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
        renders = 0,
        defer;
    const app = {
        services: {
            available: true,
            notify: message => notices.push(message),
            request: async path => {
                requests.push(path);
                if (defer?.path === path) return defer.promise;
                if (path.endsWith('/banks')) return { banks: [], execution_policy: 'sample-timeout-v1' };
                if (path.endsWith('/routes')) return { routes: [] };
                if (path.endsWith('/tasks')) return { tasks };
                if (path.endsWith('/runs')) return { runs };
                return tasks.find(task => path.endsWith('/tasks/' + task.id)) || runs.find(run => path.endsWith('/runs/' + run.id));
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
        createTaskSubmission: () => ({ updateTaskPreview() {}, renderBanks() {} }),
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
        click,
        refresh: () => events.get('mini-bench:refresh')(),
        select: id => events.get('mini-bench:select-run')({ detail: id }),
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
    const resolveTask = f.defer('./api/bench/tasks/task');
    await f.click('bench-run-list', { benchTaskId: 'task' });
    const pendingTask = f.click('bench-run-list', { benchTaskId: 'task' });
    await f.click('bench-run-list', { benchTaskId: 'task' });
    resolveTask({ id: 'task', status: 'completed' });
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
