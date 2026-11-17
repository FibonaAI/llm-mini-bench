/** A selectable leaf is scoped to provider and account, never just model. */
export function selectionKey(record) {
  return JSON.stringify([record.providerId ?? record.provider, record.accountId ?? record.account, record.model, record.think]);
}
/** Channel identity preserves recorded instances even when display names coincide. */
export const providerIdentity = record => record.providerId ?? record.provider;
const accountIdentity = record => record.accountId ?? record.account;
/** Model labels come from supplied display names, never route path parsing. */
export const modelFilterLabel = record => record.modelDisplayName ?? record.model;
/** Normalize display model spelling for cross-channel facets, preserving request IDs. */
export const modelFilterIdentity = record => String(modelFilterLabel(record)).normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s_-]+/g, '-');
const normalizeSearch = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** Default omits reasoning and must stay distinct from explicit none. */
export const thinkingLabel = value => value === 'default' ? '默认（不指定）' : value === 'unknown' ? '未记录' : String(value);

/** Unified search uses recorded identity fields, never inferred route segments. */
export function recordMatchesSearch(record, query) {
  const tokens = query.trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
  const text = normalizeSearch([record.model, record.modelDisplayName, record.provider, record.providerName, record.providerDisplayId, providerIdentity(record), record.account, record.accountDisplayId, accountIdentity(record), thinkingLabel(record.think), record.think].join(' '));
  return tokens.every(token => text.includes(token));
}
let pickerSequence = 0;

