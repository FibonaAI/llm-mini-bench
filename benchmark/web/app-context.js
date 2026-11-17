/**
 * Shared frontend event contract. All notifications use the existing window events so
 * host integrations can observe them; controllers use on/emit, not mutable globals.
 * @typedef {{id: string, route_id: string, thinking: string}} TaskTarget
 * @typedef {{routes: readonly Object[], leaves: readonly Object[], selectedKeys: readonly string[]}} TaskTargetState
 * @typedef {{version: string, tasks: {id: string}[]}} FrontendBank
 * @typedef {Object} TaskTargetActions
 * @property {() => TaskTarget[]} getSelectedTargets Deterministically ordered exact route/Thinking pairs.
 * @property {(keys: string[], announce?: boolean) => void} setTaskSelection Drop unsupported identities.
 * @property {(routes: Object[]) => void} setTaskRoutes Replace advertised catalog; never auto-select.
 * @typedef {Object} MiniBenchServices
 * @property {(id: string) => HTMLElement} byId DOM lookup, with detached detail fallback owned by the view.
 * @property {(value: unknown) => string} escapeHtml Escape any evidence before HTML insertion.
 * @property {(value: unknown) => boolean} finite Strict finite-number check.
 * @property {(path: string, options?: RequestInit) => Promise<Object>} request Authenticated local API only.
 * @property {(message: string, error?: boolean) => void} notify Local notice, not a model request.
 * @property {boolean} available Whether the bootstrap has an access token.
 * @property {(status: string) => boolean} activeStatus Queued/running status check.
 * @property {(status: string) => string} statusText Recorded execution status label.
 * @property {(value: unknown) => string} formatDate Recorded timestamp label.
 *
 * Context data: bank, targets, taskCount and getTaskId are read-only views.
 * Context actions: setBank, setTargetCatalog, setTargetSelection, setHistory replace
 * their source data; bindTargetActions installs the sole task target controller.
 * Service dependencies: byId, escapeHtml, finite, request, notify, available,
 * activeStatus, statusText and formatDate come from the classic API bootstrap.
 * No token is placed in shared context data or event payloads.
 *
 * @typedef {{
 *   'mini-bench:view': 'analysis'|'runs', // Active page.
 *   'mini-bench:select-targets': {keys: string[]}, // Exact advertised leaf identities.
 *   'mini-bench:select-run': string, // Persisted run ID, never a model name.
 *   'mini-bench:banks-changed': Object, // Current bank manifest with tasks.
 *   'mini-bench:targets-changed': undefined, // Selection/catalog changed.
 *   'mini-bench:routes-changed': undefined, // Catalog changed; not historical identity.
 *   'mini-bench:history-changed': undefined, // Run-to-task membership refreshed.
 *   'mini-bench:observations-changed': undefined, // Persisted observations need reloading.
 *   'mini-bench:refresh': undefined, // Explicit user refresh.
 *   'mini-bench:theme-changed': undefined, // Presentation-only invalidation.
 * }} MiniBenchEvents
 */

/**
 * Create one app context; services and the event target are explicit testable dependencies.
 * @param {MiniBenchServices} services
 * @param {EventTarget} eventTarget Existing window events remain available to host integrations.
 */
export function createAppContext(services, eventTarget) {
  let bank = null;
  let targets = Object.freeze({ routes: Object.freeze([]), leaves: Object.freeze([]), selectedKeys: Object.freeze([]) });
  let runTaskIds = new Map();
  let targetActions = null;
  /** Subscribe to one documented event; callers may dispose the returned subscription. */
  const on = (name, handler) => {
    eventTarget.addEventListener(name, handler);
    return () => eventTarget.removeEventListener(name, handler);
  };
  /** Publish the documented detail payload without changing state implicitly. */
  const emit = (name, detail) => eventTarget.dispatchEvent(new CustomEvent(name, { detail }));
  const context = {
    services: Object.freeze({ ...services }),
    on,
    emit,
    get bank() {
      return bank;
    },
    get targets() {
      return targets;
    },
    get taskCount() {
      return bank?.tasks?.length || 0;
    },
    getTaskId: runId => runTaskIds.get(runId),
    /** Replace the bank before notifying listeners; never infer a production bank. */
    setBank(value) {
      bank = value;
      emit('mini-bench:banks-changed', bank);
    },
    /** Catalog replacement retains only exact supported selections, never replacements. */
    setTargetCatalog(routes, leaves, supportedKeys) {
      const supported = new Set(supportedKeys);
      targets = Object.freeze({
        routes: Object.freeze([...routes]),
        leaves: Object.freeze([...leaves]),
        selectedKeys: Object.freeze(targets.selectedKeys.filter(key => supported.has(key)))
      });
    },
    /** Target controllers validate keys before publishing one immutable selection. */
    setTargetSelection(keys) {
      targets = Object.freeze({ ...targets, selectedKeys: Object.freeze([...keys]) });
    },
    /** Only membership is shared with analysis; history must not rewrite observations. */
    setHistory(tasks) {
      runTaskIds = new Map(tasks.flatMap(task => (task.children || []).map(child => [child.run_id, task.id])));
      emit('mini-bench:history-changed');
    },
    /** Install the target controller once, before task configuration is initialized. */
    bindTargetActions(actions) {
      if (targetActions) throw new Error('Mini Bench target controller already initialized');
      targetActions = actions;
    },
    getSelectedTargets: () => targetActions.getSelectedTargets(),
    setTaskSelection: (keys, announce = false) => targetActions.setTaskSelection(keys, announce),
    setTaskRoutes: routes => targetActions.setTaskRoutes(routes)
  };
  // Compatibility is introspection plus the same controller actions, not another store.
  const runState = Object.freeze({
    get routes() {
      return targets.routes;
    },
    get leaves() {
      return targets.leaves;
    },
    get selectedKeys() {
      return targets.selectedKeys;
    },
    get taskCount() {
      return context.taskCount;
    },
    get bank() {
      return bank;
    },
    get runTaskIds() {
      return new Map(runTaskIds);
    },
    getSelectedTargets: context.getSelectedTargets,
    setTaskSelection: context.setTaskSelection,
    setTaskRoutes: context.setTaskRoutes
  });
  return Object.freeze(Object.defineProperty(context, 'runState', { value: runState }));
}

let browserContext;
/** Bootstrap once after classic api.js; feature modules import this instead of window state. */
export function getAppContext() {
  if (!browserContext) {
    const services = window.MiniBench;
    if (!services) throw new Error('Mini Bench API bootstrap must load before feature modules');
    browserContext = createAppContext(services, window);
    Object.defineProperties(services, {
      bank: { get: () => browserContext.bank },
      runState: { get: () => browserContext.runState }
    });
  }
  return browserContext;
}
