import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank = load_assessment_bank('2.1');
function plain(value: any): any {
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === 'object') {
        if ('$fraction' in value) return value.$fraction;
        if ('$aliases' in value) return value.$aliases[0];
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
    }
    return value;
}

describe('Assessment 2.1 balanced candidate', () => {
    test('keeps 14 tasks across diverse domains with five interactive tasks and no hidden named-state DFA', () => {
        expect(bank.tasks).toHaveLength(14);
        expect(bank.tasks.filter(task => task.kind === 'tool')).toHaveLength(5);
        expect(bank.tasks.some(task => task.id.startsWith('T2_DFA_Identification'))).toBe(false);
        expect(new Set(bank.tasks.map(task => task.domain))).toEqual(new Set(['reasoning', 'code', 'context', 'instruction', 'tool_use']));
    });

    for (const task of bank.tasks) test(`${task.id} accepts its independently specified expected answer`, () => {
        const descriptor = (task as any).grading;
        if (descriptor.type === 'assessment-dfa-v1') {
            const simulator = task.make_simulator!();
            simulator.call('test_word', { word: '' });
            simulator.call('submit_dfa', { transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states });
            const grade = simulator.grade(JSON.stringify({ transitions: descriptor.config.transitions, accepting_states: descriptor.config.accepting_states }));
            expect(grade.content_score).toBe(1);
            expect(Object.values(grade.content_checks).every(Boolean)).toBe(true);
        } else if (descriptor.type === 'assessment-blackbox-v1') {
            const simulator = task.make_simulator!(), candidate_id = descriptor.config.expected_candidate;
            simulator.call('probe_case', { case_id: Object.keys(descriptor.config.candidates[candidate_id].outputs)[0] });
            simulator.call('submit_candidate', { candidate_id });
            const grade = simulator.grade(JSON.stringify({ candidate_id }));
            expect(grade.content_score).toBe(1);
            expect(Object.values(grade.content_checks).every(Boolean)).toBe(true);
        } else if (descriptor.type === 'assessment-documents-v1') {
            const simulator = task.make_simulator!();
            simulator.call('fetch_document', { document_id: Object.keys(descriptor.config.documents)[0] });
            const grade = simulator.grade(JSON.stringify(plain(descriptor.config.expected)));
            expect(grade.content_score).toBe(1);
            expect(grade.tool_checks?.used_documents).toBe(true);
        } else {
            const answer = JSON.stringify(plain(descriptor.expected));
            const grade = task.grade(answer);
            expect(grade.content_score).toBe(1);
            expect(Object.values(grade.content_checks).every(Boolean)).toBe(true);
        }
    });

    test('node-capacitated cut uses the independently recomputed six-unit minimum cut', () => {
        const expected = (bank.tasks.find(task => task.id === 'M2_Node_Capacitated_Cut') as any).grading.expected;
        expect(expected).toMatchObject({ max_flow: 6, min_cut_capacity: 6, min_cut_count: 1, second_cut_capacity: 8, min_cut_source_side: [], min_cut_nodes: ['A', 'B'] });
    });
});
