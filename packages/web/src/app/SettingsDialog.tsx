import { PASSWORD_MIN_LENGTH, type CurrentUser, type Settings, type UpdateSettingsRequest } from '@dida/shared';
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { changePassword, errorMessage, logout } from '../api.js';
import { Button, Dialog } from '../ui/controls.js';
import { Icon, type IconName } from '../ui/Icon.js';

type SettingsTab = 'account' | 'datetime';

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: 'account', label: '账户与安全', icon: 'user' },
  { id: 'datetime', label: '日期与时间', icon: 'clock' },
];

/**
 * 设置, laid out like 滴答's settings dialog: a tab list on the left, the
 * panel on the right. 账户与安全: who is signed in, change password, log out
 * (spec 用户故事 7、8). 日期与时间: the time zone (用户故事 26).
 */
export function SettingsDialog({
  user,
  settings,
  onClose,
  onLoggedOut,
  onSaveSettings,
}: {
  user: CurrentUser;
  settings: Settings | null;
  onClose: () => void;
  onLoggedOut: () => void;
  onSaveSettings: (patch: UpdateSettingsRequest) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<SettingsTab>('account');
  const id = useId();

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = TABS.findIndex((t) => t.id === tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + TABS.length) % TABS.length;
    const target = TABS[next] as (typeof TABS)[number];
    setTab(target.id);
    document.getElementById(`${id}-tab-${target.id}`)?.focus();
  }

  return (
    <Dialog title="设置" onClose={onClose} className="settings-dialog">
      <div className="settings-layout">
        <div role="tablist" aria-orientation="vertical" aria-label="设置分类" className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`${id}-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`${id}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              className="settings-tab"
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKeyDown}
            >
              <Icon name={t.icon} size={16} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="settings-panel">
          {tab === 'account' ? (
            <AccountPanel user={user} onLoggedOut={onLoggedOut} />
          ) : (
            <DateTimePanel settings={settings} onSave={onSaveSettings} />
          )}
        </div>
      </div>
    </Dialog>
  );
}

function AccountPanel({ user, onLoggedOut }: { user: CurrentUser; onLoggedOut: () => void }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      onLoggedOut();
    } catch (e) {
      setLogoutError(errorMessage(e));
      setLoggingOut(false);
    }
  }

  return (
    <>
      <p className="account-user">
        已登录：<strong>{user.username}</strong>
        {user.isAdmin && <span className="badge">管理员</span>}
      </p>
      <ChangePasswordForm />
      {logoutError && (
        <p className="form-error" role="alert">
          {logoutError}
        </p>
      )}
      <div className="ui-dialog-footer">
        <Button onClick={handleLogout} disabled={loggingOut}>
          退出登录
        </Button>
      </div>
    </>
  );
}

/** "(GMT+08:00) Asia/Shanghai" for the time zone menu. */
function timeZoneOptionLabel(timeZone: string, now: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value;
  const offset = !part || part === 'GMT' ? 'GMT+00:00' : part;
  return `(${offset}) ${timeZone}`;
}

function timeZoneOptions(current: string): string[] {
  const zones = new Set(Intl.supportedValuesOf('timeZone'));
  zones.add('UTC');
  zones.add(current);
  return [...zones].sort();
}

function DateTimePanel({ settings, onSave }: { settings: Settings | null; onSave: (patch: UpdateSettingsRequest) => Promise<boolean> }) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [zones] = useState(() => (settings ? timeZoneOptions(settings.timeZone) : []));
  const [now] = useState(() => new Date());

  if (!settings) {
    return (
      <p className="list-pane-status" role="status">
        正在加载…
      </p>
    );
  }

  async function change(timeZone: string) {
    setSaving(true);
    setSaved(false);
    const ok = await onSave({ timeZone });
    setSaving(false);
    setSaved(ok);
  }

  return (
    <section className="account-section" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="account-section-title">
        日期与时间
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <label htmlFor={`${id}-tz`}>时区</label>
          <select
            id={`${id}-tz`}
            className="settings-select"
            value={settings.timeZone}
            disabled={saving}
            aria-describedby={`${id}-tz-hint`}
            onChange={(e) => void change(e.target.value)}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneOptionLabel(zone, now)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p id={`${id}-tz-hint`} className="field-hint">
        带具体时间的任务按这个时区显示；全天任务的日期不受影响。
      </p>
      {saved && (
        <p className="form-success" role="status">
          时区已保存
        </p>
      )}
    </section>
  );
}

function ChangePasswordForm() {
  const id = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDone(false);
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(`新密码至少 ${PASSWORD_MIN_LENGTH} 位`);
      return;
    }
    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  const errorId = `${id}-error`;
  const describedBy = error ? errorId : undefined;
  return (
    <section className="account-section" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="account-section-title">
        修改密码
      </h3>
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-current`}>当前密码</label>
          <input
            id={`${id}-current`}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            aria-describedby={describedBy}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-new`}>新密码</label>
          <input
            id={`${id}-new`}
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            aria-describedby={describedBy ? `${id}-hint ${describedBy}` : `${id}-hint`}
            required
          />
          <p id={`${id}-hint`} className="field-hint">
            至少 {PASSWORD_MIN_LENGTH} 位。修改后，其他设备上的登录会失效。
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-confirm`}>确认新密码</label>
          <input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-describedby={describedBy}
            required
          />
        </div>
        {error && (
          <p id={errorId} className="form-error" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p className="form-success" role="status">
            密码已修改
          </p>
        )}
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? '正在保存…' : '修改密码'}
        </Button>
      </form>
    </section>
  );
}
