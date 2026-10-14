import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { reminderDeliveries } from '../../src/db/schema/reminders.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/*
 * 提醒 job (EURO-30 review): a delivery that crashes while being sent is
 * postponed and not picked again in the same tick. Before, more than 100
 * crashing deliveries made `tick()` fetch the same batch forever.
 */

describe('提醒 tick with deliveries that crash', () => {
  const clock = fixedClock('2026-10-14T02:00:00.000Z');
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ clock });
  });
  afterAll(() => t.close());

  it('finishes, postpones each crashed delivery, and still sends the others', async () => {
    const u = await t.createUser('crash');
    const task = await t.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: u.headers,
      payload: { title: '会出错的提醒', dates: { allDay: false, dueAt: '2026-10-14T02:05:00.000Z', startAt: null }, reminders: [{ type: 'before', minutes: 0 }] },
    });
    expect(task.statusCode, task.body).toBe(201);
    const [good] = await t.database.db.select().from(reminderDeliveries).where(eq(reminderDeliveries.userId, u.id));
    expect(good?.status).toBe('scheduled');

    // 120 broken copies, due before the good one: `channels` is not a list, so delivering throws.
    const due = new Date('2026-10-14T02:01:00.000Z');
    await t.database.db.insert(reminderDeliveries).values(
      Array.from({ length: 120 }, (_, i) => ({
        ...(good as typeof reminderDeliveries.$inferSelect),
        id: randomUUID(),
        status: 'delivering' as const,
        nextAttemptAt: due,
        revision: 1000 + i,
        channels: { not: 'a list' } as never,
      })),
    );

    clock.set('2026-10-14T02:10:00.000Z');
    const outcome = await Promise.race([
      t.app.reminders.tick().then((r) => r),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);
    expect(outcome).not.toBe('timeout');

    const rows = await t.database.db.select().from(reminderDeliveries).where(eq(reminderDeliveries.userId, u.id));
    const broken = rows.filter((r) => r.id !== good?.id);
    expect(broken).toHaveLength(120);
    // Postponed by 15 minutes from the tick.
    for (const r of broken) expect(r.nextAttemptAt?.toISOString()).toBe('2026-10-14T02:25:00.000Z');
    // The good delivery was not starved (no channels: done right away).
    expect(rows.find((r) => r.id === good?.id)?.status).not.toBe('scheduled');
  }, 20_000);
});
