import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture() {
    const nodes = new Map(),
        events = new Map(),
        requests = [],
        notices = [];
    const element = id => {
        if (!nodes.has(id))
            nodes.set(id, {
                handlers: new Map(),
                addEventListener(name, handler) {
                    this.handlers.set(name, handler);
                },
                contains: () => false
            });
        return nodes.get(id);
    };
    const target = { model: 'model' };
    const tasks = [
        {
            id: 'task',
            status: 'completed',
            children: [
                { run_id: 'child', target, status: 'completed' },
                { run_id: 'other', target, status: 'completed' }
            ]
        }
    ];
    const runs = ['child', 'other', 'legacy'].map(id => ({
        id,
        ...(id === 'legacy' ? {} : { task_id: 'task' }),
        status: 'completed',
        samples: []
    }));
    let state,
        refreshHistory,
        renders = 0,
        defer;
    const app = {
        services: {
            available: true,
            notify: message => notices.push(message),
            request: async path => {
                requests.push(path);
                const basePath = path.split('?')[0];
                if (defer?.path === path || defer?.path === basePath) return defer.promise;
                if (basePath.endsWith('/banks')) return { banks: [], execution_policy: 'sample-timeout-v1' };
                if (basePath.endsWith('/routes')) return { routes: [] };
                if (basePath.endsWith('/tasks')) return { tasks };
                if (basePath.endsWith('/runs')) return { runs };
                return tasks.find(task => basePath.endsWith('/tasks/' + task.id)) || runs.find(run => basePath.endsWith('/runs/' + run.id));
            }
        },
        on: (name, handler) => events.set(name, handler),
        emit() {},
        setHistory() {},
        setTaskRoutes() {}
    };
    const context = vm.createContext({
        getAppContext: () => app,
        createTaskTargets() {},
        createTaskHistoryView: options => {
            state = options.state;
            return {
                element,
                historyEntries: () => tasks.map(record => ({ kind: 'task', record })),
                renderDetails: () => renders++,
                inProgress: () => false,
                canCancel: () => false,
                fixedTargets: () => [],
                taskSection: element('task-section'),
                runSection: element('run-section')
            };
        },
        createTaskSubmission: options => {
            refreshHistory = options.refreshHistory;
            return { updateTaskPreview() {}, renderBanks() {} };
        },
        clearTimeout() {},
        setTimeout() {
            throw Error('Completed fixture must not poll');
        }
    });
    vm.runInContext(
        readFileSync(new URL('../web/bench.js', import.meta.url), 'utf8')
            .replace(/^import .*;\n/gm, '')
            .replace('if (available) load();', ''),
        context
    );
    const click = (container, dataset, path = []) =>
        element(container).handlers.get('click')({
            composedPath: () => path.map(element),
            target: {
                closest: selector =>
                    (selector.includes('data-bench-task-id') && dataset.benchTaskId) ||
                    (selector.includes('data-bench-run-id') && dataset.benchRunId) ||
                    (selector.includes('data-child-run-id') && dataset.childRunId) ||
                    (selector.includes('data-cancel-child') && dataset.cancelChild)
                        ? { dataset }
                        : null
            }
        });
    return {
        state,
        requests,
        notices,
        element,
        click,
        refresh: () => events.get('mini-bench:refresh')(),
        refreshHistory: forceFresh => refreshHistory(forceFresh),
        select: id => events.get('mini-bench:select-run')({ detail: id }),
        emitView: view => events.get('mini-bench:view')?.({ detail: view }),
        defer(path) {
            let resolve;
            const promise = new Promise(done => {
                resolve = done;
            });
            defer = { path, promise };
            return resolve;
        },
        renders: () => renders
    };
}

test('history card clicks toggle while imperative run selection always opens', async () => {
    const f = fixture();
    await f.refresh();
    expect(f.state.selectedTaskId).toBe('task');
    await f.click('bench-run-list', { benchTaskId: 'task' });
    expect(f.state.selectedTaskId).toBeNull();
    await f.refresh();
    expect(f.state.selectedTaskId).toBeNull();
    await f.click('bench-run-list', { benchTaskId: 'task' });
    await f.click('bench-task-detail', { childRunId: 'child' });
    expect(f.state.selectedRunId).toBe('child');
    await f.click('bench-task-detail', { childRunId: 'child' });
    expect(f.state.selectedRunId).toBeNull();
    expect(f.state.selectedTaskId).toBe('task');
    await f.select('child');
    await f.select('child');
    expect(f.state.selectedRunId).toBe('child');
    await f.click('bench-task-detail', { benchRunId: 'other' });
    expect(f.state.selectedRunId).toBe('other');
    await f.click('bench-run-list', { benchRunId: 'legacy' });
    expect(f.state.selectedTaskId).toBeNull();
    expect(f.state.selectedRunId).toBe('legacy');
    await f.click('bench-run-list', { benchRunId: 'legacy' });
    expect(f.state.selectedRunId).toBeNull();
    expect(f.notices).toEqual([]);
});

