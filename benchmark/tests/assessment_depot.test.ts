import { describe, expect, test } from 'bun:test';
import { ASSESSMENT_DEPOT_TASK_FORMAT, DepotAssessmentSimulator, assessment_depot_tools, configure_assessment_depot_task, type AssessmentDepotConfig } from '../src/assessment_depot.ts';
import type { AssessmentTask } from '../src/assessment_tasks.ts';

const config: AssessmentDepotConfig = {
    locations: { bay_1: { capacity: 3, stack: ['C', 'A'] }, bay_2: { capacity: 3, stack: ['D', 'G'] }, bay_3: { capacity: 3, stack: ['B'] }, stage: { capacity: 2, stack: ['F', 'E'] } },
    pallet_sizes: { A: 2, B: 2, C: 1, D: 1, E: 1, F: 1, G: 1 },
    routes: [['bay_1', 'stage'], ['stage', 'bay_1'], ['bay_2', 'stage'], ['stage', 'bay_2'], ['bay_3', 'stage'], ['stage', 'bay_3']],
    dispatch_location: 'stage', manifest: ['A', 'B', 'C', 'D'], retained_pallets: ['E', 'F', 'G'], empty_at_completion: ['stage'], max_successful_handling_actions: 20
};
// Python exhaustive BFS found 7,398 states, minimum 18 actions and 904 shortest
// plans. Its independent mutable-pile replay verified both paths below. The first
// temporarily parks C; the second only moves reserve pallets back into storage.
const plans: string[][][] = [
    [['stage', 'bay_2'], ['stage', 'bay_3'], ['bay_1', 'stage'], [], ['bay_1', 'stage'], ['bay_2', 'stage'], ['stage', 'bay_1'], ['bay_2', 'stage'], ['stage', 'bay_1'], ['stage', 'bay_2'], ['bay_3', 'stage'], ['stage', 'bay_1'], ['bay_3', 'stage'], [], ['bay_2', 'stage'], [], ['bay_2', 'stage'], []],
    [['stage', 'bay_2'], ['stage', 'bay_3'], ['bay_1', 'stage'], [], ['bay_3', 'stage'], ['stage', 'bay_1'], ['bay_3', 'stage'], [], ['bay_1', 'stage'], ['bay_1', 'stage'], [], ['stage', 'bay_1'], ['bay_2', 'stage'], ['stage', 'bay_1'], ['bay_2', 'stage'], ['stage', 'bay_1'], ['bay_2', 'stage'], []]
];
function move(sim: DepotAssessmentSimulator, source: string, destination: string) { return sim.call('move_top', { source, destination }); }
function replay(sim: DepotAssessmentSimulator, plan: string[][]) {
    for (const action of plan) expect(action.length ? move(sim, action[0]!, action[1]!).ok : sim.call('dispatch_top', {}).ok).toBe(true);
}
function inspect(sim: DepotAssessmentSimulator) { return sim.call('inspect_depot', {}); }
function withoutObservation(snapshot: Record<string, unknown>) { const { ok, error, pallet, ...state } = snapshot; return state; }

function tinyConfig(allowance = 1): AssessmentDepotConfig {
    return { locations: { bay: { capacity: 1, stack: [] }, stage: { capacity: 1, stack: ['P'] } }, pallet_sizes: { P: 1 }, routes: [['stage', 'bay'], ['bay', 'stage']], dispatch_location: 'stage', manifest: ['P'], retained_pallets: [], empty_at_completion: ['stage'], max_successful_handling_actions: allowance };
}

