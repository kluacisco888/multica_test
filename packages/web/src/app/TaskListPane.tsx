import {
  arrangeTasks,
  buildTaskTree,
  describeRepeatFrequency,
  describeTaskDates,
  dueDayOf,
  GROUP_LABELS,
  GROUP_OPTIONS,
  planIndent,
  PRIORITY_LABELS,
  SORT_LABELS,
  SORT_OPTIONS,
  type SearchMatchField,
  type Tag,
  type Task,
  type TaskList,
  type TaskNode,
  type TaskSection,
  type UpdateTaskRequest,
  type ViewOptions,
  VIEW_LAYOUT_LABELS,
  VIEW_LAYOUTS,
} from '@dida/shared';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ContextMenu, IconButton, MenuButton, TaskCheckbox, type ContextMenuSection } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { chipStyle, tagsOf, taskContextSections } from './taskMeta.js';
import { scopeKey, viewTitle, type ListPaneView } from './views.js';

export type { ListPaneView } from './views.js';

interface TaskListPaneProps {
  view: ListPaneView | null;
  tasks: Task[] | null;
  /** Every 标签 in display order. */
  tags: Tag[];
  /** Every 清单 in sidebar order (cross-清单 views name each task's 清单). */
  lists: TaskList[];
  selectedTaskId: string | null;
  sidebarVisible: boolean;
  timeZone: string;
  now: Date;
  /** 排序 / 分组 of this view (spec 用户故事 64). */
  viewOptions: ViewOptions;
  onChangeViewOptions: (options: ViewOptions) => void;
  /** Where quick add puts tasks (shown in the placeholder); null: no quick add. */
  addTarget: string | null;
  /** 搜索: where each result matched. */
  searchMatches?: Record<string, SearchMatchField[]>;
  onSearch?: (query: string) => void;
  onToggleSidebar: () => void;
  onAddTask: (title: string) => Promise<boolean>;
  onSelectTask: (taskId: string) => void;
  onToggleTask: (task: Task) => void;
  /**
   * Tab / Shift+Tab: indent / outdent `task`. Returns false when nothing can
   * happen, so the key keeps its default meaning (move focus).
   */
  onIndent: (task: Task, outdent: boolean) => boolean;
  /** Tab indents only in a 清单 in its own order (no other sort or grouping). */
  indentable: boolean;
  onChangeTask: (task: Task, patch: UpdateTaskRequest) => void;
  /** 删除: into the 回收站. */
  onDeleteTask: (task: Task) => void;
  onEditList: (() => void) | null;
  /** 归档 / 取消归档 the 清单 on screen; null for the 收件箱 and 标签 views. */
  onArchiveList: ((archived: boolean) => void) | null;
}

type MenuState = { task: Task; x: number; y: number; opener: HTMLElement | null } | null;
type LayoutMenuState = { x: number; y: number; opener: HTMLElement | null } | null;

const isOpen = (t: Task) => t.status === 'open';

const MATCH_LABELS: Record<SearchMatchField, string> = { title: '标题', description: '描述', checklist: '检查项', comment: '评论' };

const EMPTY_HINTS: Record<ListPaneView['kind'], string> = {
  list: '在上方输入任务标题，按回车添加',
  tag: '在上方输入任务标题，按回车添加',
  smart: '这里会显示符合条件的任务',
  filter: '没有符合过滤条件的任务',
  search: '',
  calendar: '',
};

/**
 * The middle column: title, quick add, then the tasks laid out by the view's
 * 排序 / 分组 (spec 用户故事 16、18、20、22、23–29、35、36、40、59–65). In a
 * 清单's own order 子任务 are nested lists and Tab / Shift+Tab on the selected
 * task indents / outdents it; other layouts show flat rows in sections (已过期,
 * each day, each 清单 …), the 已完成 section (completed and 放弃 tasks) last.
 * Right-click (or the ContextMenu key / Shift+F10) opens the task menu.
 */
