import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SUBMIT_ANSWER_PROTOCOL, task_answer_protocol, task_answer_schema } from '../src/assessment_answer_protocol.ts';
import {
    ASSESSMENT_BANK_SOURCE_PATHS,
    ASSESSMENT_PROJECT_ROOT,
    assessment_task_snapshot,
    load_assessment_bank
} from '../src/assessment_bank.ts';
import { ASSESSMENT_INTERACTIVE_SOURCE_PATHS } from '../src/assessment_interactive.ts';
import { assessment_hash } from '../src/assessment_json.ts';

const ids = ['E23_Tight_Conditional_Audit', 'K23_HTTP_Conditional_Cache_Precedence'];
const directories: string[] = [];
afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(version = '1.0') {
    const production = load_assessment_bank('1.0');
    const rawQuestions = JSON.parse(readFileSync(join(ASSESSMENT_PROJECT_ROOT, 'banks/assessment-1.0.questions.json'), 'utf8')) as Record<
        string,
        any
    >[];
    const cards: Record<string, any>[] = ids.map(id => structuredClone(rawQuestions.find(task => task.id === id)!));
    const grading = Object.fromEntries(ids.map(id => [id, structuredClone(production.grading[id]!)]));
    const snapshotCards = ids.map(id => assessment_task_snapshot(production.tasks.find(task => task.id === id)!));
    const manifest: Record<string, any> = {
        version,
        title: 'Synthetic assessment bank',
        task_ids: [...ids],
        task_sha256: assessment_hash(snapshotCards),
        source_sha256: Object.fromEntries(
            ASSESSMENT_BANK_SOURCE_PATHS.map(path => [
                path,
                createHash('sha256')
                    .update(readFileSync(join(ASSESSMENT_PROJECT_ROOT, path)))
                    .digest('hex')
            ])
        ),
        extension_sha256: Object.fromEntries(
            ASSESSMENT_INTERACTIVE_SOURCE_PATHS.map(path => [
                path,
                createHash('sha256')
                    .update(readFileSync(join(ASSESSMENT_PROJECT_ROOT, path)))
                    .digest('hex')
            ])
        ),
        task_file: 'questions.json',
        grading,
        selection: Object.fromEntries(ids.map(id => [id, { reason: 'Synthetic coverage test', role: 'test-only' }])),
        scoring_policy: { content: 'per-task fields', instruction: 'separate', tool: 'separate', aggregate: 'none' }
    };
    return { manifest, cards };
}
function writeManifest(value: any, raw = false, cards: unknown = fixture().cards): string {
    const dir = mkdtempSync(join(tmpdir(), 'assessment-bank-'));
    directories.push(dir);
    const path = join(dir, 'manifest.json');
    if (!raw && typeof value?.task_file === 'string') writeFileSync(join(dir, value.task_file), JSON.stringify(cards));
    writeFileSync(path, raw ? (value as string) : JSON.stringify(value));
    return path;
}

