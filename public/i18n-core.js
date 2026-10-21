// OCTA interface translation.
// The interface is written in Traditional Chinese; this swaps visible text for the chosen language.
// Dictionaries live in i18n-*.js (keys are the original Chinese text). Anything inside [data-u]
// (bot names, messages, user-written text) is never translated.
(function () {
  const LANGS = { 'zh-TW': '繁體中文', en: 'English', 'zh-CN': '简体中文', ja: '日本語' };
  const pick = () => {
    try { const s = localStorage.getItem('octa_lang'); if (s && LANGS[s]) return s; } catch (e) { }
    const n = (navigator.language || 'zh-TW').toLowerCase();
    if (/^zh-(tw|hk|mo)|hant/.test(n)) return 'zh-TW';
    if (n.startsWith('zh')) return 'zh-CN';
    if (n.startsWith('ja')) return 'ja';
    return 'en';
  };
  let lang = pick(), busy = false;
  const D = () => (window.OCTA_I18N || {})[lang] || null;
  const SKIP = 'script,style,pre,code,[data-u]';   // subtrees left alone
  const NOTEXT = 'textarea,option[data-u]';           // keep their text (form values), still translate attributes
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const HAN = /[㐀-鿿！-～　-〿]/;

  function tr(s) {
    const d = D();
    if (!d || !s || !HAN.test(s)) return s;
    const key = s.trim();
    if (!key) return s;
    let out = d.t[key];
    if (out === undefined) {
      d._re = d._re || (d.p || []).map(([r, rep]) => [new RegExp(r), rep]);
      for (const [re, rep] of d._re) { const m = key.match(re); if (m) { out = rep.replace(/\$(\d)/g, (_, i) => (m[i] === undefined ? '' : (d.t[m[i]] ?? m[i]))); break; } }
    }
    if (out === undefined && d.cm) out = [...key].map(c => d.cm[c] || c).join('');   // Simplified Chinese fallback
    if (out === undefined) return s;
    return s.replace(key, out);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return text(root);
    if (root.nodeType !== 1 || root.closest?.(SKIP)) return;
    for (const a of ATTRS) if (root.hasAttribute(a)) attr(root, a);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    let n; while ((n = it.nextNode())) { if (n.nodeType === 3) text(n); else for (const a of ATTRS) if (n.hasAttribute(a)) attr(n, a); }
  }
  function text(n) {
    const p = n.parentElement;
    if (!p || p.closest(SKIP) || p.matches(NOTEXT)) return;
    if (n._o === undefined || (n.nodeValue !== n._t)) n._o = n.nodeValue;   // remember the original Chinese
    const v = lang === 'zh-TW' ? n._o : tr(n._o);
    n._t = v;
    if (n.nodeValue !== v) n.nodeValue = v;
  }
  function attr(el, a) {
    el._oa = el._oa || {};
    const cur = el.getAttribute(a);
    if (el._oa[a] === undefined || cur !== el._ta?.[a]) el._oa[a] = cur;
    const v = lang === 'zh-TW' ? el._oa[a] : tr(el._oa[a]);
    (el._ta = el._ta || {})[a] = v;
    if (cur !== v) el.setAttribute(a, v);
  }
  const mo = new MutationObserver(list => {
    if (busy) return;
    busy = true;
    try {
      for (const m of list) {
        if (m.type === 'characterData') text(m.target);
        else if (m.type === 'attributes') { if (!m.target.closest(SKIP)) attr(m.target, m.attributeName); }
        else m.addedNodes.forEach(walk);
      }
    } finally { busy = false; }
  });
  function apply() { busy = true; try { walk(document.body); } finally { busy = false; } document.documentElement.lang = lang; }
  window.I18N = {
    langs: LANGS,
    get lang() { return lang; },
    t: s => (lang === 'zh-TW' ? s : tr(s)),
    set(l) { if (!LANGS[l]) return; lang = l; try { localStorage.setItem('octa_lang', l); } catch (e) { } apply(); window.dispatchEvent(new Event('octa-lang')); },
    select(id) { return `<select id="${id}" class="langsel" data-u aria-label="Language">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === lang ? 'selected' : ''}>${v}</option>`).join('')}</select>`; }
  };
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  });
})();
