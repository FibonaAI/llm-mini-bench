import { thinkingLabel } from './data-picker.js';

function recordDate(record) {
  if (typeof record.created_at !== 'string' || !record.created_at.trim()) return null;
  const date = new Date(record.created_at);
  return Number.isFinite(date.getTime()) ? date : null;
}

function compactRecordTime(date, includeYear) {
  if (!date) return '时间未记录';
  const pad = value => String(value).padStart(2, '0');
  return `${includeYear ? date.getFullYear() + '/' : ''}${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Render matching and excluded records with one compact list; full identity stays in the inspector. */
export function renderAnalysisRecordList(
  records,
  { axis, exclusionReason, escapeHtml, formatDate, currentYear = new Date().getFullYear() }
) {
  if (!records.length) return '<p class="empty">没有匹配结果，请调整筛选条件。</p>';
  const dates = records.map(recordDate);
  const includeYear = dates.some(date => date && date.getFullYear() !== currentYear);
  const rows = records.map((record, index) => {
    const model = record.modelDisplayName || record.model;
    const thinking = thinkingLabel(record.think);
    const reason = exclusionReason(record);
    const fullTime = dates[index] ? formatDate(record.created_at) : '时间未记录';
    const time = compactRecordTime(dates[index], includeYear);
    const source = record.source === 'baseline' ? '基线' : '我的运行';
    const channel = record.providerName || record.provider;
    const knownAccount = record.accountId && record.accountId !== 'unknown-account' && !record.accountId.startsWith('gateway-binding:');
    const identity = [channel, knownAccount ? record.account : null, record.source === 'baseline' ? source : null]
      .filter(Boolean)
      .join(' · ');
    const score = Number.isFinite(record.score) ? `${record.score.toFixed(1)} 分` : '无完整均分';
    const bound = record.usageIncomplete ? '≥ ' : '';
    const quantity = Number.isFinite(record.cost)
      ? axis === 'tokens'
        ? `${bound}${Math.round(record.cost).toLocaleString('zh-CN')} tokens / 轮`
        : `${bound}$${record.cost.toFixed(4)} / 轮`
      : '';
    const note =
      reason || (record.usageIncomplete ? `用量不完整：${record.usageIncomplete.unknownAttempts} 次尝试未返回用量，按已知下限绘制` : '');
    const retry =
      reason && record.source === 'run' && record.run_id && /API 失败或超时/.test(reason)
        ? ` <button class="text-control" type="button" data-open-run="${escapeHtml(record.run_id)}">去任务页重试</button>`
        : '';
    const label = `${model} · ${thinking} · ${source} · ${fullTime}`;
    return `<li class="analysis-record-row"><div class="analysis-record-main"><button class="text-control" type="button" data-inspect-observation="${escapeHtml(record.id)}" aria-label="${escapeHtml(label)}">${escapeHtml(model)} <span class="analysis-record-thinking">· ${escapeHtml(thinking)}</span></button><span class="analysis-record-meta">${escapeHtml(identity)} · <time ${dates[index] ? `datetime="${escapeHtml(record.created_at)}"` : ''} title="${escapeHtml(fullTime)}" aria-label="${escapeHtml(fullTime)}">${escapeHtml(time)}</time></span></div><div class="analysis-record-metrics"><span>${escapeHtml(score)}</span>${quantity ? `<span>${escapeHtml(quantity)}</span>` : ''}</div>${note ? `<p class="analysis-record-reason${reason ? '' : ' is-note'}">${escapeHtml(note)}${retry}</p>` : ''}</li>`;
  });
  return `<ul class="analysis-record-list">${rows.join('')}</ul>`;
}
