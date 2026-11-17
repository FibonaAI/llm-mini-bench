/** Differential fixtures preserve Python simulator traces, cards and final grading. */
import { describe, expect, test } from 'bun:test';
import {
    ASSESSMENT_TOOL_TASKS,
    InventoryAssessmentSimulator,
    BookingAssessmentSimulator,
    _inventory_task,
    grade_tool_without_trace
} from '../src/assessment_tools.ts';
import fixture from './fixtures/assessment-tools.json';
import rawArgumentFixture from './fixtures/assessment-tools-raw-arguments.json';
import { parseAssessmentJson } from '../src/assessment_json.ts';
import type { AssessmentGrade } from '../src/assessment_tasks.ts';

type ToolRecord = Record<string, unknown>;
type FixtureScenario = {
    kind: string;
    steps: { name: unknown; arguments: unknown; result: ToolRecord; state: ToolRecord }[];
    state: ToolRecord;
    grades: { answer: unknown; grade: AssessmentGrade }[];
};

function simulatorFor(kind: string) {
    return kind === 'booking' ? new BookingAssessmentSimulator() : new InventoryAssessmentSimulator(kind === 'inventory_feasible');
}

function simulatorState(sim: InventoryAssessmentSimulator | BookingAssessmentSimulator) {
    return Object.fromEntries(Object.entries(sim));
}

describe('assessment tools Python differential fixtures', () => {
    test('cards and schemas are byte-for-byte equivalent strings and structures', () => {
        const cards = ASSESSMENT_TOOL_TASKS.map(task =>
            Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function'))
        );
        expect(cards).toEqual(fixture.cards);
    });

    for (const [index, scenario] of (fixture.scenarios as FixtureScenario[]).entries()) {
        test(`${scenario.kind} trace ${index}: calls, state, history and grades`, () => {
            const sim = simulatorFor(scenario.kind);
            for (const step of scenario.steps) {
                // Deliberately exercise non-string names at the untyped input boundary.
                expect(sim.call(step.name as string, step.arguments)).toEqual(step.result);
                expect(simulatorState(sim)).toEqual(step.state);
            }
            expect(simulatorState(sim)).toEqual(scenario.state);
            for (const { answer, grade } of scenario.grades) {
                expect(sim.grade(answer)).toEqual(grade);
            }
        });
    }
});

describe('assessment tools raw argument number spelling parity', () => {
    for (const scenario of rawArgumentFixture.scenarios) {
        test(`${scenario.key}: ${scenario.raw_arguments}`, () => {
            const sim = simulatorFor(scenario.kind);
            expect(simulatorState(sim)).toEqual(scenario.initial);
            const before =
                sim instanceof InventoryAssessmentSimulator
                    ? { stock: structuredClone(sim.stock) }
                    : {
                          free: structuredClone(sim.free),
                          revisions: { ...sim.revisions },
                          booking: sim.booking,
                          external_change_done: sim.external_change_done,
                          feedback_seen: sim.feedback_seen
                      };
            expect(sim.call(scenario.name, parseAssessmentJson(scenario.raw_arguments))).toEqual(scenario.result);
            expect(simulatorState(sim)).toEqual(scenario.state);
            if (scenario.state.invalid_attempts > 0) {
                expect(sim.invalid_attempts).toBe(1);
                for (const [key, value] of Object.entries(before)) {
                    expect(simulatorState(sim)[key]).toEqual(value);
                }
                expect(sim.history).toHaveLength(1);
            }
        });
    }
});

