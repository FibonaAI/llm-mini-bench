function recordTimestamp(record) {
  const value = record.created_at;
  return typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
}

function historyGroupKey(record) {
  // Whole-bank and diagnostic records, and runs and baselines, never replace each other.
  return JSON.stringify([
    record.source,
    record.bank_version,
    record.bank_scope,
    record.providerId,
    record.accountId,
    record.model,
    record.think
  ]);
}

function localDateBoundary(value, nextDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return NaN;
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** Classify latest history from all observations, before eligibility or display filters; undated is unknown. */
export function buildAnalysisHistoryStates(records) {
  const latest = new Map();
  for (const record of records) {
    const time = recordTimestamp(record);
    if (!Number.isFinite(time)) continue;
    const key = historyGroupKey(record),
      previous = latest.get(key);
    if (!previous || time > recordTimestamp(previous) || (time === recordTimestamp(previous) && record.id.localeCompare(previous.id) > 0))
      latest.set(key, record);
  }
  return new Map(
    records.map(record => [
      record.id,
      !Number.isFinite(recordTimestamp(record)) ? 'unknown' : latest.get(historyGroupKey(record)) === record ? 'latest' : 'historical'
    ])
  );
}

/** Select latest or historical records before chart eligibility; date bounds use local calendar days. */
export function selectAnalysisHistoryRecords(records, { mode = 'latest', from = '', to = '', selectedIds = new Set() } = {}) {
  if (mode === 'latest') {
    const states = buildAnalysisHistoryStates(records);
    // Undated history remains visible: do not pretend an arbitrary record is the newest.
    return records.filter(record => states.get(record.id) !== 'historical');
  }
  const start = localDateBoundary(from),
    end = localDateBoundary(to, true);
  return records
    .filter(record => {
      if (mode === 'selected' && !selectedIds.has(record.id)) return false;
      const time = recordTimestamp(record);
      return (!from || (Number.isFinite(start) && time >= start)) && (!to || (Number.isFinite(end) && time < end));
    })
    .sort((a, b) => (recordTimestamp(b) || 0) - (recordTimestamp(a) || 0) || a.id.localeCompare(b.id));
}
