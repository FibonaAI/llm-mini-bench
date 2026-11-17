import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank = load_assessment_bank('2.2');
const words = Array.from({ length: 32 }, (_, word) => word);
const bit = (word: number, index: number) => (word >> index) & 1;
const popcount = (word: number): number => word.toString(2).replaceAll('0', '').length;
const orbitCounts = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]];
function orbitIndex(word: number): number {
    const k = popcount(word & 7), l = popcount(word >> 3);
    return orbitCounts.findIndex(([a, b]) => (k === a && l === b) || (k === 3 - a && l === 2 - b));
}
function expandOrbitMasses(masses: number[]): number[] {
    return words.map(word => masses[orbitIndex(word)] / words.filter(other => orbitIndex(other) === orbitIndex(word)).length);
}
function checkAtomicMarginals(masses: number[], numerator: number, denominator: number): void {
    expect(masses.every(mass => Number.isInteger(mass) && mass >= 0)).toBe(true);
    expect(masses.reduce((sum, mass) => sum + mass, 0)).toBe(2880);
    for (let i = 0; i < 5; i++) {
        expect(words.reduce((sum, word) => sum + masses[word] * bit(word, i), 0)).toBe(1440);
        for (let j = i + 1; j < 5; j++) {
            const [originalNumerator, originalDenominator] = j < 3 ? [2, 3] : i === 3 ? [1, 1] : [2, 5];
            const actual = words.reduce((sum, word) => sum + masses[word] * Number(bit(word, i) !== bit(word, j)), 0);
            expect(actual * denominator * 2 * originalDenominator).toBe(2880 * (2 * numerator * originalNumerator + (denominator - numerator) * originalDenominator));
        }
    }
}
function checkAnswerMutations(id: string, answer: Record<string, unknown>): void {
    const task = bank.tasks.find(task => task.id === id)!;
    expect(task.grade(JSON.stringify(answer)).content_score).toBe(1);
    for (const field of Object.keys(answer)) {
        expect(task.grade(JSON.stringify({ ...answer, [field]: -999 })).content_score).toBeLessThan(1);
    }
}

