import {
  addDays,
  arrangeTasks,
  daysBetween,
  describeTaskDates,
  dragTaskDates,
  scheduleOnDay,
  timelineBar,
  timelineDays,
  timelineStart,
  todayIn,
  weekday,
  type Tag,
  type Task,
  type TaskDatesInput,
  type TaskList,
  type TimelineDrag,
  type ViewOptions,
} from '@dida/shared';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ContextMenu, IconButton, MenuButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { layoutMenuSections } from './TaskListPane.js';
import { viewTitle, type ListPaneView } from './views.js';

/*
 * 时间线视图 (spec 用户故事 68). Each open dated task is a bar from its start
 * day to its due day; a due-date-only task is a one-day bar; tasks without a
 * date wait in 待安排 until dropped on a day. Dragging a bar moves both dates,
 * dragging one of its ends moves that date (`dragTaskDates` in @dida/shared).
 * Keyboard: on a focused bar ←/→ moves it a day, Shift+←/→ moves the end,
 * Alt+←/→ the start; Enter opens the task.
 */

type Scale = 'day' | 'week' | 'month';

const SCALES: Record<Scale, { label: string; dayWidth: number; before: number; after: number; step: number }> = {
  // Day width measured on the reference (1440×900): 108px.
  day: { label: '日', dayWidth: 108, before: 35, after: 120, step: 7 },
  week: { label: '周', dayWidth: 36, before: 120, after: 360, step: 28 },
  month: { label: '月', dayWidth: 12, before: 365, after: 730, step: 91 },
};

const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'] as const;
/** Pointer travel (px) before a press on a bar counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Width of the task-name column (reference: 120px at both widths). */
const NAME_WIDTH = 120;

interface TimelinePaneProps {
  view: ListPaneView;
  tasks: Task[] | null;
  tags: Tag[];
  lists: TaskList[];
  selectedTaskId: string | null;
  sidebarVisible: boolean;
  timeZone: string;
  now: Date;
  viewOptions: ViewOptions;
  onChangeViewOptions: (options: ViewOptions) => void;
  onToggleSidebar: () => void;
  onSelectTask: (taskId: string) => void;
  /** Save new dates of `task` (a drag, a key press or a drop from 待安排). */
  onMoveTask: (task: Task, dates: TaskDatesInput) => void;
  onEditList: (() => void) | null;
}

type BarDrag = { taskId: string; edge: TimelineDrag; pointerId: number; startX: number; days: number; moved: boolean };
type Placing = { taskId: string; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean; day: string | null };

