import {
  buildTaskTree,
  describeTaskDates,
  planIndent,
  PRIORITY_LABELS,
  type Tag,
  type Task,
  type TaskList,
  type TaskNode,
  type UpdateTaskRequest,
} from '@dida/shared';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { ContextMenu, IconButton, MenuButton, TaskCheckbox } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { chipStyle, tagsOf, taskContextSections } from './taskMeta.js';

/** What the middle column shows: one 清单, or one 标签 across 清单. */
export type ListPaneView = { kind: 'list'; list: TaskList } | { kind: 'tag'; tag: Tag; inbox: TaskList | null };

interface TaskListPaneProps {
  view: ListPaneView | null;
  tasks: Task[] | null;
  /** Every 标签 in display order. */
  tags: Tag[];
  /** Every 清单 (the 标签 view names each task's 清单). */
  lists: TaskList[];
  selectedTaskId: string | null;
  sidebarVisible: boolean;
  timeZone: string;
  now: Date;
  onToggleSidebar: () => void;
  onAddTask: (title: string) => Promise<boolean>;
  onSelectTask: (taskId: string) => void;
  onToggleTask: (task: Task) => void;
  /**
   * Tab / Shift+Tab: indent / outdent `task`. Returns false when nothing can
   * happen, so the key keeps its default meaning (move focus).
   */
  onIndent: (task: Task, outdent: boolean) => boolean;
  onChangeTask: (task: Task, patch: UpdateTaskRequest) => void;
  onEditList: (() => void) | null;
}

type MenuState = { task: Task; x: number; y: number; opener: HTMLElement | null } | null;

const isOpen = (t: Task) => t.status !== 'completed';

/**
 * The middle column: list title, quick add, the open 任务 tree, then the 已完成
 * section (spec 用户故事 18、20、22、23–27、35、36、40、65). 子任务 are nested
 * lists; Tab / Shift+Tab on the selected task indents / outdents it; right-click
 * (or the ContextMenu key / Shift+F10) opens the task menu.
 */
