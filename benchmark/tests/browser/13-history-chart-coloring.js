  await page.setViewportSize({width:1200,height:900});await refresh();await chooseData('all');
  await page.locator('#chart-color-by').selectOption('time');
  require(await point('A1-low').getAttribute('data-history-state')==='historical'&&await point('A1-medium').getAttribute('data-history-state')==='latest','Irregular batch latest states are not per Thinking');
  const markerSizes=await page.locator('.record-marker').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBBox(),stroke=Number(node.getAttribute('stroke-width'));return {shape:node.tagName,width:b.width+stroke,height:b.height+stroke,state:node.parentElement.dataset.historyState};}));
  require(markerSizes.some(marker=>marker.state==='historical')&&markerSizes.some(marker=>marker.state==='latest'),'Marker sizing fixture must contain both history states');
  require(markerSizes.every(marker=>marker.width===(marker.shape==='rect'?10:12)&&marker.height===(marker.shape==='rect'?10:12)),'Filled and hollow glyphs must have identical visible bounds, including strokes');
  require(await point('history-baseline').locator('rect.record-marker').count()===1&&await point('history-baseline').getAttribute('data-history-state')==='latest','Baseline source shape and latest identity must stay independent');
  require(await point('history-unknown').getAttribute('data-history-state')==='unknown','Undated points must not be marked latest');
  const noThinkingCurves=()=>page.locator('.thinking-series').evaluateAll(nodes=>nodes.every(node=>node.getAttribute('opacity')==='0'));
  await page.locator('#chart-color-by').focus();require(await noThinkingCurves(),'Overview unexpectedly connected irregular latest batches');
  await point('A2-low').hover();require(await noThinkingCurves()&&await page.locator('.thinking-level-label').count()===0,'Singleton batch received a fake progression');
  await point('A1-medium').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  require(await page.locator('.thinking-series[data-series-selected="true"][opacity="0.95"]').count()===1&&await page.locator('.thinking-level-label').count()===3,'Selection must reveal mixed latest/history from the same batch');
  await page.locator('#close-inspector').click();
  const stableTimeColor=await color('A1-medium');
  await openFacet('model');await facetChoice('model','atlas').check();await page.locator('#analysis-picker .af-search').focus();
  require(await page.locator('#chart-color-by').inputValue()==='time'&&await color('A1-medium')===stableTimeColor,'Model filtering changed independent time coloring');
  await chooseData('latest');await point('A1-medium').focus();
  require(await noThinkingCurves()&&await page.locator('.thinking-level-label').count()===0,'Latest points from A2/A1/A3 were falsely joined');
  await point('A1-medium').press('Space');require(await page.locator('#model-inspector').isVisible(),'Space release did not preserve exact record inspection');
  await page.locator('#close-inspector').click();await chooseData('all');
  for(const [width,dark] of [[1200,false],[390,false],[320,true]]){
    await page.setViewportSize({width,height:900});await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
    require(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Historical multicolor chart overflows');
    await page.locator('#chart-card').screenshot({path:ARTIFACTS+'/history-multicolor-'+width+'.png'});
  }
  const screenshotModels=['GPT-6 Luna','GPT-6 Luna','GPT-6 Luna','GPT-6 Luna','GPT-6.1 Terra','GPT-6.1 Terra','GPT-6.1 Sol','GPT-6.1 Sol','DeepSeek V4.1 Flash','DeepSeek V4.1 Flash'];
  const screenshotCosts=[.0015,.0029,.0042,.009,.017,.023,.033,.052,.093,.20];
  const screenshotScores=[[60,91,93,95,96],[82,85,91,94,98],[69,95,96,97,99],[70,76,86,91,98]];
  observations.splice(0,observations.length,...Array.from({length:49},(_,index)=>{
    const group=Math.floor(index/5),level=index%5,score=screenshotScores[group]?.[level]??(level===0?98:100);
    return {...peer,id:'top-cluster-'+index,run_id:'top-run-'+index,task_id:'top-batch-'+group,provider_id:'channel-'+group,model:screenshotModels[group],model_display_name:screenshotModels[group],thinking:['none','low','medium','high','max'][level],created_at:'2026-11-17T12:00:00Z',estimated_cost_usd:screenshotCosts[group]*(1+level*.035)*3,tasks:tasks.map(task=>({...task,samples:task.samples.map(sample=>({...sample,content_score:score/100}))}))};
  }));
  await page.setViewportSize({width:1440,height:1000});await page.reload();await point('top-cluster-48').waitFor();
  await page.locator('#chart-color-by').selectOption('series');
  const polishedGeometry=[];
