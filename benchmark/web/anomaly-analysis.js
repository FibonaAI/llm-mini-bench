import { thinkingLabel } from './data-picker.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);

const SCORE_BASELINE_DROP = 8;
const SCORE_BASELINE_SEVERE_DROP = 15;
const SCORE_CLUSTER_GAP = 8;
const SCORE_CLUSTER_MEAN_DIFF = 10;
const SCORE_CLUSTER_R2_DIFF = 12;
const SCORE_CLUSTER_MIN_R2 = 0.55;
const SCORE_PAIRWISE_DIFF = 12;

const COST_MIN_ABS_DIFF = 0.005;
const COST_BASELINE_RATIO = 0.35;
const COST_BASELINE_SEVERE_RATIO = 0.7;
const COST_CLUSTER_BOUNDARY_RATIO = 1.35;
const COST_CLUSTER_RATIO = 1.4;
const COST_CLUSTER_R2_RATIO = 1.5;
const COST_PAIRWISE_RATIO = 1.5;

const DURATION_BASELINE_RATIO = 0.6;
const DURATION_MIN_ABS_DIFF = 15;

function rawOf(record) {
  return record?.original && typeof record.original === 'object' ? record.original : record;
}

function recordTimestamp(record) {
  const raw = rawOf(record);
  const value = record?.created_at ?? raw?.created_at;
  const parsed = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function totalElapsedSeconds(raw) {
  return finite(raw?.elapsed_seconds) && raw.elapsed_seconds >= 0 ? raw.elapsed_seconds : null;
}

function extractMetrics(record) {
  const raw = rawOf(record);
  const rounds = Number.isInteger(raw?.rounds) && raw.rounds > 0 ? raw.rounds : null;
  let score = null;
  if (finite(record?.score) && record.score >= 0 && record.score <= 100) {
    score = record.score;
  } else if (finite(raw?.score) && raw.score >= 0 && raw.score <= 1) {
    score = raw.score * 100;
  }
  const cost = rounds !== null && finite(raw?.estimated_cost_usd) && raw.estimated_cost_usd >= 0 ? raw.estimated_cost_usd / rounds : null;
  const usage = raw?.usage;
  const tokens =
    rounds !== null && finite(usage?.input_tokens) && usage.input_tokens >= 0 && finite(usage?.output_tokens) && usage.output_tokens >= 0
      ? (usage.input_tokens + usage.output_tokens) / rounds
      : null;
  const elapsed = totalElapsedSeconds(raw);
  const duration = rounds !== null && elapsed !== null ? elapsed / rounds : null;
  const hasTimeout = Boolean(record?.sampleAnomalies?.timedOut || record?.anomalies?.timedOut);
  const hasNoSubmission = Boolean(record?.sampleAnomalies?.noSubmission || record?.anomalies?.noSubmission);
  return { score, cost, tokens, duration, rounds, hasTimeout, hasNoSubmission };
}

function isDistinctAccount(record) {
  const accountId = String(record?.accountId ?? '');
  if (!accountId || accountId === 'unknown-account' || accountId.startsWith('gateway-binding:')) return false;
  const raw = rawOf(record);
  const ref = record?.accountDisplayId ?? raw?.account_ref ?? '';
  return typeof ref === 'string' && ref.trim().length > 0 && ref !== '未记录' && ref !== '实际账号未记录';
}

function canonicalModelIdentity(model, modelDisplayName) {
  const display = typeof modelDisplayName === 'string' ? modelDisplayName.trim() : '';
  const raw = typeof model === 'string' ? model.trim() : '';
  const candidate =
    display && !display.includes('/') ? display : raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1).trim() || raw : raw || display;
  return candidate
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function recordBankVersion(record) {
  const raw = rawOf(record);
  const value = record?.bank_version ?? raw?.bank_version;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function baselineSourceKey(record) {
  const raw = rawOf(record);
  const runId = record?.run_id ?? raw?.run_id ?? raw?.source_run_id;
  const targetId = record?.target_id ?? raw?.target_id ?? raw?.source_target_id;
  return typeof runId === 'string' && runId && typeof targetId === 'string' && targetId ? `${runId}\u0000${targetId}` : '';
}

function findComparableBaselines(entry, baselineEntries) {
  const bankVersion = recordBankVersion(entry.record);
  const ownSourceKey = baselineSourceKey(entry.record);
  return baselineEntries
    .filter(candidate => {
      if (candidate.id === entry.id) return false;
      if (bankVersion && candidate.bankVersion && candidate.bankVersion !== bankVersion) return false;
      if (candidate.identity.modelKey !== entry.identity.modelKey) return false;
      if (ownSourceKey && candidate.sourceKey && ownSourceKey === candidate.sourceKey) return false;
      return true;
    })
    .sort((a, b) => recordTimestamp(b.record) - recordTimestamp(a.record) || String(b.id ?? '').localeCompare(String(a.id ?? '')));
}

function recordIdentity(record) {
  const raw = rawOf(record);
  const providerKey = String(record?.providerId ?? (raw?.provider_id ? `provider:${raw.provider_id}` : `record:${record?.id ?? ''}`));
  const providerLabel = String(record?.providerName ?? raw?.provider_id ?? '未记录渠道');
  const accountKey = String(record?.accountId ?? (raw?.account_ref ? `account:${raw.account_ref}` : 'unknown-account'));
  const distinctAccount = isDistinctAccount(record);
  const accountRaw = distinctAccount ? String(record?.accountDisplayId ?? raw?.account_ref ?? '').trim() : '';
  const model = String(record?.model ?? raw?.model ?? '').trim();
  const modelDisplayName = String(record?.modelDisplayName ?? raw?.model_display_name ?? model).trim() || model;
  const canonicalModel = canonicalModelIdentity(model, modelDisplayName);
  const think = String(record?.think ?? raw?.thinking ?? 'default').trim() || 'default';
  const modelKey = `${canonicalModel || model}::${think}`;
  const modelLabel = `${modelDisplayName} · ${thinkingLabel(think)}`;
  return {
    providerKey,
    providerLabel,
    accountKey,
    distinctAccount,
    accountRaw,
    entityKey: `${providerKey}::${accountKey}`,
    model,
    canonicalModel,
    modelDisplayName,
    think,
    modelKey,
    modelLabel
  };
}

function median(sortedValues) {
  if (!sortedValues.length) return NaN;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Exact 1D optimal 2-means bipartition (minimizing within-cluster SSE).
 * Deterministic and O(n log n); returns null when fewer than 3 points or zero variance.
 */
export function partition1D(items, getValue) {
  if (!Array.isArray(items) || items.length < 3) return null;
  const sorted = items
    .map(item => ({ item, value: getValue(item) }))
    .filter(entry => finite(entry.value))
    .sort((a, b) => a.value - b.value);
  const n = sorted.length;
  if (n < 3) return null;

  const prefixSum = new Array(n + 1).fill(0);
  const prefixSq = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const v = sorted[i].value;
    prefixSum[i + 1] = prefixSum[i] + v;
    prefixSq[i + 1] = prefixSq[i] + v * v;
  }

  const totalSum = prefixSum[n];
  const totalSq = prefixSq[n];
  const sst = totalSq - (totalSum * totalSum) / n;
  if (!(sst > 1e-12)) return null;

  let bestK = -1;
  let bestSse = Infinity;
  let bestGap = -Infinity;

  for (let k = 1; k < n; k++) {
    const leftSum = prefixSum[k];
    const leftSq = prefixSq[k];
    const leftSse = Math.max(0, leftSq - (leftSum * leftSum) / k);

    const rightCount = n - k;
    const rightSum = totalSum - leftSum;
    const rightSq = totalSq - leftSq;
    const rightSse = Math.max(0, rightSq - (rightSum * rightSum) / rightCount);

    const sse = leftSse + rightSse;
    const gap = sorted[k].value - sorted[k - 1].value;
    if (sse < bestSse - 1e-12 || (Math.abs(sse - bestSse) <= 1e-12 && gap > bestGap)) {
      bestSse = sse;
      bestK = k;
      bestGap = gap;
    }
  }

  if (bestK < 1) return null;
  const lowVals = sorted.slice(0, bestK).map(e => e.value);
  const highVals = sorted.slice(bestK).map(e => e.value);
  return {
    low: sorted.slice(0, bestK).map(e => e.item),
    high: sorted.slice(bestK).map(e => e.item),
    lowMean: mean(lowVals),
    highMean: mean(highVals),
    lowMedian: median(lowVals),
    highMedian: median(highVals),
    gap: bestGap,
    r2: Math.max(0, Math.min(1, 1 - bestSse / sst))
  };
}

function detectScoreOutliers(entries) {
  const valid = entries.filter(entry => finite(entry.metrics.score));
  if (valid.length < 2) return null;
  if (valid.length === 2) {
    const [low, high] = [...valid].sort((a, b) => a.metrics.score - b.metrics.score);
    const diff = high.metrics.score - low.metrics.score;
    if (diff < SCORE_PAIRWISE_DIFF) return null;
    return {
      isPairwise: true,
      outliers: [low],
      reference: [high],
      outlierMean: low.metrics.score,
      referenceMean: high.metrics.score,
      gap: diff,
      r2: 1
    };
  }

  const split = partition1D(valid, entry => entry.metrics.score);
  if (!split) return null;
  const meanDiff = split.highMean - split.lowMean;
  const separated =
    (split.gap >= SCORE_CLUSTER_GAP && meanDiff >= SCORE_CLUSTER_MEAN_DIFF) ||
    (meanDiff >= SCORE_CLUSTER_R2_DIFF && split.r2 >= SCORE_CLUSTER_MIN_R2);
  if (!separated) return null;

  const minorityLow = split.low.length < split.high.length;
  const starkTie = split.low.length === split.high.length && meanDiff >= 15 && split.gap >= 10;
  if (!minorityLow && !starkTie) return null;

  return {
    isPairwise: false,
    outliers: split.low,
    reference: split.high,
    outlierMean: split.lowMean,
    referenceMean: split.highMean,
    gap: split.gap,
    r2: split.r2
  };
}

function detectCostOutliers(entries) {
  const valid = entries.filter(entry => finite(entry.metrics.cost) && entry.metrics.cost > 0);
  if (valid.length < 2) return null;
  if (valid.length === 2) {
    const [low, high] = [...valid].sort((a, b) => a.metrics.cost - b.metrics.cost);
    const ratio = high.metrics.cost / low.metrics.cost;
    const diff = high.metrics.cost - low.metrics.cost;
    if (ratio < COST_PAIRWISE_RATIO || diff < COST_MIN_ABS_DIFF) return null;
    return {
      isPairwise: true,
      outliers: [high],
      reference: [low],
      outlierMedian: high.metrics.cost,
      referenceMedian: low.metrics.cost,
      ratio,
      r2: 1
    };
  }

  const split = partition1D(valid, entry => Math.log(entry.metrics.cost));
  if (!split) return null;
  const lowCosts = split.low.map(e => e.metrics.cost).sort((a, b) => a - b);
  const highCosts = split.high.map(e => e.metrics.cost).sort((a, b) => a - b);
  const lowMed = median(lowCosts);
  const highMed = median(highCosts);
  const ratio = lowMed > 0 ? highMed / lowMed : 0;
  const boundaryRatio = lowCosts[lowCosts.length - 1] > 0 ? highCosts[0] / lowCosts[lowCosts.length - 1] : 0;
  const absDiff = highCosts[0] - lowMed;

  if (absDiff < COST_MIN_ABS_DIFF) return null;
  const separated =
    (boundaryRatio >= COST_CLUSTER_BOUNDARY_RATIO && ratio >= COST_CLUSTER_RATIO) ||
    (ratio >= COST_CLUSTER_R2_RATIO && split.r2 >= SCORE_CLUSTER_MIN_R2);
  if (!separated) return null;

  const minorityHigh = split.high.length < split.low.length;
  const starkTie = split.high.length === split.low.length && ratio >= 2.0;
  if (!minorityHigh && !starkTie) return null;

  return {
    isPairwise: false,
    outliers: split.high,
    reference: split.low,
    outlierMedian: highMed,
    referenceMedian: lowMed,
    ratio,
    r2: split.r2
  };
}

function formatScore(value) {
  return Number(value).toFixed(1);
}

function formatUsd(value) {
  if (!finite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatPct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

function formatDuration(seconds) {
  if (!finite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m${s}s` : `${m}m`;
}

function pickRepresentativePerKey(records, keyFn) {
  const byKey = new Map();
  for (const record of records) {
    const key = keyFn(record);
    const prev = byKey.get(key);
    if (!prev || recordTimestamp(record.record) > recordTimestamp(prev.record)) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

function sampleAnomalyHint(entry) {
  const tags = [];
  if (entry.metrics.hasTimeout) tags.push('含样本超时');
  if (entry.metrics.hasNoSubmission) tags.push('含未提交');
  return tags.length ? `（${tags.join('、')}）` : '';
}

function summarizeModels(items, limit = 3) {
  const labels = items.map(item => item.detailLabel);
  if (labels.length <= limit) return labels.join('；');
  return `${labels.slice(0, limit).join('；')} 等 ${labels.length} 项`;
}

function buildItem({
  id,
  entry,
  metric,
  severity,
  magnitude,
  method,
  valueText,
  refText,
  refContext,
  deltaText,
  detailLabel,
  recordIds,
  referenceIds
}) {
  const uniqueRecordIds = [...new Set((recordIds || [entry.id]).filter(Boolean))];
  const uniqueRefIds = [...new Set((referenceIds || []).filter(Boolean))];
  return {
    id,
    method,
    modelKey: entry.identity.modelKey,
    modelLabel: entry.identity.modelLabel,
    modelName: entry.identity.modelDisplayName,
    thinkLabel: thinkingLabel(entry.identity.think),
    metric,
    severity,
    magnitude,
    valueText,
    refText,
    refContext,
    deltaText,
    detailLabel,
    recordIds: uniqueRecordIds,
    referenceIds: uniqueRefIds,
    primaryRecordId: uniqueRecordIds[0] || entry.id
  };
}

function summarizeProviderRefs(refBuckets, refEntries) {
  const labels = [...new Set(refBuckets.map(bucket => bucket.providerLabel).filter(Boolean))];
  if (!labels.length) return refEntries.length > 1 ? `对照渠道（${refEntries.length} 项）` : '对照渠道';
  if (labels.length === 1) {
    return refEntries.length > 1 ? `${labels[0]}（${refEntries.length} 项）` : labels[0];
  }
  const joined = labels.length <= 2 ? labels.join('、') : `${labels.slice(0, 2).join('、')} 等 ${labels.length} 渠道`;
  return refEntries.length > labels.length ? `${joined}（${refEntries.length} 项）` : joined;
}

function closestEntryByValue(entries, target, getter) {
  let best = entries[0];
  let bestDiff = Infinity;
  for (const entry of entries) {
    const value = getter(entry);
    if (!finite(value)) continue;
    const diff = Math.abs(value - target);
    if (diff < bestDiff - 1e-12 || (Math.abs(diff - bestDiff) <= 1e-12 && recordTimestamp(entry.record) > recordTimestamp(best.record))) {
      best = entry;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * Automatic anomaly analysis across channels and accounts using:
 * 1) Baseline comparison (against matching bank/model/Thinking baselines)
 * 2) Deterministic 1D clustering & pairwise channel/account comparison
 *
 * Pure function with no DOM dependencies.
 */
export function analyzeAnomalies(records, { baselinePool = null } = {}) {
  if (!Array.isArray(records) || !records.length) {
    return { findings: [], groups: [], comparableGroups: 0, baselinePairs: 0 };
  }

  const pool = Array.isArray(baselinePool) && baselinePool.length ? baselinePool : records;
  const wrapped = records
    .filter(record => record && !record.exclusionReason)
    .map(record => ({
      record,
      id: record.id,
      source: record.source,
      identity: recordIdentity(record),
      metrics: extractMetrics(record)
    }))
    .filter(entry => entry.identity.model && finite(entry.metrics.score));

  if (!wrapped.length) {
    return { findings: [], groups: [], comparableGroups: 0, baselinePairs: 0 };
  }

  const providerDistinctAccounts = new Map();
  for (const entry of wrapped) {
    if (!entry.identity.distinctAccount || !entry.identity.accountRaw) continue;
    let set = providerDistinctAccounts.get(entry.identity.providerKey);
    if (!set) {
      set = new Set();
      providerDistinctAccounts.set(entry.identity.providerKey, set);
    }
    set.add(entry.identity.accountRaw);
  }

  const findings = [];
  let baselinePairs = 0;
  let comparableGroups = 0;

  // --- 1. Baseline-based comparison ---
  const baselineEntries = pool
    .filter(record => record && record.source === 'baseline' && !record.exclusionReason)
    .map(record => ({
      record,
      id: record.id,
      bankVersion: recordBankVersion(record),
      sourceKey: baselineSourceKey(record),
      identity: recordIdentity(record),
      metrics: extractMetrics(record)
    }))
    .filter(entry => entry.identity.model && finite(entry.metrics.score));

  const runReps = pickRepresentativePerKey(
    wrapped.filter(entry => entry.source !== 'baseline'),
    entry => `${entry.identity.entityKey}::${entry.identity.modelKey}`
  );
  const baselineHits = new Map(); // `${entityKey}::${metric}` -> hit[]

  for (const entry of runReps) {
    const matches = findComparableBaselines(entry, baselineEntries);
    if (!matches.length) continue;
    const baseEntry = matches[0];
    const baseMetrics = baseEntry.metrics;
    if (!finite(baseMetrics.score)) continue;
    baselinePairs++;

    const pushHit = (metric, hit) => {
      const key = `${entry.identity.entityKey}::${metric}`;
      let list = baselineHits.get(key);
      if (!list) {
        list = [];
        baselineHits.set(key, list);
      }
      list.push(hit);
    };

    const scoreDelta = entry.metrics.score - baseMetrics.score;
    if (scoreDelta <= -SCORE_BASELINE_DROP) {
      const severity = scoreDelta <= -SCORE_BASELINE_SEVERE_DROP ? 'high' : 'medium';
      const detailLabel = `${entry.identity.modelLabel}（${formatScore(entry.metrics.score)} vs 基线 ${formatScore(baseMetrics.score)}，${formatScore(scoreDelta)} 分${sampleAnomalyHint(entry) ? `，${sampleAnomalyHint(entry).slice(1, -1)}` : ''}）`;
      pushHit('score', {
        entry,
        severity,
        magnitude: Math.abs(scoreDelta),
        detailLabel,
        item: buildItem({
          id: `baseline:${entry.identity.entityKey}::score::${entry.identity.modelKey}`,
          entry,
          metric: 'score',
          severity,
          magnitude: Math.abs(scoreDelta),
          method: 'baseline',
          valueText: formatScore(entry.metrics.score),
          refText: formatScore(baseMetrics.score),
          refContext: '基线',
          deltaText: `${formatScore(scoreDelta)} 分`,
          detailLabel,
          recordIds: [entry.id],
          referenceIds: [baseEntry.id]
        })
      });
    }

    if (finite(entry.metrics.cost) && finite(baseMetrics.cost) && baseMetrics.cost > 0 && entry.metrics.cost > 0) {
      const costDiff = entry.metrics.cost - baseMetrics.cost;
      const costRatio = costDiff / baseMetrics.cost;
      if (costRatio >= COST_BASELINE_RATIO && costDiff >= COST_MIN_ABS_DIFF) {
        const severity = costRatio >= COST_BASELINE_SEVERE_RATIO ? 'high' : 'medium';
        const detailLabel = `${entry.identity.modelLabel}（${formatUsd(entry.metrics.cost)} vs 基线 ${formatUsd(baseMetrics.cost)}，+${formatPct(costRatio)}）`;
        pushHit('cost', {
          entry,
          severity,
          magnitude: costRatio * 100,
          detailLabel,
          item: buildItem({
            id: `baseline:${entry.identity.entityKey}::cost::${entry.identity.modelKey}`,
            entry,
            metric: 'cost',
            severity,
            magnitude: costRatio * 100,
            method: 'baseline',
            valueText: formatUsd(entry.metrics.cost),
            refText: formatUsd(baseMetrics.cost),
            refContext: '基线',
            deltaText: `+${formatPct(costRatio)}`,
            detailLabel,
            recordIds: [entry.id],
            referenceIds: [baseEntry.id]
          })
        });
      }
    }

    if (finite(entry.metrics.duration) && finite(baseMetrics.duration) && baseMetrics.duration > 0) {
      const durDiff = entry.metrics.duration - baseMetrics.duration;
      const durRatio = durDiff / baseMetrics.duration;
      if (durRatio >= DURATION_BASELINE_RATIO && durDiff >= DURATION_MIN_ABS_DIFF) {
        const severity = durRatio >= 1.2 ? 'high' : 'medium';
        const detailLabel = `${entry.identity.modelLabel}（${formatDuration(entry.metrics.duration)} vs 基线 ${formatDuration(baseMetrics.duration)}，+${formatPct(durRatio)}）`;
        pushHit('duration', {
          entry,
          severity,
          magnitude: durRatio * 50,
          detailLabel,
          item: buildItem({
            id: `baseline:${entry.identity.entityKey}::duration::${entry.identity.modelKey}`,
            entry,
            metric: 'duration',
            severity,
            magnitude: durRatio * 50,
            method: 'baseline',
            valueText: formatDuration(entry.metrics.duration),
            refText: formatDuration(baseMetrics.duration),
            refContext: '基线',
            deltaText: `+${formatPct(durRatio)}`,
            detailLabel,
            recordIds: [entry.id],
            referenceIds: [baseEntry.id]
          })
        });
      }
    }
  }

  for (const [groupKey, hits] of baselineHits) {
    hits.sort((a, b) => b.magnitude - a.magnitude);
    const first = hits[0].entry;
    const metric = groupKey.split('::').pop();
    const severity = hits.some(h => h.severity === 'high') || hits.length >= 2 ? 'high' : 'medium';
    const verb = metric === 'score' ? '低于基线' : metric === 'cost' ? '成本高于基线' : '耗时慢于基线';
    const summary =
      hits.length > 1 ? `在 ${hits.length} 个模型配置上均${verb}：${summarizeModels(hits)}` : `${verb}：${hits[0].detailLabel}`;
    findings.push({
      id: `baseline:${groupKey}`,
      method: 'baseline',
      scope: hits.length > 1 ? 'channel' : 'model',
      metric,
      severity,
      magnitude: hits[0].magnitude + (hits.length - 1) * 10,
      modelCount: hits.length,
      providerKey: first.identity.providerKey,
      providerLabel: first.identity.providerLabel,
      accountRaw: first.identity.accountRaw,
      summary,
      recordIds: hits.map(h => h.entry.id),
      items: hits.map(h => h.item)
    });
  }

  // --- 2. Within-provider account anomaly (clustering / pairwise) ---
  const byProviderModel = new Map();
  for (const entry of wrapped) {
    const key = `${entry.identity.providerKey}::${entry.identity.modelKey}`;
    let list = byProviderModel.get(key);
    if (!list) {
      list = [];
      byProviderModel.set(key, list);
    }
    list.push(entry);
  }

  const accountAnomalyKeys = new Set(); // `${entityKey}::${modelKey}::${metric}`
  const accountHits = new Map(); // `${entityKey}::${metric}` -> hit[]

  for (const list of byProviderModel.values()) {
    const reps = pickRepresentativePerKey(list, entry => entry.identity.accountKey);
    if (reps.length < 2) continue;
    comparableGroups++;

    const scoreOut = detectScoreOutliers(reps);
    if (scoreOut) {
      const refIds = scoreOut.reference.map(e => e.id);
      for (const outlier of scoreOut.outliers) {
        const diff = outlier.metrics.score - scoreOut.referenceMean;
        const severity = diff <= -15 ? 'high' : 'medium';
        const key = `${outlier.identity.entityKey}::score`;
        accountAnomalyKeys.add(`${outlier.identity.entityKey}::${outlier.identity.modelKey}::score`);
        let bucket = accountHits.get(key);
        if (!bucket) {
          bucket = [];
          accountHits.set(key, bucket);
        }
        const detailLabel = `${outlier.identity.modelLabel}（${formatScore(outlier.metrics.score)} vs 同渠道其余 ${scoreOut.reference.length} 个账号均分 ${formatScore(scoreOut.referenceMean)}，${formatScore(diff)} 分${sampleAnomalyHint(outlier) ? `，${sampleAnomalyHint(outlier).slice(1, -1)}` : ''}）`;
        bucket.push({
          entry: outlier,
          severity,
          magnitude: Math.abs(diff),
          refCount: scoreOut.reference.length,
          detailLabel,
          item: buildItem({
            id: `account:${key}::${outlier.identity.modelKey}`,
            entry: outlier,
            metric: 'score',
            severity,
            magnitude: Math.abs(diff),
            method: 'cluster',
            valueText: formatScore(outlier.metrics.score),
            refText: formatScore(scoreOut.referenceMean),
            refContext: `同渠道 ${scoreOut.reference.length} 账号`,
            deltaText: `${formatScore(diff)} 分`,
            detailLabel,
            recordIds: [outlier.id],
            referenceIds: refIds
          })
        });
      }
    }

    const costOut = detectCostOutliers(reps);
    if (costOut) {
      const refIds = costOut.reference.map(e => e.id);
      for (const outlier of costOut.outliers) {
        const ratio = outlier.metrics.cost / costOut.referenceMedian - 1;
        const severity = ratio >= 0.7 ? 'high' : 'medium';
        const key = `${outlier.identity.entityKey}::cost`;
        accountAnomalyKeys.add(`${outlier.identity.entityKey}::${outlier.identity.modelKey}::cost`);
        let bucket = accountHits.get(key);
        if (!bucket) {
          bucket = [];
          accountHits.set(key, bucket);
        }
        const detailLabel = `${outlier.identity.modelLabel}（${formatUsd(outlier.metrics.cost)} vs 同渠道其余 ${costOut.reference.length} 个账号 ${formatUsd(costOut.referenceMedian)}，+${formatPct(ratio)}）`;
        bucket.push({
          entry: outlier,
          severity,
          magnitude: ratio * 100,
          refCount: costOut.reference.length,
          detailLabel,
          item: buildItem({
            id: `account:${key}::${outlier.identity.modelKey}`,
            entry: outlier,
            metric: 'cost',
            severity,
            magnitude: ratio * 100,
            method: 'cluster',
            valueText: formatUsd(outlier.metrics.cost),
            refText: formatUsd(costOut.referenceMedian),
            refContext: `同渠道 ${costOut.reference.length} 账号`,
            deltaText: `+${formatPct(ratio)}`,
            detailLabel,
            recordIds: [outlier.id],
            referenceIds: refIds
          })
        });
      }
    }
  }

  for (const [groupKey, hits] of accountHits) {
    hits.sort((a, b) => b.magnitude - a.magnitude);
    const first = hits[0].entry;
    const metric = groupKey.split('::').pop();
    const severity = hits.some(h => h.severity === 'high') || hits.length >= 2 ? 'high' : 'medium';
    const verb = metric === 'score' ? '得分显著低于同渠道其他账号' : '成本显著高于同渠道其他账号';
    const summary =
      hits.length > 1 ? `在 ${hits.length} 个模型配置上均${verb}：${summarizeModels(hits)}` : `${verb}：${hits[0].detailLabel}`;
    findings.push({
      id: `account:${groupKey}`,
      method: 'cluster',
      scope: 'account',
      metric,
      severity,
      magnitude: hits[0].magnitude + (hits.length - 1) * 10,
      modelCount: hits.length,
      providerKey: first.identity.providerKey,
      providerLabel: first.identity.providerLabel,
      accountRaw: first.identity.accountRaw,
      summary,
      recordIds: hits.map(h => h.entry.id),
      items: hits.map(h => h.item)
    });
  }

  // --- 3. Cross-channel clustering & pairwise comparison (aggregated per channel first) ---
  const byModel = new Map();
  for (const entry of wrapped) {
    let list = byModel.get(entry.identity.modelKey);
    if (!list) {
      list = [];
      byModel.set(entry.identity.modelKey, list);
    }
    list.push(entry);
  }

  const channelHits = new Map(); // `${providerKey}::${metric}` -> hit[]

  for (const list of byModel.values()) {
    const reps = pickRepresentativePerKey(list, entry => entry.identity.entityKey);
    const byProvider = new Map();
    for (const entry of reps) {
      let bucket = byProvider.get(entry.identity.providerKey);
      if (!bucket) {
        bucket = [];
        byProvider.set(entry.identity.providerKey, bucket);
      }
      bucket.push(entry);
    }
    if (byProvider.size < 2) continue;
    comparableGroups++;

    // Build per-channel score aggregates using non-outlier accounts (or all if none excluded).
    const scoreChannelNodes = [];
    for (const [providerKey, entries] of byProvider) {
      const normal = entries.filter(e => !accountAnomalyKeys.has(`${e.identity.entityKey}::${e.identity.modelKey}::score`));
      const baseEntries = normal.length ? normal : entries;
      const scores = baseEntries
        .map(e => e.metrics.score)
        .filter(finite)
        .sort((a, b) => a - b);
      if (!scores.length) continue;
      const repScore = median(scores);
      const repEntry = closestEntryByValue(baseEntries, repScore, e => e.metrics.score);
      const allScores = entries.map(e => e.metrics.score).filter(finite);
      scoreChannelNodes.push({
        providerKey,
        providerLabel: repEntry.identity.providerLabel,
        entry: repEntry,
        entries,
        baseEntries,
        minScore: Math.min(...allScores),
        metrics: { score: repScore }
      });
    }

    const scoreOut = detectScoreOutliers(scoreChannelNodes);
    if (scoreOut) {
      const refEntries = scoreOut.reference.flatMap(node => node.baseEntries);
      const refScores = refEntries.map(e => e.metrics.score).filter(finite);
      const refScoreMean = refScores.length ? mean(refScores) : scoreOut.referenceMean;
      const refIds = refEntries.map(e => e.id);
      const refContext = summarizeProviderRefs(scoreOut.reference, refEntries);

      for (const outlierNode of scoreOut.outliers) {
        const diff = outlierNode.metrics.score - refScoreMean;
        const worstDiff = outlierNode.minScore - refScoreMean;
        const severity = diff <= -15 ? 'high' : 'medium';
        const bucketKey = `${outlierNode.providerKey}::score`;
        let bucket = channelHits.get(bucketKey);
        if (!bucket) {
          bucket = [];
          channelHits.set(bucketKey, bucket);
        }
        const multiAcc = outlierNode.entries.length > 1;
        const valueText = multiAcc ? `中位 ${formatScore(outlierNode.metrics.score)}` : formatScore(outlierNode.metrics.score);
        const deltaText =
          multiAcc && Math.abs(worstDiff - diff) >= 2 ? `${formatScore(diff)} ~ ${formatScore(worstDiff)} 分` : `${formatScore(diff)} 分`;
        const refLabel = scoreOut.isPairwise
          ? `对照渠道 ${scoreOut.reference[0].providerLabel}（${formatScore(refScoreMean)}）`
          : `同组高分簇 ${refEntries.length} 项均分 ${formatScore(refScoreMean)}`;
        const detailLabel = `${outlierNode.entry.identity.modelLabel}（${valueText} vs ${refLabel}，${deltaText}${sampleAnomalyHint(outlierNode.entry) ? `，${sampleAnomalyHint(outlierNode.entry).slice(1, -1)}` : ''}）`;
        const orderedIds = [outlierNode.entry.id, ...outlierNode.entries.map(e => e.id).filter(id => id !== outlierNode.entry.id)];
        bucket.push({
          entry: outlierNode.entry,
          entries: outlierNode.entries,
          severity,
          magnitude: Math.abs(diff),
          detailLabel,
          item: buildItem({
            id: `channel:${bucketKey}::${outlierNode.entry.identity.modelKey}`,
            entry: outlierNode.entry,
            metric: 'score',
            severity,
            magnitude: Math.abs(diff),
            method: 'cluster',
            valueText,
            refText: formatScore(refScoreMean),
            refContext,
            deltaText,
            detailLabel,
            recordIds: orderedIds,
            referenceIds: refIds
          })
        });
      }
    }

    // Build per-channel cost aggregates using non-outlier accounts (or all if none excluded).
    const costChannelNodes = [];
    for (const [providerKey, entries] of byProvider) {
      const normal = entries.filter(e => !accountAnomalyKeys.has(`${e.identity.entityKey}::${e.identity.modelKey}::cost`));
      const baseEntries = normal.length ? normal : entries;
      const validBase = baseEntries.filter(e => finite(e.metrics.cost) && e.metrics.cost > 0);
      if (!validBase.length) continue;
      const baseCosts = validBase.map(e => e.metrics.cost).sort((a, b) => a - b);
      const repCost = median(baseCosts);
      const repEntry = closestEntryByValue(validBase, repCost, e => e.metrics.cost);
      const allValid = entries.filter(e => finite(e.metrics.cost) && e.metrics.cost > 0);
      const maxCost = Math.max(...allValid.map(e => e.metrics.cost));
      costChannelNodes.push({
        providerKey,
        providerLabel: repEntry.identity.providerLabel,
        entry: repEntry,
        entries: allValid,
        baseEntries: validBase,
        maxCost,
        metrics: { cost: repCost }
      });
    }

    const costOut = detectCostOutliers(costChannelNodes);
    if (costOut) {
      const refEntries = costOut.reference.flatMap(node => node.baseEntries);
      const refCosts = refEntries
        .map(e => e.metrics.cost)
        .filter(c => finite(c) && c > 0)
        .sort((a, b) => a - b);
      const refCostMed = refCosts.length ? median(refCosts) : costOut.referenceMedian;
      const refIds = refEntries.map(e => e.id);
      const refContext = summarizeProviderRefs(costOut.reference, refEntries);

      for (const outlierNode of costOut.outliers) {
        const ratio = outlierNode.metrics.cost / refCostMed - 1;
        const maxRatio = outlierNode.maxCost / refCostMed - 1;
        const severity = ratio >= 0.7 ? 'high' : 'medium';
        const bucketKey = `${outlierNode.providerKey}::cost`;
        let bucket = channelHits.get(bucketKey);
        if (!bucket) {
          bucket = [];
          channelHits.set(bucketKey, bucket);
        }
        const multiAcc = outlierNode.entries.length > 1;
        const valueText = multiAcc ? `中位 ${formatUsd(outlierNode.metrics.cost)}` : formatUsd(outlierNode.metrics.cost);
        const deltaText = multiAcc && maxRatio - ratio >= 0.15 ? `+${formatPct(ratio)} ~ +${formatPct(maxRatio)}` : `+${formatPct(ratio)}`;
        const refLabel = costOut.isPairwise
          ? `对照渠道 ${costOut.reference[0].providerLabel}（${formatUsd(refCostMed)}）`
          : `同组低成本簇 ${refEntries.length} 项中位 ${formatUsd(refCostMed)}`;
        const detailLabel = `${outlierNode.entry.identity.modelLabel}（${valueText} vs ${refLabel}，${deltaText}）`;
        const orderedIds = [outlierNode.entry.id, ...outlierNode.entries.map(e => e.id).filter(id => id !== outlierNode.entry.id)];
        bucket.push({
          entry: outlierNode.entry,
          entries: outlierNode.entries,
          severity,
          magnitude: ratio * 100,
          detailLabel,
          item: buildItem({
            id: `channel:${bucketKey}::${outlierNode.entry.identity.modelKey}`,
            entry: outlierNode.entry,
            metric: 'cost',
            severity,
            magnitude: ratio * 100,
            method: 'cluster',
            valueText,
            refText: formatUsd(refCostMed),
            refContext,
            deltaText,
            detailLabel,
            recordIds: orderedIds,
            referenceIds: refIds
          })
        });
      }
    }
  }

  for (const [groupKey, hits] of channelHits) {
    hits.sort((a, b) => b.magnitude - a.magnitude);
    const first = hits[0].entry;
    const metric = groupKey.split('::').pop();
    const severity = hits.some(h => h.severity === 'high') || hits.length >= 2 ? 'high' : 'medium';
    const distinctAccounts = new Set(hits.flatMap(h => h.entries.map(e => e.identity.accountRaw)).filter(Boolean));
    const accountRaw = distinctAccounts.size === 1 ? [...distinctAccounts][0] : '';
    const verb = metric === 'score' ? '显著低于同模型其他渠道' : '成本显著高于同模型其他渠道';
    const summary =
      hits.length > 1 ? `在 ${hits.length} 个模型配置上均${verb}：${summarizeModels(hits)}` : `${verb}：${hits[0].detailLabel}`;
    findings.push({
      id: `channel:${groupKey}`,
      method: 'cluster',
      scope: hits.length > 1 ? 'channel' : 'model',
      metric,
      severity,
      magnitude: hits[0].magnitude + (hits.length - 1) * 10,
      modelCount: hits.length,
      providerKey: first.identity.providerKey,
      providerLabel: first.identity.providerLabel,
      accountRaw,
      summary,
      recordIds: hits.map(h => h.entry.id),
      items: hits.map(h => h.item)
    });
  }

  const metricRank = { score: 0, cost: 1, duration: 2 };
  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    if (a.modelCount !== b.modelCount) return b.modelCount - a.modelCount;
    if (metricRank[a.metric] !== metricRank[b.metric]) return metricRank[a.metric] - metricRank[b.metric];
    if (b.magnitude !== a.magnitude) return b.magnitude - a.magnitude;
    return a.id.localeCompare(b.id);
  });

  // --- 4. Group findings by entity (account vs channel) for structured display ---
  const groupMap = new Map();
  for (const finding of findings) {
    const isAccountGroup = finding.scope === 'account' || (finding.method === 'baseline' && Boolean(finding.accountRaw));
    const kind = isAccountGroup ? 'account' : 'channel';
    const groupId = isAccountGroup ? `account:${finding.providerKey}::${finding.accountRaw}` : `channel:${finding.providerKey}`;
    let group = groupMap.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        kind,
        providerKey: finding.providerKey,
        providerLabel: finding.providerLabel,
        accountRaw: isAccountGroup ? finding.accountRaw : '',
        accountCount: isAccountGroup ? 1 : (providerDistinctAccounts.get(finding.providerKey)?.size ?? 0),
        severity: finding.severity,
        maxMagnitude: finding.magnitude,
        metrics: { score: 0, cost: 0, duration: 0 },
        items: [],
        recordIds: [],
        findingIds: []
      };
      groupMap.set(groupId, group);
    }
    if (finding.severity === 'high') group.severity = 'high';
    if (finding.magnitude > group.maxMagnitude) group.maxMagnitude = finding.magnitude;
    group.findingIds.push(finding.id);
    for (const item of finding.items || []) {
      group.items.push(item);
      if (item.metric in group.metrics) group.metrics[item.metric]++;
      for (const id of item.recordIds) {
        if (!group.recordIds.includes(id)) group.recordIds.push(id);
      }
    }
  }

  const groups = [...groupMap.values()].map(group => {
    group.items.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
      if (metricRank[a.metric] !== metricRank[b.metric]) return metricRank[a.metric] - metricRank[b.metric];
      if (b.magnitude !== a.magnitude) return b.magnitude - a.magnitude;
      return a.id.localeCompare(b.id);
    });
    return group;
  });

  groups.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'account' ? -1 : 1;
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    if (b.maxMagnitude !== a.maxMagnitude) return b.maxMagnitude - a.maxMagnitude;
    return a.id.localeCompare(b.id);
  });

  return { findings, groups, comparableGroups, baselinePairs };
}
