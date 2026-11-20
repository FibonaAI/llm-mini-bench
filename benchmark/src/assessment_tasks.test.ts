import { describe, expect, test } from 'bun:test';
import questions from '../banks/assessment-1.0.questions.json';
import { assessment_task_snapshot, load_assessment_bank } from './assessment_bank.ts';
import {
    AssessmentFraction,
    _rational,
    assessment_exact_fields,
    grade_assessment_fields,
    is_assessment_integer,
    is_assessment_object,
    parse_assessment_answer
} from './assessment_tasks.ts';

describe('shared assessment answer parsing and exact-field grading', () => {
    test('official question export matches loaded 1.0 task snapshots', () => {
        expect(questions).toHaveLength(12);
        const loaded = load_assessment_bank('1.0');
        expect(loaded.tasks).toHaveLength(12);
        expect(
            loaded.tasks.map(task => {
                const { grading: _grading, tools: _tools, ...snapshot } = assessment_task_snapshot(task) as Record<string, unknown>;
                return snapshot;
            })
        ).toEqual(
            questions.map(raw => {
                const { grading: _grading, tools: _tools, ...rest } = raw as Record<string, unknown>;
                return rest;
            })
        );
    });

    test('exact fractions aliases and nested structures grade with separate instruction checks', () => {
        const expected = {
            ratio: new AssessmentFraction(5, 12),
            alias: new Set(['Good Faith', '善意']),
            nested: { values: [1, true, 'x'] }
        };
        const full = grade_assessment_fields('{"ratio":"10/24","alias":"good faith","nested":{"values":[1,true,"x"]}}', expected);
        expect(full).toMatchObject({
            content_score: 1,
            content_checks: { ratio: true, alias: true, nested: true },
            instruction_checks: { json_only: true, exact_fields: true },
            outcome: 'correct'
        });

        const wrapped = grade_assessment_fields(
            'Result: ```json\n{"ratio":"5/12","alias":"善意","nested":{"values":[1,true,"x"]},"extra":1}\n```',
            expected
        );
        expect(wrapped).toMatchObject({
            content_score: 1,
            instruction_checks: { json_only: false, exact_fields: false },
            outcome: 'correct'
        });

        const abstained = grade_assessment_fields('UNKNOWN', expected);
        expect(abstained).toMatchObject({
            content_score: 0,
            outcome: 'abstained'
        });

        const fieldAbstained = grade_assessment_fields('{"ratio":"UNKNOWN","alias":"unsure","nested":"不知道"}', expected);
        expect(fieldAbstained).toMatchObject({
            content_score: 0,
            outcome: 'abstained',
            abstention_checks: { ratio: true, alias: true, nested: true }
        });
    });

    test('JSON number lexical types preserve integer versus float signatures and ambiguity detection', () => {
        expect(parse_assessment_answer('{"x":1} {"x":1.0}')[2]).toBe('ambiguous');
        expect(parse_assessment_answer('{"x":1.0} {"x":1e0}')[2]).toBeNull();
        expect(parse_assessment_answer('{"x":9007199254740992} {"x":9007199254740993}')[2]).toBe('ambiguous');
        const [intObj] = parse_assessment_answer('{"count":2}');
        const [floatObj] = parse_assessment_answer('{"count":2.0}');
        expect(is_assessment_integer(intObj!.count, intObj!, 'count')).toBe(true);
        expect(is_assessment_integer(floatObj!.count, floatObj!, 'count')).toBe(false);
        expect(is_assessment_object(intObj)).toBe(true);
        expect(is_assessment_object([])).toBe(false);
        expect(assessment_exact_fields(intObj!, ['count'])).toBe(true);
    });

    test('AssessmentFraction and _rational perform exact rational arithmetic without float drift', () => {
        const a = _rational('3/8')!;
        const b = _rational('0.125')!;
        expect(a.add(b).equals(new AssessmentFraction(1, 2))).toBe(true);
        expect(a.mul(b).equals(new AssessmentFraction(3, 64))).toBe(true);
        expect(a.div(b).equals(new AssessmentFraction(3, 1))).toBe(true);
        expect(_rational('1_000/2_000')?.equals(new AssessmentFraction(1, 2))).toBe(true);
        expect(_rational('1__0')).toBeNull();
        expect(() => new AssessmentFraction(1, 0)).toThrow('zero denominator');
    });
});