export function TimelinePane(props: TimelinePaneProps) {
  const { view, tasks, timeZone, now } = props;
  const [scale, setScale] = useState<Scale>('day');
  const { dayWidth, before, after, step } = SCALES[scale];
  const today = todayIn(now, timeZone);
  // The rendered days are fixed around today; ‹ › and 今天 scroll within them.
  const first = addDays(today, -before);
  const days = timelineDays(first, before + after);
  const [firstVisible, setFirstVisible] = useState(timelineStart(today));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number; opener: HTMLElement | null } | null>(null);
  const [drag, setDrag] = useState<BarDrag | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [unscheduledOpen, setUnscheduledOpen] = useState(true);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const hintId = 'timeline-bar-hint';

  const open = (tasks ?? []).filter((t) => t.status === 'open');
  const scheduled = open.filter((t) => t.dates !== null);
  const unscheduled = open.filter((t) => t.dates === null);
  const sections = arrangeTasks(scheduled, props.viewOptions, { now, timeZone, lists: props.lists, tags: props.tags });

  /**
   * Scroll so that `day` starts the visible days. At the 日 scale the first
   * day sits under the name column, 16px past its left edge, like the
   * reference (today's centre lands 254px from the pane's left at any width).
   */
  function scrollToDay(day: string, smooth = false) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const left = daysBetween(first, day) * dayWidth + (scale === 'day' ? NAME_WIDTH + 16 : 0);
    if (smooth && typeof scroller.scrollTo === 'function') scroller.scrollTo({ left, behavior: 'smooth' });
    else scroller.scrollLeft = left;
  }

  function scrollByDays(count: number) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ left: count * dayWidth, behavior: 'smooth' });
    else scroller.scrollLeft += count * dayWidth;
  }

  useLayoutEffect(() => {
    scrollToDay(timelineStart(today));
    // Re-centre when the scale changes; `today` only changes at midnight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  function onScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const index = Math.max(0, Math.min(days.length - 1, Math.floor(scroller.scrollLeft / dayWidth)));
    const day = days[index] as string;
    if (day !== firstVisible) setFirstVisible(day);
  }

  const [fy, fm] = firstVisible.split('-').map(Number) as [number, number];
  const monthLabel = fy === Number(today.slice(0, 4)) ? `${fm}月` : `${fy}年${fm}月`;

  function save(task: Task, dates: TaskDatesInput | null) {
    if (!dates) return;
    props.onMoveTask(task, dates);
    const text = describeTaskDates(dates.allDay ? { ...dates, startDate: dates.startDate ?? null } : { ...dates, startAt: dates.startAt ?? null, timeZone }, {
      now,
      timeZone,
    }).text;
    setAnnouncement(`${task.title}：${text}`);
  }

  // --- dragging a bar --------------------------------------------------------

  function onBarPointerDown(e: ReactPointerEvent<HTMLButtonElement>, task: Task) {
    if (e.button !== 0 || !task.dates) return;
    // A drag whose element went away (a 待安排 item once placed) never got its click.
    suppressClick.current = false;
    const edge = ((e.target as HTMLElement).dataset.edge as TimelineDrag | undefined) ?? 'move';
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ taskId: task.id, edge, pointerId: e.pointerId, startX: e.clientX, days: 0, moved: false });
  }

  function onBarPointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const moved = drag.moved || Math.abs(dx) >= DRAG_THRESHOLD;
    const nextDays = Math.round(dx / dayWidth);
    if (moved !== drag.moved || nextDays !== drag.days) setDrag({ ...drag, moved, days: nextDays });
  }

  function onBarPointerUp(e: ReactPointerEvent<HTMLButtonElement>, task: Task) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    setDrag(null);
    if (!drag.moved) return; // a click: onClick opens the task
    suppressClick.current = true;
    const days = Math.round((e.clientX - drag.startX) / dayWidth);
    if (days !== 0 && task.dates) save(task, dragTaskDates(task.dates, drag.edge, days, timeZone));
  }

  function onBarKeyDown(e: KeyboardEvent<HTMLButtonElement>, task: Task) {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !task.dates) return;
    e.preventDefault();
    const edge: TimelineDrag = e.shiftKey ? 'end' : e.altKey ? 'start' : 'move';
    save(task, dragTaskDates(task.dates, edge, e.key === 'ArrowRight' ? 1 : -1, timeZone));
  }

  // --- placing a 待安排 task -------------------------------------------------

  /** The day under a viewport point, or null outside the day tracks. */
  function dayAt(x: number, y: number): string | null {
    const tracks = tracksRef.current;
    const scroller = scrollerRef.current;
    if (!tracks || !scroller) return null;
    const area = scroller.getBoundingClientRect();
    const rect = tracks.getBoundingClientRect();
    if (x < Math.max(rect.left, area.left + NAME_WIDTH) || x > area.right || y < area.top || y > area.bottom) return null;
    return days[Math.floor((x - rect.left) / dayWidth)] ?? null;
  }

  function onPlacePointerDown(e: ReactPointerEvent<HTMLButtonElement>, task: Task) {
    if (e.button !== 0) return;
    suppressClick.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPlacing({ taskId: task.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false, day: null });
  }

  function onPlacePointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!placing || placing.pointerId !== e.pointerId) return;
    const moved = placing.moved || Math.hypot(e.clientX - placing.startX, e.clientY - placing.startY) >= DRAG_THRESHOLD;
    setPlacing({ ...placing, x: e.clientX, y: e.clientY, moved, day: moved ? dayAt(e.clientX, e.clientY) : null });
  }

  function onPlacePointerUp(e: ReactPointerEvent<HTMLButtonElement>, task: Task) {
    if (!placing || placing.pointerId !== e.pointerId) return;
    setPlacing(null);
    if (!placing.moved) return;
    suppressClick.current = true;
    const day = dayAt(e.clientX, e.clientY);
    if (day) save(task, scheduleOnDay(day));
  }

  function clickUnlessDragged(taskId: string) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    props.onSelectTask(taskId);
  }

  // A drag that ends outside the window never sends pointerup to us.
  useEffect(() => {
    if (!drag && !placing) return;
    const cancel = () => {
      setDrag(null);
      setPlacing(null);
    };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [drag, placing]);

  const placingDay = placing?.day ?? null;
  const placingTask = placing ? unscheduled.find((t) => t.id === placing.taskId) : undefined;

  // --- rendering ------------------------------------------------------------

  const trackWidth = days.length * dayWidth;
  const style = { '--timeline-name-width': `${NAME_WIDTH}px`, '--timeline-day-width': `${dayWidth}px`, '--timeline-track-width': `${trackWidth}px` } as CSSProperties;

  function barOf(task: Task) {
    let dates = task.dates;
    if (!dates) return null;
    if (drag?.taskId === task.id && drag.moved && drag.days !== 0) {
      const preview = dragTaskDates(dates, drag.edge, drag.days, timeZone);
      if (preview) dates = preview.allDay ? { ...preview, startDate: preview.startDate ?? null } : { ...preview, startAt: preview.startAt ?? null, timeZone };
    }
    const bar = timelineBar(dates, timeZone);
    if (!bar) return null;
    const from = Math.max(0, daysBetween(first, bar.start));
    const to = Math.min(days.length - 1, daysBetween(first, bar.end));
    if (to < 0 || from > days.length - 1) return null;
    const label = describeTaskDates(dates, { now, timeZone });
    const list = props.lists.find((l) => l.id === task.listId);
    return (
      <button
        type="button"
        className={`timeline-bar ${props.selectedTaskId === task.id ? 'timeline-bar-selected' : ''} ${drag?.taskId === task.id ? 'timeline-bar-dragging' : ''} ${label.overdue ? 'timeline-bar-overdue' : ''}`}
        style={{ left: from * dayWidth, width: (to - from + 1) * dayWidth, ...(list?.color ? ({ '--timeline-bar-color': list.color } as CSSProperties) : {}) }}
        aria-label={`${task.title}，${label.text}`}
        aria-describedby={hintId}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight"
        data-task-id={task.id}
        onPointerDown={(e) => onBarPointerDown(e, task)}
        onPointerMove={onBarPointerMove}
        onPointerUp={(e) => onBarPointerUp(e, task)}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => onBarKeyDown(e, task)}
        onClick={() => clickUnlessDragged(task.id)}
      >
        <span className="timeline-bar-handle timeline-bar-handle-start" data-edge="start" aria-hidden="true" />
        <span className="timeline-bar-title">{task.title}</span>
        <span className="timeline-bar-handle timeline-bar-handle-end" data-edge="end" aria-hidden="true" />
      </button>
    );
  }

  function taskRow(task: Task) {
    return (
      <li key={task.id} className={`timeline-row ${props.selectedTaskId === task.id ? 'timeline-row-selected' : ''}`}>
        <button type="button" className="timeline-name" onClick={() => props.onSelectTask(task.id)} title={task.title}>
          {task.title}
        </button>
        <div className="timeline-track">{barOf(task)}</div>
      </li>
    );
  }

  const layoutSections = layoutMenuSections(props.viewOptions, props.onChangeViewOptions, true);
  const loading = tasks === null;

  return (
    <main className="timeline-pane" aria-busy={loading} style={style}>
      <header className="list-pane-header timeline-header">
        <IconButton
          icon="sidebar"
          label={props.sidebarVisible ? '收起侧栏' : '展开侧栏'}
          aria-expanded={props.sidebarVisible}
          onClick={props.onToggleSidebar}
          className="list-pane-sidebar-toggle"
        />
        <h1 className="list-pane-title">{viewTitle(view)}</h1>
        <IconButton
          icon="sort"
          label="排序和分组"
          aria-haspopup="menu"
          aria-expanded={layoutMenu !== null}
          className="list-pane-layout"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setLayoutMenu({ x: rect.right - 200, y: rect.bottom + 4, opener: e.currentTarget });
          }}
        />
        {props.onEditList && <MenuButton label="清单更多操作" items={[{ label: '编辑清单', icon: 'edit', onSelect: props.onEditList }]} />}
      </header>

      <div className="timeline-toolbar">
        <span className="timeline-month">{monthLabel}</span>
        <button type="button" className="timeline-chip" onClick={() => scrollToDay(timelineStart(today), true)}>
          今天
        </button>
        <MenuButton
          label={`时间刻度：${SCALES[scale].label}`}
          triggerClassName="timeline-chip"
          items={(Object.keys(SCALES) as Scale[]).map((s) => ({ label: SCALES[s].label, checked: s === scale, onSelect: () => setScale(s) }))}
        >
          {SCALES[scale].label}
          <Icon name="chevronDown" size={12} />
        </MenuButton>
      </div>

      <p id={hintId} className="visually-hidden">
        拖动横条改日期，拖动两端改开始或截止日期；也可以用方向键移动一天，Shift 加方向键改截止日期，Alt 加方向键改开始日期，回车打开任务
      </p>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>

      <div className="timeline-main">
        <div className="timeline-body">
          <IconButton
            icon="chevronLeft"
            label="往前"
            size={14}
            className="timeline-nav timeline-nav-prev"
            onClick={() => scrollByDays(-step)}
          />
          <IconButton
            icon="chevronRight"
            label="往后"
            size={14}
            className="timeline-nav timeline-nav-next"
            onClick={() => scrollByDays(step)}
          />
          <div className="timeline-scroller" ref={scrollerRef} onScroll={onScroll}>
            <div className="timeline-canvas">
              <div className="timeline-head" aria-hidden="true">
                <div className="timeline-corner" />
                <div className="timeline-days">
                  {days.map((day, i) => {
                    const wd = weekday(day);
                    const d = Number(day.slice(8));
                    const label = scale === 'day' || scale === 'week' ? String(d) : d === 1 ? `${Number(day.slice(5, 7))}月` : wd === 1 ? String(d) : '';
                    const dim = day < today || wd === 0 || wd === 6;
                    return (
                      <div
                        key={day}
                        className={`timeline-day ${day === today ? 'timeline-day-today' : ''} ${dim ? 'timeline-day-dim' : ''}`}
                        style={{ left: i * dayWidth }}
                      >
                        {scale !== 'month' && <span className="timeline-day-weekday">{WEEKDAY_CHARS[wd]}</span>}
                        <span className="timeline-day-number">{label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="timeline-rows">
                {/* Keeps the name column white below the last row while the days scroll under it. */}
                <div className="timeline-name-rail" aria-hidden="true" />
                <div className="timeline-backdrop" ref={tracksRef} aria-hidden="true">
                  {days.map((day, i) =>
                    weekday(day) === 0 || weekday(day) === 6 ? (
                      <div key={day} className="timeline-weekend" style={{ left: i * dayWidth }} />
                    ) : null,
                  )}
                  {placingDay && <div className="timeline-drop-day" style={{ left: daysBetween(first, placingDay) * dayWidth }} />}
                  <div className="timeline-today" style={{ left: (daysBetween(first, today) + 0.5) * dayWidth }} />
                </div>

                {loading ? (
                  <p className="timeline-status" role="status">
                    正在加载…
                  </p>
                ) : (
                  <ul className="timeline-list" aria-label="任务">
                    {sections.map((section) =>
                      section.title === '' ? (
                        section.tasks.map(taskRow)
                      ) : (
                        <li key={section.key} className="timeline-group">
                          <div className="timeline-row timeline-group-row">
                            <button
                              type="button"
                              className="timeline-name timeline-group-toggle"
                              aria-expanded={!collapsed.has(section.key)}
                              onClick={() =>
                                setCollapsed((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(section.key)) next.delete(section.key);
                                  else next.add(section.key);
                                  return next;
                                })
                              }
                            >
                              <Icon name={collapsed.has(section.key) ? 'chevronRight' : 'chevronDown'} size={12} />
                              <span>{section.title}</span>
                            </button>
                            <div className="timeline-track" />
                          </div>
                          {!collapsed.has(section.key) && (
                            <ul className="timeline-list" aria-label={section.title}>
                              {section.tasks.map(taskRow)}
                            </ul>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>

        {unscheduled.length > 0 && (
          <section className="timeline-unscheduled" aria-labelledby="timeline-unscheduled-heading">
            <h2 id="timeline-unscheduled-heading" className="timeline-unscheduled-heading">
              <button
                type="button"
                className="timeline-unscheduled-toggle"
                aria-expanded={unscheduledOpen}
                aria-controls="timeline-unscheduled-list"
                onClick={() => setUnscheduledOpen((v) => !v)}
              >
                <Icon name={unscheduledOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                <span>待安排</span>
                <span className="task-section-count">{unscheduled.length}</span>
              </button>
            </h2>
            {unscheduledOpen && (
              <>
                <p id="timeline-unscheduled-hint" className="timeline-unscheduled-hint">
                  拖到时间线上安排日期，或打开任务设置日期
                </p>
                <ul id="timeline-unscheduled-list" className="timeline-unscheduled-list">
                  {unscheduled.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={`timeline-unscheduled-item ${placing?.taskId === task.id ? 'timeline-unscheduled-item-dragging' : ''} ${props.selectedTaskId === task.id ? 'timeline-unscheduled-item-selected' : ''}`}
                        aria-describedby="timeline-unscheduled-hint"
                        onPointerDown={(e) => onPlacePointerDown(e, task)}
                        onPointerMove={onPlacePointerMove}
                        onPointerUp={(e) => onPlacePointerUp(e, task)}
                        onPointerCancel={() => setPlacing(null)}
                        onClick={() => clickUnlessDragged(task.id)}
                      >
                        {task.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>

      {placing?.moved && placingTask && (
        <div className="timeline-ghost" style={{ left: placing.x, top: placing.y }} aria-hidden="true">
          {placingTask.title}
        </div>
      )}

      {layoutMenu && (
        <ContextMenu
          label="排序和分组"
          x={layoutMenu.x}
          y={layoutMenu.y}
          returnFocus={layoutMenu.opener}
          sections={layoutSections}
          onClose={() => setLayoutMenu(null)}
        />
      )}
    </main>
  );
}
