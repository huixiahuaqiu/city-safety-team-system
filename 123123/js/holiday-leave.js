/**
 * 假期离校/留校填报 — 管理员发布统计表，成员照表填写（对齐 Excel「端午假期离校统计」）
 * 数据：holidayLeaveCampaigns（云端 KV 同步）
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'holidayLeaveCampaigns';
  var REMARK_OPTS = ['回家', '留校', '实习', '其他'];
  var campaigns = [];
  var viewingId = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function nowStr() {
    try { return new Date().toLocaleString('zh-CN'); } catch (e) { return String(new Date()); }
  }

  function currentUser() { return global.currentUser || null; }

  function myName() {
    var u = currentUser();
    return (u && (u.realName || u.username)) || '';
  }

  function canPublish() {
    var u = currentUser();
    if (!u) return false;
    if (u.role === 'admin' || u.role === 'leader') return true;
    return typeof global.hasPermission === 'function' && (
      !!global.hasPermission('请假与申请（流程配置）') ||
      !!global.hasPermission('请假与申请（审批/查看全部）')
    );
  }

  function canEditAll(camp) {
    return canPublish();
  }

  function loadCampaigns() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      campaigns = Array.isArray(raw) ? raw : [];
    } catch (e) { campaigns = []; }
    global.holidayLeaveCampaigns = campaigns;
    return campaigns;
  }

  function saveCampaigns() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(campaigns));
    global.holidayLeaveCampaigns = campaigns;
    try {
      if (typeof global.cloudUpsert === 'function') {
        global.cloudUpsert(STORAGE_KEY, JSON.stringify(campaigns));
      }
    } catch (e) {}
  }

  function mergeIncoming(v) {
    if (Array.isArray(v)) {
      campaigns = v;
      global.holidayLeaveCampaigns = campaigns;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(campaigns)); } catch (e) {}
    }
    return campaigns;
  }

  function memberList() {
    try {
      if (Array.isArray(global.teamMemberData)) return global.teamMemberData;
    } catch (e) {}
    try { return JSON.parse(localStorage.getItem('teamMemberData') || '[]'); } catch (e2) { return []; }
  }

  function gradeYears() {
    if (typeof global.getMemberGradeYears === 'function') {
      try { return global.getMemberGradeYears().slice(); } catch (e) {}
    }
    try {
      var saved = JSON.parse(localStorage.getItem('memberGradeYears') || 'null');
      if (Array.isArray(saved) && saved.length) return saved.map(String);
    } catch (e2) {}
    var set = {};
    memberList().forEach(function (m) {
      if (m && /^20\d{2}$/.test(String(m.category || ''))) set[m.category] = 1;
    });
    return Object.keys(set).sort(function (a, b) { return Number(b) - Number(a); });
  }

  /** 显示用：研一/研二/研三（新年级=研一），表格按研三→研一排列 */
  function gradeDisplay(year, yearsDesc) {
    var y = String(year);
    var idx = yearsDesc.indexOf(y);
    var tag = y + '级';
    if (idx === 0) return '研一（' + tag + '）';
    if (idx === 1) return '研二（' + tag + '）';
    if (idx === 2) return '研三（' + tag + '）';
    if (idx > 2) return '研' + (idx + 1) + '（' + tag + '）';
    return tag;
  }

  function buildRowsFromMembers() {
    var yearsDesc = gradeYears();
    // 表内顺序：老年级在上（研三 → 研一）
    var yearsAsc = yearsDesc.slice().sort(function (a, b) { return Number(a) - Number(b); });
    var rows = [];
    yearsAsc.forEach(function (y) {
      memberList().filter(function (m) {
        return m && String(m.category) === String(y) && m.name &&
          !(typeof global.isMemberGraduated === 'function' ? global.isMemberGraduated(m) : !!m.graduated);
      }).forEach(function (m) {
        rows.push({
          memberId: m.id,
          grade: String(y),
          name: m.name,
          leaveDate: '',
          returnDate: '',
          remark: '',
          filledAt: '',
          filledBy: ''
        });
      });
    });
    return rows;
  }

  function findCamp(id) {
    return campaigns.find(function (c) { return String(c.id) === String(id); }) || null;
  }

  function openCount(camp) {
    if (!camp || !camp.rows) return { total: 0, filled: 0 };
    var total = camp.rows.length;
    var filled = camp.rows.filter(function (r) {
      return !!(r.leaveDate || r.returnDate || r.remark);
    }).length;
    return { total: total, filled: filled };
  }

  function renderHolidayLeaveSection() {
    loadCampaigns();
    var box = document.getElementById('holidayLeaveSection');
    if (!box) return;

    var openCamps = campaigns.filter(function (c) { return c.status !== 'archived'; })
      .sort(function (a, b) { return String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')); });

    var pubBtn = canPublish()
      ? '<button type="button" class="btn" style="padding:8px 14px;font-size:13px;" onclick="hlShowPublishModal()">＋ 发布假期填报</button>'
      : '';

    var cards = openCamps.map(function (c) {
      var st = openCount(c);
      var closed = c.status === 'closed';
      var color = closed ? '#94a3b8' : '#059669';
      var ico = /留校/.test(c.title || '') ? '留' : '假';
      return '<button type="button" class="hl-card" onclick="hlOpenCampaign(\'' + esc(String(c.id)) + '\')">' +
        '<div class="hl-card-ico" style="background:' + color + ';">' + ico + '</div>' +
        '<div class="hl-card-title">' + esc(c.title || '假期填报') + '</div>' +
        '<div class="hl-card-sub">' + (closed ? '已截止 · ' : '进行中 · ') +
        st.filled + '/' + st.total + ' 人已填' +
        (c.deadline ? ' · 截止 ' + esc(c.deadline) : '') +
        '</div></button>';
    }).join('');

    if (!openCamps.length) {
      cards = '<div class="hl-empty">' +
        (canPublish()
          ? '还没有假期填报。点击右上角「发布假期填报」，系统会自动带出各年级名单，大家照着填即可。'
          : '暂无进行中的假期填报，请等待导师/管理员发布。') +
        '</div>';
    }

    box.innerHTML =
      '<div class="hl-wrap">' +
      '<div class="hl-hd">' +
      '<div><div class="hl-hd-title">假期离校 / 留校填报</div>' +
      '<div class="hl-hd-sub">管理员发布假期后，自动加载成员名单；对照 Excel 统计表填写离校、返校与备注</div></div>' +
      '<div>' + pubBtn + '</div></div>' +
      '<div class="hl-cards">' + cards + '</div></div>';
  }

  function hlShowPublishModal() {
    if (!canPublish()) { alert('无发布权限'); return; }
    var rows = buildRowsFromMembers();
    if (!rows.length) {
      alert('团队成员档案中暂无学生年级名单，请先在「团队成员」维护年级后再发布');
      return;
    }
    var modal = document.getElementById('hlPublishModal');
    if (!modal) return;
    document.getElementById('hlPubTitle').value = '';
    document.getElementById('hlPubStart').value = '';
    document.getElementById('hlPubEnd').value = '';
    document.getElementById('hlPubDeadline').value = '';
    document.getElementById('hlPubHint').textContent = '将自动载入 ' + rows.length + ' 名学生（按年级分组，与现用统计表一致）';
    modal.style.display = 'flex';
  }

  function hlClosePublishModal() {
    var modal = document.getElementById('hlPublishModal');
    if (modal) modal.style.display = 'none';
  }

  function hlConfirmPublish() {
    if (!canPublish()) return;
    var title = (document.getElementById('hlPubTitle').value || '').trim();
    if (!title) { alert('请填写假期名称，例如：端午假期离校统计'); return; }
    var rows = buildRowsFromMembers();
    if (!rows.length) { alert('没有可载入的学生名单'); return; }
    var id = 'HL' + Date.now();
    campaigns.unshift({
      id: id,
      title: title,
      holidayStart: (document.getElementById('hlPubStart').value || '').trim(),
      holidayEnd: (document.getElementById('hlPubEnd').value || '').trim(),
      deadline: (document.getElementById('hlPubDeadline').value || '').trim(),
      status: 'open',
      publishedBy: myName(),
      publishedAt: nowStr(),
      rows: rows
    });
    saveCampaigns();
    hlClosePublishModal();
    renderHolidayLeaveSection();
    alert('已发布「' + title + '」，共 ' + rows.length + ' 人。成员可在本页卡片中填写。');
    hlOpenCampaign(id);
  }

  function canEditRow(camp, row) {
    if (!camp || camp.status === 'closed' || camp.status === 'archived') {
      return canEditAll(camp);
    }
    if (canEditAll(camp)) return true;
    var name = myName();
    return !!(name && row && row.name === name);
  }

  function hlOpenCampaign(id) {
    loadCampaigns();
    var camp = findCamp(id);
    if (!camp) { alert('填报不存在或已删除'); return; }
    viewingId = id;
    var modal = document.getElementById('hlViewModal');
    var titleEl = document.getElementById('hlViewTitle');
    var body = document.getElementById('hlViewBody');
    var ft = document.getElementById('hlViewFt');
    if (!modal || !body) return;
    if (titleEl) titleEl.textContent = camp.title || '假期填报';

    var yearsDesc = gradeYears();
    var st = openCount(camp);
    var meta = '<div class="hl-meta">' +
      '发布人：' + esc(camp.publishedBy || '-') +
      ' · ' + esc(camp.publishedAt || '') +
      (camp.holidayStart || camp.holidayEnd ? (' · 假期 ' + esc(camp.holidayStart || '?') + ' ~ ' + esc(camp.holidayEnd || '?')) : '') +
      (camp.deadline ? (' · 截止 ' + esc(camp.deadline)) : '') +
      ' · 已填 ' + st.filled + '/' + st.total +
      (camp.status === 'closed' ? ' · <b style="color:#dc2626;">已截止</b>' : '') +
      '</div>';

    // 按年级分组 rowspan
    var groups = [];
    var map = {};
    (camp.rows || []).forEach(function (r, idx) {
      var g = String(r.grade || '未分级');
      if (!map[g]) {
        map[g] = { grade: g, indices: [] };
        groups.push(map[g]);
      }
      map[g].indices.push(idx);
    });

    var my = myName();
    var html = meta + '<div class="hl-table-wrap"><table class="hl-table">' +
      '<thead><tr><th colspan="5" class="hl-table-title">' + esc(camp.title) + '</th></tr>' +
      '<tr><th style="width:18%">年级</th><th style="width:16%">姓名</th>' +
      '<th style="width:18%">离校日期</th><th style="width:20%">预计返校日期</th><th>备注</th></tr></thead><tbody>';

    groups.forEach(function (g) {
      var label = gradeDisplay(g.grade, yearsDesc);
      g.indices.forEach(function (idx, i) {
        var r = camp.rows[idx];
        var editable = canEditRow(camp, r);
        var mine = my && r.name === my;
        html += '<tr class="' + (mine ? 'hl-mine' : '') + '">';
        if (i === 0) {
          html += '<td class="hl-grade" rowspan="' + g.indices.length + '">' + esc(label) + '</td>';
        }
        html += '<td>' + esc(r.name) + (mine ? ' <span class="hl-me">我</span>' : '') + '</td>';
        if (editable) {
          html += '<td><input class="hl-inp" data-i="' + idx + '" data-f="leaveDate" value="' + esc(r.leaveDate || '') + '" placeholder="如 6.19"></td>';
          html += '<td><input class="hl-inp" data-i="' + idx + '" data-f="returnDate" value="' + esc(r.returnDate || '') + '" placeholder="如 6.21"></td>';
          html += '<td><select class="hl-inp" data-i="' + idx + '" data-f="remark">' +
            '<option value="">（请选择）</option>' +
            REMARK_OPTS.map(function (opt) {
              return '<option value="' + opt + '"' + (r.remark === opt ? ' selected' : '') + '>' + opt + '</option>';
            }).join('') +
            '</select></td>';
        } else {
          html += '<td>' + esc(r.leaveDate || '') + '</td>';
          html += '<td>' + esc(r.returnDate || '') + '</td>';
          html += '<td>' + esc(r.remark || '') + '</td>';
        }
        html += '</tr>';
      });
    });

    html += '</tbody></table></div>';
    if (!canPublish() && camp.status === 'open') {
      html += '<p class="hl-tip">请找到自己的姓名行填写；填完后点底部「保存我的填写」。</p>';
    }
    body.innerHTML = html;

    var btns = '';
    if (camp.status === 'open' || canEditAll(camp)) {
      btns += '<button type="button" class="btn" onclick="hlSaveCurrent()">保存我的填写</button>';
    }
    if (canPublish()) {
      btns += '<button type="button" class="btn btn-secondary" onclick="hlExportCsv(\'' + esc(String(camp.id)) + '\')">导出 Excel(CSV)</button>';
      if (camp.status === 'open') {
        btns += '<button type="button" class="btn btn-secondary" onclick="hlCloseCampaign(\'' + esc(String(camp.id)) + '\')">截止填报</button>';
      } else {
        btns += '<button type="button" class="btn btn-secondary" onclick="hlReopenCampaign(\'' + esc(String(camp.id)) + '\')">重新开放</button>';
      }
      btns += '<button type="button" class="btn btn-secondary" onclick="hlSyncMembers(\'' + esc(String(camp.id)) + '\')">同步最新名单</button>';
    }
    btns += '<button type="button" class="btn btn-secondary" onclick="hlCloseView()">关闭</button>';
    if (ft) ft.innerHTML = btns;

    modal.style.display = 'flex';
  }

  function hlCloseView() {
    var modal = document.getElementById('hlViewModal');
    if (modal) modal.style.display = 'none';
    viewingId = null;
    renderHolidayLeaveSection();
  }

  function readInputsIntoCamp(camp) {
    var body = document.getElementById('hlViewBody');
    if (!body || !camp) return;
    body.querySelectorAll('.hl-inp').forEach(function (el) {
      var i = Number(el.getAttribute('data-i'));
      var f = el.getAttribute('data-f');
      if (!camp.rows[i] || !f) return;
      if (!canEditRow(camp, camp.rows[i])) return;
      camp.rows[i][f] = el.value;
      if (el.value) {
        camp.rows[i].filledAt = nowStr();
        camp.rows[i].filledBy = myName();
      }
    });
  }

  function hlSaveCurrent() {
    loadCampaigns();
    var camp = findCamp(viewingId);
    if (!camp) return;
    readInputsIntoCamp(camp);
    saveCampaigns();
    alert('已保存');
    hlOpenCampaign(camp.id);
  }

  function hlCloseCampaign(id) {
    if (!canPublish()) return;
    var camp = findCamp(id);
    if (!camp) return;
    if (!confirm('截止后成员将无法再改自己的填写，确认？')) return;
    camp.status = 'closed';
    saveCampaigns();
    hlOpenCampaign(id);
  }

  function hlReopenCampaign(id) {
    if (!canPublish()) return;
    var camp = findCamp(id);
    if (!camp) return;
    camp.status = 'open';
    saveCampaigns();
    hlOpenCampaign(id);
  }

  function hlSyncMembers(id) {
    if (!canPublish()) return;
    var camp = findCamp(id);
    if (!camp) return;
    if (!confirm('将按最新成员档案补全名单（已有填写会保留），确认？')) return;
    var fresh = buildRowsFromMembers();
    var byKey = {};
    (camp.rows || []).forEach(function (r) {
      byKey[String(r.memberId) + '|' + r.name] = r;
    });
    camp.rows = fresh.map(function (r) {
      var old = byKey[String(r.memberId) + '|' + r.name] || byKey['|' + r.name];
      if (!old) return r;
      return Object.assign({}, r, {
        leaveDate: old.leaveDate || '',
        returnDate: old.returnDate || '',
        remark: old.remark || '',
        filledAt: old.filledAt || '',
        filledBy: old.filledBy || ''
      });
    });
    saveCampaigns();
    alert('名单已同步，共 ' + camp.rows.length + ' 人');
    hlOpenCampaign(id);
  }

  function hlExportCsv(id) {
    var camp = findCamp(id);
    if (!camp) return;
    var yearsDesc = gradeYears();
    var csv = '\ufeff年级,姓名,离校日期,预计返校日期,备注\n';
    (camp.rows || []).forEach(function (r) {
      csv += [gradeDisplay(r.grade, yearsDesc), r.name, r.leaveDate, r.returnDate, r.remark]
        .map(function (x) { return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; })
        .join(',') + '\n';
    });
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (camp.title || '假期离校统计') + '.csv';
    a.click();
  }

  function initHolidayLeave() {
    var section = document.getElementById('holidayLeaveSection');
    if (!section && typeof global.forceReloadModuleHtml === 'function') {
      Promise.resolve(global.forceReloadModuleHtml('application_center')).then(function () {
        loadCampaigns();
        renderHolidayLeaveSection();
        try { if (typeof global.renderApplicationCenter === 'function') global.renderApplicationCenter(); } catch (e) {}
      });
      return;
    }
    loadCampaigns();
    renderHolidayLeaveSection();
  }

  global.holidayLeaveCampaigns = campaigns;
  global.mergeIncomingHolidayLeaveCampaigns = mergeIncoming;
  global.initHolidayLeave = initHolidayLeave;
  global.renderHolidayLeaveSection = renderHolidayLeaveSection;
  global.hlShowPublishModal = hlShowPublishModal;
  global.hlClosePublishModal = hlClosePublishModal;
  global.hlConfirmPublish = hlConfirmPublish;
  global.hlOpenCampaign = hlOpenCampaign;
  global.hlCloseView = hlCloseView;
  global.hlSaveCurrent = hlSaveCurrent;
  global.hlCloseCampaign = hlCloseCampaign;
  global.hlReopenCampaign = hlReopenCampaign;
  global.hlSyncMembers = hlSyncMembers;
  global.hlExportCsv = hlExportCsv;

  try { loadCampaigns(); } catch (e) {}
})(typeof window !== 'undefined' ? window : this);
