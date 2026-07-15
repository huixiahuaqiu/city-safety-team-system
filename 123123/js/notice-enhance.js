/**
 * 通知发布增强：富文本编辑器、附件、草稿/定时发布
 * 在 index.html 内联通知逻辑之上增强。
 */
(function (global) {
    'use strict';

    var noticeEditor = null;
    var noticePendingAttachments = [];
    var _origSave = null;
    var _origShowAdd = null;
    var _origEdit = null;
    var _origDetail = null;
    var _origNormalize = null;
    var _origClose = null;
    var scheduleTimer = null;
    var enhanced = false;

    function esc(s) {
        if (typeof global.escHtml === 'function') return global.escHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function destroyNoticeEditor() {
        try {
            if (noticeEditor && noticeEditor.destroy) noticeEditor.destroy();
        } catch (e) {}
        noticeEditor = null;
        var tb = document.getElementById('noticeEditorToolbar');
        var body = document.getElementById('noticeEditorBody');
        if (tb) tb.innerHTML = '';
        if (body) body.innerHTML = '';
    }

    function sanitizeHtml(html) {
        var s = String(html || '').trim();
        if (!s) return '<p><br></p>';
        if (s.indexOf('<') < 0) {
            return '<p>' + esc(s).replace(/\n/g, '<br>') + '</p>';
        }
        return s;
    }

    function initNoticeEditor(html) {
        destroyNoticeEditor();
        var tb = document.getElementById('noticeEditorToolbar');
        var body = document.getElementById('noticeEditorBody');
        function fallbackTextarea() {
            var ta = document.getElementById('noticeContent');
            if (ta) {
                ta.style.display = 'block';
                ta.rows = 6;
                if (html) ta.value = String(html).replace(/<[^>]+>/g, '');
            }
        }
        if (!tb || !body) {
            fallbackTextarea();
            return;
        }
        function boot() {
            if (typeof global.wangEditor === 'undefined') {
                fallbackTextarea();
                return;
            }
            var ta = document.getElementById('noticeContent');
            if (ta) ta.style.display = 'none';
            try {
                noticeEditor = global.wangEditor.createEditor({
                    selector: '#noticeEditorBody',
                    html: sanitizeHtml(html || ''),
                    config: {
                        placeholder: '请输入通知内容…',
                        MENU_CONF: {
                            uploadImage: {
                                customUpload: function (file, insertFn) {
                                    var reader = new FileReader();
                                    reader.onload = function (e) { insertFn(e.target.result); };
                                    reader.readAsDataURL(file);
                                }
                            }
                        }
                    },
                    mode: 'default'
                });
                global.wangEditor.createToolbar({
                    editor: noticeEditor,
                    selector: '#noticeEditorToolbar',
                    config: {
                        toolbarKeys: [
                            'headerSelect', 'bold', 'italic', 'underline', 'color', '|',
                            'bulletedList', 'numberedList', 'blockquote', '|',
                            'insertLink', 'uploadImage', '|', 'undo', 'redo'
                        ]
                    }
                });
            } catch (e) {
                console.error('notice editor init', e);
                fallbackTextarea();
            }
        }
        if (typeof global.wangEditor !== 'undefined') {
            boot();
            return;
        }
        if (typeof global.ensureVendor === 'function') {
            global.ensureVendor('wangeditor').then(boot).catch(function () { fallbackTextarea(); });
        } else {
            fallbackTextarea();
        }
    }

    function getNoticeContentHtml() {
        if (noticeEditor && typeof noticeEditor.getHtml === 'function') {
            return noticeEditor.getHtml() || '';
        }
        var ta = document.getElementById('noticeContent');
        var plain = ta ? ta.value : '';
        return sanitizeHtml(plain);
    }

    function getNoticeContentText() {
        if (noticeEditor && typeof noticeEditor.getText === 'function') {
            return (noticeEditor.getText() || '').trim();
        }
        var ta = document.getElementById('noticeContent');
        return ta ? String(ta.value || '').trim() : '';
    }

    function syncContentToHidden() {
        var ta = document.getElementById('noticeContent');
        if (ta) ta.value = getNoticeContentHtml();
    }

    function renderNoticeAttachList() {
        var box = document.getElementById('noticeAttachList');
        if (!box) return;
        if (!noticePendingAttachments.length) {
            box.innerHTML = '<span style="color:#94a3b8;">暂无附件</span>';
            return;
        }
        box.innerHTML = noticePendingAttachments.map(function (a, i) {
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f1f5f9;">' +
                '<span>' + esc(a.name) + (a.from === 'shared' ? ' <span style="color:#7c3aed;font-size:11px;">共享库</span>' : '') +
                ' <span style="color:#94a3b8;">(' + Math.round((a.size || 0) / 1024) + 'KB)</span></span>' +
                '<button type="button" style="border:none;background:none;color:#ef4444;cursor:pointer;font-size:12px;" onclick="removeNoticeAttach(' + i + ')">移除</button></div>';
        }).join('');
    }

    function handleNoticeAttachUpload(event) {
        var files = event.target.files;
        if (!files || !files.length) return;
        Array.prototype.forEach.call(files, function (file) {
            if (noticePendingAttachments.length >= 5) {
                alert('最多 5 个附件');
                return;
            }
            if (file.size > 2 * 1024 * 1024) {
                alert(file.name + ' 超过 2MB，已跳过');
                return;
            }
            var reader = new FileReader();
            reader.onload = function (e) {
                noticePendingAttachments.push({
                    name: file.name,
                    url: e.target.result,
                    size: file.size,
                    from: 'local'
                });
                renderNoticeAttachList();
            };
            reader.readAsDataURL(file);
        });
        event.target.value = '';
    }
    global.handleNoticeAttachUpload = handleNoticeAttachUpload;

    function removeNoticeAttach(i) {
        noticePendingAttachments.splice(i, 1);
        renderNoticeAttachList();
    }
    global.removeNoticeAttach = removeNoticeAttach;

    function pickNoticeAttachFromShared() {
        var list = [];
        try {
            list = Array.isArray(global.sharedFileData) ? global.sharedFileData : JSON.parse(localStorage.getItem('sharedFileData') || '[]');
        } catch (e) { list = []; }
        list = (list || []).filter(function (f) { return f && !f.deletedAt && !f.hiddenInLibrary; });
        if (!list.length) {
            alert('共享文件库暂无可用文件');
            return;
        }
        var names = list.slice(0, 30).map(function (f, i) { return (i + 1) + '. ' + f.name; }).join('\n');
        var pick = prompt('输入文件序号（1-' + Math.min(30, list.length) + '）：\n' + names);
        var idx = Number(pick) - 1;
        if (!(idx >= 0 && idx < list.length)) return;
        if (noticePendingAttachments.length >= 5) {
            alert('最多 5 个附件');
            return;
        }
        var f = list[idx];
        noticePendingAttachments.push({
            name: f.name,
            url: '',
            sharedFileId: f.id,
            serverFileId: f.serverFileId || '',
            size: f.fileSizeBytes || 0,
            from: 'shared'
        });
        renderNoticeAttachList();
    }
    global.pickNoticeAttachFromShared = pickNoticeAttachFromShared;

    function toggleNoticeScheduleRow() {
        var mode = (document.getElementById('noticePublishMode') || {}).value || 'now';
        var wrap = document.getElementById('noticeScheduleWrap');
        if (wrap) wrap.style.display = mode === 'schedule' ? 'block' : 'none';
        var btn = document.getElementById('noticeSaveBtn');
        if (btn) {
            if (mode === 'draft') btn.textContent = '保存草稿';
            else if (mode === 'schedule') btn.textContent = '定时发布';
            else btn.textContent = '立即发布';
        }
    }
    global.toggleNoticeScheduleRow = toggleNoticeScheduleRow;

    function saveNoticeAsDraft() {
        var mode = document.getElementById('noticePublishMode');
        if (mode) mode.value = 'draft';
        toggleNoticeScheduleRow();
        if (typeof global.saveNotice === 'function') global.saveNotice();
    }
    global.saveNoticeAsDraft = saveNoticeAsDraft;

    function enhanceNormalize(n) {
        n = _origNormalize ? _origNormalize(n) : (n || {});
        var attachments = Array.isArray(n.attachments) ? n.attachments : [];
        return Object.assign({}, n, {
            attachments: attachments,
            status: n.status || 'published',
            scheduledAt: n.scheduledAt || '',
            contentIsHtml: n.contentIsHtml !== false
        });
    }

    function wrapShowAdd() {
        if (_origShowAdd) _origShowAdd();
        noticePendingAttachments = [];
        renderNoticeAttachList();
        var mode = document.getElementById('noticePublishMode');
        if (mode) mode.value = 'now';
        toggleNoticeScheduleRow();
        setTimeout(function () { initNoticeEditor(''); }, 60);
    }

    function wrapEdit(id) {
        if (_origEdit) _origEdit(id);
        var notice = (Array.isArray(global.noticeData) ? global.noticeData : []).find(function (n) {
            return Number(n.id) === Number(id);
        });
        noticePendingAttachments = (notice && Array.isArray(notice.attachments)) ? notice.attachments.slice() : [];
        renderNoticeAttachList();
        var mode = document.getElementById('noticePublishMode');
        if (mode && notice) {
            if (notice.status === 'draft') mode.value = 'draft';
            else if (notice.status === 'scheduled') mode.value = 'schedule';
            else mode.value = 'now';
        }
        var sched = document.getElementById('noticeScheduledAt');
        if (sched && notice && notice.scheduledAt) {
            sched.value = String(notice.scheduledAt).replace(' ', 'T').slice(0, 16);
        }
        toggleNoticeScheduleRow();
        setTimeout(function () { initNoticeEditor((notice && notice.content) || ''); }, 60);
    }

    function wrapClose() {
        destroyNoticeEditor();
        noticePendingAttachments = [];
        if (_origClose) _origClose();
    }

    function wrapSave() {
        syncContentToHidden();
        var text = getNoticeContentText();
        var html = getNoticeContentHtml();
        if (!text && html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim() === '') {
            alert('请填写通知内容');
            return;
        }
        var ta = document.getElementById('noticeContent');
        if (ta) ta.value = html;

        var mode = (document.getElementById('noticePublishMode') || {}).value || 'now';
        var scheduledAt = ((document.getElementById('noticeScheduledAt') || {}).value || '').trim();
        if (mode === 'schedule' && !scheduledAt) {
            alert('请选择定时发布时间');
            return;
        }

        var titleSnap = ((document.getElementById('noticeTitle') || {}).value || '').trim();
        var idSnap = null;
        try {
            // editingNoticeId 在 index.html 闭包内，从 modal 标题推断
            var mt = document.getElementById('noticeModalTitle');
            if (mt && /编辑/.test(mt.textContent || '')) {
                var hit = (Array.isArray(global.noticeData) ? global.noticeData : []).find(function (n) {
                    return n.title === titleSnap;
                });
                if (hit) idSnap = hit.id;
            }
        } catch (e0) {}

        if (_origSave) _origSave();

        try {
            var list = Array.isArray(global.noticeData) ? global.noticeData : [];
            var target = null;
            if (idSnap != null) {
                target = list.find(function (n) { return Number(n.id) === Number(idSnap); });
            }
            if (!target && titleSnap) {
                var cands = list.filter(function (n) { return n.title === titleSnap; });
                target = cands.length ? cands[cands.length - 1] : null;
            }
            if (!target && list.length) {
                target = list.slice().sort(function (a, b) { return Number(b.id) - Number(a.id); })[0];
            }
            if (target) {
                target.content = html;
                target.contentIsHtml = true;
                target.attachments = noticePendingAttachments.slice(0, 5);
                if (mode === 'draft') {
                    target.status = 'draft';
                    target.scheduledAt = '';
                } else if (mode === 'schedule') {
                    target.status = 'scheduled';
                    target.scheduledAt = scheduledAt;
                    target.startTime = scheduledAt;
                } else {
                    target.status = 'published';
                    target.scheduledAt = '';
                }
                if (typeof global.saveNoticeData === 'function') {
                    global.saveNoticeData({
                        log: { action: mode === 'draft' ? '草稿' : (mode === 'schedule' ? '定时' : '发布'), desc: target.title }
                    });
                }
                if (typeof global.renderNoticeList === 'function') global.renderNoticeList();
            }
        } catch (e) {
            console.warn(e);
        }
        destroyNoticeEditor();
        noticePendingAttachments = [];
    }

    function wrapDetail(id) {
        if (_origDetail) _origDetail(id);
        setTimeout(function () {
            var notice = (Array.isArray(global.noticeData) ? global.noticeData : []).find(function (n) {
                return Number(n.id) === Number(id);
            });
            if (!notice) return;
            var box = document.getElementById('noticeDetailContent');
            if (!box) return;
            // 将纯文本段落替换为富文本渲染
            var plainBlock = box.querySelector('p[style*="white-space"]');
            if (plainBlock && notice.contentIsHtml !== false && /</.test(notice.content || '')) {
                var host = document.createElement('div');
                host.style.cssText = 'background:#f8f9fa;padding:16px;border-radius:8px;margin-bottom:16px;font-size:14px;line-height:1.8;color:#333;';
                host.className = 'notice-rich-body';
                host.innerHTML = notice.content || '';
                plainBlock.parentElement.replaceChild(host, plainBlock);
            }
            if (Array.isArray(notice.attachments) && notice.attachments.length && !box.querySelector('.notice-attach-panel')) {
                var panel = document.createElement('div');
                panel.className = 'notice-attach-panel';
                panel.style.cssText = 'background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:16px;';
                panel.innerHTML = '<div style="font-weight:600;margin-bottom:8px;">附件</div>' +
                    notice.attachments.map(function (a) {
                        if (a.url) {
                            return '<div style="margin-bottom:6px;"><a href="' + esc(a.url) + '" download="' + esc(a.name) + '" style="color:#7c3aed;">📎 ' + esc(a.name) + '</a></div>';
                        }
                        if (a.sharedFileId && typeof global.handleFileDownload === 'function') {
                            return '<div style="margin-bottom:6px;"><a href="javascript:void(0)" onclick="handleFileDownload(' + Number(a.sharedFileId) + ')" style="color:#7c3aed;">📎 ' + esc(a.name) + '（共享库）</a></div>';
                        }
                        return '<div style="margin-bottom:6px;color:#64748b;">📎 ' + esc(a.name) + '</div>';
                    }).join('');
                var actions = box.querySelector('div[style*="flex-end"]');
                if (actions) box.insertBefore(panel, actions);
                else box.appendChild(panel);
            }
            if (notice.status === 'draft' || notice.status === 'scheduled') {
                var head = box.querySelector('h2');
                if (head && !box.querySelector('.notice-status-badge')) {
                    var badge = document.createElement('span');
                    badge.className = 'notice-status-badge';
                    badge.style.cssText = 'display:inline-block;margin-left:8px;padding:2px 8px;border-radius:12px;font-size:12px;vertical-align:middle;' +
                        (notice.status === 'draft' ? 'background:#f1f5f9;color:#64748b;' : 'background:#e0e7ff;color:#4338ca;');
                    badge.textContent = notice.status === 'draft' ? '草稿' : ('定时 ' + (notice.scheduledAt || ''));
                    head.appendChild(badge);
                }
            }
        }, 40);
    }

    function flushScheduledNotices() {
        var list = Array.isArray(global.noticeData) ? global.noticeData : [];
        if (!list.length) return;
        var now = Date.now();
        var changed = false;
        list.forEach(function (n) {
            if (n.status !== 'scheduled' || !n.scheduledAt) return;
            var ts = Date.parse(String(n.scheduledAt).replace(/-/g, '/'));
            if (ts && ts <= now) {
                n.status = 'published';
                n.publishTime = new Date().toLocaleString('zh-CN');
                changed = true;
            }
        });
        if (changed && typeof global.saveNoticeData === 'function') {
            global.saveNoticeData({ silent: true, log: { action: '定时上架', desc: '自动发布到期通知' } });
            if (typeof global.renderNoticeList === 'function') global.renderNoticeList();
        }
    }

    function ensureScheduleTimer() {
        if (scheduleTimer) return;
        scheduleTimer = setInterval(flushScheduledNotices, 30000);
        flushScheduledNotices();
    }

    function patchListFilter() {
        // 列表渲染后补充草稿/定时徽章：通过二次包装 renderNoticeList
        if (typeof global.renderNoticeList !== 'function') return;
        var orig = global.renderNoticeList;
        if (orig.__noticeEnhanced) return;
        global.renderNoticeList = function () {
            // 非管理员过滤掉他人不可见草稿
            try {
                var u = global.currentUser;
                var canManage = u && (u.role === 'admin' || u.role === 'leader');
                if (!canManage && Array.isArray(global.noticeData)) {
                    // 仅在过滤层提示：实际过滤在 orig 内部，这里用临时隐藏字段
                    global.noticeData.forEach(function (n) {
                        n._hideFromMember = (n.status === 'draft' || n.status === 'scheduled');
                    });
                } else if (Array.isArray(global.noticeData)) {
                    global.noticeData.forEach(function (n) { n._hideFromMember = false; });
                }
            } catch (e) {}
            var r = orig.apply(this, arguments);
            return r;
        };
        global.renderNoticeList.__noticeEnhanced = true;
    }

    function enhance() {
        if (enhanced) return;
        enhanced = true;
        if (typeof global.normalizeNoticeRecord === 'function') {
            _origNormalize = global.normalizeNoticeRecord;
            global.normalizeNoticeRecord = enhanceNormalize;
        }
        if (typeof global.showAddNoticeModal === 'function') {
            _origShowAdd = global.showAddNoticeModal;
            global.showAddNoticeModal = wrapShowAdd;
        }
        if (typeof global.editNotice === 'function') {
            _origEdit = global.editNotice;
            global.editNotice = wrapEdit;
        }
        if (typeof global.closeNoticeModal === 'function') {
            _origClose = global.closeNoticeModal;
            global.closeNoticeModal = wrapClose;
        }
        if (typeof global.saveNotice === 'function') {
            _origSave = global.saveNotice;
            global.saveNotice = wrapSave;
        }
        if (typeof global.showNoticeDetail === 'function') {
            _origDetail = global.showNoticeDetail;
            global.showNoticeDetail = wrapDetail;
        }
        ensureScheduleTimer();
        patchListFilter();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(enhance, 0); });
    } else {
        setTimeout(enhance, 0);
    }
    global.NoticeEnhance = { enhance: enhance, flushScheduledNotices: flushScheduledNotices };

})(typeof window !== 'undefined' ? window : this);
