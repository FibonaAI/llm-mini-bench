/**
 * Complete production-bank equal-task/equal-round mean (0–100), and estimated usage per whole-bank round.
 * The bank version and ordered task IDs come from the served production bank; nothing is hardcoded.
 * Never imputes missing samples or costs.
 */
export function assessmentChartMetric(record, expectedTaskIds, axis = 'cost', bankVersion) {
  const exclude = exclusionReason => ({ score: null, cost: null, exclusionReason, usageLowerBound: null });
  const taskCount = Array.isArray(expectedTaskIds) ? expectedTaskIds.length : 0;
  if (typeof bankVersion !== 'string' || !bankVersion || !taskCount || expectedTaskIds.some(id => typeof id !== 'string' || !id) || new Set(expectedTaskIds).size !== taskCount) return exclude('正式题库尚未加载或无效');
  if (!record || record.bank_version !== bankVersion) return exclude('题库版本不兼容');
  if (record.bank_scope !== 'whole') return exclude('不是完整题库运行，或缺少题库范围证据');
  if (record.status !== 'completed') return exclude(observationQualitySummary(record).text || '运行未完整完成');
  if (!Number.isInteger(record.rounds) || record.rounds < 1 || record.rounds > 3) return exclude('轮数须为 1–3 的整数');
  if (!Number.isInteger(record.sample_count) || record.sample_count !== taskCount * record.rounds) return exclude(`原始目标样本总数不等于 ${taskCount} 题 × 计划轮数`);
  if (!Array.isArray(record.tasks) || record.tasks.length !== taskCount) return exclude(`未包含完整 ${taskCount} 题`);
  const expected = new Set(expectedTaskIds), seen = new Set();
  let total = 0;
  for (const task of record.tasks) {
    if (!task || !expected.has(task.task_id) || seen.has(task.task_id)) return exclude('题目 ID 缺失、重复或不属于正式题库');
    seen.add(task.task_id);
    if (!Array.isArray(task.samples) || task.samples.length !== record.rounds) return exclude('题目缺少计划轮次或包含额外样本');
    const rounds = new Set();
    for (const sample of task.samples) {
      if (!sample || !Number.isInteger(sample.round) || sample.round < 1 || sample.round > record.rounds || rounds.has(sample.round)) return exclude('样本轮次缺失、重复或越界');
      rounds.add(sample.round);
      if (sample.status !== 'completed') return exclude('存在未完成或失败样本');
      if (typeof sample.content_score !== 'number' || !Number.isFinite(sample.content_score) || sample.content_score < 0 || sample.content_score > 1) return exclude(observationQualitySummary(record).text || '存在缺失或无效内容分');
      total += sample.content_score;
    }
  }
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const usage = record.usage, score = total / (taskCount * record.rounds) * 100;
  const usageGap = reason => ({ score, cost: null, exclusionReason: reason, usageLowerBound: usageLowerBound(record, axis) });
  if (axis === 'tokens' && (!valid(usage?.input_tokens) || !valid(usage?.output_tokens))) return usageGap(usageGapReason(record, axis));
  if (axis !== 'tokens' && !valid(record.estimated_cost_usd)) return usageGap(usageGapReason(record, axis));
  const quantity = axis === 'tokens' ? usage.input_tokens + usage.output_tokens : record.estimated_cost_usd;
  if (!Number.isFinite(quantity)) return exclude('累计用量超出范围');
  return { score, cost: quantity / record.rounds, exclusionReason: null, usageLowerBound: null };
}

function unknownAttempts(record, axis) {
  const accounting = record?.usage_accounting;
  const count = axis === 'tokens' ? accounting?.unknown_usage_attempts : accounting?.unknown_cost_attempts;
  return Number.isInteger(count) && count > 0 ? count : null;
}

function usageGapReason(record, axis) {
  const count = unknownAttempts(record, axis);
  const what = axis === 'tokens' ? '累计 tokens' : '累计估算费用';
  return count ? `${what}不完整：${count} 次请求尝试未返回用量（多为超时或上游错误）` : `${what}未记录或无效`;
}

/**
 * Known-part lower bound per round when some attempts returned no usage. This is presentation
 * evidence only: never a complete total, never used by the frontier or baselines.
 */
function usageLowerBound(record, axis) {
  const accounting = record?.usage_accounting, count = unknownAttempts(record, axis);
  if (!accounting || !count) return null;
  const known = axis === 'tokens'
    ? accounting.usage_lower_bound && accounting.usage_lower_bound.input_tokens + accounting.usage_lower_bound.output_tokens
    : accounting.estimated_cost_usd_lower_bound;
  if (typeof known !== 'number' || !Number.isFinite(known) || known < 0) return null;
  return { cost: known / record.rounds, unknownAttempts: count, attempts: Number.isInteger(accounting.attempts) ? accounting.attempts : null };
}

/** Human-readable sample-level quality counts for one observation; never a score. */
export function observationQualitySummary(record, { includeUsage = true } = {}) {
  const samples = (record?.tasks || []).flatMap(task => (task.samples || []).map(sample => ({ ...sample, task_id: task.task_id })));
  const failed = samples.filter(sample => sample.status !== 'completed');
  const unscored = samples.filter(sample => sample.status === 'completed' && !(typeof sample.content_score === 'number' && Number.isFinite(sample.content_score)));
  const byOutcome = outcome => unscored.filter(sample => sample.outcome === outcome).length;
  const failedStatus = {};
  for (const sample of failed) failedStatus[sample.status ?? 'unknown'] = (failedStatus[sample.status ?? 'unknown'] ?? 0) + 1;
  const statusText = { api_failure: 'API 失败或超时', cancelled: '已取消', pending: '未执行', queued: '未执行', running: '执行中', budget_not_admitted: '未执行', incomplete: '响应不完整', interrupted: '已中断' };
  const parts = [];
  for (const [status, count] of Object.entries(failedStatus)) { const label = statusText[status] ?? status; parts.push(`${count} 个样本${/^[A-Za-z]/.test(label) ? ' ' : ''}${label}`); }
  if (byOutcome('ambiguous')) parts.push(`${byOutcome('ambiguous')} 个样本答案歧义，无法评分`);
  if (byOutcome('ungradable')) parts.push(`${byOutcome('ungradable')} 个样本答案无法解析`);
  const otherUnscored = unscored.length - byOutcome('ambiguous') - byOutcome('ungradable');
  if (otherUnscored > 0) parts.push(`${otherUnscored} 个样本评分缺失`);
  const unknown = record?.usage_accounting?.unknown_cost_attempts;
  if (includeUsage && Number.isInteger(unknown) && unknown > 0) parts.push(`${unknown} 次尝试未返回用量`);
  return { failed: failed.length, unscored: unscored.length, retryable: failedStatus.api_failure ?? 0, text: parts.join(' · ') };
}
