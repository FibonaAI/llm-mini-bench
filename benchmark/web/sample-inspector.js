/**
 * Adaptive inline sample inspector and Pi Session execution trace viewer.
 * Pure rendering helpers: takes run/sample/task/event data and returns escaped HTML.
 */

const DOMAIN_LABELS = {
  code: 'CODE',
  knowledge: 'KNOWLEDGE',
  reasoning: 'REASONING',
  context: 'CONTEXT',
  instruction: 'INSTRUCTION',
  tool_use: 'TOOL USE'
};

/**
 * Split a task ID like "C23_Async_Generator_Finally_Override" into short code + readable label.
 * @param {string} taskId
 * @returns {{ code: string, name: string }}
 */
export function splitTaskId(taskId) {
  const raw = String(taskId || '');
  const idx = raw.indexOf('_');
  if (idx > 0 && idx <= 6) {
    return { code: raw.slice(0, idx), name: raw.slice(idx + 1).replace(/_/g, ' ') };
  }
  return { code: '', name: raw };
}

/**
 * Resolve task metadata (domain, title, prompt, kind, expected answer) from loaded banks or run snapshots.
 * @param {string} taskId
 * @param {any} run
 * @param {any[]} banks
 */
export function resolveTaskSpec(taskId, run, banks = []) {
  const bankVersion = run?.plan?.bank_version || run?.bank_version || null;
  let task = null;
  if (Array.isArray(banks) && banks.length) {
    const preferred = bankVersion ? banks.find(b => b?.version === bankVersion) : null;
    const ordered = preferred ? [preferred, ...banks.filter(b => b !== preferred)] : banks;
    for (const bank of ordered) {
      const hit = bank?.tasks?.find?.(item => item?.id === taskId);
      if (hit) {
        task = hit;
        break;
      }
    }
  }
  const snapshot = run?.plan?.task_snapshots?.find?.(item => item?.id === taskId) || null;
  const source = task || snapshot || null;
  if (!source) {
    return { id: taskId, domain: '', title: '', prompt: '', kind: 'text', expected: null };
  }
  const grading = source.grading || {};
  const config = grading.config || {};
  let expected = null;
  if (isPlainObject(grading.expected)) expected = grading.expected;
  else if (isPlainObject(config.expected)) expected = config.expected;
  else if (config.expected_candidate !== undefined) expected = { candidate: config.expected_candidate };
  return {
    id: taskId,
    domain: typeof source.domain === 'string' ? source.domain : '',
    title: typeof source.title === 'string' ? source.title : '',
    prompt: typeof source.prompt === 'string' ? source.prompt : '',
    kind: source.kind === 'tool' || Array.isArray(source.tools) ? 'tool' : 'text',
    expected
  };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} seconds */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '未记录';
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalSec = Math.round(seconds);
  const mins = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  if (mins < 60) return `${mins}m${String(rem).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${String(mins % 60).padStart(2, '0')}m`;
}

