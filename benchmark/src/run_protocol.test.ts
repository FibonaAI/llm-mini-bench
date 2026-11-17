import { describe, expect, test } from 'bun:test';
import { advertised_thinking_levels, execution_protocol_hash, target_execution_protocol } from './run_protocol.ts';
import { calibration_price, calibration_visible_text } from './assessment_response.ts';
import { parseAssessmentJson } from './assessment_json.ts';

describe('execution protocol provenance', () => {
    test('advertised future efforts survive deduplication and reserved levels do not', () => {
        expect(
            advertised_thinking_levels({
                reasoning_levels: ['low', 'ultra', 'default', 'unknown'],
                supported_reasoning_levels: ['ultra', 'future-effort', null]
            })
        ).toEqual(['low', 'ultra', 'future-effort']);
        expect(advertised_thinking_levels({ reasoning_levels: 'high' })).toEqual([]);
    });
    test('default omits reasoning and is not explicit none; budgets change hash', () => {
        const questions = [{ id: 'task', max_output_tokens: 8192 }];
        const ordinary = target_execution_protocol(questions, 'default'),
            none = target_execution_protocol(questions, 'none');
        expect(ordinary.requests.task).toEqual({ max_output_tokens: 8192 });
        expect(none.requests.task!.reasoning).toEqual({ effort: 'none' });
        expect(execution_protocol_hash(ordinary)).not.toBe(execution_protocol_hash(none));
        expect(execution_protocol_hash(none)).not.toBe(
            execution_protocol_hash(target_execution_protocol([{ id: 'task', max_output_tokens: 1024 }], 'none'))
        );
    });
    test('identity and input order never affect hash', () => {
        const first = target_execution_protocol(
            [
                { id: 'a', model: 'model-a' },
                { id: 'b', account: 'account-a' }
            ],
            'high'
        );
        const second = target_execution_protocol([{ id: 'b' }, { id: 'a' }], 'high');
        expect(execution_protocol_hash(first)).toBe(execution_protocol_hash(second));
        expect(JSON.stringify(first)).not.toContain('model-a');
    });
    test('invalid protocols and implicit unknown thinking are rejected', () => {
        const original = target_execution_protocol([{ id: 'task', max_output_tokens: 8192 }], 'high');
        for (const [key, value] of [
            ['schema', 'unknown'],
            ['wire', 'chat'],
            ['requests', {}]
        ])
            expect(() => execution_protocol_hash({ ...original, [key as string]: value })).toThrow();
        for (const config of [
            { max_output_tokens: true },
            { max_output_tokens: 0 },
            { reasoning: { effort: 'default' } },
            { temperature: 1 },
            { reasoning: { effort: 'high', extra: true } }
        ])
            expect(() => execution_protocol_hash({ ...original, requests: { task: config } })).toThrow();
        for (const value of ['', 'unknown', 'mixed', null]) expect(() => target_execution_protocol([{ id: 'task' }], value)).toThrow();
        expect(() =>
            execution_protocol_hash(
                parseAssessmentJson(
                    '{"schema":"mini-bench-execution-v1","wire":"responses","requests":{"task":{"max_output_tokens":100.0}}}'
                )
            )
        ).toThrow();
    });
});
describe('visible response text and catalog prices', () => {
    test('hidden reasoning and refusal text never become the answer', () => {
        expect(
            calibration_visible_text({
                output: [
                    { type: 'reasoning', content: [{ type: 'output_text', text: 'hidden' }] },
                    {
                        type: 'message',
                        content: [
                            { type: 'output_text', text: 'visible' },
                            { type: 'refusal', text: 'other' }
                        ]
                    },
                    { type: 'message', content: [{ type: 'output_text', text: ' answer' }] }
                ]
            })
        ).toBe('visible answer');
        expect(calibration_visible_text({ output_text: 'answer' })).toBe('answer');
        for (const payload of [null, [], {}, { output: 'invalid' }, { output: [null, { content: null }] }])
            expect(calibration_visible_text(payload)).toBe('');
    });
    test('missing pricing is not free', () => {
        expect(calibration_price(0)).toBe(0);
        expect(calibration_price('0.000002')).toBe(0.000002);
        for (const value of [null, '', 'unknown', '0x10', -1, Infinity, NaN, true]) expect(() => calibration_price(value)).toThrow();
    });
});
