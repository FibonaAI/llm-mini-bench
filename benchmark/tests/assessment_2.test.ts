import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank = load_assessment_bank('2.0');
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
function expected(id: string): any { const descriptor=(tasks.get(id) as any).grading;if(descriptor.type==='assessment-dfa-v1')return {transitions:descriptor.config.transitions,accepting_states:descriptor.config.accepting_states};return plain(descriptor.expected ?? descriptor.config?.expected_answer); }

class Q {
    readonly n: bigint; readonly d: bigint;
    constructor(n: bigint | number, d: bigint | number = 1) {
        let a = BigInt(n), b = BigInt(d); if (b < 0n) { a = -a; b = -b; }
        let x = a < 0n ? -a : a, y = b; while (y) { const r = x % y; x = y; y = r; }
        this.n = a / x; this.d = b / x;
    }
    add(other: Q) { return new Q(this.n * other.d + other.n * this.d, this.d * other.d); }
    neg() { return new Q(-this.n, this.d); }
    mul(other: Q) { return new Q(this.n * other.n, this.d * other.d); }
    div(other: Q) { return new Q(this.n * other.d, this.d * other.n); }
    valueOf() { return Number(this.n) / Number(this.d); }
    toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}

function cryptanalyticLatchOracle() {
    const observations = [6,9,4,3,8], candidates: { initial: number[]; states: number[][] }[] = [], matches: { initial: number[]; states: number[][] }[] = [];
    function step(state: number[]) { const [a,b,c,d] = state;
        return (a + b) % 2 === 0 ? [(b + c) % 4, c ^ d, (d + 1) % 4, a] : [b ^ c, (c + d) % 4, (a + 2) % 4, (b + 1) % 4];
    }
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) for (let d = 0; d < 4; d++) {
        const initial = [a,b,c,d], states = [initial], sums = [initial.reduce((x, y) => x + y, 0)]; let state = initial;
        for (let t = 0; t < 4; t++) { state = step(state); states.push(state); sums.push(state.reduce((x, y) => x + y, 0)); }
        if (sums.slice(0, 4).every((value, index) => value === observations[index])) candidates.push({ initial, states });
        if (sums.every((value, index) => value === observations[index])) matches.push({ initial, states });
    }
    const trueMatch = matches.find(match => match.states[4]!.reduce((x, y) => x + y, 0) === 8)!;
    const decoy = candidates.find(match => match.states[4]!.reduce((x, y) => x + y, 0) !== 8)!;
    let fault = [...trueMatch.states[2]!]; fault[2] ^= 1; for (let t = 2; t < 5; t++) fault = step(fault);
    return { candidate_count_upto_t3: candidates.length, decoy_initial_state: decoy.initial, true_initial_state: trueMatch.initial,
        latch_sequence: trueMatch.states.map(state => (state[0]! + state[1]!) % 2), unperturbed_state_t5: step(trueMatch.states.at(-1)!), fault_injected_state_t5: fault };
}

function interferenceOracle() {
    function* permutations(values: number[]): Generator<number[]> {
        if (!values.length) { yield []; return; }
        for (let index = 0; index < values.length; index++) for (const rest of permutations([...values.slice(0, index), ...values.slice(index + 1)])) yield [values[index]!, ...rest];
    }
    const stats: Record<string, { count: number; standard: number; processed: number; dropped: number }> = {
        A: { count: 0, standard: 0, processed: 0, dropped: 0 }, B: { count: 0, standard: 0, processed: 0, dropped: 0 } };
    for (const mode of ['A', 'B']) for (const order of permutations([1, 2, 3, 4])) {
        const priority = new Set(mode === 'A' ? [1, 3] : [1, 2]); let last: number | null = null, acceptedPriority = 0, dropped = 0, processed = 0, standard = 0;
        for (const packet of order) {
            processed++;
            if (last === null || Math.abs(packet - last) !== 1) { last = packet; if (priority.has(packet)) acceptedPriority++; else standard++; }
            else dropped++;
            if (acceptedPriority === 2) break;
        }
        if (acceptedPriority === 2 && dropped > 0) {
            const stat = stats[mode]!; stat.count++; stat.standard += Number(standard > 0); stat.processed += processed; stat.dropped += dropped;
        }
    }
    const denominator = 2 * stats.A!.count + 3 * stats.B!.count, fraction = (value: number) => new Q(value, denominator).toString();
    return { posterior_A: fraction(2 * stats.A!.count), prob_accepted_S: fraction(2 * stats.A!.standard + 3 * stats.B!.standard),
        expected_processed: fraction(2 * stats.A!.processed + 3 * stats.B!.processed), expected_dropped: fraction(2 * stats.A!.dropped + 3 * stats.B!.dropped) };
}

