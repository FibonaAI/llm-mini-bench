/** A selectable leaf is scoped to provider and account, never just model. */
export function selectionKey(record) {
  return JSON.stringify([record.providerId ?? record.provider, record.accountId ?? record.account, record.model, record.think]);
}
/** Channel identity preserves recorded instances even when display names coincide. */
export const providerIdentity = record => record.providerId ?? record.provider;
export const accountIdentity = record => record.accountId ?? record.account;
/** Model labels come from supplied display names, never route path parsing. */
export const modelFilterLabel = record => record.modelDisplayName ?? record.model;
/** Normalize display model spelling for cross-channel facets, preserving request IDs. */
export const modelFilterIdentity = record =>
  String(modelFilterLabel(record))
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, '-');
const normalizeSearch = value =>
  String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
/** Default omits reasoning (only offered for models without levels) and stays distinct from explicit none. */
export const thinkingLabel = value => (value === 'default' ? '默认' : value === 'unknown' ? '未记录' : String(value));

/** Unified search uses recorded identity fields, never inferred route segments. */
export function recordMatchesSearch(record, query) {
  const tokens = query.trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
  const text = normalizeSearch(
    [
      record.model,
      record.modelDisplayName,
      record.provider,
      record.providerName,
      record.providerDisplayId,
      providerIdentity(record),
      record.account,
      record.accountDisplayId,
      accountIdentity(record),
      thinkingLabel(record.think),
      record.think
    ].join(' ')
  );
  return tokens.every(token => text.includes(token));
}

const EFFORT_ORDER = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'unknown'];
const sortEfforts = efforts =>
  [...efforts].sort(
    (a, b) =>
      (EFFORT_ORDER.includes(a) ? EFFORT_ORDER.indexOf(a) : 99) - (EFFORT_ORDER.includes(b) ? EFFORT_ORDER.indexOf(b) : 99) ||
      String(a).localeCompare(String(b))
  );
const isAutoAccountRecord = record =>
  record.route?.account_evidence === 'gateway_binding' || String(accountIdentity(record)).startsWith('gateway-binding:');
const isRemoteChannelRecord = record => Boolean(record.providerSubtitle || record.route?.remote_route);
const COMPACT_ACCOUNT_LIMIT = 8;
const HIGH_SELECTION_THRESHOLD = 20;

function splitAccountDisplay(raw) {
  const text = String(raw ?? '').trim();
  const match = text.match(/^(.+?)\s+\(([0-9A-Za-z._-]{4,32})\)$/);
  if (match) return { primary: match[1], badgeId: match[2] };
  return { primary: text || '未记录账号', badgeId: '' };
}

function buildChannels(leaves) {
  const byId = new Map();
  for (const leaf of leaves) {
    const id = providerIdentity(leaf);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        rawLabel: leaf.providerName ?? leaf.providerDisplayId ?? leaf.provider ?? '未记录渠道',
        label: '',
        remote: isRemoteChannelRecord(leaf),
        leaves: [],
        leafByKey: new Map(),
        accountById: new Map(),
        autoAccount: null,
        fixedAccounts: [],
        modelById: new Map(),
        models: []
      });
    }
    const ch = byId.get(id);
    ch.leaves.push(leaf);
    ch.leafByKey.set(leaf.key, leaf);

    const accId = accountIdentity(leaf);
    if (!ch.accountById.has(accId)) {
      const isAuto = isAutoAccountRecord(leaf);
      const baseDisplay =
        !isAuto && leaf.accountDisplayId && leaf.accountDisplayId !== '实际账号未记录'
          ? leaf.accountDisplayId
          : (leaf.accountShortName ?? leaf.account ?? String(accId));
      const parts = isAuto ? { primary: '自动分配', badgeId: '' } : splitAccountDisplay(baseDisplay);
      const acc = {
        id: accId,
        isAuto,
        primary: parts.primary,
        badgeId: parts.badgeId,
        fullLabel: leaf.account ?? baseDisplay,
        searchText: normalizeSearch([parts.primary, parts.badgeId, leaf.account, leaf.accountDisplayId, accId].join(' '))
      };
      ch.accountById.set(accId, acc);
      if (isAuto && !ch.autoAccount) ch.autoAccount = acc;
      else ch.fixedAccounts.push(acc);
    }

    if (!ch.modelById.has(leaf.model)) {
      const modelEntry = {
        model: leaf.model,
        displayName: leaf.modelDisplayName ?? leaf.model,
        thinks: [],
        thinkSet: new Set(),
        leavesByAccountAndThink: new Map()
      };
      ch.modelById.set(leaf.model, modelEntry);
      ch.models.push(modelEntry);
    }
    const modelEntry = ch.modelById.get(leaf.model);
    modelEntry.thinkSet.add(leaf.think);
    if (!modelEntry.leavesByAccountAndThink.has(accId)) modelEntry.leavesByAccountAndThink.set(accId, new Map());
    modelEntry.leavesByAccountAndThink.get(accId).set(leaf.think, leaf);
  }

  const all = [...byId.values()];
  const labelCounts = new Map();
  for (const ch of all) labelCounts.set(ch.rawLabel, (labelCounts.get(ch.rawLabel) ?? 0) + 1);
  for (const ch of all) {
    ch.label = labelCounts.get(ch.rawLabel) > 1 ? `${ch.rawLabel} · ${ch.id}` : ch.rawLabel;
    // Disambiguate identical fixed account labels within one channel.
    const accLabelCounts = new Map();
    for (const acc of ch.fixedAccounts) {
      const sig = `${acc.primary}\0${acc.badgeId}`;
      accLabelCounts.set(sig, (accLabelCounts.get(sig) ?? 0) + 1);
    }
    for (const acc of ch.fixedAccounts) {
      const sig = `${acc.primary}\0${acc.badgeId}`;
      if ((accLabelCounts.get(sig) ?? 0) > 1) acc.badgeId = acc.badgeId ? `${acc.badgeId} · ${acc.id}` : String(acc.id);
    }
    for (const modelEntry of ch.models) modelEntry.thinks = sortEfforts(modelEntry.thinkSet);
  }
  // Present local channels first, then remote nodes, preserving catalog order within each group.
  return [...all.filter(ch => !ch.remote), ...all.filter(ch => ch.remote)];
}

let pickerSequence = 0;

