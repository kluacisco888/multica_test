import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Priority } from '@dida/shared';
import { Icon, type IconName } from './Icon.js';

/*
 * Shared UI primitives. Conventions (see ./README.md):
 *   - every control is a native element (button, input, dialog) so keyboard
 *     and screen readers work without extra code;
 *   - icon-only controls take a required `label` (their accessible name);
 *   - styling goes through `ui-*` classes in ui.css, which read design tokens.
 */

export function Button({
  variant = 'default',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return <button type="button" className={`ui-button ui-button-${variant} ${className ?? ''}`} {...rest} />;
}

export function IconButton({
  icon,
  label,
  size = 18,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & { icon: IconName; label: string; size?: number }) {
  return (
    <button type="button" className={`ui-icon-button ${className ?? ''}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/**
 * Square task checkbox (spec 完成 / 取消完成). `label` names the task; the
 * outline takes the 优先级 colour like the reference.
 */
export function TaskCheckbox({
  checked,
  label,
  priority = 'none',
  onChange,
}: {
  checked: boolean;
  label: string;
  priority?: Priority;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={`ui-task-checkbox ui-priority-${priority}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      {checked && <Icon name="check" size={12} strokeWidth={2.5} />}
    </button>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Marks the current choice (menuitemradio, or menuitemcheckbox in a `multiple` menu). */
  checked?: boolean;
  /** Extra class on the item, e.g. a 优先级 colour for its icon. */
  className?: string;
}

/** Shared ↑/↓ (and ←/→ for item rows), Home/End, Esc and Tab handling of a menu. */
function menuKeyDown(event: KeyboardEvent<HTMLElement>, menu: HTMLElement | null, close: (focusOpener: boolean) => void) {
  const entries = [...(menu?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])];
  const index = entries.indexOf(document.activeElement as HTMLButtonElement);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  if (step !== undefined) {
    event.preventDefault();
    entries[(index + step + entries.length) % entries.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    (event.key === 'Home' ? entries[0] : entries.at(-1))?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === 'Tab') {
    close(false);
  }
}

function itemRole(item: MenuItem, multiple: boolean): 'menuitem' | 'menuitemradio' | 'menuitemcheckbox' {
  if (item.checked === undefined) return 'menuitem';
  return multiple ? 'menuitemcheckbox' : 'menuitemradio';
}

/**
 * A button that opens a menu (WAI-ARIA menu button): Enter/Space/↓ open it,
 * ↑/↓ move, Esc closes and returns focus, Tab closes.
 */
export function MenuButton({
  label,
  icon = 'more',
  items,
  children,
  className,
  triggerClassName,
  align = 'end',
  multiple = false,
}: {
  label: string;
  icon?: IconName;
  items: MenuItem[];
  /** Visible content; omitted means an icon-only button. */
  children?: ReactNode;
  className?: string;
  triggerClassName?: string;
  align?: 'start' | 'end';
  /** Items with `checked` are independent checkboxes instead of one radio group. */
  multiple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not([disabled])');
    first?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function close(focusButton: boolean) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    menuKeyDown(event, menuRef.current, (focus) => (focus ? close(true) : setOpen(false)));
  }

  return (
    <div className={`ui-menu-anchor ${className ?? ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className={`${children ? 'ui-menu-trigger' : 'ui-icon-button'} ${triggerClassName ?? ''}`}
        aria-label={label}
        title={children ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children ?? <Icon name={icon} />}
      </button>
      {open && (
        <ul
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={`ui-menu ui-menu-${align}`}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role={itemRole(item, multiple)}
                aria-checked={item.checked}
                className={`ui-menu-item ${item.danger ? 'ui-menu-item-danger' : ''} ${item.className ?? ''}`}
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon && <Icon name={item.icon} size={16} />}
                <span className="ui-menu-item-label">{item.label}</span>
                {item.checked && <Icon name="check" size={16} className="ui-menu-item-check" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ContextMenuSection {
  /** Visible heading and accessible name of the group. */
  label?: string;
  /** `row`: icon-only items side by side (the reference's 优先级 flags). */
  layout?: 'row' | 'column';
  multiple?: boolean;
  items: MenuItem[];
}

/**
 * A menu opened at a point (right click, long press, or the ContextMenu key /
 * Shift+F10 from the focused element). Focus moves into it; Esc, Tab, a click
 * outside or choosing an item closes it and returns focus to `returnFocus`.
 */
export function ContextMenu({
  label,
  x,
  y,
  sections,
  onClose,
  returnFocus,
}: {
  label: string;
  x: number;
  y: number;
  sections: ContextMenuSection[];
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // Keep the menu inside the viewport.
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    });
    menu.querySelector<HTMLButtonElement>('[role^="menuitem"]:not([disabled])')?.focus();
    function onPointerDown(event: PointerEvent) {
      if (!menu?.contains(event.target as Node)) onCloseRef.current();
    }
    function onScroll() {
      onCloseRef.current();
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onScroll);
    };
  }, [x, y]);

  function close(focusOpener: boolean) {
    onClose();
    if (focusOpener) returnFocus?.focus();
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="ui-menu ui-context-menu"
      style={{ left: position.left, top: position.top }}
      onKeyDown={(e) => menuKeyDown(e, ref.current, close)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sections.map((section, i) => (
        <div
          key={section.label ?? i}
          role="group"
          aria-label={section.label}
          className={`ui-context-section ${section.layout === 'row' ? 'ui-context-row' : ''}`}
        >
          {section.label && (
            <div className="ui-context-heading" aria-hidden="true">
              {section.label}
            </div>
          )}
          <div className="ui-context-items">
            {section.items.map((item) => (
              <button
                key={item.label}
                type="button"
                role={itemRole(item, section.multiple === true)}
                aria-checked={item.checked}
                aria-label={section.layout === 'row' ? item.label : undefined}
                title={section.layout === 'row' ? item.label : undefined}
                className={`ui-menu-item ${item.danger ? 'ui-menu-item-danger' : ''} ${item.className ?? ''}`}
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon && <Icon name={item.icon} size={section.layout === 'row' ? 20 : 16} />}
                {section.layout !== 'row' && <span className="ui-menu-item-label">{item.label}</span>}
                {section.layout !== 'row' && item.checked && <Icon name="check" size={16} className="ui-menu-item-check" />}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Open a native <dialog> modally while mounted: focus is trapped, Esc calls
 * `onClose`, and focus returns to the opener on unmount. Attach the ref to the
 * <dialog>; layouts other than `Dialog` (e.g. 设置) use this directly.
 */
export function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const handleCancel = (event: Event) => {
      event.preventDefault();
      // Only the topmost dialog handles Esc (nested dialogs, e.g. a form over 设置).
      if (event.target === dialog) onCloseRef.current();
    };
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.close();
      opener?.focus?.();
    };
  }, []);

  return ref;
}

/**
 * Modal dialog on the native <dialog> element: focus is trapped and Esc
 * closes it. Render it only while open; `onClose` fires on Esc / backdrop / ✕.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useModal(onClose);
  const titleId = useId();

  return (
    <dialog
      ref={ref}
      className={`ui-dialog ${className ?? ''}`}
      aria-labelledby={titleId}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="ui-dialog-body">
        <header className="ui-dialog-header">
          <h2 id={titleId} className="ui-dialog-title">
            {title}
          </h2>
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </header>
        {children}
        {footer && <footer className="ui-dialog-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
