import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/api.js', import.meta.url), 'utf8');

function applyHostTheme(tokens, theme = 'light') {
    const properties = new Map();
    const root = {
        dataset: {},
        style: {
            setProperty(name, value) {
                properties.set(name, value);
            }
        }
    };
    const element = { hidden: false, classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {} };
    const document = {
        documentElement: root,
        getElementById() {
            return { ...element };
        },
        querySelector() {
            return element;
        },
        querySelectorAll() {
            return [];
        }
    };
    runInNewContext(source, {
        document,
        URLSearchParams,
        location: { hash: '#analysis', search: '?' + new URLSearchParams({ theme, magpie: JSON.stringify(tokens) }), pathname: '/' },
        sessionStorage: {
            getItem() {
                return 'offline-test-token';
            }
        },
        window: { addEventListener() {}, dispatchEvent() {} },
        CustomEvent: class {}
    });
    return { properties, root };
}

test('Magpie host control, selection and custom font tokens override fallback tokens', () => {
    const tokens = {
        'ctl-fg': '#61616a',
        'seg-track': '#e0e0e6',
        'seg-thumb': '#fff',
        'seg-edge': 'none',
        sel: '#ededff',
        shadow: 'none',
        'ui-font': 'system-ui',
        'ui-weight': '500',
        'ui-style': 'normal',
        'ui-stretch': '100%'
    };
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

test('status palette CSS uses C1 semantic tokens and shape-coded markers consistently across bench and chart styles', () => {
    const benchCss = readFileSync(new URL('../web/bench.css', import.meta.url), 'utf8');
    const chartCss = readFileSync(new URL('../web/score-cost-chart.css', import.meta.url), 'utf8');
    const chartJs = readFileSync(new URL('../web/score-cost-chart.js', import.meta.url), 'utf8');

    for (const token of [
        '--status-running:',
        '--status-cancelling:',
        '--status-queued:',
        '--status-completed:',
        '--status-timeout:',
        '--status-interrupted:',
        '--status-interrupted-bar:',
        '--status-failed:',
        '--status-cancelled:',
        '--status-cancelled-bar:',
        '--status-baseline:',
        '--pause-mark:',
        '--clock-mark:',
        '--sample-full-bg:',
        '--sample-partial-bg:',
        '--sample-zero-bg:',
        '--sample-zero-border:'
    ]) {
        expect(benchCss).toContain(token);
    }
    expect(benchCss).not.toContain('var(--c6');
    expect(benchCss).toContain(":root[data-theme='dark']");
    expect(benchCss).toContain('.task-dot.is-timeout');
    expect(benchCss).toContain('mask-image: var(--clock-mark)');
    expect(benchCss).toContain('.task-dot.is-interrupted');
    expect(benchCss).toContain('mask-image: var(--pause-mark)');
    expect(benchCss).toContain('.task-dot.is-failed');
    expect(benchCss).toContain('mask-image: var(--x-mark)');
    expect(benchCss).toContain('.task-preview-chip-track');
    expect(benchCss).toContain('.channel-pod-status.is-running');
    expect(benchCss).toContain('.channel-pod-status.is-cancelling');
    expect(benchCss).not.toContain('.task-channel-badge.is-completed');
    expect(benchCss).not.toContain('.task-channel-badge.is-interrupted');
    expect(benchCss).not.toContain('.channel-pod.is-running > .channel-pod-head');

    expect(chartCss).not.toContain('--ok');
    expect(chartCss).not.toContain('--bad');
    expect(chartCss).toContain('var(--status-baseline');
    expect(chartJs).toContain("node('i', 'task-baseline-sq')");
});
