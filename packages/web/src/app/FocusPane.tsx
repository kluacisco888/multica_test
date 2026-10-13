import {
  FOCUS_PHASE_LABELS,
  FOCUS_STAT_UNIT_LABELS,
  FOCUS_STAT_UNITS,
  focusElapsedMs,
  focusPeriod,
  focusRemainingMs,
  formatFocusDuration,
  formatTimer,
  stepFocusPeriod,
  todayIn,
  zonedDateTime,
  type FocusMode,
  type FocusRecord,
  type FocusStats,
  type FocusStatUnit,
  type PomodoroSettings,
  type Task,
  type UpdateSettingsRequest,
} from '@dida/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import * as api from '../api.js';
import { Button, Dialog, IconButton, MenuButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import type { FocusTimer } from './focusTimer.js';

/*
 * 番茄专注 page (spec 用户故事 86–92), laid out like the reference: the timer
 * on the left (title, 番茄计时 / 正计时, the task link, the ring, the
 * buttons), 概览 / 专注统计 / 专注记录 on the right. On mobile the right
 * column goes below the timer.
 */

const RING_SIZE = 360;
const RING_STROKE = 7;

export function FocusPane({
  timer,
  pomodoro,
  timeZone,
  isMobile,
  sidebarVisible,
  onToggleSidebar,
  onSaveSettings,
  onError,
}: {
  timer: FocusTimer;
  pomodoro: PomodoroSettings;
  timeZone: string;
  isMobile: boolean;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onSaveSettings: (patch: UpdateSettingsRequest) => Promise<boolean>;
  onError: (error: unknown) => void;
}) {
  const { session } = timer;
  const [mode, setMode] = useState<FocusMode>('pomodoro');
  /** The task chosen before starting. */
  const [pendingTask, setPendingTask] = useState<{ id: string; title: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [editingSettings, setEditingSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const running = session?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);

  const now = timer.serverNow();
  const shownMode: FocusMode = session?.mode ?? mode;
  const isBreak = session !== null && session !== undefined && session.phase !== 'focus';
  const remaining = session ? focusRemainingMs(session, now) : null;
  const elapsed = session ? focusElapsedMs(session, now) : 0;
  const planned = session ? session.plannedMs : shownMode === 'pomodoro' ? pomodoro.focusMinutes * 60_000 : null;
  const display = session ? (remaining ?? elapsed) : (planned ?? 0);
  const progress = session && planned ? Math.min(1, elapsed / planned) : 0;
  const taskTitle = session ? session.taskTitle : (pendingTask?.title ?? null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    await fn();
    setBusy(false);
  }

  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const phaseLabel = session ? FOCUS_PHASE_LABELS[session.phase] : '专注';
  const statusLabel = session?.status === 'paused' ? '已暂停' : session ? `${phaseLabel}中` : '未开始';

  return (
    <main className="focus-pane">
      <section className="focus-main" aria-labelledby="focus-title">
        <header className="focus-header">
          {isMobile && (
            <IconButton
              icon="sidebar"
              label={sidebarVisible ? '收起侧栏' : '展开侧栏'}
              aria-expanded={sidebarVisible}
              onClick={onToggleSidebar}
              className="list-pane-sidebar-toggle"
            />
          )}
          <h1 id="focus-title" className="focus-title">
            番茄专注
          </h1>
          <div className="focus-modes" role="radiogroup" aria-label="计时方式">
            {(['pomodoro', 'stopwatch'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={shownMode === m}
                className="focus-mode"
                disabled={Boolean(session) && shownMode !== m}
                onClick={() => setMode(m)}
              >
                {m === 'pomodoro' ? '番茄计时' : '正计时'}
              </button>
            ))}
          </div>
          <div className="focus-header-actions">
            <MenuButton label="专注更多操作" items={[{ label: '番茄设置', icon: 'settings', onSelect: () => setEditingSettings(true) }]} />
          </div>
        </header>

        <div className="focus-body">
          <button type="button" className="focus-task" onClick={() => setPicking(true)} aria-label={taskTitle ? `关联任务：${taskTitle}` : '选择关联任务'}>
            <span className="focus-task-title">{isBreak ? phaseLabel : (taskTitle ?? '专注')}</span>
            <Icon name="chevronRight" size={14} />
          </button>

          <div className="focus-ring">
            <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true" focusable="false">
              <circle className="focus-ring-track" cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={radius} strokeWidth={RING_STROKE} />
              {progress > 0 && (
                <circle
                  className={`focus-ring-progress ${isBreak ? 'focus-ring-break' : ''}`}
                  cx={RING_SIZE / 2}
                  cy={RING_SIZE / 2}
                  r={radius}
                  strokeWidth={RING_STROKE}
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - progress)}
                  transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                />
              )}
            </svg>
            <div className="focus-ring-center" role="timer" aria-label={`${statusLabel}，${shownMode === 'stopwatch' ? '已计时' : '剩余'} ${formatTimer(display)}`}>
              <span className="focus-time">{formatTimer(display)}</span>
              {session && <span className="focus-state">{statusLabel}</span>}
            </div>
          </div>

          <div className="focus-actions">
            {!session && (
              <Button variant="primary" className="focus-button" disabled={busy} onClick={() => act(() => timer.start(mode, pendingTask?.id ?? null))}>
                开始
              </Button>
            )}
            {session?.status === 'running' && (
              <Button variant="primary" className="focus-button" disabled={busy} onClick={() => act(() => timer.act('pause'))}>
                暂停
              </Button>
            )}
            {session?.status === 'paused' && (
              <Button variant="primary" className="focus-button" disabled={busy} onClick={() => act(() => timer.act('resume'))}>
                继续
              </Button>
            )}
            {session && !isBreak && session.mode === 'pomodoro' && (
              <Button className="focus-button focus-button-secondary" disabled={busy} onClick={() => act(() => timer.act('abandon'))}>
                放弃
              </Button>
            )}
            {session && (isBreak || session.mode === 'stopwatch') && (
              <Button className="focus-button focus-button-secondary" disabled={busy} onClick={() => act(() => timer.act('finish'))}>
                {isBreak ? '跳过休息' : '结束'}
              </Button>
            )}
          </div>
        </div>
      </section>

      <FocusSide epoch={timer.finishedEpoch} timeZone={timeZone} today={todayIn(now, timeZone)} onError={onError} />

      {picking && (
        <TaskPickerDialog
          selectedId={session ? session.taskId : (pendingTask?.id ?? null)}
          onClose={() => setPicking(false)}
          onPick={(task) => {
            setPicking(false);
            if (session) void timer.link(task?.id ?? null);
            else setPendingTask(task ? { id: task.id, title: task.title } : null);
          }}
          onError={onError}
        />
      )}
      {editingSettings && (
        <PomodoroSettingsDialog
          settings={pomodoro}
          onClose={() => setEditingSettings(false)}
          onSave={async (next) => {
            if (await onSaveSettings({ pomodoro: next })) setEditingSettings(false);
          }}
        />
      )}
    </main>
  );
}

