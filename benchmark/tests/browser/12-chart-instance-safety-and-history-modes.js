  const instanceSafety=await page.evaluate(async()=>{const {createScoreCostChart}=await import('./score-cost-chart.js');const host=document.createElement('div');document.body.append(host);const chart=createScoreCostChart(host);chart.render([{id:'isolated',model:'Isolated',providerId:'isolated',score:80,cost:1}],{labels:false});const summaries=[...document.querySelectorAll('.chart-legend summary')];const ids=summaries.map(summary=>summary.getAttribute('aria-controls'));const safe=new Set(ids).size===ids.length&&summaries.every(summary=>summary.closest('.chart-legend').contains(document.getElementById(summary.getAttribute('aria-controls'))));chart.destroy();const cleaned=!host.querySelector('.chart-legend');host.remove();return safe&&cleaned;});
  require(instanceSafety,'Legend IDs or cleanup are not chart-instance safe');
  observations.splice(0,observations.length,...Array.from({length:16},(_,i)=>({...peer,id:'history-'+i,run_id:'history-run-'+i,created_at:new Date(2026,10,i+1,12,34,56).toISOString()})));
  await page.setViewportSize({width:1200,height:900});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.locator('#analysis-reset').click();await refresh();await point('history-15').waitFor();
  require(await page.locator('#analysis-data-latest').isChecked()&&await page.locator('.score-cost-point').count()===1,'Default must show only the latest recorded result');
  require(await point('history-0').count()===0,'Old record remained in latest mode');
  await chooseData('all');require(await page.locator('.score-cost-point').count()===16,'All history lost repeated evaluations');
  await point('history-15').focus();
  const overlapCard=page.locator('.score-cost-tooltip');await overlapCard.waitFor({state:'visible'});
  const overlapText=await overlapCard.innerText();require(/2026[/-]11[/-]16/.test(overlapText)&&overlapText.includes('共 16 条记录')&&overlapText.includes(' 至 '),'Stable overlap needs a bounded date range and count');
  require(await overlapCard.locator('.score-cost-tooltip-overlap').count()===1&&(await overlapCard.locator('.score-cost-tooltip-overlap').innerText()).length<100,'Overlap card expanded into a long history list');
  require(await point('history-15').getAttribute('data-overlap-count')==='16','Overlap count omitted hidden coincident markers');
  await page.locator('#chart-card').screenshot({path:ARTIFACTS+'/history-overlap.png'});
  require(await point('history-0').getAttribute('data-history-state')==='historical'&&await point('history-15').getAttribute('data-history-state')==='latest','History markers lost global latest identity');
  await page.locator('#chart-color-by').selectOption('time');
  const historyColor=await color('history-0');
  require(await page.locator('.chart-legend-item').first().innerText().then(text=>text.includes('2026-11-01')),'Time legend must use textual recorded dates');
  require(await page.locator('.score-cost-point').evaluateAll(nodes=>new Set(nodes.map(node=>node.dataset.modelColor)).size)===16,'Time mode must retain a multicolor palette for distinct dates');
  await chooseData('selected',true);require(await page.locator('.score-cost-point').count()===0,'Specified history must not implicitly select records');
  const historyInput=id=>page.locator('[data-history-record="'+id+'"]');
  await historyInput('history-0').check();await historyInput('history-15').focus();await historyInput('history-15').press('Space');
  require(await page.locator('.score-cost-point').count()===2&&await historyInput('history-15').evaluate(node=>node===document.activeElement),'History checkboxes lost exact IDs or keyboard focus');
  require(await color('history-0')===historyColor&&await point('history-0').getAttribute('data-history-state')==='historical','Selecting history changed its time color or promoted it to latest');
  require(await page.locator('#chart-color-by').inputValue()==='time'&&await page.locator('#chart-color-by option[value="time"]').count()===1,'Time coloring must remain available with exact history selection');
  await Promise.all([page.waitForResponse('**/api/bench/observations'),refresh()]);
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  require(await historyInput('history-15').evaluate(node=>node===document.activeElement),'Observation refresh replaced the focused history checkbox');
  await page.locator('#analysis-date-to').fill('2026-11-01');await page.locator('#analysis-date-to').press('Tab');
  require(await point('history-0').count()===1&&await point('history-15').count()===0,'Specified history date range did not intersect selected IDs');
  await page.locator('#analysis-date-to').fill('');await page.locator('#analysis-date-to').press('Tab');require(await page.locator('.score-cost-point').count()===2,'Date filtering destroyed hidden record selections');
  for(const width of [1200,390,320]){
    await page.setViewportSize({width,height:900});require(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'History controls overflow the viewport');
    await page.screenshot({path:ARTIFACTS+'/history-selection-'+width+'.png',fullPage:false});
  }
  await page.locator('#analysis-history-clear').click();require(await page.locator('.score-cost-point').count()===0,'Clear history selection failed');
  await page.locator('#analysis-history-select-all').click();require(await page.locator('.score-cost-point').count()===16,'Select matching history lost repeated records');
  observations.push({...peer,id:'latest-failed',run_id:'history-latest-failed',status:'failed',created_at:new Date(2026,10,20,12).toISOString()});
  await chooseData('latest');await refresh();await page.waitForFunction(()=>document.querySelector('#analysis-excluded-count').textContent.includes('1 个未入图'));
  require(await page.locator('.score-cost-point').count()===0,'Latest mode silently fell back to an older successful result');
  await page.locator('#analysis-excluded-count').click();require(await page.locator('#analysis-excluded [data-inspect-observation="latest-failed"]').count()===1,'Latest failure is not discoverable');
  await page.locator('#close-analysis-excluded').click();await page.locator('#analysis-reset').click();
  const historyRows=[
    ['A1-low','A1','low',3,.0055,.55],['A1-medium','A1','medium',3,.0128,.75],['A1-high','A1','high',3,.0299,.82],
    ['A2-low','A2','low',10,.0066,.63],['A3-high','A3','high',17,.0379,.87]
  ].map(([id,task_id,thinking,day,cost,score])=>({...peer,id,task_id,run_id:id+'-run',model:'atlas',model_display_name:'Atlas',thinking,created_at:new Date(2026,10,day,12).toISOString(),estimated_cost_usd:cost*3,tasks:tasks.map(task=>({...task,samples:task.samples.map(sample=>({...sample,content_score:score}))}))}));
  historyRows.push({...historyRows[0],id:'history-baseline',source:'baseline',task_id:'baseline-batch',estimated_cost_usd:.06}, {...historyRows[0],id:'history-unknown',task_id:'undated-batch',created_at:null,estimated_cost_usd:.09});
  observations.splice(0,observations.length,...historyRows);
