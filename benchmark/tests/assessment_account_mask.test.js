import { describe, expect, test } from 'bun:test';
import { ACCOUNT_MASK_STORAGE_KEY, createAccountMasker, isSystemAccountText, maskBullets, maskStandIn } from '../web/account-mask.js';
import { createAppContext } from '../web/app-context.js';

function createDomHarness() {
    const observerRecords = [];
    let observerCallback = null;
    let observing = false;

    const matchesSimpleSelector = (node, selector) => {
        const trimmed = selector.trim();
        if (!trimmed || node?.nodeType !== 1) return false;
        if (trimmed.includes(' > ')) {
            const idx = trimmed.lastIndexOf(' > ');
            const parentSel = trimmed.slice(0, idx);
            const childSel = trimmed.slice(idx + 3);
            return (
                matchesSimpleSelector(node, childSel) && Boolean(node.parentElement && matchesSimpleSelector(node.parentElement, parentSel))
            );
        }
        if (trimmed.includes(' ')) {
            const idx = trimmed.lastIndexOf(' ');
            const ancSel = trimmed.slice(0, idx);
            const descSel = trimmed.slice(idx + 1);
            if (!matchesSimpleSelector(node, descSel)) return false;
            for (let p = node.parentElement; p; p = p.parentElement) {
                if (matchesSimpleSelector(p, ancSel)) return true;
            }
            return false;
        }
        let rest = trimmed;
        for (const neg of rest.matchAll(/:not\(([^)]+)\)/g)) {
            if (matchesSimpleSelector(node, neg[1])) return false;
        }
        rest = rest.replace(/:not\([^)]+\)/g, '');
        for (const attr of rest.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
            const name = attr[1];
            const expected = attr[2];
            const actual = node.getAttribute(name);
            if (actual === null) return false;
            if (expected !== undefined && actual !== expected) return false;
        }
        rest = rest.replace(/\[[^\]]+\]/g, '');
        for (const cls of rest.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
            if (!node.classes.has(cls[1])) return false;
        }
        rest = rest.replace(/\.[A-Za-z0-9_-]+/g, '');
        for (const id of rest.matchAll(/#([A-Za-z0-9_-]+)/g)) {
            if (node.getAttribute('id') !== id[1]) return false;
        }
        rest = rest.replace(/#[A-Za-z0-9_-]+/g, '').trim();
        if (rest && node.tagName !== rest.toUpperCase()) return false;
        return true;
    };

    const matchesSelectorList = (node, selectorList) =>
        String(selectorList)
            .split(',')
            .some(part => matchesSimpleSelector(node, part));

    class MockText {
        constructor(data) {
            this.nodeType = 3;
            this.data = String(data ?? '');
            this.parentElement = null;
        }
        get textContent() {
            return this.data;
        }
        set textContent(value) {
            this.data = String(value ?? '');
            if (observing) observerRecords.push({ type: 'characterData', target: this });
        }
        get isConnected() {
            return Boolean(this.parentElement?.isConnected);
        }
        replaceWith(...nodes) {
            if (!this.parentElement) return;
            this.parentElement._replaceChild(this, nodes);
        }
    }

    class MockElement {
        constructor(tagName, namespaceURI = 'http://www.w3.org/1999/xhtml') {
            this.nodeType = 1;
            this.tagName = tagName.toUpperCase();
            this.namespaceURI = namespaceURI;
            this.parentElement = null;
            this.childNodes = [];
            this.attributes = new Map();
            this.classes = new Set();
            this.listeners = new Map();
            this.connectedRoot = false;
            const self = this;
            this.dataset = new Proxy(
                {},
                {
                    get(_, prop) {
                        if (typeof prop !== 'string') return undefined;
                        const attr = 'data-' + prop.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
                        return self.attributes.has(attr) ? self.attributes.get(attr) : undefined;
                    },
                    set(_, prop, value) {
                        if (typeof prop !== 'string') return true;
                        const attr = 'data-' + prop.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
                        self.setAttribute(attr, String(value));
                        return true;
                    },
                    has(_, prop) {
                        if (typeof prop !== 'string') return false;
                        const attr = 'data-' + prop.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
                        return self.attributes.has(attr);
                    },
                    deleteProperty(_, prop) {
                        if (typeof prop !== 'string') return true;
                        const attr = 'data-' + prop.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
                        self.removeAttribute(attr);
                        return true;
                    }
                }
            );
            this.classList = {
                add: (...names) => names.forEach(n => this.classes.add(n)),
                remove: (...names) => names.forEach(n => this.classes.delete(n)),
                contains: name => this.classes.has(name),
                toggle: (name, force) => {
                    const on = force === undefined ? !this.classes.has(name) : Boolean(force);
                    on ? this.classes.add(name) : this.classes.delete(name);
                    return on;
                }
            };
        }
        get isConnected() {
            return this.connectedRoot || Boolean(this.parentElement?.isConnected);
        }
        get className() {
            return [...this.classes].join(' ');
        }
        set className(value) {
            this.classes = new Set(
                String(value ?? '')
                    .split(/\s+/)
                    .filter(Boolean)
            );
        }
        get title() {
            return this.getAttribute('title') ?? '';
        }
        set title(value) {
            this.setAttribute('title', String(value ?? ''));
        }
        getAttribute(name) {
            return this.attributes.has(name) ? this.attributes.get(name) : null;
        }
        setAttribute(name, value) {
            const str = String(value);
            if (name === 'class') this.className = str;
            this.attributes.set(name, str);
            if (observing && ['title', 'aria-label', 'data-account'].includes(name)) {
                observerRecords.push({ type: 'attributes', attributeName: name, target: this });
            }
        }
        removeAttribute(name) {
            this.attributes.delete(name);
        }
        get textContent() {
            return this.childNodes.map(child => child.textContent).join('');
        }
        set textContent(value) {
            for (const child of this.childNodes) child.parentElement = null;
            this.childNodes = value === '' ? [] : [new MockText(String(value ?? ''))];
            for (const child of this.childNodes) child.parentElement = this;
            if (observing) observerRecords.push({ type: 'childList', target: this });
        }
        append(...nodes) {
            for (const item of nodes) {
                const node = typeof item === 'string' ? new MockText(item) : item;
                if (node.parentElement) node.parentElement.childNodes = node.parentElement.childNodes.filter(c => c !== node);
                node.parentElement = this;
                this.childNodes.push(node);
            }
            if (observing) observerRecords.push({ type: 'childList', target: this });
        }
        _replaceChild(target, replacements) {
            const idx = this.childNodes.indexOf(target);
            if (idx < 0) return;
            target.parentElement = null;
            const converted = replacements.map(item => {
                const node = typeof item === 'string' ? new MockText(item) : item;
                node.parentElement = this;
                return node;
            });
            this.childNodes.splice(idx, 1, ...converted);
            if (observing) observerRecords.push({ type: 'childList', target: this });
        }
        replaceWith(...nodes) {
            if (!this.parentElement) return;
            this.parentElement._replaceChild(this, nodes);
        }
        normalize() {
            const next = [];
            for (const child of this.childNodes) {
                if (child.nodeType === 1) {
                    child.normalize();
                    next.push(child);
                } else if (child.nodeType === 3) {
                    if (!child.data) {
                        child.parentElement = null;
                        continue;
                    }
                    const prev = next[next.length - 1];
                    if (prev?.nodeType === 3) {
                        prev.data += child.data;
                        child.parentElement = null;
                    } else {
                        next.push(child);
                    }
                }
            }
            this.childNodes = next;
        }
        matches(selector) {
            return matchesSelectorList(this, selector);
        }
        closest(selector) {
            for (let cur = this; cur; cur = cur.parentElement) {
                if (matchesSelectorList(cur, selector)) return cur;
            }
            return null;
        }
        contains(other) {
            for (let cur = other; cur; cur = cur.parentElement) {
                if (cur === this) return true;
            }
            return false;
        }
        querySelectorAll(selector) {
            const found = [];
            const visit = node => {
                for (const child of node.childNodes) {
                    if (child.nodeType === 1) {
                        if (matchesSelectorList(child, selector)) found.push(child);
                        visit(child);
                    }
                }
            };
            visit(this);
            return found;
        }
        querySelector(selector) {
            return this.querySelectorAll(selector)[0] ?? null;
        }
        addEventListener(type, fn) {
            const list = this.listeners.get(type) ?? [];
            list.push(fn);
            this.listeners.set(type, list);
        }
        removeEventListener(type, fn) {
            const list = this.listeners.get(type) ?? [];
            this.listeners.set(
                type,
                list.filter(item => item !== fn)
            );
        }
        click() {
            for (const fn of this.listeners.get('click') ?? []) fn({});
        }
    }

    const doc = {
        body: new MockElement('body'),
        createElement: tag => new MockElement(tag),
        createElementNS: (ns, tag) => new MockElement(tag, ns),
        createTreeWalker: root => {
            const texts = [];
            const collect = node => {
                if (node.nodeType === 3) texts.push(node);
                else if (node.childNodes) for (const child of node.childNodes) collect(child);
            };
            collect(root);
            let index = 0;
            return {
                nextNode: () => (index < texts.length ? texts[index++] : null)
            };
        }
    };
    doc.body.connectedRoot = true;

    class MockMutationObserver {
        constructor(cb) {
            observerCallback = cb;
        }
        observe() {
            observing = true;
        }
        disconnect() {
            observing = false;
        }
    }

    const flushMutations = () => {
        if (!observing || !observerRecords.length || !observerCallback) return;
        const batch = observerRecords.splice(0, observerRecords.length);
        observerCallback(batch);
    };

    const button = doc.createElement('button');
    button.setAttribute('id', 'mask-accounts');
    button.setAttribute('data-no-pii', '');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.append(path);
    const label = doc.createElement('span');
    label.setAttribute('id', 'mask-accounts-label');
    label.textContent = '账号打码';
    button.append(svg, label);
    doc.body.append(button);

    const winTarget = new EventTarget();
    const storageMap = new Map();
    const storage = {
        getItem: key => (storageMap.has(key) ? storageMap.get(key) : null),
        setItem: (key, value) => storageMap.set(key, String(value))
    };

    const app = createAppContext({ available: true, request: async () => ({}) }, winTarget);
    return { doc, button, path, label, winTarget, storage, storageMap, app, MockMutationObserver, flushMutations };
}