export function TaskListPane(props: TaskListPaneProps) {
  const { view, tasks } = props;
  const [showCompleted, setShowCompleted] = useState(true);
  const [menu, setMenu] = useState<MenuState>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const focusAfterMove = useRef<string | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const open = tasks?.filter(isOpen) ?? [];
  const completed = tasks?.filter((t) => !isOpen(t)) ?? [];
  const title = view ? (view.kind === 'list' ? view.list.name : view.tag.name) : '';
  // Tasks added in a 标签 view go to the 收件箱 with that 标签.
  const addTarget = view ? (view.kind === 'list' ? view.list.name : (view.inbox?.name ?? '')) : '';
  const listName = (task: Task) => (view?.kind === 'tag' ? props.lists.find((l) => l.id === task.listId)?.name : undefined);

  // A moved row is re-mounted under its new parent: give it focus back.
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    const button = paneRef.current?.querySelector<HTMLButtonElement>(`[data-task-id="${id}"]`);
    if (button) {
      focusAfterMove.current = null;
      button.focus();
    }
  }, [tasks]);

  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function indent(task: Task, outdent: boolean): boolean {
    // Tab puts the task under the open sibling above it: expand that one so the task stays visible.
    const above = !outdent && tasks ? planIndent(tasks, task.id, isOpen) : null;
    const handled = props.onIndent(task, outdent);
    if (!handled) return false;
    focusAfterMove.current = task.id;
    if (above?.kind === 'move' && above.parentId) {
      const parentId = above.parentId;
      setCollapsed((prev) => (prev.has(parentId) ? new Set([...prev].filter((x) => x !== parentId)) : prev));
    }
    return true;
  }

  const rowProps = {
    selectedTaskId: props.selectedTaskId,
    collapsed,
    onToggleCollapsed: toggleCollapsed,
    onSelectTask: props.onSelectTask,
    onToggleTask: props.onToggleTask,
    onIndent: indent,
    indentable: view?.kind === 'list',
    timeZone: props.timeZone,
    now: props.now,
    tags: props.tags,
    listName,
    onOpenMenu: (task: Task, x: number, y: number, opener: HTMLElement | null) => setMenu({ task, x, y, opener }),
  };

  return (
    <main className="list-pane" aria-busy={tasks === null} ref={paneRef}>
      <header className="list-pane-header">
        <IconButton
          icon="sidebar"
          label={props.sidebarVisible ? '收起侧栏' : '展开侧栏'}
          aria-expanded={props.sidebarVisible}
          onClick={props.onToggleSidebar}
          className="list-pane-sidebar-toggle"
        />
        <h1 className="list-pane-title">{title}</h1>
        {props.onEditList && (
          <MenuButton label="清单更多操作" items={[{ label: '编辑清单', icon: 'edit', onSelect: props.onEditList }]} />
        )}
      </header>

      {view && (
        <QuickAdd key={view.kind === 'list' ? view.list.id : view.tag.id} target={addTarget} onAdd={props.onAddTask} />
      )}

      {tasks === null ? (
        <p className="list-pane-status" role="status">
          正在加载…
        </p>
      ) : (
        <>
          {open.length > 0 ? (
            <ul className="task-rows" aria-label="任务">
              <TaskRows nodes={buildTaskTree(open)} {...rowProps} />
            </ul>
          ) : (
            completed.length === 0 && (
              <div className="list-pane-empty">
                <p className="list-pane-empty-title">没有任务</p>
                <p>在上方输入任务标题，按回车添加</p>
              </div>
            )
          )}
          {completed.length > 0 && (
            <section className="task-section" aria-labelledby="completed-heading">
              <h2 id="completed-heading" className="task-section-heading">
                <button
                  type="button"
                  className="task-section-toggle"
                  aria-expanded={showCompleted}
                  aria-controls="completed-tasks"
                  onClick={() => setShowCompleted((v) => !v)}
                >
                  <Icon name={showCompleted ? 'chevronDown' : 'chevronRight'} size={12} />
                  <span>已完成</span>
                  <span className="task-section-count">{completed.length}</span>
                </button>
              </h2>
              {showCompleted && (
                <ul id="completed-tasks" className="task-rows" aria-label="已完成的任务">
                  {/* Completed subtrees keep their shape; a completed 子任务 of an open task shows as a root. */}
                  <TaskRows nodes={buildTaskTree(completed)} {...rowProps} />
                </ul>
              )}
            </section>
          )}
        </>
      )}

      {menu && (
        <ContextMenu
          label={`任务操作：${menu.task.title}`}
          x={menu.x}
          y={menu.y}
          returnFocus={menu.opener}
          // Read the task fresh: it may have changed since the menu opened.
          sections={taskContextSections(tasks?.find((t) => t.id === menu.task.id) ?? menu.task, props.tags, (patch) =>
            props.onChangeTask(menu.task, patch),
          )}
          onClose={() => setMenu(null)}
        />
      )}
    </main>
  );
}

function QuickAdd({ target, onAdd }: { target: string; onAdd: (title: string) => Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    // Keep the text if saving failed so nothing typed is lost.
    if (await onAdd(trimmed)) setTitle('');
    setBusy(false);
  }

  return (
    <form className="quick-add" onSubmit={submit} aria-label="添加任务">
      <span className="quick-add-icon" aria-hidden="true">
        <Icon name="plus" size={16} />
      </span>
      <input
        className="quick-add-input"
        aria-label="添加任务"
        placeholder={`添加任务至"${target}"，回车即可保存`}
        value={title}
        maxLength={512}
        onChange={(e) => setTitle(e.target.value)}
        enterKeyHint="done"
      />
    </form>
  );
}

interface TaskRowsProps {
  nodes: TaskNode<Task>[];
  selectedTaskId: string | null;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (id: string) => void;
  onSelectTask: (taskId: string) => void;
  onToggleTask: (task: Task) => void;
  onIndent: (task: Task, outdent: boolean) => boolean;
  /** False in a 标签 view: Tab / Shift+Tab don't indent there. */
  indentable: boolean;
  timeZone: string;
  now: Date;
  tags: Tag[];
  /** The task's 清单 name, shown in a 标签 view. */
  listName: (task: Task) => string | undefined;
  onOpenMenu: (task: Task, x: number, y: number, opener: HTMLElement | null) => void;
}

