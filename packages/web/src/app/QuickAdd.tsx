import { parseSmartInput, type SmartInputSettings, type SmartParseResult, type SmartToken, type TaskDatesInput } from '@dida/shared';
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type InputHTMLAttributes } from 'react';
import { Icon } from '../ui/Icon.js';

/** What 智能识别 needs; null when 日期识别 and 标签识别 are both off in 设置. */
export interface SmartAddOptions {
  settings: SmartInputSettings;
  lists: readonly { id: string; name: string }[];
  now: Date;
  timeZone: string;
}

const KIND_LABELS: Record<SmartToken['kind'], string> = {
  date: '日期',
  time: '时间',
  repeat: '重复',
  reminder: '提醒',
  tag: '标签',
  list: '清单',
  priority: '优先级',
};

export interface SmartTitle {
  text: string;
  setText: (text: string) => void;
  tokens: SmartToken[];
  /** 取消识别: the tokens' text stays plain text (all of a highlight's tokens at once). */
  ignore: (tokens: readonly SmartToken[]) => void;
  /** What to save: the parse result when something is recognised, else null (save `text` as typed). */
  result: SmartParseResult | null;
  reset: () => void;
}

/**
 * The text of a new-task field and what 智能识别 finds in it (spec 用户故事 51–58).
 * `defaultDates`: the date the field adds by itself (the clicked 日历 day or
 * slot, tomorrow in 明天 …), the anchor when no date is typed.
 */
export function useSmartTitle(smart: SmartAddOptions | null, defaultDates: TaskDatesInput | null = null): SmartTitle {
  const [text, setTextState] = useState('');
  const [ignored, setIgnored] = useState<string[]>([]);
  const parsed = useMemo(() => {
    if (!smart || !text.trim()) return null;
    return parseSmartInput(text, {
      now: smart.now,
      timeZone: smart.timeZone,
      fuzzyTimes: smart.settings,
      lists: smart.lists,
      dateParse: smart.settings.dateParse,
      tagParse: smart.settings.tagParse,
      removeDate: smart.settings.removeDate,
      removeTag: smart.settings.removeTag,
      ignored,
      defaultDates,
    });
  }, [smart, text, ignored, defaultDates]);
  const tokens = parsed?.tokens ?? [];
  return {
    text,
    setText(next) {
      setTextState(next);
      // A cancelled part no longer typed may be recognised again.
      setIgnored((prev) => prev.filter((t) => next.includes(t)));
    },
    tokens,
    ignore: (cancelled) => setIgnored((prev) => [...prev, ...cancelled.map((t) => t.text)]),
    result: parsed && tokens.length > 0 ? parsed : null,
    reset() {
      setTextState('');
      setIgnored([]);
    },
  };
}

type FieldInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'aria-describedby'>;

/**
 * A new-task input with 智能识别 highlights: a layer laid exactly over the
 * input's text (same font and padding, read from the input itself), with
 * transparent text so only the highlight backgrounds show. Only the
 * highlights take clicks; clicking one (or Tab to it and Enter) cancels it.
 * As in 滴答, tokens next to each other or only spaces apart (明天上午10点,
 * #工作 !高) are one highlight, cancelled as a whole.
 */