describe('Magpie-style account masking', () => {
    test('stand-in and bullet formatters preserve shape and handle CJK/emails deterministically', () => {
        const emailMasked = maskStandIn('alice.researcher@company.com');
        expect(emailMasked).toHaveLength('alice.researcher@company.com'.length);
        expect(emailMasked[5]).toBe('.');
        expect(emailMasked[16]).toBe('@');
        expect(emailMasked[24]).toBe('.');
        expect(emailMasked).not.toContain('alice');
        expect(maskStandIn('alice.researcher@company.com')).toBe(emailMasked);

        const workspaceMasked = maskStandIn('second@example.invalid · workspace-a');
        expect(workspaceMasked).toContain('@');
        expect(workspaceMasked).toContain(' ');
        expect(workspaceMasked).not.toContain('workspace');

        const cjkMasked = maskStandIn('测试账号');
        expect(cjkMasked).toHaveLength(4);
        expect(cjkMasked).not.toContain('测');
        for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
            expect(maskStandIn(ch)).not.toBe(ch.toLowerCase());
        }

        expect(maskBullets('user@example.com')).toBe('••••@•••••••.•••');
        expect(maskBullets('测试账号')).toBe('••••');

        expect(isSystemAccountText('网关自动分配（账号未记录）')).toBe(true);
        expect(isSystemAccountText('自动分配')).toBe(true);
        expect(isSystemAccountText('未记录账号')).toBe(true);
        expect(isSystemAccountText('3 个账号')).toBe(true);
        expect(isSystemAccountText('•••')).toBe(true);
        expect(isSystemAccountText('user@example.com')).toBe(false);
        expect(isSystemAccountText('a')).toBe(false);
    });

    test('masks emails, nicknames, split key badges, and 1-char accounts without false-matching models or providers, then restores cleanly', () => {
        const h = createDomHarness();
        const legendItem = h.doc.createElement('button');
        legendItem.className = 'chart-legend-item';
        legendItem.title = 'GPT-6 Luna · openai · alice@company.invalid（2 个点）';
        legendItem.setAttribute('aria-label', '高亮颜色组 GPT-6 Luna · openai · alice@company.invalid');
        legendItem.textContent = 'GPT-6 Luna · openai · alice@company.invalid';

        const shortLegend = h.doc.createElement('button');
        shortLegend.className = 'chart-legend-item';
        shortLegend.textContent = 'openai / a';

        const tooltipAcc = h.doc.createElement('span');
        tooltipAcc.className = 'score-cost-tooltip-account';
        tooltipAcc.textContent = 'a（固定绑定）';

        const autoTooltipAcc = h.doc.createElement('span');
        autoTooltipAcc.className = 'score-cost-tooltip-account';
        autoTooltipAcc.textContent = '网关自动分配（账号未记录）';

        const pill = h.doc.createElement('button');
        pill.className = 'dp-acc-pill';
        pill.title = 'prod (key000001)（固定绑定）';
        const pillName = h.doc.createElement('span');
        pillName.className = 'dp-acc-pill-name';
        pillName.textContent = 'prod';
        const pillBadge = h.doc.createElement('span');
        pillBadge.className = 'dp-acc-id';
        pillBadge.textContent = 'key000001';
        pill.append(pillName, pillBadge);

        const modelText = h.doc.createElement('p');
        modelText.textContent = 'openai · gpt-4-dev · developer · claude-a · 测试账号';

        const rawPre = h.doc.createElement('pre');
        rawPre.textContent = JSON.stringify({ provider_id: 'openai', model: 'claude-a', account_ref: 'a' }, null, 2);

        h.doc.body.append(legendItem, shortLegend, tooltipAcc, autoTooltipAcc, pill, modelText, rawPre);

        const masker = createAccountMasker({
            root: h.doc.body,
            button: h.button,
            app: h.app,
            storage: h.storage,
            doc: h.doc,
            win: h.winTarget,
            MutationObserverImpl: h.MockMutationObserver
        });

        masker.noteAccounts({
            routes: [
                { provider_id: 'openai', model: 'gpt-6-luna', account_ref: 'gateway-default', account_evidence: 'gateway_binding' },
                {
                    provider_id: 'openai',
                    model: 'gpt-6-luna',
                    account_ref: 'alice@company.invalid',
                    account_evidence: 'gateway_account_binding'
                },
                { provider_id: 'openai', model: 'claude-a', account_ref: 'a', account_evidence: 'gateway_account_binding' },
                { provider_id: 'openai', model: 'gpt-4-dev', account_ref: 'dev', account_evidence: 'configured_binding' },
                { provider_id: 'openai', model: 'gpt-4-dev', account_ref: 'prod (key000001)', account_evidence: 'gateway_account_binding' },
                { provider_id: 'openai', model: 'gpt-4-dev', account_ref: '测试账号', account_evidence: 'gateway_account_binding' },
                { provider_id: 'openai', model: 'gpt-4-dev', account_ref: 'openai', account_evidence: 'configured_binding' }
            ]
        });

        expect(masker.on).toBe(false);
        expect(h.app.maskAccounts).toBe(false);

        h.button.click();
        expect(masker.on).toBe(true);
        expect(h.app.maskAccounts).toBe(true);
        expect(h.storageMap.get(ACCOUNT_MASK_STORAGE_KEY)).toBe('1');
        expect(h.button.getAttribute('aria-pressed')).toBe('true');
        expect(h.label.textContent).toBe('账号已打码');

        // Emails and learned accounts are masked with .pii spans, while provider/model names stay untouched.
        expect(legendItem.textContent).toContain('GPT-6 Luna · openai · ');
        expect(legendItem.textContent).not.toContain('alice');
        expect(legendItem.querySelectorAll('.pii').length).toBe(1);
        expect(legendItem.title).toBe('GPT-6 Luna · openai · •••••@•••••••.•••••••（2 个点）');
        expect(legendItem.getAttribute('aria-label')).toBe('高亮颜色组 GPT-6 Luna · openai · •••••@•••••••.•••••••');

        // 1-char 'a' is masked in delimited legend, tooltip, and JSON account_ref without touching 'claude-a'.
        expect(shortLegend.textContent).not.toBe('openai / a');
        expect(shortLegend.textContent.startsWith('openai / ')).toBe(true);
        expect(tooltipAcc.textContent).toEndWith('（固定绑定）');
        expect(tooltipAcc.textContent).not.toBe('a（固定绑定）');
        expect(autoTooltipAcc.textContent).toBe('网关自动分配（账号未记录）');

        // Split pill primary + badge ID and pill tooltip are masked.
        expect(pillName.textContent).not.toBe('prod');
        expect(pillBadge.textContent).not.toBe('key000001');
        expect(pill.title).toEndWith('（固定绑定）');
        expect(pill.title).not.toContain('prod');

        // Word boundaries prevent 'dev', 'a', or 'openai' from corrupting model/provider names, while '测试账号' is masked.
        expect(modelText.textContent).toContain('openai · gpt-4-dev · developer · claude-a · ');
        expect(modelText.textContent).not.toContain('测试账号');

        // Raw JSON masks "account_ref": "a" while preserving "provider_id": "openai" and "model": "claude-a".
        expect(rawPre.textContent).toContain('"provider_id": "openai"');
        expect(rawPre.textContent).toContain('"model": "claude-a"');
        expect(rawPre.textContent).not.toContain('"account_ref": "a"');

        // Unmasking restores exact original DOM text and attributes.
        h.button.click();
        expect(masker.on).toBe(false);
        expect(h.app.maskAccounts).toBe(false);
        expect(h.label.textContent).toBe('账号打码');
        expect(h.doc.body.querySelectorAll('.pii, .pii-run')).toHaveLength(0);
        expect(legendItem.textContent).toBe('GPT-6 Luna · openai · alice@company.invalid');
        expect(legendItem.title).toBe('GPT-6 Luna · openai · alice@company.invalid（2 个点）');
        expect(legendItem.getAttribute('aria-label')).toBe('高亮颜色组 GPT-6 Luna · openai · alice@company.invalid');
        expect(shortLegend.textContent).toBe('openai / a');
        expect(tooltipAcc.textContent).toBe('a（固定绑定）');
        expect(pillName.textContent).toBe('prod');
        expect(pillBadge.textContent).toBe('key000001');
        expect(pill.title).toBe('prod (key000001)（固定绑定）');
        expect(modelText.textContent).toBe('openai · gpt-4-dev · developer · claude-a · 测试账号');
        expect(JSON.parse(rawPre.textContent)).toEqual({ provider_id: 'openai', model: 'claude-a', account_ref: 'a' });
        masker.destroy();
    });

    test('MutationObserver masks dynamically inserted nodes and updated tooltips without restoring stale titles', () => {
        const h = createDomHarness();
        const masker = createAccountMasker({
            root: h.doc.body,
            button: h.button,
            app: h.app,
            storage: h.storage,
            doc: h.doc,
            win: h.winTarget,
            MutationObserverImpl: h.MockMutationObserver
        });
        masker.set(true);

        const targetMeta = h.doc.createElement('div');
        targetMeta.className = 'selected-target-info';
        const span = h.doc.createElement('span');
        span.title = 'OpenAI / first@example.invalid · high';
        span.textContent = 'OpenAI / first@example.invalid · high';
        targetMeta.append(span);
        h.doc.body.append(targetMeta);
        h.flushMutations();

        expect(span.textContent).not.toContain('first@example.invalid');
        expect(span.title).toBe('OpenAI / •••••@•••••••.••••••• · high');

        // App updates title while masked: new title is masked and unmask restores the NEW title, not the stale one.
        span.title = 'OpenAI / second@example.invalid · low';
        span.textContent = 'OpenAI / second@example.invalid · low';
        h.flushMutations();
        expect(span.textContent).not.toContain('second@example.invalid');
        expect(span.title).toBe('OpenAI / ••••••@•••••••.••••••• · low');

        masker.set(false);
        expect(span.textContent).toBe('OpenAI / second@example.invalid · low');
        expect(span.title).toBe('OpenAI / second@example.invalid · low');
        masker.destroy();
    });

    test('degrades cleanly in sandboxed opaque-origin frames where localStorage throws SecurityError', () => {
        const h = createDomHarness();
        const deniedStorage = {
            getItem() {
                const err = new Error('The operation is insecure.');
                err.name = 'SecurityError';
                throw err;
            },
            setItem() {
                const err = new Error('The operation is insecure.');
                err.name = 'SecurityError';
                throw err;
            }
        };
        const masker = createAccountMasker({
            root: h.doc.body,
            button: h.button,
            app: h.app,
            storage: deniedStorage,
            doc: h.doc,
            win: h.winTarget,
            MutationObserverImpl: h.MockMutationObserver
        });
        expect(masker.on).toBe(false);
        expect(() => h.button.click()).not.toThrow();
        expect(masker.on).toBe(true);
        expect(() => h.button.click()).not.toThrow();
        expect(masker.on).toBe(false);
        masker.destroy();
    });

    test('masks 1-char ASCII and digit account refs across legend titles, Tier 2 chips, preview stats, history options, and unverified evidence without masking token ratios', () => {
        const h = createDomHarness();
        const legendRow = h.doc.createElement('button');
        legendRow.className = 'chart-legend-row';
        legendRow.title = 'GPT-6 Luna · OpenAI · 0 / OpenAI / 0，1 个数据点';
        legendRow.setAttribute('aria-label', 'GPT-6 Luna · OpenAI · 0 / OpenAI / 0，1 个数据点，定位此颜色组');

        const chipList = h.doc.createElement('div');
        chipList.className = 'dp-acc-chip-list';
        const chip = h.doc.createElement('button');
        chip.className = 'dp-acc-chip';
        chip.textContent = '0 ×';
        chipList.append(chip);

        const previewStats = h.doc.createElement('span');
        previewStats.className = 'task-preview-stats';
        previewStats.textContent = '0 · 12/12 样本 · 完成 1/1';

        const historyOption = h.doc.createElement('label');
        historyOption.className = 'analysis-history-option';
        const historyOuter = h.doc.createElement('span');
        const historyMeta = h.doc.createElement('span');
        historyMeta.textContent = '2026/11/19 12:00 · OpenAI / 0';
        historyOuter.append(historyMeta);
        historyOption.append(historyOuter);

        const unverifiedMeta = h.doc.createElement('small');
        unverifiedMeta.textContent = 'openai · 0 · unverified';

        const tokenDd = h.doc.createElement('dd');
        tokenDd.textContent = '1,234 / 0';

        h.doc.body.append(legendRow, chipList, previewStats, historyOption, unverifiedMeta, tokenDd);

        const masker = createAccountMasker({
            root: h.doc.body,
            button: h.button,
            app: h.app,
            storage: h.storage,
            doc: h.doc,
            win: h.winTarget,
            MutationObserverImpl: h.MockMutationObserver
        });
        masker.noteAccounts([{ provider_id: 'openai', model: 'gpt-6-luna', account_ref: '0', account_evidence: 'unverified' }]);
        masker.set(true);

        expect(legendRow.title).toBe('GPT-6 Luna · OpenAI · • / OpenAI / •，1 个数据点');
        expect(legendRow.getAttribute('aria-label')).toBe('GPT-6 Luna · OpenAI · • / OpenAI / •，1 个数据点，定位此颜色组');
        expect(chip.textContent).not.toContain('0');
        expect(chip.textContent.endsWith(' ×')).toBe(true);
        expect(previewStats.textContent).not.toContain('0 · ');
        expect(previewStats.textContent).toContain('12/12 样本');
        expect(historyMeta.textContent.endsWith('/ 0')).toBe(false);
        expect(unverifiedMeta.textContent).not.toContain('· 0 ·');
        expect(tokenDd.textContent).toBe('1,234 / 0');

        masker.set(false);
        expect(legendRow.title).toBe('GPT-6 Luna · OpenAI · 0 / OpenAI / 0，1 个数据点');
        expect(chip.textContent).toBe('0 ×');
        expect(previewStats.textContent).toBe('0 · 12/12 样本 · 完成 1/1');
        expect(historyMeta.textContent).toBe('2026/11/19 12:00 · OpenAI / 0');
        expect(unverifiedMeta.textContent).toBe('openai · 0 · unverified');
        expect(tokenDd.textContent).toBe('1,234 / 0');
        masker.destroy();
    });
});
