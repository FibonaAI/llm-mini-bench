import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

// Fixed finite simulator only: no model-generated code is evaluated.
// Five CAS sites execute at most once each. For M >= 5 a successful CAS
// cannot follow a tag wrap since its snapshot: at most four other updates
// can intervene. B8 changes only B's held first node until a successful push.
// Induction on successful updates therefore preserves node ownership.
const NIL = 4;
type StackState = {
    head: number;
    tag: number;
    next: number[];
    ptr: number[];
    seenTag: number[];
    link: number[];
    out: number[];
    pushed: boolean;
};
type TerminalDistribution = Map<string, { state: StackState; schedules: number }>;
type StackTerminalProperties = { duplicateHeld: boolean; resurrected: boolean; badWithFailedPop: boolean; badWithFailedPush: boolean };
const emptyStackProperties = (): StackTerminalProperties => ({
    duplicateHeld: false,
    resurrected: false,
    badWithFailedPop: false,
    badWithFailedPush: false
});
function accumulateStackProperties(summary: StackTerminalProperties, properties: StackTerminalProperties): void {
    for (const name of Object.keys(summary) as (keyof StackTerminalProperties)[]) summary[name] ||= properties[name];
}
const threadLengths = [3, 9, 3];

function initialStackState(): StackState {
    return {
        head: 0,
        tag: 0,
        next: [1, 2, 3, NIL],
        ptr: Array(5).fill(NIL),
        seenTag: Array(5).fill(0),
        link: Array(5).fill(NIL),
        out: Array(5).fill(NIL),
        pushed: false
    };
}
function cloneStackState(state: StackState): StackState {
    return {
        ...state,
        next: [...state.next],
        ptr: [...state.ptr],
        seenTag: [...state.seenTag],
        link: [...state.link],
        out: [...state.out]
    };
}
function stackStateKey(state: StackState): string {
    return JSON.stringify([state.head, state.tag, state.next, state.ptr, state.seenTag, state.link, state.out, state.pushed]);
}

// Formulation 1: a product-program transition system, merged by complete state.
// Operation slots are A-pop, B-first-pop, B-second-pop, B-push, C-pop.
function transitionStackState(state: StackState, thread: number, pc: number, modulus: number): void {
    const operation = thread === 0 ? 0 : thread === 2 ? 4 : 1 + Math.floor(pc / 3);
    const phase = thread === 1 ? pc % 3 : pc;
    if ((operation === 2 || operation === 3) && state.out[1] === NIL) return;
    if (operation === 3) {
        if (phase === 0) {
            state.ptr[3] = state.head;
            state.seenTag[3] = state.tag;
        }
        if (phase === 1) state.next[state.out[1]] = state.ptr[3];
        if (phase === 2 && state.head === state.ptr[3] && state.tag === state.seenTag[3]) {
            state.head = state.out[1];
            state.tag = (state.tag + 1) % modulus;
            state.pushed = true;
        }
    } else {
        if (phase === 0) {
            state.ptr[operation] = state.head;
            state.seenTag[operation] = state.tag;
        }
        if (phase === 1 && state.ptr[operation] !== NIL) state.link[operation] = state.next[state.ptr[operation]];
        if (phase === 2 && state.ptr[operation] !== NIL && state.head === state.ptr[operation] && state.tag === state.seenTag[operation]) {
            state.head = state.link[operation];
            state.tag = (state.tag + 1) % modulus;
            state.out[operation] = state.ptr[operation];
        }
    }
}
function analyzeStateGraph(modulus: number): { terminals: TerminalDistribution; graphStates: number } {
    type FrontierEntry = { state: StackState; pc: number[]; schedules: number };
    const initial = initialStackState();
    let frontier = new Map<string, FrontierEntry>([[stackStateKey(initial) + '|0,0,0', { state: initial, pc: [0, 0, 0], schedules: 1 }]]);
    let graphStates = 1;
    for (let depth = 0; depth < 15; depth++) {
        const following = new Map<string, FrontierEntry>();
        for (const entry of frontier.values()) {
            for (let thread = 0; thread < 3; thread++) {
                if (entry.pc[thread] === threadLengths[thread]) continue;
                const state = cloneStackState(entry.state);
                transitionStackState(state, thread, entry.pc[thread], modulus);
                const pc = [...entry.pc];
                pc[thread]++;
                const key = stackStateKey(state) + '|' + pc.join(',');
                const prior = following.get(key);
                if (prior) prior.schedules += entry.schedules;
                else following.set(key, { state, pc, schedules: entry.schedules });
            }
        }
        graphStates += following.size;
        frontier = following;
    }
    return {
        terminals: new Map(
            [...frontier.values()].map(entry => [stackStateKey(entry.state), { state: entry.state, schedules: entry.schedules }])
        ),
        graphStates
    };
}

