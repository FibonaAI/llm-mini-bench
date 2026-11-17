import { expect, test } from 'bun:test';
import { createAppContext } from '../web/app-context.js';

function fixture() {
  const events = new EventTarget();
  const services = { available: true, request: async () => ({}) };
  return { events, services, app: createAppContext(services, events) };
}

test('context publishes updated bank and history before notifying listeners', () => {
  const { app } = fixture();
  const bank = { version: '1.0', tasks: [{ id: 'one' }] };
  const seen = [];
  app.on('mini-bench:banks-changed', event => seen.push([event.detail, app.bank, app.taskCount]));
  app.on('mini-bench:history-changed', () => seen.push(app.getTaskId('run')));
  app.setBank(bank);
  app.setHistory([{ id: 'batch', children: [{ run_id: 'run' }] }]);
  expect(seen).toEqual([[bank, bank, 1], 'batch']);
  expect(app.runState.bank).toBe(app.bank);
  expect(app.runState.taskCount).toBe(1);
  app.setHistory([]);
  expect(app.getTaskId('run')).toBeUndefined();
});

test('target snapshots and compatibility introspection cannot become a second writable store', () => {
  const { app } = fixture();
  app.setTargetCatalog([{ id: 'route' }], [{ routeId: 'route', think: 'high' }], ['exact']);
  app.setTargetSelection(['exact']);
  const old = app.targets;
  expect(app.runState.leaves).toBe(app.targets.leaves);
  expect(app.runState.selectedKeys).toBe(app.targets.selectedKeys);
  expect(() => app.runState.selectedKeys.push('invented')).toThrow();
  expect(() => { app.runState.selectedKeys = []; }).toThrow();
  app.setTargetCatalog([], [], []);
  expect(old.selectedKeys).toEqual(['exact']);
  expect(app.targets.selectedKeys).toEqual([]);
  app.setHistory([{ id: 'batch', children: [{ run_id: 'run' }] }]);
  app.runState.runTaskIds.set('run', 'fake');
  expect(app.getTaskId('run')).toBe('batch');
});

test('compatibility methods delegate to the same controller and contexts stay isolated', () => {
  const { app } = fixture(), other = fixture().app;
  const calls = [];
  const actions = {
    getSelectedTargets: () => ['one'],
    setTaskSelection: (...args) => calls.push(args),
    setTaskRoutes: routes => calls.push(routes),
  };
  app.bindTargetActions(actions);
  expect(() => app.bindTargetActions(actions)).toThrow('already initialized');
  expect(app.runState.getSelectedTargets()).toEqual(app.getSelectedTargets());
  app.runState.setTaskSelection(['key'], true);
  app.setTaskRoutes(['route']);
  expect(calls).toEqual([[['key'], true], ['route']]);
  app.setBank({ version: '1.0', tasks: [{ id: 'one' }] });
  expect(other.bank).toBeNull();
});

test('event contract preserves exact selection and run payloads and supports unsubscribe', () => {
  const { app } = fixture();
  const seen = [];
  const unsubscribe = app.on('mini-bench:select-targets', event => seen.push(event.detail));
  const keys = ['["channel","account","model","high"]'];
  app.emit('mini-bench:select-targets', { keys });
  unsubscribe();
  app.emit('mini-bench:select-targets', { keys: [] });
  app.on('mini-bench:select-run', event => seen.push(event.detail));
  app.emit('mini-bench:select-run', 'exact-run');
  expect(seen).toEqual([{ keys }, 'exact-run']);
});
