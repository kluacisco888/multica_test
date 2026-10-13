import {
  addDays,
  defaultViewOptions,
  listInSmartLists,
  matchesFilter,
  matchesSmartList,
  SMART_LIST_NAMES,
  tagWithChildren,
  todayIn,
  type CreateTaskRequest,
  type Filter,
  type SmartListId,
  type Tag,
  type Task,
  type TaskList,
  type TasksQuery,
  type ViewClock,
  type ViewOptions,
} from '@dida/shared';

/*
 * The task views of the middle column: one 清单, one 标签, a 智能清单, a
 * 过滤器 or the 搜索 results. Everything the shell needs to know per view
 * lives here, so adding a view kind touches one switch per question.
 */

export type ListPaneView =
  | { kind: 'list'; list: TaskList }
  | { kind: 'tag'; tag: Tag; inbox: TaskList | null }
  | { kind: 'smart'; id: SmartListId; inbox: TaskList | null }
  | { kind: 'filter'; filter: Filter; inbox: TaskList | null }
  | { kind: 'search'; query: string };

/** Key of the view in 设置 → `viewOptions` and of the task set on screen. */
export function viewKey(view: ListPaneView): string {
  switch (view.kind) {
    case 'list':
      return `list:${view.list.id}`;
    case 'tag':
      return `tag:${view.tag.id}`;
    case 'smart':
      return `smart:${view.id}`;
    case 'filter':
      return `filter:${view.filter.id}`;
    case 'search':
      return 'search';
  }
}

/** Key of the fetched task set: like `viewKey`, but each search query is its own set. */
export function scopeKey(view: ListPaneView): string {
  return view.kind === 'search' ? `search:${view.query}` : viewKey(view);
}

export function viewTitle(view: ListPaneView): string {
  switch (view.kind) {
    case 'list':
      return view.list.name;
    case 'tag':
      return view.tag.name;
    case 'smart':
      return SMART_LIST_NAMES[view.id];
    case 'filter':
      return view.filter.name;
    case 'search':
      return '搜索';
  }
}

/** `GET /api/tasks` query of the view; null for 搜索 (it has its own endpoint). */
export function tasksQuery(view: ListPaneView): TasksQuery | null {
  switch (view.kind) {
    case 'list':
      return { listId: view.list.id };
    case 'tag':
      return { tagId: view.tag.id };
    case 'smart':
      return { smart: view.id };
    case 'filter':
      return { filterId: view.filter.id };
    case 'search':
      return null;
  }
}

export function viewOptionsFor(view: ListPaneView, saved: Record<string, ViewOptions> | undefined): ViewOptions {
  const key = viewKey(view);
  return saved?.[key] ?? defaultViewOptions(key);
}

/**
 * Quick add in this view: the 清单 shown in the placeholder and what a new
 * task gets so that it shows up here. Null: no quick add (搜索, 已完成).
 */
export function quickAddTarget(view: ListPaneView, clock: ViewClock): { name: string; request: Omit<CreateTaskRequest, 'title'> } | null {
  switch (view.kind) {
    case 'list':
      return { name: view.list.name, request: { listId: view.list.id } };
    case 'tag':
      return view.inbox ? { name: view.inbox.name, request: { tagIds: [view.tag.id] } } : null;
    case 'smart': {
      if (!view.inbox || view.id === 'completed') return null;
      const today = todayIn(clock.now, clock.timeZone);
      const dueDate = view.id === 'tomorrow' ? addDays(today, 1) : today;
      const request: Omit<CreateTaskRequest, 'title'> =
        view.id === 'notImportant' ? { priority: 'low' } : { dates: { allDay: true, startDate: null, dueDate } };
      return { name: view.inbox.name, request };
    }
    case 'filter':
      return view.inbox ? { name: view.inbox.name, request: {} } : null;
    case 'search':
      return null;
  }
}

/**
 * Does `task` (as just changed on screen) still belong to the view? Uses the
 * same rules as the server, so an edit moves the row in or out right away.
 */
export function belongsToView(
  view: ListPaneView,
  task: Task,
  context: ViewClock & { lists: readonly TaskList[]; tags: readonly Tag[] },
): boolean {
  switch (view.kind) {
    case 'list':
      return task.listId === view.list.id;
    case 'tag': {
      const ids = tagWithChildren(context.tags, view.tag.id);
      return task.tagIds.some((id) => ids.includes(id));
    }
    case 'smart': {
      const list = context.lists.find((l) => l.id === task.listId);
      return list !== undefined && listInSmartLists(list) && matchesSmartList(view.id, task, context);
    }
    case 'filter': {
      const scope = new Set(view.filter.rules.tagIds.flatMap((id) => tagWithChildren(context.tags, id)));
      return matchesFilter(view.filter.rules, task, context, scope);
    }
    case 'search':
      // Results stay put while edited; the next search re-reads them.
      return true;
  }
}
