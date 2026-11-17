import { test, expect } from 'bun:test';
import { chartCategory, createChartColorRegistry } from '../web/chart-colors.js';
const models = ['Claude Sonnet 4.6', 'DeepSeek V4', 'GPT-6 Astra', 'GPT-6 Luna', 'Gemini 3.1 Pro'].map(model => ({
    model,
    provider: 'ChatGPT API',
    providerId: 'chatgpt-main',
    providerName: '主渠道',
    account: '主账号',
    accountId: 'main'
}));
test('model categories never collide as the old modulo hash did', () => {
    const colors = createChartColorRegistry(models);
    for (const dark of [false, true]) expect(new Set(models.map(r => colors.color(r, 'model', dark))).size).toBe(5);
});
test('colors stay stable across filtering and reordering', () => {
    const a = createChartColorRegistry(models),
        b = createChartColorRegistry([...models].reverse());
    const before = models.map(r => a.color(r, 'model'));
    a.register([models[3]], 'model');
    expect(models.map(r => a.color(r, 'model'))).toEqual(before);
    expect(models.map(r => b.color(r, 'model'))).toEqual(before);
});
test('same type and same account display names on different instances remain distinct', () => {
    const first = models[0],
        second = { ...first, providerId: 'chatgpt-lab', providerName: '实验渠道' };
    const colors = createChartColorRegistry([first, second]);
    for (const dimension of ['provider', 'account']) {
        expect(chartCategory(first, dimension).key).not.toBe(chartCategory(second, dimension).key);
        expect(colors.color(first, dimension)).not.toBe(colors.color(second, dimension));
    }
});
test('model coloring merges channels but separates model variants', () => {
    const luna = { model: 'gpt-6-luna', providerId: 'a', accountId: 'one' };
    const otherChannel = { ...luna, providerId: 'b', accountId: 'two', modelDisplayName: 'GPT-6 Luna' };
    const sol = { ...luna, model: 'gpt-6.1-sol' };
    const colors = createChartColorRegistry([luna, otherChannel, sol]);
    for (const dark of [false, true]) {
        expect(colors.color(luna, 'series', dark)).not.toBe(colors.color(otherChannel, 'series', dark));
        expect(colors.color(luna, 'model', dark)).toBe(colors.color(otherChannel, 'model', dark));
        expect(colors.color(luna, 'model', dark)).not.toBe(colors.color(sol, 'model', dark));
    }
});
test('family coloring groups recorded model names without inferring provider identity', () => {
    const rows = [
        'gpt-6-luna',
        'GPT-6.1-Sol',
        'DeepSeek-V4',
        'deepseek v3.2',
        'Claude Sonnet 4.6',
        'Claude Opus 4.7',
        'Gemini 3.1 Pro',
        'Gemini 3 Flash'
    ].map(model => ({ model, providerId: 'same-provider' }));
    const colors = createChartColorRegistry(rows);
    for (const dark of [false, true]) {
        for (let i = 0; i < rows.length; i += 2)
            expect(colors.color(rows[i], 'family', dark)).toBe(colors.color(rows[i + 1], 'family', dark));
        expect(new Set(rows.map(row => colors.color(row, 'family', dark))).size).toBe(4);
    }
    expect(chartCategory(rows[0], 'family').label).toBe('GPT');
    expect(chartCategory(rows[2], 'family').label).toBe('DeepSeek');
    for (const model of ['Qwen3.5', 'Llama-4', 'Grok 4', 'Kimi K2', 'GLM-5', 'Mistral Large', 'MiniMax-M2'])
        expect(chartCategory({ model }, 'family').key).toContain('family');
    const unknown = ['gptish-1', 'custom-one', 'custom-two', 'openai/unknown', '未记录模型'];
    expect(new Set(unknown.map(model => chartCategory({ model }, 'family').key)).size).toBe(unknown.length);
    expect(chartCategory({ model: 'custom-one', providerId: 'gpt' }, 'family').key).not.toBe(chartCategory(rows[0], 'family').key);
});
test('all color modes keep full-catalog assignments through filtering and mode changes', () => {
    const rows = ['gpt-6-luna', 'gpt-6.1-sol', 'deepseek-v4'].map(model => ({ model, providerId: 'a' }));
    const colors = createChartColorRegistry(rows),
        reverse = createChartColorRegistry([...rows].reverse());
    for (const dimension of ['series', 'model', 'family'])
        for (const dark of [false, true]) {
            const before = rows.map(row => colors.color(row, dimension, dark));
            colors.register([rows[1]], dimension);
            expect(rows.map(row => colors.color(row, dimension, dark))).toEqual(before);
            expect(rows.map(row => reverse.color(row, dimension, dark))).toEqual(before);
        }
});
test('larger catalogs are not wrapped onto the base palette', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ model: `model-${i}` }));
    const colors = createChartColorRegistry(rows);
    expect(new Set(rows.map(r => colors.color(r, 'model'))).size).toBe(40);
});
