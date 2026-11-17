import { remoteRouteNamespace } from './data-adapter.js';

/** Render history and movable inline details; coordinator owns selection and polling. */
export function createTaskHistoryView({ app, state, retryRequests, retrying }) {
  const { byId: lookupElement, escapeHtml, activeStatus, statusText, formatDate, request } = app.services;
  const callSummaries = new Map(); // run id -> { key, calls | null, loading }
  const detailElements = new Map(['bench-close-task', 'bench-close-run', 'bench-task-section', 'bench-task-detail', 'bench-cancel-task', 'bench-copy-task', 'bench-retry-task', 'bench-run-section', 'bench-run-detail', 'bench-run-title', 'bench-cancel-run', 'bench-copy-run', 'bench-retry-run'].map(id => [id, lookupElement(id)]));
  const element = id => lookupElement(id) || detailElements.get(id);
  const inProgress = record => record && (activeStatus(record.status) || record.status === 'cancelling');
  const canCancel = record => inProgress(record) && record.status !== 'cancelling';
  const fixedTargets = record => record.plan?.targets || record.targets || [];
  const sampleProgress = record => {
    const counts = record.sample_status_counts || {};
    const done = record.samples ? record.samples.filter(sample => !['pending', 'running', 'queued'].includes(sample.status)).length : Object.entries(counts).filter(([status]) => !['pending', 'running', 'queued'].includes(status)).reduce((sum, [, count]) => sum + count, 0);
    return { done, total: record.sample_count ?? record.plan?.sample_count ?? record.samples?.length ?? 0 };
  };
  const budgetLabel = budget => `估算 ${Number.isFinite(budget?.estimated_uncached_cost_usd) ? '$' + budget.estimated_uncached_cost_usd.toFixed(4) : '未记录'} / 上限 ${Number.isFinite(budget?.max_cost_usd) ? '$' + budget.max_cost_usd.toFixed(2) : budget?.max_cost_usd === null ? '不设 USD 上限' : '未记录'}`;
  const historicalOutcomeText = sample => sample.attempts?.length ? statusText(sample.status) : ({ request_timeout: 'API 失败：请求超时', rate_limited: 'API 失败：上游限流', upstream_http_error: 'API 失败：上游服务错误', transport_error: 'API 失败：传输异常', output_token_limit: '未完成：输出 token 超限', response_incomplete: '未完成：响应被截断', tool_call_limit: '未完成：工具调用超限', unsupported_tool_sequence: '未完成：工具调用序列不符合要求', turn_limit: '未完成：交互轮次超限', empty_final_answer: '未完成：未给出最终答案', not_executed_after_api_failure: '未执行：此前 API 失败导致停止', not_executed_execution_limit: '未执行：触及执行上限' }[sample.historical_outcome_classification?.reason] || statusText(sample.status));
  /** Terminal 'failed' means some samples hit API/timeout failures, not that the whole run failed. */
  const recordStatusLabel = record => {
    if (record.status !== 'failed') return statusText(record.status);
    const counts = record.sample_status_counts;
    const failed = counts ? Object.entries(counts).filter(([status]) => status !== 'completed').reduce((sum, [, count]) => sum + count, 0) : 0;
    if (record.children?.length) return `部分失败 · ${record.children.filter(child => child.status === 'failed').length}/${record.children.length} 个运行`;
    return failed ? `${failed} 个样本失败` : '部分失败';
  };
  const targetLabel = target => `${target.model || target.route_id || '模型未记录'} · ${target.thinking || 'Thinking 未记录'}`;
  const targetIdentity = target => {
    const namespace = remoteRouteNamespace(target);
    const path = namespace ? `远端路由 ${target.provider_id} / ${namespace}${namespace === 'auto' ? '（自动路由）' : namespace === 'group' ? '（路由组）' : ''}（仅路由路径）` : `渠道 ${target.provider_name || target.provider_id || '未记录'}`;
    return `${path} / 账号 ${target.account_evidence === 'gateway_binding' ? '网关自动分配（实际账号未记录）' : target.account_ref || '未记录'} · 路由 ${target.route_id || '未记录'}`;
  };
  const taskSection = element('bench-task-section'), runSection = element('bench-run-section');
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
  const validScore = sample => sample.status === 'completed' && Number.isFinite(sample.grade?.content_score) && sample.grade.content_score >= 0 && sample.grade.content_score <= 1;
  const knownCost = value => Number.isFinite(value) && value >= 0;
  const knownUsage = usage => knownCost(usage?.input_tokens) && knownCost(usage?.output_tokens);
  const seconds = value => Number.isFinite(value) ? `${value < 10 ? value.toFixed(1) : Math.round(value)} 秒` : '';
  /** One-line diagnosis of a recorded call; derived only from journaled call metadata. */
  function describeCall(call) {
    if (!call) return '调用记录未找到';
    const after = call.elapsed_seconds !== null ? `${seconds(call.elapsed_seconds)}后` : '';
    const output = call.first_output_seconds !== null ? '已开始输出' : '未收到任何输出';
    if (call.local_exception === 'TimeoutError' || call.termination === 'timeout') return `${after}等待超时（${output}）`;
    if (call.local_exception === 'AbortError' || call.termination === 'aborted') return `${after}被取消`;
    if (call.terminal_event === 'response.failed' || call.response_status === 'failed') return `${after}上游返回 response.failed${call.error_code ? '：' + call.error_code : ''}${call.error_message ? '（' + call.error_message + '）' : ''}`;
    if (call.response_status === 'incomplete') return `${after}响应被截断（incomplete）`;
    if (call.http_status !== null && call.http_status !== 200 && call.http_status !== -1) return `${after}HTTP ${call.http_status}${call.http_status === 429 ? ' 限流' : call.http_status >= 500 ? ' 上游错误' : ''}${call.error_message ? '：' + call.error_message : ''}`;
    if (call.http_status === -1) return `${after}连接异常${call.local_exception || call.error_code ? '：' + (call.local_exception || call.error_code) : ''}`;
    if (!call.usage_known) return `${after}完成但未返回用量`;
    return `${after}请求完成`;
  }
  function attemptFailureText(attempt, calls, timeout) {
    if (Array.isArray(attempt.calls) && attempt.calls.length === 0) return '未发出请求（执行上限或此前失败导致停止）';
    if (attempt.runner_error === 'SampleTimeout') { const last = calls?.get(attempt.calls?.at(-1)); return `整题超时${Number.isFinite(timeout) ? `（${timeout} 秒）` : ''}${last ? '；最后一次请求：' + describeCall(last) : ''}`; }
    if (!calls || !Array.isArray(attempt.calls)) return null;
    const failing = (attempt.calls || []).map(id => calls.get(id)).filter(call => call && (call.http_status !== 200 || call.response_status !== 'completed' || call.local_exception));
    return failing.length ? failing.map(describeCall).join('；') : describeCall(calls.get(attempt.calls?.at(-1)));
  }
  function ensureCallSummaries(run) {
    const needs = (run.samples || []).some(sample => sample.status !== 'completed' && !['pending', 'queued', 'running'].includes(sample.status) || sample.attempts?.length);
    if (!needs || !request) return null;
    const key = `${run.id}:${run.updated_at}`, entry = callSummaries.get(run.id);
    if (entry?.key === key) return entry.calls;
    if (entry?.loading === key) return entry.calls;
    callSummaries.set(run.id, { key: entry?.key, calls: entry?.calls ?? null, loading: key });
    request(`./api/bench/runs/${encodeURIComponent(run.id)}/calls`).then(data => {
      callSummaries.set(run.id, { key, calls: new Map((data.calls || []).map(call => [call.call_id, call])), loading: null });
    }).catch(() => { callSummaries.set(run.id, { key, calls: null, loading: null }); }).finally(() => { if (state.selectedRunId === run.id) renderDetails(); });
    return entry?.calls ?? null;
  }
  function sampleScoringLabel(sample) {
    if (validScore(sample) && sample.grade.outcome === 'no_submission') return '未调用 submit_answer 提交答案 · 0';
    if (validScore(sample)) return Number(sample.grade.content_score.toFixed(3));
    if (sample.status !== 'completed') return '无评分';
    return ({ ambiguous: '答案解析有歧义，无法评分', ungradable: '答案无法解析，无法评分' })[sample.grade?.outcome] || '评分记录缺失或无效';
  }
  function sampleResultNotes(sample) {
    if (sample.status !== 'completed') return '';
    const notes = [];
    if (!validScore(sample)) notes.push(sample.grade?.outcome === 'ambiguous'
      ? '严格解析未能确定唯一答案，可能包含不同的 JSON 对象，或额外的损坏 JSON。无法评分不等于内容得 0 分；系统不会自动选取其中一个对象。'
      : sample.grade?.outcome === 'ungradable' ? '回答未能解析为可评分的答案。这不是等待评分，也不能据此断言内容全部错误。' : '评分记录缺失或得分不在 0–1 范围内；不会补记为 0 分。');
    if (!knownUsage(sample.usage) || !knownCost(sample.estimated_uncached_cost_usd)) {
      const attempts = Array.isArray(sample.attempts) ? sample.attempts : [];
      const priorUnknown = attempts.some(attempt => !knownUsage(Object.hasOwn(attempt, 'latest_attempt_usage') ? attempt.latest_attempt_usage : attempt.usage) || !knownCost(Object.hasOwn(attempt, 'latest_attempt_cost_usd') ? attempt.latest_attempt_cost_usd : attempt.estimated_uncached_cost_usd));
      const missing = [!knownUsage(sample.usage) && '累计用量', !knownCost(sample.estimated_uncached_cost_usd) && '累计估算费用'].filter(Boolean).join('、');
      notes.push(`${missing}未知。${priorUnknown ? '历次尝试存在缺失记录，即使本次重试成功，累计值仍保留为未知；本次尝试的已知值不代表全部消耗。' : '缺失记录不会按 0 补齐；已完成仅表示执行结束。'}`);
    }
    return notes.map(note => `<p class="task-detail-note">${escapeHtml(note)}</p>`).join('');
  }
  function qualityLabel(record) {
    const qualities = record.result_quality ? [record.result_quality] : (record.children || []).map(child => child.result_quality).filter(Boolean);
    const total = field => qualities.reduce((sum, quality) => sum + (quality[field] || 0), 0);
    return [total('unscored_samples') > 0 && `${total('unscored_samples')} 个已完成样本无法评分`, total('unknown_usage_samples') > 0 && `${total('unknown_usage_samples')} 个累计用量未知`, total('unknown_cost_samples') > 0 && `${total('unknown_cost_samples')} 个累计费用未知`].filter(Boolean).join(' · ');
  }
  function historyEntries() {
    return [...state.tasks.map(record => ({ kind: 'task', record })), ...state.runs.filter(record => !record.task_id).map(record => ({ kind: 'legacy', record }))]
      .sort((a, b) => Number(new Date(b.record.created_at || 0)) - Number(new Date(a.record.created_at || 0)));
  }
  function renderHistory() {
    const entries = historyEntries();
    element('run-summary').textContent = `${state.tasks.length} 个任务 · ${entries.filter(entry => entry.kind === 'legacy').length} 条旧运行 · ${entries.filter(entry => inProgress(entry.record)).length} 个进行中`;
    const query = element('history-search').value.trim().toLowerCase(), status = element('history-status').value;
    const shown = entries.filter(({ record }) => (status === 'all' || record.status === status) && [record.id, record.status, ...fixedTargets(record).flatMap(target => [target.model, target.thinking, target.route_id, target.account_ref]), ...(record.children || []).map(child => child.run_id)].join(' ').toLowerCase().includes(query));
    replaceHistoryMarkup(element('bench-run-list'), shown.length ? shown.map(({ kind, record }) => {
      const children = record.children || [], targets = fixedTargets(record);
      const progress = kind === 'task' ? { done: children.reduce((sum, child) => sum + sampleProgress(child).done, 0), total: record.plan?.sample_count ?? children.reduce((sum, child) => sum + sampleProgress(child).total, 0) } : sampleProgress(record);
      const selected = kind === 'task' ? state.selectedTaskId === record.id : !state.selectedTaskId && state.selectedRunId === record.id;
      const title = kind === 'task' ? `${record.plan?.run_count ?? children.length} 个独立运行 · ${new Set(targets.map(target => target.model)).size} 个模型 · ${record.plan?.rounds ?? '?'} 轮` : `${record.execution_kind === 'calibration-import-v1' ? '校准导入' : '旧运行'} · ${targets.map(targetLabel).join('、') || record.id}`;
      const counts = kind === 'task' ? runCounts(children) : '';
      return `<article class="history-entry"><button class="run-list-item ${selected ? 'is-selected' : ''}" type="button" aria-expanded="${selected}" aria-controls="history-${kind === 'task' ? 'task' : 'run'}-${escapeHtml(record.id)}" data-history-focus="${escapeHtml(kind + ':' + record.id)}" ${kind === 'task' ? 'data-bench-task-id' : 'data-bench-run-id'}="${escapeHtml(record.id)}"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(formatDate(record.created_at))} · ${progress.done}/${progress.total} 样本已结束 · ${escapeHtml(record.id)}${kind === 'legacy' ? (record.execution_kind === 'calibration-import-v1' ? ' · 只读，不可重试' : ' · 未归入新任务') : ''}${qualityLabel(record) ? ' · ' + escapeHtml(qualityLabel(record)) : ''}</small></span><span class="run-list-status ${record.status === 'failed' ? 'is-failed' : inProgress(record) ? 'is-running' : ''}">${escapeHtml(recordStatusLabel(record))}</span></button>${counts ? `<p class="task-status-counts">${counts}</p>` : ''}<div id="history-${kind === 'task' ? 'task' : 'run'}-${escapeHtml(record.id)}" data-inline-${kind === 'task' ? 'task' : 'run'}="${escapeHtml(record.id)}"></div></article>`;
    }).join('') : `<div class="empty">${entries.length ? '没有匹配的任务，请调整搜索或状态筛选。' : '暂无任务。选择目标并点击“开始评测”，即可创建第一个任务。'}</div>`);
  }
  function runCounts(children) {
    const count = status => children.filter(child => child.status === status).length;
    return '总计 ' + children.length + ' · 运行中 ' + (count('running') + count('cancelling')) + ' · 排队 ' + count('queued') + ' · 完成 ' + count('completed') + ' · 未完成 ' + count('incomplete') + ' · API 失败 ' + count('failed') + ' · 取消 ' + count('cancelled') + (count('interrupted') ? ' · 中断 ' + count('interrupted') : '');
  }
  function renderTaskDetail() {
    const task = state.taskDetail?.id === state.selectedTaskId ? state.taskDetail : state.tasks.find(entry => entry.id === state.selectedTaskId);
    element('bench-task-section').hidden = !state.selectedTaskId;
    element('bench-cancel-task').hidden = !inProgress(task);
    element('bench-cancel-task').disabled = !canCancel(task) || state.cancelling.has(`task:${task?.id}`);
    if (!task) { replaceHistoryMarkup(element('bench-task-detail'), '<div class="empty">正在读取任务详情…</div>'); return; }
    const plan = task.plan || {}, children = task.children || [];
    element('bench-retry-task').hidden = inProgress(task) || !children.some(child => child.retryable_samples > 0);
    element('bench-retry-task').disabled = retrying.has(`tasks:${task.id}`);
    element('bench-retry-task').textContent = retryRequests.has(`tasks:${task.id}`) ? '确认重试 API 失败' : '重试 API 失败';
    replaceHistoryMarkup(element('bench-task-detail'), `<div class="run-detail-meta"><span>任务 <strong>${escapeHtml(task.id)}</strong></span><span>状态 <strong>${escapeHtml(statusText(task.status))}</strong></span><span>独立运行 <strong>${children.length}</strong></span><span>样本总数 <strong>${escapeHtml(plan.sample_count ?? '未记录')}</strong></span><span>运行并发 <strong>${escapeHtml(plan.run_concurrency ?? '未记录')}</strong></span><span>每运行样本并发 <strong>${escapeHtml(plan.sample_concurrency ?? '未记录')}</strong></span></div><div class="task-child-list">${children.map(child => {
      const target = child.target || {}, progress = sampleProgress(child);
      return `<div class="task-child-row ${child.run_id === state.selectedRunId ? 'is-selected' : ''}" data-child-run-id="${escapeHtml(child.run_id)}"><button class="task-child-open" type="button" aria-expanded="${child.run_id === state.selectedRunId}" aria-controls="history-run-${escapeHtml(child.run_id)}" data-history-focus="run:${escapeHtml(child.run_id)}" data-bench-run-id="${escapeHtml(child.run_id)}"><strong>${escapeHtml(targetLabel(target))}</strong><span>${escapeHtml(targetIdentity(target))}</span><small>运行 ${escapeHtml(child.run_id)} · ${progress.done}/${progress.total} 样本已结束 · ${escapeHtml(budgetLabel(child.budget))}${qualityLabel(child) ? ` · ${escapeHtml(qualityLabel(child))}` : ''}${child.stop_reason && child.stop_reason !== 'api_failure' ? ` · 停止原因 ${escapeHtml(child.stop_reason)}` : ''}${child.retryable_samples > 0 && !inProgress(child) ? ` · ${child.retryable_samples} 个可重试` : ''}</small></button><span class="run-list-status ${inProgress(child) ? 'is-running' : child.status === 'failed' ? 'is-failed' : ''}">${escapeHtml(recordStatusLabel(child))}</span><button class="btn" type="button" data-history-focus="cancel:${escapeHtml(child.run_id)}" data-cancel-child="${escapeHtml(child.run_id)}" ${!canCancel(child) || state.cancelling.has(`run:${child.run_id}`) ? 'disabled' : ''}>取消运行</button></div><div id="history-run-${escapeHtml(child.run_id)}" data-inline-run="${escapeHtml(child.run_id)}"></div>`;
    }).join('')}</div><p class="task-detail-note">每个运行固定路由、模型和 Thinking，账号绑定以路由证据为准；独立保存样本与预算状态。取消某个运行不会取消其他运行。</p>`);
  }
  function jsonBlock(title, value, scope = state.selectedRunId) {
    if (value === undefined || value === null || value === '') return '';
    const key = escapeHtml(`${scope}:${title}`);
    return `<details class="raw-block" data-history-disclosure="${key}"><summary data-history-focus="${key}">${escapeHtml(title)}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
  }
  function renderRunDetail() {
    const run = state.runDetail?.id === state.selectedRunId ? state.runDetail : null;
    const container = element('bench-run-detail');
    element('bench-run-title').textContent = state.selectedTaskId ? '子运行样本' : '旧运行详情';
    element('bench-cancel-run').hidden = !inProgress(run);
    element('bench-cancel-run').disabled = !canCancel(run) || state.cancelling.has(`run:${run?.id}`);
    if (!run) { replaceHistoryMarkup(container, `<div class="empty">${state.selectedRunId ? '正在读取运行详情…' : '选择一个运行，查看逐题、逐轮样本与原始证据。'}</div>`); return; }
    element('bench-retry-run').hidden = inProgress(run) || !(run.retryable_samples > 0);
    element('bench-retry-run').disabled = retrying.has(`runs:${run.id}`);
    element('bench-retry-run').textContent = retryRequests.has(`runs:${run.id}`) ? '确认重试 API 失败' : '重试 API 失败';
    const samples = run.samples || [];
    const calls = ensureCallSummaries(run);
    const timeout = run.plan?.limits?.timeout;
    const failureText = sample => {
      if (sample.status === 'completed' || ['pending', 'queued', 'running'].includes(sample.status)) return null;
      return attemptFailureText(sample, calls, timeout) ?? (calls === null && callSummaries.get(run.id)?.loading ? '正在读取调用记录…' : null);
    };
    const summary = `<div class="run-detail-meta"><span>运行 <strong>${escapeHtml(run.id)}</strong></span><span>状态 <strong>${escapeHtml(recordStatusLabel(run))}</strong></span><span>样本 <strong>${samples.length}</strong></span><span>已结束 <strong>${sampleProgress(run).done}</strong></span>${run.budget?.stop_reason ? `<span>停止原因 <strong>${escapeHtml(run.budget.stop_reason)}</strong></span>` : ''}</div><p class="task-detail-note">${escapeHtml(fixedTargets(run).map(target => `${targetLabel(target)} · ${targetIdentity(target)}`).join('；'))}${!run.task_id ? ' · 旧运行记录，未迁移为新任务。' : ''}</p>`;
    const sampleTone = sample => validScore(sample) ? (sample.grade.content_score >= 1 ? 'full' : sample.grade.content_score > 0 ? 'partial' : 'zero') : sample.status === 'completed' ? 'unscored' : ['pending', 'queued', 'running'].includes(sample.status) ? 'pending' : 'failed';
    const cellText = sample => validScore(sample) ? String(Number(sample.grade.content_score.toFixed(2))) : sample.status === 'completed' ? (sample.grade?.outcome === 'ambiguous' ? '歧义' : '无分') : ['pending', 'queued'].includes(sample.status) ? '…' : sample.status === 'running' ? '运行' : sample.status === 'cancelled' ? '取消' : '失败';
    const taskIds = [...new Set(samples.map(sample => sample.task))], rounds = [...new Set(samples.map(sample => sample.round))].sort((a, b) => a - b);
    const byCell = new Map(samples.map(sample => [`${sample.task}\u0000${sample.round}`, sample]));
    const matrix = samples.length ? `<div class="sample-matrix" role="table" aria-label="逐题逐轮结果" style="--rounds:${rounds.length}"><div class="sample-matrix-row is-head" role="row"><span role="columnheader">题目</span>${rounds.map(round => `<span role="columnheader">第 ${escapeHtml(round)} 轮</span>`).join('')}</div>${taskIds.map(task => `<div class="sample-matrix-row" role="row"><span role="rowheader" title="${escapeHtml(task)}">${escapeHtml(task)}</span>${rounds.map(round => {
      const sample = byCell.get(`${task}\u0000${round}`);
      if (!sample) return '<span role="cell" class="sample-cell is-missing">—</span>';
      const why = failureText(sample) || (!validScore(sample) && sample.status === 'completed' ? sampleScoringLabel(sample) : '');
      return `<span role="cell"><button type="button" class="sample-cell is-${sampleTone(sample)}" data-open-sample="${escapeHtml(sample.sample_id)}" title="${escapeHtml(`${task} 第 ${round} 轮 · ${historicalOutcomeText(sample)}${why ? ' · ' + why : ''}`)}">${escapeHtml(cellText(sample))}</button></span>`;
    }).join('')}</div>`).join('')}</div>` : '';
    const sampleRow = sample => {
      const score = sampleScoringLabel(sample), scope = `${run.id}:${sample.sample_id}`;
      const evidence = (title, value) => jsonBlock(title, value, scope);
      const why = failureText(sample);
      const attempts = Array.isArray(sample.attempts) ? sample.attempts : [];
      const attemptLines = attempts.length ? `<ol class="attempt-list">${attempts.map((attempt, index) => `<li>第 ${index + 1} 次尝试 · ${escapeHtml(statusText(attempt.status))}${attempt.status === 'completed' ? '' : ' · ' + escapeHtml(attemptFailureText(attempt, calls, timeout) ?? '原因读取中')}</li>`).join('')}<li>当前结果 · ${escapeHtml(historicalOutcomeText(sample))}${why ? ' · ' + escapeHtml(why) : ''}</li></ol>` : '';
      return `<details class="run-item" data-sample-id="${escapeHtml(sample.sample_id)}" data-history-disclosure="${escapeHtml(scope)}"><summary data-history-focus="${escapeHtml(scope)}"><span>${escapeHtml(sample.task)} · 第 ${escapeHtml(sample.round)} 轮</span><span class="run-item-summary-status">${escapeHtml(historicalOutcomeText(sample))} · ${escapeHtml(why || score)}</span></summary><div class="run-item-body">
        ${why ? `<p class="item-error">${escapeHtml(why)}</p>` : sample.runner_error ? `<p class="item-error">${escapeHtml(sample.runner_error)}</p>` : ''}
        ${sampleResultNotes(sample)}${attemptLines}
        <dl class="evidence-grid"><div><dt>内容得分</dt><dd>${escapeHtml(score)}</dd></div><div><dt>执行耗时</dt><dd>${escapeHtml(sample.elapsed_seconds ?? '未记录')} 秒</dd></div><div><dt>请求次数</dt><dd>${escapeHtml(sample.api_request_count ?? sample.calls?.length ?? '未记录')}</dd></div><div><dt>开始 / 结束</dt><dd>${escapeHtml(formatDate(sample.started_at))} → ${escapeHtml(formatDate(sample.finished_at))}</dd></div><div><dt>账号绑定</dt><dd>${escapeHtml(sample.account_ref || '未记录')} · ${escapeHtml(sample.account_evidence || '未记录绑定证据')}</dd></div><div><dt>样本 ID</dt><dd>${escapeHtml(sample.sample_id)}</dd></div></dl>
        ${evidence('原始回答', sample.text || sample.response || sample.raw_response)}${evidence('评分结果', sample.grade)}${evidence('Tool trace', sample.tool_trace)}${evidence('用量记录（包含重试）', sample.usage)}${evidence('本次尝试用量 / 费用', sample.latest_attempt_usage || sample.latest_attempt_cost_usd !== undefined ? { usage: sample.latest_attempt_usage ?? null, estimated_cost_usd: sample.latest_attempt_cost_usd ?? null } : null)}${evidence('历次尝试（原始记录）', sample.attempts)}${evidence('完整样本证据', sample)}
      </div></details>`;
    };
    const attention = samples.filter(sample => sample.status !== 'completed' && !['pending', 'queued', 'running'].includes(sample.status) || sample.status === 'completed' && !validScore(sample));
    const openSamples = new Set([...(container.querySelectorAll?.('[data-sample-id][open]') || [])].map(node => node.dataset.sampleId));
    const allKey = escapeHtml(`${run.id}:all-samples`);
    replaceHistoryMarkup(container, `${summary}${run.stop_reason && run.stop_reason !== 'api_failure' ? `<p class="item-error">停止原因：${escapeHtml(run.stop_reason)}</p>` : ''}${matrix}${matrix ? `<p class="sample-matrix-legend">${[['full', '1', '满分'], ['partial', '0.5', '部分得分'], ['zero', '0', '零分'], ['unscored', '无分', '答案不可评分'], ['failed', '失败', 'API 失败或超时'], ['pending', '…', '未结束']].filter(([tone]) => samples.some(sample => sampleTone(sample) === tone)).map(([tone, cell, label]) => `<span class="sample-cell is-${tone}">${cell}</span>${label}`).join('')} · 点击格子查看样本</p>` : ''}${attention.length ? `<h3 class="sample-section-title">需要关注的样本（${attention.length}）</h3>${attention.map(sampleRow).join('')}` : ''}<details class="raw-block sample-all" data-history-disclosure="${allKey}"><summary data-history-focus="${allKey}">全部 ${samples.length} 个样本详情</summary>${samples.filter(sample => !attention.includes(sample)).map(sampleRow).join('')}</details>${jsonBlock('预算状态（估算而非账单）', run.budget)}`);
    for (const node of container.querySelectorAll?.('[data-sample-id]') || []) if (openSamples.has(node.dataset.sampleId)) node.open = true;
  }
  function renderDetails() {
    const list = element('bench-run-list'), active = list.ownerDocument?.activeElement;
    const focused = list.contains?.(active) ? active : null;
    const focusKey = focused?.dataset?.historyFocus, focusId = focused?.id;
    const openDisclosures = new Set([...(runSection.querySelectorAll?.('details[data-history-disclosure][open]') || [])].map(node => node.dataset.historyDisclosure));
    renderHistory();
    moveHistorySection(list.querySelector?.('[data-inline-task="' + state.selectedTaskId + '"]'), taskSection);
    renderTaskDetail(); renderRunDetail();
    const runSlot = element('bench-task-detail').querySelector?.('[data-inline-run="' + state.selectedRunId + '"]') || list.querySelector?.('[data-inline-run="' + state.selectedRunId + '"]');
    moveHistorySection(runSlot, runSection);
    runSection.hidden = !state.selectedRunId;
    for (const node of runSection.querySelectorAll?.('details[data-history-disclosure]') || []) if (openDisclosures.has(node.dataset.historyDisclosure)) node.open = true;
    if (focused && list.ownerDocument.activeElement !== focused) {
      const replacement = focusKey ? [...(list.querySelectorAll?.('[data-history-focus]') || [])].find(node => node.dataset.historyFocus === focusKey) : focusId ? element(focusId) : null;
      if (replacement?.isConnected && !replacement.closest?.('[hidden]')) replacement.focus({ preventScroll: true });
    }
  }

  element('bench-run-detail').addEventListener('click', event => {
    const cell = event.target.closest?.('[data-open-sample]');
    if (!cell) return;
    const target = [...element('bench-run-detail').querySelectorAll('details[data-sample-id]')].find(node => node.dataset.sampleId === cell.dataset.openSample);
    if (!target) return;
    const parent = target.parentElement?.closest('details');
    if (parent) parent.open = true;
    target.open = true;
    target.scrollIntoView?.({ block: 'nearest' });
    target.querySelector('summary')?.focus({ preventScroll: true });
  });
  element('history-search').addEventListener('input', renderDetails);
  element('history-status').addEventListener('change', renderDetails);
  return { element, historyEntries, renderDetails, inProgress, canCancel, fixedTargets, taskSection, runSection };
}