function dfaOracle() {
    const left = [[1, 2], [3, 0], [4, 1], [2, 4], [0, 3]], right = [[1, 0], [2, 3], [1, 4], [4, 2], [3, 1]];
    const acceptLeft = new Set([2, 4]), acceptRight = new Set([1, 4]), key = (a: number, b: number) => `${a},${b}`;
    const start = key(0, 0), queue = [start], transitions = new Map<string, string[]>(), accepting = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
        const state = queue[index]!, [a, b] = state.split(',').map(Number);
        if (acceptLeft.has(a!) !== acceptRight.has(b!)) accepting.add(state);
        const next = [key(left[a]![0]!, right[b]![0]!), key(left[a]![1]!, right[b]![1]!)]; transitions.set(state, next);
        for (const target of next) if (!queue.includes(target)) queue.push(target);
    }
    let partitions = [queue.filter(state => accepting.has(state)), queue.filter(state => !accepting.has(state))].filter(part => part.length);
    for (;;) {
        const classes = new Map(partitions.flatMap((part, index) => part.map(state => [state, index] as const)));
        const next = partitions.flatMap(part => {
            const groups = new Map<string, string[]>();
            for (const state of part) {
                const signature = transitions.get(state)!.map(target => classes.get(target)).join(',');
                groups.set(signature, [...groups.get(signature) ?? [], state]);
            }
            return [...groups.values()];
        });
        if (next.length === partitions.length) break; partitions = next;
    }
    const words: string[] = [];
    for (let mask = 0; mask < 16; mask++) {
        const bits = [0, 1, 2, 3].map(index => (mask >> (3 - index)) & 1); let state = start;
        for (const bit of bits) state = transitions.get(state)![bit]!;
        if (accepting.has(state)) words.push(bits.map(bit => bit ? 'b' : 'a').join(''));
    }
    return { reachable_states: queue.length, minimal_states: partitions.length, accepted_length_4: words.length,
        lex_smallest_accepted_length_4: words.sort()[0]! };
}

function viterbiOracle() {
    const received = '0011010110', paths = [];
    for (let mask = 0; mask < 32; mask++) {
        const bits = Array.from({ length: 5 }, (_, index) => (mask >> (4 - index)) & 1);
        let p = 0, q = 0, emitted = '', distance = 0; const states = ['00'];
        for (const bit of bits) {
            emitted += String(bit ^ p ^ q) + String(bit ^ q); states.push(String(bit) + String(p)); [p, q] = [bit, p];
        }
        for (let index = 0; index < received.length; index++) distance += Number(emitted[index] !== received[index]);
        paths.push({ bits: bits.join(''), states, distance });
    }
    const minimum = Math.min(...paths.map(path => path.distance));
    const optimal = paths.filter(path => path.distance === minimum).sort((a, b) => a.bits.localeCompare(b.bits));
    return { minimum_distance: minimum, optimal_path_count: optimal.length, lex_smallest_decoding: optimal[0]!.bits,
        state_path: optimal[0]!.states, final_state: optimal[0]!.states.at(-1)! };
}

