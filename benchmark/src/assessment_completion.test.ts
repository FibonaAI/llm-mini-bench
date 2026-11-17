import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    summarize_assessment_completion,
    type AssessmentCompletionSample,
    type AssessmentCompletionPlan
} from './assessment_completion.ts';
import { assessment_hash } from './assessment_json.ts';
import { main, report_assessment_completion } from '../tools/report_assessment_completion.ts';

function fixture(count = 10, rounds = 1, exceptions = 0) {
    const plan: AssessmentCompletionPlan = {
        task_ids: Array.from({ length: count }, (_, index) => 'task-' + index),
        targets: [{ model: 'm', thinking: 'high' }],
        rounds
    };
    const observations: AssessmentCompletionSample[] = [];
    for (let round = 1; round <= rounds; round++)
        for (const task of plan.task_ids) {
            const index = observations.length;
            observations.push({
                sample_id: 'sample-' + index,
                model: 'm',
                thinking: 'high',
                task,
                round,
                status: index < exceptions ? 'api_failure' : 'completed',
                runner_error: index < exceptions ? 'SampleTimeout' : null,
                grade: index < exceptions ? null : { content_score: 1 }
            });
        }
    return { plan, observations };
}

describe('exception-aware completion scoring', () => {
    test('exactly 30 percent is accepted, and the next exception invalidates the result', () => {
        for (const [count, rounds, accepted, rejected] of [
            [10, 1, 3, 4],
            [10, 2, 6, 7],
            [4, 2, 2, 3]
        ]) {
            for (const [exceptions, valid] of [
                [accepted, true],
                [rejected, false]
            ] as const) {
                const f = fixture(count, rounds, Number(exceptions));
                const target = summarize_assessment_completion(f.plan, f.observations)[0]!;
                expect(target.assessment_valid).toBe(valid);
                expect(target.score_percent).toBe(valid ? 100 : null);
                expect(target.included_samples).toBe(count! * rounds! - Number(exceptions));
                expect(target.reasons.unattributed_timeout).toBe(Number(exceptions));
            }
        }
    });
    test('all exceptions return no score; valid wrong answers are genuine zeros', () => {
        const f = fixture(10, 1, 10);
        expect(summarize_assessment_completion(f.plan, f.observations)[0]!.score_percent).toBeNull();
        const zeros = f.observations.map(sample => ({ ...sample, status: 'completed', runner_error: null, grade: { content_score: 0 } }));
        const report = summarize_assessment_completion(f.plan, zeros)[0]!;
        expect(report.assessment_valid).toBe(true);
        expect(report.score_percent).toBe(0);
        expect(report.exceptions).toBe(0);
    });
    test('ambiguous and ungradable answers fail the task, but missing grading remains an exception', () => {
        const f = fixture();
        f.observations[0]!.grade = { content_score: null, outcome: 'ambiguous' };
        f.observations[1]!.grade = { content_score: null, outcome: 'ungradable' };
        f.observations[2]!.grade = null;
        f.observations[3]!.status = 'empty_final_answer';
        const report = summarize_assessment_completion(f.plan, f.observations)[0]!;
        expect(report.task_failures).toBe(3);
        expect(report.exceptions).toBe(1);
        expect(report.score_percent).toBeCloseTo((6 / 9) * 100);
    });
    test('local sample timeout and transport TimeoutError do not prove model computation', () => {
        const f = fixture();
        f.observations[0]!.status = 'response_incomplete_or_error';
        f.observations[0]!.grade = null;
        f.observations[0]!.calls = ['call'];
        const calls = [
            {
                call_id: 'call',
                sample_id: f.observations[0]!.sample_id,
                http_status: -1,
                raw_response: { exception: 'TimeoutError', verified_compute_deadline: true }
            }
        ];
        const report = summarize_assessment_completion(f.plan, f.observations, calls)[0]!;
        expect(report.exceptions).toBe(1);
        expect(report.samples[0]!.reason).toBe('unattributed_timeout');
        const trusted = [
            {
                sample_id: f.observations[0]!.sample_id,
                kind: 'verified_compute_deadline' as const,
                evidence_reference: 'executor-fixture:compute-deadline'
            }
        ];
        const verified = summarize_assessment_completion(f.plan, f.observations, calls, trusted)[0]!;
        expect(verified.task_failures).toBe(1);
        expect(verified.exceptions).toBe(0);
        expect(verified.score_percent).toBe(90);
        f.observations[0]!.status = 'completed';
        expect(() => summarize_assessment_completion(f.plan, f.observations, calls, trusted)).toThrow('contradictory');
    });
    test('reviewed active-output task deadlines are zeros without claiming compute duration', () => {
        const f = fixture(10, 1, 1);
        const evidence = [
            {
                sample_id: 'sample-0',
                kind: 'verified_task_deadline' as const,
                evidence_reference: 'reviewed-sse-fixture:content-and-local-deadline'
            }
        ];
        const report = summarize_assessment_completion(f.plan, f.observations, [], evidence)[0]!;
        expect(report.score_percent).toBe(90);
        expect(report.exceptions).toBe(0);
        expect(report.samples[0]!.reason).toBe('verified_task_deadline');
        expect(summarize_assessment_completion(f.plan, f.observations)[0]!.exceptions).toBe(1);
        f.observations[0]!.runner_error = null;
        expect(() => summarize_assessment_completion(f.plan, f.observations, [], evidence)).toThrow('recorded local sample timeout');
    });
    test('recovered transport errors do not invalidate final completed grades, and no raw values mutate', () => {
        const f = fixture();
        f.observations[0]!.calls = ['failed', 'success'];
        const calls = [
            { call_id: 'failed', sample_id: 'sample-0', http_status: -1, raw_response: { exception: 'TimeoutError' } },
            { call_id: 'success', sample_id: 'sample-0', http_status: 200, raw_response: { status: 'completed' } }
        ];
        const before = JSON.stringify({ ...f, calls });
        expect(summarize_assessment_completion(f.plan, f.observations, calls)[0]!.score_percent).toBe(100);
        expect(JSON.stringify({ ...f, calls })).toBe(before);
    });
    test('missing, duplicated, unexpected and misattributed evidence cannot become zeros', () => {
        const f = fixture();
        expect(() => summarize_assessment_completion(f.plan, f.observations.slice(1))).toThrow('missing planned');
        expect(() => summarize_assessment_completion(f.plan, [...f.observations.slice(1), f.observations[1]!])).toThrow('duplicate');
        expect(() => summarize_assessment_completion(f.plan, [...f.observations, { ...f.observations[0]!, task: 'unknown' }])).toThrow(
            'unexpected'
        );
        expect(() =>
            summarize_assessment_completion(
                f.plan,
                f.observations.map(sample => ({ ...sample, sample_id: 'same' }))
            )
        ).toThrow('sample ID');
        f.observations[0]!.calls = ['missing'];
        expect(() => summarize_assessment_completion(f.plan, f.observations)).toThrow('call evidence');
    });
    test('the exception threshold applies independently to targets, not pooled across models', () => {
        const f = fixture(10, 1, 4),
            other = fixture(10);
        const observations = [
            ...f.observations,
            ...other.observations.map(sample => ({ ...sample, sample_id: 'b-' + sample.sample_id, model: 'other' }))
        ];
        const reports = summarize_assessment_completion(
            { ...f.plan, targets: [...f.plan.targets, { model: 'other', thinking: 'high' }] },
            observations
        );
        expect(reports[0]!.assessment_valid).toBe(false);
        expect(reports[1]!.assessment_valid).toBe(true);
    });
});

