/**
 * 文献资料库 — 科研检索库 + 全系统联动
 * 数据：localStorage literatureData + cloudUpsert
 * 联动：文献对比 / 文档解析 / 周报 / 共享文件库 / 项目管理
 */
(function (global) {
    'use strict';

    var LITERATURE_PAGE_SIZE = 20;
    var LIT_TYPE_OPTIONS = [
        { key: 'journal', label: '期刊论文' },
        { key: 'conference', label: '会议论文' },
        { key: 'thesis', label: '学位论文' },
        { key: 'review', label: '综述' },
        { key: 'report', label: '技术报告' },
        { key: 'other', label: '其他' }
    ];
    var LIT_TAG_PRESETS = ['城市安全', '目标检测', '语义分割', '深度学习', '灾害预警', '结构监测', '综述', 'AI'];
    var LIT_CUSTOM_TAGS_KEY = 'literatureCustomTags';
    var LIT_GROUPS_KEY = 'literatureCustomGroups';
    var litTagAddOpen = false;

    var litState = {
        page: 1,
        statFilter: '',
        typeFilter: '',
        tagFilter: '',
        yearFrom: '',
        yearTo: '',
        sort: 'year_desc',
        selected: {},
        favorites: {},
        view: 'list',
        groupFilter: '',
        authorFilter: '',
        hasPdf: '',
        readFilter: '',
        showAdv: false
    };
    /** 添加弹窗待入库的 PDF 文件 */
    var pendingLitPdfFile = null;
    /** BibTeX 解析预览条目 */
    var pendingBibPreview = [];
    /** DOI 查询缓存（7 天） */
    var DOI_CACHE_KEY = 'literatureDoiCache_v1';
    var DOI_HISTORY_KEY = 'literatureDoiHistory_v1';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function currentOwner() {
        var u = global.currentUser;
        return (u && (u.realName || u.username)) || '未知';
    }

    function currentUserKey() {
        var u = global.currentUser;
        if (!u) return 'anon';
        return String(u.id != null ? u.id : (u.studentId || u.username || 'anon'));
    }

    function canManageLibrary() {
        var u = global.currentUser;
        return !!(u && (u.role === 'admin' || u.role === 'leader'));
    }

    function canEditLibraryItem(item) {
        if (!item) return false;
        if (canManageLibrary()) return true;
        var u = global.currentUser;
        if (!u || u.role === 'visitor') return false;
        return String(item.uploader || '') === currentOwner();
    }

    function canDownloadPdf() {
        var u = global.currentUser;
        return !!(u && u.role !== 'visitor');
    }

    function parseTags(raw) {
        if (Array.isArray(raw)) return raw.map(function (t) { return String(t || '').trim(); }).filter(Boolean);
        return String(raw || '').split(/[,，;；、|]/).map(function (t) { return t.trim(); }).filter(Boolean);
    }

    function normalizeLiteratureRecord(raw) {
        var r = raw || {};
        var tags = parseTags(r.tags || r.keywords);
        var year = String(r.year || '').replace(/[^\d]/g, '').slice(0, 4);
        var litType = String(r.litType || r.type || 'journal');
        if (!LIT_TYPE_OPTIONS.some(function (o) { return o.key === litType; })) litType = 'other';
        return {
            id: Number(r.id) || 0,
            title: String(r.title || '').trim(),
            author: String(r.author || r.authors || '').trim(),
            journal: String(r.journal || r.venue || '').trim(),
            year: year,
            tags: tags.join(', '),
            tagList: tags,
            uploader: String(r.uploader || '').trim() || currentOwner(),
            uploadTime: String(r.uploadTime || r.createdAt || new Date().toLocaleDateString('zh-CN')),
            doi: String(r.doi || '').trim(),
            summary: String(r.summary || r.abstract || r.description || '').trim(),
            citations: Number(r.citations || r.citationCount || 0) || 0,
            litType: litType,
            paperUrl: String(r.paperUrl || r.url || '').trim(),
            pdfUrl: String(r.pdfUrl || r.pdf || '').trim(),
            pdfName: String(r.pdfName || '').trim(),
            sharedFileId: r.sharedFileId != null ? Number(r.sharedFileId) : null,
            projectIds: Array.isArray(r.projectIds) ? r.projectIds.map(Number).filter(Boolean) : [],
            projectNames: Array.isArray(r.projectNames) ? r.projectNames : [],
            favorites: Array.isArray(r.favorites) ? r.favorites.map(String) : [],
            groupIds: Array.isArray(r.groupIds) ? r.groupIds.map(String) : [],
            readStatus: r.readStatus || 'unread',
            notes: String(r.notes || '').trim(),
            isCore: !!(r.isCore || /SCI|CCF\s*[AB]|一区|Top/i.test(String(r.journal || '') + ' ' + tags.join(' '))),
            downloadCount: Number(r.downloadCount || 0) || 0,
            source: String(r.source || 'manual'),
            compareId: r.compareId != null ? Number(r.compareId) : null
        };
    }

    function getLiteratureData() {
        return Array.isArray(global.literatureData) ? global.literatureData : [];
    }

    function setLiteratureData(list) {
        global.literatureData = (Array.isArray(list) ? list : []).map(normalizeLiteratureRecord);
        try {
            if (typeof literatureData !== 'undefined') {
                // sync sibling let if same realm — no-op when only window exists
            }
        } catch (e) {}
    }

    function saveLiteratureLibraryData(options) {
        options = options || {};
        var list = getLiteratureData().map(normalizeLiteratureRecord);
        global.literatureData = list;
        try { localStorage.setItem('literatureData', JSON.stringify(list)); } catch (e) {}
        try {
            if (typeof global.cloudUpsert === 'function') {
                global.cloudUpsert('literatureData', JSON.stringify(list));
            }
        } catch (e2) {}
        try {
            if (options.log && typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('文献资料库', options.log.action || '更新', options.log.desc || '更新文献', options.log.detail || {}, { success: true }, 1, '', 0);
            }
        } catch (e3) {}
        exposeLiteratureGlobals();
        try {
            if (typeof global.syncGlobalsForExternalModules === 'function') {
                global.syncGlobalsForExternalModules();
            }
        } catch (e4) {}
    }

    function loadLiteratureFavorites() {
        try {
            var raw = localStorage.getItem('literatureFavorites_' + currentUserKey());
            litState.favorites = raw ? JSON.parse(raw) : {};
        } catch (e) {
            litState.favorites = {};
        }
    }

    function saveLiteratureFavorites() {
        try {
            localStorage.setItem('literatureFavorites_' + currentUserKey(), JSON.stringify(litState.favorites || {}));
        } catch (e) {}
    }

    function isFavorite(id) {
        return !!(litState.favorites && litState.favorites[String(id)]);
    }

    function loadLiteratureLibraryData() {
        loadLiteratureFavorites();
        var list = [];
        try {
            var stored = localStorage.getItem('literatureData');
            if (stored) list = JSON.parse(stored);
        } catch (e) { list = []; }
        if (!Array.isArray(list) || !list.length) {
            list = [
                { id: 1, title: 'Urban Safety Intelligence: A Comprehensive Review', author: 'Zhang, L.', journal: 'IEEE Transactions', year: '2026', tags: '城市安全, 综述', uploader: '张三', uploadTime: '2026-07-12', litType: 'review', citations: 128, isCore: true, doi: '10.1109/example.2026.001' },
                { id: 2, title: '深度学习在城市安全监控中的应用', author: 'Li, W.', journal: '计算机学报', year: '2026', tags: '深度学习, 监控', uploader: '李四', uploadTime: '2026-07-11', litType: 'journal', citations: 56 },
                { id: 3, title: '基于AI的城市灾害预警系统研究', author: 'Wang, Q.', journal: '安全与环境学报', year: '2025', tags: 'AI, 灾害预警', uploader: '王五', uploadTime: '2026-07-10', litType: 'journal', citations: 42 }
            ];
        }
        global.literatureData = list.map(normalizeLiteratureRecord);
        try { localStorage.setItem('literatureData', JSON.stringify(global.literatureData)); } catch (e2) {}
        exposeLiteratureGlobals();
        return global.literatureData;
    }

    function mergeIncomingLiteratureData(incoming) {
        var localMap = {};
        getLiteratureData().forEach(function (l) { localMap[l.id] = l; });
        var remote = (Array.isArray(incoming) ? incoming : []).map(normalizeLiteratureRecord);
        var remoteIds = {};
        var merged = remote.map(function (n) {
            remoteIds[n.id] = true;
            var prev = localMap[n.id];
            if (!prev) return n;
            return normalizeLiteratureRecord(Object.assign({}, prev, n, {
                favorites: (n.favorites && n.favorites.length) ? n.favorites : prev.favorites,
                notes: n.notes || prev.notes,
                downloadCount: Math.max(Number(n.downloadCount || 0), Number(prev.downloadCount || 0))
            }));
        });
        Object.keys(localMap).forEach(function (id) {
            if (!remoteIds[id]) merged.push(localMap[id]);
        });
        return merged;
    }
    global.mergeIncomingLiteratureData = mergeIncomingLiteratureData;

    function litTypeLabel(key) {
        var hit = LIT_TYPE_OPTIONS.find(function (o) { return o.key === key; });
        return hit ? hit.label : '其他';
    }

    function loadCustomLitTags() {
        try {
            var arr = JSON.parse(localStorage.getItem(LIT_CUSTOM_TAGS_KEY) || '[]');
            if (!Array.isArray(arr)) return [];
            return arr.map(function (t) { return String(t || '').trim(); }).filter(Boolean);
        } catch (e) {
            return [];
        }
    }

    function saveCustomLitTags(tags) {
        var clean = (tags || []).map(function (t) { return String(t || '').trim(); }).filter(Boolean);
        var seen = {};
        clean = clean.filter(function (t) {
            if (seen[t]) return false;
            seen[t] = true;
            return true;
        });
        localStorage.setItem(LIT_CUSTOM_TAGS_KEY, JSON.stringify(clean));
    }

    function getAllTags() {
        var map = {};
        var order = [];
        function add(t) {
            t = String(t || '').trim();
            if (!t || map[t]) return;
            map[t] = true;
            order.push(t);
        }
        LIT_TAG_PRESETS.forEach(add);
        loadCustomLitTags().forEach(add);
        getLiteratureData().forEach(function (l) {
            (l.tagList || parseTags(l.tags)).forEach(add);
        });
        return order;
    }

    function getFilterBarTags() {
        var custom = loadCustomLitTags();
        var seen = {};
        var out = [];
        function push(t) {
            t = String(t || '').trim();
            if (!t || seen[t]) return;
            seen[t] = true;
            out.push(t);
        }
        LIT_TAG_PRESETS.forEach(push);
        custom.forEach(push);
        getAllTags().forEach(push);
        return out.slice(0, 24);
    }

    function notifyTagsChanged() {
        if (typeof global.renderLiteratureCompareList === 'function') {
            try { global.renderLiteratureCompareList(); } catch (e) { /* ignore */ }
        }
    }

    function addCustomLitTag(name) {
        name = String(name || '').trim();
        if (!name) {
            alert('请输入标签名称');
            return '';
        }
        if (name.length > 30) {
            alert('标签名不超过 30 字');
            return '';
        }
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客不可添加标签');
            return '';
        }
        if (getAllTags().indexOf(name) >= 0) return name;
        var custom = loadCustomLitTags();
        custom.push(name);
        saveCustomLitTags(custom);
        notifyTagsChanged();
        return name;
    }

    function appendLitTagToInput(inputId, tag) {
        tag = String(tag || '').trim();
        if (!tag) return;
        var el = document.getElementById(inputId);
        if (!el) return;
        var cur = parseTags(el.value);
        if (cur.indexOf(tag) >= 0) return;
        cur.push(tag);
        el.value = cur.join(', ');
    }

    function promptAddLitTagToInput(inputId) {
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客不可添加标签');
            return;
        }
        var name = prompt('输入新标签名称（将同步到筛选栏与标签库）：');
        if (!name) return;
        var tag = addCustomLitTag(name);
        if (!tag) return;
        appendLitTagToInput(inputId, tag);
        refreshOpenModalTagFields();
    }

    function refreshOpenModalTagFields() {
        var tags = getAllTags();
        document.querySelectorAll('.lit-tags-field[data-tags-input]').forEach(function (wrap) {
            var inputId = wrap.getAttribute('data-tags-input');
            var datalistId = inputId + '_datalist';
            var list = document.getElementById(datalistId);
            if (list) {
                list.innerHTML = tags.map(function (t) {
                    return '<option value="' + esc(t) + '"></option>';
                }).join('');
            }
            var quick = wrap.querySelector('.lit-tag-quick');
            if (quick) {
                var chips = tags.slice(0, 20).map(function (t) {
                    return '<button type="button" class="lit-tag-quick-chip" onclick="appendLitTagToInput(' + JSON.stringify(inputId) + ',' + JSON.stringify(t) + ')">' + esc(t) + '</button>';
                }).join('');
                quick.innerHTML = '<span style="font-size:11px;color:#9ca3af;margin-right:4px;line-height:22px;">快捷：</span>' + chips +
                    '<button type="button" class="lit-tag-quick-chip lit-tag-quick-add" onclick="promptAddLitTagToInput(' + JSON.stringify(inputId) + ')">+ 新建</button>';
            }
        });
    }

    function toggleLitTagAddPanel(force) {
        var panel = document.getElementById('litTagAddPanel');
        var input = document.getElementById('litTagAddInput');
        if (!panel) return;
        litTagAddOpen = typeof force === 'boolean' ? force : !litTagAddOpen;
        panel.style.display = litTagAddOpen ? 'inline-flex' : 'none';
        if (litTagAddOpen && input) input.focus();
        else if (input) input.value = '';
    }

    function confirmAddLitTag() {
        var input = document.getElementById('litTagAddInput');
        var tag = addCustomLitTag(input ? input.value : '');
        if (!tag) return;
        toggleLitTagAddPanel(false);
        litState.tagFilter = tag;
        litState.page = 1;
        renderLiteratureList();
    }

    function loadLiteratureGroups() {
        try {
            var raw = JSON.parse(localStorage.getItem(LIT_GROUPS_KEY) || '[]');
            return Array.isArray(raw) ? raw.filter(function (g) { return g && g.id && g.name; }) : [];
        } catch (e) { return []; }
    }

    function saveLiteratureGroups(list) {
        try { localStorage.setItem(LIT_GROUPS_KEY, JSON.stringify(list || [])); } catch (e) {}
    }

    function createLiteratureGroup(name) {
        name = String(name || '').trim();
        if (!name) return null;
        var list = loadLiteratureGroups();
        if (list.some(function (g) { return g.name === name; })) {
            alert('分组已存在');
            return null;
        }
        var g = { id: 'g_' + Date.now(), name: name };
        list.push(g);
        saveLiteratureGroups(list);
        return g;
    }

    function promptCreateLiteratureGroup() {
        var name = prompt('新建分组名称（如：开题参考文献组）');
        if (!name) return;
        var g = createLiteratureGroup(name);
        if (g) {
            litState.groupFilter = g.id;
            renderLiteratureList();
        }
    }

    function setLitGroupFilter(gid) {
        litState.groupFilter = (litState.groupFilter === gid) ? '' : (gid || '');
        litState.page = 1;
        renderLiteratureList();
    }

    function renderLitGroupBar() {
        var box = document.getElementById('litGroupFilterBar');
        if (!box) return;
        var groups = loadLiteratureGroups();
        var html = '<button type="button" class="lit-tag-chip' + (!litState.groupFilter ? ' active' : '') + '" onclick="setLitGroupFilter(\'\')">全部分组</button>';
        html += groups.map(function (g) {
            return '<button type="button" class="lit-tag-chip' + (litState.groupFilter === g.id ? ' active' : '') + '" onclick="setLitGroupFilter(' + JSON.stringify(g.id) + ')">' + esc(g.name) + '</button>';
        }).join('');
        html += '<button type="button" class="lit-tag-chip lit-tag-add" onclick="promptCreateLiteratureGroup()">+ 新建分组</button>';
        box.innerHTML = html;
    }

    function toggleLitAdvFilter() {
        litState.showAdv = !litState.showAdv;
        var panel = document.getElementById('litAdvFilterPanel');
        if (panel) panel.style.display = litState.showAdv ? 'flex' : 'none';
        var btn = document.getElementById('litAdvFilterBtn');
        if (btn) btn.textContent = litState.showAdv ? '收起高级筛选' : '高级筛选';
    }

    function onLitAdvFilterChange() {
        litState.authorFilter = String((document.getElementById('litLibAuthorFilter') || {}).value || '').trim();
        litState.hasPdf = String((document.getElementById('litLibHasPdf') || {}).value || '');
        litState.readFilter = String((document.getElementById('litLibReadFilter') || {}).value || '');
        litState.page = 1;
        renderLiteratureList();
    }

    function getFilteredLiterature() {
        var q = String((document.getElementById('literatureSearchInput') || {}).value || '').trim().toLowerCase();
        var list = getLiteratureData().slice();
        var yearNow = new Date().getFullYear();

        if (litState.statFilter === 'year') {
            list = list.filter(function (l) { return Number(l.year) === yearNow || String(l.uploadTime || '').indexOf(String(yearNow)) === 0; });
        } else if (litState.statFilter === 'core') {
            list = list.filter(function (l) { return l.isCore; });
        } else if (litState.statFilter === 'fav') {
            list = list.filter(function (l) { return isFavorite(l.id); });
        }

        if (litState.typeFilter) list = list.filter(function (l) { return l.litType === litState.typeFilter; });
        if (litState.tagFilter) {
            list = list.filter(function (l) {
                return (l.tagList || parseTags(l.tags)).indexOf(litState.tagFilter) >= 0;
            });
        }
        if (litState.groupFilter) {
            list = list.filter(function (l) {
                return (l.groupIds || []).indexOf(String(litState.groupFilter)) >= 0;
            });
        }
        if (litState.yearFrom) list = list.filter(function (l) { return !l.year || Number(l.year) >= Number(litState.yearFrom); });
        if (litState.yearTo) list = list.filter(function (l) { return !l.year || Number(l.year) <= Number(litState.yearTo); });
        if (litState.authorFilter) {
            var af = litState.authorFilter.toLowerCase();
            list = list.filter(function (l) { return String(l.author || '').toLowerCase().indexOf(af) >= 0 || String(l.journal || '').toLowerCase().indexOf(af) >= 0; });
        }
        if (litState.hasPdf === '1') list = list.filter(function (l) { return !!(l.pdfUrl || l.sharedFileId); });
        if (litState.hasPdf === '0') list = list.filter(function (l) { return !(l.pdfUrl || l.sharedFileId); });
        if (litState.readFilter) list = list.filter(function (l) { return (l.readStatus || 'unread') === litState.readFilter; });

        if (q) {
            list = list.filter(function (l) {
                var blob = [l.title, l.author, l.journal, l.tags, l.doi, l.summary].join(' ').toLowerCase();
                return blob.indexOf(q) >= 0;
            });
        }

        list.sort(function (a, b) {
            if (litState.sort === 'cite_desc') return (b.citations || 0) - (a.citations || 0);
            if (litState.sort === 'upload_desc') return String(b.uploadTime).localeCompare(String(a.uploadTime));
            if (litState.sort === 'dl_desc') return (b.downloadCount || 0) - (a.downloadCount || 0);
            return (Number(b.year) || 0) - (Number(a.year) || 0) || String(b.uploadTime).localeCompare(String(a.uploadTime));
        });
        return list;
    }

    function updateLiteratureStats() {
        var all = getLiteratureData();
        var yearNow = new Date().getFullYear();
        var el = function (id, v) { var n = document.getElementById(id); if (n) n.textContent = String(v); };
        el('litStatTotal', all.length);
        el('litStatYear', all.filter(function (l) { return Number(l.year) === yearNow || String(l.uploadTime || '').indexOf(String(yearNow)) === 0; }).length);
        el('litStatCore', all.filter(function (l) { return l.isCore; }).length);
        el('litStatFav', all.filter(function (l) { return isFavorite(l.id); }).length);
        document.querySelectorAll('.lit-stat-card').forEach(function (card) {
            card.classList.toggle('active', (card.getAttribute('data-filter') || '') === (litState.statFilter || ''));
        });
    }

    function setLitStatFilter(filter) {
        litState.statFilter = (litState.statFilter === filter) ? '' : (filter || '');
        litState.page = 1;
        renderLiteratureList();
    }

    function setLitTypeFilter(v) {
        litState.typeFilter = v || '';
        litState.page = 1;
        renderLiteratureList();
    }

    function setLitTagFilter(tag) {
        // 「全部」或空字符串：清空标签筛选
        if (!tag || tag === '__all__') {
            litState.tagFilter = '';
        } else {
            litState.tagFilter = (litState.tagFilter === tag) ? '' : tag;
        }
        litState.page = 1;
        renderLiteratureList();
    }

    function onLitLibraryFilterChange() {
        litState.yearFrom = (document.getElementById('litLibYearFrom') || {}).value || '';
        litState.yearTo = (document.getElementById('litLibYearTo') || {}).value || '';
        litState.sort = (document.getElementById('litLibSort') || {}).value || 'year_desc';
        litState.page = 1;
        renderLiteratureList();
    }

    function toggleLitSelect(id, checked) {
        if (checked) litState.selected[String(id)] = true;
        else delete litState.selected[String(id)];
        updateLitBatchBar();
    }

    function toggleSelectAllLit(checked) {
        getFilteredLiterature().forEach(function (l) {
            if (checked) litState.selected[String(l.id)] = true;
            else delete litState.selected[String(l.id)];
        });
        renderLiteratureList();
    }

    function getSelectedLitIds() {
        return Object.keys(litState.selected).map(Number).filter(Boolean);
    }

    function updateLitBatchBar() {
        var bar = document.getElementById('litBatchBar');
        var countEl = document.getElementById('litBatchCount');
        var n = getSelectedLitIds().length;
        if (bar) bar.style.display = n ? 'flex' : 'none';
        if (countEl) countEl.textContent = String(n);
    }

    function toggleLiteratureFavorite(id) {
        var key = String(id);
        if (litState.favorites[key]) delete litState.favorites[key];
        else litState.favorites[key] = true;
        saveLiteratureFavorites();
        renderLiteratureList();
    }

    function renderLitTagBar() {
        var box = document.getElementById('litTagFilterBar');
        if (!box) return;
        var tags = getFilterBarTags();
        var allActive = !litState.tagFilter;
        var html = '<button type="button" class="lit-tag-chip' + (allActive ? ' active' : '') + '" onclick="setLitTagFilter(\'__all__\')">全部</button>';
        html += tags.map(function (t) {
            var active = litState.tagFilter === t;
            return '<button type="button" class="lit-tag-chip' + (active ? ' active' : '') + '" onclick="setLitTagFilter(' + JSON.stringify(t) + ')">' + esc(t) + '</button>';
        }).join('');
        html += '<button type="button" class="lit-tag-chip lit-tag-add" onclick="toggleLitTagAddPanel()">+ 添加</button>';
        html += '<span id="litTagAddPanel" class="lit-tag-add-panel" style="display:' + (litTagAddOpen ? 'inline-flex' : 'none') + ';">' +
            '<input id="litTagAddInput" type="text" placeholder="新标签名" onkeydown="if(event.key===\'Enter\'){event.preventDefault();confirmAddLitTag();}">' +
            '<button type="button" class="lit-tag-add-ok" onclick="confirmAddLitTag()">确定</button>' +
            '<button type="button" class="lit-tag-add-cancel" onclick="toggleLitTagAddPanel(false)">×</button></span>';
        box.innerHTML = html;
        if (litTagAddOpen) {
            var inp = document.getElementById('litTagAddInput');
            if (inp) inp.focus();
        }
    }

    function renderLiteratureList() {
        var container = document.getElementById('literatureList');
        var emptyState = document.getElementById('literatureEmptyState');
        if (!container || !emptyState) return;

        updateLiteratureStats();
        renderLitTagBar();
        renderLitGroupBar();

        var filtered = getFilteredLiterature();
        var totalPages = Math.max(1, Math.ceil(filtered.length / LITERATURE_PAGE_SIZE));
        if (litState.page > totalPages) litState.page = totalPages;
        var start = (litState.page - 1) * LITERATURE_PAGE_SIZE;
        var pageItems = filtered.slice(start, start + LITERATURE_PAGE_SIZE);

        if (!filtered.length) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            updateLitBatchBar();
            return;
        }
        emptyState.style.display = 'none';

        var html = pageItems.map(function (l) {
            var fav = isFavorite(l.id);
            var checked = !!litState.selected[String(l.id)];
            var tags = (l.tagList || parseTags(l.tags)).map(function (t) {
                return '<span class="lit-mini-tag">' + esc(t) + '</span>';
            }).join('');
            var pdfBadge = (l.pdfUrl || l.sharedFileId) ? '<span class="lit-pdf-badge">📄 有PDF</span>' : '';
            var coreBadge = l.isCore ? '<span class="lit-core-badge">核心</span>' : '';
            var readMap = { unread: '未读', reading: '在读', read: '已读' };
            var readBadge = '<span class="lit-read-badge lit-read-' + esc(l.readStatus || 'unread') + '">' + (readMap[l.readStatus] || '未读') + '</span>';
            return (
                '<div class="lit-card' + (checked ? ' selected' : '') + '">' +
                '<div class="lit-card-main">' +
                '<label class="lit-check"><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleLitSelect(' + l.id + ', this.checked)"></label>' +
                '<button type="button" class="lit-fav-btn' + (fav ? ' on' : '') + '" title="收藏" onclick="toggleLiteratureFavorite(' + l.id + ')">' + (fav ? '★' : '☆') + '</button>' +
                '<div class="lit-card-body">' +
                '<div class="lit-title-row">' +
                '<a href="javascript:void(0)" class="lit-title" onclick="showLibraryLiteratureDetail(' + l.id + ')" title="' + esc(l.title) + '">' + esc(l.title) + '</a>' +
                coreBadge + pdfBadge + readBadge +
                '</div>' +
                '<div class="lit-meta">' + esc(l.author || '未知作者') + ' · ' + esc(l.journal || '未填期刊') + ' · ' + esc(l.year || '—') +
                (l.citations ? (' · 引用 ' + l.citations) : '') +
                ' · ' + esc(litTypeLabel(l.litType)) +
                '</div>' +
                '<div class="lit-tags">' + tags + '</div>' +
                '<div class="lit-foot">上传者：' + esc(l.uploader) + ' | ' + esc(l.uploadTime) +
                (l.downloadCount ? (' | 下载 ' + l.downloadCount) : '') +
                (l.doi ? (' | DOI ' + esc(l.doi)) : '') +
                '</div>' +
                '</div></div>' +
                '<div class="lit-actions">' +
                '<button type="button" class="btn btn-secondary lit-act" onclick="showLibraryLiteratureDetail(' + l.id + ')">查看</button>' +
                (canDownloadPdf() && (l.pdfUrl || l.paperUrl || l.sharedFileId)
                    ? '<button type="button" class="btn lit-act" onclick="downloadLibraryLiterature(' + l.id + ')">下载</button>'
                    : '') +
                '<button type="button" class="btn lit-act" style="background:#0d9488;" onclick="addLibraryLitToCompare(' + l.id + ')">加入对比</button>' +
                '<button type="button" class="btn btn-secondary lit-act" onclick="insertLibraryLitToWeekly(' + l.id + ')">加周报</button>' +
                (canEditLibraryItem(l)
                    ? '<button type="button" class="lit-act danger" onclick="deleteLibraryLiterature(' + l.id + ')">删除</button>'
                    : '') +
                '</div></div>'
            );
        }).join('');

        html += '<div class="lit-pager">';
        if (litState.page > 1) html += '<button type="button" onclick="setLiteraturePage(' + (litState.page - 1) + ')">上一页</button>';
        html += '<span>第 ' + litState.page + ' / ' + totalPages + ' 页 · 共 ' + filtered.length + ' 篇</span>';
        if (litState.page < totalPages) html += '<button type="button" onclick="setLiteraturePage(' + (litState.page + 1) + ')">下一页</button>';
        html += '</div>';

        container.innerHTML = html;
        updateLitBatchBar();
    }

    function setLiteraturePage(p) {
        litState.page = p;
        renderLiteratureList();
    }

    function injectLiteratureLibraryStyles() {
        if (document.getElementById('literatureLibraryStyles')) return;
        var style = document.createElement('style');
        style.id = 'literatureLibraryStyles';
        style.textContent = [
            '.lit-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px;}',
            '.lit-stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;cursor:pointer;transition:.15s;}',
            '.lit-stat-card:hover,.lit-stat-card.active{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.12);}',
            '.lit-stat-card .n{font-size:22px;font-weight:700;color:#111827;}',
            '.lit-stat-card .l{font-size:12px;color:#6b7280;margin-top:4px;}',
            '.lit-filter-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;}',
            '.lit-filter-row select,.lit-filter-row input{padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;}',
            '.lit-tag-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}',
            '.lit-tag-chip{padding:4px 10px;border:1px solid #e5e7eb;background:#fff;border-radius:999px;font-size:12px;color:#4b5563;cursor:pointer;}',
            '.lit-tag-chip.active{background:#ede9fe;border-color:#7c3aed;color:#5b21b6;}',
            '.lit-tag-chip.lit-tag-add{border-style:dashed;color:#7c3aed;border-color:#c4b5fd;background:#faf8ff;}',
            '.lit-tag-add-panel{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;background:#faf8ff;border:1px dashed #c4b5fd;border-radius:999px;}',
            '.lit-tag-add-panel input{width:100px;padding:4px 8px;border:1px solid #ddd;border-radius:999px;font-size:12px;outline:none;}',
            '.lit-tag-add-panel input:focus{border-color:#7c3aed;}',
            '.lit-tag-add-ok,.lit-tag-add-cancel{border:none;background:#7c3aed;color:#fff;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;}',
            '.lit-tag-add-cancel{background:#f3f4f6;color:#6b7280;padding:4px 8px;}',
            '.lit-tag-quick-chip{padding:2px 8px;border:1px solid #e5e7eb;background:#f9fafb;border-radius:999px;font-size:11px;color:#4b5563;cursor:pointer;}',
            '.lit-tag-quick-chip:hover{border-color:#7c3aed;color:#5b21b6;background:#faf8ff;}',
            '.lit-tag-quick-chip.lit-tag-quick-add{border-style:dashed;color:#7c3aed;}',
            '.lit-batch-bar{display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;margin-bottom:12px;}',
            '.lit-card{background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);border:1px solid #f0f0f0;}',
            '.lit-card.selected{border-color:#a78bfa;background:#faf8ff;}',
            '.lit-card-main{display:flex;gap:10px;align-items:flex-start;}',
            '.lit-check{margin-top:4px;}',
            '.lit-fav-btn{border:none;background:transparent;font-size:18px;cursor:pointer;color:#d1d5db;padding:0 2px;}',
            '.lit-fav-btn.on{color:#f59e0b;}',
            '.lit-card-body{flex:1;min-width:0;}',
            '.lit-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
            '.lit-title{font-size:16px;font-weight:700;color:#111827;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}',
            '.lit-title:hover{color:#7c3aed;}',
            '.lit-meta{font-size:13px;color:#6b7280;margin-top:6px;}',
            '.lit-tags{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;}',
            '.lit-mini-tag{padding:2px 8px;background:#f0f5ff;color:#1890ff;border-radius:4px;font-size:12px;}',
            '.lit-pdf-badge{font-size:11px;color:#0d9488;background:#ccfbf1;padding:2px 6px;border-radius:4px;}',
            '.lit-core-badge{font-size:11px;color:#b45309;background:#fef3c7;padding:2px 6px;border-radius:4px;}',
            '.lit-read-badge{font-size:11px;padding:2px 6px;border-radius:4px;margin-left:4px;}',
            '.lit-read-unread{color:#64748b;background:#f1f5f9;}',
            '.lit-read-reading{color:#4338ca;background:#e0e7ff;}',
            '.lit-read-read{color:#15803d;background:#dcfce7;}',
            '.lit-adv-panel{display:none;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;padding:10px;background:#f8fafc;border-radius:8px;border:1px dashed #e2e8f0;}',
            '.lit-pdf-frame{width:100%;height:420px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;}',
            '.lit-foot{font-size:12px;color:#9ca3af;margin-top:8px;}',
            '.lit-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;justify-content:flex-end;}',
            '.lit-act{padding:4px 10px !important;font-size:12px !important;}',
            '.lit-act.danger{padding:4px 10px;border:none;background:#fff1f0;color:#ff4d4f;border-radius:4px;cursor:pointer;font-size:12px;}',
            '.lit-pager{display:flex;justify-content:center;align-items:center;gap:12px;padding:12px;color:#666;font-size:13px;}',
            '.lit-pager button{padding:4px 12px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;}',
            '.lit-link-bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}',
            '.lit-link-bar button{font-size:12px;padding:6px 12px;}',
            '.lit-modal-tabs{display:flex;gap:0;border-bottom:1px solid #eee;margin-bottom:16px;}',
            '.lit-modal-tab{flex:1;padding:10px;border:none;background:transparent;cursor:pointer;font-size:13px;color:#666;border-bottom:2px solid transparent;}',
            '.lit-modal-tab.active{color:#7c3aed;border-bottom-color:#7c3aed;font-weight:600;}',
            '.lit-pdf-drop{border:2px dashed #c4b5fd;border-radius:12px;padding:36px 20px;text-align:center;cursor:pointer;background:linear-gradient(180deg,#faf8ff,#fff);transition:.15s;}',
            '.lit-pdf-drop:hover,.lit-pdf-drop.drag{border-color:#7c3aed;background:#f5f3ff;}',
            '.lit-pdf-edit input,.lit-pdf-edit textarea,.lit-pdf-edit select{background:#fff;}',
            '.lit-bib-mode.active{border-color:#7c3aed !important;color:#5b21b6 !important;background:#f5f3ff !important;}',
            '.lit-detail-wrap{display:grid;grid-template-columns:1fr;gap:16px;}',
            '@media(min-width:900px){.lit-detail-wrap{grid-template-columns:1.1fr .9fr;}}',
            '@media(max-width:768px){.lit-stat-grid{grid-template-columns:repeat(2,1fr);}}'
        ].join('');
        document.head.appendChild(style);
    }

    function initLiteratureLibrary() {
        injectLiteratureLibraryStyles();
        loadLiteratureLibraryData();
        exposeLiteratureGlobals();
        // 进入模块时静默把资料库同步到对比库（增量）
        try {
            if (typeof global.syncFromLiteratureLibrary === 'function') {
                global.syncFromLiteratureLibrary(true);
            }
        } catch (e) {}
        renderLiteratureList();
        var addBtn = document.getElementById('litLibraryAddBtn');
        if (addBtn) addBtn.style.display = (global.currentUser && global.currentUser.role === 'visitor') ? 'none' : '';
    }

    // ========== 添加弹窗（手动 / DOI / BibTeX） ==========
    function showLibraryLiteratureModal(tab) {
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客不可添加文献');
            return;
        }
        var modalId = 'litLibModal_' + Date.now();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2200;display:flex;justify-content:center;align-items:center;padding:16px;';
        var typeOpts = LIT_TYPE_OPTIONS.map(function (o) {
            return '<option value="' + o.key + '">' + o.label + '</option>';
        }).join('');
        var projectOpts = getProjectOptionsHtml();
        modal.innerHTML =
            '<div style="background:#fff;border-radius:12px;width:100%;max-width:680px;max-height:92vh;overflow:auto;">' +
            '<div style="padding:16px 20px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;">' +
            '<h3 style="margin:0;font-size:18px;">添加文献</h3>' +
            '<button type="button" onclick="closeLibraryLiteratureModal(\'' + modalId + '\')" style="width:32px;height:32px;border:none;background:#f5f5f5;border-radius:50%;cursor:pointer;">×</button>' +
            '</div>' +
            '<div style="padding:16px 20px;">' +
            '<div class="lit-modal-tabs">' +
            '<button type="button" class="lit-modal-tab active" data-tab="manual" onclick="switchLitLibModalTab(\'' + modalId + '\',\'manual\')">手动添加</button>' +
            '<button type="button" class="lit-modal-tab" data-tab="pdf" onclick="switchLitLibModalTab(\'' + modalId + '\',\'pdf\')">PDF 上传</button>' +
            '<button type="button" class="lit-modal-tab" data-tab="doi" onclick="switchLitLibModalTab(\'' + modalId + '\',\'doi\')">DOI 导入</button>' +
            '<button type="button" class="lit-modal-tab" data-tab="bib" onclick="switchLitLibModalTab(\'' + modalId + '\',\'bib\')">BibTeX 导入</button>' +
            '</div>' +
            '<div id="' + modalId + '_manual">' +
            fieldHtml('标题 *', 'libLitTitle', 'text', '请输入文献标题') +
            fieldHtml('作者', 'libLitAuthor', 'text', '多人用逗号分隔') +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            fieldHtml('期刊/会议', 'libLitJournal', 'text', '') +
            fieldHtml('发表年份', 'libLitYear', 'text', '如 2026') +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">文献类型</label>' +
            '<select id="libLitType" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' + typeOpts + '</select></div>' +
            fieldHtml('引用量', 'libLitCite', 'number', '0') +
            '</div>' +
            fieldHtml('DOI', 'libLitDoi', 'text', '10.xxxx/...') +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">摘要</label>' +
            '<textarea id="libLitSummary" rows="3" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;resize:vertical;"></textarea></div>' +
            tagsFieldHtml('关键词/标签', 'libLitTags', '城市安全, 深度学习') +
            fieldHtml('原文链接', 'libLitUrl', 'text', 'https://...') +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">关联项目（可选）</label>' +
            '<select id="libLitProject" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;"><option value="">不关联</option>' + projectOpts + '</select></div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px;">' +
            '<input type="checkbox" id="libLitCore"> 标记为核心文献</label>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px;">' +
            '<input type="checkbox" id="libLitSyncCompare" checked> 同时同步到文献对比分析</label>' +
            '</div>' +
            '<div id="' + modalId + '_pdf" style="display:none;">' +
            '<div id="libLitPdfDrop_' + modalId + '" class="lit-pdf-drop" onclick="document.getElementById(\'libLitPdfInput_' + modalId + '\').click()" ' +
            'ondragover="event.preventDefault();this.classList.add(\'drag\');" ondragleave="this.classList.remove(\'drag\');" ' +
            'ondrop="event.preventDefault();this.classList.remove(\'drag\');handleLibraryPdfDrop(event,\'' + modalId + '\')">' +
            '<div style="font-size:42px;margin-bottom:8px;">📕</div>' +
            '<div style="font-size:15px;font-weight:600;color:#333;margin-bottom:6px;">拖拽 PDF 到此处，或点击选择文件</div>' +
            '<div style="font-size:12px;color:#888;">仅支持 .pdf，单文件上限 50MB；上传后自动识别标题/作者/年份/DOI/摘要，识别结果可手改</div>' +
            '</div>' +
            '<input type="file" id="libLitPdfInput_' + modalId + '" accept=".pdf,application/pdf" style="display:none;" onchange="handleLibraryPdfFileSelect(this,\'' + modalId + '\')">' +
            '<div id="' + modalId + '_pdfStatus" style="margin-top:10px;font-size:13px;color:#888;min-height:20px;"></div>' +
            '<div id="' + modalId + '_pdfEdit" class="lit-pdf-edit" style="display:none;margin-top:12px;padding:14px;background:#faf8ff;border:1px solid #ede9fe;border-radius:10px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">' +
            '<strong style="font-size:14px;color:#5b21b6;">① 自动识别结果（可直接手改）</strong>' +
            '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="reRecognizeLibraryPdf(\'' + modalId + '\')">🔄 重新识别</button>' +
            '</div>' +
            fieldHtml('标题 *', 'libLitPdfTitle', 'text', '识别后可手改') +
            fieldHtml('作者', 'libLitPdfAuthor', 'text', '多人用逗号分隔，可手改') +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            fieldHtml('期刊/会议', 'libLitPdfJournal', 'text', '可手改') +
            fieldHtml('发表年份', 'libLitPdfYear', 'text', '如 2026') +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">文献类型</label>' +
            '<select id="libLitPdfType" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' + typeOpts + '</select></div>' +
            fieldHtml('DOI', 'libLitPdfDoi', 'text', '识别到可手改') +
            '</div>' +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">摘要（可手改）</label>' +
            '<textarea id="libLitPdfSummary" rows="4" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;resize:vertical;" placeholder="自动提取的摘要片段，可整段改写"></textarea></div>' +
            tagsFieldHtml('关键词/标签', 'libLitPdfTags', '城市安全, PDF') +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0 10px;">' +
            '<input type="checkbox" id="libLitPdfSync" checked> 同时同步到文献对比分析</label>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:4px;">' +
            '<input type="checkbox" id="libLitPdfToShared" checked> 同时存入团队共享文件库</label>' +
            '</div>' +
            '<div style="font-size:12px;color:#999;margin-top:8px;">流程：上传 PDF → 自动识别 → 手改字段 → 上传并入库</div>' +
            '</div>' +
            '<div id="' + modalId + '_doi" style="display:none;">' +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">DOI 号 / 链接</label>' +
            '<input type="text" id="libLitDoiInput" placeholder="粘贴 DOI 或 https://doi.org/... 链接" ' +
            'oninput="onLitDoiInputChange(\'' + modalId + '\')" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' +
            '<div id="' + modalId + '_doiHint" style="font-size:12px;color:#888;margin-top:4px;">支持纯 DOI、doi.org 链接；也可粘贴含 DOI 的文献页链接</div></div>' +
            '<div id="' + modalId + '_doiHistory" style="margin-bottom:10px;"></div>' +
            '<div id="' + modalId + '_doiPreview" style="display:none;margin:12px 0;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;"></div>' +
            '<div id="' + modalId + '_doiStatus" style="font-size:13px;color:#888;min-height:18px;margin-bottom:8px;"></div>' +
            '</div>' +
            '<div id="' + modalId + '_bib" style="display:none;">' +
            '<div style="display:flex;gap:8px;margin-bottom:12px;">' +
            '<button type="button" class="btn btn-secondary lit-bib-mode active" id="' + modalId + '_bibModePaste" style="padding:6px 12px;font-size:12px;" onclick="setBibImportMode(\'' + modalId + '\',\'paste\')">粘贴文本</button>' +
            '<button type="button" class="btn btn-secondary lit-bib-mode" id="' + modalId + '_bibModeFile" style="padding:6px 12px;font-size:12px;" onclick="setBibImportMode(\'' + modalId + '\',\'file\')">上传 .bib 文件</button>' +
            '</div>' +
            '<div id="' + modalId + '_bibPaste">' +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">粘贴 BibTeX（可拖入 .bib 文件）</label>' +
            '<textarea id="libLitBibtex" rows="8" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-family:monospace;font-size:12px;" ' +
            'placeholder="@article{...,&#10;  title={...},&#10;  author={...},&#10;  year={2024}&#10;}" ' +
            'ondragover="event.preventDefault()" ondrop="handleBibTextDrop(event,\'' + modalId + '\')"></textarea></div>' +
            '</div>' +
            '<div id="' + modalId + '_bibFile" style="display:none;">' +
            '<div class="lit-pdf-drop" style="padding:28px;" onclick="document.getElementById(\'libLitBibFile_' + modalId + '\').click()" ' +
            'ondragover="event.preventDefault();this.classList.add(\'drag\')" ondragleave="this.classList.remove(\'drag\')" ' +
            'ondrop="event.preventDefault();this.classList.remove(\'drag\');handleBibFileDrop(event,\'' + modalId + '\')">' +
            '<div style="font-size:32px;margin-bottom:6px;">📄</div>' +
            '<div style="font-weight:600;">拖拽 .bib 文件到此处，或点击选择</div>' +
            '<div style="font-size:12px;color:#888;margin-top:4px;">适配 Zotero / EndNote / Mendeley 导出</div></div>' +
            '<input type="file" id="libLitBibFile_' + modalId + '" accept=".bib,text/plain" style="display:none;" onchange="handleBibFileSelect(this,\'' + modalId + '\')">' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0;">' +
            tagsFieldHtml('统一标签（可选）', 'libLitBibTags', '如：目标检测, 综述') +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">关联项目</label>' +
            '<select id="libLitBibProject" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;"><option value="">不关联</option>' + projectOpts + '</select></div>' +
            '</div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;">' +
            '<input type="checkbox" id="libLitBibSync" checked> 导入后同步到文献对比</label>' +
            '<div id="' + modalId + '_bibPreview" style="display:none;margin-top:10px;"></div>' +
            '<div id="' + modalId + '_bibStatus" style="font-size:12px;color:#888;min-height:16px;"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;flex-wrap:wrap;">' +
            '<button type="button" class="btn btn-secondary" onclick="closeLibraryLiteratureModal(\'' + modalId + '\')">取消</button>' +
            '<button type="button" class="btn" id="' + modalId + '_saveBtn" onclick="commitLibraryLiterature(\'' + modalId + '\')">保存</button>' +
            '</div></div></div>';
        pendingLitPdfFile = null;
        pendingBibPreview = [];
        document.body.appendChild(modal);
        try { renderDoiHistory(modalId); } catch (eH) {}
        if (tab) switchLitLibModalTab(modalId, tab);
        else updateLitModalFooter(modalId, 'manual');
    }

    function closeLibraryLiteratureModal(modalId) {
        clearPendingLitPdf();
        pendingBibPreview = [];
        var modal = document.getElementById(modalId);
        if (modal) modal.remove();
    }

    function fieldHtml(label, id, type, ph) {
        return '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:5px;font-size:13px;">' + label + '</label>' +
            '<input type="' + type + '" id="' + id + '" placeholder="' + (ph || '') + '" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;"></div>';
    }

    function tagsFieldHtml(label, id, ph) {
        var tags = getAllTags();
        var datalistId = id + '_datalist';
        var chips = tags.slice(0, 20).map(function (t) {
            return '<button type="button" class="lit-tag-quick-chip" onclick="appendLitTagToInput(' + JSON.stringify(id) + ',' + JSON.stringify(t) + ')">' + esc(t) + '</button>';
        }).join('');
        return '<div style="margin-bottom:12px;" class="lit-tags-field" data-tags-input="' + id + '">' +
            '<label style="display:block;margin-bottom:5px;font-size:13px;">' + label + '</label>' +
            '<input type="text" list="' + datalistId + '" id="' + id + '" placeholder="' + (ph || '') + '" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' +
            '<datalist id="' + datalistId + '">' + tags.map(function (t) {
                return '<option value="' + esc(t) + '"></option>';
            }).join('') + '</datalist>' +
            '<div class="lit-tag-quick" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">' +
            '<span style="font-size:11px;color:#9ca3af;margin-right:2px;">快捷：</span>' + chips +
            '<button type="button" class="lit-tag-quick-chip lit-tag-quick-add" onclick="promptAddLitTagToInput(' + JSON.stringify(id) + ')">+ 新建</button>' +
            '</div></div>';
    }

    function getProjectOptionsHtml() {
        var opts = [];
        try {
            [['longitudinalData', '纵向'], ['horizontalData', '横向'], ['schoolData', '校级']].forEach(function (pair) {
                var arr = global[pair[0]];
                if (!Array.isArray(arr)) {
                    try { arr = JSON.parse(localStorage.getItem(pair[0]) || '[]'); } catch (e) { arr = []; }
                }
                (arr || []).forEach(function (p) {
                    var name = p.name || p.title || p.projectName || ('项目' + p.id);
                    opts.push('<option value="' + pair[0] + ':' + p.id + '">[' + pair[1] + '] ' + esc(name) + '</option>');
                });
            });
        } catch (e) {}
        return opts.join('');
    }

    function switchLitLibModalTab(modalId, tab) {
        var modal = document.getElementById(modalId);
        if (!modal) return;
        ['manual', 'pdf', 'doi', 'bib'].forEach(function (t) {
            var pane = document.getElementById(modalId + '_' + t);
            if (pane) pane.style.display = t === tab ? 'block' : 'none';
        });
        modal.querySelectorAll('.lit-modal-tab').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
        });
        updateLitModalFooter(modalId, tab);
        if (tab === 'doi') renderDoiHistory(modalId);
    }

    function updateLitModalFooter(modalId, tab) {
        var saveBtn = document.getElementById(modalId + '_saveBtn');
        if (!saveBtn) return;
        saveBtn.disabled = false;
        saveBtn.onclick = function () { commitLibraryLiterature(modalId); };
        if (tab === 'manual') {
            saveBtn.textContent = '保存';
        } else if (tab === 'pdf') {
            saveBtn.textContent = pendingLitPdfFile ? '上传并入库' : '请先选择 PDF';
        } else if (tab === 'doi') {
            var preview = document.getElementById(modalId + '_doiPreview');
            var hasPreview = preview && preview.style.display !== 'none' && preview.innerHTML;
            if (hasPreview) {
                saveBtn.textContent = '保存入库';
            } else {
                saveBtn.textContent = '自动提取元数据';
                saveBtn.onclick = function () { fetchLiteratureByDoi(modalId); };
            }
        } else if (tab === 'bib') {
            if (pendingBibPreview && pendingBibPreview.length) {
                saveBtn.textContent = '确认导入选中项';
                saveBtn.onclick = function () { confirmBibPreviewImport(modalId); };
            } else {
                saveBtn.textContent = '解析预览';
                saveBtn.onclick = function () { parseBibtexPreview(modalId); };
            }
        }
    }

    function litToast(msg, isError) {
        if (typeof global.showCloudSyncBanner === 'function') {
            global.showCloudSyncBanner(msg, !!isError);
            return;
        }
        alert(msg);
    }

    function normalizeDoiInput(raw) {
        var s = String(raw || '').trim();
        if (!s) return '';
        s = s.replace(/^doi:\s*/i, '');
        var m = s.match(/10\.\d{4,9}\/[^\s\]）)>"']+/i);
        if (m) return m[0].replace(/[.,;]+$/, '');
        s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
        return s.trim();
    }

    function isValidDoi(doi) {
        return /^10\.\d{4,9}\/\S+$/i.test(String(doi || ''));
    }

    function onLitDoiInputChange(modalId) {
        var input = document.getElementById('libLitDoiInput');
        var hint = document.getElementById(modalId + '_doiHint');
        if (!input) return;
        var raw = input.value;
        var doi = normalizeDoiInput(raw);
        if (!String(raw || '').trim()) {
            input.style.borderColor = '#ddd';
            if (hint) { hint.style.color = '#888'; hint.textContent = '支持纯 DOI、doi.org 链接；也可粘贴含 DOI 的文献页链接'; }
            return;
        }
        if (!isValidDoi(doi)) {
            input.style.borderColor = '#ef4444';
            if (hint) { hint.style.color = '#dc2626'; hint.textContent = '请输入正确的 DOI 格式，如 10.1038/s41586-020-2649-2'; }
        } else {
            input.style.borderColor = '#86efac';
            if (hint) {
                hint.style.color = '#16a34a';
                hint.textContent = doi !== String(raw).trim() ? ('已识别 DOI：' + doi) : 'DOI 格式正确';
            }
            if (doi !== String(raw).trim()) input.value = doi;
        }
    }

    function loadDoiCache() {
        try {
            var raw = localStorage.getItem(DOI_CACHE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function saveDoiCache(cache) {
        try { localStorage.setItem(DOI_CACHE_KEY, JSON.stringify(cache || {})); } catch (e) {}
    }

    function getDoiHistory() {
        try {
            var raw = localStorage.getItem(DOI_HISTORY_KEY);
            var list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }

    function pushDoiHistory(item) {
        var list = getDoiHistory().filter(function (x) { return x.doi !== item.doi; });
        list.unshift({ doi: item.doi, title: item.title || item.doi, at: Date.now() });
        list = list.slice(0, 8);
        try { localStorage.setItem(DOI_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
    }

    function renderDoiHistory(modalId) {
        var box = document.getElementById(modalId + '_doiHistory');
        if (!box) return;
        var list = getDoiHistory();
        if (!list.length) { box.innerHTML = ''; return; }
        box.innerHTML = '<div style="font-size:12px;color:#888;margin-bottom:4px;">最近查询</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
            list.map(function (h) {
                return '<button type="button" class="btn btn-secondary" style="padding:3px 8px;font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" ' +
                    'title="' + esc(h.doi) + '" onclick="fillDoiFromHistory(\'' + modalId + '\',\'' + esc(h.doi).replace(/'/g, '') + '\')">' +
                    esc((h.title || h.doi).slice(0, 28)) + '</button>';
            }).join('') + '</div>';
    }

    function fillDoiFromHistory(modalId, doi) {
        setVal('libLitDoiInput', doi);
        onLitDoiInputChange(modalId);
        fetchLiteratureByDoi(modalId);
    }

    function setPdfStatus(modalId, msg, color) {
        var el = document.getElementById(modalId + '_pdfStatus');
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = color || '#888';
    }

    function handleLibraryPdfDrop(event, modalId) {
        var files = event.dataTransfer && event.dataTransfer.files;
        if (!files || !files.length) return;
        acceptLibraryPdfFile(files[0], modalId);
    }

    function handleLibraryPdfFileSelect(input, modalId) {
        var file = input && input.files && input.files[0];
        if (!file) return;
        acceptLibraryPdfFile(file, modalId);
        try { input.value = ''; } catch (e) {}
    }

    function clearPendingLitPdf() {
        pendingLitPdfFile = null;
    }

    async function acceptLibraryPdfFile(file, modalId) {
        if (!file) return;
        var name = String(file.name || '').toLowerCase();
        var isPdf = name.endsWith('.pdf') || (file.type || '') === 'application/pdf';
        if (!isPdf) {
            setPdfStatus(modalId, '请选择 PDF 文件', '#dc2626');
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            setPdfStatus(modalId, '文件过大（上限 50MB）', '#dc2626');
            return;
        }
        pendingLitPdfFile = file;
        var editBox = document.getElementById(modalId + '_pdfEdit');
        if (editBox) editBox.style.display = 'block';
        var baseTitle = String(file.name || '').replace(/\.pdf$/i, '');
        setVal('libLitPdfTitle', baseTitle);
        setVal('libLitPdfAuthor', '');
        setVal('libLitPdfJournal', '');
        setVal('libLitPdfYear', '');
        setVal('libLitPdfDoi', '');
        setVal('libLitPdfSummary', '');
        setVal('libLitPdfTags', 'PDF');
        var typeEl = document.getElementById('libLitPdfType');
        if (typeEl) typeEl.value = 'journal';
        setPdfStatus(modalId, '已选择：' + file.name + '（' + (file.size / 1024 / 1024).toFixed(2) + ' MB），正在自动识别…', '#7c3aed');
        await fillPdfRecognizeFields(file, modalId, baseTitle);
    }

    async function reRecognizeLibraryPdf(modalId) {
        if (!pendingLitPdfFile) {
            setPdfStatus(modalId, '请先上传 PDF', '#dc2626');
            return;
        }
        setPdfStatus(modalId, '正在重新识别…', '#7c3aed');
        var baseTitle = String(pendingLitPdfFile.name || '').replace(/\.pdf$/i, '');
        await fillPdfRecognizeFields(pendingLitPdfFile, modalId, baseTitle);
    }

    async function fillPdfRecognizeFields(file, modalId, baseTitle) {
        try {
            setPdfStatus(modalId, '识别中：提取 PDF 文字…', '#7c3aed');
            var extracted = await extractPdfLiteratureMeta(file);
            if (!extracted) {
                setPdfStatus(modalId, '✓ 已选择：' + file.name + '（未能提取文字，可能是扫描件，请手改下方字段）', '#ca8a04');
                return;
            }

            // 优先 DOI → CrossRef 官方元数据，再用 PDF 内容补缺
            if (extracted.doi && isValidDoi(extracted.doi)) {
                setPdfStatus(modalId, '识别中：发现 DOI，正在拉取官方元数据…', '#7c3aed');
                try {
                    var cache = loadDoiCache();
                    var cached = cache[extracted.doi.toLowerCase()];
                    var meta = (cached && cached.meta) ? cached.meta : await fetchCrossrefByDoi(extracted.doi);
                    if (!cached) {
                        cache[extracted.doi.toLowerCase()] = { at: Date.now(), meta: meta };
                        saveDoiCache(cache);
                    }
                    extracted = {
                        title: meta.title || extracted.title,
                        author: meta.author || extracted.author,
                        journal: meta.journal || extracted.journal,
                        year: meta.year || extracted.year,
                        doi: meta.doi || extracted.doi,
                        summary: meta.summary || extracted.summary,
                        tags: meta.tags || extracted.tags,
                        litType: meta.litType || extracted.litType,
                        citations: meta.citations,
                        paperUrl: meta.paperUrl
                    };
                } catch (eDoi) {
                    // 保留 PDF 本地识别结果
                }
            }

            if (extracted.title) setVal('libLitPdfTitle', extracted.title);
            else if (baseTitle) setVal('libLitPdfTitle', baseTitle);
            if (extracted.author) setVal('libLitPdfAuthor', extracted.author);
            if (extracted.journal) setVal('libLitPdfJournal', extracted.journal);
            if (extracted.year) setVal('libLitPdfYear', extracted.year);
            if (extracted.doi) setVal('libLitPdfDoi', extracted.doi);
            if (extracted.summary) setVal('libLitPdfSummary', extracted.summary);
            if (extracted.tags) setVal('libLitPdfTags', extracted.tags);
            if (extracted.litType) {
                var typeEl = document.getElementById('libLitPdfType');
                if (typeEl) typeEl.value = extracted.litType;
            }
            var hints = [];
            if (extracted.title) hints.push('标题');
            if (extracted.author) hints.push('作者');
            if (extracted.year) hints.push('年份');
            if (extracted.doi) hints.push('DOI');
            if (extracted.summary) hints.push('摘要');
            setPdfStatus(modalId, '✓ 自动识别完成' + (hints.length ? ('：' + hints.join('、')) : '') + '，请核对后手改，再点「上传并入库」', '#16a34a');
            updateLitModalFooter(modalId, 'pdf');
        } catch (err) {
            setPdfStatus(modalId, '✓ 已选择：' + file.name + '（识别异常，请手改字段）' + (err && err.message ? ' · ' + err.message : ''), '#ca8a04');
        }
    }

    /** 从 PDF 前几页提取文献元数据，供手改 */
    async function extractPdfLiteratureMeta(file) {
        var pdfjs = global.pdfjsLib || global.pdfjs;
        if (!pdfjs) return null;
        if (pdfjs.GlobalWorkerOptions) {
            pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js';
        }
        var buf = await file.arrayBuffer();
        var pdf = await pdfjs.getDocument({ data: buf }).promise;
        var maxPages = Math.min(3, pdf.numPages || 1);
        var pageTexts = [];
        for (var i = 1; i <= maxPages; i++) {
            var page = await pdf.getPage(i);
            var content = await page.getTextContent();
            var lines = [];
            var lastY = null;
            (content.items || []).forEach(function (it) {
                var str = String(it.str || '');
                if (!str) return;
                var y = it.transform ? it.transform[5] : null;
                if (lastY != null && y != null && Math.abs(y - lastY) > 5) lines.push('\n');
                else if (lines.length && !/\s$/.test(lines[lines.length - 1]) && !/^\s/.test(str)) lines.push(' ');
                lines.push(str);
                lastY = y;
            });
            pageTexts.push(lines.join('').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim());
        }
        var text = pageTexts.join('\n\n').trim();
        if (!text || text.replace(/\s/g, '').length < 20) return null;

        var doiMatch = text.match(/\b10\.\d{4,9}\/[^\s\]）)>,"']+/i);
        var doi = doiMatch ? doiMatch[0].replace(/[.,;]+$/, '') : '';

        var yearMatch = text.match(/\b(19|20)\d{2}\b/);
        var year = yearMatch ? yearMatch[0] : '';

        // 标题：取首屏较长的非作者行
        var rawLines = pageTexts[0].split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
        var title = '';
        for (var li = 0; li < Math.min(rawLines.length, 8); li++) {
            var line = rawLines[li];
            if (line.length < 12) continue;
            if (/^(abstract|keywords|introduction|参考文献|摘要|关键词)/i.test(line)) break;
            if (/^(doi|arxiv|vol\.|pp\.|http)/i.test(line)) continue;
            if (/^[\d\.\s]+$/.test(line)) continue;
            title = line.slice(0, 180);
            break;
        }
        if (!title) {
            var parts = text.split(/[\n。.!？?]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 12; });
            title = (parts[0] || text).slice(0, 180);
        }

        // 作者：标题后 1～3 行，或含逗号/and 的短行
        var author = '';
        var titleIdx = rawLines.indexOf(title) >= 0 ? rawLines.indexOf(title) : 0;
        for (var ai = titleIdx + 1; ai < Math.min(rawLines.length, titleIdx + 5); ai++) {
            var aLine = rawLines[ai];
            if (/^(abstract|keywords|introduction|学院|大学|department|university)/i.test(aLine)) break;
            if (aLine.length > 8 && aLine.length < 160 && !/^\d+$/.test(aLine) && !/^10\.\d/.test(aLine)) {
                author = aLine.replace(/\s+/g, ' ').replace(/\d+/g, '').replace(/\s*,\s*/g, ', ').trim();
                break;
            }
        }

        // 期刊启发式
        var journal = '';
        var jMatch = text.match(/(?:Published in|Journal|Proceedings of|会议|学报)[:：\s]+([^\n.]{4,80})/i);
        if (jMatch) journal = jMatch[1].trim();

        // 摘要
        var summary = '';
        var absMatch = text.match(/(?:Abstract|摘要)\s*[:：]?\s*([\s\S]{40,1200}?)(?=\n\s*(?:Keywords|关键词|1\.|I\.|引言|Introduction)\b|$)/i);
        if (absMatch) summary = absMatch[1].replace(/\s+/g, ' ').trim().slice(0, 1000);
        else summary = text.slice(0, 600);

        var litType = /proceedings|conference|workshop|会议/i.test(text) ? 'conference'
            : /review|综述/i.test(text + ' ' + title) ? 'review'
            : 'journal';

        var tags = ['PDF'];
        if (/deep learning|深度学习|neural/i.test(text)) tags.push('深度学习');
        if (/urban|城市安全|safety/i.test(text)) tags.push('城市安全');
        if (/detection|检测|yolo/i.test(text)) tags.push('目标检测');

        return {
            title: title,
            author: author,
            journal: journal,
            year: year,
            doi: doi,
            summary: summary,
            tags: tags.join(', '),
            litType: litType,
            snippet: text.slice(0, 1200)
        };
    }

    // 兼容旧名
    async function extractPdfFirstPageHint(file) {
        var meta = await extractPdfLiteratureMeta(file);
        if (!meta) return null;
        return { title: meta.title, snippet: meta.summary || meta.snippet };
    }

    async function storeLiteraturePdfToShared(file, options) {
        options = options || {};
        if (!file) return null;
        if (!Array.isArray(global.sharedFileData)) {
            try { global.sharedFileData = JSON.parse(localStorage.getItem('sharedFileData') || '[]'); } catch (e) { global.sharedFileData = []; }
        }
        var newId = global.sharedFileData.length
            ? Math.max.apply(null, global.sharedFileData.map(function (f) { return Number(f.id) || 0; })) + 1
            : 1;
        // 即使列表为空也要保证 id 递增：用时间戳兜底
        if (!newId || newId < 1) newId = Date.now();
        if (typeof global.saveSharedFileBlob !== 'function') {
            throw new Error('共享文件存储未就绪，请刷新页面后重试');
        }
        await global.saveSharedFileBlob(newId, file);
        var sizeKb = Math.max(1, Math.round(file.size / 1024));
        var meta = {
            id: newId,
            name: file.name || ('literature_' + newId + '.pdf'),
            size: sizeKb >= 1024 ? ((sizeKb / 1024).toFixed(1) + ' MB') : (sizeKb + ' KB'),
            fileSizeBytes: file.size,
            type: 'document',
            uploader: currentOwner(),
            uploaderId: (global.currentUser && global.currentUser.id) || 0,
            uploadTime: new Date().toLocaleDateString('zh-CN'),
            downloadCount: 0,
            fromLiterature: true,
            hiddenInLibrary: !options.visibleInShared
        };
        // 始终写入元数据，下载才能找到；隐藏项不在共享库列表展示
        global.sharedFileData.push(meta);
        try {
            localStorage.setItem('sharedFileData', JSON.stringify(global.sharedFileData));
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('sharedFileData', JSON.stringify(global.sharedFileData));
        } catch (e2) {}
        try {
            if (options.visibleInShared && typeof global.renderFileList === 'function') global.renderFileList();
        } catch (e3) {}
        return meta;
    }

    async function fetchCrossrefByDoi(doi) {
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { try { controller.abort(); } catch (e) {} }, 12000) : null;
        try {
            var resp = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi), {
                headers: { Accept: 'application/json' },
                signal: controller ? controller.signal : undefined
            });
            if (timer) clearTimeout(timer);
            if (resp.status === 404) throw new Error('NOT_FOUND');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var data = await resp.json();
            var msg = data && data.message;
            if (!msg) throw new Error('EMPTY');
            return mapCrossrefMessage(msg, doi);
        } catch (err) {
            if (timer) clearTimeout(timer);
            // OpenAlex 降级
            try {
                var resp2 = await fetch('https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi));
                if (resp2.status === 404) throw new Error('NOT_FOUND');
                if (!resp2.ok) throw new Error('HTTP ' + resp2.status);
                var oa = await resp2.json();
                return mapOpenAlexWork(oa, doi);
            } catch (err2) {
                throw err;
            }
        }
    }

    function mapCrossrefMessage(msg, doi) {
        var authors = (msg.author || []).map(function (a) {
            return [a.given, a.family].filter(Boolean).join(' ') || a.name || '';
        }).filter(Boolean).join(', ');
        var title = Array.isArray(msg.title) ? msg.title[0] : (msg.title || '');
        var journal = (msg['container-title'] && msg['container-title'][0]) || msg.publisher || '';
        var year = '';
        var parts = (msg.published && msg.published['date-parts'] && msg.published['date-parts'][0]) ||
            (msg.created && msg.created['date-parts'] && msg.created['date-parts'][0]);
        if (parts && parts[0]) year = String(parts[0]);
        var abstract = String(msg.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        var type = String(msg.type || '');
        var litType = /proceedings|conference/i.test(type + ' ' + journal) ? 'conference'
            : /dissertation|thesis/i.test(type) ? 'thesis'
            : /book/i.test(type) ? 'other'
            : 'journal';
        var keywords = [];
        if (Array.isArray(msg.subject)) keywords = msg.subject.slice(0, 6);
        return {
            title: title,
            author: authors,
            journal: journal,
            year: year,
            doi: doi,
            summary: abstract.slice(0, 2000),
            citations: Number(msg['is-referenced-by-count'] || 0) || 0,
            paperUrl: msg.URL || ('https://doi.org/' + doi),
            litType: litType,
            tags: keywords.join(', '),
            publisher: msg.publisher || '',
            volume: msg.volume || '',
            page: msg.page || ''
        };
    }

    function mapOpenAlexWork(oa, doi) {
        var authors = ((oa.authorships || []).map(function (a) {
            return (a.author && a.author.display_name) || '';
        }).filter(Boolean)).join(', ');
        var year = oa.publication_year ? String(oa.publication_year) : '';
        var journal = (oa.primary_location && oa.primary_location.source && oa.primary_location.source.display_name) || '';
        return {
            title: oa.title || oa.display_name || '',
            author: authors,
            journal: journal,
            year: year,
            doi: doi,
            summary: String(oa.abstract || '').slice(0, 2000),
            citations: Number(oa.cited_by_count || 0) || 0,
            paperUrl: (oa.primary_location && oa.primary_location.landing_page_url) || ('https://doi.org/' + doi),
            litType: 'journal',
            tags: '',
            publisher: '',
            volume: '',
            page: ''
        };
    }

    function applyMetaToManualForm(meta) {
        if (!meta) return;
        setVal('libLitTitle', meta.title || '');
        setVal('libLitAuthor', meta.author || '');
        setVal('libLitJournal', meta.journal || '');
        setVal('libLitYear', meta.year || '');
        setVal('libLitDoi', meta.doi || '');
        setVal('libLitCite', meta.citations || 0);
        setVal('libLitSummary', meta.summary || '');
        setVal('libLitUrl', meta.paperUrl || (meta.doi ? ('https://doi.org/' + meta.doi) : ''));
        if (meta.tags) setVal('libLitTags', meta.tags);
        var typeEl = document.getElementById('libLitType');
        if (typeEl && meta.litType) typeEl.value = meta.litType;
    }

    function renderDoiPreview(modalId, meta) {
        var box = document.getElementById(modalId + '_doiPreview');
        if (!box || !meta) return;
        var dup = findLibraryDuplicate(meta);
        box.style.display = 'block';
        box.innerHTML =
            '<div style="font-weight:700;color:#166534;margin-bottom:8px;">✓ 元数据提取成功' + (dup ? ' · <span style="color:#b45309;">库中已有相似文献</span>' : '') + '</div>' +
            '<div style="font-size:14px;font-weight:600;color:#111;margin-bottom:6px;">' + esc(meta.title || '（无标题）') + '</div>' +
            '<div style="font-size:12px;color:#4b5563;line-height:1.7;">' +
            '<div>作者：' + esc(meta.author || '—') + '</div>' +
            '<div>期刊/会议：' + esc(meta.journal || '—') + ' · ' + esc(meta.year || '—') + '</div>' +
            '<div>DOI：' + esc(meta.doi || '—') + (meta.citations ? (' · 引用 ' + meta.citations) : '') + '</div>' +
            (meta.summary ? ('<div style="margin-top:6px;">摘要：' + esc(meta.summary.slice(0, 180)) + (meta.summary.length > 180 ? '…' : '') + '</div>') : '') +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
            '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="switchLitLibModalTab(\'' + modalId + '\',\'manual\')">去手动表单微调</button>' +
            '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="copyDoiAsBibtex(\'' + modalId + '\')">复制 BibTeX</button>' +
            (dup ? ('<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="showLibraryLiteratureDetail(' + dup.id + ')">查看已有文献</button>') : '') +
            '</div>';
        box.dataset.meta = JSON.stringify(meta);
        updateLitModalFooter(modalId, 'doi');
    }

    function copyDoiAsBibtex(modalId) {
        var box = document.getElementById(modalId + '_doiPreview');
        if (!box || !box.dataset.meta) return;
        try {
            var meta = JSON.parse(box.dataset.meta);
            var key = String(meta.doi || 'item').replace(/[^a-zA-Z0-9]/g, '');
            var bib = '@article{' + key + ',\n' +
                '  title={' + (meta.title || '') + '},\n' +
                '  author={' + String(meta.author || '').replace(/,/g, ' and') + '},\n' +
                '  journal={' + (meta.journal || '') + '},\n' +
                '  year={' + (meta.year || '') + '},\n' +
                '  doi={' + (meta.doi || '') + '}\n}';
            navigator.clipboard.writeText(bib);
            litToast('已复制 BibTeX');
        } catch (e) {
            litToast('复制失败', true);
        }
    }

    async function fetchLiteratureByDoi(modalId) {
        var input = document.getElementById('libLitDoiInput');
        var status = document.getElementById(modalId + '_doiStatus');
        var saveBtn = document.getElementById(modalId + '_saveBtn');
        var doi = normalizeDoiInput((input && input.value) || '');
        if (input) input.value = doi;
        onLitDoiInputChange(modalId);
        if (!doi) {
            if (status) { status.style.color = '#dc2626'; status.textContent = '请输入 DOI'; }
            return;
        }
        if (!isValidDoi(doi)) {
            if (status) { status.style.color = '#dc2626'; status.textContent = 'DOI 格式不正确'; }
            return;
        }

        var setStatus = function (msg, color) {
            if (status) { status.textContent = msg; status.style.color = color || '#888'; }
        };

        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '正在提取元数据...'; }

        // 缓存
        var cache = loadDoiCache();
        var cached = cache[doi.toLowerCase()];
        if (cached && cached.at && (Date.now() - cached.at < 7 * 24 * 3600 * 1000) && cached.meta) {
            applyMetaToManualForm(cached.meta);
            renderDoiPreview(modalId, cached.meta);
            pushDoiHistory(cached.meta);
            setStatus('✓ 命中本地缓存（7 日内）', '#16a34a');
            litToast('元数据提取成功');
            if (saveBtn) { saveBtn.disabled = false; }
            updateLitModalFooter(modalId, 'doi');
            return;
        }

        setStatus('正在提取元数据（CrossRef → OpenAlex）…', '#7c3aed');
        try {
            var meta = await fetchCrossrefByDoi(doi);
            cache[doi.toLowerCase()] = { at: Date.now(), meta: meta };
            saveDoiCache(cache);
            applyMetaToManualForm(meta);
            renderDoiPreview(modalId, meta);
            pushDoiHistory(meta);
            renderDoiHistory(modalId);
            setStatus('✓ 元数据提取成功，可在预览区确认后直接「保存入库」，或去手动表单微调', '#16a34a');
            litToast('元数据提取成功');
            var titleEl = document.getElementById('libLitTitle');
            if (titleEl) try { titleEl.focus(); } catch (e) {}
        } catch (err) {
            var msg = '网络请求失败，请稍后重试';
            if (err && err.message === 'NOT_FOUND') msg = '未检索到该 DOI 对应的文献，请检查 DOI 是否正确';
            else if (err && err.name === 'AbortError') msg = '请求超时，请重试';
            else if (err && err.message) msg = '提取失败：' + err.message;
            setStatus(msg + '  ', '#dc2626');
            if (status) {
                var retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'btn btn-secondary';
                retry.style.cssText = 'padding:2px 8px;font-size:11px;margin-left:6px;';
                retry.textContent = '重试';
                retry.onclick = function () { fetchLiteratureByDoi(modalId); };
                status.appendChild(retry);
            }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
            updateLitModalFooter(modalId, 'doi');
        }
    }

    function setVal(id, v) {
        var el = document.getElementById(id);
        if (el) el.value = v == null ? '' : v;
    }

    function parseBibtexEntries(text) {
        var entries = [];
        // 更宽容：允许 } 前无换行
        var re = /@(\w+)\s*\{\s*([^,]+)\s*,([\s\S]*?)\}/g;
        var m;
        var src = String(text || '').replace(/\r\n/g, '\n');
        while ((m = re.exec(src)) !== null) {
            var fields = {};
            var body = m[3];
            var fr = /(\w+)\s*=\s*(\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)"|(\d+))/g;
            var fm;
            while ((fm = fr.exec(body)) !== null) {
                var val = fm[3] != null ? fm[3] : (fm[4] != null ? fm[4] : fm[5] || '');
                fields[fm[1].toLowerCase()] = String(val).replace(/\{\\/g, '').replace(/\\([{}&%$#_])/g, '$1').trim();
            }
            var type = String(m[1] || '').toLowerCase();
            var litType = /inproceedings|conference|proceedings/.test(type) ? 'conference'
                : /phdthesis|mastersthesis|thesis/.test(type) ? 'thesis'
                : /techreport|report/.test(type) ? 'report'
                : /book/.test(type) ? 'other'
                : 'journal';
            var title = fields.title || '';
            var author = (fields.author || '').replace(/\s+and\s+/gi, ', ');
            var incomplete = !title;
            entries.push({
                title: title,
                author: author,
                journal: fields.journal || fields.booktitle || fields.venue || '',
                year: fields.year || '',
                doi: String(fields.doi || '').replace(/^https?:\/\/doi\.org\//i, ''),
                summary: fields.abstract || '',
                tags: fields.keywords || '',
                paperUrl: fields.url || (fields.doi ? ('https://doi.org/' + fields.doi) : ''),
                litType: litType,
                incomplete: incomplete,
                bibType: type
            });
        }
        return entries;
    }

    function findLibraryDuplicate(item) {
        var doi = String(item.doi || '').trim().toLowerCase();
        var title = String(item.title || '').trim().toLowerCase();
        var author = String(item.author || '').trim().toLowerCase().split(',')[0];
        return getLiteratureData().find(function (l) {
            if (doi && String(l.doi || '').toLowerCase() === doi) return true;
            if (title && String(l.title || '').toLowerCase() === title) {
                if (!author) return true;
                return String(l.author || '').toLowerCase().indexOf(author) >= 0;
            }
            return false;
        });
    }

    function setBibImportMode(modalId, mode) {
        var paste = document.getElementById(modalId + '_bibPaste');
        var file = document.getElementById(modalId + '_bibFile');
        var btnP = document.getElementById(modalId + '_bibModePaste');
        var btnF = document.getElementById(modalId + '_bibModeFile');
        if (paste) paste.style.display = mode === 'paste' ? 'block' : 'none';
        if (file) file.style.display = mode === 'file' ? 'block' : 'none';
        if (btnP) btnP.classList.toggle('active', mode === 'paste');
        if (btnF) btnF.classList.toggle('active', mode === 'file');
    }

    function handleBibTextDrop(event, modalId) {
        event.preventDefault();
        var files = event.dataTransfer && event.dataTransfer.files;
        if (!files || !files.length) return;
        readBibFileIntoTextarea(files[0], modalId);
    }

    function handleBibFileDrop(event, modalId) {
        var files = event.dataTransfer && event.dataTransfer.files;
        if (!files || !files.length) return;
        readBibFileIntoTextarea(files[0], modalId);
        setBibImportMode(modalId, 'paste');
    }

    function handleBibFileSelect(input, modalId) {
        var file = input && input.files && input.files[0];
        if (!file) return;
        readBibFileIntoTextarea(file, modalId);
        setBibImportMode(modalId, 'paste');
        try { input.value = ''; } catch (e) {}
    }

    function readBibFileIntoTextarea(file, modalId) {
        var name = String(file.name || '').toLowerCase();
        if (!(/\.(bib|txt)$/.test(name) || (file.type || '').indexOf('text') >= 0)) {
            setBibStatus(modalId, '请选择 .bib 文本文件', '#dc2626');
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            setVal('libLitBibtex', e.target.result || '');
            setBibStatus(modalId, '✓ 已读取：' + file.name + '，请点「解析预览」', '#16a34a');
            pendingBibPreview = [];
            var prev = document.getElementById(modalId + '_bibPreview');
            if (prev) { prev.style.display = 'none'; prev.innerHTML = ''; }
            updateLitModalFooter(modalId, 'bib');
        };
        reader.onerror = function () { setBibStatus(modalId, '读取文件失败', '#dc2626'); };
        reader.readAsText(file, 'utf-8');
    }

    function setBibStatus(modalId, msg, color) {
        var el = document.getElementById(modalId + '_bibStatus');
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = color || '#888';
    }

    function parseBibtexPreview(modalId) {
        var bibText = (document.getElementById('libLitBibtex') || {}).value || '';
        var entries = parseBibtexEntries(bibText);
        if (!entries.length) {
            setBibStatus(modalId, '未解析到有效 BibTeX 条目，请检查格式', '#dc2626');
            return;
        }
        var uniTags = String((document.getElementById('libLitBibTags') || {}).value || '').trim();
        pendingBibPreview = entries.map(function (e, idx) {
            var dup = findLibraryDuplicate(e);
            var status = e.incomplete ? 'bad' : (dup ? 'dup' : 'ok');
            return Object.assign({}, e, {
                _idx: idx,
                _status: status,
                _dupId: dup ? dup.id : null,
                _checked: status === 'ok',
                tags: [e.tags, uniTags].filter(Boolean).join(', ')
            });
        });
        renderBibPreview(modalId);
        updateLitModalFooter(modalId, 'bib');
    }

    function renderBibPreview(modalId) {
        var box = document.getElementById(modalId + '_bibPreview');
        if (!box) return;
        var total = pendingBibPreview.length;
        var ok = pendingBibPreview.filter(function (e) { return e._status === 'ok'; }).length;
        var dup = pendingBibPreview.filter(function (e) { return e._status === 'dup'; }).length;
        var bad = pendingBibPreview.filter(function (e) { return e._status === 'bad'; }).length;
        var checked = pendingBibPreview.filter(function (e) { return e._checked; }).length;
        box.style.display = 'block';
        var rows = pendingBibPreview.map(function (e) {
            var badge = e._status === 'ok' ? '<span style="color:#16a34a;">正常</span>'
                : e._status === 'dup' ? '<span style="color:#b45309;">已存在</span>'
                : '<span style="color:#dc2626;">信息不全</span>';
            return '<label style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;">' +
                '<input type="checkbox" ' + (e._checked ? 'checked' : '') + ' onchange="toggleBibPreviewItem(' + e._idx + ', this.checked,\'' + modalId + '\')">' +
                '<span style="flex:1;min-width:0;"><b>' + esc(e.title || '（无标题）') + '</b><br>' +
                esc(e.author || '—') + ' · ' + esc(e.year || '—') + ' · ' + esc(litTypeLabel(e.litType)) +
                ' · ' + badge + '</span></label>';
        }).join('');
        box.innerHTML =
            '<div style="padding:10px 12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;">' +
            '<div style="font-size:13px;font-weight:600;margin-bottom:8px;">共解析 ' + total + ' 篇 · 正常 ' + ok + ' · 重复 ' + dup + ' · 异常 ' + bad +
            ' · 已选 ' + checked + '</div>' +
            '<div style="max-height:240px;overflow:auto;">' + rows + '</div>' +
            '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="setAllBibPreviewChecked(true,\'' + modalId + '\')">全选正常</button>' +
            '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="setAllBibPreviewChecked(false,\'' + modalId + '\')">全不选</button>' +
            '</div></div>';
        setBibStatus(modalId, '请勾选要导入的条目，再点「确认导入选中项」', '#7c3aed');
    }

    function toggleBibPreviewItem(idx, checked, modalId) {
        var item = pendingBibPreview.find(function (e) { return e._idx === idx; });
        if (item) item._checked = !!checked;
        renderBibPreview(modalId);
        updateLitModalFooter(modalId, 'bib');
    }

    function setAllBibPreviewChecked(onlyOk, modalId) {
        // onlyOk true = 只选正常；false = 全不选
        pendingBibPreview.forEach(function (e) {
            if (onlyOk === false) e._checked = false;
            else e._checked = e._status === 'ok';
        });
        renderBibPreview(modalId);
        updateLitModalFooter(modalId, 'bib');
    }

    function confirmBibPreviewImport(modalId) {
        var selected = pendingBibPreview.filter(function (e) { return e._checked && e.title; });
        if (!selected.length) {
            setBibStatus(modalId, '请至少勾选一篇文献', '#dc2626');
            return;
        }
        var sync = !!(document.getElementById('libLitBibSync') || {}).checked;
        var proj = String((document.getElementById('libLitBibProject') || {}).value || '');
        var projectIds = [];
        var projectNames = [];
        if (proj) {
            var parts = proj.split(':');
            projectIds = [Number(parts[1]) || 0].filter(Boolean);
            var sel = document.getElementById('libLitBibProject');
            projectNames = sel && sel.selectedOptions[0] ? [sel.selectedOptions[0].text.replace(/^\[[^\]]+\]\s*/, '')] : [];
        }
        if (sync && selected.length > 10) {
            if (!confirm('对比最多建议 10 篇，将导入全部但仅提示前 10 篇可勾选对比。是否继续？')) return;
        }
        var added = 0, skipped = 0;
        selected.forEach(function (e) {
            if (e._status === 'dup' && findLibraryDuplicate(e)) {
                skipped++;
                return;
            }
            persistLibraryItem(Object.assign({}, e, {
                projectIds: projectIds,
                projectNames: projectNames,
                source: 'bibtex'
            }), { syncCompare: sync && added < 10, silent: true });
            added++;
        });
        finishLibraryImport(modalId, '成功导入 ' + added + ' 篇' + (skipped ? ('，跳过重复 ' + skipped + ' 篇') : ''), added > 0);
    }

    function finishLibraryImport(modalId, msg, offerCompare) {
        pendingLitPdfFile = null;
        pendingBibPreview = [];
        closeLibraryLiteratureModal(modalId);
        renderLiteratureList();
        litToast(msg);
        if (offerCompare && confirm(msg + '\n\n是否打开文献对比分析？')) {
            if (typeof global.showModule === 'function') global.showModule('literature_analysis');
        }
    }

    async function commitLibraryLiterature(modalId) {
        var modal = document.getElementById(modalId);
        if (!modal) return;

        // 根据当前可见 Tab 分流（避免误判）
        var activeTab = 'manual';
        modal.querySelectorAll('.lit-modal-tab').forEach(function (btn) {
            if (btn.classList.contains('active')) activeTab = btn.getAttribute('data-tab') || 'manual';
        });

        if (activeTab === 'bib') {
            if (pendingBibPreview && pendingBibPreview.length) confirmBibPreviewImport(modalId);
            else parseBibtexPreview(modalId);
            return;
        }

        if (activeTab === 'pdf') {
            await commitLibraryPdfUpload(modalId);
            return;
        }

        if (activeTab === 'doi') {
            var preview = document.getElementById(modalId + '_doiPreview');
            var hasPreview = preview && preview.style.display !== 'none' && preview.dataset.meta;
            if (!hasPreview) {
                await fetchLiteratureByDoi(modalId);
                return;
            }
            // 用手动表单（已填充）或 preview meta 保存
        }

        var title = String((document.getElementById('libLitTitle') || {}).value || '').trim();
        if (!title) { alert('请填写标题'); return; }
        var payload = {
            title: title,
            author: String((document.getElementById('libLitAuthor') || {}).value || '').trim(),
            journal: String((document.getElementById('libLitJournal') || {}).value || '').trim(),
            year: String((document.getElementById('libLitYear') || {}).value || '').trim(),
            doi: String((document.getElementById('libLitDoi') || {}).value || '').trim(),
            summary: String((document.getElementById('libLitSummary') || {}).value || '').trim(),
            tags: String((document.getElementById('libLitTags') || {}).value || '').trim(),
            citations: Number((document.getElementById('libLitCite') || {}).value || 0) || 0,
            litType: (document.getElementById('libLitType') || {}).value || 'journal',
            paperUrl: String((document.getElementById('libLitUrl') || {}).value || '').trim(),
            isCore: !!(document.getElementById('libLitCore') || {}).checked,
            source: activeTab === 'doi' ? 'doi' : 'manual'
        };
        var proj = String((document.getElementById('libLitProject') || {}).value || '');
        if (proj) {
            var parts = proj.split(':');
            payload.projectIds = [Number(parts[1]) || 0].filter(Boolean);
            var sel = document.getElementById('libLitProject');
            payload.projectNames = sel && sel.selectedOptions[0] ? [sel.selectedOptions[0].text.replace(/^\[[^\]]+\]\s*/, '')] : [];
        }
        var dup = findLibraryDuplicate(payload);
        if (dup) {
            var choice = confirm('该文献已在库中：《' + dup.title + '》\n\n确定 = 仍要新增一份\n取消 = 取消保存\n\n（可先点预览区「查看已有文献」）');
            if (!choice) return;
        }
        var syncCompare = !!(document.getElementById('libLitSyncCompare') || {}).checked;
        persistLibraryItem(payload, { syncCompare: syncCompare });
        finishLibraryImport(modalId, '成功添加 1 篇文献', true);
    }

    async function commitLibraryPdfUpload(modalId) {
        var modal = document.getElementById(modalId);
        if (!pendingLitPdfFile) {
            setPdfStatus(modalId, '请先选择 PDF 文件', '#dc2626');
            return;
        }
        var title = String((document.getElementById('libLitPdfTitle') || {}).value || '').trim();
        if (!title) {
            title = String(pendingLitPdfFile.name || '').replace(/\.pdf$/i, '') || '未命名 PDF 文献';
        }
        var author = String((document.getElementById('libLitPdfAuthor') || {}).value || '').trim();
        var tags = String((document.getElementById('libLitPdfTags') || {}).value || '').trim() || 'PDF';
        var syncCompare = !!(document.getElementById('libLitPdfSync') || {}).checked;
        var toShared = !!(document.getElementById('libLitPdfToShared') || {}).checked;
        var saveBtn = document.getElementById(modalId + '_saveBtn');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '上传中…'; }
        setPdfStatus(modalId, '正在保存 PDF…', '#7c3aed');

        try {
            var sharedMeta = await storeLiteraturePdfToShared(pendingLitPdfFile, { visibleInShared: toShared });
            if (!sharedMeta) throw new Error('PDF 存储失败');

            var payload = {
                title: title,
                author: author,
                journal: String((document.getElementById('libLitPdfJournal') || {}).value || '').trim(),
                year: String((document.getElementById('libLitPdfYear') || {}).value || '').trim() || String(new Date().getFullYear()),
                doi: String((document.getElementById('libLitPdfDoi') || {}).value || '').trim(),
                tags: tags,
                summary: String((document.getElementById('libLitPdfSummary') || {}).value || '').trim(),
                litType: (document.getElementById('libLitPdfType') || {}).value || 'other',
                source: 'pdf_upload',
                pdfName: pendingLitPdfFile.name,
                sharedFileId: sharedMeta ? sharedMeta.id : null,
                pdfUrl: ''
            };
            var dup = findLibraryDuplicate(payload);
            if (dup && !confirm('库中已有相似文献《' + dup.title + '》，仍要添加吗？')) {
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '上传并入库'; }
                return;
            }
            persistLibraryItem(payload, { syncCompare: syncCompare });
            pendingLitPdfFile = null;
            finishLibraryImport(modalId, 'PDF 已上传并入库' + (toShared ? '，已同步共享文件库' : ''), true);
        } catch (err) {
            setPdfStatus(modalId, '上传失败：' + (err && err.message ? err.message : err), '#dc2626');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '上传并入库'; }
        }
    }

    function persistLibraryItem(raw, options) {
        options = options || {};
        var list = getLiteratureData();
        var newId = list.length ? Math.max.apply(null, list.map(function (l) { return Number(l.id) || 0; })) + 1 : 1;
        var item = normalizeLiteratureRecord(Object.assign({}, raw, {
            id: newId,
            uploader: currentOwner(),
            uploadTime: new Date().toLocaleDateString('zh-CN'),
            source: raw.source || 'manual'
        }));
        list.unshift(item);
        global.literatureData = list;
        saveLiteratureLibraryData({
            log: { action: '添加', desc: '添加文献：' + item.title, detail: { id: item.id, doi: item.doi } }
        });
        if (options.syncCompare !== false) {
            pushLibraryItemToCompare(item, true);
        }
        return item;
    }

    // ========== 详情 ==========
    function showLibraryLiteratureDetail(id) {
        var item = getLiteratureData().find(function (l) { return l.id === id; });
        if (!item) return;
        var modalId = 'litDetail_' + id;
        var old = document.getElementById(modalId);
        if (old) old.remove();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2300;display:flex;justify-content:center;align-items:flex-start;padding:24px 12px;overflow:auto;';
        var citeGb = formatCitation(item, 'gbt');
        var citeApa = formatCitation(item, 'apa');
        var citeIeee = formatCitation(item, 'ieee');
        var related = getRelatedLiterature(item).slice(0, 5);
        modal.innerHTML =
            '<div style="background:#fff;border-radius:12px;width:100%;max-width:920px;margin:auto;">' +
            '<div style="padding:16px 20px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;gap:12px;">' +
            '<h3 style="margin:0;font-size:18px;line-height:1.4;">' + esc(item.title) + '</h3>' +
            '<button type="button" onclick="document.getElementById(\'' + modalId + '\').remove()" style="width:32px;height:32px;border:none;background:#f5f5f5;border-radius:50%;cursor:pointer;flex-shrink:0;">×</button>' +
            '</div>' +
            '<div style="padding:20px;" class="lit-detail-wrap">' +
            '<div>' +
            '<div style="font-size:13px;color:#666;line-height:1.8;">' +
            '<div><b>作者：</b>' + esc(item.author || '—') + '</div>' +
            '<div><b>期刊/会议：</b>' + esc(item.journal || '—') + '</div>' +
            '<div><b>年份：</b>' + esc(item.year || '—') + ' · <b>类型：</b>' + esc(litTypeLabel(item.litType)) + '</div>' +
            '<div><b>DOI：</b>' + (item.doi ? ('<a href="https://doi.org/' + esc(item.doi) + '" target="_blank" rel="noopener">' + esc(item.doi) + '</a>') : '—') + '</div>' +
            '<div><b>引用量：</b>' + (item.citations || 0) + '</div>' +
            '<div><b>标签：</b>' + esc(item.tags || '—') + '</div>' +
            (item.projectNames && item.projectNames.length ? ('<div><b>关联项目：</b>' + esc(item.projectNames.join('、')) + '</div>') : '') +
            '<div><b>上传：</b>' + esc(item.uploader) + ' · ' + esc(item.uploadTime) + '</div>' +
            '<div style="margin-top:8px;"><b>阅读状态：</b> ' +
            '<select id="litReadStatus_' + id + '" onchange="setLibraryLitReadStatus(' + id + ', this.value)" style="padding:4px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
            '<option value="unread"' + ((item.readStatus || 'unread') === 'unread' ? ' selected' : '') + '>未读</option>' +
            '<option value="reading"' + (item.readStatus === 'reading' ? ' selected' : '') + '>在读</option>' +
            '<option value="read"' + (item.readStatus === 'read' ? ' selected' : '') + '>已读</option>' +
            '</select></div>' +
            '</div>' +
            '<div style="margin-top:14px;"><b style="font-size:14px;">摘要</b>' +
            '<div style="margin-top:6px;font-size:13px;color:#444;line-height:1.7;background:#f9fafb;padding:12px;border-radius:8px;">' +
            esc(item.summary || '暂无摘要') + '</div></div>' +
            '<div style="margin-top:14px;"><b style="font-size:14px;">PDF 预览</b>' +
            '<div id="litPdfPreview_' + id + '" style="margin-top:8px;"><div style="font-size:12px;color:#888;">加载中…</div></div></div>' +
            '<div style="margin-top:14px;"><b style="font-size:14px;">阅读笔记</b>' +
            '<textarea id="litNote_' + id + '" rows="4" style="width:100%;margin-top:6px;padding:10px;border:1px solid #ddd;border-radius:8px;" placeholder="记录阅读笔记…">' + esc(item.notes || '') + '</textarea>' +
            '<button type="button" class="btn btn-secondary" style="margin-top:8px;padding:6px 12px;font-size:12px;" onclick="saveLibraryLitNotes(' + id + ')">保存笔记</button></div>' +
            '</div>' +
            '<div>' +
            '<b style="font-size:14px;">引用格式（点击复制）</b>' +
            citeBlock('GB/T 7714', citeGb) +
            citeBlock('APA', citeApa) +
            citeBlock('IEEE', citeIeee) +
            '<div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;">' +
            '<button type="button" class="btn" onclick="addLibraryLitToCompare(' + id + ')">加入对比</button>' +
            '<button type="button" class="btn btn-secondary" onclick="insertLibraryLitToWeekly(' + id + ')">插入周报</button>' +
            '<button type="button" class="btn btn-secondary" onclick="saveLibraryLitToShared(' + id + ')">存到共享文件库</button>' +
            '<button type="button" class="btn btn-secondary" onclick="openLibraryLitInDocAnalysis(' + id + ')">智能解析</button>' +
            (item.paperUrl ? ('<a class="btn btn-secondary" style="padding:8px 14px;text-decoration:none;" href="' + esc(item.paperUrl) + '" target="_blank" rel="noopener">原文链接</a>') : '') +
            '</div>' +
            (related.length ? ('<div style="margin-top:16px;"><b style="font-size:14px;">相关文献</b><ul style="margin:8px 0 0;padding-left:18px;font-size:13px;color:#555;">' +
                related.map(function (r) {
                    return '<li style="margin-bottom:4px;"><a href="javascript:void(0)" onclick="document.getElementById(\'' + modalId + '\').remove();showLibraryLiteratureDetail(' + r.id + ')">' + esc(r.title) + '</a></li>';
                }).join('') + '</ul></div>') : '') +
            '</div></div></div>';
        document.body.appendChild(modal);
        modal.onclick = function (e) { if (e.target === modal) modal.remove(); };
        mountLibraryLitPdfPreview(id, item);
    }

    function mountLibraryLitPdfPreview(id, item) {
        var box = document.getElementById('litPdfPreview_' + id);
        if (!box) return;
        function showUrl(url) {
            box.innerHTML = '<iframe class="lit-pdf-frame" src="' + esc(url) + '#toolbar=1" title="PDF 预览"></iframe>';
        }
        if (item.pdfUrl) {
            showUrl(item.pdfUrl);
            return;
        }
        if (item.sharedFileId && typeof global.getSharedFileBlob === 'function') {
            global.getSharedFileBlob(item.sharedFileId).then(function (blob) {
                if (!blob) {
                    box.innerHTML = '<div style="font-size:12px;color:#888;">暂无本地 PDF，可点击下载或打开原文链接</div>';
                    return;
                }
                var url = URL.createObjectURL(blob);
                showUrl(url);
            }).catch(function () {
                box.innerHTML = '<div style="font-size:12px;color:#888;">PDF 预览不可用</div>';
            });
            return;
        }
        box.innerHTML = '<div style="font-size:12px;color:#888;">暂无 PDF 附件。可上传 PDF 后在此预览。</div>';
    }

    function setLibraryLitReadStatus(id, status) {
        var list = getLiteratureData();
        var idx = list.findIndex(function (l) { return l.id === id; });
        if (idx < 0) return;
        list[idx].readStatus = status || 'unread';
        global.literatureData = list;
        saveLiteratureLibraryData({ log: { action: '阅读状态', desc: list[idx].title + ' → ' + status } });
        renderLiteratureList();
    }

    function citeBlock(label, text) {
        return '<div style="margin-top:8px;padding:10px;background:#f8fafc;border-radius:8px;font-size:12px;line-height:1.6;cursor:pointer;" title="点击复制" onclick="copyLitCite(this)">' +
            '<div style="font-weight:600;color:#7c3aed;margin-bottom:4px;">' + label + '</div>' +
            '<div class="cite-text">' + esc(text) + '</div></div>';
    }

    function copyLitCite(el) {
        var t = el.querySelector('.cite-text');
        var text = t ? t.textContent : '';
        try {
            navigator.clipboard.writeText(text);
            if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已复制引用', false);
            else alert('已复制');
        } catch (e) {
            prompt('复制以下内容：', text);
        }
    }

    function formatCitation(item, style) {
        var authors = item.author || '佚名';
        var year = item.year || 'n.d.';
        var title = item.title || '';
        var journal = item.journal || '';
        var doi = item.doi ? (' https://doi.org/' + item.doi) : '';
        if (style === 'apa') {
            return authors + ' (' + year + '). ' + title + '. ' + journal + '.' + doi;
        }
        if (style === 'ieee') {
            return authors + ', "' + title + '," ' + journal + ', ' + year + '.' + doi;
        }
        // gbt
        return authors + '. ' + title + '[J]. ' + journal + ', ' + year + '.' + doi;
    }

    function getRelatedLiterature(item) {
        var tags = item.tagList || parseTags(item.tags);
        return getLiteratureData().filter(function (l) {
            if (l.id === item.id) return false;
            var lt = l.tagList || parseTags(l.tags);
            if (tags.some(function (t) { return lt.indexOf(t) >= 0; })) return true;
            if (item.author && l.author && item.author.split(/[,，]/)[0].trim() && l.author.indexOf(item.author.split(/[,，]/)[0].trim()) >= 0) return true;
            return false;
        });
    }

    function saveLibraryLitNotes(id) {
        var ta = document.getElementById('litNote_' + id);
        var list = getLiteratureData();
        var idx = list.findIndex(function (l) { return l.id === id; });
        if (idx < 0) return;
        list[idx].notes = ta ? ta.value : '';
        global.literatureData = list;
        saveLiteratureLibraryData({ log: { action: '笔记', desc: '更新文献笔记：' + list[idx].title } });
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('笔记已保存', false);
        else alert('笔记已保存');
    }

    function downloadLibraryLiterature(id) {
        if (!canDownloadPdf()) { alert('访客不可下载'); return; }
        var item = getLiteratureData().find(function (l) { return l.id === id; });
        if (!item) return;
        item.downloadCount = (item.downloadCount || 0) + 1;
        saveLiteratureLibraryData();
        if (item.sharedFileId && typeof global.handleFileDownload === 'function') {
            global.handleFileDownload(item.sharedFileId);
            return;
        }
        if (item.pdfUrl) { window.open(item.pdfUrl, '_blank'); return; }
        if (item.paperUrl) { window.open(item.paperUrl, '_blank'); return; }
        alert('该文献暂无附件或原文链接');
    }

    function deleteLibraryLiterature(id) {
        var item = getLiteratureData().find(function (l) { return l.id === id; });
        if (!item) return;
        if (!canEditLibraryItem(item)) { alert('无权限删除'); return; }
        if (!confirm('确定删除《' + item.title + '》？')) return;
        global.literatureData = getLiteratureData().filter(function (l) { return l.id !== id; });
        delete litState.selected[String(id)];
        saveLiteratureLibraryData({ log: { action: '删除', desc: '删除文献：' + item.title } });
        renderLiteratureList();
    }

    // ========== 全局链接 ==========
    function pushLibraryItemToCompare(item, silent) {
        if (!item) return null;
        try {
            if (!Array.isArray(global.compareLiteratureData)) {
                try {
                    global.compareLiteratureData = JSON.parse(localStorage.getItem('compareLiteratureData') || '[]');
                } catch (e) { global.compareLiteratureData = []; }
            }
            var mapped = {
                title: item.title,
                authors: item.author,
                author: item.author,
                year: item.year,
                venue: item.journal,
                journal: item.journal,
                field: (item.tagList && item.tagList[0]) || '文献资料库',
                summary: item.summary || '',
                keywords: item.tagList || parseTags(item.tags),
                doi: item.doi || '',
                paperUrl: item.paperUrl || '',
                owner: item.uploader || currentOwner(),
                isShared: true,
                group: '文献资料库',
                ext: {}
            };
            var key = String(item.doi || item.title || '').toLowerCase();
            var dup = (global.compareLiteratureData || []).find(function (x) {
                return (item.doi && String(x.doi || '').toLowerCase() === String(item.doi).toLowerCase()) ||
                    String(x.title || '').toLowerCase() === String(item.title || '').toLowerCase();
            });
            if (dup) {
                if (!silent) alert('对比分析中已存在：《' + dup.title + '》');
                return dup;
            }
            var newId = global.compareLiteratureData.length
                ? Math.max.apply(null, global.compareLiteratureData.map(function (l) { return Number(l.id) || 0; })) + 1
                : 1;
            mapped.id = newId;
            if (typeof global.normalizeLitItem === 'function') {
                try { mapped = global.normalizeLitItem(mapped); mapped.id = newId; } catch (e2) {}
            }
            global.compareLiteratureData.unshift(mapped);
            try {
                localStorage.setItem('compareLiteratureData', JSON.stringify(global.compareLiteratureData));
                if (typeof global.cloudUpsert === 'function') global.cloudUpsert('compareLiteratureData', JSON.stringify(global.compareLiteratureData));
            } catch (e3) {}
            item.compareId = newId;
            saveLiteratureLibraryData();
            if (!silent) {
                if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已加入文献对比：《' + item.title + '》', false);
            }
            return mapped;
        } catch (err) {
            console.warn(err);
            if (!silent) alert('加入对比失败');
            return null;
        }
    }

    function addLibraryLitToCompare(id) {
        var item = getLiteratureData().find(function (l) { return l.id === id; });
        if (!item) return;
        var mapped = pushLibraryItemToCompare(item, false);
        if (mapped && confirm('已加入对比库，是否立即打开「文献对比分析」？')) {
            if (typeof global.showModule === 'function') global.showModule('literature_analysis');
        }
    }

    function batchAddLibraryLitToCompare() {
        var ids = getSelectedLitIds();
        if (!ids.length) { alert('请先勾选文献'); return; }
        var n = 0;
        ids.forEach(function (id) {
            var item = getLiteratureData().find(function (l) { return l.id === id; });
            if (item && pushLibraryItemToCompare(item, true)) n++;
        });
        alert('已将 ' + n + ' 篇同步到文献对比（已自动去重）');
        if (n && confirm('是否打开文献对比分析？')) {
            if (typeof global.showModule === 'function') global.showModule('literature_analysis');
        }
    }

    function goLiteratureCompareWithSelection() {
        batchAddLibraryLitToCompare();
    }

    function insertLibraryLitToWeekly(id) {
        var item = getLiteratureData().find(function (l) { return l.id === id; });
        if (!item) return;
        try {
            if (!Array.isArray(global.weeklyReportData)) {
                global.weeklyReportData = JSON.parse(localStorage.getItem('weeklyReportData') || '[]');
            }
        } catch (e) { global.weeklyReportData = global.weeklyReportData || []; }

        var owner = currentOwner();
        var now = new Date();
        var weekKey = now.getFullYear() + '-W' + (Math.ceil((((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7));
        var block = [
            '',
            '【文献调研-' + now.toLocaleDateString('zh-CN') + '】',
            '标题：' + item.title,
            '作者：' + (item.author || '—'),
            '出处：' + (item.journal || '—') + ' (' + (item.year || '—') + ')',
            item.doi ? ('DOI：' + item.doi) : '',
            item.summary ? ('摘要：' + item.summary.slice(0, 300)) : '',
            item.notes ? ('笔记：' + item.notes.slice(0, 300)) : ''
        ].filter(Boolean).join('\n');

        var hit = (global.weeklyReportData || []).find(function (w) {
            return (w.owner === owner || w.author === owner || w.studentName === owner) &&
                (String(w.week || w.weekKey || '').indexOf(String(now.getFullYear())) >= 0 || !w.submitted);
        });
        if (!hit) {
            var newId = global.weeklyReportData.length
                ? Math.max.apply(null, global.weeklyReportData.map(function (w) { return Number(w.id) || 0; })) + 1
                : 1;
            hit = {
                id: newId,
                owner: owner,
                author: owner,
                week: weekKey,
                content: block.trim(),
                status: 'draft',
                createTime: now.toLocaleString('zh-CN')
            };
            global.weeklyReportData.unshift(hit);
        } else {
            hit.content = String(hit.content || '') + '\n' + block;
        }
        try {
            localStorage.setItem('weeklyReportData', JSON.stringify(global.weeklyReportData));
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('weeklyReportData', JSON.stringify(global.weeklyReportData));
        } catch (e2) {}
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已插入本周周报文献调研', false);
        else alert('已插入周报');
        if (confirm('是否打开周报模块查看？')) {
            if (typeof global.showModule === 'function') global.showModule('weekly_report');
        }
    }

    async function saveLibraryLitToShared(id) {
        var item = getLiteratureData().find(function (l) { return l.id === id; });
        if (!item) return;
        if (!Array.isArray(global.sharedFileData)) {
            try { global.sharedFileData = JSON.parse(localStorage.getItem('sharedFileData') || '[]'); } catch (e) { global.sharedFileData = []; }
        }
        var md = '# ' + item.title + '\n\n' +
            '- 作者：' + (item.author || '') + '\n' +
            '- 期刊：' + (item.journal || '') + '\n' +
            '- 年份：' + (item.year || '') + '\n' +
            '- DOI：' + (item.doi || '') + '\n\n' +
            '## 摘要\n\n' + (item.summary || '无') + '\n\n' +
            '## 笔记\n\n' + (item.notes || '无') + '\n';
        var fileName = '文献_' + item.title.slice(0, 40).replace(/[\\/:*?"<>|]/g, '_') + '.md';
        var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        var file = new File([blob], fileName, { type: 'text/markdown' });
        var newId = global.sharedFileData.length
            ? Math.max.apply(null, global.sharedFileData.map(function (f) { return Number(f.id) || 0; })) + 1
            : 1;
        try {
            if (typeof global.saveSharedFileBlob === 'function') await global.saveSharedFileBlob(newId, file);
        } catch (e) { console.warn(e); }
        global.sharedFileData.push({
            id: newId,
            name: fileName,
            size: Math.round(blob.size / 1024) + ' KB',
            fileSizeBytes: blob.size,
            type: 'document',
            uploader: currentOwner(),
            uploaderId: (global.currentUser && global.currentUser.id) || 0,
            uploadTime: new Date().toLocaleDateString('zh-CN'),
            downloadCount: 0
        });
        try {
            localStorage.setItem('sharedFileData', JSON.stringify(global.sharedFileData));
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('sharedFileData', JSON.stringify(global.sharedFileData));
        } catch (e2) {}
        item.sharedFileId = newId;
        saveLiteratureLibraryData({ log: { action: '导出', desc: '文献存入共享文件库：' + item.title } });
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已保存到共享文件库', false);
        else alert('已保存到共享文件库');
    }

    function openLibraryLitInDocAnalysis(id) {
        var item = getLiteratureData().find(function (l) { return l.id === id; });
        if (!item) return;
        if (item.paperUrl || item.pdfUrl) {
            try { sessionStorage.setItem('docAnalysisHintUrl', item.paperUrl || item.pdfUrl); } catch (e) {}
        }
        try {
            sessionStorage.setItem('docAnalysisPrefill', JSON.stringify({
                title: item.title,
                summary: item.summary,
                from: 'literature_library'
            }));
        } catch (e2) {}
        if (typeof global.showModule === 'function') global.showModule('document_analysis');
        if (typeof global.showCloudSyncBanner === 'function') {
            global.showCloudSyncBanner('已跳转文档解析，可上传 PDF 继续提取', false);
        }
    }

    function batchDeleteLibraryLiterature() {
        var ids = getSelectedLitIds();
        if (!ids.length) return;
        var managed = ids.filter(function (id) {
            var item = getLiteratureData().find(function (l) { return l.id === id; });
            return item && canEditLibraryItem(item);
        });
        if (!managed.length) { alert('所选文献均无删除权限'); return; }
        if (!confirm('确定删除选中的 ' + managed.length + ' 篇文献？')) return;
        var set = {};
        managed.forEach(function (id) { set[id] = true; delete litState.selected[String(id)]; });
        global.literatureData = getLiteratureData().filter(function (l) { return !set[l.id]; });
        saveLiteratureLibraryData({ log: { action: '批量删除', desc: '删除 ' + managed.length + ' 篇文献' } });
        renderLiteratureList();
    }

    function batchTagLibraryLiterature() {
        var ids = getSelectedLitIds();
        if (!ids.length) { alert('请先勾选文献'); return; }
        var tag = prompt('为选中文献追加标签（多个用逗号分隔）');
        if (!tag) return;
        var tags = parseTags(tag);
        if (!tags.length) return;
        tags.forEach(function (t) { addCustomLitTag(t); });
        var list = getLiteratureData();
        ids.forEach(function (id) {
            var idx = list.findIndex(function (l) { return l.id === id; });
            if (idx < 0) return;
            var cur = list[idx].tagList || parseTags(list[idx].tags);
            tags.forEach(function (t) { if (cur.indexOf(t) < 0) cur.push(t); });
            list[idx].tagList = cur;
            list[idx].tags = cur.join(', ');
        });
        global.literatureData = list;
        saveLiteratureLibraryData({ log: { action: '批量打标签', desc: tags.join(',') + ' × ' + ids.length } });
        renderLiteratureList();
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已为 ' + ids.length + ' 篇文献添加标签', false);
    }

    function batchMoveLibraryLitToGroup() {
        var ids = getSelectedLitIds();
        if (!ids.length) { alert('请先勾选文献'); return; }
        var groups = loadLiteratureGroups();
        if (!groups.length) {
            var name = prompt('尚无分组，请输入新分组名称');
            if (!name) return;
            var g = createLiteratureGroup(name);
            if (!g) return;
            groups = [g];
        }
        var options = groups.map(function (g, i) { return (i + 1) + '. ' + g.name; }).join('\n');
        var pick = prompt('选择分组序号：\n' + options);
        var gidx = Number(pick) - 1;
        if (!(gidx >= 0 && gidx < groups.length)) { alert('无效选择'); return; }
        var gid = groups[gidx].id;
        var list = getLiteratureData();
        ids.forEach(function (id) {
            var i = list.findIndex(function (l) { return l.id === id; });
            if (i < 0) return;
            var gids = list[i].groupIds || [];
            if (gids.indexOf(gid) < 0) gids.push(gid);
            list[i].groupIds = gids;
        });
        global.literatureData = list;
        saveLiteratureLibraryData({ log: { action: '批量分组', desc: groups[gidx].name + ' × ' + ids.length } });
        litState.groupFilter = gid;
        renderLiteratureList();
    }

    function batchDownloadLibraryLiterature() {
        var ids = getSelectedLitIds();
        if (!ids.length) { alert('请先勾选文献'); return; }
        if (!canDownloadPdf()) { alert('访客不可下载'); return; }
        var n = 0;
        ids.forEach(function (id) {
            var item = getLiteratureData().find(function (l) { return l.id === id; });
            if (!item) return;
            if (item.sharedFileId || item.pdfUrl || item.paperUrl) {
                n++;
                setTimeout(function () { downloadLibraryLiterature(id); }, n * 400);
            }
        });
        if (!n) alert('所选文献均无附件或原文链接');
        else if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('开始下载 ' + n + ' 个附件', false);
    }

    function importFromSharedPdfHint() {
        if (typeof global.showModule === 'function') global.showModule('shared_files');
        if (typeof global.showCloudSyncBanner === 'function') {
            global.showCloudSyncBanner('请在共享文件库下载 PDF 后，回到文献库用 DOI/手动入库；或去「文档智能解析」上传后入库', false);
        }
    }

    function exposeLiteratureGlobals() {
        // 保证外部模块能读到同一份数组引用
        try {
            if (!Array.isArray(global.literatureData)) global.literatureData = [];
        } catch (e) {}
    }

    // 供对比模块 / 文档解析写入资料库时走统一保存
    function upsertLiteratureFromExternal(raw, options) {
        options = options || {};
        var dup = findLibraryDuplicate(raw || {});
        if (dup) {
            if (options.skipIfExists !== false) return dup;
        }
        return persistLibraryItem(raw, { syncCompare: !!options.syncCompare });
    }

    // 导出
    var api = {
        initLiteratureLibrary: initLiteratureLibrary,
        loadLiteratureLibraryData: loadLiteratureLibraryData,
        saveLiteratureLibraryData: saveLiteratureLibraryData,
        renderLiteratureList: renderLiteratureList,
        showLibraryLiteratureModal: showLibraryLiteratureModal,
        showLibraryLiteratureDetail: showLibraryLiteratureDetail,
        deleteLibraryLiterature: deleteLibraryLiterature,
        addLibraryLitToCompare: addLibraryLitToCompare,
        batchAddLibraryLitToCompare: batchAddLibraryLitToCompare,
        goLiteratureCompareWithSelection: goLiteratureCompareWithSelection,
        insertLibraryLitToWeekly: insertLibraryLitToWeekly,
        saveLibraryLitToShared: saveLibraryLitToShared,
        openLibraryLitInDocAnalysis: openLibraryLitInDocAnalysis,
        upsertLiteratureFromExternal: upsertLiteratureFromExternal,
        normalizeLiteratureRecord: normalizeLiteratureRecord,
        mergeIncomingLiteratureData: mergeIncomingLiteratureData,
        setLitStatFilter: setLitStatFilter,
        setLitTypeFilter: setLitTypeFilter,
        setLitTagFilter: setLitTagFilter,
        getLiteratureAllTags: getAllTags,
        addLiteratureCustomTag: addCustomLitTag,
        appendLitTagToInput: appendLitTagToInput,
        promptAddLitTagToInput: promptAddLitTagToInput,
        toggleLitTagAddPanel: toggleLitTagAddPanel,
        confirmAddLitTag: confirmAddLitTag,
        onLitLibraryFilterChange: onLitLibraryFilterChange,
        toggleLitSelect: toggleLitSelect,
        toggleSelectAllLit: toggleSelectAllLit,
        toggleLiteratureFavorite: toggleLiteratureFavorite,
        setLiteraturePage: setLiteraturePage,
        switchLitLibModalTab: switchLitLibModalTab,
        fetchLiteratureByDoi: fetchLiteratureByDoi,
        onLitDoiInputChange: onLitDoiInputChange,
        fillDoiFromHistory: fillDoiFromHistory,
        copyDoiAsBibtex: copyDoiAsBibtex,
        commitLibraryLiterature: commitLibraryLiterature,
        handleLibraryPdfDrop: handleLibraryPdfDrop,
        handleLibraryPdfFileSelect: handleLibraryPdfFileSelect,
        clearPendingLitPdf: clearPendingLitPdf,
        closeLibraryLiteratureModal: closeLibraryLiteratureModal,
        reRecognizeLibraryPdf: reRecognizeLibraryPdf,
        commitLibraryPdfUpload: commitLibraryPdfUpload,
        setBibImportMode: setBibImportMode,
        handleBibTextDrop: handleBibTextDrop,
        handleBibFileDrop: handleBibFileDrop,
        handleBibFileSelect: handleBibFileSelect,
        parseBibtexPreview: parseBibtexPreview,
        toggleBibPreviewItem: toggleBibPreviewItem,
        setAllBibPreviewChecked: setAllBibPreviewChecked,
        confirmBibPreviewImport: confirmBibPreviewImport,
        saveLibraryLitNotes: saveLibraryLitNotes,
        downloadLibraryLiterature: downloadLibraryLiterature,
        copyLitCite: copyLitCite,
        batchDeleteLibraryLiterature: batchDeleteLibraryLiterature,
        batchTagLibraryLiterature: batchTagLibraryLiterature,
        batchMoveLibraryLitToGroup: batchMoveLibraryLitToGroup,
        batchDownloadLibraryLiterature: batchDownloadLibraryLiterature,
        setLibraryLitReadStatus: setLibraryLitReadStatus,
        toggleLitAdvFilter: toggleLitAdvFilter,
        onLitAdvFilterChange: onLitAdvFilterChange,
        setLitGroupFilter: setLitGroupFilter,
        promptCreateLiteratureGroup: promptCreateLiteratureGroup,
        importFromSharedPdfHint: importFromSharedPdfHint
    };

    Object.keys(api).forEach(function (k) { global[k] = api[k]; });
    global.LiteratureLibrary = api;

})(typeof window !== 'undefined' ? window : this);