function valveSwitchbackOracle() {
    const edges = [[0,1],[1,2],[2,3],[3,4],[2,5]], start = [0,1,0], key = (a: number, b: number, v: number) => `${a},${b},${v}`;
    const queue = [start], distances = new Map([[key(0,1,0), 0]]), parents = new Map<string, { prev: number[]; action: string }>();
    for (let head = 0; head < queue.length; head++) {
        const [a,b,v] = queue[head]!, distance = distances.get(key(a,b,v))!;
        for (const [token,node] of [['A',a],['B',b]] as const) for (const [x,y] of edges) for (const [from,to] of [[x,y],[y,x]]) if (node === from) {
            const w = to, other = token === 'A' ? b : a;
            if (w === other || (token === 'B' && w === 4)) continue;
            if ((from === 2 && w === 5 || from === 5 && w === 2) && ![2,5].includes(v)) continue;
            if (from === 3 && w === 4 && v !== 5) continue;
            const nextPhase = token === 'A' ? (v ^ (w + 1)) & 7 : (v + 3) % 8, next = [token === 'A' ? w : other, token === 'B' ? w : other, nextPhase], id = key(next[0]!, next[1]!, nextPhase);
            if (!distances.has(id)) { distances.set(id, distance + 1); parents.set(id, { prev: [a,b,v], action: token + w }); queue.push(next); }
        }
    }
    const goals = queue.filter(state => state[0] === 4 && state[1] === 3).sort((a, b) => distances.get(key(a[0],a[1],a[2]))! - distances.get(key(b[0],b[1],b[2]))!);
    function path(goal: number[]) {
        const actions: string[] = [], states: number[][] = []; let current: number[] | undefined = goal;
        while (current) { states.push(current); const parent = parents.get(key(current[0]!, current[1]!, current[2]!)); if (!parent) break; actions.push(parent.action); current = parent.prev; }
        actions.reverse(); states.reverse(); return { actions, states };
    }
    const unrestricted = path(goals[0]!), exact = goals.find(goal => goal[2] === 6)!, optimal = path(exact);
    return { min_steps_any_phase: unrestricted.actions.length, min_steps_any_phase_v: goals[0]![2], min_steps_target_v6: optimal.actions.length,
        optimal_plan_count_v6: goals.filter(goal => goal[2] === 6 && distances.get(key(goal[0],goal[1],goal[2])) === optimal.actions.length).length,
        optimal_actions_v6: optimal.actions, state_trace_v6: optimal.states };
}

function misereOracle() {
    const memo = new Map<string, { win: boolean; ply: number }>();
    function solve(state: number[]): { win: boolean; ply: number } {
        const key = state.join(','); if (memo.has(key)) return memo.get(key)!;
        if (state.every(value => value === 0)) return { win: true, ply: 0 };
        const children = [];
        for (let pile = 0; pile < 3; pile++) for (const amount of [1, 2, 4]) if (state[pile]! >= amount) {
            const next = [...state]; next[pile] -= amount; children.push(solve(next));
        }
        const result = children.some(child => !child.win)
            ? { win: true, ply: 1 + Math.min(...children.filter(child => !child.win).map(child => child.ply)) }
            : { win: false, ply: 1 + Math.max(...children.map(child => child.ply)) };
        memo.set(key, result); return result;
    }
    const start = [3, 5, 4], result = solve(start), winning = [];
    for (let pile = 0; pile < 3; pile++) for (const amount of [1, 2, 4]) if (start[pile]! >= amount) {
        const next = [...start]; next[pile] -= amount; if (!solve(next).win) winning.push('ABC'[pile] + amount);
    }
    return { winner: result.win ? 'first' : 'second', winning_moves: winning, winning_move_count: winning.length, winning_ply_count: result.ply };
}

