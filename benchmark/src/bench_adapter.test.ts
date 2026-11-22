import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BenchService } from '../backend/mini_bench.ts';
import { BenchExecutionService, type ExecutionRoute, type ExecutionRoutes } from './bench_execution.ts';

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() {
    const value = mkdtempSync(join(tmpdir(), 'bench-adapter-'));
    directories.push(value);
    return value;
}

test('standalone service uses explicit routes without contacting an implicit host gateway', async () => {
    const service = new BenchService({ token: 'offline-test-token-000000000000000000', data_dir: directory() });
    try {
        expect(await service.models()).toEqual([]);
        expect(await service.quota_cards()).toEqual({ status: 'unavailable', fetched_at: null, cards: [] });
        expect(await service.bench_execution().routes.public_routes()).toEqual([]);
    } finally {
        await service.close();
    }
});

test('generic adapter owns execution transport and snapshots while the engine freezes binding evidence', async () => {
    const storage = directory();
    const route: ExecutionRoute = {
        id: 'route',
        label: 'fixture',
        account_ref: 'account',
        binding_ref: 'adapter-binding-v1',
        provider_id: 'fixture',
        provider_evidence: 'fixture_catalog',
        remote_route: { namespace: 'namespace', evidence: 'fixture_catalog' },
        model: 'same-model',
        base_url: 'https://never-contact.invalid',
        api_key: 'offline-only',
        thinking_levels: ['high'],
        pricing: { prompt: 0, completion: 0 },
        account_concurrency: 1
    };
    const received: ExecutionRoute[] = [];
    const routes: ExecutionRoutes = {
        resolve: () => structuredClone(route),
        public_routes: () => [],
        execution_sources: () => ({ 'adapter/fixture.ts': new TextEncoder().encode('fixture source bytes') }),
        create_client: binding => {
            received.push(binding);
            return {
                async post_responses_stream() {
                    return [200, 0, {}, { status: 'completed', output_text: 'fixture', usage: { input_tokens: 1, output_tokens: 1 } }];
                }
            };
        }
    };
    const service = new BenchExecutionService(storage, routes, 1, () => {
        throw new Error('default transport must not execute');
    });
    try {
        const id = await service.start_run({
            targets: [{ route_id: 'route', thinking: 'high' }],
            task_ids: ['K23_HTTP_Conditional_Cache_Precedence'],
            rounds: 1
        });
        route.binding_ref = 'adapter-binding-v2';
        await service.wait_for_run(id);
        const run = service.get_run(id)!;
        expect(received).toHaveLength(1);
        expect(received[0]!.binding_ref).toBe('adapter-binding-v1');
        expect(run.plan.targets[0]!.binding_ref).toBe('adapter-binding-v1');
        expect(run.plan.targets[0]!.remote_route!.evidence).toBe('fixture_catalog');
        expect(run.plan.source_sha256['adapter/fixture.ts']).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(join(storage, id, 'source'))).toBe(false);
        expect(JSON.stringify(run)).not.toContain('offline-only');
    } finally {
        await service.close();
    }
});

test('adapter source paths cannot escape evidence storage or replace grading sources', async () => {
    for (const path of ['../escape.ts', '/absolute.ts', 'src/assessment_tasks.ts']) {
        const routes: ExecutionRoutes = {
            resolve: () => ({
                account_ref: 'a',
                base_url: 'https://never.invalid',
                model: 'm',
                api_key: 'k',
                thinking_levels: ['high'],
                account_concurrency: 1,
                pricing: { prompt: 0, completion: 0 }
            }),
            public_routes: () => [],
            execution_sources: () => ({ [path]: new Uint8Array([1]) })
        };
        const service = new BenchExecutionService(directory(), routes);
        try {
            await expect(service.plan({ targets: [{ route_id: 'route', thinking: 'high' }] })).rejects.toThrow('adapter execution source');
            expect(service.list_runs()).toEqual([]);
        } finally {
            await service.close();
        }
    }
});
