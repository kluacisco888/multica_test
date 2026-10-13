import { healthResponseSchema } from '@dida/shared';
import { useEffect, useState } from 'react';

type Status = 'checking' | 'ok' | 'down';

const STATUS_TEXT: Record<Status, string> = {
  checking: '正在检查服务状态…',
  ok: '服务正常',
  down: '服务不可用',
};

/**
 * Placeholder shell for the skeleton task: proves the single image serves the
 * web app and that it can reach the API. EURO-6 replaces it with the real
 * application shell matched against the reference screenshots.
 */
export function App() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (res) => {
        const body = healthResponseSchema.safeParse(await res.json());
        setStatus(res.ok && body.success && body.data.status === 'ok' ? 'ok' : 'down');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setStatus('down');
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <h1>dida-clone</h1>
      <p role="status" aria-live="polite" className={`status status-${status}`}>
        {STATUS_TEXT[status]}
      </p>
    </main>
  );
}
