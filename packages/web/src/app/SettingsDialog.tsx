import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Dialog, IconButton } from '../ui/controls.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { HolidaySettings } from './HolidaySettings.js';
import { MOBILE_QUERY, useMediaQuery } from './route.js';

/*
 * 设置: a modal with categories on the left and the chosen category on the
 * right, like the reference. On mobile it is full screen and the categories sit
 * behind a menu button. Later tasks add their categories to `TABS`.
 */

interface SettingsTab {
  id: string;
  label: string;
  icon: IconName;
  render: () => ReactNode;
}

const TABS: SettingsTab[] = [
  {
    id: 'date',
    label: '日期与时间',
    icon: 'clock',
    render: () => <HolidaySettings />,
  },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const baseId = useId();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [current, setCurrent] = useState(TABS[0]?.id ?? '');
  const [navOpen, setNavOpen] = useState(false);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tab = TABS.find((t) => t.id === current) ?? TABS[0];
  const showNav = !isMobile || navOpen;
  const showPanel = !isMobile || !navOpen;

  function select(id: string) {
    setCurrent(id);
    setNavOpen(false);
  }

  // Vertical tabs (WAI-ARIA): ↑/↓/Home/End move and select.
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = TABS.findIndex((t) => t.id === current);
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowUp'
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const id = TABS[next]?.id;
    if (!id) return;
    setCurrent(id);
    tabRefs.current.get(id)?.focus();
  }

  return (
    <Dialog
      title="设置"
      onClose={onClose}
      className="settings-dialog"
      headerStart={
        isMobile ? (
          <IconButton icon="sidebar" label="设置分类" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)} />
        ) : undefined
      }
    >
      <div className="settings-layout">
        {showNav && (
          <div className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="设置分类">
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el);
                  else tabRefs.current.delete(t.id);
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={t.id === tab?.id}
                aria-controls={showPanel ? `${baseId}-panel-${t.id}` : undefined}
                tabIndex={t.id === tab?.id ? 0 : -1}
                className={`settings-nav-item ${t.id === tab?.id ? 'settings-nav-item-active' : ''}`}
                onClick={() => select(t.id)}
                onKeyDown={onTabKeyDown}
              >
                <Icon name={t.icon} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
        {showPanel && tab && (
          <div
            className="settings-panel"
            role="tabpanel"
            id={`${baseId}-panel-${tab.id}`}
            // On mobile the tabs may be hidden; then the panel names itself.
            {...(showNav ? { 'aria-labelledby': `${baseId}-tab-${tab.id}` } : { 'aria-label': tab.label })}
          >
            <h3 className="settings-panel-title">{tab.label}</h3>
            {tab.render()}
          </div>
        )}
      </div>
    </Dialog>
  );
}