test('collapsing a loading card invalidates its late response and polling cannot reopen it', async () => {
    const f = fixture();
    await f.refresh();
    const resolve = f.defer('./api/bench/runs/child');
    const opening = f.click('bench-task-detail', { benchRunId: 'child' });
    expect(f.state.selectedRunId).toBe('child');
    await f.click('bench-task-detail', { benchRunId: 'child' });
    resolve({ id: 'child', task_id: 'task', status: 'completed' });
    await opening;
    expect(f.state.selectedRunId).toBeNull();
    expect(f.state.runDetail).toBeNull();
    await f.refresh();
    expect(f.state.selectedRunId).toBeNull();
    const resolveTask = f.defer('./api/bench/tasks/missing-task');
    const pendingTask = f.click('bench-run-list', { benchTaskId: 'missing-task' });
    await f.click('bench-run-list', { benchTaskId: 'missing-task' });
    resolveTask({ id: 'missing-task', status: 'completed', children: [] });
    await pendingTask;
    expect(f.state.selectedTaskId).toBeNull();
    expect(f.state.taskDetail).toBeNull();
    await f.refresh();
    expect(f.state.selectedTaskId).toBeNull();
});

test('history bubbling ignores child clicks even when rendering detached the original target', async () => {
    const f = fixture();
    await f.refresh();
    await f.click('bench-task-detail', { benchRunId: 'child' });
    expect(f.state.selectedRunId).toBe('child');
    await f.click('bench-run-list', { benchRunId: 'child' }, ['task-section']);
    expect(f.state.selectedRunId).toBe('child');
    await f.click('bench-task-detail', { benchRunId: 'child' });
    expect(f.state.selectedRunId).toBeNull();
    await f.click('bench-run-list', { benchRunId: 'child' }, ['task-section']);
    expect(f.state.selectedRunId).toBeNull();
});

test('switching cards rejects stale child responses and cancel actions do not toggle', async () => {
    const f = fixture();
    await f.refresh();
    const resolve = f.defer('./api/bench/runs/child');
    const pending = f.click('bench-task-detail', { childRunId: 'child' });
    await f.click('bench-task-detail', { childRunId: 'other' });
    resolve({ id: 'child', task_id: 'task' });
    await pending;
    expect(f.state.selectedRunId).toBe('other');
    expect(f.state.runDetail.id).toBe('other');
    await f.click('bench-task-detail', { childRunId: 'other', cancelChild: 'other' });
    expect(f.state.selectedRunId).toBe('other');
    expect(f.requests.some(path => path.endsWith('/cancel'))).toBe(false);
});

test('jumping to a run waits for runs-view visibility and loaded details, clears blocking filters, and scrolls target into view', async () => {
    const f = fixture();
    await f.refresh();
    const scrolled = [];
    const previewGroup = { scrollIntoView: opts => scrolled.push({ target: 'preview-group', opts }) };
    const runSection = f.element('run-section');
    runSection.closest = selector => (selector === '.task-preview-group' ? previewGroup : null);
    runSection.scrollIntoView = opts => scrolled.push({ target: 'run-section', opts });
    f.element('runs-view').hidden = true;
    f.element('history-search').value = 'unrelated-query';
    f.element('history-status').value = 'failed';

    // Select while runs-view is still hidden (before hashchange completes): should not scroll yet.
    await f.select('child');
    expect(scrolled).toEqual([]);

    // Once runs-view becomes visible via mini-bench:view, blocking filters clear and preview group scrolls into view.
    f.element('runs-view').hidden = false;
    f.emitView('runs');
    expect(f.element('history-search').value).toBe('');
    expect(f.element('history-status').value).toBe('all');
    expect(scrolled).toEqual([{ target: 'preview-group', opts: { block: 'start' } }]);

    // Re-jumping to an already selected run still scrolls once runs-view becomes visible again.
    f.element('runs-view').hidden = true;
    await f.select('child');
    expect(scrolled).toHaveLength(1);
    f.element('runs-view').hidden = false;
    f.emitView('runs');
    expect(scrolled).toHaveLength(2);
});

