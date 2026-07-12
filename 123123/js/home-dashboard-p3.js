/**
 * 首页工作台 · 第三优先级增强
 * - 聚合缓存（5 分钟，待办/通知不缓存）
 * - 跨标签页实时广播 + 变更失效
 * - 快捷入口自定义 / 三栏布局偏好
 * - 同步日志面板、失败站内信告警
 * - 数据一致性校验
 * - 角色差异化布局
 */
(function (global) {
    'use strict';

    var OVERVIEW_CACHE_TTL = 5 * 60 * 1000;
    var LAYOUT_PREF_KEY = 'homeLayoutPrefs_v1';
    var QUICK_CATALOG_KEY = 'homeQuickCatalog_v1';
    var SYNC_ALERT_COOLDOWN_KEY = 'homeSyncAlertCooldown_v1';
    var overviewCache = { at: 0, stats: null, role: '' };

    function esc(s) {
        if (typeof global.escHtml === 'function') return global.escHtml(s);
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function getRoleKind() {
        if (typeof global.getHomeRoleKind === 'function') return global.getHomeRoleKind();
        return 'guest';
    }

    /* ---------- 缓存 ---------- */
    function invalidateHomeOverviewCache(reason) {
        overviewCache = { at: 0, stats: null, role: '' };
        try {
            if (global.homeDashUi) global.homeDashUi.lastOverview = null;
        } catch (e) {}
        try {
            if (global.__homeRealtimeBroadcast) {
                global.__homeRealtimeBroadcast({ type: 'cache-invalidate', reason: reason || '' });
            }
        } catch (e2) {}
    }
    global.invalidateHomeOverviewCache = invalidateHomeOverviewCache;

    function wrapOverviewWithCache() {
        if (typeof global.getHomeDashboardOverview !== 'function') return;
        if (global.getHomeDashboardOverview.__cached) return;
        var raw = global.getHomeDashboardOverview;
        global.getHomeDashboardOverview = function () {
            var role = getRoleKind();
            var now = Date.now();
            var fresh = raw();
            // 待办 / 通知 / 动态始终用最新；统计可走缓存
            if (
                overviewCache.stats &&
                overviewCache.role === role &&
                now - overviewCache.at < OVERVIEW_CACHE_TTL
            ) {
                fresh.patents = overviewCache.stats.patents;
                fresh.papers = overviewCache.stats.papers;
                fresh.projects = overviewCache.stats.projects;
                fresh.members = overviewCache.stats.members;
                fresh._fromCache = true;
                fresh._cacheAgeMs = now - overviewCache.at;
            } else {
                overviewCache = {
                    at: now,
                    role: role,
                    stats: {
                        patents: fresh.patents,
                        papers: fresh.papers,
                        projects: fresh.projects,
                        members: fresh.members
                    }
                };
                fresh._fromCache = false;
                fresh._cacheAgeMs = 0;
            }
            return fresh;
        };
        global.getHomeDashboardOverview.__cached = true;
        global.getHomeDashboardOverview.__raw = raw;
    }

    /* ---------- 实时广播 ---------- */
    var bc = null;
    try {
        if (typeof BroadcastChannel !== 'undefined') bc = new BroadcastChannel('city-safety-home');
    } catch (eBc) { bc = null; }

    function broadcast(msg) {
        try {
            if (bc) bc.postMessage(Object.assign({ ts: Date.now() }, msg || {}));
        } catch (e) {}
        try {
            localStorage.setItem('__homeRealtimePing', String(Date.now()) + ':' + (msg && msg.type || ''));
        } catch (e2) {}
    }
    global.__homeRealtimeBroadcast = broadcast;

    function onRealtimeMessage(msg) {
        if (!msg || !msg.type) return;
        if (msg.type === 'cloud-applied' || msg.type === 'cache-invalidate' || msg.type === 'data-changed') {
            invalidateHomeOverviewCache(msg.type);
            try {
                if (typeof global.renderHomeDashboard === 'function') global.renderHomeDashboard();
            } catch (e) {}
            try {
                if (typeof global.refreshGlobalNoticeCenter === 'function') global.refreshGlobalNoticeCenter();
            } catch (e2) {}
        }
    }

    if (bc) {
        bc.onmessage = function (ev) { onRealtimeMessage(ev.data); };
    }
    global.addEventListener('storage', function (ev) {
        if (!ev) return;
        if (ev.key === '__homeRealtimePing') {
            onRealtimeMessage({ type: 'data-changed' });
            return;
        }
        var hot = {
            patentData: 1, paperData: 1, taskData: 1, noticeData: 1, newsData: 1,
            weeklyReportData: 1, meetingData: 1, teamMemberData: 1,
            longitudinalData: 1, horizontalData: 1, schoolData: 1
        };
        if (ev.key && hot[ev.key]) {
            invalidateHomeOverviewCache('storage:' + ev.key);
            try {
                if (document.getElementById('home') && document.getElementById('home').classList.contains('active')) {
                    if (typeof global.renderHomeDashboard === 'function') global.renderHomeDashboard();
                }
            } catch (e) {}
        }
    });

    /* ---------- 失败站内信 ---------- */
    function notifyHomeSyncFailure(errMsg) {
        var cooldown = 0;
        try { cooldown = Number(localStorage.getItem(SYNC_ALERT_COOLDOWN_KEY) || 0) || 0; } catch (e) {}
        if (Date.now() - cooldown < 30 * 60 * 1000) return;
        try { localStorage.setItem(SYNC_ALERT_COOLDOWN_KEY, String(Date.now())); } catch (e2) {}

        var siteOn = true;
        try {
            var cfg = JSON.parse(localStorage.getItem('systemConfigData') || '{}');
            if (cfg && cfg.notice && cfg.notice.siteMessage === false) siteOn = false;
        } catch (e3) {}
        if (!siteOn) return;
        if (typeof global.normalizeNoticeRecord !== 'function' || typeof global.saveNoticeData !== 'function') return;
        if (!Array.isArray(global.noticeData)) {
            try { global.noticeData = JSON.parse(localStorage.getItem('noticeData') || '[]') || []; } catch (eLoad) { return; }
        }

        var adminNames = [];
        try {
            (global.accountData || JSON.parse(localStorage.getItem('accountData') || '[]') || []).forEach(function (a) {
                if (a && (a.role === 'admin' || a.role === 'leader') && a.realName) adminNames.push(a.realName);
            });
        } catch (e4) {}
        if (!adminNames.length) adminNames = ['系统管理员'];

        var id = Date.now();
        var notice = global.normalizeNoticeRecord({
            id: id,
            title: '【系统告警】云端同步失败',
            type: 'urgent',
            content: '关键数据云端同步失败：' + String(errMsg || '未知错误') +
                '。请检查网络与 Supabase 配置，并在首页右下角执行「全量同步」。时间：' + new Date().toLocaleString('zh-CN'),
            startTime: new Date().toISOString().slice(0, 16).replace('T', ' '),
            endTime: '',
            publishTime: new Date().toLocaleString('zh-CN'),
            publisher: '系统',
            audience: 'custom',
            audienceNames: adminNames,
            pinned: true,
            status: 'published',
            reads: []
        });
        // 避免重复刷屏：同标题未读告警 30 分钟内不重复
        var dup = (global.noticeData || []).some(function (n) {
            return n && n.title === notice.title && String(n.publishTime || '').slice(0, 10) === String(notice.publishTime).slice(0, 10);
        });
        if (dup) return;
        global.noticeData.push(notice);
        global.saveNoticeData({
            silent: false,
            log: { action: '系统告警', desc: '云端同步失败站内信', detail: { error: String(errMsg || '') } }
        });
        try {
            if (typeof global.showCloudSyncBanner === 'function') {
                global.showCloudSyncBanner('已向管理员发送同步失败站内信', true);
            }
        } catch (e5) {}
    }
    global.notifyHomeSyncFailure = notifyHomeSyncFailure;

    /* ---------- 快捷入口目录 / 自定义 ---------- */
    function quickCatalog() {
        return [
            { module: 'member_archive', ico: '团', t: '团队成员', badge: '' },
            { module: 'task_management', ico: '任', t: '任务待办', badge: 'task' },
            { module: 'notice_publish', ico: '通', t: '通知公告', badge: 'notice' },
            { module: 'weekly_report', ico: '报', t: '工作周报', badge: 'weekly' },
            { module: 'patent_management', ico: '果', t: '成果管理', badge: '' },
            { module: 'paper_management', ico: '论', t: '论文成果', badge: '' },
            { module: 'longitudinal_project', ico: '项', t: '项目管理', badge: '' },
            { module: 'literature_library', ico: '献', t: '文献资料', badge: '' },
            { module: 'dataset_library', ico: '数', t: '数据集', badge: '' },
            { module: 'meeting_management', ico: '会', t: '组会管理', badge: '' },
            { module: 'openai', ico: '智', t: '智能工具', badge: '' },
            { module: 'achievements', ico: '览', t: '团队成果', badge: '' },
            { module: 'news_management', ico: '闻', t: '新闻动态', badge: '' },
            { module: 'about', ico: '介', t: '团队介绍', badge: '' },
            { module: 'members', ico: '员', t: '公开成员', badge: '' }
        ];
    }

    function openHomeQuickCustomize() {
        var role = getRoleKind();
        var defaults = typeof global.getHomeQuickDefaults === 'function'
            ? global.getHomeQuickDefaults(role)
            : quickCatalog().slice(0, 6);
        var current = typeof global.loadHomeQuickPrefs === 'function'
            ? global.loadHomeQuickPrefs(role)
            : defaults.slice();
        var selected = {};
        current.forEach(function (it, idx) { selected[it.module] = { on: true, order: idx, item: it }; });

        var modal = document.getElementById('homeQuickCustomizeModal');
        if (!modal) return;
        var list = document.getElementById('homeQuickCustomizeList');
        var catalog = quickCatalog();
        list.innerHTML = catalog.map(function (it, idx) {
            var hit = selected[it.module];
            var checked = hit ? 'checked' : '';
            var order = hit ? hit.order : 100 + idx;
            return '<label class="home-customize-row" data-module="' + it.module + '" data-order="' + order + '">' +
                '<input type="checkbox" ' + checked + ' data-module="' + it.module + '">' +
                '<span class="ico">' + esc(it.ico) + '</span>' +
                '<span class="t">' + esc(it.t) + '</span>' +
                '<span class="ops">' +
                '<button type="button" data-move="-1">↑</button>' +
                '<button type="button" data-move="1">↓</button>' +
                '</span></label>';
        }).sort(function (a, b) {
            // re-sort by data-order via DOM after insert
            return 0;
        }).join('');

        // sort rows by order
        var rows = Array.prototype.slice.call(list.querySelectorAll('.home-customize-row'));
        rows.sort(function (a, b) {
            return Number(a.getAttribute('data-order')) - Number(b.getAttribute('data-order'));
        });
        rows.forEach(function (r) { list.appendChild(r); });

        list.onclick = function (ev) {
            var btn = ev.target.closest('button[data-move]');
            if (!btn) return;
            ev.preventDefault();
            var row = btn.closest('.home-customize-row');
            if (!row) return;
            var dir = Number(btn.getAttribute('data-move'));
            if (dir < 0 && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
            if (dir > 0 && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
        };

        modal.style.display = 'flex';
    }
    global.openHomeQuickCustomize = openHomeQuickCustomize;

    function saveHomeQuickCustomize() {
        var role = getRoleKind();
        var list = document.getElementById('homeQuickCustomizeList');
        if (!list) return;
        var catalogMap = {};
        quickCatalog().forEach(function (it) { catalogMap[it.module] = it; });
        var out = [];
        list.querySelectorAll('.home-customize-row').forEach(function (row) {
            var cb = row.querySelector('input[type="checkbox"]');
            if (!cb || !cb.checked) return;
            var mod = row.getAttribute('data-module');
            if (catalogMap[mod]) out.push(Object.assign({}, catalogMap[mod]));
        });
        if (!out.length) {
            alert('请至少保留一个快捷入口');
            return;
        }
        if (typeof global.saveHomeQuickPrefs === 'function') global.saveHomeQuickPrefs(role, out);
        else {
            try {
                var raw = JSON.parse(localStorage.getItem('homeQuickNavPrefs_v1') || '{}') || {};
                raw[role] = out;
                localStorage.setItem('homeQuickNavPrefs_v1', JSON.stringify(raw));
            } catch (e) {}
        }
        closeHomeQuickCustomize();
        try {
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('首页工作台', '偏好', '自定义快捷入口（' + role + '）共 ' + out.length + ' 项', { role: role, modules: out.map(function (x) { return x.module; }) }, { success: true }, 1, '', 0);
            }
        } catch (e2) {}
        if (typeof global.renderHomeDashboard === 'function') global.renderHomeDashboard();
    }
    global.saveHomeQuickCustomize = saveHomeQuickCustomize;

    function closeHomeQuickCustomize() {
        var modal = document.getElementById('homeQuickCustomizeModal');
        if (modal) modal.style.display = 'none';
    }
    global.closeHomeQuickCustomize = closeHomeQuickCustomize;

    function resetHomeQuickCustomize() {
        var role = getRoleKind();
        try {
            var raw = JSON.parse(localStorage.getItem('homeQuickNavPrefs_v1') || '{}') || {};
            delete raw[role];
            localStorage.setItem('homeQuickNavPrefs_v1', JSON.stringify(raw));
        } catch (e) {}
        closeHomeQuickCustomize();
        if (typeof global.renderHomeDashboard === 'function') global.renderHomeDashboard();
    }
    global.resetHomeQuickCustomize = resetHomeQuickCustomize;

    /* ---------- 布局偏好 ---------- */
    function loadLayoutPrefs() {
        try {
            var all = JSON.parse(localStorage.getItem(LAYOUT_PREF_KEY) || '{}') || {};
            return all[getRoleKind()] || { cols: ['todo', 'feed', 'member'], compact: false };
        } catch (e) {
            return { cols: ['todo', 'feed', 'member'], compact: false };
        }
    }
    function saveLayoutPrefs(prefs) {
        try {
            var all = JSON.parse(localStorage.getItem(LAYOUT_PREF_KEY) || '{}') || {};
            all[getRoleKind()] = prefs;
            localStorage.setItem(LAYOUT_PREF_KEY, JSON.stringify(all));
        } catch (e) {}
    }
    global.loadHomeLayoutPrefs = loadLayoutPrefs;
    global.saveHomeLayoutPrefs = saveLayoutPrefs;

    function applyHomeLayoutPrefs() {
        var prefs = loadLayoutPrefs();
        var grid = document.querySelector('#home .home-grid');
        if (!grid) return;
        var map = {
            todo: grid.querySelector('.home-col:nth-child(1)') || grid.children[0],
            feed: grid.querySelector('.home-col:nth-child(2)') || grid.children[1],
            member: grid.querySelector('.home-col:nth-child(3)') || grid.children[2]
        };
        // 用 data-col 标记，避免多次应用错乱
        Array.prototype.forEach.call(grid.children, function (col, idx) {
            if (!col.getAttribute('data-col')) {
                col.setAttribute('data-col', idx === 0 ? 'todo' : (idx === 1 ? 'feed' : 'member'));
            }
        });
        var byKey = {};
        Array.prototype.forEach.call(grid.querySelectorAll('.home-col[data-col]'), function (col) {
            byKey[col.getAttribute('data-col')] = col;
        });
        (prefs.cols || ['todo', 'feed', 'member']).forEach(function (k) {
            if (byKey[k]) grid.appendChild(byKey[k]);
        });
        var dash = document.querySelector('#home .home-dashboard');
        if (dash) dash.classList.toggle('is-compact', !!prefs.compact);

        // 角色差异：访客隐藏待办栏
        var role = getRoleKind();
        var todoCol = byKey.todo;
        if (todoCol) todoCol.style.display = (role === 'visitor' || role === 'guest') ? 'none' : '';
        var memberCol = byKey.member;
        if (memberCol && role === 'visitor') {
            /* 访客保留名录与动态 */
        }
    }

    function openHomeLayoutCustomize() {
        var prefs = loadLayoutPrefs();
        var modal = document.getElementById('homeLayoutCustomizeModal');
        if (!modal) return;
        var orderEl = document.getElementById('homeLayoutOrder');
        var compactEl = document.getElementById('homeLayoutCompact');
        if (orderEl) orderEl.value = (prefs.cols || ['todo', 'feed', 'member']).join(',');
        if (compactEl) compactEl.checked = !!prefs.compact;
        modal.style.display = 'flex';
    }
    global.openHomeLayoutCustomize = openHomeLayoutCustomize;

    function saveHomeLayoutCustomize() {
        var orderEl = document.getElementById('homeLayoutOrder');
        var compactEl = document.getElementById('homeLayoutCompact');
        var cols = String(orderEl && orderEl.value || 'todo,feed,member').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        var valid = { todo: 1, feed: 1, member: 1 };
        cols = cols.filter(function (c) { return valid[c]; });
        ['todo', 'feed', 'member'].forEach(function (c) { if (cols.indexOf(c) < 0) cols.push(c); });
        saveLayoutPrefs({ cols: cols, compact: !!(compactEl && compactEl.checked) });
        closeHomeLayoutCustomize();
        applyHomeLayoutPrefs();
        try {
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('首页工作台', '偏好', '调整三栏布局顺序', { cols: cols }, { success: true }, 1, '', 0);
            }
        } catch (e) {}
    }
    global.saveHomeLayoutCustomize = saveHomeLayoutCustomize;

    function closeHomeLayoutCustomize() {
        var modal = document.getElementById('homeLayoutCustomizeModal');
        if (modal) modal.style.display = 'none';
    }
    global.closeHomeLayoutCustomize = closeHomeLayoutCustomize;

    /* ---------- 同步日志面板 ---------- */
    function openHomeSyncLogPanel() {
        var modal = document.getElementById('homeSyncLogModal');
        var box = document.getElementById('homeSyncLogList');
        if (!modal || !box) return;
        var logs = [];
        try { logs = JSON.parse(localStorage.getItem('homeCloudSyncLogs_v1') || '[]') || []; } catch (e) { logs = []; }
        var st = global.cloudSyncState || {};
        var head = '<div class="home-sync-log-head">' +
            '<div>模式：<strong>' + esc(st.lastMode || '-') + '</strong></div>' +
            '<div>最近更新：<strong>' + esc(String(st.lastApplied != null ? st.lastApplied : '-')) + '</strong> · 跳过 <strong>' + esc(String(st.lastSkipped != null ? st.lastSkipped : '-')) + '</strong></div>' +
            '<div>状态：<strong class="' + (st.lastOk ? 'ok' : 'bad') + '">' + (st.lastOk === true ? '成功' : (st.lastOk === false ? '失败' : '未知')) + '</strong></div>' +
            '</div>';
        if (!logs.length) {
            box.innerHTML = head + '<div class="home-empty">暂无同步日志</div>';
        } else {
            box.innerHTML = head + logs.slice(0, 30).map(function (l) {
                var t = l.at ? new Date(l.at).toLocaleString('zh-CN') : '-';
                return '<div class="home-sync-log-item ' + (l.ok ? 'ok' : 'bad') + '">' +
                    '<div class="t">' + esc(t) + ' · ' + (l.ok ? '成功' : '失败') + (l.full ? ' · 全量' : ' · 增量') + '</div>' +
                    '<div class="m">写入 ' + esc(String(l.applied || 0)) + ' 项' +
                    (l.skipped != null ? ' · 跳过 ' + esc(String(l.skipped)) : '') +
                    (l.error ? ' · ' + esc(String(l.error).slice(0, 80)) : '') + '</div></div>';
            }).join('');
        }
        modal.style.display = 'flex';
    }
    global.openHomeSyncLogPanel = openHomeSyncLogPanel;

    function closeHomeSyncLogPanel() {
        var modal = document.getElementById('homeSyncLogModal');
        if (modal) modal.style.display = 'none';
    }
    global.closeHomeSyncLogPanel = closeHomeSyncLogPanel;

    function clearHomeSyncLogs() {
        try { localStorage.setItem('homeCloudSyncLogs_v1', '[]'); } catch (e) {}
        openHomeSyncLogPanel();
    }
    global.clearHomeSyncLogs = clearHomeSyncLogs;

    /* ---------- 一致性校验 ---------- */
    function runHomeConsistencyCheck(silent) {
        if (typeof global.getHomeDashboardOverview !== 'function') return null;
        var ov = global.getHomeDashboardOverview.__raw
            ? global.getHomeDashboardOverview.__raw()
            : global.getHomeDashboardOverview();
        var issues = [];
        var patentLen = (typeof global.getHomePatentCount === 'function') ? global.getHomePatentCount() : -1;
        var paperLen = (typeof global.getHomePaperCount === 'function') ? global.getHomePaperCount() : -1;
        if (patentLen >= 0 && ov.patents.total !== patentLen) issues.push('专利计数不一致：概览 ' + ov.patents.total + ' / 业务 ' + patentLen);
        if (paperLen >= 0 && ov.papers.total !== paperLen) issues.push('论文计数不一致：概览 ' + ov.papers.total + ' / 业务 ' + paperLen);
        var proj = typeof global.getHomeProjectStats === 'function' ? global.getHomeProjectStats() : null;
        if (proj && ov.projects.total !== proj.count) issues.push('项目计数不一致：概览 ' + ov.projects.total + ' / 业务 ' + proj.count);
        var members = typeof global.getHomeActiveMembers === 'function' ? global.getHomeActiveMembers() : null;
        if (members && ov.members.active.length !== members.active.length) {
            issues.push('在读成员不一致：概览 ' + ov.members.active.length + ' / 业务 ' + members.active.length);
        }
        var result = { ok: !issues.length, issues: issues, at: Date.now() };
        try { localStorage.setItem('homeConsistencyLastCheck', JSON.stringify(result)); } catch (e) {}
        if (!silent && issues.length) {
            console.warn('[home-consistency]', issues);
            try {
                if (typeof global.showCloudSyncBanner === 'function') {
                    global.showCloudSyncBanner('数据一致性告警：' + issues[0], true);
                }
            } catch (e2) {}
            try {
                if (typeof global.recordOperationLog === 'function') {
                    global.recordOperationLog('首页工作台', '校验', '发现 ' + issues.length + ' 项不一致', { issues: issues }, { success: false }, 0, issues.join('; '), 0);
                }
            } catch (e3) {}
        }
        return result;
    }
    global.runHomeConsistencyCheck = runHomeConsistencyCheck;

    /* ---------- 增强 renderHomeQuickNav / renderHomeDashboard ---------- */
    function enhanceQuickNav(overview) {
        var box = document.getElementById('homeQuickNav');
        if (!box) return;
        if (typeof global.renderHomeQuickNav === 'function' && !global.renderHomeQuickNav.__enhanced) {
            var orig = global.renderHomeQuickNav;
            // can't easily wrap if not on window - it's a function declaration in index
        }
        // append toolbar buttons if missing
        if (!document.getElementById('homeQuickToolbar')) {
            var bar = document.createElement('div');
            bar.id = 'homeQuickToolbar';
            bar.className = 'home-quick-toolbar';
            bar.innerHTML =
                '<button type="button" onclick="openHomeQuickCustomize()" title="自定义快捷入口">自定义入口</button>' +
                '<button type="button" onclick="openHomeLayoutCustomize()" title="调整三栏顺序">布局</button>' +
                '<button type="button" onclick="openHomeSyncLogPanel()" title="查看同步日志">同步日志</button>' +
                '<button type="button" onclick="manualHomeCloudSyncFull()" title="强制全量同步">全量同步</button>';
            var dash = document.querySelector('#home .home-dashboard');
            var quick = document.getElementById('homeQuickNav');
            if (dash && quick) dash.insertBefore(bar, quick.nextSibling);
        }
    }

    async function manualHomeCloudSyncFull() {
        if (typeof global.syncFromCloudAndRefresh !== 'function') {
            alert('同步模块未就绪');
            return;
        }
        if (global.homeDashUi) global.homeDashUi.syncing = true;
        if (typeof global.updateHomeSyncChrome === 'function') global.updateHomeSyncChrome();
        var ok = false, applied = 0, skipped = 0, lastErr = null;
        for (var attempt = 1; attempt <= 3; attempt++) {
            try {
                if (typeof global.showCloudSyncBanner === 'function') {
                    global.showCloudSyncBanner(attempt === 1 ? '正在全量同步…' : ('全量同步重试 ' + attempt + '/3…'), false);
                }
                var result = await global.syncFromCloudAndRefresh({ silent: attempt > 1, full: true });
                applied = (result && result.applied) || 0;
                skipped = (result && result.skipped) || 0;
                ok = !!(result && result.ok !== false);
                if (ok) break;
                lastErr = (result && result.error) || 'unknown';
            } catch (e) {
                lastErr = e;
                if (attempt < 3) await new Promise(function (r) { setTimeout(r, 600 * attempt); });
            }
        }
        if (global.homeDashUi) global.homeDashUi.syncing = false;
        invalidateHomeOverviewCache('full-sync');
        if (typeof global.appendHomeSyncLog === 'function') {
            global.appendHomeSyncLog({ at: Date.now(), ok: ok, applied: applied, skipped: skipped, full: true, error: ok ? '' : String(lastErr && lastErr.message || lastErr || '') });
        } else {
            try {
                var logs = JSON.parse(localStorage.getItem('homeCloudSyncLogs_v1') || '[]') || [];
                logs.unshift({ at: Date.now(), ok: ok, applied: applied, skipped: skipped, full: true, error: ok ? '' : String(lastErr || '') });
                localStorage.setItem('homeCloudSyncLogs_v1', JSON.stringify(logs.slice(0, 50)));
            } catch (eL) {}
        }
        if (!ok) notifyHomeSyncFailure(String(lastErr && lastErr.message || lastErr || '全量同步失败'));
        try {
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('云端同步', ok ? '全量成功' : '全量失败', ok ? ('全量同步写入 ' + applied + ' 项') : String(lastErr || ''), { applied: applied, skipped: skipped }, { success: !!ok }, ok ? 1 : 0, ok ? '' : String(lastErr || ''), 0);
            }
        } catch (eR) {}
        if (typeof global.renderHomeDashboard === 'function') global.renderHomeDashboard();
        if (typeof global.updateHomeSyncChrome === 'function') global.updateHomeSyncChrome();
        runHomeConsistencyCheck(false);
    }
    global.manualHomeCloudSyncFull = manualHomeCloudSyncFull;

    function patchManualSyncForAlert() {
        if (typeof global.manualHomeCloudSync !== 'function' || global.manualHomeCloudSync.__p3) return;
        var orig = global.manualHomeCloudSync;
        global.manualHomeCloudSync = async function () {
            var beforeFail = false;
            try {
                await orig.apply(this, arguments);
            } catch (e) {
                beforeFail = true;
                notifyHomeSyncFailure(String(e && e.message || e));
                throw e;
            }
            invalidateHomeOverviewCache('manual-sync');
            var st = global.cloudSyncState || {};
            if (st.lastOk === false) notifyHomeSyncFailure(st.lastError || '同步失败');
            try {
                var logs = JSON.parse(localStorage.getItem('homeCloudSyncLogs_v1') || '[]') || [];
                if (logs[0]) {
                    logs[0].full = false;
                    logs[0].skipped = st.lastSkipped;
                    localStorage.setItem('homeCloudSyncLogs_v1', JSON.stringify(logs));
                }
            } catch (e2) {}
            runHomeConsistencyCheck(true);
        };
        global.manualHomeCloudSync.__p3 = true;
    }

    function patchRenderHomeDashboard() {
        if (typeof global.renderHomeDashboard !== 'function' || global.renderHomeDashboard.__p3) return;
        var orig = global.renderHomeDashboard;
        global.renderHomeDashboard = function () {
            wrapOverviewWithCache();
            var ret = orig.apply(this, arguments);
            try { enhanceQuickNav(); } catch (e) {}
            try { applyHomeLayoutPrefs(); } catch (e2) {}
            try {
                var foot = document.getElementById('homeFootNote');
                var ov = global.homeDashUi && global.homeDashUi.lastOverview;
                if (foot && ov) {
                    var cacheHint = ov._fromCache
                        ? ('统计缓存 ' + Math.round((ov._cacheAgeMs || 0) / 1000) + 's')
                        : '统计已刷新';
                    var st = global.cloudSyncState || {};
                    var syncHint = st.lastMode === 'incremental'
                        ? ('增量 +' + (st.lastApplied || 0) + '/跳过' + (st.lastSkipped || 0))
                        : (st.lastMode === 'full' ? '全量同步' : '同步待命');
                    var extra = document.createElement('div');
                    // append into existing foot text
                    var span = foot.querySelector('.home-foot-extra');
                    if (!span) {
                        span = document.createElement('span');
                        span.className = 'home-foot-extra';
                        foot.appendChild(span);
                    }
                    span.innerHTML = cacheHint + ' · ' + syncHint +
                        ' · <a href="javascript:void(0)" onclick="runHomeConsistencyCheck(false)">一致性校验</a>';
                }
            } catch (e3) {}
            return ret;
        };
        global.renderHomeDashboard.__p3 = true;
    }

    function boot() {
        wrapOverviewWithCache();
        patchRenderHomeDashboard();
        patchManualSyncForAlert();
        // 暴露 save/load quick prefs if missing
        if (typeof global.saveHomeQuickPrefs !== 'function') {
            global.saveHomeQuickPrefs = function (roleKind, list) {
                try {
                    var raw = JSON.parse(localStorage.getItem('homeQuickNavPrefs_v1') || '{}') || {};
                    raw[roleKind] = list;
                    localStorage.setItem('homeQuickNavPrefs_v1', JSON.stringify(raw));
                } catch (e) {}
            };
        }
        setTimeout(function () {
            try { enhanceQuickNav(); applyHomeLayoutPrefs(); } catch (e) {}
            try { runHomeConsistencyCheck(true); } catch (e2) {}
        }, 800);
        // 定期一致性巡检（30 分钟）
        setInterval(function () {
            try { runHomeConsistencyCheck(true); } catch (e) {}
        }, 30 * 60 * 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})(typeof window !== 'undefined' ? window : this);
