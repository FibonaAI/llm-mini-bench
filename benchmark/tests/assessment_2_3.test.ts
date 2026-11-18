import { describe, expect, test } from 'bun:test';
import { SUBMIT_ANSWER_PROTOCOL, task_answer_protocol, task_answer_schema } from '../src/assessment_answer_protocol.ts';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank = load_assessment_bank('2.3');

describe('Assessment 2.3 experimental bank', () => {
    test('loads through the shared loader with balanced 6-domain coverage and 12 tasks', () => {
        expect(bank.status).toBe('experimental-unvalidated');
        expect(bank.tasks.length).toBe(12);
        expect(bank.task_sha256).toBe('aa53f0d1d5e68b9c4de67cf1080e99cf76e043dfd79516ed08aa89f0408e38e0');
        expect(new Set(bank.tasks.map(task => task.domain))).toEqual(
            new Set(['knowledge', 'reasoning', 'code', 'context', 'instruction', 'tool_use'])
        );
        for (const domain of ['knowledge', 'reasoning', 'code', 'context', 'instruction', 'tool_use']) {
            expect(bank.tasks.filter(task => task.domain === domain).length).toBe(2);
        }
        expect(bank.tasks.filter(task => task.kind === 'tool').length).toBe(3);
        expect(bank.tasks.filter(task => task.kind === 'text').length).toBe(9);
        expect(bank.tasks.every(task => !('thinking' in task) && !('effort' in task))).toBe(true);
        expect(Object.keys(bank.grading).sort()).toEqual([...bank.task_ids].sort());
        expect(Object.keys(bank.selection).sort()).toEqual([...bank.task_ids].sort());
        for (const task of bank.tasks) {
            expect(task_answer_protocol(task)).toBe(SUBMIT_ANSWER_PROTOCOL);
            const schema = task_answer_schema(task);
            expect(Array.isArray(schema.required) && schema.required.length > 0).toBe(true);
            expect(Object.keys(schema.properties as object).sort()).toEqual([...(schema.required as string[])].sort());
        }
    });

    test('preserves production 1.0 and legacy 2.1 / 2.2 bank snapshots unchanged', () => {
        expect(load_assessment_bank().version).toBe('1.0');
        expect(load_assessment_bank().task_sha256).toBe('6e089b1c6a3762e56c16c803045106481eeef3a0d81437457ad3795e86cb684d');
        expect(load_assessment_bank('2.1').task_sha256).toBe('e182bb429567845f340a095b0ca2a4cc33eb470af4da7af19e9945b60c8a9a77');
        expect(load_assessment_bank('2.2').task_sha256).toBe('74e695dc95797cc63af143e2fce2322ac25fa6c665c42bee87e403ae05514adc');
        expect(bank.task_sha256).not.toBe(load_assessment_bank('2.2').task_sha256);
    });

    for (const task of bank.tasks.filter(task => task.kind === 'text')) {
        test(`${task.id} keeps missing text answers ungradable (null)`, () => {
            expect(task.grade('').content_score).toBeNull();
        });
    }
});
