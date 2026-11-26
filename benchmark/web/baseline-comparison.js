import { isUnpricedOnlyCostGap } from './assessment-chart-metric.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);

function rawOf(record) {
  return record?.original && typeof record.original === 'object' ? record.original : record;
}

function recordThink(record) {
  const raw = rawOf(record);
  const value = record?.think ?? raw?.thinking;
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function recordModel(record) {
  const raw = rawOf(record);
  const value = record?.model ?? raw?.model;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function recordBankVersion(record) {
  const raw = rawOf(record);
  const value = record?.bank_version ?? raw?.bank_version;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function recordTimestamp(record) {
  const raw = rawOf(record);
  const value = record?.created_at ?? raw?.created_at;
  const parsed = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function totalElapsedSeconds(raw) {
  if (finite(raw?.elapsed_seconds) && raw.elapsed_seconds >= 0) return raw.elapsed_seconds;
  const samples = (raw?.tasks || []).flatMap(task => task?.samples || []);
  if (!samples.length) return null;
  let sum = 0;
  for (const sample of samples) {
    if (!finite(sample?.elapsed_seconds) || sample.elapsed_seconds < 0) return null;
    sum += sample.elapsed_seconds;
  }
  return sum;
}

function perRoundMetrics(record) {
  const raw = rawOf(record);
  const rounds = Number.isInteger(raw?.rounds) && raw.rounds > 0 ? raw.rounds : null;
  const accounting = raw?.usage_accounting;
  const score = finite(record?.score) ? record.score : null;

  let cost = null;
  let costLowerBound = null;
  if (rounds !== null) {
    if (finite(raw?.estimated_cost_usd) && raw.estimated_cost_usd >= 0) {
      cost = raw.estimated_cost_usd / rounds;
    } else if (
      !isUnpricedOnlyCostGap(raw, 'cost') &&
      finite(accounting?.estimated_cost_usd_lower_bound) &&
      accounting.estimated_cost_usd_lower_bound >= 0
    ) {
      costLowerBound = accounting.estimated_cost_usd_lower_bound / rounds;
    }
  }

  let tokens = null;
  let tokensLowerBound = null;
  if (rounds !== null) {
    const usage = raw?.usage;
    if (finite(usage?.input_tokens) && usage.input_tokens >= 0 && finite(usage?.output_tokens) && usage.output_tokens >= 0) {
      tokens = (usage.input_tokens + usage.output_tokens) / rounds;
    } else if (
      finite(accounting?.usage_lower_bound?.input_tokens) &&
      accounting.usage_lower_bound.input_tokens >= 0 &&
      finite(accounting?.usage_lower_bound?.output_tokens) &&
      accounting.usage_lower_bound.output_tokens >= 0
    ) {
      tokensLowerBound = (accounting.usage_lower_bound.input_tokens + accounting.usage_lower_bound.output_tokens) / rounds;
    }
  }

  const elapsedTotal = totalElapsedSeconds(raw);
  const duration = rounds !== null && elapsedTotal !== null ? elapsedTotal / rounds : null;

  return { score, cost, costLowerBound, tokens, tokensLowerBound, duration, rounds };
}

function compareMetric(current, baseline, { currentLowerBound = null } = {}) {
  const comparable = finite(current) && finite(baseline);
  const delta = comparable ? current - baseline : null;
  const ratio = comparable && baseline > 0 ? delta / baseline : null;
  return {
    current: finite(current) ? current : null,
    baseline: finite(baseline) ? baseline : null,
    currentLowerBound: finite(currentLowerBound) ? currentLowerBound : null,
    delta,
    ratio
  };
}

function taskMean(task, rounds) {
  const samples = Array.isArray(task?.samples) ? task.samples : [];
  if (!samples.length || (Number.isInteger(rounds) && rounds > 0 && samples.length !== rounds)) {
    return { mean: null, incomplete: true, timedOut: 0, noSubmission: 0 };
  }
  let sum = 0;
  let timedOut = 0;
  let noSubmission = 0;
  for (const sample of samples) {
    if (sample?.status === 'timeout') timedOut++;
    if (sample?.outcome === 'no_submission') noSubmission++;
    if (!finite(sample?.content_score)) {
      return { mean: null, incomplete: true, timedOut, noSubmission };
    }
    sum += sample.content_score;
  }
  return { mean: sum / samples.length, incomplete: false, timedOut, noSubmission };
}

/**
 * Stable key identifying the originating run target of an observation or baseline.
 * Returns null when run_id or target_id is missing.
 */
export function baselineSourceKey(record) {
  const raw = rawOf(record);
  const runId = typeof (record?.run_id ?? raw?.run_id) === 'string' ? (record?.run_id ?? raw?.run_id).trim() : '';
  const targetId = typeof (record?.target_id ?? raw?.target_id) === 'string' ? (record?.target_id ?? raw?.target_id).trim() : '';
  if (!runId || !targetId) return null;
  return `${recordBankVersion(record)}::${runId}::${targetId}`;
}

function samePromotedSnapshot(run, baseline) {
  const runKey = baselineSourceKey(run);
  const baseKey = baselineSourceKey(baseline);
  if (!runKey || runKey !== baseKey) return false;
  const runRaw = rawOf(run);
  const baseRaw = rawOf(baseline);
  if (recordModel(run) !== recordModel(baseline)) return false;
  if (recordThink(run) !== recordThink(baseline)) return false;
  if ((runRaw?.provider_id ?? null) !== (baseRaw?.provider_id ?? null)) return false;
  if ((runRaw?.route_id ?? null) !== (baseRaw?.route_id ?? null)) return false;
  if ((runRaw?.rounds ?? null) !== (baseRaw?.rounds ?? null)) return false;
  if ((runRaw?.created_at ?? null) !== (baseRaw?.created_at ?? null)) return false;
  if ((runRaw?.estimated_cost_usd ?? null) !== (baseRaw?.estimated_cost_usd ?? null)) return false;
  if ((run?.score ?? null) !== (baseline?.score ?? null)) return false;
  return true;
}

/**
 * When a run target has been promoted to a baseline and both appear in the same
 * filtered record set with identical snapshot metrics, keep the baseline record so
 * the chart renders a single baseline square instead of covering it with a duplicate run circle.
 */
export function dedupePromotedRuns(records) {
  if (!Array.isArray(records) || records.length < 2) return Array.isArray(records) ? records : [];
  const baselinesByKey = new Map();
  for (const record of records) {
    if (record?.source !== 'baseline') continue;
    const key = baselineSourceKey(record);
    if (!key) continue;
    let bucket = baselinesByKey.get(key);
    if (!bucket) {
      bucket = [];
      baselinesByKey.set(key, bucket);
    }
    bucket.push(record);
  }
  if (!baselinesByKey.size) return records;
  return records.filter(record => {
    if (record?.source !== 'run') return true;
    const key = baselineSourceKey(record);
    const matches = key ? baselinesByKey.get(key) : null;
    return !matches || !matches.some(baseline => samePromotedSnapshot(record, baseline));
  });
}

/** Find the promoted baseline record corresponding to a run observation, if one exists. */
export function findPromotedBaseline(record, allRecords) {
  if (record?.source !== 'run' || !Array.isArray(allRecords)) return null;
  const key = baselineSourceKey(record);
  if (!key) return null;
  return allRecords.find(candidate => candidate?.source === 'baseline' && samePromotedSnapshot(record, candidate)) || null;
}

/**
 * Find baselines that match the given record on bank_version, model, and Thinking level,
 * excluding the record itself and its own promoted baseline counterpart.
 * Ordered newest first.
 */
export function findMatchingBaselines(record, allRecords) {
  if (!record || !Array.isArray(allRecords)) return [];
  const bankVersion = recordBankVersion(record);
  const model = recordModel(record);
  const think = recordThink(record);
  if (!model) return [];
  const ownSourceKey = baselineSourceKey(record);
  return allRecords
    .filter(candidate => {
      if (!candidate || candidate.source !== 'baseline') return false;
      if (candidate.id === record.id) return false;
      if (bankVersion && recordBankVersion(candidate) !== bankVersion) return false;
      if (recordModel(candidate) !== model) return false;
      if (recordThink(candidate) !== think) return false;
      const candidateSourceKey = baselineSourceKey(candidate);
      if (ownSourceKey && candidateSourceKey && ownSourceKey === candidateSourceKey) return false;
      return true;
    })
    .sort((a, b) => recordTimestamp(b) - recordTimestamp(a) || String(b.id ?? '').localeCompare(String(a.id ?? '')));
}

/**
 * Pure objective delta comparison between one observation and a matching baseline.
 * Never invents anomaly labels or imputes missing/ungradable samples as zero.
 */
export function compareRecordToBaseline(record, baseline) {
  if (!record || !baseline) return null;
  const currentRaw = rawOf(record);
  const baselineRaw = rawOf(baseline);
  const currentMetrics = perRoundMetrics(record);
  const baselineMetrics = perRoundMetrics(baseline);

  const score = compareMetric(currentMetrics.score, baselineMetrics.score);
  const cost = compareMetric(currentMetrics.cost, baselineMetrics.cost, { currentLowerBound: currentMetrics.costLowerBound });
  const tokens = compareMetric(currentMetrics.tokens, baselineMetrics.tokens, { currentLowerBound: currentMetrics.tokensLowerBound });
  const duration = compareMetric(currentMetrics.duration, baselineMetrics.duration);

  const currentProtocol = currentRaw?.assessment_protocol_sha256 || null;
  const baselineProtocol = baselineRaw?.assessment_protocol_sha256 || null;
  const protocolKnown = Boolean(currentProtocol && baselineProtocol);
  const protocolMatch = protocolKnown ? currentProtocol === baselineProtocol : null;

  const baselineTasksById = new Map();
  for (const task of baselineRaw?.tasks || []) {
    if (task?.task_id) baselineTasksById.set(task.task_id, task);
  }

  const tasks = [];
  let lowerCount = 0;
  let higherCount = 0;
  let equalCount = 0;
  let uncomparableCount = 0;
  const EPS = 1e-9;

  for (const task of currentRaw?.tasks || []) {
    if (!task?.task_id) continue;
    const baseTask = baselineTasksById.get(task.task_id);
    const curr = taskMean(task, currentMetrics.rounds);
    const base = baseTask ? taskMean(baseTask, baselineMetrics.rounds) : { mean: null, incomplete: true, timedOut: 0, noSubmission: 0 };
    const delta = finite(curr.mean) && finite(base.mean) ? curr.mean - base.mean : null;
    if (delta === null) uncomparableCount++;
    else if (delta < -EPS) lowerCount++;
    else if (delta > EPS) higherCount++;
    else equalCount++;
    tasks.push({
      task_id: task.task_id,
      title: task.title || task.task_id,
      currentMean: curr.mean,
      baselineMean: base.mean,
      delta,
      currentIncomplete: curr.incomplete,
      baselineIncomplete: base.incomplete,
      timedOut: curr.timedOut,
      noSubmission: curr.noSubmission
    });
  }

  const taskMap = new Map(tasks.map(entry => [entry.task_id, entry]));
  const biggestDrops = tasks
    .filter(entry => finite(entry.delta) && entry.delta < -EPS)
    .sort((a, b) => a.delta - b.delta || a.task_id.localeCompare(b.task_id));

  return {
    baseline,
    score,
    cost,
    tokens,
    duration,
    protocolKnown,
    protocolMatch,
    tasks,
    taskMap,
    lowerCount,
    higherCount,
    equalCount,
    uncomparableCount,
    biggestDrops
  };
}
