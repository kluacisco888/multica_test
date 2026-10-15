import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENT_LEVELS,
  achievementLevel,
  achievementScore,
  focusPomodoroCount,
  taskOverdueDay,
  type AchievementFocusInput,
  type AchievementTaskInput,
} from './achievement.js';

/*
 * 成就分 rules as the maintainer settled them on EURO-28 (方案 A):
 *   按时完成 +5 · 过期后完成 +2 · 番茄 +3 (正计时每满 25 分钟一个) ·
 *   任务过期 −2 (once, kept) · 放弃 / 删除 0 · 取消完成 takes the points back ·
 *   at most +100 a day · never below 0.
 * The score is recomputed from the history every time.
 */

const today = '2026-10-15';
const task = (t: Partial<AchievementTaskInput>): AchievementTaskInput => ({
  dueDay: null,
  overdueDay: null,
  completedDay: null,
  closedDay: null,
  ...t,
});
const score = (tasks: AchievementTaskInput[], focus: AchievementFocusInput[] = []) => achievementScore(tasks, focus, today).score;

describe('成就分: completing a 任务', () => {
  it('按时完成 (on or before the 截止日) is +5', () => {
    expect(score([task({ dueDay: '2026-10-10', completedDay: '2026-10-10' })])).toBe(5);
    expect(score([task({ dueDay: '2026-10-10', completedDay: '2026-10-08' })])).toBe(5);
  });

  it('a 任务 without a date is on time: +5', () => {
    expect(score([task({ completedDay: '2026-10-10' })])).toBe(5);
  });

  it('过期后才完成 is +2, after the −2 for going overdue (net 0)', () => {
    const late = task({ dueDay: '2026-10-10', completedDay: '2026-10-12' });
    expect(score([late])).toBe(2); // −2 on 10-11 (floored at 0), +2 on 10-12
    // Seen alongside an on-time one so the floor at 0 does not hide the −2.
    const history = achievementScore([task({ completedDay: '2026-10-01' }), late], [], today).history;
    expect(history.find((d) => d.date === '2026-10-11')?.score).toBe(3); // 5 − 2
    expect(history.find((d) => d.date === '2026-10-12')?.score).toBe(5); // + 2
  });

  it('a 任务 that went overdue earlier (then got a new date) completes late: +2', () => {
    // overdueDay is the remembered first day overdue; the current 截止日 is later.
    const t = task({ dueDay: '2026-10-20', overdueDay: '2026-10-05', completedDay: '2026-10-12' });
    expect(score([task({ completedDay: '2026-10-01' }), t])).toBe(5 - 2 + 2);
  });
});

describe('成就分: 番茄', () => {
  it('each 番茄 is +3', () => {
    expect(score([], [{ day: '2026-10-10', pomodoros: 2 }])).toBe(6);
  });

  it('正计时 counts one 番茄 per full 25 minutes; 放弃的专注 never reaches here', () => {
    expect(focusPomodoroCount({ mode: 'pomodoro', focusMs: 10 * 60_000 })).toBe(1);
    expect(focusPomodoroCount({ mode: 'stopwatch', focusMs: 24 * 60_000 + 59_000 })).toBe(0);
    expect(focusPomodoroCount({ mode: 'stopwatch', focusMs: 25 * 60_000 })).toBe(1);
    expect(focusPomodoroCount({ mode: 'stopwatch', focusMs: 74 * 60_000 })).toBe(2);
  });
});

describe('成就分: 任务过期', () => {
  const base = task({ completedDay: '2026-10-01' }); // +5 so the −2 shows

  it('an open 任务 past its 截止日 is −2, from the day after the 截止日', () => {
    expect(score([base, task({ dueDay: '2026-10-14' })])).toBe(3);
    // Due today is not overdue yet.
    expect(score([base, task({ dueDay: today })])).toBe(5);
  });

  it('is taken only once per 任务', () => {
    expect(score([base, task({ dueDay: '2026-10-01' })])).toBe(3);
  });

  it('补完成 does not give the −2 back (late completion is +2 on top)', () => {
    expect(score([base, task({ dueDay: '2026-10-05', completedDay: '2026-10-09' })])).toBe(5 - 2 + 2);
  });

  it('a remembered overdue day keeps the −2 after the date was moved or cleared', () => {
    expect(score([base, task({ dueDay: null, overdueDay: '2026-10-06' })])).toBe(3);
  });
});

