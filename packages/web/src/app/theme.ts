import {
  DEFAULT_THEME_COLOR,
  DEFAULT_THEME_MODE,
  resolveThemeMode,
  themeColorSchema,
  themeModeSchema,
  type ThemeColor,
  type ThemeMode,
} from '@dida/shared';
import { useEffect } from 'react';

/**
 * 主题 (spec 用户故事 104): puts the mode and 颜色系列 on `<html>` as
 * `data-theme` / `data-theme-color`; design/tokens.css does the rest.
 * The last theme is cached in localStorage so the next page load (and the
 * login page) paints in it before 设置 arrive.
 */

const DARK_QUERY = '(prefers-color-scheme: dark)';
const STORAGE_KEY = 'dida-theme';

export interface Theme {
  mode: ThemeMode;
  color: ThemeColor;
}

function apply({ mode, color }: Theme) {
  const root = document.documentElement;
  root.dataset.theme = resolveThemeMode(mode, window.matchMedia(DARK_QUERY).matches);
  root.dataset.themeColor = color;
  // Browser UI (mobile address bar, PWA title bar) follows the rail colour.
  const accent = getComputedStyle(root).getPropertyValue('--accent-rail-top').trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && accent) meta.content = accent;
}

function readCache(): Theme {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { mode?: unknown; color?: unknown } | null;
    return {
      mode: themeModeSchema.catch(DEFAULT_THEME_MODE).parse(raw?.mode),
      color: themeColorSchema.catch(DEFAULT_THEME_COLOR).parse(raw?.color),
    };
  } catch {
    return { mode: DEFAULT_THEME_MODE, color: DEFAULT_THEME_COLOR };
  }
}

function writeCache(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Private mode or storage full: the theme still applies, only the next first paint is default.
  }
}

/** Apply the cached theme; call once before the first render. */
export function restoreCachedTheme() {
  apply(readCache());
}

/** Keep `<html>` on `theme` (null: settings not loaded yet — keep the cached one), following the OS for 跟随系统. */
export function useTheme(theme: Theme | null) {
  const mode = theme?.mode;
  const color = theme?.color;
  useEffect(() => {
    if (!mode || !color) return;
    const current = { mode, color };
    apply(current);
    writeCache(current);
    if (mode !== 'system') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => apply(current);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode, color]);
}
