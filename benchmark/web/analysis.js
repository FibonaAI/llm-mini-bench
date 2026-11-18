import { selectionKey, thinkingLabel } from './data-picker.js';
import { createAnalysisFilters } from './analysis-filters.js';
import { getAppContext } from './app-context.js';
import { createAnalysisModel, attachAnalysisBatchIds } from './analysis-model.js';
import { selectAnalysisHistoryRecords } from './analysis-history.js';
import { createAnalysisPopover } from './analysis-popover.js';
import { renderAnalysisRecordList } from './analysis-record-list.js';
import { createScoreCostChart } from './score-cost-chart.js';
import { observationQualitySummary } from './assessment-chart-metric.js';

const app = getAppContext();
const { byId: element, escapeHtml, finite, request, notify, available, statusText, formatDate } = app.services;
const state = {
  observations: [],
  observationsEtag: null,
  records: [],
  dataMode: 'latest',
  historyIds: new Set(),
  disclosure: null,
  selectedId: null,
  loading: false,
  evidence: new Map(),
  evidenceLoading: new Set(),
  promoting: new Set()
};
const filters = createAnalysisFilters(element('analysis-picker'), { onChange: renderObservations });
const model = createAnalysisModel();
model.setBank(app.bank);
let inspectorInputs = null;
const chart = createScoreCostChart(element('score-cost-chart'), { onSelect: selectObservation });
const dataPopover = createAnalysisPopover(element('analysis-data-trigger'), element('analysis-data-panel'));
const settingsPopover = createAnalysisPopover(element('chart-settings-trigger'), element('chart-settings-panel'), { width: 280 });
const resultPopovers = Object.fromEntries(
  ['results', 'excluded'].map(kind => [
    kind,
    createAnalysisPopover(element(kind === 'results' ? 'analysis-result-count' : 'analysis-excluded-count'), element(`analysis-${kind}`), {
      width: 440,
      maxHeight: 360,
      onDismiss: () => {
        if (state.disclosure === kind) {
          state.disclosure = null;
          renderObservations();
        }
      }
    })
  ])
);
const scoreText = score => (finite(score) ? String(Number(score.toFixed(3))) : '未评分');
const numberText = value => (finite(value) ? value.toLocaleString('zh-CN') : '未记录');
const sourceText = record => (record.source === 'baseline' ? '基线' : '我的运行');
const recordLabel = record => `${record.model || record.label || record.target_id} · ${record.thinking || 'unknown'}`;
const sampleChip = sample => {
  const scored = sample.status === 'completed' && finite(sample.content_score);
  const tone = !scored
    ? sample.status === 'completed'
      ? 'unscored'
      : 'failed'
    : sample.content_score >= 1
      ? 'full'
      : sample.content_score > 0
        ? 'partial'
        : 'zero';
  const label = scored
    ? sample.outcome === 'no_submission'
      ? '未交'
      : String(Number(sample.content_score.toFixed(2)))
    : sample.status === 'completed'
      ? sample.outcome === 'ambiguous'
        ? '歧义'
        : '无分'
      : '失败';
  return `<span class="sample-chip is-${tone}" title="第 ${escapeHtml(sample.round ?? '?')} 轮 · ${escapeHtml(statusText(sample.status))}${sample.outcome ? ' · ' + escapeHtml(sample.outcome) : ''}">${escapeHtml(label)}</span>`;
};
const rawBlock = (title, data) =>
  `<details class="raw-block"><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;

function chartExclusionReason(record) {
  return record.exclusionReason || (element('log-axis').checked && record.cost === 0 ? '零用量无法显示在对数轴；切换线性刻度可见' : null);
}

/** Optionally place usage-incomplete records at their known lower bound; strict metrics stay untouched. */
function presentedRecords() {
  const lowerBound = element('usage-lower-bound').checked;
  return attachAnalysisBatchIds(model.records(element('chart-axis').value), app.getTaskId).map(record =>
    lowerBound && finite(record.score) && !finite(record.cost) && record.usageLowerBound
      ? {
          ...record,
          cost: record.usageLowerBound.cost,
          usageIncomplete: record.usageLowerBound,
          strictExclusionReason: record.exclusionReason,
          exclusionReason: null
        }
      : record
  );
}

function rebuildAnalysisRecords() {
  model.setObservations(state.observations);
  state.records = presentedRecords();
  chart.registerCatalog(state.records);
  rebuildHistoryFilterScope();
  renderObservations();
}

function rebuildHistoryFilterScope() {
  filters.setRecords(selectAnalysisHistoryRecords(state.records, historyOptions(state.dataMode === 'selected' ? 'all' : state.dataMode)));
}

function historyOptions(mode = state.dataMode) {
  return { mode, from: element('analysis-date-from').value, to: element('analysis-date-to').value, selectedIds: state.historyIds };
}

function matchingRecords() {
  return selectAnalysisHistoryRecords(state.records, historyOptions()).filter(filters.matches);
}

let historyPickerInputs = null;
function renderHistoryPicker() {
  const historical = state.dataMode !== 'latest';
  const label = { latest: '最新', all: '全部历史', selected: '指定记录' }[state.dataMode];
  element('analysis-data-trigger').textContent = `数据 · ${label}`;
  element('analysis-data-trigger').dataset.filtered = String(historical);
  element('analysis-date-range').hidden = !historical;
  element('analysis-history-picker').hidden = state.dataMode !== 'selected';
  element('analysis-data-hint').textContent =
    state.dataMode === 'latest'
      ? '同渠道、账号、模型和 Thinking 仅显示最新；未完成不回退。基线单独选取，时间未知的记录保留。'
      : state.dataMode === 'all'
        ? '显示全部评测记录（含最新），可按本地日期缩小范围。'
        : '勾选要对照的评测记录；筛选与日期范围同时生效。';
  if (state.dataMode !== 'selected') return;
  const candidates = selectAnalysisHistoryRecords(state.records, historyOptions('all')).filter(filters.matches);
  const key = JSON.stringify(
    candidates.map(record => [
      record.id,
      record.created_at,
      record.modelDisplayName,
      record.model,
      record.think,
      record.providerName,
      record.provider,
      record.account,
      record.source
    ])
  );
  const inputs = [key];
  element('analysis-history-count').textContent =
    `已选 ${candidates.filter(record => state.historyIds.has(record.id)).length} / ${candidates.length} 条`;
  if (historyPickerInputs && inputs.every((value, index) => value === historyPickerInputs[index])) {
    element('analysis-history-options')
      .querySelectorAll('[data-history-record]')
      .forEach(input => {
        input.checked = state.historyIds.has(input.dataset.historyRecord);
      });
    return;
  }
  historyPickerInputs = inputs;
  element('analysis-history-options').innerHTML = candidates.length
    ? candidates
        .map(
          record =>
            `<label class="analysis-history-option"><input type="checkbox" data-history-record="${escapeHtml(record.id)}" ${state.historyIds.has(record.id) ? 'checked' : ''}><span><strong>${escapeHtml(record.modelDisplayName || record.model)} · ${escapeHtml(thinkingLabel(record.think))}</strong><span>${escapeHtml(formatDate(record.created_at))} · ${escapeHtml(record.providerName || record.provider)} / ${escapeHtml(record.account)}</span><small>${escapeHtml(record.id)} · ${sourceText(record)}</small></span></label>`
        )
        .join('')
    : '<p class="field-hint">没有匹配的历史记录，请调整筛选或日期范围。</p>';
}

function renderResultDisclosure(records) {
  const excluded = records.filter(record => chartExclusionReason(record));
  if (state.disclosure === 'excluded' && !excluded.length) state.disclosure = null;
  for (const kind of ['results', 'excluded']) {
    const open = state.disclosure === kind;
    resultPopovers[kind].setOpen(open, { focus: true });
    element(kind === 'results' ? 'analysis-result-count' : 'analysis-excluded-count').setAttribute('aria-expanded', String(open));
    if (!open) continue;
    const scope = kind === 'results' ? records : excluded;
    element(`analysis-${kind}-content`).innerHTML = renderAnalysisRecordList(scope, {
      axis: element('chart-axis').value,
      exclusionReason: chartExclusionReason,
      escapeHtml,
      formatDate
    });
    resultPopovers[kind].position();
  }
}

function renderObservationDetails() {
  const mapped = matchingRecords().find(record => record.id === state.selectedId);
  const record = mapped?.original;
  element('model-inspector').hidden = !record;
  if (!record) {
    inspectorInputs = null;
    return;
  }
  const inputs = [
    record,
    mapped.score,
    mapped.cost,
    chartExclusionReason(mapped),
    element('chart-axis').value,
    state.evidence.get(record.id),
    state.evidenceLoading.has(record.id),
    state.promoting.has(record.id)
  ];
  if (inspectorInputs && inputs.every((value, index) => value === inspectorInputs[index])) return;
  inspectorInputs = inputs;
  element('inspector-title').textContent = recordLabel(record);
  element('inspector-identity').textContent = `${sourceText(record)} · ${record.id} · ${formatDate(record.created_at)}`;
  const samples = (record.tasks || []).flatMap(task => task.samples || []);
  const completed = samples.filter(sample => sample.status === 'completed').length;
  const quality = observationQualitySummary(record, { includeUsage: false });
  const tokens = element('chart-axis').value === 'tokens';
  const accounting = record.usage_accounting;
  const usageText = finite(record.estimated_cost_usd)
    ? '$' + record.estimated_cost_usd.toFixed(4)
    : finite(accounting?.estimated_cost_usd_lower_bound)
      ? `≥ $${accounting.estimated_cost_usd_lower_bound.toFixed(4)}（${accounting.unknown_cost_attempts} 次尝试未返回用量）`
      : '未记录';
  const tokenText = record.usage
    ? `${numberText(record.usage.input_tokens)} / ${numberText(record.usage.output_tokens)}`
    : accounting?.usage_lower_bound
      ? `≥ ${numberText(accounting.usage_lower_bound.input_tokens)} / ≥ ${numberText(accounting.usage_lower_bound.output_tokens)}`
      : '未记录';
  const fact = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  const headline = finite(mapped.score)
    ? `<strong class="inspector-score">${mapped.score.toFixed(1)}</strong><span>/ 100 · ${finite(mapped.cost) ? `每轮${tokens ? ' ' + (mapped.usageIncomplete ? '≥ ' : '') + numberText(Math.round(mapped.cost)) + ' tokens' : '费用 ' + (mapped.usageIncomplete ? '≥ ' : '') + '$' + mapped.cost.toFixed(4)}` : '用量不完整'}</span>`
    : '<strong class="inspector-score">—</strong><span>无完整均分</span>';
  element('inspector-content').innerHTML = `
    <div class="inspector-headline">${headline}</div>
    ${chartExclusionReason(mapped) ? `<p class="inspector-warning">未入图：${escapeHtml(chartExclusionReason(mapped))}</p>` : mapped.usageIncomplete ? `<p class="inspector-warning">用量不完整：${mapped.usageIncomplete.unknownAttempts} 次请求尝试未返回用量，图中按已知下限绘制，不参与前沿。</p>` : ''}
    ${quality.text && !chartExclusionReason(mapped) ? `<p class="field-hint">${escapeHtml(quality.text)}</p>` : ''}
    <dl class="inspector-facts">${[
      fact(
        '状态',
        `${escapeHtml(statusText(record.status))} · ${escapeHtml(record.rounds ?? '?')} 轮 · ${completed}/${escapeHtml((record.tasks || []).length * (record.rounds || 0))} 样本完成`
      ),
      fact('渠道 / 账号', `${escapeHtml(mapped.providerName || mapped.provider)} / ${escapeHtml(mapped.account)}`),
      fact('累计估算费用', `${escapeHtml(usageText)}<small>估算，非账单</small>`),
      fact('输入 / 输出 tokens', escapeHtml(tokenText)),
      fact(
        '路由',
        `${escapeHtml(record.route_id || '未记录')}<small>${escapeHtml(record.provider_id || '渠道未记录')} · ${escapeHtml(record.account_ref || '账号引用未记录')} · ${escapeHtml(record.account_evidence || '无绑定证据')}</small>`
      ),
      fact('基线资格', record.baseline_eligible ? '合格' : `不合格<small>${escapeHtml(record.ineligibility_reason || '')}</small>`)
    ].join('')}</dl>
    <div class="inspector-actions"><button class="btn" type="button" data-copy-observation="${escapeHtml(record.id)}">带入任务配置</button>${record.source === 'run' ? `<button class="btn" type="button" data-open-run="${escapeHtml(record.run_id)}">查看任务</button><button class="btn" type="button" data-promote-id="${escapeHtml(record.id)}" ${record.baseline_eligible && !state.promoting.has(record.id) ? '' : 'disabled'} title="${escapeHtml(record.ineligibility_reason || '保存该目标为基线')}">${state.promoting.has(record.id) ? '保存中…' : '设为基线'}</button>` : '<span class="field-hint">已保存基线</span>'}</div>
    <p class="field-hint">以下内容分保持每题原始 0–1 刻度；指令检查、工具检查与执行状态独立展示，缺失或失败不计为零。</p>
    ${(record.tasks || []).map(task => `<details class="run-item"><summary><span>${escapeHtml(task.task_id)} · ${escapeHtml(task.title)}</span><span class="sample-chips">${(task.samples || []).map(sampleChip).join('')}</span></summary><div class="run-item-body"><p class="field-hint">${escapeHtml(task.domain || '未标注领域')}</p>${(task.samples || []).length ? (task.samples || []).map(sample => `<section class="sample-detail"><h4>第 ${escapeHtml(sample.round ?? '未知')} 轮 · ${escapeHtml(statusText(sample.status))}</h4><p>内容分：${scoreText(sample.content_score)}</p>${rawBlock('指令检查（独立报告）', sample.instruction_checks ?? null)}${rawBlock('工具检查 / Outcome（独立报告）', { tool_checks: sample.tool_checks ?? null, outcome: sample.outcome ?? null })}${rawBlock('该轮观察记录', sample)}</section>`).join('') : '<p class="field-hint">尚无样本；未评分。</p>'}</div></details>`).join('')}
    ${rawBlock('题库与执行协议校验信息', { bank_version: record.bank_version, task_sha256: record.task_sha256, source_sha256: record.source_sha256, assessment_protocol_sha256: record.assessment_protocol_sha256, implementation: record.implementation })}
    ${rawBlock('完整观察记录', record)}
    <div class="raw-evidence"><button class="btn" type="button" data-load-evidence="${escapeHtml(record.id)}" ${state.evidenceLoading.has(record.id) ? 'disabled' : ''}>${state.evidenceLoading.has(record.id) ? '读取证据中…' : '读取原始样本与调用证据'}</button><p class="field-hint">只读取已有记录，不发送模型请求。展示存储中保留的原始回答、失败尝试与工具轨迹；未保存的字段不补造。</p>${state.evidence.has(record.id) ? rawBlock('原始目标证据（含所有已保存样本）', state.evidence.get(record.id)) : ''}</div>`;
}

function renderObservations() {
  const records = matchingRecords();
  if (!records.some(record => record.id === state.selectedId)) state.selectedId = null;
  const log = element('log-axis').checked;
  const plotted = records.filter(
    record =>
      finite(record.score) && record.score >= 0 && record.score <= 100 && finite(record.cost) && (log ? record.cost > 0 : record.cost >= 0)
  ).length;
  renderHistoryPicker();
  const modeLabel = { latest: '最新数据', all: '全部历史', selected: '指定记录' }[state.dataMode];
  element('analysis-result-count').textContent = `${modeLabel} ${records.length} / ${state.records.length} 条记录`;
  element('analysis-plotted-count').textContent = `${plotted} 个数据点`;
  element('analysis-excluded-count').textContent = `${records.length - plotted} 个未入图`;
  element('analysis-excluded-count').hidden = records.length === plotted;
  element('analysis-count-status').textContent =
    `${modeLabel}，${records.length} 条匹配记录，${plotted} 个数据点，${records.length - plotted} 个未入图`;
  renderResultDisclosure(records);
  element('dataset-summary').textContent =
    `Mini Bench · ${state.observations.filter(record => record.source === 'baseline').length} 份基线 · ${state.observations.filter(record => record.source === 'run').length} 个运行目标`;
  const colorDescription = {
    series: '颜色区分供应商-模型组合（保留账号区分）',
    model: '颜色区分模型，同名模型跨供应商同色',
    family: '颜色区分模型系列（按记录名称识别，未识别的模型单独着色，不代表实际服务身份）',
    time: '颜色按记录的评测时间区分本地日期，使用多色调色板；日期颜色在全部已加载记录中固定，时间未记录用中性色'
  }[element('chart-color-by').value];
  element('analysis-method').textContent =
    `均分 = 完整 ${app.taskCount || '全部'} 题、全部计划轮次的内容分等权平均 × 100；横轴 = 累计估算 USD 或输入与输出 tokens 总和 ÷ 轮数（每轮 ${app.taskCount || '全部'} 题）。仅绘制全部样本完成、分数与所选横轴用量齐全的记录。${colorDescription}，普通运行圆点、基线方块；最新实心、历史空心，时间未知用虚线边框。仅悬停、聚焦或选中时展开明确同批次、同渠道与账号、同一请求模型的不同可见 Thinking，不连接跨批次的最新记录。虚线前沿按当前可见点计算，不因 Thinking 协议不同而禁用。指令与工具检查独立报告，不计入均分；失败、取消、缺失不补零。零用量仅在线性刻度显示。未完成样本及执行限制可在任务详情中查阅。`;
  element('use-analysis').disabled = !records.length;
  chart.render(records, {
    taskCount: app.taskCount,
    historyRecords: state.records,
    log,
    labels: element('point-labels').checked,
    pareto: element('pareto-line').checked,
    colorBy: element('chart-color-by').value,
    axis: element('chart-axis').value,
    selectedIds: state.selectedId ? [state.selectedId] : []
  });
  renderObservationDetails();
  dataPopover.position();
}

function selectObservation(id) {
  state.selectedId = id || null;
  renderObservations();
  if (state.selectedId) element('close-inspector').focus({ preventScroll: true });
}
function copyToTasks(records) {
  const keys = [...new Set(records.map(selectionKey))];
  app.emit('mini-bench:select-targets', { keys });
  location.hash = 'runs';
}

async function loadObservations() {
  if (!available || state.loading) return;
  state.loading = true;
  try {
    // Switching back to analysis re-checks the list but downloads it only when it changed.
    const known = state.observationsEtag ? `?known=${encodeURIComponent(state.observationsEtag)}` : '';
    const data = await request(`./api/bench/observations${known}`);
    if (!(data.unchanged === true && known)) {
      if (!Array.isArray(data.observations)) throw new Error('Mini Bench 观察列表格式无效');
      state.observations = data.observations;
      state.observationsEtag = typeof data.etag === 'string' ? data.etag : null;
      state.evidence.clear();
      rebuildAnalysisRecords();
    }
    element('connection-status').textContent = '本地数据已同步';
  } catch (error) {
    element('connection-status').textContent = '数据加载失败';
    notify(`无法加载 Mini Bench 分析：${error.message}`, true);
  } finally {
    state.loading = false;
  }
}

async function loadRawEvidence(record) {
  if (state.evidenceLoading.has(record.id)) return;
  state.evidenceLoading.add(record.id);
  renderObservationDetails();
  try {
    if (record.source === 'baseline') {
      const data = await request('./api/bench/baselines');
      const baseline = data.baselines?.find(entry => entry.id === record.id);
      if (!baseline) throw new Error('未找到该基线的原始快照');
      state.evidence.set(record.id, baseline);
    } else {
      const run = await request(`./api/bench/runs/${encodeURIComponent(record.run_id)}`);
      state.evidence.set(record.id, { ...run, samples: (run.samples || []).filter(sample => sample.target_id === record.target_id) });
    }
  } catch (error) {
    notify(`读取原始证据失败：${error.message}`, true);
  } finally {
    state.evidenceLoading.delete(record.id);
    renderObservationDetails();
  }
}

element('chart-axis').addEventListener('change', rebuildAnalysisRecords);
element('usage-lower-bound').addEventListener('change', rebuildAnalysisRecords);
for (const id of ['chart-color-by', 'log-axis', 'point-labels', 'pareto-line']) element(id).addEventListener('change', renderObservations);
element('analysis-source').addEventListener('change', () => filters.setSource(element('analysis-source').value));
for (const kind of ['results', 'excluded']) {
  const trigger = element(kind === 'results' ? 'analysis-result-count' : 'analysis-excluded-count');
  trigger.addEventListener('click', () => {
    state.disclosure = state.disclosure === kind ? null : kind;
    renderObservations();
  });
  element(`close-analysis-${kind}`).addEventListener('click', () => {
    state.disclosure = null;
    renderObservations();
    trigger.focus();
  });
}
element('chart-settings-trigger').addEventListener('click', () => settingsPopover.setOpen(!settingsPopover.isOpen, { focus: true }));
element('close-chart-settings').addEventListener('click', () => settingsPopover.close());
element('analysis-data-trigger').addEventListener('click', () => dataPopover.setOpen(!dataPopover.isOpen, { focus: true }));
element('close-analysis-data').addEventListener('click', () => dataPopover.close());
for (const mode of ['latest', 'all', 'selected'])
  element(`analysis-data-${mode}`).addEventListener('change', () => {
    state.dataMode = mode;
    rebuildHistoryFilterScope();
    chart.resetZoom();
    renderObservations();
  });
for (const id of ['analysis-date-from', 'analysis-date-to'])
  element(id).addEventListener('change', () => {
    rebuildHistoryFilterScope();
    renderObservations();
  });
element('analysis-history-options').addEventListener('change', event => {
  const input = event.target.closest('[data-history-record]');
  if (!input) return;
  if (input.checked) state.historyIds.add(input.dataset.historyRecord);
  else state.historyIds.delete(input.dataset.historyRecord);
  renderObservations();
});
element('analysis-history-select-all').addEventListener('click', () => {
  for (const record of selectAnalysisHistoryRecords(state.records, historyOptions('all')).filter(filters.matches))
    state.historyIds.add(record.id);
  renderObservations();
});
element('analysis-history-clear').addEventListener('click', () => {
  state.historyIds.clear();
  renderObservations();
});
element('analysis-reset').addEventListener('click', () => {
  state.dataMode = 'latest';
  state.historyIds.clear();
  element('analysis-data-latest').checked = true;
  element('analysis-date-from').value = '';
  element('analysis-date-to').value = '';
  element('analysis-source').value = 'all';
  filters.reset();
  rebuildHistoryFilterScope();
  chart.resetZoom();
  renderObservations();
});
element('use-analysis').addEventListener('click', () => copyToTasks(matchingRecords()));
element('chart-zoom-in').addEventListener('click', () => chart.zoom(1.4));
element('chart-zoom-out').addEventListener('click', () => chart.zoom(1 / 1.4));
element('chart-reset').addEventListener('click', () => chart.resetZoom());
element('export-chart').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([chart.exportSvg()], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mini-bench-score-cost.svg';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
element('analysis-view').addEventListener('click', async event => {
  const inspect = event.target.closest('[data-inspect-observation]');
  if (inspect) {
    state.disclosure = null;
    selectObservation(inspect.dataset.inspectObservation);
    element('model-inspector').scrollIntoView({ block: 'start' });
  }
  const run = event.target.closest('[data-open-run]');
  if (run) {
    location.hash = 'runs';
    app.emit('mini-bench:select-run', run.dataset.openRun);
  }
  const copy = event.target.closest('[data-copy-observation]');
  if (copy) copyToTasks(state.records.filter(record => record.id === copy.dataset.copyObservation));
  const evidence = event.target.closest('[data-load-evidence]');
  if (evidence) {
    const record = state.observations.find(record => record.id === evidence.dataset.loadEvidence);
    if (record) await loadRawEvidence(record);
  }
  const promote = event.target.closest('[data-promote-id]');
  if (!promote) return;
  const record = state.observations.find(record => record.id === promote.dataset.promoteId);
  if (!record?.baseline_eligible || record.source !== 'run' || state.promoting.has(record.id)) return;
  state.promoting.add(record.id);
  renderObservationDetails();
  try {
    await request(`./api/bench/runs/${encodeURIComponent(record.run_id)}/baseline`, {
      method: 'POST',
      body: JSON.stringify({ target_id: record.target_id })
    });
    await loadObservations();
    notify('已将该运行目标保存为 Mini Bench 基线。');
  } catch (error) {
    notify(`保存基线失败：${error.message}`, true);
  } finally {
    state.promoting.delete(record.id);
    renderObservationDetails();
  }
});
element('close-inspector').addEventListener('click', () => {
  state.selectedId = null;
  renderObservations();
  filters.focus();
});
document.addEventListener('keydown', event => {
  if (!event.defaultPrevented && event.key === 'Escape' && state.selectedId) {
    state.selectedId = null;
    renderObservations();
  }
});
app.on('mini-bench:refresh', loadObservations);
app.on('mini-bench:observations-changed', loadObservations);
app.on('mini-bench:banks-changed', event => {
  model.setBank(event.detail);
  rebuildAnalysisRecords();
});
app.on('mini-bench:theme-changed', renderObservations);
app.on('mini-bench:history-changed', () => {
  state.records = presentedRecords();
  renderObservations();
});
app.on('mini-bench:view', event => {
  if (event.detail === 'analysis') {
    renderObservations();
    loadObservations();
  }
});
new MutationObserver(renderObservations).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderObservations);
rebuildAnalysisRecords();
if (available) loadObservations();
