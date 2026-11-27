import { getAppContext } from './app-context.js';

export const ACCOUNT_MASK_STORAGE_KEY = 'mini-bench-mask-accounts';

const EYE = 'M2 12s3.5-8 10-8 10 8 10 8-3.5 8-10 8-10-8-10-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';
const EYE_OFF =
  'M9.9 4.2A10.4 10.4 0 0 1 12 4c6.5 0 10 8 10 8a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20';

const EMAIL_SOURCE = '[\\w.+*•-]+@[\\w*•-]+(?:\\.[\\w*•-]+)+';
const EMAIL = new RegExp(EMAIL_SOURCE, 'g');
const IS_EMAIL = new RegExp(`^${EMAIL_SOURCE}$`);
const WORD = /[A-Za-z0-9_]/;
const JOIN = /[-.]/;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'OPTION', 'TEXTAREA', 'NOSCRIPT']);
const SVG_NS = 'http://www.w3.org/2000/svg';

const SYSTEM_ACCOUNT_LABELS = new Set([
  'default',
  'gateway-default',
  'unknown',
  'unknown-account',
  '未记录',
  '未记录账号',
  '实际账号未记录',
  '账号未记录',
  '账号引用未记录',
  '网关自动分配',
  '网关自动分配（账号未记录）',
  '网关自动分配（实际账号未记录）',
  '自动分配',
  '默认',
  '未选账号',
  '配置绑定',
  '固定绑定',
  '未核验'
]);

const NOT_ACCOUNTS = new Set([
  ...[...SYSTEM_ACCOUNT_LABELS].map(item => item.toLowerCase()),
  'own',
  'desktop',
  'account',
  'main',
  'local',
  'none',
  'free',
  'pro',
  'max',
  'ultra',
  'low',
  'medium',
  'high',
  'xhigh',
  'minimal',
  'api key',
  'signed in',
  'auto',
  'group',
  'baseline',
  'run',
  'completed',
  'running',
  'queued',
  'failed',
  'timeout',
  'cancelled',
  'interrupted',
  'mini bench',
  'llm mini bench',
  '模型',
  '任务',
  '分析',
  '渠道',
  '基线',
  '样本',
  '路由',
  '思考',
  '账号',
  '已关闭'
]);

const PURE_ACCOUNT_SELECTOR = [
  '.dp-acc-pill:not(.dp-acc-auto) > .dp-acc-pill-name',
  '.dp-acc-cell > .dp-acc-cell-name',
  '.dp-acc-pill:not(.dp-acc-auto) > .dp-acc-id',
  '.dp-acc-cell > .dp-acc-id',
  '.task-run-account:not(.is-auto)',
  '.af-facet[data-facet="account"] .af-option-primary',
  '.insight-account'
].join(', ');

const SUFFIXED_ACCOUNT_SELECTOR = '.score-cost-tooltip-account, .dp-search-row .dp-account-name';
const PREFIXED_ACCOUNT_SELECTOR = '.run-account-pill, .channel-pod-tag:not(.is-remote)';

