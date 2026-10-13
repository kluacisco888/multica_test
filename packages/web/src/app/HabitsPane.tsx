import {
  addDays,
  dayCount,
  describeFrequency,
  describeGoal,
  goalTarget,
  habitDueOn,
  habitStats,
  isDayDone,
  LIST_COLORS,
  monthGrid,
  nextMonth,
  previousMonth,
  WEEKDAY_NAMES,
  type CreateHabitRequest,
  type Habit,
  type HabitFrequency,
  type HabitGoal,
  type Streak,
} from '@dida/shared';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import * as api from '../api.js';
import { Button, Dialog, IconButton, MenuButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { COLOR_NAMES, ConfirmDialog, SwatchOption } from './dialogs.js';

/*
 * 习惯打卡 (spec 用户故事 93–98), laid out after the reference 习惯 page
 * (ADR-0007 screenshots): a header with 习惯 ⌄ (坚持中 / 已归档), + and ⋯; a
 * strip of the last 7 days whose circles fill with the share of habits done
 * that day (clicking a day picks it, so the list checks in that day — 补打卡);
 * the habits with their 连续 days and a check button; and, beside it, the
 * selected habit's 当前连续 / 最高连续 / 总打卡 / 月完成率 and 月度日历,
 * where past days can be checked in or undone.
 */

interface HabitsPaneProps {
  today: string;
  isMobile: boolean;
  selectedHabitId: string | null;
  onSelectHabit: (id: string | null) => void;
  onToggleSidebar: () => void;
  onError: (message: string) => void;
}

type Dialogs = { kind: 'none' } | { kind: 'edit'; habit: Habit | null } | { kind: 'delete'; habit: Habit };

const errorMessage = (e: unknown) => api.errorMessage(e);

function streakText(s: Streak): string {
  return `${s.value} ${s.unit === 'week' ? '周' : '天'}`;
}

export function HabitsPane(props: HabitsPaneProps) {
  const { today, isMobile, onError } = props;
  const [archived, setArchived] = useState(false);
  const [habits, setHabits] = useState<Habit[] | null>(null);
  const [day, setDay] = useState(today);
  const [dialog, setDialog] = useState<Dialogs>({ kind: 'none' });

  const load = useCallback(async () => {
    try {
      setHabits(await api.fetchHabits(archived));
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [archived, onError]);

  useEffect(() => {
    setHabits(null);
    void load();
  }, [load]);

  useEffect(() => setDay(today), [today]);

  const replace = (next: Habit) => setHabits((list) => list?.map((h) => (h.id === next.id ? next : h)) ?? list);

  async function run(action: () => Promise<Habit>) {
    try {
      replace(await action());
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  /** 打卡 button: 完成一次 toggles; 数量型 adds 1 until the target, then undoes. */
  function toggle(habit: Habit, date: string) {
    const target = goalTarget(habit.goal);
    const count = dayCount(habit.checkins, date);
    if (count >= target) return run(() => api.undoCheckIn(habit.id, date));
    return run(() => api.checkInHabit(habit.id, date, habit.goal.type === 'once' ? 1 : count + 1));
  }

  async function save(draft: CreateHabitRequest, habit: Habit | null) {
    try {
      if (habit) {
        replace(await api.updateHabit(habit.id, draft));
      } else {
        const created = await api.createHabit(draft);
        if (!archived) setHabits((list) => [...(list ?? []), created]);
        props.onSelectHabit(created.id);
      }
      setDialog({ kind: 'none' });
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  async function setArchivedFlag(habit: Habit, value: boolean) {
    try {
      await api.updateHabit(habit.id, { archived: value });
      setHabits((list) => list?.filter((h) => h.id !== habit.id) ?? list);
      props.onSelectHabit(null);
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  const selected = habits?.find((h) => h.id === props.selectedHabitId) ?? null;
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const showList = !(isMobile && selected);

  return (
    <div className={`habits ${selected ? 'habits-has-detail' : ''}`}>
      {showList && (
        <main className="habits-pane" aria-busy={habits === null}>
          <header className="habits-header">
            {isMobile && <IconButton icon="sidebar" label="展开侧栏" onClick={props.onToggleSidebar} className="habits-drawer-toggle" />}
            <MenuButton
              label="习惯分类"
              align="start"
              triggerClassName="habits-title-button"
              items={[
                { label: '坚持中', checked: !archived, onSelect: () => setArchived(false) },
                { label: '已归档', checked: archived, onSelect: () => setArchived(true) },
              ]}
            >
              <h1 className="habits-title">{archived ? '已归档' : '习惯'}</h1>
              <Icon name="chevronDown" size={14} className="habits-title-caret" />
            </MenuButton>
            <span className="habits-header-actions">
              <IconButton icon="grid" label="切换视图" size={20} disabled />
              <IconButton icon="plus" label="添加习惯" size={20} onClick={() => setDialog({ kind: 'edit', habit: null })} />
              <MenuButton
                label="更多"
                items={[{ label: archived ? '查看坚持中的习惯' : '查看已归档的习惯', icon: 'archive', onSelect: () => setArchived((v) => !v) }]}
              />
            </span>
          </header>

          {!archived && (
            <ol className="habits-week" aria-label="最近 7 天">
              {week.map((date) => {
                const due = (habits ?? []).filter((h) => habitDueOn(h, h.checkins, date));
                const doneN = due.filter((h) => isDayDone(h, h.checkins, date)).length;
                const ratio = due.length === 0 ? 0 : doneN / due.length;
                return (
                  <li key={date}>
                    <button
                      type="button"
                      className={`habits-week-day ${date === day ? 'habits-week-day-selected' : ''} ${date === today ? 'habits-week-today' : ''}`}
                      aria-pressed={date === day}
                      aria-label={`${date === today ? '今天' : date}，完成 ${doneN}/${due.length}`}
                      onClick={() => setDay(date)}
                    >
                      <span className="habits-week-name">{WEEKDAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()]}</span>
                      <span className="habits-week-date">{Number(date.slice(8))}</span>
                      <span
                        className={`habits-week-ring ${due.length === 0 ? 'habits-week-ring-empty' : ''}`}
                        style={{ ['--ratio' as string]: `${ratio * 360}deg` }}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {habits === null ? (
            <p className="list-pane-status" role="status">
              正在加载…
            </p>
          ) : habits.length === 0 ? (
            <div className="habits-empty">
              <HabitsEmptyArt />
              <p className="habits-empty-title">{archived ? '还没有已归档的习惯' : '来一起养成习惯吧'}</p>
              <p className="habits-empty-desc">{archived ? '你可以将暂时不再打卡的习惯归档到这儿' : '坚持让我们闪闪发光'}</p>
            </div>
          ) : (
            <ul className="habits-list" aria-label={archived ? '已归档的习惯' : '坚持中的习惯'}>
              {habits.map((habit) => {
                const target = goalTarget(habit.goal);
                const count = dayCount(habit.checkins, day);
                const done = count >= target;
                const stats = habitStats(habit, habit.checkins, today, today.slice(0, 7));
                const due = habitDueOn(habit, habit.checkins, day);
                return (
                  <li key={habit.id} className={`habits-row ${habit.id === props.selectedHabitId ? 'habits-row-selected' : ''}`}>
                    <span className="habits-row-icon" style={habit.color ? { background: habit.color } : undefined} aria-hidden="true">
                      {habit.name.slice(0, 1)}
                    </span>
                    <button type="button" className="habits-row-main" onClick={() => props.onSelectHabit(habit.id)}>
                      <span className="habits-row-name">{habit.name}</span>
                      <span className="habits-row-meta">
                        {habit.goal.type === 'count' ? `${count}/${target} ${habit.goal.unit} · ` : ''}
                        {stats.currentStreak.value > 0 ? `已连续 ${streakText(stats.currentStreak)}` : describeFrequency(habit.frequency)}
                      </span>
                    </button>
                    {!archived && (
                      <button
                        type="button"
                        className={`habits-check ${done ? 'habits-check-done' : ''} ${!due && !done ? 'habits-check-rest' : ''}`}
                        aria-pressed={done}
                        aria-label={`${done ? '撤销打卡' : '打卡'}：${habit.name}（${day === today ? '今天' : day}）`}
                        style={{ ['--ratio' as string]: `${Math.min(count / target, 1) * 360}deg` }}
                        onClick={() => void toggle(habit, day)}
                      >
                        {done && <Icon name="check" size={16} strokeWidth={2.5} />}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </main>
      )}

      {(!isMobile || selected) && (
        <aside className="habits-detail" aria-label="习惯详情">
          {selected ? (
            <HabitDetail
              key={selected.id}
              habit={selected}
              today={today}
              isMobile={isMobile}
              onBack={() => props.onSelectHabit(null)}
              onToggleDay={(date) => void toggle(selected, date)}
              onEdit={() => setDialog({ kind: 'edit', habit: selected })}
              onArchive={(value) => void setArchivedFlag(selected, value)}
              onDelete={() => setDialog({ kind: 'delete', habit: selected })}
            />
          ) : (
            <p className="habits-detail-empty">点击习惯标题查看详情</p>
          )}
        </aside>
      )}

      {dialog.kind === 'edit' && (
        <HabitDialog habit={dialog.habit} onCancel={() => setDialog({ kind: 'none' })} onSave={(draft) => save(draft, dialog.kind === 'edit' ? dialog.habit : null)} />
      )}
      {dialog.kind === 'delete' && (
        <ConfirmDialog
          title="删除习惯"
          message="确定删除这个习惯吗？以前辛苦累积的数据都会被删掉。"
          confirmLabel="删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={async () => {
            try {
              await api.deleteHabit(dialog.habit.id);
              setHabits((list) => list?.filter((h) => h.id !== dialog.habit.id) ?? list);
              props.onSelectHabit(null);
              setDialog({ kind: 'none' });
            } catch (e) {
              onError(errorMessage(e));
            }
          }}
        />
      )}
    </div>
  );
}

function HabitDetail({
  habit,
  today,
  isMobile,
  onBack,
  onToggleDay,
  onEdit,
  onArchive,
  onDelete,
}: {
  habit: Habit;
  today: string;
  isMobile: boolean;
  onBack: () => void;
  onToggleDay: (date: string) => void;
  onEdit: () => void;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const stats = habitStats(habit, habit.checkins, today, month);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const archived = habit.archivedAt !== null;
  const target = goalTarget(habit.goal);

  return (
    <div className="habit-detail">
      <header className="habit-detail-header">
        {isMobile && <IconButton icon="chevronLeft" label="返回" onClick={onBack} />}
        <h2 className="habit-detail-title">{habit.name}</h2>
        <MenuButton
          label={`习惯操作：${habit.name}`}
          items={[
            { label: '编辑', icon: 'edit', onSelect: onEdit },
            { label: archived ? '取消归档' : '归档', icon: archived ? 'restore' : 'archive', onSelect: () => onArchive(!archived) },
            { label: '删除', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
        />
      </header>
      <p className="habit-detail-sub">
        {describeFrequency(habit.frequency)} · {describeGoal(habit.goal)}
        {habit.reminders.length > 0 ? ` · 提醒 ${habit.reminders.join('、')}` : ''}
      </p>

      <dl className="habit-stats">
        <div>
          <dt>当前连续</dt>
          <dd>{streakText(stats.currentStreak)}</dd>
        </div>
        <div>
          <dt>最高连续</dt>
          <dd>{streakText(stats.bestStreak)}</dd>
        </div>
        <div>
          <dt>{habit.goal.type === 'count' ? '总达成目标' : '总打卡'}</dt>
          <dd>{stats.totalDays} 天</dd>
        </div>
        <div>
          <dt>{`${m}月完成率`}</dt>
          <dd>{Math.round(stats.month.rate * 100)}%</dd>
        </div>
      </dl>

      <section className="habit-month" aria-labelledby={`month-${habit.id}`}>
        <header className="habit-month-header">
          <IconButton icon="chevronLeft" label="上个月" onClick={() => setMonth(previousMonth(month))} />
          <h3 id={`month-${habit.id}`} className="habit-month-title">{`${y}年${m}月`}</h3>
          <IconButton icon="chevronRight" label="下个月" disabled={month >= today.slice(0, 7)} onClick={() => setMonth(nextMonth(month))} />
        </header>
        <div className="habit-month-grid" role="grid" aria-label={`${y}年${m}月打卡日历`}>
          <div role="row" className="habit-month-row">
            {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
              <span key={d} role="columnheader" className="habit-month-weekday">
                {d}
              </span>
            ))}
          </div>
          {chunk(monthGrid(month), 7).map((row) => (
            <div role="row" className="habit-month-row" key={row[0]}>
              {row.map((date) => {
                const inMonth = date.startsWith(month);
                const count = dayCount(habit.checkins, date);
                const done = count >= target;
                const future = date > today;
                return (
                  <span role="gridcell" key={date} className="habit-month-cell">
                    {inMonth && (
                      <button
                        type="button"
                        className={`habit-day ${done ? 'habit-day-done' : count > 0 ? 'habit-day-partial' : ''} ${date === today ? 'habit-day-today' : ''}`}
                        disabled={future || archived}
                        aria-pressed={done}
                        aria-label={`${Number(date.slice(5, 7))}月${Number(date.slice(8))}日${done ? '，已打卡' : count > 0 ? `，${count}/${target}` : ''}`}
                        onClick={() => onToggleDay(date)}
                      >
                        {Number(date.slice(8))}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        <p className="habit-month-summary">{`本月完成 ${stats.month.done} / ${stats.month.planned} 次`}</p>
      </section>
    </div>
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

const WEEKDAYS_FROM_MONDAY = [1, 2, 3, 4, 5, 6, 0];

/** 新建 / 编辑习惯: name, 频率, 目标, 提醒. */
function HabitDialog({ habit, onCancel, onSave }: { habit: Habit | null; onCancel: () => void; onSave: (draft: CreateHabitRequest) => Promise<void> }) {
  const id = useId();
  const [name, setName] = useState(habit?.name ?? '');
  const [color, setColor] = useState<string | null>(habit?.color ?? null);
  const [frequency, setFrequency] = useState<HabitFrequency>(habit?.frequency ?? { type: 'daily' });
  const [goal, setGoal] = useState<HabitGoal>(habit?.goal ?? { type: 'once' });
  const [reminders, setReminders] = useState<string[]>(habit?.reminders ?? []);
  const [newReminder, setNewReminder] = useState('09:00');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return setError('请输入习惯名称');
    if (frequency.type === 'weekdays' && frequency.days.length === 0) return setError('至少选择一天');
    setSaving(true);
    await onSave({ name: name.trim(), color, frequency, goal, reminders });
    setSaving(false);
  }

  const days = frequency.type === 'weekdays' ? frequency.days : [];

  return (
    <Dialog title={habit ? '编辑习惯' : '添加习惯'} onClose={onCancel} className="habit-dialog">
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-name`}>名称</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={64}
            autoFocus
            placeholder="例如：喝水、跑步、阅读"
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          {error && (
            <p id={`${id}-error`} className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <fieldset className="field picker">
          <legend>颜色</legend>
          <div className="picker-options">
            <SwatchOption group={`${id}-color`} label="默认颜色" checked={color === null} onChange={() => setColor(null)}>
              <span className="swatch swatch-none" />
            </SwatchOption>
            {LIST_COLORS.map((c) => (
              <SwatchOption key={c} group={`${id}-color`} label={COLOR_NAMES[c]} checked={color === c} onChange={() => setColor(c)}>
                <span className="swatch" style={{ background: c }} />
              </SwatchOption>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>频率</legend>
          <div className="habit-choice">
            <label>
              <input type="radio" name={`${id}-freq`} checked={frequency.type === 'daily'} onChange={() => setFrequency({ type: 'daily' })} />
              每天
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-freq`}
                checked={frequency.type === 'weekdays'}
                onChange={() => setFrequency({ type: 'weekdays', days: [1, 2, 3, 4, 5] })}
              />
              每周固定几天
            </label>
            <label>
              <input type="radio" name={`${id}-freq`} checked={frequency.type === 'weekly'} onChange={() => setFrequency({ type: 'weekly', times: 3 })} />
              每周几次
            </label>
          </div>
          {frequency.type === 'weekdays' && (
            <div className="habit-weekdays" role="group" aria-label="在这些天">
              {WEEKDAYS_FROM_MONDAY.map((d) => (
                <label key={d} className={`habit-weekday ${days.includes(d) ? 'habit-weekday-on' : ''}`}>
                  <input
                    type="checkbox"
                    className="visually-hidden"
                    checked={days.includes(d)}
                    onChange={(e) =>
                      setFrequency({ type: 'weekdays', days: e.target.checked ? [...days, d].sort() : days.filter((x) => x !== d) })
                    }
                  />
                  {WEEKDAY_NAMES[d]?.slice(1)}
                </label>
              ))}
            </div>
          )}
          {frequency.type === 'weekly' && (
            <div className="habit-inline">
              <label htmlFor={`${id}-times`}>每周</label>
              <select id={`${id}-times`} value={frequency.times} onChange={(e) => setFrequency({ type: 'weekly', times: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span>天</span>
            </div>
          )}
        </fieldset>
        <fieldset className="field">
          <legend>目标</legend>
          <div className="habit-choice">
            <label>
              <input type="radio" name={`${id}-goal`} checked={goal.type === 'once'} onChange={() => setGoal({ type: 'once' })} />
              当天完成打卡
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-goal`}
                checked={goal.type === 'count'}
                onChange={() => setGoal({ type: 'count', target: 8, unit: '杯' })}
              />
              当天完成一定量
            </label>
          </div>
          {goal.type === 'count' && (
            <div className="habit-inline">
              <label htmlFor={`${id}-target`}>每天</label>
              <input
                id={`${id}-target`}
                type="number"
                min={1}
                max={99999}
                value={goal.target}
                onChange={(e) => setGoal({ ...goal, target: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              <label htmlFor={`${id}-unit`} className="visually-hidden">
                单位
              </label>
              <input id={`${id}-unit`} className="habit-unit" value={goal.unit} maxLength={8} onChange={(e) => setGoal({ ...goal, unit: e.target.value })} />
            </div>
          )}
        </fieldset>
        <fieldset className="field">
          <legend>提醒</legend>
          {reminders.length > 0 && (
            <ul className="habit-reminders">
              {reminders.map((r) => (
                <li key={r}>
                  <span>{r}</span>
                  <IconButton icon="close" label={`删除提醒 ${r}`} size={14} onClick={() => setReminders(reminders.filter((x) => x !== r))} />
                </li>
              ))}
            </ul>
          )}
          <div className="habit-inline">
            <label htmlFor={`${id}-reminder`} className="visually-hidden">
              提醒时间
            </label>
            <input id={`${id}-reminder`} type="time" value={newReminder} onChange={(e) => setNewReminder(e.target.value)} />
            <Button
              disabled={!newReminder || reminders.length >= 10}
              onClick={() => setReminders([...new Set([...reminders, newReminder])].sort())}
            >
              添加提醒
            </Button>
          </div>
          <p className="field-hint">到时间还没打卡，会通过默认的通知渠道提醒你</p>
        </fieldset>
        <div className="ui-dialog-footer">
          <Button onClick={onCancel}>取消</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? '正在保存…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Our own drawing for the empty state (ADR-0001: no official artwork): a card and an alarm clock. */
function HabitsEmptyArt() {
  return (
    <svg className="habits-empty-art" width="140" height="124" viewBox="0 0 140 124" aria-hidden="true" focusable="false">
      <path d="M30 40c10-24 60-34 86-22 18 8 22 40 10 62-14 26-60 40-86 24C18 90 20 62 30 40Z" fill="var(--color-habit-art-bg)" />
      <rect x="6" y="30" width="52" height="22" rx="3" fill="#fff" stroke="#1f2a5a" strokeWidth="2" />
      <circle cx="18" cy="41" r="5" fill="none" stroke="var(--color-brand)" strokeWidth="2" />
      <path d="M28 38h22M28 44h14" stroke="var(--color-brand)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="92" cy="72" r="26" fill="var(--color-brand)" />
      <circle cx="92" cy="72" r="20" fill="#fff" stroke="#1f2a5a" strokeWidth="2" />
      <path d="M92 60v13l-5 6" stroke="#1f2a5a" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M70 52a9 9 0 0 1 12-6M114 52a9 9 0 0 0-12-6" stroke="var(--color-brand)" strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M48 76l2 4 4 2-4 2-2 4-2-4-4-2 4-2Z" fill="#1f2a5a" />
      <circle cx="70" cy="22" r="2" fill="#1f2a5a" />
    </svg>
  );
}
