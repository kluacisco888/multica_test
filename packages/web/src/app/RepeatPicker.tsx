import {
  describeRepeatRule,
  REPEAT_MAX_COUNT,
  REPEAT_MAX_INTERVAL,
  repeatRuleSchema,
  weekday,
  WEEKDAY_NAMES,
  type RepeatEnd,
  type RepeatFrequency,
  type RepeatRule,
  type RepeatRuleInput,
} from '@dida/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, MenuButton, type MenuItem } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

/*
 * 重复规则 controls inside the date picker (spec 用户故事 41–49), like 滴答:
 * a 重复 row opening a menu of common rules, and 自定义 opening an editor with
 * frequency, interval, weekdays, 按截止日期 / 按完成日期, 跳过法定节假日 and
 * the end condition.
 */

const rule = (input: RepeatRuleInput): RepeatRule => repeatRuleSchema.parse(input);

/** Compare in schema key order (rules read back from jsonb come with reordered keys). */
const sameRule = (a: RepeatRule | null, b: RepeatRule | null) =>
  a === null || b === null ? a === b : JSON.stringify(rule(a)) === JSON.stringify(rule(b));

/** The preset rules of the 重复 menu, for a series starting on `anchor`. */
export function repeatPresets(anchor: string): { label: string; rule: RepeatRule }[] {
  const [, month, day] = anchor.split('-').map(Number);
  return [
    { label: '每天', rule: rule({ freq: 'daily' }) },
    { label: `每周（${WEEKDAY_NAMES[weekday(anchor)]}）`, rule: rule({ freq: 'weekly', weekdays: [weekday(anchor)] }) },
    { label: `每月（${day}日）`, rule: rule({ freq: 'monthly', monthDay: day }) },
    { label: `每年（${month}月${day}日）`, rule: rule({ freq: 'yearly', month, monthDay: day }) },
    { label: '每周工作日（周一至周五）', rule: rule({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5] }) },
    { label: '法定工作日', rule: rule({ freq: 'workday' }) },
  ];
}

/** The 重复 row of the date picker: shows the rule, opens the preset menu. */
export function RepeatRow({
  value,
  anchor,
  onChange,
  onCustom,
}: {
  value: RepeatRule | null;
  anchor: string;
  onChange: (rule: RepeatRule | null) => void;
  onCustom: () => void;
}) {
  const presets = repeatPresets(anchor);
  const text = value ? describeRepeatRule(value, anchor) : '无';
  const isPreset = value === null || presets.some((p) => sameRule(p.rule, value));
  const items: MenuItem[] = [
    { label: '无', checked: value === null, onSelect: () => onChange(null) },
    ...presets.map((p) => ({ label: p.label, checked: sameRule(p.rule, value), onSelect: () => onChange(p.rule) })),
    { label: '自定义', checked: !isPreset, onSelect: onCustom },
  ];
  return (
    <div className="date-row date-row-repeat">
      <Icon name="repeat" size={16} />
      <span className="date-row-label" aria-hidden="true">
        重复
      </span>
      <MenuButton label={`重复：${text}`} items={items} align="end" className="date-repeat-menu" triggerClassName="date-repeat-trigger">
        <span className="date-repeat-value">{text}</span>
        <Icon name="chevronRight" size={14} />
      </MenuButton>
    </div>
  );
}

type Unit = RepeatFrequency;

const UNIT_OPTIONS: { value: Unit; label: string }[] = [
  { value: 'daily', label: '天' },
  { value: 'weekly', label: '周' },
  { value: 'monthly', label: '月' },
  { value: 'yearly', label: '年' },
  { value: 'workday', label: '工作日' },
  { value: 'restday', label: '休息日' },
  { value: 'month_first_workday', label: '每月第一个工作日' },
  { value: 'month_last_workday', label: '每月最后一个工作日' },
];
const INTERVAL_UNITS: Unit[] = ['daily', 'weekly', 'monthly', 'yearly'];
/** Weekday chips, Monday first. */
const WEEK_CHIPS = [1, 2, 3, 4, 5, 6, 0];
const CHIP_TEXT = ['日', '一', '二', '三', '四', '五', '六'];

