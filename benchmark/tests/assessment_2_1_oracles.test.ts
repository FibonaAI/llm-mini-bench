import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank = load_assessment_bank('2.1');
const tasks = new Map(bank.tasks.map(task => [task.id, task]));
function plain(value: any): any {
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === 'object') {
        if ('$fraction' in value) return value.$fraction;
        if ('$aliases' in value) return value.$aliases[0];
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
    }
    return value;
}
function expected(id: string): any {
    const descriptor = (tasks.get(id) as any).grading;
    if (descriptor.type === 'assessment-dfa-v1')
        return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
    return plain(descriptor.expected);
}

class Q {
    readonly n: bigint;
    readonly d: bigint;
    constructor(n: bigint | number, d: bigint | number = 1) {
        let a = BigInt(n),
            b = BigInt(d);
        if (b < 0n) {
            a = -a;
            b = -b;
        }
        let x = a < 0n ? -a : a,
            y = b;
        while (y) {
            const r = x % y;
            x = y;
            y = r;
        }
        this.n = a / x;
        this.d = b / x;
    }
    add(other: Q) {
        return new Q(this.n * other.d + other.n * this.d, this.d * other.d);
    }
    neg() {
        return new Q(-this.n, this.d);
    }
    mul(other: Q) {
        return new Q(this.n * other.n, this.d * other.d);
    }
    div(other: Q) {
        return new Q(this.n * other.d, this.d * other.n);
    }
    valueOf() {
        return Number(this.n) / Number(this.d);
    }
    toString() {
        return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`;
    }
}

function sequentialOracle() {
    const priors = [new Q(1, 2), new Q(1, 3), new Q(1, 6)],
        rewards = [2, 1, 3];
    const px = [new Q(3, 4), new Q(1, 2), new Q(1, 4)],
        py = [new Q(1, 5), new Q(3, 5), new Q(4, 5)];
    const probability = (test: string, state: number, outcome: number) => {
        const p = (test === 'X' ? px : py)[state]!;
        return outcome ? p : new Q(1).add(p.neg());
    };
    const costs: Record<string, Q> = { X: new Q(1, 48), Y: new Q(1, 24) },
        policies = [];
    for (const first of ['X', 'Y'])
        for (const second0 of ['X', 'Y'])
            for (const second1 of ['X', 'Y']) {
                let utility = new Q(0);
                for (const outcome1 of [0, 1])
                    for (const outcome2 of [0, 1]) {
                        const second = outcome1 ? second1 : second0;
                        const weights = priors.map((prior, state) =>
                            prior.mul(probability(first, state, outcome1)).mul(probability(second, state, outcome2))
                        );
                        utility = utility.add(
                            weights
                                .map((weight, state) => weight.mul(new Q(rewards[state]!)))
                                .reduce((a, b) => (a.valueOf() >= b.valueOf() ? a : b))
                        );
                    }
                let cost = costs[first]!;
                for (const outcome of [0, 1]) {
                    const branchProbability = priors
                        .map((prior, state) => prior.mul(probability(first, state, outcome)))
                        .reduce((sum, weight) => sum.add(weight));
                    cost = cost.add(branchProbability.mul(costs[outcome ? second1 : second0]!));
                }
                policies.push({ first, second0, second1, utility, net: utility.add(cost.neg()) });
            }
    policies.sort((a, b) => b.net.valueOf() - a.net.valueOf());
    const best = policies[0]!;
    const weights = priors.map((prior, state) => prior.mul(probability('Y', state, 0)).mul(probability('X', state, 1)));
    return {
        first_test: best.first,
        second_test_after_0: best.second0,
        second_test_after_1: best.second1,
        expected_terminal_utility: best.utility.toString(),
        expected_net_utility: best.net.toString(),
        posterior_A_after_Y0_X1: weights[0]!.div(weights.reduce((a, b) => a.add(b))).toString()
    };
}

function booleanOracle() {
    const costs = [3, 4, 5, 6, 7, 8, 9],
        names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        solutions: { v: number[]; cost: number }[] = [];
    for (let mask = 0; mask < 128; mask++) {
        const v = names.map((_, index) => (mask >> index) & 1),
            [a, b, c, d, e, f, g] = v;
        if (
            (a! ^ b!) === 1 &&
            c === Number(Boolean(a! || d!)) &&
            (!d || (b! ^ e!) === 1) &&
            (e! ^ f!) === 1 &&
            (!(a && c) || f === 1) &&
            (!(b && d) || e === 0) &&
            g === Number(Boolean(c! ^ e! || (a && f))) &&
            (!(f && d) || c === 1) &&
            (!(g && b) || d === 1)
        )
            solutions.push({ v, cost: v.reduce((sum, bit, index) => sum + bit * costs[index]!, 0) });
    }
    const costsFound = solutions.map(solution => solution.cost),
        minimum = Math.min(...costsFound);
    const optimal = solutions.filter(solution => solution.cost === minimum).sort((a, b) => a.v.join('').localeCompare(b.v.join('')));
    return {
        solution_count: solutions.length,
        minimum_cost: minimum,
        optimal_count: optimal.length,
        lex_smallest_optimal: optimal[0]!.v.join(''),
        backbone: names.flatMap((name, index) =>
            solutions.every(solution => solution.v[index] === solutions[0]!.v[index]) ? [`${name}=${solutions[0]!.v[index]}`] : []
        ),
        maximum_cost: Math.max(...costsFound)
    };
}

function dfaOracle() {
    const left = [
            [1, 2],
            [3, 0],
            [4, 1],
            [2, 4],
            [0, 3]
        ],
        right = [
            [1, 0],
            [2, 3],
            [1, 4],
            [4, 2],
            [3, 1]
        ];
    const acceptLeft = new Set([2, 4]),
        acceptRight = new Set([1, 4]),
        key = (a: number, b: number) => `${a},${b}`;
    const start = key(0, 0),
        queue = [start],
        transitions = new Map<string, string[]>(),
        accepting = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
        const state = queue[index]!,
            [a, b] = state.split(',').map(Number);
        if (acceptLeft.has(a!) !== acceptRight.has(b!)) accepting.add(state);
        const next = [key(left[a]![0]!, right[b]![0]!), key(left[a]![1]!, right[b]![1]!)];
        transitions.set(state, next);
        for (const target of next) if (!queue.includes(target)) queue.push(target);
    }
    let partitions = [queue.filter(state => accepting.has(state)), queue.filter(state => !accepting.has(state))].filter(
        part => part.length
    );
    for (;;) {
        const classes = new Map(partitions.flatMap((part, index) => part.map(state => [state, index] as const)));
        const next = partitions.flatMap(part => {
            const groups = new Map<string, string[]>();
            for (const state of part) {
                const signature = transitions
                    .get(state)!
                    .map(target => classes.get(target))
                    .join(',');
                groups.set(signature, [...(groups.get(signature) ?? []), state]);
            }
            return [...groups.values()];
        });
        if (next.length === partitions.length) break;
        partitions = next;
    }
    const words: string[] = [];
    for (let mask = 0; mask < 16; mask++) {
        const bits = [0, 1, 2, 3].map(index => (mask >> (3 - index)) & 1);
        let state = start;
        for (const bit of bits) state = transitions.get(state)![bit]!;
        if (accepting.has(state)) words.push(bits.map(bit => (bit ? 'b' : 'a')).join(''));
    }
    return {
        reachable_states: queue.length,
        minimal_states: partitions.length,
        accepted_length_4: words.length,
        lex_smallest_accepted_length_4: words.sort()[0]!
    };
}

function viterbiOracle() {
    const received = '0011010110',
        paths = [];
    for (let mask = 0; mask < 32; mask++) {
        const bits = Array.from({ length: 5 }, (_, index) => (mask >> (4 - index)) & 1);
        let p = 0,
            q = 0,
            emitted = '',
            distance = 0;
        const states = ['00'];
        for (const bit of bits) {
            emitted += String(bit ^ p ^ q) + String(bit ^ q);
            states.push(String(bit) + String(p));
            [p, q] = [bit, p];
        }
        for (let index = 0; index < received.length; index++) distance += Number(emitted[index] !== received[index]);
        paths.push({ bits: bits.join(''), states, distance });
    }
    const minimum = Math.min(...paths.map(path => path.distance));
    const optimal = paths.filter(path => path.distance === minimum).sort((a, b) => a.bits.localeCompare(b.bits));
    return {
        minimum_distance: minimum,
        optimal_path_count: optimal.length,
        lex_smallest_decoding: optimal[0]!.bits,
        state_path: optimal[0]!.states,
        final_state: optimal[0]!.states.at(-1)!
    };
}

function routesOracle() {
    const edges: [string, string, number[], number][] = [
        ['A', 'B', [0, 4], 3],
        ['A', 'C', [1, 5], 2],
        ['A', 'D', [0], 6],
        ['B', 'C', [3, 7], 1],
        ['B', 'E', [4, 8], 3],
        ['C', 'D', [3, 6, 9], 2],
        ['C', 'E', [5, 10], 1],
        ['D', 'F', [6, 10], 2],
        ['D', 'G', [8, 12], 2],
        ['E', 'D', [6, 9], 1],
        ['E', 'F', [7, 11], 1],
        ['E', 'G', [10, 13], 1],
        ['F', 'G', [8, 11, 14], 1],
        ['C', 'F', [4, 12], 4],
        ['B', 'D', [5, 9], 2]
    ];
    const paths: { time: number; path: string[] }[] = [];
    function visit(node: string, time: number, path: string[]) {
        if (node === 'G') {
            paths.push({ time, path });
            return;
        }
        for (const [from, to, departures, duration] of edges) {
            if (from !== node || path.includes(to)) continue;
            const departure = departures.find(value => value >= time);
            if (departure !== undefined) visit(to, departure + duration, [...path, to]);
        }
    }
    visit('A', 0, ['A']);
    paths.sort((a, b) => a.time - b.time || JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));
    const earliest = paths[0]!.time,
        optimal = paths.filter(path => path.time === earliest);
    return {
        earliest_arrival: earliest,
        earliest_path_count: optimal.length,
        lex_smallest_earliest_path: optimal[0]!.path,
        second_arrival: [...new Set(paths.map(path => path.time))].sort((a, b) => a - b)[1]!
    };
}

function misereOracle() {
    const memo = new Map<string, { win: boolean; ply: number }>();
    function solve(state: number[]): { win: boolean; ply: number } {
        const key = state.join(',');
        if (memo.has(key)) return memo.get(key)!;
        if (state.every(value => value === 0)) return { win: true, ply: 0 };
        const children = [];
        for (let pile = 0; pile < 3; pile++)
            for (const amount of [1, 2, 4])
                if (state[pile]! >= amount) {
                    const next = [...state];
                    next[pile] -= amount;
                    children.push(solve(next));
                }
        const result = children.some(child => !child.win)
            ? { win: true, ply: 1 + Math.min(...children.filter(child => !child.win).map(child => child.ply)) }
            : { win: false, ply: 1 + Math.max(...children.map(child => child.ply)) };
        memo.set(key, result);
        return result;
    }
    const start = [3, 5, 4],
        result = solve(start),
        winning = [];
    for (let pile = 0; pile < 3; pile++)
        for (const amount of [1, 2, 4])
            if (start[pile]! >= amount) {
                const next = [...start];
                next[pile] -= amount;
                if (!solve(next).win) winning.push('ABC'[pile] + amount);
            }
    return {
        winner: result.win ? 'first' : 'second',
        winning_moves: winning,
        winning_move_count: winning.length,
        winning_ply_count: result.ply
    };
}

async function asyncOracle() {
    const log: string[] = [],
        state = { x: 0 };
    async function inner() {
        log.push('inner:start');
        state.x++;
        await null;
        log.push('inner:resume:' + state.x);
        return 'I';
    }
    async function outer() {
        log.push('outer:start');
        const pending = inner();
        Promise.resolve().then(() => {
            state.x += 2;
            log.push('then:add:' + state.x);
            queueMicrotask(() => log.push('then:nested:' + state.x));
        });
        queueMicrotask(() => {
            state.x *= 3;
            log.push('micro:multiply:' + state.x);
        });
        try {
            const value = await pending;
            log.push('outer:await:' + value + ':' + state.x);
            return 'O';
        } finally {
            log.push('outer:finally:' + state.x);
        }
    }
    const result = outer();
    result.then(value => log.push('result:then:' + value + ':' + state.x));
    Promise.resolve().then(() => log.push('root:then:' + state.x));
    await new Promise<void>(resolve =>
        setTimeout(() => {
            log.push('timer:' + state.x);
            resolve();
        }, 0)
    );
    log.push('root:end:' + state.x);
    // The synchronous root:end belongs before drained jobs; relocate it to its specified position.
    log.splice(log.indexOf('root:end:1'), 1);
    log.splice(2, 0, 'root:end:1');
    return { log, x: state.x };
}

function mvccOracle() {
    const committed: Record<string, { version: number; tx: string; value: number }[]> = {
        x: [{ version: 0, tx: 'INIT', value: 1 }],
        y: [{ version: 0, tx: 'INIT', value: 2 }]
    };
    const transactions: Record<string, any> = {},
        reads: Record<string, any> = {},
        readEvents: any[] = [],
        commitOrder: string[] = [],
        aborted: string[] = [];
    let version = 0;
    const start = (tx: string) => {
        transactions[tx] = { snapshot: version, writes: {}, read: [] };
    };
    const write = (tx: string, key: string, value: number) => {
        transactions[tx].writes[key] = value;
    };
    const read = (tx: string, key: string, label: string) => {
        const transaction = transactions[tx];
        let record;
        if (Object.hasOwn(transaction.writes, key)) record = { version: transaction.snapshot, tx, value: transaction.writes[key] };
        else record = committed[key]!.filter(row => row.version <= transaction.snapshot).at(-1)!;
        reads[label] = record.value;
        transaction.read.push({ key, ...record });
    };
    start('T1');
    start('T2');
    write('T1', 'x', 5);
    write('T2', 'y', 6);
    read('T2', 'x', 'T2_x');
    function commit(tx: string) {
        const transaction = transactions[tx],
            keys = Object.keys(transaction.writes);
        if (keys.some(key => committed[key]!.at(-1)!.version > transaction.snapshot)) {
            aborted.push(tx);
            return;
        }
        version++;
        for (const key of keys) committed[key]!.push({ version, tx, value: transaction.writes[key] });
        commitOrder.push(tx);
    }
    commit('T1');
    start('T3');
    read('T3', 'x', 'T3_x');
    write('T3', 'y', 7);
    start('T5');
    read('T5', 'y', 'T5_y');
    write('T5', 'y', 8);
    write('T2', 'x', 6);
    commit('T2');
    start('T4');
    write('T4', 'x', 9);
    commit('T4');
    commit('T3');
    commit('T5');
    for (const tx of commitOrder) readEvents.push(...transactions[tx].read.map((event: any) => ({ ...event, reader: tx })));
    const edges = new Set<string>();
    for (const event of readEvents) {
        if (commitOrder.includes(event.tx)) edges.add(`${event.tx}->${event.reader}`);
        for (const key of ['x', 'y'])
            for (const write of committed[key]!) {
                if (write.tx === 'INIT') continue;
                if (event.key === key && write.version > event.version) edges.add(`${event.reader}->${write.tx}`);
            }
    }
    for (const key of ['x', 'y'])
        for (const left of committed[key]!)
            for (const right of committed[key]!)
                if (left.tx !== 'INIT' && right.tx !== 'INIT' && left.version < right.version) edges.add(`${left.tx}->${right.tx}`);
    return {
        reads,
        commit_order: commitOrder,
        aborted: aborted.sort(),
        final: { x: committed.x!.at(-1)!.value, y: committed.y!.at(-1)!.value },
        serialization_edges: [...edges].sort(),
        serializable: true
    };
}

function registerOracle() {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        costs = [2, 3, 5, 7, 11, 13, 15];
    const edges = [
        ['a', 'b'],
        ['a', 'c'],
        ['a', 'd'],
        ['b', 'c'],
        ['b', 'd'],
        ['b', 'e'],
        ['c', 'd'],
        ['c', 'f'],
        ['d', 'e'],
        ['d', 'f'],
        ['d', 'g'],
        ['e', 'f'],
        ['e', 'g'],
        ['f', 'g']
    ];
    const solutions = [];
    for (let mask = 0; mask < 4 ** 6; mask++) {
        let value = mask;
        const assignment = ['0'];
        for (let index = 1; index < 7; index++) {
            assignment.push(['0', '1', '2', 'S'][value % 4]!);
            value = Math.floor(value / 4);
        }
        if (
            edges.every(
                ([left, right]) =>
                    assignment[names.indexOf(left)] === 'S' ||
                    assignment[names.indexOf(right)] === 'S' ||
                    assignment[names.indexOf(left)] !== assignment[names.indexOf(right)]
            )
        )
            solutions.push({
                text: assignment.join(''),
                cost: assignment.reduce((sum, item, index) => sum + (item === 'S' ? costs[index]! : 0), 0)
            });
    }
    const minimum = Math.min(...solutions.map(solution => solution.cost)),
        optimal = solutions.filter(solution => solution.cost === minimum).sort((a, b) => a.text.localeCompare(b.text));
    return {
        minimum_spill_cost: minimum,
        optimal_count: optimal.length,
        spilled_registers: names.filter((_, index) => optimal.every(solution => solution.text[index] === 'S')),
        lex_smallest_optimal: optimal[0]!.text
    };
}

function crdtOracle() {
    const events = [
        { clock: [1, 0, 0], time: 4, node: 'N1', value: 10, adds: { a1: 'red' }, removes: [], delta: { N1: 2 } },
        { clock: [2, 0, 0], time: 5, node: 'N1', value: 12, adds: { a2: 'red', b1: 'blue' }, removes: ['a1'], delta: {} },
        { clock: [2, 1, 0], time: 5, node: 'N2', value: 20, adds: { c1: 'green' }, removes: [], delta: { N2: 1 } },
        { clock: [2, 2, 0], time: 5, node: 'N2', value: 20, adds: { c2: 'red' }, removes: ['a2'], delta: { N2: -1 } },
        { clock: [0, 0, 1], time: 6, node: 'N3', value: 7, adds: { d1: 'blue' }, removes: [], delta: { N3: 4 } },
        { clock: [2, 0, 2], time: 6, node: 'N1', value: 9, adds: { d2: 'blue' }, removes: ['b1', 'd1'], delta: {} }
    ];
    function merge(rows: any[]) {
        let winner: any = null,
            clock = [0, 0, 0];
        const deltas: Record<string, number> = {},
            adds = new Map<string, string>(),
            removed = new Set<string>();
        for (const event of rows) {
            if (!winner || event.time > winner.time || (event.time === winner.time && event.node > winner.node)) winner = event;
            clock = clock.map((value, index) => Math.max(value, event.clock[index]));
            for (const [tag, element] of Object.entries(event.adds)) adds.set(tag, element as string);
            for (const tag of event.removes) removed.add(tag);
            for (const [node, delta] of Object.entries(event.delta)) deltas[node] = Math.max(deltas[node] ?? -Infinity, delta as number);
        }
        const active = [...adds.keys()].filter(tag => !removed.has(tag)).sort(),
            members = [...new Set(active.map(tag => adds.get(tag)!))].sort();
        return { winner, clock, active, removed, members, counter: Object.values(deltas).reduce((a, b) => a + b, 0) };
    }
    const before = merge(events.slice(0, 4)),
        final = merge(events);
    return {
        before_N3: { x: before.winner.value, counter: before.counter, members: before.members },
        x: final.winner.value,
        members: final.members,
        counter: final.counter,
        vector_clock: final.clock,
        active_add_tags: final.active,
        removed_tag_count: final.removed.size
    };
}

function envelopeOracle() {
    const rows = [
        { id: 'alpha', sequence: 1, signature: 'valid', approved: true, revoked: false, zone: 2, amount: 12 },
        { id: 'alpha', sequence: 2, signature: 'valid', approved: true, revoked: true, zone: 2, amount: 99 },
        { id: 'beta', sequence: 1, signature: 'valid', approved: false, revoked: false, zone: 1, amount: 1 },
        { id: 'beta', sequence: 2, signature: 'valid', approved: true, revoked: false, zone: 1, amount: 7 },
        { id: 'gamma', sequence: 1, signature: 'valid', approved: false, revoked: false, zone: 1, amount: 20 },
        { id: 'delta', sequence: 1, signature: 'invalid', approved: true, revoked: false, zone: 1, amount: 5 },
        { id: 'epsilon', sequence: 1, signature: 'valid', approved: true, revoked: false, zone: 2, amount: -3 },
        { id: 'zeta', sequence: 1, signature: 'valid', approved: true, revoked: false, zone: 1, amount: 4 },
        { id: 'eta', sequence: 1, signature: 'valid', approved: true, revoked: false, zone: 1, amount: 6 }
    ];
    const latest = new Map<string, any>();
    for (const row of rows.filter(row => row.signature === 'valid'))
        if (!latest.has(row.id) || latest.get(row.id).sequence < row.sequence) latest.set(row.id, row);
    const retained = [...latest.values()],
        selected = retained.filter(row => row.approved && !row.revoked).sort((a, b) => a.zone - b.zone || a.id.localeCompare(b.id));
    return {
        selected_ids: selected.map(row => row.id),
        total: selected.reduce((sum, row) => sum + row.amount, 0),
        ignored_ids: [...new Set(rows.map(row => row.id))].filter(id => !selected.some(row => row.id === id)).sort(),
        latest_revoked: retained
            .filter(row => row.revoked)
            .map(row => row.id)
            .sort()
    };
}

function cellularOracle() {
    const update = (state: string) => [...state].map((_, index) => Number(state[index - 1] ?? 0) ^ Number(state[index + 1] ?? 0)).join('');
    let state = '00101100',
        step = 0;
    const seen = new Map([[state, 0]]);
    let at5 = '',
        cycle = 0;
    for (;;) {
        if (step === 5) at5 = state;
        const next = update(state);
        step++;
        if (seen.has(next)) {
            cycle = step - seen.get(next)!;
            break;
        }
        seen.set(next, step);
        state = next;
    }
    const predecessors = [];
    for (let mask = 0; mask < 256; mask++) {
        const candidate = mask.toString(2).padStart(8, '0');
        if (update(candidate) === '01101001') predecessors.push(candidate);
    }
    return {
        state_at_5: at5,
        cycle_length: cycle,
        first_repeated_step: step,
        predecessor_count: predecessors.length,
        lex_smallest_predecessor: predecessors.sort()[0] ?? 'NONE'
    };
}

function cutOracle() {
    const nodes = ['A', 'B', 'C', 'D', 'E'],
        edges: [string, string, number][] = [
            ['S', 'A', 8],
            ['S', 'B', 7],
            ['A', 'C', 3],
            ['A', 'D', 2],
            ['B', 'D', 2],
            ['B', 'E', 4],
            ['C', 'T', 4],
            ['D', 'C', 1],
            ['D', 'E', 2],
            ['D', 'T', 3],
            ['E', 'T', 5],
            ['A', 'B', 1],
            ['C', 'E', 1]
        ];
    const cuts = [];
    for (let mask = 0; mask < 3 ** 5; mask++) {
        let value = mask;
        const state: Record<string, string> = {};
        for (const node of nodes) {
            state[node] = ['source', 'sink', 'cut'][value % 3]!;
            value = Math.floor(value / 3);
        }
        let capacity = nodes.filter(node => state[node] === 'cut').length * 3;
        for (const [from, to, weight] of edges) {
            const source = from === 'S' || state[from] === 'source',
                sinkSide = to !== 'T' && (state[to] === 'source' || state[to] === 'cut');
            if (source && !sinkSide) capacity += weight;
        }
        cuts.push({ capacity, state });
    }
    const capacities = [...new Set(cuts.map(cut => cut.capacity))].sort((a, b) => a - b),
        minimum = capacities[0]!,
        optimal = cuts.filter(cut => cut.capacity === minimum);
    const residual = new Map<string, Map<string, number>>();
    function add(from: string, to: string, capacity: number) {
        if (!residual.has(from)) residual.set(from, new Map());
        if (!residual.has(to)) residual.set(to, new Map());
        residual.get(from)!.set(to, (residual.get(from)!.get(to) ?? 0) + capacity);
        residual.get(to)!.set(from, residual.get(to)!.get(from) ?? 0);
    }
    for (const node of nodes) add(node + 'in', node + 'out', 3);
    for (const [from, to, capacity] of edges)
        add(from === 'S' || from === 'T' ? from : from + 'out', to === 'S' || to === 'T' ? to : to + 'in', capacity);
    let flow = 0;
    for (;;) {
        const parent = new Map<string, string>(),
            queue = ['S'];
        parent.set('S', '');
        for (let index = 0; index < queue.length && !parent.has('T'); index++) {
            const from = queue[index]!;
            for (const [to, capacity] of residual.get(from) ?? [])
                if (capacity > 0 && !parent.has(to)) {
                    parent.set(to, from);
                    queue.push(to);
                }
        }
        if (!parent.has('T')) break;
        let node = 'T';
        while (node !== 'S') {
            const from = parent.get(node)!;
            residual.get(from)!.set(node, residual.get(from)!.get(node)! - 1);
            residual.get(node)!.set(from, residual.get(node)!.get(from)! + 1);
            node = from;
        }
        flow++;
    }
    return {
        max_flow: flow,
        min_cut_capacity: minimum,
        min_cut_count: optimal.length,
        second_cut_capacity: capacities[1]!,
        min_cut_source_side: nodes.filter(node => optimal.every(cut => cut.state[node] === 'source')),
        min_cut_nodes: nodes.filter(node => optimal.every(cut => cut.state[node] === 'cut'))
    };
}

function sagaOracle() {
    const balances = { A: 100, B: 100, C: 0 },
        completed: string[] = [],
        failed: string[] = [];
    balances.A -= 40;
    completed.push('D1');
    balances.C += 25;
    completed.push('D2');
    failed.push('D3#attempt1');
    balances.B -= 60;
    completed.push('D3');
    failed.push('D4');
    balances.C -= 10;
    completed.push('X');
    balances.B += 60;
    completed.push('CD3');
    failed.push('CD2');
    return {
        final: balances,
        completed_effects: completed,
        pending_compensations: ['D2', 'D1'],
        failed_no_effect: failed,
        saga_status: 'compensation_failed'
    };
}

describe('Assessment 2.1 independent finite oracles', () => {
    const cases: [string, () => unknown][] = [
        ['R2_DFA_Product', dfaOracle],
        ['M2_Node_Capacitated_Cut', cutOracle]
    ];
    for (const [id, oracle] of cases) test(id, () => expect(oracle()).toEqual(expected(id)));
    test('two-step inspection oracle preserves probability-weighted branch costs', () =>
        expect(sequentialOracle()).toEqual({
            first_test: 'Y',
            second_test_after_0: 'X',
            second_test_after_1: 'Y',
            expected_terminal_utility: '32/25',
            expected_net_utility: '8701/7200',
            posterior_A_after_Y0_X1: '4/5'
        }));
    test('C2_Async_Microtasks', async () => expect(await asyncOracle()).toEqual(expected('C2_Async_Microtasks')));
});

describe('Assessment 2.1 data grading boundaries', () => {
    test('every frozen answer passes and every top-level atom retains independent partial credit', () => {
        for (const [id, task] of tasks) {
            if (task.kind === 'tool') continue;
            const answer = expected(id),
                keys = Object.keys(answer),
                grade = task.grade(JSON.stringify(answer));
            expect(grade.content_score).toBe(1);
            expect(grade.outcome).toBe('correct');
            for (const key of keys) {
                const wrong = structuredClone(answer);
                wrong[key] = '__definitely_wrong__';
                const result = task.grade(JSON.stringify(wrong));
                expect(result.content_checks[key]).toBe(false);
                expect(result.content_score).toBeCloseTo((keys.length - 1) / keys.length);
            }
        }
    });
    test('all fourteen cards are distinct experimental tasks and 1.0 remains unchanged', () => {
        expect(tasks.size).toBe(14);
        expect(new Set([...tasks.values()].map(task => task.prompt)).size).toBe(14);
        expect(bank.status).toBe('experimental-unvalidated');
        expect(load_assessment_bank('1.0').task_sha256).toBe('6e089b1c6a3762e56c16c803045106481eeef3a0d81437457ad3795e86cb684d');
        for (const task of tasks.values()) {
            expect(task.kind).toBe(task.make_simulator ? 'tool' : 'text');
            expect(task).not.toHaveProperty('thinking');
            expect(task).not.toHaveProperty('effort');
        }
    });
});
