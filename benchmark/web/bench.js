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
    retrying = new Set();
  let pendingRevealRunId = null;
  let pendingForceFresh = false;
  const { element, historyEntries, renderDetails, inProgress, canCancel, fixedTargets, taskSection, runSection } = createTaskHistoryView({
    app,
    state,
    retryRequests,
    retrying
  });
  const { updateTaskPreview, renderBanks } = createTaskSubmission({
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
  const detailUnchanged = (detail, summary) =>
    Boolean(
      detail &&
      summary &&
      !inProgress(summary) &&
      !inProgress(detail) &&
      detail.status === summary.status &&
      detail.updated_at !== undefined &&
      detail.updated_at === summary.updated_at
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
    const loadBanks = async () => {
      try {
        const data = await request('./api/bench/banks');
        if (!Array.isArray(data.banks)) throw new Error('题库目录格式无效');
        state.timeoutPolicyReady = data.execution_policy === 'sample-timeout-v1';
        state.banks = data.banks;
        renderBanks();
        if (!state.timeoutPolicyReady) notify('服务仍在执行旧任务，更新完成前暂不接收新任务。', true);
      } catch (error) {
        notify(`无法加载 Mini Bench 题库：${error.message}`, true);
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
    await Promise.all([loadBanks(), loadRoutes(), refreshHistory(refresh)]);
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
      state.taskDetail = task;
      renderDetails();
    } catch (error) {
      if (version === state.selectionVersion) notify(`无法加载任务详情：${error.message}`, true);
    }
  }
  async function selectAssessmentRun(runId) {
    if (state.selectedRunId === runId && state.runDetail?.id === runId) {
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
    const cancel = event.target.closest('[data-cancel-child]');
    if (cancel) {
      await cancelExecution('run', cancel.dataset.cancelChild);
      return;
    }
    const run = event.target.closest('[data-preview-run-id], [data-bench-run-id], [data-child-run-id]');
    if (run) await toggleAssessmentRun(run.dataset.previewRunId || run.dataset.benchRunId || run.dataset.childRunId);
  });
  element('bench-cancel-task').addEventListener('click', () => cancelExecution('task', state.selectedTaskId));
  element('bench-cancel-run').addEventListener('click', () => cancelExecution('run', state.selectedRunId));
  app.on('mini-bench:select-run', event => {
    pendingRevealRunId = event.detail;
    return selectAssessmentRun(event.detail);
  });
  app.on('mini-bench:view', event => {
    if (event.detail !== 'runs') return;
    if (!state.historyClosed && !state.selectedTaskId && !state.selectedRunId) {
      const first = historyEntries()[0];
      if (first?.kind === 'task') void selectAssessmentTask(first.record.id);
      else if (first) void selectAssessmentRun(first.record.id);
    }
    revealSelectedRun();
  });
  app.on('mini-bench:refresh', load);
  updateTaskPreview();
  if (available) load();
})();
