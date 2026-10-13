import { describe, expect, it } from 'vitest';
import {
  compareCountdowns,
  countdownCaption,
  countdownReminderMessage,
  createCountdownRequestSchema,
  formatYmd,
  ymdBetween,
} from './countdowns.js';

describe('countdownCaption', () => {
  it('reads like the reference card', () => {
    expect(countdownCaption({ calendar: 'solar', lunar: null, next: { date: '2026-10-17', days: 3, status: 'upcoming' } })).toBe('距离 2026年10月17日 还有');
    expect(countdownCaption({ calendar: 'solar', lunar: null, next: { date: '2014-12-08', days: 4328, status: 'passed' } })).toBe('距离 2014年12月8日 已经');
    expect(
      countdownCaption({ calendar: 'lunar', lunar: { monthName: '正月', dayName: '初一' }, next: { date: '2027-02-06', days: 115, status: 'upcoming' } }),
    ).toBe('距离 正月初一 (2027年2月6日) 还有');
    expect(countdownCaption({ calendar: 'solar', lunar: null, next: { date: '2026-10-14', days: 0, status: 'today' } })).toBe('2026年10月14日 就是今天');
  });
});

describe('ymdBetween', () => {
  it.each([
    ['2014-12-08', '2026-10-14', { years: 11, months: 10, days: 6 }, '11年10个月6天'],
    ['2026-10-14', '2026-10-17', { years: 0, months: 0, days: 3 }, '3天'],
    ['2026-10-14', '2027-02-06', { years: 0, months: 3, days: 23 }, '3个月23天'],
    ['2026-01-31', '2026-02-28', { years: 0, months: 1, days: 0 }, '1个月'],
    ['2026-01-31', '2026-03-01', { years: 0, months: 1, days: 1 }, '1个月1天'],
    ['2024-02-29', '2025-02-28', { years: 1, months: 0, days: 0 }, '1年'],
    ['2026-10-14', '2026-10-14', { years: 0, months: 0, days: 0 }, '0天'],
  ])('%s → %s', (a, b, span, text) => {
    expect(ymdBetween(a, b)).toEqual(span);
    expect(ymdBetween(b, a)).toEqual(span);
    expect(formatYmd(span)).toBe(text);
  });
});

describe('createCountdownRequestSchema', () => {
  it('fills in defaults and keeps day reminders only', () => {
    expect(createCountdownRequestSchema.parse({ name: ' 周末 ', date: '2026-10-17' })).toEqual({
      name: '周末',
      icon: '⏳',
      date: '2026-10-17',
      calendar: 'solar',
      repeat: 'none',
      reminders: [],
      reminderChannelIds: null,
      pinned: false,
    });
    expect(createCountdownRequestSchema.safeParse({ name: 'x', date: '2026-10-17', reminders: [{ type: 'before', minutes: 0 }] }).success).toBe(false);
  });

  it('drops duplicate reminders and sorts the largest lead first', () => {
    const parsed = createCountdownRequestSchema.parse({
      name: 'x',
      date: '2026-10-17',
      reminders: [
        { type: 'day', daysBefore: 0, time: null },
        { type: 'day', daysBefore: 7, time: '09:00' },
        { type: 'day', daysBefore: 0, time: null },
      ],
    });
    expect(parsed.reminders).toEqual([
      { type: 'day', daysBefore: 7, time: '09:00' },
      { type: 'day', daysBefore: 0, time: null },
    ]);
  });
});

describe('compareCountdowns', () => {
  it('puts 置顶 first, then the sort order', () => {
    const rows = [
      { id: 'a', pinned: false, sortOrder: 'a0' },
      { id: 'b', pinned: true, sortOrder: 'a2' },
      { id: 'c', pinned: false, sortOrder: 'Zz' },
    ];
    expect([...rows].sort(compareCountdowns).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('countdownReminderMessage', () => {
  it('names the 倒数日 and how many days are left', () => {
    expect(countdownReminderMessage({ name: '春节', calendar: 'lunar', lunar: { monthName: '正月', dayName: '初一' } }, '2027-02-06', 1)).toEqual({
      title: '倒数日：春节',
      body: '还有 1 天：正月初一（2027年2月6日）\n来自勾勾清单',
    });
    expect(countdownReminderMessage({ name: '周末', calendar: 'solar', lunar: null }, '2026-10-17', 0).body).toBe('就是今天：2026年10月17日\n来自勾勾清单');
  });
});
