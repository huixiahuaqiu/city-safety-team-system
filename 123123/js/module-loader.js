(function () {
  'use strict';

  var prefetchCache = Object.create(null);
  var scriptPromises = Object.create(null);
  var MODULE_SCRIPTS = {
    excel: ['js/excel-tools.js'],
    my_projects: ['js/my-projects.js'],
    my_achievements: ['js/my-achievements.js'],
    literature_analysis: ['js/literature-compare.js'],
    document_analysis: ['js/document-analysis.js'],
    literature_library: ['js/literature-library.js'],
    dataset_library: ['js/dataset-library.js'],
    project_report: ['js/project-report.js'],
    shared_files: ['js/shared-file-library.js'],
    notice_publish: ['js/notice-enhance.js'],
    competition_management: ['js/competition-management.js'],
    application_center: ['js/holiday-leave.js', 'js/application-center.js']
  };

  // 依据构建期生成的 __MODULE_VERSIONS（见 js/module-manifest.js）拼接带内容哈希的
  // 模块 URL；取不到版本时退化为无 ?v=，保证永远能加载到最新文件（安全兜底）。
  function moduleUrl(id) {
    var v = (window.__MODULE_VERSIONS && window.__MODULE_VERSIONS[id]) || '';
    return 'modules/' + encodeURIComponent(id) + '.html' + (v ? '?v=' + v : '');
  }

  function assetUrl(path) {
    var v = (window.__ASSET_VERSIONS && window.__ASSET_VERSIONS[path]) || '';
    return path + (v ? '?v=' + v : '');
  }

  function loadScript(path) {
    if (scriptPromises[path]) return scriptPromises[path];
    scriptPromises[path] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-module-asset="' + path + '"]');
      if (existing && existing.dataset.loaded === '1') {
        resolve(true);
        return;
      }
      var script = existing || document.createElement('script');
      script.src = assetUrl(path);
      script.async = false;
      script.dataset.moduleAsset = path;
      script.onload = function () {
        script.dataset.loaded = '1';
        resolve(true);
      };
      script.onerror = function () {
        delete scriptPromises[path];
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('模块脚本加载失败：' + path));
      };
      if (!existing) document.head.appendChild(script);
    });
    return scriptPromises[path];
  }

  async function loadModuleScripts(id) {
    var scripts = MODULE_SCRIPTS[id] || [];
    for (var i = 0; i < scripts.length; i++) {
      await loadScript(scripts[i]);
    }
    return true;
  }

  async function loadModuleHtml(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    try {
      if (el.getAttribute('data-lazy') === '1' && el.getAttribute('data-loaded') !== '1') {
        var text = (el.textContent || '').replace(/\s+/g, '');
        if (!(text.length > 40 && el.children.length > 0)) {
          var html = prefetchCache[id];
          if (!html) {
            var res = await fetch(moduleUrl(id), { credentials: 'same-origin' });
            if (!res.ok) {
              console.warn('[loadModuleHtml] fetch failed', id, res.status);
              return false;
            }
            html = await res.text();
            prefetchCache[id] = html;
          }
          el.innerHTML = html;
          el.setAttribute('data-loaded', '1');
        }
      }
      await loadModuleScripts(id);
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
    fetch(moduleUrl(id), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) { if (html) prefetchCache[id] = html; })
      .catch(function () {});
    (MODULE_SCRIPTS[id] || []).forEach(function (path) {
      if (document.querySelector('link[data-module-preload="' + path + '"]')) return;
      var link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'script';
      link.href = assetUrl(path);
      link.dataset.modulePreload = path;
      document.head.appendChild(link);
    });
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
  window.loadModuleScripts = loadModuleScripts;
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
