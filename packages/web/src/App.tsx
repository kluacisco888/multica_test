import type { CurrentUser } from '@dida/shared';
import { useEffect, useState } from 'react';
import { fetchCurrentUser } from './api.js';
import { AppShell } from './app/AppShell.js';
import { LoginPage } from './LoginPage.js';

type AuthState = { status: 'loading' } | { status: 'error' } | { status: 'anonymous' } | { status: 'ready'; user: CurrentUser };

/** Login gate in front of the application shell. */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then((user) => {
        if (!cancelled) setAuth(user ? { status: 'ready', user } : { status: 'anonymous' });
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!cancelled) setAuth({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  switch (auth.status) {
    case 'loading':
      return (
        <main className="page page-center">
          <p role="status">正在加载…</p>
        </main>
      );
    case 'error':
      return (
        <main className="page page-center">
          <p role="alert">服务不可用，请稍后刷新重试</p>
        </main>
      );
    case 'anonymous':
      return <LoginPage onLoggedIn={(user) => setAuth({ status: 'ready', user })} />;
    case 'ready':
      return <AppShell user={auth.user} onLoggedOut={() => setAuth({ status: 'anonymous' })} />;
  }
}
