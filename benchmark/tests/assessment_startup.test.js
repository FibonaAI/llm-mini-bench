import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/startup.js', import.meta.url), 'utf8');
function startupHarness() {
    const handlers = new Map();
    const notice = { hidden: true, textContent: '', classList: { add() {} } };
    const window = {
        addEventListener(type, handler) {
            handlers.set(type, handler);
        }
    };
    runInNewContext(source, {
        window,
        URL,
        document: {
            getElementById() {
                return notice;
            }
        }
    });
    return { handlers, notice, window };
}

test('startup resource failures identify the file without exposing URL credentials', () => {
    const { handlers, notice } = startupHarness();
    handlers.get('error')({ target: { src: 'http://localhost/bench.js?token=secret-token#secret-fragment' } });
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('bench.js');
    expect(notice.textContent).not.toContain('secret');
});

test('startup exceptions and rejected promises never render arbitrary error details', () => {
    const { handlers, notice, window } = startupHarness();
    handlers.get('error')({
        target: window,
        error: { name: 'TypeError', message: 'secret-token' },
        filename: 'http://localhost/analysis.js?token=secret-token',
        lineno: 42
    });
    expect(notice.textContent).toContain('TypeError · analysis.js:42');
    expect(notice.textContent).not.toContain('secret-token');
    handlers.get('unhandledrejection')({ reason: 'secret-token' });
    expect(notice.textContent).toContain('异步操作未完成');
    expect(notice.textContent).not.toContain('secret-token');
});
