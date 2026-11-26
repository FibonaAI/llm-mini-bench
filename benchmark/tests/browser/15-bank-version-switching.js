  await point('top-cluster-1').press('Enter');require(await page.locator('.score-cost-tooltip.is-pinned[data-tooltip-record-id="top-cluster-1"]').isVisible(),'Dense chart selection lost its exact record');
  await page.locator('.score-cost-tooltip-close').click();
  // First enable dual-bank catalog while only 1.0 records exist: stay on 1.0 with an update badge and flush geometry.
  servedBanks=[{...BANK_2_0,id:'assessment-2.0',default:true,production:true,title:'Mini Bench'},{...bank,id:'assessment-1.0',default:false,production:true,title:'Mini Bench'}];
  await page.locator('#refresh-data').click();
  await page.waitForFunction(()=>document.querySelectorAll('#bench-version-switch [data-bank-version]').length===2);
  require(await page.locator('#bench-version-badge').isVisible(),'1.0-only workspace should show the new-version badge on trigger');
  require((await page.locator('#bench-version-trigger').getAttribute('data-has-update'))==='true','Trigger should mark data-has-update when 2.0 has no records');
  const versionSwitchGeo=await page.evaluate(()=>{
    const sw=document.querySelector('#bench-version-switch'),status=document.querySelector('#connection-status'),refresh=document.querySelector('#refresh-data'),tabs=document.querySelector('.top .tabs');
    const sr=sw.getBoundingClientRect(),st=status.getBoundingClientRect(),rr=refresh.getBoundingClientRect(),tr=tabs.getBoundingClientRect();
    return {inActions:Boolean(sw.closest('.top .actions')),left:sr.left,right:sr.right,top:sr.top,bottom:sr.bottom,statusRight:st.right,refreshLeft:rr.left,refreshTop:rr.top,refreshBottom:rr.bottom,tabsRight:tr.right,innerWidth};
  });
  require(versionSwitchGeo.inActions&&versionSwitchGeo.left>versionSwitchGeo.innerWidth/2&&versionSwitchGeo.left>=versionSwitchGeo.statusRight&&versionSwitchGeo.right<=versionSwitchGeo.refreshLeft&&Math.abs(versionSwitchGeo.top-versionSwitchGeo.refreshTop)<=1&&Math.abs(versionSwitchGeo.bottom-versionSwitchGeo.refreshBottom)<=1,'Version switch with update badge must sit flush with action buttons: '+JSON.stringify(versionSwitchGeo));
  await page.setViewportSize({width:320,height:740});
  const narrowSwitchGeo=await page.evaluate(()=>{const sr=document.querySelector('#bench-version-switch').getBoundingClientRect();return {left:sr.left,right:sr.right,scrollWidth:document.documentElement.scrollWidth,innerWidth};});
  require(narrowSwitchGeo.scrollWidth<=narrowSwitchGeo.innerWidth&&narrowSwitchGeo.left>=0&&narrowSwitchGeo.right<=narrowSwitchGeo.innerWidth,'Version switch with update badge overflows 320px viewport: '+JSON.stringify(narrowSwitchGeo));
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#bench-version-trigger').click();
  require((await page.locator('#bench-version-menu [data-bank-version="2.0"] .version-option-badge').innerText()).includes('新版本'),'2.0 option should show new-version badge before 2.0 has records');
  await page.locator('#bench-version-trigger').click();
  // Now add 2.0 records and refresh: update badge clears while preserving current 1.0 view, then verify strict data/task isolation across versions.
  const v2Tasks=BANK_2_0.tasks.map(task=>({task_id:task.id,title:task.title,domain:task.domain,samples:[1,2,3].map(round=>({round,status:'completed',content_score:.75,instruction_checks:{submitted_via_tool:true},outcome:'partial'}))}));
  const v2Obs={...baseline,id:'v2-run-obs',source:'run',run_id:'v2-only-run',target_id:'v2-target',model:'v2-frontier-model',label:'v2-frontier-model',bank_version:'2.0',task_sha256:BANK_2_0.task_sha256,source_sha256:BANK_2_0.source_sha256,tasks:v2Tasks,estimated_cost_usd:.09};
  observations.push(v2Obs);
  const v2TaskId='mock-v2-task';
  taskRecords.push({id:v2TaskId,status:'completed',bank_version:'2.0',created_at:'2026-11-23T01:00:00Z',plan:{bank_version:'2.0',targets:[routes[0]],rounds:1,sample_concurrency:6,run_concurrency:3,run_count:1,samples_per_run:12,sample_count:12,limits:{timeout:600,timeout_scope:'sample',max_cost_usd:null}},children:[{run_id:'v2-only-run',status:'completed',bank_version:'2.0',target:routes[0],sample_count:12,sample_status_counts:{completed:12},retryable_samples:0,budget:{estimated_uncached_cost_usd:.09}}]});
  runs.push({id:'v2-only-run',task_id:v2TaskId,status:'completed',bank_version:'2.0',created_at:'2026-11-23T01:00:00Z',plan:{bank_version:'2.0',rounds:1,targets:[routes[0]]},sample_count:12,sample_status_counts:{completed:12},samples:BANK_2_0.tasks.map((task,idx)=>({sample_id:'v2-s-'+idx,task:task.id,target_id:'v2-target',round:1,thinking:'high',status:'completed',response:'{}',grade:{content_score:.75}})),budget:{estimated_uncached_cost_usd:.09}});
  await page.locator('#refresh-data').click();
  await page.waitForFunction(()=>document.querySelector('#bench-version-badge')?.hidden===true);
  require((await page.locator('#bench-version-trigger').getAttribute('data-has-update'))===null,'Trigger update badge should clear once 2.0 records exist');
  require(await page.locator('#bench-version-menu [data-bank-version="2.0"] .version-option-badge').count()===0,'2.0 option badge should clear once 2.0 records exist');
  // Since 1.0 was previously active in memory, switch explicitly to 2.0 via the dropdown and verify isolation.
  require((await page.locator('#bench-version-label').innerText()).trim()==='1.0','Trigger should show current 1.0 version');
  require(await page.locator('#bench-version-menu').isHidden(),'Version menu should start collapsed');
  await page.locator('#bench-version-trigger').click();
  require(await page.locator('#bench-version-menu').isVisible(),'Version menu should open on trigger click');
  require(await page.locator('#bench-version-menu svg').count()===0,'Version menu options should not render a checkmark icon');
  const versionMenuGeo=await page.evaluate(()=>{
    const tr=document.querySelector('#bench-version-trigger').getBoundingClientRect();
    const mr=document.querySelector('#bench-version-menu').getBoundingClientRect();
    return {triggerWidth:tr.width,menuWidth:mr.width,triggerRight:tr.right,menuRight:mr.right};
  });
  require(Math.abs(versionMenuGeo.menuWidth-versionMenuGeo.triggerWidth)<=1&&Math.abs(versionMenuGeo.menuRight-versionMenuGeo.triggerRight)<=1,'Version menu without badge should match trigger width: '+JSON.stringify(versionMenuGeo));
  require((await page.locator('#bench-version-trigger').getAttribute('aria-expanded'))==='true','Trigger aria-expanded should be true when open');
  require((await page.locator('#bench-version-menu [data-bank-version="1.0"]').getAttribute('aria-selected'))==='true','1.0 option not marked selected');
  await page.locator('#bench-version-menu [data-bank-version="2.0"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length===1);
  require(await page.locator('#bench-version-menu').isHidden(),'Version menu should close after selection');
  require((await page.locator('#bench-version-label').innerText()).trim()==='2.0','Trigger should show 2.0 after switching');
  require((await page.locator('#bench-version-menu [data-bank-version="2.0"]').getAttribute('aria-selected'))==='true','2.0 option not marked selected');
  require((await page.locator('#dataset-summary').innerText()).includes('Mini Bench 2.0 · 0 份基线 · 1 个运行目标'),'2.0 dataset summary leaked 1.0 records');
  require(await point('v2-run-obs').count()===1,'2.0 observation missing on 2.0 chart');
  await page.locator('[data-view-link="runs"]').click();
  require((await page.locator('#bench-bank-label').innerText()).includes('Mini Bench 2.0 · 12 题'),'2.0 composer label not updated');
  require(await page.locator('#bench-run-list [data-bench-task-id="mock-v2-task"]').count()===1,'2.0 task missing in 2.0 history');
  require(await page.locator('#bench-run-list [data-bench-run-id="peer-run"]').count()===0,'1.0 legacy run leaked into 2.0 history');
  // Switch back to 1.0 via the dropdown and verify 1.0 history & chart return without 2.0 records.
  await page.locator('#bench-version-trigger').click();
  await page.locator('#bench-version-menu [data-bank-version="1.0"]').click();
  require((await page.locator('#bench-version-label').innerText()).trim()==='1.0','Trigger should show 1.0 after switching back');
  require((await page.locator('#bench-version-menu [data-bank-version="1.0"]').getAttribute('aria-selected'))==='true','1.0 option not marked selected');
  require(await page.locator('#bench-run-list [data-bench-task-id="mock-v2-task"]').count()===0,'2.0 task leaked into 1.0 history');
  require(await page.locator('#bench-run-list [data-bench-run-id="peer-run"]').count()===1,'1.0 legacy run missing after switching back to 1.0');
  await page.locator('[data-view-link="analysis"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length>1);
  require(await point('v2-run-obs').count()===0,'2.0 observation leaked into 1.0 chart');
