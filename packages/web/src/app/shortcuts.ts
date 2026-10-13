import type { Priority } from '@dida/shared';

/**
 * 快捷键 (spec 用户故事 105–106): the fixed list (not customisable) shown in
 * the `?` panel and 设置 →「快捷键」, and the matcher for the global ones.
 * Tab / Shift+Tab and Enter belong to the focused row / input and are handled
 * there (TaskListPane); they are listed here so the panel is complete.
 */

export type ShortcutAction =
  | { kind: 'search' }
  | { kind: 'help' }
  | { kind: 'addTask' }
  | { kind: 'priority'; priority: Priority };

export interface ShortcutItem {
  label: string;
  /** Each key combination as shown, e.g. ['Ctrl', 'K']. */
  keys: string[];
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '通用',
    items: [
      { label: '搜索', keys: ['Ctrl', 'K'] },
      { label: '快捷键', keys: ['?'] },
      { label: '取消', keys: ['Esc'] },
    ],
  },
  {
    title: '任务',
    items: [
      { label: '添加任务', keys: ['N'] },
      { label: '保存并继续添加', keys: ['Enter'] },
      { label: '缩进为子任务', keys: ['Tab'] },
      { label: '取消缩进', keys: ['Shift', 'Tab'] },
      { label: '设为高优先级', keys: ['1'] },
      { label: '设为中优先级', keys: ['2'] },
      { label: '设为低优先级', keys: ['3'] },
      { label: '设为无优先级', keys: ['0'] },
    ],
  },
];

const PRIORITY_KEYS: Record<string, Priority> = { '1': 'high', '2': 'medium', '3': 'low', '0': 'none' };

/** Is the user typing here? Then single-key shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(target.type);
  }
  return target.closest('[role="textbox"], [role="combobox"], [role="searchbox"]') !== null;
}

/** Inside a dialog, menu or popover the keys belong to it (arrows, digits in the date picker …). */
function inWidget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('dialog, [role="dialog"], [role="menu"], [role="listbox"], [role="grid"]') !== null;
}

/** The global shortcut for a keydown on the document, or null. */
export function matchShortcut(event: KeyboardEvent): ShortcutAction | null {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  // A modal dialog (设置, a confirmation, this panel) owns the keyboard.
  if (document.querySelector('dialog[open]')) return null;
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;

  // Ctrl+K (⌘K on macOS) works from anywhere, inputs included — it is no character.
  if ((ctrlKey || metaKey) && !altKey && !shiftKey && key.toLowerCase() === 'k') return { kind: 'search' };

  if (ctrlKey || metaKey || altKey) return null;
  if (isTypingTarget(event.target) || inWidget(event.target)) return null;

  if (key === '?') return { kind: 'help' };
  if (shiftKey) return null;
  if (key === 'n' || key === 'N') return { kind: 'addTask' };
  const priority = PRIORITY_KEYS[key];
  if (priority) return { kind: 'priority', priority };
  return null;
}
