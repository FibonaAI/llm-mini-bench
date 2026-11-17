import { expect, test } from 'bun:test';
import { build_assessment_knowledge_tasks, GENETIC_CODE_EXPECTED, TREATY_EXCEPTIONS_EXPECTED, _dns_key_matches, _dns_ttl_matches } from './assessment_knowledge.ts';
import { assessment_result, grade_assessment_fields, parse_assessment_answer, _normalized_name } from './assessment_tasks.ts';

const make_tasks = () => build_assessment_knowledge_tasks(grade_assessment_fields, parse_assessment_answer, assessment_result);

test('independent NCBI compact code table confirms all three nonstandard internal codons', () => {
    const amino_acids = 'FFLLSSSSYY**CCWWTTTTPPPPHHQQRRRRIIMMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
    const codons: string[] = [];
    for (const first of 'TCAG') for (const second of 'TCAG') for (const third of 'TCAG') codons.push((first+second+third).replaceAll('T','U'));
    const mapping = Object.fromEntries(codons.map((codon,index) => [codon,amino_acids[index]]));
    expect(Object.keys(mapping)).toHaveLength(64);
    const expected = Object.fromEntries(['AUA','CUA','UGA'].map(codon => [codon,mapping[codon]]));
    expect(expected).toEqual({AUA:'M',CUA:'T',UGA:'W'});
    expect(make_tasks()[0]!.grade(JSON.stringify(expected)).content_score).toBe(1);
});

test('every frozen factual alias is accepted and not accepted as part of a contradiction', () => {
    for (const [field, aliases] of Object.entries(GENETIC_CODE_EXPECTED)) {
        for (const alias of aliases) {
            expect(grade_assessment_fields(JSON.stringify({[field]:alias}),{[field]:aliases}).content_score).toBe(1);
            expect(grade_assessment_fields(JSON.stringify({[field]:'not '+alias}),{[field]:aliases}).content_score).toBe(0);
        }
    }
    for (const aliases of [TREATY_EXCEPTIONS_EXPECTED.status,TREATY_EXCEPTIONS_EXPECTED.performance_principle]) {
        for (const alias of aliases) expect(grade_assessment_fields(JSON.stringify({x:alias}),{x:aliases}).content_score).toBe(1);
    }
});

test('source metadata is fresh on each builder call and no runtime settings enter task cards', () => {
    const tasks = make_tasks();
    tasks[0]!.source.push('mutated');
    tasks[1]!.measurement.necessary_operations.length = 0;
    const fresh = make_tasks();
    expect(fresh[0]!.source).toHaveLength(1);
    expect(fresh[1]!.measurement.necessary_operations.length).toBeGreaterThan(0);
    for (const task of fresh) {
        expect(task.kind).toBe('text');
        expect(task.domain).toBe('knowledge');
        expect(task.source_verified_at).toBe('2026-11-10');
        expect(task).not.toHaveProperty('thinking');
        expect(task).not.toHaveProperty('effort');
    }
});

test('DNS aliases preserve whole-field grammar rather than collapsing duplicates or negations', () => {
    expect(_dns_key_matches(['query class','qname'],new Set(['QCLASS','QNAME']))).toBe(true);
    expect(_dns_key_matches(['QNAME','query name'],new Set(['QCLASS','QNAME']))).toBe(false);
    expect(_dns_ttl_matches('min(SOA.MINIMUM, SOA.TTL)')).toBe(true);
    for (const text of ['not min(SOA.MINIMUM, SOA.TTL)','min(SOA.MINIMUM, SOA.MINIMUM)','min(SOA.MINIMUM, SOA.TTL, 60)']) expect(_dns_ttl_matches(text)).toBe(false);
});

test('alias normalization strips nonzero combining marks but preserves spacing marks', () => {
    expect(_normalized_name('VÉNUS.')).toBe('venus');
    expect(_normalized_name('V\u093eENUS')).not.toBe('venus');
    expect(grade_assessment_fields('{"x":"VÉNUS."}',{x:new Set(['Venus'])}).content_score).toBe(1);
    expect(grade_assessment_fields('{"x":"VाENUS"}',{x:new Set(['Venus'])}).content_score).toBe(0);
});
