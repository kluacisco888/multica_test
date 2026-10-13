import type { CurrentUser } from '@dida/shared';
import { useState, type FormEvent } from 'react';
import { errorMessage, login } from './api.js';
import { Brand } from './ui/Brand.js';
import { Button } from './ui/controls.js';

/**
 * 登录 page, laid out like the reference sign-in page: brand bar on top, a
 * white card in the middle. Registration and third-party login do not exist
 * here (spec: 不开放注册), so those parts of the reference are left out.
 */
export function LoginPage({ onLoggedIn }: { onLoggedIn: (user: CurrentUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入账号和密码');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onLoggedIn(await login({ username: username.trim(), password }));
    } catch (e) {
      setError(errorMessage(e));
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <header className="login-topbar">
        <Brand />
      </header>
      <main className="login-main">
        <section className="login-card" aria-labelledby="login-title">
          <h1 id="login-title" className="login-title">
            登录
          </h1>
          <form className="login-form" onSubmit={submit} noValidate>
            <label htmlFor="login-username" className="visually-hidden">
              账号
            </label>
            <input
              id="login-username"
              className="login-input"
              name="username"
              placeholder="账号"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
            <label htmlFor="login-password" className="visually-hidden">
              密码
            </label>
            <input
              id="login-password"
              className="login-input"
              name="password"
              type="password"
              placeholder="密码"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
            {error && (
              <p id="login-error" className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="login-submit" disabled={submitting}>
              {submitting ? '正在登录…' : '登录'}
            </Button>
          </form>
          <p className="login-note">没有账号或忘记密码时，请联系管理员</p>
        </section>
      </main>
    </div>
  );
}
