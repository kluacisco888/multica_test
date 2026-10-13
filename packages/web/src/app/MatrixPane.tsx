import {
  arrangeTasks,
  describeRepeatFrequency,
  describeTaskDates,
  dueDayOf,
  PRIORITY_LABELS,
  quadrantMatcher,
  type Quadrant,
  type Tag,
  type Task,
  type TaskList,
  type TaskSection,
  type UpdateTaskRequest,
} from '@dida/shared';
import { useState, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ContextMenu, IconButton, MenuButton, TaskCheckbox, type ContextMenuSection } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { taskContextSections } from './taskMeta.js';

interface MatrixPaneProps {
  quadrants: readonly Quadrant[];
  /** The 四象限 task set (`GET /api/tasks?view=matrix`); null while loading. */
  tasks: Task[] | null;
  lists: TaskList[];
  tags: Tag[];
  selectedTaskId: string | null;
  timeZone: string;
  now: Date;
  isMobile: boolean;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onSelectTask: (taskId: string) => void;
  onToggleTask: (task: Task) => void;
  onChangeTask: (task: Task, patch: UpdateTaskRequest) => void;
  onDeleteTask: (task: Task) => void;
  /** A task dropped on (or moved from the menu to) quadrant `index`. */
  onMoveTask: (task: Task, index: number) => void;
  /** Quick add in quadrant `index`. */
  onAddTask: (index: number, title: string) => Promise<boolean>;
  onEditQuadrant: (index: number) => void;
  onResetQuadrant: (index: number) => void;
}

type MenuState = { task: Task; x: number; y: number; opener: HTMLElement | null } | null;

const NUMERALS = ['一', '二', '三', '四'] as const;
const ARRANGE = { sortBy: 'date', groupBy: 'date' } as const;

/**
 * 四象限 (spec 用户故事 72、73), laid out like the reference: a 2×2 grid of
 * white cards on the tinted page, each with its name, a + and ··· shown on
 * hover, and its tasks grouped by date (已过期, days, 更远, 无日期, 已完成).
 * Rows are dragged to another quadrant with the mouse; the row menu's
 * 移动到象限 does the same from the keyboard or on touch.
 */
