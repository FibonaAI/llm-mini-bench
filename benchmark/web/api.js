(() => {
  'use strict';
  const params = new URLSearchParams(location.hash.slice(1));
  const hashToken = params.get('token') || '';
  let accessToken = hashToken;
  try {
    if (hashToken) sessionStorage.setItem('mini-bench-access-token', hashToken);
    else accessToken = sessionStorage.getItem('mini-bench-access-token') || '';
  } catch { /* Some sandboxed hosts disable sessionStorage. The Magpie boot page supplies it again. */ }
  if (hashToken) {
    const requestedView = new URLSearchParams(location.search).get('view');
    const initialView = ['analysis', 'runs'].includes(requestedView) ? requestedView : 'analysis';
    try { history.replaceState(null, '', location.pathname + location.search + (location.hash.startsWith('#token=') ? `#${initialView}` : location.hash)); } catch { /* Sandboxed hosts may disallow history changes. */ }
  }
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  try {
    const magpieTokens = JSON.parse(new URLSearchParams(location.search).get('magpie') || '{}');
    for (const [name, value] of Object.entries(magpieTokens)) {
      if (/^[a-z0-9-]+$/i.test(name) && typeof value === 'string') {
        document.documentElement.style.setProperty(`--magpie-${name}`, value);
        if (['bg','card','card-2','pill','pill-hover','fg','fg-2','muted','faint','line','line-2','accent','accent-soft','accent-fg','green','green-soft','red','red-soft','amber','amber-soft','ctl-fg','seg-track','seg-thumb','seg-edge','sel','pop-bg','shadow','font','code','ui-font','ui-weight','ui-style','ui-stretch'].includes(name)) document.documentElement.style.setProperty(`--${name}`, value);
      }
    }
  } catch { /* Direct browser previews use the fallback theme tokens. */ }
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const activeStatus = status => status === 'queued' || status === 'running';
  const statusText = status => ({ pending: '待执行', queued: '排队中', running: '运行中', completed: '已完成', cancelling: '取消中', cancelled: '已取消', interrupted: '已中断', budget_not_admitted: '预算未准入', storage_error: '存储错误', failed: 'API 失败', api_failure: 'API 失败', incomplete: '未完成', tool_call_limit: '未完成：工具调用超限', turn_limit: '未完成：交互轮次超限', response_incomplete_or_error: '响应未完成或请求错误', usage_or_cap_failure: '用量或输出上限异常' }[status] || status || '状态未知');
  const formatDate = value => {
    if (!value) return '未记录时间';
    const date = new Date(typeof value === 'number' ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };
  function notify(message, error = false) {
    const notice = byId('app-notice');
    notice.textContent = message || '';
    notice.hidden = !message;
    notice.classList.toggle('is-error', Boolean(error && message));
  }
  async function request(path, options = {}) {
    if (!accessToken) throw new Error('缺少访问令牌，请从 Magpie 插件入口打开并检查 token 设置');
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Mini-Bench-Token': accessToken, ...(options.headers || {}) } });
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务返回了无效数据 (${response.status})`); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `请求失败 (${response.status})`);
    return data;
  }
  function renderView() {
    const queryView = new URLSearchParams(location.search).get('view');
    const requested = location.hash.replace('#', '') || (['analysis', 'runs'].includes(queryView) ? queryView : 'analysis');
    const view = ['analysis', 'runs'].includes(requested) ? requested : 'analysis';
    for (const name of ['analysis', 'runs']) {
      byId(`${name}-view`).hidden = name !== view;
      const link = document.querySelector(`[data-view-link="${name}"]`);
      if (link) {
        link.classList.toggle('is-active', name === view);
        if (name === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      }
    }
    const title = { analysis: '模型分析', runs: '评测任务' }[view];
    document.title = `LLM Mini Bench · ${title}`;
    window.dispatchEvent(new CustomEvent('mini-bench:view', { detail: view }));
  }
  document.querySelectorAll('[data-view-link]').forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.viewLink; }));
  byId('new-run-button').addEventListener('click', () => { location.hash = 'runs'; });
  byId('refresh-data').addEventListener('click', () => window.dispatchEvent(new Event('mini-bench:refresh')));
  window.addEventListener('hashchange', renderView);
  renderView();
  // Classic deferred bootstrap: feature modules obtain these services through
  // app-context.js. Its bank/runState compatibility getters reference the sole
  // shared context; they are never independently populated by feature scripts.
  window.MiniBench = {
    byId, escapeHtml, finite, activeStatus, statusText, formatDate,
    notify, request, available: Boolean(accessToken),
    refresh() { window.dispatchEvent(new Event('mini-bench:refresh')); }
  };
  if (!accessToken) notify('缺少访问令牌。请在 Magpie 中配置至少 32 位 token，并从插件页面重新打开。', true);
})();
