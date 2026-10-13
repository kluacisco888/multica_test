import type { CurrentUser } from '@dida/shared';
import { useState, type FormEvent } from 'react';
import { errorMessage, login } from './api.js';

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
    <main className="page page-center">
      <section className="card" aria-labelledby="login-title">
        <h1 id="login-title" className="card-title">
          登录
        </h1>
        <form className="form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="login-username">账号</label>
            <input
              id="login-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
          </div>
          {error && (
            <p id="login-error" className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}
