import { LIST_COLORS, LIST_ICONS, type Folder, type TaskList } from '@dida/shared';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Dialog } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

export interface ListDraft {
  name: string;
  color: string | null;
  icon: string | null;
  folderId: string | null;
}

const COLOR_NAMES: Record<(typeof LIST_COLORS)[number], string> = {
  '#ff6161': '红色',
  '#ffac38': '橙色',
  '#ffd324': '黄色',
  '#e6ea49': '黄绿色',
  '#35d870': '绿色',
  '#4ca1ff': '蓝色',
  '#6e75f4': '靛蓝色',
  '#ad73ff': '紫色',
  '#ff8ad8': '粉色',
  '#9e9fa3': '灰色',
};

/** Create or edit a 清单: name, colour, icon and 文件夹 (spec 用户故事 13、14). */
export function ListDialog({
  list,
  defaultFolderId,
  folders,
  onCancel,
  onSave,
}: {
  list: TaskList | null;
  defaultFolderId: string | null;
  folders: Folder[];
  onCancel: () => void;
  onSave: (draft: ListDraft) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(list?.name ?? '');
  const [color, setColor] = useState<string | null>(list?.color ?? null);
  const [icon, setIcon] = useState<string | null>(list?.icon ?? null);
  const [folderId, setFolderId] = useState<string | null>(list ? list.folderId : defaultFolderId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError('请输入清单名称');
      return;
    }
    setSaving(true);
    await onSave({ name: name.trim(), color, icon, folderId });
    setSaving(false);
  }

  return (
    <Dialog title={list ? '编辑清单' : '添加清单'} onClose={onCancel}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-name`}>名称</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={64}
            autoFocus
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
          <legend>颜色</legend>
          <div className="picker-options">
            <SwatchOption group={`${id}-color`} label="无颜色" checked={color === null} onChange={() => setColor(null)}>
              <span className="swatch swatch-none" />
            </SwatchOption>
            {LIST_COLORS.map((c) => (
              <SwatchOption key={c} group={`${id}-color`} label={COLOR_NAMES[c]} checked={color === c} onChange={() => setColor(c)}>
                <span className="swatch" style={{ background: c }} />
              </SwatchOption>
            ))}
          </div>
        </fieldset>
        <fieldset className="field picker">
          <legend>图标</legend>
          <div className="picker-options">
            <SwatchOption group={`${id}-icon`} label="默认图标" checked={icon === null} onChange={() => setIcon(null)}>
              <span className="icon-option">
                <Icon name="list" />
              </span>
            </SwatchOption>
            {LIST_ICONS.map((emoji) => (
              <SwatchOption key={emoji} group={`${id}-icon`} label={`图标 ${emoji}`} checked={icon === emoji} onChange={() => setIcon(emoji)}>
                <span className="icon-option" aria-hidden="true">
                  {emoji}
                </span>
              </SwatchOption>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor={`${id}-folder`}>文件夹</label>
          <select id={`${id}-folder`} value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value || null)}>
            <option value="">无</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
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

/** A radio button drawn as a swatch; the label is its accessible name. */
function SwatchOption({
  group,
  label,
  checked,
  onChange,
  children,
}: {
  group: string;
  label: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label className="picker-option" title={label}>
      <input type="radio" name={group} className="picker-input" checked={checked} onChange={onChange} aria-label={label} />
      {children}
    </label>
  );
}

/** Create or rename a 文件夹. */
export function FolderDialog({
  folder,
  onCancel,
  onSave,
}: {
  folder: Folder | null;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(folder?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError('请输入文件夹名称');
      return;
    }
    setSaving(true);
    await onSave(name.trim());
    setSaving(false);
  }

  return (
    <Dialog title={folder ? '重命名文件夹' : '添加文件夹'} onClose={onCancel}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-name`}>文件夹名称</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={64}
            autoFocus
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

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} autoFocus>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="dialog-message">{message}</p>
    </Dialog>
  );
}
