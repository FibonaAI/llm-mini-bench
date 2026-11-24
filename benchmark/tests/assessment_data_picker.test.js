import { expect, test } from 'bun:test';
import { createAppContext } from '../web/app-context.js';
import { createDataPicker, selectionKey } from '../web/data-picker.js';
import { createTaskTargets } from '../web/runs.js';

class TestElement {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.attributes = {};
        this.events = {};
        this.value = '';
        this.className = '';
        this.scrollTop = 0;
    }
    append(...nodes) {
        this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
        this.children = nodes;
    }
    setAttribute(key, value) {
        this.attributes[key] = value;
    }
    addEventListener(type, callback) {
        this.events[type] = callback;
    }
    removeEventListener(type) {
        delete this.events[type];
    }
    getBoundingClientRect() {
        return { left: 20, top: 30, bottom: 62, height: 0 };
    }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector) {
        return this.children
            .flatMap(node => [node, ...(node.querySelectorAll?.('*') ?? [])])
            .filter(
                node =>
                    selector === '*' ||
                    (selector === '[data-focus-id]'
                        ? node.dataset?.focusId
                        : node.className?.split(/\s+/).filter(Boolean).includes(selector.slice(1)))
            );
    }
    contains(target) {
        return target === this || this.querySelectorAll('*').includes(target);
    }
    focus() {
        document.activeElement = this;
    }
    remove() {
        this.removed = true;
    }
}

function fixture(options = {}) {
    globalThis.document = Object.assign(new TestElement('document'), {
        body: new TestElement('body'),
        createElement: tag => new TestElement(tag),
        createTextNode: text => ({ textContent: text })
    });
    globalThis.window = Object.assign(new TestElement('window'), { innerWidth: 900, innerHeight: 700 });
    const container = new TestElement('div');
    const records = [
        { provider: 'OpenAI', account: 'A', model: 'GPT-6-Luna', think: 'high' },
        { provider: 'OpenAI', account: 'A', model: 'GPT-6-Luna', think: 'low' },
        { provider: 'DeepSeek', account: 'B', model: 'GPT-6-Luna', think: 'high' }
    ];
    const changes = [];
    const picker = createDataPicker(container, { records, onChange: keys => changes.push(keys), ...options });
    const nodes = () => document.body.querySelectorAll('*');
    const findAll = className => nodes().filter(node => node.className?.split(/\s+/).filter(Boolean).includes(className));
    const find = className => findAll(className)[0];
    const selectChannel = providerId => {
        const btn = findAll('dp-rail-item').find(node => node.dataset.providerId === providerId);
        if (!btn) throw new Error(`Missing rail channel: ${providerId}`);
        btn.events.click();
    };
    const filterThinking = value => {
        const node = find('dp-thinking-filter');
        node.value = value;
        node.events.change();
    };
    const search = value => {
        const node = find('dp-search');
        node.value = value;
        node.events.input();
    };
    const levels = () => findAll('dp-think');
    return { picker, records, changes, nodes, container, find, findAll, selectChannel, filterThinking, search, levels };
}

test('key is tuple JSON with provider/account isolation', () => {
    expect(selectionKey({ provider: 'x', account: 'a,b', model: 'c', think: 'high' })).toBe('["x","a,b","c","high"]');
});

test('default all, explicit none, silent constructor and cloned get/set', () => {
    const { picker, changes } = fixture();
    expect(picker.getSelection()).toHaveLength(3);
    picker.getSelection().pop();
    expect(picker.getSelection()).toHaveLength(3);
    const keys = [picker.getSelection()[0]];
    picker.setSelection(keys);
    keys.length = 0;
    expect(picker.getSelection()).toHaveLength(1);
    picker.setSelection(['not-advertised']);
    expect(picker.getSelection()).toEqual([]);
    expect(changes).toEqual([]);
    expect(fixture({ selectedKeys: [] }).picker.getSelection()).toEqual([]);
});

