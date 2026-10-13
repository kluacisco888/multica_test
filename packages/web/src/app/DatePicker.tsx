import {
  addDays,
  describeTaskDates,
  todayIn,
  weekday,
  zonedDateTime,
  zonedToInstant,
  describeRepeatFrequency,
  sortReminders,
  type NotificationChannel,
  type Reminder,
  type RepeatRule,
  type TaskDates,
  type TaskDatesInput,
} from '@dida/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button, IconButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { describeReminders, fittingReminders, ReminderChannelsRow, ReminderEditor, ReminderRow } from './ReminderPicker.js';
import { RepeatEditor, RepeatRow } from './RepeatPicker.js';

/*
 * 滴答-style date picker (spec 用户故事 23–26): a popover with the tabs 日期
 * (one due date, optional time) and 时间段 (start → due, 全天 or with times),
 * a month calendar, the 重复 row (see RepeatPicker.tsx), the 提醒 rows (see
 * ReminderPicker.tsx), 清除 and 确定.
 * Timed values are entered as wall-clock time in the user's time zone and
 * saved as UTC instants.
 */

type Mode = 'date' | 'range';

interface Draft {
  mode: Mode;
  allDay: boolean;
  start: string | null;
  due: string | null;
  startTime: string;
  dueTime: string;
  repeat: RepeatRule | null;
  /** All reminders picked; only the ones fitting `allDay` are saved. */
  reminders: Reminder[];
  channelIds: string[] | null;
}

/** What 确定 saves besides the dates. */
export interface ReminderSettings {
  reminders: Reminder[];
  reminderChannelIds: string[] | null;
}

const DEFAULT_START_TIME = '09:00';
const DEFAULT_DUE_TIME = '10:00';

function draftFrom(dates: TaskDates | null, timeZone: string, repeat: RepeatRule | null, reminders: ReminderSettings): Draft {
  return {
    ...datesDraft(dates, timeZone),
    repeat: dates ? repeat : null,
    reminders: dates ? reminders.reminders : [],
    channelIds: reminders.reminderChannelIds,
  };
}

function datesDraft(dates: TaskDates | null, timeZone: string): Omit<Draft, 'repeat' | 'reminders' | 'channelIds'> {
  if (!dates) return { mode: 'date', allDay: true, start: null, due: null, startTime: DEFAULT_START_TIME, dueTime: DEFAULT_START_TIME };
  if (dates.allDay) {
    return {
      mode: dates.startDate ? 'range' : 'date',
      allDay: true,
      start: dates.startDate,
      due: dates.dueDate,
      startTime: DEFAULT_START_TIME,
      dueTime: dates.startDate ? DEFAULT_DUE_TIME : DEFAULT_START_TIME,
    };
  }
  const due = zonedDateTime(dates.dueAt, timeZone);
  const start = dates.startAt ? zonedDateTime(dates.startAt, timeZone) : null;
  return {
    mode: start ? 'range' : 'date',
    allDay: false,
    start: start?.date ?? null,
    due: due.date,
    startTime: start?.time ?? DEFAULT_START_TIME,
    dueTime: due.time,
  };
}

/** The request body for a draft; `error` when it cannot be saved. */
function inputFrom(draft: Draft, timeZone: string): { dates: TaskDatesInput | null; error: string | null } {
  if (!draft.due) return { dates: null, error: null };
  const range = draft.mode === 'range';
  const start = range ? (draft.start ?? draft.due) : null;
  if (draft.allDay) return { dates: { allDay: true, startDate: start, dueDate: draft.due }, error: null };
  const dueAt = zonedToInstant(draft.due, draft.dueTime, timeZone);
  const startAt = start ? zonedToInstant(start, draft.startTime, timeZone) : null;
  if (startAt && Date.parse(startAt) > Date.parse(dueAt)) {
    return { dates: null, error: '结束时间不能早于开始时间' };
  }
  return { dates: { allDay: false, startAt, dueAt }, error: null };
}

