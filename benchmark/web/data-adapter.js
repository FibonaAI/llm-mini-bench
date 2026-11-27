// Catalog ownership is a routing claim, not verified upstream provider/account identity.
// Never derive provider identity from a display label or split a model ID.
const text = value => (typeof value === 'string' && value.length ? value : null);

/** Read an adapter-declared remote namespace; never infer it from model-name segments. */
export function remoteRouteNamespace(record) {
  const provider = text(record.provider_id),
    remote = record.remote_route;
  return provider &&
    !['auto', 'group'].includes(provider) &&
    remote &&
    typeof remote === 'object' &&
    !Array.isArray(remote) &&
    Object.keys(remote).every(key => key === 'namespace' || key === 'evidence') &&
    typeof remote.evidence === 'string' &&
    remote.evidence.length > 0 &&
    remote.evidence.length <= 128 &&
    remote.evidence.trim() === remote.evidence &&
    !/[\u0000-\u001f\u007f]/.test(remote.evidence) &&
    typeof remote.namespace === 'string' &&
    remote.namespace.length > 0 &&
    remote.namespace.trim() === remote.namespace &&
    remote.namespace.length <= 256 &&
    !/[\u0000-\u001f\u007f/]/.test(remote.namespace)
    ? remote.namespace
    : null;
}

const routingConstructLabel = name => (name === 'auto' ? 'auto（自动路由）' : name === 'group' ? 'group（路由组）' : name);

function pickerIdentity(record, routeId, fallbackId) {
  const provider = text(record.provider_id);
  const binding = text(record.account_ref);
  const gateway = record.account_evidence === 'gateway_binding';
  const configured = record.account_evidence === 'configured_binding';
  const pinned = record.account_evidence === 'gateway_account_binding';
  const model = text(record.model) ?? text(record.label) ?? '未记录模型';
  const namespace = remoteRouteNamespace(record);
  const path = namespace ? `${provider} / ${namespace}` : null;
  const namespaceLabel = namespace ? routingConstructLabel(namespace) : null;
  const localProviderLabel = provider ? routingConstructLabel(provider) : null;
  return {
    providerId: namespace ? JSON.stringify([provider, namespace]) : provider ? `provider:${provider}` : `route:${routeId ?? fallbackId}`,
    providerShortName: namespaceLabel ?? undefined,
    providerSubtitle: namespace ? provider : undefined,
    providerName: namespace ? `${provider} / ${namespaceLabel}` : (localProviderLabel ?? '未记录渠道'),
    provider: namespace ? '远端路由目录' : provider ? '网关目录归属' : '渠道归属未记录',
    providerDisplayId: path ?? provider ?? routeId ?? '未记录',
    providerType: '', // The public model API does not expose provider preset/icon.
    accountId: gateway ? `gateway-binding:${binding ?? 'unknown'}` : binding ? `account:${binding}` : 'unknown-account',
    account: gateway
      ? '网关自动分配（账号未记录）'
      : configured && binding
        ? `${binding}（配置绑定）`
        : pinned && binding
          ? `${binding}（固定绑定）`
          : binding
            ? `${binding}（未核验）`
            : '未记录账号',
    accountShortName: gateway ? '网关自动分配' : undefined,
    accountDisplayId: gateway ? '实际账号未记录' : (binding ?? '未记录'),
    ...(record.account_disabled === true ? { accountDisabled: true } : {}),
    model,
    modelDisplayName: text(record.model_display_name) ?? model,
    routeId
  };
}

/** Offer default Thinking only when a route advertises no explicit efforts. */
export function routePickerLeaves(routes) {
  return routes.flatMap(route => {
    if (!text(route.id)) return [];
    // Explicit routes predate account_evidence and their schema establishes a configured binding.
    const identity = pickerIdentity({ ...route, account_evidence: route.account_evidence ?? 'configured_binding' }, route.id, route.id);
    const efforts = new Set(
      (route.thinking_levels ?? [])
        .map(level => (typeof level === 'string' ? level : level?.effort))
        .filter(level => typeof level === 'string' && level.trim() && !['default', 'mixed', 'unknown'].includes(level))
    );
    const options = efforts.size ? [...efforts] : ['default'];
    return options.map(think => ({ ...identity, think, route, routeId: route.id }));
  });
}
export function observationPickerRecords(observations) {
  return observations.map(record => ({
    ...record,
    ...pickerIdentity(record, text(record.route_id), `observation:${record.id}`),
    original: record,
    think: text(record.thinking) ?? 'unknown',
    score: null,
    cost: null
  }));
}