test('one normalized search finds a model across channels and preserves hidden selections', () => {
    const { picker, records, nodes, search, levels, find } = fixture({ selectedKeys: [] });
    expect(nodes().filter(node => node.type === 'search')).toHaveLength(1);
    search('gpt 6 luna');
    expect(levels()).toHaveLength(3);
    levels()[0].events.click();
    search('DeepSeek');
    expect(levels()).toHaveLength(1);
    expect(find('dp-hidden-count').textContent).toBe('1 项在当前筛选之外');
    levels()[0].events.click();
    expect(picker.getSelection()).toEqual([records[0], records[2]].map(selectionKey));
    search('nonexistent');
    expect(find('dp-empty').textContent).toContain('没有匹配结果');
    expect(picker.getSelection()).toHaveLength(2);
});

test('channel switching and thinking filter never select or clear targets', () => {
    const { picker, selectChannel, filterThinking, levels, changes, find } = fixture();
    selectChannel('DeepSeek');
    expect(levels()).toHaveLength(1);
    selectChannel('OpenAI');
    expect(levels()).toHaveLength(2);
    filterThinking('low');
    expect(levels()).toHaveLength(1);
    expect(find('dp-hidden-count').textContent).toBe('2 项在当前筛选之外');
    find('dp-reset-filters').events.click();
    expect(levels()).toHaveLength(2);
    expect(picker.getSelection()).toHaveLength(3);
    expect(changes).toEqual([]);
});

test('orthogonal account x thinking selection switches smoothly from auto to fixed and preserves model ticks', () => {
    const records = [
        {
            providerId: 'provider:openai',
            providerName: 'openai',
            provider: '网关目录归属',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            accountShortName: '网关自动分配',
            model: 'openai/gpt-5.4',
            modelDisplayName: 'GPT-5.4',
            think: 'medium',
            route: { provider_id: 'openai', account_evidence: 'gateway_binding' }
        },
        {
            providerId: 'provider:openai',
            providerName: 'openai',
            provider: '网关目录归属',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            accountShortName: '网关自动分配',
            model: 'openai/gpt-5.4',
            modelDisplayName: 'GPT-5.4',
            think: 'high',
            route: { provider_id: 'openai', account_evidence: 'gateway_binding' }
        },
        ...['acct-a', 'acct-b'].flatMap(acc =>
            ['medium', 'high'].map(think => ({
                providerId: 'provider:openai',
                providerName: 'openai',
                provider: '网关目录归属',
                accountId: `account:${acc}`,
                account: `${acc}（固定绑定）`,
                accountDisplayId: acc,
                model: 'openai/gpt-5.4',
                modelDisplayName: 'GPT-5.4',
                think,
                route: { provider_id: 'openai', account_evidence: 'gateway_account_binding' }
            }))
        )
    ];
    const { picker, levels, findAll } = fixture({ records, selectedKeys: [], mode: 'tasks' });
    // Pick thinking first (defaults to auto account).
    levels()
        .find(b => b.dataset.think === 'medium')
        .events.click();
    levels()
        .find(b => b.dataset.think === 'high')
        .events.click();
    expect(picker.getSelection()).toEqual([records[0], records[1]].map(selectionKey));

    // Clicking a fixed account replaces auto while preserving both thinking ticks.
    findAll('dp-acc-pill')
        .find(b => b.dataset.accountId === 'account:acct-a')
        .events.click();
    expect(picker.getSelection()).toEqual([records[2], records[3]].map(selectionKey));

    // Adding a second fixed account expands to 2 accounts x 2 thinking levels = 4 runs.
    findAll('dp-acc-pill')
        .find(b => b.dataset.accountId === 'account:acct-b')
        .events.click();
    expect(picker.getSelection()).toHaveLength(4);

    // Unchecking all fixed accounts preserves staged drafts without silently falling back to auto.
    findAll('dp-acc-pill')
        .find(b => b.dataset.accountId === 'account:acct-a')
        .events.click();
    findAll('dp-acc-pill')
        .find(b => b.dataset.accountId === 'account:acct-b')
        .events.click();
    expect(picker.getSelection()).toEqual([]);
    expect(findAll('dp-draft-note')).toHaveLength(1);
    expect(levels().every(b => b.dataset.draft === 'true' && b.attributes['aria-pressed'] === 'false')).toBe(true);

    // Re-selecting a fixed account restores the staged model/thinking ticks immediately.
    findAll('dp-acc-pill')
        .find(b => b.dataset.accountId === 'account:acct-b')
        .events.click();
    expect(picker.getSelection()).toEqual([records[4], records[5]].map(selectionKey));
});