test('background polling skips refetching unchanged terminal task and run details while explicit refresh still refetches', async () => {
    const f = fixture();
    await f.refresh();
    // Stamp updated_at so terminal detail records can be recognized as unchanged.
    f.state.tasks[0].updated_at = '2026-11-20T00:00:00.000Z';
    f.state.tasks[0].children[0].updated_at = '2026-11-20T00:00:00.000Z';
    f.state.tasks[0].children[1].updated_at = '2026-11-20T00:00:00.000Z';
    await f.select('child');
    f.state.taskDetail.updated_at = '2026-11-20T00:00:00.000Z';
    f.state.runDetail.updated_at = '2026-11-20T00:00:00.000Z';
    const before = f.requests.length;

    // Non-forced history refresh skips refetching unchanged terminal task/run details.
    await f.refreshHistory(false);
    expect(f.requests.slice(before)).toEqual(['./api/bench/tasks', './api/bench/runs']);

    // Explicit refresh (forceFresh) still refetches the selected run with omit_provenance=1,
    // while reusing the freshly fetched parent task summary from /api/bench/tasks.
    const beforeForced = f.requests.length;
    await f.refreshHistory(true);
    expect(f.requests.slice(beforeForced)).toEqual(['./api/bench/tasks', './api/bench/runs', './api/bench/runs/child?omit_provenance=1']);
});

test('selecting a child run under an active task skips task detail refetch, deduplicates polling, and caches terminal runs', async () => {
    const f = fixture();
    await f.refresh();
    f.state.tasks[0].status = 'running';
    f.state.tasks[0].updated_at = '2026-11-22T01:00:00.000Z';
    f.state.tasks[0].children[0].updated_at = '2026-11-22T01:00:00.000Z';
    f.state.tasks[0].children[1].updated_at = '2026-11-22T01:00:00.000Z';

    // In-flight child selection must not trigger a parent /tasks/:id request,
    // and concurrent polling must reuse the in-flight /runs/:id request instead of duplicating it.
    const beforeSelect = f.requests.length;
    const resolveChild = f.defer('./api/bench/runs/child?omit_provenance=1');
    const opening = f.click('bench-task-detail', { childRunId: 'child' });
    const polling = f.refreshHistory(false);
    await Promise.resolve();
    expect(f.requests.slice(beforeSelect).filter(path => path.includes('/tasks/task'))).toEqual([]);
    expect(f.requests.slice(beforeSelect).filter(path => path.includes('/runs/child'))).toEqual([
        './api/bench/runs/child?omit_provenance=1'
    ]);
    resolveChild({ id: 'child', task_id: 'task', status: 'completed', updated_at: '2026-11-22T01:00:00.000Z', samples: [] });
    await Promise.all([opening, polling]);
    expect(f.state.runDetail.id).toBe('child');

    // Switching away and back to an unchanged terminal child serves immediately from the local cache.
    const resolveOther = f.defer('./api/bench/runs/other?omit_provenance=1');
    const openOther = f.click('bench-task-detail', { childRunId: 'other' });
    resolveOther({ id: 'other', task_id: 'task', status: 'completed', updated_at: '2026-11-22T01:00:00.000Z', samples: [] });
    await openOther;
    const beforeCachedReopen = f.requests.length;
    await f.click('bench-task-detail', { childRunId: 'child' });
    expect(f.requests.slice(beforeCachedReopen)).toEqual([]);
    expect(f.state.runDetail.id).toBe('child');

    // Updating updated_at invalidates the terminal run cache on next open.
    f.state.tasks[0].children[0].updated_at = '2026-11-22T02:00:00.000Z';
    await f.click('bench-task-detail', { childRunId: 'other' });
    const beforeInvalidated = f.requests.length;
    const resolveRefreshed = f.defer('./api/bench/runs/child?omit_provenance=1');
    const reopenInvalidated = f.click('bench-task-detail', { childRunId: 'child' });
    resolveRefreshed({ id: 'child', task_id: 'task', status: 'completed', updated_at: '2026-11-22T02:00:00.000Z', samples: [] });
    await reopenInvalidated;
    expect(f.requests.slice(beforeInvalidated)).toEqual(['./api/bench/runs/child?omit_provenance=1']);
});

