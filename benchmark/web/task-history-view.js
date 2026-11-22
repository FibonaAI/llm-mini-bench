import { remoteRouteNamespace } from './data-adapter.js';

/** Render history and movable inline details; coordinator owns selection and polling. */
export function createTaskHistoryView({ app, state, retryRequests, retrying }) {
  const { byId: lookupElement, escapeHtml, activeStatus, statusText, formatDate, request } = app.services;
  const callSummaries = new Map(); // run id -> { key, calls | null, loading }
  const detailElements = new Map(
    [
      'bench-close-task',
      'bench-close-run',
      'bench-task-section',
      'bench-task-detail',
      'bench-cancel-task',
      'bench-copy-task',
      'bench-retry-task',
      'bench-run-section',
      'bench-run-detail',
      'bench-run-title',
      'bench-cancel-run',
      'bench-copy-run',
      'bench-retry-run'
    ].map(id => [id, lookupElement(id)])
  );
  const element = id => lookupElement(id) || detailElements.get(id);
  const inProgress = record => record && (activeStatus(record.status) || record.status === 'cancelling');
  const canCancel = record => inProgress(record) && record.status !== 'cancelling';
  const fixedTargets = record => record.plan?.targets || record.targets || [];
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
  const hasTimeoutSamples = record => {
    if (!record) return false;
    if ((record.sample_status_counts?.timeout ?? 0) > 0) return true;
    if (Array.isArray(record.samples) && record.samples.some(isTimeoutSample)) return true;
    return Array.isArray(record.children) && record.children.some(hasTimeoutSamples);
  };
  const statusBadgeClass = record => {
    if (!record) return '';
    if (inProgress(record)) return 'is-running';
    if (record.status === 'failed') return 'is-failed';
    if (record.status === 'interrupted') return 'is-interrupted';
    if (record.status === 'cancelled') return 'is-cancelled';
    if (record.status === 'timeout' || record.status === 'incomplete') return 'is-timeout';
    if (record.status === 'completed') return hasTimeoutSamples(record) ? 'is-timeout' : 'is-completed';
    return '';
  };
  const statusTone = record => statusBadgeClass(record).replace(/^is-/, '') || 'queued';
  const shortId = id => (typeof id === 'string' && id.length > 14 ? id.slice(0, 8) : String(id || ''));
  const shortThink = target => (target?.thinking === 'default' ? '默认' : target?.thinking || '未记录');
  const shortAccount = target => (target?.account_evidence === 'gateway_binding' ? '自动分配' : target?.account_ref || '未记录');
  const isPinnedAccount = target => Boolean(target?.account_ref) && target?.account_evidence !== 'gateway_binding';
  const CHANNEL_LOCAL_ICON =
    '<svg class="channel-pod-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75h.01M5 11.25h.01"/></svg>';
  const CHANNEL_REMOTE_ICON =
    '<svg class="channel-pod-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.8 8h10.4M8 2.5a8 8 0 0 1 0 11M8 2.5a8 8 0 0 0 0 11"/></svg>';
  const TIMEOUT_CHIP_ICON =
    '<svg class="chip-state-svg" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="5.2"/><path d="M7 4.2V7l1.9 1.2"/></svg>';
  const retryCopy = (record, confirming) => {
    const counts = { api: 0, timeout: 0, interrupted: 0, cancelled: 0 };
    const collect = item => {
      if (!item) return;
      if (Array.isArray(item.samples)) {
        for (const sample of item.samples) {
          if (isTimeoutSample(sample)) counts.timeout++;
          else if (sample.status === 'api_failure') counts.api++;
          else if (sample.status === 'interrupted') counts.interrupted++;
          else if (sample.status === 'cancelled') counts.cancelled++;
        }
        return;
      }
      const c = item.sample_status_counts || {};
      counts.api += c.api_failure || 0;
      counts.timeout += c.timeout || 0;
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
    }
    if (activeKinds.length > 1) return confirming ? '确认重试未完成样本' : '重试未完成样本';
    return confirming ? '确认重试 API 失败' : '重试 API 失败';
  };
  const historicalOutcomeText = sample =>
    isTimeoutSample(sample)
      ? '超时（按 0 分计）'
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
  /** Terminal 'failed' means some samples hit API failures, not that the whole run failed. */
  const recordStatusLabel = record => {
    if (record.status === 'completed') {
      const timeouts =
        record.sample_status_counts?.timeout ??
        (Array.isArray(record.samples) ? record.samples.filter(isTimeoutSample).length : 0) +
          (Array.isArray(record.children) ? record.children.reduce((sum, c) => sum + (c.sample_status_counts?.timeout ?? 0), 0) : 0);
      return timeouts > 0 ? `已完成 · ${timeouts} 超时` : statusText(record.status);
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
      sample => (sample.status !== 'completed' && !['pending', 'queued', 'running'].includes(sample.status)) || sample.attempts?.length
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
  function sampleScoringLabel(sample) {
    if (isTimeoutSample(sample)) return '0（超时）';
    if (validScore(sample) && sample.grade.outcome === 'no_submission') return '未调用 submit_answer 提交答案 · 0';
    if (validScore(sample)) return Number(sample.grade.content_score.toFixed(3));
    if (sample.status !== 'completed') return '无评分';
    return { ambiguous: '答案解析有歧义，无法评分', ungradable: '答案无法解析，无法评分' }[sample.grade?.outcome] || '评分记录缺失或无效';
  }
  function sampleResultNotes(sample) {
    if (sample.status !== 'completed') return '';
    const notes = [];
    if (!validScore(sample))
      notes.push(
        sample.grade?.outcome === 'ambiguous'
          ? '严格解析未能确定唯一答案，可能包含不同的 JSON 对象，或额外的损坏 JSON。无法评分不等于内容得 0 分；系统不会自动选取其中一个对象。'
          : sample.grade?.outcome === 'ungradable'
            ? '回答未能解析为可评分的答案。这不是等待评分，也不能据此断言内容全部错误。'
            : '评分记录缺失或得分不在 0–1 范围内；不会补记为 0 分。'
      );
    if (!knownUsage(sample.usage) || !knownCost(sample.estimated_uncached_cost_usd)) {
      const attempts = Array.isArray(sample.attempts) ? sample.attempts : [];
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
      notes.push(
        `${missing}未知。${priorUnknown ? '历次尝试存在缺失记录，即使本次重试成功，累计值仍保留为未知；本次尝试的已知值不代表全部消耗。' : '缺失记录不会按 0 补齐；已完成仅表示执行结束。'}`
      );
    }
    return notes.map(note => `<p class="task-detail-note">${escapeHtml(note)}</p>`).join('');
  }
  function qualityLabel(record) {
    if (inProgress(record)) return '';
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
      total('unscored_samples') > 0 && `${total('unscored_samples')} 个已完成样本无法评分`,
      unknownUsage > 0 ? `${unknownUsage} 个累计用量未知` : unknownCost > 0 && `${unknownCost} 个累计费用未知`
    ]
      .filter(Boolean)
      .join(' · ');
  }
  function historyEntries() {
    return [
      ...state.tasks.map(record => ({ kind: 'task', record })),
      ...state.runs.filter(record => !record.task_id).map(record => ({ kind: 'legacy', record }))
    ].sort((a, b) => Number(new Date(b.record.created_at || 0)) - Number(new Date(a.record.created_at || 0)));
  }
  const searchTokens = query => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesTokens = (text, tokens) => !tokens.length || tokens.every(token => text.includes(token));
  const targetSearchText = target =>
    [
      target?.model,
      target?.model_display_name,
      target?.thinking,
      target?.route_id,
      target?.account_ref,
      target?.provider_id,
      target?.provider_name,
      target ? remoteRouteNamespace(target) : null
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  const childMatchesTokens = (child, tokens) =>
    matchesTokens(
      [child?.run_id, child?.status, statusText(child?.status), targetSearchText(child?.target)].join(' ').toLowerCase(),
      tokens
    );
  const recordHeaderMatchesTokens = (record, tokens) =>
    matchesTokens([record?.id, record?.status, statusText(record?.status)].join(' ').toLowerCase(), tokens);
  function renderHistory() {
    const entries = historyEntries();
    element('run-summary').textContent =
      `${state.tasks.length} 个任务 · ${entries.filter(entry => entry.kind === 'legacy').length} 条旧运行 · ${entries.filter(entry => inProgress(entry.record)).length} 个进行中`;
    const tokens = searchTokens(element('history-search').value),
      status = element('history-status').value;
    const shown = entries.filter(({ kind, record }) => {
      if (status !== 'all' && record.status !== status) return false;
      if (!tokens.length) return true;
      if (recordHeaderMatchesTokens(record, tokens)) return true;
      if (kind === 'task' && Array.isArray(record.children) && record.children.length)
        return record.children.some(child => childMatchesTokens(child, tokens));
      return fixedTargets(record).some(target => matchesTokens(targetSearchText(target), tokens));
    });
    replaceHistoryMarkup(
      element('bench-run-list'),
      shown.length
        ? shown
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
              const channelBadges = renderChannelBadges(channelGroups, kind === 'task', statusTone(record));
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
              const idTag = `<code class="task-id-tag" title="${escapeHtml(record.id)}">${escapeHtml(shortId(record.id))}</code>`;
              const counts = kind === 'task' ? renderTaskCountsBar(record, children, progress) : '';
              const recordTone = statusTone(record);
              return `<article class="history-entry${selected ? ' is-expanded' : ''}"><button class="run-list-item ${selected ? 'is-selected' : ''}" type="button" aria-expanded="${selected}" aria-controls="history-${kind === 'task' ? 'task' : 'run'}-${escapeHtml(record.id)}" data-history-focus="${escapeHtml(kind + ':' + record.id)}" ${kind === 'task' ? 'data-bench-task-id' : 'data-bench-run-id'}="${escapeHtml(record.id)}"><span class="run-list-main"><strong${headline?.title ? ` title="${escapeHtml(headline.title)}"` : ''}>${escapeHtml(title)}</strong>${channelBadges}<small>${taskMetaParts.map(escapeHtml).join(' · ')} · ${idTag}</small></span><span class="run-list-status ${statusBadgeClass(record)}"><i class="task-dot is-${recordTone}" aria-hidden="true"></i>${escapeHtml(recordStatusLabel(record))}</span></button>${counts ? `<div class="task-status-counts">${counts}</div>` : ''}<div id="history-${kind === 'task' ? 'task' : 'run'}-${escapeHtml(record.id)}" data-inline-${kind === 'task' ? 'task' : 'run'}="${escapeHtml(record.id)}"></div></article>`;
            })
            .join('')
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
    const counts = { running: 0, completed: 0, queued: 0, timeout: 0, incomplete: 0, failed: 0, interrupted: 0, cancelled: 0 };
    const segments = { completed: 0, running: 0, timeout: 0, failed: 0, interrupted: 0, cancelled: 0 };
    let sampleDone = 0;
    let sampleTotal = 0;
    let timeoutSamples = 0;
    for (const child of children) {
      const tone = childPreviewTone(child);
      const progress = sampleProgress(child);
      sampleDone += progress.done;
      sampleTotal += progress.total;
      timeoutSamples += child.sample_status_counts?.timeout ?? 0;
      if (child.status === 'running' || child.status === 'cancelling') counts.running++;
      else if (child.status === 'queued') counts.queued++;
      else if (child.status === 'failed') counts.failed++;
      else if (child.status === 'interrupted') counts.interrupted++;
      else if (child.status === 'cancelled') counts.cancelled++;
      else if (child.status === 'incomplete') counts.incomplete++;
      else if (child.status === 'timeout' || (child.status === 'completed' && hasTimeoutSamples(child))) counts.timeout++;
      else if (child.status === 'completed') counts.completed++;
      if (Object.hasOwn(segments, tone) && progress.done > 0) segments[tone] += progress.done;
    }
    return { counts, segments, sampleDone, sampleTotal, timeoutSamples };
  }
  function channelHealthTone(children, fallbackTone = 'queued') {
    if (!children.length) return fallbackTone;
    const { counts } = summarizeChildren(children);
    if (counts.failed > 0) return 'failed';
    if (counts.timeout > 0 || counts.incomplete > 0) return 'timeout';
    if (counts.interrupted > 0) return 'interrupted';
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
    const order = ['completed', 'running', 'timeout', 'failed', 'interrupted', 'cancelled'];
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
  function renderChannelBadges(groups, showCount, fallbackTone) {
    if (!groups.length) return '';
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
    return `<span class="task-card-channels">${badges}${overflow}</span>`;
  }
  function renderTaskCountsBar(record, children, progress) {
    if (!children.length) return '';
    const sum = summarizeChildren(children);
    const { counts, timeoutSamples } = sum;
    const pills = [`<span class="task-count-pill is-total">总计 ${children.length}</span>`];
    const pushPill = (tone, label) => {
      pills.push(
        `<span class="task-count-pill is-${tone}"><i class="task-dot is-${tone}" aria-hidden="true"></i>${escapeHtml(label)}</span>`
      );
    };
    if (counts.running) pushPill('running', `运行中 ${counts.running}`);
    if (counts.completed) pushPill('completed', `已完成 ${counts.completed}`);
    if (counts.queued) pushPill('queued', `排队 ${counts.queued}`);
    if (counts.timeout) pushPill('timeout', `超时 ${counts.timeout}${timeoutSamples ? `（${timeoutSamples} 样本）` : ''}`);
    if (counts.incomplete) pushPill('timeout', `未完成 ${counts.incomplete}`);
    if (counts.failed) pushPill('failed', `API 失败 ${counts.failed}`);
    if (counts.interrupted) pushPill('interrupted', `已中断 ${counts.interrupted}`);
    if (counts.cancelled) pushPill('cancelled', `已取消 ${counts.cancelled}`);
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
    if (child.status === 'running' || child.status === 'cancelling') return 'running';
    if (child.status === 'failed') return 'failed';
    if (child.status === 'interrupted') return 'interrupted';
    if (child.status === 'cancelled') return 'cancelled';
    if (child.status === 'timeout' || child.status === 'incomplete') return 'timeout';
    if (child.status === 'completed') return hasTimeoutSamples(child) ? 'timeout' : 'completed';
    return 'queued';
  }
  function childPreviewStateHtml(child, progress) {
    if (child.status === 'queued') return '排队';
    if (child.status === 'running' || child.status === 'cancelling') return `${progress.done}/${progress.total}`;
    if (child.status === 'failed') return '× 失败';
    if (child.status === 'interrupted') return '‖ 中断';
    if (child.status === 'cancelled') return '已取消';
    if (child.status === 'incomplete') return '未完成';
    if (child.status === 'completed') {
      const timeouts = child.sample_status_counts?.timeout ?? 0;
      if (timeouts > 0) return `${TIMEOUT_CHIP_ICON}${timeouts} 超时`;
      return qualityLabel(child) ? '✓ · 注' : '✓ 完成';
    }
    return escapeHtml(statusText(child.status));
  }
  function renderTaskPreview(task, visibleChildren) {
    if (!visibleChildren.length) return '<div class="empty">没有匹配的子运行。</div>';
    const channelPods = groupByChannel(visibleChildren);
    const presentTones = new Set(visibleChildren.map(childPreviewTone));
    let slotIndex = 0;
    const podsHtml = channelPods
      .map(pod => {
        const podSum = summarizeChildren(pod.children);
        const podTone = channelHealthTone(pod.children);
        const isRemote = pod.children.some(child => Boolean(remoteRouteNamespace(child.target)));
        const { distinct: podAccounts, podBadge } = describeChannelAccounts(pod.children);
        const statusBits = [
          podSum.counts.running ? `运行中 ${podSum.counts.running}` : '',
          podSum.counts.completed ? `完成 ${podSum.counts.completed}` : '',
          podSum.counts.timeout ? `超时 ${podSum.counts.timeout}` : '',
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
        const modelRows = modelGroups
          .map(group => {
            const currentSlot = slotIndex++;
            const slotId = `history-preview-run-${task.id}-${currentSlot}`;
            const accounts = [...new Set(group.children.map(child => shortAccount(child.target)))];
            const thinkings = [...new Set(group.children.map(child => shortThink(child.target)))];
            const multiAccount = accounts.length > 1;
            const singleThinking = thinkings.length === 1 && multiAccount;
            const groupSum = summarizeChildren(group.children);
            const doneRuns = group.children.filter(child => child.status === 'completed').length;
            const contextParts = [
              !multiAccount && podAccounts.length > 1 && accounts[0] ? accounts[0] : '',
              `${groupSum.sampleDone}/${groupSum.sampleTotal} 样本`,
              `完成 ${doneRuns}/${group.children.length}`,
              groupSum.counts.running ? `运行中 ${groupSum.counts.running}` : '',
              groupSum.counts.timeout ? `超时 ${groupSum.counts.timeout}` : '',
              groupSum.counts.failed ? `失败 ${groupSum.counts.failed}` : '',
              groupSum.counts.interrupted ? `中断 ${groupSum.counts.interrupted}` : ''
            ].filter(Boolean);
            const chips = group.children
              .map(child => {
                const target = child.target || {},
                  progress = sampleProgress(child),
                  tone = childPreviewTone(child),
                  selected = child.run_id === state.selectedRunId,
                  acc = shortAccount(target),
                  th = shortThink(target),
                  budget = budgetLabel(child.budget, child.status),
                  quality = qualityLabel(child);
                const label = multiAccount ? (singleThinking ? acc : `${acc} · ${th}`) : th;
                const stateHtml = childPreviewStateHtml(child, progress);
                const pct = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
                const tooltip = [
                  targetLabel(target),
                  targetIdentity(target),
                  recordStatusLabel(child),
                  `${progress.done}/${progress.total} 样本`,
                  budget,
                  quality,
                  child.retryable_samples > 0 && !inProgress(child) ? `${child.retryable_samples} 个可重试` : ''
                ]
                  .filter(Boolean)
                  .join(' · ');
                const runningDecor =
                  tone === 'running'
                    ? '<span class="task-preview-chip-fill" aria-hidden="true"></span><span class="task-preview-chip-track" aria-hidden="true"></span><i class="task-dot is-running is-pulse" aria-hidden="true"></i>'
                    : '';
                return `<button type="button" class="task-preview-chip is-${tone}${selected ? ' is-selected' : ''}"${tone === 'running' ? ` style="--pct:${pct}%"` : ''} data-preview-run-id="${escapeHtml(child.run_id)}" data-history-focus="preview-run:${escapeHtml(child.run_id)}" aria-expanded="${selected}" aria-controls="${escapeHtml(slotId)}" title="${escapeHtml(tooltip)}">${runningDecor}<span class="task-preview-chip-label">${escapeHtml(label)}</span><span class="task-preview-chip-state">${stateHtml}</span></button>`;
              })
              .join('');
            return `<div class="task-preview-group"><div class="task-preview-head"><strong>${escapeHtml(group.modelName)}</strong><span class="task-preview-stats">${escapeHtml(contextParts.join(' · '))}</span></div><div class="task-preview-runs">${chips}</div><div id="${escapeHtml(slotId)}" class="task-preview-slot" data-preview-model-slot="${currentSlot}" data-preview-run-ids="${escapeHtml(group.children.map(child => child.run_id).join(','))}"></div></div>`;
          })
          .join('');
        return `<section class="channel-pod is-${podTone}" aria-label="${escapeHtml(`渠道 ${pod.name}`)}"><header class="channel-pod-head"><div class="channel-pod-identity"><span class="channel-pod-icon">${isRemote ? CHANNEL_REMOTE_ICON : CHANNEL_LOCAL_ICON}</span><strong class="channel-pod-name">${escapeHtml(pod.name)}</strong>${podBadge ? `<span class="channel-pod-tag">${escapeHtml(podBadge)}</span>` : ''}${isRemote ? '<span class="channel-pod-tag is-remote">远端路由</span>' : ''}</div><div class="channel-pod-summary">${statusBits ? `<span class="channel-pod-status is-${podTone}"><i class="task-dot is-${podTone}" aria-hidden="true"></i>${escapeHtml(statusBits)}</span>` : ''}${podSum.sampleTotal > 0 ? `<span class="channel-pod-progress">${renderProgressBar(podSum.segments, podSum.sampleTotal, true)}<span class="channel-pod-count">${podSum.sampleDone}/${podSum.sampleTotal}</span></span>` : ''}</div></header><div class="channel-pod-body">${modelRows}</div></section>`;
      })
      .join('');
    const legend = [
      ['completed', '已完成'],
      ['running', '运行中'],
      ['queued', '排队中'],
      ['timeout', '超时 / 未完成'],
      ['failed', 'API 失败'],
      ['interrupted', '已中断'],
      ['cancelled', '已取消']
    ]
      .filter(([tone]) => presentTones.has(tone))
      .map(
        ([tone, label]) => `<span class="task-preview-legend-item"><i class="task-dot is-${tone}" aria-hidden="true"></i>${label}</span>`
      )
      .join('');
    return `<div class="task-preview" aria-label="任务按渠道与模型预览">${podsHtml}</div><p class="task-preview-legend">${legend}<span class="muted">点击运行标签查看样本详情</span></p>`;
  }
  function taskCostLabel(children) {
    let total = 0,
      hasKnown = false,
      hasUnknown = false;
    for (const child of children) {
      const cost = child.budget?.estimated_uncached_cost_usd;
      if (Number.isFinite(cost) && cost >= 0) {
        total += cost;
        if (cost > 0 || child.status === 'completed') hasKnown = true;
      } else if (Number.isFinite(child.budget?.known_cost_lower_bound_usd) && child.budget.known_cost_lower_bound_usd > 0) {
        total += child.budget.known_cost_lower_bound_usd;
        hasKnown = true;
        hasUnknown = true;
      } else if (!inProgress(child) && child.status !== 'queued') {
        hasUnknown = true;
      }
    }
    if (!hasKnown) return '';
    return `${hasUnknown ? '≥ ' : ''}$${total.toFixed(4)}`;
  }
  function renderTaskDetail() {
    const task =
      state.taskDetail?.id === state.selectedTaskId ? state.taskDetail : state.tasks.find(entry => entry.id === state.selectedTaskId);
    element('bench-task-section').hidden = !state.selectedTaskId;
    element('bench-cancel-task').hidden = !inProgress(task);
    element('bench-cancel-task').disabled = !canCancel(task) || state.cancelling.has(`task:${task?.id}`);
    if (!task) {
      replaceHistoryMarkup(element('bench-task-detail'), '<div class="empty">正在读取任务详情…</div>');
      return;
    }
    const plan = task.plan || {},
      children = task.children || [];
    const rawQuery = element('history-search').value.trim(),
      tokens = searchTokens(rawQuery);
    const filterChildren = tokens.length > 0 && !recordHeaderMatchesTokens(task, tokens);
    const visibleChildren = filterChildren ? children.filter(child => childMatchesTokens(child, tokens)) : children;
    const taskConfirmLabel = retryCopy(task, true);
    element('bench-retry-task').hidden = inProgress(task) || !children.some(child => child.retryable_samples > 0);
    element('bench-retry-task').disabled = retrying.has(`tasks:${task.id}`);
    element('bench-retry-task').textContent = retrying.has(`tasks:${task.id}`)
      ? '正在提交重试…'
      : retryCopy(task, retryRequests.has(`tasks:${task.id}`));
    const totalCost = taskCostLabel(children);
    const allRunsKey = escapeHtml(`${task.id}:all-runs`);
    replaceHistoryMarkup(
      element('bench-task-detail'),
      `${retryRequests.has(`tasks:${task.id}`) && !retrying.has(`tasks:${task.id}`) ? `<p class="task-detail-note">待确认：仅重试失败、超时、中断或已取消样本，保留已完成结果；再次点击右上角“${escapeHtml(taskConfirmLabel)}”后开始。</p>` : ''}<div class="run-detail-meta">${plan.rounds ? `<span>轮数 <strong>${escapeHtml(plan.rounds)}</strong></span>` : ''}<span>并发 <strong>${escapeHtml(plan.run_concurrency ?? '未记录')} 运行 × ${escapeHtml(plan.sample_concurrency ?? '未记录')} 样本</strong></span>${totalCost ? `<span>估算费用 <strong>${escapeHtml(totalCost)}</strong></span>` : ''}<span>任务 ID <code class="task-meta-id">${escapeHtml(task.id)}</code></span></div>${filterChildren && visibleChildren.length < children.length ? `<p class="task-detail-note">已按搜索“${escapeHtml(rawQuery)}”筛选：仅显示 ${visibleChildren.length} / ${children.length} 个匹配子运行。</p>` : ''}${renderTaskPreview(task, visibleChildren)}<details class="raw-block task-all-runs" data-history-disclosure="${allRunsKey}"><summary data-history-focus="${allRunsKey}">全部 ${visibleChildren.length} 个独立运行列表${filterChildren && visibleChildren.length < children.length ? `（共 ${children.length} 个）` : ''}</summary><div class="task-child-list">${visibleChildren
        .map(child => {
          const target = child.target || {},
            progress = sampleProgress(child),
            budget = budgetLabel(child.budget, child.status),
            quality = qualityLabel(child);
          return `<div class="task-child-row ${child.run_id === state.selectedRunId ? 'is-selected' : ''}" data-child-run-id="${escapeHtml(child.run_id)}"><button class="task-child-open" type="button" aria-expanded="${child.run_id === state.selectedRunId}" aria-controls="history-run-${escapeHtml(child.run_id)}" data-history-focus="run:${escapeHtml(child.run_id)}" data-bench-run-id="${escapeHtml(child.run_id)}"><strong>${escapeHtml(targetLabel(target))}</strong><span>${escapeHtml(targetIdentity(target))}</span><small>运行 ${escapeHtml(child.run_id)} · ${progress.done}/${progress.total} 样本已结束${budget ? ` · ${escapeHtml(budget)}` : ''}${quality ? ` · ${escapeHtml(quality)}` : ''}${child.stop_reason && child.stop_reason !== 'api_failure' ? ` · 停止原因 ${escapeHtml(child.stop_reason)}` : ''}${child.retryable_samples > 0 && !inProgress(child) ? ` · ${child.retryable_samples} 个可重试` : ''}</small></button><span class="run-list-status ${statusBadgeClass(child)}">${escapeHtml(recordStatusLabel(child))}</span><button class="btn" type="button" data-history-focus="cancel:${escapeHtml(child.run_id)}" data-cancel-child="${escapeHtml(child.run_id)}" ${!canCancel(child) || state.cancelling.has(`run:${child.run_id}`) ? 'disabled' : ''}>取消运行</button></div><div id="history-run-${escapeHtml(child.run_id)}" data-inline-run="${escapeHtml(child.run_id)}"></div>`;
        })
        .join(
          ''
        )}</div></details><p class="task-detail-note">每个运行固定路由、模型和 Thinking，账号绑定以路由证据为准；独立保存样本与预算状态。取消某个运行不会取消其他运行。</p>`
    );
  }
  const lazyJsonPayloads = new Map();
  function hydrateLazyJson(node) {
    const key = node?.dataset?.lazyJson;
    if (!key || !node.open || !lazyJsonPayloads.has(key)) return;
    const text = JSON.stringify(lazyJsonPayloads.get(key), null, 2);
    const existing = node.querySelector?.('pre');
    if (existing) {
      if (existing.textContent !== text) existing.textContent = text;
      return;
    }
    const doc = node.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc?.createElement || !node.append) return;
    const pre = doc.createElement('pre');
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
  function renderRunDetail() {
    const run = state.runDetail?.id === state.selectedRunId ? state.runDetail : null;
    const container = element('bench-run-detail');
    element('bench-run-title').textContent = state.selectedTaskId ? '子运行样本' : '旧运行详情';
    element('bench-cancel-run').hidden = !inProgress(run);
    element('bench-cancel-run').disabled = !canCancel(run) || state.cancelling.has(`run:${run?.id}`);
    lazyJsonPayloads.clear();
    if (!run) {
      replaceHistoryMarkup(
        container,
        `<div class="empty">${state.selectedRunId ? '正在读取运行详情…' : '选择一个运行，查看逐题、逐轮样本与原始证据。'}</div>`
      );
      return;
    }
    const runConfirmLabel = retryCopy(run, true);
    element('bench-retry-run').hidden = inProgress(run) || !(run.retryable_samples > 0);
    element('bench-retry-run').disabled = retrying.has(`runs:${run.id}`);
    element('bench-retry-run').textContent = retrying.has(`runs:${run.id}`)
      ? '正在提交重试…'
      : retryCopy(run, retryRequests.has(`runs:${run.id}`));
    const samples = run.samples || [];
    const retryBatches = Array.isArray(run.retry_batches) ? run.retry_batches : [];
    const latestRetry = retryBatches.at(-1);
    const calls = ensureCallSummaries(run);
    const timeout = run.plan?.limits?.timeout;
    const failureText = sample => {
      if (sample.status === 'completed' || ['pending', 'queued', 'running'].includes(sample.status)) return null;
      return (
        attemptFailureText(sample, calls, timeout) ?? (calls === null && callSummaries.get(run.id)?.loading ? '正在读取调用记录…' : null)
      );
    };
    const retryNotePrefix =
      runConfirmLabel === '确认重试 API 失败'
        ? '待确认：仅重试 API 失败及因其停止的未执行样本，保留成功结果'
        : '待确认：仅重试失败、超时、中断或已取消样本，保留已完成结果';
    const summary = `${retryRequests.has(`runs:${run.id}`) && !retrying.has(`runs:${run.id}`) ? `<p class="task-detail-note">${retryNotePrefix}；再次点击右上角“${escapeHtml(runConfirmLabel)}”后开始。</p>` : ''}<div class="run-detail-meta"><span>运行 <strong>${escapeHtml(run.id)}</strong></span><span>状态 <strong>${escapeHtml(recordStatusLabel(run))}</strong></span><span>样本 <strong>${samples.length}</strong></span><span>已结束 <strong>${sampleProgress(run).done}</strong></span>${retryBatches.length ? `<span>手动重试 <strong>${retryBatches.length} 次${latestRetry?.created_at ? `（最近 ${escapeHtml(formatDate(latestRetry.created_at))}）` : ''}</strong></span>` : ''}${run.budget?.stop_reason ? `<span>停止原因 <strong>${escapeHtml(run.budget.stop_reason)}</strong></span>` : ''}</div><p class="task-detail-note">${escapeHtml(
      fixedTargets(run)
        .map(target => `${targetLabel(target)} · ${targetIdentity(target)}`)
        .join('；')
    )}${!run.task_id ? ' · 旧运行记录，未迁移为新任务。' : ''}</p>`;
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
    const taskIds = [...new Set(samples.map(sample => sample.task))],
      rounds = [...new Set(samples.map(sample => sample.round))].sort((a, b) => a - b);
    const byCell = new Map(samples.map(sample => [`${sample.task}\u0000${sample.round}`, sample]));
    const matrix = samples.length
      ? `<div class="sample-matrix" role="table" aria-label="逐题逐轮结果" style="--rounds:${rounds.length}"><div class="sample-matrix-row is-head" role="row"><span role="columnheader">题目</span>${rounds.map(round => `<span role="columnheader">第 ${escapeHtml(round)} 轮</span>`).join('')}</div>${taskIds
          .map(
            task =>
              `<div class="sample-matrix-row" role="row"><span role="rowheader" title="${escapeHtml(task)}">${escapeHtml(task)}</span>${rounds
                .map(round => {
                  const sample = byCell.get(`${task}\u0000${round}`);
                  if (!sample) return '<span role="cell" class="sample-cell is-missing">—</span>';
                  const why =
                    failureText(sample) || (!validScore(sample) && sample.status === 'completed' ? sampleScoringLabel(sample) : '');
                  return `<span role="cell"><button type="button" class="sample-cell is-${sampleTone(sample)}" data-open-sample="${escapeHtml(sample.sample_id)}" title="${escapeHtml(`${task} 第 ${round} 轮 · ${historicalOutcomeText(sample)}${why ? ' · ' + why : ''}`)}">${escapeHtml(cellText(sample))}</button></span>`;
                })
                .join('')}</div>`
          )
          .join('')}</div>`
      : '';
    const sampleRow = sample => {
      const score = sampleScoringLabel(sample),
        scope = `${run.id}:${sample.sample_id}`;
      const evidence = (title, value) => jsonBlock(title, value, scope);
      const why = failureText(sample);
      const attempts = Array.isArray(sample.attempts) ? sample.attempts : [];
      const attemptLines = attempts.length
        ? `<ol class="attempt-list">${attempts.map((attempt, index) => `<li>第 ${index + 1} 次尝试 · ${escapeHtml(statusText(attempt.status))}${attempt.status === 'completed' ? '' : ' · ' + escapeHtml(attemptFailureText(attempt, calls, timeout) ?? '原因读取中')}</li>`).join('')}<li>当前结果 · ${escapeHtml(historicalOutcomeText(sample))}${why ? ' · ' + escapeHtml(why) : ''}</li></ol>`
        : '';
      return `<details class="run-item" data-sample-id="${escapeHtml(sample.sample_id)}" data-history-disclosure="${escapeHtml(scope)}"><summary data-history-focus="${escapeHtml(scope)}"><span>${escapeHtml(sample.task)} · 第 ${escapeHtml(sample.round)} 轮</span><span class="run-item-summary-status">${escapeHtml(historicalOutcomeText(sample))} · ${escapeHtml(why || score)}</span></summary><div class="run-item-body">
        ${why ? `<p class="item-error">${escapeHtml(why)}</p>` : sample.runner_error ? `<p class="item-error">${escapeHtml(sample.runner_error)}</p>` : ''}
        ${sampleResultNotes(sample)}${attemptLines}
        <dl class="evidence-grid"><div><dt>内容得分</dt><dd>${escapeHtml(score)}</dd></div><div><dt>执行耗时</dt><dd>${escapeHtml(sample.elapsed_seconds ?? '未记录')} 秒</dd></div><div><dt>请求次数</dt><dd>${escapeHtml(sample.api_request_count ?? sample.calls?.length ?? '未记录')}</dd></div><div><dt>开始 / 结束</dt><dd>${escapeHtml(formatDate(sample.started_at))} → ${escapeHtml(formatDate(sample.finished_at))}</dd></div><div><dt>账号绑定</dt><dd>${escapeHtml(sample.account_ref || '未记录')} · ${escapeHtml(sample.account_evidence || '未记录绑定证据')}</dd></div><div><dt>样本 ID</dt><dd>${escapeHtml(sample.sample_id)}</dd></div></dl>
        ${evidence('原始回答', sample.text || sample.response || sample.raw_response)}${evidence('评分结果', sample.grade)}${evidence('Tool trace', sample.tool_trace)}${evidence('用量记录（包含重试）', sample.usage)}${evidence('本次尝试用量 / 费用', sample.latest_attempt_usage || sample.latest_attempt_cost_usd !== undefined ? { usage: sample.latest_attempt_usage ?? null, estimated_cost_usd: sample.latest_attempt_cost_usd ?? null } : null)}${evidence('历次尝试（原始记录）', sample.attempts)}${evidence('完整样本证据', sample)}
      </div></details>`;
    };
    const attention = samples.filter(
      sample =>
        (sample.status !== 'completed' && !['pending', 'queued', 'running'].includes(sample.status)) ||
        (sample.status === 'completed' && !validScore(sample))
    );
    const openSamples = new Set([...(container.querySelectorAll?.('[data-sample-id][open]') || [])].map(node => node.dataset.sampleId));
    const allKey = escapeHtml(`${run.id}:all-samples`);
    replaceHistoryMarkup(
      container,
      `${summary}${run.stop_reason && run.stop_reason !== 'api_failure' ? `<p class="item-error">停止原因：${escapeHtml(run.stop_reason)}</p>` : ''}${matrix}${
        matrix
          ? `<p class="sample-matrix-legend">${[
              ['full', '1', '满分'],
              ['partial', '0.5', '部分得分'],
              ['zero', '0', '零分'],
              ['timeout', '超时', '超时（0分/可重试）'],
              ['unscored', '无分', '答案不可评分'],
              ['failed', '失败', 'API 失败'],
              ['interrupted', '中断', '已中断'],
              ['cancelled', '取消', '已取消'],
              ['running', '运行', '运行中'],
              ['pending', '…', '待执行']
            ]
              .filter(([tone]) => samples.some(sample => sampleTone(sample) === tone))
              .map(([tone, cell, label]) => `<span class="sample-cell is-${tone}">${cell}</span>${label}`)
              .join('')} · 点击格子查看样本</p>`
          : ''
      }${attention.length ? `<h3 class="sample-section-title">需要关注的样本（${attention.length}）</h3>${attention.map(sampleRow).join('')}` : ''}<details class="raw-block sample-all" data-history-disclosure="${allKey}"><summary data-history-focus="${allKey}">全部 ${samples.length} 个样本详情</summary>${samples
        .filter(sample => !attention.includes(sample))
        .map(sampleRow)
        .join('')}</details>${jsonBlock('预算状态（估算而非账单）', run.budget)}`
    );
    for (const node of container.querySelectorAll?.('[data-sample-id]') || []) if (openSamples.has(node.dataset.sampleId)) node.open = true;
  }
  function placeRunSection() {
    if (!state.selectedRunId) {
      runSection.hidden = true;
      return;
    }
    const list = element('bench-run-list');
    const taskDetail = element('bench-task-detail');
    const allRuns = taskDetail.querySelector?.('details.task-all-runs');
    const previewSlot =
      allRuns && !allRuns.open
        ? [...(taskDetail.querySelectorAll?.('[data-preview-model-slot]') || [])].find(slot =>
            (slot.dataset?.previewRunIds || '').split(',').includes(state.selectedRunId)
          )
        : null;
    const runSlot =
      previewSlot ||
      taskDetail.querySelector?.('[data-inline-run="' + state.selectedRunId + '"]') ||
      list.querySelector?.('[data-inline-run="' + state.selectedRunId + '"]');
    if (allRuns && !allRuns.open && !previewSlot && runSlot && allRuns.contains?.(runSlot)) allRuns.open = true;
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

  element('bench-task-detail').addEventListener(
    'toggle',
    event => {
      if (event.target?.classList?.contains?.('task-all-runs') && state.selectedRunId) placeRunSection();
    },
    true
  );

  element('bench-run-detail').addEventListener(
    'toggle',
    event => {
      if (event.target?.dataset?.lazyJson && event.target.open) hydrateLazyJson(event.target);
    },
    true
  );

  element('bench-run-detail').addEventListener('click', event => {
    const cell = event.target.closest?.('[data-open-sample]');
    if (!cell) return;
    const target = [...element('bench-run-detail').querySelectorAll('details[data-sample-id]')].find(
      node => node.dataset.sampleId === cell.dataset.openSample
    );
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