test('partial account model support only emits existing leaves and never invents illegal combinations', () => {
    const records = [
        {
            providerId: 'provider:openai',
            providerName: 'openai',
            accountId: 'account:a',
            account: 'a（固定绑定）',
            accountDisplayId: 'a',
            model: 'openai/gpt-5.4',
            modelDisplayName: 'GPT-5.4',
            think: 'high',
            route: { account_evidence: 'gateway_account_binding' }
        },
        {
            providerId: 'provider:openai',
            providerName: 'openai',
            accountId: 'account:a',
            account: 'a（固定绑定）',
            accountDisplayId: 'a',
            model: 'openai/codex',
            modelDisplayName: 'Codex',
            think: 'high',
            route: { account_evidence: 'gateway_account_binding' }
        },
        {
            providerId: 'provider:openai',
            providerName: 'openai',
            accountId: 'account:b',
            account: 'b（固定绑定）',
            accountDisplayId: 'b',
            model: 'openai/gpt-5.4',
            modelDisplayName: 'GPT-5.4',
            think: 'high',
            route: { account_evidence: 'gateway_account_binding' }
        }
    ];
    const { picker, findAll, levels } = fixture({ records, selectedKeys: [], mode: 'tasks' });
    // Activate both accounts a and b.
    findAll('dp-acc-pill')
        .find(b => b.dataset.accountId === 'account:b')
        .events.click();
    // Click Codex high: only account:a supports Codex, so only 1 leaf is added.
    levels()
        .find(b => b.dataset.model === 'openai/codex')
        .events.click();
    expect(picker.getSelection()).toEqual([selectionKey(records[1])]);
    expect(findAll('dp-model-warn')[0].textContent).toContain('1/2');
});

test('non-orthogonal external setSelection stays lossless without Cartesian expansion', () => {
    const records = ['a', 'b'].flatMap(acc =>
        ['m1', 'm2'].map(model => ({
            providerId: 'provider:openai',
            providerName: 'openai',
            accountId: `account:${acc}`,
            account: `${acc}（固定绑定）`,
            accountDisplayId: acc,
            model,
            modelDisplayName: model,
            think: 'high',
            route: { account_evidence: 'gateway_account_binding' }
        }))
    );
    const { picker, findAll } = fixture({ records, selectedKeys: [], mode: 'tasks' });
    // Asymmetric combination: (a, m1) + (b, m2).
    const asymmetric = [selectionKey(records[0]), selectionKey(records[3])];
    picker.setSelection(asymmetric);
    expect(picker.getSelection()).toEqual(asymmetric);
    expect(findAll('dp-custom-bar')).toHaveLength(1);
    // Removing one chip leaves (b, m2), which becomes cleanly orthogonal and exits custom mode.
    findAll('dp-acc-chip')[0].events.click();
    expect(picker.getSelection()).toEqual([selectionKey(records[3])]);
    expect(findAll('dp-custom-bar')).toHaveLength(0);
});

