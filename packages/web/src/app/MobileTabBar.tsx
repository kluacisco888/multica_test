import { useState } from 'react';
import { Dialog } from '../ui/controls.js';
import { Icon, type IconName } from '../ui/Icon.js';

/** Bottom-navigation tab: the four modules on the bar, or 更多 for the rest. */
export type MobileTab = 'tasks' | 'calendar' | 'focus' | 'habits' | 'more';

/**
 * 底部导航 (mobile only, spec 用户故事 107), laid out like the 滴答 App's
 * tab bar: 任务、日历、专注、习惯 and 更多. 更多 opens a sheet with the
 * modules that have no tab (四象限、倒数日、搜索) and 设置.
 */
export function MobileTabBar({
  active,
  onTasks,
  onCalendar,
  onFocus,
  onHabits,
  onMatrix,
  onCountdowns,
  onSearch,
  onSettings,
}: {
  active: MobileTab;
  onTasks: () => void;
  onCalendar: () => void;
  onFocus: () => void;
  onHabits: () => void;
  onMatrix: () => void;
  onCountdowns: () => void;
  onSearch: () => void;
  onSettings: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs: { tab: MobileTab; href: string; label: string; icon: IconName; onOpen: () => void }[] = [
    { tab: 'tasks', href: '/', label: '任务', icon: 'task', onOpen: onTasks },
    { tab: 'calendar', href: '/calendar', label: '日历', icon: 'calendar', onOpen: onCalendar },
    { tab: 'focus', href: '/focus', label: '专注', icon: 'focus', onOpen: onFocus },
    { tab: 'habits', href: '/habits', label: '习惯', icon: 'habit', onOpen: onHabits },
  ];
  const more: { label: string; icon: IconName; onOpen: () => void }[] = [
    { label: '四象限', icon: 'matrix', onOpen: onMatrix },
    { label: '倒数日', icon: 'countdown', onOpen: onCountdowns },
    { label: '搜索', icon: 'search', onOpen: onSearch },
    { label: '设置', icon: 'settings', onOpen: onSettings },
  ];

  return (
    <nav className="tabbar" aria-label="底部导航">
      <ul className="tabbar-items">
        {tabs.map((item) => (
          <li key={item.tab}>
            <a
              className={`tabbar-item ${active === item.tab ? 'tabbar-item-active' : ''}`}
              href={item.href}
              aria-current={active === item.tab ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                item.onOpen();
              }}
            >
              <Icon name={item.icon} size={24} />
              <span className="tabbar-label">{item.label}</span>
            </a>
          </li>
        ))}
        <li>
          <button
            type="button"
            className={`tabbar-item ${active === 'more' ? 'tabbar-item-active' : ''}`}
            aria-current={active === 'more' ? 'page' : undefined}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            <Icon name="grid" size={24} />
            <span className="tabbar-label">更多</span>
          </button>
        </li>
      </ul>
      {moreOpen && (
        <Dialog title="更多" className="tabbar-more" onClose={() => setMoreOpen(false)}>
          <ul className="tabbar-more-items">
            {more.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  className="tabbar-more-item"
                  onClick={() => {
                    setMoreOpen(false);
                    item.onOpen();
                  }}
                >
                  <span className="tabbar-more-icon" aria-hidden="true">
                    <Icon name={item.icon} size={24} />
                  </span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </nav>
  );
}
