(async () => {
  const status = document.getElementById('status');
  let port = 3481;
  let theme = '';
  let token = '';
  let magpieTokens = {};
  try {
    const info = await window.magpie.ready;
    theme = info?.dark ? 'dark' : 'light';
    magpieTokens = info?.tokens || {};
    const saved = await window.magpie.options.get();
    const options = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    token = typeof options.token === 'string' ? options.token : '';
    const configured = Number(options.port);
    const validPort = Number.isInteger(configured) && configured > 0 && configured < 65536;
    if (token.length < 32 || !validPort) {
      // Persist through the host's own bridge. Never expose a token-discovery API on loopback.
      const next = {...options};
      if (token.length < 32) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        next.token = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      }
      if (!validPort) next.port = 49152 + crypto.getRandomValues(new Uint16Array(1))[0] % 16384;
      status.textContent = '正在初始化本地评测服务…';
      await window.magpie.options.set(next);
      // The host restarts its plugin runtime after setting options. Reload only our frame
      // so both the runtime and a remote page's service proxy use the saved port.
      location.reload();
      return;
    }
    port = configured;
  } catch {
    status.textContent = '暂时无法初始化评测服务，请重新打开插件页面。';
    return;
  }
  const proxied = window.magpie?.service;
  let address;
  if (typeof proxied === 'string' && /^https?:\/\//.test(proxied)) {
    address = proxied;
  } else if (['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(location.hostname)) {
    address = `http://127.0.0.1:${port}/`;
  } else {
    status.textContent = '当前 Magpie 不提供远程插件服务代理，请在运行 Magpie 的设备上打开，或使用安全的端口转发。';
    return;
  }
  const target = new URL(address);
  target.searchParams.set('theme', theme);
  target.searchParams.set('magpie', JSON.stringify(magpieTokens));
  target.searchParams.set('view', 'analysis');
  target.hash = new URLSearchParams({token}).toString();
  location.replace(target.href);
})();