export function TaskListPane(props: TaskListPaneProps) {
  const { view, tasks, viewOptions } = props;
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<MenuState>(null);
  const [layoutMenu, setLayoutMenu] = useState<LayoutMenuState>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const focusAfterMove = useRef<string | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const title = view ? viewTitle(view) : '';
  const archived = view?.kind === 'list' && view.list.archivedAt !== null;
  const crossList = view !== null && view.kind !== 'list';
  const listName = (task: Task) => (crossList ? props.lists.find((l) => l.id === task.listId)?.name : undefined);
  const sections: TaskSection[] =
    tasks && view
      ? arrangeTasks(tasks, viewOptions, {
          now: props.now,
          timeZone: props.timeZone,
          lists: props.lists,
          tags: props.tags,
          completedView: view.kind === 'smart' && view.id === 'completed',
        })
      : [];
  // The custom order keeps 子任务 nested; other orders show flat rows.
  const nested = viewOptions.sortBy === 'custom';
  const nodesOf = (items: Task[]): TaskNode<Task>[] =>
    nested ? buildTaskTree(items) : items.map((task) => ({ task, depth: 1, children: [] }));

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

  function toggleIn(setter: typeof setCollapsed, id: string) {
    setter((prev) => {
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
    onToggleCollapsed: (id: string) => toggleIn(setCollapsed, id),
    onSelectTask: props.onSelectTask,
    onToggleTask: props.onToggleTask,
    onIndent: indent,
    indentable: props.indentable,
    timeZone: props.timeZone,
    now: props.now,
    tags: props.tags,
    listName,
    matches: props.searchMatches,
    onOpenMenu: (task: Task, x: number, y: number, opener: HTMLElement | null) => setMenu({ task, x, y, opener }),
  };

  const layoutSections = layoutMenuSections(viewOptions, props.onChangeViewOptions, view?.kind !== 'search');

  const isSearch = view?.kind === 'search';
  const emptyQuery = view?.kind === 'search' && view.query === '';

  return (
    <main className="list-pane" aria-busy={tasks === null && !emptyQuery} ref={paneRef}>
      <header className="list-pane-header">
        <IconButton
          icon="sidebar"
          label={props.sidebarVisible ? '收起侧栏' : '展开侧栏'}
          aria-expanded={props.sidebarVisible}
          onClick={props.onToggleSidebar}
          className="list-pane-sidebar-toggle"
        />
        <h1 className={`list-pane-title ${isSearch ? 'visually-hidden' : ''}`}>{title}</h1>
        {view?.kind === 'search' && props.onSearch && (
          <SearchBox key="search" initial={view.query} onSearch={props.onSearch} />
        )}
        {view && (
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
        )}
        {props.onEditList && (
          <MenuButton
            label="清单更多操作"
            items={[
              { label: '编辑清单', icon: 'edit', onSelect: props.onEditList },
              ...(props.onArchiveList
                ? [
                    archived
                      ? { label: '取消归档', icon: 'archive' as const, onSelect: () => props.onArchiveList?.(false) }
                      : { label: '归档', icon: 'archive' as const, onSelect: () => props.onArchiveList?.(true) },
                  ]
                : []),
            ]}
          />
        )}
      </header>

      {archived && (
        <div className="list-pane-banner" role="status">
          <Icon name="archive" size={16} />
          <span>清单已归档，其中的任务不会出现在智能清单里</span>
          {props.onArchiveList && (
            <button type="button" className="list-pane-banner-action" onClick={() => props.onArchiveList?.(false)}>
              取消归档
            </button>
          )}
        </div>
      )}

      {view && props.addTarget !== null && <QuickAdd key={scopeKey(view)} target={props.addTarget} onAdd={props.onAddTask} />}

      {emptyQuery ? (
        <div className="list-pane-empty">
          <p>输入关键词，搜索任务的标题、描述、检查项和评论</p>
        </div>
      ) : tasks === null ? (
        <p className="list-pane-status" role="status">
          正在加载…
        </p>
      ) : sections.length === 0 ? (
        <div className="list-pane-empty" role={isSearch ? 'status' : undefined}>
          <p className="list-pane-empty-title">{isSearch ? '没有找到相关任务' : '没有任务'}</p>
          {view && EMPTY_HINTS[view.kind] && <p>{EMPTY_HINTS[view.kind]}</p>}
        </div>
      ) : (
        sections.map((section) =>
          section.title === '' ? (
            <ul key={section.key} className="task-rows" aria-label="任务">
              <TaskRows nodes={nodesOf(section.tasks)} {...rowProps} />
            </ul>
          ) : (
            <TaskSectionBlock
              key={section.key}
              section={section}
              collapsed={collapsedSections.has(section.key)}
              onToggle={() => toggleIn(setCollapsedSections, section.key)}
            >
              {/* Completed subtrees keep their shape; a completed 子任务 of an open task shows as a root. */}
              <TaskRows nodes={nodesOf(section.tasks)} {...rowProps} />
            </TaskSectionBlock>
          ),
        )
      )}

      {menu && (
        <ContextMenu
          label={`任务操作：${menu.task.title}`}
          x={menu.x}
          y={menu.y}
          returnFocus={menu.opener}
          // Read the task fresh: it may have changed since the menu opened.
          sections={taskContextSections(
            tasks?.find((t) => t.id === menu.task.id) ?? menu.task,
            props.tags,
            (patch) => props.onChangeTask(menu.task, patch),
            () => props.onDeleteTask(menu.task),
          )}
          onClose={() => setMenu(null)}
        />
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

/**
 * The 排序和分组 menu (shared with the 时间线): 视图 (列表 / 时间线, not for
 * 搜索), 排序 and 分组 of the view on screen.
 */
export function layoutMenuSections(
  viewOptions: ViewOptions,
  onChange: (options: ViewOptions) => void,
  canSwitchLayout: boolean,
): ContextMenuSection[] {
  const layout = viewOptions.layout ?? 'list';
  return [
    ...(canSwitchLayout
      ? [
          {
            label: '视图',
            items: VIEW_LAYOUTS.map((next) => ({
              label: VIEW_LAYOUT_LABELS[next],
              checked: layout === next,
              onSelect: () => onChange({ ...viewOptions, layout: next }),
            })),
          },
        ]
      : []),
    {
      label: '排序',
      items: SORT_OPTIONS.map((sortBy) => ({
        label: SORT_LABELS[sortBy],
        checked: viewOptions.sortBy === sortBy,
        onSelect: () => onChange({ ...viewOptions, sortBy }),
      })),
    },
    {
      label: '分组',
      items: GROUP_OPTIONS.map((groupBy) => ({
        label: GROUP_LABELS[groupBy],
        checked: viewOptions.groupBy === groupBy,
        onSelect: () => onChange({ ...viewOptions, groupBy }),
      })),
    },
  ];
}

/** A titled, collapsible group of rows: 已过期, a day, a 清单, 已完成 … */
function TaskSectionBlock({
  section,
  collapsed,
  onToggle,
  children,
}: {
  section: TaskSection;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = `section-${section.key.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  return (
    <section className="task-section" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="task-section-heading">
        <button type="button" className="task-section-toggle" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
          <span>{section.title}</span>
          <span className="task-section-count">{section.tasks.length}</span>
        </button>
      </h2>
      {!collapsed && (
        <ul id={id} className="task-rows" aria-label={section.completed ? '已完成的任务' : `${section.title}的任务`}>
          {children}
        </ul>
      )}
    </section>
  );
}

/** 搜索 box: searches as you type (debounced) and on Enter. */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (query: string) => void }) {
  const [value, setValue] = useState(initial);
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  });
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed === initial) return;
    const timer = window.setTimeout(() => onSearchRef.current(trimmed), 300);
    return () => window.clearTimeout(timer);
  }, [value, initial]);

  return (
    <form
      className="search-box"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(value.trim());
      }}
    >
      <span className="search-box-icon" aria-hidden="true">
        <Icon name="search" size={16} />
      </span>
      <input
        type="search"
        className="search-box-input"
        aria-label="搜索任务"
        placeholder="搜索标题、描述、检查项和评论"
        value={value}
        maxLength={100}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
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
  /** False outside a 清单's own order: Tab / Shift+Tab don't indent there. */
  indentable: boolean;
  timeZone: string;
  now: Date;
  tags: Tag[];
  /** The task's 清单 name, shown in cross-清单 views. */
  listName: (task: Task) => string | undefined;
  /** 搜索: where each task matched. */
  matches?: Record<string, SearchMatchField[]> | undefined;
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
    matches,
    onOpenMenu,
  } = rest;
  const matchedIn = matches?.[task.id]?.filter((f) => f !== 'title') ?? [];
  const titleRef = useRef<HTMLButtonElement>(null);
  const taskTags = tagsOf(task, tags);
  const list = listName(task);
  const selected = task.id === selectedTaskId;
  const done = task.status !== 'open';
  const abandoned = task.status === 'abandoned';
  const date = task.dates ? describeTaskDates(task.dates, { now, timeZone }) : null;
  const repeatText = task.dates && task.repeat ? describeRepeatFrequency(task.repeat, dueDayOf(task.dates)) : null;
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
        <TaskCheckbox checked={done} abandoned={abandoned} label={task.title} priority={task.priority} onChange={() => onToggleTask(task)} />
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
        {matchedIn.length > 0 && (
          <span className="task-row-match">{`匹配${matchedIn.map((f) => MATCH_LABELS[f]).join('、')}`}</span>
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
        {repeatText && (
          <span className="task-row-meta" title={repeatText}>
            <Icon name="repeat" size={14} />
            <span className="visually-hidden">{`重复：${repeatText}`}</span>
          </span>
        )}
        {task.dates && task.reminders.length > 0 && (
          <span className="task-row-meta" title="提醒">
            <Icon name="alarm" size={14} />
            <span className="visually-hidden">有提醒</span>
          </span>
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
