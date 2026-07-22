    // ===== 常量 =====
    const DEFAULT_PASSWORD = '123456';
    const TOKEN_EXPIRE_MS = 24 * 60 * 60 * 1000;
    const ROLE_LABELS = { admin: '导师', leader: '组长', student: '学生', visitor: '访客' };
    const ROLE_BADGE_CLASS = { admin: 'admin', leader: 'leader', student: 'student', visitor: 'visitor' };
    const GROUPS = ['第一小组', '第二小组', '第三小组', '第四小组'];

    // 默认权限矩阵 [功能模块, admin, leader, student, visitor]
    const DEFAULT_PERMISSIONS = [
        ['首页概览', true, true, true, true],
        ['团队成员档案（查看全组）', true, true, false, false],
        ['团队成员档案（仅自己）', true, true, true, false],
        ['团队成员档案（编辑）', true, false, false, false],
        ['角色权限管理', true, false, false, false],
        ['内部任务待办（查看全部）', true, true, false, false],
        ['内部任务待办（查看自己的）', true, true, true, false],
        ['内部任务待办（创建/分配）', true, true, false, false],
        ['团队工作周报（查看全部）', true, true, false, false],
        ['团队工作周报（提交自己的）', true, true, true, false],
        ['团队工作周报（审核）', true, true, false, false],
        ['请假与申请（提交自己的）', true, true, true, false],
        ['请假与申请（本组审批）', true, true, false, false],
        ['请假与申请（审批/查看全部）', true, false, false, false],
        ['请假与申请（流程配置）', true, false, false, false],
        ['项目管理（查看）', true, true, true, false],
        ['项目管理（编辑）', true, false, false, false],
        ['成果管理（查看）', true, true, true, false],
        ['成果管理（编辑）', true, false, false, false],
        ['智能工具（全部）', true, true, true, false],
        ['资源中心（查看）', true, true, true, true],
        ['资源中心（上传/编辑）', true, true, false, false],
        ['账号管理（新建/删除）', true, false, false, false],
        ['账号管理（查看列表）', true, true, false, false],
        ['系统设置', true, false, false, false],
        ['操作日志', true, false, false, false],
        ['数据备份', true, false, false, false],
    ];

    let accountData = [];
    let loginLogData = [];
    let permissionMatrix = [];
    let passwordPolicy = { requireUpper: false, requireLower: true, requireDigit: true, requireSpecial: false, minLength: 8 };
    let loginAttempts = {};
    let currentUser = null;
    let accountPage = 1;
    const ACCOUNTS_PER_PAGE = 10;

    function initAccountSystem() {
        // 先本地恢复登录态，再后台拉云端——避免「刷新必掉线」
        var start = function(fromCloud) {
            try {
                accountData = JSON.parse(localStorage.getItem('accountData') || 'null');
            } catch (eAcc) { accountData = null; }

            const defaults = [
                { id: 5, studentId: 'visitor01', realName: '访客', role: 'visitor', group: '', grade: '', research: '', phone: '', email: 'visitor@example.com', mustChangePwd: true, firstLogin: true, fromTeam: false }
            ];

            if (!accountData) { accountData = []; }
            let changed = false;
            defaults.forEach(def => {
                if (!accountData.find(a => a.studentId === def.studentId)) {
                    const maxId = accountData.length > 0 ? Math.max(...accountData.map(a => a.id)) : 0;
                    accountData.push({
                        ...def, id: Math.max(def.id, maxId + 1),
                        status: 'active', password: DEFAULT_PASSWORD,
                        lastLogin: '', lastLoginIp: '', createdAt: new Date().toISOString().split('T')[0],
                        loginFailCount: 0, lockedUntil: null, avatar: ''
                    });
                    changed = true;
                }
            });
            if (migrateDemoAccountNames()) changed = true;
            if (changed) saveAccountData();

            // 先恢复会话到 currentUser，再做团队联动，避免刷新时把登录账号当孤儿删掉
            var hadSession = tryRestoreSessionFromStorage();

            try {
                var rawTeam = localStorage.getItem('teamMemberData');
                if (rawTeam && typeof syncTeamMembersAcrossSystem === 'function') {
                    var parsedTeam = JSON.parse(rawTeam);
                    if (Array.isArray(parsedTeam) && parsedTeam.length && typeof teamMemberData !== 'undefined') {
                        teamMemberData = parsedTeam;
                        syncTeamMembersAcrossSystem({ preserveSessionUser: true });
                        // 联动后 id 可能变化，再匹配一次
                        if (hadSession) tryRestoreSessionFromStorage();
                    }
                }
            } catch (eTeamSync) {}
            loginLogData = JSON.parse(localStorage.getItem('loginLogData') || '[]');
            permissionMatrix = JSON.parse(localStorage.getItem('permissionMatrix') || 'null');
            if (!permissionMatrix) {
                permissionMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
                savePermissionData();
            } else {
                mergePermissionMatrixDefaults();
            }
            const p = localStorage.getItem('passwordPolicy'); if (p) passwordPolicy = JSON.parse(p);
            const a = localStorage.getItem('loginAttempts'); if (a) loginAttempts = JSON.parse(a);

            if (currentUser || tryRestoreSessionFromStorage()) {
                enterSystem();
                return;
            }

            document.getElementById('loginOverlay').classList.add('active'); initLoginMotion();
            ensureTeamAccountsReady();
            refreshLoginDemoChips();
            document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
            document.getElementById('loginUsername').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('loginPassword').focus(); });
        };

        // 1) 立即用本地数据尝试恢复（刷新不掉线）
        start(false);

        // 2) 后台同步云端；若本地未登录成功、云端回来后再试一次恢复
        if (typeof pullAllFromCloud === 'function') {
            pullAllFromCloud({ silent: true }).then(function() {
                try {
                    var rawAcc = localStorage.getItem('accountData');
                    if (rawAcc) accountData = JSON.parse(rawAcc);
                } catch (e) {}
                if (migrateDemoAccountNames()) saveAccountData();
                if (!currentUser && tryRestoreSessionFromStorage()) {
                    enterSystem();
                } else if (currentUser && typeof onCloudAccountPermissionHydrated === 'function') {
                    onCloudAccountPermissionHydrated();
                    try { if (typeof rematchSessionAfterAccountSync === 'function') rematchSessionAfterAccountSync(); } catch (eR) {}
                    try { updateHeaderUserInfo(); } catch (eH) {}
                }
            }).catch(function() {});
        }
    }

    /** 从 localStorage 恢复会话；找不到用户时不轻易清除 session（避免云端未就绪误踢） */
    function tryRestoreSessionFromStorage() {
        var session = null;
        try { session = JSON.parse(localStorage.getItem('currentSession') || 'null'); } catch (e) { session = null; }
        if (!session || !session.loginTime) return false;
        if (Date.now() - Number(session.loginTime) >= TOKEN_EXPIRE_MS) {
            localStorage.removeItem('currentSession');
            return false;
        }
        var user = findAccountForSession(session);
        if (!user) return false;
        if (user.status && user.status !== 'active') {
            localStorage.removeItem('currentSession');
            return false;
        }
        currentUser = user;
        try { window.currentUser = currentUser; } catch (eSync) {}
        // 回写补全 studentId，便于后续 id 变动时仍能匹配
        try {
            localStorage.setItem('currentSession', JSON.stringify({
                userId: user.id,
                studentId: user.studentId || session.studentId || '',
                loginTime: session.loginTime
            }));
        } catch (eSave) {}
        return true;
    }

    function findAccountForSession(session) {
        if (!session || !Array.isArray(accountData)) return null;
        var byId = accountData.find(function(u) {
            return Number(u.id) === Number(session.userId);
        });
        if (byId) return byId;
        if (session.studentId) {
            return accountData.find(function(u) {
                return String(u.studentId || '') === String(session.studentId);
            }) || null;
        }
        return null;
    }

    function mergePermissionMatrixDefaults() {
        if (!Array.isArray(permissionMatrix)) {
            permissionMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
            savePermissionData();
            return;
        }
        let changed = false;
        DEFAULT_PERMISSIONS.forEach(function(defRow) {
            if (!permissionMatrix.find(function(p) { return p[0] === defRow[0]; })) {
                permissionMatrix.push(JSON.parse(JSON.stringify(defRow)));
                changed = true;
            }
        });
        if (changed) savePermissionData();
    }

    /** 将历史演示姓名（张教授等）替换为团队真实成员，并回写云端 */
    function migrateDemoAccountNames() {
        if (!Array.isArray(accountData) || !accountData.length) return false;
        const demoNameFix = {
            '张教授': { realName: '王丽萍', research: '城市安全、智能运维、结构抗震', phone: '13996488662', email: 'wangliping98@163.com' },
            '李副教授': { realName: '罗文文', research: '工程结构抗震与城市灾害风险研究', phone: '18523539873', email: 'luowenwen326@163.com' },
            '王师兄': { realName: '王明', research: '自然语言处理、知识图谱', phone: '13800002001', email: 'wangm@university.edu.cn' },
            '李明': { realName: '陈浩', research: '深度学习、图像分割', phone: '13800003001', email: 'chenh@university.edu.cn' },
            '陈交换生': { realName: '访客', research: '', phone: '', email: 'visitor@example.com' }
        };
        let changed = false;
        accountData.forEach(function(a) {
            let fix = demoNameFix[a.realName];
            // admin 旧邮箱也强制纠正
            if (!fix && a.studentId === 'admin' && (a.realName === '张教授' || a.email === 'zhang@university.edu.cn')) {
                fix = demoNameFix['张教授'];
            }
            if (!fix) return;
            a.realName = fix.realName;
            if (fix.research) a.research = fix.research;
            if (fix.phone) a.phone = fix.phone;
            if (fix.email) a.email = fix.email;
            changed = true;
        });
        return changed;
    }

    function saveAccountData() {
        localStorage.setItem('accountData', JSON.stringify(accountData));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('accountData', JSON.stringify(accountData)); } catch (e) {}
    }
    function savePermissionData() {
        localStorage.setItem('permissionMatrix', JSON.stringify(permissionMatrix));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('permissionMatrix', JSON.stringify(permissionMatrix)); } catch (e) {}
    }

    /** 云端拉取后刷新账号/权限内存与界面（全局同步核心） */
    function onCloudAccountPermissionHydrated() {
        try {
            var rawAcc = localStorage.getItem('accountData');
            if (rawAcc) accountData = JSON.parse(rawAcc);
        } catch (e) {}
        try { if (typeof applyPendingPasswordCommit === 'function') applyPendingPasswordCommit(); } catch (eP) {}
        if (migrateDemoAccountNames()) saveAccountData();
        try {
            var rawPerm = localStorage.getItem('permissionMatrix');
            if (rawPerm) {
                permissionMatrix = JSON.parse(rawPerm);
                mergePermissionMatrixDefaults();
            }
        } catch (e) {}
        try {
            var rawPolicy = localStorage.getItem('passwordPolicy');
            if (rawPolicy) passwordPolicy = JSON.parse(rawPolicy);
        } catch (e) {}

        if (currentUser) {
            var fresh = findAccountRecordForUser(currentUser);
            if (!fresh) {
                // 云端暂未带回账号：保留当前会话，不踢出
                try { window.currentUser = currentUser; window.accountData = accountData; } catch (eSync) {}
                return;
            }
            if (fresh) {
                currentUser = fresh;
                if (fresh.status !== 'active') {
                    alert('当前账号已被禁用，请重新登录');
                    currentUser = null;
                    try { window.currentUser = null; } catch (e) {}
                    localStorage.removeItem('currentSession');
                    document.getElementById('loginOverlay').classList.add('active');
                    initLoginMotion();
                    return;
                }
                try {
                    localStorage.setItem('currentSession', JSON.stringify({
                        userId: fresh.id,
                        studentId: fresh.studentId || '',
                        loginTime: (function() {
                            try {
                                var s = JSON.parse(localStorage.getItem('currentSession') || 'null');
                                return (s && s.loginTime) || Date.now();
                            } catch (e) { return Date.now(); }
                        })()
                    }));
                } catch (eS) {}
                try { window.currentUser = currentUser; window.accountData = accountData; } catch (eSync) {}
                updateHeaderUserInfo();
                applyRolePermissions();
                try { if (typeof enforceMustChangePasswordGate === 'function') enforceMustChangePasswordGate(); } catch (eG) {}
            }
        }
    }

    // ===== 2. 登录 / 登出 =====

    function initLoginMotion() {
        const overlay = document.getElementById('loginOverlay');
        const layer = document.getElementById('loginParticles');
        const box = document.getElementById('loginBox');
        if (!overlay || !layer) return;
        if (layer.dataset.ready === '1') {
            restoreRememberedLogin();
            return;
        }
        layer.dataset.ready = '1';

        const count = 28;
        for (let i = 0; i < count; i++) {
            const p = document.createElement('span');
            p.className = 'login-particle';
            const size = 2 + Math.random() * 4;
            const left = Math.random() * 100;
            const dur = 8 + Math.random() * 12;
            const delay = Math.random() * 10;
            const dx = (Math.random() * 140 - 70).toFixed(1) + 'px';
            p.style.width = size + 'px';
            p.style.height = size + 'px';
            p.style.left = left + '%';
            p.style.setProperty('--dx', dx);
            p.style.animationDuration = dur + 's';
            p.style.animationDelay = delay + 's';
            if (Math.random() > 0.55) p.style.background = 'rgba(165, 243, 252, 0.95)';
            layer.appendChild(p);
        }

        if (box && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            overlay.addEventListener('mousemove', (e) => {
                const x = (e.clientX / window.innerWidth - 0.5) * 10;
                const y = (e.clientY / window.innerHeight - 0.5) * 8;
                box.style.transform = `translate3d(${x}px, ${y}px, 0)`;
            });
            overlay.addEventListener('mouseleave', () => {
                box.style.transform = 'translate3d(0, 0, 0)';
            });
        }
        restoreRememberedLogin();
    }

    function restoreRememberedLogin() {
        try {
            const remembered = localStorage.getItem('loginRememberedUser') || '';
            const userEl = document.getElementById('loginUsername');
            const rememberEl = document.getElementById('loginRemember');
            if (userEl && remembered && !userEl.value) userEl.value = remembered;
            if (rememberEl && remembered) rememberEl.checked = true;
        } catch (e) {}
    }

    function toggleLoginDemoPanel() {
        const panel = document.getElementById('loginDemoPanel');
        const btn = document.querySelector('.login-demo-toggle');
        if (!panel) return;
        const open = panel.hasAttribute('hidden');
        if (open) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        if (btn) btn.textContent = open ? '演示账号 ▴' : '演示账号 ▾';
        if (open) refreshLoginDemoChips();
    }

    function fillLoginDemo(studentId) {
        ensureTeamAccountsReady();
        refreshLoginDemoChips();
        const resolved = resolveDemoLoginId(studentId);
        const u = document.getElementById('loginUsername');
        const p = document.getElementById('loginPassword');
        if (u) u.value = resolved || studentId || '';
        if (p) p.value = '123456';
        const err = document.getElementById('loginError');
        if (err) err.textContent = '';
        if (p) p.focus();
    }

    function toggleLoginPasswordVisibility() {
        const pwd = document.getElementById('loginPassword');
        pwd.type = pwd.type === 'password' ? 'text' : 'password';
    }

    /** 登录前确保团队成员已同步生成账号 */
    function ensureTeamAccountsReady() {
        try {
            var rawTeam = localStorage.getItem('teamMemberData');
            if (rawTeam) {
                var parsed = JSON.parse(rawTeam);
                if (Array.isArray(parsed) && parsed.length) {
                    try { teamMemberData = parsed; } catch (eT) { window.teamMemberData = parsed; }
                    if (typeof syncTeamMembersAcrossSystem === 'function') {
                        syncTeamMembersAcrossSystem({ preserveSessionUser: true });
                    }
                }
            }
        } catch (e) {}
        try {
            var rawAcc = localStorage.getItem('accountData');
            if (rawAcc) accountData = JSON.parse(rawAcc);
        } catch (e2) {}
        try { window.accountData = accountData; } catch (e3) {}
        ensureDemoLoginAliases();
    }

    /** 保证演示账号 admin / leader01 / stu001 总能落到真实账号上 */
    function ensureDemoLoginAliases() {
        if (!Array.isArray(accountData) || !accountData.length) return;
        var changed = false;
        function pick(rolePrefer) {
            var list = accountData.filter(function(a) {
                return a && a.role !== 'visitor' && a.status !== 'disabled';
            });
            var hit = list.find(function(a) { return a.role === rolePrefer; });
            return hit || list[0] || null;
        }
        function bindAlias(alias, account) {
            if (!account || !alias) return;
            if (String(account.studentId) === alias) return;
            if (!Array.isArray(account.loginAliases)) account.loginAliases = [];
            // 先清掉其他账号上的同名别名，避免冲突
            accountData.forEach(function(a) {
                if (!a || a === account || !Array.isArray(a.loginAliases)) return;
                var i = a.loginAliases.indexOf(alias);
                if (i >= 0) { a.loginAliases.splice(i, 1); changed = true; }
            });
            if (account.loginAliases.indexOf(alias) < 0) {
                account.loginAliases.push(alias);
                changed = true;
            }
        }
        var hasExact = function(id) {
            return accountData.some(function(a) {
                return a && (String(a.studentId) === id || (Array.isArray(a.loginAliases) && a.loginAliases.indexOf(id) >= 0));
            });
        };
        if (!hasExact('admin')) bindAlias('admin', pick('admin'));
        if (!hasExact('leader01')) bindAlias('leader01', pick('leader') || pick('student'));
        if (!hasExact('stu001')) bindAlias('stu001', pick('student'));
        if (changed) saveAccountData();
    }

    function findAccountForLogin(loginId) {
        var id = String(loginId || '').trim();
        if (!id || !Array.isArray(accountData)) return null;
        var idLower = id.toLowerCase();
        var digits = id.replace(/\D/g, '');
        return accountData.find(function(a) {
            if (!a) return false;
            if (String(a.studentId || '') === id) return true;
            if (Array.isArray(a.loginAliases) && a.loginAliases.indexOf(id) >= 0) return true;
            if (digits.length >= 11) {
                var phone = String(a.phone || '').replace(/\D/g, '');
                if (phone === digits) return true;
                if (String(a.studentId || '').replace(/\D/g, '') === digits) return true;
            }
            if (a.email) {
                var email = String(a.email).toLowerCase();
                if (email === idLower) return true;
                if (email.split('@')[0] === idLower) return true;
            }
            return false;
        }) || null;
    }

    function resolveDemoLoginId(preferred) {
        ensureDemoLoginAliases();
        var acc = findAccountForLogin(preferred);
        if (acc) return preferred;
        // 回退到角色对应真实学号
        var roleMap = { admin: 'admin', leader01: 'leader', stu001: 'student', visitor01: 'visitor' };
        var role = roleMap[preferred];
        if (role === 'visitor') return 'visitor01';
        var hit = accountData.find(function(a) { return a && a.role === role && a.status !== 'disabled'; });
        return hit ? hit.studentId : preferred;
    }

    function refreshLoginDemoChips() {
        ensureDemoLoginAliases();
        var box = document.querySelector('#loginDemoPanel .login-demo-chips');
        if (!box) return;
        function labelFor(preferred, roleFallback, fallbackText) {
            var acc = findAccountForLogin(preferred);
            if (!acc && roleFallback) {
                acc = accountData.find(function(a) { return a && a.role === roleFallback && a.status !== 'disabled'; });
            }
            if (!acc) return fallbackText;
            var sid = preferred;
            if (String(acc.studentId) !== preferred && !(acc.loginAliases || []).includes(preferred)) {
                sid = acc.studentId;
            }
            return (ROLE_LABELS[acc.role] || '') + ' ' + sid + (acc.realName ? '（' + acc.realName + '）' : '');
        }
        box.innerHTML =
            '<button type="button" onclick="fillLoginDemo(\'admin\')">' + labelFor('admin', 'admin', '导师 admin') + '</button>' +
            '<button type="button" onclick="fillLoginDemo(\'leader01\')">' + labelFor('leader01', 'leader', '组长 leader01') + '</button>' +
            '<button type="button" onclick="fillLoginDemo(\'stu001\')">' + labelFor('stu001', 'student', '学生 stu001') + '</button>' +
            '<button type="button" onclick="fillLoginDemo(\'visitor01\')">访客 visitor01</button>';
    }

    function handleLogin() {
        ensureTeamAccountsReady();
        const studentId = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');
        const warningEl = document.getElementById('loginAttemptWarning');
        errorEl.textContent = ''; warningEl.style.display = 'none';

        if (!studentId || !password) { errorEl.textContent = '请输入学号/手机号和密码'; return; }

        let account = findAccountForLogin(studentId);
        if (!account) {
            // 团队有该成员但账号缺失时再同步一次
            ensureTeamAccountsReady();
            account = findAccountForLogin(studentId);
        }
        if (!account) {
            var teamHit = null;
            try {
                var members = (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData))
                    ? teamMemberData
                    : JSON.parse(localStorage.getItem('teamMemberData') || '[]');
                var digits = studentId.replace(/\D/g, '');
                teamHit = (members || []).find(function(m) {
                    if (!m) return false;
                    if (m.name === studentId) return true;
                    if (digits.length >= 6 && String(m.phone || '').replace(/\D/g, '') === digits) return true;
                    if (m.email && String(m.email).toLowerCase().indexOf(studentId.toLowerCase()) === 0) return true;
                    return false;
                });
            } catch (eTeam) {}
            if (teamHit) {
                errorEl.textContent = '成员「' + teamHit.name + '」账号开通失败，请管理员打开「账号管理」点刷新后再试';
            } else {
                errorEl.textContent = '账号不存在（可用手机号或学号登录）';
            }
            return;
        }
        if (account.status === 'disabled') { errorEl.textContent = '账号已禁用，请联系管理员'; return; }

        if (account.lockedUntil && new Date(account.lockedUntil) > new Date()) {
            errorEl.textContent = `账号已锁定，请 ${Math.ceil((new Date(account.lockedUntil) - new Date()) / 60000)} 分钟后再试`;
            return;
        }

        const maxAttempts = getConfigInt('user.passwordErrorLockCount', 5);
        const lockDuration = getConfigInt('user.lockTime', 30);
        const attemptKey = account.studentId || studentId;
        const attempts = loginAttempts[attemptKey] || loginAttempts[studentId] || 0;
        if (attempts >= maxAttempts) {
            account.lockedUntil = new Date(Date.now() + lockDuration * 60000).toISOString();
            saveAccountData();
            errorEl.textContent = `连续失败次数过多，账号已锁定 ${lockDuration} 分钟`;
            return;
        }

        if (account.password !== password) {
            loginAttempts[attemptKey] = attempts + 1;
            localStorage.setItem('loginAttempts', JSON.stringify(loginAttempts));
            const remain = maxAttempts - (attempts + 1);
            if (remain <= 2) { warningEl.textContent = `密码错误！再失败 ${remain} 次后账号将被锁定`; warningEl.style.display = 'block'; }
            errorEl.textContent = '密码错误';
            recordOperationLog('系统登录', '登录', `${account.realName}(${account.studentId}) 登录失败：密码错误`, { studentId: account.studentId }, { success: false }, 0, '密码错误', 0, account.id, account.realName);
            return;
        }

        try {
            const remember = document.getElementById('loginRemember');
            if (remember && remember.checked) localStorage.setItem('loginRememberedUser', account.studentId || studentId);
            else localStorage.removeItem('loginRememberedUser');
        } catch (eRem) {}

        // 登录成功
        loginAttempts[attemptKey] = 0;
        loginAttempts[studentId] = 0;
        localStorage.setItem('loginAttempts', JSON.stringify(loginAttempts));
        account.lastLogin = new Date().toLocaleString('zh-CN');
        account.lastLoginIp = '127.0.0.1';
        account.loginFailCount = 0;
        account.lockedUntil = null;
        saveAccountData();

        // 记录登录日志
        loginLogData.push({ studentId: account.studentId, realName: account.realName, role: account.role, loginTime: new Date().toLocaleString('zh-CN'), ip: '127.0.0.1', result: '成功' });
        if (loginLogData.length > 500) loginLogData = loginLogData.slice(-500);
        localStorage.setItem('loginLogData', JSON.stringify(loginLogData));

        recordOperationLog('系统登录', '登录', `${account.realName}(${account.studentId}) 登录系统`, { studentId: account.studentId, realName: account.realName, role: account.role }, { success: true }, 1, '', 0, account.id, account.realName);

        currentUser = account;
        try { window.currentUser = currentUser; } catch (eSync) {}
        localStorage.setItem('currentSession', JSON.stringify({
            userId: account.id,
            studentId: account.studentId || '',
            loginTime: Date.now()
        }));

        loadOperationLogData();
        cleanExpiredLogs();

        // 首次登录强制改密
        if (account.mustChangePwd) {
            document.getElementById('loginOverlay').classList.remove('active');
            showForceChangePasswordModal();
            return;
        }
        enterSystem();
    }

    function findAccountRecordForUser(user) {
        if (!user || !Array.isArray(accountData)) return null;
        var byId = accountData.find(function(a) { return a && Number(a.id) === Number(user.id); });
        if (byId) return byId;
        if (user.studentId) {
            var bySid = accountData.find(function(a) { return a && String(a.studentId || '') === String(user.studentId); });
            if (bySid) return bySid;
        }
        if (user.phone) {
            var digits = String(user.phone).replace(/\D/g, '');
            if (digits.length >= 11) {
                return accountData.find(function(a) {
                    return a && String(a.phone || '').replace(/\D/g, '') === digits;
                }) || null;
            }
        }
        return null;
    }

    function applyPendingPasswordCommit() {
        var pending = null;
        try { pending = JSON.parse(sessionStorage.getItem('pendingPasswordCommit') || 'null'); } catch (e) { pending = null; }
        if (!pending || !pending.password) return false;
        var acc = null;
        if (pending.userId != null) {
            acc = accountData.find(function(a) { return a && Number(a.id) === Number(pending.userId); });
        }
        if (!acc && pending.studentId) {
            acc = accountData.find(function(a) { return a && String(a.studentId || '') === String(pending.studentId); });
        }
        if (!acc) return false;
        var changed = false;
        if (acc.password !== pending.password) { acc.password = pending.password; changed = true; }
        if (acc.mustChangePwd !== false) { acc.mustChangePwd = false; changed = true; }
        if (acc.firstLogin) { acc.firstLogin = false; changed = true; }
        if (Number(acc.passwordUpdatedAt || 0) < Number(pending.ts || 0)) {
            acc.passwordUpdatedAt = pending.ts || Date.now();
            changed = true;
        }
        if (currentUser && (
            Number(currentUser.id) === Number(acc.id)
            || String(currentUser.studentId || '') === String(acc.studentId || '')
        )) {
            currentUser = acc;
            try { window.currentUser = currentUser; } catch (e2) {}
        }
        if (changed) {
            // 直接写存储并强制推云，避免被随后的拉取盖掉
            try {
                Storage.prototype.setItem.call(localStorage, 'accountData', JSON.stringify(accountData));
            } catch (e3) {
                localStorage.setItem('accountData', JSON.stringify(accountData));
            }
            try { if (typeof cloudUpsert === 'function') cloudUpsert('accountData', JSON.stringify(accountData)); } catch (e4) {}
        }
        return true;
    }

    function clearPendingPasswordCommit() {
        try { sessionStorage.removeItem('pendingPasswordCommit'); } catch (e) {}
    }

    function enforceMustChangePasswordGate() {
        if (!currentUser) return false;
        var acc = findAccountRecordForUser(currentUser) || currentUser;
        if (!acc.mustChangePwd) return false;
        currentUser = acc;
        try { window.currentUser = currentUser; } catch (e) {}
        document.getElementById('loginOverlay').classList.remove('active');
        if (!document.getElementById('forceChangePwdModal')) {
            showForceChangePasswordModal();
        }
        return true;
    }

    function showForceChangePasswordModal() {
        var old = document.getElementById('forceChangePwdModal');
        if (old) old.remove();
        const div = document.createElement('div');
        div.id = 'forceChangePwdModal';
        div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:11000;display:flex;justify-content:center;align-items:center;';
        div.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:28px;width:420px;max-width:90vw;" onclick="event.stopPropagation()">
                <h3 style="margin:0 0 8px;color:#e65100;">首次登录 · 请修改密码</h3>
                <p style="font-size:13px;color:#888;margin-bottom:20px;">您的账号为首次登录，请修改初始密码后再进入系统。改密完成前刷新页面仍会要求修改。</p>
                <div class="form-group"><label>新密码</label><input type="password" id="forceNewPwd" placeholder="至少8位，含字母和数字" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;" oninput="checkPasswordStrength(this.value,'forcePwdStrength')"><div class="password-strength-bar"><div class="fill" id="forcePwdStrengthBar"></div></div><div class="password-strength-text" id="forcePwdStrength"></div></div>
                <div class="form-group"><label>确认新密码</label><input type="password" id="forceNewPwdConfirm" placeholder="再次输入新密码" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;"></div>
                <div id="forcePwdError" style="color:#e53935;font-size:13px;min-height:18px;margin-bottom:8px;"></div>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
                    <button class="btn" type="button" id="forcePwdSubmitBtn" onclick="submitForceChangePwd()">确认修改并进入系统</button>
                </div>
            </div>`;
        document.body.appendChild(div);
    }

    async function submitForceChangePwd() {
        const errEl = document.getElementById('forcePwdError');
        const btn = document.getElementById('forcePwdSubmitBtn');
        const newPwd = (document.getElementById('forceNewPwd') || {}).value || '';
        const confirmPwd = (document.getElementById('forceNewPwdConfirm') || {}).value || '';
        if (errEl) errEl.textContent = '';
        if (!validatePassword(newPwd)) {
            if (errEl) errEl.textContent = '密码不符合复杂度要求（至少8位，含字母和数字）';
            else alert('密码不符合复杂度要求（至少8位，含字母和数字）');
            return;
        }
        if (newPwd !== confirmPwd) {
            if (errEl) errEl.textContent = '两次输入的密码不一致';
            else alert('两次输入的密码不一致');
            return;
        }
        if (!currentUser) {
            if (errEl) errEl.textContent = '登录状态已失效，请重新登录后再改密';
            return;
        }

        // 重新从本地加载，避免内存中的 accountData 已被云端旧数据替换
        try {
            var rawAcc = localStorage.getItem('accountData');
            if (rawAcc) accountData = JSON.parse(rawAcc);
        } catch (eReload) {}

        var acc = findAccountRecordForUser(currentUser);
        if (!acc) {
            if (errEl) errEl.textContent = '找不到账号记录，请联系导师在「账号管理」重置密码';
            return;
        }
        if (newPwd === DEFAULT_PASSWORD || newPwd === '123456') {
            if (errEl) errEl.textContent = '请勿继续使用初始密码，请设置新的密码';
            return;
        }

        var ts = Date.now();
        acc.password = newPwd;
        acc.mustChangePwd = false;
        acc.firstLogin = false;
        acc.passwordUpdatedAt = ts;
        currentUser = acc;
        try { window.currentUser = currentUser; } catch (eU) {}

        var commit = {
            userId: acc.id,
            studentId: acc.studentId || '',
            password: newPwd,
            ts: ts
        };
        try { sessionStorage.setItem('pendingPasswordCommit', JSON.stringify(commit)); } catch (eS) {}

        if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
        try {
            Storage.prototype.setItem.call(localStorage, 'accountData', JSON.stringify(accountData));
        } catch (eSet) {
            localStorage.setItem('accountData', JSON.stringify(accountData));
        }
        try {
            if (typeof cloudUpsert === 'function') {
                await cloudUpsert('accountData', JSON.stringify(accountData));
            }
        } catch (eCloud) {
            console.warn('force change pwd cloud upsert', eCloud);
        }

        document.getElementById('forceChangePwdModal')?.remove();
        enterSystem({ afterPasswordChange: true });
    }

    function syncGlobalsForExternalModules() {
        try { window.currentUser = currentUser; } catch (e) {}
        try { window.accountData = accountData; } catch (e2) {}
        try { window.weeklyReportData = typeof weeklyReportData !== 'undefined' ? weeklyReportData : window.weeklyReportData; } catch (e3) {}
        try {
            if (typeof literatureData !== 'undefined') {
                if (Array.isArray(window.literatureData) && window.literatureData !== literatureData) {
                    literatureData = window.literatureData;
                } else {
                    window.literatureData = literatureData;
                }
            }
        } catch (e4) {}
        try {
            if (typeof datasetData !== 'undefined') {
                if (Array.isArray(window.datasetData) && window.datasetData !== datasetData) {
                    datasetData = window.datasetData;
                } else {
                    window.datasetData = datasetData;
                }
            }
        } catch (e4b) {}
        try {
            if (typeof reportData !== 'undefined') {
                if (Array.isArray(window.reportData) && window.reportData !== reportData) {
                    reportData = window.reportData;
                } else {
                    window.reportData = reportData;
                }
            }
        } catch (e4c) {}
        try {
            if (typeof sharedFileData !== 'undefined') window.sharedFileData = sharedFileData;
        } catch (e5) {}
        try {
            if (typeof noticeData !== 'undefined') window.noticeData = noticeData;
        } catch (e6) {}
    }
    window.syncGlobalsForExternalModules = syncGlobalsForExternalModules;

    function enterSystem(options) {
        options = options || {};
        applyPendingPasswordCommit();
        syncGlobalsForExternalModules();

        // 刷新/恢复会话时也必须挡住未改密用户
        if (!options.afterPasswordChange && enforceMustChangePasswordGate()) {
            // 仍后台同步，但不放行业务（弹窗已显示）
            if (typeof syncFromCloudAndRefresh === 'function') {
                syncFromCloudAndRefresh({ silent: true }).then(function() {
                    applyPendingPasswordCommit();
                    try {
                        var rawAcc = localStorage.getItem('accountData');
                        if (rawAcc) accountData = JSON.parse(rawAcc);
                    } catch (e) {}
                    if (currentUser) {
                        var fresh = findAccountRecordForUser(currentUser);
                        if (fresh) currentUser = fresh;
                    }
                    if (enforceMustChangePasswordGate()) return;
                    clearPendingPasswordCommit();
                    syncGlobalsForExternalModules();
                    updateHeaderUserInfo();
                    applyRolePermissions();
                }).catch(function() {});
            }
            document.getElementById('loginOverlay').classList.remove('active');
            return;
        }

        // 登录后先拉云端；改密后先合并密码再刷新
        syncFromCloudAndRefresh({ silent: false }).then(function() {
            applyPendingPasswordCommit();
            try {
                var rawAcc2 = localStorage.getItem('accountData');
                if (rawAcc2) accountData = JSON.parse(rawAcc2);
            } catch (e2) {}
            if (currentUser) {
                var fresh2 = findAccountRecordForUser(currentUser);
                if (fresh2) {
                    currentUser = fresh2;
                    try { window.currentUser = currentUser; } catch (e3) {}
                }
            }
            if (!options.afterPasswordChange && enforceMustChangePasswordGate()) return;
            if (options.afterPasswordChange) clearPendingPasswordCommit();
            syncGlobalsForExternalModules();
            updateHeaderUserInfo();
            applyRolePermissions();
            try { if (typeof renderPermissionMatrix === 'function') renderPermissionMatrix(); } catch (e) {}
            try { if (typeof renderAccountTable === 'function') renderAccountTable(); } catch (e) {}
            try { if (typeof renderHomeNewsPanel === 'function') renderHomeNewsPanel(); } catch (e) {}
            try { if (typeof initNewsManagement === 'function' && document.getElementById('news_management') && document.getElementById('news_management').classList.contains('active')) initNewsManagement(); } catch (e) {}
        }).catch(function(e){ console.warn(e); applyPendingPasswordCommit(); syncGlobalsForExternalModules(); applyRolePermissions(); });

        document.getElementById('loginOverlay').classList.remove('active');
        updateHeaderUserInfo();
        applyRolePermissions();
        try { if (typeof renderHomeNewsPanel === 'function') renderHomeNewsPanel(); } catch (eHome) {}
    }

    function handleLogout() {
        if (!confirm('确定要退出登录吗？')) return;
        const userName = currentUser ? currentUser.realName : '';
        const studentId = currentUser ? currentUser.studentId : '';
        const userId = currentUser ? currentUser.id : 0;
        recordOperationLog('系统登录', '登出', `${userName}(${studentId}) 退出登录`, { studentId }, { success: true }, 1, '', 0, userId, userName);
        currentUser = null;
        syncGlobalsForExternalModules();
        localStorage.removeItem('currentSession');
        document.getElementById('loginOverlay').classList.add('active'); initLoginMotion();
        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginError').textContent = '';
        document.getElementById('loginAttemptWarning').style.display = 'none';
    }

    function resolveMemberAvatarUrl(person) {
        if (!person) return '';
        var direct = person.avatar || person.dataUrl || '';
        if (direct && String(direct).length > 20) return String(direct);
        try {
            var name = person.name || person.realName || '';
            var list = (typeof teamMemberData !== 'undefined' && teamMemberData) ? teamMemberData : [];
            var hit = null;
            if (person.id != null) hit = list.find(function (m) { return m.id === person.id; });
            if (!hit && name) hit = list.find(function (m) { return m.name === name; });
            if (hit && hit.avatar && String(hit.avatar).length > 20) return String(hit.avatar);
        } catch (e) {}
        return '';
    }

    function renderHomeMemberAvatarHtml(m) {
        var url = resolveMemberAvatarUrl(m);
        var ch = escHtml(String((m && m.name) || '?').charAt(0));
        if (url) {
            return '<div class="av"><img src="' + String(url).replace(/"/g, '&quot;') + '" alt="' + ch + '" onerror="this.remove();this.parentNode.textContent=\'' + ch + '\';"></div>';
        }
        return '<div class="av">' + ch + '</div>';
    }

    function updateHeaderUserInfo() {
        const nameEl = document.getElementById('headerUserName');
        const roleEl = document.getElementById('headerUserRole');
        const avEl = document.getElementById('headerAvatar');
        if (!currentUser) {
            if (nameEl) nameEl.textContent = '未登录';
            if (roleEl) roleEl.textContent = '请先登录';
            if (avEl) { avEl.innerHTML = ''; avEl.textContent = '?'; }
            return;
        }
        if (nameEl) nameEl.textContent = currentUser.realName || currentUser.studentId || '';
        if (roleEl) roleEl.textContent = (typeof ROLE_LABELS !== 'undefined' && ROLE_LABELS[currentUser.role]) ? ROLE_LABELS[currentUser.role] : (currentUser.role || '');
        if (avEl) {
            var avUrl = resolveMemberAvatarUrl(currentUser) || resolveMemberAvatarUrl({ name: currentUser.realName, id: currentUser.memberId });
            var ch = String(currentUser.realName || currentUser.studentId || '?').charAt(0);
            if (avUrl) {
                avEl.innerHTML = '<img src="' + String(avUrl).replace(/"/g, '&quot;') + '" alt="' + escHtml(ch) + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.parentNode.textContent=\'' + ch + '\';">';
            } else {
                avEl.innerHTML = '';
                avEl.textContent = ch;
            }
        }
        try { if (typeof refreshGlobalNoticeCenter === 'function') refreshGlobalNoticeCenter(); } catch (e) {}
        try { if (typeof renderHomeDashboard === 'function') renderHomeDashboard(); } catch (e2) {}
        try { if (typeof updateHomeSyncChrome === 'function') updateHomeSyncChrome(); } catch (e3) {}
    }

    /** 账号库被团队联动/云端拉取改写后，按学号或姓名重新对齐会话，避免刷新掉线 */
    function rematchSessionAfterAccountSync() {
        try {
            var session = null;
            try { session = JSON.parse(localStorage.getItem('currentSession') || 'null'); } catch (e0) { session = null; }
            if (!session || !session.loginTime) {
                if (currentUser) {
                    try { window.currentUser = currentUser; window.accountData = accountData; } catch (e1) {}
                }
                return !!currentUser;
            }
            if (Date.now() - Number(session.loginTime) >= TOKEN_EXPIRE_MS) {
                localStorage.removeItem('currentSession');
                currentUser = null;
                try { window.currentUser = null; } catch (e2) {}
                return false;
            }
            var user = findAccountForSession(session);
            if (!user && currentUser) {
                user = findAccountForSession({
                    userId: currentUser.id,
                    studentId: currentUser.studentId || session.studentId || ''
                });
            }
            if (!user && currentUser && currentUser.realName && Array.isArray(accountData)) {
                user = accountData.find(function(a) {
                    return a && a.role !== 'visitor' && String(a.realName || '') === String(currentUser.realName);
                }) || null;
            }
            if (!user) return !!currentUser;
            if (user.status && user.status !== 'active') {
                localStorage.removeItem('currentSession');
                currentUser = null;
                try { window.currentUser = null; } catch (e3) {}
                return false;
            }
            currentUser = user;
            try {
                localStorage.setItem('currentSession', JSON.stringify({
                    userId: user.id,
                    studentId: user.studentId || session.studentId || '',
                    loginTime: session.loginTime
                }));
            } catch (e4) {}
            try { window.currentUser = currentUser; window.accountData = accountData; } catch (e5) {}
            return true;
        } catch (e) {
            return !!currentUser;
        }
    }
    window.rematchSessionAfterAccountSync = rematchSessionAfterAccountSync;

    // ===== 3. 权限控制 =====
    function hasPermission(featureName) {
        if (!currentUser) return false;
        if (currentUser.role === 'admin') return true;
        const perm = permissionMatrix.find(p => p[0] === featureName);
        if (!perm) return false;
        const roleIndex = { admin: 1, leader: 2, student: 3, visitor: 4 }[currentUser.role];
        return perm[roleIndex] === true;
    }
    window.hasPermission = hasPermission;

    function canEditTeamMembers() {
        return hasPermission('团队成员档案（编辑）');
    }

    /** 导师可编全部；研究生/组长可完善与本人账号关联的档案 */
    function getCurrentUserTeamMember() {
        if (!currentUser || currentUser.role === 'visitor') return null;
        try {
            if (typeof findTeamMemberForAccount === 'function') {
                var linked = findTeamMemberForAccount(currentUser);
                if (linked) return linked;
            }
        } catch (e0) {}
        try {
            if (typeof teamMemberData === 'undefined' || !Array.isArray(teamMemberData)) return null;
            if (currentUser.teamMemberId != null) {
                var byId = teamMemberData.find(function (m) { return m && Number(m.id) === Number(currentUser.teamMemberId); });
                if (byId) return byId;
            }
            if (currentUser.realName) {
                return teamMemberData.find(function (m) { return m && m.name === currentUser.realName; }) || null;
            }
        } catch (e1) {}
        return null;
    }

    function canEditOwnMemberProfile(memberId) {
        if (canEditTeamMembers()) return true;
        if (!hasPermission('团队成员档案（仅自己）')) return false;
        var me = getCurrentUserTeamMember();
        return !!(me && Number(me.id) === Number(memberId));
    }
    window.getCurrentUserTeamMember = getCurrentUserTeamMember;
    window.canEditOwnMemberProfile = canEditOwnMemberProfile;

    function applyRolePermissions() {
        if (!currentUser) return;
        const role = currentUser.role;

        // 侧边栏：以权限矩阵为准（全局同步后各端一致）
        const menuVisibility = {
            'member_archive': hasPermission('团队成员档案（查看全组）') || hasPermission('团队成员档案（仅自己）'),
            'role_permission': hasPermission('角色权限管理'),
            'task_management': true,
            'weekly_report': hasPermission('团队工作周报（查看全部）') || hasPermission('团队工作周报（提交自己的）'),
            'application_center': hasPermission('请假与申请（提交自己的）') || hasPermission('请假与申请（本组审批）') || hasPermission('请假与申请（审批/查看全部）'),
            'my_projects': hasPermission('项目管理（查看）'),
            'longitudinal_project': hasPermission('项目管理（查看）'),
            'horizontal_project': hasPermission('项目管理（查看）'),
            'school_project': hasPermission('项目管理（查看）'),
            'my_achievements': hasPermission('成果管理（查看）'),
            'patent_management': hasPermission('成果管理（查看）'),
            'paper_management': hasPermission('成果管理（查看）'),
            'standard_management': hasPermission('成果管理（查看）'),
            'competition_management': hasPermission('成果管理（查看）'),
            'software_copyright': hasPermission('成果管理（查看）'),
            'model_training': hasPermission('智能工具（全部）'),
            'data_annotation': hasPermission('智能工具（全部）'),
            'chat': hasPermission('智能工具（全部）'),
            'openai': hasPermission('智能工具（全部）'),
            'literature_analysis': hasPermission('智能工具（全部）'),
            'excel': hasPermission('智能工具（全部）'),
            'document_analysis': hasPermission('智能工具（全部）'),
            'notice_publish': true,
            'news_management': role === 'admin' || role === 'leader' || role === 'student' || role === 'visitor',
            'meeting_management': role !== 'visitor',
            'literature_library': hasPermission('资源中心（查看）'),
            'dataset_library': hasPermission('资源中心（查看）') && role !== 'visitor',
            'project_report': hasPermission('资源中心（查看）') && role !== 'visitor',
            'shared_files': hasPermission('资源中心（查看）'),
            'account_permission': hasPermission('账号管理（查看列表）') || hasPermission('账号管理（新建/删除）'),
            'system_config': hasPermission('系统设置'),
            'operation_log': hasPermission('操作日志'),
            'data_backup': hasPermission('数据备份'),
        };

        Object.entries(menuVisibility).forEach(([moduleId, visible]) => {
            const navItems = document.querySelectorAll('.nav-item');
            navItems.forEach(item => {
                const onclick = item.getAttribute('onclick');
                if (onclick && onclick.includes(`'${moduleId}'`)) {
                    item.style.display = visible ? '' : 'none';
                }
            });
        });

        // 如果当前在隐藏的模块，跳回首页（不写入历史，避免干扰返回栈）
        const activeModule = document.querySelector('.module.active');
        if (activeModule) {
            const moduleId = activeModule.id;
            if (menuVisibility[moduleId] === false) {
                moduleNavSkipHistory = true;
                try { showModule('home'); } finally { moduleNavSkipHistory = false; }
            }
        }

        // 账号权限页面：无新建权限时隐藏注册/导入等标签
        const tabs = document.querySelectorAll('#accountTabNav .tab-btn');
        tabs.forEach(t => {
            const onclick = t.getAttribute('onclick') || '';
            if (onclick.includes('accountRegister') || onclick.includes('accountImport')) {
                t.style.display = hasPermission('账号管理（新建/删除）') ? '' : 'none';
            }
            if (onclick.includes('loginSecurity')) {
                t.style.display = (role === 'admin') ? '' : 'none';
            }
        });

        // 按钮级权限控制
        applyButtonPermissions();
        applyMemberArchivePermissions();
    }

    function applyButtonPermissions() {
        if (!currentUser) return;
        const role = currentUser.role;

        // 先恢复，再按权限隐藏（避免同步后状态残留）
        document.querySelectorAll('[data-perm="export"], [data-perm="batch-edit"], [data-perm="delete"], [data-perm="global-manage"], [data-perm="manage"], [data-perm="member-edit"], [data-perm="member-export"]').forEach(btn => {
            btn.style.display = '';
        });

        // 学生账号：隐藏导出、批量编辑、删除等管理按钮
        if (role === 'student') {
            document.querySelectorAll('[data-perm="export"], [data-perm="batch-edit"], [data-perm="delete"]').forEach(btn => {
                btn.style.display = 'none';
            });
        }

        // 组长账号：显示本组相关管理按钮，但隐藏全局管理按钮
        if (role === 'leader') {
            document.querySelectorAll('[data-perm="global-manage"]').forEach(btn => {
                btn.style.display = 'none';
            });
        }

        // 访客账号：隐藏所有管理按钮
        if (role === 'visitor') {
            document.querySelectorAll('[data-perm="manage"]').forEach(btn => {
                btn.style.display = 'none';
            });
        }

        // 成员档案编辑按钮：跟权限矩阵
        document.querySelectorAll('[data-perm="member-edit"]').forEach(btn => {
            btn.style.display = canEditTeamMembers() ? '' : 'none';
        });
        document.querySelectorAll('[data-perm="account-create"]').forEach(btn => {
            btn.style.display = hasPermission('账号管理（新建/删除）') ? '' : 'none';
        });
    }

    function applyMemberArchivePermissions() {
        const canEdit = canEditTeamMembers();
        document.querySelectorAll('#member_archive [data-perm="member-edit"]').forEach(btn => {
            btn.style.display = canEdit ? '' : 'none';
        });
        document.querySelectorAll('#member_archive .member-category-section button').forEach(btn => {
            if ((btn.textContent || '').indexOf('增加人员') >= 0) {
                btn.style.display = canEdit ? '' : 'none';
            }
        });
    }

    // ===== 4. 账号管理 - 列表 =====
    function findTeamMemberForAccount(account) {
        if (!account || account.role === 'visitor') return null;
        try {
            if (typeof teamMemberData === 'undefined' || !Array.isArray(teamMemberData)) return null;
            return teamMemberData.find(function(m) {
                if (!m) return false;
                const pref = typeof getPreferredStudentId === 'function' ? getPreferredStudentId(m) : '';
                if (typeof accountMatchesTeamMember === 'function') {
                    return accountMatchesTeamMember(account, m, pref);
                }
                if (account.teamMemberId && Number(m.id) === Number(account.teamMemberId)) return true;
                if (account.realName && m.name === account.realName) return true;
                if (account.email && m.email && account.email === m.email) return true;
                return false;
            }) || null;
        } catch (e) { return null; }
    }

    function isVisitorAccount(account) {
        return !!(account && account.role === 'visitor');
    }

    function getTeamMembersWithoutAccount() {
        const members = (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData)) ? teamMemberData : [];
        return members.filter(function(m) {
            if (!m || !m.name) return false;
            const preferred = typeof getPreferredStudentId === 'function' ? getPreferredStudentId(m) : '';
            return !accountData.some(function(a) {
                if (!a || a.role === 'visitor') return false;
                if (typeof accountMatchesTeamMember === 'function') {
                    return accountMatchesTeamMember(a, m, preferred);
                }
                return a.realName === m.name
                    || (m.email && a.email === m.email)
                    || (a.teamMemberId && Number(a.teamMemberId) === Number(m.id))
                    || (m.phone && String(a.phone || '').replace(/\D/g, '') === String(m.phone).replace(/\D/g, ''));
            });
        });
    }

    function getAccountGradeDisplay(a) {
        const m = findTeamMemberForAccount(a);
        if (m) {
            if (m.category === 'advisor') return '-';
            return (typeof getMemberCategoryLabel === 'function' ? getMemberCategoryLabel(m.category) : (m.category + '级'));
        }
        if (isVisitorAccount(a)) return '-';
        return a.grade || '-';
    }

    function getAccountGraduatedDisplay(a) {
        if (isVisitorAccount(a)) return '-';
        const m = findTeamMemberForAccount(a);
        const graduated = m ? (typeof isMemberGraduated === 'function' ? isMemberGraduated(m) : !!m.graduated) : !!a.graduated;
        if (m && m.category === 'advisor') return '-';
        return graduated ? '已毕业' : '在读';
    }

    function getAccountPasswordDisplay(a) {
        if (!a) return '-';
        if (a.role === 'admin') return '—';
        // 仅导师可见明文初始密码；学生改密后不再展示
        if (currentUser && currentUser.role === 'admin') {
            if (a.mustChangePwd || a.firstLogin || !a.lastLogin) {
                return '<code style="background:#fff7e6;padding:2px 6px;border-radius:4px;color:#ad6800;">' +
                    escHtml(a.password || DEFAULT_PASSWORD) + '</code>' +
                    '<div style="font-size:11px;color:#fa8c16;margin-top:2px;">待首次改密</div>';
            }
            return '<span style="color:#888;font-size:12px;">已自行修改</span>';
        }
        return a.mustChangePwd ? '待改密' : '已设置';
    }

    function getStudentAccountsForOps() {
        return (accountData || []).filter(function(a) {
            if (!a || isVisitorAccount(a)) return false;
            if (a.role === 'admin') return false;
            // 学生 + 组长都算可分发账号；导师账号不导出
            return a.role === 'student' || a.role === 'leader';
        });
    }

    /** 一键按团队档案匹配并开通学生账号，统一重置初始密码 */
    function matchAndOpenAllStudentAccounts() {
        if (!hasPermission('账号管理（新建/删除）')) {
            alert('当前角色无「账号管理（新建/删除）」权限');
            return;
        }
        var members = (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData))
            ? teamMemberData
            : [];
        try {
            if (!members.length) {
                var raw = localStorage.getItem('teamMemberData');
                members = raw ? JSON.parse(raw) : [];
            }
        } catch (e0) { members = []; }
        var students = members.filter(function(m) { return m && m.category !== 'advisor'; });
        if (!students.length) {
            alert('团队成员档案中暂无学生。\n请先到「团队成员档案」导入/添加学生，再点本按钮匹配账号。');
            return;
        }
        if (!confirm(
            '将为团队中的 ' + students.length + ' 位学生/成员：\n' +
            '1）自动生成或对齐专属登录账号（优先手机号）\n' +
            '2）统一重置初始密码为「' + DEFAULT_PASSWORD + '」\n' +
            '3）要求首次登录自行修改密码\n\n' +
            '导师账号与访客不受影响。是否继续？'
        )) return;

        try { if (typeof syncTeamMembersAcrossSystem === 'function') syncTeamMembersAcrossSystem(); } catch (e1) {}

        var created = 0;
        var reset = 0;
        var linked = 0;
        students.forEach(function(m) {
            var preferred = typeof getPreferredStudentId === 'function' ? getPreferredStudentId(m) : ('member' + m.id);
            var acc = accountData.find(function(a) {
                if (!a || a.role === 'visitor' || a.role === 'admin') return false;
                if (typeof accountMatchesTeamMember === 'function') return accountMatchesTeamMember(a, m, preferred);
                return a.realName === m.name || Number(a.teamMemberId) === Number(m.id);
            });
            if (!acc) {
                // sync 应已创建；若仍缺失则补建
                var newId = accountData.length ? Math.max.apply(null, accountData.map(function(x) { return Number(x.id) || 0; })) + 1 : 1;
                acc = {
                    id: newId,
                    studentId: preferred,
                    realName: m.name,
                    role: 'student',
                    group: '',
                    grade: m.category === 'advisor' ? '' : (m.category + '级'),
                    research: m.research || '',
                    phone: m.phone || '',
                    email: m.email || '',
                    status: 'active',
                    password: DEFAULT_PASSWORD,
                    mustChangePwd: true,
                    firstLogin: true,
                    lastLogin: '',
                    lastLoginIp: '',
                    createdAt: new Date().toISOString().split('T')[0],
                    loginFailCount: 0,
                    lockedUntil: null,
                    fromTeam: true,
                    teamMemberId: m.id,
                    loginAliases: []
                };
                accountData.push(acc);
                created++;
            } else {
                linked++;
            }
            if (acc.password !== DEFAULT_PASSWORD || !acc.mustChangePwd) reset++;
            acc.password = DEFAULT_PASSWORD;
            acc.mustChangePwd = true;
            acc.firstLogin = true;
            acc.loginFailCount = 0;
            acc.lockedUntil = null;
            acc.status = 'active';
            acc.fromTeam = true;
            acc.teamMemberId = m.id;
            acc.realName = m.name;
            acc.phone = m.phone || acc.phone || '';
            acc.email = m.email || acc.email || '';
            if (!acc.studentId) acc.studentId = preferred;
        });

        saveAccountData();
        try { if (typeof syncTeamMembersAcrossSystem === 'function') syncTeamMembersAcrossSystem(); } catch (e2) {}
        accountPage = 1;
        renderAccountTable();
        recordOperationLog('账号管理', '匹配开通', '一键匹配学生账号密码：成员' + students.length + '人', { count: students.length, created: created, reset: reset }, { success: true }, 1, '', 0);

        var msg = '匹配完成！\n\n团队学生：' + students.length +
            ' 人\n新开通：' + created + ' 人\n已对齐并重置密码：' + (linked + created) +
            ' 人\n初始密码：' + DEFAULT_PASSWORD +
            '\n\n请点击「导出学生账号密码」下载清单发给学生。';
        if (confirm(msg + '\n\n是否立即导出？')) {
            exportStudentCredentials();
        }
    }

    /** 导出学生专属账号 + 初始密码（仅导师） */
    function exportStudentCredentials() {
        if (!(currentUser && currentUser.role === 'admin') && !hasPermission('账号管理（新建/删除）')) {
            alert('仅导师可导出学生账号密码');
            return;
        }
        try { if (typeof syncTeamMembersAcrossSystem === 'function') syncTeamMembersAcrossSystem(); } catch (e0) {}
        var list = getStudentAccountsForOps().filter(function(a) {
            return findTeamMemberForAccount(a) || a.fromTeam;
        });
        if (!list.length) {
            alert('没有可导出的学生账号。\n请先导入团队成员并执行「一键匹配账号密码」。');
            return;
        }
        if (!confirm('将导出 ' + list.length + ' 名学生的登录账号与密码到 CSV。\n该文件含敏感信息，请仅用于线下分发，用后妥善保管或销毁。\n\n继续导出？')) return;

        var rows = [['登录账号', '姓名', '角色', '年级', '手机号', '邮箱', '初始密码', '首次登录须改密', '状态', '最后登录', '备注']];
        list.forEach(function(a) {
            var pwd = (a.mustChangePwd || !a.lastLogin) ? (a.password || DEFAULT_PASSWORD) : '（已自行修改，请重置后再导出）';
            var note = '';
            if (Array.isArray(a.loginAliases) && a.loginAliases.length) {
                note = '也可使用别名：' + a.loginAliases.join(' / ');
            }
            rows.push([
                a.studentId || '',
                a.realName || '',
                ROLE_LABELS[a.role] || a.role || '',
                getAccountGradeDisplay(a),
                a.phone || '',
                a.email || '',
                pwd,
                (a.mustChangePwd ? '是' : '否'),
                a.status === 'active' ? '已启用' : '已禁用',
                a.lastLogin || '从未登录',
                note
            ]);
        });
        var csv = rows.map(function(r) {
            return r.map(function(c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
        }).join('\n');
        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '学生账号密码_' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(url);
        recordOperationLog('账号管理', '导出', '导出学生账号密码 ' + list.length + ' 条', { count: list.length }, { success: true }, 1, '', 0);
    }

    /** 清除所有学生档案 + 对应账号，保留导师与访客 */
    function clearAllStudentsThenHintImport() {
        if (!hasPermission('账号管理（新建/删除）')) {
            alert('当前角色无「账号管理（新建/删除）」权限');
            return;
        }
        if (!(currentUser && currentUser.role === 'admin')) {
            alert('仅导师可清除全部学生信息');
            return;
        }
        var members = [];
        try {
            members = (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData))
                ? teamMemberData
                : JSON.parse(localStorage.getItem('teamMemberData') || '[]');
        } catch (e1) { members = []; }
        var studentMembers = members.filter(function(m) { return m && m.category !== 'advisor'; });
        var studentAccounts = getStudentAccountsForOps();

        if (!studentMembers.length && !studentAccounts.length) {
            alert('当前没有学生可清除。\n可直接到「团队成员档案」导入学生，再回来「一键匹配账号密码」。');
            return;
        }

        var tip = '即将清除：\n· 团队成员档案中的学生 ' + studentMembers.length + ' 人（导师保留）\n' +
            '· 登录账号中的学生/组长 ' + studentAccounts.length + ' 个（导师与访客保留）\n\n' +
            '此操作会同步到云端，不可轻易恢复。\n请输入「清除学生」确认：';
        var ok = prompt(tip);
        if (ok !== '清除学生') {
            alert('已取消，未做任何修改');
            return;
        }

        // 1) 团队档案只留导师
        try {
            if (typeof teamMemberData !== 'undefined') {
                teamMemberData = members.filter(function(m) { return m && m.category === 'advisor'; });
                if (typeof saveTeamMemberData === 'function') {
                    saveTeamMemberData();
                } else {
                    localStorage.setItem('teamMemberData', JSON.stringify(teamMemberData));
                    try { if (typeof cloudUpsert === 'function') cloudUpsert('teamMemberData', JSON.stringify(teamMemberData)); } catch (eC) {}
                }
            } else {
                var keepAdv = members.filter(function(m) { return m && m.category === 'advisor'; });
                localStorage.setItem('teamMemberData', JSON.stringify(keepAdv));
                try { if (typeof cloudUpsert === 'function') cloudUpsert('teamMemberData', JSON.stringify(keepAdv)); } catch (eC2) {}
            }
        } catch (eTeam) {
            alert('清除团队学生失败：' + (eTeam && eTeam.message ? eTeam.message : eTeam));
            return;
        }

        // 2) 账号：去掉学生/组长，保留导师与访客
        var removedAcc = [];
        accountData = accountData.filter(function(a) {
            if (!a) return false;
            if (a.role === 'admin' || a.role === 'visitor') return true;
            // 当前登录保护
            if (currentUser && Number(a.id) === Number(currentUser.id)) return true;
            removedAcc.push(a);
            return false;
        });
        saveAccountData();

        try { if (typeof renderTeamMembers === 'function') renderTeamMembers(); } catch (eR) {}
        try { if (typeof renderMemberNav === 'function') renderMemberNav(); } catch (eN) {}
        try { if (typeof renderMemberAllSections === 'function') renderMemberAllSections(); } catch (eS) {}
        accountPage = 1;
        renderAccountTable();
        recordOperationLog('账号管理', '清除学生', '清除学生档案' + studentMembers.length + '人、账号' + removedAcc.length + '个', {
            members: studentMembers.length, accounts: removedAcc.length
        }, { success: true }, 1, '', 0);

        alert(
            '已清除学生信息。\n\n档案：' + studentMembers.length + ' 人\n账号：' + removedAcc.length +
            ' 个\n导师与访客已保留。\n\n下一步：打开「团队成员档案」重新导入学生，然后回到本页点击「一键匹配账号密码」。'
        );
        try {
            if (typeof showModule === 'function' && confirm('是否现在跳转到「团队成员档案」去导入？')) {
                showModule('member_archive');
            }
        } catch (eJump) {}
    }

    function renderAccountTable() {
        try { if (typeof syncTeamMembersAcrossSystem === 'function') syncTeamMembersAcrossSystem(); } catch (eSyncAcc) {}

        const search = (document.getElementById('accountSearchInput')?.value || '').toLowerCase();
        const roleFilter = document.getElementById('accountRoleFilter')?.value || '';
        const statusFilter = document.getElementById('accountStatusFilter')?.value || '';

        let filtered = accountData.filter(a => {
            if (!a) return false;
            // 全局联动：列表只显示「访客」+「已关联团队成员」的正式账号
            if (!isVisitorAccount(a)) {
                const linked = findTeamMemberForAccount(a);
                if (!linked) return false;
            }
            if (search && !a.studentId.toLowerCase().includes(search) && !a.realName.toLowerCase().includes(search)
                && !(a.phone && String(a.phone).includes(search))) return false;
            if (roleFilter && a.role !== roleFilter) return false;
            if (statusFilter && a.status !== statusFilter) return false;
            if (currentUser && currentUser.role === 'student' && a.id !== currentUser.id) return false;
            if (currentUser && currentUser.role === 'leader' && a.group !== currentUser.group && a.id !== currentUser.id) return false;
            return true;
        });

        const totalPages = Math.ceil(filtered.length / ACCOUNTS_PER_PAGE) || 1;
        if (accountPage > totalPages) accountPage = totalPages;
        const startIdx = (accountPage - 1) * ACCOUNTS_PER_PAGE;
        const pageData = filtered.slice(startIdx, startIdx + ACCOUNTS_PER_PAGE);

        const tbody = document.getElementById('accountTableBody');
        if (!tbody) return;
        tbody.innerHTML = pageData.map(a => {
            const gradeText = getAccountGradeDisplay(a);
            const gradText = getAccountGraduatedDisplay(a);
            const gradStyle = gradText === '已毕业' ? 'color:#888;background:#f5f5f5;' : (gradText === '在读' ? 'color:#1890ff;background:#e6f7ff;' : '');
            const sourceTip = isVisitorAccount(a)
                ? '<div style="font-size:11px;color:#e65100;margin-top:2px;">访客（独立账号）</div>'
                : '<div style="font-size:11px;color:#52c41a;margin-top:2px;">来自团队管理 · 专属登录名</div>';
            const aliasTip = (Array.isArray(a.loginAliases) && a.loginAliases.length)
                ? '<div style="font-size:11px;color:#8c8c8c;margin-top:2px;">别名 ' + escHtml(a.loginAliases.join(' / ')) + '</div>'
                : '';
            return `
            <tr>
                <td><strong style="font-size:13px;">${escHtml(a.studentId)}</strong>${sourceTip}${aliasTip}</td>
                <td>${escHtml(a.realName)}</td>
                <td><span class="role-badge ${ROLE_BADGE_CLASS[a.role] || ''}">${ROLE_LABELS[a.role] || a.role}</span></td>
                <td>${escHtml(gradeText)}</td>
                <td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;${gradStyle}">${escHtml(gradText)}</span></td>
                <td>${escHtml(a.group || '-')}</td>
                <td>${getAccountPasswordDisplay(a)}</td>
                <td><span class="status-dot ${a.status}"></span>${a.status === 'active' ? '已启用' : '已禁用'}</td>
                <td style="font-size:12px;color:#888;">${a.lastLogin || '从未登录'}</td>
                <td>
                    <button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="showEditAccountModal(${a.id})">编辑</button>
                    ${a.role !== 'admin' ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;color:#1565c0;" onclick="resetAccountPassword(${a.id})">重置密码</button>` : ''}
                    ${a.role !== 'admin' ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;color:#e65100;" onclick="toggleAccountStatus(${a.id})">${a.status === 'active' ? '禁用' : '启用'}</button>` : ''}
                    ${(a.role === 'student' || a.role === 'leader') && a.status === 'active' && gradText !== '已毕业' ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;color:#666;" onclick="graduateAccount(${a.id})">毕业归档</button>` : ''}
                    <button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;color:#555;" onclick="showLoginLogModal('${escHtml(a.studentId)}')">日志</button>
                    ${a.role !== 'admin' && currentUser && currentUser.role === 'admin' ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;color:#e53935;" onclick="deleteAccount(${a.id})">删除</button>` : ''}
                </td>
            </tr>`;
        }).join('');

        const pagDiv = document.getElementById('accountPagination');
        if (pagDiv) {
            const teamCount = filtered.filter(a => !isVisitorAccount(a)).length;
            const visitorCount = filtered.filter(a => isVisitorAccount(a)).length;
            const studentCount = filtered.filter(a => a.role === 'student' || a.role === 'leader').length;
            pagDiv.innerHTML = `
                <span>共 ${filtered.length} 条（团队 ${teamCount} · 学生/组长 ${studentCount} · 访客 ${visitorCount}）</span>
                <button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="accountPage=1;renderAccountTable()" ${accountPage<=1?'disabled':''}>首页</button>
                <button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="accountPage--;renderAccountTable()" ${accountPage<=1?'disabled':''}>上一页</button>
                <span>${accountPage} / ${totalPages}</span>
                <button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="accountPage++;renderAccountTable()" ${accountPage>=totalPages?'disabled':''}>下一页</button>`;
        }
    }

    function filterAccountTable() { accountPage = 1; renderAccountTable(); }

    function showAddAccountModal() {
        showAddVisitorAccountModal();
    }

    function showAddVisitorAccountModal() {
        if (!hasPermission('账号管理（新建/删除）')) { alert('当前角色无「账号管理（新建/删除）」权限'); return; }
        document.body.appendChild(createAccountModal('新建访客账号', null, { mode: 'visitor' }));
    }

    function showOpenTeamAccountModal() {
        if (!hasPermission('账号管理（新建/删除）')) { alert('当前角色无「账号管理（新建/删除）」权限'); return; }
        try { if (typeof syncTeamMembersAcrossSystem === 'function') syncTeamMembersAcrossSystem(); } catch (e0) {}
        const pending = getTeamMembersWithoutAccount();
        if (!pending.length) {
            alert('所有团队成员均已开通账号。\n如需新增正式成员，请先到「团队成员档案」添加人员。');
            return;
        }
        const modalId = 'openTeamAccountModal_' + Date.now();
        const div = document.createElement('div');
        div.id = modalId;
        div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:5000;display:flex;justify-content:center;align-items:center;';
        div.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:28px;width:520px;max-width:90vw;max-height:85vh;overflow-y:auto;">
                <h3 style="margin:0 0 12px;">从团队成员开通账号</h3>
                <p style="margin:0 0 16px;font-size:13px;color:#666;line-height:1.6;">以下成员已在「团队成员档案」中，但尚未开通登录账号。选择后将自动带入姓名、年级等信息。</p>
                <div class="form-group">
                    <label>选择团队成员<span style="color:red;">*</span></label>
                    <select id="openTeamMemberPick" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;" onchange="onOpenTeamMemberPickChange()">
                        <option value="">请选择</option>
                        ${pending.map(function(m) {
                            const label = (typeof getMemberCategoryLabel === 'function' ? getMemberCategoryLabel(m.category) : m.category) + ' · ' + m.name;
                            return '<option value="' + m.id + '">' + escHtml(label) + '</option>';
                        }).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>登录学号/用户名<span style="color:red;">*</span></label>
                    <input type="text" id="openTeamStudentId" placeholder="将作为登录账号" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;">
                </div>
                <div class="form-group">
                    <label>角色</label>
                    <select id="openTeamRole" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;">
                        <option value="student">学生</option>
                        <option value="leader">组长</option>
                        <option value="admin">导师</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>所属小组</label>
                    <select id="openTeamGroup" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;">
                        <option value="">请选择小组</option>
                        ${GROUPS.map(g => '<option value="' + g + '">' + g + '</option>').join('')}
                    </select>
                </div>
                <div id="openTeamMemberPreview" style="display:none;padding:10px 12px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;font-size:13px;color:#389e0d;margin-bottom:12px;"></div>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
                    <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                    <button class="btn" onclick="confirmOpenTeamAccount('${modalId}')">开通账号</button>
                </div>
            </div>`;
        document.body.appendChild(div);
    }

    function onOpenTeamMemberPickChange() {
        const pick = document.getElementById('openTeamMemberPick');
        const preview = document.getElementById('openTeamMemberPreview');
        const sid = document.getElementById('openTeamStudentId');
        const roleSel = document.getElementById('openTeamRole');
        if (!pick || !pick.value) {
            if (preview) preview.style.display = 'none';
            return;
        }
        const m = (teamMemberData || []).find(function(x) { return Number(x.id) === Number(pick.value); });
        if (!m) return;
        if (sid && !sid.value) {
            sid.value = (typeof getMemberStudentId === 'function' ? getMemberStudentId(m) : ('member' + m.id));
        }
        if (roleSel) roleSel.value = m.category === 'advisor' ? 'admin' : 'student';
        if (preview) {
            const grade = m.category === 'advisor' ? '导师' : ((typeof getMemberCategoryLabel === 'function' ? getMemberCategoryLabel(m.category) : m.category + '级') + (m.graduated ? ' · 已毕业' : ' · 在读'));
            preview.style.display = 'block';
            preview.innerHTML = '将开通：<strong>' + escHtml(m.name) + '</strong>（' + escHtml(grade) + '）' + (m.email ? ' · ' + escHtml(m.email) : '');
        }
    }

    function confirmOpenTeamAccount(modalId) {
        const pick = document.getElementById('openTeamMemberPick');
        const sidEl = document.getElementById('openTeamStudentId');
        const roleEl = document.getElementById('openTeamRole');
        const groupEl = document.getElementById('openTeamGroup');
        if (!pick || !pick.value) { alert('请选择团队成员'); return; }
        const studentId = (sidEl && sidEl.value || '').trim();
        if (!studentId) { alert('请填写登录学号/用户名'); return; }
        if (accountData.find(a => a.studentId === studentId)) { alert('该学号已存在，不可重复'); return; }
        const m = (teamMemberData || []).find(function(x) { return Number(x.id) === Number(pick.value); });
        if (!m) { alert('团队成员不存在'); return; }
        let role = (roleEl && roleEl.value) || 'student';
        if (m.category === 'advisor') role = 'admin';
        else if (role === 'admin') role = 'student';
        const newId = accountData.length > 0 ? Math.max(...accountData.map(a => a.id)) + 1 : 1;
        accountData.push({
            id: newId,
            studentId: studentId,
            realName: m.name,
            role: role,
            group: role === 'admin' ? '' : ((groupEl && groupEl.value) || ''),
            grade: m.category === 'advisor' ? '' : (m.category + '级'),
            graduated: !!m.graduated,
            research: m.research || '',
            phone: m.phone || '',
            email: m.email || '',
            avatar: m.avatar || '',
            fromTeam: true,
            teamMemberId: m.id,
            status: 'active',
            password: DEFAULT_PASSWORD,
            mustChangePwd: true,
            firstLogin: true,
            lastLogin: '',
            lastLoginIp: '',
            createdAt: new Date().toISOString().split('T')[0],
            loginFailCount: 0,
            lockedUntil: null
        });
        saveAccountData();
        document.getElementById(modalId)?.remove();
        renderAccountTable();
        recordOperationLog('账号管理', '新增', '从团队开通账号：' + m.name + '(' + studentId + ')', { studentId: studentId, realName: m.name, role: role }, { success: true }, 1, '', 0);
        alert('已为「' + m.name + '」开通账号\n登录账号：' + studentId + '\n初始密码：' + DEFAULT_PASSWORD);
    }

    function showEditAccountModal(id) {
        const account = accountData.find(a => a.id === id);
        if (!account) return;
        const mode = isVisitorAccount(account) ? 'visitor' : 'team';
        document.body.appendChild(createAccountModal('编辑账号', account, { mode: mode }));
    }

    function createAccountModal(title, account, options) {
        const isEdit = !!account;
        options = options || {};
        const mode = options.mode || (isEdit && isVisitorAccount(account) ? 'visitor' : (isEdit ? 'team' : 'visitor'));
        const isVisitorMode = mode === 'visitor';
        const teamMember = isEdit && !isVisitorMode ? findTeamMemberForAccount(account) : null;
        const modalId = 'accountModal_' + Date.now();
        const div = document.createElement('div');
        div.id = modalId;
        div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:5000;display:flex;justify-content:center;align-items:center;';
        const gradeValue = teamMember
            ? (teamMember.category === 'advisor' ? '' : (teamMember.category + '级'))
            : (account && account.grade || '');
        const graduatedChecked = teamMember ? !!teamMember.graduated : !!(account && account.graduated);
        const tipHtml = isVisitorMode
            ? '<div style="margin-bottom:14px;padding:10px 12px;background:#fff7e6;border:1px solid #ffd591;border-radius:8px;font-size:12px;color:#ad6800;line-height:1.5;">访客为独立账号，不进入「团队成员档案」。</div>'
            : '<div style="margin-bottom:14px;padding:10px 12px;background:#f0f5ff;border:1px solid #adc6ff;border-radius:8px;font-size:12px;color:#1d39c4;line-height:1.5;">正式成员资料来自「团队成员档案」。姓名/年级/毕业状态请在团队管理中修改；此处可调整小组、角色与启用状态。</div>';
        const nameReadonly = !isVisitorMode && isEdit;
        const gradeReadonly = !isVisitorMode;
        const roleOptions = isVisitorMode
            ? '<option value="visitor" selected>访客（外校交流生/实习生）</option>'
            : ('<option value="admin" ' + (isEdit && account.role==='admin'?'selected':'') + '>导师（超级管理员）</option>'
                + '<option value="leader" ' + (isEdit && account.role==='leader'?'selected':'') + '>组长（大师兄/大师姐）</option>'
                + '<option value="student" ' + ((!isEdit || account.role==='student')?'selected':'') + '>学生（研究生/硕博）</option>');
        const gradeOpts = (typeof getMemberGradeYears === 'function' ? getMemberGradeYears() : ['2022','2023','2024','2025','2026']).map(function(y) {
            const g = y + '级';
            return '<option value="' + g + '" ' + (gradeValue===g?'selected':'') + '>' + g + '</option>';
        }).join('');
        div.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:28px;width:500px;max-width:90vw;max-height:85vh;overflow-y:auto;">
                <h3 style="margin:0 0 20px;">${title}</h3>
                ${tipHtml}
                <div class="form-group">
                    <label>学号（登录账号）<span style="color:red;">*</span> ${isEdit ? '<span style="color:#888;font-weight:normal;">(不可修改)</span>' : ''}</label>
                    <input type="text" id="modalStudentId" value="${isEdit ? escHtml(account.studentId) : ''}" ${isEdit ? 'disabled' : ''} placeholder="学号，作为系统登录账号" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;">
                </div>
                <div class="form-group">
                    <label>姓名<span style="color:red;">*</span></label>
                    <input type="text" id="modalRealName" value="${isEdit ? escHtml(account.realName) : ''}" ${nameReadonly ? 'readonly' : ''} placeholder="真实姓名" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;${nameReadonly ? 'background:#f5f5f5;' : ''}">
                </div>
                <div class="form-group">
                    <label>角色<span style="color:red;">*</span></label>
                    <select id="modalRole" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;" onchange="onModalRoleChange()">${roleOptions}</select>
                </div>
                <div class="form-group" id="modalGroupField" style="${(isEdit && account.role==='admin') || (!isEdit && isVisitorMode) ? 'display:none;' : ''}">
                    <label>所属小组</label>
                    <select id="modalGroup" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;">
                        <option value="">请选择小组</option>
                        ${GROUPS.map(function(g){ return '<option value="' + g + '" ' + (isEdit && account.group===g?'selected':'') + '>' + g + '</option>'; }).join('')}
                    </select>
                </div>
                <div class="form-group" id="modalGradeField" style="${isVisitorMode ? 'display:none;' : ((isEdit && (account.role==='student' || account.role==='leader')) || (!isEdit) ? '' : 'display:none;')}">
                    <label>年级 ${gradeReadonly ? '<span style="color:#888;font-weight:normal;">(来自团队管理)</span>' : ''}</label>
                    <select id="modalGrade" ${gradeReadonly ? 'disabled' : ''} style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;${gradeReadonly ? 'background:#f5f5f5;' : ''}">
                        <option value="">请选择年级</option>
                        ${gradeOpts}
                    </select>
                </div>
                <div class="form-group" id="modalGraduatedField" style="${isVisitorMode ? 'display:none;' : ((isEdit && (account.role==='student' || account.role==='leader')) ? '' : 'display:none;')}">
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                        <input type="checkbox" id="modalGraduated" ${graduatedChecked ? 'checked' : ''} ${gradeReadonly ? 'disabled' : ''}>
                        已毕业（请在团队成员档案中修改）
                    </label>
                </div>
                <div class="form-group">
                    <label>研究方向</label>
                    <input type="text" id="modalResearch" value="${isEdit ? escHtml(account.research||'') : ''}" ${nameReadonly ? 'readonly' : ''} placeholder="选填" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;${nameReadonly ? 'background:#f5f5f5;' : ''}">
                </div>
                <div class="form-group">
                    <label>手机号</label>
                    <input type="text" id="modalPhone" value="${isEdit ? escHtml(account.phone||'') : ''}" placeholder="选填" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;">
                </div>
                <div class="form-group">
                    <label>邮箱</label>
                    <input type="text" id="modalEmail" value="${isEdit ? escHtml(account.email||'') : ''}" placeholder="选填" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;">
                </div>
                <div class="form-group">
                    <label>账号状态</label>
                    <div style="display:flex;gap:20px;margin-top:4px;">
                        <label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;"><input type="radio" name="modalStatusRadio" value="active" ${!isEdit || account.status==='active'?'checked':''}> 正常</label>
                        <label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;"><input type="radio" name="modalStatusRadio" value="disabled" ${isEdit && account.status==='disabled'?'checked':''}> 禁用</label>
                    </div>
                </div>
                ${!isEdit ? `<div style="background:#f5f5f5;padding:10px;border-radius:6px;font-size:13px;color:#666;margin-bottom:16px;">新账号将自动生成默认密码：<strong>${DEFAULT_PASSWORD}</strong>，首次登录需修改密码</div>` : ''}
                <input type="hidden" id="modalAccountMode" value="${isVisitorMode ? 'visitor' : 'team'}">
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                    <button class="btn" onclick="saveAccountFromModal(${isEdit ? account.id : 'null'}, '${modalId}')">${isEdit ? '保存修改' : '创建账号'}</button>
                </div>
            </div>`;
        return div;
    }

    function onModalRoleChange() {
        const role = document.getElementById('modalRole').value;
        const modeEl = document.getElementById('modalAccountMode');
        const isVisitorMode = (modeEl && modeEl.value === 'visitor') || role === 'visitor';
        const groupField = document.getElementById('modalGroupField');
        const gradeField = document.getElementById('modalGradeField');
        const gf = document.getElementById('modalGraduatedField');
        if (groupField) groupField.style.display = (role === 'admin' || isVisitorMode) ? 'none' : '';
        if (gradeField) gradeField.style.display = (!isVisitorMode && (role === 'student' || role === 'leader')) ? '' : 'none';
        if (gf) gf.style.display = (!isVisitorMode && (role === 'student' || role === 'leader')) ? '' : 'none';
    }

    function onRegRoleChange() {
        const role = document.getElementById('regRole').value;
        document.getElementById('regGroupField').style.display = (role === 'admin' || role === 'visitor') ? 'none' : '';
    }

    function saveAccountFromModal(editId, modalId) {
        if (!editId && !hasPermission('账号管理（新建/删除）')) {
            alert('当前角色无「账号管理（新建/删除）」权限');
            return;
        }
        if (editId && !hasPermission('账号管理（查看列表）') && currentUser.role !== 'admin') {
            alert('当前角色无权编辑账号');
            return;
        }
        const modeEl = document.getElementById('modalAccountMode');
        const accountMode = (modeEl && modeEl.value) || 'visitor';
        const studentId = document.getElementById('modalStudentId').value.trim();
        const realName = document.getElementById('modalRealName').value.trim();
        let role = document.getElementById('modalRole').value;
        const groupEl = document.getElementById('modalGroup');
        const group = groupEl ? groupEl.value : '';
        const gradeEl = document.getElementById('modalGrade');
        const grade = gradeEl ? gradeEl.value : '';
        const graduatedEl = document.getElementById('modalGraduated');
        const research = document.getElementById('modalResearch').value.trim();
        const phone = document.getElementById('modalPhone').value.trim();
        const email = document.getElementById('modalEmail').value.trim();
        const status = document.querySelector('input[name="modalStatusRadio"]:checked')?.value || 'active';

        if (!studentId || !realName) { alert('学号和姓名为必填项'); return; }

        // 新建仅允许访客；正式成员须走「从团队开通」
        if (!editId) {
            role = 'visitor';
        }
        if (accountMode === 'visitor' || role === 'visitor') {
            role = 'visitor';
        }

        if (editId) {
            const account = accountData.find(a => a.id === editId);
            if (account) {
                if (isVisitorAccount(account) || role === 'visitor') {
                    account.realName = realName;
                    account.role = 'visitor';
                    account.group = '';
                    account.grade = '';
                    account.graduated = false;
                    account.fromTeam = false;
                    account.teamMemberId = null;
                } else {
                    // 正式成员：姓名/年级/毕业以团队为准，此处只改角色/小组/联系方式/状态
                    const m = findTeamMemberForAccount(account);
                    account.role = role === 'visitor' ? account.role : role;
                    account.group = account.role === 'admin' ? '' : group;
                    if (m) {
                        account.realName = m.name;
                        account.grade = m.category === 'advisor' ? '' : (m.category + '级');
                        account.graduated = !!m.graduated;
                        account.research = m.research || research;
                        account.fromTeam = true;
                        account.teamMemberId = m.id;
                    }
                }
                account.phone = phone;
                account.email = email;
                account.status = status;
                if (isVisitorAccount(account)) account.research = research;
            }
        } else {
            if (accountData.find(a => a.studentId === studentId)) { alert('该学号已存在，不可重复'); return; }
            const newId = accountData.length > 0 ? Math.max(...accountData.map(a => a.id)) + 1 : 1;
            accountData.push({
                id: newId, studentId, realName, role: 'visitor',
                group: '',
                grade: '',
                graduated: false,
                fromTeam: false,
                research, phone, email, status,
                password: DEFAULT_PASSWORD,
                mustChangePwd: true, firstLogin: true,
                lastLogin: '', lastLoginIp: '', createdAt: new Date().toISOString().split('T')[0],
                loginFailCount: 0, lockedUntil: null, avatar: ''
            });
        }
        saveAccountData();
        if (modalId) {
            document.getElementById(modalId)?.remove();
        } else {
            document.querySelector('div[style*="z-index:5000"]')?.remove();
        }
        renderAccountTable();
        
        if (editId) {
            recordOperationLog('账号管理', '修改', `编辑账号：${realName}(${studentId})`, { studentId, realName, role }, { success: true }, 1, '', 0);
        } else {
            recordOperationLog('账号管理', '新增', `创建访客账号：${realName}(${studentId})`, { studentId, realName, role: 'visitor' }, { success: true }, 1, '', 0);
        }
        
        alert(editId ? '账号已更新' : `访客账号创建成功！\n学号：${studentId}\n初始密码：${DEFAULT_PASSWORD}\n首次登录需修改密码`);
    }

    function resetAccountPassword(id) {
        if (!confirm(`确定要重置该账号密码为 "${DEFAULT_PASSWORD}" 吗？`)) return;
        const account = accountData.find(a => a.id === id);
        if (account) {
            account.password = DEFAULT_PASSWORD;
            account.mustChangePwd = true;
            account.loginFailCount = 0;
            account.lockedUntil = null;
            saveAccountData();
            alert(`已重置 "${account.realName}" 的密码为 ${DEFAULT_PASSWORD}，下次登录需修改密码`);
        }
    }

    function toggleAccountStatus(id) {
        const account = accountData.find(a => a.id === id);
        if (!account) return;
        account.status = account.status === 'active' ? 'disabled' : 'active';
        saveAccountData();
        renderAccountTable();
    }

    function graduateAccount(id) {
        if (!confirm('确定要将该学生标记为毕业归档吗？\n将同步到「团队成员档案」并禁用账号，历史数据保留。')) return;
        const account = accountData.find(a => a.id === id);
        if (!account) return;
        account.status = 'disabled';
        account.graduated = true;
        // 同步到团队成员档案
        try {
            const m = findTeamMemberForAccount(account);
            if (m && m.category !== 'advisor') {
                m.graduated = true;
                if (typeof saveTeamMemberData === 'function') saveTeamMemberData();
                if (typeof renderTeamMembers === 'function') renderTeamMembers();
            }
        } catch (eGrad) {}
        saveAccountData();
        renderAccountTable();
        alert(`"${account.realName}" 已毕业归档，账号已禁用，且不再接收通知`);
    }

    function deleteAccount(id) {
        if (!hasPermission('账号管理（新建/删除）')) { alert('当前角色无「账号管理（新建/删除）」权限'); return; }
        const account = accountData.find(a => a.id === id);
        if (!account) return;
        if (!isVisitorAccount(account) && findTeamMemberForAccount(account)) {
            if (!confirm('该账号关联「团队成员档案」。删除后下次同步可能重新生成登录账号。\n建议优先「禁用」账号，或先在团队管理中删除成员。\n\n仍要删除此账号吗？')) return;
        } else {
            if (!confirm('确定要删除此账号吗？此操作不可恢复。')) return;
        }
        accountData = accountData.filter(a => a.id !== id);
        saveAccountData();
        renderAccountTable();
        recordOperationLog('账号管理', '删除', `删除账号：${account.realName}(${account.studentId})`, { studentId: account.studentId }, { success: true }, 1, '', 0);
    }

    function showLoginLogModal(studentId) {
        const logs = loginLogData.filter(l => l.studentId === studentId).slice(-20).reverse();
        const account = accountData.find(a => a.studentId === studentId);
        const modalId = 'loginLogModal_' + Date.now();
        const div = document.createElement('div');
        div.id = modalId;
        div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:5000;display:flex;justify-content:center;align-items:center;';
        div.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:28px;width:560px;max-width:90vw;max-height:70vh;overflow-y:auto;">
                <h3 style="margin:0 0 16px;">登录日志 - ${escHtml(account?.realName || studentId)}</h3>
                ${logs.length === 0 ? '<p style="color:#888;">暂无登录记录</p>' : `
                <table class="table" style="font-size:13px;">
                    <thead><tr><th>时间</th><th>IP</th><th>结果</th></tr></thead>
                    <tbody>${logs.map(l => `<tr><td>${escHtml(l.loginTime)}</td><td>${escHtml(l.ip)}</td><td>${escHtml(l.result)}</td></tr>`).join('')}</tbody>
                </table>`}
                <div style="display:flex;justify-content:flex-end;margin-top:16px;">
                    <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">关闭</button>
                </div>
            </div>`;
        document.body.appendChild(div);
    }

    function exportAccounts() {
        const rows = [['学号', '姓名', '角色', '所属小组', '年级', '研究方向', '手机号', '邮箱', '状态', '最后登录', '创建时间']];
        accountData.forEach(a => {
            rows.push([a.studentId, a.realName, ROLE_LABELS[a.role], a.group || '', a.grade || '', a.research || '', a.phone || '', a.email || '', a.status === 'active' ? '已启用' : '已禁用', a.lastLogin || '', a.createdAt || '']);
        });
        const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `账号数据_${new Date().toISOString().split('T')[0]}.csv`; a.click();
        URL.revokeObjectURL(url);
    }

    // ===== 5. 账号注册 =====
    function handleAccountRegister() {
        if (currentUser && currentUser.role !== 'admin') { alert('只有导师可以注册账号'); return; }
        const studentId = document.getElementById('regUsername').value.trim();
        const realName = document.getElementById('regRealName').value.trim();
        const role = document.getElementById('regRole').value;
        const group = document.getElementById('regGroup').value;
        const email = document.getElementById('regEmail').value.trim();
        const password = document.getElementById('regPassword').value;
        const passwordConfirm = document.getElementById('regPasswordConfirm').value;

        if (!studentId || !realName) { alert('学号和姓名为必填项'); return; }
        if (accountData.find(a => a.studentId === studentId)) { alert('该学号已存在'); return; }
        if (!validatePassword(password)) { alert('密码不符合安全策略要求'); return; }
        if (password !== passwordConfirm) { alert('两次输入的密码不一致'); return; }

        // 正式成员须已在团队档案中；访客可独立注册
        if (role !== 'visitor') {
            const members = (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData)) ? teamMemberData : [];
            const m = members.find(function(x) {
                return x && (x.name === realName || (email && x.email === email));
            });
            if (!m) {
                alert('正式成员须先在「团队成员档案」中添加，再注册账号。\n访客角色可直接注册。');
                return;
            }
            if (accountData.some(function(a) {
                return a.role !== 'visitor' && (a.realName === m.name || (a.teamMemberId && Number(a.teamMemberId) === Number(m.id)));
            })) {
                alert('该团队成员已有账号，请勿重复注册');
                return;
            }
            const newId = accountData.length > 0 ? Math.max(...accountData.map(a => a.id)) + 1 : 1;
            let finalRole = role;
            if (m.category === 'advisor') finalRole = 'admin';
            else if (finalRole === 'admin') finalRole = 'student';
            accountData.push({
                id: newId, studentId, realName: m.name, role: finalRole,
                group: finalRole === 'admin' ? '' : group,
                grade: m.category === 'advisor' ? '' : (m.category + '级'),
                graduated: !!m.graduated,
                research: m.research || '', phone: m.phone || '', email: email || m.email || '',
                fromTeam: true, teamMemberId: m.id,
                status: 'active',
                password, mustChangePwd: true, firstLogin: true,
                lastLogin: '', lastLoginIp: '', createdAt: new Date().toISOString().split('T')[0],
                loginFailCount: 0, lockedUntil: null, avatar: m.avatar || ''
            });
        } else {
            const newId = accountData.length > 0 ? Math.max(...accountData.map(a => a.id)) + 1 : 1;
            accountData.push({
                id: newId, studentId, realName, role: 'visitor',
                group: '', grade: '', graduated: false, fromTeam: false,
                research: '', phone: '', email, status: 'active',
                password, mustChangePwd: true, firstLogin: true,
                lastLogin: '', lastLoginIp: '', createdAt: new Date().toISOString().split('T')[0],
                loginFailCount: 0, lockedUntil: null, avatar: ''
            });
        }
        saveAccountData();
        ['regUsername','regRealName','regEmail','regPassword','regPasswordConfirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('regPwdStrength').textContent = '';
        document.getElementById('regPwdStrengthBar').style.width = '0';
        alert(`账号 "${studentId}" 注册成功！`);
        try { renderAccountTable(); } catch (e) {}
    }

    // ===== 6. 批量导入 =====
    let importPreviewData = [];

    function downloadImportTemplate() {
        const csv = '\ufeff学号,姓名,角色,所属小组,年级,研究方向,手机号,邮箱\n2025001,张三,student,第一小组,2025级,深度学习,13800001001,zhangsan@university.edu.cn\n2025002,李四,student,第二小组,2025级,计算机视觉,13800001002,lisi@university.edu.cn\n2025003,王五,leader,第一小组,2024级,数据挖掘,13800001003,wangwu@university.edu.cn';
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = '账号导入模板.csv'; a.click();
        URL.revokeObjectURL(url);
    }

    function handleImportFileSelect() {
        const fileInput = document.getElementById('accountImportFile');
        const resultDiv = document.getElementById('accountImportResult');
        if (!fileInput.files[0]) return;

        const fileName = fileInput.files[0].name.toLowerCase();
        resultDiv.innerHTML = '';

        if (fileName.endsWith('.csv')) {
            parseCSVFile(fileInput.files[0]);
        } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
            var file = fileInput.files[0];
            var run = function () { parseExcelFile(file); };
            if (typeof ensureVendor === 'function') {
                ensureVendor('xlsx').then(run).catch(function () {
                    resultDiv.innerHTML = '<div style="color:#e53935;">Excel 组件加载失败</div>';
                });
            } else {
                run();
            }
        } else {
            resultDiv.innerHTML = '<div style="color:#e53935;">不支持的文件格式，请选择 CSV 或 Excel 文件</div>';
        }
    }

    function parseCSVFile(file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length < 2) {
                document.getElementById('accountImportResult').innerHTML = '<div style="color:#e53935;">文件为空或格式不正确</div>';
                return;
            }
            processImportData(lines);
        };
        reader.readAsText(file, 'UTF-8');
    }

    function parseExcelFile(file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                const lines = jsonData.map(row => row.join(','));
                if (lines.length < 2) {
                    document.getElementById('accountImportResult').innerHTML = '<div style="color:#e53935;">文件为空或格式不正确</div>';
                    return;
                }
                processImportData(lines);
            } catch (error) {
                document.getElementById('accountImportResult').innerHTML = '<div style="color:#e53935;">Excel 文件解析失败：' + error.message + '</div>';
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function processImportData(lines) {
        importPreviewData = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i]);
            const [studentId, realName, role, group, grade, research, phone, email] = cols.map(c => (c || '').trim().replace(/^"|"$/g, ''));
            
            let status = '✅ 正常';
            let errorMsg = '';
            
            if (!studentId || !realName) {
                status = '❌ 学号或姓名为空';
                errorMsg = '学号或姓名不能为空';
            } else if (accountData.find(a => a.studentId === studentId)) {
                status = '❌ 学号已存在';
                errorMsg = '学号已存在';
            } else if (!role || !['admin', 'leader', 'student', 'visitor'].includes(role)) {
                status = '⚠️ 角色无效';
                errorMsg = '角色无效，将默认设为student';
            }
            
            importPreviewData.push({
                rowNum: i + 1,
                studentId,
                realName,
                role: role && ['admin', 'leader', 'student', 'visitor'].includes(role) ? role : 'student',
                group: group || '',
                grade: grade || '',
                research: research || '',
                phone: phone || '',
                email: email || '',
                status,
                errorMsg
            });
        }
        renderImportPreview();
    }

    function renderImportPreview() {
        const previewTable = document.getElementById('importPreviewTable');
        const previewArea = document.getElementById('importPreviewArea');
        
        const validCount = importPreviewData.filter(d => !d.errorMsg || d.errorMsg === '角色无效，将默认设为student').length;
        const errorCount = importPreviewData.filter(d => d.errorMsg && d.errorMsg !== '角色无效，将默认设为student').length;
        
        let html = '';
        importPreviewData.slice(0, 10).forEach(item => {
            const statusColor = item.status.includes('❌') ? 'color:#e53935;' : item.status.includes('⚠️') ? 'color:#f57c00;' : 'color:#2e7d32;';
            html += `<tr>
                <td style="padding:8px;border-bottom:1px solid #eee;">${escHtml(item.studentId)}</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${escHtml(item.realName)}</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${escHtml(ROLE_LABELS[item.role] || item.role)}</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${escHtml(item.group)}</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${escHtml(item.grade)}</td>
                <td style="padding:8px;border-bottom:1px solid #eee;${statusColor}">${item.status}</td>
            </tr>`;
        });
        
        if (importPreviewData.length > 10) {
            html += `<tr><td colspan="6" style="padding:8px;text-align:center;color:#888;font-size:12px;">... 还有 ${importPreviewData.length - 10} 条记录</td></tr>`;
        }
        
        previewTable.innerHTML = html;
        previewArea.style.display = 'block';
        
        const resultDiv = document.getElementById('accountImportResult');
        resultDiv.innerHTML = `<div style="padding:12px;background:#f3e5f5;border-radius:6px;color:#6a1b9a;">共读取 ${importPreviewData.length} 条记录，其中 ${validCount} 条有效，${errorCount} 条无效</div>`;
    }

    function clearImportPreview() {
        document.getElementById('importPreviewArea').style.display = 'none';
        document.getElementById('accountImportResult').innerHTML = '';
        document.getElementById('accountImportFile').value = '';
        importPreviewData = [];
    }

    function confirmAccountImport() {
        if (currentUser && currentUser.role !== 'admin') { alert('只有导师可以导入账号'); return; }
        
        const passwordInput = document.getElementById('accountImportPassword');
        const password = passwordInput.value.trim() || DEFAULT_PASSWORD;
        
        let success = 0, failed = 0;
        const errors = [];
        
        importPreviewData.forEach(item => {
            if (item.errorMsg && item.errorMsg !== '角色无效，将默认设为student') {
                failed++;
                errors.push(`第${item.rowNum}行：${item.errorMsg}`);
                return;
            }
            
            if (accountData.find(a => a.studentId === item.studentId)) {
                failed++;
                errors.push(`第${item.rowNum}行：学号已存在(${item.studentId})`);
                return;
            }
            
            const newId = accountData.length > 0 ? Math.max(...accountData.map(a => a.id)) + 1 : 1;
            accountData.push({
                id: newId,
                studentId: item.studentId,
                realName: item.realName,
                role: item.role,
                group: item.group,
                grade: item.grade,
                research: item.research,
                phone: item.phone,
                email: item.email,
                status: 'active',
                password: password,
                mustChangePwd: true,
                firstLogin: true,
                lastLogin: '',
                lastLoginIp: '',
                createdAt: new Date().toISOString().split('T')[0],
                loginFailCount: 0,
                lockedUntil: null,
                avatar: ''
            });
            success++;
        });
        
        saveAccountData();
        
        const resultDiv = document.getElementById('accountImportResult');
        let html = `<div style="padding:12px;background:#e8f5e9;border-radius:6px;color:#2e7d32;">导入完成：成功 ${success} 条，失败 ${failed} 条<br>所有账号初始密码为 <strong>${password}</strong>，首次登录需修改密码</div>`;
        if (errors.length > 0) {
            html += '<div style="margin-top:8px;font-size:13px;color:#e53935;max-height:200px;overflow-y:auto;">失败详情：<br>' + errors.join('<br>') + '</div>';
        }
        resultDiv.innerHTML = html;
        
        clearImportPreview();
        passwordInput.value = '';
        renderAccountTable();
    }

    // ===== 7. 密码管理 =====
    function handleChangePassword() {
        const oldPwd = document.getElementById('pwdOld').value;
        const newPwd = document.getElementById('pwdNew').value;
        const newPwdConfirm = document.getElementById('pwdNewConfirm').value;
        if (!oldPwd || !newPwd) { alert('请填写完整'); return; }
        var acc = findAccountRecordForUser(currentUser);
        var checkPwd = (acc && acc.password) || (currentUser && currentUser.password);
        if (checkPwd !== oldPwd) { alert('当前密码错误'); return; }
        if (!validatePassword(newPwd)) { alert('新密码不符合复杂度要求（至少8位，含字母和数字）'); return; }
        if (newPwd !== newPwdConfirm) { alert('两次输入的新密码不一致'); return; }
        if (!acc) { alert('找不到账号记录'); return; }
        var ts = Date.now();
        acc.password = newPwd;
        acc.mustChangePwd = false;
        acc.firstLogin = false;
        acc.passwordUpdatedAt = ts;
        currentUser = acc;
        try {
            sessionStorage.setItem('pendingPasswordCommit', JSON.stringify({
                userId: acc.id, studentId: acc.studentId || '', password: newPwd, ts: ts
            }));
        } catch (eS) {}
        saveAccountData();
        try { if (typeof cloudUpsert === 'function') cloudUpsert('accountData', JSON.stringify(accountData)); } catch (eC) {}
        try { setTimeout(function() { clearPendingPasswordCommit(); }, 2000); } catch (eT) {}
        ['pwdOld','pwdNew','pwdNewConfirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('newPwdStrength').textContent = '';
        document.getElementById('newPwdStrengthBar').style.width = '0';
        recordOperationLog('账号权限', '修改', `${currentUser.realName}(${currentUser.studentId}) 修改密码`, { studentId: currentUser.studentId }, { success: true }, 1, '', 0);
        alert('密码修改成功！');
    }

    function handleResetPassword() {
        if (currentUser && currentUser.role !== 'admin') { alert('只有导师可以重置密码'); return; }
        const userId = parseInt(document.getElementById('resetPwdUser').value);
        const newPwd = document.getElementById('resetPwdNew').value;
        if (!userId || !newPwd) { alert('请选择用户并输入新密码'); return; }
        if (!validatePassword(newPwd)) { alert('密码不符合复杂度要求'); return; }
        const account = accountData.find(a => a.id === userId);
        if (account) {
            account.password = newPwd;
            account.mustChangePwd = true;
            account.loginFailCount = 0;
            account.lockedUntil = null;
            saveAccountData();
            document.getElementById('resetPwdNew').value = '';
            recordOperationLog('账号权限', '修改', `${currentUser.realName} 重置 ${account.realName}(${account.studentId}) 的密码`, { targetStudentId: account.studentId }, { success: true }, 1, '', 0);
            alert(`用户 "${account.realName}" 的密码已重置`);
        }
    }

    // ===== 8. 密码强度 & 策略 =====
    function validatePassword(pwd) {
        if (pwd.length < passwordPolicy.minLength) return false;
        if (passwordPolicy.requireUpper && !/[A-Z]/.test(pwd)) return false;
        if (passwordPolicy.requireLower && !/[a-z]/.test(pwd)) return false;
        if (passwordPolicy.requireDigit && !/[0-9]/.test(pwd)) return false;
        if (passwordPolicy.requireSpecial && !/[!@#$%^&*]/.test(pwd)) return false;
        return true;
    }

    function checkPasswordStrength(pwd, labelId) {
        const bar = document.getElementById(labelId + 'Bar');
        const label = document.getElementById(labelId);
        if (!label) return;
        let score = 0;
        if (pwd.length >= 8) score++; if (pwd.length >= 12) score++;
        if (/[A-Z]/.test(pwd)) score++; if (/[a-z]/.test(pwd)) score++;
        if (/[0-9]/.test(pwd)) score++; if (/[!@#$%^&*]/.test(pwd)) score++;
        const levels = [{ max: 2, text: '弱', color: '#f44336', width: '33%' }, { max: 4, text: '中', color: '#ff9800', width: '66%' }, { max: 6, text: '强', color: '#4caf50', width: '100%' }];
        const level = levels.find(l => score <= l.max) || levels[2];
        if (bar) { bar.style.width = pwd ? level.width : '0'; bar.style.background = level.color; }
        label.textContent = pwd ? `密码强度：${level.text}` : '';
        label.style.color = level.color;
    }

    function savePasswordPolicy() {
        passwordPolicy = {
            requireUpper: document.getElementById('pwdRequireUpper').checked,
            requireLower: document.getElementById('pwdRequireLower').checked,
            requireDigit: document.getElementById('pwdRequireDigit').checked,
            requireSpecial: document.getElementById('pwdRequireSpecial').checked,
            minLength: parseInt(document.getElementById('pwdMinLength').value) || 8
        };
        localStorage.setItem('passwordPolicy', JSON.stringify(passwordPolicy));
        alert('密码策略已保存');
    }

    // ===== 9. 登录安全 =====
    function saveSecuritySettings() {
        const maxAttempts = parseInt(document.getElementById('securityMaxAttempts').value) || 5;
        const lockDuration = parseInt(document.getElementById('securityLockDuration').value) || 30;
        setConfig('user.passwordErrorLockCount', maxAttempts);
        setConfig('user.lockTime', lockDuration);
        recordOperationLog('系统设置', '修改', `修改安全策略：最大尝试次数${maxAttempts}次，锁定时长${lockDuration}分钟`, 
            { maxAttempts, lockDuration }, { success: true }, 1, '', 0);
        alert('安全设置已保存');
    }

    function showCurrentSecurityStatus() {
        const el = document.getElementById('currentAccountSecurityStatus');
        if (!el || !currentUser) return;
        const attempts = loginAttempts[currentUser.studentId] || 0;
        const maxAttempts = getConfigInt('user.passwordErrorLockCount', 5);
        const isLocked = currentUser.lockedUntil && new Date(currentUser.lockedUntil) > new Date();
        const session = JSON.parse(localStorage.getItem('currentSession') || 'null');
        const tokenExpire = session ? new Date(session.loginTime + TOKEN_EXPIRE_MS).toLocaleString('zh-CN') : '-';
        el.innerHTML = `
            <p>当前用户：<strong>${escHtml(currentUser.realName)}</strong>（${ROLE_LABELS[currentUser.role]}）</p>
            <p>登录失败次数：<strong style="color:${attempts >= maxAttempts - 2 ? '#e53935' : '#333'}">${attempts} / ${maxAttempts}</strong></p>
            <p>账号状态：${isLocked ? '<span style="color:#e53935;">已锁定</span>' : '<span style="color:#4caf50;">正常</span>'}</p>
            <p>上次登录：${currentUser.lastLogin || '从未登录'}（IP: ${currentUser.lastLoginIp || '-'}）</p>
            <p>Token 过期时间：${tokenExpire}</p>
            <p>首次登录改密：${currentUser.mustChangePwd ? '<span style="color:#e65100;">需要</span>' : '<span style="color:#4caf50;">已完成</span>'}</p>`;
    }

    // ===== 10. 权限矩阵 =====
    function renderPermissionMatrix() {
        const tbody = document.getElementById('permissionMatrixBody');
        if (!tbody) return;
        tbody.innerHTML = permissionMatrix.map((perm, idx) => `
            <tr>
                <td>${escHtml(perm[0])}</td>
                ${[1,2,3,4].map(ri => `<td>${currentUser && currentUser.role === 'admin'
                    ? `<input type="checkbox" class="perm-check" ${perm[ri] ? 'checked' : ''} onchange="updatePermCell(${idx},${ri},this.checked)">`
                    : (perm[ri] ? '<span class="perm-yes">✓</span>' : '<span class="perm-no">-</span>')}</td>`).join('')}
            </tr>`).join('');
    }

    function updatePermCell(row, col, checked) { permissionMatrix[row][col] = checked; }

    function savePermissionMatrix() {
        if (currentUser && currentUser.role !== 'admin') { alert('只有导师可以修改权限配置'); return; }
        savePermissionData();
        applyRolePermissions();
        try {
            if (typeof cloudUpsert === 'function') {
                cloudUpsert('permissionMatrix', JSON.stringify(permissionMatrix)).then(function() {
                    if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner('权限配置已同步到云端（全局生效）', false);
                });
            }
        } catch (e) {}
        alert('权限配置已保存，并将同步到所有终端');
    }

    function resetPermissionMatrix() {
        if (!confirm('确定要恢复默认权限配置吗？')) return;
        permissionMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
        savePermissionData(); renderPermissionMatrix();
        alert('已恢复默认权限配置');
    }

    // ===== 11. 学生个人账号中心 =====
    function showPersonalCenter() {
        if (!currentUser) return;
        const div = document.createElement('div');
        div.id = 'personalCenterModal';
        div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:5000;display:flex;justify-content:center;align-items:center;';
        div.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:28px;width:520px;max-width:90vw;max-height:85vh;overflow-y:auto;">
                <h3 style="margin:0 0 20px;">个人账号中心</h3>
                <div style="text-align:center;margin-bottom:20px;">
                    <div id="personalAvatar" style="width:80px;height:80px;border-radius:50%;background:#667eea;color:white;display:inline-flex;align-items:center;justify-content:center;font-size:32px;cursor:pointer;" onclick="document.getElementById('avatarUpload').click()" title="点击上传头像">
                        ${currentUser.avatar ? `<img src="${currentUser.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : currentUser.realName.charAt(0)}
                    </div>
                    <input type="file" id="avatarUpload" accept="image/*" style="display:none;" onchange="uploadAvatar(this)">
                    <p style="font-size:12px;color:#888;margin-top:6px;">点击上传头像</p>
                </div>
                <div class="form-group"><label>学号</label><input type="text" value="${escHtml(currentUser.studentId)}" disabled style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;"></div>
                <div class="form-group"><label>姓名</label><input type="text" value="${escHtml(currentUser.realName)}" disabled style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;"><small style="color:#888;">姓名不可修改</small></div>
                <div class="form-group"><label>角色</label><input type="text" value="${ROLE_LABELS[currentUser.role]}" disabled style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;"></div>
                <div class="form-group"><label>手机号</label><input type="text" id="personalPhone" value="${escHtml(currentUser.phone||'')}" placeholder="选填" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;"></div>
                <div class="form-group"><label>邮箱</label><input type="text" id="personalEmail" value="${escHtml(currentUser.email||'')}" placeholder="选填" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;"></div>
                <div class="form-group"><label>研究方向</label><input type="text" id="personalResearch" value="${escHtml(currentUser.research||'')}" placeholder="选填" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;"></div>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
                    <button class="btn btn-secondary" onclick="document.getElementById('personalCenterModal').remove()">关闭</button>
                    <button class="btn" onclick="savePersonalInfo()">保存信息</button>
                </div>
                <hr style="margin:24px 0;border:none;border-top:1px solid #eee;">
                <h4 style="margin-bottom:12px;">我的角色权限</h4>
                <div style="background:#f5f5f5;padding:12px;border-radius:8px;font-size:13px;">
                    <p><strong>角色：</strong>${ROLE_LABELS[currentUser.role]}</p>
                    <p><strong>拥有权限：</strong></p>
                    <ul style="margin:4px 0 0 20px;padding:0;">
                        ${permissionMatrix.filter(p => p[{admin:1,leader:2,student:3,visitor:4}[currentUser.role]]).map(p => `<li>${escHtml(p[0])}</li>`).join('')}
                    </ul>
                </div>
            </div>`;
        document.body.appendChild(div);
    }

    function uploadAvatar(input) {
        const file = input.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            currentUser.avatar = e.target.result;
            const acc = accountData.find(a => a.id === currentUser.id);
            if (acc) acc.avatar = e.target.result;
            saveAccountData();
            document.getElementById('personalAvatar').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
            updateHeaderUserInfo();
        };
        reader.readAsDataURL(file);
    }

    function savePersonalInfo() {
        currentUser.phone = document.getElementById('personalPhone').value.trim();
        currentUser.email = document.getElementById('personalEmail').value.trim();
        currentUser.research = document.getElementById('personalResearch').value.trim();
        const acc = accountData.find(a => a.id === currentUser.id);
        if (acc) { acc.phone = currentUser.phone; acc.email = currentUser.email; acc.research = currentUser.research; }
        saveAccountData();
        alert('个人信息已保存');
    }

    // ===== 12. 标签页切换 =====
    function switchAccountTab(tabId, btn) {
        document.querySelectorAll('.account-tab-content').forEach(el => el.style.display = 'none');
        document.querySelectorAll('#accountTabNav .tab-btn').forEach(b => b.classList.remove('active'));
        const tabEl = document.getElementById('accountTab_' + tabId);
        if (tabEl) tabEl.style.display = 'block';
        if (btn) btn.classList.add('active');
        if (tabId === 'accountList') renderAccountTable();
        if (tabId === 'loginSecurity') {
            document.getElementById('securityMaxAttempts').value = getConfigInt('user.passwordErrorLockCount', 5);
            document.getElementById('securityLockDuration').value = getConfigInt('user.lockTime', 30);
            document.getElementById('pwdRequireUpper').checked = passwordPolicy.requireUpper;
            document.getElementById('pwdRequireLower').checked = passwordPolicy.requireLower;
            document.getElementById('pwdRequireDigit').checked = passwordPolicy.requireDigit;
            document.getElementById('pwdRequireSpecial').checked = passwordPolicy.requireSpecial;
            document.getElementById('pwdMinLength').value = passwordPolicy.minLength;
            showCurrentSecurityStatus();
        }
        if (tabId === 'passwordManage') {
            const select = document.getElementById('resetPwdUser');
            if (select && currentUser && currentUser.role === 'admin') {
                select.innerHTML = '<option value="">请选择用户</option>' +
                    accountData.filter(a => a.id !== currentUser.id).map(a => `<option value="${a.id}">${escHtml(a.realName)}（${escHtml(a.studentId)} - ${ROLE_LABELS[a.role]}）</option>`).join('');
            }
        }
    }

    // ===== 13. 工具函数 =====
    function escHtml(str) { if (!str) return ''; const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

    function parseCSVLine(line) {
        const result = []; let current = ''; let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) { if (ch === '"' && line[i+1] === '"') { current += '"'; i++; } else if (ch === '"') inQuotes = false; else current += ch; }
            else { if (ch === '"') inQuotes = true; else if (ch === ',') { result.push(current); current = ''; } else current += ch; }
        }
        result.push(current);
        return result;
    }

    // ===== 14. Token 过期检测 =====
    setInterval(() => {
        if (!currentUser) return;
        const session = JSON.parse(localStorage.getItem('currentSession') || 'null');
        if (session && Date.now() - session.loginTime >= TOKEN_EXPIRE_MS) {
            alert('登录已过期（超过24小时），请重新登录');
            handleLogout();
        }
    }, 60000);

    // ===== 15. 页面路由钩子 =====
    const _origShowModule = showModule;
    showModule = function(moduleId) {
        _origShowModule(moduleId);
        if (moduleId === 'account_permission') { renderAccountTable(); renderPermissionMatrix(); }
        if (moduleId === 'role_permission') renderPermissionMatrix();
        if (moduleId === 'task_management') { initTaskManagement(); }
    };

    // ===== 任务管理模块 =====
    let taskData = [];
    let selectedTaskIds = new Set();
    let editingTaskId = null;
    let taskPage = 1;
    const TASK_PAGE_SIZE = 10;

    const PRIORITY_CONFIG = {
        high: { label: '高', color: '#ff4d4f', bgColor: '#fff1f0', borderColor: '#ffccc7' },
        medium: { label: '中', color: '#faad14', bgColor: '#fffbe6', borderColor: '#ffe58f' },
        low: { label: '低', color: '#52c41a', bgColor: '#f6ffed', borderColor: '#b7eb8f' }
    };

    const STATUS_CONFIG = {
        pending: { label: '待处理', color: '#1890ff', bgColor: '#e6f7ff', borderColor: '#91d5ff' },
        progress: { label: '进行中', color: '#faad14', bgColor: '#fffbe6', borderColor: '#ffe58f' },
        completed: { label: '已完成', color: '#52c41a', bgColor: '#f6ffed', borderColor: '#b7eb8f' },
        overdue: { label: '已逾期', color: '#ff4d4f', bgColor: '#fff1f0', borderColor: '#ffccc7' }
    };

    function initTaskManagement() {
        loadTaskData();
        populateOwnerSelects();
        updateTaskStats();
        renderTaskList();
    }

    function loadTaskData() {
        const stored = localStorage.getItem('taskData');
        if (stored) {
            taskData = JSON.parse(stored);
            migrateTaskDataToRealTeam();
        } else {
            taskData = buildRealTeamDefaultTasks();
            saveTaskData();
        }
    }

    function getRealTeamOwnerNames() {
        const members = Array.isArray(teamMemberData) ? teamMemberData : [];
        const students = members.filter(m => m && m.category !== 'advisor').map(m => m.name).filter(Boolean);
        const advisors = members.filter(m => m && m.category === 'advisor').map(m => m.name).filter(Boolean);
        return [...new Set([...students, ...advisors])].filter(Boolean);
    }

    function addDaysForTask(days, hour) {
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(hour || 18, 0, 0, 0);
        return d.toISOString().slice(0, 16).replace('T', ' ');
    }

    function buildRealTeamDefaultTasks() {
        const owners = getRealTeamOwnerNames();
        const pick = idx => owners[idx % Math.max(owners.length, 1)] || (currentUser && currentUser.realName) || '团队成员';
        return [
            { id: 1, title: '完善团队成员档案与头像信息', priority: 'high', owner: pick(0), deadline: addDaysForTask(1, 18), status: 'pending', description: '补全个人简介、联系方式、研究方向、教育背景，并确保成员档案与账号权限同步。', visibility: 'all', publisher: currentUser?.realName || '系统' },
            { id: 2, title: '汇总城市安全方向近期文献', priority: 'medium', owner: pick(1), deadline: addDaysForTask(3, 18), status: 'pending', description: '围绕城市安全、智能监测、结构风险评估等方向整理近期重点文献，上传到资源中心。', visibility: 'all', publisher: currentUser?.realName || '系统' },
            { id: 3, title: '整理项目与成果台账', priority: 'medium', owner: pick(2), deadline: addDaysForTask(5, 18), status: 'progress', description: '核对纵向项目、横向项目、论文、专利、软著等台账，确保负责人和成果信息准确。', visibility: 'all', publisher: currentUser?.realName || '系统' },
            { id: 4, title: '提交本周团队工作周报', priority: 'high', owner: pick(3), deadline: addDaysForTask(2, 20), status: 'pending', description: '每位成员按实际工作提交周报，导师和组长统一查看审核。', visibility: 'all', publisher: currentUser?.realName || '系统' },
            { id: 5, title: '准备组会汇报材料', priority: 'high', owner: pick(4), deadline: addDaysForTask(4, 12), status: 'pending', description: '准备本周组会汇报，包括研究进展、问题清单、下周计划。', visibility: 'all', publisher: currentUser?.realName || '系统' }
        ];
    }

    function migrateTaskDataToRealTeam() {
        const validNames = new Set(getRealTeamOwnerNames());
        const demoOwners = ['张三', '李四', '王五', '赵六'];
        const hasDemo = Array.isArray(taskData) && taskData.some(t => demoOwners.includes(t.owner));
        if (!hasDemo) {
            taskData = (taskData || []).map(t => ({
                ...t,
                owner: validNames.has(t.owner) ? t.owner : replaceUnknownOwnerWithTeamMember(t.owner),
                visibility: 'all',
                publisher: t.publisher || '系统'
            }));
            saveTaskData();
            return;
        }
        taskData = buildRealTeamDefaultTasks();
        saveTaskData();
    }

    function saveTaskData() {
        taskData = (taskData || []).map(t => ({ ...t, visibility: 'all', publisher: t.publisher || (currentUser?.realName || '系统') }));
        localStorage.setItem('taskData', JSON.stringify(taskData));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('taskData', JSON.stringify(taskData)); } catch (e) {}
        try { if (typeof renderHomeDashboard === 'function') renderHomeDashboard(); } catch (e2) {}
    }

    function populateOwnerSelects() {
        const allOwners = getRealTeamOwnerNames();
        
        const filterSelect = document.getElementById('taskOwnerFilter');
        const modalSelect = document.getElementById('taskOwner');
        
        if (filterSelect) {
            filterSelect.innerHTML = '<option value="">全部负责人</option>' + allOwners.map(o => `<option value="${o}">${o}</option>`).join('');
        }
        if (modalSelect) {
            modalSelect.innerHTML = allOwners.map(o => `<option value="${o}">${o}</option>`).join('');
        }
    }

    function getOwnerAvatarHtml(ownerName, size) {
        const teamMembers = teamMemberData || [];
        const member = teamMembers.find(m => m.name === ownerName);
        if (member && member.avatar) {
            return `<img src="${member.avatar}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;" />`;
        }
        return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:${size * 0.4}px;display:flex;align-items:center;justify-content:center;">${ownerName.charAt(0)}</div>`;
    }

    function updateTaskStats() {
        const today = new Date().toDateString();
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        
        const pending = taskData.filter(t => t.status === 'pending' || t.status === 'progress').length;
        const todayDue = taskData.filter(t => {
            const deadline = new Date(t.deadline);
            return deadline.toDateString() === today && t.status !== 'completed';
        }).length;
        const overdue = taskData.filter(t => {
            const deadline = new Date(t.deadline);
            return deadline < new Date() && t.status !== 'completed';
        }).length;
        const weekCompleted = taskData.filter(t => {
            if (t.status !== 'completed') return false;
            const completedTime = new Date(t.completedTime || t.deadline);
            return completedTime >= weekStart;
        }).length;

        if (document.getElementById('statPending')) document.getElementById('statPending').textContent = pending;
        if (document.getElementById('statTodayDue')) document.getElementById('statTodayDue').textContent = todayDue;
        if (document.getElementById('statOverdue')) document.getElementById('statOverdue').textContent = overdue;
        if (document.getElementById('statWeekCompleted')) document.getElementById('statWeekCompleted').textContent = weekCompleted;
    }

    function getFilteredTasks() {
        let filtered = [...taskData];
        
        const search = document.getElementById('taskSearchInput')?.value?.toLowerCase() || '';
        const priority = document.getElementById('taskPriorityFilter')?.value || '';
        const status = document.getElementById('taskStatusFilter')?.value || '';
        const owner = document.getElementById('taskOwnerFilter')?.value || '';

        if (search) {
            filtered = filtered.filter(t => t.title.toLowerCase().includes(search));
        }
        if (priority) {
            filtered = filtered.filter(t => t.priority === priority);
        }
        if (status) {
            filtered = filtered.filter(t => t.status === status);
        }
        if (owner) {
            filtered = filtered.filter(t => t.owner === owner);
        }

        filtered.sort((a, b) => {
            const deadlineA = new Date(a.deadline);
            const deadlineB = new Date(b.deadline);
            
            const isOverdueA = deadlineA < new Date() && a.status !== 'completed';
            const isOverdueB = deadlineB < new Date() && b.status !== 'completed';
            
            if (isOverdueA && !isOverdueB) return -1;
            if (!isOverdueA && isOverdueB) return 1;
            
            const priorityOrder = { high: 0, medium: 1, low: 2 };
            if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
                return priorityOrder[a.priority] - priorityOrder[b.priority];
            }
            
            return deadlineA - deadlineB;
        });

        return filtered;
    }

    function renderTaskList() {
        const container = document.getElementById('taskList');
        const emptyState = document.getElementById('taskEmptyState');
        const batchToolbar = document.getElementById('taskBatchToolbar');
        
        if (!container || !emptyState) return;

        const filtered = getFilteredTasks();
        
        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            batchToolbar.style.display = 'none';
            renderTaskPagination([]);
            return;
        }

        emptyState.style.display = 'none';
        
        const start = (taskPage - 1) * TASK_PAGE_SIZE;
        const end = start + TASK_PAGE_SIZE;
        const pageData = filtered.slice(start, end);

        container.innerHTML = '';
        
        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display: grid; grid-template-columns: 40px 1fr 80px 100px 140px 80px 140px; gap: 16px; padding: 12px 16px; background: #f8f9fa; border-radius: 8px 8px 0 0; font-weight: 600; font-size: 13px; color: #666;';
        headerRow.innerHTML = `
            <label style="display:flex;align-items:center;"><input type="checkbox" id="taskSelectAll" onchange="toggleSelectAllTasks()">全选</label>
            <div>任务标题</div>
            <div>优先级</div>
            <div>负责人</div>
            <div>截止时间</div>
            <div>状态</div>
            <div style="text-align:right;">操作</div>
        `;
        container.appendChild(headerRow);

        pageData.forEach(task => {
            const isOverdue = new Date(task.deadline) < new Date() && task.status !== 'completed';
            const priority = PRIORITY_CONFIG[task.priority];
            const status = STATUS_CONFIG[task.status];
            
            const row = document.createElement('div');
            row.style.cssText = `display: grid; grid-template-columns: 40px 1fr 80px 100px 140px 80px 140px; gap: 16px; padding: 16px; background: #fff; border-bottom: 1px solid #f0f0f0; align-items: center; transition: background 0.2s;${isOverdue ? ' border-left: 3px solid #ff4d4f;' : ''}`;
            
            row.onmouseenter = () => { row.style.background = '#f9fafc'; };
            row.onmouseleave = () => { row.style.background = '#fff'; };

            const timeDisplay = formatTaskTime(task.deadline);
            
            row.innerHTML = `
                <input type="checkbox" class="task-checkbox" value="${task.id}" onchange="toggleTaskSelection(${task.id})" ${selectedTaskIds.has(task.id) ? 'checked' : ''}>
                <div style="min-width:0;">
                    <div style="font-weight:bold;color:#333;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;" onclick="showTaskDetail(${task.id})">${task.title}</div>
                    ${isOverdue ? '<div style="font-size:12px;color:#ff4d4f;margin-top:4px;">⚠️ 已逾期</div>' : ''}
                </div>
                <div><span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold;color:${priority.color};background:${priority.bgColor};border:1px solid ${priority.borderColor};">${priority.label}</span></div>
                <div style="display:flex;align-items:center;gap:6px;">
                    ${getOwnerAvatarHtml(task.owner, 28)}
                    <span style="font-size:13px;color:#666;">${task.owner}</span>
                </div>
                <div style="font-size:13px;color:${isOverdue ? '#ff4d4f' : '#666'};">${timeDisplay}</div>
                <div><span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;color:${status.color};background:${status.bgColor};border:1px solid ${status.borderColor};">${status.label}</span></div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button onclick="showTaskDetail(${task.id})" style="padding:4px 8px;border:none;background:#f5f5f5;border-radius:4px;cursor:pointer;font-size:12px;color:#666;">查看</button>
                    <button onclick="editTask(${task.id})" style="padding:4px 8px;border:none;background:#f5f5f5;border-radius:4px;cursor:pointer;font-size:12px;color:#666;">编辑</button>
                    ${task.status !== 'completed' ? `<button onclick="completeTask(${task.id})" style="padding:4px 8px;border:none;background:#f6ffed;border-radius:4px;cursor:pointer;font-size:12px;color:#52c41a;">完成</button>` : ''}
                    <button onclick="deleteTask(${task.id})" style="padding:4px 8px;border:none;background:#fff1f0;border-radius:4px;cursor:pointer;font-size:12px;color:#ff4d4f;">删除</button>
                </div>
            `;
            container.appendChild(row);
        });

        updateBatchToolbar();
        renderTaskPagination(filtered);
        updateTaskStats();
    }

    function formatTaskTime(deadlineStr) {
        const deadline = new Date(deadlineStr);
        const now = new Date();
        const diff = deadline - now;
        
        if (diff < 0) {
            const hours = Math.floor(Math.abs(diff) / (1000 * 60 * 60));
            if (hours < 24) return `已逾期 ${hours}小时`;
            const days = Math.floor(hours / 24);
            return `已逾期 ${days}天`;
        }
        
        if (diff < 24 * 60 * 60 * 1000) {
            const hours = Math.floor(diff / (1000 * 60 * 60));
            return `还有 ${hours}小时`;
        }
        
        return deadlineStr;
    }

    function renderTaskPagination(filtered) {
        const pagination = document.getElementById('taskPagination');
        if (!pagination) return;

        const totalPages = Math.ceil(filtered.length / TASK_PAGE_SIZE);
        
        if (totalPages <= 1) {
            pagination.innerHTML = `<span style="font-size:13px;color:#666;">共 ${filtered.length} 条</span>`;
            return;
        }

        let html = `<span style="font-size:13px;color:#666;">共 ${filtered.length} 条</span>`;
        
        if (taskPage > 1) {
            html += `<button onclick="setTaskPage(${taskPage - 1})" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">上一页</button>`;
        }
        
        for (let i = 1; i <= totalPages; i++) {
            if (i === taskPage) {
                html += `<button style="padding:4px 12px;border:none;background:#667eea;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;">${i}</button>`;
            } else {
                html += `<button onclick="setTaskPage(${i})" style="padding:4px 12px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">${i}</button>`;
            }
        }
        
        if (taskPage < totalPages) {
            html += `<button onclick="setTaskPage(${taskPage + 1})" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">下一页</button>`;
        }
        
        pagination.innerHTML = html;
    }

    function setTaskPage(page) {
        taskPage = page;
        renderTaskList();
    }

    function setTaskStatusFilter(status) {
        const select = document.getElementById('taskStatusFilter');
        const buttons = document.querySelectorAll('.task-status-btn');
        
        if (select) select.value = status;
        buttons.forEach(btn => btn.classList.remove('active'));
        buttons.forEach(btn => {
            if ((status === '' && btn.textContent === '全部') ||
                (status === 'pending' && btn.textContent === '待处理') ||
                (status === 'progress' && btn.textContent === '进行中') ||
                (status === 'completed' && btn.textContent === '已完成') ||
                (status === 'overdue' && btn.textContent === '已逾期')) {
                btn.classList.add('active');
            }
        });
        
        taskPage = 1;
        renderTaskList();
    }

    function toggleSelectAllTasks() {
        const checkbox = document.getElementById('taskSelectAll');
        const checkboxes = document.querySelectorAll('.task-checkbox');
        
        if (checkbox.checked) {
            checkboxes.forEach(cb => {
                cb.checked = true;
                selectedTaskIds.add(parseInt(cb.value));
            });
        } else {
            checkboxes.forEach(cb => {
                cb.checked = false;
                selectedTaskIds.delete(parseInt(cb.value));
            });
        }
        
        updateBatchToolbar();
    }

    function toggleTaskSelection(id) {
        const checkbox = document.querySelector(`.task-checkbox[value="${id}"]`);
        if (checkbox.checked) {
            selectedTaskIds.add(id);
        } else {
            selectedTaskIds.delete(id);
        }
        
        const selectAll = document.getElementById('taskSelectAll');
        const allCheckboxes = document.querySelectorAll('.task-checkbox');
        selectAll.checked = allCheckboxes.length > 0 && Array.from(allCheckboxes).every(cb => cb.checked);
        
        updateBatchToolbar();
    }

    function updateBatchToolbar() {
        const toolbar = document.getElementById('taskBatchToolbar');
        const count = document.getElementById('selectedTaskCount');
        
        if (selectedTaskIds.size > 0) {
            toolbar.style.display = 'flex';
            count.textContent = selectedTaskIds.size;
        } else {
            toolbar.style.display = 'none';
        }
    }

    function clearTaskSelection() {
        selectedTaskIds.clear();
        document.getElementById('taskSelectAll').checked = false;
        document.querySelectorAll('.task-checkbox').forEach(cb => cb.checked = false);
        updateBatchToolbar();
    }

    function batchCompleteTasks() {
        if (selectedTaskIds.size === 0) return;
        
        taskData = taskData.map(t => {
            if (selectedTaskIds.has(t.id)) {
                return { ...t, status: 'completed', completedTime: new Date().toISOString() };
            }
            return t;
        });
        
        saveTaskData();
        clearTaskSelection();
        renderTaskList();
        alert(`已完成 ${selectedTaskIds.size} 个任务`);
    }

    function batchDeleteTasks() {
        if (selectedTaskIds.size === 0) return;
        
        if (!confirm(`确定要删除选中的 ${selectedTaskIds.size} 个任务吗？`)) return;
        
        taskData = taskData.filter(t => !selectedTaskIds.has(t.id));
        saveTaskData();
        clearTaskSelection();
        renderTaskList();
        alert(`已删除 ${selectedTaskIds.size} 个任务`);
    }

    function showAddTaskModal() {
        editingTaskId = null;
        document.getElementById('taskModalTitle').textContent = '新增任务';
        document.getElementById('taskTitle').value = '';
        document.getElementById('taskPriority').value = 'medium';
        document.getElementById('taskOwner').value = '';
        document.getElementById('taskDeadline').value = '';
        document.getElementById('taskStatus').value = 'pending';
        document.getElementById('taskDescription').value = '';
        document.getElementById('taskModal').style.display = 'flex';
    }

    function editTask(id) {
        const task = taskData.find(t => t.id === id);
        if (!task) return;
        
        editingTaskId = id;
        document.getElementById('taskModalTitle').textContent = '编辑任务';
        document.getElementById('taskTitle').value = task.title;
        document.getElementById('taskPriority').value = task.priority;
        document.getElementById('taskOwner').value = task.owner;
        document.getElementById('taskDeadline').value = task.deadline.replace(' ', 'T');
        document.getElementById('taskStatus').value = task.status;
        document.getElementById('taskDescription').value = task.description || '';
        document.getElementById('taskModal').style.display = 'flex';
    }

    function closeTaskModal() {
        document.getElementById('taskModal').style.display = 'none';
    }

    function saveTask() {
        const title = document.getElementById('taskTitle').value.trim();
        const priority = document.getElementById('taskPriority').value;
        const owner = document.getElementById('taskOwner').value;
        const deadline = document.getElementById('taskDeadline').value;
        const status = document.getElementById('taskStatus').value;
        const description = document.getElementById('taskDescription').value.trim();

        if (!title || !owner || !deadline) {
            alert('请填写任务标题、负责人和截止时间');
            return;
        }

        const deadlineStr = deadline.replace('T', ' ');

        if (editingTaskId) {
            const idx = taskData.findIndex(t => t.id === editingTaskId);
            if (idx !== -1) {
                taskData[idx] = { ...taskData[idx], title, priority, owner, deadline: deadlineStr, status, description };
            }
        } else {
            const newId = taskData.length > 0 ? Math.max(...taskData.map(t => t.id)) + 1 : 1;
            taskData.push({ id: newId, title, priority, owner, deadline: deadlineStr, status, description, completedTime: null });
        }

        saveTaskData();
        closeTaskModal();
        populateOwnerSelects();
        renderTaskList();
        alert('保存成功！该任务已同步到云端，所有成员都可以看见。');
    }

    function showTaskDetail(id) {
        const task = taskData.find(t => t.id === id);
        if (!task) return;
        
        const priority = PRIORITY_CONFIG[task.priority];
        const status = STATUS_CONFIG[task.status];
        
        document.getElementById('taskDetailContent').innerHTML = `
            <div style="margin-bottom: 24px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                    <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:bold;color:${priority.color};background:${priority.bgColor};border:1px solid ${priority.borderColor};">${priority.label}优先级</span>
                    <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;color:${status.color};background:${status.bgColor};border:1px solid ${status.borderColor};">${status.label}</span>
                </div>
                <h2 style="font-size: 20px; font-weight: bold; color: #333; margin: 0;">${task.title}</h2>
            </div>
            
            <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                <h4 style="margin: 0 0 12px; color: #333; font-size: 14px;">任务描述</h4>
                <p style="margin: 0; color: #666; line-height: 1.8; font-size: 14px;">${task.description || '暂无描述'}</p>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                    <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">负责人</h4>
                    <div style="display:flex;align-items:center;gap:8px;">
                        ${getOwnerAvatarHtml(task.owner, 36)}
                        <span style="font-size:14px;color:#333;">${task.owner}</span>
                    </div>
                </div>
                <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                    <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">截止时间</h4>
                    <p style="margin: 0; color: ${new Date(task.deadline) < new Date() && task.status !== 'completed' ? '#ff4d4f' : '#666'}; font-size: 14px;">${task.deadline}</p>
                </div>
            </div>
            
            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px;">
                <button class="btn btn-secondary" onclick="closeTaskDetailDrawer()">关闭</button>
                <button class="btn" onclick="editTask(${task.id}); closeTaskDetailDrawer();">编辑</button>
                ${task.status !== 'completed' ? `<button class="btn" style="background:#52c41a;" onclick="completeTask(${task.id}); closeTaskDetailDrawer();">标记完成</button>` : ''}
            </div>
        `;
        
        document.getElementById('taskDetailDrawer').style.display = 'block';
        document.getElementById('taskDetailOverlay').style.display = 'block';
    }

    function closeTaskDetailDrawer() {
        document.getElementById('taskDetailDrawer').style.display = 'none';
        document.getElementById('taskDetailOverlay').style.display = 'none';
    }

    function completeTask(id) {
        const task = taskData.find(t => t.id === id);
        if (!task) return;
        
        task.status = 'completed';
        task.completedTime = new Date().toISOString();
        saveTaskData();
        renderTaskList();
        alert('任务已标记为完成！');
    }

    function deleteTask(id) {
        if (!confirm('确定要删除该任务吗？')) return;
        
        const task = taskData.find(t => t.id === id);
        taskData = taskData.filter(t => t.id !== id);
        saveTaskData();
        renderTaskList();
        if (task) {
            recordOperationLog('任务待办', '删除', `删除任务：${task.title}`, { taskId: id, taskTitle: task.title }, { success: true }, 1, '', 0);
        }
        alert('任务已删除！');
    }

    // ===== 周报管理模块 =====
    let weeklyReportData = [];
    let editingWeeklyReportId = null;
    let weeklyReportPage = 1;
    const WR_PAGE_SIZE = 8;

    const WR_STATUS_CONFIG = {
        pending: { label: '待审核', color: '#d97706', bgColor: '#fffbeb', borderColor: '#fde68a' },
        approved: { label: '已通过', color: '#16a34a', bgColor: '#f0fdf4', borderColor: '#bbf7d0' },
        rejected: { label: '已驳回', color: '#dc2626', bgColor: '#fef2f2', borderColor: '#fecaca' }
    };

    function canReviewWeeklyReport() {
        return !!(currentUser && (currentUser.role === 'admin' || currentUser.role === 'leader' || (typeof hasPermission === 'function' && hasPermission('团队工作周报（审核）'))));
    }

    function canSubmitWeeklyReport() {
        return !!(currentUser && (typeof hasPermission !== 'function' || hasPermission('团队工作周报（提交自己的）') || hasPermission('团队工作周报（查看全部）') || currentUser.role === 'admin' || currentUser.role === 'leader' || currentUser.role === 'student'));
    }

    function isMyWeeklyReport(report) {
        if (!currentUser || !report) return false;
        const myName = currentUser.realName || currentUser.username || '';
        return report.owner === myName;
    }

    function initWeeklyReport() {
        loadWeeklyReportData();
        populateWeeklyReportOwnerSelects();
        updateWeeklyReportHeader();
        updateWeeklyReportStats();
        renderWeeklyReportList();
        const submitBtn = document.getElementById('wrSubmitBtn');
        if (submitBtn) submitBtn.style.display = canSubmitWeeklyReport() ? '' : 'none';
    }

    function loadWeeklyReportData() {
        const stored = localStorage.getItem('weeklyReportData');
        if (stored) {
            weeklyReportData = JSON.parse(stored);
            migrateWeeklyReportDataToRealTeam();
        } else {
            weeklyReportData = buildRealTeamDefaultWeeklyReports();
            saveWeeklyReportData();
        }
    }

    function getCurrentWeekRangeText() {
        const range = getWeekRangeByOffset(0);
        return range.start + ' 至 ' + range.end;
    }

    function formatDateYMD(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    /** offsetWeeks: 0=本周, -1=上周 */
    function getWeekRangeByOffset(offsetWeeks) {
        const now = new Date();
        const day = now.getDay() || 7;
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1 + (offsetWeeks || 0) * 7);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        return { start: formatDateYMD(start), end: formatDateYMD(end) };
    }

    function parseWeekRangeText(text) {
        const raw = String(text || '').trim();
        const m = raw.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|-|~)\s*(\d{4}-\d{2}-\d{2})/);
        if (m) return { start: m[1], end: m[2] };
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { start: raw, end: raw };
        return getWeekRangeByOffset(0);
    }

    function setWeeklyReportPeriodInputs(start, end) {
        const s = document.getElementById('wrWeekStart');
        const e = document.getElementById('wrWeekEnd');
        if (s) s.value = start || '';
        if (e) e.value = end || '';
    }

    function getWeeklyReportPeriodFromInputs() {
        const start = (document.getElementById('wrWeekStart') || {}).value || '';
        const end = (document.getElementById('wrWeekEnd') || {}).value || '';
        if (!start || !end) return '';
        if (start > end) return '';
        return start + ' 至 ' + end;
    }

    function setWeeklyReportPeriodPreset(which) {
        const range = getWeekRangeByOffset(which === 'last' ? -1 : 0);
        setWeeklyReportPeriodInputs(range.start, range.end);
    }

    function buildRealTeamDefaultWeeklyReports() {
        const owners = getRealTeamOwnerNames();
        const pick = idx => owners[idx % Math.max(owners.length, 1)] || (currentUser && currentUser.realName) || '团队成员';
        const weekRange = getCurrentWeekRangeText();
        return [
            { id: 1, weekRange, owner: pick(0), content: '1. 核对个人档案和账号信息\n2. 整理本周研究进展\n3. 上传相关资料到资源中心', nextWeek: '1. 继续推进课题任务\n2. 根据组会意见完善材料', problems: '暂无', notes: '', status: 'pending', submitTime: new Date().toLocaleString('zh-CN'), reviewComment: '', visibility: 'all' },
            { id: 2, weekRange, owner: pick(1), content: '1. 整理城市安全相关文献\n2. 更新项目/成果台账\n3. 准备组会汇报材料', nextWeek: '1. 完成文献摘要\n2. 补充实验或数据说明', problems: '部分资料需要进一步核对', notes: '', status: 'approved', submitTime: new Date().toLocaleString('zh-CN'), reviewComment: '已同步归档', visibility: 'all' }
        ];
    }

    function migrateWeeklyReportDataToRealTeam() {
        const validNames = new Set(getRealTeamOwnerNames());
        const demoOwners = ['张三', '李四', '王五', '赵六'];
        if (Array.isArray(weeklyReportData) && weeklyReportData.some(r => demoOwners.includes(r.owner))) {
            weeklyReportData = buildRealTeamDefaultWeeklyReports();
            saveWeeklyReportData();
            return;
        }
        let changed = false;
        weeklyReportData = (weeklyReportData || []).map(function(r) {
            const owner = validNames.has(r.owner) ? r.owner : replaceUnknownOwnerWithTeamMember(r.owner);
            const next = { ...r, owner, visibility: 'all' };
            if (owner !== r.owner || r.visibility !== 'all') changed = true;
            return next;
        });
        if (changed) saveWeeklyReportData();
    }

    function saveWeeklyReportData() {
        weeklyReportData = (weeklyReportData || []).map(r => ({ ...r, visibility: 'all' }));
        localStorage.setItem('weeklyReportData', JSON.stringify(weeklyReportData));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('weeklyReportData', JSON.stringify(weeklyReportData)); } catch (e) {}
    }

    function populateWeeklyReportOwnerSelects() {
        const allOwners = getRealTeamOwnerNames();
        const filterSelect = document.getElementById('weeklyReportOwnerFilter');
        if (filterSelect) {
            const current = filterSelect.value;
            filterSelect.innerHTML = '<option value="">全部成员</option>' + allOwners.map(o => `<option value="${o}">${o}</option>`).join('');
            if (current && allOwners.includes(current)) filterSelect.value = current;
        }
    }

    function updateWeeklyReportHeader() {
        const badge = document.getElementById('wrCurrentWeekBadge');
        const weekRange = getCurrentWeekRangeText();
        if (badge) badge.textContent = '本周：' + weekRange;

        const tip = document.getElementById('wrMissingTip');
        if (!tip) return;
        if (!canReviewWeeklyReport()) {
            tip.style.display = 'none';
            return;
        }
        const members = getRealTeamOwnerNames().filter(n => {
            const m = (teamMemberData || []).find(x => x.name === n);
            return !m || m.category !== 'advisor';
        });
        const submitted = new Set(weeklyReportData.filter(r => r.weekRange === weekRange).map(r => r.owner));
        const missing = members.filter(n => !submitted.has(n));
        if (missing.length === 0) {
            tip.style.display = 'none';
            tip.textContent = '';
            return;
        }
        tip.style.display = 'block';
        tip.textContent = '本周尚未提交：' + missing.slice(0, 8).join('、') + (missing.length > 8 ? ` 等 ${missing.length} 人` : '');
    }

    function updateWeeklyReportStats() {
        const weekRange = getCurrentWeekRangeText();
        const pending = weeklyReportData.filter(r => r.status === 'pending').length;
        const approved = weeklyReportData.filter(r => r.status === 'approved').length;
        const rejected = weeklyReportData.filter(r => r.status === 'rejected').length;
        const submittedThisWeek = weeklyReportData.filter(r => r.weekRange === weekRange).length;
        const studentCount = getRealTeamOwnerNames().filter(n => {
            const m = (teamMemberData || []).find(x => x.name === n);
            return !m || m.category !== 'advisor';
        }).length || getRealTeamOwnerNames().length;

        if (document.getElementById('wrStatPending')) document.getElementById('wrStatPending').textContent = pending;
        if (document.getElementById('wrStatApproved')) document.getElementById('wrStatApproved').textContent = approved;
        if (document.getElementById('wrStatRejected')) document.getElementById('wrStatRejected').textContent = rejected;
        if (document.getElementById('wrStatSubmitted')) document.getElementById('wrStatSubmitted').textContent = submittedThisWeek;
        if (document.getElementById('wrStatSubmittedHint')) document.getElementById('wrStatSubmittedHint').textContent = '/ ' + studentCount;
        updateWeeklyReportHeader();
    }

    function setWeeklyReportStatusFilter(status) {
        const select = document.getElementById('weeklyReportStatusFilter');
        if (select) select.value = status || '';
        weeklyReportPage = 1;
        renderWeeklyReportList();
    }

    function filterWeeklyReportByMine() {
        if (!currentUser) return;
        const ownerSelect = document.getElementById('weeklyReportOwnerFilter');
        const myName = currentUser.realName || currentUser.username || '';
        if (ownerSelect) ownerSelect.value = myName;
        weeklyReportPage = 1;
        renderWeeklyReportList();
    }

    function getFilteredWeeklyReports() {
        let filtered = [...weeklyReportData];
        const search = document.getElementById('weeklyReportSearchInput')?.value?.toLowerCase() || '';
        const status = document.getElementById('weeklyReportStatusFilter')?.value || '';
        const owner = document.getElementById('weeklyReportOwnerFilter')?.value || '';

        if (search) {
            filtered = filtered.filter(r =>
                (r.content || '').toLowerCase().includes(search) ||
                (r.nextWeek || '').toLowerCase().includes(search) ||
                (r.problems || '').toLowerCase().includes(search) ||
                (r.owner || '').toLowerCase().includes(search) ||
                (r.weekRange || '').toLowerCase().includes(search)
            );
        }
        if (status) filtered = filtered.filter(r => r.status === status);
        if (owner) filtered = filtered.filter(r => r.owner === owner);
        filtered.sort((a, b) => new Date(b.submitTime) - new Date(a.submitTime));
        return filtered;
    }

    function renderWeeklyReportList() {
        const container = document.getElementById('weeklyReportList');
        const emptyState = document.getElementById('weeklyReportEmptyState');
        if (!container || !emptyState) return;

        const filtered = getFilteredWeeklyReports();
        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            renderWeeklyReportPagination([]);
            updateWeeklyReportStats();
            return;
        }

        emptyState.style.display = 'none';
        const start = (weeklyReportPage - 1) * WR_PAGE_SIZE;
        const pageData = filtered.slice(start, start + WR_PAGE_SIZE);
        const canReview = canReviewWeeklyReport();
        container.innerHTML = '';

        pageData.forEach(report => {
            const status = WR_STATUS_CONFIG[report.status] || WR_STATUS_CONFIG.pending;
            const preview = (report.content || '').replace(/\n/g, ' ');
            const shortPreview = preview.length > 90 ? preview.slice(0, 90) + '…' : preview;
            const mine = isMyWeeklyReport(report);
            const canEdit = mine && report.status !== 'approved';

            const card = document.createElement('div');
            card.style.cssText = 'background:#fff;border:1px solid #eef0f5;border-radius:14px;padding:16px 18px;margin-bottom:12px;transition:box-shadow .15s, transform .15s;';
            card.onmouseenter = function() { this.style.boxShadow = '0 10px 24px rgba(15,23,42,.06)'; this.style.transform = 'translateY(-1px)'; };
            card.onmouseleave = function() { this.style.boxShadow = 'none'; this.style.transform = ''; };
            card.innerHTML = `
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
                    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                        ${getOwnerAvatarHtml(report.owner, 36)}
                        <div style="min-width:0;">
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                <strong style="color:#111827;font-size:15px;">${escHtml(report.owner || '')}</strong>
                                ${mine ? '<span style="font-size:11px;padding:2px 8px;border-radius:999px;background:#eef2ff;color:#4f46e5;">我的</span>' : ''}
                                <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;color:${status.color};background:${status.bgColor};border:1px solid ${status.borderColor};">${status.label}</span>
                            </div>
                            <div style="font-size:12px;color:#6b7280;margin-top:4px;">${escHtml(report.weekRange || '')} · ${escHtml(report.submitTime || '')}</div>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <button onclick="showWeeklyReportDetail(${report.id})" style="padding:6px 12px;border:1px solid #e5e7eb;background:#fff;border-radius:8px;cursor:pointer;font-size:12px;color:#374151;">查看</button>
                        ${canEdit ? `<button onclick="editWeeklyReport(${report.id})" style="padding:6px 12px;border:none;background:#eef2ff;border-radius:8px;cursor:pointer;font-size:12px;color:#4f46e5;">编辑</button>` : ''}
                        ${canReview && report.status === 'pending' ? `<button onclick="approveWeeklyReport(${report.id})" style="padding:6px 12px;border:none;background:#f0fdf4;border-radius:8px;cursor:pointer;font-size:12px;color:#16a34a;">通过</button>` : ''}
                        ${canReview && report.status === 'pending' ? `<button onclick="rejectWeeklyReport(${report.id})" style="padding:6px 12px;border:none;background:#fef2f2;border-radius:8px;cursor:pointer;font-size:12px;color:#dc2626;">驳回</button>` : ''}
                    </div>
                </div>
                <div onclick="showWeeklyReportDetail(${report.id})" style="margin-top:12px;font-size:14px;color:#374151;line-height:1.7;cursor:pointer;">${escHtml(shortPreview)}</div>
            `;
            container.appendChild(card);
        });

        renderWeeklyReportPagination(filtered);
        updateWeeklyReportStats();
    }

    function renderWeeklyReportPagination(filtered) {
        const pagination = document.getElementById('weeklyReportPagination');
        if (!pagination) return;
        const totalPages = Math.ceil(filtered.length / WR_PAGE_SIZE) || 1;
        if (totalPages <= 1) {
            pagination.innerHTML = `<span style="font-size:13px;color:#6b7280;">共 ${filtered.length} 条</span>`;
            return;
        }
        let html = `<span style="font-size:13px;color:#6b7280;">共 ${filtered.length} 条</span>`;
        if (weeklyReportPage > 1) html += `<button onclick="setWeeklyReportPage(${weeklyReportPage - 1})" style="padding:4px 10px;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:13px;background:#fff;">上一页</button>`;
        for (let i = 1; i <= totalPages; i++) {
            if (i === weeklyReportPage) html += `<button style="padding:4px 12px;border:none;background:#4f46e5;color:#fff;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">${i}</button>`;
            else html += `<button onclick="setWeeklyReportPage(${i})" style="padding:4px 12px;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:13px;background:#fff;">${i}</button>`;
        }
        if (weeklyReportPage < totalPages) html += `<button onclick="setWeeklyReportPage(${weeklyReportPage + 1})" style="padding:4px 10px;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:13px;background:#fff;">下一页</button>`;
        pagination.innerHTML = html;
    }

    function setWeeklyReportPage(page) {
        weeklyReportPage = page;
        renderWeeklyReportList();
    }

    function showAddWeeklyReportModal() {
        if (!canSubmitWeeklyReport()) {
            alert('当前账号无周报提交权限');
            return;
        }
        const weekRange = getCurrentWeekRangeText();
        const myName = currentUser ? (currentUser.realName || currentUser.username) : '';
        const existing = weeklyReportData.find(r => r.owner === myName && r.weekRange === weekRange);
        if (existing) {
            editWeeklyReport(existing.id);
            return;
        }
        editingWeeklyReportId = null;
        document.getElementById('weeklyReportModalTitle').textContent = '提交本周周报';
        const hint = document.getElementById('wrModalHint');
        if (hint) hint.textContent = '可自行选择周期，提交后全员可见并同步云端';
        const range = parseWeekRangeText(weekRange);
        setWeeklyReportPeriodInputs(range.start, range.end);
        document.getElementById('wrContent').value = '';
        document.getElementById('wrNextWeek').value = '';
        document.getElementById('wrProblems').value = '';
        document.getElementById('wrNotes').value = '';
        document.getElementById('weeklyReportModal').style.display = 'flex';
    }

    function editWeeklyReport(id) {
        const report = weeklyReportData.find(r => r.id === id);
        if (!report) return;
        if (!isMyWeeklyReport(report) && !(currentUser && currentUser.role === 'admin')) {
            alert('只能编辑自己的周报');
            return;
        }
        if (report.status === 'approved' && !(currentUser && currentUser.role === 'admin')) {
            alert('已通过的周报不可再编辑');
            return;
        }
        editingWeeklyReportId = id;
        document.getElementById('weeklyReportModalTitle').textContent = '编辑周报';
        const hint = document.getElementById('wrModalHint');
        if (hint) hint.textContent = report.status === 'rejected' ? '驳回后可修改并重新提交审核' : '可调整周期，保存后将重新进入待审核';
        const range = parseWeekRangeText(report.weekRange || getCurrentWeekRangeText());
        setWeeklyReportPeriodInputs(range.start, range.end);
        document.getElementById('wrContent').value = report.content || '';
        document.getElementById('wrNextWeek').value = report.nextWeek || '';
        document.getElementById('wrProblems').value = report.problems || '';
        document.getElementById('wrNotes').value = report.notes || '';
        document.getElementById('weeklyReportModal').style.display = 'flex';
    }

    function closeWeeklyReportModal() {
        document.getElementById('weeklyReportModal').style.display = 'none';
    }

    function saveWeeklyReport() {
        const weekRange = getWeeklyReportPeriodFromInputs();
        const content = document.getElementById('wrContent').value.trim();
        const nextWeek = document.getElementById('wrNextWeek').value.trim();
        const problems = document.getElementById('wrProblems').value.trim();
        const notes = document.getElementById('wrNotes').value.trim();

        if (!weekRange || !content) {
            alert(!weekRange ? '请选择有效的周报起止日期（开始日期不能晚于结束日期）' : '请填写本周工作内容');
            return;
        }

        const submitter = currentUser ? currentUser.realName || currentUser.username : '未知用户';

        if (editingWeeklyReportId) {
            const idx = weeklyReportData.findIndex(r => r.id === editingWeeklyReportId);
            if (idx !== -1) {
                weeklyReportData[idx] = {
                    ...weeklyReportData[idx],
                    weekRange, content, nextWeek, problems, notes,
                    status: 'pending',
                    reviewComment: '',
                    submitTime: new Date().toLocaleString('zh-CN'),
                    visibility: 'all'
                };
            }
        } else {
            const dup = weeklyReportData.find(r => r.owner === submitter && r.weekRange === weekRange);
            if (dup) {
                alert('本周已提交过周报，已为你打开编辑');
                editWeeklyReport(dup.id);
                return;
            }
            const newId = weeklyReportData.length > 0 ? Math.max(...weeklyReportData.map(r => r.id)) + 1 : 1;
            weeklyReportData.push({
                id: newId,
                weekRange,
                owner: submitter,
                content,
                nextWeek,
                problems,
                notes,
                status: 'pending',
                submitTime: new Date().toLocaleString('zh-CN'),
                reviewComment: '',
                visibility: 'all'
            });
        }

        saveWeeklyReportData();
        closeWeeklyReportModal();
        populateWeeklyReportOwnerSelects();
        renderWeeklyReportList();
        if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner('周报已保存并同步，全员可见', false);
        else alert('提交成功！周报已同步，全员可见。');
    }

    function showWeeklyReportDetail(id) {
        const report = weeklyReportData.find(r => r.id === id);
        if (!report) return;
        const status = WR_STATUS_CONFIG[report.status] || WR_STATUS_CONFIG.pending;
        const canReview = canReviewWeeklyReport() && report.status === 'pending';
        const canEdit = isMyWeeklyReport(report) && report.status !== 'approved';

        document.getElementById('weeklyReportDetailContent').innerHTML = `
            <div style="margin-bottom: 20px;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap:wrap;">
                    <span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;color:${status.color};background:${status.bgColor};border:1px solid ${status.borderColor};">${status.label}</span>
                    <span style="font-size:12px;color:#6b7280;">${escHtml(report.submitTime || '')}</span>
                </div>
                <h2 style="font-size: 18px; font-weight: 700; color: #111827; margin: 0;">${escHtml(report.weekRange || '')}</h2>
            </div>

            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 18px; padding:12px; background:#f8fafc; border-radius:12px;">
                ${getOwnerAvatarHtml(report.owner, 42)}
                <div>
                    <div style="font-weight: 700; color: #111827;">${escHtml(report.owner || '')}</div>
                    <div style="font-size: 12px; color: #6b7280;">提交人 · 全员可见</div>
                </div>
            </div>

            <div style="background: #f8fafc; padding: 16px; border-radius: 12px; margin-bottom: 12px; border:1px solid #eef2f7;">
                <h4 style="margin: 0 0 10px; color: #111827; font-size: 14px;">本周工作内容</h4>
                <p style="margin: 0; color: #374151; line-height: 1.8; font-size: 14px; white-space: pre-wrap;">${escHtml(report.content || '')}</p>
            </div>
            <div style="background: #f8fafc; padding: 16px; border-radius: 12px; margin-bottom: 12px; border:1px solid #eef2f7;">
                <h4 style="margin: 0 0 10px; color: #111827; font-size: 14px;">下周工作计划</h4>
                <p style="margin: 0; color: #374151; line-height: 1.8; font-size: 14px; white-space: pre-wrap;">${escHtml(report.nextWeek || '暂无')}</p>
            </div>
            <div style="background: #f8fafc; padding: 16px; border-radius: 12px; margin-bottom: 12px; border:1px solid #eef2f7;">
                <h4 style="margin: 0 0 10px; color: #111827; font-size: 14px;">遇到的问题与困难</h4>
                <p style="margin: 0; color: #374151; line-height: 1.8; font-size: 14px; white-space: pre-wrap;">${escHtml(report.problems || '暂无')}</p>
            </div>
            ${report.notes ? `<div style="background:#f8fafc;padding:16px;border-radius:12px;margin-bottom:12px;border:1px solid #eef2f7;"><h4 style="margin:0 0 10px;color:#111827;font-size:14px;">备注</h4><p style="margin:0;color:#374151;line-height:1.8;font-size:14px;white-space:pre-wrap;">${escHtml(report.notes)}</p></div>` : ''}
            ${report.reviewComment ? `<div style="background:#fffbeb;padding:16px;border-radius:12px;margin-bottom:12px;border:1px solid #fde68a;"><h4 style="margin:0 0 10px;color:#92400e;font-size:14px;">审核意见</h4><p style="margin:0;color:#b45309;line-height:1.8;font-size:14px;">${escHtml(report.reviewComment)}</p></div>` : ''}

            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; flex-wrap:wrap; position:sticky; bottom:0; background:#fff; padding-top:12px; border-top:1px solid #f3f4f6;">
                <button class="btn btn-secondary" onclick="closeWeeklyReportDrawer()">关闭</button>
                ${canEdit ? `<button class="btn btn-secondary" onclick="closeWeeklyReportDrawer(); editWeeklyReport(${report.id});">编辑</button>` : ''}
                ${canReview ? `<button class="btn" style="background:#16a34a;" onclick="approveWeeklyReport(${report.id});">通过</button>` : ''}
                ${canReview ? `<button class="btn" style="background:#dc2626;" onclick="rejectWeeklyReport(${report.id});">驳回</button>` : ''}
            </div>
        `;
        document.getElementById('weeklyReportDrawer').style.display = 'block';
        document.getElementById('weeklyReportOverlay').style.display = 'block';
    }

    function closeWeeklyReportDrawer() {
        document.getElementById('weeklyReportDrawer').style.display = 'none';
        document.getElementById('weeklyReportOverlay').style.display = 'none';
    }

    function approveWeeklyReport(id) {
        if (!canReviewWeeklyReport()) { alert('仅导师/组长可审核周报'); return; }
        const report = weeklyReportData.find(r => r.id === id);
        if (!report) return;
        const comment = prompt('请输入审核意见（可选）：') || '审核通过';
        report.status = 'approved';
        report.reviewComment = comment;
        report.reviewer = currentUser ? (currentUser.realName || currentUser.username) : '';
        report.reviewTime = new Date().toLocaleString('zh-CN');
        saveWeeklyReportData();
        renderWeeklyReportList();
        showWeeklyReportDetail(id);
        recordOperationLog('工作周报', '审核', `审核通过周报：${report.weekRange}，提交人${report.owner}`, { reportId: id, weekRange: report.weekRange, ownerName: report.owner }, { success: true }, 1, '', 0);
        if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner('审核结果已同步', false);
    }

    function rejectWeeklyReport(id) {
        if (!canReviewWeeklyReport()) { alert('仅导师/组长可审核周报'); return; }
        const report = weeklyReportData.find(r => r.id === id);
        if (!report) return;
        const comment = prompt('请输入驳回原因：');
        if (!comment) { alert('请填写驳回原因'); return; }
        report.status = 'rejected';
        report.reviewComment = comment;
        report.reviewer = currentUser ? (currentUser.realName || currentUser.username) : '';
        report.reviewTime = new Date().toLocaleString('zh-CN');
        saveWeeklyReportData();
        renderWeeklyReportList();
        showWeeklyReportDetail(id);
        recordOperationLog('工作周报', '审核', `驳回周报：${report.weekRange}，提交人${report.owner}，原因：${comment}`, { reportId: id, weekRange: report.weekRange, ownerName: report.owner }, { success: true }, 1, '', 0);
        if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner('驳回结果已同步', false);
    }

    // ===== 通知管理模块（全局联动 + 已读回执） =====
    let noticeData = [];
    try { window.noticeData = noticeData; } catch (eNoticeBind) {}
    let editingNoticeId = null;
    let noticePage = 1;
    let noticeStatFilter = '';
    let selectedNoticeIds = {};
    const NOTICE_PAGE_SIZE = 10;

    const NOTICE_TYPE_CONFIG = {
        notice: { label: '通知', icon: '📋', color: '#1890ff', bgColor: '#e6f7ff' },
        announcement: { label: '公告', icon: '📢', color: '#667eea', bgColor: '#e8ebfa' },
        meeting: { label: '会议通知', icon: '📅', color: '#faad14', bgColor: '#fff7e6' },
        urgent: { label: '紧急通知', icon: '🚨', color: '#ff4d4f', bgColor: '#fff1f0' }
    };

    function canManageNotices() {
        return !!(currentUser && (currentUser.role === 'admin' || currentUser.role === 'leader'));
    }

    function canViewNoticeReadStats() {
        return !!(currentUser && (currentUser.role === 'admin' || currentUser.role === 'leader'));
    }

    function normalizeNoticeRecord(n) {
        n = n || {};
        const reads = mergeReadLists(Array.isArray(n.reads) ? n.reads : [], []);
        const audienceNames = Array.isArray(n.audienceNames)
            ? n.audienceNames.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
            : [];
        return Object.assign({}, n, {
            audience: n.audience || (audienceNames.length ? 'custom' : 'all'),
            audienceNames: audienceNames,
            audienceGrade: n.audienceGrade || '',
            audienceGroup: n.audienceGroup || '',
            pinned: !!n.pinned,
            remindAt: n.remindAt || '',
            remindCount: Number(n.remindCount || 0) || 0,
            reads: reads,
            attachments: Array.isArray(n.attachments) ? n.attachments : [],
            status: n.status || 'published',
            scheduledAt: n.scheduledAt || '',
            contentIsHtml: n.contentIsHtml !== false
        });
    }

    function mergeReadLists(a, b) {
        const list = [].concat(a || [], b || []).map(function (r) {
            return {
                userId: r.userId != null && r.userId !== '' ? Number(r.userId) : null,
                studentId: String(r.studentId || ''),
                userName: String(r.userName || r.realName || ''),
                readAt: String(r.readAt || '')
            };
        }).filter(function (r) { return r.userId || r.studentId || r.userName; });

        const byStrong = {};
        list.forEach(function (r) {
            var k = r.userId != null ? ('id:' + r.userId) : (r.studentId ? ('sid:' + r.studentId) : ('name:' + r.userName));
            if (!byStrong[k] || String(r.readAt || '') > String(byStrong[k].readAt || '')) byStrong[k] = r;
        });
        const strongList = Object.keys(byStrong).map(function (k) { return byStrong[k]; });
        const byName = {};
        strongList.forEach(function (r) {
            var nk = String(r.userName || '').trim() || ('__anon__' + (r.userId != null ? r.userId : r.studentId));
            if (!byName[nk]) {
                byName[nk] = r;
                return;
            }
            var cur = byName[nk];
            byName[nk] = {
                userId: cur.userId != null ? cur.userId : r.userId,
                studentId: cur.studentId || r.studentId,
                userName: cur.userName || r.userName,
                readAt: String(r.readAt || '') > String(cur.readAt || '') ? r.readAt : cur.readAt
            };
        });
        return Object.keys(byName).map(function (k) { return byName[k]; });
    }

    function mergeIncomingNoticeData(incoming) {
        const localMap = {};
        (noticeData || []).forEach(function (n) { localMap[n.id] = normalizeNoticeRecord(n); });
        const remote = (Array.isArray(incoming) ? incoming : []).map(normalizeNoticeRecord);
        const remoteIds = {};
        const merged = remote.map(function (n) {
            remoteIds[n.id] = true;
            const prev = localMap[n.id];
            if (!prev) return n;
            return Object.assign({}, n, {
                reads: mergeReadLists(prev.reads, n.reads),
                remindAt: n.remindAt || prev.remindAt || '',
                remindCount: Math.max(Number(n.remindCount || 0), Number(prev.remindCount || 0))
            });
        });
        // 保留本地尚未同步到云端的新通知
        Object.keys(localMap).forEach(function (id) {
            if (!remoteIds[id]) merged.push(localMap[id]);
        });
        return merged;
    }
    window.mergeIncomingNoticeData = mergeIncomingNoticeData;

    function initNoticePublish() {
        loadNoticeData();
        updateNoticePublishPermissionUI();
        updateNoticeStats();
        renderNoticeList();
        refreshGlobalNoticeCenter();
    }

    function updateNoticePublishPermissionUI() {
        const btn = document.getElementById('noticePublishBtn');
        if (btn) btn.style.display = canManageNotices() ? '' : 'none';
        const emptyBtn = document.querySelector('#noticeEmptyState .btn');
        if (emptyBtn) emptyBtn.style.display = canManageNotices() ? '' : 'none';
    }

    function loadNoticeData() {
        const stored = localStorage.getItem('noticeData');
        if (stored) {
            try {
                noticeData = mergeIncomingNoticeData(JSON.parse(stored));
            } catch (e) {
                noticeData = buildRealTeamDefaultNotices();
            }
            migrateNoticeDataToRealTeam();
        } else {
            noticeData = buildRealTeamDefaultNotices();
            saveNoticeData();
        }
    }

    function buildRealTeamDefaultNotices() {
        const now = new Date();
        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() + 7);
        const publisher = currentUser?.realName || '团队管理员';
        const nowStr = now.toISOString().replace('T', ' ').substring(0, 16);
        const endStr = weekEnd.toISOString().replace('T', ' ').substring(0, 16);
        return [
            normalizeNoticeRecord({ id: 1, title: '团队成员信息统一维护通知', type: 'notice', content: '请各位成员核对自己的姓名、年级、联系方式、研究方向、头像等信息。成员档案将同步到账号权限、任务负责人、周报提交人等功能中。', startTime: nowStr, endTime: endStr, publishTime: now.toLocaleString('zh-CN'), publisher, audience: 'all', pinned: true }),
            normalizeNoticeRecord({ id: 2, title: '本周组会安排', type: 'meeting', content: '本周组会请围绕城市安全、智能监测、结构风险评估、项目推进情况进行汇报。请提前准备进展、问题和下一步计划。', startTime: nowStr, endTime: '', publishTime: now.toLocaleString('zh-CN'), publisher, audience: 'all' }),
            normalizeNoticeRecord({ id: 3, title: '资源中心与成果台账维护要求', type: 'announcement', content: '论文、专利、项目、数据集、报告等资料请及时上传或登记，保证团队资料统一归档、全员可查。', startTime: nowStr, endTime: '', publishTime: now.toLocaleString('zh-CN'), publisher, audience: 'all' })
        ];
    }

    function migrateNoticeDataToRealTeam() {
        const demoPublishers = ['张三', '李四', '王五', '赵六'];
        const hasDemo = Array.isArray(noticeData) && noticeData.some(n => demoPublishers.includes(n.publisher));
        if (hasDemo) {
            noticeData = buildRealTeamDefaultNotices();
            saveNoticeData();
            return;
        }
        noticeData = (noticeData || []).map(normalizeNoticeRecord);
    }

    function saveNoticeData(options) {
        options = options || {};
        noticeData = (noticeData || []).map(normalizeNoticeRecord);
        localStorage.setItem('noticeData', JSON.stringify(noticeData));
        try { window.noticeData = noticeData; } catch (eW) {}
        try { if (typeof cloudUpsert === 'function') cloudUpsert('noticeData', JSON.stringify(noticeData)); } catch (e) {}
        if (options.silent !== true) {
            refreshGlobalNoticeCenter();
            updateHomeNoticeBanner();
        }
        try {
            if (typeof recordOperationLog === 'function' && options.log) {
                recordOperationLog('通知发布', options.log.action || '更新', options.log.desc || '更新通知', options.log.detail || {}, { success: true }, 1, '', 0);
            }
        } catch (e2) {}
    }
    window.normalizeNoticeRecord = normalizeNoticeRecord;
    window.saveNoticeData = saveNoticeData;

    function getNoticeAudienceMembers(notice) {
        const accounts = Array.isArray(accountData) ? accountData : [];
        let raw = accounts.filter(function (a) {
            if (!a || a.role === 'visitor') return false;
            // 已毕业成员不接收通知
            if (typeof isAccountGraduated === 'function' ? isAccountGraduated(a) : !!a.graduated) return false;
            return true;
        }).map(function (a) {
            return {
                userId: a.id,
                studentId: a.studentId || '',
                userName: a.realName || a.username || a.studentId || ('用户' + a.id),
                role: a.role || 'student',
                group: a.group || '',
                grade: a.grade || ''
            };
        });

        // 定向通知：年级 / 小组 / 指定成员
        if (notice && notice.audience === 'grade' && notice.audienceGrade) {
            const want = String(notice.audienceGrade || '').replace(/级/g, '');
            raw = raw.filter(function (m) {
                const g = String(m.grade || '').replace(/级/g, '');
                return g === want || String(m.grade || '') === String(notice.audienceGrade);
            });
        } else if (notice && notice.audience === 'group' && notice.audienceGroup) {
            raw = raw.filter(function (m) { return String(m.group || '') === String(notice.audienceGroup); });
        } else {
            const names = (notice && Array.isArray(notice.audienceNames))
                ? notice.audienceNames.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
                : [];
            const isCustom = notice && (notice.audience === 'custom' || (notice.audience !== 'all' && notice.audience !== 'grade' && notice.audience !== 'group' && names.length > 0));
            if (isCustom && names.length) {
                const nameSet = {};
                names.forEach(function (n) { nameSet[n] = true; });
                raw = raw.filter(function (m) { return !!nameSet[m.userName]; });
                names.forEach(function (n) {
                    if (raw.some(function (m) { return m.userName === n; })) return;
                    // 自定义名单里若是已毕业成员，仍不纳入通知
                    try {
                        if (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData)) {
                            const tm = teamMemberData.find(function (x) { return x && x.name === n; });
                            if (tm && typeof isMemberGraduated === 'function' && isMemberGraduated(tm)) return;
                        }
                    } catch (eGrad) {}
                    raw.push({
                        userId: null,
                        studentId: '',
                        userName: n,
                        role: 'student',
                        group: '',
                        grade: ''
                    });
                });
            }
        }

        const seen = {};
        const out = [];
        raw.forEach(function (m) {
            var k = m.studentId ? ('sid:' + m.studentId) : (m.userId != null ? ('id:' + m.userId) : ('name:' + m.userName));
            var nameKey = 'name:' + String(m.userName || '').trim();
            if (seen[k]) return;
            if (m.userName && seen[nameKey]) {
                var prev = seen[nameKey];
                var prevRank = prev.role === 'admin' ? 3 : (prev.role === 'leader' ? 2 : 1);
                var curRank = m.role === 'admin' ? 3 : (m.role === 'leader' ? 2 : 1);
                if (curRank <= prevRank) return;
                var idx = out.indexOf(prev);
                if (idx >= 0) out.splice(idx, 1);
            }
            seen[k] = m;
            if (m.userName) seen[nameKey] = m;
            out.push(m);
        });
        return out;
    }

    /** 当前用户是否在通知接收范围内 */
    function isNoticeVisibleToUser(notice, user) {
        if (!notice || !user) return false;
        if (user.role === 'visitor') return false;
        // 已毕业用户不接收通知
        if (typeof isAccountGraduated === 'function' && isAccountGraduated(user)) return false;
        if (user.graduated) return false;
        const names = Array.isArray(notice.audienceNames) ? notice.audienceNames : [];
        const isCustom = notice.audience === 'custom' || (notice.audience !== 'all' && notice.audience !== 'grade' && notice.audience !== 'group' && names.length > 0);
        if (notice.audience === 'grade' && notice.audienceGrade) {
            const want = String(notice.audienceGrade || '').replace(/级/g, '');
            const mine = String(user.grade || '').replace(/级/g, '');
            if (want && mine && want !== mine && String(user.grade || '') !== String(notice.audienceGrade)) return false;
        }
        if (notice.audience === 'group' && notice.audienceGroup) {
            if (String(user.group || '') !== String(notice.audienceGroup)) return false;
        }
        if (!isCustom && notice.audience !== 'custom') return true; // 全员 / 年级 / 小组（已按条件过滤）
        const myName = String(user.realName || user.username || '').trim();
        const mySid = String(user.studentId || '').trim();
        if (names.indexOf(myName) >= 0) return true;
        const audience = getNoticeAudienceMembers(notice);
        return audience.some(function (m) {
            if (m.userId != null && Number(m.userId) === Number(user.id)) return true;
            if (mySid && m.studentId && String(m.studentId) === mySid) return true;
            if (myName && m.userName && m.userName === myName) return true;
            return false;
        });
    }

    function isSameNoticeUser(reader, member) {
        if (!reader || !member) return false;
        if (reader.userId != null && member.userId != null && Number(reader.userId) === Number(member.userId)) return true;
        if (reader.studentId && member.studentId && String(reader.studentId) === String(member.studentId)) return true;
        if (reader.userName && member.userName && String(reader.userName) === String(member.userName)) return true;
        return false;
    }

    function hasUserReadNotice(notice, user) {
        if (!notice || !user) return false;
        const me = {
            userId: user.id,
            studentId: user.studentId || '',
            userName: user.realName || user.username || ''
        };
        return (notice.reads || []).some(function (r) { return isSameNoticeUser(r, me); });
    }

    function getNoticeReadStats(notice) {
        const audience = getNoticeAudienceMembers(notice);
        const reads = mergeReadLists(notice.reads || [], []);
        const usedReadIdx = {};
        const readMembers = [];
        const unreadMembers = [];

        function findReadForMember(m) {
            for (var i = 0; i < reads.length; i++) {
                if (usedReadIdx[i]) continue;
                var r = reads[i];
                if (r.userId != null && m.userId != null && Number(r.userId) === Number(m.userId)) return i;
                if (r.studentId && m.studentId && String(r.studentId) === String(m.studentId)) return i;
            }
            for (var j = 0; j < reads.length; j++) {
                if (usedReadIdx[j]) continue;
                var r2 = reads[j];
                if (r2.userName && m.userName && String(r2.userName) === String(m.userName)) return j;
            }
            return -1;
        }

        audience.forEach(function (m) {
            var idx = findReadForMember(m);
            if (idx >= 0) {
                usedReadIdx[idx] = true;
                readMembers.push(Object.assign({}, m, { readAt: reads[idx].readAt }));
            } else {
                unreadMembers.push(m);
            }
        });

        return {
            total: audience.length,
            readCount: readMembers.length,
            unreadCount: unreadMembers.length,
            readMembers: readMembers,
            unreadMembers: unreadMembers
        };
    }

    function markNoticeAsRead(id, options) {
        options = options || {};
        if (!currentUser) return false;
        const notice = noticeData.find(n => n.id === id);
        if (!notice) return false;
        if (hasUserReadNotice(notice, currentUser)) {
            if (options.forceRefresh) refreshGlobalNoticeCenter();
            return false;
        }
        notice.reads = mergeReadLists(notice.reads, [{
            userId: currentUser.id,
            studentId: currentUser.studentId || '',
            userName: currentUser.realName || currentUser.username || '',
            readAt: new Date().toLocaleString('zh-CN')
        }]);
        // 落盘前再清洗一次，消除历史重复回执
        notice.reads = mergeReadLists(notice.reads, []);
        saveNoticeData({ silent: false });
        return true;
    }

    function isNoticeExpired(notice) {
        return !!(notice && notice.endTime && new Date(notice.endTime) <= new Date());
    }

    function isNoticeActive(notice) {
        return !isNoticeExpired(notice);
    }

    function getMyUnreadNotices() {
        if (!currentUser) return [];
        return (noticeData || []).filter(function (n) {
            return isNoticeVisibleToUser(n, currentUser) && isNoticeActive(n) && !hasUserReadNotice(n, currentUser);
        });
    }

    function updateNoticeStats() {
        const now = new Date();
        const total = noticeData.length;
        const active = noticeData.filter(n => !n.endTime || new Date(n.endTime) > now).length;
        const urgent = noticeData.filter(n => n.type === 'urgent' && (!n.endTime || new Date(n.endTime) > now)).length;
        const expired = noticeData.filter(n => n.endTime && new Date(n.endTime) <= now).length;
        const unread = getMyUnreadNotices().length;

        if (document.getElementById('noticeStatTotal')) document.getElementById('noticeStatTotal').textContent = total;
        if (document.getElementById('noticeStatActive')) document.getElementById('noticeStatActive').textContent = active;
        if (document.getElementById('noticeStatUrgent')) document.getElementById('noticeStatUrgent').textContent = urgent;
        if (document.getElementById('noticeStatExpired')) document.getElementById('noticeStatExpired').textContent = expired;
        if (document.getElementById('noticeStatUnread')) document.getElementById('noticeStatUnread').textContent = unread;

        document.querySelectorAll('.notice-stat-card').forEach(function (el) {
            el.classList.toggle('active', (el.getAttribute('data-filter') || '') === (noticeStatFilter || ''));
        });
    }

    function setNoticeStatFilter(filter) {
        noticeStatFilter = filter || '';
        const statusSel = document.getElementById('noticeStatusFilter');
        if (statusSel) statusSel.value = noticeStatFilter;
        noticePage = 1;
        renderNoticeList();
    }

    function getFilteredNotices() {
        let filtered = [...noticeData];
        // 普通成员只看发给自己的；导师/组长在管理页看全部
        // 草稿/未到点的定时通知：仅管理员可见
        if (currentUser && !canManageNotices()) {
            filtered = filtered.filter(function (n) {
                if (n.status === 'draft' || n.status === 'scheduled') return false;
                return isNoticeVisibleToUser(n, currentUser);
            });
        }
        const search = document.getElementById('noticeSearchInput')?.value?.toLowerCase() || '';
        const type = document.getElementById('noticeTypeFilter')?.value || '';
        const status = document.getElementById('noticeStatusFilter')?.value || noticeStatFilter || '';

        if (search) {
            filtered = filtered.filter(n => String(n.title || '').toLowerCase().includes(search) || String(n.content || '').replace(/<[^>]+>/g, ' ').toLowerCase().includes(search));
        }
        if (type) filtered = filtered.filter(n => n.type === type);
        if (status === 'active') filtered = filtered.filter(n => n.status !== 'draft' && n.status !== 'scheduled' && isNoticeActive(n));
        if (status === 'urgent') filtered = filtered.filter(n => n.type === 'urgent' && n.status !== 'draft' && isNoticeActive(n));
        if (status === 'expired') filtered = filtered.filter(isNoticeExpired);
        if (status === 'unread') filtered = filtered.filter(n => currentUser && isNoticeVisibleToUser(n, currentUser) && n.status !== 'draft' && n.status !== 'scheduled' && isNoticeActive(n) && !hasUserReadNotice(n, currentUser));
        if (status === 'draft') filtered = filtered.filter(n => n.status === 'draft');
        if (status === 'scheduled') filtered = filtered.filter(n => n.status === 'scheduled');

        filtered.sort(function (a, b) {
            const ua = (a.type === 'urgent' && isNoticeActive(a)) ? 1 : 0;
            const ub = (b.type === 'urgent' && isNoticeActive(b)) ? 1 : 0;
            if (ua !== ub) return ub - ua;
            const pa = a.pinned ? 1 : 0;
            const pb = b.pinned ? 1 : 0;
            if (pa !== pb) return pb - pa;
            return new Date(b.publishTime) - new Date(a.publishTime);
        });
        return filtered;
    }

    function renderNoticeList() {
        const container = document.getElementById('noticeList');
        const emptyState = document.getElementById('noticeEmptyState');
        if (!container || !emptyState) return;

        updateNoticePublishPermissionUI();
        // 下拉与统计卡保持同步
        const statusSel = document.getElementById('noticeStatusFilter');
        if (statusSel && statusSel.value !== (noticeStatFilter || '') && statusSel.value) {
            noticeStatFilter = statusSel.value;
        } else if (statusSel && !statusSel.value && noticeStatFilter && ['active','urgent','unread','expired'].indexOf(noticeStatFilter) >= 0) {
            // keep card filter
        }

        const filtered = getFilteredNotices();
        const status = (statusSel && statusSel.value) || noticeStatFilter || '';
        const type = document.getElementById('noticeTypeFilter')?.value || '';
        const search = document.getElementById('noticeSearchInput')?.value?.trim() || '';
        const hasFilter = !!(status || type || search);
        const totalAll = (noticeData || []).length;

        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            var titleEl = emptyState.querySelector('h3');
            var descEl = emptyState.querySelector('p');
            var btnEl = emptyState.querySelector('.btn');
            if (hasFilter || totalAll > 0) {
                var tip = '当前筛选下暂无通知';
                if (status === 'unread') tip = '暂无未读通知，全部通知都已读完';
                else if (status === 'urgent') tip = '暂无紧急通知';
                else if (status === 'expired') tip = '暂无已过期通知';
                else if (status === 'active') tip = '暂无进行中的通知';
                else if (search) tip = '未找到匹配「' + search + '」的通知';
                if (titleEl) titleEl.textContent = status === 'unread' ? '没有未读通知' : '暂无匹配结果';
                if (descEl) descEl.textContent = tip + (totalAll > 0 ? '（库中共 ' + totalAll + ' 条，可清除筛选查看）' : '');
                if (btnEl) {
                    btnEl.style.display = '';
                    btnEl.textContent = '查看全部通知';
                    btnEl.onclick = function () {
                        noticeStatFilter = '';
                        if (statusSel) statusSel.value = '';
                        var typeSel = document.getElementById('noticeTypeFilter');
                        if (typeSel) typeSel.value = '';
                        var searchInput = document.getElementById('noticeSearchInput');
                        if (searchInput) searchInput.value = '';
                        noticePage = 1;
                        renderNoticeList();
                    };
                }
            } else {
                if (titleEl) titleEl.textContent = '暂无通知';
                if (descEl) descEl.textContent = '点击下方按钮发布第一条通知';
                if (btnEl) {
                    btnEl.style.display = canManageNotices() ? '' : 'none';
                    btnEl.textContent = '📝 发布通知';
                    btnEl.onclick = function () { showAddNoticeModal(); };
                }
            }
            renderNoticePagination([]);
            updateNoticeStats();
            return;
        }
        emptyState.style.display = 'none';

        const start = (noticePage - 1) * NOTICE_PAGE_SIZE;
        const pageData = filtered.slice(start, start + NOTICE_PAGE_SIZE);
        container.innerHTML = '';

        pageData.forEach(function (notice) {
            const typeConfig = NOTICE_TYPE_CONFIG[notice.type] || NOTICE_TYPE_CONFIG.notice;
            const expired = isNoticeExpired(notice);
            const unread = currentUser ? !hasUserReadNotice(notice, currentUser) : false;
            const stats = canViewNoticeReadStats() ? getNoticeReadStats(notice) : null;
            let expiringSoon = false;
            if (!expired && notice.endTime) {
                const endTs = Date.parse(String(notice.endTime).replace(/-/g, '/'));
                if (endTs && endTs - Date.now() < 24 * 3600 * 1000 && endTs > Date.now()) expiringSoon = true;
            }
            const card = document.createElement('div');
            card.style.cssText = `background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);cursor:pointer;transition:all 0.2s;${notice.type === 'urgent' ? 'border-left:4px solid #ff4d4f;' : ''}${expired ? 'opacity:0.72;' : ''}${unread ? 'border:1px solid #bfdbfe;' : ''}${expiringSoon ? 'border:1px solid #fdba74;background:#fff7ed;' : ''}`;
            card.onmouseenter = () => { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; };
            card.onmouseleave = () => { card.style.transform = ''; card.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)'; };
            card.onclick = () => showNoticeDetail(notice.id);
            const checked = !!selectedNoticeIds[String(notice.id)];
            const manageRow = canManageNotices()
                ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;" onclick="event.stopPropagation()">
                    <button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="editNotice(${notice.id})">编辑</button>
                    <button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="toggleNoticePin(${notice.id})">${notice.pinned ? '取消置顶' : '置顶'}</button>
                    <button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="withdrawNotice(${notice.id})">撤回</button>
                    <button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;color:#ef4444;" onclick="deleteNotice(${notice.id})">删除</button>
                   </div>`
                : '';
            card.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                        ${canManageNotices() ? `<label onclick="event.stopPropagation()" style="display:inline-flex;align-items:center;"><input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleNoticeSelect(${notice.id}, this.checked)"></label>` : ''}
                        ${unread ? '<span class="notice-unread-dot" title="未读"></span>' : ''}
                        <span style="font-size:20px;">${typeConfig.icon}</span>
                        <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;color:${typeConfig.color};background:${typeConfig.bgColor};">${typeConfig.label}</span>
                        ${notice.pinned ? '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;color:#7c3aed;background:#f5f3ff;">置顶</span>' : ''}
                        ${expiringSoon ? '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;color:#c2410c;background:#ffedd5;">即将过期</span>' : ''}
                        ${unread ? '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;color:#1d4ed8;background:#dbeafe;">未读</span>' : '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;color:#64748b;background:#f1f5f9;">已读</span>'}
                    </div>
                    <span style="font-size:12px;color:#888;">${notice.publishTime || ''}</span>
                </div>
                <h3 style="font-size:16px;font-weight:${unread ? '800' : '700'};color:${expired ? '#94a3b8' : '#333'};margin:0 0 8px;${expired ? 'text-decoration:line-through;' : ''}">${escHtml(notice.title || '')}</h3>
                <p style="font-size:14px;color:#666;line-height:1.6;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escHtml(notice.content || '')}</p>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:12px;color:#888;">发布人：${escHtml(notice.publisher || '')}</span>
                    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                        ${stats ? `<span style="font-size:12px;color:#4338ca;">已读 ${stats.readCount}/${stats.total}</span>` : ''}
                        ${notice.endTime ? `<span style="font-size:12px;color:${expired ? '#ff4d4f' : (expiringSoon ? '#c2410c' : '#faad14')};">${expired ? '已过期' : '有效期至：' + escHtml(notice.endTime)}</span>` : ''}
                    </div>
                </div>
                ${manageRow}`;
            container.appendChild(card);
        });

        renderNoticePagination(filtered);
        updateNoticeStats();
        updateNoticeBatchBar();
        refreshGlobalNoticeCenter();
    }

    function renderNoticePagination(filtered) {
        const pagination = document.getElementById('noticePagination');
        if (!pagination) return;
        const totalPages = Math.ceil(filtered.length / NOTICE_PAGE_SIZE) || 1;
        if (totalPages <= 1) {
            pagination.innerHTML = `<span style="font-size:13px;color:#666;">共 ${filtered.length} 条</span>`;
            return;
        }
        let html = `<span style="font-size:13px;color:#666;">共 ${filtered.length} 条</span>`;
        if (noticePage > 1) html += `<button onclick="setNoticePage(${noticePage - 1})" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">上一页</button>`;
        for (let i = 1; i <= totalPages; i++) {
            if (i === noticePage) html += `<button style="padding:4px 12px;border:none;background:#667eea;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;">${i}</button>`;
            else html += `<button onclick="setNoticePage(${i})" style="padding:4px 12px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">${i}</button>`;
        }
        if (noticePage < totalPages) html += `<button onclick="setNoticePage(${noticePage + 1})" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">下一页</button>`;
        pagination.innerHTML = html;
    }

    function setNoticePage(page) {
        noticePage = page;
        renderNoticeList();
    }

    function toggleNoticeAudienceCustom() {
        const mode = (document.getElementById('noticeAudience') || {}).value || 'all';
        const customWrap = document.getElementById('noticeAudienceCustomWrap');
        const gradeWrap = document.getElementById('noticeAudienceGradeWrap');
        const groupWrap = document.getElementById('noticeAudienceGroupWrap');
        if (customWrap) customWrap.style.display = mode === 'custom' ? 'block' : 'none';
        if (gradeWrap) gradeWrap.style.display = mode === 'grade' ? 'block' : 'none';
        if (groupWrap) groupWrap.style.display = mode === 'group' ? 'block' : 'none';
    }

    function fillNoticeAudienceMeta(notice) {
        notice = notice || {};
        const gradeSel = document.getElementById('noticeAudienceGrade');
        const groupSel = document.getElementById('noticeAudienceGroup');
        const years = (typeof getMemberGradeYears === 'function' ? getMemberGradeYears() : ['2022', '2023', '2024', '2025', '2026']);
        const grades = years.map(function (y) { return y + '级'; });
        if (gradeSel) {
            const selected = String(notice.audienceGrade || '');
            const selectedNorm = selected.replace(/级/g, '');
            gradeSel.innerHTML = grades.map(function (g) {
                const y = g.replace(/级/g, '');
                const sel = (selected === g || selectedNorm === y) ? 'selected' : '';
                return `<option value="${escHtml(g)}" ${sel}>${escHtml(g)}</option>`;
            }).join('');
        }
        const groups = (typeof GROUPS !== 'undefined' && Array.isArray(GROUPS)) ? GROUPS.slice() : ['第一小组', '第二小组', '第三小组', '第四小组'];
        if (groupSel) {
            groupSel.innerHTML = groups.map(function (g) {
                return `<option value="${escHtml(g)}" ${String(notice.audienceGroup || '') === g ? 'selected' : ''}>${escHtml(g)}</option>`;
            }).join('');
        }
    }

    function fillNoticeAudienceOptions(selectedNames) {
        const sel = document.getElementById('noticeAudienceNames');
        if (!sel) return;
        const names = typeof getNotifiableTeamOwnerNames === 'function'
            ? getNotifiableTeamOwnerNames()
            : (typeof getRealTeamOwnerNames === 'function' ? getRealTeamOwnerNames() : []);
        const selected = new Set((selectedNames || []).map(String));
        sel.innerHTML = names.map(n => `<option value="${escHtml(n)}" ${selected.has(n) ? 'selected' : ''}>${escHtml(n)}</option>`).join('');
    }

    function applyNoticeTemplate(key) {
        const pick = document.getElementById('noticeTemplatePick');
        if (!key) { if (pick) pick.value = ''; return; }
        const map = {
            meeting: { title: '组会通知', type: 'meeting', content: '本周组会安排如下：\n时间：\n地点：\n议程：\n请准时参加。' },
            weekly: { title: '周报提交提醒', type: 'notice', content: '请于本周日 23:59 前提交本周工作周报，逾期将影响考核。' },
            contest: { title: '比赛申报通知', type: 'announcement', content: '现启动比赛报名/申报，请有意向的同学于截止日前完成材料提交。\n截止时间：\n材料要求：' },
            lab: { title: '实验室安全通知', type: 'urgent', content: '请全体成员注意实验室安全规范：\n1. 离开实验室关闭电源与门窗\n2. 实验废弃物按规定处置\n3. 发现异常及时报告导师' }
        };
        const t = map[key];
        if (!t) return;
        const titleEl = document.getElementById('noticeTitle');
        const typeEl = document.getElementById('noticeType');
        const contentEl = document.getElementById('noticeContent');
        if (titleEl && !titleEl.value.trim()) titleEl.value = t.title;
        if (typeEl) typeEl.value = t.type;
        if (contentEl && !contentEl.value.trim()) contentEl.value = t.content;
        if (t.type === 'urgent') {
            const pinned = document.getElementById('noticePinned');
            if (pinned) pinned.checked = true;
        }
    }

    function showAddNoticeModal() {
        if (!canManageNotices()) {
            alert('仅导师/组长可发布通知');
            return;
        }
        editingNoticeId = null;
        document.getElementById('noticeModalTitle').textContent = '发布通知';
        document.getElementById('noticeTitle').value = '';
        document.getElementById('noticeType').value = 'notice';
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const end = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
        const localEnd = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
        document.getElementById('noticeStartTime').value = localNow;
        document.getElementById('noticeEndTime').value = localEnd;
        document.getElementById('noticeContent').value = '';
        const aud = document.getElementById('noticeAudience');
        if (aud) aud.value = 'all';
        const pinned = document.getElementById('noticePinned');
        if (pinned) pinned.checked = false;
        const tpl = document.getElementById('noticeTemplatePick');
        if (tpl) tpl.value = '';
        fillNoticeAudienceOptions([]);
        fillNoticeAudienceMeta({});
        toggleNoticeAudienceCustom();
        document.getElementById('noticeModal').style.display = 'flex';
    }

    function editNotice(id) {
        if (!canManageNotices()) {
            alert('仅导师/组长可编辑通知');
            return;
        }
        const notice = noticeData.find(n => Number(n.id) === Number(id));
        if (!notice) return;
        editingNoticeId = notice.id;
        document.getElementById('noticeModalTitle').textContent = '编辑通知';
        document.getElementById('noticeTitle').value = notice.title || '';
        document.getElementById('noticeType').value = notice.type || 'notice';
        document.getElementById('noticeStartTime').value = (notice.startTime || '').replace(' ', 'T').slice(0, 16);
        document.getElementById('noticeEndTime').value = (notice.endTime || '').replace(' ', 'T').slice(0, 16);
        document.getElementById('noticeContent').value = notice.content || '';
        const aud = document.getElementById('noticeAudience');
        let mode = notice.audience || 'all';
        if (mode !== 'grade' && mode !== 'group' && mode !== 'custom' && mode !== 'all') {
            mode = (Array.isArray(notice.audienceNames) && notice.audienceNames.length) ? 'custom' : 'all';
        }
        if (aud) aud.value = mode;
        fillNoticeAudienceOptions(notice.audienceNames || []);
        fillNoticeAudienceMeta(notice);
        toggleNoticeAudienceCustom();
        const pinned = document.getElementById('noticePinned');
        if (pinned) pinned.checked = !!notice.pinned;
        const tpl = document.getElementById('noticeTemplatePick');
        if (tpl) tpl.value = '';
        document.getElementById('noticeModal').style.display = 'flex';
    }

    function toggleNoticePin(id) {
        if (!canManageNotices()) return;
        const idx = noticeData.findIndex(n => Number(n.id) === Number(id));
        if (idx < 0) return;
        noticeData[idx].pinned = !noticeData[idx].pinned;
        saveNoticeData({ log: { action: '置顶', desc: (noticeData[idx].pinned ? '置顶' : '取消置顶') + '：' + noticeData[idx].title } });
        renderNoticeList();
    }

    function withdrawNotice(id) {
        if (!canManageNotices()) return;
        if (!confirm('撤回后将立即过期，确认？')) return;
        const idx = noticeData.findIndex(n => Number(n.id) === Number(id));
        if (idx < 0) return;
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        noticeData[idx].endTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        noticeData[idx].pinned = false;
        saveNoticeData({ log: { action: '撤回', desc: '撤回通知：' + noticeData[idx].title } });
        renderNoticeList();
        try { closeNoticeDrawer(); } catch (e) {}
    }

    function closeNoticeModal() {
        document.getElementById('noticeModal').style.display = 'none';
    }

    function saveNotice() {
        if (!canManageNotices()) {
            alert('仅导师/组长可发布通知');
            return;
        }
        const title = document.getElementById('noticeTitle').value.trim();
        const type = document.getElementById('noticeType').value;
        const startTime = document.getElementById('noticeStartTime').value;
        const endTime = document.getElementById('noticeEndTime').value;
        const content = document.getElementById('noticeContent').value.trim();
        if (!title || !content) {
            alert('请填写通知标题和内容');
            return;
        }
        const audienceMode = (document.getElementById('noticeAudience') || {}).value || 'all';
        const nameSel = document.getElementById('noticeAudienceNames');
        let audienceNames = audienceMode === 'custom' && nameSel
            ? Array.from(nameSel.selectedOptions).map(o => o.value).filter(Boolean)
            : [];
        const audienceGrade = audienceMode === 'grade' ? ((document.getElementById('noticeAudienceGrade') || {}).value || '') : '';
        const audienceGroup = audienceMode === 'group' ? ((document.getElementById('noticeAudienceGroup') || {}).value || '') : '';
        if (audienceMode === 'grade' && audienceGrade) {
            audienceNames = (Array.isArray(accountData) ? accountData : [])
                .filter(a => a && a.role !== 'visitor' && String(a.grade || '') === String(audienceGrade))
                .map(a => a.realName || a.username || '')
                .filter(Boolean);
        } else if (audienceMode === 'group' && audienceGroup) {
            audienceNames = (Array.isArray(accountData) ? accountData : [])
                .filter(a => a && a.role !== 'visitor' && String(a.group || '') === String(audienceGroup))
                .map(a => a.realName || a.username || '')
                .filter(Boolean);
        }
        const pinned = !!(document.getElementById('noticePinned') || {}).checked || type === 'urgent';
        const publisher = currentUser ? currentUser.realName || currentUser.username : '未知用户';
        const audiencePayload = {
            audience: (audienceMode === 'custom' && !audienceNames.length) ? 'all' : audienceMode,
            audienceNames: (audienceMode === 'all') ? [] : audienceNames,
            audienceGrade: audienceGrade,
            audienceGroup: audienceGroup
        };
        if (editingNoticeId) {
            const idx = noticeData.findIndex(n => n.id === editingNoticeId);
            if (idx !== -1) {
                noticeData[idx] = normalizeNoticeRecord({
                    ...noticeData[idx],
                    title, type, startTime, endTime, content,
                    ...audiencePayload,
                    pinned
                });
            }
            saveNoticeData({ log: { action: '编辑', desc: '编辑通知：' + title } });
        } else {
            const newId = noticeData.length > 0 ? Math.max(...noticeData.map(n => Number(n.id) || 0)) + 1 : 1;
            noticeData.push(normalizeNoticeRecord({
                id: newId,
                title,
                type,
                content,
                startTime,
                endTime,
                publishTime: new Date().toLocaleString('zh-CN'),
                publisher,
                ...audiencePayload,
                pinned,
                reads: []
            }));
            saveNoticeData({ log: { action: '发布', desc: '发布通知：' + title } });
            try {
                if (type === 'urgent' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    new Notification('紧急通知', { body: title });
                } else if (type === 'urgent' && typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
                    Notification.requestPermission();
                }
            } catch (e) {}
        }
        closeNoticeModal();
        renderNoticeList();
        if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner('通知已发布并同步云端', false);
        else alert('发布成功！');
    }

    function buildNoticeReadPanelHtml(notice) {
        if (!canViewNoticeReadStats()) return '';
        const stats = getNoticeReadStats(notice);
        const readLis = stats.readMembers.map(function (m) {
            return `<li class="read"><span>${escHtml(m.userName)}${m.group ? ' · ' + escHtml(m.group) : ''}</span><span>${escHtml(m.readAt || '')}</span></li>`;
        }).join('') || '<li style="border:none;background:transparent;color:#94a3b8;">暂无已读</li>';
        const unreadLis = stats.unreadMembers.map(function (m) {
            return `<li class="unread"><span>${escHtml(m.userName)}${m.group ? ' · ' + escHtml(m.group) : ''}</span><span>未读</span></li>`;
        }).join('') || '<li style="border:none;background:transparent;color:#94a3b8;">全部已读</li>';
        return `
            <div class="notice-read-panel">
                <div class="notice-read-panel-head">
                    <div>
                        <strong style="font-size:14px;color:#111827;">阅读统计</strong>
                        <div style="font-size:12px;color:#64748b;margin-top:2px;">已读 ${stats.readCount} / 应读 ${stats.total} · 未读 ${stats.unreadCount}</div>
                    </div>
                    ${stats.unreadCount > 0 ? `<button class="btn" style="padding:6px 12px;font-size:12px;" onclick="remindUnreadNoticeMembers(${notice.id})">催读未读成员</button>` : '<span style="font-size:12px;color:#16a34a;font-weight:700;">全部成员已读</span>'}
                </div>
                <div class="notice-read-cols">
                    <div class="notice-read-col">
                        <h4>✅ 已读成员</h4>
                        <ul>${readLis}</ul>
                    </div>
                    <div class="notice-read-col">
                        <h4>⏳ 未读成员</h4>
                        <ul>${unreadLis}</ul>
                    </div>
                </div>
            </div>`;
    }

    function showNoticeDetail(id) {
        const notice = noticeData.find(n => n.id === id);
        if (!notice) return;
        markNoticeAsRead(id);
        const typeConfig = NOTICE_TYPE_CONFIG[notice.type] || NOTICE_TYPE_CONFIG.notice;
        const expired = isNoticeExpired(notice);
        const manageBtns = canManageNotices()
            ? `<button class="btn btn-secondary" onclick="editNotice(${notice.id}); closeNoticeDrawer();">编辑</button>` +
              `<button class="btn btn-secondary" onclick="toggleNoticePin(${notice.id}); closeNoticeDrawer(); showNoticeDetail(${notice.id});">${notice.pinned ? '取消置顶' : '置顶'}</button>` +
              `<button class="btn btn-secondary" onclick="withdrawNotice(${notice.id})">撤回</button>` +
              `<button class="btn btn-secondary" onclick="deleteNotice(${notice.id}); closeNoticeDrawer();">删除</button>`
            : '';
        document.getElementById('noticeDetailContent').innerHTML = `
            <div style="margin-bottom: 24px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap:wrap;">
                    <span style="font-size: 24px;">${typeConfig.icon}</span>
                    <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;color:${typeConfig.color};background:${typeConfig.bgColor};">${typeConfig.label}</span>
                    ${notice.type === 'urgent' ? '<span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;color:#fff;background:#ff4d4f;">紧急</span>' : ''}
                    <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;color:#0369a1;background:#e0f2fe;">已标记已读</span>
                </div>
                <h2 style="font-size: 20px; font-weight: bold; color: #333; margin: 0;">${escHtml(notice.title || '')}</h2>
            </div>
            <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                <p style="margin: 0; color: #333; line-height: 1.8; font-size: 14px; white-space: pre-wrap;">${escHtml(notice.content || '')}</p>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                <div style="background: #f8f9fa; padding: 12px; border-radius: 8px;">
                    <div style="font-size: 12px; color: #888;">发布人</div>
                    <div style="font-size: 14px; color: #333; margin-top: 4px;">${escHtml(notice.publisher || '')}</div>
                </div>
                <div style="background: #f8f9fa; padding: 12px; border-radius: 8px;">
                    <div style="font-size: 12px; color: #888;">发布时间</div>
                    <div style="font-size: 14px; color: #333; margin-top: 4px;">${escHtml(notice.publishTime || '')}</div>
                </div>
                ${notice.startTime ? `<div style="background:#f8f9fa;padding:12px;border-radius:8px;"><div style="font-size:12px;color:#888;">生效时间</div><div style="font-size:14px;color:#333;margin-top:4px;">${escHtml(notice.startTime)}</div></div>` : ''}
                ${notice.endTime ? `<div style="background:${expired ? '#fff1f0' : '#fff7e6'};padding:12px;border-radius:8px;"><div style="font-size:12px;color:#888;">截止时间</div><div style="font-size:14px;color:${expired ? '#ff4d4f' : '#faad14'};margin-top:4px;">${escHtml(notice.endTime)} ${expired ? '(已过期)' : ''}</div></div>` : ''}
            </div>
            ${buildNoticeReadPanelHtml(notice)}
            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;">
                <button class="btn btn-secondary" onclick="closeNoticeDrawer()">关闭</button>
                ${manageBtns}
            </div>`;
        document.getElementById('noticeDrawer').style.display = 'block';
        document.getElementById('noticeOverlay').style.display = 'block';
        renderNoticeList();
    }

    function remindUnreadNoticeMembers(id) {
        if (!canViewNoticeReadStats()) {
            alert('仅导师/组长可查看并催读');
            return;
        }
        const notice = noticeData.find(n => n.id === id);
        if (!notice) return;
        const stats = getNoticeReadStats(notice);
        if (!stats.unreadCount) {
            alert('当前没有未读成员');
            return;
        }
        notice.remindAt = new Date().toLocaleString('zh-CN');
        notice.remindCount = Number(notice.remindCount || 0) + 1;
        saveNoticeData({ log: { action: '催读', desc: '催读通知：' + notice.title, detail: { unread: stats.unreadCount } } });
        showNoticeDetail(id);
        if (typeof showCloudSyncBanner === 'function') {
            showCloudSyncBanner(`已催读 ${stats.unreadCount} 位未读成员（全局铃铛同步）`, false);
        } else {
            alert(`已向 ${stats.unreadCount} 位未读成员发送催读提醒`);
        }
    }

    function closeNoticeDrawer() {
        document.getElementById('noticeDrawer').style.display = 'none';
        document.getElementById('noticeOverlay').style.display = 'none';
    }

    function deleteNotice(id) {
        if (!canManageNotices()) {
            alert('仅导师/组长可删除通知');
            return;
        }
        if (!confirm('确定要删除该通知吗？删除后全员同步移除。')) return;
        const hit = noticeData.find(n => n.id === id);
        noticeData = noticeData.filter(n => n.id !== id);
        delete selectedNoticeIds[String(id)];
        saveNoticeData({ log: { action: '删除', desc: '删除通知：' + ((hit && hit.title) || id) } });
        renderNoticeList();
        alert('已删除并同步云端');
    }

    function toggleNoticeSelect(id, checked) {
        if (checked) selectedNoticeIds[String(id)] = true;
        else delete selectedNoticeIds[String(id)];
        updateNoticeBatchBar();
    }

    function clearNoticeSelection() {
        selectedNoticeIds = {};
        updateNoticeBatchBar();
        renderNoticeList();
    }

    function getSelectedNoticeIds() {
        return Object.keys(selectedNoticeIds).map(Number).filter(Boolean);
    }

    function updateNoticeBatchBar() {
        const bar = document.getElementById('noticeBatchBar');
        const countEl = document.getElementById('noticeBatchCount');
        const n = getSelectedNoticeIds().length;
        if (bar) bar.style.display = (canManageNotices() && n) ? 'flex' : 'none';
        if (countEl) countEl.textContent = String(n);
    }

    function batchDeleteNotices() {
        if (!canManageNotices()) return;
        const ids = getSelectedNoticeIds();
        if (!ids.length) return;
        if (!confirm('确定批量删除选中的 ' + ids.length + ' 条通知？')) return;
        const idSet = {};
        ids.forEach(function (id) { idSet[id] = true; });
        noticeData = noticeData.filter(function (n) { return !idSet[n.id]; });
        selectedNoticeIds = {};
        saveNoticeData({ log: { action: '批量删除', desc: '删除 ' + ids.length + ' 条通知' } });
        renderNoticeList();
    }

    function batchPinNotices(pin) {
        if (!canManageNotices()) return;
        const ids = getSelectedNoticeIds();
        if (!ids.length) return;
        const idSet = {};
        ids.forEach(function (id) { idSet[id] = true; });
        noticeData.forEach(function (n) {
            if (idSet[n.id]) n.pinned = !!pin;
        });
        saveNoticeData({ log: { action: pin ? '批量置顶' : '批量取消置顶', desc: ids.length + ' 条' } });
        renderNoticeList();
    }

    function batchWithdrawNotices() {
        if (!canManageNotices()) return;
        const ids = getSelectedNoticeIds();
        if (!ids.length) return;
        if (!confirm('将选中通知设为立即过期，确认？')) return;
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const idSet = {};
        ids.forEach(function (id) { idSet[id] = true; });
        noticeData.forEach(function (n) {
            if (idSet[n.id]) { n.endTime = end; n.pinned = false; }
        });
        saveNoticeData({ log: { action: '批量过期', desc: ids.length + ' 条' } });
        renderNoticeList();
    }

    function getNoticeDismissStorageKey() {
        var uid = (currentUser && (currentUser.id || currentUser.studentId || currentUser.username)) || 'guest';
        return 'noticeGlobalDismissed_' + String(uid);
    }

    function loadDismissedNoticeIds() {
        try {
            var raw = localStorage.getItem(getNoticeDismissStorageKey());
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.map(String) : [];
        } catch (e) {
            return [];
        }
    }

    function saveDismissedNoticeIds(ids) {
        try {
            localStorage.setItem(getNoticeDismissStorageKey(), JSON.stringify((ids || []).map(String)));
        } catch (e) {}
    }

    /** 一键清除已读：仅从全局铃铛面板隐藏，不删除通知、不影响模块列表与已读统计 */
    function clearGlobalReadNotices() {
        var unreadSet = {};
        getMyUnreadNotices().forEach(function (n) { unreadSet[String(n.id)] = true; });
        var dismissed = loadDismissedNoticeIds();
        var map = {};
        dismissed.forEach(function (id) { map[id] = true; });
        var added = 0;
        (noticeData || []).forEach(function (n) {
            var id = String(n.id);
            if (unreadSet[id]) return; // 未读保留
            if (!map[id]) {
                map[id] = true;
                added++;
            }
        });
        if (added === 0 && Object.keys(map).length === 0) {
            if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner('没有可清除的已读通知', false);
            else alert('没有可清除的已读通知');
            return;
        }
        saveDismissedNoticeIds(Object.keys(map));
        refreshGlobalNoticeCenter();
        if (typeof showCloudSyncBanner === 'function') {
            showCloudSyncBanner('已清除已读（通知仍保留在「内部通知发布」）', false);
        }
    }

    function getGlobalNoticeList() {
        var dismissed = {};
        loadDismissedNoticeIds().forEach(function (id) { dismissed[id] = true; });
        var list = (noticeData || []).filter(function (n) {
            if (currentUser && !isNoticeVisibleToUser(n, currentUser)) return false;
            var id = String(n.id);
            var isUnread = currentUser && isNoticeActive(n) && !hasUserReadNotice(n, currentUser);
            // 未读始终显示；已读若已清除则隐藏
            if (isUnread) return true;
            return !dismissed[id];
        });
        list.sort(function (a, b) {
            var ua = (currentUser && isNoticeActive(a) && !hasUserReadNotice(a, currentUser)) ? 1 : 0;
            var ub = (currentUser && isNoticeActive(b) && !hasUserReadNotice(b, currentUser)) ? 1 : 0;
            if (ua !== ub) return ub - ua;
            var ea = a.type === 'urgent' ? 1 : 0;
            var eb = b.type === 'urgent' ? 1 : 0;
            if (ea !== eb) return eb - ea;
            return new Date(b.publishTime || 0) - new Date(a.publishTime || 0);
        });
        return list;
    }

    function refreshGlobalNoticeCenter() {
        try { if (typeof loadNoticeData === 'function' && (!noticeData || !noticeData.length)) loadNoticeData(); } catch (e) {}
        const badge = document.getElementById('globalNoticeBadge');
        const list = document.getElementById('globalNoticePanelList');
        const titleEl = document.getElementById('globalNoticePanelTitle');
        const unread = getMyUnreadNotices();
        const allRaw = noticeData || [];
        const all = getGlobalNoticeList();
        if (badge) {
            badge.textContent = unread.length > 99 ? '99+' : String(unread.length);
            badge.classList.toggle('show', unread.length > 0);
        }
        if (titleEl) {
            titleEl.textContent = unread.length > 0
                ? ('全局通知 · ' + unread.length + ' 条未读')
                : (all.length > 0 ? ('全局通知 · ' + all.length + ' 条') : '全局通知');
        }
        if (list) {
            if (!all.length) {
                var emptyTip = allRaw.length
                    ? '已读通知已清除<br><span style="font-size:12px;color:#94a3b8;">未读会继续提醒；完整列表请点「查看全部」</span>'
                    : '暂无通知';
                list.innerHTML = '<div class="global-notice-empty">' + emptyTip + '<br><button type="button" class="btn btn-secondary" style="padding:6px 12px;font-size:12px;margin-top:10px;" onclick="goToNoticeModule(true)">查看全部通知</button></div>';
            } else {
                list.innerHTML = all.slice(0, 30).map(function (n) {
                    const cfg = NOTICE_TYPE_CONFIG[n.type] || NOTICE_TYPE_CONFIG.notice;
                    const isUnread = currentUser && isNoticeActive(n) && !hasUserReadNotice(n, currentUser);
                    const remind = n.remindAt ? `<span style="color:#c2410c;">催读 ${escHtml(n.remindAt)}</span>` : '';
                    const readTag = isUnread
                        ? '<span style="color:#2563eb;font-weight:700;">未读</span>'
                        : '<span style="color:#94a3b8;">已读</span>';
                    return `<div class="global-notice-item${isUnread ? ' unread' : ''}" onclick="openNoticeFromGlobal(${n.id})" title="点击打开该通知">
                        <div class="title">${isUnread ? '● ' : ''}${cfg.icon} ${escHtml(n.title || '')}</div>
                        <div class="meta"><span>${escHtml(cfg.label)}</span>${readTag}<span>${escHtml(n.publisher || '')}</span><span>${escHtml(n.publishTime || '')}</span>${remind}</div>
                        <div class="loc">📍 公告动态 → 内部通知发布</div>
                    </div>`;
                }).join('') + (all.length > 30
                    ? '<div style="padding:10px 14px;text-align:center;"><button type="button" class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="goToNoticeModule(true)">查看全部 ' + allRaw.length + ' 条通知</button></div>'
                    : '');
            }
        }
        updateHomeNoticeBanner();
        updateNoticeStats();
        try { updateSidebarNoticeBadge(unread.length); } catch (e2) {}
    }

    function updateSidebarNoticeBadge(count) {
        var nav = document.querySelector('.nav-item[onclick*="notice_publish"]');
        if (!nav) return;
        var tip = nav.querySelector('.sidebar-notice-badge');
        if (!tip) {
            tip = document.createElement('span');
            tip.className = 'sidebar-notice-badge';
            tip.style.cssText = 'margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;font-weight:800;display:none;align-items:center;justify-content:center;';
            nav.style.display = 'flex';
            nav.style.alignItems = 'center';
            nav.appendChild(tip);
        }
        tip.textContent = count > 99 ? '99+' : String(count);
        tip.style.display = count > 0 ? 'inline-flex' : 'none';
    }

    function positionGlobalNoticePanel() {
        var bell = document.getElementById('globalNoticeBell');
        var panel = document.getElementById('globalNoticePanel');
        if (!bell || !panel) return;
        var rect = bell.getBoundingClientRect();
        var width = Math.min(380, window.innerWidth - 24);
        var left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12);
        panel.style.top = Math.round(rect.bottom + 8) + 'px';
        panel.style.left = Math.round(left) + 'px';
        panel.style.right = 'auto';
    }

    function goToNoticeModule(showAll) {
        closeGlobalNoticePanel();
        showModule('notice_publish');
        try {
            var statusSel = document.getElementById('noticeStatusFilter');
            // 全局入口默认看全部；仅侧栏未读角标等显式未读入口才筛未读
            if (showAll === false) {
                var unread = getMyUnreadNotices();
                if (unread.length > 0) {
                    if (statusSel) statusSel.value = 'unread';
                    noticeStatFilter = 'unread';
                } else {
                    if (statusSel) statusSel.value = '';
                    noticeStatFilter = '';
                }
            } else {
                if (statusSel) statusSel.value = '';
                noticeStatFilter = '';
            }
            noticePage = 1;
            renderNoticeList();
        } catch (e) {}
    }

    function openNoticeFromGlobal(id) {
        closeGlobalNoticePanel();
        showModule('notice_publish');
        setTimeout(function () {
            try {
                var statusSel = document.getElementById('noticeStatusFilter');
                if (statusSel) statusSel.value = '';
                noticeStatFilter = '';
            } catch (e) {}
            showNoticeDetail(id);
        }, 80);
    }

    function onGlobalNoticeBellClick(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        // 始终展开全局通知中心：展示全部通知（未读优先），红点仅表示未读数
        refreshGlobalNoticeCenter();
        toggleGlobalNoticePanel(event, true);
    }

    function toggleGlobalNoticePanel(event, forceOpen) {
        if (event) event.stopPropagation();
        const panel = document.getElementById('globalNoticePanel');
        if (!panel) return;
        const open = forceOpen === true ? true : (forceOpen === false ? false : !panel.classList.contains('open'));
        panel.classList.toggle('open', open);
        if (open) {
            refreshGlobalNoticeCenter();
            positionGlobalNoticePanel();
        }
    }

    function closeGlobalNoticePanel() {
        const panel = document.getElementById('globalNoticePanel');
        if (panel) panel.classList.remove('open');
    }

    function safeLen(list) {
        return Array.isArray(list) ? list.length : 0;
    }

    var homeDashUi = {
        todoTab: 'all',
        feedTab: 'all',
        memberGroup: 'all',
        memberQuery: '',
        syncing: false,
        lastOverview: null
    };

    var HOME_QUICK_PREF_KEY = 'homeQuickNavPrefs_v1';
    var HOME_SYNC_LOG_KEY = 'homeCloudSyncLogs_v1';

    function getHomeRoleKind() {
        var role = (typeof currentUser !== 'undefined' && currentUser && currentUser.role) ? currentUser.role : '';
        if (role === 'admin' || role === 'leader') return 'mentor';
        if (role === 'visitor') return 'visitor';
        if (role === 'student') return 'student';
        return 'guest';
    }

    function canViewHomeSensitiveStats() {
        var kind = getHomeRoleKind();
        return kind === 'mentor';
    }

    function homeCanAccessModule(moduleId) {
        if (!moduleId) return false;
        if (typeof hasPermission !== 'function') return true;
        var map = {
            member_archive: function () { return hasPermission('团队成员档案（查看全组）') || hasPermission('团队成员档案（仅自己）'); },
            task_management: function () { return true; },
            notice_publish: function () { return true; },
            weekly_report: function () { return hasPermission('团队工作周报（查看全部）') || hasPermission('团队工作周报（提交自己的）'); },
            application_center: function () { return hasPermission('请假与申请（提交自己的）') || hasPermission('请假与申请（本组审批）') || hasPermission('请假与申请（审批/查看全部）'); },
            literature_library: function () { return hasPermission('资源中心（查看）'); },
            dataset_library: function () { return hasPermission('资源中心（查看）'); },
            meeting_management: function () { return getHomeRoleKind() !== 'visitor'; },
            my_achievements: function () { return hasPermission('成果管理（查看）'); },
            patent_management: function () { return hasPermission('成果管理（查看）'); },
            paper_management: function () { return hasPermission('成果管理（查看）'); },
            my_projects: function () { return hasPermission('项目管理（查看）'); },
            longitudinal_project: function () { return hasPermission('项目管理（查看）'); },
            achievements: function () { return true; },
            openai: function () { return hasPermission('智能工具（全部）'); },
            chat: function () { return hasPermission('智能工具（全部）'); },
            news_management: function () { return getHomeRoleKind() !== 'guest'; }
        };
        if (map[moduleId]) {
            try { return !!map[moduleId](); } catch (e) { return true; }
        }
        return true;
    }

    function getHomePatentList() {
        try {
            if (typeof patentMgmtData !== 'undefined' && Array.isArray(patentMgmtData) && patentMgmtData.length) {
                return patentMgmtData;
            }
        } catch (e0) {}
        try {
            if (typeof window !== 'undefined' && Array.isArray(window.patentMgmtData) && window.patentMgmtData.length) {
                return window.patentMgmtData;
            }
        } catch (e1) {}
        try {
            if (typeof patentData !== 'undefined' && Array.isArray(patentData)) return patentData;
        } catch (e) {}
        try {
            var rawMgmt = JSON.parse(localStorage.getItem('patentMgmtData') || 'null');
            if (Array.isArray(rawMgmt) && rawMgmt.length) return rawMgmt;
        } catch (eMgmt) {}
        try {
            var raw = JSON.parse(localStorage.getItem('patentData') || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e2) { return []; }
    }

    function getHomePaperList() {
        try {
            if (typeof paperData !== 'undefined' && Array.isArray(paperData) && paperData.length) return paperData;
        } catch (e) {}
        try {
            if (typeof window !== 'undefined' && Array.isArray(window.paperData) && window.paperData.length) {
                return window.paperData;
            }
        } catch (e1) {}
        try {
            var raw = JSON.parse(localStorage.getItem('paperData') || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e2) { return []; }
    }

    function getHomePatentCount() { return getHomePatentList().length; }
    function getHomePaperCount() { return getHomePaperList().length; }

    function getHomeProjectStats() {
        var lon = (typeof longitudinalData !== 'undefined' && Array.isArray(longitudinalData)) ? longitudinalData : [];
        var hor = (typeof horizontalData !== 'undefined' && Array.isArray(horizontalData)) ? horizontalData : [];
        var sch = (typeof schoolData !== 'undefined' && Array.isArray(schoolData)) ? schoolData : [];
        var all = [].concat(lon, hor, sch);
        var count = all.length;
        var funding = all.reduce(function (sum, d) { return sum + (parseFloat(d && d.funding) || 0); }, 0);
        var used = all.reduce(function (sum, d) {
            return sum + (parseFloat(d && (d.usedFunding || d.spent || d.used)) || 0);
        }, 0);
        var active = all.filter(function (d) {
            var st = String((d && (d.status || d.projectStatus)) || '');
            return !/结题|完成|结束|closed|done/i.test(st);
        }).length;
        return { count: count, funding: funding, used: used, active: active || count, list: all };
    }

    function getHomeActiveMembers() {
        var members = (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData)) ? teamMemberData : [];
        var active = members.filter(function (m) {
            if (!m) return false;
            if (m.category === 'advisor') return true;
            return !(typeof isMemberGraduated === 'function' ? isMemberGraduated(m) : !!m.graduated);
        });
        var graduated = members.filter(function (m) {
            return m && m.category !== 'advisor' && (typeof isMemberGraduated === 'function' ? isMemberGraduated(m) : !!m.graduated);
        });
        return { active: active, graduated: graduated, graduatedCount: graduated.length, total: members.length, all: members };
    }

    function parseHomeDate(val) {
        if (!val) return null;
        var d = new Date(val);
        if (!isNaN(d.getTime())) return d;
        var m = String(val).match(/(\d{4})[-\/.年](\d{1,2})[-\/.月]?(\d{1,2})?/);
        if (m) {
            d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1));
            if (!isNaN(d.getTime())) return d;
        }
        return null;
    }

    function countItemsInMonth(list, dateFields, year, month) {
        var n = 0;
        (list || []).forEach(function (item) {
            if (!item) return;
            for (var i = 0; i < dateFields.length; i++) {
                var d = parseHomeDate(item[dateFields[i]]);
                if (d && d.getFullYear() === year && d.getMonth() === month) { n++; return; }
            }
        });
        return n;
    }

    function formatHomeDelta(curr, prev) {
        var diff = (curr || 0) - (prev || 0);
        if (diff > 0) return { text: '较上月 +' + diff, cls: 'delta' };
        if (diff < 0) return { text: '较上月 ' + diff, cls: 'delta neg' };
        return { text: '较上月持平', cls: 'delta flat' };
    }

    function getUnreadNoticeCount() {
        try {
            if (!currentUser || !Array.isArray(noticeData)) return 0;
            return noticeData.filter(function (n) {
                return n && typeof isNoticeActive === 'function' && isNoticeActive(n)
                    && typeof isNoticeVisibleToUser === 'function' && isNoticeVisibleToUser(n, currentUser)
                    && typeof hasUserReadNotice === 'function' && !hasUserReadNotice(n, currentUser);
            }).length;
        } catch (e) { return 0; }
    }

    function getWeeklySubmitRate() {
        var members = getHomeActiveMembers().active.filter(function (m) { return m && m.category !== 'advisor'; });
        if (!members.length) return { rate: 100, submitted: 0, total: 0 };
        var now = new Date();
        var day = now.getDay() || 7;
        var monday = new Date(now);
        monday.setDate(now.getDate() - day + 1);
        monday.setHours(0, 0, 0, 0);
        var reports = (typeof weeklyReportData !== 'undefined' && Array.isArray(weeklyReportData)) ? weeklyReportData : [];
        var submittedNames = {};
        reports.forEach(function (r) {
            if (!r || !r.owner) return;
            var t = parseHomeDate(r.submitTime || r.weekRange);
            if (t && t >= monday) submittedNames[r.owner] = 1;
        });
        var submitted = members.filter(function (m) { return submittedNames[m.name]; }).length;
        return { rate: Math.round((submitted / members.length) * 100), submitted: submitted, total: members.length };
    }

    function getHomeTodoTasks() {
        var tasks = (typeof taskData !== 'undefined' && Array.isArray(taskData)) ? taskData : [];
        var doneSet = { completed: 1, done: 1, finished: 1, '已完成': 1 };
        return tasks.filter(function (t) {
            if (!t) return false;
            if (doneSet[t.status]) return false;
            if (t.owner && typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData)) {
                var m = teamMemberData.find(function (x) { return x && x.name === t.owner; });
                if (m && typeof isMemberGraduated === 'function' && isMemberGraduated(m)) return false;
            }
            if (!currentUser) return true;
            if (currentUser.role === 'admin' || currentUser.role === 'leader') return true;
            return t.owner === currentUser.realName || t.visibility === 'all' || !t.owner;
        }).sort(function (a, b) {
            var rank = { high: 0, medium: 1, low: 2, urgent: 0 };
            var ra = rank[a.priority] != null ? rank[a.priority] : 3;
            var rb = rank[b.priority] != null ? rank[b.priority] : 3;
            if (ra !== rb) return ra - rb;
            return String(a.deadline || '').localeCompare(String(b.deadline || ''));
        });
    }

    function getHomeUnifiedTodos() {
        var items = [];
        var canReview = typeof canReviewWeeklyReport === 'function' && canReviewWeeklyReport();
        if (canReview) {
            try {
                (weeklyReportData || []).filter(function (r) { return r && r.status === 'pending'; }).forEach(function (r) {
                    items.push({
                        id: 'weekly-' + r.id,
                        category: 'weekly',
                        priority: 'high',
                        title: (r.owner || '成员') + ' 的周报待审批',
                        meta: '周报 · ' + (r.weekRange || r.submitTime || ''),
                        deadline: '',
                        source: '工作周报',
                        publisher: r.owner || '',
                        go: function () { showModule('weekly_report'); setTimeout(function () { if (typeof showWeeklyReportDetail === 'function') showWeeklyReportDetail(r.id); }, 80); },
                        actions: [
                            { label: '通过', cls: 'ok', run: function () { approveWeeklyReport(r.id); renderHomeDashboard(); } },
                            { label: '驳回', cls: 'bad', run: function () { rejectWeeklyReport(r.id); renderHomeDashboard(); } }
                        ]
                    });
                });
            } catch (e1) {}
        }
        try {
            if (typeof getApplicationHomeTodos === 'function') {
                getApplicationHomeTodos().forEach(function (it) { items.push(it); });
            }
        } catch (eAppTodo) {}
        getHomeTodoTasks().forEach(function (t) {
            var pri = (t.priority === 'high' || t.priority === 'urgent') ? 'high' : (t.priority === 'low' ? 'low' : 'medium');
            items.push({
                id: 'task-' + t.id,
                category: 'task',
                priority: pri,
                title: t.title || '未命名任务',
                meta: (t.owner || '未指定') + (t.deadline ? ' · 截止 ' + t.deadline : ''),
                deadline: t.deadline || '',
                source: '任务待办',
                publisher: t.creator || t.owner || '',
                go: function () { showModule('task_management'); },
                actions: (typeof completeTask === 'function') ? [
                    { label: '完成', cls: 'ok', run: function () { completeTask(t.id); renderHomeDashboard(); } }
                ] : []
            });
        });
        try {
            var now = Date.now();
            (meetingData || []).forEach(function (m) {
                if (!m) return;
                var start = parseHomeDate(m.startTime || m.date);
                if (!start) return;
                var diff = start.getTime() - now;
                if (diff < -2 * 3600000 || diff > 7 * 86400000) return;
                items.push({
                    id: 'meeting-' + (m.id || m.title),
                    category: 'meeting',
                    priority: diff < 24 * 3600000 ? 'high' : 'medium',
                    title: m.title || '会议通知',
                    meta: '会议 · ' + (m.startTime || m.date || ''),
                    deadline: m.startTime || m.date || '',
                    source: '会议活动',
                    publisher: m.organizer || '',
                    go: function () { showModule('meeting_management'); },
                    actions: []
                });
            });
        } catch (e2) {}
        items.sort(function (a, b) {
            var rank = { high: 0, medium: 1, low: 2 };
            var ra = rank[a.priority] != null ? rank[a.priority] : 3;
            var rb = rank[b.priority] != null ? rank[b.priority] : 3;
            if (ra !== rb) return ra - rb;
            return String(a.deadline || '').localeCompare(String(b.deadline || ''));
        });
        return items;
    }

    function getHomeFeedItems() {
        var items = [];
        try {
            (noticeData || []).filter(function (n) {
                return n && (!currentUser || isNoticeVisibleToUser(n, currentUser));
            }).forEach(function (n) {
                var unread = currentUser ? !hasUserReadNotice(n, currentUser) : true;
                items.push({
                    kind: 'notice',
                    title: n.title || '通知',
                    meta: (n.publisher || n.author || '系统') + ' · ' + (n.publishTime || ''),
                    time: n.publishTime || '',
                    unread: unread,
                    urgent: n.type === 'urgent' || !!n.pinned,
                    tag: n.type === 'urgent' ? '紧急' : '通知',
                    go: function () { if (typeof openNoticeFromGlobal === 'function') openNoticeFromGlobal(n.id); else showModule('notice_publish'); }
                });
            });
        } catch (e1) {}
        try {
            var newsList = (typeof newsData !== 'undefined' && Array.isArray(newsData))
                ? newsData
                : ((typeof window !== 'undefined' && Array.isArray(window.newsData)) ? window.newsData : []);
            newsList.filter(function (n) {
                return n && (n.status === 'published' || !n.status);
            }).slice(0, 12).forEach(function (n) {
                items.push({
                    kind: 'news',
                    title: n.title || '新闻',
                    meta: (n.author || '编辑') + ' · ' + (n.publishTime || n.date || ''),
                    time: n.publishTime || n.date || '',
                    unread: false,
                    urgent: false,
                    tag: '新闻',
                    go: function () {
                        showModule('news_management');
                        setTimeout(function () {
                            try { if (typeof showNewsDetail === 'function') showNewsDetail(n.id); } catch (e) {}
                        }, 80);
                    }
                });
            });
        } catch (e2) {}
        try {
            (meetingData || []).slice().sort(function (a, b) {
                return String(b.startTime || b.date || '').localeCompare(String(a.startTime || a.date || ''));
            }).slice(0, 6).forEach(function (m) {
                items.push({
                    kind: 'meeting',
                    title: m.title || '组会',
                    meta: '组会 · ' + (m.startTime || m.date || ''),
                    time: m.startTime || m.date || '',
                    unread: false,
                    urgent: false,
                    tag: '会议',
                    go: function () { showModule('meeting_management'); }
                });
            });
        } catch (e3) {}
        try {
            (weeklyReportData || []).slice().sort(function (a, b) {
                return String(b.submitTime || b.weekRange || '').localeCompare(String(a.submitTime || a.weekRange || ''));
            }).slice(0, 6).forEach(function (r) {
                if (r.owner && typeof teamMemberData !== 'undefined') {
                    var m = teamMemberData.find(function (x) { return x && x.name === r.owner; });
                    if (m && typeof isMemberGraduated === 'function' && isMemberGraduated(m)) return;
                }
                items.push({
                    kind: 'achievement',
                    title: (r.owner || '成员') + ' 提交周报',
                    meta: '周报 · ' + (r.weekRange || r.submitTime || ''),
                    time: r.submitTime || r.weekRange || '',
                    unread: false,
                    urgent: false,
                    tag: '成果更新',
                    go: function () { showModule('weekly_report'); }
                });
            });
        } catch (e4) {}
        items.sort(function (a, b) {
            if (!!b.urgent !== !!a.urgent) return b.urgent ? 1 : -1;
            if (!!b.unread !== !!a.unread) return b.unread ? 1 : -1;
            return String(b.time || '').localeCompare(String(a.time || ''));
        });
        return items.slice(0, 20);
    }

    /** 统一聚合：模拟 /dashboard/overview，所有首页数字同源 */
    function getHomeDashboardOverview() {
        var now = new Date();
        var y = now.getFullYear();
        var m = now.getMonth();
        var prevY = m === 0 ? y - 1 : y;
        var prevM = m === 0 ? 11 : m - 1;
        var patents = getHomePatentList();
        var papers = getHomePaperList();
        var projects = getHomeProjectStats();
        var members = getHomeActiveMembers();
        var todos = getHomeUnifiedTodos();
        var taskTodos = todos.filter(function (t) { return t.category === 'task'; });
        var urgentTodos = todos.filter(function (t) { return t.priority === 'high'; });
        var patentCurr = countItemsInMonth(patents, ['applicationDate', 'createTime', 'createdAt', 'date'], y, m);
        var patentPrev = countItemsInMonth(patents, ['applicationDate', 'createTime', 'createdAt', 'date'], prevY, prevM);
        var paperCurr = countItemsInMonth(papers, ['publishDate', 'year', 'createTime', 'createdAt'], y, m);
        var paperPrev = countItemsInMonth(papers, ['publishDate', 'year', 'createTime', 'createdAt'], prevY, prevM);
        var weekly = getWeeklySubmitRate();
        var unread = getUnreadNoticeCount();
        var budgetRate = projects.funding > 0 ? Math.round((projects.used / projects.funding) * 100) : 0;
        if (!projects.used && projects.funding) budgetRate = 0;
        var overview = {
            roleKind: getHomeRoleKind(),
            patents: { total: patents.length, delta: formatHomeDelta(patentCurr, patentPrev), monthAdd: patentCurr },
            papers: { total: papers.length, delta: formatHomeDelta(paperCurr, paperPrev), monthAdd: paperCurr },
            projects: { total: projects.count, active: projects.active, budgetRate: budgetRate, funding: projects.funding, used: projects.used },
            members: members,
            todos: todos,
            taskCount: taskTodos.length,
            urgentTodoCount: urgentTodos.length,
            unreadNotices: unread,
            weekly: weekly,
            feeds: getHomeFeedItems(),
            sync: (typeof window.cloudSyncState !== 'undefined' && window.cloudSyncState) ? window.cloudSyncState : null
        };
        homeDashUi.lastOverview = overview;
        return overview;
    }
    window.getHomeDashboardOverview = getHomeDashboardOverview;

    function animateHomeStatValue(el, targetText) {
        if (!el) return;
        if (el._homeAnimTimer) { clearInterval(el._homeAnimTimer); el._homeAnimTimer = null; }
        var num = parseFloat(String(targetText).replace(/[^\d.-]/g, ''));
        if (isNaN(num) || /[万%]/.test(String(targetText)) || String(targetText) !== String(Math.round(num))) {
            el.textContent = targetText;
            return;
        }
        var start = parseInt(el.textContent, 10);
        if (isNaN(start)) start = 0;
        var end = Math.round(num);
        if (start === end) { el.textContent = String(end); return; }
        var steps = Math.min(20, Math.max(6, Math.abs(end - start)));
        var i = 0;
        el._homeAnimTimer = setInterval(function () {
            i++;
            el.textContent = String(Math.round(start + (end - start) * (i / steps)));
            if (i >= steps) {
                clearInterval(el._homeAnimTimer);
                el._homeAnimTimer = null;
                el.textContent = String(end);
            }
        }, 16);
    }

    function renderHomeRingChart(patentN, paperN, projectN) {
        var svg = document.getElementById('homeRingSvg');
        var legend = document.getElementById('homeRingLegend');
        if (!svg || !legend) return;
        var total = patentN + paperN + projectN;
        var colors = ['#7c3aed', '#6366f1', '#a855f7'];
        var parts = [
            { key: 'patent', label: '专利', value: patentN, color: colors[0] },
            { key: 'paper', label: '论文', value: paperN, color: colors[1] },
            { key: 'project', label: '项目', value: projectN, color: colors[2] }
        ];
        if (!total) {
            svg.innerHTML = '<circle cx="18" cy="18" r="14" fill="none" stroke="#ede9fe" stroke-width="4"></circle>' +
                '<text x="18" y="19.5" text-anchor="middle" font-size="6" fill="#94a3b8">暂无</text>';
            legend.innerHTML = '<div style="font-size:12px;color:#94a3b8;">暂无成果数据</div>';
            return;
        }
        var r = 14, c = 2 * Math.PI * r, offset = 0;
        var arcs = parts.map(function (p) {
            var len = (p.value / total) * c;
            var html = '<circle cx="18" cy="18" r="' + r + '" fill="none" stroke="' + p.color + '" stroke-width="4" ' +
                'stroke-dasharray="' + len + ' ' + (c - len) + '" stroke-dashoffset="' + (-offset) + '" ' +
                'transform="rotate(-90 18 18)" style="cursor:pointer" onclick="homeJumpStat(\'' + p.key + '\')"></circle>';
            offset += len;
            return html;
        }).join('');
        svg.innerHTML = arcs + '<text x="18" y="19.5" text-anchor="middle" font-size="7" font-weight="700" fill="#5b21b6">' + total + '</text>';
        legend.innerHTML = parts.map(function (p) {
            var pct = Math.round((p.value / total) * 100);
            return '<button type="button" onclick="homeJumpStat(\'' + p.key + '\')"><span><span class="dot" style="background:' + p.color + '"></span>' +
                p.label + ' ' + p.value + '</span><strong>' + pct + '%</strong></button>';
        }).join('');
    }

    function homeJumpStat(key) {
        if (key === 'patent') {
            showModule('my_achievements');
            setTimeout(function () { try { if (typeof achSetFilter === 'function') achSetFilter('type', '专利'); } catch (e) {} }, 120);
            return;
        }
        if (key === 'paper') {
            showModule('my_achievements');
            setTimeout(function () { try { if (typeof achSetFilter === 'function') achSetFilter('type', '论文'); } catch (e) {} }, 120);
            return;
        }
        if (key === 'project') { showModule('my_projects'); return; }
        if (key === 'funding') { showModule('achievements'); return; }
        if (key === 'member') { showModule('member_archive'); return; }
        if (key === 'task') { showModule('task_management'); return; }
    }
    window.homeJumpStat = homeJumpStat;

    function getHomeQuickDefaults(roleKind) {
        if (roleKind === 'student') {
            return [
                { module: 'task_management', ico: '任', t: '我的任务', badge: 'task' },
                { module: 'weekly_report', ico: '报', t: '工作周报', badge: 'weekly' },
                { module: 'application_center', ico: '假', t: '请假申请' },
                { module: 'literature_library', ico: '献', t: '文献资料' },
                { module: 'dataset_library', ico: '数', t: '数据集' },
                { module: 'openai', ico: '智', t: '智能工具' }
            ];
        }
        if (roleKind === 'visitor') {
            return [
                { module: 'about', ico: '介', t: '团队介绍' },
                { module: 'achievements', ico: '果', t: '最新成果' },
                { module: 'news_management', ico: '闻', t: '新闻公告' },
                { module: 'members', ico: '员', t: '团队成员' }
            ];
        }
        return [
            { module: 'member_archive', ico: '团', t: '团队成员' },
            { module: 'task_management', ico: '任', t: '任务待办', badge: 'task' },
            { module: 'notice_publish', ico: '通', t: '通知公告', badge: 'notice' },
            { module: 'weekly_report', ico: '报', t: '工作周报', badge: 'weekly' },
            { module: 'application_center', ico: '假', t: '请假审批' },
            { module: 'patent_management', ico: '果', t: '成果管理' }
        ];
    }
    window.getHomeQuickDefaults = getHomeQuickDefaults;

    function loadHomeQuickPrefs(roleKind) {
        try {
            var raw = JSON.parse(localStorage.getItem(HOME_QUICK_PREF_KEY) || '{}');
            if (raw && Array.isArray(raw[roleKind]) && raw[roleKind].length) return raw[roleKind];
        } catch (e) {}
        return getHomeQuickDefaults(roleKind);
    }
    window.loadHomeQuickPrefs = loadHomeQuickPrefs;

    function saveHomeQuickPrefs(roleKind, list) {
        try {
            var raw = {};
            try { raw = JSON.parse(localStorage.getItem(HOME_QUICK_PREF_KEY) || '{}') || {}; } catch (e0) { raw = {}; }
            raw[roleKind] = list;
            localStorage.setItem(HOME_QUICK_PREF_KEY, JSON.stringify(raw));
        } catch (e) {}
    }
    window.saveHomeQuickPrefs = saveHomeQuickPrefs;

    function renderHomeQuickNav(overview) {
        var box = document.getElementById('homeQuickNav');
        if (!box) return;
        var roleKind = overview.roleKind || 'guest';
        var items = loadHomeQuickPrefs(roleKind).filter(function (it) {
            if (it.module === 'about' || it.module === 'members' || it.module === 'achievements') return true;
            return homeCanAccessModule(it.module);
        });
        var badgeMap = {
            task: overview.taskCount || 0,
            notice: overview.unreadNotices || 0,
            weekly: (overview.todos || []).filter(function (t) { return t.category === 'weekly'; }).length
        };
        box.innerHTML = '<span class="home-quick-label">快捷</span>' + items.map(function (it) {
            var badge = it.badge && badgeMap[it.badge] ? '<span class="home-quick-badge">' + badgeMap[it.badge] + '</span>' : '';
            return '<div class="home-quick-item" onclick="showModule(\'' + it.module + '\')">' + badge +
                '<div class="ico">' + escHtml(it.ico || '入') + '</div><div class="t">' + escHtml(it.t) + '</div></div>';
        }).join('');
    }
    window.renderHomeQuickNav = renderHomeQuickNav;

    function renderHomeQuickLaunch(overview) {
        var box = document.getElementById('homeQuickLaunch');
        if (!box) return;
        var kind = overview.roleKind;
        if (kind === 'visitor' || kind === 'guest') {
            box.innerHTML = '';
            return;
        }
        var btns = [];
        if (kind === 'mentor') {
            btns.push({ label: '发布通知', go: "showModule('notice_publish')" });
            btns.push({ label: '新建任务', go: "showModule('task_management')" });
            btns.push({ label: '上传成果', go: "showModule('patent_management')" });
        } else {
            btns.push({ label: '提交周报', go: "showModule('weekly_report')" });
            btns.push({ label: '查看任务', go: "showModule('task_management')" });
            btns.push({ label: '上传成果', go: "homeCanAccessModule('patent_management') && showModule('patent_management')" });
        }
        box.innerHTML = btns.map(function (b) {
            return '<button type="button" onclick="' + b.go + '">' + b.label + '</button>';
        }).join('');
    }

    function dueMetaHtml(deadline) {
        var d = parseHomeDate(deadline);
        if (!d) return { text: '', cls: '' };
        var hours = (d.getTime() - Date.now()) / 3600000;
        if (hours < 0) return { text: '已逾期', cls: 'due-soon' };
        if (hours <= 24) return { text: '距截止不足 24 小时', cls: 'due-soon' };
        return { text: '', cls: '' };
    }

    function setHomeTab(group, value) {
        if (group === 'todo') homeDashUi.todoTab = value;
        if (group === 'feed') homeDashUi.feedTab = value;
        if (group === 'member') homeDashUi.memberGroup = value;
        renderHomeDashboard();
    }
    window.setHomeTab = setHomeTab;

    function onHomeMemberSearch(val) {
        homeDashUi.memberQuery = String(val || '');
        renderHomeDashboardPanelsOnly();
    }
    window.onHomeMemberSearch = onHomeMemberSearch;

    function renderHomeTabs(elId, tabs, active, group) {
        var el = document.getElementById(elId);
        if (!el) return;
        el.innerHTML = tabs.map(function (t) {
            return '<button type="button" class="home-tab' + (t.key === active ? ' active' : '') +
                '" onclick="setHomeTab(\'' + group + '\',\'' + t.key + '\')">' + t.label + '</button>';
        }).join('');
    }

    function appendHomeSyncLog(entry) {
        try {
            var logs = [];
            try { logs = JSON.parse(localStorage.getItem(HOME_SYNC_LOG_KEY) || '[]') || []; } catch (e0) { logs = []; }
            logs.unshift(entry);
            localStorage.setItem(HOME_SYNC_LOG_KEY, JSON.stringify(logs.slice(0, 50)));
        } catch (e) {}
    }
    window.appendHomeSyncLog = appendHomeSyncLog;

    function updateHomeSyncChrome() {
        var st = (typeof window.cloudSyncState !== 'undefined' && window.cloudSyncState) ? window.cloudSyncState : null;
        var enabled = st ? !!st.enabled : (typeof cloudSyncEnabled !== 'undefined' && !!cloudSyncEnabled);
        var syncing = !!homeDashUi.syncing;
        var cls = 'is-warn';
        var label = '同步';
        var sub = enabled ? '点击同步' : '仅本机';
        if (syncing) { cls = 'is-syncing'; label = '同步中'; sub = '拉取云端数据…'; }
        else if (!enabled) { cls = ''; label = '本机'; sub = '未配置云端'; }
        else if (st && st.lastOk === true) {
            cls = 'is-ok';
            label = '已同步';
            var ago = st.lastAt ? Math.max(0, Math.round((Date.now() - st.lastAt) / 1000)) : null;
            sub = ago != null ? (ago + 's 前 · ' + (st.lastApplied || 0) + ' 项') : ('写入 ' + (st.lastApplied || 0) + ' 项');
        } else if (st && st.lastOk === false) {
            cls = 'is-bad';
            label = '同步失败';
            sub = String(st.lastError || st.lastReason || '请重试').slice(0, 28);
        }
        var chip = document.getElementById('navSyncChip');
        var chipText = document.getElementById('navSyncChipText');
        if (chip) chip.className = 'nav-sync-chip ' + cls;
        if (chipText) chipText.textContent = label;
        var fab = document.getElementById('cloudSyncFab');
        var fabLabel = document.getElementById('cloudSyncFabLabel');
        var fabSub = document.getElementById('cloudSyncFabSub');
        if (fab) {
            fab.className = 'cloud-sync-fab ' + cls;
            fab.title = enabled
                ? ('上次同步：' + (st && st.lastAt ? new Date(st.lastAt).toLocaleString('zh-CN') : '尚未同步') + '；点击立即全量同步')
                : '当前未配置云端，数据仅存本机';
        }
        if (fabLabel) fabLabel.textContent = label === '本机' ? '本机模式' : ('云端' + label);
        if (fabSub) fabSub.textContent = sub;
    }
    window.updateHomeSyncChrome = updateHomeSyncChrome;

    function renderHomeDashboardPanelsOnly() {
        var overview = homeDashUi.lastOverview || getHomeDashboardOverview();
        var todos = overview.todos || [];
        var tab = homeDashUi.todoTab || 'all';
        var filteredTodos = todos.filter(function (t) {
            if (tab === 'all') return true;
            return t.category === tab;
        });
        renderHomeTabs('homeTodoTabs', [
            { key: 'all', label: '全部' },
            { key: 'weekly', label: '待审批周报' },
            { key: 'task', label: '待处理任务' },
            { key: 'meeting', label: '会议通知' }
        ], tab, 'todo');
        var todoBox = document.getElementById('homeTodoList');
        if (todoBox) {
            if (!filteredTodos.length) {
                todoBox.innerHTML = '<div class="home-empty">该分类暂无待办</div>';
            } else {
                todoBox.innerHTML = filteredTodos.slice(0, 8).map(function (t, idx) {
                    var priText = t.priority === 'high' ? '紧急' : (t.priority === 'low' ? '低' : '普通');
                    var due = dueMetaHtml(t.deadline);
                    var actions = (t.actions || []).map(function (a, ai) {
                        return '<button type="button" class="' + (a.cls || '') + '" data-todo="' + idx + '" data-act="' + ai + '">' + escHtml(a.label) + '</button>';
                    }).join('');
                    return '<div class="home-todo-item' + (t.priority === 'high' ? ' is-urgent' : '') + '" data-todo-idx="' + idx + '">' +
                        '<span class="pri ' + t.priority + '">' + priText + '</span>' +
                        '<div style="min-width:0;flex:1;">' +
                        '<div class="title">' + escHtml(t.title) + '</div>' +
                        '<div class="meta' + (due.cls ? ' ' + due.cls : '') + '">' + escHtml(t.source + (t.publisher ? ' · ' + t.publisher : '') + (t.meta ? ' · ' + t.meta : '') + (due.text ? ' · ' + due.text : '')) + '</div>' +
                        (actions ? '<div class="home-todo-actions">' + actions + '</div>' : '') +
                        '</div></div>';
                }).join('');
                todoBox.querySelectorAll('.home-todo-item').forEach(function (el) {
                    var idx = Number(el.getAttribute('data-todo-idx'));
                    el.addEventListener('click', function (ev) {
                        if (ev.target && ev.target.closest && ev.target.closest('.home-todo-actions button')) return;
                        try { filteredTodos[idx].go(); } catch (e) {}
                    });
                });
                todoBox.querySelectorAll('.home-todo-actions button').forEach(function (btn) {
                    btn.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        var ti = Number(btn.getAttribute('data-todo'));
                        var ai = Number(btn.getAttribute('data-act'));
                        try { filteredTodos[ti].actions[ai].run(); } catch (e) {}
                    });
                });
            }
        }

        var feedTab = homeDashUi.feedTab || 'all';
        var feeds = (overview.feeds || []).filter(function (f) {
            if (feedTab === 'all') return true;
            if (feedTab === 'notice') return f.kind === 'notice';
            if (feedTab === 'news') return f.kind === 'news';
            if (feedTab === 'achievement') return f.kind === 'achievement' || f.kind === 'weekly';
            return true;
        });
        renderHomeTabs('homeFeedTabs', [
            { key: 'all', label: '全部' },
            { key: 'notice', label: '通知公告' },
            { key: 'news', label: '新闻动态' },
            { key: 'achievement', label: '成果更新' }
        ], feedTab, 'feed');
        var feedBox = document.getElementById('homeFeedList');
        if (feedBox) {
            if (!feeds.length) {
                feedBox.innerHTML = '<div class="home-empty">暂无动态</div>';
            } else {
                feedBox.innerHTML = feeds.slice(0, 10).map(function (f, idx) {
                    return '<div class="home-feed-item' + (f.unread ? '' : ' is-read') + (f.urgent ? ' is-urgent' : '') + '" data-feed-idx="' + idx + '">' +
                        '<span class="home-feed-dot"></span>' +
                        '<div style="min-width:0;flex:1;">' +
                        '<div class="title"><span class="home-feed-tag">' + escHtml(f.tag || '') + '</span>' + escHtml(f.title) + '</div>' +
                        '<div class="meta">' + escHtml(f.meta) + '</div>' +
                        '</div></div>';
                }).join('');
                feedBox.querySelectorAll('.home-feed-item').forEach(function (el, idx) {
                    el.onclick = function () { try { feeds[idx].go(); } catch (e) {} };
                });
            }
        }

        var memberGroup = homeDashUi.memberGroup || 'all';
        var q = String(homeDashUi.memberQuery || '').trim().toLowerCase();
        var pool = [];
        if (memberGroup === 'graduated') pool = overview.members.graduated || [];
        else if (memberGroup === 'advisor') pool = (overview.members.active || []).filter(function (m) { return m.category === 'advisor'; });
        else if (memberGroup === 'phd') pool = (overview.members.active || []).filter(function (m) {
            if (!m || m.category === 'advisor') return false;
            return /博士|phd/i.test(String(m.title || '') + String(m.degree || '') + String(m.education || ''));
        });
        else if (memberGroup === 'master') pool = (overview.members.active || []).filter(function (m) {
            if (!m || m.category === 'advisor') return false;
            var blob = String(m.title || '') + String(m.degree || '') + String(m.education || '');
            if (/博士|phd/i.test(blob) && !/硕士/.test(blob)) return false;
            return /硕士|研究生|\d{4}/.test(blob) || !!m.category;
        });
        else pool = overview.members.active || [];
        if (q) pool = pool.filter(function (m) { return String(m.name || '').toLowerCase().indexOf(q) >= 0; });
        renderHomeTabs('homeMemberTabs', [
            { key: 'all', label: '全部在读' },
            { key: 'advisor', label: '导师' },
            { key: 'phd', label: '博士生' },
            { key: 'master', label: '硕士生' },
            { key: 'graduated', label: '已毕业' }
        ], memberGroup, 'member');
        var memberBox = document.getElementById('homeMemberList');
        if (memberBox) {
            if (!pool.length) {
                memberBox.innerHTML = '<div class="home-empty">暂无匹配成员</div>';
            } else {
                memberBox.innerHTML = pool.slice(0, 12).map(function (m) {
                    var label = (typeof getMemberCategoryLabel === 'function')
                        ? getMemberCategoryLabel(m.category)
                        : (m.category === 'advisor' ? '导师' : (m.category + '级'));
                    var research = m.research || m.direction || m.field || '';
                    var projCount = 0;
                    try {
                        var ps = getHomeProjectStats().list || [];
                        projCount = ps.filter(function (p) {
                            var text = JSON.stringify(p || {});
                            return m.name && text.indexOf(m.name) >= 0;
                        }).length;
                    } catch (eP) {}
                    var badge = memberGroup === 'graduated'
                        ? '<span class="badge off">已毕业</span>'
                        : (m.category === 'advisor' ? '<span class="badge on">导师</span>' : '<span class="badge on">在读</span>');
                    return '<div class="home-member-item" onclick="showModule(\'member_archive\'); setTimeout(function(){ if(typeof showMemberDetail===\'function\') showMemberDetail(' + m.id + '); }, 80);">' +
                        renderHomeMemberAvatarHtml(m) +
                        '<div style="min-width:0;">' +
                        '<div class="name">' + escHtml(m.name || '') + '</div>' +
                        '<div class="tag">' + escHtml(label) + (m.title ? ' · ' + escHtml(m.title) : '') +
                        (research ? ' · ' + escHtml(String(research).slice(0, 18)) : '') +
                        (projCount ? ' · 在研' + projCount : '') + '</div>' +
                        '</div>' + badge + '</div>';
                }).join('');
            }
        }
    }

    function renderHomeDashboard() {
        if (!document.getElementById('home')) return;
        var overview = getHomeDashboardOverview();
        var user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
        var hour = new Date().getHours();
        var hello = hour < 12 ? '上午好' : (hour < 18 ? '下午好' : '晚上好');
        var name = user ? (user.realName || user.studentId || '') : '';
        var roleLabel = user
            ? ((typeof ROLE_LABELS !== 'undefined' && ROLE_LABELS[user.role]) ? ROLE_LABELS[user.role] : (user.role || ''))
            : '';
        var titleEl = document.getElementById('homeWelcomeTitle');
        var subEl = document.getElementById('homeWelcomeSub');
        if (titleEl) titleEl.textContent = name ? (hello + '，' + name) : (hello + '，欢迎回来');
        if (subEl) {
            if (overview.roleKind === 'student') subEl.textContent = '身份：' + roleLabel + ' · 聚焦个人待办、周报与科研工具';
            else if (overview.roleKind === 'visitor') subEl.textContent = '访客视图 · 仅展示公开团队信息';
            else subEl.textContent = name ? ('身份：' + roleLabel + ' · 团队数据大盘与待审批事项') : '登录后可查看与您相关的待办、通知与团队研究动态';
        }

        var heroAv = document.getElementById('homeHeroAvatar');
        if (heroAv) {
            var ch = String(name || '研').charAt(0);
            var avUrl = '';
            try {
                if (typeof resolveMemberAvatarUrl === 'function') {
                    avUrl = resolveMemberAvatarUrl(user) || resolveMemberAvatarUrl({ name: name });
                }
            } catch (eAv) {}
            if (avUrl) heroAv.innerHTML = '<img src="' + String(avUrl).replace(/"/g, '&quot;') + '" alt="' + ch + '">';
            else { heroAv.innerHTML = ''; heroAv.textContent = ch; }
        }

        var today = new Date();
        var dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        var meta = document.getElementById('homeHeroMeta');
        if (meta) {
            meta.innerHTML =
                '<span class="home-chip">今日 <strong>' + dateStr + '</strong></span>' +
                '<span class="home-chip' + (overview.unreadNotices ? ' warn' : '') + '">未读通知 <strong>' + overview.unreadNotices + '</strong></span>' +
                '<span class="home-chip' + (overview.taskCount ? ' warn' : '') + '">今日待办 <strong>' + overview.taskCount + '</strong></span>' +
                '<span class="home-chip">本周周报 <strong>' + overview.weekly.rate + '%</strong></span>';
        }

        renderHomeQuickLaunch(overview);
        renderHomeRingChart(overview.patents.total, overview.papers.total, overview.projects.total);

        var setHint = function (id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
        animateHomeStatValue(document.getElementById('homeStatPatent'), String(overview.patents.total));
        animateHomeStatValue(document.getElementById('homeStatPaper'), String(overview.papers.total));
        animateHomeStatValue(document.getElementById('homeStatProject'), String(overview.projects.active));
        setHint('homeStatPatentHint', overview.patents.delta.text + ' · 本年度筛选');
        setHint('homeStatPaperHint', overview.papers.delta.text);
        setHint('homeStatProjectHint', overview.projects.total + ' 项合计 · 预算使用率 ' + overview.projects.budgetRate + '%');

        var fundingEl = document.getElementById('homeStatFunding');
        var fundingCard = document.querySelector('.home-stat[data-stat="funding"]');
        var memberCard = document.querySelector('.home-stat[data-stat="member"]');
        if (!canViewHomeSensitiveStats()) {
            if (fundingCard) fundingCard.classList.add('is-hidden');
            if (overview.roleKind === 'student' && memberCard) {
                /* 学生仍可见成员概览，但经费隐藏 */
            }
        } else if (fundingCard) fundingCard.classList.remove('is-hidden');

        var fundingWan = overview.projects.funding;
        var fundingText = (Math.round(fundingWan * 10) / 10) + '';
        if (fundingEl) fundingEl.textContent = fundingText;
        setHint('homeStatFundingHint', '总预算 ' + fundingText + ' 万 · 已用 ' + (Math.round(overview.projects.used * 10) / 10));

        animateHomeStatValue(document.getElementById('homeStatMember'), String(overview.members.active.length));
        setHint('homeStatMemberHint', overview.members.active.length + ' 人在读 · ' + overview.members.graduatedCount + ' 人已毕业');
        animateHomeStatValue(document.getElementById('homeStatTask'), String(overview.taskCount));
        setHint('homeStatTaskHint', overview.urgentTodoCount + ' 项紧急 · 含周报/会议');

        if (overview.roleKind === 'visitor') {
            ['patent', 'paper', 'project', 'funding', 'task'].forEach(function (k) {
                var card = document.querySelector('.home-stat[data-stat="' + k + '"]');
                if (card && (k === 'funding' || k === 'task')) card.classList.add('is-hidden');
            });
        }

        renderHomeQuickNav(overview);
        renderHomeDashboardPanelsOnly();
        updateHomeSyncChrome();

        var foot = document.getElementById('homeFootNote');
        if (foot) {
            foot.innerHTML =
                '<span>同源聚合 · 专利 <strong>' + overview.patents.total + '</strong> / 论文 <strong>' + overview.papers.total + '</strong> / 项目 <strong>' + overview.projects.total + '</strong> / 待办 <strong>' + overview.todos.length + '</strong></span>' +
                '<span>本周周报提交率 <strong>' + overview.weekly.rate + '%</strong>（' + overview.weekly.submitted + '/' + overview.weekly.total + '）</span>';
        }

        try { if (typeof updateHomeNoticeBanner === 'function') updateHomeNoticeBanner(); } catch (eB) {}
    }
    window.renderHomeDashboard = renderHomeDashboard;
    window.homeDashUi = homeDashUi;

    async function manualHomeCloudSync() {
        if (typeof syncFromCloudAndRefresh !== 'function') {
            alert('同步模块未就绪');
            return;
        }
        if (homeDashUi.syncing) return;
        homeDashUi.syncing = true;
        updateHomeSyncChrome();
        var lastErr = null;
        var ok = false;
        var applied = 0;
        for (var attempt = 1; attempt <= 3; attempt++) {
            try {
                if (typeof showCloudSyncBanner === 'function') {
                    showCloudSyncBanner(attempt === 1 ? '正在从云端拉取…' : ('同步重试 ' + attempt + '/3…'), false);
                }
                var result = await syncFromCloudAndRefresh({ silent: attempt > 1 });
                applied = (result && (result.applied || result.count)) || (window.cloudSyncState && window.cloudSyncState.lastApplied) || 0;
                ok = true;
                break;
            } catch (e1) {
                lastErr = e1;
                try {
                    if (typeof markCloudSyncState === 'function') {
                        markCloudSyncState({
                            lastAt: Date.now(),
                            lastOk: false,
                            lastError: String(e1 && e1.message || e1),
                            lastReason: 'error'
                        });
                    }
                } catch (e2) {}
                if (attempt < 3) await new Promise(function (r) { setTimeout(r, 600 * attempt); });
            }
        }
        homeDashUi.syncing = false;
        appendHomeSyncLog({
            at: Date.now(),
            ok: ok,
            applied: applied,
            error: ok ? '' : String(lastErr && lastErr.message || lastErr || 'unknown')
        });
        if (!ok) {
            try {
                if (typeof showCloudSyncBanner === 'function') {
                    showCloudSyncBanner('同步失败（已重试 3 次）：' + String(lastErr && lastErr.message || lastErr || '').slice(0, 60), true);
                }
            } catch (e3) {}
            try {
                if (typeof recordOperationLog === 'function') {
                    recordOperationLog('云端同步', '失败', '首页手动同步失败：' + String(lastErr && lastErr.message || lastErr || ''), {}, { success: false }, 0, String(lastErr || ''), 0);
                }
            } catch (e4) {}
        } else {
            try {
                if (typeof recordOperationLog === 'function') {
                    recordOperationLog('云端同步', '成功', '首页手动全量同步成功，写入约 ' + applied + ' 项', { applied: applied }, { success: true }, 1, '', 0);
                }
            } catch (e5) {}
        }
        try { renderHomeDashboard(); } catch (e6) {}
        updateHomeSyncChrome();
    }
    window.manualHomeCloudSync = manualHomeCloudSync;

    function refreshHomeSyncClock() {
        updateHomeSyncChrome();
    }
    setInterval(refreshHomeSyncClock, 1000);

    function updateHomeNoticeBanner() {
        const box = document.getElementById('homeNoticeBanner');
        if (!box) return;
        const candidates = (noticeData || []).filter(function (n) {
            if (!(isNoticeActive(n) && (n.type === 'urgent' || n.pinned))) return false;
            if (currentUser && !isNoticeVisibleToUser(n, currentUser)) return false;
            return true;
        }).sort(function (a, b) {
            const ua = a.type === 'urgent' ? 1 : 0;
            const ub = b.type === 'urgent' ? 1 : 0;
            if (ua !== ub) return ub - ua;
            return new Date(b.publishTime) - new Date(a.publishTime);
        });
        if (!candidates.length) {
            box.classList.remove('show');
            box.innerHTML = '';
            return;
        }
        const n = candidates[0];
        const unread = currentUser ? !hasUserReadNotice(n, currentUser) : false;
        box.classList.add('show');
        box.innerHTML = `<div class="row">
            <div>
                <div class="label">${n.type === 'urgent' ? '紧急通知' : '置顶公告'}${unread ? ' · 未读' : ''}</div>
                <div class="title">${escHtml(n.title || '')}</div>
                <div class="desc">${escHtml(String(n.content || '').slice(0, 90))}${String(n.content || '').length > 90 ? '…' : ''}</div>
            </div>
            <button class="btn" style="padding:8px 14px;font-size:13px;white-space:nowrap;" onclick="openNoticeFromGlobal(${n.id})">查看详情</button>
        </div>`;
    }

    document.addEventListener('click', function (e) {
        const wrap = document.getElementById('globalNoticeWrap');
        const panel = document.getElementById('globalNoticePanel');
        if (!wrap || !panel) return;
        if (!wrap.contains(e.target) && !panel.contains(e.target)) closeGlobalNoticePanel();
    });
    window.addEventListener('resize', function () {
        var panel = document.getElementById('globalNoticePanel');
        if (panel && panel.classList.contains('open')) positionGlobalNoticePanel();
    });
    window.addEventListener('scroll', function () {
        var panel = document.getElementById('globalNoticePanel');
        if (panel && panel.classList.contains('open')) positionGlobalNoticePanel();
    }, true);

    // ===== 会议管理模块 =====
    let meetingData = [];
    let editingMeetingId = null;
    // 新闻动态管理已抽离至 js/news-management.js（见 window.newsData / NewsManagement）

    let meetingPage = 1;
    const MEETING_PAGE_SIZE = 10;

    const MEETING_STATUS_CONFIG = {
        upcoming: { label: '即将开始', color: '#faad14', bgColor: '#fff7e6', icon: '⏰' },
        ongoing: { label: '进行中', color: '#1890ff', bgColor: '#e6f7ff', icon: '🔄' },
        completed: { label: '已结束', color: '#52c41a', bgColor: '#f6ffed', icon: '✅' }
    };

    function initMeetingManagement() {
        loadMeetingData();
        updateMeetingStats();
        renderMeetingList();
    }

    function loadMeetingData() {
        const stored = localStorage.getItem('meetingData');
        if (stored) {
            meetingData = JSON.parse(stored);
            try { if (typeof reconcileCollaborativeDataWithTeamMembers === 'function') reconcileCollaborativeDataWithTeamMembers(); } catch (e) {}
        } else {
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            
            meetingData = [
                { id: 1, title: '项目周例会', location: '会议室A', startTime: tomorrow.toISOString().replace('T', ' ').substring(0, 16), endTime: tomorrow.toISOString().replace('T', ' ').substring(0, 16).replace(':00', ':30'), participants: '张三, 李四, 王五', agenda: '1. 本周工作汇报\n2. 项目进度讨论\n3. 下周工作计划', notes: '', createTime: '2026-07-12 09:00' },
                { id: 2, title: '技术分享会', location: '学术报告厅', startTime: now.toISOString().replace('T', ' ').substring(0, 16), endTime: now.toISOString().replace('T', ' ').substring(0, 16).replace(':00', ':45'), participants: '全体成员', agenda: '深度学习在城市安全中的应用', notes: '', createTime: '2026-07-11 14:30' },
                { id: 3, title: '安全检查会议', location: '会议室B', startTime: yesterday.toISOString().replace('T', ' ').substring(0, 16), endTime: yesterday.toISOString().replace('T', ' ').substring(0, 16).replace(':00', ':30'), participants: '安全负责人, 各课题组组长', agenda: '实验室安全检查结果通报', notes: '', createTime: '2026-07-10 10:00' },
                { id: 4, title: '论文评审会议', location: '会议室A', startTime: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 16), endTime: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 16).replace(':00', ':45'), participants: '导师, 论文作者', agenda: '硕士论文中期评审', notes: '', createTime: '2026-07-09 16:00' },
                { id: 5, title: '迎新座谈会', location: '学术报告厅', startTime: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 16), endTime: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 16).replace(':00', ':30'), participants: '全体成员, 新生', agenda: '欢迎新成员加入', notes: '', createTime: '2026-07-08 11:00' }
            ];
            saveMeetingData();
        }
    }

    function saveMeetingData() {
        localStorage.setItem('meetingData', JSON.stringify(meetingData));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('meetingData', JSON.stringify(meetingData)); } catch (e) {}
    }

    function getMeetingStatus(meeting) {
        const now = new Date();
        const start = new Date(meeting.startTime);
        const end = new Date(meeting.endTime);
        
        if (end < now) return 'completed';
        if (start <= now && end >= now) return 'ongoing';
        return 'upcoming';
    }

    function updateMeetingStats() {
        const total = meetingData.length;
        const upcoming = meetingData.filter(m => getMeetingStatus(m) === 'upcoming').length;
        const ongoing = meetingData.filter(m => getMeetingStatus(m) === 'ongoing').length;
        const completed = meetingData.filter(m => getMeetingStatus(m) === 'completed').length;

        if (document.getElementById('meetingStatTotal')) document.getElementById('meetingStatTotal').textContent = total;
        if (document.getElementById('meetingStatUpcoming')) document.getElementById('meetingStatUpcoming').textContent = upcoming;
        if (document.getElementById('meetingStatOngoing')) document.getElementById('meetingStatOngoing').textContent = ongoing;
        if (document.getElementById('meetingStatCompleted')) document.getElementById('meetingStatCompleted').textContent = completed;
    }

    function getFilteredMeetings() {
        let filtered = [...meetingData];
        
        const search = document.getElementById('meetingSearchInput')?.value?.toLowerCase() || '';
        const status = document.getElementById('meetingStatusFilter')?.value || '';

        if (search) {
            filtered = filtered.filter(m => m.title.toLowerCase().includes(search) || m.location.toLowerCase().includes(search));
        }
        if (status) {
            filtered = filtered.filter(m => getMeetingStatus(m) === status);
        }

        filtered.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        return filtered;
    }

    function renderMeetingList() {
        const container = document.getElementById('meetingList');
        const emptyState = document.getElementById('meetingEmptyState');
        
        if (!container || !emptyState) return;

        const filtered = getFilteredMeetings();
        
        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            renderMeetingPagination([]);
            return;
        }

        emptyState.style.display = 'none';
        
        const start = (meetingPage - 1) * MEETING_PAGE_SIZE;
        const end = start + MEETING_PAGE_SIZE;
        const pageData = filtered.slice(start, end);

        container.innerHTML = '';
        
        pageData.forEach(meeting => {
            const status = MEETING_STATUS_CONFIG[getMeetingStatus(meeting)];
            
            const card = document.createElement('div');
            card.style.cssText = 'background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); cursor: pointer; transition: all 0.2s;';
            card.onmouseenter = () => { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; };
            card.onmouseleave = () => { card.style.transform = ''; card.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)'; };
            
            card.onclick = () => showMeetingDetail(meeting.id);

            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">📅</span>
                        <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;color:${status.color};background:${status.bgColor};">${status.label}</span>
                    </div>
                    <span style="font-size: 12px; color: #888;">创建时间：${meeting.createTime}</span>
                </div>
                <h3 style="font-size: 16px; font-weight: bold; color: #333; margin: 0 0 8px;">${meeting.title}</h3>
                <div style="display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: #666;">
                    <span>📍 ${meeting.location}</span>
                    <span>🕐 ${meeting.startTime} - ${meeting.endTime.substring(11)}</span>
                </div>
                <div style="margin-top: 8px; font-size: 13px; color: #666;">
                    <span style="color: #888;">参会人员：</span>${meeting.participants}
                </div>
            `;
            container.appendChild(card);
        });

        renderMeetingPagination(filtered);
        updateMeetingStats();
    }

    function renderMeetingPagination(filtered) {
        const pagination = document.getElementById('meetingPagination');
        if (!pagination) return;

        const totalPages = Math.ceil(filtered.length / MEETING_PAGE_SIZE);
        
        if (totalPages <= 1) {
            pagination.innerHTML = `<span style="font-size:13px;color:#666;">共 ${filtered.length} 条</span>`;
            return;
        }

        let html = `<span style="font-size:13px;color:#666;">共 ${filtered.length} 条</span>`;
        
        if (meetingPage > 1) {
            html += `<button onclick="setMeetingPage(${meetingPage - 1})" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">上一页</button>`;
        }
        
        for (let i = 1; i <= totalPages; i++) {
            if (i === meetingPage) {
                html += `<button style="padding:4px 12px;border:none;background:#667eea;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;">${i}</button>`;
            } else {
                html += `<button onclick="setMeetingPage(${i})" style="padding:4px 12px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">${i}</button>`;
            }
        }
        
        if (meetingPage < totalPages) {
            html += `<button onclick="setMeetingPage(${meetingPage + 1})" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;">下一页</button>`;
        }
        
        pagination.innerHTML = html;
    }

    function setMeetingPage(page) {
        meetingPage = page;
        renderMeetingList();
    }

    function showAddMeetingModal() {
        editingMeetingId = null;
        document.getElementById('meetingModalTitle').textContent = '新建会议';
        document.getElementById('meetingTitle').value = '';
        document.getElementById('meetingLocation').value = '';
        document.getElementById('meetingStartTime').value = '';
        document.getElementById('meetingEndTime').value = '';
        document.getElementById('meetingParticipants').value = '';
        document.getElementById('meetingAgenda').value = '';
        document.getElementById('meetingNotes').value = '';
        const notifyCb = document.getElementById('meetingNotifyParticipants');
        if (notifyCb) notifyCb.checked = true;
        resetMeetingAgendaFileUI();
        renderMeetingParticipantChips();
        const picker = document.getElementById('meetingParticipantPicker');
        if (picker) { picker.style.display = 'none'; picker.innerHTML = ''; }
        document.getElementById('meetingModal').style.display = 'flex';
    }

    function getMeetingParticipantGroups() {
        const years = (typeof getMemberGradeYears === 'function' ? getMemberGradeYears() : ['2022', '2023', '2024', '2025', '2026']);
        return [{ key: 'advisor', label: '导师' }].concat(years.map(function (y) {
            return { key: y, label: y + '级' };
        }));
    }

    var MEETING_PARTICIPANT_GROUPS = getMeetingParticipantGroups();

    function getTeamMembersForMeeting() {
        try {
            if (typeof teamMemberData !== 'undefined' && Array.isArray(teamMemberData) && teamMemberData.length) {
                return teamMemberData;
            }
        } catch (e0) {}
        try {
            var raw = localStorage.getItem('teamMemberData');
            if (raw) {
                var list = JSON.parse(raw);
                if (Array.isArray(list)) return list;
            }
        } catch (e1) {}
        return [];
    }

    function escMeetingName(s) {
        return window.escapeHtml(s);
    }

    function getMeetingParticipantNameSet() {
        const raw = (document.getElementById('meetingParticipants').value || '').trim();
        if (!raw) return new Set();
        return new Set(raw.split(/[,，、;；\s]+/).map(function (s) { return s.trim(); }).filter(Boolean));
    }

    function syncMeetingParticipantsFromSet(nameSet) {
        const ordered = [];
        const members = getTeamMembersForMeeting();
        getMeetingParticipantGroups().forEach(function (g) {
            members.filter(function (m) { return m.category === g.key && nameSet.has(m.name); })
                .forEach(function (m) { if (ordered.indexOf(m.name) < 0) ordered.push(m.name); });
        });
        nameSet.forEach(function (n) { if (ordered.indexOf(n) < 0) ordered.push(n); });
        document.getElementById('meetingParticipants').value = ordered.join('、');
        renderMeetingParticipantChips();
        const picker = document.getElementById('meetingParticipantPicker');
        if (picker && picker.style.display !== 'none') {
            picker.querySelectorAll('input[data-mp-name]').forEach(function (cb) {
                cb.checked = nameSet.has(cb.getAttribute('data-mp-name'));
            });
            picker.querySelectorAll('input[data-mp-grade]').forEach(function (gcb) {
                const grade = gcb.getAttribute('data-mp-grade');
                const boxes = picker.querySelectorAll('input[data-mp-grade-of="' + grade + '"]');
                const checked = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).length;
                gcb.checked = boxes.length > 0 && checked === boxes.length;
                gcb.indeterminate = checked > 0 && checked < boxes.length;
            });
        }
    }

    function renderMeetingParticipantChips() {
        const box = document.getElementById('meetingParticipantChips');
        if (!box) return;
        const names = Array.from(getMeetingParticipantNameSet());
        if (!names.length) {
            box.innerHTML = '<span style="color:#bbb;font-size:13px;">尚未选择，请点「从团队选择」按年级勾人</span>';
            return;
        }
        box.innerHTML = names.map(function (n) {
            return '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:#ede9fe;color:#5b21b6;border-radius:999px;font-size:12px;">' +
                escMeetingName(n) +
                '<button type="button" data-mp-remove="' + escMeetingName(n).replace(/'/g, '&#39;') + '" onclick="removeMeetingParticipant(this.getAttribute(\'data-mp-remove\'))" style="border:none;background:transparent;color:#7c3aed;cursor:pointer;padding:0 2px;font-size:14px;line-height:1;" title="移除">×</button>' +
                '</span>';
        }).join('') +
            '<span style="margin-left:4px;color:#888;font-size:12px;">共 ' + names.length + ' 人</span>';
    }

    function removeMeetingParticipant(name) {
        const set = getMeetingParticipantNameSet();
        set.delete(name);
        syncMeetingParticipantsFromSet(set);
    }

    function clearMeetingParticipants() {
        syncMeetingParticipantsFromSet(new Set());
    }

    function selectAllMeetingParticipants() {
        const members = getTeamMembersForMeeting();
        const set = new Set(members.map(function (m) { return m.name; }).filter(Boolean));
        syncMeetingParticipantsFromSet(set);
        const picker = document.getElementById('meetingParticipantPicker');
        if (picker && picker.style.display === 'none') toggleMeetingParticipantPicker(true);
    }

    function toggleMeetingParticipantPicker(forceOpen) {
        const picker = document.getElementById('meetingParticipantPicker');
        if (!picker) return;
        const willOpen = forceOpen === true || picker.style.display === 'none';
        if (!willOpen) {
            picker.style.display = 'none';
            return;
        }
        renderMeetingParticipantPicker();
        picker.style.display = 'block';
    }

    function renderMeetingParticipantPicker() {
        const picker = document.getElementById('meetingParticipantPicker');
        if (!picker) return;
        const members = getTeamMembersForMeeting();
        const selected = getMeetingParticipantNameSet();
        if (!members.length) {
            picker.innerHTML = '<div style="padding:16px;color:#999;font-size:13px;">团队成员库为空，请先在「团队管理」维护人员</div>';
            return;
        }
        let html = '<div style="padding:10px 12px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;gap:8px;position:sticky;top:0;background:#fff;z-index:1;">' +
            '<span style="font-size:13px;font-weight:600;color:#333;">按年级选择参会人</span>' +
            '<input type="text" id="meetingParticipantSearch" placeholder="搜索姓名..." oninput="filterMeetingParticipantPicker(this.value)" style="flex:1;max-width:180px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
            '</div>';
        getMeetingParticipantGroups().forEach(function (g) {
            const list = members.filter(function (m) { return m.category === g.key; });
            if (!list.length) return;
            const allChecked = list.every(function (m) { return selected.has(m.name); });
            const someChecked = list.some(function (m) { return selected.has(m.name); });
            html += '<div class="mp-grade-block" data-grade="' + g.key + '" style="border-bottom:1px solid #f5f5f5;">' +
                '<label style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f8fafc;cursor:pointer;user-select:none;">' +
                '<input type="checkbox" data-mp-grade="' + g.key + '"' + (allChecked ? ' checked' : '') +
                (someChecked && !allChecked ? ' data-indeterminate="1"' : '') +
                ' onchange="toggleMeetingGradeParticipants(\'' + g.key + '\', this.checked)" style="width:15px;height:15px;accent-color:#7c3aed;">' +
                '<span style="font-weight:600;font-size:13px;color:#334155;">' + g.label + '</span>' +
                '<span style="font-size:12px;color:#94a3b8;">(' + list.length + '人)</span>' +
                '</label>' +
                '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;padding:6px 12px 12px 36px;">';
            list.forEach(function (m) {
                const checked = selected.has(m.name) ? ' checked' : '';
                const safeName = escMeetingName(m.name);
                html += '<label class="mp-person-item" data-name="' + safeName + '" style="display:inline-flex;align-items:center;gap:5px;font-size:13px;color:#444;cursor:pointer;min-width:88px;">' +
                    '<input type="checkbox" data-mp-name="' + safeName + '" data-mp-grade-of="' + g.key + '"' + checked +
                    ' onchange="toggleMeetingPersonParticipant(this.getAttribute(\'data-mp-name\'), this.checked)" style="width:14px;height:14px;accent-color:#7c3aed;">' +
                    safeName +
                    '</label>';
            });
            html += '</div></div>';
        });
        picker.innerHTML = html;
        picker.querySelectorAll('input[data-indeterminate="1"]').forEach(function (el) { el.indeterminate = true; });
    }

    function filterMeetingParticipantPicker(q) {
        const picker = document.getElementById('meetingParticipantPicker');
        if (!picker) return;
        const kw = String(q || '').trim().toLowerCase();
        picker.querySelectorAll('.mp-person-item').forEach(function (el) {
            const name = (el.getAttribute('data-name') || '').toLowerCase();
            el.style.display = (!kw || name.indexOf(kw) >= 0) ? 'inline-flex' : 'none';
        });
        picker.querySelectorAll('.mp-grade-block').forEach(function (block) {
            const visible = Array.prototype.some.call(block.querySelectorAll('.mp-person-item'), function (el) {
                return el.style.display !== 'none';
            });
            block.style.display = visible ? '' : 'none';
        });
    }

    function toggleMeetingGradeParticipants(grade, checked) {
        const members = getTeamMembersForMeeting();
        const set = getMeetingParticipantNameSet();
        members.filter(function (m) { return m.category === grade; }).forEach(function (m) {
            if (checked) set.add(m.name); else set.delete(m.name);
        });
        syncMeetingParticipantsFromSet(set);
    }

    function toggleMeetingPersonParticipant(name, checked) {
        const set = getMeetingParticipantNameSet();
        if (checked) set.add(name); else set.delete(name);
        syncMeetingParticipantsFromSet(set);
    }

    function resetMeetingAgendaFileUI() {
        const statusEl = document.getElementById('meetingAgendaFileStatus');
        if (statusEl) { statusEl.textContent = ''; statusEl.style.color = '#888'; }
        const fileEl = document.getElementById('meetingAgendaFile');
        if (fileEl) fileEl.value = '';
    }

    // 提取上传文件文本：支持 txt/md/docx/pdf
    async function extractMeetingFileText(file) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (ext === 'txt' || ext === 'md' || ext === 'text' || (file.type || '').indexOf('text/') === 0) {
            return await file.text();
        }
        if (ext === 'docx' || (file.type || '').indexOf('wordprocessingml') >= 0) {
            if (typeof ensureVendor === 'function') await ensureVendor('mammoth');
            if (!window.mammoth) throw new Error('Word 解析库未加载，请刷新页面后重试');
            const arrayBuffer = await file.arrayBuffer();
            const result = await window.mammoth.extractRawText({ arrayBuffer });
            return result.value || '';
        }
        if (ext === 'pdf' || (file.type || '') === 'application/pdf') {
            if (typeof ensureVendor === 'function') await ensureVendor('pdfjs');
            if (!window.pdfjsLib) throw new Error('PDF 解析库未加载，请刷新页面后重试');
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
        throw new Error('仅支持 txt、md、docx、pdf 文件');
    }

    async function handleMeetingAgendaFile(input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        const statusEl = document.getElementById('meetingAgendaFileStatus');
        const setStatus = (msg, color) => { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color || '#888'; } };
        if (file.size > 20 * 1024 * 1024) {
            setStatus('文件过大（上限 20MB）', '#c0392b');
            input.value = '';
            return;
        }
        setStatus('正在识别「' + file.name + '」...', '#7c3aed');
        try {
            let text = await extractMeetingFileText(file);
            var _LF = String.fromCharCode(10);
            text = String(text || '').split(String.fromCharCode(13) + _LF).join(_LF);
            text = text.replace(new RegExp(_LF + '{3,}', 'g'), _LF + _LF).trim();
            if (!text) {
                setStatus('未识别到有效文字（可能是扫描件/图片型 PDF），请手动录入。', '#c0392b');
                input.value = '';
                return;
            }
            const agendaEl = document.getElementById('meetingAgenda');
            const existing = agendaEl.value.trim();
            const header = '【来自文件：' + file.name + '】';
            agendaEl.value = existing ? (existing + '\n\n' + header + '\n' + text) : (header + '\n' + text);
            setStatus('✓ 已识别 ' + text.length + ' 字，可点「AI 整理议程」结构化，或直接编辑。', '#2e7d32');
        } catch (e) {
            setStatus('识别失败：' + (e && e.message ? e.message : e), '#c0392b');
        } finally {
            input.value = '';
        }
    }

    async function aiOrganizeMeetingAgenda() {
        const agendaEl = document.getElementById('meetingAgenda');
        const statusEl = document.getElementById('meetingAgendaFileStatus');
        const btn = document.getElementById('meetingAgendaAiBtn');
        const setStatus = (msg, color) => { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color || '#888'; } };
        const raw = (agendaEl.value || '').trim();
        if (!raw) { setStatus('请先录入或上传议程内容', '#c0392b'); return; }
        const apiKey = (typeof getApiKey === 'function' ? getApiKey() : '') ||
            String(localStorage.getItem('openaiApiKey') || localStorage.getItem('aliyunApiKey') || '').trim();
        if (!apiKey) { setStatus('未配置 AI 密钥，请到「系统设置」填写后重试', '#c0392b'); return; }
        const title = (document.getElementById('meetingTitle').value || '').trim();
        const messages = [
            { role: 'system', content: '你是会议秘书。把用户提供的原始材料整理成清晰的中文会议议程：用有序列表列出议题，每条含议题名称、负责人（若有）、预计时长（若有）。只输出议程正文，不要额外说明。' },
            { role: 'user', content: (title ? ('会议主题：' + title + '\n\n') : '') + '原始材料：\n' + raw.slice(0, 6000) }
        ];
        const payload = { apiKey, model: (document.getElementById('openaiModel') && document.getElementById('openaiModel').value) || 'qwen-plus', messages, temperature: 0.3, max_tokens: 1200 };
        const endpoints = ['/api/aliyun'];
        if (typeof API_PROXY !== 'undefined' && API_PROXY) endpoints.push(String(API_PROXY).replace(/\/$/, '') + '/api/aliyun');
        if (btn) { btn.disabled = true; btn.textContent = '整理中...'; }
        setStatus('AI 正在整理议程...', '#0d9488');
        let lastErr = null;
        try {
            for (let i = 0; i < endpoints.length; i++) {
                try {
                    const resp = await fetch(endpoints[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    const t = await resp.text();
                    if (!resp.ok) { lastErr = new Error('HTTP ' + resp.status + ' ' + t.slice(0, 160)); continue; }
                    const data = JSON.parse(t);
                    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
                    if (content) {
                        agendaEl.value = String(content).trim();
                        setStatus('✓ AI 已整理议程，可继续手动微调。', '#2e7d32');
                        return;
                    }
                    lastErr = new Error('模型无返回');
                } catch (err) { lastErr = err; }
            }
            setStatus('AI 整理失败：' + (lastErr && lastErr.message ? lastErr.message : lastErr), '#c0392b');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '✨ AI 整理议程'; }
        }
    }

    function closeMeetingModal() {
        document.getElementById('meetingModal').style.display = 'none';
    }

    function saveMeeting() {
        const title = document.getElementById('meetingTitle').value.trim();
        const location = document.getElementById('meetingLocation').value.trim();
        const startTime = document.getElementById('meetingStartTime').value;
        const endTime = document.getElementById('meetingEndTime').value;
        const participants = document.getElementById('meetingParticipants').value.trim();
        const agenda = document.getElementById('meetingAgenda').value.trim();
        const notes = document.getElementById('meetingNotes').value.trim();
        const shouldNotify = !!(document.getElementById('meetingNotifyParticipants') && document.getElementById('meetingNotifyParticipants').checked);

        if (!title || !startTime || !endTime) {
            alert('请填写会议主题和时间');
            return;
        }
        if (shouldNotify && !participants) {
            alert('已勾选「通知参会人」，请先选择参会人员，或取消勾选后再创建');
            return;
        }

        let savedMeeting = null;
        if (editingMeetingId) {
            const idx = meetingData.findIndex(m => m.id === editingMeetingId);
            if (idx !== -1) {
                meetingData[idx] = { ...meetingData[idx], title, location, startTime, endTime, participants, agenda, notes };
                savedMeeting = meetingData[idx];
            }
        } else {
            const newId = meetingData.length > 0 ? Math.max(...meetingData.map(m => m.id)) + 1 : 1;
            savedMeeting = {
                id: newId,
                title,
                location,
                startTime,
                endTime,
                participants,
                agenda,
                notes,
                createTime: new Date().toLocaleString('zh-CN')
            };
            meetingData.push(savedMeeting);
        }

        saveMeetingData();
        closeMeetingModal();
        renderMeetingList();

        let notifyMsg = '';
        if (shouldNotify && savedMeeting) {
            const result = notifyMeetingParticipants(savedMeeting);
            if (result && result.ok) {
                notifyMsg = '，已向 ' + result.count + ' 位参会人发送会议通知';
            } else if (result && result.error) {
                notifyMsg = '，但通知发送失败：' + result.error;
            }
        }

        if (typeof showCloudSyncBanner === 'function') {
            showCloudSyncBanner('会议已创建' + notifyMsg, false);
        } else {
            alert('创建成功！' + notifyMsg);
        }

        try {
            if (savedMeeting && typeof offerNewsDraftFromMeeting === 'function') {
                setTimeout(function () { offerNewsDraftFromMeeting(savedMeeting); }, 200);
            }
        } catch (eNews) {}
    }

    /** 向会议所选参会人定向推送会议通知（铃铛可见） */
    function notifyMeetingParticipants(meeting) {
        try {
            if (!meeting) return { ok: false, error: '无会议数据' };
            const names = String(meeting.participants || '')
                .split(/[,，、;；\s]+/)
                .map(function (s) { return s.trim(); })
                .filter(Boolean);
            if (!names.length) return { ok: false, error: '未选择参会人' };

            // 确保 noticeData 已加载
            try {
                if (typeof loadNoticeData === 'function' && (!noticeData || !noticeData.length)) loadNoticeData();
            } catch (eLoad) {}

            const publisher = currentUser ? (currentUser.realName || currentUser.username) : '系统';
            const fmt = function (v) {
                if (!v) return '待定';
                try {
                    const d = new Date(v);
                    if (isNaN(d.getTime())) return String(v).replace('T', ' ');
                    const p = function (n) { return String(n).padStart(2, '0'); };
                    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
                } catch (e) { return String(v); }
            };
            const title = '会议通知：' + (meeting.title || '未命名会议');
            const lines = [
                '您被邀请参加以下会议，请准时出席。',
                '',
                '主题：' + (meeting.title || ''),
                '时间：' + fmt(meeting.startTime) + ' ~ ' + fmt(meeting.endTime),
                '地点：' + (meeting.location || '待定'),
                '参会人：' + names.join('、')
            ];
            if (meeting.agenda) lines.push('', '议程：', meeting.agenda);
            if (meeting.notes) lines.push('', '备注：' + meeting.notes);

            const newId = (noticeData && noticeData.length)
                ? Math.max.apply(null, noticeData.map(function (n) { return Number(n.id) || 0; })) + 1
                : 1;
            const notice = normalizeNoticeRecord({
                id: newId,
                title: title,
                type: 'meeting',
                content: lines.join('\n'),
                startTime: meeting.startTime || '',
                endTime: meeting.endTime || '',
                publishTime: new Date().toLocaleString('zh-CN'),
                publisher: publisher,
                audience: 'custom',
                audienceNames: names,
                pinned: false,
                reads: [],
                meetingId: meeting.id
            });
            noticeData.push(notice);
            saveNoticeData({
                log: {
                    action: '发布',
                    desc: '会议定向通知：' + title,
                    detail: { meetingId: meeting.id, audienceNames: names }
                }
            });
            try { if (typeof refreshGlobalNoticeCenter === 'function') refreshGlobalNoticeCenter(); } catch (e2) {}
            try { if (typeof renderNoticeList === 'function') renderNoticeList(); } catch (e3) {}
            try {
                if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    new Notification(title, { body: '时间：' + fmt(meeting.startTime) + ' · 地点：' + (meeting.location || '待定') });
                }
            } catch (e4) {}
            return { ok: true, count: names.length, noticeId: newId };
        } catch (err) {
            console.error('notifyMeetingParticipants', err);
            return { ok: false, error: (err && err.message) ? err.message : String(err) };
        }
    }

    function showMeetingDetail(id) {
        const meeting = meetingData.find(m => m.id === id);
        if (!meeting) return;
        
        const status = MEETING_STATUS_CONFIG[getMeetingStatus(meeting)];
        
        document.getElementById('meetingDetailContent').innerHTML = `
            <div style="margin-bottom: 24px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                    <span style="font-size: 24px;">📅</span>
                    <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;color:${status.color};background:${status.bgColor};">${status.label}</span>
                </div>
                <h2 style="font-size: 20px; font-weight: bold; color: #333; margin: 0;">${meeting.title}</h2>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px;">
                <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                    <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">📍 会议地点</h4>
                    <p style="margin: 0; color: #666; font-size: 14px;">${meeting.location || '未设置'}</p>
                </div>
                <div style="background: #f8f9fa; padding: 16px; border-radius: 8px;">
                    <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">🕐 会议时间</h4>
                    <p style="margin: 0; color: #666; font-size: 14px;">${meeting.startTime} - ${meeting.endTime}</p>
                </div>
            </div>
            
            <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">👥 参会人员</h4>
                <p style="margin: 0; color: #666; font-size: 14px;">${meeting.participants || '未设置'}</p>
            </div>
            
            <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">📋 会议议程</h4>
                <p style="margin: 0; color: #666; line-height: 1.8; font-size: 14px; white-space: pre-wrap;">${meeting.agenda || '暂无'}</p>
            </div>
            
            ${meeting.notes ? `
            <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
                <h4 style="margin: 0 0 8px; color: #333; font-size: 14px;">备注</h4>
                <p style="margin: 0; color: #666; font-size: 14px;">${meeting.notes}</p>
            </div>
            ` : ''}
            
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
                <button class="btn btn-secondary" onclick="closeMeetingDrawer()">关闭</button>
                <button class="btn" onclick="deleteMeeting(${meeting.id}); closeMeetingDrawer();">删除</button>
            </div>
        `;
        
        document.getElementById('meetingDrawer').style.display = 'block';
        document.getElementById('meetingOverlay').style.display = 'block';
    }

    function closeMeetingDrawer() {
        document.getElementById('meetingDrawer').style.display = 'none';
        document.getElementById('meetingOverlay').style.display = 'none';
    }

    function deleteMeeting(id) {
        if (!confirm('确定要删除该会议吗？')) return;
        
        meetingData = meetingData.filter(m => m.id !== id);
        saveMeetingData();
        renderMeetingList();
        alert('已删除！');
    }

    // ===== 资源管理模块（文献/数据集/报告/文件） =====
    let literatureData = [];
    let datasetData = [];
    let reportData = [];
    let sharedFileData = [];
    let currentFileType = 'all';
    const SHARED_FILE_DB = 'sharedFileBlobDB';
    const SHARED_FILE_STORE = 'blobs';

    function openSharedFileDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(SHARED_FILE_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(SHARED_FILE_STORE)) {
                    db.createObjectStore(SHARED_FILE_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function saveSharedFileBlob(id, file) {
        const db = await openSharedFileDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SHARED_FILE_STORE, 'readwrite');
            tx.objectStore(SHARED_FILE_STORE).put(file, String(id));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    window.saveSharedFileBlob = saveSharedFileBlob;

    async function getSharedFileBlob(id) {
        const db = await openSharedFileDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SHARED_FILE_STORE, 'readonly');
            const req = tx.objectStore(SHARED_FILE_STORE).get(String(id));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function deleteSharedFileBlob(id) {
        const db = await openSharedFileDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SHARED_FILE_STORE, 'readwrite');
            tx.objectStore(SHARED_FILE_STORE).delete(String(id));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    function getFileExt(fileName) {
        const parts = (fileName || '').split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : '';
    }

    function getFileIconByName(fileName) {
        const ext = getFileExt(fileName);
        const map = {
            pdf: '📕', doc: '📄', docx: '📄', txt: '📝', md: '📝', rtf: '📄',
            xls: '📊', xlsx: '📊', csv: '📊', json: '🧾', xml: '🧾',
            ppt: '📑', pptx: '📑', pptm: '📑',
            jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', webp: '🖼️', svg: '🖼️',
            zip: '🗜️', rar: '🗜️', '7z': '🗜️',
            js: '💻', ts: '💻', py: '💻', java: '💻', html: '💻', css: '💻', c: '💻', cpp: '💻', go: '💻'
        };
        return map[ext] || '📁';
    }

    function isImageExt(ext) {
        return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext);
    }

    function isPreviewableTextExt(ext) {
        return ['txt', 'md', 'csv', 'json', 'xml', 'js', 'ts', 'py', 'html', 'css', 'log'].includes(ext);
    }

    function initResourceModules() {
        loadLiteratureData();
        loadDatasetData();
        loadReportData();
        loadFileData();
        try { if (typeof reconcileCollaborativeDataWithTeamMembers === 'function') reconcileCollaborativeDataWithTeamMembers(); } catch (e) {}
        try { if (typeof syncGlobalsForExternalModules === 'function') syncGlobalsForExternalModules(); } catch (e0) {}
        try {
            if (typeof initLiteratureLibrary === 'function') initLiteratureLibrary();
            else renderLiteratureList();
        } catch (e1) { try { renderLiteratureList(); } catch (e2) {} }
        try {
            if (typeof initDatasetLibrary === 'function') initDatasetLibrary();
            else { loadDatasetData(); renderDatasetList(); }
        } catch (eDs) { try { loadDatasetData(); renderDatasetList(); } catch (eDs2) {} }
        try {
            if (typeof initProjectReport === 'function') initProjectReport();
            else { loadReportData(); renderReportList(); }
        } catch (eRp) { try { loadReportData(); renderReportList(); } catch (eRp2) {} }
        renderFileList();
        
        const isVisitor = currentUser && currentUser.role === 'visitor';
        const uploadBtn = document.getElementById('uploadFileBtn');
        if (uploadBtn) {
            uploadBtn.style.display = isVisitor ? 'none' : 'block';
        }

        initDragUpload();
    }

    function initDragUpload() {
        const dropZone = document.getElementById('shared_files');
        if (!dropZone) return;

        const isVisitor = currentUser && currentUser.role === 'visitor';
        if (isVisitor) return;

        let dragCounter = 0;

        dropZone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter++;
            showDragOverlay();
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                hideDragOverlay();
            }
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            hideDragOverlay();

            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                handleDroppedFiles(files);
            }
        });
    }

    function showDragOverlay() {
        let overlay = document.getElementById('dragUploadOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'dragUploadOverlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(124,58,237,0.1);z-index:9999;display:flex;justify-content:center;align-items:center;backdrop-filter:blur(2px);pointer-events:none;';
            overlay.innerHTML = `
                <div style="background:#fff;padding:60px 80px;border-radius:20px;box-shadow:0 20px 60px rgba(124,58,237,0.3);text-align:center;border:3px dashed #7c3aed;">
                    <div style="font-size:80px;margin-bottom:20px;">📥</div>
                    <div style="font-size:24px;font-weight:bold;color:#7c3aed;margin-bottom:8px;">释放文件上传</div>
                    <div style="font-size:14px;color:#999;">支持拖拽文件或文件夹到此处上传</div>
                </div>
            `;
            document.body.appendChild(overlay);
        }
        overlay.style.display = 'flex';
    }

    function hideDragOverlay() {
        const overlay = document.getElementById('dragUploadOverlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    function handleDroppedFiles(files) {
        if (!files || files.length === 0) return;

        const fileList = Array.from(files);
        const hasFolder = fileList.some(f => f.webkitRelativePath && f.webkitRelativePath.includes('/'));

        if (hasFolder || fileList.length > 1) {
            handleDroppedFolder(fileList);
        } else {
            handleDroppedSingleFile(fileList[0]);
        }
    }

    function getFileTypeBySuffix(fileName) {
        const suffix = fileName.split('.').pop().toLowerCase();
        const documentTypes = ['doc', 'docx', 'txt', 'pdf', 'rtf', 'odt', 'md'];
        const datasetTypes = ['csv', 'xlsx', 'xls', 'json', 'xml', 'sql', 'db', 'sqlite'];
        const codeTypes = ['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'html', 'css', 'vue', 'react', 'go', 'rs', 'php', 'rb', 'swift', 'kt'];
        const reportTypes = ['ppt', 'pptx', 'pptm', 'key', 'pages'];
        
        if (documentTypes.includes(suffix)) return 'document';
        if (datasetTypes.includes(suffix)) return 'dataset';
        if (codeTypes.includes(suffix)) return 'code';
        if (reportTypes.includes(suffix)) return 'report';
        return 'other';
    }

    function handleDroppedSingleFile(file) {
        const maxSizeMb = getConfigInt('file.maxSize', 10);
        const allowTypes = getConfig('file.allowTypes', 'jpg,png,pdf,doc,docx,xls,xlsx,zip');
        const suffix = file.name.split('.').pop().toLowerCase();

        if (file.size > maxSizeMb * 1024 * 1024) {
            alert(`文件【${file.name}】大小不能超过 ${maxSizeMb}MB`);
            return;
        }
        if (!allowTypes.split(',').includes(suffix)) {
            alert(`文件【${file.name}】类型不支持，允许：${allowTypes}`);
            return;
        }

        const autoType = getFileTypeBySuffix(file.name);
        showAddFileModal();
        setTimeout(() => {
            const nameInput = document.getElementById('flName');
            const sizeInput = document.getElementById('flSize');
            const typeSelect = document.getElementById('flType');
            if (nameInput) nameInput.value = file.name;
            if (sizeInput) sizeInput.value = formatFileSize(file.size);
            if (typeSelect) typeSelect.value = autoType;

            const fileInput = document.getElementById('flFile');
            if (fileInput) {
                const dt = new DataTransfer();
                dt.items.add(file);
                fileInput.files = dt.files;
            }
        }, 100);
    }

    function handleDroppedFolder(fileList) {
        const maxSizeMb = getConfigInt('file.maxSize', 10);
        const allowTypes = getConfig('file.allowTypes', 'jpg,png,pdf,doc,docx,xls,xlsx,zip');
        const allowList = allowTypes.split(',').map(s => s.trim());

        const validFiles = [];
        const skippedFiles = [];

        fileList.forEach(file => {
            const relPath = file.webkitRelativePath || file.name;
            const suffix = file.name.split('.').pop().toLowerCase();
            if (!allowList.includes(suffix)) {
                skippedFiles.push({ name: relPath, reason: '类型不支持' });
                return;
            }
            if (file.size > maxSizeMb * 1024 * 1024) {
                skippedFiles.push({ name: relPath, reason: `超过${maxSizeMb}MB` });
                return;
            }
            validFiles.push({ file: file, relPath: relPath });
        });

        if (validFiles.length === 0) {
            alert('没有符合条件的文件可上传');
            return;
        }

        selectedFolderFiles = validFiles;
        showAddFileModal();
        setTimeout(() => {
            switchUploadMode('folder');
            const previewEl = document.getElementById('folderPreview');
            const listEl = document.getElementById('folderPreviewList');
            if (validFiles.length > 0 && previewEl && listEl) {
                previewEl.style.display = 'block';
                const totalSize = validFiles.reduce((s, f) => s + f.file.size, 0);
                const folderName = validFiles[0].relPath.split('/')[0];
                let html = `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee;">
                    <strong style="color:#7c3aed;">📁 ${folderName}</strong>
                    <span style="color:#888;margin-left:8px;">共 ${validFiles.length} 个文件，总计 ${formatFileSize(totalSize)}</span>
                </div>`;
                validFiles.slice(0, 30).forEach(f => {
                    const relDisplay = f.relPath.split('/').slice(1).join('/') || f.file.name;
                    html += `<div style="padding:3px 0;display:flex;justify-content:space-between;">
                        <span>📄 ${relDisplay}</span>
                        <span style="color:#999;">${formatFileSize(f.file.size)}</span>
                    </div>`;
                });
                if (validFiles.length > 30) {
                    html += `<div style="padding:3px 0;color:#999;text-align:center;">... 还有 ${validFiles.length - 30} 个文件</div>`;
                }
                if (skippedFiles.length > 0) {
                    html += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #eee;color:#e53935;">⚠️ 跳过 ${skippedFiles.length} 个文件（类型不支持或超大小限制）</div>`;
                }
                listEl.innerHTML = html;
            }
        }, 100);
    }

    function loadLiteratureData() {
        if (typeof loadLiteratureLibraryData === 'function') {
            loadLiteratureLibraryData();
            try { literatureData = window.literatureData || literatureData || []; } catch (e) {}
            return;
        }
        const stored = localStorage.getItem('literatureData');
        if (stored) {
            literatureData = JSON.parse(stored);
        } else {
            literatureData = [
                { id: 1, title: 'Urban Safety Intelligence: A Comprehensive Review', author: 'Zhang, L.', journal: 'IEEE Transactions', year: '2026', tags: '城市安全, 综述', uploader: '张三', uploadTime: '2026-07-12' },
                { id: 2, title: '深度学习在城市安全监控中的应用', author: 'Li, W.', journal: '计算机学报', year: '2026', tags: '深度学习, 监控', uploader: '李四', uploadTime: '2026-07-11' },
                { id: 3, title: '基于AI的城市灾害预警系统研究', author: 'Wang, Q.', journal: '安全与环境学报', year: '2025', tags: 'AI, 灾害预警', uploader: '王五', uploadTime: '2026-07-10' }
            ];
            localStorage.setItem('literatureData', JSON.stringify(literatureData));
        }
        try { window.literatureData = literatureData; } catch (e2) {}
    }

    function loadDatasetData() {
        if (typeof window.loadDatasetLibraryData === 'function') {
            try { window.loadDatasetLibraryData(); return; } catch (e) {}
        }
        const stored = localStorage.getItem('datasetData');
        if (stored) {
            datasetData = JSON.parse(stored);
        } else {
            datasetData = [
                { id: 1, name: '城市安全监测数据集V2', size: '2.5 GB', format: 'CSV/JSON', samples: '1,200,000', tags: '监测数据', uploader: '张三', uploadTime: '2026-07-12' },
                { id: 2, name: '灾害事件标注数据集', size: '800 MB', format: 'JPG/XML', samples: '50,000', tags: '灾害识别', uploader: '李四', uploadTime: '2026-07-11' },
                { id: 3, name: '交通流量预测数据集', size: '1.2 GB', format: 'CSV', samples: '2,000,000', tags: '交通预测', uploader: '赵六', uploadTime: '2026-07-09' }
            ];
            localStorage.setItem('datasetData', JSON.stringify(datasetData));
        }
        try { window.datasetData = datasetData; } catch (e2) {}
    }

    function loadReportData() {
        if (typeof window.loadProjectReportData === 'function') {
            try { window.loadProjectReportData(); return; } catch (e) {}
        }
        const stored = localStorage.getItem('reportData');
        if (stored) {
            reportData = JSON.parse(stored);
        } else {
            reportData = [
                { id: 1, name: '2026年上半年项目进展报告', type: '项目报告', date: '2026-07-01', uploader: '张三', description: '总结上半年项目进展情况' },
                { id: 2, name: '城市安全数智创新平台可行性研究报告', type: '可行性报告', date: '2026-06-15', uploader: '李四', description: '项目可行性分析' },
                { id: 3, name: '年度安全检查报告', type: '安全报告', date: '2026-06-01', uploader: '王五', description: '实验室年度安全检查总结' }
            ];
            localStorage.setItem('reportData', JSON.stringify(reportData));
        }
        try { window.reportData = reportData; } catch (e2) {}
    }

    function loadFileData() {
        const stored = localStorage.getItem('sharedFileData');
        const typeMap = { '文档': 'document', '演示': 'report', '表格': 'other', '图片': 'other', '其他': 'other', 'document': 'document', 'dataset': 'dataset', 'code': 'code', 'report': 'report', 'other': 'other' };
        let needSave = false;
        if (stored) {
            sharedFileData = JSON.parse(stored);
            sharedFileData.forEach(f => {
                if (f.name) {
                    f.type = getFileTypeBySuffix(f.name);
                }

                if (f.downloadCount === undefined) { f.downloadCount = 0; needSave = true; }
                if (f.fileSizeBytes === undefined) {
                    needSave = true;
                    const match = f.size.match(/([\d.]+)\s*(KB|MB|GB)/);
                    if (match) {
                        const num = parseFloat(match[1]);
                        const unit = match[2];
                        if (unit === 'KB') f.fileSizeBytes = Math.round(num * 1024);
                        else if (unit === 'MB') f.fileSizeBytes = Math.round(num * 1024 * 1024);
                        else if (unit === 'GB') f.fileSizeBytes = Math.round(num * 1024 * 1024 * 1024);
                        else f.fileSizeBytes = num;
                    } else {
                        f.fileSizeBytes = 0;
                    }
                }
                if (!f.uploaderId) { f.uploaderId = 0; needSave = true; }
                if (f.type && typeMap[f.type] && f.type !== typeMap[f.type]) { f.type = typeMap[f.type]; needSave = true; }
                else if (!f.type) { f.type = 'other'; needSave = true; }
            });
            if (needSave) {
                localStorage.setItem('sharedFileData', JSON.stringify(sharedFileData));
            }
        } else {
            sharedFileData = [
                { id: 1, name: '团队周报模板.docx', size: '52 KB', fileSizeBytes: 53248, type: 'document', uploader: '张三', uploaderId: 1, uploadTime: '2026-07-12', downloadCount: 15 },
                { id: 2, name: '项目汇报PPT模板.pptx', size: '3.2 MB', fileSizeBytes: 3355443, type: 'report', uploader: '李四', uploaderId: 2, uploadTime: '2026-07-10', downloadCount: 8 },
                { id: 3, name: '城市安全数据集.csv', size: '156 KB', fileSizeBytes: 159744, type: 'dataset', uploader: '王五', uploaderId: 3, uploadTime: '2026-07-08', downloadCount: 22 },
                { id: 4, name: '代码示例.zip', size: '1.2 MB', fileSizeBytes: 1258291, type: 'code', uploader: '赵六', uploaderId: 4, uploadTime: '2026-07-05', downloadCount: 10 }
            ];
            localStorage.setItem('sharedFileData', JSON.stringify(sharedFileData));
        }
    }

    function renderLiteratureList() {
        if (typeof window.renderLiteratureList === 'function' && window.LiteratureLibrary) {
            // LiteratureLibrary 已覆盖同名函数；此处仅作兼容回退
        }
        const container = document.getElementById('literatureList');
        const emptyState = document.getElementById('literatureEmptyState');
        if (!container || !emptyState) return;
        if (window.LiteratureLibrary && typeof window.LiteratureLibrary.renderLiteratureList === 'function') {
            try { syncGlobalsForExternalModules(); } catch (e) {}
            return window.LiteratureLibrary.renderLiteratureList();
        }

        const search = document.getElementById('literatureSearchInput')?.value?.toLowerCase() || '';
        const filtered = literatureData.filter(l => String(l.title||'').toLowerCase().includes(search) || String(l.author||'').toLowerCase().includes(search));

        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }
        emptyState.style.display = 'none';

        container.innerHTML = filtered.map(l => `
            <div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                <h3 style="font-size:16px;font-weight:bold;color:#333;margin:0 0 8px;">${l.title}</h3>
                <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:#666;">
                    <span>👤 ${l.author || ''}</span>
                    <span>📖 ${l.journal || ''}</span>
                    <span>📅 ${l.year || ''}</span>
                </div>
                <div style="margin-top:8px;">
                    ${String(l.tags||'').split(',').filter(Boolean).map(t => `<span style="display:inline-block;padding:2px 8px;background:#f0f5ff;color:#1890ff;border-radius:4px;font-size:12px;margin-right:6px;">${t}</span>`).join('')}
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
                    <span style="font-size:12px;color:#888;">上传者：${l.uploader || ''} | ${l.uploadTime || ''}</span>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-secondary" style="padding:4px 12px;font-size:12px;" onclick="showLibraryLiteratureDetail(${l.id})">查看</button>
                        <button class="btn" style="padding:4px 12px;font-size:12px;" onclick="addLibraryLitToCompare(${l.id})">加入对比</button>
                        <button onclick="deleteLibraryLiterature(${l.id})" style="padding:4px 12px;border:none;background:#fff1f0;color:#ff4d4f;border-radius:4px;cursor:pointer;font-size:12px;">删除</button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    function renderDatasetList() {
        if (window.DatasetLibrary && typeof window.DatasetLibrary.renderDatasetList === 'function') {
            try { if (typeof syncGlobalsForExternalModules === 'function') syncGlobalsForExternalModules(); } catch (e) {}
            return window.DatasetLibrary.renderDatasetList();
        }
        const container = document.getElementById('datasetList');
        const emptyState = document.getElementById('datasetEmptyState');
        if (!container || !emptyState) return;

        const search = document.getElementById('datasetSearchInput')?.value?.toLowerCase() || '';
        const filtered = datasetData.filter(d => String(d.name || '').toLowerCase().includes(search));

        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }
        emptyState.style.display = 'none';

        container.innerHTML = filtered.map(d => `
            <div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                <h3 style="font-size:16px;font-weight:bold;color:#333;margin:0 0 8px;">${d.name}</h3>
                <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:#666;">
                    <span>📦 ${d.size || ''}</span>
                    <span>📋 ${d.format || ''}</span>
                    <span>🔢 ${d.samples || ''} 条记录</span>
                </div>
                <div style="margin-top:8px;">
                    ${String(d.tags || '').split(',').filter(Boolean).map(t => `<span style="display:inline-block;padding:2px 8px;background:#f0f5ff;color:#1890ff;border-radius:4px;font-size:12px;margin-right:6px;">${t}</span>`).join('')}
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
                    <span style="font-size:12px;color:#888;">上传者：${d.uploader || ''} | ${d.uploadTime || ''}</span>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-secondary" style="padding:4px 12px;font-size:12px;" onclick="showDatasetDetail(${d.id})">详情</button>
                        <button class="btn" style="padding:4px 12px;font-size:12px;" onclick="downloadDataset(${d.id})">下载</button>
                        <button onclick="deleteDataset(${d.id})" style="padding:4px 12px;border:none;background:#fff1f0;color:#ff4d4f;border-radius:4px;cursor:pointer;font-size:12px;">删除</button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    function renderReportList() {
        if (window.ProjectReport && typeof window.ProjectReport.renderReportList === 'function') {
            try { if (typeof syncGlobalsForExternalModules === 'function') syncGlobalsForExternalModules(); } catch (e) {}
            return window.ProjectReport.renderReportList();
        }
        const container = document.getElementById('reportList');
        const emptyState = document.getElementById('reportEmptyState');
        if (!container || !emptyState) return;

        const search = document.getElementById('reportSearchInput')?.value?.toLowerCase() || '';
        const filtered = reportData.filter(r => String(r.name || '').toLowerCase().includes(search));

        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }
        emptyState.style.display = 'none';

        container.innerHTML = filtered.map(r => `
            <div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                    <h3 style="font-size:16px;font-weight:bold;color:#333;margin:0;">${r.name}</h3>
                    <span style="display:inline-block;padding:2px 8px;background:#f6ffed;color:#52c41a;border-radius:4px;font-size:12px;">${r.type || ''}</span>
                </div>
                <p style="font-size:14px;color:#666;margin:0 0 12px;">${r.description || ''}</p>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:12px;color:#888;">上传者：${r.uploader || ''} | 日期：${r.date || ''}</span>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-secondary" style="padding:4px 12px;font-size:12px;" onclick="showReportDetail(${r.id})">详情</button>
                        <button class="btn" style="padding:4px 12px;font-size:12px;" onclick="downloadReport(${r.id})">下载</button>
                        <button onclick="deleteReport(${r.id})" style="padding:4px 12px;border:none;background:#fff1f0;color:#ff4d4f;border-radius:4px;cursor:pointer;font-size:12px;">删除</button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    let currentFileView = 'card';
    let fileSearchTimer = null;
    let selectedFileIds = [];
    let currentFilePage = 1;
    const FILE_PAGE_SIZE = 20;

    function filterFilesByType(type, btn) {
        selectedFileIds = [];
        currentFilePage = 1;
        currentFileType = type;
        try {
            window.__sharedRecycleMode = false;
            if (typeof window.exitSharedRecycleMode === 'function') window.exitSharedRecycleMode();
            var recycleBtn = document.getElementById('sharedRecycleBtn');
            if (recycleBtn) recycleBtn.classList.remove('active');
        } catch (e) {}
        document.querySelectorAll('.file-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderFileList();
    }

    function switchFileView(view) {
        currentFileView = view;
        const cardBtn = document.getElementById('viewCardBtn');
        const listBtn = document.getElementById('viewListBtn');
        if (view === 'card') {
            cardBtn.style.background = '#7c3aed';
            cardBtn.style.color = '#fff';
            listBtn.style.background = '#fff';
            listBtn.style.color = '#666';
        } else {
            listBtn.style.background = '#7c3aed';
            listBtn.style.color = '#fff';
            cardBtn.style.background = '#fff';
            cardBtn.style.color = '#666';
        }
        renderFileList();
    }

    function handleFileSearch() {
        if (fileSearchTimer) clearTimeout(fileSearchTimer);
        fileSearchTimer = setTimeout(() => {
            currentFilePage = 1;
            selectedFileIds = [];
            renderFileList();
        }, 200);
    }

    function updateTypeCounts() {
        const counts = { all: sharedFileData.length, document: 0, dataset: 0, code: 0, report: 0, other: 0 };
        sharedFileData.forEach(f => {
            if (counts[f.type] !== undefined) counts[f.type]++;
            else counts.other++;
        });
        const idMap = { all: 'countAll', document: 'countDocument', dataset: 'countDataset', code: 'countCode', report: 'countReport', other: 'countOther' };
        Object.keys(idMap).forEach(key => {
            const el = document.getElementById(idMap[key]);
            if (el) el.textContent = counts[key];
        });
    }

    function getTodayUploadCount() {
        const today = new Date().toLocaleDateString('zh-CN');
        return sharedFileData.filter(f => f.uploadTime === today).length;
    }

    function sortFiles(files, sortBy) {
        const arr = [...files];
        switch (sortBy) {
            case 'time_asc':
                arr.sort((a, b) => new Date(a.uploadTime) - new Date(b.uploadTime));
                break;
            case 'time_desc':
                arr.sort((a, b) => new Date(b.uploadTime) - new Date(a.uploadTime));
                break;
            case 'size_asc':
                arr.sort((a, b) => (a.fileSizeBytes || 0) - (b.fileSizeBytes || 0));
                break;
            case 'size_desc':
                arr.sort((a, b) => (b.fileSizeBytes || 0) - (a.fileSizeBytes || 0));
                break;
            case 'name_asc':
                arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
                break;
            case 'name_desc':
                arr.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
                break;
            default:
                arr.sort((a, b) => b.id - a.id);
        }
        return arr;
    }

    function renderFileList() {
        const container = document.getElementById('sharedFileList');
        const emptyState = document.getElementById('fileEmptyState');
        const batchActionBar = document.getElementById('batchActionBar');
        const pagination = document.getElementById('filePagination');
        if (!container || !emptyState) return;

        document.querySelectorAll('.file-type-btn').forEach((b, i) => {
            const types = ['all', 'document', 'dataset', 'code', 'report', 'other'];
            if (types[i] === currentFileType) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });

        updateStorageStats();
        updateTypeCounts();

        const search = document.getElementById('fileSearchInput')?.value?.toLowerCase() || '';
        let filtered = sharedFileData.filter(f => {
            const inRecycle = !!(typeof window !== 'undefined' && window.__sharedRecycleMode);
            if (inRecycle) return !!f.deletedAt && String(f.name || '').toLowerCase().includes(search);
            return !f.hiddenInLibrary && !f.deletedAt && String(f.name || '').toLowerCase().includes(search);
        });

        if (currentFileType !== 'all') {
            filtered = filtered.filter(f => f.type === currentFileType);
        }

        const sortBy = document.getElementById('fileSortSelect')?.value || 'time_desc';
        filtered = sortFiles(filtered, sortBy);

        if (filtered.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            if (batchActionBar) batchActionBar.style.display = 'none';
            if (pagination) pagination.style.display = 'none';
            if (search) {
                emptyState.querySelector('h3').textContent = '没有找到匹配的文件';
                emptyState.querySelector('p').textContent = `没有找到包含"${document.getElementById('fileSearchInput').value}"的文件`;
            } else {
                emptyState.querySelector('h3').textContent = '暂无共享文件';
                emptyState.querySelector('p').textContent = '点击右上角按钮上传第一个文件，开始团队协作';
            }
            return;
        }
        emptyState.style.display = 'none';

        const totalPages = Math.ceil(filtered.length / FILE_PAGE_SIZE);
        if (currentFilePage > totalPages) currentFilePage = totalPages;
        if (currentFilePage < 1) currentFilePage = 1;
        const startIdx = (currentFilePage - 1) * FILE_PAGE_SIZE;
        const pageData = filtered.slice(startIdx, startIdx + FILE_PAGE_SIZE);

        if (pagination) {
            pagination.style.display = filtered.length > FILE_PAGE_SIZE ? 'flex' : 'none';
            const totalCountEl = document.getElementById('fileTotalCount');
            const currentPageEl = document.getElementById('fileCurrentPage');
            const totalPagesEl = document.getElementById('fileTotalPages');
            const lastPageBtn = document.getElementById('fileLastPageBtn');
            if (totalCountEl) totalCountEl.textContent = filtered.length;
            if (currentPageEl) currentPageEl.textContent = currentFilePage;
            if (totalPagesEl) totalPagesEl.textContent = totalPages;
            if (lastPageBtn) lastPageBtn.setAttribute('onclick', `goToFilePage(${totalPages})`);

            const pageNumbersEl = document.getElementById('filePageNumbers');
            if (pageNumbersEl) {
                let pages = [];
                const maxVisible = 5;
                let start = Math.max(1, currentFilePage - Math.floor(maxVisible / 2));
                let end = Math.min(totalPages, start + maxVisible - 1);
                if (end - start + 1 < maxVisible) {
                    start = Math.max(1, end - maxVisible + 1);
                }
                for (let i = start; i <= end; i++) pages.push(i);
                pageNumbersEl.innerHTML = pages.map(p => `
                    <button onclick="goToFilePage(${p})" style="padding:6px 12px;border:1px solid ${p === currentFilePage ? '#7c3aed' : '#ddd'};background:${p === currentFilePage ? '#7c3aed' : '#fff'};color:${p === currentFilePage ? '#fff' : '#666'};border-radius:6px;cursor:pointer;font-size:13px;min-width:36px;">${p}</button>
                `).join('');
            }
        }

        if (batchActionBar) {
            batchActionBar.style.display = selectedFileIds.length > 0 ? 'flex' : 'none';
            const selectedCountEl = document.getElementById('selectedCount');
            const selectAllEl = document.getElementById('selectAllFiles');
            if (selectedCountEl) selectedCountEl.textContent = selectedFileIds.length;
            if (selectAllEl) {
                const pageIds = pageData.map(f => f.id);
                selectAllEl.checked = pageIds.length > 0 && pageIds.every(id => selectedFileIds.includes(id));
                selectAllEl.indeterminate = pageIds.some(id => selectedFileIds.includes(id)) && !selectAllEl.checked;
            }
        }

        const typeIcons = { 'document': '📄', 'dataset': '📊', 'code': '💻', 'report': '📋', 'other': '📁' };
        const typeLabels = { 'document': '文档', 'dataset': '数据集', 'code': '代码', 'report': '报告', 'other': '其他' };
        const typeColors = { 'document': '#1890ff', 'dataset': '#52c41a', 'code': '#722ed1', 'report': '#fa8c16', 'other': '#8c8c8c' };

        const canDownload = currentUser && currentUser.role !== 'visitor';
        const canDeleteAll = currentUser && currentUser.role === 'admin';

        if (currentFileView === 'card') {
            container.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;">${pageData.map(f => {
                const isOwner = currentUser && f.uploaderId === currentUser.id;
                const canDelete = canDeleteAll || isOwner;
                const icon = getFileIconByName(f.name) || typeIcons[f.type] || '📁';
                const color = typeColors[f.type] || '#8c8c8c';
                const isSelected = selectedFileIds.includes(f.id);

                return `
                <div class="file-card-item" style="background:#fff;border-radius:14px;padding:18px 16px;box-shadow:0 2px 8px rgba(0,0,0,0.06);transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1);position:relative;overflow:hidden;cursor:pointer;border:${isSelected ? '2px solid #7c3aed' : '2px solid transparent'};${isSelected ? 'box-shadow:0 8px 24px rgba(124,58,237,0.15);' : ''}" 
                     onmouseover="this.style.boxShadow='0 12px 28px rgba(124,58,237,0.15)';this.style.transform='translateY(-4px)';this.style.borderColor='${isSelected ? '#7c3aed' : 'rgba(124,58,237,0.3)'}';" 
                     onmouseout="this.style.boxShadow='${isSelected ? '0 8px 24px rgba(124,58,237,0.15)' : '0 2px 8px rgba(0,0,0,0.06)'}';this.style.transform='translateY(0)';this.style.borderColor='${isSelected ? '#7c3aed' : 'transparent'}';"
                     onclick="showFileDetail(${f.id})">
                    <div style="position:absolute;top:12px;left:12px;z-index:10;" onclick="event.stopPropagation()">
                        <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleFileSelection(${f.id}, this)" style="width:20px;height:20px;accent-color:#7c3aed;cursor:pointer;border-radius:4px;">
                    </div>
                    <div style="position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg, ${color}, ${color}88);opacity:${isSelected ? '1' : '0.7'};"></div>
                    <div style="text-align:center;margin:14px 0 14px;padding-top:6px;">
                        <span class="file-card-icon" style="font-size:56px;display:inline-block;transition:transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);filter:${isSelected ? 'drop-shadow(0 4px 12px rgba(124,58,237,0.4))' : 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))'};">${icon}</span>
                    </div>
                    <div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;line-height:1.4;" title="${f.relativePath || f.name}">${f.name}</div>
                    <div style="font-size:12px;color:#999;margin-bottom:12px;text-align:center;">
                        <span style="display:inline-block;padding:3px 10px;background:${color}12;color:${color};border-radius:12px;font-weight:500;font-size:11px;">${typeLabels[f.type] || f.type}</span>
                    </div>
                    <div style="font-size:13px;color:#555;margin-bottom:10px;text-align:center;font-weight:600;">${f.size}</div>
                    <div style="font-size:11px;color:#999;margin-bottom:12px;display:flex;justify-content:space-between;padding:0 6px;line-height:1.5;">
                        <span style="display:flex;align-items:center;gap:3px;"><span>👤</span>${f.uploader}</span>
                        <span style="display:flex;align-items:center;gap:3px;"><span>⬇️</span>${f.downloadCount || 0}</span>
                    </div>
                    <div style="font-size:11px;color:#bbb;text-align:center;padding-top:10px;border-top:1px solid #f0f0f0;display:flex;align-items:center;justify-content:center;gap:4px;">
                        <span>📅</span> ${f.uploadTime}
                    </div>
                </div>
                `;
            }).join('')}</div>`;
        } else {
            container.innerHTML = `<div style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
                <div style="display:grid;grid-template-columns:48px 48px 1fr 100px 100px 120px 120px 160px;gap:12px;padding:14px 24px;background:linear-gradient(180deg, #fafafa, #f7f5fa);border-bottom:1px solid #f0f0f0;font-size:13px;color:#666;font-weight:600;align-items:center;">
                    <span></span>
                    <span></span>
                    <span>文件名</span>
                    <span>大小</span>
                    <span>下载</span>
                    <span>类型</span>
                    <span>上传者</span>
                    <span style="text-align:right;">操作</span>
                </div>
                ${pageData.map((f, idx) => {
                    const isOwner = currentUser && f.uploaderId === currentUser.id;
                    const canDelete = canDeleteAll || isOwner;
                    const icon = getFileIconByName(f.name) || typeIcons[f.type] || '📁';
                    const color = typeColors[f.type] || '#8c8c8c';
                    const isSelected = selectedFileIds.includes(f.id);

                    return `
                    <div class="file-list-row" style="display:grid;grid-template-columns:48px 48px 1fr 100px 100px 120px 120px 160px;gap:12px;padding:14px 24px;align-items:center;border-bottom:${idx === pageData.length - 1 ? 'none' : '1px solid #f5f5f5'};transition:all 0.2s ease;cursor:pointer;background:${isSelected ? 'linear-gradient(90deg, #f5f0ff, #faf7ff)' : 'transparent'};"
                         onmouseover="this.style.background='${isSelected ? 'linear-gradient(90deg, #ede4ff, #f5f0ff)' : 'linear-gradient(90deg, #faf7ff, #fdfcff)'}';"
                         onmouseout="this.style.background='${isSelected ? 'linear-gradient(90deg, #f5f0ff, #faf7ff)' : 'transparent'}';"
                         onclick="showFileDetail(${f.id})">
                        <div onclick="event.stopPropagation()">
                            <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleFileSelection(${f.id}, this)" style="width:18px;height:18px;accent-color:#7c3aed;cursor:pointer;">
                        </div>
                        <span style="font-size:26px;text-align:center;transition:transform 0.2s;" class="file-list-icon">${icon}</span>
                        <div style="font-size:14px;color:#1a1a1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;" title="${f.relativePath || f.name}">${f.name}</div>
                        <span style="font-size:13px;color:#555;font-weight:500;">${f.size}</span>
                        <span style="font-size:13px;color:#888;display:flex;align-items:center;gap:4px;"><span>⬇️</span>${f.downloadCount || 0} 次</span>
                        <span style="font-size:12px;padding:4px 12px;background:${color}12;color:${color};border-radius:12px;display:inline-block;width:fit-content;font-weight:500;">${typeLabels[f.type] || f.type}</span>
                        <span style="font-size:13px;color:#555;">${f.uploader}</span>
                        <div style="display:flex;gap:8px;justify-content:flex-end;" onclick="event.stopPropagation()">
                            ${canDownload ? `<button onclick="handleFileDownload(${f.id})" class="btn btn-secondary" style="padding:6px 14px;font-size:12px;border-radius:8px;font-weight:500;transition:all 0.2s;" onmouseover="this.style.background='#f0e9ff'" onmouseout="this.style.background=''">下载</button>` : ''}
                            ${canDelete ? `<button onclick="deleteSharedFile(${f.id})" style="padding:6px 14px;border:none;background:#fff1f0;color:#ff4d4f;border-radius:8px;cursor:pointer;font-size:12px;font-weight:500;transition:all 0.2s;" onmouseover="this.style.background='#ffccc7'" onmouseout="this.style.background='#fff1f0'">删除</button>` : ''}
                        </div>
                    </div>
                    `;
                }).join('')}
            </div>`;
        }
    }

    function toggleFileSelection(id, checkbox) {
        if (checkbox.checked) {
            if (!selectedFileIds.includes(id)) selectedFileIds.push(id);
        } else {
            selectedFileIds = selectedFileIds.filter(x => x !== id);
        }
        renderFileList();
    }

    function toggleSelectAllFiles(checkbox) {
        const search = document.getElementById('fileSearchInput')?.value?.toLowerCase() || '';
        let filtered = sharedFileData.filter(f => f.name.toLowerCase().includes(search));
        if (currentFileType !== 'all') {
            filtered = filtered.filter(f => f.type === currentFileType);
        }
        const sortBy = document.getElementById('fileSortSelect')?.value || 'time_desc';
        filtered = sortFiles(filtered, sortBy);

        const startIdx = (currentFilePage - 1) * FILE_PAGE_SIZE;
        const pageData = filtered.slice(startIdx, startIdx + FILE_PAGE_SIZE);
        const pageIds = pageData.map(f => f.id);

        if (checkbox.checked) {
            pageIds.forEach(id => {
                if (!selectedFileIds.includes(id)) selectedFileIds.push(id);
            });
        } else {
            selectedFileIds = selectedFileIds.filter(id => !pageIds.includes(id));
        }
        renderFileList();
    }

    function clearFileSelection() {
        selectedFileIds = [];
        renderFileList();
    }

    async function batchDeleteFiles() {
        if (selectedFileIds.length === 0) return;
        if (!confirm(`确定要删除选中的 ${selectedFileIds.length} 个文件吗？此操作不可恢复。`)) return;

        const deletedNames = [];
        for (const id of selectedFileIds) {
            const f = sharedFileData.find(x => x.id === id);
            if (f) deletedNames.push(f.name);
            try { await deleteSharedFileBlob(id); } catch (e) { console.warn(e); }
        }

        sharedFileData = sharedFileData.filter(f => !selectedFileIds.includes(f.id));
        localStorage.setItem('sharedFileData', JSON.stringify(sharedFileData));

        recordOperationLog('资源中心', '批量删除', `批量删除 ${selectedFileIds.length} 个文件：${deletedNames.slice(0, 3).join('、')}${deletedNames.length > 3 ? '...' : ''}`, { fileCount: selectedFileIds.length, fileNames: deletedNames }, { success: true }, 1);

        selectedFileIds = [];
        renderFileList();
    }

    function goToFilePage(page) {
        const search = document.getElementById('fileSearchInput')?.value?.toLowerCase() || '';
        let filtered = sharedFileData.filter(f => f.name.toLowerCase().includes(search));
        if (currentFileType !== 'all') {
            filtered = filtered.filter(f => f.type === currentFileType);
        }
        const totalPages = Math.ceil(filtered.length / FILE_PAGE_SIZE);
        if (page < 1) page = 1;
        if (page > totalPages) page = totalPages;
        currentFilePage = page;
        renderFileList();
    }

    function goToFileLastPage() {
        const search = document.getElementById('fileSearchInput')?.value?.toLowerCase() || '';
        let filtered = sharedFileData.filter(f => f.name.toLowerCase().includes(search));
        if (currentFileType !== 'all') {
            filtered = filtered.filter(f => f.type === currentFileType);
        }
        const totalPages = Math.ceil(filtered.length / FILE_PAGE_SIZE);
        currentFilePage = totalPages;
        renderFileList();
    }

    function showFileDetail(id) {
        const file = sharedFileData.find(f => f.id === id);
        if (!file) return;

        const typeIcons = { 'document': '📄', 'dataset': '📊', 'code': '💻', 'report': '📋', 'other': '📁' };
        const typeLabels = { 'document': '文档', 'dataset': '数据集', 'code': '代码', 'report': '报告', 'other': '其他' };
        const typeColors = { 'document': '#1890ff', 'dataset': '#52c41a', 'code': '#722ed1', 'report': '#fa8c16', 'other': '#8c8c8c' };
        const canDownload = currentUser && currentUser.role !== 'visitor';
        const canDeleteAll = currentUser && currentUser.role === 'admin';
        const isOwner = currentUser && file.uploaderId === currentUser.id;
        const canDelete = canDeleteAll || isOwner;
        const color = typeColors[file.type] || '#8c8c8c';
        const fileExt = file.name.split('.').pop().toLowerCase();
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(fileExt);
        const isPdf = fileExt === 'pdf';

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:3000;display:flex;justify-content:center;align-items:center;backdrop-filter:blur(4px);';
        modal.innerHTML = `
            <div style="background:#fff;border-radius:16px;width:520px;max-height:85vh;overflow:hidden;animation:fadeIn 0.2s ease;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
                <div style="padding:24px 30px;text-align:center;background:linear-gradient(135deg, ${color}12, ${color}05);border-bottom:1px solid #f0f0f0;position:relative;">
                    <button onclick="this.closest('div[style*=fixed]').remove()" style="position:absolute;top:16px;right:16px;width:32px;height:32px;border:none;background:rgba(0,0,0,0.05);border-radius:50%;cursor:pointer;font-size:16px;color:#999;display:flex;align-items:center;justify-content:center;transition:all 0.2s;" onmouseover="this.style.background='rgba(0,0,0,0.1)';this.style.color='#666'" onmouseout="this.style.background='rgba(0,0,0,0.05)';this.style.color='#999'">✕</button>
                    <div id="fileDetailPreview" style="font-size:72px;margin-bottom:12px;filter:drop-shadow(0 4px 12px ${color}30);">${getFileIconByName(file.name) || typeIcons[file.type] || '📁'}</div>
                    <h3 style="font-size:18px;color:#1a1a1a;margin:0 0 10px;word-break:break-all;font-weight:600;line-height:1.4;">${file.name}</h3>
                    <div style="display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;">
                        <span style="display:inline-block;padding:5px 14px;background:${color}15;color:${color};border-radius:20px;font-size:12px;font-weight:500;">${typeLabels[file.type] || file.type}</span>
                        <span style="display:inline-block;padding:5px 14px;background:#f5f5f5;color:#666;border-radius:20px;font-size:12px;font-weight:500;">.${fileExt}</span>
                    </div>
                </div>
                <div style="padding:24px 30px;overflow-y:auto;max-height:calc(85vh - 280px);">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 20px;margin-bottom:20px;">
                        <div style="background:#fafafa;padding:14px 16px;border-radius:10px;">
                            <div style="font-size:12px;color:#999;margin-bottom:6px;display:flex;align-items:center;gap:4px;">📦 文件大小</div>
                            <div style="font-size:16px;font-weight:600;color:#1a1a1a;">${file.size}</div>
                        </div>
                        <div style="background:#fafafa;padding:14px 16px;border-radius:10px;">
                            <div style="font-size:12px;color:#999;margin-bottom:6px;display:flex;align-items:center;gap:4px;">⬇️ 下载次数</div>
                            <div style="font-size:16px;font-weight:600;color:#1a1a1a;">${file.downloadCount || 0} 次</div>
                        </div>
                        <div style="background:#fafafa;padding:14px 16px;border-radius:10px;">
                            <div style="font-size:12px;color:#999;margin-bottom:6px;display:flex;align-items:center;gap:4px;">👤 上传者</div>
                            <div style="font-size:16px;font-weight:600;color:#1a1a1a;">${file.uploader}</div>
                        </div>
                        <div style="background:#fafafa;padding:14px 16px;border-radius:10px;">
                            <div style="font-size:12px;color:#999;margin-bottom:6px;display:flex;align-items:center;gap:4px;">📅 上传时间</div>
                            <div style="font-size:16px;font-weight:600;color:#1a1a1a;">${file.uploadTime}</div>
                        </div>
                    </div>
                    <div style="background:#fafafa;padding:14px 16px;border-radius:10px;margin-bottom:16px;">
                        <div style="font-size:12px;color:#999;margin-bottom:6px;display:flex;align-items:center;gap:4px;">🆔 文件ID</div>
                        <div style="font-size:14px;font-weight:500;color:#666;font-family:monospace;">#${file.id}</div>
                    </div>
                    ${file.relativePath ? `
                    <div style="background:#f0f5ff;padding:14px 16px;border-radius:10px;margin-bottom:16px;border:1px solid #d6e4ff;">
                        <div style="font-size:12px;color:#667eea;margin-bottom:6px;display:flex;align-items:center;gap:4px;">📂 相对路径</div>
                        <div style="font-size:13px;color:#333;word-break:break-all;font-family:'Consolas', 'Monaco', monospace;line-height:1.6;">${file.relativePath}</div>
                    </div>
                    ` : ''}
                    ${file.remark ? `
                    <div style="background:#fffbe6;padding:14px 16px;border-radius:10px;margin-bottom:16px;border:1px solid #ffe58f;">
                        <div style="font-size:12px;color:#d48806;margin-bottom:6px;display:flex;align-items:center;gap:4px;">📝 备注</div>
                        <div style="font-size:13px;color:#664d03;line-height:1.6;">${file.remark}</div>
                    </div>
                    ` : ''}
                </div>
                <div style="padding:16px 30px 24px;border-top:1px solid #f0f0f0;background:#fafafa;">
                    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
                        ${canDownload ? `<button onclick="handleFileDownload(${file.id});this.closest('div[style*=fixed]').remove();" class="btn" style="padding:10px 24px;font-size:14px;border-radius:8px;font-weight:500;">⬇️ 下载文件</button>` : ''}
                        ${canDelete ? `<button onclick="if(confirm('确定删除该文件吗？')){deleteSharedFile(${file.id});this.closest('div[style*=fixed]').remove();}" style="padding:10px 24px;border:none;background:#fff1f0;color:#ff4d4f;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;transition:all 0.2s;" onmouseover="this.style.background='#ffccc7'" onmouseout="this.style.background='#fff1f0'">🗑️ 删除</button>` : ''}
                        <button onclick="this.closest('div[style*=fixed]').remove()" class="btn btn-secondary" style="padding:10px 24px;font-size:14px;border-radius:8px;font-weight:500;">关闭</button>
                    </div>
                </div>
            </div>`;
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        document.body.appendChild(modal);
        loadSharedFilePreview(file, modal);
    }

    async function loadSharedFilePreview(file, modal) {
        const box = modal.querySelector('#fileDetailPreview');
        if (!box || !file.hasBlob) return;
        try {
            const blob = await getSharedFileBlob(file.id);
            if (!blob) return;
            const ext = getFileExt(file.name);
            if (isImageExt(ext)) {
                const url = URL.createObjectURL(blob);
                box.innerHTML = `<img src="${url}" alt="${file.name}" style="max-width:100%;max-height:220px;border-radius:12px;object-fit:contain;box-shadow:0 8px 24px rgba(0,0,0,0.12);">`;
            } else if (ext === 'pdf') {
                const url = URL.createObjectURL(blob);
                box.innerHTML = `<iframe src="${url}" style="width:100%;height:260px;border:none;border-radius:12px;background:#f5f5f5;"></iframe>`;
            } else if (isPreviewableTextExt(ext) && blob.size < 512 * 1024) {
                const textContent = await blob.text();
                const safe = textContent.slice(0, 4000).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                box.innerHTML = `<pre style="text-align:left;max-height:220px;overflow:auto;background:#f7f7fb;border-radius:12px;padding:12px;font-size:12px;line-height:1.5;color:#333;white-space:pre-wrap;word-break:break-word;">${safe}</pre>`;
            }
        } catch (e) {
            console.warn('preview failed', e);
        }
    }

    function updateStorageStats() {
        const totalUsed = sharedFileData.reduce((sum, f) => sum + (f.fileSizeBytes || 0), 0);
        const maxStorage = 10 * 1024 * 1024 * 1024;
        const remaining = Math.max(0, maxStorage - totalUsed);

        const usedEl = document.getElementById('usedStorage');
        const remainingEl = document.getElementById('remainingStorage');
        const countEl = document.getElementById('totalFilesCount');
        const todayEl = document.getElementById('todayUploadCount');
        const progressEl = document.getElementById('storageProgress');
        const percentEl = document.getElementById('storagePercent');

        if (usedEl) usedEl.textContent = formatFileSize(totalUsed);
        if (remainingEl) remainingEl.textContent = formatFileSize(remaining);
        if (countEl) countEl.textContent = sharedFileData.length;
        if (todayEl) todayEl.textContent = getTodayUploadCount();

        const percent = maxStorage > 0 ? Math.round((totalUsed / maxStorage) * 100) : 0;
        if (progressEl) {
            progressEl.style.width = percent + '%';
            progressEl.style.background = percent > 80 ? '#e53935' : (percent > 60 ? '#ffa726' : '#7c3aed');
        }
        if (percentEl) percentEl.textContent = percent + '%';

        const warnThreshold = getConfigInt('backup.warnDiskThreshold', 80);
        if (percent > warnThreshold && document.getElementById('storageStats')) {
            document.getElementById('storageStats').style.border = '2px solid #e53935';
        } else if (document.getElementById('storageStats')) {
            document.getElementById('storageStats').style.border = 'none';
        }
    }

    async function handleFileDownload(id) {
        const file = sharedFileData.find(f => f.id === id);
        if (!file) return;

        try {
            const blob = await getSharedFileBlob(id);
            if (!blob) {
                alert('该文件没有保存完整内容（可能是旧数据）。请重新上传后再下载。');
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            file.downloadCount = (file.downloadCount || 0) + 1;
            localStorage.setItem('sharedFileData', JSON.stringify(sharedFileData));
            renderFileList();
            recordOperationLog('资源中心', '下载', `下载文件：${file.name}`, { fileName: file.name }, { success: true }, 1, '', 0);
        } catch (err) {
            console.error(err);
            alert('下载失败，请重试');
        }
    }

    // 文献资料库添加弹窗（委托给 literature-library.js）
    function showLibraryLiteratureModal(tab) {
        if (typeof window.LiteratureLibrary !== 'undefined' && window.LiteratureLibrary.showLibraryLiteratureModal) {
            return window.LiteratureLibrary.showLibraryLiteratureModal(tab);
        }
        alert('文献资料库模块未加载，请刷新页面');
    }

    function addLiterature(btn) {
        // 兼容旧调用：引导使用新弹窗
        if (btn && btn.closest) {
            const modal = btn.closest('div[style*=fixed]');
            if (modal) modal.remove();
        }
        showLibraryLiteratureModal();
    }

    function deleteLibraryLiterature(id) {
        if (typeof window.LiteratureLibrary !== 'undefined' && window.LiteratureLibrary.deleteLibraryLiterature) {
            return window.LiteratureLibrary.deleteLibraryLiterature(id);
        }
        if (!confirm('确定要删除该文献吗？')) return;
        literatureData = literatureData.filter(l => l.id !== id);
        localStorage.setItem('literatureData', JSON.stringify(literatureData));
        try { window.literatureData = literatureData; } catch (e) {}
        try { if (typeof cloudUpsert === 'function') cloudUpsert('literatureData', JSON.stringify(literatureData)); } catch (e2) {}
        renderLiteratureList();
    }

    // 注意：deleteLiterature 由 literature-compare.js 占用（删对比库条目）
    // 资料库删除请使用 deleteLibraryLiterature

    // 数据集添加弹窗（委托 dataset-library.js；以下为兜底实现）
    function showAddDatasetModal() {
        if (window.DatasetLibrary && typeof window.DatasetLibrary.showAddDatasetModal === 'function') {
            return window.DatasetLibrary.showAddDatasetModal();
        }
        alert('数据集模块未加载，请刷新页面后重试');
    }

    function handleDatasetFileSelect(eventOrInput, modalId) {
        if (window.DatasetLibrary && typeof window.DatasetLibrary.handleDatasetFileSelect === 'function') {
            const input = eventOrInput && eventOrInput.target ? eventOrInput.target : eventOrInput;
            return window.DatasetLibrary.handleDatasetFileSelect(input, modalId);
        }
    }

    function handleDatasetDrop(event, modalId) {
        if (window.DatasetLibrary && typeof window.DatasetLibrary.handleDatasetDrop === 'function') {
            return window.DatasetLibrary.handleDatasetDrop(event, modalId);
        }
    }

    function deleteDataset(id) {
        if (window.DatasetLibrary && typeof window.DatasetLibrary.deleteDataset === 'function') {
            return window.DatasetLibrary.deleteDataset(id);
        }
        if (!confirm('确定要删除该数据集吗？')) return;
        datasetData = datasetData.filter(d => d.id !== id);
        localStorage.setItem('datasetData', JSON.stringify(datasetData));
        renderDatasetList();
    }

    // 报告添加弹窗（委托 project-report.js）
    function showAddReportModal() {
        if (window.ProjectReport && typeof window.ProjectReport.showAddReportModal === 'function') {
            return window.ProjectReport.showAddReportModal();
        }
        alert('报告模块未加载，请刷新页面后重试');
    }

    function deleteReport(id) {
        if (window.ProjectReport && typeof window.ProjectReport.deleteReport === 'function') {
            return window.ProjectReport.deleteReport(id);
        }
        if (!confirm('确定要删除该报告吗？')) return;
        reportData = reportData.filter(r => r.id !== id);
        localStorage.setItem('reportData', JSON.stringify(reportData));
        renderReportList();
    }

    // 文件添加弹窗
    let currentUploadMode = 'single'; // 'single' | 'folder'
    let selectedFolderFiles = []; // 文件夹模式下缓存的文件列表

    function showAddFileModal() {
        const maxSize = getConfigInt('file.maxSize', 10);
        const allowTypes = getConfig('file.allowTypes', 'jpg,png,pdf,doc,docx,xls,xlsx,zip');

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;backdrop-filter:blur(4px);';
        modal.innerHTML = `<div style="background:#fff;padding:28px 32px;border-radius:16px;width:560px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);animation:fadeIn 0.2s ease;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
                <h3 style="margin:0;color:#7c3aed;font-size:20px;font-weight:600;">📤 上传文件</h3>
                <button onclick="this.closest('div[style*=fixed]').remove()" style="width:32px;height:32px;border:none;background:#f5f5f5;border-radius:50%;cursor:pointer;font-size:16px;color:#999;display:flex;align-items:center;justify-content:center;transition:all 0.2s;" onmouseover="this.style.background='#e8e8e8';this.style.color='#666'" onmouseout="this.style.background='#f5f5f5';this.style.color='#999'">✕</button>
            </div>

            <div style="margin-bottom:20px;">
                <label style="display:block;margin-bottom:10px;font-size:14px;color:#333;font-weight:500;">上传模式</label>
                <div style="display:flex;gap:0;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8;background:#fafafa;">
                    <button id="modeBtnSingle" onclick="switchUploadMode('single')" style="flex:1;padding:12px 16px;border:none;background:#7c3aed;color:#fff;font-size:14px;cursor:pointer;font-weight:500;transition:all 0.2s;">📄 单文件上传</button>
                    <button id="modeBtnFolder" onclick="switchUploadMode('folder')" style="flex:1;padding:12px 16px;border:none;background:transparent;color:#666;font-size:14px;cursor:pointer;font-weight:500;transition:all 0.2s;">📁 整个文件夹</button>
                </div>
            </div>

            <div id="singleFileSection">
                <div style="margin-bottom:18px;">
                    <label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">选择文件 <span style="color:#ef4444;">*</span></label>
                    <div style="position:relative;">
                        <input type="file" id="flFile" style="width:100%;padding:12px;border:1px solid #e0e0e0;border-radius:10px;font-size:14px;background:#fafafa;cursor:pointer;transition:all 0.2s;" onchange="handleFileSelect()" onfocus="this.style.borderColor='#7c3aed';this.style.boxShadow='0 0 0 3px rgba(124,58,237,0.1)'" onblur="this.style.borderColor='#e0e0e0';this.style.boxShadow='none'">
                    </div>
                    <div style="font-size:12px;color:#999;margin-top:8px;display:flex;align-items:center;gap:4px;"><span>💡</span>支持 ${allowTypes}，单个文件不超过 ${maxSize}MB</div>
                </div>
                <div style="margin-bottom:18px;">
                    <label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">文件名 <span style="color:#ef4444;">*</span></label>
                    <input type="text" id="flName" style="width:100%;padding:12px;border:1px solid #e0e0e0;border-radius:10px;font-size:14px;transition:all 0.2s;" placeholder="请输入文件名" onfocus="this.style.borderColor='#7c3aed';this.style.boxShadow='0 0 0 3px rgba(124,58,237,0.1)'" onblur="this.style.borderColor='#e0e0e0';this.style.boxShadow='none'">
                </div>
                <div style="margin-bottom:18px;">
                    <label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">文件大小</label>
                    <input type="text" id="flSize" style="width:100%;padding:12px;border:1px solid #e8e8e8;border-radius:10px;font-size:14px;background:#f5f5f5;color:#999;" placeholder="自动检测" readonly>
                </div>
                <div style="margin-bottom:18px;">
                    <label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">文件类型</label>
                    <select id="flType" style="width:100%;padding:12px;border:1px solid #e0e0e0;border-radius:10px;font-size:14px;background:#fff;cursor:pointer;transition:all 0.2s;" onfocus="this.style.borderColor='#7c3aed';this.style.boxShadow='0 0 0 3px rgba(124,58,237,0.1)'" onblur="this.style.borderColor='#e0e0e0';this.style.boxShadow='none'">
                        <option value="document">📄 文档</option>
                        <option value="dataset">📊 数据集</option>
                        <option value="code">💻 代码</option>
                        <option value="report">📋 报告</option>
                        <option value="other">📁 其他</option>
                    </select>
                </div>
            </div>

            <div id="folderFileSection" style="display:none;">
                <div style="margin-bottom:18px;">
                    <label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">选择文件夹 <span style="color:#ef4444;">*</span></label>
                    <input type="file" id="flFolder" webkitdirectory directory multiple style="width:100%;padding:12px;border:1px solid #e0e0e0;border-radius:10px;font-size:14px;background:#fafafa;cursor:pointer;transition:all 0.2s;" onchange="handleFolderSelect()" onfocus="this.style.borderColor='#7c3aed';this.style.boxShadow='0 0 0 3px rgba(124,58,237,0.1)'" onblur="this.style.borderColor='#e0e0e0';this.style.boxShadow='none'">
                    <div style="font-size:12px;color:#999;margin-top:8px;display:flex;align-items:center;gap:4px;"><span>💡</span>选择整个文件夹，将自动递归上传内部所有文件并保留相对路径</div>
                </div>
                <div style="margin-bottom:18px;">
                    <label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">文件类型（统一分类）</label>
                    <select id="flTypeFolder" style="width:100%;padding:12px;border:1px solid #e0e0e0;border-radius:10px;font-size:14px;background:#fff;cursor:pointer;transition:all 0.2s;" onfocus="this.style.borderColor='#7c3aed';this.style.boxShadow='0 0 0 3px rgba(124,58,237,0.1)'" onblur="this.style.borderColor='#e0e0e0';this.style.boxShadow='none'">
                        <option value="dataset">📊 数据集</option>
                        <option value="code">💻 代码</option>
                        <option value="document">📄 文档</option>
                        <option value="report">📋 报告</option>
                        <option value="other">📁 其他</option>
                    </select>
                </div>
                <div id="folderPreview" style="display:none;margin-bottom:18px;">
                    <label style="display:block;margin-bottom:8px;font-size:14px;color:#333;font-weight:500;">文件夹预览</label>
                    <div id="folderPreviewList" style="max-height:220px;overflow-y:auto;border:1px solid #eee;border-radius:10px;padding:12px;font-size:13px;color:#666;background:#fafafa;"></div>
                </div>
            </div>

            <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:24px;padding-top:20px;border-top:1px solid #f0f0f0;">
                <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()" style="padding:10px 24px;font-size:14px;border-radius:10px;font-weight:500;">取消</button>
                <button class="btn" onclick="addFile(this)" style="padding:10px 28px;font-size:14px;border-radius:10px;font-weight:500;">上传</button>
            </div></div>`;
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        document.body.appendChild(modal);
        currentUploadMode = 'single';
        selectedFolderFiles = [];
    }

    function switchUploadMode(mode) {
        currentUploadMode = mode;
        const btnSingle = document.getElementById('modeBtnSingle');
        const btnFolder = document.getElementById('modeBtnFolder');
        const singleSection = document.getElementById('singleFileSection');
        const folderSection = document.getElementById('folderFileSection');

        if (mode === 'single') {
            btnSingle.style.background = '#7c3aed';
            btnSingle.style.color = '#fff';
            btnFolder.style.background = '#fff';
            btnFolder.style.color = '#333';
            singleSection.style.display = 'block';
            folderSection.style.display = 'none';
        } else {
            btnFolder.style.background = '#7c3aed';
            btnFolder.style.color = '#fff';
            btnSingle.style.background = '#fff';
            btnSingle.style.color = '#333';
            singleSection.style.display = 'none';
            folderSection.style.display = 'block';
        }
    }

    function handleFileSelect() {
        const fileInput = document.getElementById('flFile');
        const nameInput = document.getElementById('flName');
        const sizeInput = document.getElementById('flSize');
        const typeSelect = document.getElementById('flType');

        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            nameInput.value = file.name;
            sizeInput.value = formatFileSize(file.size);
            if (typeSelect) {
                typeSelect.value = getFileTypeBySuffix(file.name);
            }
        }
    }

    function handleFolderSelect() {
        const folderInput = document.getElementById('flFolder');
        if (!folderInput.files || folderInput.files.length === 0) return;

        const maxSizeMb = getConfigInt('file.maxSize', 10);
        const allowTypes = getConfig('file.allowTypes', 'jpg,png,pdf,doc,docx,xls,xlsx,zip');
        const allowList = allowTypes.split(',').map(s => s.trim());

        const allFiles = Array.from(folderInput.files);
        const validFiles = [];
        const skippedFiles = [];

        allFiles.forEach(file => {
            const relPath = file.webkitRelativePath || file.name;
            const suffix = file.name.split('.').pop().toLowerCase();
            if (!allowList.includes(suffix)) {
                skippedFiles.push({ name: relPath, reason: '类型不支持' });
                return;
            }
            if (file.size > maxSizeMb * 1024 * 1024) {
                skippedFiles.push({ name: relPath, reason: `超过${maxSizeMb}MB` });
                return;
            }
            validFiles.push({ file: file, relPath: relPath });
        });

        selectedFolderFiles = validFiles;

        const previewEl = document.getElementById('folderPreview');
        const listEl = document.getElementById('folderPreviewList');
        if (validFiles.length > 0) {
            previewEl.style.display = 'block';
            const totalSize = validFiles.reduce((s, f) => s + f.file.size, 0);
            const folderName = validFiles[0].relPath.split('/')[0];
            let html = `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee;">
                <strong style="color:#7c3aed;">📁 ${folderName}</strong>
                <span style="color:#888;margin-left:8px;">共 ${validFiles.length} 个文件，总计 ${formatFileSize(totalSize)}</span>
            </div>`;
            validFiles.slice(0, 30).forEach(f => {
                const relDisplay = f.relPath.split('/').slice(1).join('/') || f.file.name;
                html += `<div style="padding:3px 0;display:flex;justify-content:space-between;">
                    <span>📄 ${relDisplay}</span>
                    <span style="color:#999;">${formatFileSize(f.file.size)}</span>
                </div>`;
            });
            if (validFiles.length > 30) {
                html += `<div style="padding:3px 0;color:#999;text-align:center;">... 还有 ${validFiles.length - 30} 个文件</div>`;
            }
            if (skippedFiles.length > 0) {
                html += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #eee;color:#e53935;">⚠️ 跳过 ${skippedFiles.length} 个文件（类型不支持或超大小限制）</div>`;
            }
            listEl.innerHTML = html;
        } else {
            previewEl.style.display = 'block';
            listEl.innerHTML = `<div style="color:#e53935;text-align:center;padding:20px;">所选文件夹中没有符合条件的文件</div>`;
        }
    }

    async function addFile(btn) {
        if (currentUploadMode === 'folder') {
            await addFolderFiles(btn);
            return;
        }

        const name = document.getElementById('flName').value.trim();
        const size = document.getElementById('flSize').value.trim();
        const fileInput = document.getElementById('flFile');

        if (!name) { alert('请输入文件名'); return; }
        if (!fileInput.files || !fileInput.files[0]) { alert('请选择文件'); return; }

        const file = fileInput.files[0];

        const maxSizeMb = getConfigInt('file.maxSize', 10);
        if (file.size > maxSizeMb * 1024 * 1024) {
            alert(`文件大小不能超过 ${maxSizeMb}MB`);
            return;
        }

        const allowTypes = getConfig('file.allowTypes', 'jpg,png,pdf,doc,docx,xls,xlsx,zip');
        const suffix = getFileExt(file.name);
        if (!allowTypes.split(',').map(s => s.trim()).includes(suffix)) {
            alert(`不支持的文件类型，允许：${allowTypes}`);
            return;
        }

        // 上传啥就是啥：按真实后缀分类，并保存完整文件内容
        const type = getFileTypeBySuffix(name || file.name);
        const newId = sharedFileData.length > 0 ? Math.max(...sharedFileData.map(f => f.id)) + 1 : 1;
        try {
            await saveSharedFileBlob(newId, file);
        } catch (err) {
            console.error(err);
            alert('保存文件内容失败，请重试');
            return;
        }

        sharedFileData.push({
            id: newId,
            name: name || file.name,
            size: size || formatFileSize(file.size),
            fileSizeBytes: file.size,
            type,
            mimeType: file.type || '',
            hasBlob: true,
            uploader: currentUser?.realName || currentUser?.username || '未知',
            uploaderId: currentUser?.id || 0,
            uploadTime: new Date().toLocaleDateString('zh-CN'),
            downloadCount: 0
        });
        localStorage.setItem('sharedFileData', JSON.stringify(sharedFileData));
        btn.closest('div[style*=fixed]').remove();
        currentFileType = 'all';
        renderFileList();

        recordOperationLog('资源中心', '上传', `上传文件：${name || file.name}`, { fileName: name || file.name, fileSize: size || formatFileSize(file.size), fileType: type }, { success: true }, 1, '', 0);
        alert('上传成功！');
    }

    async function addFolderFiles(btn) {
        if (selectedFolderFiles.length === 0) {
            alert('请选择文件夹');
            return;
        }

        let baseId = sharedFileData.length > 0 ? Math.max(...sharedFileData.map(f => f.id)) + 1 : 1;
        const folderName = selectedFolderFiles[0].relPath.split('/')[0];
        let successCount = 0;

        for (const item of selectedFolderFiles) {
            const file = item.file;
            const relPath = item.relPath;
            const fileId = baseId++;
            const type = getFileTypeBySuffix(file.name);
            try {
                await saveSharedFileBlob(fileId, file);
            } catch (err) {
                console.error(err);
                continue;
            }

            sharedFileData.push({
                id: fileId,
                name: file.name,
                relativePath: relPath,
                size: formatFileSize(file.size),
                fileSizeBytes: file.size,
                type,
                mimeType: file.type || '',
                hasBlob: true,
                uploader: currentUser?.realName || currentUser?.username || '未知',
                uploaderId: currentUser?.id || 0,
                uploadTime: new Date().toLocaleDateString('zh-CN'),
                downloadCount: 0
            });
            successCount++;
        }

        localStorage.setItem('sharedFileData', JSON.stringify(sharedFileData));
        btn.closest('div[style*=fixed]').remove();
        currentFileType = 'all';
        renderFileList();

        recordOperationLog('资源中心', '上传', `上传文件夹：${folderName}（${successCount}个文件）`, { folderName: folderName, fileCount: successCount }, { success: true }, 1, '', 0);
        alert(`文件夹上传成功！共上传 ${successCount} 个文件`);
    }

    function deleteLiterature_libraryLegacy(id) {
        deleteLibraryLiterature(id);
    }

    async function deleteSharedFile(id) {
        const file = sharedFileData.find(f => f.id === id);
        if (!file) return;
        
        if (!confirm('确定要删除该文件吗？')) return;
        
        try { await deleteSharedFileBlob(id); } catch (e) { console.warn(e); }
        sharedFileData = sharedFileData.filter(f => f.id !== id);
        localStorage.setItem('sharedFileData', JSON.stringify(sharedFileData));
        renderFileList();
        
        recordOperationLog('资源中心', '删除', `删除文件：${file.name}`, { fileName: file.name }, { success: true }, 1, '', 0);
    }

    // 更新路由钩子
    showModule = function(moduleId) {
        _origShowModule(moduleId);
        if (moduleId === 'account_permission') { renderAccountTable(); renderPermissionMatrix(); }
        if (moduleId === 'role_permission') renderPermissionMatrix();
        if (moduleId === 'task_management') { initTaskManagement(); }
        if (moduleId === 'weekly_report') { initWeeklyReport(); }
        if (moduleId === 'application_center') {
            try { if (typeof initApplicationCenter === 'function') initApplicationCenter(); } catch (eApp) {}
        }
        if (moduleId === 'notice_publish') { initNoticePublish(); }
        if (moduleId === 'home') {
            try { if (typeof refreshGlobalNoticeCenter === 'function') refreshGlobalNoticeCenter(); } catch (e) {}
            try { if (typeof renderHomeDashboard === 'function') renderHomeDashboard(); } catch (e2) {}
            try { if (typeof renderHomeNewsPanel === 'function') renderHomeNewsPanel(); } catch (e3) {}
        }
        if (moduleId === 'meeting_management') { initMeetingManagement(); }
        if (moduleId === 'literature_library' || moduleId === 'dataset_library' || moduleId === 'project_report' || moduleId === 'shared_files') { initResourceModules(); }
        if (moduleId === 'model_training') { initModelTraining(); }
        if (moduleId === 'data_annotation') { initAnnotation(); }
        if (moduleId === 'chat') { initChat(); }
        if (moduleId === 'openai') {
            try { if (typeof loadApiKey === 'function') loadApiKey(); } catch (e) {}
            try { if (typeof updateOpenAIHeroStatus === 'function') updateOpenAIHeroStatus(); } catch (e) {}
            const box = document.getElementById('openaiChatContainer');
            if (box && !box.children.length) {
                try { clearOpenAIChat(); } catch (e) {}
            }
        }
        if (moduleId === 'literature_analysis') {
            initLiteratureAnalysis();
            try { if (typeof syncFromLiteratureLibrary === 'function') syncFromLiteratureLibrary(true); } catch (eSyncLit) {}
        }
        if (moduleId === 'document_analysis') { initDocumentAnalysis(); }
    };

    // 导航历史：作为最外层包装，保证「返回上一级」按访问栈回退（而不是总回首页）
    (function installModuleNavHistoryWrapper() {
        var innerShow = showModule;
        showModule = function (moduleId) {
            if (!moduleId) return;
            if (!document.getElementById(moduleId)) {
                console.warn('[showModule] 模块不存在:', moduleId);
                return;
            }
            if (!moduleNavSkipHistory) {
                var active = document.querySelector('.module.active');
                var fromId = (active && active.id) || currentModuleId || '';
                if (fromId && fromId !== moduleId) {
                    pushModuleHistory(fromId);
                }
            }
            var ret = innerShow(moduleId);
            currentModuleId = moduleId;
            updateModuleBackButton();
            return ret;
        };
        window.showModule = showModule;
        window.goBackModule = goBackModule;
    })();

    // ===== 智能工具模块 =====

    // 模型训练台账（本机 + 远程双环境 + MLOps 自动同步）
    let modelTrainingData = [];
    let modelTrainingFilterStatus = '';
    let modelTrainingFilterEnv = '';
    let mlopsPollTimer = null;
    let mlopsAutoPollEnabled = true;
    let mlopsLastSyncAt = '';

    function getModelOwnerNames() {
        if (typeof getRealTeamOwnerNames === 'function') return getRealTeamOwnerNames();
        return (teamMemberData || []).map(m => m.name).filter(Boolean);
    }

    function pickModelOwner(idx) {
        const owners = getModelOwnerNames();
        if (!owners.length) return (currentUser && currentUser.realName) || '团队成员';
        return owners[idx % owners.length];
    }

    function modelEnvMeta(env) {
        if (env === 'remote') return { text: '远程', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' };
        return { text: '本机', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' };
    }

    function modelStatusMeta(status) {
        if (status === 'completed') return { text: '已完成', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' };
        if (status === 'training') return { text: '训练中', color: '#ea580c', bg: '#fff7ed', border: '#fed7aa' };
        if (status === 'failed') return { text: '失败', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' };
        return { text: '待启动', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0' };
    }

    function toggleMlopsPanel() {
        const el = document.getElementById('mlopsPanel');
        if (!el) return;
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
        const ep = document.getElementById('mlopsEndpointText');
        if (ep) ep.textContent = (location.origin || 'http://127.0.0.1:8000') + '/api/mlops/report';
        const tokenHint = document.getElementById('mlopsTokenHint');
        if (tokenHint) tokenHint.textContent = getAppConfig('MLOPS_TOKEN', '') ? '已配置（不展示）' : '未配置';
    }

    function setMlopsAutoPoll(on) {
        mlopsAutoPollEnabled = !!on;
        localStorage.setItem('mlopsAutoPoll', mlopsAutoPollEnabled ? '1' : '0');
        if (mlopsAutoPollEnabled) startMlopsPolling();
        else stopMlopsPolling();
    }

    function startMlopsPolling() {
        stopMlopsPolling();
        if (!mlopsAutoPollEnabled) return;
        pullMlopsJobs(false);
        mlopsPollTimer = setInterval(function() {
            const mod = document.getElementById('model_training');
            if (!mod || !mod.classList.contains('active')) return;
            pullMlopsJobs(false);
        }, 8000);
    }

    function stopMlopsPolling() {
        if (mlopsPollTimer) {
            clearInterval(mlopsPollTimer);
            mlopsPollTimer = null;
        }
    }

    function mergeMlopsJobsIntoTraining(jobs) {
        if (!Array.isArray(jobs) || !jobs.length) return false;
        let changed = false;
        jobs.forEach(function(job) {
            const jid = String(job.jobId || '').trim();
            if (!jid) return;
            let idx = modelTrainingData.findIndex(function(m) { return String(m.jobId || '') === jid; });
            const patch = {
                jobId: jid,
                name: job.name || jid,
                code: job.code || jid,
                type: job.type || '其他',
                scenario: job.scenario || '城市安全监测',
                env: job.env === 'local' ? 'local' : 'remote',
                server: job.server || '',
                owner: job.owner || '',
                dataset: job.dataset || '',
                status: job.status || 'training',
                metric: job.metric || '',
                progress: job.progress != null ? Number(job.progress) : 0,
                logUrl: job.logUrl || '',
                weightPath: job.weightPath || '',
                description: job.description || '',
                updatedAt: job.updatedAt || new Date().toISOString().split('T')[0],
                lastReportAt: job.lastReportAt || '',
                syncSource: 'mlops'
            };
            if (!patch.owner && typeof pickModelOwner === 'function') patch.owner = pickModelOwner(0);
            if (idx === -1) {
                const newId = modelTrainingData.length > 0 ? Math.max.apply(null, modelTrainingData.map(function(m) { return Number(m.id) || 0; })) + 1 : 1;
                modelTrainingData.unshift(Object.assign({ id: newId, createdAt: patch.updatedAt }, patch));
                changed = true;
            } else {
                const prev = modelTrainingData[idx];
                const next = Object.assign({}, prev, patch, {
                    id: prev.id,
                    createdAt: prev.createdAt || patch.updatedAt,
                    owner: patch.owner || prev.owner
                });
                const same = JSON.stringify({
                    s: prev.status, p: prev.progress, m: prev.metric, u: prev.updatedAt, l: prev.lastReportAt, w: prev.weightPath, g: prev.logUrl
                }) === JSON.stringify({
                    s: next.status, p: next.progress, m: next.metric, u: next.updatedAt, l: next.lastReportAt, w: next.weightPath, g: next.logUrl
                });
                if (!same) {
                    modelTrainingData[idx] = next;
                    changed = true;
                }
            }
        });
        return changed;
    }

    async function pullMlopsJobs(showToast) {
        const hint = document.getElementById('mlopsSyncHint');
        try {
            if (showToast && typeof syncFromCloudAndRefresh === 'function') {
                try { await syncFromCloudAndRefresh({ silent: true }); } catch (e) {}
            }
            const resp = await fetch('/api/mlops/jobs', { cache: 'no-store' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            const jobs = (data && data.jobs) || [];
            const changed = mergeMlopsJobsIntoTraining(jobs);
            if (changed) saveModelTrainingData();
            mlopsLastSyncAt = new Date().toLocaleString('zh-CN');
            if (hint) hint.textContent = '最近同步：' + mlopsLastSyncAt + ' · 收到 ' + jobs.length + ' 条 MLOps 任务' + (changed ? '（已更新台账）' : '');
            renderModelTrainingList();
            if (showToast) {
                if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner(changed ? 'MLOps 状态已更新' : 'MLOps 已同步（无变更）', false);
                else alert(changed ? 'MLOps 状态已更新' : 'MLOps 已同步（无变更）');
            }
        } catch (e) {
            if (hint) hint.textContent = '本机 MLOps 接口不可用（请用 start_web.py 启动）。云端同步仍可用。';
            if (showToast) {
                if (typeof showCloudSyncBanner === 'function') showCloudSyncBanner('无法连接本机 MLOps，请确认本地服务已启动', true);
                else alert('无法连接本机 MLOps 接口');
            }
        }
    }

    function buildTeamDefaultModelTraining() {
        return [
            { id: 1, name: '结构裂缝检测-YOLOv8', code: 'Crack-YOLOv8', type: 'YOLOv8', scenario: '结构损伤诊断', env: 'local', server: '本机-RTX4090', jobId: 'exp-crack-0612', status: 'completed', metric: 'mAP 94.6%', progress: 100, owner: pickModelOwner(2), dataset: 'CrackDataset-CQ', logUrl: 'http://127.0.0.1:6006/#scalars', weightPath: 'D:/experiments/crack-yolov8/best.pt', createdAt: '2026-05-18', updatedAt: '2026-06-12', description: '本机训练：混凝土构件表面裂缝检测。' },
            { id: 2, name: '振动图像损伤诊断-Qwen3VL', code: 'VibDamage-Qwen3VL', type: 'Qwen3-VL', scenario: '结构振动测试', env: 'remote', server: 'gpu-lab-02', jobId: 'job-vib-0711', status: 'training', metric: 'Acc 86.2%', progress: 68, owner: pickModelOwner(2), dataset: 'VibImage-Tower', logUrl: 'http://gpu-lab-02:6006/#scalars', weightPath: '/data/exp/vib-qwen3vl/last.pt', createdAt: '2026-07-01', updatedAt: '2026-07-11', description: '远程训练：图像+振动多模态损伤诊断。' },
            { id: 3, name: '城市区域灾害风险识别', code: 'UrbanRisk-ResNet', type: 'ResNet', scenario: '城市灾害风险', env: 'remote', server: 'gpu-lab-01', jobId: 'job-risk-0620', status: 'completed', metric: 'F1 91.8%', progress: 100, owner: pickModelOwner(1), dataset: 'UrbanRisk-2025', logUrl: '', weightPath: '/nas/models/urban-risk/best.pth', createdAt: '2026-05-28', updatedAt: '2026-06-20', description: '远程训练：城市区域灾害风险场景分类。' },
            { id: 4, name: '输电塔损伤摄影测量', code: 'TowerDamage-YOLOv8', type: 'YOLOv8', scenario: '结构损伤诊断', env: 'remote', server: 'gpu-lab-02', jobId: 'job-tower-0710', status: 'training', metric: 'mAP 79.4%', progress: 52, owner: pickModelOwner(6), dataset: 'TowerUAV-Iter', logUrl: 'http://gpu-lab-02:6006/#scalars', weightPath: '/data/exp/tower-yolo/last.pt', createdAt: '2026-07-03', updatedAt: '2026-07-10', description: '远程训练：无人机摄影测量输电塔损伤检测。' },
            { id: 5, name: '装配式节点损伤识别', code: 'PCJoint-Qwen3VL', type: 'Qwen3-VL', scenario: '结构抗震', env: 'local', server: '本机-RTX4090', jobId: 'exp-pcjoint-0630', status: 'completed', metric: 'Acc 93.1%', progress: 100, owner: pickModelOwner(1), dataset: 'PCJoint-Damage', logUrl: 'http://127.0.0.1:6006/#scalars', weightPath: 'D:/experiments/pcjoint/best.pt', createdAt: '2026-06-08', updatedAt: '2026-06-30', description: '本机训练：装配式梁柱节点损伤识别。' },
            { id: 6, name: '工地安全帽佩戴检测', code: 'Helmet-YOLOv8', type: 'YOLOv8', scenario: '城市安全监测', env: 'local', server: '本机-RTX3060', jobId: 'exp-helmet-0618', status: 'completed', metric: 'mAP 96.2%', progress: 100, owner: pickModelOwner(4), dataset: 'HelmetDataset', logUrl: '', weightPath: 'D:/experiments/helmet/best.pt', createdAt: '2026-06-02', updatedAt: '2026-06-18', description: '本机训练：施工现场安全帽检测。' },
            { id: 7, name: '烟雾火灾早期预警', code: 'SmokeFire-YOLOv8', type: 'YOLOv8', scenario: '城市安全监测', env: 'remote', server: 'gpu-lab-01', jobId: 'job-smoke-0605', status: 'completed', metric: 'mAP 95.0%', progress: 100, owner: pickModelOwner(5), dataset: 'SmokeFire-Mix', logUrl: '', weightPath: '/nas/models/smoke-fire/best.pt', createdAt: '2026-05-22', updatedAt: '2026-06-05', description: '远程训练：烟雾与明火联合检测。' },
            { id: 8, name: '三维数字模型构件分割', code: 'BIMSeg-Qwen3VL', type: 'Qwen3-VL', scenario: '三维数字模型', env: 'local', server: '本机-RTX4090', jobId: 'exp-bimseg-0708', status: 'pending', metric: '—', progress: 0, owner: pickModelOwner(7), dataset: 'Struct3D-Parts', logUrl: '', weightPath: 'D:/experiments/bimseg/', createdAt: '2026-07-08', updatedAt: '2026-07-08', description: '本机待启动：三维数字模型构件语义分割。' }
        ];
    }

    function saveModelTrainingData() {
        localStorage.setItem('modelTrainingData', JSON.stringify(modelTrainingData));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('modelTrainingData', JSON.stringify(modelTrainingData)); } catch (e) {}
    }

    function normalizeModelTrainingItem(m, idx) {
        const next = Object.assign({}, m);
        if (!next.code) next.code = next.name || ('model-' + (next.id || idx));
        if (!next.scenario) next.scenario = '城市安全监测';
        if (next.accuracy && !next.metric) next.metric = next.accuracy;
        if (next.progress == null) {
            next.progress = next.status === 'completed' ? 100 : (next.status === 'training' ? 50 : 0);
        }
        if (!next.env) next.env = (idx % 2 === 0) ? 'local' : 'remote';
        if (!next.server) next.server = next.env === 'local' ? '本机-RTX4090' : 'gpu-lab-01';
        if (!next.jobId) next.jobId = next.code || ('job-' + (next.id || idx));
        if (next.logUrl == null) next.logUrl = '';
        if (next.weightPath == null) next.weightPath = '';
        if (!next.updatedAt) next.updatedAt = next.createdAt || '';
        if (!['pending', 'training', 'completed', 'failed'].includes(next.status)) {
            next.status = next.status === 'completed' ? 'completed' : 'pending';
        }
        return next;
    }

    function migrateModelTrainingToTeam() {
        const demoNames = ['YOLOv8-Safety', 'Qwen3-VL-Violence', 'YOLOv8-Object', 'YOLOv8-Sign'];
        if (!Array.isArray(modelTrainingData) || !modelTrainingData.length) {
            modelTrainingData = buildTeamDefaultModelTraining();
            saveModelTrainingData();
            return;
        }
        if (modelTrainingData.some(m => demoNames.includes(m.name))) {
            modelTrainingData = buildTeamDefaultModelTraining();
            saveModelTrainingData();
            return;
        }
        // 旧台账无 env 字段时，升级为本机/远程双环境示例
        if (modelTrainingData.every(function(m) { return !m.env; })) {
            modelTrainingData = buildTeamDefaultModelTraining();
            saveModelTrainingData();
            return;
        }
        let changed = false;
        const owners = new Set(getModelOwnerNames());
        modelTrainingData = modelTrainingData.map(function(m, idx) {
            const before = JSON.stringify(m);
            const next = normalizeModelTrainingItem(m, idx);
            if (!next.owner || (owners.size && !owners.has(next.owner))) {
                next.owner = typeof replaceUnknownOwnerWithTeamMember === 'function'
                    ? replaceUnknownOwnerWithTeamMember(next.owner)
                    : pickModelOwner(0);
            }
            if (JSON.stringify(next) !== before) changed = true;
            return next;
        });
        if (changed) saveModelTrainingData();
    }

    function initModelTraining() {
        const saved = localStorage.getItem('modelTrainingData');
        if (saved) {
            try { modelTrainingData = JSON.parse(saved); } catch (e) { modelTrainingData = []; }
        } else {
            modelTrainingData = [];
        }
        migrateModelTrainingToTeam();
        populateModelTrainingOwnerFilter();
        const auto = localStorage.getItem('mlopsAutoPoll');
        mlopsAutoPollEnabled = auto !== '0';
        const chk = document.getElementById('mlopsAutoPoll');
        if (chk) chk.checked = mlopsAutoPollEnabled;
        const ep = document.getElementById('mlopsEndpointText');
        if (ep) ep.textContent = (location.origin || 'http://127.0.0.1:8000') + '/api/mlops/report';
        const tokenHint = document.getElementById('mlopsTokenHint');
        if (tokenHint) tokenHint.textContent = getAppConfig('MLOPS_TOKEN', '') ? '已配置（不展示）' : '未配置';
        renderModelTrainingList();
        startMlopsPolling();
    }

    function populateModelTrainingOwnerFilter() {
        const sel = document.getElementById('modelTrainingOwnerFilter');
        if (!sel) return;
        const current = sel.value;
        const owners = getModelOwnerNames();
        sel.innerHTML = '<option value="">全部成员</option>' + owners.map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
        if (current && owners.includes(current)) sel.value = current;
    }

    function updateModelTrainingStats() {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('mtStatTotal', modelTrainingData.length);
        set('mtStatLocal', modelTrainingData.filter(m => m.env === 'local').length);
        set('mtStatRemote', modelTrainingData.filter(m => m.env === 'remote').length);
        set('mtStatTraining', modelTrainingData.filter(m => m.status === 'training').length);
        set('mtStatCompleted', modelTrainingData.filter(m => m.status === 'completed').length);
        set('mtStatFailed', modelTrainingData.filter(m => m.status === 'failed').length);
    }

    function setModelTrainingStatusFilter(status) {
        modelTrainingFilterStatus = status || '';
        const sel = document.getElementById('modelTrainingStatusFilter');
        if (sel) sel.value = modelTrainingFilterStatus;
        renderModelTrainingList();
    }

    function setModelTrainingEnvFilter(env) {
        modelTrainingFilterEnv = env || '';
        const sel = document.getElementById('modelTrainingEnvFilter');
        if (sel) sel.value = modelTrainingFilterEnv;
        renderModelTrainingList();
    }

    function getFilteredModelTraining() {
        const q = ((document.getElementById('modelTrainingSearch') || {}).value || '').trim().toLowerCase();
        const type = (document.getElementById('modelTrainingTypeFilter') || {}).value || '';
        const status = (document.getElementById('modelTrainingStatusFilter') || {}).value || modelTrainingFilterStatus || '';
        const env = (document.getElementById('modelTrainingEnvFilter') || {}).value || modelTrainingFilterEnv || '';
        const owner = (document.getElementById('modelTrainingOwnerFilter') || {}).value || '';
        return modelTrainingData.filter(function(m) {
            if (type && m.type !== type) return false;
            if (status && m.status !== status) return false;
            if (env && m.env !== env) return false;
            if (owner && m.owner !== owner) return false;
            if (!q) return true;
            const blob = [m.name, m.code, m.scenario, m.owner, m.dataset, m.server, m.jobId, m.weightPath, m.description].join(' ').toLowerCase();
            return blob.indexOf(q) !== -1;
        });
    }

    function renderModelTrainingList() {
        const list = document.getElementById('modelTrainingList');
        const empty = document.getElementById('modelTrainingEmpty');
        if (!list) return;
        updateModelTrainingStats();
        populateModelTrainingOwnerFilter();
        const rows = getFilteredModelTraining();
        if (!rows.length) {
            list.innerHTML = '';
            if (empty) empty.style.display = 'block';
            return;
        }
        if (empty) empty.style.display = 'none';
        list.innerHTML = rows.map(function(item) {
            const st = modelStatusMeta(item.status);
            const ev = modelEnvMeta(item.env);
            const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
            const barColor = item.status === 'completed' ? '#22c55e' : (item.status === 'failed' ? '#ef4444' : '#f59e0b');
            return `<div style="background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:16px 18px; display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center;">
                <div>
                    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
                        <strong style="font-size:15px; color:#111827;">${escHtml(item.name)}</strong>
                        <span style="font-size:11px; color:${ev.color}; background:${ev.bg}; border:1px solid ${ev.border}; padding:2px 8px; border-radius:999px; font-weight:600;">${ev.text}</span>
                        <span style="font-size:11px; color:#6366f1; background:#eef2ff; padding:2px 8px; border-radius:999px;">${escHtml(item.type)}</span>
                        <span style="font-size:11px; color:${st.color}; background:${st.bg}; border:1px solid ${st.border}; padding:2px 8px; border-radius:999px; font-weight:600;">${st.text}</span>
                        ${item.syncSource === 'mlops' ? '<span style="font-size:11px; color:#0f766e; background:#ccfbf1; border:1px solid #99f6e4; padding:2px 8px; border-radius:999px; font-weight:600;">MLOps</span>' : ''}
                        <span style="font-size:11px; color:#6b7280; background:#f3f4f6; padding:2px 8px; border-radius:999px;">${escHtml(item.scenario || '城市安全')}</span>
                    </div>
                    <div style="font-size:12px; color:#9ca3af; margin-bottom:8px;">
                        ${escHtml(item.server || '-')} · 任务 ${escHtml(item.jobId || '-')} · 负责人 ${escHtml(item.owner || '-')} · ${escHtml(item.dataset || '-')}
                        ${item.lastReportAt ? ' · 上报 ' + escHtml(item.lastReportAt) : ''}
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="flex:1; height:8px; background:#f3f4f6; border-radius:999px; overflow:hidden; max-width:280px;">
                            <div style="width:${progress}%; height:100%; background:${barColor};"></div>
                        </div>
                        <span style="font-size:12px; color:#6b7280; min-width:70px;">${escHtml(item.metric || item.accuracy || '—')}</span>
                        <span style="font-size:12px; color:#9ca3af;">${escHtml(item.updatedAt || item.createdAt || '')}</span>
                    </div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
                    <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="viewModelDetail(${item.id})">详情</button>
                    ${item.logUrl ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="openModelLogUrl(${item.id})">打开日志</button>` : ''}
                    ${item.weightPath ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="copyModelWeightPath(${item.id})">复制权重路径</button>` : ''}
                    <button class="btn" style="padding:6px 12px;font-size:12px;" onclick="showUpdateModelStatusModal(${item.id})">更新状态</button>
                </div>
            </div>`;
        }).join('');
    }

    function showAddModelModal(editId) {
        const editing = editId != null ? modelTrainingData.find(m => m.id === editId) : null;
        const owners = getModelOwnerNames();
        const ownerOpts = owners.map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
        const myName = currentUser ? (currentUser.realName || '') : '';
        const modalId = 'addModelModal_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.45);z-index:2000;display:flex;justify-content:center;align-items:center;padding:16px;';
        modal.innerHTML = `<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:620px;max-height:90vh;overflow:auto;box-shadow:0 20px 50px rgba(15,23,42,.18);">
            <h3 style="margin:0 0 6px;color:#111827;font-size:18px;">${editing ? '编辑训练任务' : '登记训练任务'}</h3>
            <p style="margin:0 0 18px;font-size:12px;color:#6b7280;">本机或远程环境登记后同步云端；训练请在对应机器执行，此处不启动进程</p>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">模型名称 <span style="color:red;">*</span></label>
                <input type="text" id="modelName" value="${escHtml(editing ? editing.name : '')}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="如：结构裂缝检测-YOLOv8">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">训练环境 <span style="color:red;">*</span></label>
                    <select id="modelEnv" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                        <option value="local">本机</option>
                        <option value="remote">远程服务器</option>
                    </select>
                </div>
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">服务器 / 机器 <span style="color:red;">*</span></label>
                    <input type="text" id="modelServer" value="${escHtml(editing ? (editing.server || '') : '本机-RTX4090')}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="本机-RTX4090 或 gpu-lab-02">
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">模型架构</label>
                    <select id="modelType" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                        <option value="YOLOv8">YOLOv8 检测</option>
                        <option value="Qwen3-VL">Qwen3-VL 多模态</option>
                        <option value="ResNet">ResNet 分类</option>
                        <option value="其他">其他</option>
                    </select>
                </div>
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">应用场景</label>
                    <select id="modelScenario" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                        <option value="结构损伤诊断">结构损伤诊断</option>
                        <option value="结构振动测试">结构振动测试</option>
                        <option value="结构抗震">结构抗震</option>
                        <option value="城市灾害风险">城市灾害风险</option>
                        <option value="三维数字模型">三维数字模型</option>
                        <option value="城市安全监测">城市安全监测</option>
                    </select>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">负责人 <span style="color:red;">*</span></label>
                    <select id="modelOwner" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                        ${ownerOpts || '<option value="">暂无成员</option>'}
                    </select>
                </div>
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">任务号 / 实验目录</label>
                    <input type="text" id="modelJobId" value="${escHtml(editing ? (editing.jobId || '') : '')}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="如：exp-crack-0612">
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">数据集</label>
                    <input type="text" id="modelDataset" value="${escHtml(editing ? (editing.dataset || '') : '')}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="如：CrackDataset-CQ">
                </div>
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">初始状态</label>
                    <select id="modelStatus" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                        <option value="pending">待启动</option>
                        <option value="training">训练中</option>
                        <option value="completed">已完成</option>
                        <option value="failed">失败</option>
                    </select>
                </div>
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">日志 / TensorBoard 链接</label>
                <input type="text" id="modelLogUrl" value="${escHtml(editing ? (editing.logUrl || '') : '')}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="http://127.0.0.1:6006 或远程 TB 地址">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">权重路径</label>
                <input type="text" id="modelWeightPath" value="${escHtml(editing ? (editing.weightPath || '') : '')}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="本机 D:/exp/... 或 /nas/models/...">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;color:#374151;">任务说明</label>
                <textarea id="modelDesc" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;height:72px;resize:vertical;" placeholder="简述训练目标与部署环境">${escHtml(editing ? (editing.description || '') : '')}</textarea>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">
                <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                <button class="btn" onclick="saveModelTrainingForm('${modalId}', ${editing ? editing.id : 'null'})">${editing ? '保存' : '登记并同步'}</button>
            </div></div>`;
        document.body.appendChild(modal);
        if (editing) {
            document.getElementById('modelEnv').value = editing.env || 'local';
            document.getElementById('modelType').value = editing.type || 'YOLOv8';
            document.getElementById('modelScenario').value = editing.scenario || '结构损伤诊断';
            document.getElementById('modelStatus').value = editing.status || 'pending';
            if (editing.owner) document.getElementById('modelOwner').value = editing.owner;
        } else {
            const ownerSel = document.getElementById('modelOwner');
            if (ownerSel && myName && owners.includes(myName)) ownerSel.value = myName;
            document.getElementById('modelEnv').addEventListener('change', function() {
                const server = document.getElementById('modelServer');
                if (!server) return;
                if (this.value === 'local' && (!server.value || server.value.indexOf('gpu-') === 0)) server.value = '本机-RTX4090';
                if (this.value === 'remote' && (!server.value || server.value.indexOf('本机') === 0)) server.value = 'gpu-lab-02';
            });
        }
    }

    function saveModelTrainingForm(modalId, editId) {
        const name = document.getElementById('modelName').value.trim();
        const env = document.getElementById('modelEnv').value;
        const server = document.getElementById('modelServer').value.trim();
        const type = document.getElementById('modelType').value;
        const scenario = document.getElementById('modelScenario').value;
        const owner = document.getElementById('modelOwner').value;
        const jobId = document.getElementById('modelJobId').value.trim();
        const dataset = document.getElementById('modelDataset').value.trim();
        const status = document.getElementById('modelStatus').value;
        const logUrl = document.getElementById('modelLogUrl').value.trim();
        const weightPath = document.getElementById('modelWeightPath').value.trim();
        const desc = document.getElementById('modelDesc').value.trim();
        if (!name) { alert('请输入模型名称'); return; }
        if (!server) { alert('请填写服务器 / 机器名称'); return; }
        if (!owner) { alert('请选择负责人'); return; }
        const today = new Date().toISOString().split('T')[0];
        const progress = status === 'completed' ? 100 : (status === 'training' ? 10 : (status === 'failed' ? 0 : 0));
        const payload = {
            name,
            code: name.replace(/\s+/g, '-'),
            env,
            server,
            type,
            scenario,
            owner,
            jobId: jobId || name.replace(/\s+/g, '-'),
            dataset: dataset || '未命名数据集',
            datasetId: (window.__pendingDatasetLink && window.__pendingDatasetLink.id) || null,
            status,
            metric: status === 'training' ? '训练中' : (status === 'pending' ? '—' : (status === 'failed' ? '失败' : '已完成')),
            progress,
            logUrl,
            weightPath,
            description: desc,
            updatedAt: today
        };
        if (editId) {
            const idx = modelTrainingData.findIndex(m => m.id === editId);
            if (idx !== -1) {
                modelTrainingData[idx] = Object.assign({}, modelTrainingData[idx], payload);
            }
        } else {
            const newId = modelTrainingData.length > 0 ? Math.max(...modelTrainingData.map(m => m.id)) + 1 : 1;
            modelTrainingData.unshift(Object.assign({ id: newId, createdAt: today }, payload));
        }
        saveModelTrainingData();
        try { window.__pendingDatasetLink = null; } catch (eLink) {}
        document.getElementById(modalId).remove();
        renderModelTrainingList();
        alert(editId ? '任务已更新并同步' : '训练任务已登记并同步');
    }

    function addModel(modalId) {
        saveModelTrainingForm(modalId, null);
    }

    function viewModelDetail(id) {
        const model = modelTrainingData.find(m => m.id === id);
        if (!model) return;
        const st = modelStatusMeta(model.status);
        const ev = modelEnvMeta(model.env);
        const overlay = document.getElementById('modelDetailOverlay');
        const drawer = document.getElementById('modelDetailDrawer');
        const statusEl = document.getElementById('modelDetailStatus');
        const titleEl = document.getElementById('modelDetailTitle');
        const body = document.getElementById('modelDetailBody');
        const actions = document.getElementById('modelDetailActions');
        if (!drawer || !body) return;
        statusEl.textContent = st.text + ' · ' + ev.text;
        statusEl.style.cssText = `display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;margin-bottom:6px;color:${st.color};background:${st.bg};border:1px solid ${st.border};`;
        titleEl.textContent = model.name;
        body.innerHTML = `
            <div style="font-size:13px;color:#6b7280;margin-bottom:14px;">${escHtml(model.code || '')}</div>
            <div style="display:grid;gap:12px;font-size:14px;color:#374151;">
                <div><div style="font-size:12px;color:#9ca3af;">环境 / 服务器</div><div>${ev.text} · ${escHtml(model.server || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">任务号</div><div>${escHtml(model.jobId || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">架构 / 场景</div><div>${escHtml(model.type)} · ${escHtml(model.scenario || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">负责人</div><div>${escHtml(model.owner || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">数据集</div><div>${escHtml(model.dataset || '-')}${model.datasetId ? ` · <a href="javascript:void(0)" onclick="closeModelDetailDrawer();showModule('dataset_library');setTimeout(function(){showDatasetDetail(${Number(model.datasetId)});},200)">查看数据集</a>` : ''}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">指标 / 进度</div><div>${escHtml(model.metric || model.accuracy || '—')} · ${Number(model.progress) || 0}%</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">日志链接</div><div style="word-break:break-all;">${model.logUrl ? `<a href="${escHtml(model.logUrl)}" target="_blank" rel="noopener">${escHtml(model.logUrl)}</a>` : '未填写'}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">权重路径</div><div style="word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;">${escHtml(model.weightPath || '未填写')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">创建 / 更新</div><div>${escHtml(model.createdAt || '-')} / ${escHtml(model.updatedAt || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">同步来源</div><div>${model.syncSource === 'mlops' ? 'MLOps 自动上报' : '人工登记'} ${model.lastReportAt ? '· 最近上报 ' + escHtml(model.lastReportAt) : ''}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">说明</div><div style="line-height:1.7;">${escHtml(model.description || '暂无')}</div></div>
                <div style="padding:10px 12px;background:#f8fafc;border-radius:10px;font-size:12px;color:#6b7280;line-height:1.6;">
                    训练在本机或远程执行。可用 <code>mlops_report.py</code> 向 <code>/api/mlops/report</code> 自动上报进度；门户会定时拉取并同步云端。
                </div>
            </div>`;
        let act = `<button class="btn btn-secondary" onclick="closeModelDetailDrawer()">关闭</button>`;
        act += `<button class="btn btn-secondary" onclick="showAddModelModal(${model.id})">编辑</button>`;
        act += `<button class="btn" onclick="showUpdateModelStatusModal(${model.id})">更新状态</button>`;
        if (model.logUrl) act += `<button class="btn btn-secondary" onclick="openModelLogUrl(${model.id})">打开日志</button>`;
        if (model.weightPath) act += `<button class="btn btn-secondary" onclick="copyModelWeightPath(${model.id})">复制权重路径</button>`;
        if (model.status === 'pending') act += `<button class="btn" onclick="markModelTrainingStatus(${model.id}, 'training')">标记为训练中</button>`;
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'leader' || model.owner === currentUser.realName)) {
            act += `<button class="btn btn-secondary" style="color:#dc2626;" onclick="deleteModelTraining(${model.id})">删除</button>`;
        }
        actions.innerHTML = act;
        overlay.style.display = 'block';
        drawer.style.display = 'block';
    }

    function closeModelDetailDrawer() {
        const overlay = document.getElementById('modelDetailOverlay');
        const drawer = document.getElementById('modelDetailDrawer');
        if (overlay) overlay.style.display = 'none';
        if (drawer) drawer.style.display = 'none';
    }

    function openModelLogUrl(id) {
        const model = modelTrainingData.find(m => m.id === id);
        if (!model || !model.logUrl) { alert('未填写日志链接'); return; }
        window.open(model.logUrl, '_blank', 'noopener');
    }

    function copyModelWeightPath(id) {
        const model = modelTrainingData.find(m => m.id === id);
        if (!model || !model.weightPath) { alert('未填写权重路径'); return; }
        const text = model.weightPath;
        const done = function() { alert('已复制权重路径：\n' + text); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(function() {
                window.prompt('请手动复制权重路径', text);
            });
        } else {
            window.prompt('请手动复制权重路径', text);
        }
    }

    function showUpdateModelStatusModal(id) {
        const model = modelTrainingData.find(m => m.id === id);
        if (!model) return;
        const modalId = 'updateModelStatus_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.45);z-index:2100;display:flex;justify-content:center;align-items:center;padding:16px;';
        modal.innerHTML = `<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:420px;box-shadow:0 20px 50px rgba(15,23,42,.18);">
            <h3 style="margin:0 0 6px;font-size:17px;">更新任务状态</h3>
            <p style="margin:0 0 14px;font-size:12px;color:#6b7280;">${escHtml(model.name)} · ${escHtml(model.server || '')}</p>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">状态</label>
                <select id="mtUpdateStatus" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                    <option value="pending">待启动</option>
                    <option value="training">训练中</option>
                    <option value="completed">已完成</option>
                    <option value="failed">失败</option>
                </select>
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">指标（可手填）</label>
                <input type="text" id="mtUpdateMetric" value="${escHtml(model.metric || '')}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="如：mAP 94.6%">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">进度 %</label>
                <input type="number" id="mtUpdateProgress" min="0" max="100" value="${Number(model.progress) || 0}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                <button class="btn" onclick="applyModelStatusUpdate(${id}, '${modalId}')">保存</button>
            </div>
        </div>`;
        document.body.appendChild(modal);
        document.getElementById('mtUpdateStatus').value = model.status || 'pending';
    }

    function applyModelStatusUpdate(id, modalId) {
        const model = modelTrainingData.find(m => m.id === id);
        if (!model) return;
        const status = document.getElementById('mtUpdateStatus').value;
        const metric = document.getElementById('mtUpdateMetric').value.trim();
        let progress = parseInt(document.getElementById('mtUpdateProgress').value, 10);
        if (isNaN(progress)) progress = 0;
        progress = Math.max(0, Math.min(100, progress));
        if (status === 'completed') progress = 100;
        model.status = status;
        model.metric = metric || model.metric || '—';
        model.progress = progress;
        model.updatedAt = new Date().toISOString().split('T')[0];
        saveModelTrainingData();
        document.getElementById(modalId).remove();
        renderModelTrainingList();
        viewModelDetail(id);
    }

    function markModelTrainingStatus(id, status) {
        const model = modelTrainingData.find(m => m.id === id);
        if (!model) return;
        model.status = status;
        if (status === 'training') {
            model.progress = Math.max(Number(model.progress) || 0, 5);
            if (!model.metric || model.metric === '—') model.metric = '训练中';
        }
        if (status === 'completed') {
            model.progress = 100;
            if (!model.metric || model.metric === '训练中' || model.metric === '—') model.metric = '已完成';
        }
        model.updatedAt = new Date().toISOString().split('T')[0];
        saveModelTrainingData();
        renderModelTrainingList();
        viewModelDetail(id);
    }

    function startModelTraining(id) { markModelTrainingStatus(id, 'training'); }
    function completeModelTraining(id) { markModelTrainingStatus(id, 'completed'); }

    function deleteModelTraining(id) {
        if (!confirm('确认删除该训练任务？')) return;
        modelTrainingData = modelTrainingData.filter(m => m.id !== id);
        saveModelTrainingData();
        closeModelDetailDrawer();
        renderModelTrainingList();
    }

    function downloadModel(id) {
        copyModelWeightPath(id);
    }

    // AI数据标注工具
    let annotationData = [];
    let annotationTypes = [];
    let annotationFilterStatus = '';

    function pickAnnoOwner(idx) {
        if (typeof getRealTeamOwnerNames === 'function') {
            const owners = getRealTeamOwnerNames();
            if (owners.length) return owners[idx % owners.length];
        }
        return (currentUser && currentUser.realName) || '团队成员';
    }

    function saveAnnotationData() {
        localStorage.setItem('annotationData', JSON.stringify(annotationData));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('annotationData', JSON.stringify(annotationData)); } catch (e) {}
    }

    function saveAnnotationTypes() {
        localStorage.setItem('annotationTypes', JSON.stringify(annotationTypes));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('annotationTypes', JSON.stringify(annotationTypes)); } catch (e) {}
    }

    function annotationStatusMeta(status) {
        if (status === 'ready') return { text: '可训练', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' };
        if (status === 'review') return { text: '待审核', color: '#ca8a04', bg: '#fefce8', border: '#fde68a' };
        return { text: '标注中', color: '#ea580c', bg: '#fff7ed', border: '#fed7aa' };
    }

    function deriveAnnotationStatus(item) {
        if (item.status && ['annotating', 'review', 'ready'].includes(item.status)) return item.status;
        const p = Number(item.progress) || 0;
        if (p >= 100) return 'ready';
        if (p >= 90) return 'review';
        return 'annotating';
    }

    function buildTeamDefaultAnnotations() {
        return [
            { id: 1, name: '结构裂缝边界框标注', dataset: 'CrackDataset-CQ', type: '目标检测', scenario: '结构损伤诊断', status: 'ready', progress: 100, owner: pickAnnoOwner(2), total: 800, completed: 800, linkedTrainJob: 'exp-crack-0612', updatedAt: '2026-06-12', notes: '可直接用于裂缝检测训练' },
            { id: 2, name: '输电塔损伤语义分割', dataset: 'TowerUAV-Iter', type: '语义分割', scenario: '结构损伤诊断', status: 'annotating', progress: 58, owner: pickAnnoOwner(6), total: 420, completed: 244, linkedTrainJob: 'job-tower-0710', updatedAt: '2026-07-10', notes: '无人机航拍损伤区域分割' },
            { id: 3, name: '振动图像损伤分类', dataset: 'VibImage-Tower', type: '图像分类', scenario: '结构振动测试', status: 'annotating', progress: 72, owner: pickAnnoOwner(2), total: 600, completed: 432, linkedTrainJob: 'job-vib-0711', updatedAt: '2026-07-11', notes: '对接多模态损伤诊断' },
            { id: 4, name: '装配式节点损伤标注', dataset: 'PCJoint-Damage', type: '目标检测', scenario: '结构抗震', status: 'ready', progress: 100, owner: pickAnnoOwner(1), total: 360, completed: 360, linkedTrainJob: 'exp-pcjoint-0630', updatedAt: '2026-06-30', notes: '' },
            { id: 5, name: '城市灾害风险场景分类', dataset: 'UrbanRisk-2025', type: '图像分类', scenario: '城市灾害风险', status: 'review', progress: 92, owner: pickAnnoOwner(1), total: 1000, completed: 920, linkedTrainJob: 'job-risk-0620', updatedAt: '2026-06-20', notes: '待导师抽检' },
            { id: 6, name: '工地安全帽检测标注', dataset: 'HelmetDataset', type: '目标检测', scenario: '城市安全监测', status: 'ready', progress: 100, owner: pickAnnoOwner(4), total: 280, completed: 280, linkedTrainJob: 'exp-helmet-0618', updatedAt: '2026-06-18', notes: '' },
            { id: 7, name: '烟雾火灾像素分割', dataset: 'SmokeFire-Mix', type: '语义分割', scenario: '城市安全监测', status: 'annotating', progress: 45, owner: pickAnnoOwner(5), total: 500, completed: 225, linkedTrainJob: 'job-smoke-0605', updatedAt: '2026-07-05', notes: '' },
            { id: 8, name: '三维构件实例分割', dataset: 'Struct3D-Parts', type: '语义分割', scenario: '三维数字模型', status: 'annotating', progress: 18, owner: pickAnnoOwner(7), total: 200, completed: 36, linkedTrainJob: 'exp-bimseg-0708', updatedAt: '2026-07-08', notes: '本机待训练前置数据' }
        ];
    }

    function migrateAnnotationDataToTeam() {
        const demoNames = ['安全目标检测标注', '跌倒检测标注', '人群密度标注', '行人行为标注'];
        const hasUserTasks = Array.isArray(annotationData) && annotationData.some(function(a) {
            return a && (a.hasRealFiles || Number(a.fileCount) > 0 || a.cloudShare || a.uploadMode || a.serverUploaded || a.cloudUploaded);
        });
        // 有真实上传任务时，绝不回滚成示例数据，避免覆盖云端同步
        if (hasUserTasks) {
            let changed = false;
            annotationData = annotationData.map(function(a, idx) {
                const next = Object.assign({}, a);
                if (!next.scenario) { next.scenario = '城市安全监测'; changed = true; }
                next.status = deriveAnnotationStatus(next);
                if (next.completed == null && next.total) {
                    next.completed = Math.round((Number(next.progress) || 0) / 100 * Number(next.total));
                    changed = true;
                }
                if (!next.updatedAt) { next.updatedAt = new Date().toISOString().split('T')[0]; changed = true; }
                if (!next.owner) { next.owner = pickAnnoOwner(idx); changed = true; }
                return next;
            });
            if (changed) saveAnnotationData();
            return;
        }
        if (!Array.isArray(annotationData) || !annotationData.length) {
            annotationData = buildTeamDefaultAnnotations();
            // 仅本地占位，不抢写云端（等云端拉取覆盖）
            try { Storage.prototype.setItem.call(localStorage, 'annotationData', JSON.stringify(annotationData)); } catch (e) {
                localStorage.setItem('annotationData', JSON.stringify(annotationData));
            }
            return;
        }
        if (annotationData.some(function(a) { return demoNames.includes(a.name); })) {
            annotationData = buildTeamDefaultAnnotations();
            try { Storage.prototype.setItem.call(localStorage, 'annotationData', JSON.stringify(annotationData)); } catch (e) {
                localStorage.setItem('annotationData', JSON.stringify(annotationData));
            }
            return;
        }
        // 全员同一负责人（如误同步成同一人）时重建示例
        const owners = annotationData.map(function(a) { return a.owner; }).filter(Boolean);
        const uniqueOwners = new Set(owners);
        if (owners.length >= 4 && uniqueOwners.size === 1 && !annotationData.some(function(a) { return a.scenario; })) {
            annotationData = buildTeamDefaultAnnotations();
            try { Storage.prototype.setItem.call(localStorage, 'annotationData', JSON.stringify(annotationData)); } catch (e) {
                localStorage.setItem('annotationData', JSON.stringify(annotationData));
            }
            return;
        }
        let changed = false;
        const valid = new Set(typeof getRealTeamOwnerNames === 'function' ? getRealTeamOwnerNames() : []);
        annotationData = annotationData.map(function(a, idx) {
            const next = Object.assign({}, a);
            if (!next.scenario) { next.scenario = '城市安全监测'; changed = true; }
            next.status = deriveAnnotationStatus(next);
            if (next.completed == null && next.total) {
                next.completed = Math.round((Number(next.progress) || 0) / 100 * Number(next.total));
                changed = true;
            }
            if (!next.updatedAt) { next.updatedAt = new Date().toISOString().split('T')[0]; changed = true; }
            if (valid.size && next.owner && !valid.has(next.owner) && typeof replaceUnknownOwnerWithTeamMember === 'function') {
                next.owner = replaceUnknownOwnerWithTeamMember(next.owner);
                changed = true;
            } else if (!next.owner) {
                next.owner = pickAnnoOwner(idx);
                changed = true;
            }
            return next;
        });
        if (changed) saveAnnotationData();
    }

    function initAnnotation() {
        const savedTypes = localStorage.getItem('annotationTypes');
        if (savedTypes) {
            try { annotationTypes = JSON.parse(savedTypes); } catch (e) { annotationTypes = []; }
        }
        if (!annotationTypes.length) {
            annotationTypes = [
                { id: 1, name: '目标检测', description: '检测图像中的目标对象并标注边界框', icon: '🎯' },
                { id: 2, name: '图像分类', description: '为图像分配预定义的类别标签', icon: '🏷️' },
                { id: 3, name: '语义分割', description: '为图像中每个像素标注所属类别', icon: '🎨' },
                { id: 4, name: '行为识别', description: '识别视频或图像中人物的行为动作', icon: '🏃' },
                { id: 5, name: '姿态估计', description: '标注人体关键点位置', icon: '🦴' },
                { id: 6, name: '密度估计', description: '估计图像中目标的数量密度', icon: '👥' }
            ];
            saveAnnotationTypes();
        }

        const saved = localStorage.getItem('annotationData');
        if (saved) {
            try { annotationData = JSON.parse(saved); } catch (e) { annotationData = []; }
        } else {
            annotationData = [];
        }
        migrateAnnotationDataToTeam();
        populateAnnotationFilters();
        renderAnnotationList();
    }

    function populateAnnotationFilters() {
        const typeSel = document.getElementById('annotationTypeFilter');
        if (typeSel) {
            const cur = typeSel.value;
            typeSel.innerHTML = '<option value="">全部类型</option>' + annotationTypes.map(function(t) {
                return '<option value="' + escHtml(t.name) + '">' + escHtml(t.name) + '</option>';
            }).join('');
            if (cur) typeSel.value = cur;
        }
        const ownerSel = document.getElementById('annotationOwnerFilter');
        if (ownerSel) {
            const cur = ownerSel.value;
            const owners = typeof getRealTeamOwnerNames === 'function' ? getRealTeamOwnerNames() : [];
            ownerSel.innerHTML = '<option value="">全部成员</option>' + owners.map(function(o) {
                return '<option value="' + escHtml(o) + '">' + escHtml(o) + '</option>';
            }).join('');
            if (cur && owners.includes(cur)) ownerSel.value = cur;
        }
    }

    function updateAnnotationStats() {
        const set = function(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; };
        const list = annotationData || [];
        set('annoStatTotal', list.length);
        set('annoStatAnnotating', list.filter(function(a) { return deriveAnnotationStatus(a) === 'annotating'; }).length);
        set('annoStatReady', list.filter(function(a) { return deriveAnnotationStatus(a) === 'ready'; }).length);
        set('annoStatDone', list.reduce(function(s, a) { return s + (Number(a.completed) || 0); }, 0));
    }

    function setAnnotationStatusFilter(status) {
        annotationFilterStatus = status || '';
        const sel = document.getElementById('annotationStatusFilter');
        if (sel) sel.value = annotationFilterStatus;
        renderAnnotationList();
    }

    function getFilteredAnnotations() {
        const q = ((document.getElementById('annotationSearch') || {}).value || '').trim().toLowerCase();
        const type = (document.getElementById('annotationTypeFilter') || {}).value || '';
        const status = (document.getElementById('annotationStatusFilter') || {}).value || annotationFilterStatus || '';
        const owner = (document.getElementById('annotationOwnerFilter') || {}).value || '';
        return (annotationData || []).filter(function(a) {
            if (type && a.type !== type) return false;
            if (status && deriveAnnotationStatus(a) !== status) return false;
            if (owner && a.owner !== owner) return false;
            if (!q) return true;
            const blob = [a.name, a.dataset, a.type, a.owner, a.scenario, a.linkedTrainJob, a.notes].join(' ').toLowerCase();
            return blob.indexOf(q) !== -1;
        });
    }

    function renderAnnotationList() {
        const list = document.getElementById('annotationList');
        const empty = document.getElementById('annotationEmpty');
        // 兼容旧表格节点（若仍存在则忽略）
        if (!list) {
            const table = document.getElementById('annotationTable');
            if (!table) return;
        }
        updateAnnotationStats();
        populateAnnotationFilters();
        if (!list) return;
        const rows = getFilteredAnnotations();
        if (!rows.length) {
            list.innerHTML = '';
            if (empty) empty.style.display = 'block';
            return;
        }
        if (empty) empty.style.display = 'none';
        list.innerHTML = rows.map(function(item) {
            const st = annotationStatusMeta(deriveAnnotationStatus(item));
            const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
            const bar = progress >= 100 ? '#22c55e' : (progress >= 50 ? '#f59e0b' : '#ef4444');
            const pending = Math.max(0, (Number(item.total) || 0) - (Number(item.completed) || 0));
            return `<div style="background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:16px 18px; display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center;">
                <div>
                    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
                        <strong style="font-size:15px; color:#111827;">${escHtml(item.name)}</strong>
                        <span style="font-size:11px; color:${st.color}; background:${st.bg}; border:1px solid ${st.border}; padding:2px 8px; border-radius:999px; font-weight:600;">${st.text}</span>
                        <span style="font-size:11px; color:#6366f1; background:#eef2ff; padding:2px 8px; border-radius:999px;">${escHtml(item.type)}</span>
                        <span style="font-size:11px; color:#6b7280; background:#f3f4f6; padding:2px 8px; border-radius:999px;">${escHtml(item.scenario || '城市安全')}</span>
                    </div>
                    <div style="font-size:12px; color:#9ca3af; margin-bottom:8px;">
                        数据集 ${escHtml(item.dataset || '-')} · 负责人 ${escHtml(item.owner || '-')} · ${Number(item.completed)||0}/${Number(item.total)||0}
                        ${item.linkedTrainJob ? ' · 训练任务 ' + escHtml(item.linkedTrainJob) : ''}
                        ${item.hasRealFiles ? (String(item.storage||'').indexOf('cloud') >= 0 ? ' · 云端共享（全员可看）' : ' · 仅本机文件') : ''}
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="flex:1; height:8px; background:#f3f4f6; border-radius:999px; overflow:hidden; max-width:280px;">
                            <div style="width:${progress}%; height:100%; background:${bar};"></div>
                        </div>
                        <span style="font-size:12px; color:#6b7280;">${progress}% · 待标 ${pending}</span>
                        <span style="font-size:12px; color:#9ca3af;">${escHtml(item.updatedAt || '')}</span>
                    </div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
                    <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="viewAnnotationDetail(${item.id})">详情</button>
                    <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="showUpdateAnnotationProgress(${item.id})">更新进度</button>
                    <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="exportAnnotation(${item.id})">导出</button>
                    ${deriveAnnotationStatus(item) === 'ready' ? `<button class="btn" style="padding:6px 12px;font-size:12px;" onclick="pushAnnotationToTraining(${item.id})">登记训练</button>` : ''}
                </div>
            </div>`;
        }).join('');
    }

    function showAnnotationTypeModal() {
        const modalId = 'annotationTypeModal_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.45);z-index:2000;display:flex;justify-content:center;align-items:center;padding:16px;';
        
        let html = `<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:640px;max-height:80vh;overflow-y:auto;box-shadow:0 20px 50px rgba(15,23,42,.18);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#111827;">管理标注类型</h3>
                <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()" style="padding:5px 10px;">×</button>
            </div>`;
        
        html += `<button class="btn" style="margin-bottom:15px;" onclick="showAddAnnotationTypeModal('${modalId}')">＋ 添加标注类型</button>`;
        
        html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">`;
        annotationTypes.forEach(item => {
            html += `<div style="padding:12px;border:1px solid #e5e7eb;border-radius:10px;">
                <div style="font-size:18px;margin-bottom:5px;">${item.icon}</div>
                <div style="font-weight:bold;">${escHtml(item.name)}</div>
                <div style="font-size:12px;color:#666;margin:5px 0;">${escHtml(item.description)}</div>
                <div style="display:flex;gap:5px;">
                    <button class="btn btn-secondary" style="padding:3px 8px;font-size:11px;" onclick="showEditAnnotationTypeModal(${item.id}, '${modalId}')">编辑</button>
                    <button class="btn btn-secondary" style="padding:3px 8px;font-size:11px;color:#dc2626;" onclick="deleteAnnotationType(${item.id}, '${modalId}')">删除</button>
                </div>
            </div>`;
        });
        html += `</div></div>`;
        
        modal.innerHTML = html;
        document.body.appendChild(modal);
    }

    function showAddAnnotationTypeModal(parentModalId) {
        const modalId = 'addTypeModal_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.45);z-index:2001;display:flex;justify-content:center;align-items:center;padding:16px;';
        
        modal.innerHTML = `<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:450px;">
            <h3 style="margin-bottom:16px;color:#111827;">添加标注类型</h3>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">类型名称 <span style="color:red;">*</span></label>
                <input type="text" id="typeName" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="例如：裂缝检测">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">类型图标</label>
                <input type="text" id="typeIcon" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="emoji，如 🎯">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">类型描述</label>
                <textarea id="typeDesc" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" rows="3" placeholder="描述该标注类型的用途"></textarea>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                <button class="btn" onclick="addAnnotationType('${modalId}', '${parentModalId}')">添加</button>
            </div></div>`;
        
        document.body.appendChild(modal);
    }

    function addAnnotationType(modalId, parentModalId) {
        const name = document.getElementById('typeName').value.trim();
        const icon = document.getElementById('typeIcon').value.trim() || '📋';
        const description = document.getElementById('typeDesc').value.trim();
        
        if (!name) { alert('请输入类型名称'); return; }
        
        const newId = annotationTypes.length > 0 ? Math.max(...annotationTypes.map(t => t.id)) + 1 : 1;
        annotationTypes.push({ id: newId, name, icon, description });
        saveAnnotationTypes();
        
        document.getElementById(modalId).remove();
        document.getElementById(parentModalId)?.remove();
        showAnnotationTypeModal();
        populateAnnotationFilters();
    }

    function showEditAnnotationTypeModal(id, parentModalId) {
        const item = annotationTypes.find(t => t.id === id);
        if (!item) return;
        
        const modalId = 'editTypeModal_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.45);z-index:2001;display:flex;justify-content:center;align-items:center;padding:16px;';
        
        modal.innerHTML = `<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:450px;">
            <h3 style="margin-bottom:16px;color:#111827;">编辑标注类型</h3>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">类型名称 <span style="color:red;">*</span></label>
                <input type="text" id="editTypeName" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" value="${escHtml(item.name)}">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">类型图标</label>
                <input type="text" id="editTypeIcon" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" value="${escHtml(item.icon)}">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">类型描述</label>
                <textarea id="editTypeDesc" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" rows="3">${escHtml(item.description)}</textarea>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                <button class="btn" onclick="updateAnnotationType(${id}, '${modalId}', '${parentModalId}')">保存</button>
            </div></div>`;
        
        document.body.appendChild(modal);
    }

    function updateAnnotationType(id, modalId, parentModalId) {
        const name = document.getElementById('editTypeName').value.trim();
        const icon = document.getElementById('editTypeIcon').value.trim() || '📋';
        const description = document.getElementById('editTypeDesc').value.trim();
        
        if (!name) { alert('请输入类型名称'); return; }
        
        const idx = annotationTypes.findIndex(t => t.id === id);
        if (idx > -1) {
            annotationTypes[idx] = { ...annotationTypes[idx], name, icon, description };
            saveAnnotationTypes();
        }
        
        document.getElementById(modalId).remove();
        document.getElementById(parentModalId)?.remove();
        showAnnotationTypeModal();
        populateAnnotationFilters();
    }

    function deleteAnnotationType(id, parentModalId) {
        if (!confirm('确定要删除这个标注类型吗？')) return;
        
        annotationTypes = annotationTypes.filter(t => t.id !== id);
        saveAnnotationTypes();
        document.getElementById(parentModalId)?.remove();
        showAnnotationTypeModal();
        populateAnnotationFilters();
    }

    function showAddAnnotationModal() {
        const owners = typeof getRealTeamOwnerNames === 'function' ? getRealTeamOwnerNames() : [];
        const myName = currentUser ? (currentUser.realName || '') : '';
        const ownerOpts = owners.map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
        const typeOptions = annotationTypes.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
        const modalId = 'addAnnotationModal_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.45);z-index:2000;display:flex;justify-content:center;align-items:center;padding:16px;';
        
        modal.innerHTML = `<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:620px;max-height:90vh;overflow:auto;box-shadow:0 20px 50px rgba(15,23,42,.18);">
            <h3 style="margin:0 0 6px;color:#111827;font-size:18px;">新建标注任务</h3>
            <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">应用场景可手写；上传数据集后可自动识别样本数，也可手动修改</p>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">任务名称 <span style="color:red;">*</span></label>
                <input type="text" id="annoName" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="如：起重吊装安全检测标注">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;">数据集名称</label>
                    <input type="text" id="annoDataset" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="可手写，上传文件夹后可自动填充">
                </div>
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;">标注类型</label>
                    <select id="annoType" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">${typeOptions}</select>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;">应用场景 <span style="color:red;">*</span></label>
                    <input type="text" id="annoScenario" list="annoScenarioSuggestions" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="自行填写，如：起重吊装 / 结构裂缝">
                    <datalist id="annoScenarioSuggestions">
                        <option value="结构损伤诊断"></option>
                        <option value="结构振动测试"></option>
                        <option value="结构抗震"></option>
                        <option value="城市灾害风险"></option>
                        <option value="三维数字模型"></option>
                        <option value="城市安全监测"></option>
                        <option value="起重吊装"></option>
                    </datalist>
                </div>
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;">负责人</label>
                    <select id="annoOwner" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">${ownerOpts || '<option value="">暂无成员</option>'}</select>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;">样本数量</label>
                    <input type="number" id="annoTotal" min="0" value="" placeholder="上传后自动识别，也可手写" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                    <div id="annoTotalHint" style="font-size:11px;color:#9ca3af;margin-top:4px;">未上传时请手动填写</div>
                </div>
                <div>
                    <label style="display:block;margin-bottom:5px;font-size:13px;">关联训练任务号</label>
                    <input type="text" id="annoLinkedJob" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;" placeholder="如：exp-crack-0612">
                </div>
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">上传数据集文件 / 文件夹</label>
                <div style="border:2px dashed #e5e7eb;border-radius:10px;padding:16px;text-align:center;" id="datasetUploadArea_${modalId}">
                    <div style="color:#6b7280;font-size:13px;margin-bottom:10px;">支持图片、标签文件、CSV、JSON，以及整个数据集文件夹</div>
                    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
                        <button type="button" class="btn btn-secondary" style="padding:8px 14px;font-size:12px;" onclick="document.getElementById('datasetFileInput_${modalId}').click()">选择文件</button>
                        <button type="button" class="btn btn-secondary" style="padding:8px 14px;font-size:12px;" onclick="document.getElementById('datasetFolderInput_${modalId}').click()">选择文件夹</button>
                    </div>
                    <div style="font-size:12px;color:#9ca3af;margin-top:8px;">例如：起重吊装 / labels_xxx 文件夹</div>
                </div>
                <input type="file" id="datasetFileInput_${modalId}" accept=".jpg,.jpeg,.png,.bmp,.webp,.gif,.txt,.xml,.csv,.json,.yaml,.yml" style="display:none;" multiple onchange="handleDatasetUpload(event, '${modalId}', 'files')">
                <input type="file" id="datasetFolderInput_${modalId}" style="display:none;" webkitdirectory directory multiple onchange="handleDatasetUpload(event, '${modalId}', 'folder')">
                <div id="datasetFileList_${modalId}" style="margin-top:10px;max-height:140px;overflow-y:auto;display:none;"></div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                <button class="btn" onclick="addAnnotation('${modalId}')">创建并同步</button>
            </div></div>`;
        document.body.appendChild(modal);
        window.__annoUploadMeta = window.__annoUploadMeta || {};
        window.__annoUploadMeta[modalId] = { files: [], sampleCount: 0, source: '', mode: '' };
        const ownerSel = document.getElementById('annoOwner');
        if (ownerSel && myName && owners.includes(myName)) ownerSel.value = myName;
        const totalInput = document.getElementById('annoTotal');
        if (totalInput) {
            totalInput.addEventListener('input', function() {
                const hint = document.getElementById('annoTotalHint');
                if (hint) hint.textContent = '已手动填写样本数量';
            });
        }
    }

    function isAnnoImageFile(file) {
        const n = (file.name || '').toLowerCase();
        return /\.(jpg|jpeg|png|bmp|webp|gif)$/i.test(n) || (file.type && file.type.indexOf('image/') === 0);
    }

    function isAnnoLabelFile(file) {
        const n = (file.name || '').toLowerCase();
        return /\.(txt|xml|json|yaml|yml)$/i.test(n);
    }

    function readFileAsText(file) {
        return new Promise(function(resolve, reject) {
            const reader = new FileReader();
            reader.onload = function() { resolve(String(reader.result || '')); };
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }

    async function detectAnnotationSampleCount(files) {
        const list = Array.from(files || []);
        if (!list.length) return { count: 0, method: '无文件' };

        const images = list.filter(isAnnoImageFile);
        if (images.length > 0) {
            return { count: images.length, method: '按图片文件数识别（' + images.length + ' 张）' };
        }

        const labels = list.filter(isAnnoLabelFile);
        // YOLO labels 目录：每个 txt 对应一张图
        const txtLabels = labels.filter(function(f) { return /\.txt$/i.test(f.name) && !/classes\.txt$/i.test(f.name); });
        if (txtLabels.length > 0) {
            return { count: txtLabels.length, method: '按标签文件数识别（' + txtLabels.length + ' 个）' };
        }

        const csv = list.find(function(f) { return /\.csv$/i.test(f.name); });
        if (csv) {
            try {
                const text = await readFileAsText(csv);
                const lines = text.split(/\r?\n/).filter(function(l) { return l.trim(); });
                const count = Math.max(0, lines.length - 1);
                return { count: count, method: '按 CSV 行数识别（去掉表头）' };
            } catch (e) {
                return { count: list.length, method: 'CSV 读取失败，暂按文件数' };
            }
        }

        const jsonFile = list.find(function(f) { return /\.json$/i.test(f.name); });
        if (jsonFile) {
            try {
                const text = await readFileAsText(jsonFile);
                const data = JSON.parse(text);
                if (Array.isArray(data)) return { count: data.length, method: '按 JSON 数组长度识别' };
                if (data && Array.isArray(data.images)) return { count: data.images.length, method: '按 JSON.images 识别（COCO）' };
                if (data && Array.isArray(data.annotations)) return { count: data.annotations.length, method: '按 JSON.annotations 识别' };
                if (data && typeof data === 'object') return { count: Object.keys(data).length, method: '按 JSON 对象键数识别' };
            } catch (e) {
                return { count: list.length, method: 'JSON 解析失败，暂按文件数' };
            }
        }

        return { count: list.length, method: '按上传文件总数识别' };
    }

    async function handleDatasetUpload(event, modalId, mode) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        const uploadArea = document.getElementById('datasetUploadArea_' + modalId);
        const fileList = document.getElementById('datasetFileList_' + modalId);
        const totalInput = document.getElementById('annoTotal');
        const hint = document.getElementById('annoTotalHint');
        const datasetInput = document.getElementById('annoDataset');
        const nameInput = document.getElementById('annoName');
        const scenarioInput = document.getElementById('annoScenario');

        if (uploadArea) {
            uploadArea.style.borderColor = '#22c55e';
            uploadArea.style.backgroundColor = '#f0fdf4';
        }

        // 文件夹上传时，用顶层文件夹名填充数据集名 / 场景建议
        let folderName = '';
        if (mode === 'folder' && files[0] && files[0].webkitRelativePath) {
            folderName = String(files[0].webkitRelativePath).split(/[\\/]/)[0] || '';
            if (datasetInput && !datasetInput.value.trim() && folderName) datasetInput.value = folderName;
            if (scenarioInput && !scenarioInput.value.trim() && folderName && !/^labels/i.test(folderName)) {
                scenarioInput.value = folderName;
            }
            if (nameInput && !nameInput.value.trim() && folderName) {
                nameInput.value = folderName + '标注';
            }
        }

        const detect = await detectAnnotationSampleCount(files);
        window.__annoUploadMeta = window.__annoUploadMeta || {};
        window.__annoUploadMeta[modalId] = {
            files: Array.from(files),
            sampleCount: detect.count,
            method: detect.method,
            mode: mode || 'files',
            folderName: folderName
        };

        if (totalInput) totalInput.value = detect.count;
        if (hint) hint.textContent = '已自动识别：' + detect.method + '（可手动修改）';

        // 列表预览（最多显示 12 条）
        let html = '<div style="font-size:12px;color:#6b7280;margin-bottom:6px;">已选 ' + files.length + ' 个文件' + (folderName ? '（文件夹：' + escHtml(folderName) + '）' : '') + '</div>';
        const maxShow = Math.min(files.length, 12);
        for (let i = 0; i < maxShow; i++) {
            const file = files[i];
            const rel = file.webkitRelativePath || file.name;
            const tag = isAnnoImageFile(file) ? '图' : (/\.csv$/i.test(file.name) ? '表' : (isAnnoLabelFile(file) ? '标' : '文'));
            html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#f8fafc;border-radius:8px;margin-bottom:5px;font-size:12px;">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%;">[${tag}] ${escHtml(rel)}</span>
                <span style="color:#9ca3af;">${typeof formatFileSize === 'function' ? formatFileSize(file.size) : file.size}</span>
            </div>`;
        }
        if (files.length > maxShow) {
            html += '<div style="font-size:12px;color:#9ca3af;">… 其余 ' + (files.length - maxShow) + ' 个文件已计入</div>';
        }
        if (fileList) {
            fileList.innerHTML = html;
            fileList.style.display = 'block';
        }
    }

    function addAnnotation(modalId) {
        addAnnotationAsync(modalId);
    }

    function openAnnoFileDb() {
        return new Promise(function(resolve, reject) {
            const req = indexedDB.open('citySafetyAnnotationFiles', 1);
            req.onupgradeneeded = function() {
                const db = req.result;
                if (!db.objectStoreNames.contains('files')) {
                    const store = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('taskId', 'taskId', { unique: false });
                }
            };
            req.onsuccess = function() { resolve(req.result); };
            req.onerror = function() { reject(req.error); };
        });
    }

    async function saveAnnotationFilesToIdb(taskId, files) {
        if (!files || !files.length) return 0;
        const db = await openAnnoFileDb();
        let saved = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const path = f.webkitRelativePath || f.name;
            await new Promise(function(resolve, reject) {
                const tx = db.transaction('files', 'readwrite');
                tx.oncomplete = resolve;
                tx.onerror = function() { reject(tx.error); };
                tx.objectStore('files').add({
                    taskId: String(taskId),
                    path: path,
                    name: f.name,
                    type: f.type || '',
                    size: f.size,
                    blob: f,
                    savedAt: Date.now()
                });
                saved += 1;
            });
        }
        db.close();
        return saved;
    }

    async function listAnnotationFilesFromIdb(taskId) {
        const db = await openAnnoFileDb();
        return new Promise(function(resolve, reject) {
            const tx = db.transaction('files', 'readonly');
            const idx = tx.objectStore('files').index('taskId');
            const req = idx.getAll(String(taskId));
            req.onsuccess = function() {
                db.close();
                resolve(req.result || []);
            };
            req.onerror = function() {
                db.close();
                reject(req.error);
            };
        });
    }

    function getAnnotationStorageBucket() {
        return String(getAppConfig('ANNOTATION_STORAGE_BUCKET', 'annotations') || 'annotations').trim() || 'annotations';
    }

    function annotationCloudObjectPath(taskId, relPath) {
        const safeRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(function(p) {
            return p && p !== '.' && p !== '..';
        }).join('/');
        return 'tasks/' + String(taskId) + '/' + safeRel;
    }

    function annotationCloudPublicUrl(objectPath) {
        const base = String(SUPABASE_URL || '').replace(/\/$/, '');
        const bucket = getAnnotationStorageBucket();
        return base + '/storage/v1/object/public/' + encodeURIComponent(bucket) + '/' + objectPath.split('/').map(encodeURIComponent).join('/');
    }

    async function ensureAnnotationCloudReady() {
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            return { ok: false, error: 'Supabase 未配置（config.local.js）' };
        }
        const bucket = getAnnotationStorageBucket();
        try {
            const resp = await fetch(SUPABASE_URL + '/storage/v1/bucket/' + encodeURIComponent(bucket), {
                headers: {
                    apikey: SUPABASE_KEY,
                    Authorization: 'Bearer ' + SUPABASE_KEY
                },
                cache: 'no-store'
            });
            if (resp.ok) return { ok: true, bucket: bucket };
            const text = await resp.text();
            return {
                ok: false,
                error: '云端桶「' + bucket + '」不可用（HTTP ' + resp.status + '）。请在 Supabase SQL Editor 执行 supabase_annotations_storage.sql。' + (text ? (' ' + text) : '')
            };
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    }

    async function uploadAnnotationFilesToCloud(taskId, files) {
        if (!files || !files.length) return { ok: false, uploaded: 0, total: 0, errors: ['no files'], paths: [] };
        const ready = await ensureAnnotationCloudReady();
        if (!ready.ok) {
            return { ok: false, uploaded: 0, total: files.length, errors: [ready.error], paths: [] };
        }
        const bucket = ready.bucket;
        let uploaded = 0;
        const errors = [];
        const paths = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const rel = f.webkitRelativePath || f.name;
            const objectPath = annotationCloudObjectPath(taskId, rel);
            try {
                const resp = await fetch(
                    SUPABASE_URL + '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + objectPath.split('/').map(encodeURIComponent).join('/'),
                    {
                        method: 'POST',
                        headers: {
                            apikey: SUPABASE_KEY,
                            Authorization: 'Bearer ' + SUPABASE_KEY,
                            'Content-Type': f.type || 'application/octet-stream',
                            'x-upsert': 'true'
                        },
                        body: f
                    }
                );
                if (!resp.ok) {
                    const t = await resp.text();
                    errors.push(rel + ': HTTP ' + resp.status + ' ' + t);
                    continue;
                }
                uploaded += 1;
                paths.push({
                    path: rel.replace(/\\/g, '/'),
                    objectPath: objectPath,
                    url: annotationCloudPublicUrl(objectPath),
                    size: f.size,
                    name: f.name
                });
            } catch (e) {
                errors.push(rel + ': ' + (e && e.message ? e.message : String(e)));
            }
        }
        return { ok: uploaded > 0, uploaded: uploaded, total: files.length, errors: errors, paths: paths, bucket: bucket };
    }

    async function listAnnotationFilesFromCloud(taskId) {
        if (!SUPABASE_URL || !SUPABASE_KEY) return [];
        const bucket = getAnnotationStorageBucket();
        const prefix = 'tasks/' + String(taskId);
        const resp = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + encodeURIComponent(bucket), {
            method: 'POST',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prefix: prefix, limit: 1000, offset: 0 })
        });
        if (!resp.ok) return [];
        const rows = await resp.json();
        if (!Array.isArray(rows)) return [];
        // Storage list is one-level; recurse folders for nested datasets
        const out = [];
        async function walk(dirPrefix) {
            const r = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + encodeURIComponent(bucket), {
                method: 'POST',
                headers: {
                    apikey: SUPABASE_KEY,
                    Authorization: 'Bearer ' + SUPABASE_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prefix: dirPrefix, limit: 1000, offset: 0 })
            });
            if (!r.ok) return;
            const items = await r.json();
            if (!Array.isArray(items)) return;
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const name = it && it.name ? String(it.name) : '';
                if (!name) continue;
                const full = (dirPrefix ? dirPrefix.replace(/\/$/, '') + '/' : '') + name;
                // folders usually have id null and metadata null
                if (it.id == null && (!it.metadata || it.metadata === null) && !/\.[a-z0-9]+$/i.test(name)) {
                    await walk(full);
                } else {
                    out.push({
                        objectPath: full,
                        path: full.indexOf(prefix + '/') === 0 ? full.slice(prefix.length + 1) : name,
                        name: name,
                        url: annotationCloudPublicUrl(full),
                        size: (it.metadata && it.metadata.size) || 0
                    });
                }
            }
        }
        await walk(prefix);
        return out;
    }

    async function shareAnnotationTaskToCloud(taskId) {
        const uploadToken = String(getAppConfig('ANNOTATION_UPLOAD_TOKEN', '') || '').trim();
        if (!uploadToken) {
            return { ok: false, error: 'ANNOTATION_UPLOAD_TOKEN 未配置' };
        }
        try {
            const resp = await fetch('/api/annotation/share-cloud', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Upload-Token': uploadToken
                },
                body: JSON.stringify({ taskId: String(taskId) })
            });
            const data = await resp.json().catch(function() { return null; });
            if (!resp.ok || !data || !data.ok) {
                return { ok: false, error: (data && data.error) || ('HTTP ' + resp.status) };
            }
            return { ok: true, share: data.share };
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    }

    async function downloadAnnotationShareFromCloudKv(taskId, downloadName) {
        if (!SUPABASE_URL || !SUPABASE_KEY) return false;
        const mark = '__APP_SYNC_BLOB__';
        const metaPn = '__SYNC_BLOB__anno_' + String(taskId) + '_meta';
        const metaRows = await supabaseRequest(
            'GET',
            'patents?classification=eq.' + encodeURIComponent(mark) + '&patent_number=eq.' + encodeURIComponent(metaPn),
            { select: 'summary', limit: 1 }
        );
        if (!metaRows || !metaRows.length || !metaRows[0].summary) return false;
        let meta;
        try { meta = JSON.parse(metaRows[0].summary); } catch (e) { return false; }
        const chunks = Number(meta.chunks || 0);
        if (!chunks) return false;
        const parts = [];
        for (let i = 0; i < chunks; i++) {
            const pn = '__SYNC_BLOB__anno_' + String(taskId) + '_c' + i;
            const rows = await supabaseRequest(
                'GET',
                'patents?classification=eq.' + encodeURIComponent(mark) + '&patent_number=eq.' + encodeURIComponent(pn),
                { select: 'summary', limit: 1 }
            );
            if (!rows || !rows.length || !rows[0].summary) {
                throw new Error('缺少云端分片 ' + i);
            }
            const bin = atob(String(rows[0].summary));
            const arr = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
            parts.push(arr);
        }
        const blob = new Blob(parts, { type: 'application/zip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = downloadName || ('annotation-task-' + taskId + '.zip');
        a.click();
        URL.revokeObjectURL(a.href);
        return true;
    }

    async function uploadAnnotationFilesToServer(taskId, files) {
        if (!files || !files.length) return { ok: false, uploaded: 0, error: 'no files' };
        const uploadToken = String(getAppConfig('ANNOTATION_UPLOAD_TOKEN', '') || '').trim();
        if (!uploadToken) {
            return { ok: false, uploaded: 0, total: files.length, errors: ['ANNOTATION_UPLOAD_TOKEN 未配置'] };
        }
        let uploaded = 0;
        const errors = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const rel = f.webkitRelativePath || f.name;
            try {
                const resp = await fetch('/api/annotation/upload', {
                    method: 'POST',
                    headers: {
                        'X-Task-Id': String(taskId),
                        'X-Rel-Path': encodeURIComponent(rel),
                        'X-Upload-Token': uploadToken,
                        'Content-Type': f.type || 'application/octet-stream'
                    },
                    body: f
                });
                if (!resp.ok) {
                    const t = await resp.text();
                    errors.push(rel + ': HTTP ' + resp.status + ' ' + t);
                    continue;
                }
                const data = await resp.json();
                if (data && data.ok) uploaded += 1;
                else errors.push(rel + ': ' + ((data && data.error) || 'fail'));
            } catch (e) {
                errors.push(rel + ': ' + (e && e.message ? e.message : String(e)));
            }
        }
        return { ok: uploaded > 0, uploaded: uploaded, total: files.length, errors: errors };
    }

    async function addAnnotationAsync(modalId) {
        const name = document.getElementById('annoName').value.trim();
        const dataset = document.getElementById('annoDataset').value.trim();
        const type = document.getElementById('annoType').value;
        const scenario = document.getElementById('annoScenario').value.trim();
        const owner = document.getElementById('annoOwner').value;
        const linked = document.getElementById('annoLinkedJob').value.trim();
        let total = parseInt((document.getElementById('annoTotal') || {}).value, 10);
        if (isNaN(total) || total < 0) total = 0;

        const meta = (window.__annoUploadMeta && window.__annoUploadMeta[modalId]) || {};
        const fileInput = document.getElementById('datasetFileInput_' + modalId);
        const folderInput = document.getElementById('datasetFolderInput_' + modalId);
        const uploadedFiles = meta.files && meta.files.length
            ? meta.files
            : (folderInput && folderInput.files && folderInput.files.length
                ? Array.from(folderInput.files)
                : (fileInput && fileInput.files ? Array.from(fileInput.files) : []));

        if (!name) { alert('请输入任务名称'); return; }
        if (!scenario) { alert('请填写应用场景（可自行输入）'); return; }
        if (!total && uploadedFiles.length) {
            total = meta.sampleCount || uploadedFiles.filter(isAnnoImageFile).length || uploadedFiles.length;
        }
        if (!total) {
            if (!confirm('样本数量为 0，确定仍要创建？')) return;
        }

        const today = new Date().toISOString().split('T')[0];
        const newId = annotationData.length > 0 ? Math.max(...annotationData.map(a => a.id)) + 1 : 1;

        // 先落库任务，再真实上传文件
        const fileMeta = uploadedFiles.slice(0, 500).map(function(f) {
            return {
                name: f.name,
                path: f.webkitRelativePath || f.name,
                size: f.size,
                type: f.type || ''
            };
        });

        const task = {
            id: newId,
            name,
            dataset: dataset || meta.folderName || '自定义数据集',
            datasetId: (window.__pendingDatasetLink && window.__pendingDatasetLink.id) || null,
            type,
            scenario,
            status: 'annotating',
            progress: 0,
            owner: owner || pickAnnoOwner(0),
            total,
            completed: 0,
            linkedTrainJob: linked,
            updatedAt: today,
            notes: meta.method ? ('样本量：' + meta.method) : '',
            fileCount: uploadedFiles.length,
            uploadMode: meta.mode || '',
            files: fileMeta,
            hasRealFiles: false,
            storage: ''
        };
        annotationData.unshift(task);
        saveAnnotationData();
        try { window.__pendingDatasetLink = null; } catch (eLink) {}

        let uploadMsg = '';
        if (uploadedFiles.length) {
            // 1) 本机网关落盘（后续可一键发布到团队云端）
            const serverRes = await uploadAnnotationFilesToServer(newId, uploadedFiles);
            // 2) 网关打包分片写入云端 patents（全员可下，无需 Storage 桶）
            let shareRes = { ok: false };
            if (serverRes.ok) {
                shareRes = await shareAnnotationTaskToCloud(newId);
            }
            // 3) 可选：Supabase Storage 桶（若已开通）
            let cloudRes = { ok: false, uploaded: 0, total: 0, errors: [], paths: [] };
            if (!shareRes.ok) {
                cloudRes = await uploadAnnotationFilesToCloud(newId, uploadedFiles);
            }
            // 4) 浏览器 IndexedDB 仅作本机兜底
            let idbCount = 0;
            try { idbCount = await saveAnnotationFilesToIdb(newId, uploadedFiles); } catch (e) { console.warn(e); }

            const storageParts = [];
            if (shareRes.ok) {
                task.hasRealFiles = true;
                task.cloudShare = shareRes.share;
                storageParts.push('cloud');
                uploadMsg += '\n已发布到团队云端：' + (shareRes.share && shareRes.share.chunks ? shareRes.share.chunks : '?') + ' 个分片（全员可导出 ZIP）';
            } else if (cloudRes.ok) {
                task.hasRealFiles = true;
                task.cloudUploaded = cloudRes.uploaded;
                task.cloudBucket = cloudRes.bucket || getAnnotationStorageBucket();
                task.cloudFiles = (cloudRes.paths || []).slice(0, 500);
                storageParts.push('cloud');
                uploadMsg += '\n已上传到团队云端桶：' + cloudRes.uploaded + '/' + cloudRes.total + ' 个（全员可查看/导出）';
            }
            if (serverRes.ok) {
                task.hasRealFiles = true;
                task.serverUploaded = serverRes.uploaded;
                storageParts.push('server');
                uploadMsg += '\n本机网关备份：' + serverRes.uploaded + '/' + serverRes.total + ' 个';
            }
            if (!shareRes.ok && !cloudRes.ok && !serverRes.ok && idbCount > 0) {
                task.hasRealFiles = true;
                storageParts.push('idb');
                uploadMsg += '\n仅保存到本浏览器（' + idbCount + ' 个），其他人看不到。';
            } else if (!shareRes.ok && !cloudRes.ok && !serverRes.ok) {
                uploadMsg += '\n文件未能共享保存。';
                if (serverRes.errors && serverRes.errors[0]) uploadMsg += '\n本机：' + serverRes.errors[0];
            } else if (!shareRes.ok && !cloudRes.ok) {
                uploadMsg += '\n注意：团队云端发布未成功，其他成员可能无法下载真实文件。';
                if (shareRes.error) uploadMsg += '\n原因：' + shareRes.error;
            }
            if (idbCount > 0 && (shareRes.ok || cloudRes.ok || serverRes.ok)) storageParts.push('idb');
            task.storage = storageParts.join('+') || '';
            task.updatedAt = today;
            saveAnnotationData();
        }

        if (window.__annoUploadMeta) delete window.__annoUploadMeta[modalId];
        document.getElementById(modalId).remove();
        renderAnnotationList();
        alert('标注任务已创建\n应用场景：' + scenario + '\n样本数量：' + total + uploadMsg);
    }

    function viewAnnotationDetail(id) {
        const task = annotationData.find(a => a.id === id);
        if (!task) return;
        const st = annotationStatusMeta(deriveAnnotationStatus(task));
        const overlay = document.getElementById('annotationDetailOverlay');
        const drawer = document.getElementById('annotationDetailDrawer');
        const statusEl = document.getElementById('annotationDetailStatus');
        const titleEl = document.getElementById('annotationDetailTitle');
        const body = document.getElementById('annotationDetailBody');
        const actions = document.getElementById('annotationDetailActions');
        if (!drawer || !body) {
            alert(`标注任务：${task.name}\n进度：${task.progress}% (${task.completed}/${task.total})\n负责人：${task.owner}`);
            return;
        }
        statusEl.textContent = st.text;
        statusEl.style.cssText = `display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;margin-bottom:6px;color:${st.color};background:${st.bg};border:1px solid ${st.border};`;
        titleEl.textContent = task.name;
        body.innerHTML = `
            <div style="display:grid;gap:12px;font-size:14px;color:#374151;">
                <div><div style="font-size:12px;color:#9ca3af;">数据集 / 类型</div><div>${escHtml(task.dataset || '-')} · ${escHtml(task.type || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">场景</div><div>${escHtml(task.scenario || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">负责人</div><div>${escHtml(task.owner || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">进度</div><div>${Number(task.progress)||0}%（${Number(task.completed)||0} / ${Number(task.total)||0}）</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">关联训练任务</div><div>${escHtml(task.linkedTrainJob || '未关联')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">真实文件</div><div>${task.hasRealFiles ? ('已保存（' + escHtml(task.storage || 'local') + '）· ' + (Number(task.fileCount)||0) + ' 个' + (String(task.storage||'').indexOf('cloud') >= 0 ? ' · 全员可下载' : ' · 仅本机可见')) : '未上传真实文件'}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">更新时间</div><div>${escHtml(task.updatedAt || '-')}</div></div>
                <div><div style="font-size:12px;color:#9ca3af;">备注</div><div style="line-height:1.7;">${escHtml(task.notes || '暂无')}</div></div>
            </div>`;
        let act = `<button class="btn btn-secondary" onclick="closeAnnotationDetailDrawer()">关闭</button>`;
        act += `<button class="btn" onclick="showUpdateAnnotationProgress(${task.id})">更新进度</button>`;
        act += `<button class="btn btn-secondary" onclick="exportAnnotation(${task.id})">导出</button>`;
        if (String(task.storage || '').indexOf('cloud') < 0) {
            act += `<button class="btn" onclick="publishAnnotationToTeamCloud(${task.id})">发布到团队云端</button>`;
        }
        if (deriveAnnotationStatus(task) === 'ready') act += `<button class="btn" onclick="pushAnnotationToTraining(${task.id})">登记到训练台账</button>`;
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'leader' || task.owner === currentUser.realName)) {
            act += `<button class="btn btn-secondary" style="color:#dc2626;" onclick="deleteAnnotationTask(${task.id})">删除</button>`;
        }
        actions.innerHTML = act;
        overlay.style.display = 'block';
        drawer.style.display = 'block';
    }

    function closeAnnotationDetailDrawer() {
        const overlay = document.getElementById('annotationDetailOverlay');
        const drawer = document.getElementById('annotationDetailDrawer');
        if (overlay) overlay.style.display = 'none';
        if (drawer) drawer.style.display = 'none';
    }

    function showUpdateAnnotationProgress(id) {
        const task = annotationData.find(a => a.id === id);
        if (!task) return;
        const modalId = 'annoProgress_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.45);z-index:2100;display:flex;justify-content:center;align-items:center;padding:16px;';
        modal.innerHTML = `<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:420px;">
            <h3 style="margin:0 0 6px;font-size:17px;">更新标注进度</h3>
            <p style="margin:0 0 14px;font-size:12px;color:#6b7280;">${escHtml(task.name)}</p>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">已完成数量</label>
                <input type="number" id="annoUpCompleted" min="0" value="${Number(task.completed)||0}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">样本总量</label>
                <input type="number" id="annoUpTotal" min="0" value="${Number(task.total)||0}" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-size:13px;">状态</label>
                <select id="annoUpStatus" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;">
                    <option value="annotating">标注中</option>
                    <option value="review">待审核</option>
                    <option value="ready">可训练</option>
                </select>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button class="btn btn-secondary" onclick="document.getElementById('${modalId}').remove()">取消</button>
                <button class="btn" onclick="applyAnnotationProgress(${id}, '${modalId}')">保存</button>
            </div>
        </div>`;
        document.body.appendChild(modal);
        document.getElementById('annoUpStatus').value = deriveAnnotationStatus(task);
    }

    function applyAnnotationProgress(id, modalId) {
        const task = annotationData.find(a => a.id === id);
        if (!task) return;
        let completed = parseInt(document.getElementById('annoUpCompleted').value, 10);
        let total = parseInt(document.getElementById('annoUpTotal').value, 10);
        const status = document.getElementById('annoUpStatus').value;
        if (isNaN(completed) || completed < 0) completed = 0;
        if (isNaN(total) || total < 0) total = 0;
        if (completed > total && total > 0) completed = total;
        task.completed = completed;
        task.total = total;
        task.progress = total > 0 ? Math.round(completed / total * 100) : (status === 'ready' ? 100 : Number(task.progress) || 0);
        if (status === 'ready') task.progress = 100;
        task.status = status;
        task.updatedAt = new Date().toISOString().split('T')[0];
        saveAnnotationData();
        document.getElementById(modalId).remove();
        renderAnnotationList();
        viewAnnotationDetail(id);
    }

    function deleteAnnotationTask(id) {
        if (!confirm('确认删除该标注任务？')) return;
        annotationData = annotationData.filter(a => a.id !== id);
        saveAnnotationData();
        closeAnnotationDetailDrawer();
        renderAnnotationList();
    }

    function pushAnnotationToTraining(id) {
        const task = annotationData.find(a => a.id === id);
        if (!task) return;
        if (typeof modelTrainingData === 'undefined' || !Array.isArray(modelTrainingData)) {
            alert('训练台账模块未就绪');
            return;
        }
        const jobId = task.linkedTrainJob || ('anno-' + task.id);
        const existing = modelTrainingData.find(m => String(m.jobId || '') === String(jobId));
        if (existing) {
            alert('训练台账中已存在任务号：' + jobId + '\n请到「模型训练台账」查看');
            if (typeof showModule === 'function') showModule('model_training');
            return;
        }
        const today = new Date().toISOString().split('T')[0];
        const newId = modelTrainingData.length > 0 ? Math.max(...modelTrainingData.map(m => Number(m.id) || 0)) + 1 : 1;
        modelTrainingData.unshift({
            id: newId,
            name: task.name.replace(/标注$/, '') + '训练',
            code: jobId,
            jobId: jobId,
            type: task.type === '目标检测' ? 'YOLOv8' : (task.type === '图像分类' ? 'ResNet' : 'Qwen3-VL'),
            scenario: task.scenario || '城市安全监测',
            env: 'local',
            server: '本机-待指定',
            owner: task.owner || pickAnnoOwner(0),
            dataset: task.dataset || '',
            status: 'pending',
            metric: '—',
            progress: 0,
            logUrl: '',
            weightPath: '',
            description: '由标注任务「' + task.name + '」登记，样本 ' + (task.completed || 0) + '/' + (task.total || 0),
            createdAt: today,
            updatedAt: today,
            syncSource: 'annotation'
        });
        if (typeof saveModelTrainingData === 'function') saveModelTrainingData();
        else localStorage.setItem('modelTrainingData', JSON.stringify(modelTrainingData));
        alert('已登记到模型训练台账（待启动）');
        if (typeof showModule === 'function') showModule('model_training');
    }

    async function exportAnnotation(id) {
        const task = annotationData.find(a => a.id === id);
        if (!task) return;

        // 1) 团队云端分片包（全员可用，不依赖 Storage 桶）
        try {
            const ok = await downloadAnnotationShareFromCloudKv(id, (task.dataset || task.name || 'annotation') + '-files.zip');
            if (ok) return;
        } catch (e) { console.warn(e); }

        // 1b) 经本机网关拉取云端分片包
        try {
            const resp = await fetch('/api/annotation/fetch-cloud?taskId=' + encodeURIComponent(String(id)), { cache: 'no-store' });
            if (resp.ok) {
                const ct = resp.headers.get('Content-Type') || '';
                if (ct.indexOf('application/zip') !== -1) {
                    const blob = await resp.blob();
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = (task.dataset || task.name || 'annotation') + '-files.zip';
                    a.click();
                    URL.revokeObjectURL(a.href);
                    return;
                }
            }
        } catch (e) { /* fall through */ }

        // 2) Supabase Storage 桶（若已开通）
        try {
            let cloudFiles = Array.isArray(task.cloudFiles) ? task.cloudFiles.slice() : [];
            if (!cloudFiles.length) {
                cloudFiles = await listAnnotationFilesFromCloud(id);
            }
            if (cloudFiles && cloudFiles.length) {
                if (cloudFiles.length === 1) {
                    const one = cloudFiles[0];
                    const url = one.url || annotationCloudPublicUrl(one.objectPath);
                    const resp = await fetch(url, { cache: 'no-store' });
                    if (resp.ok) {
                        const blob = await resp.blob();
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = one.name || one.path || 'export.bin';
                        a.click();
                        URL.revokeObjectURL(a.href);
                        return;
                    }
                } else {
                    if (!confirm('将从团队云端下载 ' + cloudFiles.length + ' 个真实文件。继续？')) return;
                    for (let i = 0; i < cloudFiles.length; i++) {
                        const one = cloudFiles[i];
                        const url = one.url || annotationCloudPublicUrl(one.objectPath);
                        try {
                            const resp = await fetch(url, { cache: 'no-store' });
                            if (!resp.ok) continue;
                            const blob = await resp.blob();
                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(blob);
                            a.download = String(one.path || one.name || ('file-' + i)).replace(/[\\/]/g, '_');
                            a.click();
                            URL.revokeObjectURL(a.href);
                            await new Promise(function(r) { setTimeout(r, 120); });
                        } catch (e) { console.warn(e); }
                    }
                    return;
                }
            }
        } catch (e) { console.warn(e); }

        // 3) 本机网关 ZIP
        try {
            const resp = await fetch('/api/annotation/export?taskId=' + encodeURIComponent(String(id)), { cache: 'no-store' });
            if (resp.ok) {
                const blob = await resp.blob();
                const ct = resp.headers.get('Content-Type') || '';
                if (ct.indexOf('application/json') !== -1) {
                    // continue
                } else if (ct.indexOf('application/zip') !== -1 || blob.size > 64) {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = (task.dataset || task.name || 'annotation') + '-files.zip';
                    a.click();
                    URL.revokeObjectURL(a.href);
                    return;
                }
            }
        } catch (e) { /* fall through */ }

        // 4) IndexedDB 本机兜底
        try {
            const rows = await listAnnotationFilesFromIdb(id);
            if (rows && rows.length) {
                if (rows.length === 1) {
                    const row = rows[0];
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(row.blob);
                    a.download = row.name || row.path || 'export.bin';
                    a.click();
                    URL.revokeObjectURL(a.href);
                    return;
                }
                if (!confirm('将下载本浏览器本地的 ' + rows.length + ' 个文件（非团队云端）。继续？')) return;
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(row.blob);
                    a.download = (row.path || row.name || ('file-' + i)).replace(/[\\/]/g, '_');
                    a.click();
                    URL.revokeObjectURL(a.href);
                    await new Promise(function(r) { setTimeout(r, 120); });
                }
                return;
            }
        } catch (e) {
            console.warn(e);
        }

        alert('未找到该任务的团队共享文件。\n若本机已有备份，请在详情中点击「发布到团队云端」后再让其他人导出。');
    }

    async function publishAnnotationToTeamCloud(id) {
        const task = annotationData.find(a => a.id === id);
        if (!task) return;
        const res = await shareAnnotationTaskToCloud(id);
        if (!res.ok) {
            alert('发布失败：' + (res.error || 'unknown'));
            return;
        }
        task.cloudShare = res.share;
        task.hasRealFiles = true;
        const parts = String(task.storage || '').split('+').filter(Boolean);
        if (parts.indexOf('cloud') < 0) parts.unshift('cloud');
        if (parts.indexOf('server') < 0) parts.push('server');
        task.storage = parts.join('+');
        task.updatedAt = new Date().toISOString().split('T')[0];
        saveAnnotationData();
        renderAnnotationList();
        viewAnnotationDetail(id);
        alert('已发布到团队云端，其他成员可导出真实 ZIP。');
    }

    // 智能对话问答
    let knowledgeData = [];
    let teamChatHistory = [];
    let teamChatBusy = false;
    const KNOWLEDGE_CATEGORIES = ['制度流程', '模型训练', '数据标注', '研究方向', '系统使用'];
    const CHAT_QUICK_QUESTIONS = [
        '周报什么时候交？',
        '组会安排是什么？',
        'YOLOv8 训练流程？',
        '标注规范有哪些？',
        '如何上报 MLOps 状态？',
        '系统有哪些智能工具？'
    ];

    function saveKnowledgeData() {
        localStorage.setItem('knowledgeData', JSON.stringify(knowledgeData));
        try { if (typeof cloudUpsert === 'function') cloudUpsert('knowledgeData', JSON.stringify(knowledgeData)); } catch (e) {}
        updateChatStats();
    }

    function buildTeamDefaultKnowledge() {
        const owner = (currentUser && currentUser.realName) || '系统';
        const today = new Date().toISOString().split('T')[0];
        return [
            { id: 1, title: '课题组研究方向', category: '研究方向', tags: ['城市安全', 'CV', '物联网'], content: '城市安全数智创新团队主要研究方向：城市安全监测与预警、结构损伤诊断、计算机视觉与深度学习、物联网与传感器网络、应急管理与决策支持、三维数字模型与装配式结构。', updatedAt: today, owner: owner },
            { id: 2, title: '周报提交要求', category: '制度流程', tags: ['周报', '审核'], content: '每周日晚 22:00 前提交周报，内容包括：本周工作进展、下周计划、遇到的问题。组长需在周一 12:00 前审核完本组周报。可在「团队工作周报」模块填写并选择周期。', updatedAt: today, owner: owner },
            { id: 3, title: '会议安排', category: '制度流程', tags: ['组会', '月度'], content: '每周三下午 2:30 召开组会，地点：工学院 302 会议室。每月最后一周周五下午召开月度总结会议。重要通知以公告动态为准。', updatedAt: today, owner: owner },
            { id: 4, title: 'YOLOv8 训练指南', category: '模型训练', tags: ['YOLOv8', '检测'], content: 'YOLOv8 训练流程：1）准备 COCO/YOLO 格式数据集；2）配置 data.yaml；3）设置 epochs、batch、lr；4）启动训练；5）评估 mAP；6）导出 best.pt。训练进度可通过 mlops_report.py 上报到「模型训练台账」。', updatedAt: today, owner: owner },
            { id: 5, title: 'MLOps 状态上报', category: '模型训练', tags: ['MLOps', '上报'], content: '本机启动 start_web.py 后，训练脚本调用 mlops_report.py，向 /api/mlops/report 上报 jobId、status、progress、metric、weightPath。门户「模型训练台账」会自动拉取并同步云端。Token 配置在 .env 的 MLOPS_TOKEN。', updatedAt: today, owner: owner },
            { id: 6, title: '数据标注规范', category: '数据标注', tags: ['标注', '边界框'], content: '标注规范：目标框需完整包围目标；类别标签准确；避免无意义重叠；难例单独复核。完成后可在「AI数据标注工具」更新进度，达标后登记到训练台账。数据集文件建议发布到团队云端供全员导出。', updatedAt: today, owner: owner },
            { id: 7, title: '系统智能工具说明', category: '系统使用', tags: ['门户', '工具'], content: '智能工具包括：模型训练管理、AI 数据标注、智能对话问答、文献对比分析、Excel 数据处理、文档智能解析。账号权限在「系统设置」中管理；云端同步依赖 config.js 中的 Supabase 公开配置。', updatedAt: today, owner: owner }
        ];
    }

    function normalizeKnowledgeItem(item, idx) {
        const next = Object.assign({}, item || {});
        next.id = Number(next.id) || (idx + 1);
        next.title = String(next.title || '').trim() || ('未命名知识' + next.id);
        next.category = KNOWLEDGE_CATEGORIES.indexOf(next.category) >= 0 ? next.category : (next.category || '系统使用');
        next.content = String(next.content || '').trim();
        next.tags = Array.isArray(next.tags) ? next.tags.map(function(t) { return String(t).trim(); }).filter(Boolean) : String(next.tags || '').split(/[,，\s]+/).filter(Boolean);
        next.updatedAt = next.updatedAt || new Date().toISOString().split('T')[0];
        next.owner = next.owner || ((currentUser && currentUser.realName) || '团队成员');
        return next;
    }

    function migrateKnowledgeData() {
        if (!Array.isArray(knowledgeData) || !knowledgeData.length) {
            knowledgeData = buildTeamDefaultKnowledge();
            try { Storage.prototype.setItem.call(localStorage, 'knowledgeData', JSON.stringify(knowledgeData)); } catch (e) {
                localStorage.setItem('knowledgeData', JSON.stringify(knowledgeData));
            }
            return;
        }
        let changed = false;
        knowledgeData = knowledgeData.map(function(item, idx) {
            const before = JSON.stringify(item);
            const next = normalizeKnowledgeItem(item, idx);
            if (JSON.stringify(next) !== before) changed = true;
            return next;
        });
        if (changed) saveKnowledgeData();
    }

    function canManageKnowledge(item) {
        if (!item) return false;
        if (!currentUser) return true;
        if (currentUser.role === 'admin' || currentUser.role === 'leader') return true;
        return item.owner === currentUser.realName || item.owner === currentUser.username;
    }

    function getChatApiKey() {
        try {
            if (typeof getApiKey === 'function') {
                const k = getApiKey();
                if (k) return String(k).trim();
            }
        } catch (e) {}
        const el = document.getElementById('openaiApiKey');
        if (el && el.value) return String(el.value).trim();
        return String(localStorage.getItem('openaiApiKey') || localStorage.getItem('aliyunApiKey') || '').trim();
    }

    function updateChatModeBadge() {
        const badge = document.getElementById('chatModeBadge');
        const hint = document.getElementById('chatApiHint');
        const hasKey = !!getChatApiKey();
        if (badge) {
            badge.textContent = hasKey ? '大模型模式' : '全局检索模式';
            badge.style.background = hasKey ? '#ecfdf5' : '#eef2ff';
            badge.style.color = hasKey ? '#047857' : '#4f46e5';
            badge.style.borderColor = hasKey ? '#a7f3d0' : '#c7d2fe';
        }
        if (hint) {
            hint.textContent = hasKey
                ? '已配置百炼密钥，将结合全局检索上下文调用大模型'
                : '未检测到百炼密钥，将使用全局检索回答（可在「OpenAI入口」配置）';
        }
    }

    function updateChatStats() {
        const cats = new Set((knowledgeData || []).map(function(k) { return k.category; }).filter(Boolean));
        const set = function(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('chatStatKnowledge', (knowledgeData || []).length);
        set('chatStatCategory', cats.size);
        set('chatStatMessages', teamChatHistory.length);
        const syncEl = document.getElementById('chatStatSync');
        if (syncEl) {
            const on = typeof cloudSyncEnabled !== 'undefined' && cloudSyncEnabled;
            syncEl.textContent = on ? '云端同步' : '仅本机';
            syncEl.style.color = on ? '#16a34a' : '#64748b';
        }
    }

    function renderChatQuickChips() {
        const box = document.getElementById('chatQuickChips');
        if (!box) return;
        box.innerHTML = CHAT_QUICK_QUESTIONS.map(function(q) {
            return '<button type="button" class="btn btn-secondary team-chat-chip" style="padding:6px 12px;font-size:12px;border-radius:999px;" onclick="askQuickChatQuestion(' + JSON.stringify(q) + ')">' + escHtml(q) + '</button>';
        }).join('');
    }

    function askQuickChatQuestion(q) {
        const input = document.getElementById('chatInput');
        if (input) input.value = q;
        sendChatMessage();
    }

    function resetChatWelcome() {
        const container = document.getElementById('chatContainer');
        if (!container) return;
        container.innerHTML = '<div class="team-chat-row assistant"><div class="team-chat-bubble assistant"><div class="team-chat-label">AI 助手</div><div>您好！我是城市安全数智创新团队助手。可全局检索周报、项目、训练、标注、文献、数据集、共享文件和知识库；左侧知识库支持维护与引用。</div><div class="team-chat-meta">试试下方快捷问题，或直接提问</div></div></div>';
    }

    function appendChatBubble(role, text, meta) {
        const container = document.getElementById('chatContainer');
        if (!container) return;
        const isUser = role === 'user';
        const row = document.createElement('div');
        row.className = 'team-chat-row ' + (isUser ? 'user' : 'assistant');
        let extra = '';
        if (meta) extra = '<div class="team-chat-meta">' + escHtml(meta) + '</div>';
        row.innerHTML = '<div class="team-chat-bubble ' + (isUser ? 'user' : 'assistant') + '">' +
            '<div class="team-chat-label">' + (isUser ? '我' : 'AI 助手') + '</div>' +
            '<div>' + escHtml(text) + '</div>' + extra + '</div>';
        container.appendChild(row);
        container.scrollTop = container.scrollHeight;
    }

    function showChatTyping() {
        const container = document.getElementById('chatContainer');
        if (!container) return;
        hideChatTyping();
        const row = document.createElement('div');
        row.id = 'chatTypingRow';
        row.className = 'team-chat-row assistant';
        row.innerHTML = '<div class="team-chat-bubble assistant"><div class="team-chat-label">AI 助手</div><div class="team-chat-typing" aria-label="正在思考"><span></span><span></span><span></span></div></div>';
        container.appendChild(row);
        container.scrollTop = container.scrollHeight;
    }

    function hideChatTyping() {
        const el = document.getElementById('chatTypingRow');
        if (el) el.remove();
    }

    function clearChatSession() {
        teamChatHistory = [];
        hideChatTyping();
        resetChatWelcome();
        updateChatStats();
    }

    function populateKnowledgeCategoryFilter() {
        const sel = document.getElementById('knowledgeCategoryFilter');
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = '<option value="">全部分类</option>' + KNOWLEDGE_CATEGORIES.map(function(c) {
            return '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>';
        }).join('');
        if (cur) sel.value = cur;
    }

    function getFilteredKnowledge() {
        const q = String((document.getElementById('knowledgeSearch') || {}).value || '').trim().toLowerCase();
        const cat = String((document.getElementById('knowledgeCategoryFilter') || {}).value || '');
        return (knowledgeData || []).filter(function(item) {
            if (cat && item.category !== cat) return false;
            if (!q) return true;
            const blob = [item.title, item.content, item.category].concat(item.tags || []).join(' ').toLowerCase();
            return blob.indexOf(q) >= 0;
        });
    }

    function renderKnowledgeList() {
        const list = document.getElementById('knowledgeList');
        if (!list) return;
        const rows = getFilteredKnowledge();
        const hint = document.getElementById('knowledgeFilterHint');
        if (hint) hint.textContent = '显示 ' + rows.length + '/' + (knowledgeData || []).length;
        if (!rows.length) {
            list.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:28px 12px;font-size:13px;">暂无匹配知识，可点击右上角添加</div>';
            return;
        }
        list.innerHTML = rows.map(function(item) {
            const tags = (item.tags || []).slice(0, 3).map(function(t) {
                return '<span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 6px;border-radius:999px;">' + escHtml(t) + '</span>';
            }).join(' ');
            return '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:8px;background:#fafafa;">' +
                '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">' +
                '<div style="min-width:0;flex:1;cursor:pointer;" onclick="viewKnowledge(' + item.id + ')">' +
                '<div style="font-size:11px;color:#4f46e5;font-weight:600;margin-bottom:4px;">' + escHtml(item.category || '未分类') + '</div>' +
                '<div style="font-size:14px;font-weight:600;color:#111827;margin-bottom:4px;">' + escHtml(item.title) + '</div>' +
                '<div style="font-size:12px;color:#6b7280;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + escHtml(item.content) + '</div>' +
                (tags ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px;">' + tags + '</div>' : '') +
                '</div></div>' +
                '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">' +
                '<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="viewKnowledge(' + item.id + ')">详情</button>' +
                '<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="quoteKnowledgeToChat(' + item.id + ')">引用</button>' +
                (canManageKnowledge(item) ? '<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="showEditKnowledgeModal(' + item.id + ')">编辑</button>' : '') +
                (canManageKnowledge(item) ? '<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;color:#dc2626;" onclick="deleteKnowledge(' + item.id + ')">删除</button>' : '') +
                '</div></div>';
        }).join('');
    }

    function initChat() {
        const saved = localStorage.getItem('knowledgeData');
        if (saved) {
            try { knowledgeData = JSON.parse(saved); } catch (e) { knowledgeData = []; }
        } else {
            knowledgeData = [];
        }
        migrateKnowledgeData();
        populateKnowledgeCategoryFilter();
        renderKnowledgeList();
        renderChatQuickChips();
        if (!teamChatHistory.length) resetChatWelcome();
        updateChatModeBadge();
        updateChatStats();
    }

    function showKnowledgeModal(editId) {
        const editing = editId != null ? knowledgeData.find(function(k) { return k.id === editId; }) : null;
        const modalId = 'knowledgeModal_' + Date.now();
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:2000;display:flex;justify-content:center;align-items:center;padding:16px;';
        const catOpts = KNOWLEDGE_CATEGORIES.map(function(c) {
            const sel = editing && editing.category === c ? ' selected' : '';
            return '<option value="' + escHtml(c) + '"' + sel + '>' + escHtml(c) + '</option>';
        }).join('');
        modal.innerHTML = '<div style="background:#fff;padding:24px;border-radius:16px;width:100%;max-width:560px;box-shadow:0 20px 50px rgba(15,23,42,.18);">' +
            '<h3 style="margin:0 0 16px;color:#111827;">' + (editing ? '编辑知识' : '添加知识') + '</h3>' +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:6px;font-size:13px;">标题 *</label>' +
            '<input id="knowledgeTitle" class="form-control" style="width:100%;padding:10px;" value="' + escHtml(editing ? editing.title : '') + '" placeholder="如：周报提交要求"></div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">' +
            '<div><label style="display:block;margin-bottom:6px;font-size:13px;">分类</label><select id="knowledgeCategory" class="form-control" style="width:100%;padding:10px;">' + catOpts + '</select></div>' +
            '<div><label style="display:block;margin-bottom:6px;font-size:13px;">标签</label><input id="knowledgeTags" class="form-control" style="width:100%;padding:10px;" value="' + escHtml(editing ? (editing.tags || []).join(',') : '') + '" placeholder="逗号分隔"></div></div>' +
            '<div style="margin-bottom:12px;"><label style="display:block;margin-bottom:6px;font-size:13px;">内容 *</label>' +
            '<textarea id="knowledgeContent" class="form-control" style="width:100%;padding:10px;height:140px;">' + escHtml(editing ? editing.content : '') + '</textarea></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'' + modalId + '\').remove()">取消</button>' +
            '<button class="btn" onclick="saveKnowledgeFromModal(\'' + modalId + '\',' + (editing ? editing.id : 'null') + ')">保存</button></div></div>';
        document.body.appendChild(modal);
    }

    function showAddKnowledgeModal() { showKnowledgeModal(null); }
    function showEditKnowledgeModal(id) { showKnowledgeModal(id); }

    function saveKnowledgeFromModal(modalId, editId) {
        const title = document.getElementById('knowledgeTitle').value.trim();
        const content = document.getElementById('knowledgeContent').value.trim();
        const category = document.getElementById('knowledgeCategory').value;
        const tags = document.getElementById('knowledgeTags').value.split(/[,，]/).map(function(t) { return t.trim(); }).filter(Boolean);
        if (!title || !content) { alert('请填写标题和内容'); return; }
        const today = new Date().toISOString().split('T')[0];
        const owner = (currentUser && currentUser.realName) || '团队成员';
        if (editId != null) {
            const item = knowledgeData.find(function(k) { return k.id === editId; });
            if (!item) return;
            if (!canManageKnowledge(item)) { alert('无权限编辑该知识'); return; }
            item.title = title;
            item.content = content;
            item.category = category;
            item.tags = tags;
            item.updatedAt = today;
        } else {
            const newId = knowledgeData.length ? Math.max.apply(null, knowledgeData.map(function(k) { return Number(k.id) || 0; })) + 1 : 1;
            knowledgeData.unshift(normalizeKnowledgeItem({ id: newId, title: title, content: content, category: category, tags: tags, updatedAt: today, owner: owner }, 0));
        }
        saveKnowledgeData();
        document.getElementById(modalId).remove();
        renderKnowledgeList();
        closeKnowledgeDetailDrawer();
    }

    function deleteKnowledge(id) {
        const item = knowledgeData.find(function(k) { return k.id === id; });
        if (!item) return;
        if (!canManageKnowledge(item)) { alert('无权限删除该知识'); return; }
        if (!confirm('确定删除知识「' + item.title + '」？')) return;
        knowledgeData = knowledgeData.filter(function(k) { return k.id !== id; });
        saveKnowledgeData();
        renderKnowledgeList();
        closeKnowledgeDetailDrawer();
    }

    function viewKnowledge(id) {
        const knowledge = knowledgeData.find(function(k) { return k.id === id; });
        if (!knowledge) return;
        const overlay = document.getElementById('knowledgeDetailOverlay');
        const drawer = document.getElementById('knowledgeDetailDrawer');
        const catEl = document.getElementById('knowledgeDetailCategory');
        const titleEl = document.getElementById('knowledgeDetailTitle');
        const body = document.getElementById('knowledgeDetailBody');
        const actions = document.getElementById('knowledgeDetailActions');
        if (!drawer || !body) {
            alert(knowledge.title + '\n\n' + knowledge.content);
            return;
        }
        if (catEl) catEl.textContent = knowledge.category || '未分类';
        if (titleEl) titleEl.textContent = knowledge.title;
        body.textContent = knowledge.content + '\n\n标签：' + ((knowledge.tags || []).join('、') || '无') + '\n更新：' + (knowledge.updatedAt || '-') + '\n维护人：' + (knowledge.owner || '-');
        let act = '<button class="btn btn-secondary" onclick="closeKnowledgeDetailDrawer()">关闭</button>';
        act += '<button class="btn" onclick="quoteKnowledgeToChat(' + knowledge.id + ')">引用到对话</button>';
        if (canManageKnowledge(knowledge)) {
            act += '<button class="btn btn-secondary" onclick="showEditKnowledgeModal(' + knowledge.id + ')">编辑</button>';
            act += '<button class="btn btn-secondary" style="color:#dc2626;" onclick="deleteKnowledge(' + knowledge.id + ')">删除</button>';
        }
        actions.innerHTML = act;
        if (overlay) overlay.style.display = 'block';
        drawer.style.display = 'block';
    }

    function closeKnowledgeDetailDrawer() {
        const overlay = document.getElementById('knowledgeDetailOverlay');
        const drawer = document.getElementById('knowledgeDetailDrawer');
        if (overlay) overlay.style.display = 'none';
        if (drawer) drawer.style.display = 'none';
    }

    function quoteKnowledgeToChat(id) {
        const knowledge = knowledgeData.find(function(k) { return k.id === id; });
        if (!knowledge) return;
        const input = document.getElementById('chatInput');
        if (input) input.value = '请根据知识「' + knowledge.title + '」说明要点：' + knowledge.title;
        closeKnowledgeDetailDrawer();
        input && input.focus();
    }

    function scoreKnowledge(query, item) {
        const q = String(query || '').toLowerCase().trim();
        if (!q) return 0;
        const title = String(item.title || '').toLowerCase();
        const content = String(item.content || '').toLowerCase();
        const tags = (item.tags || []).join(' ').toLowerCase();
        const category = String(item.category || '').toLowerCase();
        let score = 0;
        if (title === q) score += 100;
        if (title.indexOf(q) >= 0) score += 40;
        if (q.indexOf(title) >= 0 && title.length >= 2) score += 20;
        const tokens = q.split(/[\s,，。？?！!、；;：:]+/).filter(function(t) { return t.length >= 2; });
        tokens.forEach(function(t) {
            if (title.indexOf(t) >= 0) score += 18;
            if (tags.indexOf(t) >= 0) score += 12;
            if (category.indexOf(t) >= 0) score += 8;
            if (content.indexOf(t) >= 0) score += 6;
        });
        return score;
    }

    function retrieveKnowledgeTopK(query, k) {
        k = k || 3;
        return (knowledgeData || []).map(function(item) {
            return { item: item, score: scoreKnowledge(query, item) };
        }).filter(function(x) {
            return x.score > 0;
        }).sort(function(a, b) {
            return b.score - a.score;
        }).slice(0, k);
    }

    function stringifyFields(obj, fields) {
        if (!obj) return '';
        return fields.map(function(f) {
            const v = obj[f];
            if (Array.isArray(v)) return v.join(' ');
            if (v && typeof v === 'object') {
                try { return JSON.stringify(v); } catch (e) { return ''; }
            }
            return v == null ? '' : String(v);
        }).filter(Boolean).join(' ');
    }

    function pushGlobalRecord(records, moduleName, title, content, ref, raw) {
        title = String(title || '').trim();
        content = String(content || '').trim();
        if (!title && !content) return;
        records.push({
            module: moduleName,
            title: title || moduleName,
            content: content,
            ref: ref || '',
            raw: raw || null
        });
    }

    function collectGlobalSearchRecords() {
        const records = [];
        try {
            const deadlineEl = document.getElementById('cfg_business.weeklyDeadline');
            const deadline = (deadlineEl && deadlineEl.value) ? deadlineEl.value : '22:00';
            pushGlobalRecord(
                records,
                '制度流程',
                '周报提交截止时间',
                '周报每周提交截止时间为 ' + deadline + '（系统业务规则配置）。请在「团队工作周报」模块填写并提交；逾期会触发周报提醒（若已开启）。常见问法：周报什么时候交、周报截止时间、何时提交周报。',
                '系统配置 cfg_business.weeklyDeadline',
                { deadline: deadline }
            );
        } catch (e) {}
        (knowledgeData || []).forEach(function(k) {
            pushGlobalRecord(
                records,
                '知识库',
                k.title,
                [k.category, (k.tags || []).join(' '), k.content].join('\n'),
                k.category || '',
                k
            );
        });
        (typeof taskData !== 'undefined' ? taskData : []).forEach(function(t) {
            pushGlobalRecord(records, '科研任务', t.title || t.name || t.taskName, stringifyFields(t, ['description', 'content', 'owner', 'assignee', 'status', 'priority', 'deadline', 'progress']), '任务ID ' + (t.id || ''), t);
        });
        (typeof weeklyReportData !== 'undefined' ? weeklyReportData : []).forEach(function(r) {
            pushGlobalRecord(records, '团队周报', r.title || r.week || r.period || (r.owner ? r.owner + ' 周报' : '周报'), stringifyFields(r, ['owner', 'status', 'period', 'weekRange', 'thisWeek', 'nextWeek', 'problems', 'content', 'summary', 'reviewComment']), '周报ID ' + (r.id || ''), r);
        });
        (typeof modelTrainingData !== 'undefined' ? modelTrainingData : []).forEach(function(m) {
            pushGlobalRecord(records, '模型训练', m.name || m.code || m.jobId, stringifyFields(m, ['type', 'scenario', 'dataset', 'status', 'metric', 'progress', 'owner', 'server', 'env', 'description', 'weightPath', 'logUrl']), m.jobId || ('训练ID ' + (m.id || '')), m);
        });
        (typeof annotationData !== 'undefined' ? annotationData : []).forEach(function(a) {
            pushGlobalRecord(records, 'AI数据标注', a.name || a.dataset, stringifyFields(a, ['dataset', 'type', 'scenario', 'status', 'owner', 'total', 'completed', 'progress', 'linkedTrainJob', 'notes', 'storage', 'fileCount']), '标注ID ' + (a.id || ''), a);
        });
        (typeof literatureData !== 'undefined' ? literatureData : []).forEach(function(l) {
            pushGlobalRecord(records, '文献资料', l.title || l.name, stringifyFields(l, ['author', 'authors', 'journal', 'year', 'keywords', 'abstract', 'summary', 'category', 'remark']), '文献ID ' + (l.id || ''), l);
        });
        (typeof compareLiteratureData !== 'undefined' ? compareLiteratureData : []).forEach(function(l) {
            pushGlobalRecord(records, '文献对比', l.title || l.name, stringifyFields(l, ['author', 'journal', 'year', 'field', 'summary', 'keywords']), '对比文献ID ' + (l.id || ''), l);
        });
        (typeof datasetData !== 'undefined' ? datasetData : []).forEach(function(d) {
            pushGlobalRecord(records, '数据集资源', d.name || d.title, stringifyFields(d, ['type', 'scenario', 'description', 'owner', 'size', 'format', 'source', 'remark']), '数据集ID ' + (d.id || ''), d);
        });
        (typeof reportData !== 'undefined' ? reportData : []).forEach(function(r) {
            pushGlobalRecord(records, '项目报告', r.name || r.title, stringifyFields(r, ['type', 'project', 'owner', 'description', 'summary', 'status', 'date', 'remark']), '报告ID ' + (r.id || ''), r);
        });
        (typeof sharedFileData !== 'undefined' ? sharedFileData : []).forEach(function(f) {
            pushGlobalRecord(records, '共享文件', f.name || f.fileName || f.originalName, stringifyFields(f, ['category', 'fileType', 'uploader', 'remark', 'description', 'uploadTime', 'fileSize', 'tags']), '文件ID ' + (f.id || ''), f);
        });
        (typeof longitudinalData !== 'undefined' ? longitudinalData : []).forEach(function(p) {
            pushGlobalRecord(records, '纵向项目', p.name || p.title || p.projectName, stringifyFields(p, ['leader', 'owner', 'status', 'source', 'funding', 'startDate', 'endDate', 'description', 'remark']), '项目ID ' + (p.id || ''), p);
        });
        (typeof horizontalData !== 'undefined' ? horizontalData : []).forEach(function(p) {
            pushGlobalRecord(records, '横向项目', p.name || p.title || p.projectName, stringifyFields(p, ['leader', 'owner', 'partner', 'company', 'status', 'funding', 'startDate', 'endDate', 'description', 'remark']), '项目ID ' + (p.id || ''), p);
        });
        (typeof schoolData !== 'undefined' ? schoolData : []).forEach(function(p) {
            pushGlobalRecord(records, '校级项目', p.name || p.title || p.projectName, stringifyFields(p, ['leader', 'owner', 'status', 'funding', 'startDate', 'endDate', 'description', 'remark']), '项目ID ' + (p.id || ''), p);
        });
        (typeof meetingData !== 'undefined' ? meetingData : []).forEach(function(m) {
            pushGlobalRecord(records, '会议安排', m.title || m.name || m.topic, stringifyFields(m, ['time', 'date', 'location', 'host', 'participants', 'content', 'agenda', 'summary']), '会议ID ' + (m.id || ''), m);
        });
        (typeof noticeData !== 'undefined' ? noticeData : []).forEach(function(n) {
            pushGlobalRecord(records, '通知公告', n.title || n.name, stringifyFields(n, ['content', 'publisher', 'date', 'type', 'status', 'summary']), '通知ID ' + (n.id || ''), n);
        });
        (typeof newsData !== 'undefined' ? newsData : []).forEach(function(n) {
            pushGlobalRecord(records, '团队新闻', n.title || n.name, stringifyFields(n, ['content', 'publisher', 'date', 'category', 'summary']), '新闻ID ' + (n.id || ''), n);
        });
        return records;
    }

    function expandQueryTokens(query) {
        const q = String(query || '').toLowerCase().trim();
        const tokens = [];
        const seen = {};
        const add = function(t) {
            t = String(t || '').trim();
            if (!t || t.length < 2) return;
            if (seen[t]) return;
            seen[t] = true;
            tokens.push(t);
        };
        if (!q) return tokens;
        add(q);
        q.split(/[\s,，。？?！!、；;：:（）()【】\[\]""''\/\-_]+/).forEach(add);
        const cjkRuns = q.match(/[\u4e00-\u9fff]+/g) || [];
        cjkRuns.forEach(function(run) {
            add(run);
            for (let i = 0; i < run.length - 1; i++) add(run.slice(i, i + 2));
            for (let i = 0; i < run.length - 2; i++) add(run.slice(i, i + 3));
        });
        const synonymGroups = [
            ['周报', '工作周报', '提交周报', '交周报', '周报提交'],
            ['什么时候', '何时', '几点', '截止', '截止时间', 'deadline', '时间'],
            ['交', '提交', '上交', '递交'],
            ['组会', '会议', '开会', '例会'],
            ['标注', '数据标注', '标注规范'],
            ['训练', '模型训练', 'yolo', 'yolov8'],
            ['mlops', '上报', '状态上报']
        ];
        synonymGroups.forEach(function(group) {
            let hit = false;
            for (let i = 0; i < group.length; i++) {
                if (q.indexOf(group[i]) >= 0 || seen[group[i]]) { hit = true; break; }
            }
            if (hit) group.forEach(add);
        });
        return tokens;
    }

    function scoreGlobalRecord(query, record) {
        const q = String(query || '').toLowerCase().trim();
        if (!q) return 0;
        const title = String(record.title || '').toLowerCase();
        const moduleName = String(record.module || '').toLowerCase();
        const ref = String(record.ref || '').toLowerCase();
        const content = String(record.content || '').toLowerCase();
        const blob = title + '\n' + moduleName + '\n' + ref + '\n' + content;
        let score = 0;
        if (title === q) score += 120;
        if (title.indexOf(q) >= 0) score += 48;
        if (content.indexOf(q) >= 0) score += 28;
        if (moduleName.indexOf(q) >= 0) score += 16;
        const tokens = expandQueryTokens(q);
        let matched = 0;
        tokens.forEach(function(t) {
            let local = 0;
            if (title.indexOf(t) >= 0) local += (t.length >= 3 ? 22 : 14);
            if (moduleName.indexOf(t) >= 0) local += 10;
            if (ref.indexOf(t) >= 0) local += 8;
            if (content.indexOf(t) >= 0) local += (t.length >= 3 ? 8 : 4);
            if (local > 0) {
                matched += 1;
                score += local;
            }
        });
        if (matched >= 2) score += 18;
        if (matched >= 3) score += 12;
        if ((moduleName.indexOf('知识') >= 0 || moduleName.indexOf('制度') >= 0) && matched > 0) score += 10;
        // 主题词强匹配：问周报却命中周报制度
        if (q.indexOf('周报') >= 0 && blob.indexOf('周报') >= 0) score += 36;
        if ((q.indexOf('交') >= 0 || q.indexOf('提交') >= 0 || q.indexOf('截止') >= 0 || q.indexOf('什么时候') >= 0) &&
            (blob.indexOf('提交') >= 0 || blob.indexOf('截止') >= 0 || blob.indexOf('22:00') >= 0 || blob.indexOf('交') >= 0)) {
            score += 24;
        }
        if (q.indexOf('组会') >= 0 && (blob.indexOf('组会') >= 0 || blob.indexOf('会议') >= 0)) score += 30;
        return score;
    }

    function retrieveGlobalTopK(query, k) {
        k = k || 8;
        return collectGlobalSearchRecords().map(function(record) {
            return { item: record, score: scoreGlobalRecord(query, record) };
        }).filter(function(x) {
            return x.score >= 18;
        }).sort(function(a, b) {
            return b.score - a.score;
        }).slice(0, k);
    }

    // ===== 顶部全局搜索 =====
    const GLOBAL_SEARCH_MODULE_MAP = {
        '知识库': 'chat',
        '制度流程': 'chat',
        '科研任务': 'task_management',
        '团队周报': 'weekly_report',
        '模型训练': 'model_training',
        'AI数据标注': 'data_annotation',
        '文献资料': 'literature_library',
        '文献对比': 'literature_analysis',
        '数据集资源': 'dataset_library',
        '项目报告': 'project_report',
        '共享文件': 'shared_files',
        '纵向项目': 'longitudinal_project',
        '横向项目': 'horizontal_project',
        '校级项目': 'school_project',
        '会议安排': 'meeting_management',
        '通知公告': 'notice_publish',
        '团队新闻': 'news_management'
    };
    let globalSearchResults = [];
    let globalSearchActiveIndex = -1;

    function onGlobalSearchInput() {
        const input = document.getElementById('globalSearchInput');
        const panel = document.getElementById('globalSearchPanel');
        if (!input || !panel) return;
        const q = input.value.trim();
        if (!q) { closeGlobalSearch(); return; }
        globalSearchResults = retrieveGlobalTopK(q, 10);
        globalSearchActiveIndex = -1;
        if (!globalSearchResults.length) {
            panel.innerHTML = '<div class="gs-empty">未找到与「' + escHtml(q) + '」相关的内容</div>';
            panel.classList.add('show');
            return;
        }
        panel.innerHTML = globalSearchResults.map(function(h, i) {
            const snippet = String(h.item.content || '').replace(/\s+/g, ' ').slice(0, 80);
            return '<button type="button" class="gs-item" data-idx="' + i + '" onclick="jumpGlobalSearch(' + i + ')">' +
                '<span class="gs-module">' + escHtml(h.item.module) + (h.item.ref ? ' · ' + escHtml(h.item.ref) : '') + '</span>' +
                '<div class="gs-title">' + escHtml(h.item.title || '(无标题)') + '</div>' +
                '<div class="gs-snippet">' + escHtml(snippet) + '</div>' +
            '</button>';
        }).join('');
        panel.classList.add('show');
    }

    function onGlobalSearchKeyDown(event) {
        const panel = document.getElementById('globalSearchPanel');
        if (!panel || !panel.classList.contains('show')) {
            if (event.key === 'Enter') onGlobalSearchInput();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            globalSearchActiveIndex = Math.min(globalSearchActiveIndex + 1, globalSearchResults.length - 1);
            highlightGlobalSearch();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            globalSearchActiveIndex = Math.max(globalSearchActiveIndex - 1, 0);
            highlightGlobalSearch();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            jumpGlobalSearch(globalSearchActiveIndex >= 0 ? globalSearchActiveIndex : 0);
        } else if (event.key === 'Escape') {
            closeGlobalSearch();
        }
    }

    function highlightGlobalSearch() {
        const panel = document.getElementById('globalSearchPanel');
        if (!panel) return;
        Array.prototype.forEach.call(panel.querySelectorAll('.gs-item'), function(el) {
            el.classList.toggle('active', Number(el.getAttribute('data-idx')) === globalSearchActiveIndex);
        });
        const active = panel.querySelector('.gs-item.active');
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    }

    function jumpGlobalSearch(idx) {
        const hit = globalSearchResults[idx];
        if (!hit) return;
        const moduleId = GLOBAL_SEARCH_MODULE_MAP[hit.item.module] || 'home';
        closeGlobalSearch();
        const input = document.getElementById('globalSearchInput');
        if (input) input.blur();
        if (typeof showModule === 'function') showModule(moduleId);
        if (moduleId === 'chat') {
            const box = document.getElementById('knowledgeSearch');
            if (box) { box.value = hit.item.title || ''; if (typeof renderKnowledgeList === 'function') renderKnowledgeList(); }
        }
    }

    function closeGlobalSearch() {
        const panel = document.getElementById('globalSearchPanel');
        if (panel) { panel.classList.remove('show'); panel.innerHTML = ''; }
        globalSearchResults = [];
        globalSearchActiveIndex = -1;
    }

    document.addEventListener('click', function(e) {
        const wrap = document.getElementById('globalSearchWrap');
        if (wrap && !wrap.contains(e.target)) closeGlobalSearch();
    });

    function buildLocalRagAnswer(query, hits) {
        if (!hits || !hits.length) {
            return {
                text: '未在全局数据中找到足够相关内容。你可以尝试更具体的关键词，例如任务名、成员名、项目名、训练 jobId、标注数据集、周报周期或文件名。',
                meta: '来源：无命中'
            };
        }
        const q = String(query || '');
        const top = hits[0].item;
        const topBlob = [top.title, top.content, top.module].join('\n');
        if (q.indexOf('周报') >= 0 && (q.indexOf('交') >= 0 || q.indexOf('提交') >= 0 || q.indexOf('截止') >= 0 || q.indexOf('什么时候') >= 0 || q.indexOf('何时') >= 0)) {
            const timeMatch = topBlob.match(/(\d{1,2}:\d{2})/);
            const dayHint = /每周[日一二三四五六]/.exec(topBlob);
            let direct = '根据团队制度/配置：';
            if (dayHint && timeMatch) {
                direct += dayHint[0] + ' ' + timeMatch[1] + ' 前提交周报。';
            } else if (timeMatch) {
                direct += '周报每周提交截止时间为 ' + timeMatch[1] + '。';
            } else {
                direct += top.content;
            }
            direct += '\n\n详细说明：\n' + top.content;
            if (hits.length > 1) {
                direct += '\n\n其他相关条目：\n' + hits.slice(1, 3).map(function(h, i) {
                    return (i + 2) + '. 【' + h.item.module + ' · ' + h.item.title + '】' + h.item.content.slice(0, 120);
                }).join('\n');
            }
            return {
                text: direct,
                meta: '来源：' + hits.map(function(h) { return h.item.module + '/' + h.item.title; }).join('、')
            };
        }
        const parts = hits.map(function(h, idx) {
            return (idx + 1) + '. 【' + h.item.module + ' · ' + h.item.title + '】'
                + (h.item.ref ? '\n标识：' + h.item.ref : '')
                + '\n' + h.item.content;
        });
        return {
            text: '根据全局数据检索，与「' + query + '」相关的内容如下：\n\n' + parts.join('\n\n'),
            meta: '来源：' + hits.map(function(h) { return h.item.module + '/' + h.item.title; }).join('、')
        };
    }

    async function callChatAliyun(query, hits) {
        const apiKey = getChatApiKey();
        if (!apiKey) throw new Error('no api key');
        const context = (hits || []).map(function(h, i) {
            return '[' + (i + 1) + '] 模块：' + h.item.module + '\n标题：' + h.item.title + (h.item.ref ? '\n标识：' + h.item.ref : '') + '\n内容：' + h.item.content;
        }).join('\n\n');
        const hasHits = !!(hits && hits.length);
        const messages = [
            {
                role: 'system',
                content: hasHits
                    ? '你是城市安全数智创新团队助手。必须优先且仅依据【全局检索上下文】回答团队内部问题（周报截止、组会、制度、任务等）。直接给出明确结论，可引用原文关键句；禁止说“不知道/未提供”如果上下文已有答案；禁止编造不存在的制度。'
                    : '你是城市安全数智创新团队助手。当前没有检索到团队内部资料；只能给一般性建议，并明确说明“未在团队知识库/全局数据中找到依据”，不要编造团队制度或截止时间。'
            },
            {
                role: 'user',
                content: (context ? ('【全局检索上下文】\n' + context + '\n\n') : '【全局检索上下文】\n（无命中）\n\n') + '【问题】\n' + query
            }
        ];
        const payload = {
            apiKey: apiKey,
            model: (document.getElementById('openaiModel') && document.getElementById('openaiModel').value) || 'qwen-plus',
            messages: messages,
            temperature: 0.2,
            max_tokens: 1200
        };
        const endpoints = [];
        try { endpoints.push('/api/aliyun'); } catch (e) {}
        if (typeof API_PROXY !== 'undefined' && API_PROXY) endpoints.push(String(API_PROXY).replace(/\/$/, '') + '/api/aliyun');
        let lastErr = null;
        for (let i = 0; i < endpoints.length; i++) {
            try {
                const resp = await fetch(endpoints[i], {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const text = await resp.text();
                if (!resp.ok) {
                    lastErr = new Error('HTTP ' + resp.status + ' ' + text.slice(0, 180));
                    continue;
                }
                let data = null;
                try { data = JSON.parse(text); } catch (e) { lastErr = e; continue; }
                const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
                if (content) {
                    return {
                        text: String(content).trim(),
                        meta: '大模型回答' + (hits && hits.length ? (' · 参考：' + hits.map(function(h) { return h.item.module + '/' + h.item.title; }).join('、')) : ' · 无检索命中')
                    };
                }
                lastErr = new Error('empty model response');
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('aliyun call failed');
    }

    function handleTeamChatKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendChatMessage();
        }
    }

    async function sendChatMessage() {
        if (teamChatBusy) return;
        const input = document.getElementById('chatInput');
        const btn = document.getElementById('chatSendBtn');
        const message = input ? input.value.trim() : '';
        if (!message) return;
        teamChatBusy = true;
        if (btn) { btn.disabled = true; btn.textContent = '思考中'; }
        appendChatBubble('user', message);
        teamChatHistory.push({ role: 'user', content: message });
        if (input) input.value = '';
        updateChatStats();
        showChatTyping();

        const hits = retrieveGlobalTopK(message, 8);
        const topScore = hits.length ? hits[0].score : 0;
        let answer;
        try {
            // 强命中时优先本地精确回答，避免大模型忽略上下文
            if (topScore >= 60 && /周报|组会|标注|训练|mlops|截止|提交/.test(message)) {
                answer = buildLocalRagAnswer(message, hits);
            } else if (getChatApiKey()) {
                answer = await callChatAliyun(message, hits);
            } else {
                answer = buildLocalRagAnswer(message, hits);
            }
        } catch (e) {
            const fallback = buildLocalRagAnswer(message, hits);
            answer = {
                text: fallback.text,
                meta: '大模型不可用，已回退全局检索 · ' + (e && e.message ? e.message : 'error')
            };
        }
        hideChatTyping();
        appendChatBubble('assistant', answer.text, answer.meta);
        teamChatHistory.push({ role: 'assistant', content: answer.text });
        teamChatBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = '发送'; }
        updateChatStats();
    }

    // 文献对比分析已抽离至 js/literature-compare.js（工程化模块）

    // 文档智能解析已抽离至 js/document-analysis.js

    // ===== 数据备份管理模块 =====
    let backupData = [];
    let autoBackupConfig = {};
    let currentBackupPage = 1;
    let backupPageSize = 10;
    let currentRestoreId = null;

    function initBackupModule() {
        loadBackupData();
        loadAutoBackupConfig();
        renderBackupList();
    }

    function loadBackupData() {
        try {
            const data = localStorage.getItem('backupData');
            if (data) {
                backupData = JSON.parse(data);
            } else {
                backupData = [];
            }
        } catch (e) {
            backupData = [];
        }
    }

    function loadAutoBackupConfig() {
        try {
            const data = localStorage.getItem('autoBackupConfig');
            if (data) {
                autoBackupConfig = JSON.parse(data);
            } else {
                autoBackupConfig = {
                    enableAuto: 0,
                    backupCycle: 2,
                    executeTime: '02:00',
                    backupType: 2,
                    saveCount: 10
                };
                saveAutoBackupConfigToStorage();
            }
        } catch (e) {
            autoBackupConfig = {
                enableAuto: 0,
                backupCycle: 2,
                executeTime: '02:00',
                backupType: 2,
                saveCount: 10
            };
        }
    }

    function saveAutoBackupConfigToStorage() {
        localStorage.setItem('autoBackupConfig', JSON.stringify(autoBackupConfig));
    }

    function saveBackupData() {
        localStorage.setItem('backupData', JSON.stringify(backupData));
    }

    function formatFileSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let index = 0;
        let size = bytes;
        while (size >= 1024 && index < units.length - 1) {
            size /= 1024;
            index++;
        }
        return size.toFixed(2) + ' ' + units[index];
    }

    function generateBackupName(type) {
        const typeStr = type === 1 ? 'db' : 'full';
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        return 'backup_' + typeStr + '_' + year + month + day + hour + minute + second;
    }

    function calculateFileMd5(data) {
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16).padStart(32, '0');
    }

    function handleFullBackup() {
        executeBackup(2);
    }

    function handleDbBackup() {
        executeBackup(1);
    }

    function executeBackup(backupType) {
        const fullBackupBtn = document.getElementById('fullBackupBtn');
        const dbBackupBtn = document.getElementById('dbBackupBtn');
        
        fullBackupBtn.disabled = true;
        dbBackupBtn.disabled = true;
        
        const backupName = generateBackupName(backupType);
        const now = new Date();
        
        const record = {
            id: backupData.length > 0 ? Math.max(...backupData.map(b => b.id)) + 1 : 1,
            backupName: backupName,
            backupType: backupType,
            backupWay: 1,
            fileSize: 0,
            filePath: '',
            fileMd5: '',
            status: 0,
            errorMsg: '',
            operatorId: currentUser ? currentUser.id : 0,
            operatorName: currentUser ? currentUser.name : 'admin',
            remark: '',
            createTime: now.toLocaleString('zh-CN'),
            updateTime: now.toLocaleString('zh-CN'),
            isDeleted: 0
        };
        
        backupData.unshift(record);
        saveBackupData();
        renderBackupList();
        
        setTimeout(() => {
            try {
                const allData = {
                    users: userData,
                    tasks: taskData,
                    weeklyReports: weeklyReportData,
                    projects: projectData,
                    patents: patentData,
                    papers: paperData,
                    standards: standardData,
                    softwares: softwareData,
                    news: newsData,
                    meetings: meetingData,
                    literature: literatureData,
                    datasets: datasetData,
                    reports: reportData,
                    sharedFiles: sharedFileData,
                    annotations: annotationData,
                    models: modelTrainingData,
                    chatHistory: chatHistory
                };
                
                const jsonString = JSON.stringify(allData, null, 2);
                const fileSize = new Blob([jsonString]).size;
                const fileMd5 = calculateFileMd5(jsonString);
                
                const recordIndex = backupData.findIndex(b => b.id === record.id);
                if (recordIndex > -1) {
                    backupData[recordIndex].status = 1;
                    backupData[recordIndex].fileSize = fileSize;
                    backupData[recordIndex].fileMd5 = fileMd5;
                    backupData[recordIndex].updateTime = new Date().toLocaleString('zh-CN');
                    saveBackupData();
                }
                
                const typeText = backupType === 1 ? '仅数据库' : '全量备份';
                recordOperationLog('数据备份', '备份', `执行手动备份：${record.backupName}，${typeText}`, { backupName: record.backupName, backupType: typeText, fileSize: formatFileSize(fileSize) }, { success: true }, 1, '', 0);
                
                cleanExpiredBackup(autoBackupConfig.saveCount);
            } catch (e) {
                const recordIndex = backupData.findIndex(b => b.id === record.id);
                if (recordIndex > -1) {
                    backupData[recordIndex].status = 2;
                    backupData[recordIndex].errorMsg = e.message;
                    backupData[recordIndex].updateTime = new Date().toLocaleString('zh-CN');
                    saveBackupData();
                }
            }
            
            renderBackupList();
            fullBackupBtn.disabled = false;
            dbBackupBtn.disabled = false;
        }, 500);
    }

    function cleanExpiredBackup(saveCount) {
        const successBackups = backupData.filter(b => b.status === 1 && b.isDeleted === 0)
                                         .sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
        
        if (successBackups.length <= saveCount) return;
        
        const expiredBackups = successBackups.slice(saveCount);
        expiredBackups.forEach(backup => {
            const index = backupData.findIndex(b => b.id === backup.id);
            if (index > -1) {
                backupData[index].isDeleted = 1;
            }
        });
        
        saveBackupData();
    }

    function renderBackupList() {
        const tableBody = document.getElementById('backupTableBody');
        const emptyDiv = document.getElementById('backupEmpty');
        const totalSpan = document.getElementById('backupTotal');
        const pageInfoSpan = document.getElementById('backupPageInfo');
        const prevBtn = document.getElementById('backupPrevBtn');
        const nextBtn = document.getElementById('backupNextBtn');
        
        const validBackups = backupData.filter(b => b.isDeleted === 0);
        const total = validBackups.length;
        const totalPages = Math.max(1, Math.ceil(total / backupPageSize));
        
        totalSpan.textContent = total;
        pageInfoSpan.textContent = currentBackupPage + ' / ' + totalPages;
        
        prevBtn.disabled = currentBackupPage <= 1;
        nextBtn.disabled = currentBackupPage >= totalPages;
        
        const start = (currentBackupPage - 1) * backupPageSize;
        const end = start + backupPageSize;
        const pageData = validBackups.slice(start, end);
        
        if (total === 0) {
            tableBody.innerHTML = '';
            emptyDiv.style.display = 'block';
            return;
        }
        
        emptyDiv.style.display = 'none';
        
        let html = '';
        pageData.forEach(backup => {
            const typeText = backup.backupType === 1 ? '仅数据库' : '全量备份';
            const typeClass = backup.backupType === 1 ? 'badge-info' : 'badge-success';
            const wayText = backup.backupWay === 1 ? '手动' : '自动';
            
            let statusHtml = '';
            if (backup.status === 0) {
                statusHtml = '<span class="badge badge-info">进行中</span>';
            } else if (backup.status === 1) {
                statusHtml = '<span class="badge badge-success">成功</span>';
            } else {
                statusHtml = '<span class="badge badge-danger">失败</span>';
            }
            
            const canDownload = backup.status === 1;
            const canRestore = backup.status === 1;
            
            html += `<tr>
                <td style="font-size:13px;">${escHtml(backup.backupName)}</td>
                <td><span class="badge ${typeClass}">${typeText}</span></td>
                <td>${wayText}</td>
                <td>${formatFileSize(backup.fileSize)}</td>
                <td>${statusHtml}</td>
                <td>${escHtml(backup.operatorName)}</td>
                <td style="font-size:12px;color:#666;">${escHtml(backup.createTime)}</td>
                <td>
                    <button class="btn btn-primary" style="padding:4px 8px;font-size:12px;margin-right:4px;" ${!canDownload ? 'disabled' : ''} onclick="downloadBackup(${backup.id})">下载</button>
                    <button class="btn btn-warning" style="padding:4px 8px;font-size:12px;margin-right:4px;" ${!canRestore ? 'disabled' : ''} onclick="openRestoreModal(${backup.id})">恢复</button>
                    <button class="btn btn-danger" style="padding:4px 8px;font-size:12px;" onclick="deleteBackup(${backup.id})">删除</button>
                </td>
            </tr>`;
        });
        
        tableBody.innerHTML = html;
    }

    // ===== 全量数据导出 / 导入（真实文件） =====
    const BACKUP_SENSITIVE_KEYS = ['openaiApiKey', 'aliyunApiKey', 'apiKey', 'dashscopeApiKey'];

    function exportAllDataToFile() {
        try {
            const payload = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                if (BACKUP_SENSITIVE_KEYS.indexOf(key) >= 0) continue;
                payload[key] = localStorage.getItem(key);
            }
            const meta = {
                __backupType: 'city-safety-team-system',
                __version: 1,
                __exportedAt: new Date().toISOString(),
                __exportedBy: (currentUser && (currentUser.realName || currentUser.username)) || 'unknown',
                __keyCount: Object.keys(payload).length
            };
            const blob = new Blob([JSON.stringify({ meta: meta, data: payload }, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const ts = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
            a.href = url;
            a.download = 'team-backup-' + ts + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
            if (typeof recordOperationLog === 'function') {
                recordOperationLog('数据备份', '导出', '导出全量数据文件（' + meta.__keyCount + ' 项，已排除密钥）', { keyCount: meta.__keyCount }, { success: true }, 1, '', 0);
            }
            alert('已导出 ' + meta.__keyCount + ' 项数据（不含 API 密钥）。请妥善保存备份文件。');
        } catch (e) {
            alert('导出失败：' + (e && e.message ? e.message : e));
        }
    }

    function importAllDataFromFile(event) {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file) return;
        if (currentUser && currentUser.role !== 'admin' && currentUser.role !== 'leader') {
            alert('仅管理员或组长可执行数据恢复');
            if (input) input.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = function() {
            let parsed;
            try {
                parsed = JSON.parse(String(reader.result || ''));
            } catch (e) {
                alert('导入失败：文件不是有效的 JSON');
                if (input) input.value = '';
                return;
            }
            const data = parsed && parsed.data ? parsed.data : parsed;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                alert('导入失败：备份文件格式不正确');
                if (input) input.value = '';
                return;
            }
            const keys = Object.keys(data);
            if (!keys.length) {
                alert('导入失败：备份文件为空');
                if (input) input.value = '';
                return;
            }
            const exportedAt = parsed && parsed.meta && parsed.meta.__exportedAt ? ('\n备份时间：' + parsed.meta.__exportedAt) : '';
            if (!confirm('确定用该备份覆盖当前数据吗？\n将写入 ' + keys.length + ' 项数据' + exportedAt + '\n\n此操作不可撤销，建议先“导出为文件”留存当前数据。')) {
                if (input) input.value = '';
                return;
            }
            try {
                keys.forEach(function(key) {
                    if (BACKUP_SENSITIVE_KEYS.indexOf(key) >= 0) return;
                    const val = data[key];
                    localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
                });
                if (typeof recordOperationLog === 'function') {
                    recordOperationLog('数据备份', '恢复', '从文件恢复全量数据（' + keys.length + ' 项）', { keyCount: keys.length, fileName: file.name }, { success: true }, 1, '', 0);
                }
                alert('恢复成功，写入 ' + keys.length + ' 项数据。页面将刷新以加载新数据。');
                location.reload();
            } catch (e) {
                alert('导入失败：' + (e && e.message ? e.message : e));
            } finally {
                if (input) input.value = '';
            }
        };
        reader.onerror = function() {
            alert('导入失败：文件读取错误');
            if (input) input.value = '';
        };
        reader.readAsText(file);
    }

    function prevBackupPage() {
        if (currentBackupPage > 1) {
            currentBackupPage--;
            renderBackupList();
        }
    }

    function nextBackupPage() {
        const total = backupData.filter(b => b.isDeleted === 0).length;
        const totalPages = Math.max(1, Math.ceil(total / backupPageSize));
        if (currentBackupPage < totalPages) {
            currentBackupPage++;
            renderBackupList();
        }
    }

    function downloadBackup(id) {
        const backup = backupData.find(b => b.id === id);
        if (!backup || backup.status !== 1) {
            alert('备份文件不可下载');
            return;
        }
        
        const allData = {
            users: userData,
            tasks: taskData,
            weeklyReports: weeklyReportData,
            projects: projectData,
            patents: patentData,
            papers: paperData,
            standards: standardData,
            softwares: softwareData,
            news: newsData,
            meetings: meetingData,
            literature: literatureData,
            datasets: datasetData,
            reports: reportData,
            sharedFiles: sharedFileData,
            annotations: annotationData,
            models: modelTrainingData,
            chatHistory: chatHistory
        };
        
        const jsonString = JSON.stringify(allData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = backup.backupName + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function openRestoreModal(id) {
        const backup = backupData.find(b => b.id === id);
        if (!backup) return;
        
        currentRestoreId = id;
        document.getElementById('restoreBackupName').value = backup.backupName;
        document.getElementById('restoreBackupTime').value = backup.createTime;
        document.getElementById('restoreAdminPassword').value = '';
        document.getElementById('restoreModal').style.display = 'flex';
    }

    function closeRestoreModal() {
        document.getElementById('restoreModal').style.display = 'none';
        currentRestoreId = null;
    }

    function confirmRestore() {
        const password = document.getElementById('restoreAdminPassword').value.trim();
        if (!password) {
            alert('请输入管理员密码');
            return;
        }
        
        if (password !== '123456') {
            alert('管理员密码错误，无法执行恢复');
            return;
        }
        
        if (!confirm('确认要恢复数据吗？此操作将覆盖当前所有数据！')) {
            return;
        }
        
        const restoreBtn = document.getElementById('confirmRestoreBtn');
        restoreBtn.disabled = true;
        
        setTimeout(() => {
            try {
                const backup = backupData.find(b => b.id === currentRestoreId);
                if (!backup) {
                    alert('备份记录不存在');
                    restoreBtn.disabled = false;
                    return;
                }
                
                const safetyBackup = {
                    id: backupData.length > 0 ? Math.max(...backupData.map(b => b.id)) + 1 : 1,
                    backupName: 'safety_restore_before_' + new Date().toLocaleString('zh-CN').replace(/[/:\s]/g, '_'),
                    backupType: backup.backupType,
                    backupWay: 1,
                    fileSize: 0,
                    filePath: '',
                    fileMd5: '',
                    status: 0,
                    errorMsg: '',
                    operatorId: currentUser ? currentUser.id : 0,
                    operatorName: currentUser ? currentUser.name : 'admin',
                    remark: '恢复前自动兜底备份',
                    createTime: new Date().toLocaleString('zh-CN'),
                    updateTime: new Date().toLocaleString('zh-CN'),
                    isDeleted: 0
                };
                
                const allData = {
                    users: userData,
                    tasks: taskData,
                    weeklyReports: weeklyReportData,
                    projects: projectData,
                    patents: patentData,
                    papers: paperData,
                    standards: standardData,
                    softwares: softwareData,
                    news: newsData,
                    meetings: meetingData,
                    literature: literatureData,
                    datasets: datasetData,
                    reports: reportData,
                    sharedFiles: sharedFileData,
                    annotations: annotationData,
                    models: modelTrainingData,
                    chatHistory: chatHistory
                };
                
                const jsonString = JSON.stringify(allData, null, 2);
                safetyBackup.fileSize = new Blob([jsonString]).size;
                safetyBackup.fileMd5 = calculateFileMd5(jsonString);
                safetyBackup.status = 1;
                
                backupData.unshift(safetyBackup);
                saveBackupData();
                
                recordOperationLog('数据备份', '恢复', `执行数据恢复：${backup.backupName}`, { backupName: backup.backupName, backupType: backup.backupType === 1 ? '仅数据库' : '全量备份' }, { success: true }, 1, '', 0);
                
                alert('数据恢复成功！');
                closeRestoreModal();
                renderBackupList();
            } catch (e) {
                alert('恢复失败：' + e.message);
            }
            
            restoreBtn.disabled = false;
        }, 500);
    }

    function deleteBackup(id) {
        if (!confirm('确定删除该备份文件？删除后不可恢复')) return;
        
        const index = backupData.findIndex(b => b.id === id);
        if (index > -1) {
            const backupName = backupData[index].backupName;
            backupData[index].isDeleted = 1;
            saveBackupData();
            renderBackupList();
            recordOperationLog('数据备份', '删除', `删除备份文件：${backupName}`, { backupName }, { success: true }, 1, '', 0);
            alert('已删除！');
        }
    }

    function openAutoBackupConfig() {
        document.getElementById('autoBackupEnable').checked = autoBackupConfig.enableAuto === 1;
        document.getElementById('autoBackupCycle').value = autoBackupConfig.backupCycle;
        document.getElementById('autoBackupTime').value = autoBackupConfig.executeTime;
        document.getElementById('autoBackupType').value = autoBackupConfig.backupType;
        document.getElementById('autoBackupSaveCount').value = autoBackupConfig.saveCount;
        
        toggleAutoBackupSwitch();
        
        document.getElementById('autoBackupConfigModal').style.display = 'flex';
    }

    function closeAutoBackupConfigModal() {
        document.getElementById('autoBackupConfigModal').style.display = 'none';
    }

    function toggleAutoBackupSwitch() {
        const enable = document.getElementById('autoBackupEnable').checked;
        const text = document.getElementById('autoBackupEnableText');
        text.textContent = enable ? '已开启' : '已关闭';
        text.style.color = enable ? '#10b981' : '#999';
    }

    function saveAutoBackupConfig() {
        autoBackupConfig = {
            enableAuto: document.getElementById('autoBackupEnable').checked ? 1 : 0,
            backupCycle: parseInt(document.getElementById('autoBackupCycle').value),
            executeTime: document.getElementById('autoBackupTime').value,
            backupType: parseInt(document.getElementById('autoBackupType').value),
            saveCount: parseInt(document.getElementById('autoBackupSaveCount').value)
        };
        
        setConfig('backup.keepCount', autoBackupConfig.saveCount);
        saveAutoBackupConfigToStorage();
        closeAutoBackupConfigModal();
        
        const cycleText = autoBackupConfig.backupCycle === 1 ? '每天' : autoBackupConfig.backupCycle === 2 ? '每周' : '每月';
        const typeText = autoBackupConfig.backupType === 1 ? '仅数据库' : '全量备份';
        const statusText = autoBackupConfig.enableAuto === 1 ? '开启' : '关闭';
        recordOperationLog('数据备份', '修改', `修改自动备份配置：${statusText}，周期${cycleText}，时间${autoBackupConfig.executeTime}，${typeText}，保留${autoBackupConfig.saveCount}份`, 
            { enableAuto: autoBackupConfig.enableAuto, backupCycle: cycleText, executeTime: autoBackupConfig.executeTime, backupType: typeText, saveCount: autoBackupConfig.saveCount }, 
            { success: true }, 1, '', 0);
        
        if (autoBackupConfig.enableAuto === 1) {
            alert('自动备份已开启！系统将在设定时间自动执行备份');
        } else {
            alert('自动备份已关闭');
        }
    }

    function checkAutoBackup() {
        if (autoBackupConfig.enableAuto !== 1) return;
        
        const now = new Date();
        const nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        
        if (nowTime !== autoBackupConfig.executeTime) return;
        
        let shouldExecute = false;
        const cycle = autoBackupConfig.backupCycle;
        
        if (cycle === 1) {
            shouldExecute = true;
        } else if (cycle === 2) {
            shouldExecute = now.getDay() === 1;
        } else if (cycle === 3) {
            shouldExecute = now.getDate() === 1;
        }
        
        if (shouldExecute) {
            executeBackup(autoBackupConfig.backupType);
            cleanExpiredBackup(autoBackupConfig.saveCount);
        }
    }

    setInterval(checkAutoBackup, 60000);

    // ===== 操作日志管理模块 =====
    let systemConfigData = {};
    let currentConfigTab = 'system';

    const DEFAULT_CONFIG = {
        'system.name': '城市安全数智创新团队管理系统',
        'system.copyright': '© 2026 城市安全数智创新团队 版权所有',
        'system.loginNotice': '欢迎使用课题组管理系统',
        'system.enableRegister': 'false',
        
        'user.defaultPassword': '123456',
        'user.passwordErrorLockCount': '5',
        'user.lockTime': '30',
        'user.sessionTimeout': '1440',
        'user.loginRemind': 'true',
        
        'business.weeklyDeadline': '22:00',
        'business.weeklyRemind': 'true',
        'business.taskExpireRemind': 'true',
        'business.autoGraduateArchive': 'false',
        'business.logKeepDays': '90',
        
        'file.maxSize': '10',
        'file.allowTypes': 'jpg,png,pdf,doc,docx,xls,xlsx,zip',
        'file.defaultAvatar': '/assets/default-avatar.png',
        
        'notice.siteMessage': 'true',
        'notice.weeklyRemindTime': '18:00',
        
        'backup.keepCount': '10',
        'backup.warnDiskThreshold': '80'
    };

    function loadSystemConfig() {
        try {
            const data = localStorage.getItem('systemConfigData');
            if (data) {
                systemConfigData = JSON.parse(data);
            } else {
                systemConfigData = { ...DEFAULT_CONFIG };
                saveSystemConfig();
            }
        } catch {
            systemConfigData = { ...DEFAULT_CONFIG };
        }
    }

    function saveSystemConfig() {
        localStorage.setItem('systemConfigData', JSON.stringify(systemConfigData));
    }

    function getConfig(key, defaultValue = null) {
        if (systemConfigData[key] !== undefined) {
            return systemConfigData[key];
        }
        return DEFAULT_CONFIG[key] !== undefined ? DEFAULT_CONFIG[key] : defaultValue;
    }

    function getConfigInt(key, defaultValue = 0) {
        const value = getConfig(key);
        if (value === null || value === undefined) return defaultValue;
        try {
            return parseInt(value, 10);
        } catch {
            return defaultValue;
        }
    }

    function getConfigBoolean(key, defaultValue = false) {
        const value = getConfig(key);
        if (value === null || value === undefined) return defaultValue;
        return value === 'true' || value === true;
    }

    function setConfig(key, value) {
        systemConfigData[key] = String(value);
        saveSystemConfig();
        applyConfigToUI(key);
    }

    function _fmtSize(bytes) {
        var n = Number(bytes) || 0;
        if (n <= 0) return '0 B';
        var u = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return n.toFixed(i === 0 ? 0 : (n >= 100 ? 0 : 1)) + ' ' + u[i];
    }

    function _storageTile(label, value, sub, color) {
        return '<div style="flex:1 1 130px;min-width:120px;background:#fff;border:1px solid #eee;border-radius:12px;padding:12px 14px;">' +
            '<div style="font-size:12px;color:#6b7280;margin-bottom:4px;">' + escHtml(label) + '</div>' +
            '<div style="font-size:20px;font-weight:700;color:' + color + ';">' + escHtml(value) + '</div>' +
            (sub ? '<div style="font-size:11px;color:#9ca3af;margin-top:2px;">' + escHtml(sub) + '</div>' : '') +
            '</div>';
    }

    // 存储协同面板：读取 /api/storage/usage（无需登录，服务端真值→多端一致），
    // 同时展示"磁盘物理容量"与"应用各模块真实占用"，并联动系统配置页的后端上限说明。
    async function renderStorageStats(force) {
        var body = document.getElementById('storageStatsBody');
        if (!body) return;
        if (force) body.innerHTML = '<div style="color:#9ca3af;">正在刷新…</div>';
        try {
            var r = await fetch('/api/storage/usage', { cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var s = await r.json();
            var disk = s.disk || {}, u = s.usage || {}, lim = s.limits || {};
            var total = Number(disk.totalGB) || 0;
            var free = Number(disk.freeGB) || 0;
            var usedPct = Number(disk.usedPercent) || 0;
            var used = Math.max(0, total - free);
            var barColor = usedPct >= 90 ? '#e5484d' : (usedPct >= 75 ? '#f5a623' : '#7c3aed');
            function g(o, k) { return (o && o[k]) || {}; }
            body.innerHTML =
                '<div style="font-size:12px;color:#6b7280;margin:0 0 8px;font-weight:600;">磁盘容量（服务端物理盘）</div>' +
                '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;">' +
                    _storageTile('总容量', total.toFixed(1) + ' GB', '', '#4f46e5') +
                    _storageTile('已用', used.toFixed(1) + ' GB', '含系统与其他', barColor) +
                    _storageTile('还能存（剩余）', free.toFixed(1) + ' GB', '', '#16a34a') +
                '</div>' +
                '<div style="background:#eef2f7;border-radius:999px;height:12px;overflow:hidden;">' +
                    '<div style="height:100%;width:' + Math.min(100, usedPct) + '%;background:' + barColor + ';transition:width .4s;"></div>' +
                '</div>' +
                '<div style="font-size:12px;color:#6b7280;margin-top:5px;">磁盘已用 ' + usedPct + '% · 存储后端：' + escHtml(String(s.storageBackend || '-')) + '</div>' +
                '<div style="font-size:12px;color:#6b7280;margin:16px 0 8px;font-weight:600;">应用数据占用（各模块实际存了多少）</div>' +
                '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
                    _storageTile('共享文件', _fmtSize(g(u, 'shared').bytes), (g(u, 'shared').count || 0) + ' 个', '#0ea5e9') +
                    _storageTile('数据集', _fmtSize(g(u, 'datasets').bytes), (g(u, 'datasets').count || 0) + ' 个', '#8b5cf6') +
                    _storageTile('标注', _fmtSize(g(u, 'annotations').bytes), (g(u, 'annotations').count || 0) + ' 个', '#f59e0b') +
                    _storageTile('应用合计', _fmtSize(u.appTotalBytes), '', '#111827') +
                '</div>' +
                '<div style="font-size:12px;color:#9ca3af;margin-top:12px;">单文件上限：数据集 ' + _fmtSize(lim.datasetMaxBytes) +
                    ' · 共享文件直传 ' + _fmtSize(lim.sharedPresignMaxBytes) + ' · 网关兜底 ' + _fmtSize(lim.sharedGatewayMaxBytes) +
                    '（分片 ' + _fmtSize(lim.datasetChunkSize) + '）</div>';
            var ts = document.getElementById('storageUpdatedAt');
            if (ts) ts.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
            // 协同：把后端真实上限写进系统配置"文件上传"页的说明，终结 UI 与后端脱节
            var noteEl = document.getElementById('fileLimitsBackendNote');
            if (noteEl) {
                noteEl.textContent = '后端实际上限（全系统生效，真值来自网关）：数据集 ' + _fmtSize(lim.datasetMaxBytes) +
                    '，共享文件浏览器直传 ' + _fmtSize(lim.sharedPresignMaxBytes) + '，网关直传兜底 ' + _fmtSize(lim.sharedGatewayMaxBytes) + '。';
            }
        } catch (e) {
            body.innerHTML = '<div style="color:#e5484d;">读取失败：' + escHtml(String((e && e.message) || e)) + '（请确认网关运行中）</div>';
        }
    }

    function initSystemConfigModule() {
        loadSystemConfig();
        renderConfigForm();
        applyAllConfigToUI();
        renderStorageStats();
        // 面板可见时每 30s 自动刷新；离开该模块（元素消失）自动停止，避免定时器泄漏
        if (window.__storageStatsTimer) clearInterval(window.__storageStatsTimer);
        window.__storageStatsTimer = setInterval(function () {
            if (document.getElementById('storageStatsBody')) {
                renderStorageStats();
            } else {
                clearInterval(window.__storageStatsTimer);
                window.__storageStatsTimer = null;
            }
        }, 30000);
    }

    function switchConfigTab(tabName, btn) {
        currentConfigTab = tabName;
        
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById('tab_' + tabName).classList.add('active');
    }

    function renderConfigForm() {
        for (const key in DEFAULT_CONFIG) {
            const el = document.getElementById('cfg_' + key);
            if (el) {
                const value = getConfig(key);
                if (el.type === 'checkbox') {
                    el.checked = value === 'true';
                } else {
                    el.value = value;
                }
            }
        }
    }

    function applyAllConfigToUI() {
        const systemName = getConfig('system.name', '城市安全数智创新团队管理系统');
        
        const titleEl = document.querySelector('title');
        if (titleEl) titleEl.textContent = systemName;
        
        const headerTitle = document.getElementById('headerTitle');
        if (headerTitle) headerTitle.textContent = systemName;
        
        const loginTitle = document.getElementById('loginTitle');
        if (loginTitle) loginTitle.textContent = systemName;
        
        const copyright = getConfig('system.copyright', '© 2026 城市安全数智创新团队 版权所有');
        const footerEl = document.getElementById('footerCopyright');
        if (footerEl) footerEl.textContent = copyright;
        
        const loginNotice = getConfig('system.loginNotice', '');
        const noticeEl = document.getElementById('loginNotice');
        if (noticeEl) {
            noticeEl.textContent = loginNotice;
            noticeEl.style.display = loginNotice ? 'block' : 'none';
        }
    }

    function applyConfigToUI(key) {
        if (key === 'system.name') {
            const value = getConfig('system.name');
            const titleEl = document.querySelector('title');
            if (titleEl) titleEl.textContent = value;
            const headerTitle = document.getElementById('headerTitle');
            if (headerTitle) headerTitle.textContent = value;
            const loginTitle = document.getElementById('loginTitle');
            if (loginTitle) loginTitle.textContent = value;
        } else if (key === 'system.copyright') {
            const footerEl = document.getElementById('footerCopyright');
            if (footerEl) footerEl.textContent = getConfig('system.copyright');
        } else if (key === 'system.loginNotice') {
            const noticeEl = document.getElementById('loginNotice');
            if (noticeEl) {
                noticeEl.textContent = getConfig('system.loginNotice');
                noticeEl.style.display = noticeEl.textContent ? 'block' : 'none';
            }
        }
    }

    function saveCurrentConfig() {
        const tabPrefix = 'cfg_' + currentConfigTab + '.';
        let hasChanges = false;
        
        for (const key in DEFAULT_CONFIG) {
            if (key.startsWith(currentConfigTab + '.')) {
                const el = document.getElementById('cfg_' + key);
                if (el) {
                    let newValue;
                    if (el.type === 'checkbox') {
                        newValue = el.checked ? 'true' : 'false';
                    } else {
                        newValue = el.value;
                    }
                    
                    if (systemConfigData[key] !== newValue) {
                        systemConfigData[key] = newValue;
                        hasChanges = true;
                        applyConfigToUI(key);
                    }
                }
            }
        }
        
        if (hasChanges) {
            saveSystemConfig();
            recordOperationLog('系统设置', '修改', `修改${getConfigTabName(currentConfigTab)}配置`, { tab: currentConfigTab }, { success: true }, 1, '', 0);
            alert('配置保存成功，已实时生效！');
        } else {
            alert('没有任何修改');
        }
    }

    function resetCurrentConfig() {
        const tabPrefix = 'cfg_' + currentConfigTab + '.';
        
        for (const key in DEFAULT_CONFIG) {
            if (key.startsWith(currentConfigTab + '.')) {
                const el = document.getElementById('cfg_' + key);
                if (el) {
                    const defaultValue = DEFAULT_CONFIG[key];
                    if (el.type === 'checkbox') {
                        el.checked = defaultValue === 'true';
                    } else {
                        el.value = defaultValue;
                    }
                    systemConfigData[key] = defaultValue;
                }
            }
        }
        
        saveSystemConfig();
        alert('已重置为默认值');
    }

    function getConfigTabName(tab) {
        const names = {
            system: '系统基本信息',
            user: '用户与安全',
            business: '业务规则',
            file: '文件上传',
            notice: '通知提醒',
            backup: '备份与运维'
        };
        return names[tab] || tab;
    }

    let operationLogData = [];
    let currentLogPage = 1;
    let logPageSize = 10;
    let selectedLogIds = [];

    function initOperationLogModule() {
        loadOperationLogData();
        cleanExpiredLogs();
        renderOperationLogList();
        
        setInterval(cleanExpiredLogs, 24 * 60 * 60 * 1000);
    }

    function cleanExpiredLogs() {
        const retentionDays = getConfigInt('business.logKeepDays', 90);
        const expireTime = new Date();
        expireTime.setDate(expireTime.getDate() - retentionDays);
        
        const expiredCount = operationLogData.filter(log => {
            try {
                const logTime = new Date(log.operationTime);
                return logTime < expireTime;
            } catch {
                return false;
            }
        }).length;
        
        operationLogData = operationLogData.filter(log => {
            try {
                const logTime = new Date(log.operationTime);
                return logTime >= expireTime;
            } catch {
                return true;
            }
        });
        
        if (expiredCount > 0) {
            saveOperationLogData();
        }
    }

    function loadOperationLogData() {
        try {
            const data = localStorage.getItem('operationLogData');
            if (data) {
                operationLogData = JSON.parse(data);
            } else {
                operationLogData = [];
            }
        } catch (e) {
            operationLogData = [];
        }
    }

    function saveOperationLogData() {
        localStorage.setItem('operationLogData', JSON.stringify(operationLogData));
    }

    function getClientIp() {
        return '127.0.0.1';
    }

    function getBrowserInfo() {
        const ua = navigator.userAgent;
        if (ua.includes('Chrome')) return 'Chrome';
        if (ua.includes('Firefox')) return 'Firefox';
        if (ua.includes('Safari')) return 'Safari';
        if (ua.includes('Edge')) return 'Edge';
        if (ua.includes('IE')) return 'IE';
        return 'Unknown';
    }

    function getOsInfo() {
        const ua = navigator.userAgent;
        if (ua.includes('Windows')) return 'Windows';
        if (ua.includes('Mac OS')) return 'Mac OS';
        if (ua.includes('Linux')) return 'Linux';
        if (ua.includes('Android')) return 'Android';
        if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
        return 'Unknown';
    }

    function desensitizeData(data) {
        if (!data) return data;
        let result = data;
        result = result.replace(/"password"\s*:\s*"[^"]*"/g, '"password":"***"');
        result = result.replace(/"pwd"\s*:\s*"[^"]*"/g, '"pwd":"***"');
        result = result.replace(/"phone"\s*:\s*"[^"]*"/g, '"phone":"***"');
        result = result.replace(/"email"\s*:\s*"[^"]*"/g, '"email":"***"');
        return result;
    }

    function resolveLogOperatorProfile(log) {
        const result = {
            displayName: '',
            studentId: '',
            role: '',
            roleLabel: '',
            grade: '',
            source: '',
            account: null,
            member: null,
            memberId: null
        };
        let params = {};
        try {
            if (log && log.requestParams) params = JSON.parse(log.requestParams) || {};
        } catch (e) {}

        const accounts = (typeof accountData !== 'undefined' && Array.isArray(accountData)) ? accountData : [];
        let account = null;
        if (log && log.operatorId) {
            account = accounts.find(function(a) { return a && Number(a.id) === Number(log.operatorId); }) || null;
        }
        if (!account && params.studentId) {
            account = accounts.find(function(a) { return a && a.studentId === params.studentId; }) || null;
        }
        if (!account && (params.realName || log.operatorName)) {
            const nameHint = params.realName || log.operatorName;
            account = accounts.find(function(a) { return a && a.realName === nameHint; }) || null;
        }
        // 历史脏数据：operatorName 写成了 admin / studentId
        if (!account && log && log.operatorName) {
            account = accounts.find(function(a) { return a && a.studentId === log.operatorName; }) || null;
        }

        result.account = account;
        if (account) {
            result.displayName = account.realName || account.studentId || '';
            result.studentId = account.studentId || '';
            result.role = account.role || '';
            result.roleLabel = (typeof ROLE_LABELS !== 'undefined' && ROLE_LABELS[account.role]) ? ROLE_LABELS[account.role] : (account.role || '');
            if (account.role === 'visitor') {
                result.source = '访客账号';
                result.grade = '-';
            } else {
                const member = (typeof findTeamMemberForAccount === 'function') ? findTeamMemberForAccount(account) : null;
                result.member = member;
                result.memberId = member ? member.id : null;
                result.source = member ? '团队成员' : '账号库';
                if (member && typeof getMemberCategoryLabel === 'function') {
                    result.grade = member.category === 'advisor' ? '导师' : getMemberCategoryLabel(member.category);
                } else {
                    result.grade = account.grade || '-';
                }
            }
        } else {
            // 从描述里尽量还原「姓名(学号)」
            const desc = String((log && log.operationDesc) || '');
            const m = desc.match(/^([^\s(（]+)[(（]([^)）]+)[)）]/);
            if (m) {
                result.displayName = m[1];
                result.studentId = m[2];
            } else {
                result.displayName = (log && log.operatorName) || '未知';
                result.studentId = params.studentId || '';
            }
            result.source = '历史记录';
            result.roleLabel = '-';
            result.grade = '-';
        }
        if (!result.displayName) result.displayName = '未知';
        return result;
    }

    function formatLogOperatorCell(log) {
        const p = resolveLogOperatorProfile(log);
        const sid = p.studentId ? ('<div style="font-size:11px;color:#888;margin-top:2px;">' + escHtml(p.studentId) + '</div>') : '';
        return '<div><strong>' + escHtml(p.displayName) + '</strong>' + sid + '</div>';
    }

    function recordOperationLog(module, type, desc, params = null, response = null, status = 1, errorMsg = '', costTime = 0, opId = null, opName = null) {
        const now = new Date();
        const user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
        const resolvedId = opId !== null && opId !== undefined
            ? opId
            : (user ? user.id : 0);
        const resolvedName = opName !== null && opName !== undefined && String(opName).trim()
            ? String(opName).trim()
            : (user ? (user.realName || user.studentId || '系统') : '系统');
        const enrichedParams = Object.assign({}, (params && typeof params === 'object' ? params : {}), {
            studentId: (params && params.studentId) || (user && user.studentId) || undefined,
            realName: (params && params.realName) || (user && user.realName) || resolvedName || undefined,
            role: (params && params.role) || (user && user.role) || undefined
        });
        Object.keys(enrichedParams).forEach(function(k) {
            if (enrichedParams[k] === undefined) delete enrichedParams[k];
        });

        const log = {
            id: operationLogData.length > 0 ? Math.max(...operationLogData.map(l => l.id)) + 1 : 1,
            module: module,
            operationType: type,
            operationDesc: desc,
            requestMethod: 'POST',
            requestUrl: '/system/operation',
            requestParams: Object.keys(enrichedParams).length ? desensitizeData(JSON.stringify(enrichedParams)) : (params ? desensitizeData(JSON.stringify(params)) : null),
            responseResult: response ? desensitizeData(JSON.stringify(response)) : null,
            operatorId: resolvedId,
            operatorName: resolvedName,
            ipAddress: getClientIp(),
            ipLocation: '本地',
            browser: getBrowserInfo(),
            os: getOsInfo(),
            costTime: costTime,
            status: status,
            errorMsg: errorMsg,
            operationTime: now.toLocaleString('zh-CN')
        };

        operationLogData.unshift(log);
        if (operationLogData.length > 2000) operationLogData = operationLogData.slice(0, 2000);
        saveOperationLogData();

        if (document.getElementById('operation_log') && document.getElementById('operation_log').classList.contains('active')) {
            renderOperationLogList();
        }
    }

    function toggleLogSelectAll() {
        const selectAll = document.getElementById('logSelectAll').checked;
        const checkboxes = document.querySelectorAll('.log-checkbox');
        selectedLogIds = [];
        
        checkboxes.forEach(cb => {
            cb.checked = selectAll;
            if (selectAll) {
                selectedLogIds.push(parseInt(cb.value));
            }
        });
        
        updateBatchDeleteBtn();
    }

    function toggleLogSelect(id) {
        const index = selectedLogIds.indexOf(id);
        if (index > -1) {
            selectedLogIds.splice(index, 1);
        } else {
            selectedLogIds.push(id);
        }
        
        const selectAll = document.getElementById('logSelectAll');
        const checkboxes = document.querySelectorAll('.log-checkbox');
        selectAll.checked = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);
        
        updateBatchDeleteBtn();
    }

    function updateBatchDeleteBtn() {
        const btn = document.getElementById('batchDeleteLogBtn');
        btn.disabled = selectedLogIds.length === 0;
    }

    function getFilteredOperationLogs() {
        let filteredData = [...operationLogData];
        const module = (document.getElementById('logModule') || {}).value || '';
        const operator = (document.getElementById('logOperator') || {}).value || '';
        const status = (document.getElementById('logStatus') || {}).value;
        const startDate = (document.getElementById('logStartDate') || {}).value || '';
        const endDate = (document.getElementById('logEndDate') || {}).value || '';

        const moduleQ = String(module).trim();
        const operatorQ = String(operator).trim().toLowerCase();

        if (moduleQ) {
            filteredData = filteredData.filter(l => String(l.module || '').includes(moduleQ));
        }
        if (operatorQ) {
            filteredData = filteredData.filter(function(l) {
                const p = resolveLogOperatorProfile(l);
                return String(p.displayName || '').toLowerCase().includes(operatorQ)
                    || String(p.studentId || '').toLowerCase().includes(operatorQ)
                    || String(l.operatorName || '').toLowerCase().includes(operatorQ)
                    || String(l.operationDesc || '').toLowerCase().includes(operatorQ);
            });
        }
        if (status !== '' && status !== undefined && status !== null) {
            filteredData = filteredData.filter(l => l.status === parseInt(status));
        }
        if (startDate) {
            filteredData = filteredData.filter(l => l.operationTime >= startDate);
        }
        if (endDate) {
            filteredData = filteredData.filter(l => l.operationTime <= endDate + ' 23:59:59');
        }
        return filteredData;
    }

    function renderOperationLogList() {
        const tableBody = document.getElementById('logTableBody');
        const emptyDiv = document.getElementById('logEmpty');
        const totalSpan = document.getElementById('logTotal');
        const pageInfoSpan = document.getElementById('logPageInfo');
        const prevBtn = document.getElementById('logPrevBtn');
        const nextBtn = document.getElementById('logNextBtn');
        if (!tableBody) return;

        const filteredData = getFilteredOperationLogs();
        const total = filteredData.length;
        const totalPages = Math.max(1, Math.ceil(total / logPageSize));
        if (currentLogPage > totalPages) currentLogPage = totalPages;

        if (totalSpan) totalSpan.textContent = total;
        if (pageInfoSpan) pageInfoSpan.textContent = currentLogPage + ' / ' + totalPages;
        if (prevBtn) prevBtn.disabled = currentLogPage <= 1;
        if (nextBtn) nextBtn.disabled = currentLogPage >= totalPages;

        const start = (currentLogPage - 1) * logPageSize;
        const pageData = filteredData.slice(start, start + logPageSize);

        if (total === 0) {
            tableBody.innerHTML = '';
            if (emptyDiv) emptyDiv.style.display = 'block';
            return;
        }
        if (emptyDiv) emptyDiv.style.display = 'none';

        let html = '';
        pageData.forEach(log => {
            const isSelected = selectedLogIds.includes(log.id);
            const statusHtml = log.status === 1 
                ? '<span class="badge badge-success">成功</span>' 
                : '<span class="badge badge-danger">失败</span>';

            html += `<tr>
                <td><input type="checkbox" class="log-checkbox" value="${log.id}" ${isSelected ? 'checked' : ''} onchange="toggleLogSelect(${log.id})"></td>
                <td>${escHtml(log.module)}</td>
                <td>${escHtml(log.operationType)}</td>
                <td style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escHtml(log.operationDesc)}">${escHtml(log.operationDesc)}</td>
                <td>${formatLogOperatorCell(log)}</td>
                <td>${escHtml(log.ipAddress)}</td>
                <td>${statusHtml}</td>
                <td style="text-align: right;">${log.costTime}</td>
                <td style="font-size: 12px; color: #666;">${escHtml(log.operationTime)}</td>
                <td>
                    <button class="btn btn-primary" style="padding: 4px 8px; font-size: 12px;" onclick="openLogDetail(${log.id})">详情</button>
                </td>
            </tr>`;
        });

        tableBody.innerHTML = html;
    }

    function prevLogPage() {
        if (currentLogPage > 1) {
            currentLogPage--;
            renderOperationLogList();
        }
    }

    function nextLogPage() {
        const total = getFilteredOperationLogs().length;
        const totalPages = Math.max(1, Math.ceil(total / logPageSize));
        if (currentLogPage < totalPages) {
            currentLogPage++;
            renderOperationLogList();
        }
    }

    function handleLogQuery() {
        currentLogPage = 1;
        renderOperationLogList();
    }

    function resetLogQuery() {
        document.getElementById('logModule').value = '';
        document.getElementById('logOperator').value = '';
        document.getElementById('logStatus').value = '';
        document.getElementById('logStartDate').value = '';
        document.getElementById('logEndDate').value = '';
        currentLogPage = 1;
        selectedLogIds = [];
        document.getElementById('logSelectAll').checked = false;
        updateBatchDeleteBtn();
        renderOperationLogList();
    }

    var __currentLogDetailMemberId = null;

    function openLogDetail(id) {
        const log = operationLogData.find(l => l.id === id);
        if (!log) return;

        const profile = resolveLogOperatorProfile(log);
        __currentLogDetailMemberId = profile.memberId || null;

        const statusBadge = document.getElementById('detailStatusBadge');
        if (statusBadge) {
            statusBadge.innerHTML = log.status === 1
                ? '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;font-size:12px;">成功</span>'
                : '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:#fff2f0;color:#cf1322;border:1px solid #ffccc7;font-size:12px;">失败</span>';
        }

        const opCard = document.getElementById('detailOperatorCard');
        if (opCard) {
            const initial = String(profile.displayName || '?').charAt(0);
            const metaBits = [
                profile.roleLabel && profile.roleLabel !== '-' ? profile.roleLabel : '',
                profile.grade && profile.grade !== '-' ? profile.grade : '',
                profile.source || ''
            ].filter(Boolean).join(' · ');
            opCard.innerHTML = `
                <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0;">${escHtml(initial)}</div>
                <div style="min-width:0;flex:1;">
                    <div style="font-size:16px;font-weight:700;color:#1f2937;">${escHtml(profile.displayName)}</div>
                    <div style="font-size:12px;color:#6b7280;margin-top:4px;">${escHtml(profile.studentId || '无登录账号')} ${metaBits ? ' · ' + escHtml(metaBits) : ''}</div>
                </div>`;
        }

        const openBtn = document.getElementById('detailOpenMemberBtn');
        if (openBtn) openBtn.style.display = profile.memberId ? '' : 'none';

        document.getElementById('detailModule').textContent = log.module || '-';
        document.getElementById('detailType').textContent = log.operationType || '-';
        document.getElementById('detailOperator').textContent = profile.displayName || '-';
        document.getElementById('detailIp').textContent = (log.ipAddress || '-') + (log.ipLocation ? '（' + log.ipLocation + '）' : '');
        document.getElementById('detailMethod').textContent = log.requestMethod || '-';
        document.getElementById('detailCostTime').textContent = (log.costTime || 0) + ' ms';
        document.getElementById('detailTime').textContent = log.operationTime || '-';
        document.getElementById('detailUrl').textContent = log.requestUrl || '-';
        document.getElementById('detailDesc').textContent = log.operationDesc || '-';
        const clientEl = document.getElementById('detailClient');
        if (clientEl) clientEl.textContent = [log.browser, log.os].filter(Boolean).join(' / ') || '-';
        
        try {
            const params = log.requestParams ? JSON.stringify(JSON.parse(log.requestParams), null, 2) : '-';
            document.getElementById('detailParams').textContent = params;
        } catch {
            document.getElementById('detailParams').textContent = log.requestParams || '-';
        }
        
        try {
            const response = log.responseResult ? JSON.stringify(JSON.parse(log.responseResult), null, 2) : '-';
            document.getElementById('detailResponse').textContent = response;
        } catch {
            document.getElementById('detailResponse').textContent = log.responseResult || '-';
        }

        const errorContainer = document.getElementById('detailErrorContainer');
        if (log.status === 0 && log.errorMsg) {
            errorContainer.style.display = 'block';
            document.getElementById('detailError').textContent = log.errorMsg;
        } else {
            errorContainer.style.display = 'none';
        }

        document.getElementById('logDetailModal').style.display = 'flex';
    }

    function openMemberFromLogDetail() {
        if (!__currentLogDetailMemberId) return;
        var mid = __currentLogDetailMemberId;
        closeLogDetailModal();
        try {
            var go = function () {
                if (typeof showMemberDetail === 'function') showMemberDetail(mid);
            };
            if (typeof showModule === 'function') {
                Promise.resolve(showModule('member_archive')).then(function () {
                    setTimeout(go, 80);
                }).catch(function () { setTimeout(go, 200); });
            } else {
                setTimeout(go, 200);
            }
        } catch (e) {}
    }

    function closeLogDetailModal() {
        document.getElementById('logDetailModal').style.display = 'none';
        __currentLogDetailMemberId = null;
    }

    function handleBatchDeleteLog() {
        if (selectedLogIds.length === 0) return;
        
        if (!confirm(`确定删除选中的 ${selectedLogIds.length} 条日志？删除后不可恢复`)) return;

        operationLogData = operationLogData.filter(l => !selectedLogIds.includes(l.id));
        saveOperationLogData();
        
        selectedLogIds = [];
        document.getElementById('logSelectAll').checked = false;
        updateBatchDeleteBtn();
        renderOperationLogList();
        
        alert('已删除！');
    }

    function handleCleanAllLog() {
        if (!confirm('确定清空全部操作日志？清空后不可恢复！')) return;

        operationLogData = [];
        saveOperationLogData();
        
        selectedLogIds = [];
        document.getElementById('logSelectAll').checked = false;
        updateBatchDeleteBtn();
        renderOperationLogList();
        
        recordOperationLog('系统设置', '删除', '清空所有操作日志', {}, { success: true }, 1, '', 0);
        
        alert('已清空全部日志！');
    }

    function handleExportLog() {
        const filteredData = getFilteredOperationLogs();

        if (filteredData.length === 0) {
            alert('没有数据可导出');
            return;
        }

        const headers = ['操作模块', '操作类型', '操作描述', '操作人', '登录账号', '身份来源', '操作IP', '状态', '耗时(ms)', '操作时间'];
        let csv = headers.join(',') + '\n';

        filteredData.forEach(log => {
            const statusText = log.status === 1 ? '成功' : '失败';
            const p = resolveLogOperatorProfile(log);
            const row = [
                `"${log.module || ''}"`,
                `"${log.operationType || ''}"`,
                `"${(log.operationDesc || '').replace(/"/g, '""')}"`,
                `"${(p.displayName || '').replace(/"/g, '""')}"`,
                `"${(p.studentId || '').replace(/"/g, '""')}"`,
                `"${(p.source || '').replace(/"/g, '""')}"`,
                `"${log.ipAddress || ''}"`,
                `"${statusText}"`,
                `"${log.costTime || 0}"`,
                `"${log.operationTime || ''}"`
            ];
            csv += row.join(',') + '\n';
        });

        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '操作日志_' + new Date().toLocaleString('zh-CN').replace(/[/:\s]/g, '_') + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    