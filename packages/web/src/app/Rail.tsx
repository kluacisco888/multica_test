import type { CurrentUser } from '@dida/shared';
import { Icon } from '../ui/Icon.js';

/**
 * The narrow blue bar on the far left (desktop only): account at the top,
 * then one entry per module. Calendar, focus, habits etc. join it in later tasks.
 */
export function Rail({ user, onOpenAccount, onHome }: { user: CurrentUser; onOpenAccount: () => void; onHome: () => void }) {
  return (
    <nav className="rail" aria-label="模块">
      <button type="button" className="rail-avatar" aria-label={`账户：${user.username}`} title={user.username} onClick={onOpenAccount}>
        <span aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
      </button>
      <ul className="rail-items">
        <li>
          <a className="rail-item rail-item-active" href="/"
            onClick={(e) => {
              e.preventDefault();
              onHome();
            }}
            aria-current="page" aria-label="任务" title="任务">
            <Icon name="task" size={22} />
          </a>
        </li>
      </ul>
    </nav>
  );
}