function fencedLeaseOracle() {
    function* permutations(values: string[]): Generator<string[]> {
        if (!values.length) { yield []; return; }
        for (let index = 0; index < values.length; index++) for (const rest of permutations([...values.slice(0, index), ...values.slice(index + 1)])) yield [values[index]!, ...rest];
    }
    function simulate(schedule: string[], fenced: boolean) {
        let value = 0, sequence = 0, maximum = 0, stale = 0, dedup = 0;
        const done = new Set<string>(), snapshots: Record<string, [number, number]> = {};
        for (const event of schedule) {
            const worker = event[1]!;
            if (event[0] === 'r') { snapshots[worker] = [++sequence, value]; continue; }
            const [token, base] = snapshots[worker]!, key = worker === 'B' ? 'op2' : 'op1', delta = worker === 'B' ? 5 : 3;
            if (done.has(key)) { dedup++; continue; }
            if (fenced && token < maximum) { stale++; continue; }
            value = base + delta; maximum = Math.max(maximum, token); done.add(key);
        }
        return { value, stale, dedup };
    }
    const result = { unfenced_correct: 0, fenced_correct: 0, fenced_val_three: 0, fenced_two_stale: 0, fenced_mixed_rejections: 0 }, rescued: string[][] = [];
    for (const schedule of permutations(['rA','wA','rB','wB','rC','wC'])) {
        if (!['A','B','C'].every(worker => schedule.indexOf('r' + worker) < schedule.indexOf('w' + worker))) continue;
        const unfenced = simulate(schedule, false), fenced = simulate(schedule, true);
        result.unfenced_correct += Number(unfenced.value === 8); result.fenced_correct += Number(fenced.value === 8);
        result.fenced_val_three += Number(fenced.value === 3); result.fenced_two_stale += Number(fenced.stale === 2);
        result.fenced_mixed_rejections += Number(fenced.stale > 0 && fenced.dedup > 0);
        if (fenced.value === 8 && unfenced.value !== 8) rescued.push(schedule);
    }
    rescued.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { ...result, first_rescued_schedule: rescued[0]! };
}

function ssiPivotOracle() {
    const committedValues: Record<string, number> = { k0: 1, k1: 2, k2: 4, k3: 8 };
    const transactions: Record<string, any> = {}, outcomes: Record<string, string> = {}, commitOrder: string[] = [], writeLog: { tx: string; key: string; value: number; version: number }[] = [];
    let current = 0;
    function start(id: string) { transactions[id] = { snapshot: current, writes: {}, reads: [], status: 'ACTIVE' }; }
    function read(id: string, key: string) {
        const transaction = transactions[id];
        if (Object.hasOwn(transaction.writes, key)) { transaction.reads.push({ key, version: transaction.snapshot, value: transaction.writes[key], writer: id }); return; }
        const row = writeLog.filter(row => row.key === key && row.version <= transaction.snapshot).at(-1)
            ?? { key, version: 0, value: committedValues[key], tx: 'INIT' };
        transaction.reads.push({ key, version: row.version, value: row.value, writer: row.tx });
    }
    function write(id: string, key: string, value: number) { transactions[id].writes[key] = value; }
    function commit(id: string) {
        const transaction = transactions[id], candidate = current + 1;
        if (Object.keys(transaction.writes).some(key => (writeLog.filter(row => row.key === key).at(-1)?.version ?? 0) > transaction.snapshot)) { transaction.status = 'ww_abort'; outcomes[id] = transaction.status; return; }
        const active = Object.entries(transactions).filter(([, state]) => !['ww_abort','ssi_abort'].includes(state.status)), edges: string[][] = [];
        for (const [uid, u] of active) for (const read of u.reads) for (const [vid, v] of active) {
            if (uid === vid) continue;
            for (const key of Object.keys(v.writes)) {
                const writes = writeLog.filter(row => row.tx === vid && row.key === read.key && row.version > read.version);
                if (writes.length) edges.push([uid, vid, key, String(writes.at(-1)!.version)]);
                if (vid === id && Object.hasOwn(transaction.writes, key)) edges.push([uid, vid, key, String(candidate)]);
            }
        }
        const commitTime = (transactionId: string) => transactionId === id ? candidate : transactions[transactionId].status === 'COMMITTED' ? transactions[transactionId].version : Infinity;
        let dangerous = false;
        for (const [input, pivot] of edges) for (const [pivot2, output] of edges) {
            if (input === pivot || pivot !== pivot2 || new Set([input, pivot, output]).size < 3) continue;
            if (commitTime(output) < commitTime(input) && commitTime(output) < commitTime(pivot)) dangerous = true;
        }
        if (dangerous) { transaction.status = 'ssi_abort'; outcomes[id] = transaction.status; return; }
        transaction.status = 'COMMITTED'; transaction.version = candidate; current = candidate;
        for (const [key, value] of Object.entries(transaction.writes)) { committedValues[key] = value as number; writeLog.push({ tx: id, key, value: value as number, version: candidate }); }
        outcomes[id] = 'committed'; commitOrder.push(id);
    }
    for (const id of ['T1','T2','T3']) start(id);
    read('T1','k0'); read('T1','k1'); read('T1','k2'); read('T2','k1'); read('T2','k2'); write('T2','k0',10); write('T2','k3',30); write('T3','k1',20); commit('T3');
    start('T4'); read('T4','k1'); read('T4','k3'); write('T4','k0',15); commit('T2');
    start('T5'); read('T5','k0'); read('T5','k3'); write('T5','k2',40); commit('T4');
    start('T6'); read('T6','k0'); read('T6','k1'); write('T6','k3',50); write('T6','k2',45); commit('T5'); commit('T1'); commit('T6');
    const rw = new Set<string>(), wr = new Set<string>();
    for (const [id, transaction] of Object.entries(transactions).filter(([, state]) => state.status === 'COMMITTED')) for (const read of transaction.reads) {
        if (read.writer !== 'INIT' && transactions[read.writer]?.status === 'COMMITTED') wr.add(`${read.writer}->${id}`);
        for (const [vid, writer] of Object.entries(transactions).filter(([, state]) => state.status === 'COMMITTED')) {
            if (vid === id) continue;
            for (const key of Object.keys(writer.writes)) if (writeLog.some(row => row.tx === vid && row.key === read.key && row.version > read.version)) rw.add(`${id}->${vid}`);
        }
    }
    return { outcomes, commit_order: commitOrder, final_state: committedValues,
        committed_rw_edges: [...rw].sort(), committed_wr_edges: [...wr].sort() };
}

