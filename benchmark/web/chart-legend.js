import { chartCategory } from './chart-colors.js';

const normalizeLegendSearch = value => String(value).normalize('NFKC').toLocaleLowerCase();

/** Build color legend groups from plotted records only, preserving repeats in point counts. */
export function buildChartLegendGroups(records, dimension) {
  const groups = new Map();
  for (const record of records) {
    const category = chartCategory(record, dimension);
    if (!groups.has(category.key)) {
      const provider = record.providerName ?? record.providerDisplayId ?? record.provider ?? '未记录渠道';
      const account = record.accountDisplayId ?? record.account ?? '未记录账号';
      groups.set(category.key, {
        key: category.key,
        label: category.label,
        name: dimension === 'series' ? chartCategory(record, 'model').label : category.label,
        detail: dimension === 'series' ? `${provider} / ${account}` : dimension === 'account' ? (record.account ?? '') : '',
        record,
        count: 0,
        searchValues: new Set()
      });
    }
    const group = groups.get(category.key);
    group.count++;
    for (const value of [
      category.label,
      record.model,
      record.modelDisplayName,
      record.providerName,
      record.providerDisplayId,
      record.provider,
      record.accountDisplayId,
      record.account
    ]) {
      if (value) group.searchValues.add(String(value));
    }
  }
  return [...groups.values()]
    .map(({ searchValues, ...group }) => ({ ...group, searchText: normalizeLegendSearch([...searchValues].join(' ')) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN') || a.key.localeCompare(b.key));
}

/** Fit a contiguous legend prefix in CSS pixels; never leave invisible items keyboard-focusable. */
export function fitChartLegendItems(widths, availableWidth, gap = 6) {
  let used = 0,
    count = 0;
  for (const width of widths) {
    const next = used + width + (count ? gap : 0);
    if (next > availableWidth) break;
    used = next;
    count++;
  }
  return count;
}

function legendNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Single-row color legend with a native disclosure and a bounded single-column searchable list. */
export function createChartLegend(container, id) {
  const root = legendNode('section', 'chart-legend');
  root.hidden = true;
  root.setAttribute('aria-label', '颜色图例');
  const bar = legendNode('div', 'chart-legend-bar');
  const compact = legendNode('div', 'chart-legend-compact');
  bar.append(legendNode('span', 'chart-legend-caption', '图例'), compact);
  const disclosure = legendNode('details', 'chart-legend-disclosure');
  const summary = legendNode('summary', 'chart-legend-toggle');
  const panel = legendNode('div', 'chart-legend-panel');
  panel.id = id;
  summary.setAttribute('aria-controls', id);
  const searchBar = legendNode('div', 'chart-legend-search-bar');
  const searchLabel = legendNode('label', 'chart-legend-search');
  searchLabel.append(legendNode('span', 'visually-hidden', '搜索图例，不筛选图表数据'));
  const search = legendNode('input', 'field');
  search.type = 'search';
  search.placeholder = '搜索模型、供应商、账号或 Key';
  search.autocomplete = 'off';
  searchLabel.append(search);
  const count = legendNode('span', 'chart-legend-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  const list = legendNode('div', 'chart-legend-list');
  const empty = legendNode('p', 'chart-legend-empty', '没有匹配图例，请调整关键词。');
  empty.hidden = true;
  searchBar.append(searchLabel, count);
  panel.append(
    searchBar,
    list,
    empty,
    legendNode('p', 'chart-legend-help', '悬停或聚焦图例可定位同色数据点；搜索只查找图例，不改变图中数据。')
  );
  disclosure.append(summary, panel);
  root.append(bar, disclosure);
  container.append(root);
  let entries = [],
    dimension = null,
    signature = '',
    compactButtons = [],
    compactWidths = null,
    lastFitWidth = -1,
    lastDisclosureOpen = null,
    listDirty = true,
    highlight = _key => {},
    activeKey = null;

  function setHighlight(key) {
    activeKey = key;
    highlight(key);
  }
  function focusedKey() {
    const button = /** @type {HTMLElement | null} */ (document.activeElement?.closest('[data-legend-key]'));
    return button && root.contains(button) ? button.dataset.legendKey : null;
  }
  function makeButton(entry, expanded) {
    const button = legendNode('button', expanded ? 'chart-legend-row' : 'chart-legend-item');
    button.type = 'button';
    button.dataset.legendKey = entry.key;
    button.title = `${entry.name}${entry.detail ? ' / ' + entry.detail : ''}，${entry.count} 个数据点`;
    button.setAttribute('aria-label', button.title + '，定位此颜色组');
    const swatch = legendNode('i', 'chart-legend-swatch');
    swatch.style.background = entry.color;
    swatch.setAttribute('aria-hidden', 'true');
    button.append(swatch);
    if (expanded) {
      const identity = legendNode('span', 'chart-legend-identity');
      identity.append(legendNode('span', 'chart-legend-name', entry.name));
      if (entry.detail) identity.append(legendNode('span', 'chart-legend-detail', entry.detail));
      button.append(identity, legendNode('span', 'chart-legend-count', `${entry.count} 个点`));
    } else button.append(legendNode('span', 'chart-legend-short-name', entry.label));
    button.addEventListener('pointerenter', () => setHighlight(entry.key));
    button.addEventListener('pointerleave', () => setHighlight(focusedKey()));
    button.addEventListener('focus', () => setHighlight(entry.key));
    button.addEventListener('blur', () => setHighlight(null));
    button.addEventListener('click', () => {
      button.focus({ preventScroll: true });
      setHighlight(entry.key);
    });
    return button;
  }
  function renderList() {
    listDirty = false;
    const query = normalizeLegendSearch(search.value.trim());
    const matches = entries.filter(entry => entry.searchText.includes(query));
    list.replaceChildren(...matches.map(entry => makeButton(entry, true)));
    count.textContent = query ? `${matches.length} / ${entries.length} 组` : `${entries.length} 个颜色组`;
    empty.hidden = matches.length > 0;
  }
  function fitCompact(forceMeasure = false) {
    if (root.hidden) return;
    const width = compact.clientWidth;
    if (!forceMeasure && compactWidths !== null && width === lastFitWidth && disclosure.open === lastDisclosureOpen) return;
    summary.textContent = disclosure.open ? '收起图例' : `查看全部 · ${entries.length} 组`;
    disclosure.hidden = false;
    bar.style.paddingRight = '0px';
    if (forceMeasure || compactWidths === null) {
      compactButtons.forEach(button => {
        button.hidden = false;
      });
      compactWidths = compactButtons.map(button => button.getBoundingClientRect().width);
    }
    const availableWidth = compact.clientWidth;
    let shown = fitChartLegendItems(compactWidths, availableWidth);
    if (shown === entries.length && !disclosure.open) disclosure.hidden = true;
    else {
      bar.style.paddingRight = `${summary.getBoundingClientRect().width + 12}px`;
      shown = fitChartLegendItems(compactWidths, compact.clientWidth);
    }
    const focused = document.activeElement;
    compactButtons.forEach((button, index) => {
      button.hidden = index >= shown;
    });
    lastFitWidth = compact.clientWidth;
    lastDisclosureOpen = disclosure.open;
    if (compactButtons.some(button => button === focused && button.hidden)) summary.focus({ preventScroll: true });
    if (focused === summary && disclosure.hidden) compactButtons[0]?.focus({ preventScroll: true });
  }
  summary.addEventListener('click', () => {
    if (!disclosure.open && listDirty) renderList();
  });
  disclosure.addEventListener('toggle', () => {
    if (disclosure.open && listDirty) renderList();
    if (!disclosure.open) setHighlight(null);
    fitCompact();
  });
  search.addEventListener('input', () => {
    setHighlight(null);
    list.scrollTop = 0;
    renderList();
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !disclosure.open) return;
    event.preventDefault();
    event.stopPropagation();
    disclosure.open = false;
    summary.focus({ preventScroll: true });
    setHighlight(null);
    fitCompact();
  });
  return {
    render(nextEntries, nextDimension, onHighlight) {
      highlight = onHighlight;
      const nextSignature = JSON.stringify(
        nextEntries.map(({ key, label, name, detail, color, count, searchText }) => [key, label, name, detail, color, count, searchText])
      );
      const dimensionChanged = dimension !== nextDimension;
      const changed = dimensionChanged || signature !== nextSignature;
      const hadFocus = root.contains(document.activeElement);
      const scrollTop = list.scrollTop;
      entries = nextEntries;
      root.hidden = !entries.length;
      if (dimensionChanged || !entries.length) {
        disclosure.open = false;
        search.value = '';
        activeKey = null;
      }
      dimension = nextDimension;
      search.placeholder = dimension === 'time' ? '搜索日期、模型、供应商或账号' : '搜索模型、供应商或账号';
      signature = nextSignature;
      if (changed) {
        compactButtons = entries.map(entry => makeButton(entry, false));
        compact.replaceChildren(...compactButtons);
        compactWidths = null;
        lastFitWidth = -1;
        listDirty = true;
        if (disclosure.open) renderList();
        list.scrollTop = dimensionChanged ? 0 : scrollTop;
        if (hadFocus && !root.hidden) (disclosure.open ? search : summary).focus({ preventScroll: true });
        if (activeKey && !entries.some(entry => entry.key === activeKey)) activeKey = null;
      }
      fitCompact(changed);
      if (activeKey !== null) highlight(activeKey);
    },
    destroy() {
      root.remove();
    }
  };
}
