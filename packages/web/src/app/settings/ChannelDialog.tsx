import {
  CHANNEL_TYPE_LABELS,
  QQ_MAIL_PRESET,
  SMTP_DEFAULT_PORTS,
  SMTP_SECURITY,
  SMTP_SECURITY_LABELS,
  type ChannelType,
  type NotificationChannel,
  type SmtpSecurity,
  type UpdateChannelRequest,
} from '@dida/shared';
import { cloneElement, useId, useState, type FormEvent, type ReactElement } from 'react';
import * as api from '../../api.js';
import { Button, Dialog } from '../../ui/controls.js';

type Provider = 'qq' | 'custom';

interface Draft {
  name: string;
  isDefault: boolean;
  webhookUrl: string;
  secret: string;
  clearSecret: boolean;
  provider: Provider;
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
  to: string;
}

function initialDraft(type: ChannelType, channel: NotificationChannel | null): Draft {
  const base: Draft = {
    name: channel?.name ?? CHANNEL_TYPE_LABELS[type],
    isDefault: channel?.isDefault ?? false,
    webhookUrl: '',
    secret: '',
    clearSecret: false,
    provider: 'qq',
    host: QQ_MAIL_PRESET.host,
    port: String(QQ_MAIL_PRESET.port),
    security: QQ_MAIL_PRESET.security,
    username: '',
    password: '',
    to: '',
  };
  if (channel?.type === 'email') {
    const c = channel.config;
    const isQq = c.host === QQ_MAIL_PRESET.host;
    return { ...base, provider: isQq ? 'qq' : 'custom', host: c.host, port: String(c.port), security: c.security, username: c.username, to: c.to };
  }
  return base;
}

/**
 * Add or edit a 通知渠道. Saved credentials are never sent back to the
 * browser: on edit the credential inputs start empty, and leaving them empty
 * keeps the stored value.
 */
