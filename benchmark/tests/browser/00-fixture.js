  page.setDefaultTimeout(8000);
  const staticFiles=STATIC_FILES, bank=BANK;
  const errors=[],requests=[],posts=[];
  const require=(condition,message)=>{if(!condition)throw Error(message)};
  const tasks=bank.tasks.map(task=>({task_id:task.id,title:task.title,domain:task.domain,samples:[1,2,3].map(round=>({round,status:'completed',content_score:.8,instruction_checks:{format:true},outcome:null}))}));
  const baseline={id:'baseline-fixture',source:'baseline',run_id:'baseline-run',target_id:'fixture',label:'same-model',model:'same-model',thinking:'high',route_id:'route-0',provider_id:'chatgpt-main',provider_evidence:'gateway_catalog',account_ref:'gateway-default',account_evidence:'gateway_binding',bank_version:'1.0',bank_scope:'whole',sample_count:36,task_sha256:bank.task_sha256,source_sha256:bank.source_sha256,assessment_protocol_sha256:'a'.repeat(64),rounds:3,status:'completed',baseline_eligible:true,tasks,created_at:'2026-11-11T00:00:00Z',usage:{input_tokens:420,output_tokens:840},estimated_cost_usd:.06};
  const peer={...baseline,id:'peer',source:'run',run_id:'peer-run',target_id:'peer-target',provider_id:'chatgpt-lab',route_id:'route-1',thinking:'low',estimated_cost_usd:.12};
  const legacyRun={id:'peer-run',status:'completed',created_at:'2026-11-10T01:00:00Z',plan:{bank_version:'1.0',rounds:3,targets:[{id:'peer-target',route_id:'route-1',model:'same-model',thinking:'low'}]},sample_count:36,sample_status_counts:{completed:36},samples:[{sample_id:'legacy-sample',task:bank.tasks[0].id,target_id:'peer-target',round:1,thinking:'low',status:'completed',response:'saved legacy response',grade:{content_score:.8}}],budget:{}};
  let observations=[baseline,peer],runs=[legacyRun],taskRecords=[],plan,failObservations=false,timeoutNextSubmit=false,runResponseGate=null,thinkingLaneGeometry=null;
  const routes=['chatgpt-main','chatgpt-lab',...Array.from({length:5},(_,i)=>'fixture-provider-'+(i+2))].map((provider_id,i)=>({id:'route-'+i,provider_id,provider_evidence:'gateway_catalog',label:'same-model',model:'same-model',account_ref:'gateway-default',account_evidence:'gateway_binding',pricing:{prompt:.000001,completion:.000002},thinking_levels:['high','low']}));
  const remoteRoutes=[['remote-A','openai'],['remote-B','openai'],['remote-A','auto'],['remote-A','group']].map(([provider_id,namespace])=>({...routes[0],id:provider_id+'-'+namespace,provider_id,model:provider_id+'/'+namespace+'/exact/model-v1',remote_route:{namespace,evidence:'magpie_via_catalog'}}));
  const ordinarySlashRoute={...routes[0],id:'ordinary-slash-route',provider_id:'ordinary-owner',model:'ordinary-owner/openai/not-a-remote'};
  routes.push(...remoteRoutes,ordinarySlashRoute);
  function createTaskRecord(body) {
    const id='mock-task-'+(taskRecords.length+1);
    const resolvedTargets=body.targets.map(target=>({...routes.find(route=>route.id===target.route_id),...target}));
    const taskPlan={...body,targets:resolvedTargets,run_count:body.targets.length,samples_per_run:12*body.rounds,sample_count:body.targets.length*12*body.rounds,total_max_cost_usd:body.limits.max_cost_usd*body.targets.length};
    const childRuns=resolvedTargets.map((target,index)=>({id:id+'-run-'+index,task_id:id,status:index===0?'completed':index<3?'running':'queued',created_at:'2026-11-11T01:00:00Z',plan:{bank_version:'1.0',targets:[target],rounds:body.rounds,concurrency:body.sample_concurrency,limits:body.limits},sample_count:12*body.rounds,sample_status_counts:index===0?{completed:12*body.rounds}:index<3?{pending:12*body.rounds-1,running:1}:{pending:12*body.rounds},samples:Array.from({length:12*body.rounds},(_,sampleIndex)=>({sample_id:id+'-sample-'+index+'-'+sampleIndex,task:bank.tasks[sampleIndex%12].id,target_id:target.id,round:Math.floor(sampleIndex/12)+1,thinking:target.thinking,status:index===0?'completed':index<3&&sampleIndex===0?'running':'pending',account_ref:'gateway-default',tool_trace:[{name:'fixed_simulator'}],response:'saved response '+index,grade:index===0?{content_score:.8}:null})),budget:{max_cost_usd:body.limits.max_cost_usd}}));
    const completed=childRuns[0];
    completed.samples.forEach(sample=>Object.assign(sample,{usage:{input_tokens:1,output_tokens:2},estimated_uncached_cost_usd:.000005}));
    Object.assign(completed.samples[0],{grade:{content_score:null,outcome:'ambiguous'},response:'{"answer":1} explanation {invalid}'});
    Object.assign(completed.samples[1],{grade:{content_score:0,outcome:'ok'},usage:null,estimated_uncached_cost_usd:null,latest_attempt_usage:{input_tokens:3,output_tokens:4},latest_attempt_cost_usd:.01,attempts:[{status:'api_failure',usage:null,estimated_uncached_cost_usd:null}]});
    completed.result_quality={completed_samples:36,unscored_samples:1,unknown_usage_samples:1,unknown_cost_samples:1,prior_unknown_usage_samples:1,prior_unknown_cost_samples:1};
    const task={id,status:'running',created_at:'2026-11-11T01:00:00Z',updated_at:'2026-11-11T01:00:00Z',plan:taskPlan,children:childRuns.map(run=>({run_id:run.id,target:run.plan.targets[0],status:run.status,sample_count:run.sample_count,sample_status_counts:run.sample_status_counts,result_quality:run.result_quality,budget:run.budget}))};
    runs.push(...childRuns);taskRecords.push(task);return task;
  }
  function cancelChildRun(runId) {
    const run=runs.find(run=>run.id===runId);require(run,'Unknown child run '+runId);
    if(['queued','running','cancelling'].includes(run.status)){run.status='cancelled';run.samples.forEach(sample=>{if(['pending','running'].includes(sample.status))sample.status='cancelled';});run.sample_status_counts={cancelled:run.sample_count};}
    const task=taskRecords.find(task=>task.id===run.task_id),child=task?.children.find(child=>child.run_id===runId);
    if(child)Object.assign(child,{status:run.status,sample_status_counts:run.sample_status_counts});
    return run;
  }
  await page.addInitScript(()=>{window.browserWindowErrors=[];window.addEventListener('error',event=>window.browserWindowErrors.push({message:event.message,name:event.error?.name,file:event.filename,line:event.lineno}));window.addEventListener('unhandledrejection',event=>window.browserWindowErrors.push({rejection:String(event.reason)}));});
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;requests.push(path);
    require(url.hostname==='assessment-ui.invalid','Unexpected external URL '+url);
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(!path.startsWith('/api/')){const name=path==='/'?'index.html':path.slice(1);if(!(name in staticFiles))return route.abort();return route.fulfill({status:200,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html',body:staticFiles[name]});}
    require(request.headers()['x-mini-bench-token']==='offline-test-token','Missing mock auth');
    if(request.method()==='POST')posts.push({path,body:request.postData()?request.postDataJSON():null});
    if(path==='/api/bench/banks')return json({execution_policy:'sample-timeout-v1',banks:[bank]});
    if(path==='/api/bench/quota-cards')return json({status:'available',fetched_at:'2026-11-11T00:00:00Z',cards:['remote-A','remote-B'].map(provider=>({provider_path:provider+'/openai',user:provider+'@example.invalid',alias:null,read_at:'2026-11-11T00:00:00Z',windows:[{name:'7 days',used:23,resets_at:null}]}))});
    if(path==='/api/bench/routes')return json({routes});
    if(path==='/api/bench/observations')return failObservations?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'mock observation failure'})}):json({observations});
    if(path==='/api/bench/baselines')return json({baselines:[{...baseline,raw_calls:[{response:'saved raw evidence',source:'original provenance'}]}]});
    if(path==='/api/bench/task-plans')throw Error('UI requested a manual plan');
    if(path==='/api/bench/tasks'&&request.method()==='POST'){plan=request.postDataJSON();const task=createTaskRecord(plan);if(timeoutNextSubmit){timeoutNextSubmit=false;return route.abort('timedout');}return json({id:task.id});}
    if(path.startsWith('/api/bench/runs/')&&path.endsWith('/retry')){
      require(request.method()==='POST'&&/^[a-f0-9]{32}$/.test(request.postDataJSON().request_id),'Invalid retry identity');
      const run=runs.find(run=>run.id===path.split('/')[4]);require(run?.retryable_samples===1,'Retry offered for a non-API outcome');
      run.status='completed';run.retryable_samples=0;run.samples.forEach(sample=>{if(sample.status==='api_failure')Object.assign(sample,{status:'completed',response:'retried answer',grade:{content_score:1},attempts:[{status:'api_failure'}]});});
      return json({id:run.id});
    }
    if(path==='/api/bench/tasks')return json({tasks:taskRecords});
    const taskPath=path.match(/^\/api\/bench\/tasks\/([^/]+)(\/cancel)?$/);
    if(taskPath){const task=taskRecords.find(task=>task.id===taskPath[1]);require(task,'Unknown task '+path);if(taskPath[2]){task.children.forEach(child=>cancelChildRun(child.run_id));task.status='cancelled';}return json(task);}
    if(/^\/api\/bench\/runs\/[^/]+\/calls$/.test(path))return json({calls:[]});
    if(path==='/api/bench/runs')return json({runs:runs.map(({samples,...run})=>run)});
    const runPath=path.match(/^\/api\/bench\/runs\/([^/]+)(\/cancel)?$/);
    if(runPath){const run=runs.find(run=>run.id===runPath[1]);require(run,'Unknown run '+path);if(!runPath[2]&&runResponseGate?.id===run.id){runResponseGate.started();await runResponseGate.wait;}return json(runPath[2]?cancelChildRun(run.id):run);}
    if(path==='/api/bench/runs/eligible-run/baseline'){observations.push({...baseline,id:'promoted',target_id:'eligible-target'});return json({baseline:observations.at(-1)});}
    throw Error('Unexpected API '+path);
  });
  const point=id=>page.locator('.score-cost-point[data-record-id="'+id+'"]');
  const color=async id=>point(id).getAttribute('data-model-color');
  const refresh=async()=>{await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:observations-changed')));};
  const openData=async()=>{if(await page.locator('#analysis-data-panel').isHidden())await page.locator('#analysis-data-trigger').click();};
  const chooseData=async(mode,keepOpen=false)=>{await openData();await page.locator('#analysis-data-'+mode).check();if(!keepOpen)await page.locator('#close-analysis-data').click();};
  await page.setViewportSize({width:1440,height:1000});
