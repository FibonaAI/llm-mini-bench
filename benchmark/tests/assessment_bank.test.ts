import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ASSESSMENT_TASKS } from '../src/assessment_tasks.ts';
import { ASSESSMENT_BANK_SOURCE_PATHS, ASSESSMENT_PROJECT_ROOT, assessment_task_snapshot, load_assessment_bank } from '../src/assessment_bank.ts';
import { ASSESSMENT_INTERACTIVE_SOURCE_PATHS } from '../src/assessment_interactive.ts';
import { assessment_hash } from '../src/assessment_json.ts';

const ids = ['T03_Booking_Feedback', 'K04_Genetic_Code'];
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(version = '1.0') {
    const cards: Record<string, any>[] = ids.map(id => assessment_task_snapshot(ASSESSMENT_TASKS.find(task => task.id === id)!));
    const manifest: Record<string, any> = { version, title: 'Synthetic assessment bank', task_ids: [...ids], task_sha256: assessment_hash(cards),
        source_sha256: Object.fromEntries(ASSESSMENT_BANK_SOURCE_PATHS.map(path => [path, createHash('sha256').update(readFileSync(join(ASSESSMENT_PROJECT_ROOT, path))).digest('hex')])),
        task_file: 'questions.json', grading: Object.fromEntries(ids.map(id => [id, { type: 'assessment-named-v1', name: id }])),
        selection: Object.fromEntries(ids.map(id => [id, { reason: 'Synthetic coverage test', role: 'test-only' }])),
        scoring_policy: { content: 'per-task fields', instruction: 'separate', tool: 'separate', aggregate: 'none' } };
    return { manifest, cards };
}
function writeManifest(value: any, raw = false, cards: unknown = fixture().cards): string {
    const dir = mkdtempSync(join(tmpdir(), 'assessment-bank-')); directories.push(dir);
    const path = join(dir, 'manifest.json');
    if (!raw && typeof value?.task_file === 'string') writeFileSync(join(dir, value.task_file), JSON.stringify(cards));
    writeFileSync(path, raw ? value as string : JSON.stringify(value)); return path;
}

