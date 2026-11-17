import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Active work polls every 2 s only while the page is visible.
test('hidden pages stop history polling and refresh once when visible again', async () => {
    const listeners = new Map(),
        timers = [],
        requests = [];
    const node = () => ({ addEventListener() {}, querySelectorAll: () => [] });
    const elements = new Map(),
        element = id => elements.get(id) ?? elements.set(id, node()).get(id);
    const document = { visibilityState: 'visible', addEventListener: (name, handler) => listeners.set(name, handler) };
    const running = { id: 'task', status: 'running', children: [] };
    const app = {
        services: {
            request: async path => {
                requests.push(path);
                if (path.endsWith('/tasks')) return { tasks: [running] };
                if (path.endsWith('/runs')) return { runs: [] };
                if (path.endsWith('/banks')) return { banks: [], execution_policy: 'sample-timeout-v1' };
                if (path.endsWith('/routes')) return { routes: [] };
                return running;
            },
            notify() {},
            available: true
        },
        on() {},
        emit() {},
        setHistory() {},
        setTaskRoutes() {}
    };
    const context = vm.createContext({
        document,
        getAppContext: () => app,
        createTaskTargets() {},
        createTaskHistoryView: () => ({
            element,
            historyEntries: () => [{ kind: 'task', record: running }],
            renderDetails() {},
            inProgress: record => record.status === 'running',
            canCancel: () => false,
            fixedTargets: () => [],
            taskSection: node(),
            runSection: node()
        }),
        createTaskSubmission: () => ({ updateTaskPreview() {}, renderBanks() {} }),
        clearTimeout: id => {
            if (id !== null) timers[id] = null;
        },
        setTimeout: callback => timers.push(callback) - 1
    });
    vm.runInContext(readFileSync(new URL('../web/bench.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), context);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(timers.filter(Boolean)).toHaveLength(1);
    document.visibilityState = 'hidden';
    listeners.get('visibilitychange')();
    expect(timers.filter(Boolean)).toHaveLength(0);
    const before = requests.length;
    document.visibilityState = 'visible';
    listeners.get('visibilitychange')();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests.length).toBeGreaterThan(before);
    expect(timers.filter(Boolean)).toHaveLength(1);
});
