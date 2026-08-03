(function () {
  'use strict';

  var prefetchCache = Object.create(null);
  var scriptPromises = Object.create(null);
  var MODULE_SCRIPTS = {
    shared_files: ['js/shared-file-library.js'],
    notice_publish: ['js/shared-file-library.js', 'js/notice-enhance.js'],
    competition_management: ['js/competition-management.js'],
    application_center: ['js/shared-file-library.js', 'js/holiday-leave.js', 'js/application-center.js'],
    literature_library: ['js/shared-file-library.js', 'js/literature-library.js'],
    literature_analysis: ['js/shared-file-library.js', 'js/literature-compare.js'],
    document_analysis: ['js/shared-file-library.js', 'js/document-analysis.js'],
    project_report: ['js/shared-file-library.js', 'js/project-report.js'],
    dataset_library: ['js/dataset-library.js'],
    my_projects: ['js/my-projects.js'],
    my_achievements: ['js/my-achievements.js'],
    excel: ['js/excel-tools.js']
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

  function findScriptByPath(path) {
    var byData = document.querySelector('script[data-module-asset="' + path + '"]');
    if (byData) return byData;
    var nodes = document.getElementsByTagName('script');
    for (var i = 0; i < nodes.length; i++) {
      var src = nodes[i].getAttribute('src') || '';
      if (src.indexOf(path) !== -1) return nodes[i];
    }
    return null;
  }

  function isRealCloudUploadApi() {
    return typeof window.saveFileForTeam === 'function'
      && window.saveFileForTeam.__isCloudStub !== true
      && typeof window.cloudFileDownloadUrl === 'function'
      && window.cloudFileDownloadUrl.__isCloudStub !== true;
  }

  function loadScript(path) {
    if (scriptPromises[path]) return scriptPromises[path];
    scriptPromises[path] = new Promise(function (resolve, reject) {
      // 共享上传库：若真实 API 已挂好，无需再注入
      if (path === 'js/shared-file-library.js' && isRealCloudUploadApi()) {
        var readyTag = findScriptByPath(path);
        if (readyTag) readyTag.dataset.loaded = '1';
        resolve(true);
        return;
      }
      var existing = findScriptByPath(path);
      if (existing && existing.dataset.loaded === '1') {
        resolve(true);
        return;
      }
      // 不复用已完成的 script 标签（onload 不会再次触发，会导致 Promise 挂死）
      var script = document.createElement('script');
      script.src = assetUrl(path);
      script.async = false;
      script.dataset.moduleAsset = path;
      script.onload = function () {
        script.dataset.loaded = '1';
        script.dataset.moduleAssetLoaded = '1';
        resolve(true);
      };
      script.onerror = function () {
        delete scriptPromises[path];
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('模块脚本加载失败：' + path));
      };
      document.head.appendChild(script);
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

  /** 确保云端上传 API 可用（头像/附件等入口可能早于共享文件模块） */
  async function ensureCloudUploadReady() {
    if (isRealCloudUploadApi()) return true;
    await loadScript('js/shared-file-library.js');
    if (!isRealCloudUploadApi()) {
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    if (!isRealCloudUploadApi()) {
      throw new Error('云端上传模块加载失败，请强制刷新（Ctrl+F5）后重试');
    }
    return true;
  }

  async function saveFileForTeamAuto(file, options) {
    await ensureCloudUploadReady();
    var impl = window.saveFileForTeam;
    if (!impl || impl.__isCloudStub === true) {
      throw new Error('云端上传模块加载失败，请强制刷新（Ctrl+F5）后重试');
    }
    return impl(file, options);
  }
  saveFileForTeamAuto.__isCloudStub = true;

  function cloudFileDownloadUrlAuto(fileId) {
    if (isRealCloudUploadApi()) return window.cloudFileDownloadUrl(fileId);
    // 同步场景：先拼基础 URL，token 在模块加载后由真实实现补齐
    var id = String(fileId || '').trim();
    if (!id) return '';
    var url = '/api/shared-file/download?fileId=' + encodeURIComponent(id);
    try {
      var session = window.GatewayAuth && window.GatewayAuth.read
        ? window.GatewayAuth.read()
        : null;
      if (session && session.token) url += '&access=' + encodeURIComponent(session.token);
    } catch (e) { /* ignore */ }
    return url;
  }
  cloudFileDownloadUrlAuto.__isCloudStub = true;

  async function uploadFileToCloudAuto(file, options) {
    await ensureCloudUploadReady();
    var impl = window.uploadFileToCloud;
    if (!impl || impl.__isCloudStub === true) {
      throw new Error('云端上传接口不可用');
    }
    return impl(file, options);
  }
  uploadFileToCloudAuto.__isCloudStub = true;

  // 在共享库脚本加载前提供可调用的全局入口，避免「未打开共享文件就上传」失败
  if (typeof window.saveFileForTeam !== 'function') {
    window.saveFileForTeam = saveFileForTeamAuto;
  }
  if (typeof window.cloudFileDownloadUrl !== 'function') {
    window.cloudFileDownloadUrl = cloudFileDownloadUrlAuto;
  }
  if (typeof window.uploadFileToCloud !== 'function') {
    window.uploadFileToCloud = uploadFileToCloudAuto;
  }
  window.ensureCloudUploadReady = ensureCloudUploadReady;
  window.requireCloudUpload = async function requireCloudUpload() {
    await ensureCloudUploadReady();
    return {
      saveFileForTeam: window.saveFileForTeam,
      cloudFileDownloadUrl: window.cloudFileDownloadUrl,
      uploadFileToCloud: window.uploadFileToCloud
    };
  };
  window.loadModuleAssetScript = loadScript;

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
