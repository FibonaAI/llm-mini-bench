import { sortThinkingEfforts, thinkingLabel } from './data-picker.js';

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
  function updateConfigOverview(config) {
    const overview = element('run-config-overview');
    if (!overview) return;
    const bankText = app.taskCount > 0 ? `${app.taskCount} 题` : '题库加载中';
    const rounds = Number.isInteger(config.rounds) && config.rounds >= 1 && config.rounds <= 3 ? `${config.rounds} 轮` : '轮数无效';
    const sampleConcurrency =
      Number.isInteger(config.sample_concurrency) && config.sample_concurrency >= 1 && config.sample_concurrency <= 64
        ? `样本并发 ${config.sample_concurrency}`
        : '样本并发无效';
    const runConcurrency =
      Number.isInteger(config.run_concurrency) && config.run_concurrency >= 1 && config.run_concurrency <= 10
        ? `运行并发 ${config.run_concurrency}`
        : '运行并发无效';
    const timeout =
      Number.isInteger(config.limits.timeout) && config.limits.timeout >= 10 && config.limits.timeout <= 3600
        ? `超时 ${config.limits.timeout} 秒`
        : '超时无效';
    overview.textContent = `${bankText} · ${rounds} · ${sampleConcurrency} · ${runConcurrency} · ${timeout}`;
  }
  function updateTaskPreview() {
    const config = taskRequestConfig();
    updateConfigOverview(config);
    const valid = validConfig();
    element('start-run').disabled = !valid || state.busy || state.submissionUncertain || !state.timeoutPolicyReady;
    element('start-run').textContent = state.busy ? '正在启动…' : '开始评测';
    element('bench-retry-review').hidden = !state.submissionUncertain || state.busy;
    element('bench-plan-preview').hidden = !valid;
    if (!valid) return;
    renderTaskSummary({
      ...config,
      run_count: config.targets.length,
      samples_per_run: app.taskCount * config.rounds,
      sample_count: config.targets.length * app.taskCount * config.rounds,
      total_max_cost_usd: config.limits.max_cost_usd === null ? null : config.targets.length * config.limits.max_cost_usd
    });
  }
  let versionMenuOpen = false;
  function setVersionMenuOpen(next, { focus = false, restoreFocus = false } = {}) {
    const trigger = element('bench-version-trigger');
    const menu = element('bench-version-menu');
    if (!trigger || !menu) return;
    versionMenuOpen = Boolean(next);
    trigger.setAttribute?.('aria-expanded', String(versionMenuOpen));
    menu.hidden = !versionMenuOpen;
    if (versionMenuOpen && focus) {
      const target = menu.querySelector?.('[aria-selected="true"]') || menu.querySelector?.('[data-bank-version]');
      target?.focus?.({ preventScroll: true });
    } else if (!versionMenuOpen && restoreFocus) {
      trigger.focus?.({ preventScroll: true });
    }
  }
  function defaultBankEntry(banks) {
    return banks.find(entry => entry?.default === true) || banks.find(entry => entry?.production === true) || banks[0] || null;
  }
  function preferredDefaultBank(banks, recordedVersions) {
    const defaultBank = defaultBankEntry(banks);
    if (!defaultBank) return null;
    if (recordedVersions?.size && !recordedVersions.has(defaultBank.version)) {
      const legacyBank = banks.find(
        entry => entry?.version && entry.version !== defaultBank.version && recordedVersions.has(entry.version)
      );
      if (legacyBank) return legacyBank;
    }
    return defaultBank;
  }
  function unseenDefaultBankVersion(banks, recordedVersions) {
    if (!Array.isArray(banks) || banks.length < 2) return null;
    const defaultBank = banks.find(entry => entry?.default === true);
    if (!defaultBank?.version || recordedVersions?.has(defaultBank.version)) return null;
    return defaultBank.version;
  }
  function renderVersionSwitcher(bank = app.bank) {
    const switcher = element('bench-version-switch');
    if (!switcher || !bank || typeof bank.version !== 'string') return;
    const banks = Array.isArray(state.banks) ? state.banks : [];
    const versions = banks.filter(entry => typeof entry?.version === 'string');
    const recordedVersions = app.recordedBankVersions;
    const unseenDefault = unseenDefaultBankVersion(versions, recordedVersions);
    const hasNewer = Boolean(unseenDefault && unseenDefault !== bank.version);
    const label = element('bench-version-label');
    const badge = element('bench-version-badge');
    const trigger = element('bench-version-trigger');
    const menu = element('bench-version-menu');
    if (label) label.textContent = bank.version;
    if (badge) badge.hidden = !hasNewer;
    if (trigger) {
      trigger.title = hasNewer ? `Mini Bench ${bank.version}（新版本 ${unseenDefault} 已发布，点击切换）` : `Mini Bench ${bank.version}`;
      trigger.setAttribute?.(
        'aria-label',
        hasNewer ? `题库版本：Mini Bench ${bank.version}，有新版本 ${unseenDefault} 可用` : `题库版本：Mini Bench ${bank.version}`
      );
      if (hasNewer) trigger.setAttribute?.('data-has-update', 'true');
      else trigger.removeAttribute?.('data-has-update');
    }
    if (menu) {
      menu.innerHTML = versions
        .map(entry => {
          const isNew = Boolean(unseenDefault && entry.version === unseenDefault);
          const title = isNew ? `Mini Bench ${entry.version}（新版本）` : `Mini Bench ${entry.version}`;
          const newBadge = isNew ? '<span class="version-option-badge">新版本</span>' : '';
          return `<button class="version-option" type="button" role="option" data-bank-version="${escapeHtml(entry.version)}" aria-selected="${entry.version === bank.version}" title="${escapeHtml(title)}"><span>${escapeHtml(entry.version)}</span>${newBadge}</button>`;
        })
        .join('');
    }
    switcher.hidden = versions.length < 2;
    if (switcher.hidden && versionMenuOpen) setVersionMenuOpen(false);
  }
  function renderBanks() {
    // Keep the user's in-memory choice; otherwise prefer the legacy bank only when the workspace has
    // legacy records without any record on the default (latest) bank, and default to latest otherwise.
    const banks = Array.isArray(state.banks) ? state.banks : [];
    const bank =
      (state.selectedBankVersion && banks.find(entry => entry?.version === state.selectedBankVersion)) ||
      preferredDefaultBank(banks, app.recordedBankVersions);
    if (!bank || typeof bank.version !== 'string' || !Array.isArray(bank.tasks) || !bank.tasks.length)
      throw new Error('Mini Bench 题库格式无效');
    state.selectedBankVersion = bank.version;
    renderVersionSwitcher(bank);
    const labelPrefix = banks.length > 1 ? `Mini Bench ${bank.version}` : 'Mini Bench';
    element('bench-bank').value = bank.version;
    element('bench-bank-label').textContent = `${labelPrefix} · ${bank.tasks.length} 题全部运行`;
    const header = element('runs-bank-label');
    if (header) header.textContent = `${labelPrefix} · ${bank.tasks.length} 题`;
    app.setBank(bank);
    updateTaskPreview();
  }
  function selectBankVersion(version) {
    setVersionMenuOpen(false, { restoreFocus: true });
    if (!version || !state.banks.some(entry => entry?.version === version)) return;
    state.bankVersionPinned = true;
    if (version === state.selectedBankVersion) return;
    state.selectedBankVersion = version;
    renderBanks();
  }
  function reconcileDefaultBank() {
    if (!state.banks.length) return;
    if (!state.bankVersionPinned) {
      const preferred = preferredDefaultBank(state.banks, app.recordedBankVersions);
      if (preferred && preferred.version !== state.selectedBankVersion) {
        state.selectedBankVersion = preferred.version;
        renderBanks();
        return;
      }
    }
    renderVersionSwitcher();
  }
  element('bench-version-trigger')?.addEventListener?.('click', () => {
    setVersionMenuOpen(!versionMenuOpen, { focus: !versionMenuOpen });
  });
  element('bench-version-trigger')?.addEventListener?.('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setVersionMenuOpen(true, { focus: true });
    }
  });
  element('bench-version-menu')?.addEventListener?.('keydown', event => {
    if (!versionMenuOpen) return;
    const options = [...(element('bench-version-menu')?.querySelectorAll?.('[data-bank-version]') || [])];
    if (!options.length) return;
    const index = options.indexOf(event.target?.closest?.('[data-bank-version]'));
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      options[(index + 1 + options.length) % options.length]?.focus?.({ preventScroll: true });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      options[(index - 1 + options.length) % options.length]?.focus?.({ preventScroll: true });
    } else if (event.key === 'Home') {
      event.preventDefault();
      options[0]?.focus?.({ preventScroll: true });
    } else if (event.key === 'End') {
      event.preventDefault();
      options[options.length - 1]?.focus?.({ preventScroll: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setVersionMenuOpen(false, { restoreFocus: true });
    } else if (event.key === 'Tab') {
      setVersionMenuOpen(false);
    }
  });
  element('bench-version-switch')?.addEventListener?.('click', event => {
    const button = event.target?.closest?.('[data-bank-version]');
    if (button) selectBankVersion(button.dataset.bankVersion);
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', event => {
      if (versionMenuOpen && !element('bench-version-switch')?.contains?.(event.target)) setVersionMenuOpen(false);
    });
  }
  function renderTaskSummary(plan) {
    const thinkingLevels = sortThinkingEfforts(new Set((plan.targets || []).map(target => target?.thinking || 'unknown'))).map(
      thinkingLabel
    );
    element('bench-plan-preview').hidden = false;
    element('bench-plan-preview').innerHTML =
      `<div class="run-plan-summary"><strong>${escapeHtml(plan.run_count)} 个独立运行 · 共 ${escapeHtml(plan.sample_count)} 个样本</strong>${thinkingLevels.length ? `<span>思考 ${escapeHtml(thinkingLevels.join(' · '))}</span>` : ''}<span>每运行 ${escapeHtml(plan.samples_per_run)} 个样本（${escapeHtml(app.taskCount)} 题 × ${escapeHtml(plan.rounds)} 轮）</span><span>同时运行 ${escapeHtml(plan.run_concurrency)} 个 · 每运行最多并发 ${escapeHtml(plan.sample_concurrency)} 个样本</span><span>每题总超时 ${escapeHtml(plan.limits.timeout)} 秒</span><span class="sub">不设置 token、费用、请求数、工具调用及交互轮数上限。临时 API 错误最多重试 3 次，共用该题超时时间。</span></div>`;
  }
  // Magpie embeds pages in sandbox="allow-scripts" (without allow-forms), so native <form>
  // submission is blocked by the browser before JS submit listeners run.
  element('start-run').addEventListener('click', async () => {
    if (state.busy || state.submissionUncertain) return;
    if (!validConfig() || !state.timeoutPolicyReady) {
      notify('请先选择运行目标，并确认轮数、两级并发与执行上限。', true);
      return;
    }
    const submission = taskRequestConfig();
    const submittedBankVersion = submission.bank_version;
    state.busy = true;
    updateTaskPreview();
    notify('正在启动评测。');
    let created = false;
    try {
      const result = await request('./api/bench/tasks', { method: 'POST', body: JSON.stringify(submission) });
      if (!result?.id) throw new Error('服务未返回任务 ID');
      created = true;
      if (app.bank?.version === submittedBankVersion) {
        state.selectionVersion++;
        state.selectedTaskId = result.id;
        state.selectedRunId = null;
        state.taskDetail = null;
        state.runDetail = null;
      }
      app.setTaskSelection([]);
    } catch (error) {
      state.submissionUncertain = true;
      await refreshHistory(true);
      notify('未能确认创建结果：' + error.message + '。已尝试刷新任务历史，请先核对记录；不要直接重复提交，以免重复付费。', true);
    } finally {
      state.busy = false;
      updateTaskPreview();
    }
    if (created) {
      notify('评测已启动，各运行独立保存样本与预算状态。');
      void refreshHistory(true);
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
    const recordVersion = record?.bank_version ?? plan.bank_version;
    if (recordVersion && recordVersion !== app.bank?.version && state.banks.some(entry => entry?.version === recordVersion))
      selectBankVersion(recordVersion);
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
    const rounds = plan.rounds ?? 3;
    const sampleConcurrency = plan.sample_concurrency ?? plan.concurrency ?? 6;
    const runConcurrency = plan.run_concurrency ?? 3;
    const timeout = plan.limits?.timeout_scope === 'sample' ? plan.limits.timeout : 600;
    element('run-rounds').value = String(rounds);
    element('sample-concurrency').value = String(sampleConcurrency);
    element('run-concurrency').value = String(runConcurrency);
    element('bench-timeout').value = String(timeout);
    const configDisclosure = element('run-config-disclosure');
    if (configDisclosure && (rounds !== 3 || sampleConcurrency !== 6 || runConcurrency !== 3 || timeout !== 600)) {
      configDisclosure.open = true;
    }
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
    if (!retryRequests.has(key)) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      retryRequests.set(key, [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''));
      renderDetails();
      notify('仅重试失败、超时、已中断或已取消样本，保留已完成结果。会产生额外用量，仍使用原账号与剩余执行上限。再次点击确认。');
      return;
    }
    retrying.add(key);
    renderDetails();
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
  return { updateTaskPreview, renderBanks, renderVersionSwitcher, reconcileDefaultBank, selectBankVersion };
}
