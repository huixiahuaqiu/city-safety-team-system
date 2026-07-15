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
    type: '专利',
    role: '',
    year: '',
    page: 1,
    currentKey: '',
    yearsCollapsed: false,
    sub: 'all'
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
    try { if (typeof cloudUpsert === 'function') cloudUpsert(key, JSON.stringify(arr || [])); } catch (e) {}
  }

  function loadExtra() {
    try { return JSON.parse(localStorage.getItem('researchAchievementExtra') || '{}') || {}; }
    catch (e) { return {}; }
  }

  function saveExtra(map) {
    localStorage.setItem('researchAchievementExtra', JSON.stringify(map || {}));
    try { if (typeof cloudUpsert === 'function') cloudUpsert('researchAchievementExtra', JSON.stringify(map || {})); } catch (e) {}
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
    return list;
  }

  function filteredList() {
    return allAchievements().filter(function (p) {
      if (state.type && p._type !== state.type) return false;
      if (state.role && p.roleType !== state.role) return false;
      if (state.year && p.year !== state.year) return false;
      return true;
    });
  }

  function achSetFilter(kind, value, el) {
    if (kind === 'type') state.type = value;
    if (kind === 'role') state.role = (state.role === value ? '' : value);
    if (kind === 'year') state.year = (state.year === value ? '' : value);
    state.page = 1;
    achRender();
  }

  function achResetFilters() {
    state.type = '';
    state.role = '';
    state.year = '';
    state.page = 1;
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
    state.sub = name;
    if (name !== 'all') alert('「' + (el ? el.textContent : name) + '」可后续对接推送/核验流程，当前请先使用「所有成果」');
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
    set('achCntHost', all.filter(function (p) { return p.roleType === '主持'; }).length);
    set('achCntJoin', all.filter(function (p) { return p.roleType === '参与'; }).length);

    document.querySelectorAll('#achSide [data-ach-type]').forEach(function (el) {
      el.classList.toggle('active', String(el.getAttribute('data-ach-type')) === String(state.type));
    });
    document.querySelectorAll('#achSide [data-ach-role]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-ach-role') === state.role && !!state.role);
    });

    var yearMap = {};
    all.forEach(function (p) { yearMap[p.year] = (yearMap[p.year] || 0) + 1; });
    var years = Object.keys(yearMap).filter(function (y) { return y !== '其他'; })
      .sort(function (a, b) { return Number(a) - Number(b); });
    if (yearMap['其他']) years.push('其他');
    var box = document.getElementById('achYearList');
    if (!box) return;
    box.innerHTML = years.map(function (y) {
      return '<a href="javascript:void(0)" class="ach-side-a' + (state.year === y ? ' active' : '') +
        '" data-ach-year="' + esc(y) + '" onclick="achSetFilter(\'year\',\'' + esc(y) + '\',this)">' +
        esc(y) + '<span class="ach-badge">' + yearMap[y] + '</span></a>';
    }).join('');
    if (state.yearsCollapsed) box.style.display = 'none';
  }

  function headHtml() {
    var t = state.type;
    if (t === '专利') {
      return '<tr><th style="width:14%">申请号</th><th>专利名称</th><th style="width:11%">申请日期</th><th style="width:10%">专利状态</th><th style="width:16%">所属单位</th><th style="width:9%">代理状态</th><th style="width:10%">审核状态</th></tr>';
    }
    if (t === '论文' || t === '') {
      return '<tr><th>名称</th><th style="width:16%">刊物/论文集名称</th><th style="width:18%">所有作者</th><th style="width:11%">发表/出版日期</th><th style="width:10%">审核状态</th><th style="width:14%">所属单位</th><th style="width:8%">操作</th></tr>';
    }
    return '<tr><th>名称</th><th style="width:14%">日期</th><th style="width:18%">相关信息</th><th style="width:14%">所属单位</th><th style="width:10%">审核状态</th><th style="width:10%">参与形式</th></tr>';
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
        '<td></td></tr>';
    }
    return '<tr>' +
      '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
      '<td>' + esc(p.date || '-') + '</td>' +
      '<td>' + esc(p.journal || p.status || p.authors || '-') + '</td>' +
      '<td>' + esc(p.unit || '-') + '</td>' +
      '<td>' + esc(p.audit) + '</td>' +
      '<td>' + esc(p.roleType) + '</td></tr>';
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
    });
  }

  function hoistModal() {
    var modal = document.getElementById('achViewModal');
    if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
    return modal;
  }

  function achRender() {
    hoistModal();
    bindTableClicks();
    var all = allAchievements();
    updateSide(all);
    var list = filteredList();
    // 全部类型时用论文列样式展示混合列表（名称优先）
    var thead = document.getElementById('achTableHead');
    var tbody = document.getElementById('achTableBody');
    var empty = document.getElementById('achEmpty');
    if (!thead || !tbody) return;

    if (!state.type) {
      thead.innerHTML = '<tr><th style="width:10%">类型</th><th>名称</th><th style="width:12%">日期</th><th style="width:14%">所属单位</th><th style="width:10%">审核状态</th></tr>';
    } else {
      thead.innerHTML = headHtml();
    }

    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var rows = list.slice(start, start + PAGE_SIZE);

    if (!rows.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      if (!state.type) {
        tbody.innerHTML = rows.map(function (p) {
          var k = esc(p._key);
          return '<tr><td>' + esc(p._type) + '</td>' +
            '<td><a class="ach-a" href="javascript:void(0)" data-ach-act="view" data-ach-key="' + k + '">' + esc(p.title || '-') + '</a></td>' +
            '<td>' + esc(p.date || '-') + '</td>' +
            '<td>' + esc(p.unit || '-') + '</td>' +
            '<td>' + esc(p.audit) + '</td></tr>';
        }).join('');
      } else {
        tbody.innerHTML = rows.map(rowHtml).join('');
      }
    }

    var pager = document.getElementById('achPager');
    if (pager) {
      pager.innerHTML = '共 ' + pages + ' 页 每页 ' + PAGE_SIZE + ' 条 共 ' + total + ' 条记录' +
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
    alert(p ? ('审核状态：' + p.audit + '\n成果：' + p.title) : '无记录');
  }

  function achShowAddHint() {
    alert('新增请使用左侧「成果管理」下的专利/论文等原模块录入，将自动汇总到「我的成果」。\n也可点「示例成果」生成演示数据。');
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

    if (!state.type) state.type = '专利';
    achRender();
    return true;
  }

  function initMyAchievements() {
    state.page = 1;
    var root = document.getElementById('my_achievements');
    function ready() {
      hoistModal();
      achSeedDemo(false);
      if (!state.type) state.type = '专利';
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
  global.achGotoPage = achGotoPage;
  global.achView = achView;
  global.achCloseView = achCloseView;
  global.achSwitchTab = achSwitchTab;
  global.achShowAuditLog = achShowAuditLog;
  global.achShowAuditLogKey = achShowAuditLogKey;
  global.achShowAddHint = achShowAddHint;
  global.achExportCsv = achExportCsv;
  global.achSeedDemo = achSeedDemo;
})(typeof window !== 'undefined' ? window : this);
