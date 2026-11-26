import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BenchService, make_handler } from '../backend/mini_bench.ts';
import { assessment_task_snapshot, load_assessment_bank } from '../src/assessment_bank.ts';
import { build_assessment_baseline } from '../src/assessment_baselines.ts';
import { capture_assessment_sources } from '../src/assessment_provenance.ts';
import { assessment_sample_protocol, execution_protocol_hash } from '../src/run_protocol.ts';
import { MagpieBenchAdapter } from '../../magpie/magpie_adapter.ts';

// Real HTTP + opaque iframe: route.fulfill would hide the CORS regression this test guards.
const exec = promisify(execFile);
const artifacts = mkdtempSync(join(tmpdir(), 'assessment-sandbox-'));
const token = 'offline-sandbox-token-never-a-real-secret-000000';
const web = process.env.MINI_BENCH_WEB_DIR || fileURLToPath(new URL('../web/', import.meta.url));
const previousRoutes = process.env.MAGPIE_BENCH_ROUTES_FILE;
delete process.env.MAGPIE_BENCH_ROUTES_FILE;
const adapter = new MagpieBenchAdapter('http://127.0.0.1:1/never-contact', 'offline-test');
const service = new BenchService({ token, data_dir: join(artifacts, 'data'), adapter });
// Seed this isolated acceptance workspace explicitly; production workspaces stay empty.
const seededBank = load_assessment_bank('2.0');
const seededCards = seededBank.tasks.map(assessment_task_snapshot);
const seededBank1 = load_assessment_bank('1.0');
const seededCards1 = seededBank1.tasks.map(assessment_task_snapshot);
const seededLimits = {
    max_output_tokens: null,
    max_turns: null,
    max_tool_calls: null,
    timeout: 600,
    max_api_retries: 3,
    timeout_scope: 'sample'
};
const seededTarget = {
    id: 'sandbox-target',
    model: 'remote-A/openai/exact/model-v1',
    route_id: 'remote-A-openai',
    provider_id: 'remote-A',
    provider_evidence: 'gateway_catalog',
    account_ref: 'gateway-default',
    account_evidence: 'gateway_binding',
    thinking: 'high'
};
const { tasks: _seededTasks, ...seededBankSnapshot } = seededBank;
const seededBaseline = build_assessment_baseline(
    {
        id: 'sandbox-baseline-run',
        status: 'completed',
        created_at: '2026-11-11T00:00:00Z',
        plan: {
            bank_version: '2.0',
            bank_scope: 'whole',
            bank_snapshot: seededBankSnapshot,
            task_ids: seededBank.task_ids,
            task_snapshots: seededCards,
            source_sha256: capture_assessment_sources(seededBank).hashes,
            targets: [seededTarget],
            rounds: 1,
            limits: seededLimits
        },
        samples: seededCards.map(card => {
            const { execution_protocol, assessment_protocol_sha256 } = assessment_sample_protocol(card, 'high', seededLimits, false);
            return {
                sample_id: `${card.id}-1`,
                run_id: 'sandbox-baseline-run',
                target_id: seededTarget.id,
                route_id: seededTarget.route_id,
                account_ref: seededTarget.account_ref,
                task: card.id,
                round: 1,
                model: seededTarget.model,
                thinking: 'high',
                status: 'completed',
                ok: true,
                usage: { input_tokens: 100, output_tokens: 200 },
                estimated_uncached_cost_usd: 0.01,
                execution_protocol,
                execution_protocol_sha256: execution_protocol_hash(execution_protocol),
                assessment_protocol_sha256,
                grade: { content_score: 0.85, instruction_checks: { submit_answer: true }, outcome: 'correct' }
            };
        })
    },
    seededTarget.id
);
service.save_baseline(seededBaseline);
const { tasks: _seededTasks1, ...seededBankSnapshot1 } = seededBank1;
const seededBaseline1 = build_assessment_baseline(
    {
        id: 'sandbox-baseline-run-1-0',
        status: 'completed',
        created_at: '2026-11-10T00:00:00Z',
        plan: {
            bank_version: '1.0',
            bank_scope: 'whole',
            bank_snapshot: seededBankSnapshot1,
            task_ids: seededBank1.task_ids,
            task_snapshots: seededCards1,
            source_sha256: capture_assessment_sources(seededBank1).hashes,
            targets: [seededTarget],
            rounds: 1,
            limits: seededLimits
        },
        samples: seededCards1.map(card => {
            const { execution_protocol, assessment_protocol_sha256 } = assessment_sample_protocol(card, 'high', seededLimits, false);
            return {
                sample_id: `${card.id}-1`,
                run_id: 'sandbox-baseline-run-1-0',
                target_id: seededTarget.id,
                route_id: seededTarget.route_id,
                account_ref: seededTarget.account_ref,
                task: card.id,
                round: 1,
                model: seededTarget.model,
                thinking: 'high',
                status: 'completed',
                ok: true,
                usage: { input_tokens: 120, output_tokens: 240 },
                estimated_uncached_cost_usd: 0.02,
                execution_protocol,
                execution_protocol_sha256: execution_protocol_hash(execution_protocol),
                assessment_protocol_sha256,
                grade: { content_score: 0.9, instruction_checks: { submit_answer: true }, outcome: 'correct' }
            };
        })
    },
    seededTarget.id
);
service.save_baseline(seededBaseline1);
adapter.models = async () =>
    [
        ...['remote-A', 'remote-B'].map(owner => ({
            id: `${owner}/openai/exact/model-v1`,
            owned_by: owner,
            magpie_via: ['remote-hop', 'local-hop'],
            reasoning_levels: ['high']
        })),
        ...['auto', 'group'].map(namespace => ({
            id: `remote-A/${namespace}/model-v1`,
            owned_by: 'remote-A',
            magpie_via: ['remote-hop', 'local-hop'],
            reasoning_levels: ['high']
        })),
        { id: 'ordinary-owner/openai/not-a-remote', owned_by: 'ordinary-owner', reasoning_levels: ['high'] },
        ...['image', 'video', 'decision'].map(kind => ({ id: `excluded-${kind}/model`, owned_by: `excluded-${kind}`, kind }))
    ].map(model => ({ ...model, pricing: { prompt: '0.000001', completion: '0.000002' } }));
