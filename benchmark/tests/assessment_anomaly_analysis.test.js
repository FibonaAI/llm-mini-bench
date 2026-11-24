import { describe, expect, test } from 'bun:test';
import { analyzeAnomalies, partition1D } from '../web/anomaly-analysis.js';

function makeRecord({
    id,
    source = 'run',
    bank_version = '2.0',
    provider = 'chan-a',
    account = 'gateway-default',
    accountEvidence = 'gateway_binding',
    model = 'gpt-6-luna',
    modelDisplayName = 'GPT-6 Luna',
    think = 'high',
    score = 90,
    costPerRound = 0.1,
    durationPerRound = 30,
    rounds = 3,
    created_at = '2026-11-24T10:00:00Z',
    run_id = `run-${id}`,
    target_id = `target-${id}`,
    exclusionReason = null,
    sampleAnomalies = null
} = {}) {
    const isGateway = accountEvidence === 'gateway_binding';
    const original = {
        id,
        source,
        bank_version,
        run_id,
        target_id,
        provider_id: provider,
        account_ref: account,
        account_evidence: accountEvidence,
        model,
        model_display_name: modelDisplayName,
        thinking: think,
        rounds,
        score: score / 100,
        estimated_cost_usd: costPerRound === null ? null : costPerRound * rounds,
        elapsed_seconds: durationPerRound === null ? null : durationPerRound * rounds,
        created_at
    };
    return {
        id,
        source,
        bank_version,
        run_id,
        target_id,
        providerId: `provider:${provider}`,
        providerName: provider,
        accountId: isGateway ? `gateway-binding:${account}` : `account:${account}`,
        accountDisplayId: isGateway ? '实际账号未记录' : account,
        model,
        modelDisplayName,
        think,
        score,
        cost: costPerRound,
        exclusionReason,
        sampleAnomalies,
        created_at,
        original
    };
}

describe('partition1D', () => {
    test('splits clear high-score cluster from low-score outliers deterministically', () => {
        const items = [92, 91, 90, 89, 64, 58].map((v, i) => ({ id: `p${i}`, v }));
        const split = partition1D(items, item => item.v);
        expect(split).not.toBeNull();
        expect(split.low.map(i => i.v)).toEqual([58, 64]);
        expect(split.high.map(i => i.v)).toEqual([89, 90, 91, 92]);
        expect(split.gap).toBe(25);
        expect(split.r2).toBeGreaterThan(0.9);
    });

    test('returns null for fewer than 3 items or identical values', () => {
        expect(partition1D([{ v: 10 }, { v: 90 }], i => i.v)).toBeNull();
        expect(partition1D([{ v: 80 }, { v: 80 }, { v: 80 }], i => i.v)).toBeNull();
    });
});