test('channels with more than 8 fixed accounts default collapsed and expand to searchable 2-col grid', () => {
    const records = [
        {
            providerId: 'provider:openai',
            providerName: 'openai',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            accountShortName: '网关自动分配',
            model: 'openai/gpt-5.4',
            modelDisplayName: 'GPT-5.4',
            think: 'high',
            route: { account_evidence: 'gateway_binding' }
        },
        ...Array.from({ length: 12 }, (_, i) => {
            const label = i < 4 ? `team-a-${i + 1}` : `prod-${i + 1}`;
            return {
                providerId: 'provider:openai',
                providerName: 'openai',
                accountId: `account:${label}`,
                account: `${label}（固定绑定）`,
                accountDisplayId: `${label} (id00${i})`,
                model: 'openai/gpt-5.4',
                modelDisplayName: 'GPT-5.4',
                think: 'high',
                route: { account_evidence: 'gateway_account_binding' }
            };
        })
    ];
    const { picker, find, findAll, nodes, levels } = fixture({ records, selectedKeys: [], mode: 'tasks' });
    // Starts collapsed by default.
    const toggle = find('dp-acc-toggle');
    expect(toggle.attributes['aria-expanded']).toBe('false');
    expect(toggle.textContent).toContain('展开 12 个账号');
    expect(findAll('dp-acc-grid')).toHaveLength(0);
    expect(nodes().filter(n => n.type === 'search')).toHaveLength(1);

    // Expand account selector.
    toggle.events.click();
    expect(find('dp-acc-toggle').attributes['aria-expanded']).toBe('true');
    expect(findAll('dp-acc-cell')).toHaveLength(12);
    // Account search uses type="text" so popup still has strictly one type="search" input.
    expect(nodes().filter(n => n.type === 'search')).toHaveLength(1);

    // Filter to team-a and batch-select matched accounts.
    const accSearch = find('dp-acc-search');
    accSearch.value = 'team-a';
    accSearch.events.input();
    expect(findAll('dp-acc-cell')).toHaveLength(4);
    expect(find('dp-acc-batch').textContent).toBe('全选匹配 (4)');
    find('dp-acc-batch').events.click();
    expect(findAll('dp-acc-selected-bar')).toHaveLength(1);
    expect(findAll('dp-acc-chip')).toHaveLength(4);

    // Select model high -> 4 runs across the 4 team-a accounts.
    levels()[0].events.click();
    expect(picker.getSelection()).toHaveLength(4);

    // Collapse keeps summary chips visible.
    find('dp-acc-toggle').events.click();
    expect(find('dp-acc-toggle').attributes['aria-expanded']).toBe('false');
    expect(findAll('dp-acc-collapsed-chips')).toHaveLength(1);
});

test('select search results only affects matched leaves; row check is tri-state', () => {
    const { picker, records, search, levels, nodes, find, filterThinking } = fixture({ selectedKeys: [] });
    levels()[0].events.click();
    expect(nodes().find(node => node.className === 'dp-check').indeterminate).toBe(true);
    filterThinking('high');
    search('DeepSeek');
    find('dp-select-visible').events.click();
    expect(picker.getSelection()).toEqual([records[1], records[2]].map(selectionKey));
    find('dp-reset-filters').events.click();
    expect(picker.getSelection()).toHaveLength(2);
    find('dp-action').events.click();
    expect(picker.getSelection()).toEqual([]);
});

test('finish closes the picker with exact selections intact; no separate selected review step', () => {
    const { picker, records, find, levels, search, nodes } = fixture({ selectedKeys: [] });
    picker.setSelection([selectionKey(records[1])]);
    picker.show();
    search('DeepSeek');
    expect(levels()).toHaveLength(1);
    expect(find('dp-hidden-count').textContent).toContain('1 项在当前筛选之外');
    expect(nodes().some(node => node.className === 'dp-selected-toggle')).toBe(false);
    find('dp-done').events.click();
    expect(document.body.children[0].hidden).toBe(true);
    expect(picker.getSelection()).toEqual([selectionKey(records[1])]);
});

