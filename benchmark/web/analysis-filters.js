import { analysisPopoverPlacement } from './analysis-popover.js';
import { providerIdentity, modelFilterIdentity, modelFilterLabel, thinkingLabel, recordMatchesSearch } from './data-picker.js';

const facets = [
  { id: 'provider', label: '渠道', width: 320, value: providerIdentity, text: record => record.providerName ?? record.provider },
  { id: 'model', label: '模型', width: 340, value: modelFilterIdentity, text: modelFilterLabel },
  { id: 'think', label: 'Thinking', width: 240, value: record => record.think, text: record => thinkingLabel(record.think) }
];

/** Analysis facets are OR within a dimension, AND across dimensions; empty means unrestricted. */
export function createAnalysisFilterState() {
  return { query: '', source: 'all', provider: new Set(), model: new Set(), think: new Set() };
}

/** Filter observations without deduplicating repeated runs or mutating identity. */
export function matchesAnalysisFilters(record, filters, omittedFacet = null) {
  return (filters.source === 'all' || record.source === filters.source)
    && recordMatchesSearch(record, filters.query)
    && facets.every(facet => facet.id === omittedFacet || !filters[facet.id].size || filters[facet.id].has(facet.value(record)));
}

/** Direct chart filtering is separate from the task picker's explicit target selection. */
export function createAnalysisFilters(container, { onChange = () => {} } = {}) {
  const state = createAnalysisFilterState();
  let records = [];
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
  search.placeholder = '搜索模型、渠道或账号';
  search.setAttribute('aria-label', '搜索分析结果');
  search.setAttribute('spellcheck', 'false');
  search.setAttribute('autocapitalize', 'none');
  search.addEventListener('input', () => { state.query = search.value; update(); });
  container.append(search);
  const conditions = document.getElementById('analysis-conditions');
  const controls = facets.map(facet => {
    const details = node('details', 'af-facet');
    details.dataset.facet = facet.id;
    const summary = node('summary', 'btn');
    const popup = node('div', 'af-options');
    const heading = node('div', 'af-heading');
    const actions = node('div', 'af-heading-actions');
    const unrestricted = button('text-control af-unrestricted', '不限', () => { state[facet.id].clear(); update(); });
    const close = button('text-control', '完成', () => { details.open = false; summary.focus({ preventScroll: true }); });
    actions.append(unrestricted, close);
    heading.append(node('strong', '', facet.label), actions);
    const list = node('div', 'af-option-list');
    popup.append(heading, list);
    details.append(summary, popup);
    details.addEventListener('toggle', () => {
      if (details.open) {
        for (const control of controls) if (control.details !== details) control.details.open = false;
        positionOpenFacet();
      }
    });
    container.append(details);
    return { facet, details, summary, list, popup };
  });
  function positionOpenFacet() {
    for (const { facet, details, summary, popup } of controls) {
      if (!details.open) continue;
      const inset = 16;
      const rect = summary.getBoundingClientRect();
      const width = Math.max(0, Math.min(facet.width, window.innerWidth - inset * 2));
      Object.assign(popup.style, { position: 'fixed', width: `${width}px`, maxWidth: `${width}px`, maxHeight: `${Math.max(0, window.innerHeight - inset * 2)}px`, overflowY: 'auto', right: 'auto', marginTop: '0px' });
      const height = popup.getBoundingClientRect().height;
      const placement = analysisPopoverPlacement(rect, width, height, window.innerWidth, window.innerHeight);
      popup.style.left = `${placement.left}px`;
      popup.style.top = `${placement.top}px`;
    }
  }
  function render() {
    const focused = document.activeElement;
    const focusValue = focused?.dataset.value;
    const focusFacet = focused?.closest('.af-facet')?.dataset.facet;
    const focusOnly = focused?.classList.contains('af-only');
    conditions.replaceChildren();
    if (state.query) conditions.append(button('af-condition', `搜索：${state.query} ×`, () => { state.query = search.value = ''; update(); search.focus(); }));
    for (const { facet, summary, list } of controls) {
      const values = new Map(records.map(record => [facet.value(record), facet.text(record)]));
      const labels = new Map();
      for (const label of values.values()) labels.set(label, (labels.get(label) ?? 0) + 1);
      const labelFor = value => labels.get(values.get(value)) > 1 ? `${values.get(value)} · ${value}` : values.get(value) ?? value;
      summary.textContent = `${facet.label} · ${state[facet.id].size ? `${state[facet.id].size} 项` : '不限'}`;
      summary.dataset.filtered = String(state[facet.id].size > 0);
      list.replaceChildren();
      for (const value of state[facet.id]) {
        const chip = button('af-condition', `${facet.label}：${labelFor(value)} ×`, () => { state[facet.id].delete(value); update(); summary.focus(); });
        chip.setAttribute('aria-label', `移除${facet.label}条件：${labelFor(value)}`);
        conditions.append(chip);
      }
      // Keep temporarily absent selections visible so refreshes never silently broaden a filter.
      for (const value of state[facet.id]) if (!values.has(value)) values.set(value, value);
      for (const [value] of values) {
        const count = records.filter(record => matchesAnalysisFilters(record, state, facet.id) && facet.value(record) === value).length;
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
        label.append(checkbox, node('span', '', labelFor(value)), node('span', 'muted', String(count)));
        const only = button('text-control af-only', '仅此项', () => { state[facet.id] = new Set([value]); update(); });
        only.dataset.value = value;
        only.setAttribute('aria-label', `仅筛选${facet.label}：${labelFor(value)}`);
        row.append(label, only);
        list.append(row);
      }
      if (!values.size) list.append(node('p', 'muted', '暂无选项'));
    }
    conditions.hidden = !conditions.children.length;
    if (focusFacet && focusValue !== undefined) {
      const control = controls.find(control => control.facet.id === focusFacet);
      [...control.list.querySelectorAll(focusOnly ? '.af-only' : 'input')].find(input => input.dataset.value === focusValue)?.focus({ preventScroll: true });
    }
    positionOpenFacet();
  }
  function update() { render(); onChange(); }
  function outside(event) { for (const { details } of controls) if (!details.contains(event.target)) details.open = false; }
  function escape(event) {
    if (event.key !== 'Escape') return;
    for (const { details, summary } of controls) if (details.open) { details.open = false; summary.focus(); event.preventDefault(); }
  }
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', positionOpenFacet);
  window.addEventListener('scroll', positionOpenFacet, true);
  container.addEventListener('keydown', escape);
  render();
  return {
    matches: record => matchesAnalysisFilters(record, state),
    setRecords(next) { records = next; render(); },
    setSource(source) { state.source = source; update(); },
    reset() { Object.assign(state, createAnalysisFilterState()); search.value = ''; for (const { details } of controls) details.open = false; update(); },
    focus() { search.focus(); }
  };
}
