import { z } from 'zod';

/**
 * 主题 (spec 用户故事 104): a mode (浅色 / 深色 / 跟随系统) and one of the
 * 颜色系列 from the reference's 设置 → 外观 (ADR-0007 screenshot). The
 * colours themselves live in the web package's design tokens; here are only
 * the ids, their names and the order they are shown in.
 */

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export const themeModeSchema = z.enum(THEME_MODES);
export type ThemeMode = z.infer<typeof themeModeSchema>;

export const THEME_MODE_LABELS: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' };

/** 颜色系列, in the reference's order. 晴蓝 is the default (the reference's brand blue). */
export const THEME_COLORS = ['blue', 'turquoise', 'cyan', 'reed', 'apricot', 'peach', 'lavender', 'agarwood'] as const;
export const themeColorSchema = z.enum(THEME_COLORS);
export type ThemeColor = z.infer<typeof themeColorSchema>;

export const THEME_COLOR_LABELS: Record<ThemeColor, string> = {
  blue: '晴蓝',
  turquoise: '松石',
  cyan: '秘青',
  reed: '蒹葭',
  apricot: '杏黄',
  peach: '桃夭',
  lavender: '暮山紫',
  agarwood: '沉香',
};

export const DEFAULT_THEME_MODE: ThemeMode = 'light';
export const DEFAULT_THEME_COLOR: ThemeColor = 'blue';

/** The mode actually shown: 跟随系统 follows the OS dark-mode preference. */
export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}
