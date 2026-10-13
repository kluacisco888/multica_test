import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
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

/** Square task checkbox (spec 完成 / 取消完成). `label` names the task. */
export function TaskCheckbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="ui-task-checkbox"
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
  /** Marks the current choice (menuitemradio). */
  checked?: boolean;
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
  align = 'end',
}: {
  label: string;
  icon?: IconName;
  items: MenuItem[];
  /** Visible content; omitted means an icon-only button. */
  children?: ReactNode;
  className?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();
  const radio = items.some((i) => i.checked !== undefined);

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
    const entries = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      entries[(index + step + entries.length) % entries.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? entries[0] : entries.at(-1))?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className={`ui-menu-anchor ${className ?? ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className={children ? 'ui-menu-trigger' : 'ui-icon-button'}
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
                role={radio ? 'menuitemradio' : 'menuitem'}
                aria-checked={radio ? item.checked === true : undefined}
                className={`ui-menu-item ${item.danger ? 'ui-menu-item-danger' : ''}`}
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
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
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
      onCloseRef.current();
    };
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.close();
      opener?.focus?.();
    };
  }, []);

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
