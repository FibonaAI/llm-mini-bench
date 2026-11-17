  for(const [width,dark] of [[1440,false],[820,false],[390,false],[320,true]]){
    await page.setViewportSize({width,height:1000});await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    const state=await page.locator('#score-cost-chart').evaluate(host=>{
      const svg=host.querySelector('svg'),labels=[...host.querySelectorAll('.chart-point-label')];
      return {width:host.clientWidth,height:svg.getBoundingClientRect().height,viewBox:svg.getAttribute('viewBox'),labels:labels.map(label=>label.textContent),points:host.querySelectorAll('.score-cost-point').length,
        separated:[...host.querySelectorAll('.record-marker')].every(marker=>{const halo=marker.previousElementSibling;return halo?.classList.contains('record-marker-halo')&&halo.getAttribute('stroke')===svg.querySelector('rect').getAttribute('fill')&&Number(halo.getAttribute('stroke-width'))>Number(marker.getAttribute('stroke-width'));})};
    });
    require(state.points===49&&state.separated,'Dense real-shape fixture lost records or solid marker separation');
    require(state.labels.length<=Math.min(4,Math.max(1,Math.floor((state.width-(state.width<600?61:92))/160))),'Dense chart exceeded the model annotation budget');
    require(new Set(state.labels).size===state.labels.length&&state.labels.every(label=>!label.includes('channel-')),'Default labels must be short and deduplicated across channels');
    require(state.height===(state.width<600?380:400),'Chart height must be compact without cropping the score scale');
    require(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Dense chart polish overflows');
    polishedGeometry.push({viewport:width,...state});
    await page.locator('#chart-card').screenshot({path:ARTIFACTS+'/top-cluster-polished-'+width+'.png'});
  }
  await page.setViewportSize({width:1440,height:1000});await point('top-cluster-1').focus();
  require((await page.locator('.score-cost-tooltip').innerText()).includes('channel-0'),'Short labels removed exact channel from accessible details');
