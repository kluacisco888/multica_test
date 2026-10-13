import {
  CALENDAR_MODE_LABELS,
  CALENDAR_MODES,
  calendarDays,
  calendarTitle,
  daysBetween,
  layoutDayBars,
  moveTaskByDays,
  placeTaskAt,
  placeTaskOnDay,
  stepCalendar,
  taskSpan,
  TASK_TITLE_MAX_LENGTH,
  WEEKDAY_NAMES,
  weekday,
  zonedDateTime,
  zonedToInstant,
  type CalendarDay,
  type CalendarMode,
  type Task,
  type TaskDates,
  type TaskDatesInput,
  type TaskList,
  type TaskSpan,
} from '@dida/shared';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import { IconButton } from '../ui/controls.js';

/*
 * 日历视图 (spec 用户故事 69–71): 月 / 周 / 日 / 多日. Tasks sit on the days
 * they fall on in the user's current time zone; 日期区间 are 长条 across days.
 * Drag a task to another day (月, 全天 row) or time (周 / 日 / 多日) to change
 * its dates; click an empty day or time slot to add a task there. Keyboard and
 * touch users open the task (Enter on its button) and change the date in the
 * detail's date picker. The date arithmetic lives in shared `calendar.ts`.
 */

/** Height of one hour in the time grid, px (kept in sync with --calendar-hour-height). */
const HOUR_HEIGHT = 48;
/** One 长条 lane in a day cell, px (--calendar-lane-height). */
const LANE_HEIGHT = 22;
/** Day number line at the top of a 月 cell, px (--calendar-cell-head / --calendar-cell-head-mobile). */
const CELL_HEAD = 28;
const CELL_HEAD_MOBILE = 38;
/** Drag snaps to this many minutes in the time grid. */
const SNAP_MINUTES = 15;
/** Shortest block drawn in the time grid (a timed point is drawn this long). */
const MIN_BLOCK_MINUTES = 30;
const DAY_MINUTES = 24 * 60;
const SCROLL_TO_HOUR = 8;

export interface CalendarPaneProps {
  mode: CalendarMode;
  anchor: string;
  today: string;
  /** Tasks of the days on screen; null while loading. */
  tasks: Task[] | null;
  /** 农历, 节日, 休 / 班 by date; missing days show no label. */
  days: ReadonlyMap<string, CalendarDay>;
  lists: TaskList[];
  timeZone: string;
  now: Date;
  selectedTaskId: string | null;
  isMobile: boolean;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onNavigate: (mode: CalendarMode, anchor: string) => void;
  onSelectTask: (taskId: string) => void;
  onCreateTask: (title: string, dates: TaskDatesInput) => Promise<boolean>;
  onMoveTask: (task: Task, dates: TaskDatesInput) => void;
}

/** What is being dragged: the task, and where in it the pointer grabbed it. */
interface DragState {
  task: Task;
  /** 月 / 全天 row: the day under the pointer when the drag started. */
  grabDate: string | null;
  /** Time grid: minutes between the block's top and the pointer. */
  grabMinutes: number;
}

