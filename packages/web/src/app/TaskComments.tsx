import { COMMENT_MAX_LENGTH, type Comment } from '@dida/shared';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import * as api from '../api.js';
import { Button, MenuButton } from '../ui/controls.js';
import { ConfirmDialog } from './dialogs.js';

/*
 * 评论 of a 任务 (spec 用户故事 39): a thread at the bottom of the detail
 * pane, oldest first. Each 评论 can be edited and deleted from its menu. The
 * section appears once there is a 评论, or when the footer's 评论 button
 * focuses the composer (`composerRef`). No @ mentions (out of scope).
 */

export function TaskComments({
  taskId,
  userName,
  timeZone,
  composerOpen,
  composerRef,
  onError,
}: {
  taskId: string;
  userName: string;
  timeZone: string;
  /** Show the composer even without 评论 (the footer button was used). */
  composerOpen: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onError: (error: unknown) => void;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Comment | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchComments(taskId)
      .then((loaded) => {
        if (!cancelled) setComments(loaded);
      })
      .catch((e: unknown) => {
        if (!cancelled) onError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, onError]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const added = await api.createComment(taskId, content);
      setComments((prev) => [...(prev ?? []), added]);
      setDraft('');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function save(comment: Comment, content: string): Promise<boolean> {
    try {
      const updated = await api.updateComment(comment.id, content);
      setComments((prev) => prev && prev.map((c) => (c.id === updated.id ? updated : c)));
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  }

  async function remove(comment: Comment) {
    try {
      await api.deleteComment(comment.id);
      setComments((prev) => prev && prev.filter((c) => c.id !== comment.id));
      setConfirming(null);
    } catch (e) {
      onError(e);
    }
  }

  const list = comments ?? [];
  if (list.length === 0 && !composerOpen) return null;

  return (
    <section className="comments" aria-labelledby={`comments-heading-${taskId}`}>
      <h2 className="comments-heading" id={`comments-heading-${taskId}`}>
        评论 {list.length > 0 && <span className="comments-count">{list.length}</span>}
      </h2>
      {list.length > 0 && (
        <ul className="comments-list" aria-label="评论列表">
          {list.map((comment) => (
            <li key={comment.id} className="comment">
              <span className="comment-avatar" aria-hidden="true">
                {userName.slice(0, 1).toUpperCase()}
              </span>
              <div className="comment-main">
                <div className="comment-head">
                  <span className="comment-author">{userName}</span>
                  <time className="comment-time" dateTime={comment.createdAt}>
                    {formatCommentTime(comment.createdAt, timeZone)}
                  </time>
                  {comment.editedAt && <span className="comment-edited">已编辑</span>}
                  <MenuButton
                    label="评论操作"
                    className="comment-menu"
                    items={[
                      { label: '编辑', icon: 'edit', onSelect: () => setEditing(comment.id) },
                      { label: '删除', icon: 'trash', danger: true, onSelect: () => setConfirming(comment) },
                    ]}
                  />
                </div>
                {editing === comment.id ? (
                  <CommentEditor
                    initial={comment.content}
                    onCancel={() => setEditing(null)}
                    onSave={async (content) => {
                      if (content === comment.content || (await save(comment, content))) setEditing(null);
                    }}
                  />
                ) : (
                  <p className="comment-content">{comment.content}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="comment-composer" onSubmit={(e) => void submit(e)}>
        <textarea
          ref={composerRef}
          className="comment-input"
          aria-label="写评论"
          placeholder="写评论，Enter 发送，Shift+Enter 换行"
          rows={1}
          maxLength={COMMENT_MAX_LENGTH}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <Button type="submit" variant="primary" className="comment-send" disabled={busy || !draft.trim()}>
          发送
        </Button>
      </form>
      {confirming && (
        <ConfirmDialog
          title="删除评论"
          message="确定删除这条评论吗？"
          confirmLabel="删除"
          onCancel={() => setConfirming(null)}
          onConfirm={() => remove(confirming)}
        />
      )}
    </section>
  );
}

function CommentEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (value.trim()) void onSave(value.trim());
    }
  }

  return (
    <div className="comment-editor">
      <textarea
        ref={ref}
        className="comment-input"
        aria-label="编辑评论"
        maxLength={COMMENT_MAX_LENGTH}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="comment-editor-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button variant="primary" disabled={!value.trim()} onClick={() => void onSave(value.trim())}>
          保存
        </Button>
      </div>
    </div>
  );
}

/** "10月13日 10:30" in the user's time zone; the year is added when it is not this year. */
export function formatCommentTime(iso: string, timeZone: string, now = new Date()): string {
  const parts = (d: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
  const p = parts(new Date(iso));
  const thisYear = parts(now).year;
  return `${p.year === thisYear ? '' : `${p.year}年`}${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
}
