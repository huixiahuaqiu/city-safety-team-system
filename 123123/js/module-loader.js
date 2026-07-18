(function () {
  'use strict';

  var prefetchCache = Object.create(null);

  async function loadModuleHtml(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    if (el.getAttribute('data-lazy') !== '1') return false;
    if (el.getAttribute('data-loaded') === '1') return true;

    var text = (el.textContent || '').replace(/\s+/g, '');
    if (text.length > 40 && el.children.length > 0) return false;

    try {
      var html = prefetchCache[id];
      if (!html) {
        var res = await fetch('modules/' + encodeURIComponent(id) + '.html?v=20260716-ach3', { credentials: 'same-origin' });
        if (!res.ok) {
          console.warn('[loadModuleHtml] fetch failed', id, res.status);
          return false;
        }
        html = await res.text();
        prefetchCache[id] = html;
      }
      el.innerHTML = html;
      el.setAttribute('data-loaded', '1');
      return true;
    } catch (err) {
      console.warn('[loadModuleHtml] error', id, err);
      return false;
    }
  }

  function prefetchModuleHtml(id) {
    if (!id || prefetchCache[id]) return;
    var el = document.getElementById(id);
    if (!el || el.getAttribute('data-lazy') !== '1' || el.getAttribute('data-loaded') === '1') return;
    fetch('modules/' + encodeURIComponent(id) + '.html?v=20260716-ach3', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) { if (html) prefetchCache[id] = html; })
      .catch(function () {});
  }

  function bindNavPrefetch() {
    document.querySelectorAll('.nav-item[onclick]').forEach(function (item) {
      var oc = item.getAttribute('onclick') || '';
      var m = oc.match(/showModule\(\s*['\"]([^'\"]+)['\"]\s*\)/);
      if (!m) return;
      var mid = m[1];
      item.addEventListener('mouseenter', function () { prefetchModuleHtml(mid); }, { passive: true });
      item.addEventListener('focus', function () { prefetchModuleHtml(mid); }, { passive: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindNavPrefetch);
  } else {
    bindNavPrefetch();
  }

  window.loadModuleHtml = loadModuleHtml;
  window.prefetchModuleHtml = prefetchModuleHtml;
  window.__moduleHtmlCache = prefetchCache;
  window.forceReloadModuleHtml = function (id) {
    delete prefetchCache[id];
    var el = document.getElementById(id);
    if (!el) return Promise.resolve(false);
    el.setAttribute('data-loaded', '0');
    el.innerHTML = '<!-- lazy reload -->';
    return loadModuleHtml(id);
  };
})();
