import { selectionKey, thinkingLabel } from './data-picker.js';
import { createAnalysisFilters } from './analysis-filters.js';
import { getAppContext } from './app-context.js';
import { createAnalysisModel, attachAnalysisBatchIds } from './analysis-model.js';
import { selectAnalysisHistoryRecords } from './analysis-history.js';
import { createAnalysisPopover } from './analysis-popover.js';
import { renderAnalysisRecordList } from './analysis-record-list.js';
import { createScoreCostChart } from './score-cost-chart.js';
import { buildObservationAnomalies } from './assessment-chart-metric.js';
import { dedupePromotedRuns } from './baseline-comparison.js';
import { analyzeAnomalies } from './anomaly-analysis.js';

const app = getAppContext();
const { byId: element, escapeHtml, finite, request, notify, available, formatDate } = app.services;
const DEFAULT_INSIGHT_GROUP_LIMIT = 8;
const INSIGHT_GROUP_STEP = 12;
const DEFAULT_ITEMS_PER_GROUP = 5;
const ITEMS_PER_GROUP_STEP = 15;
const AUTO_EXPAND_GROUP_MAX = 3;
let insightsCollapsible = false;
const state = {
  observations: [],
  observationsEtag: null,
  records: [],
  dataMode: 'latest',
  historyIds: new Set(),
  historyPickerLimit: 100,
  disclosure: null,
  disclosureLimit: 80,
  insightsCollapsed: false,
  insightMetricFilter: 'all',
  insightSearch: '',
  insightGroupLimit: DEFAULT_INSIGHT_GROUP_LIMIT,
  insightGroupOpen: new Map(),
  insightGroupItemLimits: new Map(),
  activeInsightId: null,
  activeInsightHighlight: null,
  selectedId: null,
  loading: false,
  promoting: new Set(),
  demoting: new Set()
};
const filters = createAnalysisFilters(element('analysis-picker'), { onChange: renderObservations });
const model = createAnalysisModel();
model.setBank(app.bank);
let pendingAnalysisRender = false;
const chart = createScoreCostChart(element('score-cost-chart'), {
  onSelect: selectObservation,
  onOpenRun: runId => {
    location.hash = 'runs';
    app.emit('mini-bench:select-run', runId);
  },
  onPromoteBaseline: promoteObservation,
  onDemoteBaseline: demoteObservationBaseline
});
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
          renderResultDisclosure(matchingRecords());
        }
      }
    })
  ])
);
const sourceText = record => (record.source === 'baseline' ? '基线' : '我的运行');

function chartExclusionReason(record) {
  const axis = element('chart-axis').value;
  return (
    record.exclusionReason ||
    (element('log-axis').checked && axis !== 'cost' && record.cost === 0 ? '零用量无法显示在对数轴；切换线性刻度可见' : null)
  );
}

/** Optionally place usage-incomplete records at their known lower bound; strict metrics stay untouched. */
function presentedRecords() {
  const lowerBound = element('usage-lower-bound').checked;
  return attachAnalysisBatchIds(model.records(element('chart-axis').value), app.getTaskId).map(record => {
    const withLowerBound =
      lowerBound && finite(record.score) && !finite(record.cost) && record.usageLowerBound
        ? {
            ...record,
            cost: record.usageLowerBound.cost,
            usageIncomplete: record.usageLowerBound,
            strictExclusionReason: record.exclusionReason,
            exclusionReason: null
          }
        : record;
    const anomalies = buildObservationAnomalies(withLowerBound.sampleAnomalies, withLowerBound.usageIncomplete ?? null);
    return anomalies.hasAny ? { ...withLowerBound, anomalies } : withLowerBound;
  });
}

// Analysis covers one bank version at a time; the scoped list stays reference-stable between rebuilds.
let scopedRawObservations = null,
  scopedBankVersion = undefined,
  scopedObservationList = [];
function scopedObservations() {
  const version = app.bank?.version ?? null;
  if (scopedRawObservations === state.observations && scopedBankVersion === version) return scopedObservationList;
  scopedRawObservations = state.observations;
  scopedBankVersion = version;
  scopedObservationList = version ? state.observations.filter(record => record?.bank_version === version) : [];
  return scopedObservationList;
}

