// Report resource/startup failures without exposing URL queries, fragments, or access tokens.
(() => {
  function show(message) {
    const notice = document.getElementById('app-notice');
    if (!notice) return;
    notice.hidden = false;
    notice.classList.add('is-error');
    notice.textContent = message;
  }
  window.addEventListener(
    'error',
    event => {
      const resource = event.target;
      if (resource && resource !== window && (resource.src || resource.href)) {
        let file = '页面资源';
        try {
          file = new URL(resource.src || resource.href).pathname.split('/').pop() || file;
        } catch {}
        show(`页面资源加载失败：${file}。请重新打开插件页面；若仍失败，请反馈此提示。`);
      } else {
        const knownErrors = [
          'Error',
          'TypeError',
          'ReferenceError',
          'SyntaxError',
          'RangeError',
          'URIError',
          'EvalError',
          'SecurityError',
          'AbortError',
          'NetworkError'
        ];
        const kind = knownErrors.includes(event.error?.name) ? event.error.name : 'ScriptError';
        let file = '';
        try {
          file = new URL(event.filename).pathname.split('/').pop() || '';
        } catch {}
        show(`页面初始化失败：${kind}${file ? ' · ' + file + ':' + event.lineno : ''}。请反馈此提示。`);
      }
    },
    true
  );
  window.addEventListener('unhandledrejection', () => show('页面初始化失败：异步操作未完成。请重新打开插件页面；若仍失败，请反馈此提示。'));
})();