// Formulation 2: enumerate disjoint position sets for A and C, then execute a
// separately coded flat-register interpreter. No transition function, initial
// state builder, or graph search from formulation 1 is reused here.
function* triples(values: number[]): Generator<number[]> {
    for (let i = 0; i < values.length; i++)
        for (let j = i + 1; j < values.length; j++) for (let k = j + 1; k < values.length; k++) yield [values[i], values[j], values[k]];
}
function replayFlatEvent(r: number[], event: number, modulus: number): void {
    // head=0, tag=1, next=2..5, ptr=6..10, tag-read=11..15,
    // next-read=16..20, returned-node=21..25, push-success=26.
    const readHead = (op: number) => {
        r[6 + op] = r[0];
        r[11 + op] = r[1];
    };
    const readLink = (op: number) => {
        if (r[6 + op] !== 4) r[16 + op] = r[2 + r[6 + op]];
    };
    const popCas = (op: number) => {
        if (r[6 + op] !== 4 && r[0] === r[6 + op] && r[1] === r[11 + op]) {
            r[0] = r[16 + op];
            r[1] = (r[11 + op] + 1) % modulus;
            r[21 + op] = r[6 + op];
        }
    };
    switch (event) {
        case 0:
            readHead(0);
            break;
        case 1:
            readLink(0);
            break;
        case 2:
            popCas(0);
            break;
        case 3:
            readHead(1);
            break;
        case 4:
            readLink(1);
            break;
        case 5:
            popCas(1);
            break;
        case 6:
            if (r[22] !== 4) readHead(2);
            break;
        case 7:
            if (r[22] !== 4) readLink(2);
            break;
        case 8:
            if (r[22] !== 4) popCas(2);
            break;
        case 9:
            if (r[22] !== 4) readHead(3);
            break;
        case 10:
            if (r[22] !== 4) r[2 + r[22]] = r[9];
            break;
        case 11:
            if (r[22] !== 4 && r[0] === r[9] && r[1] === r[14]) {
                r[0] = r[22];
                r[1] = (r[14] + 1) % modulus;
                r[26] = 1;
            }
            break;
        case 12:
            readHead(4);
            break;
        case 13:
            readLink(4);
            break;
        case 14:
            popCas(4);
            break;
        default:
            throw new Error('Stack oracle invalid event');
    }
}
function analyzeSchedulePositions(modulus: number): {
    counts: Map<string, number>;
    unsafeTuples: string[];
    unsafeByState: Map<string, boolean>;
    propertiesByState: Map<string, StackTerminalProperties>;
} {
    const positions = Array.from({ length: 15 }, (_, i) => i);
    const counts = new Map<string, number>();
    const unsafeTuples = new Set<string>();
    const unsafeByState = new Map<string, boolean>();
    const propertiesByState = new Map<string, StackTerminalProperties>();
    for (const a of triples(positions)) {
        const aSlots = new Set(a);
        const remainder = positions.filter(position => !aSlots.has(position));
        for (const c of triples(remainder)) {
            const cSlots = new Set(c);
            const r = [0, 0, 1, 2, 3, 4, ...Array(5).fill(4), ...Array(5).fill(0), ...Array(5).fill(4), ...Array(5).fill(4), 0];
            let aPc = 0,
                bPc = 3,
                cPc = 12;
            for (let position = 0; position < 15; position++) {
                replayFlatEvent(r, aSlots.has(position) ? aPc++ : cSlots.has(position) ? cPc++ : bPc++, modulus);
            }
            const key = JSON.stringify([
                r[0],
                r[1],
                r.slice(2, 6),
                r.slice(6, 11),
                r.slice(11, 16),
                r.slice(16, 21),
                r.slice(21, 26),
                r[26] === 1
            ]);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            // Independent multiplicity-based ownership check.
            const seen = [0, 0, 0, 0];
            let node = r[0],
                cycle = false;
            while (node !== 4) {
                if (seen[node] !== 0) {
                    cycle = true;
                    break;
                }
                seen[node]++;
                node = r[2 + node];
            }
            const reached = [...seen],
                ownedCounts = [0, 0, 0, 0];
            for (const owned of [r[21], r[25], r[23], r[26] === 0 ? r[22] : 4])
                if (owned !== 4) {
                    seen[owned]++;
                    ownedCounts[owned]++;
                }
            const unsafe = cycle || seen.some(count => count !== 1);
            unsafeByState.set(key, unsafe);
            // Derive semantic predicates directly from flat registers and separate
            // reachability/ownership counts, without the graph's set predicates.
            propertiesByState.set(key, {
                duplicateHeld: ownedCounts.some(count => count > 1),
                resurrected: ownedCounts.some((count, node) => count > 0 && reached[node] > 0),
                badWithFailedPop: unsafe && (r[21] === 4 || r[25] === 4 || r[23] === 4),
                badWithFailedPush: unsafe && r[22] !== 4 && r[26] === 0
            });
            if (unsafe) unsafeTuples.add(JSON.stringify([r[21], r[25], r[23], r[0]]));
        }
    }
    return { counts, unsafeTuples: [...unsafeTuples].sort(), unsafeByState, propertiesByState };
}
function inspectTerminalState(state: StackState): {
    unsafe: boolean;
    tuple: number[];
    defects: number;
    properties: StackTerminalProperties;
} {
    const held = [state.out[0], state.out[4], state.out[2], state.pushed ? NIL : state.out[1]].filter(node => node !== NIL);
    const chain = new Set<number>();
    let node = state.head;
    while (node !== NIL && !chain.has(node)) {
        chain.add(node);
        node = state.next[node];
    }
    const duplicateReturns = held.length !== new Set(held).size;
    const resurrectedNode = held.some(value => chain.has(value));
    const allNodes = new Set([...held, ...chain]);
    const unsafe = node !== NIL || duplicateReturns || resurrectedNode || allNodes.size !== 4;
    return {
        unsafe,
        tuple: [state.out[0], state.out[4], state.out[2], state.head],
        defects: Number(duplicateReturns) + 2 * Number(resurrectedNode) + 4 * Number(allNodes.size !== 4),
        properties: {
            duplicateHeld: duplicateReturns,
            resurrected: resurrectedNode,
            badWithFailedPop: unsafe && [state.out[0], state.out[4], state.out[2]].includes(NIL),
            badWithFailedPush: unsafe && state.out[1] !== NIL && !state.pushed
        }
    };
}

