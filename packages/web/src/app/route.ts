import { useCallback, useEffect, useState } from 'react';

/*
 * Client-side routes (the server falls back to index.html for them):
 *   /                              → 收件箱
 *   /lists/<listId>                → a 清单
 *   /lists/<listId>/tasks/<taskId> → a 清单 with a 任务 open in the detail pane
 *   /tags/<tagId>                  → a 标签 (a parent 标签 includes its children)
 *   /tags/<tagId>/tasks/<taskId>   → a 标签 with a 任务 open
 */

export interface Route {
  listId: string | null;
  tagId?: string | null;
  taskId: string | null;
}

export function parseRoute(pathname: string): Route {
  const match = /^\/(lists|tags)\/([^/]+)(?:\/tasks\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return { listId: null, tagId: null, taskId: null };
  const id = decodeURIComponent(match[2] as string);
  const taskId = match[3] ? decodeURIComponent(match[3]) : null;
  return match[1] === 'tags' ? { listId: null, tagId: id, taskId } : { listId: id, tagId: null, taskId };
}

export function routePath({ listId, tagId, taskId }: Route): string {
  let base: string;
  if (tagId) base = `/tags/${encodeURIComponent(tagId)}`;
  else if (listId) base = `/lists/${encodeURIComponent(listId)}`;
  else return '/';
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
    setRoute({ tagId: null, ...next });
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
