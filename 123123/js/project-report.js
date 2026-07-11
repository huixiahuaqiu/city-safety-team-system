/**
 * 项目报告归档 — 结题材料 / 进展报告 / 项目档案联动
 * 数据：localStorage reportData + IndexedDB 附件 + cloudUpsert
 */
(function (global) {
    'use strict';

    var RP_PAGE_SIZE = 12;
    var RP_BLOB_DB = 'reportBlobDB';
    var RP_BLOB_STORE = 'blobs';
    var RP_FAV_KEY = 'reportFavorites';
    var RP_TAG_KEY = 'reportCustomTags';
    var RP_TAG_PRESETS = ['结题', '中期', '安全检查', '可行性', '年度总结', '工地安全'];
    var RP_TYPES = ['项目报告', '可行性报告', '安全报告', '年度报告', '结题报告', '其他'];
    var RP_BLOB_MAX = 80 * 1024 * 1024;

    var rpState = {
        page: 1,
        statFilter: '',
        typeFilter: '',
        tagFilter: '',
        dateFrom: '',
        dateTo: '',
        sort: 'date_desc',
        selected: {},
        favorites: {},
        stylesInjected: false,
        tagAddOpen: false
    };
    var pendingRpFile = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function parseTags(raw) {
        if (Array.isArray(raw)) return raw.map(function (t) { return String(t || '').trim(); }).filter(Boolean);
        return String(raw || '').split(/[,，;；]/).map(function (t) { return t.trim(); }).filter(Boolean);
    }

    function formatBytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function getReportData() {
        if (!Array.isArray(global.reportData)) {
            try { global.reportData = JSON.parse(localStorage.getItem('reportData') || '[]'); }
            catch (e) { global.reportData = []; }
        }
        return global.reportData;
    }

    function saveReportData() {
        var data = getReportData();
        localStorage.setItem('reportData', JSON.stringify(data));
        try {
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('reportData', JSON.stringify(data));
        } catch (e) { /* ignore */ }
        try {
            if (typeof global.syncGlobalsForExternalModules === 'function') global.syncGlobalsForExternalModules();
        } catch (e2) { /* ignore */ }
    }

    function normalizeReport(r) {
        if (!r || typeof r !== 'object') return null;
        var tags = parseTags(r.tags || r.tagList);
        return Object.assign({}, r, {
            id: Number(r.id) || Date.now(),
            name: String(r.name || '未命名报告'),
            type: String(r.type || '项目报告'),
            date: String(r.date || '').slice(0, 10),
            description: String(r.description || ''),
            uploader: r.uploader || '未知',
            tags: tags.join(', '),
            tagList: tags,
            projectKey: r.projectKey || '',
            version: r.version || 'V1.0',
            downloadCount: Number(r.downloadCount) || 0,
            size: r.size || '',
            sizeBytes: Number(r.sizeBytes) || 0,
            format: r.format || '',
            hasLocalBlob: !!r.hasLocalBlob,
            previewText: r.previewText || ''
        });
    }

    function loadFavorites() {
        try { rpState.favorites = JSON.parse(localStorage.getItem(RP_FAV_KEY) || '{}') || {}; }
        catch (e) { rpState.favorites = {}; }
    }

    function saveFavorites() {
        localStorage.setItem(RP_FAV_KEY, JSON.stringify(rpState.favorites || {}));
    }

    function loadCustomTags() {
        try {
            var arr = JSON.parse(localStorage.getItem(RP_TAG_KEY) || '[]');
            return Array.isArray(arr) ? arr.map(function (t) { return String(t).trim(); }).filter(Boolean) : [];
        } catch (e) { return []; }
    }

    function saveCustomTags(tags) {
        var seen = {};
        var clean = (tags || []).map(function (t) { return String(t || '').trim(); }).filter(function (t) {
            if (!t || seen[t]) return false;
            seen[t] = true;
            return true;
        });
        localStorage.setItem(RP_TAG_KEY, JSON.stringify(clean));
    }

    function getAllRpTags() {
        var map = {};
        var order = [];
        function add(t) {
            t = String(t || '').trim();
            if (!t || map[t]) return;
            map[t] = true;
            order.push(t);
        }
        RP_TAG_PRESETS.forEach(add);
        loadCustomTags().forEach(add);
        getReportData().forEach(function (r) {
            (r.tagList || parseTags(r.tags)).forEach(add);
        });
        return order;
    }

    function addCustomRpTag(name) {
        name = String(name || '').trim();
        if (!name) { alert('请输入标签'); return ''; }
        if (getAllRpTags().indexOf(name) >= 0) return name;
        var custom = loadCustomTags();
        custom.push(name);
        saveCustomTags(custom);
        return name;
    }

    function seedIfEmpty() {
        var data = getReportData();
        if (data.length) {
            global.reportData = data.map(normalizeReport).filter(Boolean);
            saveReportData();
            return;
        }
        global.reportData = [
            normalizeReport({
                id: 1, name: '2026年上半年项目进展报告', type: '项目报告', date: '2026-07-01',
                uploader: '张三', description: '总结上半年项目进展情况', tags: '中期,工地安全', downloadCount: 8
            }),
            normalizeReport({
                id: 2, name: '城市安全数智创新平台可行性研究报告', type: '可行性报告', date: '2026-06-15',
                uploader: '李四', description: '项目可行性分析', tags: '可行性', downloadCount: 12
            }),
            normalizeReport({
                id: 3, name: '年度安全检查报告', type: '安全报告', date: '2026-06-01',
                uploader: '王五', description: '实验室年度安全检查总结', tags: '安全检查,年度总结', downloadCount: 5
            })
        ];
        saveReportData();
    }

    function openRpDB() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(RP_BLOB_DB, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(RP_BLOB_STORE)) db.createObjectStore(RP_BLOB_STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbPut(key, value) {
        return openRpDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(RP_BLOB_STORE, 'readwrite');
                tx.objectStore(RP_BLOB_STORE).put(value, String(key));
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function idbGet(key) {
        return openRpDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(RP_BLOB_STORE, 'readonly');
                var req = tx.objectStore(RP_BLOB_STORE).get(String(key));
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function idbDel(key) {
        return openRpDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(RP_BLOB_STORE, 'readwrite');
                tx.objectStore(RP_BLOB_STORE).delete(String(key));
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function collectProjectOptions() {
        var opts = [];
        [['longitudinalData', '纵向'], ['horizontalData', '横向'], ['schoolData', '校级']].forEach(function (pair) {
            var arr = global[pair[0]];
            if (!Array.isArray(arr)) {
                try { arr = JSON.parse(localStorage.getItem(pair[0]) || '[]'); } catch (e) { arr = []; }
            }
            (arr || []).forEach(function (p) {
                var name = p.name || p.title || p.projectName || ('项目' + p.id);
                opts.push({ value: pair[0] + ':' + p.id, label: '[' + pair[1] + '] ' + name });
            });
        });
        return opts;
    }

    function projectLabel(key) {
        if (!key) return '—';
        var hit = collectProjectOptions().find(function (o) { return o.value === key; });
        return hit ? hit.label : key;
    }

    async function extractTextPreview(file) {
        var name = (file.name || '').toLowerCase();
        if (/\.(txt|md|csv|json|log)$/.test(name)) {
            var text = await file.text();
            return text.slice(0, 4000);
        }
        return '';
    }

    function getFilteredReports() {
        var q = String((document.getElementById('reportSearchInput') || {}).value || '').trim().toLowerCase();
        var list = getReportData().slice().map(normalizeReport);
        var yearNow = String(new Date().getFullYear());

        if (rpState.statFilter === 'year') {
            list = list.filter(function (r) { return String(r.date || '').indexOf(yearNow) === 0; });
        } else if (rpState.statFilter === 'project') {
            list = list.filter(function (r) { return !!r.projectKey; });
        } else if (rpState.statFilter === 'fav') {
            list = list.filter(function (r) { return !!rpState.favorites[String(r.id)]; });
        }

        if (rpState.typeFilter) list = list.filter(function (r) { return r.type === rpState.typeFilter; });
        if (rpState.tagFilter) {
            list = list.filter(function (r) {
                return (r.tagList || []).indexOf(rpState.tagFilter) >= 0;
            });
        }
        if (rpState.dateFrom) list = list.filter(function (r) { return String(r.date || '') >= rpState.dateFrom; });
        if (rpState.dateTo) list = list.filter(function (r) { return String(r.date || '') <= rpState.dateTo; });

        if (q) {
            list = list.filter(function (r) {
                var blob = [r.name, r.description, r.uploader, r.tags, r.type].join(' ').toLowerCase();
                return blob.indexOf(q) >= 0;
            });
        }

        var sort = rpState.sort || 'date_desc';
        list.sort(function (a, b) {
            if (sort === 'date_asc') return String(a.date).localeCompare(String(b.date));
            if (sort === 'name_asc') return String(a.name).localeCompare(String(b.name), 'zh-CN');
            if (sort === 'dl_desc') return (b.downloadCount || 0) - (a.downloadCount || 0);
            return String(b.date).localeCompare(String(a.date));
        });
        return list;
    }

    function updateStats() {
        var all = getReportData().map(normalizeReport);
        var yearNow = String(new Date().getFullYear());
        var el = function (id, v) { var n = document.getElementById(id); if (n) n.textContent = v; };
        el('rpStatTotal', String(all.length));
        el('rpStatYear', String(all.filter(function (r) { return String(r.date || '').indexOf(yearNow) === 0; }).length));
        el('rpStatProject', String(all.filter(function (r) { return !!r.projectKey; }).length));
        el('rpStatFav', String(all.filter(function (r) { return !!rpState.favorites[String(r.id)]; }).length));
        document.querySelectorAll('.rp-stat-card').forEach(function (card) {
            card.classList.toggle('active', (card.getAttribute('data-filter') || '') === (rpState.statFilter || ''));
        });
    }

    function renderTagBar() {
        var box = document.getElementById('rpTagFilterBar');
        if (!box) return;
        var tags = getAllRpTags().slice(0, 16);
        var html = '<button type="button" class="rp-tag-chip' + (!rpState.tagFilter ? ' active' : '') + '" onclick="setRpTagFilter(\'\')">全部</button>';
        html += tags.map(function (t) {
            return '<button type="button" class="rp-tag-chip' + (rpState.tagFilter === t ? ' active' : '') + '" onclick="setRpTagFilter(' + JSON.stringify(t) + ')">' + esc(t) + '</button>';
        }).join('');
        html += '<button type="button" class="rp-tag-chip rp-tag-add" onclick="toggleRpTagAddPanel()">+ 添加</button>';
        html += '<span id="rpTagAddPanel" class="rp-tag-add-panel" style="display:' + (rpState.tagAddOpen ? 'inline-flex' : 'none') + ';">' +
            '<input id="rpTagAddInput" type="text" placeholder="新标签" onkeydown="if(event.key===\'Enter\'){event.preventDefault();confirmAddRpTag();}">' +
            '<button type="button" class="rp-tag-add-ok" onclick="confirmAddRpTag()">确定</button>' +
            '<button type="button" class="rp-tag-add-cancel" onclick="toggleRpTagAddPanel(false)">×</button></span>';
        box.innerHTML = html;
    }

    function updateBatchBar() {
        var bar = document.getElementById('rpBatchBar');
        var countEl = document.getElementById('rpBatchCount');
        var n = Object.keys(rpState.selected).filter(function (k) { return rpState.selected[k]; }).length;
        if (bar) bar.style.display = n ? 'flex' : 'none';
        if (countEl) countEl.textContent = String(n);
    }

    function renderReportList() {
        var container = document.getElementById('reportList');
        var emptyState = document.getElementById('reportEmptyState');
        if (!container || !emptyState) return;
        injectStyles();
        updateStats();
        renderTagBar();

        var filtered = getFilteredReports();
        var totalPages = Math.max(1, Math.ceil(filtered.length / RP_PAGE_SIZE));
        if (rpState.page > totalPages) rpState.page = totalPages;
        var start = (rpState.page - 1) * RP_PAGE_SIZE;
        var pageItems = filtered.slice(start, start + RP_PAGE_SIZE);

        if (!filtered.length) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            updateBatchBar();
            renderPagination(0, 1);
            return;
        }
        emptyState.style.display = 'none';
        container.innerHTML = pageItems.map(renderCard).join('');
        renderPagination(filtered.length, totalPages);
        updateBatchBar();
    }

    function renderPagination(total, totalPages) {
        var box = document.getElementById('reportPagination');
        if (!box) return;
        if (totalPages <= 1) { box.innerHTML = ''; return; }
        var html = '<span style="font-size:12px;color:#888;">共 ' + total + ' 条</span>';
        for (var i = 1; i <= totalPages; i++) {
            html += '<button type="button" class="rp-page-btn' + (i === rpState.page ? ' active' : '') + '" onclick="setReportPage(' + i + ')">' + i + '</button>';
        }
        box.innerHTML = html;
    }

    function renderCard(r) {
        var fav = !!rpState.favorites[String(r.id)];
        var checked = !!rpState.selected[String(r.id)];
        var tags = (r.tagList || []).map(function (t) {
            return '<span class="rp-mini-tag">' + esc(t) + '</span>';
        }).join('');
        return (
            '<div class="rp-card' + (checked ? ' selected' : '') + '">' +
            '<div class="rp-card-main">' +
            '<label class="rp-check"><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleRpSelect(' + r.id + ', this.checked)"></label>' +
            '<button type="button" class="rp-fav-btn' + (fav ? ' on' : '') + '" onclick="toggleReportFavorite(' + r.id + ')">' + (fav ? '★' : '☆') + '</button>' +
            '<div class="rp-body">' +
            '<div class="rp-title-row">' +
            '<a href="javascript:void(0)" class="rp-title" onclick="showReportDetail(' + r.id + ')">' + esc(r.name) + '</a>' +
            '<span class="rp-type-badge">' + esc(r.type) + '</span>' +
            (r.hasLocalBlob ? '<span class="rp-file-badge">有附件</span>' : '') +
            '</div>' +
            '<p class="rp-desc">' + esc(r.description || '暂无描述') + '</p>' +
            '<div class="rp-tags">' + tags + '</div>' +
            '<div class="rp-foot">上传者：' + esc(r.uploader) + ' | ' + esc(r.date) +
            (r.projectKey ? (' | 项目：' + esc(projectLabel(r.projectKey))) : '') +
            ' | 下载 ' + (r.downloadCount || 0) + ' 次</div>' +
            '</div></div>' +
            '<div class="rp-actions">' +
            '<button type="button" class="btn btn-secondary rp-act" onclick="showReportDetail(' + r.id + ')">详情</button>' +
            '<button type="button" class="btn btn-secondary rp-act" onclick="previewReport(' + r.id + ')">预览</button>' +
            '<button type="button" class="btn rp-act" onclick="downloadReport(' + r.id + ')">下载</button>' +
            '<button type="button" class="btn btn-secondary rp-act" style="color:#dc2626;" onclick="deleteReport(' + r.id + ')">删除</button>' +
            '</div></div>'
        );
    }

    function setRpStatFilter(v) {
        rpState.statFilter = v || '';
        rpState.page = 1;
        renderReportList();
    }

    function setRpTagFilter(tag) {
        rpState.tagFilter = (rpState.tagFilter === tag) ? '' : (tag || '');
        rpState.page = 1;
        renderReportList();
    }

    function onReportFilterChange() {
        rpState.typeFilter = (document.getElementById('rpTypeFilter') || {}).value || '';
        rpState.sort = (document.getElementById('rpSort') || {}).value || 'date_desc';
        rpState.dateFrom = (document.getElementById('rpDateFrom') || {}).value || '';
        rpState.dateTo = (document.getElementById('rpDateTo') || {}).value || '';
        rpState.page = 1;
        renderReportList();
    }

    function onReportSearchInput() {
        rpState.page = 1;
        renderReportList();
    }

    function setReportPage(p) {
        rpState.page = p;
        renderReportList();
    }

    function toggleRpSelect(id, checked) {
        if (checked) rpState.selected[String(id)] = true;
        else delete rpState.selected[String(id)];
        updateBatchBar();
    }

    function toggleReportFavorite(id) {
        var k = String(id);
        if (rpState.favorites[k]) delete rpState.favorites[k];
        else rpState.favorites[k] = true;
        saveFavorites();
        renderReportList();
    }

    function toggleRpTagAddPanel(force) {
        rpState.tagAddOpen = typeof force === 'boolean' ? force : !rpState.tagAddOpen;
        renderTagBar();
        if (rpState.tagAddOpen) {
            var inp = document.getElementById('rpTagAddInput');
            if (inp) inp.focus();
        }
    }

    function confirmAddRpTag() {
        var input = document.getElementById('rpTagAddInput');
        var tag = addCustomRpTag(input ? input.value : '');
        if (!tag) return;
        rpState.tagAddOpen = false;
        rpState.tagFilter = tag;
        renderReportList();
    }

    function getSelectedIds() {
        return Object.keys(rpState.selected).filter(function (k) { return rpState.selected[k]; }).map(Number);
    }

    function batchDeleteReports() {
        var ids = getSelectedIds();
        if (!ids.length) return;
        if (!confirm('确定删除选中的 ' + ids.length + ' 份报告？')) return;
        global.reportData = getReportData().filter(function (r) { return ids.indexOf(Number(r.id)) < 0; });
        ids.forEach(function (id) {
            idbDel(id).catch(function () {});
            delete rpState.selected[String(id)];
        });
        saveReportData();
        renderReportList();
    }

    function batchTagReports() {
        var ids = getSelectedIds();
        if (!ids.length) return;
        var tag = prompt('为选中报告追加标签：');
        if (!tag) return;
        tag = addCustomRpTag(tag) || String(tag).trim();
        getReportData().forEach(function (r) {
            if (ids.indexOf(Number(r.id)) < 0) return;
            var tags = parseTags(r.tags);
            if (tags.indexOf(tag) < 0) tags.push(tag);
            r.tags = tags.join(', ');
            r.tagList = tags;
        });
        saveReportData();
        renderReportList();
    }

    function batchLinkReportProject() {
        var ids = getSelectedIds();
        if (!ids.length) return;
        var opts = collectProjectOptions();
        if (!opts.length) { alert('暂无可用项目'); return; }
        var names = opts.map(function (o, i) { return (i + 1) + '. ' + o.label; }).join('\n');
        var pick = prompt('输入序号关联项目：\n' + names);
        var idx = Number(pick) - 1;
        if (!(idx >= 0 && idx < opts.length)) return;
        getReportData().forEach(function (r) {
            if (ids.indexOf(Number(r.id)) >= 0) r.projectKey = opts[idx].value;
        });
        saveReportData();
        alert('已关联：' + opts[idx].label);
        renderReportList();
    }

    function findReport(id) {
        return getReportData().map(normalizeReport).find(function (r) { return Number(r.id) === Number(id); });
    }

    function tagsFieldHtml(id, ph) {
        var tags = getAllRpTags();
        var chips = tags.slice(0, 14).map(function (t) {
            return '<button type="button" class="rp-tag-quick" onclick="appendRpTagToInput(' + JSON.stringify(id) + ',' + JSON.stringify(t) + ')">' + esc(t) + '</button>';
        }).join('');
        return '<div><input type="text" list="' + id + '_dl" id="' + id + '" class="rp-input" placeholder="' + esc(ph || '') + '">' +
            '<datalist id="' + id + '_dl">' + tags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
            '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">' + chips +
            '<button type="button" class="rp-tag-quick rp-tag-quick-add" onclick="promptAddRpTagToInput(' + JSON.stringify(id) + ')">+ 新建</button></div></div>';
    }

    function appendRpTagToInput(inputId, tag) {
        var el = document.getElementById(inputId);
        if (!el || !tag) return;
        var cur = parseTags(el.value);
        if (cur.indexOf(tag) < 0) cur.push(tag);
        el.value = cur.join(', ');
    }

    function promptAddRpTagToInput(inputId) {
        var name = prompt('输入新标签：');
        if (!name) return;
        var tag = addCustomRpTag(name);
        if (tag) appendRpTagToInput(inputId, tag);
    }

    function showAddReportModal() {
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客不可上传报告');
            return;
        }
        pendingRpFile = null;
        var modalId = 'rpModal_' + Date.now();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'rp-modal-mask';
        var typeOpts = RP_TYPES.map(function (t) {
            return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
        }).join('');
        var projectOpts = collectProjectOptions().map(function (o) {
            return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
        }).join('');
        var today = new Date().toISOString().slice(0, 10);

        modal.innerHTML =
            '<div class="rp-modal">' +
            '<div class="rp-modal-hd"><h3>上传报告</h3><button type="button" class="rp-modal-x" onclick="document.getElementById(\'' + modalId + '\').remove()">×</button></div>' +
            '<div class="rp-modal-bd">' +
            '<div class="rp-sec">① 报告文件（可选）</div>' +
            '<div class="rp-drop" id="' + modalId + '_drop" onclick="document.getElementById(\'' + modalId + '_file\').click()" ' +
            'ondragover="event.preventDefault();this.classList.add(\'drag\')" ondragleave="this.classList.remove(\'drag\')" ' +
            'ondrop="event.preventDefault();this.classList.remove(\'drag\');handleReportDrop(event,\'' + modalId + '\')">' +
            '<div style="font-size:36px;margin-bottom:6px;">📄</div>' +
            '<div style="font-weight:600;">拖拽报告到此处，或点击选择</div>' +
            '<div style="font-size:12px;color:#888;margin-top:4px;">支持 PDF / Word / TXT / MD，单文件建议 ≤80MB</div></div>' +
            '<input type="file" id="' + modalId + '_file" accept=".pdf,.doc,.docx,.txt,.md,.pptx,.ppt" style="display:none" onchange="handleReportFileSelect(this,\'' + modalId + '\')">' +
            '<div id="' + modalId + '_preview" style="display:none;margin-top:8px;"></div>' +
            '<div class="rp-sec">② 基础信息</div>' +
            '<div style="margin-bottom:12px;"><label class="rp-label">报告名称 *</label><input id="rpName" class="rp-input" placeholder="可从文件名自动填充"></div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div><label class="rp-label">类型</label><select id="rpType" class="rp-input">' + typeOpts + '</select></div>' +
            '<div><label class="rp-label">日期</label><input type="date" id="rpDate" class="rp-input" value="' + today + '"></div></div>' +
            '<div style="margin:12px 0;"><label class="rp-label">描述</label><textarea id="rpDesc" rows="3" class="rp-input" placeholder="报告摘要、适用范围"></textarea></div>' +
            '<div style="margin-bottom:12px;"><label class="rp-label">标签</label>' + tagsFieldHtml('rpTags', '结题, 中期') + '</div>' +
            '<div class="rp-sec">③ 关联设置</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div><label class="rp-label">关联科研项目</label><select id="rpProject" class="rp-input"><option value="">不关联</option>' + projectOpts + '</select></div>' +
            '<div><label class="rp-label">版本号</label><input id="rpVersion" class="rp-input" value="V1.0"></div></div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:12px;"><input type="checkbox" id="rpToShared"> 同时存入团队共享文件库（报告分类）</label>' +
            '</div>' +
            '<div class="rp-modal-ft">' +
            '<button type="button" class="btn btn-secondary" onclick="document.getElementById(\'' + modalId + '\').remove()">取消</button>' +
            '<button type="button" class="btn" id="' + modalId + '_submit" onclick="commitReportUpload(\'' + modalId + '\')">保存入库</button>' +
            '</div></div>';
        document.body.appendChild(modal);
    }

    function handleReportFileSelect(input, modalId) {
        var file = input && input.files && input.files[0];
        if (!file) return;
        onReportFileChosen(file, modalId);
    }

    function handleReportDrop(event, modalId) {
        var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (!file) return;
        onReportFileChosen(file, modalId);
    }

    async function onReportFileChosen(file, modalId) {
        if (file.size > RP_BLOB_MAX) {
            if (!confirm('文件超过 80MB，仅保存元数据，不缓存附件。继续？')) return;
        }
        pendingRpFile = file;
        var preview = document.getElementById(modalId + '_preview');
        if (preview) {
            preview.style.display = 'block';
            preview.innerHTML = '<div class="rp-file-chip"><span>📄 ' + esc(file.name) + '</span><span>' + formatBytes(file.size) + '</span></div>';
        }
        var nameEl = document.getElementById('rpName');
        if (nameEl && !nameEl.value) nameEl.value = file.name.replace(/\.[^.]+$/, '');
        var text = await extractTextPreview(file);
        if (text) {
            var desc = document.getElementById('rpDesc');
            if (desc && !desc.value) desc.value = text.slice(0, 200).replace(/\s+/g, ' ');
            pendingRpFile.__previewText = text;
        }
    }

    async function commitReportUpload(modalId) {
        var name = String((document.getElementById('rpName') || {}).value || '').trim();
        if (!name) { alert('请输入报告名称'); return; }
        var btn = document.getElementById(modalId + '_submit');
        if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

        try {
            var newId = getReportData().reduce(function (m, r) { return Math.max(m, Number(r.id) || 0); }, 0) + 1;
            var tags = parseTags((document.getElementById('rpTags') || {}).value);
            var record = normalizeReport({
                id: newId,
                name: name,
                type: (document.getElementById('rpType') || {}).value || '项目报告',
                date: (document.getElementById('rpDate') || {}).value || new Date().toISOString().slice(0, 10),
                description: (document.getElementById('rpDesc') || {}).value || '',
                tags: tags.join(', '),
                tagList: tags,
                projectKey: (document.getElementById('rpProject') || {}).value || '',
                version: (document.getElementById('rpVersion') || {}).value || 'V1.0',
                uploader: (global.currentUser && (global.currentUser.realName || global.currentUser.username)) || '未知',
                downloadCount: 0,
                size: pendingRpFile ? formatBytes(pendingRpFile.size) : '',
                sizeBytes: pendingRpFile ? pendingRpFile.size : 0,
                format: pendingRpFile ? (pendingRpFile.name.split('.').pop() || '').toUpperCase() : '',
                previewText: (pendingRpFile && pendingRpFile.__previewText) || '',
                hasLocalBlob: false
            });

            if (pendingRpFile && pendingRpFile.size <= RP_BLOB_MAX) {
                await idbPut(newId, pendingRpFile);
                record.hasLocalBlob = true;
            }

            getReportData().push(record);
            saveReportData();

            if ((document.getElementById('rpToShared') || {}).checked && pendingRpFile && typeof global.saveSharedFileBlob === 'function') {
                try {
                    var shared = Array.isArray(global.sharedFileData) ? global.sharedFileData : JSON.parse(localStorage.getItem('sharedFileData') || '[]');
                    var sid = shared.reduce(function (m, f) { return Math.max(m, Number(f.id) || 0); }, 0) + 1;
                    shared.push({
                        id: sid,
                        name: pendingRpFile.name,
                        size: formatBytes(pendingRpFile.size),
                        fileSizeBytes: pendingRpFile.size,
                        type: 'report',
                        uploader: record.uploader,
                        uploaderId: (global.currentUser && global.currentUser.id) || 0,
                        uploadTime: record.date,
                        downloadCount: 0,
                        remark: '来自项目报告：' + name
                    });
                    global.sharedFileData = shared;
                    localStorage.setItem('sharedFileData', JSON.stringify(shared));
                    await global.saveSharedFileBlob(sid, pendingRpFile);
                    if (typeof global.cloudUpsert === 'function') global.cloudUpsert('sharedFileData', JSON.stringify(shared));
                } catch (eShare) { console.warn(eShare); }
            }

            var m = document.getElementById(modalId);
            if (m) m.remove();
            renderReportList();
            alert('报告已入库');
            showReportDetail(newId);
        } catch (e) {
            alert('保存失败：' + (e && e.message ? e.message : e));
            if (btn) { btn.disabled = false; btn.textContent = '保存入库'; }
        }
    }

    function showReportDetail(id) {
        var item = findReport(id);
        if (!item) { alert('报告不存在'); return; }
        var modalId = 'rpDetail_' + Date.now();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'rp-modal-mask';
        var tags = (item.tagList || []).map(function (t) {
            return '<span class="rp-mini-tag">' + esc(t) + '</span>';
        }).join('') || '—';
        var preview = item.previewText
            ? ('<pre class="rp-preview-pre">' + esc(item.previewText.slice(0, 3000)) + '</pre>')
            : '<div style="color:#9ca3af;font-size:13px;">暂无文本预览。上传 TXT/MD 可自动提取；PDF 请下载后查看。</div>';

        modal.innerHTML =
            '<div class="rp-modal rp-modal-lg">' +
            '<div class="rp-modal-hd"><h3>报告详情</h3><button type="button" class="rp-modal-x" onclick="document.getElementById(\'' + modalId + '\').remove()">×</button></div>' +
            '<div class="rp-modal-bd">' +
            '<div class="rp-title-row"><span class="rp-title" style="font-size:20px;">' + esc(item.name) + '</span>' +
            '<span class="rp-type-badge">' + esc(item.type) + '</span></div>' +
            '<p style="margin:10px 0;color:#4b5563;line-height:1.6;">' + esc(item.description || '暂无描述') + '</p>' +
            '<div class="rp-foot">上传者：' + esc(item.uploader) + ' | ' + esc(item.date) +
            ' | 版本 ' + esc(item.version) +
            (item.size ? (' | ' + esc(item.size)) : '') +
            (item.format ? (' | ' + esc(item.format)) : '') +
            ' | 下载 ' + (item.downloadCount || 0) + ' 次</div>' +
            '<div class="rp-tags" style="margin-top:10px;">' + tags + '</div>' +
            '<div class="rp-detail-sec"><h4>关联项目</h4><div>' + esc(projectLabel(item.projectKey)) + '</div></div>' +
            '<div class="rp-detail-sec"><h4>内容预览</h4>' + preview + '</div>' +
            '</div>' +
            '<div class="rp-modal-ft">' +
            '<button type="button" class="btn btn-secondary" onclick="copyReportCitation(' + item.id + ')">复制引用</button>' +
            '<button type="button" class="btn btn-secondary" onclick="previewReport(' + item.id + ')">预览附件</button>' +
            '<button type="button" class="btn" onclick="downloadReport(' + item.id + ')">下载</button>' +
            '</div></div>';
        document.body.appendChild(modal);
    }

    async function previewReport(id) {
        var item = findReport(id);
        if (!item) return;
        if (item.previewText) {
            showReportDetail(id);
            return;
        }
        try {
            var blob = await idbGet(id);
            if (!blob) {
                alert('无附件可预览');
                return;
            }
            var url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        } catch (e) {
            alert('预览失败');
        }
    }

    async function downloadReport(id) {
        var item = findReport(id);
        if (!item) return;
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客无下载权限');
            return;
        }
        var raw = getReportData().find(function (r) { return Number(r.id) === Number(id); });
        if (raw) {
            raw.downloadCount = (Number(raw.downloadCount) || 0) + 1;
            saveReportData();
        }
        try {
            var blob = await idbGet(id);
            if (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = item.name + (item.format ? ('.' + String(item.format).toLowerCase()) : '');
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
                renderReportList();
                return;
            }
        } catch (e) { /* fallthrough */ }

        // 无附件时导出元数据文本
        var text = [
            '报告名称：' + item.name,
            '类型：' + item.type,
            '日期：' + item.date,
            '上传者：' + item.uploader,
            '版本：' + item.version,
            '关联项目：' + projectLabel(item.projectKey),
            '标签：' + (item.tags || ''),
            '',
            item.description || ''
        ].join('\n');
        var metaBlob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        var metaUrl = URL.createObjectURL(metaBlob);
        var a2 = document.createElement('a');
        a2.href = metaUrl;
        a2.download = item.name + '_元数据.txt';
        document.body.appendChild(a2);
        a2.click();
        a2.remove();
        URL.revokeObjectURL(metaUrl);
        renderReportList();
    }

    function deleteReport(id) {
        if (!confirm('确定要删除该报告吗？')) return;
        global.reportData = getReportData().filter(function (r) { return Number(r.id) !== Number(id); });
        idbDel(id).catch(function () {});
        delete rpState.selected[String(id)];
        saveReportData();
        renderReportList();
    }

    function copyReportCitation(id) {
        var item = findReport(id);
        if (!item) return;
        var year = String(item.date || '').slice(0, 4) || new Date().getFullYear();
        var cite = item.uploader + '. ' + item.name + '[R]. ' + year +
            '. 城市安全数智创新团队项目报告归档, 版本 ' + (item.version || 'V1.0') + '.';
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cite).then(function () { alert('已复制引用：\n' + cite); });
        } else {
            prompt('复制引用：', cite);
        }
    }

    function injectStyles() {
        if (rpState.stylesInjected) return;
        rpState.stylesInjected = true;
        var style = document.createElement('style');
        style.id = 'projectReportStyles';
        style.textContent = [
            '.rp-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px;}',
            '.rp-stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;cursor:pointer;}',
            '.rp-stat-card:hover,.rp-stat-card.active{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.12);}',
            '.rp-stat-card .n{font-size:20px;font-weight:700;color:#111827;}',
            '.rp-stat-card .l{font-size:12px;color:#6b7280;margin-top:4px;}',
            '.rp-filter-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;}',
            '.rp-filter-row select,.rp-filter-row input{padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;}',
            '.rp-tag-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}',
            '.rp-tag-chip{padding:4px 10px;border:1px solid #e5e7eb;background:#fff;border-radius:999px;font-size:12px;color:#4b5563;cursor:pointer;}',
            '.rp-tag-chip.active{background:#ede9fe;border-color:#7c3aed;color:#5b21b6;}',
            '.rp-tag-chip.rp-tag-add{border-style:dashed;color:#7c3aed;border-color:#c4b5fd;background:#faf8ff;}',
            '.rp-tag-add-panel{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border:1px dashed #c4b5fd;border-radius:999px;background:#faf8ff;}',
            '.rp-tag-add-panel input{width:96px;padding:4px 8px;border:1px solid #ddd;border-radius:999px;font-size:12px;}',
            '.rp-tag-add-ok{border:none;background:#7c3aed;color:#fff;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;}',
            '.rp-tag-add-cancel{border:none;background:#f3f4f6;color:#6b7280;border-radius:999px;padding:4px 8px;cursor:pointer;}',
            '.rp-batch-bar{display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;margin-top:12px;}',
            '.rp-card{background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:12px;border:1px solid #f0f0f0;box-shadow:0 1px 3px rgba(0,0,0,.04);}',
            '.rp-card.selected{border-color:#a78bfa;background:#faf8ff;}',
            '.rp-card-main{display:flex;gap:10px;align-items:flex-start;}',
            '.rp-body{flex:1;min-width:0;}',
            '.rp-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
            '.rp-title{font-size:16px;font-weight:700;color:#111827;text-decoration:none;}',
            '.rp-title:hover{color:#7c3aed;}',
            '.rp-type-badge{font-size:11px;padding:2px 8px;border-radius:4px;background:#f6ffed;color:#389e0d;}',
            '.rp-file-badge{font-size:11px;padding:2px 6px;border-radius:4px;background:#e0f2fe;color:#0369a1;}',
            '.rp-desc{font-size:14px;color:#6b7280;margin:8px 0;line-height:1.5;}',
            '.rp-tags{display:flex;flex-wrap:wrap;gap:6px;}',
            '.rp-mini-tag{padding:2px 8px;background:#f0f5ff;color:#1890ff;border-radius:4px;font-size:12px;}',
            '.rp-foot{font-size:12px;color:#9ca3af;margin-top:8px;}',
            '.rp-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;justify-content:flex-end;}',
            '.rp-act{padding:4px 10px !important;font-size:12px !important;}',
            '.rp-fav-btn{border:none;background:transparent;font-size:18px;cursor:pointer;color:#d1d5db;}',
            '.rp-fav-btn.on{color:#f59e0b;}',
            '.rp-pagination{display:flex;gap:6px;align-items:center;justify-content:center;margin-top:16px;flex-wrap:wrap;}',
            '.rp-page-btn{border:1px solid #e5e7eb;background:#fff;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;}',
            '.rp-page-btn.active{background:#7c3aed;color:#fff;border-color:#7c3aed;}',
            '.rp-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2200;display:flex;justify-content:center;align-items:center;padding:16px;}',
            '.rp-modal{background:#fff;border-radius:12px;width:100%;max-width:640px;max-height:92vh;overflow:auto;}',
            '.rp-modal-lg{max-width:820px;}',
            '.rp-modal-hd{padding:16px 20px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;}',
            '.rp-modal-hd h3{margin:0;font-size:18px;}',
            '.rp-modal-x{width:32px;height:32px;border:none;background:#f5f5f5;border-radius:50%;cursor:pointer;}',
            '.rp-modal-bd{padding:16px 20px;}',
            '.rp-modal-ft{padding:14px 20px;background:#f9fafb;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:10px;}',
            '.rp-sec{font-size:14px;font-weight:700;color:#5b21b6;margin:14px 0 10px;padding-bottom:6px;border-bottom:1px dashed #ede9fe;}',
            '.rp-sec:first-child{margin-top:0;}',
            '.rp-label{display:block;margin-bottom:5px;font-size:13px;color:#374151;}',
            '.rp-input{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;}',
            '.rp-drop{border:2px dashed #ddd;border-radius:10px;padding:24px;text-align:center;cursor:pointer;}',
            '.rp-drop.drag{border-color:#7c3aed;background:#faf8ff;}',
            '.rp-file-chip{display:flex;justify-content:space-between;gap:8px;background:#f5f5f5;padding:10px 12px;border-radius:8px;font-size:13px;}',
            '.rp-tag-quick{padding:2px 8px;border:1px solid #e5e7eb;background:#f9fafb;border-radius:999px;font-size:11px;cursor:pointer;}',
            '.rp-tag-quick-add{border-style:dashed;color:#7c3aed;}',
            '.rp-detail-sec{margin-top:16px;padding-top:12px;border-top:1px solid #f3f4f6;}',
            '.rp-detail-sec h4{margin:0 0 8px;font-size:14px;}',
            '.rp-preview-pre{padding:12px;background:#0f172a;color:#e2e8f0;border-radius:8px;font-size:12px;max-height:280px;overflow:auto;white-space:pre-wrap;}',
            '@media (max-width:900px){.rp-stat-grid{grid-template-columns:repeat(2,1fr);}}'
        ].join('');
        document.head.appendChild(style);
    }

    function initProjectReport() {
        loadFavorites();
        seedIfEmpty();
        injectStyles();
        var btn = document.getElementById('rpLibraryUploadBtn');
        if (btn && global.currentUser && global.currentUser.role === 'visitor') btn.style.display = 'none';
        renderReportList();
    }

    function loadProjectReportData() {
        seedIfEmpty();
        return getReportData();
    }

    var api = {
        initProjectReport: initProjectReport,
        loadProjectReportData: loadProjectReportData,
        renderReportList: renderReportList,
        showAddReportModal: showAddReportModal,
        showReportDetail: showReportDetail,
        previewReport: previewReport,
        downloadReport: downloadReport,
        deleteReport: deleteReport,
        setRpStatFilter: setRpStatFilter,
        setRpTagFilter: setRpTagFilter,
        onReportFilterChange: onReportFilterChange,
        onReportSearchInput: onReportSearchInput,
        setReportPage: setReportPage,
        toggleRpSelect: toggleRpSelect,
        toggleReportFavorite: toggleReportFavorite,
        toggleRpTagAddPanel: toggleRpTagAddPanel,
        confirmAddRpTag: confirmAddRpTag,
        batchDeleteReports: batchDeleteReports,
        batchTagReports: batchTagReports,
        batchLinkReportProject: batchLinkReportProject,
        handleReportFileSelect: handleReportFileSelect,
        handleReportDrop: handleReportDrop,
        commitReportUpload: commitReportUpload,
        appendRpTagToInput: appendRpTagToInput,
        promptAddRpTagToInput: promptAddRpTagToInput,
        copyReportCitation: copyReportCitation
    };

    Object.keys(api).forEach(function (k) { global[k] = api[k]; });
    global.ProjectReport = api;

})(typeof window !== 'undefined' ? window : this);
