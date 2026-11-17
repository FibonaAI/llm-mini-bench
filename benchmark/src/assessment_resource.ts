import type { AssessmentGrade, AssessmentSimulator, AssessmentTask } from './assessment_tasks.ts';

/** Declarative resource-network task format shared by every bank version. */
export const ASSESSMENT_RESOURCE_TASK_FORMAT = 'assessment-resource-v1';
type ResourceObject = Record<string, unknown>;
type ResourceNode = { stock: number; protected_min: number; capacity: number; tainted: boolean; quarantine_certified: boolean; revision: number };
type ResourceConfig = {
    nodes: Record<string, ResourceNode>;
    routes: [string, string][];
    max_units_per_transfer: number;
    on_first_touch: Record<string, { protected_min: number }>;
    expected_answer: { status: string; stock: Record<string, number>; tainted_nodes: string[] };
};
type ResourceHistory = { name: string; arguments: unknown; result: ResourceObject }[];
const object = (value: unknown): value is ResourceObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function requireResource(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Assessment resource task ' + reason); }
const exactFields = (value: ResourceObject, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

function resourceConfig(value: unknown): ResourceConfig {
    requireResource(object(value) && exactFields(value, ['nodes', 'routes', 'max_units_per_transfer', 'on_first_touch', 'expected_answer']), 'requires a complete declarative configuration');
    const nodes = value.nodes;
    requireResource(object(nodes) && Object.keys(nodes).length > 0, 'requires nodes');
    for (const [id, node] of Object.entries(nodes)) {
        requireResource(/^[A-Za-z][A-Za-z0-9_]*$/.test(id) && object(node) && exactFields(node, ['stock', 'protected_min', 'capacity', 'tainted', 'quarantine_certified', 'revision']), 'has an invalid node: ' + id);
        requireResource(integer(node.stock) && integer(node.protected_min) && integer(node.capacity) && integer(node.revision) && node.revision > 0, 'node numbers must be nonnegative integers with positive revision: ' + id);
        requireResource(node.protected_min <= node.stock && node.stock <= node.capacity && typeof node.tainted === 'boolean' && typeof node.quarantine_certified === 'boolean', 'has inconsistent stock, capacity or flags: ' + id);
    }
    requireResource(Array.isArray(value.routes) && value.routes.every(route => Array.isArray(route) && route.length === 2 && route.every(id => typeof id === 'string' && Object.hasOwn(nodes, id))), 'routes must reference known nodes');
    requireResource(integer(value.max_units_per_transfer) && value.max_units_per_transfer > 0, 'max_units_per_transfer must be positive');
    requireResource(object(value.on_first_touch) && Object.entries(value.on_first_touch).every(([id, update]) => Object.hasOwn(nodes, id) && object(update) && exactFields(update, ['protected_min']) && integer(update.protected_min) && update.protected_min >= 0 && update.protected_min <= (nodes[id] as ResourceNode).stock), 'has an invalid first-touch conflict');
    const expected = value.expected_answer;
    requireResource(object(expected) && exactFields(expected, ['status', 'stock', 'tainted_nodes']) && typeof expected.status === 'string'
        && object(expected.stock) && exactFields(expected.stock, Object.keys(nodes)) && Object.values(expected.stock).every(integer)
        && Array.isArray(expected.tainted_nodes) && expected.tainted_nodes.every(id => typeof id === 'string' && Object.hasOwn(nodes, id)), 'has an invalid expected final answer');
    return structuredClone(value) as ResourceConfig;
}

/** Strict tool schemas for inspecting and mutating a declarative resource network. */
export function assessment_resource_tools(): ResourceObject[] {
    return [
        { type: 'function', name: 'inspect_network', description: 'Inspect all node stocks, reserves, capacities, contamination flags, routes and revisions.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
        { type: 'function', name: 'transfer_relay', description: 'Transfer stock using current source and destination revisions; conflicts return authoritative node state.', parameters: {
            type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, units: { type: 'integer' }, source_revision: { type: 'integer' }, destination_revision: { type: 'integer' } },
            required: ['source', 'destination', 'units', 'source_revision', 'destination_revision'], additionalProperties: false }, strict: true }
    ];
}

/** Fixed in-memory resource state machine; model answers never become executable code. */
export class ResourceAssessmentSimulator implements AssessmentSimulator {
    readonly config: ResourceConfig;
    nodes: Record<string, ResourceNode>;
    history: ResourceHistory = [];
    invalid_attempts = 0;
    inspected = false;
    private conflicted = new Set<string>();

    constructor(config: unknown) {
        this.config = resourceConfig(config);
        this.nodes = structuredClone(this.config.nodes);
    }

    private snapshot(): ResourceObject {
        return { nodes: structuredClone(this.nodes), routes: structuredClone(this.config.routes), max_units_per_transfer: this.config.max_units_per_transfer };
    }

    private conflict(nodeId: string): ResourceObject {
        this.conflicted.add(nodeId);
        this.nodes[nodeId]!.protected_min = this.config.on_first_touch[nodeId]!.protected_min;
        this.nodes[nodeId]!.revision++;
        return { ok: false, error: 'revision_conflict', ...this.snapshot() };
    }

    call(name: string, args: unknown): ResourceObject {
        let result: ResourceObject;
        if (!object(args)) {
            result = { ok: false, error: 'arguments must be an object' }; this.invalid_attempts++;
        } else if (name === 'inspect_network' && exactFields(args, [])) {
            this.inspected = true; result = { ok: true, ...this.snapshot() };
        } else if (name !== 'transfer_relay' || !exactFields(args, ['source', 'destination', 'units', 'source_revision', 'destination_revision'])) {
            result = { ok: false, error: 'unknown tool or invalid argument fields' }; this.invalid_attempts++;
        } else {
            const { source, destination, units, source_revision, destination_revision } = args;
            if (typeof source !== 'string' || typeof destination !== 'string' || !Object.hasOwn(this.nodes, source) || !Object.hasOwn(this.nodes, destination)) {
                result = { ok: false, error: 'unknown node' }; this.invalid_attempts++;
            } else {
                const conflict = this.config.on_first_touch[source] && !this.conflicted.has(source) ? source : this.config.on_first_touch[destination] && !this.conflicted.has(destination) ? destination : null;
                if (conflict) result = this.conflict(conflict);
                else if (!integer(units) || units < 1 || units > this.config.max_units_per_transfer || !integer(source_revision) || !integer(destination_revision)) {
                    result = { ok: false, error: 'invalid quantity or revisions' }; this.invalid_attempts++;
                } else if (source_revision !== this.nodes[source]!.revision || destination_revision !== this.nodes[destination]!.revision) {
                    result = { ok: false, error: 'revision_conflict', ...this.snapshot() };
                } else if (!this.config.routes.some(([from, to]) => from === source && to === destination)) {
                    result = { ok: false, error: 'route not permitted' }; this.invalid_attempts++;
                } else if (this.nodes[source]!.tainted && !this.nodes[destination]!.quarantine_certified) {
                    result = { ok: false, error: 'destination is not quarantine certified' }; this.invalid_attempts++;
                } else if (this.nodes[source]!.stock - units < this.nodes[source]!.protected_min) {
                    result = { ok: false, error: 'protected reserve would be violated' }; this.invalid_attempts++;
                } else if (this.nodes[destination]!.stock + units > this.nodes[destination]!.capacity) {
                    result = { ok: false, error: 'destination capacity exceeded' }; this.invalid_attempts++;
                } else {
                    this.nodes[source]!.stock -= units; this.nodes[destination]!.stock += units;
                    if (this.nodes[source]!.tainted) this.nodes[destination]!.tainted = true;
                    this.nodes[source]!.revision++; this.nodes[destination]!.revision++;
                    result = { ok: true, ...this.snapshot() };
                }
            }
        }
        this.history.push({ name, arguments: structuredClone(args), result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(text: unknown): AssessmentGrade {
        const { assessment_result, parse_assessment_answer, _matches_answer, assessment_exact_fields } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const [obj, instructions, problem] = parse_assessment_answer(text);
        const expected = this.config.expected_answer;
        const stockMatches = Object.entries(expected.stock).every(([id, value]) => this.nodes[id]!.stock === value);
        const expectedTainted = Object.keys(this.nodes).filter(id => this.nodes[id]!.tainted).sort();
        const goal = stockMatches && JSON.stringify(expectedTainted) === JSON.stringify(expected.tainted_nodes);
        const truthful = problem === null && _matches_answer(obj, expected);
        instructions.exact_fields = problem === null && obj !== null && assessment_exact_fields(obj, Object.keys(expected));
        const usedConflict = this.history.some(call => call.result.error === 'revision_conflict') && goal;
        const checks = { goal_reached: goal, truthful_final: truthful, observed_network: this.inspected, used_conflict_feedback: usedConflict, no_invalid_attempts: this.invalid_attempts === 0 };
        const result = assessment_result(checks, instructions, null, this.history.length ? null : 0);
        if (problem) result.outcome = problem;
        result.tool_checks = { goal_reached: goal, observed_network: this.inspected, conflict_seen: this.history.some(call => call.result.error === 'revision_conflict'), no_invalid_attempts: this.invalid_attempts === 0, final_report_truthful: truthful };
        result.tool_calls = this.history.length;
        return result;
    }
}

/** Attach a declarative simulator and tool schema to a serializable resource task card. */
export function configure_assessment_resource_task(card: AssessmentTask, config: unknown): AssessmentTask {
    resourceConfig(config);
    card.kind = 'tool';
    card.tools = assessment_resource_tools();
    card.make_simulator = () => new ResourceAssessmentSimulator(config);
    card.grade = () => ({ content_score: null, content_checks: {}, instruction_checks: {}, tool_checks: {}, outcome: 'ungradable', reason: 'Use the same resource simulator instance that received real tool calls.' });
    return card;
}
