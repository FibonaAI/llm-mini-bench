import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ASSESSMENT_PROJECT_ROOT } from '../src/assessment_bank.ts';
import { build_assessment_baseline } from '../src/assessment_baselines.ts';
import { parseAssessmentJson } from '../src/assessment_json.ts';

/** Validate complete native run evidence offline; refuse to overwrite differing evidence. */
export function main(argv = process.argv.slice(2)): number {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            'target-id': { type: 'string' },
            'output-dir': { type: 'string', default: join(ASSESSMENT_PROJECT_ROOT, 'baselines') },
            help: { type: 'boolean' }
        }
    });
    if (values.help) {
        console.log(
            'Usage: bun benchmark/tools/import_assessment_baseline.ts RUN --target-id ID [--output-dir DIR]\nImport a complete native Assessment run as a validated per-target baseline. No model calls.'
        );
        return 0;
    }
    if (positionals.length !== 1 || !values['target-id']) throw new Error('Assessment baseline import: RUN and --target-id are required');
    const run = parseAssessmentJson(readFileSync(positionals[0]!, 'utf8'));
    const baseline = build_assessment_baseline(run as Record<string, unknown>, values['target-id']);
    mkdirSync(values['output-dir']!, { recursive: true });
    const path = join(values['output-dir']!, baseline.id + '.json');
    const content = JSON.stringify(baseline, null, 2) + '\n';
    try {
        writeFileSync(path, content, { flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (readFileSync(path, 'utf8') !== content) throw new Error('Assessment baseline destination already contains different evidence');
    }
    console.log(path);
    return 0;
}
if (import.meta.main) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 2;
    }
}