export function SmartTitleInput({ smart, ...inputProps }: FieldInputProps & { smart: SmartTitle }) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState<CSSProperties>({});
  const [scroll, setScroll] = useState(0);
  const { text, tokens } = smart;

  // Match the input's text box, so the highlights sit over their characters.
  useLayoutEffect(() => {
    const input = own.current;
    if (!input || tokens.length === 0) return;
    const s = getComputedStyle(input);
    const left = input.offsetLeft + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
    setBox({
      left,
      top: input.offsetTop,
      width: input.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
      height: input.offsetHeight,
      font: s.font,
      letterSpacing: s.letterSpacing,
    });
    setScroll(input.scrollLeft);
  }, [text, tokens.length]);

  const syncScroll = () => setScroll(own.current?.scrollLeft ?? 0);
  const summaryId = `${id}-smart`;

  return (
    <div className="smart-field">
      <input
        {...inputProps}
        ref={own}
        value={text}
        aria-describedby={tokens.length > 0 ? summaryId : undefined}
        onChange={(e) => smart.setText(e.target.value)}
        onScroll={syncScroll}
        onKeyUp={syncScroll}
        onSelect={syncScroll}
      />
      {tokens.length > 0 && (
        <>
          <div className="smart-highlights" data-testid="smart-highlights" style={box}>
            <div className="smart-highlights-text" style={{ transform: `translateX(${-scroll}px)` }}>
              {segments(text, tokens).map((s) =>
                s.tokens ? (
                  <button
                    key={s.start}
                    type="button"
                    className="smart-token"
                    data-kind={s.tokens.map((t) => t.kind).join(' ')}
                    aria-label={`取消识别${s.tokens.map(describe).join('、')}`}
                    title="点击取消识别"
                    onMouseDown={(e) => e.preventDefault()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      smart.ignore(s.tokens ?? []);
                      own.current?.focus();
                    }}
                  >
                    {s.text}
                  </button>
                ) : (
                  <span key={s.start}>{s.text}</span>
                ),
              )}
            </div>
          </div>
          <span id={summaryId} className="visually-hidden" aria-live="polite">
            已识别：{tokens.map(describe).join('，')}
          </span>
        </>
      )}
    </div>
  );
}

/** 添加任务 at the top of a list (spec 用户故事 51–58). Enter saves with what is recognised. */
export function QuickAdd({
  target,
  onAdd,
  smart,
  defaultDates = null,
}: {
  target: string;
  onAdd: (title: string, smart: SmartParseResult | null) => Promise<boolean>;
  smart: SmartAddOptions | null;
  /** The date the view gives new tasks (今天 / 明天 …). */
  defaultDates?: TaskDatesInput | null;
}) {
  const title = useSmartTitle(smart, defaultDates);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.text.trim() || busy) return;
    setBusy(true);
    // Keep the text if saving failed so nothing typed is lost.
    if (await submitSmart(title, onAdd)) title.reset();
    setBusy(false);
  }

  return (
    <form className="quick-add" onSubmit={submit} aria-label="添加任务">
      <span className="quick-add-icon" aria-hidden="true">
        <Icon name="plus" size={16} />
      </span>
      <SmartTitleInput
        smart={title}
        className="quick-add-input"
        aria-label="添加任务"
        placeholder={`添加任务至"${target}"，回车即可保存`}
        maxLength={512}
        enterKeyHint="done"
      />
    </form>
  );
}

/** Call `onAdd` with the cleaned title and the parse result, or the typed text and null. */
export function submitSmart(title: SmartTitle, onAdd: (title: string, smart: SmartParseResult | null) => Promise<boolean>): Promise<boolean> {
  const result = title.result;
  return onAdd(result ? result.title : title.text.trim(), result);
}

const describe = (t: SmartToken) => `${KIND_LABELS[t.kind]}“${t.text}”`;

/**
 * `text` cut into plain runs and highlights. Tokens (in text order, not
 * overlapping) with nothing or only whitespace between them share one
 * highlight, which spans the whitespace too.
 */
function segments(text: string, tokens: readonly SmartToken[]): { start: number; text: string; tokens?: SmartToken[] }[] {
  const groups: { start: number; end: number; tokens: SmartToken[] }[] = [];
  for (const token of tokens) {
    const last = groups.at(-1);
    if (last && /^\s*$/.test(text.slice(last.end, token.start))) {
      last.end = token.end;
      last.tokens.push(token);
    } else {
      groups.push({ start: token.start, end: token.end, tokens: [token] });
    }
  }
  const out: { start: number; text: string; tokens?: SmartToken[] }[] = [];
  let at = 0;
  for (const g of groups) {
    if (g.start > at) out.push({ start: at, text: text.slice(at, g.start) });
    out.push({ start: g.start, text: text.slice(g.start, g.end), tokens: g.tokens });
    at = g.end;
  }
  if (at < text.length) out.push({ start: at, text: text.slice(at) });
  return out;
}
