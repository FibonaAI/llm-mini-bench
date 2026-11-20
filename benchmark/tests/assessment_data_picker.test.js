import { expect, test } from 'bun:test';
import { createDataPicker, selectionKey } from '../web/data-picker.js';

class TestElement {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.attributes = {};
        this.events = {};
        this.value = '';
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
    querySelectorAll(selector) {
        return this.children
            .flatMap(node => [node, ...(node.querySelectorAll?.('*') ?? [])])
            .filter(
                node =>
                    selector === '*' ||
                    (selector === '[data-focus-id]' ? node.dataset?.focusId : node.className?.split(' ').includes(selector.slice(1)))
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
    const find = className => nodes().find(node => node.className === className);
    const filter = (className, value) => {
        const node = find(className);
        node.value =
            className === 'dp-model-filter'
                ? value
                      .normalize('NFKC')
                      .trim()
                      .toLocaleLowerCase()
                      .replace(/[\s_-]+/g, '-')
                : value;
        node.events.change();
    };
    const search = value => {
        const node = find('dp-search');
        node.value = value;
        node.events.input();
    };
    const levels = () => nodes().filter(node => node.className === 'dp-think');
    return { picker, records, changes, nodes, container, find, filter, search, levels };
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
test('channel, model and thinking filters never select or clear targets', () => {
    const { picker, filter, levels, changes, find, nodes } = fixture();
    expect(nodes().some(node => node.className === 'dp-account-filter')).toBe(false);
    expect(find('dp-thinking-filter').attributes['aria-label']).toBe('筛选思考');
    filter('dp-provider-filter', 'DeepSeek');
    filter('dp-model-filter', 'GPT-6-Luna');
    expect(levels()).toHaveLength(1);
    filter('dp-thinking-filter', 'low');
    expect(levels()).toHaveLength(0);
    filter('dp-provider-filter', '');
    expect(levels()).toHaveLength(1);
    expect(levels()[0].dataset.think).toBe('low');
    expect(picker.getSelection()).toHaveLength(3);
    expect(changes).toEqual([]);
});
test('model dropdown filters the same display model across channels without merging request identities', () => {
    const records = [
        {
            providerId: 'one',
            provider: 'One',
            accountId: 'a',
            account: 'A',
            model: 'one/exact/luna',
            modelDisplayName: 'GPT-6 Luna',
            think: 'high'
        },
        {
            providerId: 'two',
            provider: 'Two',
            accountId: 'b',
            account: 'B',
            model: 'two/exact/luna',
            modelDisplayName: 'GPT-6-Luna',
            think: 'high'
        },
        {
            providerId: 'two',
            provider: 'Two',
            accountId: 'b',
            account: 'B',
            model: 'two/exact/other',
            modelDisplayName: 'Other model',
            think: 'high'
        }
    ];
    const { picker, filter, levels, find, nodes } = fixture({ records, selectedKeys: [] });
    expect(
        find('dp-model-filter')
            .children.slice(1)
            .map(node => node.textContent)
    ).toEqual(['GPT-6 Luna', 'Other model']);
    filter('dp-model-filter', 'GPT-6 Luna');
    expect(levels()).toHaveLength(2);
    find('dp-select-visible').events.click();
    expect(picker.getSelection()).toEqual(records.slice(0, 2).map(selectionKey));
    filter('dp-model-filter', 'Other model');
    expect(levels()).toHaveLength(1);
    expect(find('dp-hidden-count').textContent).toBe('2 项在当前筛选之外');
    find('dp-reset-filters').events.click();
    expect(find('dp-model-filter').value).toBe('');
    expect(levels()).toHaveLength(3);
    expect(picker.getSelection()).toHaveLength(2);
    expect(find('dp-column-head').children.map(node => node.textContent)).toEqual(['渠道', '模型', '思考']);
    const row = nodes().find(node => node.className === 'dp-result-row');
    expect(row.children.slice(0, 4).map(node => node.className)).toEqual(['dp-check', 'dp-route', 'dp-model-name', 'dp-thinking-list']);
});
test('model options follow the selected channel, clear incompatible model filters and retain exact selections', () => {
    const records = [
        { providerId: 'codex', provider: 'Codex', account: 'A', model: 'codex/luna', modelDisplayName: 'Luna', think: 'high' },
        { providerId: 'codex', provider: 'Codex', account: 'A', model: 'codex/terra', modelDisplayName: 'Terra', think: 'high' },
        { providerId: 'other', provider: 'Other', account: 'B', model: 'other/luna', modelDisplayName: 'Luna', think: 'high' },
        { providerId: 'other', provider: 'Other', account: 'B', model: 'other/claude', modelDisplayName: 'Claude', think: 'high' }
    ];
    const { picker, filter, levels, find, changes } = fixture({ records, selectedKeys: [selectionKey(records[3])] });
    const modelOptions = () =>
        find('dp-model-filter')
            .children.slice(1)
            .map(node => node.value);
    filter('dp-model-filter', 'Claude');
    filter('dp-provider-filter', 'codex');
    expect(modelOptions()).toEqual(['luna', 'terra']);
    expect(find('dp-model-filter').value).toBe('');
    expect(levels()).toHaveLength(2);
    filter('dp-model-filter', 'Luna');
    filter('dp-provider-filter', 'other');
    expect(modelOptions()).toEqual(['luna', 'claude']);
    expect(find('dp-model-filter').value).toBe('luna');
    expect(levels()).toHaveLength(1);
    expect(levels()[0].dataset.model).toBe('other/luna');
    filter('dp-provider-filter', '');
    expect(modelOptions()).toEqual(['luna', 'terra', 'claude']);
    expect(levels()).toHaveLength(2);
    filter('dp-provider-filter', 'codex');
    find('dp-reset-filters').events.click();
    expect(modelOptions()).toEqual(['luna', 'terra', 'claude']);
    expect(levels()).toHaveLength(4);
    expect(picker.getSelection()).toEqual([selectionKey(records[3])]);
    expect(changes).toEqual([]);
});
test('select search results only affects matched leaves; row check is tri-state', () => {
    const { picker, records, search, levels, nodes, find, filter } = fixture({ selectedKeys: [] });
    levels()[0].events.click();
    expect(nodes().find(node => node.className === 'dp-check').indeterminate).toBe(true);
    filter('dp-thinking-filter', 'high');
    search('DeepSeek');
    find('dp-select-visible').events.click();
    expect(picker.getSelection()).toEqual([records[0], records[2]].map(selectionKey));
    find('dp-reset-filters').events.click();
    expect(levels()).toHaveLength(3);
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
    find('dp-reset-filters').events.click();
    expect(levels()).toHaveLength(3);
    find('dp-done').events.click();
    expect(picker.getSelection()).toEqual([selectionKey(records[1])]);
});
test('leaf changes independent; popup lifecycle and destroy remove listeners', () => {
    const { picker, levels, container } = fixture();
    picker.show();
    expect(container.children[0].attributes['aria-expanded']).toBe('true');
    levels()[0].events.click();
    expect(picker.getSelection()).toHaveLength(2);
    document.events.keydown({ key: 'Escape', preventDefault() {} });
    expect(container.children[0].attributes['aria-expanded']).toBe('false');
    expect(document.activeElement).toBe(container.children[0]);
    picker.destroy();
    expect(document.events).toEqual({});
    expect(window.events).toEqual({});
});
test('popup stays anchored and shrinks to available space', () => {
    const { picker, container } = fixture({ selectedKeys: [], mode: 'tasks' });
    window.innerWidth = 1024;
    window.innerHeight = 900;
    container.children[0].getBoundingClientRect = () => ({ left: 40, top: 280, bottom: 312 });
    picker.show();
    const popup = document.body.children[0];
    expect(popup.style.width).toBe('720px');
    expect(popup.style.height).toBe('428px');
    expect(popup.style.left).toBe('40px');
    expect(popup.style.top).toBe('320px');
    expect(popup.dataset.placement).toBe('below');
    window.innerHeight = 660;
    window.events.resize();
    expect(popup.style.height).toBe('324px');
    expect(popup.style.top).toBe('320px');
    expect(picker.getSelection()).toEqual([]);
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
    expect(popup.style.height).toBe('422px');
    window.innerHeight = 660;
    window.events.resize();
    expect(popup.style.height).toBe('422px');
    expect(popup.dataset.placement).toBe('viewport');
    expect(Number.parseFloat(popup.style.top) + Number.parseFloat(popup.style.height)).toBeLessThanOrEqual(644);
});
test('popup flips near bottom and uses viewport space in short windows', () => {
    const { picker, container } = fixture({ mode: 'tasks' });
    container.children[0].getBoundingClientRect = () => ({ left: 400, top: 608, bottom: 640 });
    picker.show();
    const popup = document.body.children[0];
    expect(popup.dataset.placement).toBe('above');
    expect(popup.style.top).toBe('172px');
    expect(popup.style.left).toBe('164px');
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
    const { picker, filter, levels, changes, find } = fixture({ records, selectedKeys: [] });
    expect(
        find('dp-provider-filter')
            .children.slice(1)
            .map(node => node.textContent)
    ).toEqual(['Same name · chatgpt-main', 'Same name · chatgpt-lab']);
    expect(
        find('dp-model-filter')
            .children.slice(1)
            .map(node => node.textContent)
    ).toEqual(['Luna']);
    filter('dp-provider-filter', 'chatgpt-main');
    expect(levels()).toHaveLength(2);
    levels()[1].events.click();
    filter('dp-provider-filter', 'chatgpt-lab');
    expect(levels()[1].attributes['aria-pressed']).toBe('false');
    levels()[1].events.click();
    expect(picker.getSelection()).toEqual([records[1], records[3]].map(selectionKey));
    expect(changes).toHaveLength(2);
});
test('explicit efforts display and select their exact protocol value', () => {
    const { levels, picker } = fixture({ records: [{ provider: 'A', account: 'B', model: 'Luna', think: 'none' }], selectedKeys: [] });
    expect(levels()[0].textContent).toBe('none');
    expect(levels()[0].dataset.think).toBe('none');
    levels()[0].events.click();
    expect(JSON.parse(picker.getSelection()[0])[3]).toBe('none');
});
test('default has a clear display label but keeps the exact protocol value', () => {
    const { levels, picker } = fixture({ records: [{ provider: 'A', account: 'B', model: 'Luna', think: 'default' }], selectedKeys: [] });
    expect(levels()[0].textContent).toBe('默认');
    expect(levels()[0].dataset.think).toBe('default');
    levels()[0].events.click();
    expect(JSON.parse(picker.getSelection()[0])[3]).toBe('default');
});
test('target rows show supplier, account and model without quota disclosures', () => {
    const records = [
        {
            providerId: 'provider:office',
            providerName: 'Office supplier',
            provider: 'office',
            account: 'Named account',
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
    expect(find('dp-provider-name').textContent).toBe('Office supplier');
    expect(find('dp-account-name').textContent).toBe('Named account');
    expect(find('dp-model-name').textContent).toBe('Luna');
    expect(nodes().some(node => node.className?.startsWith('dp-quota'))).toBe(false);
    expect(picker.getSelection()).toEqual(records.map(selectionKey));
    expect(changes).toEqual([]);
});
