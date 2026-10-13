import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs` so 今天 / 已过期 labels roll over. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