interface EditorDraft {
  freq: Unit;
  interval: string;
  weekdays: number[];
  monthDay: string;
  basis: 'due' | 'completion';
  skipHolidays: boolean;
  endType: RepeatEnd['type'];
  until: string;
  count: string;
}

function draftOf(value: RepeatRule | null, anchor: string): EditorDraft {
  const anchorDay = Number(anchor.slice(8));
  const r = value ?? rule({ freq: 'daily' });
  return {
    freq: r.freq,
    interval: String(r.interval),
    weekdays: r.weekdays.length > 0 ? r.weekdays : [weekday(anchor)],
    monthDay: String(r.monthDay ?? anchorDay),
    basis: r.basis,
    skipHolidays: r.skipHolidays,
    endType: r.end.type,
    until: r.end.type === 'until' ? r.end.date : anchor,
    count: r.end.type === 'count' ? String(r.end.count) : '5',
  };
}

function ruleOf(d: EditorDraft, anchor: string): { rule: RepeatRule | null; error: string | null } {
  const interval = INTERVAL_UNITS.includes(d.freq) ? Number(d.interval) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > REPEAT_MAX_INTERVAL) {
    return { rule: null, error: `间隔应为 1–${REPEAT_MAX_INTERVAL}` };
  }
  const monthDay = Number(d.monthDay);
  if ((d.freq === 'monthly' || d.freq === 'yearly') && !(Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31)) {
    return { rule: null, error: '日期应为 1–31' };
  }
  if (d.freq === 'weekly' && d.weekdays.length === 0) return { rule: null, error: '请至少选择一天' };
  let end: RepeatEnd = { type: 'never' };
  if (d.endType === 'until') {
    if (!d.until) return { rule: null, error: '请选择结束日期' };
    if (d.until < anchor) return { rule: null, error: '结束日期不能早于截止日期' };
    end = { type: 'until', date: d.until };
  } else if (d.endType === 'count') {
    const count = Number(d.count);
    if (!Number.isInteger(count) || count < 1 || count > REPEAT_MAX_COUNT) return { rule: null, error: `次数应为 1–${REPEAT_MAX_COUNT}` };
    end = { type: 'count', count };
  }
  const parsed = repeatRuleSchema.safeParse({
    freq: d.freq,
    interval,
    ...(d.freq === 'weekly' ? { weekdays: d.weekdays } : {}),
    ...(d.freq === 'monthly' || d.freq === 'yearly' ? { monthDay } : {}),
    ...(d.freq === 'yearly' ? { month: Number(anchor.slice(5, 7)) } : {}),
    basis: d.basis,
    skipHolidays: d.skipHolidays,
    end,
  });
  return parsed.success ? { rule: parsed.data, error: null } : { rule: null, error: '重复规则不完整' };
}