describe('analyzeAnomalies', () => {
    test('detects baseline score drop, cost inflation, and aggregates multi-model channel degradation', () => {
        const baseA = makeRecord({
            id: 'base-a',
            source: 'baseline',
            provider: 'official',
            model: 'm1',
            modelDisplayName: 'Model A',
            score: 92,
            costPerRound: 0.1,
            durationPerRound: 25
        });
        const baseB = makeRecord({
            id: 'base-b',
            source: 'baseline',
            provider: 'official',
            model: 'm2',
            modelDisplayName: 'Model B',
            score: 88,
            costPerRound: 0.12,
            durationPerRound: 25
        });
        const badA = makeRecord({
            id: 'run-a',
            provider: 'proxy-x',
            model: 'm1',
            modelDisplayName: 'Model A',
            score: 72,
            costPerRound: 0.18,
            durationPerRound: 28
        });
        const badB = makeRecord({
            id: 'run-b',
            provider: 'proxy-x',
            model: 'm2',
            modelDisplayName: 'Model B',
            score: 70,
            costPerRound: 0.22,
            durationPerRound: 28
        });

        const res = analyzeAnomalies([badA, badB], { baselinePool: [baseA, baseB, badA, badB] });
        expect(res.baselinePairs).toBe(2);

        const scoreFinding = res.findings.find(f => f.method === 'baseline' && f.metric === 'score');
        expect(scoreFinding).toBeDefined();
        expect(scoreFinding.scope).toBe('channel');
        expect(scoreFinding.severity).toBe('high');
        expect(scoreFinding.modelCount).toBe(2);
        expect(scoreFinding.providerLabel).toBe('proxy-x');
        expect(scoreFinding.summary).toContain('2 个模型配置');
        expect(scoreFinding.recordIds).toEqual(['run-a', 'run-b']);

        const costFinding = res.findings.find(f => f.method === 'baseline' && f.metric === 'cost');
        expect(costFinding).toBeDefined();
        expect(costFinding.modelCount).toBe(2);
        expect(costFinding.summary).toContain('成本高于基线');
    });

    test('detects low-score cluster outliers across channels without baselines', () => {
        const records = [
            makeRecord({ id: 'c1', provider: 'chan-1', score: 92 }),
            makeRecord({ id: 'c2', provider: 'chan-2', score: 91 }),
            makeRecord({ id: 'c3', provider: 'chan-3', score: 90 }),
            makeRecord({ id: 'c4', provider: 'chan-4', score: 88 }),
            makeRecord({ id: 'c5', provider: 'chan-bad-1', score: 66 }),
            makeRecord({ id: 'c6', provider: 'chan-bad-2', score: 60 })
        ];
        const res = analyzeAnomalies(records);
        expect(res.comparableGroups).toBeGreaterThanOrEqual(1);
        const scoreFindings = res.findings.filter(f => f.method === 'cluster' && f.metric === 'score');
        expect(scoreFindings).toHaveLength(2);
        expect(scoreFindings.map(f => f.providerLabel).sort()).toEqual(['chan-bad-1', 'chan-bad-2']);
        expect(scoreFindings[0].summary).toContain('同组高分簇 4 项均分');
    });

    test('detects high-cost channel outliers and aggregates across multiple models', () => {
        const records = [
            makeRecord({ id: 'a1', provider: 'chan-a', model: 'm1', modelDisplayName: 'M1', score: 90, costPerRound: 0.08 }),
            makeRecord({ id: 'b1', provider: 'chan-b', model: 'm1', modelDisplayName: 'M1', score: 91, costPerRound: 0.09 }),
            makeRecord({ id: 'c1', provider: 'chan-expensive', model: 'm1', modelDisplayName: 'M1', score: 90, costPerRound: 0.2 }),
            makeRecord({ id: 'a2', provider: 'chan-a', model: 'm2', modelDisplayName: 'M2', score: 86, costPerRound: 0.05 }),
            makeRecord({ id: 'b2', provider: 'chan-b', model: 'm2', modelDisplayName: 'M2', score: 85, costPerRound: 0.06 }),
            makeRecord({ id: 'c2', provider: 'chan-expensive', model: 'm2', modelDisplayName: 'M2', score: 86, costPerRound: 0.14 })
        ];
        const res = analyzeAnomalies(records);
        const costFindings = res.findings.filter(f => f.metric === 'cost');
        expect(costFindings).toHaveLength(1);
        expect(costFindings[0].providerLabel).toBe('chan-expensive');
        expect(costFindings[0].modelCount).toBe(2);
        expect(costFindings[0].severity).toBe('high');
        expect(costFindings[0].summary).toContain('2 个模型配置上均成本显著高于同模型其他渠道');
    });

    test('detects within-provider account anomaly without duplicating as cross-channel noise', () => {
        const records = [
            makeRecord({
                id: 'acc-1',
                provider: 'chatgpt-main',
                account: 'alice@example.com',
                accountEvidence: 'gateway_account_binding',
                score: 92
            }),
            makeRecord({
                id: 'acc-2',
                provider: 'chatgpt-main',
                account: 'bob@example.com',
                accountEvidence: 'gateway_account_binding',
                score: 90
            }),
            makeRecord({
                id: 'acc-3',
                provider: 'chatgpt-main',
                account: 'carol@example.com',
                accountEvidence: 'gateway_account_binding',
                score: 91
            }),
            makeRecord({
                id: 'acc-bad',
                provider: 'chatgpt-main',
                account: 'bad@example.com',
                accountEvidence: 'gateway_account_binding',
                score: 58
            }),
            makeRecord({ id: 'other-chan', provider: 'other-provider', score: 91 })
        ];
        const res = analyzeAnomalies(records);
        const accountFindings = res.findings.filter(f => f.scope === 'account');
        expect(accountFindings).toHaveLength(1);
        expect(accountFindings[0].providerLabel).toBe('chatgpt-main');
        expect(accountFindings[0].accountRaw).toBe('bad@example.com');
        expect(accountFindings[0].summary).toContain('得分显著低于同渠道其他账号');

        // Should not emit a duplicate cross-channel finding for the same single-account anomaly
        const crossFindings = res.findings.filter(f => f.scope !== 'account');
        expect(crossFindings).toHaveLength(0);
    });

    test('supports pairwise comparison when only two channels exist', () => {
        const records = [
            makeRecord({ id: 'good', provider: 'chan-good', score: 91, costPerRound: 0.1 }),
            makeRecord({ id: 'weak', provider: 'chan-weak', score: 74, costPerRound: 0.22 })
        ];
        const res = analyzeAnomalies(records);
        expect(res.findings.some(f => f.providerLabel === 'chan-weak' && f.metric === 'score')).toBe(true);
        expect(res.findings.some(f => f.providerLabel === 'chan-weak' && f.metric === 'cost')).toBe(true);
    });

    test('never mixes different models or Thinking levels and stays clean when channels perform similarly', () => {
        const records = [
            makeRecord({ id: 'h1', provider: 'chan-a', model: 'm1', think: 'high', score: 92, costPerRound: 0.12 }),
            makeRecord({ id: 'h2', provider: 'chan-b', model: 'm1', think: 'high', score: 90, costPerRound: 0.13 }),
            makeRecord({ id: 'l1', provider: 'chan-a', model: 'm1', think: 'low', score: 65, costPerRound: 0.04 }),
            makeRecord({ id: 'm2', provider: 'chan-b', model: 'm2', think: 'high', score: 50, costPerRound: 0.02 })
        ];
        const res = analyzeAnomalies(records);
        expect(res.findings).toHaveLength(0);
        expect(res.comparableGroups).toBe(1);
    });

    test('matches same model across channels with different route prefixes and display punctuation', () => {
        const baseline = makeRecord({
            id: 'base-openai',
            source: 'baseline',
            provider: 'homelab / openai',
            model: 'homelab/openai/gpt-6-luna',
            modelDisplayName: 'GPT-6 Luna',
            think: 'high',
            score: 73.1,
            costPerRound: 0.048
        });
        const codexRun = makeRecord({
            id: 'run-codex',
            provider: 'homelab / codex',
            model: 'homelab/codex/gpt-6-luna',
            modelDisplayName: 'GPT-6-Luna',
            think: 'high',
            score: 57.3,
            costPerRound: 0.047
        });
        const costPeers = [
            makeRecord({
                id: 'sol-codex',
                provider: 'homelab / codex',
                model: 'homelab/codex/gpt-6.2-sol',
                modelDisplayName: 'GPT-6.2-Sol',
                think: 'low',
                score: 89.9,
                costPerRound: 0.6567
            }),
            makeRecord({
                id: 'sol-chatgpt',
                provider: 'homelab / chatgpt-api',
                model: 'homelab/chatgpt-api/gpt-6.2-sol',
                modelDisplayName: 'GPT-6.2-Sol',
                think: 'low',
                score: 88.8,
                costPerRound: 0.2279
            }),
            makeRecord({
                id: 'sol-openai',
                provider: 'homelab / openai',
                model: 'homelab/openai/gpt-6.2-sol',
                modelDisplayName: 'GPT-6.2-Sol',
                think: 'low',
                score: 90.3,
                costPerRound: 0.214
            })
        ];

        const res = analyzeAnomalies([baseline, codexRun, ...costPeers]);
        expect(res.baselinePairs).toBe(1);
        expect(res.comparableGroups).toBe(2);
        expect(res.findings.some(f => f.method === 'baseline' && f.providerLabel === 'homelab / codex' && f.metric === 'score')).toBe(true);
        expect(res.findings.some(f => f.method === 'cluster' && f.providerLabel === 'homelab / codex' && f.metric === 'cost')).toBe(true);
    });

    test('aggregates cross-channel comparisons per channel so unequal account counts and extreme accounts do not hide or skew channel anomalies', () => {
        const codexHigh = [
            ['codex-hi-1', 'a@outlook.com', 0.989],
            ['codex-hi-2', 'b@outlook.com', 0.959],
            ['codex-hi-3', 'c@outlook.com', 0.955]
        ].map(([id, account, costPerRound]) =>
            makeRecord({
                id,
                provider: 'codex',
                account,
                accountEvidence: 'gateway_account_binding',
                model: 'gpt-6.1-sol',
                modelDisplayName: 'GPT-6.1-Sol',
                think: 'medium',
                score: 85,
                costPerRound
            })
        );
        const codexNormal = [
            ['codex-ok-1', 'n1@gmx.com', 0.632],
            ['codex-ok-2', 'n2@gmx.com', 0.623],
            ['codex-ok-3', 'n3@gmx.com', 0.622],
            ['codex-ok-4', 'n4@gmx.com', 0.62]
        ].map(([id, account, costPerRound]) =>
            makeRecord({
                id,
                provider: 'codex',
                account,
                accountEvidence: 'gateway_account_binding',
                model: 'gpt-6.1-sol',
                modelDisplayName: 'GPT-6.1-Sol',
                think: 'medium',
                score: 85,
                costPerRound
            })
        );
        const chatgptPeers = [
            ['cg-1', 'n1@gmx.com', 0.284],
            ['cg-2', 'a@outlook.com', 0.28],
            ['cg-3', 'n2@gmx.com', 0.261],
            ['cg-4', 'n3@gmx.com', 0.248],
            ['cg-5', 'n4@gmx.com', 0.245]
        ].map(([id, account, costPerRound]) =>
            makeRecord({
                id,
                provider: 'chatgpt-api',
                account,
                accountEvidence: 'gateway_account_binding',
                model: 'gpt-6.1-sol',
                modelDisplayName: 'GPT-6.1-Sol',
                think: 'medium',
                score: 85,
                costPerRound
            })
        );

        const res = analyzeAnomalies([...codexHigh, ...codexNormal, ...chatgptPeers]);

        // 3 within-channel account anomalies + 1 channel-wide anomaly even though codex has more accounts (7 vs 5)
        const accountGroups = res.groups.filter(g => g.kind === 'account');
        const channelGroups = res.groups.filter(g => g.kind === 'channel');
        expect(accountGroups).toHaveLength(3);
        expect(channelGroups).toHaveLength(1);
        expect(channelGroups[0].providerLabel).toBe('codex');
        expect(channelGroups[0].accountCount).toBe(7);

        const channelItem = channelGroups[0].items[0];
        expect(channelItem.valueText).toBe('中位 $0.623');
        expect(channelItem.refText).toBe('$0.261');
        expect(channelItem.recordIds).toHaveLength(7);
        expect(channelItem.referenceIds).toHaveLength(5);

        const accountItem = accountGroups[0].items[0];
        expect(accountItem.recordIds).toHaveLength(1);
        expect(accountItem.referenceIds).toEqual(expect.arrayContaining(['codex-ok-1', 'codex-ok-2', 'codex-ok-3', 'codex-ok-4']));
    });
});
