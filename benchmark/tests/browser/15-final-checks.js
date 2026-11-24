  await point('top-cluster-1').press('Enter');require(await page.locator('.score-cost-tooltip.is-pinned[data-tooltip-record-id="top-cluster-1"]').isVisible(),'Dense chart selection lost its exact record');
  await page.locator('.score-cost-tooltip-close').click();

  // Verify Magpie-style account masking across Analysis (legend, tooltip, SVG export, inspector, raw JSON) and Tasks.
  const maskAccountsRoutes=[
    {id:'route-mask-auto',provider_id:'chatgpt-main',model:'same-model',account_ref:'gateway-default',account_evidence:'gateway_binding',thinking_levels:['high','low']},
    {id:'route-mask-email',provider_id:'chatgpt-main',model:'same-model',account_ref:'alice.researcher@company.invalid',account_evidence:'gateway_account_binding',thinking_levels:['high','low']},
    {id:'route-mask-cjk',provider_id:'chatgpt-main',model:'same-model',account_ref:'测试账号',account_evidence:'gateway_account_binding',thinking_levels:['high','low']},
    {id:'route-mask-short',provider_id:'chatgpt-main',model:'same-model',account_ref:'a',account_evidence:'configured_binding',thinking_levels:['high','low']}
  ];
  routes.push(...maskAccountsRoutes);
  observations.splice(0,observations.length,
    {...peer,id:'obs-mask-email',run_id:'run-mask-email',provider_id:'chatgpt-main',route_id:'route-mask-email',model:'same-model',model_display_name:'GPT-6 Luna',account_ref:'alice.researcher@company.invalid',account_evidence:'gateway_account_binding',thinking:'high',created_at:'2026-11-18T10:00:00Z',estimated_cost_usd:.05},
    {...peer,id:'obs-mask-cjk',run_id:'run-mask-cjk',provider_id:'chatgpt-main',route_id:'route-mask-cjk',model:'same-model',model_display_name:'GPT-6 Luna',account_ref:'测试账号',account_evidence:'gateway_account_binding',thinking:'high',created_at:'2026-11-18T11:00:00Z',estimated_cost_usd:.09},
    {...peer,id:'obs-mask-short',run_id:'run-mask-short',provider_id:'chatgpt-main',route_id:'route-mask-short',model:'same-model',model_display_name:'GPT-6 Luna',account_ref:'a',account_evidence:'configured_binding',thinking:'low',created_at:'2026-11-18T12:00:00Z',estimated_cost_usd:.14}
  );
  await page.locator('#refresh-data').click();await point('obs-mask-email').waitFor();
  await page.waitForFunction(()=>window.MiniBench.runState.routes.some(route=>route.id==='route-mask-email'));
  await page.locator('#chart-color-by').selectOption('account');
  require((await legend.innerText()).includes('alice.researcher@company.invalid'),'Unmasked account missing from legend before toggle');
  const insights=page.locator('#analysis-insights');
  await insights.waitFor({state:'visible'});
  require((await insights.innerText()).includes('测试账号')&&(await insights.locator('.insight-row').count())>=1,'Anomaly insights did not detect within-channel account cost anomaly');
  await insights.locator('.insight-row[data-insight-record="obs-mask-cjk"]').click();
  await page.locator('.score-cost-tooltip.is-pinned[data-tooltip-record-id="obs-mask-cjk"]').waitFor({state:'visible'});
  await page.locator('.score-cost-tooltip-close').click();
  const maskBtn=page.locator('#mask-accounts');
  require(await maskBtn.getAttribute('aria-pressed')==='false'&&(await maskBtn.innerText()).includes('账号打码'),'Mask toggle must start unpressed');
  await maskBtn.click();
  require(await maskBtn.getAttribute('aria-pressed')==='true'&&(await maskBtn.innerText()).includes('账号已打码'),'Mask toggle did not enter active state');
  require(await page.evaluate(()=>document.body.classList.contains('masked')&&localStorage.getItem('mini-bench-mask-accounts')==='1'),'Mask toggle did not persist or mark body.masked');
  const maskedInsightsText=await insights.innerText();
  require(!maskedInsightsText.includes('测试账号')&&!maskedInsightsText.includes('alice.researcher')&&await insights.locator('.pii').count()>=1,'Anomaly insights leaked account names while masked: '+maskedInsightsText);
  const maskedLegendText=await legend.innerText();
  require(!maskedLegendText.includes('alice.researcher')&&!maskedLegendText.includes('测试账号')&&!maskedLegendText.endsWith('/ a'),'Legend leaked account names while masked: '+maskedLegendText);
  require(await legend.locator('.pii').count()>=3,'Legend must render blurred .pii spans while masked');
  const maskedPointLabels=await page.locator('.chart-point-label').allTextContents();
  require(maskedPointLabels.length>0&&maskedPointLabels.every(t=>!t.includes('alice')&&!t.includes('测试账号')),'SVG point labels leaked account names: '+JSON.stringify(maskedPointLabels));
  await point('obs-mask-email').focus();await page.locator('.score-cost-tooltip').waitFor({state:'visible'});
  const maskedTipText=await page.locator('.score-cost-tooltip').innerText();
  require(!maskedTipText.includes('alice.researcher')&&maskedTipText.includes('（固定绑定）'),'Tooltip leaked email or dropped binding suffix: '+maskedTipText);
  await point('obs-mask-short').press('Enter');await page.locator('.score-cost-tooltip.is-pinned[data-tooltip-record-id="obs-mask-short"]').waitFor({state:'visible'});
  const maskedPinnedTip=await page.locator('.score-cost-tooltip.is-pinned').innerText();
  const maskedAccountText=await page.locator('.score-cost-tooltip.is-pinned .score-cost-tooltip-account').innerText();
  require(!maskedAccountText.startsWith('a（')&&maskedPinnedTip.includes('（配置绑定）')&&await page.locator('.score-cost-tooltip.is-pinned .pii').count()>=1,'Pinned tooltip leaked 1-char account_ref while masked: '+maskedAccountText);
  await page.locator('.score-cost-tooltip-close').click();
  await page.locator('[data-view-link="runs"]').click();
  const maskPopup=page.locator('#task-picker .dp-popup.dp-inline:not([hidden])');
  await maskPopup.waitFor({state:'visible'});
  await maskPopup.locator('.dp-rail-item[data-provider-id="provider:chatgpt-main"]').click();
  const maskedPills=await maskPopup.locator('.dp-acc-pills').innerText();
  require(maskedPills.includes('自动分配')&&!maskedPills.includes('alice.researcher')&&!maskedPills.includes('测试账号'),'Task picker pills leaked accounts or hid auto-allocation: '+maskedPills);
  await page.locator('[data-view-link="analysis"]').click();
  await maskBtn.click();
  require(await maskBtn.getAttribute('aria-pressed')==='false'&&(await maskBtn.innerText()).includes('账号打码'),'Mask toggle did not return to unpressed state');
  require(await page.locator('.pii').count()===0&&(await legend.innerText()).includes('alice.researcher@company.invalid'),'Unmasking failed to restore original account names');

  observations.splice(0,observations.length);await refresh();await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length===0);
  require(await insights.isHidden(),'Empty charts must hide anomaly insights panel');
  require(await legend.isHidden(),'Empty charts must not retain stale legend categories');
  require(await page.locator('.chart-legend-list').textContent()==='','Empty charts retained old account labels');
  const windowErrors=await page.evaluate(()=>window.browserWindowErrors);require(windowErrors.length===0,'Window errors: '+JSON.stringify(windowErrors));
  await page.evaluate(()=>sessionStorage.clear());const before=requests.length;await page.goto('http://assessment-ui.invalid/?view=analysis');await page.locator('#app-notice').waitFor({state:'visible'});require((await page.locator('#app-notice').textContent()).includes('缺少访问令牌'),'Missing token message');require(!requests.slice(before).some(path=>path.startsWith('/api/')),'Unauthenticated API call');
  require(!requests.some(path=>/^\/api\/(runs|questions|observations|models)/.test(path)),'Legacy API');require(errors.length===0,errors.join('\n'));return {passed:true,pickerGeometry,polishedGeometry,posts,errors,requests:[...new Set(requests)]};
