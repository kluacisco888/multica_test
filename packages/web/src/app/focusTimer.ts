import { FOCUS_PHASE_LABELS, type CurrentFocusResponse, type FocusMode, type FocusSession } from '@dida/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api.js';

/*
 * The 专注 timer as the page sees it (spec 用户故事 86–91). The state is on
 * the server; this hook mirrors it for the whole app (not just the 专注 page),
 * so that wherever the user is, the page settles a 番茄 the moment its
 * countdown ends — reading the current session makes the server complete it
 * and start the break — and plays the 提示音. The server notifies through
 * the 通知渠道 only when no page did this (the page was closed).
 */

/** Re-read now and then, in case another device changed the timer. */
const POLL_MS = 60_000;

export interface FocusTimer {
  /** Null until the first answer. */
  session: FocusSession | null | undefined;
  /** Server clock minus this device's clock, ms. */
  offsetMs: number;
  /** The server's idea of now. */
  serverNow(): Date;
  /** Polite announcement of the last automatic change (e.g. 专注结束). */
  announcement: string;
  start(mode: FocusMode, taskId: string | null): Promise<void>;
  act(action: 'pause' | 'resume' | 'abandon' | 'finish'): Promise<void>;
  link(taskId: string | null): Promise<void>;
  /** Bumped whenever a session finished, so 专注记录 / 统计 reload. */
  finishedEpoch: number;
}

let audio: AudioContext | null = null;

/** Create (or wake) the audio context inside a user gesture, so the chime may play later. */
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    // No Web Audio: no sound, the announcement still shows.
  }
}

/** 提示音: three soft rising tones. */
export function playChime() {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    [660, 880, 990].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + i * 0.28;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.55);
    });
  } catch {
    // See unlockAudio.
  }
}

function endAnnouncement(previous: FocusSession, next: FocusSession | null): string {
  if (previous.phase === 'focus') {
    return next && next.phase !== 'focus' ? `专注结束，开始${FOCUS_PHASE_LABELS[next.phase]}` : '专注结束';
  }
  return `${FOCUS_PHASE_LABELS[previous.phase]}结束`;
}

export function useFocusTimer(onError: (error: unknown) => void): FocusTimer {
  const [session, setSession] = useState<FocusSession | null | undefined>(undefined);
  const [offsetMs, setOffsetMs] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [finishedEpoch, setFinishedEpoch] = useState(0);
  const sessionRef = useRef<FocusSession | null | undefined>(undefined);

  const apply = useCallback((res: CurrentFocusResponse) => {
    setOffsetMs(new Date(res.now).getTime() - Date.now());
    const before = sessionRef.current;
    if (before && (res.session?.id !== before.id || res.session?.phase !== before.phase)) setFinishedEpoch((n) => n + 1);
    sessionRef.current = res.session;
    setSession(res.session);
  }, []);

  /** Read the server state; chime when the countdown we showed has run out. */
  const refresh = useCallback(
    async () => {
      try {
        const before = sessionRef.current;
        const res = await api.fetchCurrentFocus();
        const ranOut = before?.status === 'running' && before.endsAt !== null && before.endsAt <= res.now;
        if (before && ranOut && res.session?.id !== before.id) {
          playChime();
          setAnnouncement(endAnnouncement(before, res.session));
        }
        apply(res);
      } catch {
        // Background refresh: the next one retries.
      }
    },
    [apply],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const id = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Settle at the end of the countdown (a little after, so the server's clock has passed it too).
  useEffect(() => {
    if (!session || session.status !== 'running' || !session.endsAt) return;
    const wait = new Date(session.endsAt).getTime() - (Date.now() + offsetMs) + 250;
    const id = window.setTimeout(() => void refresh(), Math.max(0, wait));
    return () => window.clearTimeout(id);
  }, [session, offsetMs, refresh]);

  const run = useCallback(
    async (call: () => Promise<CurrentFocusResponse>) => {
      unlockAudio();
      setAnnouncement('');
      try {
        apply(await call());
      } catch (e) {
        onError(e);
        void refresh();
      }
    },
    [apply, onError, refresh],
  );

  return {
    session,
    offsetMs,
    serverNow: () => new Date(Date.now() + offsetMs),
    announcement,
    finishedEpoch,
    start: (mode, taskId) => run(() => api.startFocus({ mode, taskId })),
    act: (action) => run(() => api.focusAction(action)),
    link: (taskId) => run(() => api.linkFocusTask(taskId)),
  };
}
