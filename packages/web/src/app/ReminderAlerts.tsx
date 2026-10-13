import { describeTaskDates, SNOOZE_OPTIONS_MINUTES, type ReminderAlert } from '@dida/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import * as api from '../api.js';
import { Button, IconButton, MenuButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

/*
 * 应用内提醒 (spec 用户故事 82): while the page is open, reminders that fire
 * pop up in the corner (as well as going to the 通知渠道). Each card offers
 * 完成, 稍后提醒 (5 分钟 … 3 小时) and closing it. The page polls the
 * server; the cards do not take focus, they are announced instead.
 */

/** How often the page asks for new alerts. */
export const ALERT_POLL_MS = 15_000;

const snoozeLabel = (minutes: number) => (minutes < 60 ? `${minutes}分钟后` : `${minutes / 60}小时后`);

export function ReminderAlerts({
  timeZone,
  now,
  onCompleted,
  onError,
}: {
  timeZone: string;
  now: Date;
  /** After 完成: refresh the task list and counts. */
  onCompleted: () => void;
  onError: (error: unknown) => void;
}) {
  const [alerts, setAlerts] = useState<ReminderAlert[]>([]);

  const poll = useCallback(async () => {
    try {
      setAlerts(await api.fetchReminderAlerts());
    } catch {
      // A missed poll is retried on the next one; no toast for background refreshes.
    }
  }, []);

  useEffect(() => {
    // Polled on an interval and whenever the page comes back to the foreground.
    const first = window.setTimeout(() => void poll(), 0);
    const id = window.setInterval(() => void poll(), ALERT_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [poll]);

  async function act(alert: ReminderAlert, action: () => Promise<void>) {
    setAlerts((list) => list.filter((a) => a.id !== alert.id));
    try {
      await action();
    } catch (e) {
      // Already closed or snoozed elsewhere (another tab): the card is just gone.
      if (!(e instanceof api.ApiCallError && e.status === 409)) onError(e);
      void poll();
    }
  }

  return (
    <section className="reminder-alerts" aria-label="提醒" aria-live="polite">
      {alerts.map((alert) => (
        <AlertCard
          key={alert.id}
          alert={alert}
          when={alert.dates ? describeTaskDates(alert.dates, { now, timeZone }).text : null}
          onComplete={() =>
            act(alert, async () => {
              await api.updateTask(alert.taskId, { status: 'completed' });
              onCompleted();
            })
          }
          onSnooze={(minutes) => act(alert, () => api.snoozeReminderAlert(alert.id, minutes))}
          onDismiss={() => act(alert, () => api.dismissReminderAlert(alert.id))}
        />
      ))}
    </section>
  );
}

function AlertCard({
  alert,
  when,
  onComplete,
  onSnooze,
  onDismiss,
}: {
  alert: ReminderAlert;
  when: string | null;
  onComplete: () => void;
  onSnooze: (minutes: number) => void;
  onDismiss: () => void;
}) {
  const id = useId();
  return (
    <article className="reminder-alert" aria-labelledby={`${id}-title`} aria-describedby={when ? `${id}-when` : undefined}>
      <header className="reminder-alert-head">
        <Icon name="alarm" size={16} />
        <span className="reminder-alert-kind">提醒</span>
        <IconButton icon="close" size={14} label={`关闭「${alert.title}」的提醒`} className="reminder-alert-close" onClick={onDismiss} />
      </header>
      <h2 id={`${id}-title`} className="reminder-alert-title">
        {alert.title}
      </h2>
      {when && (
        <p id={`${id}-when`} className="reminder-alert-when">
          {when}
        </p>
      )}
      <div className="reminder-alert-actions">
        <MenuButton
          label={`稍后提醒「${alert.title}」`}
          align="start"
          className="reminder-alert-snooze"
          items={SNOOZE_OPTIONS_MINUTES.map((m) => ({ label: snoozeLabel(m), onSelect: () => onSnooze(m) }))}
        >
          稍后提醒
          <Icon name="chevronDown" size={14} />
        </MenuButton>
        <Button variant="primary" onClick={onComplete} aria-label={`完成「${alert.title}」`}>
          完成
        </Button>
      </div>
    </article>
  );
}
