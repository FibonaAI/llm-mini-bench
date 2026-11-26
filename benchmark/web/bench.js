import { getAppContext } from './app-context.js';
import { createTaskTargets } from './runs.js';
import { createTaskHistoryView } from './task-history-view.js';
import { createTaskSubmission } from './task-submission.js';

(() => {
  'use strict';
  const app = getAppContext();
  const { request, notify, available } = app.services;
  createTaskTargets(app);
  const state = {
    banks: [],
    selectedBankVersion: null,
    bankVersionPinned: false,
    observationsBankChecked: false,
    submissionUncertain: false,
    tasks: [],
    runs: [],
    tasksEtag: null,
    runsEtag: null,
    selectedTaskId: null,
    selectedRunId: null,
    taskDetail: null,
    runDetail: null,
    selectionVersion: 0,
    timer: null,
    busy: false,
    refreshing: null,
    cancelling: new Set()
  };
  const retryRequests = new Map(),
    retrying = new Set(),
    baselineBusy = new Set();
  let pendingRevealRunId = null;
  let pendingForceFresh = false;
  const {
    element,
    historyEntries,
    renderDetails,
    inProgress,
    canCancel,
    fixedTargets,
    runBaselineTargets,
    taskSection,
    runSection,
    recordBankVersion = record => record?.bank_version ?? record?.plan?.bank_version ?? null,
    matchesBankVersion = (record, active = app.bank?.version ?? null) => Boolean(active) && recordBankVersion(record) === active
  } = createTaskHistoryView({
    app,
    state,
    retryRequests,
    retrying,
    baselineBusy
  });
  const {
    updateTaskPreview,
    renderBanks,
    renderVersionSwitcher = () => {},
    reconcileDefaultBank = () => {},
    selectBankVersion = () => {}
  } = createTaskSubmission({
    app,
    state,
    element,
    fixedTargets,
    inProgress,
    renderDetails,
    refreshHistory,
    retryRequests,
    retrying
  });
  // Hidden pages do not poll; becoming visible refreshes once and resumes if work is active.
  const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  function schedulePolling() {
    clearTimeout(state.timer);
    state.timer = null;
    if (!pageHidden() && [...state.tasks, ...state.runs].some(inProgress)) state.timer = setTimeout(() => refreshHistory(), 2000);
  }
  if (typeof document !== 'undefined')
    document.addEventListener?.('visibilitychange', () => {
      if (pageHidden()) {
        clearTimeout(state.timer);
        state.timer = null;
      } else if (available && [...state.tasks, ...state.runs].some(inProgress)) refreshHistory();
    });
  const findTaskSummary = id => (id ? state.tasks.find(task => task.id === id) || null : null);
  const taskSummaryComplete = task => Boolean(task && Array.isArray(task.children));
  const findRunSummary = id => {
    if (!id) return null;
    for (const task of state.tasks) {
      const child = task.children?.find(item => item.run_id === id);
      if (child) return child;
    }
    return state.runs.find(run => run.id === id) || null;
  };
  const taskDetailUrl = id => `./api/bench/tasks/${encodeURIComponent(id)}?omit_provenance=1`;
  const runDetailUrl = id => `./api/bench/runs/${encodeURIComponent(id)}?omit_provenance=1`;
  const baselineStateSignature = record => {
    if (!record) return '';
    if (Array.isArray(record.children)) {
      return record.children.map(child => `${child.run_id}:${child.baseline_eligible ? 1 : 0}:${child.baseline_id || ''}`).join('|');
    }
    if (Array.isArray(record.baseline_targets) && record.baseline_targets.length > 0) {
      return record.baseline_targets.map(item => `${item.target_id}:${item.baseline_eligible ? 1 : 0}:${item.baseline_id || ''}`).join('|');
    }
    const targetId =
      typeof record.target?.id === 'string' && record.target.id
        ? record.target.id
        : Array.isArray(record.plan?.targets) && record.plan.targets.length === 1 && typeof record.plan.targets[0]?.id === 'string'
          ? record.plan.targets[0].id
          : '';
    return targetId
      ? `${targetId}:${record.baseline_eligible ? 1 : 0}:${record.baseline_id || ''}`
      : `${record.baseline_eligible ? 1 : 0}:${record.baseline_id || ''}`;
  };
  const detailUnchanged = (detail, summary) =>
    Boolean(
      detail &&
      summary &&
      !inProgress(summary) &&
      !inProgress(detail) &&
      detail.status === summary.status &&
      detail.updated_at !== undefined &&
      detail.updated_at === summary.updated_at &&
      baselineStateSignature(detail) === baselineStateSignature(summary)
    );
  const RUN_DETAIL_CACHE_MAX = 32;
  const runDetailCache = new Map();
  const inflightRunRequests = new Map();
  function cachedRunDetail(runId) {
    if (!runId) return null;
    const cached = runDetailCache.get(runId);
    if (!cached) return null;
    if (!detailUnchanged(cached, findRunSummary(runId))) {
      runDetailCache.delete(runId);
      return null;
    }
    runDetailCache.delete(runId);
    runDetailCache.set(runId, cached);
    return cached;
  }
  function cacheRunDetail(run) {
    if (!run?.id) return;
    if (inProgress(run) || run.updated_at === undefined) {
      runDetailCache.delete(run.id);
      return;
    }
    runDetailCache.delete(run.id);
    runDetailCache.set(run.id, run);
    if (runDetailCache.size > RUN_DETAIL_CACHE_MAX) {
      const oldest = runDetailCache.keys().next().value;
      if (oldest !== undefined) runDetailCache.delete(oldest);
    }
  }
  function fetchRunDetail(runId, { forceFresh = false } = {}) {
    if (!forceFresh) {
      const hit = cachedRunDetail(runId);
      if (hit) return Promise.resolve(hit);
    }
    const existing = inflightRunRequests.get(runId);
    if (existing && (!forceFresh || existing.forceFresh)) return existing.promise;
    const entry = { forceFresh, promise: null };
    entry.promise = request(runDetailUrl(runId))
      .then(run => {
        cacheRunDetail(run);
        return run;
      })
      .finally(() => {
        if (inflightRunRequests.get(runId) === entry) inflightRunRequests.delete(runId);
      });
    inflightRunRequests.set(runId, entry);
    return entry.promise;
  }
  async function refreshHistory(forceFresh = false) {
    if (state.refreshing) {
      if (forceFresh) pendingForceFresh = true;
      await state.refreshing;
      if (pendingForceFresh) {
        pendingForceFresh = false;
        return refreshHistory(true);
      }
      return;
    }
    state.refreshing = (async () => {
      const previous = new Map([...state.tasks, ...state.runs].map(record => [record.id, record.status]));
      try {
        const tasksPath =
          !forceFresh && state.tasksEtag ? `./api/bench/tasks?known=${encodeURIComponent(state.tasksEtag)}` : './api/bench/tasks';
        const runsPath =
          !forceFresh && state.runsEtag ? `./api/bench/runs?known=${encodeURIComponent(state.runsEtag)}` : './api/bench/runs';
        const [tasks, runs] = await Promise.all([request(tasksPath), request(runsPath)]);
        const tasksUnchanged = !forceFresh && Boolean(state.tasksEtag) && tasks.unchanged === true;
        const runsUnchanged = !forceFresh && Boolean(state.runsEtag) && runs.unchanged === true;
        if (!tasksUnchanged) {
          if (!Array.isArray(tasks.tasks)) throw new Error('任务或运行记录格式无效');
          state.tasks = tasks.tasks;
          state.tasksEtag = typeof tasks.etag === 'string' ? tasks.etag : null;
          app.setHistory(state.tasks);
        }
        if (!runsUnchanged) {
          if (!Array.isArray(runs.runs)) throw new Error('任务或运行记录格式无效');
          state.runs = runs.runs;
          state.runsEtag = typeof runs.etag === 'string' ? runs.etag : null;
        }
        if (!tasksUnchanged || !runsUnchanged) {
          app.setRecordedBankVersions?.(
            'history',
            [...state.tasks, ...state.runs].map(record => recordBankVersion(record))
          );
        }
        const runsVisible = !element('runs-view')?.hidden;
        if (runsVisible && !state.historyClosed && !state.selectedTaskId && !state.selectedRunId) {
          const first = historyEntries()[0];
          if (first?.kind === 'task') state.selectedTaskId = first.record.id;
          else if (first) state.selectedRunId = first.record.id;
        }
        const taskId = state.selectedTaskId,
          runId = state.selectedRunId,
          version = state.selectionVersion;
        if (tasksUnchanged && runsUnchanged && (!taskId || state.taskDetail?.id === taskId) && (!runId || state.runDetail?.id === runId)) {
          revealSelectedRun();
          return;
        }
        const taskSummary = findTaskSummary(taskId);
        const keepTask = !forceFresh && state.taskDetail?.id === taskId && detailUnchanged(state.taskDetail, taskSummary);
        const keepRun = !forceFresh && state.runDetail?.id === runId && detailUnchanged(state.runDetail, findRunSummary(runId));
        const taskPromise = taskId
          ? keepTask
            ? state.taskDetail
            : taskSummaryComplete(taskSummary)
              ? taskSummary
              : request(taskDetailUrl(taskId))
          : null;
        const runPromise = runId ? (keepRun ? state.runDetail : fetchRunDetail(runId, { forceFresh })) : null;
        const [task, run] = await Promise.all([taskPromise, runPromise]);
        if (version === state.selectionVersion) {
          state.taskDetail = task;
          state.runDetail = run;
        }
        renderDetails();
        revealSelectedRun();
        if (
          (!tasksUnchanged || !runsUnchanged) &&
          [...state.tasks, ...state.runs].some(record => previous.has(record.id) && previous.get(record.id) !== record.status)
        )
          app.emit('mini-bench:observations-changed');
      } catch (error) {
        notify(`无法加载任务与运行记录：${error.message}`, true);
      } finally {
        state.refreshing = null;
        schedulePolling();
      }
    })();
    return state.refreshing;
  }
  async function load(event) {
    if (!available) return;
    const refresh = event?.type === 'mini-bench:refresh';
    const initialBankLoad = !state.selectedBankVersion;
    const fetchBanks = async () => {
      try {
        const data = await request('./api/bench/banks');
        if (!Array.isArray(data.banks)) throw new Error('题库目录格式无效');
        state.timeoutPolicyReady = data.execution_policy === 'sample-timeout-v1';
        state.banks = data.banks;
        if (!initialBankLoad) renderBanks();
        if (!state.timeoutPolicyReady) notify('服务仍在执行旧任务，更新完成前暂不接收新任务。', true);
        return true;
      } catch (error) {
        notify(`无法加载 Mini Bench 题库：${error.message}`, true);
        return false;
      }
    };
    const loadRoutes = async () => {
      try {
        const data = await request(`./api/bench/routes${refresh ? '?refresh=1' : ''}`);
        if (!Array.isArray(data.routes)) throw new Error('路由目录格式无效');
        app.setTaskRoutes(data.routes);
        app.emit('mini-bench:routes-changed');
      } catch (error) {
        notify(`无法加载路由目录：${error.message}`, true);
      }
    };
    const [banksLoaded] = await Promise.all([fetchBanks(), loadRoutes(), refreshHistory(refresh)]);
    if (initialBankLoad && banksLoaded) renderBanks();
  }
  function ensureRunMounted(runId) {
    if (!runId) return;
    const list = element('bench-run-list');
    const search = element('history-search');
    const status = element('history-status');
    if (!search || !status || (!search.value?.trim?.() && (!status.value || status.value === 'all'))) return;
    const slot = runSection.parentElement;
    const mountedForRun =
      Boolean(list?.contains?.(runSection)) &&
      !runSection.hidden &&
      (slot?.dataset?.inlineRun === runId || (slot?.dataset?.previewRunIds || '').split(',').includes(runId));
    if (mountedForRun) return;
    if (search.value) search.value = '';
    if (status.value && status.value !== 'all') status.value = 'all';
    renderDetails();
  }
  function revealSelectedRun() {
    const runId = pendingRevealRunId;
    if (!runId || state.selectedRunId !== runId) return;
    if (element('runs-view')?.hidden) return;
    const loaded = state.runDetail?.id === runId && (!state.selectedTaskId || state.taskDetail?.id === state.selectedTaskId);
    if (!loaded) return;
    ensureRunMounted(runId);
    if (state.refreshing && runSection.isConnected === false) return;
    pendingRevealRunId = null;
    const scrollNow = () => {
      if (state.selectedRunId !== runId || element('runs-view')?.hidden || runSection.hidden) return;
      const target =
        runSection.closest?.('.task-preview-group') ||
        (!state.selectedTaskId ? runSection.closest?.('.history-entry') : null) ||
        runSection;
      target?.scrollIntoView?.({ block: 'start' });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(scrollNow));
    } else {
      scrollNow();
    }
  }
  function closeAssessmentTask() {
    pendingRevealRunId = null;
    state.selectionVersion++;
    state.historyClosed = true;
    state.selectedTaskId = null;
    state.selectedRunId = null;
    state.taskDetail = null;
    state.runDetail = null;
    renderDetails();
  }
  function closeAssessmentRun() {
    pendingRevealRunId = null;
    state.selectionVersion++;
    state.historyClosed = true;
    state.selectedRunId = null;
    state.runDetail = null;
    renderDetails();
  }
  const toggleAssessmentTask = taskId => (state.selectedTaskId === taskId ? closeAssessmentTask() : selectAssessmentTask(taskId));
  const toggleAssessmentRun = runId => (state.selectedRunId === runId ? closeAssessmentRun() : selectAssessmentRun(runId));
  function focusHistoryCard(attribute, id) {
    const candidates = [...(element('bench-run-list').querySelectorAll?.(`[${attribute}]`) || [])].filter(
      node => node.getAttribute(attribute) === id
    );
    const visible = candidates.find(node => !node.closest?.('details:not([open])'));
    (visible || candidates[0])?.focus({ preventScroll: true });
  }
  element('bench-close-task').addEventListener('click', () => {
    const id = state.selectedTaskId;
    closeAssessmentTask();
    focusHistoryCard('data-bench-task-id', id);
  });
  element('bench-close-run').addEventListener('click', () => {
    const id = state.selectedRunId;
    const allRunsOpen = Boolean(element('bench-task-detail').querySelector?.('details.task-all-runs')?.open);
    closeAssessmentRun();
    focusHistoryCard(state.selectedTaskId && !allRunsOpen ? 'data-preview-run-id' : 'data-bench-run-id', id);
  });
  async function selectAssessmentTask(taskId) {
    pendingRevealRunId = null;
    const version = ++state.selectionVersion;
    state.historyClosed = false;
    state.selectedTaskId = taskId;
    state.selectedRunId = null;
    state.runDetail = null;
    const summary = findTaskSummary(taskId);
    if (taskSummaryComplete(summary)) {
      state.taskDetail = summary;
      renderDetails();
      return;
    }
    state.taskDetail = null;
    renderDetails();
    try {
      const task = await request(taskDetailUrl(taskId));
      if (version !== state.selectionVersion) return;
      if (!matchesBankVersion(task, app.bank?.version)) {
        if (state.selectedTaskId === taskId) {
          state.selectedTaskId = null;
          state.taskDetail = null;
          renderDetails();
        }
        return;
      }
      state.taskDetail = task;
      renderDetails();
    } catch (error) {
      if (version === state.selectionVersion) notify(`无法加载任务详情：${error.message}`, true);
    }
  }
  async function selectAssessmentRun(runId, { allowBankSwitch = false } = {}) {
    if (state.selectedRunId === runId && state.runDetail?.id === runId && matchesBankVersion(state.runDetail, app.bank?.version)) {
      revealSelectedRun();
      return;
    }
    const version = ++state.selectionVersion;
    state.historyClosed = false;
    state.selectedRunId = runId;
    const parent = state.tasks.find(task => task.children?.some(child => child.run_id === runId));
    state.selectedTaskId = parent?.id || null;
    if (parent) state.taskDetail = parent;
    else if (state.taskDetail) state.taskDetail = null;
    const cached = cachedRunDetail(runId);
    if (cached) {
      const cachedVersion = recordBankVersion(cached) ?? recordBankVersion(parent);
      if (
        allowBankSwitch &&
        cachedVersion &&
        cachedVersion !== app.bank?.version &&
        state.banks.some(bank => bank?.version === cachedVersion)
      ) {
        suppressBankAutoSelect = true;
        try {
          selectBankVersion(cachedVersion);
        } finally {
          suppressBankAutoSelect = false;
        }
      } else if (!matchesBankVersion(cached, app.bank?.version)) {
        state.selectedRunId = null;
        state.selectedTaskId = null;
        state.taskDetail = null;
        state.runDetail = null;
        renderDetails();
        return;
      }
      state.runDetail = cached;
      renderDetails();
      revealSelectedRun();
      return;
    }
    state.runDetail = null;
    renderDetails();
    try {
      const run = await fetchRunDetail(runId);
      if (version !== state.selectionVersion) return;
      const loadedVersion = recordBankVersion(run) ?? recordBankVersion(findTaskSummary(run.task_id));
      if (
        allowBankSwitch &&
        loadedVersion &&
        loadedVersion !== app.bank?.version &&
        state.banks.some(bank => bank?.version === loadedVersion)
      ) {
        suppressBankAutoSelect = true;
        try {
          selectBankVersion(loadedVersion);
        } finally {
          suppressBankAutoSelect = false;
        }
      } else if (!matchesBankVersion(run, app.bank?.version)) {
        if (state.selectedRunId === runId) {
          pendingRevealRunId = null;
          state.selectedRunId = null;
          state.selectedTaskId = null;
          state.taskDetail = null;
          state.runDetail = null;
          renderDetails();
        }
        return;
      }
      state.runDetail = run;
      state.selectedTaskId = run.task_id || parent?.id || null;
      if (state.selectedTaskId && state.taskDetail?.id !== state.selectedTaskId) {
        const parentSummary = findTaskSummary(state.selectedTaskId);
        if (taskSummaryComplete(parentSummary)) {
          state.taskDetail = parentSummary;
        } else {
          const task = await request(taskDetailUrl(state.selectedTaskId));
          if (version !== state.selectionVersion) return;
          state.taskDetail = task;
        }
      }
      renderDetails();
      revealSelectedRun();
    } catch (error) {
      if (pendingRevealRunId === runId) pendingRevealRunId = null;
      if (version === state.selectionVersion) notify(`无法加载运行详情：${error.message}`, true);
    }
  }
  async function cancelExecution(kind, id) {
    if (!id || state.cancelling.has(`${kind}:${id}`)) return;
    const record =
      kind === 'task'
        ? state.taskDetail || state.tasks.find(task => task.id === id)
        : state.runDetail?.id === id
          ? state.runDetail
          : state.taskDetail?.children?.find(child => child.run_id === id) || state.runs.find(run => run.id === id);
    if (!canCancel(record)) return;
    const key = `${kind}:${id}`;
    state.cancelling.add(key);
    renderDetails();
    try {
      await request(`./api/bench/${kind === 'task' ? 'tasks' : 'runs'}/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      await refreshHistory(true);
      notify(kind === 'task' ? '已请求取消整个任务及未完成运行。' : '已请求取消该运行，其他运行不受影响。');
    } catch (error) {
      notify(`取消失败：${error.message}`, true);
    } finally {
      state.cancelling.delete(key);
      renderDetails();
    }
  }
  const BASELINE_BATCH_LIMIT = 256;
  const chunkList = (list, size) => {
    const chunks = [];
    for (let offset = 0; offset < list.length; offset += size) chunks.push(list.slice(offset, offset + size));
    return chunks;
  };
  async function promoteRunsToBaseline(scopeKey, items) {
    const seen = new Set();
    const uniqueItems = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.run_id !== 'string' || !item.run_id || typeof item.target_id !== 'string' || !item.target_id) continue;
      const key = `${item.run_id}\u0000${item.target_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueItems.push({ run_id: item.run_id, target_id: item.target_id });
    }
    if (!scopeKey || baselineBusy.has(scopeKey) || !uniqueItems.length) return;
    baselineBusy.add(scopeKey);
    renderDetails();
    let createdCount = 0;
    let rejectedCount = 0;
    try {
      if (uniqueItems.length === 1) {
        const single = uniqueItems[0];
        await request(`./api/bench/runs/${encodeURIComponent(single.run_id)}/baseline`, {
          method: 'POST',
          body: JSON.stringify({ target_id: single.target_id })
        });
        createdCount = 1;
      } else {
        for (const chunk of chunkList(uniqueItems, BASELINE_BATCH_LIMIT)) {
          const result = await request('./api/bench/baselines/batch', {
            method: 'POST',
            body: JSON.stringify({ action: 'promote', items: chunk })
          });
          createdCount += Array.isArray(result?.created) ? result.created.length : chunk.length;
          rejectedCount += Array.isArray(result?.rejected) ? result.rejected.length : 0;
        }
      }
      await refreshHistory(true);
      app.emit('mini-bench:observations-changed');
      if (rejectedCount > 0 && createdCount === 0) {
        notify(`未能保存基线：${rejectedCount} 个运行不符合当前基线条件。`, true);
      } else if (rejectedCount > 0) {
        notify(`已将 ${createdCount} 个运行保存为基线；${rejectedCount} 个运行不符合条件已跳过。`);
      } else {
        notify(createdCount > 1 ? `已将 ${createdCount} 个运行目标保存为 Mini Bench 基线。` : '已将该运行目标保存为 Mini Bench 基线。');
      }
    } catch (error) {
      if (createdCount > 0) {
        try {
          await refreshHistory(true);
        } catch {
          /* Preserve the primary batch error message. */
        }
        app.emit('mini-bench:observations-changed');
        notify(`部分保存基线失败（已保存 ${createdCount} 个）：${error.message}`, true);
      } else {
        notify(`保存基线失败：${error.message}`, true);
      }
    } finally {
      baselineBusy.delete(scopeKey);
      renderDetails();
    }
  }
  async function demoteBaselines(scopeKey, ids) {
    const uniqueIds = [...new Set((ids || []).filter(id => typeof id === 'string' && id))];
    if (!scopeKey || baselineBusy.has(scopeKey) || !uniqueIds.length) return;
    baselineBusy.add(scopeKey);
    renderDetails();
    let deletedCount = 0;
    try {
      if (uniqueIds.length === 1) {
        await request(`./api/bench/baselines/${encodeURIComponent(uniqueIds[0])}/delete`, { method: 'POST' });
        deletedCount = 1;
      } else {
        for (const chunk of chunkList(uniqueIds, BASELINE_BATCH_LIMIT)) {
          const result = await request('./api/bench/baselines/batch', {
            method: 'POST',
            body: JSON.stringify({ action: 'delete', ids: chunk })
          });
          deletedCount += Array.isArray(result?.deleted) ? result.deleted.length : chunk.length;
        }
      }
      await refreshHistory(true);
      app.emit('mini-bench:observations-changed');
      notify(deletedCount > 1 ? `已取消 ${deletedCount} 份基线标记，原始运行记录已保留。` : '已取消该基线标记，原始运行记录已保留。');
    } catch (error) {
      if (deletedCount > 0) {
        try {
          await refreshHistory(true);
        } catch {
          /* Preserve the primary batch error message. */
        }
        app.emit('mini-bench:observations-changed');
        notify(`部分取消基线失败（已取消 ${deletedCount} 份）：${error.message}`, true);
      } else {
        notify(`取消基线失败：${error.message}`, true);
      }
    } finally {
      baselineBusy.delete(scopeKey);
      renderDetails();
    }
  }
  let reasonPopover = null;
  let reasonAnchor = null;
  function closeBaselineReasonPopover() {
    if (reasonPopover) reasonPopover.hidden = true;
    reasonAnchor = null;
  }
  function showBaselineIneligibleHint(anchor, reason) {
    const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim() : '当前不符合基线校验条件';
    notify(`不可设为基线：${cleanReason}`);
    if (typeof document === 'undefined' || !anchor?.getBoundingClientRect) return;
    if (reasonPopover && !reasonPopover.hidden && reasonAnchor === anchor) {
      closeBaselineReasonPopover();
      return;
    }
    if (!reasonPopover) {
      reasonPopover = document.createElement('div');
      reasonPopover.id = 'baseline-reason-popover';
      reasonPopover.className = 'baseline-reason-popover';
      reasonPopover.setAttribute('role', 'status');
      reasonPopover.setAttribute('aria-live', 'polite');
      reasonPopover.hidden = true;
      document.body.append(reasonPopover);
    }
    reasonAnchor = anchor;
    reasonPopover.replaceChildren();
    const headEl = document.createElement('div');
    headEl.className = 'baseline-reason-head';
    const titleEl = document.createElement('strong');
    titleEl.textContent = '不可设为基线';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'baseline-reason-close';
    closeBtn.setAttribute('aria-label', '关闭提示');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      const prev = reasonAnchor;
      closeBaselineReasonPopover();
      prev?.focus?.({ preventScroll: true });
    });
    headEl.append(titleEl, closeBtn);
    const bodyEl = document.createElement('p');
    bodyEl.textContent = cleanReason;
    reasonPopover.append(headEl, bodyEl);
    reasonPopover.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const popRect = reasonPopover.getBoundingClientRect();
    const margin = 12;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const left = Math.min(vw - popRect.width - margin, Math.max(margin, rect.left + rect.width / 2 - popRect.width / 2));
    const below = rect.bottom + 8;
    const top = below + popRect.height <= vh - margin ? below : Math.max(margin, rect.top - popRect.height - 8);
    reasonPopover.style.left = `${Math.round(left)}px`;
    reasonPopover.style.top = `${Math.round(top)}px`;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', event => {
      if (!reasonPopover || reasonPopover.hidden) return;
      const target = /** @type {Node | null} */ (event.target);
      if (reasonPopover.contains(target) || reasonAnchor?.contains?.(target)) return;
      closeBaselineReasonPopover();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !reasonPopover || reasonPopover.hidden) return;
      const prev = reasonAnchor;
      closeBaselineReasonPopover();
      prev?.focus?.({ preventScroll: true });
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('scroll', closeBaselineReasonPopover, true);
    window.addEventListener('resize', closeBaselineReasonPopover);
  }
  const activeTaskRecord = () =>
    state.taskDetail?.id === state.selectedTaskId ? state.taskDetail : state.tasks.find(task => task.id === state.selectedTaskId);
  element('bench-run-list').addEventListener('click', async event => {
    const path = event.composedPath?.() || [];
    // Rendering can detach the clicked button before this ancestor receives the same event.
    if ([taskSection, runSection].some(section => path.includes(section) || section.contains?.(event.target))) return;
    const task = event.target.closest('[data-bench-task-id]'),
      run = event.target.closest('[data-bench-run-id]');
    if (task) await toggleAssessmentTask(task.dataset.benchTaskId);
    else if (run) await toggleAssessmentRun(run.dataset.benchRunId);
  });
  element('bench-task-detail').addEventListener('click', async event => {
    if (event.composedPath?.().includes(runSection) || runSection.contains?.(event.target)) return;
    const ineligibleBtn = event.target.closest('[data-baseline-ineligible-reason]');
    if (ineligibleBtn) {
      showBaselineIneligibleHint(ineligibleBtn, ineligibleBtn.dataset.baselineIneligibleReason);
      return;
    }
    const promoteBtn = event.target.closest('[data-baseline-promote-runs]');
    if (promoteBtn) {
      closeBaselineReasonPopover();
      const task = activeTaskRecord();
      const runIdSet = new Set((promoteBtn.dataset.baselinePromoteRuns || '').split(',').filter(Boolean));
      const items = (task?.children || [])
        .filter(
          child => runIdSet.has(child.run_id) && !inProgress(child) && child.baseline_eligible && !child.baseline_id && child.target?.id
        )
        .map(child => ({ run_id: child.run_id, target_id: child.target.id }));
      await promoteRunsToBaseline(promoteBtn.dataset.baselineScope || `scope-promote:${task?.id || ''}`, items);
      return;
    }
    const demoteBtn = event.target.closest('[data-baseline-demote-ids]');
    if (demoteBtn) {
      closeBaselineReasonPopover();
      const ids = (demoteBtn.dataset.baselineDemoteIds || '').split(',').filter(Boolean);
      await demoteBaselines(demoteBtn.dataset.baselineScope || `scope-demote:${state.selectedTaskId || ''}`, ids);
      return;
    }
    const cancel = event.target.closest('[data-cancel-child]');
    if (cancel) {
      await cancelExecution('run', cancel.dataset.cancelChild);
      return;
    }
    const run = event.target.closest('[data-preview-run-id], [data-bench-run-id], [data-child-run-id]');
    if (run) await toggleAssessmentRun(run.dataset.previewRunId || run.dataset.benchRunId || run.dataset.childRunId);
  });
  element('bench-baseline-task')?.addEventListener?.('click', event => {
    const btn = /** @type {HTMLElement} */ (event.currentTarget || element('bench-baseline-task'));
    const reason = btn?.dataset?.baselineIneligibleReason;
    if (btn?.getAttribute?.('aria-disabled') === 'true' || reason) {
      showBaselineIneligibleHint(btn, reason);
      return;
    }
    closeBaselineReasonPopover();
    const task = activeTaskRecord();
    if (!task) return;
    const items = (task.children || [])
      .filter(child => !inProgress(child) && child.baseline_eligible && !child.baseline_id && child.target?.id)
      .map(child => ({ run_id: child.run_id, target_id: child.target.id }));
    return promoteRunsToBaseline(`task-promote:${task.id}`, items);
  });
  element('bench-unbaseline-task')?.addEventListener?.('click', () => {
    closeBaselineReasonPopover();
    const task = activeTaskRecord();
    if (!task) return;
    const ids = (task.children || []).map(child => child.baseline_id).filter(Boolean);
    return demoteBaselines(`task-demote:${task.id}`, ids);
  });
  element('bench-baseline-run')?.addEventListener?.('click', event => {
    const btn = /** @type {HTMLElement} */ (event.currentTarget || element('bench-baseline-run'));
    const reason = btn?.dataset?.baselineIneligibleReason;
    if (btn?.getAttribute?.('aria-disabled') === 'true' || reason) {
      showBaselineIneligibleHint(btn, reason);
      return;
    }
    closeBaselineReasonPopover();
    const run = state.runDetail?.id === state.selectedRunId ? state.runDetail : findRunSummary(state.selectedRunId);
    const runId = state.selectedRunId;
    if (!run || !runId || inProgress(run)) return;
    const items = (runBaselineTargets ? runBaselineTargets(run) : [])
      .filter(item => item.baseline_eligible && !item.baseline_id && item.target_id)
      .map(item => ({ run_id: runId, target_id: item.target_id }));
    return promoteRunsToBaseline(`run-promote:${runId}`, items);
  });
  element('bench-unbaseline-run')?.addEventListener?.('click', () => {
    closeBaselineReasonPopover();
    const run = state.runDetail?.id === state.selectedRunId ? state.runDetail : findRunSummary(state.selectedRunId);
    const runId = state.selectedRunId;
    if (!run || !runId) return;
    const ids = (runBaselineTargets ? runBaselineTargets(run) : []).map(item => item.baseline_id).filter(Boolean);
    return demoteBaselines(`run-demote:${runId}`, ids);
  });
  element('bench-cancel-task').addEventListener('click', () => cancelExecution('task', state.selectedTaskId));
  element('bench-cancel-run').addEventListener('click', () => cancelExecution('run', state.selectedRunId));
  app.on('mini-bench:baselines-changed', () => refreshHistory(true));
  // Selection belongs to one bank version; switching versions drops selections from the other bank.
  let suppressBankAutoSelect = false;
  function runBankVersion(runId) {
    if (!runId) return null;
    const parent = state.tasks.find(task => task.children?.some(child => child.run_id === runId));
    const standalone = state.runs.find(run => run.id === runId);
    const detail = state.runDetail?.id === runId ? state.runDetail : null;
    return (
      recordBankVersion(findRunSummary(runId)) ?? recordBankVersion(parent) ?? recordBankVersion(standalone) ?? recordBankVersion(detail)
    );
  }
  function selectedHistoryRecord() {
    if (state.selectedTaskId)
      return findTaskSummary(state.selectedTaskId) || (state.taskDetail?.id === state.selectedTaskId ? state.taskDetail : null);
    if (!state.selectedRunId) return null;
    const runId = state.selectedRunId;
    return (
      state.tasks.find(task => task.children?.some(child => child.run_id === runId)) ||
      state.runs.find(run => run.id === runId) ||
      (state.runDetail?.id === runId ? state.runDetail : null)
    );
  }
  app.on('mini-bench:banks-changed', event => {
    closeBaselineReasonPopover();
    const version = event.detail?.version ?? null;
    const hasSelection = Boolean(state.selectedTaskId || state.selectedRunId);
    if (hasSelection && !matchesBankVersion(selectedHistoryRecord(), version)) {
      pendingRevealRunId = null;
      state.selectionVersion++;
      state.selectedTaskId = null;
      state.selectedRunId = null;
      state.taskDetail = null;
      state.runDetail = null;
    }
    if (!suppressBankAutoSelect && !element('runs-view')?.hidden && !state.historyClosed && !state.selectedTaskId && !state.selectedRunId) {
      const first = historyEntries()[0];
      if (first?.kind === 'task') void selectAssessmentTask(first.record.id);
      else if (first) void selectAssessmentRun(first.record.id);
    }
    renderDetails();
  });
  app.on('mini-bench:select-run', event => {
    closeBaselineReasonPopover();
    const runVersion = runBankVersion(event.detail);
    if (runVersion && runVersion !== app.bank?.version && state.banks.some(bank => bank?.version === runVersion)) {
      suppressBankAutoSelect = true;
      try {
        selectBankVersion(runVersion);
      } finally {
        suppressBankAutoSelect = false;
      }
    }
    pendingRevealRunId = event.detail;
    return selectAssessmentRun(event.detail, { allowBankSwitch: true });
  });
  app.on('mini-bench:view', event => {
    closeBaselineReasonPopover();
    if (event.detail !== 'runs') return;
    if (!state.historyClosed && !state.selectedTaskId && !state.selectedRunId) {
      const first = historyEntries()[0];
      if (first?.kind === 'task') void selectAssessmentTask(first.record.id);
      else if (first) void selectAssessmentRun(first.record.id);
    }
    revealSelectedRun();
  });
  app.on('mini-bench:recorded-banks-changed', event => {
    const firstObservations = event.detail?.source === 'observations' && !state.observationsBankChecked;
    if (firstObservations) state.observationsBankChecked = true;
    if (!state.banks.length || !state.selectedBankVersion) return;
    if (firstObservations) {
      reconcileDefaultBank();
      return;
    }
    renderVersionSwitcher();
  });
  app.on('mini-bench:refresh', load);
  updateTaskPreview();
  if (available) load();
})();
