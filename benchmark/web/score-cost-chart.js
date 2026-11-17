/* Native SVG chart; metric calculation belongs to the observation adapter. */
import { buildAnalysisHistoryStates } from './analysis-history.js';
import { chartCategory, createChartColorRegistry } from './chart-colors.js';
import { buildChartLegendGroups, createChartLegend } from './chart-legend.js';
import { placeChartLabels, placeThinkingLabels } from './chart-layout.js';
import { formatChartRecordTime, summarizeChartRecordTimes, overlappingChartRecords } from './chart-point-time.js';
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
const validPoint = (record, log) =>
  Number.isFinite(record.score) &&
  record.score >= 0 &&
  record.score <= 100 &&
  Number.isFinite(record.cost) &&
  (log ? record.cost > 0 : record.cost >= 0);

/** Score axis floor snaps below the lowest plotted score so clustered results stay distinguishable. */
export function scoreAxisDomain(scores) {
  const finiteScores = scores.filter(score => Number.isFinite(score));
  if (!finiteScores.length) return { min: 0, step: 20 };
  const lowest = Math.min(...finiteScores);
  const min = Math.max(0, Math.min(90, Math.floor((lowest - 2) / 10) * 10));
  const span = 100 - min;
  return { min, step: span <= 20 ? 5 : span <= 50 ? 10 : 20 };
}