export function MatrixPane(props: MatrixPaneProps) {
  const { quadrants, tasks } = props;
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [addingIn, setAddingIn] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const clock = { now: props.now, timeZone: props.timeZone };
  const matcher = quadrantMatcher(quadrants, props.tags, clock);
  const byQuadrant: Task[][] = quadrants.map(() => []);
  for (const task of tasks ?? []) byQuadrant[matcher.indexOf(task)]?.push(task);
  const ctx = { ...clock, lists: props.lists, tags: props.tags };
  const listName = (task: Task) => props.lists.find((l) => l.id === task.listId)?.name;

  function onDragOver(event: DragEvent<HTMLElement>, index: number) {
    if (!dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropIndex !== index) setDropIndex(index);
  }

  function onDrop(event: DragEvent<HTMLElement>, index: number) {
    if (!dragged) return;
    event.preventDefault();
    const task = tasks?.find((t) => t.id === dragged);
    setDragged(null);
    setDropIndex(null);
    if (task && matcher.indexOf(task) !== index) props.onMoveTask(task, index);
  }

  function openMenu(task: Task, x: number, y: number, opener: HTMLElement | null) {
    setMenu({ task, x, y, opener });
  }

  function moveSection(task: Task): ContextMenuSection {
    const current = matcher.indexOf(task);
    return {
      label: '移动到象限',
      items: quadrants.map((q, i) => ({
        label: q.name,
        checked: i === current,
        onSelect: () => {
          if (i !== current) props.onMoveTask(task, i);
        },
      })),
    };
  }

  return (
    <main className="matrix-pane" aria-busy={tasks === null}>
      <header className="matrix-header">
        {props.isMobile && (
          <IconButton
            icon="sidebar"
            label={props.sidebarVisible ? '收起侧栏' : '展开侧栏'}
            aria-expanded={props.sidebarVisible}
            onClick={props.onToggleSidebar}
            className="list-pane-sidebar-toggle"
          />
        )}
        <h1 className="matrix-title">四象限</h1>
      </header>
      <div className="matrix-grid">
        {quadrants.map((quadrant, index) => {
          const headingId = `matrix-q${index + 1}`;
          const sections = arrangeTasks(byQuadrant[index] ?? [], ARRANGE, ctx);
          return (
            <section
              key={index}
              className={`matrix-quadrant matrix-quadrant-${index + 1} ${dropIndex === index ? 'matrix-quadrant-drop' : ''}`}
              aria-labelledby={headingId}
              onDragOver={(e) => onDragOver(e, index)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex((d) => (d === index ? null : d));
              }}
              onDrop={(e) => onDrop(e, index)}
            >
              <header className="matrix-quadrant-header">
                <span className="matrix-quadrant-badge" aria-hidden="true">
                  {NUMERALS[index]}
                </span>
                <h2 id={headingId} className="matrix-quadrant-name">
                  {quadrant.name}
                </h2>
                <IconButton
                  icon="plus"
                  size={16}
                  label={`在「${quadrant.name}」中添加任务`}
                  className="matrix-quadrant-action"
                  // The N shortcut (AppShell) presses the first quadrant's +.
                  data-shortcut={index === 0 ? 'add-task' : undefined}
                  onClick={() => setAddingIn(index)}
                />
                <MenuButton
                  label={`象限「${quadrant.name}」更多操作`}
                  className="matrix-quadrant-action"
                  items={[
                    { label: '编辑象限', icon: 'edit', onSelect: () => props.onEditQuadrant(index) },
                    { label: '恢复默认', icon: 'repeat', onSelect: () => props.onResetQuadrant(index) },
                  ]}
                />
              </header>
              {addingIn === index && (
                <QuadrantAddForm name={quadrant.name} onAdd={(title) => props.onAddTask(index, title)} onClose={() => setAddingIn(null)} />
              )}
              <div className="matrix-quadrant-body">
                {tasks === null ? (
                  <p className="matrix-status" role="status">
                    正在加载…
                  </p>
                ) : sections.length === 0 ? (
                  <p className="matrix-empty">没有任务</p>
                ) : (
                  sections.map((section) => {
                    const key = `${index}/${section.key}`;
                    return (
                      <MatrixSection
                        key={section.key}
                        id={`${headingId}-${section.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                        quadrantName={quadrant.name}
                        section={section}
                        collapsed={collapsed.has(key)}
                        onToggle={() =>
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      >
                        {section.tasks.map((task) => (
                          <MatrixRow
                            key={task.id}
                            task={task}
                            listName={listName(task)}
                            selected={task.id === props.selectedTaskId}
                            timeZone={props.timeZone}
                            now={props.now}
                            onSelect={() => props.onSelectTask(task.id)}
                            onToggle={() => props.onToggleTask(task)}
                            onOpenMenu={(x, y, opener) => openMenu(task, x, y, opener)}
                            onDragStart={() => setDragged(task.id)}
                            onDragEnd={() => {
                              setDragged(null);
                              setDropIndex(null);
                            }}
                          />
                        ))}
                      </MatrixSection>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
      {menu && (
        <ContextMenu
          label={`任务操作：${menu.task.title}`}
          x={menu.x}
          y={menu.y}
          returnFocus={menu.opener}
          // Read the task fresh: it may have changed since the menu opened.
          sections={(() => {
            const task = tasks?.find((t) => t.id === menu.task.id) ?? menu.task;
            return [
              ...taskContextSections(
                task,
                props.tags,
                (patch) => props.onChangeTask(task, patch),
                () => props.onDeleteTask(task),
              ),
              moveSection(task),
            ];
          })()}
          onClose={() => setMenu(null)}
        />
      )}
    </main>
  );
}

function MatrixSection({
  id,
  quadrantName,
  section,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  quadrantName: string;
  section: TaskSection;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="matrix-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="matrix-section-heading">
        <button type="button" className="matrix-section-toggle" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
          <span>{section.title}</span>
          <span className="matrix-section-count">{section.tasks.length}</span>
        </button>
      </h3>
      {!collapsed && (
        <ul id={id} className="matrix-rows" aria-label={`${quadrantName} · ${section.title}`}>
          {children}
        </ul>
      )}
    </section>
  );
}

function MatrixRow({
  task,
  listName,
  selected,
  timeZone,
  now,
  onSelect,
  onToggle,
  onOpenMenu,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  listName: string | undefined;
  selected: boolean;
  timeZone: string;
  now: Date;
  onSelect: () => void;
  onToggle: () => void;
  onOpenMenu: (x: number, y: number, opener: HTMLElement | null) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const done = task.status !== 'open';
  const date = task.dates ? describeTaskDates(task.dates, { now, timeZone }) : null;
  const overdue = date?.overdue === true && !done;
  const repeatText = task.dates && task.repeat ? describeRepeatFrequency(task.repeat, dueDayOf(task.dates)) : null;

  function onContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    onOpenMenu(event.clientX, event.clientY, event.currentTarget.querySelector<HTMLElement>('.matrix-row-title'));
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      onOpenMenu(rect.left + 24, rect.bottom, e.currentTarget);
    }
  }

  return (
    <li
      className={`matrix-row ${selected ? 'matrix-row-selected' : ''} ${done ? 'matrix-row-done' : ''}`}
      draggable={!done}
      data-task-row={task.id}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
    >
      <TaskCheckbox checked={done} abandoned={task.status === 'abandoned'} label={task.title} priority={task.priority} onChange={onToggle} />
      <span className="matrix-row-line">
        <button
          type="button"
          className="matrix-row-title"
          data-task-id={task.id}
          aria-current={selected ? 'true' : undefined}
          aria-description={task.priority !== 'none' ? PRIORITY_LABELS[task.priority] : undefined}
          onClick={onSelect}
          onKeyDown={onKeyDown}
        >
          {task.title}
        </button>
        <span className="matrix-row-meta">
          {listName && <span className="matrix-row-list">{listName}</span>}
          {task.kind === 'checklist' ? (
            <span className="matrix-row-icon" title="检查清单">
              <Icon name="checklist" size={13} />
              <span className="visually-hidden">检查清单</span>
            </span>
          ) : (
            task.description.trim() && (
              <span className="matrix-row-icon" title="有描述">
                <Icon name="list" size={13} />
                <span className="visually-hidden">有描述</span>
              </span>
            )
          )}
          {repeatText && (
            <span className="matrix-row-icon" title={repeatText}>
              <Icon name="repeat" size={13} />
              <span className="visually-hidden">{`重复：${repeatText}`}</span>
            </span>
          )}
          {date && (
            <span className={`matrix-row-date ${overdue ? 'date-overdue' : ''} ${done ? 'matrix-row-date-done' : ''}`}>
              {date.text}
              {overdue && <span className="visually-hidden">，已过期</span>}
            </span>
          )}
        </span>
      </span>
    </li>
  );
}

function QuadrantAddForm({ name, onAdd, onClose }: { name: string; onAdd: (title: string) => Promise<boolean>; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    if (await onAdd(trimmed)) setTitle('');
    setBusy(false);
  }

  return (
    <form className="matrix-add" onSubmit={(e) => void submit(e)}>
      <input
        className="matrix-add-input"
        aria-label={`添加任务到「${name}」`}
        placeholder="添加任务，回车即可保存"
        value={title}
        maxLength={512}
        autoFocus
        enterKeyHint="done"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        onBlur={() => {
          if (!title.trim()) onClose();
        }}
      />
    </form>
  );
}
