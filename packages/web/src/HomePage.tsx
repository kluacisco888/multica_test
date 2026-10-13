import { PASSWORD_MIN_LENGTH, type CurrentUser } from '@dida/shared';
import { useId, useState, type FormEvent } from 'react';
import { changePassword, errorMessage, logout } from './api.js';

/** Placeholder signed-in page until EURO-6 builds the application shell. */
export function HomePage({ user, onLoggedOut }: { user: CurrentUser; onLoggedOut: () => void }) {
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
    <div className="page">
      <header className="topbar">
        <p className="topbar-user">
          已登录：<strong>{user.username}</strong>
          {user.isAdmin && <span className="badge">管理员</span>}
        </p>
        <button type="button" className="button" onClick={handleLogout} disabled={loggingOut}>
          退出登录
        </button>
      </header>
      {logoutError && (
        <p className="form-error page-message" role="alert">
          {logoutError}
        </p>
      )}
      <main className="page-main">
        <h1 className="page-title">账户</h1>
        <ChangePasswordForm />
      </main>
    </div>
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
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="card-title">
        修改密码
      </h2>
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
        <button type="submit" className="button button-primary" disabled={submitting}>
          {submitting ? '正在保存…' : '修改密码'}
        </button>
      </form>
    </section>
  );
}