describe('成就分: 放弃、删除、取消完成', () => {
  const base = task({ completedDay: '2026-10-01' });

  it('放弃 or 删除 before the 截止日 is 0', () => {
    expect(score([base, task({ dueDay: '2026-10-10', closedDay: '2026-10-08' })])).toBe(5);
    expect(score([base, task({ closedDay: '2026-10-08' })])).toBe(5);
  });

  it('放弃 or 删除 after going overdue keeps the −2', () => {
    expect(score([base, task({ dueDay: '2026-10-05', closedDay: '2026-10-09' })])).toBe(3);
  });

  it('deleting a completed 任务 keeps its points (删除 is 0)', () => {
    expect(score([task({ completedDay: '2026-10-02', closedDay: '2026-10-09' })])).toBe(5);
  });

  it('取消完成 takes the completion points back: the 任务 is open again', () => {
    // After 取消完成 the 任务 has no completed day; undated, nothing is left.
    expect(score([task({ completedDay: null })])).toBe(0);
    // A dated one that is past due is then overdue (−2), its +5 gone.
    expect(score([base, task({ dueDay: '2026-10-05', completedDay: null })])).toBe(3);
  });
});

describe('成就分: daily cap and floor', () => {
  it('adds at most +100 a day', () => {
    const many = Array.from({ length: 30 }, () => task({ completedDay: '2026-10-10' })); // 150
    expect(score(many)).toBe(100);
    expect(score(many, [{ day: '2026-10-11', pomodoros: 1 }])).toBe(103);
  });

  it('the cap applies to the day’s gains; that day’s −2 still counts', () => {
    const many = Array.from({ length: 30 }, () => task({ completedDay: '2026-10-10' }));
    expect(score([...many, task({ dueDay: '2026-10-09' })])).toBe(98);
  });

  it('never goes below 0, and later gains count from 0', () => {
    const overdue = Array.from({ length: 5 }, () => task({ dueDay: '2026-10-01' })); // −10 on 10-02
    expect(score(overdue)).toBe(0);
    expect(score([...overdue, task({ completedDay: '2026-10-05' })])).toBe(5);
  });

  it('history gives the score at the end of each of the last 7 days', () => {
    const { history } = achievementScore([task({ completedDay: '2026-10-10' }), task({ completedDay: today })], [], today);
    expect(history.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', today]);
    expect(history.map((d) => d.score)).toEqual([0, 5, 5, 5, 5, 5, 10]);
  });

  it('ignores events after today', () => {
    expect(score([task({ completedDay: '2026-10-20' })])).toBe(0);
  });
});

describe('taskOverdueDay', () => {
  it('is the day after the 截止日 once that day has come while the 任务 was not completed', () => {
    expect(taskOverdueDay(task({ dueDay: '2026-10-10' }), '2026-10-11')).toBe('2026-10-11');
    expect(taskOverdueDay(task({ dueDay: '2026-10-10' }), '2026-10-10')).toBeNull();
    expect(taskOverdueDay(task({ dueDay: '2026-10-10', completedDay: '2026-10-10' }), today)).toBeNull();
    expect(taskOverdueDay(task({ dueDay: '2026-10-10', closedDay: '2026-10-10' }), today)).toBeNull();
    expect(taskOverdueDay(task({ dueDay: '2026-10-10', closedDay: '2026-10-11' }), today)).toBe('2026-10-11');
  });

  it('a remembered overdue day wins', () => {
    expect(taskOverdueDay(task({ dueDay: '2026-10-30', overdueDay: '2026-10-03' }), today)).toBe('2026-10-03');
  });
});

describe('等级', () => {
  it.each([
    [0, '新手'],
    [99, '新手'],
    [100, '初级'],
    [299, '初级'],
    [300, '勤奋者'],
    [699, '勤奋者'],
    [700, '挑战者'],
    [1399, '挑战者'],
    [1400, '新星'],
    [2999, '新星'],
    [3000, '自由者'],
    [5999, '自由者'],
    [6000, '飞跃者'],
    [9999, '飞跃者'],
    [10000, '超级英雄'],
    [19999, '超级英雄'],
    [20000, '传奇'],
    [49999, '传奇'],
    [50000, '黄金'],
    [1_000_000, '黄金'],
  ])('%i 分是「%s」', (points, name) => {
    expect(achievementLevel(points).name).toBe(name);
  });

  it('gives the next level’s threshold, none at the top', () => {
    expect(achievementLevel(150)).toMatchObject({ level: 2, min: 100, next: 300 });
    expect(achievementLevel(50000)).toMatchObject({ level: 10, min: 50000, next: null });
    expect(ACHIEVEMENT_LEVELS).toHaveLength(10);
  });
});
