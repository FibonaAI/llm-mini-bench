/** Resettable in-memory tool environments; never execute model code or access external resources. */
import type { AssessmentTask, AssessmentGrade, AssessmentSimulator } from './assessment_tasks.ts';
import { assessmentJsonNumberToken } from './assessment_json.ts';

type ToolRecord = Record<string, unknown>;
type ToolHistory = { name: string; arguments: unknown; result: ToolRecord };
type InventoryStock = Record<'A' | 'B' | 'C', number>;
type BookingRoom = 'S' | 'L' | 'A';
type MeetingBooking = { status: string; room: BookingRoom; start: number; duration: number };

function isObject(value: unknown): value is ToolRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value: ToolRecord, fields: string[]): boolean {
    return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}

function isBookingRoom(value: unknown): value is BookingRoom {
    return value === 'S' || value === 'L' || value === 'A';
}

function isInteger(value: unknown, container: object, key: string): value is number {
    const token = assessmentJsonNumberToken(container, key);
    return typeof value === 'number' && Number.isInteger(value) && (token === undefined || !/[.eE]/.test(token));
}

function truthfulFields(obj: ToolRecord | null, expected: ToolRecord): boolean {
    const { _matches_answer } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
    return obj !== null && Object.entries(expected).every(([key, value]) =>
        Object.hasOwn(obj, key) && _matches_answer(obj[key], value));
}

function stockTotal(stock: InventoryStock): number {
    return stock.A + stock.B + stock.C;
}

/** Build a strict Responses function schema requiring every declared property. */
export function _function_schema(name: string, description: string, properties: ToolRecord): ToolRecord {
    return { type: 'function', name, description,
        parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
        strict: true };
}

/** Inventory tools operate only on the simulator's protected stock. */
export const INVENTORY_TOOLS = [
    _function_schema('inspect_inventory', 'Read all current stocks, protected reserves, capacity and legal transfer routes.', {}),
    _function_schema('transfer_stock', 'Transfer a positive integer quantity along a permitted route. Errors leave state unchanged.',
        { source: { type: 'string' }, destination: { type: 'string' }, units: { type: 'integer' } }),
];

/** Booking tools expose authoritative revision feedback for optimistic concurrency. */
export const BOOKING_TOOLS = [
    _function_schema('list_rooms', 'List room IDs and equipment/capacity; does not reserve a room.', {}),
    _function_schema('room_availability', 'Read current free integer-hour slots and revision for one room.',
        { room: { type: 'string' } }),
    _function_schema('reserve_room', 'Reserve consecutive slots using the observed revision. On conflict, read returned current availability and retry if feasible.',
        { room: { type: 'string' }, start: { type: 'integer' }, duration: { type: 'integer' }, revision: { type: 'integer' } }),
];

/** Protect warehouse reserves while assessing a feasible or impossible delivery goal. */
export class InventoryAssessmentSimulator implements AssessmentSimulator {
    stock: InventoryStock;
    initial: InventoryStock;
    reserves: InventoryStock = { A: 2, B: 1, C: 0 };
    history: ToolHistory[] = [];
    invalid_attempts = 0;
    inspected = false;

    constructor(feasible = true) {
        this.stock = { A: feasible ? 5 : 3, B: 2, C: 1 };
        this.initial = { ...this.stock };
    }

    _snapshot(): ToolRecord {
        return { stock: { ...this.stock }, protected_minimum: { ...this.reserves },
            capacity: { A: 10, B: 10, C: 5 }, routes: [['A', 'C'], ['B', 'C']], max_units_per_transfer: 3 };
    }

