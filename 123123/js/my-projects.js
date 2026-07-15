/**
 * 我的项目 — 视觉与交互对齐「科研创新服务平台」截图（一比一布局）。
 * 数据：longitudinalData / horizontalData / schoolData + researchProjectExtra
 */
(function (global) {
  'use strict';

  var PAGE_SIZE = 20;
  var state = {
    nature: '',
    role: '',
    life: '',
    year: '',
    page: 1,
    currentKey: '',
    editingKey: null,
    yearsCollapsed: false
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadArr(key) {
    try {
      var raw = localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveArr(key, arr) {
    localStorage.setItem(key, JSON.stringify(arr || []));
    try {
      if (typeof cloudUpsert === 'function') cloudUpsert(key, JSON.stringify(arr || []));
    } catch (e) {}
  }

  function loadExtra() {
    try {
      return JSON.parse(localStorage.getItem('researchProjectExtra') || '{}') || {};
    } catch (e) { return {}; }
  }

  function saveExtra(map) {
    localStorage.setItem('researchProjectExtra', JSON.stringify(map || {}));
    try {
      if (typeof cloudUpsert === 'function') cloudUpsert('researchProjectExtra', JSON.stringify(map || {}));
    } catch (e) {}
  }

  function currentUploader() {
    try {
      var u = global.currentUser;
      if (u) return u.realName || u.name || u.username || '当前用户';
    } catch (e) {}
    return '当前用户';
  }

  function nowStr() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function authHeaders(extra) {
    var h = Object.assign({}, extra || {});
    var cfg = global.APP_CONFIG || {};
    var token = cfg.DATASET_UPLOAD_TOKEN || cfg.ANNOTATION_UPLOAD_TOKEN || '';
    if (token) h['X-Upload-Token'] = token;
    return h;
  }

  function fileIconHtml(name) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    var label = ext === 'pdf' ? 'PDF' : (ext || 'F').slice(0, 3).toUpperCase();
    return '<span class="kx-file-ico' + (ext === 'pdf' ? ' pdf' : '') + '">' + esc(label) + '</span>';
  }

  function docLinkHtml(d) {
    var name = (d && (d.name || d.relativePath)) || '未命名';
    var href = d && d.serverFileId
      ? ('/api/shared-file/download?fileId=' + encodeURIComponent(d.serverFileId))
      : ((d && d.blobUrl) || '');
    var open = href
      ? ('<a class="kx-a" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(name) + '</a>')
      : ('<span>' + esc(name) + '</span>');
    return '<span class="kx-file-row">' + fileIconHtml(name) + open + '</span>';
  }

  function setUploadStatus(msg, kind) {
    var el = document.getElementById('mpUploadStatus');
    if (!el) return;
    el.className = 'kx-upload-status' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
  }

  async function mpUploadOneFile(file, remark) {
    var caps = null;
    try {
      var hr = await fetch('/api/shared-file/health');
      if (hr.ok) caps = await hr.json();
    } catch (e) { caps = null; }

    if (caps && caps.ok) {
      var PRESIGN_THRESHOLD = 8 * 1024 * 1024;
      if (caps.presignEnabled && file.size >= PRESIGN_THRESHOLD) {
        try {
          var preResp = await fetch('/api/shared-file/presign', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              fileName: file.name,
              originalName: file.name,
              fileType: 'project_doc',
              remark: remark || '',
              size: file.size,
              contentType: file.type || 'application/octet-stream'
            })
          });
          var pre = await preResp.json().catch(function () { return {}; });
          if (preResp.ok && pre.ok && pre.uploadUrl) {
            var putResp = await fetch(pre.uploadUrl, {
              method: pre.method || 'PUT',
              headers: Object.assign({}, pre.headers || {}),
              body: file
            });
            if (!putResp.ok) throw new Error('直传失败 HTTP ' + putResp.status);
            var confResp = await fetch('/api/shared-file/confirm', {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ fileId: pre.fileId, size: file.size })
            });
            var conf = await confResp.json().catch(function () { return {}; });
            if (!confResp.ok || !conf.ok) throw new Error((conf && conf.error) || '确认失败');
            return {
              name: file.name,
              relativePath: file.webkitRelativePath || file.name,
              size: file.size,
              serverFileId: conf.fileId || pre.fileId,
              uploader: currentUploader(),
              time: nowStr()
            };
          }
        } catch (ePre) {
          console.warn('[my-projects] presign fallback', ePre);
        }
      }

      var fd = new FormData();
      fd.append('file', file);
      fd.append('fileName', file.name);
      fd.append('fileType', 'project_doc');
      fd.append('remark', remark || '');
      var resp = await fetch('/api/shared-file/upload', {
        method: 'POST',
        headers: authHeaders(),
        body: fd
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data.ok) throw new Error((data && data.error) || '上传失败');
      return {
        name: file.name,
        relativePath: file.webkitRelativePath || file.name,
        size: file.size,
        serverFileId: data.fileId || data.id,
        uploader: currentUploader(),
        time: nowStr()
      };
    }

    var blobUrl = '';
    try { blobUrl = URL.createObjectURL(file); } catch (e2) {}
    return {
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      size: file.size,
      serverFileId: '',
      blobUrl: blobUrl,
      localOnly: true,
      uploader: currentUploader(),
      time: nowStr()
    };
  }

  function persistExtraPatch(key, patch) {
    var extraMap = loadExtra();
    extraMap[key] = Object.assign({}, extraMap[key] || {}, patch);
    saveExtra(extraMap);
  }

  function listFromFileList(fileList) {
    var files = [];
    for (var i = 0; i < (fileList || []).length; i++) {
      var f = fileList[i];
      if (!f || !f.size) continue;
      var rel = f.webkitRelativePath || f.name || '';
      if (/(^|\/|\\)\.DS_Store$|(^|\/|\\)Thumbs\.db$/i.test(rel)) continue;
      files.push(f);
    }
    return files;
  }

  async function mpIngestFiles(fileList, opts) {
    opts = opts || {};
    var key = state.currentKey;
    if (!key) { alert('请先打开项目'); return; }
    var files = listFromFileList(fileList);
    if (!files.length) {
      alert('未选到有效文件（空文件夹或仅含系统文件）');
      return;
    }

    var p = findByKey(key);
    if (!p) return;
    var docs = (p.documents || []).slice();
    var remark = '项目文档|' + (p.projectNumber || '') + '|' + (p.name || '');
    var ok = 0;
    var fail = 0;
    var taskBookSet = false;
    setUploadStatus('正在上传 0/' + files.length + ' …', 'busy');

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      setUploadStatus('正在上传 ' + (i + 1) + '/' + files.length + '：' + file.name, 'busy');
      try {
        var meta = await mpUploadOneFile(file, remark);
        var displayName = opts.keepRelative && meta.relativePath ? meta.relativePath : meta.name;
        docs.push({
          name: displayName,
          uploader: meta.uploader,
          time: meta.time,
          size: meta.size,
          serverFileId: meta.serverFileId || '',
          blobUrl: meta.blobUrl || '',
          localOnly: !!meta.localOnly
        });
        ok++;

        if (opts.asTaskBook && !taskBookSet) {
          var isBook = /\.(pdf|docx?|wps)$/i.test(file.name) || files.length === 1;
          if (isBook) {
            persistExtraPatch(key, {
              taskBookName: meta.name,
              taskBookFileId: meta.serverFileId || '',
              taskBookBlobUrl: meta.blobUrl || ''
            });
            try {
              var arr = loadArr(p._store);
              var idx = arr.findIndex(function (d) { return Number(d.id) === Number(p.id); });
              if (idx >= 0) {
                arr[idx].fileName = meta.name;
                saveArr(p._store, arr);
              }
            } catch (eSync) {}
            taskBookSet = true;
          }
        }
        if (opts.asAgreement && i === 0) {
          persistExtraPatch(key, {
            agreementName: meta.name,
            agreementFileId: meta.serverFileId || '',
            agreementBlobUrl: meta.blobUrl || ''
          });
        }
      } catch (err) {
        fail++;
        console.warn('[my-projects] upload fail', file.name, err);
      }
    }

    persistExtraPatch(key, { documents: docs });

    var msg = '完成：成功 ' + ok + ' 个' + (fail ? '，失败 ' + fail + ' 个' : '');
    if (ok) {
      var recent = docs.slice(-ok);
      if (recent.some(function (d) { return d.localOnly; })) {
        msg += '（存储服务未就绪，仅本地登记）';
      }
    }
    setUploadStatus(msg, fail ? 'err' : 'ok');
    mpSwitchTab(opts.refreshTab || 'docs');
  }

  function mpPickDocs(mode) {
    if (!state.currentKey) { alert('请先打开项目'); return; }
    var input;
    function bind(el, ingestOpts) {
      if (!el) return;
      el.onchange = function () {
        var list = el.files;
        el.value = '';
        mpIngestFiles(list, ingestOpts);
      };
      el.click();
    }
    if (mode === 'folder') {
      bind(document.getElementById('mpFolderInput'), { keepRelative: true, refreshTab: 'docs' });
      return;
    }
    if (mode === 'taskbook') {
      bind(document.getElementById('mpTaskBookInput'), { asTaskBook: true, refreshTab: 'info' });
      return;
    }
    if (mode === 'taskbook-folder') {
      bind(document.getElementById('mpFolderInput'), { asTaskBook: true, keepRelative: true, refreshTab: 'info' });
      return;
    }
    if (mode === 'agreement') {
      bind(document.getElementById('mpAgreeInput'), { asAgreement: true, refreshTab: 'info' });
      return;
    }
    bind(document.getElementById('mpFileInput'), { refreshTab: 'docs' });
  }

  function mpRemoveDoc(idx) {
    var key = state.currentKey;
    var p = findByKey(key);
    if (!p) return;
    if (!confirm('确定从项目文档中移除该文件记录？')) return;
    var docs = (p.documents || []).slice();
    if (idx < 0 || idx >= docs.length) return;
    docs.splice(idx, 1);
    persistExtraPatch(key, { documents: docs });
    mpSwitchTab('docs');
  }

  function mpOpenDoc(idx) {
    var p = findByKey(state.currentKey);
    if (!p || !p.documents || !p.documents[idx]) return;
    var d = p.documents[idx];
    if (d.serverFileId) {
      window.open('/api/shared-file/download?fileId=' + encodeURIComponent(d.serverFileId), '_blank');
      return;
    }
    if (d.blobUrl) {
      window.open(d.blobUrl, '_blank');
      return;
    }
    alert('该文件暂无可下载地址');
  }

  function storeKey(nature) {
    if (nature === '横向') return 'horizontalData';
    if (nature === '校级') return 'schoolData';
    return 'longitudinalData';
  }

  function itemKey(nature, id) {
    return nature + ':' + id;
  }

  function normalizeLife(item, extra) {
    var life = (extra && extra.lifeStatus) || item.lifeStatus || '';
    if (life) return life;
    var st = String(item.status || '') + ' ' + String(item.remark || '');
    if (/结题/.test(st)) return '结题';
    if (/完成|已结|结项/.test(st)) return '完成';
    if (item.status === '已驳回') return '完成';
    return '进行';
  }

  function normalizeAudit(item, extra) {
    var a = (extra && extra.auditStatus) || item.auditStatus || '';
    if (a) return a;
    if (item.status === '审核中' || item.status === '已驳回' || item.status === '已通过') return item.status;
    return '学校通过';
  }

  function normalizeRole(item, extra) {
    return (extra && extra.roleType) || item.roleType || '主持';
  }

  function yearOf(item) {
    var d = item.startDate || item.approvalDate || '';
    var m = String(d).match(/(20\d{2}|19\d{2})/);
    return m ? m[1] : '其他';
  }

  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0.00';
    return n.toFixed(2);
  }

  function money1(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0.0';
    return n.toFixed(1);
  }

  function unifyOne(raw, nature) {
    var key = itemKey(nature, raw.id);
    var extra = loadExtra()[key] || {};
    return Object.assign({}, raw, {
      _key: key,
      _nature: nature,
      _store: storeKey(nature),
      projectNumber: raw.projectNumber || raw.number || '',
      name: raw.name || '',
      leader: raw.leader || '',
      unit: raw.unit || '',
      level: raw.level || raw.type || raw.company || '',
      startDate: raw.startDate || '',
      endDate: extra.endDate || raw.endDate || '',
      actualEndDate: extra.actualEndDate || '',
      funding: raw.funding != null ? raw.funding : '',
      outFunding: extra.outFunding != null ? extra.outFunding : (raw.outFunding || 0),
      matchFunding: extra.matchFunding != null ? extra.matchFunding : (raw.matchFunding || 0),
      roleType: normalizeRole(raw, extra),
      lifeStatus: normalizeLife(raw, extra),
      auditStatus: normalizeAudit(raw, extra),
      sourceOrg: extra.sourceOrg || raw.sourceOrg || '',
      partner: extra.partner || raw.partner || '无',
      discipline: extra.discipline || '自然科学',
      leaderType: extra.leaderType || '教师',
      categoryName: extra.categoryName || (nature === '纵向' ? '其他省部级政府科研项目' : nature === '横向' ? '横向委托项目' : '校级项目'),
      systemNo: extra.systemNo || raw.projectNumber || '',
      platform: extra.platform || '',
      direction: extra.direction || '',
      financeNo: extra.financeNo || '',
      taskBookName: extra.taskBookName || raw.fileName || '',
      taskBookFileId: extra.taskBookFileId || '',
      taskBookBlobUrl: extra.taskBookBlobUrl || '',
      agreementName: extra.agreementName || '',
      agreementFileId: extra.agreementFileId || '',
      agreementBlobUrl: extra.agreementBlobUrl || '',
      members: Array.isArray(extra.members) ? extra.members : defaultMembers(raw),
      budget: Array.isArray(extra.budget) ? extra.budget : defaultBudget(raw),
      fundCards: Array.isArray(extra.fundCards) ? extra.fundCards : [],
      incomes: Array.isArray(extra.incomes) ? extra.incomes : [],
      expenses: Array.isArray(extra.expenses) ? extra.expenses : [],
      outsources: Array.isArray(extra.outsources) ? extra.outsources : [],
      documents: Array.isArray(extra.documents) ? extra.documents : defaultDocs(raw),
      outcomes: Array.isArray(extra.outcomes) ? extra.outcomes : [],
      process: Array.isArray(extra.process) ? extra.process : defaultProcess(raw),
      remark: raw.remark || extra.remark || ''
    });
  }

  function defaultMembers(raw) {
    return [{
      order: 1, type: '教师', name: raw.leader || '负责人', unit: raw.unit || '',
      title: '', degree: '', duty: '负责人', contribution: 100
    }];
  }

  function defaultBudget(raw) {
    var fund = Number(raw.funding) || 0;
    if (!fund) return [];
    return [
      { subject: '直接费用', amount: (fund * 0.7).toFixed(2) },
      { subject: '间接费用', amount: (fund * 0.3).toFixed(2) }
    ];
  }

  function defaultDocs(raw) {
    if (!raw.fileName && !raw.taskBookName) return [];
    return [{
      name: raw.taskBookName || raw.fileName || '任务书.pdf',
      uploader: raw.leader || '-',
      time: (raw.startDate || '') + (raw.startDate ? ' 00:00:00' : '')
    }];
  }

  function defaultProcess(raw) {
    if (!raw.startDate) return [];
    return [{ time: raw.startDate, event: '立项获批', note: '项目进入执行' }];
  }

  function allProjects() {
    var list = [];
    loadArr('longitudinalData').forEach(function (d) { list.push(unifyOne(d, '纵向')); });
    loadArr('horizontalData').forEach(function (d) { list.push(unifyOne(d, '横向')); });
    loadArr('schoolData').forEach(function (d) { list.push(unifyOne(d, '校级')); });
    list.sort(function (a, b) {
      return String(b.startDate || '').localeCompare(String(a.startDate || ''));
    });
    return list;
  }

  function filteredProjects() {
    return allProjects().filter(function (p) {
      if (state.nature && p._nature !== state.nature) return false;
      if (state.role && p.roleType !== state.role) return false;
      if (state.life && p.lifeStatus !== state.life) return false;
      if (state.year && yearOf(p) !== state.year) return false;
      return true;
    });
  }

  function syncSideActive() {
    document.querySelectorAll('#mpSide [data-mp-nature]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-mp-nature') === state.nature && !!state.nature);
    });
    document.querySelectorAll('#mpSide [data-mp-role]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-mp-role') === state.role && !!state.role);
    });
    document.querySelectorAll('#mpSide [data-mp-life]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-mp-life') === state.life && !!state.life);
    });
  }

  function mpSetFilter(kind, value, el) {
    // 再次点击同一项 → 取消筛选（截图侧栏无“全部”，用二次点击清空）
    if (kind === 'nature') state.nature = (state.nature === value ? '' : value);
    if (kind === 'role') state.role = (state.role === value ? '' : value);
    if (kind === 'life') state.life = (state.life === value ? '' : value);
    if (kind === 'year') state.year = (state.year === value ? '' : value);
    state.page = 1;
    mpRender();
  }

  function mpResetFilters() {
    state.nature = state.role = state.life = state.year = '';
    state.page = 1;
    mpRender();
  }

  function mpToggleYears() {
    state.yearsCollapsed = !state.yearsCollapsed;
    var box = document.getElementById('mpYearList');
    if (box) box.style.display = state.yearsCollapsed ? 'none' : '';
  }

  function mpSetSubNav(el, name) {
    document.querySelectorAll('.kx-subnav-item').forEach(function (a) { a.classList.remove('active'); });
    if (el) el.classList.add('active');
    if (name === '立项') {
      state.life = '';
    } else if (name === '结项') {
      state.life = '结题';
    } else if (name === '中检') {
      state.life = '进行';
    }
    state.page = 1;
    mpRender();
  }

  function updateSideCounts(all) {
    function set(id, n) {
      var el = document.getElementById(id);
      if (el) el.textContent = String(n);
    }
    set('mpCntNature纵', all.filter(function (p) { return p._nature === '纵向'; }).length);
    set('mpCntNature横', all.filter(function (p) { return p._nature === '横向'; }).length);
    set('mpCntNature校', all.filter(function (p) { return p._nature === '校级'; }).length);
    set('mpCntRoleHost', all.filter(function (p) { return p.roleType === '主持'; }).length);
    set('mpCntRoleJoin', all.filter(function (p) { return p.roleType === '参与'; }).length);
    set('mpCntLifeRun', all.filter(function (p) { return p.lifeStatus === '进行'; }).length);
    set('mpCntLifeDone', all.filter(function (p) { return p.lifeStatus === '完成'; }).length);
    set('mpCntLifeClose', all.filter(function (p) { return p.lifeStatus === '结题'; }).length);

    var yearMap = {};
    all.forEach(function (p) {
      var y = yearOf(p);
      yearMap[y] = (yearMap[y] || 0) + 1;
    });
    // 截图：升序（早年在上，近年在下）
    var years = Object.keys(yearMap).filter(function (y) { return y !== '其他'; })
      .sort(function (a, b) { return Number(a) - Number(b); });
    if (yearMap['其他']) years.push('其他');

    var box = document.getElementById('mpYearList');
    if (!box) return;
    box.innerHTML = years.map(function (y) {
      var active = state.year === y ? ' active' : '';
      return '<a href="javascript:void(0)" class="kx-side-a' + active + '" data-mp-year="' + esc(y) + '"' +
        ' onclick="mpSetFilter(\'year\',\'' + esc(y) + '\',this)">' + esc(y) +
        '<span class="kx-badge">' + yearMap[y] + '</span></a>';
    }).join('');
    if (state.yearsCollapsed) box.style.display = 'none';
  }

  function opsHtml(p) {
    var k = esc(p._key);
    return '<div class="kx-ops">' +
      '<a class="kx-a" href="javascript:void(0)" data-mp-act="finance" data-mp-key="' + k + '">录入财务账号</a>' +
      '<a class="kx-a" href="javascript:void(0)" data-mp-act="info" data-mp-key="' + k + '">项目变更</a>' +
      '<a class="kx-a" href="javascript:void(0)" data-mp-act="process" data-mp-key="' + k + '">中检</a>' +
      '<a class="kx-a" href="javascript:void(0)" data-mp-act="docs" data-mp-key="' + k + '">结项</a>' +
      '<a class="kx-a" href="javascript:void(0)" data-mp-act="docs" data-mp-key="' + k + '">文档+</a>' +
      '<a class="kx-a" href="javascript:void(0)" data-mp-act="audit" data-mp-key="' + k + '">历史变更</a>' +
      '</div>';
  }

  function mpRender() {
    hoistMpModals();
    bindMpTableClicks();
    var all = allProjects();
    updateSideCounts(all);
    syncSideActive();
    var list = filteredProjects();
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var pageRows = list.slice(start, start + PAGE_SIZE);
    var tbody = document.getElementById('mpTableBody');
    var empty = document.getElementById('mpEmpty');
    if (!tbody) return;

    if (!pageRows.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      tbody.innerHTML = pageRows.map(function (p) {
        var k = esc(p._key);
        return '<tr>' +
          '<td>' + esc(p.projectNumber || '-') + '</td>' +
          '<td><a class="kx-a" href="javascript:void(0)" data-mp-act="view" data-mp-key="' + k + '">' + esc(p.name || '-') + '</a></td>' +
          '<td>' + esc(p.leader || '-') + '</td>' +
          '<td>' + money(p.funding) + '</td>' +
          '<td>' + esc(p.startDate || '-') + '</td>' +
          '<td>' + esc(p.unit || '-') + '</td>' +
          '<td><a class="kx-a" href="javascript:void(0)" data-mp-act="audit" data-mp-key="' + k + '">' + esc(p.auditStatus || '-') + '</a></td>' +
          '<td>' + opsHtml(p) + '</td>' +
          '</tr>';
      }).join('');
    }

    var pager = document.getElementById('mpPager');
    if (pager) {
      pager.innerHTML = '共 ' + pages + ' 页 每页 ' + PAGE_SIZE + ' 条 共 ' + total + ' 条记录' +
        ' <button type="button" ' + (state.page <= 1 ? 'disabled' : '') + ' onclick="mpGotoPage(' + (state.page - 1) + ')">上一页</button>' +
        '<button type="button" ' + (state.page >= pages ? 'disabled' : '') + ' onclick="mpGotoPage(' + (state.page + 1) + ')">下一页</button>';
    }
  }

  function mpGotoPage(p) {
    state.page = Math.max(1, p);
    mpRender();
  }

  function ensureMpViewModal() {
    var modal = document.getElementById('mpViewModal');
    if (modal) return modal;
    // 兜底：HTML 缺失时现场创建，避免再弹「未加载」
    modal = document.createElement('div');
    modal.id = 'mpViewModal';
    modal.className = 'kx-mask';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:20000;align-items:center;justify-content:center;padding:20px;';
    modal.onclick = function (e) { if (e.target === modal) mpCloseView(); };
    modal.innerHTML =
      '<div class="kx-dlg" style="background:#fff;width:min(1080px,96vw);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 28px rgba(0,0,0,.28);border:1px solid #bbb;">' +
      '<div class="kx-dlg-hd" style="background:#1e7ad6;color:#fff;height:40px;padding:0 14px;display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:600;">' +
      '<span>项目查看</span><button type="button" class="kx-dlg-x" onclick="mpCloseView()" style="border:none;background:transparent;color:#fff;font-size:22px;cursor:pointer;">×</button></div>' +
      '<div class="kx-dlg-tabs" style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e0e0e0;background:#f7f9fc;min-height:38px;">' +
      '<div class="kx-dlg-tabs-l" id="mpTabs" style="display:flex;overflow-x:auto;flex:1;">' +
      ['info:项目信息', 'members:项目成员', 'budget:项目预算', 'fundcard:经费卡', 'income:经费到账', 'expense:经费报销', 'outsource:经费外拨', 'docs:项目文档', 'outcomes:衍生成果', 'process:执行过程'].map(function (pair, i) {
        var parts = pair.split(':');
        return '<a href="javascript:void(0)" class="kx-tab' + (i === 0 ? ' active' : '') + '" data-tab="' + parts[0] + '" onclick="mpSwitchTab(\'' + parts[0] + '\',this)" style="display:inline-block;padding:10px 12px;color:' + (i === 0 ? '#1e7ad6' : '#555') + ';text-decoration:none;font-size:13px;white-space:nowrap;border-bottom:2px solid ' + (i === 0 ? '#1e7ad6' : 'transparent') + ';">' + parts[1] + '</a>';
      }).join('') +
      '</div><a href="javascript:void(0)" class="kx-audit-link" onclick="mpShowAuditLog()" style="color:#1e7ad6;text-decoration:none;font-size:12px;padding:0 12px;">审核记录</a></div>' +
      '<div class="kx-dlg-bd" id="mpTabBody" style="padding:14px 16px;overflow:auto;flex:1;background:#fff;"></div>' +
      '<div class="kx-dlg-ft" style="padding:10px;border-top:1px solid #e8e8e8;display:flex;justify-content:center;background:#fafafa;">' +
      '<button type="button" class="kx-btn-primary" onclick="mpCloseView()" style="min-width:88px;height:32px;border:none;background:#1e7ad6;color:#fff;font-size:13px;cursor:pointer;border-radius:2px;">关闭</button></div></div>';
    document.body.appendChild(modal);
    return modal;
  }

  function hoistMpModals() {
    ensureMpViewModal();
    ['mpViewModal', 'mpEditModal', 'mpFileInput', 'mpFolderInput', 'mpTaskBookInput', 'mpAgreeInput'].forEach(function (id) {
      var nodes = document.querySelectorAll('#' + id);
      if (nodes.length > 1) {
        for (var i = 0; i < nodes.length - 1; i++) {
          try { nodes[i].remove(); } catch (e) {}
        }
      }
      var el = document.getElementById(id);
      if (el && el.parentElement !== document.body) {
        document.body.appendChild(el);
      }
    });
  }

  function bindMpTableClicks() {
    var tbody = document.getElementById('mpTableBody');
    if (!tbody || tbody._mpBound) return;
    tbody._mpBound = true;
    tbody.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('[data-mp-act]') : null;
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
      var act = a.getAttribute('data-mp-act');
      var key = a.getAttribute('data-mp-key') || '';
      if (!key) return;
      if (act === 'view') mpView(key);
      else if (act === 'finance') mpEditFinance(key);
      else if (act === 'info') mpOpenTab(key, 'info');
      else if (act === 'process') mpOpenTab(key, 'process');
      else if (act === 'docs') mpOpenTab(key, 'docs');
      else if (act === 'audit') mpShowAuditLogKey(key);
    });
  }

  function findByKey(key) {
    return allProjects().find(function (p) { return p._key === key; }) || null;
  }

  function mpView(key) {
    hoistMpModals();
    state.currentKey = String(key || '');
    var modal = ensureMpViewModal();
    modal.style.display = 'flex';
    modal.style.zIndex = '20000';
    document.querySelectorAll('#mpTabs .kx-tab').forEach(function (t, i) {
      t.classList.toggle('active', i === 0);
    });
    mpSwitchTab('info');
  }

  function mpOpenTab(key, tab) {
    hoistMpModals();
    state.currentKey = String(key || '');
    var modal = ensureMpViewModal();
    modal.style.display = 'flex';
    modal.style.zIndex = '20000';
    var btn = document.querySelector('#mpTabs .kx-tab[data-tab="' + tab + '"]');
    document.querySelectorAll('#mpTabs .kx-tab').forEach(function (t) {
      t.classList.toggle('active', t === btn);
    });
    mpSwitchTab(tab, btn || null);
  }

  function mpCloseView() {
    var modal = document.getElementById('mpViewModal');
    if (modal) modal.style.display = 'none';
    state.currentKey = '';
  }

  function cell(lab, val) {
    return '<td class="lab">' + esc(lab) + '</td><td class="val">' + (val == null || val === '' ? '&nbsp;' : val) + '</td>';
  }

  function cellRaw(lab, html) {
    return '<td class="lab">' + esc(lab) + '</td><td class="val">' + (html || '&nbsp;') + '</td>';
  }

  function summaryBanner(p) {
    return '<table class="kx-sum"><tr>' +
      '<td><span class="k">项目名称</span><span class="v">' + esc(p.name) + '</span></td>' +
      '<td><span class="k">负责人</span><span class="v">' + esc(p.leader) + '</span></td>' +
      '<td><span class="k">批准经费</span><span class="v">' + money1(p.funding) + ' 万元</span></td>' +
      '<td><span class="k">外拨经费</span><span class="v">' + money1(p.outFunding) + ' 万元</span></td>' +
      '<td><span class="k">配套经费</span><span class="v">' + money1(p.matchFunding) + ' 万元</span></td>' +
      '</tr></table>';
  }

  function tableHtml(headers, rows) {
    if (!rows || !rows.length) return '<div class="kx-null">暂无数据</div>';
    return '<table class="kx-grid"><thead><tr>' +
      headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + r.map(function (c) {
          return '<td>' + (typeof c === 'string' && c.indexOf('<') === 0 ? c : esc(c == null ? '' : c)) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function mpSwitchTab(tab, btn) {
    if (btn) {
      document.querySelectorAll('#mpTabs .kx-tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
    }
    var p = findByKey(state.currentKey);
    var body = document.getElementById('mpTabBody');
    if (!body) return;
    if (!p) { body.innerHTML = '<div class="kx-null">项目不存在</div>'; return; }

    if (tab === 'info') {
      var taskDoc = p.taskBookName
        ? {
          name: p.taskBookName,
          serverFileId: p.taskBookFileId,
          blobUrl: p.taskBookBlobUrl
        }
        : null;
      var agreeDoc = p.agreementName
        ? {
          name: p.agreementName,
          serverFileId: p.agreementFileId,
          blobUrl: p.agreementBlobUrl
        }
        : null;
      var pdf = '<div class="kx-file-row">' +
        (taskDoc ? docLinkHtml(taskDoc) : '<span style="color:#bbb">未上传</span>') +
        '<span class="kx-file-actions">' +
        '<a class="kx-a" href="javascript:void(0)" onclick="mpPickDocs(\'taskbook\')">上传文件</a>' +
        '<a class="kx-a" href="javascript:void(0)" onclick="mpPickDocs(\'taskbook-folder\')">上传文件夹</a>' +
        '</span></div>';
      var agree = '<div class="kx-file-row">' +
        (agreeDoc ? docLinkHtml(agreeDoc) : '<span style="color:#bbb">未上传</span>') +
        '<span class="kx-file-actions">' +
        '<a class="kx-a" href="javascript:void(0)" onclick="mpPickDocs(\'agreement\')">上传</a>' +
        '</span></div>';
      body.innerHTML =
        '<div class="kx-sec"><div class="kx-sec-h">基本信息</div>' +
        '<div class="kx-upload-bar" style="margin-bottom:8px;">' +
        '<span class="kx-upload-status" id="mpUploadStatus"></span></div>' +
        '<table class="kx-info-table">' +
        '<tr>' + cell('项目来源单位', esc(p.sourceOrg)) + cell('项目编号', esc(p.projectNumber)) + '</tr>' +
        '<tr>' + cell('项目学科门类', esc(p.discipline)) + cell('项目名称', esc(p.name)) + '</tr>' +
        '<tr>' + cell('系统编号', esc(p.systemNo)) + cell('负责人', esc(p.leader)) + '</tr>' +
        '<tr>' + cell('负责人类型', esc(p.leaderType)) + cell('成果归属单位', esc(p.unit)) + '</tr>' +
        '<tr>' + cell('项目分类', esc(p.categoryName)) + cell('项目级别', esc(p.level || '其他')) + '</tr>' +
        '<tr>' + cell('项目状态', esc(p.lifeStatus)) + cell('立项日期', esc(p.startDate)) + '</tr>' +
        '<tr>' + cell('开始日期', esc(p.startDate)) + cell('计划结项日期', esc(p.endDate || '')) + '</tr>' +
        '<tr>' + cell('实际结项日期', esc(p.actualEndDate || '')) + cell('合同经费', money(p.funding) + ' 万元') + '</tr>' +
        '<tr>' + cell('批准经费', money(p.funding) + ' 万元') + cell('配套经费', money(p.matchFunding) + ' 万元') + '</tr>' +
        '<tr>' + cell('外拨经费', money(p.outFunding) + ' 万元') + cell('所属年度', esc(yearOf(p))) + '</tr>' +
        '<tr>' + cell('所属平台', esc(p.platform)) + cell('所属方向', esc(p.direction)) + '</tr>' +
        '<tr>' + cell('合作单位', esc(p.partner || '无')) + cellRaw('带公章的任务书完整版电子版', pdf) + '</tr>' +
        '<tr>' + cellRaw('外拨经费协议上传', agree) + cell('专题项目', '') + '</tr>' +
        '<tr>' + cell('累积余额', '万元') + cell('财务编号', esc(p.financeNo)) + '</tr>' +
        '</table></div>' +
        '<div class="kx-sec"><div class="kx-sec-h">详细信息</div>' +
        '<table class="kx-info-table">' +
        '<tr>' + cell('承担单位排名', '第一单位') + cell('项目类型', '项目') + '</tr>' +
        '<tr><td class="lab">备注</td><td class="val" colspan="3">' + esc(p.remark || '') + '&nbsp;</td></tr>' +
        '</table></div>';
      return;
    }

    if (tab === 'members') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">项目成员</div>' +
        tableHtml(
          ['署名顺序', '成员类型', '成员名称', '工作单位', '职称', '学位', '承担类型', '贡献率%'],
          p.members.map(function (m) {
            return [m.order, m.type, m.name, m.unit, m.title, m.degree, m.duty, m.contribution];
          })
        ) + '</div>';
      return;
    }

    if (tab === 'budget') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">项目预算</div>' +
        tableHtml(['预算科目', '金额(万元)'], p.budget.map(function (b) { return [b.subject, b.amount]; })) +
        '</div>';
      return;
    }

    if (tab === 'fundcard') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">经费卡</div>' +
        (p.fundCards.length
          ? tableHtml(['卡号', '开户行', '余额(万元)', '备注'], p.fundCards.map(function (c) {
            return [c.no, c.bank, c.balance, c.note];
          }))
          : '<div class="kx-null">暂无经费卡</div>') + '</div>';
      return;
    }

    if (tab === 'income') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">经费到账</div>' +
        (p.incomes.length
          ? tableHtml(['到账日期', '金额(万元)', '来源', '备注'], p.incomes.map(function (r) {
            return [r.date, r.amount, r.source, r.note];
          }))
          : '<div class="kx-null">暂无到账记录</div>') + '</div>';
      return;
    }

    if (tab === 'expense') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">经费报销</div>' +
        (p.expenses.length
          ? tableHtml(['报销日期', '金额(万元)', '用途', '经办人'], p.expenses.map(function (r) {
            return [r.date, r.amount, r.usage, r.person];
          }))
          : '<div class="kx-null">暂无报销记录</div>') + '</div>';
      return;
    }

    if (tab === 'outsource') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">经费外拨</div>' +
        (p.outsources.length
          ? tableHtml(['外拨单位', '金额(万元)', '日期', '协议'], p.outsources.map(function (r) {
            return [r.org, r.amount, r.date, r.agreement];
          }))
          : '<div class="kx-null">暂无外拨记录</div>') + '</div>';
      return;
    }

    if (tab === 'docs') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">项目文档</div>' +
        '<div class="kx-upload-bar">' +
        '<button type="button" class="kx-btn-sm" onclick="mpPickDocs(\'files\')">选择文件</button>' +
        '<button type="button" class="kx-btn-sm" onclick="mpPickDocs(\'folder\')">选择文件夹</button>' +
        '<span class="kx-upload-status" id="mpUploadStatus">支持一次上传整个文件夹内全部相关文件</span>' +
        '</div>' +
        (p.documents.length
          ? tableHtml(['序号', '文件名称', '上传人', '上传时间', '操作'], p.documents.map(function (d, i) {
            return [
              i + 1,
              docLinkHtml(d),
              d.uploader,
              d.time,
              '<a class="kx-a" href="javascript:void(0)" onclick="mpOpenDoc(' + i + ')">打开</a> ' +
              '<a class="kx-a" href="javascript:void(0)" onclick="mpRemoveDoc(' + i + ')">移除</a>'
            ];
          }))
          : '<div class="kx-null">暂无文档，可点击「选择文件」或「选择文件夹」上传</div>') +
        '</div>';
      return;
    }

    if (tab === 'outcomes') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">衍生成果</div>' +
        (p.outcomes.length
          ? tableHtml(['类型', '名称', '完成人', '日期'], p.outcomes.map(function (o) {
            return [o.type, o.name, o.authors, o.date];
          }))
          : '<div class="kx-null">暂无衍生成果</div>') + '</div>';
      return;
    }

    if (tab === 'process') {
      body.innerHTML = summaryBanner(p) +
        '<div class="kx-sec"><div class="kx-sec-h">执行过程</div>' +
        (p.process.length
          ? tableHtml(['时间', '事项', '说明'], p.process.map(function (r) {
            return [r.time, r.event, r.note];
          }))
          : '<div class="kx-null">暂无执行过程记录</div>') + '</div>';
    }
  }

  function mpShowAuditLog() {
    mpShowAuditLogKey(state.currentKey);
  }

  function mpShowAuditLogKey(key) {
    var p = findByKey(key || state.currentKey);
    alert(p ? ('审核状态：' + (p.auditStatus || '-') + '\n项目：' + p.name) : '无项目');
  }

  function mpEditFinance(key) {
    var p = findByKey(key);
    if (!p) return;
    var no = prompt('录入财务账号 / 财务编号', p.financeNo || '');
    if (no == null) return;
    var extraMap = loadExtra();
    extraMap[key] = Object.assign({}, extraMap[key] || {}, { financeNo: String(no).trim() });
    saveExtra(extraMap);
    mpRender();
    alert('财务编号已保存');
  }

  function setVal(id, v) {
    var el = document.getElementById(id);
    if (el) el.value = v == null ? '' : v;
  }

  function getVal(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function fillEditForm(p) {
    setVal('mpNature', p ? p._nature : '纵向');
    setVal('mpRole', p ? p.roleType : '主持');
    setVal('mpNumber', p ? p.projectNumber : '');
    setVal('mpName', p ? p.name : '');
    setVal('mpLeader', p ? p.leader : '');
    setVal('mpUnit', p ? p.unit : '');
    setVal('mpLevel', p ? p.level : '');
    setVal('mpLife', p ? p.lifeStatus : '进行');
    setVal('mpStartDate', p ? p.startDate : '');
    setVal('mpEndDate', p ? p.endDate : '');
    setVal('mpFunding', p ? p.funding : '');
    setVal('mpOutFunding', p ? p.outFunding : 0);
    setVal('mpMatchFunding', p ? p.matchFunding : 0);
    setVal('mpAudit', p ? p.auditStatus : '学校通过');
    setVal('mpSourceOrg', p ? p.sourceOrg : '');
    setVal('mpPartner', p ? (p.partner || '无') : '无');
    setVal('mpRemark', p ? p.remark : '');
    var natureEl = document.getElementById('mpNature');
    if (natureEl) natureEl.disabled = !!p;
  }

  function mpShowAddModal() {
    hoistMpModals();
    state.editingKey = null;
    var t = document.getElementById('mpEditTitle');
    if (t) t.textContent = '新增项目';
    fillEditForm(null);
    var modal = document.getElementById('mpEditModal');
    if (modal) {
      modal.style.display = 'flex';
      modal.style.zIndex = '20000';
    }
  }

  function mpEdit(key) {
    var p = findByKey(key);
    if (!p) return;
    hoistMpModals();
    state.editingKey = key;
    var t = document.getElementById('mpEditTitle');
    if (t) t.textContent = '编辑项目';
    fillEditForm(p);
    var modal = document.getElementById('mpEditModal');
    if (modal) {
      modal.style.display = 'flex';
      modal.style.zIndex = '20000';
    }
  }

  function mpEditCurrent() {
    if (state.currentKey) mpEdit(state.currentKey);
  }

  function mpCloseEdit() {
    document.getElementById('mpEditModal').style.display = 'none';
    state.editingKey = null;
  }

  function mpSave() {
    var nature = getVal('mpNature') || '纵向';
    var payload = {
      projectNumber: getVal('mpNumber'),
      name: getVal('mpName'),
      leader: getVal('mpLeader'),
      unit: getVal('mpUnit'),
      startDate: getVal('mpStartDate'),
      funding: getVal('mpFunding'),
      status: getVal('mpAudit') || '学校通过',
      remark: getVal('mpRemark')
    };
    if (!payload.name || !payload.projectNumber || !payload.leader || !payload.unit || !payload.startDate || !payload.funding) {
      alert('请填写必填字段');
      return;
    }
    if (nature === '纵向') payload.level = getVal('mpLevel') || '省部级';
    if (nature === '横向') payload.company = getVal('mpLevel') || payload.unit;
    if (nature === '校级') payload.type = getVal('mpLevel') || '科研项目';

    var sk = storeKey(nature);
    var arr = loadArr(sk);
    var id;
    if (state.editingKey) {
      var old = findByKey(state.editingKey);
      if (!old) { alert('原记录不存在'); return; }
      id = old.id;
      var idx = arr.findIndex(function (d) { return Number(d.id) === Number(id); });
      if (idx < 0) { alert('原记录不存在'); return; }
      arr[idx] = Object.assign({}, arr[idx], payload, { id: id });
    } else {
      id = arr.length ? Math.max.apply(null, arr.map(function (d) { return Number(d.id) || 0; })) + 1 : 1;
      arr.push(Object.assign({ id: id, fileName: '' }, payload));
    }
    saveArr(sk, arr);

    var key = itemKey(nature, id);
    var extraMap = loadExtra();
    extraMap[key] = Object.assign({}, extraMap[key] || {}, {
      roleType: getVal('mpRole') || '主持',
      lifeStatus: getVal('mpLife') || '进行',
      auditStatus: getVal('mpAudit') || '学校通过',
      endDate: getVal('mpEndDate'),
      outFunding: getVal('mpOutFunding') || 0,
      matchFunding: getVal('mpMatchFunding') || 0,
      sourceOrg: getVal('mpSourceOrg'),
      partner: getVal('mpPartner') || '无',
      remark: getVal('mpRemark')
    });
    saveExtra(extraMap);

    try {
      if (nature === '纵向' && typeof longitudinalData !== 'undefined') {
        global.longitudinalData = arr;
        if (typeof saveLongitudinalData === 'function') saveLongitudinalData();
      }
      if (nature === '横向' && typeof horizontalData !== 'undefined') {
        global.horizontalData = arr;
        if (typeof saveHorizontalData === 'function') saveHorizontalData();
      }
      if (nature === '校级' && typeof schoolData !== 'undefined') {
        global.schoolData = arr;
        if (typeof saveSchoolData === 'function') saveSchoolData();
      }
    } catch (e) {}

    mpCloseEdit();
    mpRender();
    alert('保存成功');
  }

  function mpDelete(key) {
    var p = findByKey(key);
    if (!p) return;
    if (!confirm('确定删除项目「' + p.name + '」？')) return;
    var arr = loadArr(p._store).filter(function (d) { return Number(d.id) !== Number(p.id); });
    saveArr(p._store, arr);
    var extraMap = loadExtra();
    delete extraMap[key];
    saveExtra(extraMap);
    if (state.currentKey === key) mpCloseView();
    mpRender();
  }

  function mpExportCsv() {
    var list = filteredProjects();
    if (!list.length) { alert('没有可导出的数据'); return; }
    var csv = '\ufeff项目性质,参与形式,项目编号,项目名称,负责人,批准经费,立项日期,所属单位,项目状态,审核状态\n';
    list.forEach(function (p) {
      csv += [p._nature, p.roleType, p.projectNumber, p.name, p.leader, p.funding, p.startDate, p.unit, p.lifeStatus, p.auditStatus]
        .map(function (x) { return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; }).join(',') + '\n';
    });
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '我的项目_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  }

  function mpSeedDemoProject(force) {
    var arr = loadArr('longitudinalData');
    var demoNo = 'CQYJ2025-KJ-015';
    var exists = arr.some(function (d) { return d.projectNumber === demoNo || d._demo === 1; });
    if (exists && !force) {
      mpRender();
      return false;
    }
    if (exists && force) {
      arr = arr.filter(function (d) { return d.projectNumber !== demoNo && d._demo !== 1; });
    }
    var id = arr.length ? Math.max.apply(null, arr.map(function (d) { return Number(d.id) || 0; })) + 1 : 1;
    var item = {
      id: id,
      _demo: 1,
      projectNumber: demoNo,
      name: '露天非煤矿山非现场执法典型隐患识别关键技术研究',
      leader: '王丽萍',
      unit: '土木与水利工程学院',
      level: '其他',
      startDate: '2025-12-23',
      funding: 20,
      status: '学校通过',
      remark: '',
      fileName: '露天非煤矿山非现场执法典型隐患识别关键技术研究.pdf'
    };
    arr.push(item);
    saveArr('longitudinalData', arr);

    var key = itemKey('纵向', id);
    var extraMap = loadExtra();
    extraMap[key] = {
      roleType: '主持',
      lifeStatus: '进行',
      auditStatus: '学校通过',
      endDate: '2026-12-31',
      outFunding: 0,
      matchFunding: 0,
      sourceOrg: '重庆市应急管理局',
      partner: '无',
      discipline: '自然科学',
      leaderType: '教师',
      categoryName: '其他省部级政府科研项目',
      systemNo: 'KJ20250016',
      platform: '',
      direction: '',
      financeNo: '',
      taskBookName: '露天非煤矿山非现场执法典型隐患识别关键技术研究.pdf',
      members: [
        { order: 1, type: '教师', name: '王丽萍', unit: '科技处（产学研办公室、期刊社）', title: '教授', degree: '博士', duty: '负责人', contribution: 40 },
        { order: 2, type: '教师', name: '罗文文', unit: '土木与水利工程学院', title: '副教授', degree: '博士', duty: '参与人', contribution: 30 },
        { order: 3, type: '教师', name: '罗钧', unit: '土木与水利工程学院', title: '高级工程师', degree: '博士', duty: '参与人', contribution: 30 }
      ],
      budget: [
        { subject: '直接费用', amount: '14.00' },
        { subject: '间接费用', amount: '6.00' }
      ],
      fundCards: [
        { no: '6222****8899', bank: '中国建设银行重庆科大支行', balance: '20.00', note: '项目主卡' }
      ],
      incomes: [
        { date: '2026-01-15', amount: '10.00', source: '重庆市应急管理局', note: '首批到账' },
        { date: '2026-06-01', amount: '10.00', source: '重庆市应急管理局', note: '尾款到账' }
      ],
      expenses: [
        { date: '2026-03-08', amount: '1.20', usage: '差旅调研', person: '罗文文' },
        { date: '2026-04-20', amount: '0.80', usage: '耗材采购', person: '罗钧' }
      ],
      outsources: [],
      documents: [
        { name: '露天非煤矿山非现场执法典型隐患识别关键技术研究.pdf', uploader: '徐晓文', time: '2025-05-13 16:41:03' },
        { name: '关于公示2025年应急管理科技项目立项情况的通知.pdf', uploader: '徐晓文', time: '2025-05-13 16:41:03' }
      ],
      outcomes: [
        { type: '论文', name: '露天矿山非现场执法隐患识别方法研究', authors: '王丽萍,罗文文', date: '2026-05-01' }
      ],
      process: [
        { time: '2025-12-23', event: '立项获批', note: '学校通过立项审核' },
        { time: '2026-01-15', event: '经费到账', note: '首批经费 10 万元到账' },
        { time: '2026-06-30', event: '中期检查', note: '按计划推进中' }
      ],
      remark: ''
    };
    saveExtra(extraMap);
    try {
      if (typeof longitudinalData !== 'undefined') {
        global.longitudinalData = arr;
        if (typeof saveLongitudinalData === 'function') saveLongitudinalData();
      }
    } catch (e) {}
    mpRender();
    return true;
  }

  function initMyProjects() {
    state.page = 1;
    var root = document.getElementById('my_projects');
    function afterReady() {
      hoistMpModals();
      ensureMpViewModal();
      mpSeedDemoProject(false);
      mpRender();
    }
    var needReload = root && (
      !root.querySelector('.kx-root') ||
      (!document.getElementById('mpViewModal') && !root.querySelector('#mpViewModal'))
    );
    if (needReload && typeof window.forceReloadModuleHtml === 'function') {
      Promise.resolve(window.forceReloadModuleHtml('my_projects')).then(afterReady);
      return;
    }
    afterReady();
  }

  global.initMyProjects = initMyProjects;
  global.mpSeedDemoProject = mpSeedDemoProject;
  global.mpPickDocs = mpPickDocs;
  global.mpRemoveDoc = mpRemoveDoc;
  global.mpOpenDoc = mpOpenDoc;
  global.mpSetFilter = mpSetFilter;
  global.mpResetFilters = mpResetFilters;
  global.mpToggleYears = mpToggleYears;
  global.mpSetSubNav = mpSetSubNav;
  global.mpGotoPage = mpGotoPage;
  global.mpView = mpView;
  global.mpOpenTab = mpOpenTab;
  global.mpCloseView = mpCloseView;
  global.mpSwitchTab = mpSwitchTab;
  global.mpShowAuditLog = mpShowAuditLog;
  global.mpShowAuditLogKey = mpShowAuditLogKey;
  global.mpEditFinance = mpEditFinance;
  global.mpShowAddModal = mpShowAddModal;
  global.mpEdit = mpEdit;
  global.mpEditCurrent = mpEditCurrent;
  global.mpCloseEdit = mpCloseEdit;
  global.mpSave = mpSave;
  global.mpDelete = mpDelete;
  global.mpExportCsv = mpExportCsv;
  global.mpRender = mpRender;

})(typeof window !== 'undefined' ? window : this);
