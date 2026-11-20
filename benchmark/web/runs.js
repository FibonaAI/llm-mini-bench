import { createDataPicker, selectionKey, thinkingLabel } from './data-picker.js';
import { routePickerLeaves } from './data-adapter.js';

/** Initialize exact target selection with the shared app context; no import-time DOM writes. */
export function createTaskTargets(app) {
  const { byId: element, escapeHtml, notify } = app.services;
  let picker;

  /** Resolve only selected advertised route/Thinking leaves; never form a cross product. */
  function getSelectedTargets() {
    const selected = new Set(app.targets.selectedKeys);
    const targets = new Map();
    for (const leaf of app.targets.leaves) {
      if (!selected.has(selectionKey(leaf))) continue;
      const routeId = leaf.routeId;
      if (!routeId || typeof routeId !== 'string') continue;
      const identity = JSON.stringify([routeId, leaf.think]);
      targets.set(identity, { route_id: routeId, thinking: leaf.think });
    }
    // Sort exact identities before assigning short local IDs; catalog/selection order cannot change the payload.
    return [...targets.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, target], index) => ({ id: `target-${index + 1}`, ...target }));
  }

  function renderSelection() {
    const selected = new Set(app.targets.selectedKeys);
    const leaves = app.targets.leaves.filter(leaf => selected.has(selectionKey(leaf)));
    element('run-model-count').textContent = `${getSelectedTargets().length} 个独立运行`;
    element('run-selected-targets').innerHTML = leaves.length
      ? leaves
          .map(
            leaf =>
              `<div class="selected-target"><strong>${escapeHtml(leaf.modelDisplayName || leaf.model)}</strong><span>${escapeHtml(leaf.providerName || leaf.providerDisplayId || leaf.provider)} / ${escapeHtml(leaf.account)} · ${escapeHtml(thinkingLabel(leaf.think))}</span></div>`
          )
          .join('')
      : '<p class="empty">尚未选择目标。搜索模型可跨渠道选择，也可按渠道、模型或思考筛选。</p>';
    const gatewayTargets = leaves.some(leaf => leaf.route?.account_evidence === 'gateway_binding');
    element('task-route-warning').hidden = !gatewayTargets;
    element('task-route-warning').textContent = gatewayTargets
      ? '实际账号由 Magpie 分配；网关内部也可能重试。固定账号对照需显式绑定路由。'
      : '';
    updateEstimate();
  }

  function updateEstimate() {
    const rounds = Number(element('run-rounds').value);
    const count = getSelectedTargets().length;
    const validRounds = Number.isInteger(rounds) && rounds >= 1 && rounds <= 3;
    const samples = count * app.taskCount * (validRounds ? rounds : 0);
    element('run-request-estimate').textContent =
      `${count} 个独立运行 × 每运行 ${app.taskCount} 题 × ${validRounds ? rounds : '?'} 轮 = 共 ${samples} 个样本。每个运行固定路由、模型与 Thinking；实际账号绑定以路由证据为准。`;
  }

  /** Copy exact available leaves only; unknown selections never become wildcard targets. */
  function setTaskSelection(keys, announce = false) {
    const requested = [...new Set(keys)];
    const available = new Set(app.targets.leaves.map(selectionKey));
    app.setTargetSelection(requested.filter(key => available.has(key)));
    picker?.setSelection(app.targets.selectedKeys);
    if (!requested.length) picker?.resetFilters?.();
    renderSelection();
    app.emit('mini-bench:targets-changed');
    if (announce) {
      const omitted = requested.length - app.targets.selectedKeys.length;
      notify(
        `已带入 ${app.targets.selectedKeys.length} 个目标${omitted ? `；${omitted} 项不受当前路由目录支持，未加入` : ''}。尚未发送模型请求，核对样本数与预算后即可开始评测。`
      );
    }
  }

  /** Refresh catalog while retaining only still-supported leaves; never auto-select new routes. */
  function setTaskRoutes(routes) {
    const leaves = routePickerLeaves(routes);
    app.setTargetCatalog(routes, leaves, leaves.map(selectionKey));
    picker?.destroy();
    picker = createDataPicker(element('task-picker'), {
      records: app.targets.leaves,
      selectedKeys: app.targets.selectedKeys,
      mode: 'tasks',
      onChange: keys => setTaskSelection(keys)
    });
    renderSelection();
    app.emit('mini-bench:targets-changed');
  }

  element('run-rounds').addEventListener('input', updateEstimate);
  app.on('mini-bench:select-targets', event => {
    if (Array.isArray(event.detail?.keys)) setTaskSelection(event.detail.keys, true);
  });
  app.on('mini-bench:banks-changed', updateEstimate);
  app.bindTargetActions({ getSelectedTargets, setTaskSelection, setTaskRoutes });
  setTaskRoutes([]);
  return { getSelectedTargets, setTaskSelection, setTaskRoutes };
}
