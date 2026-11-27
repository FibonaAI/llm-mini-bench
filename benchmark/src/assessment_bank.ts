import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build_assessment_data_task } from './assessment_data.ts';
import { ASSESSMENT_INTERACTIVE_SOURCE_PATHS, build_assessment_interactive_task } from './assessment_interactive.ts';
import { ASSESSMENT_INTERACTIVE_V2_SOURCE_PATHS, build_assessment_interactive_v2_task } from './assessment_interactive_v2.ts';
import type { AssessmentTask } from './assessment_tasks.ts';
import { assessment_hash } from './assessment_json.ts';
import { parseStrictJson } from './bench_execution_storage.ts';

/** Bank paths always resolve against the benchmark root, never the working directory. */
export const ASSESSMENT_PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Bank manifests and question files live together in this directory. */
export const ASSESSMENT_BANK_DIRECTORY = join(ASSESSMENT_PROJECT_ROOT, 'banks');
/** Shared grading, simulator and strict JSON sources pinned by every bank manifest. */
export const ASSESSMENT_BANK_SOURCE_PATHS = ['src/assessment_tasks.ts', 'src/assessment_json.ts', 'src/assessment_data.ts'] as const;
/** Full simulator closure when a bank uses v2 interactive graders built atop v1 state machines. */
export const ASSESSMENT_INTERACTIVE_V2_CLOSURE_PATHS = [
    ...ASSESSMENT_INTERACTIVE_SOURCE_PATHS,
    ...ASSESSMENT_INTERACTIVE_V2_SOURCE_PATHS
] as const;
type BankObject = Record<string, unknown>;
/** Serializable task fields retain their identifiers when runtime functions are removed. */
export interface AssessmentTaskSnapshot extends BankObject {
    id: string;
    title: string;
    prompt: string;
    domain: string;
    kind: string;
}
/** Validated bank metadata plus independently cloned runnable task cards. */
export interface AssessmentBank extends BankObject {
    version: string;
    title: string;
    task_ids: string[];
    task_sha256: string;
    source_sha256: Record<string, string>;
    extension_sha256?: Record<string, string>;
    task_file: string;
    grading: Record<string, Record<string, unknown>>;
    selection: Record<string, { reason: string; role: string; [key: string]: unknown }>;
    scoring_policy: Record<string, unknown>;
    tasks: AssessmentTask[];
}
const object = (value: unknown): value is BankObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const keysMatch = (value: BankObject, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function requireBank(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new Error('Assessment bank ' + reason);
}

/** Remove runtime functions while retaining every serializable task field. */
export function assessment_task_snapshot(task: BankObject): AssessmentTaskSnapshot {
    return structuredClone(
        Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function'))
    ) as AssessmentTaskSnapshot;
}

/** Validate source bytes and ordered task snapshots; importing this module never starts a runner. */
export function load_assessment_bank(version: string = '1.0', manifest_path?: string): AssessmentBank {
    requireBank(typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version), 'version must be a nonempty path-safe string');
    const manifest = parseStrictJson(readFileSync(manifest_path ?? join(ASSESSMENT_BANK_DIRECTORY, `assessment-${version}.json`), 'utf8'));
    const required = [
        'version',
        'title',
        'task_ids',
        'task_sha256',
        'source_sha256',
        'task_file',
        'grading',
        'selection',
        'scoring_policy'
    ];
    requireBank(object(manifest) && required.every(key => Object.hasOwn(manifest, key)), 'manifest is missing required fields');
    const bank = manifest as AssessmentBank;
    requireBank(bank.version === version, 'manifest version does not match the requested version');
    requireBank(
        object(bank.source_sha256) && keysMatch(bank.source_sha256, ASSESSMENT_BANK_SOURCE_PATHS),
        'source_sha256 must contain exactly the shared grading and strict JSON source paths'
    );
    for (const path of ASSESSMENT_BANK_SOURCE_PATHS) {
        const actual = createHash('sha256')
            .update(readFileSync(join(ASSESSMENT_PROJECT_ROOT, path)))
            .digest('hex');
        requireBank(
            typeof bank.source_sha256[path] === 'string' &&
                /^[0-9a-f]{64}$/.test(bank.source_sha256[path]) &&
                bank.source_sha256[path] === actual,
            'source hash mismatch: ' + path
        );
    }
    const usesV2Interactive =
        object(bank.grading) &&
        Object.values(bank.grading).some(entry => object(entry) && typeof entry.type === 'string' && entry.type.endsWith('-v2'));
    const expectedExtensionPaths = usesV2Interactive ? ASSESSMENT_INTERACTIVE_V2_CLOSURE_PATHS : ASSESSMENT_INTERACTIVE_SOURCE_PATHS;
    if (bank.extension_sha256 !== undefined) {
        requireBank(
            object(bank.extension_sha256) && keysMatch(bank.extension_sha256, expectedExtensionPaths),
            'extension_sha256 must contain exactly the optional interactive source paths'
        );
        for (const path of expectedExtensionPaths) {
            const actual = createHash('sha256')
                .update(readFileSync(join(ASSESSMENT_PROJECT_ROOT, path)))
                .digest('hex');
            requireBank(
                typeof bank.extension_sha256[path] === 'string' &&
                    /^[0-9a-f]{64}$/.test(bank.extension_sha256[path]) &&
                    bank.extension_sha256[path] === actual,
                'extension source hash mismatch: ' + path
            );
        }
    }
    requireBank(nonempty(bank.title), 'title must be a nonempty string');
    const ids = bank.task_ids;
    requireBank(
        Array.isArray(ids) && ids.length > 0 && ids.every(nonempty) && new Set(ids).size === ids.length,
        'task_ids must be a nonempty array of unique IDs'
    );
    requireBank(
        typeof bank.task_file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(bank.task_file),
        'task_file must be a JSON filename beside the manifest'
    );
    requireBank(object(bank.grading) && keysMatch(bank.grading, ids), 'grading must cover exactly the selected task IDs');
    const manifestDirectory = dirname(manifest_path ?? join(ASSESSMENT_BANK_DIRECTORY, `assessment-${version}.json`));
    const cards = parseStrictJson(readFileSync(join(manifestDirectory, bank.task_file), 'utf8'));
    requireBank(Array.isArray(cards), 'task_file must contain an array');
    const catalogTasks = cards.map(card => {
        requireBank(
            object(card) && nonempty(card.id) && Object.hasOwn(bank.grading, card.id),
            'task_file contains an unknown or malformed task ID'
        );
        const interactive =
            build_assessment_interactive_task(card as AssessmentTask, bank.grading[card.id]) ??
            build_assessment_interactive_v2_task(card as AssessmentTask, bank.grading[card.id]);
        if (interactive) {
            requireBank(object(bank.extension_sha256), 'interactive tasks require extension source hashes');
            return interactive;
        }
        return build_assessment_data_task(card, bank.grading[card.id]);
    });
    const catalog = new Map(catalogTasks.map(task => [task.id, task]));
    requireBank(catalog.size === catalogTasks.length, 'task catalog has duplicate IDs');
    requireBank(
        ids.every((id: string) => catalog.has(id)),
        'contains unknown task IDs'
    );
    requireBank(object(bank.selection) && keysMatch(bank.selection, ids), 'selection must cover exactly the selected task IDs');
    requireBank(
        Object.values(bank.selection).every(entry => object(entry) && ['reason', 'role'].every(key => nonempty(entry[key]))),
        'selection entries require nonempty reason and role strings'
    );
    requireBank(
        object(bank.scoring_policy) && Object.keys(bank.scoring_policy).length,
        'scoring_policy must be a nonempty descriptive object'
    );
    const tasks = ids.map((id: string) => {
        const task = catalog.get(id)!;
        requireBank(!('thinking' in task) && !('effort' in task), 'task must not prescribe thinking or effort: ' + id);
        requireBank(
            typeof task.grade === 'function' && (task.kind !== 'tool' || typeof task.make_simulator === 'function'),
            'task is not runnable: ' + id
        );
        return {
            ...assessment_task_snapshot(task),
            ...Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value === 'function'))
        };
    });
    requireBank(
        typeof bank.task_sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(bank.task_sha256) &&
            bank.task_sha256 === assessment_hash(tasks.map(assessment_task_snapshot)),
        'task snapshot hash mismatch'
    );
    return { ...structuredClone(bank), tasks } as AssessmentBank;
}