/** 概览, 专注统计 and 专注记录. */
function FocusSide({ epoch, timeZone, today, onError }: { epoch: number; timeZone: string; today: string; onError: (e: unknown) => void }) {
  const [unit, setUnit] = useState<FocusStatUnit>('day');
  const [date, setDate] = useState(today);
  const [stats, setStats] = useState<FocusStats | null>(null);
  const [records, setRecords] = useState<FocusRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchFocusStats(unit, date)
      .then((s) => !cancelled && setStats(s))
      .catch((e: unknown) => !cancelled && onError(e));
    return () => {
      cancelled = true;
    };
  }, [unit, date, epoch, onError]);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchFocusRecords()
      .then((r) => !cancelled && setRecords(r))
      .catch((e: unknown) => !cancelled && onError(e));
    return () => {
      cancelled = true;
    };
  }, [epoch, onError]);

  const grouped = useMemo(() => {
    const groups: { date: string; items: FocusRecord[] }[] = [];
    for (const r of records ?? []) {
      const d = zonedDateTime(r.startedAt, timeZone).date;
      const last = groups.at(-1);
      if (last?.date === d) last.items.push(r);
      else groups.push({ date: d, items: [r] });
    }
    return groups;
  }, [records, timeZone]);

  const period = focusPeriod(unit, date);
  const periodLabel = unit === 'day' ? dateLabel(date) : unit === 'week' ? `${dateLabel(period.from)} - ${dateLabel(period.to)}` : monthLabel(date);
  const overview = stats?.overview;

  return (
    <aside className="focus-side" aria-label="专注概览与记录">
      <section aria-labelledby="focus-overview-title">
        <h2 id="focus-overview-title" className="focus-side-title">
          概览
        </h2>
        <dl className="focus-cards">
          <Card label="今日番茄" value={overview ? String(overview.todayPomodoros) : '–'} />
          <Card label="今日专注时长" value={overview ? overview.todayFocusMs : null} />
          <Card label="总番茄" value={overview ? String(overview.totalPomodoros) : '–'} />
          <Card label="总专注时长" value={overview ? overview.totalFocusMs : null} />
        </dl>
      </section>

      <section aria-labelledby="focus-stats-title" className="focus-stats">
        <div className="focus-side-head">
          <h2 id="focus-stats-title" className="focus-side-title">
            专注统计
          </h2>
          <div className="focus-units" role="radiogroup" aria-label="统计周期">
            {FOCUS_STAT_UNITS.map((u) => (
              <button key={u} type="button" role="radio" aria-checked={unit === u} className="focus-unit" onClick={() => setUnit(u)}>
                {FOCUS_STAT_UNIT_LABELS[u]}
              </button>
            ))}
          </div>
        </div>
        <div className="focus-period">
          <IconButton icon="chevronLeft" label="上一个周期" onClick={() => setDate(stepFocusPeriod(unit, date, -1))} />
          <span className="focus-period-label" aria-live="polite">
            {periodLabel}
          </span>
          <IconButton icon="chevronRight" label="下一个周期" onClick={() => setDate(stepFocusPeriod(unit, date, 1))} />
          {date !== today && (
            <button type="button" className="focus-period-today" onClick={() => setDate(today)}>
              今天
            </button>
          )}
        </div>
        {stats && (
          <>
            <p className="focus-period-total">
              <span>
                番茄 <strong>{stats.pomodoros}</strong>
              </span>
              <span>
                专注时长 <strong>{formatFocusDuration(stats.focusMs)}</strong>
              </span>
            </p>
            {unit !== 'day' && <DayBars days={stats.days} unit={unit} />}
            <h3 className="focus-side-subtitle">任务用时</h3>
            {stats.tasks.length === 0 ? (
              <p className="focus-empty">这段时间没有关联任务的专注</p>
            ) : (
              <ul className="focus-task-totals" aria-label="任务用时">
                {stats.tasks.map((t) => (
                  <li key={t.taskId}>
                    <span className="focus-task-totals-title">{t.title || '（无标题）'}</span>
                    <span className="focus-task-totals-time">{formatFocusDuration(t.focusMs)}</span>
                  </li>
                ))}
              </ul>
            )}
            {stats.taskTotals.length > 0 && (
              <>
                <h3 className="focus-side-subtitle">任务累计用时</h3>
                <ul className="focus-task-totals" aria-label="任务累计用时">
                  {stats.taskTotals.slice(0, 10).map((t) => (
                    <li key={t.taskId}>
                      <span className="focus-task-totals-title">{t.title || '（无标题）'}</span>
                      <span className="focus-task-totals-time">{formatFocusDuration(t.focusMs)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="focus-records-title" className="focus-records">
        <h2 id="focus-records-title" className="focus-side-title">
          专注记录
        </h2>
        {records && records.length === 0 && <p className="focus-empty">还没有专注记录</p>}
        {grouped.map((g) => (
          <div key={g.date} className="focus-record-day">
            <h3 className="focus-record-date">{fullDateLabel(g.date)}</h3>
            <ul aria-label={fullDateLabel(g.date)}>
              {g.items.map((r) => (
                <li key={r.id} className="focus-record">
                  <span className={`focus-record-icon focus-record-${r.mode}`} aria-hidden="true">
                    <Icon name={r.mode === 'pomodoro' ? 'focus' : 'clock'} size={14} />
                  </span>
                  <span className="focus-record-time">
                    <span className="visually-hidden">{r.mode === 'pomodoro' ? '番茄' : '正计时'} </span>
                    {zonedDateTime(r.startedAt, timeZone).time} - {zonedDateTime(r.endedAt, timeZone).time}
                  </span>
                  <span className="focus-record-duration">{formatFocusDuration(r.focusMs)}</span>
                  {r.taskTitle && <span className="focus-record-task">{r.taskTitle}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </aside>
  );
}

function Card({ label, value }: { label: string; value: string | number | null }) {
  let content;
  if (typeof value === 'number') {
    const h = Math.floor(value / 3_600_000);
    const m = Math.floor((value % 3_600_000) / 60_000);
    content = (
      <>
        {h > 0 && (
          <>
            {h}
            <small>h</small>{' '}
          </>
        )}
        {m}
        <small>m</small>
      </>
    );
  } else content = value ?? '–';
  return (
    <div className="focus-card">
      <dt>{label}</dt>
      <dd>{content}</dd>
    </div>
  );
}

function DayBars({ days, unit }: { days: FocusStats['days']; unit: FocusStatUnit }) {
  const max = Math.max(1, ...days.map((d) => d.focusMs));
  return (
    <ol className={`focus-bars focus-bars-${unit}`} aria-label="每天的专注时长">
      {days.map((d) => (
        <li key={d.date} title={`${dateLabel(d.date)} ${formatFocusDuration(d.focusMs)}`}>
          <span className="focus-bar" style={{ height: `${Math.round((d.focusMs / max) * 100)}%` }} />
          <span className="visually-hidden">{`${dateLabel(d.date)}：${formatFocusDuration(d.focusMs)}`}</span>
        </li>
      ))}
    </ol>
  );
}

const dateLabel = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日`;
};
const monthLabel = (date: string) => {
  const [y, m] = date.split('-').map(Number);
  return `${y}年${m}月`;
};
const fullDateLabel = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}年${m}月${d}日`;
};

/** 选择任务: today's open tasks, or search all of them; or no task. */
function TaskPickerDialog({
  selectedId,
  onClose,
  onPick,
  onError,
}: {
  selectedId: string | null;
  onClose: () => void;
  onPick: (task: Task | null) => void;
  onError: (e: unknown) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    const timer = window.setTimeout(
      () => {
        (q ? api.searchTasks(q).then((r) => r.tasks) : api.fetchTasks({ smart: 'today' }))
          .then((list) => !cancelled && setTasks(list.filter((t) => t.status === 'open')))
          .catch((e: unknown) => !cancelled && onError(e));
      },
      q ? 200 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, onError]);

  return (
    <Dialog title="选择任务" onClose={onClose} className="focus-picker">
      <div className="field">
        <label htmlFor={`${id}-q`}>搜索任务</label>
        <input id={`${id}-q`} type="search" value={query} autoFocus maxLength={100} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <p className="focus-picker-hint">{query.trim() ? '搜索结果' : '今天'}</p>
      {tasks === null ? (
        <p role="status">正在加载…</p>
      ) : tasks.length === 0 ? (
        <p className="focus-empty">没有未完成的任务</p>
      ) : (
        <ul className="focus-picker-list" aria-label="任务">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="focus-picker-item" aria-pressed={t.id === selectedId} onClick={() => onPick(t)}>
                {t.title || '（无标题）'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ui-dialog-footer">
        <Button onClick={() => onPick(null)}>不关联任务</Button>
      </div>
    </Dialog>
  );
}

/** 番茄设置: the three lengths and how many 番茄 before a 长休息. */
function PomodoroSettingsDialog({
  settings,
  onClose,
  onSave,
}: {
  settings: PomodoroSettings;
  onClose: () => void;
  onSave: (next: PomodoroSettings) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Record<keyof PomodoroSettings, string>>({
    focusMinutes: String(settings.focusMinutes),
    shortBreakMinutes: String(settings.shortBreakMinutes),
    longBreakMinutes: String(settings.longBreakMinutes),
    longBreakEvery: String(settings.longBreakEvery),
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fields: { key: keyof PomodoroSettings; label: string; max: number }[] = [
    { key: 'focusMinutes', label: '专注时长（分钟）', max: 180 },
    { key: 'shortBreakMinutes', label: '短休息时长（分钟）', max: 60 },
    { key: 'longBreakMinutes', label: '长休息时长（分钟）', max: 60 },
    { key: 'longBreakEvery', label: '长休息间隔（番茄数）', max: 10 },
  ];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = {} as PomodoroSettings;
    for (const f of fields) {
      const n = Number(draft[f.key]);
      if (!Number.isInteger(n) || n < 1 || n > f.max) {
        setError(`${f.label.replace(/（.*）/, '')}应为 1 到 ${f.max} 之间的整数`);
        return;
      }
      next[f.key] = n;
    }
    setSaving(true);
    await onSave(next);
    setSaving(false);
  }

  return (
    <Dialog title="番茄设置" onClose={onClose}>
      <form className="form" onSubmit={submit} noValidate>
        {fields.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
            <input
              id={`${id}-${f.key}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={f.max}
              step={1}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
            />
          </div>
        ))}
        {error && (
          <p id={`${id}-error`} className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="ui-dialog-footer">
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? '正在保存…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
