import { analysisPopoverPlacement } from './analysis-popover.js';
import {
  providerIdentity,
  accountIdentity,
  modelFilterIdentity,
  modelFilterLabel,
  thinkingLabel,
  compileSearchTokens,
  recordMatchesTokens,
  recordMatchesSearch
} from './data-picker.js';

const isGenericAccount = record => {
  const id = String(accountIdentity(record) ?? '');
  return id === 'unknown-account' || id.startsWith('gateway-binding:');
};
const shortAccountLabel = record => {
  const id = String(accountIdentity(record) ?? '');
  if (id === 'unknown-account') return '未记录账号';
  if (id.startsWith('gateway-binding:')) return record.accountShortName ?? '网关自动分配';
  if (record.accountDisplayId && record.accountDisplayId !== '实际账号未记录') return record.accountDisplayId;
  return record.accountShortName ?? record.account ?? '未记录账号';
};
const accountFacetValue = record =>
  isGenericAccount(record) ? accountIdentity(record) : JSON.stringify([providerIdentity(record), accountIdentity(record)]);
const accountFacetRank = value => (String(value).startsWith('gateway-binding:') ? 1 : value === 'unknown-account' ? 2 : 0);

const SOURCE_OPTIONS = [
  ['run', '我的评测'],
  ['baseline', '基线']
];
const sourceLabel = value => (value === 'baseline' ? '基线' : value === 'run' ? '我的评测' : String(value));
const sourceRank = value => (value === 'run' ? 0 : value === 'baseline' ? 1 : 2);
const facetMatches = (filterValue, recordValue) => {
  if (filterValue instanceof Set) return !filterValue.size || filterValue.has(recordValue);
  return !filterValue || filterValue === 'all' || filterValue === recordValue;
};

const facets = [
  { id: 'provider', label: '渠道', width: 320, value: providerIdentity, text: record => record.providerName ?? record.provider },
  {
    id: 'account',
    label: '账号',
    heading: '账号 / Key',
    width: 340,
    value: accountFacetValue,
    text: record =>
      isGenericAccount(record) ? shortAccountLabel(record) : `${record.providerName ?? record.provider} / ${shortAccountLabel(record)}`,
    option: record =>
      isGenericAccount(record)
        ? { primary: shortAccountLabel(record), secondary: '' }
        : { primary: shortAccountLabel(record), secondary: record.providerName ?? record.provider },
    sort: (a, b) =>
      accountFacetRank(a[0]) - accountFacetRank(b[0]) ||
      String(a[1].secondary || '').localeCompare(String(b[1].secondary || ''), 'zh-CN') ||
      String(a[1].primary || '').localeCompare(String(b[1].primary || ''), 'zh-CN') ||
      String(a[0]).localeCompare(String(b[0]))
  },
  { id: 'model', label: '模型', width: 340, value: modelFilterIdentity, text: modelFilterLabel },
  { id: 'think', label: 'Thinking', width: 240, value: record => record.think, text: record => thinkingLabel(record.think) },
  {
    id: 'source',
    label: '来源',
    heading: '数据来源',
    width: 240,
    fixedOptions: SOURCE_OPTIONS,
    value: record => record.source,
    text: record => sourceLabel(record.source),
    sort: (a, b) => sourceRank(a[0]) - sourceRank(b[0]) || String(a[0]).localeCompare(String(b[0]))
  }
];

/** Analysis facets are OR within a dimension, AND across dimensions; empty means unrestricted. */
export function createAnalysisFilterState() {
  return { query: '', source: new Set(), provider: new Set(), account: new Set(), model: new Set(), think: new Set() };
}

/** Filter observations without deduplicating repeated runs or mutating identity. */
export function matchesAnalysisFilters(record, filters, omittedFacet = null, compiledTokens = null) {
  return (
    (compiledTokens ? recordMatchesTokens(record, compiledTokens) : recordMatchesSearch(record, filters.query)) &&
    facets.every(facet => facet.id === omittedFacet || facetMatches(filters[facet.id], facet.value(record)))
  );
}

