  await page.locator('[data-view-link="analysis"]').click();await page.locator('#analysis-source').selectOption('all');await point('remote-history-unmarked').waitFor();
  const tooltipChecks=[];
  for(const [name,width,height,dark] of [['light',1200,900,false],['dark',1200,900,true],['mobile',390,740,false],['minimum',320,620,false]]){
    await page.setViewportSize({width,height});await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await point('observation-remote-A-openai').evaluate(node=>node.focus());
    const tooltip=page.locator('.score-cost-tooltip');await tooltip.waitFor({state:'visible'});
    require(await tooltip.locator('.score-cost-tooltip-metric').count()===3,'Tooltip metrics must have distinct labels and values');
    const text=await tooltip.innerText();require(text.includes('remote-A / openai')&&text.includes('账号未记录')&&text.includes('我的运行'),'Tooltip lost recorded route/account/source');
    require(!text.includes('["remote-A"')&&!text.includes('远端路由目录'),'Tooltip exposes internal identity or duplicates channel metadata');
    const geometry=await tooltip.evaluate(node=>{const box=node.getBoundingClientRect(),values=[...node.querySelectorAll('.score-cost-tooltip-metrics dd')].map(value=>value.getBoundingClientRect());return {width:box.width,height:box.height,x:box.x,y:box.y,overflow:node.scrollWidth>node.clientWidth,metricTops:values.map(value=>value.top),metricWidths:values.map(value=>value.width)};});
    require(!geometry.overflow&&geometry.x>=0&&geometry.x+geometry.width<=width,'Details strip overflows narrow viewport');
    require(await tooltip.evaluate(node=>{const card=node.getBoundingClientRect();return getComputedStyle(node).position==='absolute'&&[...node.parentElement.querySelectorAll('.thinking-series[data-hover-highlight="true"]')].every(line=>{const curve=line.getBoundingClientRect();return card.bottom<=curve.top||card.top>=curve.bottom||card.right<=curve.left||card.left>=curve.right;});}),'Floating hover card must avoid the full highlighted curve');
    require(Math.max(...geometry.metricTops)-Math.min(...geometry.metricTops)<1,'Tooltip metrics are not aligned');
    // A low tooltip may extend over the footer keys; it must paint above them, badges included
    // (pointer events are enabled only so elementFromPoint can see the card).
    require(await tooltip.evaluate(node=>{const key=document.querySelector('.chart-footer .source-incomplete');key.scrollIntoView({block:'center'});const host=node.parentElement.getBoundingClientRect(),k=key.getBoundingClientRect();const old=[node.style.left,node.style.top];node.style.pointerEvents='auto';node.style.left=(k.left-host.left-4)+'px';node.style.top=(k.top-host.top-node.offsetHeight/2)+'px';const hits=[[k.left+k.width/2,k.top+k.height/2],[k.right+1,k.top-1]].map(([x,y])=>document.elementFromPoint(x,y));[node.style.left,node.style.top]=old;node.style.pointerEvents='';return hits.every(hit=>hit&&node.contains(hit));}),'Footer key markers paint above the tooltip card');
    tooltipChecks.push({name,...geometry});await tooltip.screenshot({path:"/tmp/llm-mini-bench-analysis-tooltip-"+name+'.png'});
  }
  console.log('Tooltip geometry: '+JSON.stringify(tooltipChecks));
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.activeElement?.blur();});
  await openFacet('provider');
  const historyFacetText=await facet('provider').innerText();require(['remote-A / openai','remote-B / openai'].every(name=>historyFacetText.includes(name)),'Historical explicit remote metadata lost');
  require(await page.locator('#analysis-picker .dp-quota-cards').count()===0,'Live accounts backfilled into history');
  await facetChoice('provider','provider:remote-A').check();
  require(await point('remote-history-unmarked').count()===1&&await point('observation-remote-A-openai').count()===0,'Unmarked historical identity split or backfilled from live route');
  await facet('provider').locator('summary').click();await page.locator('#analysis-result-count').click();
  require((await page.locator('#analysis-results').innerText()).includes(remoteRoutes[0].model),'Historical result lost the exact recorded model');
  await page.locator('#close-analysis-results').click();await page.locator('#analysis-reset').click();
  const analysisGeometry=[];
  for(const [width,height] of [[1100,780],[820,620],[772,620],[390,740],[320,620],[390,380]]){
    await page.setViewportSize({width,height});
    for(const name of ['provider','model','think']){
      await openFacet(name);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const geometry=await facet(name).locator('.af-options').evaluate(node=>{const box=node.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height,overflow:node.scrollWidth>node.clientWidth};});
      require(geometry.x>=15&&geometry.y>=15&&geometry.x+geometry.width<=width-15&&geometry.y+geometry.height<=height-15&&!geometry.overflow,'Analysis facet escapes viewport: '+JSON.stringify({name,viewportWidth:width,viewportHeight:height,...geometry}));
      require(geometry.width===Math.min({provider:320,model:340,think:240}[name],width-32),'Facet width must follow its content, not fill the viewport');
      const rowHeight=await facet(name).locator('.af-option label').first().evaluate(node=>node.getBoundingClientRect().height);
      require(rowHeight>=36,'Facet row is too small');
      analysisGeometry.push({name,width,height,...geometry,rowHeight});
      await page.screenshot({path:ARTIFACTS+'/analysis-'+name+'-'+width+'-'+height+'.png',fullPage:false});
      await facet(name).getByRole('button',{name:'完成',exact:true}).click();
      require(await facet(name).locator('summary').evaluate(node=>node===document.activeElement),'Facet completion must restore focus');
      await openFacet(name);await page.keyboard.press('Escape');
      require(!await facet(name).evaluate(node=>node.open)&&await facet(name).locator('summary').evaluate(node=>node===document.activeElement),'Facet Escape must close and restore focus');
    }
  }
  console.log('Analysis facet geometry: '+JSON.stringify(analysisGeometry));
  const panelGeometry=[];
  for(const [width,height] of [[1440,1000],[820,380],[390,740],[320,380]]){
    await page.setViewportSize({width,height});
    for(const [name,triggerId,panelId,closeId,preferredWidth] of [
      ['data','analysis-data-trigger','analysis-data-panel','close-analysis-data',340],
      ['settings','chart-settings-trigger','chart-settings-panel','close-chart-settings',280]
    ]){
      const trigger=page.locator('#'+triggerId),panel=page.locator('#'+panelId);
      await trigger.click();
      const geometry=await panel.evaluate(node=>{const b=node.getBoundingClientRect(),s=getComputedStyle(node),heading=node.querySelector('.af-heading'),h=heading.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,padding:s.padding,borderRadius:s.borderRadius,headingHeight:h.height,headingFont:getComputedStyle(heading.querySelector('strong')).fontSize,rowHeight:node.querySelector('label').getBoundingClientRect().height,overflow:node.scrollWidth>node.clientWidth};});
      require(geometry.width===Math.min(preferredWidth,width-32),'Incorrect content-specific '+name+' width');
      require(geometry.x>=15&&geometry.y>=15&&geometry.x+geometry.width<=width-15&&geometry.y+geometry.height<=height-15&&!geometry.overflow,'Panel escapes viewport: '+JSON.stringify({name,width,height,...geometry}));
      require(geometry.padding==='8px'&&geometry.borderRadius==='11px'&&geometry.headingFont==='12px'&&geometry.rowHeight===36,'Panel rhythm drift: '+JSON.stringify({name,...geometry}));
      panelGeometry.push({name,viewportWidth:width,viewportHeight:height,...geometry});
      await page.screenshot({path:ARTIFACTS+'/analysis-'+name+'-'+width+'-'+height+'.png',fullPage:false});
      await page.keyboard.press('Escape');require(await panel.isHidden()&&await trigger.evaluate(node=>node===document.activeElement),'Escape did not restore '+name+' focus');
      await trigger.click();await page.locator('#'+closeId).click();require(await panel.isHidden()&&await trigger.evaluate(node=>node===document.activeElement),'Completion did not restore '+name+' focus');
      await trigger.click();await page.locator('#analysis-reset').click();require(await panel.isHidden(),'Outside click did not dismiss '+name);
    }
  }
  console.log('Analysis utility panel geometry: '+JSON.stringify(panelGeometry));