function rebuildAnalysisRecords() {
  model.setObservations(scopedObservations());
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
  return dedupePromotedRuns(selectAnalysisHistoryRecords(state.records, historyOptions()).filter(filters.matches));
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
  if (state.dataMode !== 'selected' || !dataPopover.isOpen) return;
  const candidates = selectAnalysisHistoryRecords(state.records, historyOptions('all')).filter(filters.matches);
  const visibleCandidates = candidates.length > state.historyPickerLimit ? candidates.slice(0, state.historyPickerLimit) : candidates;
  const key = JSON.stringify([
    candidates.length,
    visibleCandidates.map(record => [
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
  ]);
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
  const conciseAccount = record =>
    String(record.accountId ?? '').startsWith('gateway-binding:')
      ? '自动分配'
      : record.accountDisplayId && record.accountDisplayId !== '实际账号未记录'
        ? record.accountDisplayId
        : record.account;
  const moreHistory =
    candidates.length > visibleCandidates.length
      ? `<div class="history-pagination"><button class="btn" type="button" data-history-picker-more="100">显示更多（已显示 ${visibleCandidates.length} / ${candidates.length} 条）</button><button class="text-control" type="button" data-history-picker-more="all">显示全部</button></div>`
      : '';
  element('analysis-history-options').innerHTML = visibleCandidates.length
    ? visibleCandidates
        .map(
          record =>
            `<label class="analysis-history-option"><input type="checkbox" data-history-record="${escapeHtml(record.id)}" ${state.historyIds.has(record.id) ? 'checked' : ''}><span><strong>${escapeHtml(record.modelDisplayName || record.model)} · ${escapeHtml(thinkingLabel(record.think))}</strong><span>${escapeHtml(formatDate(record.created_at))} · ${escapeHtml(record.providerName || record.provider)} / ${escapeHtml(conciseAccount(record))}</span><small>${escapeHtml(record.id)} · ${sourceText(record)}</small></span></label>`
        )
        .join('') + moreHistory
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
      formatDate,
      limit: state.disclosureLimit
    });
    resultPopovers[kind].position();
  }
}

