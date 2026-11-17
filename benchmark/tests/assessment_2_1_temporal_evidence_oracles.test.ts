import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const TEMPORAL_EVENTS = 'ABCDEFGHI';
const TEMPORAL_LOCATIONS = ['Birch', 'Cedar', 'Dune', 'Elm', 'Origin', 'Terminal'];
const TEMPORAL_LOCATION_BITS = Object.fromEntries(TEMPORAL_LOCATIONS.map((name, index) => [name, 1 << index]));
const TEMPORAL_PAIR_BITS = Array.from({ length: 9 }, (_, before) =>
    Array.from({ length: 9 }, (_, after) => (before === after ? 0n : 1n << BigInt(before * 9 + after)))
);
const ALL_TEMPORAL_PAIRS = TEMPORAL_PAIR_BITS.flat().reduce((union, bit) => union | bit, 0n);

type EvidenceRecord = { id: string; slot: string; authority: string; revision: number; signature: string; scope: string; before: string[] };
type TemporalSummary = {
    legal: number;
    delivered: number;
    certain: number;
    possible: number;
    legalPairs: bigint;
    deliveredPairs: bigint;
    smallestFailure: string | null;
};
type WithdrawalCase = { withdrawn: string[]; active: string[]; summary: TemporalSummary };

/** Read evidence data from the loaded prompt, independently of its grading descriptor. */
function parseTemporalEvidenceRecords(prompt: string): EvidenceRecord[] {
    return prompt.split('\n').flatMap(line => {
        const match = /^(D\d{2}) \| (K\d+) \| (Court|Registry) \| (\d+) \| (ok|bad) \| (R\d+) \| ([A-I,]+)$/.exec(line.trim());
        if (!match) return [];
        return [
            {
                id: match[1]!,
                slot: match[2]!,
                authority: match[3]!,
                revision: Number(match[4]),
                signature: match[5]!,
                scope: match[6]!,
                before: match[7]!.split(',')
            }
        ];
    });
}

function temporalWithdrawalSubsets(): string[][] {
    const ids = Array.from({ length: 12 }, (_, index) => `D${String(index + 1).padStart(2, '0')}`);
    return [[], ...ids.map(id => [id]), ...ids.flatMap((left, index) => ids.slice(index + 1).map(right => [left, right]))];
}

function emptyTemporalSummary(): TemporalSummary {
    return {
        legal: 0,
        delivered: 0,
        certain: 63,
        possible: 0,
        legalPairs: ALL_TEMPORAL_PAIRS,
        deliveredPairs: ALL_TEMPORAL_PAIRS,
        smallestFailure: null
    };
}

/** First oracle: compare priorities within each slot, without using global record sorting. */
function resolveTemporalEvidenceBySlot(records: EvidenceRecord[], withdrawn: string[]): EvidenceRecord[] {
    const selected = new Map<string, EvidenceRecord>();
    for (const record of records) {
        if (withdrawn.includes(record.id) || record.signature !== 'ok' || record.scope !== 'R17') continue;
        const current = selected.get(record.slot);
        const authority = record.authority === 'Court' ? 2 : 1;
        const currentAuthority = current?.authority === 'Court' ? 2 : 1;
        if (!current || authority > currentAuthority || (authority === currentAuthority && record.revision > current.revision))
            selected.set(record.slot, record);
    }
    return [...selected.values()];
}

/** First oracle: literal Set copies are observed at I, so later events cannot alter the result. */
function simulateTemporalSetCopies(order: string): Set<string> {
    const copies = new Set(['Origin']);
    const transfers: Record<string, [string, string]> = {
        A: ['Origin', 'Birch'],
        B: ['Birch', 'Cedar'],
        C: ['Origin', 'Dune'],
        D: ['Dune', 'Cedar'],
        E: ['Cedar', 'Elm'],
        F: ['Elm', 'Terminal'],
        G: ['Dune', 'Terminal']
    };
    for (const event of order) {
        if (event === 'I') return copies;
        if (event === 'H') {
            copies.delete('Cedar');
            copies.delete('Terminal');
        } else {
            const [sender, receiver] = transfers[event]!;
            if (copies.has(sender)) copies.add(receiver);
        }
    }
    throw new Error('Temporal evidence history is missing seal I');
}