test('terminal child run cache matches scalar child summary against run detail baseline_targets and invalidates on baseline change', async () => {
    const f = fixture();
    await f.refresh();
    const ts = '2026-11-25T06:00:00.000Z';
    f.state.tasks[0].updated_at = ts;
    f.state.tasks[0].children[0] = {
        run_id: 'child',
        target: { id: 'target-a', model: 'model' },
        status: 'completed',
        updated_at: ts,
        baseline_eligible: true,
        ineligibility_reason: null,
        baseline_id: null
    };
    f.state.tasks[0].children[1] = {
        run_id: 'other',
        target: { id: 'target-b', model: 'model' },
        status: 'completed',
        updated_at: ts,
        baseline_eligible: true,
        ineligibility_reason: null,
        baseline_id: null
    };

    const resolveChild = f.defer('./api/bench/runs/child?omit_provenance=1');
    const openChild = f.click('bench-task-detail', { childRunId: 'child' });
    resolveChild({
        id: 'child',
        task_id: 'task',
        status: 'completed',
        updated_at: ts,
        baseline_eligible: true,
        ineligibility_reason: null,
        baseline_id: null,
        baseline_targets: [{ target_id: 'target-a', baseline_eligible: true, ineligibility_reason: null, baseline_id: null }],
        samples: []
    });
    await openChild;

    // Background polling must not refetch the unchanged terminal child detail.
    const beforePoll = f.requests.length;
    await f.refreshHistory(false);
    expect(f.requests.slice(beforePoll)).toEqual(['./api/bench/tasks', './api/bench/runs']);

    // Switching away and reopening must hit the terminal run cache.
    const resolveOther = f.defer('./api/bench/runs/other?omit_provenance=1');
    const openOther = f.click('bench-task-detail', { childRunId: 'other' });
    resolveOther({
        id: 'other',
        task_id: 'task',
        status: 'completed',
        updated_at: ts,
        baseline_targets: [{ target_id: 'target-b', baseline_eligible: true, ineligibility_reason: null, baseline_id: null }],
        samples: []
    });
    await openOther;
    const beforeReopen = f.requests.length;
    await f.click('bench-task-detail', { childRunId: 'child' });
    expect(f.requests.slice(beforeReopen)).toEqual([]);

    // Changing baseline_id on the child summary invalidates the cache on next open.
    const baselineId = 'a'.repeat(64);
    f.state.tasks[0].children[0].baseline_id = baselineId;
    await f.click('bench-task-detail', { childRunId: 'other' });
    const beforeInvalidated = f.requests.length;
    const resolvePromoted = f.defer('./api/bench/runs/child?omit_provenance=1');
    const reopenPromoted = f.click('bench-task-detail', { childRunId: 'child' });
    resolvePromoted({
        id: 'child',
        task_id: 'task',
        status: 'completed',
        updated_at: ts,
        baseline_eligible: true,
        ineligibility_reason: null,
        baseline_id: baselineId,
        baseline_targets: [{ target_id: 'target-a', baseline_eligible: true, ineligibility_reason: null, baseline_id: baselineId }],
        samples: []
    });
    await reopenPromoted;
    expect(f.requests.slice(beforeInvalidated)).toEqual(['./api/bench/runs/child?omit_provenance=1']);
    expect(f.state.runDetail.baseline_id).toBe(baselineId);
});