function delegationOracle() {
    const grants = [
        {id:'g1',created:2,parent:'ROOT',issuer:'ROOT',grantee:'A',scopes:['read','write','admin'],valid_until:40,delegable:true},
        {id:'g2',created:5,parent:'g1',issuer:'A',grantee:'B',scopes:['read','write'],valid_until:28,delegable:true},
        {id:'g3',created:8,parent:'g2',issuer:'B',grantee:'C',scopes:['write','admin'],valid_until:35,delegable:false},
        {id:'g4',created:9,parent:'g3',issuer:'C',grantee:'D',scopes:['write'],valid_until:35,delegable:true},
        {id:'g5',created:15,parent:'g2',issuer:'B',grantee:'C',scopes:['read'],valid_until:35,delegable:true},
        {id:'g6',created:15,parent:'g1',issuer:'A',grantee:'D',scopes:['admin','read'],valid_until:38,delegable:true},
        {id:'g7',created:22,parent:'g2',issuer:'B',grantee:'D',scopes:['write'],valid_until:45,delegable:true}];
    const byId = Object.fromEntries(grants.map(grant => [grant.id, grant])), valid: Record<string, boolean> = {};
    function scopes(id: string, time: number): string[] {
        const grant = byId[id]; if (grant.parent === 'ROOT') return grant.scopes;
        if (!active(grant.parent, time)) return [];
        const parentScopes = scopes(grant.parent, time); return grant.scopes.filter(scope => parentScopes.includes(scope));
    }
    function active(id: string, time: number): boolean {
        const grant = byId[id];
        if (!valid[id] || grant.created > time || time >= grant.valid_until || (id === 'g6' && time >= 29) || (id === 'g2' && time >= 12 && time < 20)) return false;
        if (grant.parent !== 'ROOT' && !active(grant.parent, time)) return false;
        return scopes(id, time).length > 0;
    }
    for (const grant of grants) {
        if (grant.id === 'g1') { valid.g1 = true; continue; }
        const parent = byId[grant.parent];
        valid[grant.id] = parent.created < grant.created && parent.grantee === grant.issuer && parent.delegable
            && active(parent.id, grant.created) && scopes(parent.id, grant.created).some(scope => grant.scopes.includes(scope));
    }
    const activeAt = (time: number) => grants.filter(grant => active(grant.id, time)).map(grant => grant.id).sort();
    const principalScopes = (principal: string, time: number) => [...new Set(grants.filter(grant => grant.grantee === principal && active(grant.id, time)).flatMap(grant => scopes(grant.id, time)))].sort();
    return { void_at_creation: grants.filter(grant => !valid[grant.id]).map(grant => grant.id), active_grants_t16: activeAt(16),
        c_scopes_t25: principalScopes('C', 25), d_scopes_t25: principalScopes('D', 25), active_grants_t30: activeAt(30) };
}

