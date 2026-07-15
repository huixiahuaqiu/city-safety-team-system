/**
 * 数据集资源库 — AI 数据资产管理中心
 * 数据：localStorage datasetData + IndexedDB 分片/整文件 + cloudUpsert
 * 联动：模型训练 / 数据标注 / 项目管理
 */
(function (global) {
    'use strict';

    var DS_PAGE_SIZE = 12;
    var DS_BLOB_MAX = 80 * 1024 * 1024;
    var DS_CHUNK_SIZE = 8 * 1024 * 1024;
    var DS_CHUNK_RETRIES = 5;
    var DS_TAG_PRESETS = ['监测数据', '灾害识别', '交通预测', '城市安全', '目标检测', '语义分割', '结构监测'];
    var DS_CUSTOM_TAGS_KEY = 'datasetCustomTags';
    var DS_FAV_KEY = 'datasetFavorites';
    var DS_GROUP_KEY = 'datasetGroups';
    var DS_DL_LOG_KEY = 'datasetDownloadLogs';
    var DS_BLOB_DB = 'datasetBlobDB';
    var DS_BLOB_STORE = 'blobs';
    var DS_CHUNK_STORE = 'chunks';
    var dsServerCaps = null;

    var DATA_TYPE_OPTS = [
        { key: 'image', label: '图像数据', icon: '🖼️' },
        { key: 'table', label: '表格数据', icon: '📊' },
        { key: 'text', label: '文本数据', icon: '📝' },
        { key: 'multimodal', label: '多模态数据', icon: '🧩' }
    ];
    var ANNO_TYPE_OPTS = [
        { key: 'detection', label: '目标检测' },
        { key: 'segmentation', label: '语义分割' },
        { key: 'classification', label: '分类识别' },
        { key: 'none', label: '无标注' }
    ];

    var dsState = {
        page: 1,
        statFilter: '',
        dataType: '',
        annoType: '',
        tagFilter: '',
        groupId: '',
        sort: 'time_desc',
        dateFrom: '',
        dateTo: '',
        uploader: '',
        format: '',
        isPublic: '',
        selected: {},
        favorites: {},
        view: 'list',
        tagAddOpen: false,
        stylesInjected: false
    };

    var pendingDsFile = null;
    var pendingParse = null;
    var uploadCtrl = {
        paused: false,
        cancelled: false,
        progress: 0,
        abortController: null,
        modalId: '',
        statusText: null
    };

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

    function parseSizeToBytes(sizeStr) {
        var m = String(sizeStr || '').match(/([\d.]+)\s*(B|KB|MB|GB)/i);
        if (!m) return 0;
        var n = parseFloat(m[1]);
        var u = m[2].toUpperCase();
        if (u === 'GB') return Math.round(n * 1024 * 1024 * 1024);
        if (u === 'MB') return Math.round(n * 1024 * 1024);
        if (u === 'KB') return Math.round(n * 1024);
        return Math.round(n);
    }

    function parseSampleCount(samples) {
        var m = String(samples || '').replace(/,/g, '').match(/(\d+)/);
        return m ? Number(m[1]) : 0;
    }

    function labelOf(opts, key) {
        var hit = opts.find(function (o) { return o.key === key; });
        return hit ? hit.label : key || '—';
    }

    function iconOfDataType(key) {
        var hit = DATA_TYPE_OPTS.find(function (o) { return o.key === key; });
        return hit ? hit.icon : '📁';
    }

    function annoStatusOf(item) {
        if (item.annoStatus) return item.annoStatus;
        if (item.annoType && item.annoType !== 'none') return 'labeled';
        return 'unlabeled';
    }

    function annoStatusLabel(s) {
        return ({ labeled: '已标注', partial: '部分标注', unlabeled: '未标注' })[s] || '未标注';
    }

    function getDatasetData() {
        if (!Array.isArray(global.datasetData)) {
            try { global.datasetData = JSON.parse(localStorage.getItem('datasetData') || '[]'); }
            catch (e) { global.datasetData = []; }
        }
        return global.datasetData;
    }

    function saveDatasetData() {
        var data = getDatasetData();
        localStorage.setItem('datasetData', JSON.stringify(data));
        try {
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('datasetData', JSON.stringify(data));
        } catch (e) { /* ignore */ }
        try {
            if (typeof global.syncGlobalsForExternalModules === 'function') global.syncGlobalsForExternalModules();
        } catch (e2) { /* ignore */ }
    }

    function normalizeDatasetRecord(r) {
        if (!r || typeof r !== 'object') return null;
        var tags = parseTags(r.tags || r.tagList);
        var sizeBytes = Number(r.sizeBytes) || parseSizeToBytes(r.size);
        var sampleCount = Number(r.sampleCount) || parseSampleCount(r.samples);
        var dataType = r.dataType || guessDataType(r.format, r.name);
        var annoType = r.annoType || (tags.some(function (t) { return /检测|分割|分类/.test(t); }) ? 'detection' : 'none');
        var version = r.version || 'V1.0';
        var versions = Array.isArray(r.versions) && r.versions.length ? r.versions : [{
            version: version,
            updateTime: r.uploadTime || '',
            note: '初始版本',
            size: r.size || formatBytes(sizeBytes),
            sizeBytes: sizeBytes
        }];
        return Object.assign({}, r, {
            id: Number(r.id) || Date.now(),
            name: String(r.name || '未命名数据集'),
            size: r.size || formatBytes(sizeBytes),
            sizeBytes: sizeBytes,
            format: String(r.format || 'UNKNOWN').toUpperCase(),
            samples: r.samples || (sampleCount ? sampleCount.toLocaleString('en-US') : '—'),
            sampleCount: sampleCount,
            tags: tags.join(', '),
            tagList: tags,
            dataType: dataType,
            annoType: annoType,
            annoStatus: r.annoStatus || (annoType === 'none' ? 'unlabeled' : 'labeled'),
            description: String(r.description || ''),
            version: version,
            versions: versions,
            isPublic: r.isPublic !== false,
            projectKey: r.projectKey || '',
            citation: r.citation || '',
            uploader: r.uploader || '未知',
            uploadTime: r.uploadTime || '',
            downloadCount: Number(r.downloadCount) || 0,
            md5: r.md5 || '',
            fieldCount: Number(r.fieldCount) || 0,
            encoding: r.encoding || '',
            preview: r.preview || null,
            imageCount: Number(r.imageCount) || 0,
            labelCount: Number(r.labelCount) || 0,
            classCount: Number(r.classCount) || 0,
            classes: Array.isArray(r.classes) ? r.classes : [],
            sampleImages: Array.isArray(r.sampleImages) ? r.sampleImages : [],
            labelPreview: r.labelPreview || '',
            serverFileId: r.serverFileId || '',
            hasLocalBlob: !!r.hasLocalBlob,
            groupIds: Array.isArray(r.groupIds) ? r.groupIds : []
        });
    }

    function guessDataType(format, name) {
        var f = String(format || '').toLowerCase() + ' ' + String(name || '').toLowerCase();
        if (/\b(jpg|jpeg|png|bmp|webp|coco|yolo|voc|zip)\b/.test(f) && /image|图|检测|分割/.test(f + name)) return 'image';
        if (/\b(jpg|jpeg|png|bmp|webp)\b/.test(f)) return 'image';
        if (/\b(csv|xlsx|xls|json|xml|parquet|tsv)\b/.test(f)) return 'table';
        if (/\b(txt|md|doc|docx)\b/.test(f)) return 'text';
        if (/\bzip\b/.test(f)) return 'image';
        return 'table';
    }

    function loadFavorites() {
        try { dsState.favorites = JSON.parse(localStorage.getItem(DS_FAV_KEY) || '{}') || {}; }
        catch (e) { dsState.favorites = {}; }
    }

    function saveFavorites() {
        localStorage.setItem(DS_FAV_KEY, JSON.stringify(dsState.favorites || {}));
    }

    function loadGroups() {
        try {
            var g = JSON.parse(localStorage.getItem(DS_GROUP_KEY) || '[]');
            return Array.isArray(g) ? g : [];
        } catch (e) { return []; }
    }

    function saveGroups(groups) {
        localStorage.setItem(DS_GROUP_KEY, JSON.stringify(groups || []));
    }

    function loadCustomTags() {
        try {
            var arr = JSON.parse(localStorage.getItem(DS_CUSTOM_TAGS_KEY) || '[]');
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
        localStorage.setItem(DS_CUSTOM_TAGS_KEY, JSON.stringify(clean));
    }

    function getAllDsTags() {
        var map = {};
        var order = [];
        function add(t) {
            t = String(t || '').trim();
            if (!t || map[t]) return;
            map[t] = true;
            order.push(t);
        }
        DS_TAG_PRESETS.forEach(add);
        loadCustomTags().forEach(add);
        getDatasetData().forEach(function (d) {
            (d.tagList || parseTags(d.tags)).forEach(add);
        });
        return order;
    }

    function addCustomDsTag(name) {
        name = String(name || '').trim();
        if (!name) { alert('请输入标签名称'); return ''; }
        if (name.length > 30) { alert('标签名不超过 30 字'); return ''; }
        if (getAllDsTags().indexOf(name) >= 0) return name;
        var custom = loadCustomTags();
        custom.push(name);
        saveCustomTags(custom);
        return name;
    }

    function seedIfEmpty() {
        var data = getDatasetData();
        if (data.length) {
            global.datasetData = data.map(normalizeDatasetRecord).filter(Boolean);
            saveDatasetData();
            return;
        }
        global.datasetData = [
            normalizeDatasetRecord({
                id: 1, name: '城市安全监测数据集V2', size: '2.5 GB', format: 'CSV/JSON', samples: '1,200,000',
                tags: '监测数据,城市安全,目标检测', uploader: '柳煦', uploadTime: '2026-07-12',
                dataType: 'table', annoType: 'detection', annoStatus: 'labeled', downloadCount: 36,
                description: '城市安全多源监测时序与事件标注样本，适用于检测与预警模型训练。'
            }),
            normalizeDatasetRecord({
                id: 2, name: '灾害事件标注数据集', size: '800 MB', format: 'JPG/XML', samples: '50,000',
                tags: '灾害识别,目标检测', uploader: '李四', uploadTime: '2026-07-11',
                dataType: 'image', annoType: 'detection', annoStatus: 'labeled', downloadCount: 18,
                description: '灾害场景图像与 VOC/XML 标注，覆盖坍塌、积水、烟火等类别。'
            }),
            normalizeDatasetRecord({
                id: 3, name: '交通流量预测数据集', size: '1.2 GB', format: 'CSV', samples: '2,000,000',
                tags: '交通预测', uploader: '赵六', uploadTime: '2026-07-09',
                dataType: 'table', annoType: 'none', annoStatus: 'unlabeled', downloadCount: 12,
                description: '路口传感器流量与天气特征，用于时序预测与异常检测。'
            })
        ];
        saveDatasetData();
    }

    // ---------- IndexedDB ----------
    function openDsDB() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(DS_BLOB_DB, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(DS_BLOB_STORE)) db.createObjectStore(DS_BLOB_STORE);
                if (!db.objectStoreNames.contains(DS_CHUNK_STORE)) db.createObjectStore(DS_CHUNK_STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbPut(store, key, value) {
        return openDsDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(value, String(key));
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function idbGet(store, key) {
        return openDsDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(store, 'readonly');
                var req = tx.objectStore(store).get(String(key));
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function idbDel(store, key) {
        return openDsDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).delete(String(key));
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    // ---------- 轻量指纹 / 解析 ----------
    function simpleFileFingerprint(file) {
        return String(file.name) + '|' + file.size + '|' + (file.lastModified || 0);
    }

    function hashString(str) {
        var h = 2166136261;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ('00000000' + (h >>> 0).toString(16)).slice(-8);
    }

    function getDatasetAuthHeaders(extra) {
        var headers = Object.assign({}, extra || {});
        var cfg = global.APP_CONFIG || {};
        var token = cfg.DATASET_UPLOAD_TOKEN || cfg.ANNOTATION_UPLOAD_TOKEN || '';
        if (token) headers['X-Upload-Token'] = token;
        return headers;
    }

    async function probeDatasetServer() {
        if (dsServerCaps) return dsServerCaps;
        try {
            var resp = await fetch('/api/dataset/health', { method: 'GET' });
            if (!resp.ok) throw new Error('no server');
            dsServerCaps = await resp.json();
            if (dsServerCaps && dsServerCaps.chunkSize) DS_CHUNK_SIZE = Number(dsServerCaps.chunkSize) || DS_CHUNK_SIZE;
        } catch (e) {
            dsServerCaps = { ok: false };
        }
        return dsServerCaps;
    }

    async function computeFileMd5(file) {
        // 大文件只抽检头尾+大小，避免卡死；小文件尽量算完整 MD5
        try {
            if (file.size <= 8 * 1024 * 1024 && global.crypto && crypto.subtle) {
                var buf = await file.arrayBuffer();
                var digest = await crypto.subtle.digest('SHA-256', buf);
                var arr = Array.from(new Uint8Array(digest));
                return arr.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').slice(0, 32);
            }
        } catch (e) { /* fallthrough */ }
        return hashString(simpleFileFingerprint(file) + '|' + file.size);
    }

    function loadDownloadLogs() {
        try {
            var obj = JSON.parse(localStorage.getItem(DS_DL_LOG_KEY) || '{}');
            return obj && typeof obj === 'object' ? obj : {};
        } catch (e) { return {}; }
    }

    function pushDownloadLog(datasetId, entry) {
        var logs = loadDownloadLogs();
        var key = String(datasetId);
        if (!Array.isArray(logs[key])) logs[key] = [];
        logs[key].unshift(entry);
        logs[key] = logs[key].slice(0, 100);
        localStorage.setItem(DS_DL_LOG_KEY, JSON.stringify(logs));
    }

    function collectAchievementLinks(datasetName) {
        var name = String(datasetName || '').toLowerCase();
        var papers = [];
        var patents = [];
        try {
            var pd = Array.isArray(global.paperData) ? global.paperData : [];
            papers = pd.filter(function (p) {
                var blob = [p.title, p.remark, p.dataset, p.keywords].join(' ').toLowerCase();
                return name && blob.indexOf(name) >= 0;
            }).slice(0, 10);
        } catch (e) { papers = []; }
        try {
            var pt = Array.isArray(global.patentData) ? global.patentData : JSON.parse(localStorage.getItem('patentData') || '[]');
            patents = (pt || []).filter(function (p) {
                var blob = [p.name, p.title, p.description, p.abstract, p.remark].join(' ').toLowerCase();
                return name && blob.indexOf(name) >= 0;
            }).slice(0, 10);
        } catch (e2) { patents = []; }
        return { papers: papers, patents: patents };
    }

    function ensureJSZip() {
        return new Promise(function (resolve, reject) {
            if (global.JSZip) return resolve(global.JSZip);
            function finish() {
                if (global.JSZip) resolve(global.JSZip);
                else reject(new Error('JSZip 加载失败'));
            }
            if (typeof global.ensureVendor === 'function') {
                global.ensureVendor('jszip').then(finish).catch(function () {
                    var s = document.createElement('script');
                    s.src = 'vendor/jszip/jszip.min.js';
                    s.onload = finish;
                    s.onerror = function () { reject(new Error('JSZip 加载失败')); };
                    document.head.appendChild(s);
                });
                return;
            }
            var s = document.createElement('script');
            s.src = 'vendor/jszip/jszip.min.js';
            s.onload = finish;
            s.onerror = function () { reject(new Error('JSZip 加载失败')); };
            document.head.appendChild(s);
        });
    }

    function readDirectoryEntries(reader) {
        return new Promise(function (resolve, reject) {
            var all = [];
            (function readBatch() {
                reader.readEntries(function (entries) {
                    if (!entries.length) return resolve(all);
                    all = all.concat(entries);
                    readBatch();
                }, reject);
            })();
        });
    }

    function entryToFile(fileEntry) {
        return new Promise(function (resolve, reject) {
            fileEntry.file(resolve, reject);
        });
    }

    async function collectFilesFromDirectoryEntry(dirEntry, basePath, out) {
        var reader = dirEntry.createReader();
        var entries = await readDirectoryEntries(reader);
        for (var i = 0; i < entries.length; i++) {
            var ent = entries[i];
            var next = (basePath ? basePath + '/' : '') + ent.name;
            if (ent.isDirectory) {
                await collectFilesFromDirectoryEntry(ent, next, out);
            } else if (ent.isFile) {
                var file = await entryToFile(ent);
                out.push({ path: next, file: file });
            }
        }
    }

    function collectFilesFromFileList(fileList) {
        var out = [];
        for (var i = 0; i < fileList.length; i++) {
            var f = fileList[i];
            var rel = f.webkitRelativePath || f.name;
            if (!rel || /(?:^|\/)\./.test(rel)) continue; // skip hidden
            out.push({ path: rel.replace(/\\/g, '/'), file: f });
        }
        return out;
    }

    async function packFolderEntriesToZip(entries, folderName, onProgress) {
        if (!entries.length) throw new Error('文件夹为空，没有可上传的文件');
        var totalBytes = entries.reduce(function (s, e) { return s + (e.file.size || 0); }, 0);
        if (totalBytes <= 0) throw new Error('文件夹内文件总大小为 0，无法上传');
        if (totalBytes > 10 * 1024 * 1024 * 1024) throw new Error('文件夹过大（超过 10GB），请先打包压缩后再上传');
        if (totalBytes > 800 * 1024 * 1024) {
            var ok = confirm('文件夹约 ' + formatBytes(totalBytes) + '，将在浏览器内打包为 ZIP，可能较慢且占用内存。是否继续？');
            if (!ok) throw new Error('已取消文件夹打包');
        }
        var JSZip = await ensureJSZip();
        var zip = new JSZip();
        var root = String(folderName || 'dataset').replace(/[\\/:*?"<>|]/g, '_');
        var done = 0;
        for (var i = 0; i < entries.length; i++) {
            var item = entries[i];
            var rel = String(item.path || item.file.name).replace(/\\/g, '/');
            // webkitRelativePath 已含根目录名；拖拽目录则用 basePath
            if (rel.indexOf('/') < 0) rel = root + '/' + rel;
            zip.file(rel, item.file);
            done += item.file.size || 0;
            if (onProgress) onProgress(done, totalBytes, i + 1, entries.length);
        }
        if (onProgress) onProgress(totalBytes, totalBytes, entries.length, entries.length);
        var blob = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
            function (meta) {
                if (onProgress && meta && meta.percent != null) {
                    onProgress(totalBytes, totalBytes, entries.length, entries.length, meta.percent);
                }
            }
        );
        var zipName = root + '.zip';
        return new File([blob], zipName, { type: 'application/zip', lastModified: Date.now() });
    }

    async function packDroppedDirectory(dirEntry, onProgress) {
        var entries = [];
        await collectFilesFromDirectoryEntry(dirEntry, dirEntry.name, entries);
        return packFolderEntriesToZip(entries, dirEntry.name, onProgress);
    }

    async function parseZipDatasetClient(file) {
        var result = {
            imageCount: 0, labelCount: 0, classCount: 0, classes: [],
            sampleImages: [], sampleImageDataUrls: [], labelPreview: '',
            sampleCount: 0, annoTypeHint: 'detection', note: ''
        };
        try {
            var JSZip = await ensureJSZip();
            var zip = await JSZip.loadAsync(await file.arrayBuffer());
            var imgExt = /\.(jpg|jpeg|png|bmp|webp|gif)$/i;
            var labelExt = /\.(xml|json|txt|yaml|yml)$/i;
            var images = [];
            var labels = [];
            var classes = {};
            zip.forEach(function (relPath, entry) {
                if (entry.dir) return;
                if (imgExt.test(relPath)) images.push(relPath);
                else if (labelExt.test(relPath)) labels.push(relPath);
                var parts = relPath.replace(/\\/g, '/').split('/');
                if (parts.length >= 2 && imgExt.test(relPath)) classes[parts[parts.length - 2]] = true;
            });
            result.imageCount = images.length;
            result.labelCount = labels.length;
            result.sampleCount = images.length || Object.keys(zip.files).length;
            result.sampleImages = images.slice(0, 20);
            result.classes = Object.keys(classes).slice(0, 50);
            result.classCount = result.classes.length;
            result.annoTypeHint = labels.length ? 'detection' : 'none';
            // 抽取最多 12 张样例图（限制单张 1.5MB）
            var picked = images.slice(0, 12);
            for (var i = 0; i < picked.length; i++) {
                try {
                    var entry = zip.file(picked[i]);
                    if (!entry) continue;
                    var blob = await entry.async('blob');
                    if (blob.size > 1.5 * 1024 * 1024) continue;
                    result.sampleImageDataUrls.push({
                        path: picked[i],
                        url: URL.createObjectURL(blob)
                    });
                } catch (e) { /* skip */ }
            }
            // 标注样例
            if (labels[0]) {
                try {
                    var lf = zip.file(labels[0]);
                    if (lf) result.labelPreview = String(await lf.async('string')).slice(0, 1200);
                } catch (e2) { /* ignore */ }
            }
            result.note = 'ZIP 客户端已统计图像 ' + result.imageCount + ' / 标注 ' + result.labelCount +
                (result.classCount ? (' / 类别 ' + result.classCount) : '');
        } catch (e) {
            result.note = 'ZIP 解析降级：' + (e && e.message ? e.message : e);
        }
        return result;
    }

    function countCsvLines(text) {
        var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
        return Math.max(0, lines.length - 1);
    }

    function parseCsvPreview(text, maxRows) {
        var lines = text.split(/\r?\n/).filter(function (l) { return l.length; });
        if (!lines.length) return { columns: [], rows: [], fieldCount: 0, sampleCount: 0 };
        var sep = lines[0].indexOf('\t') >= 0 ? '\t' : ',';
        var columns = lines[0].split(sep).map(function (c) { return c.replace(/^"|"$/g, '').trim(); });
        var rows = [];
        for (var i = 1; i < lines.length && rows.length < (maxRows || 100); i++) {
            rows.push(lines[i].split(sep).map(function (c) { return c.replace(/^"|"$/g, ''); }));
        }
        return { columns: columns, rows: rows, fieldCount: columns.length, sampleCount: Math.max(0, lines.length - 1) };
    }

    function parseJsonPreview(text) {
        try {
            var data = JSON.parse(text);
            if (Array.isArray(data)) {
                var cols = data[0] && typeof data[0] === 'object' ? Object.keys(data[0]) : ['value'];
                var rows = data.slice(0, 100).map(function (row) {
                    if (row && typeof row === 'object') return cols.map(function (c) { return row[c]; });
                    return [row];
                });
                return { columns: cols, rows: rows, fieldCount: cols.length, sampleCount: data.length };
            }
            if (data && Array.isArray(data.data)) return parseJsonPreview(JSON.stringify(data.data));
            if (data && Array.isArray(data.images)) {
                return { columns: ['images'], rows: data.images.slice(0, 20).map(function (x) { return [typeof x === 'string' ? x : JSON.stringify(x)]; }), fieldCount: 1, sampleCount: data.images.length };
            }
            return { columns: ['json'], rows: [[JSON.stringify(data).slice(0, 200)]], fieldCount: 1, sampleCount: 1 };
        } catch (e) {
            return null;
        }
    }

    function detectEncodingHint(buf) {
        if (!buf || buf.byteLength < 3) return 'UTF-8';
        var u8 = new Uint8Array(buf);
        if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return 'UTF-8 BOM';
        return 'UTF-8';
    }

    function readFileHead(file, maxBytes) {
        return new Promise(function (resolve, reject) {
            var blob = file.slice(0, maxBytes || 2 * 1024 * 1024);
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(reader.error); };
            reader.readAsArrayBuffer(blob);
        });
    }

    function arrayBufferToText(buf) {
        try {
            return new TextDecoder('utf-8', { fatal: false }).decode(buf);
        } catch (e) {
            return String.fromCharCode.apply(null, new Uint8Array(buf));
        }
    }

    async function autoParseDatasetFile(file) {
        var ext = datasetFileExtension(file.name);
        var result = {
            format: ext.toUpperCase() || 'UNKNOWN',
            size: formatBytes(file.size),
            sizeBytes: file.size,
            samples: '—',
            sampleCount: 0,
            fieldCount: 0,
            encoding: '',
            dataType: guessDataType(ext, file.name),
            preview: null,
            nameHint: file.name.replace(/\.[^.]+$/, ''),
            md5: hashString(simpleFileFingerprint(file)),
            parseOk: true,
            parseNote: ''
        };

        try {
            result.md5 = await computeFileMd5(file);
            if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
                var buf = await readFileHead(file, 1500000);
                result.encoding = detectEncodingHint(buf);
                var text = arrayBufferToText(buf);
                var preview = parseCsvPreview(text, 100);
                result.preview = preview;
                result.fieldCount = preview.fieldCount;
                if (file.size > 1500000) {
                    var ratio = file.size / buf.byteLength;
                    result.sampleCount = Math.max(preview.sampleCount, Math.round(countCsvLines(text) * ratio));
                    result.parseNote = '大文件按采样估算记录数';
                } else {
                    result.sampleCount = preview.sampleCount;
                }
                result.samples = result.sampleCount.toLocaleString('en-US');
                result.dataType = 'table';
            } else if (ext === 'json') {
                var jbuf = await readFileHead(file, 2000000);
                result.encoding = detectEncodingHint(jbuf);
                var jtext = arrayBufferToText(jbuf);
                var jp = parseJsonPreview(jtext);
                if (jp) {
                    result.preview = jp;
                    result.fieldCount = jp.fieldCount;
                    result.sampleCount = jp.sampleCount;
                    result.samples = jp.sampleCount.toLocaleString('en-US');
                    result.dataType = 'table';
                } else {
                    result.parseOk = false;
                    result.parseNote = 'JSON 解析失败，请手动填写';
                }
            } else if (ext === 'xml') {
                var xbuf = await readFileHead(file, 800000);
                var xt = arrayBufferToText(xbuf);
                var objMatch = xt.match(/<object[\s>]/gi);
                var annMatch = xt.match(/<annotation[\s>]/gi);
                result.sampleCount = (objMatch && objMatch.length) || (annMatch && annMatch.length) || 0;
                result.samples = result.sampleCount ? result.sampleCount.toLocaleString('en-US') : '需解压统计';
                result.dataType = 'image';
                result.annoTypeHint = 'detection';
                result.parseNote = '检测到 XML 标注结构';
            } else if (ext === 'zip') {
                result.dataType = 'image';
                var zipMeta = await parseZipDatasetClient(file);
                result.sampleCount = zipMeta.sampleCount || 0;
                result.samples = result.sampleCount ? result.sampleCount.toLocaleString('en-US') : 'ZIP 包';
                result.imageCount = zipMeta.imageCount;
                result.labelCount = zipMeta.labelCount;
                result.classCount = zipMeta.classCount;
                result.classes = zipMeta.classes;
                result.sampleImages = zipMeta.sampleImages;
                result.sampleImageDataUrls = zipMeta.sampleImageDataUrls;
                result.labelPreview = zipMeta.labelPreview;
                result.zipStats = zipMeta;
                if (zipMeta.annoTypeHint) result.annoTypeHint = zipMeta.annoTypeHint;
                result.parseNote = zipMeta.note || 'ZIP 已解析';
                result.preview = {
                    type: 'image',
                    images: zipMeta.sampleImageDataUrls || [],
                    labelPreview: zipMeta.labelPreview || '',
                    stats: {
                        imageCount: zipMeta.imageCount,
                        labelCount: zipMeta.labelCount,
                        classCount: zipMeta.classCount,
                        classes: zipMeta.classes
                    }
                };
            } else if (/^(jpg|jpeg|png|bmp|webp)$/.test(ext)) {
                result.dataType = 'image';
                result.sampleCount = 1;
                result.samples = '1';
            } else {
                result.parseNote = '通用文件：已识别格式与大小';
            }
        } catch (e) {
            result.parseOk = false;
            result.parseNote = '自动解析失败，请手动填写信息';
        }
        return result;
    }

    // ---------- 筛选 / 统计 ----------
    function getFilteredDatasets() {
        var q = String((document.getElementById('datasetSearchInput') || {}).value || '').trim().toLowerCase();
        var list = getDatasetData().slice().map(normalizeDatasetRecord);
        var now = new Date();
        var monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

        if (dsState.statFilter === 'month') {
            list = list.filter(function (d) {
                var t = Date.parse(String(d.uploadTime).replace(/\./g, '-'));
                return t && t >= monthAgo.getTime();
            });
        } else if (dsState.statFilter === 'labeled') {
            list = list.filter(function (d) { return annoStatusOf(d) === 'labeled' || annoStatusOf(d) === 'partial'; });
        } else if (dsState.statFilter === 'storage') {
            dsState.sort = 'size_desc';
            var sortEl = document.getElementById('dsSort');
            if (sortEl) sortEl.value = 'size_desc';
        }

        if (dsState.dataType) list = list.filter(function (d) { return d.dataType === dsState.dataType; });
        if (dsState.annoType) list = list.filter(function (d) { return d.annoType === dsState.annoType; });
        if (dsState.tagFilter) {
            list = list.filter(function (d) {
                return (d.tagList || []).indexOf(dsState.tagFilter) >= 0;
            });
        }
        if (dsState.groupId) {
            list = list.filter(function (d) {
                return (d.groupIds || []).indexOf(dsState.groupId) >= 0;
            });
        }
        if (dsState.dateFrom) {
            list = list.filter(function (d) {
                return String(d.uploadTime || '') >= dsState.dateFrom;
            });
        }
        if (dsState.dateTo) {
            list = list.filter(function (d) {
                return String(d.uploadTime || '') <= dsState.dateTo;
            });
        }
        if (dsState.uploader) {
            var up = dsState.uploader.toLowerCase();
            list = list.filter(function (d) { return String(d.uploader || '').toLowerCase().indexOf(up) >= 0; });
        }
        if (dsState.format) {
            var fmt = dsState.format.toLowerCase();
            list = list.filter(function (d) { return String(d.format || '').toLowerCase().indexOf(fmt) >= 0; });
        }
        if (dsState.isPublic === '1') list = list.filter(function (d) { return d.isPublic !== false; });
        if (dsState.isPublic === '0') list = list.filter(function (d) { return d.isPublic === false; });

        if (q) {
            list = list.filter(function (d) {
                var blob = [d.name, d.tags, d.description, d.uploader, d.format].join(' ').toLowerCase();
                return blob.indexOf(q) >= 0;
            });
        }

        var sort = dsState.sort || 'time_desc';
        list.sort(function (a, b) {
            if (sort === 'size_desc') return (b.sizeBytes || 0) - (a.sizeBytes || 0);
            if (sort === 'size_asc') return (a.sizeBytes || 0) - (b.sizeBytes || 0);
            if (sort === 'dl_desc') return (b.downloadCount || 0) - (a.downloadCount || 0);
            if (sort === 'samples_desc') return (b.sampleCount || 0) - (a.sampleCount || 0);
            if (sort === 'time_asc') return String(a.uploadTime).localeCompare(String(b.uploadTime));
            return String(b.uploadTime).localeCompare(String(a.uploadTime));
        });
        return list;
    }

    function updateDatasetStats() {
        var all = getDatasetData().map(normalizeDatasetRecord);
        var totalBytes = all.reduce(function (s, d) { return s + (d.sizeBytes || 0); }, 0);
        var now = new Date();
        var monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
        var monthN = all.filter(function (d) {
            var t = Date.parse(String(d.uploadTime).replace(/\./g, '-'));
            return t && t >= monthAgo.getTime();
        }).length;
        var labeledN = all.filter(function (d) {
            var s = annoStatusOf(d);
            return s === 'labeled' || s === 'partial';
        }).length;

        var el = function (id, v) { var n = document.getElementById(id); if (n) n.textContent = v; };
        el('dsStatTotal', String(all.length));
        el('dsStatStorage', formatBytes(totalBytes));
        el('dsStatMonth', String(monthN));
        el('dsStatLabeled', String(labeledN));

        document.querySelectorAll('.ds-stat-card').forEach(function (card) {
            var f = card.getAttribute('data-filter') || '';
            card.classList.toggle('active', f === (dsState.statFilter || ''));
        });
    }

    function renderDsTagBar() {
        var box = document.getElementById('dsTagFilterBar');
        if (!box) return;
        var tags = getAllDsTags().slice(0, 20);
        var html = '<button type="button" class="ds-tag-chip' + (!dsState.tagFilter ? ' active' : '') + '" onclick="setDsTagFilter(\'\')">全部</button>';
        html += tags.map(function (t) {
            return '<button type="button" class="ds-tag-chip' + (dsState.tagFilter === t ? ' active' : '') + '" onclick="setDsTagFilter(' + JSON.stringify(t) + ')">' + esc(t) + '</button>';
        }).join('');
        html += '<button type="button" class="ds-tag-chip ds-tag-add" onclick="toggleDsTagAddPanel()">+ 添加</button>';
        html += '<span id="dsTagAddPanel" class="ds-tag-add-panel" style="display:' + (dsState.tagAddOpen ? 'inline-flex' : 'none') + ';">' +
            '<input id="dsTagAddInput" type="text" placeholder="新标签" onkeydown="if(event.key===\'Enter\'){event.preventDefault();confirmAddDsTag();}">' +
            '<button type="button" class="ds-tag-add-ok" onclick="confirmAddDsTag()">确定</button>' +
            '<button type="button" class="ds-tag-add-cancel" onclick="toggleDsTagAddPanel(false)">×</button></span>';
        box.innerHTML = html;
    }

    function renderDsGroups() {
        var box = document.getElementById('dsGroupList');
        if (!box) return;
        var groups = loadGroups();
        box.innerHTML = groups.map(function (g) {
            return '<button type="button" class="ds-group-item' + (dsState.groupId === g.id ? ' active' : '') + '" onclick="setDatasetGroup(' + JSON.stringify(g.id) + ')">' +
                esc(g.name) +
                '<span class="ds-group-del" onclick="event.stopPropagation();deleteDatasetGroup(' + JSON.stringify(g.id) + ')" title="删除分组">×</span></button>';
        }).join('');
        document.querySelectorAll('.ds-group-item[data-group]').forEach(function (btn) {
            btn.classList.toggle('active', !dsState.groupId);
        });
    }

    function updateDsBatchBar() {
        var bar = document.getElementById('dsBatchBar');
        var countEl = document.getElementById('dsBatchCount');
        var n = Object.keys(dsState.selected).filter(function (k) { return dsState.selected[k]; }).length;
        if (bar) bar.style.display = n ? 'flex' : 'none';
        if (countEl) countEl.textContent = String(n);
    }

    function updateSearchSuggest() {
        var dl = document.getElementById('datasetSearchSuggest');
        if (!dl) return;
        var names = getDatasetData().map(function (d) { return d.name; }).filter(Boolean).slice(0, 30);
        dl.innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('');
    }

    function renderDatasetList() {
        var container = document.getElementById('datasetList');
        var emptyState = document.getElementById('datasetEmptyState');
        if (!container || !emptyState) return;

        injectStyles();
        updateDatasetStats();
        renderDsTagBar();
        renderDsGroups();
        updateSearchSuggest();

        var filtered = getFilteredDatasets();
        var totalPages = Math.max(1, Math.ceil(filtered.length / DS_PAGE_SIZE));
        if (dsState.page > totalPages) dsState.page = totalPages;
        var start = (dsState.page - 1) * DS_PAGE_SIZE;
        var pageItems = filtered.slice(start, start + DS_PAGE_SIZE);

        if (!filtered.length) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            updateDsBatchBar();
            renderPagination(0, 1);
            return;
        }
        emptyState.style.display = 'none';

        if (dsState.view === 'card') {
            container.className = 'ds-card-grid';
            container.innerHTML = pageItems.map(renderDatasetCardView).join('');
        } else {
            container.className = '';
            container.innerHTML = pageItems.map(renderDatasetListItem).join('');
        }
        renderPagination(filtered.length, totalPages);
        updateDsBatchBar();
    }

    function renderPagination(total, totalPages) {
        var box = document.getElementById('datasetPagination');
        if (!box) return;
        if (totalPages <= 1) { box.innerHTML = ''; return; }
        var html = '<span style="font-size:12px;color:#888;">共 ' + total + ' 条</span>';
        for (var i = 1; i <= totalPages; i++) {
            html += '<button type="button" class="ds-page-btn' + (i === dsState.page ? ' active' : '') + '" onclick="setDatasetPage(' + i + ')">' + i + '</button>';
        }
        box.innerHTML = html;
    }

    function statusBadge(item) {
        var s = annoStatusOf(item);
        var cls = s === 'labeled' ? 'ok' : (s === 'partial' ? 'mid' : 'off');
        return '<span class="ds-anno-badge ' + cls + '">' + annoStatusLabel(s) + '</span>';
    }

    function renderDatasetListItem(d) {
        var fav = !!dsState.favorites[String(d.id)];
        var checked = !!dsState.selected[String(d.id)];
        var tags = (d.tagList || []).map(function (t) {
            return '<span class="ds-mini-tag">' + esc(t) + '</span>';
        }).join('');
        return (
            '<div class="ds-card' + (checked ? ' selected' : '') + '" title="' + esc(d.description || d.name) + '">' +
            '<div class="ds-card-main">' +
            '<label class="ds-check"><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleDsSelect(' + d.id + ', this.checked)"></label>' +
            '<button type="button" class="ds-fav-btn' + (fav ? ' on' : '') + '" onclick="toggleDatasetFavorite(' + d.id + ')">' + (fav ? '★' : '☆') + '</button>' +
            '<div class="ds-icon">' + iconOfDataType(d.dataType) + '</div>' +
            '<div class="ds-body">' +
            '<div class="ds-title-row">' +
            '<a href="javascript:void(0)" class="ds-title" onclick="showDatasetDetail(' + d.id + ')">' + esc(d.name) + '</a>' +
            statusBadge(d) +
            '<span class="ds-ver">v' + esc(String(d.version || '1.0').replace(/^V/i, '')) + '</span>' +
            '</div>' +
            '<div class="ds-meta">' + esc(d.size) + ' · ' + esc(d.format) + ' · ' + esc(d.samples) + ' 条记录 · ' + esc(labelOf(DATA_TYPE_OPTS, d.dataType)) + '</div>' +
            '<div class="ds-tags">' + tags + '</div>' +
            '<div class="ds-foot">上传者：' + esc(d.uploader) + ' | ' + esc(d.uploadTime) + ' | 下载 ' + (d.downloadCount || 0) + ' 次</div>' +
            '</div></div>' +
            '<div class="ds-actions">' +
            '<button type="button" class="btn btn-secondary ds-act" onclick="showDatasetDetail(' + d.id + ')">详情</button>' +
            '<button type="button" class="btn ds-act" onclick="downloadDataset(' + d.id + ')">下载</button>' +
            '<button type="button" class="btn btn-secondary ds-act" onclick="useDatasetForTraining(' + d.id + ')">用于训练</button>' +
            '<button type="button" class="btn btn-secondary ds-act" onclick="showDatasetMoreMenu(' + d.id + ', event)">更多</button>' +
            '</div></div>'
        );
    }

    function renderDatasetCardView(d) {
        var fav = !!dsState.favorites[String(d.id)];
        var checked = !!dsState.selected[String(d.id)];
        return (
            '<div class="ds-grid-card' + (checked ? ' selected' : '') + '">' +
            '<div class="ds-thumb">' + iconOfDataType(d.dataType) + '</div>' +
            '<label class="ds-check ds-check-abs"><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleDsSelect(' + d.id + ', this.checked)"></label>' +
            '<button type="button" class="ds-fav-btn ds-fav-abs' + (fav ? ' on' : '') + '" onclick="toggleDatasetFavorite(' + d.id + ')">' + (fav ? '★' : '☆') + '</button>' +
            '<div class="ds-grid-body">' +
            '<div class="ds-title" onclick="showDatasetDetail(' + d.id + ')" style="cursor:pointer;">' + esc(d.name) + '</div>' +
            '<div class="ds-meta">' + esc(d.size) + ' · ' + esc(d.format) + '</div>' +
            statusBadge(d) +
            '<div class="ds-actions" style="margin-top:10px;">' +
            '<button type="button" class="btn btn-secondary ds-act" onclick="showDatasetDetail(' + d.id + ')">详情</button>' +
            '<button type="button" class="btn ds-act" onclick="useDatasetForTraining(' + d.id + ')">训练</button>' +
            '</div></div></div>'
        );
    }

    // ---------- 交互 ----------
    function setDsStatFilter(v) {
        dsState.statFilter = v || '';
        dsState.page = 1;
        renderDatasetList();
    }

    function setDsTagFilter(tag) {
        dsState.tagFilter = (dsState.tagFilter === tag) ? '' : (tag || '');
        dsState.page = 1;
        renderDatasetList();
    }

    function onDatasetFilterChange() {
        dsState.dataType = (document.getElementById('dsDataTypeFilter') || {}).value || '';
        dsState.annoType = (document.getElementById('dsAnnoTypeFilter') || {}).value || '';
        dsState.sort = (document.getElementById('dsSort') || {}).value || 'time_desc';
        dsState.dateFrom = (document.getElementById('dsDateFrom') || {}).value || '';
        dsState.dateTo = (document.getElementById('dsDateTo') || {}).value || '';
        dsState.uploader = (document.getElementById('dsUploaderFilter') || {}).value || '';
        dsState.format = (document.getElementById('dsFormatFilter') || {}).value || '';
        dsState.isPublic = (document.getElementById('dsPublicFilter') || {}).value || '';
        dsState.page = 1;
        renderDatasetList();
    }

    function onDatasetSearchInput() {
        dsState.page = 1;
        renderDatasetList();
    }

    function toggleDsAdvancedFilter() {
        var box = document.getElementById('dsAdvancedFilter');
        if (!box) return;
        box.style.display = box.style.display === 'none' ? 'flex' : 'none';
    }

    function setDatasetView(view) {
        dsState.view = view === 'card' ? 'card' : 'list';
        document.querySelectorAll('.ds-view-btn').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-view') === dsState.view);
        });
        renderDatasetList();
    }

    function setDatasetPage(p) {
        dsState.page = p;
        renderDatasetList();
    }

    function setDatasetGroup(id) {
        dsState.groupId = id || '';
        dsState.page = 1;
        renderDatasetList();
    }

    function createDatasetGroup() {
        var name = prompt('新建分组名称：');
        if (!name || !String(name).trim()) return;
        var groups = loadGroups();
        var id = 'g_' + Date.now();
        groups.push({ id: id, name: String(name).trim() });
        saveGroups(groups);
        renderDsGroups();
    }

    function deleteDatasetGroup(id) {
        if (!confirm('删除该分组？（不会删除数据集）')) return;
        saveGroups(loadGroups().filter(function (g) { return g.id !== id; }));
        getDatasetData().forEach(function (d) {
            if (d.groupIds) d.groupIds = d.groupIds.filter(function (x) { return x !== id; });
        });
        saveDatasetData();
        if (dsState.groupId === id) dsState.groupId = '';
        renderDatasetList();
    }

    function toggleDsSelect(id, checked) {
        if (checked) dsState.selected[String(id)] = true;
        else delete dsState.selected[String(id)];
        updateDsBatchBar();
    }

    function toggleDatasetFavorite(id) {
        var k = String(id);
        if (dsState.favorites[k]) delete dsState.favorites[k];
        else dsState.favorites[k] = true;
        saveFavorites();
        renderDatasetList();
    }

    function toggleDsTagAddPanel(force) {
        dsState.tagAddOpen = typeof force === 'boolean' ? force : !dsState.tagAddOpen;
        renderDsTagBar();
        if (dsState.tagAddOpen) {
            var inp = document.getElementById('dsTagAddInput');
            if (inp) inp.focus();
        }
    }

    function confirmAddDsTag() {
        var input = document.getElementById('dsTagAddInput');
        var tag = addCustomDsTag(input ? input.value : '');
        if (!tag) return;
        dsState.tagAddOpen = false;
        dsState.tagFilter = tag;
        renderDatasetList();
    }

    function getSelectedIds() {
        return Object.keys(dsState.selected).filter(function (k) { return dsState.selected[k]; }).map(Number);
    }

    function batchDeleteDatasets() {
        var ids = getSelectedIds();
        if (!ids.length) return;
        if (!confirm('确定删除选中的 ' + ids.length + ' 个数据集？')) return;
        global.datasetData = getDatasetData().filter(function (d) { return ids.indexOf(Number(d.id)) < 0; });
        ids.forEach(function (id) {
            idbDel(DS_BLOB_STORE, id).catch(function () {});
            delete dsState.selected[String(id)];
        });
        saveDatasetData();
        renderDatasetList();
    }

    function batchTagDatasets() {
        var ids = getSelectedIds();
        if (!ids.length) return;
        var tag = prompt('为选中数据集追加标签：');
        if (!tag) return;
        tag = addCustomDsTag(tag) || String(tag).trim();
        getDatasetData().forEach(function (d) {
            if (ids.indexOf(Number(d.id)) < 0) return;
            var tags = parseTags(d.tags);
            if (tags.indexOf(tag) < 0) tags.push(tag);
            d.tags = tags.join(', ');
            d.tagList = tags;
        });
        saveDatasetData();
        renderDatasetList();
    }

    function batchLinkDatasetProject() {
        var ids = getSelectedIds();
        if (!ids.length) return;
        var opts = collectProjectOptions();
        if (!opts.length) { alert('暂无可用项目'); return; }
        var names = opts.map(function (o, i) { return (i + 1) + '. ' + o.label; }).join('\n');
        var pick = prompt('输入序号关联项目：\n' + names);
        var idx = Number(pick) - 1;
        if (!(idx >= 0 && idx < opts.length)) return;
        getDatasetData().forEach(function (d) {
            if (ids.indexOf(Number(d.id)) >= 0) d.projectKey = opts[idx].value;
        });
        saveDatasetData();
        alert('已关联项目：' + opts[idx].label);
        renderDatasetList();
    }

    function batchDownloadDatasets() {
        var ids = getSelectedIds();
        if (!ids.length) return;
        ids.forEach(function (id, i) {
            setTimeout(function () { downloadDataset(id); }, i * 400);
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

    function findDataset(id) {
        return getDatasetData().map(normalizeDatasetRecord).find(function (d) { return Number(d.id) === Number(id); });
    }

    function showDatasetMoreMenu(id, ev) {
        if (ev) ev.stopPropagation();
        var item = findDataset(id);
        if (!item) return;
        var act = prompt('更多操作：\n1 加入当前分组\n2 发起标注\n3 生成引用\n4 删除\n请输入序号');
        if (act === '1') {
            if (!dsState.groupId) { alert('请先在左侧选中一个分组'); return; }
            var raw = getDatasetData().find(function (d) { return Number(d.id) === Number(id); });
            if (!raw) return;
            raw.groupIds = raw.groupIds || [];
            if (raw.groupIds.indexOf(dsState.groupId) < 0) raw.groupIds.push(dsState.groupId);
            saveDatasetData();
            alert('已加入分组');
            renderDatasetList();
        } else if (act === '2') {
            useDatasetForAnnotation(id);
        } else if (act === '3') {
            copyDatasetCitation(id);
        } else if (act === '4') {
            deleteDataset(id);
        }
    }

    // ---------- 上传弹窗 ----------
    function tagsFieldHtml(id, ph) {
        var tags = getAllDsTags();
        var chips = tags.slice(0, 16).map(function (t) {
            return '<button type="button" class="ds-tag-quick" onclick="appendDsTagToInput(' + JSON.stringify(id) + ',' + JSON.stringify(t) + ')">' + esc(t) + '</button>';
        }).join('');
        return '<div class="ds-tags-field" data-tags-input="' + id + '">' +
            '<input type="text" list="' + id + '_dl" id="' + id + '" placeholder="' + esc(ph || '') + '" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;">' +
            '<datalist id="' + id + '_dl">' + tags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
            '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">' + chips +
            '<button type="button" class="ds-tag-quick ds-tag-quick-add" onclick="promptAddDsTagToInput(' + JSON.stringify(id) + ')">+ 新建</button></div></div>';
    }

    function appendDsTagToInput(inputId, tag) {
        var el = document.getElementById(inputId);
        if (!el || !tag) return;
        var cur = parseTags(el.value);
        if (cur.indexOf(tag) < 0) cur.push(tag);
        el.value = cur.join(', ');
    }

    function promptAddDsTagToInput(inputId) {
        var name = prompt('输入新标签：');
        if (!name) return;
        var tag = addCustomDsTag(name);
        if (tag) appendDsTagToInput(inputId, tag);
    }

    function showAddDatasetModal() {
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客不可上传数据集');
            return;
        }
        pendingDsFile = null;
        pendingParse = null;
        uploadCtrl = {
            paused: false,
            cancelled: false,
            progress: 0,
            abortController: null,
            modalId: '',
            statusText: null
        };

        var modalId = 'dsModal_' + Date.now();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'ds-modal-mask';
        var typeOpts = DATA_TYPE_OPTS.map(function (o) {
            return '<option value="' + o.key + '">' + o.label + '</option>';
        }).join('');
        var annoOpts = ANNO_TYPE_OPTS.map(function (o) {
            return '<option value="' + o.key + '">' + o.label + '</option>';
        }).join('');
        var projectOpts = collectProjectOptions().map(function (o) {
            return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
        }).join('');

        modal.innerHTML =
            '<div class="ds-modal">' +
            '<div class="ds-modal-hd"><h3>上传数据集</h3><button type="button" class="ds-modal-x" onclick="closeDatasetModal(\'' + modalId + '\')">×</button></div>' +
            '<div class="ds-modal-bd">' +
            '<div class="ds-sec-title">① 文件上传区</div>' +
            '<div id="' + modalId + '_drop" class="ds-drop" ' +
            'ondragover="event.preventDefault();this.classList.add(\'drag\')" ondragleave="this.classList.remove(\'drag\')" ' +
            'ondrop="event.preventDefault();this.classList.remove(\'drag\');handleDatasetDrop(event,\'' + modalId + '\')">' +
            '<div style="font-size:40px;margin-bottom:8px;">☁️</div>' +
            '<div style="font-weight:600;margin-bottom:4px;">拖拽文件/文件夹到此处</div>' +
            '<div style="font-size:12px;color:#888;margin-bottom:12px;">支持 CSV、JSON、ZIP；也可直接选文件夹（自动打包为 ZIP 后分片上传，最大 10GB）</div>' +
            '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">' +
            '<button type="button" class="btn btn-secondary" style="padding:6px 14px;font-size:13px;" onclick="event.stopPropagation();document.getElementById(\'' + modalId + '_file\').click()">选择文件</button>' +
            '<button type="button" class="btn" style="padding:6px 14px;font-size:13px;" onclick="event.stopPropagation();document.getElementById(\'' + modalId + '_folder\').click()">选择文件夹</button>' +
            '</div></div>' +
            '<input type="file" id="' + modalId + '_file" accept=".csv,.tsv,.json,.xml,.zip,.jpg,.jpeg,.png,.xlsx,.xls" style="display:none" onchange="handleDatasetFileSelect(this,\'' + modalId + '\')">' +
            '<input type="file" id="' + modalId + '_folder" webkitdirectory directory multiple style="display:none" onchange="handleDatasetFolderSelect(this,\'' + modalId + '\')">' +
            '<div id="' + modalId + '_preview" style="display:none;margin-top:10px;"></div>' +
            '<div id="' + modalId + '_progress" class="ds-progress-wrap" style="display:none;">' +
            '<div class="ds-progress-bar"><div id="' + modalId + '_bar" class="ds-progress-inner"></div></div>' +
            '<div id="' + modalId + '_progText" class="ds-progress-text">准备上传…</div>' +
            '<div class="ds-progress-acts">' +
            '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="pauseDatasetUpload()">暂停</button>' +
            '<button type="button" class="btn" style="padding:4px 10px;font-size:12px;" onclick="resumeDatasetUpload()">继续</button>' +
            '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="cancelDatasetUpload(\'' + modalId + '\')">取消</button>' +
            '</div></div>' +
            '<div class="ds-sec-title">② 基础信息区</div>' +
            '<div style="margin-bottom:12px;"><label class="ds-label">数据集名称 *</label>' +
            '<input id="dsName" type="text" class="ds-input" placeholder="自动从文件名提取，可修改"></div>' +
            '<div style="margin-bottom:12px;"><label class="ds-label">数据集简介</label>' +
            '<textarea id="dsDesc" rows="3" class="ds-input" placeholder="数据来源、适用场景、标注规范"></textarea></div>' +
            '<div style="margin-bottom:12px;"><label class="ds-label">标签</label>' + tagsFieldHtml('dsTags', '监测数据, 城市安全') + '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div><label class="ds-label">数据类型</label><select id="dsDataType" class="ds-input">' + typeOpts + '</select></div>' +
            '<div><label class="ds-label">标注类型</label><select id="dsAnnoType" class="ds-input">' + annoOpts + '</select></div></div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;">' +
            '<div><label class="ds-label">格式 <button type="button" class="ds-link-btn" onclick="reParseDatasetFile(\'' + modalId + '\')">重新识别</button></label>' +
            '<input id="dsFormat" type="text" class="ds-input ds-ro" readonly placeholder="自动识别"></div>' +
            '<div><label class="ds-label">记录数</label><input id="dsSamples" type="text" class="ds-input ds-ro" readonly placeholder="自动识别"></div>' +
            '<div><label class="ds-label">大小</label><input id="dsSize" type="text" class="ds-input ds-ro" readonly placeholder="自动识别"></div></div>' +
            '<div id="' + modalId + '_parseNote" style="font-size:12px;color:#888;margin-top:6px;"></div>' +
            '<div class="ds-sec-title">③ 高级设置区</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div><label class="ds-label">版本号</label><input id="dsVersion" type="text" class="ds-input" value="V1.0"></div>' +
            '<div><label class="ds-label">关联科研项目</label><select id="dsProject" class="ds-input"><option value="">不关联</option>' + projectOpts + '</select></div></div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:12px 0;"><input type="checkbox" id="dsPublic" checked> 共享全组</label>' +
            '<div style="margin-bottom:8px;"><label class="ds-label">引用说明（可选）</label>' +
            '<input id="dsCitation" type="text" class="ds-input" placeholder="写论文时的数据集引用规范"></div>' +
            '<div style="margin-bottom:8px;"><label class="ds-label">版本更新说明（覆盖旧版时填写）</label>' +
            '<input id="dsVersionNote" type="text" class="ds-input" placeholder="如：新增 1000 张标注图片"></div>' +
            '</div>' +
            '<div class="ds-modal-ft">' +
            '<button type="button" class="btn btn-secondary" onclick="closeDatasetModal(\'' + modalId + '\')">取消</button>' +
            '<button type="button" class="btn" id="' + modalId + '_submit" onclick="commitDatasetUpload(\'' + modalId + '\')">开始上传</button>' +
            '</div></div>';
        document.body.appendChild(modal);
    }

    function abortServerUpload(uploadId, extra) {
        if (!uploadId && !(extra && extra.purgeAll)) return Promise.resolve();
        var body = Object.assign({ uploadId: uploadId || '' }, extra || {});
        return fetch('/api/dataset/abort', {
            method: 'POST',
            headers: getDatasetAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
            keepalive: true
        }).catch(function () { /* ignore */ });
    }

    function closeDatasetModal(modalId) {
        uploadCtrl.cancelled = true;
        if (uploadCtrl.abortController) {
            try { uploadCtrl.abortController.abort('cancelled'); } catch (e) { /* ignore */ }
        }
        if (uploadCtrl.uploadId) {
            abortServerUpload(uploadCtrl.uploadId);
            uploadCtrl.uploadId = '';
        }
        pendingDsFile = null;
        var m = document.getElementById(modalId);
        if (m) m.remove();
    }

    function cancelDatasetUpload(modalId) {
        uploadCtrl.cancelled = true;
        uploadCtrl.paused = false;
        if (uploadCtrl.abortController) {
            try { uploadCtrl.abortController.abort('cancelled'); } catch (e) { /* ignore */ }
        }
        if (uploadCtrl.uploadId) {
            abortServerUpload(uploadCtrl.uploadId);
            uploadCtrl.uploadId = '';
        }
        var wrap = document.getElementById(modalId + '_progress');
        if (wrap) wrap.style.display = 'none';
        var btn = document.getElementById(modalId + '_submit');
        if (btn) { btn.disabled = false; btn.textContent = '开始上传'; }
        setUploadStatus('已取消，临时分片已清理', '#b91c1c');
    }

    function setFolderPackProgress(modalId, msg) {
        var note = document.getElementById(modalId + '_parseNote');
        if (note) {
            note.textContent = msg || '';
            note.style.color = '#7c3aed';
        }
        var text = document.getElementById(modalId + '_progText');
        var wrap = document.getElementById(modalId + '_progress');
        if (wrap) wrap.style.display = 'block';
        if (text) text.textContent = msg || '打包中…';
    }

    async function handleDatasetFolderSelect(input, modalId) {
        var list = input && input.files;
        if (!list || !list.length) return;
        try {
            setFolderPackProgress(modalId, '正在读取文件夹…');
            var entries = collectFilesFromFileList(list);
            var rootName = (entries[0] && entries[0].path.split('/')[0]) || 'dataset';
            var zipFile = await packFolderEntriesToZip(entries, rootName, function (done, total, idx, count, pct) {
                if (pct != null) {
                    setFolderPackProgress(modalId, '正在压缩文件夹… ' + Math.round(pct) + '%');
                } else {
                    setFolderPackProgress(modalId, '正在收集文件 ' + idx + '/' + count + '（' + formatBytes(done) + '）');
                }
            });
            await onDatasetFileChosen(zipFile, modalId);
        } catch (e) {
            alert('文件夹处理失败：' + (e && e.message ? e.message : e));
            clearPendingDatasetFile(modalId);
        } finally {
            try { input.value = ''; } catch (e2) { /* ignore */ }
        }
    }

    function handleDatasetFileSelect(input, modalId) {
        var file = input && input.files && input.files[0];
        if (!file) return;
        // 某些浏览器把文件夹当成 size=0 的伪文件
        if (!file.size && !datasetFileExtension(file.name)) {
            alert('检测到可能是文件夹。请点击「选择文件夹」，或先打成 ZIP 再上传');
            try { input.value = ''; } catch (e) { /* ignore */ }
            return;
        }
        onDatasetFileChosen(file, modalId);
    }

    async function handleDatasetDrop(event, modalId) {
        var items = event.dataTransfer && event.dataTransfer.items;
        if (items && items.length) {
            var dirEntry = null;
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item.kind !== 'file') continue;
                var entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                if (entry && entry.isDirectory) {
                    dirEntry = entry;
                    break;
                }
            }
            if (dirEntry) {
                try {
                    setFolderPackProgress(modalId, '正在读取文件夹「' + dirEntry.name + '」…');
                    var zipFile = await packDroppedDirectory(dirEntry, function (done, total, idx, count, pct) {
                        if (pct != null) {
                            setFolderPackProgress(modalId, '正在压缩文件夹… ' + Math.round(pct) + '%');
                        } else {
                            setFolderPackProgress(modalId, '正在收集文件 ' + idx + '/' + count + '（' + formatBytes(done) + '）');
                        }
                    });
                    await onDatasetFileChosen(zipFile, modalId);
                } catch (e) {
                    alert('文件夹处理失败：' + (e && e.message ? e.message : e));
                    clearPendingDatasetFile(modalId);
                }
                return;
            }
        }
        var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (!file) return;
        if (!file.size && !datasetFileExtension(file.name)) {
            alert('拖入的好像是空项或文件夹。请用「选择文件夹」按钮，或拖入已打好的 ZIP');
            return;
        }
        var input = document.getElementById(modalId + '_file');
        if (input) {
            try {
                var dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
            } catch (e) { /* ignore */ }
        }
        onDatasetFileChosen(file, modalId);
    }

    function datasetFileExtension(fileName) {
        var m = String(fileName || '').match(/\.([^.]+)$/);
        return m ? m[1].toLowerCase() : '';
    }

    async function onDatasetFileChosen(file, modalId) {
        if (!file || !file.size) {
            alert('所选文件为空（0 字节），请选择有效的数据集文件');
            return;
        }
        if (file.size > 10 * 1024 * 1024 * 1024) {
            alert('单文件最大 10GB');
            return;
        }
        var pickExt = datasetFileExtension(file.name);
        if (!pickExt) {
            alert('文件缺少扩展名。请选择 .csv / .json / .zip / .xlsx 等支持的数据集文件');
            return;
        }
        pendingDsFile = file;
        var preview = document.getElementById(modalId + '_preview');
        var drop = document.getElementById(modalId + '_drop');
        if (drop) { drop.classList.add('has-file'); }
        if (preview) {
            preview.style.display = 'block';
            preview.innerHTML = '<div class="ds-file-chip"><span>📄 ' + esc(file.name) + '</span><span>' + formatBytes(file.size) + '</span>' +
                '<button type="button" onclick="clearPendingDatasetFile(\'' + modalId + '\')">✕</button></div>';
        }
        setVal('dsSamples', '解析中…');
        setVal('dsFormat', '…');
        setVal('dsSize', formatBytes(file.size));
        var note = document.getElementById(modalId + '_parseNote');
        if (note) note.textContent = '正在自动解析元数据…';

        pendingParse = await autoParseDatasetFile(file);
        applyParseToForm(pendingParse, modalId);
    }

    function applyParseToForm(meta, modalId) {
        if (!meta) return;
        setVal('dsFormat', meta.format);
        setVal('dsSize', meta.size);
        setVal('dsSamples', meta.samples);
        if (meta.nameHint && !(document.getElementById('dsName') || {}).value) setVal('dsName', meta.nameHint);
        if (meta.dataType) setVal('dsDataType', meta.dataType);
        if (meta.annoTypeHint) setVal('dsAnnoType', meta.annoTypeHint);
        var note = document.getElementById(modalId + '_parseNote');
        if (note) {
            note.textContent = meta.parseOk
                ? ('✓ 已识别' + (meta.fieldCount ? (' · 字段 ' + meta.fieldCount) : '') + (meta.encoding ? (' · ' + meta.encoding) : '') + (meta.parseNote ? (' · ' + meta.parseNote) : ''))
                : ('⚠ ' + (meta.parseNote || '解析失败，请手动填写'));
            note.style.color = meta.parseOk ? '#059669' : '#b45309';
        }
        if (!meta.parseOk) {
            var samples = document.getElementById('dsSamples');
            if (samples) { samples.readOnly = false; samples.classList.remove('ds-ro'); samples.placeholder = '请手动填写记录数'; }
        }
    }

    function setVal(id, v) {
        var el = document.getElementById(id);
        if (el) el.value = v == null ? '' : String(v);
    }

    function clearPendingDatasetFile(modalId) {
        pendingDsFile = null;
        pendingParse = null;
        var input = document.getElementById(modalId + '_file');
        if (input) input.value = '';
        var folderInput = document.getElementById(modalId + '_folder');
        if (folderInput) folderInput.value = '';
        var preview = document.getElementById(modalId + '_preview');
        if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
        var drop = document.getElementById(modalId + '_drop');
        if (drop) drop.classList.remove('has-file');
        var wrap = document.getElementById(modalId + '_progress');
        if (wrap) wrap.style.display = 'none';
        ['dsFormat', 'dsSamples', 'dsSize'].forEach(function (id) { setVal(id, ''); });
        var note = document.getElementById(modalId + '_parseNote');
        if (note) { note.textContent = ''; note.style.color = '#888'; }
    }

    async function reParseDatasetFile(modalId) {
        if (!pendingDsFile) { alert('请先选择文件'); return; }
        pendingParse = await autoParseDatasetFile(pendingDsFile);
        applyParseToForm(pendingParse, modalId);
    }

    function setUploadStatus(msg, color) {
        var el = uploadCtrl.statusText || (uploadCtrl.modalId
            ? document.getElementById(uploadCtrl.modalId + '_progText')
            : null);
        if (el) {
            el.textContent = msg;
            if (color) el.style.color = color;
        }
    }

    function pauseDatasetUpload() {
        uploadCtrl.paused = true;
        if (uploadCtrl.abortController) {
            try { uploadCtrl.abortController.abort('paused'); } catch (e) { /* ignore */ }
        }
        setUploadStatus('已暂停 · 点击「继续」恢复上传', '#b45309');
    }

    function resumeDatasetUpload() {
        if (uploadCtrl.cancelled) {
            setUploadStatus('已取消，请重新点击「开始上传」', '#b91c1c');
            return;
        }
        uploadCtrl.paused = false;
        setUploadStatus('正在继续上传…', '#7c3aed');
    }

    function waitWhilePaused() {
        return new Promise(function (resolve) {
            (function tick() {
                if (uploadCtrl.cancelled) return resolve(false);
                if (!uploadCtrl.paused) return resolve(true);
                setTimeout(tick, 120);
            })();
        });
    }

    async function runChunkedUpload(file, modalId, datasetId) {
        uploadCtrl = {
            paused: false,
            cancelled: false,
            progress: 0,
            abortController: null,
            modalId: modalId,
            statusText: document.getElementById(modalId + '_progText'),
            uploadId: ''
        };
        var wrap = document.getElementById(modalId + '_progress');
        var bar = document.getElementById(modalId + '_bar');
        var text = document.getElementById(modalId + '_progText');
        if (wrap) wrap.style.display = 'block';
        if (text) text.style.color = '';

        var caps = await probeDatasetServer();
        if (caps && caps.ok) {
            return runServerChunkedUpload(file, modalId, datasetId, text, bar);
        }
        return runLocalChunkedUpload(file, modalId, datasetId, text, bar);
    }

    function updateUploadProgress(bar, text, uploaded, total, startAt, extra) {
        var pct = Math.round((uploaded / Math.max(total, 1)) * 100);
        uploadCtrl.progress = pct;
        if (bar) bar.style.width = pct + '%';
        var elapsed = (Date.now() - startAt) / 1000;
        var speed = uploaded / Math.max(elapsed, 0.1);
        var remain = (total - uploaded) / Math.max(speed, 1);
        if (text) {
            text.textContent = pct + '% · ' + formatBytes(uploaded) + ' / ' + formatBytes(total) +
                ' · ' + formatBytes(speed) + '/s · 剩余约 ' + Math.max(1, Math.round(remain)) + 's' +
                (extra ? (' · ' + extra) : '');
        }
    }

    function sleepMs(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function friendlyUploadError(err) {
        var msg = (err && err.message) ? String(err.message) : String(err || '未知错误');
        if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
            return '网络中断，未完成的分片已清理。请重新点击「开始上传」';
        }
        return msg;
    }

    async function fetchChunkWithRetry(url, options, attemptHint) {
        var lastErr = null;
        var attempt = 0;
        while (attempt < DS_CHUNK_RETRIES) {
            if (uploadCtrl.cancelled) throw new Error('已取消上传');
            var canGo = await waitWhilePaused();
            if (!canGo) throw new Error('已取消上传');

            attempt += 1;
            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            uploadCtrl.abortController = controller;
            var timedOut = false;
            var timer = setTimeout(function () {
                timedOut = true;
                if (controller) {
                    try { controller.abort('timeout'); } catch (e) { /* ignore */ }
                }
            }, 90000);

            try {
                var opts = Object.assign({}, options);
                if (controller) opts.signal = controller.signal;
                var resp = await fetch(url, opts);
                clearTimeout(timer);
                uploadCtrl.abortController = null;
                var data = await resp.json().catch(function () { return {}; });
                if (!resp.ok || data.ok === false) {
                    var serverErr = (data && data.error) || ('HTTP ' + resp.status);
                    if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
                        throw new Error(serverErr);
                    }
                    lastErr = new Error(serverErr);
                } else {
                    return data;
                }
            } catch (e) {
                clearTimeout(timer);
                uploadCtrl.abortController = null;
                var msg = (e && e.message) ? String(e.message) : String(e || '');
                var aborted = (e && e.name === 'AbortError') || /abort/i.test(msg);
                if (uploadCtrl.cancelled) throw new Error('已取消上传');
                // 暂停导致的中止：不计失败次数，等继续后再传同一片
                if (aborted && uploadCtrl.paused) {
                    attempt -= 1;
                    await waitWhilePaused();
                    continue;
                }
                if (aborted && timedOut) {
                    lastErr = new Error('分片上传超时，正在重试');
                } else {
                    lastErr = e;
                }
                if (/已取消/.test(msg)) throw e;
            }

            if (attempt < DS_CHUNK_RETRIES) {
                if (typeof attemptHint === 'function') {
                    attemptHint(attempt, DS_CHUNK_RETRIES, lastErr);
                }
                await sleepMs(400 * attempt * attempt);
            }
        }
        throw lastErr || new Error('分片上传失败');
    }

    async function runServerChunkedUpload(file, modalId, datasetId, text, bar) {
        var md5 = (pendingParse && pendingParse.md5) || await computeFileMd5(file);
        if (text) text.textContent = '连接服务端分片通道…';
        var initResp = await fetch('/api/dataset/init', {
            method: 'POST',
            headers: getDatasetAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                fileName: file.name,
                size: file.size,
                md5: md5,
                chunkSize: DS_CHUNK_SIZE
            })
        });
        var initData = await initResp.json();
        if (!initResp.ok || !initData.ok) throw new Error((initData && initData.error) || '初始化上传失败');

        if (initData.instant && initData.fileId) {
            if (bar) bar.style.width = '100%';
            if (text) text.textContent = '秒传成功（相同文件已存在）';
            return {
                storedLocally: false,
                storedServer: true,
                instant: true,
                serverFileId: initData.fileId,
                md5: initData.md5 || md5,
                inspect: null
            };
        }

        var uploadId = initData.uploadId;
        uploadCtrl.uploadId = uploadId;
        try {
            var chunkSize = Number(initData.chunkSize) || DS_CHUNK_SIZE;
            var totalChunks = Math.ceil(file.size / chunkSize);
            var startAt = Date.now();
            var uploadedBytes = 0;

            for (var i = 0; i < totalChunks; i++) {
                if (uploadCtrl.cancelled) throw new Error('已取消上传');
                var ok = await waitWhilePaused();
                if (!ok) throw new Error('已取消上传');
                var begin = i * chunkSize;
                var end = Math.min(begin + chunkSize, file.size);
                var slice = file.slice(begin, end);
                var buf = await slice.arrayBuffer();
                await fetchChunkWithRetry('/api/dataset/chunk', {
                    method: 'POST',
                    headers: getDatasetAuthHeaders({
                        'X-Upload-Id': uploadId,
                        'X-Chunk-Index': String(i),
                        'X-Chunk-Total': String(totalChunks),
                        'Content-Type': 'application/octet-stream'
                    }),
                    body: buf
                }, function (attempt, maxAttempts) {
                    if (text) {
                        text.style.color = '#b45309';
                        text.textContent = '分片 ' + (i + 1) + '/' + totalChunks + ' 网络抖动，重试 ' + attempt + '/' + maxAttempts + '…';
                    }
                });
                if (text) text.style.color = '';
                uploadedBytes = end;
                updateUploadProgress(bar, text, uploadedBytes, file.size, startAt, '服务端分片');
            }

            if (text) text.textContent = '合并校验中…';
            var completeData = await fetchChunkWithRetry('/api/dataset/complete', {
                method: 'POST',
                headers: getDatasetAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    uploadId: uploadId,
                    fileName: file.name,
                    size: file.size,
                    md5: md5,
                    fileId: 'dsf_' + datasetId
                })
            });
            uploadCtrl.uploadId = '';
            if (bar) bar.style.width = '100%';
            if (text) text.textContent = '服务端入库完成，正在解析…';
            return {
                storedLocally: false,
                storedServer: true,
                serverFileId: completeData.fileId,
                md5: completeData.md5 || md5,
                inspect: completeData.inspect || null
            };
        } catch (e) {
            // 未成功：删除临时分片，不留存
            await abortServerUpload(uploadId);
            uploadCtrl.uploadId = '';
            throw e;
        }
    }

    async function runLocalChunkedUpload(file, modalId, datasetId, text, bar) {
        var resumeKey = 'ds_upload_' + hashString(simpleFileFingerprint(file));
        var resume = 0;
        try { resume = Number(localStorage.getItem(resumeKey) || 0) || 0; } catch (e) { resume = 0; }

        var total = file.size;
        var startAt = Date.now();
        var uploaded = resume;
        var storeBlob = total <= DS_BLOB_MAX;
        var chunks = [];

        while (uploaded < total) {
            if (uploadCtrl.cancelled) throw new Error('已取消上传');
            var ok = await waitWhilePaused();
            if (!ok) throw new Error('已取消上传');

            var end = Math.min(uploaded + DS_CHUNK_SIZE, total);
            if (storeBlob) {
                var slice = file.slice(uploaded, end);
                var buf = await slice.arrayBuffer();
                chunks.push(buf);
                await idbPut(DS_CHUNK_STORE, datasetId + '_' + uploaded, {
                    offset: uploaded,
                    size: buf.byteLength,
                    done: true
                });
            } else {
                await new Promise(function (r) { setTimeout(r, 20); });
            }
            uploaded = end;
            try { localStorage.setItem(resumeKey, String(uploaded)); } catch (e2) { /* ignore */ }
            updateUploadProgress(bar, text, uploaded, total, startAt, resume ? '本机断点' : '本机缓存');
        }

        if (storeBlob) {
            var blob = new Blob(chunks, { type: file.type || 'application/octet-stream' });
            await idbPut(DS_BLOB_STORE, datasetId, blob);
        }
        try { localStorage.removeItem(resumeKey); } catch (e3) { /* ignore */ }
        if (text) {
            text.textContent = storeBlob
                ? '本机缓存完成，正在入库…'
                : '超大文件仅登记元数据（请使用 start_web.py 网关以启用服务端分片）';
        }
        return { storedLocally: storeBlob, storedServer: false };
    }

    async function commitDatasetUpload(modalId) {
        var name = String((document.getElementById('dsName') || {}).value || '').trim();
        if (!name) { alert('请输入数据集名称'); return; }
        if (!pendingDsFile) { alert('请先选择数据集文件'); return; }
        if (!pendingDsFile.size) {
            alert('所选文件为空（0 字节），无法上传');
            return;
        }
        if (!datasetFileExtension(pendingDsFile.name)) {
            alert('文件缺少扩展名，无法上传');
            return;
        }

        var btn = document.getElementById(modalId + '_submit');
        if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }

        var md5 = (pendingParse && pendingParse.md5) || hashString(simpleFileFingerprint(pendingDsFile));
        var dup = getDatasetData().find(function (d) {
            return d.md5 === md5 || String(d.name).toLowerCase() === name.toLowerCase();
        });
        var asNewVersion = false;
        if (dup) {
            asNewVersion = confirm('检测到同名或相同文件指纹的数据集「' + dup.name + '」。\n确定：覆盖更新为新版本\n取消：作为全新数据集入库');
            if (!asNewVersion && dup.md5 === md5) {
                if (!confirm('文件指纹相同，仍要重复入库吗？')) {
                    if (btn) { btn.disabled = false; btn.textContent = '开始上传'; }
                    return;
                }
            }
        }

        var newId = asNewVersion ? Number(dup.id) : (getDatasetData().reduce(function (m, d) { return Math.max(m, Number(d.id) || 0); }, 0) + 1);

        try {
            var upRes = await runChunkedUpload(pendingDsFile, modalId, newId);
            var tags = parseTags((document.getElementById('dsTags') || {}).value);
            var version = String((document.getElementById('dsVersion') || {}).value || 'V1.0').trim() || 'V1.0';
            var versionNote = String((document.getElementById('dsVersionNote') || {}).value || '').trim() || (asNewVersion ? '版本更新' : '初始版本');
            var samplesVal = String((document.getElementById('dsSamples') || {}).value || '').trim();
            var insp = (upRes && upRes.inspect) || null;
            if (insp) {
                if (insp.sampleCount && (!samplesVal || samplesVal === '—' || /ZIP|解析/.test(samplesVal))) {
                    samplesVal = Number(insp.sampleCount).toLocaleString('en-US');
                    setVal('dsSamples', samplesVal);
                }
                if (insp.preview && (!pendingParse || !pendingParse.preview)) {
                    pendingParse = pendingParse || {};
                    pendingParse.preview = insp.preview;
                }
                if (insp.imageCount && pendingParse) {
                    pendingParse.imageCount = insp.imageCount;
                    pendingParse.labelCount = insp.labelCount;
                    pendingParse.classCount = insp.classCount;
                    pendingParse.classes = insp.classes;
                    pendingParse.sampleImages = insp.sampleImages;
                }
            }
            var record = normalizeDatasetRecord({
                id: newId,
                name: name,
                size: (document.getElementById('dsSize') || {}).value || formatBytes(pendingDsFile.size),
                sizeBytes: pendingDsFile.size,
                format: (document.getElementById('dsFormat') || {}).value || '',
                samples: samplesVal,
                sampleCount: parseSampleCount(samplesVal),
                tags: tags.join(', '),
                tagList: tags,
                dataType: (document.getElementById('dsDataType') || {}).value || 'table',
                annoType: (document.getElementById('dsAnnoType') || {}).value || 'none',
                description: (document.getElementById('dsDesc') || {}).value || '',
                version: version,
                isPublic: !!(document.getElementById('dsPublic') || {}).checked,
                projectKey: (document.getElementById('dsProject') || {}).value || '',
                citation: (document.getElementById('dsCitation') || {}).value || '',
                uploader: (global.currentUser && (global.currentUser.realName || global.currentUser.username)) || '未知',
                uploadTime: new Date().toISOString().slice(0, 10),
                downloadCount: asNewVersion ? (dup.downloadCount || 0) : 0,
                md5: (upRes && upRes.md5) || (pendingParse && pendingParse.md5) || hashString(simpleFileFingerprint(pendingDsFile)),
                fieldCount: (pendingParse && pendingParse.fieldCount) || (insp && insp.fieldCount) || 0,
                encoding: pendingParse ? pendingParse.encoding : '',
                preview: (pendingParse && pendingParse.preview) || (insp && insp.preview) || null,
                imageCount: (pendingParse && pendingParse.imageCount) || (insp && insp.imageCount) || 0,
                labelCount: (pendingParse && pendingParse.labelCount) || (insp && insp.labelCount) || 0,
                classCount: (pendingParse && pendingParse.classCount) || (insp && insp.classCount) || 0,
                classes: (pendingParse && pendingParse.classes) || (insp && insp.classes) || [],
                sampleImages: (pendingParse && pendingParse.sampleImages) || (insp && insp.sampleImages) || [],
                labelPreview: (pendingParse && pendingParse.labelPreview) || '',
                hasLocalBlob: !!(upRes && upRes.storedLocally),
                serverFileId: (upRes && upRes.serverFileId) || '',
                groupIds: asNewVersion ? (dup.groupIds || []) : [],
                downloadLogs: asNewVersion ? (dup.downloadLogs || []) : []
            });

            if (asNewVersion) {
                var versions = (dup.versions || []).slice();
                versions.unshift({
                    version: version,
                    updateTime: record.uploadTime,
                    note: versionNote,
                    size: record.size,
                    sizeBytes: record.sizeBytes
                });
                record.versions = versions;
                record.downloadCount = dup.downloadCount || 0;
                global.datasetData = getDatasetData().map(function (d) {
                    return Number(d.id) === newId ? record : d;
                });
            } else {
                record.versions = [{
                    version: version,
                    updateTime: record.uploadTime,
                    note: versionNote,
                    size: record.size,
                    sizeBytes: record.sizeBytes
                }];
                getDatasetData().push(record);
            }

            saveDatasetData();
            closeDatasetModal(modalId);
            renderDatasetList();
            alert(asNewVersion ? '已更新为新版本并入库' : '上传成功！');
            showDatasetDetail(newId);
        } catch (e) {
            alert('上传失败：' + friendlyUploadError(e));
            if (btn) { btn.disabled = false; btn.textContent = '重试上传'; }
        }
    }

    // ---------- 详情 / 下载 / 联动 ----------
    function showDatasetDetail(id) {
        var item = findDataset(id);
        if (!item) { alert('数据集不存在'); return; }
        var modalId = 'dsDetail_' + Date.now();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'ds-modal-mask';
        var tags = (item.tagList || []).map(function (t) {
            return '<span class="ds-mini-tag">' + esc(t) + '</span>';
        }).join('') || '—';
        var previewHtml = renderPreviewBlock(item);
        var versionsHtml = (item.versions || []).map(function (v, idx) {
            return '<div class="ds-ver-row"><div><b>' + esc(v.version) + '</b> · ' + esc(v.updateTime || '') +
                '<div style="font-size:12px;color:#888;">' + esc(v.note || '') + '</div></div>' +
                '<div style="display:flex;gap:6px;align-items:center;">' +
                '<span style="font-size:12px;color:#666;">' + esc(v.size || '') + '</span>' +
                (idx > 0 ? '<button type="button" class="btn btn-secondary" style="padding:2px 8px;font-size:11px;" onclick="rollbackDatasetVersion(' + item.id + ',' + idx + ')">回退</button>' : '') +
                '</div></div>';
        }).join('') || '<div style="color:#999;font-size:13px;">暂无版本记录</div>';

        var projectLabel = '—';
        if (item.projectKey) {
            var hit = collectProjectOptions().find(function (o) { return o.value === item.projectKey; });
            projectLabel = hit ? hit.label : item.projectKey;
        }

        var linkedTrain = [];
        try {
            var mt = Array.isArray(global.modelTrainingData) ? global.modelTrainingData : JSON.parse(localStorage.getItem('modelTrainingData') || '[]');
            linkedTrain = (mt || []).filter(function (m) {
                return String(m.dataset || '').indexOf(item.name) >= 0 || Number(m.datasetId) === Number(item.id);
            });
        } catch (e) { linkedTrain = []; }

        var linkedAnno = [];
        try {
            var ad = Array.isArray(global.annotationData) ? global.annotationData : JSON.parse(localStorage.getItem('annotationData') || '[]');
            linkedAnno = (ad || []).filter(function (a) {
                return String(a.dataset || '').indexOf(item.name) >= 0 || Number(a.datasetId) === Number(item.id);
            });
        } catch (e2) { linkedAnno = []; }

        var achievements = collectAchievementLinks(item.name);
        var dlLogs = (loadDownloadLogs()[String(item.id)] || []).slice(0, 20);
        var dlHtml = dlLogs.length
            ? dlLogs.map(function (l) {
                return '<div class="ds-ver-row"><div>' + esc(l.user || '未知') + ' · ' + esc(l.mode || '直接下载') + '</div><div style="font-size:12px;color:#888;">' + esc(l.time || '') + '</div></div>';
            }).join('')
            : '<div style="color:#9ca3af;font-size:13px;">暂无下载记录</div>';

        var zipStats = '';
        if (item.imageCount || item.labelCount || item.classCount) {
            zipStats = '<div class="ds-meta" style="margin-top:6px;">图像 ' + (item.imageCount || 0) +
                ' · 标注文件 ' + (item.labelCount || 0) +
                ' · 类别 ' + (item.classCount || 0) +
                ((item.classes && item.classes.length) ? ('（' + esc(item.classes.slice(0, 8).join(', ')) + '）') : '') +
                '</div>';
        }

        var serverLink = item.serverFileId
            ? (location.origin + '/api/dataset/download?fileId=' + encodeURIComponent(item.serverFileId))
            : '';

        modal.innerHTML =
            '<div class="ds-modal ds-modal-lg">' +
            '<div class="ds-modal-hd"><h3>数据集详情</h3><button type="button" class="ds-modal-x" onclick="document.getElementById(\'' + modalId + '\').remove()">×</button></div>' +
            '<div class="ds-modal-bd">' +
            '<div class="ds-detail-top">' +
            '<div class="ds-detail-cover">' + iconOfDataType(item.dataType) + '</div>' +
            '<div style="flex:1;min-width:0;">' +
            '<div class="ds-title-row"><span class="ds-title" style="font-size:20px;">' + esc(item.name) + '</span>' + statusBadge(item) + '</div>' +
            '<p style="margin:8px 0;color:#4b5563;font-size:14px;line-height:1.6;">' + esc(item.description || '暂无简介') + '</p>' +
            '<div class="ds-meta">' + esc(item.size) + ' · ' + esc(item.format) + ' · ' + esc(item.samples) + ' 条 · ' +
            esc(labelOf(DATA_TYPE_OPTS, item.dataType)) + ' · ' + esc(labelOf(ANNO_TYPE_OPTS, item.annoType)) +
            ' · 版本 ' + esc(item.version) + ' · 下载 ' + (item.downloadCount || 0) + ' 次' +
            (item.isPublic === false ? ' · 仅导师可见' : ' · 全组共享') + '</div>' +
            zipStats +
            '<div class="ds-tags" style="margin-top:8px;">' + tags + '</div>' +
            '<div class="ds-foot" style="margin-top:8px;">上传者：' + esc(item.uploader) + ' | ' + esc(item.uploadTime) +
            (item.md5 ? (' | 指纹 ' + esc(item.md5)) : '') +
            (item.serverFileId ? (' | 服务端 ' + esc(item.serverFileId)) : '') + '</div>' +
            '</div></div>' +
            '<div class="ds-detail-sec"><h4>数据样例预览</h4>' + previewHtml + '</div>' +
            '<div class="ds-detail-sec"><h4>版本历史</h4>' + versionsHtml + '</div>' +
            '<div class="ds-detail-sec"><h4>关联溯源</h4>' +
            '<div style="font-size:13px;color:#374151;margin-bottom:6px;">关联项目：' + esc(projectLabel) +
            (item.projectKey ? ' <button type="button" class="ds-link-btn" onclick="exportProjectDatasetManifest(' + JSON.stringify(item.projectKey) + ')">导出项目数据集清单</button>' : '') +
            '</div>' +
            '<div style="font-size:13px;color:#374151;margin-bottom:6px;">训练任务：' + (linkedTrain.length ? linkedTrain.map(function (m) {
                return '<a href="javascript:void(0)" onclick="showModule(\'model_training\')">' + esc(m.name) + '</a>';
            }).join('、') : '暂无') + '</div>' +
            '<div style="font-size:13px;color:#374151;margin-bottom:6px;">标注任务：' + (linkedAnno.length ? linkedAnno.map(function (a) {
                return esc(a.name) + (a.progress != null ? ('(' + a.progress + '%)') : '');
            }).join('、') : '暂无') +
            ' <button type="button" class="ds-link-btn" onclick="syncLabeledDatasetFromAnnotation(' + item.id + ')">同步标注版</button></div>' +
            '<div style="font-size:13px;color:#374151;margin-bottom:6px;">关联论文：' + (achievements.papers.length ? achievements.papers.map(function (p) {
                return esc(p.title || p.name);
            }).join('、') : '暂无（在论文备注中提及数据集名可自动关联）') + '</div>' +
            '<div style="font-size:13px;color:#374151;">关联专利：' + (achievements.patents.length ? achievements.patents.map(function (p) {
                return esc(p.name || p.title);
            }).join('、') : '暂无') + '</div>' +
            '</div>' +
            '<div class="ds-detail-sec"><h4>下载记录</h4>' + dlHtml + '</div>' +
            '<div class="ds-detail-sec"><h4>下载与引用</h4>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">' +
            '<button type="button" class="btn" onclick="downloadDataset(' + item.id + ',\'direct\')">直接下载</button>' +
            '<button type="button" class="btn btn-secondary" onclick="downloadDataset(' + item.id + ',\'link\')">复制下载链接</button>' +
            '<button type="button" class="btn btn-secondary" onclick="downloadDataset(' + item.id + ',\'thunder\')">迅雷链接</button>' +
            '<button type="button" class="btn btn-secondary" onclick="copyDatasetCitation(' + item.id + ')">GB/T 7714 引用</button>' +
            '</div>' +
            (serverLink ? ('<div style="font-size:12px;color:#6b7280;word-break:break-all;">网关直链：' + esc(serverLink) + '</div>') : '<div style="font-size:12px;color:#9ca3af;">未落盘到服务端时，下载走本机 IndexedDB 缓存。</div>') +
            '</div></div>' +
            '<div class="ds-modal-ft" style="flex-wrap:wrap;">' +
            '<button type="button" class="btn btn-secondary" onclick="useDatasetForAnnotation(' + item.id + ')">发起标注</button>' +
            '<button type="button" class="btn btn-secondary" onclick="useDatasetForTraining(' + item.id + ')">一键训练</button>' +
            '<button type="button" class="btn" onclick="downloadDataset(' + item.id + ')">下载</button>' +
            '</div></div>';
        document.body.appendChild(modal);
    }

    function renderPreviewBlock(item) {
        if (item.preview && item.preview.type === 'image' && item.preview.images && item.preview.images.length) {
            var stats = item.preview.stats || {};
            var imgs = item.preview.images.map(function (img) {
                var src = typeof img === 'string' ? img : (img.url || '');
                var title = typeof img === 'string' ? '' : (img.path || '');
                return '<div class="ds-img-tile" title="' + esc(title) + '"><img src="' + esc(src) + '" alt=""></div>';
            }).join('');
            return '<div class="ds-meta" style="margin-bottom:8px;">样例图 ' + item.preview.images.length +
                (stats.imageCount ? (' / 共 ' + stats.imageCount + ' 张') : '') +
                (stats.labelCount ? (' · 标注文件 ' + stats.labelCount) : '') + '</div>' +
                '<div class="ds-img-grid">' + imgs + '</div>' +
                (item.preview.labelPreview || item.labelPreview
                    ? ('<pre class="ds-label-pre">' + esc(item.preview.labelPreview || item.labelPreview) + '</pre>')
                    : '');
        }
        if (item.serverFileId && item.sampleImages && item.sampleImages.length) {
            var tiles = item.sampleImages.slice(0, 12).map(function (p) {
                var src = '/api/dataset/sample?fileId=' + encodeURIComponent(item.serverFileId) + '&path=' + encodeURIComponent(p);
                return '<div class="ds-img-tile" title="' + esc(p) + '"><img src="' + esc(src) + '" alt="" loading="lazy"></div>';
            }).join('');
            return '<div class="ds-img-grid">' + tiles + '</div>' +
                '<div style="font-size:12px;color:#888;margin-top:6px;">来自服务端 ZIP 样例抽取</div>';
        }
        if (item.preview && item.preview.columns && item.preview.columns.length) {
            var cols = item.preview.columns;
            var rows = (item.preview.rows || []).slice(0, 20);
            var thead = '<tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>';
            var tbody = rows.map(function (r) {
                return '<tr>' + cols.map(function (_, i) { return '<td>' + esc(r[i] == null ? '' : r[i]) + '</td>'; }).join('') + '</tr>';
            }).join('');
            return '<div class="ds-preview-table-wrap"><table class="ds-preview-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>' +
                '<div style="font-size:12px;color:#888;margin-top:6px;">预览前 ' + rows.length + ' 行' + (item.fieldCount ? (' · ' + item.fieldCount + ' 个字段') : '') + '</div></div>';
        }
        if (item.dataType === 'image') {
            return '<div class="ds-img-preview-hint">图像数据集元数据已就绪。上传 ZIP 后可自动统计图像/标注并展示样例图。</div>';
        }
        return '<div style="color:#9ca3af;font-size:13px;">暂无样例预览。上传 CSV/JSON/ZIP 后将自动生成。</div>';
    }

    async function downloadDataset(id, mode) {
        mode = mode || 'direct';
        var item = findDataset(id);
        if (!item) return;
        if (global.currentUser && global.currentUser.role === 'visitor') {
            alert('访客无下载权限');
            return;
        }
        if (item.isPublic === false) {
            var role = global.currentUser && global.currentUser.role;
            if (role !== 'admin' && role !== 'mentor' && role !== 'teacher') {
                var me = (global.currentUser && (global.currentUser.realName || global.currentUser.username)) || '';
                if (me !== item.uploader) {
                    alert('该数据集仅导师/管理员或上传者可下载');
                    return;
                }
            }
        }

        var raw = getDatasetData().find(function (d) { return Number(d.id) === Number(id); });
        var who = (global.currentUser && (global.currentUser.realName || global.currentUser.username)) || '未知';
        var when = new Date().toLocaleString('zh-CN');
        var serverUrl = item.serverFileId
            ? (location.origin + '/api/dataset/download?fileId=' + encodeURIComponent(item.serverFileId))
            : '';

        if (mode === 'link' || mode === 'thunder') {
            var link = serverUrl || ('dataset://' + encodeURIComponent(item.name) + '?id=' + item.id);
            var text = mode === 'thunder' ? ('thunder://' + btoa(unescape(encodeURIComponent(link)))) : link;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                alert(mode === 'thunder' ? '已复制迅雷链接' : '已复制下载链接');
            } else {
                prompt('复制链接：', text);
            }
            if (raw) {
                raw.downloadCount = (Number(raw.downloadCount) || 0) + 1;
                saveDatasetData();
            }
            pushDownloadLog(id, { user: who, time: when, mode: mode === 'thunder' ? '迅雷链接' : '复制链接' });
            return;
        }

        if (raw) {
            raw.downloadCount = (Number(raw.downloadCount) || 0) + 1;
            saveDatasetData();
        }
        pushDownloadLog(id, { user: who, time: when, mode: '直接下载' });

        if (serverUrl) {
            var a1 = document.createElement('a');
            a1.href = serverUrl;
            a1.download = item.name || 'dataset';
            document.body.appendChild(a1);
            a1.click();
            a1.remove();
            renderDatasetList();
            return;
        }
        try {
            var blob = await idbGet(DS_BLOB_STORE, id);
            if (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = (item.name || 'dataset') + (item.format ? ('.' + String(item.format).split('/')[0].toLowerCase()) : '');
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
                renderDatasetList();
                return;
            }
        } catch (e) { /* fallthrough */ }
        alert('本机未缓存完整文件二进制。\n已记录下载统计。\n名称：' + item.name + '\n大小：' + item.size + '\n提示：通过 start_web.py 上传的大文件可走服务端直链下载。');
        renderDatasetList();
    }

    function rollbackDatasetVersion(id, versionIndex) {
        var raw = getDatasetData().find(function (d) { return Number(d.id) === Number(id); });
        if (!raw || !Array.isArray(raw.versions) || !raw.versions[versionIndex]) return;
        if (!confirm('确认回退到版本「' + raw.versions[versionIndex].version + '」？当前版本信息会保留在历史中。')) return;
        var target = raw.versions[versionIndex];
        var note = '从 ' + (raw.version || '') + ' 回退';
        raw.versions.unshift({
            version: target.version,
            updateTime: new Date().toISOString().slice(0, 10),
            note: note,
            size: target.size,
            sizeBytes: target.sizeBytes
        });
        raw.version = target.version;
        raw.size = target.size || raw.size;
        raw.sizeBytes = target.sizeBytes || raw.sizeBytes;
        saveDatasetData();
        alert('已回退到 ' + target.version);
        var open = document.querySelector('.ds-modal-mask');
        if (open) open.remove();
        showDatasetDetail(id);
        renderDatasetList();
    }

    function exportProjectDatasetManifest(projectKey) {
        var list = getDatasetData().map(normalizeDatasetRecord).filter(function (d) {
            return d.projectKey === projectKey;
        });
        var lines = ['数据集名称,版本,大小,格式,记录数,标注类型,上传者,上传时间'];
        list.forEach(function (d) {
            lines.push([d.name, d.version, d.size, d.format, d.samples, d.annoType, d.uploader, d.uploadTime]
                .map(function (x) { return '"' + String(x || '').replace(/"/g, '""') + '"'; }).join(','));
        });
        var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '项目数据集清单_' + String(projectKey).replace(/[:\\/]/g, '_') + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function syncLabeledDatasetFromAnnotation(id) {
        var item = findDataset(id);
        if (!item) return;
        var linked = [];
        try {
            var ad = Array.isArray(global.annotationData) ? global.annotationData : JSON.parse(localStorage.getItem('annotationData') || '[]');
            linked = (ad || []).filter(function (a) {
                return String(a.dataset || '').indexOf(item.name) >= 0;
            });
        } catch (e) { linked = []; }
        if (!linked.length) {
            alert('未找到关联标注任务。可先「发起标注」，完成后再同步。');
            return;
        }
        var task = linked[0];
        var progress = Number(task.progress != null ? task.progress : (task.labeled && task.total ? (100 * task.labeled / task.total) : 0));
        var raw = getDatasetData().find(function (d) { return Number(d.id) === Number(id); });
        if (!raw) return;
        var newVer = 'V' + (parseFloat(String(raw.version || '1').replace(/[^\d.]/g, '')) + 0.1).toFixed(1);
        raw.versions = raw.versions || [];
        raw.versions.unshift({
            version: newVer,
            updateTime: new Date().toISOString().slice(0, 10),
            note: '同步标注任务「' + (task.name || '') + '」进度 ' + Math.round(progress) + '%',
            size: raw.size,
            sizeBytes: raw.sizeBytes
        });
        raw.version = newVer;
        raw.annoStatus = progress >= 100 ? 'labeled' : (progress > 0 ? 'partial' : 'unlabeled');
        if (raw.annoType === 'none') raw.annoType = 'detection';
        saveDatasetData();
        alert('已生成标注同步版本 ' + newVer + '（状态：' + annoStatusLabel(raw.annoStatus) + '）');
        var open = document.querySelector('.ds-modal-mask');
        if (open) open.remove();
        showDatasetDetail(id);
        renderDatasetList();
    }

    function deleteDataset(id) {
        if (!confirm('确定要删除该数据集吗？')) return;
        global.datasetData = getDatasetData().filter(function (d) { return Number(d.id) !== Number(id); });
        idbDel(DS_BLOB_STORE, id).catch(function () {});
        delete dsState.selected[String(id)];
        saveDatasetData();
        renderDatasetList();
    }

    function copyDatasetCitation(id) {
        var item = findDataset(id);
        if (!item) return;
        var year = String(item.uploadTime || '').slice(0, 4) || new Date().getFullYear();
        var cite = item.citation || (
            item.uploader + '. ' + item.name + '[DS]. ' +
            year + '. 城市安全数智创新团队数据集资源库, 版本 ' + (item.version || 'V1.0') +
            (item.md5 ? ('. 标识: ' + item.md5) : '') + '.'
        );
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cite).then(function () { alert('已复制 GB/T 7714 风格引用：\n' + cite); });
        } else {
            prompt('复制以下引用：', cite);
        }
    }

    function useDatasetForTraining(id) {
        var item = findDataset(id);
        if (!item) return;
        global.__pendingDatasetLink = { type: 'training', name: item.name, id: item.id, samples: item.samples };
        if (typeof global.showModule === 'function') global.showModule('model_training');
        setTimeout(function () {
            if (typeof global.showAddModelModal === 'function') {
                global.showAddModelModal();
                setTimeout(function () {
                    var el = document.getElementById('modelDataset');
                    if (el) el.value = item.name;
                    var nameEl = document.getElementById('modelName');
                    if (nameEl && !nameEl.value) nameEl.value = item.name + '-训练任务';
                }, 80);
            }
        }, 120);
    }

    function useDatasetForAnnotation(id) {
        var item = findDataset(id);
        if (!item) return;
        global.__pendingDatasetLink = { type: 'annotation', name: item.name, id: item.id, samples: item.sampleCount };
        if (typeof global.showModule === 'function') global.showModule('data_annotation');
        setTimeout(function () {
            if (typeof global.showAddAnnotationModal === 'function') {
                global.showAddAnnotationModal();
                setTimeout(function () {
                    var el = document.getElementById('annoDataset');
                    if (el) el.value = item.name;
                    var total = document.getElementById('annoTotal');
                    if (total && item.sampleCount) total.value = String(item.sampleCount);
                    var nameEl = document.getElementById('annoName');
                    if (nameEl && !nameEl.value) nameEl.value = item.name + '-标注任务';
                    if (item.annoType && item.annoType !== 'none') {
                        var typeMap = { detection: '目标检测', segmentation: '语义分割', classification: '图像分类' };
                        var want = typeMap[item.annoType];
                        var sel = document.getElementById('annoType');
                        if (sel && want) {
                            Array.prototype.forEach.call(sel.options, function (opt) {
                                if (opt.value.indexOf(want) >= 0 || opt.text.indexOf(want) >= 0) sel.value = opt.value;
                            });
                        }
                    }
                }, 80);
            }
        }, 120);
    }

    function injectStyles() {
        if (dsState.stylesInjected) return;
        dsState.stylesInjected = true;
        var style = document.createElement('style');
        style.id = 'datasetLibraryStyles';
        style.textContent = [
            '.ds-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px;}',
            '.ds-stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;cursor:pointer;}',
            '.ds-stat-card:hover,.ds-stat-card.active{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.12);}',
            '.ds-stat-card .n{font-size:20px;font-weight:700;color:#111827;}',
            '.ds-stat-card .l{font-size:12px;color:#6b7280;margin-top:4px;}',
            '.ds-filter-row,.ds-advanced-filter{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;}',
            '.ds-filter-row select,.ds-filter-row input,.ds-advanced-filter input,.ds-advanced-filter select{padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;}',
            '.ds-tag-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}',
            '.ds-tag-chip{padding:4px 10px;border:1px solid #e5e7eb;background:#fff;border-radius:999px;font-size:12px;color:#4b5563;cursor:pointer;}',
            '.ds-tag-chip.active{background:#ede9fe;border-color:#7c3aed;color:#5b21b6;}',
            '.ds-tag-chip.ds-tag-add{border-style:dashed;color:#7c3aed;border-color:#c4b5fd;background:#faf8ff;}',
            '.ds-tag-add-panel{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border:1px dashed #c4b5fd;border-radius:999px;background:#faf8ff;}',
            '.ds-tag-add-panel input{width:96px;padding:4px 8px;border:1px solid #ddd;border-radius:999px;font-size:12px;}',
            '.ds-tag-add-ok{border:none;background:#7c3aed;color:#fff;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;}',
            '.ds-tag-add-cancel{border:none;background:#f3f4f6;color:#6b7280;border-radius:999px;padding:4px 8px;cursor:pointer;}',
            '.ds-batch-bar{display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;margin-top:12px;}',
            '.ds-group-side{width:180px;flex-shrink:0;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px;}',
            '.ds-group-title{font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;}',
            '.ds-group-item{display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;border:none;background:transparent;padding:8px 10px;border-radius:8px;font-size:13px;color:#4b5563;cursor:pointer;margin-bottom:4px;}',
            '.ds-group-item:hover,.ds-group-item.active{background:#f5f3ff;color:#5b21b6;}',
            '.ds-group-del{opacity:.45;padding:0 4px;}',
            '.ds-group-add{width:100%;margin-top:8px;border:1px dashed #c4b5fd;background:#faf8ff;color:#7c3aed;border-radius:8px;padding:8px;font-size:12px;cursor:pointer;}',
            '.ds-view-toggle{display:inline-flex;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;}',
            '.ds-view-btn{border:none;background:#fff;padding:8px 12px;font-size:12px;cursor:pointer;color:#6b7280;}',
            '.ds-view-btn.active{background:#7c3aed;color:#fff;}',
            '.ds-card{background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:12px;border:1px solid #f0f0f0;box-shadow:0 1px 3px rgba(0,0,0,.04);}',
            '.ds-card.selected,.ds-grid-card.selected{border-color:#a78bfa;background:#faf8ff;}',
            '.ds-card-main{display:flex;gap:10px;align-items:flex-start;}',
            '.ds-icon{font-size:28px;line-height:1;margin-top:2px;}',
            '.ds-body{flex:1;min-width:0;}',
            '.ds-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
            '.ds-title{font-size:16px;font-weight:700;color:#111827;text-decoration:none;}',
            '.ds-title:hover{color:#7c3aed;}',
            '.ds-meta{font-size:13px;color:#6b7280;margin-top:6px;}',
            '.ds-tags{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;}',
            '.ds-mini-tag{padding:2px 8px;background:#f0f5ff;color:#1890ff;border-radius:4px;font-size:12px;}',
            '.ds-anno-badge{font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;}',
            '.ds-anno-badge.ok{background:#dcfce7;color:#166534;}',
            '.ds-anno-badge.mid{background:#fef3c7;color:#92400e;}',
            '.ds-anno-badge.off{background:#f3f4f6;color:#6b7280;}',
            '.ds-ver{font-size:11px;color:#7c3aed;background:#ede9fe;padding:2px 6px;border-radius:4px;}',
            '.ds-foot{font-size:12px;color:#9ca3af;margin-top:8px;}',
            '.ds-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;justify-content:flex-end;}',
            '.ds-act{padding:4px 10px !important;font-size:12px !important;}',
            '.ds-fav-btn{border:none;background:transparent;font-size:18px;cursor:pointer;color:#d1d5db;}',
            '.ds-fav-btn.on{color:#f59e0b;}',
            '.ds-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;}',
            '.ds-grid-card{position:relative;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;}',
            '.ds-thumb{height:120px;display:flex;align-items:center;justify-content:center;font-size:48px;background:linear-gradient(135deg,#f5f3ff,#eff6ff);}',
            '.ds-grid-body{padding:12px;}',
            '.ds-check-abs{position:absolute;top:10px;left:10px;}',
            '.ds-fav-abs{position:absolute;top:6px;right:8px;}',
            '.ds-pagination{display:flex;gap:6px;align-items:center;justify-content:center;margin-top:16px;flex-wrap:wrap;}',
            '.ds-page-btn{border:1px solid #e5e7eb;background:#fff;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;}',
            '.ds-page-btn.active{background:#7c3aed;color:#fff;border-color:#7c3aed;}',
            '.ds-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2200;display:flex;justify-content:center;align-items:center;padding:16px;}',
            '.ds-modal{background:#fff;border-radius:12px;width:100%;max-width:720px;max-height:92vh;overflow:auto;}',
            '.ds-modal-lg{max-width:900px;}',
            '.ds-modal-hd{padding:16px 20px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;}',
            '.ds-modal-hd h3{margin:0;font-size:18px;}',
            '.ds-modal-x{width:32px;height:32px;border:none;background:#f5f5f5;border-radius:50%;cursor:pointer;}',
            '.ds-modal-bd{padding:16px 20px;}',
            '.ds-modal-ft{padding:14px 20px;background:#f9fafb;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:10px;}',
            '.ds-sec-title{font-size:14px;font-weight:700;color:#5b21b6;margin:16px 0 10px;padding-bottom:6px;border-bottom:1px dashed #ede9fe;}',
            '.ds-sec-title:first-child{margin-top:0;}',
            '.ds-label{display:block;margin-bottom:5px;font-size:13px;color:#374151;}',
            '.ds-input{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;}',
            '.ds-input.ds-ro{background:#f5f5f5;color:#6b7280;}',
            '.ds-drop{border:2px dashed #ddd;border-radius:10px;padding:28px;text-align:center;cursor:pointer;transition:.15s;}',
            '.ds-drop.drag,.ds-drop.has-file{border-color:#7c3aed;background:#faf8ff;}',
            '.ds-file-chip{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#f5f5f5;padding:10px 12px;border-radius:8px;font-size:13px;}',
            '.ds-file-chip button{border:none;background:none;cursor:pointer;color:#999;}',
            '.ds-progress-wrap{margin-top:12px;padding:12px;background:#faf8ff;border:1px solid #ede9fe;border-radius:10px;}',
            '.ds-progress-bar{height:8px;background:#ede9fe;border-radius:999px;overflow:hidden;}',
            '.ds-progress-inner{height:100%;width:0;background:#7c3aed;transition:width .15s;}',
            '.ds-progress-text{font-size:12px;color:#6b7280;margin-top:8px;}',
            '.ds-progress-acts{display:flex;gap:8px;margin-top:8px;}',
            '.ds-tag-quick{padding:2px 8px;border:1px solid #e5e7eb;background:#f9fafb;border-radius:999px;font-size:11px;cursor:pointer;}',
            '.ds-tag-quick-add{border-style:dashed;color:#7c3aed;}',
            '.ds-link-btn{border:none;background:none;color:#7c3aed;font-size:12px;cursor:pointer;padding:0;margin-left:6px;}',
            '.ds-detail-top{display:flex;gap:16px;margin-bottom:16px;}',
            '.ds-detail-cover{width:120px;height:120px;border-radius:12px;background:linear-gradient(135deg,#f5f3ff,#eff6ff);display:flex;align-items:center;justify-content:center;font-size:48px;flex-shrink:0;}',
            '.ds-detail-sec{margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;}',
            '.ds-detail-sec h4{margin:0 0 10px;font-size:14px;color:#111827;}',
            '.ds-ver-row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px dashed #f3f4f6;font-size:13px;}',
            '.ds-preview-table-wrap{overflow:auto;max-height:280px;border:1px solid #e5e7eb;border-radius:8px;}',
            '.ds-preview-table{border-collapse:collapse;width:100%;font-size:12px;}',
            '.ds-preview-table th,.ds-preview-table td{border-bottom:1px solid #f3f4f6;padding:6px 8px;text-align:left;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;}',
            '.ds-preview-table th{background:#f9fafb;position:sticky;top:0;}',
            '.ds-img-preview-hint{padding:16px;background:#f9fafb;border-radius:8px;font-size:13px;color:#6b7280;}',
            '.ds-img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;}',
            '.ds-img-tile{aspect-ratio:1;border-radius:8px;overflow:hidden;background:#f3f4f6;border:1px solid #e5e7eb;}',
            '.ds-img-tile img{width:100%;height:100%;object-fit:cover;display:block;}',
            '.ds-label-pre{margin-top:10px;padding:10px;background:#0f172a;color:#e2e8f0;border-radius:8px;font-size:11px;max-height:160px;overflow:auto;white-space:pre-wrap;}',
            '@media (max-width:900px){.ds-stat-grid{grid-template-columns:repeat(2,1fr);} .ds-group-side{display:none;} .ds-detail-top{flex-direction:column;}}'
        ].join('');
        document.head.appendChild(style);
    }

    function initDatasetLibrary() {
        loadFavorites();
        seedIfEmpty();
        injectStyles();
        var uploadBtn = document.getElementById('dsLibraryUploadBtn');
        if (uploadBtn && global.currentUser && global.currentUser.role === 'visitor') {
            uploadBtn.style.display = 'none';
        }
        renderDatasetList();
    }

    function loadDatasetLibraryData() {
        seedIfEmpty();
        return getDatasetData();
    }

    var api = {
        initDatasetLibrary: initDatasetLibrary,
        loadDatasetLibraryData: loadDatasetLibraryData,
        saveDatasetLibraryData: saveDatasetData,
        renderDatasetList: renderDatasetList,
        showAddDatasetModal: showAddDatasetModal,
        showDatasetDetail: showDatasetDetail,
        deleteDataset: deleteDataset,
        downloadDataset: downloadDataset,
        setDsStatFilter: setDsStatFilter,
        setDsTagFilter: setDsTagFilter,
        onDatasetFilterChange: onDatasetFilterChange,
        onDatasetSearchInput: onDatasetSearchInput,
        toggleDsAdvancedFilter: toggleDsAdvancedFilter,
        setDatasetView: setDatasetView,
        setDatasetPage: setDatasetPage,
        setDatasetGroup: setDatasetGroup,
        createDatasetGroup: createDatasetGroup,
        deleteDatasetGroup: deleteDatasetGroup,
        toggleDsSelect: toggleDsSelect,
        toggleDatasetFavorite: toggleDatasetFavorite,
        toggleDsTagAddPanel: toggleDsTagAddPanel,
        confirmAddDsTag: confirmAddDsTag,
        batchDeleteDatasets: batchDeleteDatasets,
        batchTagDatasets: batchTagDatasets,
        batchLinkDatasetProject: batchLinkDatasetProject,
        batchDownloadDatasets: batchDownloadDatasets,
        handleDatasetFileSelect: handleDatasetFileSelect,
        handleDatasetFolderSelect: handleDatasetFolderSelect,
        handleDatasetDrop: handleDatasetDrop,
        clearPendingDatasetFile: clearPendingDatasetFile,
        reParseDatasetFile: reParseDatasetFile,
        closeDatasetModal: closeDatasetModal,
        commitDatasetUpload: commitDatasetUpload,
        pauseDatasetUpload: pauseDatasetUpload,
        resumeDatasetUpload: resumeDatasetUpload,
        cancelDatasetUpload: cancelDatasetUpload,
        appendDsTagToInput: appendDsTagToInput,
        promptAddDsTagToInput: promptAddDsTagToInput,
        useDatasetForTraining: useDatasetForTraining,
        useDatasetForAnnotation: useDatasetForAnnotation,
        copyDatasetCitation: copyDatasetCitation,
        showDatasetMoreMenu: showDatasetMoreMenu,
        rollbackDatasetVersion: rollbackDatasetVersion,
        exportProjectDatasetManifest: exportProjectDatasetManifest,
        syncLabeledDatasetFromAnnotation: syncLabeledDatasetFromAnnotation,
        normalizeDatasetRecord: normalizeDatasetRecord
    };

    Object.keys(api).forEach(function (k) { global[k] = api[k]; });
    global.DatasetLibrary = api;

})(typeof window !== 'undefined' ? window : this);
