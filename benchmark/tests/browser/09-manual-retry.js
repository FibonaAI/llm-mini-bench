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
  observations.splice(0,observations.length,...[[1,1],[10,.5],[10.1,.6]].map(([cost,score],i)=>({...peer,id:'zoom-'+i,model:'zoom-model-'+i,model_display_name:'Zoom model '+i,estimated_cost_usd:cost*3,usage:{input_tokens:cost*1000,output_tokens:0},tasks:tasks.map(task=>({...task,samples:task.samples.map(sample=>({...sample,content_score:score}))}))})));