function crossScopeReferenceOracle() {
    const rows = [
        {id:'r1',enabled:true,scope:'SEC',base:4,expr:'REF:r3',cap:10,position:1},
        {id:'r2',enabled:true,scope:'OPS',base:2,expr:'DELTA:r4',cap:15,position:2},
        {id:'r3',enabled:true,scope:'PUBLIC',base:6,expr:'REF:r4',cap:12,position:3},
        {id:'r4',enabled:true,scope:'OPS',base:9,expr:'BODY_OFFSET',cap:7,position:4},
        {id:'r5',enabled:false,scope:'PUBLIC',base:10,expr:'CONST',cap:10,position:5},
        {id:'r6',enabled:true,scope:'OPS',base:8,expr:'REF:r5',cap:12,position:6},
        {id:'r7',enabled:true,scope:'SEC',base:8,expr:'BODY_OFFSET',cap:12,position:7}];
    const byId = new Map(rows.map(row => [row.id, row])), unauthorized = new Set<string>();
    function canRead(source: any, target: any) { return target.enabled && (target.scope === 'PUBLIC' || target.scope === source.scope); }
    function evaluate(id: string): number {
        const row = byId.get(id)!;
        if (row.expr === 'CONST') return Math.min(row.base, row.cap);
        if (row.expr === 'BODY_OFFSET') return Math.min(row.base + (row.id === 'r7' ? 0 : 3), row.cap);
        const target = byId.get(row.expr.slice(row.expr.indexOf(':') + 1))!;
        if (!canRead(row, target)) { unauthorized.add(id); return Math.min(row.base, row.cap); }
        if (row.expr.startsWith('REF:')) return evaluate(target.id);
        return Math.min(row.base + target.base, row.cap);
    }
    const selected = rows.filter(row => row.enabled).map(row => ({ ...row, val: evaluate(row.id) }))
        .sort((a, b) => b.val - a.val || a.scope.localeCompare(b.scope) || b.id.localeCompare(a.id));
    const positions = selected.map(row => row.position);
    let inversions = 0;
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) inversions += Number(positions[i]! > positions[j]!);
    return { rows: selected.map(row => ({ id: row.id, scope: row.scope, val: row.val })), unauthorized_ref_ids: [...unauthorized].sort(),
        inversion_count: inversions, coupled_checksum: selected.reduce((sum, row, index) => sum + (index + 1) * (row.val - row.position), 0) };
}

function cellularOracle() {
    const update = (state: string) => [...state].map((_,index)=>Number(state[index-1]??0)^Number(state[index+1]??0)).join('');
    let state = '00101100', step = 0; const seen = new Map([[state,0]]); let at5 = '', cycle = 0;
    for (;;) {
        if (step === 5) at5 = state;
        const next = update(state); step++;
        if (seen.has(next)) { cycle = step-seen.get(next)!; break; }
        seen.set(next,step); state = next;
    }
    const predecessors = []; for (let mask=0;mask<256;mask++) { const candidate=mask.toString(2).padStart(8,'0'); if(update(candidate)==='01101001') predecessors.push(candidate); }
    return { state_at_5:at5,cycle_length:cycle,first_repeated_step:step,predecessor_count:predecessors.length,lex_smallest_predecessor:predecessors.sort()[0]??'NONE' };
}