test('popup stays anchored and shrinks to available space', () => {
    const { picker, container } = fixture({ mode: 'tasks' });
    container.children[0].getBoundingClientRect = () => ({ left: 40, top: 20, bottom: 52 });
    picker.show();
    const popup = document.body.children[0];
    expect(popup.dataset.placement).toBe('below');
    expect(popup.style.top).toBe('60px');
    expect(popup.style.width).toBe('860px');
    expect(Number.parseFloat(popup.style.height)).toBeGreaterThanOrEqual(360);
    expect(Number.parseFloat(popup.style.height)).toBeLessThanOrEqual(640);
    window.innerHeight = 420;
    window.events.resize();
    expect(popup.dataset.placement).toBe('below');
    expect(popup.style.height).toBe('344px');
    window.innerHeight = 320;
    window.events.resize();
    expect(popup.dataset.placement).toBe('viewport');
    expect(popup.style.height).toBe('288px');
});

test('compact popup measures wrapped content rather than clipping a tall single row', () => {
    const { picker, container, find } = fixture({
        records: [{ provider: 'Long provider name', account: 'Long account name', model: 'Long model name', think: 'high' }],
        mode: 'tasks'
    });
    window.innerHeight = 900;
    container.children[0].getBoundingClientRect = () => ({ left: 40, top: 280, bottom: 312 });
    picker.show();
    find('dp-result-row').getBoundingClientRect = () => ({ height: 420 });
    window.events.resize();
    const popup = document.body.children[0];
    expect(Number.parseFloat(popup.style.height)).toBeGreaterThanOrEqual(420);
    window.innerHeight = 660;
    window.events.resize();
    expect(popup.dataset.placement).toBe('viewport');
    expect(Number.parseFloat(popup.style.top) + Number.parseFloat(popup.style.height)).toBeLessThanOrEqual(644);
});

test('popup flips near bottom and uses viewport space in short windows', () => {
    const { picker, container } = fixture({ mode: 'tasks' });
    container.children[0].getBoundingClientRect = () => ({ left: 400, top: 608, bottom: 640 });
    picker.show();
    const popup = document.body.children[0];
    expect(popup.dataset.placement).toBe('above');
    expect(Number.parseFloat(popup.style.top)).toBeGreaterThanOrEqual(16);
    expect(popup.style.left).toBe('24px');
    window.innerWidth = 390;
    window.innerHeight = 320;
    container.children[0].getBoundingClientRect = () => ({ left: 24, top: 140, bottom: 172 });
    window.events.resize();
    expect(popup.dataset.placement).toBe('viewport');
    expect(popup.style.top).toBe('16px');
    expect(popup.style.width).toBe('358px');
    expect(popup.style.height).toBe('288px');
});

test('identical labels keep provider and account instances independent', () => {
    const records = ['chatgpt-main', 'chatgpt-lab'].flatMap(providerId =>
        ['main', 'research'].map(accountId => ({
            providerId,
            providerName: 'Same name',
            provider: 'ChatGPT API',
            accountId,
            account: 'Same account',
            model: 'Luna',
            think: 'high'
        }))
    );
    const { picker, selectChannel, findAll, levels, changes } = fixture({ records, selectedKeys: [] });
    expect(findAll('dp-rail-name').map(node => node.textContent)).toEqual(['Same name · chatgpt-main', 'Same name · chatgpt-lab']);
    selectChannel('chatgpt-main');
    // Activate second account 'research' and click thinking 'high'.
    findAll('dp-acc-pill')
        .find(p => p.dataset.accountId === 'research')
        .events.click();
    findAll('dp-acc-pill')
        .find(p => p.dataset.accountId === 'main')
        .events.click();
    levels()[0].events.click();
    selectChannel('chatgpt-lab');
    expect(levels()[0].attributes['aria-pressed']).toBe('false');
    findAll('dp-acc-pill')
        .find(p => p.dataset.accountId === 'research')
        .events.click();
    findAll('dp-acc-pill')
        .find(p => p.dataset.accountId === 'main')
        .events.click();
    levels()[0].events.click();
    expect(picker.getSelection()).toEqual([records[1], records[3]].map(selectionKey));
    expect(changes.length).toBeGreaterThanOrEqual(2);
});

