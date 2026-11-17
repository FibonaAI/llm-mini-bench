import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/api.js', import.meta.url), 'utf8');

function applyHostTheme(tokens, theme = 'light') {
  const properties = new Map();
  const root = { dataset: {}, style: { setProperty(name, value) { properties.set(name, value); } } };
  const element = { hidden: false, classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {} };
  const document = { documentElement: root, getElementById() { return { ...element }; }, querySelector() { return element; }, querySelectorAll() { return []; } };
  runInNewContext(source, {
    document, URLSearchParams,
    location: { hash: '#analysis', search: '?' + new URLSearchParams({ theme, magpie: JSON.stringify(tokens) }), pathname: '/' },
    sessionStorage: { getItem() { return 'offline-test-token'; } },
    window: { addEventListener() {}, dispatchEvent() {} },
    CustomEvent: class {},
  });
  return { properties, root };
}

test('Magpie host control, selection and custom font tokens override fallback tokens', () => {
  const tokens = { 'ctl-fg': '#61616a', 'seg-track': '#e0e0e6', 'seg-thumb': '#fff', 'seg-edge': 'none', sel: '#ededff', shadow: 'none', 'ui-font': 'system-ui', 'ui-weight': '500', 'ui-style': 'normal', 'ui-stretch': '100%' };
  const { properties, root } = applyHostTheme(tokens, 'dark');
  expect(root.dataset.theme).toBe('dark');
  for (const [name, value] of Object.entries(tokens)) expect(properties.get('--' + name)).toBe(value);
});

test('unknown host properties stay namespaced and malformed theme data uses fallback', () => {
  const { properties } = applyHostTheme({ 'arbitrary-layout': 'none', 'invalid name': 'red', accent: 42 });
  expect(properties.get('--magpie-arbitrary-layout')).toBe('none');
  expect(properties.has('--arbitrary-layout')).toBe(false);
  expect(properties.has('--magpie-invalid name')).toBe(false);
  expect(properties.has('--accent')).toBe(false);
  expect(() => applyHostTheme(null)).not.toThrow();
});