/** Enumerate all 9! total orders lexicographically, then filter each evidence graph. */
function temporalPermutationOracle(records: EvidenceRecord[]): WithdrawalCase[] {
    const graphCache = new Map<string, { edges: [number, number][]; summary: TemporalSummary }>();
    const cases = temporalWithdrawalSubsets().map(withdrawn => {
        const selected = resolveTemporalEvidenceBySlot(records, withdrawn);
        const active = selected.map(record => record.id).sort();
        const signature = active.join(',');
        if (!graphCache.has(signature))
            graphCache.set(signature, {
                edges: selected.flatMap(record =>
                    record.before.map(pair => [TEMPORAL_EVENTS.indexOf(pair[0]!), TEMPORAL_EVENTS.indexOf(pair[1]!)] as [number, number])
                ),
                summary: emptyTemporalSummary()
            });
        return { withdrawn, active, summary: graphCache.get(signature)!.summary };
    });
    const order = Array.from({ length: 9 }, (_, index) => index);
    const positions = new Int8Array(9);
    let permutations = 0;
    do {
        permutations++;
        order.forEach((event, index) => {
            positions[event] = index;
        });
        const compatible = [...graphCache.values()].filter(graph =>
            graph.edges.every(([before, after]) => positions[before]! < positions[after]!)
        );
        if (compatible.length) {
            const history = order.map(event => TEMPORAL_EVENTS[event]).join('');
            const copies = simulateTemporalSetCopies(history);
            const holderBits = TEMPORAL_LOCATIONS.reduce((bits, location, index) => bits | (copies.has(location) ? 1 << index : 0), 0);
            let relation = 0n;
            for (let before = 0; before < 9; before++)
                for (let after = 0; after < 9; after++)
                    if (positions[before]! < positions[after]!) relation |= TEMPORAL_PAIR_BITS[before]![after]!;
            for (const { summary } of compatible) {
                summary.legal++;
                summary.certain &= holderBits;
                summary.possible |= holderBits;
                summary.legalPairs &= relation;
                if (copies.has('Terminal')) {
                    summary.delivered++;
                    summary.deliveredPairs &= relation;
                } else if (summary.smallestFailure === null) summary.smallestFailure = history;
            }
        }
        let pivot = order.length - 2;
        while (pivot >= 0 && order[pivot]! > order[pivot + 1]!) pivot--;
        if (pivot < 0) break;
        let successor = order.length - 1;
        while (order[successor]! < order[pivot]!) successor--;
        [order[pivot], order[successor]] = [order[successor]!, order[pivot]!];
        for (let left = pivot + 1, right = order.length - 1; left < right; left++, right--)
            [order[left], order[right]] = [order[right]!, order[left]!];
    } while (true);
    expect(permutations).toBe(362880);
    return cases;
}

/** Second oracle: global authority/revision sort followed by the first surviving row per slot. */
function resolveTemporalEvidenceByPriority(records: EvidenceRecord[], withdrawn: string[]): EvidenceRecord[] {
    const eligible = records.filter(record => !withdrawn.includes(record.id) && record.signature === 'ok' && record.scope === 'R17');
    eligible.sort((left, right) => {
        if (left.authority !== right.authority) return left.authority === 'Court' ? -1 : 1;
        return right.revision - left.revision;
    });
    return eligible.filter((record, index) => eligible.findIndex(other => other.slot === record.slot) === index);
}

/** Second oracle: fixed integer transitions, separately encoded from the Set-copy implementation. */
function advanceTemporalBitCopies(event: number, copies: number): number {
    const origin = 16,
        birch = 1,
        cedar = 2,
        dune = 4,
        elm = 8,
        terminal = 32;
    switch (event) {
        case 0:
            return copies & origin ? copies | birch : copies;
        case 1:
            return copies & birch ? copies | cedar : copies;
        case 2:
            return copies & origin ? copies | dune : copies;
        case 3:
            return copies & dune ? copies | cedar : copies;
        case 4:
            return copies & cedar ? copies | elm : copies;
        case 5:
            return copies & elm ? copies | terminal : copies;
        case 6:
            return copies & dune ? copies | terminal : copies;
        case 7:
            return copies & ~(cedar | terminal);
        default:
            throw new Error('Temporal bit-copy transition must be A through H');
    }
}

/** Dynamic programming over ready events, possession, and the frozen seal observation. */
function temporalTopologicalOracle(records: EvidenceRecord[]): WithdrawalCase[] {
    return temporalWithdrawalSubsets().map(withdrawn => {
        const selected = resolveTemporalEvidenceByPriority(records, withdrawn);
        const prerequisites = Array<number>(9).fill(0);
        for (const record of selected)
            for (const pair of record.before) prerequisites[TEMPORAL_EVENTS.indexOf(pair[1]!)]! |= 1 << TEMPORAL_EVENTS.indexOf(pair[0]!);
        const memo = new Map<string, TemporalSummary>();
        function complete(done: number, copies: number, observed: number): TemporalSummary {
            if (done === 511)
                return {
                    legal: 1,
                    delivered: observed & 32 ? 1 : 0,
                    certain: observed,
                    possible: observed,
                    legalPairs: 0n,
                    deliveredPairs: 0n,
                    smallestFailure: observed & 32 ? null : ''
                };
            const key = `${done}/${copies}/${observed}`;
            const cached = memo.get(key);
            if (cached) return cached;
            const result = emptyTemporalSummary();
            for (let event = 0; event < 9; event++) {
                const bit = 1 << event;
                if (done & bit || (prerequisites[event]! & done) !== prerequisites[event]) continue;
                const nextDone = done | bit;
                const nextCopies = observed >= 0 || event === 8 ? copies : advanceTemporalBitCopies(event, copies);
                const nextObserved = event === 8 ? copies : observed;
                const child = complete(nextDone, nextCopies, nextObserved);
                if (!child.legal) continue;
                let firstBeforeRemaining = 0n;
                for (let after = 0; after < 9; after++)
                    if (!(nextDone & (1 << after))) firstBeforeRemaining |= TEMPORAL_PAIR_BITS[event]![after]!;
                result.legal += child.legal;
                result.delivered += child.delivered;
                result.certain &= child.certain;
                result.possible |= child.possible;
                result.legalPairs &= child.legalPairs | firstBeforeRemaining;
                if (child.delivered) result.deliveredPairs &= child.deliveredPairs | firstBeforeRemaining;
                if (child.smallestFailure !== null && result.smallestFailure === null)
                    result.smallestFailure = TEMPORAL_EVENTS[event]! + child.smallestFailure;
            }
            memo.set(key, result);
            return result;
        }
        return { withdrawn, active: selected.map(record => record.id).sort(), summary: complete(0, 16, -1) };
    });
}

