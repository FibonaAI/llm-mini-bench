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
  await page.locator('#chart-color-by').selectOption('series');
  observations.splice(0,observations.length,...Array.from({length:43},(_,i)=>({...peer,id:'dense-'+i,task_id:'dense-task',run_id:'dense-run-'+i,provider_id:'dense-channel-'+Math.floor(i/9),model:'request-model-'+Math.floor(i/9)%3,model_display_name:i===41?'Singleton model':'Model '+Math.floor(i/9)%3,thinking:['default','none','minimal','low','medium','high','xhigh','max','ultra'][i%9],status:'completed',estimated_cost_usd:i===42?null:.009+i*.002,usage:{input_tokens:1000+i*10,output_tokens:500+i*5},tasks:tasks.map(task=>({...task,samples:task.samples.map(sample=>({...sample,content_score:i<22?1:.8+(i%5)*.03}))}))})));
