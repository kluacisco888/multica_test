import {
  arrangeAutoBoard,
  arrangeListBoard,
  arrangeTasks,
  buildTaskTree,
  describeRepeatFrequency,
  describeTaskDates,
  dueDayOf,
  GROUP_LABELS,
  GROUP_OPTIONS,
  UNGROUPED_COLUMN_TITLE,
  planIndent,
  PRIORITY_LABELS,
  SORT_LABELS,
  SORT_OPTIONS,
  type Board,
  type KanbanColumn,
  type SearchMatchField,
  type SmartParseResult,
  type TaskDatesInput,
  type Tag,
  type Task,
  type TaskList,
  type TaskNode,
  type TaskSection,
  type UpdateTaskRequest,
  type ViewOptions,
  VIEW_LAYOUT_LABELS,
  type ViewLayout,
  dropAfterId,
  selectTask,
  stepAfterId,
  toggleGroup,
  type SelectMode,
} from '@dida/shared';
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { batchContextSections, BatchToolbar, type BatchContext } from './BatchPanel.js';
import { ContextMenu, IconButton, MenuButton, TaskCheckbox, type ContextMenuSection } from '../ui/controls.js';
import { useSwipe } from './swipe.js';
import { Icon } from '../ui/Icon.js';
import { KanbanBoard, type ManualBoardActions } from './KanbanBoard.js';
import { QuickAdd, type SmartAddOptions } from './QuickAdd.js';
import { chipStyle, tagsOf, taskContextSections } from './taskMeta.js';
import { scopeKey, viewLayouts, viewTitle, type ListPaneView } from './views.js';

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
  /** `smart`: what 智能识别 found (null: nothing, or switched off). */
  onAddTask: (title: string, smart: SmartParseResult | null) => Promise<boolean>;
  /** 智能识别 for 添加任务 and the 看板 column quick add; null while loading or switched off. */
  smart: SmartAddOptions | null;
  /** The date 添加任务 gives new tasks here (今天, 明天 …): 智能识别's anchor. */
  addDates: TaskDatesInput | null;
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
  /** 看板分栏 of the 清单 on screen (看板视图); null while loading or not needed. */
  columns: KanbanColumn[] | null;
  /** 清单 board actions (看板视图 of a 清单). */
  kanban: ManualBoardActions | null;
  /** 多选: the selected tasks when two or more are (spec 用户故事 34); empty otherwise. */
  multiSelectedIds: readonly string[];
  /** Ctrl / Cmd / Shift + click and 全选: the new selection (fewer than two: back to one open task, or none). */
  onMultiSelect: (ids: string[]) => void;
  /** 批量操作 on the selection (its menus and the phone toolbar); null without a selection. */
  batch: BatchContext | null;
  onBatchDelete: () => void;
  isMobile: boolean;
  /** 拖拽排序 (spec 用户故事 32): put `task` right after `afterId` (null: first) in its group. */
  onMoveTask: (task: Task, afterId: string | null) => void;
}

