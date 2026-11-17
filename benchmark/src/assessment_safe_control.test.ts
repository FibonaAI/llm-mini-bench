import { describe, expect, test } from 'bun:test';
import { parseAssessmentJson } from './assessment_json.ts';
import {
    ASSESSMENT_SAFE_CONTROL_TASK_FORMAT,
    SafeControlAssessmentSimulator,
    assessment_safe_control_tools,
    configure_assessment_safe_control_task,
    type AssessmentSafeControlConfig,
    type AssessmentSafeControlWorld
} from './assessment_safe_control.ts';
import type { AssessmentTask } from './assessment_tasks.ts';

type Command = 'A+' | 'A-' | 'B+' | 'B-';
const commands: Command[] = ['A+', 'A-', 'B+', 'B-'];
const config: AssessmentSafeControlConfig = {
    limit: 3,
    sensor_divisor: 3,
    hidden_world: 'W2',
    worlds: [
        { id: 'W1', initial: [-3, -1], A: [0, 1], B: [1, 1] },
        { id: 'W2', initial: [0, -3], A: [1, 0], B: [1, -1] },
        { id: 'W3', initial: [-1, 3], A: [1, 0], B: [1, -1] },
        { id: 'W4', initial: [1, -3], A: [1, 0], B: [0, 1] }
    ]
};
const inspect = (sim: SafeControlAssessmentSimulator) => sim.call('inspect_fixture', {});
const pulse = (sim: SafeControlAssessmentSimulator, command: Command) => sim.call('pulse_motor', { command });
const dock = (sim: SafeControlAssessmentSimulator) => sim.call('dock_fixture', {});
function physical(reply: Record<string, unknown>) {
    const { ok, error, event, ...reading } = reply;
    return reading;
}
function report(reply: Record<string, unknown>) {
    return JSON.stringify(physical(reply));
}

// Author certificate verified independently by explicit belief-state reachability
// and cumulative-motor-count feasibility. Decisions here use only sensor replies,
// never the hidden world ID. Safe opposite-pulse detours provide a second policy.
function centerByHistory(sim: SafeControlAssessmentSimulator, detours = 0, stopAtFirstZero = false): Record<string, unknown> {
    let reading = inspect(sim);
    const step = (command: Command) => {
        reading = pulse(sim, command);
        expect(reading).toMatchObject({ ok: true, status: 'operating' });
        return stopAtFirstZero && reading.strain_band === 0;
    };
    for (let i = 0; i < detours; i++) {
        step('A+');
        step('A-');
    }
    step('A-');
    let tail: Command[];
    if (reading.strain_band === 4) tail = ['A-', 'B+', 'B+', 'B+'];
    else {
        expect(reading.strain_band).toBe(3);
        step('A+');
        step('A+');
        if (reading.strain_band === 3) tail = ['A+', 'A+', 'B-', 'B-', 'B-'];
        else {
            expect(reading.strain_band).toBe(4);
            tail = ['A-', 'A-', 'B+', 'B+', 'B+'];
        }
    }
    for (const command of tail) if (step(command)) break;
    return reading;
}

