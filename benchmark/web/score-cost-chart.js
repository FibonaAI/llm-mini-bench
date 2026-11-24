/* Native SVG chart; metric calculation belongs to the observation adapter. */
import { buildAnalysisHistoryStates } from './analysis-history.js';
import { chartCategory, createChartColorRegistry } from './chart-colors.js';
import { buildChartLegendGroups, createChartLegend } from './chart-legend.js';
import { placeChartLabels, placeThinkingLabels } from './chart-layout.js';
import { formatChartRecordTime, summarizeChartRecordTimes } from './chart-point-time.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
let chartSequence = 0;
const money = value =>
  '$' +
  (value === 0
    ? '0'
    : value < 0.01
      ? Number(value.toPrecision(2)).toString()
      : value < 1
        ? Number(value.toFixed(3)).toString()
        : Number(value.toFixed(2)).toString());
const sourceLabel = point => (point.source === 'baseline' ? '基线' : '我的运行');
const validNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function compactTokens(value) {
  if (!validNonnegative(value)) return '未记录';
  if (value >= 1e6) return Number((value / 1e6).toFixed(2)).toString() + 'M';
  if (value >= 1e4) return Number((value / 1e3).toFixed(1)).toString() + 'k';
  return Math.round(value).toLocaleString('zh-CN');
}
function formatDuration(seconds) {
  if (!validNonnegative(seconds)) return '未记录';
  if (seconds < 60) return Number(seconds.toFixed(seconds < 10 ? 1 : 0)).toString() + 's';
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60),
    remSeconds = totalSeconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60),
    remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}
function roundMetrics(point) {
  const original = point.original ?? point;
  const rounds =
    Number.isInteger(point.rounds) && point.rounds > 0
      ? point.rounds
      : Number.isInteger(original.rounds) && original.rounds > 0
        ? original.rounds
        : null;
  const accounting = original.usage_accounting;
  const elapsed = validNonnegative(original.elapsed_seconds)
    ? original.elapsed_seconds
    : (() => {
        const samples = (original.tasks || []).flatMap(task => task?.samples || []);
        return samples.length && samples.every(sample => validNonnegative(sample?.elapsed_seconds))
          ? samples.reduce((sum, sample) => sum + sample.elapsed_seconds, 0)
          : null;
      })();
  const durationText = rounds && validNonnegative(elapsed) ? formatDuration(elapsed / rounds) : '未记录';
  const costText =
    rounds && validNonnegative(original.estimated_cost_usd)
      ? money(original.estimated_cost_usd / rounds)
      : rounds &&
          Number.isInteger(accounting?.unknown_cost_attempts) &&
          accounting.unknown_cost_attempts > 0 &&
          validNonnegative(accounting?.estimated_cost_usd_lower_bound)
        ? '≥ ' + money(accounting.estimated_cost_usd_lower_bound / rounds)
        : '未记录';
  const tokenTotal =
    validNonnegative(original.usage?.input_tokens) && validNonnegative(original.usage?.output_tokens)
      ? original.usage.input_tokens + original.usage.output_tokens
      : null;
  const tokenBound =
    validNonnegative(accounting?.usage_lower_bound?.input_tokens) && validNonnegative(accounting?.usage_lower_bound?.output_tokens)
      ? accounting.usage_lower_bound.input_tokens + accounting.usage_lower_bound.output_tokens
      : null;
  const tokenText =
    rounds && validNonnegative(tokenTotal)
      ? compactTokens(tokenTotal / rounds)
      : rounds &&
          Number.isInteger(accounting?.unknown_usage_attempts) &&
          accounting.unknown_usage_attempts > 0 &&
          validNonnegative(tokenBound)
        ? '≥ ' + compactTokens(tokenBound / rounds)
        : '未记录';
  return { durationText, costText, tokenText };
}
const allowZeroOnAxis = (log, axis = 'cost') => !log || axis === 'cost';
const validPoint = (record, log, axis = 'cost') =>
  Number.isFinite(record.score) &&
  record.score >= 0 &&
  record.score <= 100 &&
  Number.isFinite(record.cost) &&
  (allowZeroOnAxis(log, axis) ? record.cost >= 0 : record.cost > 0);

/** Score axis floor snaps below the lowest plotted score so clustered results stay distinguishable. */
export function scoreAxisDomain(scores) {
  const finiteScores = scores.filter(score => Number.isFinite(score));
  if (!finiteScores.length) return { min: 0, step: 20 };
  const lowest = Math.min(...finiteScores);
  const min = Math.max(0, Math.min(90, Math.floor((lowest - 2) / 10) * 10));
  const span = 100 - min;
  return { min, step: span <= 20 ? 5 : span <= 50 ? 10 : 20 };
}

/** Collect human-readable anomaly reasons for one plotted point; keeps compatibility with direct usageIncomplete points. */
function pointAnomalyReasons(point) {
  if (Array.isArray(point.anomalies?.items) && point.anomalies.items.length) return point.anomalies.items;
  if (point.usageIncomplete) {
    return [`用量不完整：${point.usageIncomplete.unknownAttempts} 次请求尝试未返回用量（超时或上游错误），横坐标按已知下限绘制`];
  }
  return [];
}
const hasPointAnomalies = point => pointAnomalyReasons(point).length > 0 || Boolean(point.usageIncomplete);

/** Pareto frontier minimizes the selected usage axis and maximizes score; zero-cost/usage records are excluded and equal-usage lower scores are dominated. */
export function scoreCostFrontier(records) {
  const eligible = records.filter(point => Number.isFinite(point.cost) && point.cost > 0);
  return eligible
    .filter(
      point =>
        !eligible.some(
          other => other.cost <= point.cost && other.score >= point.score && (other.cost < point.cost || other.score > point.score)
        )
    )
    .sort((a, b) => a.cost - b.cost);
}

function thinkingGroupKey(point) {
  return JSON.stringify([
    point.source,
    point.bank_version,
    point.bank_scope,
    point.task_id || point.run_id || point.id,
    point.model,
    point.providerId,
    point.accountId
  ]);
}

/** Connect unique Thinking levels only within one recorded batch, model, channel and account. */
export function thinkingSeries(records) {
  const order = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const groups = new Map();
  for (const point of records) {
    const batch = point.task_id || point.run_id;
    if (!batch || !order.includes(point.think)) continue;
    const key = thinkingGroupKey(point);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }
  return [...groups.values()]
    .filter(points => points.length > 1 && new Set(points.map(point => point.think)).size === points.length)
    .map(points => points.sort((a, b) => order.indexOf(a.think) - order.indexOf(b.think)));
}

const CHART_SYSTEM_ACCOUNTS = new Set([
  'default',
  'gateway-default',
  'unknown',
  'unknown-account',
  '未记录',
  '未记录账号',
  '实际账号未记录',
  '网关自动分配',
  '网关自动分配（账号未记录）',
  '网关自动分配（实际账号未记录）',
  '自动分配',
  '默认'
]);
function maskChartAccountBullets(value) {
  const raw = String(value ?? '').trim();
  if (!raw || CHART_SYSTEM_ACCOUNTS.has(raw) || CHART_SYSTEM_ACCOUNTS.has(raw.toLowerCase()) || /^•+$/u.test(raw))
    return String(value ?? '');
  const suffixed = /^(.+?)(（(?:固定绑定|配置绑定|未核验)）)$/.exec(raw);
  if (suffixed) {
    const inner = suffixed[1];
    if (CHART_SYSTEM_ACCOUNTS.has(inner) || CHART_SYSTEM_ACCOUNTS.has(inner.toLowerCase())) return raw;
    const maskedInner = inner.includes('@') ? inner.replace(/[^@.\s]/gu, '•') : inner.replace(/[^\s]/gu, '•');
    return maskedInner + suffixed[2];
  }
  return raw.includes('@') ? raw.replace(/[^@.\s]/gu, '•') : raw.replace(/[^\s]/gu, '•');
}

