import { useId } from 'react';
import { Dialog } from '../ui/controls.js';
import { SHORTCUT_GROUPS } from './shortcuts.js';

/** The fixed 快捷键 list, grouped like the reference's 设置 →「快捷键」. */
export function ShortcutList() {
  const id = useId();
  return (
    <div className="shortcut-groups">
      {SHORTCUT_GROUPS.map((group, i) => (
        <section key={group.title} className="shortcut-group" aria-labelledby={`${id}-${i}`}>
          <h3 id={`${id}-${i}`} className="shortcut-group-title">
            {group.title}
          </h3>
          <dl className="shortcut-card">
            {group.items.map((item) => (
              <div key={item.label} className="shortcut-row">
                <dt>{item.label}</dt>
                <dd>
                  <kbd className="shortcut-keys">
                    {item.keys.map((k, j) => (
                      <span key={k}>
                        {j > 0 && '+'}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </kbd>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** The `?` panel (spec 用户故事 106). Esc or 关闭 closes it. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="快捷键" onClose={onClose} className="shortcuts-dialog">
      <ShortcutList />
      <p className="field-hint shortcut-note">在输入框里输入时，单个字母和数字的快捷键不会触发。快捷键不支持自定义。</p>
    </Dialog>
  );
}
