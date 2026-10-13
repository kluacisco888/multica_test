import {
  DEFAULT_TIME_ZONE,
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
  FilterDialog,
  FolderDialog,
  ListDialog,
  TagDialog,
  type FilterDraft,
  type ListDraft,
  type TagDraft,
} from './dialogs.js';
import { Rail } from './Rail.js';
import { SettingsDialog, type SettingsTab } from './SettingsDialog.js';
import { MOBILE_QUERY, useMediaQuery, useRoute } from './route.js';
import { activeSidebar, Sidebar } from './Sidebar.js';
import { TaskDetail } from './TaskDetail.js';
import { TaskListPane } from './TaskListPane.js';
import { TrashPane } from './TrashPane.js';
import { belongsToView, quickAddTarget, scopeKey, tasksQuery, viewOptionsFor, viewKey, type ListPaneView } from './views.js';

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
  | { kind: 'delete-filter'; filter: Filter };

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
  /** The 回收站 while it is on screen. */
  const [trash, setTrash] = useState<TrashedTask[] | null>(null);
  const now = useNow();

  const fail = useCallback((e: unknown) => {
    console.error(e);
    setError(api.errorMessage(e));
  }, []);

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

  async function saveSettings(patch: UpdateSettingsRequest) {
    try {
      setSettings(await api.updateSettings(patch));
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  const inbox = sidebar?.lists.find((l) => l.isInbox) ?? null;
  const currentTag = route.tagId ? (tags?.find((t) => t.id === route.tagId) ?? null) : null;
  const currentFilter = route.filterId ? (filters?.find((f) => f.id === route.filterId) ?? null) : null;
  const crossListRoute = Boolean(route.trash || route.tagId || route.smartId || route.filterId || (route.search !== null && route.search !== undefined));
  const currentList = useMemo(() => {
    if (!sidebar || crossListRoute) return null;
    return (route.listId ? sidebar.lists.find((l) => l.id === route.listId) : inbox) ?? null;
  }, [sidebar, route.listId, crossListRoute, inbox]);
  const view: ListPaneView | null = useMemo(() => {
    if (route.trash) return null;
    if (route.search !== null && route.search !== undefined) return { kind: 'search', query: route.search };
    if (route.smartId) return sidebar ? { kind: 'smart', id: route.smartId, inbox } : null;
    if (currentFilter) return { kind: 'filter', filter: currentFilter, inbox };
    if (currentTag) return { kind: 'tag', tag: currentTag, inbox };
    return currentList ? { kind: 'list', list: currentList } : null;
  }, [route.trash, route.search, route.smartId, sidebar, currentFilter, currentTag, currentList, inbox]);

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
  const timeZone = settings?.timeZone ?? DEFAULT_TIME_ZONE;
  const selectedTask = listTasks?.find((t) => t.id === route.taskId) ?? null;
  const viewOptions = view ? viewOptionsFor(view, settings?.viewOptions) : null;
  // Tab / Shift+Tab only make sense in a 清单 shown in its own order.
  const indentable = view?.kind === 'list' && viewOptions?.sortBy === 'custom' && viewOptions.groupBy === 'none';
  const addTarget = view ? quickAddTarget(view, { now, timeZone }) : null;

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
    navigate({ ...route, taskId });
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
      await reloadSidebar();
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
      await reloadTags();
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

  const showDetail = !isMobile || selectedTask !== null;
  const sidebarVisible = isMobile ? drawerOpen : sidebarOpen;

  return (
    <div className={`shell ${sidebarVisible ? 'shell-sidebar-open' : 'shell-sidebar-closed'} ${selectedTask ? 'shell-has-task' : ''}`}>
      {!isMobile && (
        <Rail
          user={user}
          onOpenAccount={() => setDialog({ kind: 'settings', tab: 'account' })}
          onOpenSettings={() => setDialog({ kind: 'settings', tab: 'notifications' })}
          onHome={() => navigate({ listId: null, taskId: null })}
          onSearch={() => openSearch()}
          searchActive={view?.kind === 'search'}
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
      {!route.trash && !(isMobile && selectedTask) && (
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
        />
      )}
      {showDetail && !(isMobile && route.trash) && (
        <TaskDetail
          key={selectedTask?.id ?? 'empty'}
          task={selectedTask}
          tasks={listTasks ?? []}
          lists={sidebar?.lists ?? []}
          tags={tags ?? []}
          userName={user.username}
          isMobile={isMobile}
          timeZone={timeZone}
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

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" className="toast-close" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      )}

      {dialog.kind === 'settings' && (
        <SettingsDialog
          user={user}
          initialTab={dialog.tab}
          settings={settings}
          onClose={() => setDialog({ kind: 'none' })}
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
      {dialog.kind === 'delete-filter' && (
        <ConfirmDialog
          title="删除过滤器"
          message={`删除过滤器「${dialog.filter.name}」后，其中的任务不受影响。`}
          confirmLabel="删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => removeFilter(dialog.filter)}
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
