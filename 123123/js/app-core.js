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
            'patentData', 'categoryData', 'memberData',
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
            try { apply('patentData', function(v){ patentData = v; }); } catch(e){}
            try { apply('categoryData', function(v){ categoryData = v; }); } catch(e){}
            try { apply('memberData', function(v){ memberData = v; }); } catch(e){}
        }

        async function syncFromCloudAndRefresh(options) {
            var result = await pullAllFromCloud(options || {});
            hydrateInMemoryFromLocalStorage();
            try { if (typeof onCloudAccountPermissionHydrated === 'function') onCloudAccountPermissionHydrated(); } catch (e) {}
            try { if (typeof syncTeamMembersAcrossSystem === 'function') syncTeamMembersAcrossSystem(); } catch (e) {}
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
        
        // Excel处理相关函数
        let uploadedExcelFiles = [];
        let excelData = []; // 存储Excel文件数据
        let mergedWorkbook = null; // 存储合并后的工作簿
        let dataTypes = []; // 存储提取的数据类型
        
        // 处理Excel文件上传
        function handleExcelFileUpload(event) {
            const files = event.target.files;
            if (files.length === 0) return;
            
            let validFilesCount = 0;
            let invalidFilesCount = 0;
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
                if (fileExtension === '.xlsx' || fileExtension === '.xls') {
                    uploadedExcelFiles.push(file);
                    processExcelFile(file);
                    validFilesCount++;
                } else {
                    invalidFilesCount++;
                }
            }
            
            if (validFilesCount > 0) {
                updateExcelFileList();
                showStatusMessage(`成功添加 ${validFilesCount} 个Excel文件`, 'success');
            }
            
            if (invalidFilesCount > 0) {
                showStatusMessage(`跳过 ${invalidFilesCount} 个非Excel文件，请上传.xlsx或.xls格式的文件`, 'error');
            }
        }
        
        // 处理 Excel 文件
        function processExcelFile(file) {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const excelItem = { file: file, workbook: workbook };
                    excelData.push(excelItem);
                    
                    // 提取数据类型
                    extractDataTypes(workbook, file.name);
                    
                    // 文件上传成功后，立即调用 AI 进行预处理和分析
                    console.log('文件上传成功，开始 AI 预处理...');
                    await preprocessExcelWithAI(excelItem);
                    
                } catch (error) {
                    console.error('处理 Excel 文件失败:', error);
                    showStatusMessage(`处理文件 ${file.name} 失败: ${error.message}`, 'error');
                }
            };
            reader.onerror = function() {
                console.error('文件读取失败');
                showStatusMessage(`读取文件 ${file.name} 失败，请检查文件是否损坏`, 'error');
            };
            reader.readAsArrayBuffer(file);
        }
        
        // AI 预处理 Excel 文件
        async function preprocessExcelWithAI(excelItem) {
            const apiKey = document.getElementById('openaiApiKey').value;
            const model = document.getElementById('openaiModel').value;
            
            if (!apiKey) {
                console.log('⚠️ 未设置 API Key，跳过 AI 预处理');
                return;
            }
            
            try {
                // 准备 Excel 数据（只发送样本）
                const workbook = excelItem.workbook;
                const excelDataForAI = {
                    fileName: excelItem.file.name,
                    sheets: []
                };
                
                workbook.SheetNames.forEach(sheetName => {
                    const sheet = workbook.Sheets[sheetName];
                    const jsonData = XLSX.utils.sheet_to_json(sheet);
                    
                    excelDataForAI.sheets.push({
                        sheetName: sheetName,
                        totalRows: jsonData.length,
                        columns: jsonData.length > 0 ? Object.keys(jsonData[0]) : [],
                        sampleData: jsonData.slice(0, 10)
                    });
                });
                
                const jsonDataString = JSON.stringify(excelDataForAI, null, 2);
                
                console.log('🔄 正在预处理文件:', excelItem.file.name);
                
                // 调用 AI 进行预处理
                const localProxy = `${API_PROXY}/api/aliyun`;
                const response = await fetch(localProxy, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: apiKey,
                        model: model,
                        messages: [
                            {
                                role: 'system',
                                content: '你是一个专业的 Excel 数据分析专家。用户上传了 Excel 文件，请快速分析文件结构并生成预处理报告。只需要分析文件结构、列名、数据类型等基本信息，不需要详细分析。用中文回复。'
                            },
                            {
                                role: 'user',
                                content: `我上传了一个 Excel 文件，请分析文件结构：

${jsonDataString}

请提供：
1. 文件基本信息（文件名、工作表数量）
2. 每个工作表的结构（表名、行数、列名）
3. 数据类型识别（日期、数字、文本等）
4. 数据质量初步评估

保持简洁，后续我会提出具体分析需求。`
                            }
                        ],
                        temperature: 0.5,
                        max_tokens: 1500
                    }),
                    credentials: 'omit',
                    mode: 'cors'
                });
                
                if (response.ok) {
                    const data = await response.json();
                    const aiResponse = data.choices?.[0]?.message?.content;
                    
                    console.log('✅ AI 预处理完成');
                    
                    // 保存预处理结果
                    excelItem.aiPreprocess = {
                        timestamp: new Date().toISOString(),
                        result: aiResponse
                    };
                    
                    // 显示预处理结果
                    const mergeResult = document.getElementById('mergeResult');
                    if (mergeResult) {
                        mergeResult.innerHTML = `
                            <div style="background: #e7f3ff; padding: 20px; border-radius: 8px; border: 1px solid #b3d9ff;">
                                <h4 style="margin-top: 0; color: #0066cc;">🤖 AI 文件预处理完成</h4>
                                <div style="white-space: pre-wrap; line-height: 1.6; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px;">${aiResponse}</div>
                                <div style="margin-top: 15px; padding: 10px; background: #fff; border-radius: 5px; border-left: 4px solid #0066cc;">
                                    <strong>💡 提示：</strong>文件已上传并预处理完成。请点击"💡 智能指令"按钮，输入您的具体分析需求（如数据清洗、分组汇总、趋势分析等）。
                                </div>
                            </div>
                        `;
                    }
                } else {
                    console.error('AI 预处理失败');
                }
            } catch (error) {
                console.error('AI 预处理失败:', error);
            }
        }
        
        // 生成更有意义的数据类型名称
        function generateMeaningfulTypeName(headers, fileName, sheetName) {
            // 尝试从表头中提取关键词
            const headerKeywords = [];
            
            headers.forEach(header => {
                if (header) {
                    const headerStr = String(header);
                    // 提取有意义的关键词
                    if (headerStr.includes('报销')) {
                        headerKeywords.push('报销');
                    } else if (headerStr.includes('项目')) {
                        headerKeywords.push('项目');
                    } else if (headerStr.includes('成果')) {
                        headerKeywords.push('成果');
                    } else if (headerStr.includes('经费')) {
                        headerKeywords.push('经费');
                    } else if (headerStr.includes('成本')) {
                        headerKeywords.push('成本');
                    } else if (headerStr.includes('预算')) {
                        headerKeywords.push('预算');
                    } else if (headerStr.includes('支出')) {
                        headerKeywords.push('支出');
                    } else if (headerStr.includes('收入')) {
                        headerKeywords.push('收入');
                    } else if (headerStr.includes('进度')) {
                        headerKeywords.push('进度');
                    } else if (headerStr.includes('计划')) {
                        headerKeywords.push('计划');
                    } else if (headerStr.includes('统计')) {
                        headerKeywords.push('统计');
                    } else if (headerStr.includes('报表')) {
                        headerKeywords.push('报表');
                    }
                }
            });
            
            // 如果从表头中提取到关键词
            if (headerKeywords.length > 0) {
                // 去重
                const uniqueKeywords = [...new Set(headerKeywords)];
                // 生成名称
                return uniqueKeywords.join('') + '数据';
            }
            
            // 尝试从文件名中提取关键词
            const fileNameStr = fileName.replace(/\.xlsx?$/, '');
            if (fileNameStr.includes('报销')) {
                return '报销数据';
            } else if (fileNameStr.includes('项目')) {
                return '项目数据';
            } else if (fileNameStr.includes('成果')) {
                return '成果数据';
            } else if (fileNameStr.includes('经费')) {
                return '经费数据';
            } else if (fileNameStr.includes('成本')) {
                return '成本数据';
            } else if (fileNameStr.includes('预算')) {
                return '预算数据';
            } else if (fileNameStr.includes('进度')) {
                return '进度数据';
            } else if (fileNameStr.includes('统计')) {
                return '统计数据';
            }
            
            // 默认名称
            return `${fileNameStr} - ${sheetName}`;
        }
        
        // 提取数据类型
        function extractDataTypes(workbook, fileName) {
            workbook.SheetNames.forEach(sheetName => {
                const worksheet = workbook.Sheets[sheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                
                if (jsonData.length > 0) {
                    // 自动识别真正的表头
                    let headerRowIndex = 0;
                    
                    // 遍历前几行，找到包含最多非空值的行作为表头
                    let maxNonEmpty = 0;
                    for (let i = 0; i < Math.min(5, jsonData.length); i++) {
                        const row = jsonData[i];
                        const nonEmptyCount = row.filter(cell => cell && String(cell).trim() !== '').length;
                        if (nonEmptyCount > maxNonEmpty) {
                            maxNonEmpty = nonEmptyCount;
                            headerRowIndex = i;
                        }
                    }
                    
                    // 提取表头和数据
                    const headers = jsonData[headerRowIndex];
                    const data = jsonData.slice(headerRowIndex + 1);
                    
                    // 过滤掉空数据行并处理日期格式
                    const filteredData = data.filter(row => {
                        return row.filter(cell => cell && String(cell).trim() !== '').length > 0;
                    }).map(row => {
                        return row.map((cell, index) => {
                            // 检查是否是日期列（列名包含日期相关词汇）
                            const header = headers[index];
                            if (header && (String(header).includes('日期') || String(header).includes('时间'))) {
                                // 尝试将Excel序列号转换为日期
                                if (typeof cell === 'number' && cell > 0 && cell < 700000) {
                                    const date = new Date(Math.round((cell - 25569) * 86400 * 1000));
                                    if (!isNaN(date.getTime())) {
                                        return date.toISOString().split('T')[0];
                                    }
                                }
                            }
                            return cell;
                        });
                    });
                    
                    // 生成更有意义的数据类型名称
                    let dataTypeName = generateMeaningfulTypeName(headers, fileName, sheetName);
                    
                    const dataType = {
                        id: `${fileName}_${sheetName}`,
                        name: dataTypeName,
                        file: fileName,
                        sheet: sheetName,
                        headers: headers,
                        data: filteredData
                    };
                    
                    dataTypes.push(dataType);
                }
            });
            
            // 生成数据类型按钮
            generateDataTypeButtons();
        }
        
        // 生成数据类型按钮
        function generateDataTypeButtons() {
            const buttonContainer = document.getElementById('dataTypeButtons');
            const dataTypeSection = document.getElementById('dataTypeSection');
            
            if (dataTypes.length > 0) {
                buttonContainer.innerHTML = '';
                
                dataTypes.forEach(dataType => {
                    const button = document.createElement('button');
                    button.className = 'btn';
                    button.textContent = dataType.name;
                    button.onclick = function() {
                        showDataTypeTable(dataType);
                    };
                    buttonContainer.appendChild(button);
                });
                
                dataTypeSection.style.display = 'block';
            }
        }
        
        // 显示数据类型表格
        function showDataTypeTable(dataType) {
            const tableContainer = document.getElementById('dataTableContainer');
            const tableTitle = document.getElementById('tableTitle');
            const dataTableSection = document.getElementById('dataTableSection');
            
            tableTitle.textContent = dataType.name;
            
            // 分页设置
            const rowsPerPage = 10; // 每页显示10行
            const totalRows = dataType.data.length;
            const totalPages = Math.ceil(totalRows / rowsPerPage);
            let currentPage = 1;
            
            // 创建表格容器
            const tableWrapper = document.createElement('div');
            tableWrapper.style.width = '100%';
            
            // 创建表格
            const tableElement = document.createElement('table');
            tableElement.className = 'table';
            tableElement.style.width = '100%';
            tableElement.style.borderCollapse = 'collapse';
            
            // 创建表头
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            dataType.headers.forEach(header => {
                const th = document.createElement('th');
                th.textContent = header;
                th.style.padding = '10px';
                th.style.borderBottom = '2px solid #8A2BE2';
                th.style.backgroundColor = '#f8f9fa';
                th.style.fontWeight = 'bold';
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            tableElement.appendChild(thead);
            
            // 创建表体
            const tbody = document.createElement('tbody');
            tbody.id = 'tableBody';
            tableElement.appendChild(tbody);
            
            // 渲染当前页的数据
            function renderTablePage(page) {
                tbody.innerHTML = '';
                const startIndex = (page - 1) * rowsPerPage;
                const endIndex = Math.min(startIndex + rowsPerPage, totalRows);
                const pageData = dataType.data.slice(startIndex, endIndex);
                
                pageData.forEach((row, index) => {
                    const tr = document.createElement('tr');
                    tr.style.borderBottom = '1px solid #e8e8e8';
                    row.forEach(cell => {
                        const td = document.createElement('td');
                        td.textContent = cell || '';
                        td.style.padding = '8px 10px';
                        td.style.whiteSpace = 'nowrap';
                        td.style.overflow = 'hidden';
                        td.style.textOverflow = 'ellipsis';
                        td.style.maxWidth = '200px';
                        tr.appendChild(td);
                    });
                    tbody.appendChild(tr);
                });
            }
            
            // 渲染第一页
            renderTablePage(currentPage);
            
            tableWrapper.appendChild(tableElement);
            
            // 创建分页控件
            if (totalPages > 1) {
                const paginationContainer = document.createElement('div');
                paginationContainer.style.display = 'flex';
                paginationContainer.style.justifyContent = 'center';
                paginationContainer.style.alignItems = 'center';
                paginationContainer.style.gap = '10px';
                paginationContainer.style.marginTop = '15px';
                paginationContainer.style.padding = '10px';
                paginationContainer.style.background = 'white';
                paginationContainer.style.borderRadius = '8px';
                paginationContainer.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
                
                // 上一页按钮
                const prevButton = document.createElement('button');
                prevButton.innerHTML = '◀ 上一页';
                prevButton.style.padding = '6px 12px';
                prevButton.style.background = '#8A2BE2';
                prevButton.style.color = 'white';
                prevButton.style.border = 'none';
                prevButton.style.borderRadius = '4px';
                prevButton.style.cursor = 'pointer';
                prevButton.disabled = currentPage === 1;
                prevButton.style.opacity = currentPage === 1 ? '0.5' : '1';
                
                // 页码显示
                const pageInfo = document.createElement('span');
                pageInfo.textContent = `第 ${currentPage} 页 / 共 ${totalPages} 页 (共 ${totalRows} 条数据)`;
                pageInfo.style.fontSize = '14px';
                pageInfo.style.color = '#333';
                
                // 下一页按钮
                const nextButton = document.createElement('button');
                nextButton.innerHTML = '下一页 ▶';
                nextButton.style.padding = '6px 12px';
                nextButton.style.background = '#8A2BE2';
                nextButton.style.color = 'white';
                nextButton.style.border = 'none';
                nextButton.style.borderRadius = '4px';
                nextButton.style.cursor = 'pointer';
                nextButton.disabled = currentPage === totalPages;
                nextButton.style.opacity = currentPage === totalPages ? '0.5' : '1';
                
                // 添加事件监听
                prevButton.addEventListener('click', () => {
                    if (currentPage > 1) {
                        currentPage--;
                        renderTablePage(currentPage);
                        pageInfo.textContent = `第 ${currentPage} 页 / 共 ${totalPages} 页 (共 ${totalRows} 条数据)`;
                        prevButton.disabled = currentPage === 1;
                        prevButton.style.opacity = currentPage === 1 ? '0.5' : '1';
                        nextButton.disabled = currentPage === totalPages;
                        nextButton.style.opacity = currentPage === totalPages ? '0.5' : '1';
                    }
                });
                
                nextButton.addEventListener('click', () => {
                    if (currentPage < totalPages) {
                        currentPage++;
                        renderTablePage(currentPage);
                        pageInfo.textContent = `第 ${currentPage} 页 / 共 ${totalPages} 页 (共 ${totalRows} 条数据)`;
                        prevButton.disabled = currentPage === 1;
                        prevButton.style.opacity = currentPage === 1 ? '0.5' : '1';
                        nextButton.disabled = currentPage === totalPages;
                        nextButton.style.opacity = currentPage === totalPages ? '0.5' : '1';
                    }
                });
                
                paginationContainer.appendChild(prevButton);
                paginationContainer.appendChild(pageInfo);
                paginationContainer.appendChild(nextButton);
                tableWrapper.appendChild(paginationContainer);
            }
            
            // 清空容器并添加新内容
            tableContainer.innerHTML = '';
            tableContainer.appendChild(tableWrapper);
            dataTableSection.style.display = 'block';
            
            // 添加折叠功能
            const tableHeader = document.createElement('div');
            tableHeader.style.display = 'flex';
            tableHeader.style.justifyContent = 'space-between';
            tableHeader.style.alignItems = 'center';
            tableHeader.style.cursor = 'pointer';
            tableHeader.style.padding = '10px 0';
            tableHeader.style.borderBottom = '2px solid #8A2BE2';
            tableHeader.style.marginBottom = '10px';
            
            const toggleButton = document.createElement('button');
            toggleButton.innerHTML = '▼ 收起表格';
            toggleButton.style.background = 'none';
            toggleButton.style.border = 'none';
            toggleButton.style.color = '#8A2BE2';
            toggleButton.style.cursor = 'pointer';
            toggleButton.style.fontSize = '14px';
            toggleButton.style.fontWeight = 'bold';
            
            tableHeader.appendChild(toggleButton);
            tableContainer.insertBefore(tableHeader, tableWrapper);
            
            // 折叠功能
            let isTableExpanded = true;
            tableHeader.addEventListener('click', () => {
                isTableExpanded = !isTableExpanded;
                if (isTableExpanded) {
                    tableWrapper.style.display = 'block';
                    toggleButton.innerHTML = '▼ 收起表格';
                } else {
                    tableWrapper.style.display = 'none';
                    toggleButton.innerHTML = '▶ 展开表格';
                }
            });
        }
        
        // 更新Excel文件列表
        function updateExcelFileList() {
            const fileList = document.getElementById('excelFileList');
            const fileListItems = document.getElementById('excelFileListItems');
            
            if (uploadedExcelFiles.length > 0) {
                fileList.style.display = 'block';
                fileListItems.innerHTML = '';
                
                uploadedExcelFiles.forEach((file, index) => {
                    const li = document.createElement('li');
                    li.textContent = `${index + 1}. ${file.name} (${(file.size / 1024).toFixed(2)} KB)`;
                    fileListItems.appendChild(li);
                });
            } else {
                fileList.style.display = 'none';
            }
        }
        
        // 合并Excel文件
        function mergeExcelFiles() {
            if (uploadedExcelFiles.length === 0) {
                alert('请先上传Excel文件');
                return;
            }
            
            const mergeResult = document.getElementById('mergeResult');
            const downloadBtn = document.getElementById('downloadMergeBtn');
            
            // 显示加载状态
            mergeResult.innerHTML = '<p style="color: #8A2BE2; font-weight: bold;">正在合并Excel文件...</p>';
            
            setTimeout(() => {
                try {
                    // 创建新的工作簿
                    mergedWorkbook = XLSX.utils.book_new();
                    
                    // 合并所有工作表
                    excelData.forEach((item, fileIndex) => {
                        const workbook = item.workbook;
                        const file = item.file;
                        
                        // 遍历所有工作表
                        workbook.SheetNames.forEach(sheetName => {
                            const worksheet = workbook.Sheets[sheetName];
                            // 为工作表名称添加文件标识
                            const newSheetName = `${file.name.replace(/\.xlsx?$/, '')}_${sheetName}`;
                            XLSX.utils.book_append_sheet(mergedWorkbook, worksheet, newSheetName);
                        });
                    });
                    
                    // 显示合并结果
                    mergeResult.innerHTML = `
                        <div style="padding: 15px; background: #f3e5f5; border-radius: 8px;">
                            <h4 style="color: #8A2BE2; margin-bottom: 10px;">合并结果</h4>
                            <p>合并成功！已将 ${uploadedExcelFiles.length} 个Excel文件合并为一个文件。</p>
                            <p><strong>合并的文件：</strong></p>
                            <ul style="margin-top: 10px; padding-left: 20px;">
                                ${uploadedExcelFiles.map(file => `<li>${file.name}</li>`).join('')}
                            </ul>
                            <p style="margin-top: 10px;"><strong>合并工作表数量：</strong> ${mergedWorkbook.SheetNames.length}</p>
                        </div>
                    `;
                    downloadBtn.style.display = 'block';
                } catch (error) {
                    mergeResult.innerHTML = `<p style="color: #dc3545; font-weight: bold;">合并失败：${error.message}</p>`;
                }
            }, 1000);
        }
        
        // 生成Excel图表
        function generateExcelCharts() {
            if (uploadedExcelFiles.length === 0) {
                alert('请先上传Excel文件');
                return;
            }
            
            const chartsContainer = document.getElementById('chartsContainer');
            const chartsSection = document.getElementById('chartsSection');
            
            // 显示加载状态
            chartsContainer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 300px;"><span style="font-size: 24px;">📊 生成中...</span></div>';
            chartsSection.style.display = 'block';
            
            setTimeout(() => {
                try {
                    // 分析Excel数据生成图表
                    const chartsData = analyzeExcelDataForCharts();
                    renderDynamicCharts(chartsData);
                } catch (error) {
                    console.error('生成图表失败:', error);
                    chartsContainer.innerHTML = '<p style="color: #dc3545; text-align: center; padding: 50px;">生成失败</p>';
                }
            }, 1000);
        }
        
        // 分析Excel数据以生成图表
        function analyzeExcelDataForCharts() {
            const chartsData = [];
            
            excelData.forEach((item, fileIndex) => {
                const workbook = item.workbook;
                const fileName = item.file.name;
                
                workbook.SheetNames.forEach(sheetName => {
                    const worksheet = workbook.Sheets[sheetName];
                    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                    
                    if (jsonData.length > 0) {
                        // 自动识别真正的表头
                        let headerRowIndex = 0;
                        
                        // 遍历前几行，找到包含最多非空值的行作为表头
                        let maxNonEmpty = 0;
                        for (let i = 0; i < Math.min(5, jsonData.length); i++) {
                            const row = jsonData[i];
                            const nonEmptyCount = row.filter(cell => cell && String(cell).trim() !== '').length;
                            if (nonEmptyCount > maxNonEmpty) {
                                maxNonEmpty = nonEmptyCount;
                                headerRowIndex = i;
                            }
                        }
                        
                        // 提取表头和数据
                        const headers = jsonData[headerRowIndex];
                        const data = jsonData.slice(headerRowIndex + 1);
                        
                        // 过滤掉空数据行
                        const filteredData = data.filter(row => {
                            return row.filter(cell => cell && String(cell).trim() !== '').length > 0;
                        });
                        
                        if (filteredData.length > 0) {
                            // 生成更有意义的图表标题
                            const chartTitle = generateMeaningfulTypeName(headers, fileName, sheetName);
                            
                            const chartData = {
                                id: `${fileName}_${sheetName}`,
                                title: chartTitle,
                                headers: headers,
                                data: filteredData,
                                chartType: determineChartType(headers, filteredData)
                            };
                            chartsData.push(chartData);
                        }
                    }
                });
            });
            
            return chartsData;
        }
        
        // 确定图表类型
        function determineChartType(headers, data) {
            // 分析数据特征确定图表类型
            if (data.length === 0) return 'bar';
            
            // 检查是否有材料名称、材料消耗等字段
            const hasMaterial = headers.some(h => String(h).includes('材料') || String(h).includes('物料') || String(h).includes('物品'));
            const hasQuantity = headers.some(h => String(h).includes('数量') || String(h).includes('消耗') || String(h).includes('用量'));
            const hasPrice = headers.some(h => String(h).includes('单价') || String(h).includes('价格'));
            
            // 对于材料消耗数据，优先使用柱状图
            if (hasMaterial && (hasQuantity || hasPrice)) {
                return 'bar';
            }
            
            // 检查是否有申请人、完成人、申请类型、申请数量等字段
            const hasApplicant = headers.some(h => String(h).includes('申请人') || String(h).includes('申请方') || String(h).includes('完成人'));
            const hasType = headers.some(h => String(h).includes('类型') || String(h).includes('类别'));
            
            // 对于成果项目数据，优先使用柱状图
            if (hasApplicant || hasType || hasQuantity) {
                return 'bar';
            }
            
            // 检查是否有日期列
            const dateIndex = headers.findIndex(h => String(h).includes('日期') || String(h).includes('时间') || String(h).includes('月份') || String(h).includes('年'));
            
            // 如果有日期列，使用折线图
            if (dateIndex !== -1) {
                return 'line';
            }
            
            // 默认使用柱状图
            return 'bar';
        }
        
        // 渲染动态图表
        function renderDynamicCharts(chartsData) {
            const chartsContainer = document.getElementById('chartsContainer');
            const scrollLeftBtn = document.getElementById('scrollLeftBtn');
            const scrollRightBtn = document.getElementById('scrollRightBtn');
            const chartsContainerWrapper = document.getElementById('chartsContainerWrapper');
            
            if (chartsData.length === 0) {
                chartsContainer.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">没有找到可生成图表的数据</p>';
                scrollLeftBtn.style.display = 'none';
                scrollRightBtn.style.display = 'none';
                return;
            }
            
            chartsContainer.innerHTML = '';
            
            // 显示滑动按钮
            scrollLeftBtn.style.display = 'block';
            scrollRightBtn.style.display = 'block';
            
            // 渲染所有图表
            chartsData.forEach((chartData, index) => {
                const chartElement = document.createElement('div');
                chartElement.style.minWidth = '400px';
                chartElement.style.width = '400px';
                chartElement.style.padding = '20px';
                chartElement.style.background = 'white';
                chartElement.style.borderRadius = '8px';
                chartElement.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
                chartElement.style.overflow = 'hidden';
                chartElement.style.transition = 'all 0.3s ease';
                chartElement.style.flexShrink = '0';
                
                // 添加折叠功能
                const chartHeader = document.createElement('div');
                chartHeader.style.display = 'flex';
                chartHeader.style.justifyContent = 'space-between';
                chartHeader.style.alignItems = 'center';
                chartHeader.style.cursor = 'pointer';
                chartHeader.style.paddingBottom = '15px';
                
                const chartTitle = document.createElement('h4');
                chartTitle.textContent = chartData.title;
                chartTitle.style.margin = '0';
                chartTitle.style.fontSize = '14px';
                chartTitle.style.whiteSpace = 'nowrap';
                chartTitle.style.overflow = 'hidden';
                chartTitle.style.textOverflow = 'ellipsis';
                chartTitle.style.maxWidth = '300px';
                
                const toggleButton = document.createElement('button');
                toggleButton.innerHTML = '▼';
                toggleButton.style.background = 'none';
                toggleButton.style.border = 'none';
                toggleButton.style.fontSize = '12px';
                toggleButton.style.cursor = 'pointer';
                toggleButton.style.transition = 'transform 0.3s ease';
                
                chartHeader.appendChild(chartTitle);
                chartHeader.appendChild(toggleButton);
                chartElement.appendChild(chartHeader);
                
                const chartContainer = document.createElement('div');
                chartContainer.className = 'chart-placeholder';
                chartContainer.style.height = '300px';
                chartContainer.style.display = 'flex';
                chartContainer.style.alignItems = 'center';
                chartContainer.style.justifyContent = 'center';
                chartContainer.style.overflow = 'hidden';
                
                // 根据图表类型渲染
                if (chartData.chartType === 'bar') {
                    renderBarChart(chartContainer, chartData);
                } else if (chartData.chartType === 'line') {
                    renderLineChart(chartContainer, chartData);
                } else if (chartData.chartType === 'pie') {
                    renderPieChart(chartContainer, chartData);
                }
                
                chartElement.appendChild(chartContainer);
                chartsContainer.appendChild(chartElement);
                
                // 添加折叠功能
                let isExpanded = true;
                chartHeader.addEventListener('click', () => {
                    isExpanded = !isExpanded;
                    if (isExpanded) {
                        chartContainer.style.height = '300px';
                        toggleButton.style.transform = 'rotate(0deg)';
                    } else {
                        chartContainer.style.height = '0';
                        toggleButton.style.transform = 'rotate(-90deg)';
                    }
                });
            });
            
            // 更新滑动按钮状态
            updateScrollButtons();
            
            // 监听滚动事件
            chartsContainerWrapper.addEventListener('scroll', updateScrollButtons);
        }
        
        // 滑动图表
        function scrollCharts(direction) {
            const chartsContainerWrapper = document.getElementById('chartsContainerWrapper');
            const scrollAmount = 420; // 每次滑动一个图表的宽度（400px + 20px间距）
            
            if (direction === 'left') {
                chartsContainerWrapper.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            } else {
                chartsContainerWrapper.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            }
        }
        
        // 更新滑动按钮状态
        function updateScrollButtons() {
            const chartsContainerWrapper = document.getElementById('chartsContainerWrapper');
            const scrollLeftBtn = document.getElementById('scrollLeftBtn');
            const scrollRightBtn = document.getElementById('scrollRightBtn');
            
            if (!chartsContainerWrapper || !scrollLeftBtn || !scrollRightBtn) return;
            
            const scrollLeft = chartsContainerWrapper.scrollLeft;
            const scrollWidth = chartsContainerWrapper.scrollWidth;
            const clientWidth = chartsContainerWrapper.clientWidth;
            
            // 判断是否显示左滑动按钮
            if (scrollLeft <= 0) {
                scrollLeftBtn.style.opacity = '0.3';
                scrollLeftBtn.style.cursor = 'not-allowed';
            } else {
                scrollLeftBtn.style.opacity = '1';
                scrollLeftBtn.style.cursor = 'pointer';
            }
            
            // 判断是否显示右滑动按钮
            if (scrollLeft + clientWidth >= scrollWidth) {
                scrollRightBtn.style.opacity = '0.3';
                scrollRightBtn.style.cursor = 'not-allowed';
            } else {
                scrollRightBtn.style.opacity = '1';
                scrollRightBtn.style.cursor = 'pointer';
            }
        }
        
        // 渲染柱状图
        function renderBarChart(container, chartData) {
            const headers = chartData.headers;
            const data = chartData.data;
            
            if (data.length === 0) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">数据不足，无法生成图表</p>';
                return;
            }
            
            // 找到材料名称列
            let materialIndex = -1;
            for (let i = 0; i < headers.length; i++) {
                const header = String(headers[i]);
                if (header.includes('材料') || header.includes('物料') || header.includes('物品') || header.includes('名称')) {
                    materialIndex = i;
                    break;
                }
            }
            
            // 找到数量列
            let quantityIndex = -1;
            for (let i = 0; i < headers.length; i++) {
                if (i !== materialIndex) {
                    const header = String(headers[i]);
                    if (header.includes('数量') || header.includes('消耗') || header.includes('用量')) {
                        quantityIndex = i;
                        break;
                    }
                }
            }
            
            // 找到单价列
            let priceIndex = -1;
            for (let i = 0; i < headers.length; i++) {
                if (i !== materialIndex && i !== quantityIndex) {
                    const header = String(headers[i]);
                    if (header.includes('单价') || header.includes('价格')) {
                        priceIndex = i;
                        break;
                    }
                }
            }
            
            // 如果找到材料名称列，按材料汇总数据
            if (materialIndex !== -1) {
                const materialData = {};
                
                data.forEach(row => {
                    const material = row[materialIndex];
                    if (material) {
                        if (!materialData[material]) {
                            materialData[material] = {
                                quantity: 0,
                                price: 0,
                                count: 0
                            };
                        }
                        
                        if (quantityIndex !== -1) {
                            materialData[material].quantity += parseFloat(row[quantityIndex]) || 0;
                        }
                        
                        if (priceIndex !== -1) {
                            materialData[material].price += parseFloat(row[priceIndex]) || 0;
                            materialData[material].count += 1;
                        }
                    }
                });
                
                // 转换为数组格式
                const validData = Object.entries(materialData).map(([material, data]) => ({
                    category: material,
                    value: data.quantity || data.price,
                    quantity: data.quantity,
                    price: data.count > 0 ? (data.price / data.count).toFixed(2) : 0
                }));
                
                if (validData.length === 0) {
                    container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">没有有效数据，无法生成图表</p>';
                    return;
                }
                
                // 生成柱状图
                let chartHtml = `
                    <div style="display: flex; flex-direction: column; height: 100%; width: 100%;">
                        <!-- 图表标题 -->
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <h5 style="margin: 0; font-size: 14px; color: #333;">${chartData.title}</h5>
                        </div>
                        
                        <!-- 图表容器（可水平滚动） -->
                        <div style="flex: 1; position: relative;">
                            <div style="position: absolute; left: 0; top: 0; bottom: 60px; width: 2px; background: #333;"></div>
                            <div style="position: absolute; left: 0; bottom: 0; right: 0; height: 2px; background: #333;"></div>
                            
                            <!-- 可滚动的图表内容 -->
                            <div style="overflow-x: auto; overflow-y: hidden; height: 100%; padding-bottom: 60px; scrollbar-width: thin; -webkit-overflow-scrolling: touch;">
                                <div style="display: flex; align-items: flex-end; height: 100%; min-width: ${validData.length * 150}px; padding-left: 20px; padding-right: 20px;">
                `;
                
                const maxValue = Math.max(...validData.map(item => item.value), 1);
                
                validData.forEach((item, index) => {
                    // 确保高度至少为30%，使柱体更高更明显
                    const height = Math.max((item.value / maxValue) * 90, 30);
                    const color = getRandomColor(index);
                    
                    // 处理过长的材料名称
                    const materialName = item.category.length > 12 ? item.category.substring(0, 12) + '...' : item.category;
                    
                    chartHtml += `
                        <div style="display: flex; flex-direction: column; align-items: center; width: 130px; margin: 0 10px; flex-shrink: 0;">
                            <div style="width: 50px; height: ${height}%; background: ${color}; border-radius: 4px 4px 0 0; border: 1px solid ${color};"></div>
                            <div style="margin-top: 8px; font-size: 12px; text-align: center; word-break: break-word; max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                <span title="${item.category}">${materialName}</span>
                            </div>
                            ${item.quantity > 0 ? `<div style="margin-top: 3px; font-size: 11px; text-align: center;">数量: ${formatNumber(item.quantity)}</div>` : ''}
                            ${item.price > 0 ? `<div style="margin-top: 3px; font-size: 11px; text-align: center;">单价: ${formatNumber(item.price)}</div>` : ''}
                        </div>
                    `;
                });
                
                chartHtml += `
                                </div>
                            </div>
                        </div>
                    </div>
                `;
                
                container.innerHTML = chartHtml;
                return;
            }
            
            // 原有逻辑：找到合适的分类列
            let categoryIndex = -1;
            
            // 优先选择申请人、完成人或申请类型作为分类列
            for (let i = 0; i < headers.length; i++) {
                const header = String(headers[i]);
                if (header.includes('申请人') || header.includes('申请方') || header.includes('完成人') || header.includes('类型') || header.includes('类别')) {
                    categoryIndex = i;
                    break;
                }
            }
            
            // 如果没有找到申请人或类型列，使用第一列
            if (categoryIndex === -1) {
                categoryIndex = 0;
            }
            
            // 找到数值列
            let valueIndex = -1;
            for (let i = 0; i < headers.length; i++) {
                if (i !== categoryIndex) {
                    const header = String(headers[i]);
                    if (header.includes('数量') || header.includes('申请数量') || header.includes('金额') || header.includes('数值') || header.includes('费用')) {
                        valueIndex = i;
                        break;
                    }
                }
            }
            
            // 提取分类数据
            const categories = data.map(row => row[categoryIndex] || '');
            
            // 计算每个分类的值
            const categoryValue = {};
            
            if (valueIndex !== -1) {
                // 如果找到数值列，对每个分类的值进行求和
                data.forEach(row => {
                    const category = row[categoryIndex];
                    const value = parseFloat(row[valueIndex]) || 0;
                    if (category) {
                        categoryValue[category] = (categoryValue[category] || 0) + value;
                    }
                });
            } else {
                // 如果没有找到数值列，统计每个分类的数量
                categories.forEach(category => {
                    if (category) {
                        categoryValue[category] = (categoryValue[category] || 0) + 1;
                    }
                });
            }
            
            // 转换为数组格式
            const validData = Object.entries(categoryValue).map(([category, value]) => ({
                category: category,
                value: value
            }));
            
            if (validData.length === 0) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">没有有效数据，无法生成图表</p>';
                return;
            }
            
            // 生成柱状图
            let chartHtml = `
                <div style="display: flex; flex-direction: column; height: 100%; width: 100%;">
                    <!-- 图表标题 -->
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <h5 style="margin: 0; font-size: 14px; color: #333;">${chartData.title}</h5>
                    </div>
                    
                    <!-- 图表容器（可水平滚动） -->
                    <div style="flex: 1; position: relative;">
                        <div style="position: absolute; left: 0; top: 0; bottom: 30px; width: 2px; background: #333;"></div>
                        <div style="position: absolute; left: 0; bottom: 0; right: 0; height: 2px; background: #333;"></div>
                        
                        <!-- 可滚动的图表内容 -->
                        <div style="overflow-x: auto; overflow-y: hidden; height: 100%; padding-bottom: 30px; scrollbar-width: thin; -webkit-overflow-scrolling: touch;">
                            <div style="display: flex; align-items: flex-end; height: 100%; min-width: ${validData.length * 120}px; padding-left: 20px; padding-right: 20px;">
            `;
            
            const maxValue = Math.max(...validData.map(item => item.value), 1);
            
            validData.forEach((item, index) => {
                // 确保高度至少为30%，使柱体更高更明显
                const height = Math.max((item.value / maxValue) * 90, 30);
                const color = getRandomColor(index);
                
                // 处理过长的分类名称
                const categoryName = item.category.length > 10 ? item.category.substring(0, 10) + '...' : item.category;
                
                chartHtml += `
                    <div style="display: flex; flex-direction: column; align-items: center; width: 100px; margin: 0 10px; flex-shrink: 0;">
                        <div style="width: 50px; height: ${height}%; background: ${color}; border-radius: 4px 4px 0 0; border: 1px solid ${color};"></div>
                        <div style="margin-top: 8px; font-size: 12px; text-align: center; word-break: break-word; max-width: 90px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            <span title="${item.category}">${categoryName}</span>
                        </div>
                        <div style="margin-top: 5px; font-size: 12px; font-weight: bold; white-space: nowrap; text-align: center;">${formatNumber(item.value)}</div>
                    </div>
                `;
            });
            
            chartHtml += `
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            container.innerHTML = chartHtml;
        }
        
        // 渲染折线图
        function renderLineChart(container, chartData) {
            const headers = chartData.headers;
            const data = chartData.data;
            
            // 检查是否有材料名称、材料消耗等字段，如果有则不使用折线图
            const hasMaterial = headers.some(h => String(h).includes('材料') || String(h).includes('物料') || String(h).includes('物品'));
            const hasQuantity = headers.some(h => String(h).includes('数量') || String(h).includes('消耗') || String(h).includes('用量'));
            const hasPrice = headers.some(h => String(h).includes('单价') || String(h).includes('价格'));
            
            // 对于材料消耗数据，使用柱状图
            if (hasMaterial && (hasQuantity || hasPrice)) {
                renderBarChart(container, chartData);
                return;
            }
            
            // 检查是否有申请人、完成人、申请类型等字段，如果有则不使用折线图
            const hasApplicant = headers.some(h => String(h).includes('申请人') || String(h).includes('申请方') || String(h).includes('完成人'));
            const hasType = headers.some(h => String(h).includes('类型') || String(h).includes('类别'));
            
            if (hasApplicant || hasType) {
                // 对于成果项目数据，使用柱状图
                renderBarChart(container, chartData);
                return;
            }
            
            // 找到日期列
            const dateIndex = headers.findIndex(h => String(h).includes('日期') || String(h).includes('时间') || String(h).includes('月份') || String(h).includes('年'));
            if (dateIndex === -1) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">未找到日期列，无法生成趋势图</p>';
                return;
            }
            
            // 找到数值列
            let valueIndex = -1;
            for (let i = 0; i < headers.length; i++) {
                if (i !== dateIndex) {
                    const header = String(headers[i]);
                    if (header.includes('金额') || header.includes('数量') || header.includes('数值') || header.includes('费用')) {
                        valueIndex = i;
                        break;
                    }
                }
            }
            
            // 如果没有找到明确的数值列，使用第一个非日期列
            if (valueIndex === -1) {
                for (let i = 0; i < headers.length; i++) {
                    if (i !== dateIndex) {
                        valueIndex = i;
                        break;
                    }
                }
            }
            
            if (valueIndex === -1) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">未找到数值列，无法生成趋势图</p>';
                return;
            }
            
            // 提取数据
            const dates = data.map(row => row[dateIndex] || '');
            const values = data.map(row => parseFloat(row[valueIndex]) || 0);
            
            // 过滤空数据
            const validData = dates.map((date, index) => ({
                date: date,
                value: values[index]
            })).filter(item => item.date && item.value > 0);
            
            if (validData.length === 0) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">没有有效数据，无法生成图表</p>';
                return;
            }
            
            // 生成折线图
            let chartHtml = `
                <div style="display: flex; flex-direction: column; height: 100%; width: 100%;">
                    <!-- 图表标题 -->
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <h5 style="margin: 0; font-size: 14px; color: #333;">${chartData.title}</h5>
                    </div>
                    
                    <!-- 图表容器（可水平滚动） -->
                    <div style="flex: 1; position: relative;">
                        <div style="position: absolute; left: 0; top: 0; bottom: 30px; width: 2px; background: #333;"></div>
                        <div style="position: absolute; left: 0; bottom: 0; right: 0; height: 2px; background: #333;"></div>
                        
                        <!-- 可滚动的图表内容 -->
                        <div style="overflow-x: auto; overflow-y: hidden; height: 100%; padding-bottom: 30px; scrollbar-width: thin; -webkit-overflow-scrolling: touch;">
                            <div style="width: ${validData.length * 120}px; height: 100%; position: relative;">
                                <svg width="100%" height="100%" style="position: absolute; top: 0; left: 0;">
            `;
            
            const maxValue = Math.max(...validData.map(item => item.value), 1);
            
            // 绘制折线
            let linePoints = '';
            validData.forEach((item, index) => {
                const x = ((index + 1) / (validData.length + 1)) * 100;
                const y = 100 - (item.value / maxValue) * 80;
                linePoints += `${x}% ${y}%, `;
            });
            linePoints = linePoints.slice(0, -2);
            
            chartHtml += `
                                    <polyline points="${linePoints}" fill="none" stroke="#8A2BE2" stroke-width="2"/>
                                    ${validData.map((item, index) => {
                                        const x = ((index + 1) / (validData.length + 1)) * 100;
                                        const y = 100 - (item.value / maxValue) * 80;
                                        return `<circle cx="${x}%" cy="${y}%" r="4" fill="#8A2BE2"/>`;
                                    }).join('')}
                                </svg>
            `;
            
            // 绘制日期标签
            chartHtml += `
                                <!-- 日期标签 -->
                                <div style="position: absolute; bottom: -25px; left: 0; width: 100%; display: flex; justify-content: space-around;">
                                    ${validData.map(item => {
                                        // 处理过长的日期标签
                                        const dateLabel = item.date.length > 10 ? item.date.substring(0, 10) + '...' : item.date;
                                        return `<div style="font-size: 12px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 90px;">
                                            <span title="${item.date}">${dateLabel}</span>
                                        </div>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            container.innerHTML = chartHtml;
        }
        
        // 渲染饼图
        function renderPieChart(container, chartData) {
            const headers = chartData.headers;
            const data = chartData.data;
            
            if (headers.length === 0 || data.length === 0) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">数据不足，无法生成图表</p>';
                return;
            }
            
            // 找到分类列和数值列
            let categoryIndex = 0;
            let valueIndex = -1;
            
            // 尝试找到数值列
            for (let i = 0; i < headers.length; i++) {
                const header = String(headers[i]);
                if (header.includes('金额') || header.includes('数量') || header.includes('数值') || header.includes('费用')) {
                    valueIndex = i;
                    break;
                }
            }
            
            // 如果没有找到明确的数值列，使用第二列
            if (valueIndex === -1 && headers.length > 1) {
                valueIndex = 1;
            }
            
            if (valueIndex === -1) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">未找到数值列，无法生成图表</p>';
                return;
            }
            
            // 提取数据
            const categories = [];
            const values = [];
            
            data.forEach(row => {
                if (row[categoryIndex]) {
                    categories.push(row[categoryIndex]);
                    values.push(parseFloat(row[valueIndex]) || 0);
                }
            });
            
            // 过滤空数据
            const validData = categories.map((cat, index) => ({
                category: cat,
                value: values[index]
            })).filter(item => item.category && item.value > 0);
            
            if (validData.length === 0) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 50px;">没有有效数据，无法生成图表</p>';
                return;
            }
            
            const total = validData.reduce((sum, item) => sum + item.value, 0);
            
            // 计算饼图角度
            let currentAngle = 0;
            const pieSegments = [];
            
            validData.forEach((item, index) => {
                const percentage = total > 0 ? (item.value / total) : 0;
                const angle = percentage * 360;
                pieSegments.push({
                    name: item.category,
                    value: item.value,
                    percentage: (percentage * 100).toFixed(1),
                    color: getRandomColor(index),
                    startAngle: currentAngle,
                    endAngle: currentAngle + angle
                });
                currentAngle += angle;
            });
            
            // 生成饼图
            let chartHtml = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; width: 100%;">
                    <div style="width: 150px; height: 150px; border-radius: 50%; background: conic-gradient(
                        ${pieSegments.map(segment => `${segment.color} ${segment.startAngle}deg ${segment.endAngle}deg`).join(', ')}
                    ); margin-bottom: 15px;"></div>
                    <div style="width: 100%; max-height: 150px; overflow-y: auto;">
                        ${pieSegments.map(segment => `
                            <div style="display: flex; align-items: center; margin: 2px 0; font-size: 12px;">
                                <div style="width: 12px; height: 12px; background: ${segment.color}; margin-right: 5px;"></div>
                                <span>${segment.name}: ${segment.value} (${segment.percentage}%)</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            
            container.innerHTML = chartHtml;
        }
        
        // 生成成本类型分布图表
        function generateCostTypeChart(container) {
            // 分析Excel数据，提取成本类型
            const costData = analyzeCostData();
            
            // 创建图表
            container.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
                    <div style="font-size: 48px; margin-bottom: 10px;">📊</div>
                    <p style="text-align: center;">成本类型分布</p>
                    <div style="margin-top: 10px; width: 100%;">
                        ${costData.map(item => `
                            <div style="display: flex; align-items: center; margin: 5px 0;">
                                <div style="width: 20px; height: 20px; background: ${item.color}; margin-right: 10px;"></div>
                                <span>${item.name}: ${item.percentage}%</span>
                                <div style="flex: 1; height: 20px; background: #f0f0f0; margin-left: 10px; border-radius: 10px;">
                                    <div style="width: ${item.percentage}%; height: 100%; background: ${item.color}; border-radius: 10px;"></div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }
        
        // 生成材料消耗趋势图表
        function generateMaterialTrendChart(container) {
            // 分析Excel数据，提取材料消耗趋势
            const trendData = analyzeMaterialTrend();
            
            // 创建图表
            container.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
                    <div style="font-size: 48px; margin-bottom: 10px;">📈</div>
                    <p style="text-align: center;">材料消耗趋势</p>
                    <div style="margin-top: 10px; width: 100%; height: 150px; position: relative;">
                        <div style="position: absolute; bottom: 0; left: 0; width: 100%; height: 120px; border-bottom: 2px solid #333; border-left: 2px solid #333;">
                            ${trendData.map((item, index) => `
                                <div style="position: absolute; bottom: 0; left: ${(index + 1) * 20 - 10}%; width: 4px; height: ${item.value}%; background: #8A2BE2; border-radius: 2px 2px 0 0;"></div>
                                <div style="position: absolute; bottom: -20px; left: ${(index + 1) * 20 - 10}%; font-size: 12px;">${item.month}</div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
        }
        
        // 生成项目工时成本占比图表
        function generateLaborCostChart(container) {
            // 分析Excel数据，提取工时成本占比
            const laborData = analyzeLaborCost();
            
            // 计算饼图角度
            let currentAngle = 0;
            const pieSegments = laborData.map(item => {
                const angle = (item.percentage / 100) * 360;
                const segment = {
                    name: item.name,
                    percentage: item.percentage,
                    color: item.color,
                    startAngle: currentAngle,
                    endAngle: currentAngle + angle
                };
                currentAngle += angle;
                return segment;
            });
            
            // 创建图表
            container.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
                    <div style="font-size: 48px; margin-bottom: 10px;">🥧</div>
                    <p style="text-align: center;">项目工时成本占比</p>
                    <div style="margin-top: 10px; width: 150px; height: 150px; border-radius: 50%; background: conic-gradient(
                        ${pieSegments.map(segment => `${segment.color} ${segment.startAngle}deg ${segment.endAngle}deg`).join(', ')}
                    );"></div>
                    <div style="margin-top: 10px; width: 100%;">
                        ${laborData.map(item => `
                            <div style="display: flex; align-items: center; margin: 2px 0; font-size: 12px;">
                                <div style="width: 12px; height: 12px; background: ${item.color}; margin-right: 5px;"></div>
                                <span>${item.name}: ${item.percentage}%</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }
        
        // 分析成本数据
        function analyzeCostData() {
            // 从Excel数据中提取成本数据
            for (const item of excelData) {
                const workbook = item.workbook;
                
                for (const sheetName of workbook.SheetNames) {
                    const worksheet = workbook.Sheets[sheetName];
                    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                    
                    if (jsonData.length > 1) {
                        const headers = jsonData[0];
                        const costIndex = headers.findIndex(h => String(h).includes('成本') || String(h).includes('费用'));
                        const nameIndex = headers.findIndex(h => String(h).includes('名称') || String(h).includes('类型'));
                        
                        if (costIndex !== -1 && nameIndex !== -1) {
                            const costData = [];
                            let totalCost = 0;
                            
                            // 计算总成本
                            for (let i = 1; i < jsonData.length; i++) {
                                const row = jsonData[i];
                                const cost = parseFloat(row[costIndex]) || 0;
                                totalCost += cost;
                            }
                            
                            // 计算各成本类型的占比
                            for (let i = 1; i < jsonData.length; i++) {
                                const row = jsonData[i];
                                const name = String(row[nameIndex]);
                                const cost = parseFloat(row[costIndex]) || 0;
                                const percentage = totalCost > 0 ? (cost / totalCost * 100).toFixed(1) : 0;
                                
                                if (name && cost > 0) {
                                    costData.push({
                                        name: name,
                                        percentage: parseFloat(percentage),
                                        color: getRandomColor(i)
                                    });
                                }
                            }
                            
                            if (costData.length > 0) {
                                return costData;
                            }
                        }
                    }
                }
            }
            
            // 如果没有找到成本数据，返回默认数据
            return [
                { name: '材料成本', percentage: 45, color: '#8A2BE2' },
                { name: '人工成本', percentage: 30, color: '#28a745' },
                { name: '设备成本', percentage: 15, color: '#ffc107' },
                { name: '其他成本', percentage: 10, color: '#dc3545' }
            ];
        }
        
        // 分析材料消耗趋势
        function analyzeMaterialTrend() {
            // 从Excel数据中提取材料消耗趋势
            for (const item of excelData) {
                const workbook = item.workbook;
                
                for (const sheetName of workbook.SheetNames) {
                    const worksheet = workbook.Sheets[sheetName];
                    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                    
                    if (jsonData.length > 1) {
                        const headers = jsonData[0];
                        const dateIndex = headers.findIndex(h => String(h).includes('日期') || String(h).includes('月份'));
                        const valueIndex = headers.findIndex(h => String(h).includes('消耗') || String(h).includes('数量') || String(h).includes('金额'));
                        
                        if (dateIndex !== -1 && valueIndex !== -1) {
                            const trendData = [];
                            let maxValue = 0;
                            
                            // 先计算最大值用于归一化
                            for (let i = 1; i < jsonData.length; i++) {
                                const row = jsonData[i];
                                const value = parseFloat(row[valueIndex]) || 0;
                                if (value > maxValue) maxValue = value;
                            }
                            
                            // 生成趋势数据
                            for (let i = 1; i < jsonData.length; i++) {
                                const row = jsonData[i];
                                const date = String(row[dateIndex]);
                                const value = parseFloat(row[valueIndex]) || 0;
                                const normalizedValue = maxValue > 0 ? (value / maxValue * 100) : 0;
                                
                                if (date) {
                                    trendData.push({
                                        month: date,
                                        value: normalizedValue
                                    });
                                }
                            }
                            
                            if (trendData.length > 0) {
                                return trendData;
                            }
                        }
                    }
                }
            }
            
            // 如果没有找到趋势数据，返回默认数据
            return [
                { month: '1月', value: 30 },
                { month: '2月', value: 45 },
                { month: '3月', value: 60 },
                { month: '4月', value: 50 },
                { month: '5月', value: 75 }
            ];
        }
        
        // 分析工时成本数据
        function analyzeLaborCost() {
            // 从Excel数据中提取工时成本数据
            for (const item of excelData) {
                const workbook = item.workbook;
                
                for (const sheetName of workbook.SheetNames) {
                    const worksheet = workbook.Sheets[sheetName];
                    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                    
                    if (jsonData.length > 1) {
                        const headers = jsonData[0];
                        const projectIndex = headers.findIndex(h => String(h).includes('项目') || String(h).includes('任务'));
                        const costIndex = headers.findIndex(h => String(h).includes('成本') || String(h).includes('工时'));
                        
                        if (projectIndex !== -1 && costIndex !== -1) {
                            const laborData = [];
                            let totalCost = 0;
                            
                            // 计算总成本
                            for (let i = 1; i < jsonData.length; i++) {
                                const row = jsonData[i];
                                const cost = parseFloat(row[costIndex]) || 0;
                                totalCost += cost;
                            }
                            
                            // 计算各项目的占比
                            for (let i = 1; i < jsonData.length; i++) {
                                const row = jsonData[i];
                                const project = String(row[projectIndex]);
                                const cost = parseFloat(row[costIndex]) || 0;
                                const percentage = totalCost > 0 ? (cost / totalCost * 100).toFixed(1) : 0;
                                
                                if (project && cost > 0) {
                                    laborData.push({
                                        name: project,
                                        percentage: parseFloat(percentage),
                                        color: getRandomColor(i)
                                    });
                                }
                            }
                            
                            if (laborData.length > 0) {
                                return laborData;
                            }
                        }
                    }
                }
            }
            
            // 如果没有找到工时数据，返回默认数据
            return [
                { name: '设计', percentage: 40, color: '#8A2BE2' },
                { name: '施工', percentage: 30, color: '#28a745' },
                { name: '调试', percentage: 20, color: '#ffc107' },
                { name: '其他', percentage: 10, color: '#dc3545' }
            ];
        }
        
        // 获取随机颜色
        function getRandomColor(index) {
            const colors = [
                '#8A2BE2', // 紫色
                '#28a745', // 绿色
                '#ffc107', // 黄色
                '#dc3545', // 红色
                '#007bff', // 蓝色
                '#17a2b8', // 青色
                '#fd7e14', // 橙色
                '#6f42c1'  // 紫色
            ];
            return colors[index % colors.length];
        }
        
        // 格式化数值，保留两位小数，达到万单位时显示为多少万
        function formatNumber(num) {
            // 确保是数字
            const number = parseFloat(num) || 0;
            
            // 保留两位小数
            const fixedNum = number.toFixed(2);
            
            // 如果大于等于1万，显示为多少万
            if (number >= 10000) {
                const wan = (number / 10000).toFixed(2);
                return wan + '万';
            }
            
            return fixedNum;
        }
        
        // 使用阿里云百炼API处理Excel文件
        async function processExcelWithAI() {
            // 获取API密钥和设置
            const apiKey = document.getElementById('openaiApiKey').value;
            const model = document.getElementById('openaiModel').value;
            const temperature = parseFloat(document.getElementById('openaiTemperature').value);
            const maxTokens = parseInt(document.getElementById('openaiMaxTokens').value);
            
            if (!apiKey) {
                alert('请先设置并保存阿里云百炼 API 密钥');
                return;
            }
            
            console.log('excelData 长度:', excelData.length);
            console.log('uploadedExcelFiles 长度:', uploadedExcelFiles.length);
            
            if (excelData.length === 0) {
                alert('请先上传 Excel 文件。当前 excelData 为空数组！');
                return;
            }
            
            try {
                // 准备 Excel 数据
                const excelDataForAI = excelData.map(item => ({
                    fileName: item.file.name,
                    sheets: item.workbook.SheetNames.map(sheetName => ({
                        sheetName: sheetName,
                        rowCount: XLSX.utils.sheet_to_json(item.workbook.Sheets[sheetName]).length,
                        data: XLSX.utils.sheet_to_json(item.workbook.Sheets[sheetName])
                    }))
                }));
                
                console.log('发送给 AI 的 Excel 数据:', JSON.stringify(excelDataForAI, null, 2));
                console.log('数据大小:', JSON.stringify(excelDataForAI).length, '字节');
                
                // 调用阿里云百炼 API
                const localProxy = `${API_PROXY}/api/aliyun`;
                const response = await fetch(localProxy, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: apiKey,
                        model: model,
                        messages: [
                            {
                                role: 'system',
                                content: '你是一个专业的 Excel 数据分析助手。用户已经在消息中提供了完整的 Excel 数据（包含文件名、工作表名、行数和具体数据）。请直接分析这些实际数据，不要再说没有收到数据。请详细分析：数据概览、核心指标、趋势模式、异常值、可视化建议和业务洞察。请用中文回复。'
                            },
                            {
                                role: 'user',
                                content: `以下是我上传的 Excel 文件数据，请详细分析：\n\n${JSON.stringify(excelDataForAI, null, 2)}\n\n请基于以上实际数据进行分析，不要忽略或跳过数据。`
                            }
                        ],
                        temperature: temperature,
                        max_tokens: maxTokens
                    }),
                    credentials: 'omit',
                    mode: 'cors'
                });
                
                if (response.ok) {
                    const data = await response.json();
                    const aiResponse = data.choices?.[0]?.message?.content || '未获取到响应';
                    
                    console.log('AI 响应:', aiResponse);
                    
                    // 显示 AI 分析结果
                    const mergeResult = document.getElementById('mergeResult');
                    mergeResult.innerHTML = `
                        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #e9ecef;">
                            <h4 style="margin-top: 0; color: #6f42c1;">阿里云百炼分析结果</h4>
                            <div style="white-space: pre-wrap; line-height: 1.6;">${aiResponse}</div>
                        </div>
                    `;
                } else {
                    const errorData = await response.json();
                    alert('API 调用失败：' + (errorData.message || errorData.error?.message || '未知错误'));
                }
            } catch (error) {
                console.error('处理Excel文件失败:', error);
                alert('处理Excel文件失败：' + error.message + '\n请检查网络连接和API密钥是否正确');
            }
        }
        
        // 清空Excel文件
        function clearExcelFiles() {
            uploadedExcelFiles = [];
            excelData = [];
            mergedWorkbook = null;
            dataTypes = [];
            updateExcelFileList();
            
            // 重置数据类型部分
            document.getElementById('dataTypeSection').style.display = 'none';
            document.getElementById('dataTableSection').style.display = 'none';
            document.getElementById('dataTypeButtons').innerHTML = '';
            document.getElementById('dataTableContainer').innerHTML = '';
            
            // 重置图表
            document.getElementById('chartsSection').style.display = 'none';
            document.getElementById('chartsContainer').innerHTML = '';
            
            // 重置合并结果
            document.getElementById('mergeResult').innerHTML = '<p style="color: #666;">点击"合并Excel"按钮查看合并结果</p>';
            document.getElementById('downloadMergeBtn').style.display = 'none';
        }
        
        // 开发日志功能
        function saveDevLog() {
            const content = document.getElementById('devlogContent').value;
            const statusElement = document.getElementById('devlogStatus');
            
            if (!content.trim()) {
                statusElement.innerHTML = '<span style="color: #dc3545;">日志内容不能为空</span>';
                return;
            }
            
            try {
                // 获取当前日期时间
                const now = new Date();
                const timestamp = now.toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
                
                // 创建日志对象
                const logEntry = {
                    id: Date.now(),
                    timestamp: timestamp,
                    content: content
                };
                
                // 获取现有的日志记录
                let logs = JSON.parse(localStorage.getItem('devlogEntries') || '[]');
                
                // 添加新日志到开头
                logs.unshift(logEntry);
                
                // 限制日志数量为100条
                if (logs.length > 100) {
                    logs = logs.slice(0, 100);
                }
                
                // 保存到localStorage
                localStorage.setItem('devlogEntries', JSON.stringify(logs));
                
                // 清空输入框
                document.getElementById('devlogContent').value = '';
                
                // 显示保存成功提示
                statusElement.innerHTML = '<span style="color: #28a745;">日志保存成功</span>';
                
                // 3秒后清空状态
                setTimeout(() => {
                    statusElement.innerHTML = '';
                }, 3000);
                
                // 更新历史记录显示
                displayDevLogHistory();
            } catch (error) {
                statusElement.innerHTML = '<span style="color: #dc3545;">保存失败：' + error.message + '</span>';
            }
        }
        
        // 显示开发日志历史
        function displayDevLogHistory() {
            try {
                const logs = JSON.parse(localStorage.getItem('devlogEntries') || '[]');
                const historyContainer = document.getElementById('devlogHistory');
                
                if (logs.length === 0) {
                    historyContainer.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">暂无历史记录</p>';
                    return;
                }
                
                let html = '';
                logs.forEach(log => {
                    html += `
                        <div style="border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin-bottom: 10px; background: #f8f9fa;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                <div style="font-size: 12px; color: #666;">${log.timestamp}</div>
                                <button class="btn" onclick="deleteDevLog(${log.id})" style="padding: 4px 8px; font-size: 12px; background: #dc3545;">删除</button>
                            </div>
                            <div style="white-space: pre-wrap; line-height: 1.5;">${log.content}</div>
                        </div>
                    `;
                });
                
                historyContainer.innerHTML = html;
            } catch (error) {
                console.error('显示日志历史失败:', error);
            }
        }
        
        // 删除开发日志
        function deleteDevLog(logId) {
            try {
                let logs = JSON.parse(localStorage.getItem('devlogEntries') || '[]');
                logs = logs.filter(log => log.id !== logId);
                localStorage.setItem('devlogEntries', JSON.stringify(logs));
                displayDevLogHistory();
            } catch (error) {
                console.error('删除日志失败:', error);
            }
        }
        
        // 页面加载时加载开发日志历史
        window.onload = function() {
            displayDevLogHistory();
        }
        
        // 导出发日志
        function exportDevLogs() {
            try {
                const logs = localStorage.getItem('devlogEntries');
                if (!logs || logs === '[]') {
                    alert('暂无日志可导出');
                    return;
                }
                
                const blob = new Blob([logs], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `devlog_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                alert('日志导出成功！');
            } catch (error) {
                alert('导出失败：' + error.message);
            }
        }
        
        // 导入开发日志
        function importDevLogs(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const logs = JSON.parse(e.target.result);
                    if (!Array.isArray(logs)) {
                        throw new Error('文件格式不正确');
                    }
                    
                    localStorage.setItem('devlogEntries', JSON.stringify(logs));
                    displayDevLogHistory();
                    alert('日志导入成功！');
                } catch (error) {
                    alert('导入失败：' + error.message);
                }
            };
            reader.readAsText(file);
            
            // 清空 input 以便下次选择同一文件
            event.target.value = '';
        }
        
        // 下载合并的 Excel 文件
        function downloadMergedExcel() {
            if (!mergedWorkbook) {
                alert('请先合并Excel文件');
                return;
            }
            
            // 生成Excel文件并下载
            const excelBuffer = XLSX.write(mergedWorkbook, { bookType: 'xlsx', type: 'array' });
            const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'merged_excel_files.xlsx';
            link.click();
            URL.revokeObjectURL(url);
        }
        
        // ==================== 智能指令分析系统 ====================
        
        // 预设指令模板
        const instructionTemplates = {
            data_cleaning: {
                name: '数据清洗',
                rules: [
                    '检查并处理缺失值',
                    '删除重复记录',
                    '修正数据格式',
                    '处理异常值'
                ],
                instruction: '请对上传的 Excel 数据进行数据清洗，包括：处理缺失值、删除重复记录、统一数据格式、识别并处理异常值。请列出所有发现的问题及处理方式。'
            },
            data_analysis: {
                name: '数据分析',
                rules: [
                    '描述性统计分析',
                    '数据分布分析',
                    '相关性分析',
                    '关键指标计算'
                ],
                instruction: '请对数据进行全面的描述性统计分析，包括：均值、中位数、标准差、最大最小值等统计指标，分析数据分布特征，识别关键指标和潜在规律。'
            },
            data_filter: {
                name: '数据筛选',
                rules: [
                    '设置筛选条件',
                    '多条件组合筛选',
                    '模糊匹配筛选',
                    '数值范围筛选'
                ],
                instruction: '请根据我指定的条件筛选数据。筛选条件：[请在此处详细描述筛选条件，如：销售额>10000 且日期在 2024 年之后的记录]。请提供筛选后的数据列表和筛选统计。'
            },
            data_sort: {
                name: '数据排序',
                rules: [
                    '单字段排序',
                    '多字段组合排序',
                    '升序/降序设置',
                    '自定义排序规则'
                ],
                instruction: '请对数据进行排序。排序规则：[请指定排序字段和顺序，如：按销售额降序排列，如果销售额相同则按日期升序排列]。请提供排序后的数据。'
            },
            data_group: {
                name: '数据分组汇总',
                rules: [
                    '单字段分组',
                    '多字段组合分组',
                    '分组聚合计算',
                    '分组统计展示'
                ],
                instruction: '请对数据进行分组汇总。分组方式：[请指定分组字段，如：按部门分组]。汇总指标：[请指定汇总指标，如：计算每个部门的总成本、平均成本、记录数]。请提供分组汇总结果。'
            },
            data_compare: {
                name: '数据对比',
                rules: [
                    '时间对比（同比/环比）',
                    '类别对比',
                    '目标与实际对比',
                    '多维度对比分析'
                ],
                instruction: '请对数据进行对比分析。对比维度：[请指定对比维度，如：各月份之间的销售数据对比/各部门的成本对比]。请提供对比结果、差异分析和原因推测。'
            },
            data_trend: {
                name: '趋势分析',
                rules: [
                    '时间序列分析',
                    '趋势线拟合',
                    '增长率计算',
                    '趋势预测'
                ],
                instruction: '请对数据进行趋势分析。分析维度：[请指定分析维度，如：销售额的月度变化趋势]。请提供：趋势描述、增长率计算、趋势图建议、未来走势预测。'
            },
            data_anomaly: {
                name: '异常检测',
                rules: [
                    '统计方法检测（3σ原则）',
                    '箱线图检测（IQR 方法）',
                    '业务规则检测',
                    '异常原因分析'
                ],
                instruction: '请检测数据中的异常值。检测方法：使用统计方法（如 3σ原则或 IQR 方法）和业务规则。请列出：异常数据列表、异常程度、可能的原因分析、处理建议。'
            },
            custom: {
                name: '自定义指令',
                rules: [],
                instruction: ''
            }
        };
        
        // 显示智能指令面板
        function showSmartInstructionPanel() {
            console.log('=== 打开智能指令面板 ===');
            console.log('excelData 长度:', excelData.length);
            console.log('uploadedExcelFiles 长度:', uploadedExcelFiles.length);
            
            if (excelData.length === 0) {
                alert('请先上传 Excel 文件！当前没有检测到已上传的文件数据。');
                return;
            }
            
            document.getElementById('smartInstructionPanel').style.display = 'block';
            document.getElementById('instructionStatus').style.display = 'none';
        }
        
        // 隐藏智能指令面板
        function hideSmartInstructionPanel() {
            document.getElementById('smartInstructionPanel').style.display = 'none';
        }
        
        // 加载指令模板
        function loadInstructionTemplate() {
            const templateKey = document.getElementById('instructionTemplate').value;
            const analysisRulesDiv = document.getElementById('analysisRules');
            const instructionTextarea = document.getElementById('smartInstruction');
            
            if (!templateKey) {
                analysisRulesDiv.innerHTML = '<p style="color: #666; margin: 0;">请先选择指令模板，系统将自动加载相应的分析规则</p>';
                return;
            }
            
            const template = instructionTemplates[templateKey];
            
            // 显示分析规则
            if (template.rules.length > 0) {
                let rulesHtml = '<h4 style="margin-top: 0; margin-bottom: 10px; color: #6f42c1;">分析规则：</h4><ul style="margin: 0; padding-left: 20px;">';
                template.rules.forEach(rule => {
                    rulesHtml += `<li style="margin-bottom: 5px;">✅ ${rule}</li>`;
                });
                rulesHtml += '</ul>';
                analysisRulesDiv.innerHTML = rulesHtml;
            } else {
                analysisRulesDiv.innerHTML = '<p style="color: #666; margin: 0;">自定义模式，请在下方输入具体指令</p>';
            }
            
            // 加载默认指令
            if (template.instruction) {
                instructionTextarea.value = template.instruction;
            } else {
                instructionTextarea.value = '';
            }
        }
        
        // 验证指令
        function validateInstruction() {
            const instruction = document.getElementById('smartInstruction').value.trim();
            const statusDiv = document.getElementById('instructionStatus');
            
            if (!instruction) {
                showInstructionStatus('❌ 请输入具体指令', 'error');
                return;
            }
            
            if (excelData.length === 0) {
                showInstructionStatus('❌ 请先上传 Excel 文件', 'error');
                return;
            }
            
            // 简单的指令完整性检查
            const checks = [
                { test: instruction.length >= 10, msg: '指令长度足够' },
                { test: instruction.includes('请') || instruction.includes('分析') || instruction.includes('计算'), msg: '包含动作词' },
                { test: /[0-9]/.test(instruction) || /[a-zA-Z]/.test(instruction), msg: '包含具体参数' }
            ];
            
            let passedCount = 0;
            let checkResults = '';
            checks.forEach(check => {
                if (check.test) {
                    passedCount++;
                    checkResults += `✅ ${check.msg}<br>`;
                } else {
                    checkResults += `⚠️ ${check.msg}（未满足）<br>`;
                }
            });
            
            if (passedCount === checks.length) {
                showInstructionStatus(`✅ 指令验证通过<br><br>${checkResults}`, 'success');
            } else {
                showInstructionStatus(`⚠️ 指令基本可用，但以下方面可以优化：<br><br>${checkResults}`, 'warning');
            }
        }
        
        // 显示指令状态
        function showInstructionStatus(message, type) {
            const statusDiv = document.getElementById('instructionStatus');
            statusDiv.innerHTML = message;
            statusDiv.style.display = 'block';
            
            if (type === 'success') {
                statusDiv.style.backgroundColor = '#d4edda';
                statusDiv.style.border = '1px solid #c3e6cb';
                statusDiv.style.color = '#155724';
            } else if (type === 'error') {
                statusDiv.style.backgroundColor = '#f8d7da';
                statusDiv.style.border = '1px solid #f5c6cb';
                statusDiv.style.color = '#721c24';
            } else {
                statusDiv.style.backgroundColor = '#fff3cd';
                statusDiv.style.border = '1px solid #ffeeba';
                statusDiv.style.color = '#856404';
            }
        }
        
        // 执行智能指令
        async function executeSmartInstruction() {
            const apiKey = document.getElementById('openaiApiKey').value;
            const model = document.getElementById('openaiModel').value;
            const instruction = document.getElementById('smartInstruction').value.trim();
            const outputSummary = document.getElementById('outputSummary').checked;
            const outputData = document.getElementById('outputData').checked;
            const outputChart = document.getElementById('outputChart').checked;
            const outputExcel = document.getElementById('outputExcel').checked;
            
            if (!apiKey) {
                alert('请先设置并保存阿里云百炼 API 密钥');
                return;
            }
            
            if (!instruction) {
                showInstructionStatus('❌ 请输入具体指令', 'error');
                return;
            }
            
            if (excelData.length === 0) {
                showInstructionStatus('❌ 请先上传 Excel 文件', 'error');
                return;
            }
            
            try {
                showInstructionStatus('🔄 正在执行指令，请稍候...', 'warning');
                
                // 准备 Excel 数据 - 只发送样本数据，减少 token 消耗
                const excelDataForAI = excelData.map(item => {
                    const workbook = item.workbook;
                    const result = {
                        fileName: item.file.name,
                        sheets: []
                    };
                    
                    workbook.SheetNames.forEach(sheetName => {
                        const sheet = workbook.Sheets[sheetName];
                        const jsonData = XLSX.utils.sheet_to_json(sheet);
                        
                        result.sheets.push({
                            sheetName: sheetName,
                            totalRows: jsonData.length,
                            columns: jsonData.length > 0 ? Object.keys(jsonData[0]) : [],
                            // 只发送前 10 行样本数据
                            sampleData: jsonData.slice(0, 10)
                        });
                    });
                    
                    return result;
                });
                
                const jsonDataString = JSON.stringify(excelDataForAI, null, 2);
                console.log('=== 发送给 AI 的 Excel 数据 ===');
                console.log('数据大小:', jsonDataString.length, '字节');
                console.log('文件数量:', excelDataForAI.length);
                console.log('===============================');
                
                // 构建输出要求
                let outputRequirements = '';
                if (outputSummary) outputRequirements += '【必须】1. 分析摘要总结\n';
                if (outputData) outputRequirements += '【必须】2. 处理后的完整数据（以表格形式展示）\n';
                if (outputChart) outputRequirements += '【可选】3. 图表类型建议和图表配置说明\n';
                if (outputExcel) outputRequirements += '【可选】4. 提供可导出为 Excel 的数据格式\n';
                
                // 调用阿里云百炼 API
                const localProxy = `${API_PROXY}/api/aliyun`;
                const response = await fetch(localProxy, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: apiKey,
                        model: model,
                        messages: [
                            {
                                role: 'system',
                                content: '你是一个专业的 Excel 数据处理和分析专家。用户已经上传了 Excel 文件，文件数据就在下面的 user 消息中（JSON 格式）。请直接读取这些数据，严格按照用户的具体指令进行处理，输出实际的处理结果。不要说"请提供数据"，因为数据就在你的输入中。用中文回复，结果要具体、可执行。'
                            },
                            {
                                role: 'user',
                                content: `【Excel 文件数据】以下是我已经上传的文件数据（JSON 格式）：

${jsonDataString}

【我的具体指令】
${instruction}

【输出要求】
${outputRequirements}

【重要】
- 上面的 JSON 数据是真实存在的，请直接使用
- 立即执行指令，输出实际结果
- 不要返回模板
- 用中文回复`
                            }
                        ],
                        temperature: 0.7,
                        max_tokens: 4000
                    }),
                    credentials: 'omit',
                    mode: 'cors'
                });
                
                if (response.ok) {
                    const data = await response.json();
                    console.log('API 返回数据:', data);
                    
                    const aiResponse = data.choices?.[0]?.message?.content;
                    
                    if (!aiResponse) {
                        console.error('AI 响应为空:', data);
                        showInstructionStatus('❌ AI 返回空响应。请检查服务器日志或重试。', 'error');
                        return;
                    }
                    
                    console.log('智能指令 AI 响应:', aiResponse);
                    
                    // 显示 AI 分析结果
                    const mergeResult = document.getElementById('mergeResult');
                    mergeResult.innerHTML = `
                        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #e9ecef;">
                            <h4 style="margin-top: 0; color: #6f42c1;">💡 智能指令执行结果</h4>
                            <div style="white-space: pre-wrap; line-height: 1.6; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px;">${aiResponse}</div>
                        </div>
                    `;
                    
                    showInstructionStatus('✅ 指令执行成功！结果已显示在下方', 'success');
                    
                    // 滚动到结果区域
                    mergeResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else {
                    let errorMessage = '未知错误';
                    try {
                        const errorData = await response.json();
                        console.error('API 错误数据:', errorData);
                        errorMessage = errorData.message || errorData.error?.message || `HTTP ${response.status}`;
                    } catch (parseError) {
                        errorMessage = `HTTP ${response.status} - ${response.statusText}`;
                    }
                    showInstructionStatus('❌ API 调用失败：' + errorMessage, 'error');
                }
            } catch (error) {
                console.error('执行智能指令失败:', error);
                showInstructionStatus('❌ 执行失败：' + error.message + '。请检查：1. 服务器是否运行 2. API Key 是否正确 3. 网络连接', 'error');
            }
        }
        
        // 保存自定义指令模板
        function saveInstructionTemplate() {
            const templateKey = document.getElementById('instructionTemplate').value;
            const instruction = document.getElementById('smartInstruction').value.trim();
            
            if (!instruction) {
                alert('请先输入指令内容');
                return;
            }
            
            const customTemplates = JSON.parse(localStorage.getItem('customInstructionTemplates') || '{}');
            
            if (templateKey && templateKey !== 'custom') {
                // 保存到预设模板的自定义版本
                const templateName = instructionTemplates[templateKey].name;
                customTemplates[templateKey + '_custom'] = {
                    name: templateName + '（自定义）',
                    instruction: instruction
                };
            } else {
                // 保存为新的自定义模板
                const templateName = prompt('请输入模板名称：', '自定义模板');
                if (templateName) {
                    const newKey = 'custom_' + Date.now();
                    customTemplates[newKey] = {
                        name: templateName,
                        instruction: instruction
                    };
                }
            }
            
            localStorage.setItem('customInstructionTemplates', JSON.stringify(customTemplates));
            alert('模板保存成功！下次使用时可以在自定义模板中找到。');
        }
        
        // 加载自定义模板到下拉框
        function loadCustomTemplates() {
            const select = document.getElementById('instructionTemplate');
            const customTemplates = JSON.parse(localStorage.getItem('customInstructionTemplates') || '{}');
            
            Object.keys(customTemplates).forEach(key => {
                const template = customTemplates[key];
                const option = document.createElement('option');
                option.value = key;
                option.textContent = '⭐ ' + template.name;
                select.appendChild(option);
            });
        }
        
        // 添加专利数据
        function addPatentData() {
            const name = document.getElementById('newPatentName').value.trim();
            const patentNumber = document.getElementById('newPatentNumber').value.trim();
            const applicant = document.getElementById('newPatentApplicant').value.trim();
            const applicationDate = document.getElementById('newPatentDate').value;
            const classification = document.getElementById('newPatentClassification').value;
            const status = document.getElementById('newPatentStatus').value;
            const summary = document.getElementById('newPatentSummary').value.trim();
            const fileInput = document.getElementById('newPatentFile');
            let fileName = '';
            if (fileInput.files.length > 0) {
                fileName = fileInput.files[0].name;
            }
            
            if (!name || !patentNumber || !applicant || !applicationDate || !classification || !status) {
                alert('请填写所有必填字段');
                return;
            }
            
            let patentData = JSON.parse(localStorage.getItem('patentData') || '[]');
            
            const newId = patentData.length > 0 ? Math.max(...patentData.map(p => p.id)) + 1 : 1;
            
            const newPatent = {
                id: newId,
                name: name,
                patentNumber: patentNumber,
                applicant: applicant,
                applicationDate: applicationDate,
                classification: classification,
                status: status,
                summary: summary,
                fileName: fileName
            };
            
            patentData.push(newPatent);
            
            localStorage.setItem('patentData', JSON.stringify(patentData));
            
            document.getElementById('newPatentName').value = '';
            document.getElementById('newPatentNumber').value = '';
            document.getElementById('newPatentApplicant').value = '';
            document.getElementById('newPatentDate').value = '';
            document.getElementById('newPatentClassification').value = '';
            document.getElementById('newPatentStatus').value = '';
            document.getElementById('newPatentSummary').value = '';
            document.getElementById('newPatentFile').value = '';
            
            loadExistingPatents();
            
            alert('专利数据添加成功！');
        }
        
        // 加载现有专利数据
        function loadExistingPatents() {
            const patentTableBody = document.getElementById('existingPatentList');
            if (!patentTableBody) return;
            
            // 获取现有专利数据
            let patentData = JSON.parse(localStorage.getItem('patentData') || '[]');
            
            // 清空表格
            patentTableBody.innerHTML = '';
            
            // 生成表格内容
            patentData.forEach(patent => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${patent.name}</td>
                    <td>${patent.patentNumber || '-'}</td>
                    <td>${patent.applicant}</td>
                    <td>${patent.applicationDate}</td>
                    <td>${patent.classification}</td>
                    <td><span class="tag ${getStatusClass(patent.status)}">${patent.status}</span></td>
                    <td>
                        <button class="btn" style="padding: 6px 12px; font-size: 12px; margin-right: 5px;" onclick="editPatent(${patent.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px;" onclick="deletePatentById(${patent.id})">删除</button>
                    </td>
                `;
                patentTableBody.appendChild(row);
            });
        }
        
        // 根据状态获取标签类
        function getStatusClass(status) {
            switch(status) {
                case '已授权':
                    return 'tag-success';
                case '审查中':
                    return 'tag-warning';
                case '已公开':
                    return 'tag-primary';
                case '已失效':
                    return 'tag-danger';
                default:
                    return 'tag';
            }
        }
        
        // 编辑专利
        function editPatent(id) {
            // 获取现有专利数据
            let patentData = JSON.parse(localStorage.getItem('patentData') || '[]');
            const patent = patentData.find(p => p.id === id);
            
            if (patent) {
                document.getElementById('newPatentName').value = patent.name;
                document.getElementById('newPatentNumber').value = patent.patentNumber || '';
                document.getElementById('newPatentApplicant').value = patent.applicant;
                document.getElementById('newPatentDate').value = patent.applicationDate;
                document.getElementById('newPatentClassification').value = patent.classification;
                document.getElementById('newPatentStatus').value = patent.status;
                document.getElementById('newPatentSummary').value = patent.summary;
                
                // 删除原专利
                patentData = patentData.filter(p => p.id !== id);
                localStorage.setItem('patentData', JSON.stringify(patentData));
                
                alert('请修改表单内容后点击"添加专利"按钮完成编辑');
            }
        }
        
        // 根据ID删除专利
        function deletePatentById(id) {
            if (confirm('确定要删除这个专利吗？')) {
                // 获取现有专利数据
                let patentData = JSON.parse(localStorage.getItem('patentData') || '[]');
                
                // 删除专利
                patentData = patentData.filter(p => p.id !== id);
                localStorage.setItem('patentData', JSON.stringify(patentData));
                
                // 更新专利列表
                loadExistingPatents();
                
                alert('专利删除成功！');
            }
        }
        
        // 页面加载时加载自定义模板
        const originalWindowOnload = window.onload;
        window.onload = function() {
            if (originalWindowOnload) originalWindowOnload();
            loadCustomTemplates();
            // 加载现有专利数据
            loadExistingPatents();
        };
        
        // ========== Excel 处理重构功能 ==========
        
        // 拖拽上传相关函数
        function handleDragOver(event) {
            event.preventDefault();
            event.stopPropagation();
            const dropZone = document.getElementById('dropZone');
            if (dropZone) {
                dropZone.classList.add('drag-over');
            }
        }
        
        function handleDragLeave(event) {
            event.preventDefault();
            event.stopPropagation();
            const dropZone = document.getElementById('dropZone');
            if (dropZone) {
                dropZone.classList.remove('drag-over');
            }
        }
        
        function handleDrop(event) {
            event.preventDefault();
            event.stopPropagation();
            const dropZone = document.getElementById('dropZone');
            if (dropZone) {
                dropZone.classList.remove('drag-over');
            }
            
            const files = event.dataTransfer.files;
            if (files.length > 0) {
                const validFiles = Array.from(files).filter(file => {
                    const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
                    return fileExtension === '.xlsx' || fileExtension === '.xls';
                });
                
                if (validFiles.length > 0) {
                    const fakeEvent = {
                        target: {
                            files: validFiles
                        }
                    };
                    handleExcelFileUpload(fakeEvent);
                } else {
                    showStatusMessage('请上传 Excel 文件（.xlsx 或 .xls 格式）', 'error');
                }
            }
        }
        
        // 自然语言输入处理
        function handleInputFocus() {
            const input = document.getElementById('naturalLanguageInput');
            const suggestions = document.getElementById('autocompleteSuggestions');
            
            if (input && input.value.trim().length > 0) {
                showAutocompleteSuggestions(input.value);
            }
        }
        
        function handleInputBlur() {
            // 延迟隐藏，以便可以点击建议项
            setTimeout(() => {
                const suggestions = document.getElementById('autocompleteSuggestions');
                if (suggestions) {
                    suggestions.style.display = 'none';
                }
            }, 200);
        }
        
        // 显示自动完成建议
        function showAutocompleteSuggestions(inputValue) {
            const suggestions = document.getElementById('autocompleteSuggestions');
            if (!suggestions) return;
            
            const commonCommands = [
                '生成销售数据的月度趋势图',
                '按部门统计总成本并生成饼图',
                '对比各季度的收入变化',
                '找出销售额前 10 的产品并生成柱状图',
                '分析数据的相关性并生成散点图',
                '计算每个月的环比增长率',
                '按地区分组统计销售额',
                '预测下个季度的销售趋势',
                '找出异常值并分析原因',
                '生成数据的分布直方图'
            ];
            
            const filtered = commonCommands.filter(cmd => 
                cmd.toLowerCase().includes(inputValue.toLowerCase())
            );
            
            if (filtered.length > 0) {
                suggestions.innerHTML = filtered.map(cmd => 
                    `<div class="autocomplete-item" onclick="selectSuggestion('${cmd.replace(/'/g, "\\'")}')">${cmd}</div>`
                ).join('');
                suggestions.style.display = 'block';
            } else {
                suggestions.style.display = 'none';
            }
        }
        
        function selectSuggestion(command) {
            const input = document.getElementById('naturalLanguageInput');
            if (input) {
                input.value = command;
            }
            const suggestions = document.getElementById('autocompleteSuggestions');
            if (suggestions) {
                suggestions.style.display = 'none';
            }
        }
        
        function insertQuickCommand(command) {
            const input = document.getElementById('naturalLanguageInput');
            if (input) {
                input.value = command;
                input.focus();
            }
        }
        
        // 提交到 AI 处理
        async function submitToAI() {
            const input = document.getElementById('naturalLanguageInput');
            const command = input ? input.value.trim() : '';
            
            if (!command) {
                showStatusMessage('请输入数据处理需求', 'error');
                return;
            }
            
            if (uploadedExcelFiles.length === 0) {
                showStatusMessage('请先上传 Excel 文件', 'error');
                return;
            }
            
            // 显示加载状态
            showStatusMessage('<span class="loading-spinner"></span>正在处理您的请求...', 'info');
            
            try {
                // 准备数据
                const excelDataArray = [];
                
                for (let i = 0; i < excelData.length; i++) {
                    const item = excelData[i];
                    const workbook = item.workbook;
                    const dataForAI = {
                        fileName: item.file.name,
                        sheets: []
                    };
                    
                    workbook.SheetNames.forEach(sheetName => {
                        const sheet = workbook.Sheets[sheetName];
                        const jsonData = XLSX.utils.sheet_to_json(sheet);
                        
                        dataForAI.sheets.push({
                            sheetName: sheetName,
                            totalRows: jsonData.length,
                            columns: jsonData.length > 0 ? Object.keys(jsonData[0]) : [],
                            sampleData: jsonData.slice(0, 50),
                            fullData: jsonData
                        });
                    });
                    
                    excelDataArray.push(dataForAI);
                }
                
                // 调用通义千问 API（密钥统一从「OpenAI入口」配置读取，禁止硬编码）
                const apiKey = (typeof getChatApiKey === 'function' ? getChatApiKey() : (localStorage.getItem('openaiApiKey') || ''));
                if (!apiKey) {
                    alert('未配置百炼 API 密钥，请先到「智能工具 → OpenAI入口」保存密钥后再试。');
                    return;
                }
                const baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
                
                const systemPrompt = `你是一个专业的数据分析和可视化专家。用户上传了 Excel 文件，并提出了数据处理需求。
请根据用户的需求：
1. 分析 Excel 数据结构
2. 提取相关数据
3. 生成 ECharts 图表配置

请以 JSON 格式返回，包含以下结构：
{
  "analysis": "数据分析说明",
  "chartConfig": {
    "type": "图表类型（bar/line/pie/scatter 等）",
    "title": "图表标题",
    "xAxis": "X 轴数据或配置",
    "yAxis": "Y 轴数据或配置",
    "series": "系列数据",
    "otherConfig": "其他 ECharts 配置项"
  }
}

如果用户的需求不适合生成图表，或者需要更多信息，请返回说明。`;

                const userPrompt = `用户指令：${command}

Excel 数据：
${JSON.stringify(excelDataArray, null, 2)}

请根据以上数据生成可视化图表。如果数据量太大，请只使用样本数据进行演示。`;

                // 使用本地代理（如果有的话）
                const localProxy = `${API_PROXY}/api/aliyun`;
                
                let response;
                try {
                    response = await fetch(localProxy, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify({
                            apiKey: apiKey,
                            model: 'qwen3.6-plus',
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: userPrompt }
                            ],
                            temperature: 0.7,
                            max_tokens: 4000
                        }),
                        credentials: 'omit',
                        mode: 'cors'
                    });
                } catch (proxyError) {
                    console.log('本地代理不可用，使用备用方案');
                    // 备用方案：直接返回模拟数据用于演示
                    response = {
                        ok: true,
                        json: async () => ({
                            choices: [{
                                message: {
                                    content: JSON.stringify({
                                        analysis: "基于您上传的数据，我生成了这个演示图表。实际使用时需要配置 API 代理。",
                                        chartConfig: {
                                            type: 'bar',
                                            title: command,
                                            xAxis: ['类别 1', '类别 2', '类别 3', '类别 4', '类别 5'],
                                            yAxis: { name: '数值' },
                                            series: [{
                                                name: '演示数据',
                                                type: 'bar',
                                                data: [120, 200, 150, 80, 70]
                                            }]
                                        }
                                    }, null, 2)
                                }
                            }]
                        })
                    };
                }
                
                if (response.ok) {
                    const data = await response.json();
                    const aiResponse = data.choices?.[0]?.message?.content;
                    
                    console.log('AI 响应:', aiResponse);
                    
                    // 解析 AI 响应
                    let result;
                    try {
                        // 尝试从响应中提取 JSON
                        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            result = JSON.parse(jsonMatch[0]);
                        } else {
                            result = JSON.parse(aiResponse);
                        }
                    } catch (parseError) {
                        console.error('解析 AI 响应ER 失败:', parseError);
                        showStatusMessage('AI 响应解析失败，但已为您生成演示图表', 'info');
                        result = {
                            analysis: "数据处理完成",
                            chartConfig: {
                                type: 'bar',
                                title: command,
                                xAxis: ['类别 1', '类别 2', '类别 3', '类别 4', '类别 5'],
                                yAxis: { name: '数值' },
                                series: [{
                                    name: '演示数据',
                                    type: 'bar',
                                    data: [120, 200, 150, 80, 70]
                                }]
                            }
                        };
                    }
                    
                    // 显示分析结果
                    if (result.analysis) {
                        showStatusMessage(`✅ ${result.analysis}`, 'success');
                    }
                    
                    // 渲染图表
                    if (result.chartConfig) {
                        renderChart(result.chartConfig);
                    } else {
                        showStatusMessage('未生成图表配置', 'error');
                    }
                    
                } else {
                    console.error('API 调用失败');
                    showStatusMessage('❌ API 调用失败，请检查网络连接', 'error');
                }
                
            } catch (error) {
                // API 调用失败，使用演示模式
                console.log('⚠️ API 调用失败，使用演示模式');
                
                try {
                    // 模拟 API 调用延迟
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    
                    // 演示结果
                    const demoResult = {
                        analysis: `✅ <strong>演示模式</strong><br><br>已理解您的需求："<strong>${command}</strong>"<br><br>📊 正在生成图表...<br><br>⚠️ <strong>注意：</strong>由于浏览器跨域限制，无法直接调用通义千问 API。当前显示的是演示图表。<br><br><strong>解决方案：</strong><br>1️⃣ 创建 Node.js 后端代理（推荐）<br>2️⃣ 使用 Python Flask/FastAPI 代理<br>3️⃣ 配置 CORS 代理服务器`,
                        chartConfig: {
                            type: 'bar',
                            title: command,
                            xAxis: {
                                type: 'category',
                                data: ['样本 1', '样本 2', '样本 3', '样本 4', '样本 5', '样本 6']
                            },
                            yAxis: {
                                type: 'value',
                                name: '数值'
                            },
                            series: [{
                                name: '演示数据',
                                type: 'bar',
                                data: [
                                    Math.floor(Math.random() * 200) + 50,
                                    Math.floor(Math.random() * 200) + 50,
                                    Math.floor(Math.random() * 200) + 50,
                                    Math.floor(Math.random() * 200) + 50,
                                    Math.floor(Math.random() * 200) + 50,
                                    Math.floor(Math.random() * 200) + 50
                                ],
                                itemStyle: {
                                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                                        { offset: 0, color: '#8A2BE2' },
                                        { offset: 1, color: '#9370DB' }
                                    ])
                                }
                            }]
                        }
                    };
                    
                    // 显示分析结果
                    showStatusMessage(demoResult.analysis, 'success');
                    
                    // 渲染图表
                    if (demoResult.chartConfig) {
                        renderChart(demoResult.chartConfig);
                    }
                    
                    console.log('✅ 演示图表已生成');
                    
                } catch (demoError) {
                    console.error('演示模式失败:', demoError);
                    showStatusMessage('演示模式也失败了：' + demoError.message, 'error');
                }
            }
        }
        
        // ========== 纵向项目管理模块 ==========
        
        var longitudinalData = [];
        var filteredLongitudinalData = [];
        var selectedLongitudinalIds = new Set();
        var editingLongitudinalId = null;
        var longitudinalSortField = '';
        var longitudinalSortOrder = 'asc';
        
        function initLongitudinalData() {
            const saved = localStorage.getItem('longitudinalData');
            if (saved) { longitudinalData = JSON.parse(saved); }
            else { longitudinalData = []; localStorage.setItem('longitudinalData', JSON.stringify(longitudinalData)); }
            filteredLongitudinalData = [...longitudinalData];
            updateLongitudinalFilterCounts();
            renderLongitudinalTable();
        }
        
        function saveLongitudinalData() { localStorage.setItem('longitudinalData', JSON.stringify(longitudinalData)); }
        
        function updateLongitudinalFilterCounts() {
            const currentYear = new Date().getFullYear().toString();
            document.getElementById('longitudinalCountAll').textContent = longitudinalData.length;
            document.getElementById('longitudinalCountCurrentYear').textContent = longitudinalData.filter(d => d.startDate && d.startDate.startsWith(currentYear)).length;
            document.getElementById('longitudinalCountReviewing').textContent = longitudinalData.filter(d => d.status === '审核中').length;
            document.getElementById('longitudinalCountApproved').textContent = longitudinalData.filter(d => d.status === '已通过').length;
            document.getElementById('longitudinalCountRejected').textContent = longitudinalData.filter(d => d.status === '已驳回').length;
        }
        
        function renderLongitudinalTable() {
            const tbody = document.getElementById('longitudinalTableBody');
            const emptyMsg = document.getElementById('longitudinalEmptyMessage');
            tbody.innerHTML = '';
            if (filteredLongitudinalData.length === 0) { emptyMsg.style.display = 'block'; return; }
            emptyMsg.style.display = 'none';
            filteredLongitudinalData.forEach(item => {
                const row = document.createElement('tr');
                let statusClass = 'tag-warning';
                if (item.status === '已通过') statusClass = 'tag-success';
                else if (item.status === '已驳回') statusClass = 'tag-danger';
                row.innerHTML = `
                    <td><input type="checkbox" ${selectedLongitudinalIds.has(item.id) ? 'checked' : ''} onchange="toggleLongitudinalSelect(${item.id}, this)"></td>
                    <td>${item.startDate ? item.startDate.substring(0, 4) : '-'}</td>
                    <td>${item.projectNumber || '-'}</td>
                    <td>${item.name}</td>
                    <td>${item.level || '-'}</td>
                    <td>${item.leader || '-'}</td>
                    <td>${item.unit || '-'}</td>
                    <td>${item.startDate || '-'}</td>
                    <td>${item.funding || '-'}</td>
                    <td><span class="tag ${statusClass}">${item.status}</span></td>
                    <td>
                        <button class="btn" style="padding: 4px 10px; font-size: 12px; margin-right: 5px;" onclick="editLongitudinal(${item.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="deleteLongitudinal(${item.id})">删除</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
        
        function showAddLongitudinalModal() {
            editingLongitudinalId = null;
            document.getElementById('longitudinalModalTitle').textContent = '新增纵向项目';
            document.getElementById('longitudinalName').value = '';
            document.getElementById('longitudinalProjectNumber').value = '';
            document.getElementById('longitudinalLeader').value = '';
            document.getElementById('longitudinalUnit').value = '';
            document.getElementById('longitudinalLevel').value = '';
            document.getElementById('longitudinalStartDate').value = '';
            document.getElementById('longitudinalFunding').value = '';
            document.getElementById('longitudinalStatus').value = '审核中';
            document.getElementById('longitudinalFile').value = '';
            document.getElementById('longitudinalRemark').value = '';
            document.getElementById('longitudinalModal').style.display = 'flex';
        }
        
        function closeLongitudinalModal() { document.getElementById('longitudinalModal').style.display = 'none'; }
        
        function saveLongitudinal() {
            const name = document.getElementById('longitudinalName').value.trim();
            const projectNumber = document.getElementById('longitudinalProjectNumber').value.trim();
            const leader = document.getElementById('longitudinalLeader').value.trim();
            const unit = document.getElementById('longitudinalUnit').value.trim();
            const level = document.getElementById('longitudinalLevel').value;
            const startDate = document.getElementById('longitudinalStartDate').value;
            const funding = document.getElementById('longitudinalFunding').value;
            const status = document.getElementById('longitudinalStatus').value;
            const remark = document.getElementById('longitudinalRemark').value.trim();
            if (!name || !projectNumber || !leader || !unit || !level || !startDate || !funding) { alert('请填写所有必填字段'); return; }
            if (editingLongitudinalId) {
                const idx = longitudinalData.findIndex(d => d.id === editingLongitudinalId);
                if (idx !== -1) longitudinalData[idx] = { ...longitudinalData[idx], name, projectNumber, leader, unit, level, startDate, funding, status, remark };
            } else {
                const newId = longitudinalData.length > 0 ? Math.max(...longitudinalData.map(d => d.id)) + 1 : 1;
                longitudinalData.push({ id: newId, name, projectNumber, leader, unit, level, startDate, funding, status, remark, fileName: '' });
            }
            saveLongitudinalData(); updateLongitudinalFilterCounts(); applyLongitudinalFilters(); closeLongitudinalModal();
            alert('保存成功！');
            try {
                if (typeof offerNewsDraftFromProject === 'function') {
                    setTimeout(function () {
                        offerNewsDraftFromProject({ name: name, projectNumber: projectNumber, leader: leader, status: status, remark: remark, projectType: '纵向' });
                    }, 200);
                }
            } catch (eNews) {}
        }
        
        function editLongitudinal(id) {
            const item = longitudinalData.find(d => d.id === id);
            if (!item) return;
            editingLongitudinalId = id;
            document.getElementById('longitudinalModalTitle').textContent = '编辑纵向项目';
            document.getElementById('longitudinalName').value = item.name;
            document.getElementById('longitudinalProjectNumber').value = item.projectNumber;
            document.getElementById('longitudinalLeader').value = item.leader;
            document.getElementById('longitudinalUnit').value = item.unit;
            document.getElementById('longitudinalLevel').value = item.level;
            document.getElementById('longitudinalStartDate').value = item.startDate;
            document.getElementById('longitudinalFunding').value = item.funding;
            document.getElementById('longitudinalStatus').value = item.status;
            document.getElementById('longitudinalRemark').value = item.remark || '';
            document.getElementById('longitudinalModal').style.display = 'flex';
        }
        
        function deleteLongitudinal(id) {
            if (!confirm('确定要删除这条记录吗？')) return;
            longitudinalData = longitudinalData.filter(d => d.id !== id);
            selectedLongitudinalIds.delete(id);
            saveLongitudinalData(); updateLongitudinalFilterCounts(); applyLongitudinalFilters();
        }
        
        function toggleLongitudinalSelectAll(checkbox) {
            if (checkbox.checked) filteredLongitudinalData.forEach(d => selectedLongitudinalIds.add(d.id));
            else selectedLongitudinalIds.clear();
            renderLongitudinalTable();
        }
        
        function toggleLongitudinalSelect(id, checkbox) {
            if (checkbox.checked) selectedLongitudinalIds.add(id); else selectedLongitudinalIds.delete(id);
        }
        
        function filterLongitudinalByTag(tag, element) {
            document.querySelectorAll('#longitudinalFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            const currentYear = new Date().getFullYear().toString();
            switch(tag) {
                case 'all': filteredLongitudinalData = [...longitudinalData]; break;
                case 'current_year': filteredLongitudinalData = longitudinalData.filter(d => d.startDate && d.startDate.startsWith(currentYear)); break;
                case 'reviewing': filteredLongitudinalData = longitudinalData.filter(d => d.status === '审核中'); break;
                case 'approved': filteredLongitudinalData = longitudinalData.filter(d => d.status === '已通过'); break;
                case 'rejected': filteredLongitudinalData = longitudinalData.filter(d => d.status === '已驳回'); break;
            }
            renderLongitudinalTable();
        }
        
        function toggleLongitudinalMoreFilters() {
            const el = document.getElementById('longitudinalMoreFilters');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }
        
        function applyLongitudinalFilters() {
            const name = document.getElementById('longitudinalFilterName').value.trim().toLowerCase();
            const projectNumber = document.getElementById('longitudinalFilterNumber').value.trim().toLowerCase();
            const leader = document.getElementById('longitudinalFilterLeader').value.trim().toLowerCase();
            const year = document.getElementById('longitudinalFilterYear').value;
            const status = document.getElementById('longitudinalFilterStatus').value;
            const level = document.getElementById('longitudinalFilterLevel').value;
            const unit = document.getElementById('longitudinalFilterUnit').value.trim().toLowerCase();
            const dateFrom = document.getElementById('longitudinalFilterDateFrom').value;
            const dateTo = document.getElementById('longitudinalFilterDateTo').value;
            filteredLongitudinalData = longitudinalData.filter(d => {
                if (name && !d.name.toLowerCase().includes(name)) return false;
                if (projectNumber && !d.projectNumber.toLowerCase().includes(projectNumber)) return false;
                if (leader && !d.leader.toLowerCase().includes(leader)) return false;
                if (year && (!d.startDate || !d.startDate.startsWith(year))) return false;
                if (status && d.status !== status) return false;
                if (level && d.level !== level) return false;
                if (unit && (!d.unit || !d.unit.toLowerCase().includes(unit))) return false;
                if (dateFrom && (!d.startDate || d.startDate < dateFrom)) return false;
                if (dateTo && (!d.startDate || d.startDate > dateTo)) return false;
                return true;
            });
            renderLongitudinalTable();
        }
        
        function resetLongitudinalFilters() {
            document.getElementById('longitudinalFilterName').value = '';
            document.getElementById('longitudinalFilterNumber').value = '';
            document.getElementById('longitudinalFilterLeader').value = '';
            document.getElementById('longitudinalFilterYear').value = '';
            document.getElementById('longitudinalFilterStatus').value = '';
            document.getElementById('longitudinalFilterLevel').value = '';
            document.getElementById('longitudinalFilterUnit').value = '';
            document.getElementById('longitudinalFilterDateFrom').value = '';
            document.getElementById('longitudinalFilterDateTo').value = '';
            document.getElementById('longitudinalMoreFilters').style.display = 'none';
            document.querySelectorAll('#longitudinalFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            document.querySelector('#longitudinalFilterTags .filter-tag').classList.add('active');
            filteredLongitudinalData = [...longitudinalData];
            renderLongitudinalTable();
        }
        
        function sortLongitudinalTable(field) {
            if (longitudinalSortField === field) longitudinalSortOrder = longitudinalSortOrder === 'asc' ? 'desc' : 'asc';
            else { longitudinalSortField = field; longitudinalSortOrder = 'asc'; }
            filteredLongitudinalData.sort((a, b) => {
                let valA = a[field] || ''; let valB = b[field] || '';
                if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
                if (valA < valB) return longitudinalSortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return longitudinalSortOrder === 'asc' ? 1 : -1;
                return 0;
            });
            renderLongitudinalTable();
        }
        
        function batchDeleteLongitudinal() {
            if (selectedLongitudinalIds.size === 0) { alert('请先选择要删除的记录'); return; }
            if (!confirm(`确定要删除选中的 ${selectedLongitudinalIds.size} 条记录吗？`)) return;
            longitudinalData = longitudinalData.filter(d => !selectedLongitudinalIds.has(d.id));
            selectedLongitudinalIds.clear();
            saveLongitudinalData(); updateLongitudinalFilterCounts(); applyLongitudinalFilters();
        }
        
        function batchAuditLongitudinal() {
            if (selectedLongitudinalIds.size === 0) { alert('请先选择要审核的记录'); return; }
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">批量审核</h3>
                <div class="form-group"><label>新状态</label>
                    <select id="batchAuditLongitudinalStatusSelect" class="form-control">
                        <option value="审核中">审核中</option><option value="已通过">已通过</option><option value="已驳回">已驳回</option>
                    </select>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">取消</button>
                    <button class="btn" onclick="confirmBatchAuditLongitudinal(this)">确定</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        function confirmBatchAuditLongitudinal(btn) {
            const newStatus = document.getElementById('batchAuditLongitudinalStatusSelect').value;
            longitudinalData.forEach(d => { if (selectedLongitudinalIds.has(d.id)) d.status = newStatus; });
            selectedLongitudinalIds.clear();
            saveLongitudinalData(); updateLongitudinalFilterCounts(); applyLongitudinalFilters();
            btn.closest('div[style*="fixed"]').remove();
            alert('批量审核完成！');
        }
        
        function exportLongitudinal() {
            if (filteredLongitudinalData.length === 0) { alert('没有可导出的数据'); return; }
            let csv = '\ufeff立项年度,项目编号,项目名称,项目级别,负责人,所属单位,立项日期,经费(万元),状态\n';
            filteredLongitudinalData.forEach(d => {
                csv += `${d.startDate ? d.startDate.substring(0,4) : ''},${d.projectNumber},${d.name},${d.level},${d.leader},${d.unit},${d.startDate},${d.funding},${d.status}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '纵向项目数据_' + new Date().toISOString().slice(0,10) + '.csv';
            link.click();
        }
        
        function importLongitudinal() {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.csv';
            input.onchange = function(e) {
                const file = e.target.files[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 9) {
                            const newId = longitudinalData.length > 0 ? Math.max(...longitudinalData.map(d => d.id)) + 1 : 1;
                            longitudinalData.push({ id: newId, name: cols[2] || '', projectNumber: cols[1] || '', level: cols[3] || '', leader: cols[4] || '', unit: cols[5] || '', startDate: cols[6] || '', funding: cols[7] || '', status: cols[8] || '审核中', remark: '', fileName: '' });
                            count++;
                        }
                    }
                    saveLongitudinalData(); updateLongitudinalFilterCounts(); applyLongitudinalFilters();
                    alert(`成功导入 ${count} 条记录`);
                };
                reader.readAsText(file, 'UTF-8');
            };
            input.click();
        }
        
        function viewLongitudinalStats() {
            const total = longitudinalData.length;
            const currentYear = new Date().getFullYear().toString();
            const thisYear = longitudinalData.filter(d => d.startDate && d.startDate.startsWith(currentYear)).length;
            const approved = longitudinalData.filter(d => d.status === '已通过').length;
            const reviewing = longitudinalData.filter(d => d.status === '审核中').length;
            const rejected = longitudinalData.filter(d => d.status === '已驳回').length;
            const totalFunding = longitudinalData.reduce((sum, d) => sum + (parseFloat(d.funding) || 0), 0);
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">纵向项目统计</h3>
                <div style="line-height:2;font-size:15px;">
                    <p>总数：<strong>${total}</strong></p>
                    <p>当年立项：<strong>${thisYear}</strong></p>
                    <p>总经费：<strong style="color:#17a2b8;">${totalFunding.toFixed(2)} 万元</strong></p>
                    <p>已通过：<strong style="color:#28a745;">${approved}</strong></p>
                    <p>审核中：<strong style="color:#ffc107;">${reviewing}</strong></p>
                    <p>已驳回：<strong style="color:#dc3545;">${rejected}</strong></p>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:20px;">
                    <button class="btn" onclick="this.closest('div[style*=fixed]').remove()">关闭</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        // ========== 横向项目管理模块 ==========
        
        var horizontalData = [];
        var filteredHorizontalData = [];
        var selectedHorizontalIds = new Set();
        var editingHorizontalId = null;
        var horizontalSortField = '';
        var horizontalSortOrder = 'asc';
        
        function initHorizontalData() {
            const saved = localStorage.getItem('horizontalData');
            if (saved) { horizontalData = JSON.parse(saved); }
            else { horizontalData = []; localStorage.setItem('horizontalData', JSON.stringify(horizontalData)); }
            filteredHorizontalData = [...horizontalData];
            updateHorizontalFilterCounts();
            renderHorizontalTable();
        }
        
        function saveHorizontalData() { localStorage.setItem('horizontalData', JSON.stringify(horizontalData)); }
        
        function updateHorizontalFilterCounts() {
            const currentYear = new Date().getFullYear().toString();
            document.getElementById('horizontalCountAll').textContent = horizontalData.length;
            document.getElementById('horizontalCountCurrentYear').textContent = horizontalData.filter(d => d.startDate && d.startDate.startsWith(currentYear)).length;
            document.getElementById('horizontalCountReviewing').textContent = horizontalData.filter(d => d.status === '审核中').length;
            document.getElementById('horizontalCountApproved').textContent = horizontalData.filter(d => d.status === '已通过').length;
            document.getElementById('horizontalCountRejected').textContent = horizontalData.filter(d => d.status === '已驳回').length;
        }
        
        function renderHorizontalTable() {
            const tbody = document.getElementById('horizontalTableBody');
            const emptyMsg = document.getElementById('horizontalEmptyMessage');
            tbody.innerHTML = '';
            if (filteredHorizontalData.length === 0) { emptyMsg.style.display = 'block'; return; }
            emptyMsg.style.display = 'none';
            filteredHorizontalData.forEach(item => {
                const row = document.createElement('tr');
                let statusClass = 'tag-warning';
                if (item.status === '已通过') statusClass = 'tag-success';
                else if (item.status === '已驳回') statusClass = 'tag-danger';
                row.innerHTML = `
                    <td><input type="checkbox" ${selectedHorizontalIds.has(item.id) ? 'checked' : ''} onchange="toggleHorizontalSelect(${item.id}, this)"></td>
                    <td>${item.startDate ? item.startDate.substring(0, 4) : '-'}</td>
                    <td>${item.projectNumber || '-'}</td>
                    <td>${item.name}</td>
                    <td>${item.company || '-'}</td>
                    <td>${item.leader || '-'}</td>
                    <td>${item.unit || '-'}</td>
                    <td>${item.startDate || '-'}</td>
                    <td>${item.funding || '-'}</td>
                    <td><span class="tag ${statusClass}">${item.status}</span></td>
                    <td>
                        <button class="btn" style="padding: 4px 10px; font-size: 12px; margin-right: 5px;" onclick="editHorizontal(${item.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="deleteHorizontal(${item.id})">删除</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
        
        function showAddHorizontalModal() {
            editingHorizontalId = null;
            document.getElementById('horizontalModalTitle').textContent = '新增横向项目';
            document.getElementById('horizontalName').value = '';
            document.getElementById('horizontalProjectNumber').value = '';
            document.getElementById('horizontalLeader').value = '';
            document.getElementById('horizontalCompany').value = '';
            document.getElementById('horizontalUnit').value = '';
            document.getElementById('horizontalStartDate').value = '';
            document.getElementById('horizontalFunding').value = '';
            document.getElementById('horizontalStatus').value = '审核中';
            document.getElementById('horizontalFile').value = '';
            document.getElementById('horizontalRemark').value = '';
            document.getElementById('horizontalModal').style.display = 'flex';
        }
        
        function closeHorizontalModal() { document.getElementById('horizontalModal').style.display = 'none'; }
        
        function saveHorizontal() {
            const name = document.getElementById('horizontalName').value.trim();
            const projectNumber = document.getElementById('horizontalProjectNumber').value.trim();
            const leader = document.getElementById('horizontalLeader').value.trim();
            const company = document.getElementById('horizontalCompany').value.trim();
            const unit = document.getElementById('horizontalUnit').value.trim();
            const startDate = document.getElementById('horizontalStartDate').value;
            const funding = document.getElementById('horizontalFunding').value;
            const status = document.getElementById('horizontalStatus').value;
            const remark = document.getElementById('horizontalRemark').value.trim();
            if (!name || !projectNumber || !leader || !company || !unit || !startDate || !funding) { alert('请填写所有必填字段'); return; }
            if (editingHorizontalId) {
                const idx = horizontalData.findIndex(d => d.id === editingHorizontalId);
                if (idx !== -1) horizontalData[idx] = { ...horizontalData[idx], name, projectNumber, leader, company, unit, startDate, funding, status, remark };
            } else {
                const newId = horizontalData.length > 0 ? Math.max(...horizontalData.map(d => d.id)) + 1 : 1;
                horizontalData.push({ id: newId, name, projectNumber, leader, company, unit, startDate, funding, status, remark, fileName: '' });
            }
            saveHorizontalData(); updateHorizontalFilterCounts(); applyHorizontalFilters(); closeHorizontalModal();
            alert('保存成功！');
            try {
                if (typeof offerNewsDraftFromProject === 'function') {
                    setTimeout(function () {
                        offerNewsDraftFromProject({ name: name, projectNumber: projectNumber, leader: leader, status: status, remark: remark, projectType: '横向' });
                    }, 200);
                }
            } catch (eNews) {}
        }
        
        function editHorizontal(id) {
            const item = horizontalData.find(d => d.id === id);
            if (!item) return;
            editingHorizontalId = id;
            document.getElementById('horizontalModalTitle').textContent = '编辑横向项目';
            document.getElementById('horizontalName').value = item.name;
            document.getElementById('horizontalProjectNumber').value = item.projectNumber;
            document.getElementById('horizontalLeader').value = item.leader;
            document.getElementById('horizontalCompany').value = item.company;
            document.getElementById('horizontalUnit').value = item.unit;
            document.getElementById('horizontalStartDate').value = item.startDate;
            document.getElementById('horizontalFunding').value = item.funding;
            document.getElementById('horizontalStatus').value = item.status;
            document.getElementById('horizontalRemark').value = item.remark || '';
            document.getElementById('horizontalModal').style.display = 'flex';
        }
        
        function deleteHorizontal(id) {
            if (!confirm('确定要删除这条记录吗？')) return;
            horizontalData = horizontalData.filter(d => d.id !== id);
            selectedHorizontalIds.delete(id);
            saveHorizontalData(); updateHorizontalFilterCounts(); applyHorizontalFilters();
        }
        
        function toggleHorizontalSelectAll(checkbox) {
            if (checkbox.checked) filteredHorizontalData.forEach(d => selectedHorizontalIds.add(d.id));
            else selectedHorizontalIds.clear();
            renderHorizontalTable();
        }
        
        function toggleHorizontalSelect(id, checkbox) {
            if (checkbox.checked) selectedHorizontalIds.add(id); else selectedHorizontalIds.delete(id);
        }
        
        function filterHorizontalByTag(tag, element) {
            document.querySelectorAll('#horizontalFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            const currentYear = new Date().getFullYear().toString();
            switch(tag) {
                case 'all': filteredHorizontalData = [...horizontalData]; break;
                case 'current_year': filteredHorizontalData = horizontalData.filter(d => d.startDate && d.startDate.startsWith(currentYear)); break;
                case 'reviewing': filteredHorizontalData = horizontalData.filter(d => d.status === '审核中'); break;
                case 'approved': filteredHorizontalData = horizontalData.filter(d => d.status === '已通过'); break;
                case 'rejected': filteredHorizontalData = horizontalData.filter(d => d.status === '已驳回'); break;
            }
            renderHorizontalTable();
        }
        
        function toggleHorizontalMoreFilters() {
            const el = document.getElementById('horizontalMoreFilters');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }
        
        function applyHorizontalFilters() {
            const name = document.getElementById('horizontalFilterName').value.trim().toLowerCase();
            const projectNumber = document.getElementById('horizontalFilterNumber').value.trim().toLowerCase();
            const leader = document.getElementById('horizontalFilterLeader').value.trim().toLowerCase();
            const year = document.getElementById('horizontalFilterYear').value;
            const status = document.getElementById('horizontalFilterStatus').value;
            const company = document.getElementById('horizontalFilterCompany').value.trim().toLowerCase();
            const unit = document.getElementById('horizontalFilterUnit').value.trim().toLowerCase();
            const dateFrom = document.getElementById('horizontalFilterDateFrom').value;
            const dateTo = document.getElementById('horizontalFilterDateTo').value;
            filteredHorizontalData = horizontalData.filter(d => {
                if (name && !d.name.toLowerCase().includes(name)) return false;
                if (projectNumber && !d.projectNumber.toLowerCase().includes(projectNumber)) return false;
                if (leader && !d.leader.toLowerCase().includes(leader)) return false;
                if (year && (!d.startDate || !d.startDate.startsWith(year))) return false;
                if (status && d.status !== status) return false;
                if (company && (!d.company || !d.company.toLowerCase().includes(company))) return false;
                if (unit && (!d.unit || !d.unit.toLowerCase().includes(unit))) return false;
                if (dateFrom && (!d.startDate || d.startDate < dateFrom)) return false;
                if (dateTo && (!d.startDate || d.startDate > dateTo)) return false;
                return true;
            });
            renderHorizontalTable();
        }
        
        function resetHorizontalFilters() {
            document.getElementById('horizontalFilterName').value = '';
            document.getElementById('horizontalFilterNumber').value = '';
            document.getElementById('horizontalFilterLeader').value = '';
            document.getElementById('horizontalFilterYear').value = '';
            document.getElementById('horizontalFilterStatus').value = '';
            document.getElementById('horizontalFilterCompany').value = '';
            document.getElementById('horizontalFilterUnit').value = '';
            document.getElementById('horizontalFilterDateFrom').value = '';
            document.getElementById('horizontalFilterDateTo').value = '';
            document.getElementById('horizontalMoreFilters').style.display = 'none';
            document.querySelectorAll('#horizontalFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            document.querySelector('#horizontalFilterTags .filter-tag').classList.add('active');
            filteredHorizontalData = [...horizontalData];
            renderHorizontalTable();
        }
        
        function sortHorizontalTable(field) {
            if (horizontalSortField === field) horizontalSortOrder = horizontalSortOrder === 'asc' ? 'desc' : 'asc';
            else { horizontalSortField = field; horizontalSortOrder = 'asc'; }
            filteredHorizontalData.sort((a, b) => {
                let valA = a[field] || ''; let valB = b[field] || '';
                if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
                if (valA < valB) return horizontalSortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return horizontalSortOrder === 'asc' ? 1 : -1;
                return 0;
            });
            renderHorizontalTable();
        }
        
        function batchDeleteHorizontal() {
            if (selectedHorizontalIds.size === 0) { alert('请先选择要删除的记录'); return; }
            if (!confirm(`确定要删除选中的 ${selectedHorizontalIds.size} 条记录吗？`)) return;
            horizontalData = horizontalData.filter(d => !selectedHorizontalIds.has(d.id));
            selectedHorizontalIds.clear();
            saveHorizontalData(); updateHorizontalFilterCounts(); applyHorizontalFilters();
        }
        
        function batchAuditHorizontal() {
            if (selectedHorizontalIds.size === 0) { alert('请先选择要审核的记录'); return; }
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">批量审核</h3>
                <div class="form-group"><label>新状态</label>
                    <select id="batchAuditHorizontalStatusSelect" class="form-control">
                        <option value="审核中">审核中</option><option value="已通过">已通过</option><option value="已驳回">已驳回</option>
                    </select>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">取消</button>
                    <button class="btn" onclick="confirmBatchAuditHorizontal(this)">确定</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        function confirmBatchAuditHorizontal(btn) {
            const newStatus = document.getElementById('batchAuditHorizontalStatusSelect').value;
            horizontalData.forEach(d => { if (selectedHorizontalIds.has(d.id)) d.status = newStatus; });
            selectedHorizontalIds.clear();
            saveHorizontalData(); updateHorizontalFilterCounts(); applyHorizontalFilters();
            btn.closest('div[style*="fixed"]').remove();
            alert('批量审核完成！');
        }
        
        function exportHorizontal() {
            if (filteredHorizontalData.length === 0) { alert('没有可导出的数据'); return; }
            let csv = '\ufeff立项年度,合同编号,项目名称,委托单位,负责人,所属单位,立项日期,经费(万元),状态\n';
            filteredHorizontalData.forEach(d => {
                csv += `${d.startDate ? d.startDate.substring(0,4) : ''},${d.projectNumber},${d.name},${d.company},${d.leader},${d.unit},${d.startDate},${d.funding},${d.status}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '横向项目数据_' + new Date().toISOString().slice(0,10) + '.csv';
            link.click();
        }
        
        function importHorizontal() {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.csv';
            input.onchange = function(e) {
                const file = e.target.files[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 9) {
                            const newId = horizontalData.length > 0 ? Math.max(...horizontalData.map(d => d.id)) + 1 : 1;
                            horizontalData.push({ id: newId, name: cols[2] || '', projectNumber: cols[1] || '', company: cols[3] || '', leader: cols[4] || '', unit: cols[5] || '', startDate: cols[6] || '', funding: cols[7] || '', status: cols[8] || '审核中', remark: '', fileName: '' });
                            count++;
                        }
                    }
                    saveHorizontalData(); updateHorizontalFilterCounts(); applyHorizontalFilters();
                    alert(`成功导入 ${count} 条记录`);
                };
                reader.readAsText(file, 'UTF-8');
            };
            input.click();
        }
        
        function viewHorizontalStats() {
            const total = horizontalData.length;
            const currentYear = new Date().getFullYear().toString();
            const thisYear = horizontalData.filter(d => d.startDate && d.startDate.startsWith(currentYear)).length;
            const approved = horizontalData.filter(d => d.status === '已通过').length;
            const reviewing = horizontalData.filter(d => d.status === '审核中').length;
            const rejected = horizontalData.filter(d => d.status === '已驳回').length;
            const totalFunding = horizontalData.reduce((sum, d) => sum + (parseFloat(d.funding) || 0), 0);
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">横向项目统计</h3>
                <div style="line-height:2;font-size:15px;">
                    <p>总数：<strong>${total}</strong></p>
                    <p>当年立项：<strong>${thisYear}</strong></p>
                    <p>总经费：<strong style="color:#17a2b8;">${totalFunding.toFixed(2)} 万元</strong></p>
                    <p>已通过：<strong style="color:#28a745;">${approved}</strong></p>
                    <p>审核中：<strong style="color:#ffc107;">${reviewing}</strong></p>
                    <p>已驳回：<strong style="color:#dc3545;">${rejected}</strong></p>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:20px;">
                    <button class="btn" onclick="this.closest('div[style*=fixed]').remove()">关闭</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        // ========== 校级项目管理模块 ==========
        
        var schoolData = [];
        var filteredSchoolData = [];
        var selectedSchoolIds = new Set();
        var editingSchoolId = null;
        var schoolSortField = '';
        var schoolSortOrder = 'asc';
        
        function initSchoolData() {
            const saved = localStorage.getItem('schoolData');
            if (saved) { schoolData = JSON.parse(saved); }
            else { schoolData = []; localStorage.setItem('schoolData', JSON.stringify(schoolData)); }
            filteredSchoolData = [...schoolData];
            updateSchoolFilterCounts();
            renderSchoolTable();
        }
        
        function saveSchoolData() { localStorage.setItem('schoolData', JSON.stringify(schoolData)); }
        
        function updateSchoolFilterCounts() {
            const currentYear = new Date().getFullYear().toString();
            document.getElementById('schoolCountAll').textContent = schoolData.length;
            document.getElementById('schoolCountCurrentYear').textContent = schoolData.filter(d => d.startDate && d.startDate.startsWith(currentYear)).length;
            document.getElementById('schoolCountReviewing').textContent = schoolData.filter(d => d.status === '审核中').length;
            document.getElementById('schoolCountApproved').textContent = schoolData.filter(d => d.status === '已通过').length;
            document.getElementById('schoolCountRejected').textContent = schoolData.filter(d => d.status === '已驳回').length;
        }
        
        function renderSchoolTable() {
            const tbody = document.getElementById('schoolTableBody');
            const emptyMsg = document.getElementById('schoolEmptyMessage');
            tbody.innerHTML = '';
            if (filteredSchoolData.length === 0) { emptyMsg.style.display = 'block'; return; }
            emptyMsg.style.display = 'none';
            filteredSchoolData.forEach(item => {
                const row = document.createElement('tr');
                let statusClass = 'tag-warning';
                if (item.status === '已通过') statusClass = 'tag-success';
                else if (item.status === '已驳回') statusClass = 'tag-danger';
                row.innerHTML = `
                    <td><input type="checkbox" ${selectedSchoolIds.has(item.id) ? 'checked' : ''} onchange="toggleSchoolSelect(${item.id}, this)"></td>
                    <td>${item.startDate ? item.startDate.substring(0, 4) : '-'}</td>
                    <td>${item.projectNumber || '-'}</td>
                    <td>${item.name}</td>
                    <td>${item.type || '-'}</td>
                    <td>${item.leader || '-'}</td>
                    <td>${item.unit || '-'}</td>
                    <td>${item.startDate || '-'}</td>
                    <td>${item.funding || '-'}</td>
                    <td><span class="tag ${statusClass}">${item.status}</span></td>
                    <td>
                        <button class="btn" style="padding: 4px 10px; font-size: 12px; margin-right: 5px;" onclick="editSchool(${item.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="deleteSchool(${item.id})">删除</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
        
        function showAddSchoolModal() {
            editingSchoolId = null;
            document.getElementById('schoolModalTitle').textContent = '新增校级项目';
            document.getElementById('schoolName').value = '';
            document.getElementById('schoolProjectNumber').value = '';
            document.getElementById('schoolLeader').value = '';
            document.getElementById('schoolUnit').value = '';
            document.getElementById('schoolType').value = '';
            document.getElementById('schoolStartDate').value = '';
            document.getElementById('schoolFunding').value = '';
            document.getElementById('schoolStatus').value = '审核中';
            document.getElementById('schoolFile').value = '';
            document.getElementById('schoolRemark').value = '';
            document.getElementById('schoolModal').style.display = 'flex';
        }
        
        function closeSchoolModal() { document.getElementById('schoolModal').style.display = 'none'; }
        
        function saveSchool() {
            const name = document.getElementById('schoolName').value.trim();
            const projectNumber = document.getElementById('schoolProjectNumber').value.trim();
            const leader = document.getElementById('schoolLeader').value.trim();
            const unit = document.getElementById('schoolUnit').value.trim();
            const type = document.getElementById('schoolType').value;
            const startDate = document.getElementById('schoolStartDate').value;
            const funding = document.getElementById('schoolFunding').value;
            const status = document.getElementById('schoolStatus').value;
            const remark = document.getElementById('schoolRemark').value.trim();
            if (!name || !projectNumber || !leader || !unit || !type || !startDate || !funding) { alert('请填写所有必填字段'); return; }
            if (editingSchoolId) {
                const idx = schoolData.findIndex(d => d.id === editingSchoolId);
                if (idx !== -1) schoolData[idx] = { ...schoolData[idx], name, projectNumber, leader, unit, type, startDate, funding, status, remark };
            } else {
                const newId = schoolData.length > 0 ? Math.max(...schoolData.map(d => d.id)) + 1 : 1;
                schoolData.push({ id: newId, name, projectNumber, leader, unit, type, startDate, funding, status, remark, fileName: '' });
            }
            saveSchoolData(); updateSchoolFilterCounts(); applySchoolFilters(); closeSchoolModal();
            alert('保存成功！');
            try {
                if (typeof offerNewsDraftFromProject === 'function') {
                    setTimeout(function () {
                        offerNewsDraftFromProject({ name: name, projectNumber: projectNumber, leader: leader, status: status, remark: remark, projectType: '校级' });
                    }, 200);
                }
            } catch (eNews) {}
        }
        
        function editSchool(id) {
            const item = schoolData.find(d => d.id === id);
            if (!item) return;
            editingSchoolId = id;
            document.getElementById('schoolModalTitle').textContent = '编辑校级项目';
            document.getElementById('schoolName').value = item.name;
            document.getElementById('schoolProjectNumber').value = item.projectNumber;
            document.getElementById('schoolLeader').value = item.leader;
            document.getElementById('schoolUnit').value = item.unit;
            document.getElementById('schoolType').value = item.type;
            document.getElementById('schoolStartDate').value = item.startDate;
            document.getElementById('schoolFunding').value = item.funding;
            document.getElementById('schoolStatus').value = item.status;
            document.getElementById('schoolRemark').value = item.remark || '';
            document.getElementById('schoolModal').style.display = 'flex';
        }
        
        function deleteSchool(id) {
            if (!confirm('确定要删除这条记录吗？')) return;
            schoolData = schoolData.filter(d => d.id !== id);
            selectedSchoolIds.delete(id);
            saveSchoolData(); updateSchoolFilterCounts(); applySchoolFilters();
        }
        
        function toggleSchoolSelectAll(checkbox) {
            if (checkbox.checked) filteredSchoolData.forEach(d => selectedSchoolIds.add(d.id));
            else selectedSchoolIds.clear();
            renderSchoolTable();
        }
        
        function toggleSchoolSelect(id, checkbox) {
            if (checkbox.checked) selectedSchoolIds.add(id); else selectedSchoolIds.delete(id);
        }
        
        function filterSchoolByTag(tag, element) {
            document.querySelectorAll('#schoolFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            const currentYear = new Date().getFullYear().toString();
            switch(tag) {
                case 'all': filteredSchoolData = [...schoolData]; break;
                case 'current_year': filteredSchoolData = schoolData.filter(d => d.startDate && d.startDate.startsWith(currentYear)); break;
                case 'reviewing': filteredSchoolData = schoolData.filter(d => d.status === '审核中'); break;
                case 'approved': filteredSchoolData = schoolData.filter(d => d.status === '已通过'); break;
                case 'rejected': filteredSchoolData = schoolData.filter(d => d.status === '已驳回'); break;
            }
            renderSchoolTable();
        }
        
        function toggleSchoolMoreFilters() {
            const el = document.getElementById('schoolMoreFilters');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }
        
        function applySchoolFilters() {
            const name = document.getElementById('schoolFilterName').value.trim().toLowerCase();
            const projectNumber = document.getElementById('schoolFilterNumber').value.trim().toLowerCase();
            const leader = document.getElementById('schoolFilterLeader').value.trim().toLowerCase();
            const year = document.getElementById('schoolFilterYear').value;
            const status = document.getElementById('schoolFilterStatus').value;
            const type = document.getElementById('schoolFilterType').value;
            const unit = document.getElementById('schoolFilterUnit').value.trim().toLowerCase();
            const dateFrom = document.getElementById('schoolFilterDateFrom').value;
            const dateTo = document.getElementById('schoolFilterDateTo').value;
            filteredSchoolData = schoolData.filter(d => {
                if (name && !d.name.toLowerCase().includes(name)) return false;
                if (projectNumber && !d.projectNumber.toLowerCase().includes(projectNumber)) return false;
                if (leader && !d.leader.toLowerCase().includes(leader)) return false;
                if (year && (!d.startDate || !d.startDate.startsWith(year))) return false;
                if (status && d.status !== status) return false;
                if (type && d.type !== type) return false;
                if (unit && (!d.unit || !d.unit.toLowerCase().includes(unit))) return false;
                if (dateFrom && (!d.startDate || d.startDate < dateFrom)) return false;
                if (dateTo && (!d.startDate || d.startDate > dateTo)) return false;
                return true;
            });
            renderSchoolTable();
        }
        
        function resetSchoolFilters() {
            document.getElementById('schoolFilterName').value = '';
            document.getElementById('schoolFilterNumber').value = '';
            document.getElementById('schoolFilterLeader').value = '';
            document.getElementById('schoolFilterYear').value = '';
            document.getElementById('schoolFilterStatus').value = '';
            document.getElementById('schoolFilterType').value = '';
            document.getElementById('schoolFilterUnit').value = '';
            document.getElementById('schoolFilterDateFrom').value = '';
            document.getElementById('schoolFilterDateTo').value = '';
            document.getElementById('schoolMoreFilters').style.display = 'none';
            document.querySelectorAll('#schoolFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            document.querySelector('#schoolFilterTags .filter-tag').classList.add('active');
            filteredSchoolData = [...schoolData];
            renderSchoolTable();
        }
        
        function sortSchoolTable(field) {
            if (schoolSortField === field) schoolSortOrder = schoolSortOrder === 'asc' ? 'desc' : 'asc';
            else { schoolSortField = field; schoolSortOrder = 'asc'; }
            filteredSchoolData.sort((a, b) => {
                let valA = a[field] || ''; let valB = b[field] || '';
                if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
                if (valA < valB) return schoolSortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return schoolSortOrder === 'asc' ? 1 : -1;
                return 0;
            });
            renderSchoolTable();
        }
        
        function batchDeleteSchool() {
            if (selectedSchoolIds.size === 0) { alert('请先选择要删除的记录'); return; }
            if (!confirm(`确定要删除选中的 ${selectedSchoolIds.size} 条记录吗？`)) return;
            schoolData = schoolData.filter(d => !selectedSchoolIds.has(d.id));
            selectedSchoolIds.clear();
            saveSchoolData(); updateSchoolFilterCounts(); applySchoolFilters();
        }
        
        function batchAuditSchool() {
            if (selectedSchoolIds.size === 0) { alert('请先选择要审核的记录'); return; }
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">批量审核</h3>
                <div class="form-group"><label>新状态</label>
                    <select id="batchAuditSchoolStatusSelect" class="form-control">
                        <option value="审核中">审核中</option><option value="已通过">已通过</option><option value="已驳回">已驳回</option>
                    </select>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">取消</button>
                    <button class="btn" onclick="confirmBatchAuditSchool(this)">确定</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        function confirmBatchAuditSchool(btn) {
            const newStatus = document.getElementById('batchAuditSchoolStatusSelect').value;
            schoolData.forEach(d => { if (selectedSchoolIds.has(d.id)) d.status = newStatus; });
            selectedSchoolIds.clear();
            saveSchoolData(); updateSchoolFilterCounts(); applySchoolFilters();
            btn.closest('div[style*="fixed"]').remove();
            alert('批量审核完成！');
        }
        
        function exportSchool() {
            if (filteredSchoolData.length === 0) { alert('没有可导出的数据'); return; }
            let csv = '\ufeff立项年度,项目编号,项目名称,项目类型,负责人,所属单位,立项日期,经费(万元),状态\n';
            filteredSchoolData.forEach(d => {
                csv += `${d.startDate ? d.startDate.substring(0,4) : ''},${d.projectNumber},${d.name},${d.type},${d.leader},${d.unit},${d.startDate},${d.funding},${d.status}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '校级项目数据_' + new Date().toISOString().slice(0,10) + '.csv';
            link.click();
        }
        
        function importSchool() {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.csv';
            input.onchange = function(e) {
                const file = e.target.files[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 9) {
                            const newId = schoolData.length > 0 ? Math.max(...schoolData.map(d => d.id)) + 1 : 1;
                            schoolData.push({ id: newId, name: cols[2] || '', projectNumber: cols[1] || '', type: cols[3] || '', leader: cols[4] || '', unit: cols[5] || '', startDate: cols[6] || '', funding: cols[7] || '', status: cols[8] || '审核中', remark: '', fileName: '' });
                            count++;
                        }
                    }
                    saveSchoolData(); updateSchoolFilterCounts(); applySchoolFilters();
                    alert(`成功导入 ${count} 条记录`);
                };
                reader.readAsText(file, 'UTF-8');
            };
            input.click();
        }
        
        function viewSchoolStats() {
            const total = schoolData.length;
            const currentYear = new Date().getFullYear().toString();
            const thisYear = schoolData.filter(d => d.startDate && d.startDate.startsWith(currentYear)).length;
            const approved = schoolData.filter(d => d.status === '已通过').length;
            const reviewing = schoolData.filter(d => d.status === '审核中').length;
            const rejected = schoolData.filter(d => d.status === '已驳回').length;
            const totalFunding = schoolData.reduce((sum, d) => sum + (parseFloat(d.funding) || 0), 0);
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">校级项目统计</h3>
                <div style="line-height:2;font-size:15px;">
                    <p>总数：<strong>${total}</strong></p>
                    <p>当年立项：<strong>${thisYear}</strong></p>
                    <p>总经费：<strong style="color:#17a2b8;">${totalFunding.toFixed(2)} 万元</strong></p>
                    <p>已通过：<strong style="color:#28a745;">${approved}</strong></p>
                    <p>审核中：<strong style="color:#ffc107;">${reviewing}</strong></p>
                    <p>已驳回：<strong style="color:#dc3545;">${rejected}</strong></p>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:20px;">
                    <button class="btn" onclick="this.closest('div[style*=fixed]').remove()">关闭</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        // ========== 团队成员档案模块 ==========
        
        var teamMemberData = [];
        var editingMemberId = null;

        function getProfileLibraryAdvisors() {
            return [
                {
                    name: '王丽萍',
                    category: 'advisor',
                    title: '重庆科技大学教授、科技处处长',
                    phone: '13996488662',
                    email: 'wangliping98@163.com',
                    research: '城市安全、智能运维、结构抗震',
                    education: '2005-2010年重庆大学防灾减灾及防护工程博士；2002-2005年新疆大学结构工程硕士；1998-2002年新疆大学工民建学士',
                    projects: '国家自然科学基金青年/地区项目；重庆市科委社会类重点研发项目等',
                    awards: '重庆市科技进步二等奖、三等奖；重庆市建设创新一等奖',
                    bio: '王丽萍，1980年11月生，女，重庆科技大学教授，科技处处长，重庆安全生产科学研究院副院长，防灾减灾及防护工程专业博士，重庆市巾帼科技创新团队负责人。2013年赴新加坡南洋理工大学访问，2016年赴美国内华达拉斯维加斯大学访学。长期从事工程结构抗灾和城市区域防灾研究。',
                    avatar: '',
                    fileName: ''
                },
                {
                    name: '罗文文',
                    category: 'advisor',
                    title: '博士、副教授',
                    phone: '18523539873',
                    email: 'luowenwen326@163.com',
                    research: '工程结构抗震与城市灾害风险研究',
                    education: '2009/09～2015/12重庆大学土木工程学院工学博士(直攻博)；2005/09～2009/06重庆大学土木工程学院工学学士',
                    projects: '国家自然科学基金青年项目；兵团重点领域科技攻关项目；重庆市自然科学基金等',
                    awards: '新疆建设兵团科学技术奖自然科学奖二等奖',
                    bio: '罗文文，男，博士，副教授。1987年10月出生于四川省绵阳市。2009年、2015年分别获得重庆大学学士和博士学位。主持国家自然科学基金1项及多项省部级项目，发表论文20余篇，授权发明专利6项，参编专著2部、地方标准2项。',
                    avatar: '',
                    fileName: ''
                },
                {
                    name: '罗钧',
                    category: 'advisor',
                    title: '土木工程博士/博士后，高级工程师，硕士生导师',
                    phone: '13452426159',
                    email: 'jluo@cqust.edu.cn',
                    research: '基于人工智能和图像信息的结构振动测试和损伤诊断，多信息融合的结构三维数字模型构建',
                    education: '2009-2016年重庆大学土木工程博士（直博）；2005-2009年重庆大学土木工程学士',
                    projects: '重庆市自然科学基金创新发展联合基金重点项目；重庆市博士后特别资助项目；重庆市自然科学基金面上项目等',
                    awards: '省部级科技进步奖；重庆科技大学教学成果奖二等奖',
                    bio: '罗钧，出生于1986年5月，土木工程博士/博士后，高级工程师，硕士生导师，土木与水利工程学院教师。主持多项省部级项目，以第一作者或通讯作者发表论文17篇（SCI/EI检索14篇），获实用新型专利3项，参编地方标准2项。',
                    avatar: '',
                    fileName: ''
                }
            ];
        }

        function importProfileLibraryAdvisors(forceUpdate) {
            const advisors = getProfileLibraryAdvisors();
            let nextId = teamMemberData.length > 0 ? Math.max(...teamMemberData.map(d => d.id)) + 1 : 1;
            let changed = 0;
            advisors.forEach(function(adv) {
                const idx = teamMemberData.findIndex(m => m.name === adv.name);
                if (idx === -1) {
                    teamMemberData.push(Object.assign({ id: nextId++ }, adv));
                    changed++;
                } else if (forceUpdate) {
                    const id = teamMemberData[idx].id;
                    const avatar = teamMemberData[idx].avatar || '';
                    teamMemberData[idx] = Object.assign({}, teamMemberData[idx], adv, { id: id, avatar: avatar });
                    changed++;
                }
            });
            // 移除占位假导师
            const before = teamMemberData.length;
            teamMemberData = teamMemberData.filter(m => !(m.category === 'advisor' && (m.name === '张教授' || m.name === '李副教授')));
            if (teamMemberData.length !== before) changed++;
            if (changed > 0) {
                saveTeamMemberData();
                if (typeof renderTeamMembers === 'function') renderTeamMembers();
            }
            return changed;
        }

        function importAdvisorsFromProfileUI() {
            const n = importProfileLibraryAdvisors(true);
            closeImportMembersModal();
            switchMemberCategory('advisor', document.querySelector('.member-nav-item[data-category="advisor"]') || null);
            alert(n > 0 ? ('已导入/更新导师信息，并同步到云端（王丽萍、罗文文、罗钧）') : '导师信息已是最新');
        }

        async function initTeamMemberData() {
            // 先拉云端，避免本机默认数据覆盖别人的删除
            try { await syncFromCloudAndRefresh({ silent: true }); } catch (e) {}
            const saved = localStorage.getItem('teamMemberData');
            if (saved !== null) {
                teamMemberData = JSON.parse(saved);
            } else {
                resetToDefaultMembers();
            }
            // 从个人信息库导入三位导师，并同步到云端
            importProfileLibraryAdvisors(true);
            ensureMemberGradeYears();
            renderMemberNav();
            renderMemberAllSections();
            fillMemberCategorySelect();
            renderTeamMembers();
            switchMemberCategory('all', document.querySelector('.member-nav-item[data-category="all"]') || null);
        }
        
        function resetToDefaultMembers() {
            teamMemberData = [
                { id: 1, name: '王丽萍', category: 'advisor', title: '重庆科技大学教授、科技处处长', phone: '13996488662', email: 'wangliping98@163.com', bio: '王丽萍，1980年11月生，女，重庆科技大学教授，科技处处长，重庆安全生产科学研究院副院长，防灾减灾及防护工程专业博士，重庆市巾帼科技创新团队负责人。长期从事工程结构抗灾和城市区域防灾研究。', avatar: '', research: '城市安全、智能运维、结构抗震', projects: '国家自然科学基金青年/地区项目；重庆市科委社会类重点研发项目等', awards: '重庆市科技进步二等奖、三等奖；重庆市建设创新一等奖', education: '重庆大学防灾减灾及防护工程博士；新疆大学结构工程硕士、工民建学士' },
                { id: 2, name: '罗文文', category: 'advisor', title: '博士、副教授', phone: '18523539873', email: 'luowenwen326@163.com', bio: '罗文文，男，博士，副教授。1987年10月出生于四川省绵阳市。2009年、2015年分别获得重庆大学学士和博士学位，主要从事工程结构抗震与城市灾害风险研究。', avatar: '', research: '工程结构抗震与城市灾害风险研究', projects: '国家自然科学基金青年项目；兵团重点领域科技攻关项目；重庆市自然科学基金等', awards: '新疆建设兵团科学技术奖自然科学奖二等奖', education: '重庆大学土木工程博士（直攻博）、学士' },
                { id: 3, name: '罗钧', category: 'advisor', title: '土木工程博士/博士后，高级工程师，硕士生导师', phone: '13452426159', email: 'jluo@cqust.edu.cn', bio: '罗钧，出生于1986年5月，土木工程博士/博士后，高级工程师，硕士生导师。主要从事基于人工智能和图像信息的结构振动测试和损伤诊断研究。', avatar: '', research: '基于人工智能和图像信息的结构振动测试和损伤诊断，多信息融合的结构三维数字模型构建', projects: '重庆市自然科学基金创新发展联合基金重点项目等', awards: '省部级科技进步奖；重庆科技大学教学成果奖二等奖', education: '重庆大学土木工程博士（直博）、学士' },
                { id: 4, name: '王明', category: '2022', title: '2022级硕士研究生', phone: '138****2001', email: 'wangm@university.edu.cn', bio: '研究方向为自然语言处理，已发表SCI论文2篇，参与国家级科研项目1项。', avatar: '', research: '自然语言处理、知识图谱', projects: '国家自然科学基金面上项目（参与）', awards: '研究生国家奖学金', education: '本科毕业于重庆邮电大学计算机科学专业' },
                { id: 5, name: '赵芳', category: '2022', title: '2022级硕士研究生', phone: '138****2002', email: 'zhaof@university.edu.cn', bio: '研究方向为机器学习，已发表SCI论文1篇，获研究生学术创新奖。', avatar: '', research: '机器学习、数据挖掘', projects: '重庆市自然科学基金（参与）', awards: '研究生学术创新奖', education: '本科毕业于西南大学计算机专业' },
                { id: 6, name: '陈浩', category: '2023', title: '2023级硕士研究生', phone: '138****3001', email: 'chenh@university.edu.cn', bio: '研究方向为深度学习，已发表SCI论文1篇，积极参与学术竞赛。', avatar: '', research: '深度学习、图像分割', projects: '国家自然科学基金（参与）', awards: '优秀研究生', education: '本科毕业于重庆理工大学计算机专业' },
                { id: 7, name: '刘洋', category: '2023', title: '2023级硕士研究生', phone: '138****3002', email: 'liuy@university.edu.cn', bio: '研究方向为计算机视觉，已完成课程学习，正在开展研究工作。', avatar: '', research: '计算机视觉、视频分析', projects: '横向项目（参与）', awards: '', education: '本科毕业于重庆科技大学计算机专业' },
                { id: 8, name: '孙丽', category: '2024', title: '2024级硕士研究生', phone: '138****4001', email: 'sunl@university.edu.cn', bio: '研究方向为人工智能，刚入学，正在学习相关课程。', avatar: '', research: '人工智能、智能推荐', projects: '', awards: '', education: '本科毕业于重庆交通大学计算机专业' },
                { id: 9, name: '周杰', category: '2024', title: '2024级硕士研究生', phone: '138****4002', email: 'zhouj@university.edu.cn', bio: '研究方向为大数据，刚入学，正在适应研究生生活。', avatar: '', research: '大数据、云计算', projects: '', awards: '', education: '本科毕业于重庆工商大学计算机专业' },
                { id: 10, name: '吴婷', category: '2025', title: '2025级硕士研究生', phone: '138****5001', email: 'wut@university.edu.cn', bio: '研究方向为物联网，刚入学，正在学习基础课程。', avatar: '', research: '物联网、边缘计算', projects: '', awards: '', education: '本科毕业于重庆师范大学计算机专业' },
                { id: 11, name: '郑伟', category: '2025', title: '2025级硕士研究生', phone: '138****5002', email: 'zhengw@university.edu.cn', bio: '研究方向为网络安全，刚入学，正在适应新的学习环境。', avatar: '', research: '网络安全、信息安全', projects: '', awards: '', education: '本科毕业于重庆科技学院计算机专业' },
                { id: 12, name: '冯雪', category: '2026', title: '2026级硕士研究生', phone: '138****6001', email: 'fengx@university.edu.cn', bio: '研究方向为人工智能，刚入学，正在学习相关基础知识。', avatar: '', research: '人工智能、智能算法', projects: '', awards: '', education: '本科毕业于重庆文理学院计算机专业' },
                { id: 13, name: '何强', category: '2026', title: '2026级硕士研究生', phone: '138****6002', email: 'heq@university.edu.cn', bio: '研究方向为计算机图形学，刚入学，正在适应研究生阶段的学习。', avatar: '', research: '计算机图形学、虚拟现实', projects: '', awards: '', education: '本科毕业于长江师范学院计算机专业' }
            ];
            localStorage.setItem('teamMemberData', JSON.stringify(teamMemberData));
        }
        
        function saveTeamMemberData() {
            teamMemberData = normalizeTeamMembers(teamMemberData);
            ensureMemberGradeYearsFromMembers();
            syncTeamMembersAcrossSystem();
            localStorage.setItem('teamMemberData', JSON.stringify(teamMemberData));
            try { if (typeof cloudUpsert === 'function') cloudUpsert('teamMemberData', JSON.stringify(teamMemberData)); } catch (e) {}
            if (typeof populateOwnerSelects === 'function') populateOwnerSelects();
            if (typeof populateWeeklyReportOwnerFilter === 'function') populateWeeklyReportOwnerFilter();
            if (typeof renderAccountTable === 'function') renderAccountTable();
            try { if (typeof renderHomeDashboard === 'function') renderHomeDashboard(); } catch (eHome) {}
        }

        var DEFAULT_MEMBER_GRADE_YEARS = ['2022', '2023', '2024', '2025', '2026'];
        var MEMBER_GRADE_GRADIENTS = [
            'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
            'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
            'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
            'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
            'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
            'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
            'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)'
        ];

        function isMemberYearCategory(cat) {
            return /^20\d{2}$/.test(String(cat || '').trim());
        }

        function getMemberCategoryLabel(cat) {
            if (cat === 'advisor') return '导师';
            if (isMemberYearCategory(cat)) return cat + '级';
            return String(cat || '') || '未分类';
        }

        function getMemberGradeGradient(year) {
            const years = getMemberGradeYears();
            const idx = Math.max(0, years.indexOf(String(year)));
            return MEMBER_GRADE_GRADIENTS[idx % MEMBER_GRADE_GRADIENTS.length];
        }

        function getMemberGradeYears() {
            let years = [];
            try {
                const saved = JSON.parse(localStorage.getItem('memberGradeYears') || 'null');
                if (Array.isArray(saved)) years = saved.map(String);
            } catch (e) {}
            if (!years.length) years = DEFAULT_MEMBER_GRADE_YEARS.slice();
            years = years.filter(isMemberYearCategory);
            years = Array.from(new Set(years)).sort();
            return years.length ? years : DEFAULT_MEMBER_GRADE_YEARS.slice();
        }

        function saveMemberGradeYears(years) {
            const cleaned = Array.from(new Set((years || []).map(String).filter(isMemberYearCategory))).sort();
            const finalYears = cleaned.length ? cleaned : DEFAULT_MEMBER_GRADE_YEARS.slice();
            localStorage.setItem('memberGradeYears', JSON.stringify(finalYears));
            try { if (typeof cloudUpsert === 'function') cloudUpsert('memberGradeYears', JSON.stringify(finalYears)); } catch (e) {}
            return finalYears;
        }

        function ensureMemberGradeYearsFromMembers() {
            const years = getMemberGradeYears();
            const set = new Set(years);
            (Array.isArray(teamMemberData) ? teamMemberData : []).forEach(function(m) {
                if (isMemberYearCategory(m && m.category)) set.add(String(m.category));
            });
            return saveMemberGradeYears(Array.from(set));
        }

        function ensureMemberGradeYears() {
            return ensureMemberGradeYearsFromMembers();
        }

        function promptAddMemberGrade() {
            if (typeof canEditTeamMembers === 'function' && !canEditTeamMembers()) {
                alert('当前角色无「团队成员档案（编辑）」权限');
                return;
            }
            const input = prompt('请输入要增加的年级（四位年份，如 2027）：', String(new Date().getFullYear()));
            if (input == null) return;
            const year = String(input).trim().replace(/级/g, '');
            if (!isMemberYearCategory(year)) {
                alert('年级格式不正确，请输入四位年份，例如 2027');
                return;
            }
            const years = getMemberGradeYears();
            if (years.indexOf(year) >= 0) {
                alert(year + '级已存在');
                switchMemberCategory(year, document.querySelector('.member-nav-item[data-category="' + year + '"]') || null);
                return;
            }
            years.push(year);
            saveMemberGradeYears(years);
            renderMemberNav();
            renderMemberAllSections();
            fillMemberCategorySelect();
            renderTeamMembers();
            switchMemberCategory(year, document.querySelector('.member-nav-item[data-category="' + year + '"]') || null);
            alert('已增加 ' + year + '级');
        }

        function removeMemberGrade(year) {
            if (typeof canEditTeamMembers === 'function' && !canEditTeamMembers()) {
                alert('当前角色无「团队成员档案（编辑）」权限');
                return;
            }
            year = String(year || '').trim();
            if (!isMemberYearCategory(year)) return;
            const count = (teamMemberData || []).filter(function(m) { return m.category === year; }).length;
            if (count > 0) {
                alert(year + '级仍有 ' + count + ' 名成员，请先调整他们的年级后再删除');
                return;
            }
            if (!confirm('确定删除「' + year + '级」？')) return;
            saveMemberGradeYears(getMemberGradeYears().filter(function(y) { return y !== year; }));
            renderMemberNav();
            renderMemberAllSections();
            fillMemberCategorySelect();
            renderTeamMembers();
            switchMemberCategory('all', document.querySelector('.member-nav-item[data-category="all"]') || null);
        }

        function renderMemberNav(activeCategory) {
            const nav = document.getElementById('memberNavList');
            if (!nav) return;
            const active = activeCategory || (document.querySelector('.member-nav-item.active') || {}).getAttribute?.('data-category') || 'all';
            const years = getMemberGradeYears();
            let html = '';
            html += '<div class="member-nav-item' + (active === 'all' ? ' active' : '') + '" data-category="all" onclick="switchMemberCategory(\'all\', this)" style="padding:12px 16px;cursor:pointer;border-left:3px solid ' + (active === 'all' ? '#667eea' : 'transparent') + ';background:' + (active === 'all' ? '#f0f4ff' : '') + ';color:' + (active === 'all' ? '#667eea' : '') + ';transition:all 0.2s;">全部成员</div>';
            html += '<div class="member-nav-item' + (active === 'advisor' ? ' active' : '') + '" data-category="advisor" onclick="switchMemberCategory(\'advisor\', this)" style="padding:12px 16px;cursor:pointer;border-left:3px solid ' + (active === 'advisor' ? '#667eea' : 'transparent') + ';background:' + (active === 'advisor' ? '#f0f4ff' : '') + ';color:' + (active === 'advisor' ? '#667eea' : '') + ';transition:all 0.2s;">导师</div>';
            years.forEach(function(y) {
                const isActive = active === y;
                html += '<div class="member-nav-item' + (isActive ? ' active' : '') + '" data-category="' + y + '" onclick="switchMemberCategory(\'' + y + '\', this)" style="padding:12px 16px;cursor:pointer;border-left:3px solid ' + (isActive ? '#667eea' : 'transparent') + ';background:' + (isActive ? '#f0f4ff' : '') + ';color:' + (isActive ? '#667eea' : '') + ';transition:all 0.2s;display:flex;justify-content:space-between;align-items:center;">'
                    + '<span>' + y + '级</span>';
                if (typeof canEditTeamMembers !== 'function' || canEditTeamMembers()) {
                    html += '<span title="删除年级" onclick="event.stopPropagation();removeMemberGrade(\'' + y + '\')" style="color:#bbb;font-size:14px;padding:0 4px;line-height:1;">×</span>';
                }
                html += '</div>';
            });
            nav.innerHTML = html;
        }

        function renderMemberAllSections() {
            const host = document.getElementById('memberCategoryAll');
            if (!host) return;
            const years = getMemberGradeYears();
            let html = '';
            html += '<div class="member-category-section" data-category="advisor" style="margin-bottom:24px;">'
                + '<div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:12px 20px;border-radius:8px 8px 0 0;font-size:16px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">'
                + '<span>导师</span>'
                + '<button type="button" onclick="showAddMemberModal(\'advisor\')" style="background:rgba(255,255,255,0.22);border:1px solid rgba(255,255,255,0.45);color:#fff;padding:4px 12px;border-radius:6px;font-size:13px;cursor:pointer;">＋ 增加人员</button>'
                + '</div>'
                + '<div style="background:#f8f9fa;padding:16px;border-radius:0 0 8px 8px;display:flex;flex-wrap:wrap;gap:12px;" id="memberGridAdvisor"></div></div>';
            years.forEach(function(y) {
                html += '<div class="member-category-section" data-category="' + y + '" style="margin-bottom:24px;">'
                    + '<div style="background:' + getMemberGradeGradient(y) + ';color:#fff;padding:12px 20px;border-radius:8px 8px 0 0;font-size:16px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">'
                    + '<span>' + y + '级</span>'
                    + '<button type="button" onclick="showAddMemberModal(\'' + y + '\')" style="background:rgba(255,255,255,0.22);border:1px solid rgba(255,255,255,0.45);color:#fff;padding:4px 12px;border-radius:6px;font-size:13px;cursor:pointer;">＋ 增加人员</button>'
                    + '</div>'
                    + '<div style="background:#f8f9fa;padding:16px;border-radius:0 0 8px 8px;display:flex;flex-wrap:wrap;gap:12px;" id="memberGrid' + y + '"></div></div>';
            });
            host.innerHTML = html;
        }

        function fillMemberCategorySelect(selected) {
            const sel = document.getElementById('memberCategory');
            if (!sel) return;
            const years = getMemberGradeYears();
            const cur = selected != null ? selected : sel.value;
            let html = '<option value="">请选择分类</option><option value="advisor">导师</option>';
            years.forEach(function(y) {
                html += '<option value="' + y + '">' + y + '级</option>';
            });
            sel.innerHTML = html;
            if (cur) sel.value = cur;
            onMemberCategoryChange();
        }

        function onMemberCategoryChange() {
            const cat = (document.getElementById('memberCategory') || {}).value || '';
            const wrap = document.getElementById('memberGraduatedWrap');
            if (wrap) wrap.style.display = cat === 'advisor' ? 'none' : '';
            if (cat === 'advisor') {
                const cb = document.getElementById('memberGraduated');
                if (cb) cb.checked = false;
            }
        }

        function isMemberGraduated(member) {
            if (!member || member.category === 'advisor') return false;
            return !!member.graduated;
        }

        function isAccountGraduated(account) {
            if (!account) return false;
            if (account.graduated === true || account.graduated === 'true' || account.graduated === 1) return true;
            const name = String(account.realName || account.username || '').trim();
            if (!name || !Array.isArray(teamMemberData)) return false;
            const m = teamMemberData.find(function(x) {
                return x && (x.name === name || (account.email && x.email === account.email));
            });
            return isMemberGraduated(m);
        }

        function getNotifiableTeamOwnerNames() {
            const members = Array.isArray(teamMemberData) ? teamMemberData : [];
            return members.filter(function(m) {
                return m && m.name && !isMemberGraduated(m);
            }).map(function(m) { return m.name; });
        }

        function normalizeMemberCategory(value, title) {
            const raw = String(value || '').trim();
            if (raw === 'advisor' || raw === '导师') return 'advisor';
            const source = raw + ' ' + String(title || '');
            const yearMatch = source.match(/(20\d{2})/);
            if (yearMatch && isMemberYearCategory(yearMatch[1])) return yearMatch[1];
            if (/教授|导师|博士后|高级工程师/.test(source) && !/研究生|硕士|博士生/.test(source)) return 'advisor';
            if (isMemberYearCategory(raw.replace(/级/g, ''))) return raw.replace(/级/g, '');
            return raw.replace(/级/g, '') || '2024';
        }

        function normalizeTeamMemberName(name) {
            return String(name || '')
                .trim()
                .replace(/\s+/g, '')
                .replace(/(个人简历|个人信息|个人资料|简历|档案|资料)$/g, '')
                .replace(/个人$/g, '');
        }

        function normalizeTeamMembers(list) {
            const seen = new Set();
            let nextId = Array.isArray(list) && list.length > 0 ? Math.max(...list.map(m => Number(m.id) || 0)) + 1 : 1;
            return (Array.isArray(list) ? list : []).map(function(m) {
                const copy = Object.assign({}, m);
                copy.name = normalizeTeamMemberName(copy.name);
                copy.category = normalizeMemberCategory(copy.category, copy.title);
                copy.title = String(copy.title || '').trim() || (copy.category === 'advisor' ? '导师' : copy.category + '级硕士研究生');
                copy.graduated = copy.category === 'advisor' ? false : !!copy.graduated;
                if (!copy.id) copy.id = nextId++;
                return copy;
            }).filter(function(m) {
                if (!m.name) return false;
                const key = (m.name + '|' + (m.email || '') + '|' + (m.phone || '')).toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        function getMemberRole(member) {
            return member.category === 'advisor' ? 'admin' : 'student';
        }

        function getMemberStudentId(member) {
            const emailPrefix = member.email && String(member.email).split('@')[0];
            if (emailPrefix && /^[a-zA-Z0-9_.-]{3,}$/.test(emailPrefix)) return emailPrefix;
            const phoneDigits = String(member.phone || '').replace(/\D/g, '');
            if (phoneDigits.length >= 6) return phoneDigits;
            return 'member' + member.id;
        }

        function getPreferredStudentId(member) {
            const preferredMap = {
                '王丽萍': 'admin',
                '王明': 'leader01',
                '陈浩': 'stu001',
                '赵芳': 'stu002',
                '罗文文': 'luowenwen326',
                '罗钧': 'jluo'
            };
            if (member && preferredMap[member.name]) return preferredMap[member.name];
            try {
                if (typeof accountData !== 'undefined' && Array.isArray(accountData)) {
                    const existing = accountData.find(function(a) {
                        return a && a.role !== 'visitor' && a.realName === member.name;
                    });
                    if (existing && existing.studentId) return existing.studentId;
                }
            } catch (e) {}
            return getMemberStudentId(member);
        }

        function accountMatchesTeamMember(a, m, preferredStudentId) {
            if (!a || !m || a.role === 'visitor') return false;
            if (a.teamMemberId != null && Number(a.teamMemberId) === Number(m.id)) return true;
            if (a.realName && m.name && a.realName === m.name) return true;
            if (m.email && a.email && String(a.email).toLowerCase() === String(m.email).toLowerCase()) return true;
            if (preferredStudentId && a.studentId === preferredStudentId) return true;
            const autoId = getMemberStudentId(m);
            if (autoId && a.studentId === autoId) return true;
            return false;
        }

        function scoreLinkedAccount(a, preferredStudentId) {
            let s = 0;
            try {
                if (typeof currentUser !== 'undefined' && currentUser && Number(currentUser.id) === Number(a.id)) s += 10000;
            } catch (e0) {}
            if (preferredStudentId && a.studentId === preferredStudentId) s += 500;
            if (a.studentId === 'admin') s += 200;
            if (a.lastLogin) s += 80;
            if (a.role === 'leader') s += 40;
            if (a.role === 'admin') s += 20;
            if (a.status === 'active') s += 10;
            s -= (Number(a.id) || 0) * 0.001;
            return s;
        }

        function syncTeamMembersAcrossSystem() {
            const members = normalizeTeamMembers(teamMemberData);
            teamMemberData = members;

            // 同步旧版“团队成员/个人信息库”模块，避免两套成员数据不一致。
            const legacyMembers = members.map(function(m) {
                return {
                    id: m.id,
                    name: m.name,
                    position: m.title || '',
                    field: m.research || '',
                    email: m.email || '',
                    phone: m.phone || '',
                    avatar: m.avatar || ''
                };
            });
            localStorage.setItem('memberData', JSON.stringify(legacyMembers));
            try { if (typeof cloudUpsert === 'function') cloudUpsert('memberData', JSON.stringify(legacyMembers)); } catch (e) {}

            if (typeof accountData === 'undefined' || !Array.isArray(accountData)) {
                reconcileCollaborativeDataWithTeamMembers();
                return;
            }

            let changed = false;
            let nextId = accountData.length > 0 ? Math.max(...accountData.map(a => Number(a.id) || 0)) + 1 : 1;
            const linkedAccountIds = new Set();
            const removeAccountIds = new Set();

            members.forEach(function(m) {
                const preferredStudentId = getPreferredStudentId(m);
                const candidates = accountData.filter(function(a) {
                    if (removeAccountIds.has(a.id)) return false;
                    return accountMatchesTeamMember(a, m, preferredStudentId);
                });

                let role = 'student';
                if (m.category === 'advisor') role = 'admin';
                else if (candidates.some(function(c) { return c.role === 'leader'; })) role = 'leader';
                else role = getMemberRole(m);

                const patch = {
                    realName: m.name,
                    role: role,
                    grade: m.category === 'advisor' ? '' : (m.category + '级'),
                    research: m.research || '',
                    phone: m.phone || '',
                    email: m.email || '',
                    avatar: m.avatar || '',
                    graduated: !!m.graduated,
                    fromTeam: true,
                    teamMemberId: m.id,
                    teamOrphan: false
                };

                let primary = null;
                if (candidates.length) {
                    candidates.sort(function(a, b) {
                        return scoreLinkedAccount(b, preferredStudentId) - scoreLinkedAccount(a, preferredStudentId);
                    });
                    primary = candidates[0];
                    // 合并重复账号：保留主账号，删除同名/同邮箱的多余正式账号
                    candidates.slice(1).forEach(function(dup) {
                        if (dup.lastLogin && !primary.lastLogin) primary.lastLogin = dup.lastLogin;
                        if (dup.lastLoginIp && !primary.lastLoginIp) primary.lastLoginIp = dup.lastLoginIp;
                        if (dup.password && primary.mustChangePwd && !dup.mustChangePwd) {
                            primary.password = dup.password;
                            primary.mustChangePwd = dup.mustChangePwd;
                        }
                        if (dup.group && !primary.group) primary.group = dup.group;
                        removeAccountIds.add(dup.id);
                        changed = true;
                    });
                    // 若主账号不是首选登录名，且首选名未被占用，则改用首选学号（如王丽萍→admin）
                    if (preferredStudentId && primary.studentId !== preferredStudentId) {
                        const preferredTaken = accountData.some(function(a) {
                            return a && a.id !== primary.id && !removeAccountIds.has(a.id) && a.studentId === preferredStudentId;
                        });
                        if (!preferredTaken) {
                            primary.studentId = preferredStudentId;
                            changed = true;
                        }
                    }
                    Object.keys(patch).forEach(function(k) {
                        if (k === 'graduated' || k === 'fromTeam' || k === 'teamOrphan' || typeof patch[k] === 'boolean' || typeof patch[k] === 'number') {
                            if (patch[k] !== primary[k]) {
                                primary[k] = patch[k];
                                changed = true;
                            }
                        } else if ((patch[k] || '') !== (primary[k] || '')) {
                            primary[k] = patch[k];
                            changed = true;
                        }
                    });
                } else {
                    primary = Object.assign({
                        id: nextId++,
                        studentId: preferredStudentId,
                        group: '',
                        status: 'active',
                        password: (typeof DEFAULT_PASSWORD !== 'undefined' ? DEFAULT_PASSWORD : '123456'),
                        mustChangePwd: true,
                        firstLogin: true,
                        lastLogin: '',
                        lastLoginIp: '',
                        createdAt: new Date().toISOString().split('T')[0],
                        loginFailCount: 0,
                        lockedUntil: null
                    }, patch);
                    accountData.push(primary);
                    changed = true;
                }
                if (primary) linkedAccountIds.add(primary.id);
            });

            // 全局清理：非访客且未关联当前团队成员的账号一律移除（访客例外）
            let currentId = null;
            try { if (typeof currentUser !== 'undefined' && currentUser) currentId = currentUser.id; } catch (e1) {}
            accountData.forEach(function(a) {
                if (!a || a.role === 'visitor') return;
                if (linkedAccountIds.has(a.id)) return;
                // 当前登录用户若成了孤儿，先保留以免被踢出，但仍标记
                if (currentId != null && Number(a.id) === Number(currentId)) {
                    if (!a.teamOrphan) { a.teamOrphan = true; changed = true; }
                    return;
                }
                removeAccountIds.add(a.id);
            });

            if (removeAccountIds.size) {
                const before = accountData.length;
                accountData = accountData.filter(function(a) { return a && !removeAccountIds.has(a.id); });
                if (accountData.length !== before) changed = true;
            }

            if (changed) {
                localStorage.setItem('accountData', JSON.stringify(accountData));
                try { if (typeof cloudUpsert === 'function') cloudUpsert('accountData', JSON.stringify(accountData)); } catch (e) {}
            }

            reconcileCollaborativeDataWithTeamMembers();
        }

        /** 强制按团队档案清理账号库（访客保留），供账号页一键联动 */
        function purgeAccountsNotInTeam(options) {
            options = options || {};
            syncTeamMembersAcrossSystem();
            const members = Array.isArray(teamMemberData) ? teamMemberData : [];
            const keepIds = new Set();
            members.forEach(function(m) {
                const preferred = getPreferredStudentId(m);
                accountData.forEach(function(a) {
                    if (accountMatchesTeamMember(a, m, preferred)) keepIds.add(a.id);
                });
            });
            const before = accountData.slice();
            const removed = [];
            accountData = accountData.filter(function(a) {
                if (!a) return false;
                if (a.role === 'visitor') return true;
                if (keepIds.has(a.id)) return true;
                removed.push(a);
                return false;
            });
            if (removed.length) {
                localStorage.setItem('accountData', JSON.stringify(accountData));
                try { if (typeof cloudUpsert === 'function') cloudUpsert('accountData', JSON.stringify(accountData)); } catch (e) {}
            }
            if (typeof renderAccountTable === 'function') renderAccountTable();
            if (!options.silent) {
                alert(removed.length
                    ? ('已清理 ' + removed.length + ' 个非团队正式账号：\n' + removed.map(function(a) { return a.studentId + '（' + a.realName + '）'; }).join('\n'))
                    : '账号已与团队成员档案完全对齐，无需清理');
            }
            return removed.length;
        }

        function replaceUnknownOwnerWithTeamMember(ownerName) {
            const names = getRealTeamOwnerNames();
            if (!names.length) return ownerName || '';
            const clean = normalizeTeamMemberName(ownerName);
            if (!clean) return ownerName || '';
            // 系统角色 / 公告发布方不允许被强行改写成团队成员姓名
            var reserved = {
                '系统': 1, '系统管理员': 1, '团队管理员': 1, '未知用户': 1,
                '管理员': 1, 'system': 1, 'System': 1, 'admin': 1
            };
            if (reserved[clean] || reserved[String(ownerName || '').trim()]) return clean || String(ownerName || '').trim();
            const renameMap = window.__teamMemberRenameMap || {};
            if (renameMap[clean] && names.includes(renameMap[clean])) return renameMap[clean];
            if (names.includes(clean)) return clean;
            const samePrefix = names.find(function(n) { return clean && (n.indexOf(clean) === 0 || clean.indexOf(n) === 0); });
            return samePrefix || names[0];
        }

        function reconcilePeopleFieldList(list, fields, key) {
            if (!Array.isArray(list)) return false;
            let changed = false;
            list.forEach(function(item) {
                // 系统自动告警：发布人必须保持「系统」
                if (key === 'noticeData' && item && (
                    String(item.title || '').indexOf('【系统告警】') === 0 ||
                    String(item.title || '').indexOf('【系统通知】') === 0
                )) {
                    if (item.publisher !== '系统') {
                        item.publisher = '系统';
                        changed = true;
                    }
                    return;
                }
                fields.forEach(function(field) {
                    if (!item || !item[field]) return;
                    const next = replaceUnknownOwnerWithTeamMember(item[field]);
                    if (next && next !== item[field]) {
                        item[field] = next;
                        changed = true;
                    }
                });
            });
            if (changed && key) {
                localStorage.setItem(key, JSON.stringify(list));
                try { if (typeof cloudUpsert === 'function') cloudUpsert(key, JSON.stringify(list)); } catch (e) {}
            }
            return changed;
        }

        function reconcileParticipantsText(text) {
            const names = getRealTeamOwnerNames();
            if (!names.length || !text) return text || '';
            if (/全体|全部|所有/.test(text)) return '全体成员';
            return String(text).split(/[、,，;；\s]+/)
                .map(function(part) { return part.trim(); })
                .filter(Boolean)
                .map(function(part) { return replaceUnknownOwnerWithTeamMember(part); })
                .filter(function(name, idx, arr) { return name && arr.indexOf(name) === idx; })
                .join('、');
        }

        function reconcileCollaborativeDataWithTeamMembers() {
            const validNames = new Set(getRealTeamOwnerNames());
            if (validNames.size === 0) return;
            let taskChanged = false;
            if (typeof taskData !== 'undefined' && Array.isArray(taskData)) {
                taskData.forEach(function(t) {
                    const nextOwner = replaceUnknownOwnerWithTeamMember(t.owner);
                    if (nextOwner && t.owner !== nextOwner) {
                        t.owner = nextOwner;
                        taskChanged = true;
                    }
                    if (t.visibility !== 'all') {
                        t.visibility = 'all';
                        taskChanged = true;
                    }
                });
                if (taskChanged) {
                    localStorage.setItem('taskData', JSON.stringify(taskData));
                    try { if (typeof cloudUpsert === 'function') cloudUpsert('taskData', JSON.stringify(taskData)); } catch (e) {}
                }
            }

            let reportChanged = false;
            if (typeof weeklyReportData !== 'undefined' && Array.isArray(weeklyReportData)) {
                weeklyReportData.forEach(function(r) {
                    const nextOwner = replaceUnknownOwnerWithTeamMember(r.owner);
                    if (nextOwner && r.owner !== nextOwner) {
                        r.owner = nextOwner;
                        reportChanged = true;
                    }
                });
                if (reportChanged) {
                    localStorage.setItem('weeklyReportData', JSON.stringify(weeklyReportData));
                    try { if (typeof cloudUpsert === 'function') cloudUpsert('weeklyReportData', JSON.stringify(weeklyReportData)); } catch (e) {}
                }
            }

            reconcilePeopleFieldList(typeof longitudinalData !== 'undefined' ? longitudinalData : null, ['leader'], 'longitudinalData');
            reconcilePeopleFieldList(typeof horizontalData !== 'undefined' ? horizontalData : null, ['leader'], 'horizontalData');
            reconcilePeopleFieldList(typeof schoolData !== 'undefined' ? schoolData : null, ['leader'], 'schoolData');
            reconcilePeopleFieldList(typeof noticeData !== 'undefined' ? noticeData : null, ['publisher'], 'noticeData');
            reconcilePeopleFieldList(typeof newsData !== 'undefined' ? newsData : null, ['author'], 'newsData');
            reconcilePeopleFieldList(typeof literatureData !== 'undefined' ? literatureData : null, ['uploader'], 'literatureData');
            reconcilePeopleFieldList(typeof datasetData !== 'undefined' ? datasetData : null, ['uploader'], 'datasetData');
            reconcilePeopleFieldList(typeof reportData !== 'undefined' ? reportData : null, ['uploader'], 'reportData');
            reconcilePeopleFieldList(typeof sharedFileData !== 'undefined' ? sharedFileData : null, ['uploader'], 'sharedFileData');
            reconcilePeopleFieldList(typeof modelTrainingData !== 'undefined' ? modelTrainingData : null, ['owner'], 'modelTrainingData');
            reconcilePeopleFieldList(typeof annotationData !== 'undefined' ? annotationData : null, ['owner'], 'annotationData');

            if (typeof meetingData !== 'undefined' && Array.isArray(meetingData)) {
                let meetingChanged = false;
                meetingData.forEach(function(m) {
                    const nextParticipants = reconcileParticipantsText(m.participants || '');
                    if (nextParticipants !== (m.participants || '')) {
                        m.participants = nextParticipants;
                        meetingChanged = true;
                    }
                });
                if (meetingChanged) {
                    localStorage.setItem('meetingData', JSON.stringify(meetingData));
                    try { if (typeof cloudUpsert === 'function') cloudUpsert('meetingData', JSON.stringify(meetingData)); } catch (e) {}
                }
            }

            // 清理已删除成员的筛选值，避免下拉刷新后仍卡在旧名字上。
            ['taskOwnerFilter', 'taskOwner', 'weeklyReportOwnerFilter'].forEach(function(id) {
                const el = document.getElementById(id);
                if (el && el.value && !validNames.has(el.value)) el.value = '';
            });
        }
        
        function createMemberCard(m) {
            const card = document.createElement('div');
            card.style.cssText = 'background: #fff; border-radius: 8px; padding: 16px; width: 140px; text-align: center; cursor: pointer; transition: all 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.1); position: relative;';
            card.onmouseenter = function() { this.style.transform = 'translateY(-3px)'; this.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)'; };
            card.onmouseleave = function() { this.style.transform = ''; this.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)'; };
            if (typeof canEditTeamMembers === 'function' && canEditTeamMembers()) {
                const actionsDiv = document.createElement('div');
                actionsDiv.style.cssText = 'position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; z-index: 10;';
                const editBtn = document.createElement('span');
                editBtn.style.cssText = 'width: 22px; height: 22px; border-radius: 50%; background: #17a2b8; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer;';
                editBtn.innerHTML = '✎';
                editBtn.title = '编辑';
                editBtn.onclick = function(e) { e.stopPropagation(); editMember(m.id); };
                const delBtn = document.createElement('span');
                delBtn.style.cssText = 'width: 22px; height: 22px; border-radius: 50%; background: #dc3545; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer;';
                delBtn.innerHTML = '×';
                delBtn.title = '删除';
                delBtn.onclick = function(e) { e.stopPropagation(); deleteMember(m.id); };
                actionsDiv.appendChild(editBtn);
                actionsDiv.appendChild(delBtn);
                card.appendChild(actionsDiv);
            }
            card.onclick = function() { showMemberDetail(m.id); };
            let avatar;
            if (m.avatar) {
                avatar = document.createElement('img');
                avatar.src = m.avatar;
                avatar.style.cssText = 'width: 60px; height: 60px; border-radius: 50%; object-fit: cover; margin: 0 auto 10px;';
            } else {
                avatar = document.createElement('div');
                avatar.style.cssText = 'width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 22px; font-weight: bold;';
                avatar.textContent = m.name.charAt(0);
            }
            const nameEl = document.createElement('div');
            nameEl.style.cssText = 'font-size: 14px; font-weight: bold; color: #333; margin-bottom: 4px;';
            nameEl.textContent = m.name;
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-size: 12px; color: #888;';
            titleEl.textContent = m.title;
            card.appendChild(avatar);
            card.appendChild(nameEl);
            card.appendChild(titleEl);
            if (isMemberGraduated(m)) {
                const badge = document.createElement('div');
                badge.style.cssText = 'margin-top:8px;display:inline-block;padding:2px 8px;border-radius:10px;background:#f5f5f5;color:#888;font-size:11px;border:1px solid #e8e8e8;';
                badge.textContent = '已毕业';
                card.appendChild(badge);
            } else if (m.category !== 'advisor') {
                const badge = document.createElement('div');
                badge.style.cssText = 'margin-top:8px;display:inline-block;padding:2px 8px;border-radius:10px;background:#e6f7ff;color:#1890ff;font-size:11px;border:1px solid #91d5ff;';
                badge.textContent = '在读';
                card.appendChild(badge);
            }
            return card;
        }

        function createAddMemberCard(category) {
            const card = document.createElement('div');
            card.style.cssText = 'background: #fff; border-radius: 8px; padding: 16px; width: 140px; text-align: center; cursor: pointer; transition: all 0.2s; border: 2px dashed #c5cbe0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 140px; color: #667eea;';
            card.onmouseenter = function() { this.style.borderColor = '#667eea'; this.style.background = '#f5f7ff'; };
            card.onmouseleave = function() { this.style.borderColor = '#c5cbe0'; this.style.background = '#fff'; };
            card.onclick = function() { showAddMemberModal(category); };
            card.innerHTML = '<div style="font-size: 32px; line-height: 1; margin-bottom: 8px;">＋</div><div style="font-size: 13px; font-weight: 600;">增加人员</div>';
            return card;
        }
        
        function getMemberGridCategories() {
            return ['advisor'].concat(getMemberGradeYears());
        }

        function memberGridId(cat) {
            return cat === 'advisor' ? 'memberGridAdvisor' : ('memberGrid' + cat);
        }
        
        function renderTeamMembers() {
            ensureMemberGradeYears();
            renderMemberNav((document.querySelector('.member-nav-item.active') || {}).getAttribute?.('data-category') || 'all');
            const allVisible = document.getElementById('memberCategoryAll');
            if (allVisible && allVisible.style.display !== 'none') {
                renderMemberAllSections();
            }
            getMemberGridCategories().forEach(function(cat) {
                const grid = document.getElementById(memberGridId(cat));
                if (!grid) return;
                const members = teamMemberData.filter(m => m.category === cat);
                grid.innerHTML = '';
                members.forEach(m => { grid.appendChild(createMemberCard(m)); });
                if (typeof canEditTeamMembers !== 'function' || canEditTeamMembers()) {
                    grid.appendChild(createAddMemberCard(cat));
                }
            });
        }
        
        function showAddMemberModal(preselectCategory) {
            if (typeof canEditTeamMembers === 'function' && !canEditTeamMembers()) {
                alert('当前角色无「团队成员档案（编辑）」权限');
                return;
            }
            editingMemberId = null;
            document.getElementById('memberEditModalTitle').textContent = '新增成员';
            document.getElementById('memberName').value = '';
            fillMemberCategorySelect(preselectCategory || '');
            document.getElementById('memberCategory').value = preselectCategory || '';
            onMemberCategoryChange();
            const titleEl = document.getElementById('memberTitle');
            if (preselectCategory === 'advisor') titleEl.value = '导师';
            else if (isMemberYearCategory(preselectCategory)) titleEl.value = preselectCategory + '级硕士研究生';
            else titleEl.value = '';
            const graduatedCb = document.getElementById('memberGraduated');
            if (graduatedCb) graduatedCb.checked = false;
            document.getElementById('memberResearch').value = '';
            document.getElementById('memberEducation').value = '';
            document.getElementById('memberPhone').value = '';
            document.getElementById('memberEmail').value = '';
            document.getElementById('memberProjects').value = '';
            document.getElementById('memberAwards').value = '';
            document.getElementById('memberBio').value = '';
            document.getElementById('memberEditModal').style.display = 'flex';
        }
        
        function closeMemberEditModal() {
            document.getElementById('memberEditModal').style.display = 'none';
            ['memberName', 'memberCategory'].forEach(function (fid) {
                var el = document.getElementById(fid);
                if (el) el.disabled = false;
            });
            var graduatedCb = document.getElementById('memberGraduated');
            if (graduatedCb) graduatedCb.disabled = false;
        }
        
        function editMember(id) {
            var fullEdit = typeof canEditTeamMembers === 'function' && canEditTeamMembers();
            var selfEdit = typeof canEditOwnMemberProfile === 'function' && canEditOwnMemberProfile(id);
            if (!fullEdit && !selfEdit) {
                alert('当前角色无编辑权限。研究生请使用本人账号完善自己的档案。');
                return;
            }
            const m = teamMemberData.find(d => d.id === id);
            if (!m) return;
            editingMemberId = id;
            document.getElementById('memberEditModalTitle').textContent = selfEdit && !fullEdit ? '完善我的档案' : '编辑成员';
            document.getElementById('memberName').value = m.name;
            fillMemberCategorySelect(m.category);
            document.getElementById('memberCategory').value = m.category;
            onMemberCategoryChange();
            document.getElementById('memberTitle').value = m.title;
            const graduatedCb = document.getElementById('memberGraduated');
            if (graduatedCb) graduatedCb.checked = !!m.graduated;
            document.getElementById('memberResearch').value = m.research || '';
            document.getElementById('memberEducation').value = m.education || '';
            document.getElementById('memberPhone').value = m.phone || '';
            document.getElementById('memberEmail').value = m.email || '';
            document.getElementById('memberProjects').value = m.projects || '';
            document.getElementById('memberAwards').value = m.awards || '';
            document.getElementById('memberBio').value = m.bio || '';
            // 研究生完善本人信息时锁定姓名/分类/毕业状态，避免误改组织字段
            var lockOrg = selfEdit && !fullEdit;
            ['memberName', 'memberCategory'].forEach(function (fid) {
                var el = document.getElementById(fid);
                if (el) el.disabled = lockOrg;
            });
            if (graduatedCb) graduatedCb.disabled = lockOrg;
            document.getElementById('memberEditModal').style.display = 'flex';
        }
        
        function saveMember() {
            var fullEdit = typeof canEditTeamMembers === 'function' && canEditTeamMembers();
            var selfEdit = editingMemberId && typeof canEditOwnMemberProfile === 'function' && canEditOwnMemberProfile(editingMemberId);
            if (!fullEdit && !selfEdit) {
                alert('当前角色无编辑权限');
                return;
            }
            const nameEl = document.getElementById('memberName');
            const categoryEl = document.getElementById('memberCategory');
            // 临时解除 disabled 以便读取（部分浏览器对 disabled 不提交）
            var wasNameDisabled = nameEl.disabled;
            var wasCatDisabled = categoryEl.disabled;
            nameEl.disabled = false;
            categoryEl.disabled = false;
            const name = nameEl.value.trim();
            const category = categoryEl.value;
            const title = document.getElementById('memberTitle').value.trim();
            if (!name || !category || !title) { alert('请填写姓名、分类和职称/身份'); nameEl.disabled = wasNameDisabled; categoryEl.disabled = wasCatDisabled; return; }
            const graduatedEl = document.getElementById('memberGraduated');
            const data = {
                name, category, title,
                graduated: category === 'advisor' ? false : !!(graduatedEl && graduatedEl.checked),
                research: document.getElementById('memberResearch').value.trim(),
                education: document.getElementById('memberEducation').value.trim(),
                phone: document.getElementById('memberPhone').value.trim(),
                email: document.getElementById('memberEmail').value.trim(),
                projects: document.getElementById('memberProjects').value.trim(),
                awards: document.getElementById('memberAwards').value.trim(),
                bio: document.getElementById('memberBio').value.trim()
            };
            nameEl.disabled = wasNameDisabled;
            categoryEl.disabled = wasCatDisabled;
            if (editingMemberId) {
                const idx = teamMemberData.findIndex(d => d.id === editingMemberId);
                if (idx !== -1) {
                    if (!fullEdit && selfEdit) {
                        // 本人完善：保留姓名、分类、毕业标记
                        data.name = teamMemberData[idx].name;
                        data.category = teamMemberData[idx].category;
                        data.graduated = !!teamMemberData[idx].graduated;
                    }
                    const oldName = normalizeTeamMemberName(teamMemberData[idx].name);
                    const newName = normalizeTeamMemberName(data.name);
                    if (oldName && newName && oldName !== newName) {
                        window.__teamMemberRenameMap = window.__teamMemberRenameMap || {};
                        window.__teamMemberRenameMap[oldName] = newName;
                    }
                    teamMemberData[idx] = { ...teamMemberData[idx], ...data, name: newName || data.name };
                }
            } else {
                if (!fullEdit) {
                    alert('仅导师可新增成员档案');
                    return;
                }
                const newId = teamMemberData.length > 0 ? Math.max(...teamMemberData.map(d => d.id)) + 1 : 1;
                teamMemberData.push({ id: newId, ...data, avatar: '', fileName: '' });
            }
            if (isMemberYearCategory(category)) {
                const years = getMemberGradeYears();
                if (years.indexOf(category) < 0) {
                    years.push(category);
                    saveMemberGradeYears(years);
                }
            }
            saveTeamMemberData();
            renderMemberNav(category === 'advisor' ? 'advisor' : (isMemberYearCategory(category) ? category : 'all'));
            renderMemberAllSections();
            renderTeamMembers();
            const single = document.getElementById('memberCategorySingle');
            if (single && single.style.display !== 'none') {
                const activeNav = document.querySelector('.member-nav-item.active');
                if (activeNav) activeNav.click();
            }
            closeMemberEditModal();
            try {
                if (typeof invalidatePortalCache === 'function') invalidatePortalCache();
                if (typeof renderMembersPortal === 'function' && document.getElementById('members') && document.getElementById('members').classList.contains('active')) {
                    renderMembersPortal();
                }
            } catch (ePortal) {}
            alert('保存成功！');
        }
        
        function deleteMember(id) {
            if (typeof canEditTeamMembers === 'function' && !canEditTeamMembers()) {
                alert('当前角色无「团队成员档案（编辑）」权限');
                return;
            }
            if (!confirm('确定要删除该成员吗？\n关联的登录账号（非访客）将一并清理。')) return;
            const removed = teamMemberData.find(d => d.id === id);
            teamMemberData = teamMemberData.filter(d => d.id !== id);
            // 全局联动：删除对应正式账号
            try {
                if (removed && typeof accountData !== 'undefined' && Array.isArray(accountData)) {
                    const preferred = typeof getPreferredStudentId === 'function' ? getPreferredStudentId(removed) : '';
                    accountData = accountData.filter(function(a) {
                        if (!a || a.role === 'visitor') return true;
                        if (typeof accountMatchesTeamMember === 'function' && accountMatchesTeamMember(a, removed, preferred)) return false;
                        if (a.teamMemberId != null && Number(a.teamMemberId) === Number(removed.id)) return false;
                        if (a.realName === removed.name) return false;
                        return true;
                    });
                    localStorage.setItem('accountData', JSON.stringify(accountData));
                    try { if (typeof cloudUpsert === 'function') cloudUpsert('accountData', JSON.stringify(accountData)); } catch (e2) {}
                }
            } catch (eDelAcc) {}
            saveTeamMemberData();
            renderTeamMembers();
            switchMemberCategory('all', document.querySelector('.member-nav-item.active') || document.querySelector('.member-nav-item'));
            try { if (typeof renderAccountTable === 'function') renderAccountTable(); } catch (e3) {}
        }
        
        function compressMemberAvatar(img, maxSize, quality) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            let width = img.width;
            let height = img.height;
            if (width > height) {
                if (width > maxSize) { height = height * maxSize / width; width = maxSize; }
            } else {
                if (height > maxSize) { width = width * maxSize / height; height = maxSize; }
            }
            canvas.width = Math.max(1, Math.round(width));
            canvas.height = Math.max(1, Math.round(height));
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', quality);
        }

        function changeMemberAvatar(id) {
            if (typeof canEditOwnMemberProfile === 'function' && !canEditOwnMemberProfile(id)) {
                alert('仅可修改本人头像，或由导师编辑其他成员');
                return;
            }
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = function(e) {
                const file = e.target.files[0];
                if (!file) return;
                if (!file.type || file.type.indexOf('image/') !== 0) {
                    alert('请选择图片文件');
                    return;
                }
                if (file.size > 8 * 1024 * 1024) {
                    alert('图片不能超过 8MB');
                    return;
                }

                const img = new Image();
                const reader = new FileReader();
                reader.onload = function(event) { img.src = event.target.result; };
                img.onload = function() {
                    // 压缩到可同步大小（约 120px / 0.55）
                    let base64 = compressMemberAvatar(img, 128, 0.55);
                    if (base64.length > 100000) {
                        base64 = compressMemberAvatar(img, 96, 0.45);
                    }
                    pendingMemberAvatar = { id: id, dataUrl: base64, fileName: file.name };
                    showMemberDetail(id);
                    const tip = document.getElementById('memberAvatarPendingTip');
                    if (tip) tip.style.display = 'block';
                    const preview = document.getElementById('memberAvatarPreview');
                    if (preview) {
                        preview.innerHTML = `<img src="${base64}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid #667eea;" />`;
                    }
                };
                reader.onerror = function() { alert('读取图片失败，请重试'); };
                reader.readAsDataURL(file);
            };
            input.click();
        }

        var pendingMemberAvatar = null;

        function saveMemberAvatar() {
            if (!pendingMemberAvatar) {
                alert('请先点击“更换头像”选择图片');
                return;
            }
            if (typeof canEditOwnMemberProfile === 'function' && !canEditOwnMemberProfile(pendingMemberAvatar.id)) {
                alert('仅可修改本人头像，或由导师编辑其他成员');
                return;
            }
            const member = teamMemberData.find(d => d.id === pendingMemberAvatar.id);
            if (!member) {
                alert('成员不存在');
                return;
            }
            member.avatar = pendingMemberAvatar.dataUrl;
            member.fileName = pendingMemberAvatar.fileName || '';
            member.avatarSynced = true;
            saveTeamMemberData();
            // 立即强制上传云端（含压缩头像）
            try {
                if (typeof cloudUpsert === 'function') {
                    cloudUpsert('teamMemberData', JSON.stringify(teamMemberData));
                }
            } catch (e) { console.warn(e); }
            pendingMemberAvatar = null;
            renderTeamMembers();
            showMemberDetail(member.id);
            try {
                if (typeof invalidatePortalCache === 'function') invalidatePortalCache();
                if (typeof renderMembersPortal === 'function' && document.getElementById('members') && document.getElementById('members').classList.contains('active')) {
                    renderMembersPortal();
                }
            } catch (e2) {}
            if (typeof showCloudSyncBanner === 'function') {
                showCloudSyncBanner('头像已保存并同步到云端', false);
            } else {
                alert('头像已保存并同步到云端');
            }
            if (typeof renderTaskList === 'function') renderTaskList();
        }

        function cancelPendingMemberAvatar() {
            pendingMemberAvatar = null;
            const tip = document.getElementById('memberAvatarPendingTip');
            if (tip) tip.style.display = 'none';
        }
        
        function showMemberDetail(id) {
            const m = teamMemberData.find(d => d.id === id);
            if (!m) return;
            const canEdit = typeof canEditOwnMemberProfile === 'function' ? canEditOwnMemberProfile(m.id) : (typeof canEditTeamMembers === 'function' && canEditTeamMembers());
            const content = document.getElementById('memberDetailContent');
            const graduatedBadge = m.category === 'advisor' ? '' : (isMemberGraduated(m)
                ? '<div style="display:inline-block;background:#f5f5f5;color:#888;padding:4px 12px;border-radius:20px;font-size:12px;margin-top:8px;margin-left:6px;border:1px solid #e8e8e8;">已毕业（不接收通知）</div>'
                : '<div style="display:inline-block;background:#e6f7ff;color:#1890ff;padding:4px 12px;border-radius:20px;font-size:12px;margin-top:8px;margin-left:6px;border:1px solid #91d5ff;">在读</div>');
            const avatarClick = canEdit ? `onclick="changeMemberAvatar(${m.id})"` : '';
            const avatarCursor = canEdit ? 'cursor:pointer;' : '';
            content.innerHTML = `
                <div style="text-align: center; margin-bottom: 24px;">
                    <div id="memberAvatarPreview">
                    ${(pendingMemberAvatar && pendingMemberAvatar.id === m.id && pendingMemberAvatar.dataUrl) ? `<img src="${pendingMemberAvatar.dataUrl}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;margin:0 auto 12px;border:3px solid #52c41a;" />` : (m.avatar ? `<img src="${m.avatar}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;margin:0 auto 12px;${avatarCursor}border:3px solid #667eea;" ${avatarClick} />` : `<div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:32px;font-weight:bold;${avatarCursor}border:3px solid #667eea;" ${avatarClick}>${m.name.charAt(0)}</div>`)}
                    </div>
                    ${canEdit ? `<p style="font-size:12px;color:#667eea;margin-top:4px;cursor:pointer;" onclick="changeMemberAvatar(${m.id})">点击更换头像</p>` : ''}
                    <div id="memberAvatarPendingTip" style="display:${(pendingMemberAvatar && pendingMemberAvatar.id === m.id) ? 'block' : 'none'};margin:10px auto 0;padding:8px 12px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;color:#389e0d;font-size:12px;width:fit-content;">已选择新头像，请点击下方「保存头像」完成保存与同步</div>
                    <h2 style="margin: 12px 0 0; color: #333;">${m.name}</h2>
                    <div style="display: inline-block; background: #667eea; color: #fff; padding: 4px 16px; border-radius: 20px; font-size: 13px; margin-top: 8px;">${getMemberCategoryLabel(m.category)}</div>${graduatedBadge}
                </div>
                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 16px;">
                    <h4 style="margin: 0 0 8px; color: #333;">个人简介</h4>
                    <p style="margin: 0; color: #666; line-height: 1.8; font-size: 14px;">${m.bio || '暂无简介'}</p>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                        <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">职称/身份</h4>
                        <p style="margin: 0; color: #666; font-size: 14px;">${m.title}</p>
                    </div>
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                        <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">研究方向</h4>
                        <p style="margin: 0; color: #666; font-size: 14px;">${m.research || '-'}</p>
                    </div>
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                        <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">教育背景</h4>
                        <p style="margin: 0; color: #666; font-size: 14px;">${m.education || '-'}</p>
                    </div>
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                        <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">联系电话</h4>
                        <p style="margin: 0; color: #666; font-size: 14px;">${m.phone || '-'}</p>
                    </div>
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                        <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">电子邮箱</h4>
                        <p style="margin: 0; color: #666; font-size: 14px;">${m.email || '-'}</p>
                    </div>
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                        <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">主持项目</h4>
                        <p style="margin: 0; color: #666; font-size: 14px;">${m.projects || '-'}</p>
                    </div>
                </div>
                ${m.awards ? `<div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin-top: 16px;"><h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">获奖情况</h4><p style="margin: 0; color: #666; font-size: 14px;">${m.awards}</p></div>` : ''}
                <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; flex-wrap:wrap; position:sticky; bottom:0; background:#fff; padding-top:12px; border-top:1px solid #f0f0f0;">
                    <button class="btn btn-secondary" onclick="cancelPendingMemberAvatar(); closeMemberDetailModal();">关闭</button>
                    ${canEdit ? `<button class="btn btn-secondary" onclick="closeMemberDetailModal(); editMember(${m.id});">${(typeof canEditTeamMembers === 'function' && canEditTeamMembers()) ? '编辑资料' : '完善我的资料'}</button>
                    <button class="btn" id="saveMemberAvatarBtn" onclick="saveMemberAvatar()" style="${(pendingMemberAvatar && pendingMemberAvatar.id === m.id) ? '' : 'opacity:0.55;'}">保存头像</button>` : ''}
                </div>
            `;
            document.getElementById('memberDetailModal').style.display = 'flex';
        }
        
        function closeMemberDetailModal() { document.getElementById('memberDetailModal').style.display = 'none'; }
        window.editMember = editMember;
        window.showMemberDetail = showMemberDetail;
        window.closeMemberDetailModal = closeMemberDetailModal;
        window.closeMemberEditModal = closeMemberEditModal;
        window.saveMember = saveMember;
        // 编辑弹窗挂到 body，避免在隐藏的 member_archive 内无法显示
        (function hoistMemberModals() {
            ['memberEditModal', 'memberDetailModal'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el && el.parentElement !== document.body) document.body.appendChild(el);
            });
        })();
        
        function switchMemberCategory(category, element) {
            document.querySelectorAll('.member-nav-item').forEach(item => {
                item.classList.remove('active');
                item.style.borderLeftColor = 'transparent';
                item.style.background = '';
                item.style.color = '';
            });
            if (element) {
                element.classList.add('active');
                element.style.borderLeftColor = '#667eea';
                element.style.background = '#f0f4ff';
                element.style.color = '#667eea';
            } else {
                const navItem = document.querySelector('.member-nav-item[data-category="' + category + '"]');
                if (navItem) {
                    navItem.classList.add('active');
                    navItem.style.borderLeftColor = '#667eea';
                    navItem.style.background = '#f0f4ff';
                    navItem.style.color = '#667eea';
                }
            }
            
            if (category === 'all') {
                document.getElementById('memberCategoryAll').style.display = 'block';
                document.getElementById('memberCategorySingle').style.display = 'none';
                renderMemberAllSections();
                renderTeamMembers();
            } else {
                document.getElementById('memberCategoryAll').style.display = 'none';
                document.getElementById('memberCategorySingle').style.display = 'block';
                const members = teamMemberData.filter(m => m.category === category);
                const headerBg = category === 'advisor'
                    ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                    : getMemberGradeGradient(category);
                const single = document.getElementById('memberCategorySingle');
                single.innerHTML = `<div style="margin-bottom: 24px;">
                    <div style="background: ${headerBg}; color: #fff; padding: 12px 20px; border-radius: 8px 8px 0 0; font-size: 16px; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
                        <span>${getMemberCategoryLabel(category)}</span>
                        <button type="button" onclick="showAddMemberModal('${category}')" style="background: rgba(255,255,255,0.22); border: 1px solid rgba(255,255,255,0.45); color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 13px; cursor: pointer;">＋ 增加人员</button>
                    </div>
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 0 0 8px 8px; display: flex; flex-wrap: wrap; gap: 12px;" id="singleMemberGrid"></div>
                </div>`;
                const grid = document.getElementById('singleMemberGrid');
                members.forEach(m => { grid.appendChild(createMemberCard(m)); });
                if (typeof canEditTeamMembers !== 'function' || canEditTeamMembers()) {
                    grid.appendChild(createAddMemberCard(category));
                }
            }
        }
        
        function searchMembers(keyword) {
            keyword = keyword.trim().toLowerCase();
            if (!keyword) {
                renderTeamMembers();
                return;
            }
            const filtered = teamMemberData.filter(m => m.name.toLowerCase().includes(keyword));
            getMemberGridCategories().forEach(function(cat) {
                const grid = document.getElementById(memberGridId(cat));
                if (!grid) return;
                grid.innerHTML = '';
                filtered.filter(m => m.category === cat).forEach(m => { grid.appendChild(createMemberCard(m)); });
                if (typeof canEditTeamMembers !== 'function' || canEditTeamMembers()) {
                    grid.appendChild(createAddMemberCard(cat));
                }
            });
        }
        
        function exportMembers() {
            if (teamMemberData.length === 0) { alert('没有可导出的数据'); return; }
            let csv = '\ufeff姓名,分类,是否毕业,职称/身份,研究方向,教育背景,联系电话,电子邮箱,主持项目,获奖情况,个人简介\n';
            teamMemberData.forEach(d => {
                csv += `"${d.name}","${getMemberCategoryLabel(d.category)}","${isMemberGraduated(d) ? '已毕业' : (d.category === 'advisor' ? '-' : '在读')}","${d.title}","${d.research || ''}","${d.education || ''}","${d.phone || ''}","${d.email || ''}","${d.projects || ''}","${d.awards || ''}","${(d.bio || '').replace(/"/g, '""')}"\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '团队成员数据_' + new Date().toISOString().slice(0, 10) + '.csv';
            link.click();
        }
        
        function getApiKey() {
            return localStorage.getItem('openaiApiKey') || localStorage.getItem('aliyunApiKey') || '';
        }

        async function readMemberImportDocument(file) {
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            if (ext === 'txt') {
                return await file.text();
            }
            if (ext === 'docx') {
                if (!window.mammoth) {
                    throw new Error('Word 解析库未加载，请刷新页面后重试');
                }
                const arrayBuffer = await file.arrayBuffer();
                const result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer });
                return result.value || '';
            }
            if (ext === 'pdf') {
                if (!window.pdfjsLib) {
                    throw new Error('PDF 解析库未加载，请刷新页面后重试');
                }
                if (window.pdfjsLib.GlobalWorkerOptions) {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
                }
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                const pages = [];
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    pages.push(content.items.map(item => item.str).join(' '));
                }
                return pages.join('\n');
            }
            throw new Error('仅支持 docx、pdf、txt 文件');
        }

        function extractFieldFromText(text, labels) {
            for (const label of labels) {
                const pattern = new RegExp(label + '\\s*[：:]\\s*([^\\n\\r；;]+)', 'i');
                const match = text.match(pattern);
                if (match && match[1]) return match[1].trim();
            }
            return '';
        }

        function guessImportedMemberName(text, fileName) {
            const fromField = extractFieldFromText(text, ['姓名', '名字', 'Name']);
            if (fromField) {
                const clean = fromField.replace(/\s+/g, '').match(/[\u4e00-\u9fa5]{2,4}/);
                if (clean) return clean[0];
            }
            const base = fileName.replace(/\.[^.]+$/, '').split(/[+_—\-\s]/)[0];
            const fromFile = base.match(/[\u4e00-\u9fa5]{2,4}/);
            if (fromFile) return fromFile[0];
            const fallback = text.match(/(?:^|\s)([\u4e00-\u9fa5]{2,4})(?:\s|，|,)/);
            return fallback ? fallback[1] : '';
        }

        function parseImportedMembersFromText(text, fileName) {
            const cleaned = String(text || '').replace(/\r/g, '\n').replace(/\n{2,}/g, '\n').trim();
            const phoneFromFile = (fileName.match(/1[3-9]\d{9}/) || [])[0] || '';
            const phone = extractFieldFromText(cleaned, ['电话', '手机号', '手机', '联系电话']) || (cleaned.match(/1[3-9]\d{9}/) || [phoneFromFile])[0] || '';
            const email = extractFieldFromText(cleaned, ['邮箱', '电子邮箱', 'Email']) || (cleaned.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0];
            const name = guessImportedMemberName(cleaned, fileName);
            const title = extractFieldFromText(cleaned, ['职称', '身份', '职位', '岗位']) || '';
            const research = extractFieldFromText(cleaned, ['研究方向', '研究领域', '方向']) || '';
            const education = extractFieldFromText(cleaned, ['教育背景', '学习经历', '学历']) || '';
            const projects = extractFieldFromText(cleaned, ['主持项目', '科研项目', '项目经历']) || '';
            const awards = extractFieldFromText(cleaned, ['获奖情况', '荣誉奖励', '奖励']) || '';
            const yearMatch = (cleaned + ' ' + fileName + ' ' + title).match(/20(22|23|24|25|26)/);
            const category = normalizeMemberCategory(yearMatch ? ('20' + yearMatch[1]) : '', title + ' ' + cleaned.slice(0, 300));
            const finalTitle = title || (category === 'advisor' ? '导师' : category + '级硕士研究生');
            const bio = cleaned.slice(0, 600);

            if (!name) return [];
            return [normalizeTeamMembers([{
                name: name,
                category: category,
                title: finalTitle,
                research: research,
                education: education,
                phone: phone,
                email: email,
                projects: projects,
                awards: awards,
                bio: bio,
                avatar: '',
                fileName: fileName
            }])[0]].filter(Boolean);
        }

        function renderPendingImportMembers(importImages) {
            const resultDiv = document.getElementById('importMembersResult');
            if (pendingImportMembers.length === 0) {
                resultDiv.innerHTML = `<div style="padding:12px; background:#fff3e0; border-radius:6px; color:#e65100;">⚠ 未从文档中提取到成员信息，请检查文档内容是否包含姓名/电话/年级等字段</div>`;
                return;
            }
            let html = `<div style="padding:12px; background:#e8f5e9; border-radius:6px; color:#2e7d32; margin-bottom:12px;">✓ 成功识别 ${pendingImportMembers.length} 位成员，点击确认导入后会同步到账号权限和云端</div>`;
            html += '<div style="max-height:300px; overflow-y:auto; border:1px solid #eee; border-radius:6px; padding:8px;">';
            pendingImportMembers.forEach((m, idx) => {
                const catLabels = {};
                const years = typeof getMemberGradeYears === 'function' ? getMemberGradeYears() : ['2022','2023','2024','2025','2026'];
                catLabels.advisor = '导师';
                years.forEach(function(y) { catLabels[y] = y + '级'; });
                const avatarSrc = importImages && importImages[idx] ? importImages[idx] : '';
                const avatarHtml = avatarSrc ? `<img src="${avatarSrc}" style="width:40px; height:40px; border-radius:50%; object-fit:cover; margin-right:12px;" />` : `<div style="width:40px; height:40px; border-radius:50%; background:#667eea; color:white; display:flex; justify-content:center; align-items:center; font-size:14px; margin-right:12px;">${(m.name || '未')[0]}</div>`;
                html += `<div style="padding:8px; border-bottom:1px solid #f0f0f0; display:flex; align-items:center;">
                    ${avatarHtml}
                    <div style="flex:1;">
                        <strong>${m.name || '未知'}</strong>
                        <span style="color:#888; margin-left:8px;">${m.title || ''}</span>
                        <div style="font-size:12px;color:#999;margin-top:2px;">${m.phone || ''} ${m.email || ''}</div>
                    </div>
                    <span style="font-size:12px; padding:2px 8px; background:#f0f0ff; border-radius:10px; color:#667eea;">${(typeof getMemberCategoryLabel === 'function' ? getMemberCategoryLabel(m.category) : (catLabels[m.category] || m.category || '未分类'))}${m.graduated ? ' · 已毕业' : ''}</span>
                </div>`;
            });
            html += '</div>';
            resultDiv.innerHTML = html;
        }

        function showImportMembersModal() {
            const modal = document.getElementById('importMembersModal');
            if (!modal) {
                const modalDiv = document.createElement('div');
                modalDiv.id = 'importMembersModal';
                modalDiv.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:3000; justify-content:center; align-items:center;';
                modalDiv.innerHTML = `
                    <div style="background:#fff; border-radius:12px; padding:24px; width:500px; max-width:90vw; max-height:80vh; overflow-y:auto;">
                        <h3 style="margin:0 0 16px; color:#333;">导入团队成员</h3>
                        <div style="margin-bottom:16px;">
                            <label style="display:block; margin-bottom:8px; font-weight:bold; color:#555;">选择导入方式</label>
                            <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
                                <button class="btn" onclick="importAdvisorsFromProfileUI()" id="importModeProfile" style="flex:1;min-width:140px;">从个人信息库导入</button>
                                <button class="btn btn-secondary" onclick="setImportMode('csv')" id="importModeCsv" style="flex:1;min-width:100px;">CSV 文件</button>
                                <button class="btn btn-secondary" onclick="setImportMode('doc')" id="importModeDoc" style="flex:1;min-width:100px;">Word/PDF</button>
                            </div>
                            <p style="color:#888;font-size:12px;margin:0 0 8px;">一键导入：王丽萍、罗文文、罗钧（自动同步到云端）</p>
                        </div>
                        <div id="csvImportSection" style="display:none; margin-bottom:16px;">
                            <p style="color:#666; font-size:13px; margin-bottom:8px;">选择 CSV 格式的成员数据文件导入</p>
                            <input type="file" id="csvFileInput" accept=".csv" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">
                        </div>
                        <div id="docImportSection" style="display:none; margin-bottom:16px;">
                            <p style="color:#666; font-size:13px; margin-bottom:8px;">上传 Word(.docx)、PDF 或 TXT 文档，系统在浏览器本地自动提取成员信息</p>
                            <input type="file" id="docFileInput" accept=".docx,.pdf,.txt" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">
                            <div id="importMembersResult" style="margin-top:12px;"></div>
                        </div>
                        <div id="importMembersLoading" style="display:none; text-align:center; padding:20px;">
                            <div style="display:inline-block; width:30px; height:30px; border:3px solid #f3f3f3; border-top:3px solid #667eea; border-radius:50%; animation: spin 1s linear infinite;"></div>
                            <p style="margin-top:12px; color:#666;">正在解析文档并提取成员信息...</p>
                        </div>
                        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                            <button class="btn btn-secondary" onclick="closeImportMembersModal()">取消</button>
                            <button class="btn" onclick="confirmImportMembers()" id="confirmImportBtn">确认导入</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modalDiv);
            }
            document.getElementById('importMembersModal').style.display = 'flex';
            setImportMode('csv');
            document.getElementById('importMembersResult').innerHTML = '';
            document.getElementById('csvFileInput').value = '';
            document.getElementById('docFileInput').value = '';
            pendingImportMembers = [];
        }

        function closeImportMembersModal() {
            document.getElementById('importMembersModal').style.display = 'none';
        }

        let currentImportMode = 'csv';
        let pendingImportMembers = [];

        function setImportMode(mode) {
            currentImportMode = mode;
            const csvBtn = document.getElementById('importModeCsv');
            const docBtn = document.getElementById('importModeDoc');
            const csvSection = document.getElementById('csvImportSection');
            const docSection = document.getElementById('docImportSection');

            if (mode === 'csv') {
                csvBtn.className = 'btn';
                docBtn.className = 'btn btn-secondary';
                csvSection.style.display = 'block';
                docSection.style.display = 'none';
            } else {
                csvBtn.className = 'btn btn-secondary';
                docBtn.className = 'btn';
                csvSection.style.display = 'none';
                docSection.style.display = 'block';
            }
            pendingImportMembers = [];
            document.getElementById('importMembersResult').innerHTML = '';
        }

        function importMembers() {
            showImportMembersModal();

            setTimeout(() => {
                const csvInput = document.getElementById('csvFileInput');
                const docInput = document.getElementById('docFileInput');

                csvInput.onchange = function(e) {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = function(event) {
                        const text = event.target.result;
                        const lines = text.split('\n');
                        pendingImportMembers = [];
                        for (let i = 1; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (!line) continue;
                            const cols = parseCSVLine(line);
                            if (cols.length >= 3) {
                                pendingImportMembers.push({
                                    name: cols[0] || '',
                                    category: cols[1] || '',
                                    title: cols[2] || '',
                                    research: cols[3] || '',
                                    education: cols[4] || '',
                                    phone: cols[5] || '',
                                    email: cols[6] || '',
                                    projects: cols[7] || '',
                                    awards: cols[8] || '',
                                    bio: cols[9] || ''
                                });
                            }
                        }
                        const resultDiv = document.getElementById('importMembersResult');
                        resultDiv.innerHTML = `<div style="padding:12px; background:#e8f5e9; border-radius:6px; color:#2e7d32;">✓ 已解析到 ${pendingImportMembers.length} 条成员记录，点击确认导入</div>`;
                    };
                    reader.readAsText(file, 'UTF-8');
                };

                docInput.onchange = async function(e) {
                    const file = e.target.files[0];
                    if (!file) return;

                    document.getElementById('importMembersLoading').style.display = 'block';
                    document.getElementById('confirmImportBtn').disabled = true;
                    document.getElementById('importMembersResult').innerHTML = '';
                    pendingImportMembers = [];

                    try {
                        const text = await readMemberImportDocument(file);
                        pendingImportMembers = parseImportedMembersFromText(text, file.name);
                        renderPendingImportMembers([]);
                    } catch (error) {
                        document.getElementById('importMembersResult').innerHTML = `<div style="padding:12px; background:#ffebee; border-radius:6px; color:#c62828;">✗ 识别失败：${error.message}</div>`;
                    } finally {
                        document.getElementById('importMembersLoading').style.display = 'none';
                        document.getElementById('confirmImportBtn').disabled = false;
                    }
                };
            }, 50);
        }

        function confirmImportMembers() {
            if (pendingImportMembers.length === 0) {
                alert('没有可导入的成员数据');
                return;
            }

            let count = 0;
            let updated = 0;
            pendingImportMembers = normalizeTeamMembers(pendingImportMembers);
            pendingImportMembers.forEach(m => {
                const idx = teamMemberData.findIndex(function(d) {
                    return d.name === m.name || (m.email && d.email === m.email) || (m.phone && d.phone === m.phone);
                });
                const next = {
                    name: m.name || '',
                    category: normalizeMemberCategory(m.category || '2024', m.title),
                    title: m.title || '',
                    research: m.research || '',
                    education: m.education || '',
                    phone: m.phone || '',
                    email: m.email || '',
                    projects: m.projects || '',
                    awards: m.awards || '',
                    bio: m.bio || '',
                    avatar: m.avatar || '',
                    fileName: m.fileName || ''
                };
                if (idx >= 0) {
                    teamMemberData[idx] = Object.assign({}, teamMemberData[idx], next, {
                        id: teamMemberData[idx].id,
                        avatar: next.avatar || teamMemberData[idx].avatar || ''
                    });
                    updated++;
                } else {
                    const newId = teamMemberData.length > 0 ? Math.max(...teamMemberData.map(d => Number(d.id) || 0)) + 1 : 1;
                    teamMemberData.push(Object.assign({ id: newId }, next));
                    count++;
                }
            });

            saveTeamMemberData();
            renderTeamMembers();
            closeImportMembersModal();
            alert(`导入完成：新增 ${count} 条，更新 ${updated} 条。成员、账号权限和云端已同步。`);
        }
        
        function parseCSVLine(line) {
            const result = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (inQuotes) {
                    if (ch === '"') {
                        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
                        else { inQuotes = false; }
                    } else { current += ch; }
                } else {
                    if (ch === '"') { inQuotes = true; }
                    else if (ch === ',') { result.push(current.trim()); current = ''; }
                    else { current += ch; }
                }
            }
            result.push(current.trim());
            return result;
        }
        
        function resetMemberData() {
            if (!confirm('确定要重置为默认数据吗？当前所有自定义数据将被清除！')) return;
            resetToDefaultMembers();
            renderTeamMembers();
            alert('数据已重置！');
        }
        
        // ========== 专利台账管理模块 ==========
        
        var patentMgmtData = [];
        var filteredPatentMgmtData = [];
        var selectedPatentMgmtIds = new Set();
        var editingPatentMgmtId = null;
        var patentMgmtSortField = '';
        var patentMgmtSortOrder = 'asc';
        var patentPage = 1;
        const PAGE_SIZE = 20;
        
        async function initPatentMgmtData() {
            try {
                const data = await supabaseRequest('GET', 'patents', { select: '*', order: 'grant_date.desc.nullslast' });
                // 过滤掉云端同步占位记录，避免出现在专利台账
                patentMgmtData = (data || []).filter(function(p) {
                    return !(p && (p.classification === '__APP_SYNC__' || (p.patent_number && String(p.patent_number).indexOf('__SYNC_KV__') === 0)));
                });
            } catch (e) {
                console.error('加载专利数据失败:', e);
                patentMgmtData = [];
            }
            patentPage = 1;
            filteredPatentMgmtData = [...patentMgmtData];
            updatePatentMgmtFilterCounts();
            renderPatentMgmtTable();
        }
        
        async function savePatentMgmtData() {
            // Supabase 模式不需要此函数，数据直接写入数据库
        }
        
        function updatePatentMgmtFilterCounts() {
            const currentYear = new Date().getFullYear().toString();
            document.getElementById('patentMgmtCountAll').textContent = patentMgmtData.length;
            document.getElementById('patentMgmtCountCurrentYear').textContent = patentMgmtData.filter(d => d.application_date && d.application_date.startsWith(currentYear)).length;
            document.getElementById('patentMgmtCountReviewing').textContent = patentMgmtData.filter(d => d.status === '实质审查').length;
            document.getElementById('patentMgmtCountApproved').textContent = patentMgmtData.filter(d => d.status === '授权').length;
            document.getElementById('patentMgmtCountRejected').textContent = patentMgmtData.filter(d => d.status === '无效').length;
        }
        
        function renderPatentMgmtTable() {
            const tbody = document.getElementById('patentMgmtTableBody');
            const emptyMsg = document.getElementById('patentMgmtEmptyMessage');
            tbody.innerHTML = '';
            if (filteredPatentMgmtData.length === 0) {
                emptyMsg.style.display = 'block';
                return;
            }
            emptyMsg.style.display = 'none';
            const totalPages = Math.ceil(filteredPatentMgmtData.length / PAGE_SIZE);
            if (patentPage > totalPages) patentPage = totalPages;
            if (patentPage < 1) patentPage = 1;
            const start = (patentPage - 1) * PAGE_SIZE;
            const end = start + PAGE_SIZE;
            const pageData = filteredPatentMgmtData.slice(start, end);
            pageData.forEach(item => {
                const row = document.createElement('tr');
                let statusClass = 'tag-warning';
                if (item.status === '授权') statusClass = 'tag-success';
                else if (item.status === '无效') statusClass = 'tag-danger';
                else if (item.status === '公布') statusClass = 'tag-primary';
                else if (item.status === '实质审查') statusClass = 'tag-warning';
                row.innerHTML = `
                    <td><input type="checkbox" ${selectedPatentMgmtIds.has(item.id) ? 'checked' : ''} onchange="togglePatentMgmtSelect(${item.id}, this)"></td>
                    <td>${item.patent_type || '-'}</td>
                    <td>${item.name}</td>
                    <td>${item.patent_number || '-'}</td>
                    <td>${item.announcement_number || '-'}</td>
                    <td>${item.grant_date || '-'}</td>
                    <td>${item.applicant || '-'}</td>
                    <td>${item.inventor || '-'}</td>
                    <td>${item.classification || '-'}</td>
                    <td><span class="tag ${statusClass}">${item.status}</span></td>
                    <td>
                        <button class="btn" style="padding: 4px 10px; font-size: 12px; margin-right: 5px;" onclick="editPatentMgmt(${item.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="deletePatentMgmt(${item.id})">删除</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
            let paginationHtml = `<div style="display:flex;justify-content:space-between;align-items:center;padding:15px;border-top:1px solid #eee;">
                <span style="color:#666;">共 ${filteredPatentMgmtData.length} 条，第 ${patentPage}/${totalPages} 页</span>
                <div style="display:flex;gap:5px;align-items:center;">
                    <button class="btn" style="padding:4px 12px;font-size:12px;${patentPage===1?'opacity:0.5;pointer-events:none':''}" onclick="changePatentPage(${patentPage-1})">上一页</button>`;
            for (let p = 1; p <= totalPages; p++) {
                if (totalPages > 7 && Math.abs(p - patentPage) > 2 && p !== 1 && p !== totalPages) {
                    if (p === patentPage - 3 || p === patentPage + 3) paginationHtml += `<span style="padding:4px;">...</span>`;
                    continue;
                }
                paginationHtml += `<button class="btn" style="padding:4px 12px;font-size:12px;${p===patentPage?'background:#666;':''}" onclick="changePatentPage(${p})">${p}</button>`;
            }
            paginationHtml += `<button class="btn" style="padding:4px 12px;font-size:12px;${patentPage===totalPages?'opacity:0.5;pointer-events:none':''}" onclick="changePatentPage(${patentPage+1})">下一页</button>
                </div></div>`;
            const existing = document.getElementById('patentPagination');
            if (existing) existing.remove();
            const paginationDiv = document.createElement('div');
            paginationDiv.id = 'patentPagination';
            paginationDiv.innerHTML = paginationHtml;
            tbody.parentNode.parentNode.appendChild(paginationDiv);
        }
        
        function changePatentPage(page) {
            const totalPages = Math.ceil(filteredPatentMgmtData.length / PAGE_SIZE);
            if (page < 1 || page > totalPages) return;
            patentPage = page;
            selectedPatentMgmtIds.clear();
            renderPatentMgmtTable();
        }
        
        function showAddPatentMgmtModal() {
            editingPatentMgmtId = null;
            document.getElementById('patentMgmtModalTitle').textContent = '新增专利';
            document.getElementById('patentMgmtPatentType').value = '发明专利';
            document.getElementById('patentMgmtName').value = '';
            document.getElementById('patentMgmtPatentNumber').value = '';
            document.getElementById('patentMgmtAnnouncementNumber').value = '';
            document.getElementById('patentMgmtGrantDate').value = '';
            document.getElementById('patentMgmtApplicant').value = '';
            document.getElementById('patentMgmtInventor').value = '';
            document.getElementById('patentMgmtClassification').value = '';
            document.getElementById('patentMgmtApplicationDate').value = '';
            document.getElementById('patentMgmtStatus').value = '实质审查';
            document.getElementById('patentMgmtFile').value = '';
            document.getElementById('patentMgmtSummary').value = '';
            clearPatentImage();
            document.getElementById('patentMgmtModal').style.display = 'flex';
        }
        
        function closePatentMgmtModal() {
            document.getElementById('patentMgmtModal').style.display = 'none';
        }
        
        let patentImageBase64 = null;
        
        document.getElementById('patentMgmtFile').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) {
                clearPatentImage();
                return;
            }
            const reader = new FileReader();
            reader.onload = function(event) {
                patentImageBase64 = event.target.result.split(',')[1];
                document.getElementById('patentImagePreviewImg').src = event.target.result;
                document.getElementById('patentImagePreview').style.display = 'block';
            };
            reader.readAsDataURL(file);
        });
        
        function clearPatentImage() {
            patentImageBase64 = null;
            document.getElementById('patentMgmtFile').value = '';
            document.getElementById('patentImagePreview').style.display = 'none';
            document.getElementById('patentImagePreviewImg').src = '';
        }
        
        async function recognizePatentCertificate(buttonEl) {
            if (!patentImageBase64) {
                alert('请先上传专利证书图片');
                return;
            }

            const recognizeBtn = buttonEl;
            const originalText = recognizeBtn.innerHTML;
            recognizeBtn.innerHTML = '⏳ 识别中...';
            recognizeBtn.disabled = true;

            try {
                console.log('开始 OCR 识别...');
                const ocrResponse = await fetch(`${API_PROXY}/api/baidu-ocr`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: patentImageBase64 })
                });

                console.log('OCR 响应状态:', ocrResponse.status);
                if (!ocrResponse.ok) {
                    const errText = await ocrResponse.text();
                    console.error('OCR 错误:', errText);
                    throw new Error('OCR 识别失败: ' + ocrResponse.status);
                }

                const ocrData = await ocrResponse.json();
                console.log('OCR 返回数据:', JSON.stringify(ocrData).substring(0, 500));

                if (ocrData.words_result && ocrData.words_result.length > 0) {
                    const ocrText = ocrData.words_result.map(item => item.words).join('\n');
                    console.log('OCR 提取文本:', ocrText);

                    recognizeBtn.innerHTML = '🤖 AI 提取字段中...';

                    const apiKey = (typeof getChatApiKey === 'function' ? getChatApiKey() : (localStorage.getItem('openaiApiKey') || ''));
                    if (!apiKey) {
                        recognizeBtn.innerHTML = originalText;
                        recognizeBtn.disabled = false;
                        alert('未配置百炼 API 密钥，请先到「智能工具 → OpenAI入口」保存密钥后再试。');
                        return;
                    }

                    console.log('开始调用 AI 提取字段...');
                    const aiResponse = await fetch(`${API_PROXY}/api/aliyun`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            apiKey: apiKey,
                            model: 'qwen-turbo',
                            messages: [{
                                role: 'user',
                                content: `请从以下专利证书识别文本中提取字段，以JSON格式返回，不要其他任何内容：
{
  "patentType": "专利类型（如：发明专利/实用新型/外观设计）",
  "name": "专利名称",
  "patentNumber": "专利号",
  "announcementNumber": "授权公告号",
  "grantDate": "授权公告日（格式：YYYY-MM-DD）",
  "applicant": "申请人/专利权人",
  "inventor": "发明人",
  "classification": "IPC分类号",
  "applicationDate": "申请日期（格式：YYYY-MM-DD）",
  "summary": "摘要（如果有）"
}

识别文本：
${ocrText}`
                            }],
                            temperature: 0.3,
                            max_tokens: 500
                        })
                    });

                    console.log('AI 响应状态:', aiResponse.status);
                    const aiResponseText = await aiResponse.text();
                    console.log('AI 返回内容:', aiResponseText.substring(0, 1000));

                    if (!aiResponse.ok) {
                        throw new Error('AI 字段提取失败 (HTTP ' + aiResponse.status + '): ' + aiResponseText);
                    }

                    const aiData = JSON.parse(aiResponseText);

                    if (aiData.error) {
                        throw new Error('AI 错误: ' + aiData.error.message);
                    }

                    const aiContent = aiData.choices[0].message.content;
                    console.log('AI 提取内容:', aiContent);

                    const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const extractedData = JSON.parse(jsonMatch[0]);
                        console.log('提取的字段数据:', extractedData);

                        if (extractedData.patentType) document.getElementById('patentMgmtPatentType').value = extractedData.patentType;
                        if (extractedData.name) document.getElementById('patentMgmtName').value = extractedData.name;
                        if (extractedData.patentNumber) document.getElementById('patentMgmtPatentNumber').value = extractedData.patentNumber;
                        if (extractedData.announcementNumber) document.getElementById('patentMgmtAnnouncementNumber').value = extractedData.announcementNumber;
                        if (extractedData.grantDate) {
                            const grantDateStr = extractedData.grantDate.replace(/[年月]/g, '-').replace(/[日]/g, '');
                            document.getElementById('patentMgmtGrantDate').value = grantDateStr;
                        }
                        if (extractedData.applicant) document.getElementById('patentMgmtApplicant').value = extractedData.applicant;
                        if (extractedData.inventor) document.getElementById('patentMgmtInventor').value = extractedData.inventor;
                        if (extractedData.classification) document.getElementById('patentMgmtClassification').value = extractedData.classification;
                        if (extractedData.applicationDate) {
                            const dateStr = extractedData.applicationDate.replace(/[年月]/g, '-').replace(/[日]/g, '');
                            document.getElementById('patentMgmtApplicationDate').value = dateStr;
                        }
                        if (extractedData.summary) document.getElementById('patentMgmtSummary').value = extractedData.summary;

                        alert('识别成功！请检查并确认自动填充的信息。');
                    } else {
                        alert('AI 返回格式异常，请手动填写');
                    }
                } else {
                    alert('未能识别到文字，请检查图片质量');
                }
            } catch (error) {
                console.error('识别错误:', error);
                alert('识别失败：' + error.message);
            } finally {
                recognizeBtn.innerHTML = originalText;
                recognizeBtn.disabled = false;
            }
        }
        
        async function savePatentMgmt() {
            const patentType = document.getElementById('patentMgmtPatentType').value;
            const name = document.getElementById('patentMgmtName').value.trim();
            const patentNumber = document.getElementById('patentMgmtPatentNumber').value.trim();
            const announcementNumber = document.getElementById('patentMgmtAnnouncementNumber').value.trim();
            const grantDate = document.getElementById('patentMgmtGrantDate').value;
            const applicant = document.getElementById('patentMgmtApplicant').value.trim();
            const inventor = document.getElementById('patentMgmtInventor').value.trim();
            const classification = document.getElementById('patentMgmtClassification').value;
            const applicationDate = document.getElementById('patentMgmtApplicationDate').value;
            const status = document.getElementById('patentMgmtStatus').value;
            const summary = document.getElementById('patentMgmtSummary').value.trim();
            if (!patentType || !name || !patentNumber || !applicant || !classification || !applicationDate) {
                alert('请填写所有必填字段');
                return;
            }
            const record = { patent_type: patentType, name, patent_number: patentNumber, announcement_number: announcementNumber || null, grant_date: grantDate || null, applicant, inventor: inventor || null, classification, application_date: applicationDate, status, summary };
            try {
                if (editingPatentMgmtId) {
                    await supabaseRequest('PATCH', 'patents?id=eq.' + editingPatentMgmtId, record);
                } else {
                    await supabaseRequest('POST', 'patents', record);
                }
                await initPatentMgmtData();
                closePatentMgmtModal();
                alert('保存成功！');
                try {
                    if (typeof offerNewsDraftFromAchievement === 'function') {
                        setTimeout(function () {
                            offerNewsDraftFromAchievement({
                                title: '专利动态：' + name,
                                summary: summary || (name + '（' + patentNumber + '）'),
                                content: '<h2>专利动态</h2><p><strong>名称：</strong>' + name + '</p><p><strong>专利号：</strong>' + patentNumber + '</p><p><strong>申请人：</strong>' + applicant + '</p><p>' + (summary || '') + '</p>',
                                tags: ['专利', '成果']
                            });
                        }, 200);
                    }
                } catch (eNews) {}
            } catch (e) {
                console.error('保存专利失败:', e);
                alert('保存失败：' + e.message);
            }
        }
        
        function editPatentMgmt(id) {
            const item = patentMgmtData.find(d => d.id === id);
            if (!item) return;
            editingPatentMgmtId = id;
            document.getElementById('patentMgmtModalTitle').textContent = '编辑专利';
            document.getElementById('patentMgmtPatentType').value = item.patent_type || '发明专利';
            document.getElementById('patentMgmtName').value = item.name;
            document.getElementById('patentMgmtPatentNumber').value = item.patent_number;
            document.getElementById('patentMgmtAnnouncementNumber').value = item.announcement_number || '';
            document.getElementById('patentMgmtGrantDate').value = item.grant_date || '';
            document.getElementById('patentMgmtApplicant').value = item.applicant;
            document.getElementById('patentMgmtInventor').value = item.inventor || '';
            document.getElementById('patentMgmtClassification').value = item.classification || '';
            document.getElementById('patentMgmtApplicationDate').value = item.application_date;
            document.getElementById('patentMgmtStatus').value = item.status;
            document.getElementById('patentMgmtSummary').value = item.summary || '';
            document.getElementById('patentMgmtModal').style.display = 'flex';
        }
        
        async function deletePatentMgmt(id) {
            if (!confirm('确定要删除这条专利记录吗？')) return;
            try {
                await supabaseRequest('DELETE', 'patents?id=eq.' + id);
                selectedPatentMgmtIds.delete(id);
                await initPatentMgmtData();
            } catch (e) {
                console.error('删除专利失败:', e);
                alert('删除失败：' + e.message);
            }
        }
        
        function togglePatentMgmtSelectAll(checkbox) {
            if (checkbox.checked) {
                filteredPatentMgmtData.forEach(d => selectedPatentMgmtIds.add(d.id));
            } else {
                selectedPatentMgmtIds.clear();
            }
            renderPatentMgmtTable();
        }
        
        function togglePatentMgmtSelect(id, checkbox) {
            if (checkbox.checked) selectedPatentMgmtIds.add(id);
            else selectedPatentMgmtIds.delete(id);
        }
        
        function filterPatentMgmtByTag(tag, element) {
            document.querySelectorAll('#patentMgmtFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            const currentYear = new Date().getFullYear().toString();
            switch(tag) {
                case 'all': filteredPatentMgmtData = [...patentMgmtData]; break;
                case 'current_year': filteredPatentMgmtData = patentMgmtData.filter(d => d.application_date && d.application_date.startsWith(currentYear)); break;
                case 'reviewing': filteredPatentMgmtData = patentMgmtData.filter(d => d.status === '实质审查'); break;
                case 'approved': filteredPatentMgmtData = patentMgmtData.filter(d => d.status === '授权'); break;
                case 'rejected': filteredPatentMgmtData = patentMgmtData.filter(d => d.status === '无效'); break;
            }
            patentPage = 1;
            renderPatentMgmtTable();
        }
        
        function togglePatentMgmtMoreFilters() {
            const el = document.getElementById('patentMgmtMoreFilters');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }
        
        function applyPatentMgmtFilters() {
            const name = document.getElementById('patentMgmtFilterName').value.trim().toLowerCase();
            const patentNumber = document.getElementById('patentMgmtFilterNumber').value.trim().toLowerCase();
            const applicant = document.getElementById('patentMgmtFilterApplicant').value.trim().toLowerCase();
            const year = document.getElementById('patentMgmtFilterYear').value;
            const status = document.getElementById('patentMgmtFilterStatus').value;
            const classification = document.getElementById('patentMgmtFilterClassification').value;
            const dateFrom = document.getElementById('patentMgmtFilterDateFrom').value;
            const dateTo = document.getElementById('patentMgmtFilterDateTo').value;
            filteredPatentMgmtData = patentMgmtData.filter(d => {
                if (name && !d.name.toLowerCase().includes(name)) return false;
                if (patentNumber && !(d.patent_number || '').toLowerCase().includes(patentNumber)) return false;
                if (applicant && !d.applicant.toLowerCase().includes(applicant)) return false;
                if (year && (!d.application_date || !d.application_date.startsWith(year))) return false;
                if (status && d.status !== status) return false;
                if (classification && d.classification !== classification) return false;
                if (dateFrom && (!d.application_date || d.application_date < dateFrom)) return false;
                if (dateTo && (!d.application_date || d.application_date > dateTo)) return false;
                return true;
            });
            patentPage = 1;
            renderPatentMgmtTable();
        }
        
        function resetPatentMgmtFilters() {
            document.getElementById('patentMgmtFilterName').value = '';
            document.getElementById('patentMgmtFilterNumber').value = '';
            document.getElementById('patentMgmtFilterApplicant').value = '';
            document.getElementById('patentMgmtFilterYear').value = '';
            document.getElementById('patentMgmtFilterStatus').value = '';
            document.getElementById('patentMgmtFilterClassification').value = '';
            document.getElementById('patentMgmtFilterDateFrom').value = '';
            document.getElementById('patentMgmtFilterDateTo').value = '';
            document.getElementById('patentMgmtMoreFilters').style.display = 'none';
            document.querySelectorAll('#patentMgmtFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            document.querySelector('#patentMgmtFilterTags .filter-tag').classList.add('active');
            filteredPatentMgmtData = [...patentMgmtData];
            patentPage = 1;
            renderPatentMgmtTable();
        }
        
        function sortPatentMgmtTable(field) {
            if (patentMgmtSortField === field) {
                patentMgmtSortOrder = patentMgmtSortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                patentMgmtSortField = field;
                patentMgmtSortOrder = 'asc';
            }
            filteredPatentMgmtData.sort((a, b) => {
                const fieldMap = { patentNumber: 'patent_number', applicationDate: 'application_date', grantDate: 'grant_date', announcementNumber: 'announcement_number', patentType: 'patent_type', inventor: 'inventor' };
                const mappedField = fieldMap[field] || field;
                let valA = a[mappedField] || '';
                let valB = b[mappedField] || '';
                if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
                if (valA < valB) return patentMgmtSortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return patentMgmtSortOrder === 'asc' ? 1 : -1;
                return 0;
            });
            renderPatentMgmtTable();
        }
        
        async function batchDeletePatentMgmt() {
            if (selectedPatentMgmtIds.size === 0) { alert('请先选择要删除的记录'); return; }
            if (!confirm(`确定要删除选中的 ${selectedPatentMgmtIds.size} 条记录吗？`)) return;
            try {
                const ids = Array.from(selectedPatentMgmtIds);
                await supabaseRequest('DELETE', 'patents?id=in.(' + ids.join(',') + ')');
                selectedPatentMgmtIds.clear();
                await initPatentMgmtData();
            } catch (e) {
                console.error('批量删除失败:', e);
                alert('删除失败：' + e.message);
            }
        }
        
        function batchAuditPatentMgmt() {
            if (selectedPatentMgmtIds.size === 0) { alert('请先选择要审核的记录'); return; }
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">批量审核</h3>
                <div class="form-group"><label>新状态</label>
                    <select id="batchAuditStatusSelect" class="form-control">
                        <option value="申请">申请</option><option value="受理">受理</option><option value="初审">初审</option><option value="公布">公布</option><option value="实质审查">实质审查</option><option value="授权">授权</option><option value="届满">届满</option><option value="无效">无效</option>
                    </select>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">取消</button>
                    <button class="btn" onclick="confirmBatchAuditPatentMgmt(this)">确定</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        async function confirmBatchAuditPatentMgmt(btn) {
            const newStatus = document.getElementById('batchAuditStatusSelect').value;
            try {
                const ids = Array.from(selectedPatentMgmtIds);
                const record = { status: newStatus };
                await supabaseRequest('PATCH', 'patents?id=in.(' + ids.join(',') + ')', record);
                selectedPatentMgmtIds.clear();
                await initPatentMgmtData();
                btn.closest('div[style*="fixed"]').remove();
                alert('批量审核完成！');
            } catch (e) {
                console.error('批量审核失败:', e);
                alert('审核失败：' + e.message);
            }
        }
        
        function exportPatentMgmt() {
            if (filteredPatentMgmtData.length === 0) { alert('没有可导出的数据'); return; }
            let csv = '\ufeff专利类型,专利名称,专利号,授权公告号,授权日,申请人,发明人,专利所属类别,状态\n';
            filteredPatentMgmtData.forEach(d => {
                csv += `${d.patent_type || ''},${d.name},${d.patent_number},${d.announcement_number || ''},${d.grant_date || ''},${d.applicant || ''},${d.inventor || ''},${d.classification || ''},${d.status}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '专利台账数据_' + new Date().toISOString().slice(0,10) + '.csv';
            link.click();
        }
        
        function importPatentMgmt() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.csv';
            input.onchange = function(e) {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 9) {
                            const newId = patentMgmtData.length > 0 ? Math.max(...patentMgmtData.map(d => d.id)) + 1 : 1;
                            await supabaseRequest('POST', 'patents', { patent_type: cols[0] || '', name: cols[1] || '', patent_number: cols[2] || '', announcement_number: cols[3] || null, grant_date: cols[4] || null, applicant: cols[5] || '', inventor: cols[6] || null, classification: cols[7] || '', status: cols[8] || '实质审查', application_date: cols.length > 9 ? (cols[9] || null) : null, summary: '', remark: '' });
                            count++;
                        }
                    }
                    await initPatentMgmtData();
                    applyPatentMgmtFilters();
                    alert(`成功导入 ${count} 条记录`);
                };
                reader.readAsText(file, 'UTF-8');
            };
            input.click();
        }
        
        function viewPatentMgmtStats() {
            const total = patentMgmtData.length;
            const currentYear = new Date().getFullYear().toString();
            const thisYear = patentMgmtData.filter(d => d.application_date && d.application_date.startsWith(currentYear)).length;
            const approved = patentMgmtData.filter(d => d.status === '授权').length;
            const reviewing = patentMgmtData.filter(d => d.status === '实质审查').length;
            const rejected = patentMgmtData.filter(d => d.status === '无效').length;
            const publicCount = patentMgmtData.filter(d => d.status === '公布').length;
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">专利数据统计</h3>
                <div style="line-height:2;font-size:15px;">
                    <p>总数：<strong>${total}</strong></p>
                    <p>当年申请：<strong>${thisYear}</strong></p>
                    <p>已授权：<strong style="color:#28a745;">${approved}</strong></p>
                    <p>已公开：<strong style="color:#17a2b8;">${publicCount}</strong></p>
                    <p>审查中：<strong style="color:#ffc107;">${reviewing}</strong></p>
                    <p>已失效：<strong style="color:#dc3545;">${rejected}</strong></p>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:20px;">
                    <button class="btn" onclick="this.closest('div[style*=fixed]').remove()">关闭</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        // ========== 论文成果管理模块 ==========
        
        var paperData = [];
        var filteredPaperData = [];
        var selectedPaperIds = new Set();
        var editingPaperId = null;
        var paperSortField = '';
        var paperSortOrder = 'asc';
        
        async function initPaperData() {
            try {
                const data = await supabaseRequest('GET', 'papers', { select: '*', order: 'publish_date.desc' });
                paperData = data || [];
            } catch (e) {
                console.error('加载论文数据失败:', e);
                paperData = [];
            }
            filteredPaperData = [...paperData];
            updatePaperFilterCounts();
            renderPaperTable();
        }
        
        async function savePaperData() {
            // Supabase 模式不需要此函数
        }
        
        function updatePaperFilterCounts() {
            const currentYear = new Date().getFullYear().toString();
            document.getElementById('paperCountAll').textContent = paperData.length;
            document.getElementById('paperCountCurrentYear').textContent = paperData.filter(d => d.publish_date && d.publish_date.startsWith(currentYear)).length;
            document.getElementById('paperCountReviewing').textContent = paperData.filter(d => d.status === '审核中').length;
            document.getElementById('paperCountApproved').textContent = paperData.filter(d => d.status === '已通过').length;
            document.getElementById('paperCountRejected').textContent = paperData.filter(d => d.status === '已驳回').length;
        }
        
        function renderPaperTable() {
            const tbody = document.getElementById('paperTableBody');
            const emptyMsg = document.getElementById('paperEmptyMessage');
            tbody.innerHTML = '';
            if (filteredPaperData.length === 0) { emptyMsg.style.display = 'block'; return; }
            emptyMsg.style.display = 'none';
            filteredPaperData.forEach(item => {
                const row = document.createElement('tr');
                let statusClass = 'tag-warning';
                if (item.status === '已通过') statusClass = 'tag-success';
                else if (item.status === '已驳回') statusClass = 'tag-danger';
                row.innerHTML = `
                    <td><input type="checkbox" ${selectedPaperIds.has(item.id) ? 'checked' : ''} onchange="togglePaperSelect(${item.id}, this)"></td>
                    <td>${item.publish_date ? item.publish_date.substring(0, 4) : '-'}</td>
                    <td>${item.title}</td>
                    <td>${item.author || '-'}</td>
                    <td>${item.journal || '-'}</td>
                    <td>${item.index || '-'}</td>
                    <td>${item.unit || '-'}</td>
                    <td>${item.publish_date || '-'}</td>
                    <td><span class="tag ${statusClass}">${item.status}</span></td>
                    <td>
                        <button class="btn" style="padding: 4px 10px; font-size: 12px; margin-right: 5px;" onclick="editPaper(${item.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="deletePaper(${item.id})">删除</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
        
        function showAddPaperModal() {
            editingPaperId = null;
            document.getElementById('paperModalTitle').textContent = '新增论文';
            document.getElementById('paperTitle').value = '';
            document.getElementById('paperAuthor').value = '';
            document.getElementById('paperJournal').value = '';
            document.getElementById('paperUnit').value = '';
            document.getElementById('paperIndex').value = '';
            document.getElementById('paperPublishDate').value = '';
            document.getElementById('paperStatus').value = '审核中';
            document.getElementById('paperFile').value = '';
            document.getElementById('paperRemark').value = '';
            document.getElementById('paperModal').style.display = 'flex';
        }
        
        function closePaperModal() {
            document.getElementById('paperModal').style.display = 'none';
        }
        
        async function savePaper() {
            const title = document.getElementById('paperTitle').value.trim();
            const author = document.getElementById('paperAuthor').value.trim();
            const journal = document.getElementById('paperJournal').value.trim();
            const unit = document.getElementById('paperUnit').value.trim();
            const index = document.getElementById('paperIndex').value;
            const publishDate = document.getElementById('paperPublishDate').value;
            const status = document.getElementById('paperStatus').value;
            const remark = document.getElementById('paperRemark').value.trim();
            if (!title || !author || !journal || !unit || !index || !publishDate) {
                alert('请填写所有必填字段');
                return;
            }
            const record = { title, author, journal, unit, index, publish_date: publishDate, status, remark };
            try {
                if (editingPaperId) {
                    await supabaseRequest('PATCH', 'papers?id=eq.' + editingPaperId, record);
                } else {
                    await supabaseRequest('POST', 'papers', record);
                }
                await initPaperData();
                closePaperModal();
                alert('保存成功！');
                try {
                    if (typeof offerNewsDraftFromPaper === 'function') {
                        setTimeout(function () {
                            offerNewsDraftFromPaper({ title: title, author: author, journal: journal, publish_date: publishDate, status: status, remark: remark, index: index });
                        }, 200);
                    }
                } catch (eNews) { console.warn(eNews); }
            } catch (e) {
                console.error('保存论文失败:', e);
                alert('保存失败：' + e.message);
            }
        }
        
        function editPaper(id) {
            const item = paperData.find(d => d.id === id);
            if (!item) return;
            editingPaperId = id;
            document.getElementById('paperModalTitle').textContent = '编辑论文';
            document.getElementById('paperTitle').value = item.title;
            document.getElementById('paperAuthor').value = item.author;
            document.getElementById('paperJournal').value = item.journal;
            document.getElementById('paperUnit').value = item.unit;
            document.getElementById('paperIndex').value = item.index;
            document.getElementById('paperPublishDate').value = item.publish_date;
            document.getElementById('paperStatus').value = item.status;
            document.getElementById('paperRemark').value = item.remark || '';
            document.getElementById('paperModal').style.display = 'flex';
        }
        
        async function deletePaper(id) {
            if (!confirm('确定要删除这条论文记录吗？')) return;
            try {
                await supabaseRequest('DELETE', 'papers?id=eq.' + id);
                selectedPaperIds.delete(id);
                await initPaperData();
            } catch (e) {
                console.error('删除论文失败:', e);
                alert('删除失败：' + e.message);
            }
        }
        
        function togglePaperSelectAll(checkbox) {
            if (checkbox.checked) filteredPaperData.forEach(d => selectedPaperIds.add(d.id));
            else selectedPaperIds.clear();
            renderPaperTable();
        }
        
        function togglePaperSelect(id, checkbox) {
            if (checkbox.checked) selectedPaperIds.add(id);
            else selectedPaperIds.delete(id);
        }
        
        function filterPaperByTag(tag, element) {
            document.querySelectorAll('#paperFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            const currentYear = new Date().getFullYear().toString();
            switch(tag) {
                case 'all': filteredPaperData = [...paperData]; break;
                case 'current_year': filteredPaperData = paperData.filter(d => d.publish_date && d.publish_date.startsWith(currentYear)); break;
                case 'reviewing': filteredPaperData = paperData.filter(d => d.status === '审核中'); break;
                case 'approved': filteredPaperData = paperData.filter(d => d.status === '已通过'); break;
                case 'rejected': filteredPaperData = paperData.filter(d => d.status === '已驳回'); break;
            }
            renderPaperTable();
        }
        
        function togglePaperMoreFilters() {
            const el = document.getElementById('paperMoreFilters');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }
        
        function applyPaperFilters() {
            const title = document.getElementById('paperFilterTitle').value.trim().toLowerCase();
            const author = document.getElementById('paperFilterAuthor').value.trim().toLowerCase();
            const journal = document.getElementById('paperFilterJournal').value.trim().toLowerCase();
            const year = document.getElementById('paperFilterYear').value;
            const status = document.getElementById('paperFilterStatus').value;
            const index = document.getElementById('paperFilterIndex').value;
            const unit = document.getElementById('paperFilterUnit').value.trim().toLowerCase();
            const dateFrom = document.getElementById('paperFilterDateFrom').value;
            const dateTo = document.getElementById('paperFilterDateTo').value;
            filteredPaperData = paperData.filter(d => {
                if (title && !d.title.toLowerCase().includes(title)) return false;
                if (author && !d.author.toLowerCase().includes(author)) return false;
                if (journal && !(d.journal || '').toLowerCase().includes(journal)) return false;
                if (year && (!d.publish_date || !d.publish_date.startsWith(year))) return false;
                if (status && d.status !== status) return false;
                if (index && d.index !== index) return false;
                if (unit && (!d.unit || !d.unit.toLowerCase().includes(unit))) return false;
                if (dateFrom && (!d.publish_date || d.publish_date < dateFrom)) return false;
                if (dateTo && (!d.publish_date || d.publish_date > dateTo)) return false;
                return true;
            });
            renderPaperTable();
        }
        
        function resetPaperFilters() {
            document.getElementById('paperFilterTitle').value = '';
            document.getElementById('paperFilterAuthor').value = '';
            document.getElementById('paperFilterJournal').value = '';
            document.getElementById('paperFilterYear').value = '';
            document.getElementById('paperFilterStatus').value = '';
            document.getElementById('paperFilterIndex').value = '';
            document.getElementById('paperFilterUnit').value = '';
            document.getElementById('paperFilterDateFrom').value = '';
            document.getElementById('paperFilterDateTo').value = '';
            document.getElementById('paperMoreFilters').style.display = 'none';
            document.querySelectorAll('#paperFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            document.querySelector('#paperFilterTags .filter-tag').classList.add('active');
            filteredPaperData = [...paperData];
            renderPaperTable();
        }
        
        function sortPaperTable(field) {
            if (paperSortField === field) paperSortOrder = paperSortOrder === 'asc' ? 'desc' : 'asc';
            else { paperSortField = field; paperSortOrder = 'asc'; }
            const fieldMap = { publishDate: 'publish_date' };
            const mappedField = fieldMap[field] || field;
            filteredPaperData.sort((a, b) => {
                let valA = a[mappedField] || ''; let valB = b[mappedField] || '';
                if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
                if (valA < valB) return paperSortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return paperSortOrder === 'asc' ? 1 : -1;
                return 0;
            });
            renderPaperTable();
        }
        
        async function batchDeletePapers() {
            if (selectedPaperIds.size === 0) { alert('请先选择要删除的记录'); return; }
            if (!confirm(`确定要删除选中的 ${selectedPaperIds.size} 条记录吗？`)) return;
            try {
                const ids = Array.from(selectedPaperIds);
                await supabaseRequest('DELETE', 'papers?id=in.(' + ids.join(',') + ')');
                selectedPaperIds.clear();
                await initPaperData();
            } catch (e) {
                console.error('批量删除失败:', e);
                alert('删除失败：' + e.message);
            }
        }
        
        async function batchAuditPapers() {
            if (selectedPaperIds.size === 0) { alert('请先选择要审核的记录'); return; }
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">批量审核</h3>
                <div class="form-group"><label>新状态</label>
                    <select id="batchAuditPaperStatusSelect" class="form-control">
                        <option value="审核中">审核中</option><option value="已通过">已通过</option><option value="已驳回">已驳回</option>
                    </select>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">取消</button>
                    <button class="btn" onclick="confirmBatchAuditPapers(this)">确定</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        async function confirmBatchAuditPapers(btn) {
            const newStatus = document.getElementById('batchAuditPaperStatusSelect').value;
            try {
                const ids = Array.from(selectedPaperIds);
                const record = { status: newStatus };
                await supabaseRequest('PATCH', 'papers?id=in.(' + ids.join(',') + ')', record);
                selectedPaperIds.clear();
                await initPaperData();
                btn.closest('div[style*="fixed"]').remove();
                alert('批量审核完成！');
            } catch (e) {
                console.error('批量审核失败:', e);
                alert('审核失败：' + e.message);
            }
        }
        
        function exportPapers() {
            if (filteredPaperData.length === 0) { alert('没有可导出的数据'); return; }
            let csv = '\ufeff所属年度,论文标题,作者,期刊名称,收录类型,所属单位,发表日期,状态\n';
            filteredPaperData.forEach(d => {
                csv += `${d.publish_date ? d.publish_date.substring(0,4) : ''},${d.title},${d.author},${d.journal},${d.index},${d.unit},${d.publish_date},${d.status}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '论文数据_' + new Date().toISOString().slice(0,10) + '.csv';
            link.click();
        }
        
        function importPapers() {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.csv';
            input.onchange = function(e) {
                const file = e.target.files[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 8) {
                            const newId = paperData.length > 0 ? Math.max(...paperData.map(d => d.id)) + 1 : 1;
                            paperData.push({ id: newId, title: cols[1] || '', author: cols[2] || '', journal: cols[3] || '', index: cols[4] || '', unit: cols[5] || '', publishDate: cols[6] || '', status: cols[7] || '审核中', remark: '', fileName: '' });
                            count++;
                        }
                    }
                    savePaperData(); updatePaperFilterCounts(); applyPaperFilters();
                    alert(`成功导入 ${count} 条记录`);
                };
                reader.readAsText(file, 'UTF-8');
            };
            input.click();
        }
        
        function viewPaperStats() {
            const total = paperData.length;
            const currentYear = new Date().getFullYear().toString();
            const thisYear = paperData.filter(d => d.publishDate && d.publishDate.startsWith(currentYear)).length;
            const approved = paperData.filter(d => d.status === '已通过').length;
            const reviewing = paperData.filter(d => d.status === '审核中').length;
            const rejected = paperData.filter(d => d.status === '已驳回').length;
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">论文数据统计</h3>
                <div style="line-height:2;font-size:15px;">
                    <p>总数：<strong>${total}</strong></p>
                    <p>当年发表：<strong>${thisYear}</strong></p>
                    <p>已通过：<strong style="color:#28a745;">${approved}</strong></p>
                    <p>审核中：<strong style="color:#ffc107;">${reviewing}</strong></p>
                    <p>已驳回：<strong style="color:#dc3545;">${rejected}</strong></p>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:20px;">
                    <button class="btn" onclick="this.closest('div[style*=fixed]').remove()">关闭</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        // ========== 标准专著管理模块 ==========
        
        var standardData = [];
        var filteredStandardData = [];
        var selectedStandardIds = new Set();
        var editingStandardId = null;
        var standardSortField = '';
        var standardSortOrder = 'asc';
        
        function initStandardData() {
            const saved = localStorage.getItem('standardData');
            if (saved) { standardData = JSON.parse(saved); }
            else { standardData = []; localStorage.setItem('standardData', JSON.stringify(standardData)); }
            filteredStandardData = [...standardData];
            updateStandardFilterCounts();
            renderStandardTable();
        }
        
        function saveStandardData() {
            localStorage.setItem('standardData', JSON.stringify(standardData));
        }
        
        function updateStandardFilterCounts() {
            const currentYear = new Date().getFullYear().toString();
            document.getElementById('standardCountAll').textContent = standardData.length;
            document.getElementById('standardCountCurrentYear').textContent = standardData.filter(d => d.publishDate && d.publishDate.startsWith(currentYear)).length;
            document.getElementById('standardCountReviewing').textContent = standardData.filter(d => d.status === '审核中').length;
            document.getElementById('standardCountApproved').textContent = standardData.filter(d => d.status === '已通过').length;
            document.getElementById('standardCountRejected').textContent = standardData.filter(d => d.status === '已驳回').length;
        }
        
        function renderStandardTable() {
            const tbody = document.getElementById('standardTableBody');
            const emptyMsg = document.getElementById('standardEmptyMessage');
            tbody.innerHTML = '';
            if (filteredStandardData.length === 0) { emptyMsg.style.display = 'block'; return; }
            emptyMsg.style.display = 'none';
            filteredStandardData.forEach(item => {
                const row = document.createElement('tr');
                let statusClass = 'tag-warning';
                if (item.status === '已通过') statusClass = 'tag-success';
                else if (item.status === '已驳回') statusClass = 'tag-danger';
                row.innerHTML = `
                    <td><input type="checkbox" ${selectedStandardIds.has(item.id) ? 'checked' : ''} onchange="toggleStandardSelect(${item.id}, this)"></td>
                    <td>${item.publishDate ? item.publishDate.substring(0, 4) : '-'}</td>
                    <td>${item.standardNumber || '-'}</td>
                    <td>${item.name}</td>
                    <td>${item.type || '-'}</td>
                    <td>${item.author || '-'}</td>
                    <td>${item.unit || '-'}</td>
                    <td>${item.publishDate || '-'}</td>
                    <td><span class="tag ${statusClass}">${item.status}</span></td>
                    <td>
                        <button class="btn" style="padding: 4px 10px; font-size: 12px; margin-right: 5px;" onclick="editStandard(${item.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="deleteStandard(${item.id})">删除</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
        
        function showAddStandardModal() {
            editingStandardId = null;
            document.getElementById('standardModalTitle').textContent = '新增标准/专著';
            document.getElementById('standardName').value = '';
            document.getElementById('standardNumber').value = '';
            document.getElementById('standardAuthor').value = '';
            document.getElementById('standardUnit').value = '';
            document.getElementById('standardType').value = '';
            document.getElementById('standardPublishDate').value = '';
            document.getElementById('standardStatus').value = '审核中';
            document.getElementById('standardFile').value = '';
            document.getElementById('standardRemark').value = '';
            document.getElementById('standardModal').style.display = 'flex';
        }
        
        function closeStandardModal() {
            document.getElementById('standardModal').style.display = 'none';
        }
        
        function saveStandard() {
            const name = document.getElementById('standardName').value.trim();
            const standardNumber = document.getElementById('standardNumber').value.trim();
            const author = document.getElementById('standardAuthor').value.trim();
            const unit = document.getElementById('standardUnit').value.trim();
            const type = document.getElementById('standardType').value;
            const publishDate = document.getElementById('standardPublishDate').value;
            const status = document.getElementById('standardStatus').value;
            const remark = document.getElementById('standardRemark').value.trim();
            if (!name || !standardNumber || !author || !unit || !type || !publishDate) {
                alert('请填写所有必填字段');
                return;
            }
            if (editingStandardId) {
                const idx = standardData.findIndex(d => d.id === editingStandardId);
                if (idx !== -1) standardData[idx] = { ...standardData[idx], name, standardNumber, author, unit, type, publishDate, status, remark };
            } else {
                const newId = standardData.length > 0 ? Math.max(...standardData.map(d => d.id)) + 1 : 1;
                standardData.push({ id: newId, name, standardNumber, author, unit, type, publishDate, status, remark, fileName: '' });
            }
            saveStandardData();
            updateStandardFilterCounts();
            applyStandardFilters();
            closeStandardModal();
            alert('保存成功！');
            try {
                if (typeof offerNewsDraftFromAchievement === 'function') {
                    setTimeout(function () {
                        offerNewsDraftFromAchievement({
                            title: '标准/专著：' + name,
                            summary: author + ' 《' + name + '》（' + standardNumber + '）',
                            content: '<h2>标准/专著</h2><p><strong>名称：</strong>' + name + '</p><p><strong>编号：</strong>' + standardNumber + '</p><p><strong>作者：</strong>' + author + '</p>',
                            tags: ['标准', '专著']
                        });
                    }, 200);
                }
            } catch (eNews) {}
        }
        
        function editStandard(id) {
            const item = standardData.find(d => d.id === id);
            if (!item) return;
            editingStandardId = id;
            document.getElementById('standardModalTitle').textContent = '编辑标准/专著';
            document.getElementById('standardName').value = item.name;
            document.getElementById('standardNumber').value = item.standardNumber;
            document.getElementById('standardAuthor').value = item.author;
            document.getElementById('standardUnit').value = item.unit;
            document.getElementById('standardType').value = item.type;
            document.getElementById('standardPublishDate').value = item.publishDate;
            document.getElementById('standardStatus').value = item.status;
            document.getElementById('standardRemark').value = item.remark || '';
            document.getElementById('standardModal').style.display = 'flex';
        }
        
        function deleteStandard(id) {
            if (!confirm('确定要删除这条记录吗？')) return;
            standardData = standardData.filter(d => d.id !== id);
            selectedStandardIds.delete(id);
            saveStandardData();
            updateStandardFilterCounts();
            applyStandardFilters();
        }
        
        function toggleStandardSelectAll(checkbox) {
            if (checkbox.checked) filteredStandardData.forEach(d => selectedStandardIds.add(d.id));
            else selectedStandardIds.clear();
            renderStandardTable();
        }
        
        function toggleStandardSelect(id, checkbox) {
            if (checkbox.checked) selectedStandardIds.add(id);
            else selectedStandardIds.delete(id);
        }
        
        function filterStandardByTag(tag, element) {
            document.querySelectorAll('#standardFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            const currentYear = new Date().getFullYear().toString();
            switch(tag) {
                case 'all': filteredStandardData = [...standardData]; break;
                case 'current_year': filteredStandardData = standardData.filter(d => d.publishDate && d.publishDate.startsWith(currentYear)); break;
                case 'reviewing': filteredStandardData = standardData.filter(d => d.status === '审核中'); break;
                case 'approved': filteredStandardData = standardData.filter(d => d.status === '已通过'); break;
                case 'rejected': filteredStandardData = standardData.filter(d => d.status === '已驳回'); break;
            }
            renderStandardTable();
        }
        
        function toggleStandardMoreFilters() {
            const el = document.getElementById('standardMoreFilters');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }
        
        function applyStandardFilters() {
            const name = document.getElementById('standardFilterName').value.trim().toLowerCase();
            const standardNumber = document.getElementById('standardFilterNumber').value.trim().toLowerCase();
            const author = document.getElementById('standardFilterAuthor').value.trim().toLowerCase();
            const year = document.getElementById('standardFilterYear').value;
            const status = document.getElementById('standardFilterStatus').value;
            const type = document.getElementById('standardFilterType').value;
            const unit = document.getElementById('standardFilterUnit').value.trim().toLowerCase();
            const dateFrom = document.getElementById('standardFilterDateFrom').value;
            const dateTo = document.getElementById('standardFilterDateTo').value;
            filteredStandardData = standardData.filter(d => {
                if (name && !d.name.toLowerCase().includes(name)) return false;
                if (standardNumber && !d.standardNumber.toLowerCase().includes(standardNumber)) return false;
                if (author && !d.author.toLowerCase().includes(author)) return false;
                if (year && (!d.publishDate || !d.publishDate.startsWith(year))) return false;
                if (status && d.status !== status) return false;
                if (type && d.type !== type) return false;
                if (unit && (!d.unit || !d.unit.toLowerCase().includes(unit))) return false;
                if (dateFrom && (!d.publishDate || d.publishDate < dateFrom)) return false;
                if (dateTo && (!d.publishDate || d.publishDate > dateTo)) return false;
                return true;
            });
            renderStandardTable();
        }
        
        function resetStandardFilters() {
            document.getElementById('standardFilterName').value = '';
            document.getElementById('standardFilterNumber').value = '';
            document.getElementById('standardFilterAuthor').value = '';
            document.getElementById('standardFilterYear').value = '';
            document.getElementById('standardFilterStatus').value = '';
            document.getElementById('standardFilterType').value = '';
            document.getElementById('standardFilterUnit').value = '';
            document.getElementById('standardFilterDateFrom').value = '';
            document.getElementById('standardFilterDateTo').value = '';
            document.getElementById('standardMoreFilters').style.display = 'none';
            document.querySelectorAll('#standardFilterTags .filter-tag').forEach(t => t.classList.remove('active'));
            document.querySelector('#standardFilterTags .filter-tag').classList.add('active');
            filteredStandardData = [...standardData];
            renderStandardTable();
        }
        
        function sortStandardTable(field) {
            if (standardSortField === field) standardSortOrder = standardSortOrder === 'asc' ? 'desc' : 'asc';
            else { standardSortField = field; standardSortOrder = 'asc'; }
            filteredStandardData.sort((a, b) => {
                let valA = a[field] || ''; let valB = b[field] || '';
                if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
                if (valA < valB) return standardSortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return standardSortOrder === 'asc' ? 1 : -1;
                return 0;
            });
            renderStandardTable();
        }
        
        function batchDeleteStandards() {
            if (selectedStandardIds.size === 0) { alert('请先选择要删除的记录'); return; }
            if (!confirm(`确定要删除选中的 ${selectedStandardIds.size} 条记录吗？`)) return;
            standardData = standardData.filter(d => !selectedStandardIds.has(d.id));
            selectedStandardIds.clear();
            saveStandardData();
            updateStandardFilterCounts();
            applyStandardFilters();
        }
        
        function batchAuditStandards() {
            if (selectedStandardIds.size === 0) { alert('请先选择要审核的记录'); return; }
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">批量审核</h3>
                <div class="form-group"><label>新状态</label>
                    <select id="batchAuditStandardStatusSelect" class="form-control">
                        <option value="审核中">审核中</option><option value="已通过">已通过</option><option value="已驳回">已驳回</option>
                    </select>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">取消</button>
                    <button class="btn" onclick="confirmBatchAuditStandards(this)">确定</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        function confirmBatchAuditStandards(btn) {
            const newStatus = document.getElementById('batchAuditStandardStatusSelect').value;
            standardData.forEach(d => { if (selectedStandardIds.has(d.id)) d.status = newStatus; });
            selectedStandardIds.clear();
            saveStandardData();
            updateStandardFilterCounts();
            applyStandardFilters();
            btn.closest('div[style*="fixed"]').remove();
            alert('批量审核完成！');
        }
        
        function exportStandards() {
            if (filteredStandardData.length === 0) { alert('没有可导出的数据'); return; }
            let csv = '\ufeff所属年度,标准编号/ISBN,名称,类型,起草人/作者,所属单位,发布日期,状态\n';
            filteredStandardData.forEach(d => {
                csv += `${d.publishDate ? d.publishDate.substring(0,4) : ''},${d.standardNumber},${d.name},${d.type},${d.author},${d.unit},${d.publishDate},${d.status}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '标准专著数据_' + new Date().toISOString().slice(0,10) + '.csv';
            link.click();
        }
        
        function importStandards() {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.csv';
            input.onchange = function(e) {
                const file = e.target.files[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 8) {
                            const newId = standardData.length > 0 ? Math.max(...standardData.map(d => d.id)) + 1 : 1;
                            standardData.push({ id: newId, name: cols[2] || '', standardNumber: cols[1] || '', type: cols[3] || '', author: cols[4] || '', unit: cols[5] || '', publishDate: cols[6] || '', status: cols[7] || '审核中', remark: '', fileName: '' });
                            count++;
                        }
                    }
                    saveStandardData(); updateStandardFilterCounts(); applyStandardFilters();
                    alert(`成功导入 ${count} 条记录`);
                };
                reader.readAsText(file, 'UTF-8');
            };
            input.click();
        }
        
        function viewStandardStats() {
            const total = standardData.length;
            const currentYear = new Date().getFullYear().toString();
            const thisYear = standardData.filter(d => d.publishDate && d.publishDate.startsWith(currentYear)).length;
            const approved = standardData.filter(d => d.status === '已通过').length;
            const reviewing = standardData.filter(d => d.status === '审核中').length;
            const rejected = standardData.filter(d => d.status === '已驳回').length;
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
            modal.innerHTML = `<div style="background:#fff;padding:30px;border-radius:12px;width:400px;">
                <h3 style="margin-bottom:20px;color:#333;">标准专著统计</h3>
                <div style="line-height:2;font-size:15px;">
                    <p>总数：<strong>${total}</strong></p>
                    <p>当年发布：<strong>${thisYear}</strong></p>
                    <p>已通过：<strong style="color:#28a745;">${approved}</strong></p>
                    <p>审核中：<strong style="color:#ffc107;">${reviewing}</strong></p>
                    <p>已驳回：<strong style="color:#dc3545;">${rejected}</strong></p>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:20px;">
                    <button class="btn" onclick="this.closest('div[style*=fixed]').remove()">关闭</button>
                </div></div>`;
            document.body.appendChild(modal);
            modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        }
        
        // ========== 软著管理模块 ==========
        function renderChart(chartConfig) {
            const chartsSection = document.getElementById('chartsSection');
            const chartsContainer = document.getElementById('chartsContainer');
            
            if (!chartsSection || !chartsContainer) return;
            
            // 显示图表区域
            chartsSection.style.display = 'block';
            
            // 创建图表容器
            const chartId = 'chart_' + Date.now();
            const chartDiv = document.createElement('div');
            chartDiv.className = 'chart-container';
            chartDiv.id = chartId;
            chartDiv.style.display = 'inline-block';
            chartDiv.style.verticalAlign = 'top';
            chartDiv.style.position = 'relative';
            
            // 添加关闭按钮
            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = '✕';
            closeBtn.onclick = function() { closeChart(chartDiv); };
            closeBtn.style.cssText = `
                position: absolute;
                top: 10px;
                right: 10px;
                z-index: 1000;
                background: rgba(255, 0, 0, 0.8);
                color: white;
                border: none;
                border-radius: 50%;
                width: 32px;
                height: 32px;
                font-size: 18px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.3s;
            `;
            closeBtn.onmouseover = function() {
                this.style.background = 'rgba(255, 0, 0, 1)';
                this.style.transform = 'scale(1.1)';
            };
            closeBtn.onmouseout = function() {
                this.style.background = 'rgba(255, 0, 0, 0.8)';
                this.style.transform = 'scale(1)';
            };
            
            chartDiv.appendChild(closeBtn);
            
            chartsContainer.appendChild(chartDiv);
            
            // 初始化 ECharts
            const chart = echarts.init(chartDiv);
            
            // 配置图表
            const option = {
                title: {
                    text: chartConfig.title || '数据图表',
                    left: 'center'
                },
                tooltip: {
                    trigger: 'axis'
                },
                legend: {
                    data: chartConfig.series ? chartConfig.series.map(s => s.name) : [],
                    top: '10%'
                },
                xAxis: chartConfig.xAxis || {},
                yAxis: chartConfig.yAxis || {},
                series: chartConfig.series || [],
                ...chartConfig.otherConfig
            };
            
            chart.setOption(option);
            
            // 响应式调整
            window.addEventListener('resize', () => {
                chart.resize();
            });
            
            // 滚动到图表区域
            chartsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            
            // 更新滑动按钮显示
            updateScrollButtons();
        }
        
        // 关闭单个图表
        function closeChart(chartDiv) {
            chartDiv.remove();
            
            // 检查是否还有图表
            const chartsContainer = document.getElementById('chartsContainer');
            const remainingCharts = chartsContainer.querySelectorAll('.chart-container');
            if (remainingCharts.length === 0) {
                const chartsSection = document.getElementById('chartsSection');
                if (chartsSection) {
                    chartsSection.style.display = 'none';
                }
            }
            
            // 更新滑动按钮
            updateScrollButtons();
        }
        
        // 关闭所有图表
        function closeAllCharts() {
            const chartsContainer = document.getElementById('chartsContainer');
            const chartsSection = document.getElementById('chartsSection');
            
            if (chartsContainer) {
                chartsContainer.innerHTML = '';
            }
            
            if (chartsSection) {
                chartsSection.style.display = 'none';
            }
        }
        
        // 更新滑动按钮显示
        function updateScrollButtons() {
            const wrapper = document.getElementById('chartsContainerWrapper');
            const container = document.getElementById('chartsContainer');
            const leftBtn = document.getElementById('scrollLeftBtn');
            const rightBtn = document.getElementById('scrollRightBtn');
            
            if (!wrapper || !container || !leftBtn || !rightBtn) return;
            
            const scrollWidth = wrapper.scrollWidth;
            const clientWidth = wrapper.clientWidth;
            const scrollLeft = wrapper.scrollLeft;
            
            // 只有当内容超出容器时才显示按钮
            if (scrollWidth > clientWidth) {
                // 左按钮：当滚动到最左边时隐藏
                leftBtn.style.display = scrollLeft > 0 ? 'flex' : 'none';
                
                // 右按钮：当滚动到最右边时隐藏
                const canScrollRight = scrollWidth - scrollLeft - clientWidth > 10;
                rightBtn.style.display = canScrollRight ? 'flex' : 'none';
            } else {
                leftBtn.style.display = 'none';
                rightBtn.style.display = 'none';
            }
        }
        
        // 滑动图表
        function scrollCharts(direction) {
            const wrapper = document.getElementById('chartsContainerWrapper');
            if (!wrapper) return;
            
            const scrollAmount = 400; // 每次滑动的距离
            
            if (direction === 'left') {
                wrapper.scrollLeft -= scrollAmount;
            } else {
                wrapper.scrollLeft += scrollAmount;
            }
            
            // 滑动后更新按钮显示
            setTimeout(() => updateScrollButtons(), 300);
        }
        
        // 监听滚动事件，自动更新按钮显示
        document.addEventListener('DOMContentLoaded', function() {
            const wrapper = document.getElementById('chartsContainerWrapper');
            if (wrapper) {
                wrapper.addEventListener('scroll', function() {
                    updateScrollButtons();
                });
            }
        });
        
        // 显示状态消息
        function showStatusMessage(message, type = 'info') {
            const mergeResult = document.getElementById('mergeResult');
            if (!mergeResult) return;
            
            mergeResult.innerHTML = `<div class="status-message ${type}">${message}</div>`;
            
            // 如果是成功或错误消息，5 秒后自动消失
            if (type === 'success' || type === 'error') {
                setTimeout(() => {
                    const msgDiv = mergeResult.querySelector('.status-message');
                    if (msgDiv) {
                        msgDiv.style.opacity = '0';
                        msgDiv.style.transition = 'opacity 0.5s';
                        setTimeout(() => {
                            msgDiv.remove();
                        }, 500);
                    }
                }, 5000);
            }
        }
    
// onclick 兼容：保持全局可调用
window.showModule = showModule;