type StackOracleResult = {
    graph: ReturnType<typeof analyzeStateGraph>;
    replay: ReturnType<typeof analyzeSchedulePositions>;
    schedules: number;
    unsafeSchedules: number;
    unsafeTuples: number[][];
    graphProperties: StackTerminalProperties;
    replayProperties: StackTerminalProperties;
    replayUnsafeSchedules: number;
};
const oracleResults = new Map<number, StackOracleResult>();
function analyzeTaggedStack(modulus: number): StackOracleResult {
    const cached = oracleResults.get(modulus);
    if (cached) return cached;
    const graph = analyzeStateGraph(modulus);
    const replay = analyzeSchedulePositions(modulus);
    const tuples = new Set<string>();
    const graphProperties = emptyStackProperties(),
        replayProperties = emptyStackProperties();
    let schedules = 0,
        unsafeSchedules = 0,
        replayUnsafeSchedules = 0;
    for (const entry of graph.terminals.values()) {
        schedules += entry.schedules;
        const result = inspectTerminalState(entry.state);
        accumulateStackProperties(graphProperties, result.properties);
        if (result.unsafe) {
            unsafeSchedules += entry.schedules;
            tuples.add(JSON.stringify(result.tuple));
        }
    }
    for (const [key, properties] of replay.propertiesByState) {
        accumulateStackProperties(replayProperties, properties);
        if (replay.unsafeByState.get(key)) replayUnsafeSchedules += replay.counts.get(key)!;
    }
    const result = {
        graph,
        replay,
        schedules,
        unsafeSchedules,
        graphProperties,
        replayProperties,
        replayUnsafeSchedules,
        unsafeTuples: [...tuples].sort().map(value => JSON.parse(value) as number[])
    };
    oracleResults.set(modulus, result);
    return result;
}

