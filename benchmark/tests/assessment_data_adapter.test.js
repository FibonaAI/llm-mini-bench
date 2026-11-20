import { test, expect } from 'bun:test';
import { routePickerLeaves, observationPickerRecords, remoteRouteNamespace } from '../web/data-adapter.js';
import { selectionKey } from '../web/data-picker.js';
const route = (id, provider_id) => ({
    id,
    provider_id,
    provider_evidence: 'gateway_catalog',
    model: 'remote-magpie/openai/same-model',
    model_display_name: 'Same model',
    label: 'Same label',
    account_ref: 'gateway-default',
    account_evidence: 'gateway_binding',
    thinking_levels: ['high', 'low']
});
test('catalog provider instance IDs are exact and independent of human labels', () => {
    const records = routePickerLeaves([route('a', 'chatgpt-api'), route('b', 'chatgpt-api-2')]);
    expect(new Set(records.map(selectionKey)).size).toBe(4);
    expect(records.some(r => r.think === 'default')).toBe(false);
    expect(new Set(records.map(r => r.providerId))).toEqual(new Set(['provider:chatgpt-api', 'provider:chatgpt-api-2']));
    expect(records.every(r => r.account.includes('账号未记录') && r.providerType === '')).toBe(true);
    expect(records[0].model).toBe('remote-magpie/openai/same-model');
    expect(records[0].modelDisplayName).toBe('Same model');
});
test('models without levels offer only default; models with levels never offer default', () => {
    const records = routePickerLeaves([
        { ...route('plain', 'chatgpt-api'), thinking_levels: [] },
        { ...route('missing', 'chatgpt-api'), thinking_levels: undefined },
        { ...route('reserved', 'chatgpt-api'), thinking_levels: ['default', 'mixed'] },
        route('levels', 'chatgpt-api')
    ]);
    const by = id => records.filter(r => r.routeId === id).map(r => r.think);
    expect(by('plain')).toEqual(['default']);
    expect(by('missing')).toEqual(['default']);
    expect(by('reserved')).toEqual(['default']);
    expect(by('levels')).toEqual(['high', 'low']);
});
test('nested model names do not create a provider or verified account', () => {
    const [record] = routePickerLeaves([route('a', undefined)]);
    expect(record.providerId).toBe('route:a');
    expect(record.providerName).not.toBe('openai');
    expect(record.accountDisplayId).toBe('实际账号未记录');
});
test('historical observation identity is never backfilled from current catalog', () => {
    const observation = {
        id: 'old',
        route_id: 'a',
        model: 'remote-magpie/openai/same-model',
        thinking: 'high',
        account_ref: null,
        account_evidence: null
    };
    const before = structuredClone(observation);
    const [record] = observationPickerRecords([observation], [route('a', 'chatgpt-api')]);
    expect(record.providerId).toBe('route:a');
    expect(record.account).toBe('未记录账号');
    expect(observation).toEqual(before);
    expect(record.score).toBeNull();
    expect(record.cost).toBeNull();
});
test('explicit configured bindings and anonymous routes stay separate', () => {
    const a = { id: 'explicit-a', model: 'same', account_ref: 'configured-account', thinking_levels: ['high'] };
    const b = { ...a, id: 'explicit-b' };
    const records = routePickerLeaves([a, b]);
    expect(new Set(records.map(selectionKey)).size).toBe(2);
    expect(records.every(r => r.account === 'configured-account（配置绑定）')).toBe(true);
    const unknown = observationPickerRecords([
        { id: 'old-1', model: 'same', thinking: 'high' },
        { id: 'old-2', model: 'same', thinking: 'high' }
    ]);
    expect(new Set(unknown.map(selectionKey)).size).toBe(2);
    const pinned = routePickerLeaves([
        {
            ...route('pin-a', 'codex'),
            account_ref: 'first@example.invalid',
            account_evidence: 'gateway_account_binding'
        },
        {
            ...route('pin-b', 'codex'),
            account_ref: 'second@example.invalid',
            account_evidence: 'gateway_account_binding'
        }
    ]);
    expect(new Set(pinned.map(selectionKey)).size).toBe(4);
    expect(pinned.find(r => r.routeId === 'pin-a').account).toBe('first@example.invalid（固定绑定）');
    expect(pinned.find(r => r.routeId === 'pin-b').account).toBe('second@example.invalid（固定绑定）');
    expect(pinned.find(r => r.routeId === 'pin-a').accountId).toBe('account:first@example.invalid');
});
const remoteRoute = (id, provider, namespace, model = 'remote-magpie/openai/same-model') => ({
    ...route(id, provider),
    model,
    remote_route: { namespace, evidence: 'magpie_via_catalog' }
});
test('remote namespaces group by outer provider instance and namespace without changing exact routes or models', () => {
    const input = [
        remoteRoute('a', 'remote-A', 'openai'),
        remoteRoute('b', 'remote-B', 'openai'),
        remoteRoute('c', 'remote-A', 'openai', 'another/exact/model')
    ];
    const before = structuredClone(input),
        records = routePickerLeaves(input);
    expect(new Set(records.map(record => record.providerId))).toEqual(
        new Set([JSON.stringify(['remote-A', 'openai']), JSON.stringify(['remote-B', 'openai'])])
    );
    expect(records.filter(record => record.routeId === 'a')[0].providerId).toBe(
        records.filter(record => record.routeId === 'c')[0].providerId
    );
    expect(records[0].providerName).toBe('remote-A / openai');
    expect(records[0].provider).toBe('远端路由目录');
    expect(records.every(record => record.providerType === '' && record.accountDisplayId === '实际账号未记录')).toBe(true);
    expect(records.filter(record => record.routeId === 'c').every(record => record.model === 'another/exact/model')).toBe(true);
    expect(new Set(records.map(selectionKey)).size).toBe(6);
    expect(input).toEqual(before);
});
test('inner auto and group are labeled as routing constructs, unknown namespaces remain neutral', () => {
    const records = routePickerLeaves([
        remoteRoute('a', 'remote', 'auto'),
        remoteRoute('b', 'remote', 'group'),
        remoteRoute('c', 'remote', 'unfamiliar')
    ]);
    expect(records.find(record => record.routeId === 'a').providerName).toBe('remote / auto（自动路由）');
    expect(records.find(record => record.routeId === 'b').providerName).toBe('remote / group（路由组）');
    expect(records.find(record => record.routeId === 'c').providerName).toBe('remote / unfamiliar');
    expect(records.every(record => record.providerType === '')).toBe(true);
});
test('invalid remote evidence never expands a nested model name into provider identity', () => {
    for (const remote_route of [
        null,
        undefined,
        [],
        {},
        { namespace: 'openai', evidence: '' },
        { namespace: '', evidence: 'magpie_via_catalog' },
        { namespace: '   ', evidence: 'magpie_via_catalog' },
        { namespace: ' openai', evidence: 'magpie_via_catalog' },
        { namespace: 'openai ', evidence: 'magpie_via_catalog' },
        { namespace: 'one/two', evidence: 'magpie_via_catalog' },
        { namespace: 'a\nnamespace', evidence: 'magpie_via_catalog' },
        { namespace: 'x'.repeat(257), evidence: 'magpie_via_catalog' },
        { namespace: 'openai', evidence: 'magpie_via_catalog', extra: true },
        { namespace: 123, evidence: 'magpie_via_catalog' }
    ]) {
        const input = { ...route('a', 'remote'), remote_route };
        const [record] = routePickerLeaves([input]);
        expect(remoteRouteNamespace(input)).toBeNull();
        expect(record.providerId).toBe('provider:remote');
        expect(record.providerName).toBe('remote');
        expect(record.model).toBe(input.model);
    }
    for (const provider_id of [undefined, null, '', 'auto', 'group']) {
        const input = remoteRoute('a', provider_id, 'openai');
        expect(remoteRouteNamespace(input)).toBeNull();
        expect(routePickerLeaves([input])[0].providerName).not.toContain(' / openai');
    }
});
test('normalized namespaces from other adapters use the same picker without platform-specific evidence', () => {
    const input = { ...route('fixture', 'adapter-owner'), remote_route: { namespace: 'account-service', evidence: 'fixture_catalog' } };
    expect(remoteRouteNamespace(input)).toBe('account-service');
    expect(routePickerLeaves([input])[0].providerName).toBe('adapter-owner / account-service');
});
test('historical records without namespace evidence do not merge into current remote routes', () => {
    const current = remoteRoute('a', 'remote', 'openai');
    const old = {
        id: 'old',
        provider_id: 'remote',
        route_id: 'a',
        model: current.model,
        thinking: 'high',
        account_ref: 'gateway-default',
        account_evidence: 'gateway_binding'
    };
    const [historical] = observationPickerRecords([old], [current]);
    const leaf = routePickerLeaves([current]).find(record => record.think === 'high');
    expect(selectionKey(historical)).not.toBe(selectionKey(leaf));
    expect(historical.providerId).toBe('provider:remote');
    const [recent] = observationPickerRecords([{ ...old, id: 'new', remote_route: current.remote_route }]);
    expect(selectionKey(recent)).toBe(selectionKey(leaf));
    expect(recent.provider_id).toBe('remote');
    expect(recent.original.remote_route).toEqual(current.remote_route);
});
