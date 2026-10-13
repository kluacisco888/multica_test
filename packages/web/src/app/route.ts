import { useCallback, useEffect, useState } from 'react';

/*
 * Client-side routes (the server falls back to index.html for them):
 *   /                              → 收件箱
 *   /lists/<listId>                → a 清单
 *   /lists/<listId>/tasks/<taskId> → a 清单 with a 任务 open in the detail pane
 */

export interface Route {
  listId: string | null;
  taskId: string | null;
}

export function parseRoute(pathname: string): Route {
  const match = /^\/lists\/([^/]+)(?:\/tasks\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return { listId: null, taskId: null };
  return { listId: decodeURIComponent(match[1] as string), taskId: match[2] ? decodeURIComponent(match[2]) : null };
}

export function routePath({ listId, taskId }: Route): string {
  if (!listId) return '/';
  const list = `/lists/${encodeURIComponent(listId)}`;
  return taskId ? `${list}/tasks/${encodeURIComponent(taskId)}` : list;
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
    setRoute(next);
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