/** Shared cross-channel search and orthogonal channel/account/thinking target selector. */
export function createDataPicker(container, { records, selectedKeys, mode = 'analysis', onChange = _keys => {} }) {
  const leaves = [...new Map(records.map(record => [selectionKey(record), { ...record }])).entries()].map(([key, record]) => ({
    ...record,
    key
  }));
  const knownKeys = new Set(leaves.map(leaf => leaf.key));
  const channels = buildChannels(leaves);
  const channelById = new Map(channels.map(ch => [ch.id, ch]));
  let selected = new Set((selectedKeys === undefined ? [...knownKeys] : selectedKeys).filter(key => knownKeys.has(key)));
  let open = false;
  let destroyed = false;
  let activeChannelId = channels[0]?.id ?? null;
  let visibleRowCount = 0;
  let searchVisibleLeaves = [];
  const title = mode === 'tasks' ? '选择目标' : '选择数据';

  // Per-channel state: activeAccounts, draftModelThinks, expanded (>8 defaults to collapsed), accSearch, accView, customMode.
  const channelStates = new Map();
  function defaultActiveAccounts(ch) {
    if (ch.autoAccount) return new Set([ch.autoAccount.id]);
    if (ch.fixedAccounts.length) return new Set([ch.fixedAccounts[0].id]);
    return new Set();
  }
  function getChannelState(ch) {
    if (!channelStates.has(ch.id)) {
      channelStates.set(ch.id, {
        activeAccounts: defaultActiveAccounts(ch),
        draftModelThinks: new Map(),
        expanded: false, // Channels with > 8 fixed accounts start collapsed by default.
        accSearch: '',
        accView: 'all',
        customMode: false
      });
    }
    return channelStates.get(ch.id);
  }
  function syncChannelFromSelected(ch, { preserveDraft = false } = {}) {
    const cs = getChannelState(ch);
    const chosen = ch.leaves.filter(leaf => selected.has(leaf.key));
    if (!chosen.length) {
      cs.customMode = false;
      if (!preserveDraft) {
        cs.draftModelThinks.clear();
        if (!cs.activeAccounts.size) cs.activeAccounts = defaultActiveAccounts(ch);
      }
      return;
    }
    const accSet = new Set(chosen.map(accountIdentity));
    const mtMap = new Map();
    for (const leaf of chosen) {
      if (!mtMap.has(leaf.model)) mtMap.set(leaf.model, new Set());
      mtMap.get(leaf.model).add(leaf.think);
    }
    const productKeys = new Set();
    for (const leaf of ch.leaves) {
      if (accSet.has(accountIdentity(leaf)) && mtMap.get(leaf.model)?.has(leaf.think)) productKeys.add(leaf.key);
    }
    if (productKeys.size === chosen.length && chosen.every(leaf => productKeys.has(leaf.key))) {
      cs.customMode = false;
      cs.activeAccounts = accSet;
      cs.draftModelThinks = mtMap;
    } else {
      cs.customMode = true;
      if (!cs.activeAccounts.size) cs.activeAccounts = new Set([accountIdentity(chosen[0])]);
    }
  }
  function syncAllChannelsFromSelected(options) {
    for (const ch of channels) syncChannelFromSelected(ch, options);
  }
  syncAllChannelsFromSelected();
  const firstSelectedChannel = channels.find(ch => ch.leaves.some(leaf => selected.has(leaf.key)));
  if (firstSelectedChannel) activeChannelId = firstSelectedChannel.id;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text, action) => {
    const node = element('button', className, text);
    node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
  };

  const trigger = button('dp-trigger', '', () => (open ? hide() : show()));
  const popup = element('section', 'dp-popup');
  popup.id = `dp-popup-${++pickerSequence}`;
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', title);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', popup.id);

  const header = element('div', 'dp-header');
  header.append(element('strong', 'dp-title', title), element('span', 'dp-hint', '同渠道按 账号 × 思考 组合，跨渠道搜索保留已选'));

  const toolbar = element('div', 'dp-toolbar');
  const searchWrap = element('div', 'dp-search-wrap');
  const search = element('input', 'dp-search');
  search.type = 'search';
  search.placeholder = '跨渠道搜索模型、渠道、账号或 Key';
  search.setAttribute('aria-label', search.placeholder);
  const clearSearch = button('dp-clear-search', '×', () => {
    search.value = '';
    render();
    search.focus();
  });
  clearSearch.setAttribute('aria-label', '清空搜索');
  searchWrap.append(search, clearSearch);

  const thinkingLabelNode = element('label', 'dp-filter', '思考');
  const thinking = element('select', 'dp-thinking-filter');
  thinking.setAttribute('aria-label', '筛选思考');
  const allThinkOption = element('option', '', '全部');
  allThinkOption.value = '';
  thinking.append(allThinkOption);
  for (const effort of sortEfforts(new Set(leaves.map(leaf => leaf.think)))) {
    const option = element('option', '', thinkingLabel(effort));
    option.value = effort;
    thinking.append(option);
  }
  thinking.addEventListener('change', () => render());
  thinkingLabelNode.append(thinking);

  const resetFilters = button('dp-reset-filters', '重置条件', clearFilters);
  toolbar.append(searchWrap, thinkingLabelNode, resetFilters);

  const body = element('div', 'dp-body');
  const footer = element('div', 'dp-footer');
  const summary = element('span', 'dp-summary');
  const clear = button('dp-action', '清空全部', () => {
    selected.clear();
    for (const ch of channels) {
      const cs = getChannelState(ch);
      cs.draftModelThinks.clear();
      cs.customMode = false;
      cs.activeAccounts = defaultActiveAccounts(ch);
    }
    render();
    onChange([]);
  });
  const done = button('dp-done', '完成', () => {
    hide();
    trigger.focus();
  });
  footer.append(summary, clear, done);
  popup.append(header, toolbar, body, footer);
  container.append(trigger);
  document.body.append(popup);

  search.addEventListener('input', () => render());

  function clearFilters() {
    search.value = '';
    thinking.value = '';
    render();
  }

  function draftCount(cs) {
    let total = 0;
    for (const set of cs.draftModelThinks.values()) total += set.size;
    return total;
  }

  function applyOrthogonal(ch) {
    const cs = getChannelState(ch);
    for (const leaf of ch.leaves) selected.delete(leaf.key);
    for (const accId of cs.activeAccounts) {
      for (const [model, thinkSet] of cs.draftModelThinks) {
        const modelEntry = ch.modelById.get(model);
        const byThink = modelEntry?.leavesByAccountAndThink.get(accId);
        if (!byThink) continue;
        for (const think of thinkSet) {
          const leaf = byThink.get(think);
          if (leaf) selected.add(leaf.key);
        }
      }
    }
    render();
    onChange([...selected]);
  }

  function toggleAccount(ch, accId) {
    const cs = getChannelState(ch);
    const isAuto = ch.autoAccount && accId === ch.autoAccount.id;
    if (cs.customMode) {
      if (isAuto) {
        cs.activeAccounts = new Set([accId]);
      } else {
        if (ch.autoAccount) cs.activeAccounts.delete(ch.autoAccount.id);
        if (cs.activeAccounts.has(accId)) cs.activeAccounts.delete(accId);
        else cs.activeAccounts.add(accId);
        if (!cs.activeAccounts.size) cs.activeAccounts = defaultActiveAccounts(ch);
      }
      render();
      return;
    }
    if (isAuto) {
      cs.activeAccounts = new Set([accId]);
      applyOrthogonal(ch);
      return;
    }
    if (ch.autoAccount) cs.activeAccounts.delete(ch.autoAccount.id);
    if (cs.activeAccounts.has(accId)) {
      cs.activeAccounts.delete(accId);
      if (!cs.activeAccounts.size && ch.autoAccount && draftCount(cs) === 0) cs.activeAccounts.add(ch.autoAccount.id);
    } else {
      cs.activeAccounts.add(accId);
    }
    applyOrthogonal(ch);
  }

  function switchToAuto(ch) {
    const cs = getChannelState(ch);
    if (!ch.autoAccount) return;
    cs.activeAccounts = new Set([ch.autoAccount.id]);
    if (cs.customMode) render();
    else applyOrthogonal(ch);
  }

  function batchAccounts(ch, targetIds, selectAll) {
    const cs = getChannelState(ch);
    if (selectAll) {
      if (ch.autoAccount) cs.activeAccounts.delete(ch.autoAccount.id);
      for (const id of targetIds) cs.activeAccounts.add(id);
    } else {
      for (const id of targetIds) cs.activeAccounts.delete(id);
      if (!cs.activeAccounts.size && ch.autoAccount && draftCount(cs) === 0) cs.activeAccounts.add(ch.autoAccount.id);
    }
    if (cs.customMode) render();
    else applyOrthogonal(ch);
  }

  function toggleThinkInChannel(ch, modelEntry, think) {
    const cs = getChannelState(ch);
    if (cs.customMode) {
      const targets = [...cs.activeAccounts].map(accId => modelEntry.leavesByAccountAndThink.get(accId)?.get(think)).filter(Boolean);
      if (!targets.length) return;
      const allOn = targets.every(leaf => selected.has(leaf.key));
      for (const leaf of targets) allOn ? selected.delete(leaf.key) : selected.add(leaf.key);
      syncChannelFromSelected(ch);
      render();
      onChange([...selected]);
      return;
    }
    if (!cs.draftModelThinks.has(modelEntry.model)) cs.draftModelThinks.set(modelEntry.model, new Set());
    const set = cs.draftModelThinks.get(modelEntry.model);
    if (set.has(think)) {
      set.delete(think);
      if (!set.size) cs.draftModelThinks.delete(modelEntry.model);
    } else {
      set.add(think);
    }
    applyOrthogonal(ch);
  }

  function toggleModelRowInChannel(ch, modelEntry, visibleThinks) {
    const cs = getChannelState(ch);
    if (cs.customMode) {
      const targets = [];
      for (const accId of cs.activeAccounts) {
        const byThink = modelEntry.leavesByAccountAndThink.get(accId);
        if (!byThink) continue;
        for (const think of visibleThinks) {
          const leaf = byThink.get(think);
          if (leaf) targets.push(leaf);
        }
      }
      if (!targets.length) return;
      const allOn = targets.every(leaf => selected.has(leaf.key));
      for (const leaf of targets) allOn ? selected.delete(leaf.key) : selected.add(leaf.key);
      syncChannelFromSelected(ch);
      render();
      onChange([...selected]);
      return;
    }
    const supportedThinks = visibleThinks.filter(
      think => !cs.activeAccounts.size || [...cs.activeAccounts].some(accId => modelEntry.leavesByAccountAndThink.get(accId)?.has(think))
    );
    if (!supportedThinks.length) return;
    const set = cs.draftModelThinks.get(modelEntry.model) ?? new Set();
    const allOn = supportedThinks.every(think => set.has(think));
    if (allOn) {
      for (const think of supportedThinks) set.delete(think);
      if (set.size) cs.draftModelThinks.set(modelEntry.model, set);
      else cs.draftModelThinks.delete(modelEntry.model);
    } else {
      const next = new Set(set);
      for (const think of supportedThinks) next.add(think);
      cs.draftModelThinks.set(modelEntry.model, next);
    }
    applyOrthogonal(ch);
  }

  function selectAllVisibleInChannel(ch, visibleModels) {
    const cs = getChannelState(ch);
    if (!cs.activeAccounts.size && ch.autoAccount) cs.activeAccounts.add(ch.autoAccount.id);
    if (!cs.activeAccounts.size && ch.fixedAccounts.length) cs.activeAccounts.add(ch.fixedAccounts[0].id);
    if (cs.customMode) {
      for (const { modelEntry, thinks } of visibleModels) {
        for (const accId of cs.activeAccounts) {
          const byThink = modelEntry.leavesByAccountAndThink.get(accId);
          if (!byThink) continue;
          for (const think of thinks) {
            const leaf = byThink.get(think);
            if (leaf) selected.add(leaf.key);
          }
        }
      }
      syncChannelFromSelected(ch);
      render();
      onChange([...selected]);
      return;
    }
    for (const { modelEntry, thinks } of visibleModels) {
      const supported = thinks.filter(think =>
        [...cs.activeAccounts].some(accId => modelEntry.leavesByAccountAndThink.get(accId)?.has(think))
      );
      if (!supported.length) continue;
      if (!cs.draftModelThinks.has(modelEntry.model)) cs.draftModelThinks.set(modelEntry.model, new Set());
      const set = cs.draftModelThinks.get(modelEntry.model);
      for (const think of supported) set.add(think);
    }
    applyOrthogonal(ch);
  }

  function changeDirectLeaves(scope, checked) {
    for (const leaf of scope) checked ? selected.add(leaf.key) : selected.delete(leaf.key);
    syncAllChannelsFromSelected({ preserveDraft: false });
    render();
    onChange([...selected]);
  }

  function channelSelectedCount(ch) {
    let count = 0;
    for (const leaf of ch.leaves) if (selected.has(leaf.key)) count++;
    return count;
  }

  function channelVisibleModels(ch) {
    const thinkFilter = thinking.value;
    return ch.models
      .map(modelEntry => ({
        modelEntry,
        thinks: thinkFilter ? modelEntry.thinks.filter(t => t === thinkFilter) : modelEntry.thinks
      }))
      .filter(item => item.thinks.length > 0);
  }

  function renderAccountSection(ch, cs) {
    const section = element('div', 'dp-acc-section');
    const fixedCount = ch.fixedAccounts.length;
    const isAutoOnly = cs.activeAccounts.size === 1 && ch.autoAccount && cs.activeAccounts.has(ch.autoAccount.id);
    const selectedFixed = ch.fixedAccounts.filter(acc => cs.activeAccounts.has(acc.id));

    // Tier 0: no fixed accounts (remote node or single-account gateway-default channel).
    if (fixedCount === 0) {
      const staticRow = element('div', 'dp-acc-static');
      const label = element('span', 'dp-acc-title', '运行账号');
      const value = element(
        'span',
        'dp-acc-static-value',
        ch.autoAccount ? (ch.autoAccount.isAuto ? '网关自动分配（实际账号未记录）' : ch.autoAccount.fullLabel) : '未记录账号'
      );
      staticRow.append(label, value);
      section.append(staticRow);
      return section;
    }

    // Header row shared by Tier 1 and Tier 2.
    const head = element('div', 'dp-acc-head');
    const headLeft = element('div', 'dp-acc-head-left');
    headLeft.append(element('span', 'dp-acc-title', '运行账号'));
    const statusText = isAutoOnly
      ? '自动分配'
      : selectedFixed.length
        ? `已选 ${selectedFixed.length} / ${fixedCount} 个固定账号`
        : '未选择账号';
    const statusNode = element('span', `dp-acc-status${selectedFixed.length ? ' is-active' : ''}`, statusText);
    headLeft.append(statusNode);

    const headRight = element('div', 'dp-acc-head-right');

    // Tier 1: 1–8 fixed accounts -> compact wrapping pills.
    if (fixedCount <= COMPACT_ACCOUNT_LIMIT) {
      const allFixedSelected = selectedFixed.length === fixedCount;
      const batchBtn = button(
        'dp-acc-link',
        allFixedSelected ? (ch.autoAccount ? '切回自动' : '清空固定') : `全选固定 (${fixedCount})`,
        () => {
          if (allFixedSelected) {
            if (ch.autoAccount) switchToAuto(ch);
            else
              batchAccounts(
                ch,
                ch.fixedAccounts.map(a => a.id),
                false
              );
          } else {
            batchAccounts(
              ch,
              ch.fixedAccounts.map(a => a.id),
              true
            );
          }
        }
      );
      batchBtn.dataset.focusId = `acc-batch:${ch.id}`;
      headRight.append(batchBtn);
      head.append(headLeft, headRight);
      section.append(head);

      const pills = element('div', 'dp-acc-pills');
      if (ch.autoAccount) {
        const autoBtn = button('dp-acc-pill dp-acc-auto', '自动分配', () => toggleAccount(ch, ch.autoAccount.id));
        autoBtn.setAttribute('aria-pressed', String(cs.activeAccounts.has(ch.autoAccount.id)));
        autoBtn.dataset.accountId = ch.autoAccount.id;
        autoBtn.dataset.focusId = `acc:${ch.id}:${ch.autoAccount.id}`;
        autoBtn.title = ch.autoAccount.fullLabel;
        pills.append(autoBtn);
      }
      for (const acc of ch.fixedAccounts) {
        const pill = button('dp-acc-pill', '', () => toggleAccount(ch, acc.id));
        pill.setAttribute('aria-pressed', String(cs.activeAccounts.has(acc.id)));
        pill.dataset.accountId = acc.id;
        pill.dataset.focusId = `acc:${ch.id}:${acc.id}`;
        pill.title = acc.fullLabel;
        pill.append(element('span', 'dp-acc-pill-name', acc.primary));
        if (acc.badgeId) pill.append(element('span', 'dp-acc-id', acc.badgeId));
        pills.append(pill);
      }
      section.append(pills);
      return section;
    }

    // Tier 2: > 8 fixed accounts -> default-collapsed compact bar / expandable 2-col searchable grid.
    if (ch.autoAccount) {
      const autoBtn = button('dp-acc-pill dp-acc-auto', '自动分配', () => toggleAccount(ch, ch.autoAccount.id));
      autoBtn.setAttribute('aria-pressed', String(cs.activeAccounts.has(ch.autoAccount.id)));
      autoBtn.dataset.accountId = ch.autoAccount.id;
      autoBtn.dataset.focusId = `acc:${ch.id}:${ch.autoAccount.id}`;
      autoBtn.title = ch.autoAccount.fullLabel;
      headRight.append(autoBtn);
    }
    const toggleBtn = button('dp-acc-toggle', cs.expanded ? '收起 ▲' : `展开 ${fixedCount} 个账号 ▾`, () => {
      cs.expanded = !cs.expanded;
      render();
    });
    toggleBtn.setAttribute('aria-expanded', String(cs.expanded));
    toggleBtn.dataset.focusId = `acc-toggle:${ch.id}`;
    headRight.append(toggleBtn);
    head.append(headLeft, headRight);
    section.append(head);

    if (!cs.expanded) {
      if (selectedFixed.length) {
        const collapsedBar = element('div', 'dp-acc-collapsed-chips');
        const preview = selectedFixed.slice(0, 4);
        for (const acc of preview) {
          const chip = button('dp-acc-chip', `${acc.primary} ×`, () => toggleAccount(ch, acc.id));
          chip.setAttribute('aria-label', `移除账号 ${acc.primary}`);
          chip.dataset.accountId = acc.id;
          chip.dataset.focusId = `acc-chip:${ch.id}:${acc.id}`;
          collapsedBar.append(chip);
        }
        if (selectedFixed.length > preview.length) {
          collapsedBar.append(element('span', 'dp-acc-more', `+${selectedFixed.length - preview.length}`));
        }
        section.append(collapsedBar);
      }
      return section;
    }

    // Expanded Tier 2: pinned selected bar + search/segmented toolbar + bounded 2-col grid.
    if (selectedFixed.length) {
      const selectedBar = element('div', 'dp-acc-selected-bar');
      selectedBar.append(element('span', 'dp-acc-selected-label', '已选'));
      const chipList = element('div', 'dp-acc-chip-list');
      for (const acc of selectedFixed) {
        const chip = button('dp-acc-chip', `${acc.primary} ×`, () => toggleAccount(ch, acc.id));
        chip.setAttribute('aria-label', `移除账号 ${acc.primary}`);
        chip.dataset.accountId = acc.id;
        chip.dataset.focusId = `acc-chip:${ch.id}:${acc.id}`;
        chipList.append(chip);
      }
      selectedBar.append(chipList);
      const resetAcc = button('dp-acc-link', ch.autoAccount ? '切回自动' : '清空固定', () => {
        if (ch.autoAccount) switchToAuto(ch);
        else
          batchAccounts(
            ch,
            ch.fixedAccounts.map(a => a.id),
            false
          );
      });
      resetAcc.dataset.focusId = `acc-reset:${ch.id}`;
      selectedBar.append(resetAcc);
      section.append(selectedBar);
    }

    const accToolbar = element('div', 'dp-acc-toolbar');
    const accSearch = element('input', 'dp-acc-search');
    accSearch.type = 'text';
    accSearch.value = cs.accSearch;
    accSearch.placeholder = '筛选账号名或 Key ID…';
    accSearch.setAttribute('aria-label', `筛选 ${ch.label} 账号`);
    accSearch.dataset.focusId = `acc-search:${ch.id}`;
    accSearch.addEventListener('input', () => {
      cs.accSearch = accSearch.value;
      render();
    });

    const seg = element('div', 'dp-acc-seg');
    const allViewBtn = button('dp-acc-seg-btn', `全部 ${fixedCount}`, () => {
      cs.accView = 'all';
      render();
    });
    allViewBtn.dataset.accView = 'all';
    allViewBtn.setAttribute('aria-pressed', String(cs.accView === 'all'));
    allViewBtn.dataset.focusId = `acc-view-all:${ch.id}`;
    const selViewBtn = button('dp-acc-seg-btn', `已选 ${selectedFixed.length}`, () => {
      cs.accView = 'selected';
      render();
    });
    selViewBtn.dataset.accView = 'selected';
    selViewBtn.setAttribute('aria-pressed', String(cs.accView === 'selected'));
    selViewBtn.dataset.focusId = `acc-view-sel:${ch.id}`;
    seg.append(allViewBtn, selViewBtn);

    const queryTokens = cs.accSearch.trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
    const filteredAccounts = ch.fixedAccounts.filter(acc => {
      if (cs.accView === 'selected' && !cs.activeAccounts.has(acc.id)) return false;
      if (!queryTokens.length) return true;
      return queryTokens.every(token => acc.searchText.includes(token));
    });
    const isFiltered = queryTokens.length > 0 || cs.accView === 'selected';
    const allFilteredSelected = filteredAccounts.length > 0 && filteredAccounts.every(acc => cs.activeAccounts.has(acc.id));
    const batchLabel = isFiltered
      ? allFilteredSelected
        ? `取消匹配 (${filteredAccounts.length})`
        : `全选匹配 (${filteredAccounts.length})`
      : allFilteredSelected
        ? '清空固定'
        : `全选固定 (${fixedCount})`;
    const batchBtn = button('dp-acc-link dp-acc-batch', batchLabel, () => {
      batchAccounts(
        ch,
        filteredAccounts.map(a => a.id),
        !allFilteredSelected
      );
    });
    batchBtn.disabled = filteredAccounts.length === 0;
    batchBtn.dataset.focusId = `acc-batch:${ch.id}`;

    accToolbar.append(accSearch, seg, batchBtn);
    section.append(accToolbar);

    const grid = element('div', 'dp-acc-grid');
    if (!filteredAccounts.length) {
      grid.append(element('p', 'dp-acc-empty', cs.accView === 'selected' ? '当前未勾选固定账号' : '没有匹配的账号或 Key'));
    } else {
      for (const acc of filteredAccounts) {
        const checked = cs.activeAccounts.has(acc.id);
        const cell = element('label', `dp-acc-cell${checked ? ' is-checked' : ''}`);
        cell.title = acc.fullLabel;
        const checkbox = element('input', 'dp-acc-check');
        checkbox.type = 'checkbox';
        checkbox.checked = checked;
        checkbox.dataset.accountId = acc.id;
        checkbox.dataset.focusId = `acc:${ch.id}:${acc.id}`;
        checkbox.addEventListener('change', () => toggleAccount(ch, acc.id));
        cell.append(checkbox, element('span', 'dp-acc-cell-name', acc.primary));
        if (acc.badgeId) cell.append(element('span', 'dp-acc-id', acc.badgeId));
        grid.append(cell);
      }
    }
    section.append(grid);
    return section;
  }

  function renderSplitView() {
    const split = element('div', 'dp-split');
    const rail = element('div', 'dp-rail');
    rail.setAttribute('role', 'navigation');
    rail.setAttribute('aria-label', '渠道列表');

    const visibleChannels = channels.filter(ch => channelVisibleModels(ch).length > 0);
    if (!visibleChannels.length) {
      visibleRowCount = 0;
      const empty = element('p', 'dp-empty', '没有匹配结果，试试缩短关键词或重置条件。');
      body.append(empty);
      return;
    }
    if (!visibleChannels.some(ch => ch.id === activeChannelId)) activeChannelId = visibleChannels[0].id;
    const activeCh = channelById.get(activeChannelId) ?? visibleChannels[0];
    const hasBothGroups = visibleChannels.some(ch => !ch.remote) && visibleChannels.some(ch => ch.remote);

    const appendRailGroup = (groupTitle, items) => {
      if (!items.length) return;
      if (hasBothGroups) rail.append(element('div', 'dp-rail-group', groupTitle));
      for (const ch of items) {
        const count = channelSelectedCount(ch);
        const isCurrent = ch.id === activeCh.id;
        const item = button(`dp-rail-item${isCurrent ? ' is-active' : ''}`, '', () => {
          activeChannelId = ch.id;
          render();
        });
        item.dataset.providerId = ch.id;
        item.dataset.focusId = `rail:${ch.id}`;
        item.setAttribute('aria-current', String(isCurrent));
        const info = element('span', 'dp-rail-info');
        info.append(element('span', 'dp-rail-name', ch.label));
        const subText =
          ch.fixedAccounts.length > 0
            ? `${ch.fixedAccounts.length} 个固定账号`
            : ch.autoAccount
              ? '网关自动分配'
              : `${ch.models.length} 个模型`;
        info.append(element('span', 'dp-rail-sub', subText));
        item.append(info);
        if (count > 0) item.append(element('span', 'dp-rail-badge', String(count)));
        rail.append(item);
      }
    };
    appendRailGroup(
      '本机渠道',
      visibleChannels.filter(ch => !ch.remote)
    );
    appendRailGroup(
      '远端节点',
      visibleChannels.filter(ch => ch.remote)
    );

    const main = element('div', 'dp-main');
    const cs = getChannelState(activeCh);
    main.append(renderAccountSection(activeCh, cs));

    // Notice when orthogonal drafts exist while no account is active.
    const stagedCount = draftCount(cs);
    if (!cs.customMode && cs.activeAccounts.size === 0 && stagedCount > 0) {
      const draftNote = element('div', 'dp-draft-note');
      draftNote.append(element('span', '', `已暂存 ${stagedCount} 项模型配置，勾选任意账号后立即生效`));
      if (activeCh.autoAccount) {
        draftNote.append(button('dp-acc-link', '切回自动分配', () => switchToAuto(activeCh)));
      }
      main.append(draftNote);
    }

    // Custom selection banner when channel contains non-matrix combinations (e.g. from setSelection or search).
    if (cs.customMode) {
      const customLeaves = activeCh.leaves.filter(leaf => selected.has(leaf.key));
      const customBar = element('div', 'dp-custom-bar');
      const customHead = element('div', 'dp-custom-head');
      customHead.append(element('span', '', `自定义组合（已选 ${customLeaves.length} 项）`));
      const clearCh = button('dp-acc-link', '清空本渠道', () => {
        for (const leaf of activeCh.leaves) selected.delete(leaf.key);
        syncChannelFromSelected(activeCh);
        render();
        onChange([...selected]);
      });
      clearCh.dataset.focusId = `custom-clear:${activeCh.id}`;
      customHead.append(clearCh);
      const customList = element('div', 'dp-custom-chips');
      for (const leaf of customLeaves.slice(0, 8)) {
        const acc = activeCh.accountById.get(accountIdentity(leaf));
        const chipLabel = `${acc?.primary ?? leaf.account} · ${leaf.modelDisplayName ?? leaf.model} · ${thinkingLabel(leaf.think)} ×`;
        const chip = button('dp-acc-chip', chipLabel, () => {
          selected.delete(leaf.key);
          syncChannelFromSelected(activeCh);
          render();
          onChange([...selected]);
        });
        chip.dataset.focusId = `custom-leaf:${leaf.key}`;
        customList.append(chip);
      }
      if (customLeaves.length > 8) customList.append(element('span', 'dp-acc-more', `+${customLeaves.length - 8}`));
      customBar.append(customHead, customList);
      main.append(customBar);
    }

    const visibleModels = channelVisibleModels(activeCh);
    visibleRowCount = visibleModels.length;

    const modelsHead = element('div', 'dp-models-head');
    const activeAccCount = cs.activeAccounts.size;
    const isAutoOnly = activeAccCount === 1 && activeCh.autoAccount && cs.activeAccounts.has(activeCh.autoAccount.id);
    const accDesc =
      activeAccCount === 0
        ? '未选账号'
        : isAutoOnly
          ? '自动分配'
          : activeAccCount === 1
            ? (activeCh.accountById.get([...cs.activeAccounts][0])?.primary ?? '1 个账号')
            : `${activeAccCount} 个账号`;
    modelsHead.append(element('span', 'dp-models-title', `${activeCh.label} · 模型与思考`));
    const modelsHeadRight = element('div', 'dp-models-head-right');
    modelsHeadRight.append(element('span', 'dp-models-hint', `按 思考 × ${accDesc} 展开`));
    const selectChBtn = button('dp-select-visible dp-select-channel', '全选本渠道', () =>
      selectAllVisibleInChannel(activeCh, visibleModels)
    );
    selectChBtn.dataset.focusId = `select-ch:${activeCh.id}`;
    modelsHeadRight.append(selectChBtn);
    modelsHead.append(modelsHeadRight);
    main.append(modelsHead);

    const modelsList = element('div', 'dp-results dp-models-list');
    for (const { modelEntry, thinks } of visibleModels) {
      const supportedAccounts = [...cs.activeAccounts].filter(accId =>
        thinks.some(think => modelEntry.leavesByAccountAndThink.get(accId)?.has(think))
      );
      const row = element('div', 'dp-result-row dp-model-row');
      row.dataset.providerId = activeCh.id;
      row.dataset.model = modelEntry.model;

      const check = element('input', 'dp-check');
      check.type = 'checkbox';
      check.setAttribute('aria-label', `选择 ${modelEntry.displayName}`);
      check.dataset.focusId = `model-check:${activeCh.id}:${modelEntry.model}`;

      let activeThinkCount = 0;
      const thinkWrap = element('div', 'dp-thinking-list');
      for (const think of thinks) {
        const matchingLeaves = [...cs.activeAccounts]
          .map(accId => modelEntry.leavesByAccountAndThink.get(accId)?.get(think))
          .filter(Boolean);
        const supported = cs.activeAccounts.size === 0 || matchingLeaves.length > 0;
        const drafted = !cs.customMode && Boolean(cs.draftModelThinks.get(modelEntry.model)?.has(think));
        const pressed = cs.customMode
          ? matchingLeaves.length > 0 && matchingLeaves.every(leaf => selected.has(leaf.key))
          : drafted && matchingLeaves.length > 0;
        if (pressed) activeThinkCount++;
        const opt = button('dp-think', thinkingLabel(think), () => toggleThinkInChannel(activeCh, modelEntry, think));
        opt.dataset.think = think;
        opt.dataset.model = modelEntry.model;
        opt.dataset.focusId = `think:${activeCh.id}:${modelEntry.model}:${think}`;
        opt.setAttribute('aria-pressed', String(pressed));
        if (!pressed && drafted && cs.activeAccounts.size === 0) opt.dataset.draft = 'true';
        if (!supported) {
          opt.disabled = true;
          opt.title = '当前已选账号不支持此模型';
        }
        thinkWrap.append(opt);
      }

      const selectableThinks = thinks.filter(
        think =>
          cs.activeAccounts.size === 0 || [...cs.activeAccounts].some(accId => modelEntry.leavesByAccountAndThink.get(accId)?.has(think))
      );
      const draftedThinksInRow = !cs.customMode
        ? selectableThinks.filter(t => cs.draftModelThinks.get(modelEntry.model)?.has(t)).length
        : activeThinkCount;
      check.checked = selectableThinks.length > 0 && draftedThinksInRow === selectableThinks.length;
      check.indeterminate = draftedThinksInRow > 0 && draftedThinksInRow < selectableThinks.length;
      check.disabled = selectableThinks.length === 0;
      check.addEventListener('change', () => toggleModelRowInChannel(activeCh, modelEntry, thinks));

      const modelCol = element('div', 'dp-model-col');
      modelCol.append(element('span', 'dp-model-name', modelEntry.displayName));
      if (cs.activeAccounts.size > 1 && supportedAccounts.length < cs.activeAccounts.size) {
        modelCol.append(
          element(
            'span',
            'dp-model-warn',
            supportedAccounts.length === 0
              ? '当前已选账号均不支持'
              : `仅 ${supportedAccounts.length}/${cs.activeAccounts.size} 个已选账号支持`
          )
        );
      }
      if (activeCh.fixedAccounts.length === 0 && activeCh.autoAccount) {
        // Expose route/account context cleanly on single-account channels without clutter.
        row.dataset.account = activeCh.autoAccount.fullLabel;
      }

      row.append(check, modelCol, thinkWrap);
      modelsList.append(row);
    }

    main.append(modelsList);
    split.append(rail, main);
    body.append(split);
  }

  function renderSearchView() {
    const query = search.value;
    const thinkFilter = thinking.value;
    searchVisibleLeaves = leaves.filter(leaf => {
      if (thinkFilter && leaf.think !== thinkFilter) return false;
      return recordMatchesSearch(leaf, query);
    });

    const groups = new Map();
    for (const leaf of searchVisibleLeaves) {
      const id = JSON.stringify([providerIdentity(leaf), accountIdentity(leaf), leaf.model]);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(leaf);
    }
    const rows = [...groups.values()];
    visibleRowCount = rows.length;

    const resultBar = element('div', 'dp-result-bar');
    const resultCount = element(
      'span',
      'dp-result-count',
      `${rows.length} 条${mode === 'tasks' ? '路由' : '模型记录'} · ${new Set(searchVisibleLeaves.map(providerIdentity)).size} 个渠道`
    );
    resultCount.setAttribute('role', 'status');
    resultCount.setAttribute('aria-live', 'polite');
    const selectVisible = button('dp-select-visible', '全选搜索结果', () => changeDirectLeaves(searchVisibleLeaves, true));
    selectVisible.disabled = !searchVisibleLeaves.length || searchVisibleLeaves.every(leaf => selected.has(leaf.key));
    selectVisible.dataset.focusId = 'select-visible';
    resultBar.append(resultCount, selectVisible);

    const columnHead = element('div', 'dp-column-head');
    columnHead.setAttribute('aria-hidden', 'true');
    for (const colText of ['渠道 / 账号', '模型', '思考']) columnHead.append(element('span', '', colText));

    const list = element('div', 'dp-results dp-search-results');
    for (const group of rows) {
      const first = group[0];
      const ch = channelById.get(providerIdentity(first));
      const acc = ch?.accountById.get(accountIdentity(first));
      const row = element('div', 'dp-result-row dp-search-row');

      const check = element('input', 'dp-check');
      check.type = 'checkbox';
      const checkedCount = group.filter(leaf => selected.has(leaf.key)).length;
      check.checked = checkedCount === group.length;
      check.indeterminate = checkedCount > 0 && checkedCount < group.length;
      check.setAttribute('aria-label', `选择 ${first.modelDisplayName ?? first.model}`);
      check.dataset.focusId = `search-row:${first.key}`;
      check.addEventListener('change', () => changeDirectLeaves(group, check.checked));

      const route = element('span', 'dp-route');
      route.append(
        element('span', 'dp-provider-name', ch?.label ?? first.providerName ?? first.providerDisplayId ?? first.provider),
        element(
          'span',
          'dp-account-name',
          acc ? (acc.isAuto ? acc.fullLabel : acc.badgeId ? `${acc.primary} (${acc.badgeId})` : acc.primary) : first.account
        )
      );

      const modelNode = element('span', 'dp-model-name', first.modelDisplayName ?? first.model);
      const thinkWrap = element('div', 'dp-thinking-list');
      for (const leaf of group) {
        const opt = button('dp-think', thinkingLabel(leaf.think), () => changeDirectLeaves([leaf], !selected.has(leaf.key)));
        opt.dataset.think = leaf.think;
        opt.dataset.model = leaf.model;
        opt.dataset.focusId = `search-leaf:${leaf.key}`;
        opt.setAttribute('aria-pressed', String(selected.has(leaf.key)));
        thinkWrap.append(opt);
      }
      row.append(check, route, modelNode, thinkWrap);
      list.append(row);
    }
    if (!rows.length) list.append(element('p', 'dp-empty', '没有匹配结果，试试缩短关键词或重置条件。'));

    body.append(resultBar, columnHead, list);
  }

  function render() {
    const activeEl = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusId = activeEl?.dataset?.focusId;
    const isTextInputFocused = activeEl?.className === 'dp-acc-search';
    const selStart = isTextInputFocused ? /** @type {HTMLInputElement} */ (activeEl).selectionStart : null;
    const selEnd = isTextInputFocused ? /** @type {HTMLInputElement} */ (activeEl).selectionEnd : null;

    const prevRailScroll = body.querySelector?.('.dp-rail')?.scrollTop ?? 0;
    const prevAccGridScroll = body.querySelector?.('.dp-acc-grid')?.scrollTop ?? 0;
    const prevResultsScroll = body.querySelector?.('.dp-results')?.scrollTop ?? 0;

    const isSearching = Boolean(search.value.trim());
    searchVisibleLeaves = [];
    body.replaceChildren();
    if (isSearching) renderSearchView();
    else renderSplitView();

    // Restore scroll offsets cleanly.
    const nextRail = body.querySelector?.('.dp-rail');
    if (nextRail) nextRail.scrollTop = prevRailScroll;
    const nextAccGrid = body.querySelector?.('.dp-acc-grid');
    if (nextAccGrid) nextAccGrid.scrollTop = prevAccGridScroll;
    const nextResults = body.querySelector?.('.dp-results');
    if (nextResults) nextResults.scrollTop = prevResultsScroll;

    // Footer summary & hidden count.
    summary.replaceChildren();
    summary.className = `dp-summary${selected.size > HIGH_SELECTION_THRESHOLD ? ' is-high-count' : ''}`;
    if (mode === 'tasks') {
      const lead = element('span', 'dp-summary-lead', `已选 ${selected.size} 个独立运行`);
      summary.append(lead);
    } else {
      summary.append(element('span', 'dp-summary-lead', `已选 ${selected.size} / ${leaves.length}`));
    }

    if (isSearching) {
      const visibleKeys = new Set(searchVisibleLeaves.map(leaf => leaf.key));
      const hiddenCount = [...selected].filter(key => !visibleKeys.has(key)).length;
      if (hiddenCount) summary.append(element('small', 'dp-hidden-count', `${hiddenCount} 项在当前筛选之外`));
    } else if (thinking.value) {
      const visibleKeys = new Set(leaves.filter(leaf => leaf.think === thinking.value).map(leaf => leaf.key));
      const hiddenCount = [...selected].filter(key => !visibleKeys.has(key)).length;
      if (hiddenCount) summary.append(element('small', 'dp-hidden-count', `${hiddenCount} 项在当前筛选之外`));
    } else if (selected.size > 0) {
      const breakdown = channels.map(ch => ({ label: ch.label, count: channelSelectedCount(ch) })).filter(item => item.count > 0);
      if (breakdown.length) {
        const shown = breakdown.slice(0, 3).map(item => `${item.label} ${item.count}`);
        if (breakdown.length > 3) shown.push(`+${breakdown.length - 3} 个渠道`);
        summary.append(element('small', 'dp-breakdown', `（${shown.join(' · ')}）`));
      }
    }

    trigger.textContent = `${title} ${selected.size}/${leaves.length} ▾`;
    trigger.setAttribute('aria-expanded', String(open));
    clear.disabled = selected.size === 0;
    clearSearch.disabled = !search.value;
    resetFilters.disabled = !search.value && !thinking.value;

    if (focusId) {
      const target = [...popup.querySelectorAll('[data-focus-id]')].find(node => node.dataset.focusId === focusId);
      if (target) {
        target.focus({ preventScroll: true });
        if (isTextInputFocused && typeof target.setSelectionRange === 'function' && selStart !== null) {
          target.setSelectionRange(selStart, selEnd ?? selStart);
        }
      }
    }
    if (open) position();
  }

  function position() {
    if (!open) return;
    const rect = trigger.getBoundingClientRect();
    const inset = 16,
      gap = 8;
    const width = Math.min(860, window.innerWidth - inset * 2);
    popup.style.width = `${Math.max(0, width)}px`;
    const fixedHeight =
      2 + [...popup.children].filter(child => child !== body).reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
    const resultsEl = body.querySelector?.('.dp-results');
    const rowsHeight = resultsEl ? [...resultsEl.children].reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) : 0;
    const railEl = body.querySelector?.('.dp-rail');
    const railStackedHeight = railEl && window.innerWidth <= 680 ? railEl.getBoundingClientRect().height : 0;
    const railSideHeight =
      railEl && window.innerWidth > 680
        ? Math.min(
            440,
            [...railEl.children].reduce((sum, item) => sum + item.getBoundingClientRect().height + 2, 16)
          )
        : 0;
    const mainEl = body.querySelector?.('.dp-main');
    const bodyChromeHeight = mainEl
      ? [...mainEl.children].filter(child => child !== resultsEl).reduce((sum, child) => sum + child.getBoundingClientRect().height, 0)
      : [...body.children].filter(child => child !== resultsEl).reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
    const lowerEdge = Math.max(inset, Math.min(rect.bottom + gap, window.innerHeight - inset));
    const upperEdge = Math.max(inset, Math.min(rect.top - gap, window.innerHeight - inset));
    const below = Math.max(0, window.innerHeight - inset - lowerEdge);
    const above = Math.max(0, upperEdge - inset);
    const useAbove = below < 320 && above > below;
    const available = useAbove ? above : below;
    const isSearching = Boolean(search.value.trim());
    const estimatedBody = isSearching
      ? 244 + Math.max(1, visibleRowCount) * (window.innerWidth <= 772 ? 112 : 76)
      : Math.max(360, 220 + railStackedHeight + bodyChromeHeight + Math.max(1, visibleRowCount) * (window.innerWidth <= 680 ? 96 : 62));
    const measuredHeight = fixedHeight + Math.max(railSideHeight, railStackedHeight + bodyChromeHeight + rowsHeight) + 4;
    const contentHeight = Math.min(640, Math.max(measuredHeight, estimatedBody));
    const compact =
      available < 300 ||
      (visibleRowCount > 2 && available < Math.min(440, contentHeight)) ||
      (visibleRowCount <= 2 && measuredHeight > available);
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
    body.querySelector?.('.dp-rail-item.is-active')?.scrollIntoView?.({ block: 'nearest' });
    search.focus();
  }
  function hide() {
    open = false;
    popup.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function outsideClick(event) {
    if (open && !popup.contains(event.target) && !trigger.contains(event.target)) hide();
  }
  function escape(event) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      hide();
      trigger.focus();
    }
  }
  document.addEventListener('pointerdown', outsideClick);
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  render();

  return {
    getSelection: () => [...selected],
    setSelection(keys) {
      selected = new Set([...keys].filter(key => knownKeys.has(key)));
      syncAllChannelsFromSelected({ preserveDraft: false });
      const firstSelected = channels.find(ch => ch.leaves.some(leaf => selected.has(leaf.key)));
      if (firstSelected) activeChannelId = firstSelected.id;
      render();
    },
    resetFilters: clearFilters,
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
    }
  };
}
