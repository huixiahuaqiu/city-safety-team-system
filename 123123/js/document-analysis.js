/**
 * 文档智能解析模块（工程化落地版）
 * - 真实解析 PDF / DOCX / TXT（mammoth + pdf.js）+ 扫描件 OCR
 * - 单文件 / 多文件 / 文件夹批量识别
 * - 摘要 / 关键点 / 结构 + 大模型联析
 * - 文档问答聊天窗（基于已解析正文）
 * - 联动：入库文献对比、共享文件库、周报
 */
(function (global) {
    'use strict';

    var currentDocument = null;
    var documentContent = '';
    var documentMeta = null;
    var documentBusy = false;
    var docActiveTab = 'preview';
    var docLastResults = { summary: '', keypoints: '', structure: '' };
    var _pdfDocCache = null;
    var docLibrary = []; // {id,name,size,content,meta,status,error,file,relPath}
    var activeDocId = null;
    var docChatHistory = [];
    var docChatBusy = false;
    var OCR_MAX_PAGES = 12;
    var TEXT_MAX_PAGES = 80;
    var MIN_MEANINGFUL_SCORE = 48;
    var MAX_BATCH_FILES = 30;
    var MAX_FILE_BYTES = 30 * 1024 * 1024;
    var CHAT_CONTEXT_CHARS = 14000;
    var AI_SNIPPET_CHARS = 8000;
    var _docIdSeq = 1;

    function _esc(s) {
        if (typeof global.escHtml === 'function') return global.escHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _size(bytes) {
        if (typeof global.formatFileSize === 'function') return global.formatFileSize(bytes);
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function _owner() {
        var u = global.currentUser;
        return (u && (u.realName || u.username)) || '团队成员';
    }

    function emptyDocHtml() {
        return '<div class="doc-empty">' +
            '<div class="doc-empty-ico">📄</div>' +
            '<div class="doc-empty-title">上传文档或文件夹后开始智能解析</div>' +
            '<div class="doc-empty-desc">支持 PDF / DOCX / TXT。可批量识别文件夹，调用大模型联析，并在右侧问答。</div>' +
            '<div class="doc-empty-steps">' +
            '<span>1. 上传</span><span>2. 解析/OCR</span><span>3. AI 联析</span><span>4. 问答</span>' +
            '</div></div>';
    }

    function setDocStatus(text, type) {
        var el = document.getElementById('docStatusPill');
        if (!el) return;
        el.textContent = text || '待上传';
        el.className = 'doc-status-pill' + (type ? ' ' + type : '');
    }

    function bindUploadZone(zoneId, mode) {
        var zone = document.getElementById(zoneId);
        if (!zone || zone._bound) return;
        zone._bound = true;
        zone.addEventListener('click', function (e) {
            e.preventDefault();
            if (mode === 'whole') pickWholeFolder();
            else openDocPicker(mode === 'multi');
        });
        zone.addEventListener('dragover', function (e) {
            e.preventDefault();
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', function () {
            zone.classList.remove('dragover');
        });
        zone.addEventListener('drop', function (e) {
            e.preventDefault();
            zone.classList.remove('dragover');
            ingestDataTransfer(e.dataTransfer, { fromFolder: mode !== 'file' });
        });
    }

    function openDocPicker(asMulti) {
        // 普通多选：可进入目录、看到文件。不使用 webkitdirectory。
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        if (!asMulti) {
            input.accept = '.pdf,.docx,.txt,.md,application/pdf,text/plain';
        }
        input.addEventListener('change', function (event) {
            var files = event.target && event.target.files
                ? Array.prototype.slice.call(event.target.files)
                : [];
            if (files.length) {
                processDocumentFiles(files, { fromFolder: !!asMulti });
            }
            setTimeout(function () {
                if (input.parentNode) input.parentNode.removeChild(input);
            }, 0);
        });
        document.body.appendChild(input);
        input.click();
    }

    async function collectFilesFromDirHandle(dirHandle, prefix) {
        var out = [];
        prefix = prefix || dirHandle.name || '';
        for await (var entry of dirHandle.entries()) {
            var name = entry[0];
            var handle = entry[1];
            var rel = prefix ? (prefix + '/' + name) : name;
            if (handle.kind === 'file') {
                try {
                    var file = await handle.getFile();
                    try {
                        Object.defineProperty(file, 'webkitRelativePath', {
                            value: rel,
                            configurable: true
                        });
                    } catch (e2) {}
                    out.push(file);
                } catch (e3) {}
            } else if (handle.kind === 'directory') {
                var nested = await collectFilesFromDirHandle(handle, rel);
                out = out.concat(nested);
            }
        }
        return out;
    }

    function openWebkitDirectoryPicker() {
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        try { input.setAttribute('webkitdirectory', ''); } catch (e1) {}
        try { input.setAttribute('directory', ''); } catch (e2) {}
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        input.addEventListener('change', function (event) {
            var files = event.target && event.target.files
                ? Array.prototype.slice.call(event.target.files)
                : [];
            if (!files.length) {
                alert('未读到文件夹内容。\n\n提示：该对话框可能不显示文件名，属正常。\n请确认已选中目标文件夹后点「上传」。\n也可改用「多选文件」进入目录后 Ctrl+A，或直接拖拽文件夹。');
            } else {
                processDocumentFiles(files, { fromFolder: true });
            }
            setTimeout(function () {
                if (input.parentNode) input.parentNode.removeChild(input);
            }, 0);
        });
        document.body.appendChild(input);
        input.click();
    }

    async function pickWholeFolder() {
        // 优先 File System Access API：真正选整个目录并递归读取
        if (typeof window.showDirectoryPicker === 'function') {
            try {
                setDocStatus('选择文件夹…', 'busy');
                var dirHandle = await window.showDirectoryPicker({ mode: 'read' });
                setDocStatus('读取文件夹…', 'busy');
                showDocLoading('正在读取文件夹「' + (dirHandle.name || '') + '」…');
                var files = await collectFilesFromDirHandle(dirHandle, dirHandle.name || '');
                if (!files.length) {
                    setDocStatus('空文件夹', 'err');
                    alert('该文件夹下没有可读文件');
                    return;
                }
                await processDocumentFiles(files, { fromFolder: true });
                return;
            } catch (e) {
                if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
                    setDocStatus('已取消', '');
                    return;
                }
                console.warn('[doc] showDirectoryPicker failed, fallback webkitdirectory', e);
            }
        }
        // 回退：webkitdirectory（Windows 可能不列出文件名，但仍可选整个目录）
        openWebkitDirectoryPicker();
    }
    global.pickWholeFolder = pickWholeFolder;

    function wireDocInputs() {
        var fileInput = document.getElementById('documentUploadInput');
        var folderInput = document.getElementById('documentFolderInput');
        if (fileInput && !fileInput._bound) {
            fileInput._bound = true;
            fileInput.addEventListener('change', function (e) {
                handleDocumentUpload(e);
            });
        }
        if (folderInput && !folderInput._bound) {
            folderInput._bound = true;
            try { folderInput.removeAttribute('webkitdirectory'); } catch (e) {}
            try { folderInput.removeAttribute('directory'); } catch (e2) {}
            folderInput.multiple = true;
            try { folderInput.removeAttribute('accept'); } catch (e3) {}
            folderInput.addEventListener('change', function (e) {
                handleDocumentFolderUpload(e);
            });
        }
    }

    function initDocumentAnalysis() {
        wireDocInputs();
        bindUploadZone('docUploadZone', 'file');
        bindUploadZone('docMultiZone', 'multi');
        bindUploadZone('docFolderZone', 'whole');
        renderDocLibrary();
        renderDocChat();
        if (!okDocs().length) {
            var info = document.getElementById('documentInfo');
            if (info) info.style.display = 'none';
            var result = document.getElementById('documentAnalysisResult');
            if (result) result.innerHTML = emptyDocHtml();
            setDocStatus('待上传', '');
            updateDocActionState(false);
        } else {
            updateDocActionState(true);
            renderDocTabs();
        }
    }
    global.initDocumentAnalysis = initDocumentAnalysis;

    function okDocs() {
        return docLibrary.filter(function (d) { return d.status === 'ok' && d.content; });
    }

    function updateDocActionState(ready) {
        var hasOk = okDocs().length > 0;
        var enable = ready !== false && hasOk;
        ['docBtnSummary', 'docBtnKeys', 'docBtnStruct', 'docBtnAi', 'docBtnAiAll', 'docBtnOcr', 'docBtnLit', 'docBtnShare', 'docBtnWeekly'].forEach(function (id) {
            var btn = document.getElementById(id);
            if (!btn) return;
            if (id === 'docBtnOcr') {
                var entry = docLibrary.find(function (d) { return d.id === activeDocId; });
                var canOcr = !!_pdfDocCache || (entry && entry.file && /\.pdf$/i.test(entry.name));
                btn.disabled = !canOcr;
                return;
            }
            if (id === 'docBtnAiAll') {
                btn.disabled = okDocs().length < 1;
                return;
            }
            btn.disabled = !enable;
        });
        var send = document.getElementById('docChatSendBtn');
        if (send) send.disabled = !hasOk || docChatBusy;
        updateChatContextHint();
    }

    function fileExt(name) {
        var base = String(name || '').split(/[/\\]/).pop().toLowerCase();
        var m = base.match(/\.([a-z0-9]+)$/);
        return m ? m[1] : '';
    }

    function isSupportedDocName(name) {
        var ext = fileExt(name);
        return ext === 'pdf' || ext === 'docx' || ext === 'txt' || ext === 'md' || ext === 'text';
    }

    function isSupportedDocFile(file) {
        if (!file) return false;
        var name = file.name || '';
        if (isSupportedDocName(name)) return true;
        var mime = String(file.type || '').toLowerCase();
        if (mime === 'application/pdf') return true;
        if (mime === 'text/plain' || mime === 'text/markdown') return true;
        if (mime.indexOf('wordprocessingml') >= 0) return true; // docx
        return false;
    }

    function filterDocFiles(fileList) {
        var out = [];
        var skipped = [];
        var extCount = {};
        Array.prototype.forEach.call(fileList || [], function (f) {
            var base = String(f.name || '').split(/[/\\]/).pop() || '(未命名)';
            var ext = fileExt(base) || (f.type ? 'mime' : 'unknown');
            extCount[ext] = (extCount[ext] || 0) + 1;
            // 跳过系统垃圾文件
            if (/^\./.test(base) || base === 'Thumbs.db' || base === 'desktop.ini') {
                skipped.push(base + '（系统文件）');
                return;
            }
            if (!isSupportedDocFile(f)) {
                skipped.push(base + '（.' + ext + ' 暂不支持）');
                return;
            }
            if (f.size <= 0) {
                skipped.push(base + '（空文件）');
                return;
            }
            if (f.size > MAX_FILE_BYTES) {
                skipped.push(base + '（超过 30MB）');
                return;
            }
            out.push(f);
        });
        var seen = {};
        out = out.filter(function (f) {
            var key = (f.webkitRelativePath || f.name) + '|' + f.size;
            if (seen[key]) return false;
            seen[key] = 1;
            return true;
        });
        if (out.length > MAX_BATCH_FILES) {
            skipped.push('超出上限，仅处理前 ' + MAX_BATCH_FILES + ' 个可解析文件');
            out = out.slice(0, MAX_BATCH_FILES);
        }
        return { files: out, skipped: skipped, extCount: extCount, total: (fileList && fileList.length) || 0 };
    }

    function showScanReport(filtered, opts) {
        var box = document.getElementById('docScanReport');
        if (!box) return;
        opts = opts || {};
        box.style.display = 'block';
        var extLines = Object.keys(filtered.extCount || {}).map(function (k) {
            return k + '×' + filtered.extCount[k];
        }).join('，');
        box.innerHTML = '<div class="doc-scan-report">' +
            '<strong>' + (opts.fromFolder ? '文件夹扫描结果' : '文件扫描结果') + '</strong><br>' +
            '共发现 <strong>' + filtered.total + '</strong> 个文件，可解析 <strong>' + filtered.files.length + '</strong> 个' +
            (extLines ? ('<br><span class="muted">类型分布：' + _esc(extLines) + '</span>') : '') +
            (filtered.skipped.length
                ? ('<br><span class="muted">已跳过 ' + filtered.skipped.length + ' 个：' +
                    _esc(filtered.skipped.slice(0, 6).join('；')) +
                    (filtered.skipped.length > 6 ? '…' : '') + '</span>')
                : '') +
            '<br><span class="muted">批量导入：进入文件夹后 Ctrl+A 全选再打开；或直接拖拽整个文件夹到绿色框。</span>' +
            '</div>';
    }

    function handleDocumentUpload(event) {
        var list = event.target && event.target.files ? Array.prototype.slice.call(event.target.files) : [];
        // 延迟清空，避免部分浏览器清空后 File 引用失效
        var input = event.target;
        if (!list.length) return;
        processDocumentFiles(list, { fromFolder: false }).finally(function () {
            try { if (input) input.value = ''; } catch (e) {}
        });
    }
    global.handleDocumentUpload = handleDocumentUpload;

    function handleDocumentFolderUpload(event) {
        var list = event.target && event.target.files ? Array.prototype.slice.call(event.target.files) : [];
        var input = event.target;
        if (!list.length) {
            alert('未选中任何文件。\n\n正确做法：\n1) 在对话框里双击进入「蒋兄的论文」等目标文件夹\n2) 按 Ctrl+A 全选（或手动多选 PDF/DOCX/TXT）\n3) 点「打开」\n\n也可以把整个文件夹直接拖到绿色「批量导入」框上。');
            try { if (input) input.value = ''; } catch (e) {}
            return;
        }
        processDocumentFiles(list, { fromFolder: true }).finally(function () {
            try { if (input) input.value = ''; } catch (e2) {}
        });
    }
    global.handleDocumentFolderUpload = handleDocumentFolderUpload;

    async function ingestDataTransfer(dt, opts) {
        if (!dt) return;
        var files = [];
        // 优先用 webkitGetAsEntry 递归读取拖入的文件夹
        if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
            var entries = [];
            for (var i = 0; i < dt.items.length; i++) {
                var entry = dt.items[i].webkitGetAsEntry && dt.items[i].webkitGetAsEntry();
                if (entry) entries.push(entry);
            }
            if (entries.length) {
                for (var j = 0; j < entries.length; j++) {
                    var got = await readEntryFiles(entries[j]);
                    files = files.concat(got);
                }
            }
        }
        if (!files.length && dt.files && dt.files.length) {
            files = Array.prototype.slice.call(dt.files);
        }
        if (!files.length) {
            alert('拖拽未读取到文件');
            return;
        }
        return processDocumentFiles(files, opts || { fromFolder: true });
    }

    function readEntryFiles(entry) {
        return new Promise(function (resolve) {
            if (!entry) return resolve([]);
            if (entry.isFile) {
                entry.file(function (file) {
                    // 补齐相对路径，便于展示
                    try {
                        Object.defineProperty(file, 'webkitRelativePath', {
                            value: entry.fullPath ? String(entry.fullPath).replace(/^\//, '') : file.name,
                            configurable: true
                        });
                    } catch (e) {}
                    resolve([file]);
                }, function () { resolve([]); });
                return;
            }
            if (entry.isDirectory) {
                var reader = entry.createReader();
                var all = [];
                var readBatch = function () {
                    reader.readEntries(async function (batch) {
                        if (!batch.length) {
                            resolve(all);
                            return;
                        }
                        for (var i = 0; i < batch.length; i++) {
                            var sub = await readEntryFiles(batch[i]);
                            all = all.concat(sub);
                        }
                        readBatch();
                    }, function () { resolve(all); });
                };
                readBatch();
                return;
            }
            resolve([]);
        });
    }

    async function processDocumentFiles(fileList, opts) {
        opts = opts || {};
        if (documentBusy) {
            alert('正在解析中，请稍候');
            return;
        }
        var filtered = filterDocFiles(fileList);
        showScanReport(filtered, opts);

        if (!filtered.files.length) {
            setDocStatus('无可用文档', 'err');
            var box = document.getElementById('documentAnalysisResult');
            if (box) {
                box.innerHTML = '<div class="doc-error">文件夹/选择结果里没有可解析文档。' +
                    '<br>支持：PDF、DOCX、TXT、MD。' +
                    '<br>共发现 ' + filtered.total + ' 个文件，均被跳过。' +
                    (filtered.skipped.length
                        ? ('<br><br>跳过示例：<br>- ' + _esc(filtered.skipped.slice(0, 10).join('<br>- ')))
                        : '') +
                    '<br><br>旧版 .doc / CAJ / 图片请先转换为 PDF 或 DOCX。' +
                    '</div>';
            }
            // 把跳过项也列出来，避免“什么都没有”
            filtered.skipped.slice(0, 20).forEach(function (s) {
                var name = String(s).split('（')[0];
                docLibrary.unshift({
                    id: 'doc_' + (_docIdSeq++),
                    name: name || '未知文件',
                    relPath: name,
                    size: 0,
                    file: null,
                    content: '',
                    meta: null,
                    status: 'err',
                    error: s
                });
            });
            renderDocLibrary();
            alert('未找到可解析文档（支持 PDF / DOCX / TXT / MD）\n共发现 ' + filtered.total +
                ' 个文件\n' + (filtered.skipped.length ? '已跳过：\n- ' + filtered.skipped.slice(0, 8).join('\n- ') : ''));
            return;
        }

        documentBusy = true;
        updateDocActionState(false);
        setDocStatus(opts.fromFolder ? '文件夹解析中' : '解析中', 'busy');
        showDocLoading((opts.fromFolder ? '正在识别文件夹：' : '正在解析：') +
            '共 ' + filtered.files.length + ' / ' + filtered.total + ' 个文档…');

        var firstOkId = null;
        var okCount = 0;
        var failCount = 0;

        for (var i = 0; i < filtered.files.length; i++) {
            var file = filtered.files[i];
            var rel = file.webkitRelativePath || file.name;
            var displayName = String(rel).split(/[/\\]/).pop();
            var entry = {
                id: 'doc_' + (_docIdSeq++),
                name: displayName,
                relPath: rel,
                size: file.size,
                file: file,
                content: '',
                meta: null,
                status: 'busy',
                error: ''
            };
            docLibrary.unshift(entry);
            renderDocLibrary();
            showDocLoading('解析中 (' + (i + 1) + '/' + filtered.files.length + ')：' + displayName);
            setProgress(Math.floor((i / filtered.files.length) * 90) + 5);

            try {
                var parsed = await parseOneDocument(file, {
                    quiet: filtered.files.length > 1,
                    keepPdfCache: i === filtered.files.length - 1 || filtered.files.length === 1
                });
                entry.content = parsed.text;
                entry.meta = parsed.meta;
                entry.status = 'ok';
                entry.error = '';
                okCount++;
                if (!firstOkId) firstOkId = entry.id;
                if (typeof global.recordOperationLog === 'function') {
                    global.recordOperationLog('文档解析', opts.fromFolder ? '文件夹解析' : '上传解析',
                        '解析文档：' + displayName, {
                            fileName: displayName, chars: parsed.text.length, engine: parsed.meta.engine
                        }, { success: true }, 1, '', 0);
                }
            } catch (e) {
                entry.status = 'err';
                entry.error = (e && e.message) ? e.message : String(e);
                failCount++;
            }
            renderDocLibrary();
        }

        documentBusy = false;
        setProgress(100);

        if (firstOkId) {
            activateDoc(firstOkId);
            setDocStatus(okCount + ' 成功' + (failCount ? (' / ' + failCount + ' 失败') : ''), failCount ? 'err' : 'ok');
            if (opts.fromFolder && okCount > 1) {
                pushDocChatSystem('已识别文件夹内 ' + okCount + ' 份文档。可点「文件夹联析」或直接提问。');
            }
        } else {
            setDocStatus('全部失败', 'err');
            updateDocActionState(false);
            var box2 = document.getElementById('documentAnalysisResult');
            if (box2) {
                box2.innerHTML = '<div class="doc-error">未能成功解析任何文档。请检查格式，或对扫描 PDF 配置 OCR 后重试。' +
                    (filtered.skipped.length ? '<br>另有跳过：' + _esc(filtered.skipped.slice(0, 5).join('；')) : '') +
                    '</div>';
            }
            renderDocLibrary();
        }
    }
    global.processDocumentFiles = processDocumentFiles;

    async function parseOneDocument(file, opts) {
        opts = opts || {};
        var name = String(file.name || '').toLowerCase();
        var text = '';
        var meta = { pages: 0, engine: '', ocrPages: 0, note: '' };
        _pdfDocCache = null;

        if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.text') || (file.type || '').indexOf('text/') === 0) {
            text = await readAsText(file);
            meta.engine = name.endsWith('.md') ? 'markdown' : 'text';
        } else if (name.endsWith('.docx') || (file.type || '').indexOf('wordprocessingml') >= 0) {
            text = await parseDocx(file);
            meta.engine = 'mammoth';
        } else if (name.endsWith('.pdf') || (file.type || '') === 'application/pdf') {
            var pdfRes = await parsePdfSmart(file, { quiet: opts.quiet });
            text = pdfRes.text;
            meta.pages = pdfRes.pages;
            meta.engine = pdfRes.engine;
            meta.ocrPages = pdfRes.ocrPages || 0;
            meta.note = pdfRes.note || '';
            if (!opts.keepPdfCache) _pdfDocCache = null;
        } else {
            throw new Error('不支持的格式');
        }

        text = String(text || '').replace(/\r\n/g, '\n').trim();
        var score = meaningfulScore(text);
        if (score < MIN_MEANINGFUL_SCORE) {
            throw new Error(
                '未能提取到有效正文（有效分 ' + score + '）。' +
                (name.endsWith('.pdf') || (file.type || '') === 'application/pdf'
                    ? '可能是扫描件，请选中该文件后点「OCR 识别」。'
                    : '请检查文件内容。')
            );
        }
        return { text: text, meta: meta, score: score };
    }

    function activateDoc(id) {
        var entry = docLibrary.find(function (d) { return d.id === id; });
        if (!entry) return;
        activeDocId = id;
        currentDocument = {
            name: entry.name,
            type: (entry.file && entry.file.type) || '',
            size: entry.size,
            file: entry.file,
            id: entry.id,
            relPath: entry.relPath
        };
        documentContent = entry.content || '';
        documentMeta = entry.meta || null;
        _pdfDocCache = null;
        // 若当前是失败项但仍有 file，允许后续 OCR 时重建 cache
        docLastResults = { summary: '', keypoints: '', structure: '' };
        docActiveTab = 'preview';
        renderDocLibrary();
        renderDocFileCard(entry.status === 'ok', documentMeta || {}, documentContent.length);
        if (entry.status === 'ok' && documentContent) {
            docLastResults.keypoints = buildKeyPointsHtml();
            docLastResults.structure = buildStructureHtml();
            docLastResults.summary = buildSummaryHtml(false);
            renderDocTabs();
            setDocStatus('当前：' + entry.name, 'ok');
            updateDocActionState(true);
        } else {
            var box = document.getElementById('documentAnalysisResult');
            if (box) {
                box.innerHTML = '<div class="doc-error">该文件解析失败：' + _esc(entry.error || '未知错误') +
                    '<div style="margin-top:12px;">' +
                    '<button class="btn" onclick="retryActiveDocOcr()">🔍 尝试 OCR 重试</button>' +
                    '</div></div>';
            }
            updateDocActionState(false);
        }
        updateChatContextHint();
    }
    global.activateDoc = activateDoc;

    async function retryActiveDocOcr() {
        var entry = docLibrary.find(function (d) { return d.id === activeDocId; });
        if (!entry || !entry.file) {
            alert('没有可重试的 PDF');
            return;
        }
        if (!/\.pdf$/i.test(entry.name)) {
            alert('仅 PDF 支持 OCR 重试');
            return;
        }
        documentBusy = true;
        setDocStatus('OCR 重试中', 'busy');
        showDocLoading('正在 OCR：' + entry.name);
        try {
            var pdfjs = getPdfjs();
            var buf = await entry.file.arrayBuffer();
            var pdf = await pdfjs.getDocument({ data: buf }).promise;
            _pdfDocCache = pdf;
            var ocr = await ocrPdfDocument(pdf, OCR_MAX_PAGES);
            var score = meaningfulScore(ocr.text);
            if (score < MIN_MEANINGFUL_SCORE) throw new Error('OCR 仍未得到有效正文');
            entry.content = ocr.text;
            entry.meta = {
                pages: pdf.numPages,
                engine: 'pdf.js+OCR',
                ocrPages: ocr.ocrPages,
                note: pdf.numPages > ocr.ocrPages ? ('OCR 前 ' + ocr.ocrPages + '/' + pdf.numPages + ' 页') : ''
            };
            entry.status = 'ok';
            entry.error = '';
            activateDoc(entry.id);
        } catch (e) {
            entry.status = 'err';
            entry.error = (e && e.message) ? e.message : String(e);
            activateDoc(entry.id);
            alert('OCR 重试失败：' + entry.error);
        } finally {
            documentBusy = false;
            updateDocActionState(!!documentContent);
        }
    }
    global.retryActiveDocOcr = retryActiveDocOcr;

    function renderDocLibrary() {
        var box = document.getElementById('docLibraryList');
        if (!box) return;
        if (!docLibrary.length) {
            box.innerHTML = '';
            return;
        }
        var ok = okDocs().length;
        box.innerHTML = '<div class="doc-lib-title"><span>已载入文档</span><span>' + ok + '/' + docLibrary.length + ' 可用</span></div>' +
            docLibrary.map(function (d) {
                var badge = d.status === 'ok' ? '成功' : (d.status === 'busy' ? '解析中' : '失败');
                var badgeCls = d.status === 'ok' ? '' : (d.status === 'busy' ? 'busy' : 'err');
                return '<div class="doc-lib-item ' + (d.id === activeDocId ? 'active ' : '') + (d.status === 'err' ? 'err' : '') +
                    '" onclick="activateDoc(\'' + d.id + '\')">' +
                    '<div style="flex:1;min-width:0;">' +
                    '<div class="name">' + _esc(d.name) + '</div>' +
                    '<div class="sub">' + _esc(_size(d.size)) +
                    (d.relPath && d.relPath !== d.name ? (' · ' + _esc(d.relPath)) : '') +
                    (d.status === 'ok' ? (' · ' + (d.content || '').length + ' 字') : '') +
                    (d.error ? (' · ' + _esc(d.error).slice(0, 40)) : '') +
                    '</div></div>' +
                    '<span class="doc-lib-badge ' + badgeCls + '">' + badge + '</span></div>';
            }).join('');
    }

    function buildCorpusText(maxChars) {
        maxChars = maxChars || CHAT_CONTEXT_CHARS;
        var docs = okDocs();
        if (!docs.length) return '';
        // 优先当前文档，再补其它
        var ordered = docs.slice().sort(function (a, b) {
            if (a.id === activeDocId) return -1;
            if (b.id === activeDocId) return 1;
            return 0;
        });
        var parts = [];
        var used = 0;
        for (var i = 0; i < ordered.length; i++) {
            var d = ordered[i];
            var header = '### 文件：' + d.name + (d.relPath && d.relPath !== d.name ? '（' + d.relPath + '）' : '') + '\n';
            var budget = Math.max(400, Math.floor((maxChars - used) / (ordered.length - i)));
            var body = String(d.content || '').slice(0, budget);
            var block = header + body;
            if (used + block.length > maxChars) {
                block = block.slice(0, Math.max(0, maxChars - used));
            }
            parts.push(block);
            used += block.length;
            if (used >= maxChars) break;
        }
        return parts.join('\n\n');
    }

    function updateChatContextHint() {
        var el = document.getElementById('docChatContextHint');
        if (!el) return;
        var n = okDocs().length;
        if (!n) {
            el.textContent = '上传文档后，可基于当前/全部文档向大模型提问';
            return;
        }
        el.textContent = '上下文：当前「' + ((currentDocument && currentDocument.name) || '未选') +
            '」+ 共 ' + n + ' 份已解析文档（问答时自动汇总）';
    }

    function renderDocFileCard(ok, meta, chars) {
        var info = document.getElementById('documentInfo');
        if (!info || !currentDocument) return;
        meta = meta || {};
        var name = String(currentDocument.name || '').toLowerCase();
        info.style.display = 'block';
        info.innerHTML = '<div class="doc-file-card ' + (ok ? 'ok' : 'err') + '">' +
            '<div class="doc-file-icon">' + (name.endsWith('.pdf') ? '📕' : name.endsWith('.docx') ? '📘' : '📄') + '</div>' +
            '<div class="doc-file-meta">' +
            '<div class="doc-file-name">' + _esc(currentDocument.name) + '</div>' +
            '<div class="doc-file-sub">' + _esc(_size(currentDocument.size)) +
            (meta.pages ? (' · ' + meta.pages + ' 页') : '') +
            (ok ? (' · ' + chars + ' 字符 · ' + _esc(meta.engine || '')) : ' · 解析失败') +
            (meta.ocrPages ? (' · OCR ' + meta.ocrPages + ' 页') : '') +
            (meta.note ? (' · ' + _esc(meta.note)) : '') +
            (okDocs().length > 1 ? (' · 库内 ' + okDocs().length + ' 份') : '') +
            '</div></div></div>';
    }

    function setProgress(pct) {
        var bar = document.getElementById('docProgressBar');
        if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }

    function showDocLoading(msg) {
        var box = document.getElementById('documentAnalysisResult');
        if (!box) return;
        box.innerHTML = '<div class="doc-loading"><div class="team-chat-typing"><span></span><span></span><span></span></div><div>' + _esc(msg || '处理中…') + '</div></div>';
    }

    function readAsText(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('文本读取失败')); };
            reader.readAsText(file, 'utf-8');
        });
    }

    async function parseDocx(file) {
        if (typeof global.mammoth === 'undefined') throw new Error('mammoth 未加载');
        var buf = await file.arrayBuffer();
        var res = await global.mammoth.extractRawText({ arrayBuffer: buf });
        return res && res.value ? res.value : '';
    }

    function meaningfulScore(text) {
        var s = String(text || '');
        // 去掉页码/空白噪声，避免把「仅解析前 N 页」这类元信息当成正文
        s = s.replace(/…（仅解析前[\s\S]*?页）/g, '').replace(/\s+/g, '');
        if (!s) return 0;
        var cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
        var latin = (s.match(/[A-Za-z]/g) || []).length;
        var digits = (s.match(/\d/g) || []).length;
        // 扫描件空文本层常只有少量符号/页码噪声
        return cjk * 2 + latin + Math.min(digits, 20);
    }

    function getPdfjs() {
        var pdfjs = global.pdfjsLib || global.pdfjs;
        if (!pdfjs) throw new Error('PDF.js 未加载');
        if (pdfjs.GlobalWorkerOptions) {
            pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js';
        }
        return pdfjs;
    }

    async function extractPdfTextLayer(pdf, maxPages) {
        var limit = Math.min(pdf.numPages, maxPages || TEXT_MAX_PAGES);
        var parts = [];
        for (var i = 1; i <= limit; i++) {
            setProgress(18 + Math.floor((i / limit) * 35));
            var page = await pdf.getPage(i);
            var tc = await page.getTextContent();
            var line = (tc.items || []).map(function (it) { return it.str || ''; }).join('').trim();
            if (line) parts.push(line);
        }
        return { text: parts.join('\n\n').trim(), parsedPages: limit };
    }

    function ocrEndpointCandidates() {
        var list = [];
        // 同域本地网关（start_web / working_proxy）
        list.push('/api/baidu-ocr');
        var proxy = '';
        try { proxy = String(global.API_PROXY || '').replace(/\/$/, ''); } catch (e) {}
        if (proxy) list.push(proxy + '/api/baidu-ocr');
        return list;
    }

    async function callBaiduOcr(imageB64) {
        var endpoints = ocrEndpointCandidates();
        var lastErr = null;
        for (var i = 0; i < endpoints.length; i++) {
            try {
                var resp = await fetch(endpoints[i], {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: imageB64 })
                });
                var data = null;
                try { data = await resp.json(); } catch (e) { data = null; }
                if (!resp.ok) {
                    lastErr = new Error((data && data.error) || ('OCR HTTP ' + resp.status));
                    continue;
                }
                if (data && data.error_code) {
                    lastErr = new Error('百度 OCR ' + data.error_code + ': ' + (data.error_msg || '失败'));
                    continue;
                }
                var words = (data && data.words_result) || [];
                return words.map(function (w) { return w.words || ''; }).filter(Boolean).join('\n');
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('OCR 请求失败');
    }

    async function renderPdfPageToJpegBase64(page, scale) {
        var viewport = page.getViewport({ scale: scale || 1.6 });
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        // 控制体积，避免超过百度 OCR ~4MB 限制
        var quality = 0.82;
        var dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > 3800000 && quality > 0.45) {
            quality -= 0.12;
            dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        canvas.width = 0;
        canvas.height = 0;
        return dataUrl.split(',')[1] || '';
    }

    async function ocrPdfDocument(pdf, maxPages) {
        var limit = Math.min(pdf.numPages, maxPages || OCR_MAX_PAGES);
        var parts = [];
        showDocLoading('检测到无文本层，正在 OCR 识别（前 ' + limit + ' / ' + pdf.numPages + ' 页）…');
        for (var i = 1; i <= limit; i++) {
            setProgress(55 + Math.floor((i / limit) * 40));
            showDocLoading('OCR 识别中：第 ' + i + ' / ' + limit + ' 页…');
            var page = await pdf.getPage(i);
            var b64 = await renderPdfPageToJpegBase64(page, 1.55);
            if (!b64) continue;
            var pageText = '';
            try {
                pageText = await callBaiduOcr(b64);
            } catch (e) {
                if (i === 1) throw e; // 首页就失败则整体失败
                // 后续页失败则跳过，保留已识别内容
                console.warn('[doc-ocr] page ' + i + ' failed', e);
            }
            if (pageText && pageText.trim()) {
                parts.push('【第' + i + '页】\n' + pageText.trim());
            }
        }
        return { text: parts.join('\n\n').trim(), ocrPages: limit };
    }

    async function parsePdfSmart(file, opts) {
        opts = opts || {};
        var pdfjs = getPdfjs();
        var buf = await file.arrayBuffer();
        var pdf = await pdfjs.getDocument({ data: buf }).promise;
        _pdfDocCache = pdf;
        if (!opts.quiet) showDocLoading('正在抽取 PDF 文本层（共 ' + pdf.numPages + ' 页）…');
        var layer = await extractPdfTextLayer(pdf, TEXT_MAX_PAGES);
        var score = meaningfulScore(layer.text);
        if (score >= MIN_MEANINGFUL_SCORE) {
            var note = pdf.numPages > layer.parsedPages
                ? ('仅解析前 ' + layer.parsedPages + '/' + pdf.numPages + ' 页')
                : '';
            return {
                text: layer.text,
                pages: pdf.numPages,
                engine: 'pdf.js',
                ocrPages: 0,
                note: note
            };
        }
        if (!opts.quiet) showDocLoading('文本层不足，自动 OCR…');
        var ocr = await ocrPdfDocument(pdf, OCR_MAX_PAGES);
        return {
            text: ocr.text,
            pages: pdf.numPages,
            engine: 'pdf.js+OCR',
            ocrPages: ocr.ocrPages,
            note: pdf.numPages > ocr.ocrPages ? ('OCR 前 ' + ocr.ocrPages + '/' + pdf.numPages + ' 页') : ''
        };
    }

    function syncActiveEntryContent() {
        var entry = docLibrary.find(function (d) { return d.id === activeDocId; });
        if (!entry) return;
        entry.content = documentContent;
        entry.meta = documentMeta;
        entry.status = documentContent ? 'ok' : entry.status;
        entry.error = documentContent ? '' : entry.error;
        renderDocLibrary();
    }

    async function ensurePdfCacheForActive() {
        if (_pdfDocCache) return true;
        var entry = docLibrary.find(function (d) { return d.id === activeDocId; });
        var file = (entry && entry.file) || (currentDocument && currentDocument.file);
        if (!file || !/\.pdf$/i.test((entry && entry.name) || (currentDocument && currentDocument.name) || '')) return false;
        var pdfjs = getPdfjs();
        var buf = await file.arrayBuffer();
        _pdfDocCache = await pdfjs.getDocument({ data: buf }).promise;
        return true;
    }

    async function ocrCurrentPdf(force) {
        if (documentBusy) return;
        try {
            var ok = await ensurePdfCacheForActive();
            if (!ok || !_pdfDocCache) {
                alert('请先选中一份 PDF 文档');
                return;
            }
        } catch (e) {
            alert('加载 PDF 失败：' + (e && e.message ? e.message : e));
            return;
        }
        if (!force && documentContent && meaningfulScore(documentContent) >= MIN_MEANINGFUL_SCORE) {
            if (!confirm('当前已有可用正文，仍要重新 OCR 吗？')) return;
        }
        documentBusy = true;
        setDocStatus('OCR 中', 'busy');
        updateDocActionState(false);
        try {
            var ocr = await ocrPdfDocument(_pdfDocCache, OCR_MAX_PAGES);
            var score = meaningfulScore(ocr.text);
            if (score < MIN_MEANINGFUL_SCORE) {
                throw new Error('OCR 未识别到有效正文（有效分 ' + score + '）。请检查百度 OCR 密钥或云端 Worker。');
            }
            documentContent = ocr.text;
            documentMeta = {
                pages: _pdfDocCache.numPages,
                engine: 'pdf.js+OCR',
                ocrPages: ocr.ocrPages,
                note: _pdfDocCache.numPages > ocr.ocrPages
                    ? ('OCR 前 ' + ocr.ocrPages + '/' + _pdfDocCache.numPages + ' 页')
                    : ''
            };
            syncActiveEntryContent();
            renderDocFileCard(true, documentMeta, documentContent.length);
            setDocStatus('OCR 就绪', 'ok');
            updateDocActionState(true);
            docLastResults.keypoints = buildKeyPointsHtml();
            docLastResults.structure = buildStructureHtml();
            docLastResults.summary = buildSummaryHtml(false);
            docActiveTab = 'preview';
            renderDocTabs();
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('文档解析', 'OCR', 'OCR 识别：' + (currentDocument && currentDocument.name || ''), {
                    chars: documentContent.length, ocrPages: ocr.ocrPages
                }, { success: true }, 1, '', 0);
            }
        } catch (e) {
            setDocStatus('OCR 失败', 'err');
            var box = document.getElementById('documentAnalysisResult');
            if (box) {
                box.innerHTML = '<div class="doc-error">OCR 失败：' + _esc(e && e.message ? e.message : String(e)) +
                    '<div style="margin-top:10px;font-size:12px;line-height:1.7;">' +
                    '请确认：① 通过 <code>start_web.py</code> 访问本站；② <code>123123/.env</code> 已配置 <code>BAIDU_OCR_API_KEY</code> / <code>BAIDU_OCR_SECRET_KEY</code>；' +
                    '③ 或云端 Worker 已配置同名密钥。' +
                    '</div>' +
                    '<div style="margin-top:12px;"><button class="btn" onclick="ocrCurrentPdf(true)">重试 OCR</button></div></div>';
            }
            updateDocActionState(false);
        } finally {
            documentBusy = false;
            updateDocActionState(!!documentContent);
        }
    }
    global.ocrCurrentPdf = ocrCurrentPdf;

    function renderDocTabs() {
        var box = document.getElementById('documentAnalysisResult');
        if (!box) return;
        var tabs = [
            { id: 'preview', label: '预览' },
            { id: 'summary', label: '摘要' },
            { id: 'keypoints', label: '关键点' },
            { id: 'structure', label: '结构' }
        ];
        var body = '';
        if (docActiveTab === 'preview') body = buildPreviewHtml();
        else if (docActiveTab === 'summary') body = docLastResults.summary || '<div class="doc-hint">点击「提取摘要」生成</div>';
        else if (docActiveTab === 'keypoints') body = docLastResults.keypoints || '<div class="doc-hint">点击「提取关键点」生成</div>';
        else body = docLastResults.structure || '<div class="doc-hint">点击「分析结构」生成</div>';

        box.innerHTML =
            '<div class="doc-tabs">' + tabs.map(function (t) {
                return '<button type="button" class="doc-tab' + (docActiveTab === t.id ? ' active' : '') + '" onclick="switchDocTab(\'' + t.id + '\')">' + t.label + '</button>';
            }).join('') + '</div>' +
            '<div class="doc-pane">' + body + '</div>';
    }

    function switchDocTab(tab) {
        docActiveTab = tab || 'preview';
        renderDocTabs();
    }
    global.switchDocTab = switchDocTab;

    function buildPreviewHtml() {
        var preview = documentContent.slice(0, 1800);
        return '<div class="doc-card-soft">' +
            '<div class="doc-card-title">文档内容预览</div>' +
            '<div class="doc-preview-text">' + _esc(preview) + (documentContent.length > 1800 ? '…' : '') + '</div>' +
            '<div class="doc-stat-row">' +
            '<span>' + documentContent.length + ' 字符</span>' +
            '<span>' + documentContent.split(/\n/).filter(Boolean).length + ' 非空行</span>' +
            (documentMeta && documentMeta.pages ? ('<span>' + documentMeta.pages + ' 页</span>') : '') +
            '</div></div>';
    }

    function buildSummaryHtml(fromAi, aiText) {
        if (fromAi && aiText) {
            return '<div class="doc-card-soft"><div class="doc-card-title">AI 摘要</div><div class="doc-prose">' + _esc(aiText) + '</div></div>';
        }
        var sentences = documentContent.split(/[。！？!?\n]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 12; });
        var summary = sentences.slice(0, 4).join('。') + (sentences.length ? '。' : '');
        var cores = extractCorePoints().map(function (p) { return '<li>' + _esc(p) + '</li>'; }).join('');
        return '<div class="doc-card-soft">' +
            '<div class="doc-card-title">本地摘要（规则抽取）</div>' +
            '<div class="doc-meta-line">来源：' + _esc(currentDocument && currentDocument.name || '') + '</div>' +
            '<div class="doc-prose">' + _esc(summary || '内容过短，无法生成摘要') + '</div>' +
            '<div class="doc-card-title" style="margin-top:14px;">核心线索</div>' +
            '<ul class="doc-ul">' + (cores || '<li>暂无线索</li>') + '</ul></div>';
    }

    function extractCorePoints() {
        var points = [];
        var lines = documentContent.split('\n').filter(function (l) { return l.trim(); });
        lines.forEach(function (line) {
            if (/关键词|Key\s*words/i.test(line)) points.push('关键词：' + line.replace(/.*(关键词|Key\s*words)\s*[:：]\s*/i, '').trim().slice(0, 80));
            else if (/^[\d一二三四五六七八九十]+[\.、．]/.test(line.trim())) points.push(line.trim().slice(0, 60));
        });
        if (!points.length) {
            points.push('文档约 ' + documentContent.length + ' 字符');
            var kws = extractKeywords(documentContent).slice(0, 5);
            if (kws.length) points.push('高频词：' + kws.join('、'));
        }
        return points.slice(0, 6);
    }

    function extractKeywords(text) {
        var stop = { '的': 1, '是': 1, '在': 1, '有': 1, '和': 1, '了': 1, '与': 1, '及': 1, '等': 1, '为': 1, '对': 1, '中': 1, '上': 1, '下': 1, '通过': 1, '进行': 1, '可以': 1, '我们': 1, '本文': 1, '研究': 1, '基于': 1, '一个': 1, '以及': 1, '或者': 1, '如果': 1, '因为': 1, '所以': 1, '但是': 1, '这个': 1, '那个': 1, '他们': 1, '以及': 1 };
        var words = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ').split(/\s+/);
        var count = {};
        words.forEach(function (w) {
            if (!w || w.length < 2 || stop[w]) return;
            count[w] = (count[w] || 0) + 1;
        });
        return Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).slice(0, 12);
    }

    function extractNumbers(text) {
        var patterns = [
            /\d+(?:\.\d+)?\s*%/g,
            /\d+(?:\.\d+)?\s*(?:秒|毫秒|分钟|小时|天|周|月|年|mAP|FPS|MB|GB)/gi,
            /(?:准确率|精度|召回|F1|mAP|FPS)\s*[:：]?\s*\d+(?:\.\d+)?%?/gi
        ];
        var out = [];
        patterns.forEach(function (re) {
            var m;
            while ((m = re.exec(text)) !== null) out.push(m[0]);
        });
        return Array.from(new Set(out)).slice(0, 10);
    }

    function extractNames(text) {
        var patterns = [
            /([\u4e00-\u9fa5]{2,4})\s*(?:教授|副教授|研究员|博士|硕士|老师)/g,
            /作者\s*[:：]\s*([^\n]{2,40})/g
        ];
        var out = [];
        patterns.forEach(function (re) {
            var m;
            while ((m = re.exec(text)) !== null) out.push(m[1]);
        });
        return Array.from(new Set(out)).slice(0, 8);
    }

    function extractDates(text) {
        var patterns = [
            /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/g,
            /\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}/g,
            /\d{4}\s*年/g
        ];
        var out = [];
        patterns.forEach(function (re) {
            var m;
            while ((m = re.exec(text)) !== null) out.push(m[0]);
        });
        return Array.from(new Set(out)).slice(0, 8);
    }

    function buildKeyPointsHtml() {
        var keywords = extractKeywords(documentContent);
        var numbers = extractNumbers(documentContent);
        var names = extractNames(documentContent);
        var dates = extractDates(documentContent);
        return '<div class="doc-card-soft">' +
            '<div class="doc-card-title">关键信息</div>' +
            '<div class="doc-kv"><strong>关键词</strong><div class="doc-chips">' +
            (keywords.length ? keywords.map(function (k) { return '<span>#' + _esc(k) + '</span>'; }).join('') : '<span class="muted">暂无</span>') +
            '</div></div>' +
            '<div class="doc-kv"><strong>重要数据</strong><ul class="doc-ul">' +
            (numbers.length ? numbers.map(function (n) { return '<li>' + _esc(n) + '</li>'; }).join('') : '<li>暂无</li>') +
            '</ul></div>' +
            '<div class="doc-kv"><strong>相关人员</strong><ul class="doc-ul">' +
            (names.length ? names.map(function (n) { return '<li>' + _esc(n) + '</li>'; }).join('') : '<li>暂无</li>') +
            '</ul></div>' +
            '<div class="doc-kv"><strong>时间信息</strong><ul class="doc-ul">' +
            (dates.length ? dates.map(function (d) { return '<li>' + _esc(d) + '</li>'; }).join('') : '<li>暂无</li>') +
            '</ul></div></div>';
    }

    function analyzeDocumentStructure(text) {
        var lines = text.split('\n').filter(function (l) { return l.trim(); });
        var structure = [];
        var current = null;
        lines.forEach(function (line) {
            var t = line.trim();
            var l1 = t.match(/^((?:第?[一二三四五六七八九十百]+[章节部]|[一二三四五六七八九十]+、|\d+[\.、．]))\s*(.+)$/);
            var l2 = t.match(/^(\d+\.\d+[\.、．]?|[（(][一二三四五六七八九十\d]+[)）])\s*(.+)$/);
            var abs = /^(摘要|Abstract|引言|Introduction|结论|Conclusion|参考文献|References)\b/i.test(t);
            if (abs || l1) {
                current = { title: t.slice(0, 80), level: 1, children: [] };
                structure.push(current);
            } else if (l2 && current) {
                current.children.push({ title: t.slice(0, 80), level: 2 });
            }
        });
        return structure.slice(0, 40);
    }

    function buildStructureHtml() {
        var structure = analyzeDocumentStructure(documentContent);
        var lines = documentContent.split('\n');
        var nonEmpty = lines.filter(function (l) { return l.trim(); }).length;
        var html = '<div class="doc-card-soft"><div class="doc-card-title">文档结构</div>';
        if (structure.length) {
            html += '<div class="doc-tree">';
            structure.forEach(function (sec) {
                html += '<div class="doc-tree-item"><strong>' + _esc(sec.title) + '</strong>';
                if (sec.children && sec.children.length) {
                    html += '<div class="doc-tree-children">' + sec.children.map(function (c) {
                        return '<div>' + _esc(c.title) + '</div>';
                    }).join('') + '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        } else {
            html += '<div class="doc-hint">未识别到明显标题层级，已给出统计信息</div>';
        }
        html += '<div class="doc-stat-row" style="margin-top:12px;">' +
            '<span>总行 ' + lines.length + '</span>' +
            '<span>非空行 ' + nonEmpty + '</span>' +
            '<span>字符 ' + documentContent.length + '</span></div></div>';
        return html;
    }

    function extractDocumentSummary() {
        if (!ensureDocReady()) return;
        docLastResults.summary = buildSummaryHtml(false);
        docActiveTab = 'summary';
        renderDocTabs();
    }
    global.extractDocumentSummary = extractDocumentSummary;

    function extractDocumentKeyPoints() {
        if (!ensureDocReady()) return;
        docLastResults.keypoints = buildKeyPointsHtml();
        docActiveTab = 'keypoints';
        renderDocTabs();
    }
    global.extractDocumentKeyPoints = extractDocumentKeyPoints;

    function extractDocumentStructure() {
        if (!ensureDocReady()) return;
        docLastResults.structure = buildStructureHtml();
        docActiveTab = 'structure';
        renderDocTabs();
    }
    global.extractDocumentStructure = extractDocumentStructure;

    function ensureDocReady() {
        if (!okDocs().length || !documentContent) {
            alert('请先上传并成功解析文档');
            return false;
        }
        return true;
    }

    function resolveDocApiKey() {
        return typeof global.getChatApiKey === 'function'
            ? global.getChatApiKey()
            : (localStorage.getItem('openaiApiKey') || '');
    }

    function resolveDocModel() {
        return ((document.getElementById('openaiModel') || {}).value) || 'qwen-plus';
    }

    function llmEndpointCandidates() {
        var list = ['/api/aliyun'];
        var proxy = '';
        try { proxy = String(global.API_PROXY || '').replace(/\/$/, ''); } catch (e) {}
        if (proxy) list.push(proxy + '/api/aliyun');
        return list;
    }

    async function callDocLLM(messages, opts) {
        opts = opts || {};
        var apiKey = resolveDocApiKey();
        if (!apiKey) throw new Error('未配置百炼密钥，请到「智能工具 → OpenAI入口」保存后再用');
        var endpoints = llmEndpointCandidates();
        var lastErr = null;
        for (var i = 0; i < endpoints.length; i++) {
            try {
                var resp = await fetch(endpoints[i], {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        apiKey: apiKey,
                        model: opts.model || resolveDocModel(),
                        messages: messages,
                        temperature: opts.temperature != null ? opts.temperature : 0.3,
                        max_tokens: opts.max_tokens || 1800
                    })
                });
                var text = await resp.text();
                var data = null;
                try { data = JSON.parse(text); } catch (e) { data = null; }
                if (!resp.ok) {
                    lastErr = new Error('HTTP ' + resp.status + ' ' + text.slice(0, 160));
                    continue;
                }
                var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
                if (!content) {
                    lastErr = new Error('模型无返回');
                    continue;
                }
                return String(content).trim();
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('大模型请求失败');
    }

    async function aiEnhanceDocument() {
        if (!ensureDocReady()) return;
        var btn = document.getElementById('docBtnAi');
        if (btn) { btn.disabled = true; btn.textContent = 'AI 分析中…'; }
        showDocLoading('大模型正在分析当前文档…');
        setDocStatus('AI 分析中', 'busy');
        try {
            var snippet = documentContent.slice(0, AI_SNIPPET_CHARS);
            var content = await callDocLLM([
                {
                    role: 'system',
                    content: '你是城市安全科研团队的文档分析助手。基于给定文本输出简体中文：1) 200字内摘要；2) 5条关键点；3) 适用场景/规范要点（若有）；4) 勿编造原文没有的信息。'
                },
                {
                    role: 'user',
                    content: '文件名：' + (currentDocument.name || '') + '\n\n正文：\n' + snippet
                }
            ], { max_tokens: 1800 });
            docLastResults.summary = buildSummaryHtml(true, content);
            docActiveTab = 'summary';
            setDocStatus('AI 完成', 'ok');
            renderDocTabs();
            pushDocChatSystem('已完成「' + currentDocument.name + '」的 AI 增强摘要，可继续追问细节。');
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('文档解析', 'AI增强', 'AI 解析：' + currentDocument.name, {}, { success: true }, 1, '', 0);
            }
        } catch (e) {
            setDocStatus('AI 失败', 'err');
            alert('AI 增强失败：' + (e && e.message ? e.message : e));
            renderDocTabs();
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '✨ AI 增强摘要'; }
            updateDocActionState(true);
        }
    }
    global.aiEnhanceDocument = aiEnhanceDocument;

    async function aiAnalyzeCorpus() {
        if (!okDocs().length) {
            alert('请先上传并解析至少一份文档');
            return;
        }
        var btn = document.getElementById('docBtnAiAll');
        if (btn) { btn.disabled = true; btn.textContent = '联析中…'; }
        showDocLoading('大模型正在联析全部文档…');
        setDocStatus('联析中', 'busy');
        try {
            var corpus = buildCorpusText(Math.min(CHAT_CONTEXT_CHARS, 12000));
            var names = okDocs().map(function (d) { return d.name; }).join('、');
            var content = await callDocLLM([
                {
                    role: 'system',
                    content: '你是科研文献联析助手。基于多份文档材料，用简体中文输出：\n1) 总体主题与覆盖范围\n2) 各文档一句话定位\n3) 共性与差异（条目）\n4) 对团队工程/研究的可执行建议\n不要编造材料中没有的信息；材料不足时明确说明。'
                },
                {
                    role: 'user',
                    content: '文档清单：' + names + '\n\n材料：\n' + corpus
                }
            ], { temperature: 0.35, max_tokens: 2200 });
            docLastResults.summary = buildSummaryHtml(true, '【文件夹/多文档联析】\n\n' + content);
            docActiveTab = 'summary';
            setDocStatus('联析完成', 'ok');
            renderDocTabs();
            pushDocChatMessage('assistant', content);
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('文档解析', 'AI联析', '联析文档数：' + okDocs().length, {}, { success: true }, 1, '', 0);
            }
        } catch (e) {
            setDocStatus('联析失败', 'err');
            alert('文件夹联析失败：' + (e && e.message ? e.message : e));
            renderDocTabs();
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🧠 文件夹联析'; }
            updateDocActionState(true);
        }
    }
    global.aiAnalyzeCorpus = aiAnalyzeCorpus;

    function renderDocChat() {
        var box = document.getElementById('docChatStream');
        if (!box) return;
        if (!docChatHistory.length) {
            box.innerHTML = '<div class="doc-hint" style="padding:28px 12px;">解析文档后即可提问。<br>支持追问当前文档，或对比文件夹内全部材料。</div>';
            return;
        }
        box.innerHTML = docChatHistory.map(function (m) {
            if (m.role === 'system') {
                return '<div class="doc-chat-row assistant"><div class="doc-chat-bubble assistant" style="opacity:.92;border-style:dashed;">' +
                    '<div class="doc-chat-label">系统</div>' + _esc(m.content) + '</div></div>';
            }
            var who = m.role === 'user' ? 'user' : 'assistant';
            var label = m.role === 'user' ? '我' : '文档助手';
            return '<div class="doc-chat-row ' + who + '"><div class="doc-chat-bubble ' + who + '">' +
                '<div class="doc-chat-label">' + label + '</div>' + _esc(m.content) + '</div></div>';
        }).join('');
        box.scrollTop = box.scrollHeight;
    }

    function pushDocChatMessage(role, content) {
        docChatHistory.push({ role: role, content: String(content || '') });
        if (docChatHistory.length > 40) docChatHistory = docChatHistory.slice(-40);
        renderDocChat();
    }

    function pushDocChatSystem(content) {
        pushDocChatMessage('system', content);
    }

    function clearDocChat() {
        docChatHistory = [];
        renderDocChat();
    }
    global.clearDocChat = clearDocChat;

    function askDocChatPreset(q) {
        var input = document.getElementById('docChatInput');
        if (input) input.value = q;
        sendDocChatMessage();
    }
    global.askDocChatPreset = askDocChatPreset;

    async function sendDocChatMessage() {
        if (docChatBusy) return;
        if (!okDocs().length) {
            alert('请先上传并成功解析文档');
            return;
        }
        var input = document.getElementById('docChatInput');
        var q = input ? String(input.value || '').trim() : '';
        if (!q) return;
        if (input) input.value = '';
        pushDocChatMessage('user', q);
        docChatBusy = true;
        updateDocActionState(true);
        var sendBtn = document.getElementById('docChatSendBtn');
        if (sendBtn) sendBtn.disabled = true;
        pushDocChatMessage('assistant', '思考中…');
        var thinkingIdx = docChatHistory.length - 1;
        try {
            var corpus = buildCorpusText(CHAT_CONTEXT_CHARS);
            var history = docChatHistory
                .filter(function (m) { return m.role === 'user' || m.role === 'assistant'; })
                .slice(0, -1) // 去掉占位
                .slice(-8)
                .map(function (m) { return { role: m.role, content: m.content }; });
            var messages = [
                {
                    role: 'system',
                    content: '你是城市安全团队的文档问答助手。只能依据提供的文档材料回答，使用简体中文。若材料不足请明确说不知道，不要编造。回答尽量具体、可执行，必要时引用文件名。'
                },
                {
                    role: 'user',
                    content: '【文档材料】\n' + corpus + '\n\n【当前问题】\n' + q
                }
            ];
            // 多轮：把近期对话附在后面（仍以材料为准）
            if (history.length > 1) {
                messages = [
                    messages[0],
                    { role: 'user', content: '【文档材料】\n' + corpus },
                    { role: 'assistant', content: '已读取材料，请提问。' }
                ].concat(history).concat([{ role: 'user', content: q }]);
            }
            var answer = await callDocLLM(messages, { temperature: 0.4, max_tokens: 1600 });
            docChatHistory[thinkingIdx] = { role: 'assistant', content: answer };
            renderDocChat();
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('文档解析', '文档问答', q.slice(0, 80), { docs: okDocs().length }, { success: true }, 1, '', 0);
            }
        } catch (e) {
            docChatHistory[thinkingIdx] = {
                role: 'assistant',
                content: '回答失败：' + (e && e.message ? e.message : String(e))
            };
            renderDocChat();
        } finally {
            docChatBusy = false;
            updateDocActionState(true);
        }
    }
    global.sendDocChatMessage = sendDocChatMessage;

    function guessLitFieldsFromDoc() {
        var title = '';
        var lines = documentContent.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        for (var i = 0; i < Math.min(lines.length, 8); i++) {
            if (lines[i].length > 12 && lines[i].length < 180 && !/摘要|Abstract|关键词/i.test(lines[i])) {
                title = lines[i];
                break;
            }
        }
        if (!title) title = (currentDocument && currentDocument.name || '未命名文档').replace(/\.[^.]+$/, '');
        var yearMatch = documentContent.match(/\b(20\d{2}|19\d{2})\b/);
        var author = '';
        var am = documentContent.match(/作者\s*[:：]\s*([^\n]{2,40})/);
        if (am) author = am[1].trim();
        var abs = '';
        var absM = documentContent.match(/(?:摘要|Abstract)\s*[:：]?\s*([\s\S]{30,500}?)(?:\n\s*\n|关键词|Key\s*words|1[\.、]|引言)/i);
        if (absM) abs = absM[1].replace(/\s+/g, ' ').trim();
        if (!abs) abs = documentContent.replace(/\s+/g, ' ').slice(0, 280);
        var kws = extractKeywords(documentContent).slice(0, 6);
        return {
            title: title.slice(0, 200),
            authors: author,
            year: yearMatch ? parseInt(yearMatch[1], 10) : null,
            venue: '',
            field: '文档解析导入',
            summary: abs,
            keywords: kws,
            group: '文档解析',
            owner: _owner(),
            ext: { innovation: '', scenario: '由文档智能解析自动入库' }
        };
    }

    function pushDocToLiteratureCompare() {
        if (!ensureDocReady()) return;
        if (!Array.isArray(global.compareLiteratureData)) {
            alert('文献对比模块未就绪，请先打开一次「文献对比分析」');
            return;
        }
        var item = guessLitFieldsFromDoc();
        var key = String(item.title || '').toLowerCase();
        var dup = global.compareLiteratureData.find(function (l) {
            return String(l.title || '').toLowerCase() === key;
        });
        if (dup) {
            if (!confirm('文献库已存在同名条目《' + dup.title + '》，仍要新增一份吗？')) return;
        }
        var newId = global.compareLiteratureData.length
            ? Math.max.apply(null, global.compareLiteratureData.map(function (l) { return Number(l.id) || 0; })) + 1
            : 1;
        item.id = newId;
        if (typeof global.normalizeLitItem === 'function') {
            // normalizeLitItem may not be exported; push raw and let init normalize later
        }
        // 轻量规范化
        item.author = item.authors;
        item.journal = item.venue;
        item.ext = item.ext || {};
        global.compareLiteratureData.unshift(item);
        try {
            localStorage.setItem('compareLiteratureData', JSON.stringify(global.compareLiteratureData));
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('compareLiteratureData', JSON.stringify(global.compareLiteratureData));
        } catch (e) {}
        // 同步资料库
        try {
            if (typeof global.upsertLiteratureFromExternal === 'function') {
                global.upsertLiteratureFromExternal({
                    title: item.title,
                    author: item.authors,
                    journal: item.venue,
                    year: item.year || '',
                    tags: (item.keywords || []).join(', '),
                    doi: item.doi || '',
                    summary: item.summary || '',
                    uploader: _owner(),
                    source: 'document_analysis'
                }, { skipIfExists: true, syncCompare: false });
            } else if (Array.isArray(global.literatureData)) {
                var lid = global.literatureData.length ? Math.max.apply(null, global.literatureData.map(function (l) { return Number(l.id) || 0; })) + 1 : 1;
                global.literatureData.unshift({
                    id: lid,
                    title: item.title,
                    author: item.authors,
                    journal: item.venue,
                    year: item.year || '',
                    tags: (item.keywords || []).join(', '),
                    uploader: _owner(),
                    uploadTime: new Date().toLocaleDateString('zh-CN')
                });
                localStorage.setItem('literatureData', JSON.stringify(global.literatureData));
                if (typeof global.cloudUpsert === 'function') global.cloudUpsert('literatureData', JSON.stringify(global.literatureData));
            }
        } catch (e2) {}
        if (typeof global.recordOperationLog === 'function') {
            global.recordOperationLog('文档解析', '入库对比', '文档入库文献对比：' + item.title, { title: item.title }, { success: true }, 1, '', 0);
        }
        alert('已入库文献对比：《' + item.title + '》');
        if (typeof global.showModule === 'function') global.showModule('literature_analysis');
    }
    global.pushDocToLiteratureCompare = pushDocToLiteratureCompare;

    async function saveDocResultToShared() {
        if (!ensureDocReady()) return;
        if (!Array.isArray(global.sharedFileData)) {
            alert('共享文件库未就绪');
            return;
        }
        var md = '# 文档解析结果\n\n' +
            '- 文件：' + currentDocument.name + '\n' +
            '- 字符数：' + documentContent.length + '\n\n' +
            '## 预览\n\n' + documentContent.slice(0, 3000) + '\n\n' +
            '## 摘要结果\n\n' + stripHtml(docLastResults.summary) + '\n\n' +
            '## 关键点\n\n' + stripHtml(docLastResults.keypoints) + '\n';
        var fileName = '文档解析_' + currentDocument.name.replace(/\.[^.]+$/, '') + '_' + new Date().toISOString().slice(0, 10) + '.md';
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
            size: _size(file.size),
            fileSizeBytes: file.size,
            type: 'md',
            mimeType: 'text/markdown',
            hasBlob: true,
            category: '文档解析成果',
            remark: '由文档智能解析导出',
            uploader: _owner(),
            uploaderId: (global.currentUser && global.currentUser.id) || 0,
            uploadTime: new Date().toLocaleDateString('zh-CN'),
            downloadCount: 0,
            tags: ['文档解析']
        });
        localStorage.setItem('sharedFileData', JSON.stringify(global.sharedFileData));
        try { if (typeof global.cloudUpsert === 'function') global.cloudUpsert('sharedFileData', JSON.stringify(global.sharedFileData)); } catch (e2) {}
        alert('已保存到共享文件库：' + fileName);
        if (typeof global.showModule === 'function') global.showModule('shared_files');
    }
    global.saveDocResultToShared = saveDocResultToShared;

    function stripHtml(html) {
        var d = document.createElement('div');
        d.innerHTML = html || '';
        return (d.textContent || '').trim();
    }

    function insertDocToWeeklyReport() {
        if (!ensureDocReady()) return;
        if (!Array.isArray(global.weeklyReportData)) {
            alert('周报模块未就绪');
            return;
        }
        var text = stripHtml(docLastResults.summary) || documentContent.slice(0, 800);
        var block = '\n\n【文档解析-' + new Date().toLocaleDateString('zh-CN') + '】\n文件：' + currentDocument.name + '\n' + text.slice(0, 2000);
        var myName = _owner();
        var now = new Date();
        var day = now.getDay() || 7;
        var start = new Date(now); start.setDate(now.getDate() - day + 1);
        var end = new Date(start); end.setDate(start.getDate() + 6);
        var weekRange = start.toISOString().slice(0, 10) + ' ~ ' + end.toISOString().slice(0, 10);
        var report = global.weeklyReportData.find(function (r) { return r.owner === myName && r.weekRange === weekRange; });
        if (report) {
            report.content = (report.content || '') + block;
            report.status = 'pending';
        } else {
            var newId = global.weeklyReportData.length
                ? Math.max.apply(null, global.weeklyReportData.map(function (r) { return Number(r.id) || 0; })) + 1
                : 1;
            global.weeklyReportData.push({
                id: newId, weekRange: weekRange, owner: myName,
                content: '文档解析进展：' + block, nextWeek: '', problems: '', notes: '由文档智能解析插入',
                status: 'pending', submitTime: new Date().toLocaleString('zh-CN'), reviewComment: '', visibility: 'all'
            });
        }
        try {
            if (typeof global.saveWeeklyReportData === 'function') global.saveWeeklyReportData();
            else {
                localStorage.setItem('weeklyReportData', JSON.stringify(global.weeklyReportData));
                if (typeof global.cloudUpsert === 'function') global.cloudUpsert('weeklyReportData', JSON.stringify(global.weeklyReportData));
            }
        } catch (e) {}
        alert('已写入本周周报');
        if (typeof global.showModule === 'function') global.showModule('weekly_report');
    }
    global.insertDocToWeeklyReport = insertDocToWeeklyReport;

    function clearDocumentAnalysis() {
        currentDocument = null;
        documentContent = '';
        documentMeta = null;
        _pdfDocCache = null;
        docLibrary = [];
        activeDocId = null;
        docChatHistory = [];
        docLastResults = { summary: '', keypoints: '', structure: '' };
        docActiveTab = 'preview';
        var input = document.getElementById('documentUploadInput');
        if (input) input.value = '';
        var folder = document.getElementById('documentFolderInput');
        if (folder) folder.value = '';
        var info = document.getElementById('documentInfo');
        if (info) { info.style.display = 'none'; info.innerHTML = ''; }
        var scan = document.getElementById('docScanReport');
        if (scan) { scan.style.display = 'none'; scan.innerHTML = ''; }
        var result = document.getElementById('documentAnalysisResult');
        if (result) result.innerHTML = emptyDocHtml();
        renderDocLibrary();
        renderDocChat();
        setDocStatus('待上传', '');
        updateDocActionState(false);
    }
    global.clearDocumentAnalysis = clearDocumentAnalysis;

    // 兼容旧调用名
    global.showDocumentContentPreview = function () {
        docActiveTab = 'preview';
        renderDocTabs();
    };

})(window);
