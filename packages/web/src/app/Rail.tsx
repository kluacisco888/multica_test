import type { CurrentUser } from '@dida/shared';
import { Icon, type IconName } from '../ui/Icon.js';

/** Module shown in the main area, highlighted in the rail. */
export type RailModule = 'tasks' | 'calendar' | 'matrix' | 'focus' | 'countdowns' | 'search';

/**
 * The narrow blue bar on the far left (desktop only): account at the top,
 * then one entry per module. Focus, habits etc. join it in later tasks.
 */
export function Rail({
  user,
  onOpenAccount,
  onOpenSettings,
  onHome,
  onCalendar,
  onMatrix,
  onFocus,
  onCountdowns,
  onSearch,
  active,
}: {
  user: CurrentUser;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onHome: () => void;
  /** 日历 (spec 用户故事 69). */
  onCalendar: () => void;
  /** 四象限 (spec 用户故事 72). */
  onMatrix: () => void;
  /** 番茄专注 (spec 用户故事 86). */
  onFocus: () => void;
  /** 倒数日 (spec 用户故事 99). */
  onCountdowns: () => void;
  /** 全局搜索 (spec 用户故事 63). */
  onSearch: () => void;
  active: RailModule;
}) {
  const items: { module: RailModule; href: string; label: string; icon: IconName; onOpen: () => void }[] = [
    { module: 'tasks', href: '/', label: '任务', icon: 'task', onOpen: onHome },
    { module: 'calendar', href: '/calendar', label: '日历', icon: 'calendar', onOpen: onCalendar },
    { module: 'matrix', href: '/matrix', label: '四象限', icon: 'matrix', onOpen: onMatrix },
    { module: 'focus', href: '/focus', label: '番茄专注', icon: 'focus', onOpen: onFocus },
    { module: 'countdowns', href: '/countdowns', label: '倒数日', icon: 'countdown', onOpen: onCountdowns },
    { module: 'search', href: '/search', label: '搜索', icon: 'search', onOpen: onSearch },
  ];
  return (
    <nav className="rail" aria-label="模块">
      <button type="button" className="rail-avatar" aria-label={`账户：${user.username}`} title={user.username} onClick={onOpenAccount}>
        <span aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
      </button>
      <ul className="rail-items">
        {items.map((item) => (
          <li key={item.module}>
            <a
              className={`rail-item ${active === item.module ? 'rail-item-active' : ''}`}
              href={item.href}
              onClick={(e) => {
                e.preventDefault();
                item.onOpen();
              }}
              aria-current={active === item.module ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
            >
              <Icon name={item.icon} size={22} />
            </a>
          </li>
        ))}
      </ul>
      <div className="rail-bottom">
        <button type="button" className="rail-item rail-button" aria-label="设置" title="设置" onClick={onOpenSettings}>
          <Icon name="settings" size={22} />
        </button>
      </div>
    </nav>
  );
}