const BINDING_SUFFIX_RE = /([^\s/·，,("']+?)(?=（(?:固定绑定|配置绑定|未核验)）)/g;
const ACCOUNT_PREFIX_RE = /账号\s+([^\s/·，,)"']+)/g;
const JSON_ACCOUNT_REF_RE = /"account_ref"\s*:\s*"([^"\r\n]+)"/g;
const CONDITION_ACCOUNT_RE = /^(?:账号|(?:仅筛选|移除)账号(?:条件)?)：(.+?)(?:\s+×)?$/;
const REMOVE_PICKER_CHIP_RE = /^移除账号\s+(.+)$/;
const REMOVE_TARGET_RE = /^移除\s+.+\s+\(([^()]+)\)$/;
const SPLIT_DISPLAY_RE = /^(.+?)\s+\(([0-9A-Za-z._-]{4,32})\)$/;

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameLike = value => [...value].length > 1 || /^(?!\p{ASCII})\p{L}$/u.test(value);
const joined = (text, index, step) => WORD.test(text[index] || '') || (JOIN.test(text[index] || '') && WORD.test(text[index + step] || ''));
const inWord = (text, start, end) => /[\p{L}\p{N}]$/u.test(text.slice(0, start)) || /^[\p{L}\p{N}]/u.test(text.slice(end));

/** Check whether a label is a generic/system placeholder rather than a user account or key identifier. */
export function isSystemAccountText(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || /^•+$/u.test(trimmed)) return true;
  if (SYSTEM_ACCOUNT_LABELS.has(trimmed) || SYSTEM_ACCOUNT_LABELS.has(trimmed.toLowerCase())) return true;
  if (/^\d+\s*个账号$/.test(trimmed)) return true;
  return false;
}

const STAND_IN_CHARS = 'aeiounrstlcmdh';
/** Deterministic shape-preserving stand-in characters (following Magpie's blurred `.pii` masking). */
export function maskStandIn(value) {
  let hash = 7;
  return String(value ?? '').replace(/[^@.\s]/gu, ch => {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
    let pick = STAND_IN_CHARS[hash % STAND_IN_CHARS.length];
    if (pick === ch.toLowerCase()) pick = STAND_IN_CHARS[(hash + 1) % STAND_IN_CHARS.length];
    return pick;
  });
}

/** Plain-text bullet mask for native tooltips and ARIA labels where CSS blur cannot apply. */
export function maskBullets(value) {
  const text = String(value ?? '');
  return text.includes('@') ? text.replace(/[^@.\s]/gu, '•') : text.replace(/[^\s]/gu, '•');
}

function mergeRanges(text, candidates) {
  const valid = candidates.filter(
    ([start, end]) => start >= 0 && end > start && end <= text.length && !isSystemAccountText(text.slice(start, end))
  );
  if (!valid.length) return [];
  valid.sort((a, b) => a[0] - b[0] || b[1] - b[0] - (a[1] - a[0]));
  /** @type {[number, number][]} */
  const merged = [];
  for (const [start, end] of valid) {
    const prev = merged[merged.length - 1];
    if (!prev || start >= prev[1]) merged.push([start, end]);
    else if (end > prev[1]) prev[1] = end;
  }
  return merged;
}

/**
 * Create a page-level account masker modeled on Magpie's `hideAccounts` controller.
 * Keeps underlying route/observation/selection identities untouched while masking rendered
 * DOM text, tooltips, and ARIA descriptions on demand for screenshot sharing.
 * @param {Record<string, any>} [options]
 */
export function createAccountMasker({
  root = undefined,
  button = null,
  app = null,
  storage = undefined,
  doc = undefined,
  win = undefined,
  MutationObserverImpl = typeof MutationObserver !== 'undefined' ? MutationObserver : null
} = {}) {
  const ownerDoc = doc ?? root?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  const view = root ?? ownerDoc?.body ?? null;
  const hostWin = win ?? (typeof window !== 'undefined' ? window : null);
  const store =
    storage !== undefined
      ? storage
      : (() => {
          try {
            return hostWin?.localStorage ?? null;
          } catch {
            return null;
          }
        })();

  const accountNames = new Set();
  const exactAccountRefs = new Set();
  const nonAccountTerms = new Set(NOT_ACCOUNTS);
  let finderKey = null;
  let compiledFinder = EMAIL;
  let exactRefKey = null;
  /** @type {RegExp | null} */
  let compiledShortRefs = null;
  /** @type {RegExp | null} */
  let compiledLegendShortRefs = null;
  let masked = false;
  let maskingTimer = null;

  function addAccountCandidate(raw) {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 120 || /[\r\n]/.test(trimmed) || isSystemAccountText(trimmed)) return;
    exactAccountRefs.add(trimmed);
    exactRefKey = null;
    if (nameLike(trimmed)) {
      accountNames.add(trimmed);
      finderKey = null;
    }
    const split = SPLIT_DISPLAY_RE.exec(trimmed);
    if (split) {
      const primary = split[1].trim();
      const badgeId = split[2].trim();
      if (primary && !isSystemAccountText(primary)) {
        exactAccountRefs.add(primary);
        if (nameLike(primary)) accountNames.add(primary);
      }
      if (badgeId && !isSystemAccountText(badgeId)) {
        exactAccountRefs.add(badgeId);
        if (nameLike(badgeId)) accountNames.add(badgeId);
      }
      finderKey = null;
      exactRefKey = null;
    }
  }

  function addNonAccountTerm(raw) {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || trimmed.length > 160) return;
    if (!nonAccountTerms.has(trimmed)) {
      nonAccountTerms.add(trimmed);
      finderKey = null;
      exactRefKey = null;
    }
  }

  function scanPayload(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 10) return false;
    let beforeCount = exactAccountRefs.size + accountNames.size;
    if (Array.isArray(value)) {
      for (const item of value) scanPayload(item, depth + 1);
      return exactAccountRefs.size + accountNames.size !== beforeCount;
    }
    const record = /** @type {Record<string, any>} */ (value);
    for (const key of ['provider_id', 'provider_name', 'model', 'model_display_name']) {
      if (typeof record[key] === 'string') addNonAccountTerm(record[key]);
    }
    if (record.remote_route && typeof record.remote_route === 'object' && typeof record.remote_route.namespace === 'string') {
      addNonAccountTerm(record.remote_route.namespace);
    }
    if (typeof record.account_ref === 'string' && record.account_evidence !== 'gateway_binding') {
      addAccountCandidate(record.account_ref);
    }
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      const child = record[key];
      if (child && typeof child === 'object') scanPayload(child, depth + 1);
    }
    return exactAccountRefs.size + accountNames.size !== beforeCount;
  }

  function finder() {
    const names = [...accountNames]
      .filter(name => nameLike(name) && !IS_EMAIL.test(name) && !nonAccountTerms.has(name.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    const key = names.join('\n');
    if (key !== finderKey) {
      finderKey = key;
      const withAt = names.filter(name => name.includes('@')).map(escapeRegex);
      const withoutAt = names.filter(name => !name.includes('@')).map(escapeRegex);
      compiledFinder = names.length ? new RegExp([...withAt, EMAIL_SOURCE, ...withoutAt].join('|'), 'g') : new RegExp(EMAIL_SOURCE, 'g');
    }
    return compiledFinder;
  }

  function shortRefPattern() {
    const shortRefs = [...exactAccountRefs]
      .filter(ref => !nameLike(ref) && !nonAccountTerms.has(ref.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    const key = shortRefs.join('\n');
    if (key !== exactRefKey) {
      exactRefKey = key;
      if (!shortRefs.length) {
        compiledShortRefs = null;
        compiledLegendShortRefs = null;
      } else {
        const alt = shortRefs.map(escapeRegex).join('|');
        compiledShortRefs = new RegExp(
          `(?:(?<=\\s[\\/·]\\s)(${alt})(?=$|（|\\s×|")|(?<=^|\\s)(${alt})(?=\\s·\\s(?:gateway_account_binding|configured_binding|gateway_binding|unverified|无绑定证据|未记录绑定证据)))`,
          'g'
        );
        compiledLegendShortRefs = new RegExp(`(?<=\\s[\\/·]\\s)(${alt})(?=$|（|，|\\s[\\/·]\\s)`, 'g');
      }
    }
    return compiledShortRefs;
  }

  function* patternHits(text, regex) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const value = match[0];
      const start = match.index ?? 0;
      const end = start + value.length;
      const isName = !value.includes('@');
      if (isName && ((WORD.test(value[0]) && joined(text, start - 1, -1)) || (WORD.test(value.at(-1) || '') && joined(text, end, 1)))) {
        continue;
      }
      if (isName && [...value].length < 2 && inWord(text, start, end)) continue;
      yield /** @type {[number, number]} */ ([start, end]);
    }
  }

  function conditionAccountRange(text) {
    const cond = CONDITION_ACCOUNT_RE.exec(text);
    if (!cond) return null;
    const body = cond[1];
    const bodyOffset = text.indexOf(body);
    if (bodyOffset < 0 || isSystemAccountText(body)) return null;
    const dupSuffix = body.indexOf(' · [');
    const cleanBody = dupSuffix >= 0 ? body.slice(0, dupSuffix) : body;
    const slash = cleanBody.lastIndexOf(' / ');
    if (slash >= 0) {
      const acc = cleanBody.slice(slash + 3);
      if (!isSystemAccountText(acc)) return /** @type {[number, number]} */ ([bodyOffset + slash + 3, bodyOffset + cleanBody.length]);
      return null;
    }
    return /** @type {[number, number]} */ ([bodyOffset, bodyOffset + cleanBody.length]);
  }

  function explicitElementRanges(text, element) {
    if (/^(?:≥\s*)?[\d,]+\s\/\s(?:≥\s*)?[\d,]+$/u.test(text)) return [];
    if (!element || typeof element.matches !== 'function') return null;
    if (element.matches(PURE_ACCOUNT_SELECTOR)) {
      const dupSuffix = text.indexOf(' · [');
      const end = dupSuffix > 0 ? dupSuffix : text.length;
      return isSystemAccountText(text.slice(0, end)) ? [] : [[0, end]];
    }
    if (element.matches(SUFFIXED_ACCOUNT_SELECTOR)) {
      if (isSystemAccountText(text)) return [];
      const suffixed = /^(.+?)(（(?:固定绑定|配置绑定|未核验)）)$/.exec(text);
      if (suffixed) return isSystemAccountText(suffixed[1]) ? [] : [[0, suffixed[1].length]];
      return [[0, text.length]];
    }
    if (element.matches(PREFIXED_ACCOUNT_SELECTOR)) {
      if (isSystemAccountText(text)) return [];
      if (text.startsWith('账号 ')) {
        return isSystemAccountText(text.slice(3)) ? [] : [[3, text.length]];
      }
    }
    if (element.matches('.dp-acc-collapsed-chips > .dp-acc-chip, .dp-acc-chip-list > .dp-acc-chip')) {
      const chip = /^(.+?)\s+×$/.exec(text);
      if (chip) return isSystemAccountText(chip[1]) ? [] : [[0, chip[1].length]];
    }
    if (element.matches('.task-preview-stats')) {
      const lead = /^(.+?)(?=\s·\s\d+\/\d+\s*完成)/.exec(text);
      return lead && !isSystemAccountText(lead[1]) ? [[0, lead[1].length]] : [];
    }
    if (element.matches('.analysis-history-option > span > span')) {
      const accSep = text.lastIndexOf(' / ');
      if (accSep >= 0) {
        const accStart = accSep + 3;
        return isSystemAccountText(text.slice(accStart)) ? [] : [[accStart, text.length]];
      }
    }
    if (element.matches('.dp-custom-chips > .dp-acc-chip')) {
      const sep = text.indexOf(' · ');
      if (sep > 0) return isSystemAccountText(text.slice(0, sep)) ? [] : [[0, sep]];
    }
    if (element.matches('.dp-models-hint')) {
      const hint = /^按 思考 × (.+) 展开$/.exec(text);
      if (hint) return isSystemAccountText(hint[1]) ? [] : [[7, 7 + hint[1].length]];
    }
    if (element.matches('.selected-target-info > span')) {
      const thinkSep = text.lastIndexOf(' · ');
      if (thinkSep > 0) {
        const head = text.slice(0, thinkSep);
        const accSep = head.lastIndexOf(' / ');
        if (accSep >= 0) {
          const accStart = accSep + 3;
          return isSystemAccountText(head.slice(accStart)) ? [] : [[accStart, thinkSep]];
        }
      }
    }
    return null;
  }

  function findAccountRanges(text, element = null, isAttribute = false) {
    if (!text) return [];
    if (!isAttribute) {
      const explicit = explicitElementRanges(text, element);
      if (explicit !== null) return mergeRanges(text, explicit);
    }
    /** @type {[number, number][]} */
    const ranges = [];
    const condRange = conditionAccountRange(text);
    if (condRange) ranges.push(condRange);
    if (isAttribute) {
      const rmChip = REMOVE_PICKER_CHIP_RE.exec(text);
      if (rmChip) ranges.push([text.length - rmChip[1].length, text.length]);
      const rmTarget = REMOVE_TARGET_RE.exec(text);
      if (rmTarget) {
        const start = text.lastIndexOf(`(${rmTarget[1]})`);
        if (start >= 0) ranges.push([start + 1, start + 1 + rmTarget[1].length]);
      }
      if (element?.matches?.('.dp-acc-pill:not(.dp-acc-auto), .dp-acc-cell')) {
        const suffixed = /^(.+?)(（(?:固定绑定|配置绑定|未核验)）)$/.exec(text);
        if (suffixed && !isSystemAccountText(suffixed[1])) ranges.push([0, suffixed[1].length]);
        else if (!isSystemAccountText(text)) ranges.push([0, text.length]);
      }
    }
    for (const regex of [BINDING_SUFFIX_RE, ACCOUNT_PREFIX_RE, JSON_ACCOUNT_REF_RE]) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        const group = match[1];
        if (!group || isSystemAccountText(group)) continue;
        const fullStart = match.index ?? 0;
        const offset = match[0].lastIndexOf(group);
        if (offset >= 0) ranges.push([fullStart + offset, fullStart + offset + group.length]);
      }
    }
    const shortRe = shortRefPattern();
    if (shortRe) {
      shortRe.lastIndex = 0;
      for (const match of text.matchAll(shortRe)) {
        const start = match.index ?? 0;
        ranges.push([start, start + match[0].length]);
      }
    }
    if (isAttribute && compiledLegendShortRefs && element?.matches?.('.chart-legend-item, .chart-legend-row')) {
      compiledLegendShortRefs.lastIndex = 0;
      for (const match of text.matchAll(compiledLegendShortRefs)) {
        const start = match.index ?? 0;
        ranges.push([start, start + match[0].length]);
      }
    }
    for (const hit of patternHits(text, finder())) ranges.push(hit);
    return mergeRanges(text, ranges);
  }

  function isSkippedElement(element) {
    if (!element) return true;
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.namespaceURI === SVG_NS || element.closest?.('svg')) return true;
    if (element.closest?.('.pii, [data-no-pii]')) return true;
    return false;
  }

  function maskAttribute(element, attrName, rawKey, maskedKey) {
    if (!element?.dataset || element.closest?.('[data-no-pii]') || element.namespaceURI === SVG_NS || element.closest?.('svg')) return;
    const current = element.getAttribute?.(attrName) ?? '';
    if (rawKey in element.dataset) {
      if (current === element.dataset[maskedKey]) return;
      delete element.dataset[rawKey];
      delete element.dataset[maskedKey];
    }
    if (!current) return;
    const ranges =
      attrName === 'data-account' ? (isSystemAccountText(current) ? [] : [[0, current.length]]) : findAccountRanges(current, element, true);
    if (!ranges.length) return;
    let out = '';
    let last = 0;
    for (const [start, end] of ranges) {
      out += current.slice(last, start) + maskBullets(current.slice(start, end));
      last = end;
    }
    out += current.slice(last);
    element.dataset[rawKey] = current;
    element.dataset[maskedKey] = out;
    element.setAttribute(attrName, out);
  }

  function maskSubtree(scope = view) {
    if (!scope || !ownerDoc) return;
    if (ownerDoc.createTreeWalker) {
      const walker = ownerDoc.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
      /** @type {Text[]} */
      const textNodes = [];
      for (let node; (node = /** @type {Text | null} */ (walker.nextNode()));) {
        if (!node.data || isSkippedElement(node.parentElement)) continue;
        textNodes.push(node);
      }
      for (const node of textNodes) {
        const text = node.data;
        const ranges = findAccountRanges(text, node.parentElement, false);
        if (!ranges.length) continue;
        const bits = [];
        let last = 0;
        for (const [start, end] of ranges) {
          if (start > last) bits.push(text.slice(last, start));
          const raw = text.slice(start, end);
          const span = ownerDoc.createElement('span');
          span.className = 'pii';
          span.dataset.raw = raw;
          span.textContent = maskStandIn(raw);
          bits.push(span);
          last = end;
        }
        if (last < text.length) bits.push(text.slice(last));
        // Keep split text wrapped in a single element so flex parents do not gain extra flex items.
        if (bits.length > 1) {
          const run = ownerDoc.createElement('span');
          run.className = 'pii-run';
          run.append(...bits);
          node.replaceWith(run);
        } else {
          node.replaceWith(...bits);
        }
      }
    }
    const attrTargets = new Set();
    if (scope.getAttribute) {
      if (scope.getAttribute('title') || scope.getAttribute('aria-label') || scope.getAttribute('data-account')) attrTargets.add(scope);
    }
    if (scope.querySelectorAll) {
      for (const el of scope.querySelectorAll('[title], [aria-label], [data-account]')) attrTargets.add(el);
    }
    for (const el of attrTargets) {
      maskAttribute(el, 'title', 'piiTitle', 'piiTitleMasked');
      maskAttribute(el, 'aria-label', 'piiAriaLabel', 'piiAriaLabelMasked');
      maskAttribute(el, 'data-account', 'piiAccount', 'piiAccountMasked');
    }
  }

  function unmaskAll() {
    if (!view?.querySelectorAll) return;
    for (const span of view.querySelectorAll('.pii')) {
      span.replaceWith(span.dataset?.raw ?? '');
    }
    for (const run of view.querySelectorAll('.pii-run')) {
      run.replaceWith(run.textContent ?? '');
    }
    view.normalize?.();
    for (const [attrName, rawKey, maskedKey] of [
      ['title', 'piiTitle', 'piiTitleMasked'],
      ['aria-label', 'piiAriaLabel', 'piiAriaLabelMasked'],
      ['data-account', 'piiAccount', 'piiAccountMasked']
    ]) {
      for (const el of view.querySelectorAll(`[data-${rawKey.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase())}]`)) {
        el.setAttribute(attrName, el.dataset[rawKey] ?? '');
        delete el.dataset[rawKey];
        delete el.dataset[maskedKey];
      }
    }
  }

  const OBSERVER_OPTIONS = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label', 'data-account']
  };

  const watch = MutationObserverImpl
    ? new MutationObserverImpl(records => {
        if (!masked || !view) return;
        watch.disconnect();
        const roots = new Set();
        for (const record of records) {
          const target = record.target?.nodeType === 3 ? record.target.parentElement : record.target;
          if (target?.isConnected !== false && target) roots.add(target);
        }
        const topRoots = [...roots].filter(candidate => ![...roots].some(other => other !== candidate && other.contains?.(candidate)));
        for (const target of topRoots) maskSubtree(target);
        watch.observe(view, OBSERVER_OPTIONS);
      })
    : null;

  function syncButton(on) {
    if (!button) return;
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? '账号已打码，点击显示' : '给所有页面的账号（邮箱地址和账号名）打码，方便截图分享';
    const path = button.querySelector?.('path');
    if (path) path.setAttribute('d', on ? EYE_OFF : EYE);
    const label = button.querySelector?.('#mask-accounts-label, [data-mask-label]');
    if (label) label.textContent = on ? '账号已打码' : '账号打码';
  }

  function applyPageMask(on) {
    masked = on;
    view?.classList?.toggle?.('masked', on);
    watch?.disconnect();
    unmaskAll();
    if (on && view) {
      maskSubtree(view);
      watch?.observe(view, OBSERVER_OPTIONS);
    }
  }

  function setMasked(next, { persist = true, animate = false } = {}) {
    const on = Boolean(next);
    if (persist && store) {
      try {
        store.setItem(ACCOUNT_MASK_STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* Sandboxed opaque-origin frames deny localStorage; keep session state in memory. */
      }
    }
    syncButton(on);
    app?.setMaskAccounts?.(on);
    applyPageMask(on);
    if (animate && on && view?.classList) {
      view.classList.add('masking');
      if (maskingTimer !== null) clearTimeout(maskingTimer);
      maskingTimer = setTimeout(() => {
        maskingTimer = null;
        view.classList.remove('masking');
      }, 450);
    } else if (!on && view?.classList) {
      if (maskingTimer !== null) clearTimeout(maskingTimer);
      maskingTimer = null;
      view.classList.remove('masking');
    }
  }

  function noteAccounts(payload) {
    const changed = scanPayload(payload);
    if (changed && masked) applyPageMask(true);
    return changed;
  }

  const onButtonClick = () => {
    setMasked(!masked, { persist: true, animate: !masked });
  };
  button?.addEventListener?.('click', onButtonClick);

  const onStorage = event => {
    if (event?.key !== ACCOUNT_MASK_STORAGE_KEY) return;
    const next = event.newValue === '1';
    if (next !== masked) setMasked(next, { persist: false, animate: false });
  };
  hostWin?.addEventListener?.('storage', onStorage);

  const onApiPayload = event => {
    noteAccounts(event?.detail);
  };
  hostWin?.addEventListener?.('mini-bench:api-payload', onApiPayload);

  const unsubscribeRoutes = app?.on?.('mini-bench:routes-changed', () => {
    noteAccounts(app.targets?.routes);
  });

  if (app?.targets?.routes?.length) noteAccounts(app.targets.routes);

  let initial = false;
  if (store) {
    try {
      initial = store.getItem(ACCOUNT_MASK_STORAGE_KEY) === '1';
    } catch {
      initial = false;
    }
  }
  setMasked(initial, { persist: false, animate: false });

  return {
    get on() {
      return masked;
    },
    set: (on, options) => setMasked(on, options),
    toggle: () => setMasked(!masked, { persist: true, animate: !masked }),
    noteAccounts,
    refresh: () => {
      if (masked) applyPageMask(true);
    },
    destroy() {
      watch?.disconnect();
      if (maskingTimer !== null) clearTimeout(maskingTimer);
      maskingTimer = null;
      button?.removeEventListener?.('click', onButtonClick);
      hostWin?.removeEventListener?.('storage', onStorage);
      hostWin?.removeEventListener?.('mini-bench:api-payload', onApiPayload);
      unsubscribeRoutes?.();
      unmaskAll();
      view?.classList?.remove?.('masked', 'masking');
    }
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.MiniBench) {
  const toggleButton = document.getElementById('mask-accounts');
  if (toggleButton) {
    const app = getAppContext();
    const masker = createAccountMasker({ root: document.body, button: toggleButton, app });
    window.MiniBench.accountMask = masker;
  }
}
