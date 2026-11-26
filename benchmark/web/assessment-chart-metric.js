/**
 * Complete production-bank equal-task/equal-round mean (0–100), and estimated usage per whole-bank round.
 * The bank version and ordered task IDs come from the served production bank; nothing is hardcoded.
 * Never imputes missing samples or costs.
 */
export function assessmentChartMetric(record, expectedTaskIds, axis = 'cost', bankVersion) {
  const exclude = exclusionReason => ({ score: null, cost: null, exclusionReason, usageLowerBound: null });
  const taskCount = Array.isArray(expectedTaskIds) ? expectedTaskIds.length : 0;
  if (
    typeof bankVersion !== 'string' ||
    !bankVersion ||
    !taskCount ||
    expectedTaskIds.some(id => typeof id !== 'string' || !id) ||
    new Set(expectedTaskIds).size !== taskCount
  )
    return exclude('正式题库尚未加载或无效');
  if (!record || record.bank_version !== bankVersion) return exclude('题库版本不兼容');
  if (record.bank_scope !== 'whole') return exclude('不是完整题库运行，或缺少题库范围证据');
  if (record.status !== 'completed') return exclude(observationQualitySummary(record).text || '运行未完整完成');
  if (!Number.isInteger(record.rounds) || record.rounds < 1 || record.rounds > 3) return exclude('轮数须为 1–3 的整数');
  if (!Number.isInteger(record.sample_count) || record.sample_count !== taskCount * record.rounds)
    return exclude(`原始目标样本总数不等于 ${taskCount} 题 × 计划轮数`);
  if (!Array.isArray(record.tasks) || record.tasks.length !== taskCount) return exclude(`未包含完整 ${taskCount} 题`);
  const expected = new Set(expectedTaskIds),
    seen = new Set();
  let total = 0;
  let elapsedSum = 0,
    allElapsedValid = true;
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const task of record.tasks) {
    if (!task || !expected.has(task.task_id) || seen.has(task.task_id)) return exclude('题目 ID 缺失、重复或不属于正式题库');
    seen.add(task.task_id);
    if (!Array.isArray(task.samples) || task.samples.length !== record.rounds) return exclude('题目缺少计划轮次或包含额外样本');
    const rounds = new Set();
    for (const sample of task.samples) {
      if (!sample || !Number.isInteger(sample.round) || sample.round < 1 || sample.round > record.rounds || rounds.has(sample.round))
        return exclude('样本轮次缺失、重复或越界');
      rounds.add(sample.round);
      if (sample.status !== 'completed' && sample.status !== 'timeout') return exclude('存在未完成或失败样本');
      const scoreValue = sample.status === 'timeout' && sample.content_score === null ? 0 : sample.content_score;
      if (typeof scoreValue !== 'number' || !Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 1)
        return exclude(observationQualitySummary(record).text || '存在缺失或无效内容分');
      total += scoreValue;
      if (valid(sample.elapsed_seconds)) elapsedSum += sample.elapsed_seconds;
      else allElapsedValid = false;
    }
  }
  const usage = record.usage,
    score = (total / (taskCount * record.rounds)) * 100;
  if (axis === 'duration') {
    const elapsed = valid(record.elapsed_seconds) ? record.elapsed_seconds : allElapsedValid ? elapsedSum : null;
    if (!valid(elapsed)) return { score, cost: null, exclusionReason: '未记录完整执行耗时', usageLowerBound: null };
    return { score, cost: elapsed / record.rounds, exclusionReason: null, usageLowerBound: null };
  }
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

export function isUnpricedOnlyCostGap(record, axis = 'cost') {
  if (axis !== 'cost') return false;
  const accounting = record?.usage_accounting;
  return Boolean(
    accounting &&
    Number.isInteger(accounting.unknown_usage_attempts) &&
    accounting.unknown_usage_attempts >= 0 &&
    Number.isInteger(accounting.unknown_cost_attempts) &&
    accounting.unknown_cost_attempts > accounting.unknown_usage_attempts &&
    accounting.estimated_cost_usd_lower_bound === 0
  );
}

function usageGapReason(record, axis) {
  if (isUnpricedOnlyCostGap(record, axis)) {
    const unknownUsage = record?.usage_accounting?.unknown_usage_attempts;
    return Number.isInteger(unknownUsage) && unknownUsage > 0
      ? `累计估算费用未知：目录未提供单价（且有 ${unknownUsage} 次请求尝试未返回用量）`
      : '累计估算费用未知：目录未提供单价';
  }
  const count = unknownAttempts(record, axis);
  const what = axis === 'tokens' ? '累计 tokens' : '累计估算费用';
  return count ? `${what}不完整：${count} 次请求尝试未返回用量（多为超时或上游错误）` : `${what}未记录或无效`;
}

/**
 * Known-part lower bound per round when some attempts returned no usage. This is presentation
 * evidence only: never a complete total, never used by the frontier or baselines.
 */
function usageLowerBound(record, axis) {
  if (isUnpricedOnlyCostGap(record, axis)) return null;
  const accounting = record?.usage_accounting,
    count = unknownAttempts(record, axis);
  if (!accounting || !count) return null;
  const known =
    axis === 'tokens'
      ? accounting.usage_lower_bound && accounting.usage_lower_bound.input_tokens + accounting.usage_lower_bound.output_tokens
      : accounting.estimated_cost_usd_lower_bound;
  if (typeof known !== 'number' || !Number.isFinite(known) || known < 0) return null;
  return {
    cost: known / record.rounds,
    unknownAttempts: count,
    attempts: Number.isInteger(accounting.attempts) ? accounting.attempts : null
  };
}