describe('assessment bank manifest', () => {
    test('runnable independent cards preserve selected order and canonical hashes', () => {
        const { manifest, cards } = fixture(), path = writeManifest(manifest, false, cards), loaded = load_assessment_bank('1.0', path);
        expect(loaded.tasks.map(task => task.id)).toEqual(ids);
        const { tasks: runnable, ...metadata } = loaded; expect(metadata as Record<string, any>).toEqual(manifest);
        const tasks = runnable as any[];
        expect(tasks[0].make_simulator().call('list_rooms', {}).ok).toBe(true);
        expect(tasks[1].grade('{"AUA":"M","CUA":"T","UGA":"W"}').content_score).toBe(1);
        expect(loaded.task_sha256).toBe(assessment_hash(tasks.map(assessment_task_snapshot)));
        expect(loaded).not.toHaveProperty('weights'); expect(loaded).not.toHaveProperty('total_score');
        loaded.selection[ids[0]!].reason = 'mutated'; loaded.scoring_policy.aggregate = 'mutated'; tasks[0].prompt = 'mutated'; tasks[0].tools[0].parameters.additionalProperties = true;
        const second = load_assessment_bank('1.0', path);
        expect(second.selection[ids[0]!].reason).not.toBe('mutated'); expect(second.scoring_policy.aggregate).toBe('none');
        expect(second.tasks[0]!.prompt).not.toBe('mutated'); expect((second.tasks[0]!.tools as any[])[0].parameters.additionalProperties).toBe(false);
        expect(second.tasks[0]).not.toBe(ASSESSMENT_TASKS.find(task => task.id === ids[0]));
    });
    test('default release resolves relative to module and contains exactly 14 tasks', () => {
        const previous = process.cwd(); const dir = mkdtempSync(join(tmpdir(), 'assessment-cwd-')); directories.push(dir);
        try { process.chdir(dir); expect(load_assessment_bank().task_ids).toHaveLength(14); } finally { process.chdir(previous); }
    });
    test('unknown duplicate empty and malformed task IDs rejected', () => {
        for (const task_ids of [['unknown'], [...ids, ids[0]], [], 'K04_Genetic_Code', [null], [{}], [' ']]) {
            const { manifest, cards } = fixture(); manifest.task_ids = task_ids as any;
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow();
        }
    });
    test('snapshot hashes reject tampering reordering and question drift', () => {
        const { manifest, cards } = fixture(); manifest.task_sha256 = '0'.repeat(64); expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('snapshot hash mismatch');
        const reordered = fixture(); reordered.manifest.task_ids.reverse(); expect(() => load_assessment_bank('1.0', writeManifest(reordered.manifest, false, reordered.cards))).toThrow();
        const drifted = fixture(), path = writeManifest(drifted.manifest, false, drifted.cards), questionPath = join(dirname(path), drifted.manifest.task_file);
        const questions = JSON.parse(readFileSync(questionPath, 'utf8')); questions[0].prompt += ' Drift.'; writeFileSync(questionPath, JSON.stringify(questions));
        expect(() => load_assessment_bank('1.0', path)).toThrow('snapshot hash mismatch');
    });
    test('source hashes pin exactly the shared graders and strict JSON parser', () => {
        expect(ASSESSMENT_BANK_SOURCE_PATHS).toEqual(['src/assessment_tasks.ts', 'src/assessment_tools.ts', 'src/assessment_knowledge.ts', 'src/assessment_challenges.ts', 'src/assessment_json.ts', 'src/assessment_data.ts', 'src/assessment_resource.ts', 'src/assessment_dfa.ts']);
        for (const path of ASSESSMENT_BANK_SOURCE_PATHS) for (const value of ['0'.repeat(64), null]) {
            const { manifest, cards } = fixture(); manifest.source_sha256[path] = value; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('source hash mismatch');
        }
        for (const extra of ['src/client.ts', '../outside.ts', '/tmp/arbitrary.ts', 'calibrate_assessment.ts', 'src/assessment_bank.ts']) {
            const { manifest, cards } = fixture(); manifest.source_sha256[extra] = '0'.repeat(64); expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('shared grading and strict JSON');
        }
        for (const removed of ASSESSMENT_BANK_SOURCE_PATHS) { const { manifest, cards } = fixture(); delete manifest.source_sha256[removed]; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('shared grading and strict JSON'); }
        for (const source_sha256 of [null, [], {}]) { const { manifest, cards } = fixture(); manifest.source_sha256 = source_sha256; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('shared grading and strict JSON'); }
    });
    test('optional interactive sources require complete current hashes', () => {
        const bank = load_assessment_bank('2.1');
        const { tasks, ...metadata } = bank;
        const cards = tasks.map(assessment_task_snapshot);
        const manifest = { ...metadata, task_file: 'questions.json' };
        for (const path of ASSESSMENT_INTERACTIVE_SOURCE_PATHS) {
            const corrupted = structuredClone(manifest);
            corrupted.extension_sha256![path] = '0'.repeat(64);
            expect(() => load_assessment_bank('2.1', writeManifest(corrupted, false, cards))).toThrow('extension source hash mismatch');
        }
        const absent = { ...manifest }; delete absent.extension_sha256;
        expect(() => load_assessment_bank('2.1', writeManifest(absent, false, cards))).toThrow('interactive tasks require extension source hashes');
        for (const card of cards.filter(card => card.kind === 'tool')) {
            const invalid = cards.map(value => value.id === card.id ? { ...value, prompt: '' } : value);
            expect(() => load_assessment_bank('2.1', writeManifest(manifest, false, invalid))).toThrow('requires nonempty prompt');
        }
    });
    test('version mismatch, unsafe paths and missing files rejected', () => {
        const { manifest, cards } = fixture(), path = writeManifest(manifest, false, cards); expect(() => load_assessment_bank('2.0', path)).toThrow('version does not match');
        for (const version of ['', null, 1, '../1.0', '1.0/extra']) expect(() => load_assessment_bank(version as string, path)).toThrow('path-safe');
        expect(() => load_assessment_bank('1.0', path + '.missing')).toThrow();
        expect(() => load_assessment_bank('1.0', writeManifest({ ...manifest, task_file: '../questions.json' }, false, cards))).toThrow('task_file');
    });
    test('selection and grading require exact coverage and valid entries', () => {
        const choices = [{ [ids[0]!]: { reason: 'r', role: 'anchor' } }, { ...fixture().manifest.selection, other: { reason: 'r', role: 'anchor' } },
            Object.fromEntries(ids.map(id => [id, { reason: 'r' }])), [], null,
            Object.fromEntries(ids.map(id => [id, { reason: ' ', role: 'anchor' }])), Object.fromEntries(ids.map(id => [id, { reason: 'r', role: 1 }]))];
        for (const selection of choices) { const { manifest, cards } = fixture(); manifest.selection = selection; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('selection'); }
        const optional = fixture(); optional.manifest.selection[ids[0]!].evidence = 'optional metadata'; expect(load_assessment_bank('1.0', writeManifest(optional.manifest, false, optional.cards)).selection).toEqual(optional.manifest.selection);
        for (const grading of [{}, [], null, { [ids[0]!]: { type: 'assessment-named-v1', name: ids[0] } }]) { const { manifest, cards } = fixture(); manifest.grading = grading; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('grading'); }
    });
    test('required fields and title/scoring shapes checked', () => {
        for (const key of Object.keys(fixture().manifest)) { const { manifest, cards } = fixture(); delete manifest[key]; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow(); }
        for (const title of ['', ' ', null, []]) { const { manifest, cards } = fixture(); manifest.title = title; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('title'); }
        for (const scoring_policy of ['', null, [], {}]) { const { manifest, cards } = fixture(); manifest.scoring_policy = scoring_policy; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('scoring_policy'); }
    });
    test('thinking effort duplicate cards and nonrunnable cards rejected before hashing', () => {
        for (const key of ['thinking', 'effort']) { const { manifest, cards } = fixture(); cards[0][key] = 'high'; expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('must not prescribe'); }
        const duplicate = fixture(); expect(() => load_assessment_bank('1.0', writeManifest(duplicate.manifest, false, [...duplicate.cards, duplicate.cards[0]]))).toThrow('duplicate IDs');
        const nonrunnable = fixture(); nonrunnable.cards[1].kind = 'tool'; nonrunnable.manifest.task_sha256 = assessment_hash(nonrunnable.cards);
        expect(() => load_assessment_bank('1.0', writeManifest(nonrunnable.manifest, false, nonrunnable.cards))).toThrow('not runnable');
    });
    test('duplicate nonfinite and deeply nested JSON rejected', () => {
        for (const raw of ['{"version":"1.0","version":"2.0"}', '{"version":NaN}', '[]', '['.repeat(110) + '0' + ']'.repeat(110)]) expect(() => load_assessment_bank('1.0', writeManifest(raw, true))).toThrow();
    });
    test('loader does not import runner or backend', () => {
        expect(readFileSync(join(ASSESSMENT_PROJECT_ROOT, 'src/assessment_bank.ts'), 'utf8')).not.toMatch(/from ['"].*(?:calibrate|backend)/);
    });
});

describe('version-independent exact-fields task data', () => {
    test('an arbitrary bank version loads fractions aliases and nested exact answers', () => {
        const card = { id: 'GENERIC', title: 'Generic exact fields', domain: 'reasoning', kind: 'text', prompt: 'Return JSON.', version: 'generic-v1',
            source: [], difficulty_intent: 'test', measurement: { necessary_operations: [], confounds: '', status: 'test' }, scoring_rule: 'equal fields' };
        const { manifest } = fixture('9.7-experimental');
        manifest.task_ids = ['GENERIC']; manifest.grading = { GENERIC: { type: 'assessment-exact-fields-v1', name: 'grade', expected: {
            fraction: { $fraction: '5/12' }, alias: { $aliases: ['Good Faith', '善意'] }, nested: { values: [1, true, 'x'] } } } };
        manifest.task_sha256 = assessment_hash([{ ...card, grading: manifest.grading.GENERIC }]);
        manifest.selection = { GENERIC: { reason: 'generic test', role: 'test' } };
        const bank = load_assessment_bank('9.7-experimental', writeManifest(manifest, false, [card])), grade = bank.tasks[0]!.grade;
        expect(grade('{"fraction":"10/24","alias":"good faith","nested":{"values":[1,true,"x"]}}').content_score).toBe(1);
        expect(grade('{"fraction":"0.4166666667","alias":"善意","nested":{"values":[1,true,"x"]}}').content_checks).toEqual({ fraction: false, alias: true, nested: true });
        expect(grade('{"fraction":"5/12","alias":"unlisted","nested":{"values":[1,false,"x"]}}').content_score).toBe(1 / 3);
    });
    test('invalid descriptors and unknown named graders are rejected', () => {
        const card = { id: 'GENERIC', title: 'Generic', domain: 'reasoning', kind: 'text', prompt: 'Return JSON.', version: 'generic-v1' };
        for (const grading of [{ type: 'assessment-exact-fields-v1', name: 'grade' }, { type: 'assessment-exact-fields-v1', name: 'other', expected: { x: 1 } },
            { type: 'assessment-exact-fields-v1', name: 'grade', expected: {} }, { type: 'assessment-exact-fields-v1', name: 'grade', expected: { x: { $fraction: '1/0' } } },
            { type: 'assessment-exact-fields-v1', name: 'grade', expected: { x: { $aliases: [] } } }, { type: 'assessment-named-v1', name: 'UNKNOWN' }, { type: 'unknown', name: 'grade' }]) {
            const { manifest } = fixture('generic'); manifest.task_ids = ['GENERIC']; manifest.task_sha256 = assessment_hash([card]); manifest.grading = { GENERIC: grading };
            manifest.selection = { GENERIC: { reason: 'generic test', role: 'test' } };
            expect(() => load_assessment_bank('generic', writeManifest(manifest, false, [card]))).toThrow();
        }
    });
});