// Independent closed-form geometry used only by tests, not the runtime engine.
function cumulativePose(world: AssessmentSafeControlWorld, countA: number, countB: number): [number, number] {
    return [world.initial[0] + countA * world.A[0] + countB * world.B[0], world.initial[1] + countA * world.A[1] + countB * world.B[1]];
}
function safeBeliefs() {
    type Belief = { candidates: number[]; countA: number; countB: number; prefix: Command[] };
    const key = (belief: Belief) =>
        belief.candidates.map(index => [index, ...cumulativePose(config.worlds[index]!, belief.countA, belief.countB)].join(',')).join('|');
    const beliefs: Belief[] = [{ candidates: config.worlds.map((_, index) => index), countA: 0, countB: 0, prefix: [] }];
    const seen = new Set([key(beliefs[0]!)]);
    for (let index = 0; index < beliefs.length; index++) {
        const belief = beliefs[index]!;
        for (const command of commands) {
            const countA = belief.countA + (command[0] === 'A' ? (command[1] === '+' ? 1 : -1) : 0);
            const countB = belief.countB + (command[0] === 'B' ? (command[1] === '+' ? 1 : -1) : 0);
            const poses = belief.candidates.map(world => ({ world, pose: cumulativePose(config.worlds[world]!, countA, countB) }));
            if (poses.some(({ pose }) => pose.some(component => Math.abs(component) > config.limit))) continue;
            const grouped = new Map<number, number[]>();
            for (const { world, pose } of poses) {
                const band = Math.floor((pose[0] ** 2 + pose[1] ** 2) / config.sensor_divisor);
                grouped.set(band, [...(grouped.get(band) ?? []), world]);
            }
            for (const candidates of grouped.values()) {
                const next = { candidates, countA, countB, prefix: [...belief.prefix, command] };
                const nextKey = key(next);
                if (!seen.has(nextKey)) {
                    seen.add(nextKey);
                    beliefs.push(next);
                }
            }
        }
    }
    return beliefs;
}