describe('assessment tools safety and independent invariants', () => {
    test('strict schemas, ungradable text-only answers and independent factories', () => {
        for (const task of ASSESSMENT_TOOL_TASKS) {
            expect(task.kind).toBe('tool');
            expect(task).not.toHaveProperty('effort');
            expect(task).not.toHaveProperty('thinking');
            const first = task.make_simulator!();
            const second = task.make_simulator!();
            expect(first).not.toBe(second);
            expect(first.history).not.toBe(second.history);
            expect(task.grade('I used the tools').outcome).toBe('ungradable');
            for (const tool of task.tools as {
                type: string;
                strict: boolean;
                parameters: {
                    additionalProperties: boolean;
                    required: string[];
                    properties: ToolRecord;
                };
            }[]) {
                expect(tool.type).toBe('function');
                expect(tool.strict).toBe(true);
                expect(tool.parameters.additionalProperties).toBe(false);
                expect([...tool.parameters.required].sort()).toEqual(Object.keys(tool.parameters.properties).sort());
            }
        }
        const first = _inventory_task('custom', true);
        const second = _inventory_task('custom', true);
        expect(first.id).toBe('custom');
        expect(first.tools).not.toBe(second.tools);
        expect(grade_tool_without_trace(null).content_score).toBeNull();
    });

    test('inventory feasibility is independently exhausted', () => {
        for (const feasible of [true, false]) {
            const sim = new InventoryAssessmentSimulator(feasible);
            const achievable: number[] = [];
            for (let a = 0; a <= sim.initial.A; a++) {
                for (let b = 0; b <= sim.initial.B; b++) {
                    if (sim.initial.A - a >= 2 && sim.initial.B - b >= 1 && sim.initial.C + a + b <= 5) {
                        achievable.push(sim.initial.C + a + b);
                    }
                }
            }
            expect(Math.max(...achievable)).toBe(feasible ? 5 : 3);
        }
    });

    test('all legal surplus transfer orderings succeed without trace matching', () => {
        for (const path of [
            [
                ['A', 3],
                ['B', 1]
            ],
            [
                ['B', 1],
                ['A', 1],
                ['A', 2]
            ],
            [
                ['A', 2],
                ['B', 1],
                ['A', 1]
            ]
        ]) {
            const sim = new InventoryAssessmentSimulator();
            sim.call('inspect_inventory', {});
            for (const [source, units] of path) {
                expect(sim.call('transfer_stock', { source, destination: 'C', units }).ok).toBe(true);
            }
            const grade = sim.grade('Completed legally. {"status":"done","stock":{"A":2,"B":1,"C":5}}');
            expect(grade.content_score).toBe(1);
            expect(grade.outcome).toBe('correct');
            expect(grade.instruction_checks.json_only).toBe(false);
        }
    });

    test('inventory results and arguments cannot mutate state or stored history', () => {
        const sim = new InventoryAssessmentSimulator();
        const result = sim.call('inspect_inventory', {});
        (result.stock as ToolRecord).A = 900;
        (result.protected_minimum as ToolRecord).A = 0;
        expect(sim.stock.A).toBe(5);
        expect(sim.reserves.A).toBe(2);
        expect((sim.history[0]!.result.stock as ToolRecord).A).toBe(5);
        const args = { source: 'A', destination: 'C', units: 1 };
        sim.call('transfer_stock', args);
        args.units = 100;
        expect((sim.history[1]!.arguments as ToolRecord).units).toBe(1);
    });

    test('booking returned room information and availability are isolated', () => {
        const sim = new BookingAssessmentSimulator();
        const listed = sim.call('list_rooms', {});
        (listed.rooms as ToolRecord[])[1]!.capacity = 100;
        const available = sim.call('room_availability', { room: 'L' });
        (available.free_slots as number[]).splice(0);
        available.revision = 99;
        expect(sim.rooms.L.capacity).toBe(8);
        expect(sim.free.L).toEqual([9, 10, 11]);
        expect(sim.revisions.L).toBe(1);
        expect(sim.history[1]!.result.free_slots).toEqual([9, 10, 11]);
        const conflict = sim.call('reserve_room', { room: 'L', start: 9, duration: 2, revision: 1 });
        (conflict.free_slots as number[]).push(9);
        expect(sim.free.L).toEqual([10, 11]);
        expect(sim.invalid_attempts).toBe(0);
    });

    test('nonfinite and fractional quantities, prototype names, and booleans are rejected atomically', () => {
        for (const units of [NaN, Infinity, -Infinity, 1.5, true, false]) {
            const inventory = new InventoryAssessmentSimulator();
            const before = { ...inventory.stock };
            expect(inventory.call('transfer_stock', { source: 'A', destination: 'C', units }).ok).toBe(false);
            expect(inventory.stock).toEqual(before);
            expect(inventory.invalid_attempts).toBe(1);
        }
        for (const room of ['constructor', '__proto__', 'toString']) {
            const sim = new BookingAssessmentSimulator();
            expect(sim.call('room_availability', { room })).toEqual({ ok: false, error: 'unknown room' });
            expect(sim.call('reserve_room', { room, start: 9, duration: 2, revision: 1 }).ok).toBe(false);
            expect(sim.external_change_done).toBe(false);
            expect(sim.booking).toBeNull();
        }
    });
});