    call(name: string, args: unknown): ToolRecord {
        let result: ToolRecord;
        if (!isObject(args)) {
            result = { ok: false, error: 'arguments must be an object' };
        } else if (name === 'inspect_inventory' && exactFields(args, [])) {
            this.inspected = true;
            result = { ok: true, ...this._snapshot() };
        } else if (name === 'transfer_stock' && exactFields(args, ['source', 'destination', 'units'])) {
            const { source, destination, units } = args;
            if ((source !== 'A' && source !== 'B') || destination !== 'C'
                || !isInteger(units, args, 'units') || units < 1 || units > 3) {
                result = { ok: false, error: 'invalid route or quantity' };
            } else if (this.stock[source] - units < this.reserves[source]) {
                result = { ok: false, error: 'protected reserve would be violated' };
            } else if (this.stock.C + units > 5) {
                result = { ok: false, error: 'destination capacity exceeded' };
            } else {
                this.stock[source] -= units;
                this.stock.C += units;
                result = { ok: true, ...this._snapshot() };
            }
        } else {
            result = { ok: false, error: 'unknown tool or invalid argument fields' };
        }
        if (!result.ok) this.invalid_attempts += 1;
        this.history.push({ name, arguments: structuredClone(args), result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(final_text: unknown): AssessmentGrade {
        const { assessment_result, parse_assessment_answer } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const [obj, instructions, problem] = parse_assessment_answer(final_text);
        const max_c = Math.min(5, this.initial.C + this.initial.A - this.reserves.A + this.initial.B - this.reserves.B);
        const feasible = max_c >= 5;
        const goal = feasible ? this.stock.C === 5 : max_c < 5;
        const expected = feasible ? { status: 'done', stock: this.stock } : { status: 'impossible', max_C: max_c };
        const truthful = problem === null && truthfulFields(obj, expected);
        instructions.exact_fields = problem === null && obj !== null && exactFields(obj, Object.keys(expected));
        const invariants = stockTotal(this.stock) === stockTotal(this.initial)
            && (Object.keys(this.reserves) as (keyof InventoryStock)[]).every(key => this.stock[key] >= this.reserves[key])
            && this.stock.C <= 5;
        const checks = { goal_or_infeasibility: goal, truthful_final: truthful,
            observed_inventory: this.inspected, invariants_and_no_invalid_attempt: invariants && this.invalid_attempts === 0 };
        const result = assessment_result(checks, instructions, null, this.history.length ? null : 0);
        if (problem) result.outcome = problem;
        result.tool_checks = { queried_state: this.inspected, no_invalid_attempts: this.invalid_attempts === 0,
            state_invariants: invariants, goal_feasible: feasible, goal_reached: this.stock.C === 5, final_report_truthful: truthful };
        result.tool_calls = this.history.length;
        return result;
    }
}

/** Require feedback-aware booking after one explicitly modeled external revision change. */
export class BookingAssessmentSimulator implements AssessmentSimulator {
    rooms = { S: { capacity: 4, projector: true }, L: { capacity: 8, projector: true }, A: { capacity: 10, projector: false } };
    free: Record<BookingRoom, number[]> = { S: [9, 10, 11], L: [9, 10, 11], A: [9, 10, 11] };
    revisions: Record<BookingRoom, number> = { S: 1, L: 1, A: 1 };
    booking: MeetingBooking | null = null;
    external_change_done = false;
    history: ToolHistory[] = [];
    invalid_attempts = 0;
    feedback_seen = false;

    _availability(room: BookingRoom): ToolRecord {
        return { room, ...this.rooms[room], free_slots: [...this.free[room]], revision: this.revisions[room] };
    }

    call(name: string, args: unknown): ToolRecord {
        let result: ToolRecord;
        let invalid = false;
        if (!isObject(args)) {
            result = { ok: false, error: 'arguments must be an object' };
            invalid = true;
        } else if (name === 'list_rooms' && exactFields(args, [])) {
            result = { ok: true, rooms: Object.entries(this.rooms).map(([room, data]) => ({ room, ...data })) };
        } else if (name === 'room_availability' && exactFields(args, ['room'])) {
            const { room } = args;
            if (isBookingRoom(room)) {
                result = { ok: true, ...this._availability(room) };
            } else {
                result = { ok: false, error: 'unknown room' };
                invalid = true;
            }
        } else if (name === 'reserve_room' && exactFields(args, ['room', 'start', 'duration', 'revision'])) {
            const { room, start, duration, revision } = args;
            if (!isBookingRoom(room) || !isInteger(start, args, 'start') || !isInteger(duration, args, 'duration')
                || !isInteger(revision, args, 'revision')
                || start < 9 || start >= 12 || duration < 1 || duration > 3 || start + duration > 12 || revision < 1) {
                result = { ok: false, error: 'invalid booking arguments' };
                invalid = true;
            } else if (this.booking !== null) {
                result = { ok: false, error: 'only one meeting may be booked' };
                invalid = true;
            } else if (this.rooms[room].capacity < 8 || !this.rooms[room].projector) {
                result = { ok: false, error: 'room violates meeting requirements' };
                invalid = true;
            } else if (revision !== this.revisions[room]) {
                this.feedback_seen = true;
                result = { ok: false, error: 'revision_conflict', ...this._availability(room) };
            } else if (!Array.from({ length: duration }, (_, index) => start + index).every(slot => this.free[room].includes(slot))) {
                result = { ok: false, error: 'requested slots are occupied' };
                invalid = true;
            } else if (!this.external_change_done) {
                // A valid request races with an external booking; this is not an invalid action.
                this.external_change_done = true;
                this.free.L.splice(this.free.L.indexOf(9), 1);
                this.revisions.L += 1;
                this.feedback_seen = true;
                result = { ok: false, error: 'revision_conflict', ...this._availability(room) };
            } else {
                for (let slot = start; slot < start + duration; slot++) {
                    this.free[room].splice(this.free[room].indexOf(slot), 1);
                }
                this.revisions[room] += 1;
                this.booking = { status: 'booked', room, start, duration };
                result = { ok: true, booking_id: 'booking-1', ...this.booking };
            }
        } else {
            result = { ok: false, error: 'unknown tool or invalid argument fields' };
            invalid = true;
        }
        if (invalid) this.invalid_attempts += 1;
        this.history.push({ name, arguments: structuredClone(args), result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(final_text: unknown): AssessmentGrade {
        const { assessment_result, parse_assessment_answer } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const [obj, instructions, problem] = parse_assessment_answer(final_text);
        const goal = this.booking !== null && this.booking.status === 'booked' && this.booking.room === 'L'
            && this.booking.start === 10 && this.booking.duration === 2;
        const truthful = problem === null && this.booking !== null && truthfulFields(obj, this.booking);
        instructions.exact_fields = problem === null && this.booking !== null && obj !== null
            && exactFields(obj, Object.keys(this.booking));
        const checks = { meeting_reserved: goal, truthful_final: truthful,
            used_conflict_feedback: this.feedback_seen && goal, no_invalid_attempts: this.invalid_attempts === 0 };
        const result = assessment_result(checks, instructions, null, this.history.length ? null : 0);
        if (problem) result.outcome = problem;
        result.tool_checks = { goal_reached: goal, feedback_seen: this.feedback_seen,
            observed_room_information: this.history.some(call => Object.hasOwn(call.result, 'rooms') || Object.hasOwn(call.result, 'capacity')),
            observed_availability: this.history.some(call => Object.hasOwn(call.result, 'free_slots')),
            no_invalid_attempts: this.invalid_attempts === 0,
            external_booking_preserved: !this.external_change_done || !this.free.L.includes(9), final_report_truthful: truthful };
        result.tool_calls = this.history.length;
        return result;
    }
}

/** Text alone cannot establish execution; use the simulator that received the sample's calls. */
export function grade_tool_without_trace(_text: unknown): AssessmentGrade {
    return { content_score: null, content_checks: {}, instruction_checks: {}, tool_checks: {},
        outcome: 'ungradable', reason: 'Use the same simulator instance that received real tool calls.' };
}

/** Construct an independent protected-stock task without sharing mutable tool schemas. */
export function _inventory_task(identifier: string, feasible: boolean): AssessmentTask {
    return {
        "domain": "tool_use",
        "kind": "tool",
        "version": "assessment-tools-0.1",
        "difficulty_intent": "query hidden state, plan transfers under reserves/capacity, or prove impossibility",
        "prompt": "Use the inventory tools to get warehouse C to exactly 5 units. Preserve all protected minimum stocks, do not exceed capacities, and use only allowed routes and per-transfer quantities. Initial stocks are not supplied; inspect them. There is no external stock source. If achievable, finish with an answer object {\"status\":\"done\",\"stock\":{\"A\":integer,\"B\":integer,\"C\":integer}} matching actual stock. If impossible, do not attempt an illegal transfer: report {\"status\":\"impossible\",\"max_C\":integer}, where max_C is the maximum achievable C stock under the rules. Legal transfers may be split or reordered.",
        "source": [
            "Author-defined deterministic in-memory inventory specification"
        ],
        "measurement": {
            "necessary_operations": [
                "query state",
                "compute transferable surplus",
                "plan legal actions or infeasibility"
            ],
            "confounds": "Feasible/impossible variants are a shared family, not independent dimensions. Tool unsupported is a runner outcome.",
            "status": "uncalibrated candidate"
        },
        "scoring_rule": "Equal mean of state feasibility/goal, truthful final report, observed inventory, and invariant/no-invalid-attempt checks. No calls scores zero. Also retain full tool_checks; no trace-string matching.",
        id: identifier,
        title: feasible ? 'Protected-stock delivery' : 'Protected-stock infeasibility',
        tools: structuredClone(INVENTORY_TOOLS),
        make_simulator: () => new InventoryAssessmentSimulator(feasible),
        grade: grade_tool_without_trace,
    };
}

/** Tool task cards retain the original prompts and per-task stateful grading contract. */
export const ASSESSMENT_TOOL_TASKS: AssessmentTask[] = [
    _inventory_task('T01_Inventory_Feasible', true),
    _inventory_task('T02_Inventory_Impossible', false),
    {
        "id": "T03_Booking_Feedback",
        "title": "Reserve a meeting despite a revision conflict",
        "domain": "tool_use",
        "kind": "tool",
        "version": "assessment-tools-0.1",
        "difficulty_intent": "tool selection, optimistic concurrency, feedback adaptation",
        "prompt": "Book exactly one 2-hour meeting for 8 people in a room with a projector. Start must be an integer hour, at or after 9, and end no later than 12. Discover rooms and availability through tools. Use revisions when reserving. Another user may reserve a slot between your read and write; a revision_conflict returns authoritative current availability and revision. Adapt to feedback; never overwrite existing bookings, and do not book an unsuitable room. Finish with an answer object {\"status\":\"booked\",\"room\":string,\"start\":integer,\"duration\":integer} matching the actual reservation, or report impossibility if no legal slot exists.",
        "source": [
            "Author-defined deterministic in-memory booking specification"
        ],
        "measurement": {
            "necessary_operations": [
                "select a suitable room",
                "read revision",
                "react to conflict",
                "reserve remaining legal slots"
            ],
            "confounds": "One fixed external change; not real distributed-systems reliability or long-horizon agency.",
            "status": "uncalibrated candidate"
        },
        "scoring_rule": "Equal mean of actual correct reservation, truthful final report, successful conflict recovery and no invalid attempts; retain full tool_checks. No calls scores zero. Room/availability evidence may come from queries or authoritative conflict feedback.",
        tools: structuredClone(BOOKING_TOOLS),
        make_simulator: () => new BookingAssessmentSimulator(),
        grade: grade_tool_without_trace,
    },
];
