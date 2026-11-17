import { expect, test } from 'bun:test';
import { buildChartLegendGroups, fitChartLegendItems } from '../web/chart-legend.js';

const luna = { model:'gpt-6-luna', modelDisplayName:'GPT-6 Luna', providerId:'a', providerName:'Primary', accountId:'one', accountDisplayId:'Research' };

test('legend counts retain repeated observations, Thinking levels and baseline sources', () => {
  const rows = [luna, {...luna,think:'high',source:'baseline'}, {...luna,providerId:'b',providerName:'Backup'}, {...luna,accountId:'two',accountDisplayId:'Other'}];
  const groups = buildChartLegendGroups(rows, 'series');
  expect(groups.length).toBe(3);
  const first = groups.find(group => group.detail === 'Primary / Research');
  expect(first.count).toBe(2);
  expect(first.name).toBe('GPT-6 Luna');
  expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(4);
});

test('legend grouping uses exactly the active model or family color identity', () => {
  const rows = [luna, {...luna,providerId:'b'}, {...luna,modelDisplayName:'gpt-6.1-sol'}, {...luna,modelDisplayName:'DeepSeek-V4'}];
  const models = buildChartLegendGroups(rows, 'model');
  expect(models.length).toBe(3);
  expect(models.find(group => group.name === 'GPT-6 Luna').count).toBe(2);
  expect(models.every(group => group.detail === '')).toBe(true);
  const families = buildChartLegendGroups(rows, 'family');
  expect(families.map(group => [group.name,group.count])).toEqual([['DeepSeek',1],['GPT',3]]);
});

test('grouped legend search retains all recorded model, provider and account names', () => {
  const groups = buildChartLegendGroups([luna, {...luna,modelDisplayName:'ＧＰＴ-６ Luna',providerName:'Remote Lab',accountDisplayId:'Second Account'}], 'model');
  expect(groups.length).toBe(1);
  for (const text of ['gpt-6 luna','remote lab','primary','research','second account']) expect(groups[0].searchText).toContain(text);
});

test('unknown models stay separate and recorded strings remain unmodified display data', () => {
  const groups = buildChartLegendGroups([{model:'<custom-one>',providerName:'<script>not code</script>'},{model:'custom-two'}], 'family');
  expect(groups.length).toBe(2);
  expect(groups.find(group => group.name === '<custom-one>').searchText).toContain('<script>not code</script>');
  expect(buildChartLegendGroups([], 'series')).toEqual([]);
  expect(buildChartLegendGroups([{model:'unknown'}], 'series')[0].detail).toBe('未记录渠道 / 未记录账号');
});

test('legend order does not depend on score, usage or observation ordering', () => {
  const rows = [luna,{...luna,modelDisplayName:'DeepSeek V4',score:100,cost:0},{...luna,modelDisplayName:'Claude Sonnet',score:1,cost:100}];
  expect(buildChartLegendGroups(rows,'model').map(group => group.key)).toEqual(buildChartLegendGroups([...rows].reverse(),'model').map(group => group.key));
});

test('compact legend fits only whole items in a contiguous prefix', () => {
  expect(fitChartLegendItems([80,90,100],176)).toBe(2);
  expect(fitChartLegendItems([80,90,100],175.9)).toBe(1);
  expect(fitChartLegendItems([240,40],100)).toBe(0);
  expect(fitChartLegendItems([40,240,40],130)).toBe(1);
  expect(fitChartLegendItems([],0)).toBe(0);
  expect(fitChartLegendItems([30],0)).toBe(0);
  expect(fitChartLegendItems([80,90,100],500)).toBe(3);
});
