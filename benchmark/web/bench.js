import { getAppContext } from './app-context.js';
import { createTaskTargets } from './runs.js';
import { createTaskHistoryView } from './task-history-view.js';
import { createTaskSubmission } from './task-submission.js';

(() => {
  'use strict';
  const app = getAppContext();
  const { request, notify, available } = app.services;
  createTaskTargets(app);
  const state = { banks: [], submissionUncertain: false, tasks: [], runs: [], selectedTaskId: null, selectedRunId: null, taskDetail: null, runDetail: null, selectionVersion: 0, timer: null, busy: false, refreshing: null, cancelling: new Set() };
  const retryRequests = new Map(), retrying = new Set();
  const { element, historyEntries, renderDetails, inProgress, canCancel, fixedTargets, taskSection, runSection } = createTaskHistoryView({ app, state, retryRequests, retrying });
  const { updateTaskPreview, renderBanks } = createTaskSubmission({ app, state, element, fixedTargets, inProgress, renderDetails, refreshHistory, retryRequests, retrying });
  function schedulePolling() {
    clearTimeout(state.timer); state.timer = null;
    if ([...state.tasks, ...state.runs].some(inProgress)) state.timer = setTimeout(() => refreshHistory(), 2000);
  }
  async function refreshHistory(forceFresh = false) {
    if (state.refreshing) {
      await state.refreshing;
      if (forceFresh) return refreshHistory();
      return;
    }
    state.refreshing = (async () => {
      const previous = new Map([...state.tasks, ...state.runs].map(record => [record.id, record.status]));
      try {
        const [tasks, runs] = await Promise.all([request('./api/bench/tasks'), request('./api/bench/runs')]);
        if (!Array.isArray(tasks.tasks) || !Array.isArray(runs.runs)) throw new Error('任务或运行记录格式无效');
        state.tasks = tasks.tasks; state.runs = runs.runs;
        app.setHistory(state.tasks);
        if (!state.historyClosed && !state.selectedTaskId && !state.selectedRunId) {
          const first = historyEntries()[0];
          if (first?.kind === 'task') state.selectedTaskId = first.record.id;
          else if (first) state.selectedRunId = first.record.id;
        }
        const taskId = state.selectedTaskId, runId = state.selectedRunId, version = state.selectionVersion;
        const [task, run] = await Promise.all([taskId ? request(`./api/bench/tasks/${encodeURIComponent(taskId)}`) : null, runId ? request(`./api/bench/runs/${encodeURIComponent(runId)}`) : null]);
        if (version === state.selectionVersion) { state.taskDetail = task; state.runDetail = run; }
        renderDetails();
        if ([...state.tasks, ...state.runs].some(record => previous.has(record.id) && previous.get(record.id) !== record.status)) app.emit('mini-bench:observations-changed');
      } catch (error) { notify(`无法加载任务与运行记录：${error.message}`, true); }
      finally { state.refreshing = null; schedulePolling(); }
    })();
    return state.refreshing;
  }
  async function load(event) {
    if (!available) return;
    const refresh = event?.type === 'mini-bench:refresh';
    try {
      const data = await request('./api/bench/banks');
      if (!Array.isArray(data.banks)) throw new Error('题库目录格式无效');
      state.timeoutPolicyReady = data.execution_policy === 'sample-timeout-v1';
      state.banks = data.banks; renderBanks();
      if (!state.timeoutPolicyReady) notify('服务仍在执行旧任务，更新完成前暂不接收新任务。', true);
    } catch (error) { notify(`无法加载 Mini Bench 题库：${error.message}`, true); }
    try {
      const data = await request(`./api/bench/routes${refresh ? '?refresh=1' : ''}`);
      if (!Array.isArray(data.routes)) throw new Error('路由目录格式无效');
      app.setTaskRoutes(data.routes); app.emit('mini-bench:routes-changed');
    } catch (error) { notify(`无法加载路由目录：${error.message}`, true); }
    await refreshHistory();
  }
  function closeAssessmentTask() {
    state.selectionVersion++; state.historyClosed = true; state.selectedTaskId = null; state.selectedRunId = null; state.taskDetail = null; state.runDetail = null; renderDetails();
  }
  function closeAssessmentRun() {
    state.selectionVersion++; state.historyClosed = true; state.selectedRunId = null; state.runDetail = null; renderDetails();
  }
  const toggleAssessmentTask = taskId => state.selectedTaskId === taskId ? closeAssessmentTask() : selectAssessmentTask(taskId);
  const toggleAssessmentRun = runId => state.selectedRunId === runId ? closeAssessmentRun() : selectAssessmentRun(runId);
  function focusHistoryCard(attribute, id) {
    const trigger = [...(element('bench-run-list').querySelectorAll?.(`[${attribute}]`) || [])].find(node => node.getAttribute(attribute) === id);
    trigger?.focus({ preventScroll: true });
  }
  element('bench-close-task').addEventListener('click', () => { const id = state.selectedTaskId; closeAssessmentTask(); focusHistoryCard('data-bench-task-id', id); });
  element('bench-close-run').addEventListener('click', () => { const id = state.selectedRunId; closeAssessmentRun(); focusHistoryCard('data-bench-run-id', id); });
  async function selectAssessmentTask(taskId) {
    const version = ++state.selectionVersion;
    state.historyClosed = false;
    state.selectedTaskId = taskId; state.selectedRunId = null; state.taskDetail = null; state.runDetail = null; renderDetails();
    try {
      const task = await request(`./api/bench/tasks/${encodeURIComponent(taskId)}`);
      if (version !== state.selectionVersion) return;
      state.taskDetail = task; renderDetails();
    } catch (error) { if (version === state.selectionVersion) notify(`无法加载任务详情：${error.message}`, true); }
  }
  async function selectAssessmentRun(runId) {
    if (state.selectedRunId === runId && state.runDetail?.id === runId) return;
    const version = ++state.selectionVersion;
    state.historyClosed = false;
    state.selectedRunId = runId; state.runDetail = null;
    const parent = state.tasks.find(task => task.children?.some(child => child.run_id === runId));
    state.selectedTaskId = parent?.id || null; state.taskDetail = parent || null; renderDetails();
    try {
      const run = await request(`./api/bench/runs/${encodeURIComponent(runId)}`);
      if (version !== state.selectionVersion) return;
      state.runDetail = run; state.selectedTaskId = run.task_id || parent?.id || null;
      if (state.selectedTaskId) {
        const task = await request(`./api/bench/tasks/${encodeURIComponent(state.selectedTaskId)}`);
        if (version !== state.selectionVersion) return;
        state.taskDetail = task;
      }
      renderDetails();
    } catch (error) { if (version === state.selectionVersion) notify(`无法加载运行详情：${error.message}`, true); }
  }
  async function cancelExecution(kind, id) {
    if (!id || state.cancelling.has(`${kind}:${id}`)) return;
    const record = kind === 'task' ? state.taskDetail || state.tasks.find(task => task.id === id) : state.runDetail?.id === id ? state.runDetail : state.taskDetail?.children?.find(child => child.run_id === id) || state.runs.find(run => run.id === id);
    if (!canCancel(record)) return;
    const key = `${kind}:${id}`; state.cancelling.add(key); renderDetails();
    try {
      await request(`./api/bench/${kind === 'task' ? 'tasks' : 'runs'}/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      await refreshHistory(true); notify(kind === 'task' ? '已请求取消整个任务及未完成运行。' : '已请求取消该运行，其他运行不受影响。');
    } catch (error) { notify(`取消失败：${error.message}`, true); }
    finally { state.cancelling.delete(key); renderDetails(); }
  }
  element('bench-run-list').addEventListener('click', async event => {
    const path = event.composedPath?.() || [];
    // Rendering can detach the clicked button before this ancestor receives the same event.
    if ([taskSection, runSection].some(section => path.includes(section) || section.contains?.(event.target))) return;
    const task = event.target.closest('[data-bench-task-id]'), run = event.target.closest('[data-bench-run-id]');
    if (task) await toggleAssessmentTask(task.dataset.benchTaskId);
    else if (run) await toggleAssessmentRun(run.dataset.benchRunId);
  });
  element('bench-task-detail').addEventListener('click', async event => {
    if (event.composedPath?.().includes(runSection) || runSection.contains?.(event.target)) return;
    const cancel = event.target.closest('[data-cancel-child]');
    if (cancel) { await cancelExecution('run', cancel.dataset.cancelChild); return; }
    const run = event.target.closest('[data-bench-run-id], [data-child-run-id]');
    if (run) await toggleAssessmentRun(run.dataset.benchRunId || run.dataset.childRunId);
  });
  element('bench-cancel-task').addEventListener('click', () => cancelExecution('task', state.selectedTaskId));
  element('bench-cancel-run').addEventListener('click', () => cancelExecution('run', state.selectedRunId));
  app.on('mini-bench:select-run', event => selectAssessmentRun(event.detail));
  app.on('mini-bench:refresh', load);
  updateTaskPreview();
  if (available) load();
})();
