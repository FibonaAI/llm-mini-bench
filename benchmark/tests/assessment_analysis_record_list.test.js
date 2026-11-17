import { expect, test } from 'bun:test';
import { renderAnalysisRecordList } from '../web/analysis-record-list.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
const options = { axis: 'cost', exclusionReason: record => record.reason, escapeHtml, formatDate: value => new Date(value).toISOString(), currentYear: 2026 };
const record = { id: 'run:exact-target', model: 'DeepSeek V4.1 Flash', think: 'high', source: 'run', created_at: new Date(2026, 10, 17, 16, 23, 20).toISOString(), providerName: 'homelab / opencode-go', accountId: 'gateway-binding:gateway-default', account: '网关自动分配（账号未记录）', score: 97.619, cost: .017958 };

async function visibleText(html) {
  const values = [];
  await new HTMLRewriter().on('*', { text: chunk => values.push(chunk.text) }).transform(new Response(html)).text();
  return values.join('');
}

test('shared compact records retain exact selection and full timestamp but omit repeated secondary fields', async () => {
  const html = renderAnalysisRecordList([record], options), text = await visibleText(html);
  expect(html).toContain('data-inspect-observation="run:exact-target"');
  expect(html).toContain(record.created_at);
  expect(html).toContain('11/17 16:23');
  for (const value of [record.model, 'high', record.providerName, '97.6 分', '$0.0180 / 轮']) expect(text).toContain(value);
  for (const value of [record.id, '已入图', '我的运行', record.account, '用量未记录']) expect(text).not.toContain(value);
  expect(html).not.toContain('analysis-record-reason');
});

test('excluded records show the actual reason once without redundant missing usage lines or zero imputation', async () => {
  const reason = '运行未完整完成';
  const html = renderAnalysisRecordList([{ ...record, score: null, cost: null, reason }], options), text = await visibleText(html);
  expect(text.split(reason)).toHaveLength(2);
  expect(text).toContain('无完整均分');
  expect(text).not.toContain('用量未记录');
  expect(text).not.toContain('0 / 100');
  expect(text).not.toContain('$0');
});

test('known account claims and baselines remain distinguishable; unknown metadata is not invented', async () => {
  const html = renderAnalysisRecordList([{ ...record, source: 'baseline', accountId: 'account:research', account: 'research（配置绑定）' }], options);
  const text = await visibleText(html);
  expect(text).toContain('research（配置绑定）');
  expect(text).toContain('基线');
  expect(await visibleText(renderAnalysisRecordList([{ ...record, accountId: 'unknown-account', account: '未记录账号' }], options))).not.toContain('未记录账号');
});

test('compact dates preserve cross-year distinctions and missing dates, and token axis formatting stays separate', async () => {
  const old = { ...record, id: 'old', created_at: new Date(2025, 10, 17, 16, 23).toISOString() };
  const html = renderAnalysisRecordList([record, old, { ...record, created_at: null }], { ...options, axis: 'tokens' });
  const text = await visibleText(html);
  expect(text).toContain('2025/11/17');
  expect(text).toContain('2026/11/17');
  expect(text).toContain('时间未记录');
  expect(text).toContain('tokens / 轮');
  expect(text).not.toContain('$');
});

test('record data is escaped in text and attributes; empty list stays explicit', () => {
  const html = renderAnalysisRecordList([{ ...record, id: '" onclick="alert(1)', model: '<img src=x onerror=alert(1)>', reason: '<script>bad()</script>' }], options);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;img');
  expect(html).toContain('data-inspect-observation="&quot; onclick=&quot;alert(1)"');
  expect(renderAnalysisRecordList([], options)).toContain('没有匹配结果');
});