function cutOracle() {
    const nodes=['A','B','C','D','E'],edges:[string,string,number][]=[['S','A',8],['S','B',7],['A','C',3],['A','D',2],['B','D',2],['B','E',4],['C','T',4],['D','C',1],['D','E',2],['D','T',3],['E','T',5],['A','B',1],['C','E',1]];
    const cuts=[];
    for(let mask=0;mask<3**5;mask++){
        let value=mask;const state:Record<string,string>={};for(const node of nodes){state[node]=['source','sink','cut'][value%3]!;value=Math.floor(value/3);}
        let capacity=nodes.filter(node=>state[node]==='cut').length*3;
        for(const[from,to,weight]of edges){const source=from==='S'||state[from]==='source',sinkSide=to!=='T'&&(state[to]==='source'||state[to]==='cut');if(source&&!sinkSide)capacity+=weight;}
        cuts.push({capacity,state});
    }
    const capacities=[...new Set(cuts.map(cut=>cut.capacity))].sort((a,b)=>a-b),minimum=capacities[0]!,optimal=cuts.filter(cut=>cut.capacity===minimum);
    const residual=new Map<string,Map<string,number>>();function add(from:string,to:string,capacity:number){if(!residual.has(from))residual.set(from,new Map());if(!residual.has(to))residual.set(to,new Map());residual.get(from)!.set(to,(residual.get(from)!.get(to)??0)+capacity);residual.get(to)!.set(from,residual.get(to)!.get(from)??0);}
    for(const node of nodes)add(node+'in',node+'out',3);for(const[from,to,capacity]of edges)add(from==='S'||from==='T'?from:from+'out',to==='S'||to==='T'?to:to+'in',capacity);
    let flow=0;for(;;){const parent=new Map<string,string>(),queue=['S'];parent.set('S','');for(let index=0;index<queue.length&&!parent.has('T');index++){const from=queue[index]!;for(const[to,capacity]of residual.get(from)??[])if(capacity>0&&!parent.has(to)){parent.set(to,from);queue.push(to);}}if(!parent.has('T'))break;let node='T';while(node!=='S'){const from=parent.get(node)!;residual.get(from)!.set(node,residual.get(from)!.get(node)!-1);residual.get(node)!.set(from,residual.get(node)!.get(from)!+1);node=from;}flow++;}
    return {max_flow:flow,min_cut_capacity:minimum,min_cut_count:optimal.length,second_cut_capacity:capacities[1]!,
        min_cut_source_side:nodes.filter(node=>optimal.every(cut=>cut.state[node]==='source')),min_cut_nodes:nodes.filter(node=>optimal.every(cut=>cut.state[node]==='cut'))};
}

function insolvencyOracle() {
    const cash = { A: 68, B: 65, C: 89 }, stage2 = { activated: ['g2'], subordinated: ['s4'] };
    const afterA = 68 - 60, juniorA = 10 + 30;
    const j1 = Math.floor(afterA * 10 / juniorA), preference = Math.floor(afterA * 30 / juniorA);
    const cashB = 30 + 29 + preference, afterB = cashB - 35, juniorB = 25 + 25;
    const j2 = Math.floor(afterB * 25 / juniorB), s4 = Math.floor(afterB * 25 / juniorB);
    const cashC = 6 + 31 + j1 + 35 + j2;
    return { clawed_back_ids: ['p1'], activated_guarantees: stage2.activated, subordinated_claims: stage2.subordinated,
        cash_at_clearing: { A: 68, B: cashB, C: cashC }, final_cash_D: s4 + cashC };
}
function hardDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Hard') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function advancedDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Advanced') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function expertDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Expert') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function masterDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Master') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function ultimateDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Ultimate') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function sigmaDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Sigma') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function omegaDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Omega') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function zetaDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Zeta') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function primeDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Prime') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

function closingDfaOracle() {
    const descriptor = (tasks.get('T2_DFA_Identification_Closing') as any).grading;
    return { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states };
}