/** 自定义重复: replaces the date panel until 确定 or 取消. */
export function RepeatEditor({
  value,
  anchor,
  onCancel,
  onSave,
}: {
  value: RepeatRule | null;
  anchor: string;
  onCancel: () => void;
  onSave: (rule: RepeatRule) => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(value, anchor));
  const uid = useId();
  const ref = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<EditorDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const { rule: result, error } = ruleOf(draft, anchor);
  const hasInterval = INTERVAL_UNITS.includes(draft.freq);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      // Back to the date panel, not out of the whole picker.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }

  function onBasisKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = draft.basis === 'due' ? 'completion' : 'due';
      update({ basis: next });
      ref.current?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-basis-${next}`)}`)?.focus();
    }
  }

  const basisOption = (basis: 'due' | 'completion', text: string) => (
    <button
      type="button"
      role="radio"
      id={`${uid}-basis-${basis}`}
      aria-checked={draft.basis === basis}
      tabIndex={draft.basis === basis ? 0 : -1}
      className="date-tab"
      onClick={() => update({ basis })}
      onKeyDown={onBasisKey}
    >
      {text}
    </button>
  );

  return (
    <div ref={ref} className="repeat-editor" role="group" aria-labelledby={`${uid}-title`} onKeyDown={onKeyDown}>
      <h2 id={`${uid}-title`} className="repeat-editor-title">
        自定义重复
      </h2>
      <div role="radiogroup" aria-label="重复方式" className="date-tabs">
        {basisOption('due', '按截止日期')}
        {basisOption('completion', '按完成日期')}
      </div>

      <div className="repeat-field repeat-every">
        <span aria-hidden="true">每</span>
        {hasInterval && (
          <>
            <label htmlFor={`${uid}-interval`} className="visually-hidden">
              间隔
            </label>
            <input
              id={`${uid}-interval`}
              className="date-time-input repeat-interval"
              type="number"
              inputMode="numeric"
              min={1}
              max={REPEAT_MAX_INTERVAL}
              value={draft.interval}
              onChange={(e) => update({ interval: e.target.value })}
            />
          </>
        )}
        <label htmlFor={`${uid}-freq`} className="visually-hidden">
          重复单位
        </label>
        <select
          id={`${uid}-freq`}
          className="settings-select repeat-unit"
          value={draft.freq}
          onChange={(e) => update({ freq: e.target.value as Unit })}
        >
          {UNIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {draft.freq === 'weekly' && (
        <div className="repeat-weekdays" role="group" aria-label="星期">
          {WEEK_CHIPS.map((d) => {
            const on = draft.weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                className="repeat-weekday"
                aria-pressed={on}
                aria-label={WEEKDAY_NAMES[d]}
                onClick={() => update({ weekdays: on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d] })}
              >
                {CHIP_TEXT[d]}
              </button>
            );
          })}
        </div>
      )}

      {(draft.freq === 'monthly' || draft.freq === 'yearly') && (
        <div className="repeat-field">
          <label htmlFor={`${uid}-monthday`}>{draft.freq === 'yearly' ? `${Number(anchor.slice(5, 7))}月的` : '每月的'}</label>
          <input
            id={`${uid}-monthday`}
            className="date-time-input repeat-interval"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            value={draft.monthDay}
            onChange={(e) => update({ monthDay: e.target.value })}
          />
          <span aria-hidden="true">日</span>
        </div>
      )}

      <div className="date-row">
        <input
          id={`${uid}-skip`}
          type="checkbox"
          className="date-allday"
          checked={draft.skipHolidays}
          onChange={(e) => update({ skipHolidays: e.target.checked })}
        />
        <label htmlFor={`${uid}-skip`}>跳过法定节假日</label>
      </div>

      <div className="repeat-field">
        <label htmlFor={`${uid}-end`}>结束重复</label>
        <select
          id={`${uid}-end`}
          className="settings-select repeat-end"
          value={draft.endType}
          onChange={(e) => update({ endType: e.target.value as RepeatEnd['type'] })}
        >
          <option value="never">永不</option>
          <option value="until">到某天</option>
          <option value="count">重复次数</option>
        </select>
        {draft.endType === 'until' && (
          <>
            <label htmlFor={`${uid}-until`} className="visually-hidden">
              结束日期
            </label>
            <input
              id={`${uid}-until`}
              className="date-time-input"
              type="date"
              value={draft.until}
              min={anchor}
              onChange={(e) => update({ until: e.target.value })}
            />
          </>
        )}
        {draft.endType === 'count' && (
          <>
            <label htmlFor={`${uid}-count`} className="visually-hidden">
              重复次数
            </label>
            <input
              id={`${uid}-count`}
              className="date-time-input repeat-interval"
              type="number"
              inputMode="numeric"
              min={1}
              max={REPEAT_MAX_COUNT}
              value={draft.count}
              onChange={(e) => update({ count: e.target.value })}
            />
            <span aria-hidden="true">次</span>
          </>
        )}
      </div>

      <p className="repeat-summary" aria-live="polite">
        {result ? describeRepeatRule(result, anchor) : <span className="date-error" role="alert">{error}</span>}
      </p>
      <div className="date-footer">
        <Button onClick={onCancel}>取消</Button>
        <Button variant="primary" disabled={!result} onClick={() => result && onSave(result)}>
          确定
        </Button>
      </div>
    </div>
  );
}