describe('assessment bank manifest', () => {
    test('runnable independent cards preserve selected order and canonical hashes', () => {
        const { manifest, cards } = fixture(),
            path = writeManifest(manifest, false, cards),
            loaded = load_assessment_bank('1.0', path);
        expect(loaded.tasks.map(task => task.id)).toEqual(ids);
        const { tasks: runnable, ...metadata } = loaded;
        expect(metadata as Record<string, any>).toEqual(manifest);
        const tasks = runnable as any[];
        const firstDocId = Object.keys((manifest.grading.E23_Tight_Conditional_Audit as any).config.documents)[0]!;
        expect(tasks[0].make_simulator().call('fetch_document', { document_id: firstDocId }).ok).toBe(true);
        const k23Expected = (manifest.grading.K23_HTTP_Conditional_Cache_Precedence as any).expected;
        expect(tasks[1].grade(JSON.stringify(k23Expected)).content_score).toBe(1);
        expect(loaded.task_sha256).toBe(assessment_hash(tasks.map(assessment_task_snapshot)));
        expect(loaded).not.toHaveProperty('weights');
        expect(loaded).not.toHaveProperty('total_score');
        loaded.selection[ids[0]!].reason = 'mutated';
        loaded.scoring_policy.aggregate = 'mutated';
        tasks[0].prompt = 'mutated';
        tasks[0].tools[0].parameters.additionalProperties = true;
        const second = load_assessment_bank('1.0', path);
        expect(second.selection[ids[0]!].reason).not.toBe('mutated');
        expect(second.scoring_policy.aggregate).toBe('none');
        expect(second.tasks[0]!.prompt).not.toBe('mutated');
        expect((second.tasks[0]!.tools as any[])[0].parameters.additionalProperties).toBe(false);
        expect(second.tasks[0]).not.toBe(tasks[0]);
    });
    test('default release resolves relative to module with balanced 6-domain coverage and 12 tasks', () => {
        const previous = process.cwd();
        const dir = mkdtempSync(join(tmpdir(), 'assessment-cwd-'));
        directories.push(dir);
        try {
            process.chdir(dir);
            const bank = load_assessment_bank();
            expect(bank.version).toBe('1.0');
            expect(bank.status).toBe('released');
            expect(bank.task_ids).toHaveLength(12);
            expect(bank.task_sha256).toBe('d58ddb12bdfbd7af6358f46546159384b83b4e7837aff9e38bab0cc06c23fed8');
            expect(new Set(bank.tasks.map(task => task.domain))).toEqual(
                new Set(['knowledge', 'reasoning', 'code', 'context', 'instruction', 'tool_use'])
            );
            for (const domain of ['knowledge', 'reasoning', 'code', 'context', 'instruction', 'tool_use']) {
                expect(bank.tasks.filter(task => task.domain === domain)).toHaveLength(2);
            }
            expect(bank.tasks.filter(task => task.kind === 'tool')).toHaveLength(3);
            expect(bank.tasks.filter(task => task.kind === 'text')).toHaveLength(9);
            for (const task of bank.tasks) {
                expect(task_answer_protocol(task)).toBe(SUBMIT_ANSWER_PROTOCOL);
                const schema = task_answer_schema(task);
                expect(Array.isArray(schema.required) && schema.required.length > 0).toBe(true);
                expect(Object.keys(schema.properties as object).sort()).toEqual([...(schema.required as string[])].sort());
            }
        } finally {
            process.chdir(previous);
        }
    });
    test('unknown duplicate empty and malformed task IDs rejected', () => {
        for (const task_ids of [['unknown'], [...ids, ids[0]], [], 'K23_HTTP_Conditional_Cache_Precedence', [null], [{}], [' ']]) {
            const { manifest, cards } = fixture();
            manifest.task_ids = task_ids as any;
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow();
        }
    });
    test('task order changes and prompt edits invalidate task hash', () => {
        const reversed = fixture();
        reversed.manifest.task_ids.reverse();
        reversed.manifest.grading = Object.fromEntries(reversed.manifest.task_ids.map((id: string) => [id, reversed.manifest.grading[id]]));
        reversed.manifest.selection = Object.fromEntries(
            reversed.manifest.task_ids.map((id: string) => [id, reversed.manifest.selection[id]])
        );
        expect(() => load_assessment_bank('1.0', writeManifest(reversed.manifest, false, reversed.cards))).toThrow(
            'task snapshot hash mismatch'
        );
        const edited = fixture();
        edited.cards[0].prompt += ' extra';
        expect(() => load_assessment_bank('1.0', writeManifest(edited.manifest, false, edited.cards))).toThrow(
            'task snapshot hash mismatch'
        );
    });
    test('source hash mismatch extra missing and non-object source maps rejected', () => {
        for (const path of ASSESSMENT_BANK_SOURCE_PATHS) {
            for (const bad of ['0'.repeat(64), 'not-a-sha', 123, null]) {
                const { manifest, cards } = fixture();
                manifest.source_sha256[path] = bad;
                expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('source hash mismatch');
            }
        }
        for (const extra of ['src/other.ts']) {
            const { manifest, cards } = fixture();
            manifest.source_sha256[extra] = '0'.repeat(64);
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('shared grading and strict JSON');
        }
        for (const removed of ASSESSMENT_BANK_SOURCE_PATHS) {
            const { manifest, cards } = fixture();
            delete manifest.source_sha256[removed];
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('shared grading and strict JSON');
        }
        for (const source_sha256 of [null, [], {}]) {
            const { manifest, cards } = fixture();
            manifest.source_sha256 = source_sha256;
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('shared grading and strict JSON');
        }
    });
    test('optional interactive sources require complete current hashes', () => {
        const { manifest, cards } = fixture();
        for (const path of ASSESSMENT_INTERACTIVE_SOURCE_PATHS) {
            const corrupted = structuredClone(manifest);
            corrupted.extension_sha256![path] = '0'.repeat(64);
            expect(() => load_assessment_bank('1.0', writeManifest(corrupted, false, cards))).toThrow('extension source hash mismatch');
        }
        const absent = { ...manifest };
        delete absent.extension_sha256;
        expect(() => load_assessment_bank('1.0', writeManifest(absent, false, cards))).toThrow(
            'interactive tasks require extension source hashes'
        );
        for (const card of cards.filter(card => card.kind === 'tool')) {
            const invalid = cards.map(value => (value.id === card.id ? { ...value, prompt: '' } : value));
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, invalid))).toThrow('requires nonempty prompt');
        }
    });
    test('version mismatch, unsafe paths and missing files rejected', () => {
        const { manifest, cards } = fixture(),
            path = writeManifest(manifest, false, cards);
        expect(() => load_assessment_bank('other', path)).toThrow('version does not match');
        for (const version of ['', null, 1, '../1.0', '1.0/extra'])
            expect(() => load_assessment_bank(version as string, path)).toThrow('path-safe');
        expect(() => load_assessment_bank('1.0', path + '.missing')).toThrow();
        expect(() => load_assessment_bank('1.0', writeManifest({ ...manifest, task_file: '../questions.json' }, false, cards))).toThrow(
            'task_file'
        );
    });
    test('selection and grading require exact coverage and valid entries', () => {
        const choices = [
            { [ids[0]!]: { reason: 'r', role: 'anchor' } },
            { ...fixture().manifest.selection, other: { reason: 'r', role: 'anchor' } },
            Object.fromEntries(ids.map(id => [id, { reason: 'r' }])),
            [],
            null,
            Object.fromEntries(ids.map(id => [id, { reason: ' ', role: 'anchor' }])),
            Object.fromEntries(ids.map(id => [id, { reason: 'r', role: 1 }]))
        ];
        for (const selection of choices) {
            const { manifest, cards } = fixture();
            manifest.selection = selection;
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('selection');
        }
        const optional = fixture();
        optional.manifest.selection[ids[0]!].evidence = 'optional metadata';
        expect(load_assessment_bank('1.0', writeManifest(optional.manifest, false, optional.cards)).selection).toEqual(
            optional.manifest.selection
        );
        for (const grading of [{}, [], null, { [ids[0]!]: fixture().manifest.grading[ids[0]!] }]) {
            const { manifest, cards } = fixture();
            manifest.grading = grading;
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('grading');
        }
    });
    test('required fields and title/scoring shapes checked', () => {
        for (const key of [
            'version',
            'title',
            'task_ids',
            'task_sha256',
            'source_sha256',
            'task_file',
            'grading',
            'selection',
            'scoring_policy'
        ]) {
            const { manifest, cards } = fixture();
            delete manifest[key];
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow();
        }
        for (const title of ['', ' ', null, []]) {
            const { manifest, cards } = fixture();
            manifest.title = title;
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('title');
        }
        for (const scoring_policy of ['', null, [], {}]) {
            const { manifest, cards } = fixture();
            manifest.scoring_policy = scoring_policy;
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('scoring_policy');
        }
    });
    test('thinking effort duplicate cards and nonrunnable cards rejected before hashing', () => {
        for (const key of ['thinking', 'effort']) {
            const { manifest, cards } = fixture();
            cards[0][key] = 'high';
            expect(() => load_assessment_bank('1.0', writeManifest(manifest, false, cards))).toThrow('must not prescribe');
        }
        const duplicate = fixture();
        expect(() =>
            load_assessment_bank('1.0', writeManifest(duplicate.manifest, false, [...duplicate.cards, duplicate.cards[0]]))
        ).toThrow('duplicate IDs');
        const nonrunnable = fixture();
        nonrunnable.cards[1].kind = 'tool';
        expect(() => load_assessment_bank('1.0', writeManifest(nonrunnable.manifest, false, nonrunnable.cards))).toThrow(
            'exact-fields grading'
        );
    });
    test('duplicate nonfinite and deeply nested JSON rejected', () => {
        for (const raw of ['{"version":"1.0","version":"2.0"}', '{"version":NaN}', '[]', '['.repeat(110) + '0' + ']'.repeat(110)])
            expect(() => load_assessment_bank('1.0', writeManifest(raw, true))).toThrow();
    });
    test('loader does not import runner or backend', () => {
        expect(readFileSync(join(ASSESSMENT_PROJECT_ROOT, 'src/assessment_bank.ts'), 'utf8')).not.toMatch(
            /from ['"].*(?:calibrate|backend)/
        );
    });
    test('official 2.0 release validates 12 tasks across 6 domains with strict schemas and v2 closure hashes', () => {
        const bank2 = load_assessment_bank('2.0');
        expect(bank2.version).toBe('2.0');
        expect(bank2.status).toBe('released');
        expect(bank2.task_ids).toHaveLength(12);
        expect(bank2.task_sha256).toBe('84feeda2dbeef6cf75ecdb281ff0fcff0e0200f669f13682a735a66ed3a724a3');
        expect(new Set(bank2.tasks.map(task => task.domain))).toEqual(
            new Set(['knowledge', 'reasoning', 'code', 'context', 'instruction', 'tool_use'])
        );
        for (const domain of ['knowledge', 'reasoning', 'code', 'context', 'instruction', 'tool_use']) {
            expect(bank2.tasks.filter(task => task.domain === domain)).toHaveLength(2);
        }
        expect(bank2.tasks.filter(task => task.kind === 'tool')).toHaveLength(3);
        expect(bank2.tasks.filter(task => task.kind === 'text')).toHaveLength(9);
        expect(Object.keys(bank2.extension_sha256 ?? {})).toHaveLength(8);
        const allowedSchemaKeys = new Set([
            'type',
            'properties',
            'required',
            'additionalProperties',
            'items',
            'enum',
            'description',
            'anyOf',
            'oneOf'
        ]);
        const assertStrictSchemaNode = (node: Record<string, any>) => {
            for (const key of Object.keys(node)) expect(allowedSchemaKeys.has(key)).toBe(true);
            if (node.type === 'object') {
                const keys = Object.keys(node.properties ?? {});
                expect(keys.length).toBeGreaterThan(0);
                expect(node.additionalProperties).toBe(false);
                expect([...(node.required ?? [])].sort()).toEqual([...keys].sort());
                for (const child of Object.values(node.properties as Record<string, any>)) assertStrictSchemaNode(child);
            } else if (node.type === 'array') {
                expect(typeof node.items).toBe('object');
                assertStrictSchemaNode(node.items);
            } else if (Array.isArray(node.type)) {
                expect(node.type.length).toBeGreaterThan(0);
                for (const t of node.type) expect(['string', 'integer', 'number', 'boolean', 'null']).toContain(t);
            } else {
                expect(['string', 'integer', 'number', 'boolean']).toContain(node.type);
            }
        };
        for (const task of bank2.tasks) {
            expect(task_answer_protocol(task)).toBe(SUBMIT_ANSWER_PROTOCOL);
            const schema = task_answer_schema(task);
            expect((schema.required as string[]).length).toBeGreaterThanOrEqual(1);
            expect((schema.required as string[]).length).toBeLessThanOrEqual(3);
            assertStrictSchemaNode(schema);
        }
        // Corrupting any v2 simulator hash in 2.0 manifest is rejected.
        const raw2 = JSON.parse(readFileSync(join(ASSESSMENT_PROJECT_ROOT, 'banks/assessment-2.0.json'), 'utf8'));
        const cards2 = JSON.parse(readFileSync(join(ASSESSMENT_PROJECT_ROOT, 'banks/assessment-2.0.questions.json'), 'utf8'));
        raw2.extension_sha256['src/assessment_blackbox_v2.ts'] = '0'.repeat(64);
        expect(() => load_assessment_bank('2.0', writeManifest(raw2, false, cards2))).toThrow('extension source hash mismatch');
    });
});