// These certificates are independent of the task descriptors. All arithmetic in
// atomic distributions and obedience identities uses integer common denominators.
describe('Assessment 2.2 mathematical certificates', () => {
    test('global marginal inequality and atomic witnesses establish sharp bounds', () => {
        for (const word of words) {
            const k = popcount(word & 7), l = popcount(word >> 3), s = k - l;
            const within = k * (3 - k) + l * (2 - l);
            const cross = k * (2 - l) + (3 - k) * l;
            expect(within - cross).toBe(s * (1 - s));
            expect(within - cross).toBeLessThanOrEqual(0);
        }
        // E[within-cross] = -1 + 8t/5, so every feasible t is <= 5/8.
        checkAtomicMarginals(expandOrbitMasses([270, 0, 0, 270, 2340, 0]), 5, 8);
        const witnesses = [[72, 288, 0, 648, 1872, 0], [360, 0, 0, 72, 2160, 288]];
        const allEqual: number[] = [], tripleAndPairEqual: number[] = [];
        for (const orbitMasses of witnesses) {
            const masses = expandOrbitMasses(orbitMasses);
            checkAtomicMarginals(masses, 1, 2);
            allEqual.push(masses[0] + masses[31]);
            tripleAndPairEqual.push(words.reduce((sum, word) => sum + masses[word] * Number((popcount(word & 7) % 3 === 0) && (popcount(word >> 3) % 2 === 0)), 0));
            expect(words.reduce((sum, word) => sum + masses[word] * Number(bit(word, 3) === bit(word, 4)), 0)).toBe(720);
        }
        // Verify the linear identities used to bound every feasible distribution,
        // not just the witnesses. A is total ABC disagreement, B is DE, C is cross.
        for (const word of words) {
            const k = popcount(word & 7), l = popcount(word >> 3), orbit = orbitIndex(word);
            const a = k * (3 - k), b = l * (2 - l), c = k * (2 - l) + (3 - k) * l;
            expect(2 * Number(orbit <= 2)).toBe(2 - a);
            expect(2 * (Number(orbit === 1) + 3 * Number(orbit === 2) + Number(orbit === 5))).toBe(c - a - b);
        }
        // At half retention, w0+w1+w2=1/8 and w1+3w2+w5=1/10.
        // Nonnegativity gives w0>=1/8-1/10, w0<=1/8, and
        // (w0+w2)/(1/4)=1/2-4w1 in [1/10,1/2].
        expect(allEqual).toEqual([72, 360]);
        expect(tripleAndPairEqual).toEqual([72, 360]);
        checkAnswerMutations('F_Marginal_Compatibility', {
            maximum_feasible_t: '5/8', all_equal_bounds_at_half: { lower: '1/40', upper: '1/8' },
            conditional_triple_bounds_at_half: { lower: '1/10', upper: '1/2' },
        });
    });

    test('private obedience dual, atomic witnesses and public contradiction certify recommendation optima', () => {
        // Atom order is state L/H, then player 1, then player 2.
        const atoms = Array.from({ length: 8 }, (_, atom) => [bit(atom, 2), bit(atom, 1), bit(atom, 0)]);
        function obedience(masses: number[]): number[] {
            return [0, 1].flatMap(player => [0, 1].map(recommendation => atoms.reduce((sum, [state, a, b], index) => {
                const actions = [a, b];
                return sum + (actions[player] === recommendation ? masses[index] * ((state ? 2 : -3) + 2 * actions[1 - player]) * (recommendation ? 1 : -1) : 0);
            }, 0)));
        }
        // Symmetrize each individual atom using doubled masses. The resulting
        // identity holds on arbitrary mixtures, including asymmetric rules.
        for (let selected = 0; selected < 8; selected++) {
            const [state, a, b] = atoms[selected];
            const masses = Array(8).fill(0) as number[];
            masses[selected]++;
            masses[state * 4 + b * 2 + a]++;
            const [u, v, , w, x, y, , z] = masses;
            const active = 2 * y + 4 * z - 3 * v - w;
            const inactive = 3 * u + v - 2 * x - 4 * y;
            const prior = x + 2 * y + z;
            expect(18 * (y + v) + 10 * (x + w) + active + 3 * inactive).toBe(18 - 5 * prior);
        }
        // At prior 2/5 this proves objective <= 7/9. Equality forces x=w=0
        // and both obedience constraints tight; the unique symmetric masses
        // below give both-active mass 1/9, preserved by symmetrization.
        const informed = [10, 22, 22, 0, 0, 13, 13, 10];
        expect(informed.reduce((sum, value) => sum + value, 0)).toBe(90);
        expect(informed.slice(4).reduce((sum, value) => sum + value, 0)).toBe(36);
        expect(obedience(informed)).toEqual([0, 0, 0, 0]);
        expect(informed[1] + informed[2] + informed[5] + informed[6]).toBe(70);
        expect(informed[3] + informed[7]).toBe(10);
        const corrupted = [...informed]; corrupted[6]++; corrupted[7]--;
        expect(obedience(corrupted).some(slack => slack < 0)).toBe(true);
        // Blind rule: all four action profiles equally likely, independent of state.
        expect(obedience([3, 3, 3, 3, 2, 2, 2, 2])).toEqual([0, 0, 0, 0]);
        // Symmetric blind constraints q0>=q1 and q2>=q1 give 4q1<=1.
        // A public off-diagonal profile requires m>=0 and m+2<=0,
        // impossible. Always public 00 is feasible because prior theta=-1.
        expect(obedience([3, 0, 0, 0, 2, 0, 0, 0])).toEqual([5, 0, 5, 0]);
        checkAnswerMutations('F_Private_Recommendations', {
            informed_private_max: '7/9', blind_private_max: '1/2', informed_public_max: 0, minimum_both_at_informed_optimum: '1/9',
        });
    });

    test('cube coverage obstruction and actual local rule execution establish all three guessing optima', () => {
        const even = words.filter(word => popcount(word) % 2 === 0);
        const odd = words.filter(word => popcount(word) % 2 === 1);
        const covered = (word: number, centers: number[]) => centers.some(center => popcount(word ^ center) <= 1);
        let survivingTriples = 0;
        // Six centers must split 3/3 by parity. Exhaust every even triple:
        // if it leaves <=3 odd vertices uncovered, those are the forced odd centers.
        for (let i = 0; i < even.length; i++) for (let j = i + 1; j < even.length; j++) for (let k = j + 1; k < even.length; k++) {
            const centers = [even[i], even[j], even[k]];
            const missingOdd = odd.filter(word => !covered(word, centers));
            if (missingOdd.length > 3) continue;
            survivingTriples++;
            expect(missingOdd.length).toBe(3);
            expect(words.every(word => covered(word, [...centers, ...missingOdd]))).toBe(false);
        }
        expect(survivingTriples).toBeGreaterThan(0);
        function localRules(losing: number[]) {
            return Array.from({ length: 5 }, (_, player) => words.map(view => {
                const zero = view & ~(1 << player), one = zero | (1 << player);
                return losing.includes(zero) === losing.includes(one) ? -1 : losing.includes(zero) ? 1 : 0;
            }));
        }
        function successful(rules: number[][]): number[] {
            return words.filter(word => {
                const guesses = rules.map((rule, player) => rule[word & ~(1 << player)]);
                return guesses.some(guess => guess !== -1) && guesses.every((guess, player) => guess === -1 || guess === bit(word, player));
            });
        }
        const seven = [0, 1, 2, 15, 23, 27, 28];
        expect(words.every(word => covered(word, seven))).toBe(true);
        expect(successful(localRules(seven))).toEqual(words.filter(word => !seven.includes(word)));
        const eight = [0, 1, 2, 3, 28, 29, 30, 31];
        expect(words.every(word => covered(word, eight))).toBe(true);
        const complementRules = localRules(eight);
        expect(successful(complementRules).length).toBe(24);
        // Complement symmetry makes losing cardinality even, hence at least 8.
        for (let player = 0; player < 5; player++) for (const view of words.filter(word => !bit(word, player))) {
            const output = complementRules[player][view];
            expect(complementRules[player][view ^ (31 ^ (1 << player))]).toBe(output < 0 ? -1 : 1 - output);
        }
        let anonymousMaximum = 0;
        for (let encoding = 0; encoding < 3 ** 5; encoding++) {
            let remainder = encoding;
            const outputs = Array.from({ length: 5 }, () => { const output = remainder % 3 - 1; remainder = Math.floor(remainder / 3); return output; });
            const rules = Array.from({ length: 5 }, (_, player) => words.map(view => outputs[popcount(view & ~(1 << player))]));
            anonymousMaximum = Math.max(anonymousMaximum, successful(rules).length);
        }
        expect(anonymousMaximum).toBe(22);
        checkAnswerMutations('F_Distributed_Guessing', { unrestricted_max: 25, complement_equivariant_max: 24, anonymous_max: anonymousMaximum });
    });
});