/** Pareto frontier minimizes the selected usage axis and maximizes score; equal-usage lower scores are dominated. */
export function scoreCostFrontier(records) {
  return records
    .filter(
      point =>
        !records.some(
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

function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Native score / USD cost scatter plot. render is synchronous; exportSvg returns standalone SVG text. */
export function createScoreCostChart(container, { onSelect = () => {}, catalog = [] } = {}) {
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
    options = { log: true, labels: true, pareto: true, axis: 'cost', colorBy: 'series', selectedIds: [] };
  let zoomLevel = 1,
    disposed = false,
    resizeFrame = null,
    drawnWidth = null;

  function drawChart() {
    if (disposed) return;
    tooltip.hidden = true;
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
      amber: token('--amber', '#b45309')
    };
    const explicitTheme = document.documentElement.dataset.theme;
    const dark = explicitTheme === 'dark' || (!explicitTheme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const colorBy = ['series', 'model', 'family', 'time'].includes(options.colorBy) ? options.colorBy : 'series';
    const historyRecords = options.historyRecords ?? records;
    const historyStates = buildAnalysisHistoryStates(historyRecords);
    colors.register(historyRecords, colorBy);
    const color = record => colors.color(record, colorBy, dark);
    svg.setAttribute('data-color-by', colorBy);
    const quantity = value => (options.axis === 'tokens' ? Number(value.toFixed(1)).toLocaleString('zh-CN') : money(value));
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif');
    svg.setAttribute('font-size', '12');
    svg.append(svgNode('rect', { width, height, fill: theme.card }));
    const points = records.filter(record => validPoint(record, options.log));
    const costs = points.map(point => point.cost);
    const transform = value => (options.log ? Math.log10(value) : value);
    const inverse = value => (options.log ? 10 ** value : value);
    const logMin = Math.log10(costs.length ? Math.min(...costs) : 0.01);
    const logMax = Math.log10(costs.length ? Math.max(...costs) : 0.1);
    const logPadding = Math.max(0.12, (logMax - logMin) * 0.1);
    let lower = options.log ? logMin - logPadding : 0;
    let upper = options.log ? logMax + logPadding : Math.max(...costs, 0.1) * 1.12;
    if (lower === upper) upper = lower + 1;
    const span = (upper - lower) / zoomLevel;
    const selectedPoint = points.find(point => options.selectedIds.includes(point.id));
    const center = selectedPoint ? transform(selectedPoint.cost) : (upper + lower) / 2;
    const start = Math.max(lower, Math.min(upper - span, center - span / 2));
    lower = start;
    upper = start + span;
    const x = cost => margin.left + ((transform(cost) - lower) / (upper - lower)) * plotWidth;
    const { min: scoreFloor, step: scoreStep } = scoreAxisDomain(points.map(point => point.score));
    const y = score => margin.top + ((100 - score) / (100 - scoreFloor)) * plotHeight;
    const text = (label, px, py, attrs = {}) => svg.appendChild(svgNode('text', { x: px, y: py, fill: theme.secondary, ...attrs }, label));
    const line = (x1, y1, x2, y2, attrs = {}) => svg.appendChild(svgNode('line', { x1, y1, x2, y2, stroke: theme.line, ...attrs }));
    text('均分 / 100', margin.left, 19, { 'font-weight': 600 });
    text('越高越好', width - margin.right, 19, { 'text-anchor': 'end', fill: theme.muted, 'font-size': 11 });
    for (let score = scoreFloor; score <= 100; score += scoreStep) {
      line(margin.left, y(score), width - margin.right, y(score));
      text(score, margin.left - 12, y(score) + 4, { 'text-anchor': 'end', fill: theme.muted, 'font-size': 11 });
    }
    let ticks = [];
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
    if (ticks.length < 2) ticks = [inverse(lower), inverse((upper + lower) / 2), inverse(upper)];
    let lastTickX = -Infinity;
    for (const cost of ticks) {
      const px = x(cost);
      if (px - lastTickX < (mobile ? 58 : 65)) continue;
      line(px, margin.top, px, height - margin.bottom, { 'stroke-dasharray': '2 5' });
      text(quantity(cost), px, height - margin.bottom + 23, { 'text-anchor': 'middle', fill: theme.muted, 'font-size': 11 });
      lastTickX = px;
    }
    line(margin.left, height - margin.bottom, width - margin.right, height - margin.bottom, { stroke: theme.axis });
    text(
      `${options.axis === 'tokens' ? '总 tokens（输入 + 输出）' : '平均费用 / USD'} · 每轮${options.taskCount ? options.taskCount + '题' : '全部题目'}${options.log ? ' · 对数' : ' · 线性'}`,
      margin.left + plotWidth / 2,
      height - 10,
      { 'text-anchor': 'middle', 'font-size': 11 }
    );
    const defs = svgNode('defs'),
      clip = svgNode('clipPath', { id: clipId });
    clip.append(svgNode('rect', { x: margin.left - 12, y: margin.top - 13, width: plotWidth + 24, height: plotHeight + 26 }));
    defs.append(clip);
    svg.append(defs);
    const plotted = svgNode('g', { 'clip-path': `url(#${clipId})` });
    svg.append(plotted);
    const hoverLabels = svgNode('g', { class: 'thinking-hover-labels', 'pointer-events': 'none' });
    svg.append(hoverLabels);
    const visible = points.filter(point => transform(point.cost) >= lower && transform(point.cost) <= upper);
    const visibleSeries = new Map(thinkingSeries(visible).map(series => [thinkingGroupKey(series[0]), series]));
    const seriesNodes = [],
      pointNodes = [],
      labelNodes = [];
    const highlightSeries = hoveredKey => {
      const key = visibleSeries.has(hoveredKey) ? hoveredKey : null;
      const selectedKey = [...visibleSeries].find(([, series]) => series.some(point => options.selectedIds.includes(point.id)))?.[0];
      const activeKey = key ?? selectedKey;
      hoverLabels.replaceChildren();
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
    const frontier = scoreCostFrontier(visible.filter(point => !point.usageIncomplete));
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
    for (const point of visible) {
      const px = x(point.cost),
        py = y(point.score),
        selected = options.selectedIds.includes(point.id);
      const overlaps = overlappingChartRecords(visible, point, x, y);
      const overlapSummary = overlaps.length > 1 ? summarizeChartRecordTimes(overlaps) : '';
      const historyState = historyStates.get(point.id) ?? 'unknown';
      const historyLabel = { latest: '最新', historical: '历史', unknown: '最新状态未知（时间未记录）' }[historyState];
      const group = svgNode('g', {
        class: 'score-cost-point',
        'data-history-state': historyState,
        tabindex: 0,
        role: 'button',
        'aria-pressed': selected,
        'aria-label': `${point.model}，${historyLabel}，${point.provider}，${point.account}，Thinking ${point.think}，均分 ${point.score} / 100，每轮${options.axis === 'tokens' ? '总 tokens ' : '平均费用 '}${point.usageIncomplete ? '至少 ' : ''}${quantity(point.cost)}${point.usageIncomplete ? `（${point.usageIncomplete.unknownAttempts} 次尝试未返回用量）` : ''}，${sourceLabel(point)}，${formatChartRecordTime(point)}${overlapSummary ? '，重叠记录：' + overlapSummary : ''}${point.anomaly ? '，' + point.anomaly : ''}`,
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
      group.setAttribute('data-model-color', color(point));
      group.setAttribute('data-color-key', chartCategory(point, colorBy).key);
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
          fill: historyState === 'latest' ? color(point) : theme.card,
          stroke: color(point),
          'stroke-width': markerStroke,
          'stroke-dasharray': historyState === 'unknown' ? '2 2' : 'none'
        })
      );
      if (point.usageIncomplete) {
        group.setAttribute('data-usage-incomplete', 'true');
        group.append(
          svgNode('circle', {
            class: 'record-usage-badge',
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
      pointNodes.push([group, seriesKey, point]);
      const showTooltip = () => {
        highlightSeries(seriesKey);
        tooltip.replaceChildren();
        const node = (tag, className, text) => {
          const child = document.createElement(tag);
          child.className = className;
          if (text !== undefined) child.textContent = text;
          return child;
        };
        const header = node('div', 'score-cost-tooltip-header');
        const heading = node('strong', 'score-cost-tooltip-model', point.modelDisplayName ?? point.model);
        heading.title = point.model;
        header.append(
          heading,
          node('span', 'score-cost-tooltip-thinking', point.think === 'default' ? '默认思考（不指定）' : `Thinking ${point.think}`)
        );
        const metrics = node('dl', 'score-cost-tooltip-metrics');
        for (const [label, value] of [
          ['均分 / 100', point.score.toFixed(1)],
          [options.axis === 'tokens' ? '每轮总 tokens' : '每轮费用', (point.usageIncomplete ? '≥ ' : '') + quantity(point.cost)],
          ['轮数', String(point.rounds)]
        ]) {
          const metric = node('div', 'score-cost-tooltip-metric');
          metric.append(node('dt', '', label), node('dd', '', value));
          metrics.append(metric);
        }
        const details = node('dl', 'score-cost-tooltip-details');
        for (const [label, value] of [
          ['时间', formatChartRecordTime(point)],
          ['渠道', point.providerName ?? point.providerDisplayId ?? point.provider],
          ['账号', point.account],
          ['来源', `${sourceLabel(point)} · ${historyLabel}`]
        ]) {
          const row = node('div', 'score-cost-tooltip-detail');
          row.append(node('dt', '', label), node('dd', '', value));
          details.append(row);
        }
        tooltip.append(header, metrics, details);
        if (overlapSummary) tooltip.append(node('div', 'score-cost-tooltip-overlap', `重叠记录：${overlapSummary}`));
        if (point.usageIncomplete)
          tooltip.append(
            node(
              'div',
              'score-cost-tooltip-note',
              `用量不完整：${point.usageIncomplete.unknownAttempts} 次请求尝试未返回用量（超时或上游错误），横坐标按已知部分绘制，实际只会更高；该点不参与前沿。`
            )
          );
        if (point.anomaly) {
          const anomaly = document.createElement('p');
          anomaly.textContent = `记录标注：${point.anomaly}`;
          tooltip.append(anomaly);
        }
        tooltip.hidden = false;
        const cardWidth = tooltip.offsetWidth,
          cardHeight = tooltip.offsetHeight,
          gap = 16;
        const members = visibleSeries.get(seriesKey) ?? [point];
        const curve = {
          left: Math.min(...members.map(member => x(member.cost))) - 9,
          right: Math.max(...members.map(member => x(member.cost))) + 9,
          top: Math.min(...members.map(member => y(member.score))) - 9,
          bottom: Math.max(...members.map(member => y(member.score))) + 9
        };
        const annotation = hoverLabels.getBBox();
        if (hoverLabels.children.length) {
          curve.left = Math.min(curve.left, annotation.x - 4);
          curve.right = Math.max(curve.right, annotation.x + annotation.width + 4);
          curve.top = Math.min(curve.top, annotation.y - 4);
          curve.bottom = Math.max(curve.bottom, annotation.y + annotation.height + 4);
        }
        const rect = container.getBoundingClientRect();
        const maximumTop = Math.max(4, window.innerHeight - rect.top - cardHeight - 8);
        const candidates = [
          { left: px + gap, top: curve.bottom + gap },
          { left: curve.right + gap, top: py - cardHeight / 2 },
          { left: curve.left - cardWidth - gap, top: py - cardHeight / 2 },
          { left: px - cardWidth / 2, top: curve.top - cardHeight - gap }
        ].map(candidate => ({
          left: Math.max(4, Math.min(width - cardWidth - 4, candidate.left)),
          top: Math.max(4, Math.min(maximumTop, candidate.top))
        }));
        const chosen = candidates.find(
          candidate =>
            candidate.left + cardWidth <= curve.left ||
            candidate.left >= curve.right ||
            candidate.top + cardHeight <= curve.top ||
            candidate.top >= curve.bottom
        ) || { left: Math.max(4, Math.min(width - cardWidth - 4, px + gap)), top: curve.bottom + gap };
        tooltip.style.left = chosen.left + 'px';
        tooltip.style.top = chosen.top + 'px';
      };
      group.addEventListener('pointerenter', showTooltip);
      group.addEventListener('pointerleave', () => {
        tooltip.hidden = true;
        highlightSeries(null);
      });
      group.addEventListener('focus', showTooltip);
      group.addEventListener('blur', () => {
        tooltip.hidden = true;
        highlightSeries(null);
      });
      group.addEventListener('click', () => onSelect(point.id));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.repeat) {
          event.preventDefault();
          onSelect(point.id);
        }
        if (event.key === ' ') event.preventDefault();
        if (event.key === 'Escape') {
          tooltip.hidden = true;
          highlightSeries(null);
        }
      });
      group.addEventListener('keyup', event => {
        if (event.key === ' ') {
          event.preventDefault();
          onSelect(point.id);
        }
      });
      plotted.append(group);
    }
    if (options.labels) {
      // One short name per visible model; channel/account distinctions remain in the legend and details.
      // Picking an anchor changes only the label; all records and frontier points remain plotted.
      const anchors = new Map();
      for (const point of [...visible].sort(
        (a, b) =>
          Number(options.selectedIds.includes(b.id)) - Number(options.selectedIds.includes(a.id)) ||
          b.score - a.score ||
          a.cost - b.cost ||
          a.id.localeCompare(b.id)
      )) {
        const key = chartCategory(point, 'model').key;
        if (!anchors.has(key)) anchors.set(key, []);
        anchors.get(key).push(point);
      }
      const candidates = [...anchors.values()].flat().map(point => {
        const selected = options.selectedIds.includes(point.id);
        const modelLabel = point.modelDisplayName ?? point.model;
        const label = selected ? modelLabel + ' · ' + point.think : modelLabel;
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
          group: chartCategory(point, 'model').key,
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
            maxLabels: Math.max(1, Math.min(6, Math.floor(plotWidth / 160)))
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
        options.log ? '调整筛选条件；对数刻度仅显示正用量。' : '调整筛选条件，或选择有分数与所选横轴用量的记录。',
        margin.left + plotWidth / 2,
        margin.top + plotHeight / 2 + 18,
        { 'text-anchor': 'middle', 'font-size': mobile ? 10 : 12 }
      );
    }
    highlightSeries(null);
    legend.render(
      buildChartLegendGroups(visible, colorBy).map(entry => ({ ...entry, color: color(entry.record) })),
      colorBy,
      key => {
        tooltip.hidden = true;
        highlightSeries(null);
        if (key === null) return;
        // Legend lookup highlights points only; it must not reveal unselected Thinking curves.
        for (const [node, , selected] of seriesNodes) {
          node.setAttribute('opacity', selected ? 0.95 : 0);
          node.setAttribute('data-legend-highlight', false);
        }
        for (const [node, , point] of pointNodes) {
          const active = chartCategory(point, colorBy).key === key;
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
      records = [...nextRecords];
      options = { ...options, ...nextOptions };
      drawChart();
    },
    zoom(factor) {
      if (Number.isFinite(factor) && factor > 0) {
        zoomLevel = Math.max(1, Math.min(16, zoomLevel * factor));
        drawChart();
      }
    },
    resetZoom() {
      zoomLevel = 1;
      drawChart();
    },
    exportSvg() {
      const copy = svg.cloneNode(true);
      copy.setAttribute('xmlns', SVG_NS);
      return new XMLSerializer().serializeToString(copy);
    },
    destroy() {
      disposed = true;
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
      svg.remove();
      tooltip.remove();
      legend.destroy();
      container.classList.remove('score-cost-chart');
    }
  };
}
