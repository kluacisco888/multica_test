import {
  COUNTDOWN_ICONS,
  COUNTDOWN_REMINDER_PRESETS,
  countdownCaption,
  DEFAULT_COUNTDOWN_ICON,
  describeReminder,
  formatYmd,
  reminderKey,
  sortReminders,
  ymdBetween,
  type Countdown,
  type CountdownCalendar,
  type CountdownRepeat,
  type NotificationChannel,
  type Reminder,
} from '@dida/shared';
import { useEffect, useId, useState, type FormEvent } from 'react';
import * as api from '../api.js';
import { Button, Dialog, IconButton, MenuButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { ConfirmDialog } from './dialogs.js';
import { ReminderChannelsRow } from './ReminderPicker.js';

/*
 * 倒数日 (spec 用户故事 99–101), laid out like the reference's 倒数纪念日 page:
 * a grid of cards (icon and name, the day count in large figures, "距离 …
 * 还有 / 已经" underneath), the 记录中 / 已归档 switch in the title menu and +
 * to add. Clicking the figures switches between days and 年月日. Hover (or
 * focus) shows 置顶 and the card menu; on touch screens they always show.
 */

export interface CountdownDraft {
  name: string;
  icon: string;
  date: string;
  calendar: CountdownCalendar;
  repeat: CountdownRepeat;
  reminders: Reminder[];
  reminderChannelIds: string[] | null;
  pinned: boolean;
}

interface CountdownPaneProps {
  archived: boolean;
  today: string;
  isMobile: boolean;
  sidebarVisible: boolean;
  channels: NotificationChannel[];
  allDayReminderTime: string;
  onToggleSidebar: () => void;
  onShowArchived: (archived: boolean) => void;
  onError: (error: unknown) => void;
}

type PaneDialog = { kind: 'none' } | { kind: 'edit'; countdown: Countdown | null } | { kind: 'delete'; countdown: Countdown };

export function CountdownPane(props: CountdownPaneProps) {
  const { archived, onError } = props;
  // Tagged with what was loaded, so switching 记录中 / 已归档 shows 正在加载 until the new list arrives.
  const [loaded, setLoaded] = useState<{ archived: boolean; items: Countdown[] } | null>(null);
  const items = loaded?.archived === archived ? loaded.items : null;
  const [dialog, setDialog] = useState<PaneDialog>({ kind: 'none' });
  const [ymdCards, setYmdCards] = useState<ReadonlySet<string>>(new Set());

  /** Bumped after every write to load the list again. */
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.fetchCountdowns(archived).then(
      (list) => {
        if (!cancelled) setLoaded({ archived, items: list });
      },
      (error: unknown) => {
        if (!cancelled) onError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [archived, onError, props.today, epoch]);

  async function run(write: () => Promise<unknown>) {
    try {
      await write();
    } catch (error) {
      onError(error);
    }
    setEpoch((n) => n + 1);
  }

  async function save(draft: CountdownDraft) {
    const editing = dialog.kind === 'edit' ? dialog.countdown : null;
    await run(() => (editing ? api.updateCountdown(editing.id, draft) : api.createCountdown(draft)));
    setDialog({ kind: 'none' });
  }

  const toggleFormat = (id: string) =>
    setYmdCards((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const title = archived ? '已归档的倒数日' : '倒数纪念日';

  return (
    <main className="countdown-pane" aria-busy={items === null}>
      <header className="list-pane-header countdown-header">
        {props.isMobile && (
          <IconButton
            icon="sidebar"
            label={props.sidebarVisible ? '收起侧栏' : '展开侧栏'}
            aria-expanded={props.sidebarVisible}
            onClick={props.onToggleSidebar}
            className="list-pane-sidebar-toggle"
          />
        )}
        <h1 className="list-pane-title countdown-title">
          <MenuButton
            label={`${title}，切换记录中 / 已归档`}
            align="start"
            triggerClassName="countdown-title-trigger"
            items={[
              { label: '记录中', checked: !archived, onSelect: () => props.onShowArchived(false) },
              { label: '已归档', checked: archived, onSelect: () => props.onShowArchived(true) },
            ]}
          >
            <span>{title}</span>
            <Icon name="chevronDown" size={14} />
          </MenuButton>
        </h1>
        <span className="countdown-header-actions">
          <IconButton icon="plus" size={22} label="添加倒数日" onClick={() => setDialog({ kind: 'edit', countdown: null })} />
        </span>
      </header>

      {items === null ? (
        <p className="list-pane-status" role="status">
          正在加载…
        </p>
      ) : items.length === 0 ? (
        <div className="list-pane-empty countdown-empty">
          <p className="list-pane-empty-title">{archived ? '没有已归档的倒数日' : '还没有倒数日'}</p>
          {!archived && <p>记录重要的日子，看看还有几天，或者已经过去了几天</p>}
        </div>
      ) : (
        <ul className="countdown-grid" aria-label={title}>
          {items.map((c) => (
            <CountdownCard
              key={c.id}
              countdown={c}
              ymd={ymdCards.has(c.id)}
              today={props.today}
              onToggleFormat={() => toggleFormat(c.id)}
              onEdit={() => setDialog({ kind: 'edit', countdown: c })}
              onPin={() => void run(() => api.updateCountdown(c.id, { pinned: !c.pinned }))}
              onArchive={() => void run(() => api.updateCountdown(c.id, { archived: !c.archivedAt }))}
              onDelete={() => setDialog({ kind: 'delete', countdown: c })}
            />
          ))}
        </ul>
      )}

      {dialog.kind === 'edit' && (
        <CountdownDialog
          countdown={dialog.countdown}
          today={props.today}
          channels={props.channels}
          allDayReminderTime={props.allDayReminderTime}
          onCancel={() => setDialog({ kind: 'none' })}
          onSave={save}
        />
      )}
      {dialog.kind === 'delete' && (
        <ConfirmDialog
          title="删除倒数日"
          message={`确定删除「${dialog.countdown.name}」吗？`}
          confirmLabel="删除"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={async () => {
            const target = dialog.countdown;
            setDialog({ kind: 'none' });
            await run(() => api.deleteCountdown(target.id));
          }}
        />
      )}
    </main>
  );
}

function CountdownCard({
  countdown: c,
  ymd,
  today,
  onToggleFormat,
  onEdit,
  onPin,
  onArchive,
  onDelete,
}: {
  countdown: Countdown;
  ymd: boolean;
  today: string;
  onToggleFormat: () => void;
  onEdit: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const caption = countdownCaption(c);
  const figure = ymd ? formatYmd(ymdBetween(today, c.next.date)) : String(c.next.days);
  return (
    <li className={`countdown-card ${c.pinned ? 'countdown-card-pinned' : ''}`} aria-labelledby={titleId}>
      <span className="countdown-card-actions">
        <IconButton icon="pin" size={14} label={c.pinned ? `取消置顶：${c.name}` : `置顶：${c.name}`} aria-pressed={c.pinned} className="countdown-card-action" onClick={onPin} />
        <MenuButton
          label={`倒数日操作：${c.name}`}
          triggerClassName="countdown-card-action"
          items={[
            { label: '编辑', icon: 'edit', onSelect: onEdit },
            { label: c.pinned ? '取消置顶' : '置顶', icon: 'pin', onSelect: onPin },
            { label: c.archivedAt ? '取消归档' : '归档', icon: c.archivedAt ? 'restore' : 'archive', onSelect: onArchive },
            { label: '删除', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
        />
      </span>
      <h2 id={titleId} className="countdown-card-name">
        <span className="countdown-card-icon" aria-hidden="true">
          {c.icon}
        </span>
        <span className="countdown-card-name-text">{c.name}</span>
      </h2>
      <button
        type="button"
        className={`countdown-card-figure ${ymd ? 'countdown-card-figure-ymd' : ''} ${c.next.status === 'passed' ? 'countdown-card-figure-passed' : ''}`}
        title="点击可切换年月日格式"
        aria-label={`${caption} ${ymd ? figure : `${figure}天`}，点击切换为${ymd ? '天数' : '年月日'}格式`}
        onClick={onToggleFormat}
      >
        {c.next.status === 'today' && !ymd ? '今天' : figure}
      </button>
      <p className="countdown-card-caption" aria-hidden="true">
        {caption}
      </p>
    </li>
  );
}

const PRESET_REMINDERS: Reminder[] = COUNTDOWN_REMINDER_PRESETS.map((daysBefore) => ({ type: 'day', daysBefore, time: null }));

/** Create or edit a 倒数日: name, icon, date (公历 or 农历), 每年重复, 提醒 and 置顶. */
export function CountdownDialog({
  countdown,
  today,
  channels,
  allDayReminderTime,
  onCancel,
  onSave,
}: {
  countdown: Countdown | null;
  today: string;
  channels: NotificationChannel[];
  allDayReminderTime: string;
  onCancel: () => void;
  onSave: (draft: CountdownDraft) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(countdown?.name ?? '');
  const [icon, setIcon] = useState(countdown?.icon ?? DEFAULT_COUNTDOWN_ICON);
  const [date, setDate] = useState(countdown?.date ?? today);
  const [calendar, setCalendar] = useState<CountdownCalendar>(countdown?.calendar ?? 'solar');
  const [repeat, setRepeat] = useState<CountdownRepeat>(countdown?.repeat ?? 'none');
  // Presets only differ in the lead; one time of day applies to all of them.
  const [leads, setLeads] = useState<ReadonlySet<number>>(new Set(countdown?.reminders.flatMap((r) => (r.type === 'day' ? [r.daysBefore] : [])) ?? []));
  const firstTime = countdown?.reminders.find((r) => r.type === 'day')?.time ?? null;
  const [time, setTime] = useState(firstTime ?? allDayReminderTime);
  const [channelIds, setChannelIds] = useState<string[] | null>(countdown?.reminderChannelIds ?? null);
  const [pinned, setPinned] = useState(countdown?.pinned ?? false);
  const [lunar, setLunar] = useState<{ date: string; text: string | null } | null>(null);
  const lunarText = calendar === 'lunar' && lunar?.date === date ? lunar.text : null;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 农历 preview of the chosen date (the 日历's 农历 data, so no 农历 library in the page).
  useEffect(() => {
    if (calendar !== 'lunar' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let cancelled = false;
    api
      .fetchCalendarDays({ from: date, to: date })
      .then(([day]) => {
        if (!cancelled) setLunar({ date, text: day ? `农历 ${day.lunarMonthName}${day.lunarDayName}` : null });
      })
      .catch(() => {
        if (!cancelled) setLunar({ date, text: null });
      });
    return () => {
      cancelled = true;
    };
  }, [calendar, date]);

  const reminders: Reminder[] = sortReminders(
    [...leads].map((daysBefore) => ({ type: 'day', daysBefore, time: time === allDayReminderTime ? null : time })),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError('请输入名称');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('请选择日期');
      return;
    }
    setSaving(true);
    await onSave({ name: name.trim(), icon, date, calendar, repeat, reminders, reminderChannelIds: reminders.length > 0 ? channelIds : null, pinned });
    setSaving(false);
  }

  return (
    <Dialog title={countdown ? '编辑倒数日' : '添加倒数日'} onClose={onCancel} className="countdown-dialog">
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-name`}>名称</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={64}
            autoFocus
            placeholder="例如：春节、生日、纪念日"
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          {error && (
            <p id={`${id}-error`} className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <fieldset className="field picker">
          <legend>图标</legend>
          <div className="picker-options">
            {COUNTDOWN_ICONS.map((emoji) => (
              <label key={emoji} className="picker-option" title={`图标 ${emoji}`}>
                <input type="radio" name={`${id}-icon`} className="picker-input" checked={icon === emoji} onChange={() => setIcon(emoji)} aria-label={`图标 ${emoji}`} />
                <span className="icon-option" aria-hidden="true">
                  {emoji}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field countdown-calendar">
          <legend>日期</legend>
          <div className="countdown-segments" role="radiogroup" aria-label="历法">
            {(['solar', 'lunar'] as const).map((value) => (
              <label key={value} className={`countdown-segment ${calendar === value ? 'countdown-segment-active' : ''}`}>
                <input type="radio" name={`${id}-calendar`} className="picker-input" checked={calendar === value} onChange={() => setCalendar(value)} />
                {value === 'solar' ? '公历' : '农历'}
              </label>
            ))}
          </div>
          <label htmlFor={`${id}-date`} className="visually-hidden">
            日期
          </label>
          <input id={`${id}-date`} type="date" required value={date} onChange={(e) => setDate(e.target.value)} aria-describedby={`${id}-lunar`} />
          <p id={`${id}-lunar`} className="field-hint" aria-live="polite">
            {calendar === 'lunar' ? (lunarText ?? ' ') : ' '}
          </p>
        </fieldset>
        <div className="field">
          <label htmlFor={`${id}-repeat`}>重复</label>
          <select id={`${id}-repeat`} value={repeat} onChange={(e) => setRepeat(e.target.value as CountdownRepeat)}>
            <option value="none">不重复</option>
            <option value="yearly">{calendar === 'lunar' ? '每年（农历）' : '每年'}</option>
          </select>
        </div>
        <fieldset className="field countdown-reminders">
          <legend>提醒</legend>
          <div className="countdown-reminder-options">
            {PRESET_REMINDERS.map((r) => {
              const lead = r.type === 'day' ? r.daysBefore : 0;
              return (
                <label key={reminderKey(r)} className="countdown-reminder-option">
                  <input
                    type="checkbox"
                    checked={leads.has(lead)}
                    onChange={() =>
                      setLeads((current) => {
                        const next = new Set(current);
                        if (!next.delete(lead)) next.add(lead);
                        return next;
                      })
                    }
                  />
                  {describeReminder(r, allDayReminderTime).replace(/（.*）$/, '')}
                </label>
              );
            })}
          </div>
          <div className="countdown-reminder-time">
            <label htmlFor={`${id}-time`}>提醒时间</label>
            <input id={`${id}-time`} type="time" value={time} disabled={leads.size === 0} onChange={(e) => setTime(e.target.value || allDayReminderTime)} />
          </div>
          {leads.size > 0 && <ReminderChannelsRow channels={channels} value={channelIds} onChange={setChannelIds} />}
        </fieldset>
        <div className="field field-switch">
          <label htmlFor={`${id}-pinned`}>置顶</label>
          <input id={`${id}-pinned`} type="checkbox" role="switch" className="ui-switch" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        </div>
        <div className="ui-dialog-footer">
          <Button onClick={onCancel}>取消</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? '正在保存…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
