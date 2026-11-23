  failObservations=true;await refresh();await page.waitForFunction(()=>document.querySelector('#app-notice').textContent.includes('mock observation failure'));require(await page.locator('#connection-status').textContent()==='数据加载失败','API failure missing');
  failObservations=false;await refresh();await page.waitForFunction(()=>document.querySelector('#connection-status').textContent==='本地数据已同步');await page.evaluate(()=>window.MiniBench.notify(''));
  const pickerGeometry=[];
  for(const [name,width,height,dark,view='runs'] of [['light',1100,780,false],['dark',1100,780,true],['narrow',820,620,false],['short',820,380,false],['mobile',390,740,false],['minimum',320,620,false],['desktop-edge',773,700,false],['mobile-edge',772,700,false],['long-labels',1100,780,false],['long-labels-mobile',390,740,false]]){
    if(name==='long-labels') { Object.assign(routes[0],{provider_id:'self-hosted-provider-with-a-long-instance-name',model_display_name:'GPT-6-Luna-extended-context-release-preview',account_ref:'research-team-account-with-a-long-name',account_evidence:'configured_binding',thinking_levels:['none','minimal','low','medium','high','xhigh','max','ultra']});await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));await page.waitForFunction(()=>window.MiniBench.runState.routes.some(route=>route.provider_id==='self-hosted-provider-with-a-long-instance-name')); }
    if(view==='analysis') { await Promise.all([page.waitForResponse('**/api/bench/observations'),page.locator('[data-view-link="analysis"]').click()]);await page.evaluate(()=>new Promise(requestAnimationFrame)); }
    else await page.locator('[data-view-link="runs"]').click();
    await page.setViewportSize({width,height});await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
    const triggerSelector=view==='runs'?'#task-picker .dp-trigger':'#analysis-picker .dp-trigger';
    await page.locator(triggerSelector).scrollIntoViewIfNeeded();await page.locator(triggerSelector).click();
    await chooseProvider('');
    if(name.startsWith('long-labels'))await chooseProvider('provider:self-hosted-provider-with-a-long-instance-name');
    const geometry=await popup.evaluate((node,triggerSelector)=>{const box=node.getBoundingClientRect(),anchor=document.querySelector(triggerSelector).getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height,anchorTop:anchor.top,anchorBottom:anchor.bottom,placement:node.dataset.placement,viewportWidth:innerWidth,viewportHeight:innerHeight};},triggerSelector);
    require(geometry.width<=860&&geometry.height<=640,'Picker exceeds compact bounds');require(geometry.x>=15&&geometry.y>=15&&geometry.x+geometry.width<=width-15&&geometry.y+geometry.height<=height-15,'Picker leaves viewport');
    if(geometry.placement==='below')require(Math.abs(geometry.y-geometry.anchorBottom-8)<1,'Picker detached from trigger');
    if(geometry.placement==='above')require(Math.abs(geometry.anchorTop-geometry.y-geometry.height-8)<1,'Picker above gap incorrect');
    const before=await page.evaluate(()=>JSON.stringify(window.MiniBench.runState.selectedKeys));
    const hoverRow=popup.locator('.dp-result-row').first();
    await hoverRow.hover();
    const hover=await hoverRow.evaluate(node=>({actual:getComputedStyle(node).backgroundColor,expected:(()=>{const test=document.createElement('i');test.style.background='var(--pill-hover)';node.append(test);const color=getComputedStyle(test).backgroundColor;test.remove();return color;})()}));require(hover.actual===hover.expected,'Browse hover must use neutral host color');
    require(await page.evaluate(()=>JSON.stringify(window.MiniBench.runState.selectedKeys))===before,'Hover changed selections');
    const rowGeometry=await popup.locator('.dp-result-row').first().evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,columns:getComputedStyle(node).gridTemplateColumns,overflow:node.scrollWidth>node.clientWidth}));
    require(!rowGeometry.overflow,'Result row overflows');
    if(name.startsWith('long-labels'))require(await popup.locator('.dp-result-row').first().evaluate(row=>{const bounds=row.getBoundingClientRect(),list=row.parentElement.getBoundingClientRect();return bounds.top>=list.top-1&&bounds.bottom<=list.bottom+1;}),'Wrapped target is clipped by the header or footer');
    if(name==='long-labels'){
      const tops=await popup.locator('.dp-model-row .dp-think').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));
      require(tops.length===8&&new Set(tops).size===1,'All 8 thinking options should stay on a single desktop line: '+JSON.stringify(tops));
      await popup.locator('.dp-search').fill('GPT-6-Luna-extended');
      const searchTops=await popup.locator('.dp-search-row .dp-think').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));
      require(searchTops.length===8&&new Set(searchTops).size===1,'All 8 thinking options should stay on a single line in search view: '+JSON.stringify(searchTops));
      await popup.locator('.dp-search').fill('');
      await chooseProvider('provider:self-hosted-provider-with-a-long-instance-name');
    }
    require(await popup.locator('.dp-result-row').evaluateAll(rows=>rows.every(row=>row.scrollWidth<=row.clientWidth)),'Long target content overflows compact width');
    const columns=await popup.locator('.dp-result-row').first().evaluate(node=>Object.fromEntries(['.dp-model-name','.dp-thinking-list'].map(selector=>{const r=node.querySelector(selector).getBoundingClientRect();return [selector,{x:r.x,y:r.y}];})));
    require(width<=680 ? columns['.dp-model-name'].y<=columns['.dp-thinking-list'].y : columns['.dp-model-name'].x<columns['.dp-thinking-list'].x,'Model/thinking order is not preserved across layouts');
    if(width>680){
      const railNoOverlap=await popup.locator('.dp-rail-item').evaluateAll(nodes=>{
        const boxes=nodes.map(n=>n.getBoundingClientRect());
        return boxes.every((box,i)=>i===0||box.top>=boxes[i-1].bottom-1);
      });
      require(railNoOverlap,'Desktop channel rail items overlap vertically');
    }
    require(await popup.locator('input[type="search"]').count()===1,'Multiple search fields');
    pickerGeometry.push({name,...geometry,rowGeometry,hover:hover.actual});
    await page.screenshot({path:ARTIFACTS+'/picker-polish-'+name+'.png',fullPage:false});await page.keyboard.press('Escape');
  }
  // Verify multi-account (>8 keys) default-collapsed tier, expand/search/batch, and orthogonal selection in browser.
  await page.setViewportSize({width:1200,height:900});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  routes.splice(0,routes.length,
    {id:'acct-auto',provider_id:'openai-keys',model:'openai-keys/gpt-5.4',model_display_name:'GPT-5.4',account_ref:'gateway-default',account_evidence:'gateway_binding',thinking_levels:['low','medium','high']},
    ...Array.from({length:12},(_,i)=>({id:'acct-key-'+i,provider_id:'openai-keys',model:'openai-keys/gpt-5.4',model_display_name:'GPT-5.4',account_ref:(i<3?'team-a-':'prod-')+i+' (k00'+i+')',account_evidence:'gateway_account_binding',thinking_levels:['low','medium','high']}))
  );
  await page.locator('[data-view-link="runs"]').click();await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));
  await page.waitForFunction(()=>window.MiniBench.runState.routes.some(route=>route.id==='acct-key-11'));
  await page.locator('#task-picker .dp-trigger').click();
  require(await popup.locator('.dp-acc-toggle').getAttribute('aria-expanded')==='false','Channels with >8 accounts must start collapsed by default');
  require(await popup.locator('.dp-acc-grid').count()===0,'Collapsed multi-account grid must be hidden');
  await page.screenshot({path:ARTIFACTS+'/picker-multi-account-collapsed.png',fullPage:false});
  await popup.locator('.dp-acc-toggle').click();
  require(await popup.locator('.dp-acc-toggle').getAttribute('aria-expanded')==='true','Multi-account grid did not expand');
  require(await popup.locator('input[type="search"]').count()===1,'Expanded account filter must not add a second type=search');
  await popup.locator('.dp-acc-search').fill('team-a');
  require(await popup.locator('.dp-acc-cell').count()===3,'Account filter did not narrow grid');
  await popup.locator('.dp-acc-batch').click();
  await popup.locator('.dp-think[data-think="medium"]').click();
  await popup.locator('.dp-think[data-think="high"]').click();
  require((await page.evaluate(()=>window.MiniBench.runState.getSelectedTargets())).length===6,'Orthogonal 3 accounts x 2 thinking levels did not produce 6 targets');
  await page.screenshot({path:ARTIFACTS+'/picker-multi-account-expanded.png',fullPage:false});
  await popup.locator('.dp-acc-toggle').click();
  require(await popup.locator('.dp-acc-collapsed-chips .dp-acc-chip').count()===3,'Collapsed view must retain selected account summary chips');
  await popup.locator('.dp-action').click();
  await popup.getByRole('button',{name:'完成',exact:true}).click();

  await page.setViewportSize({width:1200,height:900});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  routes.splice(0,routes.length,...Array.from({length:23},(_,i)=>({id:'bulk-route-'+i,provider_id:'bulk-provider-'+i,model:'bulk-model-'+i,account_ref:'gateway-default',account_evidence:'gateway_binding',thinking_levels:i===22?[]:['high']})));
  await page.locator('[data-view-link="runs"]').click();await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));
  await page.waitForFunction(()=>window.MiniBench.runState.routes.some(route=>route.id==='bulk-route-22'));
  await page.locator('#task-picker .dp-trigger').click();
  await popup.locator('.dp-model-row .dp-check').first().click();
  await popup.locator('.dp-rail-item[data-provider-id="provider:bulk-provider-5"]').click();
  await popup.locator('.dp-model-row .dp-check').first().click();
  require(await popup.locator('.dp-rail-item.is-active').getAttribute('data-provider-id')==='provider:bulk-provider-5','Checking a later channel target must not jump back to an earlier selected channel');
  await popup.locator('.dp-action').click();
  await popup.locator('.dp-search').fill('bulk-model');
  const defaultOption=popup.locator('.dp-think[data-model="bulk-model-22"]');
  require(await defaultOption.count()===1&&await defaultOption.getAttribute('data-think')==='default'&&(await defaultOption.innerText())==='默认','Model without Thinking levels must offer exactly the default option');
  require(await popup.locator('.dp-think[data-think="default"]').count()===1,'Models with Thinking levels must not offer default');
  require(await defaultOption.getAttribute('aria-pressed')==='false','Default target must not be preselected');
  await popup.locator('.dp-select-visible').click();await popup.getByRole('button',{name:'完成',exact:true}).click();
  const selectedTargets=await page.evaluate(()=>window.MiniBench.runState.getSelectedTargets());
  require(selectedTargets.length===23&&selectedTargets.every(target=>target.thinking===(target.route_id==='bulk-route-22'?'default':'high')),'Bulk selection must submit default only for the model without levels');
  await page.locator('#run-rounds').fill('3');require((await page.locator('#run-request-estimate').innerText()).includes('828'),'Large task sample count incorrect');
  require(!await page.locator('#start-run').isDisabled(),'Aggregate sample cap still blocks large tasks');
  const startsBeforeLargePlan=posts.filter(call=>call.path==='/api/bench/tasks').length;
  await page.waitForFunction(()=>!document.querySelector('#start-run').disabled);
  require((await page.locator('#bench-plan-preview').innerText()).includes('828'),'Large task plan missing');
  require(posts.filter(call=>call.path==='/api/bench/tasks').length===startsBeforeLargePlan,'Preview started a paid task');
  await page.screenshot({path:ARTIFACTS+'/large-task-plan.png',fullPage:false});
  console.log('Picker geometry: '+JSON.stringify(pickerGeometry));
  const retryRun={...legacyRun,id:'retry-ui-run',status:'failed',retryable_samples:1,sample_count:36,samples:Array.from({length:36},(_,i)=>({...legacyRun.samples[0],sample_id:'retry-sample-'+i,status:i===0?'api_failure':'completed'}))};runs.push(retryRun);
  await page.evaluate(()=>window.dispatchEvent(new Event('mini-bench:refresh')));await page.locator('[data-bench-run-id="retry-ui-run"]').click();
  await page.locator('#bench-retry-run').waitFor({state:'visible'});const beforeRetry=posts.length;
  await page.locator('#bench-retry-run').click();require(posts.length===beforeRetry,'Retry confirmation sent requests');
