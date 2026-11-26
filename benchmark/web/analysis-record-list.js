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
  { axis, exclusionReason, escapeHtml, formatDate, currentYear = new Date().getFullYear(), limit = Infinity }
) {
  if (!records.length) return '<p class="empty">没有匹配结果，请调整筛选条件。</p>';
  const shown = Number.isFinite(limit) && records.length > limit ? records.slice(0, limit) : records;
  const dates = shown.map(recordDate);
  const includeYear = dates.some(date => date && date.getFullYear() !== currentYear);
  const rows = shown.map((record, index) => {
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
    const formatSeconds = value => {
      if (value < 60) return `${Number(value.toFixed(value < 10 ? 1 : 0))}s`;
      const total = Math.round(value);
      const mins = Math.floor(total / 60),
        secs = total % 60;
      if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
      const hrs = Math.floor(mins / 60),
        remMins = mins % 60;
      return remMins ? `${hrs}h ${remMins}m` : `${hrs}h`;
    };
    const quantity = Number.isFinite(record.cost)
      ? axis === 'tokens'
        ? `${bound}${Math.round(record.cost).toLocaleString('zh-CN')} tokens / 轮`
        : axis === 'duration'
          ? `${formatSeconds(record.cost)} / 轮`
          : `${bound}$${record.cost.toFixed(4)} / 轮`
      : '';
    const anomalyItems = Array.isArray(record.anomalies?.items)
      ? record.anomalies.items
      : record.usageIncomplete
        ? [`用量不完整：${record.usageIncomplete.unknownAttempts} 次尝试未返回用量，按已知下限绘制`]
        : [];
    const note = reason || (anomalyItems.length ? `含异常项：${anomalyItems.join('；')}` : '');
    const retryableAnomaly = !reason && (Boolean(record.anomalies?.hasAny) || Boolean(record.usageIncomplete));
    const retry =
      record.source === 'run' &&
      record.run_id &&
      ((reason && /非模型异常|模型异常|API 失败|超时|已中断|已取消|响应不完整|未完成/.test(reason)) || retryableAnomaly)
        ? ` <button class="text-control" type="button" data-open-run="${escapeHtml(record.run_id)}">去任务页重试</button>`
        : '';
    const label = `${model} · ${thinking} · ${source} · ${fullTime}`;
    return `<li class="analysis-record-row"><div class="analysis-record-main"><button class="text-control" type="button" data-inspect-observation="${escapeHtml(record.id)}" aria-label="${escapeHtml(label)}">${escapeHtml(model)} <span class="analysis-record-thinking">· ${escapeHtml(thinking)}</span></button><span class="analysis-record-meta">${escapeHtml(identity)} · <time ${dates[index] ? `datetime="${escapeHtml(record.created_at)}"` : ''} title="${escapeHtml(fullTime)}" aria-label="${escapeHtml(fullTime)}">${escapeHtml(time)}</time></span></div><div class="analysis-record-metrics"><span>${escapeHtml(score)}</span>${quantity ? `<span>${escapeHtml(quantity)}</span>` : ''}</div>${note ? `<p class="analysis-record-reason${reason ? '' : ' is-note'}">${escapeHtml(note)}${retry}</p>` : ''}</li>`;
  });
  const more =
    records.length > shown.length
      ? `<div class="history-pagination"><button class="btn" type="button" data-record-list-more="80">显示更多（已显示 ${shown.length} / ${records.length} 条）</button><button class="text-control" type="button" data-record-list-more="all">显示全部</button></div>`
      : '';
  return `<ul class="analysis-record-list">${rows.join('')}</ul>${more}`;
}
