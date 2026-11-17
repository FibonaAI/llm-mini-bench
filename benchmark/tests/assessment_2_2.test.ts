import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank = load_assessment_bank('2.2');

describe('Assessment 2.2 final experimental bank', () => {
    test('loads through the shared loader with broad coverage and at most fifteen tasks', () => {
        expect(bank.status).toBe('experimental-unvalidated');
        expect(bank.tasks.length).toBe(10);
        expect(bank.task_sha256).toBe('74e695dc95797cc63af143e2fce2322ac25fa6c665c42bee87e403ae05514adc');
        expect(new Set(bank.tasks.map(task => task.domain))).toEqual(new Set(['reasoning', 'code', 'context', 'instruction', 'tool_use']));
        expect(bank.tasks.filter(task => task.kind === 'tool').length).toBe(2);
        expect(bank.tasks.every(task => !('thinking' in task) && !('effort' in task))).toBe(true);
        expect(Object.keys(bank.grading).sort()).toEqual([...bank.task_ids].sort());
        expect(Object.keys(bank.selection).sort()).toEqual([...bank.task_ids].sort());
    });

    test('preserves production selection and legacy bank snapshots', () => {
        expect(load_assessment_bank().version).toBe('1.0');
        expect(load_assessment_bank().task_sha256).toBe('6e089b1c6a3762e56c16c803045106481eeef3a0d81437457ad3795e86cb684d');
        expect(load_assessment_bank('2.1').task_sha256).toBe('e182bb429567845f340a095b0ca2a4cc33eb470af4da7af19e9945b60c8a9a77');
        expect(bank.task_sha256).not.toBe(load_assessment_bank('2.1').task_sha256);
    });

    for (const task of bank.tasks.filter(task => task.kind === 'text'))
        test(`${task.id} does not turn a missing text answer into a zero score`, () => {
            const grade = task.grade('');
            expect(grade.content_score).toBeNull();
        });
});
