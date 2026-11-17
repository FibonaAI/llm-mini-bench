/** Task configuration, explicit creation/review, and idempotent manual retries. */
export function createTaskSubmission({
  app,
  state,
  element,
  fixedTargets,
  inProgress,
  renderDetails,
  refreshHistory,
  retryRequests,
  retrying
}) {
  const { escapeHtml, request, notify } = app.services;
  function taskRequestConfig() {
    return {
      bank_version: element('bench-bank').value,
      targets: app.getSelectedTargets(),
      rounds: Number(element('run-rounds').value),
      sample_concurrency: Number(element('sample-concurrency').value),
      run_concurrency: Number(element('run-concurrency').value),
      limits: {
        timeout: Number(element('bench-timeout').value),
        timeout_scope: 'sample',
        max_requests: null,
        max_output_tokens: null,
        max_cost_usd: null,
        max_turns: null,
        max_tool_calls: null,
        max_api_retries: 3
      }
    };
  }
  function validConfig() {
    const config = taskRequestConfig();
    return (
      config.targets.length > 0 &&
      app.taskCount > 0 &&
      typeof app.bank?.version === 'string' &&
      config.bank_version === app.bank.version &&
      Number.isInteger(config.limits.timeout) &&
      config.limits.timeout >= 10 &&
      config.limits.timeout <= 3600 &&
      Number.isInteger(config.rounds) &&
      config.rounds >= 1 &&
      config.rounds <= 3 &&
      Number.isInteger(config.sample_concurrency) &&
      config.sample_concurrency >= 1 &&
      config.sample_concurrency <= 64 &&
      Number.isInteger(config.run_concurrency) &&
      config.run_concurrency >= 1 &&
      config.run_concurrency <= 10
    );
  }
  function updateTaskPreview() {
    const valid = validConfig();
    element('start-run').disabled = !valid || state.busy || state.submissionUncertain || !state.timeoutPolicyReady;
    element('start-run').textContent = state.busy ? '正在启动…' : '开始评测';
    element('bench-retry-review').hidden = !state.submissionUncertain || state.busy;
    element('bench-plan-preview').hidden = !valid;
    if (!valid) return;
    const config = taskRequestConfig();
    renderTaskSummary({
      ...config,
      run_count: config.targets.length,
      samples_per_run: app.taskCount * config.rounds,
      sample_count: config.targets.length * 14 * config.rounds,
      total_max_cost_usd: config.limits.max_cost_usd === null ? null : config.targets.length * config.limits.max_cost_usd
    });
  }
  function renderBanks() {
    // The service marks exactly one production bank; its version and task count drive the form.
    const bank = state.banks.find(entry => entry.production === true) ?? (state.banks.length === 1 ? state.banks[0] : undefined);
    if (!bank || typeof bank.version !== 'string' || !Array.isArray(bank.tasks) || !bank.tasks.length)
      throw new Error('Mini Bench 题库格式无效');
    element('bench-bank').value = bank.version;
    element('bench-bank-label').textContent = `Mini Bench · ${bank.tasks.length} 题全部运行`;
    const header = element('runs-bank-label');
    if (header) header.textContent = `Mini Bench · ${bank.tasks.length} 题`;
    app.setBank(bank);
    updateTaskPreview();
  }
  function renderTaskSummary(plan) {
    element('bench-plan-preview').hidden = false;
    element('bench-plan-preview').innerHTML =
      `<div class="run-plan-summary"><strong>${escapeHtml(plan.run_count)} 个独立运行 · 共 ${escapeHtml(plan.sample_count)} 个样本</strong><span>每运行 ${escapeHtml(plan.samples_per_run)} 个样本（${escapeHtml(app.taskCount)} 题 × ${escapeHtml(plan.rounds)} 轮）</span><span>同时运行 ${escapeHtml(plan.run_concurrency)} 个 · 每运行最多并发 ${escapeHtml(plan.sample_concurrency)} 个样本</span><span>每题总超时 ${escapeHtml(plan.limits.timeout)} 秒</span><span class="sub">不设置 token、费用、请求数、工具调用及交互轮数上限。临时 API 错误最多重试 3 次，共用该题超时时间。</span></div>`;
  }
  element('run-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy || state.submissionUncertain) return;
    if (!validConfig() || !state.timeoutPolicyReady) {
      notify('请先选择运行目标，并确认轮数、两级并发与执行上限。', true);
      return;
    }
    const submission = taskRequestConfig();
    state.busy = true;
    updateTaskPreview();
    notify('正在启动评测。');
    try {
      const result = await request('./api/bench/tasks', { method: 'POST', body: JSON.stringify(submission) });
      if (!result?.id) throw new Error('服务未返回任务 ID');
      state.selectionVersion++;
      state.selectedTaskId = result.id;
      state.selectedRunId = null;
      state.taskDetail = null;
      state.runDetail = null;
      await refreshHistory(true);
      notify('评测已启动，各运行独立保存样本与预算状态。');
    } catch (error) {
      state.submissionUncertain = true;
      await refreshHistory(true);
      notify('未能确认创建结果：' + error.message + '。已尝试刷新任务历史，请先核对记录；不要直接重复提交，以免重复付费。', true);
    } finally {
      state.busy = false;
      updateTaskPreview();
    }
  });
  element('bench-retry-review').addEventListener('click', () => {
    if (state.busy || !state.submissionUncertain) return;
    state.submissionUncertain = false;
    updateTaskPreview();
    notify('已允许重新开始。再次点击“开始评测”会创建新任务，可能产生额外费用。');
  });
  async function copyTaskConfig(record) {
    const plan = record?.plan;
    if (!plan) return;
    const targets = fixedTargets(record),
      keys = [];
    for (const target of targets) {
      const leaf = app.targets.leaves.find(
        leaf =>
          leaf.routeId === target.route_id &&
          leaf.think === target.thinking &&
          (!target.binding_ref || leaf.route?.binding_ref === target.binding_ref)
      );
      if (leaf) keys.push(JSON.stringify([leaf.providerId, leaf.accountId, leaf.model, leaf.think]));
    }
    element('run-rounds').value = String(plan.rounds ?? 3);
    element('sample-concurrency').value = String(plan.sample_concurrency ?? plan.concurrency ?? 6);
    element('run-concurrency').value = String(plan.run_concurrency ?? 3);
    element('bench-timeout').value = String(plan.limits?.timeout_scope === 'sample' ? plan.limits.timeout : 600);
    app.setTaskSelection(keys);
    updateTaskPreview();
    element('run-form').scrollIntoView?.({ block: 'start' });
    notify(
      '已复制 ' +
        keys.length +
        ' 个目标及配置' +
        (keys.length < targets.length ? '；部分路由或绑定已不可用，未替换为其他目标' : '') +
        '。尚未启动评测。'
    );
  }
  async function retryExecution(kind, id) {
    const key = kind + ':' + id;
    if (!id || retrying.has(key)) return;
    const record = kind === 'tasks' ? state.taskDetail : state.runDetail;
    if (!record || record.id !== id || inProgress(record)) return;
    const button = element(kind === 'tasks' ? 'bench-retry-task' : 'bench-retry-run');
    if (!retryRequests.has(key)) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      retryRequests.set(key, [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''));
      button.textContent = '确认重试 API 失败';
      notify('仅重试 API 失败及因其停止的未执行样本，保留成功结果。会产生额外用量，仍使用原账号与剩余执行上限。再次点击确认。');
      return;
    }
    retrying.add(key);
    button.disabled = true;
    try {
      const result = await request('./api/bench/' + kind + '/' + encodeURIComponent(id) + '/retry', {
        method: 'POST',
        body: JSON.stringify({ request_id: retryRequests.get(key) })
      });
      retryRequests.delete(key);
      await refreshHistory(true);
      app.emit('mini-bench:observations-changed');
      notify(result.rejected?.length ? '部分运行未能重试，请查看原账号、剩余上限及任务状态。' : '已提交重试，结果会随运行进度自动更新。');
    } catch (error) {
      await refreshHistory(true);
      notify('未能确认重试结果：' + error.message + '。请核对历史；再次确认会使用同一请求标识，不会重复创建本次重试。', true);
    } finally {
      retrying.delete(key);
      renderDetails();
    }
  }
  element('bench-copy-task').addEventListener('click', () => copyTaskConfig(state.taskDetail));
  element('bench-copy-run').addEventListener('click', () => copyTaskConfig(state.runDetail));
  element('bench-retry-task').addEventListener('click', () => retryExecution('tasks', state.selectedTaskId));
  element('bench-retry-run').addEventListener('click', () => retryExecution('runs', state.selectedRunId));
  app.on('mini-bench:targets-changed', updateTaskPreview);
  element('run-form').addEventListener('change', updateTaskPreview);
  element('run-form').addEventListener('input', updateTaskPreview);
  updateTaskPreview();
  return { updateTaskPreview, renderBanks };
}
