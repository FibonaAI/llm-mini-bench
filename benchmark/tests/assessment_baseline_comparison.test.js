import { describe, expect, test } from 'bun:test';
import {
    baselineSourceKey,
    compareRecordToBaseline,
    dedupePromotedRuns,
    findMatchingBaselines,
    findPromotedBaseline
} from '../web/baseline-comparison.js';

function makeRecord(overrides = {}) {
    const tasks = overrides.tasks ?? [
        { task_id: 'T1', title: 'Task 1', samples: [{ round: 1, status: 'completed', content_score: 1 }] },
        { task_id: 'T2', title: 'Task 2', samples: [{ round: 1, status: 'completed', content_score: 0.5 }] }
    ];
    const raw = {
        id: overrides.id ?? 'rec-1',
        source: overrides.source ?? 'run',
        run_id: 'run_id' in overrides ? overrides.run_id : 'run-1',
        target_id: 'target_id' in overrides ? overrides.target_id : 'target-1',
        bank_version: overrides.bank_version ?? '2.0',
        model: overrides.model ?? 'gpt-6-luna',
        thinking: overrides.think ?? 'high',
        created_at: overrides.created_at ?? '2026-11-24T01:00:00Z',
        rounds: overrides.rounds ?? 1,
        estimated_cost_usd: 'estimated_cost_usd' in overrides ? overrides.estimated_cost_usd : 0.1,
        usage: 'usage' in overrides ? overrides.usage : { input_tokens: 1000, output_tokens: 500 },
        elapsed_seconds: 'elapsed_seconds' in overrides ? overrides.elapsed_seconds : 20,
        usage_accounting: overrides.usage_accounting ?? null,
        assessment_protocol_sha256: 'assessment_protocol_sha256' in overrides ? overrides.assessment_protocol_sha256 : 'proto-a',
        tasks
    };
    return {
        id: raw.id,
        source: raw.source,
        run_id: raw.run_id,
        target_id: raw.target_id,
        bank_version: raw.bank_version,
        model: raw.model,
        think: raw.thinking,
        created_at: raw.created_at,
        score: 'score' in overrides ? overrides.score : 75,
        cost: 'cost' in overrides ? overrides.cost : 0.1,
        original: raw
    };
}

