/**
 * 请假与申请中心 — 角色差异化 · 类型模板 · 二级审批 · 业务联动
 * 数据存 localStorage + 云端 KV（applicationData / approvalFlowConfig）
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'applicationData';
    var FLOW_KEY = 'approvalFlowConfig';
    var TEMPLATE_KEY = 'applicationPersonalTemplates';
    var REIMBURSE_LARGE = 2000;

    var applicationData = [];
    var approvalFlowConfig = null;
    var activeTab = 'mine';
    var activeStat = '';
    var selectedIds = {};
    var reviewingId = null;
    var reviewAction = '';
    var createStep = 'pick';
    var createType = '';
    var pendingAttachments = [];
    var pendingDetailImages = [];
    var editingDraftId = null;
    var resubmitFromId = null;

    var STATUS_CFG = {
        draft: { label: '草稿', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
        pending: { label: '待审批', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
        reviewing: { label: '审批中', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
        approved: { label: '已通过', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
        rejected: { label: '已驳回', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
        withdrawn: { label: '已撤回', color: '#6b7280', bg: '#f3f4f6', border: '#e5e7eb' }
    };

    var TYPE_META = {
        leave: { label: '事假/病假请假', short: '请假', ico: '假', color: '#7c3aed' },
        trip: { label: '出差申请', short: '出差', ico: '差', color: '#2563eb' },
        equipment: { label: '实验室设备借用', short: '设备', ico: '设', color: '#0891b2' },
        reimburse: { label: '经费报销申请', short: '报销', ico: '报', color: '#d97706' },
        stay: { label: '假期留校申请', short: '留校', ico: '留', color: '#059669' },
        defense: { label: '开题/答辩申请', short: '答辩', ico: '辩', color: '#db2777' },
        other: { label: '其他通用申请', short: '其他', ico: '其', color: '#64748b' }
    };

    var DEFAULT_FLOWS = {
        leave: [{ role: 'leader', label: '组长初审' }, { role: 'admin', label: '导师终审' }],
        trip: [{ role: 'admin', label: '导师审批' }],
        equipment: [{ role: 'admin', label: '导师审批' }],
        reimburse: [{ role: 'admin', label: '导师审批' }],
        reimburse_large: [{ role: 'admin', label: '导师审批' }],
        stay: [{ role: 'leader', label: '组长初审' }, { role: 'admin', label: '导师终审' }],
        defense: [{ role: 'admin', label: '导师审批' }],
        other: [{ role: 'leader', label: '组长初审' }, { role: 'admin', label: '导师终审' }]
    };

    function esc(s) {
        return window.escapeHtml(s);
    }

    function nowStr() {
        try { return new Date().toLocaleString('zh-CN'); } catch (e) { return String(new Date()); }
    }

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function genApplyNo() {
        var d = new Date();
        var base = 'SQ' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
        var seq = String((applicationData.length % 900) + 100);
        return base + seq + String(Date.now() % 1000);
    }

    function currentUser() { return global.currentUser || null; }

    function hasPerm(name) {
        return typeof global.hasPermission === 'function' && !!global.hasPermission(name);
    }

    function roleKind() {
        var u = currentUser();
        if (!u) return 'guest';
        if (u.role === 'admin') return 'admin';
        if (u.role === 'leader') return 'leader';
        if (u.role === 'student') return 'student';
        if (u.role === 'visitor') return 'visitor';
        return 'guest';
    }

    function canSubmit() {
        var u = currentUser();
        if (!u || u.role === 'visitor') return false;
        return hasPerm('请假与申请（提交自己的）') || u.role === 'admin' || u.role === 'leader' || u.role === 'student';
    }

    function canReviewAll() {
        var u = currentUser();
        if (!u) return false;
        if (u.role === 'admin') return true;
        if (u.role === 'leader') return false;
        return hasPerm('请假与申请（审批/查看全部）');
    }

    function canReviewGroup() {
        var u = currentUser();
        if (!u) return false;
        if (canReviewAll()) return true;
        return u.role === 'leader' || hasPerm('请假与申请（本组审批）');
    }

    function canConfigFlow() {
        return !!(currentUser() && (currentUser().role === 'admin' || hasPerm('请假与申请（流程配置）')));
    }

    function myName() {
        var u = currentUser();
        return (u && (u.realName || u.username)) || '';
    }

    function myApplicantId() {
        var u = currentUser();
        if (!u) return '';
        return String(u.id != null ? u.id : (u.studentId || ''));
    }

    function myGroup() {
        var u = currentUser();
        return (u && u.group) || '';
    }

    function myStudentId() {
        var u = currentUser();
        return (u && u.studentId) || '';
    }

    function accounts() {
        try {
            if (Array.isArray(global.accountData)) return global.accountData;
        } catch (e) {}
        try { return JSON.parse(localStorage.getItem('accountData') || '[]'); } catch (e2) { return []; }
    }

    function resolveAvatar(name) {
        try {
            var list = global.teamMemberData || [];
            var hit = list.find(function (m) { return m && m.name === name; });
            if (hit && hit.avatar && String(hit.avatar).length > 20) return hit.avatar;
        } catch (e) {}
        return '';
    }

    function avatarHtml(name) {
        var url = resolveAvatar(name);
        var ch = esc(String(name || '?').charAt(0));
        if (url) {
            return '<div style="width:40px;height:40px;border-radius:50%;overflow:hidden;flex-shrink:0;background:#ede9fe;">' +
                '<img src="' + String(url).replace(/"/g, '&quot;') + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentNode.textContent=\'' + ch + '\';"></div>';
        }
        return '<div style="width:40px;height:40px;border-radius:50%;flex-shrink:0;background:#ede9fe;color:#7c3aed;display:flex;align-items:center;justify-content:center;font-weight:700;">' + ch + '</div>';
    }

    function loadFlowConfig() {
        try {
            var raw = JSON.parse(localStorage.getItem(FLOW_KEY) || 'null');
            if (raw && typeof raw === 'object') approvalFlowConfig = raw;
        } catch (e) {}
        if (!approvalFlowConfig) approvalFlowConfig = JSON.parse(JSON.stringify(DEFAULT_FLOWS));
        Object.keys(DEFAULT_FLOWS).forEach(function (k) {
            if (!approvalFlowConfig[k]) approvalFlowConfig[k] = DEFAULT_FLOWS[k].slice();
        });
        // 报销一律导师直审（覆盖历史「组长初审」配置）
        var mentorOnly = [{ role: 'admin', label: '导师审批' }];
        approvalFlowConfig.reimburse = mentorOnly.slice();
        approvalFlowConfig.reimburse_large = mentorOnly.slice();
        try { localStorage.setItem(FLOW_KEY, JSON.stringify(approvalFlowConfig)); } catch (ePersist) {}
        global.approvalFlowConfig = approvalFlowConfig;
        return approvalFlowConfig;
    }

    function saveFlowConfig() {
        localStorage.setItem(FLOW_KEY, JSON.stringify(approvalFlowConfig));
        global.approvalFlowConfig = approvalFlowConfig;
        try { if (typeof global.cloudUpsert === 'function') global.cloudUpsert(FLOW_KEY, JSON.stringify(approvalFlowConfig)); } catch (e) {}
    }

    function mergeIncomingApprovalFlowConfig(v) {
        if (v && typeof v === 'object') {
            approvalFlowConfig = v;
            Object.keys(DEFAULT_FLOWS).forEach(function (k) {
                if (!approvalFlowConfig[k]) approvalFlowConfig[k] = DEFAULT_FLOWS[k].slice();
            });
            global.approvalFlowConfig = approvalFlowConfig;
        }
        return approvalFlowConfig;
    }

    function resolveFlow(applyType, formData) {
        loadFlowConfig();
        var key = applyType || 'other';
        if (key === 'reimburse') {
            return (approvalFlowConfig.reimburse || DEFAULT_FLOWS.reimburse).slice();
        }
        return (approvalFlowConfig[key] || DEFAULT_FLOWS.other).slice();
    }

    function typeLabel(t) {
        return (TYPE_META[t] && TYPE_META[t].short) || t || '申请';
    }

    function normalize(raw) {
        var r = raw || {};
        var applyType = String(r.applyType || r.category || 'leave');
        if (applyType === 'leave' || applyType === 'other' || TYPE_META[applyType]) {
            /* ok */
        } else {
            applyType = 'other';
        }
        // legacy category → applyType
        if (!r.applyType && r.category === 'other') applyType = 'other';
        if (!r.applyType && r.category === 'leave') applyType = 'leave';

        var status = String(r.status || 'pending');
        if (!STATUS_CFG[status]) status = 'pending';

        var formData = r.formData && typeof r.formData === 'object' ? Object.assign({}, r.formData) : {};
        if (!formData.startAt && r.startAt) formData.startAt = r.startAt;
        if (!formData.endAt && r.endAt) formData.endAt = r.endAt;
        if (!formData.leaveType && r.leaveType) formData.leaveType = r.leaveType;
        if (!formData.contact && r.contact) formData.contact = r.contact;

        var records = Array.isArray(r.approvalRecords) ? r.approvalRecords.slice() : [];
        if (!records.length && (r.reviewedBy || r.reviewComment)) {
            records.push({
                nodeOrder: 1,
                approver: r.reviewedBy || '',
                approverId: '',
                result: status === 'rejected' ? 'rejected' : (status === 'approved' ? 'approved' : 'approved'),
                opinion: r.reviewComment || '',
                at: r.reviewedAt || ''
            });
        }

        var flow = Array.isArray(r.flow) && r.flow.length ? r.flow.slice() : resolveFlow(applyType, formData);

        return {
            id: Number(r.id) || 0,
            applyNo: String(r.applyNo || ''),
            applyType: applyType,
            category: applyType === 'leave' ? 'leave' : (applyType === 'other' ? 'other' : applyType),
            title: String(r.title || '').trim(),
            reason: String(r.reason || '').trim(),
            formData: formData,
            attachments: Array.isArray(r.attachments) ? r.attachments : [],
            leaveType: String(formData.leaveType || r.leaveType || '').trim(),
            startAt: String(formData.startAt || r.startAt || '').trim(),
            endAt: String(formData.endAt || r.endAt || '').trim(),
            contact: String(formData.contact || r.contact || '').trim(),
            applicant: String(r.applicant || '').trim(),
            applicantId: r.applicantId != null ? String(r.applicantId) : '',
            applicantGroup: String(r.applicantGroup || '').trim(),
            studentId: String(r.studentId || '').trim(),
            status: status,
            currentNode: Number(r.currentNode) || 0,
            flow: flow,
            version: Number(r.version) || 1,
            urgent: !!r.urgent,
            projectId: r.projectId != null ? r.projectId : null,
            projectName: String(r.projectName || formData.projectName || '').trim(),
            createdAt: String(r.createdAt || ''),
            updatedAt: String(r.updatedAt || r.createdAt || ''),
            reviewedBy: String(r.reviewedBy || '').trim(),
            reviewedAt: String(r.reviewedAt || ''),
            reviewComment: String(r.reviewComment || '').trim(),
            approvalRecords: records,
            parentId: r.parentId != null ? Number(r.parentId) : null
        };
    }

    function isMine(item) {
        if (!item) return false;
        if (item.applicantId && String(item.applicantId) === myApplicantId()) return true;
        return String(item.applicant || '') === myName();
    }

    function inMyGroup(item) {
        var g = myGroup();
        if (!g) return false;
        return String(item.applicantGroup || '') === String(g);
    }

    function currentNodeDef(item) {
        if (!item || !item.flow || !item.flow.length) return null;
        var idx = Number(item.currentNode) || 0;
        return item.flow[idx] || null;
    }

    function isAwaitingMe(item) {
        if (!item || (item.status !== 'pending' && item.status !== 'reviewing')) return false;
        var node = currentNodeDef(item);
        if (!node) return false;
        var u = currentUser();
        if (!u) return false;
        if (node.role === 'leader') {
            if (!(u.role === 'leader' || canReviewGroup())) return false;
            if (canReviewAll()) return true;
            return inMyGroup(item);
        }
        if (node.role === 'admin') {
            return canReviewAll() || u.role === 'admin';
        }
        return false;
    }

    function canSeeItem(item) {
        if (!item) return false;
        if (isMine(item)) return true;
        if (canReviewAll()) return true;
        if (canReviewGroup() && inMyGroup(item)) return true;
        return false;
    }

    function canWithdraw(item) {
        if (!item || !isMine(item)) return false;
        if (item.status !== 'pending' && item.status !== 'reviewing') return false;
        // 仅首个节点未处理前可撤回
        return !item.approvalRecords || !item.approvalRecords.length;
    }

    function displayTitle(item) {
        if (!item) return '';
        if (item.title) return item.title;
        var t = typeLabel(item.applyType);
        if (item.applyType === 'leave' && item.leaveType) return item.leaveType;
        return t;
    }

    function calcDays(startAt, endAt) {
        if (!startAt || !endAt) return 0;
        var a = new Date(String(startAt).replace(' ', 'T'));
        var b = new Date(String(endAt).replace(' ', 'T'));
        if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return 0;
        return Math.max(1, Math.ceil((b - a) / 86400000));
    }

    function isUrgentItem(item) {
        if (!item) return false;
        if (item.urgent) return true;
        var fd = item.formData || {};
        if (item.applyType === 'reimburse') {
            var amt = parseFloat(fd.amount || 0) || 0;
            if (amt >= REIMBURSE_LARGE) return true;
        }
        if (item.applyType === 'leave') {
            var start = String(fd.startAt || item.startAt || '').slice(0, 10);
            var today = new Date();
            var ymd = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
            if (start && start === ymd) return true;
        }
        return false;
    }

    function nextId() {
        if (!applicationData.length) return 1;
        return Math.max.apply(null, applicationData.map(function (a) { return Number(a.id) || 0; })) + 1;
    }

    function loadData() {
        try {
            var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            applicationData = Array.isArray(raw) ? raw.map(normalize) : [];
        } catch (e) {
            applicationData = [];
        }
        global.applicationData = applicationData;
        loadFlowConfig();
        return applicationData;
    }

    function saveData(options) {
        options = options || {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify(applicationData));
        global.applicationData = applicationData;
        try {
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert(STORAGE_KEY, JSON.stringify(applicationData));
        } catch (e) {}
        try {
            if (options.log && typeof global.recordOperationLog === 'function') {
                global.recordOperationLog(
                    '请假与申请',
                    options.log.action || '更新',
                    options.log.desc || '',
                    options.log.detail || {},
                    { success: true }, 1, '', 0
                );
            }
        } catch (e2) {}
        try { if (typeof global.renderHomeDashboard === 'function') global.renderHomeDashboard(); } catch (e3) {}
    }

    function mergeIncomingApplicationData(incoming) {
        var remote = Array.isArray(incoming) ? incoming.map(normalize) : [];
        var map = {};
        (applicationData || []).forEach(function (a) { map[a.id] = normalize(a); });
        remote.forEach(function (r) {
            if (!r.id) return;
            var cur = map[r.id];
            if (!cur || (Number(r.version) || 0) >= (Number(cur.version) || 0)) map[r.id] = r;
        });
        applicationData = Object.keys(map).map(function (k) { return map[k]; });
        applicationData.sort(function (a, b) { return (Number(b.id) || 0) - (Number(a.id) || 0); });
        global.applicationData = applicationData;
        return applicationData;
    }

    /* ========== 通知 ========== */
    function pushSystemNotice(opts) {
        try {
            if (typeof global.normalizeNoticeRecord !== 'function') return;
            var noticeData = global.noticeData;
            if (!Array.isArray(noticeData)) {
                try { noticeData = JSON.parse(localStorage.getItem('noticeData') || '[]'); } catch (e) { noticeData = []; }
                global.noticeData = noticeData;
            }
            var newId = noticeData.length
                ? Math.max.apply(null, noticeData.map(function (n) { return Number(n.id) || 0; })) + 1
                : 1;
            var notice = global.normalizeNoticeRecord({
                id: newId,
                title: opts.title,
                type: opts.urgent ? 'urgent' : 'notice',
                content: opts.content || '',
                startTime: '',
                endTime: '',
                publishTime: nowStr(),
                publisher: '系统',
                audience: 'custom',
                audienceNames: opts.names || [],
                pinned: !!opts.urgent,
                reads: [],
                contentIsHtml: false
            });
            noticeData.push(notice);
            global.noticeData = noticeData;
            if (typeof global.saveNoticeData === 'function') {
                global.saveNoticeData({ log: { action: '发布', desc: opts.title, detail: { audienceNames: opts.names } } });
            } else {
                localStorage.setItem('noticeData', JSON.stringify(noticeData));
                if (typeof global.cloudUpsert === 'function') global.cloudUpsert('noticeData', JSON.stringify(noticeData));
            }
            try { if (typeof global.refreshGlobalNoticeCenter === 'function') global.refreshGlobalNoticeCenter(); } catch (e2) {}
        } catch (err) {
            console.error('pushSystemNotice', err);
        }
    }

    function namesByRole(role, group) {
        return accounts().filter(function (a) {
            if (!a || a.role === 'visitor') return false;
            if (role === 'admin') return a.role === 'admin';
            if (role === 'leader') return a.role === 'leader' && (!group || String(a.group) === String(group));
            return false;
        }).map(function (a) { return a.realName; }).filter(Boolean);
    }

    function notifyApprovers(item) {
        var node = currentNodeDef(item);
        if (!node) return;
        var names = namesByRole(node.role, item.applicantGroup);
        if (!names.length && node.role === 'admin') {
            names = accounts().filter(function (a) { return a && a.role === 'admin'; }).map(function (a) { return a.realName; });
        }
        if (!names.length) return;
        pushSystemNotice({
            title: '【系统通知】待审批：' + displayTitle(item) + '（' + (item.applicant || '') + '）',
            content: [
                '您有一条新的申请待审批。',
                '编号：' + (item.applyNo || item.id),
                '申请人：' + (item.applicant || ''),
                '类型：' + typeLabel(item.applyType),
                '节点：' + (node.label || ''),
                '',
                '请前往「请假与申请」处理。'
            ].join('\n'),
            names: names,
            urgent: isUrgentItem(item)
        });
    }

    function notifyApplicantResult(item, resultLabel) {
        if (!item || !item.applicant) return;
        pushSystemNotice({
            title: '【系统通知】申请' + resultLabel + '：' + displayTitle(item),
            content: [
                '您好，' + item.applicant + '：',
                '您的申请「' + displayTitle(item) + '」结果：' + resultLabel + '。',
                '编号：' + (item.applyNo || item.id),
                item.reviewComment ? ('意见：' + item.reviewComment) : '',
                '',
                '可在「请假与申请」查看详情。'
            ].filter(Boolean).join('\n'),
            names: [item.applicant],
            urgent: false
        });
    }

    /* ========== 业务联动 ========== */
    function linkWeeklyReport(item) {
        if (!item || (item.applyType !== 'leave' && item.applyType !== 'trip')) return;
        if (item.status !== 'approved') return;
        try {
            var reports = global.weeklyReportData;
            if (!Array.isArray(reports)) {
                try { reports = JSON.parse(localStorage.getItem('weeklyReportData') || '[]'); } catch (e) { reports = []; }
                global.weeklyReportData = reports;
            }
            var start = String((item.formData && item.formData.startAt) || item.startAt || '').slice(0, 10);
            var end = String((item.formData && item.formData.endAt) || item.endAt || '').slice(0, 10);
            var days = calcDays(start, end) || calcDays(item.startAt, item.endAt);
            var note = item.applyType === 'leave'
                ? ('【系统】本周请假 ' + days + ' 天（' + start + ' ~ ' + end + '，编号 ' + (item.applyNo || item.id) + '）')
                : ('【系统】本周出差 ' + days + ' 天（' + start + ' ~ ' + end + '，编号 ' + (item.applyNo || item.id) + '）');
            var owner = item.applicant;
            var hit = null;
            for (var i = 0; i < reports.length; i++) {
                if (reports[i] && reports[i].owner === owner) {
                    var wr = String(reports[i].weekRange || '');
                    var m = wr.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
                    if (m && start && start >= m[1] && start <= m[2]) { hit = reports[i]; break; }
                }
            }
            if (hit) {
                if (String(hit.notes || '').indexOf(item.applyNo || String(item.id)) >= 0) return;
                hit.notes = (hit.notes ? hit.notes + '\n' : '') + note;
            } else {
                var newId = reports.length ? Math.max.apply(null, reports.map(function (r) { return Number(r.id) || 0; })) + 1 : 1;
                reports.unshift({
                    id: newId,
                    weekRange: start + ' 至 ' + (end || start),
                    owner: owner,
                    content: note,
                    nextWeek: '',
                    problems: '',
                    notes: note,
                    status: 'pending',
                    submitTime: nowStr(),
                    reviewComment: '',
                    visibility: 'all'
                });
            }
            if (typeof global.saveWeeklyReportData === 'function') global.saveWeeklyReportData();
            else {
                localStorage.setItem('weeklyReportData', JSON.stringify(reports));
                if (typeof global.cloudUpsert === 'function') global.cloudUpsert('weeklyReportData', JSON.stringify(reports));
            }
        } catch (err) {
            console.error('linkWeeklyReport', err);
        }
    }

    function linkProjectExpense(item) {
        if (!item || item.applyType !== 'reimburse' || item.status !== 'approved') return;
        try {
            var fd = item.formData || {};
            var amt = parseFloat(fd.amount || 0) || 0;
            if (!amt) return;
            var pid = item.projectId || fd.projectId;
            var pname = item.projectName || fd.projectName || '';
            var pools = [];
            try { if (Array.isArray(global.longitudinalData)) pools = pools.concat(global.longitudinalData); } catch (e) {}
            try { if (Array.isArray(global.horizontalData)) pools = pools.concat(global.horizontalData); } catch (e2) {}
            try { if (Array.isArray(global.schoolData)) pools = pools.concat(global.schoolData); } catch (e3) {}
            var proj = null;
            if (pid != null && pid !== '') {
                proj = pools.find(function (p) { return String(p.id) === String(pid); });
            }
            if (!proj && pname) {
                proj = pools.find(function (p) { return String(p.name || p.title || '') === String(pname); });
            }
            if (!proj) return;
            var used = parseFloat(proj.usedFunding || proj.spent || proj.used || 0) || 0;
            proj.usedFunding = used + amt;
            proj.spent = proj.usedFunding;
            var log = Array.isArray(proj.expenseLogs) ? proj.expenseLogs : [];
            if (log.some(function (x) { return x && String(x.applyId) === String(item.id); })) return;
            log.push({
                applyId: item.id,
                applyNo: item.applyNo,
                amount: amt,
                title: displayTitle(item),
                at: nowStr(),
                by: item.applicant
            });
            proj.expenseLogs = log;
            try {
                if (typeof global.saveLongitudinalData === 'function') global.saveLongitudinalData();
                if (typeof global.saveHorizontalData === 'function') global.saveHorizontalData();
                if (typeof global.saveSchoolData === 'function') global.saveSchoolData();
            } catch (e4) {}
            // 兜底写回 localStorage 各池
            try {
                if (Array.isArray(global.longitudinalData)) {
                    localStorage.setItem('longitudinalData', JSON.stringify(global.longitudinalData));
                    if (typeof global.cloudUpsert === 'function') global.cloudUpsert('longitudinalData', JSON.stringify(global.longitudinalData));
                }
            } catch (e5) {}
        } catch (err) {
            console.error('linkProjectExpense', err);
        }
    }

    function onFinalApproved(item) {
        linkWeeklyReport(item);
        linkProjectExpense(item);
    }

    /* ========== 列表范围 ========== */
    function visibleBaseList() {
        loadData();
        return (applicationData || []).filter(canSeeItem);
    }

    function listForTab() {
        var list = visibleBaseList();
        var kind = roleKind();
        if (activeTab === 'mine' || kind === 'student') {
            list = list.filter(isMine);
        } else if (activeTab === 'pending') {
            list = list.filter(isAwaitingMe);
        } else if (activeTab === 'all') {
            if (kind === 'leader' && !canReviewAll()) {
                list = list.filter(function (a) { return inMyGroup(a) || isMine(a); });
            }
        }
        return list;
    }

    function applyFilters(list) {
        var q = String((document.getElementById('appSearchInput') || {}).value || '').trim().toLowerCase();
        var st = activeStat || String((document.getElementById('appStatusFilter') || {}).value || '');
        var cat = String((document.getElementById('appCategoryFilter') || {}).value || '');
        var from = String((document.getElementById('appDateFrom') || {}).value || '');
        var to = String((document.getElementById('appDateTo') || {}).value || '');
        var applicant = String((document.getElementById('appApplicantFilter') || {}).value || '');
        if (st) list = list.filter(function (a) { return a.status === st; });
        if (cat) list = list.filter(function (a) { return a.applyType === cat || a.category === cat; });
        if (applicant) list = list.filter(function (a) { return a.applicant === applicant; });
        if (from) list = list.filter(function (a) { return String(a.createdAt || '').slice(0, 10).replace(/\//g, '-') >= from; });
        if (to) list = list.filter(function (a) { return String(a.createdAt || '').slice(0, 10).replace(/\//g, '-') <= to; });
        if (q) {
            list = list.filter(function (a) {
                var blob = [a.applicant, a.title, a.reason, a.applyNo, displayTitle(a), typeLabel(a.applyType)].join(' ').toLowerCase();
                return blob.indexOf(q) >= 0;
            });
        }
        list.sort(function (a, b) {
            var ua = isUrgentItem(a) && (a.status === 'pending' || a.status === 'reviewing') ? 1 : 0;
            var ub = isUrgentItem(b) && (b.status === 'pending' || b.status === 'reviewing') ? 1 : 0;
            if (ua !== ub) return ub - ua;
            return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || ((b.id || 0) - (a.id || 0));
        });
        return list;
    }

    function monthKey(s) {
        var t = String(s || '');
        var m = t.match(/(\d{4})[\/\-](\d{1,2})/);
        if (!m) return '';
        return m[1] + '-' + pad(parseInt(m[2], 10));
    }

    function thisMonthKey() {
        var d = new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1);
    }

    function renderStatCards() {
        var box = document.getElementById('appStatCards');
        if (!box) return;
        var kind = roleKind();
        var base = visibleBaseList();
        if (kind === 'student') base = base.filter(isMine);
        else if (kind === 'leader' && !canReviewAll()) base = base.filter(function (a) { return inMyGroup(a) || isMine(a); });

        var awaiting = base.filter(isAwaitingMe).length;
        var pendingLike = base.filter(function (a) { return a.status === 'pending' || a.status === 'reviewing'; }).length;
        var approved = base.filter(function (a) { return a.status === 'approved'; }).length;
        var rejected = base.filter(function (a) { return a.status === 'rejected'; }).length;
        var monthCount = base.filter(function (a) { return monthKey(a.createdAt) === thisMonthKey(); }).length;
        var decided = approved + rejected;
        var rate = decided ? Math.round((approved / decided) * 100) : 0;

        var cards = [];
        if (kind === 'student') {
            cards = [
                { key: 'pending', label: '我的待审批', value: pendingLike, color: '#dc2626', alert: pendingLike > 0 },
                { key: 'approved', label: '已通过', value: approved, color: '#16a34a' },
                { key: 'rejected', label: '已驳回', value: rejected, color: '#dc2626' }
            ];
        } else if (kind === 'leader') {
            cards = [
                { key: '__await__', label: '待我审批', value: awaiting, color: '#dc2626', alert: awaiting > 0 },
                { key: 'approved', label: '已通过', value: approved, color: '#16a34a' },
                { key: 'rejected', label: '已驳回', value: rejected, color: '#dc2626' },
                { key: '__month__', label: '本组本月', value: monthCount, color: '#7c3aed' }
            ];
        } else {
            cards = [
                { key: '__await__', label: '待审批', value: awaiting, color: '#dc2626', alert: awaiting > 0 },
                { key: 'approved', label: '已通过', value: approved, color: '#16a34a' },
                { key: 'rejected', label: '已驳回', value: rejected, color: '#dc2626' },
                { key: '__month__', label: '本月申请', value: monthCount, color: '#7c3aed' },
                { key: '__rate__', label: '通过率', value: rate + '%', color: '#2563eb' }
            ];
        }

        box.innerHTML = cards.map(function (c) {
            var on = (activeStat === c.key) || (c.key === '__await__' && activeTab === 'pending' && !activeStat);
            var border = on ? '2px solid #7c3aed' : '1px solid #eef0f5';
            var badge = c.alert ? '<span style="position:absolute;top:10px;right:12px;width:8px;height:8px;border-radius:50%;background:#ef4444;"></span>' : '';
            return '<div data-stat="' + esc(c.key) + '" onclick="setApplicationStatFilter(\'' + esc(c.key) + '\')" style="position:relative;background:#fff;padding:16px 18px;border-radius:14px;border:' + border + ';cursor:pointer;">' +
                badge +
                '<div style="font-size:12px;color:#6b7280;margin-bottom:6px;">' + esc(c.label) + '</div>' +
                '<div style="font-size:28px;font-weight:700;color:' + c.color + ';line-height:1;">' + esc(String(c.value)) + '</div></div>';
        }).join('');
    }

    function renderTabs() {
        var bar = document.getElementById('appTabBar');
        if (!bar) return;
        var kind = roleKind();
        var tabs = [];
        if (kind === 'student') {
            tabs = [{ id: 'mine', label: '我的申请' }];
        } else if (kind === 'leader') {
            tabs = [
                { id: 'pending', label: '待我审批' },
                { id: 'all', label: '本组申请' },
                { id: 'mine', label: '我的申请' }
            ];
        } else {
            tabs = [
                { id: 'pending', label: '待我审批' },
                { id: 'all', label: '全部申请' },
                { id: 'mine', label: '我的申请' }
            ];
        }
        if (!tabs.some(function (t) { return t.id === activeTab; })) activeTab = tabs[0].id;
        bar.innerHTML = tabs.map(function (t) {
            var on = t.id === activeTab;
            return '<button type="button" class="btn' + (on ? '' : ' btn-secondary') + '" style="padding:6px 14px;font-size:13px;" onclick="setApplicationTab(\'' + t.id + '\')">' +
                esc(t.label) + '</button>';
        }).join('');
    }

    function miniSteps(item) {
        var flow = item.flow || [];
        if (!flow.length) return '';
        var cur = Number(item.currentNode) || 0;
        var done = item.status === 'approved';
        var rejected = item.status === 'rejected';
        var parts = ['<span style="color:#16a34a;">提交</span>'];
        flow.forEach(function (n, i) {
            var color = '#9ca3af';
            if (done || (item.approvalRecords || []).some(function (r) { return Number(r.nodeOrder) === i + 1 && r.result === 'approved'; })) color = '#16a34a';
            else if (rejected && i === cur) color = '#dc2626';
            else if ((item.status === 'pending' || item.status === 'reviewing') && i === cur) color = '#2563eb';
            parts.push('<span style="color:' + color + ';">' + esc(n.label || ('节点' + (i + 1))) + '</span>');
        });
        return '<div style="font-size:11px;margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;align-items:center;">' +
            parts.join('<span style="color:#d1d5db;">→</span>') + '</div>';
    }

    function statusBadge(status) {
        var cfg = STATUS_CFG[status] || STATUS_CFG.pending;
        return '<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:' +
            cfg.color + ';background:' + cfg.bg + ';border:1px solid ' + cfg.border + ';">' + esc(cfg.label) + '</span>';
    }

    function typeTag(applyType) {
        var meta = TYPE_META[applyType] || TYPE_META.other;
        return '<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;color:#fff;background:' +
            meta.color + ';">' + esc(meta.short) + '</span>';
    }

    function nodeLabel(item) {
        if (item.status === 'approved') return '已完成';
        if (item.status === 'rejected') return '已驳回';
        if (item.status === 'withdrawn') return '已撤回';
        if (item.status === 'draft') return '草稿';
        var n = currentNodeDef(item);
        return n ? n.label : '—';
    }

    function renderList(list) {
        var box = document.getElementById('applicationList');
        var empty = document.getElementById('applicationEmptyState');
        if (!box) return;
        var kind = roleKind();
        var reviewerView = kind === 'admin' || kind === 'leader';

        if (!list.length) {
            box.innerHTML = '';
            if (empty) empty.style.display = '';
            return;
        }
        if (empty) empty.style.display = 'none';

        var showBatch = reviewerView && activeTab === 'pending';
        var batchBar = document.getElementById('appBatchBar');
        if (batchBar) batchBar.style.display = showBatch ? 'flex' : 'none';

        box.innerHTML = list.map(function (item) {
            var urgent = isUrgentItem(item) && (item.status === 'pending' || item.status === 'reviewing');
            var border = urgent ? '1px solid #fecaca' : '1px solid #eef0f5';
            var bg = urgent ? '#fff7f7' : '#fff';
            var reason = String(item.reason || '').slice(0, 80);
            var check = '';
            if (showBatch && isAwaitingMe(item)) {
                check = '<input type="checkbox" ' + (selectedIds[item.id] ? 'checked' : '') +
                    ' onclick="event.stopPropagation();toggleApplicationSelect(' + item.id + ')" style="margin-top:4px;">';
            }
            var actions = [];
            if (item.status === 'draft' && isMine(item)) {
                actions.push('<button type="button" class="btn" style="padding:4px 10px;font-size:12px;" onclick="event.stopPropagation();editApplicationDraft(' + item.id + ')">继续编辑</button>');
            }
            if (canWithdraw(item)) {
                actions.push('<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="event.stopPropagation();withdrawApplication(' + item.id + ')">撤回</button>');
            }
            if (item.status === 'rejected' && isMine(item)) {
                actions.push('<button type="button" class="btn" style="padding:4px 10px;font-size:12px;" onclick="event.stopPropagation();resubmitApplication(' + item.id + ')">重新提交</button>');
            }
            if (isAwaitingMe(item)) {
                actions.push('<button type="button" class="btn" style="padding:4px 10px;font-size:12px;background:#16a34a;" onclick="event.stopPropagation();openApplicationReview(' + item.id + ',\'approved\')">通过</button>');
                actions.push('<button type="button" class="btn" style="padding:4px 10px;font-size:12px;background:#dc2626;" onclick="event.stopPropagation();openApplicationReview(' + item.id + ',\'rejected\')">驳回</button>');
                if (canReviewAll()) {
                    actions.push('<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="event.stopPropagation();openApplicationReview(' + item.id + ',\'transfer\')">转审</button>');
                }
            }

            if (reviewerView && activeTab !== 'mine') {
                return '<div onclick="showApplicationDetail(' + item.id + ')" style="background:' + bg + ';border:' + border + ';border-radius:14px;padding:16px 18px;margin-bottom:12px;cursor:pointer;display:flex;gap:14px;align-items:flex-start;">' +
                    check +
                    avatarHtml(item.applicant) +
                    '<div style="flex:1;min-width:0;">' +
                    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">' +
                    '<strong style="font-size:15px;color:#111827;">' + esc(item.applicant || '—') + '</strong>' +
                    '<span style="font-size:12px;color:#9ca3af;">' + esc(item.applicantGroup || '未分组') + '</span>' +
                    typeTag(item.applyType) +
                    (urgent ? '<span style="font-size:11px;color:#dc2626;font-weight:700;">紧急</span>' : '') +
                    '</div>' +
                    '<div style="font-size:14px;color:#374151;line-height:1.5;">' + esc(reason) + (String(item.reason || '').length > 80 ? '…' : '') + '</div>' +
                    '<div style="font-size:12px;color:#9ca3af;margin-top:6px;">提交 ' + esc(item.createdAt || '—') +
                    ' · 当前节点：' + esc(nodeLabel(item)) +
                    (item.applyNo ? ' · ' + esc(item.applyNo) : '') + '</div>' +
                    miniSteps(item) +
                    '</div>' +
                    '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0;">' +
                    statusBadge(item.status) +
                    '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;" onclick="event.stopPropagation()">' + actions.join('') + '</div>' +
                    '</div></div>';
            }

            return '<div onclick="showApplicationDetail(' + item.id + ')" style="background:' + bg + ';border:' + border + ';border-radius:14px;padding:16px 18px;margin-bottom:12px;cursor:pointer;">' +
                '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">' +
                '<div style="flex:1;min-width:200px;">' +
                '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">' +
                typeTag(item.applyType) + statusBadge(item.status) +
                (urgent ? '<span style="font-size:11px;color:#dc2626;font-weight:700;">紧急</span>' : '') +
                '</div>' +
                '<div style="font-size:16px;font-weight:700;color:#111827;">' + esc(displayTitle(item)) + '</div>' +
                '<div style="font-size:13px;color:#4b5563;margin-top:6px;">' + esc(reason) + (String(item.reason || '').length > 80 ? '…' : '') + '</div>' +
                '<div style="font-size:12px;color:#9ca3af;margin-top:6px;">提交于 ' + esc(item.createdAt || '—') +
                (item.applyNo ? ' · ' + esc(item.applyNo) : '') + '</div>' +
                miniSteps(item) +
                '</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;" onclick="event.stopPropagation()">' + actions.join('') + '</div>' +
                '</div></div>';
        }).join('');

        updateBatchBar();
    }

    function updateBatchBar() {
        var n = Object.keys(selectedIds).filter(function (k) { return selectedIds[k]; }).length;
        var el = document.getElementById('appBatchCount');
        if (el) el.textContent = '已选 ' + n + ' 项';
    }

    function populateApplicantFilter() {
        var sel = document.getElementById('appApplicantFilter');
        if (!sel) return;
        var show = canReviewAll() || (roleKind() === 'leader');
        sel.style.display = show ? '' : 'none';
        if (!show) return;
        var names = {};
        visibleBaseList().forEach(function (a) {
            if (a.applicant) names[a.applicant] = 1;
        });
        var cur = sel.value;
        sel.innerHTML = '<option value="">全部申请人</option>' +
            Object.keys(names).sort().map(function (n) {
                return '<option value="' + esc(n) + '"' + (cur === n ? ' selected' : '') + '>' + esc(n) + '</option>';
            }).join('');
    }

    function renderApplicationCenter() {
        loadData();
        var badge = document.getElementById('appRoleBadge');
        var kind = roleKind();
        if (badge) {
            badge.textContent = kind === 'admin' ? '导师工作台' : (kind === 'leader' ? '组长审批' : '我的申请');
        }
        var newBtn = document.getElementById('appNewBtn');
        if (newBtn) newBtn.style.display = canSubmit() ? '' : 'none';
        var cfgBtn = document.getElementById('appFlowCfgBtn');
        if (cfgBtn) cfgBtn.style.display = canConfigFlow() ? '' : 'none';
        var expBtn = document.getElementById('appExportBtn');
        if (expBtn) expBtn.style.display = (canReviewAll() || roleKind() === 'leader') ? '' : 'none';

        renderTabs();
        renderStatCards();
        populateApplicantFilter();
        renderList(applyFilters(listForTab()));
    }

    function initApplicationCenter() {
        loadData();
        var kind = roleKind();
        activeTab = (kind === 'admin' || kind === 'leader') ? 'pending' : 'mine';
        activeStat = '';
        selectedIds = {};
        renderApplicationCenter();
        try { if (typeof global.initHolidayLeave === 'function') global.initHolidayLeave(); } catch (eHl) {}
    }

    function setApplicationTab(tab) {
        activeTab = tab;
        activeStat = '';
        selectedIds = {};
        var st = document.getElementById('appStatusFilter');
        if (st) st.value = '';
        renderApplicationCenter();
    }

    function setApplicationStatFilter(key) {
        if (key === '__await__') {
            activeTab = 'pending';
            activeStat = '';
            var st = document.getElementById('appStatusFilter');
            if (st) st.value = '';
        } else if (key === '__month__' || key === '__rate__') {
            activeStat = '';
            if (roleKind() !== 'student') activeTab = 'all';
        } else {
            activeStat = activeStat === key ? '' : key;
            var st2 = document.getElementById('appStatusFilter');
            if (st2) st2.value = activeStat || '';
            if (key === 'pending' && (roleKind() === 'admin' || roleKind() === 'leader')) {
                /* keep current tab */
            }
        }
        renderApplicationCenter();
    }

    function onApplicationFilterChange() {
        activeStat = String((document.getElementById('appStatusFilter') || {}).value || '');
        renderApplicationCenter();
    }

    /* ========== 表单 / 创建 ========== */
    function readProjectPool(storageKey) {
        var list = [];
        try {
            if (Array.isArray(global[storageKey]) && global[storageKey].length) list = global[storageKey];
        } catch (e) {}
        if (!list.length) {
            try {
                var raw = JSON.parse(localStorage.getItem(storageKey) || '[]');
                if (Array.isArray(raw)) list = raw;
            } catch (e2) {}
        }
        return Array.isArray(list) ? list : [];
    }

    function projectDisplayName(p) {
        if (!p) return '';
        return String(p.name || p.title || p.projectName || p.project_name || p.projectTitle || '').trim();
    }

    function collectAllProjects() {
        var groups = [
            { key: 'longitudinalData', src: '纵向项目', prefix: 'lon-' },
            { key: 'horizontalData', src: '横向项目', prefix: 'hor-' },
            { key: 'schoolData', src: '校级项目', prefix: 'sch-' }
        ];
        var out = [];
        var seen = {};
        groups.forEach(function (g) {
            readProjectPool(g.key).forEach(function (p) {
                var name = projectDisplayName(p);
                if (!name) return;
                var id = g.prefix + String(p.id != null ? p.id : name);
                if (seen[id]) return;
                seen[id] = 1;
                out.push({ id: id, name: name, src: g.src, status: p.status || '' });
            });
        });
        return out;
    }

    function projectOptionsHtml(selected) {
        var pools = collectAllProjects();
        var bySrc = {};
        pools.forEach(function (p) {
            if (!bySrc[p.src]) bySrc[p.src] = [];
            bySrc[p.src].push(p);
        });
        var html = '<option value="">不关联项目</option>';
        html += '<option value="__custom__"' + (selected === '__custom__' ? ' selected' : '') + '>其他项目（手动填写）</option>';
        Object.keys(bySrc).forEach(function (src) {
            html += '<optgroup label="' + esc(src) + '（' + bySrc[src].length + '）">';
            bySrc[src].forEach(function (p) {
                var hint = p.status ? ' · ' + p.status : '';
                html += '<option value="' + esc(p.id) + '" data-name="' + esc(p.name) + '"' +
                    (String(selected) === String(p.id) ? ' selected' : '') + '>' +
                    esc(p.name + hint) + '</option>';
            });
            html += '</optgroup>';
        });
        if (!pools.length) {
            html += '<optgroup label="暂无台账项目"><option value="" disabled>请先在项目管理中录入，或选手动填写</option></optgroup>';
        }
        return html;
    }

    function onAppProjectChange() {
        var sel = document.getElementById('af_project');
        var wrap = document.getElementById('af_projectCustomWrap');
        if (!sel || !wrap) return;
        wrap.style.display = sel.value === '__custom__' ? '' : 'none';
    }

    function flowPreviewHtml(applyType, formData) {
        var flow = resolveFlow(applyType, formData || {});
        return '<div style="margin-top:16px;padding:12px 14px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;">' +
            '<div style="font-size:12px;color:#64748b;margin-bottom:6px;">审批流程预览</div>' +
            '<div style="font-size:13px;color:#334155;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
            '<span style="color:#16a34a;font-weight:600;">提交</span>' +
            flow.map(function (n) {
                return '<span style="color:#cbd5e1;">→</span><span>' + esc(n.label) + '</span>';
            }).join('') +
            '</div></div>';
    }

    function autoUserFieldsHtml() {
        return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">' +
            '<div style="background:#f8fafc;padding:10px 12px;border-radius:8px;"><div style="font-size:11px;color:#94a3b8;">申请人</div><div style="font-size:13px;font-weight:600;">' + esc(myName()) + '</div></div>' +
            '<div style="background:#f8fafc;padding:10px 12px;border-radius:8px;"><div style="font-size:11px;color:#94a3b8;">学号</div><div style="font-size:13px;font-weight:600;">' + esc(myStudentId() || '—') + '</div></div>' +
            '<div style="background:#f8fafc;padding:10px 12px;border-radius:8px;"><div style="font-size:11px;color:#94a3b8;">所属小组</div><div style="font-size:13px;font-weight:600;">' + esc(myGroup() || '—') + '</div></div>' +
            '</div>';
    }

    function attachAreaHtml() {
        return '<div class="form-group"><label>附件（证明材料/发票，最多5个，单文件≤2MB）</label>' +
            '<input type="file" id="appAttachInput" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx,image/*" onchange="handleApplicationAttachUpload(event)" style="font-size:13px;">' +
            '<div id="appAttachList" style="margin-top:8px;"></div></div>';
    }

    function renderAttachList() {
        var box = document.getElementById('appAttachList');
        if (!box) return;
        if (!pendingAttachments.length) { box.innerHTML = '<span style="font-size:12px;color:#94a3b8;">暂无附件</span>'; return; }
        box.innerHTML = pendingAttachments.map(function (a, i) {
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:#f8fafc;border-radius:6px;margin-bottom:4px;font-size:12px;">' +
                '<span>' + esc(a.name) + '</span>' +
                '<button type="button" class="btn btn-secondary" style="padding:2px 8px;font-size:11px;" onclick="removeApplicationAttach(' + i + ')">移除</button></div>';
        }).join('');
    }

    function removeApplicationAttach(i) {
        i = Number(i);
        if (i >= 0 && i < pendingAttachments.length) {
            pendingAttachments.splice(i, 1);
            renderAttachList();
        }
    }

    function handleApplicationAttachUpload(event) {
        var files = event.target.files;
        if (!files || !files.length) return;
        Array.prototype.forEach.call(files, function (file) {
            if (pendingAttachments.length >= 5) { alert('最多 5 个附件'); return; }
            if (file.size > 2 * 1024 * 1024) { alert(file.name + ' 超过 2MB，已跳过'); return; }
            var reader = new FileReader();
            reader.onload = function (e) {
                pendingAttachments.push({ name: file.name, dataUrl: e.target.result, size: file.size });
                renderAttachList();
            };
            reader.readAsDataURL(file);
        });
        event.target.value = '';
    }

    function handleDetailImageUpload(event) {
        var files = event.target.files;
        if (!files || !files.length) return;
        Array.prototype.forEach.call(files, function (file) {
            if (pendingDetailImages.length >= 8) { alert('明细图片最多 8 张'); return; }
            if (!/^image\//.test(file.type) && !/\.(jpe?g|png|gif|webp)$/i.test(file.name)) {
                alert(file.name + ' 不是图片，已跳过');
                return;
            }
            if (file.size > 2 * 1024 * 1024) { alert(file.name + ' 超过 2MB，已跳过'); return; }
            var reader = new FileReader();
            reader.onload = function (e) {
                pendingDetailImages.push({ name: file.name, dataUrl: e.target.result, size: file.size });
                renderDetailImageList();
            };
            reader.readAsDataURL(file);
        });
        event.target.value = '';
    }

    function removeDetailImage(i) {
        pendingDetailImages.splice(i, 1);
        renderDetailImageList();
    }

    function renderDetailImageList() {
        var box = document.getElementById('af_detailImgList');
        if (!box) return;
        if (!pendingDetailImages.length) {
            box.innerHTML = '<span style="font-size:12px;color:#94a3b8;">暂无明细图片</span>';
            return;
        }
        box.innerHTML = pendingDetailImages.map(function (img, i) {
            return '<div style="position:relative;width:88px;height:88px;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;background:#f8fafc;">' +
                '<img src="' + String(img.dataUrl).replace(/"/g, '&quot;') + '" alt="' + esc(img.name) + '" style="width:100%;height:100%;object-fit:cover;">' +
                '<button type="button" onclick="removeDetailImage(' + i + ')" title="删除" style="position:absolute;top:2px;right:2px;width:22px;height:22px;border:none;border-radius:50%;background:rgba(15,23,42,.65);color:#fff;cursor:pointer;font-size:12px;line-height:22px;padding:0;">×</button></div>';
        }).join('');
    }

    function showApplicationCreateModal() {
        if (!canSubmit()) { alert('当前账号无权提交申请'); return; }
        createStep = 'pick';
        createType = '';
        pendingAttachments = [];
        pendingDetailImages = [];
        editingDraftId = null;
        resubmitFromId = null;
        var titleEl = document.getElementById('applicationModalTitle');
        var hintEl = document.getElementById('applicationModalHint');
        var panel = document.getElementById('applicationModalPanel');
        if (titleEl) titleEl.textContent = '新建申请';
        if (hintEl) hintEl.textContent = '第一步：选择申请类型';
        if (panel) panel.style.maxWidth = '820px';
        renderTypePicker();
        var modal = document.getElementById('applicationModal');
        if (modal) modal.style.display = 'flex';
    }

    function renderTypePicker() {
        var body = document.getElementById('applicationModalBody');
        if (!body) return;
        var cards = Object.keys(TYPE_META).map(function (k) {
            var m = TYPE_META[k];
            return '<button type="button" onclick="selectApplicationType(\'' + k + '\')" style="text-align:left;border:1px solid #e5e7eb;border-radius:14px;padding:16px;background:#fff;cursor:pointer;transition:border-color .15s;">' +
                '<div style="width:36px;height:36px;border-radius:10px;background:' + m.color + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;margin-bottom:10px;">' + esc(m.ico) + '</div>' +
                '<div style="font-size:14px;font-weight:700;color:#111827;">' + esc(m.label) + '</div>' +
                '<div style="font-size:12px;color:#94a3b8;margin-top:4px;">自动加载表单模板</div></button>';
        }).join('');
        var tpls = loadPersonalTemplates();
        var tplHtml = '';
        if (tpls.length) {
            tplHtml = '<div style="margin-top:18px;"><div style="font-size:13px;font-weight:600;margin-bottom:8px;">我的模板</div>' +
                tpls.map(function (t, i) {
                    return '<button type="button" class="btn btn-secondary" style="margin:0 8px 8px 0;padding:6px 12px;font-size:12px;" onclick="applyPersonalTemplate(' + i + ')">' +
                        esc(t.name || typeLabel(t.applyType)) + '</button>';
                }).join('') + '</div>';
        }
        body.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;">' + cards + '</div>' + tplHtml;
    }

    function selectApplicationType(type) {
        createType = type;
        createStep = 'form';
        var titleEl = document.getElementById('applicationModalTitle');
        var hintEl = document.getElementById('applicationModalHint');
        if (titleEl) titleEl.textContent = '填写 · ' + ((TYPE_META[type] && TYPE_META[type].label) || type);
        if (hintEl) hintEl.textContent = '申请人信息已自动填充';
        renderCreateForm({});
    }

    function typeFieldsHtml(type, fd) {
        fd = fd || {};
        if (type === 'leave') {
            return '<div class="form-group"><label>请假类型 <span style="color:red;">*</span></label>' +
                '<select id="af_leaveType" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;">' +
                ['事假', '病假', '年假', '科研外出', '其他'].map(function (t) {
                    return '<option value="' + t + '"' + (fd.leaveType === t ? ' selected' : '') + '>' + t + '</option>';
                }).join('') + '</select></div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<div class="form-group"><label>开始时间 <span style="color:red;">*</span></label><input type="datetime-local" id="af_startAt" value="' + esc(fd.startAt || '') + '" onchange="validateAppTimeRange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>结束时间 <span style="color:red;">*</span></label><input type="datetime-local" id="af_endAt" value="' + esc(fd.endAt || '') + '" onchange="validateAppTimeRange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div></div>' +
                '<div id="af_daysHint" style="font-size:12px;color:#7c3aed;margin-bottom:10px;"></div>' +
                '<div class="form-group"><label>去向</label><input type="text" id="af_destination" value="' + esc(fd.destination || '') + '" placeholder="请假期间去向" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>紧急联系人</label><input type="text" id="af_contact" value="' + esc(fd.contact || '') + '" placeholder="姓名 + 手机号" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>';
        }
        if (type === 'trip') {
            return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<div class="form-group"><label>出发时间 <span style="color:red;">*</span></label><input type="datetime-local" id="af_startAt" value="' + esc(fd.startAt || '') + '" onchange="validateAppTimeRange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>返回时间 <span style="color:red;">*</span></label><input type="datetime-local" id="af_endAt" value="' + esc(fd.endAt || '') + '" onchange="validateAppTimeRange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div></div>' +
                '<div id="af_daysHint" style="font-size:12px;color:#7c3aed;margin-bottom:10px;"></div>' +
                '<div class="form-group"><label>目的地 <span style="color:red;">*</span></label><input type="text" id="af_destination" value="' + esc(fd.destination || '') + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>随行人员</label><input type="text" id="af_companions" value="' + esc(fd.companions || '') + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>经费来源项目</label><select id="af_project" onchange="onAppProjectChange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;">' + projectOptionsHtml(fd.projectId) + '</select></div>' +
                '<div class="form-group" id="af_projectCustomWrap" style="display:' + (fd.projectId === '__custom__' || fd.customProject ? 'block' : 'none') + ';"><label>项目名称（手填）</label><input type="text" id="af_projectCustom" value="' + esc(fd.customProject || fd.projectName || '') + '" placeholder="输入项目全称" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>';
        }
        if (type === 'equipment') {
            return '<div class="form-group"><label>设备名称/编号 <span style="color:red;">*</span></label><input type="text" id="af_device" value="' + esc(fd.device || '') + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<div class="form-group"><label>借用开始 <span style="color:red;">*</span></label><input type="datetime-local" id="af_startAt" value="' + esc(fd.startAt || '') + '" onchange="validateAppTimeRange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>预计归还 <span style="color:red;">*</span></label><input type="datetime-local" id="af_endAt" value="' + esc(fd.endAt || '') + '" onchange="validateAppTimeRange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div></div>' +
                '<div id="af_daysHint" style="font-size:12px;color:#7c3aed;margin-bottom:10px;"></div>' +
                '<div class="form-group"><label>用途 <span style="color:red;">*</span></label><input type="text" id="af_purpose" value="' + esc(fd.purpose || '') + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label><input type="checkbox" id="af_returnPromise" ' + (fd.returnPromise !== false ? 'checked' : '') + '> 本人承诺按期完好归还设备</label></div>';
        }
        if (type === 'reimburse') {
            return '<div class="form-group"><label>报销金额（元） <span style="color:red;">*</span></label><input type="number" min="0" step="0.01" id="af_amount" value="' + esc(fd.amount || '') + '" onchange="refreshFlowPreview()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>关联项目</label>' +
                '<select id="af_project" onchange="onAppProjectChange()" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;">' + projectOptionsHtml(fd.projectId) + '</select>' +
                '<div style="font-size:12px;color:#94a3b8;margin-top:4px;">含纵向 / 横向 / 校级台账项目，也可选手动填写</div></div>' +
                '<div class="form-group" id="af_projectCustomWrap" style="display:' + (fd.projectId === '__custom__' || fd.customProject ? 'block' : 'none') + ';"><label>项目名称（手填） <span style="color:red;">*</span></label><input type="text" id="af_projectCustom" value="' + esc(fd.customProject || (fd.projectId === '__custom__' ? fd.projectName : '') || '') + '" placeholder="输入项目全称" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>报销明细 <span style="color:red;">*</span></label>' +
                '<textarea id="af_detail" rows="3" placeholder="文字说明费用明细..." style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;">' + esc(fd.detail || '') + '</textarea>' +
                '<div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                '<label class="btn btn-secondary" style="padding:6px 12px;font-size:12px;cursor:pointer;margin:0;">上传明细图片' +
                '<input type="file" id="af_detailImgInput" accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png" multiple style="display:none;" onchange="handleDetailImageUpload(event)">' +
                '</label>' +
                '<span style="font-size:12px;color:#94a3b8;">支持 JPG/PNG，最多 8 张，单张 ≤ 2MB</span></div>' +
                '<div id="af_detailImgList" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;"></div></div>' +
                '<div style="font-size:12px;color:#7c3aed;margin-bottom:8px;">审批流程：提交 → 导师审批（无需组长）</div>';
        }
        if (type === 'stay') {
            return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<div class="form-group"><label>留校开始 <span style="color:red;">*</span></label><input type="date" id="af_startAt" value="' + esc(String(fd.startAt || '').slice(0, 10)) + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>留校结束 <span style="color:red;">*</span></label><input type="date" id="af_endAt" value="' + esc(String(fd.endAt || '').slice(0, 10)) + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div></div>' +
                '<div class="form-group"><label>留校地点</label><input type="text" id="af_destination" value="' + esc(fd.destination || '') + '" placeholder="宿舍/实验室" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>紧急联系人</label><input type="text" id="af_contact" value="' + esc(fd.contact || '') + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>';
        }
        if (type === 'defense') {
            return '<div class="form-group"><label>类型 <span style="color:red;">*</span></label><select id="af_defenseType" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;">' +
                ['开题', '中期', '预答辩', '答辩'].map(function (t) {
                    return '<option value="' + t + '"' + (fd.defenseType === t ? ' selected' : '') + '>' + t + '</option>';
                }).join('') + '</select></div>' +
                '<div class="form-group"><label>拟安排时间</label><input type="datetime-local" id="af_startAt" value="' + esc(fd.startAt || '') + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>' +
                '<div class="form-group"><label>论文/课题题目</label><input type="text" id="af_thesisTitle" value="' + esc(fd.thesisTitle || '') + '" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>';
        }
        return '<div class="form-group"><label>申请标题 <span style="color:red;">*</span></label><input type="text" id="af_title" value="' + esc(fd.title || '') + '" placeholder="如：盖章申请" style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;"></div>';
    }

    function renderCreateForm(preset) {
        preset = preset || {};
        var type = createType || preset.applyType || 'leave';
        createType = type;
        var fd = Object.assign({}, preset.formData || {}, preset);
        if (preset.reason) fd._reason = preset.reason;
        if (preset.title) fd.title = preset.title;
        pendingAttachments = Array.isArray(preset.attachments) ? preset.attachments.slice() : pendingAttachments;
        pendingDetailImages = Array.isArray((preset.formData && preset.formData.detailImages) || preset.detailImages)
            ? ((preset.formData && preset.formData.detailImages) || preset.detailImages).slice()
            : (createType === 'reimburse' ? pendingDetailImages : []);
        if (createType !== 'reimburse') pendingDetailImages = [];
        var body = document.getElementById('applicationModalBody');
        if (!body) return;
        body.innerHTML = autoUserFieldsHtml() +
            typeFieldsHtml(type, fd) +
            '<div class="form-group"><label>事由说明 <span style="color:red;">*</span></label>' +
            '<textarea id="af_reason" rows="4" placeholder="请说明事由..." style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:10px;line-height:1.7;">' +
            esc(preset.reason || fd._reason || '') + '</textarea></div>' +
            attachAreaHtml() +
            '<div id="af_flowPreview">' + flowPreviewHtml(type, fd) + '</div>' +
            '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:18px;flex-wrap:wrap;">' +
            '<div style="display:flex;gap:8px;">' +
            '<button type="button" class="btn btn-secondary" onclick="showApplicationCreateModal()">重选类型</button>' +
            '<button type="button" class="btn btn-secondary" onclick="saveApplicationAsTemplate()">存为模板</button>' +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
            '<button type="button" class="btn btn-secondary" onclick="saveApplicationDraft()">存草稿</button>' +
            '<button type="button" class="btn" onclick="submitApplicationForm()">提交申请</button>' +
            '</div></div>';
        setTimeout(function () {
            renderAttachList();
            renderDetailImageList();
            onAppProjectChange();
            validateAppTimeRange();
        }, 0);
    }

    function validateAppTimeRange() {
        var s = document.getElementById('af_startAt');
        var e = document.getElementById('af_endAt');
        var hint = document.getElementById('af_daysHint');
        if (!s || !e) return true;
        var ok = true;
        if (s.value && e.value && s.value > e.value) {
            e.style.borderColor = '#dc2626';
            s.style.borderColor = '#dc2626';
            ok = false;
            if (hint) hint.innerHTML = '<span style="color:#dc2626;">结束时间不可早于开始时间</span>';
        } else {
            e.style.borderColor = '#e5e7eb';
            s.style.borderColor = '#e5e7eb';
            var days = calcDays(s.value, e.value);
            if (hint) hint.textContent = days ? ('自动计算：共 ' + days + ' 天') : '';
        }
        return ok;
    }

    function refreshFlowPreview() {
        var box = document.getElementById('af_flowPreview');
        if (!box) return;
        var fd = collectFormData().formData;
        box.innerHTML = flowPreviewHtml(createType, fd);
    }

    function collectProjectFields(formData) {
        var proj = document.getElementById('af_project');
        if (!proj) return;
        var val = String(proj.value || '');
        if (!val) return;
        if (val === '__custom__') {
            formData.projectId = '__custom__';
            formData.customProject = String((document.getElementById('af_projectCustom') || {}).value || '').trim();
            formData.projectName = formData.customProject;
        } else {
            formData.projectId = val;
            formData.projectName = proj.options[proj.selectedIndex]
                ? (proj.options[proj.selectedIndex].getAttribute('data-name') || proj.options[proj.selectedIndex].textContent || '')
                : '';
            formData.customProject = '';
        }
    }

    function collectFormData() {
        var type = createType;
        var formData = {};
        var title = '';
        var reason = String((document.getElementById('af_reason') || {}).value || '').trim();
        var startAt = String((document.getElementById('af_startAt') || {}).value || '').trim();
        var endAt = String((document.getElementById('af_endAt') || {}).value || '').trim();
        var contact = String((document.getElementById('af_contact') || {}).value || '').trim();

        if (type === 'leave') {
            formData.leaveType = String((document.getElementById('af_leaveType') || {}).value || '');
            formData.startAt = startAt;
            formData.endAt = endAt;
            formData.destination = String((document.getElementById('af_destination') || {}).value || '').trim();
            formData.contact = contact;
            formData.days = calcDays(startAt, endAt);
            title = formData.leaveType || '请假';
        } else if (type === 'trip') {
            formData.startAt = startAt;
            formData.endAt = endAt;
            formData.destination = String((document.getElementById('af_destination') || {}).value || '').trim();
            formData.companions = String((document.getElementById('af_companions') || {}).value || '').trim();
            formData.days = calcDays(startAt, endAt);
            collectProjectFields(formData);
            title = '出差 · ' + (formData.destination || '');
        } else if (type === 'equipment') {
            formData.device = String((document.getElementById('af_device') || {}).value || '').trim();
            formData.startAt = startAt;
            formData.endAt = endAt;
            formData.purpose = String((document.getElementById('af_purpose') || {}).value || '').trim();
            formData.returnPromise = !!(document.getElementById('af_returnPromise') || {}).checked;
            title = '借用 · ' + (formData.device || '');
        } else if (type === 'reimburse') {
            formData.amount = parseFloat((document.getElementById('af_amount') || {}).value || 0) || 0;
            formData.detail = String((document.getElementById('af_detail') || {}).value || '').trim();
            formData.detailImages = pendingDetailImages.slice();
            collectProjectFields(formData);
            title = '报销 ¥' + formData.amount;
        } else if (type === 'stay') {
            formData.startAt = startAt;
            formData.endAt = endAt;
            formData.destination = String((document.getElementById('af_destination') || {}).value || '').trim();
            formData.contact = contact;
            title = '假期留校';
        } else if (type === 'defense') {
            formData.defenseType = String((document.getElementById('af_defenseType') || {}).value || '');
            formData.startAt = startAt;
            formData.thesisTitle = String((document.getElementById('af_thesisTitle') || {}).value || '').trim();
            title = formData.defenseType + '申请';
        } else {
            title = String((document.getElementById('af_title') || {}).value || '').trim();
            formData.title = title;
        }

        return { title: title, reason: reason, formData: formData, startAt: startAt, endAt: endAt, contact: contact };
    }

    function validateCreate(payload, asDraft) {
        if (!payload.reason && !asDraft) { alert('请填写事由说明'); return false; }
        var t = createType;
        var fd = payload.formData;
        if (asDraft) return true;
        if (!validateAppTimeRange()) { alert('请修正时间范围'); return false; }
        if (t === 'leave') {
            if (!fd.leaveType || !fd.startAt || !fd.endAt) { alert('请完整填写请假信息'); return false; }
        } else if (t === 'trip') {
            if (!fd.startAt || !fd.endAt || !fd.destination) { alert('请完整填写出差信息'); return false; }
        } else if (t === 'equipment') {
            if (!fd.device || !fd.startAt || !fd.endAt || !fd.purpose) { alert('请完整填写设备借用信息'); return false; }
            if (!fd.returnPromise) { alert('请勾选归还承诺'); return false; }
        } else if (t === 'reimburse') {
            if (!fd.amount || (!fd.detail && !(fd.detailImages && fd.detailImages.length))) {
                alert('请填写报销金额，并填写明细文字或上传明细图片');
                return false;
            }
            if (fd.projectId === '__custom__' && !fd.customProject) {
                alert('请填写关联项目名称');
                return false;
            }
        } else if (t === 'stay') {
            if (!fd.startAt || !fd.endAt) { alert('请填写留校起止日期'); return false; }
        } else if (t === 'defense') {
            if (!fd.defenseType) { alert('请选择答辩类型'); return false; }
        } else if (t === 'other') {
            if (!payload.title) { alert('请填写申请标题'); return false; }
        }
        return true;
    }

    function buildItemFromForm(status) {
        var payload = collectFormData();
        var asDraft = status === 'draft';
        if (!validateCreate(payload, asDraft)) return null;
        var flow = resolveFlow(createType, payload.formData);
        var urgent = false;
        if (createType === 'leave') {
            var today = new Date();
            var ymd = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
            if (String(payload.formData.startAt || '').slice(0, 10) === ymd) urgent = true;
        }
        if (createType === 'reimburse' && (payload.formData.amount || 0) >= REIMBURSE_LARGE) urgent = true;

        var item = normalize({
            id: editingDraftId || nextId(),
            applyNo: genApplyNo(),
            applyType: createType,
            title: payload.title,
            reason: payload.reason,
            formData: payload.formData,
            attachments: pendingAttachments.slice(),
            leaveType: payload.formData.leaveType || '',
            startAt: payload.formData.startAt || payload.startAt || '',
            endAt: payload.formData.endAt || payload.endAt || '',
            contact: payload.formData.contact || payload.contact || '',
            applicant: myName(),
            applicantId: myApplicantId(),
            applicantGroup: myGroup(),
            studentId: myStudentId(),
            status: status,
            currentNode: 0,
            flow: flow,
            version: 1,
            urgent: urgent,
            projectId: payload.formData.projectId || null,
            projectName: payload.formData.projectName || '',
            createdAt: nowStr(),
            updatedAt: nowStr(),
            approvalRecords: [],
            parentId: resubmitFromId
        });
        return item;
    }

    function saveApplicationDraft() {
        var item = buildItemFromForm('draft');
        if (!item) return;
        var idx = applicationData.findIndex(function (a) { return Number(a.id) === Number(item.id); });
        if (idx >= 0) applicationData[idx] = item;
        else applicationData.unshift(item);
        saveData({ log: { action: '草稿', desc: '保存草稿：' + displayTitle(item), detail: { id: item.id } } });
        closeApplicationModal();
        activeTab = 'mine';
        renderApplicationCenter();
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('草稿已保存', false);
        else alert('草稿已保存');
    }

    function submitApplicationForm() {
        var item = buildItemFromForm('pending');
        if (!item) return;
        var idx = applicationData.findIndex(function (a) { return Number(a.id) === Number(item.id); });
        if (idx >= 0) applicationData[idx] = item;
        else applicationData.unshift(item);
        if (resubmitFromId) {
            var old = applicationData.find(function (a) { return Number(a.id) === Number(resubmitFromId); });
            if (old && old.status === 'rejected') {
                old.updatedAt = nowStr();
            }
        }
        saveData({ log: { action: '提交', desc: '提交申请：' + displayTitle(item), detail: { id: item.id, type: item.applyType } } });
        notifyApprovers(item);
        closeApplicationModal();
        activeTab = 'mine';
        renderApplicationCenter();
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('申请已提交，已通知审批人', false);
        else alert('申请已提交');
    }

    function editApplicationDraft(id) {
        loadData();
        var item = applicationData.find(function (a) { return Number(a.id) === Number(id); });
        if (!item || !isMine(item) || item.status !== 'draft') return;
        editingDraftId = item.id;
        createType = item.applyType;
        createStep = 'form';
        pendingAttachments = (item.attachments || []).slice();
        var titleEl = document.getElementById('applicationModalTitle');
        if (titleEl) titleEl.textContent = '继续编辑草稿';
        renderCreateForm(item);
        var modal = document.getElementById('applicationModal');
        if (modal) modal.style.display = 'flex';
    }

    function resubmitApplication(id) {
        loadData();
        var item = applicationData.find(function (a) { return Number(a.id) === Number(id); });
        if (!item || !isMine(item) || item.status !== 'rejected') return;
        resubmitFromId = item.id;
        editingDraftId = null;
        createType = item.applyType;
        pendingAttachments = (item.attachments || []).slice();
        var titleEl = document.getElementById('applicationModalTitle');
        if (titleEl) titleEl.textContent = '修改并重新提交';
        renderCreateForm(item);
        var modal = document.getElementById('applicationModal');
        if (modal) modal.style.display = 'flex';
    }

    /* ========== 模板 ========== */
    function loadPersonalTemplates() {
        try {
            var all = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '{}');
            var list = all[myApplicantId()] || all[myName()] || [];
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }

    function savePersonalTemplates(list) {
        try {
            var all = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '{}') || {};
            all[myApplicantId() || myName()] = list;
            localStorage.setItem(TEMPLATE_KEY, JSON.stringify(all));
        } catch (e) {}
    }

    function saveApplicationAsTemplate() {
        var payload = collectFormData();
        var name = prompt('模板名称', displayTitle({ title: payload.title, applyType: createType, leaveType: payload.formData.leaveType }) || typeLabel(createType));
        if (!name) return;
        var list = loadPersonalTemplates();
        list.unshift({
            name: name,
            applyType: createType,
            title: payload.title,
            reason: payload.reason,
            formData: payload.formData
        });
        savePersonalTemplates(list.slice(0, 20));
        alert('模板已保存');
    }

    function applyPersonalTemplate(i) {
        var list = loadPersonalTemplates();
        var t = list[i];
        if (!t) return;
        createType = t.applyType;
        createStep = 'form';
        pendingAttachments = [];
        renderCreateForm(t);
    }

    /* ========== 详情 / 审批 ========== */
    function timelineHtml(item) {
        var nodes = [{ label: '提交申请', done: true, meta: (item.applicant || '') + ' · ' + (item.createdAt || '') }];
        (item.flow || []).forEach(function (n, i) {
            var rec = (item.approvalRecords || []).find(function (r) { return Number(r.nodeOrder) === i + 1; });
            var isCur = (item.status === 'pending' || item.status === 'reviewing') && (Number(item.currentNode) || 0) === i;
            var color = '#94a3b8';
            var label = n.label;
            var meta = '等待处理';
            if (rec) {
                color = rec.result === 'rejected' ? '#dc2626' : (rec.result === 'transfer' ? '#d97706' : '#16a34a');
                meta = (rec.approver || '') + ' · ' + (rec.at || '') + (rec.opinion ? ('\n意见：' + rec.opinion) : '');
                if (rec.result === 'rejected') label += '（驳回）';
                else if (rec.result === 'transfer') label += '（转审）';
                else label += '（通过）';
            } else if (isCur) {
                color = '#2563eb';
                meta = '当前节点';
            }
            nodes.push({ label: label, color: color, meta: meta, current: isCur });
        });
        if (item.status === 'approved') {
            nodes.push({ label: '流程完成', done: true, meta: item.reviewedAt || '', color: '#16a34a' });
        }
        return '<div style="padding-left:4px;">' + nodes.map(function (n, idx) {
            var c = n.color || (n.done ? '#16a34a' : '#94a3b8');
            return '<div style="display:flex;gap:12px;margin-bottom:16px;">' +
                '<div style="display:flex;flex-direction:column;align-items:center;">' +
                '<div style="width:12px;height:12px;border-radius:50%;background:' + c + ';box-shadow:' + (n.current ? '0 0 0 4px rgba(37,99,235,.2)' : 'none') + ';"></div>' +
                (idx < nodes.length - 1 ? '<div style="width:2px;flex:1;background:#e2e8f0;margin-top:4px;"></div>' : '') +
                '</div>' +
                '<div style="padding-bottom:4px;">' +
                '<div style="font-size:13px;font-weight:600;color:#111827;">' + esc(n.label) + '</div>' +
                '<div style="font-size:12px;color:#64748b;white-space:pre-wrap;margin-top:2px;">' + esc(n.meta || '') + '</div>' +
                '</div></div>';
        }).join('') + '</div>';
    }

    function detailFieldsHtml(item) {
        var fd = item.formData || {};
        var rows = [
            ['申请编号', esc(item.applyNo || item.id)],
            ['申请类型', typeTag(item.applyType)],
            ['状态', statusBadge(item.status)],
            ['申请人', esc(item.applicant || '—') + (item.studentId ? '（' + esc(item.studentId) + '）' : '')],
            ['所属小组', esc(item.applicantGroup || '—')],
            ['提交时间', esc(item.createdAt || '—')]
        ];
        Object.keys(fd).forEach(function (k) {
            if (k === 'title' || fd[k] === '' || fd[k] == null || fd[k] === false) return;
            if (typeof fd[k] === 'boolean') {
                rows.push([k, fd[k] ? '是' : '否']);
                return;
            }
            var labelMap = {
                leaveType: '请假类型', startAt: '开始时间', endAt: '结束时间', days: '天数',
                destination: '去向/目的地', contact: '紧急联系', companions: '随行人员',
                device: '设备', purpose: '用途', amount: '金额(元)', detail: '报销明细',
                projectName: '关联项目', defenseType: '答辩类型', thesisTitle: '题目', returnPromise: '归还承诺'
            };
            if (k === 'projectId' || k === 'customProject' || k === 'detailImages') return;
            rows.push([labelMap[k] || k, esc(String(fd[k]))]);
        });
        if (fd.detailImages && fd.detailImages.length) {
            rows.push(['明细图片', '<div style="display:flex;flex-wrap:wrap;gap:8px;">' + fd.detailImages.map(function (img) {
                return '<a href="' + String(img.dataUrl || '#').replace(/"/g, '&quot;') + '" target="_blank" rel="noopener"><img src="' + String(img.dataUrl || '').replace(/"/g, '&quot;') + '" alt="' + esc(img.name || '明细') + '" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;"></a>';
            }).join('') + '</div>']);
        }
        rows.push(['事由', '<div style="white-space:pre-wrap;line-height:1.7;">' + esc(item.reason || '—') + '</div>']);
        if (item.attachments && item.attachments.length) {
            rows.push(['附件', item.attachments.map(function (a) {
                return '<a href="' + String(a.dataUrl || '#').replace(/"/g, '&quot;') + '" download="' + esc(a.name) + '" style="display:inline-block;margin:2px 8px 2px 0;font-size:12px;color:#7c3aed;">' + esc(a.name) + '</a>';
            }).join('')]);
        }
        return rows.map(function (r) {
            return '<div style="margin-bottom:12px;"><div style="font-size:11px;color:#94a3b8;margin-bottom:3px;">' + esc(r[0]) + '</div><div style="font-size:14px;color:#111827;">' + r[1] + '</div></div>';
        }).join('');
    }

    function showApplicationDetail(id) {
        loadData();
        var item = applicationData.find(function (a) { return Number(a.id) === Number(id); });
        if (!item || !canSeeItem(item)) { alert('无权查看'); return; }
        var titleEl = document.getElementById('applicationModalTitle');
        var hintEl = document.getElementById('applicationModalHint');
        var panel = document.getElementById('applicationModalPanel');
        var body = document.getElementById('applicationModalBody');
        if (titleEl) titleEl.textContent = displayTitle(item);
        if (hintEl) hintEl.textContent = (item.applyNo || '') + ' · ' + typeLabel(item.applyType);
        if (panel) panel.style.maxWidth = '960px';
        if (!body) return;

        var actions = [];
        if (canWithdraw(item)) actions.push('<button class="btn btn-secondary" type="button" onclick="withdrawApplication(' + item.id + ');closeApplicationModal();">撤回</button>');
        if (item.status === 'rejected' && isMine(item)) actions.push('<button class="btn" type="button" onclick="closeApplicationModal();resubmitApplication(' + item.id + ')">重新提交</button>');
        if (item.status === 'draft' && isMine(item)) actions.push('<button class="btn" type="button" onclick="closeApplicationModal();editApplicationDraft(' + item.id + ')">继续编辑</button>');
        if (isAwaitingMe(item)) {
            actions.push('<button class="btn" type="button" style="background:#16a34a;" onclick="closeApplicationModal();openApplicationReview(' + item.id + ',\'approved\')">通过</button>');
            actions.push('<button class="btn" type="button" style="background:#dc2626;" onclick="closeApplicationModal();openApplicationReview(' + item.id + ',\'rejected\')">驳回</button>');
            if (canReviewAll()) actions.push('<button class="btn btn-secondary" type="button" onclick="closeApplicationModal();openApplicationReview(' + item.id + ',\'transfer\')">转审</button>');
        }
        actions.push('<button class="btn btn-secondary" type="button" onclick="closeApplicationModal()">关闭</button>');

        body.innerHTML = '<div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(260px,0.8fr);gap:20px;">' +
            '<div style="min-width:0;">' + detailFieldsHtml(item) + '</div>' +
            '<div style="background:#f8fafc;border-radius:12px;padding:16px;border:1px solid #e2e8f0;">' +
            '<div style="font-size:13px;font-weight:700;margin-bottom:12px;color:#111827;">审批进度</div>' +
            timelineHtml(item) + '</div></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap;border-top:1px solid #f1f5f9;padding-top:16px;">' +
            actions.join('') + '</div>';

        var modal = document.getElementById('applicationModal');
        if (modal) modal.style.display = 'flex';
    }

    function withdrawApplication(id) {
        loadData();
        var item = applicationData.find(function (a) { return Number(a.id) === Number(id); });
        if (!item || !canWithdraw(item)) { alert('当前状态不可撤回'); return; }
        if (!confirm('确定撤回该申请？')) return;
        item.status = 'withdrawn';
        item.updatedAt = nowStr();
        item.version = (Number(item.version) || 1) + 1;
        saveData({ log: { action: '撤回', desc: '撤回申请：' + displayTitle(item), detail: { id: item.id } } });
        renderApplicationCenter();
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已撤回', false);
    }

    function openApplicationReview(id, action) {
        loadData();
        var check = applicationData.find(function (a) { return Number(a.id) === Number(id); });
        if (!check || !isAwaitingMe(check)) { alert('无权审批该申请'); return; }
        reviewingId = Number(id);
        reviewAction = action;
        var title = document.getElementById('applicationReviewTitle');
        var req = document.getElementById('appReviewCommentRequired');
        var comment = document.getElementById('appReviewComment');
        var btn = document.getElementById('appReviewConfirmBtn');
        var transferWrap = document.getElementById('appTransferWrap');
        var transferSel = document.getElementById('appTransferTarget');
        if (comment) comment.value = '';
        if (action === 'transfer') {
            if (title) title.textContent = '转审';
            if (req) req.style.display = '';
            if (transferWrap) transferWrap.style.display = '';
            if (transferSel) {
                var mentors = accounts().filter(function (a) { return a && (a.role === 'admin' || a.role === 'leader') && a.realName !== myName(); });
                transferSel.innerHTML = mentors.map(function (a) {
                    return '<option value="' + esc(a.realName) + '">' + esc(a.realName) + '（' + esc(a.role === 'admin' ? '导师' : '组长') + '）</option>';
                }).join('') || '<option value="">暂无可转审对象</option>';
            }
            if (btn) { btn.textContent = '确认转审'; btn.style.background = '#d97706'; }
        } else {
            if (transferWrap) transferWrap.style.display = 'none';
            if (title) title.textContent = action === 'approved' ? '通过申请' : '驳回申请';
            if (req) req.style.display = action === 'rejected' ? '' : 'none';
            if (btn) {
                btn.textContent = action === 'approved' ? '确认通过' : '确认驳回';
                btn.style.background = action === 'approved' ? '#16a34a' : '#dc2626';
            }
        }
        var modal = document.getElementById('applicationReviewModal');
        if (modal) modal.style.display = 'flex';
    }

    function confirmApplicationReview() {
        loadData();
        var item = applicationData.find(function (a) { return Number(a.id) === Number(reviewingId); });
        if (!item || !isAwaitingMe(item)) { alert('该申请不可审批（可能已被他人处理）'); closeApplicationReviewModal(); return; }
        var comment = String((document.getElementById('appReviewComment') || {}).value || '').trim();
        if (reviewAction === 'rejected' && !comment) { alert('驳回时请填写审批意见'); return; }
        if (reviewAction === 'transfer' && !comment) { alert('转审请填写说明'); return; }

        var expectedVersion = Number(item.version) || 1;
        // 乐观锁：再读一次
        loadData();
        item = applicationData.find(function (a) { return Number(a.id) === Number(reviewingId); });
        if (!item || (Number(item.version) || 1) !== expectedVersion) {
            alert('申请状态已变更，请刷新后重试');
            closeApplicationReviewModal();
            renderApplicationCenter();
            return;
        }

        var nodeIdx = Number(item.currentNode) || 0;
        var node = item.flow[nodeIdx];

        if (reviewAction === 'transfer') {
            var target = String((document.getElementById('appTransferTarget') || {}).value || '');
            if (!target) { alert('请选择转审对象'); return; }
            item.approvalRecords = item.approvalRecords || [];
            item.approvalRecords.push({
                nodeOrder: nodeIdx + 1,
                approver: myName(),
                approverId: myApplicantId(),
                result: 'transfer',
                opinion: comment + ' → 转给 ' + target,
                at: nowStr()
            });
            item.reviewComment = comment;
            item.reviewedBy = myName();
            item.reviewedAt = nowStr();
            item.updatedAt = nowStr();
            item.version = expectedVersion + 1;
            // 转审后保持当前节点，通知目标人
            saveData({ log: { action: '转审', desc: '转审申请：' + displayTitle(item), detail: { id: item.id, to: target } } });
            pushSystemNotice({
                title: '【系统通知】转审待办：' + displayTitle(item),
                content: '有一条申请转审给您，请尽快处理。\n编号：' + (item.applyNo || item.id) + '\n意见：' + comment,
                names: [target],
                urgent: isUrgentItem(item)
            });
            closeApplicationReviewModal();
            renderApplicationCenter();
            return;
        }

        if (reviewAction === 'rejected') {
            item.approvalRecords = item.approvalRecords || [];
            item.approvalRecords.push({
                nodeOrder: nodeIdx + 1,
                approver: myName(),
                approverId: myApplicantId(),
                result: 'rejected',
                opinion: comment,
                at: nowStr()
            });
            item.status = 'rejected';
            item.reviewComment = comment;
            item.reviewedBy = myName();
            item.reviewedAt = nowStr();
            item.updatedAt = nowStr();
            item.version = expectedVersion + 1;
            saveData({ log: { action: '驳回', desc: '驳回申请：' + displayTitle(item), detail: { id: item.id } } });
            notifyApplicantResult(item, '已驳回');
            closeApplicationReviewModal();
            renderApplicationCenter();
            if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已驳回并通知申请人', false);
            return;
        }

        // approved at current node
        item.approvalRecords = item.approvalRecords || [];
        item.approvalRecords.push({
            nodeOrder: nodeIdx + 1,
            approver: myName(),
            approverId: myApplicantId(),
            result: 'approved',
            opinion: comment,
            at: nowStr()
        });
        item.reviewComment = comment;
        item.reviewedBy = myName();
        item.reviewedAt = nowStr();
        item.updatedAt = nowStr();
        item.version = expectedVersion + 1;

        if (nodeIdx + 1 >= (item.flow || []).length) {
            item.status = 'approved';
            item.currentNode = nodeIdx;
            saveData({ log: { action: '通过', desc: '终审通过：' + displayTitle(item), detail: { id: item.id } } });
            notifyApplicantResult(item, '已通过');
            onFinalApproved(item);
            if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已通过并完成业务联动', false);
        } else {
            item.status = 'reviewing';
            item.currentNode = nodeIdx + 1;
            saveData({ log: { action: '初审通过', desc: '节点通过：' + (node && node.label) + ' · ' + displayTitle(item), detail: { id: item.id, node: nodeIdx } } });
            notifyApprovers(item);
            if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已通过本节点，已通知下一审批人', false);
        }
        closeApplicationReviewModal();
        renderApplicationCenter();
    }

    function closeApplicationModal() {
        var m = document.getElementById('applicationModal');
        if (m) m.style.display = 'none';
    }

    function closeApplicationReviewModal() {
        var m = document.getElementById('applicationReviewModal');
        if (m) m.style.display = 'none';
        reviewingId = null;
        reviewAction = '';
    }

    function toggleApplicationSelect(id) {
        selectedIds[id] = !selectedIds[id];
        updateBatchBar();
    }

    function clearApplicationSelection() {
        selectedIds = {};
        renderApplicationCenter();
    }

    function batchApproveApplications() {
        var ids = Object.keys(selectedIds).filter(function (k) { return selectedIds[k]; }).map(Number);
        if (!ids.length) { alert('请先勾选申请'); return; }
        if (!confirm('确认批量通过选中的 ' + ids.length + ' 条申请？')) return;
        ids.forEach(function (id) {
            loadData();
            var item = applicationData.find(function (a) { return Number(a.id) === Number(id); });
            if (!item || !isAwaitingMe(item)) return;
            reviewingId = id;
            reviewAction = 'approved';
            var commentEl = document.getElementById('appReviewComment');
            if (commentEl) commentEl.value = '批量通过';
            confirmApplicationReview();
        });
        selectedIds = {};
        renderApplicationCenter();
    }

    /* ========== 流程配置 / 导出 ========== */
    function showApprovalFlowConfig() {
        if (!canConfigFlow()) { alert('无权配置'); return; }
        loadFlowConfig();
        var titleEl = document.getElementById('applicationModalTitle');
        var hintEl = document.getElementById('applicationModalHint');
        var body = document.getElementById('applicationModalBody');
        if (titleEl) titleEl.textContent = '审批流程配置';
        if (hintEl) hintEl.textContent = '按申请类型配置审批节点（角色：leader / admin）';
        if (!body) return;
        var keys = Object.keys(DEFAULT_FLOWS);
        body.innerHTML = keys.map(function (k) {
            var flow = approvalFlowConfig[k] || DEFAULT_FLOWS[k];
            var label = k === 'reimburse_large' ? '大额报销（≥' + REIMBURSE_LARGE + '）' : ((TYPE_META[k] && TYPE_META[k].label) || k);
            return '<div style="margin-bottom:14px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;">' +
                '<div style="font-weight:700;margin-bottom:8px;">' + esc(label) + '</div>' +
                '<input type="text" id="flow_' + esc(k) + '" value="' + esc(flow.map(function (n) { return n.role + ':' + n.label; }).join(',')) +
                '" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;" placeholder="leader:组长初审,admin:导师终审">' +
                '</div>';
        }).join('') +
            '<div style="display:flex;justify-content:flex-end;gap:8px;"><button class="btn btn-secondary" type="button" onclick="closeApplicationModal()">取消</button>' +
            '<button class="btn" type="button" onclick="saveApprovalFlowConfigForm()">保存配置</button></div>';
        var modal = document.getElementById('applicationModal');
        if (modal) modal.style.display = 'flex';
    }

    function saveApprovalFlowConfigForm() {
        Object.keys(DEFAULT_FLOWS).forEach(function (k) {
            var el = document.getElementById('flow_' + k);
            if (!el) return;
            var parts = String(el.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            var flow = parts.map(function (p) {
                var segs = p.split(':');
                return { role: (segs[0] || 'admin').trim(), label: (segs[1] || segs[0] || '审批').trim() };
            }).filter(function (n) { return n.role === 'leader' || n.role === 'admin'; });
            if (flow.length) approvalFlowConfig[k] = flow;
        });
        saveFlowConfig();
        closeApplicationModal();
        alert('流程配置已保存并同步云端');
    }

    function exportApplicationRecords() {
        var list = applyFilters(listForTab());
        var rows = [['编号', '类型', '标题', '申请人', '小组', '状态', '提交时间', '当前节点', '事由']];
        list.forEach(function (a) {
            rows.push([
                a.applyNo || a.id,
                typeLabel(a.applyType),
                displayTitle(a),
                a.applicant,
                a.applicantGroup,
                (STATUS_CFG[a.status] && STATUS_CFG[a.status].label) || a.status,
                a.createdAt,
                nodeLabel(a),
                String(a.reason || '').replace(/\n/g, ' ')
            ]);
        });
        var csv = '\ufeff' + rows.map(function (r) {
            return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
        }).join('\n');
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '申请记录_' + thisMonthKey() + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    /** 首页待办：返回当前用户待审批申请条目 */
    function getApplicationHomeTodos() {
        loadData();
        return (applicationData || []).filter(isAwaitingMe).map(function (a) {
            return {
                id: 'app-' + a.id,
                category: 'application',
                priority: isUrgentItem(a) ? 'high' : 'medium',
                title: (a.applicant || '') + ' · ' + displayTitle(a),
                meta: '请假申请 · ' + typeLabel(a.applyType) + ' · ' + nodeLabel(a),
                deadline: '',
                source: '请假与申请',
                publisher: a.applicant || '',
                go: function () {
                    if (typeof global.showModule === 'function') global.showModule('application_center');
                    setTimeout(function () { showApplicationDetail(a.id); }, 80);
                },
                actions: [
                    { label: '通过', cls: 'ok', run: function () { openApplicationReview(a.id, 'approved'); } },
                    { label: '驳回', cls: 'bad', run: function () { openApplicationReview(a.id, 'rejected'); } }
                ]
            };
        });
    }

    // exports
    global.applicationData = applicationData;
    global.approvalFlowConfig = approvalFlowConfig;
    global.mergeIncomingApplicationData = mergeIncomingApplicationData;
    global.mergeIncomingApprovalFlowConfig = mergeIncomingApprovalFlowConfig;
    global.initApplicationCenter = initApplicationCenter;
    global.renderApplicationCenter = renderApplicationCenter;
    global.setApplicationTab = setApplicationTab;
    global.setApplicationStatFilter = setApplicationStatFilter;
    global.onApplicationFilterChange = onApplicationFilterChange;
    global.showApplicationCreateModal = showApplicationCreateModal;
    global.selectApplicationType = selectApplicationType;
    global.submitApplicationForm = submitApplicationForm;
    global.saveApplicationDraft = saveApplicationDraft;
    global.saveApplicationAsTemplate = saveApplicationAsTemplate;
    global.applyPersonalTemplate = applyPersonalTemplate;
    global.editApplicationDraft = editApplicationDraft;
    global.resubmitApplication = resubmitApplication;
    global.showApplicationDetail = showApplicationDetail;
    global.withdrawApplication = withdrawApplication;
    global.openApplicationReview = openApplicationReview;
    global.confirmApplicationReview = confirmApplicationReview;
    global.closeApplicationModal = closeApplicationModal;
    global.closeApplicationReviewModal = closeApplicationReviewModal;
    global.handleApplicationAttachUpload = handleApplicationAttachUpload;
    global.removeApplicationAttach = removeApplicationAttach;
    global.handleDetailImageUpload = handleDetailImageUpload;
    global.removeDetailImage = removeDetailImage;
    global.onAppProjectChange = onAppProjectChange;
    global.validateAppTimeRange = validateAppTimeRange;
    global.refreshFlowPreview = refreshFlowPreview;
    global.toggleApplicationSelect = toggleApplicationSelect;
    global.clearApplicationSelection = clearApplicationSelection;
    global.batchApproveApplications = batchApproveApplications;
    global.showApprovalFlowConfig = showApprovalFlowConfig;
    global.saveApprovalFlowConfigForm = saveApprovalFlowConfigForm;
    global.exportApplicationRecords = exportApplicationRecords;
    global.getApplicationHomeTodos = getApplicationHomeTodos;
    global.isApplicationAwaitingMe = isAwaitingMe;

    try { loadData(); } catch (eBoot) {}
})(typeof window !== 'undefined' ? window : this);
