// Qualitative colors, not brand colors. Register the full catalog before filtering.
// The former hash % 7 scheme gave unrelated models the identical orange.
const palette = [
  ['#2166ac', '#68b0f3'],
  ['#d95f02', '#ff963f'],
  ['#16866a', '#45cba4'],
  ['#b5348b', '#ec7cc5'],
  ['#998100', '#d9c04a'],
  ['#62666e', '#b5bbc5'],
  ['#008da8', '#41d3e9'],
  ['#7150aa', '#b499ed'],
  ['#b93939', '#f27979'],
  ['#7d571a', '#cba56c'],
  ['#617a28', '#a6c765'],
  ['#b76678', '#eda7b6']
];
// Model families are display-name groups, never evidence of the serving provider.
const modelFamilies = [
  ['gpt', 'GPT'],
  ['deepseek', 'DeepSeek'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
  ['qwen', 'Qwen'],
  ['llama', 'Llama'],
  ['grok', 'Grok'],
  ['kimi', 'Kimi'],
  ['glm', 'GLM'],
  ['mistral', 'Mistral'],
  ['minimax', 'MiniMax']
];

/** Chart categories affect presentation only; unknown model families remain separate models. */
export function chartCategory(record, dimension) {
  const providerId = record.providerId ?? record.provider;
  const providerLabel = record.providerName ?? record.provider;
  if (dimension === 'time') {
    const timestamp = typeof record.created_at === 'string' && record.created_at.trim() ? Date.parse(record.created_at) : NaN;
    if (!Number.isFinite(timestamp)) return { key: JSON.stringify(['time', 'unknown']), label: '时间未记录' };
    // Recorded evaluation time, grouped by the viewer's local calendar day; never insertion time.
    const date = new Date(timestamp);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { key: JSON.stringify(['time', day]), label: day };
  }
  if (dimension === 'series') {
    const model = chartCategory(record, 'model');
    const account = record.accountId ?? record.account ?? 'unknown-account';
    const accountLabel =
      account === 'unknown-account' || String(account).startsWith('gateway-binding:')
        ? ''
        : ' · ' + (record.accountDisplayId ?? record.account ?? account);
    return {
      key: JSON.stringify([model.key, providerId, account]),
      label: model.label + ' · ' + (record.providerName ?? record.providerDisplayId ?? record.provider ?? '未记录渠道') + accountLabel
    };
  }
  if (dimension === 'model') {
    const label = String(record.modelDisplayName ?? record.model ?? '未记录模型');
    const identity = label
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
    return { key: JSON.stringify([identity]), label };
  }
  if (dimension === 'family') {
    const model = chartCategory(record, 'model');
    const name = model.label.normalize('NFKC').trim().toLowerCase();
    const family = modelFamilies.find(([prefix]) => new RegExp(`^${prefix}(?=$|[\\s._-]|[0-9])`).test(name));
    return family
      ? { key: JSON.stringify(['family', family[0]]), label: family[1] }
      : { key: JSON.stringify(['model', model.key]), label: model.label };
  }
  if (dimension === 'provider') return { key: JSON.stringify([providerId]), label: providerLabel };
  if (dimension === 'account') {
    const accountId = record.accountId ?? record.account;
    const shortAccount =
      accountId === 'unknown-account'
        ? '未记录账号'
        : String(accountId ?? '').startsWith('gateway-binding:')
          ? (record.accountShortName ?? '网关自动分配')
          : record.accountDisplayId && record.accountDisplayId !== '实际账号未记录'
            ? record.accountDisplayId
            : (record.accountShortName ?? record.account ?? '未记录账号');
    return { key: JSON.stringify([providerId, accountId]), label: `${providerLabel} / ${shortAccount}` };
  }
  return { key: JSON.stringify([record[dimension]]), label: String(record[dimension] ?? '未标注') };
}
export function createChartColorRegistry(catalog = []) {
  const registries = new Map();
  function register(records, dimension) {
    if (!registries.has(dimension)) registries.set(dimension, new Map());
    const registry = registries.get(dimension);
    for (const key of [
      ...new Set(
        records
          .filter(record => dimension !== 'time' || chartCategory(record, dimension).label !== '时间未记录')
          .map(record => chartCategory(record, dimension).key)
      )
    ].sort()) {
      if (!registry.has(key)) registry.set(key, registry.size);
    }
  }
  for (const dimension of ['provider', 'account', 'model', 'family', 'think', 'source', 'series']) register(catalog, dimension);
  return {
    register,
    color(record, dimension, dark = false) {
      if (dimension === 'time' && chartCategory(record, dimension).label === '时间未记录') return dark ? '#b5bbc5' : '#62666e';
      register([record], dimension);
      const index = registries.get(dimension).get(chartCategory(record, dimension).key);
      if (index < palette.length) return palette[index][dark ? 1 : 0];
      // More categories are not folded back onto existing colors.
      return `hsl(${((index * 137.508) % 360).toFixed(3)} 58% ${dark ? 68 : 42}%)`;
    }
  };
}