describe('generic safe physical fixture control', () => {
    test('two history-only policies deliver every world, including routes far longer than the certificate', () => {
        for (const world of config.worlds)
            for (const detours of [0, 100]) {
                const sim = new SafeControlAssessmentSimulator({ ...config, hidden_world: world.id });
                expect(inspect(sim)).toMatchObject({ status: 'operating', strain_band: 3, pulses: 0 });
                const centered = centerByHistory(sim, detours);
                expect(sim.grade(report(centered))).toMatchObject({
                    content_score: 0.5,
                    content_checks: { undamaged_and_centered: true, delivered: false }
                });
                const delivered = dock(sim);
                expect(delivered).toMatchObject({
                    ok: true,
                    event: 'docked',
                    status: 'delivered',
                    strain_band: 0,
                    pulses: centered.pulses
                });
                expect(sim.grade(report(delivered))).toMatchObject({
                    content_score: 1,
                    tool_checks: { observed_fixture: true, no_invalid_attempts: true, final_report_truthful: true }
                });
                if (detours) expect(delivered.pulses).toBeGreaterThan(200);
                expect(sim.grade('not JSON')).toMatchObject({
                    content_score: 1,
                    instruction_checks: { json_only: false },
                    tool_checks: { final_report_truthful: false }
                });
                expect(pulse(sim, 'A+')).toMatchObject({ ok: false, status: 'delivered', pulses: delivered.pulses });
                expect(dock(sim).ok).toBe(false);
                expect(physical(inspect(sim))).toEqual(physical(delivered));
            }
    });

    test('all 152 safe beliefs and 1,050 physical actions agree with independent cumulative geometry', () => {
        const beliefs = safeBeliefs();
        expect(beliefs).toHaveLength(152);
        let actions = 0,
            damaging = 0;
        for (const belief of beliefs)
            for (const worldIndex of belief.candidates)
                for (const command of [...commands, 'dock'] as const) {
                    const world = config.worlds[worldIndex]!,
                        sim = new SafeControlAssessmentSimulator({ ...config, hidden_world: world.id });
                    for (const prefix of belief.prefix) expect(pulse(sim, prefix).status).toBe('operating');
                    const [x, y] = cumulativePose(world, belief.countA, belief.countB);
                    let nx = x,
                        ny = y,
                        pulses = belief.prefix.length;
                    if (command !== 'dock') {
                        const vector = command[0] === 'A' ? world.A : world.B,
                            sign = command[1] === '+' ? 1 : -1;
                        nx += sign * vector[0];
                        ny += sign * vector[1];
                        pulses++;
                    }
                    const damaged = command === 'dock' ? nx !== 0 || ny !== 0 : Math.abs(nx) > config.limit || Math.abs(ny) > config.limit;
                    const status = damaged ? 'damaged' : command === 'dock' ? 'delivered' : 'operating';
                    const reading = command === 'dock' ? dock(sim) : pulse(sim, command);
                    expect(reading).toMatchObject({
                        ok: true,
                        status,
                        strain_band: damaged ? null : Math.floor((nx * nx + ny * ny) / config.sensor_divisor),
                        pulses
                    });
                    const expectedScore = damaged ? 0 : command === 'dock' ? 1 : nx === 0 && ny === 0 ? 0.5 : 0;
                    expect(sim.grade(report(reading))).toMatchObject({
                        content_score: expectedScore,
                        tool_checks: { no_invalid_attempts: true, final_report_truthful: true }
                    });
                    if (damaged) {
                        damaging++;
                        expect(pulse(sim, 'B-')).toMatchObject({ ok: false, pulses });
                        expect(dock(sim)).toMatchObject({ ok: false, pulses });
                        expect(physical(inspect(sim))).toEqual(physical(reading));
                    }
                    actions++;
                }
        expect(actions).toBe(1050);
        expect(damaging).toBe(368);
    });

    test('the first zero band is not alignment and premature docking permanently damages all worlds', () => {
        for (const world of config.worlds) {
            const sim = new SafeControlAssessmentSimulator({ ...config, hidden_world: world.id });
            const zero = centerByHistory(sim, 0, true);
            expect(zero.strain_band).toBe(0);
            expect(sim.grade(report(zero)).content_score).toBe(0);
            const damaged = dock(sim);
            expect(damaged).toMatchObject({ ok: true, event: 'docking_damage', status: 'damaged', strain_band: null, pulses: zero.pulses });
            expect(sim.grade(report(damaged))).toMatchObject({
                content_score: 0,
                tool_checks: { undamaged: false, no_invalid_attempts: true }
            });
            expect(pulse(sim, 'A-').ok).toBe(false);
        }
    });

    test('unsafe valid pulses execute, count once and cause irreversible travel damage', () => {
        const sim = new SafeControlAssessmentSimulator(config);
        expect(pulse(sim, 'B+')).toMatchObject({ ok: true, event: 'travel_damage', status: 'damaged', strain_band: null, pulses: 1 });
        expect(sim.grade('{"status":"damaged","strain_band":null,"pulses":1}')).toMatchObject({
            content_score: 0,
            tool_checks: { no_invalid_attempts: true, final_report_truthful: true }
        });
        expect(pulse(sim, 'B-')).toMatchObject({ ok: false, status: 'damaged', pulses: 1 });
        expect(dock(sim)).toMatchObject({ ok: false, status: 'damaged', pulses: 1 });
        for (let i = 0; i < 100; i++) expect(inspect(sim)).toMatchObject({ ok: true, status: 'damaged', strain_band: null, pulses: 1 });
    });

    test('invalid names, arguments and tool JSON reject atomically without executing supplied code', () => {
        const sim = new SafeControlAssessmentSimulator(config),
            before = physical(inspect(sim));
        let executed = false;
        const attempts: [string, unknown][] = [
            ['pulse_motor', { command: 'C+' }],
            ['pulse_motor', { command: 'A' }],
            ['pulse_motor', { command: ['A+'] }],
            ['pulse_motor', { command: 'constructor' }],
            ['pulse_motor', { command: 'A+', count: 2 }],
            ['pulse_motor', {}],
            [
                'pulse_motor',
                {
                    command: () => {
                        executed = true;
                        return 'A+';
                    }
                }
            ],
            ['pulse_motor', '{"command":"A+","command":"B+"}'],
            ['inspect_fixture', { coordinates: true }],
            ['dock_fixture', { force: true }],
            ['inspect_fixture', null],
            ['inspect_fixture', []],
            ['inspect_fixture', Object.create({})],
            ['reset', {}],
            ['repair', {}],
            ['get_world', {}],
            ['get_coordinates', {}],
            ['eval', { code: 'throw new Error()' }]
        ];
        for (const [name, args] of attempts) {
            expect(sim.call(name, args).ok).toBe(false);
            expect(physical(inspect(sim))).toEqual(before);
        }
        expect(executed).toBe(false);
        expect(() => parseAssessmentJson('{"command":"A+","command":"B+"}')).toThrow('duplicate');
        expect(physical(inspect(sim))).toEqual(before);
        expect(pulse(sim, 'A-')).toMatchObject({ ok: true, pulses: 1 });
    });

    test('actual half and full credit are independent of final JSON, integer spelling and truthfulness', () => {
        const sim = new SafeControlAssessmentSimulator(config);
        expect(sim.grade('{"status":"delivered","strain_band":0,"pulses":0}')).toMatchObject({
            content_score: 0,
            tool_checks: { final_report_truthful: false, used_tools: false, observed_fixture: false }
        });
        const centered = centerByHistory(sim),
            valid = report(centered);
        expect(sim.grade(valid)).toMatchObject({
            content_score: 0.5,
            instruction_checks: { json_only: true, exact_fields: true },
            tool_checks: { final_report_truthful: true }
        });
        for (const malformed of ['done', '{"status":"operating","status":"delivered","strain_band":0,"pulses":8}', valid + '\n{}']) {
            expect(sim.grade(malformed)).toMatchObject({
                content_score: 0.5,
                instruction_checks: { json_only: false },
                tool_checks: { final_report_truthful: false }
            });
        }
        expect(sim.grade(valid.replace('"strain_band":0', '"strain_band":0.0')).tool_checks!.final_report_truthful).toBe(false);
        expect(sim.grade(valid.replace(/"pulses":\d+/, '"pulses":8e0')).tool_checks!.final_report_truthful).toBe(false);
        expect(sim.grade(valid.replace('}', ',"extra":true}'))).toMatchObject({
            content_score: 0.5,
            instruction_checks: { exact_fields: false },
            tool_checks: { final_report_truthful: false }
        });
        dock(sim);
        expect(sim.grade('{"status":"damaged","strain_band":null,"pulses":999}').content_score).toBe(1);
        const initialCenter = new SafeControlAssessmentSimulator({
            limit: 1,
            sensor_divisor: 1,
            hidden_world: 'center',
            worlds: [{ id: 'center', initial: [0, 0], A: [0, 0], B: [0, 0] }]
        });
        expect(initialCenter.grade('plan only').content_score).toBe(0.5);
        expect(dock(initialCenter)).toMatchObject({ status: 'delivered', pulses: 0 });
        expect(initialCenter.grade('plan only').content_score).toBe(1);
    });

    test('all tool replies expose only readings, never hidden geometry, model IDs or configuration', () => {
        const allowed = new Set(['ok', 'error', 'event', 'status', 'strain_band', 'pulses']);
        for (const world of config.worlds) {
            const sim = new SafeControlAssessmentSimulator({ ...config, hidden_world: world.id });
            for (const reply of [inspect(sim), pulse(sim, 'A-'), sim.call('get_world', {}), dock(sim), inspect(sim)]) {
                expect(Object.keys(reply).every(key => allowed.has(key))).toBe(true);
                const serialized = JSON.stringify(reply);
                for (const forbidden of ['hidden_world', 'worlds', 'initial', 'coordinates', world.id])
                    expect(serialized).not.toContain(forbidden);
            }
        }
        // The rotationally equivalent candidates must remain indistinguishable.
        const first = new SafeControlAssessmentSimulator({ ...config, hidden_world: 'W1' }),
            third = new SafeControlAssessmentSimulator({ ...config, hidden_world: 'W3' });
        for (const command of ['A-', 'A-', 'B+', 'B+', 'B+'] as Command[]) expect(pulse(first, command)).toEqual(pulse(third, command));
        expect(dock(first)).toEqual(dock(third));
    });

    test('configuration, response, history, factory and schema clones are isolated', () => {
        const data = structuredClone(config),
            card = {} as AssessmentTask;
        expect(ASSESSMENT_SAFE_CONTROL_TASK_FORMAT).toBe('assessment-safe-control-v1');
        configure_assessment_safe_control_task(card, data);
        data.hidden_world = 'W1';
        data.worlds[1]!.initial[0] = 100;
        data.worlds[1]!.A[0] = 100;
        const first = card.make_simulator!(),
            second = card.make_simulator!();
        const args = { command: 'A-' },
            reply = first.call('pulse_motor', args);
        args.command = 'B+';
        reply.pulses = 100;
        first.history[0]!.result.strain_band = 999;
        expect(first.history[0]!.arguments).toEqual({ command: 'A-' });
        expect(first.call('inspect_fixture', {})).toMatchObject({ pulses: 1, strain_band: 3 });
        expect(second.call('inspect_fixture', {})).toMatchObject({ pulses: 0, strain_band: 3 });
        expect(card.grade('delivered')).toMatchObject({ content_score: null, outcome: 'ungradable' });
        const tools = assessment_safe_control_tools();
        expect(tools.map(tool => tool.name)).toEqual(['inspect_fixture', 'pulse_motor', 'dock_fixture']);
        for (const tool of tools) {
            expect(tool.strict).toBe(true);
            expect((tool.parameters as Record<string, unknown>).additionalProperties).toBe(false);
        }
        expect(tools[1]!.parameters).toMatchObject({ properties: { command: { enum: commands } }, required: ['command'] });
        (tools[1]!.parameters as Record<string, unknown>).properties = {};
        expect(assessment_safe_control_tools()[1]!.parameters).toHaveProperty('properties.command.enum');
    });

    test('strict validation and exact arithmetic cover finite, integer and precision boundaries', () => {
        const mutations: ((data: AssessmentSafeControlConfig) => void)[] = [
            data => {
                (data as unknown as Record<string, unknown>).extra = true;
            },
            data => {
                data.limit = 0;
            },
            data => {
                data.limit = -1;
            },
            data => {
                data.limit = 1.5;
            },
            data => {
                data.limit = Infinity;
            },
            data => {
                data.limit = NaN;
            },
            data => {
                data.limit = Number.MAX_SAFE_INTEGER + 1;
            },
            data => {
                data.sensor_divisor = 0;
            },
            data => {
                data.sensor_divisor = 1.5;
            },
            data => {
                data.sensor_divisor = Infinity;
            },
            data => {
                data.limit = Number.MAX_SAFE_INTEGER;
            },
            data => {
                data.hidden_world = 'missing';
            },
            data => {
                data.worlds = [];
            },
            data => {
                data.worlds = new Array(1);
            },
            data => {
                data.worlds[0]!.id = 'W2';
            },
            data => {
                data.worlds[0]!.id = '';
            },
            data => {
                data.worlds[0]!.initial = [4, 0];
            },
            data => {
                data.worlds[0]!.A = [Infinity, 0];
            },
            data => {
                data.worlds[0]!.B = [NaN, 0];
            },
            data => {
                data.worlds[0]!.initial = new Array(2) as [number, number];
            },
            data => {
                data.worlds[0]!.A = [0.5, 0];
            },
            data => {
                data.worlds[0]!.B = [Number.MAX_SAFE_INTEGER + 1, 0];
            },
            data => {
                (data.worlds[0] as unknown as Record<string, unknown>).extra = true;
            }
        ];
        for (const mutate of mutations) {
            const data = structuredClone(config);
            mutate(data);
            expect(() => new SafeControlAssessmentSimulator(data)).toThrow('Assessment safe control task');
        }
        for (const bad of [null, [], {}, Object.create(config)])
            expect(() => new SafeControlAssessmentSimulator(bad)).toThrow('Assessment safe control task');
        const large = new SafeControlAssessmentSimulator({
            limit: 100000000,
            sensor_divisor: 3,
            hidden_world: 'large',
            worlds: [{ id: 'large', initial: [100000000, 100000000], A: [Number.MAX_SAFE_INTEGER, 0], B: [0, 0] }]
        });
        expect(inspect(large)).toMatchObject({ status: 'operating', strain_band: 6666666666666666, pulses: 0 });
        expect(pulse(large, 'A+')).toMatchObject({ ok: true, status: 'damaged', strain_band: null, pulses: 1 });
    });
});