adapter.gateway = async (path, body) => {
    if (path === '/magpie/quotas/cards' && body === undefined)
        return {
            data: [
                {
                    provider: 'remote-A/openai',
                    user: 'sandbox@example.invalid',
                    readAt: '2026-11-11T00:00:00Z',
                    windows: [{ name: '7 days', used: 23 }],
                    api_key: 'must-not-reach-browser'
                }
            ]
        };
    throw new Error('Sandbox acceptance must never contact a gateway');
};
const handler = make_handler(service, web);
const requests = [];
const sandboxMockTaskId = '0'.repeat(32);
const backend = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
        const entry = {
            path: new URL(request.url).pathname,
            method: request.method,
            origin: request.headers.get('origin'),
            authenticated: request.headers.get('x-mini-bench-token') === token
        };
        requests.push(entry);
        // No paid or mutating request can reach the production handler in this acceptance test.
        // Intercept POST /api/bench/tasks here so we can verify sandboxed submission without starting a real run.
        if (request.method === 'POST' && entry.path === '/api/bench/tasks' && entry.authenticated) {
            entry.body = await request.json();
            entry.status = 202;
            entry.allowOrigin = 'null';
            return Response.json(
                { id: sandboxMockTaskId },
                { status: 202, headers: { 'access-control-allow-origin': 'null', vary: 'Origin' } }
            );
        }
        if (request.method === 'GET' && entry.path === `/api/bench/tasks/${sandboxMockTaskId}` && entry.authenticated) {
            entry.status = 200;
            entry.allowOrigin = 'null';
            return Response.json(
                {
                    id: sandboxMockTaskId,
                    status: 'completed',
                    created_at: '2026-11-11T00:00:00Z',
                    updated_at: '2026-11-11T00:00:00Z',
                    plan: { bank_version: '1.0', rounds: 3, targets: [], limits: seededLimits },
                    children: []
                },
                { status: 200, headers: { 'access-control-allow-origin': 'null', vary: 'Origin' } }
            );
        }
        if (!['GET', 'OPTIONS'].includes(request.method)) return new Response('Mutations disabled by acceptance harness', { status: 405 });
        const response = await handler(request);
        entry.status = response.status;
        entry.allowOrigin = response.headers.get('access-control-allow-origin');
        return response;
    }
});
const backendUrl = `http://127.0.0.1:${backend.port}`;
const host = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
        return new Response(
            `<!doctype html><html><body style="margin:0"><iframe title="Magpie sandbox" sandbox="allow-scripts" src="${backendUrl}/#token=${token}" style="border:0;width:100vw;height:100vh"></iframe></body></html>`,
            { headers: { 'content-type': 'text/html' } }
        );
    }
});
const session = `sandbox-regression-${Date.now()}`;
const scriptPath = join(artifacts, 'check.js');
writeFileSync(
    scriptPath,
    `async page => {
 page.setDefaultTimeout(8000);
 const errors=[],consoleErrors=[],failures=[];
 page.on('pageerror',error=>errors.push(String(error)));
 page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 page.on('requestfailed',request=>failures.push({url:request.url(),error:request.failure()?.errorText}));
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(${JSON.stringify(`http://127.0.0.1:${host.port}`)});
 const frame=page.frames().find(frame=>frame.url().startsWith(${JSON.stringify(backendUrl)}));
 if(!frame)throw Error('Sandbox frame not found');
 let readyError=null;
 try { await frame.locator('#analysis-picker .af-search').waitFor({timeout:8000}); await frame.locator('.score-cost-point').first().waitFor({timeout:8000}); } catch(error){readyError=String(error);}
 const state=await frame.evaluate(()=>{
  let storageDenied=false;try{localStorage.getItem('opaque-origin-test');}catch(error){storageDenied=error.name==='SecurityError';}
  return {origin:self.origin,storageDenied,inlinePicker:document.querySelectorAll('#task-picker .dp-popup.dp-inline').length,pickers:document.querySelectorAll('#task-picker .dp-popup.dp-inline:not([hidden])').length,triggerCount:document.querySelectorAll('#task-picker .dp-trigger').length,analysisFilters:document.querySelectorAll('#analysis-picker details.af-facet').length,chart:!!document.querySelector('#score-cost-chart svg'),points:document.querySelectorAll('.score-cost-point').length,bank:document.querySelector('#bench-bank-label')?.textContent,connection:document.querySelector('#connection-status')?.textContent,title:document.title};
 });
 const legendState={inline:await frame.locator('.chart-legend').isVisible(),singleGroup:await frame.locator('.chart-legend-item').count()===1,collapsed:await frame.locator('.chart-legend-disclosure').getAttribute('open')===null,searchHidden:await frame.locator('.chart-legend input').isHidden()};
 await frame.locator('.chart-legend-item').focus();legendState.highlight=await frame.locator('.score-cost-point[data-legend-highlight="true"]').count()===state.points;
 await frame.locator('#analysis-picker .af-search').focus();legendState.restores=await frame.locator('.score-cost-point[opacity="1"]').count()===state.points;
 const svg=await frame.evaluate(async()=>{try{const response=await fetch('./icons/download.svg');return {ok:response.ok,svg:(await response.text()).includes('<svg')};}catch(error){return {ok:false,error:String(error)};}});
 const analysisState={initialCollapsed:await frame.locator('#analysis-results').isHidden()&&await frame.locator('#analysis-excluded').isHidden()};
 await frame.locator('#analysis-picker .af-search').fill('no-sandbox-match');analysisState.searchFilters=await frame.locator('.score-cost-point').count()===0;
 await frame.locator('#analysis-reset').click();analysisState.resetRestores=await frame.locator('.score-cost-point').count()===state.points;
 await frame.locator('#analysis-result-count').click();analysisState.resultsOpen=await frame.locator('#analysis-results').isVisible();
 analysisState.resultCount=await frame.locator('#analysis-results [data-inspect-observation]').count()===state.points;
 // Keyboard activation avoids opaque-iframe pointer coordinate drift after nested scrolling.
 await frame.locator('#close-analysis-results').focus();analysisState.closeFocus=await frame.locator('#close-analysis-results').evaluate(node=>node===document.activeElement);await frame.locator('#close-analysis-results').press('Enter');await frame.locator('#analysis-results').waitFor({state:'hidden'});analysisState.focusRestored=await frame.locator('#analysis-result-count').evaluate(node=>node===document.activeElement);analysisState.resultsClose=await frame.locator('#analysis-results').isHidden();
 await frame.locator('#bench-version-trigger').click();
 await frame.locator('#bench-version-menu [data-bank-version="1.0"]').click();
 const switched10={points:await frame.locator('.score-cost-point').count()===1,summary:(await frame.locator('#dataset-summary').innerText()).includes('Mini Bench 1.0')};
 await frame.locator('#bench-version-trigger').click();
 await frame.locator('#bench-version-menu [data-bank-version="2.0"]').click();
 const switched20={points:await frame.locator('.score-cost-point').count()===1,summary:(await frame.locator('#dataset-summary').innerText()).includes('Mini Bench 2.0')};
 await frame.locator('[data-view-link="runs"]').click();
 const popup=frame.locator('#task-picker .dp-popup.dp-inline:not([hidden])');
 await popup.waitFor({state:'visible'});
 const ids=await popup.locator('.dp-rail-item').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.providerId,label:node.querySelector('.dp-rail-name')?.textContent})));
 const remoteState={twoInstances:['remote-A','remote-B'].every(owner=>ids.some(node=>node.id===JSON.stringify([owner,'openai']))),neutralIcon:await popup.locator('img').count()===0,auto:ids.some(node=>node.label==='remote-A / auto（自动路由）'),group:ids.some(node=>node.label==='remote-A / group（路由组）'),ordinary:ids.some(node=>node.label==='ordinary-owner'),ordinaryNotExpanded:!ids.some(node=>node.label==='ordinary-owner / openai'),nonChatExcluded:!ids.some(node=>node.label.includes('excluded-')),oneSearch:await popup.locator('input[type="search"]').count()===1};
 await popup.locator('.dp-rail-item').evaluateAll((nodes,id)=>nodes.find(n=>n.dataset.providerId===id)?.click(),JSON.stringify(['remote-A','openai']));remoteState.exactModel=await popup.locator('.dp-think[data-think="high"]').getAttribute('data-model')==='remote-A/openai/exact/model-v1';remoteState.accountUnknown=(await popup.locator('.dp-acc-static-value').innerText()).includes('网关自动分配')&&(await popup.locator('.dp-acc-static-value').innerText()).includes('实际账号未记录');
 remoteState.noQuotaCards=await popup.locator('.dp-quota-cards, .dp-quota-card').count()===0;
 remoteState.identityOnly=!(await popup.innerText()).includes('账号与额度');
 const quotaPayload=await frame.evaluate(()=>window.MiniBench.request('./api/bench/quota-cards'));
 remoteState.quotaSanitized=quotaPayload.status==='available'&&quotaPayload.cards.length===1&&!JSON.stringify(quotaPayload).includes('must-not-reach-browser');
 await page.screenshot({path:${JSON.stringify(join(artifacts, 'sandbox-remote-picker.png'))},fullPage:true});
 const taskState=await frame.evaluate(()=>({configCollapsed:!document.querySelector('#run-config-disclosure')?.open,sampleConcurrency:document.querySelector('#sample-concurrency')?.value,runConcurrency:document.querySelector('#run-concurrency')?.value,rounds:document.querySelector('#run-rounds')?.value,planDisabled:!document.querySelector('#bench-plan'),startDisabled:document.querySelector('#start-run')?.disabled,history:document.querySelector('#bench-run-list')?.textContent}));
 // Verify starting a task works inside sandbox="allow-scripts" (without allow-forms).
 await popup.locator('.dp-rail-item').evaluateAll((nodes,id)=>nodes.find(n=>n.dataset.providerId===id)?.click(),JSON.stringify(['remote-A','openai']));
 await popup.locator('.dp-think[data-think="high"]').click();
 const startEnabledAfterSelect=!(await frame.locator('#start-run').isDisabled());
 await frame.locator('#start-run').click();
 await frame.waitForFunction(()=>document.querySelector('#start-run')?.disabled===true&&window.MiniBench.runState.getSelectedTargets().length===0);
 const sandboxSubmit={startEnabledAfterSelect,clearedAfterSubmit:await frame.evaluate(()=>window.MiniBench.runState.getSelectedTargets().length===0)};
 await frame.locator('#mask-accounts').click();
 const maskedPressed=await frame.locator('#mask-accounts').getAttribute('aria-pressed')==='true'&&await frame.evaluate(()=>document.body.classList.contains('masked'));
 await frame.locator('#mask-accounts').click();
 const maskedRestored=await frame.locator('#mask-accounts').getAttribute('aria-pressed')==='false'&&await frame.evaluate(()=>!document.body.classList.contains('masked'));
 const sandboxMask={maskedPressed,maskedRestored};
 await page.screenshot({path:${JSON.stringify(join(artifacts, 'sandbox.png'))},fullPage:true});
 return {passed:state.origin==='null'&&state.storageDenied&&state.inlinePicker===1&&state.pickers===1&&state.triggerCount===0&&state.analysisFilters===5&&Object.values(legendState).every(Boolean)&&Object.values(analysisState).every(Boolean)&&Object.values(switched10).every(Boolean)&&Object.values(switched20).every(Boolean)&&state.chart&&state.points===1&&state.bank.includes('Mini Bench 2.0')&&state.bank.includes('12')&&svg.ok&&svg.svg&&taskState.configCollapsed&&taskState.sampleConcurrency==='6'&&taskState.runConcurrency==='3'&&taskState.rounds==='3'&&taskState.planDisabled&&taskState.startDisabled&&Object.values(remoteState).every(Boolean)&&Object.values(sandboxSubmit).every(Boolean)&&Object.values(sandboxMask).every(Boolean)&&!errors.length&&!consoleErrors.length&&!failures.length,state,switched10,switched20,legendState,analysisState,taskState,remoteState,sandboxSubmit,sandboxMask,svg,readyError,errors,consoleErrors,failures};
}`
);
let opened = false;
try {
    await exec('playwright-cli', [`-s=${session}`, 'open', 'about:blank'], { cwd: artifacts, timeout: 15000 });
    opened = true;
    const { stdout } = await exec('playwright-cli', ['--raw', `-s=${session}`, 'run-code', `--filename=${scriptPath}`], {
        cwd: artifacts,
        timeout: 30000,
        maxBuffer: 1024 * 1024
    });
    writeFileSync(join(artifacts, 'result.txt'), stdout);
    writeFileSync(join(artifacts, 'http-requests.json'), JSON.stringify(requests, null, 2));
    console.log(stdout);
    assert(
        requests.every(
            request => ['GET', 'OPTIONS'].includes(request.method) || (request.method === 'POST' && request.path === '/api/bench/tasks')
        ),
        'Unexpected mutation attempted'
    );
    assert(
        requests.some(
            request =>
                request.path === '/api/bench/tasks' &&
                request.method === 'POST' &&
                request.origin === 'null' &&
                request.authenticated &&
                request.status === 202 &&
                request.body?.bank_version === '2.0' &&
                Array.isArray(request.body?.targets) &&
                request.body.targets.length === 1 &&
                typeof request.body.targets[0].route_id === 'string' &&
                request.body.targets[0].route_id.startsWith('gateway-') &&
                request.body.targets[0].thinking === 'high'
        ),
        'Sandboxed task submission did not reach backend without allow-forms'
    );
    assert(
        requests.some(
            request => request.path.startsWith('/api/') && request.method === 'GET' && request.authenticated && request.status === 200
        ),
        'No real authenticated API GET'
    );
    for (const path of ['/api/bench/tasks', '/api/bench/runs']) {
        assert(
            requests.some(
                request =>
                    request.path === path &&
                    request.method === 'GET' &&
                    request.origin === 'null' &&
                    request.authenticated &&
                    request.status === 200 &&
                    request.allowOrigin === 'null'
            ),
            `Missing real opaque-origin history GET: ${path}`
        );
    }
    for (const modulePath of ['/chart-legend.js', '/account-mask.js']) {
        assert(
            requests.some(
                request =>
                    request.path === modulePath &&
                    request.method === 'GET' &&
                    request.origin === 'null' &&
                    request.status === 200 &&
                    request.allowOrigin === 'null'
            ),
            `Module did not load through real opaque-origin CORS: ${modulePath}`
        );
    }
    assert(
        requests.some(request => request.method === 'OPTIONS' && request.origin === 'null' && request.status === 204),
        'Opaque-origin preflight absent'
    );
    assert.match(stdout, /"passed":\s*true/, 'Real sandbox browser regression failed (see saved CORS diagnostics)');
} finally {
    if (opened) await exec('playwright-cli', [`-s=${session}`, 'close'], { cwd: artifacts, timeout: 10000 }).catch(() => {});
    host.stop(true);
    backend.stop(true);
    await service.close();
    if (previousRoutes === undefined) delete process.env.MAGPIE_BENCH_ROUTES_FILE;
    else process.env.MAGPIE_BENCH_ROUTES_FILE = previousRoutes;
    console.log(`Sandbox evidence: ${artifacts}`);
}
