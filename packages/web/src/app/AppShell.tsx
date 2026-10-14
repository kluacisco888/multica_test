import {
  calendarDays,
  calendarModeSchema,
  DEFAULT_ALL_DAY_REMINDER_TIME,
  DEFAULT_SETTINGS,
  DEFAULT_TIME_ZONE,
  datesAsStored,
  DEFAULT_QUADRANTS,
  quadrantPriority,
  todayIn,
  keyBetween,
  type BatchAction,
  type CalendarDay,
  type CalendarMode,
  type NotificationChannel,
  sortKeyForDrop,
  UNGROUPED_COLUMN_TITLE,
  type KanbanColumn,
  type Quadrant,
  type Filter,
  type SearchMatchField,
  type SmartListId,
  type ViewOptions,
  DEPTH_EXCEEDED_MESSAGE,
  planIndent,
  planOutdent,
  orderTags,
  planSidebarDrop,
  TRASH_RETENTION_DAYS,
  type CurrentUser,
  type DropPosition,
  type Folder,
  type SidebarItemRef,
  type Settings,
  type SidebarResponse,
  type Tag,
  type Task,
  type TaskDatesInput,
  type TaskList,
  type TrashedTask,
  type UpdateSettingsRequest,
  type UpdateTaskRequest,
} from '@dida/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { useNow } from './clock.js';
import {
  ConfirmDialog,
  DeleteColumnDialog,
  FilterDialog,
  FolderDialog,
  ListDialog,
  TagDialog,
  type DeleteColumnChoice,
  type FilterDraft,
  type ListDraft,
  type TagDraft,
} from './dialogs.js';
import { CalendarPane } from './CalendarPane.js';
import { FocusPane } from './FocusPane.js';
import { useFocusTimer } from './focusTimer.js';
import { MatrixPane } from './MatrixPane.js';
import { Rail } from './Rail.js';
import { ReminderAlerts } from './ReminderAlerts.js';
import { SettingsDialog, type SettingsTab } from './SettingsDialog.js';
import { MOBILE_QUERY, useMediaQuery, useRoute } from './route.js';
import { activeSidebar, Sidebar } from './Sidebar.js';
import { TaskDetail } from './TaskDetail.js';
import { BatchDateDialog, BatchPanel, type BatchContext } from './BatchPanel.js';
import type { ManualBoardActions } from './KanbanBoard.js';
import { TaskListPane } from './TaskListPane.js';
import { TimelinePane } from './TimelinePane.js';
import { TrashPane } from './TrashPane.js';
import { matchShortcut } from './shortcuts.js';
import { ShortcutsDialog } from './ShortcutsPanel.js';
import { useTheme } from './theme.js';
import { belongsToView, quickAddTarget, scopeKey, tasksQuery, viewLayouts, viewOptionsFor, viewKey, type ListPaneView } from './views.js';

type DialogState =
  | { kind: 'none' }
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'list'; list: TaskList | null; folderId: string | null }
  | { kind: 'folder'; folder: Folder | null }
  | { kind: 'delete-list'; list: TaskList }
  | { kind: 'delete-folder'; folder: Folder }
  | { kind: 'tag'; tag: Tag | null; parentId: string | null }
  | { kind: 'delete-tag'; tag: Tag }
  | { kind: 'purge-task'; task: TrashedTask }
  | { kind: 'empty-trash' }
  | { kind: 'filter'; filter: Filter | null }
  | { kind: 'delete-filter'; filter: Filter }
  | { kind: 'quadrant'; index: number }
  | { kind: 'shortcuts' }
  | { kind: 'delete-column'; column: KanbanColumn; taskCount: number };

const CALENDAR_MODE_KEY = 'dida.calendar.mode';

/** The 日历 view last used on this device (月 by default). */
function storedCalendarMode(): CalendarMode {
  try {
    const parsed = calendarModeSchema.safeParse(window.localStorage.getItem(CALENDAR_MODE_KEY));
    return parsed.success ? parsed.data : 'month';
  } catch {
    return 'month';
  }
}

type ScreenTasks = { scope: string; items: Task[]; matches?: Record<string, SearchMatchField[]> };

/**
 * The application shell (spec 用户故事 65): rail | sidebar | task list | task
 * detail on desktop; on mobile the sidebar is a drawer and the detail a full
 * screen page. Owns the sidebar and current-list data.
 */