test('explicit efforts display and select their exact protocol value without checkmark prefix', () => {
    const { levels, picker } = fixture({ records: [{ provider: 'A', account: 'B', model: 'Luna', think: 'none' }], selectedKeys: [] });
    expect(levels()[0].textContent).toBe('none');
    expect(levels()[0].dataset.think).toBe('none');
    levels()[0].events.click();
    expect(levels()[0].attributes['aria-pressed']).toBe('true');
    expect(levels()[0].textContent).toBe('none');
    expect(JSON.parse(picker.getSelection()[0])[3]).toBe('none');
});

test('default has a clear display label but keeps the exact protocol value', () => {
    const { levels, picker } = fixture({ records: [{ provider: 'A', account: 'B', model: 'Luna', think: 'default' }], selectedKeys: [] });
    expect(levels()[0].textContent).toBe('默认');
    expect(levels()[0].dataset.think).toBe('default');
    levels()[0].events.click();
    expect(JSON.parse(picker.getSelection()[0])[3]).toBe('default');
});

test('target rows show channel, account and model without quota disclosures', () => {
    const records = [
        {
            providerId: 'provider:office',
            providerName: 'Office supplier',
            provider: 'office',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            model: 'Luna',
            think: 'high',
            route: { provider_id: 'office', account_evidence: 'gateway_binding' }
        }
    ];
    const { picker, changes, nodes, find } = fixture({
        records,
        mode: 'tasks',
        quotaCatalog: {
            status: 'available',
            cards: [{ provider_path: 'office', user: 'quota@example.invalid', windows: [{ name: 'weekly', used: 23 }] }]
        }
    });
    expect(find('dp-rail-name').textContent).toBe('Office supplier');
    expect(find('dp-acc-static-value').textContent).toBe('网关自动分配（实际账号未记录）');
    expect(find('dp-model-name').textContent).toBe('Luna');
    expect(nodes().some(node => node.className?.startsWith('dp-quota'))).toBe(false);
    expect(picker.getSelection()).toEqual(records.map(selectionKey));
    expect(changes).toEqual([]);
});

test('local routing groups follow direct local channels and duplicate model display names show raw model IDs', () => {
    const records = [
        {
            providerId: 'provider:auto',
            providerName: 'auto（自动路由）',
            provider: '网关目录归属',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            model: 'auto/claude-sonnet-5-5',
            modelDisplayName: 'Claude Sonnet 5.5',
            think: 'high',
            route: { provider_id: 'auto', account_evidence: 'gateway_binding' }
        },
        {
            providerId: '["homelab","claude"]',
            providerName: 'homelab / claude',
            providerSubtitle: 'homelab',
            provider: '远端路由目录',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            model: 'homelab/claude/claude-sonnet-5-5',
            modelDisplayName: 'Claude Sonnet 5.5',
            think: 'high',
            route: {
                provider_id: 'homelab',
                account_evidence: 'gateway_binding',
                remote_route: { namespace: 'claude', evidence: 'magpie_via_catalog' }
            }
        },
        {
            providerId: 'provider:claude',
            providerName: 'claude',
            provider: '网关目录归属',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            model: 'claude/claude-sonnet-4-5',
            modelDisplayName: 'Claude Sonnet 4.5',
            think: 'high',
            route: { provider_id: 'claude', account_evidence: 'gateway_binding' }
        },
        {
            providerId: 'provider:claude',
            providerName: 'claude',
            provider: '网关目录归属',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            model: 'claude/claude-sonnet-4-5-20250929',
            modelDisplayName: 'Claude Sonnet 4.5',
            think: 'high',
            route: { provider_id: 'claude', account_evidence: 'gateway_binding' }
        },
        {
            providerId: 'provider:claude',
            providerName: 'claude',
            provider: '网关目录归属',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            model: 'claude/claude-haiku-5-5',
            modelDisplayName: 'Claude Haiku 5.5',
            think: 'high',
            route: { provider_id: 'claude', account_evidence: 'gateway_binding' }
        }
    ];
    const { findAll, search } = fixture({ records, selectedKeys: [], mode: 'tasks' });
    // Rail orders direct local channel before local routing group and remote node.
    expect(findAll('dp-rail-item').map(node => node.dataset.providerId)).toEqual([
        'provider:claude',
        'provider:auto',
        '["homelab","claude"]'
    ]);
    // Inside claude, the two colliding display names show their raw model IDs, while the unique model does not.
    expect(findAll('dp-model-id').map(node => node.textContent)).toEqual(['claude/claude-sonnet-4-5', 'claude/claude-sonnet-4-5-20250929']);
    // Cross-channel search also shows raw model IDs for colliding display names.
    search('Claude Sonnet 4.5');
    expect(findAll('dp-model-id').map(node => node.textContent)).toEqual(['claude/claude-sonnet-4-5', 'claude/claude-sonnet-4-5-20250929']);
});

