import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(root, 'benchmark/web');

describe('single-bank browser contract', () => {
  test('browser requests only the assessment API', () => {
    for (const name of readdirSync(web).filter(name => name.endsWith('.js'))) {
      for (const [, endpoint] of readFileSync(join(web, name), 'utf8').matchAll(/\.\/api\/([^\s'"`]+)/g)) {
        expect(endpoint!.startsWith('bench/')).toBe(true);
      }
    }
  });

  test('markup is read-only with one bank, unique IDs and bounded rounds', async () => {
    const elements: { tag: string; attributes: Map<string, string> }[] = [];
    await new HTMLRewriter().on('*', { element(element) {
      elements.push({ tag: element.tagName, attributes: new Map(element.attributes) });
    } }).transform(new Response(readFileSync(join(web, 'index.html'), 'utf8'))).text();
    const ids = elements.flatMap(element => element.attributes.has('id') ? [element.attributes.get('id')!] : []);
    expect(ids.length).toBe(new Set(ids).size);
    for (const retired of ['question-bank-version', 'bank-version-top', 'run-judge-model', 'question-editor']) expect(ids).not.toContain(retired);
    expect(elements.some(element => element.tag === 'textarea')).toBe(false);
    expect(elements.find(element => element.attributes.get('id') === 'run-rounds')?.attributes.get('max')).toBe('3');
    const bank = elements.find(element => element.attributes.get('id') === 'bench-bank')!.attributes;
    expect([bank.get('type'), bank.get('value')]).toEqual(['hidden', '1.0']);
  });

  test('user-facing markup uses Mini Bench rather than an additional assessment brand', () => {
    const markup = readFileSync(join(web, 'index.html'), 'utf8');
    expect(markup).toContain('LLM Mini Bench');
    expect(markup).toContain('Mini Bench · 14 题');
    expect(markup).not.toContain('Assessment');
    for (const file of ['bench.js', 'analysis.js', 'assessment-chart-metric.js']) {
      const source = readFileSync(join(web, file), 'utf8');
      expect(source).not.toMatch(/['"`][^'"`\n]*Assessment(?: 1\.0)?[ ·基线分析记录题库]/);
    }
  });

  test('configuration descriptions and collapsed analysis rules stay accessible', async () => {
    const descriptions = new Map<string, string>();
    const ids = new Set<string>();
    let searchRegions = 0;
    let methodologyOpen = false;
    await new HTMLRewriter().on('*', { element(element) {
      const id = element.getAttribute('id');
      if (id) ids.add(id);
      const description = element.getAttribute('aria-describedby');
      if (id && description) descriptions.set(id, description);
      if (element.tagName === 'search') searchRegions++;
      if (element.getAttribute('class') === 'analysis-methodology') methodologyOpen = element.hasAttribute('open');
    } }).transform(new Response(readFileSync(join(web, 'index.html'), 'utf8'))).text();
    expect(searchRegions).toBe(1);
    expect(methodologyOpen).toBe(false);
    for (const id of ['sample-concurrency', 'run-concurrency', 'bench-timeout']) {
      expect(descriptions.has(id)).toBe(true);
      expect(ids.has(descriptions.get(id)!)).toBe(true);
    }
  });

  test('browser scripts parse in Bun without requiring Node or a build output', () => {
    const transpiler = new Bun.Transpiler({ loader: 'js' });
    for (const directory of [web, join(root, 'magpie/page')]) {
      for (const name of readdirSync(directory).filter(name => name.endsWith('.js'))) {
        expect(() => transpiler.transformSync(readFileSync(join(directory, name), 'utf8'))).not.toThrow();
      }
    }
  });
});
