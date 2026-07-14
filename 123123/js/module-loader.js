(function () {
  'use strict';

  async function loadModuleHtml(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    if (el.getAttribute('data-lazy') !== '1') return false;
    if (el.getAttribute('data-loaded') === '1') return true;

    // 允许壳内仅有注释/空白占位
    var text = (el.textContent || '').replace(/\s+/g, '');
    if (text.length > 40 && el.children.length > 0) return false;

    try {
      var res = await fetch('modules/' + encodeURIComponent(id) + '.html', { credentials: 'same-origin' });
      if (!res.ok) {
        console.warn('[loadModuleHtml] fetch failed', id, res.status);
        return false;
      }
      var html = await res.text();
      el.innerHTML = html;
      el.setAttribute('data-loaded', '1');
      return true;
    } catch (err) {
      console.warn('[loadModuleHtml] error', id, err);
      return false;
    }
  }

  window.loadModuleHtml = loadModuleHtml;
})();
