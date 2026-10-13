import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, updateSettingsRequestSchema } from './settings.js';
import { resolveThemeMode, THEME_COLORS } from './theme.js';

describe('主题', () => {
  it('跟随系统 follows the OS preference; 浅色 / 深色 ignore it', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
  });

  it('offers about 8 颜色系列, 晴蓝 first and by default', () => {
    expect(THEME_COLORS).toHaveLength(8);
    expect(THEME_COLORS[0]).toBe('blue');
    expect(DEFAULT_SETTINGS).toMatchObject({ themeMode: 'light', themeColor: 'blue' });
  });

  it('accepts only known modes and colours in a settings patch', () => {
    expect(updateSettingsRequestSchema.safeParse({ themeMode: 'system', themeColor: 'lavender' }).success).toBe(true);
    expect(updateSettingsRequestSchema.safeParse({ themeMode: 'auto' }).success).toBe(false);
    expect(updateSettingsRequestSchema.safeParse({ themeColor: '#ff0000' }).success).toBe(false);
  });
});
