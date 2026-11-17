import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BenchService, make_handler } from '../backend/mini_bench.ts';
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
copyFileSync(
    fileURLToPath(new URL('../baselines/1e0617b82fc8b44f085d147ffd8c53a6998856050364ab6c4c3a8363a080372a.json', import.meta.url)),
    join(service.data_dir, 'assessment-baselines', 'fixture.json')
);
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
  return {origin:self.origin,storageDenied,pickers:document.querySelectorAll('.dp-trigger').length,analysisFilters:document.querySelectorAll('#analysis-picker details.af-facet').length,chart:!!document.querySelector('#score-cost-chart svg'),points:document.querySelectorAll('.score-cost-point').length,bank:document.querySelector('#bench-bank-label')?.textContent,connection:document.querySelector('#connection-status')?.textContent,title:document.title};
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
 await frame.locator('[data-view-link="runs"]').click();
 await frame.locator('#task-picker .dp-trigger').click();const popup=frame.locator('.dp-popup:not([hidden])');
 const ids=await popup.locator('.dp-provider-filter option').evaluateAll(nodes=>nodes.map(node=>({id:node.value,label:node.textContent})));
 const remoteState={twoInstances:['remote-A','remote-B'].every(owner=>ids.some(node=>node.id===JSON.stringify([owner,'openai']))),neutralIcon:await popup.locator('img').count()===0,auto:ids.some(node=>node.label==='remote-A / auto（自动路由）'),group:ids.some(node=>node.label==='remote-A / group（路由组）'),ordinary:ids.some(node=>node.label==='ordinary-owner'),ordinaryNotExpanded:!ids.some(node=>node.label==='ordinary-owner / openai'),nonChatExcluded:!ids.some(node=>node.label.includes('excluded-')),oneSearch:await popup.locator('input[type="search"]').count()===1};
 await popup.locator('.dp-provider-filter').selectOption(JSON.stringify(['remote-A','openai']));remoteState.exactModel=await popup.locator('.dp-think[data-think="default"]').getAttribute('data-model')==='remote-A/openai/exact/model-v1';remoteState.accountUnknown=(await popup.locator('.dp-route').innerText()).includes('网关自动分配')&&(await popup.locator('.dp-route').innerText()).includes('实际账号未记录');
 remoteState.noQuotaCards=await popup.locator('.dp-quota-cards, .dp-quota-card').count()===0;
 remoteState.identityOnly=!(await popup.innerText()).includes('账号与额度');
 const quotaPayload=await frame.evaluate(()=>window.MiniBench.request('./api/bench/quota-cards'));
 remoteState.quotaSanitized=quotaPayload.status==='available'&&quotaPayload.cards.length===1&&!JSON.stringify(quotaPayload).includes('must-not-reach-browser');
 await page.screenshot({path:${JSON.stringify(join(artifacts, 'sandbox-remote-picker.png'))},fullPage:true});try { await popup.getByRole('button',{name:'完成',exact:true}).click(); } catch(error) { const debug=await frame.evaluate(()=>({scrollY,innerHeight,hidden:document.querySelector('.dp-popup')?.hidden,trigger:document.querySelector('#task-picker .dp-trigger')?.getBoundingClientRect().toJSON(),popups:[...document.querySelectorAll('.dp-popup')].map(n=>({hidden:n.hidden,style:n.getAttribute('style')}))}));throw new Error('Picker geometry '+JSON.stringify(debug)+' parent '+JSON.stringify(await page.evaluate(()=>({scrollY,innerHeight})))+' '+error.message); }
 const taskState=await frame.evaluate(()=>({sampleConcurrency:document.querySelector('#sample-concurrency')?.value,runConcurrency:document.querySelector('#run-concurrency')?.value,rounds:document.querySelector('#run-rounds')?.value,planDisabled:!document.querySelector('#bench-plan'),startDisabled:document.querySelector('#start-run')?.disabled,history:document.querySelector('#bench-run-list')?.textContent}));
 await page.screenshot({path:${JSON.stringify(join(artifacts, 'sandbox.png'))},fullPage:true});
 return {passed:state.origin==='null'&&state.storageDenied&&state.pickers===1&&state.analysisFilters===3&&Object.values(legendState).every(Boolean)&&Object.values(analysisState).every(Boolean)&&state.chart&&state.points>0&&state.bank.includes('14')&&svg.ok&&svg.svg&&taskState.sampleConcurrency==='6'&&taskState.runConcurrency==='3'&&taskState.rounds==='3'&&taskState.planDisabled&&taskState.startDisabled&&Object.values(remoteState).every(Boolean)&&!errors.length&&!consoleErrors.length&&!failures.length,state,legendState,analysisState,taskState,remoteState,svg,readyError,errors,consoleErrors,failures};
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
        requests.every(request => ['GET', 'OPTIONS'].includes(request.method)),
        'Unexpected mutation attempted'
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
    assert(
        requests.some(
            request =>
                request.path === '/chart-legend.js' &&
                request.method === 'GET' &&
                request.origin === 'null' &&
                request.status === 200 &&
                request.allowOrigin === 'null'
        ),
        'Legend module did not load through real opaque-origin CORS'
    );
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