function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Native score / cost / tokens / duration scatter plot. render is synchronous; exportSvg returns standalone SVG text. */
export function createScoreCostChart(container, { onSelect = _id => {}, onOpenRun = _runId => {}, catalog = [] } = {}) {
  const colors = createChartColorRegistry(catalog);
  container.classList.add('score-cost-chart');
  const clipId = `score-cost-clip-${++chartSequence}`;
  const svg = svgNode('svg', { class: 'score-cost-svg', role: 'group', 'aria-label': '分数与费用散点图' });
  const tooltip = document.createElement('div');
  tooltip.className = 'score-cost-tooltip';
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip');
  container.append(svg, tooltip);
  const legend = createChartLegend(container, `${clipId}-legend`);
  let records = [],
    options = { log: true, labels: true, pareto: true, axis: 'cost', colorBy: 'series', selectedIds: [], maskAccounts: false };
  let zoomWindow = null,
    viewState = null,
    pinnedPointId = null,
    hoveredPointId = null,
    pan = null,
    suppressPlotClick = false,
    showPointTooltipById = new Map(),
    highlightSeriesFn = _key => {},
    crosshairCtrl = null,
    disposed = false,
    resizeFrame = null,
    drawnWidth = null;

  const DURATION_TICKS = [
    1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 5400, 7200, 10800, 14400, 21600, 28800, 43200
  ];

  function unpinTooltip({ notifySelect = false } = {}) {
    const hadSelection = Boolean(pinnedPointId || options.selectedIds.length);
    pinnedPointId = null;
    tooltip.hidden = true;
    tooltip.classList?.remove?.('is-pinned');
    highlightSeriesFn(null);
    crosshairCtrl?.hide();
    if (notifySelect && hadSelection) onSelect(null);
  }

  function svgPointFromEvent(event) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height || !viewState) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * viewState.width,
      y: ((event.clientY - rect.top) / rect.height) * viewState.height
    };
  }

  function clampZoomWindow(next, state) {
    const fullXSpan = Math.max(1e-9, state.fullUpper - state.fullLower);
    const fullYSpan = Math.max(1, state.fullYMax - state.fullYMin);
    const minXSpan = fullXSpan / 64;
    const minYSpan = Math.min(fullYSpan, 2);
    let xSpan = Math.max(minXSpan, Math.min(fullXSpan, next.xMax - next.xMin));
    let ySpan = Math.max(minYSpan, Math.min(fullYSpan, next.yMax - next.yMin));
    let xMin = next.xMin;
    let xMax = xMin + xSpan;
    if (xMin < state.fullLower) {
      xMin = state.fullLower;
      xMax = xMin + xSpan;
    }
    if (xMax > state.fullUpper) {
      xMax = state.fullUpper;
      xMin = Math.max(state.fullLower, xMax - xSpan);
    }
    let yMin = next.yMin;
    let yMax = yMin + ySpan;
    if (yMin < state.fullYMin) {
      yMin = state.fullYMin;
      yMax = yMin + ySpan;
    }
    if (yMax > state.fullYMax) {
      yMax = state.fullYMax;
      yMin = Math.max(state.fullYMin, yMax - ySpan);
    }
    if (xMax - xMin >= fullXSpan * 0.995 && yMax - yMin >= fullYSpan * 0.995) return null;
    return { xMin, xMax, yMin, yMax };
  }

  function onWheel(event) {
    if (disposed || !viewState?.hasPoints) return;
    const pt = svgPointFromEvent(event);
    if (!pt) return;
    const { margin, plotWidth, plotHeight, lower, upper, yMin, yMax } = viewState;
    if (pt.x < margin.left || pt.x > margin.left + plotWidth || pt.y < margin.top || pt.y > margin.top + plotHeight) return;
    event.preventDefault();
    clearPan();
    const fx = (pt.x - margin.left) / plotWidth;
    const fy = (pt.y - margin.top) / plotHeight;
    const anchorX = lower + fx * (upper - lower);
    const anchorY = yMax - fy * (yMax - yMin);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 120 : event.deltaY;
    const factor = Math.exp(Math.max(-0.5, Math.min(0.5, delta * 0.0022)));
    const newXSpan = (upper - lower) * factor;
    const newYSpan = (yMax - yMin) * factor;
    zoomWindow = clampZoomWindow(
      {
        xMin: anchorX - fx * newXSpan,
        xMax: anchorX + (1 - fx) * newXSpan,
        yMin: anchorY - (1 - fy) * newYSpan,
        yMax: anchorY + fy * newYSpan
      },
      viewState
    );
    drawChart();
  }

  function clearPan() {
    pan = null;
    svg.classList?.remove?.('is-panning');
  }

  function onPointerDown(event) {
    if (disposed || event.button !== 0 || !viewState) return;
    suppressPlotClick = false;
    const startedOnPoint = Boolean(event.target?.closest?.('.score-cost-point'));
    if (!zoomWindow || !viewState.hasPoints) {
      if (!startedOnPoint && pinnedPointId) {
        pan = { pointerId: event.pointerId, unpinOnly: true, startedOnPoint: false, active: false };
      }
      return;
    }
    const pt = svgPointFromEvent(event);
    if (!pt) return;
    const { margin, plotWidth, plotHeight } = viewState;
    if (pt.x < margin.left || pt.x > margin.left + plotWidth || pt.y < margin.top || pt.y > margin.top + plotHeight) {
      if (!startedOnPoint && pinnedPointId) {
        pan = { pointerId: event.pointerId, unpinOnly: true, startedOnPoint: false, active: false };
      }
      return;
    }
    pan = {
      pointerId: event.pointerId,
      startX: pt.x,
      startY: pt.y,
      startWindow: { ...zoomWindow },
      state: { ...viewState },
      startedOnPoint,
      active: false,
      unpinOnly: false
    };
  }

  function onPointerMove(event) {
    if (disposed || !viewState) return;
    if (pan && !pan.unpinOnly) {
      if (pan.pointerId !== undefined && event.pointerId !== undefined && pan.pointerId !== event.pointerId) return;
      const pt = svgPointFromEvent(event);
      if (!pt) return;
      const dx = pt.x - pan.startX;
      const dy = pt.y - pan.startY;
      if (!pan.active && Math.hypot(dx, dy) >= 4) {
        pan.active = true;
        svg.classList?.add?.('is-panning');
        try {
          svg.setPointerCapture?.(event.pointerId);
        } catch {
          /* Synthetic events may not carry a capturable pointerId. */
        }
      }
      if (!pan.active) return;
      const { plotWidth, plotHeight } = pan.state;
      const xSpan = pan.startWindow.xMax - pan.startWindow.xMin;
      const ySpan = pan.startWindow.yMax - pan.startWindow.yMin;
      const deltaX = -(dx / plotWidth) * xSpan;
      const deltaY = (dy / plotHeight) * ySpan;
      const nextWindow = clampZoomWindow(
        {
          xMin: pan.startWindow.xMin + deltaX,
          xMax: pan.startWindow.xMax + deltaX,
          yMin: pan.startWindow.yMin + deltaY,
          yMax: pan.startWindow.yMax + deltaY
        },
        pan.state
      );
      if (nextWindow) {
        zoomWindow = nextWindow;
        drawChart();
      }
      return;
    }
    if (!viewState.hasPoints || pinnedPointId || hoveredPointId) return;
    const pt = svgPointFromEvent(event);
    if (!pt) return;
    const { margin, plotWidth, plotHeight } = viewState;
    if (pt.x < margin.left || pt.x > margin.left + plotWidth || pt.y < margin.top || pt.y > margin.top + plotHeight) {
      crosshairCtrl?.hide();
      return;
    }
    crosshairCtrl?.showAt(pt.x, pt.y);
  }

  function onPointerLeave() {
    hoveredPointId = null;
    if (!pinnedPointId) crosshairCtrl?.hide();
  }

  function onPointerUp(event) {
    if (!pan) return;
    if (pan.pointerId !== undefined && event.pointerId !== undefined && pan.pointerId !== event.pointerId) return;
    const current = pan;
    if (current.active) {
      try {
        svg.releasePointerCapture?.(event.pointerId);
      } catch {
        /* Ignore release errors for synthetic pointer events. */
      }
      suppressPlotClick = Boolean(current.startedOnPoint);
    }
    clearPan();
    if (!current.active && !current.startedOnPoint && pinnedPointId) {
      unpinTooltip({ notifySelect: true });
    }
  }

  function onSvgClick() {
    suppressPlotClick = false;
  }

  function onDoubleClick(event) {
    if (disposed || event.target?.closest?.('.score-cost-point')) return;
    if (zoomWindow) {
      clearPan();
      zoomWindow = null;
      drawChart();
    }
  }

  function onDocumentKeyDown(event) {
    if (!disposed && event.key === 'Escape' && pinnedPointId) {
      unpinTooltip({ notifySelect: true });
    }
  }

  svg.addEventListener?.('wheel', onWheel, { passive: false });
  svg.addEventListener?.('pointerdown', onPointerDown);
  svg.addEventListener?.('pointermove', onPointerMove);
  svg.addEventListener?.('pointerleave', onPointerLeave);
  svg.addEventListener?.('pointerup', onPointerUp);
  svg.addEventListener?.('pointercancel', clearPan);
  svg.addEventListener?.('click', onSvgClick);
  svg.addEventListener?.('dblclick', onDoubleClick);
  document.addEventListener?.('keydown', onDocumentKeyDown);

  function drawChart() {
    if (disposed) return;
    hoveredPointId = null;
    crosshairCtrl = null;
    tooltip.hidden = true;
    tooltip.classList?.remove?.('is-pinned');
    showPointTooltipById = new Map();
    drawnWidth = container.clientWidth;
    const width = Math.max(240, drawnWidth || 900);
    const mobile = width < 600;
    const height = mobile ? 380 : 400;
    const margin = { left: mobile ? 43 : 58, right: mobile ? 18 : 34, top: 38, bottom: 58 };
    const plotWidth = width - margin.left - margin.right,
      plotHeight = height - margin.top - margin.bottom;
    const style = getComputedStyle(container);
    const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const theme = {
      fg: token('--fg', '#1c1c21'),
      secondary: token('--fg-2', '#4b4b53'),
      muted: token('--muted', '#85858d'),
      line: token('--line-2', '#ececf0'),
      axis: token('--line', '#e3e3e8'),
      card: token('--card', '#fff'),
      accent: token('--accent', '#4f46e5'),
      accentFg: token('--accent-fg', '#fff'),
      amber: token('--amber', '#b45309')
    };
    const explicitTheme = document.documentElement.dataset.theme;
    const dark = explicitTheme === 'dark' || (!explicitTheme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const colorBy = ['series', 'account', 'model', 'family', 'time'].includes(options.colorBy) ? options.colorBy : 'series';
    const historyRecords = options.historyRecords ?? records;
    const historyStates = buildAnalysisHistoryStates(historyRecords);
    colors.register(historyRecords, colorBy);
    const color = record => colors.color(record, colorBy, dark);
    svg.setAttribute('data-color-by', colorBy);
    const quantity = value =>
      options.axis === 'tokens'
        ? Number(value.toFixed(1)).toLocaleString('zh-CN')
        : options.axis === 'duration'
          ? formatDuration(value)
          : money(value);
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif');
    svg.setAttribute('font-size', '12');
    svg.append(svgNode('rect', { width, height, fill: theme.card }));
    const points = records.filter(record => validPoint(record, options.log, options.axis));
    const costs = points.map(point => point.cost);
    const positiveCosts = costs.filter(cost => cost > 0);
    const transform = value => (options.log ? Math.log10(value) : value);
    const inverse = value => (options.log ? 10 ** value : value);
    const logMin = Math.log10(positiveCosts.length ? Math.min(...positiveCosts) : 0.01);
    const logMax = Math.log10(positiveCosts.length ? Math.max(...positiveCosts) : 0.1);
    const logPadding = Math.max(0.12, (logMax - logMin) * 0.1);
    let fullLower = options.log ? logMin - logPadding : 0;
    let fullUpper = options.log ? logMax + logPadding : Math.max(...costs, 0.1) * 1.12;
    if (fullLower === fullUpper) fullUpper = fullLower + 1;
    const pointXValue = cost => (options.log && cost === 0 ? fullLower : transform(cost));
    const { min: fullYMin, step: fullYStep } = scoreAxisDomain(points.map(point => point.score));
    const fullYMax = 100;
    if (zoomWindow) {
      zoomWindow = clampZoomWindow(zoomWindow, { fullLower, fullUpper, fullYMin, fullYMax });
    }
    svg.classList?.toggle?.('is-pannable', Boolean(zoomWindow && points.length));
    svg.classList?.toggle?.('is-panning', Boolean(pan?.active));
    const lower = zoomWindow ? zoomWindow.xMin : fullLower;
    const upper = zoomWindow ? zoomWindow.xMax : fullUpper;
    const yMin = zoomWindow ? zoomWindow.yMin : fullYMin;
    const yMax = zoomWindow ? zoomWindow.yMax : fullYMax;
    viewState = {
      width,
      height,
      margin,
      plotWidth,
      plotHeight,
      lower,
      upper,
      yMin,
      yMax,
      fullLower,
      fullUpper,
      fullYMin,
      fullYMax,
      hasPoints: points.length > 0
    };
    const x = cost => margin.left + ((pointXValue(cost) - lower) / (upper - lower)) * plotWidth;
    const y = score => margin.top + ((yMax - score) / Math.max(1e-9, yMax - yMin)) * plotHeight;
    const text = (label, px, py, attrs = {}) => svg.appendChild(svgNode('text', { x: px, y: py, fill: theme.secondary, ...attrs }, label));
    const line = (x1, y1, x2, y2, attrs = {}) => svg.appendChild(svgNode('line', { x1, y1, x2, y2, stroke: theme.line, ...attrs }));
    text('均分 / 100', margin.left, 19, { 'font-weight': 600 });
    text('越高越好', width - margin.right, 19, { 'text-anchor': 'end', fill: theme.muted, 'font-size': 11 });
    const ySpan = yMax - yMin;
    const scoreStep = zoomWindow ? (ySpan <= 5 ? 1 : ySpan <= 12 ? 2 : ySpan <= 30 ? 5 : ySpan <= 60 ? 10 : 20) : fullYStep;
    const firstScoreTick = zoomWindow ? Math.ceil(yMin / scoreStep) * scoreStep : fullYMin;
    for (let score = firstScoreTick; score <= yMax + 1e-6; score += scoreStep) {
      const clamped = Math.min(100, Math.round(score * 100) / 100);
      line(margin.left, y(clamped), width - margin.right, y(clamped));
      text(clamped, margin.left - 12, y(clamped) + 4, { 'text-anchor': 'end', fill: theme.muted, 'font-size': 11 });
    }
    let ticks = [];
    if (options.axis === 'duration') {
      if (options.log) {
        ticks = DURATION_TICKS.filter(value => transform(value) >= lower - 1e-9 && transform(value) <= upper + 1e-9);
      } else {
        const roughStep = (upper - lower) / (mobile ? 4 : 7);
        const step = DURATION_TICKS.find(n => n >= roughStep) ?? Math.ceil(roughStep / 3600) * 3600;
        for (let tick = Math.ceil(lower / step) * step; tick <= upper + step * 0.001; tick += step) ticks.push(tick);
      }
    }
    if (!ticks.length) {
      if (options.log) {
        for (let power = Math.floor(lower); power <= Math.ceil(upper); power++)
          for (const multiple of [1, 2, 5]) {
            const value = multiple * 10 ** power;
            if (transform(value) >= lower - 1e-9 && transform(value) <= upper + 1e-9) ticks.push(value);
          }
      } else {
        const roughStep = (upper - lower) / (mobile ? 4 : 7);
        const unit = 10 ** Math.floor(Math.log10(roughStep));
        const step = [1, 2, 5, 10].find(n => n * unit >= roughStep) * unit;
        for (let tick = Math.ceil(lower / step) * step; tick <= upper + step * 0.001; tick += step) ticks.push(tick);
      }
    }
    if (ticks.length < 2) ticks = [inverse(lower), inverse((upper + lower) / 2), inverse(upper)];
    const hasVisibleZeroOnLogAxis =
      options.log &&
      options.axis === 'cost' &&
      lower <= fullLower + 1e-9 &&
      points.some(point => point.cost === 0 && point.score >= yMin - 1e-9 && point.score <= yMax + 1e-9);
    let lastTickX = -Infinity;
    if (hasVisibleZeroOnLogAxis) {
      line(margin.left, margin.top, margin.left, height - margin.bottom, { stroke: theme.axis });
      text(quantity(0), margin.left, height - margin.bottom + 23, { 'text-anchor': 'middle', fill: theme.muted, 'font-size': 11 });
      lastTickX = margin.left;
    }
    for (const cost of ticks) {
      const px = x(cost);
      if (px - lastTickX < (mobile ? 58 : 65)) continue;
      line(px, margin.top, px, height - margin.bottom, { 'stroke-dasharray': '2 5' });
      text(quantity(cost), px, height - margin.bottom + 23, { 'text-anchor': 'middle', fill: theme.muted, 'font-size': 11 });
      lastTickX = px;
    }
    line(margin.left, height - margin.bottom, width - margin.right, height - margin.bottom, { stroke: theme.axis });
    const axisLabel = options.axis === 'tokens' ? '总 tokens（输入 + 输出）' : options.axis === 'duration' ? '平均耗时' : '平均费用 / USD';
    text(
      `${axisLabel} · 每轮${options.taskCount ? options.taskCount + '题' : '全部题目'}${options.log ? ' · 对数' : ' · 线性'}`,
      margin.left + plotWidth / 2,
      height - 10,
      { 'text-anchor': 'middle', 'font-size': 11 }
    );
    const defs = svgNode('defs'),
      clip = svgNode('clipPath', { id: clipId });
    clip.append(svgNode('rect', { x: margin.left - 12, y: margin.top - 13, width: plotWidth + 24, height: plotHeight + 26 }));
    defs.append(clip);
    svg.append(defs);
    const crosshair = svgNode('g', {
      class: 'score-cost-crosshair',
      'pointer-events': 'none',
      'data-visible': 'false',
      'data-pinned': 'false',
      display: 'none'
    });
    const crosshairH = svgNode('line', {
      class: 'score-cost-crosshair-line score-cost-crosshair-h',
      x1: margin.left,
      x2: width - margin.right,
      y1: margin.top,
      y2: margin.top,
      stroke: theme.muted,
      'stroke-width': 1,
      'stroke-dasharray': '4 4',
      opacity: 0.75
    });
    const crosshairV = svgNode('line', {
      class: 'score-cost-crosshair-line score-cost-crosshair-v',
      x1: margin.left,
      x2: margin.left,
      y1: margin.top,
      y2: height - margin.bottom,
      stroke: theme.muted,
      'stroke-width': 1,
      'stroke-dasharray': '4 4',
      opacity: 0.75
    });
    const yBadgeBg = svgNode('rect', { class: 'score-cost-crosshair-badge', rx: 4, fill: theme.secondary });
    const yBadgeText = svgNode('text', {
      class: 'score-cost-crosshair-label score-cost-crosshair-y-label',
      'text-anchor': 'middle',
      fill: theme.card,
      'font-size': 10.5,
      'font-weight': 600
    });
    const xBadgeBg = svgNode('rect', { class: 'score-cost-crosshair-badge', rx: 4, fill: theme.secondary });
    const xBadgeText = svgNode('text', {
      class: 'score-cost-crosshair-label score-cost-crosshair-x-label',
      'text-anchor': 'middle',
      fill: theme.card,
      'font-size': 10.5,
      'font-weight': 600
    });
    crosshair.append(crosshairH, crosshairV, yBadgeBg, yBadgeText, xBadgeBg, xBadgeText);
    svg.append(crosshair);
    const formatCrosshairX = value =>
      options.axis === 'tokens' ? compactTokens(value) : options.axis === 'duration' ? formatDuration(value) : money(value);
    const updateCrosshair = (px, py, { pinned = false, recordId = '', scoreLabel = null, xLabel = null } = {}) => {
      const cx = Math.max(margin.left, Math.min(width - margin.right, px));
      const cy = Math.max(margin.top, Math.min(height - margin.bottom, py));
      const strokeColor = pinned ? theme.accent : theme.muted;
      const strokeWidth = pinned ? 1.25 : 1;
      const dash = pinned ? '5 3' : '4 4';
      const lineOpacity = pinned ? 0.9 : 0.75;
      const badgeBg = pinned ? theme.accent : theme.secondary;
      const badgeFg = pinned ? theme.accentFg : theme.card;
      crosshairH.setAttribute('y1', cy);
      crosshairH.setAttribute('y2', cy);
      crosshairH.setAttribute('stroke', strokeColor);
      crosshairH.setAttribute('stroke-width', strokeWidth);
      crosshairH.setAttribute('stroke-dasharray', dash);
      crosshairH.setAttribute('opacity', lineOpacity);
      crosshairV.setAttribute('x1', cx);
      crosshairV.setAttribute('x2', cx);
      crosshairV.setAttribute('stroke', strokeColor);
      crosshairV.setAttribute('stroke-width', strokeWidth);
      crosshairV.setAttribute('stroke-dasharray', dash);
      crosshairV.setAttribute('opacity', lineOpacity);
      const rawScore = Math.max(0, Math.min(100, yMax - ((cy - margin.top) / plotHeight) * (yMax - yMin)));
      const yText = scoreLabel ?? rawScore.toFixed(1);
      const xVal = lower + ((cx - margin.left) / plotWidth) * (upper - lower);
      const rawCost = hasVisibleZeroOnLogAxis && Math.abs(cx - margin.left) < 1.5 ? 0 : Math.max(0, inverse(xVal));
      const xText = xLabel ?? formatCrosshairX(rawCost);
      crosshair.setAttribute('data-visible', 'true');
      crosshair.setAttribute('data-pinned', String(Boolean(pinned)));
      crosshair.setAttribute('data-record-id', recordId);
      crosshair.setAttribute('display', 'inline');
      yBadgeText.textContent = yText;
      const yTextW = Math.max(24, yBadgeText.getComputedTextLength?.() || yText.length * 7);
      const yBadgeW = Math.min(margin.left - 4, Math.ceil(yTextW + 12));
      const yBadgeH = 18;
      const yBadgeX = Math.max(1, margin.left - yBadgeW - 4);
      const yBadgeY = Math.max(margin.top - yBadgeH / 2, Math.min(height - margin.bottom - yBadgeH / 2, cy - yBadgeH / 2));
      yBadgeBg.setAttribute('x', yBadgeX);
      yBadgeBg.setAttribute('y', yBadgeY);
      yBadgeBg.setAttribute('width', yBadgeW);
      yBadgeBg.setAttribute('height', yBadgeH);
      yBadgeBg.setAttribute('fill', badgeBg);
      yBadgeText.setAttribute('x', yBadgeX + yBadgeW / 2);
      yBadgeText.setAttribute('y', yBadgeY + 12.5);
      yBadgeText.setAttribute('fill', badgeFg);
      xBadgeText.textContent = xText;
      const xTextW = Math.max(28, xBadgeText.getComputedTextLength?.() || xText.length * 7);
      const xBadgeW = Math.ceil(xTextW + 14);
      const xBadgeH = 18;
      const xBadgeX = Math.max(margin.left, Math.min(width - margin.right - xBadgeW, cx - xBadgeW / 2));
      const xBadgeY = height - margin.bottom + 8;
      xBadgeBg.setAttribute('x', xBadgeX);
      xBadgeBg.setAttribute('y', xBadgeY);
      xBadgeBg.setAttribute('width', xBadgeW);
      xBadgeBg.setAttribute('height', xBadgeH);
      xBadgeBg.setAttribute('fill', badgeBg);
      xBadgeText.setAttribute('x', xBadgeX + xBadgeW / 2);
      xBadgeText.setAttribute('y', xBadgeY + 12.5);
      xBadgeText.setAttribute('fill', badgeFg);
    };
    const hideCrosshair = () => {
      crosshair.setAttribute('data-visible', 'false');
      crosshair.setAttribute('data-pinned', 'false');
      crosshair.setAttribute('data-record-id', '');
      crosshair.setAttribute('display', 'none');
    };
    crosshairCtrl = {
      showAt: (px, py) => updateCrosshair(px, py),
      showPoint: (point, px, py, pinned) =>
        updateCrosshair(px, py, {
          pinned,
          recordId: point.id,
          scoreLabel: point.score.toFixed(1),
          xLabel: `${point.usageIncomplete ? '≥ ' : ''}${formatCrosshairX(point.cost)}`
        }),
      hide: hideCrosshair
    };
    const plotted = svgNode('g', { 'clip-path': `url(#${clipId})` });
    svg.append(plotted);
    const hoverLabels = svgNode('g', { class: 'thinking-hover-labels', 'pointer-events': 'none' });
    svg.append(hoverLabels);
    const visible = points.filter(
      point =>
        pointXValue(point.cost) >= lower - 1e-9 &&
        pointXValue(point.cost) <= upper + 1e-9 &&
        point.score >= yMin - 1e-9 &&
        point.score <= yMax + 1e-9
    );
    const visibleSeries = new Map(thinkingSeries(visible).map(series => [thinkingGroupKey(series[0]), series]));
    const seriesNodes = [],
      pointNodes = [],
      labelNodes = [];
    let activeHoverLabelBoxes = [];
    const highlightSeries = hoveredKey => {
      const key = visibleSeries.has(hoveredKey) ? hoveredKey : null;
      const selectedKey = [...visibleSeries].find(([, series]) => series.some(point => options.selectedIds.includes(point.id)))?.[0];
      const activeKey = key ?? selectedKey;
      hoverLabels.replaceChildren();
      activeHoverLabelBoxes = [];
      if (activeKey) {
        const candidates = visibleSeries.get(activeKey).map(point => {
          const label = svgNode(
            'text',
            {
              class: 'thinking-level-label',
              'data-thinking-record': point.id,
              fill: color(point),
              'font-size': 11,
              'font-weight': 600,
              'paint-order': 'stroke',
              stroke: theme.card,
              'stroke-width': 4
            },
            point.think
          );
          hoverLabels.append(label);
          return { id: point.id, point, node: label, width: label.getComputedTextLength(), x: x(point.cost), y: y(point.score) };
        });
        const layout = new Map(
          placeThinkingLabels(candidates, {
            left: margin.left,
            right: width - margin.right,
            top: margin.top + 2,
            bottom: height - margin.bottom - 3
          }).map(item => [item.id, item])
        );
        activeHoverLabelBoxes = [...layout.values()].map(item => ({
          left: item.box.x - 4,
          right: item.box.x + item.box.w + 4,
          top: item.box.y - 4,
          bottom: item.box.y + item.box.h + 4
        }));
        for (const candidate of candidates) {
          const item = layout.get(candidate.id);
          if (!item) {
            candidate.node.remove();
            continue;
          }
          candidate.node.setAttribute('x', item.box.x);
          candidate.node.setAttribute('y', item.box.y + 12);
          const leader = svgNode('line', {
            class: 'thinking-label-anchor',
            'data-thinking-record': item.id,
            x1: item.x,
            y1: item.y,
            x2: item.endX,
            y2: item.endY,
            stroke: color(item.point),
            'stroke-width': 0.8,
            opacity: 0.75
          });
          hoverLabels.insertBefore(leader, candidate.node);
        }
      }
      for (const [node, seriesKey, selected] of seriesNodes) {
        const active = seriesKey === activeKey;
        node.setAttribute('opacity', active ? 0.95 : 0);
        node.setAttribute('stroke-width', active ? 2.5 : 1.2);
        node.setAttribute('data-hover-highlight', Boolean(key && active));
        node.setAttribute('data-legend-highlight', false);
      }
      for (const [node, seriesKey] of pointNodes) {
        node.setAttribute('opacity', key && seriesKey !== key ? 0.18 : 1);
        node.setAttribute('data-legend-highlight', false);
      }
      for (const [node] of labelNodes) node.setAttribute('opacity', activeKey ? 0 : 1);
    };
    for (const series of visibleSeries.values()) {
      const selected = series.some(point => options.selectedIds.includes(point.id));
      const node = svgNode('polyline', {
        class: 'thinking-series',
        'data-series-selected': selected,
        points: series.map(point => `${x(point.cost)},${y(point.score)}`).join(' '),
        fill: 'none',
        stroke: color(series[0]),
        'stroke-width': selected ? 2 : 1.2,
        opacity: selected ? 0.9 : 0,
        'pointer-events': 'none'
      });
      seriesNodes.push([node, thinkingGroupKey(series[0]), selected, series[0]]);
      plotted.append(node);
    }
    const frontier = scoreCostFrontier(visible.filter(point => !hasPointAnomalies(point) && point.cost > 0));
    const frontierIds = new Set(frontier.map(point => point.id));
    highlightSeriesFn = highlightSeries;
    if (options.pareto && frontier.length)
      plotted.append(
        svgNode('polyline', {
          class: 'pareto-frontier',
          points: [
            ...frontier.map(point => `${x(point.cost)},${y(point.score)}`),
            `${width - margin.right},${y(frontier.at(-1).score)}`
          ].join(' '),
          fill: 'none',
          stroke: theme.muted,
          'stroke-width': 1.25,
          'stroke-dasharray': '5 5',
          opacity: 0.7
        })
      );
    const OVERLAP_RADIUS = 12;
    const visibleCoords = visible.map((point, index) => ({
      point,
      index,
      px: x(point.cost),
      py: y(point.score),
      pointColor: color(point),
      colorKey: chartCategory(point, colorBy).key
    }));
    const overlapGrid = new Map();
    for (const item of visibleCoords) {
      const gx = Math.floor(item.px / OVERLAP_RADIUS);
      const gy = Math.floor(item.py / OVERLAP_RADIUS);
      const cellKey = `${gx}:${gy}`;
      let bucket = overlapGrid.get(cellKey);
      if (!bucket) {
        bucket = [];
        overlapGrid.set(cellKey, bucket);
      }
      bucket.push(item);
    }
    const findOverlaps = item => {
      const gx = Math.floor(item.px / OVERLAP_RADIUS);
      const gy = Math.floor(item.py / OVERLAP_RADIUS);
      const found = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = overlapGrid.get(`${gx + dx}:${gy + dy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (Math.hypot(other.px - item.px, other.py - item.py) <= OVERLAP_RADIUS) found.push(other);
          }
        }
      }
      if (found.length > 1) found.sort((a, b) => a.index - b.index);
      return found.map(entry => entry.point);
    };
    const selectedIdSet = new Set(options.selectedIds);
    for (const item of visibleCoords) {
      const { point, px, py, pointColor, colorKey } = item;
      const selected = selectedIdSet.has(point.id);
      const overlaps = findOverlaps(item);
      const overlapSummary = overlaps.length > 1 ? summarizeChartRecordTimes(overlaps) : '';
      const historyState = historyStates.get(point.id) ?? 'unknown';
      const historyLabel = { latest: '最新', historical: '历史', unknown: '最新状态未知（时间未记录）' }[historyState];
      const anomalyReasons = pointAnomalyReasons(point);
      const hasAnomalies = anomalyReasons.length > 0;
      const isZeroCostExcludedFromFrontier = options.axis === 'cost' && point.cost === 0;
      const group = svgNode('g', {
        class: 'score-cost-point',
        'data-history-state': historyState,
        tabindex: 0,
        role: 'button',
        'aria-pressed': selected,
        'aria-label': `${point.model}，${historyLabel}，${point.provider}，${options.maskAccounts ? maskChartAccountBullets(point.account) : point.account}，Thinking ${point.think}，均分 ${point.score} / 100，每轮${options.axis === 'tokens' ? '总 tokens ' : options.axis === 'duration' ? '平均耗时 ' : '平均费用 '}${point.usageIncomplete ? '至少 ' : ''}${quantity(point.cost)}，${sourceLabel(point)}，${formatChartRecordTime(point)}${overlapSummary ? '，重叠记录：' + overlapSummary : ''}${hasAnomalies ? '，含异常项（不参与前沿）：' + anomalyReasons.join('；') : isZeroCostExcludedFromFrontier ? '，零费用（不计入前沿）' : ''}${point.anomaly ? '，' + point.anomaly : ''}`,
        'data-record-id': point.id,
        'data-overlap-count': overlaps.length
      });
      group.append(svgNode('circle', { cx: px, cy: py, r: 7, fill: 'transparent', class: 'score-cost-hit' }));
      group.append(
        svgNode('circle', {
          cx: px,
          cy: py,
          r: 11,
          fill: 'none',
          stroke: point.anomaly ? theme.amber : theme.accent,
          'stroke-width': selected ? 2 : 1.5,
          opacity: selected || point.anomaly ? 1 : 0,
          class: 'score-cost-focus-ring',
          'pointer-events': 'none'
        })
      );
      const bundled = point.source === 'baseline';
      group.setAttribute('data-channel-key', String(point.providerId ?? point.provider));
      group.setAttribute('data-model-color', pointColor);
      if (!options.maskAccounts) group.setAttribute('data-color-key', colorKey);
      const markerStroke = 1.5;
      // Centered strokes stay inside identical visible bounds for filled and hollow markers.
      const markerRadius = ((bundled ? 10 : 12) - markerStroke) / 2;
      const markerShape = bundled
        ? { x: px - markerRadius, y: py - markerRadius, width: markerRadius * 2, height: markerRadius * 2 }
        : { cx: px, cy: py, r: markerRadius };
      group.append(
        svgNode(bundled ? 'rect' : 'circle', {
          class: 'record-marker-halo',
          ...markerShape,
          fill: theme.card,
          stroke: theme.card,
          'stroke-width': markerStroke + 3,
          'pointer-events': 'none',
          'aria-hidden': true
        })
      );
      group.append(
        svgNode(bundled ? 'rect' : 'circle', {
          class: 'record-marker',
          ...markerShape,
          fill: historyState === 'latest' ? pointColor : theme.card,
          stroke: pointColor,
          'stroke-width': markerStroke,
          'stroke-dasharray': historyState === 'unknown' ? '2 2' : 'none'
        })
      );
      if (point.usageIncomplete) group.setAttribute('data-usage-incomplete', 'true');
      if (hasAnomalies) {
        group.setAttribute('data-has-anomalies', 'true');
        group.append(
          svgNode('circle', {
            class: 'record-anomaly-badge record-usage-badge',
            cx: px + markerRadius * 0.8,
            cy: py - markerRadius * 0.8,
            r: 2.6,
            fill: theme.amber,
            stroke: theme.card,
            'stroke-width': 1,
            'pointer-events': 'none',
            'aria-hidden': true
          })
        );
      }
      const seriesKey = thinkingGroupKey(point);
      pointNodes.push([group, seriesKey, point, colorKey]);
      const showTooltip = (pinned = false) => {
        highlightSeries(seriesKey);
        tooltip.replaceChildren();
        tooltip.classList?.toggle?.('is-pinned', pinned);
        const node = (tag, className, text) => {
          const child = document.createElement(tag);
          child.className = className;
          if (text !== undefined) child.textContent = text;
          return child;
        };
        const header = node('div', 'score-cost-tooltip-header');
        const heading = node('strong', 'score-cost-tooltip-model', point.modelDisplayName ?? point.model);
        heading.title = point.model;
        const headerRight = node('div', 'score-cost-tooltip-header-right');
        headerRight.append(
          node('span', 'score-cost-tooltip-thinking', point.think === 'default' ? 'Thinking 默认' : `Thinking ${point.think}`)
        );
        if (pinned) {
          const closeBtn = node('button', 'score-cost-tooltip-close', '×');
          closeBtn.type = 'button';
          closeBtn.setAttribute('aria-label', '关闭卡片');
          closeBtn.addEventListener('click', event => {
            event.stopPropagation();
            unpinTooltip({ notifySelect: true });
          });
          headerRight.append(closeBtn);
        }
        header.append(heading, headerRight);
        const channel = node('div', 'score-cost-tooltip-channel');
        channel.append(
          node('span', 'score-cost-tooltip-provider', point.providerName ?? point.providerDisplayId ?? point.provider),
          node('span', 'score-cost-tooltip-account', point.account)
        );
        const { durationText, costText, tokenText } = roundMetrics(point);
        const metrics = node('dl', 'score-cost-tooltip-metrics');
        for (const [label, value, isScore] of [
          ['均分', point.score.toFixed(1), true],
          ['耗时', durationText, false],
          ['费用', costText, false],
          ['Tokens', tokenText, false]
        ]) {
          const metric = node('div', isScore ? 'score-cost-tooltip-metric is-score' : 'score-cost-tooltip-metric');
          metric.append(node('dt', '', label), node('dd', '', value));
          metrics.append(metric);
        }
        const meta = node('div', 'score-cost-tooltip-meta');
        meta.append(
          node('span', '', `${sourceLabel(point)} · ${historyLabel}${point.rounds ? ` · ${point.rounds} 轮` : ''}`),
          node('span', '', formatChartRecordTime(point))
        );
        tooltip.append(header, channel, metrics, meta);
        if (overlapSummary) tooltip.append(node('div', 'score-cost-tooltip-overlap', `重叠记录：${overlapSummary}`));
        if (hasAnomalies) {
          const note = node('div', 'score-cost-tooltip-note');
          note.append(node('strong', '', '含异常项（不参与前沿）：'));
          if (anomalyReasons.length === 1) {
            note.append(node('span', '', anomalyReasons[0]));
          } else {
            const list = node('ul', 'score-cost-tooltip-anomaly-list');
            for (const reason of anomalyReasons) list.append(node('li', '', reason));
            note.append(list);
          }
          tooltip.append(note);
        } else if (isZeroCostExcludedFromFrontier) {
          const note = node('div', 'score-cost-tooltip-note');
          note.append(node('span', '', '零费用记录绘制在坐标轴上，不计入前沿线。'));
          tooltip.append(note);
        }
        if (point.anomaly) {
          const anomaly = document.createElement('p');
          anomaly.textContent = `记录标注：${point.anomaly}`;
          tooltip.append(anomaly);
        }
        const runId = point.run_id ?? point.original?.run_id;
        if (point.source === 'run' && runId) {
          const actions = node('div', 'score-cost-tooltip-actions');
          const openBtn = node('button', 'score-cost-tooltip-link', '查看任务详情 →');
          openBtn.type = 'button';
          openBtn.dataset.tooltipOpenRun = runId;
          openBtn.addEventListener('click', event => {
            event.stopPropagation();
            onOpenRun(runId);
          });
          actions.append(openBtn, node('span', 'score-cost-tooltip-hint', pinned ? '已固定 · 再次点击取消' : '点击固定卡片与参考线'));
          tooltip.append(actions);
        } else {
          const actions = node('div', 'score-cost-tooltip-actions');
          actions.append(node('span', 'score-cost-tooltip-hint', pinned ? '已固定 · 再次点击取消' : '点击固定卡片与参考线'));
          tooltip.append(actions);
        }
        tooltip.hidden = false;
        crosshairCtrl?.showPoint(point, px, py, Boolean(pinned));
        const cardWidth = tooltip.offsetWidth || 348,
          cardHeight = tooltip.offsetHeight || 176,
          gap = 14;
        const rect = container.getBoundingClientRect();
        const maxLeft = Math.max(4, width - cardWidth - 4);
        const maxTop = Math.max(4, Math.min(height - cardHeight - 4, window.innerHeight - rect.top - cardHeight - 8));
        const minTop = Math.min(maxTop, rect.top < 0 ? -rect.top + 8 : 4);
        const activeBox = { left: px - 14, right: px + 14, top: py - 14, bottom: py + 14 };
        const overlapsBox = (candidate, box) =>
          candidate.left < box.right &&
          candidate.left + cardWidth > box.left &&
          candidate.top < box.bottom &&
          candidate.top + cardHeight > box.top;
        const clampCandidate = candidate => ({
          left: Math.max(4, Math.min(maxLeft, candidate.left)),
          top: Math.max(minTop, Math.min(maxTop, candidate.top)),
          priority: candidate.priority
        });
        // Anchor close to the active point so the card stays immediately readable and reachable when pinned,
        // picking the cleanest side that avoids the active point, its Thinking series/labels, and nearby dots.
        const rawCandidates = [
          { left: px + gap, top: py - cardHeight * 0.35, priority: 0 },
          { left: px - cardWidth - gap, top: py - cardHeight * 0.35, priority: 0 },
          { left: px + gap, top: py + gap, priority: 1 },
          { left: px - cardWidth - gap, top: py + gap, priority: 1 },
          { left: px - cardWidth / 2, top: py + gap, priority: 1 },
          { left: px + gap, top: py - cardHeight - gap, priority: 2 },
          { left: px - cardWidth - gap, top: py - cardHeight - gap, priority: 2 },
          { left: px - cardWidth / 2, top: py - cardHeight - gap, priority: 2 }
        ].map(clampCandidate);
        const activeSeries = visibleSeries.get(thinkingGroupKey(point)) || [];
        const seriesCheckPoints = [];
        for (let i = 0; i < activeSeries.length; i++) {
          const item = activeSeries[i];
          const sx = x(item.cost),
            sy = y(item.score);
          if (item.id !== point.id) seriesCheckPoints.push({ x: sx, y: sy });
          if (i + 1 < activeSeries.length) {
            const next = activeSeries[i + 1];
            const nx = x(next.cost),
              ny = y(next.score);
            for (const t of [0.25, 0.5, 0.75]) {
              seriesCheckPoints.push({ x: sx + (nx - sx) * t, y: sy + (ny - sy) * t });
            }
          }
        }
        const otherPoints = visibleCoords.filter(other => other.point.id !== point.id).map(other => ({ x: other.px, y: other.py }));
        const scoreCandidate = candidate => {
          const hitsActive = overlapsBox(candidate, activeBox) ? 1 : 0;
          const hitsSeries = seriesCheckPoints.filter(pt =>
            overlapsBox(candidate, { left: pt.x - 10, right: pt.x + 10, top: pt.y - 10, bottom: pt.y + 10 })
          ).length;
          const hitsHoverLabels = activeHoverLabelBoxes.filter(box => overlapsBox(candidate, box)).length;
          const hitsOthers = otherPoints.filter(pt =>
            overlapsBox(candidate, { left: pt.x - 6, right: pt.x + 6, top: pt.y - 6, bottom: pt.y + 6 })
          ).length;
          const dx = Math.max(candidate.left - px, 0, px - (candidate.left + cardWidth));
          const dy = Math.max(candidate.top - py, 0, py - (candidate.top + cardHeight));
          const edgeDist = Math.hypot(dx, dy);
          const centerDist = Math.hypot(candidate.left + cardWidth / 2 - px, candidate.top + cardHeight / 2 - py);
          return (
            hitsActive * 100000 +
            hitsSeries * 400 +
            hitsHoverLabels * 250 +
            hitsOthers * 12 +
            edgeDist * 4 +
            centerDist * 0.05 +
            candidate.priority * 4
          );
        };
        const chosen = [...rawCandidates].sort((a, b) => scoreCandidate(a) - scoreCandidate(b))[0];
        tooltip.style.left = chosen.left + 'px';
        tooltip.style.top = chosen.top + 'px';
      };
      showPointTooltipById.set(point.id, showTooltip);
      const restoreOrHide = () => {
        if (pinnedPointId && showPointTooltipById.has(pinnedPointId)) {
          showPointTooltipById.get(pinnedPointId)(true);
          return;
        }
        tooltip.hidden = true;
        tooltip.classList?.remove?.('is-pinned');
        highlightSeries(null);
        crosshairCtrl?.hide();
      };
      group.addEventListener('pointerenter', () => {
        hoveredPointId = point.id;
        if (!pan?.active && (!pinnedPointId || pinnedPointId === point.id)) showTooltip(pinnedPointId === point.id);
      });
      group.addEventListener('pointerleave', () => {
        if (hoveredPointId === point.id) hoveredPointId = null;
        if (!pan?.active && !pinnedPointId) restoreOrHide();
      });
      group.addEventListener('focus', () => showTooltip(pinnedPointId === point.id));
      group.addEventListener('blur', restoreOrHide);
      const toggleSelectAndPin = () => {
        if (pinnedPointId === point.id || options.selectedIds.includes(point.id)) {
          unpinTooltip();
          onSelect(null);
          return;
        }
        pinnedPointId = point.id;
        showTooltip(true);
        onSelect(point.id);
      };
      group.addEventListener('click', event => {
        event.stopPropagation();
        if (suppressPlotClick) {
          suppressPlotClick = false;
          return;
        }
        toggleSelectAndPin();
      });
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.repeat) {
          event.preventDefault();
          toggleSelectAndPin();
        }
        if (event.key === ' ') event.preventDefault();
        if (event.key === 'Escape') unpinTooltip({ notifySelect: true });
      });
      group.addEventListener('keyup', event => {
        if (event.key === ' ') {
          event.preventDefault();
          toggleSelectAndPin();
        }
      });
      plotted.append(group);
    }
    if (options.labels && visible.length) {
      const distinctModels = new Set(visible.map(point => chartCategory(point, 'model').key));
      const rawChannels = visible.map(point => String(point.providerName ?? point.providerDisplayId ?? point.provider ?? ''));
      const distinctChannels = new Set(rawChannels);
      const distinctThinkings = new Set(visible.map(point => point.think));
      // Strip a shared slash-prefix like "homelab / " so single-host channels stay compact.
      let sharedPrefix = '';
      if (distinctChannels.size > 1 && rawChannels.every(ch => ch.includes(' / '))) {
        const firstPrefix = rawChannels[0].slice(0, rawChannels[0].indexOf(' / ') + 3);
        if (rawChannels.every(ch => ch.startsWith(firstPrefix))) sharedPrefix = firstPrefix;
      }
      const shortChannel = point => {
        const raw = String(point.providerName ?? point.providerDisplayId ?? point.provider ?? '');
        const stripped = sharedPrefix && raw.startsWith(sharedPrefix) ? raw.slice(sharedPrefix.length) : raw;
        return stripped.length > 14 ? stripped.slice(0, 13) + '…' : stripped;
      };
      const shortAccount = point => {
        if (point.accountId && String(point.accountId).startsWith('gateway-binding:')) return '默认';
        const raw = String(point.accountDisplayId ?? point.account ?? '');
        const shown = options.maskAccounts ? maskChartAccountBullets(raw) : raw;
        return shown.length > 14 ? shown.slice(0, 13) + '…' : shown;
      };
      const channelAccounts = new Map();
      for (const point of visible) {
        const chKey = String(point.providerId ?? point.provider ?? '');
        if (!channelAccounts.has(chKey)) channelAccounts.set(chKey, new Set());
        channelAccounts.get(chKey).add(String(point.accountId ?? point.account ?? ''));
      }
      const shortThink = think => (think === 'default' ? '默认' : think === 'unknown' ? '' : think);
      const modelThinkings = new Map();
      for (const point of visible) {
        const mk = chartCategory(point, 'model').key;
        if (!modelThinkings.has(mk)) modelThinkings.set(mk, new Set());
        modelThinkings.get(mk).add(point.think);
      }
      const labelForPoint = point => {
        const modelName = point.modelDisplayName ?? point.model;
        const th = shortThink(point.think);
        if (distinctModels.size === 1) {
          const chKey = String(point.providerId ?? point.provider ?? '');
          const ch = shortChannel(point);
          const acc = (channelAccounts.get(chKey)?.size ?? 0) > 1 ? shortAccount(point) : '';
          if (distinctChannels.size > 1) {
            const origin = acc ? `${ch}/${acc}` : ch;
            return distinctThinkings.size > 1 && th ? `${origin} · ${th}` : origin;
          }
          if (acc) return distinctThinkings.size > 1 && th ? `${acc} · ${th}` : acc;
          if (distinctThinkings.size > 1) return th || '默认';
          return modelName;
        }
        const mk = chartCategory(point, 'model').key;
        const showThink = options.selectedIds.includes(point.id) || (modelThinkings.get(mk)?.size ?? 0) > 1;
        return showThink && th ? `${modelName} · ${th}` : modelName;
      };
      const ordered = [...visible].sort(
        (a, b) =>
          Number(options.selectedIds.includes(b.id) || b.id === pinnedPointId) -
            Number(options.selectedIds.includes(a.id) || a.id === pinnedPointId) ||
          Number(frontierIds.has(b.id)) - Number(frontierIds.has(a.id)) ||
          Number(historyStates.get(b.id) === 'latest') - Number(historyStates.get(a.id) === 'latest') ||
          b.score - a.score ||
          a.cost - b.cost ||
          a.id.localeCompare(b.id)
      );
      const candidates = ordered.map(point => {
        const selected = options.selectedIds.includes(point.id) || point.id === pinnedPointId;
        const label = labelForPoint(point);
        const node = svgNode(
          'text',
          {
            class: 'chart-point-label',
            fill: theme.secondary,
            'font-size': 11,
            'paint-order': 'stroke',
            stroke: theme.card,
            'stroke-width': 4,
            'stroke-linejoin': 'round',
            'pointer-events': 'none',
            'data-label-record': point.id
          },
          label
        );
        svg.append(node);
        labelNodes.push([node, thinkingGroupKey(point)]);
        return {
          id: point.id,
          selected,
          group: null,
          node,
          width: node.getComputedTextLength(),
          x: x(point.cost),
          y: y(point.score)
        };
      });
      const placed = new Map(
        placeChartLabels(
          candidates,
          visible.map(point => ({ x: x(point.cost), y: y(point.score) })),
          {
            left: margin.left,
            right: width - margin.right,
            top: margin.top + 2,
            bottom: height - margin.bottom - 5,
            maxLabels: Math.max(4, Math.min(28, Math.floor(plotWidth / 48)))
          }
        ).map(item => [item.id, item])
      );
      for (const candidate of candidates) {
        const item = placed.get(candidate.id);
        if (!item) {
          candidate.node.remove();
          continue;
        }
        candidate.node.setAttribute('x', item.box.x);
        candidate.node.setAttribute('y', item.box.y + 11);
      }
    }
    if (!points.length) {
      text('没有可绘制的记录', margin.left + plotWidth / 2, margin.top + plotHeight / 2 - 8, {
        'text-anchor': 'middle',
        fill: theme.fg,
        'font-size': 15,
        'font-weight': 600
      });
      text(
        options.log && options.axis !== 'cost'
          ? '调整筛选条件；对数刻度仅显示正用量。'
          : '调整筛选条件，或选择有分数与所选横轴用量的记录。',
        margin.left + plotWidth / 2,
        margin.top + plotHeight / 2 + 18,
        { 'text-anchor': 'middle', 'font-size': mobile ? 10 : 12 }
      );
    }
    highlightSeries(null);
    if (pinnedPointId && showPointTooltipById.has(pinnedPointId)) {
      showPointTooltipById.get(pinnedPointId)(true);
    } else if (pinnedPointId && !showPointTooltipById.has(pinnedPointId)) {
      pinnedPointId = null;
    }
    legend.render(
      buildChartLegendGroups(visible, colorBy).map(entry => ({ ...entry, color: color(entry.record) })),
      colorBy,
      key => {
        if (!pinnedPointId) {
          tooltip.hidden = true;
          crosshairCtrl?.hide();
        }
        highlightSeries(null);
        if (key === null) {
          if (pinnedPointId && showPointTooltipById.has(pinnedPointId)) showPointTooltipById.get(pinnedPointId)(true);
          return;
        }
        tooltip.hidden = true;
        // Legend lookup highlights points only; it must not reveal unselected Thinking curves.
        for (const [node, , selected] of seriesNodes) {
          node.setAttribute('opacity', selected ? 0.95 : 0);
          node.setAttribute('data-legend-highlight', false);
        }
        for (const [node, , , pointColorKey] of pointNodes) {
          const active = pointColorKey === key;
          node.setAttribute('opacity', active ? 1 : 0.18);
          node.setAttribute('data-legend-highlight', active);
        }
        for (const [node] of labelNodes) node.setAttribute('opacity', 0);
      }
    );
  }
  // SVG aspect ratio and legend disclosure can change our own height. Never write layout
  // during ResizeObserver delivery, and ignore height-only notifications from that draw.
  const observer = new ResizeObserver(() => {
    if (disposed || container.clientWidth <= 0 || container.clientWidth === drawnWidth || resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (!disposed && container.clientWidth > 0 && container.clientWidth !== drawnWidth) drawChart();
    });
  });
  observer.observe(container);
  return {
    registerCatalog(catalog) {
      for (const dimension of ['provider', 'account', 'model', 'family', 'think', 'source', 'series', 'time'])
        colors.register(catalog, dimension);
    },
    render(nextRecords, nextOptions = {}) {
      const axisChanged =
        (nextOptions.axis !== undefined && nextOptions.axis !== options.axis) ||
        (nextOptions.log !== undefined && nextOptions.log !== options.log);
      if (axisChanged) {
        clearPan();
        zoomWindow = null;
      }
      if (Array.isArray(nextOptions.selectedIds)) {
        const nextSelectedId = nextOptions.selectedIds[0] ?? null;
        if (nextSelectedId !== (options.selectedIds[0] ?? null)) {
          pinnedPointId = nextSelectedId;
        }
      }
      records = [...nextRecords];
      options = { ...options, ...nextOptions };
      drawChart();
    },
    zoom(factor) {
      if (!Number.isFinite(factor) || factor <= 0 || !viewState?.hasPoints) return;
      clearPan();
      const state = viewState;
      const points = records.filter(record => validPoint(record, options.log, options.axis));
      const pointXValue = cost => (options.log && cost === 0 ? state.fullLower : options.log ? Math.log10(cost) : cost);
      const selectedPoint = points.find(point => options.selectedIds.includes(point.id));
      const center = selectedPoint ? pointXValue(selectedPoint.cost) : (state.lower + state.upper) / 2;
      const nextXSpan = (state.upper - state.lower) / factor;
      let nextYMin = state.yMin,
        nextYMax = state.yMax;
      if (factor < 1 && zoomWindow) {
        const yMid = (state.yMin + state.yMax) / 2;
        const nextYSpan = (state.yMax - state.yMin) / factor;
        nextYMin = yMid - nextYSpan / 2;
        nextYMax = yMid + nextYSpan / 2;
      }
      zoomWindow = clampZoomWindow({ xMin: center - nextXSpan / 2, xMax: center + nextXSpan / 2, yMin: nextYMin, yMax: nextYMax }, state);
      drawChart();
    },
    resetZoom() {
      clearPan();
      zoomWindow = null;
      drawChart();
    },
    exportSvg() {
      const copy = svg.cloneNode(true);
      for (const node of copy.querySelectorAll?.('.score-cost-crosshair') || []) {
        if (node.getAttribute('data-pinned') !== 'true') node.remove();
      }
      copy.setAttribute('xmlns', SVG_NS);
      return new XMLSerializer().serializeToString(copy);
    },
    destroy() {
      disposed = true;
      clearPan();
      observer.disconnect();
      svg.removeEventListener?.('wheel', onWheel);
      svg.removeEventListener?.('pointerdown', onPointerDown);
      svg.removeEventListener?.('pointermove', onPointerMove);
      svg.removeEventListener?.('pointerleave', onPointerLeave);
      svg.removeEventListener?.('pointerup', onPointerUp);
      svg.removeEventListener?.('pointercancel', clearPan);
      svg.removeEventListener?.('click', onSvgClick);
      svg.removeEventListener?.('dblclick', onDoubleClick);
      document.removeEventListener?.('keydown', onDocumentKeyDown);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
      svg.remove();
      tooltip.remove();
      legend.destroy();
      container.classList.remove('score-cost-chart');
    }
  };
}