function TaskRows({ nodes, ...rest }: TaskRowsProps) {
  return nodes.map((node) => <TaskRow key={node.task.id} node={node} {...rest} />);
}

function TaskRow({ node, ...rest }: Omit<TaskRowsProps, 'nodes'> & { node: TaskNode<Task> }) {
  const { task, depth, children } = node;
  const {
    selectedTaskId,
    collapsed,
    onToggleCollapsed,
    onSelectTask,
    onToggleTask,
    onIndent,
    indentable,
    timeZone,
    now,
    tags,
    listName,
    onOpenMenu,
  } = rest;
  const titleRef = useRef<HTMLButtonElement>(null);
  const taskTags = tagsOf(task, tags);
  const list = listName(task);
  const selected = task.id === selectedTaskId;
  const done = task.status === 'completed';
  const date = task.dates ? describeTaskDates(task.dates, { now, timeZone }) : null;
  // Completed tasks are never shown as overdue.
  const overdue = date?.overdue === true && !done;
  const isCollapsed = collapsed.has(task.id);
  const childListId = `subtasks-${task.id}`;

  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    onOpenMenu(task, event.clientX, event.clientY, titleRef.current);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    // Keyboard access to the right-click menu: the ContextMenu key or Shift+F10.
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      onOpenMenu(task, rect.left + 24, rect.bottom, e.currentTarget);
      return;
    }
    // Only the selected task takes Tab, so Tab still moves focus everywhere else.
    if (e.key !== 'Tab' || !selected || e.altKey || e.ctrlKey || e.metaKey) return;
    if (onIndent(task, e.shiftKey)) e.preventDefault();
  }

  return (
    <li className="task-item">
      <div
        className={`task-row ${selected ? 'task-row-selected' : ''} ${done ? 'task-row-done' : ''}`}
        style={{ '--task-depth': depth - 1 } as CSSProperties}
        onContextMenu={onContextMenu}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="task-row-expand"
            aria-label={`${isCollapsed ? '展开' : '收起'}「${task.title}」的子任务`}
            aria-expanded={!isCollapsed}
            aria-controls={childListId}
            onClick={() => onToggleCollapsed(task.id)}
          >
            <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
          </button>
        ) : (
          <span className="task-row-expand" aria-hidden="true" />
        )}
        <TaskCheckbox checked={done} label={task.title} priority={task.priority} onChange={() => onToggleTask(task)} />
        <button
          ref={titleRef}
          type="button"
          className="task-row-title"
          data-task-id={task.id}
          aria-current={selected ? 'true' : undefined}
          aria-description={task.priority !== 'none' ? PRIORITY_LABELS[task.priority] : undefined}
          aria-keyshortcuts={selected && !done && indentable ? 'Tab Shift+Tab' : undefined}
          onClick={() => onSelectTask(task.id)}
          onKeyDown={onKeyDown}
        >
          {task.title}
        </button>
        {taskTags.length > 0 && (
          <ul className="task-row-tags" aria-label="标签">
            {taskTags.map((tag) => (
              <li key={tag.id} className="tag-chip" style={chipStyle(tag)}>
                {tag.name}
              </li>
            ))}
          </ul>
        )}
        {list && <span className="task-row-list">{list}</span>}
        {task.kind === 'checklist' ? (
          <span className="task-row-meta" title="检查清单">
            <Icon name="checklist" size={14} />
            <span className="visually-hidden">检查清单</span>
          </span>
        ) : (
          task.description.trim() && (
            <span className="task-row-meta" title="有描述">
              <Icon name="list" size={14} />
              <span className="visually-hidden">有描述</span>
            </span>
          )
        )}
        {date && (
          <span className={`task-row-date ${overdue ? 'date-overdue' : ''}`}>
            {date.text}
            {overdue && <span className="visually-hidden">，已过期</span>}
          </span>
        )}
      </div>
      {children.length > 0 && !isCollapsed && (
        <ul id={childListId} className="task-rows" aria-label={`「${task.title}」的子任务`}>
          <TaskRows nodes={children} {...rest} />
        </ul>
      )}
    </li>
  );
}
