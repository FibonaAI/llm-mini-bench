import { describe, expect, test } from 'bun:test';
import { BlackboxAssessmentSimulator, assessment_blackbox_tools } from '../src/assessment_blackbox.ts';
import { DocumentAssessmentSimulator, assessment_documents_tools } from '../src/assessment_documents.ts';
import { build_assessment_interactive_task } from '../src/assessment_interactive.ts';
import type { AssessmentTask } from '../src/assessment_tasks.ts';

const blackbox = () =>
    new BlackboxAssessmentSimulator({
        candidates: {
            A: { outputs: { x: 0, y: 1 } },
            B: { outputs: { x: 1, y: 0 } }
        },
        expected_candidate: 'A',
        query_limit: 2
    });

describe('generic interactive assessment simulators', () => {
    test('black-box probes identify a candidate without executing rule data', () => {
        const simulator = blackbox();
        expect(assessment_blackbox_tools().every(tool => tool.strict === true)).toBe(true);
        expect(simulator.call('probe_case', { case_id: 'x' })).toEqual({ ok: true, case_id: 'x', output: 0 });
        expect(simulator.call('submit_candidate', { candidate_id: 'A' }).correct).toBe(true);
        const grade = simulator.grade('{"candidate_id":"A"}');
        expect(grade.content_score).toBe(1);
        expect(Object.values(grade.content_checks).every(Boolean)).toBe(true);
    });

    test('black-box wrong or absent submissions earn no content credit and overflow fails tool checks', () => {
        const wrong = blackbox();
        wrong.call('probe_case', { case_id: 'x' });
        wrong.call('submit_candidate', { candidate_id: 'B' });
        const grade = wrong.grade('{"candidate_id":"B"}');
        expect(grade.content_score).toBe(0);
        expect(grade.content_checks.identified_rule).toBe(false);
        const overflow = blackbox();
        overflow.call('probe_case', { case_id: 'x' });
        overflow.call('probe_case', { case_id: 'y' });
        expect(overflow.call('probe_case', { case_id: 'x' }).error).toBe('query_limit');
        expect(overflow.grade('{}').tool_checks?.within_query_limit).toBe(false);
        expect(overflow.grade('{}').content_score).toBe(0);
        const noSubmission = blackbox();
        noSubmission.call('probe_case', { case_id: 'x' });
        expect(noSubmission.grade('{}').content_score).toBe(0);
        expect(overflow.grade('{}').tool_checks?.no_invalid_attempts).toBe(false);
    });

    test('submission closes the black-box so correctness feedback cannot become another probe', () => {
        const simulator = blackbox();
        expect(simulator.call('submit_candidate', { candidate_id: 'B' }).correct).toBe(false);
        expect(simulator.call('submit_candidate', { candidate_id: 'A' }).error).toBe('already_submitted');
        expect(simulator.grade('{"candidate_id":"A"}').content_score).toBe(0);
    });

    test('depot descriptors use the same generic adapter without a bank-version condition', () => {
        const card = {
            id: 'future_depot',
            title: 'Future depot',
            domain: 'tool_use',
            kind: 'tool',
            version: 'any-future-revision',
            prompt: 'Dispatch the pallet.'
        } as AssessmentTask;
        const descriptor = {
            type: 'assessment-depot-v1',
            name: 'fulfill',
            config: {
                locations: { bay: { capacity: 1, stack: [] }, stage: { capacity: 1, stack: ['P'] } },
                pallet_sizes: { P: 1 },
                routes: [
                    ['stage', 'bay'],
                    ['bay', 'stage']
                ],
                dispatch_location: 'stage',
                manifest: ['P'],
                retained_pallets: [],
                empty_at_completion: ['stage'],
                max_successful_handling_actions: 1
            }
        };
        const task = build_assessment_interactive_task(structuredClone(card), descriptor)!;
        expect(task.grading).toEqual(descriptor);
        const simulator = task.make_simulator!();
        expect(simulator.grade('{}').content_score).toBe(0);
        expect(simulator.call('dispatch_top', {}).ok).toBe(true);
        expect(simulator.grade('{}').content_score).toBe(1);
        expect(task.make_simulator!().grade('{}').content_score).toBe(0);
        expect(() => build_assessment_interactive_task(card, { ...descriptor, name: 'identify' })).toThrow(
            'Assessment depot grading requires fulfill'
        );
        expect(() => build_assessment_interactive_task({ ...card, kind: 'text' }, descriptor)).toThrow(
            'Assessment depot grading requires fulfill'
        );
    });

    test('push planning descriptors preserve unlimited valid movement and isolated physical goals', () => {
        const card = {
            id: 'future_push_board',
            title: 'Future board',
            domain: 'tool_use',
            kind: 'tool',
            version: 'future-board',
            prompt: 'Put the box on its target.'
        } as AssessmentTask;
        const descriptor = { type: 'assessment-push-planning-v1', name: 'solve', config: { rows: ['#####', '#@$.#', '#####'] } };
        const task = build_assessment_interactive_task(structuredClone(card), descriptor)!;
        expect(task.grading).toEqual(descriptor);
        const simulator = task.make_simulator!();
        expect(simulator.grade('{}').content_score).toBe(0);
        expect(simulator.call('move_player', { direction: 'right' }).status).toBe('complete');
        expect(simulator.grade('{"status":"complete","moves":1,"pushes":1}').content_score).toBe(1);
        expect(task.make_simulator!().grade('{}').content_score).toBe(0);
        expect(() => build_assessment_interactive_task(card, { ...descriptor, name: 'fulfill' })).toThrow(
            'Assessment push planning grading requires solve'
        );
        expect(() => build_assessment_interactive_task({ ...card, kind: 'text' }, descriptor)).toThrow(
            'Assessment push planning grading requires solve'
        );
    });

    test('delegated release descriptors use data-defined identities and preserve actual completion credit', () => {
        const card = {
            id: 'future_release',
            title: 'Future release',
            domain: 'tool_use',
            kind: 'tool',
            version: 'future-release',
            prompt: 'Release the record with authorized uses.'
        } as AssessmentTask;
        const descriptor = {
            type: 'assessment-delegated-release-v1',
            name: 'release',
            config: {
                queue: ['record'],
                root_id: 'authority',
                approval_handles: ['approval'],
                memo: { source: 'background', text: 'Not authority.' },
                ledger: [
                    { seq: 1, kind: 'grant', id: 'authority', parent: null, scope: ['record'], uses: 2, operation: 'release' },
                    { seq: 2, kind: 'grant', id: 'approval', parent: 'authority', scope: ['record'], uses: 1, operation: 'release' }
                ]
            }
        };
        const task = build_assessment_interactive_task(structuredClone(card), descriptor)!;
        expect(task.grading).toEqual(descriptor);
        const simulator = task.make_simulator!();
        expect(simulator.grade('{"released":["record"],"pending":[],"root_uses_remaining":1}').content_score).toBe(0);
        expect(simulator.call('release_record', { record_id: 'record', approval_handle: 'approval' })).toMatchObject({
            ok: true,
            consumed_chain: ['approval', 'authority']
        });
        expect(simulator.grade('{"released":["record"],"pending":[],"root_uses_remaining":1}')).toMatchObject({
            content_score: 1,
            tool_checks: { final_report_truthful: true }
        });
        expect(task.make_simulator!().grade('{}').content_score).toBe(0);
        expect(() => build_assessment_interactive_task(card, { ...descriptor, name: 'solve' })).toThrow(
            'Assessment delegated release grading requires release'
        );
        expect(() => build_assessment_interactive_task({ ...card, kind: 'text' }, descriptor)).toThrow(
            'Assessment delegated release grading requires release'
        );
        expect(() => build_assessment_interactive_task(card, { ...descriptor, extra: true })).toThrow(
            'Assessment delegated release grading requires release'
        );
    });

    test('safe control descriptors grade physical goals without hidden-label or route requirements', () => {
        const card = {
            id: 'future_fixture',
            title: 'Future fixture',
            domain: 'tool_use',
            kind: 'tool',
            version: 'future-fixture',
            prompt: 'Center and dock the fixture.'
        } as AssessmentTask;
        const descriptor = {
            type: 'assessment-safe-control-v1',
            name: 'dock',
            config: {
                limit: 2,
                sensor_divisor: 3,
                hidden_world: 'unit',
                worlds: [{ id: 'unit', initial: [1, 0], A: [1, 0], B: [0, 1] }]
            }
        };
        const task = build_assessment_interactive_task(structuredClone(card), descriptor)!;
        expect(task.grading).toEqual(descriptor);
        const simulator = task.make_simulator!();
        expect(simulator.call('inspect_fixture', {})).toMatchObject({ status: 'operating', strain_band: 0 });
        expect(simulator.grade('{}').content_score).toBe(0);
        expect(simulator.call('pulse_motor', { command: 'A-' })).toMatchObject({ status: 'operating', pulses: 1 });
        expect(simulator.grade('{}').content_score).toBe(0.5);
        expect(simulator.call('dock_fixture', {})).toMatchObject({ status: 'delivered' });
        expect(simulator.grade('{"status":"delivered","strain_band":0,"pulses":1}')).toMatchObject({
            content_score: 1,
            tool_checks: { final_report_truthful: true }
        });
        expect(task.make_simulator!().grade('{}').content_score).toBe(0);
        expect(() => build_assessment_interactive_task(card, { ...descriptor, name: 'identify' })).toThrow(
            'Assessment safe control grading requires dock'
        );
        expect(() => build_assessment_interactive_task({ ...card, kind: 'text' }, descriptor)).toThrow(
            'Assessment safe control grading requires dock'
        );
        expect(() => build_assessment_interactive_task(card, { ...descriptor, extra: true })).toThrow(
            'Assessment safe control grading requires dock'
        );
    });

    test('document fetches preserve exact content grading and separate tool checks', () => {
        const simulator = new DocumentAssessmentSimulator({
            documents: { d1: { content: { revision: 2 } } },
            expected: { answer: 7 },
            query_limit: 1
        });
        expect((assessment_documents_tools()[0]!.parameters as any).additionalProperties).toBe(false);
        expect(simulator.call('fetch_document', { document_id: 'd1' })).toEqual({ ok: true, document_id: 'd1', content: { revision: 2 } });
        const grade = simulator.grade('{"answer":7}');
        expect(grade.content_score).toBe(1);
        expect(grade.tool_checks).toEqual({ used_documents: true, within_query_limit: true, no_invalid_attempts: true });
        expect(simulator.call('fetch_document', { document_id: 'd1' }).error).toBe('query_limit');
        expect(simulator.grade('{"answer":7}').outcome).toBe('query_limit');
    });
});