export function AppShell({ user, onLoggedOut }: { user: CurrentUser; onLoggedOut: () => void }) {
  const [route, navigate] = useRoute();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [sidebar, setSidebar] = useState<SidebarResponse | null>(null);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [tasks, setTasks] = useState<ScreenTasks | null>(null);
  const [filters, setFilters] = useState<Filter[] | null>(null);
  const [smartCounts, setSmartCounts] = useState<Record<string, number>>({});
  /** Bumped to refetch the task set on screen (e.g. after a 标签 was deleted). */
  const [tasksEpoch, setTasksEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [settings, setSettings] = useState<Settings | null>(null);
  /** 通知渠道, for choosing where a task's 提醒 go; reloaded when 设置 closes. */
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  /** 看板分栏 of the 清单 on screen in 看板视图. */
  const [columns, setColumns] = useState<{ listId: string; items: KanbanColumn[] } | null>(null);
  /** The 回收站 while it is on screen. */
  const [trash, setTrash] = useState<TrashedTask[] | null>(null);
  const now = useNow();

  const fail = useCallback((e: unknown) => {
    console.error(e);
    setError(api.errorMessage(e));
  }, []);
  /** 番茄专注 timer, kept for the whole app so a 番茄 ends (and chimes) wherever the user is. */
  const focusTimer = useFocusTimer(fail);

  /** The sidebar: 清单, 文件夹, their counts and the 智能清单 counts. */
  const reloadSidebar = useCallback(async () => {
    try {
      const [data, counts] = await Promise.all([api.fetchSidebar(), api.fetchSmartListCounts()]);
      setSidebar(data);
      setSmartCounts(counts);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  const reloadFilters = useCallback(async () => {
    try {
      setFilters(await api.fetchFilters());
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  const reloadTags = useCallback(async () => {
    try {
      setTags(orderTags(await api.fetchTags()));
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.fetchSidebar(), api.fetchTags(), api.fetchFilters(), api.fetchSmartListCounts()])
      .then(([data, tagList, filterList, counts]) => {
        if (cancelled) return;
        setSidebar(data);
        setTags(orderTags(tagList));
        setFilters(filterList);
        setSmartCounts(counts);
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [fail]);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchSettings()
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [fail]);

  const reloadChannels = useCallback(async () => {
    try {
      setChannels(await api.fetchChannels());
    } catch {
      // Only the 发送到 choice needs them; the default channels still apply.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchChannels()
      .then((list) => {
        if (!cancelled) setChannels(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useTheme(settings ? { mode: settings.themeMode, color: settings.themeColor } : null);

  async function saveSettings(patch: UpdateSettingsRequest) {
    // 主题 changes show at once; a failed save puts the old theme back.
    const previous = settings;
    if (settings && (patch.themeMode || patch.themeColor)) {
      setSettings({ ...settings, ...(patch.themeMode ? { themeMode: patch.themeMode } : {}), ...(patch.themeColor ? { themeColor: patch.themeColor } : {}) });
    }
    try {
      setSettings(await api.updateSettings(patch));
      return true;
    } catch (e) {
      if (previous && (patch.themeMode || patch.themeColor)) setSettings(previous);
      fail(e);
      return false;
    }
  }

  const timeZone = settings?.timeZone ?? DEFAULT_TIME_ZONE;
  const today = todayIn(now, timeZone);
  const calendarMode = route.calendar ? (route.calendar.mode ?? storedCalendarMode()) : null;
  const calendarAnchor = route.calendar ? (route.calendar.date ?? today) : null;
  const calendarRange = useMemo(() => {
    if (!calendarMode || !calendarAnchor) return null;
    const days = calendarDays(calendarMode, calendarAnchor);
    return { from: days[0] as string, to: days.at(-1) as string };
  }, [calendarMode, calendarAnchor]);
  /** 农历 / 节日 / 休 / 班 of the 日历 days on screen. */
  const [calendarInfo, setCalendarInfo] = useState<ReadonlyMap<string, CalendarDay>>(new Map());

  const inbox = sidebar?.lists.find((l) => l.isInbox) ?? null;
  const currentTag = route.tagId ? (tags?.find((t) => t.id === route.tagId) ?? null) : null;
  const currentFilter = route.filterId ? (filters?.find((f) => f.id === route.filterId) ?? null) : null;
  const crossListRoute = Boolean(route.matrix || route.focus || route.calendar || route.trash || route.tagId || route.smartId || route.filterId || (route.search !== null && route.search !== undefined));
  const currentList = useMemo(() => {
    if (!sidebar || crossListRoute) return null;
    return (route.listId ? sidebar.lists.find((l) => l.id === route.listId) : inbox) ?? null;
  }, [sidebar, route.listId, crossListRoute, inbox]);
  const matrixQuadrants = settings?.matrixQuadrants ?? null;
  const view: ListPaneView | null = useMemo(() => {
    if (route.matrix) return matrixQuadrants ? { kind: 'matrix', quadrants: matrixQuadrants } : null;
    if (calendarRange) return { kind: 'calendar', range: calendarRange };
    if (route.trash) return null;
    if (route.search !== null && route.search !== undefined) return { kind: 'search', query: route.search };
    if (route.smartId) return sidebar ? { kind: 'smart', id: route.smartId, inbox } : null;
    if (currentFilter) return { kind: 'filter', filter: currentFilter, inbox };
    if (currentTag) return { kind: 'tag', tag: currentTag, inbox };
    return currentList ? { kind: 'list', list: currentList } : null;
  }, [route.matrix, matrixQuadrants, calendarRange, route.trash, route.search, route.smartId, sidebar, currentFilter, currentTag, currentList, inbox]);

  useEffect(() => {
    if (!calendarRange) return;
    let cancelled = false;
    api
      .fetchCalendarDays(calendarRange)
      .then((days) => {
        if (!cancelled) setCalendarInfo(new Map(days.map((d) => [d.date, d])));
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [calendarRange, fail]);

  const reloadTrash = useCallback(async () => {
    try {
      setTrash(await api.fetchTrash());
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    if (!route.trash) return;
    let cancelled = false;
    api
      .fetchTrash()
      .then((items) => {
        if (!cancelled) setTrash(items);
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [route.trash, fail]);

  // An unknown or deleted 清单 / 标签 / 过滤器 in the URL falls back to the 收件箱.
  useEffect(() => {
    const unknownList = sidebar && route.listId && !sidebar.lists.some((l) => l.id === route.listId);
    const unknownTag = tags && route.tagId && !tags.some((t) => t.id === route.tagId);
    const unknownFilter = filters && route.filterId && !filters.some((f) => f.id === route.filterId);
    if (unknownList || unknownTag || unknownFilter) navigate({ listId: null, taskId: null }, { replace: true });
  }, [sidebar, tags, filters, route.listId, route.tagId, route.filterId, navigate]);

  const currentScope = view ? scopeKey(view) : null;

  /** Fetch the task set of `target`: one call per view kind. */
  const fetchScreen = useCallback(async (target: ListPaneView): Promise<ScreenTasks | null> => {
    const scope = scopeKey(target);
    if (target.kind === 'search') {
      if (!target.query) return { scope, items: [], matches: {} };
      const found = await api.searchTasks(target.query);
      return { scope, items: found.tasks, matches: found.matches };
    }
    const query = tasksQuery(target);
    return query ? { scope, items: await api.fetchTasks(query) } : null;
  }, []);

  useEffect(() => {
    if (!view || !currentScope) return;
    let cancelled = false;
    fetchScreen(view)
      .then((next) => {
        if (!cancelled && next) setTasks(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
    // `view` changes identity with every sidebar reload; refetch only when the scope does
    // (a 过滤器 also when its rules change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScope, currentFilter?.revision, tasksEpoch, fail, fetchScreen]);

  // Dates are shown in the user's time zone, so wait for the settings too.
  const listTasks = settings && tasks && tasks.scope === currentScope ? tasks.items : null;
  const selectedTask = listTasks?.find((t) => t.id === route.taskId) ?? null;
  // 多选 (spec 用户故事 34): two or more selected tasks of this view, in display order.
  const [multi, setMulti] = useState<{ scope: string | null; ids: string[] }>({ scope: null, ids: [] });
  const [pickingBatchDate, setPickingBatchDate] = useState(false);
  const multiTasks =
    multi.scope === currentScope && listTasks ? multi.ids.flatMap((id) => listTasks.find((t) => t.id === id) ?? []) : [];
  // On a phone a plain tap opens the task full screen, so one Ctrl / Shift-selected task already starts the 多选.
  const batchTasks = multiTasks.length >= (isMobile ? 1 : 2) ? multiTasks : [];
  const viewOptions = view ? viewOptionsFor(view, settings?.viewOptions) : null;
  // Tab / Shift+Tab only make sense in a 清单 shown in its own order.
  const indentable = view?.kind === 'list' && viewOptions?.sortBy === 'custom' && viewOptions.groupBy === 'none';
  const addTarget = view ? quickAddTarget(view, { now, timeZone }) : null;
  // 看板视图 (spec 用户故事 66、67).
  const boardMode = view !== null && viewLayouts(view).includes('kanban') && viewOptions?.layout === 'kanban';
  const boardListId = boardMode && view?.kind === 'list' ? view.list.id : null;
  const listColumns = columns && columns.listId === boardListId ? columns.items : null;

  useEffect(() => {
    if (!boardListId) return;
    let cancelled = false;
    api
      .fetchKanbanColumns(boardListId)
      .then((items) => {
        if (!cancelled) setColumns({ listId: boardListId, items });
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [boardListId, fail]);

  const sortColumns = (items: KanbanColumn[]) =>
    [...items].sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.id < b.id ? -1 : 1));

  async function reloadColumns(listId: string) {
    try {
      const items = await api.fetchKanbanColumns(listId);
      setColumns((prev) => (prev && prev.listId !== listId ? prev : { listId, items }));
    } catch (e) {
      fail(e);
    }
  }

  /** Open cards (top-level tasks) of a column in custom order: where a dropped card lands. */
  function cardsOf(columnId: string | null): Task[] {
    const live = new Set((listColumns ?? []).map((c) => c.id));
    const ids = new Set((listTasks ?? []).map((t) => t.id));
    return (listTasks ?? []).filter(
      (t) =>
        t.status === 'open' &&
        (t.parentId === null || !ids.has(t.parentId)) &&
        (t.columnId !== null && live.has(t.columnId) ? t.columnId : null) === columnId,
    );
  }

  const kanbanActions: ManualBoardActions | null =
    boardListId === null
      ? null
      : {
          async onAddTask(columnId, title) {
            try {
              putTask(await api.createTask({ listId: boardListId, title, columnId }));
              void reloadSidebar();
              return true;
            } catch (e) {
              fail(e);
              return false;
            }
          },
          async onAddColumn(name, sortOrder) {
            try {
              const created = await api.createKanbanColumn({ listId: boardListId, name, ...(sortOrder ? { sortOrder } : {}) });
              setColumns((prev) => ({ listId: boardListId, items: sortColumns([...(prev?.listId === boardListId ? prev.items : []), created]) }));
              return true;
            } catch (e) {
              fail(e);
              return false;
            }
          },
          async onRenameColumn(column, name) {
            try {
              const updated = await api.updateKanbanColumn(column.id, { name });
              setColumns((prev) => prev && { ...prev, items: prev.items.map((c) => (c.id === updated.id ? updated : c)) });
              return true;
            } catch (e) {
              fail(e);
              return false;
            }
          },
          onReorderColumn(column, sortOrder) {
            // Optimistic: the column moves at once.
            setColumns((prev) => prev && { ...prev, items: sortColumns(prev.items.map((c) => (c.id === column.id ? { ...c, sortOrder } : c))) });
            api.updateKanbanColumn(column.id, { sortOrder }).catch((e: unknown) => {
              fail(e);
              void reloadColumns(boardListId);
            });
          },
          onDeleteColumn(column) {
            const taskCount = (listTasks ?? []).filter((t) => t.columnId === column.id && t.parentId === null).length;
            // Reference: an empty 分组 is deleted without asking.
            if (taskCount === 0) void removeColumn(column, { tasks: 'delete' });
            else setDialog({ kind: 'delete-column', column, taskCount });
          },
          onDropTask(taskId, columnId, beforeId) {
            const task = listTasks?.find((t) => t.id === taskId);
            if (!task) return;
            const live = new Set((listColumns ?? []).map((c) => c.id));
            const currentColumn = task.columnId !== null && live.has(task.columnId) ? task.columnId : null;
            // Order inside a column follows the drop only in the custom order.
            const sortOrder = viewOptions?.sortBy === 'custom' ? sortKeyForDrop(cardsOf(columnId), task.id, beforeId) : null;
            const patch: UpdateTaskRequest = {
              ...(currentColumn !== columnId ? { columnId } : {}),
              ...(sortOrder ? { sortOrder } : {}),
            };
            if (Object.keys(patch).length === 0) return;
            putTask({ ...task, ...patch } as Task);
            void changeTask(task, patch);
          },
        };

  async function removeColumn(column: KanbanColumn, choice: DeleteColumnChoice) {
    try {
      await api.deleteKanbanColumn(column.id, choice.tasks === 'move' ? { tasks: 'move', ...(choice.moveTo ? { moveTo: choice.moveTo } : {}) } : { tasks: 'delete' });
      setDialog({ kind: 'none' });
      await Promise.all([reloadColumns(column.listId), reloadTasks()]);
      void reloadSidebar();
    } catch (e) {
      fail(e);
    }
  }

  function openList(listId: string) {
    navigate({ listId: listId === inbox?.id ? null : listId, taskId: null });
    setDrawerOpen(false);
  }

  function openTrash() {
    if (!route.trash) setTrash(null); // show 正在加载… rather than an old copy
    navigate({ listId: null, tagId: null, taskId: null, trash: true });
    setDrawerOpen(false);
  }

  function openTag(tagId: string) {
    navigate({ listId: null, tagId, taskId: null });
    setDrawerOpen(false);
  }

  function openSmart(smartId: SmartListId) {
    navigate({ listId: null, smartId, taskId: null });
    setDrawerOpen(false);
  }

  function openFilter(filterId: string) {
    navigate({ listId: null, filterId, taskId: null });
    setDrawerOpen(false);
  }

  function openSearch(query = '') {
    // Typing refines the same search: replace the history entry instead of piling them up.
    navigate({ listId: null, search: query, taskId: null }, { replace: route.search !== null && route.search !== undefined });
    setDrawerOpen(false);
  }

  function selectTask(taskId: string | null) {
    setMulti({ scope: null, ids: [] });
    // In the 日历 the URL names the view and date, so the task stays on the same page.
    const calendar = calendarMode && calendarAnchor ? { mode: calendarMode, date: calendarAnchor } : null;
    navigate({ ...route, calendar, taskId });
  }

  /** 番茄专注 (spec 用户故事 86). */
  function openFocus() {
    navigate({ listId: null, focus: true, taskId: null });
    setDrawerOpen(false);
  }

  /** 日历 (spec 用户故事 69): `mode` and `date` default to the last used view and today. */
  function openCalendar(mode?: CalendarMode, date?: string) {
    if (mode) {
      try {
        window.localStorage.setItem(CALENDAR_MODE_KEY, mode);
      } catch {
        // Private mode: the view is still in the URL.
      }
    }
    navigate({ listId: null, calendar: { mode: mode ?? null, date: date ?? null }, taskId: null });
    setDrawerOpen(false);
  }

  /** 四象限 (spec 用户故事 72). */
  function openMatrix() {
    navigate({ listId: null, matrix: true, taskId: null });
    setDrawerOpen(false);
  }

  /** Drag (or 移动到象限) in the 四象限 (spec 用户故事 73): the task takes the quadrant's 优先级. */
  function moveMatrixTask(task: Task, index: number) {
    if (!settings) return;
    const priority = quadrantPriority(settings.matrixQuadrants, index);
    if (priority === task.priority) return;
    putTask({ ...task, priority });
    void changeTask(task, { priority });
  }

  /** + in a quadrant: into the 收件箱 (or the quadrant's only 清单) with the quadrant's 优先级. */
  async function addMatrixTask(index: number, title: string) {
    if (!settings) return false;
    const listIds = settings.matrixQuadrants[index]?.rules.listIds ?? [];
    try {
      putTask(await api.createTask({ title, priority: quadrantPriority(settings.matrixQuadrants, index), ...(listIds.length === 1 ? { listId: listIds[0] } : {}) }));
      void reloadSidebar();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  /** Save quadrant `index` (the four are stored together in 设置), then re-read the 四象限 tasks. */
  async function saveQuadrant(index: number, quadrant: Quadrant) {
    if (!settings) return;
    const matrixQuadrants = settings.matrixQuadrants.map((q, i) => (i === index ? quadrant : q));
    if (await saveSettings({ matrixQuadrants })) {
      setDialog({ kind: 'none' });
      setTasksEpoch((n) => n + 1);
    }
  }

  /** Click on an empty day or time slot of the 日历 (spec 用户故事 71): into the 收件箱 with that date. */
  async function addCalendarTask(title: string, dates: TaskDatesInput) {
    try {
      putTask(await api.createTask({ title, dates }));
      void reloadSidebar();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  /** Drag in the 日历: move at once, then save (a failure re-reads the tasks). */
  function moveCalendarTask(task: Task, dates: TaskDatesInput) {
    putTask({ ...task, dates: datesAsStored(dates, timeZone) });
    void changeTask(task, { dates });
  }

  /** Does `task` belong to the task set on screen? */
  function inView(task: Task): boolean {
    if (!view) return false;
    return belongsToView(view, task, { now, timeZone, lists: sidebar?.lists ?? [], tags: tags ?? [] });
  }

  /** Replace a task on screen (or drop it when it left the 清单 / 标签). */
  function putTask(task: Task) {
    const keep = inView(task);
    setTasks((prev) => {
      if (!prev || prev.scope !== currentScope) return prev;
      const others = prev.items.filter((t) => t.id !== task.id);
      return { ...prev, items: keep ? sortTasks([...others, task]) : others };
    });
  }

  async function addTask(title: string) {
    if (!view || !addTarget) return false;
    try {
      // Outside a 清单 the task goes to the 收件箱, with what makes it show here
      // (the 标签, today's date in 今天, 低优先级 in 不重要的 …).
      const task = await api.createTask({ ...addTarget.request, title });
      putTask(task);
      // A new task lands first; if it does not sort first here, the server re-keyed the 清单 (long keys): re-read it.
      const rekeyed = listTasks?.some((t) => t.listId === task.listId && t.parentId === null && t.id !== task.id && t.sortOrder <= task.sortOrder);
      if (rekeyed) void reloadTasks();
      void reloadSidebar();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  /** Re-read the tasks on screen: a change may have cascaded to 子任务 / ancestors. */
  async function reloadTasks() {
    if (!view || !currentScope) return;
    const scope = currentScope;
    try {
      const next = await fetchScreen(view);
      if (next) setTasks((prev) => (prev && prev.scope !== scope ? prev : next));
    } catch (e) {
      fail(e);
    }
  }

  async function addSubtask(parent: Task, title: string) {
    try {
      putTask(await api.createTask({ parentId: parent.id, title }));
      void reloadSidebar();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  /** Tab / Shift+Tab (spec 用户故事 36). False when nothing can move, so Tab keeps moving focus. */
  function indentTask(task: Task, outdent: boolean): boolean {
    // Cross-清单 views and other orders flatten trees: indenting there could move the
    // task into another 清单 or somewhere unseen, so Tab keeps its default meaning (move focus).
    if (!indentable) return false;
    if (!listTasks || task.status !== 'open') return false;
    const plan = outdent ? planOutdent(listTasks, task.id) : planIndent(listTasks, task.id, (t) => t.status === 'open');
    if (plan.kind === 'none') return false;
    if (plan.kind === 'too-deep') {
      setError(DEPTH_EXCEEDED_MESSAGE);
      return true;
    }
    // Optimistic, so the row lands under its new parent right away.
    putTask({ ...task, parentId: plan.parentId, sortOrder: plan.sortOrder });
    void changeTask(task, { parentId: plan.parentId, sortOrder: plan.sortOrder });
    return true;
  }

  async function changeTask(task: Task, patch: UpdateTaskRequest) {
    try {
      const updated = await api.updateTask(task.id, patch);
      putTask(updated);
      if (patch.status !== undefined || patch.listId !== undefined || patch.parentId !== undefined) void reloadTasks();
      // Counts of 清单 and 智能清单 follow status, 清单, dates and 优先级.
      if (patch.status !== undefined || patch.listId !== undefined || patch.dates !== undefined || patch.priority !== undefined) {
        void reloadSidebar();
      }
      if (!inView(updated) && route.taskId === task.id) selectTask(null);
      return updated;
    } catch (e) {
      fail(e);
      // Undo optimistic changes.
      void reloadTasks();
      return null;
    }
  }

  /** 时间线 drag: show the new dates at once, then save them (a failure re-reads the tasks). */
  async function moveTask(task: Task, dates: TaskDatesInput) {
    putTask({ ...task, dates: datesAsStored(dates, timeZone) });
    await changeTask(task, { dates });
  }

  /** Ctrl / Cmd / Shift + click: two or more tasks (one on a phone) become the 多选; fewer go back to one open task (or none). */
  function multiSelect(ids: string[]) {
    if (ids.length >= (isMobile ? 1 : 2)) {
      if (route.taskId) selectTask(null);
      setMulti({ scope: currentScope, ids });
    } else {
      selectTask(ids[0] ?? null);
    }
  }

  /** 批量操作 on the 多选. Actions that can take tasks out of the view end the selection. */
  async function runBatch(action: BatchAction) {
    const ids = batchTasks.map((t) => t.id);
    if (ids.length === 0) return;
    try {
      await api.batchTasks(ids, action);
      if (action.op === 'delete' || action.op === 'complete' || action.op === 'abandon' || action.op === 'move') {
        setMulti({ scope: null, ids: [] });
      }
      await reloadTasks();
      void reloadSidebar();
    } catch (e) {
      fail(e);
      void reloadTasks();
    }
  }

  /** 拖拽排序 (spec 用户故事 32): show the new place at once, then save it (a failure re-reads the tasks). */
  async function reorderTask(task: Task, afterId: string | null) {
    const pinned = task.pinOrder !== null;
    const key = (t: Task) => (pinned ? (t.pinOrder ?? '') : t.sortOrder);
    const group = (listTasks ?? [])
      .filter((t) => t.id !== task.id && (pinned ? t.pinOrder !== null : t.listId === task.listId && t.parentId === task.parentId))
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1));
    const index = afterId === null ? 0 : group.findIndex((t) => t.id === afterId) + 1;
    try {
      const guess = keyBetween(group[index - 1] ? key(group[index - 1]!) : null, group[index] ? key(group[index]!) : null);
      putTask(pinned ? { ...task, pinOrder: guess } : { ...task, sortOrder: guess });
    } catch {
      // Out-of-order keys on screen: just wait for the server.
    }
    try {
      for (const moved of await api.moveTask(task.id, afterId)) putTask(moved);
    } catch (e) {
      fail(e);
      void reloadTasks();
    }
  }

  /** 删除: the task and its 子任务 go to the 回收站. */
  async function deleteTask(task: Task) {
    try {
      await api.deleteTask(task.id);
      if (route.taskId === task.id) selectTask(null);
      await reloadTasks();
      void reloadSidebar();
    } catch (e) {
      fail(e);
    }
  }

  async function restoreTask(task: TrashedTask) {
    try {
      await api.restoreTask(task.id);
      await reloadTrash();
      void reloadSidebar();
    } catch (e) {
      fail(e);
    }
  }

  async function purgeTask(task: TrashedTask) {
    try {
      await api.purgeTask(task.id);
      setDialog({ kind: 'none' });
      await reloadTrash();
    } catch (e) {
      fail(e);
    }
  }

  async function emptyTrash() {
    try {
      await api.emptyTrash();
      setDialog({ kind: 'none' });
      await reloadTrash();
    } catch (e) {
      fail(e);
    }
  }

  /** 归档 / 取消归档 (spec 用户故事 16). */
  async function archiveList(list: TaskList, archived: boolean) {
    try {
      await api.updateList(list.id, { archived });
      await reloadSidebar();
    } catch (e) {
      fail(e);
    }
  }

  async function saveList(draft: ListDraft, existing: TaskList | null) {
    try {
      if (existing) {
        await api.updateList(existing.id, draft);
        await reloadSidebar();
        // 不进智能清单 changes which tasks a 智能清单 shows.
        if (draft.excludeFromSmartLists !== existing.excludeFromSmartLists) setTasksEpoch((n) => n + 1);
      } else {
        const created = await api.createList(draft);
        // Load the sidebar first: an unknown 清单 in the URL would fall back to the 收件箱.
        await reloadSidebar();
        openList(created.id);
      }
      setDialog({ kind: 'none' });
    } catch (e) {
      fail(e);
    }
  }

  async function saveFolder(name: string, existing: Folder | null) {
    try {
      if (existing) await api.updateFolder(existing.id, { name });
      else await api.createFolder({ name });
      setDialog({ kind: 'none' });
      await reloadSidebar();
    } catch (e) {
      fail(e);
    }
  }

  async function removeList(list: TaskList) {
    try {
      await api.deleteList(list.id);
      setDialog({ kind: 'none' });
      if (currentList?.id === list.id) navigate({ listId: null, taskId: null });
      // 过滤器 that named the 清单 no longer apply it.
      await Promise.all([reloadSidebar(), reloadFilters()]);
      setTasksEpoch((n) => n + 1);
    } catch (e) {
      fail(e);
    }
  }

  async function removeFolder(folder: Folder) {
    try {
      await api.deleteFolder(folder.id);
      setDialog({ kind: 'none' });
      await reloadSidebar();
    } catch (e) {
      fail(e);
    }
  }

  async function saveTag(draft: TagDraft, existing: Tag | null) {
    try {
      if (existing) {
        await api.updateTag(existing.id, draft);
        await reloadTags();
        // A changed parent changes which tasks a parent 标签 view covers.
        if (draft.parentId !== existing.parentId) setTasksEpoch((n) => n + 1);
      } else {
        const created = await api.createTag(draft);
        await reloadTags();
        openTag(created.id);
      }
      setDialog({ kind: 'none' });
    } catch (e) {
      fail(e);
    }
  }

  async function removeTag(tag: Tag) {
    try {
      await api.deleteTag(tag.id);
      setDialog({ kind: 'none' });
      if (route.tagId === tag.id) navigate({ listId: null, tagId: null, taskId: null });
      await Promise.all([reloadTags(), reloadFilters()]);
      // Tasks on screen lost the 标签: refetch them.
      setTasksEpoch((n) => n + 1);
    } catch (e) {
      fail(e);
    }
  }

  async function saveFilter(draft: FilterDraft, existing: Filter | null) {
    try {
      if (existing) {
        const updated = await api.updateFilter(existing.id, draft);
        setFilters((prev) => prev?.map((f) => (f.id === updated.id ? updated : f)) ?? prev);
      } else {
        const created = await api.createFilter(draft);
        setFilters((prev) => [...(prev ?? []), created]);
        openFilter(created.id);
      }
      setDialog({ kind: 'none' });
    } catch (e) {
      fail(e);
    }
  }

  async function removeFilter(filter: Filter) {
    try {
      await api.deleteFilter(filter.id);
      setDialog({ kind: 'none' });
      if (route.filterId === filter.id) navigate({ listId: null, taskId: null });
      await reloadFilters();
    } catch (e) {
      fail(e);
    }
  }

  function changeViewOptions(options: ViewOptions) {
    if (!view || !settings) return;
    const key = viewKey(view);
    // Optimistic: the layout changes at once; saving failure shows a toast.
    setSettings({ ...settings, viewOptions: { ...settings.viewOptions, [key]: options } });
    void saveSettings({ viewOptions: { [key]: options } });
  }

  function hideSmartList(id: SmartListId) {
    if (!settings) return;
    const hiddenSmartLists = [...settings.hiddenSmartLists.filter((h) => h !== id), id];
    setSettings({ ...settings, hiddenSmartLists });
    void saveSettings({ hiddenSmartLists });
  }

  async function toggleFolder(folder: Folder) {
    // Optimistic: collapsing should feel instant.
    setSidebar((s) => s && { ...s, folders: s.folders.map((f) => (f.id === folder.id ? { ...f, collapsed: !f.collapsed } : f)) });
    try {
      await api.updateFolder(folder.id, { collapsed: !folder.collapsed });
    } catch (e) {
      fail(e);
      await reloadSidebar();
    }
  }

  async function moveSidebarItem(dragged: SidebarItemRef, target: SidebarItemRef, position: DropPosition) {
    if (!sidebar) return;
    const plan = planSidebarDrop(activeSidebar(sidebar), dragged, target, position);
    if (!plan) return;
    setSidebar({
      ...sidebar,
      lists: sidebar.lists.map((l) => (plan.kind === 'list' && l.id === plan.id ? { ...l, ...plan.patch } : l)),
      folders: sidebar.folders.map((f) => (plan.kind === 'folder' && f.id === plan.id ? { ...f, ...plan.patch } : f)),
    });
    try {
      if (plan.kind === 'list') await api.updateList(plan.id, plan.patch);
      else await api.updateFolder(plan.id, plan.patch);
    } catch (e) {
      fail(e);
    }
    await reloadSidebar();
  }

  // 快捷键 (spec 用户故事 105–106). The handler is re-bound each render so it sees the current task and view.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const action = matchShortcut(event);
      if (!action) return;
      switch (action.kind) {
        case 'search': {
          event.preventDefault();
          if (view?.kind === 'search') document.querySelector<HTMLInputElement>('.search-box-input')?.focus();
          else openSearch();
          return;
        }
        case 'help':
          event.preventDefault();
          setDialog({ kind: 'shortcuts' });
          return;
        case 'addTask': {
          const input = document.querySelector<HTMLInputElement>('.quick-add-input');
          // Views without a quick-add box (日历) mark their own 添加任务 control.
          const button = input ? null : document.querySelector<HTMLButtonElement>('[data-shortcut="add-task"]');
          if (!input && !button) return;
          // Keep the "n" out of the box it focuses.
          event.preventDefault();
          if (input) input.focus();
          else button?.click();
          return;
        }
        case 'priority': {
          if (!selectedTask || selectedTask.priority === action.priority) return;
          event.preventDefault();
          void changeTask(selectedTask, { priority: action.priority });
          return;
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  const batch: BatchContext | null =
    batchTasks.length > 0
      ? {
          tasks: batchTasks,
          lists: sidebar?.lists ?? [],
          tags: tags ?? [],
          timeZone,
          now,
          onAction: (action) => void runBatch(action),
          onPickDate: () => setPickingBatchDate(true),
        }
      : null;

  // 时间线 (spec 用户故事 68) and 看板 (66、67) use the whole width until a task is opened, like the reference.
  const timeline = view !== null && viewLayouts(view).includes('timeline') && viewOptions?.layout === 'timeline';
  const board = boardMode && !route.trash;
  // The 日历 takes the whole width too; its task opens beside it.
  const showDetail = route.focus
    ? false
    : route.calendar || route.matrix
      ? selectedTask !== null
      : (!isMobile && !timeline && !board) || selectedTask !== null;
  const sidebarVisible = isMobile ? drawerOpen : sidebarOpen && !route.calendar && !route.matrix && !route.focus;

  return (
    <div
      className={`shell ${sidebarVisible ? 'shell-sidebar-open' : 'shell-sidebar-closed'} ${selectedTask ? 'shell-has-task' : ''} ${
        route.calendar ? 'shell-calendar' : ''}
      } ${route.focus ? 'shell-focus' : ''
      } ${route.matrix ? 'shell-matrix' : ''} ${board ? 'shell-kanban' : ''}`}
    >
      {!isMobile && (
        <Rail
          user={user}
          onOpenAccount={() => setDialog({ kind: 'settings', tab: 'account' })}
          onOpenSettings={() => setDialog({ kind: 'settings', tab: 'notifications' })}
          onHome={() => navigate({ listId: null, taskId: null })}
          onCalendar={() => openCalendar()}
          onMatrix={openMatrix}
          onFocus={openFocus}
          onSearch={() => openSearch()}
          active={route.calendar ? 'calendar' : route.matrix ? 'matrix' : route.focus ? 'focus' : view?.kind === 'search' ? 'search' : 'tasks'}
        />
      )}
      {isMobile && drawerOpen && <div className="shell-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
      {sidebarVisible && (
        <Sidebar
          sidebar={sidebar}
          tags={tags ?? []}
          currentListId={currentList?.id ?? null}
          currentTagId={currentTag?.id ?? null}
          isDrawer={isMobile}
          user={user}
          onOpenAccount={() => setDialog({ kind: 'settings', tab: 'account' })}
          onOpenSettings={() => setDialog({ kind: 'settings', tab: 'notifications' })}
          onClose={() => setDrawerOpen(false)}
          onOpenList={openList}
          onAddList={(folderId) => setDialog({ kind: 'list', list: null, folderId })}
          onAddFolder={() => setDialog({ kind: 'folder', folder: null })}
          onEditList={(list) => setDialog({ kind: 'list', list, folderId: list.folderId })}
          onDeleteList={(list) => setDialog({ kind: 'delete-list', list })}
          onArchiveList={(list, archived) => void archiveList(list, archived)}
          trashActive={route.trash === true}
          onOpenTrash={openTrash}
          onRenameFolder={(folder) => setDialog({ kind: 'folder', folder })}
          onDeleteFolder={(folder) => setDialog({ kind: 'delete-folder', folder })}
          onToggleFolder={toggleFolder}
          onMove={moveSidebarItem}
          onOpenTag={openTag}
          onAddTag={(parentId) => setDialog({ kind: 'tag', tag: null, parentId })}
          onEditTag={(tag) => setDialog({ kind: 'tag', tag, parentId: tag.parentId })}
          onDeleteTag={(tag) => setDialog({ kind: 'delete-tag', tag })}
          hiddenSmartLists={settings?.hiddenSmartLists ?? []}
          smartCounts={smartCounts}
          currentSmartId={route.smartId ?? null}
          onOpenSmart={openSmart}
          onHideSmart={hideSmartList}
          filters={filters ?? []}
          currentFilterId={currentFilter?.id ?? null}
          onOpenFilter={openFilter}
          onAddFilter={() => setDialog({ kind: 'filter', filter: null })}
          onEditFilter={(filter) => setDialog({ kind: 'filter', filter })}
          onDeleteFilter={(filter) => setDialog({ kind: 'delete-filter', filter })}
          onOpenSearch={() => openSearch()}
          onOpenCalendar={() => openCalendar()}
          onOpenMatrix={openMatrix}
          onOpenFocus={openFocus}
        />
      )}
      {route.trash && (
        <TrashPane
          tasks={trash}
          lists={sidebar?.lists ?? []}
          sidebarVisible={sidebarVisible}
          timeZone={timeZone}
          now={now}
          onToggleSidebar={() => (isMobile ? setDrawerOpen((v) => !v) : setSidebarOpen((v) => !v))}
          onRestore={(task) => void restoreTask(task)}
          onPurge={(task) => setDialog({ kind: 'purge-task', task })}
          onEmpty={() => setDialog({ kind: 'empty-trash' })}
        />
      )}
      {route.focus && (
        <FocusPane
          timer={focusTimer}
          pomodoro={settings?.pomodoro ?? DEFAULT_SETTINGS.pomodoro}
          timeZone={timeZone}
          isMobile={isMobile}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setDrawerOpen((v) => !v)}
          onSaveSettings={saveSettings}
          onError={fail}
        />
      )}
      {route.matrix && !(isMobile && selectedTask) && (
        <MatrixPane
          quadrants={settings?.matrixQuadrants ?? DEFAULT_QUADRANTS}
          tasks={listTasks}
          lists={sidebar?.lists ?? []}
          tags={tags ?? []}
          selectedTaskId={route.taskId}
          timeZone={timeZone}
          now={now}
          isMobile={isMobile}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setDrawerOpen((v) => !v)}
          onSelectTask={selectTask}
          onToggleTask={(task) => void changeTask(task, { status: task.status !== 'open' ? 'open' : 'completed' })}
          onChangeTask={(task, patch) => void changeTask(task, patch)}
          onDeleteTask={(task) => void deleteTask(task)}
          onMoveTask={moveMatrixTask}
          onAddTask={addMatrixTask}
          onEditQuadrant={(index) => setDialog({ kind: 'quadrant', index })}
          onResetQuadrant={(index) => {
            const quadrant = DEFAULT_QUADRANTS[index];
            if (quadrant) void saveQuadrant(index, quadrant);
          }}
        />
      )}
      {!route.trash && !route.calendar && !route.matrix && !route.focus && !(isMobile && selectedTask) && timeline && view && (
        <TimelinePane
          key={viewKey(view)}
          view={view}
          tasks={listTasks}
          viewOptions={viewOptions ?? { sortBy: 'custom', groupBy: 'none' }}
          onChangeViewOptions={changeViewOptions}
          tags={tags ?? []}
          lists={sidebar?.lists ?? []}
          selectedTaskId={route.taskId}
          sidebarVisible={sidebarVisible}
          timeZone={timeZone}
          now={now}
          onToggleSidebar={() => (isMobile ? setDrawerOpen((v) => !v) : setSidebarOpen((v) => !v))}
          onSelectTask={selectTask}
          onMoveTask={(task, dates) => void moveTask(task, dates)}
          onEditList={currentList && !currentList.isInbox ? () => setDialog({ kind: 'list', list: currentList, folderId: currentList.folderId }) : null}
        />
      )}
      {calendarMode && calendarAnchor && !(isMobile && selectedTask) && (
        <CalendarPane
          mode={calendarMode}
          anchor={calendarAnchor}
          today={today}
          tasks={listTasks}
          days={calendarInfo}
          lists={sidebar?.lists ?? []}
          timeZone={timeZone}
          now={now}
          selectedTaskId={route.taskId}
          isMobile={isMobile}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setDrawerOpen((v) => !v)}
          onNavigate={(mode, date) => openCalendar(mode, date)}
          onSelectTask={selectTask}
          onCreateTask={addCalendarTask}
          onMoveTask={moveCalendarTask}
        />
      )}
      {!route.trash && !route.calendar && !route.matrix && !route.focus && !(isMobile && selectedTask) && !timeline && (
        <TaskListPane
          // A new view starts with its sections expanded.
          key={view ? viewKey(view) : 'none'}
          view={view}
          tasks={view?.kind === 'search' && !view.query ? [] : listTasks}
          viewOptions={viewOptions ?? { sortBy: 'custom', groupBy: 'none' }}
          onChangeViewOptions={changeViewOptions}
          addTarget={addTarget?.name ?? null}
          searchMatches={tasks?.scope === currentScope ? tasks?.matches : undefined}
          onSearch={(q) => openSearch(q)}
          indentable={indentable}
          tags={tags ?? []}
          lists={sidebar?.lists ?? []}
          selectedTaskId={route.taskId}
          sidebarVisible={sidebarVisible}
          timeZone={timeZone}
          now={now}
          onToggleSidebar={() => (isMobile ? setDrawerOpen((v) => !v) : setSidebarOpen((v) => !v))}
          onAddTask={addTask}
          onSelectTask={selectTask}
          onToggleTask={(task) => changeTask(task, { status: task.status !== 'open' ? 'open' : 'completed' })}
          onIndent={indentTask}
          onChangeTask={(task, patch) => void changeTask(task, patch)}
          onDeleteTask={(task) => void deleteTask(task)}
          onArchiveList={currentList && !currentList.isInbox ? (archived) => void archiveList(currentList, archived) : null}
          onEditList={currentList && !currentList.isInbox ? () => setDialog({ kind: 'list', list: currentList, folderId: currentList.folderId }) : null}
          columns={view?.kind === 'list' ? listColumns : null}
          kanban={kanbanActions}
          multiSelectedIds={batchTasks.map((t) => t.id)}
          onMultiSelect={multiSelect}
          batch={batch}
          onBatchDelete={() => void runBatch({ op: 'delete' })}
          isMobile={isMobile}
          onMoveTask={(task, afterId) => void reorderTask(task, afterId)}
        />
      )}
      {batch && !isMobile && !route.trash && !route.calendar && !timeline && (
        <BatchPanel ctx={batch} onCancel={() => setMulti({ scope: null, ids: [] })} onDelete={() => void runBatch({ op: 'delete' })} />
      )}
      {pickingBatchDate && batch && (
        <BatchDateDialog
          initial={today}
          onCancel={() => setPickingBatchDate(false)}
          onSave={(date) => {
            setPickingBatchDate(false);
            void runBatch({ op: 'dates', dates: { allDay: true, startDate: null, dueDate: date } });
          }}
        />
      )}
      {showDetail && !batch && !(isMobile && route.trash) && (
        <TaskDetail
          key={selectedTask?.id ?? 'empty'}
          task={selectedTask}
          tasks={listTasks ?? []}
          lists={sidebar?.lists ?? []}
          tags={tags ?? []}
          userName={user.username}
          isMobile={isMobile}
          timeZone={timeZone}
          allDayReminderTime={settings?.allDayReminderTime ?? DEFAULT_ALL_DAY_REMINDER_TIME}
          channels={channels}
          now={now}
          onBack={() => selectTask(null)}
          onChange={changeTask}
          onSelectTask={selectTask}
          onAddSubtask={addSubtask}
          onIndent={indentTask}
          onDelete={(task) => void deleteTask(task)}
          indentable={indentable}
          onError={fail}
        />
      )}

      {/* 专注结束 is announced wherever the user is (the 提示音 plays too). */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {focusTimer.announcement}
      </p>

      <ReminderAlerts
        timeZone={timeZone}
        now={now}
        onCompleted={() => {
          void reloadTasks();
          void reloadSidebar();
        }}
        onError={fail}
      />

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" className="toast-close" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      )}

      {dialog.kind === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog({ kind: 'none' })} />}
      {dialog.kind === 'settings' && (
        <SettingsDialog
          user={user}
          initialTab={dialog.tab}
          settings={settings}
          onClose={() => {
            setDialog({ kind: 'none' });
            void reloadChannels();
          }}
          onLoggedOut={onLoggedOut}
          onSaveSettings={saveSettings}
        />
      )}
      {dialog.kind === 'list' && (
        <ListDialog
          list={dialog.list}
          defaultFolderId={dialog.folderId}
          folders={sidebar?.folders ?? []}
          onCancel={() => setDialog({ kind: 'none' })}
          onSave={(draft) => saveList(draft, dialog.list)}
        />
      )}
      {dialog.kind === 'folder' && (
        <FolderDialog
          folder={dialog.folder}
          onCancel={() => setDialog({ kind: 'none' })}
          onSave={(name) => saveFolder(name, dialog.folder)}
        />
      )}
      {dialog.kind === 'delete-list' && (
        <ConfirmDialog
          title="删除清单"
          message={`删除清单「${dialog.list.name}」后，其中的任务会移到回收站，${TRASH_RETENTION_DAYS} 天内可以还原（还原到收件箱）。`}
          confirmLabel="删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => removeList(dialog.list)}
        />
      )}
      {dialog.kind === 'delete-folder' && (
        <ConfirmDialog
          title="删除文件夹"
          message={`删除文件夹「${dialog.folder.name}」后，其中的清单会移到文件夹外，不会被删除。`}
          confirmLabel="删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => removeFolder(dialog.folder)}
        />
      )}
      {dialog.kind === 'purge-task' && (
        <ConfirmDialog
          title="彻底删除"
          message={`彻底删除「${dialog.task.title}」后无法恢复。`}
          confirmLabel="彻底删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => purgeTask(dialog.task)}
        />
      )}
      {dialog.kind === 'empty-trash' && (
        <ConfirmDialog
          title="清空回收站"
          message="回收站里的任务会被彻底删除，无法恢复。"
          confirmLabel="清空"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={emptyTrash}
        />
      )}
      {dialog.kind === 'tag' && (
        <TagDialog
          tag={dialog.tag}
          tags={tags ?? []}
          defaultParentId={dialog.parentId}
          onCancel={() => setDialog({ kind: 'none' })}
          onSave={(draft) => saveTag(draft, dialog.tag)}
        />
      )}
      {dialog.kind === 'filter' && (
        <FilterDialog
          filter={dialog.filter}
          lists={sidebar?.lists ?? []}
          tags={tags ?? []}
          onCancel={() => setDialog({ kind: 'none' })}
          onSave={(draft) => saveFilter(draft, dialog.filter)}
        />
      )}
      {dialog.kind === 'quadrant' && settings?.matrixQuadrants[dialog.index] && (
        <FilterDialog
          kind="quadrant"
          filter={settings.matrixQuadrants[dialog.index] ?? null}
          lists={sidebar?.lists ?? []}
          tags={tags ?? []}
          onCancel={() => setDialog({ kind: 'none' })}
          onSave={(draft) => saveQuadrant(dialog.index, draft)}
        />
      )}
      {dialog.kind === 'delete-filter' && (
        <ConfirmDialog
          title="删除过滤器"
          message={`删除过滤器「${dialog.filter.name}」后，其中的任务不受影响。`}
          confirmLabel="删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => removeFilter(dialog.filter)}
        />
      )}
      {dialog.kind === 'delete-column' && (
        <DeleteColumnDialog
          columnName={dialog.column.name}
          taskCount={dialog.taskCount}
          targets={[
            ...(listColumns ?? []).filter((c) => c.id !== dialog.column.id).map((c) => ({ id: c.id, name: c.name })),
            { id: null, name: UNGROUPED_COLUMN_TITLE },
          ]}
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={(choice) => removeColumn(dialog.column, choice)}
        />
      )}
      {dialog.kind === 'delete-tag' && (
        <ConfirmDialog
          title="删除标签"
          message={`删除标签「${dialog.tag.name}」后，任务上的这个标签会被移除，任务本身不受影响。${
            (tags ?? []).some((t) => t.parentId === dialog.tag.id) ? '它的子标签会移到顶层。' : ''
          }`}
          confirmLabel="删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => removeTag(dialog.tag)}
        />
      )}
    </div>
  );
}

/** Same order as the server: open by sort key, then closed (完成 / 放弃), most recently closed first. */
function sortTasks(items: Task[]): Task[] {
  const closedAt = (t: Task) => t.completedAt ?? t.abandonedAt ?? '';
  return [...items].sort((a, b) => {
    const doneA = a.status !== 'open';
    const doneB = b.status !== 'open';
    if (doneA !== doneB) return doneA ? 1 : -1;
    if (doneA) return closedAt(b).localeCompare(closedAt(a));
    return a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.id < b.id ? -1 : 1;
  });
}