describe('baseline deduplication and matching', () => {
    test('dedupePromotedRuns hides duplicate run circle when its promoted baseline is present', () => {
        const baseline = makeRecord({ id: 'base-1', source: 'baseline', run_id: 'run-a', target_id: 't1' });
        const sameRun = makeRecord({ id: 'run-a:t1', source: 'run', run_id: 'run-a', target_id: 't1' });
        const otherRun = makeRecord({ id: 'run-b:t1', source: 'run', run_id: 'run-b', target_id: 't1' });

        expect(baselineSourceKey(baseline)).toBe('2.0::run-a::t1');
        expect(dedupePromotedRuns([baseline, sameRun, otherRun]).map(r => r.id)).toEqual(['base-1', 'run-b:t1']);
        // When filtered to runs only, the run stays visible.
        expect(dedupePromotedRuns([sameRun, otherRun]).map(r => r.id)).toEqual(['run-a:t1', 'run-b:t1']);
        expect(findPromotedBaseline(sameRun, [baseline, sameRun, otherRun])?.id).toBe('base-1');
        expect(findPromotedBaseline(otherRun, [baseline, sameRun, otherRun])).toBeNull();
    });

    test('findMatchingBaselines matches same bank_version, model, and think, excluding self and own promoted counterpart', () => {
        const run = makeRecord({ id: 'run-new:t1', source: 'run', run_id: 'run-new', target_id: 't1', model: 'm1', think: 'high' });
        const ownBase = makeRecord({
            id: 'base-own',
            source: 'baseline',
            run_id: 'run-new',
            target_id: 't1',
            model: 'm1',
            think: 'high',
            created_at: '2026-11-24T05:00:00Z'
        });
        const oldBase = makeRecord({
            id: 'base-old',
            source: 'baseline',
            run_id: 'run-1',
            target_id: 't1',
            model: 'm1',
            think: 'high',
            created_at: '2026-11-20T00:00:00Z'
        });
        const newerBase = makeRecord({
            id: 'base-newer',
            source: 'baseline',
            run_id: 'run-2',
            target_id: 't1',
            model: 'm1',
            think: 'high',
            created_at: '2026-11-22T00:00:00Z'
        });
        const diffThink = makeRecord({
            id: 'base-low',
            source: 'baseline',
            run_id: 'run-3',
            target_id: 't1',
            model: 'm1',
            think: 'low'
        });
        const diffModel = makeRecord({
            id: 'base-m2',
            source: 'baseline',
            run_id: 'run-4',
            target_id: 't1',
            model: 'm2',
            think: 'high'
        });
        const diffBank = makeRecord({
            id: 'base-v1',
            source: 'baseline',
            run_id: 'run-5',
            target_id: 't1',
            bank_version: '1.0',
            model: 'm1',
            think: 'high'
        });

        const matches = findMatchingBaselines(run, [run, ownBase, oldBase, newerBase, diffThink, diffModel, diffBank]);
        expect(matches.map(r => r.id)).toEqual(['base-newer', 'base-old']);
        // A baseline itself does not match itself, but can compare against other baselines with same model+think.
        expect(findMatchingBaselines(newerBase, [oldBase, newerBase]).map(r => r.id)).toEqual(['base-old']);
    });

    test('compareRecordToBaseline computes objective deltas, per-task drops, lower-bound honesty, and protocol mismatch', () => {
        const baseline = makeRecord({
            id: 'base',
            source: 'baseline',
            run_id: 'run-base',
            score: 85,
            rounds: 2,
            estimated_cost_usd: 0.2,
            usage: { input_tokens: 2000, output_tokens: 1000 },
            elapsed_seconds: 40,
            assessment_protocol_sha256: 'proto-a',
            tasks: [
                {
                    task_id: 'T1',
                    title: 'Task 1',
                    samples: [
                        { round: 1, status: 'completed', content_score: 1 },
                        { round: 2, status: 'completed', content_score: 1 }
                    ]
                },
                {
                    task_id: 'T2',
                    title: 'Task 2',
                    samples: [
                        { round: 1, status: 'completed', content_score: 0.5 },
                        { round: 2, status: 'completed', content_score: 0.5 }
                    ]
                },
                {
                    task_id: 'T3',
                    title: 'Task 3',
                    samples: [
                        { round: 1, status: 'completed', content_score: 1 },
                        { round: 2, status: 'completed', content_score: 1 }
                    ]
                }
            ]
        });

        const suspect = makeRecord({
            id: 'run-suspect',
            source: 'run',
            run_id: 'run-2',
            score: 65,
            rounds: 2,
            estimated_cost_usd: null,
            usage: null,
            usage_accounting: {
                estimated_cost_usd_lower_bound: 0.26,
                usage_lower_bound: { input_tokens: 2400, output_tokens: 1200 },
                unknown_cost_attempts: 1,
                unknown_usage_attempts: 1
            },
            elapsed_seconds: 60,
            assessment_protocol_sha256: 'proto-b',
            tasks: [
                {
                    task_id: 'T1',
                    title: 'Task 1',
                    samples: [
                        { round: 1, status: 'timeout', content_score: 0 },
                        { round: 2, status: 'completed', content_score: 1 }
                    ]
                },
                {
                    task_id: 'T2',
                    title: 'Task 2',
                    samples: [
                        { round: 1, status: 'completed', content_score: 1 },
                        { round: 2, status: 'completed', content_score: 1 }
                    ]
                },
                {
                    task_id: 'T3',
                    title: 'Task 3',
                    samples: [
                        { round: 1, status: 'completed', content_score: 1 },
                        { round: 2, status: 'api_failure', content_score: null }
                    ]
                }
            ]
        });

        const diff = compareRecordToBaseline(suspect, baseline);
        expect(diff).not.toBeNull();
        expect(diff.score.delta).toBeCloseTo(-20, 6);
        // Incomplete cost/tokens must never fabricate full deltas.
        expect(diff.cost.delta).toBeNull();
        expect(diff.cost.currentLowerBound).toBeCloseTo(0.13, 6);
        expect(diff.tokens.delta).toBeNull();
        expect(diff.tokens.currentLowerBound).toBeCloseTo(1800, 6);
        // Duration is complete: 30s/round vs 20s/round => +10s (+50%).
        expect(diff.duration.delta).toBeCloseTo(10, 6);
        expect(diff.duration.ratio).toBeCloseTo(0.5, 6);
        expect(diff.protocolKnown).toBe(true);
        expect(diff.protocolMatch).toBe(false);
        // Per-task: T1 dropped -0.5, T2 gained +0.5, T3 incomplete (uncomparable, never imputed as zero).
        expect(diff.lowerCount).toBe(1);
        expect(diff.higherCount).toBe(1);
        expect(diff.equalCount).toBe(0);
        expect(diff.uncomparableCount).toBe(1);
        expect(diff.biggestDrops.map(t => t.task_id)).toEqual(['T1']);
        expect(diff.taskMap.get('T1').delta).toBeCloseTo(-0.5, 6);
        expect(diff.taskMap.get('T2').delta).toBeCloseTo(0.5, 6);
        expect(diff.taskMap.get('T3').delta).toBeNull();
        expect(diff.taskMap.get('T3').currentIncomplete).toBe(true);
    });
});