test('task target controller preserves active channel, staged drafts and search filter during picker interactions', () => {
    globalThis.document = Object.assign(new TestElement('document'), {
        body: new TestElement('body'),
        createElement: tag => new TestElement(tag),
        createTextNode: text => ({ textContent: text })
    });
    globalThis.window = Object.assign(new TestElement('window'), { innerWidth: 900, innerHeight: 700 });
    const domById = new Map();
    const byId = id => {
        if (!domById.has(id)) {
            const el = new TestElement('div');
            if (id === 'run-rounds') el.value = '3';
            domById.set(id, el);
        }
        return domById.get(id);
    };
    const app = createAppContext(
        {
            byId,
            escapeHtml: value => String(value ?? ''),
            finite: Number.isFinite,
            request: async () => ({}),
            notify: () => {},
            available: true,
            activeStatus: () => false,
            statusText: value => value,
            formatDate: value => String(value ?? '')
        },
        new EventTarget()
    );
    app.setBank({ version: '1.0', tasks: Array(12).fill({ id: 't' }) });
    createTaskTargets(app);

    app.setTaskRoutes([
        {
            id: 'r-chatgpt',
            provider_id: 'homelab',
            remote_route: { namespace: 'chatgpt-api', evidence: 'magpie_via_catalog' },
            account_ref: 'gateway-default',
            account_evidence: 'gateway_binding',
            model: 'homelab/chatgpt-api/gpt-5.4',
            model_display_name: 'GPT-5.4',
            thinking_levels: ['low', 'medium', 'high']
        },
        {
            id: 'r-agy-gemini',
            provider_id: 'homelab',
            remote_route: { namespace: 'agy-cli', evidence: 'magpie_via_catalog' },
            account_ref: 'gateway-default',
            account_evidence: 'gateway_binding',
            model: 'homelab/agy-cli/gemini-4-carbon',
            model_display_name: 'Gemini 4 Carbon',
            thinking_levels: ['low', 'medium', 'high', 'ultra']
        },
        {
            id: 'r-local-a',
            provider_id: 'openai',
            account_ref: 'acct-a',
            account_evidence: 'gateway_account_binding',
            model: 'openai/gpt-5.4',
            model_display_name: 'GPT-5.4',
            thinking_levels: ['high']
        }
    ]);

    const popup = () => byId('task-picker').children.at(-1);
    const nodes = () => popup().querySelectorAll('*');
    const findAll = className => nodes().filter(node => node.className?.split(/\s+/).filter(Boolean).includes(className));
    const find = className => findAll(className)[0];
    const activeRailId = () => find('is-active')?.dataset?.providerId;
    const selectChannel = providerId => {
        const btn = findAll('dp-rail-item').find(node => node.dataset.providerId === providerId);
        if (!btn) throw new Error(`Missing channel ${providerId}`);
        btn.events.click();
    };

    // Task target picker is always visible inline without a trigger or done button.
    expect(popup().hidden).toBe(false);
    expect(popup().className).toContain('dp-inline');
    expect(findAll('dp-trigger')).toHaveLength(0);
    expect(findAll('dp-done')).toHaveLength(0);

    // Select all in earlier remote channel homelab / chatgpt-api (3 runs).
    selectChannel('["homelab","chatgpt-api"]');
    expect(activeRailId()).toBe('["homelab","chatgpt-api"]');
    find('dp-select-channel').events.click();
    expect(app.getSelectedTargets()).toHaveLength(3);

    // Switch to later channel homelab / agy-cli and check Gemini 4 Carbon row checkbox.
    selectChannel('["homelab","agy-cli"]');
    expect(activeRailId()).toBe('["homelab","agy-cli"]');
    const geminiCheck = findAll('dp-check')[0];
    geminiCheck.events.change();
    expect(activeRailId()).toBe('["homelab","agy-cli"]');
    expect(app.getSelectedTargets()).toHaveLength(7);

    // Toggle one thinking pill (row becomes indeterminate), re-select all 4, then uncheck row: channel stays on homelab / agy-cli.
    findAll('dp-think')
        .find(btn => btn.dataset.think === 'ultra')
        .events.click();
    expect(activeRailId()).toBe('["homelab","agy-cli"]');
    expect(app.getSelectedTargets()).toHaveLength(6);
    findAll('dp-check')[0].events.change();
    expect(activeRailId()).toBe('["homelab","agy-cli"]');
    expect(app.getSelectedTargets()).toHaveLength(7);
    findAll('dp-check')[0].events.change();
    expect(activeRailId()).toBe('["homelab","agy-cli"]');
    expect(app.getSelectedTargets()).toHaveLength(3);

    // Re-check one Gemini thinking level and remove that chip externally via #run-selected-targets.
    findAll('dp-think')
        .find(btn => btn.dataset.think === 'high')
        .events.click();
    expect(app.getSelectedTargets()).toHaveLength(4);
    const geminiKey = JSON.stringify([
        '["homelab","agy-cli"]',
        'gateway-binding:gateway-default',
        'homelab/agy-cli/gemini-4-carbon',
        'high'
    ]);
    byId('run-selected-targets').events.click({
        target: { closest: selector => (selector === '[data-remove-target-key]' ? { dataset: { removeTargetKey: geminiKey } } : null) }
    });
    expect(app.getSelectedTargets()).toHaveLength(3);
    expect(activeRailId()).toBe('["homelab","agy-cli"]');

    // Clear all selections, then verify staged drafts survive unchecking fixed account in local channel.
    find('dp-action').events.click();
    selectChannel('provider:openai');
    findAll('dp-think')[0].events.click();
    expect(app.getSelectedTargets()).toHaveLength(1);
    findAll('dp-acc-pill')[0].events.click();
    expect(app.getSelectedTargets()).toHaveLength(0);
    expect(findAll('dp-draft-note')).toHaveLength(1);

    // Verify unchecking the last item during search keeps search query, while external setTaskSelection([]) resets it.
    const searchInput = find('dp-search');
    searchInput.value = 'Gemini';
    searchInput.events.input();
    findAll('dp-think')[0].events.click();
    expect(app.getSelectedTargets()).toHaveLength(1);
    findAll('dp-think')[0].events.click();
    expect(app.getSelectedTargets()).toHaveLength(0);
    expect(find('dp-search').value).toBe('Gemini');

    app.setTaskSelection([]);
    expect(find('dp-search').value).toBe('');
});