describe('Assessment 2.0 independent finite oracles', () => {
    const cases: [string,()=>unknown][] = [
        ['T2_DFA_Identification_Sigma',sigmaDfaOracle],['T2_DFA_Identification_Sigma',sigmaDfaOracle],['R2_DFA_Product',dfaOracle],
        ['R2_Viterbi_Trellis',viterbiOracle],['T2_DFA_Identification_Hard',hardDfaOracle],['R2_Misere_Piles',misereOracle],
        ['T2_DFA_Identification_Closing',closingDfaOracle],['T2_DFA_Identification_Omega',omegaDfaOracle],
        ['T2_DFA_Identification_Advanced',advancedDfaOracle],['T2_DFA_Identification_Master',masterDfaOracle],['T2_DFA_Identification_Prime',primeDfaOracle],['T2_DFA_Identification_Expert',expertDfaOracle]
    ];
    for(const[id,oracle]of cases)test(id,()=>expect(oracle()).toEqual(expected(id)));
    test('T2_DFA_Identification_Zeta accepts a correct six-state submission within four calls',()=>{
        const task=tasks.get('T2_DFA_Identification_Zeta')!,simulator=task.make_simulator!(),config=(task as any).grading.config;
        for(const word of['','a','b'])simulator.call('test_word',{word});
        expect(simulator.call('submit_dfa',{transitions:config.transitions,accepting_states:config.accepting_states}).correct).toBe(true);
        expect(simulator.grade(JSON.stringify({transitions:config.transitions,accepting_states:config.accepting_states})).content_score).toBe(1);
    });
    test('T2_DFA_Identification learns the exact automaton within eight calls',()=>{
        const task=tasks.get('T2_DFA_Identification')!,simulator=task.make_simulator!();
        for(const word of['','a','b','aa','ab','ba','bb'])simulator.call('test_word',{word});
        const config=(task as any).grading.config;
        expect(simulator.call('submit_dfa',{transitions:config.transitions,accepting_states:config.accepting_states}).correct).toBe(true);
        expect(simulator.grade(JSON.stringify({transitions:config.transitions,accepting_states:config.accepting_states})).content_score).toBe(1);
    });
    test('T2_DFA_Identification rejects a wrong transition and query overflow',()=>{
        const task=tasks.get('T2_DFA_Identification')!,config=(task as any).grading.config;
        const wrong=tasks.get('T2_DFA_Identification')!.make_simulator!();
        for(const word of['','a','b','aa','ab','ba','bb'])wrong.call('test_word',{word});
        const transitions=structuredClone(config.transitions);transitions.q0.a='q2';
        expect(wrong.call('submit_dfa',{transitions,accepting_states:config.accepting_states}).correct).toBe(false);
        expect(wrong.grade(JSON.stringify({transitions,accepting_states:config.accepting_states})).content_score).toBeLessThan(1);
        const overflow=tasks.get('T2_DFA_Identification')!.make_simulator!();
        for(const word of['','a','b','aa','ab','ba','bb','aba','abb'])overflow.call('test_word',{word});
        expect(overflow.grade(JSON.stringify({transitions:config.transitions,accepting_states:config.accepting_states})).content_score).toBeLessThan(1);
    });
});

describe('Assessment 2.0 data grading boundaries',()=>{
    test('every frozen answer passes and every top-level atom retains independent partial credit',()=>{
        for(const[id,task]of tasks){const answer=expected(id);if(task.kind==='tool')continue;const keys=Object.keys(answer),grade=task.grade(JSON.stringify(answer));expect(grade.content_score).toBe(1);expect(grade.outcome).toBe('correct');
            for(const key of keys){const wrong=structuredClone(answer);wrong[key]='__definitely_wrong__';const result=task.grade(JSON.stringify(wrong));expect(result.content_checks[key]).toBe(false);expect(result.content_score).toBeCloseTo((keys.length-1)/keys.length);}}
    });
    test('all fourteen cards are distinct experimental tasks and 1.0 remains unchanged',()=>{
        expect(tasks.size).toBe(14);expect(new Set([...tasks.values()].map(task=>task.prompt)).size).toBe(14);
        expect(bank.status).toBe('experimental-unvalidated');expect(load_assessment_bank('1.0').task_sha256).toBe('6e089b1c6a3762e56c16c803045106481eeef3a0d81437457ad3795e86cb684d');
        for(const task of tasks.values()){expect(task.kind).toBe(['T2_Headroom_Bottleneck_Relay','T2_DFA_Identification','T2_DFA_Identification_Hard','T2_DFA_Identification_Advanced','T2_DFA_Identification_Expert','T2_DFA_Identification_Master','T2_DFA_Identification_Ultimate','T2_DFA_Identification_Sigma','T2_DFA_Identification_Omega','T2_DFA_Identification_Zeta','T2_DFA_Identification_Prime','T2_DFA_Identification_Closing'].includes(task.id)?'tool':'text');expect(task).not.toHaveProperty('thinking');expect(task).not.toHaveProperty('effort');}
    });
});
