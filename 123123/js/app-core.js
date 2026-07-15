        // ========== Supabase 配置 (REST API 模式，无需SDK) ==========
        // 加载顺序：config.js（可提交公开配置）→ config.local.js（本机覆盖，可选）
        window.APP_CONFIG = window.APP_CONFIG || {};
        function getAppConfig(key, fallback) {
            if (window.APP_CONFIG && Object.prototype.hasOwnProperty.call(window.APP_CONFIG, key)) {
                return window.APP_CONFIG[key];
            }
            return fallback;
        }
        const SUPABASE_URL = String(getAppConfig('SUPABASE_URL', '') || '').trim();
        const SUPABASE_KEY = String(getAppConfig('SUPABASE_KEY', '') || '').trim();
        
        function supabaseRequest(method, table, data, options) {
            options = options || {};
            var maxRetry = options.retries != null ? Number(options.retries) : 2;
            if (!isFinite(maxRetry) || maxRetry < 0) maxRetry = 0;

            function formatSupabaseError(xhr) {
                var status = xhr && xhr.status;
                var body = (xhr && xhr.responseText) ? String(xhr.responseText).slice(0, 240) : '';
                if (!status) {
                    return '无法连接 Supabase（HTTP 0：网络中断、DNS 失败、扩展拦截或未走 http://localhost:8000）。请检查网络后在首页右下角执行「全量同步」。目标：' + SUPABASE_URL;
                }
                return 'HTTP ' + status + ': ' + body;
            }

            function isTransientSupabaseError(err) {
                var msg = String(err && err.message || err || '');
                return /HTTP 0|网络错误|超时|timeout|Failed to fetch|ERR_NETWORK|ERR_CONNECTION/i.test(msg);
            }

            function once() {
                return new Promise(function(resolve, reject) {
                    if (!SUPABASE_URL || !SUPABASE_KEY) {
                        reject(new Error('Supabase 未配置：请检查 config.js / config.local.js'));
                        return;
                    }
                    var xhr = new XMLHttpRequest();
                    var url = SUPABASE_URL + '/rest/v1/' + table;
                    if (method === 'GET' && data) {
                        var params = [];
                        if (data.select) params.push('select=' + encodeURIComponent(data.select));
                        if (data.limit) params.push('limit=' + data.limit);
                        if (data.order) params.push('order=' + encodeURIComponent(data.order));
                        if (params.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + params.join('&');
                    }
                    if (options.onConflict) {
                        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'on_conflict=' + encodeURIComponent(options.onConflict);
                    }
                    var settled = false;
                    function fail(err) {
                        if (settled) return;
                        settled = true;
                        reject(err instanceof Error ? err : new Error(String(err || '未知错误')));
                    }
                    function ok(val) {
                        if (settled) return;
                        settled = true;
                        resolve(val);
                    }
                    xhr.open(method, url, true);
                    xhr.timeout = options.timeoutMs || 20000;
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.setRequestHeader('apikey', SUPABASE_KEY);
                    xhr.setRequestHeader('Authorization', 'Bearer ' + SUPABASE_KEY);
                    var prefer = options.prefer || 'return=representation';
                    xhr.setRequestHeader('Prefer', prefer);
                    xhr.onreadystatechange = function() {
                        if (xhr.readyState !== 4) return;
                        if (xhr.status >= 200 && xhr.status < 300) {
                            try {
                                ok(xhr.responseText ? JSON.parse(xhr.responseText) : []);
                            } catch (e) {
                                ok(xhr.responseText ? null : []);
                            }
                        } else {
                            fail(new Error(formatSupabaseError(xhr)));
                        }
                    };
                    xhr.onerror = function() {
                        fail(new Error(formatSupabaseError(xhr)));
                    };
                    xhr.ontimeout = function() {
                        fail(new Error('连接 Supabase 超时（' + (options.timeoutMs || 20000) + 'ms）'));
                    };
                    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
                        xhr.send(JSON.stringify(data || {}));
                    } else {
                        xhr.send();
                    }
                });
            }

            function run(left) {
                return once().catch(function (err) {
                    if (left > 0 && isTransientSupabaseError(err)) {
                        var wait = 400 * (maxRetry - left + 1);
                        return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
                            return run(left - 1);
                        });
                    }
                    throw err;
                });
            }
            return run(maxRetry);
        }

        window.diagnoseCloudSync = async function diagnoseCloudSync() {
            var result = {
                url: SUPABASE_URL || '(空)',
                keyPresent: !!(SUPABASE_KEY && SUPABASE_KEY.length > 8),
                keyPrefix: SUPABASE_KEY ? String(SUPABASE_KEY).slice(0, 14) + '…' : '',
                pageOrigin: location.origin,
                ok: false,
                detail: ''
            };
            if (!SUPABASE_URL || !SUPABASE_KEY) {
                result.detail = '未配置 SUPABASE_URL / SUPABASE_KEY';
                console.warn('[cloud-diagnose]', result);
                return result;
            }
            try {
                var rows = await supabaseRequest(
                    'GET',
                    'patents?select=id&limit=1',
                    null,
                    { retries: 1, timeoutMs: 12000, prefer: 'count=exact' }
                );
                result.ok = true;
                result.detail = '连通正常，样例行数：' + (Array.isArray(rows) ? rows.length : 0);
            } catch (e) {
                result.detail = String(e && e.message || e);
            }
            console.info('[cloud-diagnose]', result);
            try {
                if (typeof showCloudSyncBanner === 'function') {
                    showCloudSyncBanner(result.ok ? ('云端连通正常') : ('云端诊断失败：' + result.detail.slice(0, 80)), !result.ok);
                }
            } catch (e2) {}
            if (result.ok) {
                try {
                    if (typeof window.clearStaleCloudSyncAlerts === 'function') {
                        window.clearStaleCloudSyncAlerts('diagnose-ok');
                    }
                } catch (e3) {}
            }
            return result;
        };

        // ========== 全站云端同步（复用已有 patents 表，无需新建表） ==========
        // 同步记录标记：classification=__APP_SYNC__，patent_number=__SYNC_KV__{key}
        const CLOUD_SYNC_KEYS = new Set([
            'teamMemberData', 'memberGradeYears', 'accountData', 'permissionMatrix', 'passwordPolicy', 'loginLogData',
            'longitudinalData', 'horizontalData', 'schoolData',
            'taskData', 'weeklyReportData', 'applicationData', 'approvalFlowConfig', 'noticeData', 'newsData', 'meetingData',
            'literatureData', 'datasetData', 'reportData', 'sharedFileData',
            'standardData', 'copyrightData', 'competitionData',
            'modelTrainingData', 'annotationTypes', 'annotationData',
            'knowledgeData', 'compareLiteratureData',
            'systemConfigData', 'operationLogData',
            'patentData', 'patentMgmtData', 'paperData', 'categoryData', 'memberData',
            'portalContentConfig_v1', 'portalFeedbackData_v1',
            'literatureCompareDimTemplate', 'literatureCompareNamedDimTemplates',
            'customInstructionTemplates', 'devlogEntries',
            'backupData', 'autoBackupConfig'
        ]);
        const CLOUD_SYNC_MARK = '__APP_SYNC__';
        const CLOUD_SYNC_PREFIX = '__SYNC_KV__';

        let cloudSyncReady = false;
        let cloudSyncEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);
        var cloudSyncState = {
            enabled: cloudSyncEnabled,
            lastAt: 0,
            lastOk: null,
            lastApplied: 0,
            lastError: '',
            lastReason: '',
            pollMs: 15000
        };
        function markCloudSyncState( partial ) {
            try {
                Object.assign(cloudSyncState, partial || {});
                cloudSyncState.enabled = !!cloudSyncEnabled;
                if (typeof window !== 'undefined') window.cloudSyncState = cloudSyncState;
            } catch (e) {}
        }
        window.cloudSyncState = cloudSyncState;
        window.markCloudSyncState = markCloudSyncState;
        let cloudPulling = false;
        const cloudUpsertTimers = {};
        const cloudRowIdCache = {};
        let cloudSyncBannerEl = null;

        function showCloudSyncBanner(msg, isError) {
            if (!cloudSyncBannerEl) {
                cloudSyncBannerEl = document.createElement('div');
                cloudSyncBannerEl.id = 'cloudSyncBanner';
                cloudSyncBannerEl.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:20000;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.18);transition:opacity 0.3s;pointer-events:none;';
                document.body.appendChild(cloudSyncBannerEl);
            }
            cloudSyncBannerEl.style.background = isError ? '#fff1f0' : '#f0fff4';
            cloudSyncBannerEl.style.color = isError ? '#cf1322' : '#389e0d';
            cloudSyncBannerEl.style.border = isError ? '1px solid #ffa39e' : '1px solid #b7eb8f';
            cloudSyncBannerEl.textContent = msg;
            cloudSyncBannerEl.style.opacity = '1';
            clearTimeout(showCloudSyncBanner._t);
            showCloudSyncBanner._t = setTimeout(function() {
                if (cloudSyncBannerEl) cloudSyncBannerEl.style.opacity = '0';
            }, isError ? 8000 : 2500);
        }

        function syncKeyToPatentNumber(key) {
            return CLOUD_SYNC_PREFIX + key;
        }

        function patentNumberToSyncKey(pn) {
            if (!pn || pn.indexOf(CLOUD_SYNC_PREFIX) !== 0) return null;
            return pn.slice(CLOUD_SYNC_PREFIX.length);
        }

        function compactSyncValue(key, parsed) {
            // 保留压缩后的头像；仅当单张过大时才丢弃，避免撑爆字段
            if (key === 'teamMemberData' && Array.isArray(parsed)) {
                return parsed.map(function(m) {
                    var copy = Object.assign({}, m);
                    var av = copy.avatar ? String(copy.avatar) : '';
                    if (av.length > 120000) {
                        copy.avatar = '';
                        copy.avatarSynced = false;
                    } else if (av) {
                        copy.avatarSynced = true;
                    }
                    return copy;
                });
            }
            // 账号头像过大时裁掉，密码与角色权限必须保留以支持全局登录
            if (key === 'accountData' && Array.isArray(parsed)) {
                return parsed.map(function(a) {
                    var copy = Object.assign({}, a);
                    var av = copy.avatar ? String(copy.avatar) : '';
                    if (av.length > 80000) copy.avatar = '';
                    return copy;
                });
            }
            return parsed;
        }

        function mergeCloudTeamMembersWithLocalAvatars(cloudMembers) {
            if (!Array.isArray(cloudMembers)) return cloudMembers;
            var local = [];
            try { local = JSON.parse(localStorage.getItem('teamMemberData') || '[]'); } catch (e) { local = []; }
            var localAvatarByName = {};
            var localAvatarById = {};
            local.forEach(function(m) {
                if (m && m.avatar && String(m.avatar).length > 50) {
                    if (m.name) localAvatarByName[m.name] = m.avatar;
                    if (m.id != null) localAvatarById[m.id] = m.avatar;
                }
            });
            return cloudMembers.map(function(m) {
                var hasCloudAvatar = m && m.avatar && String(m.avatar).length > 50;
                if (hasCloudAvatar) return m;
                var localAv = (m && m.id != null && localAvatarById[m.id]) || (m && m.name && localAvatarByName[m.name]);
                if (localAv) return Object.assign({}, m, { avatar: localAv, avatarSynced: false });
                return m;
            });
        }

        async function findSyncRowId(key) {
            if (cloudRowIdCache[key]) return cloudRowIdCache[key];
            var pn = encodeURIComponent(syncKeyToPatentNumber(key));
            var rows = await supabaseRequest('GET', 'patents?patent_number=eq.' + pn, { select: 'id', limit: 1 });
            if (rows && rows[0] && rows[0].id) {
                cloudRowIdCache[key] = rows[0].id;
                return rows[0].id;
            }
            return null;
        }

        async function cloudUpsert(key, rawValue) {
            if (!cloudSyncEnabled || !CLOUD_SYNC_KEYS.has(key)) return;
            var parsed;
            try {
                parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
            } catch (e) {
                parsed = rawValue;
            }
            parsed = compactSyncValue(key, parsed);
            var summary = '';
            try {
                summary = JSON.stringify(parsed);
            } catch (e) {
                console.warn('cloud stringify failed', key, e);
                return;
            }
            // 过大则跳过（约 500KB 保护）
            if (summary.length > 500000) {
                console.warn('cloud value too large, skip', key, summary.length);
                return;
            }
            var payload = {
                patent_type: '同步',
                name: '[SYNC] ' + key,
                patent_number: syncKeyToPatentNumber(key),
                classification: CLOUD_SYNC_MARK,
                status: 'SYNC',
                applicant: 'system',
                summary: summary,
                remark: 'cloud-sync:' + new Date().toISOString()
            };
            try {
                var id = await findSyncRowId(key);
                if (id) {
                    await supabaseRequest('PATCH', 'patents?id=eq.' + id, payload, { prefer: 'return=minimal' });
                } else {
                    var created = await supabaseRequest('POST', 'patents', payload, { prefer: 'return=representation' });
                    if (created && created[0] && created[0].id) {
                        cloudRowIdCache[key] = created[0].id;
                    }
                }
                cloudSyncReady = true;
            } catch (err) {
                console.warn('cloud upsert failed', key, err);
                if (String(err && err.message || err).indexOf('401') >= 0) {
                    showCloudSyncBanner('云端同步权限不足', true);
                }
            }
            try {
                var fp = {};
                try { fp = JSON.parse(localStorage.getItem('cloudSyncFingerprints') || '{}') || {}; } catch (eFp) { fp = {}; }
                var h = 5381;
                for (var i = 0; i < summary.length; i++) h = ((h << 5) + h) + summary.charCodeAt(i);
                fp[key] = (h >>> 0).toString(36) + ':' + summary.length;
                localStorage.setItem('cloudSyncFingerprints', JSON.stringify(fp));
            } catch (eFp2) {}
        }

        function queueCloudUpsert(key, rawValue) {
            if (!cloudSyncEnabled || cloudPulling || !CLOUD_SYNC_KEYS.has(key)) return;
            clearTimeout(cloudUpsertTimers[key]);
            cloudUpsertTimers[key] = setTimeout(function() {
                cloudUpsert(key, rawValue);
            }, 350);
        }

        (function patchLocalStorageSync() {
            var origSetItem = localStorage.setItem.bind(localStorage);
            localStorage.setItem = function(key, value) {
                origSetItem(key, value);
                queueCloudUpsert(key, value);
            };
        })();

        async function pullAllFromCloud(options) {
            options = options || {};
            if (!cloudSyncEnabled) {
                markCloudSyncState({ lastAt: Date.now(), lastOk: false, lastReason: 'disabled', lastError: '未配置云端', lastApplied: 0 });
                return { ok: false, reason: 'disabled', applied: 0, skipped: 0, changedKeys: [] };
            }
            function syncContentHash(str) {
                var h = 5381;
                str = String(str || '');
                for (var i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
                return (h >>> 0).toString(36) + ':' + str.length;
            }
            function loadSyncFingerprints() {
                try { return JSON.parse(localStorage.getItem('cloudSyncFingerprints') || '{}') || {}; } catch (e) { return {}; }
            }
            function saveSyncFingerprints(map) {
                try { localStorage.setItem('cloudSyncFingerprints', JSON.stringify(map || {})); } catch (e) {}
            }
            try {
                cloudPulling = true;
                var rows = await supabaseRequest(
                    'GET',
                    'patents?classification=eq.' + encodeURIComponent(CLOUD_SYNC_MARK),
                    { select: 'id,patent_number,summary,remark', limit: 500 }
                );
                cloudSyncReady = true;
                var applied = 0;
                var skipped = 0;
                var changedKeys = [];
                var fingerprints = loadSyncFingerprints();
                var forceFull = !!options.full;
                var latestByKey = {};
                (rows || []).forEach(function(row) {
                    var key = patentNumberToSyncKey(row.patent_number);
                    if (!key || !CLOUD_SYNC_KEYS.has(key)) return;
                    if (!latestByKey[key] || (row.id > latestByKey[key].id)) {
                        latestByKey[key] = row;
                    }
                });
                Object.keys(latestByKey).forEach(function(key) {
                    var row = latestByKey[key];
                    cloudRowIdCache[key] = row.id;
                    try {
                        var summaryRaw = row.summary || 'null';
                        var hash = syncContentHash(summaryRaw);
                        var localRaw = null;
                        try { localRaw = localStorage.getItem(key); } catch (eL) { localRaw = null; }
                        if (!forceFull && fingerprints[key] === hash && localRaw != null) {
                            skipped++;
                            return;
                        }
                        var parsed = JSON.parse(summaryRaw);
                        if (key === 'teamMemberData' && Array.isArray(parsed)) {
                            parsed = mergeCloudTeamMembersWithLocalAvatars(parsed);
                        }
                        var nextRaw = JSON.stringify(parsed);
                        if (!forceFull && localRaw === nextRaw) {
                            fingerprints[key] = hash;
                            skipped++;
                            return;
                        }
                        Storage.prototype.setItem.call(localStorage, key, nextRaw);
                        fingerprints[key] = hash;
                        applied++;
                        changedKeys.push(key);
                    } catch (e) {
                        console.warn('apply cloud key failed', key, e);
                    }
                });
                saveSyncFingerprints(fingerprints);
                markCloudSyncState({
                    lastAt: Date.now(),
                    lastOk: true,
                    lastApplied: applied,
                    lastSkipped: skipped,
                    lastMode: forceFull ? 'full' : 'incremental',
                    lastChangedKeys: changedKeys,
                    lastError: '',
                    lastReason: 'ok'
                });
                if (options.silent !== true) {
                    if (forceFull) {
                        showCloudSyncBanner('全量同步完成：更新 ' + applied + ' 项，跳过 ' + skipped + ' 项', false);
                    } else {
                        showCloudSyncBanner(applied > 0
                            ? ('增量同步：更新 ' + applied + ' 项，未变 ' + skipped + ' 项')
                            : ('增量同步：无变更（已核对 ' + skipped + ' 项）'), false);
                    }
                }
                try {
                    if (typeof window !== 'undefined' && window.__homeRealtimeBroadcast && applied > 0) {
                        window.__homeRealtimeBroadcast({ type: 'cloud-applied', applied: applied, keys: changedKeys });
                    }
                } catch (eBc) {}
                return { ok: true, applied: applied, skipped: skipped, changedKeys: changedKeys, full: forceFull };
            } catch (err) {
                console.warn('pullAllFromCloud failed', err);
                markCloudSyncState({
                    lastAt: Date.now(),
                    lastOk: false,
                    lastApplied: 0,
                    lastError: String(err && err.message || err),
                    lastReason: 'error'
                });
                if (options.silent !== true) showCloudSyncBanner('拉取云端数据失败', true);
                try {
                    if (typeof window !== 'undefined' && typeof window.notifyHomeSyncFailure === 'function') {
                        window.notifyHomeSyncFailure(String(err && err.message || err));
                    }
                } catch (eN) {}
                return { ok: false, error: String(err && err.message || err), applied: 0, skipped: 0, changedKeys: [] };
            } finally {
                cloudPulling = false;
            }
        }
        window.pullAllFromCloud = pullAllFromCloud;

        function hydrateInMemoryFromLocalStorage() {
            function apply(name, setter) {
                try {
                    var raw = localStorage.getItem(name);
                    if (raw === null) return;
                    setter(JSON.parse(raw));
                } catch (e) {}
            }
            try { apply('teamMemberData', function(v){ teamMemberData = v; }); } catch(e){}
            try { apply('accountData', function(v){ accountData = v; }); } catch(e){}
            try { apply('permissionMatrix', function(v){ permissionMatrix = v; }); } catch(e){}
            try { apply('sharedFileData', function(v){ sharedFileData = v; }); } catch(e){}
            try { apply('longitudinalData', function(v){ longitudinalData = v; }); } catch(e){}
            try { apply('horizontalData', function(v){ horizontalData = v; }); } catch(e){}
            try { apply('schoolData', function(v){ schoolData = v; }); } catch(e){}
            try { apply('taskData', function(v){ taskData = v; }); } catch(e){}
            try { apply('weeklyReportData', function(v){ weeklyReportData = v; }); } catch(e){}
            try { apply('applicationData', function(v){
                if (typeof window.mergeIncomingApplicationData === 'function') window.applicationData = window.mergeIncomingApplicationData(v);
                else window.applicationData = v;
            }); } catch(e){}
            try { apply('approvalFlowConfig', function(v){
                if (typeof window.mergeIncomingApprovalFlowConfig === 'function') window.mergeIncomingApprovalFlowConfig(v);
                else window.approvalFlowConfig = v;
            }); } catch(e){}
            try { apply('noticeData', function(v){
                if (typeof window.mergeIncomingNoticeData === 'function') noticeData = window.mergeIncomingNoticeData(v);
                else noticeData = v;
                try { window.noticeData = noticeData; } catch (eN) {}
            }); } catch(e){}
            try { apply('newsData', function(v){
                if (typeof window.mergeIncomingNewsData === 'function') {
                    window.newsData = window.mergeIncomingNewsData(v);
                } else if (window.NewsManagement) {
                    window.NewsManagement.newsData = v;
                } else {
                    window.newsData = v;
                }
            }); } catch(e){}
            try { apply('meetingData', function(v){ meetingData = v; }); } catch(e){}
            try { apply('literatureData', function(v){
                if (typeof window.mergeIncomingLiteratureData === 'function') literatureData = window.mergeIncomingLiteratureData(v);
                else literatureData = v;
                try { window.literatureData = literatureData; } catch (eLit) {}
            }); } catch(e){}
            try { apply('datasetData', function(v){ datasetData = v; }); } catch(e){}
            try { apply('reportData', function(v){ reportData = v; }); } catch(e){}
            try { apply('standardData', function(v){ standardData = v; }); } catch(e){}
            try { apply('copyrightData', function(v){ copyrightData = v; }); } catch(e){}
            try { apply('competitionData', function(v){
                if (typeof window.mergeIncomingCompetitionData === 'function') window.mergeIncomingCompetitionData(v);
                else window.competitionData = v;
            }); } catch(e){}
            try { apply('systemConfigData', function(v){ systemConfigData = v; }); } catch(e){}
            try { apply('operationLogData', function(v){ operationLogData = v; }); } catch(e){}
            try { apply('modelTrainingData', function(v){ modelTrainingData = v; }); } catch(e){}
            try { apply('annotationTypes', function(v){ annotationTypes = v; }); } catch(e){}
            try { apply('annotationData', function(v){ annotationData = v; }); } catch(e){}
            try { apply('knowledgeData', function(v){ knowledgeData = v; }); } catch(e){}
            try { apply('compareLiteratureData', function(v){ compareLiteratureData = v; }); } catch(e){}
            try { apply('patentData', function(v){ patentData = v; try { window.patentData = v; } catch (eW) {} }); } catch(e){}
            try { apply('patentMgmtData', function(v){
                if (typeof patentMgmtData !== 'undefined') patentMgmtData = v;
                try { window.patentMgmtData = v; } catch (eW) {}
                try { window.patentData = v; patentData = v; } catch (eW2) {}
            }); } catch(e){}
            try { apply('paperData', function(v){
                if (typeof paperData !== 'undefined') paperData = v;
                try { window.paperData = v; } catch (eW) {}
            }); } catch(e){}
            try { apply('categoryData', function(v){ categoryData = v; }); } catch(e){}
            try { apply('memberData', function(v){ memberData = v; }); } catch(e){}
            try { apply('memberGradeYears', function(v){ try { window.memberGradeYears = v; } catch (eW) {} }); } catch(e){}
            try { apply('copyrightData', function(v){ if (typeof copyrightData !== 'undefined') copyrightData = v; try { window.copyrightData = v; } catch (eW) {} }); } catch(e){}
            try { apply('standardData', function(v){ if (typeof standardData !== 'undefined') standardData = v; try { window.standardData = v; } catch (eW) {} }); } catch(e){}
            try { apply('competitionData', function(v){ try { window.competitionData = v; } catch (eW) {} }); } catch(e){}
            try { apply('portalContentConfig_v1', function(v){ try { window.portalContentConfig_v1 = v; } catch (eW) {} }); } catch(e){}
        }

        async function syncFromCloudAndRefresh(options) {
            var result = await pullAllFromCloud(options || {});
            hydrateInMemoryFromLocalStorage();
            try { if (typeof onCloudAccountPermissionHydrated === 'function') onCloudAccountPermissionHydrated(); } catch (e) {}
            try { if (typeof syncTeamMembersAcrossSystem === 'function') syncTeamMembersAcrossSystem({ preserveSessionUser: true }); } catch (e) {}
            // 团队联动可能改写账号 id，必须立刻回写会话，否则刷新会变成「未登录」
            try { if (typeof rematchSessionAfterAccountSync === 'function') rematchSessionAfterAccountSync(); } catch (eRematch) {}
            // 论文/专利台账：云表 + KV 镜像双向对齐，保证首页/门户全局同源
            try { if (typeof initPaperData === 'function') await initPaperData({ silent: true }); } catch (ePaper) {}
            try { if (typeof initPatentMgmtData === 'function') await initPatentMgmtData({ silent: true }); } catch (ePat) {}
            try {
                if (typeof ensureMemberGradeYears === 'function') ensureMemberGradeYears();
                if (typeof renderMemberNav === 'function') renderMemberNav();
                if (typeof renderMemberAllSections === 'function') renderMemberAllSections();
                if (typeof renderTeamMembers === 'function') renderTeamMembers();
            } catch (e) {}
            try { if (typeof renderFileList === 'function') renderFileList(); } catch (e) {}
            try { if (typeof renderAccountTable === 'function') renderAccountTable(); } catch (e) {}
            try { if (typeof renderPermissionMatrix === 'function') renderPermissionMatrix(); } catch (e) {}
            try { if (typeof applyRolePermissions === 'function') applyRolePermissions(); } catch (e) {}
            try { if (typeof updateHeaderUserInfo === 'function') updateHeaderUserInfo(); } catch (e) {}
            try { if (typeof populateOwnerSelects === 'function') populateOwnerSelects(); } catch (e) {}
            try { if (typeof renderTaskList === 'function') renderTaskList(); } catch (e) {}
            try { if (typeof renderNoticeList === 'function') renderNoticeList(); } catch (e) {}
            try { if (typeof refreshGlobalNoticeCenter === 'function') refreshGlobalNoticeCenter(); } catch (e) {}
            try { if (typeof populateWeeklyReportOwnerSelects === 'function') populateWeeklyReportOwnerSelects(); } catch (e) {}
            try { if (typeof renderWeeklyReportList === 'function') renderWeeklyReportList(); } catch (e) {}
            try { if (typeof renderApplicationCenter === 'function') renderApplicationCenter(); } catch (e) {}
            try { if (typeof renderModelTrainingList === 'function') renderModelTrainingList(); } catch (e) {}
            try { if (typeof renderAnnotationList === 'function') renderAnnotationList(); } catch (e) {}
            try { if (typeof updateAnnotationStats === 'function') updateAnnotationStats(); } catch (e) {}
            try { if (typeof populateAnnotationFilters === 'function') populateAnnotationFilters(); } catch (e) {}
            try { if (typeof renderKnowledgeList === 'function') renderKnowledgeList(); } catch (e) {}
            try { if (typeof updateChatStats === 'function') updateChatStats(); } catch (e) {}
            try { if (typeof updateChatModeBadge === 'function') updateChatModeBadge(); } catch (e) {}
            try { if (typeof updateLongitudinalFilterCounts === 'function') updateLongitudinalFilterCounts(); if (typeof applyLongitudinalFilters === 'function') applyLongitudinalFilters(); } catch (e) {}
            try { if (typeof updateHorizontalFilterCounts === 'function') updateHorizontalFilterCounts(); if (typeof applyHorizontalFilters === 'function') applyHorizontalFilters(); } catch (e) {}
            try { if (typeof updateSchoolFilterCounts === 'function') updateSchoolFilterCounts(); if (typeof applySchoolFilters === 'function') applySchoolFilters(); } catch (e) {}
            try { if (typeof renderNewsList === 'function') renderNewsList(); if (typeof updateNewsStats === 'function') updateNewsStats(); if (typeof renderHomeNewsPanel === 'function') renderHomeNewsPanel(); } catch (e) {}
            try { if (typeof renderHomeDashboard === 'function') renderHomeDashboard(); } catch (eHomeDash) {}
            try { if (typeof renderMeetingList === 'function') renderMeetingList(); if (typeof updateMeetingStats === 'function') updateMeetingStats(); } catch (e) {}
            try { if (typeof renderLiteratureList === 'function') renderLiteratureList(); } catch (e) {}
            try { if (typeof renderDatasetList === 'function') renderDatasetList(); } catch (e) {}
            try { if (typeof renderReportList === 'function') renderReportList(); } catch (e) {}
            try { if (typeof updatePaperFilterCounts === 'function') updatePaperFilterCounts(); if (typeof renderPaperTable === 'function') renderPaperTable(); } catch (e) {}
            try { if (typeof updatePatentMgmtFilterCounts === 'function') updatePatentMgmtFilterCounts(); if (typeof renderPatentMgmtTable === 'function') renderPatentMgmtTable(); } catch (e) {}
            try { if (typeof updateCopyrightFilterCounts === 'function') updateCopyrightFilterCounts(); if (typeof renderCopyrightTable === 'function') renderCopyrightTable(); } catch (e) {}
            try { if (typeof updateStandardFilterCounts === 'function') updateStandardFilterCounts(); if (typeof renderStandardTable === 'function') renderStandardTable(); } catch (e) {}
            try { if (typeof renderCompetitionList === 'function') renderCompetitionList(); } catch (e) {}
            try {
                if (result && result.applied > 0 && typeof invalidateHomeOverviewCache === 'function') {
                    invalidateHomeOverviewCache('cloud-sync');
                }
            } catch (eInv) {}
            try {
                if (typeof invalidatePortalCache === 'function') invalidatePortalCache();
            } catch (ePortal) {}
            return result;
        }
        window.syncFromCloudAndRefresh = syncFromCloudAndRefresh;

        // 跨标签页：其他窗口写入同步键时，本页立刻拉云端，保证全局联动
        try {
            window.addEventListener('storage', function(ev) {
                if (!ev || !ev.key) return;
                if (!CLOUD_SYNC_KEYS.has(ev.key) && ev.key !== 'cloudSyncFingerprints') return;
                clearTimeout(window.__cloudStorageSyncTimer);
                window.__cloudStorageSyncTimer = setTimeout(function() {
                    syncFromCloudAndRefresh({ silent: true, full: false });
                }, 400);
            });
        } catch (eStorageSync) {}

        setInterval(function() {
            if (!cloudSyncEnabled) return;
            if (document.hidden) return;
            var home = document.getElementById('home');
            // 首页激活时由 5s 定时器负责，避免重复拉取
            if (home && home.classList.contains('active')) return;
            syncFromCloudAndRefresh({ silent: true, full: false });
        }, 15000);

        // 首页激活时 5s 增量同步，提升「实时」感
        setInterval(function() {
            if (!cloudSyncEnabled) return;
            if (document.hidden) return;
            var home = document.getElementById('home');
            if (!home || !home.classList.contains('active')) return;
            syncFromCloudAndRefresh({ silent: true, full: false });
        }, 5000);

        window.__cloudBootstrapped = true;
        setTimeout(function() {
            syncFromCloudAndRefresh({ silent: true, full: false });
        }, 400);

        // 显示模块
        var moduleNavHistory = [];
        var currentModuleId = 'home';
        var moduleNavSkipHistory = false;
        var MODULE_LABEL_MAP = {
            home: '首页',
            about: '团队介绍',
            achievements: '团队成果',
            projects: '团队项目',
            members: '团队成员',
            contact: '联系我们',
            member_archive: '团队成员档案',
            role_permission: '角色权限',
            task_management: '任务管理',
            weekly_report: '工作周报',
            application_center: '请假与申请',
            longitudinal_project: '纵向项目',
            horizontal_project: '横向项目',
            school_project: '校级项目',
            project_overview: '项目总览',
            patent_management: '专利管理',
            paper_management: '论文管理',
            standard_management: '标准规范',
            competition_management: '竞赛成果',
            software_copyright: '软著管理',
            funding_management: '经费管理',
            model_training: '模型训练',
            data_annotation: '数据标注',
            chat: 'AI 问答',
            openai: 'OpenAI 入口',
            literature_analysis: '文献分析',
            excel: 'Excel 工具',
            document_analysis: '文档分析',
            notice_publish: '通知公告',
            news_management: '新闻管理',
            meeting_management: '组会管理',
            literature_library: '文献资料',
            dataset_library: '数据集',
            project_report: '项目报告',
            shared_files: '共享文件',
            account_permission: '账号权限',
            system_config: '系统配置',
            operation_log: '操作日志',
            data_backup: '数据备份',
            collection: '专利收集'
        };

        function getModuleLabel(moduleId) {
            if (!moduleId) return '';
            if (MODULE_LABEL_MAP[moduleId]) return MODULE_LABEL_MAP[moduleId];
            try {
                var items = document.querySelectorAll('.nav-item, .top-nav .nav-links a');
                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    var handler = item.getAttribute('onclick') || '';
                    if (handler.indexOf("'" + moduleId + "'") >= 0 || handler.indexOf('"' + moduleId + '"') >= 0) {
                        return String(item.textContent || '').replace(/\s+/g, ' ').trim() || moduleId;
                    }
                }
            } catch (e) {}
            return moduleId;
        }

        function updateModuleBackButton() {
            var can = moduleNavHistory.length > 0;
            var prevId = can ? moduleNavHistory[moduleNavHistory.length - 1] : '';
            var prevLabel = prevId ? getModuleLabel(prevId) : '';
            var title = can ? ('返回上一级：' + prevLabel + '（Alt+←）') : '暂无上一级页面';
            var btn = document.getElementById('moduleBackBtn');
            var fab = document.getElementById('moduleBackFab');
            var fabPrev = document.getElementById('moduleBackFabPrev');
            var btnText = btn ? btn.querySelector('.back-text') : null;
            [btn, fab].forEach(function (el) {
                if (!el) return;
                el.disabled = !can;
                el.classList.toggle('is-disabled', !can);
                el.title = title;
            });
            if (btnText) btnText.textContent = can ? ('返回 ' + prevLabel) : '返回';
            if (fabPrev) fabPrev.textContent = can ? prevLabel : '';
            try {
                window.__moduleNavHistory = moduleNavHistory.slice();
                window.__currentModuleId = currentModuleId;
            } catch (e) {}
        }

        function pushModuleHistory(fromId) {
            if (!fromId) return;
            if (moduleNavHistory[moduleNavHistory.length - 1] === fromId) return;
            moduleNavHistory.push(fromId);
            if (moduleNavHistory.length > 40) moduleNavHistory.shift();
        }

        function goBackModule() {
            var active = document.querySelector('.module.active');
            var curId = (active && active.id) || currentModuleId || '';
            while (moduleNavHistory.length) {
                var prev = moduleNavHistory.pop();
                if (!prev || prev === curId) continue;
                if (!document.getElementById(prev)) continue;
                moduleNavSkipHistory = true;
                try {
                    showModule(prev);
                } finally {
                    moduleNavSkipHistory = false;
                    currentModuleId = prev;
                    updateModuleBackButton();
                }
                return;
            }
            updateModuleBackButton();
        }

        async function showModule(moduleId) {
            if (typeof window.loadModuleHtml === 'function') {
                try { await window.loadModuleHtml(moduleId); } catch (e) { console.warn(e); }
            }
            if (!moduleId) return;
            var target = document.getElementById(moduleId);
            if (!target) {
                console.warn('[showModule] 模块不存在:', moduleId);
                return;
            }

            // 历史记录改由最外层 navigateShowModule 统一处理，避免重复 push
            currentModuleId = moduleId;
            updateModuleBackButton();

            if (cloudSyncEnabled) {
                clearTimeout(window.__cloudModuleSyncTimer);
                window.__cloudModuleSyncTimer = setTimeout(function() {
                    syncFromCloudAndRefresh({ silent: true });
                }, 200);
            }

            // 隐藏所有模块
            document.querySelectorAll('.module').forEach(module => {
                module.classList.remove('active');
            });
            
            // 显示选中模块
            target.classList.add('active');
            
            // 更新导航状态
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.remove('active');
            });
            
            // 尝试找到对应的nav-item并激活
            const navItems = document.querySelectorAll('.nav-item');
            for (let item of navItems) {
                if (item.onclick && item.onclick.toString().includes(moduleId)) {
                    item.classList.add('active');
                    // 展开包含该菜单项的子菜单
                    const submenu = item.closest('.submenu');
                    if (submenu) {
                        submenu.classList.add('show');
                        const category = submenu.previousElementSibling;
                        if (category) {
                            const toggle = category.querySelector('.submenu-toggle');
                            if (toggle) {
                                toggle.classList.add('rotated');
                            }
                        }
                    }
                    break;
                }
            }
            
            // 模块初始化
            if (moduleId === 'news_management') {
                initNewsManagement();
            } else if (moduleId === 'member_archive') {
                try {
                    if (typeof ensureMemberGradeYears === 'function') ensureMemberGradeYears();
                    if (typeof renderMemberNav === 'function') renderMemberNav();
                    if (typeof renderMemberAllSections === 'function') renderMemberAllSections();
                    if (typeof fillMemberCategorySelect === 'function') fillMemberCategorySelect();
                    if (typeof renderTeamMembers === 'function') renderTeamMembers();
                    var activeNav = document.querySelector('#member_archive .member-nav-item.active');
                    if (!activeNav) switchMemberCategory('all', document.querySelector('#member_archive .member-nav-item[data-category="all"]'));
                } catch (eMem) {}
            } else if (moduleId === 'literature_library') {
                try { if (typeof initLiteratureLibrary === 'function') initLiteratureLibrary(); } catch (eLit) {}
            } else if (moduleId === 'competition_management') {
                try { if (typeof initCompetitionManagement === 'function') initCompetitionManagement(); } catch (eCmp) {}
            } else if (moduleId === 'data_backup') {
                initBackupModule();
            } else if (moduleId === 'operation_log') {
                initOperationLogModule();
            } else if (moduleId === 'system_config') {
                initSystemConfigModule();
            }
        }

        document.addEventListener('keydown', function (e) {
            if (!(e.altKey && (e.key === 'ArrowLeft' || e.code === 'ArrowLeft'))) return;
            var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
            e.preventDefault();
            goBackModule();
        });
        document.addEventListener('DOMContentLoaded', function () {
            try { updateModuleBackButton(); } catch (eBack) {}
        });
        window.goBackModule = goBackModule;
        window.updateModuleBackButton = updateModuleBackButton;
        window.pushModuleHistory = pushModuleHistory;
        
        // 切换子菜单
        function toggleSubMenu(element) {
            const submenu = element.nextElementSibling;
            const toggle = element.querySelector('.submenu-toggle');
            
            if (submenu && submenu.classList.contains('submenu')) {
                submenu.classList.toggle('show');
                if (toggle) {
                    toggle.classList.toggle('rotated');
                }
            }
        }
        
        // 添加快速导航卡片的悬停效果
        document.addEventListener('DOMContentLoaded', function() {
            // 快速导航卡片悬停效果
            const navCards = document.querySelectorAll('.main-content .module.active .card:nth-child(2) .card:nth-child(2) div[style*="flex: 1; text-align: center"]');
            navCards.forEach(card => {
                card.addEventListener('mouseenter', function() {
                    this.style.transform = 'translateY(-5px)';
                    this.style.boxShadow = '0 8px 20px rgba(0,0,0,0.12)';
                    const icon = this.querySelector('div:nth-child(1)');
                    if (icon) {
                        icon.style.transform = 'scale(1.1)';
                    }
                    const text = this.querySelector('div:nth-child(2)');
                    if (text) {
                        text.style.color = '#8A2BE2';
                    }
                    const gradient = this.querySelector('div:nth-child(3)');
                    if (gradient) {
                        gradient.style.left = '100%';
                    }
                });
                
                card.addEventListener('mouseleave', function() {
                    this.style.transform = 'translateY(0)';
                    this.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)';
                    const icon = this.querySelector('div:nth-child(1)');
                    if (icon) {
                        icon.style.transform = 'scale(1)';
                    }
                    const text = this.querySelector('div:nth-child(2)');
                    if (text) {
                        text.style.color = '#333';
                    }
                    const gradient = this.querySelector('div:nth-child(3)');
                    if (gradient) {
                        gradient.style.left = '-100%';
                    }
                });
            });
            
            // 数据概览卡片悬停效果
            const dataCards = document.querySelectorAll('.main-content .module.active .card:nth-child(3) div[style*="grid-template-columns"] > div');
            dataCards.forEach(card => {
                card.addEventListener('mouseenter', function() {
                    this.style.transform = 'translateY(-5px)';
                    this.style.boxShadow = '0 8px 20px rgba(0,0,0,0.15)';
                    const icon = this.querySelector('div:nth-child(1) div:nth-child(2)');
                    if (icon) {
                        icon.style.transform = 'scale(1.1) rotate(5deg)';
                    }
                });
                
                card.addEventListener('mouseleave', function() {
                    this.style.transform = 'translateY(0)';
                    this.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)';
                    const icon = this.querySelector('div:nth-child(1) div:nth-child(2)');
                    if (icon) {
                        icon.style.transform = 'scale(1) rotate(0)';
                    }
                });
            });
            
            // 内容卡片悬停效果
            const contentCards = document.querySelectorAll('.main-content .module.active .card:nth-child(4) div[style*="grid-template-columns"] > div > div');
            contentCards.forEach(card => {
                card.addEventListener('mouseenter', function() {
                    this.style.transform = 'translateY(-3px)';
                    this.style.boxShadow = '0 6px 16px rgba(0,0,0,0.12)';
                });
                
                card.addEventListener('mouseleave', function() {
                    this.style.transform = 'translateY(0)';
                    this.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)';
                });
            });
        });
        
        // 显示标签页
        function showTab(tabId) {
            // 隐藏所有标签内容
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            
            // 显示选中标签内容
            document.getElementById(tabId).classList.add('active');
            
            // 更新标签状态
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            event.target.classList.add('active');
        }
        
        // 执行搜索
        function performSearch() {
            // 获取搜索条件
            const keyword = document.querySelector('#search input[type="text"]').value.toLowerCase();
            const startDate = document.querySelector('#search input[type="date"]:nth-child(1)').value;
            const endDate = document.querySelector('#search input[type="date"]:nth-child(3)').value;
            const patentType = document.querySelector('#search select').value;
            
            // 过滤专利数据
            let filteredPatents = patentData;
            
            // 按关键词过滤
            if (keyword) {
                filteredPatents = filteredPatents.filter(patent => 
                    patent.name.toLowerCase().includes(keyword) ||
                    patent.applicant.toLowerCase().includes(keyword) ||
                    patent.summary.toLowerCase().includes(keyword)
                );
            }
            
            // 按日期范围过滤
            if (startDate) {
                filteredPatents = filteredPatents.filter(patent => patent.applicationDate >= startDate);
            }
            if (endDate) {
                filteredPatents = filteredPatents.filter(patent => patent.applicationDate <= endDate);
            }
            
            // 按专利类型过滤
            if (patentType && patentType !== '请选择专利类型') {
                // 由于专利数据中没有type字段，这里使用分类来近似过滤
                filteredPatents = filteredPatents.filter(patent => {
                    if (patentType === '发明专利') {
                        return patent.name.includes('发明') || patent.summary.includes('发明');
                    } else if (patentType === '实用新型') {
                        return patent.name.includes('实用新型') || patent.summary.includes('实用新型');
                    } else if (patentType === '外观设计') {
                        return patent.name.includes('外观') || patent.name.includes('设计');
                    }
                    return true;
                });
            }
            
            // 更新搜索结果
            const searchResults = document.getElementById('searchResults');
            const tableBody = searchResults.querySelector('tbody');
            
            // 清空现有结果
            tableBody.innerHTML = '';
            
            // 添加过滤后的结果
            if (filteredPatents.length === 0) {
                const row = document.createElement('tr');
                row.innerHTML = '<td colspan="5" style="text-align: center; padding: 20px;">未找到符合条件的专利</td>';
                tableBody.appendChild(row);
            } else {
                filteredPatents.forEach(patent => {
                    // 从专利名称中提取申请人姓名
                    let applicant = patent.applicant;
                    if (applicant === '未知申请人' || !applicant) {
                        const match = patent.name.match(/_([^_]+)$/);
                        if (match) {
                            applicant = match[1];
                        }
                    }
                    
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${patent.name}</td>
                        <td>${applicant}</td>
                        <td>${patent.applicationDate}</td>
                        <td><span class="tag ${getTagClass(patent.status)}">${patent.status}</span></td>
                        <td><button class="btn" style="padding: 6px 12px; font-size: 12px;" onclick="viewPatent(${patent.id})")">查看</button></td>
                    `;
                    tableBody.appendChild(row);
                });
            }
            
            // 显示搜索结果
            searchResults.style.display = 'block';
        }
        
        // 获取标签样式类
        function getTagClass(status) {
            switch(status) {
                case '授权': return 'tag-success';
                case '实质审查': return 'tag-warning';
                case '公布': return 'tag-primary';
                case '无效': return 'tag-danger';
                default: return 'tag-default';
            }
        }
        
        // 查看专利详情
        function viewPatent(patentId) {
            // 查找专利
            const patent = patentData.find(p => p.id === patentId);
            if (!patent) return;
            
            // 从专利名称中提取申请人姓名
            let applicant = patent.applicant;
            if (applicant === '未知申请人' || !applicant) {
                const match = patent.name.match(/_([^_]+)$/);
                if (match) {
                    applicant = match[1];
                }
            }
            
            // 创建模态框
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 1000;
            `;
            
            // 创建模态框内容
            const modalContent = document.createElement('div');
            modalContent.style.cssText = `
                background: white;
                padding: 30px;
                border-radius: 8px;
                width: 80%;
                max-width: 800px;
                max-height: 80%;
                overflow-y: auto;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            `;
            
            // 填充专利详情
            modalContent.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h2>专利详情</h2>
                    <button style="background: #6c757d; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;" onclick="this.closest('.modal').remove()">关闭</button>
                </div>
                <div style="line-height: 1.8;">
                    <p><strong>专利名称：</strong>${patent.name}</p>
                    <p><strong>申请人：</strong>${applicant}</p>
                    <p><strong>申请日期：</strong>${patent.applicationDate}</p>
                    <p><strong>分类：</strong>${patent.classification}</p>
                    <p><strong>法律状态：</strong><span class="tag ${getTagClass(patent.status)}">${patent.status}</span></p>
                    <p><strong>摘要：</strong>${patent.summary}</p>
                </div>
            `;
            
            modalContent.className = 'modal-content';
            modal.className = 'modal';
            modal.appendChild(modalContent);
            document.body.appendChild(modal);
            
            // 点击模态框外部关闭
            modal.onclick = function(e) {
                if (e.target === modal) {
                    modal.remove();
                }
            };
        }
        
        // 自动分类功能
        function autoClassify() {
            // 分类规则 - 优化后的关键词和优先级
            const classificationRules = [
                {
                    name: '能源技术',
                    keywords: ['太阳能', '风能', '电力', '能源', '电池', '发电', '光伏', '新能源', '水电', '风电', '清洁能源', '储能', '氢能', '生物质能'],
                    priority: 1
                },
                {
                    name: '土木水利',
                    keywords: ['土木', '水利', '建筑', '结构', '工程', '施工', '混凝土', '钢筋', '桥梁', '隧道', '道路', '水坝', '地基', '桩基', '边坡'],
                    priority: 2
                },
                {
                    name: '城市安全',
                    keywords: ['安全', '预警', '监测', '巡检', '隐患', '事故', '应急', '消防', '防护', '风险', '灾害', '监测', '预警', '应急管理'],
                    priority: 3
                },
                {
                    name: '人工智能',
                    keywords: ['智能', 'AI', '人工智能', '机器学习', '深度学习', '神经网络', '算法', '数据', '模型', '识别', '预测', '自动化', '机器人'],
                    priority: 4
                }
            ];
            
            // 自动分类专利
            let classifiedCount = 0;
            
            patentData.forEach(patent => {
                const patentText = (patent.name + ' ' + patent.summary).toLowerCase();
                let bestMatch = null;
                let highestScore = 0;
                
                // 尝试匹配主分类，计算匹配得分
                for (const rule of classificationRules) {
                    const mainKeywords = rule.keywords.map(k => k.toLowerCase());
                    let matchCount = 0;
                    
                    // 计算匹配的关键词数量
                    for (const keyword of mainKeywords) {
                        if (patentText.includes(keyword)) {
                            matchCount++;
                        }
                    }
                    
                    // 计算得分：匹配数量 * 优先级权重
                    const score = matchCount * rule.priority;
                    
                    if (matchCount > 0 && score > highestScore) {
                        highestScore = score;
                        bestMatch = rule.name;
                    }
                }
                
                // 更新专利分类
                if (bestMatch) {
                    patent.classification = bestMatch;
                    classifiedCount++;
                } else {
                    patent.classification = '未分类';
                }
            });
            
            // 保存更新后的专利数据
            localStorage.setItem('patentData', JSON.stringify(patentData));
            
            // 更新专利列表
            updatePatentList();
            
            // 显示分类结果
            alert(`自动分类完成！共分类 ${classifiedCount} 个专利。`);
        }
        
        // 更新专利列表
        function updatePatentList() {
            const tableBody = document.querySelector('#classification table tbody');
            if (!tableBody) return;
            
            tableBody.innerHTML = '';
            
            patentData.forEach(patent => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${patent.name}</td>
                    <td>${patent.classification}</td>
                    <td>
                        <button class="btn" style="padding: 6px 12px; font-size: 12px;" onclick="alert('编辑功能待实现')">编辑</button>
                        <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px; margin-left: 5px;" onclick="deletePatent(this)">删除</button>
                    </td>
                `;
                tableBody.appendChild(row);
            });
        }
        
        // 一键全部删除专利
        function deleteAllPatents() {
            if (confirm('确定要删除所有专利吗？此操作不可恢复！')) {
                patentData = [];
                localStorage.setItem('patentData', JSON.stringify(patentData));
                updatePatentList();
                updateComparisonPatents();
                alert('所有专利已删除！');
            }
        }
        
        // 添加新分类
        function addNewCategory() {
            const categoryName = document.getElementById('newCategoryName').value.trim();
            if (!categoryName) {
                alert('请输入分类名称');
                return;
            }
            
            // 检查分类是否已存在
            const existingCategory = categoryData.find(cat => cat.name === categoryName && cat.parentId === 0);
            if (existingCategory) {
                alert('该分类已存在');
                return;
            }
            
            // 创建新分类
            const newId = categoryData.length > 0 ? Math.max(...categoryData.map(c => c.id)) + 1 : 1;
            const newCategory = {
                id: newId,
                name: categoryName,
                type: 'category',
                parentId: 0
            };
            
            categoryData.push(newCategory);
            localStorage.setItem('categoryData', JSON.stringify(categoryData));
            updateCategoryTree();
            
            // 清空输入框
            document.getElementById('newCategoryName').value = '';
            
            alert('分类添加成功！');
        }
        
        // 开始分析
        function startAnalysis() {
            const aiFileInput = document.getElementById('aiFileInput');
            
            // 检查是否有文件上传
            if (aiFileInput && aiFileInput.files.length > 0) {
                // 清空之前的分析结果
                const analysisResult = document.getElementById('analysisResult');
                analysisResult.innerHTML = '<h3>分析结果</h3>';
                
                // 分析每个文件
                for (let i = 0; i < aiFileInput.files.length; i++) {
                    // 创建文件分析结果容器
                    const fileAnalysis = document.createElement('div');
                    fileAnalysis.className = 'file-analysis';
                    fileAnalysis.style.marginBottom = '30px';
                    fileAnalysis.style.padding = '20px';
                    fileAnalysis.style.border = '1px solid #e9ecef';
                    fileAnalysis.style.borderRadius = '8px';
                    
                    // 添加文件名称
                    const fileName = document.createElement('h4');
                    fileName.textContent = aiFileInput.files[i].name;
                    fileAnalysis.appendChild(fileName);
                    
                    // 生成分析结果
                    const analysisContent = generateAnalysisResultForFile(aiFileInput.files[i]);
                    
                    // 添加分析结果
                    fileAnalysis.innerHTML += `
                        <div class="result-card">
                            <h4>专利摘要</h4>
                            <p>${analysisContent.summary}</p>
                        </div>
                        <div class="result-card">
                            <h4>关键技术点</h4>
                            <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                                ${analysisContent.keyTechPoints.map(point => `<span class="tag tag-primary">${point}</span>`).join('')}
                            </div>
                        </div>
                        <div class="result-card">
                            <h4>创新点</h4>
                            <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                                ${analysisContent.innovations.map(innovation => `<span class="tag tag-success">${innovation}</span>`).join('')}
                            </div>
                        </div>
                        <div class="result-card">
                            <h4>法律状态</h4>
                            <div style="display: flex; justify-content: space-between;">
                                <div>
                                    <p><strong>状态：</strong>${analysisContent.legalStatus.status}</p>
                                    <p><strong>专利号：</strong>${analysisContent.legalStatus.patentNumber}</p>
                                </div>
                                <button class="btn" onclick="saveAnalysisResult()">💾 保存结果</button>
                            </div>
                        </div>
                    `;
                    
                    // 添加到分析结果容器
                    analysisResult.appendChild(fileAnalysis);
                }
                
                // 显示分析结果
                analysisResult.style.display = 'block';
                
                // 滚动到分析结果
                analysisResult.scrollIntoView({ behavior: 'smooth' });
            } else {
                alert('请上传文件进行分析');
            }
        }
        
        // 为单个文件生成分析结果
        function generateAnalysisResultForFile(file) {
            let analysisContent = {
                summary: '',
                keyTechPoints: [],
                innovations: [],
                legalStatus: {
                    status: '已公开',
                    patentNumber: 'CN' + Math.floor(Math.random() * 1000000000).toString().padStart(9, '0'),
                    applicationDate: new Date().toISOString().split('T')[0],
                    publicationDate: new Date().toISOString().split('T')[0],
                    expirationDate: new Date(new Date().getFullYear() + 20, new Date().getMonth(), new Date().getDate()).toISOString().split('T')[0]
                }
            };
            
            const fileName = file.name;
            
            // 改进的关键词识别和分析逻辑
            if (fileName.includes('FRP') || fileName.includes('钢筋') || fileName.includes('混凝土') || fileName.includes('抗震')) {
                analysisContent.summary = '本专利涉及FRP网格加固钢筋混凝土柱的抗震性能研究，通过实验分析和数值模拟，提出了一种新型的加固方法，显著提高了混凝土柱的抗震能力，具有重要的工程应用价值。';
                analysisContent.keyTechPoints = [
                    'FRP网格加固技术',
                    '钢筋混凝土柱抗震性能',
                    '实验分析方法',
                    '数值模拟技术',
                    '加固施工工艺'
                ];
                analysisContent.innovations = [
                    '提出了新型FRP网格加固方案',
                    '优化了加固施工工艺，提高施工效率',
                    '显著提高了混凝土柱的抗震性能',
                    '降低了加固成本，提高经济效益',
                    '建立了抗震性能评估模型'
                ];
            } else if (fileName.includes('太阳能') || fileName.includes('电池')) {
                analysisContent.summary = '本专利涉及一种新型太阳能电池技术，通过优化材料结构和制造工艺，显著提高了能量转换效率，降低了生产成本，具有广阔的应用前景。';
                analysisContent.keyTechPoints = [
                    '太阳能电池材料优化',
                    '能量转换效率提升技术',
                    '新型电极结构设计',
                    '光捕获增强技术',
                    '低成本制造工艺'
                ];
                analysisContent.innovations = [
                    '采用新型纳米材料提高光电转换效率20%以上',
                    '优化电池结构减少能量损失15%',
                    '开发低成本制造工艺，降低成本30%',
                    '延长电池使用寿命至15年',
                    '提高了电池在低光照条件下的性能'
                ];
            } else if (fileName.includes('无人机') || fileName.includes('UAV')) {
                analysisContent.summary = '本专利涉及无人机在特定领域的应用技术，通过自主导航、智能避障和数据采集等功能，实现了高效的监测和巡检任务，具有重要的应用价值。';
                analysisContent.keyTechPoints = [
                    '无人机自主导航技术',
                    '智能避障系统',
                    '多传感器数据采集',
                    '实时图像处理',
                    '远程控制与通信'
                ];
                analysisContent.innovations = [
                    '开发了基于视觉的自主导航算法',
                    '实现了复杂环境下的智能避障',
                    '集成多传感器数据融合系统',
                    '提高了数据采集效率和准确性',
                    '优化了电池续航能力'
                ];
            } else if (fileName.includes('AI') || fileName.includes('人工智能') || fileName.includes('智能')) {
                analysisContent.summary = '本专利涉及人工智能技术在特定领域的应用，通过机器学习、深度学习等算法，实现了智能分析和自动化处理，提高了系统的智能化水平。';
                analysisContent.keyTechPoints = [
                    '机器学习算法',
                    '深度学习模型',
                    '数据采集与处理',
                    '智能决策系统',
                    '模型训练与优化'
                ];
                analysisContent.innovations = [
                    '提出了新型机器学习算法，提高分析准确率',
                    '设计了轻量化深度学习模型，降低计算成本',
                    '开发了实时数据处理系统，提高响应速度',
                    '实现了自适应学习能力，持续优化性能',
                    '解决了传统方法难以处理的复杂问题'
                ];
            } else if (fileName.includes('监测') || fileName.includes('预警') || fileName.includes('安全')) {
                analysisContent.summary = '本专利涉及安全监测和预警技术，通过传感器网络、数据采集和智能分析，实现了对特定目标的实时监测和异常预警，提高了安全管理水平。';
                analysisContent.keyTechPoints = [
                    '传感器网络布局',
                    '实时数据采集',
                    '智能分析算法',
                    '预警机制',
                    '应急响应系统'
                ];
                analysisContent.innovations = [
                    '优化了传感器网络布局，提高监测覆盖范围',
                    '开发了低功耗数据传输协议，延长设备寿命',
                    '设计了智能异常检测算法，提高预警准确率',
                    '建立了多级预警机制，实现精准预警',
                    '集成了应急响应系统，提高处理效率'
                ];
            } else {
                // 基于文件名字词分析生成更具体的结果
                const nameWords = fileName.replace(/\.[^/.]+$/, '').split(/[_\s]+/);
                const keyWords = nameWords.filter(word => word.length > 2);
                
                analysisContent.summary = `本专利涉及${keyWords.join('、')}等相关技术，通过创新的技术方案解决了现有技术中的关键问题，具有重要的技术价值和广阔的应用前景。`;
                analysisContent.keyTechPoints = [
                    `${keyWords[0]}核心技术`,
                    `${keyWords.length > 1 ? keyWords[1] : '系统'}优化设计`,
                    '创新实现方法',
                    '应用场景拓展',
                    '性能优化技术'
                ];
                analysisContent.innovations = [
                    `提出了基于${keyWords[0]}的创新技术方案`,
                    `优化了${keyWords.length > 1 ? keyWords[1] : '系统'}的性能指标`,
                    '开发了低成本高效率的实现方法',
                    '拓展了应用场景和适用范围',
                    '解决了行业内长期存在的技术难题'
                ];
            }
            
            return analysisContent;
        }
        
        // 生成分析结果
        function generateAnalysisResult(aiFileInput, existingPatent, textInput) {
            let analysisContent = {
                summary: '',
                keyTechPoints: [],
                innovations: [],
                legalStatus: {
                    status: '已公开',
                    patentNumber: 'CN' + Math.floor(Math.random() * 1000000000).toString().padStart(9, '0'),
                    applicationDate: new Date().toISOString().split('T')[0],
                    publicationDate: new Date().toISOString().split('T')[0],
                    expirationDate: new Date(new Date().getFullYear() + 20, new Date().getMonth(), new Date().getDate()).toISOString().split('T')[0]
                }
            };
            
            // 根据文件生成分析结果
            if (aiFileInput && aiFileInput.files.length > 0) {
                const file = aiFileInput.files[0];
                const fileName = file.name;
                
                if (fileName.includes('FRP') || fileName.includes('钢筋') || fileName.includes('混凝土') || fileName.includes('抗震')) {
                    analysisContent.summary = '本专利涉及FRP网格加固钢筋混凝土柱的抗震性能研究，通过实验分析和数值模拟，提出了一种新型的加固方法，显著提高了混凝土柱的抗震能力，具有重要的工程应用价值。';
                    analysisContent.keyTechPoints = [
                        'FRP网格加固技术',
                        '钢筋混凝土柱抗震性能',
                        '实验分析方法',
                        '数值模拟技术'
                    ];
                    analysisContent.innovations = [
                        '提出了新型FRP网格加固方案',
                        '优化了加固施工工艺',
                        '提高了混凝土柱的抗震性能',
                        '降低了加固成本'
                    ];
                } else if (fileName.includes('太阳能') || fileName.includes('电池')) {
                    analysisContent.summary = '本专利涉及一种新型太阳能电池技术，通过优化材料结构和制造工艺，显著提高了能量转换效率，降低了生产成本，具有广阔的应用前景。';
                    analysisContent.keyTechPoints = [
                        '太阳能电池材料优化',
                        '能量转换效率提升技术',
                        '新型电极结构设计',
                        '光捕获增强技术'
                    ];
                    analysisContent.innovations = [
                        '采用新型纳米材料提高光电转换效率',
                        '优化电池结构减少能量损失',
                        '开发低成本制造工艺',
                        '延长电池使用寿命'
                    ];
                } else {
                    // 通用分析结果
                    analysisContent.summary = `本专利涉及${fileName.replace(/\.[^/.]+$/, '')}相关技术，通过创新的技术方案，解决了现有技术中的问题，具有重要的技术价值和应用前景。`;
                    analysisContent.keyTechPoints = [
                        '核心技术点1',
                        '核心技术点2',
                        '核心技术点3',
                        '核心技术点4'
                    ];
                    analysisContent.innovations = [
                        '创新点1',
                        '创新点2',
                        '创新点3',
                        '创新点4'
                    ];
                }
            } else {
                // 通用分析结果
                analysisContent.summary = '本专利涉及相关技术创新，通过独特的技术方案解决了现有技术中的关键问题，具有重要的技术价值和广阔的应用前景。';
                analysisContent.keyTechPoints = [
                    '核心技术原理',
                    '创新实现方法',
                    '系统优化设计',
                    '应用场景拓展'
                ];
                analysisContent.innovations = [
                    '技术创新点1',
                    '技术创新点2',
                    '技术创新点3',
                    '技术创新点4'
                ];
            }
            
            // 更新分析结果
            document.getElementById('summaryResult').textContent = analysisContent.summary;
            
            const keyTechPointsContainer = document.getElementById('techPoints');
            keyTechPointsContainer.innerHTML = '';
            analysisContent.keyTechPoints.forEach(point => {
                const tag = document.createElement('span');
                tag.className = 'tag tag-primary';
                tag.textContent = point;
                keyTechPointsContainer.appendChild(tag);
            });
            
            const innovationsContainer = document.getElementById('innovations');
            innovationsContainer.innerHTML = '';
            analysisContent.innovations.forEach(innovation => {
                const tag = document.createElement('span');
                tag.className = 'tag tag-success';
                tag.textContent = innovation;
                innovationsContainer.appendChild(tag);
            });
            
            document.getElementById('legalStatus').textContent = analysisContent.legalStatus.status;
            document.getElementById('patentNumber').textContent = analysisContent.legalStatus.patentNumber;
        }
        
        // 清空所有数据
        function clearAllData() {
            if (confirm('确定要清空所有专利和分类数据吗？此操作不可恢复！')) {
                localStorage.removeItem('patentData');
                localStorage.removeItem('categoryData');
                patentData = [];
                categoryData = [];
                updatePatentList();
                updateComparisonPatents();
                updateCategoryTree();
                alert('所有数据已清空！');
            }
        }
        
        // 添加成员
        function addMember() {
            const memberName = prompt('请输入成员姓名：');
            if (!memberName) return;
            
            const memberPosition = prompt('请输入成员职位：');
            const memberField = prompt('请输入研究方向：');
            const memberEmail = prompt('请输入邮箱：');
            const memberPhone = prompt('请输入电话：');
            
            // 创建新成员对象
            const newMember = {
                name: memberName,
                position: memberPosition || '未填写',
                field: memberField || '未填写',
                email: memberEmail || '未填写',
                phone: memberPhone || '未填写'
            };
            
            // 获取现有成员数据或创建新数组
            let memberData = JSON.parse(localStorage.getItem('memberData') || '[]');
            memberData.push(newMember);
            
            // 保存到本地存储
            localStorage.setItem('memberData', JSON.stringify(memberData));
            
            alert('成员添加成功！');
        }
        
        // 导出成员数据
        function exportMemberData() {
            // 获取成员数据
            let memberData = JSON.parse(localStorage.getItem('memberData') || '[]');
            
            // 如果没有成员数据，提示用户
            if (memberData.length === 0) {
                alert('没有成员数据可导出！');
                return;
            }
            
            // 生成CSV格式数据
            let csvContent = '姓名,职位,研究方向,邮箱,电话\n';
            memberData.forEach(member => {
                csvContent += `"${member.name}","${member.position}","${member.field}","${member.email}","${member.phone}"\n`;
            });
            
            // 创建Blob对象
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            
            // 创建下载链接
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', `团队成员数据_${new Date().toISOString().split('T')[0]}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            alert('成员数据导出成功！');
        }
        
        // 开始对比
        function startComparison() {
            const patentSelect = document.querySelector('#comparison select');
            const selectedOptions = Array.from(patentSelect.selectedOptions);
            
            if (selectedOptions.length < 2) {
                alert('请至少选择两个专利进行对比');
                return;
            }
            
            // 获取选择的专利
            const selectedPatents = selectedOptions.map(option => {
                const patentId = parseInt(option.value);
                return patentData.find(patent => patent.id === patentId);
            }).filter(Boolean);
            
            if (selectedPatents.length < 2) {
                alert('无法找到选中的专利数据');
                return;
            }
            
            // 处理专利数据
            const processedPatents = selectedPatents.map(patent => {
                return {
                    ...patent,
                    processedName: extractPatentName(patent.name),
                    processedApplicant: extractApplicant(patent.name, patent.applicant),
                    processedTech: generateTechSummary(patent.summary, patent.name)
                };
            });
            
            // 生成对比结果
            const comparisonResult = document.getElementById('comparisonResult');
            const table = comparisonResult.querySelector('table');
            
            // 更新表头
            const thead = table.querySelector('thead tr');
            thead.innerHTML = '<th>对比维度</th>';
            processedPatents.forEach(patent => {
                const th = document.createElement('th');
                th.textContent = patent.processedName;
                thead.appendChild(th);
            });
            
            // 更新表格内容
            const tbody = table.querySelector('tbody');
            tbody.innerHTML = '';
            
            // 专利名称
            const nameRow = document.createElement('tr');
            nameRow.innerHTML = '<td><strong>专利名称</strong></td>';
            processedPatents.forEach(patent => {
                const td = document.createElement('td');
                td.textContent = patent.processedName;
                nameRow.appendChild(td);
            });
            tbody.appendChild(nameRow);
            
            // 申请人（可选显示）
            const showApplicant = document.getElementById('dim2').checked;
            if (showApplicant) {
                const applicantRow = document.createElement('tr');
                applicantRow.innerHTML = '<td><strong>申请人</strong></td>';
                processedPatents.forEach(patent => {
                    const td = document.createElement('td');
                    td.textContent = patent.processedApplicant;
                    applicantRow.appendChild(td);
                });
                tbody.appendChild(applicantRow);
            }
            
            // 申请日期（可选显示）
            const showDate = document.getElementById('dim3').checked;
            if (showDate) {
                const dateRow = document.createElement('tr');
                dateRow.innerHTML = '<td><strong>申请日期</strong></td>';
                processedPatents.forEach(patent => {
                    const td = document.createElement('td');
                    td.textContent = patent.applicationDate || '未知日期';
                    dateRow.appendChild(td);
                });
                tbody.appendChild(dateRow);
            }
            
            // 技术方案
            const techRow = document.createElement('tr');
            techRow.innerHTML = '<td><strong>技术方案</strong></td>';
            processedPatents.forEach(patent => {
                const td = document.createElement('td');
                td.textContent = patent.processedTech;
                td.title = patent.summary;
                td.style.maxWidth = '300px';
                td.style.wordBreak = 'break-word';
                techRow.appendChild(td);
            });
            tbody.appendChild(techRow);
            
            // 创新点
            const innovationRow = document.createElement('tr');
            innovationRow.innerHTML = '<td><strong>创新点</strong></td>';
            processedPatents.forEach(patent => {
                const td = document.createElement('td');
                // 基于专利名称和摘要生成创新点
                let innovation = generateInnovationPoint(patent.name, patent.summary);
                td.textContent = innovation;
                td.style.maxWidth = '300px';
                td.style.wordBreak = 'break-word';
                innovationRow.appendChild(td);
            });
            tbody.appendChild(innovationRow);
            
            // 差异分析
            if (processedPatents.length === 2) {
                const diffRow = document.createElement('tr');
                diffRow.innerHTML = '<td><strong>主要差异</strong></td>';
                
                // 生成差异分析
                const diff1 = generateDifference(processedPatents[0], processedPatents[1], 1);
                const diff2 = generateDifference(processedPatents[1], processedPatents[0], 2);
                
                const td1 = document.createElement('td');
                td1.textContent = diff1;
                td1.style.maxWidth = '300px';
                td1.style.wordBreak = 'break-word';
                diffRow.appendChild(td1);
                
                const td2 = document.createElement('td');
                td2.textContent = diff2;
                td2.style.maxWidth = '300px';
                td2.style.wordBreak = 'break-word';
                diffRow.appendChild(td2);
                
                tbody.appendChild(diffRow);
            }
            
            // 法律状态
            const statusRow = document.createElement('tr');
            statusRow.innerHTML = '<td><strong>法律状态</strong></td>';
            processedPatents.forEach(patent => {
                const td = document.createElement('td');
                let tagClass = 'tag-success';
                if (patent.status === '审查中') tagClass = 'tag-warning';
                if (patent.status === '已授权') tagClass = 'tag-primary';
                td.innerHTML = `<span class="tag ${tagClass}">${patent.status}</span>`;
                statusRow.appendChild(td);
            });
            tbody.appendChild(statusRow);
            
            // 显示对比结果
            comparisonResult.style.display = 'block';
            comparisonResult.scrollIntoView({ behavior: 'smooth' });
        }
        
        // 提取专利名称（去除姓名）
        function extractPatentName(originalName) {
            // 去除文件扩展名
            let name = originalName.replace(/\.pdf$/, '');
            
            // 去除姓名部分（匹配常见的姓名模式）
            name = name.replace(/[_\s]*[\u4e00-\u9fa5]{2,4}$/, '');
            name = name.replace(/[_\s]*[\u4e00-\u9fa5]{2,4}\s*$/, '');
            
            // 去除"的应用"等后缀
            name = name.replace(/的应用$/, '');
            name = name.replace(/的运用$/, '');
            
            return name;
        }
        
        // 提取申请人
        function extractApplicant(originalName, currentApplicant) {
            // 如果已有申请人信息，直接使用
            if (currentApplicant && currentApplicant !== '未知申请人') {
                return currentApplicant;
            }
            
            // 从文件名中提取申请人
            let name = originalName.replace(/\.pdf$/, '');
            
            // 匹配"名称_申请人"格式
            const underScoreMatch = name.match(/_(.+)$/);
            if (underScoreMatch && underScoreMatch[1]) {
                const applicant = underScoreMatch[1].trim();
                // 确保提取的是中文姓名（2-4个汉字）
                if (/^[\u4e00-\u9fa5]{2,4}$/.test(applicant)) {
                    return applicant;
                }
            }
            
            // 匹配文件名末尾的姓名
            const nameMatch = name.match(/[_\s]*([\u4e00-\u9fa5]{2,4})$/);
            if (nameMatch && nameMatch[1]) {
                return nameMatch[1];
            }
            
            return '未知申请人';
        }
        
        // 生成技术方案摘要
        function generateTechSummary(originalSummary, patentName) {
            // 如果摘要已经很详细，直接使用
            if (originalSummary.length > 100) {
                return originalSummary.substring(0, 100) + '...';
            }
            
            // 结合专利名称和摘要生成更详细的技术方案描述
            const fullText = (patentName + ' ' + originalSummary).toLowerCase();
            
            if (fullText.includes('无人机') && fullText.includes('智慧工地')) {
                return '本技术方案涉及无人机在智慧工地中的应用，通过无人机航拍、实时图像处理和AI分析，实现工地施工监测、进度管理、质量控制和安全预警，提高施工效率和安全性。系统包括无人机平台、传感器网络、数据处理中心和可视化界面，形成完整的智慧工地管理体系。';
            } else if (fullText.includes('无人机') && fullText.includes('环境监测')) {
                return '本技术方案涉及无人机在矿山生态环境监测中的应用，通过无人机航拍、多光谱成像和激光雷达技术，实现对矿山环境的实时监测、数据分析和变化趋势预测，为生态环境保护和恢复提供科学依据。系统具有自主导航、智能避障和数据自动处理功能。';
            } else if (fullText.includes('ai') || fullText.includes('人工智能')) {
                return '本技术方案利用人工智能技术，包括机器学习、深度学习和计算机视觉等算法，实现特定领域的智能分析、自动化处理和智能决策，提高系统的自动化和智能化水平。系统采用模块化设计，具有良好的扩展性和适应性。';
            } else if (fullText.includes('监测') || fullText.includes('预警')) {
                return '本技术方案通过传感器网络、数据采集系统和智能分析算法，实现对特定目标的实时监测、数据分析和异常预警，及时发现和处理潜在问题。系统具有高精度、低功耗和高可靠性的特点，适用于复杂环境下的监测需求。';
            } else if (fullText.includes('安全')) {
                return '本技术方案关注安全管理和风险防控，通过多层次安全防护体系、风险评估模型和应急响应机制，提高系统的安全性和可靠性，保障人员和设备的安全。系统采用先进的安全技术和管理方法，实现全面的安全保障。';
            } else if (fullText.includes('太阳能') || fullText.includes('电池')) {
                return '本技术方案涉及太阳能电池技术的创新，通过材料优化、结构设计和制造工艺改进，提高能量转换效率，降低生产成本，延长使用寿命。系统包括电池核心技术、生产工艺和应用系统，形成完整的技术体系。';
            } else if (fullText.includes('FRP') || fullText.includes('钢筋') || fullText.includes('混凝土')) {
                return '本技术方案涉及土木工程领域的结构加固和优化技术，通过新型材料应用、结构设计改进和施工工艺创新，提高工程结构的安全性、耐久性和经济性。系统包括材料研发、结构设计和施工技术，形成完整的技术解决方案。';
            } else {
                // 基于专利名称分析生成技术方案
                const nameWords = patentName.split(/[_\s]+/);
                const keyWords = nameWords.filter(word => word.length > 2);
                return `本技术方案涉及${keyWords.join('、')}等相关技术，通过创新的技术原理、实现方法和系统设计，解决了现有技术中的关键问题，提高了系统性能和应用价值。技术方案包括核心技术模块、系统集成和应用场景，形成完整的技术体系。`;
            }
        }
        
        // 生成创新点
        function generateInnovationPoint(patentName, patentSummary) {
            const text = (patentName + ' ' + patentSummary).toLowerCase();
            
            if (text.includes('无人机') && text.includes('智慧工地')) {
                return '创新点：1. 提出了基于视觉的无人机智能导航与避障技术，实现复杂工地环境下的自主飞行；2. 开发了实时施工进度监测与质量评估算法，提高施工管理效率；3. 设计了多源数据融合与分析系统，实现工地信息的全面感知和智能决策；4. 构建了工地安全预警机制，降低施工风险。';
            } else if (text.includes('无人机') && text.includes('环境监测')) {
                return '创新点：1. 开发了无人机在矿山环境的精准监测技术，提高数据采集的准确性和效率；2. 提出了多光谱成像与环境参数分析算法，实现环境指标的精准评估；3. 设计了生态环境变化趋势预测模型，为环境管理提供科学依据；4. 构建了无人机自主作业系统，减少人工干预，提高监测覆盖范围。';
            } else if (text.includes('ai') || text.includes('人工智能')) {
                return '创新点：1. 提出了基于深度学习的智能分析算法，提高数据处理的准确性和效率；2. 开发了实时数据处理与决策系统，实现快速响应和智能决策；3. 设计了自适应学习能力，使系统能够不断优化和提升性能；4. 构建了模块化AI系统架构，提高系统的可扩展性和适应性。';
            } else if (text.includes('监测') || text.includes('预警')) {
                return '创新点：1. 优化了高精度传感器网络布局，提高监测覆盖范围和数据质量；2. 开发了低功耗数据传输与处理技术，延长设备使用寿命；3. 设计了智能预警算法，提高预警的准确性和及时性；4. 构建了多级预警机制，实现精准预警和分级响应。';
            } else if (text.includes('安全')) {
                return '创新点：1. 构建了多层次安全防护体系，实现全面的安全保障；2. 开发了风险评估与预测模型，提高风险识别和防控能力；3. 设计了快速应急响应机制，提高突发事件的处理效率；4. 提出了安全管理智能化方案，实现安全管理的自动化和精细化。';
            } else if (text.includes('太阳能') || text.includes('电池')) {
                return '创新点：1. 采用新型纳米材料提高光电转换效率，突破传统电池的性能瓶颈；2. 优化了电池结构设计，减少能量损失，提高能量利用率；3. 开发了低成本制造工艺，降低生产成本，提高市场竞争力；4. 设计了电池寿命延长技术，提高产品的使用寿命和可靠性。';
            } else if (text.includes('FRP') || text.includes('钢筋') || text.includes('混凝土')) {
                return '创新点：1. 提出了新型FRP网格加固方案，提高混凝土结构的抗震性能；2. 优化了加固施工工艺，提高施工效率和质量；3. 开发了结构性能评估模型，实现加固效果的精准预测；4. 设计了低成本高效的加固材料，提高技术的经济性和可推广性。';
            } else {
                // 基于专利名称分析生成创新点
                const nameWords = patentName.split(/[_\s]+/);
                const keyWord = nameWords.find(word => word.length > 2) || '技术';
                return `创新点：1. 提出了基于${keyWord}的核心技术创新，解决了行业内长期存在的技术难题；2. 开发了优化的系统集成方案，提高系统性能和可靠性；3. 设计了创新的实现方法，降低成本，提高效率；4. 拓展了应用场景，扩大技术的适用范围和市场潜力。`;
            }
        }
        
        // 生成差异分析
        function generateDifference(patent1, patent2, position) {
            const name1 = patent1.processedName;
            const name2 = patent2.processedName;
            const summary1 = patent1.summary;
            const summary2 = patent2.summary;
            
            // 提取技术架构关键词
            function extractTechArchitecture(text) {
                const architectures = [];
                if (text.includes('U-Net')) architectures.push('U-Net');
                if (text.includes('YOLO')) architectures.push('YOLO');
                if (text.includes('YOLOv8')) architectures.push('YOLOv8');
                if (text.includes('改进YOLO')) architectures.push('改进YOLO');
                if (text.includes('深度学习')) architectures.push('深度学习');
                if (text.includes('机器学习')) architectures.push('机器学习');
                return architectures;
            }
            
            // 提取应用场景关键词
            function extractApplicationScenario(text) {
                const scenarios = [];
                if (text.includes('公路')) scenarios.push('公路');
                if (text.includes('裂缝')) scenarios.push('裂缝检测');
                if (text.includes('目标检测')) scenarios.push('目标检测');
                if (text.includes('图像')) scenarios.push('图像处理');
                if (text.includes('航拍')) scenarios.push('航拍');
                return scenarios;
            }
            
            // 提取两个专利的技术架构和应用场景
            const arch1 = extractTechArchitecture(name1 + ' ' + summary1);
            const arch2 = extractTechArchitecture(name2 + ' ' + summary2);
            const scenario1 = extractApplicationScenario(name1 + ' ' + summary1);
            const scenario2 = extractApplicationScenario(name2 + ' ' + summary2);
            
            // 找出差异点
            const uniqueArch1 = arch1.filter(a => !arch2.includes(a));
            const uniqueArch2 = arch2.filter(a => !arch1.includes(a));
            const uniqueScenario1 = scenario1.filter(s => !scenario2.includes(s));
            const uniqueScenario2 = scenario2.filter(s => !scenario1.includes(s));
            
            if (position === 1) {
                // 分析第一个专利的特点
                if (uniqueArch1.length > 0 || uniqueScenario1.length > 0) {
                    let differences = [];
                    
                    // 技术架构差异
                    if (uniqueArch1.length > 0) {
                        differences.push(`采用${uniqueArch1.join('、')}架构，在算法性能和准确性方面有独特优势`);
                    }
                    
                    // 应用场景差异
                    if (uniqueScenario1.length > 0) {
                        differences.push(`专注于${uniqueScenario1.join('、')}领域，在特定场景的应用效果方面有独特优势`);
                    }
                    
                    if (differences.length > 0) {
                        return `与对比专利相比，本专利${differences.join('，')}，通过创新的技术方案解决了特定领域的关键问题。`;
                    }
                }
                
                // 基于专利名称的具体差异
                if (name1.includes('U-Net') && name2.includes('YOLO')) {
                    return '与对比专利相比，本专利采用U-Net架构，更适合处理图像分割任务如公路裂缝检测，在像素级精度方面具有优势。';
                } else if (name1.includes('YOLO') && name2.includes('U-Net')) {
                    return '与对比专利相比，本专利采用YOLO架构，更适合处理目标检测任务，在实时性和多目标检测方面具有优势。';
                } else if (name1.includes('公路') && !name2.includes('公路')) {
                    return '与对比专利相比，本专利专注于公路场景的图像处理，在公路裂缝检测等特定应用方面有独特优势。';
                } else if (name1.includes('裂缝') && !name2.includes('裂缝')) {
                    return '与对比专利相比，本专利专注于裂缝检测任务，在缺陷识别和定位方面有独特优势。';
                } else if (name1.includes('目标检测') && !name2.includes('目标检测')) {
                    return '与对比专利相比，本专利专注于目标检测任务，在多目标识别和实时处理方面有独特优势。';
                }
                
                // 基于摘要长度的差异
                if (summary1.length > summary2.length) {
                    return '与对比专利相比，本专利技术方案更加全面和深入，在技术实现细节和应用场景方面有更详细的描述和创新。';
                } else {
                    return '与对比专利相比，本专利在技术理念和创新思路方面有独特的见解，通过不同的技术路径实现了类似的目标。';
                }
            } else {
                // 分析第二个专利的特点
                if (uniqueArch2.length > 0 || uniqueScenario2.length > 0) {
                    let differences = [];
                    
                    // 技术架构差异
                    if (uniqueArch2.length > 0) {
                        differences.push(`采用${uniqueArch2.join('、')}架构，在算法性能和准确性方面有独特优势`);
                    }
                    
                    // 应用场景差异
                    if (uniqueScenario2.length > 0) {
                        differences.push(`专注于${uniqueScenario2.join('、')}领域，在特定场景的应用效果方面有独特优势`);
                    }
                    
                    if (differences.length > 0) {
                        return `与对比专利相比，本专利${differences.join('，')}，通过创新的技术方案解决了特定领域的关键问题。`;
                    }
                }
                
                // 基于专利名称的具体差异
                if (name2.includes('U-Net') && name1.includes('YOLO')) {
                    return '与对比专利相比，本专利采用U-Net架构，更适合处理图像分割任务如公路裂缝检测，在像素级精度方面具有优势。';
                } else if (name2.includes('YOLO') && name1.includes('U-Net')) {
                    return '与对比专利相比，本专利采用YOLO架构，更适合处理目标检测任务，在实时性和多目标检测方面具有优势。';
                } else if (name2.includes('公路') && !name1.includes('公路')) {
                    return '与对比专利相比，本专利专注于公路场景的图像处理，在公路裂缝检测等特定应用方面有独特优势。';
                } else if (name2.includes('裂缝') && !name1.includes('裂缝')) {
                    return '与对比专利相比，本专利专注于裂缝检测任务，在缺陷识别和定位方面有独特优势。';
                } else if (name2.includes('目标检测') && !name1.includes('目标检测')) {
                    return '与对比专利相比，本专利专注于目标检测任务，在多目标识别和实时处理方面有独特优势。';
                }
                
                // 基于摘要长度的差异
                if (summary2.length > summary1.length) {
                    return '与对比专利相比，本专利技术方案更加全面和深入，在技术实现细节和应用场景方面有更详细的描述和创新。';
                } else {
                    return '与对比专利相比，本专利在技术理念和创新思路方面有独特的见解，通过不同的技术路径实现了类似的目标。';
                }
            }
        }
        
        // 导出对比结果
        function exportComparisonResult() {
            const comparisonResult = document.getElementById('comparisonResult');
            if (!comparisonResult || comparisonResult.style.display === 'none') {
                alert('请先生成对比结果');
                return;
            }
            
            // 获取对比表格内容
            const table = comparisonResult.querySelector('table');
            if (!table) {
                alert('未找到对比结果表格');
                return;
            }
            
            // 构建CSV内容
            let csvContent = '对比维度,';
            const headers = table.querySelectorAll('thead th');
            const headerTexts = [];
            headers.forEach((th, index) => {
                if (index > 0) {
                    headerTexts.push(th.textContent.trim());
                }
            });
            csvContent += headerTexts.join(',') + '\n';
            
            // 添加表格数据
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                const rowData = [];
                cells.forEach(cell => {
                    // 移除HTML标签，只保留文本内容
                    const text = cell.textContent.trim().replace(/,/g, '，');
                    rowData.push(text);
                });
                csvContent += rowData.join(',') + '\n';
            });
            
            // 创建并下载文件
            const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', '专利对比结果_' + new Date().toISOString().split('T')[0] + '.csv');
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            alert('对比结果已导出为CSV文件！');
        }
        
        // 初始化文献选择下拉框
        function initPatentSelect() {
            const patentSelect = document.getElementById('patentSelect');
            if (!patentSelect) return;
            
            // 清空现有选项
            patentSelect.innerHTML = '<option value="">全部文献</option>';
            
            // 添加专利选项
            patentData.forEach(patent => {
                const option = document.createElement('option');
                option.value = patent.id;
                option.textContent = patent.name;
                patentSelect.appendChild(option);
            });
        }
        
        // 生成趋势图
        function generateTrend() {
            const analysisDimension = document.getElementById('analysisDimension').value;
            const chartType = document.getElementById('chartType').value;
            const startDate = document.getElementById('startDate').value;
            const endDate = document.getElementById('endDate').value;
            
            // 获取选择的文献
            const patentSelect = document.getElementById('patentSelect');
            const selectedPatentIds = Array.from(patentSelect.selectedOptions)
                .map(option => option.value)
                .filter(value => value !== '');
            
            // 筛选专利数据
            let filteredPatents = patentData;
            if (selectedPatentIds.length > 0) {
                filteredPatents = patentData.filter(patent => 
                    selectedPatentIds.includes(patent.id.toString())
                );
            }
            
            // 生成模拟数据
            const trendData = generateTrendData(analysisDimension, startDate, endDate, filteredPatents);
            
            // 显示结果区域
            const trendResult = document.getElementById('trendResult');
            trendResult.style.display = 'block';
            
            // 清空现有图表
            const chartContainer = document.getElementById('chartContainer');
            chartContainer.innerHTML = '';
            
            // 创建图表容器
            const canvas = document.createElement('canvas');
            canvas.id = 'trendChart';
            canvas.width = 800;
            canvas.height = 400;
            chartContainer.appendChild(canvas);
            
            // 生成图表
            renderChart(chartType, trendData, analysisDimension);
            
            // 显示分析报告
            generateAnalysisReport(trendData, analysisDimension);
        }
        
        // 生成趋势数据
        function generateTrendData(dimension, startDate, endDate, filteredPatents = patentData) {
            // 基于专利数据生成趋势数据
            const data = {
                labels: [],
                datasets: []
            };
            
            // 根据分析维度生成数据
            if (dimension === '技术领域') {
                // 按技术领域分析
                const categories = ['能源技术', '人工智能', '土木水利', '城市安全'];
                const years = ['2022', '2023', '2024', '2025', '2026'];
                
                data.labels = years;
                
                categories.forEach((category, index) => {
                    const colors = ['#9c27b0', '#3f51b5', '#2196f3', '#4caf50'];
                    const bgColors = ['rgba(156, 39, 176, 0.2)', 'rgba(63, 81, 181, 0.2)', 'rgba(33, 150, 243, 0.2)', 'rgba(76, 175, 80, 0.2)'];
                    
                    // 根据筛选后的专利数据生成趋势
                    const categoryData = years.map(year => {
                        // 模拟数据，实际项目中应基于真实数据计算
                        const baseCount = filteredPatents.length / 4;
                        return Math.floor(Math.random() * baseCount) + Math.floor(baseCount / 2);
                    });
                    
                    data.datasets.push({
                        label: category,
                        data: categoryData,
                        borderColor: colors[index],
                        backgroundColor: bgColors[index],
                        borderWidth: 2,
                        tension: 0.3
                    });
                });
            } else if (dimension === '申请年份') {
                // 按申请年份分析
                const years = ['2022', '2023', '2024', '2025', '2026'];
                data.labels = years;
                
                // 根据筛选后的专利数据生成趋势
                const yearData = years.map(year => {
                    // 模拟数据，实际项目中应基于真实数据计算
                    const baseCount = filteredPatents.length / 5;
                    return Math.floor(Math.random() * baseCount) + Math.floor(baseCount / 2);
                });
                
                data.datasets.push({
                    label: '专利数量',
                    data: yearData,
                    borderColor: '#9c27b0',
                    backgroundColor: 'rgba(156, 39, 176, 0.2)',
                    borderWidth: 2,
                    tension: 0.3
                });
            } else if (dimension === '法律状态') {
                // 按法律状态分析
                const statuses = ['已公开', '审查中', '已授权', '已失效'];
                data.labels = statuses;
                
                // 根据筛选后的专利数据生成趋势
                const statusData = statuses.map(() => {
                    // 模拟数据，实际项目中应基于真实数据计算
                    const baseCount = filteredPatents.length / 4;
                    return Math.floor(Math.random() * baseCount) + Math.floor(baseCount / 2);
                });
                
                data.datasets.push({
                    label: '专利数量',
                    data: statusData,
                    backgroundColor: ['#4caf50', '#ff9800', '#2196f3', '#f44336']
                });
            }
            
            return data;
        }
        
        // 渲染图表
        function renderChart(chartType, data, dimension) {
            const ctx = document.getElementById('trendChart').getContext('2d');
            
            // 销毁现有图表
            if (window.trendChart) {
                window.trendChart.destroy();
            }
            
            // 配置图表
            const config = {
                type: chartType === '折线图' ? 'line' : chartType === '柱状图' ? 'bar' : 'pie',
                data: data,
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: `${dimension}趋势分析`,
                            font: {
                                size: 16
                            }
                        },
                        legend: {
                            position: 'top',
                        },
                        tooltip: {
                            mode: 'index',
                            intersect: false
                        }
                    },
                    scales: chartType !== '饼图' ? {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: '专利数量'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: dimension === '技术领域' || dimension === '申请年份' ? '年份' : '状态'
                            }
                        }
                    } : {}
                }
            };
            
            // 创建图表
            window.trendChart = new Chart(ctx, config);
        }
        
        // 生成分析报告
        function generateAnalysisReport(data, dimension) {
            const reportContainer = document.getElementById('analysisReport');
            
            // 分析数据
            let report = '<h3>趋势分析报告</h3>';
            
            if (dimension === '技术领域') {
                // 分析技术领域趋势
                const totalByCategory = {};
                data.datasets.forEach(dataset => {
                    totalByCategory[dataset.label] = dataset.data.reduce((sum, value) => sum + value, 0);
                });
                
                // 找出最热门的技术领域
                let topCategory = '';
                let maxCount = 0;
                for (const [category, count] of Object.entries(totalByCategory)) {
                    if (count > maxCount) {
                        maxCount = count;
                        topCategory = category;
                    }
                }
                
                report += `
                    <p><strong>分析维度：</strong>技术领域</p>
                    <p><strong>最热门技术领域：</strong>${topCategory}（共${maxCount}项专利）</p>
                    <p><strong>趋势分析：</strong>从数据可以看出，各技术领域的专利数量呈现稳步增长趋势，其中${topCategory}领域增长最为明显。</p>
                    <p><strong>建议：</strong>可以重点关注${topCategory}领域的技术发展，加大研发投入。</p>
                `;
            } else if (dimension === '申请年份') {
                // 分析申请年份趋势
                const totalPatents = data.datasets[0].data.reduce((sum, value) => sum + value, 0);
                const latestYear = data.labels[data.labels.length - 1];
                const latestYearCount = data.datasets[0].data[data.datasets[0].data.length - 1];
                
                report += `
                    <p><strong>分析维度：</strong>申请年份</p>
                    <p><strong>总专利数：</strong>${totalPatents}项</p>
                    <p><strong>最新年份专利数：</strong>${latestYear}年 ${latestYearCount}项</p>
                    <p><strong>趋势分析：</strong>专利申请数量整体呈现${data.datasets[0].data[data.datasets[0].data.length - 1] > data.datasets[0].data[0] ? '上升' : '下降'}趋势。</p>
                    <p><strong>建议：</strong>根据趋势调整专利申请策略，保持创新活力。</p>
                `;
            } else if (dimension === '法律状态') {
                // 分析法律状态分布
                const totalPatents = data.datasets[0].data.reduce((sum, value) => sum + value, 0);
                const statusDistribution = data.labels.map((label, index) => {
                    const count = data.datasets[0].data[index];
                    const percentage = ((count / totalPatents) * 100).toFixed(1);
                    return `${label}：${count}项 (${percentage}%)`;
                }).join('，');
                
                report += `
                    <p><strong>分析维度：</strong>法律状态</p>
                    <p><strong>总专利数：</strong>${totalPatents}项</p>
                    <p><strong>状态分布：</strong>${statusDistribution}</p>
                    <p><strong>分析：</strong>从分布可以看出专利的法律状态构成，有助于了解专利组合的整体质量。</p>
                    <p><strong>建议：</strong>关注授权专利的比例，同时积极推进审查中的专利。</p>
                `;
            }
            
            reportContainer.innerHTML = report;
        }
        
        // 设置聊天输入
        function setChatInput(text) {
            document.getElementById('chatInput').value = text;
        }
        
        // 发送消息
        // 智能助手对话历史
        let chatHistory = [];
        
        function sendMessage() {
            const input = document.getElementById('chatInput');
            const message = input.value.trim();
            
            if (!message) return;
            
            const container = document.getElementById('chatContainer');
            
            // 添加用户消息
            const userMessage = document.createElement('div');
            userMessage.className = 'chat-message user';
            userMessage.innerHTML = `<strong>您：</strong><br>${message}`;
            container.appendChild(userMessage);
            
            // 记录对话历史
            chatHistory.push({ role: 'user', content: message });
            
            // 清空输入
            input.value = '';
            
            // 模拟AI回复
            setTimeout(() => {
                const aiMessage = document.createElement('div');
                aiMessage.className = 'chat-message ai';
                
                const response = generateAIResponse(message);
                
                aiMessage.innerHTML = `<strong>智能助手：</strong><br>${response}`;
                container.appendChild(aiMessage);
                
                // 记录AI回复
                chatHistory.push({ role: 'assistant', content: response });
                
                // 滚动到底部
                container.scrollTop = container.scrollHeight;
            }, 1000);
            
            // 滚动到底部
            container.scrollTop = container.scrollHeight;
        }
        
        // 生成AI响应
        function generateAIResponse(message) {
            const lowerMessage = message.toLowerCase();
            
            // 问候语
            if (lowerMessage.includes('你好') || lowerMessage.includes('您好') || lowerMessage.includes('hi') || lowerMessage.includes('hello') || lowerMessage.includes('嗨') || lowerMessage.includes('早上好') || lowerMessage.includes('下午好') || lowerMessage.includes('晚上好')) {
                    return '您好！我是城市安全数智创新团队专利文献管理系统的智能助手，有什么可以帮您的吗？我可以帮您查询专利信息、分析专利趋势、对比专利技术方案等，也可以和您聊聊天。';
                }
            
            // 专利查询
            if (lowerMessage.includes('专利') && (lowerMessage.includes('查询') || lowerMessage.includes('查找') || lowerMessage.includes('搜索'))) {
                // 提取领域关键词
                const domains = ['能源技术', '太阳能', '风能', '人工智能', '机器学习', '深度学习', '计算机视觉', '土木水利', '城市安全'];
                let foundDomain = null;
                
                for (const domain of domains) {
                    if (message.includes(domain)) {
                        foundDomain = domain;
                        break;
                    }
                }
                
                if (foundDomain) {
                    return searchPatentsByDomain(foundDomain);
                } else {
                    return '请问您想查询哪个领域的专利？您可以指定技术领域、申请人或关键词。';
                }
            }
            
            // 专利数量
            if (lowerMessage.includes('专利') && (lowerMessage.includes('数量') || lowerMessage.includes('多少'))) {
                return `目前系统中共有 ${patentData.length} 个专利。`;
            }
            
            // 专利趋势
            if (lowerMessage.includes('趋势') || (lowerMessage.includes('专利') && lowerMessage.includes('分析'))) {
                return generatePatentTrend();
            }
            
            // 专利对比
            if (lowerMessage.includes('对比') || lowerMessage.includes('比较')) {
                return '请告诉我您想对比哪两个专利，以及您关注的对比维度（如技术方案、权利要求等）。您可以在对比分析模块中选择专利进行详细对比。';
            }
            
            // 法律状态
            if (lowerMessage.includes('法律状态') || lowerMessage.includes('状态')) {
                // 提取专利名称
                const patentNames = patentData.map(p => p.name);
                let foundPatent = null;
                
                for (const name of patentNames) {
                    if (message.includes(name)) {
                        foundPatent = patentData.find(p => p.name === name);
                        break;
                    }
                }
                
                if (foundPatent) {
                    return `专利 "${foundPatent.name}" 的法律状态是：${foundPatent.status}。申请日期：${foundPatent.applicationDate}。`;
                } else {
                    return '请提供专利号或专利名称，我可以为您查询其法律状态。';
                }
            }
            
            // 分类查询
            if (lowerMessage.includes('分类') || lowerMessage.includes('类别')) {
                return generateCategoryInfo();
            }
            
            // 帮助
            if (lowerMessage.includes('帮助') || lowerMessage.includes('使用') || lowerMessage.includes('怎么')) {
                return '我可以帮助您：\n1. 查询专利信息（例如："查询人工智能领域的专利"）\n2. 分析专利趋势（例如："分析最近的专利趋势"）\n3. 对比专利技术（例如："对比两个专利的技术方案"）\n4. 查询专利法律状态（例如："查询太阳能电池专利的状态"）\n5. 了解分类体系（例如："查看分类体系"）\n6. 日常聊天（例如："你好"、"今天天气怎么样"）';
            }
            
            // 系统信息
            if (lowerMessage.includes('系统') || lowerMessage.includes('功能') || lowerMessage.includes('介绍')) {
                return '城市安全数智创新团队专利文献管理系统提供以下功能：\n1. 专利文献收集（批量导入、在线检索、手动录入）\n2. AI智能处理（提取关键技术点、创新点、法律状态）\n3. 分类整理（自定义分类体系）\n4. 对比分析（可视化对比表格）\n5. 趋势分析（技术发展趋势图表）\n6. 智能对话（自然语言交互，支持日常聊天）';
            }
            
            // 日常对话
            if (lowerMessage.includes('天气') || lowerMessage.includes('气温')) {
                return '我是专利管理系统的智能助手，无法提供实时天气信息。不过您可以询问我关于专利的问题，我很乐意帮助您！或者我们可以聊点别的，比如您今天过得怎么样？';
            } else if (lowerMessage.includes('时间') || lowerMessage.includes('日期')) {
                const now = new Date();
                const time = now.toLocaleTimeString('zh-CN');
                const date = now.toLocaleDateString('zh-CN');
                return `现在是 ${date} ${time}。请问有什么专利相关的问题需要我帮助，还是想聊点别的？`;
            } else if (lowerMessage.includes('名字') || lowerMessage.includes('你是谁') || lowerMessage.includes('身份')) {
                return '我是城市安全数智创新团队专利文献管理系统的智能助手，您可以叫我小安。我不仅可以帮助您查询专利信息、分析专利趋势等专业问题，还可以和您聊聊天，分享一些有趣的话题。';
            } else if (lowerMessage.includes('谢谢') || lowerMessage.includes('感谢') || lowerMessage.includes('谢了')) {
                return '不客气！能够帮到您我很高兴。如果您有任何专利相关的问题，或者只是想聊聊天，随时可以问我。';
            } else if (lowerMessage.includes('再见') || lowerMessage.includes('拜拜') || lowerMessage.includes('下次见')) {
                return '再见！希望我们的对话对您有所帮助。如果您有任何专利相关的问题，或者只是想聊聊天，随时可以回来找我。';
            } else if (lowerMessage.includes('心情') || lowerMessage.includes('好吗') || lowerMessage.includes('怎么样')) {
                return '我是一个AI助手，没有情感，但我随时准备为您提供专利相关的帮助！请问有什么我可以帮您的吗？或者您想聊点别的什么？';
            } else if (lowerMessage.includes('学校') || lowerMessage.includes('重庆科技大学')) {
                return '重庆科技大学是一所全日制公办普通本科院校，位于重庆市沙坪坝区大学城。学校以工为主，工、理、管、经、文、艺、法等多学科协调发展。城市安全数智创新团队是学校的重要研究团队之一，专注于城市安全领域的技术创新。';
            } else if (lowerMessage.includes('团队') || lowerMessage.includes('创新团队')) {
                return '城市安全数智创新团队是一支致力于城市安全领域研究的创新团队，由王丽萍教授领衔，被授予重庆市巾帼创新团队称号。团队专注于土木水利智能运维、工程隐患智能巡检、城市洪涝智能预警、房屋安全智能评估、三维测量智能感知等核心研究方向。';
            } else if (lowerMessage.includes('王丽萍') || lowerMessage.includes('教授')) {
                return '王丽萍教授是城市安全数智创新团队的领衔人，被授予重庆市巾帼创新团队称号。她带领团队在城市安全领域取得了丰硕的科研成果，包括发表SCI高水平论文、授权发明专利等。';
            } else if (lowerMessage.includes('工作') || lowerMessage.includes('学习') || lowerMessage.includes('生活')) {
                return '工作和学习都很重要，希望您一切顺利！如果您在专利管理方面有任何问题，或者只是想聊聊天放松一下，我都很乐意陪伴您。';
            } else if (lowerMessage.includes('吃饭') || lowerMessage.includes('饮食') || lowerMessage.includes('午餐') || lowerMessage.includes('晚餐')) {
                return '民以食为天，吃饭确实是一件重要的事情！希望您能享受到美味的食物。如果您有任何专利相关的问题，或者只是想聊聊美食，我都很乐意和您交流。';
            } else if (lowerMessage.includes('爱好') || lowerMessage.includes('兴趣')) {
                return '每个人都有自己的爱好和兴趣，这让生活更加丰富多彩！我虽然没有个人爱好，但我很喜欢帮助用户解决专利相关的问题，也很乐意和您聊各种话题。';
            } else if (lowerMessage.includes('周末') || lowerMessage.includes('假期') || lowerMessage.includes('休息')) {
                return '周末和假期是放松身心的好时机！希望您能好好休息，充充电。如果您在休息之余有任何专利相关的问题，或者只是想聊聊周末计划，我都很乐意和您交流。';
            }
            
            // 默认回复
            return '感谢您的提问。我可以帮助您查询专利信息、分析专利趋势、对比专利技术方案等专业问题，也可以和您聊聊天，分享一些有趣的话题。请问您具体需要什么帮助？';

        }
        
        // 根据领域搜索专利
        function searchPatentsByDomain(domain) {
            const matchedPatents = patentData.filter(patent => 
                patent.classification.includes(domain) || 
                patent.name.includes(domain) || 
                patent.summary.includes(domain)
            );
            
            if (matchedPatents.length === 0) {
                return `未找到与 "${domain}" 相关的专利。`;
            }
            
            let response = `找到 ${matchedPatents.length} 个与 "${domain}" 相关的专利：\n`;
            matchedPatents.slice(0, 5).forEach((patent, index) => {
                response += `${index + 1}. ${patent.name}（${patent.applicationDate}，${patent.status}）\n`;
            });
            
            if (matchedPatents.length > 5) {
                response += `... 等 ${matchedPatents.length} 个专利`;
            }
            
            return response;
        }
        
        // 生成专利趋势
        function generatePatentTrend() {
            // 按年份统计专利数量
            const yearStats = {};
            patentData.forEach(patent => {
                const year = patent.applicationDate.substring(0, 4);
                if (!yearStats[year]) {
                    yearStats[year] = 0;
                }
                yearStats[year]++;
            });
            
            // 生成趋势报告
            let response = '专利申请趋势分析：\n';
            Object.entries(yearStats)
                .sort((a, b) => a[0] - b[0])
                .forEach(([year, count]) => {
                    response += `${year}年：${count}个专利\n`;
                });
            
            // 分析增长趋势
            const years = Object.keys(yearStats).sort();
            if (years.length >= 2) {
                const firstYear = years[0];
                const lastYear = years[years.length - 1];
                const growthRate = ((yearStats[lastYear] - yearStats[firstYear]) / yearStats[firstYear] * 100).toFixed(1);
                response += `\n从 ${firstYear} 年到 ${lastYear} 年，专利申请量${growthRate >= 0 ? '增长' : '下降'}了 ${Math.abs(growthRate)}%。`;
            }
            
            return response;
        }
        
        // 生成分类信息
        function generateCategoryInfo() {
            // 统计分类数量
            const categoryCount = categoryData.filter(cat => cat.type === 'category').length;
            const subcategoryCount = categoryData.filter(cat => cat.type === 'subcategory').length;
            const itemCount = categoryData.filter(cat => cat.type === 'item').length;
            
            let response = `分类体系信息：\n`;
            response += `• 主分类：${categoryCount}个\n`;
            response += `• 子分类：${subcategoryCount}个\n`;
            response += `• 具体项目：${itemCount}个\n\n`;
            
            // 列出主分类
            const mainCategories = categoryData.filter(cat => cat.type === 'category');
            response += '主要分类包括：\n';
            mainCategories.forEach((cat, index) => {
                response += `${index + 1}. ${cat.name}\n`;
            });
            
            return response;
        }
        
        // 处理聊天回车键
        function handleChatKeyPress(event) {
            if (event.key === 'Enter') {
                sendMessage();
            }
        }
        
        // 专利数据存储
        let patentData = JSON.parse(localStorage.getItem('patentData')) || [];
        
        // 分类数据存储
        let categoryData = JSON.parse(localStorage.getItem('categoryData')) || [];
        
        // 页面加载完成后的初始化
        document.addEventListener('DOMContentLoaded', function() {
            console.log('重庆科技大学专利文献管理系统已加载完成');
            
            // 初始化批量导入文件上传功能
            initFileUpload('.upload-area', 'fileInput', 'fileList');
            
            // 初始化AI智能处理文件上传功能
            initFileUpload('#ai-process .upload-area', 'aiFileInput', 'aiFileList');
            
            // 初始化文献选择下拉框
            initPatentSelect();
            
            // 初始化分类数据
            if (categoryData.length === 0) {
                // 添加默认分类
                categoryData = [
                    {
                        id: 1,
                        name: '能源技术',
                        type: 'category',
                        parentId: 0
                    },
                    {
                        id: 2,
                        name: '太阳能',
                        type: 'subcategory',
                        parentId: 1
                    },
                    {
                        id: 3,
                        name: '太阳能电池',
                        type: 'item',
                        parentId: 2
                    },
                    {
                        id: 4,
                        name: '太阳能热水器',
                        type: 'item',
                        parentId: 2
                    },
                    {
                        id: 5,
                        name: '风能',
                        type: 'subcategory',
                        parentId: 1
                    },
                    {
                        id: 6,
                        name: '风力发电',
                        type: 'item',
                        parentId: 5
                    },
                    {
                        id: 7,
                        name: '人工智能',
                        type: 'category',
                        parentId: 0
                    },
                    {
                        id: 8,
                        name: '机器学习',
                        type: 'subcategory',
                        parentId: 7
                    },
                    {
                        id: 9,
                        name: '深度学习',
                        type: 'item',
                        parentId: 8
                    },
                    {
                        id: 10,
                        name: '计算机视觉',
                        type: 'item',
                        parentId: 7
                    }
                ];
                localStorage.setItem('categoryData', JSON.stringify(categoryData));
            }
            
            // 初始化专利数据
            if (patentData.length === 0) {
                // 添加默认数据
                patentData = [
                    {
                        id: 1,
                        name: '一种新型太阳能电池',
                        applicant: '科技公司A',
                        applicationDate: '2023-01-15',
                        classification: '能源技术 > 太阳能',
                        status: '已公开',
                        summary: '本专利涉及一种新型太阳能电池技术，通过优化材料结构和制造工艺，显著提高了能量转换效率，降低了生产成本，具有广阔的应用前景。'
                    },
                    {
                        id: 2,
                        name: '智能机器人控制系统',
                        applicant: '机器人公司B',
                        applicationDate: '2023-03-10',
                        classification: '人工智能 > 机器学习',
                        status: '审查中',
                        summary: '本专利涉及一种智能机器人控制系统，基于深度学习算法实现环境感知和实时路径规划，提高了机器人的自主导航能力。'
                    },
                    {
                        id: 3,
                        name: '风力发电设备优化',
                        applicant: '能源公司C',
                        applicationDate: '2023-05-20',
                        classification: '能源技术 > 风能',
                        status: '已授权',
                        summary: '本专利涉及风力发电设备的优化设计，通过改进叶片结构和控制系统，提高了风能利用效率，降低了设备维护成本。'
                    }
                ];
                localStorage.setItem('patentData', JSON.stringify(patentData));
            }
            
            // 更新专利列表
            updatePatentList();
            
            // 更新对比分析的专利选择
            updateComparisonPatents();
            
            // 更新分类体系
            updateCategoryTree();
        });
        
        // 更新专利列表
        function updatePatentList() {
            const patentTableBody = document.querySelector('#classification table tbody');
            if (!patentTableBody) return;
            
            patentTableBody.innerHTML = '';
            
            patentData.forEach(patent => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${patent.name}</td>
                    <td>${patent.applicant}</td>
                    <td>${patent.applicationDate}</td>
                    <td>${patent.classification}</td>
                    <td>
                        <button class="btn" style="padding: 4px 8px; font-size: 11px;" onclick="editPatent(${patent.id})">编辑</button>
                        <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;" onclick="deletePatent(${patent.id})">删除</button>
                    </td>
                `;
                patentTableBody.appendChild(row);
            });
        }
        
        // 更新对比分析的专利选择
        function updateComparisonPatents() {
            const patentSelect = document.querySelector('#comparison select');
            if (!patentSelect) return;
            
            patentSelect.innerHTML = '';
            
            patentData.forEach(patent => {
                const option = document.createElement('option');
                option.value = patent.id;
                option.textContent = patent.name;
                patentSelect.appendChild(option);
            });
        }
        
        // 编辑专利
        function editPatent(id) {
            alert('编辑专利功能待实现');
        }
        
        // 删除专利
        function deletePatent(id) {
            if (confirm('确定要删除这个专利吗？')) {
                patentData = patentData.filter(patent => patent.id !== id);
                localStorage.setItem('patentData', JSON.stringify(patentData));
                updatePatentList();
                updateComparisonPatents();
                alert('专利已删除');
            }
        }
        
        // 添加专利
        function addPatent(patent) {
            const newId = patentData.length > 0 ? Math.max(...patentData.map(p => p.id)) + 1 : 1;
            patent.id = newId;
            patentData.push(patent);
            localStorage.setItem('patentData', JSON.stringify(patentData));
            updatePatentList();
            updateComparisonPatents();
        }
        
        // 更新分类树
        function updateCategoryTree() {
            const categoryContainer = document.querySelector('#classification div[style*="border: 1px solid #e9ecef"]');
            if (!categoryContainer) return;
            
            categoryContainer.innerHTML = '';
            
            // 递归生成分类树
            function buildCategoryTree(parentId, level) {
                const categories = categoryData.filter(cat => cat.parentId === parentId);
                
                categories.forEach(category => {
                    const categoryElement = document.createElement('div');
                    const indent = ' '.repeat(level * 20);
                    
                    let icon = '📄';
                    if (category.type === 'category') icon = '📁';
                    if (category.type === 'subcategory') icon = '📂';
                    
                    categoryElement.style.marginLeft = `${indent}`;
                    categoryElement.style.marginBottom = '5px';
                    categoryElement.innerHTML = `
                        <span>${icon} ${category.name}</span>
                        <span style="float: right; margin-right: 10px;">
                            <button onclick="addSubCategory(${category.id})" style="background: none; border: none; color: #8A2BE2; cursor: pointer; font-size: 12px;">+</button>
                            <button onclick="deleteCategory(${category.id})" style="background: none; border: none; color: #dc3545; cursor: pointer; font-size: 12px;">-</button>
                        </span>
                    `;
                    
                    categoryContainer.appendChild(categoryElement);
                    
                    // 递归处理子分类
                    buildCategoryTree(category.id, level + 1);
                });
            }
            
            // 从根分类开始构建
            buildCategoryTree(0, 0);
        }
        
        // 添加分类
        function addCategory() {
            const categoryName = prompt('请输入分类名称:');
            if (categoryName && categoryName.trim()) {
                const newId = categoryData.length > 0 ? Math.max(...categoryData.map(c => c.id)) + 1 : 1;
                const newCategory = {
                    id: newId,
                    name: categoryName.trim(),
                    type: 'category',
                    parentId: 0
                };
                categoryData.push(newCategory);
                localStorage.setItem('categoryData', JSON.stringify(categoryData));
                updateCategoryTree();
                alert('分类添加成功！');
            }
        }
        
        // 添加子分类
        function addSubCategory(parentId) {
            const parentCategory = categoryData.find(cat => cat.id === parentId);
            if (!parentCategory) return;
            
            const categoryName = prompt(`请输入"${parentCategory.name}"的子分类名称:`);
            if (categoryName && categoryName.trim()) {
                const newId = categoryData.length > 0 ? Math.max(...categoryData.map(c => c.id)) + 1 : 1;
                let newType = 'item';
                if (parentCategory.type === 'category') newType = 'subcategory';
                
                const newCategory = {
                    id: newId,
                    name: categoryName.trim(),
                    type: newType,
                    parentId: parentId
                };
                categoryData.push(newCategory);
                localStorage.setItem('categoryData', JSON.stringify(categoryData));
                updateCategoryTree();
                alert('子分类添加成功！');
            }
        }
        
        // 通过名称添加子分类
        function addSubCategoryByName(categoryName) {
            const category = categoryData.find(cat => cat.name === categoryName);
            if (category) {
                addSubCategory(category.id);
            } else {
                alert('未找到该分类，请先添加主分类');
            }
        }
        
        // 删除分类
        function deleteCategory(categoryId) {
            const category = categoryData.find(cat => cat.id === categoryId);
            if (!category) return;
            
            // 检查是否有子分类
            const hasChildren = categoryData.some(cat => cat.parentId === categoryId);
            if (hasChildren) {
                alert('该分类下有子分类，无法删除！');
                return;
            }
            
            if (confirm(`确定要删除"${category.name}"分类吗？`)) {
                categoryData = categoryData.filter(cat => cat.id !== categoryId);
                localStorage.setItem('categoryData', JSON.stringify(categoryData));
                updateCategoryTree();
                alert('分类删除成功！');
            }
        }
        
        // 通过元素删除分类
        function deleteCategoryByElement(element) {
            // 获取分类名称
            const categoryItem = element.closest('.category-item');
            const categoryName = categoryItem.querySelector('span:nth-child(2)').textContent;
            
            // 查找分类ID
            const category = categoryData.find(cat => cat.name === categoryName);
            if (category) {
                deleteCategory(category.id);
            } else {
                alert('未找到该分类');
            }
        }
        
        // 初始化文件上传功能
        function initFileUpload(uploadAreaSelector, inputId, fileListId) {
            const uploadArea = document.querySelector(uploadAreaSelector);
            const fileInput = document.getElementById(inputId);
            const fileList = document.getElementById(fileListId);
            
            if (uploadArea && fileInput) {
                // 点击上传区域触发文件选择
                uploadArea.addEventListener('click', function() {
                    fileInput.click();
                });
                
                // 处理文件选择
                fileInput.addEventListener('change', function(e) {
                    handleFiles(e.target.files, fileListId);
                });
                
                // 处理拖拽上传
                uploadArea.addEventListener('dragover', function(e) {
                    e.preventDefault();
                    uploadArea.style.background = '#e1bee7';
                });
                
                uploadArea.addEventListener('dragleave', function() {
                    uploadArea.style.background = '#f3e5f5';
                });
                
                uploadArea.addEventListener('drop', function(e) {
                    e.preventDefault();
                    uploadArea.style.background = '#f3e5f5';
                    if (e.dataTransfer.files.length > 0) {
                        handleFiles(e.dataTransfer.files, fileListId);
                    }
                });
            }
        }
        
        // 处理选择的文件
        function handleFiles(files, fileListId = 'fileList') {
            const fileList = document.getElementById(fileListId);
            if (!fileList) return;
            
            fileList.innerHTML = '';
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const fileItem = document.createElement('div');
                fileItem.style.padding = '8px';
                fileItem.style.borderBottom = '1px solid #e9ecef';
                fileItem.innerHTML = `
                    <span>📄 ${file.name}</span>
                    <span style="float: right; color: #666; font-size: 12px;">${formatFileSize(file.size)}</span>
                `;
                fileList.appendChild(fileItem);
            }
            
            if (files.length > 0) {
                fileList.style.display = 'block';
            }
        }
        
        // 格式化文件大小
        function formatFileSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        // 开始导入
        function startImport() {
            const fileInput = document.getElementById('fileInput');
            if (fileInput && fileInput.files.length > 0) {
                const fileCount = fileInput.files.length;
                alert(`开始导入 ${fileCount} 个文件...`);
                
                // 模拟导入过程
                setTimeout(() => {
                    // 为每个文件创建专利数据
                    for (let i = 0; i < fileInput.files.length; i++) {
                        const file = fileInput.files[i];
                        const fileName = file.name.replace(/\.[^/.]+$/, ''); // 去掉文件扩展名
                        const newPatent = {
                            name: fileName,
                            applicant: extractApplicant(file.name, null),
                            applicationDate: new Date().toISOString().split('T')[0],
                            classification: '未分类',
                            status: '审查中',
                            summary: `从文件 ${file.name} 导入的专利数据`
                        };
                        addPatent(newPatent);
                    }
                    
                    alert(`成功导入 ${fileCount} 个文件！`);
                    // 清空文件列表
                    document.getElementById('fileList').innerHTML = '';
                    fileInput.value = '';
                }, 2000);
            } else {
                alert('请先选择要上传的文件');
            }
        }
        
        // OpenAI 功能
        const API_PROXY = 'https://dawn-night-d7ae.1970238795.workers.dev';
        window.API_PROXY = API_PROXY;
        const PORT = 3000;
        
        // 更新 API Key 显示
        function updateApiKeyDisplay() {
            const apiKey = document.getElementById('openaiApiKey').value;
            const display = document.getElementById('apiKeyDisplay');
            if (apiKey) {
                display.textContent = `当前 API：${apiKey}`;
            } else {
                display.textContent = '请输入 API 密钥';
            }
        }

        // 保存 API 密钥
        function saveApiKey() {
            const apiKey = document.getElementById('openaiApiKey').value;
            if (apiKey) {
                localStorage.setItem('openaiApiKey', apiKey);
                updateApiKeyDisplay();
                showApiKeyStatus('API 密钥保存成功！', 'success');
                try { if (typeof updateChatModeBadge === 'function') updateChatModeBadge(); } catch (e) {}
                try { if (typeof updateOpenAIHeroStatus === 'function') updateOpenAIHeroStatus(); } catch (e) {}
            } else {
                showApiKeyStatus('请输入 API 密钥', 'error');
            }
        }
        
        // 加载 API 密钥
        function loadApiKey() {
            const savedKey = localStorage.getItem('openaiApiKey');
            if (savedKey) {
                document.getElementById('openaiApiKey').value = savedKey;
                updateApiKeyDisplay();
                showApiKeyStatus('API 密钥已加载', 'success');
            } else {
                updateApiKeyDisplay();
            }
            try { if (typeof updateOpenAIHeroStatus === 'function') updateOpenAIHeroStatus(); } catch (e) {}
            try { if (typeof updateChatModeBadge === 'function') updateChatModeBadge(); } catch (e) {}
        }

        function updateOpenAIHeroStatus() {
            const el = document.getElementById('openaiHeroStatus');
            if (!el) return;
            const key = (document.getElementById('openaiApiKey') && document.getElementById('openaiApiKey').value)
                || localStorage.getItem('openaiApiKey')
                || '';
            if (String(key).trim()) {
                el.textContent = '密钥已配置';
                el.style.background = 'rgba(34,197,94,0.22)';
            } else {
                el.textContent = '密钥未配置';
                el.style.background = 'rgba(255,255,255,0.16)';
            }
        }
        
        // 页面加载时加载开发日志历史
        window.onload = function() {
            loadApiKey();
            displayDevLogHistory();
        }
        
        // 详情弹窗功能
        const modal = document.getElementById('details-modal');
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');
        const modalClose = document.querySelector('.modal-close');
        const modalCloseBtn = document.querySelector('.modal-close-btn');
        
        function showDetails(title, content) {
            modalTitle.textContent = title;
            modalBody.innerHTML = content;
            modal.style.display = 'block';
        }
        
        function closeModal() {
            modal.style.display = 'none';
        }
        
        if (modalClose) modalClose.addEventListener('click', closeModal);
        if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
        
        window.addEventListener('click', function(event) {
            if (event.target == modal) {
                closeModal();
            }
        });
        
        // 顶部核心指标卡片详情
        function showStatsDetails(type) {
            const details = {
                'funding': {
                    title: '科研总经费详情',
                    content: `
                        <p>2025年科研总经费：<strong>407.2万元</strong></p>
                        <p>同比增长：<span style="color: #00B42A;">+236%</span></p>
                        <h4>经费结构：</h4>
                        <ul>
                            <li>智能巡检与安全AI算法：85%（346.1万元）</li>
                            <li>城市内涝与水利监测：12%（48.9万元）</li>
                            <li>其他：3%（12.2万元）</li>
                        </ul>
                        <h4>代表性项目：</h4>
                        <ul>
                            <li>中交集团攻关项目：陆空一体化事故隐患AI智能巡检技术（200万元）</li>
                            <li>教育部大项目：基于AI精度可控三维扫描的大型预制建模与预拼装（120万元）</li>
                        </ul>
                    `
                },
                'papers': {
                    title: '高水平论文详情',
                    content: `
                        <p>总计：<strong>65篇</strong></p>
                        <h4>论文分布：</h4>
                        <ul>
                            <li>SCI论文：30篇</li>
                            <li>EI论文：35篇</li>
                        </ul>
                        <h4>研究方向：</h4>
                        <ul>
                            <li>智能巡检与安全AI算法</li>
                            <li>城市内涝与水利监测</li>
                            <li>应急管理与灾害预警</li>
                        </ul>
                    `
                },
                'ip': {
                    title: '知识产权详情',
                    content: `
                        <p>总计：<strong>75项</strong></p>
                        <h4>知识产权分布：</h4>
                        <ul>
                            <li>发明专利：45项</li>
                            <li>软件著作权：30项</li>
                        </ul>
                        <h4>2025年新增：</h4>
                        <ul>
                            <li>发明专利受理：10项（+67%）</li>
                            <li>发明专利授权：4项（+100%）</li>
                            <li>实用新型受理：2项（新增）</li>
                        </ul>
                    `
                },
                'standards': {
                    title: '标准制定详情',
                    content: `
                        <p>总计：<strong>33项</strong></p>
                        <h4>标准分布：</h4>
                        <ul>
                            <li>地方标准：2项</li>
                            <li>行业标准：31项</li>
                        </ul>
                        <h4>代表性标准：</h4>
                        <ul>
                            <li>重庆市《地震灾害风险评估规范》（DB50/T 1701-2024）</li>
                        </ul>
                    `
                },
                'awards': {
                    title: '赛事获奖详情',
                    content: `
                        <p>总计：<strong>5+项</strong></p>
                        <h4>获奖情况：</h4>
                        <ul>
                            <li>全国建筑机器人大赛：二等奖</li>
                            <li>中国国际大学生创新大赛：院赛二等奖、校赛银奖</li>
                        </ul>
                        <h4>赛事级别：</h4>
                        <ul>
                            <li>国家级赛事</li>
                            <li>省部级赛事</li>
                        </ul>
                    `
                }
            };
            
            if (details[type]) {
                showDetails(details[type].title, details[type].content);
            }
        }
        
        // 双栏业绩卡片详情
        function showPerformanceDetails(type) {
            const details = {
                'ip': {
                    title: '知识产权业绩详情',
                    content: `
                        <h4>2024 vs 2025 对比：</h4>
                        <ul>
                            <li>发明专利受理：6项 → 10项（+67%）</li>
                            <li>发明专利授权：2项 → 4项（+100%）</li>
                            <li>实用新型受理：0项 → 2项（新增）</li>
                        </ul>
                        <h4>结构分布：</h4>
                        <ul>
                            <li>智能巡检与安全AI算法：75%</li>
                            <li>城市内涝与水利监测：25%</li>
                        </ul>
                    `
                },
                'funding': {
                    title: '科研经费业绩详情',
                    content: `
                        <h4>2024 vs 2025 对比：</h4>
                        <ul>
                            <li>总经费：121.1万元 → 407.2万元（+236%）</li>
                            <li>新立项：5项 → 9项（+80%）</li>
                            <li>代表性纵向：- → 120万元</li>
                            <li>代表性横向：- → 200万元</li>
                        </ul>
                        <h4>结构分布：</h4>
                        <ul>
                            <li>智能巡检与安全AI：85%</li>
                            <li>城市内涝与水利：12%</li>
                            <li>其他：3%</li>
                        </ul>
                    `
                }
            };
            
            if (details[type]) {
                showDetails(details[type].title, details[type].content);
            }
        }
        
        // 三栏分类成果详情
        function showCategoryDetails(type) {
            const details = {
                'academic': {
                    title: '学术成果详情',
                    content: `
                        <h4>论文发表：</h4>
                        <p>SCI/高水平论文65篇（SCI 30篇 · EI 35篇）</p>
                        <h4>专著出版：</h4>
                        <p>学术专著3部（城市安全管理 · 智能运维）</p>
                        <h4>标准制定：</h4>
                        <p>牵头地方标准2项 · 参与行业标准31项</p>
                    `
                },
                'tech': {
                    title: '技术成果详情',
                    content: `
                        <h4>知识产权：</h4>
                        <p>发明专利45项 · 软件著作权30项</p>
                        <h4>科技奖励：</h4>
                        <p>省部级科技奖3项 · 市级科技进步奖2项</p>
                        <h4>技术转化：</h4>
                        <p>多项成果工程应用 · 显著经济社会效益</p>
                    `
                },
                'honor': {
                    title: '荣誉称号详情',
                    content: `
                        <h4>市级荣誉：</h4>
                        <ul>
                            <li>重庆市巾帼创新团队</li>
                            <li>重庆市高校创新团队</li>
                        </ul>
                        <h4>校级荣誉：</h4>
                        <ul>
                            <li>重庆科技大学优秀科研团队</li>
                        </ul>
                    `
                }
            };
            
            if (details[type]) {
                showDetails(details[type].title, details[type].content);
            }
        }
        
        // 里程碑成果详情
        function showMilestoneDetails(index) {
            const milestones = [
                {
                    title: '《地震灾害风险评估规范》获批发布',
                    content: `
                        <p>发布时间：2025年1月13日</p>
                        <p>标准编号：DB50/T 1701-2024</p>
                        <h4>标准意义：</h4>
                        <p>重庆市《地震灾害风险评估规范》由重庆科技大学、重庆市地震灾害防御中心等单位编制，经重庆市市场监督管理局批准发布。</p>
                        <p>该标准是在第一次全国自然灾害综合风险普查工作经验基础上编制，是国内第一部地震灾害风险评估工作的地方标准，填补了内地在地震灾害风险评估标准的空白。</p>
                        <h4>应用价值：</h4>
                        <p>该标准的出台可有效指导重庆市各区县开展地震灾害风险评估工作流程，提高评估结果的科学性、针对性，为地方政府提供科学依据。</p>
                    `
                },
                {
                    title: '联合国世界气象组织肯定重庆数智气象',
                    content: `
                        <p>时间：2025年3月</p>
                        <h4>重要意义：</h4>
                        <p>联合国世界气象组织对重庆数智气象的先进性给予高度肯定，其中包括"知天·智慧服务"中的"城市内涝监测预警联动系统"。</p>
                        <p>联合国世界气象组织副秘书长·巴雷特表示："看到了体系有多先进"，并希望合作将专业技术带向世界。</p>
                        <h4>应用情况：</h4>
                        <p>该系统已在重庆市33个积水内涝点开展应用，为城市防洪减灾提供了有力技术支撑。</p>
                    `
                },
                {
                    title: '陆空一体化AI巡检技术试点落地',
                    content: `
                        <p>时间：2025年5月</p>
                        <h4>技术亮点：</h4>
                        <p>团队研发的"陆空一体化事故隐患AI识别智能巡检技术"在中交一公局第三工程有限公司重庆轨道交通15号线项目成功试点应用。</p>
                        <p>该技术通过无人机空中覆盖巡查、机器人地面精准排查、摄像头重点部位监控等方式，实现了事故隐患的自动识别和及时预警。</p>
                        <h4>媒体报道：</h4>
                        <p>获得了"重庆科技报"与"央广网"的报道。</p>
                        <h4>技术意义：</h4>
                        <p>此标志着团队在技术工业全流程人工智能融合领域迈出关键一步，为智能制造提供了可复制的本地化解决方案。</p>
                    `
                },
                {
                    title: '自然灾害预警响应能力提升项目完成',
                    content: `
                        <p>时间：2025年7月</p>
                        <h4>项目成果：</h4>
                        <p>团队完成了"自然灾害预警响应能力提升项目"，通过AI技术赋能重庆预警系统，实现了预警信息的快速发布和响应。</p>
                        <h4>技术指标：</h4>
                        <p>重庆市应急管理局副局长姜瑾表示："让预警跑在成灾之前！重庆预警短信每秒可发布4500条，5~10分钟内送达社会公众。"</p>
                        <h4>项目意义：</h4>
                        <p>该项目高质量完成了"十四五"规划中中国式现代化应急管理体系和能力现代化建设的相关任务，为重庆市的灾害预警能力提升做出了重要贡献。</p>
                    `
                },
                {
                    title: '智能巡检四足机器人获全国建筑机器人大赛二等奖',
                    content: `
                        <p>时间：2025年9月</p>
                        <h4>获奖情况：</h4>
                        <p>团队研发的"安全隐患识别智能巡检四足机器人"在2025年"智能建造·慧享未来"第三届全国建筑机器人大赛创意设计竞赛中获得二等奖。</p>
                        <h4>其他荣誉：</h4>
                        <ul>
                            <li>中国国际大学生创新大赛（2025）院赛二等奖</li>
                            <li>中国国际大学生创新大赛（2025）校赛银奖</li>
                        </ul>
                        <h4>技术特点：</h4>
                        <p>该机器人能够自主识别安全隐患，实现智能巡检功能，为建筑施工安全提供了新的技术解决方案。</p>
                    `
                }
            ];
            
            if (milestones[index]) {
                showDetails(milestones[index].title, milestones[index].content);
            }
        }
        
        // 测试API密钥
        async function testApiKey() {
            const apiKey = document.getElementById('openaiApiKey').value;
            const model = document.getElementById('openaiModel').value;
            
            if (!apiKey) {
                showApiKeyStatus('请输入API密钥', 'error');
                return;
            }
            
            showApiKeyStatus('正在测试API密钥...', 'info');
            
            try {
                const localProxy = `${API_PROXY}/api/aliyun`;
                
                const response = await fetch(localProxy, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: apiKey,
                        model: model,
                        messages: [
                            { role: 'user', content: '你好' }
                        ],
                        temperature: 0.7,
                        max_tokens: 10
                    })
                });
                
                const responseText = await response.text();
                
                if (response.ok) {
                    const data = JSON.parse(responseText);
                    if (data.choices && data.choices.length > 0) {
                        showApiKeyStatus('API 密钥测试成功！连接正常。', 'success');
                    } else {
                        showApiKeyStatus('API 响应异常，请检查密钥是否正确。', 'error');
                    }
                } else {
                    const errorData = JSON.parse(responseText);
                    const errorMsg = errorData.message || errorData.error?.message || 'API 调用失败';
                    showApiKeyStatus('API 密钥测试失败：' + errorMsg, 'error');
                }
            } catch (error) {
                showApiKeyStatus('测试失败：' + error.message + '，请确保代理服务器已启动。', 'error');
            }
        }
        
        // 显示API密钥状态
        function showApiKeyStatus(message, type) {
            const statusDiv = document.getElementById('apiKeyStatus');
            statusDiv.textContent = message;
            statusDiv.style.display = 'block';
            
            // 设置样式
            if (type === 'success') {
                statusDiv.style.backgroundColor = '#d4edda';
                statusDiv.style.border = '1px solid #c3e6cb';
                statusDiv.style.color = '#155724';
            } else if (type === 'error') {
                statusDiv.style.backgroundColor = '#f8d7da';
                statusDiv.style.border = '1px solid #f5c6cb';
                statusDiv.style.color = '#721c24';
            } else {
                statusDiv.style.backgroundColor = '#d1ecf1';
                statusDiv.style.border = '1px solid #bee5eb';
                statusDiv.style.color = '#0c5460';
            }
            
            // 3秒后隐藏
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 3000);
        }
        
        // 发送消息到阿里云百炼API
        async function sendOpenAIMessage() {
            const input = document.getElementById('openaiChatInput');
            const message = input.value.trim();
            
            if (!message) return;
            
            addOpenAIMessage('user', message);
            input.value = '';
            
            const apiKey = document.getElementById('openaiApiKey').value || localStorage.getItem('openaiApiKey') || '';
            const model = document.getElementById('openaiModel').value;
            const temperature = parseFloat(document.getElementById('openaiTemperature').value);
            const maxTokens = parseInt(document.getElementById('openaiMaxTokens').value);
            
            if (!apiKey) {
                addOpenAIMessage('ai', '请先设置并保存阿里云百炼 API 密钥');
                return;
            }
            
            const loadingMessageId = addOpenAIMessage('ai', '', true);
            
            try {
                const localProxy = `${API_PROXY}/api/aliyun`;
                const response = await fetch(localProxy, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: apiKey,
                        model: model,
                        messages: [
                            { role: 'system', content: '你是城市安全数智创新团队的阿里云百炼助手，回答简洁、专业、可执行。' },
                            { role: 'user', content: message }
                        ],
                        temperature: temperature,
                        max_tokens: maxTokens
                    })
                });
                
                const responseText = await response.text();
                
                if (response.ok) {
                    try {
                        const data = JSON.parse(responseText);
                        const aiResponse = data.choices?.[0]?.message?.content || '未获取到响应';
                        replaceOpenAIMessage(loadingMessageId, aiResponse);
                    } catch (jsonError) {
                        console.error('JSON解析错误:', jsonError);
                        replaceOpenAIMessage(loadingMessageId, '错误：API 响应解析失败');
                    }
                } else {
                    try {
                        const errorData = JSON.parse(responseText);
                        replaceOpenAIMessage(loadingMessageId, '错误：' + (errorData.message || errorData.error?.message || 'API 调用失败'));
                    } catch (jsonError) {
                        replaceOpenAIMessage(loadingMessageId, '错误：' + responseText);
                    }
                }
            } catch (error) {
                console.error('发送消息失败:', error);
                replaceOpenAIMessage(loadingMessageId, '错误：' + error.message);
            }
        }
        
        // 添加阿里云百炼消息
        function addOpenAIMessage(type, content, typing) {
            const chatContainer = document.getElementById('openaiChatContainer');
            if (!chatContainer) return '';
            const isUser = type === 'user';
            const row = document.createElement('div');
            const mid = 'openai_msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            row.id = mid;
            row.className = 'team-chat-row ' + (isUser ? 'user' : 'assistant');
            const body = typing
                ? '<div class="team-chat-typing" aria-label="正在思考"><span></span><span></span><span></span></div>'
                : '<div>' + String(content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
            row.innerHTML = '<div class="team-chat-bubble ' + (isUser ? 'user' : 'assistant') + '">' +
                '<div class="team-chat-label">' + (isUser ? '我' : '百炼助手') + '</div>' +
                body +
                '</div>';
            chatContainer.appendChild(row);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return mid;
        }
        
        // 替换阿里云百炼消息
        function replaceOpenAIMessage(messageId, content) {
            const messageDiv = document.getElementById(messageId);
            if (messageDiv) {
                messageDiv.className = 'team-chat-row assistant';
                messageDiv.innerHTML = '<div class="team-chat-bubble assistant">' +
                    '<div class="team-chat-label">百炼助手</div>' +
                    '<div>' + String(content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
                    '<div class="team-chat-meta">大模型直连</div></div>';
                const chatContainer = document.getElementById('openaiChatContainer');
                if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
            }
        }
        
        // 处理键盘事件
        function handleOpenAIChatKeyPress(event) {
            if (event.key === 'Enter') {
                sendOpenAIMessage();
            }
        }
        
        // 清空阿里云百炼对话
        function clearOpenAIChat() {
            const chatContainer = document.getElementById('openaiChatContainer');
            if (!chatContainer) return;
            chatContainer.innerHTML = '<div class="team-chat-row assistant"><div class="team-chat-bubble assistant"><div class="team-chat-label">百炼助手</div><div>您好！我是阿里云百炼助手，可在此直接对话调试模型参数。团队制度/周报等问题请优先使用「智能对话问答」。</div></div></div>';
        }
        

        // [moved] see js/excel-tools.js
        

        // [moved] see js/achievements-modules.js
// onclick 兼容：保持全局可调用
window.showModule = showModule;