describe('Assessment 2.1 tagged-stack independent finite oracles', () => {
    const unsafeScheduleCounts = [15750, 120, 15630, 120, 0, 0, 0, 0];
    for (let modulus = 1; modulus <= 8; modulus++) {
        test('M=' + modulus + ' agrees on every terminal state, schedule count and ownership result', () => {
            const { graph, replay, schedules, unsafeSchedules, unsafeTuples, graphProperties, replayProperties, replayUnsafeSchedules } =
                analyzeTaggedStack(modulus);
            expect(graph.graphStates).toBeGreaterThan(1000);
            expect(graph.terminals.size).toBe(replay.counts.size);
            for (const [key, entry] of graph.terminals) {
                expect(replay.counts.get(key)).toBe(entry.schedules);
                const graphResult = inspectTerminalState(entry.state);
                expect(replay.unsafeByState.get(key)).toBe(graphResult.unsafe);
                expect(replay.propertiesByState.get(key)).toEqual(graphResult.properties);
            }
            // 15! / (3! * 9! * 3!), including events whose condition is false.
            expect(schedules).toBe(100100);
            expect([...replay.counts.values()].reduce((sum, count) => sum + count, 0)).toBe(100100);
            expect(unsafeSchedules).toBe(unsafeScheduleCounts[modulus - 1]);
            expect(replayUnsafeSchedules).toBe(unsafeSchedules);
            expect(replayProperties).toEqual(graphProperties);
            expect(unsafeTuples.map(tuple => JSON.stringify(tuple))).toEqual(replay.unsafeTuples);
            if (modulus >= 5) {
                expect(unsafeSchedules).toBe(0);
                expect(unsafeTuples).toEqual([]);
            } else {
                expect(unsafeSchedules).toBeGreaterThan(0);
            }
        });
    }
});

test('Assessment 2.1 tagged-stack task matches the independently computed exact fields', () => {
    const bank = load_assessment_bank('2.1');
    const task = bank.tasks.find(candidate => candidate.id === 'C2_Tagged_Stack_ABA');
    expect(task).toBeDefined();
    if (!task) throw new Error('Assessment 2.1 is missing C2_Tagged_Stack_ABA');
    const moduli = Array.from({ length: 8 }, (_, index) => index + 1);
    const minimumSafeModulus = moduli.find(modulus => analyzeTaggedStack(modulus).unsafeSchedules === 0);
    const minimumSafeTagBits = [0, 1, 2, 3].find(bits => analyzeTaggedStack(2 ** bits).unsafeSchedules === 0);
    const replayMinimumSafeModulus = moduli.find(modulus => analyzeTaggedStack(modulus).replayUnsafeSchedules === 0);
    const replayMinimumSafeTagBits = [0, 1, 2, 3].find(bits => analyzeTaggedStack(2 ** bits).replayUnsafeSchedules === 0);
    expect(minimumSafeModulus).toBe(5);
    expect(minimumSafeTagBits).toBe(3);
    expect(replayMinimumSafeModulus).toBe(minimumSafeModulus);
    expect(replayMinimumSafeTagBits).toBe(minimumSafeTagBits);
    const expected = {
        m2_duplicate_held_possible: analyzeTaggedStack(2).graphProperties.duplicateHeld,
        m3_duplicate_held_possible: analyzeTaggedStack(3).graphProperties.duplicateHeld,
        m2_resurrection_possible: analyzeTaggedStack(2).graphProperties.resurrected,
        m3_bad_with_failed_pop_possible: analyzeTaggedStack(3).graphProperties.badWithFailedPop,
        m1_bad_after_failed_push_possible: analyzeTaggedStack(1).graphProperties.badWithFailedPush,
        minimum_safe_modulus: minimumSafeModulus,
        minimum_safe_tag_bits: minimumSafeTagBits
    };
    expect(Object.values(expected)).toEqual([false, true, true, true, false, 5, 3]);
    expect(task.grading).toEqual({ type: 'assessment-exact-fields-v1', name: 'grade', expected });
    const grade = task.grade(JSON.stringify(expected));
    expect(grade.content_score).toBe(1);
    expect(Object.values(grade.content_checks).every(Boolean)).toBe(true);
    expect(grade.instruction_checks).toEqual({ json_only: true, exact_fields: true });
});
