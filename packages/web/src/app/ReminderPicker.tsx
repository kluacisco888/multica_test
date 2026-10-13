import {
  ALL_DAY_REMINDER_PRESETS,
  describeReminder,
  reminderKey,
  REMINDER_MAX_DAYS,
  REMINDER_MAX_MINUTES,
  sortReminders,
  TASK_MAX_REMINDERS,
  TIMED_REMINDER_PRESETS,
  type NotificationChannel,
  type Reminder,
} from '@dida/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, MenuButton, type MenuItem } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

/*
 * 提醒 controls inside the date picker (spec 用户故事 78–80), like 滴答: a
 * 提醒 row opening a menu of presets that can be combined (准时, 提前 5 分钟 …
 * for a task with a time; 当天, 提前 1 天, 提前 1 周 for a 全天 task), 自定义
 * for any other lead, and a row choosing the 通知渠道 (default channels
 * unless chosen).
 */

export function reminderPresets(allDay: boolean): Reminder[] {
  return allDay
    ? ALL_DAY_REMINDER_PRESETS.map((daysBefore) => ({ type: 'day', daysBefore, time: null }))
    : TIMED_REMINDER_PRESETS.map((minutes) => ({ type: 'before', minutes }));
}

/** Only the reminders that suit the kind of date. */
export function fittingReminders(reminders: Reminder[], allDay: boolean): Reminder[] {
  return reminders.filter((r) => (allDay ? r.type === 'day' : r.type === 'before'));
}

export function describeReminders(reminders: Reminder[], allDayTime: string): string {
  return reminders.length === 0 ? '无' : reminders.map((r) => describeReminder(r, allDayTime)).join('，');
}

export function ReminderRow({
  value,
  allDay,
  allDayTime,
  onChange,
  onCustom,
}: {
  value: Reminder[];
  allDay: boolean;
  allDayTime: string;
  onChange: (reminders: Reminder[]) => void;
  onCustom: () => void;
}) {
  const keys = new Set(value.map(reminderKey));
  const text = describeReminders(value, allDayTime);
  const toggle = (r: Reminder) =>
    onChange(keys.has(reminderKey(r)) ? value.filter((v) => reminderKey(v) !== reminderKey(r)) : sortReminders([...value, r]));
  const presets = reminderPresets(allDay);
  const custom = value.filter((r) => !presets.some((p) => reminderKey(p) === reminderKey(r)));
  const full = value.length >= TASK_MAX_REMINDERS;
  const items: MenuItem[] = [
    { label: '无', checked: value.length === 0, onSelect: () => onChange([]) },
    ...presets.map((p) => ({
      label: describeReminder(p, allDayTime),
      checked: keys.has(reminderKey(p)),
      disabled: full && !keys.has(reminderKey(p)),
      onSelect: () => toggle(p),
    })),
    // Custom reminders are listed so they can be removed again.
    ...custom.map((r) => ({ label: describeReminder(r, allDayTime), checked: true, onSelect: () => toggle(r) })),
    { label: '自定义', disabled: full, onSelect: onCustom },
  ];
  return (
    <div className="date-row date-row-repeat">
      <Icon name="alarm" size={16} />
      <span className="date-row-label" aria-hidden="true">
        提醒
      </span>
      <MenuButton
        label={`提醒：${text}`}
        items={items}
        multiple
        align="end"
        className="date-repeat-menu"
        triggerClassName="date-repeat-trigger date-reminder-trigger"
      >
        <span className="date-repeat-value">{text}</span>
        <Icon name="chevronRight" size={14} />
      </MenuButton>
    </div>
  );
}

