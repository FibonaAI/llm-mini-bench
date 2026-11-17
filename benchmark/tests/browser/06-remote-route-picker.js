  await page.locator('[data-view-link="runs"]').click();await page.locator('#task-picker .dp-trigger').click();const bounds=await popup.boundingBox();require(bounds.x>=0&&bounds.x+bounds.width<=390,'Mobile picker clipped');require(await popup.locator('.dp-results').evaluate(node=>node.scrollWidth<=node.clientWidth),'Mobile results overflow horizontally');require(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile popup page overflow');await page.screenshot({path:(ARTIFACTS + '/mobile-picker.png'),fullPage:true});await page.keyboard.press('Escape');require(await page.locator('#task-picker .dp-trigger').evaluate(node=>node===document.activeElement),'Escape failed focus restore');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#task-picker .dp-trigger').click();await popup.getByRole('button',{name:'清空全部',exact:true}).click();
  await popup.locator('.dp-search').fill('no-match-before-reset');
  require(await popup.locator('.dp-result-row').count()===0,'Reset precondition must explicitly filter candidates');
  await popup.getByRole('button',{name:'重置条件',exact:true}).click();
  require(await popup.locator('.dp-search').inputValue()===''&&await popup.locator('.dp-result-row').count()>0,'Reset did not restore candidate rows');
  for(const provider of ['remote-A','remote-B']){
    const id=JSON.stringify([provider,'openai']);
    require(await popup.locator('.dp-provider-filter option').evaluateAll((nodes,id)=>nodes.some(node=>node.value===id),id),'Remote namespaces merged across instances');
    await chooseProvider(id);
    require(await popup.locator('.dp-result-row img').count()===0,'Remote namespace inferred a brand icon');
    require((await popup.locator('.dp-route').innerText()).includes('网关自动分配')&&(await popup.locator('.dp-route').innerText()).includes('实际账号未记录'),'Remote path invented account pinning');
    require(await popup.locator('.dp-quota-cards, .dp-quota-card').count()===0,'Target list must not display quota cards');
    const leaf=popup.locator('.dp-think[data-think="high"]');require(await leaf.getAttribute('aria-pressed')==='false','Remote instance selection leaked');require(await leaf.getAttribute('data-model')===provider+'/openai/exact/model-v1','Remote model ID was rewritten');await leaf.click();
  }
  await chooseProvider(JSON.stringify(['remote-A','openai']));require(await popup.locator('.dp-think[data-think="high"]').getAttribute('aria-pressed')==='true','Remote A selection lost after filtering B');
  for(const [namespace,label] of [['auto','自动路由'],['group','路由组']]){await chooseProvider(JSON.stringify(['remote-A',namespace]));require((await popup.locator('.dp-route').innerText()).includes(label),'Remote routing namespace mislabeled');require(await popup.locator('.dp-quota-cards').count()===0,'Inferred group member accounts');}
  await chooseProvider('provider:ordinary-owner');require(await popup.locator('.dp-think[data-think="high"]').getAttribute('data-model')==='ordinary-owner/openai/not-a-remote','Ordinary slash model changed');await popup.locator('.dp-think[data-think="high"]').click();
  require(!await popup.locator('.dp-provider-filter option').evaluateAll(nodes=>nodes.some(node=>node.textContent==='ordinary-owner / openai')),'Ordinary slash model falsely expanded');
  await page.screenshot({path:(ARTIFACTS + '/remote-picker.png'),fullPage:true});await popup.getByRole('button',{name:'完成',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#start-run').disabled);
  plan={targets:await page.evaluate(()=>window.MiniBench.runState.getSelectedTargets())};
  require(JSON.stringify(plan.targets.map(({route_id,thinking})=>({route_id,thinking})))===JSON.stringify(['ordinary-slash-route','remote-A-openai','remote-B-openai'].map(route_id=>({route_id,thinking:'high'}))),'Remote task plan changed exact route IDs or Thinking');
  require(plan.targets.every(target=>Object.keys(target).sort().join(',')==='id,route_id,thinking'),'Picker invented model/account routing payload fields');
  require(posts.filter(post=>post.path==='/api/bench/tasks').length===2,'Remote browsing/planning submitted paid work');
  await page.locator('#task-picker .dp-trigger').click();await chooseProvider(JSON.stringify(['remote-A','openai']));
  const plannedTargets=await page.evaluate(()=>JSON.stringify(window.MiniBench.runState.getSelectedTargets()));
  await popup.locator('.dp-search').fill('exact model v1');await popup.locator('.dp-thinking-filter').selectOption('high');
  require(!await page.locator('#start-run').isDisabled(),'Filtering invalidated a valid plan');
  require(await page.evaluate(()=>JSON.stringify(window.MiniBench.runState.getSelectedTargets()))===plannedTargets,'Filtering changed submitted target identities');
  await popup.locator('.dp-reset-filters').click();await chooseProvider(JSON.stringify(['remote-A','openai']));
  require(!requests.includes('/api/bench/quota-cards'),'Target browsing must not fetch quotas');
  await popup.getByRole('button',{name:'完成',exact:true}).click();
  observations.push(...remoteRoutes.slice(0,2).map(route=>({...baseline,id:'observation-'+route.id,source:'run',route_id:route.id,provider_id:route.provider_id,model:route.model,remote_route:route.remote_route})));
  observations.push({...baseline,id:'remote-history-unmarked',source:'run',route_id:'remote-A-openai',provider_id:'remote-A',model:remoteRoutes[0].model});
