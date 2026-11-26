import { remoteRouteNamespace } from './data-adapter.js';
import { sortThinkingEfforts, thinkingLabel } from './data-picker.js';
import { renderInlineSampleInspector, resolveTaskSpec, splitTaskId } from './sample-inspector.js';

/** Render history and movable inline details; coordinator owns selection and polling. */
export function createTaskHistoryView({ app, state, retryRequests, retrying, baselineBusy = new Set() }) {
  const { byId: lookupElement, escapeHtml, activeStatus, statusText, formatDate, request } = app.services;
  const callSummaries = new Map(); // run id -> { key, calls | null, loading }
  const sampleEvents = new Map(); // `${runId}\u0000${sampleId}` -> { key, events | null, loading, error }
  const inspectorByRun = new Map(); // run id -> { sampleId, tab, showAllFields, showPrompt, attemptId, matrixFilter }
  const taskFilterByTask = new Map(); // task id -> 'all' | 'anomaly'
  function getInspectorState(runId) {
    let entry = inspectorByRun.get(runId);
    if (!entry) {
      entry = {
        sampleId: null,
        tab: null,
        showAllFields: false,
        showPrompt: false,
        attemptId: null,
        matrixFilter: 'all',
        anomalyOrder: []
      };
      inspectorByRun.set(runId, entry);
    }
    return entry;
  }
  const detailElements = new Map(
    [
      'bench-close-task',
      'bench-close-run',
      'bench-task-section',
      'bench-task-title',
      'bench-task-detail',
      'bench-baseline-task',
      'bench-unbaseline-task',
      'bench-cancel-task',
      'bench-copy-task',
      'bench-retry-task',
      'bench-run-section',
      'bench-run-detail',
      'bench-run-title',
      'bench-baseline-run',
      'bench-unbaseline-run',
      'bench-cancel-run',
      'bench-copy-run',
      'bench-retry-run'
    ].map(id => [id, lookupElement(id)])
  );
  const element = id => lookupElement(id) || detailElements.get(id);
  const inProgress = record => record && (activeStatus(record.status) || record.status === 'cancelling');
  const canCancel = record => inProgress(record) && record.status !== 'cancelling';
  const fixedTargets = record => record.plan?.targets || record.targets || [];
  function formatBaselineReason(reason, record) {
    const raw = typeof reason === 'string' ? reason.trim() : '';
    const text = raw.replace(/^Assessment baseline:\s*/i, '');
    const status = record?.status;
    const counts = record?.sample_status_counts || {};
    const statusReason = () => {
      if (status === 'queued' || status === 'running' || status === 'cancelling') return '运行尚未完成';
      if (status === 'failed') {
        const failed = counts.api_failure ?? 0;
        if (failed > 0) return `含 ${failed} 个 API 失败样本`;
        const postNonModel =
          record?.result_quality?.ended_after_non_model_samples ??
          (Array.isArray(record?.samples) ? record.samples.filter(isPostSubmissionNonModelSample).length : 0);
        return postNonModel > 0 ? `含 ${postNonModel} 个非模型异常样本` : '含非模型异常样本';
      }
      if (status === 'cancelled') return '运行已取消';
      if (status === 'interrupted') return '运行已中断';
      if (status === 'incomplete') return '运行未完成';
      if (status === 'timeout') {
        const timeouts = counts.timeout ?? 0;
        return timeouts > 0 ? `含 ${timeouts} 个超时样本` : '含超时样本';
      }
      return '';
    };
    if (text.includes('timed-out samples are not eligible')) return '含超时样本';
    if (text.includes('non-model anomalies are not eligible')) return '含非模型异常样本';
    if (text.includes('retry execution sources differ')) return '重试时源码版本发生变化';
    if (text.includes('retry execution policy differs') || text.includes('retry execution limits differ'))
      return '重试时评测限额或策略发生变化';
    if (text.includes('invalid retry batch evidence')) return '重试批次证据不完整';
    if (
      text.includes('retry:') &&
      (text.includes('source hashes') || text.includes('source provenance') || text.includes('invalid source digest'))
    )
      return '重试时题库或源码快照已过期';
    if (text.includes('failed or incomplete samples')) {
      const timeouts = counts.timeout ?? 0;
      if (timeouts > 0) return `含 ${timeouts} 个超时样本`;
      const failed = counts.api_failure ?? 0;
      if (failed > 0) return `含 ${failed} 个 API 失败样本`;
      return statusReason() || '含未完成或失败样本';
    }
    if (text.includes('run must be completed')) return statusReason() || '运行尚未完成';
    if (text.includes('only the whole Assessment') || text.includes('only whole released Mini Bench banks'))
      return '仅全量官方题库可设为基线';
    if (text.includes('all 12 tasks are required')) return '缺少完整 12 题';
    if (text.includes('current bank provenance mismatch') || text.includes('task snapshots differ')) return '题库版本与当前不一致';
    if (text.includes('source hashes are missing or stale') || text.includes('execution source provenance is missing'))
      return '题库或源码快照已过期';
    if (text.includes('invalid round count')) return '轮次不在 1~3 范围内';
    if (text.includes('every planned round must contain exactly 12 samples')) return '轮次样本数不完整';
    if (text.includes('ungradable content')) return '含无法评分样本';
    if (text.includes('instruction checks are missing') || text.includes('grade outcome is missing')) return '评分证据不完整';
    if (text.includes('sample execution protocol is unknown')) return '执行协议与当前不兼容';
    if (text.includes('invalid protocol limits') || text.includes('invalid API retry policy') || text.includes('invalid timeout scope'))
      return '评测限额协议与当前不兼容';
    if (
      text.includes('target identity is incomplete') ||
      text.includes('sample identity differs') ||
      text.includes('sample target identity differs')
    )
      return '运行目标标识不完整';
    if (text.includes('malformed run evidence')) return '运行证据不完整';
    if (text) return '不符合当前基线校验条件';
    return statusReason() || '不符合基线条件';
  }
  function summarizeIneligibleReasons(items) {
    if (!items.length) return '';
    const counts = new Map();
    for (const item of items) {
      const text = formatBaselineReason(item.reason, item.record);
      counts.set(text, (counts.get(text) || 0) + 1);
    }
    const entries = [...counts.entries()];
    if (entries.length === 1) return entries[0][0];
    return entries.map(([text, count]) => (count > 1 ? `${text} ×${count}` : text)).join('；');
  }
  function childBaselineState(child) {
    return {
      eligible: Boolean(child?.baseline_eligible),
      reason: typeof child?.ineligibility_reason === 'string' && child.ineligibility_reason ? child.ineligibility_reason : null,
      baselineId: typeof child?.baseline_id === 'string' && child.baseline_id ? child.baseline_id : null
    };
  }
  function summarizeBaselineGroup(children) {
    const promotable = [];
    const promoted = [];
    const ineligible = [];
    for (const child of children) {
      const base = childBaselineState(child);
      if (base.baselineId) promoted.push(child);
      else if (!inProgress(child) && base.eligible && child.target?.id) promotable.push(child);
      else ineligible.push({ record: child, reason: inProgress(child) ? 'Assessment baseline: run must be completed' : base.reason });
    }
    return { promotable, promoted, ineligible, ineligibleReason: summarizeIneligibleReasons(ineligible) };
  }
  function setBaselineHeaderButton(btn, { hidden, busy, busyText, label, title, ariaLabel, ineligibleReason }) {
    if (!btn) return;
    btn.hidden = Boolean(hidden);
    btn.textContent = busy ? busyText : label;
    btn.title = title || '';
    if (ineligibleReason) {
      btn.disabled = false;
      btn.setAttribute?.('aria-disabled', 'true');
      if (ariaLabel) btn.setAttribute?.('aria-label', ariaLabel);
      btn.classList?.toggle('is-baseline-ineligible', true);
      if (btn.dataset) btn.dataset.baselineIneligibleReason = ineligibleReason;
      else btn.setAttribute?.('data-baseline-ineligible-reason', ineligibleReason);
    } else {
      btn.disabled = Boolean(busy);
      btn.removeAttribute?.('aria-disabled');
      if (ariaLabel) btn.setAttribute?.('aria-label', ariaLabel);
      else btn.removeAttribute?.('aria-label');
      btn.classList?.toggle('is-baseline-ineligible', false);
      if (btn.dataset) delete btn.dataset.baselineIneligibleReason;
      btn.removeAttribute?.('data-baseline-ineligible-reason');
    }
  }
  function latestRunSummary(runId) {
    if (!runId) return null;
    const fromSelectedTask = state.taskDetail?.children?.find(child => child.run_id === runId);
    if (fromSelectedTask) return fromSelectedTask;
    for (const task of state.tasks || []) {
      const child = task.children?.find(item => item.run_id === runId);
      if (child) return child;
    }
    return (state.runs || []).find(item => item.id === runId) || null;
  }
  function runBaselineTargets(run) {
    if (!run) return [];
    const runId = run.id || run.run_id || '';
    const summary = runId ? latestRunSummary(runId) : null;
    const source =
      summary && (Array.isArray(summary.baseline_targets) || summary.baseline_eligible !== undefined || summary.baseline_id !== undefined)
        ? summary
        : run;
    if (Array.isArray(source.baseline_targets)) {
      return source.baseline_targets.map(item => ({
        target_id: typeof item?.target_id === 'string' ? item.target_id : '',
        baseline_eligible: Boolean(item?.baseline_eligible),
        ineligibility_reason:
          typeof item?.ineligibility_reason === 'string' && item.ineligibility_reason ? item.ineligibility_reason : null,
        baseline_id: typeof item?.baseline_id === 'string' && item.baseline_id ? item.baseline_id : null
      }));
    }
    if (source.baseline_eligible !== undefined || source.baseline_id !== undefined || source.ineligibility_reason !== undefined) {
      const targetId = source.target?.id || fixedTargets(run)[0]?.id || '';
      return [
        {
          target_id: typeof targetId === 'string' ? targetId : '',
          baseline_eligible: Boolean(source.baseline_eligible),
          ineligibility_reason:
            typeof source.ineligibility_reason === 'string' && source.ineligibility_reason ? source.ineligibility_reason : null,
          baseline_id: typeof source.baseline_id === 'string' && source.baseline_id ? source.baseline_id : null
        }
      ];
    }
    return [];
  }
  const sampleProgress = record => {
    const counts = record.sample_status_counts || {};
    const done = record.samples
      ? record.samples.filter(sample => !['pending', 'running', 'queued'].includes(sample.status)).length
      : Object.entries(counts)
          .filter(([status]) => !['pending', 'running', 'queued'].includes(status))
          .reduce((sum, [, count]) => sum + count, 0);
    return { done, total: record.sample_count ?? record.plan?.sample_count ?? record.samples?.length ?? 0 };
  };
  const budgetLabel = (budget, status) => {
    const cap = Number.isFinite(budget?.max_cost_usd) ? ` / 上限 $${budget.max_cost_usd.toFixed(2)}` : '';
    if (Number.isFinite(budget?.estimated_uncached_cost_usd)) {
      if (status === 'queued' || (activeStatus(status) && budget.estimated_uncached_cost_usd === 0 && !(budget?.requests > 0)))
        return cap ? `上限 $${budget.max_cost_usd.toFixed(2)}` : '';
      return `估算 $${budget.estimated_uncached_cost_usd.toFixed(4)}${cap}`;
    }
    if (Number.isFinite(budget?.known_cost_lower_bound_usd) && budget.known_cost_lower_bound_usd > 0)
      return `估算 ≥ $${budget.known_cost_lower_bound_usd.toFixed(4)}${cap}`;
    return cap ? `上限 $${budget.max_cost_usd.toFixed(2)}` : '';
  };
  const isTimeoutSample = sample =>
    sample &&
    (sample.status === 'timeout' ||
      sample.grade?.outcome === 'timeout' ||
      (sample.status === 'api_failure' && sample.runner_error === 'SampleTimeout'));
  const endedAfterSubmissionReason = sample => {
    if (!sample || sample.status !== 'completed') return null;
    const raw = sample.answer_submission?.ended_after_submission;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  };
  const isPostSubmissionTimeoutSample = sample => endedAfterSubmissionReason(sample) === 'SampleTimeout';
  const isPostSubmissionNonModelSample = sample => {
    const reason = endedAfterSubmissionReason(sample);
    return Boolean(reason && reason !== 'SampleTimeout');
  };
  const isPreSubmissionNonModelSample = sample =>
    Boolean(sample && !['completed', 'pending', 'queued', 'running'].includes(sample.status) && !isTimeoutSample(sample));
  const isNoSubmissionSample = sample => sample?.status === 'completed' && sample?.grade?.outcome === 'no_submission';
  const hasSubmissionAnomaly = sample => Boolean(endedAfterSubmissionReason(sample) || isNoSubmissionSample(sample));
  const sentNoRequestAttempt = attempt =>
    Boolean(
      attempt &&
      ((Array.isArray(attempt.calls) && attempt.calls.length === 0) ||
        (!Array.isArray(attempt.calls) &&
          !attempt.started_at &&
          ['interrupted', 'cancelled', 'budget_not_admitted', 'pending'].includes(String(attempt.status))))
    );
  const formatEndedAfterReason = reason => {
    if (reason === 'SampleTimeout') return '超时：提交后整题超时（SampleTimeout）';
    if (reason === 'api_failure') return '非模型异常：提交后上游 API 失败（api_failure）';
    if (reason === 'incomplete') return '非模型异常：提交后响应被截断（incomplete）';
    if (reason === 'turn_limit') return '非模型异常：提交后触及交互轮次上限（turn_limit）';
    if (reason === 'tool_call_limit') return '非模型异常：提交后触及工具调用上限（tool_call_limit）';
    return `非模型异常：提交后异常中止（${reason}）`;
  };
  const recordAnomalyCounts = record => {
    const empty = {
      wholeTimeout: 0,
      endedAfterTimeout: 0,
      timeout: 0,
      modelAnomaly: 0,
      preNonModel: 0,
      endedAfterNonModel: 0,
      nonModelAnomaly: 0,
      total: 0
    };
    if (!record) return empty;
    if (Array.isArray(record.samples)) {
      const out = { ...empty };
      for (const sample of record.samples) {
        if (isTimeoutSample(sample)) out.wholeTimeout++;
        else if (isPreSubmissionNonModelSample(sample)) out.preNonModel++;
        else if (sample.status === 'completed') {
          if (isPostSubmissionTimeoutSample(sample)) out.endedAfterTimeout++;
          else if (isPostSubmissionNonModelSample(sample)) out.endedAfterNonModel++;
          if (isNoSubmissionSample(sample)) out.modelAnomaly++;
        }
      }
      out.timeout = out.wholeTimeout + out.endedAfterTimeout;
      out.nonModelAnomaly = out.preNonModel + out.endedAfterNonModel;
      out.total = out.timeout + out.modelAnomaly + out.nonModelAnomaly;
      return out;
    }
    if (Array.isArray(record.children) && record.children.length) {
      const out = { ...empty };
      for (const child of record.children) {
        if (inProgress(child)) continue;
        const c = recordAnomalyCounts(child);
        out.wholeTimeout += c.wholeTimeout;
        out.endedAfterTimeout += c.endedAfterTimeout;
        out.modelAnomaly += c.modelAnomaly;
        out.preNonModel += c.preNonModel;
        out.endedAfterNonModel += c.endedAfterNonModel;
      }
      out.timeout = out.wholeTimeout + out.endedAfterTimeout;
      out.nonModelAnomaly = out.preNonModel + out.endedAfterNonModel;
      out.total = out.timeout + out.modelAnomaly + out.nonModelAnomaly;
      return out;
    }
    const counts = record.sample_status_counts || {};
    const q = record.result_quality || {};
    const wholeTimeout = counts.timeout ?? 0;
    const endedAfterTimeout = q.ended_after_timeout_samples ?? 0;
    const endedAfterNonModel = q.ended_after_non_model_samples ?? Math.max(0, (q.ended_after_submission_samples || 0) - endedAfterTimeout);
    const modelAnomaly = q.model_anomaly_samples ?? q.no_submission_samples ?? 0;
    const preNonModel = Object.entries(counts)
      .filter(([status]) => !['completed', 'timeout', 'pending', 'queued', 'running'].includes(status))
      .reduce((sum, [, count]) => sum + (Number(count) || 0), 0);
    const timeout = wholeTimeout + endedAfterTimeout;
    const nonModelAnomaly = preNonModel + endedAfterNonModel;
    return {
      wholeTimeout,
      endedAfterTimeout,
      timeout,
      modelAnomaly,
      preNonModel,
      endedAfterNonModel,
      nonModelAnomaly,
      total: timeout + modelAnomaly + nonModelAnomaly
    };
  };
  const hasTimeoutSamples = record => {
    if (!record) return false;
    if (recordAnomalyCounts(record).timeout > 0) return true;
    return false;
  };
  const statusBadgeClass = record => {
    if (!record) return '';
    if (record.status === 'cancelling') return 'is-cancelling';
    if (record.status === 'running') return 'is-running';
    if (record.status === 'queued') return 'is-queued';
    if (record.status === 'failed') return 'is-failed';
    if (record.status === 'interrupted') return 'is-interrupted';
    if (record.status === 'cancelled') return 'is-cancelled';
    if (record.status === 'timeout' || record.status === 'incomplete') return 'is-timeout';
    if (record.status === 'completed') return hasTimeoutSamples(record) ? 'is-timeout' : 'is-completed';
    return '';
  };
  const statusTone = record => statusBadgeClass(record).replace(/^is-/, '') || 'queued';
  const shortId = id => (typeof id === 'string' && id.length > 14 ? id.slice(0, 8) : String(id || ''));
  const rawThinkingKey = target => (typeof target?.thinking === 'string' && target.thinking ? target.thinking : 'unknown');
  const shortThink = target => thinkingLabel(rawThinkingKey(target));
  const collectSortedThinkingKeys = entries => sortThinkingEfforts(new Set(entries.map(entry => rawThinkingKey(entry?.target ?? entry))));
  const shortAccount = target => (target?.account_evidence === 'gateway_binding' ? '自动分配' : target?.account_ref || '未记录');
  const isPinnedAccount = target => Boolean(target?.account_ref) && target?.account_evidence !== 'gateway_binding';
  const CHANNEL_LOCAL_ICON =
    '<svg class="channel-pod-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75h.01M5 11.25h.01"/></svg>';
  const CHANNEL_REMOTE_ICON =
    '<svg class="channel-pod-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.8 8h10.4M8 2.5a8 8 0 0 1 0 11M8 2.5a8 8 0 0 0 0 11"/></svg>';
  const THINKING_BADGE_ICON =
    '<svg class="task-thinking-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 12.5h3.6M6.8 14.2h2.4M8 2.2a4.1 4.1 0 0 0-2.4 7.4c.5.4.8 1 .8 1.6h3.2c0-.6.3-1.2.8-1.6A4.1 4.1 0 0 0 8 2.2Z"/></svg>';
  const TIMEOUT_CHIP_ICON =
    '<svg class="chip-state-svg" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="5.2"/><path d="M7 4.2V7l1.9 1.2"/></svg>';
  const retryCopy = (record, confirming) => {
    const counts = { api: 0, timeout: 0, model: 0, interrupted: 0, cancelled: 0 };
    const collect = item => {
      if (!item) return;
      if (Array.isArray(item.samples)) {
        for (const sample of item.samples) {
          if (isTimeoutSample(sample) || isPostSubmissionTimeoutSample(sample)) counts.timeout++;
          else if (isNoSubmissionSample(sample)) counts.model++;
          else if (isPostSubmissionNonModelSample(sample)) counts.api++;
          else if (sample.status === 'interrupted') counts.interrupted++;
          else if (sample.status === 'cancelled') counts.cancelled++;
          else if (isPreSubmissionNonModelSample(sample)) counts.api++;
        }
        return;
      }
      const c = item.sample_status_counts || {};
      const anomalies = recordAnomalyCounts(item);
      counts.api += (c.api_failure || 0) + (c.incomplete || 0) + anomalies.endedAfterNonModel;
      counts.timeout += anomalies.timeout;
      counts.model += anomalies.modelAnomaly;
      counts.interrupted += c.interrupted || 0;
      counts.cancelled += c.cancelled || 0;
    };
    if (Array.isArray(record?.children)) for (const child of record.children) collect(child);
    else collect(record);
    const activeKinds = Object.entries(counts).filter(([, count]) => count > 0);
    if (activeKinds.length === 1) {
      const [kind] = activeKinds[0];
      if (kind === 'interrupted') return confirming ? '确认重跑中断样本' : '继续重跑中断样本';
      if (kind === 'cancelled') return confirming ? '确认重跑已取消样本' : '重跑已取消样本';
      if (kind === 'timeout') return confirming ? '确认重试超时样本' : '重试超时样本';
      if (kind === 'model') return confirming ? '确认重试未提交样本' : '重试未提交样本';
    }
    if (activeKinds.length > 1) return confirming ? '确认重试异常样本' : '重试异常样本';
    return confirming ? '确认重试 API 失败' : '重试 API 失败';
  };
  const historicalOutcomeText = sample =>
    isTimeoutSample(sample)
      ? '超时（整题超时 · 按 0 分计）'
      : isPostSubmissionTimeoutSample(sample)
        ? '超时（提交后超时 · 按最后提交评分）'
        : isPostSubmissionNonModelSample(sample)
          ? '非模型异常（提交后中止 · 按最后提交评分）'
          : isNoSubmissionSample(sample)
            ? '模型异常（未提交答案 · 按 0 分计）'
            : sample.attempts?.length
              ? statusText(sample.status)
              : {
                  request_timeout: 'API 失败：请求超时',
                  rate_limited: 'API 失败：上游限流',
                  upstream_http_error: 'API 失败：上游服务错误',
                  transport_error: 'API 失败：传输异常',
                  output_token_limit: '未完成：输出 token 超限',
                  response_incomplete: '未完成：响应被截断',
                  tool_call_limit: '未完成：工具调用超限',
                  unsupported_tool_sequence: '未完成：工具调用序列不符合要求',
                  turn_limit: '未完成：交互轮次超限',
                  empty_final_answer: '未完成：未给出最终答案',
                  not_executed_after_api_failure: '未执行：此前 API 失败导致停止',
                  not_executed_execution_limit: '未执行：触及执行上限'
                }[sample.historical_outcome_classification?.reason] || statusText(sample.status);
  const STOP_REASON_TEXT = {
    rate_limited: '上游限流或额度不足（HTTP 429），重试后仍失败，已停止该模型后续样本',
    access_denied: '上游拒绝访问（HTTP 401/403），已停止该模型后续样本',
    payment_required: '上游额度或计费不足（HTTP 402），已停止该模型后续样本',
    model_not_found: '上游找不到该模型（HTTP 404），已停止该模型后续样本',
    cancelled: '已取消',
    service_restart: '服务重启导致中断',
    storage_error: '存储错误',
    child_failure: '部分运行失败',
    capability_or_limit: '能力或执行上限',
    request_limit: '触及请求次数上限',
    cost_reservation_limit: '触及费用预留上限',
    observed_cost_exceeded: '触及费用上限',
    missing_usage_cost: '上游未返回用量或费用',
    transport_failure: '传输异常'
  };
  const stopReasonText = reason => STOP_REASON_TEXT[reason] || reason;
  const isFastFailStop = reason => ['rate_limited', 'access_denied', 'payment_required', 'model_not_found'].includes(reason);
  /** Terminal 'failed' means some samples hit non-model API failures, not that the whole run failed. */
  const recordStatusLabel = record => {
    if (record.status === 'completed') {
      const { timeout, modelAnomaly, endedAfterNonModel } = recordAnomalyCounts(record);
      const tags = [];
      if (timeout > 0) tags.push(`${timeout} 超时`);
      if (modelAnomaly > 0) tags.push(`${modelAnomaly} 未提交`);
      if (endedAfterNonModel > 0) tags.push(`${endedAfterNonModel} 非模型异常`);
      return tags.length ? `已完成 · ${tags.join(' · ')}` : statusText(record.status);
    }
    if (record.status !== 'failed') return statusText(record.status);
    const counts = record.sample_status_counts;
    const failed = counts
      ? Object.entries(counts)
          .filter(([status]) => status !== 'completed' && status !== 'timeout')
          .reduce((sum, [, count]) => sum + count, 0)
      : 0;
    if (record.children?.length)
      return `部分失败 · ${record.children.filter(child => child.status === 'failed').length}/${record.children.length} 个运行`;
    return failed ? `${failed} 个样本失败` : '部分失败';
  };
  const targetModelName = target => target?.model_display_name || target?.model || target?.route_id || '模型未记录';
  const targetShortChannel = target => {
    const namespace = remoteRouteNamespace(target);
    if (namespace) return target?.provider_id ? `${target.provider_id} / ${namespace}` : namespace;
    return target?.provider_name || target?.provider_id || '渠道未记录';
  };
  const taskHeadline = record => {
    const children = Array.isArray(record.children) ? record.children : [];
    const entries = children.length ? children.map(child => child.target || {}) : fixedTargets(record);
    const models = [...new Set(entries.map(targetModelName).filter(Boolean))];
    const channels = [...new Set(entries.map(targetShortChannel).filter(Boolean))];
    const full = models.join('、');
    if (!models.length)
      return {
        text: `${record.plan?.run_count ?? children.length} 个独立运行 · ${record.plan?.rounds ?? '?'} 轮`,
        title: '',
        modelCount: 0
      };
    if (models.length === 1) {
      if (channels.length === 1) {
        const pinnedAccounts = [
          ...new Set(entries.filter(t => t?.account_ref && t?.account_evidence !== 'gateway_binding').map(t => t.account_ref))
        ];
        const hasGateway = entries.some(t => !t?.account_ref || t?.account_evidence === 'gateway_binding');
        const distinctCount = pinnedAccounts.length + (hasGateway ? 1 : 0);
        if (pinnedAccounts.length === 1 && !hasGateway) {
          const text = `${models[0]} · ${channels[0]} / ${pinnedAccounts[0]}`;
          return { text, title: text, modelCount: 1 };
        }
        if (distinctCount > 1) {
          const text = `${models[0]} · ${channels[0]}（${distinctCount} 个账号）`;
          return { text, title: text, modelCount: 1 };
        }
      }
      const channelHint = channels.length >= 1 && channels.length <= 2 ? ` · ${channels.join(' / ')}` : '';
      return { text: `${models[0]}${channelHint}`, title: `${models[0]}${channelHint}`, modelCount: 1 };
    }
    const shown = models.length <= 6 ? full : `${models.slice(0, 5).join('、')} 等 ${models.length} 个模型`;
    return { text: shown, title: full, modelCount: models.length };
  };
  const targetLabel = target => `${target.model || target.route_id || '模型未记录'} · ${target.thinking || 'Thinking 未记录'}`;
  const targetIdentity = target => {
    const namespace = remoteRouteNamespace(target);
    const localProvider =
      target.provider_name ||
      (target.provider_id === 'auto'
        ? 'auto（自动路由）'
        : target.provider_id === 'group'
          ? 'group（路由组）'
          : target.provider_id || '未记录');
    const path = namespace
      ? `远端路由 ${target.provider_id} / ${namespace}${namespace === 'auto' ? '（自动路由）' : namespace === 'group' ? '（路由组）' : ''}（仅路由路径）`
      : `渠道 ${localProvider}`;
    return `${path} / 账号 ${target.account_evidence === 'gateway_binding' ? '网关自动分配（实际账号未记录）' : target.account_ref || '未记录'} · 路由 ${target.route_id || '未记录'}`;
  };
  const taskSection = element('bench-task-section'),
    runSection = element('bench-run-section');
  const renderedMarkup = new WeakMap();
  function replaceHistoryMarkup(node, markup) {
    if (renderedMarkup.get(node) === markup) return;
    node.innerHTML = markup;
    renderedMarkup.set(node, markup);
  }
  function moveHistorySection(slot, section) {
    if (!slot || section.parentElement === slot) return;
    if (slot.moveBefore && slot.isConnected && section.isConnected) slot.moveBefore(section, null);
    else slot.append(section);
  }
  const validScore = sample =>
    sample.status === 'completed' &&
    Number.isFinite(sample.grade?.content_score) &&
    sample.grade.content_score >= 0 &&
    sample.grade.content_score <= 1;
  const knownCost = value => Number.isFinite(value) && value >= 0;
  const knownUsage = usage => knownCost(usage?.input_tokens) && knownCost(usage?.output_tokens);
  const seconds = value => (Number.isFinite(value) ? `${value < 10 ? value.toFixed(1) : Math.round(value)} 秒` : '');
  /** One-line diagnosis of a recorded call; derived only from journaled call metadata. */
  function describeCall(call) {
    if (!call) return '调用记录未找到';
    const after = call.elapsed_seconds !== null ? `${seconds(call.elapsed_seconds)}后` : '';
    const output = call.first_output_seconds !== null ? '已开始输出' : '未收到任何输出';
    if (call.local_exception === 'TimeoutError' || call.termination === 'timeout') return `${after}等待超时（${output}）`;
    if (call.local_exception === 'AbortError' || call.termination === 'aborted') return `${after}被取消`;
    if (call.terminal_event === 'response.failed' || call.response_status === 'failed')
      return `${after}上游返回 response.failed${call.error_code ? '：' + call.error_code : ''}${call.error_message ? '（' + call.error_message + '）' : ''}`;
    if (call.response_status === 'incomplete') return `${after}响应被截断（incomplete）`;
    if (call.http_status !== null && call.http_status !== 200 && call.http_status !== -1)
      return `${after}HTTP ${call.http_status}${call.http_status === 429 ? ' 限流' : call.http_status >= 500 ? ' 上游错误' : ''}${call.error_message ? '：' + call.error_message : ''}`;
    if (call.http_status === -1)
      return `${after}连接异常${call.local_exception || call.error_code ? '：' + (call.local_exception || call.error_code) : ''}`;
    if (!call.usage_known) return `${after}完成但未返回用量`;
    return `${after}请求完成`;
  }
  function attemptFailureText(attempt, calls, timeout) {
    if (Array.isArray(attempt.calls) && attempt.calls.length === 0) return '未发出请求（执行上限或此前失败导致停止）';
    if (attempt.runner_error === 'SampleTimeout') {
      const last = calls?.get(attempt.calls?.at(-1));
      return `整题超时${Number.isFinite(timeout) ? `（${timeout} 秒）` : ''}${last ? '；最后一次请求：' + describeCall(last) : ''}`;
    }
    if (!calls || !Array.isArray(attempt.calls)) return null;
    const failing = (attempt.calls || [])
      .map(id => calls.get(id))
      .filter(call => call && (call.http_status !== 200 || call.response_status !== 'completed' || call.local_exception));
    return failing.length ? failing.map(describeCall).join('；') : describeCall(calls.get(attempt.calls?.at(-1)));
  }
  function ensureCallSummaries(run) {
    const needs = (run.samples || []).some(
      sample =>
        (sample.status !== 'completed' && !['pending', 'queued', 'running'].includes(sample.status)) ||
        sample.attempts?.length ||
        Boolean(endedAfterSubmissionReason(sample))
    );
    if (!needs || !request) return null;
    const key = `${run.id}:${run.updated_at}`,
      entry = callSummaries.get(run.id);
    if (entry?.key === key) return entry.calls;
    if (entry?.loading === key) return entry.calls;
    callSummaries.set(run.id, { key: entry?.key, calls: entry?.calls ?? null, loading: key });
    request(`./api/bench/runs/${encodeURIComponent(run.id)}/calls`)
      .then(data => {
        callSummaries.set(run.id, { key, calls: new Map((data.calls || []).map(call => [call.call_id, call])), loading: null });
      })
      .catch(() => {
        callSummaries.set(run.id, { key, calls: null, loading: null });
      })
      .finally(() => {
        if (state.selectedRunId === run.id) renderDetails();
      });
    return entry?.calls ?? null;
  }
  function ensureSampleEvents(run, sampleId) {
    if (!run?.id || !sampleId || !request) return { events: null, loading: false, error: null };
    const cacheKey = `${run.id}\u0000${sampleId}`;
    const versionKey = `${run.id}:${run.updated_at ?? ''}`;
    const entry = sampleEvents.get(cacheKey);
    if (entry?.key === versionKey) return { events: entry.events, loading: false, error: entry.error };
    if (entry?.loading === versionKey) return { events: entry.events ?? null, loading: true, error: null };
    sampleEvents.set(cacheKey, { key: entry?.key ?? null, events: entry?.events ?? null, loading: versionKey, error: null });
    request(`./api/bench/runs/${encodeURIComponent(run.id)}/events?sample_id=${encodeURIComponent(sampleId)}`)
      .then(data => {
        const list = Array.isArray(data?.events) ? data.events : [];
        sampleEvents.set(cacheKey, { key: versionKey, events: list, loading: null, error: null });
      })
      .catch(err => {
        sampleEvents.set(cacheKey, {
          key: versionKey,
          events: entry?.events ?? null,
          loading: null,
          error: err instanceof Error ? err.message : String(err || '加载失败')
        });
      })
      .finally(() => {
        if (state.selectedRunId === run.id && getInspectorState(run.id).sampleId === sampleId) renderDetails();
      });
    return { events: entry?.events ?? null, loading: true, error: null };
  }
  function sampleDiagnosticBanner(sample, calls = null, timeout = undefined) {
    if (!sample) return null;
    if (isTimeoutSample(sample)) {
      const diag = attemptFailureText(sample, calls, timeout);
      return {
        tone: 'warn',
        title: '整题超时（按 0 分计）',
        body: `${diag || `超过单题总超时限制${timeout ? `（${timeout}s）` : ''}`}。该样本不影响任务完成，但不可设为基线，支持手动重试。`
      };
    }
    if (sample.status !== 'completed' && !['pending', 'queued', 'running'].includes(sample.status)) {
      const diag = attemptFailureText(sample, calls, timeout);
      return {
        tone: 'err',
        title: `${statusText(sample.status)}（非模型异常）`,
        body: `${diag || sample.runner_error || '上游调用失败或样本未正常结束'}。不计入有效分、不可设为基线，支持手动重试。`
      };
    }
    const endedAfter = endedAfterSubmissionReason(sample);
    if (endedAfter) {
      const subCount = Number.isInteger(sample.answer_submission?.submissions) ? sample.answer_submission.submissions : null;
      const diag = attemptFailureText(sample, calls, timeout);
      const isTimeoutEnded = endedAfter === 'SampleTimeout';
      return {
        tone: isTimeoutEnded ? 'warn' : 'err',
        title: isTimeoutEnded ? '提交答案后超时' : '提交答案后异常中止',
        body: `已通过 submit_answer 提交${subCount ? `（共 ${subCount} 次）` : ''}，但后续收尾轮次发生${formatEndedAfterReason(endedAfter)}${diag ? `（${diag}）` : ''}。已按最后一次有效提交评分；${isTimeoutEnded ? '不可设为基线，支持重试。' : '不视为完成、不可设为基线，支持重试。'}`
      };
    }
    if (isNoSubmissionSample(sample)) {
      return {
        tone: 'warn',
        title: '未调用 submit_answer（模型异常 · 0 分）',
        body: '模型自然结束但未通过 submit_answer 工具提交答案，按 0 分计。请直接查看下方执行轨迹，核对模型是否已在正文中得出结果。'
      };
    }
    if (sample.status === 'completed' && !validScore(sample)) {
      return {
        tone: 'warn',
        title: sampleScoringLabel(sample),
        body:
          sample.grade?.outcome === 'ambiguous'
            ? '严格解析未能确定唯一答案，系统不会自动选取其中一个对象。'
            : '回答未能解析为可评分的答案，不会补记为 0 分。'
      };
    }
    if (sample.status === 'completed' && (!knownUsage(sample.usage) || !knownCost(sample.estimated_uncached_cost_usd))) {
      const attempts = (Array.isArray(sample.attempts) ? sample.attempts : []).filter(attempt => !sentNoRequestAttempt(attempt));
      const priorUnknown = attempts.some(
        attempt =>
          !knownUsage(Object.hasOwn(attempt, 'latest_attempt_usage') ? attempt.latest_attempt_usage : attempt.usage) ||
          !knownCost(
            Object.hasOwn(attempt, 'latest_attempt_cost_usd') ? attempt.latest_attempt_cost_usd : attempt.estimated_uncached_cost_usd
          )
      );
      const missing = [!knownUsage(sample.usage) && '累计用量', !knownCost(sample.estimated_uncached_cost_usd) && '累计估算费用']
        .filter(Boolean)
        .join('、');
      return {
        tone: 'warn',
        title: `${missing}未知`,
        body: priorUnknown
          ? '历次尝试存在缺失记录，即使本次重试成功，累计值仍保留为未知；本次尝试的已知值不代表全部消耗。'
          : '缺失记录不会按 0 补齐；已完成仅表示执行结束。'
      };
    }
    return null;
  }
  function sampleScoringLabel(sample) {
    if (isTimeoutSample(sample)) return '0（超时）';
    if (validScore(sample) && sample.grade.outcome === 'no_submission') return '未调用 submit_answer 提交答案 · 0';
    if (validScore(sample)) return Number(sample.grade.content_score.toFixed(3));
    if (sample.status !== 'completed') return '无评分';
    return { ambiguous: '答案解析有歧义，无法评分', ungradable: '答案无法解析，无法评分' }[sample.grade?.outcome] || '评分记录缺失或无效';
  }
  function qualityLabel(record) {
    if (inProgress(record)) return '';
    const anomalies = recordAnomalyCounts(record);
    const qualities = record.result_quality
      ? [record.result_quality]
      : (record.children || [])
          .filter(child => !inProgress(child))
          .map(child => child.result_quality)
          .filter(Boolean);
    const total = field => qualities.reduce((sum, quality) => sum + (quality[field] || 0), 0);
    const unknownUsage = total('unknown_usage_samples'),
      unknownCost = total('unknown_cost_samples');
    return [
      anomalies.timeout > 0 && `超时 ${anomalies.timeout} 样本`,
      anomalies.modelAnomaly > 0 && `模型异常 ${anomalies.modelAnomaly}（未提交）`,
      anomalies.endedAfterNonModel > 0 && `非模型异常 ${anomalies.endedAfterNonModel}（提交后中止）`,
      total('unscored_samples') > 0 && `${total('unscored_samples')} 个已完成样本无法评分`,
      unknownUsage > 0 ? `${unknownUsage} 个累计用量未知` : unknownCost > 0 && `${unknownCost} 个累计费用未知`
    ]
      .filter(Boolean)
      .join(' · ');
  }
  // History shows only records proven to belong to the currently active bank version.
  const recordBankVersion = record => record?.bank_version ?? record?.plan?.bank_version ?? null;
  const activeBankVersion = () => app.bank?.version ?? null;
  const matchesBankVersion = (record, version) => Boolean(version) && recordBankVersion(record) === version;
  const matchesActiveBank = record => matchesBankVersion(record, activeBankVersion());
  let cachedEntriesTasksSnapshot = null;
  let cachedEntriesRunsSnapshot = null;
  let cachedEntriesBankVersion = undefined;
  let cachedEntriesList = [];
  const sameArrayItems = (prev, next) => prev !== null && prev.length === next.length && prev.every((item, index) => item === next[index]);
  function historyEntries() {
    const bankVersion = activeBankVersion();
    if (
      cachedEntriesBankVersion === bankVersion &&
      sameArrayItems(cachedEntriesTasksSnapshot, state.tasks) &&
      sameArrayItems(cachedEntriesRunsSnapshot, state.runs)
    )
      return cachedEntriesList;
    cachedEntriesTasksSnapshot = [...state.tasks];
    cachedEntriesRunsSnapshot = [...state.runs];
    cachedEntriesBankVersion = bankVersion;
    cachedEntriesList = [
      ...state.tasks.filter(matchesActiveBank).map(record => ({ kind: 'task', record })),
      ...state.runs.filter(record => !record.task_id && matchesActiveBank(record)).map(record => ({ kind: 'legacy', record }))
    ].sort((a, b) => Number(new Date(b.record.created_at || 0)) - Number(new Date(a.record.created_at || 0)));
    return cachedEntriesList;
  }
  const HISTORY_PAGE_SIZE = 40;
  let historyLimit = HISTORY_PAGE_SIZE;
  let lastHistoryFilterKey = '';
  const targetSearchCache = new WeakMap();
  const searchTokens = query => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesTokens = (text, tokens) => !tokens.length || tokens.every(token => text.includes(token));
  const targetSearchText = target => {
    if (!target || typeof target !== 'object') return '';
    const cached = targetSearchCache.get(target);
    if (cached !== undefined) return cached;
    const computed = [
      target.model,
      target.model_display_name,
      target.thinking,
      shortThink(target),
      target.route_id,
      target.account_ref,
      shortAccount(target),
      target.provider_id,
      target.provider_name,
      remoteRouteNamespace(target)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    targetSearchCache.set(target, computed);
    return computed;
  };
  const childMatchesTokens = (child, tokens) =>
    matchesTokens(
      [child?.run_id, child?.status, statusText(child?.status), targetSearchText(child?.target)].join(' ').toLowerCase(),
      tokens
    );
  const recordHeaderMatchesTokens = (record, tokens) =>
    matchesTokens([record?.id, record?.status, statusText(record?.status)].join(' ').toLowerCase(), tokens);
  function renderHistory() {
    const entries = historyEntries();
    let legacyCount = 0,
      activeCount = 0;
    for (const entry of entries) {
      if (entry.kind === 'legacy') legacyCount++;
      if (inProgress(entry.record)) activeCount++;
    }
    const scopedTasks = state.tasks.filter(matchesActiveBank);
    element('run-summary').textContent = `${scopedTasks.length} 个任务 · ${legacyCount} 条旧运行 · ${activeCount} 个进行中`;
    const rawSearch = element('history-search').value,
      status = element('history-status').value;
    const filterKey = `${status}\u0000${rawSearch}`;
    if (filterKey !== lastHistoryFilterKey) {
      lastHistoryFilterKey = filterKey;
      historyLimit = HISTORY_PAGE_SIZE;
    }
    const tokens = searchTokens(rawSearch);
    const shown = entries.filter(({ kind, record }) => {
      if (status === 'anomalous') {
        if (inProgress(record) || recordAnomalyCounts(record).total === 0) return false;
      } else if (status !== 'all' && record.status !== status) return false;
      if (!tokens.length) return true;
      if (recordHeaderMatchesTokens(record, tokens)) return true;
      if (kind === 'task' && Array.isArray(record.children) && record.children.length)
        return record.children.some(child => childMatchesTokens(child, tokens));
      return fixedTargets(record).some(target => matchesTokens(targetSearchText(target), tokens));
    });
    let visibleLimit = historyLimit;
    if (shown.length > visibleLimit && (state.selectedTaskId || state.selectedRunId)) {
      const selectedIdx = shown.findIndex(({ kind, record }) =>
        kind === 'task' ? record.id === state.selectedTaskId : !state.selectedTaskId && record.id === state.selectedRunId
      );
      if (selectedIdx >= visibleLimit) visibleLimit = selectedIdx + 1;
    }
    const visible = shown.length > visibleLimit ? shown.slice(0, visibleLimit) : shown;
    const paginationHtml =
      shown.length > visible.length
        ? `<div class="history-pagination"><button class="btn" type="button" data-history-show-more="40">显示更多（已显示 ${visible.length} / ${shown.length} 条）</button><button class="text-control" type="button" data-history-show-more="all">显示全部</button></div>`
        : '';
    replaceHistoryMarkup(
      element('bench-run-list'),
      visible.length
        ? visible
            .map(({ kind, record }) => {
              const children = record.children || [],
                targets = fixedTargets(record);
              const progress =
                kind === 'task'
                  ? {
                      done: children.reduce((sum, child) => sum + sampleProgress(child).done, 0),
                      total: record.plan?.sample_count ?? children.reduce((sum, child) => sum + sampleProgress(child).total, 0)
                    }
                  : sampleProgress(record);
              const selected =
                kind === 'task' ? state.selectedTaskId === record.id : !state.selectedTaskId && state.selectedRunId === record.id;
              const headline = kind === 'task' ? taskHeadline(record) : null;
              const title =
                kind === 'task'
                  ? headline.text
                  : `${record.execution_kind === 'calibration-import-v1' ? '校准导入' : '旧运行'} · ${targets.map(targetLabel).join('、') || record.id}`;
              const channelEntries =
                kind === 'task'
                  ? children.length
                    ? children
                    : targets.map(target => ({ target, status: record.status }))
                  : targets
                      .slice(0, 1)
                      .filter(target => Boolean(target?.provider_id || target?.provider_name || remoteRouteNamespace(target)))
                      .map(target => ({ target, status: record.status }));
              const channelGroups = groupByChannel(channelEntries);
              const thinkingBadge = kind === 'task' ? renderThinkingBadge(channelEntries) : '';
              const channelBadges = renderChannelBadges(channelGroups, kind === 'task', statusTone(record), thinkingBadge);
              const modelCount = headline?.modelCount || new Set(targets.map(targetModelName)).size;
              const channelCount = channelGroups.length;
              const taskMetaParts =
                kind === 'task'
                  ? [
                      `${record.plan?.run_count ?? children.length} 个独立运行`,
                      modelCount ? `${modelCount} 个模型` : '',
                      channelCount ? `${channelCount} 个渠道` : '',
                      `${record.plan?.rounds ?? '?'} 轮`,
                      formatDate(record.created_at)
                    ].filter(Boolean)
                  : [
                      formatDate(record.created_at),
                      `${progress.done}/${progress.total} 样本已结束`,
                      record.execution_kind === 'calibration-import-v1' ? '只读，不可重试' : '未归入新任务'
                    ].filter(Boolean);
              const quality = qualityLabel(record);
              if (quality) taskMetaParts.push(quality);
              if (kind !== 'task' && runBaselineTargets(record).some(item => Boolean(item.baseline_id))) {
                taskMetaParts.push('已设为基线');
              }
              const idTag = `<code class="task-id-tag" title="${escapeHtml(record.id)}">${escapeHtml(shortId(record.id))}</code>`;
              const counts = kind === 'task' ? renderTaskCountsBar(record, children, progress) : '';
              const recordTone = statusTone(record);
              return `<article class="history-entry${selected ? ' is-expanded' : ''}"><button class="run-list-item ${selected ? 'is-selected' : ''}" type="button" aria-expanded="${selected}" aria-controls="history-${kind === 'task' ? 'task' : 'run'}-${escapeHtml(record.id)}" data-history-focus="${escapeHtml(kind + ':' + record.id)}" ${kind === 'task' ? 'data-bench-task-id' : 'data-bench-run-id'}="${escapeHtml(record.id)}"><span class="run-list-main"><strong${headline?.title ? ` title="${escapeHtml(headline.title)}"` : ''}>${escapeHtml(title)}</strong>${channelBadges}<small>${taskMetaParts.map(escapeHtml).join(' · ')} · ${idTag}</small></span><span class="run-list-status ${statusBadgeClass(record)}"><i class="task-dot is-${recordTone}${recordTone === 'running' ? ' is-pulse' : ''}" aria-hidden="true"></i>${escapeHtml(recordStatusLabel(record))}</span></button>${counts ? `<div class="task-status-counts">${counts}</div>` : ''}<div id="history-${kind === 'task' ? 'task' : 'run'}-${escapeHtml(record.id)}" data-inline-${kind === 'task' ? 'task' : 'run'}="${escapeHtml(record.id)}"></div></article>`;
            })
            .join('') + paginationHtml
        : `<div class="empty">${entries.length ? '没有匹配的任务，请调整搜索或状态筛选。' : '暂无任务。选择目标并点击“开始评测”，即可创建第一个任务。'}</div>`
    );
  }
  function groupByChannel(entries) {
    const groups = [];
    const byChannel = new Map();
    for (const entry of entries) {
      const target = entry?.target || {};
      const name = targetShortChannel(target);
      if (!byChannel.has(name)) {
        const group = { name, children: [] };
        byChannel.set(name, group);
        groups.push(group);
      }
      byChannel.get(name).children.push(entry);
    }
    return groups;
  }
  function summarizeChildren(children) {
    const counts = {
      running: 0,
      cancelling: 0,
      completed: 0,
      queued: 0,
      timeout: 0,
      incomplete: 0,
      failed: 0,
      interrupted: 0,
      cancelled: 0
    };
    const segments = { completed: 0, running: 0, cancelling: 0, timeout: 0, failed: 0, interrupted: 0, cancelled: 0 };
    let sampleDone = 0;
    let sampleTotal = 0;
    let timeoutRuns = 0;
    let timeoutSamples = 0;
    let modelAnomalyRuns = 0;
    let modelAnomalySamples = 0;
    let anomalousCompletedRuns = 0;
    for (const child of children) {
      const tone = childPreviewTone(child);
      const progress = sampleProgress(child);
      const anomalies = recordAnomalyCounts(child);
      sampleDone += progress.done;
      sampleTotal += progress.total;
      if (child.status === 'running') counts.running++;
      else if (child.status === 'cancelling') counts.cancelling++;
      else if (child.status === 'queued') counts.queued++;
      else if (child.status === 'failed') counts.failed++;
      else if (child.status === 'interrupted') counts.interrupted++;
      else if (child.status === 'cancelled') counts.cancelled++;
      else if (child.status === 'incomplete') counts.incomplete++;
      else if (child.status === 'timeout') {
        counts.timeout++;
        timeoutRuns++;
        timeoutSamples += anomalies.timeout;
      } else if (child.status === 'completed') {
        counts.completed++;
        if (anomalies.timeout > 0) {
          timeoutRuns++;
          timeoutSamples += anomalies.timeout;
        }
        if (anomalies.modelAnomaly > 0) {
          modelAnomalyRuns++;
          modelAnomalySamples += anomalies.modelAnomaly;
        }
        if (anomalies.timeout > 0 || anomalies.modelAnomaly > 0 || anomalies.endedAfterNonModel > 0) anomalousCompletedRuns++;
      }
      if (Object.hasOwn(segments, tone) && progress.done > 0) segments[tone] += progress.done;
    }
    return {
      counts,
      segments,
      sampleDone,
      sampleTotal,
      timeoutRuns,
      timeoutSamples,
      modelAnomalyRuns,
      modelAnomalySamples,
      anomalousCompletedRuns
    };
  }
  function channelHealthTone(children, fallbackTone = 'queued', precomputedSum = null) {
    if (!children.length) return fallbackTone;
    const sum = precomputedSum ?? summarizeChildren(children);
    const { counts } = sum;
    if (counts.failed > 0) return 'failed';
    if (counts.timeout > 0 || sum.timeoutRuns > 0 || counts.incomplete > 0) return 'timeout';
    if (counts.interrupted > 0) return 'interrupted';
    if (counts.cancelling > 0) return 'cancelling';
    if (counts.running > 0) return 'running';
    if (counts.completed === children.length) return 'completed';
    if (counts.queued > 0) return 'queued';
    if (counts.cancelled > 0) return 'cancelled';
    return fallbackTone;
  }
  function describeChannelAccounts(children) {
    const distinct = [...new Set(children.map(child => shortAccount(child.target)))];
    const pinned = [...new Set(children.filter(child => isPinnedAccount(child.target)).map(child => child.target.account_ref))];
    const allPinned = children.length > 0 && children.every(child => isPinnedAccount(child.target));
    const singlePinned = allPinned && pinned.length === 1 ? pinned[0] : '';
    const podBadge = singlePinned
      ? `账号 ${singlePinned}`
      : distinct.length === 1
        ? distinct[0]
        : distinct.length > 1
          ? `${distinct.length} 个账号`
          : '';
    return { distinct, singlePinned, podBadge };
  }
  function renderProgressBar(segments, total, compact = false) {
    const order = ['completed', 'running', 'cancelling', 'timeout', 'failed', 'interrupted', 'cancelled'];
    let used = 0;
    const parts =
      total > 0
        ? order
            .map(tone => {
              const value = segments[tone] || 0;
              if (value <= 0) return '';
              const rawPct = Math.min(100 - used, (value / total) * 100);
              if (rawPct <= 0) return '';
              used += rawPct;
              return `<span class="task-progress-seg is-${tone}" style="width:${rawPct.toFixed(2)}%"></span>`;
            })
            .filter(Boolean)
            .join('')
        : '';
    return `<span class="task-progress-bar${compact ? ' is-compact' : ''}" aria-hidden="true">${parts}</span>`;
  }
  function renderThinkingBadge(entries) {
    if (!entries.length) return '';
    const keys = collectSortedThinkingKeys(entries);
    if (!keys.length) return '';
    const levelsHtml = keys
      .map(key => `<code class="task-thinking-code">${escapeHtml(thinkingLabel(key))}</code>`)
      .join('<span class="task-thinking-sep" aria-hidden="true">·</span>');
    return `<span class="task-thinking-badge">${THINKING_BADGE_ICON}<span class="task-thinking-prefix">思考</span><span class="task-thinking-levels">${levelsHtml}</span></span>`;
  }
  function renderChannelBadges(groups, showCount, fallbackTone, extraBadgeHtml = '') {
    if (!groups.length && !extraBadgeHtml) return '';
    const maxVisible = groups.length > 5 ? 4 : groups.length;
    const shown = groups.slice(0, maxVisible);
    const hidden = groups.slice(maxVisible);
    const badges = shown
      .map(group => {
        const tone = channelHealthTone(group.children, fallbackTone);
        const { singlePinned } = describeChannelAccounts(group.children);
        const isRemote = group.children.some(child => Boolean(remoteRouteNamespace(child.target)));
        return `<span class="task-channel-badge is-${tone}"><i class="task-dot is-${tone}" aria-hidden="true"></i><span class="task-channel-name">${escapeHtml(group.name)}</span>${singlePinned ? `<span class="task-channel-tag">${escapeHtml(singlePinned)}</span>` : ''}${isRemote ? '<span class="task-channel-tag">远端</span>' : ''}${showCount ? `<span class="task-channel-count">${group.children.length} 运行</span>` : ''}</span>`;
      })
      .join('');
    const overflow = hidden.length
      ? `<span class="task-channel-badge is-more" title="${escapeHtml(hidden.map(group => `${group.name} (${group.children.length})`).join('、'))}">+${hidden.length} 个渠道</span>`
      : '';
    return `<span class="task-card-channels">${badges}${overflow}${extraBadgeHtml}</span>`;
  }
  function renderTaskCountsBar(record, children, progress) {
    if (!children.length) return '';
    const sum = summarizeChildren(children);
    const { counts, timeoutRuns, timeoutSamples, modelAnomalyRuns, modelAnomalySamples, anomalousCompletedRuns } = sum;
    const pills = [`<span class="task-count-pill is-total">总计 ${children.length}</span>`];
    const pushPill = (tone, label) => {
      pills.push(
        `<span class="task-count-pill is-${tone}"><i class="task-dot is-${tone}" aria-hidden="true"></i>${escapeHtml(label)}</span>`
      );
    };
    if (counts.running) pushPill('running', `运行中 ${counts.running}`);
    if (counts.cancelling) pushPill('cancelling', `取消中 ${counts.cancelling}`);
    if (counts.completed) pushPill('completed', `已完成 ${counts.completed}`);
    if (counts.queued) pushPill('queued', `排队 ${counts.queued}`);
    if (counts.timeout) pushPill('timeout', `超时 ${counts.timeout}${timeoutSamples ? `（${timeoutSamples} 样本）` : ''}`);
    if (counts.incomplete) pushPill('timeout', `未完成 ${counts.incomplete}`);
    if (counts.failed) pushPill('failed', `API 失败 ${counts.failed}`);
    if (counts.interrupted) pushPill('interrupted', `已中断 ${counts.interrupted}`);
    if (counts.cancelled) pushPill('cancelled', `已取消 ${counts.cancelled}`);
    const baselineCount = children.filter(child => Boolean(childBaselineState(child).baselineId)).length;
    if (baselineCount > 0) {
      pills.push(
        `<span class="task-count-pill is-baseline"><i class="task-baseline-sq" aria-hidden="true"></i>基线 ${baselineCount}</span>`
      );
    }
    if (anomalousCompletedRuns > 0) {
      const detail = [];
      if (timeoutSamples > 0) detail.push(`${timeoutSamples} 超时`);
      if (modelAnomalySamples > 0) detail.push(`${modelAnomalySamples} 未提交`);
      const label =
        timeoutRuns > 0 && modelAnomalyRuns === 0
          ? `含超时 ${timeoutRuns}${timeoutSamples ? `（${timeoutSamples} 样本）` : ''}`
          : modelAnomalyRuns > 0 && timeoutRuns === 0
            ? `模型异常 ${modelAnomalyRuns}${modelAnomalySamples ? `（${modelAnomalySamples} 未提交）` : ''}`
            : `含异常 ${anomalousCompletedRuns}${detail.length ? `（${detail.join(' · ')}）` : ''}`;
      pushPill('timeout', label);
    }
    const total = progress?.total ?? record.plan?.sample_count ?? sum.sampleTotal;
    const done = progress?.done ?? sum.sampleDone;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const progressHtml =
      total > 0
        ? `<span class="task-count-progress">${renderProgressBar(sum.segments, total, false)}<span class="task-progress-readout"><strong>${done}</strong>/${total} (${pct}%)</span></span>`
        : '';
    return `<span class="task-count-pills">${pills.join('')}</span>${progressHtml}`;
  }
  function childPreviewTone(child) {
    if (!child) return 'queued';
    if (child.status === 'queued') return 'queued';
    if (child.status === 'cancelling') return 'cancelling';
    if (child.status === 'running') return 'running';
    if (child.status === 'failed') return 'failed';
    if (child.status === 'interrupted') return 'interrupted';
    if (child.status === 'cancelled') return 'cancelled';
    if (child.status === 'timeout' || child.status === 'incomplete') return 'timeout';
    if (child.status === 'completed') return hasTimeoutSamples(child) ? 'timeout' : 'completed';
    return 'queued';
  }

  function renderScopeBaselineButtons({ level, scopeId, scopeName, children, focusKeyPrefix, unitLabel }) {
    if (!children.length) return '';
    const { promotable, promoted, ineligible, ineligibleReason } = summarizeBaselineGroup(children);
    if (promotable.length === 0 && promoted.length === 0) return '';
    const promoteScope = `${level}-promote:${scopeId}`;
    const demoteScope = `${level}-demote:${scopeId}`;
    const promoteBusy = baselineBusy.has(promoteScope);
    const demoteBusy = baselineBusy.has(demoteScope);
    const multiRun = children.length > 1;
    const buttons = [];
    if (promotable.length > 0) {
      const promoteLabel = promoteBusy ? '保存中…' : multiRun ? `设为基线 (${promotable.length})` : '设为基线';
      const skipNote = ineligible.length > 0 ? `（跳过 ${ineligible.length} 个不可设为基线的运行：${ineligibleReason}）` : '';
      buttons.push(
        `<button type="button" class="channel-pod-action is-baseline" data-baseline-level="${escapeHtml(level)}" data-baseline-scope="${escapeHtml(promoteScope)}" data-baseline-promote-runs="${escapeHtml(promotable.map(child => child.run_id).join(','))}" data-history-focus="${escapeHtml(`${focusKeyPrefix}:promote`)}" aria-label="${escapeHtml(`${scopeName} ${promoteLabel}`)}" title="${escapeHtml(`将该${unitLabel}中 ${promotable.length} 个符合条件的已完成运行设为基线${skipNote}`)}" ${promoteBusy ? 'disabled' : ''}><i class="task-baseline-sq" aria-hidden="true"></i>${escapeHtml(promoteLabel)}</button>`
      );
    }
    if (promoted.length > 0) {
      const demoteLabel = demoteBusy ? '取消中…' : multiRun || promoted.length > 1 ? `取消基线 (${promoted.length})` : '取消基线';
      const skipNote =
        promotable.length === 0 && ineligible.length > 0 ? `；另 ${ineligible.length} 个不可设为基线：${ineligibleReason}` : '';
      buttons.push(
        `<button type="button" class="channel-pod-action is-unbaseline" data-baseline-level="${escapeHtml(level)}" data-baseline-scope="${escapeHtml(demoteScope)}" data-baseline-demote-ids="${escapeHtml(promoted.map(child => childBaselineState(child).baselineId).join(','))}" data-history-focus="${escapeHtml(`${focusKeyPrefix}:demote`)}" aria-label="${escapeHtml(`${scopeName} ${demoteLabel}`)}" title="${escapeHtml(`取消该${unitLabel}已保存的 ${promoted.length} 份基线标记（保留原始运行记录）${skipNote}`)}" ${demoteBusy ? 'disabled' : ''}>${escapeHtml(demoteLabel)}</button>`
      );
    }
    return buttons.join('');
  }
  const validNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const formatMoney = value => {
    if (!validNonnegative(value)) return '—';
    return (
      '$' +
      (value === 0
        ? '0'
        : value < 0.01
          ? Number(value.toPrecision(2)).toString()
          : value < 1
            ? Number(value.toFixed(3)).toString()
            : Number(value.toFixed(2)).toString())
    );
  };
  const formatTokens = value => {
    if (!validNonnegative(value)) return '—';
    if (value >= 1e6) return Number((value / 1e6).toFixed(2)).toString() + 'M';
    if (value >= 1e4) return Number((value / 1e3).toFixed(1)).toString() + 'k';
    return Math.round(value).toLocaleString('zh-CN');
  };
  const formatDuration = seconds => {
    if (!validNonnegative(seconds)) return '—';
    if (seconds < 60) return Number(seconds.toFixed(seconds < 10 ? 1 : 0)).toString() + 's';
    const total = Math.round(seconds);
    const mins = Math.floor(total / 60),
      secs = total % 60;
    if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
    const hrs = Math.floor(mins / 60),
      remMins = mins % 60;
    return remMins ? `${hrs}h ${remMins}m` : `${hrs}h`;
  };
  function resolveRunMetrics(record, fallbackRounds = null) {
    if (!record) return null;
    if (record.metrics && typeof record.metrics === 'object') {
      const m = record.metrics;
      return {
        ...m,
        rounds: Number.isInteger(m.rounds) && m.rounds > 0 ? m.rounds : (fallbackRounds ?? record.plan?.rounds ?? null)
      };
    }
    if (Array.isArray(record.samples)) {
      let scored_samples = 0,
        full_score_samples = 0,
        partial_score_samples = 0,
        zero_score_samples = 0,
        scoreSum = 0,
        elapsed_sample_count = 0,
        elapsed_seconds_known = 0,
        hasActiveSamples = false,
        inputKnown = 0,
        outputKnown = 0,
        costKnown = 0,
        unknownUsage = 0,
        unknownCost = 0;
      const roundSet = new Set();
      const addAttempt = (attempt, usage, cost) => {
        if (sentNoRequestAttempt(attempt)) return;
        if (knownUsage(usage)) {
          inputKnown += usage.input_tokens;
          outputKnown += usage.output_tokens;
        } else unknownUsage++;
        if (knownCost(cost)) costKnown += cost;
        else unknownCost++;
      };
      for (const sample of record.samples) {
        if (Number.isInteger(sample.round) && sample.round > 0) roundSet.add(sample.round);
        if (['pending', 'queued', 'running'].includes(String(sample.status ?? ''))) hasActiveSamples = true;
        if (isTimeoutSample(sample)) {
          scored_samples++;
          zero_score_samples++;
        } else if (sample.status === 'completed' && validScore(sample)) {
          const s = sample.grade.content_score;
          scored_samples++;
          scoreSum += s;
          if (s >= 1) full_score_samples++;
          else if (s > 0) partial_score_samples++;
          else zero_score_samples++;
        }
        if (validNonnegative(sample.elapsed_seconds)) {
          elapsed_sample_count++;
          elapsed_seconds_known += sample.elapsed_seconds;
        }
        const prior = Array.isArray(sample.attempts) ? sample.attempts.filter(item => item && typeof item === 'object') : [];
        if (knownUsage(sample.usage) && knownCost(sample.estimated_uncached_cost_usd)) {
          inputKnown += sample.usage.input_tokens;
          outputKnown += sample.usage.output_tokens;
          costKnown += sample.estimated_uncached_cost_usd;
        } else {
          const pick = (item, key) =>
            key === 'usage'
              ? Object.hasOwn(item, 'latest_attempt_usage')
                ? item.latest_attempt_usage
                : item.usage
              : Object.hasOwn(item, 'latest_attempt_cost_usd')
                ? item.latest_attempt_cost_usd
                : item.estimated_uncached_cost_usd;
          for (const attempt of prior) addAttempt(attempt, pick(attempt, 'usage'), pick(attempt, 'cost'));
          addAttempt(sample, pick(sample, 'usage'), pick(sample, 'cost'));
        }
      }
      const totalSamples = record.samples.length;
      const rounds =
        (Number.isInteger(record.plan?.rounds) && record.plan.rounds > 0 ? record.plan.rounds : null) ??
        fallbackRounds ??
        (roundSet.size > 0 ? roundSet.size : null);
      const usageComplete = totalSamples > 0 && !hasActiveSamples && unknownUsage === 0;
      const costComplete = totalSamples > 0 && !hasActiveSamples && unknownCost === 0;
      const totalTokensKnown = inputKnown + outputKnown;
      return {
        rounds,
        scored_samples,
        full_score_samples,
        partial_score_samples,
        zero_score_samples,
        mean_score: scored_samples > 0 ? (scoreSum / scored_samples) * 100 : null,
        score_complete: totalSamples > 0 && scored_samples === totalSamples,
        elapsed_sample_count,
        elapsed_seconds_known,
        elapsed_seconds_total: totalSamples > 0 && elapsed_sample_count === totalSamples ? elapsed_seconds_known : null,
        avg_sample_elapsed_seconds: elapsed_sample_count > 0 ? elapsed_seconds_known / elapsed_sample_count : null,
        input_tokens: usageComplete ? inputKnown : null,
        output_tokens: usageComplete ? outputKnown : null,
        total_tokens: usageComplete ? totalTokensKnown : null,
        known_input_tokens_lower_bound: !usageComplete && totalTokensKnown > 0 ? inputKnown : null,
        known_output_tokens_lower_bound: !usageComplete && totalTokensKnown > 0 ? outputKnown : null,
        known_total_tokens_lower_bound: !usageComplete && totalTokensKnown > 0 ? totalTokensKnown : null,
        estimated_cost_usd: costComplete ? costKnown : null,
        known_cost_lower_bound_usd: !costComplete && costKnown > 0 ? costKnown : null,
        unknown_usage_attempts: unknownUsage,
        unknown_cost_attempts: unknownCost
      };
    }
    const rounds = Number.isInteger(fallbackRounds) && fallbackRounds > 0 ? fallbackRounds : (record.plan?.rounds ?? null);
    const budget = record.budget || {};
    const estCost = validNonnegative(budget.estimated_uncached_cost_usd) ? budget.estimated_uncached_cost_usd : null;
    const lowerCost =
      estCost === null && validNonnegative(budget.known_cost_lower_bound_usd) && budget.known_cost_lower_bound_usd > 0
        ? budget.known_cost_lower_bound_usd
        : null;
    return {
      rounds,
      scored_samples: 0,
      full_score_samples: 0,
      partial_score_samples: 0,
      zero_score_samples: 0,
      mean_score: null,
      score_complete: false,
      elapsed_sample_count: 0,
      elapsed_seconds_known: 0,
      elapsed_seconds_total: null,
      avg_sample_elapsed_seconds: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      known_input_tokens_lower_bound: null,
      known_output_tokens_lower_bound: null,
      known_total_tokens_lower_bound: null,
      estimated_cost_usd: estCost,
      known_cost_lower_bound_usd: lowerCost,
      unknown_usage_attempts: 0,
      unknown_cost_attempts: 0
    };
  }
  const perRoundValue = (value, rounds) =>
    validNonnegative(value) ? (Number.isInteger(rounds) && rounds > 0 ? value / rounds : value) : null;
  function formatRunScore(metrics) {
    if (!metrics || !validNonnegative(metrics.mean_score)) return { text: '—', sub: '', title: '尚无已评分样本', complete: false };
    const text = `${metrics.mean_score.toFixed(1)}${metrics.score_complete ? '' : '*'}`;
    const sub = `${metrics.full_score_samples} 满 · ${metrics.partial_score_samples} 部 · ${metrics.zero_score_samples} 零`;
    const title = `均分 ${metrics.mean_score.toFixed(1)}（已评 ${metrics.scored_samples} 题：${metrics.full_score_samples} 满分 / ${metrics.partial_score_samples} 部分 / ${metrics.zero_score_samples} 零分${metrics.score_complete ? '' : '；含未计分样本'}）`;
    return { text, sub, title, complete: Boolean(metrics.score_complete) };
  }
  function formatRunElapsed(metrics) {
    if (!metrics || !validNonnegative(metrics.avg_sample_elapsed_seconds)) return { text: '—', sub: '', title: '耗时未记录' };
    const text = formatDuration(metrics.avg_sample_elapsed_seconds);
    const perRound =
      validNonnegative(metrics.elapsed_seconds_total) && Number.isInteger(metrics.rounds) && metrics.rounds > 0
        ? formatDuration(metrics.elapsed_seconds_total / metrics.rounds)
        : null;
    const sub = perRound ? `每轮 ${perRound}` : `${metrics.elapsed_sample_count} 题均值`;
    const title = `平均单题耗时 ${text}（${metrics.elapsed_sample_count} 题合计 ${formatDuration(metrics.elapsed_seconds_known)}${perRound ? ` · 每轮 ${perRound}` : ''}）`;
    return { text, sub, title };
  }
  function formatRunCost(metrics, record) {
    if (!metrics) return { text: '—', sub: '', title: '费用未定价或缺失', isLowerBound: false };
    const rounds = metrics.rounds;
    const isIdleZero =
      record &&
      (record.status === 'queued' || (activeStatus(record.status) && metrics.estimated_cost_usd === 0 && !(record.budget?.requests > 0)));
    if (validNonnegative(metrics.estimated_cost_usd) && !isIdleZero) {
      const perRound = perRoundValue(metrics.estimated_cost_usd, rounds);
      const text = formatMoney(perRound);
      const sub = rounds > 1 ? `${rounds} 轮总计 ${formatMoney(metrics.estimated_cost_usd)}` : '每轮估算';
      const title = `每轮估算费用 ${text}${rounds > 1 ? `（${rounds} 轮总计 ${formatMoney(metrics.estimated_cost_usd)}）` : ''}`;
      return { text, sub, title, isLowerBound: false };
    }
    if (validNonnegative(metrics.known_cost_lower_bound_usd)) {
      const perRound = perRoundValue(metrics.known_cost_lower_bound_usd, rounds);
      const text = `≥ ${formatMoney(perRound)}`;
      const sub =
        rounds > 1
          ? `总 ≥ ${formatMoney(metrics.known_cost_lower_bound_usd)}`
          : metrics.unknown_cost_attempts > 0
            ? `含 ${metrics.unknown_cost_attempts} 次未知`
            : '已知下限';
      const title = `每轮已知费用下限 ${text}${rounds > 1 ? `（${rounds} 轮已知总计 ≥ ${formatMoney(metrics.known_cost_lower_bound_usd)}）` : ''}${metrics.unknown_cost_attempts > 0 ? `；含 ${metrics.unknown_cost_attempts} 次未知费用尝试` : ''}`;
      return { text, sub, title, isLowerBound: true };
    }
    return { text: '—', sub: '未定价 / 缺失', title: '费用未定价或缺失', isLowerBound: false };
  }
  function formatRunTokens(metrics) {
    if (!metrics) return { text: '—', sub: '', title: 'Token 用量未记录', isLowerBound: false };
    const rounds = metrics.rounds;
    if (validNonnegative(metrics.total_tokens)) {
      const perRound = perRoundValue(metrics.total_tokens, rounds);
      const inPer = perRoundValue(metrics.input_tokens, rounds);
      const outPer = perRoundValue(metrics.output_tokens, rounds);
      const text = formatTokens(perRound);
      const sub = inPer !== null && outPer !== null ? `入 ${formatTokens(inPer)} / 出 ${formatTokens(outPer)}` : '';
      const title = `每轮 Tokens ${text}${sub ? `（${sub}）` : ''}${rounds > 1 ? ` · ${rounds} 轮总计 ${formatTokens(metrics.total_tokens)}` : ''}`;
      return { text, sub, title, isLowerBound: false };
    }
    if (validNonnegative(metrics.known_total_tokens_lower_bound)) {
      const perRound = perRoundValue(metrics.known_total_tokens_lower_bound, rounds);
      const text = `≥ ${formatTokens(perRound)}`;
      const sub = metrics.unknown_usage_attempts > 0 ? `含 ${metrics.unknown_usage_attempts} 次未知` : '已知下限';
      const title = `每轮已知 Tokens 下限 ${text}${rounds > 1 ? `（${rounds} 轮已知总计 ≥ ${formatTokens(metrics.known_total_tokens_lower_bound)}）` : ''}${metrics.unknown_usage_attempts > 0 ? `；含 ${metrics.unknown_usage_attempts} 次未返回用量` : ''}`;
      return { text, sub, title, isLowerBound: true };
    }
    return { text: '—', sub: '未记录', title: 'Token 用量未记录', isLowerBound: false };
  }
  function isAnomalousChild(child) {
    if (!child) return false;
    if (['failed', 'incomplete', 'timeout', 'interrupted', 'cancelled'].includes(child.status)) return true;
    const a = recordAnomalyCounts(child);
    return a.timeout > 0 || a.modelAnomaly > 0 || a.nonModelAnomaly > 0;
  }

  function resolvePillStatus(child, progress) {
    const a = recordAnomalyCounts(child);
    const frac = progress.total > 0 ? `${progress.done}/${progress.total}` : '';
    const partial = progress.total > 0 && progress.done > 0 && progress.done < progress.total;
    const timeoutBit = n => `<span class="task-pill-note is-timeout">${TIMEOUT_CHIP_ICON}${n} 超时</span>`;
    if (child.status === 'queued') return { html: '○ 排队中', tone: 'queued' };
    if (child.status === 'cancelling') return { html: partial ? `取消中 ${frac}` : '取消中', tone: 'cancelling' };
    if (child.status === 'running')
      return {
        html: `<i class="task-dot is-running is-pulse" aria-hidden="true"></i><span class="visually-hidden">运行中 </span>${frac}`,
        tone: 'running'
      };
    if (child.status === 'failed') {
      const doneCompleted = child.sample_status_counts?.completed || 0;
      const label = doneCompleted > 0 ? '× 部分失败' : '× 失败';
      return {
        html: `${label}${a.nonModelAnomaly > 0 ? ` <span class="task-pill-note">${a.nonModelAnomaly} 异常</span>` : ''}`,
        tone: 'failed'
      };
    }
    if (child.status === 'interrupted')
      return { html: `‖ 中断${partial ? ` ${frac}` : ''}${a.timeout > 0 ? ` · ${timeoutBit(a.timeout)}` : ''}`, tone: 'interrupted' };
    if (child.status === 'cancelled') return { html: partial ? `已取消 ${frac}` : '已取消', tone: 'cancelled' };
    if (child.status === 'incomplete') return { html: partial ? `未完成 ${frac}` : '未完成', tone: 'timeout' };
    if (child.status === 'completed') {
      const parts = [];
      if (a.timeout > 0) parts.push(timeoutBit(a.timeout));
      if (a.endedAfterNonModel > 0) parts.push(`<span class="task-pill-note is-timeout">${a.endedAfterNonModel} 异常</span>`);
      if (a.modelAnomaly > 0) parts.push(`<span class="task-pill-note is-model">${a.modelAnomaly} 未提交</span>`);
      if (!parts.length) return { html: '✓<span class="visually-hidden"> 已完成</span>', tone: 'completed' };
      const tone = a.timeout > 0 || a.endedAfterNonModel > 0 ? 'timeout' : 'model';
      return { html: `${parts.join(' · ')}<span class="visually-hidden"> 已完成</span>`, tone };
    }
    return { html: escapeHtml(statusText(child.status)), tone: childPreviewTone(child) };
  }
  function renderTaskOverview(task, children, plan, filterMode) {
    let elapsedKnownSum = 0,
      elapsedCountSum = 0,
      costTotal = 0,
      costKnownAny = false,
      costHasUnknown = false,
      tokensTotal = 0,
      tokensKnownAny = false,
      tokensHasUnknown = false,
      timeoutSamples = 0,
      modelSamples = 0,
      nonModelSamples = 0,
      anomalousRuns = 0;
    for (const child of children) {
      const m = resolveRunMetrics(child, plan.rounds);
      if (m && m.elapsed_sample_count > 0) {
        elapsedKnownSum += m.elapsed_seconds_known;
        elapsedCountSum += m.elapsed_sample_count;
      }
      if (m && validNonnegative(m.estimated_cost_usd)) {
        costTotal += m.estimated_cost_usd;
        if (m.estimated_cost_usd > 0 || child.status === 'completed') costKnownAny = true;
      } else if (m && validNonnegative(m.known_cost_lower_bound_usd)) {
        costTotal += m.known_cost_lower_bound_usd;
        costKnownAny = true;
        costHasUnknown = true;
      } else if (!inProgress(child) && child.status !== 'queued') {
        costHasUnknown = true;
      }
      if (m && validNonnegative(m.total_tokens)) {
        tokensTotal += m.total_tokens;
        if (m.total_tokens > 0 || child.status === 'completed') tokensKnownAny = true;
      } else if (m && validNonnegative(m.known_total_tokens_lower_bound)) {
        tokensTotal += m.known_total_tokens_lower_bound;
        tokensKnownAny = true;
        tokensHasUnknown = true;
      } else if (!inProgress(child) && child.status !== 'queued') {
        tokensHasUnknown = true;
      }
      const a = recordAnomalyCounts(child);
      timeoutSamples += a.timeout;
      modelSamples += a.modelAnomaly;
      nonModelSamples += a.nonModelAnomaly;
      if (isAnomalousChild(child)) anomalousRuns++;
    }
    const avgElapsed = elapsedCountSum > 0 ? formatDuration(elapsedKnownSum / elapsedCountSum) : '—';
    const elapsedTip = elapsedCountSum > 0 ? `${elapsedCountSum} 题样本均值` : '尚无耗时';
    const costBound = costHasUnknown && costKnownAny;
    const costValue = costKnownAny ? `${costBound ? '≥ ' : ''}${formatMoney(costTotal)}` : '—';
    const costTip = costKnownAny ? (costHasUnknown ? '含未知费用运行，显示已知下限' : `${children.length} 个运行合计`) : '未定价 / 缺失';
    const tokensBound = tokensHasUnknown && tokensKnownAny;
    const tokensValue = tokensKnownAny ? `${tokensBound ? '≥ ' : ''}${formatTokens(tokensTotal)}` : '—';
    const tokensTip = tokensKnownAny
      ? tokensHasUnknown
        ? '含未返回用量运行，显示已知下限'
        : `${children.length} 个运行合计`
      : '用量未记录';
    const meta = `<div class="task-inline-meta" aria-label="任务指标概览"><span class="task-inline-item" title="${escapeHtml(elapsedTip)}">单题均耗 <b>${escapeHtml(avgElapsed)}</b></span><span class="task-inline-sep" aria-hidden="true">·</span><span class="task-inline-item" title="${escapeHtml(`任务总费用：${costTip}`)}">总费用 <b${costBound ? ' class="is-bound"' : ''}>${escapeHtml(costValue)}</b></span><span class="task-inline-sep" aria-hidden="true">·</span><span class="task-inline-item" title="${escapeHtml(`任务总 Tokens：${tokensTip}`)}">总 Tokens <b${tokensBound ? ' class="is-bound"' : ''}>${escapeHtml(tokensValue)}</b></span></div>`;
    let filterHtml = '';
    if (anomalousRuns > 0) {
      const anomalyTip = [
        `异常运行 ${anomalousRuns}/${children.length}`,
        timeoutSamples > 0 ? `超时 ${timeoutSamples}` : '',
        modelSamples > 0 ? `模型异常 ${modelSamples}` : '',
        nonModelSamples > 0 ? `非模型异常 ${nonModelSamples}` : ''
      ]
        .filter(Boolean)
        .join(' · ');
      filterHtml = `<div class="task-seg-group" role="group" aria-label="按异常筛选运行" title="${escapeHtml(anomalyTip)}"><button type="button" class="task-filter-btn${filterMode === 'all' ? ' is-active' : ''}" data-task-run-filter="all" data-history-focus="task-filter:all" aria-pressed="${filterMode === 'all'}">全部 ${children.length}</button><button type="button" class="task-filter-btn is-anom${filterMode === 'anomaly' ? ' is-active' : ''}" data-task-run-filter="anomaly" data-history-focus="task-filter:anomaly" aria-pressed="${filterMode === 'anomaly'}">仅看异常 ${anomalousRuns}</button></div>`;
    }
    return `<div class="task-inline-bar">${meta}${filterHtml}</div>`;
  }
  function renderRunPill(child, label, { slotId, describedBy = '', isAccount = false, isAutoAcc = false, plan }) {
    const target = child.target || {};
    const progress = sampleProgress(child);
    const tone = childPreviewTone(child);
    const baseState = childBaselineState(child);
    const isBaseline = Boolean(baseState.baselineId);
    const selected = child.run_id === state.selectedRunId;
    const metrics = resolveRunMetrics(child, plan.rounds);
    const score = formatRunScore(metrics);
    const elapsed = formatRunElapsed(metrics);
    const cost = formatRunCost(metrics, child);
    const tokens = formatRunTokens(metrics);
    const pct = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
    const baselineDecor = isBaseline
      ? '<span class="task-run-baseline" title="已设为基线"><i class="task-baseline-sq" aria-hidden="true"></i><span class="visually-hidden">已设基线</span></span>'
      : '';
    const { html: statusHtml, tone: statusTone } = resolvePillStatus(child, progress);
    const hasChildAnomaly = child.status === 'completed' && statusTone !== 'completed';
    const canPromote = !inProgress(child) && baseState.eligible && !isBaseline && Boolean(target.id);
    const ineligibleReason =
      !isBaseline && !canPromote
        ? formatBaselineReason(inProgress(child) ? 'Assessment baseline: run must be completed' : baseState.reason, child)
        : '';
    const baselineTip = isBaseline ? '已设为基线' : canPromote ? '可设为基线' : ineligibleReason ? `不可设为基线：${ineligibleReason}` : '';
    const cardTooltip = [
      targetLabel(target),
      targetIdentity(target),
      statusText(child.status),
      `${progress.done}/${progress.total} 样本`,
      score.text !== '—' ? score.title : '',
      elapsed.text !== '—' ? elapsed.title : '',
      cost.text !== '—' ? cost.title : '',
      tokens.text !== '—' ? tokens.title : '',
      baselineTip,
      child.stop_reason && child.stop_reason !== 'api_failure' ? `停止原因：${stopReasonText(child.stop_reason)}` : '',
      child.retryable_samples > 0 && !inProgress(child) ? `${child.retryable_samples} 个可重试` : ''
    ]
      .filter(Boolean)
      .join(' · ');
    const progressTrack =
      tone === 'running' ? `<span class="task-run-pill-track" aria-hidden="true"><span style="width:${pct}%"></span></span>` : '';
    const cancelBtnHtml = inProgress(child)
      ? `<button class="btn task-run-pill-cancel" type="button" data-history-focus="cancel:${escapeHtml(child.run_id)}" data-cancel-child="${escapeHtml(child.run_id)}" ${!canCancel(child) || state.cancelling.has(`run:${child.run_id}`) ? 'disabled' : ''}>取消</button>`
      : '';
    const labelClass = isAccount ? `task-run-pill-label is-account task-run-account${isAutoAcc ? ' is-auto' : ''}` : 'task-run-pill-label';
    return `<div class="task-run-pill is-${tone}${child.status === 'cancelled' ? ' is-muted-pill' : ''}${hasChildAnomaly ? ' has-anomaly' : ''}${statusTone === 'model' ? ' is-model-anom' : ''}${isBaseline ? ' is-baseline' : ''}${selected ? ' is-selected' : ''}${cancelBtnHtml ? ' has-cancel' : ''}" data-child-run-id="${escapeHtml(child.run_id)}"><button type="button" class="task-run-pill-btn" data-preview-run-id="${escapeHtml(child.run_id)}" data-history-focus="preview-run:${escapeHtml(child.run_id)}" aria-expanded="${selected}" aria-controls="${escapeHtml(slotId)}"${describedBy ? ` aria-describedby="${escapeHtml(describedBy)}"` : ''} title="${escapeHtml(cardTooltip)}">${progressTrack}${baselineDecor}<span class="${labelClass}">${escapeHtml(label)}</span><span class="task-run-pill-status is-${statusTone}">${statusHtml}</span></button>${cancelBtnHtml}</div>`;
  }
  function renderTaskComparison(task, visibleChildren, plan) {
    if (!visibleChildren.length) return '<div class="empty">没有匹配的子运行。</div>';
    const channelPods = groupByChannel(visibleChildren);
    let slotSeq = 0;
    const podsHtml = channelPods
      .map((pod, podIndex) => {
        const podSum = summarizeChildren(pod.children);
        const podTone = channelHealthTone(pod.children, 'queued', podSum);
        const isRemote = pod.children.some(child => Boolean(remoteRouteNamespace(child.target)));
        const { distinct: podAccounts, podBadge } = describeChannelAccounts(pod.children);
        const podBaselineHtml = renderScopeBaselineButtons({
          level: 'channel',
          scopeId: `${task.id}:${podIndex}`,
          scopeName: pod.name,
          children: pod.children,
          focusKeyPrefix: `pod:${pod.name}`,
          unitLabel: '渠道'
        });
        const statusBits = [
          podSum.counts.running ? `运行中 ${podSum.counts.running}` : '',
          podSum.counts.cancelling ? `取消中 ${podSum.counts.cancelling}` : '',
          podSum.counts.completed ? `完成 ${podSum.counts.completed}` : '',
          podSum.timeoutRuns ? `含超时 ${podSum.timeoutRuns}` : '',
          podSum.modelAnomalyRuns ? `模型异常 ${podSum.modelAnomalyRuns}` : '',
          podSum.counts.incomplete ? `未完成 ${podSum.counts.incomplete}` : '',
          podSum.counts.failed ? `失败 ${podSum.counts.failed}` : '',
          podSum.counts.interrupted ? `中断 ${podSum.counts.interrupted}` : '',
          podSum.counts.queued ? `排队 ${podSum.counts.queued}` : '',
          podSum.counts.cancelled ? `取消 ${podSum.counts.cancelled}` : ''
        ]
          .filter(Boolean)
          .join(' · ');
        const modelGroups = [];
        const byModel = new Map();
        for (const child of pod.children) {
          const modelName = targetModelName(child.target);
          if (!byModel.has(modelName)) {
            const group = { modelName, children: [] };
            byModel.set(modelName, group);
            modelGroups.push(group);
          }
          byModel.get(modelName).children.push(child);
        }
        const groupsHtml = modelGroups
          .map((group, modelIndex) => {
            const currentSlot = slotSeq++;
            const slotId = `history-preview-run-${task.id}-${currentSlot}`;
            const accounts = [...new Set(group.children.map(child => shortAccount(child.target)))];
            const multiAccount = accounts.length > 1;
            const groupSum = summarizeChildren(group.children);
            const doneRuns = group.children.filter(child => child.status === 'completed').length;
            const contextParts = [
              !multiAccount && podAccounts.length > 1 && accounts[0] ? accounts[0] : '',
              `${doneRuns}/${group.children.length} 完成`,
              groupSum.counts.running ? `运行中 ${groupSum.counts.running}` : '',
              groupSum.counts.cancelling ? `取消中 ${groupSum.counts.cancelling}` : '',
              groupSum.timeoutRuns ? `含超时 ${groupSum.timeoutRuns}` : '',
              groupSum.counts.failed ? `失败 ${groupSum.counts.failed}` : '',
              groupSum.counts.interrupted ? `中断 ${groupSum.counts.interrupted}` : ''
            ].filter(Boolean);
            const modelBaselineHtml =
              modelGroups.length > 1
                ? renderScopeBaselineButtons({
                    level: 'model',
                    scopeId: `${task.id}:${podIndex}:${modelIndex}`,
                    scopeName: `${pod.name} ${group.modelName}`,
                    children: group.children,
                    focusKeyPrefix: `model:${pod.name}:${group.modelName}`,
                    unitLabel: '模型'
                  })
                : '';
            const sortedThinkingKeys = collectSortedThinkingKeys(group.children);
            let runsMarkup;
            if (multiAccount) {
              const byThinking = new Map();
              for (const child of group.children) {
                const key = rawThinkingKey(child.target);
                if (!byThinking.has(key)) byThinking.set(key, []);
                byThinking.get(key).push(child);
              }
              const lanesHtml = sortedThinkingKeys
                .map((thinkKey, laneIdx) => {
                  const laneChildren = byThinking.get(thinkKey) || [];
                  const laneDone = laneChildren.filter(child => child.status === 'completed').length;
                  const laneRailId = `history-preview-lane-${task.id}-${currentSlot}-${laneIdx}`;
                  const pills = laneChildren
                    .map(child => {
                      const isAutoAcc = child.target?.account_evidence === 'gateway_binding' || !child.target?.account_ref;
                      return renderRunPill(child, shortAccount(child.target), {
                        slotId,
                        describedBy: laneRailId,
                        isAccount: true,
                        isAutoAcc,
                        plan
                      });
                    })
                    .join('');
                  return `<div class="task-thinking-lane" data-thinking-lane="${escapeHtml(thinkKey)}"><div class="task-thinking-rail" id="${escapeHtml(laneRailId)}"><code class="task-thinking-rail-value">${escapeHtml(thinkingLabel(thinkKey))}</code><span class="task-thinking-rail-stat">${laneDone}/${laneChildren.length}</span></div><div class="task-ribbon-pills">${pills}</div></div>`;
                })
                .join('');
              runsMarkup = `<div class="task-thinking-lanes">${lanesHtml}</div>`;
            } else {
              const keyRank = new Map(sortedThinkingKeys.map((key, idx) => [key, idx]));
              const sortedChildren = [...group.children].sort(
                (a, b) => (keyRank.get(rawThinkingKey(a.target)) ?? 99) - (keyRank.get(rawThinkingKey(b.target)) ?? 99)
              );
              const pills = sortedChildren.map(child => renderRunPill(child, shortThink(child.target), { slotId, plan })).join('');
              runsMarkup = `<div class="task-ribbon-pills">${pills}</div>`;
            }
            const selectedInGroup = group.children.find(child => child.run_id === state.selectedRunId);
            const runIdsAttr = escapeHtml(group.children.map(child => child.run_id).join(','));
            const statsTitle = `${groupSum.sampleDone}/${groupSum.sampleTotal} 样本`;
            return `<div class="task-preview-group task-ribbon-group${multiAccount ? ' is-multi-account' : ''}"><div class="task-ribbon-row"><div class="task-ribbon-model"><strong class="task-ribbon-name" title="${escapeHtml(group.modelName)}">${escapeHtml(group.modelName)}</strong><div class="task-ribbon-sub"><span class="task-preview-stats" title="${escapeHtml(statsTitle)}">${escapeHtml(contextParts.join(' · '))}</span>${modelBaselineHtml ? `<span class="task-ribbon-actions">${modelBaselineHtml}</span>` : ''}</div></div><div class="task-ribbon-content">${runsMarkup}</div></div><div id="${escapeHtml(slotId)}" class="task-preview-slot" data-preview-model-slot="${currentSlot}" data-preview-run-ids="${runIdsAttr}"${selectedInGroup ? ` data-inline-run="${escapeHtml(selectedInGroup.run_id)}"` : ''}></div></div>`;
          })
          .join('');
        return `<section class="channel-pod is-${podTone}" aria-label="${escapeHtml(`渠道 ${pod.name}`)}"><header class="channel-pod-head"><div class="channel-pod-identity"><span class="channel-pod-icon">${isRemote ? CHANNEL_REMOTE_ICON : CHANNEL_LOCAL_ICON}</span><strong class="channel-pod-name">${escapeHtml(pod.name)}</strong>${podBadge ? `<span class="channel-pod-tag">${escapeHtml(podBadge)}</span>` : ''}${isRemote ? '<span class="channel-pod-tag is-remote">远端路由</span>' : ''}</div><div class="channel-pod-summary">${statusBits ? `<span class="channel-pod-status is-${podTone}"><i class="task-dot is-${podTone}" aria-hidden="true"></i>${escapeHtml(statusBits)}</span>` : ''}${podBaselineHtml}${podSum.sampleTotal > 0 ? `<span class="channel-pod-progress">${renderProgressBar(podSum.segments, podSum.sampleTotal, true)}<span class="channel-pod-count">${podSum.sampleDone}/${podSum.sampleTotal}</span></span>` : ''}</div></header><div class="channel-pod-body">${groupsHtml}</div></section>`;
      })
      .join('');
    return `<div class="task-preview" aria-label="任务按渠道与模型分组">${podsHtml}</div>`;
  }
  function renderTaskDetail() {
    const task =
      state.taskDetail?.id === state.selectedTaskId ? state.taskDetail : state.tasks.find(entry => entry.id === state.selectedTaskId);
    element('bench-task-section').hidden = !state.selectedTaskId;
    element('bench-cancel-task').hidden = !inProgress(task);
    element('bench-cancel-task').disabled = !canCancel(task) || state.cancelling.has(`task:${task?.id}`);
    const taskBaselineBtn = element('bench-baseline-task');
    const taskUnbaselineBtn = element('bench-unbaseline-task');
    if (!task) {
      taskSection.classList?.toggle('is-single-run-task', false);
      if (taskBaselineBtn) taskBaselineBtn.hidden = true;
      if (taskUnbaselineBtn) taskUnbaselineBtn.hidden = true;
      replaceHistoryMarkup(element('bench-task-detail'), '<div class="empty">正在读取任务详情…</div>');
      return;
    }
    const plan = task.plan || {},
      children = task.children || [];
    const {
      promotable: promotableChildren,
      promoted: promotedChildren,
      ineligible: ineligibleChildren,
      ineligibleReason: taskIneligibleReason
    } = summarizeBaselineGroup(children);
    const taskPromoteBusy = baselineBusy.has(`task-promote:${task.id}`);
    const taskDemoteBusy = baselineBusy.has(`task-demote:${task.id}`);
    if (promotableChildren.length > 0) {
      setBaselineHeaderButton(taskBaselineBtn, {
        hidden: false,
        busy: taskPromoteBusy,
        busyText: '正在保存基线…',
        label: children.length > 1 ? `设为基线 (${promotableChildren.length})` : '设为基线',
        title: `将该任务中 ${promotableChildren.length} 个符合条件的已完成运行保存为基线${ineligibleChildren.length > 0 ? `（跳过 ${ineligibleChildren.length} 个不可设为基线的运行：${taskIneligibleReason}）` : ''}`,
        ariaLabel: '',
        ineligibleReason: ''
      });
    } else if (promotedChildren.length === 0 && children.length > 0) {
      const reason = taskIneligibleReason || '不符合基线条件';
      setBaselineHeaderButton(taskBaselineBtn, {
        hidden: false,
        busy: false,
        busyText: '正在保存基线…',
        label: '设为基线',
        title: `不可设为基线：${reason}`,
        ariaLabel: `设为基线（不可用：${reason}）`,
        ineligibleReason: reason
      });
    } else {
      setBaselineHeaderButton(taskBaselineBtn, {
        hidden: true,
        busy: false,
        busyText: '正在保存基线…',
        label: '设为基线',
        title: '',
        ariaLabel: '',
        ineligibleReason: ''
      });
    }
    if (taskUnbaselineBtn) {
      taskUnbaselineBtn.hidden = promotedChildren.length === 0;
      taskUnbaselineBtn.disabled = taskDemoteBusy;
      taskUnbaselineBtn.textContent = taskDemoteBusy
        ? '正在取消基线…'
        : promotedChildren.length > 1
          ? `取消基线 (${promotedChildren.length})`
          : '取消基线';
      taskUnbaselineBtn.title = `取消该任务已保存的 ${promotedChildren.length} 份基线标记（保留原始运行记录）${promotableChildren.length === 0 && ineligibleChildren.length > 0 ? `；另 ${ineligibleChildren.length} 个不可设为基线：${taskIneligibleReason}` : ''}`;
    }
    const rawQuery = element('history-search').value.trim(),
      tokens = searchTokens(rawQuery);
    const filterChildren = tokens.length > 0 && !recordHeaderMatchesTokens(task, tokens);
    const searchMatchedChildren = filterChildren ? children.filter(child => childMatchesTokens(child, tokens)) : children;
    const taskConfirmLabel = retryCopy(task, true);
    element('bench-retry-task').hidden = inProgress(task) || !children.some(child => child.retryable_samples > 0);
    element('bench-retry-task').disabled = retrying.has(`tasks:${task.id}`);
    element('bench-retry-task').textContent = retrying.has(`tasks:${task.id}`)
      ? '正在提交重试…'
      : retryCopy(task, retryRequests.has(`tasks:${task.id}`));

    const isSingleRunTask = children.length === 1 && !filterChildren && state.selectedRunId === children[0].run_id;
    taskSection.classList?.toggle('is-single-run-task', isSingleRunTask);
    if (isSingleRunTask) {
      const sole = children[0];
      replaceHistoryMarkup(
        element('bench-task-detail'),
        `${retryRequests.has(`tasks:${task.id}`) && !retrying.has(`tasks:${task.id}`) ? `<p class="task-detail-note">待确认：仅重试异常、超时或失败样本，保留正常已完成结果；再次点击右上角“${escapeHtml(taskConfirmLabel)}”后开始。</p>` : ''}<div id="history-run-${escapeHtml(sole.run_id)}" class="task-single-run-slot" data-inline-run="${escapeHtml(sole.run_id)}"></div>`
      );
      return;
    }

    const hasAnyAnomaly = searchMatchedChildren.some(isAnomalousChild);
    const rawFilterMode = taskFilterByTask.get(task.id) === 'anomaly' ? 'anomaly' : 'all';
    const filterMode = hasAnyAnomaly ? rawFilterMode : 'all';
    const visibleChildren = filterMode === 'anomaly' ? searchMatchedChildren.filter(isAnomalousChild) : searchMatchedChildren;
    const techKey = escapeHtml(`${task.id}:tech-meta`);
    const timeoutSec = plan.limits?.timeout;
    const techMetaHtml = `<details class="raw-block task-tech-meta" data-history-disclosure="${techKey}"><summary data-history-focus="${techKey}">技术元信息 · 任务 ${escapeHtml(shortId(task.id))}${plan.rounds ? ` · ${escapeHtml(plan.rounds)} 轮` : ''}${plan.run_concurrency ? ` · 并发 ${escapeHtml(plan.run_concurrency)}×${escapeHtml(plan.sample_concurrency ?? '—')}` : ''}</summary><dl class="tech-meta-grid"><div><dt>任务 ID</dt><dd><code>${escapeHtml(task.id)}</code></dd></div><div><dt>题库版本</dt><dd>${escapeHtml(task.bank_version || plan.bank_version || '—')}</dd></div><div><dt>轮数 / 并发</dt><dd>${escapeHtml(plan.rounds ?? '—')} 轮 · ${escapeHtml(plan.run_concurrency ?? '未记录')} 运行 × ${escapeHtml(plan.sample_concurrency ?? '未记录')} 样本</dd></div><div><dt>单题超时</dt><dd>${Number.isFinite(timeoutSec) ? `${escapeHtml(timeoutSec)} 秒` : '默认'}</dd></div><div><dt>创建时间</dt><dd>${escapeHtml(formatDate(task.created_at))}</dd></div><div><dt>更新时间</dt><dd>${escapeHtml(formatDate(task.updated_at))}</dd></div></dl><p class="tech-meta-note">每个运行固定路由、模型和 Thinking，账号绑定以路由证据为准；独立保存样本与用量记录，取消单个运行不会影响其他运行。</p></details>`;
    replaceHistoryMarkup(
      element('bench-task-detail'),
      `${retryRequests.has(`tasks:${task.id}`) && !retrying.has(`tasks:${task.id}`) ? `<p class="task-detail-note">待确认：仅重试异常、超时或失败样本，保留正常已完成结果；再次点击右上角“${escapeHtml(taskConfirmLabel)}”后开始。</p>` : ''}${renderTaskOverview(task, searchMatchedChildren, plan, filterMode)}${filterChildren && searchMatchedChildren.length < children.length ? `<p class="task-detail-note">已按搜索“${escapeHtml(rawQuery)}”筛选：仅显示 ${searchMatchedChildren.length} / ${children.length} 个匹配子运行。</p>` : ''}${renderTaskComparison(task, visibleChildren, plan)}${techMetaHtml}`
    );
  }
  const lazyJsonPayloads = new Map();
  function hydrateLazyJson(node) {
    const key = node?.dataset?.lazyJson;
    if (!key || !node.open || !lazyJsonPayloads.has(key)) return;
    const text = JSON.stringify(lazyJsonPayloads.get(key), null, 2);
    const existing = node.querySelector?.('pre');
    if (existing) {
      if ((existing.dataset?.rawJson ?? existing.textContent) !== text) {
        if (existing.dataset) existing.dataset.rawJson = text;
        existing.textContent = text;
      }
      return;
    }
    const doc = node.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc?.createElement || !node.append) return;
    const pre = doc.createElement('pre');
    if (pre.dataset) pre.dataset.rawJson = text;
    pre.textContent = text;
    node.append(pre);
  }
  function syncOpenLazyJson(container) {
    for (const node of container.querySelectorAll?.('details[data-lazy-json][open]') || []) hydrateLazyJson(node);
  }
  function jsonBlock(title, value, scope = state.selectedRunId) {
    if (value === undefined || value === null || value === '') return '';
    const rawKey = `${scope}:${title}`;
    const key = escapeHtml(rawKey);
    lazyJsonPayloads.set(rawKey, value);
    return `<details class="raw-block" data-history-disclosure="${key}" data-lazy-json="${key}"><summary data-history-focus="${key}">${escapeHtml(title)}</summary></details>`;
  }
  let lastRunDetailInputs = null;
  function renderRunDetail() {
    const run = state.runDetail?.id === state.selectedRunId ? state.runDetail : null;
    const container = element('bench-run-detail');
    const headerTitle = state.selectedTaskId ? '运行详情' : '旧运行详情';
    element('bench-run-title').textContent = headerTitle;
    element('bench-cancel-run').hidden = !inProgress(run);
    element('bench-cancel-run').disabled = !canCancel(run) || state.cancelling.has(`run:${run?.id}`);
    const runBaselineBtn = element('bench-baseline-run');
    const runUnbaselineBtn = element('bench-unbaseline-run');
    if (!run) {
      if (runBaselineBtn) runBaselineBtn.hidden = true;
      if (runUnbaselineBtn) runUnbaselineBtn.hidden = true;
      lastRunDetailInputs = null;
      lazyJsonPayloads.clear();
      replaceHistoryMarkup(
        container,
        `<div class="empty">${state.selectedRunId ? '正在读取运行详情…' : '选择一个运行，查看逐题、逐轮样本与原始证据。'}</div>`
      );
      return;
    }
    const baseTargets = runBaselineTargets(run);
    const promotableTargets = inProgress(run)
      ? []
      : baseTargets.filter(item => item.baseline_eligible && !item.baseline_id && item.target_id);
    const promotedTargets = baseTargets.filter(item => Boolean(item.baseline_id));
    const ineligibleTargets = baseTargets
      .filter(item => !item.baseline_id && (inProgress(run) || !item.baseline_eligible || !item.target_id))
      .map(item => ({
        record: run,
        reason: inProgress(run) ? 'Assessment baseline: run must be completed' : item.ineligibility_reason
      }));
    const runIneligibleReason =
      promotableTargets.length === 0 && promotedTargets.length === 0
        ? summarizeIneligibleReasons(
            ineligibleTargets.length
              ? ineligibleTargets
              : [{ record: run, reason: inProgress(run) ? 'Assessment baseline: run must be completed' : run.ineligibility_reason }]
          )
        : '';
    const runPromoteBusy = baselineBusy.has(`run-promote:${run.id}`);
    const runDemoteBusy = baselineBusy.has(`run-demote:${run.id}`);
    const baselineSig = baseTargets
      .map(item => `${item.target_id}:${item.baseline_eligible ? 1 : 0}:${item.baseline_id || ''}:${item.ineligibility_reason || ''}`)
      .join('|');
    if (promotableTargets.length > 0) {
      const skipNote =
        ineligibleTargets.length > 0
          ? `（跳过 ${ineligibleTargets.length} 个不可设为基线的目标：${summarizeIneligibleReasons(ineligibleTargets)}）`
          : '';
      setBaselineHeaderButton(runBaselineBtn, {
        hidden: false,
        busy: runPromoteBusy,
        busyText: '正在保存基线…',
        label: promotableTargets.length > 1 ? `设为基线 (${promotableTargets.length})` : '设为基线',
        title:
          promotableTargets.length > 1
            ? `将该运行中 ${promotableTargets.length} 个符合条件的目标保存为基线${skipNote}`
            : `将该运行目标保存为基线${skipNote}`,
        ariaLabel: '',
        ineligibleReason: ''
      });
    } else if (promotedTargets.length === 0) {
      const reason = runIneligibleReason || '不符合基线条件';
      setBaselineHeaderButton(runBaselineBtn, {
        hidden: false,
        busy: false,
        busyText: '正在保存基线…',
        label: '设为基线',
        title: `不可设为基线：${reason}`,
        ariaLabel: `设为基线（不可用：${reason}）`,
        ineligibleReason: reason
      });
    } else {
      setBaselineHeaderButton(runBaselineBtn, {
        hidden: true,
        busy: false,
        busyText: '正在保存基线…',
        label: '设为基线',
        title: '',
        ariaLabel: '',
        ineligibleReason: ''
      });
    }
    if (runUnbaselineBtn) {
      runUnbaselineBtn.hidden = promotedTargets.length === 0;
      runUnbaselineBtn.disabled = runDemoteBusy;
      runUnbaselineBtn.textContent = runDemoteBusy
        ? '正在取消基线…'
        : promotedTargets.length > 1
          ? `取消基线 (${promotedTargets.length})`
          : '取消基线';
      runUnbaselineBtn.title = '取消该运行已保存的基线标记（保留原始运行记录）';
    }
    const calls = ensureCallSummaries(run);
    const inspector = getInspectorState(run.id);
    const activeSampleObj = inspector.sampleId ? (run.samples || []).find(s => s.sample_id === inspector.sampleId) || null : null;
    if (inspector.sampleId && !activeSampleObj) inspector.sampleId = null;
    const activeEventState = activeSampleObj ? ensureSampleEvents(run, activeSampleObj.sample_id) : null;
    const runDetailInputs = [
      run,
      run.samples,
      run.samples?.length ?? 0,
      run.status,
      run.updated_at,
      state.selectedRunId,
      state.selectedTaskId,
      state.banks,
      calls,
      Boolean(callSummaries.get(run.id)?.loading),
      inspector.sampleId,
      inspector.tab,
      inspector.showAllFields,
      inspector.showPrompt,
      inspector.attemptId,
      inspector.matrixFilter,
      activeEventState?.events ?? null,
      Boolean(activeEventState?.loading),
      activeEventState?.error ?? null,
      retryRequests.has(`runs:${run.id}`),
      retrying.has(`runs:${run.id}`),
      state.cancelling.has(`run:${run.id}`),
      baselineSig,
      runPromoteBusy,
      runDemoteBusy
    ];
    if (lastRunDetailInputs && runDetailInputs.every((value, index) => value === lastRunDetailInputs[index])) return;
    lastRunDetailInputs = runDetailInputs;
    lazyJsonPayloads.clear();
    const runConfirmLabel = retryCopy(run, true);
    element('bench-retry-run').hidden = inProgress(run) || !(run.retryable_samples > 0);
    element('bench-retry-run').disabled = retrying.has(`runs:${run.id}`);
    element('bench-retry-run').textContent = retrying.has(`runs:${run.id}`)
      ? '正在提交重试…'
      : retryCopy(run, retryRequests.has(`runs:${run.id}`));
    const samples = run.samples || [];
    const retryBatches = Array.isArray(run.retry_batches) ? run.retry_batches : [];
    const latestRetry = retryBatches.at(-1);
    const timeout = run.plan?.limits?.timeout;
    const failureText = sample => {
      if (sample.status === 'completed' || ['pending', 'queued', 'running'].includes(sample.status)) return null;
      if (sample.status === 'budget_not_admitted' && !sample.calls?.length && isFastFailStop(run.stop_reason))
        return `未发出请求：${stopReasonText(run.stop_reason)}`;
      return (
        attemptFailureText(sample, calls, timeout) ?? (calls === null && callSummaries.get(run.id)?.loading ? '正在读取调用记录…' : null)
      );
    };
    const retryNotePrefix =
      runConfirmLabel === '确认重试 API 失败'
        ? '待确认：仅重试 API 失败及非模型异常样本，保留正常结果'
        : '待确认：仅重试异常、超时或失败样本，保留正常已完成结果';
    const runTargets = fixedTargets(run);
    const runProgress = sampleProgress(run);
    const sampleTotal = samples.length || runProgress.total;
    const targetBanner = runTargets.length
      ? `<div class="run-target-banner"><div class="run-target-primary">${runTargets
          .map(
            target =>
              `<span class="run-target-item"><strong class="run-target-model">${escapeHtml(targetModelName(target))}</strong><span class="run-thinking-pill"><span class="run-thinking-pill-prefix">思考</span><code>${escapeHtml(shortThink(target))}</code></span><span class="run-account-pill">账号 ${escapeHtml(shortAccount(target))}</span></span>`
          )
          .join(
            ''
          )}</div><div class="run-target-badges">${promotedTargets.length > 0 ? '<span class="run-baseline-pill"><i class="task-baseline-sq" aria-hidden="true"></i>已设为基线</span>' : ''}${!run.task_id ? '<span class="channel-pod-tag">旧运行</span>' : ''}<span class="run-list-status ${statusBadgeClass(run)}"><i class="task-dot is-${statusTone(run)}${statusTone(run) === 'running' ? ' is-pulse' : ''}" aria-hidden="true"></i>${escapeHtml(recordStatusLabel(run))}${sampleTotal ? ` · ${runProgress.done}/${sampleTotal} 样本` : ''}</span></div></div>`
      : '';

    const runMetrics = resolveRunMetrics(run, run.plan?.rounds);
    const scoreMetric = formatRunScore(runMetrics);
    const elapsedMetric = formatRunElapsed(runMetrics);
    const costMetric = formatRunCost(runMetrics, run);
    const tokensMetric = formatRunTokens(runMetrics);
    const runKpiStrip = `<div class="run-kpi-strip" aria-label="运行核心指标">
      <div class="run-kpi-tile" title="${escapeHtml(scoreMetric.title)}"><span class="run-kpi-label">均分</span><strong class="run-kpi-value is-score">${escapeHtml(scoreMetric.text)}</strong>${scoreMetric.sub ? `<span class="run-kpi-sub">${escapeHtml(scoreMetric.sub)}</span>` : ''}</div>
      <div class="run-kpi-tile" title="${escapeHtml(elapsedMetric.title)}"><span class="run-kpi-label">平均单题耗时</span><strong class="run-kpi-value">${escapeHtml(elapsedMetric.text)}</strong>${elapsedMetric.sub ? `<span class="run-kpi-sub">${escapeHtml(elapsedMetric.sub)}</span>` : ''}</div>
      <div class="run-kpi-tile" title="${escapeHtml(costMetric.title)}"><span class="run-kpi-label">费用 / 轮</span><strong class="run-kpi-value${costMetric.isLowerBound ? ' is-bound' : ''}">${escapeHtml(costMetric.text)}</strong>${costMetric.sub ? `<span class="run-kpi-sub">${escapeHtml(costMetric.sub)}</span>` : ''}</div>
      <div class="run-kpi-tile" title="${escapeHtml(tokensMetric.title)}"><span class="run-kpi-label">Tokens / 轮</span><strong class="run-kpi-value${tokensMetric.isLowerBound ? ' is-bound' : ''}">${escapeHtml(tokensMetric.text)}</strong>${tokensMetric.sub ? `<span class="run-kpi-sub">${escapeHtml(tokensMetric.sub)}</span>` : ''}</div>
    </div>`;

    const sampleTone = sample =>
      isTimeoutSample(sample)
        ? 'timeout'
        : validScore(sample)
          ? sample.grade.content_score >= 1
            ? 'full'
            : sample.grade.content_score > 0
              ? 'partial'
              : 'zero'
          : sample.status === 'completed'
            ? 'unscored'
            : sample.status === 'running'
              ? 'running'
              : ['pending', 'queued'].includes(sample.status)
                ? 'pending'
                : sample.status === 'cancelled'
                  ? 'cancelled'
                  : sample.status === 'interrupted'
                    ? 'interrupted'
                    : 'failed';
    const cellText = sample =>
      isTimeoutSample(sample)
        ? '超时'
        : isNoSubmissionSample(sample)
          ? '未提交'
          : validScore(sample)
            ? String(Number(sample.grade.content_score.toFixed(2)))
            : sample.status === 'completed'
              ? sample.grade?.outcome === 'ambiguous'
                ? '歧义'
                : '无分'
              : ['pending', 'queued'].includes(sample.status)
                ? '…'
                : sample.status === 'running'
                  ? '运行'
                  : sample.status === 'cancelled'
                    ? '取消'
                    : sample.status === 'interrupted'
                      ? '中断'
                      : '失败';
    const isAnomalousCell = sample =>
      Boolean(
        sample &&
        ((sample.status !== 'completed' && !['pending', 'queued', 'running'].includes(sample.status)) ||
          (sample.status === 'completed' && (!validScore(sample) || hasSubmissionAnomaly(sample))))
      );
    const rawTaskKey = sample => sample.task || sample.sample_id || 'unknown';
    const sampleRoundKey = sample => (Number.isInteger(sample.round) && sample.round > 0 ? sample.round : 1);
    const uniqueForKey = keyFn => {
      const seen = new Set();
      for (const sample of samples) {
        const cellKey = `${keyFn(sample)}\u0000${sampleRoundKey(sample)}`;
        if (seen.has(cellKey)) return false;
        seen.add(cellKey);
      }
      return true;
    };
    const byTargetKey = sample => `${rawTaskKey(sample)} (${sample.target_id || sample.sample_id})`;
    const sampleTaskKey = uniqueForKey(rawTaskKey)
      ? rawTaskKey
      : uniqueForKey(byTargetKey)
        ? byTargetKey
        : sample => `${rawTaskKey(sample)} (${sample.sample_id})`;
    const taskIds = [...new Set(samples.map(sampleTaskKey))],
      rounds = [...new Set(samples.map(sampleRoundKey))].sort((a, b) => a - b);
    const byCell = new Map(samples.map(sample => [`${sampleTaskKey(sample)}\u0000${sampleRoundKey(sample)}`, sample]));
    const anomalyOrder = [];
    for (const task of taskIds) {
      for (const round of rounds) {
        const sample = byCell.get(`${task}\u0000${round}`);
        if (sample && isAnomalousCell(sample)) anomalyOrder.push(sample);
      }
    }
    const activeAnomalyIdx = activeSampleObj ? anomalyOrder.findIndex(s => s.sample_id === activeSampleObj.sample_id) : -1;
    // Step navigation reuses the exact target-aware order the matrix rendered.
    inspector.anomalyOrder = anomalyOrder.map(s => s.sample_id);

    const runAnomalies = recordAnomalyCounts(run);
    const diagTags = [];
    const diagNotes = [];
    if (runAnomalies.wholeTimeout > 0) {
      diagTags.push(`<span class="run-anom-tag is-timeout">超时 ${runAnomalies.wholeTimeout}</span>`);
      diagNotes.push(`${runAnomalies.wholeTimeout} 题整题超时（按 0 分计，不可设基线）`);
    }
    if (runAnomalies.endedAfterTimeout > 0) {
      diagTags.push(`<span class="run-anom-tag is-timeout">提交后超时 ${runAnomalies.endedAfterTimeout}</span>`);
      diagNotes.push(`${runAnomalies.endedAfterTimeout} 题提交后超时（按最后提交评分，不可设基线）`);
    }
    if (runAnomalies.endedAfterNonModel > 0) {
      diagTags.push(`<span class="run-anom-tag is-non-model">提交后中止 ${runAnomalies.endedAfterNonModel}</span>`);
      diagNotes.push(`${runAnomalies.endedAfterNonModel} 题提交后异常中止（不视为完成）`);
    }
    if (runAnomalies.preSubmissionNonModel > 0) {
      diagTags.push(`<span class="run-anom-tag is-non-model">非模型异常 ${runAnomalies.preSubmissionNonModel}</span>`);
      diagNotes.push(`${runAnomalies.preSubmissionNonModel} 题执行失败或中断`);
    }
    if (runAnomalies.modelAnomaly > 0) {
      diagTags.push(`<span class="run-anom-tag is-model">模型异常 ${runAnomalies.modelAnomaly}</span>`);
      diagNotes.push(`${runAnomalies.modelAnomaly} 题未提交答案（按 0 分计，可设基线）`);
    }
    if (run.stop_reason && run.stop_reason !== 'api_failure') diagNotes.push(`停止原因：${stopReasonText(run.stop_reason)}`);
    const hasDiag = diagTags.length > 0 || diagNotes.length > 0;
    const diagBarHtml = hasDiag
      ? `<div class="run-diag-bar${runAnomalies.nonModelAnomaly > 0 ? ' is-error' : runAnomalies.timeout > 0 || runAnomalies.modelAnomaly > 0 ? ' is-warn' : ' is-muted'}" role="note"><div class="run-diag-main">${diagTags.length ? `<span class="run-diag-tags">${diagTags.join('')}</span>` : ''}<span class="run-diag-text">${escapeHtml(diagNotes.join('；'))}</span></div>${anomalyOrder.length ? '<button type="button" class="run-diag-jump" data-matrix-step="next">定位异常样本 →</button>' : ''}</div>`
      : '';

    const inspectorHelpers = {
      validScore,
      isNoSubmissionSample,
      endedAfterSubmissionReason,
      shortCellLabel: sample => {
        const base = cellText(sample);
        const endedAfter = endedAfterSubmissionReason(sample);
        if (endedAfter && validScore(sample)) return `${base} ${endedAfter === 'SampleTimeout' ? '后超时' : '后中止'}`;
        return base;
      },
      sampleDiagnosticBanner
    };
    const matrixToolbar =
      samples.length && anomalyOrder.length
        ? `<div class="sample-matrix-toolbar"><div class="sample-matrix-filters"><button type="button" class="si-pill${inspector.matrixFilter === 'all' ? ' is-active' : ''}" data-matrix-filter="all">全部 ${samples.length}</button><button type="button" class="si-pill is-anom-filter${inspector.matrixFilter === 'anomaly' ? ' is-active' : ''}" data-matrix-filter="anomaly"><i class="si-anom-dot" aria-hidden="true"></i>仅高亮异常 ${anomalyOrder.length}</button></div><div class="sample-matrix-stepper"><span class="si-stepper-count">异常巡检 ${activeAnomalyIdx >= 0 ? activeAnomalyIdx + 1 : 0}/${anomalyOrder.length}</span><button type="button" class="si-step-btn" data-matrix-step="prev" aria-label="上一个异常样本">‹ 上一异常</button><button type="button" class="si-step-btn" data-matrix-step="next" aria-label="下一个异常样本">下一异常 ›</button></div></div>`
        : '';
    const matrix = samples.length
      ? `${matrixToolbar}<div class="sample-matrix" role="table" aria-label="逐题逐轮结果" style="--rounds:${rounds.length}"><div class="sample-matrix-row is-head" role="row"><span role="columnheader">题目</span>${rounds.map(round => `<span role="columnheader">第 ${escapeHtml(round)} 轮</span>`).join('')}<span role="columnheader" class="sample-matrix-avg-head">均分</span><span role="columnheader" class="sample-matrix-time-head">单题均耗</span></div>${taskIds
          .map(task => {
            const roundSamples = rounds.map(r => byCell.get(`${task}\u0000${r}`)).filter(Boolean);
            const scoredValues = roundSamples
              .filter(s => validScore(s) || isTimeoutSample(s))
              .map(s => (isTimeoutSample(s) ? 0 : s.grade.content_score));
            const avgText = scoredValues.length ? (scoredValues.reduce((acc, v) => acc + v, 0) / scoredValues.length).toFixed(2) : '—';
            const elapsedValues = roundSamples.map(s => s.elapsed_seconds).filter(validNonnegative);
            const avgTimeText = elapsedValues.length
              ? formatDuration(elapsedValues.reduce((acc, v) => acc + v, 0) / elapsedValues.length)
              : '—';
            const parsedTask = splitTaskId(task);
            const isActiveRow = Boolean(activeSampleObj && sampleTaskKey(activeSampleObj) === task);
            const rowHtml = `<div class="sample-matrix-row${isActiveRow ? ' is-expanded-row' : ''}" role="row"><span role="rowheader" title="${escapeHtml(task)}">${parsedTask.code ? `<span class="sample-task-code">${escapeHtml(parsedTask.code)}</span>` : ''}<span class="sample-task-name">${escapeHtml(parsedTask.name)}</span></span>${rounds
              .map(round => {
                const sample = byCell.get(`${task}\u0000${round}`);
                if (!sample) return '<span role="cell" class="sample-cell is-missing">—</span>';
                const endedAfter = endedAfterSubmissionReason(sample);
                const isAnom = isAnomalousCell(sample);
                const isSelected = inspector.sampleId === sample.sample_id;
                const isDimmed = inspector.matrixFilter === 'anomaly' && !isAnom && !isSelected;
                const anomalyClass = hasSubmissionAnomaly(sample) ? ' has-anomaly' : '';
                const extraClasses = `${isSelected ? ' is-selected' : ''}${isDimmed ? ' is-dimmed' : ''}${isAnom && inspector.matrixFilter === 'anomaly' ? ' is-highlighted' : ''}`;
                const why =
                  failureText(sample) ||
                  (endedAfter ? formatEndedAfterReason(endedAfter) : '') ||
                  (isNoSubmissionSample(sample) ? sampleScoringLabel(sample) : '') ||
                  (!validScore(sample) && sample.status === 'completed' ? sampleScoringLabel(sample) : '');
                const subTag =
                  endedAfter && validScore(sample)
                    ? `<span class="sample-cell-sub ${endedAfter === 'SampleTimeout' ? 'is-warn' : 'is-err'}">${endedAfter === 'SampleTimeout' ? '后超时' : '后中止'}</span>`
                    : '';
                return `<span role="cell"><button type="button" class="sample-cell is-${sampleTone(sample)}${anomalyClass}${extraClasses}" data-open-sample="${escapeHtml(sample.sample_id)}" aria-expanded="${isSelected ? 'true' : 'false'}" title="${escapeHtml(`${task} 第 ${round} 轮 · ${historicalOutcomeText(sample)}${why ? ' · ' + why : ''}`)}"><span>${escapeHtml(cellText(sample))}</span>${subTag}</button></span>`;
              })
              .join(
                ''
              )}<span role="cell" class="sample-matrix-avg">${escapeHtml(avgText)}</span><span role="cell" class="sample-matrix-time">${escapeHtml(avgTimeText)}</span></div>`;
            if (!isActiveRow || !activeSampleObj) return rowHtml;
            const taskSpec = resolveTaskSpec(rawTaskKey(activeSampleObj), run, state.banks || []);
            const inspectorHtml = renderInlineSampleInspector({
              run,
              sample: activeSampleObj,
              roundSamples,
              taskSpec,
              calls,
              eventState: activeEventState,
              uiState: inspector,
              esc: escapeHtml,
              helpers: inspectorHelpers,
              formatDate,
              registerLazyJson: (label, value) => jsonBlock(label, value, `${run.id}:si:${activeSampleObj.sample_id}`)
            });
            return `${rowHtml}${inspectorHtml}`;
          })
          .join('')}</div>`
      : '';
    const techKey = escapeHtml(`${run.id}:tech-meta`);
    const targetIdentityText = runTargets.map(target => `${targetLabel(target)} · ${targetIdentity(target)}`).join('；');
    const techMetaHtml = `<details class="raw-block run-tech-meta" data-history-disclosure="${techKey}"><summary data-history-focus="${techKey}">技术元信息 · 运行 ${escapeHtml(shortId(run.id))}${retryBatches.length ? ` · 重试 ${retryBatches.length} 次` : ''}</summary><dl class="tech-meta-grid"><div><dt>运行 ID</dt><dd><code>${escapeHtml(run.id)}</code></dd></div>${targetIdentityText ? `<div><dt>目标与路由</dt><dd>${escapeHtml(targetIdentityText)}</dd></div>` : ''}<div><dt>轮数 / 超时</dt><dd>${escapeHtml(run.plan?.rounds ?? runMetrics?.rounds ?? '—')} 轮 · ${Number.isFinite(timeout) ? `单题 ${escapeHtml(timeout)} 秒` : '默认超时'}</dd></div>${retryBatches.length ? `<div><dt>手动重试</dt><dd>${retryBatches.length} 次${latestRetry?.created_at ? `（最近 ${escapeHtml(formatDate(latestRetry.created_at))}）` : ''}</dd></div>` : ''}${run.stop_reason || run.budget?.stop_reason ? `<div><dt>停止原因</dt><dd>${escapeHtml(run.stop_reason || run.budget?.stop_reason)}</dd></div>` : ''}<div><dt>创建 / 更新</dt><dd>${escapeHtml(formatDate(run.created_at))} → ${escapeHtml(formatDate(run.updated_at))}</dd></div></dl>${jsonBlock('预算与用量原始记录 (JSON)', run.budget)}</details>`;
    const retryBannerHtml =
      retryRequests.has(`runs:${run.id}`) && !retrying.has(`runs:${run.id}`)
        ? `<p class="task-detail-note">${retryNotePrefix}；再次点击右上角“${escapeHtml(runConfirmLabel)}”后开始。</p>`
        : '';
    replaceHistoryMarkup(
      container,
      `${retryBannerHtml}${targetBanner}${runKpiStrip}${diagBarHtml}${matrix}${matrix ? '<p class="sample-matrix-tip">点击任意格子展开评分详情、完整对话轨迹与跨轮对比</p>' : ''}${techMetaHtml}`
    );
  }
  function placeRunSection() {
    if (!state.selectedRunId) {
      runSection.hidden = true;
      return;
    }
    const list = element('bench-run-list');
    const taskDetail = element('bench-task-detail');
    const previewSlot = [...(taskDetail.querySelectorAll?.('[data-preview-run-ids]') || [])].find(slot =>
      String(slot.dataset?.previewRunIds || '')
        .split(',')
        .includes(state.selectedRunId)
    );
    const runSlot =
      taskDetail.querySelector?.('[data-inline-run="' + state.selectedRunId + '"]') ||
      previewSlot ||
      list.querySelector?.('[data-inline-run="' + state.selectedRunId + '"]');
    if (!runSlot) {
      runSection.hidden = true;
      return;
    }
    moveHistorySection(runSlot, runSection);
    runSection.hidden = false;
  }
  function renderDetails() {
    const list = element('bench-run-list'),
      active = list.ownerDocument?.activeElement;
    const focused = list.contains?.(active) ? active : null;
    const focusKey = focused?.dataset?.historyFocus,
      focusId = focused?.id;
    const openTaskDisclosures = new Set(
      [...(taskSection.querySelectorAll?.('details[data-history-disclosure][open]') || [])]
        .filter(node => !runSection.contains?.(node))
        .map(node => node.dataset.historyDisclosure)
    );
    const openDisclosures = new Set(
      [...(runSection.querySelectorAll?.('details[data-history-disclosure][open]') || [])].map(node => node.dataset.historyDisclosure)
    );
    renderHistory();
    moveHistorySection(list.querySelector?.('[data-inline-task="' + state.selectedTaskId + '"]'), taskSection);
    renderTaskDetail();
    for (const node of taskSection.querySelectorAll?.('details[data-history-disclosure]') || [])
      if (!runSection.contains?.(node) && openTaskDisclosures.has(node.dataset.historyDisclosure)) node.open = true;
    renderRunDetail();
    placeRunSection();
    for (const node of runSection.querySelectorAll?.('details[data-history-disclosure]') || [])
      if (openDisclosures.has(node.dataset.historyDisclosure)) node.open = true;
    syncOpenLazyJson(runSection);
    if (focused && list.ownerDocument.activeElement !== focused) {
      const replacement = focusKey
        ? [...(list.querySelectorAll?.('[data-history-focus]') || [])].find(node => node.dataset.historyFocus === focusKey)
        : focusId
          ? element(focusId)
          : null;
      if (replacement?.isConnected && !replacement.closest?.('[hidden]')) replacement.focus({ preventScroll: true });
    }
  }

  element('bench-task-detail').addEventListener('click', event => {
    const filterBtn = event.target?.closest?.('[data-task-run-filter]');
    if (!filterBtn || !state.selectedTaskId) return;
    event.stopPropagation?.();
    taskFilterByTask.set(state.selectedTaskId, filterBtn.dataset.taskRunFilter === 'anomaly' ? 'anomaly' : 'all');
    renderDetails();
  });

  element('bench-run-detail').addEventListener(
    'toggle',
    event => {
      if (event.target?.dataset?.lazyJson && event.target.open) hydrateLazyJson(event.target);
    },
    true
  );

  element('bench-run-detail').addEventListener('click', event => {
    const run = state.runDetail;
    if (!run?.id) return;
    const inspector = getInspectorState(run.id);
    const cell = event.target.closest?.('[data-open-sample]');
    if (cell) {
      const sampleId = cell.dataset.openSample;
      if (inspector.sampleId === sampleId) {
        inspector.sampleId = null;
        inspector.tab = null;
        inspector.attemptId = null;
      } else {
        inspector.sampleId = sampleId;
        inspector.tab = null;
        inspector.showAllFields = false;
        inspector.showPrompt = false;
        inspector.attemptId = null;
      }
      renderDetails();
      const panel = element('bench-run-detail').querySelector?.('.sample-inline-inspector');
      panel?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.target.closest?.('[data-si-close]')) {
      inspector.sampleId = null;
      inspector.tab = null;
      inspector.attemptId = null;
      renderDetails();
      return;
    }
    const switchBtn = event.target.closest?.('[data-si-switch-sample]');
    if (switchBtn) {
      const nextId = switchBtn.dataset.siSwitchSample;
      inspector.sampleId = nextId;
      if (inspector.tab === 'compare') inspector.tab = null;
      inspector.showAllFields = false;
      inspector.attemptId = null;
      renderDetails();
      return;
    }
    const tabBtn = event.target.closest?.('[data-si-tab]');
    if (tabBtn) {
      inspector.tab = tabBtn.dataset.siTab;
      renderDetails();
      return;
    }
    const fieldsBtn = event.target.closest?.('[data-si-fields]');
    if (fieldsBtn) {
      inspector.showAllFields = fieldsBtn.dataset.siFields === 'all';
      renderDetails();
      return;
    }
    if (event.target.closest?.('[data-si-toggle-prompt]')) {
      inspector.showPrompt = !inspector.showPrompt;
      renderDetails();
      return;
    }
    const attemptBtn = event.target.closest?.('[data-si-attempt]');
    if (attemptBtn) {
      inspector.attemptId = attemptBtn.dataset.siAttempt;
      renderDetails();
      return;
    }
    const filterBtn = event.target.closest?.('[data-matrix-filter]');
    if (filterBtn) {
      inspector.matrixFilter = filterBtn.dataset.matrixFilter === 'anomaly' ? 'anomaly' : 'all';
      renderDetails();
      return;
    }
    const stepBtn = event.target.closest?.('[data-matrix-step]');
    if (stepBtn) {
      const anomalies = Array.isArray(inspector.anomalyOrder) ? inspector.anomalyOrder : [];
      if (!anomalies.length) return;
      const curIdx = anomalies.indexOf(inspector.sampleId);
      const dir = stepBtn.dataset.matrixStep === 'prev' ? -1 : 1;
      const nextIdx = curIdx < 0 ? (dir > 0 ? 0 : anomalies.length - 1) : (curIdx + dir + anomalies.length) % anomalies.length;
      inspector.sampleId = anomalies[nextIdx];
      inspector.tab = null;
      inspector.showAllFields = false;
      inspector.attemptId = null;
      renderDetails();
      const panel = element('bench-run-detail').querySelector?.('.sample-inline-inspector');
      panel?.scrollIntoView?.({ block: 'nearest' });
    }
  });
  element('bench-run-list').addEventListener('click', event => {
    const more = event.target?.closest?.('[data-history-show-more]');
    if (!more) return;
    event.stopPropagation();
    const step = more.dataset.historyShowMore;
    historyLimit = step === 'all' ? Number.MAX_SAFE_INTEGER : historyLimit + (Number(step) || HISTORY_PAGE_SIZE);
    renderDetails();
  });
  element('history-search').addEventListener('input', renderDetails);
  element('history-status').addEventListener('change', renderDetails);
  return {
    element,
    historyEntries,
    renderDetails,
    inProgress,
    canCancel,
    fixedTargets,
    runBaselineTargets,
    taskSection,
    runSection,
    recordBankVersion,
    matchesBankVersion
  };
}
