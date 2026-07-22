/**
 * 新闻动态管理 — 内容运营中心
 * 依赖全局：currentUser, accountData, escHtml, cloudUpsert, recordOperationLog,
 * API_PROXY, wangEditor, weeklyReportData / saveWeeklyReportData（可选）
 */
(function (global) {
    'use strict';

    var NEWS_CATEGORIES = ['团队动态', '学术交流', '项目进展', '政策资讯', '成果发布'];
    var NEWS_PAGE_SIZE = 10;
    var NEWS_SENSITIVE = ['违法', '赌博', '色情', '诈骗', '暴力恐怖'];
    var NEWS_STATUS_CONFIG = {
        published: { label: '已发布', color: '#52c41a', bgColor: '#f6ffed', icon: '✅' },
        draft: { label: '草稿', color: '#8c8c8c', bgColor: '#f5f5f5', icon: '📝' },
        pending: { label: '待审核', color: '#1890ff', bgColor: '#e6f7ff', icon: '⏳' },
        scheduled: { label: '定时', color: '#722ed1', bgColor: '#f9f0ff', icon: '⏰' },
        withdrawn: { label: '已撤回', color: '#fa8c16', bgColor: '#fff7e6', icon: '📥' }
    };

    var NEWS_TEMPLATE_LIBRARY = {
        achievement: {
            label: '成果获奖',
            items: [
                { title: '论文发表', content: '<h2>🏆 论文发表喜报</h2><p>近日，我团队相关研究成果已成功发表于 <strong>[期刊/会议]</strong>。</p><h3>论文信息</h3><ul><li>标题：[论文标题]</li><li>作者：[作者列表]</li><li>方向：[研究方向]</li></ul><h3>主要贡献</h3><ol><li>贡献一</li><li>贡献二</li></ol><p>该研究得到了 [基金项目] 的支持。</p>' },
                { title: '专利授权', content: '<h2>📜 专利授权喜报</h2><p>热烈祝贺团队发明专利 <strong>《[专利名称]》</strong> 获授权！</p><ul><li>专利号：[号]</li><li>发明人：[名单]</li><li>应用场景：[场景]</li></ul>' },
                { title: '竞赛获奖', content: '<h2>🥇 竞赛获奖通报</h2><p>在 <strong>[赛事名称]</strong> 中，我团队荣获 <strong>[奖项]</strong>。</p><p>参赛成员：[名单]。祝贺！</p>' },
                { title: '项目立项', content: '<h2>📌 项目立项通知</h2><p>项目 <strong>《[项目名称]》</strong> 已正式立项。</p><ul><li>负责人：[姓名]</li><li>周期：[起止]</li><li>目标：[简述]</li></ul>' }
            ]
        },
        academic: {
            label: '学术活动',
            items: [
                { title: '会议预告', content: '<h2>📅 会议预告</h2><p>定于 <strong>[日期]</strong> 在 <strong>[地点]</strong> 举办 <strong>[会议名称]</strong>。</p><h3>议程</h3><ul><li>[时间] [内容]</li></ul><p>请准时参加。</p>' },
                { title: '会议总结', content: '<h2>📝 会议总结</h2><p>[会议名称] 已于 [日期] 顺利召开。</p><h3>要点</h3><ol><li>要点一</li><li>要点二</li></ol><p>纪要与资料见附件。</p>' },
                { title: '学术讲座', content: '<h2>🎤 学术讲座</h2><p>主题：<strong>[主题]</strong></p><p>主讲人：[姓名/单位]</p><p>时间地点：[信息]</p>' },
                { title: '嘉宾报告', content: '<h2>👤 嘉宾报告</h2><p>欢迎 <strong>[嘉宾]</strong> 作报告。</p><p>题目：[题目]</p><p>简介：[简介]</p>' }
            ]
        },
        team: {
            label: '团队动态',
            items: [
                { title: '人员入职', content: '<h2>👋 欢迎新成员</h2><p>热烈欢迎 <strong>[姓名]</strong> 加入团队，研究方向为 [方向]。</p>' },
                { title: '学生毕业', content: '<h2>🎓 毕业寄语</h2><p>祝贺 <strong>[姓名]</strong> 顺利毕业！感谢在团队期间的贡献。</p>' },
                { title: '项目启动', content: '<h2>🚀 项目启动</h2><p>《[项目名]》正式启动，请相关成员按计划推进。</p>' },
                { title: '团队招新', content: '<h2>📣 团队招新</h2><p>现面向 [年级/专业] 招收新成员，方向包括 [方向]。</p><p>报名方式：[方式]</p>' }
            ]
        },
        policy: {
            label: '政策通知',
            items: [
                { title: '实验室通知', content: '<h2>实验室通知</h2><p>请注意以下事项：</p><ol><li>事项一</li><li>事项二</li></ol>' },
                { title: '周报提醒', content: '<h2>周报提醒</h2><p>请于 [截止日期] 前提交本周周报。</p>' },
                { title: '安全通知', content: '<h2>⚠️ 安全通知</h2><p>请严格遵守实验室安全规范：[要点]。</p>' },
                { title: '放假通知', content: '<h2>放假通知</h2><p>根据安排，[日期] 起放假，[日期] 正常上班/返校。</p>' }
            ]
        }
    };

    var newsData = [];
    var editingNewsId = null;
    var newsPage = 1;
    var newsStatFilter = '';
    var newsSortByViews = false;
    var newsSelectedIds = {};
    var newsEditorInstance = null;
    var newsEditorId = '';
    var newsEditorModalId = '';
    var newsModalDirty = false;
    var newsAutoSaveTimer = null;
    var newsScheduleTimer = null;
    var newsPendingAttachments = [];

    function esc(s) {
        return window.escapeHtml(s);
    }

    function nowStr() {
        return new Date().toLocaleString('zh-CN');
    }

    function dateStr() {
        return new Date().toLocaleDateString('zh-CN');
    }

    function getCurrentUser() {
        var u = global.currentUser || null;
        if (u) return u;
        // index.html 用 let currentUser，不会自动挂到 window；尝试从会话恢复
        try {
            var sess = JSON.parse(localStorage.getItem('currentSession') || 'null');
            var accounts = global.accountData || JSON.parse(localStorage.getItem('accountData') || '[]');
            if (sess && sess.userId && Array.isArray(accounts)) {
                u = accounts.find(function (a) { return a && a.id === sess.userId; }) || null;
                if (u) global.currentUser = u;
            }
        } catch (e) {}
        return u || null;
    }

    function canManageNews() {
        var u = getCurrentUser();
        return !!(u && (u.role === 'admin' || u.role === 'leader'));
    }

    function canPublishNews() {
        return canManageNews();
    }

    function canReviewNews() {
        return canManageNews();
    }

    function canEditNews(item) {
        var u = getCurrentUser();
        if (!u || !item) return false;
        if (u.role === 'admin' || u.role === 'leader') return true;
        if (u.role === 'student') {
            var mine = item.createdBy === u.id || item.authorId === u.id ||
                item.author === (u.realName || u.username);
            return mine && (item.status === 'draft' || item.status === 'pending' || item.status === 'withdrawn');
        }
        return false;
    }

    function normalizeNewsRecord(raw) {
        var n = raw && typeof raw === 'object' ? raw : {};
        var status = n.status || 'draft';
        if (status === 'unpublished') status = 'withdrawn';
        var tags = Array.isArray(n.tags) ? n.tags : (n.keywords ? String(n.keywords).split(/[,，\s]+/).filter(Boolean) : []);
        return {
            id: Number(n.id) || 0,
            title: String(n.title || ''),
            category: NEWS_CATEGORIES.indexOf(n.category) >= 0 ? n.category : (n.category || '团队动态'),
            author: String(n.author || ''),
            authorId: n.authorId != null ? n.authorId : null,
            tags: tags,
            keywords: String(n.keywords || tags.join('、')),
            summary: String(n.summary || ''),
            content: String(n.content || ''),
            cover: String(n.cover || ''),
            originalUrl: String(n.originalUrl || ''),
            status: NEWS_STATUS_CONFIG[status] ? status : 'draft',
            pinned: !!n.pinned,
            allowComment: n.allowComment !== false,
            scheduledAt: String(n.scheduledAt || ''),
            attachments: Array.isArray(n.attachments) ? n.attachments : [],
            views: Number(n.views) || 0,
            likes: Number(n.likes) || 0,
            comments: Array.isArray(n.comments) ? n.comments : [],
            favorites: Array.isArray(n.favorites) ? n.favorites : [],
            shareCount: Number(n.shareCount) || 0,
            viewLogs: Array.isArray(n.viewLogs) ? n.viewLogs : [],
            reviewNote: String(n.reviewNote || ''),
            reviewedBy: String(n.reviewedBy || ''),
            reviewedAt: String(n.reviewedAt || ''),
            publishTime: String(n.publishTime || ''),
            updatedAt: String(n.updatedAt || ''),
            createdAt: String(n.createdAt || ''),
            createdBy: n.createdBy != null ? n.createdBy : null
        };
    }

    function mergeIncomingNewsData(incoming) {
        var localMap = {};
        (newsData || []).forEach(function (n) { localMap[n.id] = normalizeNewsRecord(n); });
        var remote = (Array.isArray(incoming) ? incoming : []).map(normalizeNewsRecord);
        var remoteIds = {};
        var merged = remote.map(function (n) {
            remoteIds[n.id] = true;
            var prev = localMap[n.id];
            if (!prev) return n;
            return Object.assign({}, n, {
                comments: (n.comments && n.comments.length) ? n.comments : prev.comments,
                favorites: (n.favorites && n.favorites.length) ? n.favorites : prev.favorites,
                viewLogs: mergeViewLogs(prev.viewLogs, n.viewLogs),
                views: Math.max(Number(n.views) || 0, Number(prev.views) || 0),
                likes: Math.max(Number(n.likes) || 0, Number(prev.likes) || 0),
                shareCount: Math.max(Number(n.shareCount) || 0, Number(prev.shareCount) || 0)
            });
        });
        Object.keys(localMap).forEach(function (id) {
            if (!remoteIds[id]) merged.push(localMap[id]);
        });
        return merged;
    }

    function mergeViewLogs(a, b) {
        var map = {};
        [].concat(a || [], b || []).forEach(function (v) {
            if (!v) return;
            var k = String(v.userId || v.user || '') + '|' + String(v.day || v.time || '');
            map[k] = v;
        });
        return Object.keys(map).map(function (k) { return map[k]; });
    }

    function buildDefaultNews() {
        var author = (getCurrentUser() && (getCurrentUser().realName || getCurrentUser().username)) || '团队管理员';
        return [
            normalizeNewsRecord({ id: 1, title: '团队在城市安全监测领域取得重要突破', category: '成果发布', author: author, content: '<p>近日，我团队在城市安全智能监测系统研发方面取得重大进展。基于深度学习的目标检测算法在真实场景测试中达到了95%以上的准确率。</p>', summary: '基于深度学习的目标检测算法在真实场景测试中达到了95%以上的准确率。', status: 'published', publishTime: '2026/7/5', views: 328, pinned: true, tags: ['成果', 'AI'] }),
            normalizeNewsRecord({ id: 2, title: '2026年度学术交流会议圆满举行', category: '学术交流', author: author, content: '<p>学术交流会议圆满举行，专家学者共同探讨城市安全前沿技术。</p>', summary: '来自全国各地的专家学者齐聚一堂，共同探讨城市安全领域的前沿技术。', status: 'published', publishTime: '2026/7/4', views: 256, tags: ['会议'] }),
            normalizeNewsRecord({ id: 3, title: '智能预警系统V3.0版本开发启动', category: '项目进展', author: author, content: '<p>智能预警系统V3.0版本正式启动开发。</p>', summary: '新版本将引入更多先进的AI算法，提升系统的智能化水平和预警准确率。', status: 'published', publishTime: '2026/7/1', views: 189 }),
            normalizeNewsRecord({ id: 4, title: '团队新增两名博士研究生', category: '团队动态', author: author, content: '<p>热烈欢迎新成员加入团队。</p>', summary: '两位博士将在目标检测和数据挖掘方向开展研究。', status: 'published', publishTime: '2026/6/28', views: 145 }),
            normalizeNewsRecord({ id: 5, title: '智慧城市安全建设指导意见发布', category: '政策资讯', author: author, content: '<p>相关指导意见明确了未来五年城市安全智能化发展的目标和方向。</p>', summary: '明确了未来五年城市安全智能化发展的目标和方向。', status: 'draft', views: 0 })
        ];
    }

    function loadNewsData() {
        var stored = localStorage.getItem('newsData');
        if (stored) {
            try {
                newsData = mergeIncomingNewsData(JSON.parse(stored));
            } catch (e) {
                newsData = buildDefaultNews();
            }
        } else {
            newsData = buildDefaultNews();
            saveNewsData({ silent: true });
        }
        newsData = (newsData || []).map(normalizeNewsRecord);
    }

    function saveNewsData(options) {
        options = options || {};
        newsData = (newsData || []).map(normalizeNewsRecord);
        localStorage.setItem('newsData', JSON.stringify(newsData));
        try { if (typeof global.cloudUpsert === 'function') global.cloudUpsert('newsData', JSON.stringify(newsData)); } catch (e) {}
        if (options.silent !== true) {
            try { updateNewsStats(); } catch (e2) {}
            try { renderNewsList(); } catch (e3) {}
            try { renderHomeNewsPanel(); } catch (e4) {}
        }
        try {
            if (typeof global.recordOperationLog === 'function' && options.log) {
                global.recordOperationLog('新闻动态', options.log.action || '更新', options.log.desc || '更新新闻', options.log.detail || {}, { success: true }, 1, '', 0);
            }
        } catch (e5) {}
    }

    function initNewsManagement() {
        try { if (typeof global.syncGlobalsForExternalModules === 'function') global.syncGlobalsForExternalModules(); } catch (e0) {}
        loadNewsData();
        try { if (typeof global.reconcileCollaborativeDataWithTeamMembers === 'function') global.reconcileCollaborativeDataWithTeamMembers(); } catch (e) {}
        newsPage = 1;
        newsSelectedIds = {};
        updateNewsPublishPermissionUI();
        updateNewsStats();
        renderNewsList();
        ensureNewsScheduleTimer();
    }

    function updateNewsPublishPermissionUI() {
        var btn = document.getElementById('newsPublishBtn');
        var u = getCurrentUser();
        if (btn) {
            if (!u || u.role === 'visitor') btn.style.display = 'none';
            else {
                btn.style.display = '';
                btn.innerHTML = canPublishNews() ? '<span>➕</span> 发布新闻' : '<span>📝</span> 新建草稿';
            }
        }
    }

    function ensureNewsScheduleTimer() {
        if (newsScheduleTimer) return;
        newsScheduleTimer = setInterval(processScheduledNews, 60000);
        processScheduledNews();
    }

    function processScheduledNews() {
        var changed = false;
        var now = Date.now();
        (newsData || []).forEach(function (n) {
            if (n.status !== 'scheduled' || !n.scheduledAt) return;
            var t = new Date(String(n.scheduledAt).replace(/-/g, '/')).getTime();
            if (!isNaN(t) && t <= now) {
                n.status = 'published';
                n.publishTime = dateStr();
                n.updatedAt = nowStr();
                changed = true;
            }
        });
        if (changed) saveNewsData({ log: { action: '定时发布', desc: '定时新闻自动上架' } });
    }

    /* ---------- 筛选 / 列表 ---------- */

    function getFilteredNews() {
        var search = (document.getElementById('newsSearchInput') || {}).value || '';
        var statusFilter = newsStatFilter || (document.getElementById('newsStatusFilter') || {}).value || '';
        var cat = (document.getElementById('newsCategoryFilter') || {}).value || '';
        var author = (document.getElementById('newsAuthorFilter') || {}).value || '';
        var range = (document.getElementById('newsTimeFilter') || {}).value || '';
        var pinned = (document.getElementById('newsPinnedFilter') || {}).value || '';
        var u = getCurrentUser();
        var filtered = (newsData || []).slice();

        if (u && u.role === 'visitor') {
            filtered = filtered.filter(function (n) { return n.status === 'published'; });
        }

        if (search) {
            var q = search.toLowerCase();
            filtered = filtered.filter(function (n) {
                return (n.title || '').toLowerCase().indexOf(q) >= 0 ||
                    (n.summary || '').toLowerCase().indexOf(q) >= 0 ||
                    (n.author || '').toLowerCase().indexOf(q) >= 0 ||
                    (n.tags || []).join(',').toLowerCase().indexOf(q) >= 0;
            });
        }
        if (statusFilter === 'draft_group') {
            filtered = filtered.filter(function (n) { return n.status === 'draft' || n.status === 'pending'; });
        } else if (statusFilter) {
            filtered = filtered.filter(function (n) { return n.status === statusFilter; });
        }
        if (cat) filtered = filtered.filter(function (n) { return n.category === cat; });
        if (author) filtered = filtered.filter(function (n) { return n.author === author; });
        if (pinned === '1') filtered = filtered.filter(function (n) { return n.pinned; });
        if (pinned === '0') filtered = filtered.filter(function (n) { return !n.pinned; });
        if (range) {
            var days = Number(range);
            if (days > 0) {
                var cut = Date.now() - days * 86400000;
                filtered = filtered.filter(function (n) {
                    var t = new Date(String(n.publishTime || n.updatedAt || n.createdAt).replace(/-/g, '/')).getTime();
                    return !isNaN(t) && t >= cut;
                });
            }
        }

        filtered.sort(function (a, b) {
            if (newsSortByViews) return (b.views || 0) - (a.views || 0);
            if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
            var order = { published: 0, scheduled: 1, pending: 2, draft: 3, withdrawn: 4 };
            var oa = order[a.status] != null ? order[a.status] : 9;
            var ob = order[b.status] != null ? order[b.status] : 9;
            if (oa !== ob) return oa - ob;
            return (Number(b.id) || 0) - (Number(a.id) || 0);
        });
        return filtered;
    }

    function setNewsStatFilter(key) {
        newsStatFilter = key || '';
        newsSortByViews = key === 'views';
        if (key === 'views') newsStatFilter = '';
        var sel = document.getElementById('newsStatusFilter');
        if (sel) {
            if (key === 'draft_group') sel.value = 'draft_group';
            else if (key === 'published') sel.value = 'published';
            else if (key === 'views' || key === '') sel.value = '';
            else sel.value = key;
        }
        newsPage = 1;
        updateNewsStats();
        renderNewsList();
    }

    function onNewsStatusFilterChange() {
        var sel = document.getElementById('newsStatusFilter');
        newsStatFilter = sel ? sel.value : '';
        newsSortByViews = false;
        newsPage = 1;
        updateNewsStats();
        renderNewsList();
    }

    function onNewsSearchInput() {
        newsPage = 1;
        renderNewsList();
    }

    function onNewsFilterChange() {
        newsPage = 1;
        renderNewsList();
    }

    function toggleNewsAdvancedFilter() {
        var box = document.getElementById('newsAdvancedFilter');
        if (!box) return;
        box.style.display = box.style.display === 'none' ? 'flex' : 'none';
    }

    function updateNewsStats() {
        var list = newsData || [];
        var total = list.length;
        var published = list.filter(function (n) { return n.status === 'published'; }).length;
        var draft = list.filter(function (n) { return n.status === 'draft' || n.status === 'pending'; }).length;
        var pending = list.filter(function (n) { return n.status === 'pending'; }).length;
        var views = list.reduce(function (s, n) { return s + (Number(n.views) || 0); }, 0);
        var el = function (id, v) { var n = document.getElementById(id); if (n) n.textContent = v; };
        el('newsStatTotal', total);
        el('newsStatPublished', published);
        el('newsStatDraft', draft);
        el('newsStatViews', views);
        var badge = document.getElementById('newsPendingBadge');
        if (badge) {
            badge.textContent = pending > 0 ? ('待审 ' + pending) : '';
            badge.style.display = pending > 0 && canReviewNews() ? 'inline-flex' : 'none';
        }
        ['newsStatCardTotal', 'newsStatCardPublished', 'newsStatCardDraft', 'newsStatCardViews'].forEach(function (id) {
            var c = document.getElementById(id);
            if (c) c.classList.remove('news-stat-active');
        });
        var activeId = newsSortByViews ? 'newsStatCardViews'
            : (newsStatFilter === 'published' ? 'newsStatCardPublished'
                : (newsStatFilter === 'draft_group' ? 'newsStatCardDraft' : 'newsStatCardTotal'));
        var active = document.getElementById(activeId);
        if (active) active.classList.add('news-stat-active');
    }

    function fillNewsAuthorFilterOptions() {
        var sel = document.getElementById('newsAuthorFilter');
        if (!sel) return;
        var cur = sel.value;
        var authors = {};
        (newsData || []).forEach(function (n) { if (n.author) authors[n.author] = true; });
        var accounts = Array.isArray(global.accountData) ? global.accountData : [];
        accounts.forEach(function (a) {
            var name = a.realName || a.username;
            if (name) authors[name] = true;
        });
        sel.innerHTML = '<option value="">全部作者</option>' +
            Object.keys(authors).sort().map(function (a) {
                return '<option value="' + esc(a) + '"' + (cur === a ? ' selected' : '') + '>' + esc(a) + '</option>';
            }).join('');
    }

    function coverThumb(item) {
        if (item.cover) {
            return '<img src="' + esc(item.cover) + '" alt="" style="width:96px;height:64px;object-fit:cover;border-radius:8px;flex-shrink:0;background:#f3f4f6;">';
        }
        return '<div style="width:96px;height:64px;border-radius:8px;flex-shrink:0;background:linear-gradient(135deg,#ede9fe,#e0e7ff);display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:11px;">暂无封面</div>';
    }

    function renderNewsList() {
        fillNewsAuthorFilterOptions();
        var filtered = getFilteredNews();
        var tbody = document.getElementById('newsTable');
        var empty = document.getElementById('newsEmpty');
        var pager = document.getElementById('newsPager');
        var batchBar = document.getElementById('newsBatchBar');
        if (!tbody) return;

        var totalPages = Math.max(1, Math.ceil(filtered.length / NEWS_PAGE_SIZE));
        if (newsPage > totalPages) newsPage = totalPages;
        var start = (newsPage - 1) * NEWS_PAGE_SIZE;
        var pageData = filtered.slice(start, start + NEWS_PAGE_SIZE);

        if (batchBar) {
            var selCount = Object.keys(newsSelectedIds).filter(function (k) { return newsSelectedIds[k]; }).length;
            batchBar.style.display = canManageNews() && selCount > 0 ? 'flex' : 'none';
            var cnt = document.getElementById('newsBatchCount');
            if (cnt) cnt.textContent = String(selCount);
        }

        if (!filtered.length) {
            tbody.innerHTML = '';
            if (empty) empty.style.display = 'block';
            if (pager) pager.innerHTML = '';
            return;
        }
        if (empty)         empty.style.display = 'none';

        var showCheck = canManageNews();
        var thCheck = document.querySelector('#news_management thead th');
        if (thCheck && thCheck.querySelector('input[type=checkbox]')) {
            thCheck.style.display = showCheck ? '' : 'none';
        }

        var u = getCurrentUser();
        tbody.innerHTML = pageData.map(function (item) {
            var status = NEWS_STATUS_CONFIG[item.status] || NEWS_STATUS_CONFIG.draft;
            var previewText = item.summary || String(item.content || '').replace(/<[^>]*>/g, '').substring(0, 60);
            var checked = newsSelectedIds[item.id] ? ' checked' : '';
            var pinTag = item.pinned ? '<span style="display:inline-block;padding:2px 8px;margin-right:6px;background:#f3e8ff;color:#7c3aed;border-radius:999px;font-size:11px;font-weight:600;">置顶</span>' : '';
            var ops = buildNewsRowActions(item, u);
            return '<tr style="border-bottom:1px solid #f5f5f5;" onmouseover="this.style.background=\'#fafafa\'" onmouseout="this.style.background=\'\'">' +
                (showCheck ? '<td style="padding:14px 12px;width:36px;"><input type="checkbox" data-news-id="' + item.id + '" onchange="toggleNewsSelect(' + item.id + ', this.checked)"' + checked + '></td>' : '') +
                '<td style="padding:14px 16px;"><div style="display:flex;gap:12px;cursor:pointer;" onclick="showNewsDetail(' + item.id + ')">' +
                coverThumb(item) +
                '<div style="flex:1;min-width:0;"><div style="font-weight:600;color:#333;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' +
                pinTag + esc(item.title) + '</div>' +
                '<div style="font-size:12px;color:#999;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(previewText) + '</div></div></div></td>' +
                '<td style="padding:14px 16px;"><span style="display:inline-block;padding:4px 10px;background:#f5f5f5;color:#666;border-radius:16px;font-size:12px;">' + esc(item.category) + '</span></td>' +
                '<td style="padding:14px 16px;font-size:14px;color:#666;">' + esc(item.author) + '</td>' +
                '<td style="padding:14px 16px;font-size:14px;color:#666;">' + esc(item.publishTime || item.scheduledAt || '-') + '</td>' +
                '<td style="padding:14px 16px;"><span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:' + status.bgColor + ';color:' + status.color + ';border-radius:16px;font-size:12px;font-weight:500;">' +
                status.icon + ' ' + status.label + '</span></td>' +
                '<td style="padding:14px 16px;font-size:14px;color:#666;cursor:pointer;" onclick="showNewsStats(' + item.id + ')" title="查看阅读统计">👁️ ' + (item.views || 0) +
                ' · 💬 ' + ((item.comments && item.comments.length) || 0) + '</td>' +
                '<td style="padding:14px 16px;text-align:right;"><div style="display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;">' + ops + '</div></td></tr>';
        }).join('');

        if (pager) {
            pager.innerHTML = '<span style="color:#888;font-size:13px;">共 ' + filtered.length + ' 条</span>' +
                '<div style="display:flex;gap:8px;align-items:center;">' +
                '<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" ' + (newsPage <= 1 ? 'disabled' : '') + ' onclick="newsPageNav(-1)">上一页</button>' +
                '<span style="font-size:13px;">' + newsPage + ' / ' + totalPages + '</span>' +
                '<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" ' + (newsPage >= totalPages ? 'disabled' : '') + ' onclick="newsPageNav(1)">下一页</button></div>';
        }
    }

    function buildNewsRowActions(item, u) {
        var btns = [];
        btns.push('<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();showNewsDetail(' + item.id + ')">查看</button>');
        if (canEditNews(item)) {
            btns.push('<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();showEditNewsModal(' + item.id + ')">编辑</button>');
        }
        btns.push('<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();copyNewsLink(' + item.id + ')">复制链接</button>');
        if (canManageNews()) {
            btns.push('<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();toggleNewsPin(' + item.id + ')">' + (item.pinned ? '取消置顶' : '置顶') + '</button>');
            if (item.status === 'pending') {
                btns.push('<button class="btn" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();reviewNews(' + item.id + ', true)">通过</button>');
                btns.push('<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();reviewNews(' + item.id + ', false)">驳回</button>');
            } else if (item.status === 'draft' || item.status === 'withdrawn' || item.status === 'scheduled') {
                btns.push('<button class="btn" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();publishNews(' + item.id + ')">发布</button>');
            } else if (item.status === 'published') {
                btns.push('<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();unpublishNews(' + item.id + ')">撤回</button>');
            }
            btns.push('<button class="btn btn-danger" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();deleteNews(' + item.id + ')">删除</button>');
        } else if (u && u.role === 'student') {
            btns.push('<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();toggleNewsFavorite(' + item.id + ')">收藏</button>');
            if (item.status === 'draft' && canEditNews(item)) {
                btns.push('<button class="btn" style="padding:5px 10px;font-size:12px;" onclick="event.stopPropagation();submitNewsForReview(' + item.id + ')">提交审核</button>');
            }
        }
        return btns.join('');
    }

    function newsPageNav(delta) {
        newsPage = Math.max(1, newsPage + delta);
        renderNewsList();
    }

    function toggleNewsSelect(id, checked) {
        if (checked) newsSelectedIds[id] = true;
        else delete newsSelectedIds[id];
        renderNewsList();
    }

    function toggleSelectAllNews(checked) {
        getFilteredNews().forEach(function (n) {
            if (checked) newsSelectedIds[n.id] = true;
            else delete newsSelectedIds[n.id];
        });
        renderNewsList();
    }

    function getSelectedNewsIds() {
        return Object.keys(newsSelectedIds).filter(function (k) { return newsSelectedIds[k]; }).map(Number);
    }

    function batchNewsAction(action) {
        if (!canManageNews()) { alert('无权限'); return; }
        var ids = getSelectedNewsIds();
        if (!ids.length) { alert('请先勾选新闻'); return; }
        if (action === 'delete' && !confirm('确定批量删除 ' + ids.length + ' 条新闻？')) return;
        var cat = '';
        if (action === 'category') {
            cat = prompt('输入新分类（' + NEWS_CATEGORIES.join(' / ') + '）', NEWS_CATEGORIES[0]);
            if (!cat || NEWS_CATEGORIES.indexOf(cat) < 0) return;
        }
        ids.forEach(function (id) {
            var idx = newsData.findIndex(function (n) { return n.id === id; });
            if (idx < 0) return;
            if (action === 'publish') {
                newsData[idx].status = 'published';
                newsData[idx].publishTime = newsData[idx].publishTime || dateStr();
            } else if (action === 'withdraw') {
                newsData[idx].status = 'withdrawn';
            } else if (action === 'pin') {
                newsData[idx].pinned = true;
            } else if (action === 'category') {
                newsData[idx].category = cat;
            } else if (action === 'delete') {
                newsData[idx] = null;
            }
            if (newsData[idx]) newsData[idx].updatedAt = nowStr();
        });
        if (action === 'delete') newsData = newsData.filter(Boolean);
        newsSelectedIds = {};
        saveNewsData({ log: { action: '批量' + action, desc: '批量操作 ' + ids.length + ' 条' } });
    }

    /* ---------- 弹窗 ---------- */

    function authorOptionsHtml(selected) {
        var u = getCurrentUser();
        var names = {};
        if (u) names[u.realName || u.username] = u.id;
        (Array.isArray(global.accountData) ? global.accountData : []).forEach(function (a) {
            if (!a || a.role === 'visitor') return;
            var name = a.realName || a.username;
            if (name) names[name] = a.id;
        });
        return Object.keys(names).map(function (name) {
            return '<option value="' + esc(name) + '" data-id="' + names[name] + '"' + (selected === name ? ' selected' : '') + '>' + esc(name) + '</option>';
        }).join('');
    }

    function showAddNewsModal() {
        editingNewsId = null;
        showNewsModal();
    }

    function showEditNewsModal(id) {
        editingNewsId = id;
        showNewsModal();
    }

    function showNewsModal() {
        try {
            var item = editingNewsId ? newsData.find(function (n) { return n.id === editingNewsId; }) : null;
            var modalId = 'newsModal_' + Date.now();
            var editorId = 'newsEditor_' + Date.now();
            var u = getCurrentUser();
            var defaultAuthor = item ? item.author : (u && (u.realName || u.username)) || '';
            newsPendingAttachments = item && item.attachments ? item.attachments.slice() : [];
            newsModalDirty = false;

            var modePublishLabel = canPublishNews() ? '立即发布' : '提交审核';
            var modal = document.createElement('div');
            modal.id = modalId;
            // 外层可滚动、内层不裁切，避免 wangEditor 字号/颜色下拉被 overflow 挡住
            modal.className = 'fixed inset-0 bg-black/50 z-[5000] overflow-y-auto';
            modal.style.cssText = 'display:block;padding:24px 12px;';
            modal.innerHTML =
                '<div class="bg-white rounded-xl w-[820px] max-w-[96vw] mx-auto my-2 flex flex-col shadow-2xl" style="overflow:visible;position:relative;">' +
                '<div class="flex justify-between items-center px-6 py-4 border-b border-gray-100 gap-3 flex-wrap sticky top-0 bg-white z-10 rounded-t-xl">' +
                '<div><h3 class="text-xl font-semibold text-[#7c3aed]">' + (item ? '编辑新闻' : '发布新闻') + '</h3>' +
                '<div class="text-xs text-gray-400 mt-1" id="newsAutoSaveTip_' + modalId + '">编辑中自动保存草稿</div></div>' +
                '<div class="flex items-center gap-2 flex-wrap">' +
                '<div class="flex rounded-lg overflow-hidden border border-gray-200 text-sm" id="newsPublishModeGroup">' +
                '<button type="button" data-mode="publish" class="news-mode-btn px-3 py-1.5 bg-[#7c3aed] text-white" onclick="setNewsPublishMode(\'' + modalId + '\',\'publish\')">' + modePublishLabel + '</button>' +
                (canPublishNews() ? '<button type="button" data-mode="schedule" class="news-mode-btn px-3 py-1.5 bg-white text-gray-600" onclick="setNewsPublishMode(\'' + modalId + '\',\'schedule\')">定时发布</button>' : '') +
                '<button type="button" data-mode="draft" class="news-mode-btn px-3 py-1.5 bg-white text-gray-600" onclick="setNewsPublishMode(\'' + modalId + '\',\'draft\')">保存草稿</button>' +
                '</div>' +
                '<button class="text-gray-400 hover:text-gray-600 text-xl font-bold w-8 h-8" onclick="closeNewsModal(\'' + modalId + '\')">×</button></div></div>' +
                '<div class="p-6 space-y-5" style="overflow:visible;" oninput="markNewsModalDirty()">' +
                sectionTitle('① 基础信息') +
                '<div><label class="block text-sm font-medium text-gray-700 mb-2">新闻标题 <span class="text-red-500">*</span></label>' +
                '<input type="text" id="newsTitle" class="w-full text-lg px-4 py-3 border border-gray-200 rounded-lg outline-none" value="' + esc(item ? item.title : '') + '" placeholder="请输入新闻标题" maxlength="80"></div>' +
                '<div class="flex gap-4 flex-wrap">' +
                '<div class="flex-1 min-w-[160px]"><label class="block text-sm font-medium text-gray-700 mb-2">分类</label>' +
                '<select id="newsCategory" class="w-full px-4 py-3 border border-gray-200 rounded-lg bg-white">' +
                NEWS_CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '"' + (item && item.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
                '</select></div>' +
                '<div class="flex-1 min-w-[160px]"><label class="block text-sm font-medium text-gray-700 mb-2">作者</label>' +
                '<select id="newsAuthor" class="w-full px-4 py-3 border border-gray-200 rounded-lg bg-white">' + authorOptionsHtml(defaultAuthor) + '</select></div></div>' +
                '<div><label class="block text-sm font-medium text-gray-700 mb-2">关键词标签</label>' +
                '<input type="text" id="newsTags" class="w-full px-4 py-3 border border-gray-200 rounded-lg" placeholder="多个标签用逗号分隔，如：论文,CVPR,目标检测" value="' + esc((item && item.tags ? item.tags : []).join('、')) + '"></div>' +
                sectionTitle('② 封面与摘要') +
                coverUploadHtml(modalId, item) +
                '<div><label class="block text-sm font-medium text-gray-700 mb-2">摘要 <span class="text-xs text-gray-400">建议 80–150 字，用于首页列表</span></label>' +
                '<textarea id="newsSummary" class="w-full px-4 py-3 border border-gray-200 rounded-lg resize-none" rows="3" placeholder="不填则默认截取正文前 100 字">' + esc(item ? (item.summary || '') : '') + '</textarea>' +
                '<div class="text-xs text-gray-400 mt-1" id="newsSummaryCount">0 字</div></div>' +
                '<div><label class="block text-sm font-medium text-gray-700 mb-2">原文链接</label>' +
                '<input type="text" id="newsOriginalUrl" class="w-full px-4 py-3 border border-gray-200 rounded-lg" placeholder="可选" value="' + esc(item ? (item.originalUrl || '') : '') + '"></div>' +
                sectionTitle('③ 正文编辑') +
                '<div class="flex justify-between items-center mb-2 flex-wrap gap-2">' +
                '<label class="text-sm font-medium text-gray-700">正文 <span class="text-red-500">*</span></label>' +
                '<div class="flex gap-2 flex-wrap text-sm">' +
                '<button type="button" class="text-[#7c3aed]" onclick="ensureNewsEditorReady();showNewsTemplateLibrary(\'' + modalId + '\')">📋 模板库</button>' +
                '<button type="button" class="text-[#7c3aed]" onclick="ensureNewsEditorReady();oneClickNewsFormat()">✨ 一键排版</button>' +
                '<button type="button" class="text-[#7c3aed]" onclick="ensureNewsEditorReady();clearNewsEditorFormat()">清除格式</button>' +
                '<button type="button" class="text-[#7c3aed]" onclick="ensureNewsEditorReady();aiPolishNews()">AI 润色</button>' +
                '<button type="button" class="text-[#7c3aed]" onclick="ensureNewsEditorReady();aiGenerateNewsDraft()">AI 初稿</button>' +
                '</div></div>' +
                '<div class="news-editor-host" style="position:relative;z-index:40;overflow:visible;">' +
                '<div id="toolbar_' + editorId + '" class="w-full" style="overflow:visible;"></div>' +
                '<div id="' + editorId + '" class="w-full" style="min-height:280px;"></div>' +
                '</div>' +
                '<div class="text-right text-xs text-gray-400 mt-1" id="wordCount_' + modalId + '">0 字</div>' +
                sectionTitle('④ 发布设置') +
                '<div class="flex gap-4 flex-wrap items-center">' +
                '<label class="flex items-center gap-2 text-sm"><input type="checkbox" id="newsPinned"' + (item && item.pinned ? ' checked' : '') + '> 置顶</label>' +
                '<label class="flex items-center gap-2 text-sm"><input type="checkbox" id="newsAllowComment"' + (!item || item.allowComment !== false ? ' checked' : '') + '> 允许评论</label>' +
                '</div>' +
                '<div id="newsScheduleWrap" style="display:none;"><label class="block text-sm font-medium text-gray-700 mb-2">定时发布时间</label>' +
                '<input type="datetime-local" id="newsScheduledAt" class="w-full px-4 py-3 border border-gray-200 rounded-lg" value="' + esc(toDatetimeLocal(item && item.scheduledAt)) + '"></div>' +
                '<input type="hidden" id="newsPublishMode" value="publish">' +
                '<div><label class="block text-sm font-medium text-gray-700 mb-2">附件（本地上传，单文件建议 &lt; 2MB）</label>' +
                '<input type="file" id="newsAttachInput" multiple onchange="handleNewsAttachUpload(event)">' +
                '<div id="newsAttachList" class="mt-2 text-sm text-gray-600"></div></div>' +
                '</div>' +
                '<div class="px-6 py-4 border-t border-gray-100 flex justify-between items-center bg-gray-50/50 gap-2 flex-wrap sticky bottom-0 rounded-b-xl">' +
                '<button class="px-4 py-2 text-gray-600" onclick="showMobileNewsPreview(\'' + modalId + '\')">预览效果</button>' +
                '<div class="flex gap-2">' +
                '<button class="px-4 py-2 text-gray-500 bg-gray-100 rounded-lg" onclick="closeNewsModal(\'' + modalId + '\')">取消</button>' +
                '<button class="px-4 py-2 border border-gray-200 rounded-lg" onclick="commitNewsModal(\'' + modalId + '\',\'draft\')">存草稿</button>' +
                '<button id="newsPrimaryBtn" class="px-6 py-2 text-white bg-[#7c3aed] rounded-lg font-medium" onclick="commitNewsModal(\'' + modalId + '\')">确认</button>' +
                '</div></div>' +
                '</div>';

            document.body.appendChild(modal);
            renderNewsAttachList();
            bindNewsSummaryCounter();
            setTimeout(function () {
                initNewsEditor(editorId, modalId, item ? item.content : '');
                if (item && item.cover) {
                    var prev = document.getElementById('coverPreview_' + modalId);
                    var ph = document.getElementById('coverPlaceholder_' + modalId);
                    if (prev) prev.classList.remove('hidden');
                    if (ph) ph.classList.add('hidden');
                }
                startNewsAutoSave(modalId);
                setNewsPublishMode(modalId, canPublishNews() ? 'publish' : 'draft');
            }, 80);
        } catch (e) {
            console.error(e);
            alert('打开新闻编辑弹窗失败，请刷新重试');
        }
    }

    function sectionTitle(t) {
        return '<div class="text-sm font-semibold text-[#7c3aed] border-l-4 border-[#7c3aed] pl-2 mt-1">' + t + '</div>';
    }

    function coverUploadHtml(modalId, item) {
        return '<div><label class="block text-sm font-medium text-gray-700 mb-2">封面图 <span class="text-xs text-gray-400">直接上传，不裁剪</span></label>' +
            '<div id="coverUploadArea_' + modalId + '" class="border-2 border-dashed border-gray-200 rounded-lg p-6 text-center cursor-pointer" onclick="document.getElementById(\'coverFileInput_' + modalId + '\').click()">' +
            '<div id="coverPreview_' + modalId + '" class="' + (item && item.cover ? '' : 'hidden') + '">' +
            '<img id="coverImage_' + modalId + '" src="' + esc(item && item.cover ? item.cover : '') + '" class="max-h-40 mx-auto rounded-lg object-contain">' +
            '<div class="mt-3 flex justify-center gap-2">' +
            '<button type="button" class="text-sm text-[#7c3aed]" onclick="event.stopPropagation();document.getElementById(\'coverFileInput_' + modalId + '\').click()">重新上传</button>' +
            '<button type="button" class="text-sm text-gray-500" onclick="event.stopPropagation();clearCoverImage(\'' + modalId + '\')">删除</button></div></div>' +
            '<div id="coverPlaceholder_' + modalId + '" class="' + (item && item.cover ? 'hidden' : '') + '"><div class="text-3xl mb-2">🖼️</div><div class="text-gray-500">点击上传封面</div><div class="text-xs text-gray-400">支持 JPG/PNG，原图直接使用</div></div></div>' +
            '<input type="file" id="coverFileInput_' + modalId + '" accept=".jpg,.jpeg,.png,image/*" class="hidden" onchange="handleCoverUpload(event,\'' + modalId + '\')">' +
            '<input type="hidden" id="newsCover" value="' + esc(item && item.cover ? item.cover : '') + '"></div>';
    }

    function toDatetimeLocal(v) {
        if (!v) return '';
        var d = new Date(String(v).replace(/-/g, '/'));
        if (isNaN(d.getTime())) return '';
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function setNewsPublishMode(modalId, mode) {
        var input = document.getElementById('newsPublishMode');
        if (input) input.value = mode;
        var wrap = document.getElementById('newsScheduleWrap');
        if (wrap) wrap.style.display = mode === 'schedule' ? 'block' : 'none';
        var group = document.getElementById('newsPublishModeGroup');
        if (group) {
            Array.prototype.forEach.call(group.querySelectorAll('.news-mode-btn'), function (btn) {
                var on = btn.getAttribute('data-mode') === mode;
                btn.className = 'news-mode-btn px-3 py-1.5 ' + (on ? 'bg-[#7c3aed] text-white' : 'bg-white text-gray-600');
            });
        }
        var primary = document.getElementById('newsPrimaryBtn');
        if (primary) {
            primary.textContent = mode === 'draft' ? '保存草稿' : (mode === 'schedule' ? '设定时发布' : (canPublishNews() ? '发布新闻' : '提交审核'));
        }
    }

    function markNewsModalDirty() { newsModalDirty = true; }

    function bindNewsSummaryCounter() {
        var ta = document.getElementById('newsSummary');
        var tip = document.getElementById('newsSummaryCount');
        if (!ta || !tip) return;
        var upd = function () { tip.textContent = ta.value.length + ' 字'; };
        ta.addEventListener('input', upd);
        upd();
    }

    function startNewsAutoSave(modalId) {
        stopNewsAutoSave();
        newsAutoSaveTimer = setInterval(function () {
            try {
                var payload = collectNewsFormPayload();
                if (!payload.title && !payload.content.replace(/<[^>]*>/g, '').trim()) return;
                var key = 'newsAutoDraft_' + ((getCurrentUser() && getCurrentUser().id) || 'guest');
                localStorage.setItem(key, JSON.stringify(Object.assign({ savedAt: nowStr(), editingId: editingNewsId }, payload)));
                var tip = document.getElementById('newsAutoSaveTip_' + modalId);
                if (tip) tip.textContent = '已自动保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            } catch (e) {}
        }, 30000);
    }

    function stopNewsAutoSave() {
        if (newsAutoSaveTimer) clearInterval(newsAutoSaveTimer);
        newsAutoSaveTimer = null;
    }

    function closeNewsModal(modalId) {
        if (newsModalDirty && !confirm('当前内容尚未保存，确定离开吗？')) return;
        stopNewsAutoSave();
        try { if (newsEditorInstance && newsEditorInstance.destroy) newsEditorInstance.destroy(); } catch (e) {}
        newsEditorInstance = null;
        var el = document.getElementById(modalId);
        if (el) el.remove();
    }

    function initNewsEditor(editorId, modalId, content) {
        try {
            if (typeof global.wangEditor === 'undefined') return;
            var toolbarEl = document.getElementById('toolbar_' + editorId);
            var editorEl = document.getElementById(editorId);
            if (!toolbarEl || !editorEl) return;
            newsEditorId = editorId;
            newsEditorModalId = modalId;
            try { if (newsEditorInstance && newsEditorInstance.destroy) newsEditorInstance.destroy(); } catch (e0) {}
            newsEditorInstance = null;
            toolbarEl.innerHTML = '';
            editorEl.innerHTML = '';
            toolbarEl.style.borderBottom = '1px solid #e8e8e8';
            editorEl.style.height = '360px';
            editorEl.style.border = '1px solid #e8e8e8';
            editorEl.style.borderTop = 'none';
            var editorConfig = {
                placeholder: '请输入新闻正文...',
                onChange: function (editor) {
                    markNewsModalDirty();
                    captureNewsSelection();
                    var wordCountEl = document.getElementById('wordCount_' + modalId);
                    if (wordCountEl) wordCountEl.textContent = editor.getText().length + ' 字';
                },
                MENU_CONF: {
                    uploadImage: {
                        customUpload: function (file, insertFn) {
                            var reader = new FileReader();
                            reader.onload = function (e) { insertFn(e.target.result); };
                            reader.readAsDataURL(file);
                        }
                    }
                }
            };
            var toolbarConfig = [
                'headerSelect', 'fontSize', 'fontFamily', 'lineHeight', '|',
                'bold', 'italic', 'underline', 'through', 'color', 'bgColor', 'clearStyle', '|',
                'bulletedList', 'numberedList', 'todo', 'blockquote', '|',
                'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyJustify', 'indent', 'delIndent', '|',
                'insertLink', 'uploadImage', 'insertTable', 'insertVideo', '|',
                'undo', 'redo', 'fullScreen'
            ];
            newsEditorInstance = global.wangEditor.createEditor({
                selector: '#' + editorId,
                html: sanitizeNewsEditorHtml(content || '<p><br></p>'),
                config: editorConfig,
                mode: 'default'
            });
            global.wangEditor.createToolbar({
                editor: newsEditorInstance,
                selector: '#toolbar_' + editorId,
                config: { toolbarKeys: toolbarConfig }
            });
            enableNewsEditorToolbarUsability(toolbarEl);
            setTimeout(function () { focusNewsEditor(); }, 50);
            setTimeout(function () { focusNewsEditor(); }, 200);
        } catch (e) {
            console.error('wangEditor init error', e);
        }
    }

    function isNewsEditorFocused() {
        try {
            return !!(newsEditorInstance && typeof newsEditorInstance.isFocused === 'function' && newsEditorInstance.isFocused());
        } catch (e) {
            return false;
        }
    }

    // 记录用户最后一次有效选区，供工具栏/写入时恢复，避免光标乱跳
    var newsLastSelection = null;

    function captureNewsSelection() {
        try {
            if (newsEditorInstance && newsEditorInstance.selection) {
                newsLastSelection = newsEditorInstance.selection;
            }
        } catch (e) {}
    }

    function focusNewsEditor() {
        if (!newsEditorInstance) return;
        try {
            if (typeof newsEditorInstance.enable === 'function') newsEditorInstance.enable();
            // 优先恢复上次选区；否则聚焦到末尾。绝不强制跳到开头
            if (newsLastSelection && typeof newsEditorInstance.select === 'function') {
                try { newsEditorInstance.select(newsLastSelection); return; } catch (e1) {}
            }
            if (typeof newsEditorInstance.restoreSelection === 'function') {
                try { newsEditorInstance.restoreSelection(); return; } catch (e2) {}
            }
            newsEditorInstance.focus(true);
        } catch (e) {}
    }

    /** 清洗 AI/模板 HTML，避免 Slate 路径错乱 */
    function sanitizeNewsEditorHtml(html) {
        var s = String(html || '').trim();
        if (!s) return '<p><br></p>';
        s = s.replace(/^```(?:html|HTML)?\s*/i, '').replace(/\s*```$/i, '').trim();
        s = s.replace(/<\/?(html|body|head)[^>]*>/gi, '');
        if (s.indexOf('<') < 0) {
            s = '<p>' + esc(s).replace(/\n+/g, '</p><p>') + '</p>';
        }
        if (!s.replace(/<[^>]*>/g, '').trim()) return '<p><br></p>';
        return s;
    }

    /** 安全写入正文：整篇替换，写完把光标放到末尾；失败则重建编辑器 */
    function safeSetNewsEditorHtml(html) {
        var clean = sanitizeNewsEditorHtml(html);
        newsLastSelection = null;
        if (!newsEditorInstance) {
            if (newsEditorId && newsEditorModalId) initNewsEditor(newsEditorId, newsEditorModalId, clean);
            return;
        }
        try {
            try { newsEditorInstance.deselect && newsEditorInstance.deselect(); } catch (e3) {}
            try { newsEditorInstance.clear(); } catch (e4) {}
            newsEditorInstance.setHtml(clean);
            try { newsEditorInstance.focus(true); } catch (e5) {}
            captureNewsSelection();
            markNewsModalDirty();
            return;
        } catch (err) {
            console.warn('safeSetNewsEditorHtml fallback', err);
        }
        try {
            var toolbarEl = document.getElementById('toolbar_' + newsEditorId);
            var editorEl = document.getElementById(newsEditorId);
            try { if (newsEditorInstance.destroy) newsEditorInstance.destroy(); } catch (e6) {}
            newsEditorInstance = null;
            if (toolbarEl) {
                toolbarEl.innerHTML = '';
                toolbarEl.dataset.toolbarFix = '';
            }
            if (editorEl) {
                editorEl.innerHTML = '';
                editorEl.dataset.focusFix = '';
            }
            initNewsEditor(newsEditorId, newsEditorModalId, clean);
            markNewsModalDirty();
        } catch (err2) {
            throw err2;
        }
    }

    function portNewsEditorPanels() {
        var panels = document.querySelectorAll('.w-e-select-list, .w-e-drop-panel, .w-e-bar-item-menus-container, .w-e-panel-content-color, .w-e-panel-content-emotion');
        panels.forEach(function (panel) {
            try {
                if (!panel || panel.style.display === 'none') return;
                var rect = panel.getBoundingClientRect();
                if (rect.width < 2 && rect.height < 2) return;
                if (panel.parentElement === document.body && panel.dataset.newsPorted === '1') {
                    panel.style.zIndex = '10080';
                    return;
                }
                var nextLeft = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
                var nextTop = Math.max(8, Math.min(rect.top, window.innerHeight - Math.min(rect.height, 280) - 8));
                document.body.appendChild(panel);
                panel.style.position = 'fixed';
                panel.style.left = nextLeft + 'px';
                panel.style.top = nextTop + 'px';
                panel.style.zIndex = '10080';
                panel.dataset.newsPorted = '1';
            } catch (err) {}
        });
    }

    /**
     * 工具栏可用性：
     * - wangEditor 自身会保留选区，按钮对最近选区生效，无需强制 refocus
     * - 仅：记录选区 + 把可能被裁切的下拉面板移到 body 顶层
     */
    function enableNewsEditorToolbarUsability(toolbarEl) {
        if (!toolbarEl || toolbarEl.dataset.toolbarFix === '1') return;
        toolbarEl.dataset.toolbarFix = '1';
        toolbarEl.addEventListener('mouseup', function () {
            setTimeout(portNewsEditorPanels, 20);
        }, true);
        toolbarEl.addEventListener('click', function () {
            setTimeout(portNewsEditorPanels, 20);
        }, true);

        var editorEl = document.getElementById(newsEditorId);
        if (editorEl && editorEl.dataset.focusFix !== '1') {
            editorEl.dataset.focusFix = '1';
            // 只记录选区，绝不重置光标
            var cap = function () { captureNewsSelection(); };
            editorEl.addEventListener('keyup', cap, true);
            editorEl.addEventListener('mouseup', cap, true);
            editorEl.addEventListener('input', cap, true);
        }
    }

    // 兼容旧函数名
    function enableNewsEditorDropdownFix(toolbarEl) {
        enableNewsEditorToolbarUsability(toolbarEl);
    }

    function handleCoverUpload(event, modalId) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        if (!String(file.type || '').startsWith('image/')) {
            alert('请选择图片文件');
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            var url = e.target.result;
            var coverInput = document.getElementById('newsCover');
            var img = document.getElementById('coverImage_' + modalId);
            var prev = document.getElementById('coverPreview_' + modalId);
            var ph = document.getElementById('coverPlaceholder_' + modalId);
            if (coverInput) coverInput.value = url;
            if (img) img.src = url;
            if (prev) prev.classList.remove('hidden');
            if (ph) ph.classList.add('hidden');
            markNewsModalDirty();
        };
        reader.readAsDataURL(file);
    }

    function clearCoverImage(modalId) {
        var coverInput = document.getElementById('newsCover');
        if (coverInput) coverInput.value = '';
        var img = document.getElementById('coverImage_' + modalId);
        if (img) img.src = '';
        var prev = document.getElementById('coverPreview_' + modalId);
        var ph = document.getElementById('coverPlaceholder_' + modalId);
        if (prev) prev.classList.add('hidden');
        if (ph) ph.classList.remove('hidden');
        var fileInput = document.getElementById('coverFileInput_' + modalId);
        if (fileInput) fileInput.value = '';
        markNewsModalDirty();
    }

    function handleNewsAttachUpload(event) {
        var files = event.target.files;
        if (!files || !files.length) return;
        Array.prototype.forEach.call(files, function (file) {
            if (file.size > 2 * 1024 * 1024) {
                alert(file.name + ' 超过 2MB，已跳过');
                return;
            }
            var reader = new FileReader();
            reader.onload = function (e) {
                newsPendingAttachments.push({ name: file.name, url: e.target.result, size: file.size, from: 'local' });
                renderNewsAttachList();
                markNewsModalDirty();
            };
            reader.readAsDataURL(file);
        });
        event.target.value = '';
    }

    function renderNewsAttachList() {
        var box = document.getElementById('newsAttachList');
        if (!box) return;
        if (!newsPendingAttachments.length) {
            box.innerHTML = '<span class="text-gray-400">暂无附件</span>';
            return;
        }
        box.innerHTML = newsPendingAttachments.map(function (a, i) {
            return '<div class="flex justify-between items-center py-1 border-b border-gray-100">' +
                '<span>' + esc(a.name) + ' <span class="text-gray-400">(' + Math.round((a.size || 0) / 1024) + 'KB)</span></span>' +
                '<button type="button" class="text-red-500 text-xs" onclick="removeNewsAttach(' + i + ')">移除</button></div>';
        }).join('');
    }

    function removeNewsAttach(i) {
        newsPendingAttachments.splice(i, 1);
        renderNewsAttachList();
        markNewsModalDirty();
    }

    function showNewsTemplateLibrary() {
        var html = Object.keys(NEWS_TEMPLATE_LIBRARY).map(function (key) {
            var cat = NEWS_TEMPLATE_LIBRARY[key];
            return '<div style="margin-bottom:12px;"><div style="font-weight:600;color:#7c3aed;margin-bottom:6px;">' + esc(cat.label) + '</div>' +
                cat.items.map(function (it, idx) {
                    return '<button class="btn btn-secondary" style="margin:0 6px 6px 0;padding:4px 10px;font-size:12px;" onclick="applyNewsTemplate(\'' + key + '\',' + idx + ')">' + esc(it.title) + '</button>';
                }).join('') + '</div>';
        }).join('');
        var id = 'newsTplModal_' + Date.now();
        var el = document.createElement('div');
        el.id = id;
        el.className = 'fixed inset-0 bg-black/40 z-[7000] flex justify-center items-center';
        el.innerHTML = '<div class="bg-white rounded-xl w-[520px] max-h-[80vh] overflow-auto p-5">' +
            '<div class="flex justify-between mb-3"><h4 class="font-semibold text-lg">分类模板库</h4><button onclick="document.getElementById(\'' + id + '\').remove()">×</button></div>' +
            html + '</div>';
        document.body.appendChild(el);
    }

    function ensureNewsEditorReady() {
        focusNewsEditor();
        return !!newsEditorInstance;
    }

    function applyNewsTemplate(catKey, idx) {
        var cat = NEWS_TEMPLATE_LIBRARY[catKey];
        if (!cat || !cat.items[idx]) return;
        ensureNewsEditorReady();
        safeSetNewsEditorHtml(cat.items[idx].content);
        var title = document.getElementById('newsTitle');
        if (title && !title.value.trim()) title.value = cat.items[idx].title;
        var modals = document.querySelectorAll('[id^="newsTplModal_"]');
        modals.forEach(function (m) { m.remove(); });
    }

    function oneClickNewsFormat() {
        if (!ensureNewsEditorReady()) return;
        var html = newsEditorInstance.getHtml() || '';
        html = html.replace(/<p>\s*<\/p>/g, '');
        html = html.replace(/style="[^"]*"/gi, '');
        html = html.replace(/<img /gi, '<img style="display:block;margin:12px auto;max-width:100%;" ');
        safeSetNewsEditorHtml(html);
        alert('已完成一键排版（清理空段/行内样式，图片居中）');
    }

    function clearNewsEditorFormat() {
        if (!ensureNewsEditorReady()) return;
        var text = newsEditorInstance.getText();
        safeSetNewsEditorHtml('<p>' + esc(text).replace(/\n/g, '</p><p>') + '</p>');
    }

    function collectNewsFormPayload() {
        var authorSel = document.getElementById('newsAuthor');
        var author = authorSel ? authorSel.value.trim() : '';
        var authorId = null;
        if (authorSel && authorSel.selectedOptions && authorSel.selectedOptions[0]) {
            authorId = authorSel.selectedOptions[0].getAttribute('data-id');
        }
        var tagsRaw = (document.getElementById('newsTags') || {}).value || '';
        var tags = tagsRaw.split(/[,，、\s]+/).map(function (t) { return t.trim(); }).filter(Boolean);
        var content = newsEditorInstance ? newsEditorInstance.getHtml() : '';
        var summary = ((document.getElementById('newsSummary') || {}).value || '').trim();
        if (!summary) {
            var text = content.replace(/<[^>]*>/g, '').trim();
            summary = text.substring(0, 100) + (text.length > 100 ? '…' : '');
        }
        return {
            title: ((document.getElementById('newsTitle') || {}).value || '').trim(),
            category: ((document.getElementById('newsCategory') || {}).value || NEWS_CATEGORIES[0]),
            author: author,
            authorId: authorId,
            tags: tags,
            keywords: tags.join('、'),
            summary: summary,
            content: content,
            cover: ((document.getElementById('newsCover') || {}).value || ''),
            originalUrl: ((document.getElementById('newsOriginalUrl') || {}).value || '').trim(),
            pinned: !!(document.getElementById('newsPinned') || {}).checked,
            allowComment: !!(document.getElementById('newsAllowComment') || {}).checked,
            scheduledAt: ((document.getElementById('newsScheduledAt') || {}).value || ''),
            attachments: newsPendingAttachments.slice(),
            mode: ((document.getElementById('newsPublishMode') || {}).value || 'publish')
        };
    }

    function validateNewsPublish(payload, soft) {
        if (!payload.title) return { ok: false, hard: true, msg: '请填写新闻标题' };
        if (!payload.content.replace(/<[^>]*>/g, '').trim()) return { ok: false, hard: true, msg: '请填写正文内容' };
        if (!payload.category) return { ok: false, hard: true, msg: '请选择分类' };
        var warns = [];
        if (payload.title.length > 60) warns.push('标题较长（超过 60 字）');
        if (!payload.cover) warns.push('当前未上传封面图');
        if ((payload.summary || '').length < 40) warns.push('摘要较短（建议 80–150 字）');
        var hit = NEWS_SENSITIVE.filter(function (w) {
            return (payload.title + payload.summary + payload.content).indexOf(w) >= 0;
        });
        if (hit.length) warns.push('可能包含敏感词：' + hit.join('、'));
        if (soft && warns.length) {
            if (!confirm(warns.join('\n') + '\n\n是否继续？')) return { ok: false, hard: false, msg: '已取消' };
        }
        return { ok: true };
    }

    function commitNewsModal(modalId, forceMode) {
        var payload = collectNewsFormPayload();
        var mode = forceMode || payload.mode || 'publish';
        var check = validateNewsPublish(payload, mode !== 'draft');
        if (!check.ok) {
            if (check.msg && check.msg !== '已取消') alert(check.msg);
            return;
        }
        var status = 'draft';
        if (mode === 'schedule') {
            if (!canPublishNews()) { alert('仅导师/组长可设定时发布'); return; }
            if (!payload.scheduledAt) { alert('请选择定时发布时间'); return; }
            status = 'scheduled';
        } else if (mode === 'publish') {
            status = canPublishNews() ? 'published' : 'pending';
        } else {
            status = 'draft';
        }
        persistNewsPayload(payload, status);
        newsModalDirty = false;
        stopNewsAutoSave();
        try { if (newsEditorInstance && newsEditorInstance.destroy) newsEditorInstance.destroy(); } catch (e) {}
        newsEditorInstance = null;
        var el = document.getElementById(modalId);
        if (el) el.remove();
        var tip = status === 'published' ? '新闻发布成功' : (status === 'pending' ? '已提交审核' : (status === 'scheduled' ? '已设定时发布' : '草稿已保存'));
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner(tip, false);
        else alert(tip);
    }

    function persistNewsPayload(payload, status) {
        var u = getCurrentUser();
        var base = {
            title: payload.title,
            category: payload.category,
            author: payload.author,
            authorId: payload.authorId,
            tags: payload.tags,
            keywords: payload.keywords,
            summary: payload.summary,
            content: payload.content,
            cover: payload.cover,
            originalUrl: payload.originalUrl,
            pinned: payload.pinned,
            allowComment: payload.allowComment,
            scheduledAt: status === 'scheduled' ? payload.scheduledAt.replace('T', ' ') : '',
            attachments: payload.attachments || [],
            status: status,
            updatedAt: nowStr()
        };
        if (editingNewsId) {
            var idx = newsData.findIndex(function (n) { return n.id === editingNewsId; });
            if (idx >= 0) {
                var prev = newsData[idx];
                newsData[idx] = normalizeNewsRecord(Object.assign({}, prev, base, {
                    publishTime: status === 'published' && prev.status !== 'published' ? dateStr() : prev.publishTime
                }));
            }
        } else {
            var newId = newsData.length ? Math.max.apply(null, newsData.map(function (n) { return Number(n.id) || 0; })) + 1 : 1;
            newsData.push(normalizeNewsRecord(Object.assign({}, base, {
                id: newId,
                views: 0,
                likes: 0,
                comments: [],
                favorites: [],
                shareCount: 0,
                viewLogs: [],
                publishTime: status === 'published' ? dateStr() : '',
                createdAt: nowStr(),
                createdBy: u ? u.id : null
            })));
            editingNewsId = newId;
        }
        saveNewsData({ log: { action: status === 'published' ? '发布' : (status === 'pending' ? '提交审核' : '保存'), desc: base.title } });
    }

    function showMobileNewsPreview() {
        var p = collectNewsFormPayload();
        var id = 'newsPreview_' + Date.now();
        var el = document.createElement('div');
        el.id = id;
        el.className = 'fixed inset-0 bg-black/60 z-[6000] flex justify-center items-center';
        el.innerHTML = '<div class="bg-white rounded-xl p-5 max-h-[90vh] overflow-auto"><div class="flex justify-between mb-3"><h4 class="font-semibold">手机预览</h4><button onclick="document.getElementById(\'' + id + '\').remove()">×</button></div>' +
            '<div class="bg-gray-100 p-3 rounded-lg"><div class="bg-white w-[375px] overflow-hidden rounded-lg shadow">' +
            '<div class="bg-[#7c3aed] text-white text-center text-sm py-2">城市安全数智创新团队</div>' +
            (p.cover ? '<img src="' + esc(p.cover) + '" class="w-full h-48 object-cover">' : '') +
            '<div class="p-4"><h1 class="text-xl font-bold mb-2">' + esc(p.title || '标题') + '</h1>' +
            '<div class="text-sm text-gray-500 mb-3">' + esc(p.author) + ' · ' + dateStr() + '</div>' +
            (p.summary ? '<p class="text-sm text-gray-600 italic mb-3">' + esc(p.summary) + '</p>' : '') +
            '<div class="text-sm leading-relaxed news-detail-body">' + (p.content || '') + '</div></div></div></div></div>';
        document.body.appendChild(el);
    }

    /* ---------- 列表操作 ---------- */

    function publishNews(id) {
        if (!canPublishNews()) { alert('仅导师/组长可直接发布'); return; }
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0) return;
        newsData[idx].status = 'published';
        newsData[idx].publishTime = dateStr();
        newsData[idx].updatedAt = nowStr();
        saveNewsData({ log: { action: '发布', desc: newsData[idx].title } });
        alert('发布成功');
    }

    function unpublishNews(id) {
        if (!canManageNews()) return;
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0) return;
        newsData[idx].status = 'withdrawn';
        newsData[idx].updatedAt = nowStr();
        saveNewsData({ log: { action: '撤回', desc: newsData[idx].title } });
        alert('已撤回');
    }

    function submitNewsForReview(id) {
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0 || !canEditNews(newsData[idx])) return;
        newsData[idx].status = 'pending';
        newsData[idx].updatedAt = nowStr();
        saveNewsData({ log: { action: '提交审核', desc: newsData[idx].title } });
        alert('已提交审核');
    }

    function reviewNews(id, pass) {
        if (!canReviewNews()) return;
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0) return;
        var note = pass ? '' : (prompt('请填写驳回意见（可选）', '') || '');
        var u = getCurrentUser();
        if (pass) {
            newsData[idx].status = 'published';
            newsData[idx].publishTime = dateStr();
        } else {
            newsData[idx].status = 'draft';
            newsData[idx].reviewNote = note;
        }
        newsData[idx].reviewedBy = u ? (u.realName || u.username) : '';
        newsData[idx].reviewedAt = nowStr();
        newsData[idx].updatedAt = nowStr();
        saveNewsData({ log: { action: pass ? '审核通过' : '审核驳回', desc: newsData[idx].title, detail: { note: note } } });
        alert(pass ? '已通过并发布' : '已驳回为草稿');
    }

    function toggleNewsPin(id) {
        if (!canManageNews()) return;
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0) return;
        newsData[idx].pinned = !newsData[idx].pinned;
        newsData[idx].updatedAt = nowStr();
        saveNewsData({ log: { action: newsData[idx].pinned ? '置顶' : '取消置顶', desc: newsData[idx].title } });
    }

    function deleteNews(id) {
        if (!canManageNews()) { alert('无权限删除'); return; }
        if (!confirm('确定删除该新闻？')) return;
        var hit = newsData.find(function (n) { return n.id === id; });
        newsData = newsData.filter(function (n) { return n.id !== id; });
        saveNewsData({ log: { action: '删除', desc: (hit && hit.title) || String(id) } });
        alert('已删除');
    }

    function copyNewsLink(id) {
        var url = location.origin + location.pathname + '#news/' + id;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () { alert('链接已复制'); }).catch(function () { prompt('复制链接', url); });
        } else {
            prompt('复制链接', url);
        }
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx >= 0) {
            newsData[idx].shareCount = (newsData[idx].shareCount || 0) + 1;
            saveNewsData({ silent: true });
        }
    }

    function toggleNewsFavorite(id) {
        var u = getCurrentUser();
        if (!u) return;
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0) return;
        var uid = String(u.id);
        var fav = newsData[idx].favorites || [];
        if (fav.indexOf(uid) >= 0) fav = fav.filter(function (x) { return x !== uid; });
        else fav.push(uid);
        newsData[idx].favorites = fav;
        saveNewsData({ silent: false });
        alert(fav.indexOf(uid) >= 0 ? '已收藏' : '已取消收藏');
    }

    /* ---------- 详情 / 统计 / 首页 ---------- */

    function recordNewsView(item) {
        if (!item || item.status !== 'published') return;
        var u = getCurrentUser();
        var uid = u ? String(u.id || u.username || 'guest') : 'guest';
        var day = new Date().toISOString().slice(0, 10);
        item.viewLogs = item.viewLogs || [];
        var exists = item.viewLogs.some(function (v) { return String(v.userId) === uid && v.day === day; });
        if (!exists) {
            item.viewLogs.push({ userId: uid, user: u ? (u.realName || u.username) : '访客', day: day, time: nowStr() });
            item.views = (item.views || 0) + 1;
            saveNewsData({ silent: true });
        }
    }

    function getRelatedNews(item, limit) {
        limit = limit || 4;
        return (newsData || []).filter(function (n) {
            if (n.id === item.id || n.status !== 'published') return false;
            if (n.category === item.category) return true;
            if (n.author === item.author) return true;
            var tags = item.tags || [];
            return tags.some(function (t) { return (n.tags || []).indexOf(t) >= 0; });
        }).slice(0, limit);
    }

    function showNewsDetail(id) {
        loadNewsData();
        var item = newsData.find(function (n) { return n.id === id; });
        if (!item) { alert('新闻不存在'); return; }
        var u = getCurrentUser();
        if (item.status !== 'published' && !(u && (canManageNews() || canEditNews(item)))) {
            alert('该新闻尚未发布');
            return;
        }
        recordNewsView(item);
        var related = getRelatedNews(item);
        var status = NEWS_STATUS_CONFIG[item.status] || NEWS_STATUS_CONFIG.draft;
        var idModal = 'newsDetail_' + Date.now();
        var commentsHtml = (item.comments || []).map(function (c) {
            return '<div style="padding:10px 0;border-bottom:1px solid #f0f0f0;"><div style="font-size:13px;font-weight:600;">' + esc(c.user) +
                ' <span style="color:#94a3b8;font-weight:400;font-size:12px;">' + esc(c.time) + '</span></div>' +
                '<div style="font-size:13px;color:#334155;margin-top:4px;">' + esc(c.content) + '</div></div>';
        }).join('') || '<div style="color:#94a3b8;font-size:13px;">暂无评论</div>';
        var attachHtml = (item.attachments || []).map(function (a) {
            return '<a href="' + esc(a.url) + '" download="' + esc(a.name) + '" style="display:inline-block;margin:4px 8px 4px 0;padding:6px 10px;background:#f5f3ff;border-radius:8px;font-size:12px;color:#6d28d9;">📎 ' + esc(a.name) + '</a>';
        }).join('') || '<span style="color:#94a3b8;font-size:13px;">无附件</span>';
        var relatedHtml = related.map(function (n) {
            return '<div onclick="document.getElementById(\'' + idModal + '\').remove();showNewsDetail(' + n.id + ')" style="padding:10px;border:1px solid #f0f0f0;border-radius:8px;cursor:pointer;margin-bottom:8px;">' +
                '<div style="font-weight:600;font-size:13px;">' + esc(n.title) + '</div>' +
                '<div style="font-size:12px;color:#94a3b8;">' + esc(n.category) + ' · ' + esc(n.publishTime || '') + '</div></div>';
        }).join('') || '<div style="color:#94a3b8;font-size:13px;">暂无相关推荐</div>';

        var el = document.createElement('div');
        el.id = idModal;
        el.className = 'fixed inset-0 bg-black/50 z-[5500] flex justify-center items-start overflow-auto';
        el.innerHTML = '<div class="bg-white rounded-xl w-[860px] max-w-[96vw] my-6 shadow-2xl overflow-hidden">' +
            (item.cover ? '<img src="' + esc(item.cover) + '" style="width:100%;max-height:320px;object-fit:cover;">' : '') +
            '<div style="padding:24px 28px;">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">' +
            '<div><span style="display:inline-block;padding:2px 8px;background:' + status.bgColor + ';color:' + status.color + ';border-radius:999px;font-size:12px;margin-right:6px;">' + status.label + '</span>' +
            (item.pinned ? '<span style="display:inline-block;padding:2px 8px;background:#f3e8ff;color:#7c3aed;border-radius:999px;font-size:12px;">置顶</span>' : '') +
            '<h2 style="font-size:24px;font-weight:800;margin:10px 0 8px;line-height:1.35;">' + esc(item.title) + '</h2>' +
            '<div style="font-size:13px;color:#64748b;">' + esc(item.category) + ' · ' + esc(item.author) + ' · ' + esc(item.publishTime || item.updatedAt || '') +
            ' · 👁️ ' + (item.views || 0) + ' · 👍 ' + (item.likes || 0) + '</div></div>' +
            '<button class="text-2xl text-gray-400" onclick="document.getElementById(\'' + idModal + '\').remove()">×</button></div>' +
            (item.summary ? '<p style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-radius:8px;color:#475569;font-size:14px;">' + esc(item.summary) + '</p>' : '') +
            '<div class="news-detail-body" style="font-size:15px;line-height:1.8;color:#1e293b;margin:18px 0;">' + (item.content || '') + '</div>' +
            (item.originalUrl ? '<p style="font-size:13px;"><a href="' + esc(item.originalUrl) + '" target="_blank" rel="noopener">原文链接 →</a></p>' : '') +
            '<div style="margin:18px 0;"><div style="font-weight:600;margin-bottom:8px;">附件</div>' + attachHtml + '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:16px 0;">' +
            '<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="likeNews(' + item.id + ')">👍 点赞</button>' +
            '<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="copyNewsLink(' + item.id + ')">复制链接</button>' +
            '<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="shareNewsToWeekly(' + item.id + ')">分享到周报</button>' +
            '<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="showNewsStats(' + item.id + ')">阅读统计</button>' +
            (canEditNews(item) ? '<button class="btn" style="padding:6px 12px;font-size:12px;" onclick="document.getElementById(\'' + idModal + '\').remove();showEditNewsModal(' + item.id + ')">编辑</button>' : '') +
            '</div>' +
            (item.allowComment ? ('<div style="margin-top:20px;border-top:1px solid #f0f0f0;padding-top:16px;"><div style="font-weight:600;margin-bottom:8px;">评论区</div>' +
                commentsHtml +
                '<div style="display:flex;gap:8px;margin-top:12px;"><input id="newsCommentInput_' + idModal + '" class="flex-1 px-3 py-2 border rounded-lg" placeholder="写下评论…">' +
                '<button class="btn" style="padding:8px 14px;" onclick="postNewsComment(' + item.id + ',\'' + idModal + '\')">发送</button></div></div>') : '') +
            '<div style="margin-top:24px;"><div style="font-weight:600;margin-bottom:10px;">相关新闻</div>' + relatedHtml + '</div>' +
            '</div></div>';
        document.body.appendChild(el);
        updateNewsStats();
        renderNewsList();
    }

    function likeNews(id) {
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0) return;
        newsData[idx].likes = (newsData[idx].likes || 0) + 1;
        saveNewsData({ silent: true });
        alert('已点赞（' + newsData[idx].likes + '）');
    }

    function postNewsComment(id, modalId) {
        var u = getCurrentUser();
        if (!u) { alert('请先登录'); return; }
        var input = document.getElementById('newsCommentInput_' + modalId);
        var text = input ? input.value.trim() : '';
        if (!text) return;
        var idx = newsData.findIndex(function (n) { return n.id === id; });
        if (idx < 0) return;
        newsData[idx].comments = newsData[idx].comments || [];
        newsData[idx].comments.push({
            id: Date.now(),
            user: u.realName || u.username,
            userId: u.id,
            content: text,
            time: nowStr()
        });
        saveNewsData({ log: { action: '评论', desc: newsData[idx].title } });
        document.getElementById(modalId).remove();
        showNewsDetail(id);
    }

    function showNewsStats(id) {
        var item = newsData.find(function (n) { return n.id === id; });
        if (!item) return;
        var logs = item.viewLogs || [];
        var days = {};
        for (var i = 6; i >= 0; i--) {
            var d = new Date();
            d.setDate(d.getDate() - i);
            var key = d.toISOString().slice(0, 10);
            days[key] = 0;
        }
        logs.forEach(function (v) { if (days[v.day] != null) days[v.day]++; });
        var max = Math.max(1, Math.max.apply(null, Object.keys(days).map(function (k) { return days[k]; })));
        var bars = Object.keys(days).map(function (k) {
            var h = Math.round((days[k] / max) * 80);
            return '<div style="flex:1;text-align:center;"><div style="height:80px;display:flex;align-items:flex-end;justify-content:center;"><div style="width:70%;height:' + h + 'px;background:#7c3aed;border-radius:4px 4px 0 0;"></div></div><div style="font-size:10px;color:#94a3b8;margin-top:4px;">' + k.slice(5) + '</div></div>';
        }).join('');
        var uniq = {};
        logs.forEach(function (v) { uniq[String(v.userId)] = true; });
        var mid = 'newsStats_' + Date.now();
        var el = document.createElement('div');
        el.id = mid;
        el.className = 'fixed inset-0 bg-black/40 z-[5600] flex justify-center items-center';
        el.innerHTML = '<div class="bg-white rounded-xl w-[520px] p-5">' +
            '<div class="flex justify-between mb-3"><h4 class="font-semibold text-lg">阅读统计 · ' + esc(item.title) + '</h4><button onclick="document.getElementById(\'' + mid + '\').remove()">×</button></div>' +
            '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">' +
            statCard(item.views || 0, '总浏览') + statCard(Object.keys(uniq).length, '独立访客') +
            statCard(item.likes || 0, '点赞') + statCard((item.comments || []).length, '评论') +
            '</div><div style="font-size:13px;color:#64748b;margin-bottom:8px;">近 7 天浏览</div>' +
            '<div style="display:flex;gap:4px;align-items:flex-end;">' + bars + '</div>' +
            '<div style="margin-top:12px;font-size:12px;color:#94a3b8;">分享次数：' + (item.shareCount || 0) + ' · 收藏：' + ((item.favorites || []).length) + '</div></div>';
        document.body.appendChild(el);
    }

    function statCard(v, label) {
        return '<div style="background:#f8fafc;border-radius:10px;padding:12px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#7c3aed;">' + v + '</div><div style="font-size:12px;color:#94a3b8;">' + label + '</div></div>';
    }

    function shareNewsToWeekly(id) {
        var item = newsData.find(function (n) { return n.id === id; });
        if (!item) return;
        var u = getCurrentUser();
        if (!u) { alert('请先登录'); return; }
        var block = '【新闻】' + item.title + '\n' + (item.summary || '') + '\n';
        try {
            if (Array.isArray(global.weeklyReportData)) {
                var myName = u.realName || u.username;
                var mine = global.weeklyReportData.filter(function (r) { return r.owner === myName; })
                    .sort(function (a, b) { return (b.id || 0) - (a.id || 0); })[0];
                if (mine) {
                    mine.content = (mine.content || '') + (mine.content ? '\n\n' : '') + block;
                    if (typeof global.saveWeeklyReportData === 'function') global.saveWeeklyReportData();
                    else {
                        localStorage.setItem('weeklyReportData', JSON.stringify(global.weeklyReportData));
                        try { if (typeof global.cloudUpsert === 'function') global.cloudUpsert('weeklyReportData', JSON.stringify(global.weeklyReportData)); } catch (e) {}
                    }
                    alert('已追加到你最近一条周报内容中');
                    return;
                }
            }
        } catch (e) {}
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(block).then(function () {
                alert('未找到进行中周报，摘要已复制，请到周报模块粘贴');
            });
        } else {
            prompt('复制到周报', block);
        }
    }

    function renderHomeNewsPanel() {
        var box = document.getElementById('homeNewsList');
        if (!box) return;
        try { if (!newsData || !newsData.length) loadNewsData(); } catch (e) {}
        var list = (newsData || []).filter(function (n) { return n.status === 'published'; })
            .sort(function (a, b) {
                if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
                return (Number(b.id) || 0) - (Number(a.id) || 0);
            }).slice(0, 5);
        if (!list.length) {
            box.innerHTML = '<div class="home-empty">暂无已发布新闻</div>';
            return;
        }
        box.innerHTML = list.map(function (n, i) {
            return '<div class="home-feed-item" onclick="showNewsDetail(' + n.id + ')">' +
                '<span class="home-feed-dot"></span>' +
                '<div style="min-width:0;flex:1;">' +
                '<div class="title">' + (n.pinned ? '置顶 · ' : '') + esc(n.title) + '</div>' +
                '<div class="meta">' + esc(n.publishTime || '') + '</div>' +
                '</div></div>';
        }).join('');
    }

    /* ---------- AI ---------- */

    async function callNewsAI(messages) {
        var apiKey = '';
        try {
            apiKey = typeof global.getChatApiKey === 'function'
                ? global.getChatApiKey()
                : (localStorage.getItem('openaiApiKey') || localStorage.getItem('aliyunApiKey') || '');
        } catch (e) {}
        apiKey = String(apiKey || '').trim();
        if (!apiKey) throw new Error('未配置百炼密钥，请到「智能工具 → OpenAI入口」保存后再用');

        var endpoints = ['/api/aliyun'];
        try {
            var proxy = String(global.API_PROXY || '').replace(/\/$/, '');
            if (proxy) endpoints.push(proxy + '/api/aliyun');
        } catch (e2) {}

        var lastErr = null;
        for (var i = 0; i < endpoints.length; i++) {
            try {
                var res = await fetch(endpoints[i], {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        apiKey: apiKey,
                        model: 'qwen-plus',
                        messages: messages,
                        temperature: 0.4,
                        max_tokens: 2000
                    })
                });
                var raw = await res.text();
                var data = null;
                try { data = JSON.parse(raw); } catch (e3) { data = null; }
                if (!res.ok) {
                    lastErr = new Error('AI 请求失败 ' + res.status + (raw ? '：' + raw.slice(0, 120) : ''));
                    continue;
                }
                var text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
                    || (data && data.output) || (data && data.text) || '';
                if (!text) {
                    lastErr = new Error('AI 无返回内容');
                    continue;
                }
                return String(text);
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr || new Error('AI 请求失败');
    }

    async function aiPolishNews() {
        if (!ensureNewsEditorReady()) return;
        var text = newsEditorInstance.getText();
        if (!text.trim()) { alert('请先输入正文'); return; }
        try {
            var out = await callNewsAI([
                { role: 'system', content: '你是高校科研团队新闻编辑。将用户文本润色为正式、简洁的中文新闻稿，保留事实，只输出 HTML 片段（可用 h2/p/ul/ol），不要输出 markdown 代码块、不要编造数据。' },
                { role: 'user', content: text }
            ]);
            safeSetNewsEditorHtml(out);
            alert('AI 润色完成，请核对后发布');
        } catch (e) {
            alert('AI 润色失败：' + String((e && e.message) || e).slice(0, 180) + '\n若已配置密钥仍失败，请关闭弹窗重开后再试。');
        }
    }

    async function aiGenerateNewsDraft() {
        if (!ensureNewsEditorReady()) {
            alert('编辑器未就绪，请关闭弹窗后重试');
            return;
        }
        var type = prompt('新闻类型（如：论文发表 / 会议预告 / 团队招新）', '论文发表');
        if (type == null) return;
        var author = prompt('作者/主角', (getCurrentUser() && getCurrentUser().realName) || '');
        var result = prompt('成果/主题关键词', '');
        var channel = prompt('发布渠道/期刊/会议（可空）', '');
        try {
            var out = await callNewsAI([
                { role: 'system', content: '你是高校科研团队新闻写手。根据关键词生成一篇中文新闻初稿，只输出 HTML（h2/p/ul/ol），不要 markdown 代码块，语气正式，不要虚构具体数据与单位。' },
                { role: 'user', content: '类型：' + type + '\n作者：' + author + '\n成果：' + result + '\n渠道：' + channel }
            ]);
            safeSetNewsEditorHtml(out);
            var title = document.getElementById('newsTitle');
            if (title && !title.value.trim()) title.value = type + '：' + (result || author || '团队动态');
            alert('AI 初稿已填入，请修改后发布');
        } catch (e) {
            alert('AI 生成失败：' + String((e && e.message) || e).slice(0, 180));
        }
    }

    /* ---------- 联动：成果 / 会议 → 草稿 ---------- */

    function createNewsDraftFromSource(opts) {
        opts = opts || {};
        loadNewsData();
        var u = getCurrentUser();
        var newId = newsData.length ? Math.max.apply(null, newsData.map(function (n) { return Number(n.id) || 0; })) + 1 : 1;
        var draft = normalizeNewsRecord({
            id: newId,
            title: opts.title || '未命名新闻草稿',
            category: opts.category || '团队动态',
            author: (u && (u.realName || u.username)) || '团队管理员',
            authorId: u ? u.id : null,
            summary: opts.summary || '',
            content: opts.content || ('<p>' + esc(opts.summary || opts.title || '') + '</p>'),
            status: 'draft',
            tags: opts.tags || [],
            createdAt: nowStr(),
            createdBy: u ? u.id : null,
            updatedAt: nowStr()
        });
        newsData.push(draft);
        saveNewsData({ log: { action: '自动草稿', desc: draft.title } });
        return draft;
    }

    function offerNewsDraftFromMeeting(meeting) {
        if (!meeting) return;
        if (!confirm('是否根据该会议自动生成一条新闻草稿？')) return;
        var draft = createNewsDraftFromSource({
            title: '会议动态：' + (meeting.title || ''),
            category: '学术交流',
            summary: (meeting.title || '') + ' 于 ' + (meeting.startTime || '') + ' 举行。',
            content: '<h2>会议动态</h2><p><strong>主题：</strong>' + esc(meeting.title || '') + '</p>' +
                '<p><strong>时间：</strong>' + esc(meeting.startTime || '') + ' - ' + esc(meeting.endTime || '') + '</p>' +
                '<p><strong>地点：</strong>' + esc(meeting.location || '') + '</p>' +
                '<p><strong>参会：</strong>' + esc(meeting.participants || '') + '</p>' +
                '<h3>议程</h3><p>' + esc(meeting.agenda || '（待补充）') + '</p>' +
                (meeting.notes ? '<h3>纪要</h3><p>' + esc(meeting.notes) + '</p>' : ''),
            tags: ['会议']
        });
        if (confirm('草稿已生成，是否立即打开编辑？')) {
            if (typeof global.showModule === 'function') global.showModule('news_management');
            setTimeout(function () { showEditNewsModal(draft.id); }, 200);
        }
    }

    function offerNewsDraftFromAchievement(payload) {
        payload = payload || {};
        if (!confirm('是否根据该成果自动生成新闻草稿？')) return;
        var draft = createNewsDraftFromSource({
            title: payload.title || '成果发布',
            category: '成果发布',
            summary: payload.summary || '',
            content: payload.content || ('<h2>成果发布</h2><p>' + esc(payload.summary || payload.title || '') + '</p>'),
            tags: payload.tags || ['成果']
        });
        if (confirm('草稿已生成，是否立即打开编辑？')) {
            if (typeof global.showModule === 'function') global.showModule('news_management');
            setTimeout(function () { showEditNewsModal(draft.id); }, 200);
        }
        return draft;
    }

    function offerNewsDraftFromPaper(paper) {
        if (!paper) return;
        if (!confirm('是否根据该论文自动生成新闻草稿？')) return;
        var draft = createNewsDraftFromSource({
            title: '论文成果：' + (paper.title || ''),
            category: '科研成果',
            summary: (paper.author || '') + ' 等在 ' + (paper.journal || '') + ' 发表论文《' + (paper.title || '') + '》',
            content: '<h2>论文成果</h2><p><strong>题目：</strong>' + esc(paper.title || '') + '</p>' +
                '<p><strong>作者：</strong>' + esc(paper.author || '') + '</p>' +
                '<p><strong>期刊：</strong>' + esc(paper.journal || '') + '</p>' +
                '<p><strong>发表日期：</strong>' + esc(paper.publish_date || '') + '</p>' +
                '<p>' + esc(paper.remark || '') + '</p>',
            tags: ['论文', paper.index || ''].filter(Boolean)
        });
        if (confirm('草稿已生成，是否立即打开编辑？')) {
            if (typeof global.showModule === 'function') global.showModule('news_management');
            setTimeout(function () { showEditNewsModal(draft.id); }, 200);
        }
        return draft;
    }

    function offerNewsDraftFromCompetition(item) {
        if (!item) return;
        if (!confirm('是否根据该竞赛成果自动生成新闻草稿？')) return;
        var name = item.name || item.title || '竞赛成果';
        var draft = createNewsDraftFromSource({
            title: '竞赛喜报：' + name,
            category: '团队动态',
            summary: name + ' 获得 ' + (item.award || item.level || '优异成绩'),
            content: '<h2>竞赛喜报</h2><p><strong>项目：</strong>' + esc(name) + '</p>' +
                '<p><strong>赛事：</strong>' + esc(item.event || '') + '</p>' +
                '<p><strong>奖项：</strong>' + esc(item.award || item.level || '') + '</p>' +
                '<p><strong>级别：</strong>' + esc(item.level || '') + '</p>' +
                '<p><strong>成员：</strong>' + esc(item.members || item.author || '') + '</p>',
            tags: ['竞赛', item.level || ''].filter(Boolean)
        });
        if (confirm('草稿已生成，是否立即打开编辑？')) {
            if (typeof global.showModule === 'function') global.showModule('news_management');
            setTimeout(function () { showEditNewsModal(draft.id); }, 200);
        }
        return draft;
    }

    function offerNewsDraftFromProject(item) {
        if (!item) return;
        if (!confirm('是否根据该项目进展自动生成新闻草稿？')) return;
        var name = item.name || item.title || item.projectName || '科研项目';
        var draft = createNewsDraftFromSource({
            title: '项目动态：' + name,
            category: '项目进展',
            summary: name + '（' + (item.status || '推进中') + '）',
            content: '<h2>项目动态</h2><p><strong>项目：</strong>' + esc(name) + '</p>' +
                '<p><strong>编号：</strong>' + esc(item.projectNumber || '') + '</p>' +
                '<p><strong>负责人：</strong>' + esc(item.leader || item.owner || '') + '</p>' +
                '<p><strong>状态：</strong>' + esc(item.status || '') + '</p>' +
                '<p>' + esc(item.remark || '') + '</p>',
            tags: ['项目', item.projectType || ''].filter(Boolean)
        });
        if (confirm('草稿已生成，是否立即打开编辑？')) {
            if (typeof global.showModule === 'function') global.showModule('news_management');
            setTimeout(function () { showEditNewsModal(draft.id); }, 200);
        }
        return draft;
    }

    /* ---------- 样式 ---------- */

    function injectNewsStyles() {
        if (document.getElementById('newsMgmtStyles')) return;
        var s = document.createElement('style');
        s.id = 'newsMgmtStyles';
        s.textContent =
            '.news-stat-card{cursor:pointer;transition:box-shadow .15s,border-color .15s;border:2px solid transparent;}' +
            '.news-stat-card:hover{box-shadow:0 4px 14px rgba(124,58,237,.12);}' +
            '.news-stat-card.news-stat-active{border-color:#7c3aed;background:#faf5ff;}' +
            '.news-detail-body img{max-width:100%;height:auto;display:block;margin:12px auto;}' +
            '.news-detail-body table{display:block;max-width:100%;overflow-x:auto;}' +
            '.news-editor-host,.news-editor-host .w-e-toolbar,.news-editor-host .w-e-bar{overflow:visible!important;}' +
            '.news-editor-host .w-e-bar-item{pointer-events:auto!important;}' +
            '.w-e-select-list,.w-e-drop-panel,.w-e-bar-item-menus-container,.w-e-panel-content-color{z-index:10080!important;}' +
            '@media(max-width:768px){.news-detail-body{font-size:14px;}}';
        document.head.appendChild(s);
    }

    /* ---------- 导出 ---------- */

    var api = {
        NEWS_CATEGORIES: NEWS_CATEGORIES,
        initNewsManagement: initNewsManagement,
        loadNewsData: loadNewsData,
        saveNewsData: saveNewsData,
        normalizeNewsRecord: normalizeNewsRecord,
        mergeIncomingNewsData: mergeIncomingNewsData,
        updateNewsStats: updateNewsStats,
        renderNewsList: renderNewsList,
        setNewsStatFilter: setNewsStatFilter,
        onNewsStatusFilterChange: onNewsStatusFilterChange,
        onNewsSearchInput: onNewsSearchInput,
        onNewsFilterChange: onNewsFilterChange,
        toggleNewsAdvancedFilter: toggleNewsAdvancedFilter,
        showAddNewsModal: showAddNewsModal,
        showEditNewsModal: showEditNewsModal,
        showNewsModal: showNewsModal,
        closeNewsModal: closeNewsModal,
        setNewsPublishMode: setNewsPublishMode,
        markNewsModalDirty: markNewsModalDirty,
        commitNewsModal: commitNewsModal,
        handleCoverUpload: handleCoverUpload,
        clearCoverImage: clearCoverImage,
        handleNewsAttachUpload: handleNewsAttachUpload,
        removeNewsAttach: removeNewsAttach,
        showNewsTemplateLibrary: showNewsTemplateLibrary,
        applyNewsTemplate: applyNewsTemplate,
        oneClickNewsFormat: oneClickNewsFormat,
        clearNewsEditorFormat: clearNewsEditorFormat,
        ensureNewsEditorReady: ensureNewsEditorReady,
        focusNewsEditor: focusNewsEditor,
        showMobileNewsPreview: showMobileNewsPreview,
        publishNews: publishNews,
        unpublishNews: unpublishNews,
        submitNewsForReview: submitNewsForReview,
        reviewNews: reviewNews,
        toggleNewsPin: toggleNewsPin,
        deleteNews: deleteNews,
        copyNewsLink: copyNewsLink,
        toggleNewsFavorite: toggleNewsFavorite,
        toggleNewsSelect: toggleNewsSelect,
        toggleSelectAllNews: toggleSelectAllNews,
        batchNewsAction: batchNewsAction,
        newsPageNav: newsPageNav,
        showNewsDetail: showNewsDetail,
        showNewsStats: showNewsStats,
        likeNews: likeNews,
        postNewsComment: postNewsComment,
        shareNewsToWeekly: shareNewsToWeekly,
        renderHomeNewsPanel: renderHomeNewsPanel,
        aiPolishNews: aiPolishNews,
        aiGenerateNewsDraft: aiGenerateNewsDraft,
        createNewsDraftFromSource: createNewsDraftFromSource,
        offerNewsDraftFromMeeting: offerNewsDraftFromMeeting,
        offerNewsDraftFromAchievement: offerNewsDraftFromAchievement,
        offerNewsDraftFromPaper: offerNewsDraftFromPaper,
        offerNewsDraftFromCompetition: offerNewsDraftFromCompetition,
        offerNewsDraftFromProject: offerNewsDraftFromProject,
        canManageNews: canManageNews,
        canPublishNews: canPublishNews,
        canReviewNews: canReviewNews
    };

    Object.keys(api).forEach(function (k) {
        try { global[k] = api[k]; } catch (e) {}
    });
    global.NewsManagement = api;
    try {
        Object.defineProperty(api, 'newsData', {
            configurable: true,
            enumerable: true,
            get: function () { return newsData; },
            set: function (v) { newsData = Array.isArray(v) ? v.map(normalizeNewsRecord) : []; }
        });
    } catch (eApi) {}
    global.mergeIncomingNewsData = mergeIncomingNewsData;

    try {
        Object.defineProperty(global, 'newsData', {
            configurable: true,
            enumerable: true,
            get: function () { return newsData; },
            set: function (v) {
                newsData = Array.isArray(v) ? v.map(normalizeNewsRecord) : [];
            }
        });
    } catch (eProp) {
        global.newsData = newsData;
    }

    injectNewsStyles();
    try { loadNewsData(); } catch (e) {}
    try { ensureNewsScheduleTimer(); } catch (e) {}
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { try { renderHomeNewsPanel(); } catch (e) {} });
    } else {
        try { renderHomeNewsPanel(); } catch (e) {}
    }

    // hash 直达 #news/123
    try {
        var hash = location.hash || '';
        var m = hash.match(/^#news\/(\d+)/);
        if (m) setTimeout(function () { showNewsDetail(Number(m[1])); }, 800);
    } catch (e) {}

})(typeof window !== 'undefined' ? window : this);