export function ChannelDialog({
  type,
  channel,
  onCancel,
  onSaved,
}: {
  type: ChannelType;
  channel: NotificationChannel | null;
  onCancel: () => void;
  onSaved: (channel: NotificationChannel) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => initialDraft(type, channel));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = channel !== null;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function chooseProvider(provider: Provider) {
    setDraft((d) =>
      provider === 'qq'
        ? { ...d, provider, host: QQ_MAIL_PRESET.host, port: String(QQ_MAIL_PRESET.port), security: QQ_MAIL_PRESET.security }
        : { ...d, provider },
    );
  }

  function chooseSecurity(security: SmtpSecurity) {
    // Follow the usual port unless the user typed a custom one.
    setDraft((d) => {
      const usual = Object.values(SMTP_DEFAULT_PORTS).map(String).includes(d.port) || d.port === '';
      return { ...d, security, port: usual ? String(SMTP_DEFAULT_PORTS[security]) : d.port };
    });
  }

  function validate(): string | null {
    if (!draft.name.trim()) return '请输入渠道名称';
    if (type === 'feishu') {
      if (!editing && !draft.webhookUrl.trim()) return '请填写 Webhook URL';
      return null;
    }
    const port = Number(draft.port);
    if (!draft.host.trim()) return '请填写 SMTP 服务器';
    if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口应为 1–65535 的整数';
    if (!draft.username.trim()) return '请填写账号';
    if (!editing && !draft.password) return '请填写授权码';
    if (!draft.to.trim()) return '请填写收件地址';
    return null;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const name = draft.name.trim();
    const email = {
      host: draft.host.trim(),
      port: Number(draft.port),
      security: draft.security,
      username: draft.username.trim(),
      to: draft.to.trim(),
    };
    try {
      let saved: NotificationChannel;
      if (!channel) {
        saved = await api.createChannel(
          type === 'feishu'
            ? { type, name, isDefault: draft.isDefault, config: { webhookUrl: draft.webhookUrl.trim(), ...(draft.secret.trim() ? { secret: draft.secret.trim() } : {}) } }
            : { type, name, isDefault: draft.isDefault, config: { ...email, password: draft.password } },
        );
      } else {
        const patch: UpdateChannelRequest =
          type === 'feishu'
            ? {
                name,
                isDefault: draft.isDefault,
                config: { webhookUrl: draft.webhookUrl.trim(), secret: draft.clearSecret ? null : draft.secret.trim() },
              }
            : { name, isDefault: draft.isDefault, config: { ...email, password: draft.password } };
        saved = await api.updateChannel(channel.id, patch);
      }
      onSaved(saved);
    } catch (e) {
      setError(api.errorMessage(e));
      setSaving(false);
    }
  }

  const keepHint = (masked: string | null | undefined) =>
    editing && masked ? `已保存（${masked}），留空则保持不变。` : undefined;

  return (
    <Dialog title={`${editing ? '编辑' : '添加'}${CHANNEL_TYPE_LABELS[type]}渠道`} onClose={onCancel} className="channel-dialog">
      <form className="form" onSubmit={submit} noValidate>
        <Field id={`${id}-name`} label="名称">
          <input id={`${id}-name`} value={draft.name} maxLength={64} onChange={(e) => set('name', e.target.value)} />
        </Field>

        {type === 'feishu' && (
          <>
            <Field
              id={`${id}-url`}
              label="Webhook URL"
              hint={keepHint(channel?.type === 'feishu' ? channel.config.webhookUrl : null) ?? '在飞书群 → 设置 → 群机器人 → 添加自定义机器人后复制。'}
            >
              <input
                id={`${id}-url`}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
                value={draft.webhookUrl}
                onChange={(e) => set('webhookUrl', e.target.value)}
                required={!editing}
              />
            </Field>
            <Field
              id={`${id}-secret`}
              label="签名 secret（选填）"
              hint={
                keepHint(channel?.type === 'feishu' ? channel.config.secret : null) ??
                '只有在机器人的安全设置里开启了「签名校验」时才需要填写。'
              }
            >
              <input
                id={`${id}-secret`}
                type="password"
                autoComplete="off"
                value={draft.secret}
                disabled={draft.clearSecret}
                onChange={(e) => set('secret', e.target.value)}
              />
            </Field>
            {channel?.type === 'feishu' && channel.config.secret && (
              <label className="checkbox-field">
                <input type="checkbox" checked={draft.clearSecret} onChange={(e) => set('clearSecret', e.target.checked)} />
                不再使用签名
              </label>
            )}
          </>
        )}

        {type === 'email' && (
          <>
            <Field id={`${id}-provider`} label="邮箱服务商">
              <select id={`${id}-provider`} value={draft.provider} onChange={(e) => chooseProvider(e.target.value as Provider)}>
                <option value="qq">QQ 邮箱</option>
                <option value="custom">其他（自定义 SMTP）</option>
              </select>
            </Field>
            <div className="form-row">
              <Field id={`${id}-host`} label="SMTP 服务器" className="form-row-grow">
                <input
                  id={`${id}-host`}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.host}
                  onChange={(e) => {
                    set('host', e.target.value);
                    set('provider', e.target.value.trim() === QQ_MAIL_PRESET.host ? 'qq' : 'custom');
                  }}
                />
              </Field>
              <Field id={`${id}-port`} label="端口" className="form-row-port">
                <input id={`${id}-port`} inputMode="numeric" value={draft.port} onChange={(e) => set('port', e.target.value)} />
              </Field>
            </div>
            <Field id={`${id}-security`} label="加密方式">
              <select id={`${id}-security`} value={draft.security} onChange={(e) => chooseSecurity(e.target.value as SmtpSecurity)}>
                {SMTP_SECURITY.map((s) => (
                  <option key={s} value={s}>
                    {SMTP_SECURITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${id}-username`} label="账号">
              <input
                id={`${id}-username`}
                type="email"
                autoComplete="off"
                placeholder="例如 123456@qq.com"
                value={draft.username}
                onChange={(e) => set('username', e.target.value)}
              />
            </Field>
            <Field
              id={`${id}-password`}
              label="授权码"
              hint={
                keepHint(channel?.type === 'email' ? channel.config.password : null) ??
                (draft.provider === 'qq' ? 'QQ 邮箱网页版 → 设置 → 账号 → 开启 SMTP 服务后生成，不是 QQ 密码。' : undefined)
              }
            >
              <input id={`${id}-password`} type="password" autoComplete="new-password" value={draft.password} onChange={(e) => set('password', e.target.value)} />
            </Field>
            <Field id={`${id}-to`} label="收件地址">
              <input id={`${id}-to`} type="email" autoComplete="off" value={draft.to} onChange={(e) => set('to', e.target.value)} />
            </Field>
          </>
        )}

        <label className="checkbox-field">
          <input type="checkbox" checked={draft.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
          设为默认渠道
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
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

/** Label + control + optional hint; the hint is wired to the control with aria-describedby. */
function Field({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  className?: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? cloneElement(children, { 'aria-describedby': `${id}-hint` }) : children}
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
