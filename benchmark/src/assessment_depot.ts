import type { AssessmentGrade, AssessmentSimulator, AssessmentTask } from './assessment_tasks.ts';

/** Declarative pallet depot planning; successful handling actions consume a public resource. */
export const ASSESSMENT_DEPOT_TASK_FORMAT = 'assessment-depot-v1';
type DepotObject = Record<string, unknown>;
/** Complete depot data; stack arrays are ordered from bottom to top. */
export type AssessmentDepotConfig = {
    locations: Record<string, { capacity: number; stack: string[] }>;
    pallet_sizes: Record<string, number>;
    routes: [string, string][];
    dispatch_location: string;
    manifest: string[];
    retained_pallets: string[];
    empty_at_completion: string[];
    max_successful_handling_actions: number;
};
const object = (value: unknown): value is DepotObject => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactFields = (value: DepotObject, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && Array.from(value).every(identifier) && new Set(value).size === value.length;
function requireDepot(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Assessment depot task ' + reason); }

function depotConfig(value: unknown): AssessmentDepotConfig {
    requireDepot(object(value) && exactFields(value, ['locations', 'pallet_sizes', 'routes', 'dispatch_location', 'manifest', 'retained_pallets', 'empty_at_completion', 'max_successful_handling_actions']), 'requires a complete declarative configuration');
    requireDepot(object(value.locations) && Object.keys(value.locations).length >= 2 && Object.keys(value.locations).every(identifier), 'locations must contain a stage and storage bays');
    requireDepot(object(value.pallet_sizes) && Object.keys(value.pallet_sizes).length > 0 && Object.keys(value.pallet_sizes).every(identifier)
        && Object.values(value.pallet_sizes).every(positiveInteger), 'pallet sizes must be positive safe integers');
    const locations = value.locations, sizes = value.pallet_sizes as Record<string, number>, seen = new Set<string>();
    for (const [name, location] of Object.entries(locations)) {
        requireDepot(object(location) && exactFields(location, ['capacity', 'stack']) && positiveInteger(location.capacity) && stringList(location.stack), 'invalid capacity or stack at ' + name);
        let used = 0;
        for (const pallet of location.stack) {
            requireDepot(Object.hasOwn(sizes, pallet) && !seen.has(pallet), 'initial stacks must contain each declared pallet exactly once');
            requireDepot(sizes[pallet]! <= location.capacity - used, 'initial capacity exceeded at ' + name);
            used += sizes[pallet]!;
            seen.add(pallet);
        }
    }
    requireDepot(seen.size === Object.keys(sizes).length, 'initial stacks must contain every declared pallet');
    requireDepot(typeof value.dispatch_location === 'string' && Object.hasOwn(locations, value.dispatch_location), 'dispatch location must exist');
    const stage = value.dispatch_location;
    requireDepot(Array.isArray(value.routes) && value.routes.length > 0 && Array.from(value.routes).every(route => Array.isArray(route) && route.length === 2
        && Array.from(route).every(name => typeof name === 'string' && Object.hasOwn(locations, name)) && route[0] !== route[1]
        && (route[0] === stage || route[1] === stage)), 'routes must connect the stage to a storage bay');
    requireDepot(new Set(value.routes.map(route => JSON.stringify(route))).size === value.routes.length, 'routes must be unique');
    requireDepot(stringList(value.manifest) && value.manifest.length > 0 && stringList(value.retained_pallets)
        && [...value.manifest, ...value.retained_pallets].every(pallet => Object.hasOwn(sizes, pallet))
        && new Set([...value.manifest, ...value.retained_pallets]).size === value.manifest.length + value.retained_pallets.length
        && value.manifest.length + value.retained_pallets.length === seen.size, 'manifest and reserves must partition the pallets');
    requireDepot(stringList(value.empty_at_completion) && value.empty_at_completion.length > 0
        && value.empty_at_completion.every(name => Object.hasOwn(locations, name)), 'completion locations must be unique known locations');
    requireDepot(positiveInteger(value.max_successful_handling_actions), 'handling allowance must be a positive safe integer');
    return structuredClone(value) as AssessmentDepotConfig;
}

/** Fixed strict schemas; dispatch rejects a wrong top pallet before changing any state. */
export function assessment_depot_tools(): DepotObject[] {
    const emptyParameters = () => ({ type: 'object', properties: {}, required: [], additionalProperties: false });
    return [
        { type: 'function', name: 'inspect_depot', description: 'Inspect complete authoritative depot state, manifest, capacities, routes and handling allowance. Free and repeatable.', parameters: emptyParameters(), strict: true },
        { type: 'function', name: 'move_top', description: 'Move one whole top pallet along a listed stage/bay route if it fits. Success costs one handling action. Rejected moves change nothing.', parameters: {
            type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'], additionalProperties: false }, strict: true },
        { type: 'function', name: 'dispatch_top', description: 'Permanently ship the stage top if it is the next manifest pallet. Wrong pallets are rejected without mutation or quota cost. Success costs one handling action.', parameters: emptyParameters(), strict: true }
    ];
}

/** In-memory stack planning with immutable shipped pallets and no hidden state changes. */
export class DepotAssessmentSimulator implements AssessmentSimulator {
    private readonly config: AssessmentDepotConfig;
    private stacks: Record<string, string[]>;
    private truck: string[] = [];
    private handlingActions = 0;
    private invalidAttempts = 0;
    private inspections = 0;
    history: AssessmentSimulator['history'] = [];

    constructor(config: unknown) {
        this.config = depotConfig(config);
        this.stacks = Object.fromEntries(Object.entries(this.config.locations).map(([name, location]) => [name, [...location.stack]]));
    }

    private goal(): boolean {
        const remaining = Object.values(this.stacks).flat().sort();
        return this.handlingActions > 0 && this.handlingActions <= this.config.max_successful_handling_actions
            && this.truck.length === this.config.manifest.length && this.truck.every((pallet, index) => pallet === this.config.manifest[index])
            && remaining.length === this.config.retained_pallets.length && remaining.every((pallet, index) => pallet === [...this.config.retained_pallets].sort()[index])
            && this.config.empty_at_completion.every(name => this.stacks[name]!.length === 0);
    }

    private snapshot(): DepotObject {
        return structuredClone({ ...this.config, locations: Object.fromEntries(Object.entries(this.config.locations).map(([name, location]) => [name, { capacity: location.capacity, stack: this.stacks[name] }])), stacks: this.stacks, truck: this.truck, handling_actions: this.handlingActions,
            remaining_handling_actions: this.config.max_successful_handling_actions - this.handlingActions,
            status: this.goal() ? 'complete' : this.handlingActions >= this.config.max_successful_handling_actions ? 'handling_limit_reached' : 'in_progress' });
    }

    call(name: string, args: unknown): DepotObject {
        let error: string | null = null, pallet: string | undefined;
        if (!object(args)) error = 'arguments must be an object';
        else if (name === 'inspect_depot' && exactFields(args, [])) this.inspections++;
        else if (!((name === 'move_top' && exactFields(args, ['source', 'destination'])) || (name === 'dispatch_top' && exactFields(args, [])))) error = 'unknown tool or invalid argument fields';
        else if (this.goal()) error = 'shipment already complete';
        else if (this.handlingActions >= this.config.max_successful_handling_actions) error = 'handling allowance exhausted';
        else if (name === 'move_top') {
            const { source, destination } = args;
            if (typeof source !== 'string' || typeof destination !== 'string' || !Object.hasOwn(this.stacks, source) || !Object.hasOwn(this.stacks, destination)) error = 'unknown location';
            else if (!this.config.routes.some(([from, to]) => from === source && to === destination)) error = 'route not permitted';
            else if (!this.stacks[source]!.length) error = 'source stack is empty';
            else {
                const top = this.stacks[source]!.at(-1)!;
                const used = this.stacks[destination]!.reduce((total, id) => total + this.config.pallet_sizes[id]!, 0);
                if (this.config.pallet_sizes[top]! > this.config.locations[destination]!.capacity - used) error = 'destination capacity exceeded';
                else { pallet = this.stacks[source]!.pop()!; this.stacks[destination]!.push(pallet); this.handlingActions++; }
            }
        } else {
            const stage = this.stacks[this.config.dispatch_location]!;
            if (!stage.length) error = 'dispatch stack is empty';
            else if (stage.at(-1) !== this.config.manifest[this.truck.length]) error = 'top pallet is not the next manifest pallet';
            else { pallet = stage.pop()!; this.truck.push(pallet); this.handlingActions++; }
        }
        if (error) this.invalidAttempts++;
        const result = { ok: error === null, ...(error ? { error } : {}), ...(pallet ? { pallet } : {}), ...this.snapshot() };
        let recordedArguments: unknown;
        try { recordedArguments = structuredClone(args); } catch { recordedArguments = null; }
        this.history.push({ name, arguments: recordedArguments, result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(text: unknown): AssessmentGrade {
        const { assessment_result, parse_assessment_answer, assessment_exact_fields } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const [answer, instructions, problem] = parse_assessment_answer(text);
        const goal = this.goal();
        const expectedStatus = goal ? 'complete' : 'incomplete';
        instructions.exact_fields = problem === null && answer !== null && assessment_exact_fields(answer, ['status', 'truck', 'handling_actions']);
        const truthful = instructions.exact_fields && answer !== null
            && answer.status === expectedStatus && answer.handling_actions === this.handlingActions
            && Array.isArray(answer.truck) && answer.truck.length === this.truck.length && answer.truck.every((pallet, index) => pallet === this.truck[index]);
        const result = assessment_result({ goal_reached: goal }, instructions, null, Number(goal));
        result.tool_checks = { goal_reached: goal, used_tools: this.history.length > 0, observed_depot: this.inspections > 0,
            no_invalid_attempts: this.invalidAttempts === 0, within_handling_allowance: this.handlingActions <= this.config.max_successful_handling_actions,
            final_report_truthful: truthful };
        result.tool_calls = this.history.length;
        return result;
    }
}

/** Attach depot tools and an independently cloned simulator factory to a serializable card. */
export function configure_assessment_depot_task(card: AssessmentTask, config: unknown): AssessmentTask {
    const validated = depotConfig(config);
    card.kind = 'tool';
    card.tools = assessment_depot_tools();
    card.make_simulator = () => new DepotAssessmentSimulator(validated);
    card.grade = () => ({ content_score: null, content_checks: {}, instruction_checks: {}, tool_checks: {}, outcome: 'ungradable', reason: 'Use the same depot simulator instance that received real tool calls.' });
    return card;
}
