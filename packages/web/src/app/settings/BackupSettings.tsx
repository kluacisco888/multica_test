import {
  BACKUP_ENTITY_NAMES,
  BACKUP_IMPORT_MAX_BYTES,
  describeImportIssue,
  formatBackupSize,
  importIssueSchema,
  type BackupEntityType,
  type ImportIssue,
} from '@dida/shared';
import { useId, useRef, useState, type ChangeEvent } from 'react';
import * as api from '../../api.js';

/*
 * 设置 →「关联与导入」→ 备份与还原 (spec 用户故事 110–112): 生成备份 downloads
 * the whole account as JSON, 导出任务 the 任务 as CSV, 导入本地备份 imports a
 * JSON backup of this app, 导入滴答清单备份 a 滴答 CSV (用户故事 113). A refused
 * file lists the records (or lines) at fault.
 */

type Message = { kind: 'ok' | 'error'; text: string };

/** 任务 12 个、清单 3 个 (types with records only, main ones first). */
function summary(imported: Record<string, number>): string {
  const parts = Object.entries(imported)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${BACKUP_ENTITY_NAMES[type as BackupEntityType] ?? type} ${n} 条`);
  return parts.length > 0 ? parts.join('、') : '没有数据';
}

export function BackupSettings() {
  const titleId = useId();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const tickTickInputId = useId();
  const tickTickInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<Message | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [imported, setImported] = useState(false);

  async function exportBackup() {
    if (exporting) return;
    setExporting(true);
    setExportMessage({ kind: 'ok', text: '正在生成备份…' });
    try {
      const { blob, fileName } = await api.downloadBackup();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setExportMessage({ kind: 'ok', text: '备份已生成' });
    } catch (e) {
      setExportMessage({ kind: 'error', text: api.errorMessage(e) });
    } finally {
      setExporting(false);
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || importing) return;
    setIssues([]);
    setImported(false);
    if (file.size > BACKUP_IMPORT_MAX_BYTES) {
      setMessage({ kind: 'error', text: `文件太大，最大 ${formatBackupSize(BACKUP_IMPORT_MAX_BYTES)}` });
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(await file.text());
    } catch {
      setMessage({ kind: 'error', text: '这不是有效的 JSON 文件，请选择本应用导出的备份文件' });
      return;
    }
    await runImport(() => api.importBackup(doc).then((r) => r.imported));
  }

  /** 导入滴答清单备份 (spec 用户故事 113): the CSV file as 滴答's 生成备份 downloaded it. */
  async function onTickTickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || importing) return;
    setIssues([]);
    setImported(false);
    if (file.size > BACKUP_IMPORT_MAX_BYTES) {
      setMessage({ kind: 'error', text: `文件太大，最大 ${formatBackupSize(BACKUP_IMPORT_MAX_BYTES)}` });
      return;
    }
    await runImport(() => api.importTickTickBackup(file));
  }

  async function runImport(run: () => Promise<Record<string, number>>) {
    setImporting(true);
    setMessage({ kind: 'ok', text: '正在导入…' });
    try {
      const result = { imported: await run() };
      setMessage({ kind: 'ok', text: `导入完成：${summary(result.imported)}。刷新页面后可以看到导入的数据。` });
      setImported(true);
    } catch (e) {
      setMessage({ kind: 'error', text: api.errorMessage(e) });
      if (e instanceof api.ApiCallError) {
        setIssues(e.issues.flatMap((i) => {
          const parsed = importIssueSchema.safeParse(i);
          return parsed.success ? [parsed.data] : [];
        }));
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="settings-card backup-card" role="group" aria-labelledby={titleId}>
      <div className="settings-row settings-row-stacked">
        <h4 id={titleId} className="settings-row-label">
          备份与还原
        </h4>
        <p className="settings-row-hint">备份文件包含账户里的全部数据，可以在本应用里完整恢复。</p>
      </div>
      <div className="settings-row">
        <span className="settings-row-stacked">
          <span className="settings-row-label">生成备份</span>
          <span className="settings-row-hint">
            JSON 文件，含通知渠道的 Webhook 地址和授权码，请妥善保管；附件也在里面，文件最大 {formatBackupSize(BACKUP_IMPORT_MAX_BYTES)}
          </span>
        </span>
        <button type="button" className="settings-link" aria-disabled={exporting} onClick={() => void exportBackup()}>
          生成备份
        </button>
      </div>
      <p role="status" aria-label="生成备份状态" className={`settings-status ${exportMessage?.kind === 'error' ? 'settings-status-error' : ''}`}>
        {exportMessage?.text}
      </p>
      <div className="settings-row">
        <span className="settings-row-stacked">
          <span className="settings-row-label">导出任务</span>
          <span className="settings-row-hint">CSV 表格，可以用 Excel 或 Numbers 打开</span>
        </span>
        <a className="settings-link" href={api.TASKS_CSV_URL} download>
          导出 CSV
        </a>
      </div>
      <div className="settings-row">
        <span className="settings-row-stacked">
          <span className="settings-row-label">导入本地备份</span>
          <span className="settings-row-hint">选择本应用导出的 JSON 备份，导入的数据和现有数据放在一起</span>
        </span>
        {/* aria-disabled rather than disabled: keeps keyboard focus on the button while it runs. */}
        <button type="button" className="settings-link" aria-disabled={importing} onClick={() => !importing && input.current?.click()}>
          导入本地备份
        </button>
        <label htmlFor={inputId} className="visually-hidden">
          选择备份文件
        </label>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept=".json,application/json"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(e) => void onFile(e)}
        />
      </div>
      <div className="settings-row">
        <span className="settings-row-stacked">
          <span className="settings-row-label">导入滴答清单备份</span>
          <span className="settings-row-hint">选择滴答清单「生成备份」下载的 CSV 文件，清单、文件夹、标签、子任务、日期、重复和提醒都会导入</span>
        </span>
        <button type="button" className="settings-link" aria-disabled={importing} onClick={() => !importing && tickTickInput.current?.click()}>
          导入滴答清单备份
        </button>
        <label htmlFor={tickTickInputId} className="visually-hidden">
          选择滴答清单备份文件
        </label>
        <input
          ref={tickTickInput}
          id={tickTickInputId}
          type="file"
          accept=".csv,text/csv"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(e) => void onTickTickFile(e)}
        />
      </div>
      <div className="backup-status">
        <p role="status" aria-label="导入状态" className={`settings-status ${message?.kind === 'error' ? 'settings-status-error' : ''}`}>
          {message?.text}
        </p>
        {imported && (
          <button type="button" className="settings-link" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        )}
      </div>
      {issues.length > 0 && (
        <ul className="backup-issues" aria-label="出错的数据">
          {issues.map((issue) => (
            <li key={`${issue.entity}-${issue.index}-${issue.message}`}>{describeImportIssue(issue)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