/** Calendar day of the due date as the user sees it. */
function dueDay(dates: TaskDates, timeZone: string): string {
  return dates.allDay ? dates.dueDate : zonedDateTime(dates.dueAt, timeZone).date;
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function fullDateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

const WEEK_HEADER = ['日', '一', '二', '三', '四', '五', '六'];

interface TaskDateButtonProps {
  dates: TaskDates | null;
  /** 重复规则 of the task (only meaningful with dates). */
  repeat: RepeatRule | null;
  /** 提醒 of the task and their 通知渠道. */
  reminders: ReminderSettings;
  /** 全天提醒时间 setting. */
  allDayTime: string;
  /** The user's 通知渠道, to choose where the reminders go. */
  channels: NotificationChannel[];
  timeZone: string;
  now: Date;
  isMobile: boolean;
  disabled?: boolean;
  onSave: (dates: TaskDatesInput | null, repeat: RepeatRule | null, reminders: ReminderSettings) => void;
}

/** The detail-header date control: the current label, opening the picker. */
export function TaskDateButton({ dates, repeat, reminders, allDayTime, channels, timeZone, now, isMobile, disabled, onSave }: TaskDateButtonProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const label = dates ? describeTaskDates(dates, { now, timeZone }) : null;
  const repeatText = dates && repeat ? describeRepeatFrequency(repeat, dueDay(dates, timeZone)) : null;
  const reminderText = dates && reminders.reminders.length > 0 ? describeReminders(reminders.reminders, allDayTime) : null;

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div className="date-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={`date-trigger ${label ? 'date-trigger-set' : ''} ${label?.overdue ? 'date-overdue' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={label ? `日期：${label.text}${label.overdue ? '，已过期' : ''}${repeatText ? `，重复：${repeatText}` : ''}${reminderText ? `，提醒：${reminderText}` : ''}` : '设置日期'}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="calendar" size={16} />
        <span>{label?.text ?? '截止日期'}</span>
        {reminderText && <Icon name="alarm" size={14} className="date-trigger-repeat" />}
        {repeatText && <Icon name="repeat" size={14} className="date-trigger-repeat" />}
      </button>
      {open && (
        <DatePickerPopover
          id={popoverId}
          dates={dates}
          repeat={repeat}
          reminders={reminders}
          allDayTime={allDayTime}
          channels={channels}
          timeZone={timeZone}
          today={todayIn(now, timeZone)}
          isMobile={isMobile}
          anchor={buttonRef}
          onCancel={close}
          onSave={(value, rule, extra) => {
            close();
            onSave(value, rule, extra);
          }}
        />
      )}
    </div>
  );
}

