import {
  planSidebarDrop,
  type CurrentUser,
  type DropPosition,
  type Folder,
  type SidebarItemRef,
  type SidebarResponse,
  type Task,
  type TaskList,
  type UpdateTaskRequest,
} from '@dida/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { AccountDialog } from './AccountDialog.js';
import { ConfirmDialog, FolderDialog, ListDialog, type ListDraft } from './dialogs.js';
import { Rail } from './Rail.js';
import { MOBILE_QUERY, useMediaQuery, useRoute } from './route.js';
import { Sidebar } from './Sidebar.js';
import { TaskDetail } from './TaskDetail.js';
import { TaskListPane } from './TaskListPane.js';

type DialogState =
  | { kind: 'none' }
  | { kind: 'account' }
  | { kind: 'list'; list: TaskList | null; folderId: string | null }
  | { kind: 'folder'; folder: Folder | null }
  | { kind: 'delete-list'; list: TaskList }
  | { kind: 'delete-folder'; folder: Folder };

/**
 * The application shell (spec 用户故事 65): rail | sidebar | task list | task
 * detail on desktop; on mobile the sidebar is a drawer and the detail a full
 * screen page. Owns the sidebar and current-list data.
 */
export function AppShell({ user, onLoggedOut }: { user: CurrentUser; onLoggedOut: () => void }) {
  const [route, navigate] = useRoute();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [sidebar, setSidebar] = useState<SidebarResponse | null>(null);
  const [tasks, setTasks] = useState<{ listId: string; items: Task[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });

  const fail = useCallback((e: unknown) => {
    console.error(e);
    setError(api.errorMessage(e));
  }, []);

  const reloadSidebar = useCallback(async () => {
    try {
      setSidebar(await api.fetchSidebar());
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchSidebar()
      .then((data) => {
        if (!cancelled) setSidebar(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [fail]);

  const inbox = sidebar?.lists.find((l) => l.isInbox) ?? null;
  const currentList = useMemo(() => {
    if (!sidebar) return null;
    return (route.listId ? sidebar.lists.find((l) => l.id === route.listId) : inbox) ?? null;
  }, [sidebar, route.listId, inbox]);

  // An unknown or deleted 清单 in the URL falls back to the 收件箱.
  useEffect(() => {
    if (sidebar && route.listId && !sidebar.lists.some((l) => l.id === route.listId)) {
      navigate({ listId: null, taskId: null }, { replace: true });
    }
  }, [sidebar, route.listId, navigate]);

  const currentListId = currentList?.id ?? null;
  useEffect(() => {
    if (!currentListId) return;
    let cancelled = false;
    api
      .fetchTasks(currentListId)
      .then((items) => {
        if (!cancelled) setTasks({ listId: currentListId, items });
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [currentListId, fail]);

  const listTasks = tasks && tasks.listId === currentListId ? tasks.items : null;
  const selectedTask = listTasks?.find((t) => t.id === route.taskId) ?? null;

  function openList(listId: string) {
    navigate({ listId: listId === inbox?.id ? null : listId, taskId: null });
    setDrawerOpen(false);
  }

  function selectTask(taskId: string | null) {
    navigate({ listId: route.listId, taskId });
  }

  /** Replace a task in the current list (or drop it when it left the list). */
  function putTask(task: Task) {
    setTasks((prev) => {
      if (!prev) return prev;
      const others = prev.items.filter((t) => t.id !== task.id);
      const items = task.listId === prev.listId ? sortTasks([...others, task]) : others;
      return { ...prev, items };
    });
  }

  async function addTask(title: string) {
    if (!currentList) return false;
    try {
      const task = await api.createTask({ listId: currentList.id, title });
      putTask(task);
      void reloadSidebar();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  async function changeTask(task: Task, patch: UpdateTaskRequest) {
    try {
      const updated = await api.updateTask(task.id, patch);
      putTask(updated);
      if (patch.status !== undefined || patch.listId !== undefined) void reloadSidebar();
      if (updated.listId !== currentList?.id && route.taskId === task.id) selectTask(null);
      return updated;
    } catch (e) {
      fail(e);
      return null;
    }
  }

  async function saveList(draft: ListDraft, existing: TaskList | null) {
    try {
      if (existing) {
        await api.updateList(existing.id, draft);
        await reloadSidebar();
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
    const plan = planSidebarDrop(sidebar, dragged, target, position);
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
      {!isMobile && <Rail user={user} onOpenAccount={() => setDialog({ kind: 'account' })} onHome={() => navigate({ listId: null, taskId: null })} />}
      {isMobile && drawerOpen && <div className="shell-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
      {sidebarVisible && (
        <Sidebar
          sidebar={sidebar}
          currentListId={currentList?.id ?? null}
          isDrawer={isMobile}
          user={user}
          onOpenAccount={() => setDialog({ kind: 'account' })}
          onClose={() => setDrawerOpen(false)}
          onOpenList={openList}
          onAddList={(folderId) => setDialog({ kind: 'list', list: null, folderId })}
          onAddFolder={() => setDialog({ kind: 'folder', folder: null })}
          onEditList={(list) => setDialog({ kind: 'list', list, folderId: list.folderId })}
          onDeleteList={(list) => setDialog({ kind: 'delete-list', list })}
          onRenameFolder={(folder) => setDialog({ kind: 'folder', folder })}
          onDeleteFolder={(folder) => setDialog({ kind: 'delete-folder', folder })}
          onToggleFolder={toggleFolder}
          onMove={moveSidebarItem}
        />
      )}
      {!(isMobile && selectedTask) && (
        <TaskListPane
          list={currentList}
          tasks={listTasks}
          selectedTaskId={route.taskId}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => (isMobile ? setDrawerOpen((v) => !v) : setSidebarOpen((v) => !v))}
          onAddTask={addTask}
          onSelectTask={selectTask}
          onToggleTask={(task) => changeTask(task, { status: task.status === 'completed' ? 'open' : 'completed' })}
          onEditList={currentList && !currentList.isInbox ? () => setDialog({ kind: 'list', list: currentList, folderId: currentList.folderId }) : null}
        />
      )}
      {showDetail && (
        <TaskDetail
          key={selectedTask?.id ?? 'empty'}
          task={selectedTask}
          lists={sidebar?.lists ?? []}
          isMobile={isMobile}
          onBack={() => selectTask(null)}
          onChange={changeTask}
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

      {dialog.kind === 'account' && <AccountDialog user={user} onClose={() => setDialog({ kind: 'none' })} onLoggedOut={onLoggedOut} />}
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
          message={`删除清单「${dialog.list.name}」后，其中的任务也会一起删除。`}
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
    </div>
  );
}

/** Same order as the server: open by sort key, then completed, newest completion first. */
function sortTasks(items: Task[]): Task[] {
  return [...items].sort((a, b) => {
    const doneA = a.status === 'completed';
    const doneB = b.status === 'completed';
    if (doneA !== doneB) return doneA ? 1 : -1;
    if (doneA) return (b.completedAt ?? '').localeCompare(a.completedAt ?? '');
    return a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.id < b.id ? -1 : 1;
  });
}
