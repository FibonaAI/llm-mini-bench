const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});
const timestamp = record => (typeof record.created_at === 'string' && record.created_at.trim() ? Date.parse(record.created_at) : NaN);

/** Format the recorded timestamp in the viewer's local time; missing dates stay unknown. */
export function formatChartRecordTime(record) {
  const value = timestamp(record);
  return Number.isFinite(value) ? timeFormatter.format(value) : '时间未记录';
}

/** Keep overlap times bounded: at most three timestamps, otherwise a range and record count. */
export function summarizeChartRecordTimes(records) {
  const dated = records.filter(record => Number.isFinite(timestamp(record))).sort((a, b) => timestamp(a) - timestamp(b));
  const unknown = records.length - dated.length;
  let times =
    dated.length <= 3
      ? [...new Set(dated.map(formatChartRecordTime))].join('、')
      : `${formatChartRecordTime(dated[0])} 至 ${formatChartRecordTime(dated.at(-1))}`;
  if (unknown) times += `${times ? '；' : ''}${unknown} 条时间未记录`;
  return `${times || '时间未记录'} · 共 ${records.length} 条记录`;
}

/** Find marker overlaps in screen coordinates without moving or merging metric points. */
export function overlappingChartRecords(records, point, x, y, radius = 12) {
  const px = x(point.cost),
    py = y(point.score);
  return records.filter(record => Math.hypot(x(record.cost) - px, y(record.score) - py) <= radius);
}
