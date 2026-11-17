  await page.locator('#bench-retry-run').click();await page.waitForFunction(()=>document.querySelector('#bench-run-detail').textContent.includes('retried answer'));
  require(retryRun.status==='completed'&&retryRun.samples[1].response==='saved legacy response','Retry overwrote a successful sample');
  require(await page.locator('#bench-retry-run').isHidden(),'Completed retry remains retryable');
  observations.splice(0,observations.length,...[[1,1],[10,.5],[10.1,.6]].map(([cost,score],i)=>({...peer,id:'zoom-'+i,model:'zoom-model-'+i,model_display_name:'Zoom model '+i,estimated_cost_usd:cost*3,usage:{input_tokens:cost*1000,output_tokens:0},tasks:tasks.map(task=>({...task,samples:task.samples.map(sample=>({...sample,content_score:score}))}))})));
