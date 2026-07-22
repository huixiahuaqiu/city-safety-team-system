/**
 * 竞赛成果管理 — 台账 CRUD + 审核 + 新闻喜报联动
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'competitionData';
    var competitionData = [];
    var editingId = null;
    var selected = {};
    var statFilter = '';

    function esc(s) {
        return window.escapeHtml(s);
    }

    function currentOwner() {
        var u = global.currentUser;
        return (u && (u.realName || u.username)) || '未知';
    }

    function canManage() {
        var u = global.currentUser;
        return !!(u && (u.role === 'admin' || u.role === 'leader'));
    }

    function canEdit(item) {
        if (!item) return false;
        if (canManage()) return true;
        var u = global.currentUser;
        if (!u || u.role === 'visitor') return false;
        return String(item.uploader || '') === currentOwner();
    }

    function normalize(raw) {
        var r = raw || {};
        return {
            id: Number(r.id) || 0,
            name: String(r.name || r.title || '').trim(),
            event: String(r.event || r.contest || '').trim(),
            award: String(r.award || '').trim(),
            level: String(r.level || '校级').trim(),
            members: String(r.members || '').trim(),
            awardDate: String(r.awardDate || r.date || '').trim(),
            status: String(r.status || '审核中').trim(),
            remark: String(r.remark || '').trim(),
            uploader: String(r.uploader || '').trim() || currentOwner(),
            uploadTime: String(r.uploadTime || new Date().toLocaleDateString('zh-CN')),
            certificateUrl: String(r.certificateUrl || '').trim()
        };
    }

    function loadData() {
        try {
            var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            competitionData = Array.isArray(raw) ? raw.map(normalize) : [];
        } catch (e) {
            competitionData = [];
        }
        if (!competitionData.length) {
            competitionData = [
                normalize({
                    id: 1,
                    name: '安全隐患识别智能巡检四足机器人',
                    event: '智能建造·慧享未来全国建筑机器人大赛',
                    award: '二等奖',
                    level: '国家级',
                    members: '课题组团队',
                    awardDate: '2025-11-01',
                    status: '已通过'
                })
            ];
        }
        global.competitionData = competitionData;
        return competitionData;
    }

    function saveData(options) {
        options = options || {};
        competitionData = (competitionData || []).map(normalize);
        global.competitionData = competitionData;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(competitionData)); } catch (e) {}
        try {
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert(STORAGE_KEY, JSON.stringify(competitionData));
        } catch (e2) {}
        try {
            if (options.log && typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('竞赛成果', options.log.action || '更新', options.log.desc || '', options.log.detail || {}, { success: true }, 1, '', 0);
            }
        } catch (e3) {}
    }

    function mergeIncoming(incoming) {
        if (!Array.isArray(incoming)) return;
        var map = {};
        competitionData.forEach(function (c) { map[c.id] = c; });
        incoming.map(normalize).forEach(function (n) { map[n.id] = Object.assign({}, map[n.id] || {}, n); });
        competitionData = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.id - a.id; });
        saveData({ silent: true });
    }

    function updateStats() {
        var year = String(new Date().getFullYear());
        var el = function (id, v) { var n = document.getElementById(id); if (n) n.textContent = String(v); };
        el('cmpStatTotal', competitionData.length);
        el('cmpStatYear', competitionData.filter(function (c) { return String(c.awardDate || '').indexOf(year) === 0; }).length);
        el('cmpStatNational', competitionData.filter(function (c) { return c.level === '国家级' || c.level === '国际级'; }).length);
        el('cmpStatApproved', competitionData.filter(function (c) { return c.status === '已通过'; }).length);
    }

    function getFiltered() {
        var q = String((document.getElementById('competitionSearchInput') || {}).value || '').trim().toLowerCase();
        var level = (document.getElementById('competitionLevelFilter') || {}).value || '';
        var status = (document.getElementById('competitionStatusFilter') || {}).value || '';
        var year = String(new Date().getFullYear());
        var list = competitionData.slice();
        if (statFilter === 'year') list = list.filter(function (c) { return String(c.awardDate || '').indexOf(year) === 0; });
        if (statFilter === 'national') list = list.filter(function (c) { return c.level === '国家级' || c.level === '国际级'; });
        if (statFilter === 'approved') list = list.filter(function (c) { return c.status === '已通过'; });
        if (level) list = list.filter(function (c) { return c.level === level; });
        if (status) list = list.filter(function (c) { return c.status === status; });
        if (q) {
            list = list.filter(function (c) {
                return [c.name, c.event, c.award, c.members, c.level].join(' ').toLowerCase().indexOf(q) >= 0;
            });
        }
        return list;
    }

    function setCompetitionStatFilter(f) {
        statFilter = (statFilter === f) ? '' : (f || '');
        renderCompetitionList();
    }

    function updateBatchBar() {
        var bar = document.getElementById('competitionBatchBar');
        var countEl = document.getElementById('competitionBatchCount');
        var n = Object.keys(selected).length;
        if (bar) bar.style.display = n ? 'flex' : 'none';
        if (countEl) countEl.textContent = String(n);
    }

    function toggleCompetitionSelect(id, checked) {
        if (checked) selected[String(id)] = true;
        else delete selected[String(id)];
        updateBatchBar();
    }

    function renderCompetitionList() {
        var container = document.getElementById('competitionList');
        var empty = document.getElementById('competitionEmptyState');
        if (!container) return;
        updateStats();
        var list = getFiltered();
        if (!list.length) {
            container.innerHTML = '';
            if (empty) empty.style.display = 'block';
            updateBatchBar();
            return;
        }
        if (empty) empty.style.display = 'none';
        container.innerHTML = list.map(function (c) {
            var checked = !!selected[String(c.id)];
            return '<div style="background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);">' +
                '<div style="display:flex;gap:12px;align-items:flex-start;">' +
                '<label><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleCompetitionSelect(' + c.id + ',this.checked)"></label>' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:16px;font-weight:700;color:#111;">' + esc(c.name) + '</div>' +
                '<div style="font-size:13px;color:#666;margin-top:6px;line-height:1.6;">' +
                esc(c.event) + ' · ' + esc(c.award) + ' · ' + esc(c.level) +
                '<br>成员：' + esc(c.members || '—') + ' · 获奖日期：' + esc(c.awardDate || '—') +
                ' · <span style="color:' + (c.status === '已通过' ? '#15803d' : (c.status === '已驳回' ? '#b91c1c' : '#b45309')) + ';">' + esc(c.status) + '</span>' +
                '</div></div>' +
                '<div style="display:flex;flex-direction:column;gap:6px;">' +
                (canEdit(c) ? '<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="editCompetition(' + c.id + ')">编辑</button>' : '') +
                '<button class="btn" style="padding:4px 10px;font-size:12px;background:#0d9488;" onclick="offerCompetitionNews(' + c.id + ')">生成新闻</button>' +
                (canManage() && c.status !== '已通过' ? '<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="auditCompetition(' + c.id + ',\'已通过\')">通过</button>' : '') +
                (canEdit(c) ? '<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;color:#ef4444;" onclick="deleteCompetition(' + c.id + ')">删除</button>' : '') +
                '</div></div></div>';
        }).join('');
        updateBatchBar();
    }

    function showAddCompetitionModal(item) {
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客不可登记竞赛成果');
            return;
        }
        editingId = item ? item.id : null;
        var modalId = 'competitionModal';
        var old = document.getElementById(modalId);
        if (old) old.remove();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2600;display:flex;align-items:center;justify-content:center;padding:16px;';
        item = item || {};
        modal.innerHTML =
            '<div style="background:#fff;border-radius:12px;width:100%;max-width:560px;max-height:90vh;overflow:auto;">' +
            '<div style="padding:16px 20px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;">' +
            '<h3 style="margin:0;">' + (editingId ? '编辑竞赛成果' : '登记竞赛成果') + '</h3>' +
            '<button type="button" onclick="document.getElementById(\'' + modalId + '\').remove()" style="border:none;background:#f5f5f5;width:32px;height:32px;border-radius:50%;cursor:pointer;">×</button></div>' +
            '<div style="padding:20px;">' +
            field('项目/作品名称 *', 'cmpName', item.name || '') +
            field('赛事名称 *', 'cmpEvent', item.event || '') +
            field('获奖等级 *', 'cmpAward', item.award || '', '如：一等奖 / 金奖') +
            '<div class="form-group" style="margin-bottom:12px;"><label>赛事级别</label>' +
            '<select id="cmpLevel" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' +
            ['国际级', '国家级', '省部级', '市级', '校级'].map(function (lv) {
                return '<option value="' + lv + '"' + ((item.level || '校级') === lv ? ' selected' : '') + '>' + lv + '</option>';
            }).join('') + '</select></div>' +
            field('获奖成员', 'cmpMembers', item.members || '') +
            '<div class="form-group" style="margin-bottom:12px;"><label>获奖日期</label>' +
            '<input type="date" id="cmpDate" value="' + esc(item.awardDate || '') + '" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;"></div>' +
            '<div class="form-group" style="margin-bottom:12px;"><label>状态</label>' +
            '<select id="cmpStatus" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' +
            ['审核中', '已通过', '已驳回'].map(function (st) {
                return '<option value="' + st + '"' + ((item.status || '审核中') === st ? ' selected' : '') + '>' + st + '</option>';
            }).join('') + '</select></div>' +
            '<div class="form-group" style="margin-bottom:12px;"><label>备注</label>' +
            '<textarea id="cmpRemark" rows="3" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' + esc(item.remark || '') + '</textarea></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'' + modalId + '\').remove()">取消</button>' +
            '<button class="btn" onclick="commitCompetition()">保存</button></div></div></div>';
        document.body.appendChild(modal);
        modal.onclick = function (e) { if (e.target === modal) modal.remove(); };
    }

    function field(label, id, val, ph) {
        return '<div class="form-group" style="margin-bottom:12px;"><label>' + label + '</label>' +
            '<input id="' + id + '" value="' + esc(val) + '" placeholder="' + esc(ph || '') + '" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;"></div>';
    }

    function editCompetition(id) {
        var item = competitionData.find(function (c) { return c.id === id; });
        if (!item) return;
        if (!canEdit(item)) { alert('无权限编辑'); return; }
        showAddCompetitionModal(item);
    }

    function commitCompetition() {
        var name = ((document.getElementById('cmpName') || {}).value || '').trim();
        var event = ((document.getElementById('cmpEvent') || {}).value || '').trim();
        var award = ((document.getElementById('cmpAward') || {}).value || '').trim();
        if (!name || !event || !award) { alert('请填写项目名称、赛事名称与获奖等级'); return; }
        var payload = normalize({
            id: editingId || 0,
            name: name,
            event: event,
            award: award,
            level: (document.getElementById('cmpLevel') || {}).value || '校级',
            members: (document.getElementById('cmpMembers') || {}).value || '',
            awardDate: (document.getElementById('cmpDate') || {}).value || '',
            status: (document.getElementById('cmpStatus') || {}).value || '审核中',
            remark: (document.getElementById('cmpRemark') || {}).value || '',
            uploader: currentOwner()
        });
        if (editingId) {
            var idx = competitionData.findIndex(function (c) { return c.id === editingId; });
            if (idx >= 0) competitionData[idx] = Object.assign({}, competitionData[idx], payload, { id: editingId });
            saveData({ log: { action: '编辑', desc: name } });
        } else {
            payload.id = competitionData.length ? Math.max.apply(null, competitionData.map(function (c) { return c.id; })) + 1 : 1;
            competitionData.unshift(payload);
            saveData({ log: { action: '新增', desc: name } });
        }
        var modal = document.getElementById('competitionModal');
        if (modal) modal.remove();
        renderCompetitionList();
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('竞赛成果已保存', false);
        else alert('保存成功！');
        try {
            if (typeof global.offerNewsDraftFromCompetition === 'function') {
                setTimeout(function () {
                    global.offerNewsDraftFromCompetition({
                        name: payload.name,
                        title: payload.name,
                        award: payload.award,
                        level: payload.level,
                        members: payload.members,
                        event: payload.event
                    });
                }, 250);
            }
        } catch (e) {}
    }

    function deleteCompetition(id) {
        var item = competitionData.find(function (c) { return c.id === id; });
        if (!item || !canEdit(item)) return;
        if (!confirm('确定删除《' + item.name + '》？')) return;
        competitionData = competitionData.filter(function (c) { return c.id !== id; });
        delete selected[String(id)];
        saveData({ log: { action: '删除', desc: item.name } });
        renderCompetitionList();
    }

    function auditCompetition(id, status) {
        if (!canManage()) return;
        var idx = competitionData.findIndex(function (c) { return c.id === id; });
        if (idx < 0) return;
        competitionData[idx].status = status;
        saveData({ log: { action: '审核', desc: competitionData[idx].name + ' → ' + status } });
        renderCompetitionList();
    }

    function batchAuditCompetitions(status) {
        if (!canManage()) return;
        var ids = Object.keys(selected).map(Number);
        if (!ids.length) return;
        competitionData.forEach(function (c) {
            if (selected[String(c.id)]) c.status = status;
        });
        saveData({ log: { action: '批量审核', desc: ids.length + ' 条 → ' + status } });
        renderCompetitionList();
    }

    function batchDeleteCompetitions() {
        var ids = Object.keys(selected).map(Number).filter(function (id) {
            var item = competitionData.find(function (c) { return c.id === id; });
            return item && canEdit(item);
        });
        if (!ids.length) return;
        if (!confirm('确定删除选中的 ' + ids.length + ' 条？')) return;
        var set = {};
        ids.forEach(function (id) { set[id] = true; });
        competitionData = competitionData.filter(function (c) { return !set[c.id]; });
        selected = {};
        saveData({ log: { action: '批量删除', desc: ids.length + ' 条' } });
        renderCompetitionList();
    }

    function offerCompetitionNews(id) {
        var item = competitionData.find(function (c) { return c.id === id; });
        if (!item) return;
        if (typeof global.offerNewsDraftFromCompetition === 'function') {
            global.offerNewsDraftFromCompetition({
                name: item.name,
                title: item.name,
                award: item.award,
                level: item.level,
                members: item.members,
                event: item.event
            });
        } else {
            alert('新闻模块未加载');
        }
    }

    function initCompetitionManagement() {
        loadData();
        renderCompetitionList();
        var btn = document.getElementById('competitionAddBtn');
        if (btn && global.currentUser && global.currentUser.role === 'visitor') btn.style.display = 'none';
    }

    var api = {
        initCompetitionManagement: initCompetitionManagement,
        initCompetitionData: initCompetitionManagement,
        loadCompetitionData: loadData,
        saveCompetitionData: saveData,
        mergeIncomingCompetitionData: mergeIncoming,
        renderCompetitionList: renderCompetitionList,
        setCompetitionStatFilter: setCompetitionStatFilter,
        showAddCompetitionModal: function () { showAddCompetitionModal(null); },
        editCompetition: editCompetition,
        commitCompetition: commitCompetition,
        deleteCompetition: deleteCompetition,
        auditCompetition: auditCompetition,
        batchAuditCompetitions: batchAuditCompetitions,
        batchDeleteCompetitions: batchDeleteCompetitions,
        toggleCompetitionSelect: toggleCompetitionSelect,
        offerCompetitionNews: offerCompetitionNews
    };
    Object.keys(api).forEach(function (k) { global[k] = api[k]; });
    global.CompetitionManagement = api;
    try {
        Object.defineProperty(global, 'competitionData', {
            configurable: true,
            enumerable: true,
            get: function () { return competitionData; },
            set: function (v) { competitionData = Array.isArray(v) ? v.map(normalize) : []; }
        });
    } catch (e) {
        global.competitionData = competitionData;
    }
})(typeof window !== 'undefined' ? window : this);