function DatePickerPopover({
  id,
  dates,
  repeat,
  reminders,
  allDayTime,
  channels,
  timeZone,
  today,
  isMobile,
  anchor,
  onCancel,
  onSave,
}: {
  id: string;
  dates: TaskDates | null;
  repeat: RepeatRule | null;
  reminders: ReminderSettings;
  allDayTime: string;
  channels: NotificationChannel[];
  timeZone: string;
  today: string;
  isMobile: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onSave: (dates: TaskDatesInput | null, repeat: RepeatRule | null, reminders: ReminderSettings) => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(dates, timeZone, repeat, reminders));
  /** 自定义重复 editor shown instead of the date panel. */
  const [customRepeat, setCustomRepeat] = useState(false);
  /** 自定义提醒 editor, likewise. */
  const [customReminder, setCustomReminder] = useState(false);
  const [editing, setEditing] = useState<'start' | 'due'>('start');
  const [view, setView] = useState(() => monthStart(draft.due ?? today));
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onCancelRef.current();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [anchor]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const { dates: result, error } = inputFrom(draft, timeZone);
  /** The day a new series starts on: the chosen due date, or today. */
  const repeatAnchor = draft.due ?? today;

  function setRepeat(rule: RepeatRule | null) {
    // A 重复规则 needs a date: like 滴答, choosing one without a date starts today.
    update(rule && !draft.due ? { repeat: rule, due: today } : { repeat: rule });
  }

  function closeCustom() {
    setCustomRepeat(false);
    // Focus goes back to the 重复 row once it is rendered again.
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.date-repeat-trigger[aria-label^="重复："]')?.focus());
  }

  function closeCustomReminder() {
    setCustomReminder(false);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.date-reminder-trigger')?.focus());
  }

  /** The reminders 确定 saves: the ones that fit the chosen kind of date. */
  const draftReminders = draft.due ? fittingReminders(draft.reminders, draft.allDay) : [];

  function setReminders(next: typeof draft.reminders) {
    // Like 重复: choosing a reminder without a date starts today.
    update(next.length > 0 && !draft.due ? { reminders: next, due: today } : { reminders: next });
  }

  function setMode(mode: Mode) {
    if (mode === draft.mode) return;
    if (mode === 'range') {
      update({ mode, start: draft.start ?? draft.due, dueTime: draft.allDay ? DEFAULT_DUE_TIME : draft.dueTime });
      setEditing('start');
    } else {
      update({ mode, start: null });
    }
  }

  function pick(date: string) {
    if (draft.mode === 'date') {
      update({ due: date });
      return;
    }
    if (editing === 'start' || !draft.start) {
      update({ start: date, due: draft.due && draft.due >= date ? draft.due : date });
      setEditing('due');
    } else if (date < draft.start) {
      update({ start: date });
    } else {
      update({ due: date });
    }
  }

  function quick(date: string) {
    update(draft.mode === 'date' ? { due: date } : { start: date, due: draft.due && draft.due >= date ? draft.due : date });
    setView(monthStart(date));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next: Mode = draft.mode === 'date' ? 'range' : 'date';
      setMode(next);
      ref.current?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-tab-${next}`)}`)?.focus();
    }
  }

  const tab = (mode: Mode, text: string) => (
    <button
      type="button"
      role="tab"
      id={`${uid}-tab-${mode}`}
      aria-selected={draft.mode === mode}
      aria-controls={`${uid}-panel`}
      tabIndex={draft.mode === mode ? 0 : -1}
      className="date-tab"
      onClick={() => setMode(mode)}
      onKeyDown={onTabKeyDown}
    >
      {text}
    </button>
  );

  const popover = (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label="设置日期"
      className={`date-popover ${isMobile ? 'date-popover-sheet' : ''}`}
      onKeyDown={onKeyDown}
    >
      {customReminder ? (
        <ReminderEditor
          allDay={draft.allDay}
          allDayTime={allDayTime}
          onCancel={closeCustomReminder}
          onSave={(reminder) => {
            setReminders(sortReminders([...draftReminders, reminder]));
            closeCustomReminder();
          }}
        />
      ) : customRepeat ? (
        <RepeatEditor
          value={draft.repeat}
          anchor={repeatAnchor}
          onCancel={closeCustom}
          onSave={(rule) => {
            setRepeat(rule);
            closeCustom();
          }}
        />
      ) : (
        <>
          <div role="tablist" aria-label="日期类型" className="date-tabs">
            {tab('date', '日期')}
            {tab('range', '时间段')}
          </div>
          <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${draft.mode}`} className="date-panel">
            {draft.mode === 'date' ? (
              <div className="date-quick" role="group" aria-label="快捷日期">
                {(
                  [
                    ['今天', today],
                    ['明天', addDays(today, 1)],
                    ['下周', addDays(today, 7)],
                    ['下月', addMonths(today, 1)],
                  ] as const
                ).map(([text, date]) => (
                  <button key={text} type="button" className="date-quick-button" title={fullDateLabel(date)} onClick={() => quick(date)}>
                    {text}
                  </button>
                ))}
              </div>
            ) : (
              <div className="date-range-ends" role="group" aria-label="选择要修改的日期">
                {(['start', 'due'] as const).map((end) => {
                  const value = end === 'start' ? draft.start : draft.due;
                  return (
                    <button
                      key={end}
                      type="button"
                      className="date-range-end"
                      aria-pressed={editing === end}
                      onClick={() => setEditing(end)}
                    >
                      <span className="date-range-end-label">{end === 'start' ? '开始' : '结束'}</span>
                      <span>{value ? fullDateLabel(value) : '未设置'}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <MonthCalendar
              view={view}
              today={today}
              draft={draft}
              onView={setView}
              onPick={pick}
            />

            {draft.mode === 'date' ? (
              <div className="date-row">
                <Icon name="clock" size={16} />
                <label htmlFor={`${uid}-time`}>时间</label>
                <input
                  id={`${uid}-time`}
                  type="time"
                  className="date-time-input"
                  value={draft.allDay ? '' : draft.dueTime}
                  onChange={(e) =>
                    e.target.value
                      ? update({ allDay: false, dueTime: e.target.value, due: draft.due ?? today })
                      : update({ allDay: true })
                  }
                />
                {!draft.allDay && (
                  <IconButton icon="close" size={14} label="清除时间" className="date-row-clear" onClick={() => update({ allDay: true })} />
                )}
              </div>
            ) : (
              <>
                <div className="date-row">
                  <input
                    id={`${uid}-allday`}
                    type="checkbox"
                    className="date-allday"
                    checked={draft.allDay}
                    onChange={(e) => update({ allDay: e.target.checked })}
                  />
                  <label htmlFor={`${uid}-allday`}>全天</label>
                </div>
                {!draft.allDay && (
                  <div className="date-row date-row-times">
                    <label htmlFor={`${uid}-start-time`}>开始时间</label>
                    <input
                      id={`${uid}-start-time`}
                      type="time"
                      className="date-time-input"
                      required
                      value={draft.startTime}
                      onChange={(e) => e.target.value && update({ startTime: e.target.value })}
                    />
                    <label htmlFor={`${uid}-due-time`}>结束时间</label>
                    <input
                      id={`${uid}-due-time`}
                      type="time"
                      className="date-time-input"
                      required
                      value={draft.dueTime}
                      onChange={(e) => e.target.value && update({ dueTime: e.target.value })}
                    />
                  </div>
                )}
              </>
            )}
            <ReminderRow
              value={draftReminders}
              allDay={draft.allDay}
              allDayTime={allDayTime}
              onChange={setReminders}
              onCustom={() => setCustomReminder(true)}
            />
            {draftReminders.length > 0 && (
              <ReminderChannelsRow channels={channels} value={draft.channelIds} onChange={(channelIds) => update({ channelIds })} />
            )}
            <RepeatRow value={draft.repeat} anchor={repeatAnchor} onChange={setRepeat} onCustom={() => setCustomRepeat(true)} />
            {error && (
              <p className="date-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="date-footer">
            <Button onClick={() => onSave(null, null, { reminders: [], reminderChannelIds: draft.channelIds })}>清除</Button>
            <Button
              variant="primary"
              disabled={error !== null}
              onClick={() =>
                onSave(result, result ? draft.repeat : null, { reminders: result ? draftReminders : [], reminderChannelIds: draft.channelIds })
              }
            >
              确定
            </Button>
          </div>
        </>
      )}
    </div>
  );

  if (!isMobile) return popover;
  return (
    <>
      <div className="date-scrim" aria-hidden="true" />
      {popover}
    </>
  );
}

/** Month grid, weeks from Sunday: ←/→/↑/↓ move by day and week, PageUp/PageDown by month, Enter picks. */
function MonthCalendar({
  view,
  today,
  draft,
  onView,
  onPick,
}: {
  view: string;
  today: string;
  draft: Draft;
  onView: (view: string) => void;
  onPick: (date: string) => void;
}) {
  const [focusDate, setFocusDate] = useState(() => draft.due ?? today);
  const gridRef = useRef<HTMLTableElement>(null);
  const moved = useRef(false);
  const active = focusDate.slice(0, 7) === view.slice(0, 7) ? focusDate : view;

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)?.focus();
  }, [active]);

  const first = addDays(view, -weekday(view));
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)));
  const [y, m] = view.split('-').map(Number);
  const rangeStart = draft.mode === 'range' ? draft.start : null;

  function move(date: string) {
    moved.current = true;
    setFocusDate(date);
    if (date.slice(0, 7) !== view.slice(0, 7)) onView(monthStart(date));
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const steps: Record<string, () => string> = {
      ArrowLeft: () => addDays(date, -1),
      ArrowRight: () => addDays(date, 1),
      ArrowUp: () => addDays(date, -7),
      ArrowDown: () => addDays(date, 7),
      Home: () => addDays(date, -weekday(date)),
      End: () => addDays(date, 6 - weekday(date)),
      PageUp: () => addMonths(date, -1),
      PageDown: () => addMonths(date, 1),
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      move(step());
    }
  }

  return (
    <div className="date-calendar">
      <div className="date-calendar-header">
        <span className="date-calendar-title" aria-live="polite">
          {y}年{m}月
        </span>
        <IconButton icon="chevronLeft" size={16} label="上个月" onClick={() => onView(addMonths(view, -1))} />
        <IconButton icon="chevronRight" size={16} label="下个月" onClick={() => onView(addMonths(view, 1))} />
      </div>
      <table ref={gridRef} className="date-grid" role="grid" aria-label={`${y}年${m}月`}>
        <thead>
          <tr>
            {WEEK_HEADER.map((d) => (
              <th key={d} scope="col" abbr={`周${d}`}>
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((date) => {
                const selected = date === draft.due || date === rangeStart;
                const inRange = rangeStart !== null && draft.due !== null && date > rangeStart && date < draft.due;
                const outside = date.slice(0, 7) !== view.slice(0, 7);
                return (
                  <td key={date} role="gridcell" aria-selected={selected}>
                    <button
                      type="button"
                      data-date={date}
                      tabIndex={date === active ? 0 : -1}
                      aria-label={`${fullDateLabel(date)}${date === today ? '（今天）' : ''}`}
                      aria-current={date === today ? 'date' : undefined}
                      className={[
                        'date-day',
                        selected ? 'date-day-selected' : '',
                        inRange ? 'date-day-in-range' : '',
                        outside ? 'date-day-outside' : '',
                        date === today ? 'date-day-today' : '',
                      ].join(' ')}
                      onClick={() => {
                        setFocusDate(date);
                        onPick(date);
                      }}
                      onKeyDown={(e) => onKeyDown(e, date)}
                    >
                      {Number(date.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