/** Human-readable sample-level quality counts for one observation; never a score. */
export function observationQualitySummary(record, { includeUsage = true } = {}) {
  const samples = (record?.tasks || []).flatMap(task => (task.samples || []).map(sample => ({ ...sample, task_id: task.task_id })));
  const timedOut = samples.filter(sample => sample.status === 'timeout');
  const failed = samples.filter(sample => sample.status !== 'completed' && sample.status !== 'timeout');
  const unscored = samples.filter(
    sample => sample.status === 'completed' && !(typeof sample.content_score === 'number' && Number.isFinite(sample.content_score))
  );
  const byOutcome = outcome => unscored.filter(sample => sample.outcome === outcome).length;
  const failedStatus = {};
  for (const sample of failed) failedStatus[sample.status ?? 'unknown'] = (failedStatus[sample.status ?? 'unknown'] ?? 0) + 1;
  const statusText = {
    api_failure: 'API 失败',
    cancelled: '已取消',
    pending: '未执行',
    queued: '未执行',
    running: '执行中',
    budget_not_admitted: '未执行',
    incomplete: '响应不完整',
    interrupted: '已中断'
  };
  const parts = [];
  if (timedOut.length > 0) parts.push(`${timedOut.length} 个样本超时（按 0 分计）`);
  for (const [status, count] of Object.entries(failedStatus)) {
    const label = statusText[status] ?? status;
    parts.push(`${count} 个样本${/^[A-Za-z]/.test(label) ? ' ' : ''}${label}`);
  }
  if (byOutcome('ambiguous')) parts.push(`${byOutcome('ambiguous')} 个样本答案歧义，无法评分`);
  if (byOutcome('ungradable')) parts.push(`${byOutcome('ungradable')} 个样本答案无法解析`);
  const otherUnscored = unscored.length - byOutcome('ambiguous') - byOutcome('ungradable');
  if (otherUnscored > 0) parts.push(`${otherUnscored} 个样本评分缺失`);
  const unknownUsage = record?.usage_accounting?.unknown_usage_attempts;
  const unknownCost = record?.usage_accounting?.unknown_cost_attempts;
  if (includeUsage) {
    if (isUnpricedOnlyCostGap(record, 'cost')) {
      if (Number.isInteger(unknownUsage) && unknownUsage > 0) parts.push(`${unknownUsage} 次尝试未返回用量`);
      parts.push('累计估算费用未知（目录未提供单价）');
    } else if (Number.isInteger(unknownCost) && unknownCost > 0) {
      parts.push(`${unknownCost} 次尝试未返回用量`);
    }
  }
  return {
    failed: failed.length,
    timedOut: timedOut.length,
    unscored: unscored.length,
    retryable: (failedStatus.api_failure ?? 0) + timedOut.length + (failedStatus.interrupted ?? 0) + (failedStatus.cancelled ?? 0),
    text: parts.join(' · ')
  };
}

/**
 * Scan sample-level anomalies that affect plotted score/usage once per observation response.
 * Cached by analysis-model so presentation changes never rescan task samples.
 */
export function observationSampleAnomalies(record) {
  let timedOut = 0,
    endedAfterSubmission = 0,
    noSubmission = 0;
  for (const task of record?.tasks || []) {
    for (const sample of task?.samples || []) {
      if (!sample) continue;
      if (sample.status === 'timeout') {
        timedOut++;
        continue;
      }
      if (sample.status !== 'completed') continue;
      if (typeof sample.ended_after_submission === 'string' && sample.ended_after_submission.trim()) endedAfterSubmission++;
      if (sample.outcome === 'no_submission') noSubmission++;
    }
  }
  return { timedOut, endedAfterSubmission, noSubmission };
}

/** Combine cached sample anomalies with active usage lower-bound state without rescanning tasks. */
export function buildObservationAnomalies(sampleAnomalies, usageIncomplete = null) {
  const timedOut = Number.isInteger(sampleAnomalies?.timedOut) && sampleAnomalies.timedOut > 0 ? sampleAnomalies.timedOut : 0;
  const endedAfterSubmission =
    Number.isInteger(sampleAnomalies?.endedAfterSubmission) && sampleAnomalies.endedAfterSubmission > 0
      ? sampleAnomalies.endedAfterSubmission
      : 0;
  const noSubmission =
    Number.isInteger(sampleAnomalies?.noSubmission) && sampleAnomalies.noSubmission > 0 ? sampleAnomalies.noSubmission : 0;
  const items = [];
  if (timedOut > 0) items.push(`${timedOut} 个样本超时（按 0 分计）`);
  if (endedAfterSubmission > 0) items.push(`${endedAfterSubmission} 个样本提交答案后异常中止（按最后一次提交评分）`);
  if (noSubmission > 0) items.push(`${noSubmission} 个样本未调用 submit_answer 提交（按 0 分计）`);
  const activeUsageIncomplete =
    usageIncomplete && Number.isInteger(usageIncomplete.unknownAttempts) && usageIncomplete.unknownAttempts > 0 ? usageIncomplete : null;
  if (activeUsageIncomplete) {
    items.push(`用量不完整：${activeUsageIncomplete.unknownAttempts} 次请求尝试未返回用量，横坐标按已知下限绘制`);
  }
  return {
    timedOut,
    endedAfterSubmission,
    noSubmission,
    usageIncomplete: activeUsageIncomplete,
    items,
    hasAny: items.length > 0,
    summary: items.join('；')
  };
}
