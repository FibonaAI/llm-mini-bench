import { test, expect } from 'bun:test';
import { createAnalysisFilterState, matchesAnalysisFilters } from '../web/analysis-filters.js';

const observation = (id, providerId, model, think = 'low', extra = {}) => ({
    id,
    providerId,
    providerName: providerId,
    accountId: 'configured:a',
    account: 'Account A',
    model,
    modelDisplayName: model,
    think,
    source: 'run',
    ...extra
});
const records = [
    observation('one', 'channel-a', 'Beam Free'),
    observation('repeat', 'channel-a', 'Beam Free'),
    observation('other-account', 'channel-a', 'Beam Free', 'low', { accountId: 'configured:b', account: 'Account B' }),
    observation('high', 'channel-b', 'beam_free', 'high'),
    observation('second-model', 'channel-a', 'Luna', 'high'),
    observation('baseline', 'channel-b', 'Luna', 'unknown', { source: 'baseline' })
];
const matchIds = state => records.filter(record => matchesAnalysisFilters(record, state)).map(record => record.id);

test('unrestricted analysis keeps every repeated observation and exact account identity', () => {
    expect(matchIds(createAnalysisFilterState())).toEqual(records.map(record => record.id));
});

test('model facets span channels with OR within facets and AND across facets', () => {
    const state = createAnalysisFilterState();
    state.model.add('beam-free');
    expect(matchIds(state)).toEqual(['one', 'repeat', 'other-account', 'high']);
    state.model.add('luna');
    state.think.add('high');
    expect(matchIds(state)).toEqual(['high', 'second-model']);
    state.provider.add('channel-a');
    expect(matchIds(state)).toEqual(['second-model']);
    state.provider.add('channel-b');
    expect(matchIds(state)).toEqual(['high', 'second-model']);
    state.think.clear();
    expect(matchIds(state)).toHaveLength(6);
});

test('source and unified search directly constrain observations without rewriting fields', () => {
    const state = createAnalysisFilterState();
    state.query = 'beam free accountb';
    expect(matchIds(state)).toEqual(['other-account']);
    state.query = 'LUNA';
    state.source = 'baseline';
    expect(matchIds(state)).toEqual(['baseline']);
    state.think.add('unknown');
    expect(matchIds(state)).toEqual(['baseline']);
    state.think = new Set(['low']);
    expect(matchIds(state)).toEqual([]);
});

test('facet counts omit only their own dimension and do not discard absent filters', () => {
    const state = createAnalysisFilterState();
    state.provider.add('temporarily-absent');
    state.model.add('beam-free');
    expect(matchIds(state)).toEqual([]);
    expect(records.filter(record => matchesAnalysisFilters(record, state, 'provider')).map(record => record.id)).toEqual([
        'one',
        'repeat',
        'other-account',
        'high'
    ]);
    expect(state.provider.has('temporarily-absent')).toBe(true);
});

test('request path segments do not invent a shared display model or provider', () => {
    const record = observation('remote', 'owner-a', 'owner-a/openai/exact/model', 'low');
    const state = createAnalysisFilterState();
    state.model.add('exact/model');
    expect(matchesAnalysisFilters(record, state)).toBe(false);
    state.model = new Set(['owner-a/openai/exact/model']);
    state.provider.add('owner-b');
    expect(matchesAnalysisFilters(record, state)).toBe(false);
    state.provider.clear();
    expect(matchesAnalysisFilters(record, state)).toBe(true);
});
