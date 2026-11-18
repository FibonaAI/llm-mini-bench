import {
    createReadStream,
    createWriteStream,
    existsSync,
    fsyncSync,
    openSync,
    closeSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    chmodSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGzip, createGunzip } from 'node:zlib';
import { COMPRESSED_JOURNAL_FILE, JOURNAL_FILE } from '../src/bench_call_summaries.ts';
import { TERMINAL_RUN_STATUSES } from '../src/bench_execution.ts';
import { save_execution_json } from '../src/bench_execution_storage.ts';

/** Sidecar recording the exact original bytes, so archiving is verifiably lossless and reversible. */
export const JOURNAL_ARCHIVE_MANIFEST = 'journal.archive.json';
type Manifest = {
    method: 'gzip';
    original_bytes: number;
    original_sha256: string;
    compressed_bytes: number;
    compressed_sha256: string;
    created_at: string;
};

const HELP = `Usage: bun benchmark/tools/compress_journals.ts [--data-dir DIR] [--dry-run] [--decompress]
Losslessly gzip the journals of terminal runs (main and retry generations) in a personal workspace.
Each archive is decompressed and compared by SHA-256 with the original before the plain file is removed;
${JOURNAL_ARCHIVE_MANIFEST} records the original size and digest. Runs that are queued, running or
cancelling are skipped. The service reads archived journals transparently. --decompress restores the
exact original bytes and verifies them against the manifest. No model requests are made.
  --data-dir DIR   Workspace root (default MAGPIE_BENCH_DATA_DIR or ~/.local/share/magpie-mini-bench)`;

async function digest(path: string, gunzip = false): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;
    const source = createReadStream(path);
    for await (const chunk of gunzip ? source.pipe(createGunzip()) : source) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
    }
    return { sha256: hash.digest('hex'), bytes };
}
function fsyncPath(path: string): void {
    const fd = openSync(path, 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}
const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Archive one journal directory; idempotent and safe to resume after an interruption. */
export async function compress_journal(directory: string): Promise<'compressed' | 'already' | 'missing'> {
    const plain = join(directory, JOURNAL_FILE),
        archived = join(directory, COMPRESSED_JOURNAL_FILE),
        manifestPath = join(directory, JOURNAL_ARCHIVE_MANIFEST);
    if (!existsSync(plain)) return existsSync(archived) ? 'already' : 'missing';
    const original = await digest(plain);
    if (!existsSync(archived) || !existsSync(manifestPath)) {
        const temporary = join(directory, '.journal-' + randomUUID() + '.gz');
        try {
            await pipeline(createReadStream(plain), createGzip({ level: 6 }), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
            fsyncPath(temporary);
            const restored = await digest(temporary, true);
            if (restored.sha256 !== original.sha256 || restored.bytes !== original.bytes)
                throw new Error('Journal archive verification failed: ' + plain);
            const manifest: Manifest = {
                method: 'gzip',
                original_bytes: original.bytes,
                original_sha256: original.sha256,
                compressed_bytes: statSync(temporary).size,
                compressed_sha256: sha256File(temporary),
                created_at: new Date().toISOString()
            };
            renameSync(temporary, archived);
            save_execution_json(manifestPath, manifest);
        } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
        }
    }
    // Resumed or fresh: never remove the plain file unless the archive reproduces it exactly.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const restored = await digest(archived, true);
    if (manifest.original_sha256 !== original.sha256 || restored.sha256 !== original.sha256)
        throw new Error('Journal archive does not match original: ' + plain);
    unlinkSync(plain);
    return 'compressed';
}

/** Restore the exact original journal bytes from an archive, verified against its manifest. */
export async function decompress_journal(directory: string): Promise<'restored' | 'skipped'> {
    const plain = join(directory, JOURNAL_FILE),
        archived = join(directory, COMPRESSED_JOURNAL_FILE),
        manifestPath = join(directory, JOURNAL_ARCHIVE_MANIFEST);
    if (!existsSync(archived)) return 'skipped';
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (!existsSync(plain)) {
        const temporary = join(directory, '.journal-' + randomUUID() + '.jsonl');
        try {
            await pipeline(createReadStream(archived), createGunzip(), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
            fsyncPath(temporary);
            if ((await digest(temporary)).sha256 !== manifest.original_sha256)
                throw new Error('Restored journal does not match manifest: ' + archived);
            renameSync(temporary, plain);
        } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
        }
    } else if ((await digest(plain)).sha256 !== manifest.original_sha256)
        throw new Error('Existing plain journal differs from manifest: ' + plain);
    chmodSync(plain, 0o600);
    unlinkSync(archived);
    unlinkSync(manifestPath);
    return 'restored';
}

/** Journal directories (run root plus retry generations) of runs whose status is terminal. */
export function terminal_journal_directories(root: string): { directories: string[]; skipped: string[] } {
    const directories: string[] = [],
        skipped: string[] = [];
    for (const name of readdirSync(root).sort()) {
        const runPath = join(root, name, 'run.json');
        if (!/^[0-9a-f]{32}$/.test(name) || !existsSync(runPath)) continue;
        const status = (JSON.parse(readFileSync(runPath, 'utf8')) as { status?: string }).status;
        if (!TERMINAL_RUN_STATUSES.has(String(status))) {
            skipped.push(name);
            continue;
        }
        directories.push(
            join(root, name),
            ...readdirSync(join(root, name))
                .filter(entry => /^retry-[0-9a-f]{32}$/.test(entry))
                .sort()
                .map(entry => join(root, name, entry))
        );
    }
    return { directories, skipped };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            'data-dir': { type: 'string' },
            'dry-run': { type: 'boolean' },
            decompress: { type: 'boolean' },
            help: { type: 'boolean' }
        }
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const root = resolve(
        values['data-dir'] ?? process.env.MAGPIE_BENCH_DATA_DIR ?? join(homedir(), '.local/share/magpie-mini-bench'),
        'assessment'
    );
    const { directories, skipped } = terminal_journal_directories(root);
    let before = 0,
        after = 0,
        changed = 0;
    for (const directory of directories) {
        const plain = join(directory, JOURNAL_FILE);
        if (values['dry-run']) {
            if (!values.decompress && existsSync(plain)) {
                before += statSync(plain).size;
                changed++;
            }
            continue;
        }
        if (values.decompress) {
            if ((await decompress_journal(directory)) === 'restored') changed++;
            continue;
        }
        const size = existsSync(plain) ? statSync(plain).size : 0;
        if ((await compress_journal(directory)) === 'compressed') {
            changed++;
            before += size;
            after += statSync(join(directory, COMPRESSED_JOURNAL_FILE)).size;
        }
    }
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1) + ' MB';
    if (values['dry-run']) console.log(`Would compress ${changed} journals (${mb(before)}); skipped ${skipped.length} active runs.`);
    else if (values.decompress) console.log(`Restored ${changed} journals.`);
    else console.log(`Compressed ${changed} journals: ${mb(before)} -> ${mb(after)}; skipped ${skipped.length} active runs.`);
    return 0;
}
if (import.meta.main)
    main().then(
        code => {
            process.exitCode = code;
        },
        error => {
            console.error((error as Error).message);
            process.exitCode = 2;
        }
    );
