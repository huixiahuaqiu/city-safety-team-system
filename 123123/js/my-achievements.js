/**
 * 我的成果 — 对齐科研创新服务平台「我的成果」截图
 * 聚合：paperData / patentMgmtData|patentData / standardData / competitionData / copyrightData
 * 扩展：researchAchievementExtra
 */
(function (global) {
  'use strict';

  var PAGE_SIZE = 20;
  var TYPES = ['论文', '著作', '决策咨询报告', '专利', '获奖', '标准'];
  var state = {
    type: '',
    role: '',
    year: '',
    page: 1,
    currentKey: '',
    yearsCollapsed: false,
    sub: 'all',
    pushFilter: '',
    verifyFilter: ''
  };

  function esc(s) {
    return window.escapeHtml(s);
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
      if (key === 'paperData') {
        window.paperData = arr || [];
        if (typeof paperData !== 'undefined') paperData = arr || [];
      }
      if (key === 'patentMgmtData' || key === 'patentData') {
        window.patentMgmtData = arr || [];
        window.patentData = arr || [];
      }
      if (key === 'copyrightData') {
        window.copyrightData = arr || [];
      }
    } catch (eW) {}
    try { if (typeof cloudUpsert === 'function') cloudUpsert(key, JSON.stringify(arr || [])); } catch (e) {}
    notifyHomeAchievementChange(key);
  }

  function loadExtra() {
    try { return JSON.parse(localStorage.getItem('researchAchievementExtra') || '{}') || {}; }
    catch (e) { return {}; }
  }

  function saveExtra(map) {
    localStorage.setItem('researchAchievementExtra', JSON.stringify(map || {}));
    try { if (typeof cloudUpsert === 'function') cloudUpsert('researchAchievementExtra', JSON.stringify(map || {})); } catch (e) {}
    notifyHomeAchievementChange('researchAchievementExtra');
  }

  function itemKey(type, id) { return type + ':' + id; }

  function yearOf(dateStr) {
    var m = String(dateStr || '').match(/(20\d{2}|19\d{2})/);
    return m ? m[1] : '其他';
  }

  function patentStatusLabel(st) {
    st = String(st || '');
    if (st === '授权') return '专利授权';
    if (/申请|实质审查|公布/.test(st)) return '专利申请';
    return st || '专利申请';
  }

  function auditLabel(raw) {
    if (!raw) return '学校通过';
    if (raw === '已通过' || raw === '授权' || raw === '学校通过') return '学校通过';
    if (raw === '审核中' || raw === '实质审查') return '审核中';
    if (raw === '已驳回' || raw === '无效') return '学校不通过';
    return raw;
  }

  function nowUser() {
    try {
      var u = global.currentUser;
      if (u) return u.realName || u.name || u.username || '当前用户';
    } catch (e) {}
    return '当前用户';
  }

  function nowStamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function patchExtra(key, patch) {
    var map = loadExtra();
    map[key] = Object.assign({}, map[key] || {}, patch || {});
    saveExtra(map);
  }

  function computeVerifyIssues(p) {
    var issues = [];
    if (!p) return issues;
    if (!p.title) issues.push('缺少成果名称');
    if (!p.date) issues.push('缺少日期');
    if (!p.unit) issues.push('缺少所属单位');
    if (p._type === '论文') {
      if (!p.journal) issues.push('缺少刊物/论文集');
      if (!p.authors) issues.push('缺少作者');
      if (!p.doi && !(p.extra && p.extra.doi)) issues.push('缺少 DOI');
    }
    if (p._type === '专利') {
      if (!p.no) issues.push('缺少专利号/申请号');
      if (!p.inventors && !p.authors) issues.push('缺少发明人');
    }
    if (p._type === '著作' && !p.title) issues.push('缺少软著/著作名称');
    if (p.audit === '审核中') issues.push('仍在审核中');
    if (p.audit === '学校不通过') issues.push('审核未通过');
    return issues;
  }

  function pushStatusLabel(st) {
    if (st === 'pushed') return '已推送';
    if (st === 'pending') return '待推送';
    return '未推送';
  }

  function verifyStatusLabel(st) {
    if (st === 'passed') return '核验通过';
    if (st === 'failed') return '核验未通过';
    if (st === 'pending') return '待核验';
    return '未核验';
  }

  function attachWorkflow(p) {
    if (!p) return p;
    var extra = p.extra || {};
    p.pushStatus = extra.pushStatus || 'none';
    p.pushTime = extra.pushTime || '';
    p.pushBy = extra.pushBy || '';
    p.pushNote = extra.pushNote || '';
    p.verifyStatus = extra.verifyStatus || 'none';
    p.verifyTime = extra.verifyTime || '';
    p.verifyNote = extra.verifyNote || '';
    p.verifyIssues = Array.isArray(extra.verifyIssues) && extra.verifyIssues.length
      ? extra.verifyIssues
      : computeVerifyIssues(p);
    return p;
  }

  function unifyPatent(raw) {
    var extra = loadExtra()[itemKey('专利', raw.id)] || {};
    var date = raw.application_date || raw.applicationDate || raw.grant_date || '';
    return {
      _key: itemKey('专利', raw.id),
      _type: '专利',
      _store: 'patentMgmtData',
      id: raw.id,
      title: raw.name || raw.title || '',
      no: raw.patent_number || raw.application_number || '',
      date: date,
      status: patentStatusLabel(raw.status),
      unit: raw.unit || raw.applicant || '土木与水利工程学院',
      agentStatus: extra.agentStatus || '未处理',
      audit: auditLabel(extra.auditStatus || raw.auditStatus || '学校通过'),
      roleType: extra.roleType || '主持',
      year: yearOf(date),
      inventors: raw.inventor || extra.inventors || '',
      patentType: raw.patent_type || '发明专利',
      applicant: raw.applicant || '重庆科技大学',
      pdfName: extra.pdfName || raw.fileName || '',
      authors: raw.inventor || '',
      authorRows: Array.isArray(extra.authorRows) ? extra.authorRows : defaultPatentAuthors(raw),
      projects: Array.isArray(extra.projects) ? extra.projects : defaultLinkedProjects(),
      reprints: Array.isArray(extra.reprints) ? extra.reprints : [],
      raw: raw,
      extra: extra
    };
  }

  function defaultPatentAuthors(raw) {
    var names = String(raw.inventor || '').split(/[,，、;；]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) names = ['发明人'];
    return names.map(function (n, i) {
      return { order: i + 1, type: '教师', name: n, edu: '博士研究生', title: i === 0 ? '教授' : '副教授', role: i === 0 ? '第一发明人' : '参与发明人', unit: '土木与水利工程学院', rate: Math.floor(100 / names.length) };
    });
  }

  function unifyPaper(raw) {
    var extra = loadExtra()[itemKey('论文', raw.id)] || {};
    var date = raw.publish_date || raw.publishDate || '';
    return {
      _key: itemKey('论文', raw.id),
      _type: '论文',
      _store: 'paperData',
      id: raw.id,
      title: raw.title || raw.name || '',
      journal: raw.journal || '',
      authors: raw.author || raw.authors || '',
      date: date,
      audit: auditLabel(raw.status || extra.auditStatus),
      unit: raw.unit || '土木与水利工程学院',
      roleType: extra.roleType || '主持',
      year: yearOf(date),
      paperType: extra.paperType || '国际期刊',
      level: extra.level || (raw.index || '检索'),
      indexCat: extra.indexCat || raw.index || 'SCI',
      doi: extra.doi || '',
      pdfName: extra.pdfName || '',
      vol: extra.vol || '',
      sciZone: extra.sciZone || '',
      ifactor: extra.ifactor || '',
      issn: extra.issn || '',
      authorRows: Array.isArray(extra.authorRows) ? extra.authorRows : defaultPaperAuthors(raw),
      projects: Array.isArray(extra.projects) ? extra.projects : defaultLinkedProjects(),
      reprints: Array.isArray(extra.reprints) ? extra.reprints : [],
      raw: raw,
      extra: extra
    };
  }

  function defaultPaperAuthors(raw) {
    var names = String(raw.author || '').split(/[,，、;；]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) names = ['作者'];
    return names.map(function (n, i) {
      var isStu = /学/.test(n);
      var name = n.replace(/[（(]学[）)]/g, '').replace(/[（(]外[）)]/g, '').trim();
      return {
        order: i + 1,
        type: isStu ? '学生' : '教师',
        name: name,
        user: '',
        edu: isStu ? '硕士研究生' : '博士研究生',
        title: i === 0 ? '' : (i === 1 ? '高级工程师' : '副教授'),
        role: i === 0 ? '第一作者' : (i === 1 ? '通讯作者' : '参与作者'),
        unit: '土木与水利工程学院',
        rate: 0
      };
    });
  }

  function defaultLinkedProjects() {
    var lon = loadArr('longitudinalData');
    if (!lon.length) return [];
    var p = lon[0];
    return [{
      name: p.name || '',
      leader: p.leader || '',
      unit: p.unit || '',
      date: p.startDate || '',
      amount: p.funding != null ? Number(p.funding).toFixed(2) : '',
      members: p.leader || ''
    }];
  }

  function unifyGeneric(raw, type, store, titleField, dateField) {
    var extra = loadExtra()[itemKey(type, raw.id)] || {};
    var date = raw[dateField] || raw.date || raw.publish_date || raw.startDate || '';
    return {
      _key: itemKey(type, raw.id),
      _type: type,
      _store: store,
      id: raw.id,
      title: raw[titleField] || raw.name || raw.title || '',
      date: date,
      audit: auditLabel(raw.status || extra.auditStatus),
      unit: raw.unit || '',
      roleType: extra.roleType || '主持',
      year: yearOf(date),
      authors: raw.author || raw.authors || raw.members || '',
      journal: raw.journal || raw.publisher || raw.level || '',
      status: raw.status || '',
      raw: raw,
      extra: extra,
      authorRows: Array.isArray(extra.authorRows) ? extra.authorRows : [],
      projects: Array.isArray(extra.projects) ? extra.projects : [],
      reprints: Array.isArray(extra.reprints) ? extra.reprints : []
    };
  }

  function patentSource() {
    var a = loadArr('patentMgmtData');
    if (a.length) return a;
    return loadArr('patentData');
  }

  function allAchievements() {
    var list = [];
    patentSource().forEach(function (d) {
      if (d && !(d.classification === '__APP_SYNC__' || (d.patent_number && String(d.patent_number).indexOf('__SYNC_KV__') === 0))) {
        list.push(unifyPatent(d));
      }
    });
    loadArr('paperData').forEach(function (d) { list.push(unifyPaper(d)); });
    loadArr('standardData').forEach(function (d) {
      var t = /著作|专著|图书/.test(String(d.type || d.category || d.name || '')) ? '著作' : '标准';
      list.push(unifyGeneric(d, t, 'standardData', 'name', 'publishDate'));
    });
    loadArr('competitionData').forEach(function (d) {
      list.push(unifyGeneric(d, '获奖', 'competitionData', 'name', 'date'));
    });
    loadArr('copyrightData').forEach(function (d) {
      list.push(unifyGeneric(d, '著作', 'copyrightData', 'name', 'registerDate'));
    });
    loadArr('consultReportData').forEach(function (d) {
      list.push(unifyGeneric(d, '决策咨询报告', 'consultReportData', 'name', 'date'));
    });
    list.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    return list.map(attachWorkflow);
  }

  /** 供首页 KPI / 门户同源统计 */
  function getAchievementOverviewCounts(yearScope) {
    var y = String(new Date().getFullYear());
    var scope = yearScope === 'current' ? 'current' : 'all';
    var counts = { patent: 0, paper: 0, book: 0, award: 0, standard: 0, consult: 0, total: 0 };
    allAchievements().forEach(function (p) {
      if (!p) return;
      if (scope === 'current' && String(p.year) !== y) return;
      counts.total++;
      if (p._type === '专利') counts.patent++;
      else if (p._type === '论文') counts.paper++;
      else if (p._type === '著作') counts.book++;
      else if (p._type === '获奖') counts.award++;
      else if (p._type === '标准') counts.standard++;
      else if (p._type === '决策咨询报告') counts.consult++;
    });
    return counts;
  }

  function notifyHomeAchievementChange(reason) {
    try {
      if (typeof bumpHomeDashboard === 'function') bumpHomeDashboard(reason || 'achievements');
      else if (typeof invalidateHomeOverviewCache === 'function') {
        invalidateHomeOverviewCache(reason || 'achievements');
        if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
      }
    } catch (e) {}
  }

  function passFilters(p, opts) {
    opts = opts || {};
    var type = opts.type !== undefined ? opts.type : state.type;
    var role = opts.role !== undefined ? opts.role : state.role;
    var year = opts.year !== undefined ? opts.year : state.year;
    if (type && p._type !== type) return false;
    if (role && p.roleType !== role) return false;
    if (year && String(p.year) !== String(year)) return false;
    return true;
  }

  function passSubFilters(p) {
    if (!p) return false;
    if (state.sub === 'push') {
      if (state.pushFilter === 'pushed') return p.pushStatus === 'pushed';
      if (state.pushFilter === 'pending') return p.pushStatus === 'pending' || p.pushStatus === 'none';
      return true;
    }
    if (state.sub === 'verify') {
      if (state.verifyFilter === 'passed') return p.verifyStatus === 'passed';
      if (state.verifyFilter === 'failed') return p.verifyStatus === 'failed';
      if (state.verifyFilter === 'pending') {
        return p.verifyStatus === 'pending' || p.verifyStatus === 'none' || (p.verifyIssues && p.verifyIssues.length);
      }
      return true;
    }
    return true;
  }

  function filteredList() {
    var list = allAchievements().filter(function (p) {
      return passFilters(p) && passSubFilters(p);
    });
    if (typeof acColRows === 'function') list = acColRows('myachievements', list);
    return list;
  }

  function sideFilteredList() {
    return allAchievements().filter(function (p) { return passFilters(p); });
  }

  function ensureAchColFilterReady() {
    if (ensureAchColFilterReady._done) return;
    if (typeof acColValFn === 'function') {
      acColValFn('myachievements', 'info', function (d) {
        return (d && (d.journal || d.status || d.authors)) || '';
      });
      ensureAchColFilterReady._done = true;
    }
  }

  function openAchColFilter(ev, field, label) {
    ensureAchColFilterReady();
    if (typeof acShowColFilter === 'function') {
      acShowColFilter(ev, 'myachievements', field, label, sideFilteredList(), 'achRender');
    }
  }

  function achColTh(field, label, width) {
    var w = width ? ' style="width:' + width + '"' : '';
    var safeLabel = String(label).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<th' + w + '>' + esc(label) +
      ' <span data-acfilter="myachievements" data-acfield="' + esc(field) +
      '" onclick="openAchColFilter(event,\'' + esc(field) + '\',\'' + safeLabel +
      '\')" title="按此列筛选" class="ach-col-filter">▼</span></th>';
  }

  function achSetFilter(kind, value) {
    value = value == null ? '' : String(value);
    if (kind === 'type') {
      state.type = value;
      if (typeof acClearColFilter === 'function') acClearColFilter('myachievements');
    } else if (kind === 'role') {
      state.role = (state.role === value ? '' : value);
    } else if (kind === 'year') {
      state.year = (String(state.year) === value ? '' : value);
    }
    // 点侧栏后若当前组合无数据，自动放宽冲突条件，避免「点了却空白」
    if (state.year || state.role || state.type) {
      var all = allAchievements();
      if (!all.some(function (p) { return passFilters(p); })) {
        if (state.role && all.some(function (p) { return passFilters(p, { role: '' }); })) {
          state.role = '';
        } else if (state.type && all.some(function (p) { return passFilters(p, { type: '' }); })) {
          state.type = '';
        } else if (state.year && state.role && all.some(function (p) { return passFilters(p, { role: '', type: '' }); })) {
          state.role = '';
          state.type = '';
        }
      }
    }
    state.page = 1;
    achRender();
  }

  function achResetFilters() {
    state.type = '';
    state.role = '';
    state.year = '';
    state.pushFilter = '';
    state.verifyFilter = '';
    state.page = 1;
    if (typeof acClearColFilter === 'function') acClearColFilter('myachievements');
    achRender();
  }

  function achToggleYears() {
    state.yearsCollapsed = !state.yearsCollapsed;
    var box = document.getElementById('achYearList');
    if (box) box.style.display = state.yearsCollapsed ? 'none' : '';
  }

  function achSetSubNav(el, name) {
    document.querySelectorAll('.ach-subnav-item').forEach(function (a) { a.classList.remove('active'); });
    if (el) el.classList.add('active');
    state.sub = name || 'all';
    state.page = 1;
    state.pushFilter = '';
    state.verifyFilter = '';
    achRender();
  }

  function achSetPushFilter(value) {
    state.pushFilter = state.pushFilter === value ? '' : (value || '');
    state.page = 1;
    achRender();
  }

  function achSetVerifyFilter(value) {
    state.verifyFilter = state.verifyFilter === value ? '' : (value || '');
    state.page = 1;
    achRender();
  }

  function bindSideClicks() {
    var side = document.getElementById('achSide');
    if (!side) return;
    // 模块 HTML 重载后节点会换新，必须重新绑定
    if (side._achSideHandler) {
      try { side.removeEventListener('click', side._achSideHandler); } catch (e) {}
    }
    side._achSideHandler = function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[data-ach-type],a[data-ach-role],a[data-ach-year]') : null;
      if (!a || !side.contains(a)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (a.hasAttribute('data-ach-type')) achSetFilter('type', a.getAttribute('data-ach-type') || '');
      else if (a.hasAttribute('data-ach-role')) achSetFilter('role', a.getAttribute('data-ach-role') || '');
      else if (a.hasAttribute('data-ach-year')) achSetFilter('year', a.getAttribute('data-ach-year') || '');
    };
    side.addEventListener('click', side._achSideHandler);
  }

  function updateSide(all) {
    function set(id, n) {
      var el = document.getElementById(id);
      if (el) el.textContent = String(n);
    }
    set('achCntAll', all.length);
    TYPES.forEach(function (t) {
      set('achCnt' + t, all.filter(function (p) { return p._type === t; }).length);
    });
    // 角标与列表同一套筛选（只放开自身维度），避免「角标有数、点开空白」
    var forRole = all.filter(function (p) { return passFilters(p, { role: '' }); });
    set('achCntHost', forRole.filter(function (p) { return p.roleType === '主持'; }).length);
    set('achCntJoin', forRole.filter(function (p) { return p.roleType === '参与'; }).length);

    document.querySelectorAll('#achSide [data-ach-type]').forEach(function (el) {
      el.classList.toggle('active', String(el.getAttribute('data-ach-type') || '') === String(state.type || ''));
    });
    document.querySelectorAll('#achSide [data-ach-role]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-ach-role') === state.role && !!state.role);
    });

    var forYear = all.filter(function (p) { return passFilters(p, { year: '' }); });
    var yearMap = {};
    forYear.forEach(function (p) { yearMap[p.year] = (yearMap[p.year] || 0) + 1; });
    var years = Object.keys(yearMap).filter(function (y) { return y !== '其他'; })
      .sort(function (a, b) { return Number(a) - Number(b); });
    if (yearMap['其他']) years.push('其他');
    var box = document.getElementById('achYearList');
    if (box) {
      box.innerHTML = years.map(function (y) {
        return '<a href="javascript:void(0)" class="ach-side-a' + (String(state.year) === String(y) ? ' active' : '') +
          '" data-ach-year="' + esc(y) + '">' +
          esc(y) + '<span class="ach-badge">' + yearMap[y] + '</span></a>';
      }).join('');
      if (state.yearsCollapsed) box.style.display = 'none';
    }

    var flow = document.getElementById('achFlowFilters');
    if (!flow) {
      flow = document.createElement('div');
      flow.id = 'achFlowFilters';
      flow.className = 'ach-side-sec';
      var side = document.getElementById('achSide');
      var foot = side && side.querySelector('.ach-side-foot');
      if (side && foot) side.insertBefore(flow, foot);
      else if (side) side.appendChild(flow);
    }
    if (!flow) return;
    if (state.sub === 'push') {
      var pushedN = all.filter(function (p) { return p.pushStatus === 'pushed'; }).length;
      var pendingN = all.filter(function (p) { return p.pushStatus !== 'pushed'; }).length;
      flow.style.display = '';
      flow.innerHTML =
        '<div class="ach-side-title">推送状态</div>' +
        '<a href="javascript:void(0)" class="ach-side-a' + (!state.pushFilter ? ' active' : '') + '" onclick="achSetPushFilter(\'\')">全部<span class="ach-badge">' + all.length + '</span></a>' +
        '<a href="javascript:void(0)" class="ach-side-a' + (state.pushFilter === 'pending' ? ' active' : '') + '" onclick="achSetPushFilter(\'pending\')">待推送<span class="ach-badge">' + pendingN + '</span></a>' +
        '<a href="javascript:void(0)" class="ach-side-a' + (state.pushFilter === 'pushed' ? ' active' : '') + '" onclick="achSetPushFilter(\'pushed\')">已推送<span class="ach-badge">' + pushedN + '</span></a>';
    } else if (state.sub === 'verify') {
      var passedN = all.filter(function (p) { return p.verifyStatus === 'passed'; }).length;
      var failedN = all.filter(function (p) { return p.verifyStatus === 'failed'; }).length;
      var pendingV = all.filter(function (p) {
        return p.verifyStatus === 'pending' || p.verifyStatus === 'none' || (p.verifyIssues && p.verifyIssues.length && p.verifyStatus !== 'passed');
      }).length;
      flow.style.display = '';
      flow.innerHTML =
        '<div class="ach-side-title">核验状态</div>' +
        '<a href="javascript:void(0)" class="ach-side-a' + (!state.verifyFilter ? ' active' : '') + '" onclick="achSetVerifyFilter(\'\')">全部<span class="ach-badge">' + all.length + '</span></a>' +
        '<a href="javascript:void(0)" class="ach-side-a' + (state.verifyFilter === 'pending' ? ' active' : '') + '" onclick="achSetVerifyFilter(\'pending\')">待核验<span class="ach-badge">' + pendingV + '</span></a>' +
        '<a href="javascript:void(0)" class="ach-side-a' + (state.verifyFilter === 'passed' ? ' active' : '') + '" onclick="achSetVerifyFilter(\'passed\')">通过<span class="ach-badge">' + passedN + '</span></a>' +
        '<a href="javascript:void(0)" class="ach-side-a' + (state.verifyFilter === 'failed' ? ' active' : '') + '" onclick="achSetVerifyFilter(\'failed\')">未通过<span class="ach-badge">' + failedN + '</span></a>';
    } else {
      flow.style.display = 'none';
      flow.innerHTML = '';
    }
  }

  function emptyHint() {
    var parts = [];
    if (state.sub === 'push') parts.push('页签「所内推送」');
    if (state.sub === 'verify') parts.push('页签「自助核验」');
    if (state.pushFilter === 'pushed') parts.push('已推送');
    if (state.pushFilter === 'pending') parts.push('待推送');
    if (state.verifyFilter === 'passed') parts.push('核验通过');
    if (state.verifyFilter === 'failed') parts.push('核验未通过');
    if (state.verifyFilter === 'pending') parts.push('待核验');
    if (state.type) parts.push('类型「' + state.type + '」');
    if (state.year) parts.push('年度「' + state.year + '」');
    if (state.role) parts.push('参与形式「' + state.role + '」');
    if (!parts.length) return '暂无成果数据';
    return '当前筛选（' + parts.join(' · ') + '）下没有数据。可点侧栏「清除筛选」或切换页签。';
  }

  function opsCell(p) {
    var k = esc(p._key);
    var html = '<td class="ach-ops">' +
      '<a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">查看</a> ';
    if (state.sub === 'push') {
      if (p.pushStatus === 'pushed') {
        html += '<a class="ach-a" href="javascript:void(0)" data-ach-act="unpush" data-ach-key="' + k + '">撤回</a> ';
      } else {
        html += '<a class="ach-a" href="javascript:void(0)" data-ach-act="push" data-ach-key="' + k + '">推送</a> ';
      }
    } else if (state.sub === 'verify') {
      html += '<a class="ach-a" href="javascript:void(0)" data-ach-act="verify" data-ach-key="' + k + '">核验</a> ';
      html += '<a class="ach-a" href="javascript:void(0)" data-ach-act="pass" data-ach-key="' + k + '">通过</a> ';
      html += '<a class="ach-a" href="javascript:void(0)" data-ach-act="fail" data-ach-key="' + k + '" style="color:#e5484d">未通过</a> ';
    } else {
      html += '<a class="ach-a" href="javascript:void(0)" data-ach-act="delete" data-ach-key="' + k + '" style="color:#e5484d">删除</a>';
    }
    html += '</td>';
    return html;
  }

  function updatePanelChrome() {
    var title = document.querySelector('#my_achievements .ach-panel-title') || document.querySelector('.ach-panel-title');
    var tools = document.querySelector('#my_achievements .ach-panel-tools') || document.querySelector('.ach-panel-tools');
    if (title) {
      title.textContent = state.sub === 'push' ? '所内推送列表' : (state.sub === 'verify' ? '自助核验列表' : '成果列表');
    }
    if (!tools) return;
    if (state.sub === 'push') {
      tools.innerHTML =
        '<button type="button" class="ach-btn-sm ach-btn-add" onclick="achBatchPush()">批量推送待办</button>' +
        '<button type="button" class="ach-btn-sm" onclick="achExportCsv()">导出</button>' +
        '<button type="button" class="ach-btn-sm" onclick="achRender()">刷新</button>';
    } else if (state.sub === 'verify') {
      tools.innerHTML =
        '<button type="button" class="ach-btn-sm ach-btn-add" onclick="achBatchVerify()">一键核验全部</button>' +
        '<button type="button" class="ach-btn-sm" onclick="achExportCsv()">导出</button>' +
        '<button type="button" class="ach-btn-sm" onclick="achRender()">刷新</button>';
    } else {
      tools.innerHTML =
        '<button type="button" class="ach-btn-sm ach-btn-add" onclick="achShowAddHint()">＋ 新增</button>' +
        '<button type="button" class="ach-btn-sm" onclick="achExportCsv()">导出</button>' +
        '<button type="button" class="ach-btn-sm" onclick="achRender()">刷新</button>';
    }
  }

  function headHtml() {
    var t = state.type;
    if (t === '专利') {
      return '<tr>' +
        achColTh('no', '申请号', '14%') +
        achColTh('title', '专利名称') +
        achColTh('date', '申请日期', '11%') +
        achColTh('status', '专利状态', '10%') +
        achColTh('unit', '所属单位', '16%') +
        achColTh('agentStatus', '代理状态', '9%') +
        achColTh('audit', '审核状态', '10%') +
        '<th style="width:10%">操作</th></tr>';
    }
    if (t === '论文' || t === '') {
      return '<tr>' +
        achColTh('title', '名称') +
        achColTh('journal', '刊物/论文集名称', '16%') +
        achColTh('authors', '所有作者', '18%') +
        achColTh('date', '发表/出版日期', '11%') +
        achColTh('audit', '审核状态', '10%') +
        achColTh('unit', '所属单位', '14%') +
        '<th style="width:10%">操作</th></tr>';
    }
    return '<tr>' +
      achColTh('title', '名称') +
      achColTh('date', '日期', '14%') +
      achColTh('info', '相关信息', '18%') +
      achColTh('unit', '所属单位', '14%') +
      achColTh('audit', '审核状态', '10%') +
      achColTh('roleType', '参与形式', '10%') +
      '<th style="width:10%">操作</th></tr>';
  }

  function rowHtml(p) {
    var k = esc(p._key);
    if (state.type === '专利') {
      return '<tr>' +
        '<td>' + esc(p.no || '-') + '</td>' +
        '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
        '<td>' + esc(p.date || '-') + '</td>' +
        '<td>' + esc(p.status || '-') + '</td>' +
        '<td>' + esc(p.unit || '-') + '</td>' +
        '<td>' + esc(p.agentStatus || '未处理') + '</td>' +
        '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="audit" data-ach-key="' + k + '">' + esc(p.audit) + '</a></td>' +
        opsCell(p) +
        '</tr>';
    }
    if (state.type === '论文') {
      return '<tr>' +
        '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
        '<td>' + esc(p.journal || '-') + '</td>' +
        '<td>' + esc(p.authors || '-') + '</td>' +
        '<td>' + esc(p.date || '-') + '</td>' +
        '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="audit" data-ach-key="' + k + '">' + esc(p.audit) + '</a></td>' +
        '<td>' + esc(p.unit || '-') + '</td>' +
        opsCell(p) +
        '</tr>';
    }
    return '<tr>' +
      '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
      '<td>' + esc(p.date || '-') + '</td>' +
      '<td>' + esc(p.journal || p.status || p.authors || '-') + '</td>' +
      '<td>' + esc(p.unit || '-') + '</td>' +
      '<td>' + esc(p.audit) + '</td>' +
      '<td>' + esc(p.roleType) + '</td>' +
      opsCell(p) +
      '</tr>';
  }

  function bindTableClicks() {
    var tbody = document.getElementById('achTableBody');
    if (!tbody || tbody._achBound) return;
    tbody._achBound = true;
    tbody.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('[data-ach-act]') : null;
      if (!a) return;
      ev.preventDefault();
      var act = a.getAttribute('data-ach-act');
      var key = a.getAttribute('data-ach-key') || '';
      if (act === 'view') achView(key);
      else if (act === 'audit') achShowAuditLogKey(key);
      else if (act === 'delete') achDelete(key);
      else if (act === 'push') achPush(key);
      else if (act === 'unpush') achUnpush(key);
      else if (act === 'verify') achVerifyRun(key);
      else if (act === 'pass') achVerifyPass(key);
      else if (act === 'fail') achVerifyFail(key);
    });
  }

  function workflowRowHtml(p) {
    var k = esc(p._key);
    if (state.sub === 'push') {
      return '<tr>' +
        '<td>' + esc(p._type) + '</td>' +
        '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
        '<td>' + esc(p.date || '-') + '</td>' +
        '<td>' + esc(p.unit || '-') + '</td>' +
        '<td>' + esc(pushStatusLabel(p.pushStatus)) + (p.pushTime ? '<div style="color:#999;font-size:11px">' + esc(p.pushTime) + '</div>' : '') + '</td>' +
        opsCell(p) +
        '</tr>';
    }
    var issueText = (p.verifyIssues && p.verifyIssues.length) ? p.verifyIssues.join('；') : '无问题';
    return '<tr>' +
      '<td>' + esc(p._type) + '</td>' +
      '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
      '<td>' + esc(verifyStatusLabel(p.verifyStatus)) + '</td>' +
      '<td title="' + esc(issueText) + '">' + esc(issueText.length > 28 ? issueText.slice(0, 28) + '…' : issueText) + '</td>' +
      '<td>' + esc(p.verifyTime || '-') + '</td>' +
      opsCell(p) +
      '</tr>';
  }

  function hoistModal() {
    var modal = document.getElementById('achViewModal');
    if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
    return modal;
  }

  function achRender() {
    hoistModal();
    bindTableClicks();
    bindSideClicks();
    ensureAchColFilterReady();
    updatePanelChrome();
    var all = allAchievements();
    updateSide(all);
    var list = filteredList();
    var thead = document.getElementById('achTableHead');
    var tbody = document.getElementById('achTableBody');
    var empty = document.getElementById('achEmpty');
    if (!thead || !tbody) return;

    if (state.sub === 'push') {
      thead.innerHTML = '<tr>' +
        '<th style="width:10%">类型</th><th>名称</th><th style="width:12%">日期</th>' +
        '<th style="width:14%">所属单位</th><th style="width:14%">推送状态</th><th style="width:16%">操作</th></tr>';
    } else if (state.sub === 'verify') {
      thead.innerHTML = '<tr>' +
        '<th style="width:10%">类型</th><th>名称</th><th style="width:12%">核验状态</th>' +
        '<th>问题清单</th><th style="width:12%">核验时间</th><th style="width:18%">操作</th></tr>';
    } else if (!state.type) {
      thead.innerHTML = '<tr>' +
        achColTh('_type', '类型', '10%') +
        achColTh('title', '名称') +
        achColTh('date', '日期', '12%') +
        achColTh('unit', '所属单位', '14%') +
        achColTh('audit', '审核状态', '10%') +
        '<th style="width:10%">操作</th></tr>';
    } else {
      thead.innerHTML = headHtml();
    }
    if (typeof acUpdateColIndicators === 'function') acUpdateColIndicators('myachievements');

    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var rows = list.slice(start, start + PAGE_SIZE);

    if (!rows.length) {
      tbody.innerHTML = '';
      if (empty) {
        empty.style.display = 'block';
        empty.textContent = emptyHint();
      }
    } else {
      if (empty) empty.style.display = 'none';
      if (state.sub === 'push' || state.sub === 'verify') {
        tbody.innerHTML = rows.map(workflowRowHtml).join('');
      } else if (!state.type) {
        tbody.innerHTML = rows.map(function (p) {
          var k = esc(p._key);
          return '<tr><td>' + esc(p._type) + '</td>' +
            '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
            '<td>' + esc(p.date || '-') + '</td>' +
            '<td>' + esc(p.unit || '-') + '</td>' +
            '<td>' + esc(p.audit) + '</td>' +
            opsCell(p) +
            '</tr>';
        }).join('');
      } else {
        tbody.innerHTML = rows.map(rowHtml).join('');
      }
    }

    var pager = document.getElementById('achPager');
    if (pager) {
      pager.innerHTML = '共 ' + pages + ' 页 每页 ' + PAGE_SIZE + ' 条 共 ' + total + ' 条记录' +
        (state.year ? ' · ' + state.year + '年' : '') +
        (state.type ? ' · ' + state.type : '') +
        ' <button type="button" ' + (state.page <= 1 ? 'disabled' : '') + ' onclick="achGotoPage(' + (state.page - 1) + ')">上一页</button>' +
        '<button type="button" ' + (state.page >= pages ? 'disabled' : '') + ' onclick="achGotoPage(' + (state.page + 1) + ')">下一页</button>';
    }
  }

  function achGotoPage(p) {
    state.page = Math.max(1, p);
    achRender();
  }

  function findByKey(key) {
    return allAchievements().find(function (p) { return p._key === key; }) || null;
  }

  function cell(lab, val) {
    return '<td class="lab">' + esc(lab) + '</td><td class="val">' + (val == null || val === '' ? '&nbsp;' : val) + '</td>';
  }

  function cellRaw(lab, html) {
    return '<td class="lab">' + esc(lab) + '</td><td class="val">' + (html || '&nbsp;') + '</td>';
  }

  function tableHtml(headers, rows) {
    if (!rows || !rows.length) return '<div class="ach-null">暂无数据</div>';
    return '<table class="ach-grid"><thead><tr>' +
      headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + r.map(function (c) {
          return '<td>' + (typeof c === 'string' && c.indexOf('<') === 0 ? c : esc(c == null ? '' : c)) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  function tabsFor(p) {
    if (p._type === '专利') return [['info', '基本信息'], ['projects', '依托项目'], ['legal', '专利法律状态']];
    return [['info', '基本信息'], ['projects', '依托项目'], ['reprint', '转载情况']];
  }

  function achView(key) {
    state.currentKey = key;
    var modal = hoistModal();
    if (!modal) { alert('详情窗口未加载，请 Ctrl+F5 刷新'); return; }
    var p = findByKey(key);
    var tabs = document.getElementById('achTabs');
    if (tabs && p) {
      tabs.innerHTML = tabsFor(p).map(function (pair, i) {
        return '<a href="javascript:void(0)" class="ach-tab' + (i === 0 ? ' active' : '') +
          '" data-tab="' + pair[0] + '" onclick="achSwitchTab(\'' + pair[0] + '\',this)">' + pair[1] + '</a>';
      }).join('');
    }
    modal.style.display = 'flex';
    modal.style.zIndex = '20000';
    achSwitchTab('info');
  }

  function achCloseView() {
    var modal = document.getElementById('achViewModal');
    if (modal) modal.style.display = 'none';
    state.currentKey = '';
  }

  function achSwitchTab(tab, btn) {
    if (btn) {
      document.querySelectorAll('#achTabs .ach-tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
    }
    var p = findByKey(state.currentKey);
    var body = document.getElementById('achTabBody');
    if (!body) return;
    if (!p) { body.innerHTML = '<div class="ach-null">成果不存在</div>'; return; }

    if (tab === 'info') {
      if (p._type === '专利') {
        var pdf = p.pdfName ? '<a class="ach-a" href="javascript:void(0)">📄 ' + esc(p.pdfName) + '</a>' : '&nbsp;';
        var rows = Array.isArray(p.authorRows) && p.authorRows.length ? p.authorRows : [];
        if (!rows.length && typeof p.inventors === 'string') rows = defaultPatentAuthors({ inventor: p.inventors });
        body.innerHTML =
          '<div class="ach-sec"><div class="ach-sec-h">基本信息</div><table class="ach-info-table">' +
          '<tr>' + cell('专利名称', esc(p.title)) + cell('专利类型', esc(p.patentType)) + '</tr>' +
          '<tr>' + cell('申请号', esc(p.no)) + cell('申请人', esc(p.applicant)) + '</tr>' +
          '<tr>' + cell('所属单位', esc(p.unit)) + cell('专利状态', esc(p.status)) + '</tr>' +
          '<tr>' + cell('申请日期', esc(p.date)) + cell('所属年度', esc(p.year)) + '</tr>' +
          '</table></div>' +
          '<div class="ach-sec"><div class="ach-sec-h">详细信息</div><table class="ach-info-table">' +
          '<tr>' + cell('合作类型', '独立申请') + cell('单位排名', '第一单位') + '</tr>' +
          '<tr>' + cell('专利范围', '国内') + cell('是否PCT专利', '否') + '</tr>' +
          '<tr>' + cellRaw('专利证书附件', pdf) + cell('代理状态', esc(p.agentStatus)) + '</tr>' +
          '</table></div>' +
          '<div class="ach-sec"><div class="ach-sec-h">作者信息</div>' +
          tableHtml(['署名顺序', '作者类型', '作者姓名', '学历', '职称', '角色类型', '工作单位', '贡献率%'],
            rows.map(function (m) {
              return [m.order, m.type, m.name, m.edu, m.title, m.role || m.duty, m.unit, m.rate || m.contribution || 0];
            })) + '</div>';
        return;
      }

      var pdf2 = p.pdfName ? '<a class="ach-a" href="javascript:void(0)">📄 ' + esc(p.pdfName) + '</a>' : '&nbsp;';
      var arows = Array.isArray(p.authorRows) ? p.authorRows : [];
      body.innerHTML =
        '<div class="ach-sec"><div class="ach-sec-h">基本信息</div><table class="ach-info-table">' +
        '<tr>' + cell('发表/出版日期', esc(p.date)) + cell('刊物/论文集名称', esc(p.journal)) + '</tr>' +
        '<tr>' + cell('论文类型', esc(p.paperType || p._type)) + cell('所属单位', esc(p.unit)) + '</tr>' +
        '<tr>' + cell('刊物级别', esc(p.level || '-')) + cell('收录类别', esc(p.indexCat || '-')) + '</tr>' +
        '<tr>' + cell('DOI', esc(p.doi || '-')) + cellRaw('pdf全文', pdf2) + '</tr>' +
        '<tr>' + cell('检索报告', esc((p.extra && p.extra.reportId) || '-')) + cell('所属年度', esc(p.year)) + '</tr>' +
        '<tr>' + cell('成果名称', esc(p.title)) + cell('审核状态', esc(p.audit)) + '</tr>' +
        '</table></div>' +
        '<div class="ach-sec"><div class="ach-sec-h">详细信息</div><table class="ach-info-table">' +
        '<tr>' + cell('卷/期/页', esc(p.vol || '-')) + cell('SCI论文分区', esc(p.sciZone || '-')) + '</tr>' +
        '<tr>' + cell('影响因子', esc(p.ifactor || '-')) + cell('学校署名', '第一单位') + '</tr>' +
        '<tr>' + cell('ISSN号', esc(p.issn || '-')) + cell('参与形式', esc(p.roleType)) + '</tr>' +
        '</table></div>' +
        '<div class="ach-sec"><div class="ach-sec-h">作者信息</div>' +
        tableHtml(['署名', '作者类型', '作者姓名', '网络用户名', '学历', '职称', '角色类型', '工作单位', '贡献率%'],
          arows.map(function (m) {
            return [m.order, m.type, m.name, m.user || '', m.edu, m.title, m.role, m.unit, m.rate];
          })) + '</div>';
      return;
    }

    if (tab === 'projects') {
      body.innerHTML = '<div class="ach-bar">依托项目列表</div>' +
        tableHtml(['项目名称', '负责人', '所属单位', '立项日期', '合同金额(万元)', '项目成员'],
          (p.projects || []).map(function (x) {
            return [x.name, x.leader, x.unit, x.date, x.amount, x.members];
          }));
      return;
    }

    if (tab === 'reprint' || tab === 'legal') {
      var title = tab === 'legal' ? '专利法律状态' : '转载情况';
      body.innerHTML = '<div class="ach-bar">' + title + '</div>' +
        ((p.reprints && p.reprints.length)
          ? tableHtml(['时间', '内容', '说明'], p.reprints.map(function (r) { return [r.time, r.content, r.note]; }))
          : '<div class="ach-null">暂无记录</div>');
    }
  }

  function achShowAuditLog() { achShowAuditLogKey(state.currentKey); }
  function achShowAuditLogKey(key) {
    var p = findByKey(key);
    if (!p) { alert('无记录'); return; }
    var lines = [
      '审核状态：' + (p.audit || '-'),
      '推送状态：' + pushStatusLabel(p.pushStatus) + (p.pushTime ? '（' + p.pushTime + '）' : ''),
      '核验状态：' + verifyStatusLabel(p.verifyStatus) + (p.verifyTime ? '（' + p.verifyTime + '）' : ''),
      '成果：' + (p.title || '-')
    ];
    if (p.verifyIssues && p.verifyIssues.length) {
      lines.push('核验问题：' + p.verifyIssues.join('；'));
    }
    if (p.pushNote) lines.push('推送说明：' + p.pushNote);
    if (p.verifyNote) lines.push('核验说明：' + p.verifyNote);
    alert(lines.join('\n'));
  }

  function achShowAddHint() {
    alert('新增请使用左侧「成果管理」下的专利/论文等原模块录入，将自动汇总到「我的成果」。\n也可点「示例成果」生成演示数据。');
  }

  function publishPushNotice(p) {
    try {
      if (typeof normalizeNoticeRecord !== 'function' || typeof saveNoticeData !== 'function') return;
      if (!Array.isArray(global.noticeData)) {
        try { global.noticeData = JSON.parse(localStorage.getItem('noticeData') || '[]') || []; } catch (e) { global.noticeData = []; }
      }
      var notice = normalizeNoticeRecord({
        id: Date.now(),
        title: '【所内推送】' + (p._type || '成果') + '：' + (p.title || ''),
        type: 'notice',
        content: '成果「' + (p.title || '') + '」已推送至所内共享。\n类型：' + (p._type || '') +
          '\n单位：' + (p.unit || '') + '\n日期：' + (p.date || '') +
          '\n推送人：' + nowUser(),
        publisher: nowUser(),
        publishTime: nowStamp(),
        audience: 'all',
        pinned: false
      });
      global.noticeData.unshift(notice);
      saveNoticeData({
        silent: false,
        log: { action: '所内推送', desc: (p._type || '') + ' ' + (p.title || '') }
      });
    } catch (e) {
      console.warn('push notice failed', e);
    }
  }

  function achPush(key, silent) {
    var p = findByKey(key);
    if (!p) return false;
    if (p.pushStatus === 'pushed') {
      if (!silent) alert('该成果已推送');
      return false;
    }
    var note = silent ? '批量推送' : prompt('推送说明（可选）', '所内共享');
    if (note == null && !silent) return false;
    patchExtra(key, {
      pushStatus: 'pushed',
      pushTime: nowStamp(),
      pushBy: nowUser(),
      pushNote: note || ''
    });
    publishPushNotice(p);
    if (!silent) {
      achRender();
      alert('已推送到所内，并写入通知中心');
    }
    return true;
  }

  function achUnpush(key) {
    var p = findByKey(key);
    if (!p) return;
    if (!confirm('确定撤回「' + (p.title || '') + '」的所内推送？')) return;
    patchExtra(key, {
      pushStatus: 'none',
      pushTime: '',
      pushBy: '',
      pushNote: ''
    });
    achRender();
    alert('已撤回推送');
  }

  function achBatchPush() {
    var list = allAchievements().filter(function (p) {
      return passFilters(p) && p.pushStatus !== 'pushed';
    });
    if (!list.length) {
      alert('当前筛选下没有待推送成果');
      return;
    }
    if (!confirm('将推送 ' + list.length + ' 条成果到所内，并发布通知，是否继续？')) return;
    var n = 0;
    list.forEach(function (p) {
      if (achPush(p._key, true)) n++;
    });
    achRender();
    alert('已推送 ' + n + ' 条');
  }

  function achVerifyRun(key, silent) {
    var p = findByKey(key);
    if (!p) return null;
    var issues = computeVerifyIssues(p);
    var status = issues.length ? 'failed' : 'passed';
    patchExtra(key, {
      verifyStatus: status,
      verifyIssues: issues,
      verifyTime: nowStamp(),
      verifyNote: issues.length ? ('自动核验：' + issues.join('；')) : '自动核验通过'
    });
    if (!silent) {
      achRender();
      alert(status === 'passed'
        ? '核验通过'
        : ('核验未通过：\n- ' + issues.join('\n- ')));
    }
    return status;
  }

  function achVerifyPass(key) {
    var p = findByKey(key);
    if (!p) return;
    var note = prompt('通过说明（可选）', '人工确认通过');
    if (note == null) return;
    patchExtra(key, {
      verifyStatus: 'passed',
      verifyIssues: [],
      verifyTime: nowStamp(),
      verifyNote: note || '人工确认通过'
    });
    achRender();
  }

  function achVerifyFail(key) {
    var p = findByKey(key);
    if (!p) return;
    var note = prompt('未通过原因', (p.verifyIssues && p.verifyIssues.length) ? p.verifyIssues.join('；') : '信息不完整');
    if (note == null) return;
    var issues = note ? note.split(/[；;]/).map(function (s) { return s.trim(); }).filter(Boolean) : ['信息不完整'];
    patchExtra(key, {
      verifyStatus: 'failed',
      verifyIssues: issues,
      verifyTime: nowStamp(),
      verifyNote: note
    });
    achRender();
  }

  function achBatchVerify() {
    var list = allAchievements().filter(function (p) { return passFilters(p); });
    if (!list.length) {
      alert('当前筛选下没有可核验成果');
      return;
    }
    if (!confirm('将对 ' + list.length + ' 条成果执行自动核验，是否继续？')) return;
    var passed = 0;
    var failed = 0;
    list.forEach(function (p) {
      var st = achVerifyRun(p._key, true);
      if (st === 'passed') passed++;
      else failed++;
    });
    achRender();
    alert('核验完成：通过 ' + passed + ' 条，未通过 ' + failed + ' 条');
  }

  function achDelete(key) {
    var p = findByKey(key);
    if (!p) return;
    var tip = '确定删除「' + (p._type || '成果') + '：' + (p.title || '') + '」？\n将从对应台账中移除，且不可恢复。';
    if (!confirm(tip)) return;

    var store = p._store || '';
    var id = Number(p.id);
    var arr = loadArr(store).filter(function (d) { return Number(d && d.id) !== id; });

    if (store === 'patentMgmtData' || store === 'patentData') {
      saveArr('patentMgmtData', arr);
      saveArr('patentData', arr);
      try {
        window.patentMgmtData = arr;
        window.patentData = arr;
        if (typeof patentMgmtData !== 'undefined') patentMgmtData = arr;
        if (typeof patentData !== 'undefined') patentData = arr;
        if (typeof persistPatentMgmtGlobalMirror === 'function') {
          // persist 会再写一遍当前 patentMgmtData
          patentMgmtData = arr;
          persistPatentMgmtGlobalMirror();
        }
      } catch (ePat) {}
    } else if (store === 'paperData') {
      saveArr('paperData', arr);
      try {
        window.paperData = arr;
        if (typeof paperData !== 'undefined') paperData = arr;
        if (typeof persistPaperGlobalMirror === 'function') {
          paperData = arr;
          persistPaperGlobalMirror();
        }
      } catch (ePaper) {}
    } else {
      saveArr(store, arr);
      try {
        if (store === 'copyrightData') {
          window.copyrightData = arr;
          if (typeof copyrightData !== 'undefined') copyrightData = arr;
        } else if (store === 'standardData') {
          window.standardData = arr;
          if (typeof standardData !== 'undefined') standardData = arr;
        } else if (store === 'competitionData') {
          window.competitionData = arr;
          if (typeof competitionData !== 'undefined') competitionData = arr;
        }
      } catch (eStore) {}
    }

    var extraMap = loadExtra();
    delete extraMap[key];
    saveExtra(extraMap);

    if (state.currentKey === key) achCloseView();
    notifyHomeAchievementChange('ach-delete');
    achRender();
    alert('已删除');
  }

  function achDeleteCurrent() {
    if (!state.currentKey) {
      alert('请先打开要删除的成果');
      return;
    }
    achDelete(state.currentKey);
  }

  function achExportCsv() {
    var list = filteredList();
    if (!list.length) { alert('没有可导出的数据'); return; }
    var csv = '\ufeff类型,名称,日期,所属单位,审核状态,参与形式\n';
    list.forEach(function (p) {
      csv += [p._type, p.title, p.date, p.unit, p.audit, p.roleType]
        .map(function (x) { return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; }).join(',') + '\n';
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = '我的成果_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  }

  function nextId(arr) {
    return arr.length ? Math.max.apply(null, arr.map(function (d) { return Number(d.id) || 0; })) + 1 : 1;
  }

  function achSeedDemo(force) {
    var papers = loadArr('paperData');
    var patents = patentSource();
    var hasPaper = papers.some(function (d) { return d._demo === 1 || d.title === 'Leakage diagnostic method for water supply pipeline based on ground penetrating radar'; });
    var hasPatent = patents.some(function (d) { return d._demo === 1 || /跨界超低频/.test(d.name || ''); });

    if ((!hasPaper || force) && (!hasPaper || force)) {
      if (force) papers = papers.filter(function (d) { return d._demo !== 1; });
      if (!papers.some(function (d) { return d._demo === 1; })) {
        var pid = nextId(papers);
        papers.push({
          id: pid, _demo: 1,
          title: 'Leakage diagnostic method for water supply pipeline based on ground penetrating radar',
          author: '张克静(学),罗钧,罗文文,王丽萍',
          journal: 'MEASUREMENT',
          unit: '土木与水利工程学院',
          index: 'SCI',
          publish_date: '2024-09-30',
          status: '学校通过',
          remark: ''
        });
        saveArr('paperData', papers);
        var pkey = itemKey('论文', pid);
        var ex = loadExtra();
        ex[pkey] = {
          roleType: '主持', paperType: '国际期刊', level: '检索', indexCat: 'SCI',
          doi: '10.1016/j.measurement.2024.115233',
          pdfName: '2024-03Leakage diagnostic method for water supply pipeline based on ground penetrating.pdf',
          vol: '237/115233', sciZone: '二区', ifactor: '5.2', issn: '0263-2241',
          reportId: '2c9c63da922d2d…',
          authorRows: [
            { order: 1, type: '学生', name: '张克静', user: '', edu: '硕士研究生', title: '', role: '第一作者', unit: '土木与水利工程学院', rate: 0 },
            { order: 2, type: '教师', name: '罗钧', user: '', edu: '博士研究生', title: '高级工程师', role: '通讯作者', unit: '土木与水利工程学院', rate: 0 },
            { order: 3, type: '教师', name: '罗文文', user: '', edu: '博士研究生', title: '副教授', role: '参与作者', unit: '土木与水利工程学院', rate: 0 },
            { order: 4, type: '教师', name: '王丽萍', user: '', edu: '博士研究生', title: '教授', role: '参与作者', unit: '科技处（产学研办公室、期刊社）', rate: 0 }
          ],
          projects: defaultLinkedProjects(),
          reprints: []
        };
        saveExtra(ex);
      }
    }

    if (!hasPatent || force) {
      var pats = loadArr('patentMgmtData');
      if (!pats.length) pats = loadArr('patentData');
      if (force) pats = pats.filter(function (d) { return d._demo !== 1; });
      if (!pats.some(function (d) { return d._demo === 1; })) {
        var tid = nextId(pats);
        pats.push({
          id: tid, _demo: 1,
          name: '跨界超低频振动能量捕获智能分析评估系统及方法',
          patent_type: '发明专利',
          patent_number: '202111722139.1',
          application_date: '2021-11-21',
          status: '专利申请',
          applicant: '重庆科技大学',
          inventor: '王丽萍,罗文文,罗莉,任洪强',
          unit: '科技处（产学研办公室、期刊社）'
        });
        saveArr('patentMgmtData', pats);
        saveArr('patentData', pats);
        var tk = itemKey('专利', tid);
        var ex2 = loadExtra();
        ex2[tk] = {
          roleType: '主持', agentStatus: '未处理', auditStatus: '学校通过',
          pdfName: '2021117221391.pdf',
          authorRows: [
            { order: 1, type: '教师', name: '王丽萍', edu: '博士研究生', title: '教授', role: '第一发明人', unit: '科技处（产学研办公室、期刊社）', rate: 25 },
            { order: 2, type: '教师', name: '罗文文', edu: '博士研究生', title: '副教授', role: '参与发明人', unit: '土木与水利工程学院', rate: 25 },
            { order: 3, type: '教师', name: '罗莉', edu: '博士研究生', title: '高级工程师', role: '参与发明人', unit: '安全科学与工程学院', rate: 25 },
            { order: 4, type: '教师', name: '任洪强', edu: '博士研究生', title: '副教授', role: '参与发明人', unit: '土木与水利工程学院', rate: 25 }
          ],
          projects: defaultLinkedProjects()
        };
        saveExtra(ex2);
      }
    }

    achRender();
    return true;
  }

  function initMyAchievements() {
    state.page = 1;
    var root = document.getElementById('my_achievements');
    function ready() {
      hoistModal();
      achSeedDemo(false);
      achRender();
    }
    if (root && !root.querySelector('.ach-root') && typeof window.forceReloadModuleHtml === 'function') {
      Promise.resolve(window.forceReloadModuleHtml('my_achievements')).then(ready);
      return;
    }
    ready();
  }

  global.initMyAchievements = initMyAchievements;
  global.achRender = achRender;
  global.achSetFilter = achSetFilter;
  global.achResetFilters = achResetFilters;
  global.achToggleYears = achToggleYears;
  global.achSetSubNav = achSetSubNav;
  global.achSetPushFilter = achSetPushFilter;
  global.achSetVerifyFilter = achSetVerifyFilter;
  global.achPush = achPush;
  global.achUnpush = achUnpush;
  global.achBatchPush = achBatchPush;
  global.achVerifyRun = achVerifyRun;
  global.achVerifyPass = achVerifyPass;
  global.achVerifyFail = achVerifyFail;
  global.achBatchVerify = achBatchVerify;
  global.achGotoPage = achGotoPage;
  global.achView = achView;
  global.achCloseView = achCloseView;
  global.achSwitchTab = achSwitchTab;
  global.achShowAuditLog = achShowAuditLog;
  global.achShowAuditLogKey = achShowAuditLogKey;
  global.achShowAddHint = achShowAddHint;
  global.achDelete = achDelete;
  global.achDeleteCurrent = achDeleteCurrent;
  global.achExportCsv = achExportCsv;
  global.achSeedDemo = achSeedDemo;
  global.openAchColFilter = openAchColFilter;
  global.allAchievements = allAchievements;
  global.getAchievementOverviewCounts = getAchievementOverviewCounts;
})(typeof window !== 'undefined' ? window : this);
