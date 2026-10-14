import { parseSmartInput, type SmartInputSettings, type SmartParseResult, type SmartToken } from '@dida/shared';
import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../ui/Icon.js';

/** What 智能识别 needs; null when it is switched off in 设置. */
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

/**
 * 添加任务 with 智能识别 (spec 用户故事 51–58): the recognised parts are
 * highlighted in the field; clicking one (or Tab to it and Enter) cancels it
 * so it stays plain text. Enter saves with what is recognised.
 *
 * The highlights are a layer laid exactly over the input text: the text in it
 * is transparent, only the highlight backgrounds show, and only the
 * highlights take clicks (the rest falls through to the input).
 */
export function QuickAdd({
  target,
  onAdd,
  smart,
}: {
  target: string;
  onAdd: (title: string, smart: SmartParseResult | null) => Promise<boolean>;
  smart: SmartAddOptions | null;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [ignored, setIgnored] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => {
    if (!smart || !text.trim()) return null;
    return parseSmartInput(text, {
      now: smart.now,
      timeZone: smart.timeZone,
      fuzzyTimes: smart.settings,
      lists: smart.lists,
      keepText: smart.settings.keepText,
      ignored,
    });
  }, [smart, text, ignored]);
  const tokens = parsed?.tokens ?? [];

  // Keep the highlights over their text when the input scrolls sideways.
  const syncScroll = () => setScroll(input.current?.scrollLeft ?? 0);
  useLayoutEffect(syncScroll, [text]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    const result = parsed && parsed.tokens.length > 0 ? parsed : null;
    setBusy(true);
    // Keep the text if saving failed so nothing typed is lost.
    if (await onAdd(result ? result.title : text.trim(), result)) {
      setText('');
      setIgnored([]);
    }
    setBusy(false);
  }

  function cancel(token: SmartToken) {
    setIgnored((prev) => [...prev, token.text]);
    input.current?.focus();
  }

  const summaryId = `${id}-smart`;
  return (
    <form className="quick-add" onSubmit={submit} aria-label="添加任务">
      <span className="quick-add-icon" aria-hidden="true">
        <Icon name="plus" size={16} />
      </span>
      <div className="quick-add-field">
        <input
          ref={input}
          className="quick-add-input"
          aria-label="添加任务"
          aria-describedby={tokens.length > 0 ? summaryId : undefined}
          placeholder={`添加任务至"${target}"，回车即可保存`}
          value={text}
          maxLength={512}
          onChange={(e) => {
            setText(e.target.value);
            // A cancelled part no longer typed may be recognised again.
            setIgnored((prev) => prev.filter((t) => e.target.value.includes(t)));
          }}
          onScroll={syncScroll}
          onKeyUp={syncScroll}
          onSelect={syncScroll}
          enterKeyHint="done"
        />
        {tokens.length > 0 && (
          <div className="quick-add-highlights" data-testid="smart-highlights">
            <div className="quick-add-highlights-text" style={{ transform: `translateX(${-scroll}px)` }}>
              {segments(text, tokens).map((s) =>
                s.token ? (
                  <button
                    key={s.start}
                    type="button"
                    className="smart-token"
                    data-kind={s.token.kind}
                    aria-label={`取消识别${KIND_LABELS[s.token.kind]}“${s.token.text}”`}
                    title="点击取消识别"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => cancel(s.token as SmartToken)}
                  >
                    {s.text}
                  </button>
                ) : (
                  <span key={s.start}>{s.text}</span>
                ),
              )}
            </div>
          </div>
        )}
      </div>
      {tokens.length > 0 && (
        <span id={summaryId} className="visually-hidden" aria-live="polite">
          已识别：{tokens.map((t) => `${KIND_LABELS[t.kind]}“${t.text}”`).join('，')}
        </span>
      )}
    </form>
  );
}

function segments(text: string, tokens: SmartToken[]): { start: number; text: string; token?: SmartToken }[] {
  const out: { start: number; text: string; token?: SmartToken }[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start > at) out.push({ start: at, text: text.slice(at, token.start) });
    out.push({ start: token.start, text: token.text, token });
    at = token.end;
  }
  if (at < text.length) out.push({ start: at, text: text.slice(at) });
  return out;
}
