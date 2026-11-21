  await page.locator('[data-view-link="analysis"]').click();await page.locator('#analysis-reset').click();await refresh();await point('zoom-0').waitFor();
  await point('zoom-1').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  for(const axis of ['cost','tokens']){
    await page.locator('#chart-reset').click();await page.locator('#chart-axis').selectOption(axis);
    await page.locator('#chart-zoom-in').evaluate(node=>{for(let i=0;i<10;i++)node.click();});
    require(await point('zoom-0').count()===0&&await page.locator('.score-cost-point').count()===2,'Zoom fixture must exclude the dominating point');
    const frontierMatches=await page.evaluate(()=>{const line=document.querySelector('.pareto-frontier');const actual=line.getAttribute('points').split(' ').slice(0,-1).map(pair=>pair.split(',').map(Number));const expected=[...document.querySelectorAll('.record-marker')].map(marker=>[Number(marker.getAttribute('cx')),Number(marker.getAttribute('cy'))]);return JSON.stringify(actual)===JSON.stringify(expected);});
    require(frontierMatches,'Pareto frontier includes an offscreen dominator on '+axis+' axis');
  }
  await page.locator('#chart-reset').click();await page.locator('#chart-axis').selectOption('cost');await page.locator('#close-inspector').click();
  observations.splice(0,observations.length,...['gpt-6-luna','GPT-6 Luna','gpt-6.1-sol','DeepSeek-V4','DeepSeek-V3.2'].map((model,i)=>({...peer,id:'color-'+i,provider_id:'color-channel-'+i,model,model_display_name:model,estimated_cost_usd:.03+i*.01})));
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-view-link="analysis"]').click();await page.locator('#analysis-reset').click();await refresh();
  await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length===5);
  const geometry=()=>page.locator('.record-marker').evaluateAll(nodes=>nodes.map(node=>[node.getAttribute('cx'),node.getAttribute('cy')]));
  const positions=await geometry();
  await page.locator('#chart-color-by').selectOption('model');
  require(await color('color-0')===await color('color-1')&&await color('color-0')!==await color('color-2'),'Model mode must merge channels, not distinct GPT variants');
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
    await page.locator('#chart-color-by').selectOption('family');
    require(await color('color-0')===await color('color-2')&&await color('color-3')===await color('color-4')&&await color('color-0')!==await color('color-3'),'Family grouping failed in '+(dark?'dark':'light')+' mode');
    require(JSON.stringify(await geometry())===JSON.stringify(positions),'Color mode moved or removed data points');
    require((await page.locator('#analysis-method').textContent()).includes('颜色区分模型系列'),'Methodology must describe active coloring');
    await page.locator('#chart-card').screenshot({path:ARTIFACTS+'/family-colors-'+(dark?'dark':'light')+'.png'});
    await page.locator('#chart-color-by').selectOption('model');
  }
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  observations.push(
    {...peer,id:'color-same-acct',provider_id:'color-channel-0',account_ref:'acct-a',account_evidence:'gateway_account_binding',model:'gpt-6.1-sol',model_display_name:'gpt-6.1-sol',estimated_cost_usd:.085},
    {...peer,id:'color-same-acct-m2',provider_id:'color-channel-0',account_ref:'acct-a',account_evidence:'gateway_account_binding',model:'DeepSeek-V4',model_display_name:'DeepSeek-V4',estimated_cost_usd:.09},
    {...peer,id:'color-other-acct',provider_id:'color-channel-0',account_ref:'acct-b',account_evidence:'gateway_account_binding',model:'gpt-6.1-sol',model_display_name:'gpt-6.1-sol',estimated_cost_usd:.095}
  );
  await refresh();
  await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length===8);
  await page.locator('#chart-color-by').selectOption('account');
  require(await page.locator('.score-cost-svg').getAttribute('data-color-by')==='account','Chart SVG must enter account color mode');
  require(await color('color-same-acct')===await color('color-same-acct-m2'),'Account coloring must give distinct models on the same channel/account the same color');
  require(await color('color-same-acct')!==await color('color-other-acct'),'Account coloring must distinguish different accounts on the same channel');
  require((await page.locator('#analysis-method').textContent()).includes('颜色区分渠道与账号 / Key 组合'),'Methodology must describe account/key coloring');
  const accountLegendTexts=await page.locator('.chart-legend-item').allInnerTexts();
  require(accountLegendTexts.some(t=>t.includes('color-channel-0 / acct-a')&&!t.includes('（')),'Account legend should use concise channel/account label without verbose suffix');
  await openFacet('account');
  require(await facet('account').locator('.af-facet-search').isHidden(),'Account facet search should stay hidden when <=8 accounts');
  const acctSubtitles=await facet('account').locator('.af-option-sub').allInnerTexts();
  require(acctSubtitles.includes('color-channel-0'),'Bound accounts should show channel as a concise secondary subtitle');
  await facetChoice('account',JSON.stringify(['provider:color-channel-0','account:acct-a'])).check();
  require(await point('color-same-acct').count()===1&&await point('color-same-acct-m2').count()===1&&await point('color-other-acct').count()===0,'Account facet did not isolate bound account');
  await facet('account').locator('.af-unrestricted').click();
  await facet('account').locator('summary').click();
  // Verify inline search appears in account facet when >8 distinct accounts exist.
  const extraAccounts=Array.from({length:8},(_,i)=>({...peer,id:'color-extra-acct-'+i,provider_id:'color-channel-0',account_ref:'batch-key-'+i,account_evidence:'gateway_account_binding',model:'gpt-6.1-sol',model_display_name:'gpt-6.1-sol',estimated_cost_usd:.096+i*.001}));
  observations.push(...extraAccounts);
  await refresh();
  await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length===16);
  await openFacet('account');
  require(await facet('account').locator('.af-facet-search').isVisible(),'Account facet should show inline filter when >8 accounts');
  await facet('account').locator('.af-facet-search').fill('batch-key-3');
  require(await facet('account').locator('.af-option').count()===1,'Account facet inline filter did not narrow options');
  await facet('account').locator('summary').click();
  observations.splice(observations.length-extraAccounts.length,extraAccounts.length);
  await refresh();
  await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length===8);
  await page.locator('#chart-color-by').selectOption('series');
  require(await color('color-same-acct')!==await color('color-same-acct-m2'),'Series coloring must still separate distinct models on the same account');
  observations.splice(0,observations.length,...Array.from({length:43},(_,i)=>({...peer,id:'dense-'+i,task_id:'dense-task',run_id:'dense-run-'+i,provider_id:'dense-channel-'+Math.floor(i/9),model:'request-model-'+Math.floor(i/9)%3,model_display_name:i===41?'Singleton model':'Model '+Math.floor(i/9)%3,thinking:['unknown','none','minimal','low','medium','high','xhigh','max','ultra'][i%9],status:'completed',estimated_cost_usd:i===42?null:.009+i*.002,usage:{input_tokens:1000+i*10,output_tokens:500+i*5},tasks:tasks.map(task=>({...task,samples:task.samples.map(sample=>({...sample,content_score:i<22?1:.8+(i%5)*.03}))}))})));
