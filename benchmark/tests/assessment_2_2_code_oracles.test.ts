import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank = load_assessment_bank('2.2');
function gradeCodeAnswer(id: string, answer: Record<string, unknown>) {
    const task = bank.tasks.find(task => task.id === id);
    expect(task).toBeDefined();
    expect(task!.grade(JSON.stringify(answer)).content_score).toBe(1);
    for (const key of Object.keys(answer)) {
        expect(task!.grade(JSON.stringify({ ...answer, [key]: null })).content_checks[key]).toBe(false);
    }
}
function subsets<T>(values: T[]): T[][] {
    return Array.from({ length: 2 ** values.length }, (_, mask) => values.filter((_, index) => mask & 2 ** index));
}
function minimalSubsets<T>(values: T[], sufficient: (selected: T[]) => boolean): T[][] {
    return subsets(values).filter(selected => sufficient(selected) && selected.every((_, index) => !sufficient(selected.filter((_, other) => index !== other))));
}
const lexical = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en');

describe('Assessment 2.2 independent code oracles', () => {
    test('symbolic coordinates establish all alias patterns, minimal guards and kernel dimensions', () => {
        const patterns: number[][] = [];
        function extend(prefix: number[]) {
            if (prefix.length === 4) { patterns.push(prefix); return; }
            for (let next = 0; next <= Math.max(...prefix) + 1; next++) extend([...prefix, next]);
        }
        extend([0]);
        // A signed nonzero integer denotes one signed initial coordinate; no arithmetic cancellation is possible here.
        function rotate(pattern: number[], fused: boolean): number[] {
            const heap = Array.from({ length: Math.max(...pattern) + 1 }, (_, index) => index + 1);
            const [a, b, c, d] = pattern as [number, number, number, number];
            const t = heap[a]!;
            if (fused) {
                const u = heap[c]!;
                heap[a] = -heap[b]!;
                heap[c] = -heap[d]!;
                heap[b] = t;
                heap[d] = u;
            } else {
                heap[a] = -heap[b]!;
                heap[b] = t;
                const u = heap[c]!;
                heap[c] = -heap[d]!;
                heap[d] = u;
            }
            return heap;
        }
        const equivalent = patterns.filter(pattern => JSON.stringify(rotate(pattern, false)) === JSON.stringify(rotate(pattern, true)));
        const pairs = ['ab', 'ac', 'ad', 'bc', 'bd', 'cd'];
        const sufficient = (guard: string[]) => patterns.every(pattern => !guard.every(pair => pattern['abcd'.indexOf(pair[0]!)] !== pattern['abcd'.indexOf(pair[1]!)]) || equivalent.includes(pattern));
        const lostDimensions = (pattern: number[]) => Math.max(...pattern) + 1 - new Set(rotate(pattern, true).map(Math.abs)).size;
        expect(patterns).toHaveLength(15);
        const answer = {
            equivalent_patterns: equivalent.map(pattern => pattern.join('')).sort(),
            minimal_guards: minimalSubsets(pairs, sufficient).sort(lexical),
            information_loss_patterns: patterns.filter(pattern => lostDimensions(pattern) > 0).map(pattern => pattern.join('')).sort(),
            maximum_lost_dimensions: Math.max(...patterns.map(lostDimensions)),
        };
        expect(answer.minimal_guards).toEqual([['ac', 'bc', 'bd']]);
        expect(answer.maximum_lost_dimensions).toBe(1);
        gradeCodeAnswer('CFinal_Aliased_Rotation_Fusion', answer);
    });

    test('prefix dynamic programming finds every shortest loss and every probe tokenization', () => {
        const tokens = [['01', '010', '1001'], ['10', '101', '0110']];
        function tokenizations(word: string) {
            const counts = Array.from({ length: word.length + 1 }, () => [0, 0]);
            const switches = Array.from({ length: word.length + 1 }, () => [Infinity, Infinity]);
            for (let position = 0; position < word.length; position++) for (const mode of [0, 1]) for (const token of tokens[mode]!) {
                if (!word.startsWith(token, position)) continue;
                const end = position + token.length;
                if (position === 0) { counts[end]![mode]!++; switches[end]![mode] = 0; }
                else for (const previous of [0, 1]) {
                    counts[end]![mode]! += counts[position]![previous]!;
                    switches[end]![mode] = Math.min(switches[end]![mode]!, switches[position]![previous]! + Number(previous !== mode));
                }
            }
            return { minimum_switches: Math.min(...switches[word.length]!), tokenizations: counts[word.length]!.reduce((sum, count) => sum + count, 0) };
        }
        let shortestLosses: string[] = [];
        const countsByLength: number[][] = [[1, 1]];
        for (let length = 1; length <= 9; length++) {
            let reference = 0, optimized = 0;
            for (let bits = 0; bits < 2 ** length; bits++) {
                const word = bits.toString(2).padStart(length, '0');
                const result = tokenizations(word);
                if (!result.tokenizations) continue;
                reference++;
                if (result.minimum_switches <= 1) optimized++;
                else shortestLosses.push(word);
            }
            countsByLength.push([reference, optimized]);
            if (shortestLosses.length) break;
        }
        expect(countsByLength).toEqual([[1, 1], [0, 0], [2, 2], [2, 2], [4, 4], [6, 6], [10, 10], [16, 16], [26, 26], [42, 38]]);
        // The all-n certificate uses alternating forced X/Y windows, not extrapolation from these examples.
        for (let repetitions = 1; repetitions <= 24; repetitions++) {
            expect(tokenizations('010010010101101101'.repeat(repetitions)).minimum_switches).toBe(2 * repetitions - 1);
        }
        gradeCodeAnswer('CFinal_Erased_Token_Batching', {
            shortest_losses: shortestLosses.sort(), probe: tokenizations('0110010110'), repeat_switches: { slope: 2, intercept: -1 },
        });
    });

    test('all serial executions and observation partitions independently establish every minimal cover', () => {
        type Heap = [number, number, number];
        const orders = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'];
        const initial: Heap[] = Array.from({ length: 8 }, (_, bits) => [(bits >> 2) & 1, (bits >> 1) & 1, bits & 1]);
        function execute(heap: Heap, transaction: string) {
            const [x, y, z] = heap;
            if (transaction === 'A') return { index: 0, value: y & z, reads: [y, z] };
            if (transaction === 'B') return { index: 1, value: (1 - x) | z, reads: [x, z] };
            return { index: 2, value: x ^ y, reads: [x, y] };
        }
        const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
        const matches = initial.map(heap => {
            const batch = ['A', 'B', 'C'].map(transaction => execute(heap, transaction));
            const final = batch.map(result => result.value);
            const finalOrders: string[] = [], readOrders: string[] = [];
            for (const order of orders) {
                const current = [...heap] as Heap;
                let readsMatch = true;
                for (const transaction of order) {
                    const result = execute(current, transaction);
                    readsMatch &&= same(result.reads, batch['ABC'.indexOf(transaction)]!.reads);
                    current[result.index] = result.value;
                }
                if (same(final, current)) { finalOrders.push(order); if (readsMatch) readOrders.push(order); }
            }
            return { finalOrders, readOrders };
        });
        expect(matches.map(match => match.finalOrders)).toEqual([
            ['ACB', 'CAB', 'CBA'], ['ACB', 'CAB', 'CBA'], ['ABC', 'ACB', 'BAC'], ['BCA', 'CAB', 'CBA'],
            ['BCA'], ['ABC', 'CAB'], ['BAC', 'CBA'], ['ABC', 'BAC'],
        ]);
        const covers = (portfolio: string[]) => matches.every(match => match.finalOrders.some(order => portfolio.includes(order)));
        const observable = (cells: string[]) => initial.every((heap, index) => orders.some(order => initial.every((other, otherIndex) =>
            !cells.every(cell => heap['xyz'.indexOf(cell)] === other['xyz'.indexOf(cell)]) || matches[otherIndex]!.finalOrders.includes(order))));
        gradeCodeAnswer('CFinal_Snapshot_Serial_Witness', {
            final_state_failures: initial.filter((_, index) => !matches[index]!.finalOrders.length).map(heap => heap.join('')),
            read_observation_failures: initial.filter((_, index) => !matches[index]!.readOrders.length).map(heap => heap.join('')),
            minimal_portfolios: minimalSubsets(orders, covers).sort(lexical),
            minimal_observation_sets: minimalSubsets(['x', 'y', 'z'], observable).map(cells => cells.join('')).sort(),
        });
    });
});