/** @param {number} count */
function formatShortInt(count) {
  if (!Number.isFinite(count)) return '—';
  if (Math.abs(count) >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (Math.abs(count) >= 10_000) return `${(count / 1_000).toFixed(1)}K`;
  if (Math.abs(count) >= 1_000) return `${(count / 1_000).toFixed(2)}K`;
  return String(Math.round(count));
}

/** @param {any} usage */
export function formatTokensSummary(usage) {
  if (!usage || typeof usage !== 'object') return '用量未知';
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return '用量未知';
  const total = input + output;
  return `${formatShortInt(total)} (入 ${formatShortInt(input)} / 出 ${formatShortInt(output)})`;
}

/** @param {unknown} cost */
export function formatCostUsd(cost) {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return '未知';
  if (cost === 0) return '$0';
  if (cost < 0.0001) return '<$0.0001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Extract the model's structured answer object if available.
 * @param {any} sample
 * @returns {Record<string, any> | null}
 */
export function extractModelAnswer(sample) {
  if (!sample) return null;
  if (isPlainObject(sample.answer_submission?.answer)) return sample.answer_submission.answer;
  if (isPlainObject(sample.grade?.parsed_answer)) return sample.grade.parsed_answer;
  const raw = typeof sample.text === 'string' ? sample.text.trim() : '';
  if (!raw) return null;
  const unwrapped = raw.startsWith('```')
    ? raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()
    : raw;
  if (unwrapped.startsWith('{') && unwrapped.endsWith('}')) {
    try {
      const parsed = JSON.parse(unwrapped);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/** @param {unknown} value */
function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** @param {unknown} value */
function formatScalar(value) {
  if (value === undefined) return '（缺失）';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stableStringify(value);
}

/** @param {unknown} value @param {number} maxLen */
function formatCompactValue(value, maxLen = 42) {
  if (value === undefined) return '缺失';
  if (value === null) return 'null';
  let text = '';
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else if (Array.isArray(value))
    text = `[${value.map(item => (typeof item === 'object' ? stableStringify(item) : String(item))).join(', ')}]`;
  else if (isPlainObject(value)) {
    text = Object.entries(value)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? stableStringify(v) : String(v)}`)
      .join(', ');
  } else text = String(value);
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

/**
 * Render an inline diff pair [gotHtml, expHtml] highlighting differences.
 * @param {unknown} got
 * @param {unknown} exp
 * @param {(v: unknown) => string} esc
 * @param {boolean} hasExpected
 * @returns {[string, string]}
 */
export function renderDiffPair(got, exp, esc, hasExpected = true) {
  if (!hasExpected) {
    return [`<span class="si-val-plain">${esc(formatScalar(got))}</span>`, '<span class="si-val-muted">—</span>'];
  }
  if (got === undefined) {
    return ['<span class="si-tok-mismatch">（缺失）</span>', `<span class="si-tok-expected">${esc(formatScalar(exp))}</span>`];
  }
  if (Array.isArray(got) && Array.isArray(exp)) {
    const gotHtml = `<div class="si-diff-seq">${got
      .map((item, idx) => {
        const same = idx < exp.length && stableStringify(item) === stableStringify(exp[idx]);
        return `<span class="si-seq-tok${same ? '' : ' is-mismatch'}">${esc(formatScalar(item))}</span>`;
      })
      .join('')}${got.length === 0 ? '<span class="si-val-muted">[]</span>' : ''}</div>`;
    const expHtml = `<div class="si-diff-seq">${exp
      .map((item, idx) => {
        const same = idx < got.length && stableStringify(item) === stableStringify(got[idx]);
        return `<span class="si-seq-tok${same ? '' : ' is-expected'}">${esc(formatScalar(item))}</span>`;
      })
      .join('')}${exp.length === 0 ? '<span class="si-val-muted">[]</span>' : ''}</div>`;
    return [gotHtml, expHtml];
  }
  if (isPlainObject(got) && isPlainObject(exp)) {
    const keys = [...new Set([...Object.keys(exp), ...Object.keys(got)])];
    const gotParts = [];
    const expParts = [];
    for (const key of keys) {
      const same = Object.hasOwn(got, key) && Object.hasOwn(exp, key) && stableStringify(got[key]) === stableStringify(exp[key]);
      const gotText = Object.hasOwn(got, key) ? `${key}: ${formatScalar(got[key])}` : `${key}: 缺失`;
      const expText = Object.hasOwn(exp, key) ? `${key}: ${formatScalar(exp[key])}` : `${key}: —`;
      gotParts.push(same ? `<span class="si-obj-part">${esc(gotText)}</span>` : `<span class="si-tok-mismatch">${esc(gotText)}</span>`);
      expParts.push(same ? `<span class="si-obj-part">${esc(expText)}</span>` : `<span class="si-tok-expected">${esc(expText)}</span>`);
    }
    return [
      `<div class="si-diff-obj">${gotParts.join('<span class="si-obj-sep">, </span>')}</div>`,
      `<div class="si-diff-obj">${expParts.join('<span class="si-obj-sep">, </span>')}</div>`
    ];
  }
  const same = stableStringify(got) === stableStringify(exp);
  if (same) {
    return [`<span class="si-val-plain">${esc(formatScalar(got))}</span>`, `<span class="si-val-plain">${esc(formatScalar(exp))}</span>`];
  }
  return [
    `<span class="si-tok-mismatch">${esc(formatScalar(got))}</span>`,
    `<span class="si-tok-expected">${esc(formatScalar(exp))}</span>`
  ];
}

/**
 * Pick the default inspector tab based on the sample's outcome so the user sees the answer to their first question in 0 clicks.
 * @param {any} sample
 * @param {any} taskSpec
 * @param {{ validScore: (s: any) => boolean, isNoSubmissionSample: (s: any) => boolean, endedAfterSubmissionReason: (s: any) => string | null }} helpers
 * @returns {'grading' | 'trace' | 'raw'}
 */
export function defaultInspectorTab(sample, taskSpec, helpers) {
  if (!sample) return 'trace';
  if (sample.status !== 'completed') return 'trace';
  if (helpers.isNoSubmissionSample(sample)) return 'trace';
  if (!helpers.validScore(sample)) return 'trace';
  const score = sample.grade.content_score;
  const endedAfter = helpers.endedAfterSubmissionReason(sample);
  if (endedAfter && score >= 1) return 'trace';
  const checks = sample.grade?.content_checks;
  const hasChecks = isPlainObject(checks) && Object.keys(checks).length > 0;
  if (score < 1 && hasChecks) return 'grading';
  const isToolTask = taskSpec?.kind === 'tool' || (Array.isArray(sample.tool_trace) && sample.tool_trace.length > 1);
  if (score >= 1 && isToolTask) return 'trace';
  return hasChecks ? 'grading' : 'trace';
}

/**
 * Summarize protocol/instruction/tool checks into a single compact status indicator.
 * @param {any} sample
 * @param {(v: unknown) => string} esc
 */
function renderProtocolSummary(sample, esc) {
  const grade = sample?.grade;
  if (!grade || typeof grade !== 'object') return '';
  const pairs = [];
  for (const [key, value] of Object.entries(grade.instruction_checks || {})) {
    if (typeof value === 'boolean') pairs.push({ key, pass: value, group: '协议' });
  }
  for (const [key, value] of Object.entries(grade.tool_checks || {})) {
    if (typeof value === 'boolean') pairs.push({ key, pass: value, group: '工具' });
  }
  if (!pairs.length) return '';
  const failed = pairs.filter(item => !item.pass);
  if (!failed.length) {
    return `<span class="si-proto-badge is-ok" title="${esc(pairs.map(p => `${p.key}: ✓`).join('\n'))}">协议/工具检查 ${pairs.length}/${pairs.length} ✓</span>`;
  }
  return `<span class="si-proto-badge is-fail" title="${esc(pairs.map(p => `${p.key}: ${p.pass ? '✓' : '✗'}`).join('\n'))}">协议/工具检查 ${pairs.length - failed.length}/${pairs.length} · ✗ ${esc(failed.map(f => f.key).join(', '))}</span>`;
}

/**
 * Try pretty-printing a JSON string or object for trace cards.
 * @param {unknown} value
 */
function prettyJson(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Render the Grading Comparison tab.
 */
function renderGradingTab({ sample, taskSpec, showAllFields, esc, helpers }) {
  const grade = sample?.grade;
  const checks = isPlainObject(grade?.content_checks) ? grade.content_checks : {};
  const checkKeys = Object.keys(checks);
  const expected = isPlainObject(taskSpec?.expected) ? taskSpec.expected : null;
  const modelAnswer = extractModelAnswer(sample);

  const failedProto = [];
  for (const [k, v] of Object.entries(grade?.instruction_checks || {})) if (v === false) failedProto.push({ group: '协议', key: k });
  for (const [k, v] of Object.entries(grade?.tool_checks || {})) if (v === false) failedProto.push({ group: '工具', key: k });

  const protoAlert = failedProto.length
    ? `<div class="si-inline-alert is-err"><strong>未通过检查：</strong>${failedProto
        .map(item => `<code>${esc(item.key)}</code>`)
        .join('、')}</div>`
    : '';

  if (sample.status !== 'completed' || helpers.isNoSubmissionSample(sample) || !helpers.validScore(sample)) {
    const reasonText =
      sample.status !== 'completed'
        ? '该样本未完成，无有效判分对照。'
        : helpers.isNoSubmissionSample(sample)
          ? '模型自然结束时未调用 submit_answer 提交有效答案，按 0 分计。'
          : '该样本的回答无法被严格解析为唯一可评分答案。';
    return `${protoAlert}<div class="si-empty-state"><p>${esc(reasonText)}</p><button type="button" class="btn si-jump-btn" data-si-tab="trace">查看执行轨迹 →</button></div>`;
  }

  const allKeys = checkKeys.length ? checkKeys : expected ? Object.keys(expected) : modelAnswer ? Object.keys(modelAnswer) : [];

  if (!allKeys.length) {
    return `${protoAlert}<div class="si-empty-state"><p>该题无逐字段明细（得分 ${esc(Number(grade.content_score.toFixed(3)))}）。</p><button type="button" class="btn si-jump-btn" data-si-tab="trace">查看执行轨迹 →</button></div>`;
  }

  const hasDiffColumns = Boolean(expected || modelAnswer);
  const rows = allKeys.map(key => {
    const pass = typeof checks[key] === 'boolean' ? checks[key] : null;
    const hasExpected = Boolean(expected && Object.hasOwn(expected, key));
    const exp = hasExpected ? expected[key] : undefined;
    const got = modelAnswer && Object.hasOwn(modelAnswer, key) ? modelAnswer[key] : undefined;
    return { key, pass, got, exp, hasExpected };
  });

  const failedRows = rows.filter(r => r.pass === false);
  const otherRows = rows.filter(r => r.pass !== false);
  const ordered = [...failedRows, ...otherRows];
  const hasMixed = failedRows.length > 0 && otherRows.length > 0;
  const visibleRows = hasMixed && !showAllFields ? failedRows : ordered;

  const filterBar = hasMixed
    ? `<div class="si-subbar"><span class="si-subbar-meta">共 ${rows.length} 项：<strong>${failedRows.length} 错</strong> / ${otherRows.length} 通过</span><div class="si-pill-group"><button type="button" class="si-pill${!showAllFields ? ' is-active' : ''}" data-si-fields="failed">仅看错项 (${failedRows.length})</button><button type="button" class="si-pill${showAllFields ? ' is-active' : ''}" data-si-fields="all">全部 (${rows.length})</button></div></div>`
    : '';

  let tableHtml = '';
  if (hasDiffColumns) {
    tableHtml = `<div class="si-diff-wrap"><table class="si-diff-table"><thead><tr><th class="si-col-field">字段</th><th class="si-col-val">模型提交</th><th class="si-col-val">参考答案</th></tr></thead><tbody>${visibleRows
      .map(row => {
        const icon =
          row.pass === false
            ? '<span class="si-mark is-fail" aria-label="未通过">✗</span>'
            : row.pass === true
              ? '<span class="si-mark is-ok" aria-label="通过">✓</span>'
              : '<span class="si-mark">·</span>';
        const [gotHtml, expHtml] =
          row.pass === true
            ? [
                `<span class="si-val-plain">${esc(formatScalar(row.got))}</span>`,
                `<span class="si-val-plain">${esc(row.hasExpected ? formatScalar(row.exp) : '—')}</span>`
              ]
            : renderDiffPair(row.got, row.exp, esc, row.hasExpected);
        return `<tr class="${row.pass === false ? 'is-fail' : row.pass === true ? 'is-ok' : ''}"><td class="si-col-field">${icon}<code>${esc(row.key)}</code></td><td class="si-col-val">${gotHtml}</td><td class="si-col-val">${expHtml}</td></tr>`;
      })
      .join('')}</tbody></table>${
      hasMixed && !showAllFields
        ? `<div class="si-fold-bar"><span>已折叠 ${otherRows.length} 个通过字段（${esc(otherRows.map(r => r.key).join(', '))}）</span><button type="button" class="si-link-btn" data-si-fields="all">展开全部 ${rows.length} 项</button></div>`
        : ''
    }</div>`;
  } else {
    // State-based simulator tasks (e.g., T23_Delegated_Authority_Release)
    const toolEntries = Object.entries(grade?.tool_checks || {});
    tableHtml = `<div class="si-diff-wrap"><table class="si-diff-table is-checklist"><thead><tr><th>检查项</th><th>结果</th></tr></thead><tbody>${visibleRows
      .map(
        row =>
          `<tr class="${row.pass === false ? 'is-fail' : row.pass === true ? 'is-ok' : ''}"><td><code>${esc(row.key)}</code></td><td>${row.pass === true ? '<span class="si-mark is-ok">✓ 通过</span>' : row.pass === false ? '<span class="si-mark is-fail">✗ 未通过</span>' : '—'}</td></tr>`
      )
      .join('')}${toolEntries
      .map(
        ([k, v]) =>
          `<tr class="${v === false ? 'is-fail' : v === true ? 'is-ok' : ''}"><td><span class="si-check-tag">工具</span><code>${esc(k)}</code></td><td>${v === true ? '<span class="si-mark is-ok">✓ 通过</span>' : v === false ? '<span class="si-mark is-fail">✗ 未通过</span>' : `<code>${esc(String(v))}</code>`}</td></tr>`
      )
      .join('')}</tbody></table>${
      hasMixed && !showAllFields
        ? `<div class="si-fold-bar"><span>已折叠 ${otherRows.length} 个通过项</span><button type="button" class="si-link-btn" data-si-fields="all">展开全部 ${rows.length} 项</button></div>`
        : ''
    }</div>`;
  }

  return `${protoAlert}${filterBar}${tableHtml}`;
}

/**
 * Render one tool call card with optional paired tool_result inline.
 */
function renderToolCallCard(call, resultEvent, esc) {
  const name = call?.name || resultEvent?.payload?.name || 'unknown_tool';
  const isSubmit = name === 'submit_answer';
  const argsText = prettyJson(call?.arguments ?? resultEvent?.payload?.arguments);
  const resPayload = resultEvent?.payload;
  const runnerErr = typeof resPayload?.runner_error === 'string' ? resPayload.runner_error : null;
  const hasResult = Boolean(resPayload && Object.hasOwn(resPayload, 'result'));
  const resultObj = resPayload?.result;
  const acceptedBadge =
    isSubmit && isPlainObject(resultObj)
      ? resultObj.accepted === true
        ? '<span class="si-step-pill is-ok">已接受</span>'
        : '<span class="si-step-pill is-err">未接受</span>'
      : runnerErr
        ? `<span class="si-step-pill is-err">${esc(runnerErr)}</span>`
        : hasResult
          ? '<span class="si-step-pill is-neutral">已返回</span>'
          : '';

  const resText = runnerErr ? runnerErr : hasResult ? prettyJson(resultObj) : '';
  const longArgs = argsText.length > 520;
  const longRes = resText.length > 520;

  return `<div class="si-tool-card${isSubmit ? ' is-submit' : ''}${runnerErr ? ' is-err' : ''}">
    <div class="si-tool-head">
      <span class="si-tool-badge">${isSubmit ? '提交答案' : '调用工具'}</span>
      <code class="si-tool-name">${esc(name)}</code>
      ${call?.call_id ? `<span class="si-call-id">${esc(call.call_id)}</span>` : ''}
      ${acceptedBadge}
    </div>
    ${
      argsText
        ? longArgs
          ? `<details class="si-tool-block"><summary>参数（${argsText.length} 字符）</summary><pre class="si-trace-code">${esc(argsText)}</pre></details>`
          : `<div class="si-tool-block"><div class="si-tool-block-label">参数</div><pre class="si-trace-code">${esc(argsText)}</pre></div>`
        : ''
    }
    ${
      resText
        ? longRes
          ? `<details class="si-tool-block is-output"><summary>返回结果（${resText.length} 字符）</summary><pre class="si-trace-code">${esc(resText)}</pre></details>`
          : `<div class="si-tool-block is-output"><div class="si-tool-block-label">${runnerErr ? '执行错误' : '返回结果'}</div><pre class="si-trace-code">${esc(resText)}</pre></div>`
        : ''
    }
  </div>`;
}

/**
 * Render the Pi Session Execution Trace tab.
 */
function renderTraceTab({ sample, taskSpec, calls, eventState, selectedAttemptId, esc, helpers, formatDate }) {
  const events = Array.isArray(eventState?.events) ? eventState.events : [];
  const loading = Boolean(eventState?.loading);
  const loadError = typeof eventState?.error === 'string' && eventState.error ? eventState.error : '';

  // Build ordered attempt list from prior sample.attempts + current sample + observed event attempt_ids.
  const attemptMap = new Map();
  const rawAttempts = Array.isArray(sample?.attempts) ? sample.attempts : [];
  rawAttempts.forEach((att, idx) => {
    const id = typeof att?.attempt_id === 'string' && att.attempt_id ? att.attempt_id : `attempt-${idx + 1}`;
    attemptMap.set(id, { id, index: attemptMap.size + 1, meta: att, isCurrent: false, events: [] });
  });
  const currentAttemptId =
    typeof sample?.attempt_id === 'string' && sample.attempt_id
      ? sample.attempt_id
      : rawAttempts.length > 0
        ? `attempt-${rawAttempts.length + 1}`
        : null;
  if (currentAttemptId && !attemptMap.has(currentAttemptId)) {
    attemptMap.set(currentAttemptId, { id: currentAttemptId, index: attemptMap.size + 1, meta: sample, isCurrent: true, events: [] });
  } else if (currentAttemptId && attemptMap.has(currentAttemptId)) {
    attemptMap.get(currentAttemptId).isCurrent = true;
  }
  for (const ev of events) {
    const id = ev.attempt_id || currentAttemptId || 'attempt-1';
    if (!attemptMap.has(id)) {
      attemptMap.set(id, { id, index: attemptMap.size + 1, meta: null, isCurrent: id === currentAttemptId, events: [] });
    }
    attemptMap.get(id).events.push(ev);
  }
  const attemptList = [...attemptMap.values()];
  // Keep the current attempt at the end if an earlier event had a synthetic attempt_id.
  attemptList.sort((a, b) => (a.isCurrent === b.isCurrent ? a.index - b.index : a.isCurrent ? 1 : -1));
  attemptList.forEach((att, idx) => {
    att.index = idx + 1;
  });
  const activeAttempt =
    (selectedAttemptId && attemptMap.get(selectedAttemptId)) ||
    (currentAttemptId && attemptMap.get(currentAttemptId)) ||
    attemptList.at(-1) ||
    null;

  const attemptSwitcher =
    attemptList.length > 1
      ? `<div class="si-attempt-bar" role="tablist" aria-label="历次尝试">${attemptList
          .map((att, idx) => {
            const isLatest = att.isCurrent || idx === attemptList.length - 1;
            const status = att.meta?.status || (isLatest ? sample.status : '');
            const statusLabel =
              status === 'budget_not_admitted' || (Array.isArray(att.meta?.calls) && att.meta.calls.length === 0)
                ? '未发出请求'
                : status === 'completed'
                  ? '完成'
                  : status === 'timeout'
                    ? '超时'
                    : status === 'api_failure'
                      ? '失败'
                      : status === 'interrupted'
                        ? '中断'
                        : status === 'cancelled'
                          ? '取消'
                          : status || `${att.events.length} 事件`;
            return `<button type="button" class="si-pill${att === activeAttempt ? ' is-active' : ''}" data-si-attempt="${esc(att.id)}">第 ${att.index} 次尝试 · ${esc(statusLabel)}${isLatest ? '（最新）' : ''}</button>`;
          })
          .join('')}</div>`
      : '';

  const promptNode = taskSpec?.prompt
    ? `<details class="si-trace-step is-prompt"><summary class="si-trace-head"><span class="si-role-tag is-user">USER</span><span class="si-trace-title">题目输入（Prompt）</span><span class="si-trace-meta">${taskSpec.prompt.length} 字符 · 点击展开</span></summary><div class="si-trace-body"><pre class="si-trace-text">${esc(taskSpec.prompt)}</pre></div></details>`
    : '';

  if (loading && !events.length) {
    return `${attemptSwitcher}<div class="si-trace-timeline">${promptNode}<div class="si-trace-loading">正在加载执行轨迹（Session Events）…</div></div>`;
  }

  const attemptEvents = activeAttempt ? activeAttempt.events : [];
  const viewSample = activeAttempt?.meta || sample;

  // Fallback synthesis when session_events is unavailable (e.g., mocked fixtures or legacy runs without events)
  if (!attemptEvents.length) {
    return `${attemptSwitcher}${loadError ? `<div class="si-inline-alert is-warn">执行事件读取失败（${esc(loadError)}），以下基于样本摘要还原。</div>` : ''}${renderSynthesizedTrace({ sample: viewSample, sampleId: sample.sample_id, attemptId: activeAttempt?.id || null, calls, promptNode, esc, helpers })}`;
  }

  // Pair tool_result events with llm_turn tool_calls by call_id so each tool interaction reads naturally.
  const toolResultByCallId = new Map();
  const pairedEventIds = new Set();
  for (const ev of attemptEvents) {
    if (ev.kind === 'tool_result' && ev.call_id && !toolResultByCallId.has(ev.call_id)) {
      toolResultByCallId.set(ev.call_id, ev);
    }
  }

  const stepNodes = [];
  const isNoSub = helpers.isNoSubmissionSample(viewSample);

  for (const ev of attemptEvents) {
    if (ev.kind === 'llm_turn') {
      const payload = isPlainObject(ev.payload) ? ev.payload : {};
      const turnLabel = ev.turn != null ? `Turn ${ev.turn}` : `调用 #${ev.seq}`;
      const attemptTag =
        ev.api_attempt != null && ev.api_attempt > 1 ? `<span class="si-step-pill is-warn">重试 #${ev.api_attempt}</span>` : '';
      const httpBad = ev.http_status != null && ev.http_status !== 200;
      const httpPill =
        ev.http_status != null
          ? `<span class="si-step-pill ${httpBad ? 'is-err' : 'is-ok'}">HTTP ${ev.http_status}</span>`
          : ev.local_exception
            ? `<span class="si-step-pill is-err">${esc(ev.local_exception)}</span>`
            : '';
      const termBadge =
        ev.response_status && ev.response_status !== 'completed'
          ? `<span class="si-step-pill is-warn">${esc(ev.response_status)}</span>`
          : ev.termination && ev.termination !== 'completed'
            ? `<span class="si-step-pill is-warn">${esc(ev.termination)}</span>`
            : '';
      const metaBits = [
        ev.elapsed_seconds != null ? `耗时 ${formatDuration(ev.elapsed_seconds)}` : '',
        ev.first_output_seconds != null ? `首字 ${ev.first_output_seconds.toFixed(1)}s` : '',
        ev.usage_known && ev.input_tokens != null && ev.output_tokens != null
          ? `入 ${formatShortInt(ev.input_tokens)} / 出 ${formatShortInt(ev.output_tokens)}`
          : ev.usage_known === false
            ? '用量未知'
            : '',
        ev.estimated_cost_usd != null ? formatCostUsd(ev.estimated_cost_usd) : ''
      ].filter(Boolean);

      const reasoningList = Array.isArray(payload.reasoning_summary) ? payload.reasoning_summary.filter(Boolean) : [];
      const reasoningHtml = reasoningList.length
        ? `<details class="si-trace-reasoning"><summary>思考摘要（${reasoningList.length} 段）</summary><div class="si-trace-reasoning-body">${reasoningList
            .map(part => `<p>${esc(part)}</p>`)
            .join('')}</div></details>`
        : '';

      const textVal = typeof payload.assistant_text === 'string' ? payload.assistant_text : '';
      const textHtml = textVal
        ? `<div class="si-trace-text-wrap">${isNoSub ? '<div class="si-trace-subnote is-warn">模型输出了可见正文，但未调用 submit_answer 工具</div>' : ''}<pre class="si-trace-text">${esc(textVal)}</pre></div>`
        : '';

      const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
      const toolsHtml = toolCalls.length
        ? `<div class="si-tool-list">${toolCalls
            .map(call => {
              const paired = call?.call_id ? toolResultByCallId.get(call.call_id) : null;
              if (paired) pairedEventIds.add(paired.id);
              return renderToolCallCard(call, paired, esc);
            })
            .join('')}</div>`
        : '';

      const errParts = [
        ev.error_code ? `错误码：${ev.error_code}` : '',
        ev.error_message ? ev.error_message : '',
        ev.local_exception ? `本地异常：${ev.local_exception}` : '',
        ev.terminal_event && ev.terminal_event !== 'response.completed' ? `终结事件：${ev.terminal_event}` : ''
      ].filter(Boolean);
      const rawExcerpt = typeof payload.raw_error_excerpt === 'string' && payload.raw_error_excerpt ? payload.raw_error_excerpt : '';
      const errHtml =
        errParts.length || rawExcerpt
          ? `<div class="si-trace-error">${errParts.length ? `<div class="si-trace-error-line">${esc(errParts.join(' · '))}</div>` : ''}${rawExcerpt ? `<pre class="si-trace-code">${esc(rawExcerpt)}</pre>` : ''}</div>`
          : '';

      const hasBody = Boolean(reasoningHtml || textHtml || toolsHtml || errHtml);
      const emptyNote = !hasBody ? '<div class="si-trace-empty">本轮无可见正文或工具调用</div>' : '';

      stepNodes.push(`<div class="si-trace-step is-assistant${httpBad || ev.local_exception || errParts.length ? ' is-fault' : ''}">
        <div class="si-trace-head">
          <span class="si-role-tag is-assistant">ASSISTANT</span>
          <strong class="si-trace-title">${esc(turnLabel)}</strong>
          ${attemptTag}${httpPill}${termBadge}
          <span class="si-trace-meta">${esc(metaBits.join(' · '))}</span>
        </div>
        <div class="si-trace-body">${reasoningHtml}${textHtml}${toolsHtml}${errHtml}${emptyNote}</div>
      </div>`);
    } else if (ev.kind === 'tool_result') {
      if (pairedEventIds.has(ev.id)) continue;
      stepNodes.push(`<div class="si-trace-step is-tool"><div class="si-trace-body">${renderToolCallCard(null, ev, esc)}</div></div>`);
    } else if (ev.kind === 'api_retry') {
      const delayMs = isPlainObject(ev.payload) ? Number(ev.payload.delay_ms) : NaN;
      const delayText = Number.isFinite(delayMs) ? `${(delayMs / 1000).toFixed(1)}s` : '';
      stepNodes.push(
        `<div class="si-trace-retry"><span class="si-retry-dot" aria-hidden="true">↻</span>Turn ${esc(ev.turn ?? '?')} 触发瞬时重试${delayText ? ` · 退避 ${esc(delayText)}` : ''} → 第 ${esc(ev.api_attempt ?? '?')} 次请求</div>`
      );
    } else if (ev.kind === 'worker_error') {
      const err = isPlainObject(ev.payload) ? ev.payload.runner_error : 'WorkerError';
      stepNodes.push(
        `<div class="si-trace-step is-fault"><div class="si-trace-head"><span class="si-role-tag is-err">ERROR</span><strong class="si-trace-title">Worker 异常</strong></div><div class="si-trace-body"><div class="si-trace-error">${esc(String(err || 'Error'))}</div></div></div>`
      );
    } else if (ev.kind === 'grade') {
      const payload = isPlainObject(ev.payload) ? ev.payload : {};
      const scoreVal =
        typeof payload.content_score === 'number' && Number.isFinite(payload.content_score)
          ? Number(payload.content_score.toFixed(3))
          : null;
      const statusStr = String(payload.status || sample.status || '');
      const outcomeStr = payload.outcome ? ` · ${payload.outcome}` : '';
      const scoreStr = scoreVal !== null ? ` · 得分 ${scoreVal}` : '';
      const runnerErr = payload.runner_error ? ` · ${payload.runner_error}` : '';
      stepNodes.push(
        `<div class="si-trace-grade"><span class="si-role-tag is-grade">GRADE</span><span>状态 <strong>${esc(statusStr)}</strong>${esc(outcomeStr)}${esc(scoreStr)}${esc(runnerErr)}</span><span class="si-trace-meta">${ev.elapsed_seconds != null ? `总耗时 ${formatDuration(ev.elapsed_seconds)}` : ''}${ev.estimated_cost_usd != null ? ` · ${formatCostUsd(ev.estimated_cost_usd)}` : ''}</span></div>`
      );
    }
  }

  return `${attemptSwitcher}<div class="si-trace-timeline">${promptNode}${stepNodes.join('')}</div>`;
}

/**
 * Fallback trace view when session_events rows are absent (e.g. mocked tests or legacy records).
 */
function renderSynthesizedTrace({ sample, sampleId, attemptId, calls, promptNode, esc, helpers }) {
  const nodes = [];
  const targetSampleId = sampleId || sample?.sample_id;
  const sampleCalls =
    calls instanceof Map
      ? [...calls.values()].filter(
          call => call.sample_id === targetSampleId && (!attemptId || !call.attempt_id || call.attempt_id === attemptId)
        )
      : [];
  const toolTrace = Array.isArray(sample?.tool_trace) ? sample.tool_trace : [];
  const textVal =
    typeof sample?.text === 'string' && sample.text ? sample.text : typeof sample?.response === 'string' ? sample.response : '';
  const hasAnswerSub = isPlainObject(sample?.answer_submission);
  const runnerErr = typeof sample?.runner_error === 'string' && sample.runner_error ? sample.runner_error : '';

  if (sampleCalls.length) {
    for (const call of sampleCalls) {
      const bad = (call.http_status != null && call.http_status !== 200) || Boolean(call.local_exception) || Boolean(call.error_code);
      const bits = [
        call.elapsed_seconds != null ? `耗时 ${formatDuration(call.elapsed_seconds)}` : '',
        call.first_output_seconds != null ? `首字 ${call.first_output_seconds.toFixed(1)}s` : '',
        call.http_status != null ? `HTTP ${call.http_status}` : '',
        call.response_status && call.response_status !== 'completed' ? call.response_status : '',
        call.local_exception || call.error_code || ''
      ].filter(Boolean);
      nodes.push(
        `<div class="si-trace-step is-assistant${bad ? ' is-fault' : ''}"><div class="si-trace-head"><span class="si-role-tag is-assistant">CALL</span><strong class="si-trace-title">Turn ${esc(call.turn ?? 1)}${call.api_attempt > 1 ? ` · 重试 #${call.api_attempt}` : ''}</strong><span class="si-trace-meta">${esc(bits.join(' · '))}</span></div>${call.error_message ? `<div class="si-trace-body"><div class="si-trace-error">${esc(call.error_message)}</div></div>` : ''}</div>`
      );
    }
  }

  if (textVal) {
    nodes.push(
      `<div class="si-trace-step is-assistant"><div class="si-trace-head"><span class="si-role-tag is-assistant">ASSISTANT</span><strong class="si-trace-title">模型可见回答</strong>${helpers.isNoSubmissionSample(sample) ? '<span class="si-step-pill is-warn">未调用 submit_answer</span>' : ''}</div><div class="si-trace-body"><pre class="si-trace-text">${esc(textVal)}</pre></div></div>`
    );
  }

  if (toolTrace.length) {
    nodes.push(
      `<div class="si-trace-step is-tool"><div class="si-trace-head"><span class="si-role-tag is-tool">TOOLS</span><strong class="si-trace-title">工具交互记录（${toolTrace.length} 步）</strong></div><div class="si-trace-body"><div class="si-tool-list">${toolTrace
        .map(step => renderToolCallCard({ call_id: step.call_id, name: step.name, arguments: step.arguments }, { payload: step }, esc))
        .join('')}</div></div></div>`
    );
  } else if (hasAnswerSub) {
    nodes.push(
      `<div class="si-trace-step is-tool"><div class="si-trace-body">${renderToolCallCard({ call_id: sample.answer_submission.call_id, name: 'submit_answer', arguments: sample.answer_submission.answer }, { payload: { name: 'submit_answer', result: { accepted: true } } }, esc)}</div></div>`
    );
  }

  if (runnerErr) {
    nodes.push(
      `<div class="si-trace-step is-fault"><div class="si-trace-head"><span class="si-role-tag is-err">ERROR</span><strong class="si-trace-title">执行异常</strong></div><div class="si-trace-body"><div class="si-trace-error">${esc(runnerErr)}</div></div></div>`
    );
  }

  if (!nodes.length) {
    nodes.push('<div class="si-trace-empty">该样本暂无执行轨迹事件（可能是尚未开始、未记录事件的旧运行，或请求尚未发出）。</div>');
  }

  return `<div class="si-trace-timeline">${promptNode}${nodes.join('')}</div>`;
}

/**
 * Render the 3-round Field × Round comparison table.
 */
function renderCompareTab({ taskId, roundSamples, taskSpec, esc, helpers }) {
  const expected = isPlainObject(taskSpec?.expected) ? taskSpec.expected : null;
  const allKeysSet = new Set();
  for (const s of roundSamples) {
    if (isPlainObject(s?.grade?.content_checks)) {
      for (const k of Object.keys(s.grade.content_checks)) allKeysSet.add(k);
    }
  }
  if (!allKeysSet.size && expected) {
    for (const k of Object.keys(expected)) allKeysSet.add(k);
  }
  const allKeys = [...allKeysSet];
  // Sort keys that failed in at least one round first.
  allKeys.sort((a, b) => {
    const aFail = roundSamples.some(s => s?.grade?.content_checks?.[a] === false) ? 0 : 1;
    const bFail = roundSamples.some(s => s?.grade?.content_checks?.[b] === false) ? 0 : 1;
    return aFail - bFail;
  });

  const headCols = roundSamples
    .map(s => {
      const label = helpers.shortCellLabel(s);
      return `<th><button type="button" class="si-cmp-round-btn" data-si-switch-sample="${esc(s.sample_id)}">第 ${esc(s.round)} 轮 · <strong>${esc(label)}</strong></button></th>`;
    })
    .join('');

  const summaryRows = [
    `<tr><td class="si-col-field">耗时</td>${roundSamples.map(s => `<td class="si-cmp-meta">${esc(formatDuration(s.elapsed_seconds))}</td>`).join('')}</tr>`,
    `<tr><td class="si-col-field">Tokens</td>${roundSamples.map(s => `<td class="si-cmp-meta">${esc(formatTokensSummary(s.usage))}</td>`).join('')}</tr>`,
    `<tr><td class="si-col-field">费用</td>${roundSamples.map(s => `<td class="si-cmp-meta">${esc(formatCostUsd(s.estimated_uncached_cost_usd))}</td>`).join('')}</tr>`
  ].join('');

  const fieldRows = allKeys
    .map(key => {
      const anyFail = roundSamples.some(s => s?.grade?.content_checks?.[key] === false);
      const cells = roundSamples
        .map(s => {
          const pass = s?.grade?.content_checks?.[key];
          const ans = extractModelAnswer(s);
          const got = ans && Object.hasOwn(ans, key) ? ans[key] : undefined;
          if (pass === true) {
            return `<td class="si-cmp-cell is-ok" title="${esc(formatScalar(got))}"><span class="si-mark is-ok">✓</span></td>`;
          }
          if (pass === false) {
            const snippet = got !== undefined ? formatCompactValue(got, 26) : '缺失';
            return `<td class="si-cmp-cell is-fail" title="${esc(formatScalar(got))}"><span class="si-mark is-fail">✗</span> <span class="si-cmp-val">${esc(snippet)}</span></td>`;
          }
          const fallback = helpers.isNoSubmissionSample(s)
            ? '未提交'
            : s.status === 'timeout'
              ? '超时'
              : s.status !== 'completed'
                ? '未完成'
                : '—';
          return `<td class="si-cmp-cell is-muted">${esc(fallback)}</td>`;
        })
        .join('');
      return `<tr class="${anyFail ? 'is-fail' : ''}"><td class="si-col-field"><code>${esc(key)}</code></td>${cells}</tr>`;
    })
    .join('');

  return `<div class="si-diff-wrap"><table class="si-diff-table si-cmp-table"><thead><tr><th class="si-col-field">${esc(splitTaskId(taskId).code || '项目')}</th>${headCols}</tr></thead><tbody>${summaryRows}${fieldRows}</tbody></table></div>`;
}

/**
 * Render the Raw Evidence JSON tab.
 */
function renderRawTab({ sample, eventState, registerLazyJson, esc }) {
  const blocks = [
    ['答案提交记录', sample.answer_submission],
    ['原始回答', sample.text || sample.response || sample.raw_response],
    ['评分结果', sample.grade],
    ['Tool trace', sample.tool_trace],
    [
      '用量与费用',
      {
        usage: sample.usage ?? null,
        estimated_uncached_cost_usd: sample.estimated_uncached_cost_usd ?? null,
        latest_attempt_usage: sample.latest_attempt_usage ?? null,
        latest_attempt_cost_usd: sample.latest_attempt_cost_usd ?? null
      }
    ],
    ['历次尝试（原始记录）', sample.attempts],
    ['执行事件（Session Events）', Array.isArray(eventState?.events) && eventState.events.length ? eventState.events : null],
    ['完整样本证据', sample]
  ];
  return `<div class="si-raw-list">${blocks
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => registerLazyJson(label, value))
    .join('')}</div>`;
}

/**
 * Main entry: render the complete inline inspector panel mounted below a matrix task row.
 * @param {any} options
 */
export function renderInlineSampleInspector({
  run,
  sample,
  roundSamples,
  taskSpec,
  calls,
  eventState,
  uiState,
  esc,
  helpers,
  formatDate,
  registerLazyJson
}) {
  const activeTab = uiState.tab || defaultInspectorTab(sample, taskSpec, helpers);
  const showAllFields = Boolean(uiState.showAllFields);
  const showPrompt = Boolean(uiState.showPrompt);
  const selectedAttemptId = uiState.attemptId || null;

  // Header: round pills + multi-round compare + close button
  const roundPills = roundSamples
    .map(s => {
      const active = activeTab !== 'compare' && s.sample_id === sample.sample_id;
      return `<button type="button" class="si-round-pill${active ? ' is-active' : ''}" data-si-switch-sample="${esc(s.sample_id)}">第 ${esc(s.round)} 轮 · ${esc(helpers.shortCellLabel(s))}</button>`;
    })
    .join('');
  const compareBtn =
    roundSamples.length > 1
      ? `<span class="si-head-sep" aria-hidden="true">|</span><button type="button" class="si-round-pill${activeTab === 'compare' ? ' is-active' : ''}" data-si-tab="compare">多轮对照</button>`
      : '';

  // Context line: domain + title + prompt toggle
  const domainKey = (taskSpec?.domain || sample?.domain || '').toLowerCase();
  const domainLabel = DOMAIN_LABELS[domainKey] || (domainKey ? domainKey.toUpperCase() : '');
  const titleText = taskSpec?.title || splitTaskId(sample.task).name || sample.task;
  const promptToggle = taskSpec?.prompt
    ? `<button type="button" class="si-link-btn" data-si-toggle-prompt>${showPrompt ? '收起原题' : '查看原题'}</button>`
    : '';
  const promptDrawer =
    showPrompt && taskSpec?.prompt ? `<div class="si-prompt-drawer"><pre class="si-trace-text">${esc(taskSpec.prompt)}</pre></div>` : '';

  // Compact single-line metrics strip
  const checks = isPlainObject(sample?.grade?.content_checks) ? sample.grade.content_checks : {};
  const totalChecks = Object.keys(checks).length;
  const passChecks = Object.values(checks).filter(v => v === true).length;
  const failChecks = Object.values(checks).filter(v => v === false).length;
  const scoreDisplay = helpers.validScore(sample)
    ? `${Number(sample.grade.content_score.toFixed(2))}${totalChecks ? ` (${passChecks}/${totalChecks})` : ''}`
    : helpers.shortCellLabel(sample);
  const reqCount = sample.api_request_count ?? (Array.isArray(sample.calls) ? sample.calls.length : null);
  const metaStrip = `<div class="si-meta-strip">
    <span>得分 <strong>${esc(scoreDisplay)}</strong></span>
    <span>耗时 <strong>${esc(formatDuration(sample.elapsed_seconds))}</strong>${reqCount != null ? ` (${esc(reqCount)} 次请求)` : ''}</span>
    <span>Tokens <strong>${esc(formatTokensSummary(sample.usage))}</strong></span>
    <span>费用 <strong>${esc(formatCostUsd(sample.estimated_uncached_cost_usd))}</strong></span>
    ${renderProtocolSummary(sample, esc)}
  </div>`;

  // Conditional diagnostic banner (only when something is abnormal or failed)
  const diagNotes = helpers.sampleDiagnosticBanner(sample, calls, run.plan?.limits?.timeout);
  const diagHtml = diagNotes
    ? `<div class="si-diag-banner is-${diagNotes.tone}" role="note"><strong>${esc(diagNotes.title)}：</strong>${esc(diagNotes.body)}</div>`
    : '';

  // Tab bar (hidden when in compare mode; compare mode shows its own clean subheader)
  const eventCount = Array.isArray(eventState?.events)
    ? eventState.events.filter(e => e.kind === 'llm_turn' || e.kind === 'tool_result').length
    : null;
  const tabsHtml =
    activeTab === 'compare'
      ? ''
      : `<div class="si-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="${activeTab === 'grading' ? 'true' : 'false'}" class="si-tab${activeTab === 'grading' ? ' is-active' : ''}" data-si-tab="grading">判分对照${failChecks > 0 ? `<span class="si-tab-badge is-err">${failChecks} 错</span>` : totalChecks > 0 && passChecks === totalChecks ? '<span class="si-tab-badge is-ok">全对</span>' : ''}</button>
          <button type="button" role="tab" aria-selected="${activeTab === 'trace' ? 'true' : 'false'}" class="si-tab${activeTab === 'trace' ? ' is-active' : ''}" data-si-tab="trace">执行轨迹${eventCount ? `<span class="si-tab-badge">${eventCount}</span>` : eventState?.loading ? '<span class="si-tab-badge">…</span>' : ''}</button>
          <button type="button" role="tab" aria-selected="${activeTab === 'raw' ? 'true' : 'false'}" class="si-tab${activeTab === 'raw' ? ' is-active' : ''}" data-si-tab="raw">原始证据 <span class="si-tab-muted">JSON</span></button>
        </div>`;

  let bodyHtml = '';
  if (activeTab === 'compare') {
    bodyHtml = renderCompareTab({ taskId: sample.task, roundSamples, taskSpec, esc, helpers });
  } else if (activeTab === 'grading') {
    bodyHtml = renderGradingTab({ sample, taskSpec, showAllFields, esc, helpers });
  } else if (activeTab === 'raw') {
    bodyHtml = renderRawTab({ sample, eventState, registerLazyJson, esc });
  } else {
    bodyHtml = renderTraceTab({ sample, taskSpec, calls, eventState, selectedAttemptId, esc, helpers, formatDate });
  }

  return `<div class="sample-inline-inspector" data-inspector-sample="${esc(sample.sample_id)}" role="region" aria-label="${esc(`${sample.task} 第 ${sample.round} 轮样本详情`)}">
    <div class="si-head">
      <div class="si-head-rounds">${roundPills}${compareBtn}</div>
      <button type="button" class="si-close-btn" data-si-close>收起</button>
    </div>
    <div class="si-context">
      <div class="si-context-title-row">
        <div class="si-context-title">${domainLabel ? `<span class="si-domain-tag">${esc(domainLabel)}</span>` : ''}<span>${esc(titleText)}</span></div>
        ${promptToggle}
      </div>
      ${promptDrawer}
      ${activeTab === 'compare' ? '' : metaStrip}
    </div>
    ${activeTab === 'compare' ? '' : diagHtml}
    ${tabsHtml}
    <div class="si-body">${bodyHtml}</div>
  </div>`;
}
