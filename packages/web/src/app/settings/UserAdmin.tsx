import { PASSWORD_MIN_LENGTH, type AdminUser, type CurrentUser } from '@dida/shared';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import * as api from '../../api.js';
import { Button, Dialog } from '../../ui/controls.js';
import { ConfirmDialog } from '../dialogs.js';

type Editing = { kind: 'none' } | { kind: 'create' } | { kind: 'reset'; user: AdminUser } | { kind: 'disable'; user: AdminUser };

const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * 设置 →「用户管理」(spec 用户故事 9), shown to 管理员 only: add 用户,
 * 停用 / 启用 them and reset their password. Laid out like the 通知渠道
 * cards; 滴答 has no such screen to copy.
 */
export function UserAdmin({ currentUser }: { currentUser: CurrentUser }) {
  const id = useId();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>({ kind: 'none' });
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setUsers(await api.fetchAdminUsers());
      setLoadError(null);
    } catch (e) {
      setLoadError(api.errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function replace(user: AdminUser) {
    setUsers((list) => list && list.map((u) => (u.id === user.id ? user : u)));
  }

  async function setDisabled(user: AdminUser, disabled: boolean) {
    setRowError(({ [user.id]: _, ...rest }) => rest);
    setNotice(null);
    setBusy(user.id);
    try {
      replace(await api.setUserDisabled(user.id, disabled));
      setNotice(disabled ? `已停用 ${user.username}，该用户的登录已全部失效` : `已启用 ${user.username}`);
    } catch (e) {
      setRowError((r) => ({ ...r, [user.id]: api.errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-users">
      <div className="settings-section-head">
        <div>
          <h4 id={`${id}-title`} className="settings-section-title">
            用户
          </h4>
          <p className="settings-section-hint">本应用不开放注册，新用户只能由管理员添加。停用后该用户无法登录，已登录的设备会立即退出。</p>
        </div>
        <button type="button" className="link-button admin-users-add" onClick={() => setEditing({ kind: 'create' })}>
          + 添加用户
        </button>
      </div>

      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {users === null && !loadError && <p className="settings-section-hint">正在加载…</p>}
      <p className="form-success admin-users-notice" role="status">
        {notice}
      </p>

      {users && (
        <ul className="settings-card admin-users-list" aria-labelledby={`${id}-title`}>
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isSelf={user.id === currentUser.id}
              busy={busy === user.id}
              error={rowError[user.id]}
              onReset={() => setEditing({ kind: 'reset', user })}
              onDisable={() => setEditing({ kind: 'disable', user })}
              onEnable={() => void setDisabled(user, false)}
            />
          ))}
        </ul>
      )}

      {editing.kind === 'create' && (
        <AddUserDialog
          onCancel={() => setEditing({ kind: 'none' })}
          onCreated={(user) => {
            setEditing({ kind: 'none' });
            setUsers((list) => [...(list ?? []), user]);
            setNotice(`已添加${user.isAdmin ? '管理员' : '用户'} ${user.username}`);
          }}
        />
      )}
      {editing.kind === 'reset' && (
        <ResetPasswordDialog
          user={editing.user}
          isSelf={editing.user.id === currentUser.id}
          onCancel={() => setEditing({ kind: 'none' })}
          onDone={() => {
            setNotice(`已重置 ${editing.user.username} 的密码`);
            setEditing({ kind: 'none' });
          }}
        />
      )}
      {editing.kind === 'disable' && (
        <ConfirmDialog
          title="停用用户"
          message={`停用「${editing.user.username}」后，该用户无法登录，已登录的设备会立即退出。数据会保留，之后可以重新启用。`}
          confirmLabel="停用"
          onCancel={() => setEditing({ kind: 'none' })}
          onConfirm={async () => {
            const user = editing.user;
            setEditing({ kind: 'none' });
            await setDisabled(user, true);
          }}
        />
      )}
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  busy,
  error,
  onReset,
  onDisable,
  onEnable,
}: {
  user: AdminUser;
  isSelf: boolean;
  busy: boolean;
  error: string | undefined;
  onReset: () => void;
  onDisable: () => void;
  onEnable: () => void;
}) {
  const id = useId();
  return (
    <li className={`admin-user ${user.disabled ? 'admin-user-disabled' : ''}`} aria-labelledby={`${id}-name`}>
      <div className="settings-row">
        <span className="admin-user-main">
          <span className="admin-user-title">
            <span id={`${id}-name`} className="admin-user-name">
              {user.username}
            </span>
            {user.isAdmin && <span className="badge">管理员</span>}
            {user.disabled && <span className="badge badge-muted">已停用</span>}
            {isSelf && <span className="badge badge-muted">当前账户</span>}
          </span>
          <span className="settings-row-hint">添加于 {dateFormat.format(new Date(user.createdAt))}</span>
        </span>
        <span className="settings-row-actions">
          <button type="button" className="link-button" onClick={onReset} aria-label={`重置「${user.username}」的密码`}>
            重置密码
          </button>
          {user.disabled ? (
            <button type="button" className="link-button" onClick={onEnable} disabled={busy} aria-label={`启用「${user.username}」`}>
              启用
            </button>
          ) : (
            !isSelf && (
              <button type="button" className="link-button link-button-danger" onClick={onDisable} disabled={busy} aria-label={`停用「${user.username}」`}>
                停用
              </button>
            )
          )}
        </span>
      </div>
      {error && (
        <p className="form-error admin-user-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** Client-side checks shared by the two password forms; the server checks again. */
function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password !== confirm) return '两次输入的密码不一致';
  return null;
}

function AddUserDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (user: AdminUser) => void }) {
  const id = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = username.trim();
    const problem = !name ? '请输入账号' : /\s/.test(name) ? '账号不能包含空白字符' : passwordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onCreated(await api.createAdminUser({ username: name, password, isAdmin }));
    } catch (e) {
      setError(api.errorMessage(e));
      setSaving(false);
    }
  }

  const describedBy = error ? `${id}-error` : undefined;
  return (
    <Dialog title="添加用户" onClose={onCancel} className="admin-user-dialog">
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-username`}>账号</label>
          <input
            id={`${id}-username`}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            autoFocus
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
            aria-describedby={describedBy}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-password`}>初始密码</label>
          <input
            id={`${id}-password`}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            aria-describedby={describedBy ? `${id}-hint ${describedBy}` : `${id}-hint`}
            required
          />
          <p id={`${id}-hint`} className="field-hint">
            至少 {PASSWORD_MIN_LENGTH} 位。把账号和初始密码告诉对方，登录后可以在 设置 → 账户与安全 里修改。
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-confirm`}>确认密码</label>
          <input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError(null);
            }}
            aria-describedby={describedBy}
            required
          />
        </div>
        <label className="checkbox-field">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          设为管理员
        </label>
        {error && (
          <p id={`${id}-error`} className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="ui-dialog-footer">
          <Button onClick={onCancel}>取消</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? '正在添加…' : '添加'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  isSelf,
  onCancel,
  onDone,
}: {
  user: AdminUser;
  isSelf: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.resetUserPassword(user.id, password);
      onDone();
    } catch (e) {
      setError(api.errorMessage(e));
      setSaving(false);
    }
  }

  const describedBy = error ? `${id}-error` : undefined;
  return (
    <Dialog title={`重置「${user.username}」的密码`} onClose={onCancel} className="admin-user-dialog">
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-password`}>新密码</label>
          <input
            id={`${id}-password`}
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            aria-describedby={describedBy ? `${id}-hint ${describedBy}` : `${id}-hint`}
            required
          />
          <p id={`${id}-hint`} className="field-hint">
            至少 {PASSWORD_MIN_LENGTH} 位。{isSelf ? '重置后，你在其他设备上的登录会失效。' : '重置后，该用户所有设备上的登录都会失效。'}
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-confirm`}>确认新密码</label>
          <input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError(null);
            }}
            aria-describedby={describedBy}
            required
          />
        </div>
        {error && (
          <p id={`${id}-error`} className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="ui-dialog-footer">
          <Button onClick={onCancel}>取消</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? '正在保存…' : '重置密码'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
