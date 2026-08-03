/**
 * 团队共享文件库增强层
 * 在 index.html 内联实现之上补齐：权限硬校验、重命名、下载记录、
 * 下载量排序、备注、重名处理、上传进度、批量下载、服务端落盘。
 */
(function (global) {
    'use strict';

    var DL_LOG_KEY = 'sharedFileDownloadLogs';
    var _origDownload = null;
    var _origDelete = null;
    var _origShowAdd = null;
    var _origAddFile = null;
    var _origBatchDelete = null;
    var _origShowDetail = null;
    var _origSortFiles = null;
    var _origRenderFileList = null;
    var sharedRecycleMode = false;
    var enhanced = false;

    function esc(s) {
        return window.escapeHtml(s);
    }

    function currentUser() {
        return global.currentUser || null;
    }

    function isVisitor() {
        var u = currentUser();
        return !!(u && u.role === 'visitor');
    }

    function isAdminLike() {
        var u = currentUser();
        if (!u) return false;
        return u.role === 'admin' || u.role === 'mentor' || u.role === 'teacher' || u.role === 'leader';
    }

    function canUploadShared() {
        return !isVisitor();
    }

    function canDownloadShared() {
        return !isVisitor();
    }

    function canDeleteShared(file) {
        if (!file) return false;
        if (isVisitor()) return false;
        if (isAdminLike()) return true;
        var u = currentUser();
        if (!u) return false;
        if (file.uploaderId && u.id && Number(file.uploaderId) === Number(u.id)) return true;
        var name = u.realName || u.username || '';
        return name && file.uploader === name;
    }

    function getSharedList() {
        if (!Array.isArray(global.sharedFileData)) {
            try { global.sharedFileData = JSON.parse(localStorage.getItem('sharedFileData') || '[]'); }
            catch (e) { global.sharedFileData = []; }
        }
        return global.sharedFileData;
    }

    function saveSharedMeta() {
        var list = getSharedList();
        localStorage.setItem('sharedFileData', JSON.stringify(list));
        try {
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('sharedFileData', JSON.stringify(list));
        } catch (e) { /* ignore */ }
    }

    function loadDlLogs() {
        try {
            var o = JSON.parse(localStorage.getItem(DL_LOG_KEY) || '{}');
            return o && typeof o === 'object' ? o : {};
        } catch (e) { return {}; }
    }

    function pushDlLog(fileId, entry) {
        var logs = loadDlLogs();
        var k = String(fileId);
        if (!Array.isArray(logs[k])) logs[k] = [];
        logs[k].unshift(entry);
        logs[k] = logs[k].slice(0, 200);
        localStorage.setItem(DL_LOG_KEY, JSON.stringify(logs));
    }

    function uniqueDisplayName(name) {
        var list = getSharedList().filter(function (f) { return !f.hiddenInLibrary; });
        var base = String(name || '未命名');
        var exists = list.some(function (f) { return f.name === base; });
        if (!exists) return base;
        var m = base.match(/^(.*?)(\.[^.]+)?$/);
        var stem = m ? m[1] : base;
        var ext = m && m[2] ? m[2] : '';
        var i = 2;
        while (list.some(function (f) { return f.name === stem + '(' + i + ')' + ext; })) i++;
        return stem + '(' + i + ')' + ext;
    }

    function authHeaders(extra) {
        var h = Object.assign({}, extra || {});
        var cfg = global.APP_CONFIG || {};
        var token = cfg.DATASET_UPLOAD_TOKEN || cfg.ANNOTATION_UPLOAD_TOKEN || '';
        if (token) h['X-Upload-Token'] = token;
        try {
            var session = global.GatewayAuth && global.GatewayAuth.read
                ? global.GatewayAuth.read()
                : null;
            if (session && session.token) h.Authorization = 'Bearer ' + session.token;
        } catch (eAuth) { /* ignore */ }
        return h;
    }

    function sharedFetch(url, options) {
        options = options || {};
        options.headers = authHeaders(options.headers || {});
        if (global.GatewayAuth && typeof global.GatewayAuth.fetch === 'function' && global.GatewayAuth.hasSession && global.GatewayAuth.hasSession()) {
            return global.GatewayAuth.fetch(url, options);
        }
        return fetch(url, options);
    }

    function triggerBlobDownload(blob, fileName) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    async function probeSharedServer() {
        try {
            var r = await fetch('/api/shared-file/health');
            if (!r.ok) return null;
            return await r.json();
        } catch (e) { return null; }
    }

    async function uploadToServer(file, meta) {
        var caps = await probeSharedServer();
        if (!caps || !caps.ok) return null;

        var hasSession = !!(global.GatewayAuth && global.GatewayAuth.enabled
            && global.GatewayAuth.hasSession && global.GatewayAuth.hasSession());
        if (global.GatewayAuth && global.GatewayAuth.enabled && !hasSession) {
            throw new Error('登录已失效，请退出后重新登录再上传');
        }

        // 较大文件优先预签名直传 MinIO；失败则回退 multipart（经网关）
        var PRESIGN_THRESHOLD = 1 * 1024 * 1024; // 1MB
        if (caps.presignEnabled && file && file.size >= PRESIGN_THRESHOLD) {
            try {
                var preResp = await sharedFetch('/api/shared-file/presign', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fileName: meta.fileName || file.name,
                        originalName: file.name,
                        fileType: meta.fileType || 'other',
                        remark: meta.remark || '',
                        size: file.size,
                        contentType: file.type || 'application/octet-stream'
                    })
                });
                var pre = await preResp.json().catch(function () { return {}; });
                if (preResp.ok && pre.ok && pre.uploadUrl) {
                    var putHeaders = Object.assign({}, pre.headers || {});
                    var putResp = await fetch(pre.uploadUrl, {
                        method: pre.method || 'PUT',
                        headers: putHeaders,
                        body: file
                    });
                    if (!putResp.ok) throw new Error('直传对象存储失败 HTTP ' + putResp.status);
                    var confResp = await sharedFetch('/api/shared-file/confirm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fileId: pre.fileId, size: file.size })
                    });
                    var conf = await confResp.json().catch(function () { return {}; });
                    if (!confResp.ok || !conf.ok) throw new Error((conf && conf.error) || '直传确认失败');
                    return conf;
                }
            } catch (e) {
                console.warn('[shared-file] presign fallback to multipart', e);
            }
        }

        var fd = new FormData();
        fd.append('file', file);
        fd.append('fileName', meta.fileName || file.name);
        fd.append('fileType', meta.fileType || 'other');
        fd.append('remark', meta.remark || '');
        var resp = await sharedFetch('/api/shared-file/upload', {
            method: 'POST',
            body: fd
        });
        var data = await resp.json().catch(function () { return {}; });
        if (!resp.ok || !data.ok) {
            var errMsg = (data && data.error) || ('服务端上传失败 HTTP ' + resp.status);
            if (resp.status === 401 || /invalid upload token|valid session required/i.test(String(errMsg))) {
                errMsg = '登录已失效，请退出后重新登录再上传';
            }
            throw new Error(errMsg);
        }
        return data;
    }

    function cloudDownloadUrl(serverFileId) {
        var id = String(serverFileId || '').trim();
        if (!id) return '';
        var url = '/api/shared-file/download?fileId=' + encodeURIComponent(id);
        try {
            var session = global.GatewayAuth && global.GatewayAuth.read
                ? global.GatewayAuth.read()
                : null;
            if (session && session.token) {
                url += '&access=' + encodeURIComponent(session.token);
            }
        } catch (e) { /* ignore */ }
        return url;
    }

    function formatBytesLocal(n) {
        n = Number(n) || 0;
        if (typeof global.formatFileSize === 'function') return global.formatFileSize(n);
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(2) + ' MB';
    }

    /**
     * 上传文件到云端并登记共享元数据（全员可见/可下载）。
     * options: { fileName, fileType, remark, hiddenInLibrary, skipLibrary }
     */
    async function saveFileForTeam(file, options) {
        options = options || {};
        if (!file) throw new Error('未选择文件');
        if (!canUploadShared()) throw new Error('当前账号无权上传');

        var displayName = uniqueDisplayName(options.fileName || file.name || ('file_' + Date.now()));
        var serverMeta = await uploadToServer(file, {
            fileName: displayName,
            fileType: options.fileType || 'other',
            remark: options.remark || ''
        });
        if (!serverMeta || !serverMeta.fileId) {
            throw new Error('云端上传失败：未返回文件编号（请确认已登录且服务正常）');
        }

        var list = getSharedList();
        var newId = list.length
            ? Math.max.apply(null, list.map(function (f) { return Number(f.id) || 0; })) + 1
            : 1;
        var meta = {
            id: newId,
            name: displayName,
            size: formatBytesLocal(file.size),
            fileSizeBytes: file.size,
            type: options.fileType || 'other',
            mimeType: file.type || '',
            hasBlob: false,
            serverFileId: serverMeta.fileId,
            storagePath: serverMeta.savedAs || '',
            uploader: (currentUser() && (currentUser().realName || currentUser().username)) || '未知',
            uploaderId: (currentUser() && currentUser().id) || 0,
            uploadTime: new Date().toLocaleDateString('zh-CN'),
            downloadCount: 0,
            remark: options.remark || '',
            hiddenInLibrary: !!options.hiddenInLibrary,
            url: cloudDownloadUrl(serverMeta.fileId)
        };
        if (!options.skipLibrary) {
            list.push(meta);
            global.sharedFileData = list;
            saveSharedMeta();
            try {
                if (!meta.hiddenInLibrary && typeof global.renderFileList === 'function') {
                    global.renderFileList();
                }
            } catch (eRender) { /* ignore */ }
        }
        return meta;
    }

    async function uploadFolderToServer(btn, items) {
        if (!canUploadShared()) { alert('访客不可上传'); return; }
        if (!items || !items.length) { alert('请选择文件夹'); return; }

        var progress = document.getElementById('flUploadProgress');
        var bar = document.getElementById('flUploadBar');
        var text = document.getElementById('flUploadText');
        if (progress) progress.style.display = 'block';
        if (btn) {
            btn.disabled = true;
            btn.textContent = '上传中…';
        }

        var typeSel = document.getElementById('flTypeFolder');
        var fileType = (typeSel && typeSel.value) || 'dataset';
        var list = getSharedList();
        var baseId = list.length ? Math.max.apply(null, list.map(function (f) { return Number(f.id) || 0; })) + 1 : 1;
        var folderName = String(items[0].relPath || items[0].file.name).split('/')[0] || 'folder';
        var success = 0;
        var failed = 0;
        var failSamples = [];

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var file = item.file;
            var relPath = item.relPath || file.name;
            var pct = Math.max(2, Math.round(((i + 1) / items.length) * 100));
            if (bar) bar.style.width = pct + '%';
            if (text) {
                text.textContent = '正在上传到云端 ' + (i + 1) + '/' + items.length + '：' + relPath;
            }
            var fileId = baseId++;
            var serverMeta = null;
            try {
                serverMeta = await uploadToServer(file, {
                    fileName: file.name,
                    fileType: fileType,
                    remark: 'folder:' + folderName + ' | ' + relPath
                });
            } catch (err) {
                console.warn('[shared-file] folder item upload failed', relPath, err);
            }

            if (!serverMeta || !serverMeta.fileId) {
                // 禁止回退本机 IndexedDB：仅本机登记时其他人无法接收
                failed += 1;
                if (failSamples.length < 8) failSamples.push(relPath);
                continue;
            }

            list.push({
                id: fileId,
                name: file.name,
                relativePath: relPath,
                size: typeof global.formatFileSize === 'function'
                    ? global.formatFileSize(file.size)
                    : (Math.round(file.size / 1024) + ' KB'),
                fileSizeBytes: file.size,
                type: fileType,
                mimeType: file.type || '',
                hasBlob: false,
                serverFileId: serverMeta.fileId,
                storagePath: serverMeta.savedAs || '',
                uploader: (currentUser() && (currentUser().realName || currentUser().username)) || '未知',
                uploaderId: (currentUser() && currentUser().id) || 0,
                uploadTime: new Date().toLocaleDateString('zh-CN'),
                downloadCount: 0,
                remark: 'folder:' + folderName
            });
            success += 1;

            // 每 20 个落盘一次元数据，避免中途刷新全丢
            if (success % 20 === 0) {
                global.sharedFileData = list;
                saveSharedMeta();
            }
        }

        global.sharedFileData = list;
        saveSharedMeta();
        if (typeof global.renderFileList === 'function') global.renderFileList();
        if (typeof global.recordOperationLog === 'function') {
            global.recordOperationLog(
                '资源中心',
                '上传',
                '上传文件夹：' + folderName + '（成功' + success + '/失败' + failed + '）',
                { folderName: folderName, success: success, failed: failed },
                { success: failed === 0 },
                failed === 0 ? 1 : 0,
                '',
                0
            );
        }

        if (bar) bar.style.width = '100%';
        if (text) text.textContent = '完成：成功 ' + success + '，失败 ' + failed;
        var modal = btn && btn.closest ? btn.closest('div[style*=fixed]') : null;
        var msg = '文件夹上传完成（已写入服务器，全员可下载）！\n成功 ' + success + ' 个';
        if (failed) {
            msg += '，失败 ' + failed + ' 个（未写入服务器，其他人无法接收）';
            if (failSamples.length) msg += '\n示例：\n- ' + failSamples.join('\n- ');
        }
        if (!success && failed) {
            msg = '文件夹上传失败：全部 ' + failed + ' 个文件未能写入服务器。\n请确认已登录且云端存储正常后重试。';
            if (failSamples.length) msg += '\n示例：\n- ' + failSamples.join('\n- ');
        }
        alert(msg);
        if (modal) modal.remove();
        else if (btn) {
            btn.disabled = false;
            btn.textContent = '上传';
        }
    }

    function enhanceSortSelect() {
        var sel = document.getElementById('fileSortSelect');
        if (!sel) return;
        if (![].some.call(sel.options, function (o) { return o.value === 'dl_desc'; })) {
            var opt = document.createElement('option');
            opt.value = 'dl_desc';
            opt.textContent = '⬇️ 下载量';
            sel.appendChild(opt);
        }
    }

    function enhanceBatchBar() {
        var bar = document.getElementById('batchActionBar');
        if (!bar || document.getElementById('sfBatchDownloadBtn')) return;
        var right = bar.querySelector('div:last-child') || bar;
        var btn = document.createElement('button');
        btn.id = 'sfBatchDownloadBtn';
        btn.className = 'btn btn-secondary';
        btn.style.cssText = 'padding:8px 16px;font-size:13px;';
        btn.textContent = '⬇️ 批量下载';
        btn.onclick = function () { batchDownloadSharedFiles(); };
        right.insertBefore(btn, right.firstChild);

        var logBtn = document.createElement('button');
        logBtn.className = 'btn btn-secondary';
        logBtn.style.cssText = 'padding:8px 16px;font-size:13px;';
        logBtn.textContent = '📋 下载记录';
        logBtn.onclick = function () { showSharedDownloadLogs(); };
        var header = document.querySelector('#shared_files .btn#uploadFileBtn');
        if (header && header.parentElement && !document.getElementById('sfDownloadLogsBtn')) {
            logBtn.id = 'sfDownloadLogsBtn';
            header.parentElement.insertBefore(logBtn, header);
        }
    }

    function wrapSortFiles() {
        if (typeof global.sortFiles !== 'function') return;
        _origSortFiles = global.sortFiles;
        global.sortFiles = function (list, sortBy) {
            if (sortBy === 'dl_desc') {
                return (list || []).slice().sort(function (a, b) {
                    return (Number(b.downloadCount) || 0) - (Number(a.downloadCount) || 0);
                });
            }
            return _origSortFiles(list, sortBy);
        };
    }

    async function handleFileDownloadEnhanced(id) {
        if (!canDownloadShared()) {
            alert('访客无下载权限');
            return;
        }
        var list = getSharedList();
        var file = list.find(function (f) { return Number(f.id) === Number(id); });
        if (!file) return;

        var who = (currentUser() && (currentUser().realName || currentUser().username)) || '未知';
        var when = new Date().toLocaleString('zh-CN');

        // 优先服务端
        if (file.serverFileId) {
            try {
                var response = await fetch(
                    '/api/shared-file/download?fileId=' + encodeURIComponent(file.serverFileId),
                    { headers: authHeaders(), credentials: 'same-origin' }
                );
                if (!response.ok) throw new Error('下载失败 HTTP ' + response.status);
                triggerBlobDownload(await response.blob(), file.name);
                file.downloadCount = (file.downloadCount || 0) + 1;
                saveSharedMeta();
                pushDlLog(id, { user: who, time: when, mode: '服务端鉴权下载' });
                if (typeof global.recordOperationLog === 'function') {
                    global.recordOperationLog('资源中心', '下载', '下载文件：' + file.name, { fileName: file.name }, { success: true }, 1, '', 0);
                }
                if (typeof global.renderFileList === 'function') global.renderFileList();
                return;
            } catch (e) {
                console.warn('[shared-file] server download failed', e);
                alert('服务端文件下载失败，请检查登录状态或下载令牌配置');
                return;
            }
        }

        if (_origDownload) await _origDownload(id);
        else if (typeof global.getSharedFileBlob === 'function') {
            var blob = await global.getSharedFileBlob(id);
            if (!blob) { alert('该文件没有保存完整内容'); return; }
            triggerBlobDownload(blob, file.name);
            file.downloadCount = (file.downloadCount || 0) + 1;
            saveSharedMeta();
            if (typeof global.renderFileList === 'function') global.renderFileList();
        }
        pushDlLog(id, { user: who, time: when, mode: '直接下载' });
    }

    async function serverSoftDelete(fileId, mode) {
        try {
            var headers = authHeaders();
            headers['Content-Type'] = 'application/json';
            var path = mode === 'restore' ? '/api/shared-file/restore' : '/api/shared-file/delete';
            var body = mode === 'restore'
                ? JSON.stringify({ fileId: fileId })
                : JSON.stringify({ fileId: fileId, mode: mode === 'purge' ? 'purge' : 'soft' });
            var res = await fetch(path, { method: 'POST', headers: headers, body: body });
            if (!res.ok) return false;
            var data = await res.json();
            return !!(data && data.ok);
        } catch (e) {
            return false;
        }
    }

    async function deleteSharedFileEnhanced(id) {
        var list = getSharedList();
        var file = list.find(function (f) { return Number(f.id) === Number(id); });
        if (!file) return;
        if (!canDeleteShared(file)) {
            alert('无权删除该文件（仅上传者或导师/管理员可删）');
            return;
        }
        if (file.deletedAt) {
            if (!confirm('彻底删除「' + file.name + '」？此操作不可恢复。')) return;
            if (file.serverFileId) await serverSoftDelete(file.serverFileId, 'purge');
            if (typeof global.deleteSharedFileBlob === 'function') {
                try { await global.deleteSharedFileBlob(id); } catch (e) {}
            }
            global.sharedFileData = list.filter(function (f) { return Number(f.id) !== Number(id); });
            saveSharedMeta();
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('资源中心', '彻底删除', '彻底删除：' + file.name, { fileId: id }, { success: true }, 1, '', 0);
            }
            if (typeof global.renderFileList === 'function') global.renderFileList();
            return;
        }
        if (!confirm('移入回收站「' + file.name + '」？可在回收站恢复。')) return;
        file.deletedAt = new Date().toISOString();
        file.deletedBy = (currentUser() && (currentUser().realName || currentUser().username)) || '';
        if (file.serverFileId) await serverSoftDelete(file.serverFileId, 'soft');
        saveSharedMeta();
        if (typeof global.recordOperationLog === 'function') {
            global.recordOperationLog('资源中心', '软删除', '移入回收站：' + file.name, { fileId: id }, { success: true }, 1, '', 0);
        }
        if (typeof global.renderFileList === 'function') global.renderFileList();
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已移入回收站', false);
    }

    async function restoreSharedFile(id) {
        var list = getSharedList();
        var file = list.find(function (f) { return Number(f.id) === Number(id); });
        if (!file || !file.deletedAt) return;
        if (!canDeleteShared(file) && !isAdminLike()) {
            alert('无权恢复');
            return;
        }
        delete file.deletedAt;
        delete file.deletedBy;
        if (file.serverFileId) await serverSoftDelete(file.serverFileId, 'restore');
        saveSharedMeta();
        if (typeof global.recordOperationLog === 'function') {
            global.recordOperationLog('资源中心', '恢复', '从回收站恢复：' + file.name, { fileId: id }, { success: true }, 1, '', 0);
        }
        if (typeof global.renderFileList === 'function') global.renderFileList();
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已恢复文件', false);
    }
    global.restoreSharedFile = restoreSharedFile;

    function toggleSharedRecycleBin(btn) {
        sharedRecycleMode = !sharedRecycleMode;
        global.__sharedRecycleMode = sharedRecycleMode;
        document.querySelectorAll('.file-type-btn').forEach(function (b) { b.classList.remove('active'); });
        if (btn) {
            if (sharedRecycleMode) btn.classList.add('active');
            else {
                var allBtn = document.querySelector('#shared_files .file-type-btn');
                if (allBtn) allBtn.classList.add('active');
            }
        }
        if (typeof global.renderFileList === 'function') global.renderFileList();
    }
    global.toggleSharedRecycleBin = toggleSharedRecycleBin;
    global.exitSharedRecycleMode = function () {
        sharedRecycleMode = false;
        global.__sharedRecycleMode = false;
    };

    async function batchDeleteSharedEnhanced() {
        var ids = global.selectedFileIds || [];
        var list = getSharedList();
        var forbidden = ids.filter(function (id) {
            var f = list.find(function (x) { return Number(x.id) === Number(id); });
            return f && !canDeleteShared(f);
        });
        if (forbidden.length) {
            alert('所选文件中有 ' + forbidden.length + ' 个无删除权限，已取消操作');
            return;
        }
        if (!ids.length) return;
        if (!confirm('将选中的 ' + ids.length + ' 个文件移入回收站？')) return;
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var file = list.find(function (f) { return Number(f.id) === Number(id); });
            if (!file || file.deletedAt) continue;
            file.deletedAt = new Date().toISOString();
            file.deletedBy = (currentUser() && (currentUser().realName || currentUser().username)) || '';
            if (file.serverFileId) await serverSoftDelete(file.serverFileId, 'soft');
        }
        global.selectedFileIds = [];
        saveSharedMeta();
        if (typeof global.renderFileList === 'function') global.renderFileList();
    }

    function wrapRenderFileList() {
        if (typeof global.renderFileList !== 'function' || global.renderFileList.__sfSoftWrapped) return;
        _origRenderFileList = global.renderFileList;
        global.renderFileList = function () {
            var list = getSharedList();
            var recycleCount = list.filter(function (f) { return !!f.deletedAt; }).length;
            var countEl = document.getElementById('countRecycle');
            if (countEl) countEl.textContent = String(recycleCount);
            global.__sharedRecycleMode = sharedRecycleMode;
            var r = _origRenderFileList.apply(this, arguments);
            if (sharedRecycleMode) {
                setTimeout(function () {
                    var container = document.getElementById('sharedFileList');
                    if (!container) return;
                    var old = document.getElementById('sfRecycleHint');
                    if (old) old.remove();
                    var deleted = list.filter(function (f) { return f.deletedAt; });
                    var hint = document.createElement('div');
                    hint.id = 'sfRecycleHint';
                    hint.style.cssText = 'background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#9a3412;';
                    if (!deleted.length) {
                        hint.textContent = '回收站为空';
                    } else {
                        hint.innerHTML = '<div style="margin-bottom:8px;">回收站共 ' + deleted.length + ' 个文件</div>' +
                            deleted.map(function (f) {
                                return '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">' +
                                    '<span style="flex:1;min-width:120px;">' + esc(f.name) + '</span>' +
                                    '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="restoreSharedFile(' + f.id + ')">恢复</button>' +
                                    '<button type="button" class="btn" style="padding:4px 10px;font-size:12px;background:#ef4444;" onclick="deleteSharedFile(' + f.id + ')">彻底删除</button></div>';
                            }).join('');
                    }
                    container.insertBefore(hint, container.firstChild);
                }, 30);
            }
            return r;
        };
        global.renderFileList.__sfSoftWrapped = true;
    }

    function renameSharedFile(id) {
        var list = getSharedList();
        var file = list.find(function (f) { return Number(f.id) === Number(id); });
        if (!file) return;
        if (!canDeleteShared(file) && !canUploadShared()) {
            alert('无权重命名');
            return;
        }
        var u = currentUser();
        var isOwner = file.uploaderId && u && Number(file.uploaderId) === Number(u.id);
        var isUploaderName = u && (u.realName || u.username) === file.uploader;
        if (!isAdminLike() && !isOwner && !isUploaderName) {
            alert('仅上传者或导师/管理员可重命名');
            return;
        }
        var name = prompt('输入新文件名：', file.name);
        if (!name || !String(name).trim()) return;
        name = uniqueDisplayName(String(name).trim());
        var old = file.name;
        file.name = name;
        file.updateTime = new Date().toISOString().slice(0, 10);
        saveSharedMeta();
        if (typeof global.recordOperationLog === 'function') {
            global.recordOperationLog('资源中心', '重命名', '重命名：' + old + ' → ' + name, { oldName: old, newName: name }, { success: true }, 1, '', 0);
        }
        if (typeof global.renderFileList === 'function') global.renderFileList();
        alert('已重命名为：' + name);
    }

    function showSharedDownloadLogs(fileId) {
        var logs = loadDlLogs();
        var html = '';
        if (fileId) {
            var arr = logs[String(fileId)] || [];
            html = arr.length ? arr.map(function (l) {
                return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed #eee;font-size:13px;"><span>' + esc(l.user) + ' · ' + esc(l.mode || '') + '</span><span style="color:#888;">' + esc(l.time) + '</span></div>';
            }).join('') : '<div style="color:#999;font-size:13px;">暂无下载记录</div>';
        } else {
            var rows = [];
            Object.keys(logs).forEach(function (fid) {
                (logs[fid] || []).forEach(function (l) {
                    var f = getSharedList().find(function (x) { return String(x.id) === String(fid); });
                    rows.push({ name: f ? f.name : ('#' + fid), user: l.user, time: l.time, mode: l.mode });
                });
            });
            rows.sort(function (a, b) { return String(b.time).localeCompare(String(a.time)); });
            rows = rows.slice(0, 50);
            html = rows.length ? rows.map(function (l) {
                return '<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed #eee;font-size:13px;"><span>' + esc(l.name) + ' · ' + esc(l.user) + '</span><span style="color:#888;white-space:nowrap;">' + esc(l.time) + '</span></div>';
            }).join('') : '<div style="color:#999;font-size:13px;">暂无下载记录</div>';
        }
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
        modal.innerHTML = '<div style="background:#fff;border-radius:12px;width:100%;max-width:560px;max-height:80vh;overflow:auto;padding:20px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">下载记录</h3>' +
            '<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="border:none;background:#f5f5f5;width:32px;height:32px;border-radius:50%;cursor:pointer;">×</button></div>' +
            html + '</div>';
        document.body.appendChild(modal);
    }

    function batchDownloadSharedFiles() {
        if (!canDownloadShared()) { alert('访客无下载权限'); return; }
        var ids = global.selectedFileIds || [];
        if (!ids.length) { alert('请先选择文件'); return; }
        ids.forEach(function (id, i) {
            setTimeout(function () { handleFileDownloadEnhanced(id); }, i * 350);
        });
    }

    function showAddFileModalEnhanced() {
        if (!canUploadShared()) {
            alert('访客不可上传文件');
            return;
        }
        if (_origShowAdd) _origShowAdd();
        setTimeout(function () {
            var modal = document.querySelector('div[style*="fixed"][style*="z-index:2000"]');
            if (!modal) return;
            // 注入备注字段
            if (!document.getElementById('flRemark')) {
                var typeSel = document.getElementById('flType');
                if (typeSel && typeSel.parentElement) {
                    var wrap = document.createElement('div');
                    wrap.style.marginBottom = '18px';
                    wrap.innerHTML = '<label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">备注</label>' +
                        '<input type="text" id="flRemark" style="width:100%;padding:12px;border:1px solid #e0e0e0;border-radius:10px;font-size:14px;" placeholder="可选：用途说明、版本说明">';
                    typeSel.parentElement.parentElement.insertBefore(wrap, typeSel.parentElement.nextSibling);
                }
            }
            // 进度条容器
            if (!document.getElementById('flUploadProgress')) {
                var ft = modal.querySelector('.btn');
                var box = document.createElement('div');
                box.id = 'flUploadProgress';
                box.style.cssText = 'display:none;margin:12px 0;';
                box.innerHTML = '<div style="height:8px;background:#ede9fe;border-radius:999px;overflow:hidden;"><div id="flUploadBar" style="height:100%;width:0;background:#7c3aed;transition:width .2s;"></div></div>' +
                    '<div id="flUploadText" style="font-size:12px;color:#6b7280;margin-top:6px;">准备上传…</div>';
                var body = modal.querySelector('div[style*="padding"]') || modal.firstElementChild;
                if (body) body.appendChild(box);
            }
            // 拖拽到弹窗
            var drop = modal.querySelector('#singleFileSection') || modal;
            drop.ondragover = function (e) { e.preventDefault(); };
            drop.ondrop = function (e) {
                e.preventDefault();
                var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                if (!f) return;
                var input = document.getElementById('flFile');
                if (input) {
                    try {
                        var dt = new DataTransfer();
                        dt.items.add(f);
                        input.files = dt.files;
                        if (typeof global.handleFileSelect === 'function') global.handleFileSelect();
                    } catch (err) { /* ignore */ }
                }
            };
        }, 50);
    }

    async function addFileEnhanced(btn) {
        if (!canUploadShared()) { alert('访客不可上传'); return; }

        // 文件夹模式：逐文件上传到云端（旧逻辑只写本机 IndexedDB，其他人看不见）
        var folderSection = document.getElementById('folderFileSection');
        var folderItems = global.selectedFolderFiles;
        if (
            folderSection
            && folderSection.style.display !== 'none'
            && Array.isArray(folderItems)
            && folderItems.length
        ) {
            return uploadFolderToServer(btn, folderItems);
        }

        var nameEl = document.getElementById('flName');
        var fileInput = document.getElementById('flFile');
        if (nameEl && nameEl.value) nameEl.value = uniqueDisplayName(nameEl.value.trim());

        var progress = document.getElementById('flUploadProgress');
        var bar = document.getElementById('flUploadBar');
        var text = document.getElementById('flUploadText');
        if (progress) progress.style.display = 'block';
        if (bar) bar.style.width = '15%';
        if (text) text.textContent = '校验并准备上传…';

        var file = fileInput && fileInput.files && fileInput.files[0];
        var remark = (document.getElementById('flRemark') || {}).value || '';
        var type = (document.getElementById('flType') || {}).value || 'document';
        var displayName = (nameEl && nameEl.value) || (file && file.name) || '';

        var serverMeta = null;
        try {
            if (!file) throw new Error('请选择文件');
            if (bar) bar.style.width = '40%';
            if (text) text.textContent = '上传到云端…';
            serverMeta = await uploadToServer(file, {
                fileName: displayName,
                fileType: type,
                remark: remark
            });
            if (!serverMeta || !serverMeta.fileId) throw new Error('服务端未返回文件编号');
        } catch (e) {
            console.error('shared server upload failed', e);
            if (text) text.textContent = '云端上传失败';
            alert('必须上传到服务器后其他人才能看到。\n失败原因：' + (e && e.message ? e.message : e));
            return;
        }

        if (bar) bar.style.width = '70%';
        if (_origAddFile) {
            // 临时注入 remark：在 addFile 之后补写
            await Promise.resolve(_origAddFile(btn));
        }

        // 补写最近一条记录的 remark / serverFileId / 重名结果
        try {
            var list = getSharedList();
            if (list.length) {
                var last = list[0];
                // addFile 可能 unshift 或 push，找同名最近的
                var hit = list.find(function (f) {
                    return f.name === displayName || (file && f.name === file.name);
                }) || list[0];
                if (hit) {
                    if (remark) hit.remark = remark;
                    if (serverMeta && serverMeta.fileId) {
                        hit.serverFileId = serverMeta.fileId;
                        hit.storagePath = serverMeta.savedAs || '';
                    }
                    // 确保重名唯一
                    var others = list.filter(function (f) { return f !== hit && f.name === hit.name; });
                    if (others.length) hit.name = uniqueDisplayName(hit.name);
                    saveSharedMeta();
                }
            }
        } catch (e2) { /* ignore */ }

        if (bar) bar.style.width = '100%';
        if (text) text.textContent = '上传完成';
        setTimeout(function () {
            if (progress) progress.style.display = 'none';
        }, 600);
    }

    function showFileDetailEnhanced(id) {
        if (_origShowDetail) _origShowDetail(id);
        setTimeout(function () {
            var modal = document.querySelector('div[style*="z-index"][style*="fixed"]');
            if (!modal) return;
            var actions = modal.querySelector('div[style*="flex-end"]') || modal.querySelector('.btn') && modal.querySelector('.btn').parentElement;
            if (!actions || document.getElementById('sfRenameBtn_' + id)) return;
            var renameBtn = document.createElement('button');
            renameBtn.id = 'sfRenameBtn_' + id;
            renameBtn.className = 'btn btn-secondary';
            renameBtn.style.cssText = 'padding:8px 14px;font-size:13px;';
            renameBtn.textContent = '重命名';
            renameBtn.onclick = function () {
                renameSharedFile(id);
                modal.remove();
            };
            var logBtn = document.createElement('button');
            logBtn.className = 'btn btn-secondary';
            logBtn.style.cssText = 'padding:8px 14px;font-size:13px;';
            logBtn.textContent = '下载记录';
            logBtn.onclick = function () { showSharedDownloadLogs(id); };
            actions.insertBefore(logBtn, actions.firstChild);
            actions.insertBefore(renameBtn, actions.firstChild);
        }, 80);
    }

    function enhance() {
        if (enhanced) return;
        enhanced = true;

        if (typeof global.handleFileDownload === 'function') {
            _origDownload = global.handleFileDownload;
            global.handleFileDownload = handleFileDownloadEnhanced;
        }
        if (typeof global.deleteSharedFile === 'function') {
            _origDelete = global.deleteSharedFile;
            global.deleteSharedFile = deleteSharedFileEnhanced;
        }
        if (typeof global.batchDeleteFiles === 'function') {
            _origBatchDelete = global.batchDeleteFiles;
            global.batchDeleteFiles = batchDeleteSharedEnhanced;
        }
        wrapRenderFileList();

        if (typeof global.showAddFileModal === 'function') {
            _origShowAdd = global.showAddFileModal;
            global.showAddFileModal = showAddFileModalEnhanced;
        }
        if (typeof global.addFile === 'function') {
            _origAddFile = global.addFile;
            global.addFile = addFileEnhanced;
        }
        if (typeof global.showFileDetail === 'function') {
            _origShowDetail = global.showFileDetail;
            global.showFileDetail = showFileDetailEnhanced;
        }
        wrapSortFiles();

        global.renameSharedFile = renameSharedFile;
        global.showSharedDownloadLogs = showSharedDownloadLogs;
        global.batchDownloadSharedFiles = batchDownloadSharedFiles;
        global.downloadSharedFile = handleFileDownloadEnhanced;

        // 全站统一：任意模块把文件落到云端，全员可下载
        global.CitySafeCloudFiles = {
            upload: uploadToServer,
            saveForTeam: saveFileForTeam,
            downloadUrl: cloudDownloadUrl,
            requireServer: true
        };
        global.uploadFileToCloud = uploadToServer;
        global.saveFileForTeam = saveFileForTeam;
        global.cloudFileDownloadUrl = cloudDownloadUrl;
        global.__citysafeCloudUploadReady = true;

        enhanceSortSelect();
        enhanceBatchBar();

        // 模块进入时再增强一次 DOM
        var _origInit = global.initResourceModules;
        if (typeof _origInit === 'function') {
            global.initResourceModules = function () {
                var r = _origInit.apply(this, arguments);
                enhanceSortSelect();
                enhanceBatchBar();
                return r;
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(enhance, 0); });
    } else {
        setTimeout(enhance, 0);
    }

    // 全局联动：云端拉取（同页）/ 其他标签页写入时，刷新共享文件视图。
    var SF_SYNC_WATCH_KEYS = { sharedFileData: 1, sharedFileDownloadLogs: 1 };

    function refreshSharedLibraryFromSync(changedKey) {
        if (changedKey === 'sharedFileData') {
            try {
                global.sharedFileData = JSON.parse(localStorage.getItem('sharedFileData') || '[]');
            } catch (e) { /* 保留旧缓存 */ }
        }
        try {
            if (typeof global.renderFileList === 'function') global.renderFileList();
        } catch (e2) { /* 模块未挂载时忽略 */ }
    }

    try {
        global.addEventListener('storage', function (ev) {
            if (ev && ev.key && SF_SYNC_WATCH_KEYS[ev.key]) refreshSharedLibraryFromSync(ev.key);
        });
        global.addEventListener('citysafe:cloud-applied', function (ev) {
            var keys = (ev && ev.detail && ev.detail.keys) || [];
            var hit = keys.filter(function (k) { return SF_SYNC_WATCH_KEYS[k]; });
            if (hit.length) hit.forEach(refreshSharedLibraryFromSync);
        });
    } catch (eWatch) { /* ignore */ }

    global.SharedFileLibrary = {
        enhance: enhance,
        renameSharedFile: renameSharedFile,
        showSharedDownloadLogs: showSharedDownloadLogs,
        batchDownloadSharedFiles: batchDownloadSharedFiles,
        restoreSharedFile: restoreSharedFile,
        toggleSharedRecycleBin: toggleSharedRecycleBin
    };

    // 尽早挂到全局，供文献/报告/新闻等模块调用（不依赖 enhance 时机）
    global.CitySafeCloudFiles = {
        upload: uploadToServer,
        saveForTeam: saveFileForTeam,
        downloadUrl: cloudDownloadUrl,
        requireServer: true
    };
    global.uploadFileToCloud = uploadToServer;
    global.saveFileForTeam = saveFileForTeam;
    global.cloudFileDownloadUrl = cloudDownloadUrl;
    try {
        delete global.saveFileForTeam.__isCloudStub;
        delete global.cloudFileDownloadUrl.__isCloudStub;
        delete global.uploadFileToCloud.__isCloudStub;
    } catch (eFlag) { /* ignore */ }
    global.__citysafeCloudUploadReady = true;

})(typeof window !== 'undefined' ? window : this);