/** Where the reminders go: the default channels, or the ones chosen. Hidden without channels. */
export function ReminderChannelsRow({
  channels,
  value,
  onChange,
}: {
  channels: NotificationChannel[];
  value: string[] | null;
  onChange: (ids: string[] | null) => void;
}) {
  if (channels.length === 0) return null;
  const chosen = value?.filter((id) => channels.some((c) => c.id === id)) ?? null;
  const text = chosen === null || chosen.length === 0 ? '默认渠道' : channels.filter((c) => chosen.includes(c.id)).map((c) => c.name).join('，');
  const items: MenuItem[] = [
    { label: '默认渠道', checked: chosen === null, onSelect: () => onChange(null) },
    ...channels.map((c) => ({
      label: c.name,
      checked: chosen?.includes(c.id) ?? false,
      onSelect: () => {
        const next = chosen?.includes(c.id) ? chosen.filter((id) => id !== c.id) : [...(chosen ?? []), c.id];
        onChange(next.length === 0 ? null : next);
      },
    })),
  ];
  return (
    <div className="date-row date-row-repeat">
      <Icon name="send" size={16} />
      <span className="date-row-label" aria-hidden="true">
        发送到
      </span>
      <MenuButton label={`提醒发送到：${text}`} items={items} multiple align="end" className="date-repeat-menu" triggerClassName="date-repeat-trigger">
        <span className="date-repeat-value">{text}</span>
        <Icon name="chevronRight" size={14} />
      </MenuButton>
    </div>
  );
}

type Unit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

/** 自定义提醒: N 分钟 / 小时 / 天 before a timed task, or N 天 before a 全天 task at a time. */
export function ReminderEditor({
  allDay,
  allDayTime,
  onCancel,
  onSave,
}: {
  allDay: boolean;
  allDayTime: string;
  onCancel: () => void;
  onSave: (reminder: Reminder) => void;
}) {
  const id = useId();
  const [amount, setAmount] = useState(allDay ? '2' : '10');
  const [unit, setUnit] = useState<Unit>('minutes');
  const [time, setTime] = useState(allDayTime);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const n = Number(amount);
  let error: string | null = null;
  let reminder: Reminder | null = null;
  if (!Number.isInteger(n) || n < 0) error = '请输入不小于 0 的整数';
  else if (allDay) {
    if (n > REMINDER_MAX_DAYS) error = `最多提前 ${REMINDER_MAX_DAYS} 天`;
    else if (!time) error = '请选择时间';
    else reminder = { type: 'day', daysBefore: n, time: time === allDayTime ? null : time };
  } else if (n * UNIT_MINUTES[unit] > REMINDER_MAX_MINUTES) error = '最多提前 60 天';
  else reminder = { type: 'before', minutes: n * UNIT_MINUTES[unit] };

  function submit(event: FormEvent) {
    event.preventDefault();
    if (reminder) onSave(reminder);
  }

  return (
    <form className="repeat-editor" aria-labelledby={`${id}-title`} onSubmit={submit}>
      <h3 id={`${id}-title`} className="repeat-editor-title">
        自定义提醒
      </h3>
      <div className="repeat-field">
        <label htmlFor={`${id}-amount`}>提前</label>
        <input
          ref={firstRef}
          id={`${id}-amount`}
          type="number"
          inputMode="numeric"
          min={0}
          className="date-time-input repeat-interval"
          value={amount}
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setAmount(e.target.value)}
        />
        {allDay ? (
          <>
            <span>天</span>
            <label htmlFor={`${id}-time`} className="visually-hidden">
              提醒时间
            </label>
            <input id={`${id}-time`} type="time" className="date-time-input" required value={time} onChange={(e) => setTime(e.target.value)} />
          </>
        ) : (
          <>
            <label htmlFor={`${id}-unit`} className="visually-hidden">
              单位
            </label>
            <select id={`${id}-unit`} className="settings-select repeat-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
              <option value="minutes">分钟</option>
              <option value="hours">小时</option>
              <option value="days">天</option>
            </select>
          </>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="date-error" role="alert">
          {error}
        </p>
      )}
      <div className="date-footer">
        <Button onClick={onCancel}>取消</Button>
        <Button type="submit" variant="primary" disabled={reminder === null}>
          确定
        </Button>
      </div>
    </form>
  );
}
