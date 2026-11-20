import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load_assessment_bank } from '../src/assessment_bank.ts';

// Every browser URL is fulfilled locally; no service, gateway or paid model is contacted.
const root = fileURLToPath(new URL('../', import.meta.url));
const web = process.env.MINI_BENCH_WEB_DIR || join(root, 'web');
const artifacts = mkdtempSync(join(tmpdir(), 'assessment-web-'));
const staticFiles = {};
function loadStatic(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) {
            if (entry.name === 'icons') loadStatic(join(directory, entry.name), name + '/');
        } else if (/\.(html|css|js|svg)$/.test(name) && !name.endsWith('.test.js'))
            staticFiles[name] = readFileSync(join(directory, entry.name), 'utf8');
    }
}
loadStatic(web);
const loadedBank = load_assessment_bank();
const bank = {
    ...loadedBank,
    tasks: loadedBank.tasks.map(task => Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function')))
};
assert.equal(bank.tasks.length, 12);
// The acceptance is one sequential browser session split into named steps under tests/browser/.
// Steps share state in order (later steps rely on earlier ones), so they are concatenated into one
// script; a failure reports its step name and saves a failure screenshot for that step.
const stepsDirectory = join(root, 'tests', 'browser');
const steps = readdirSync(stepsDirectory)
    .filter(name => /^\d{2}-[a-z0-9-]+\.js$/.test(name))
    .sort();
assert.ok(steps.length > 1 && steps[0] === '00-fixture.js', 'Browser acceptance steps are missing');
const body = steps
    .map(name => `step = ${JSON.stringify(name.slice(3, -3))};\n${readFileSync(join(stepsDirectory, name), 'utf8')}`)
    .join('\n');
const script = `async page => {
const ARTIFACTS = ${JSON.stringify(artifacts)}, STATIC_FILES = ${JSON.stringify(staticFiles)}, BANK = ${JSON.stringify(bank)};
let step = '';
try {
${body}
} catch (error) {
  await page.screenshot({ path: ARTIFACTS + '/failure-' + step + '.png', fullPage: true }).catch(() => {});
  throw new Error('[browser step ' + step + '] ' + ((error && error.message) || error));
}
}`;
const scriptPath = join(artifacts, 'browser-check.js');
writeFileSync(scriptPath, script);
const session = `assessment-test-${Date.now()}`;
try {
    execFileSync('playwright-cli', [`-s=${session}`, 'open', 'about:blank'], { cwd: artifacts, encoding: 'utf8' });
    const result = execFileSync('playwright-cli', ['--raw', `-s=${session}`, 'run-code', `--filename=${scriptPath}`], {
        cwd: artifacts,
        encoding: 'utf8',
        timeout: 90000
    });
    writeFileSync(join(artifacts, 'result.txt'), result);
    console.log(result.slice(0, 5000));
    assert.match(result, /"passed":\s*true/, 'Browser acceptance did not report success');
} finally {
    execFileSync('playwright-cli', [`-s=${session}`, 'close'], { cwd: artifacts, encoding: 'utf8' });
    console.log(`Browser evidence: ${artifacts}`);
}
