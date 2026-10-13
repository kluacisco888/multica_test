import { CHECKLIST_ITEM_TITLE_MAX_LENGTH, compareSortKeys, keyBetween, type ChecklistItem } from '@dida/shared';
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type RefObject } from 'react';
import * as api from '../api.js';
import { IconButton, MenuButton, TaskCheckbox } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

/*
 * 检查清单 mode content of a 任务 (spec 用户故事 37): 检查项 can be added,
 * checked, renamed, deleted and reordered — by mouse drag on desktop, or
 * with 上移 / 下移 in each 检查项's menu (keyboard, touch).
 */

type Position = 'before' | 'after';

export function ChecklistEditor({ taskId, onError }: { taskId: string; onError: (error: unknown) => void }) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [hint, setHint] = useState<{ id: string; position: Position } | null>(null);
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchChecklistItems(taskId)
      .then((loaded) => {
        if (!cancelled) setItems(loaded);
      })
      .catch((e: unknown) => {
        if (!cancelled) onError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, onError]);

  const sorted = items ? [...items].sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id)) : [];

  function put(item: ChecklistItem) {
    setItems((prev) => prev && [...prev.filter((i) => i.id !== item.id), item]);
  }

  async function add(title: string): Promise<boolean> {
    try {
      put(await api.createChecklistItem(taskId, { title, sortOrder: keyBetween(sorted.at(-1)?.sortOrder ?? null, null) }));
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  }

  async function update(item: ChecklistItem, patch: Partial<Pick<ChecklistItem, 'title' | 'completed' | 'sortOrder'>>) {
    put({ ...item, ...patch }); // optimistic: checking should feel instant
    try {
      put(await api.updateChecklistItem(item.id, patch));
    } catch (e) {
      put(item);
      onError(e);
    }
  }

  async function remove(item: ChecklistItem) {
    setItems((prev) => prev && prev.filter((i) => i.id !== item.id));
    try {
      await api.deleteChecklistItem(item.id);
    } catch (e) {
      put(item);
      onError(e);
    }
  }

  /** Move `id` next to `targetId`; only the moved 检查项 gets a new key. */
  function move(id: string, targetId: string, position: Position) {
    const item = sorted.find((i) => i.id === id);
    const rest = sorted.filter((i) => i.id !== id);
    const index = rest.findIndex((i) => i.id === targetId);
    if (!item || index < 0) return;
    const at = position === 'before' ? index : index + 1;
    const before = rest[at - 1]?.sortOrder ?? null;
    const after = rest[at]?.sortOrder ?? null;
    if (at === sorted.indexOf(item)) return; // same place
    void update(item, { sortOrder: keyBetween(before, after) });
  }

  function dragProps(item: ChecklistItem) {
    const position = (event: DragEvent<HTMLElement>): Position => {
      const rect = event.currentTarget.getBoundingClientRect();
      return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
    };
    return {
      draggable: true,
      'data-drop': hint?.id === item.id ? hint.position : undefined,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
        setDragged(item.id);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!dragged || dragged === item.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const p = position(event);
        if (hint?.id !== item.id || hint.position !== p) setHint({ id: item.id, position: p });
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && hint?.id === item.id) setHint(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        if (dragged && dragged !== item.id) move(dragged, item.id, position(event));
        setDragged(null);
        setHint(null);
      },
      onDragEnd: () => {
        setDragged(null);
        setHint(null);
      },
    };
  }

  if (items === null) {
    return (
      <p className="checklist-status" role="status">
        正在加载…
      </p>
    );
  }

  return (
    <div className="checklist">
      {sorted.length > 0 && (
        <ul className="checklist-items" aria-label="检查项">
          {sorted.map((item, index) => {
            const prev = sorted[index - 1];
            const next = sorted[index + 1];
            return (
              <li key={item.id} className={`checklist-item ${item.completed ? 'checklist-item-done' : ''}`} {...dragProps(item)}>
                <span className="checklist-grip" aria-hidden="true">
                  <Icon name="grip" size={14} />
                </span>
                <TaskCheckbox checked={item.completed} label={item.title} onChange={(completed) => void update(item, { completed })} />
                <ItemTitle
                  key={item.title /* re-start the draft when the saved text changes */}
                  item={item}
                  index={index}
                  onSave={(title) => void update(item, { title })}
                  onEnter={() => addRef.current?.focus()}
                />
                <MenuButton
                  label={`检查项「${item.title}」更多操作`}
                  className="checklist-item-menu"
                  items={[
                    { label: '上移', icon: 'arrowUp', disabled: !prev, onSelect: () => prev && move(item.id, prev.id, 'before') },
                    { label: '下移', icon: 'arrowDown', disabled: !next, onSelect: () => next && move(item.id, next.id, 'after') },
                    { label: '删除', icon: 'trash', danger: true, onSelect: () => void remove(item) },
                  ]}
                />
                <IconButton
                  icon="close"
                  size={14}
                  label={`删除检查项「${item.title}」`}
                  className="checklist-item-delete"
                  onClick={() => void remove(item)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <AddItem inputRef={addRef} onAdd={add} />
    </div>
  );
}

function ItemTitle({ item, index, onSave, onEnter }: { item: ChecklistItem; index: number; onSave: (title: string) => void; onEnter: () => void }) {
  const [draft, setDraft] = useState(item.title);

  function commit() {
    const title = draft.trim();
    if (!title) setDraft(item.title); // a 检查项 always keeps text; delete it with ×
    else if (title !== item.title) onSave(title);
  }

  return (
    <input
      className="checklist-title"
      aria-label={`检查项 ${index + 1}`}
      value={draft}
      maxLength={CHECKLIST_ITEM_TITLE_MAX_LENGTH}
      draggable={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit();
          onEnter();
        } else if (e.key === 'Escape') {
          setDraft(item.title);
        }
      }}
    />
  );
}

function AddItem({ inputRef, onAdd }: { inputRef: RefObject<HTMLInputElement | null>; onAdd: (title: string) => Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    if (await onAdd(trimmed)) setTitle('');
    setBusy(false);
  }

  return (
    <form className="checklist-add" onSubmit={submit} aria-label="添加检查项">
      <span className="checklist-add-icon" aria-hidden="true">
        <Icon name="plus" size={14} />
      </span>
      <input
        ref={inputRef}
        className="checklist-title"
        aria-label="添加检查项"
        placeholder="添加检查项，回车保存"
        value={title}
        maxLength={CHECKLIST_ITEM_TITLE_MAX_LENGTH}
        onChange={(e) => setTitle(e.target.value)}
        enterKeyHint="done"
      />
    </form>
  );
}