/** Direct chart filtering is separate from the task picker's explicit target selection. */
export function createAnalysisFilters(container, { onChange = () => {} } = {}) {
  const state = createAnalysisFilterState();
  let records = [];
  let cachedCatalogRecords = null;
  let cachedCatalog = null;
  let cachedQueryString = '';
  let cachedQueryTokens = [];
  const getQueryTokens = () => {
    if (cachedQueryString !== state.query) {
      cachedQueryString = state.query;
      cachedQueryTokens = compileSearchTokens(state.query);
    }
    return cachedQueryTokens;
  };
  const getFacetCatalog = () => {
    if (cachedCatalogRecords === records && cachedCatalog) return cachedCatalog;
    cachedCatalogRecords = records;
    const byFacet = new Map();
    for (const facet of facets) {
      const values = new Map();
      if (facet.fixedOptions) for (const [key, text] of facet.fixedOptions) values.set(key, { text, primary: text, secondary: '' });
      for (const record of records) {
        const key = facet.value(record);
        if (values.has(key)) continue;
        const text = facet.text(record);
        const option = facet.option ? facet.option(record) : { primary: text, secondary: '' };
        values.set(key, { text, ...option });
      }
      const labels = new Map();
      for (const entry of values.values()) labels.set(entry.text, (labels.get(entry.text) ?? 0) + 1);
      byFacet.set(facet.id, { values, labels });
    }
    cachedCatalog = byFacet;
    return byFacet;
  };
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const button = (className, text, action) => {
    const result = node('button', className, text);
    result.type = 'button';
    result.addEventListener('click', action);
    return result;
  };
  const search = node('input', 'field af-search');
  search.type = 'search';
  search.placeholder = '搜索模型、渠道、账号或 Key';
  search.setAttribute('aria-label', '搜索分析结果');
  search.setAttribute('spellcheck', 'false');
  search.setAttribute('autocapitalize', 'none');
  search.addEventListener('input', () => {
    state.query = search.value;
    update();
  });
  container.append(search);
  const conditions = document.getElementById('analysis-conditions');
  const controls = facets.map(facet => {
    const details = node('details', 'af-facet');
    details.dataset.facet = facet.id;
    const summary = node('summary', 'btn');
    const popup = node('div', 'af-options');
    const heading = node('div', 'af-heading');
    const actions = node('div', 'af-heading-actions');
    const unrestricted = button('text-control af-unrestricted', '不限', () => {
      state[facet.id].clear();
      update();
    });
    const close = button('text-control', '完成', () => {
      details.open = false;
      summary.focus({ preventScroll: true });
    });
    actions.append(unrestricted, close);
    heading.append(node('strong', '', facet.heading ?? facet.label), actions);
    const facetSearch = node('input', 'field af-facet-search');
    facetSearch.type = 'text';
    facetSearch.placeholder = `筛选${facet.heading ?? facet.label}…`;
    facetSearch.setAttribute('aria-label', `筛选${facet.heading ?? facet.label}选项`);
    facetSearch.setAttribute('spellcheck', 'false');
    facetSearch.setAttribute('autocapitalize', 'none');
    facetSearch.hidden = true;
    facetSearch.addEventListener('input', () => render());
    const list = node('div', 'af-option-list');
    popup.append(heading, facetSearch, list);
    details.append(summary, popup);
    summary.addEventListener('click', () => {
      if (!details.open) renderFacetNow(facet.id);
    });
    details.addEventListener('toggle', () => {
      if (details.open) {
        for (const control of controls) if (control.details !== details) control.details.open = false;
        renderOpenFacet(facet.id);
        positionOpenFacet();
      } else if (facetSearch.value) {
        facetSearch.value = '';
      }
    });
    container.append(details);
    return { facet, details, summary, facetSearch, list, popup };
  });
  function positionOpenFacet(event) {
    if (event?.type === 'scroll' && controls.some(({ popup }) => popup.contains(event.target))) return;
    for (const { facet, details, summary, popup } of controls) {
      if (!details.open) continue;
      const inset = 16;
      const rect = summary.getBoundingClientRect();
      const width = Math.max(0, Math.min(facet.width, window.innerWidth - inset * 2));
      Object.assign(popup.style, {
        position: 'fixed',
        width: `${width}px`,
        maxWidth: `${width}px`,
        maxHeight: `${Math.max(0, window.innerHeight - inset * 2)}px`,
        overflowY: 'auto',
        right: 'auto',
        marginTop: '0px'
      });
      const height = popup.getBoundingClientRect().height;
      const placement = analysisPopoverPlacement(rect, width, height, window.innerWidth, window.innerHeight);
      popup.style.left = `${placement.left}px`;
      popup.style.top = `${placement.top}px`;
    }
  }
  function renderFacetOptions(control, baseRecords, catalogEntry) {
    const { facet, facetSearch, list } = control;
    const values = new Map(catalogEntry.values);
    const labels = catalogEntry.labels;
    const labelFor = value => {
      const entry = values.get(value);
      if (!entry) return value;
      return (labels.get(entry.text) ?? 0) > 1 ? `${entry.text} · ${value}` : entry.text;
    };
    list.replaceChildren();
    // Keep temporarily absent selections visible so refreshes never silently broaden a filter.
    for (const value of state[facet.id]) if (!values.has(value)) values.set(value, { text: value, primary: value, secondary: '' });
    const ordered = facet.sort ? [...values.entries()].sort(facet.sort) : [...values.entries()];
    const showFacetSearch = ordered.length > 8;
    facetSearch.hidden = !showFacetSearch;
    if (!showFacetSearch && facetSearch.value) facetSearch.value = '';
    const facetQuery = showFacetSearch ? facetSearch.value.trim().toLocaleLowerCase() : '';
    const shown = facetQuery
      ? ordered.filter(([value, entry]) =>
          `${entry.primary} ${entry.secondary} ${entry.text} ${value}`.toLocaleLowerCase().includes(facetQuery)
        )
      : ordered;
    // Single O(N) pass over baseRecords instead of O(V * N).
    const otherFacets = facets.filter(other => other.id !== facet.id && state[other.id].size > 0);
    const counts = new Map();
    for (const record of baseRecords) {
      if (otherFacets.length && !otherFacets.every(other => state[other.id].has(other.value(record)))) continue;
      const key = facet.value(record);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [value, entry] of shown) {
      const count = counts.get(value) ?? 0;
      const row = node('div', 'af-option');
      const label = node('label', '');
      const checkbox = node('input', '');
      checkbox.type = 'checkbox';
      checkbox.dataset.value = value;
      checkbox.checked = state[facet.id].has(value);
      checkbox.addEventListener('change', () => {
        checkbox.checked ? state[facet.id].add(value) : state[facet.id].delete(value);
        update();
      });
      const textWrap = node('span', 'af-option-text');
      const duplicate = (labels.get(entry.text) ?? 0) > 1;
      textWrap.append(node('span', 'af-option-primary', duplicate && !entry.secondary ? `${entry.primary} · ${value}` : entry.primary));
      if (entry.secondary) textWrap.append(node('span', 'af-option-sub', duplicate ? `${entry.secondary} · ${value}` : entry.secondary));
      label.append(checkbox, textWrap, node('span', 'muted af-option-count', String(count)));
      const only = button('text-control af-only', '仅此项', () => {
        state[facet.id] = new Set([value]);
        update();
      });
      only.dataset.value = value;
      only.setAttribute('aria-label', `仅筛选${facet.label}：${labelFor(value)}`);
      row.append(label, only);
      list.append(row);
    }
    if (!values.size) list.append(node('p', 'muted', '暂无选项'));
    else if (!shown.length) list.append(node('p', 'muted af-empty', '没有匹配选项'));
  }
  function getBaseRecords() {
    const tokens = getQueryTokens();
    return records.filter(record => recordMatchesTokens(record, tokens));
  }
  function renderFacetNow(facetId) {
    const control = controls.find(item => item.facet.id === facetId);
    if (!control) return;
    const catalog = getFacetCatalog();
    renderFacetOptions(control, getBaseRecords(), catalog.get(facetId));
  }
  function renderOpenFacet(facetId) {
    const control = controls.find(item => item.facet.id === facetId);
    if (!control || !control.details.open) return;
    const catalog = getFacetCatalog();
    renderFacetOptions(control, getBaseRecords(), catalog.get(facetId));
  }
  function render() {
    const focused = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusValue = focused?.dataset.value;
    const focusFacet = /** @type {HTMLElement | null} */ (focused?.closest('.af-facet'))?.dataset.facet;
    const focusOnly = focused?.classList.contains('af-only');
    const catalog = getFacetCatalog();
    let baseRecords = null;
    conditions.replaceChildren();
    if (state.query)
      conditions.append(
        button('af-condition', `搜索：${state.query} ×`, () => {
          state.query = search.value = '';
          update();
          search.focus();
        })
      );
    for (const control of controls) {
      const { facet, details, summary } = control;
      const catalogEntry = catalog.get(facet.id);
      const { values, labels } = catalogEntry;
      const labelFor = value => {
        const entry = values.get(value);
        if (!entry) return value;
        return (labels.get(entry.text) ?? 0) > 1 ? `${entry.text} · ${value}` : entry.text;
      };
      const selectedCount = state[facet.id].size;
      const summaryValue =
        selectedCount === 0
          ? '不限'
          : facet.id === 'source' && selectedCount === 1
            ? labelFor([...state[facet.id]][0])
            : `${selectedCount} 项`;
      summary.textContent = `${facet.label} · ${summaryValue}`;
      summary.dataset.filtered = String(selectedCount > 0);
      for (const value of state[facet.id]) {
        const chip = button('af-condition', `${facet.label}：${labelFor(value)} ×`, () => {
          state[facet.id].delete(value);
          update();
          summary.focus();
        });
        chip.setAttribute('aria-label', `移除${facet.label}条件：${labelFor(value)}`);
        conditions.append(chip);
      }
      if (details.open) {
        if (!baseRecords) baseRecords = getBaseRecords();
        renderFacetOptions(control, baseRecords, catalogEntry);
      }
    }
    conditions.hidden = !conditions.children.length;
    if (focusFacet && focusValue !== undefined) {
      const control = controls.find(control => control.facet.id === focusFacet);
      [...control.list.querySelectorAll(focusOnly ? '.af-only' : 'input')]
        .find(input => input.dataset.value === focusValue)
        ?.focus({ preventScroll: true });
    }
    positionOpenFacet();
  }
  function update() {
    render();
    onChange();
  }
  function outside(event) {
    for (const { details } of controls) if (!details.contains(event.target)) details.open = false;
  }
  function escape(event) {
    if (event.key !== 'Escape') return;
    for (const { details, summary } of controls)
      if (details.open) {
        details.open = false;
        summary.focus();
        event.preventDefault();
      }
  }
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', positionOpenFacet);
  window.addEventListener('scroll', positionOpenFacet, true);
  container.addEventListener('keydown', escape);
  render();
  return {
    matches: record => matchesAnalysisFilters(record, state, null, getQueryTokens()),
    setRecords(next) {
      records = next;
      render();
    },
    setSource(source) {
      if (!source || source === 'all') state.source.clear();
      else state.source = new Set([source]);
      update();
    },
    reset() {
      Object.assign(state, createAnalysisFilterState());
      search.value = '';
      for (const { details, facetSearch } of controls) {
        details.open = false;
        facetSearch.value = '';
      }
      update();
    },
    focus() {
      search.focus();
    }
  };
}
