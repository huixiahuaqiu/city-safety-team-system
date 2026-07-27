/**
 * GitHub Pages 静态演示启动：
 * - 关闭网关鉴权（静态站没有后端）
 * - 注入 data/pages-snapshot.json，让访客看到同一份演示数据
 */
(function () {
    'use strict';

    function isGitHubPages() {
        try {
            var host = String(location.hostname || '');
            return /\.github\.io$/i.test(host);
        } catch (e) {
            return false;
        }
    }

    function forcePagesConfig() {
        window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, {
            APP_ENV: 'pages',
            SHOW_DEMO_ACCOUNTS: true,
            GATEWAY_AUTH_ENABLED: false,
            DATA_BACKEND: 'local',
            API_PROXY: '',
            STATIC_PAGES_DEMO: true
        });
    }

    function snapshotUrl() {
        // 相对当前页面目录，兼容 /city-safety-team-system/123123/
        var base = String(location.pathname || '/');
        if (!/\/$/.test(base)) {
            base = base.replace(/\/[^/]*$/, '/');
        }
        return base + 'data/pages-snapshot.json';
    }

    var SKIP = {
        currentSession: 1,
        dashscopeApiKey: 1,
        openaiApiKey: 1,
        apiKey: 1,
        AUTH_TOKEN: 1,
        gatewayAuthToken: 1,
        loginAttempts: 1
    };

    function applySnapshot(payload) {
        if (!payload || !payload.data || typeof payload.data !== 'object') return false;
        var meta = payload.meta || {};
        var version = String(meta.version || '');
        var applied = String(localStorage.getItem('__pagesSnapshotVersion') || '');
        // 同版本且已有成员数据则不重复覆盖用户本地改动
        try {
            var existing = JSON.parse(localStorage.getItem('teamMemberData') || '[]');
            if (applied === version && Array.isArray(existing) && existing.length >= 20) {
                return false;
            }
        } catch (e) {}

        Object.keys(payload.data).forEach(function (key) {
            if (SKIP[key]) return;
            var val = payload.data[key];
            try {
                localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
            } catch (err) {
                console.warn('[pages-static-boot] setItem failed', key, err);
            }
        });
        if (version) localStorage.setItem('__pagesSnapshotVersion', version);
        try {
            sessionStorage.setItem('__pagesSnapshotJustApplied', '1');
        } catch (e2) {}
        return true;
    }

    function showBanner(text) {
        try {
            var id = 'citysafePagesBanner';
            if (document.getElementById(id)) return;
            var el = document.createElement('div');
            el.id = id;
            el.setAttribute('role', 'status');
            el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483646;padding:10px 14px;border-radius:12px;background:#0f172a;color:#e2e8f0;font:600 13px/1.45 sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.28);opacity:.96;';
            el.textContent = text;
            (document.body || document.documentElement).appendChild(el);
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 8000);
        } catch (e) {}
    }

    if (!isGitHubPages() && !(window.APP_CONFIG && window.APP_CONFIG.STATIC_PAGES_DEMO)) {
        return;
    }

    forcePagesConfig();

    // 同步拉取快照，保证在 app-core / 登录初始化前写入 localStorage
    var applied = false;
    try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', snapshotUrl() + '?v=' + Date.now(), false);
        xhr.send(null);
        if (xhr.status >= 200 && xhr.status < 300) {
            applied = applySnapshot(JSON.parse(xhr.responseText));
        } else {
            console.warn('[pages-static-boot] snapshot HTTP', xhr.status);
        }
    } catch (err) {
        console.warn('[pages-static-boot] snapshot load failed', err);
    }

    if (applied) {
        // 避免重复 reload：仅当本会话尚未因快照刷新过
        try {
            if (sessionStorage.getItem('__pagesSnapshotReloaded') !== '1') {
                sessionStorage.setItem('__pagesSnapshotReloaded', '1');
                location.reload();
                return;
            }
        } catch (e3) {}
    }

    document.addEventListener('DOMContentLoaded', function () {
        showBanner('当前为 GitHub Pages 静态演示（快照数据）。登录可用演示账号，密码 123456。多人协作请使用正式服务器。');
    });
})();