interface QuickAddState {
  date: string;
  /** `HH:mm` for a time slot; null: all-day. */
  time: string | null;
  x: number;
  y: number;
  opener: HTMLElement | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const toTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

const instant = (value: string | null | undefined) => (value ? Date.parse(value) : null);

/** Would `next` leave the task where it is? (A drop back on its own slot.) */
function sameDates(current: TaskDates, next: TaskDatesInput): boolean {
  if (current.allDay || next.allDay) return false;
  return instant(current.startAt) === instant(next.startAt) && instant(current.dueAt) === instant(next.dueAt);
}

export function dayLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日`;
}

const SHORT_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;
const MARK_TEXT = { holiday: '休', makeup_workday: '班' } as const;
const MARK_NAMES = { holiday: '休息', makeup_workday: '补班' } as const;

/** Accessible description of a day: 10月1日 周四 国庆节 休息. */
function dayDescription(date: string, info: CalendarDay | undefined): string {
  const parts = [dayLabel(date), WEEKDAY_NAMES[weekday(date)]];
  if (info) parts.push(info.label);
  if (info?.mark) parts.push(`${info.holidayName ?? ''}${MARK_NAMES[info.mark]}`);
  return parts.join(' ');
}

function barStyle(task: Task, lists: TaskList[]): CSSProperties | undefined {
  const color = lists.find((l) => l.id === task.listId)?.color;
  return color ? ({ '--bar-color': color } as CSSProperties) : undefined;
}

function useElementHeight<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

/** Column (0-based) of `days` under the pointer in a row element spanning them. */
function columnAt(event: { clientX: number }, row: HTMLElement, count: number): number {
  const rect = row.getBoundingClientRect();
  return Math.min(count - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * count)));
}

export function CalendarPane(props: CalendarPaneProps) {
  const { mode, anchor, today, tasks, timeZone, isMobile } = props;
  const visibleDays = calendarDays(mode, anchor);
  const drag = useRef<DragState | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<QuickAddState | null>(null);

  const spans = new Map<string, TaskSpan>();
  for (const task of tasks ?? []) if (task.dates) spans.set(task.id, taskSpan(task.dates, timeZone));

  function openQuickAdd(event: MouseEvent<HTMLElement>, date: string, time: string | null) {
    const rect = event.currentTarget.getBoundingClientRect();
    const fromPointer = event.detail > 0;
    setQuickAdd({
      date,
      time,
      x: fromPointer ? event.clientX : rect.left + 8,
      y: fromPointer ? event.clientY : rect.top + 8,
      opener: event.currentTarget,
    });
  }

  function startDrag(event: DragEvent<HTMLElement>, task: Task, state: Omit<DragState, 'task'>) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
    drag.current = { task, ...state };
  }

  function endDrag() {
    drag.current = null;
    setDropDate(null);
  }

  /** Drop on a day of the 月视图: same clock time, `date - grabDate` days later. */
  function dropOnMonthDay(date: string) {
    const d = drag.current;
    endDrag();
    if (!d?.task.dates || !d.grabDate) return;
    const days = daysBetween(d.grabDate, date);
    if (days !== 0) props.onMoveTask(d.task, moveTaskByDays(d.task.dates, days, timeZone));
  }

  /** Drop on the 全天 row: all-day, starting on `date`. */
  function dropOnAllDay(date: string) {
    const d = drag.current;
    endDrag();
    if (!d?.task.dates) return;
    if (d.task.dates.allDay && d.grabDate) {
      const days = daysBetween(d.grabDate, date);
      if (days !== 0) props.onMoveTask(d.task, moveTaskByDays(d.task.dates, days, timeZone));
      return;
    }
    props.onMoveTask(d.task, placeTaskOnDay(d.task.dates, date, timeZone));
  }

  /** Drop in a time column: the block's top goes to the snapped time under it. */
  function dropAtTime(date: string, pointerMinutes: number) {
    const d = drag.current;
    endDrag();
    if (!d?.task.dates) return;
    const raw = pointerMinutes - d.grabMinutes;
    const minutes = Math.min(DAY_MINUTES - SNAP_MINUTES, Math.max(0, Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES));
    const next = placeTaskAt(d.task.dates, date, toTime(minutes), timeZone);
    if (!sameDates(d.task.dates, next)) props.onMoveTask(d.task, next);
  }

  const title = calendarTitle(mode, anchor);

  return (
    <main className={`calendar-pane calendar-pane-${mode}`} aria-busy={tasks === null}>
      <header className="calendar-header">
        {isMobile && (
          <IconButton
            icon="sidebar"
            label={props.sidebarVisible ? '收起侧栏' : '展开侧栏'}
            aria-expanded={props.sidebarVisible}
            onClick={props.onToggleSidebar}
            className="list-pane-sidebar-toggle"
          />
        )}
        <h1 className="calendar-title">{title}</h1>
        <div className="calendar-modes" role="group" aria-label="日历视图">
          {CALENDAR_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`calendar-mode ${m === mode ? 'calendar-mode-active' : ''}`}
              aria-pressed={m === mode}
              onClick={() => props.onNavigate(m, m === 'month' ? anchor : visibleDays.includes(today) ? today : anchor)}
            >
              {CALENDAR_MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="calendar-nav">
          <IconButton icon="chevronLeft" label="上一页" onClick={() => props.onNavigate(mode, stepCalendar(mode, anchor, -1))} />
          <button type="button" className="calendar-today" onClick={() => props.onNavigate(mode, today)}>
            今天
          </button>
          <IconButton icon="chevronRight" label="下一页" onClick={() => props.onNavigate(mode, stepCalendar(mode, anchor, 1))} />
        </div>
      </header>

      {tasks === null && (
        <p className="visually-hidden" role="status">
          正在加载…
        </p>
      )}

      {mode === 'month' ? (
        <MonthGrid
          {...props}
          visibleDays={visibleDays}
          spans={spans}
          dropDate={dropDate}
          onHoverDate={setDropDate}
          onStartDrag={startDrag}
          onEndDrag={endDrag}
          onDropDate={dropOnMonthDay}
          onOpenQuickAdd={openQuickAdd}
        />
      ) : (
        <TimeGrid
          {...props}
          visibleDays={visibleDays}
          spans={spans}
          dropDate={dropDate}
          onHoverDate={setDropDate}
          onStartDrag={startDrag}
          onEndDrag={endDrag}
          onDropAllDay={dropOnAllDay}
          onDropAtTime={dropAtTime}
          onOpenQuickAdd={openQuickAdd}
        />
      )}

      {quickAdd && (
        <QuickAddPopover
          state={quickAdd}
          onClose={() => {
            quickAdd.opener?.focus();
            setQuickAdd(null);
          }}
          onSubmit={async (taskTitle) => {
            const dates: TaskDatesInput = quickAdd.time
              ? { allDay: false, startAt: null, dueAt: zonedToInstant(quickAdd.date, quickAdd.time, timeZone) }
              : { allDay: true, startDate: null, dueDate: quickAdd.date };
            const ok = await props.onCreateTask(taskTitle, dates);
            if (ok) setQuickAdd(null);
            return ok;
          }}
        />
      )}
    </main>
  );
}

// --- 月视图 ------------------------------------------------------------------

interface GridProps extends CalendarPaneProps {
  visibleDays: string[];
  spans: Map<string, TaskSpan>;
  dropDate: string | null;
  onHoverDate: (date: string | null) => void;
  onStartDrag: (event: DragEvent<HTMLElement>, task: Task, state: Omit<DragState, 'task'>) => void;
  onEndDrag: () => void;
  onOpenQuickAdd: (event: MouseEvent<HTMLElement>, date: string, time: string | null) => void;
}

function MonthGrid(props: GridProps & { onDropDate: (date: string) => void }) {
  const { visibleDays, spans, anchor, today, tasks, isMobile } = props;
  const [weeksRef, weeksHeight] = useElementHeight<HTMLDivElement>();
  const weeks: string[][] = [];
  for (let i = 0; i < visibleDays.length; i += 7) weeks.push(visibleDays.slice(i, i + 7));
  const month = anchor.slice(0, 7);
  const rowHeight = weeks.length > 0 ? weeksHeight / weeks.length : 0;
  const cellHead = isMobile ? CELL_HEAD_MOBILE : CELL_HEAD;
  // Lanes that fit under the day number, keeping one for "+N".
  const fit = Math.max(1, Math.floor((rowHeight - cellHead) / LANE_HEIGHT));
  const dated = (tasks ?? []).filter((t) => spans.has(t.id));
  const byId = new Map(dated.map((t) => [t.id, t]));
  // Within a day: all-day before timed, then by time, then list order.
  const ordered = [...dated].sort((a, b) => {
    const sa = spans.get(a.id) as TaskSpan;
    const sb = spans.get(b.id) as TaskSpan;
    if (sa.allDay !== sb.allDay) return sa.allDay ? -1 : 1;
    if (!sa.allDay && !sb.allDay) return sa.startTime.localeCompare(sb.startTime);
    return 0;
  });

  return (
    <div className="calendar-month">
      <div className="calendar-weekdays" aria-hidden="true">
        {visibleDays.slice(0, 7).map((date) => (
          <span key={date}>{isMobile ? SHORT_WEEKDAYS[weekday(date)] : WEEKDAY_NAMES[weekday(date)]}</span>
        ))}
      </div>
      <div className="calendar-weeks" ref={weeksRef}>
        {weeks.map((week) => {
          const bars = layoutDayBars(
            week,
            ordered.map((t) => ({ id: t.id, ...(spans.get(t.id) as TaskSpan) })),
          );
          const used = Math.max(0, ...bars.map((b) => b.lane + 1));
          const lanes = used <= fit ? fit : Math.max(1, fit - 1);
          const shown = bars.filter((b) => b.lane < lanes);
          const hiddenPerDay = week.map((_, col) => bars.filter((b) => b.lane >= lanes && b.startColumn <= col && b.endColumn >= col).length);
          return (
            <div
              key={week[0]}
              className="calendar-week"
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                props.onHoverDate(week[columnAt(e, e.currentTarget, 7)] ?? null);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onHoverDate(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const date = week[columnAt(e, e.currentTarget, 7)];
                if (date) props.onDropDate(date);
              }}
            >
              {week.map((date, col) => {
                const info = props.days.get(date);
                return (
                  <div
                    key={date}
                    className={[
                      'calendar-cell',
                      date.slice(0, 7) !== month ? 'calendar-cell-outside' : '',
                      date === today ? 'calendar-cell-today' : '',
                      props.dropDate === date ? 'calendar-cell-drop' : '',
                      info?.mark ? `calendar-cell-${info.mark}` : '',
                    ].join(' ')}
                    style={{ gridColumn: col + 1 }}
                  >
                    <button
                      type="button"
                      className="calendar-cell-add"
                      aria-label={`${dayDescription(date, info)}，新建任务`}
                      onClick={(e) => props.onOpenQuickAdd(e, date, null)}
                    >
                      <DayHead date={date} info={info} />
                    </button>
                    {hiddenPerDay[col]! > 0 && (
                      <button
                        type="button"
                        className="calendar-more"
                        style={{ top: cellHead + lanes * LANE_HEIGHT }}
                        aria-label={`${dayLabel(date)}还有 ${hiddenPerDay[col]} 项，打开日视图`}
                        onClick={() => props.onNavigate('day', date)}
                      >
                        +{hiddenPerDay[col]}
                      </button>
                    )}
                  </div>
                );
              })}
              <ul className="calendar-bars" aria-label={`${dayLabel(week[0]!)}–${dayLabel(week[6]!)}的任务`}>
                {shown.map((bar) => {
                  const task = byId.get(bar.id) as Task;
                  const span = spans.get(bar.id) as TaskSpan;
                  const single = bar.startColumn === bar.endColumn && !bar.continuesBefore && !bar.continuesAfter;
                  return (
                    <li
                      key={bar.id}
                      className="calendar-bar-slot"
                      style={{
                        left: `calc(${bar.startColumn} * 100% / 7)`,
                        width: `calc(${bar.endColumn - bar.startColumn + 1} * 100% / 7)`,
                        top: cellHead + bar.lane * LANE_HEIGHT,
                      }}
                    >
                      <TaskBar
                        task={task}
                        span={span}
                        lists={props.lists}
                        selected={task.id === props.selectedTaskId}
                        // A timed task on one day reads as a line with its time, like the reference.
                        variant={!span.allDay && single ? 'dot' : 'bar'}
                        continuesBefore={bar.continuesBefore}
                        continuesAfter={bar.continuesAfter}
                        onSelect={() => props.onSelectTask(task.id)}
                        onDragStart={(e) => {
                          const row = e.currentTarget.closest('.calendar-week') as HTMLElement;
                          props.onStartDrag(e, task, { grabDate: week[columnAt(e, row, 7)] ?? null, grabMinutes: 0 });
                        }}
                        onDragEnd={props.onEndDrag}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayHead({ date, info }: { date: string; info: CalendarDay | undefined }) {
  const festive = info ? info.festivals.length > 0 || info.solarTerm !== null : false;
  return (
    <span className="calendar-day-head" aria-hidden="true">
      <span className="calendar-day-number">{Number(date.slice(8))}</span>
      {info && <span className={`calendar-lunar ${festive ? 'calendar-lunar-festival' : ''}`}>{info.label}</span>}
      {info?.mark && (
        <span className={`calendar-mark calendar-mark-${info.mark}`} title={`${info.holidayName ?? ''}${MARK_NAMES[info.mark]}`}>
          {MARK_TEXT[info.mark]}
        </span>
      )}
    </span>
  );
}

function TaskBar({
  task,
  span,
  lists,
  selected,
  variant,
  continuesBefore,
  continuesAfter,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  span: TaskSpan;
  lists: TaskList[];
  selected: boolean;
  variant: 'bar' | 'dot';
  continuesBefore: boolean;
  continuesAfter: boolean;
  onSelect: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const done = task.status !== 'open';
  return (
    <button
      type="button"
      draggable
      className={[
        'calendar-task',
        `calendar-task-${variant}`,
        done ? 'calendar-task-done' : '',
        selected ? 'calendar-task-selected' : '',
        continuesBefore ? 'calendar-task-cut-start' : '',
        continuesAfter ? 'calendar-task-cut-end' : '',
      ].join(' ')}
      style={barStyle(task, lists)}
      aria-pressed={selected}
      onClick={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {!span.allDay && variant === 'dot' && <span className="calendar-task-time">{span.startTime}</span>}
      <span className="calendar-task-title">{task.title}</span>
    </button>
  );
}

// --- 周 / 日 / 多日 ----------------------------------------------------------

interface Block {
  task: Task;
  top: number;
  bottom: number;
  column: number;
  columns: number;
  label: string;
}

/** Timed blocks of one day column, side by side where they overlap. */
function dayBlocks(date: string, tasks: Task[], spans: Map<string, TaskSpan>, timeZone: string): Block[] {
  const items: Omit<Block, 'column' | 'columns'>[] = [];
  for (const task of tasks) {
    const span = spans.get(task.id);
    if (!span || span.allDay || date < span.start || date > span.end || !task.dates || task.dates.allDay) continue;
    const point = !task.dates.startAt;
    const top = date === span.start ? toMinutes(span.startTime) : 0;
    const end = point ? top + MIN_BLOCK_MINUTES : date === span.end ? toMinutes(span.endTime) : DAY_MINUTES;
    const bottom = Math.min(DAY_MINUTES, Math.max(end, top + MIN_BLOCK_MINUTES));
    const due = zonedDateTime(task.dates.dueAt, timeZone).time;
    items.push({ task, top, bottom, label: point ? span.startTime : `${span.startTime} - ${due}` });
  }
  items.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // Greedy columns within clusters of overlapping blocks.
  const result: Block[] = [];
  let cluster: Block[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const columns = Math.max(1, ...cluster.map((b) => b.column + 1));
    for (const b of cluster) result.push({ ...b, columns });
    cluster = [];
  };
  for (const item of items) {
    if (item.top >= clusterEnd && cluster.length > 0) flush();
    const ends: number[] = [];
    for (const b of cluster) ends[b.column] = Math.max(ends[b.column] ?? 0, b.bottom);
    let column = ends.findIndex((end) => end <= item.top);
    if (column === -1) column = ends.length;
    cluster.push({ ...item, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, item.bottom);
  }
  if (cluster.length > 0) flush();
  return result;
}

function TimeGrid(
  props: GridProps & {
    onDropAllDay: (date: string) => void;
    onDropAtTime: (date: string, minutes: number) => void;
  },
) {
  const { visibleDays, spans, today, tasks, timeZone, now, isMobile } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = visibleDays.length;
  const dated = (tasks ?? []).filter((t) => spans.has(t.id));
  const allDayTasks = dated.filter((t) => (spans.get(t.id) as TaskSpan).allDay);
  const byId = new Map(dated.map((t) => [t.id, t]));
  const allDayBars = layoutDayBars(
    visibleDays,
    allDayTasks.map((t) => ({ id: t.id, ...(spans.get(t.id) as TaskSpan) })),
  );
  const allDayLanes = Math.max(1, ...allDayBars.map((b) => b.lane + 1));
  const nowPoint = zonedDateTime(now, timeZone);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_HEIGHT - 8;
  }, []);

  const gridStyle = { '--calendar-days': count } as CSSProperties;

  return (
    <div className="calendar-timegrid" style={gridStyle}>
      <div className="calendar-tg-head">
        <span className="calendar-tg-gutter" aria-hidden="true" />
        {visibleDays.map((date) => {
          const info = props.days.get(date);
          return (
            <div key={date} className={`calendar-tg-day ${date === today ? 'calendar-tg-day-today' : ''}`} aria-hidden="true">
              <span className="calendar-tg-weekday">{isMobile ? SHORT_WEEKDAYS[weekday(date)] : WEEKDAY_NAMES[weekday(date)]}</span>
              <DayHead date={date} info={info} />
            </div>
          );
        })}
      </div>

      <div className="calendar-allday">
        <span className="calendar-tg-gutter calendar-allday-label">全天</span>
        <div
          className="calendar-allday-row"
          style={{ height: allDayLanes * LANE_HEIGHT + 6 }}
          onDragOver={(e) => {
            e.preventDefault();
            props.onHoverDate(visibleDays[columnAt(e, e.currentTarget, count)] ?? null);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onHoverDate(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const date = visibleDays[columnAt(e, e.currentTarget, count)];
            if (date) props.onDropAllDay(date);
          }}
        >
          {visibleDays.map((date, col) => (
            <button
              key={date}
              type="button"
              className={`calendar-allday-cell ${props.dropDate === date ? 'calendar-cell-drop' : ''}`}
              style={{ gridColumn: col + 1 }}
              aria-label={`${dayDescription(date, props.days.get(date))}，新建全天任务`}
              onClick={(e) => props.onOpenQuickAdd(e, date, null)}
            />
          ))}
          <ul className="calendar-bars" aria-label="全天任务">
            {allDayBars.map((bar) => {
              const task = byId.get(bar.id) as Task;
              return (
                <li
                  key={bar.id}
                  className="calendar-bar-slot"
                  style={{
                    left: `calc(${bar.startColumn} * 100% / ${count})`,
                    width: `calc(${bar.endColumn - bar.startColumn + 1} * 100% / ${count})`,
                    top: 3 + bar.lane * LANE_HEIGHT,
                  }}
                >
                  <TaskBar
                    task={task}
                    span={spans.get(bar.id) as TaskSpan}
                    lists={props.lists}
                    selected={task.id === props.selectedTaskId}
                    variant="bar"
                    continuesBefore={bar.continuesBefore}
                    continuesAfter={bar.continuesAfter}
                    onSelect={() => props.onSelectTask(task.id)}
                    onDragStart={(e) => {
                      const row = e.currentTarget.closest('.calendar-allday-row') as HTMLElement;
                      props.onStartDrag(e, task, { grabDate: visibleDays[columnAt(e, row, count)] ?? null, grabMinutes: 0 });
                    }}
                    onDragEnd={props.onEndDrag}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="calendar-tg-scroll" ref={scrollRef}>
        <div className="calendar-tg-body" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className="calendar-tg-gutter calendar-tg-hours" aria-hidden="true">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="calendar-tg-hour" style={{ top: h * HOUR_HEIGHT }}>
                {h === 0 ? '' : `${pad(h)}:00`}
              </span>
            ))}
          </div>
          {visibleDays.map((date) => (
            <div
              key={date}
              className={`calendar-tg-col ${date === today ? 'calendar-tg-col-today' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                props.onDropAtTime(date, ((e.clientY - rect.top) / HOUR_HEIGHT) * 60);
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <button
                  key={h}
                  type="button"
                  tabIndex={-1}
                  className="calendar-slot"
                  style={{ top: h * HOUR_HEIGHT }}
                  aria-label={`${dayLabel(date)} ${pad(h)}:00，新建任务`}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const half = e.detail > 0 && e.clientY - rect.top >= HOUR_HEIGHT / 2;
                    props.onOpenQuickAdd(e, date, `${pad(h)}:${half ? '30' : '00'}`);
                  }}
                />
              ))}
              {date === nowPoint.date && (
                <span className="calendar-now" style={{ top: (toMinutes(nowPoint.time) / 60) * HOUR_HEIGHT }} aria-hidden="true" />
              )}
              <ul className="calendar-blocks" aria-label={`${dayLabel(date)}的任务`}>
                {dayBlocks(date, dated, spans, timeZone).map((block) => (
                  <li
                    key={block.task.id}
                    className="calendar-block-slot"
                    style={{
                      top: (block.top / 60) * HOUR_HEIGHT,
                      height: ((block.bottom - block.top) / 60) * HOUR_HEIGHT,
                      left: `calc(${block.column} * 100% / ${block.columns})`,
                      width: `calc(100% / ${block.columns})`,
                    }}
                  >
                    <button
                      type="button"
                      draggable
                      className={[
                        'calendar-task',
                        'calendar-task-block',
                        block.bottom - block.top < 60 ? 'calendar-task-short' : '',
                        block.task.status !== 'open' ? 'calendar-task-done' : '',
                        block.task.id === props.selectedTaskId ? 'calendar-task-selected' : '',
                      ].join(' ')}
                      style={barStyle(block.task, props.lists)}
                      aria-pressed={block.task.id === props.selectedTaskId}
                      onClick={() => props.onSelectTask(block.task.id)}
                      onDragStart={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        props.onStartDrag(e, block.task, { grabDate: null, grabMinutes: ((e.clientY - rect.top) / HOUR_HEIGHT) * 60 });
                      }}
                      onDragEnd={props.onEndDrag}
                    >
                      <span className="calendar-task-title">{block.task.title}</span>
                      <span className="calendar-task-time">{block.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- 新建任务 ------------------------------------------------------------------

function QuickAddPopover({
  state,
  onClose,
  onSubmit,
}: {
  state: QuickAddState;
  onClose: () => void;
  onSubmit: (title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  const when = `${dayLabel(state.date)}${state.time ? ` ${state.time}` : ''}`;

  useEffect(() => {
    ref.current?.querySelector('input')?.focus();
  }, []);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const ok = await onSubmit(trimmed);
    setBusy(false);
    if (ok) setTitle('');
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  const width = 280;
  const left = Math.max(8, Math.min(state.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(state.y, window.innerHeight - 96));

  return (
    <form
      ref={ref}
      className="calendar-quick-add"
      style={{ left, top, width }}
      aria-label={`新建任务：${when}`}
      onSubmit={(e) => void submit(e)}
      onKeyDown={onKeyDown}
    >
      <p className="calendar-quick-add-when">{when}</p>
      <input
        className="calendar-quick-add-input"
        aria-label="新任务标题"
        placeholder="准备做什么？回车保存"
        value={title}
        maxLength={TASK_TITLE_MAX_LENGTH}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
      />
    </form>
  );
}

