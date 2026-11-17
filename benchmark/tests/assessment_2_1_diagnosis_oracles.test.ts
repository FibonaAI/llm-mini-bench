import { expect, test } from 'bun:test';
import { AssessmentFraction as Fraction } from '../src/assessment_tasks.ts';
const priorWeights = [3, 2, 4, 1, 2, 4];
const positiveWeights = [
    [3, 1, 2, 1, 3, 2],
    [1, 3, 1, 2, 2, 3],
    [2, 2, 3, 1, 1, 3],
    [3, 2, 1, 3, 2, 1],
    [1, 2, 3, 2, 3, 1]
];
const repairLosses = [
    [0, 2, 5, 7, 9, 6],
    [6, 0, 3, 8, 4, 7],
    [8, 5, 0, 2, 6, 4],
    [5, 8, 6, 0, 2, 3]
];
const inspectionCosts = [new Fraction(1, 20), new Fraction(1, 15), new Fraction(1, 24), new Fraction(1, 18), new Fraction(1, 16)];
const inspectionNames = ['thermal', 'acoustic', 'current', 'vibration', 'pressure'];
type World = { fault: number; signals: number; weight: number };
type Policy = { decision: number; objective: Fraction; inspections: number; inspectionCost: Fraction; zero?: Policy; one?: Policy };
const worlds: World[] = [];
for (let fault = 0; fault < 6; fault++)
    for (let signals = 0; signals < 32; signals++) {
        let weight = priorWeights[fault]!;
        for (let inspection = 0; inspection < 5; inspection++) {
            const positive = positiveWeights[inspection]![fault]!;
            weight *= signals & (1 << inspection) ? positive : 4 - positive;
        }
        worlds.push({ fault, signals, weight });
    }
const denominator = worlds.reduce((sum, world) => sum + world.weight, 0);
if (denominator !== 16384) throw new Error('Diagnosis joint-world prior is not normalized');
const less = (left: Fraction, right: Fraction) => left.numerator * right.denominator < right.numerator * left.denominator;
const cache = new Map<string, Policy>();
function optimize(observed: number, positive: number): Policy {
    const key = observed + ':' + positive;
    if (cache.has(key)) return cache.get(key)!;
    const compatible = worlds.filter(world => (world.signals & observed) === positive);
    const mass = compatible.reduce((sum, world) => sum + world.weight, 0);
    const losses = repairLosses.map(row => compatible.reduce((sum, world) => sum + world.weight * row[world.fault]!, 0));
    let best: Policy = {
        decision: -1 - losses.indexOf(Math.min(...losses)),
        objective: new Fraction(Math.min(...losses)),
        inspections: 0,
        inspectionCost: new Fraction(0)
    };
    let depth = 0;
    for (let bits = observed; bits; bits &= bits - 1) depth++;
    if (depth < 3)
        for (let test = 0; test < 5; test++) {
            if (observed & (1 << test)) continue;
            const zero = optimize(observed | (1 << test), positive);
            const one = optimize(observed | (1 << test), positive | (1 << test));
            const cost = inspectionCosts[test]!.mul(new Fraction(mass));
            const objective = cost.add(zero.objective).add(one.objective);
            if (less(objective, best.objective))
                best = {
                    decision: test,
                    objective,
                    inspections: mass + zero.inspections + one.inspections,
                    inspectionCost: cost.add(zero.inspectionCost).add(one.inspectionCost),
                    zero,
                    one
                };
        }
    cache.set(key, best);
    return best;
}
const root = optimize(0, 0);
const naming = (node: Policy) => (node.decision < 0 ? 'repair-' + -node.decision : inspectionNames[node.decision]);
const expected = {
    first_decision: naming(root),
    after_negative: naming(root.zero!),
    after_positive: naming(root.one!),
    minimum_expected_total_loss: { $fraction: root.objective.div(new Fraction(denominator)).toString() },
    expected_inspection_count: { $fraction: new Fraction(root.inspections, denominator).toString() },
    expected_inspection_cost: { $fraction: root.inspectionCost.div(new Fraction(denominator)).toString() },
    expected_terminal_loss: {
        $fraction: root.objective
            .add(root.inspectionCost.mul(new Fraction(-1)))
            .div(new Fraction(denominator))
            .toString()
    }
};
test('three-stage diagnosis regression preserves independent joint-noise-world optimization', () => {
    expect(expected).toEqual({
        first_decision: 'vibration',
        after_negative: 'current',
        after_positive: 'pressure',
        minimum_expected_total_loss: { $fraction: '308699/92160' },
        expected_inspection_count: { $fraction: '77/32' },
        expected_inspection_cost: { $fraction: '11519/92160' },
        expected_terminal_loss: { $fraction: '1651/512' }
    });
    expect(worlds).toHaveLength(192);
    expect(cache.size).toBe(131);
});
// A third check: replay the complete optimal policy in every fully sampled noise world.
let replayLoss = new Fraction(0),
    replayCost = new Fraction(0),
    replayCount = 0;
for (const world of worlds) {
    let node = root,
        worldCost = new Fraction(0),
        tests = 0;
    while (node.decision >= 0) {
        const test = node.decision;
        worldCost = worldCost.add(inspectionCosts[test]!);
        tests++;
        node = world.signals & (1 << test) ? node.one! : node.zero!;
    }
    replayLoss = replayLoss.add(new Fraction(world.weight * repairLosses[-1 - node.decision]![world.fault]!));
    replayCost = replayCost.add(worldCost.mul(new Fraction(world.weight)));
    replayCount += tests * world.weight;
}
if (!replayLoss.add(replayCost).equals(root.objective) || !replayCost.equals(root.inspectionCost) || replayCount !== root.inspections)
    throw new Error('Diagnosis complete-policy replay differs from optimizer');
test('whole-policy branch probabilities reproduce loss, paid inspections and stopping', () => {
    expect(replayLoss.add(replayCost).equals(root.objective)).toBe(true);
    expect(replayCost.equals(root.inspectionCost)).toBe(true);
    expect(replayCount).toBe(root.inspections);
    expect(expected.expected_inspection_count.$fraction).toBe('77/32');
    expect(expected.minimum_expected_total_loss.$fraction).toBe('308699/92160');
});
