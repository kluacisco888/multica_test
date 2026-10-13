import { CHANNEL_TYPE_LABELS, SMTP_SECURITY_LABELS, type ChannelType, type NotificationChannel } from '@dida/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import * as api from '../../api.js';
import { MenuButton } from '../../ui/controls.js';
import { ConfirmDialog } from '../dialogs.js';
import { ChannelDialog } from './ChannelDialog.js';

type TestState = { status: 'sending' } | { status: 'sent' } | { status: 'failed'; message: string };

type Editing = { kind: 'none' } | { kind: 'create'; type: ChannelType } | { kind: 'edit'; channel: NotificationChannel };

/** 设置 →「提醒与通知」: the user's 通知渠道 (spec 用户故事 74–77、85). */
export function NotificationSettings() {
  const id = useId();
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>({ kind: 'none' });
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      setChannels(await api.fetchChannels());
      setLoadError(null);
    } catch (e) {
      setLoadError(api.errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function replace(channel: NotificationChannel) {
    setChannels((list) => list && list.map((c) => (c.id === channel.id ? channel : c)));
  }

  async function sendTest(channel: NotificationChannel) {
    setTests((t) => ({ ...t, [channel.id]: { status: 'sending' } }));
    try {
      await api.testChannel(channel.id);
      setTests((t) => ({ ...t, [channel.id]: { status: 'sent' } }));
    } catch (e) {
      setTests((t) => ({ ...t, [channel.id]: { status: 'failed', message: api.errorMessage(e) } }));
    }
  }

  async function toggleDefault(channel: NotificationChannel) {
    setRowError(({ [channel.id]: _, ...rest }) => rest);
    replace({ ...channel, isDefault: !channel.isDefault });
    try {
      replace(await api.updateChannel(channel.id, { isDefault: !channel.isDefault }));
    } catch (e) {
      replace(channel);
      setRowError((r) => ({ ...r, [channel.id]: api.errorMessage(e) }));
    }
  }

  return (
    <div className="channels">
      <div className="settings-section-head">
        <div>
          <h4 id={`${id}-title`} className="settings-section-title">
            通知渠道
          </h4>
          <p className="settings-section-hint">提醒到点后，消息会发送到默认渠道。可以设置多个默认渠道。</p>
        </div>
        <MenuButton
          label="添加渠道"
          className="channels-add"
          items={(['feishu', 'email'] as const).map((type) => ({
            label: CHANNEL_TYPE_LABELS[type],
            icon: type === 'feishu' ? 'send' : 'mail',
            onSelect: () => setEditing({ kind: 'create', type }),
          }))}
        >
          + 添加渠道
        </MenuButton>
      </div>

      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {channels === null && !loadError && <p className="settings-section-hint">正在加载…</p>}
      {channels?.length === 0 && (
        <div className="settings-card settings-empty">
          <p>还没有通知渠道。添加飞书机器人或邮箱后，提醒就能发到手机上。</p>
        </div>
      )}

      <ul className="channels-list" aria-labelledby={`${id}-title`}>
        {channels?.map((channel) => (
          <ChannelCard
            key={channel.id}
            channel={channel}
            test={tests[channel.id]}
            error={rowError[channel.id]}
            onTest={() => sendTest(channel)}
            onToggleDefault={() => toggleDefault(channel)}
            onEdit={() => setEditing({ kind: 'edit', channel })}
            onDelete={() => setDeleting(channel)}
          />
        ))}
      </ul>

      {editing.kind !== 'none' && (
        <ChannelDialog
          type={editing.kind === 'create' ? editing.type : editing.channel.type}
          channel={editing.kind === 'edit' ? editing.channel : null}
          onCancel={() => setEditing({ kind: 'none' })}
          onSaved={(saved) => {
            setEditing({ kind: 'none' });
            setChannels((list) => (list?.some((c) => c.id === saved.id) ? list.map((c) => (c.id === saved.id ? saved : c)) : [...(list ?? []), saved]));
            setTests(({ [saved.id]: _, ...rest }) => rest);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除通知渠道"
          message={`删除「${deleting.name}」后，提醒不会再发到这个渠道。`}
          confirmLabel="删除"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteChannel(deleting.id);
              setChannels((list) => list && list.filter((c) => c.id !== deleting.id));
              setDeleting(null);
            } catch (e) {
              setDeleting(null);
              setRowError((r) => ({ ...r, [deleting.id]: api.errorMessage(e) }));
            }
          }}
        />
      )}
    </div>
  );
}

function ChannelCard({
  channel,
  test,
  error,
  onTest,
  onToggleDefault,
  onEdit,
  onDelete,
}: {
  channel: NotificationChannel;
  test: TestState | undefined;
  error: string | undefined;
  onTest: () => void;
  onToggleDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const rows: [string, string][] =
    channel.type === 'feishu'
      ? [
          ['Webhook URL', channel.config.webhookUrl],
          ['签名 secret', channel.config.secret ?? '未设置'],
        ]
      : [
          ['SMTP 服务器', `${channel.config.host}:${channel.config.port} · ${SMTP_SECURITY_LABELS[channel.config.security]}`],
          ['账号', channel.config.username],
          ['授权码', channel.config.password],
          ['收件地址', channel.config.to],
        ];

  return (
    <li className="settings-card channel" aria-labelledby={`${id}-name`}>
      <div className="settings-row channel-head">
        <span className="channel-title">
          <span id={`${id}-name`} className="channel-name">
            {channel.name}
          </span>
          <span className="badge badge-muted">{CHANNEL_TYPE_LABELS[channel.type]}</span>
          {channel.isDefault && <span className="badge">默认</span>}
        </span>
        <span className="settings-row-actions">
          <button type="button" className="link-button" onClick={onEdit} aria-label={`编辑「${channel.name}」`}>
            编辑
          </button>
          <button type="button" className="link-button link-button-danger" onClick={onDelete} aria-label={`删除「${channel.name}」`}>
            删除
          </button>
        </span>
      </div>
      <dl className="channel-config">
        {rows.map(([label, value]) => (
          <div key={label} className="settings-row">
            <dt>{label}</dt>
            <dd className="settings-row-value">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="settings-row">
        <label htmlFor={`${id}-default`}>设为默认渠道</label>
        <input
          id={`${id}-default`}
          type="checkbox"
          role="switch"
          className="ui-switch"
          checked={channel.isDefault}
          onChange={onToggleDefault}
        />
      </div>
      <div className="settings-row channel-test">
        <span className="channel-test-result" aria-live="polite">
          {test?.status === 'sent' && (
            <span className="form-success" role="status">
              测试消息已发送，请查收
            </span>
          )}
          {test?.status === 'sending' && <span className="settings-row-value">正在发送…</span>}
        </span>
        <button type="button" className="link-button" onClick={onTest} disabled={test?.status === 'sending'} aria-label={`发送测试消息到「${channel.name}」`}>
          发送测试消息
        </button>
      </div>
      {test?.status === 'failed' && (
        <p className="form-error channel-error" role="alert">
          发送失败：{test.message}
        </p>
      )}
      {error && (
        <p className="form-error channel-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