test('offline completion CLI preserves inputs, refuses replacement and rejects incompatible merges', () => {
    const dir = mkdtempSync(join(tmpdir(), 'completion-report-'));
    try {
        const f = fixture(),
            tasks = f.plan.task_ids.map(id => ({ id, prompt: 'fixture' }));
        const metadata = {
            type: 'metadata',
            ...f.plan,
            tasks,
            planned_samples: 10,
            task_sha256: assessment_hash(tasks),
            source_sha256: { 'fixture.ts': 'a'.repeat(64) },
            config: { timeout: 300 },
            bank: { version: 'fixture' }
        };
        const input = join(dir, 'observations.jsonl'),
            output = join(dir, 'report.json');
        const bytes =
            [metadata, ...f.observations.map(sample => ({ type: 'observation', ...sample }))].map(row => JSON.stringify(row)).join('\n') +
            '\n';
        writeFileSync(input, bytes);
        main(['--input', input, '--output', output]);
        expect(JSON.parse(readFileSync(output, 'utf8')).targets[0].score_percent).toBe(100);
        expect(readFileSync(input, 'utf8')).toBe(bytes);
        expect(() => main(['--input', input, '--output', output])).toThrow();
        expect(() => report_assessment_completion([input, input])).toThrow('target appears');
        const other = join(dir, 'other.jsonl');
        writeFileSync(other, bytes.replace('"timeout":300', '"timeout":301'));
        expect(() => report_assessment_completion([input, other])).toThrow('different banks');
        writeFileSync(other, bytes.replace('"prompt":"fixture"', '"prompt":"changed"'));
        expect(() => report_assessment_completion([other])).toThrow('snapshot hash differs');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
