import { PASSWORD_MIN_LENGTH, type CurrentUser } from '@dida/shared';
import { useId, useState, type FormEvent } from 'react';
import { changePassword, errorMessage, logout } from '../api.js';
import { Button, Dialog } from '../ui/controls.js';

/** 账户: who is signed in, change password, log out (spec 用户故事 7、8). */
export function AccountDialog({
  user,
  onClose,
  onLoggedOut,
}: {
  user: CurrentUser;
  onClose: () => void;
  onLoggedOut: () => void;
}) {
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
    <Dialog title="账户" onClose={onClose} className="account-dialog">
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
    </Dialog>
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
