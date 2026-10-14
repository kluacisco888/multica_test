import { calendarDateSchema, calendarModeSchema, smartListIdSchema, type CalendarMode, type SmartListId } from '@dida/shared';
import { useCallback, useEffect, useState } from 'react';

/*
 * Client-side routes (the server falls back to index.html for them):
 *   /                              → 收件箱
 *   /lists/<listId>                → a 清单
 *   /lists/<listId>/tasks/<taskId> → a 清单 with a 任务 open in the detail pane
 *   /tags/<tagId>                  → a 标签 (a parent 标签 includes its children)
 *   /tags/<tagId>/tasks/<taskId>   → a 标签 with a 任务 open
 *   /smart/<id>                    → a 智能清单 (today, tomorrow, week, completed, notImportant)
 *   /filters/<filterId>            → a 过滤器
 *   /search/<query>                → 全局搜索 results (`/search` alone: the empty search box)
 *   /trash                         → the 回收站
 *   /calendar                      → 日历 (last used view, today)
 *   /calendar/<mode>/<YYYY-MM-DD>  → 日历 in 月 / 周 / 日 / 多日 (`month` / `week` / `day` / `multiDay`) around a date
 *   /matrix                        → 四象限
 *   /focus                         → 番茄专注
 *   /countdowns                    → 倒数日 (记录中); /countdowns/archived → 已归档
 * Each but /trash, /focus and /countdowns takes `/tasks/<taskId>` for an open 任务.
 */

/** 日历 route: null mode / date mean "last used view" / "today". */
export interface CalendarRoute {
  mode: CalendarMode | null;
  date: string | null;
}

export interface Route {
  listId: string | null;
  tagId?: string | null;
  smartId?: SmartListId | null;
  filterId?: string | null;
  /** Non-null: the search view; '' is the empty search box. */
  search?: string | null;
  taskId: string | null;
  /** The 回收站 smart list. */
  trash?: boolean;
  /** Non-null: the 日历. */
  calendar?: CalendarRoute | null;
  /** The 四象限. */
  matrix?: boolean;
  /** 番茄专注. */
  focus?: boolean;
  /** Non-null: the 倒数日 page, showing 记录中 or 已归档 ones. */
  countdowns?: 'active' | 'archived' | null;
}

const EMPTY: Required<Route> = { listId: null, tagId: null, smartId: null, filterId: null, search: null, taskId: null, trash: false, calendar: null, matrix: false, focus: false, countdowns: null };

export function parseRoute(pathname: string): Route {
  if (/^\/trash\/?$/.test(pathname)) return { ...EMPTY, trash: true };
  if (/^\/search\/?$/.test(pathname)) return { ...EMPTY, search: '' };
  const matrix = /^\/matrix(?:\/tasks\/([^/]+))?\/?$/.exec(pathname);
  if (matrix) return { ...EMPTY, matrix: true, taskId: matrix[1] ? safeDecode(matrix[1]) : null };
  if (/^\/focus\/?$/.test(pathname)) return { ...EMPTY, focus: true };
  const countdowns = /^\/countdowns(\/archived)?\/?$/.exec(pathname);
  if (countdowns) return { ...EMPTY, countdowns: countdowns[1] ? 'archived' : 'active' };
  const calendar = /^\/calendar(?:\/([^/]+)\/([^/]+))?(?:\/tasks\/([^/]+))?\/?$/.exec(pathname);
  if (calendar) {
    const mode = calendarModeSchema.safeParse(calendar[1]);
    const date = calendarDateSchema.safeParse(calendar[2]);
    const taskId = calendar[3] ? safeDecode(calendar[3]) : null;
    return mode.success && date.success
      ? { ...EMPTY, calendar: { mode: mode.data, date: date.data }, taskId }
      : { ...EMPTY, calendar: { mode: null, date: null }, taskId: calendar[1] ? null : taskId };
  }
  const match = /^\/(lists|tags|smart|filters|search)\/([^/]+)(?:\/tasks\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return { ...EMPTY };
  let id: string;
  try {
    id = decodeURIComponent(match[2] as string);
  } catch {
    return { ...EMPTY };
  }
  const taskId = match[3] ? decodeURIComponent(match[3]) : null;
  switch (match[1]) {
    case 'tags':
      return { ...EMPTY, tagId: id, taskId };
    case 'smart': {
      const smart = smartListIdSchema.safeParse(id);
      return smart.success ? { ...EMPTY, smartId: smart.data, taskId } : { ...EMPTY };
    }
    case 'filters':
      return { ...EMPTY, filterId: id, taskId };
    case 'search':
      return { ...EMPTY, search: id, taskId };
    default:
      return { ...EMPTY, listId: id, taskId };
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function routePath({ listId, tagId, smartId, filterId, search, taskId, trash, calendar, matrix, focus, countdowns }: Route): string {
  if (trash) return '/trash';
  if (focus) return '/focus';
  if (countdowns) return countdowns === 'archived' ? '/countdowns/archived' : '/countdowns';
  let base: string;
  if (matrix) base = '/matrix';
  else if (calendar) base = calendar.mode && calendar.date ? `/calendar/${calendar.mode}/${calendar.date}` : '/calendar';
  else if (search !== null && search !== undefined) base = search ? `/search/${encodeURIComponent(search)}` : '/search';
  else if (smartId) base = `/smart/${smartId}`;
  else if (filterId) base = `/filters/${encodeURIComponent(filterId)}`;
  else if (tagId) base = `/tags/${encodeURIComponent(tagId)}`;
  else if (listId) base = `/lists/${encodeURIComponent(listId)}`;
  else return '/';
  // The empty search box cannot hold an open task.
  if (base === '/search') return base;
  return taskId ? `${base}/tasks/${encodeURIComponent(taskId)}` : base;
}

export function useRoute(): [Route, (next: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const path = routePath(next);
    if (path !== window.location.pathname) {
      if (options?.replace) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    setRoute({ ...EMPTY, ...next });
  }, []);

  return [route, navigate];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Mobile layout breakpoint (also used in CSS: max-width 767px). */
export const MOBILE_QUERY = '(max-width: 767px)';