function renderObservations() {
  if (element('analysis-view')?.hidden) {
    pendingAnalysisRender = true;
    return;
  }
  pendingAnalysisRender = false;
  const records = matchingRecords();
  if (!records.some(record => record.id === state.selectedId)) state.selectedId = null;
  const log = element('log-axis').checked;
  const axis = element('chart-axis').value;
  const allowZero = !log || axis === 'cost';
  const plotted = records.filter(
    record =>
      finite(record.score) &&
      record.score >= 0 &&
      record.score <= 100 &&
      finite(record.cost) &&
      (allowZero ? record.cost >= 0 : record.cost > 0)
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
  renderInsights(records);
  const scoped = scopedObservations();
  const bankPrefix = app.bank?.version ? `Mini Bench ${app.bank.version}` : 'Mini Bench';
  element('dataset-summary').textContent =
    `${bankPrefix} · ${scoped.filter(record => record.source === 'baseline').length} 份基线 · ${scoped.filter(record => record.source === 'run').length} 个运行目标`;
  const colorDescription = {
    series: '颜色区分供应商-模型组合（保留账号区分）',
    account: '颜色区分渠道与账号 / Key 组合，同账号或 Key 下不同模型同色',
    model: '颜色区分模型，同名模型跨供应商同色',
    family: '颜色区分模型系列（按记录名称识别，未识别的模型单独着色，不代表实际服务身份）',
    time: '颜色按记录的评测时间区分本地日期，使用多色调色板；日期颜色在全部已加载记录中固定，时间未记录用中性色'
  }[element('chart-color-by').value];
  element('analysis-method').textContent =
    `均分 = 完整 ${app.taskCount || '全部'} 题、全部计划轮次的内容分等权平均 × 100（超时按 0 分计入完整完成，仍可重试）；横轴 = 累计估算 USD、输入与输出 tokens 总和或累计执行耗时 ÷ 轮数（每轮 ${app.taskCount || '全部'} 题）。仅绘制全部样本完成、分数与所选横轴指标齐全的记录。${colorDescription}，普通运行圆点、基线方块；最新实心、历史空心，时间未知用虚线边框；含异常项（样本超时、提交后异常中止、未调用 submit_answer 提交或用量不完整）的记录带橙色角标且不参与前沿。仅悬停、聚焦或选中时展开明确同批次、同渠道与账号、同一请求模型的不同可见 Thinking，不连接跨批次的最新记录。虚线前沿按当前可见点计算，不因 Thinking 协议不同而禁用。指令与工具检查独立报告，不计入均分；API 失败、取消、缺失不补零。零费用记录绘制在坐标轴上，不计入前沿线；其余横轴零用量仅在线性刻度显示。未完成样本及执行限制可在任务详情中查阅。`;
  element('use-analysis').disabled = !records.length;
  chart.render(records, {
    taskCount: app.taskCount,
    historyRecords: state.records,
    log,
    labels: element('point-labels').checked,
    pareto: element('pareto-line').checked,
    colorBy: element('chart-color-by').value,
    axis: element('chart-axis').value,
    selectedIds: state.selectedId ? [state.selectedId] : [],
    insightHighlight: state.activeInsightHighlight,
    promotingIds: state.promoting,
    demotingIds: state.demoting,
    maskAccounts: Boolean(app.maskAccounts)
  });
  dataPopover.position();
}

let cachedInsightsKey = null,
  cachedInsightsResult = null;
function currentInsights(records) {
  const key = `${records.map(r => r.id).join('\0')}\n${state.records.length}`;
  if (cachedInsightsKey === key && cachedInsightsResult && cachedInsightsResult.pool === state.records) {
    return cachedInsightsResult.result;
  }
  const result = analyzeAnomalies(records, { baselinePool: state.records });
  cachedInsightsKey = key;
  cachedInsightsResult = { pool: state.records, result };
  return result;
}

function findInsightItem(records, itemId) {
  if (!itemId) return null;
  const { groups = [] } = currentInsights(records);
  for (const group of groups) {
    const found = group.items.find(item => item.id === itemId);
    if (found) return found;
  }
  return null;
}

function filterInsightGroups(groups) {
  const metricFilter = state.insightMetricFilter || 'all';
  const query = (state.insightSearch || '').trim().toLocaleLowerCase();
  const filtered = [];
  for (const group of groups) {
    const groupText =
      `${group.accountRaw || ''} ${group.providerLabel || ''} ${group.kind === 'account' ? '账号' : '渠道'}`.toLocaleLowerCase();
    const groupMatchesQuery = !query || groupText.includes(query);
    const items = group.items.filter(item => {
      if (metricFilter !== 'all' && item.metric !== metricFilter) return false;
      if (!query || groupMatchesQuery) return true;
      const itemText = `${item.modelName || ''} ${item.thinkLabel || ''} ${item.refContext || ''}`.toLocaleLowerCase();
      return itemText.includes(query);
    });
    if (!items.length) continue;
    const metrics = { score: 0, cost: 0, duration: 0 };
    for (const item of items) {
      if (item.metric in metrics) metrics[item.metric]++;
    }
    filtered.push({ ...group, items, metrics });
  }
  return filtered;
}

function isInsightGroupOpen(group, totalVisibleGroups) {
  if (state.insightGroupOpen.has(group.id)) return Boolean(state.insightGroupOpen.get(group.id));
  if (state.activeInsightId && group.items.some(item => item.id === state.activeInsightId)) return true;
  if ((state.insightSearch || '').trim()) return true;
  return totalVisibleGroups <= AUTO_EXPAND_GROUP_MAX;
}

function renderInsights(records) {
  const panel = element('analysis-insights');
  if (!panel) return;
  const { findings, groups = [], comparableGroups, baselinePairs } = currentInsights(records);
  if (state.activeInsightId && !findInsightItem(records, state.activeInsightId)) {
    state.activeInsightId = null;
    state.activeInsightHighlight = null;
  }
  if (!groups.length && comparableGroups === 0 && baselinePairs === 0) {
    insightsCollapsible = false;
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.classList?.toggle?.('is-clean', !groups.length);

  const disclosureEl = /** @type {HTMLDetailsElement} */ (element('analysis-insights-disclosure'));
  const summaryEl = element('analysis-insights-summary');
  const activeEl = element('analysis-insights-active');
  const toggleHintEl = element('analysis-insights-toggle-hint');
  const bodyEl = element('analysis-insights-body');
  const toolbarEl = element('analysis-insights-toolbar');
  const filtersEl = element('analysis-insights-filters');
  const searchEl = /** @type {HTMLInputElement | null} */ (element('analysis-insights-search'));
  const toggleAllEl = element('analysis-insights-toggle-all');
  const countEl = element('analysis-insights-count');
  const metaEl = element('analysis-insights-meta');
  const listEl = element('analysis-insights-list');
  const moreEl = element('analysis-insights-more');

  const metaParts = [];
  if (baselinePairs > 0) metaParts.push(`基线配对 ${baselinePairs} 项`);
  if (comparableGroups > 0) metaParts.push(`渠道/账号对照 ${comparableGroups} 组`);
  metaEl.textContent = metaParts.join(' · ');

  if (!groups.length) {
    insightsCollapsible = false;
    panel.classList?.toggle?.('is-collapsed', false);
    disclosureEl.open = false;
    summaryEl.setAttribute('aria-disabled', 'true');
    activeEl.hidden = true;
    activeEl.textContent = '';
    toggleHintEl.hidden = true;
    bodyEl.hidden = true;
    if (toolbarEl) toolbarEl.hidden = true;
    countEl.textContent = '未发现显著异常';
    countEl.className = 'insight-count is-clean';
    listEl.innerHTML = '';
    moreEl.hidden = true;
    moreEl.innerHTML = '';
    return;
  }

  insightsCollapsible = true;
  panel.classList?.toggle?.('is-collapsed', state.insightsCollapsed);
  if (summaryEl.removeAttribute) summaryEl.removeAttribute('aria-disabled');
  else summaryEl.setAttribute('aria-disabled', 'false');
  bodyEl.hidden = false;
  disclosureEl.open = !state.insightsCollapsed;
  toggleHintEl.hidden = false;
  toggleHintEl.textContent = state.insightsCollapsed ? '展开' : '收起';
  activeEl.hidden = !state.activeInsightId;
  activeEl.textContent = state.activeInsightId ? '已定位对比' : '';

  const validGroupIds = new Set(groups.map(group => group.id));
  for (const key of state.insightGroupItemLimits.keys()) {
    if (!validGroupIds.has(key)) state.insightGroupItemLimits.delete(key);
  }
  for (const key of state.insightGroupOpen.keys()) {
    if (!validGroupIds.has(key)) state.insightGroupOpen.delete(key);
  }

  const metricTotals = { all: 0, score: 0, cost: 0, duration: 0 };
  for (const group of groups) {
    metricTotals.all += group.items.length;
    metricTotals.score += group.metrics.score || 0;
    metricTotals.cost += group.metrics.cost || 0;
    metricTotals.duration += group.metrics.duration || 0;
  }
  if (state.insightMetricFilter !== 'all' && !metricTotals[state.insightMetricFilter]) {
    state.insightMetricFilter = 'all';
  }

  const hasHigh = findings.some(item => item.severity === 'high');
  const channelGroupCount = groups.filter(group => group.kind === 'channel').length;
  const accountGroupCount = groups.filter(group => group.kind === 'account').length;
  const countParts = [];
  if (channelGroupCount > 0) countParts.push(`${channelGroupCount} 渠道`);
  if (accountGroupCount > 0) countParts.push(`${accountGroupCount} 账号`);
  countParts.push(`${metricTotals.all} 项异常`);
  countEl.textContent = countParts.join(' · ');
  countEl.className = `insight-count${hasHigh ? ' is-high' : ''}`;

  const filteredGroups = filterInsightGroups(groups);
  const groupLimit = Math.max(DEFAULT_INSIGHT_GROUP_LIMIT, state.insightGroupLimit);
  const visibleGroups = filteredGroups.length <= groupLimit ? filteredGroups : filteredGroups.slice(0, groupLimit);
  const metricLabel = metric => (metric === 'score' ? '能力偏低' : metric === 'cost' ? '成本偏高' : '耗时偏慢');

  const showToolbar =
    groups.length > 1 || metricTotals.all > 3 || state.insightMetricFilter !== 'all' || Boolean((state.insightSearch || '').trim());
  if (toolbarEl) {
    toolbarEl.hidden = !showToolbar;
    if (showToolbar && filtersEl) {
      const pills = [
        { key: 'all', label: `全部 ${metricTotals.all}` },
        metricTotals.score > 0 ? { key: 'score', label: `能力偏低 ${metricTotals.score}` } : null,
        metricTotals.cost > 0 ? { key: 'cost', label: `成本偏高 ${metricTotals.cost}` } : null,
        metricTotals.duration > 0 ? { key: 'duration', label: `耗时偏慢 ${metricTotals.duration}` } : null
      ].filter(Boolean);
      filtersEl.innerHTML = pills
        .map(pill => {
          const pressed = state.insightMetricFilter === pill.key;
          return `<button class="insight-filter-pill is-${pill.key}${pressed ? ' is-active' : ''}" type="button" data-insight-metric="${pill.key}" aria-pressed="${pressed ? 'true' : 'false'}">${pill.label}</button>`;
        })
        .join('');
    }
    if (searchEl && searchEl.value !== state.insightSearch) searchEl.value = state.insightSearch;
    if (toggleAllEl) {
      const allOpen = visibleGroups.length > 0 && visibleGroups.every(group => isInsightGroupOpen(group, visibleGroups.length));
      toggleAllEl.hidden = visibleGroups.length <= 1;
      toggleAllEl.setAttribute('aria-expanded', allOpen ? 'true' : 'false');
      toggleAllEl.textContent = allOpen ? '全部收起' : '全部展开';
    }
  }

  const prevScrollTop = listEl.scrollTop || 0;
  if (!visibleGroups.length) {
    listEl.innerHTML = '<div class="insight-empty muted">当前筛选条件下无匹配异常</div>';
    moreEl.hidden = true;
    moreEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = visibleGroups
    .map(group => {
      const open = isInsightGroupOpen(group, visibleGroups.length);
      const itemLimit = state.insightGroupItemLimits.get(group.id) ?? DEFAULT_ITEMS_PER_GROUP;
      const visibleItems = group.items.length <= itemLimit ? group.items : group.items.slice(0, itemLimit);
      const remainingItems = group.items.length - visibleItems.length;
      const identHtml =
        group.kind === 'account'
          ? `<span class="insight-scope is-account">账号</span><span class="insight-target insight-account">${escapeHtml(group.accountRaw)}</span><span class="insight-group-sub">· ${escapeHtml(group.providerLabel)}</span>`
          : `<span class="insight-scope is-channel">渠道</span><span class="insight-target">${escapeHtml(group.providerLabel)}</span><span class="insight-group-sub">${group.accountCount > 1 ? `整渠道（${group.accountCount} 个账号）` : '整渠道'}</span>`;
      const lead = group.items[0];
      const leadHtml = lead
        ? `<span class="insight-group-lead" title="${escapeHtml(`${lead.modelName} · ${lead.thinkLabel} ${lead.deltaText}`)}">${escapeHtml(lead.modelName)} <strong class="insight-delta is-${escapeHtml(lead.metric)}">${escapeHtml(lead.deltaText)}</strong></span>`
        : '';
      const badges = [];
      if (group.metrics.score > 0) badges.push(`<span class="insight-badge is-score">能力偏低 ${group.metrics.score}</span>`);
      if (group.metrics.cost > 0) badges.push(`<span class="insight-badge is-cost">成本偏高 ${group.metrics.cost}</span>`);
      if (group.metrics.duration > 0) badges.push(`<span class="insight-badge is-duration">耗时偏慢 ${group.metrics.duration}</span>`);
      const rowsHtml = visibleItems
        .map(item => {
          const active = state.activeInsightId
            ? state.activeInsightId === item.id
            : Boolean(state.selectedId && item.primaryRecordId === state.selectedId);
          const extraRefs = Array.isArray(item.comparisons) && item.comparisons.length > 1 ? item.comparisons.slice(1) : [];
          const refLabel = extraRefs.length ? `${item.refContext} +${extraRefs.length}` : item.refContext;
          const refTitle =
            Array.isArray(item.comparisons) && item.comparisons.length > 1
              ? item.comparisons.map(c => `对照 ${c.refContext}：${c.valueText} vs ${c.refText}（${c.deltaText}）`).join('；')
              : `对照 ${item.refContext}`;
          return `<button class="insight-row${active ? ' is-active' : ''}" type="button" data-insight-record="${escapeHtml(item.primaryRecordId)}" data-insight-item="${escapeHtml(item.id)}" aria-pressed="${active ? 'true' : 'false'}"><span class="insight-badge is-${escapeHtml(item.metric)}">${metricLabel(item.metric)}</span><span class="insight-model"><span class="insight-model-name">${escapeHtml(item.modelName)}</span><span class="insight-model-think"> · ${escapeHtml(item.thinkLabel)}</span></span><span class="insight-compare"><strong class="insight-val">${escapeHtml(item.valueText)}</strong><span class="insight-vs"> vs </span><span class="insight-ref-val">${escapeHtml(item.refText)}</span><span class="insight-delta is-${escapeHtml(item.metric)}">${escapeHtml(item.deltaText)}</span></span><span class="insight-ref-ctx" title="${escapeHtml(refTitle)}">对照 ${escapeHtml(refLabel)}</span><span class="insight-locate">${active ? '已定位 ×' : '定位 →'}</span></button>`;
        })
        .join('');
      let expandHtml = '';
      if (group.items.length > DEFAULT_ITEMS_PER_GROUP) {
        const actions = [];
        if (remainingItems > 0) {
          const nextLabel =
            remainingItems <= ITEMS_PER_GROUP_STEP
              ? `展开其余 ${remainingItems} 项`
              : `继续展开（已显示 ${visibleItems.length} / ${group.items.length} 项）`;
          actions.push(
            `<button class="insight-group-expand" type="button" data-insight-group-toggle="${escapeHtml(group.id)}" data-insight-group-step="more">${nextLabel}</button>`
          );
          if (remainingItems > ITEMS_PER_GROUP_STEP) {
            actions.push(
              `<button class="insight-group-expand" type="button" data-insight-group-toggle="${escapeHtml(group.id)}" data-insight-group-step="all">展开全部 ${group.items.length} 项</button>`
            );
          }
        }
        if (visibleItems.length > DEFAULT_ITEMS_PER_GROUP) {
          actions.push(
            `<button class="insight-group-expand" type="button" data-insight-group-toggle="${escapeHtml(group.id)}" data-insight-group-step="reset">收起明细</button>`
          );
        }
        expandHtml = `<div class="insight-group-actions">${actions.join('')}</div>`;
      }
      return `<details class="insight-group is-${group.kind}" data-insight-group="${escapeHtml(group.id)}"${open ? ' open' : ''}><summary class="insight-group-head"><div class="insight-group-ident">${identHtml}</div><div class="insight-group-summary-side">${leadHtml}<div class="insight-group-badges">${badges.join('')}</div></div></summary><div class="insight-group-content"><div class="insight-group-rows">${rowsHtml}</div>${expandHtml}</div></details>`;
    })
    .join('');
  if (prevScrollTop > 0) listEl.scrollTop = prevScrollTop;

  if (filteredGroups.length > DEFAULT_INSIGHT_GROUP_LIMIT) {
    const remainingGroups = filteredGroups.length - visibleGroups.length;
    const buttons = [];
    if (remainingGroups > 0) {
      const moreLabel =
        remainingGroups <= INSIGHT_GROUP_STEP
          ? `展开其余 ${remainingGroups} 个主体`
          : `展开更多主体（已显示 ${visibleGroups.length} / ${filteredGroups.length}）`;
      buttons.push(`<button class="text-control" type="button" data-insight-toggle="more">${moreLabel}</button>`);
      if (remainingGroups > INSIGHT_GROUP_STEP) {
        buttons.push(
          `<button class="text-control" type="button" data-insight-toggle="all">展开全部 ${filteredGroups.length} 个主体</button>`
        );
      }
    }
    if (visibleGroups.length > DEFAULT_INSIGHT_GROUP_LIMIT) {
      buttons.push('<button class="text-control" type="button" data-insight-toggle="reset">收起部分主体</button>');
    }
    moreEl.hidden = false;
    moreEl.innerHTML = buttons.join('');
  } else {
    moreEl.hidden = true;
    moreEl.innerHTML = '';
  }
}

function selectObservation(id) {
  state.selectedId = id || null;
  state.activeInsightId = null;
  state.activeInsightHighlight = null;
  renderObservations();
}
function copyToTasks(records) {
  const keys = [...new Set(records.map(selectionKey))];
  app.emit('mini-bench:select-targets', { keys });
  location.hash = 'runs';
}

async function promoteObservation(id) {
  const record = state.observations.find(entry => entry.id === id);
  if (!record?.baseline_eligible || record.source !== 'run' || state.promoting.has(record.id)) return;
  state.promoting.add(record.id);
  renderObservations();
  try {
    const result = await request(`./api/bench/runs/${encodeURIComponent(record.run_id)}/baseline`, {
      method: 'POST',
      body: JSON.stringify({ target_id: record.target_id })
    });
    const promotedId = typeof result?.baseline?.id === 'string' ? result.baseline.id : null;
    if (promotedId && state.selectedId === record.id) state.selectedId = promotedId;
    await loadObservations();
    app.emit('mini-bench:baselines-changed');
    notify('已将该运行目标保存为 Mini Bench 基线。');
  } catch (error) {
    notify(`保存基线失败：${error.message}`, true);
  } finally {
    state.promoting.delete(record.id);
    renderObservations();
  }
}

async function demoteObservationBaseline(baselineId) {
  if (!baselineId || state.demoting.has(baselineId)) return;
  const baselineRecord = state.observations.find(entry => entry.source === 'baseline' && entry.id === baselineId);
  const runCounterpart = baselineRecord
    ? state.observations.find(
        entry => entry.source === 'run' && entry.run_id === baselineRecord.run_id && entry.target_id === baselineRecord.target_id
      )
    : null;
  state.demoting.add(baselineId);
  renderObservations();
  try {
    await request(`./api/bench/baselines/${encodeURIComponent(baselineId)}/delete`, { method: 'POST' });
    if (state.selectedId === baselineId) state.selectedId = runCounterpart?.id ?? null;
    await loadObservations();
    app.emit('mini-bench:baselines-changed');
    notify('已取消该基线标记，原始运行记录已保留。');
  } catch (error) {
    notify(`取消基线失败：${error.message}`, true);
  } finally {
    state.demoting.delete(baselineId);
    renderObservations();
  }
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
      app.setRecordedBankVersions?.(
        'observations',
        state.observations.map(record => record?.bank_version)
      );
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

element('chart-axis').addEventListener('change', rebuildAnalysisRecords);
element('usage-lower-bound').addEventListener('change', rebuildAnalysisRecords);
for (const id of ['chart-color-by', 'log-axis', 'point-labels', 'pareto-line']) element(id).addEventListener('change', renderObservations);
for (const kind of ['results', 'excluded']) {
  const trigger = element(kind === 'results' ? 'analysis-result-count' : 'analysis-excluded-count');
  trigger.addEventListener('click', () => {
    state.disclosure = state.disclosure === kind ? null : kind;
    state.disclosureLimit = 80;
    renderResultDisclosure(matchingRecords());
  });
  element(`close-analysis-${kind}`).addEventListener('click', () => {
    state.disclosure = null;
    renderResultDisclosure(matchingRecords());
    trigger.focus();
  });
}
element('chart-settings-trigger').addEventListener('click', () => settingsPopover.setOpen(!settingsPopover.isOpen, { focus: true }));
element('close-chart-settings').addEventListener('click', () => settingsPopover.close());
element('analysis-data-trigger').addEventListener('click', () => {
  const next = !dataPopover.isOpen;
  dataPopover.setOpen(next, { focus: true });
  if (next) {
    renderHistoryPicker();
    dataPopover.position();
  }
});
element('close-analysis-data').addEventListener('click', () => dataPopover.close());
for (const mode of ['latest', 'all', 'selected'])
  element(`analysis-data-${mode}`).addEventListener('change', () => {
    state.dataMode = mode;
    state.historyPickerLimit = 100;
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
  const moreList = event.target.closest('[data-record-list-more]');
  if (moreList) {
    const step = moreList.dataset.recordListMore;
    state.disclosureLimit = step === 'all' ? Number.MAX_SAFE_INTEGER : state.disclosureLimit + (Number(step) || 80);
    renderResultDisclosure(matchingRecords());
    return;
  }
  const moreHistory = event.target.closest('[data-history-picker-more]');
  if (moreHistory) {
    const step = moreHistory.dataset.historyPickerMore;
    state.historyPickerLimit = step === 'all' ? Number.MAX_SAFE_INTEGER : state.historyPickerLimit + (Number(step) || 100);
    renderHistoryPicker();
    dataPopover.position();
    return;
  }
  const insightMetric = event.target.closest('[data-insight-metric]');
  if (insightMetric) {
    const nextMetric = insightMetric.dataset.insightMetric || 'all';
    state.insightMetricFilter = state.insightMetricFilter === nextMetric && nextMetric !== 'all' ? 'all' : nextMetric;
    state.insightGroupLimit = DEFAULT_INSIGHT_GROUP_LIMIT;
    element('analysis-insights-list').scrollTop = 0;
    renderInsights(matchingRecords());
    return;
  }
  const insightToggle = event.target.closest('[data-insight-toggle]');
  if (insightToggle) {
    const action = insightToggle.dataset.insightToggle;
    if (action === 'reset') {
      state.insightGroupLimit = DEFAULT_INSIGHT_GROUP_LIMIT;
      element('analysis-insights-list').scrollTop = 0;
    } else if (action === 'all') {
      state.insightGroupLimit = Number.MAX_SAFE_INTEGER;
    } else {
      state.insightGroupLimit = Math.max(DEFAULT_INSIGHT_GROUP_LIMIT, state.insightGroupLimit) + INSIGHT_GROUP_STEP;
    }
    renderInsights(matchingRecords());
    return;
  }
  const insightGroupToggle = event.target.closest('[data-insight-group-toggle]');
  if (insightGroupToggle) {
    const groupId = insightGroupToggle.dataset.insightGroupToggle;
    if (groupId) {
      const step = insightGroupToggle.dataset.insightGroupStep;
      const current = state.insightGroupItemLimits.get(groupId) ?? DEFAULT_ITEMS_PER_GROUP;
      if (step === 'reset') state.insightGroupItemLimits.delete(groupId);
      else if (step === 'all') state.insightGroupItemLimits.set(groupId, Number.MAX_SAFE_INTEGER);
      else state.insightGroupItemLimits.set(groupId, current + ITEMS_PER_GROUP_STEP);
      renderInsights(matchingRecords());
    }
    return;
  }
  const insightRow = event.target.closest('[data-insight-record]');
  if (insightRow) {
    const itemId = insightRow.dataset.insightItem || '';
    const recordId = insightRow.dataset.insightRecord || '';
    if (itemId && state.activeInsightId === itemId) {
      selectObservation(null);
      return;
    }
    const item = findInsightItem(matchingRecords(), itemId);
    if (item) {
      state.activeInsightId = item.id;
      state.activeInsightHighlight = {
        anomalyIds: item.recordIds,
        referenceIds: item.referenceIds,
        metric: item.metric,
        valueText: item.valueText,
        refText: item.refText,
        refContext: item.refContext,
        deltaText: item.deltaText
      };
      state.selectedId = item.primaryRecordId || recordId || null;
      renderObservations();
      element('chart-card')?.scrollIntoView?.({ block: 'nearest' });
    } else if (recordId) {
      selectObservation(recordId);
      element('chart-card')?.scrollIntoView?.({ block: 'nearest' });
    }
    return;
  }
  const inspect = event.target.closest('[data-inspect-observation]');
  if (inspect) {
    const id = inspect.dataset.inspectObservation;
    state.disclosure = null;
    const record = matchingRecords().find(entry => entry.id === id);
    if (record && !chartExclusionReason(record)) {
      selectObservation(id);
      element('chart-card')?.scrollIntoView?.({ block: 'nearest' });
    } else if (record?.run_id) {
      renderResultDisclosure(matchingRecords());
      location.hash = 'runs';
      app.emit('mini-bench:select-run', record.run_id);
    } else {
      renderResultDisclosure(matchingRecords());
    }
    return;
  }
  const run = event.target.closest('[data-open-run]');
  if (run) {
    location.hash = 'runs';
    app.emit('mini-bench:select-run', run.dataset.openRun);
    return;
  }
  const promote = event.target.closest('[data-promote-id]');
  if (promote) {
    await promoteObservation(promote.dataset.promoteId);
    return;
  }
  const demote = event.target.closest('[data-demote-baseline-id]');
  if (demote) await demoteObservationBaseline(demote.dataset.demoteBaselineId);
});
element('analysis-insights-search')?.addEventListener('input', event => {
  state.insightSearch = String(/** @type {HTMLInputElement} */ (event.target).value || '');
  state.insightGroupLimit = DEFAULT_INSIGHT_GROUP_LIMIT;
  element('analysis-insights-list').scrollTop = 0;
  renderInsights(matchingRecords());
});
element('analysis-insights-toggle-all')?.addEventListener('click', () => {
  const records = matchingRecords();
  const filteredGroups = filterInsightGroups(currentInsights(records).groups || []);
  const groupLimit = Math.max(DEFAULT_INSIGHT_GROUP_LIMIT, state.insightGroupLimit);
  const visibleGroups = filteredGroups.length <= groupLimit ? filteredGroups : filteredGroups.slice(0, groupLimit);
  if (!visibleGroups.length) return;
  const allOpen = visibleGroups.every(group => isInsightGroupOpen(group, visibleGroups.length));
  const nextOpen = !allOpen;
  for (const group of visibleGroups) state.insightGroupOpen.set(group.id, nextOpen);
  renderInsights(records);
});
element('analysis-insights-list')?.addEventListener(
  'toggle',
  event => {
    const target = event.target;
    const groupId = target?.dataset?.insightGroup;
    if (!groupId) return;
    state.insightGroupOpen.set(groupId, Boolean(target.open));
    const toggleAllEl = element('analysis-insights-toggle-all');
    if (toggleAllEl) {
      const filteredGroups = filterInsightGroups(currentInsights(matchingRecords()).groups || []);
      const groupLimit = Math.max(DEFAULT_INSIGHT_GROUP_LIMIT, state.insightGroupLimit);
      const visibleGroups = filteredGroups.length <= groupLimit ? filteredGroups : filteredGroups.slice(0, groupLimit);
      const allOpen = visibleGroups.length > 0 && visibleGroups.every(group => isInsightGroupOpen(group, visibleGroups.length));
      toggleAllEl.setAttribute('aria-expanded', allOpen ? 'true' : 'false');
      toggleAllEl.textContent = allOpen ? '全部收起' : '全部展开';
    }
  },
  true
);
element('analysis-insights-summary').addEventListener('click', event => {
  if (!insightsCollapsible) {
    event.preventDefault();
    return;
  }
  const disclosureEl = /** @type {HTMLDetailsElement} */ (element('analysis-insights-disclosure'));
  const nextCollapsed = Boolean(disclosureEl.open);
  state.insightsCollapsed = nextCollapsed;
  element('analysis-insights')?.classList?.toggle?.('is-collapsed', nextCollapsed);
  element('analysis-insights-toggle-hint').textContent = nextCollapsed ? '展开' : '收起';
});
element('analysis-insights-disclosure').addEventListener('toggle', () => {
  const disclosureEl = /** @type {HTMLDetailsElement} */ (element('analysis-insights-disclosure'));
  if (!insightsCollapsible) {
    disclosureEl.open = false;
    return;
  }
  const collapsed = !disclosureEl.open;
  state.insightsCollapsed = collapsed;
  element('analysis-insights')?.classList?.toggle?.('is-collapsed', collapsed);
  element('analysis-insights-toggle-hint').textContent = collapsed ? '展开' : '收起';
});
document.addEventListener('keydown', event => {
  if (!event.defaultPrevented && event.key === 'Escape' && (state.selectedId || state.activeInsightId)) {
    selectObservation(null);
  }
});
app.on('mini-bench:refresh', loadObservations);
app.on('mini-bench:observations-changed', () => {
  if (element('analysis-view')?.hidden) return;
  return loadObservations();
});
let lastBankVersion = app.bank?.version ?? null;
app.on('mini-bench:banks-changed', event => {
  const nextVersion = event.detail?.version ?? null;
  if (lastBankVersion !== null && nextVersion !== lastBankVersion) {
    state.selectedId = null;
    state.disclosure = null;
    state.historyIds.clear();
    chart.resetZoom();
  }
  lastBankVersion = nextVersion;
  model.setBank(event.detail);
  rebuildAnalysisRecords();
});
app.on('mini-bench:theme-changed', renderObservations);
app.on('mini-bench:mask-accounts-changed', renderObservations);
app.on('mini-bench:history-changed', () => {
  const next = presentedRecords();
  const changed = next.length !== state.records.length || next.some((record, index) => record.task_id !== state.records[index]?.task_id);
  state.records = next;
  if (changed) renderObservations();
});
app.on('mini-bench:view', event => {
  if (event.detail === 'analysis') {
    if (pendingAnalysisRender) renderObservations();
    loadObservations();
  }
});
new MutationObserver(renderObservations).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderObservations);
rebuildAnalysisRecords();
if (available) loadObservations();
