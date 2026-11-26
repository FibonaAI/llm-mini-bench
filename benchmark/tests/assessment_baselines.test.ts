import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ASSESSMENT_PROJECT_ROOT, assessment_task_snapshot, load_assessment_bank } from '../src/assessment_bank.ts';
import {
    assessment_observations,
    build_assessment_baseline,
    load_assessment_baselines,
    validate_assessment_baseline
} from '../src/assessment_baselines.ts';
import { capture_assessment_sources, create_assessment_source_context } from '../src/assessment_provenance.ts';
import { project_assessment_observation } from '../src/assessment_observations.ts';
import { assessment_hash } from '../src/assessment_json.ts';
import { assessment_sample_protocol, execution_protocol_hash } from '../src/run_protocol.ts';
import { main as importBaseline } from '../tools/import_assessment_baseline.ts';

type Evidence = Record<string, any>;
const dirs: string[] = [];
const temporary = () => {
    const dir = mkdtempSync(join(tmpdir(), 'assessment-baseline-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function completeRun(rounds = 2): Evidence {
    const bank = load_assessment_bank(),
        cards = bank.tasks.map(assessment_task_snapshot);
    const config = { max_output_tokens: 8192, max_turns: 6, max_tool_calls: 5, timeout: 120 };
    const target = {
        id: 'target-1',
        model: 'example/model',
        route_id: 'example/route',
        account_ref: 'account-a',
        account_evidence: 'configured_binding',
        thinking: 'high'
    };
    const sources = { ...bank.source_sha256 };
    for (const path of ['calibrate_assessment.ts', 'src/run_protocol.ts', 'src/client.ts'])
        sources[path] = createHash('sha256')
            .update(readFileSync(join(ASSESSMENT_PROJECT_ROOT, path)))
            .digest('hex');
    const { tasks: _tasks, ...snapshot } = bank;
    const run: Evidence = {
        id: 'test-run',
        status: 'completed',
        created_at: '2026-11-11T00:00:00Z',
        plan: {
            bank_version: '1.0',
            bank_scope: 'whole',
            bank_snapshot: snapshot,
            task_ids: bank.task_ids,
            task_snapshots: cards,
            source_sha256: sources,
            targets: [target],
            rounds,
            limits: config
        },
        samples: []
    };
    for (let round = 1; round <= rounds; round++)
        for (const card of cards) {
            const { execution_protocol: protocol, assessment_protocol_sha256 } = assessment_sample_protocol(card, 'high', config, false);
            run.samples.push({
                sample_id: `${card.id}-${round}`,
                run_id: run.id,
                target_id: target.id,
                route_id: target.route_id,
                account_ref: target.account_ref,
                task: card.id,
                round,
                model: target.model,
                thinking: 'high',
                status: 'completed',
                ok: true,
                execution_protocol: protocol,
                execution_protocol_sha256: execution_protocol_hash(protocol),
                assessment_protocol_sha256,
                grade: { content_score: 0.5, instruction_checks: { json_only: false }, outcome: 'partial' }
            });
        }
    return run;
}
describe('observation query verification', () => {
    test('empty queries do not load sources, and multiple targets and baselines share one load', () => {
        let loads = 0;
        const context = create_assessment_source_context(() => {
            loads++;
            return load_assessment_bank();
        });
        expect(assessment_observations([], [], context)).toEqual([]);
        expect(loads).toBe(0);
        const run = completeRun(1),
            baseline = build_assessment_baseline(run, 'target-1');
        const second = { ...run.plan.targets[0], id: 'target-2', model: 'second-model' };
        run.plan.targets.push(second);
        run.samples.push(
            ...run.samples.map((sample: Evidence) => ({
                ...sample,
                target_id: second.id,
                model: second.model,
                sample_id: sample.sample_id + '-second'
            }))
        );
        const rows = assessment_observations([baseline], [run, run], context);
        expect(rows).toHaveLength(5);
        expect(rows.every(row => row.baseline_eligible)).toBe(true);
        expect(loads).toBe(1);
        assessment_observations(
            [],
            [run],
            create_assessment_source_context(() => {
                loads++;
                return load_assessment_bank();
            })
        );
        expect(loads).toBe(2);
    });
    test('baseline file loading and observation projection can share one query-local source context', () => {
        const run = completeRun(1),
            baseline = build_assessment_baseline(run, 'target-1');
        const path = join(temporary(), 'baseline.json');
        writeFileSync(path, JSON.stringify(baseline));
        let loads = 0;
        const context = create_assessment_source_context(() => {
            loads++;
            return load_assessment_bank();
        });
        const loaded = load_assessment_baselines([path], context);
        expect(loaded).toHaveLength(1);
        expect(loads).toBe(1);
        const rows = assessment_observations(loaded, [run], context);
        expect(rows).toHaveLength(2);
        expect(rows.every(row => row.baseline_eligible)).toBe(true);
        expect(loads).toBe(1);
    });
    test('incomplete run preflight skips task snapshot and protocol work but not bank validity', () => {
        const run = completeRun(1);
        run.status = 'running';
        const bank = load_assessment_bank();
        let cards = 0;
        const context = {
            production_bank: () => bank,
            production_cards() {
                cards++;
                throw new Error('Unreachable snapshot work');
            }
        };
        const rows = assessment_observations([], [run], context);
        expect(rows[0]!.ineligibility_reason).toBe('Assessment baseline: run must be completed');
        expect(cards).toBe(0);
        let loads = 0;
        const invalid = create_assessment_source_context(() => {
            loads++;
            throw new TypeError('Assessment bank: source hash mismatch');
        });
        expect(assessment_observations([], [run, run], invalid).map(row => row.ineligibility_reason)).toEqual([
            'Assessment bank: source hash mismatch',
            'Assessment bank: source hash mismatch'
        ]);
        expect(loads).toBe(1);
    });
    test('pure projection neither validates nor fills missing sample evidence', () => {
        const run = completeRun(1);
        run.samples[0].status = 'api_failure';
        run.samples[0].grade = null;
        const row = project_assessment_observation(run as any, run.plan.targets[0], 'run', null, 'fixture-reason');
        expect(row.baseline_eligible).toBe(false);
        expect(row.ineligibility_reason).toBe('fixture-reason');
        expect(row.tasks[0]!.samples[0]!.content_score).toBeNull();
        expect(row.usage).toBeNull();
    });
});

describe('assessment baseline validation', () => {
    test('complete rounds retain separate content and instruction checks with stable deep snapshots', () => {
        const run = completeRun(),
            baseline = build_assessment_baseline(run, 'target-1');
        expect(baseline.schema).toBe('assessment-baseline-v1');
        expect(baseline.samples).toHaveLength(24);
        expect(baseline.samples[0].grade.content_score).toBe(0.5);
        expect(baseline.samples[0].grade.instruction_checks.json_only).toBe(false);
        expect(baseline).not.toHaveProperty('score');
        expect(baseline).not.toHaveProperty('weights');
        expect(baseline).toEqual(build_assessment_baseline(run, 'target-1'));
        baseline.samples[0].grade.content_score = 0;
        expect(run.samples[0].grade.content_score).toBe(0.5);
    });
    test('incomplete unprovenanced or contradictory runs are rejected', () => {
        const changes: ((run: Evidence) => void)[] = [
            r => (r.status = 'failed'),
            r => (r.plan.bank_version = '0.1'),
            r => (r.plan.bank_scope = 'subset'),
            r => r.plan.task_ids.pop(),
            r => (r.plan.bank_snapshot.task_sha256 = '0'.repeat(64)),
            r => (r.plan.source_sha256 = {}),
            r => delete r.plan.source_sha256['src/run_protocol.ts'],
            r => (r.plan.task_snapshots[0].prompt = 'modified'),
            r => r.samples.pop(),
            r => r.samples.push(structuredClone(r.samples[0])),
            r => (r.samples[0].round = 3),
            r => (r.samples[0].status = 'response_incomplete_or_error'),
            r => (r.samples[0].ok = false),
            r => (r.samples[0].model = 'other'),
            r => (r.samples[0].account_ref = 'other'),
            r => (r.samples[0].execution_protocol = null),
            r => (r.samples[0].execution_protocol_sha256 = '0'.repeat(64)),
            r => (r.samples[0].assessment_protocol_sha256 = '0'.repeat(64)),
            r => (r.samples[0].grade.content_score = null),
            r => (r.samples[0].grade.content_score = NaN),
            r => (r.samples[0].grade.content_score = true),
            r => (r.samples[0].grade.instruction_checks = {}),
            r => (r.samples[0].grade.instruction_checks = { json_only: 1 }),
            r => (r.plan.rounds = true),
            r => (r.plan.limits.timeout = -1),
            r => r.plan.targets.push(structuredClone(r.plan.targets[0]))
        ];
        const original = completeRun();
        for (const change of changes) {
            const run = structuredClone(original);
            change(run);
            expect(() => build_assessment_baseline(run, 'target-1')).toThrow(TypeError);
        }
        for (const [run, target] of [
            [null, 'target-1'],
            [{}, 'target-1'],
            [original, 'missing']
        ])
            expect(() => build_assessment_baseline(run as Evidence, target as string)).toThrow(TypeError);
    });
    test('duplicate rounds cannot replace missing rounds', () => {
        const run = completeRun();
        run.samples[run.samples.length - 1] = structuredClone(run.samples[0]);
        expect(() => build_assessment_baseline(run, 'target-1')).toThrow('duplicate task round');
    });
    test('observations preserve failures and missing usage without imputed zero', () => {
        const run = completeRun();
        run.status = 'failed';
        run.samples[0].status = 'turn_limit';
        run.samples[0].grade = { content_score: 0 };
        const record = assessment_observations([], [run])[0]!;
        expect(record.baseline_eligible).toBe(false);
        expect(record.tasks[0].samples[0].content_score).toBeNull();
        expect(record.usage).toBeNull();
        expect(record.estimated_cost_usd).toBeNull();
        expect(record.account_ref).toBe('account-a');
        expect(record.tasks).toHaveLength(12);
        expect(record.tasks[0].samples).toHaveLength(2);
    });
    test('recorded catalog identity survives baseline snapshots while absent metadata stays unknown', () => {
        const run = completeRun();
        Object.assign(run.plan.targets[0], {
            provider_id: 'chatgpt-api-2',
            provider_evidence: 'gateway_catalog',
            model_display_name: 'Display model'
        });
        const baseline = build_assessment_baseline(run, 'target-1');
        const records = assessment_observations([baseline], [run]);
        expect(records).toHaveLength(2);
        for (const record of records) {
            expect(record.provider_id).toBe('chatgpt-api-2');
            expect(record.provider_evidence).toBe('gateway_catalog');
            expect(record.model_display_name).toBe('Display model');
            expect(record.model).toBe('example/model');
            expect(record.bank_scope).toBe('whole');
            expect(record.sample_count).toBe(run.samples.length);
            expect(record.baseline_eligible).toBe(true);
        }
        run.plan.targets[0].provider_id = 'changed';
        expect(assessment_observations([baseline], [])[0]!.provider_id).toBe('chatgpt-api-2');
        const unknown = assessment_observations([], [completeRun()])[0]!;
        for (const key of ['provider_id', 'provider_evidence', 'model_display_name']) expect(unknown[key]).toBeNull();
        expect(unknown.baseline_eligible).toBe(true);
    });
    test('remote route namespace survives baseline and observation snapshots without changing ownership or identity', () => {
        const run = completeRun();
        const remote = { namespace: 'remote-provider-route', evidence: 'magpie_via_catalog' };
        Object.assign(run.plan.targets[0], {
            provider_id: 'outer-magpie-instance',
            provider_evidence: 'gateway_catalog',
            remote_route: remote
        });
        const baseline = build_assessment_baseline(run, 'target-1');
        const observations = assessment_observations([baseline], [run]);
        for (const observation of observations) {
            expect(observation.remote_route).toEqual(remote);
            expect(observation.provider_id).toBe('outer-magpie-instance');
            expect(observation.model).toBe('example/model');
            expect(observation.route_id).toBe('example/route');
            expect(observation.account_ref).toBe('account-a');
            expect(observation.account_evidence).toBe('configured_binding');
        }
        remote.namespace = 'changed-external-object';
        expect(baseline.target.remote_route?.namespace).toBe('remote-provider-route');
        expect((observations[0]!.remote_route as typeof remote).namespace).toBe('remote-provider-route');
        (observations[1]!.remote_route as typeof remote).namespace = 'changed-observation-copy';
        expect(run.plan.targets[0].remote_route.namespace).toBe('changed-external-object');
        const root = temporary(),
            path = join(root, 'remote-baseline.json');
        writeFileSync(path, JSON.stringify(baseline));
        const loaded = load_assessment_baselines([path]);
        expect(loaded).toHaveLength(1);
        expect(assessment_observations(loaded, [])[0]!.remote_route).toEqual({
            namespace: 'remote-provider-route',
            evidence: 'magpie_via_catalog'
        });
        expect(assessment_observations([], [completeRun()])[0]!.remote_route).toBeNull();
    });
    test('usage and cost require every sample and include all rounds', () => {
        const run = completeRun();
        for (const sample of run.samples) {
            sample.usage = { input_tokens: 10, output_tokens: 5 };
            sample.estimated_uncached_cost_usd = 0.01;
        }
        const record = assessment_observations([], [run])[0]!;
        expect(record.usage).toEqual({ input_tokens: 240, output_tokens: 120 });
        expect(record.estimated_cost_usd).toBeCloseTo(0.24);
        delete run.samples[0].usage;
        delete run.samples[0].estimated_uncached_cost_usd;
        const missing = assessment_observations([], [run])[0]!;
        expect(missing.usage).toBeNull();
        expect(missing.estimated_cost_usd).toBeNull();
    });
    test('observation sample count includes samples outside the task snapshot', () => {
        const run = completeRun();
        run.samples.push({ ...run.samples[0], task: 'unexpected-task', sample_id: 'extra-sample' });
        const observation = assessment_observations([], [run])[0]!;
        expect(observation.sample_count).toBe(25);
        expect(observation.tasks.flatMap(task => task.samples)).toHaveLength(24);
        expect(observation.baseline_eligible).toBe(false);
    });
    test('observation projection preserves ended_after_submission from answer_submission', () => {
        const run = completeRun();
        run.samples[0].answer_submission = {
            protocol: 'submit-answer-tool-v1',
            call_id: 'call-1',
            answer: { answer: 'ok' },
            submissions: 1,
            ended_after_submission: 'api_failure'
        };
        run.samples[1].answer_submission = {
            protocol: 'submit-answer-tool-v1',
            call_id: 'call-2',
            answer: { answer: 'ok' },
            submissions: 1,
            ended_after_submission: null
        };
        const observation = assessment_observations([], [run])[0]!;
        const firstTaskSamples = observation.tasks[0]!.samples;
        expect(firstTaskSamples[0]!.ended_after_submission).toBe('api_failure');
        expect(firstTaskSamples[1]!.ended_after_submission).toBeNull();
        expect(observation.tasks[1]!.samples[0]!.ended_after_submission).toBeNull();
    });
    test('loader skips obsolete invalid tampered files and deduplicates', () => {
        const run = completeRun(),
            baseline = build_assessment_baseline(run, 'target-1'),
            root = temporary();
        for (const name of ['valid', 'duplicate']) writeFileSync(join(root, name + '.json'), JSON.stringify(baseline));
        writeFileSync(join(root, 'old.json'), '{"schema":"fingerprint-v1"}');
        writeFileSync(join(root, 'bad.json'), '{');
        const forged = structuredClone(baseline);
        forged.samples[0].grade.content_score = 1;
        writeFileSync(join(root, 'forged.json'), JSON.stringify(forged));
        const loaded = load_assessment_baselines(readdirSync(root).map(path => join(root, path)));
        expect(loaded).toEqual([baseline]);
        expect(load_assessment_baselines([root, join(root, 'missing.json')])).toEqual([]);
        const records = assessment_observations(loaded, [run]);
        expect(records.map(row => row.source)).toEqual(['baseline', 'run']);
        expect(records[0]!.assessment_protocol_sha256).toBe(records[1]!.assessment_protocol_sha256);
    });
    test('importer accepts native evidence idempotently without overwriting changed evidence', () => {
        const root = temporary(),
            runPath = join(root, 'run.json'),
            output = join(root, 'baselines');
        writeFileSync(runPath, JSON.stringify(completeRun()));
        const args = [runPath, '--target-id', 'target-1', '--output-dir', output];
        expect(importBaseline(args)).toBe(0);
        expect(importBaseline(args)).toBe(0);
        const paths = readdirSync(output).map(path => join(output, path));
        expect(load_assessment_baselines(paths)).toHaveLength(1);
        writeFileSync(paths[0]!, '{}');
        expect(() => importBaseline(args)).toThrow('different evidence');
    });
    test('retried runs stay eligible across backend source updates when bank sources, limits and policy match', () => {
        const bank = load_assessment_bank();
        const run = completeRun(1);
        const retrySources: Record<string, string> = {
            ...run.plan.source_sha256,
            ...(bank.extension_sha256 ?? {}),
            'src/bench_execution.ts': 'a'.repeat(64),
            'src/assessment_runner.ts': 'b'.repeat(64)
        };
        run.retry_batches = [
            {
                request_id: '1'.repeat(32),
                sample_ids: [run.samples[0].sample_id],
                source_sha256: retrySources,
                limits: { ...run.plan.limits, max_requests: null, max_cost_usd: null },
                created_at: '2026-11-12T00:00:00Z'
            }
        ];
        run.samples[0].retry_source_sha256 = structuredClone(retrySources);
        run.samples[0].retry_limits = { ...run.plan.limits, max_requests: null, max_cost_usd: null };

        const baseline = build_assessment_baseline(run, 'target-1');
        expect(validate_assessment_baseline(baseline)).toEqual(baseline);
        const observation = assessment_observations([], [run])[0]!;
        expect(observation.baseline_eligible).toBe(true);
        expect(observation.ineligibility_reason).toBeNull();
    });
    test('retried runs reject bank source changes, policy/limit changes, and still surface sample timeout failures', () => {
        const bank = load_assessment_bank();
        const base = completeRun(1);
        const retrySources: Record<string, string> = {
            ...base.plan.source_sha256,
            ...(bank.extension_sha256 ?? {}),
            'src/bench_execution.ts': 'c'.repeat(64)
        };
        base.retry_batches = [
            {
                request_id: '2'.repeat(32),
                sample_ids: [base.samples[0].sample_id],
                source_sha256: retrySources,
                limits: structuredClone(base.plan.limits),
                created_at: '2026-11-12T00:00:00Z'
            }
        ];
        base.samples[0].retry_source_sha256 = structuredClone(retrySources);
        base.samples[0].retry_limits = structuredClone(base.plan.limits);

        const changedBank = structuredClone(base);
        changedBank.retry_batches[0].source_sha256['src/assessment_tasks.ts'] = '0'.repeat(64);
        expect(() => build_assessment_baseline(changedBank, 'target-1')).toThrow('retry: task source hashes are missing or stale');

        const changedExt = structuredClone(base);
        changedExt.retry_batches[0].source_sha256['src/assessment_blackbox.ts'] = '0'.repeat(64);
        expect(() => build_assessment_baseline(changedExt, 'target-1')).toThrow('retry: task source hashes are missing or stale');

        const changedPolicy = structuredClone(base);
        changedPolicy.retry_batches[0].policy = 'sample-timeout-v1';
        expect(() => build_assessment_baseline(changedPolicy, 'target-1')).toThrow('retry execution policy differs');

        const changedLimits = structuredClone(base);
        changedLimits.retry_batches[0].limits.timeout = 600;
        expect(() => build_assessment_baseline(changedLimits, 'target-1')).toThrow('retry execution limits differ');

        const missingProvenance = structuredClone(base);
        delete missingProvenance.retry_batches[0].source_sha256['src/client.ts'];
        expect(() => build_assessment_baseline(missingProvenance, 'target-1')).toThrow('retry: execution source provenance is missing');

        const invalidDigest = structuredClone(base);
        invalidDigest.retry_batches[0].source_sha256['src/bench_execution.ts'] = 'not-a-sha256';
        expect(() => build_assessment_baseline(invalidDigest, 'target-1')).toThrow('retry: invalid source digest');

        const timedOutSample = structuredClone(base);
        timedOutSample.samples[1].status = 'timeout';
        timedOutSample.samples[1].ok = false;
        expect(() => build_assessment_baseline(timedOutSample, 'target-1')).toThrow('failed or incomplete samples are not scores');

        // Model anomaly (no_submission) has no non-model anomaly and IS eligible for baseline promotion.
        const modelAnomalyRun = structuredClone(base);
        modelAnomalyRun.samples[1].grade = {
            content_score: 0,
            instruction_checks: { submitted_via_tool: false },
            outcome: 'no_submission'
        };
        modelAnomalyRun.samples[1].answer_submission = {
            protocol: 'submit-answer-tool-v1',
            call_id: null,
            answer: null,
            submissions: 0,
            ended_after_submission: null
        };
        const modelBaseline = build_assessment_baseline(modelAnomalyRun, 'target-1');
        expect(validate_assessment_baseline(modelBaseline)).toEqual(modelBaseline);

        // Post-submission timeout and post-submission non-model anomalies are BOTH rejected from baselines.
        const postTimeoutRun = structuredClone(base);
        postTimeoutRun.samples[1].answer_submission = {
            protocol: 'submit-answer-tool-v1',
            call_id: 'call-1',
            answer: { ok: true },
            submissions: 1,
            ended_after_submission: 'SampleTimeout'
        };
        expect(() => build_assessment_baseline(postTimeoutRun, 'target-1')).toThrow('timed-out samples are not eligible for baselines');

        const postApiFailRun = structuredClone(base);
        postApiFailRun.samples[1].answer_submission = {
            protocol: 'submit-answer-tool-v1',
            call_id: 'call-1',
            answer: { ok: true },
            submissions: 1,
            ended_after_submission: 'api_failure'
        };
        expect(() => build_assessment_baseline(postApiFailRun, 'target-1')).toThrow('non-model anomalies are not eligible for baselines');

        const forgedBaseline = build_assessment_baseline(base, 'target-1');
        forgedBaseline.samples[0].retry_source_sha256 = {
            ...retrySources,
            'src/assessment_tasks.ts': '0'.repeat(64)
        };
        expect(() => validate_assessment_baseline(forgedBaseline)).toThrow('retry: task source hashes are missing or stale');

        const forgedLimits = build_assessment_baseline(base, 'target-1');
        forgedLimits.samples[0].retry_limits = { ...base.plan.limits, max_turns: 99 };
        expect(() => validate_assessment_baseline(forgedLimits)).toThrow('retry execution limits differ');
    });
    test('importer help is offline and default output is module-relative', () => {
        expect(importBaseline(['--help'])).toBe(0);
        expect(readFileSync(join(ASSESSMENT_PROJECT_ROOT, 'tools/import_assessment_baseline.ts'), 'utf8')).toContain(
            "join(ASSESSMENT_PROJECT_ROOT, 'baselines')"
        );
    });
    test('Assessment 2.0 runs build validated 2.0 baselines and stay strictly isolated from 1.0', () => {
        const bank2 = load_assessment_bank('2.0');
        const cards2 = bank2.tasks.map(assessment_task_snapshot);
        const config = { max_output_tokens: null, max_turns: null, max_tool_calls: null, timeout: 600 };
        const target = {
            id: 'target-v2',
            model: 'example/model-v2',
            route_id: 'example/route',
            account_ref: 'account-a',
            account_evidence: 'configured_binding',
            thinking: 'high'
        };
        const sources: Record<string, string> = capture_assessment_sources(bank2).hashes;
        const { tasks: _tasks2, ...snapshot2 } = bank2;
        const run2: Evidence = {
            id: 'test-run-v2',
            status: 'completed',
            created_at: '2026-11-23T00:00:00Z',
            plan: {
                bank_version: '2.0',
                bank_scope: 'whole',
                bank_snapshot: snapshot2,
                task_ids: bank2.task_ids,
                task_snapshots: cards2,
                source_sha256: sources,
                targets: [target],
                rounds: 1,
                limits: config
            },
            samples: cards2.map(card => {
                const { execution_protocol, assessment_protocol_sha256 } = assessment_sample_protocol(card, 'high', config, false);
                return {
                    sample_id: `${card.id}-1`,
                    run_id: 'test-run-v2',
                    target_id: target.id,
                    route_id: target.route_id,
                    account_ref: target.account_ref,
                    task: card.id,
                    round: 1,
                    model: target.model,
                    thinking: 'high',
                    status: 'completed',
                    ok: true,
                    execution_protocol,
                    execution_protocol_sha256: execution_protocol_hash(execution_protocol),
                    assessment_protocol_sha256,
                    grade: { content_score: 0.75, instruction_checks: { submitted_via_tool: true }, outcome: 'partial' }
                };
            })
        };
        const baseline2 = build_assessment_baseline(run2, 'target-v2');
        expect(baseline2.bank_version).toBe('2.0');
        expect(baseline2.samples).toHaveLength(12);
        const run1 = completeRun(1);
        const baseline1 = build_assessment_baseline(run1, 'target-1');
        const combined = assessment_observations([baseline1, baseline2], [run1, run2]);
        expect(combined.map(r => [r.source, r.bank_version, r.baseline_eligible])).toEqual([
            ['baseline', '1.0', true],
            ['baseline', '2.0', true],
            ['run', '1.0', true],
            ['run', '2.0', true]
        ]);
        expect(baseline2.bank_snapshot.extension_sha256).toEqual(bank2.extension_sha256);
        // Cross-version relabeling, tampered bank_snapshot.extension_sha256, or incomplete execution closure must fail.
        const relabeled = structuredClone(run2);
        relabeled.plan.bank_version = '1.0';
        expect(() => build_assessment_baseline(relabeled, 'target-v2')).toThrow(TypeError);
        const badSnapExt = structuredClone(run2);
        badSnapExt.plan.bank_snapshot.extension_sha256 = { 'src/assessment_blackbox_v2.ts': '0'.repeat(64) };
        expect(() => build_assessment_baseline(badSnapExt, 'target-v2')).toThrow('extension_sha256');
        const missingExt = structuredClone(run2);
        delete missingExt.plan.source_sha256['src/assessment_blackbox_v2.ts'];
        expect(() => build_assessment_baseline(missingExt, 'target-v2')).toThrow('extension source hashes');
        const missingExec = structuredClone(run2);
        delete missingExec.plan.source_sha256['src/assessment_runner.ts'];
        expect(() => build_assessment_baseline(missingExec, 'target-v2')).toThrow('execution source provenance');
    });
});
