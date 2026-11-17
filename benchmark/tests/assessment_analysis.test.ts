import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, summarize_assessment } from '../tools/analyze_assessment.ts';
function records(): Record<string, any>[] {
    return [{ type: 'metadata', task_sha256: 'a', source_sha256: {}, config: {}, targets: [], tasks: [{ id: 'I', domain: 'instruction' }] },
        { type: 'observation', model: 'm', thinking: 'low', task: 'I', domain: 'instruction', round: 1, ok: true, status: 'completed',
            grade: { content_score: 1, outcome: 'incorrect', instruction_checks: { order: false } }, calls: ['a'], elapsed_seconds: 1 }];
}
test('analysis separates thinking and keeps instruction failure visible', () => {
    const [metadata, row] = records(); const result = summarize_assessment([metadata!, row!, { ...row, thinking: 'high' }]);
    expect(result.tasks[0].observed_configurations).toBe(2); expect(result.tasks[0].flags).toContain('instruction_failures_despite_separate_content_score');
});
test('analysis excludes failures from content means but counts them as zero in the execution summary', () => {
    const [metadata, row] = records(); const result = summarize_assessment([metadata!, row!, { ...row, round: 2, ok: false, grade: null, status: 'turn_limit' }]);
    const item = result.tasks[0].results[0]; expect([item.samples, item.gradable, item.content_mean, item.failure_as_zero_mean]).toEqual([2, 1, 1, 0.5]); expect(item.outcomes.turn_limit).toBe(1);
});
test('analysis preserves versioned bank provenance and unknown missing metadata', () => {
    const [metadata, row] = records(); metadata!.bank = { version: '1.0', task_ids: ['I'], scoring_policy: { aggregate: 'none' } }; metadata!.bank_scope = 'whole';
    const result = summarize_assessment([metadata!, row!]); expect(result.bank).toEqual(metadata!.bank); expect(result.bank_scope).toBe('whole');
    delete metadata!.bank; delete metadata!.bank_scope; expect(summarize_assessment([metadata!, row!]).bank).toBeNull();
});
test('analysis rejects duplicate rounds and ambiguous metadata', () => {
    const [metadata, row] = records(); expect(() => summarize_assessment([metadata!, row!, row!])).toThrow('duplicate samples');
    expect(() => summarize_assessment([row!])).toThrow('exactly one'); expect(() => summarize_assessment([metadata!, metadata!, row!])).toThrow('exactly one');
});
test('analysis reports partial cost as lower bound, not complete bill', () => {
    const result = summarize_assessment([...records(), { type: 'call', estimated_uncached_cost_usd: 0.1 }, { type: 'call', estimated_uncached_cost_usd: null }]);
    expect(result.missing_cost_calls).toBe(1); expect(result.known_cost_lower_bound_usd).toBe(0.1); expect(result.estimated_uncached_cost_usd).toBeNull();
});
test('analysis CLI runs offline and never overwrites evidence', () => {
    expect(main(['--help'])).toBe(0); const dir = mkdtempSync(join(tmpdir(), 'assessment-analysis-'));
    try {
        const input = join(dir, 'input.jsonl'), output = join(dir, 'output.json'); writeFileSync(input, records().map(row => JSON.stringify(row)).join('\n'));
        expect(main([input, '--output', output])).toBe(0); expect(JSON.parse(readFileSync(output, 'utf8')).samples).toBe(1);
        expect(() => main([input, '--output', output])).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
