import type { CurrentUser } from '@dida/shared';
import { Icon } from '../ui/Icon.js';

/**
 * The narrow blue bar on the far left (desktop only): account at the top,
 * then one entry per module. Calendar, focus, habits etc. join it in later tasks.
 */
export function Rail({
  user,
  onOpenAccount,
  onOpenSettings,
  onHome,
  onSearch,
  searchActive,
}: {
  user: CurrentUser;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onHome: () => void;
  /** 全局搜索 (spec 用户故事 63). */
  onSearch: () => void;
  searchActive: boolean;
}) {
  return (
    <nav className="rail" aria-label="模块">
      <button type="button" className="rail-avatar" aria-label={`账户：${user.username}`} title={user.username} onClick={onOpenAccount}>
        <span aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
      </button>
      <ul className="rail-items">
        <li>
          <a className={`rail-item ${searchActive ? '' : 'rail-item-active'}`} href="/"
            onClick={(e) => {
              e.preventDefault();
              onHome();
            }}
            aria-current={searchActive ? undefined : 'page'} aria-label="任务" title="任务">
            <Icon name="task" size={22} />
          </a>
        </li>
        <li>
          <a
            className={`rail-item ${searchActive ? 'rail-item-active' : ''}`}
            href="/search"
            onClick={(e) => {
              e.preventDefault();
              onSearch();
            }}
            aria-current={searchActive ? 'page' : undefined}
            aria-label="搜索"
            title="搜索"
          >
            <Icon name="search" size={22} />
          </a>
        </li>
      </ul>
      <div className="rail-bottom">
        <button type="button" className="rail-item rail-button" aria-label="设置" title="设置" onClick={onOpenSettings}>
          <Icon name="settings" size={22} />
        </button>
      </div>
    </nav>
  );
}