/** Where a dragged row would land. */
type DropHint = { id: string; position: 'before' | 'after' } | null;
/** Rows a task is ordered with on screen: same section and parent (已置顶 roots together). */
const orderGroupKey = (sectionKey: string, task: Task) => `${sectionKey}|${task.parentId ?? ''}`;

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
  matrix: '',
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
  // 看板视图 (spec 用户故事 66、67): 清单 get their own 分栏, 智能清单 / 过滤器 automatic columns.
  const kanbanCapable = view !== null && viewLayouts(view).includes('kanban');
  const boardMode = kanbanCapable && viewOptions.layout === 'kanban';
  const arrangeContext = {
    now: props.now,
    timeZone: props.timeZone,
    lists: props.lists,
    tags: props.tags,
    completedView: view?.kind === 'smart' && view.id === 'completed',
  };
  let board: Board | null = null;
  if (boardMode && tasks && view) {
    if (view.kind !== 'list') board = arrangeAutoBoard(tasks, viewOptions, arrangeContext);
    else if (props.columns) board = arrangeListBoard(tasks, props.columns, viewOptions, arrangeContext);
  }
  const nodesOf = (items: Task[], section?: TaskSection): TaskNode<Task>[] => {
    if (!nested) return items.map((task) => ({ task, depth: 1, children: [] }));
    // 已置顶 keeps its pin order for the roots; each root brings its 子任务.
    if (section?.pinned) {
      const rank = new Map(items.map((t, i) => [t.id, i]));
      return buildTaskTree(items).sort((a, b) => (rank.get(a.task.id) ?? 0) - (rank.get(b.task.id) ?? 0));
    }
    return buildTaskTree(items);
  };

  // 拖拽排序 only in a 清单's own (custom) order, where the rows are the stored order.
  const reorderable = view?.kind === 'list' && !archived && viewOptions.sortBy === 'custom' && !boardMode;
  const [dragged, setDragged] = useState<{ id: string; group: string } | null>(null);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  const anchor = useRef<string | null>(null);

  // Display order (for Shift + click ranges) and the order groups (for drops), from what is on screen.
  const shownOrder: string[] = [];
  const groups = new Map<string, string[]>();
  const groupOfTask = new Map<string, string>();
  const sectionNodes = sections.map((section) => ({ section, nodes: nodesOf(section.tasks, section) }));
  for (const { section, nodes } of sectionNodes) {
    const walk = (list: TaskNode<Task>[], visible: boolean) => {
      for (const node of list) {
        const key = orderGroupKey(section.key, node.task);
        groups.set(key, [...(groups.get(key) ?? []), node.task.id]);
        groupOfTask.set(node.task.id, key);
        if (visible) shownOrder.push(node.task.id);
        walk(node.children, visible && !collapsed.has(node.task.id));
      }
    };
    walk(nodes, !collapsedSections.has(section.key));
  }
  const multi = new Set(props.multiSelectedIds);

  function select(task: Task, mode: SelectMode) {
    if (mode === 'single') {
      anchor.current = task.id;
      props.onSelectTask(task.id);
      return;
    }
    const base = props.multiSelectedIds.length > 0 ? [...props.multiSelectedIds] : props.selectedTaskId ? [props.selectedTaskId] : [];
    // Without a 多选 the range starts at the open task (or the clicked one), never at an old anchor.
    const from = props.multiSelectedIds.length > 0 ? anchor.current : props.selectedTaskId;
    const next = selectTask(shownOrder, { ids: base, anchor: from }, task.id, mode);
    anchor.current = next.anchor;
    props.onMultiSelect(next.ids);
  }

  function toggleSectionSelection(section: TaskSection) {
    const ids = section.tasks.map((t) => t.id).filter((id) => shownOrder.includes(id));
    props.onMultiSelect(toggleGroup(shownOrder, { ids: [...props.multiSelectedIds], anchor: anchor.current }, ids).ids);
  }

  function moveBy(task: Task, step: -1 | 1): boolean {
    const key = groupOfTask.get(task.id);
    const afterId = key ? stepAfterId(groups.get(key) ?? [], task.id, step) : undefined;
    if (afterId === undefined) return false;
    focusAfterMove.current = task.id;
    props.onMoveTask(task, afterId);
    return true;
  }

  const drag = reorderable
    ? {
        draggedId: dragged?.id ?? null,
        hint: dropHint,
        start(task: Task) {
          const group = groupOfTask.get(task.id);
          if (group) setDragged({ id: task.id, group });
        },
        end() {
          setDragged(null);
          setDropHint(null);
        },
        over(event: DragEvent<HTMLElement>, task: Task) {
          if (!dragged || groupOfTask.get(task.id) !== dragged.group || task.id === dragged.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          if (dropHint?.id !== task.id || dropHint.position !== position) setDropHint({ id: task.id, position });
        },
        drop(event: DragEvent<HTMLElement>, task: Task) {
          if (!dragged || !dropHint) return;
          event.preventDefault();
          const moved = tasks?.find((t) => t.id === dragged.id);
          const afterId = dropAfterId(groups.get(dragged.group) ?? [], dragged.id, task.id, dropHint.position);
          setDragged(null);
          setDropHint(null);
          if (moved && afterId !== undefined) props.onMoveTask(moved, afterId);
        },
      }
    : null;

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
    onToggleTask: props.onToggleTask,
    onIndent: indent,
    indentable: props.indentable,
    timeZone: props.timeZone,
    now: props.now,
    tags: props.tags,
    listName,
    matches: props.searchMatches,
    onOpenMenu: (task: Task, x: number, y: number, opener: HTMLElement | null) => setMenu({ task, x, y, opener }),
    multi,
    onSelect: select,
    onClearMulti: () => props.onMultiSelect([]),
    onMoveBy: reorderable ? moveBy : null,
    drag,
    // 多选 rows are tapped, not swiped.
    swipe: props.isMobile && multi.size === 0 ? { onToggle: (task: Task) => void props.onToggleTask(task), onDelete: props.onDeleteTask } : null,
  };

  const layoutSections = layoutMenuSections(viewOptions, props.onChangeViewOptions, view ? viewLayouts(view) : []);

  const isSearch = view?.kind === 'search';
  const emptyQuery = view?.kind === 'search' && view.query === '';

  return (
    <main className={`list-pane ${boardMode ? 'list-pane-kanban' : ''}`} aria-busy={(tasks === null || (boardMode && !board)) && !emptyQuery} ref={paneRef}>
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

      {view && props.addTarget !== null && !boardMode && <QuickAdd
          key={scopeKey(view)}
          target={props.addTarget}
          onAdd={props.onAddTask}
          smart={props.smart}
          defaultDates={props.addDates}
        />}

      {boardMode ? (
        board ? (
          <KanbanBoard
            board={board}
            smart={props.smart}
            tags={props.tags}
            selectedTaskId={props.selectedTaskId}
            timeZone={props.timeZone}
            now={props.now}
            listName={listName}
            onSelectTask={props.onSelectTask}
            onToggleTask={props.onToggleTask}
            onOpenMenu={rowProps.onOpenMenu}
            manual={view?.kind === 'list' && !archived ? props.kanban : null}
          />
        ) : (
          <p className="list-pane-status" role="status">
            正在加载…
          </p>
        )
      ) : emptyQuery ? (
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
        sectionNodes.map(({ section, nodes }) =>
          section.title === '' ? (
            <ul key={section.key} className="task-rows" aria-label="任务">
              <TaskRows nodes={nodes} sectionKey={section.key} {...rowProps} />
            </ul>
          ) : (
            <TaskSectionBlock
              key={section.key}
              section={section}
              collapsed={collapsedSections.has(section.key)}
              onToggle={() => toggleIn(setCollapsedSections, section.key)}
              selection={
                multi.size > 0
                  ? { all: section.tasks.every((t) => multi.has(t.id)), onToggle: () => toggleSectionSelection(section) }
                  : null
              }
            >
              {/* Completed subtrees keep their shape; a completed 子任务 of an open task shows as a root. */}
              <TaskRows nodes={nodes} sectionKey={section.key} {...rowProps} />
            </TaskSectionBlock>
          ),
        )
      )}

      {props.isMobile && props.batch && !boardMode && (
        <BatchToolbar ctx={props.batch} onCancel={() => props.onMultiSelect([])} onDelete={props.onBatchDelete} />
      )}

      {menu && (
        <ContextMenu
          label={props.batch && multi.has(menu.task.id) ? `批量操作：已选择 ${multi.size} 项` : `任务操作：${menu.task.title}`}
          x={menu.x}
          y={menu.y}
          returnFocus={menu.opener}
          // Read the task fresh: it may have changed since the menu opened.
          sections={
            props.batch && multi.has(menu.task.id)
              ? batchContextSections(props.batch, props.onBatchDelete)
              : [
            ...taskContextSections(
              tasks?.find((t) => t.id === menu.task.id) ?? menu.task,
              props.tags,
              (patch) => props.onChangeTask(menu.task, patch),
              () => props.onDeleteTask(menu.task),
            ),
            ...(menu.task.parentId === null && menu.task.status === 'open' ? [pinSection(menu.task, (patch) => props.onChangeTask(menu.task, patch))] : []),
            ...(board?.kind === 'manual' && props.kanban && menu.task.parentId === null ? [columnMoveSection(menu.task, props.columns ?? [], props.kanban)] : []),
          ]}
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
 * The 排序和分组 menu (shared with the 时间线): 视图 (the `layouts` this view
 * offers: 列表 / 看板 / 时间线, none for 搜索), 排序 and 分组 of the view on screen.
 */
export function layoutMenuSections(
  viewOptions: ViewOptions,
  onChange: (options: ViewOptions) => void,
  layouts: readonly ViewLayout[],
): ContextMenuSection[] {
  const layout = viewOptions.layout ?? 'list';
  return [
    ...(layouts.length > 1
      ? [
          {
            label: '视图',
            items: layouts.map((next) => ({
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

/** 置顶 / 取消置顶 (spec 用户故事 33): top-level open tasks. */
function pinSection(task: Task, onChange: (patch: UpdateTaskRequest) => void): ContextMenuSection {
  return {
    items: [
      task.pinOrder !== null
        ? { label: '取消置顶', icon: 'pin', onSelect: () => onChange({ pinned: false }) }
        : { label: '置顶', icon: 'pin', onSelect: () => onChange({ pinned: true }) },
    ],
  };
}

/** 移动到分组: the keyboard / touch way to move a card between 分栏. */
function columnMoveSection(task: Task, columns: KanbanColumn[], kanban: ManualBoardActions): ContextMenuSection {
  const current = columns.some((c) => c.id === task.columnId) ? task.columnId : null;
  const targets = [{ id: null, name: UNGROUPED_COLUMN_TITLE }, ...columns.map((c) => ({ id: c.id, name: c.name }))];
  return {
    label: '移动到分组',
    items: targets.map((t) => ({
      label: t.name,
      checked: t.id === current,
      onSelect: () => {
        if (t.id !== current) kanban.onDropTask(task.id, t.id, null);
      },
    })),
  };
}

/** A titled, collapsible group of rows: 已过期, a day, a 清单, 已完成 … */
function TaskSectionBlock({
  section,
  collapsed,
  onToggle,
  selection,
  children,
}: {
  section: TaskSection;
  collapsed: boolean;
  onToggle: () => void;
  /** While several tasks are selected: 全选 / 取消全选 of this group. */
  selection: { all: boolean; onToggle: () => void } | null;
  children: ReactNode;
}) {
  const id = `section-${section.key.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  return (
    <section className={`task-section ${section.pinned ? 'task-section-pinned' : ''}`} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="task-section-heading">
        <button type="button" className="task-section-toggle" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
          {section.pinned && <Icon name="pin" size={16} className="task-section-pin" />}
          <span>{section.title}</span>
          <span className="task-section-count">{section.tasks.length}</span>
        </button>
        {selection && (
          <button
            type="button"
            className="task-section-select"
            aria-label={`${selection.all ? '取消全选' : '全选'}「${section.title}」`}
            onClick={selection.onToggle}
          >
            {selection.all ? '取消全选' : '全选'}
          </button>
        )}
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

interface TaskRowsProps {
  nodes: TaskNode<Task>[];
  selectedTaskId: string | null;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (id: string) => void;
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
  /** Section the rows are in (drops stay inside it). */
  sectionKey: string;
  /** 多选: the selected tasks when several are. */
  multi: ReadonlySet<string>;
  onSelect: (task: Task, mode: SelectMode) => void;
  onClearMulti: () => void;
  /** Alt + ↑ / ↓ (keyboard 拖拽排序); null where the order cannot change. */
  onMoveBy: ((task: Task, step: -1 | 1) => boolean) | null;
  /** Phone: 右滑 toggles 完成, 左滑 deletes (spec 用户故事 108); null on desktop. */
  swipe: { onToggle: (task: Task) => void; onDelete: (task: Task) => void } | null;
  drag: {
    draggedId: string | null;
    hint: DropHint;
    start: (task: Task) => void;
    end: () => void;
    over: (event: DragEvent<HTMLElement>, task: Task) => void;
    drop: (event: DragEvent<HTMLElement>, task: Task) => void;
  } | null;
}

/** Click modifiers: Shift selects a range, Ctrl / Cmd adds or removes one task. */
function selectModeOf(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  if (e.shiftKey) return 'range';
  if (e.ctrlKey || e.metaKey) return 'toggle';
  return 'single';
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
    onToggleTask,
    onIndent,
    indentable,
    timeZone,
    now,
    tags,
    listName,
    matches,
    onOpenMenu,
    multi,
    onSelect,
    onClearMulti,
    onMoveBy,
    drag,
    swipe,
  } = rest;
  const swipeGesture = useSwipe({ onLeft: () => swipe?.onDelete(task), onRight: () => swipe?.onToggle(task) });
  const multiSelected = multi.has(task.id);
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
    // 多选 from the keyboard: Shift / Ctrl / Cmd + Enter or Space, like the clicks; Esc clears it.
    if ((e.key === 'Enter' || e.key === ' ') && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSelect(task, selectModeOf(e));
      return;
    }
    if (e.key === 'Escape' && multi.size > 0) {
      e.preventDefault();
      onClearMulti();
      return;
    }
    // Keyboard 拖拽排序: Alt + ↑ / ↓ moves the task one place within its group.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onMoveBy) {
      if (onMoveBy(task, e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
      return;
    }
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

  const swipeOffset = swipe ? swipeGesture.offset : 0;
  const row = (
      <div
        className={`task-row ${selected ? 'task-row-selected' : ''} ${multiSelected ? 'task-row-multi' : ''} ${done ? 'task-row-done' : ''} ${
          drag?.draggedId === task.id ? 'task-row-dragging' : ''
        }`}
        style={{ '--task-depth': depth - 1, transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined } as CSSProperties}
        {...(swipe ? swipeGesture.handlers : {})}
        onContextMenu={onContextMenu}
        data-drop={drag?.hint?.id === task.id ? drag.hint.position : undefined}
        draggable={drag !== null && !done}
        onDragStart={
          drag && !done
            ? (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', task.title);
                drag.start(task);
              }
            : undefined
        }
        onDragEnd={drag ? drag.end : undefined}
        onDragOver={drag ? (e) => drag.over(e, task) : undefined}
        onDrop={drag ? (e) => drag.drop(e, task) : undefined}
      >
        {drag && !done && (
          <span className="task-row-grip" aria-hidden="true">
            <Icon name="grip" size={14} />
          </span>
        )}
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
          aria-keyshortcuts={selected && !done && indentable ? 'Tab Shift+Tab' : onMoveBy && !done ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          onClick={(e) => onSelect(task, selectModeOf(e))}
          onKeyDown={onKeyDown}
        >
          {task.title}
          {multiSelected && <span className="visually-hidden">（已选中）</span>}
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
  );

  return (
    <li className="task-item">
      {swipe ? (
        <div className={`task-swipe ${swipeGesture.settling ? 'task-swipe-settling' : ''}`}>
          {swipeOffset > 0 && (
            <span className="task-swipe-action task-swipe-complete" aria-hidden="true">
              <Icon name={done ? 'restore' : 'check'} size={18} />
              {done ? '取消完成' : '完成'}
            </span>
          )}
          {swipeOffset < 0 && (
            <span className="task-swipe-action task-swipe-delete" aria-hidden="true">
              <Icon name="trash" size={18} />
              删除
            </span>
          )}
          {row}
        </div>
      ) : (
        row
      )}
      {children.length > 0 && !isCollapsed && (
        <ul id={childListId} className="task-rows" aria-label={`「${task.title}」的子任务`}>
          <TaskRows nodes={children} {...rest} />
        </ul>
      )}
    </li>
  );
}