describe('version-independent exact-fields task data', () => {
    test('an arbitrary bank version loads fractions aliases and nested exact answers', () => {
        const card = {
            id: 'GENERIC',
            title: 'Generic exact fields',
            domain: 'reasoning',
            kind: 'text',
            prompt: 'Return JSON.',
            version: 'generic-v1',
            source: [],
            difficulty_intent: 'test',
            measurement: { necessary_operations: [], confounds: '', status: 'test' },
            scoring_rule: 'equal fields'
        };
        const { manifest } = fixture('9.7-experimental');
        delete manifest.extension_sha256;
        manifest.task_ids = ['GENERIC'];
        manifest.grading = {
            GENERIC: {
                type: 'assessment-exact-fields-v1',
                name: 'grade',
                expected: {
                    fraction: { $fraction: '5/12' },
                    alias: { $aliases: ['Good Faith', '善意'] },
                    nested: { values: [1, true, 'x'] }
                }
            }
        };
        manifest.task_sha256 = assessment_hash([{ ...card, grading: manifest.grading.GENERIC }]);
        manifest.selection = { GENERIC: { reason: 'generic test', role: 'test' } };
        const bank = load_assessment_bank('9.7-experimental', writeManifest(manifest, false, [card])),
            grade = bank.tasks[0]!.grade;
        expect(grade('{"fraction":"10/24","alias":"good faith","nested":{"values":[1,true,"x"]}}').content_score).toBe(1);
        expect(grade('{"fraction":"0.4166666667","alias":"善意","nested":{"values":[1,true,"x"]}}').content_checks).toEqual({
            fraction: false,
            alias: true,
            nested: true
        });
        expect(grade('{"fraction":"5/12","alias":"unlisted","nested":{"values":[1,false,"x"]}}').content_score).toBe(1 / 3);
    });
    test('invalid descriptors and unknown grading formats are rejected', () => {
        const card = { id: 'GENERIC', title: 'Generic', domain: 'reasoning', kind: 'text', prompt: 'Return JSON.', version: 'generic-v1' };
        for (const grading of [
            { type: 'assessment-exact-fields-v1', name: 'grade' },
            { type: 'assessment-exact-fields-v1', name: 'other', expected: { x: 1 } },
            { type: 'assessment-exact-fields-v1', name: 'grade', expected: {} },
            { type: 'assessment-exact-fields-v1', name: 'grade', expected: { x: { $fraction: '1/0' } } },
            { type: 'assessment-exact-fields-v1', name: 'grade', expected: { x: { $aliases: [] } } },
            { type: 'unknown', name: 'grade' }
        ]) {
            const { manifest } = fixture('generic');
            delete manifest.extension_sha256;
            manifest.task_ids = ['GENERIC'];
            manifest.task_sha256 = assessment_hash([card]);
            manifest.grading = { GENERIC: grading };
            manifest.selection = { GENERIC: { reason: 'generic test', role: 'test' } };
            expect(() => load_assessment_bank('generic', writeManifest(manifest, false, [card]))).toThrow();
        }
    });
});
