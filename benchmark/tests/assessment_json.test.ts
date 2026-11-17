import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    assessment_hash,
    assessmentJsonNumberToken,
    canonicalAssessmentJson,
    canonicalAssessmentJsonText,
    parseAssessmentAnswerJson,
    parseAssessmentJson
} from '../src/assessment_json.ts';

describe('strict assessment JSON and provenance hashes', () => {
    test('rejects duplicate keys, nonfinite numbers, invalid syntax and excessive nesting', () => {
        for (const text of [
            '{"a":1,"a":2}',
            '{"a":1,"\\u0061":2}',
            '{"nested":{"a":1,"a":2}}',
            'NaN',
            'Infinity',
            '1e999',
            '[1,]',
            '{"a":1,}',
            '[01]',
            '{"a":+1}',
            'true false',
            '"line\nfeed"',
            '\u00a0{}',
            ''
        ]) {
            expect(() => parseAssessmentJson(text)).toThrow(SyntaxError);
        }
        expect(() => parseAssessmentJson('[[[1]]]', 2)).toThrow('nesting limit');
        expect(parseAssessmentJson(' \r\n\t {"a":[true,false,null,"\\\\\\\"é"]} ')).toEqual({ a: [true, false, null, '\\"é'] });
    });

    test('answer-only parsing preserves overflow integers without admitting nonfinite API numbers', () => {
        const number = '9'.repeat(400);
        const text = '{"value":' + number + '}';
        expect(() => parseAssessmentJson(text)).toThrow('nonfinite number');
        const parsed = parseAssessmentAnswerJson(text) as { value: bigint };
        expect(parsed.value).toBe(BigInt(number));
        expect(assessmentJsonNumberToken(parsed, 'value')).toBe(number);
        expect(() => parseAssessmentAnswerJson('{"value":1e999}')).toThrow('nonfinite number');
    });

    test('keeps literal prototype keys inert and numeric spellings available', () => {
        const value = parseAssessmentJson('{"__proto__":{"polluted":true},"whole":3,"decimal":3.0,"exp":3e0,"array":[3.0]}') as Record<
            string,
            unknown
        >;
        expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(assessmentJsonNumberToken(value, 'whole')).toBe('3');
        expect(assessmentJsonNumberToken(value, 'decimal')).toBe('3.0');
        expect(assessmentJsonNumberToken(value, 'exp')).toBe('3e0');
        expect(assessmentJsonNumberToken(value.array as object, 0)).toBe('3.0');
    });

    test('canonical keys use Unicode code point order, including integer-looking keys', () => {
        expect(canonicalAssessmentJson({ '2': 2, '10': 10, '\u{10000}': 1, '\ue000': 2, é: '中文' })).toBe(
            '{"10":10,"2":2,"é":"中文","\ue000":2,"\u{10000}":1}'
        );
        expect(assessment_hash({ b: 2, a: 1 })).toBe(createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
        expect(assessment_hash({ a: 1, b: 2 })).toBe(assessment_hash({ b: 2, a: 1 }));
    });

    test('rejects silent JSON coercion while historical canonicalization preserves float tokens', () => {
        const cyclic: unknown[] = [];
        cyclic.push(cyclic);
        for (const value of [undefined, Infinity, NaN, { missing: undefined }, [undefined], new Date(), 3n, cyclic]) {
            expect(() => canonicalAssessmentJson(value)).toThrow();
        }
        const historical = '{ "score": 1.0, "id":"old", "cost":1e-05, "nested":{"id":1,"zero":-0.0} }';
        expect(canonicalAssessmentJsonText(historical, ['id'])).toBe('{"cost":1e-05,"nested":{"id":1,"zero":-0.0},"score":1.0}');
    });
});