function temporalAnswerFields(cases: WithdrawalCase[]) {
    const baseline = cases[0]!;
    const guarantees = cases.filter(({ summary }) => summary.legal > 0 && summary.legal === summary.delivered);
    const minimum = Math.min(...guarantees.map(item => item.withdrawn.length));
    const extraPairs: string[] = [];
    for (let before = 0; before < 9; before++)
        for (let after = 0; after < 9; after++) {
            const pair = TEMPORAL_PAIR_BITS[before]![after]!;
            if (pair && baseline.summary.deliveredPairs & pair && !(baseline.summary.legalPairs & pair))
                extraPairs.push(TEMPORAL_EVENTS[before]! + TEMPORAL_EVENTS[after]!);
        }
    return {
        active_memos: baseline.active,
        certain_holders: TEMPORAL_LOCATIONS.filter(location => baseline.summary.certain & TEMPORAL_LOCATION_BITS[location]!),
        possible_holders: TEMPORAL_LOCATIONS.filter(location => baseline.summary.possible & TEMPORAL_LOCATION_BITS[location]!),
        minimum_withdrawals: minimum,
        optimal_withdrawal_sets: guarantees.filter(item => item.withdrawn.length === minimum).map(item => item.withdrawn),
        smallest_failure_order: baseline.summary.smallestFailure,
        new_precedence_if_delivered: extraPairs
    };
}

describe('Assessment 2.1 temporal evidence independent oracles', () => {
    test('permutation filtering and topological state DP agree on all 79 withdrawal cases and all seven fields', () => {
        const bank = load_assessment_bank('2.1');
        const task = bank.tasks.find(card => card.id === 'L2_Temporal_Evidence_Withdrawals');
        expect(task).toBeDefined();
        const records = parseTemporalEvidenceRecords(task!.prompt);
        expect(records).toHaveLength(14);
        const permutation = temporalPermutationOracle(records);
        const topological = temporalTopologicalOracle(records);
        expect(permutation).toHaveLength(79);
        expect(topological).toEqual(permutation);
        expect(permutation[0]!.summary.legal).toBe(1062);
        expect(permutation[0]!.summary.delivered).toBe(446);
        expect(permutation.some(item => item.summary.legal === 0)).toBe(true);
        const answer = temporalAnswerFields(permutation);
        expect(bank.grading[task!.id]!.expected).toEqual(answer);
        expect(temporalAnswerFields(topological)).toEqual(answer);
        expect(answer.minimum_withdrawals).toBe(2);
        expect(answer.optimal_withdrawal_sets).toEqual([
            ['D04', 'D12'],
            ['D08', 'D12']
        ]);
        expect(task!.grade(JSON.stringify(answer)).content_score).toBe(1);
    }, 30000);

    test('successful history ACBGIHEDF refutes inferred H-before-I after observing delivery', () => {
        const task = load_assessment_bank('2.1').tasks.find(card => card.id === 'L2_Temporal_Evidence_Withdrawals');
        expect(task).toBeDefined();
        const records = parseTemporalEvidenceRecords(task!.prompt);
        const history = 'ACBGIHEDF';
        expect(history.indexOf('I')).toBeLessThan(history.indexOf('H'));
        for (const selected of [resolveTemporalEvidenceBySlot(records, []), resolveTemporalEvidenceByPriority(records, [])])
            for (const record of selected)
                for (const pair of record.before) expect(history.indexOf(pair[0]!)).toBeLessThan(history.indexOf(pair[1]!));
        expect(simulateTemporalSetCopies(history).has('Terminal')).toBe(true);
        let copies = 16;
        for (const event of history) {
            if (event === 'I') break;
            copies = advanceTemporalBitCopies(TEMPORAL_EVENTS.indexOf(event), copies);
        }
        expect(copies & 32).toBe(32);
        expect(simulateTemporalSetCopies('ACBGHEDFI').has('Terminal')).toBe(false);
    });
});
