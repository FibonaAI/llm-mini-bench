  await point('top-cluster-1').press('Enter');require((await page.locator('#inspector-identity').innerText()).includes('top-cluster-1'),'Dense chart selection lost its exact record');
  await page.locator('#close-inspector').click();
  observations.splice(0,observations.length);await refresh();await page.waitForFunction(()=>document.querySelectorAll('.score-cost-point').length===0);
  require(await legend.isHidden(),'Empty charts must not retain stale legend categories');
  require(await page.locator('.chart-legend-list').textContent()==='','Empty charts retained old account labels');
  const windowErrors=await page.evaluate(()=>window.browserWindowErrors);require(windowErrors.length===0,'Window errors: '+JSON.stringify(windowErrors));
  await page.evaluate(()=>sessionStorage.clear());const before=requests.length;await page.goto('http://assessment-ui.invalid/?view=analysis');await page.locator('#app-notice').waitFor({state:'visible'});require((await page.locator('#app-notice').textContent()).includes('缺少访问令牌'),'Missing token message');require(!requests.slice(before).some(path=>path.startsWith('/api/')),'Unauthenticated API call');
  require(!requests.some(path=>/^\/api\/(runs|questions|observations|models)/.test(path)),'Legacy API');require(errors.length===0,errors.join('\n'));return {passed:true,pickerGeometry,polishedGeometry,posts,errors,requests:[...new Set(requests)]};
