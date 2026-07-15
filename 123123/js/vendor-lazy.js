/**
 * 非首屏第三方库按需加载。首屏只保留 Tailwind + ECharts。
 * 用法：await ensureVendor('xlsx') 后再调用 XLSX.*
 */
(function (global) {
  'use strict';

  var LOADING = {};
  var LOADED = {};

  var MAP = {
    xlsx: ['vendor/xlsx/xlsx.full.min.js'],
    pdfjs: ['vendor/pdfjs/pdf.min.js'],
    mammoth: ['vendor/mammoth/mammoth.browser.min.js'],
    cropper: ['vendor/cropperjs/cropper.css', 'vendor/cropperjs/cropper.min.js'],
    wangeditor: ['vendor/wangeditor/style.css', 'vendor/wangeditor/index.min.js'],
    jszip: ['vendor/jszip/jszip.min.js']
  };

  function loadOne(url) {
    return new Promise(function (resolve, reject) {
      var isCss = /\.css(\?|$)/i.test(url);
      if (isCss) {
        if (document.querySelector('link[data-vendor="' + url + '"]')) {
          resolve();
          return;
        }
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.setAttribute('data-vendor', url);
        link.onload = function () { resolve(); };
        link.onerror = function () { reject(new Error('css load fail: ' + url)); };
        document.head.appendChild(link);
        return;
      }
      if (document.querySelector('script[data-vendor="' + url + '"]')) {
        resolve();
        return;
      }
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.setAttribute('data-vendor', url);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('js load fail: ' + url)); };
      document.head.appendChild(s);
    });
  }

  function ensureVendor(name) {
    var key = String(name || '').toLowerCase();
    if (LOADED[key]) return Promise.resolve(true);
    if (LOADING[key]) return LOADING[key];
    var urls = MAP[key];
    if (!urls) return Promise.reject(new Error('unknown vendor: ' + name));
    LOADING[key] = Promise.all(urls.map(loadOne)).then(function () {
      LOADED[key] = true;
      delete LOADING[key];
      if (key === 'pdfjs' && global.pdfjsLib && global.pdfjsLib.GlobalWorkerOptions) {
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
      }
      return true;
    });
    return LOADING[key];
  }

  /** 根据文件扩展名预加载解析库 */
  function ensureVendorsForFile(fileName) {
    var n = String(fileName || '').toLowerCase();
    var jobs = [];
    if (/\.(xlsx?|xls)$/.test(n)) jobs.push(ensureVendor('xlsx'));
    if (/\.pdf$/.test(n)) jobs.push(ensureVendor('pdfjs'));
    if (/\.docx?$/.test(n)) jobs.push(ensureVendor('mammoth'));
    return Promise.all(jobs);
  }

  global.ensureVendor = ensureVendor;
  global.ensureVendorsForFile = ensureVendorsForFile;
})(window);