test('bulk baseline promote and demote split requests into 256-item batches and refresh after partial failure', async () => {
    const nodes = new Map(),
        events = new Map(),
        emitted = [],
        notices = [],
        batchBodies = [];
    const element = id => {
        if (!nodes.has(id))
            nodes.set(id, {
                handlers: new Map(),
                dataset: {},
                addEventListener(name, handler) {
                    this.handlers.set(name, handler);
                },
                getAttribute: () => null,
                contains: () => false
            });
        return nodes.get(id);
    };
    const total = 300;
    const tasks = [
        {
            id: 'big-task',
            status: 'completed',
            children: Array.from({ length: total }, (_, index) => ({
                run_id: index.toString(16).padStart(32, '0'),
                target: { id: `target-${index}`, model: 'model' },
                status: 'completed',
                baseline_eligible: true,
                ineligibility_reason: null,
                baseline_id: null
            }))
        }
    ];
    let failOnSecondDeleteBatch = false;
    let deleteBatchCalls = 0;
    const app = {
        services: {
            available: true,
            notify: (message, isError = false) => notices.push({ message, isError }),
            request: async (path, options) => {
                const basePath = path.split('?')[0];
                if (basePath.endsWith('/banks')) return { banks: [], execution_policy: 'sample-timeout-v1' };
                if (basePath.endsWith('/routes')) return { routes: [] };
                if (basePath.endsWith('/tasks')) return { tasks };
                if (basePath.endsWith('/runs')) return { runs: [] };
                if (basePath.endsWith('/baselines/batch') && options?.method === 'POST') {
                    const body = JSON.parse(options.body);
                    batchBodies.push(body);
                    if (body.action === 'promote') {
                        expect(body.items.length).toBeLessThanOrEqual(256);
                        const created = body.items.map((item, idx) => {
                            const id = (batchBodies.length * 1000 + idx).toString(16).padStart(64, '0');
                            const child = tasks[0].children.find(c => c.run_id === item.run_id);
                            if (child) child.baseline_id = id;
                            return { id, run_id: item.run_id, target_id: item.target_id };
                        });
                        return { created, rejected: [] };
                    }
                    if (body.action === 'delete') {
                        deleteBatchCalls++;
                        expect(body.ids.length).toBeLessThanOrEqual(256);
                        if (failOnSecondDeleteBatch && deleteBatchCalls === 2) throw new Error('disk busy');
                        const deletedSet = new Set(body.ids);
                        for (const child of tasks[0].children) {
                            if (deletedSet.has(child.baseline_id)) child.baseline_id = null;
                        }
                        return { deleted: body.ids };
                    }
                }
                return {};
            }
        },
        on: (name, handler) => events.set(name, handler),
        emit: name => emitted.push(name),
        setHistory() {},
        setTaskRoutes() {}
    };
    const context = vm.createContext({
        getAppContext: () => app,
        createTaskTargets() {},
        createTaskHistoryView: () => ({
            element,
            historyEntries: () => tasks.map(record => ({ kind: 'task', record })),
            renderDetails() {},
            inProgress: () => false,
            canCancel: () => false,
            fixedTargets: () => [],
            taskSection: element('task-section'),
            runSection: element('run-section')
        }),
        createTaskSubmission: () => ({ updateTaskPreview() {}, renderBanks() {} }),
        clearTimeout() {},
        setTimeout() {}
    });
    vm.runInContext(
        readFileSync(new URL('../web/bench.js', import.meta.url), 'utf8')
            .replace(/^import .*;\n/gm, '')
            .replace('if (available) load();', ''),
        context
    );
    await events.get('mini-bench:refresh')();

    // Promote 300 eligible children -> split into [256, 44]
    await element('bench-baseline-task').handlers.get('click')({ currentTarget: element('bench-baseline-task') });
    expect(batchBodies.map(body => ({ action: body.action, size: body.items.length }))).toEqual([
        { action: 'promote', size: 256 },
        { action: 'promote', size: 44 }
    ]);
    expect(tasks[0].children.every(child => Boolean(child.baseline_id))).toBe(true);
    expect(emitted.filter(name => name === 'mini-bench:observations-changed')).toHaveLength(1);
    expect(notices.at(-1)).toEqual({ message: '已将 300 个运行目标保存为 Mini Bench 基线。', isError: false });

    // Demote 300 saved baselines -> split into [256, 44], with second batch failing
    batchBodies.length = 0;
    failOnSecondDeleteBatch = true;
    await element('bench-unbaseline-task').handlers.get('click')({});
    expect(batchBodies.map(body => ({ action: body.action, size: body.ids.length }))).toEqual([
        { action: 'delete', size: 256 },
        { action: 'delete', size: 44 }
    ]);
    expect(tasks[0].children.filter(child => Boolean(child.baseline_id))).toHaveLength(44);
    expect(emitted.filter(name => name === 'mini-bench:observations-changed')).toHaveLength(2);
    expect(notices.at(-1)).toEqual({ message: '部分取消基线失败（已取消 256 份）：disk busy', isError: true });

    // Demote remaining 44 -> single batch succeeds
    batchBodies.length = 0;
    failOnSecondDeleteBatch = false;
    deleteBatchCalls = 0;
    await element('bench-unbaseline-task').handlers.get('click')({});
    expect(batchBodies.map(body => ({ action: body.action, size: body.ids.length }))).toEqual([{ action: 'delete', size: 44 }]);
    expect(tasks[0].children.every(child => !child.baseline_id)).toBe(true);
    expect(notices.at(-1)).toEqual({ message: '已取消 44 份基线标记，原始运行记录已保留。', isError: false });
});