/** Shared cross-channel search; omitted selectedKeys means all known leaves, [] means none. */
export function createDataPicker(container, { records, selectedKeys, mode = 'analysis', onChange = () => {} }) {
  const leaves = [...new Map(records.map(record => [selectionKey(record), { ...record }])).entries()].map(([key, record]) => ({ ...record, key }));
  const knownKeys = new Set(leaves.map(leaf => leaf.key));
  let selected = new Set((selectedKeys === undefined ? [...knownKeys] : selectedKeys).filter(key => knownKeys.has(key)));
  let open = false;
  let destroyed = false;
  let visibleLeaves = [];
  let visibleRowCount = 0;
  const title = mode === 'tasks' ? '选择目标' : '选择数据';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text, action) => {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const trigger = button('dp-trigger', '', () => open ? hide() : show());
  const popup = element('section', 'dp-popup');
  popup.id = `dp-popup-${++pickerSequence}`;
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', title);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', popup.id);
  const header = element('div', 'dp-header');
  header.append(element('strong', 'dp-title', title), element('span', 'dp-hint', '跨渠道搜索，保留已选项'));
  const searchWrap = element('div', 'dp-search-wrap');
  const search = element('input', 'dp-search');
  search.type = 'search';
  search.placeholder = '搜索模型、渠道或账号';
  search.setAttribute('aria-label', search.placeholder);
  const clearSearch = button('dp-clear-search', '×', () => { search.value = ''; render(); search.focus(); });
  clearSearch.setAttribute('aria-label', '清空搜索');
  searchWrap.append(search, clearSearch);
  const filters = element('div', 'dp-filters');
  function setFilterOptions(select, options) {
    const previous = select.value;
    select.replaceChildren();
    const all = element('option', '', '全部');
    all.value = '';
    select.append(all);
    const entries = [...options];
    const labelCounts = new Map();
    for (const [, text] of entries) labelCounts.set(text, (labelCounts.get(text) ?? 0) + 1);
    // Identical labels can refer to different instances; keep their exact option values and show IDs.
    for (const [value, text] of entries) {
      const option = element('option', '', labelCounts.get(text) > 1 ? `${text} · ${value}` : text);
      option.value = value;
      select.append(option);
    }
    select.value = entries.some(([value]) => value === previous) ? previous : '';
  }
  function filter(name, options, className) {
    const label = element('label', 'dp-filter', name);
    const select = element('select', className);
    select.setAttribute('aria-label', `筛选${name}`);
    setFilterOptions(select, options);
    select.addEventListener('change', () => {
      if (select === providers) updateModelOptions();
      list.scrollTop = 0;
      render();
    });
    label.append(select);
    filters.append(label);
    return select;
  }
  const providerOptions = new Map(leaves.map(leaf => [providerIdentity(leaf), leaf.providerName ?? leaf.providerDisplayId ?? leaf.provider]));
  const providers = filter('渠道', providerOptions, 'dp-provider-filter');
  const modelLabels = new Map();
  for (const leaf of leaves) if (!modelLabels.has(modelFilterIdentity(leaf))) modelLabels.set(modelFilterIdentity(leaf), modelFilterLabel(leaf));
  const modelOptions = scope => new Map(scope.map(leaf => [modelFilterIdentity(leaf), modelLabels.get(modelFilterIdentity(leaf))]));
  const models = filter('模型', modelOptions(leaves), 'dp-model-filter');
  function updateModelOptions() {
    const scope = leaves.filter(leaf => !providers.value || providerIdentity(leaf) === providers.value);
    setFilterOptions(models, modelOptions(scope));
  }
  const efforts = [...new Set(leaves.map(leaf => leaf.think))];
  const effortOrder = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown'];
  efforts.sort((a, b) => (effortOrder.includes(a) ? effortOrder.indexOf(a) : 99) - (effortOrder.includes(b) ? effortOrder.indexOf(b) : 99));
  const thinking = filter('思考', efforts.map(effort => [effort, thinkingLabel(effort)]), 'dp-thinking-filter');
  const resetFilters = button('dp-reset-filters', '重置条件', () => {
    search.value = providers.value = models.value = thinking.value = '';
    updateModelOptions();
    list.scrollTop = 0;
    render();
  });
  filters.append(resetFilters);
  const resultBar = element('div', 'dp-result-bar');
  const resultCount = element('span', 'dp-result-count');
  resultCount.setAttribute('role', 'status');
  resultCount.setAttribute('aria-live', 'polite');
  const selectVisible = button('dp-select-visible', '全选搜索结果', () => changeKeys(visibleLeaves, true));
  resultBar.append(resultCount, selectVisible);
  const columnHead = element('div', 'dp-column-head');
  columnHead.setAttribute('aria-hidden', 'true');
  for (const text of ['渠道', '模型', '思考']) columnHead.append(element('span', '', text));
  const list = element('div', 'dp-results');
  const footer = element('div', 'dp-footer');
  const summary = element('span', 'dp-summary');
  const clear = button('dp-action', '清空全部', () => changeKeys(leaves, false));
  const done = button('dp-done', '完成', () => { hide(); trigger.focus(); });
  footer.append(summary, clear, done);
  popup.append(header, searchWrap, filters, resultBar, columnHead, list, footer);
  container.append(trigger);
  document.body.append(popup);
  search.addEventListener('input', () => { list.scrollTop = 0; render(); });

  function matchingLeaves() {
    return leaves.filter(leaf => {
      if (providers.value && providerIdentity(leaf) !== providers.value) return false;
      if (models.value && modelFilterIdentity(leaf) !== models.value) return false;
      if (thinking.value && leaf.think !== thinking.value) return false;
      return recordMatchesSearch(leaf, search.value);
    });
  }
  function changeKeys(scope, checked) {
    for (const leaf of scope) checked ? selected.add(leaf.key) : selected.delete(leaf.key);
    render();
    onChange([...selected]);
  }
  function render() {
    const focusId = document.activeElement?.dataset?.focusId;
    const scrollTop = list.scrollTop;
    visibleLeaves = matchingLeaves();
    const groups = new Map();
    for (const leaf of visibleLeaves) {
      const id = JSON.stringify([providerIdentity(leaf), accountIdentity(leaf), leaf.model]);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(leaf);
    }
    const query = normalizeSearch(search.value);
    const exact = scope => [scope[0].model, scope[0].modelDisplayName].some(name => normalizeSearch(name) === query);
    const rows = [...groups.entries()].sort(([, a], [, b]) => Number(exact(b)) - Number(exact(a)));
    visibleRowCount = rows.length;
    list.replaceChildren();
    for (const [id, scope] of rows) {
      const record = scope[0];
      const row = element('article', 'dp-result-row');
      row.dataset.providerId = providerIdentity(record);
      row.dataset.accountId = accountIdentity(record);
      row.dataset.model = record.model;
      const check = element('input', 'dp-check');
      check.type = 'checkbox';
      check.dataset.focusId = `${id}-check`;
      check.setAttribute('aria-label', `选择 ${record.model} / ${record.providerName ?? record.provider} / ${record.account} 的匹配项目`);
      const count = scope.filter(leaf => selected.has(leaf.key)).length;
      check.checked = count === scope.length;
      check.indeterminate = count > 0 && count < scope.length;
      check.addEventListener('change', () => changeKeys(scope, check.checked));
      const model = element('strong', 'dp-model-name', record.modelDisplayName ?? record.model);
      model.setAttribute('title', record.model);
      const route = element('div', 'dp-route');
      route.append(element('span', 'dp-provider-name', record.providerName ?? record.providerDisplayId ?? record.provider));
      route.setAttribute('title', record.providerDisplayId ?? record.providerName ?? record.provider);
      const account = element('small', 'dp-account-name', record.accountShortName && record.accountDisplayId ? `${record.accountShortName} · ${record.accountDisplayId}` : record.accountShortName ?? record.account);
      account.setAttribute('title', record.accountDisplayId ?? record.account);
      route.append(account);
      const levels = element('div', 'dp-thinking-list');
      for (const leaf of scope) {
        const selectedLeaf = selected.has(leaf.key);
        const level = button('dp-think', thinkingLabel(leaf.think), () => changeKeys([leaf], !selected.has(leaf.key)));
        level.setAttribute('aria-pressed', String(selectedLeaf));
        level.setAttribute('aria-label', `${leaf.providerName ?? leaf.provider} / ${leaf.account} / ${leaf.model} / ${thinkingLabel(leaf.think)}`);
        if (leaf.think === 'default') level.setAttribute('title', '请求中不指定 reasoning，使用上游默认行为；不等于 none');
        for (const field of ['provider', 'account', 'model', 'think']) level.dataset[field] = leaf[field];
        level.dataset.providerId = providerIdentity(leaf);
        level.dataset.accountId = accountIdentity(leaf);
        level.dataset.selectionKey = leaf.key;
        level.dataset.focusId = leaf.key;
        levels.append(level);
      }
      row.append(check, route, model, levels);
      if (mode === 'analysis') {
        const observations = records.filter(leaf => providerIdentity(leaf) === providerIdentity(record) && accountIdentity(leaf) === accountIdentity(record) && leaf.model === record.model && scope.some(visible => visible.think === leaf.think));
        const note = element('div', 'dp-record-note', `${observations.length} 个结果${observations.some(leaf => leaf.exclusionReason) ? ' · 含未入图记录' : ''}`);
        note.setAttribute('title', observations.map(leaf => `${thinkingLabel(leaf.think)} · ${leaf.original?.created_at ?? leaf.created_at ?? '时间未记录'}${leaf.exclusionReason ? ` · 未入图：${leaf.exclusionReason}` : ''}`).join('\n'));
        row.append(note);
      }
      list.append(row);
    }
    if (!rows.length) list.append(element('p', 'dp-empty', '没有匹配结果，试试缩短关键词或重置条件。'));
    const visibleKeys = new Set(visibleLeaves.map(leaf => leaf.key));
    const hiddenCount = [...selected].filter(key => !visibleKeys.has(key)).length;
    summary.textContent = `已选 ${selected.size} / ${leaves.length}`;
    if (hiddenCount) summary.append(element('small', 'dp-hidden-count', `${hiddenCount} 项在当前筛选之外`));
    trigger.textContent = `${title} ${selected.size}/${leaves.length} ▾`;
    trigger.setAttribute('aria-expanded', String(open));
    resultCount.textContent = `${rows.length} 条${mode === 'tasks' ? '路由' : '模型记录'} · ${new Set(visibleLeaves.map(providerIdentity)).size} 个渠道`;
    clear.disabled = selected.size === 0;
    clearSearch.disabled = !search.value;
    selectVisible.disabled = !visibleLeaves.length || visibleLeaves.every(leaf => selected.has(leaf.key));
    resetFilters.disabled = !search.value && !providers.value && !models.value && !thinking.value;
    list.scrollTop = scrollTop;
    if (focusId) [...popup.querySelectorAll('[data-focus-id]')].find(node => node.dataset.focusId === focusId)?.focus({ preventScroll: true });
    if (open) position();
  }
  function position() {
    if (!open) return;
    const rect = trigger.getBoundingClientRect();
    const inset = 16, gap = 8;
    const width = Math.min(720, window.innerWidth - inset * 2);
    popup.style.width = `${Math.max(0, width)}px`;
    const fixedHeight = 2 + [...popup.children].filter(child => child !== list).reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
    const rowsHeight = [...list.children].reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    const lowerEdge = Math.max(inset, Math.min(rect.bottom + gap, window.innerHeight - inset));
    const upperEdge = Math.max(inset, Math.min(rect.top - gap, window.innerHeight - inset));
    const below = Math.max(0, window.innerHeight - inset - lowerEdge);
    const above = Math.max(0, upperEdge - inset);
    const useAbove = below < 320 && above > below;
    const available = useAbove ? above : below;
    // A short viewport needs the whole popup, including filters and footer, inside its bounds.
    const contentHeight = Math.min(640, Math.max(fixedHeight + rowsHeight, 244 + Math.max(1, visibleRowCount) * (window.innerWidth <= 772 ? 124 : mode === 'tasks' ? 92 : 90)));
    const compact = available < 300 || (visibleRowCount > 2 && available < Math.min(420, contentHeight)) || (visibleRowCount === 1 && fixedHeight + rowsHeight > available);
    const height = Math.max(0, Math.min(contentHeight, compact ? window.innerHeight - inset * 2 : available));
    popup.style.height = `${height}px`;
    popup.style.left = `${Math.max(inset, Math.min(rect.left, window.innerWidth - width - inset))}px`;
    popup.style.top = `${compact ? Math.max(inset, Math.min(lowerEdge, window.innerHeight - inset - height)) : useAbove ? upperEdge - height : lowerEdge}px`;
    popup.dataset.placement = compact ? 'viewport' : useAbove ? 'above' : 'below';
  }
  function show() {
    if (destroyed) return;
    open = true;
    popup.hidden = false;
    render();
    search.focus();
  }
  function hide() { open = false; popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
  function outsideClick(event) { if (open && !popup.contains(event.target) && !trigger.contains(event.target)) hide(); }
  function escape(event) { if (open && event.key === 'Escape') { event.preventDefault(); hide(); trigger.focus(); } }
  document.addEventListener('pointerdown', outsideClick);
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  render();
  return {
    getSelection: () => [...selected],
    setSelection(keys) { selected = new Set([...keys].filter(key => knownKeys.has(key))); render(); },
    show,
    hide,
    destroy() {
      destroyed = true;
      hide();
      trigger.remove();
      popup.remove();
      document.removeEventListener('pointerdown', outsideClick);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    },
  };
}
