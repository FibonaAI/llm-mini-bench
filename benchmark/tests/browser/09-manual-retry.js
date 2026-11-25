  await page.locator('#bench-retry-run').click();await page.locator('#bench-retry-run').waitFor({state:'hidden'});
  await page.locator('#bench-run-detail .sample-all > summary').click();
  const retriedSample=page.locator('#bench-run-detail [data-sample-id="retry-sample-0"]');
  await retriedSample.locator('summary').first().click();
  await retriedSample.locator('.raw-block').filter({has:page.locator('summary').filter({hasText:'原始回答'})}).locator('summary').click();
  await page.waitForFunction(()=>document.querySelector('[data-sample-id="retry-sample-0"]').textContent.includes('retried answer'));
  require(retryRun.status==='completed'&&retryRun.samples[1].response==='saved legacy response','Retry overwrote a successful sample');
  require(await page.locator('#bench-retry-run').isHidden(),'Completed retry remains retryable');
  {
    const laneEmails=['LeanderMosbrucker7482@outlook.com','skeptic000@gmx.com','SunshineSumnicht01551@outlook.com','andrevelo87@gmx.com','gop7678@gmx.com','staharf1@gmx.com','OsbaldoOsoy734933@outlook.com'];
    const mkLaneChild=(id,model,display,acc,think,status,done)=>({run_id:id,status,bank_version:'1.0',target:{provider_id:'chatgpt-api',provider_name:'chatgpt-api',model:'chatgpt-api/'+model,model_display_name:display,route_id:'r-'+id,account_ref:acc,account_evidence:'gateway_account_binding',thinking:think},sample_count:36,sample_status_counts:status==='completed'?{completed:36}:status==='running'?{completed:done,running:2,pending:34-done}:{pending:36},retryable_samples:0,budget:{estimated_uncached_cost_usd:status==='queued'?0:1.25}});
    const laneChildren=[
      ...laneEmails.map((acc,i)=>mkLaneChild('lane-m-'+i,'gpt-6-astra','GPT-6-Astra',acc,'medium',i<4?'completed':i<6?'running':'queued',i===4?35:2)),
      mkLaneChild('lane-h-0','gpt-6.2-astra','GPT-6.2-Astra',laneEmails[0],'high','completed',36),
      mkLaneChild('lane-h-1','gpt-6.2-astra','GPT-6.2-Astra',laneEmails[1],'high','running',24),
      mkLaneChild('lane-l-0','gpt-6.2-astra','GPT-6.2-Astra',laneEmails[0],'low','completed',36),
      mkLaneChild('lane-l-1','gpt-6.2-astra','GPT-6.2-Astra',laneEmails[1],'low','completed',36)
    ];
    taskRecords.push({id:'lanes-task-67068e800e9142478343bd30c4395a36',status:'running',bank_version:'1.0',created_at:'2026-11-23T06:02:49Z',plan:{bank_version:'1.0',targets:laneChildren.map(c=>c.target),rounds:3,sample_concurrency:6,run_concurrency:3,run_count:laneChildren.length,samples_per_run:36,sample_count:laneChildren.length*36,limits:{timeout:600,timeout_scope:'sample',max_cost_usd:null}},children:laneChildren});
    runs.push({id:'lane-m-0',task_id:'lanes-task-67068e800e9142478343bd30c4395a36',bank_version:'1.0',status:'completed',plan:{bank_version:'1.0',targets:[laneChildren[0].target],limits:{timeout:600}},budget:{requests:36,estimated_uncached_cost_usd:1.25},samples:BANK.tasks.flatMap(t=>[1,2,3].map(r=>({sample_id:'lm0-'+t.id+'-'+r,task:t.id,round:r,thinking:'medium',status:'completed',grade:{content_score:1,outcome:'ok'},usage:{input_tokens:100,output_tokens:200},estimated_uncached_cost_usd:0.03})))});
    await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));
    const laneCard=page.locator('[data-bench-task-id="lanes-task-67068e800e9142478343bd30c4395a36"]');
    await laneCard.waitFor({state:'visible'});
    const badgeCodes=await laneCard.locator('.task-thinking-badge .task-thinking-code').allInnerTexts();
    require(badgeCodes.join(',')==='low,medium,high','Outer card thinking badge must sort efforts canonically: '+badgeCodes.join(','));
    await laneCard.click();await page.locator('#bench-task-detail .task-thinking-lane[data-thinking-lane="medium"]').waitFor({state:'visible'});
    const laneOrder=await page.locator('#bench-task-detail .task-preview-group').nth(1).locator('.task-thinking-lane').evaluateAll(nodes=>nodes.map(n=>n.dataset.thinkingLane));
    require(laneOrder.join(',')==='low,high','Model thinking lanes must sort low before high: '+laneOrder.join(','));
    await page.locator('#bench-task-detail [data-preview-run-id="lane-m-0"]').click();
    await page.locator('#bench-run-detail .run-target-banner .run-thinking-pill').waitFor({state:'visible'});
    require((await page.locator('#bench-run-detail .run-target-banner .run-thinking-pill').innerText()).includes('medium'),'Run banner must surface medium thinking');
    const desktopLaneGeo=await page.locator('#bench-task-detail .task-thinking-lane[data-thinking-lane="medium"]').evaluate(lane=>{const rail=lane.querySelector('.task-thinking-rail').getBoundingClientRect(),chips=lane.querySelector('.task-preview-runs').getBoundingClientRect();return {railRight:Math.round(rail.right),chipsLeft:Math.round(chips.left),railTop:Math.round(rail.top),chipsTop:Math.round(chips.top)};});
    require(desktopLaneGeo.railRight<=desktopLaneGeo.chipsLeft&&Math.abs(desktopLaneGeo.railTop-desktopLaneGeo.chipsTop)<=6,'Desktop thinking rail must sit cleanly to the left of account chips: '+JSON.stringify(desktopLaneGeo));
    await page.locator('.history-entry.is-expanded').screenshot({path:ARTIFACTS+'/thinking-lanes-1440-light.png'});
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
    await page.locator('.history-entry.is-expanded').screenshot({path:ARTIFACTS+'/thinking-lanes-1440-dark.png'});
    let mobileLaneGeo=null;
    for(const width of [390,320]){
      await page.setViewportSize({width,height:900});await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
      require(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Thinking lanes overflow at '+width);
      if(width===390){
        mobileLaneGeo=await page.locator('#bench-task-detail .task-thinking-lane[data-thinking-lane="medium"]').evaluate(lane=>{const rail=lane.querySelector('.task-thinking-rail').getBoundingClientRect(),chips=lane.querySelector('.task-preview-runs').getBoundingClientRect();return {railBottom:Math.round(rail.bottom),chipsTop:Math.round(chips.top),railLeft:Math.round(rail.left),chipsLeft:Math.round(chips.left)};});
        require(mobileLaneGeo.railBottom<=mobileLaneGeo.chipsTop&&mobileLaneGeo.railLeft===mobileLaneGeo.chipsLeft,'Mobile thinking rail must stack cleanly above account chips: '+JSON.stringify(mobileLaneGeo));
        await page.locator('.history-entry.is-expanded').screenshot({path:ARTIFACTS+'/thinking-lanes-390-light.png'});
      }
    }
    thinkingLaneGeometry={desktop1440:desktopLaneGeo,mobile390:mobileLaneGeo};
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#bench-close-task').click();
    taskRecords.pop();runs.pop();
    const afterLaneRefresh=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bench/tasks');
    await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));await afterLaneRefresh;
  }
  {
    const baseTaskId='baseline-ui-task-0123456789abcdef0123';
    const baseChildren=[
      {run_id:'b-ref-hi',target:{id:'bt-1',provider_id:'openai-official',model:'gpt-5.4',thinking:'high',account_ref:'gateway-default'},status:'completed',sample_count:36,sample_status_counts:{completed:36},baseline_eligible:true,ineligibility_reason:null,baseline_id:null},
      {run_id:'b-ref-med',target:{id:'bt-2',provider_id:'openai-official',model:'gpt-5.4',thinking:'medium',account_ref:'gateway-default'},status:'completed',sample_count:36,sample_status_counts:{completed:36},baseline_eligible:true,ineligibility_reason:null,baseline_id:null},
      {run_id:'b-ref-fail',target:{id:'bt-5',provider_id:'openai-official',model:'gpt-5.4-mini',thinking:'high',account_ref:'gateway-default'},status:'failed',sample_count:36,sample_status_counts:{completed:30,api_failure:6},baseline_eligible:false,ineligibility_reason:'Assessment baseline: run must be completed',baseline_id:null},
      {run_id:'b-rel-hi',target:{id:'bt-3',provider_id:'third-relay',model:'gpt-5.4',thinking:'high',account_ref:'gateway-default'},status:'completed',sample_count:36,sample_status_counts:{completed:36},baseline_eligible:true,ineligibility_reason:null,baseline_id:null},
      {run_id:'b-rel-to',target:{id:'bt-4',provider_id:'third-relay',model:'gpt-5.4',thinking:'low',account_ref:'gateway-default'},status:'completed',sample_count:36,sample_status_counts:{completed:35,timeout:1},baseline_eligible:false,ineligibility_reason:'Assessment baseline: failed or incomplete samples are not scores',baseline_id:null}
    ];
    // Abnormal parent task (status=failed) still allows promoting healthy models/channels, while keeping chips clean.
    taskRecords.unshift({id:baseTaskId,status:'failed',created_at:'2026-11-24T12:00:00Z',plan:{bank_version:'1.0',targets:baseChildren.map(c=>c.target),rounds:3,sample_concurrency:6,run_concurrency:3,run_count:5,samples_per_run:36,sample_count:180,limits:{timeout:600,timeout_scope:'sample',max_cost_usd:null}},children:baseChildren});
    for(const child of baseChildren){
      runs.push({id:child.run_id,task_id:baseTaskId,bank_version:'1.0',status:child.status,updated_at:'2026-11-24T12:05:00Z',sample_count:36,sample_status_counts:child.sample_status_counts,baseline_eligible:child.baseline_eligible,ineligibility_reason:child.ineligibility_reason,baseline_id:null,plan:{bank_version:'1.0',targets:[child.target],limits:{timeout:600}},budget:{requests:36,estimated_uncached_cost_usd:0.5},samples:BANK.tasks.flatMap((t,ti)=>[1,2,3].map(r=>({sample_id:child.run_id+'-'+t.id+'-'+r,task:t.id,round:r,thinking:child.target.thinking,status:child.run_id==='b-rel-to'&&ti===0&&r===1?'timeout':child.run_id==='b-ref-fail'&&ti<2?'api_failure':'completed',grade:child.run_id==='b-rel-to'&&ti===0&&r===1?{content_score:0,outcome:'timeout'}:child.run_id==='b-ref-fail'&&ti<2?null:{content_score:0.9,outcome:'ok'}})))});
    }
    const baseTaskLoaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bench/tasks');
    await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));await baseTaskLoaded;
    const baseCard=page.locator('[data-bench-task-id="'+baseTaskId+'"]');
    await baseCard.click();await page.locator('#bench-baseline-task').waitFor({state:'visible'});
    require((await page.locator('#bench-baseline-task').innerText()).includes('设为基线 (3)')&&await page.locator('#bench-unbaseline-task').isHidden(),'Abnormal task header must still count 3 eligible runs');
    require(await page.locator('#bench-task-detail .task-chip-baseline').count()===0,'Thinking chips must stay clean without inline baseline buttons');
    require(await page.locator('#bench-task-detail [data-baseline-level="model"]').count()===1,'Only promotable models in multi-model pods should show a model-level baseline button');
    // Model-level promotion marks healthy openai-official gpt-5.4 runs as baselines; failed sibling model stays clean.
    await page.locator('#bench-task-detail [data-baseline-level="model"][data-baseline-promote-runs="b-ref-hi,b-ref-med"]').click();
    await page.waitForFunction(()=>document.querySelector('#bench-unbaseline-task')&&!document.querySelector('#bench-unbaseline-task').hidden);
    require((await page.locator('.history-entry.is-expanded .task-count-pill.is-baseline').innerText()).includes('基线 2'),'Outer task pill must show 2 baselines');
    require((await page.locator('#bench-baseline-task').innerText()).includes('设为基线 (1)')&&(await page.locator('#bench-unbaseline-task').innerText()).includes('取消基线 (2)'),'Partial model promotion did not update task header counts');
    require(await page.locator('#bench-task-detail .task-preview-chip.is-baseline').count()===2,'Promoted preview chips must carry .is-baseline');
    require(await page.locator('#bench-task-detail .task-preview-chip.is-baseline .task-preview-chip-baseline .task-baseline-sq').count()===2,'Promoted preview chips must render leading baseline square');
    require((await page.locator('#bench-task-detail .task-preview-chip.is-baseline .task-preview-chip-state').first().innerText()).includes('✓ 完成'),'Promoted preview chips must preserve completed state text');
    // Expanding a single thinking chip lets the user promote/demote that run from the run detail header.
    await page.locator('#bench-task-detail [data-preview-run-id="b-rel-hi"]').click();
    await page.locator('#bench-baseline-run').waitFor({state:'visible'});
    await page.locator('#bench-baseline-run').click();
    await page.locator('#bench-unbaseline-run').waitFor({state:'visible'});
    require(await page.locator('#bench-run-detail .run-baseline-pill').isVisible(),'Promoted run detail must surface baseline pill');
    require((await page.locator('.history-entry.is-expanded .task-count-pill.is-baseline').innerText()).includes('基线 3'),'Single run promotion did not increment baseline count');
    await page.locator('#bench-unbaseline-run').click();
    await page.locator('#bench-baseline-run').waitFor({state:'visible'});
    require((await page.locator('.history-entry.is-expanded .task-count-pill.is-baseline').innerText()).includes('基线 2'),'Single run demotion did not decrement baseline count');
    // Channel-level promotion marks remaining healthy run in third-relay while skipping timed-out sibling.
    await page.locator('#bench-task-detail [data-baseline-level="channel"][data-baseline-promote-runs="b-rel-hi"]').click();
    await page.waitForFunction(()=>(document.querySelector('.history-entry.is-expanded .task-count-pill.is-baseline')?.textContent||'').includes('基线 3'));
    // Completed ineligible run keeps visible aria-disabled baseline button in run detail header and explains why.
    await page.locator('#bench-task-detail [data-preview-run-id="b-rel-to"]').click();
    await page.waitForFunction(()=>document.querySelector('#bench-run-detail').textContent.includes('不可设为基线：含 1 个超时样本'));
    require(await page.locator('#bench-baseline-run').isVisible()&&(await page.locator('#bench-baseline-run').getAttribute('aria-disabled'))==='true'&&await page.locator('#bench-unbaseline-run').isHidden(),'Timed-out run must show aria-disabled baseline button with reason');
    await page.locator('#bench-baseline-run').click({force:true});
    await page.locator('#baseline-reason-popover').waitFor({state:'visible'});
    require((await page.locator('#baseline-reason-popover').innerText()).includes('含 1 个超时样本'),'Run ineligible button click must surface timeout reason');
    await page.locator('.history-entry.is-expanded').screenshot({path:ARTIFACTS+'/baseline-ineligible-run.png'});
    await page.keyboard.press('Escape');
    await page.locator('#baseline-reason-popover').waitFor({state:'hidden'});
    await page.setViewportSize({width:320,height:740});
    require(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Baseline actions overflow 320px viewport');
    await page.setViewportSize({width:1440,height:1000});
    // Task-level batch cancellation removes all 3 baselines while keeping run records.
    await page.locator('#bench-unbaseline-task').click();
    await page.waitForFunction(()=>document.querySelector('#bench-unbaseline-task').hidden);
    require(await page.locator('.history-entry.is-expanded .task-count-pill.is-baseline').count()===0&&(await page.locator('#bench-baseline-task').innerText()).includes('设为基线 (3)'),'Task batch unbaseline did not restore initial state');
    await page.locator('#bench-close-task').click();
    taskRecords.shift();
    runs.splice(runs.length-5,5);
    observations=observations.filter(row=>!String(row.id).startsWith('baseline-b-'));
    const cleanBaseRefresh=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bench/tasks');
    await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));await cleanBaseRefresh;
  }
  observations.splice(0,observations.length,...[[1,1],[10,.5],[10.1,.6]].map(([cost,score],i)=>({...peer,id:'zoom-'+i,model:'zoom-model-'+i,model_display_name:'Zoom model '+i,estimated_cost_usd:cost*3,usage:{input_tokens:cost*1000,output_tokens:0},tasks:tasks.map(task=>({...task,samples:task.samples.map(sample=>({...sample,content_score:score}))}))})));
