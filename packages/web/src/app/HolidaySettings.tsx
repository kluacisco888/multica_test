import type { HolidayRefreshResponse, HolidaySource, HolidayStatus } from '@dida/shared';
import { useEffect, useId, useState } from 'react';
import * as api from '../api.js';

/*
 * 节假日数据 card in 设置 → 日期与时间 (spec 用户故事 114, ADR-0006): when the
 * data was last fetched, 立即更新, and where each tracked year's data comes from.
 */

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const SOURCE_LABEL: Record<HolidaySource, string> = {
  remote: '已更新',
  bundled: '使用内置数据',
  none: '尚未公布，按周一到周五计算',
};

type Message = { kind: 'ok' | 'error'; text: string };

function describe(results: HolidayRefreshResponse['results']): Message {
  const failed = results.filter((r) => r.outcome === 'failed');
  const updated = results.filter((r) => r.outcome === 'updated').map((r) => `${r.year} 年`);
  if (failed.length === results.length) return { kind: 'error', text: '更新失败，继续使用已有数据' };
  if (failed.length > 0) {
    return { kind: 'error', text: `${failed.map((r) => `${r.year} 年`).join('、')}更新失败，继续使用已有数据` };
  }
  if (updated.length > 0) return { kind: 'ok', text: `已更新${updated.join('、')}的节假日数据` };
  return { kind: 'ok', text: '节假日数据已是最新' };
}

export function HolidaySettings() {
  const titleId = useId();
  const [status, setStatus] = useState<HolidayStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchHolidayStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setMessage({ kind: 'error', text: api.errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setMessage({ kind: 'ok', text: '正在更新…' });
    try {
      const result = await api.refreshHolidays();
      setStatus(result.status);
      setMessage(describe(result.results));
    } catch (e) {
      setMessage({ kind: 'error', text: api.errorMessage(e) });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="settings-card" role="group" aria-labelledby={titleId}>
      <div className="settings-row settings-row-stacked">
        <h4 id={titleId} className="settings-row-label">
          节假日数据
        </h4>
        <p className="settings-row-hint">用于判断工作日、法定假日和调休补班，每天自动从 holiday-cn 更新。</p>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">最后更新时间</span>
        <span className="settings-row-value">
          <span data-testid="holiday-last-updated">
            {status === null ? '…' : status.lastUpdatedAt ? dateTime.format(new Date(status.lastUpdatedAt)) : '尚未更新'}
          </span>
          {/* aria-disabled rather than disabled: keeps keyboard focus on the button while it runs. */}
          <button type="button" className="settings-link" onClick={refresh} aria-disabled={refreshing}>
            立即更新
          </button>
        </span>
      </div>
      {status?.years.map((y) => (
        <div className="settings-row" key={y.year}>
          <span className="settings-row-label">{y.year} 年</span>
          <span className="settings-row-value" data-testid={`holiday-year-${y.year}`}>
            {SOURCE_LABEL[y.source]}
          </span>
        </div>
      ))}
      <p role="status" className={`settings-status ${message?.kind === 'error' ? 'settings-status-error' : ''}`}>
        {message?.text}
      </p>
    </section>
  );
}