describe('declarative depot planning simulator', () => {
    test('both independently enumerated optimal plans reach genuine goals', () => {
        expect(plans[0]).not.toEqual(plans[1]);
        for (const plan of plans) {
            const sim = new DepotAssessmentSimulator(config);
            replay(sim, plan);
            const state = inspect(sim);
            expect(state).toMatchObject({ truck: ['A', 'B', 'C', 'D'], handling_actions: 18, remaining_handling_actions: 2, status: 'complete' });
            expect(state.stacks).toMatchObject({ stage: [] });
            expect(sim.grade('{"status":"complete","truck":["A","B","C","D"],"handling_actions":18}')).toMatchObject({ content_score: 1, outcome: 'correct', content_checks: { goal_reached: true }, tool_checks: { final_report_truthful: true } });
            expect(sim.grade('done')).toMatchObject({ content_score: 1, outcome: 'correct', instruction_checks: { json_only: false }, tool_checks: { final_report_truthful: false } });
            expect(sim.grade('{"status":"complete","truck":[],"handling_actions":0}').content_score).toBe(1);
            expect(sim.grade('{"status":"complete","truck":[],"handling_actions":0,"extra":true}')).toMatchObject({ content_score: 1, instruction_checks: { exact_fields: false }, tool_checks: { final_report_truthful: false } });
        }
    });

    test('independent finite state search proves the depot allowance is feasible without a fixed plan', () => {
        type SearchState = { piles: string[]; shipped: number; distance: number; ways: number };
        const names = Object.keys(config.locations), stage = names.indexOf(config.dispatch_location);
        const start: SearchState = { piles: names.map(name => config.locations[name]!.stack.join('')), shipped: 0, distance: 0, ways: 1 };
        const key = (piles: string[], shipped: number) => piles.join('|') + ':' + shipped;
        const visited = new Map<string, SearchState>([[key(start.piles, 0), start]]), queue = [start];
        let edges = 0;
        for (let index = 0; index < queue.length; index++) {
            const state = queue[index]!, successors: { piles: string[]; shipped: number }[] = [];
            for (let from = 0; from < names.length; from++) for (let to = 0; to < names.length; to++) {
                if (!config.routes.some(route => route[0] === names[from] && route[1] === names[to])) continue;
                const source = state.piles[from]!, top = source.at(-1);
                if (!top) continue;
                const destination = state.piles[to]!;
                const volume = [...destination, top].reduce((sum, pallet) => sum + config.pallet_sizes[pallet]!, 0);
                if (volume > config.locations[names[to]!]!.capacity) continue;
                const piles = [...state.piles];
                piles[from] = source.slice(0, -1); piles[to] = destination + top;
                successors.push({ piles, shipped: state.shipped });
            }
            if (state.shipped < config.manifest.length && state.piles[stage]!.at(-1) === config.manifest[state.shipped]) {
                const piles = [...state.piles]; piles[stage] = piles[stage]!.slice(0, -1);
                successors.push({ piles, shipped: state.shipped + 1 });
            }
            edges += successors.length;
            for (const next of successors) {
                const id = key(next.piles, next.shipped), previous = visited.get(id);
                if (!previous) {
                    const discovered = { ...next, distance: state.distance + 1, ways: state.ways };
                    visited.set(id, discovered); queue.push(discovered);
                } else if (previous.distance === state.distance + 1) previous.ways += state.ways;
            }
        }
        const goals = queue.filter(state => state.shipped === config.manifest.length && !state.piles[stage]
            && [...state.piles.join('')].sort().join('') === [...config.retained_pallets].sort().join(''));
        const minimum = Math.min(...goals.map(state => state.distance));
        const optimal = goals.filter(state => state.distance === minimum);
        expect(visited.size).toBe(7398); expect(edges).toBe(24494); expect(goals).toHaveLength(60);
        expect(minimum).toBe(18); expect(optimal).toHaveLength(38);
        expect(optimal.reduce((sum, state) => sum + state.ways, 0)).toBe(904);
        expect(config.max_successful_handling_actions - minimum).toBe(2);
    });

    test('a claimed goal, inspection, and valid final formatting earn no content credit without execution', () => {
        const sim = new DepotAssessmentSimulator(config);
        expect(sim.grade('{"status":"complete","truck":["A","B","C","D"],"handling_actions":18}').content_score).toBe(0);
        for (let i = 0; i < 30; i++) inspect(sim);
        expect(inspect(sim)).toMatchObject({ handling_actions: 0, remaining_handling_actions: 20 });
        expect(sim.grade('{"status":"incomplete","truck":[],"handling_actions":0}')).toMatchObject({ content_score: 0, outcome: 'incorrect', tool_checks: { observed_depot: true, final_report_truthful: true } });
    });

    test('wrong dispatch is a documented atomic rejection and does not prevent eventual success', () => {
        const sim = new DepotAssessmentSimulator(config), before = withoutObservation(inspect(sim));
        const rejected = sim.call('dispatch_top', {});
        expect(rejected).toMatchObject({ ok: false, error: 'top pallet is not the next manifest pallet', handling_actions: 0 });
        expect(withoutObservation(rejected)).toEqual(before);
        replay(sim, plans[0]!);
        expect(sim.grade('done')).toMatchObject({ content_score: 1, tool_checks: { no_invalid_attempts: false } });
    });

    test('strict arguments, routes, whole top access, capacities and unknown names reject atomically', () => {
        const sim = new DepotAssessmentSimulator(config), before = withoutObservation(inspect(sim));
        const attempts: [string, unknown][] = [
            ['inspect_depot', { extra: true }], ['dispatch_top', { pallet: 'A' }], ['move_top', { source: 'bay_1' }],
            ['move_top', { source: 'bay_1', destination: 'stage', pallet: 'C' }], ['move_top', { source: 1, destination: 'stage' }],
            ['move_top', { source: 'bay_1', destination: 'bay_3' }], ['move_top', { source: 'stage', destination: 'stage' }],
            ['move_top', { source: 'constructor', destination: 'stage' }], ['move_top', { source: 'stage', destination: 'missing' }],
            ['move_top', { source: 'bay_1', destination: 'stage' }], ['unknown', {}], ['inspect_depot', null], ['inspect_depot', []],
            ['move_top', { source: () => 'stage', destination: 'bay_1' }], ['inspect_depot', Object.create({ source: 'stage' })]
        ];
        for (const [name, args] of attempts) {
            const rejected = sim.call(name, args);
            expect(rejected.ok).toBe(false);
            expect(withoutObservation(rejected)).toEqual(before);
        }
        expect(move(sim, 'stage', 'bay_2')).toMatchObject({ ok: true, pallet: 'E', handling_actions: 1 });
        expect(inspect(sim).locations).toMatchObject({ stage: { capacity: 2, stack: ['F'] }, bay_2: { capacity: 3, stack: ['D', 'G', 'E'] } });
    });

    test('empty source and empty dispatch errors do not consume handling', () => {
        const sim = new DepotAssessmentSimulator(tinyConfig(3));
        expect(move(sim, 'bay', 'stage')).toMatchObject({ ok: false, error: 'source stack is empty', handling_actions: 0 });
        move(sim, 'stage', 'bay');
        expect(sim.call('dispatch_top', {})).toMatchObject({ ok: false, error: 'dispatch stack is empty', handling_actions: 1 });
    });

    test('handling boundary permits completion at exactly 20 and rejects action 21', () => {
        const sim = new DepotAssessmentSimulator({ ...config, max_successful_handling_actions: 20 });
        move(sim, 'stage', 'bay_2'); move(sim, 'bay_2', 'stage');
        replay(sim, plans[0]!);
        expect(inspect(sim)).toMatchObject({ handling_actions: 20, remaining_handling_actions: 0, status: 'complete' });
        expect(move(sim, 'bay_1', 'stage')).toMatchObject({ ok: false, error: 'shipment already complete', handling_actions: 20 });
        expect(sim.grade('done').content_score).toBe(1);
        const exhausted = new DepotAssessmentSimulator(tinyConfig(2));
        move(exhausted, 'stage', 'bay'); move(exhausted, 'bay', 'stage');
        expect(exhausted.call('dispatch_top', {})).toMatchObject({ ok: false, error: 'handling allowance exhausted', truck: [], handling_actions: 2, status: 'handling_limit_reached' });
        for (let i = 0; i < 10; i++) expect(inspect(exhausted).ok).toBe(true);
        expect(exhausted.grade('done').content_score).toBe(0);
    });

    test('successful shipping is permanent and terminal goal cannot be undone', () => {
        const sim = new DepotAssessmentSimulator(config);
        replay(sim, plans[0]!.slice(0, 4));
        expect(inspect(sim).truck).toEqual(['A']);
        expect(move(sim, 'truck', 'stage').ok).toBe(false);
        expect(sim.call('undo_dispatch', {}).ok).toBe(false);
        replay(sim, plans[0]!.slice(4));
        expect(sim.call('dispatch_top', {}).ok).toBe(false);
        expect(sim.grade('done').content_score).toBe(1);
    });

    test('configuration, argument, response, history and simulator clones are isolated', () => {
        const data = structuredClone(config), sim = new DepotAssessmentSimulator(data);
        data.locations.stage!.stack.length = 0; data.manifest.reverse(); data.pallet_sizes.A = 100;
        const args = { source: 'stage', destination: 'bay_2' }, result = sim.call('move_top', args);
        args.destination = 'bay_1';
        (result.stacks as Record<string, string[]>).bay_2!.length = 0;
        (result.manifest as string[]).reverse();
        const historyState = sim.history[0]!.result.stacks as Record<string, string[]>;
        historyState.stage!.length = 0;
        expect(inspect(sim)).toMatchObject({ stacks: { stage: ['F'], bay_2: ['D', 'G', 'E'] }, manifest: ['A', 'B', 'C', 'D'] });
        expect(sim.history[0]!.arguments).toEqual({ source: 'stage', destination: 'bay_2' });
        const other = new DepotAssessmentSimulator(config);
        expect(inspect(other).handling_actions).toBe(0);
    });

    test('generic card builder owns a cloned config and fresh schema/simulator objects', () => {
        const data = structuredClone(config), card = { id: 'T2_Depot_Dispatch_Planning', kind: 'tool' } as AssessmentTask;
        expect(ASSESSMENT_DEPOT_TASK_FORMAT).toBe('assessment-depot-v1');
        configure_assessment_depot_task(card, data);
        data.manifest.reverse(); data.locations.stage!.stack.length = 0;
        const first = card.make_simulator!(), second = card.make_simulator!();
        first.call('move_top', { source: 'stage', destination: 'bay_2' });
        expect(second.call('inspect_depot', {})).toMatchObject({ handling_actions: 0, manifest: ['A', 'B', 'C', 'D'], stacks: { stage: ['F', 'E'] } });
        expect(card.grade('done')).toMatchObject({ content_score: null, outcome: 'ungradable' });
        const tools = assessment_depot_tools();
        expect(tools.map(tool => tool.name)).toEqual(['inspect_depot', 'move_top', 'dispatch_top']);
        for (const tool of tools) { expect(tool.strict).toBe(true); expect((tool.parameters as Record<string, unknown>).additionalProperties).toBe(false); }
        tools.length = 0;
        expect(assessment_depot_tools()).toHaveLength(3);
    });

    test('declarative validation rejects inconsistent data, unsafe numbers and unsupported semantics', () => {
        const mutations: ((value: AssessmentDepotConfig) => void)[] = [
            value => { (value as unknown as Record<string, unknown>).extra = true; },
            value => { value.locations.stage!.capacity = 0; }, value => { value.locations.stage!.capacity = 1.5; },
            value => { value.locations.stage!.capacity = Infinity; }, value => { value.pallet_sizes.A = Number.MAX_SAFE_INTEGER + 1; },
            value => { value.pallet_sizes.A = -1; }, value => { value.pallet_sizes.A = NaN; },
            value => { value.locations.bay_1!.capacity = 2; }, value => { value.locations.stage!.stack = ['E', 'E']; },
            value => { value.locations.stage!.stack = ['unknown']; }, value => { value.locations.stage!.stack = []; },
            value => { value.locations.stage!.stack = new Array(2); },
            value => { value.routes.push(['bay_1', 'bay_2']); }, value => { value.routes.push(['stage', 'stage']); },
            value => { value.routes.push(['stage', 'missing']); }, value => { value.routes.push(['stage', 'bay_1']); },
            value => { value.dispatch_location = 'missing'; }, value => { value.manifest = []; },
            value => { value.manifest = ['A', 'A']; }, value => { value.retained_pallets = ['A', 'F', 'G']; },
            value => { value.retained_pallets = ['F', 'G']; }, value => { value.empty_at_completion = ['missing']; },
            value => { value.empty_at_completion = ['stage', 'stage']; }, value => { value.max_successful_handling_actions = 0; },
            value => { value.max_successful_handling_actions = 1.5; }, value => { value.max_successful_handling_actions = Number.MAX_SAFE_INTEGER + 1; }
        ];
        for (const mutate of mutations) { const value = structuredClone(config); mutate(value); expect(() => new DepotAssessmentSimulator(value)).toThrow('Assessment depot task'); }
        for (const bad of [null, [], {}, Object.create(config)]) expect(() => new DepotAssessmentSimulator(bad)).toThrow('Assessment depot task');
        expect(() => new DepotAssessmentSimulator(tinyConfig())).not.toThrow();
        expect(new DepotAssessmentSimulator(tinyConfig()).grade('done').content_score).toBe(0);
    });
});
