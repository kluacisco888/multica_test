import { formatFileSize, type Attachment } from '@dida/shared';
import { useEffect, useState, type ChangeEvent, type RefObject } from 'react';
import * as api from '../api.js';
import { Dialog, IconButton } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';
import { ConfirmDialog } from './dialogs.js';

/*
 * 附件 of a 任务 (spec 用户故事 38): images as thumbnails, other files as
 * cards; images and PDF open in a preview dialog, everything can be
 * downloaded. The upload button lives in the detail footer and clicks the
 * hidden file input passed in as `inputRef`.
 */

export function TaskAttachments({
  taskId,
  inputRef,
  onError,
}: {
  taskId: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onError: (error: unknown) => void;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState<{ key: string; name: string }[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [confirming, setConfirming] = useState<Attachment | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchAttachments(taskId)
      .then((loaded) => {
        if (!cancelled) setAttachments(loaded);
      })
      .catch((e: unknown) => {
        if (!cancelled) onError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, onError]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = ''; // picking the same file again fires change again
    for (const file of files) {
      const key = crypto.randomUUID();
      setUploading((list) => [...list, { key, name: file.name }]);
      try {
        const added = await api.uploadAttachment(taskId, file);
        setAttachments((prev) => [...prev, added]);
      } catch (e) {
        onError(e);
      } finally {
        setUploading((list) => list.filter((u) => u.key !== key));
      }
    }
  }

  async function remove(attachment: Attachment) {
    try {
      await api.deleteAttachment(attachment.id);
      setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setConfirming(null);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="attachments" aria-label="附件" hidden={attachments.length === 0 && uploading.length === 0}>
      <input ref={inputRef} type="file" multiple className="attachments-input" aria-label="选择要上传的附件" tabIndex={-1} onChange={(e) => void upload(e)} />
      <ul className="attachments-list" aria-label="附件列表">
        {attachments.map((a) => (
          <li key={a.id} className={`attachment ${a.preview === 'image' ? 'attachment-image' : 'attachment-file'}`}>
            {a.preview === 'image' ? (
              <button type="button" className="attachment-thumb" aria-label={`预览：${a.fileName}`} onClick={() => setPreview(a)}>
                <img src={api.attachmentUrl(a.id)} alt={a.fileName} loading="lazy" />
              </button>
            ) : a.preview ? (
              <button type="button" className="attachment-card" aria-label={`预览：${a.fileName}`} onClick={() => setPreview(a)}>
                <FileCardContent attachment={a} />
              </button>
            ) : (
              <a className="attachment-card" href={api.attachmentUrl(a.id, true)} download={a.fileName} aria-label={`下载：${a.fileName}`}>
                <FileCardContent attachment={a} />
              </a>
            )}
            <span className="attachment-actions">
              {a.preview && (
                <a className="ui-icon-button attachment-download" href={api.attachmentUrl(a.id, true)} download={a.fileName} aria-label={`下载：${a.fileName}`} title="下载">
                  <Icon name="download" size={16} />
                </a>
              )}
              <IconButton icon="trash" size={16} label={`删除附件：${a.fileName}`} className="attachment-delete" onClick={() => setConfirming(a)} />
            </span>
          </li>
        ))}
        {uploading.map(({ key, name }) => (
          <li key={key} className="attachment attachment-file attachment-uploading" aria-busy="true">
            <span className="attachment-card">
              <span className="attachment-icon" aria-hidden="true">
                <Icon name="attachment" size={18} />
              </span>
              <span className="attachment-meta">
                <span className="attachment-name">{name}</span>
                <span className="attachment-size">正在上传…</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
      {preview && <PreviewDialog attachment={preview} onClose={() => setPreview(null)} />}
      {confirming && (
        <ConfirmDialog
          title="删除附件"
          message={`删除后无法恢复「${confirming.fileName}」。`}
          confirmLabel="删除"
          onCancel={() => setConfirming(null)}
          onConfirm={() => remove(confirming)}
        />
      )}
    </section>
  );
}

function FileCardContent({ attachment }: { attachment: Attachment }) {
  return (
    <>
      <span className="attachment-icon" aria-hidden="true">
        <Icon name="file" size={20} />
        <span className="attachment-ext">{extensionOf(attachment.fileName)}</span>
      </span>
      <span className="attachment-meta">
        <span className="attachment-name">{attachment.fileName}</span>
        <span className="attachment-size">{formatFileSize(attachment.size)}</span>
      </span>
    </>
  );
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 && dot >= fileName.length - 6 ? fileName.slice(dot + 1).toUpperCase() : '';
}

function PreviewDialog({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  return (
    <Dialog
      title={attachment.fileName}
      onClose={onClose}
      className="attachment-preview"
      footer={
        <a className="ui-button ui-button-primary" href={api.attachmentUrl(attachment.id, true)} download={attachment.fileName}>
          下载
        </a>
      }
    >
      {attachment.preview === 'image' ? (
        <img className="attachment-preview-image" src={api.attachmentUrl(attachment.id)} alt={attachment.fileName} />
      ) : (
        <iframe className="attachment-preview-pdf" src={api.attachmentUrl(attachment.id)} title={`PDF 预览：${attachment.fileName}`} />
      )}
    </Dialog>
  );
}
