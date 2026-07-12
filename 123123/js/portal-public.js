/**
 * 公开门户五页：团队介绍 / 成果 / 项目 / 成员 / 联系我们
 * 数据同源聚合后台业务数组，样式由 css/portal-public.css 隔离
 */
(function (global) {
    'use strict';

    var PORTAL_CONTENT_KEY = 'portalContentConfig_v1';
    var PORTAL_FEEDBACK_KEY = 'portalFeedbackData_v1';
    var CACHE_TTL = 5 * 60 * 1000;
    var cache = { at: 0, data: null };
    var observers = [];

    function esc(s) {
        if (typeof global.escHtml === 'function') return global.escHtml(s);
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function arr(name) {
        try {
            if (typeof global[name] !== 'undefined' && Array.isArray(global[name])) return global[name];
        } catch (e) {}
        try {
            var raw = JSON.parse(localStorage.getItem(name) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e2) { return []; }
    }

    function defaultPortalContent() {
        return {
            slogan: '一支产教融合、交叉学科的精英队伍，致力于将前沿科技转化为城市安全的核心力量。',
            intro: '城市安全数智创新团队依托重庆科技大学，聚焦城市安全、智能监测、结构风险评估与防灾减灾，推动产学研用深度融合，服务区域安全治理与重大工程保障。',
            platform: '依托平台：重庆科技大学 · 重庆安全生产科学研究院',
            directions: [
                { name: '智能巡检', tech: '隐患AI识别 + 自主巡航', scene: '无人机/机器人/摄像头协同巡查', output: '排查派发、隐患识别、预警整改' },
                { name: '内涝预警', tech: '多源感知 + 风险推演', scene: '城市内涝监测与应急响应', output: '预警模型、态势研判、决策支持' },
                { name: '三维扫描', tech: '多信息融合三维重建', scene: '结构损伤诊断与数字孪生', output: '三维模型、损伤识别、运维档案' },
                { name: '装配式结构', tech: '结构抗震与城市灾害风险', scene: '工程结构抗灾与区域防灾', output: '标准规范、关键技术、示范工程' }
            ],
            partners: ['中交集团', '教育部产学合作', '重庆市应急管理局', '重庆市科技局', '中冶赛迪', '重庆大学'],
            recruit: '欢迎对城市安全、人工智能、结构工程、防灾减灾感兴趣的优秀学子报考本团队研究生；同时欢迎相关方向青年教师、博士后加盟。请通过「联系我们」提交意向。',
            galleryTips: ['学术交流', '课题研讨', '工程现场', '成果汇报'],
            contact: {
                email: '1533074793@qq.com',
                phone: '023-65022222',
                address: '重庆市沙坪坝区大学城东路 20 号（重庆科技大学）',
                hours: '工作日 9:00–17:30'
            },
            milestones: [
                { year: '2025.09', title: '团队科研成果持续产出', body: '论文、专利与项目协同推进，支撑城市安全治理场景落地。' },
                { year: '2025.06', title: '产学研合作深化', body: '与行业单位开展横向课题与技术服务，推动成果转化。' },
                { year: '2025.03', title: '研究方向体系完善', body: '智能巡检、内涝预警、三维扫描、装配式结构四大方向成型。' },
                { year: '2025.01', title: '团队门户与管理系统升级', body: '成果、项目、成员数据同源展示，对外宣传与对内管理贯通。' }
            ]
        };
    }

    function loadPortalContent() {
        try {
            var raw = JSON.parse(localStorage.getItem(PORTAL_CONTENT_KEY) || 'null');
            if (raw && typeof raw === 'object') return Object.assign(defaultPortalContent(), raw);
        } catch (e) {}
        return defaultPortalContent();
    }

    function savePortalContent(cfg) {
        try {
            localStorage.setItem(PORTAL_CONTENT_KEY, JSON.stringify(cfg || {}));
            invalidatePortalCache();
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('前台内容', '修改', '更新门户公开内容配置', {}, { success: true }, 1, '', 0);
            }
        } catch (e) {}
    }
    global.loadPortalContent = loadPortalContent;
    global.savePortalContent = savePortalContent;

    function isPublicMember(m) {
        if (!m) return false;
        if (m.showOnPortal === false || m.publicShow === false) return false;
        if (m.category === 'advisor') return true;
        var graduated = typeof global.isMemberGraduated === 'function' ? global.isMemberGraduated(m) : !!m.graduated;
        return !graduated;
    }

    function isActiveProject(p) {
        var st = String((p && (p.status || p.projectStatus)) || '');
        return !/结题|完成|结束|closed|done|已完成/i.test(st);
    }

    function getPortalOverview(force) {
        var now = Date.now();
        if (!force && cache.data && now - cache.at < CACHE_TTL) return cache.data;

        var content = loadPortalContent();
        var members = arr('teamMemberData').filter(isPublicMember);
        var advisors = members.filter(function (m) { return m.category === 'advisor'; });
        var students = members.filter(function (m) { return m.category !== 'advisor'; });
        var graduatedAll = arr('teamMemberData').filter(function (m) {
            return m && m.category !== 'advisor' && (typeof global.isMemberGraduated === 'function' ? global.isMemberGraduated(m) : !!m.graduated);
        });

        var papers = arr('paperData');
        var patents = arr('patentData');
        var standards = arr('standardData');
        var copyrights = arr('copyrightData');
        var competitions = arr('competitionData');
        var lon = arr('longitudinalData');
        var hor = arr('horizontalData');
        var sch = arr('schoolData');
        var projects = [].concat(lon, hor, sch).map(function (p, i) {
            return Object.assign({ _src: i < lon.length ? '纵向' : (i < lon.length + hor.length ? '横向' : '校级') }, p);
        });
        var activeProjects = projects.filter(isActiveProject);
        var doneProjects = projects.filter(function (p) { return !isActiveProject(p); });
        var funding = projects.reduce(function (s, p) { return s + (parseFloat(p && p.funding) || 0); }, 0);

        var data = {
            content: content,
            members: members,
            advisors: advisors,
            students: students,
            graduatedCount: graduatedAll.length,
            papers: papers,
            patents: patents,
            standards: standards,
            copyrights: copyrights,
            competitions: competitions,
            projects: projects,
            activeProjects: activeProjects,
            doneProjects: doneProjects.length ? doneProjects : activeProjects.slice(0, 0),
            funding: funding,
            counts: {
                advisor: advisors.length,
                student: students.length,
                paper: papers.length,
                patent: patents.length,
                standard: standards.length,
                copyright: copyrights.length,
                competition: competitions.length,
                project: projects.length,
                activeProject: activeProjects.length,
                fundingWan: Math.round(funding * 10) / 10
            }
        };
        // 若业务数据为空，保留展示用兜底（避免公开页空白）
        if (!data.counts.paper && !data.counts.patent) {
            data.counts._fallback = true;
        }
        cache = { at: now, data: data };
        return data;
    }
    global.getPortalOverview = getPortalOverview;

    function invalidatePortalCache() {
        cache = { at: 0, data: null };
    }
    global.invalidatePortalCache = invalidatePortalCache;

    function avatarHtml(m, sizeClass) {
        var ch = esc(String((m && m.name) || '?').charAt(0));
        var url = '';
        try {
            if (typeof global.resolveMemberAvatarUrl === 'function') url = global.resolveMemberAvatarUrl(m) || '';
            else if (m && m.avatar && String(m.avatar).length > 20) url = m.avatar;
        } catch (e) {}
        if (url) {
            return '<div class="' + (sizeClass || 'av') + '"><img src="' + String(url).replace(/"/g, '&quot;') + '" alt="' + ch + '"></div>';
        }
        return '<div class="' + (sizeClass || 'av') + '">' + ch + '</div>';
    }

    function animateCount(el, target) {
        if (!el) return;
        var end = Number(target) || 0;
        var start = 0;
        var steps = Math.min(24, Math.max(8, end));
        var i = 0;
        var t = setInterval(function () {
            i++;
            el.textContent = String(Math.round(start + (end - start) * (i / steps)));
            if (i >= steps) { clearInterval(t); el.textContent = String(end); }
        }, 16);
    }

    /* ---------- 顶栏 / 页脚激活态 ---------- */
    function syncPublicNavActive(moduleId) {
        document.querySelectorAll('.top-nav .nav-links a[data-portal], .footer-nav a[data-portal]').forEach(function (a) {
            a.classList.toggle('is-active', a.getAttribute('data-portal') === moduleId);
        });
    }

    /* ---------- 团队介绍 ---------- */
    function renderAboutPortal() {
        var root = document.getElementById('about');
        if (!root) return;
        var d = getPortalOverview();
        var c = d.content;
        var counts = d.counts;

        root.innerHTML =
            '<div class="portal-about">' +
            '<div class="pa-banner">' +
            '<h1>城市安全数智创新团队</h1>' +
            '<p class="slogan">' + esc(c.slogan) + '</p>' +
            '</div>' +
            '<div class="pa-layout">' +
            '<aside class="pa-aside" id="aboutAsideNav">' +
            '<a href="#about-intro" data-anchor="about-intro">团队简介</a>' +
            '<a href="#about-stats" data-anchor="about-stats">数据总览</a>' +
            '<a href="#about-faculty" data-anchor="about-faculty">师资队伍</a>' +
            '<a href="#about-dirs" data-anchor="about-dirs">研究方向</a>' +
            '<a href="#about-gallery" data-anchor="about-gallery">团队风采</a>' +
            '<a href="#about-partners" data-anchor="about-partners">合作交流</a>' +
            '<a href="#about-recruit" data-anchor="about-recruit">招生招聘</a>' +
            '<a href="#about-contact" data-anchor="about-contact">联系我们</a>' +
            '</aside>' +
            '<div class="pa-main">' +
            '<section class="pa-section" id="about-intro"><h2>团队简介</h2>' +
            '<p style="margin:0;line-height:1.75;color:#475569;font-size:14px;">' + esc(c.intro) + '</p>' +
            '<p style="margin:10px 0 0;font-size:13px;color:#7c3aed;font-weight:650;">' + esc(c.platform) + '</p></section>' +
            '<section class="pa-section" id="about-stats"><h2>数据总览</h2>' +
            '<div class="pa-stats">' +
            '<div class="pa-stat" onclick="showModule(\'members\')"><div class="n" data-count="' + counts.advisor + '">0</div><div class="l">师资导师</div><div class="s">公开展示</div></div>' +
            '<div class="pa-stat" onclick="showModule(\'members\')"><div class="n" data-count="' + counts.student + '">0</div><div class="l">在读学生</div><div class="s">毕业 ' + counts.graduatedCount + ' 人</div></div>' +
            '<div class="pa-stat" onclick="showModule(\'achievements\')"><div class="n" data-count="' + (counts.paper || 0) + '">0</div><div class="l">论文成果</div><div class="s">专利 ' + counts.patent + ' · 软著 ' + counts.copyright + '</div></div>' +
            '<div class="pa-stat" onclick="showModule(\'projects\')"><div class="n" data-count="' + counts.activeProject + '">0</div><div class="l">在研项目</div><div class="s">合计 ' + counts.project + ' 项</div></div>' +
            '</div></section>' +
            '<section class="pa-section" id="about-faculty"><h2>师资队伍</h2>' +
            '<div class="pa-faculty" id="aboutFacultyList"></div>' +
            '<div style="margin-top:12px;"><button type="button" class="btn" style="background:#7c3aed;color:#fff;border:0;padding:8px 14px;border-radius:8px;cursor:pointer;" onclick="showModule(\'members\')">查看全部成员 →</button></div>' +
            '</section>' +
            '<section class="pa-section" id="about-dirs"><h2>研究方向</h2><div class="pa-dir-grid" id="aboutDirGrid"></div></section>' +
            '<section class="pa-section" id="about-gallery"><h2>团队风采</h2><div class="pa-gallery" id="aboutGallery"></div></section>' +
            '<section class="pa-section" id="about-partners"><h2>合作交流</h2><div class="pa-partners" id="aboutPartners"></div></section>' +
            '<section class="pa-section" id="about-recruit"><h2>招生招聘</h2><p style="margin:0;line-height:1.7;color:#475569;font-size:14px;">' + esc(c.recruit) + '</p></section>' +
            '<section class="pa-section" id="about-contact"><h2>联系我们</h2>' +
            '<div style="font-size:14px;color:#475569;line-height:1.8;">' +
            '<div>邮箱：' + esc(c.contact.email) + '</div>' +
            '<div>电话：' + esc(c.contact.phone) + '</div>' +
            '<div>地址：' + esc(c.contact.address) + '</div>' +
            '<div>办公时间：' + esc(c.contact.hours) + '</div></div>' +
            '<div style="margin-top:12px;"><button type="button" class="btn" style="background:#7c3aed;color:#fff;border:0;padding:8px 14px;border-radius:8px;cursor:pointer;" onclick="showModule(\'contact\')">前往联系页 →</button></div>' +
            '</section></div></div></div>';

        root.querySelectorAll('[data-count]').forEach(function (el) {
            animateCount(el, el.getAttribute('data-count'));
        });

        var faculty = document.getElementById('aboutFacultyList');
        var list = d.advisors.length ? d.advisors : d.members.slice(0, 6);
        if (faculty) {
            faculty.innerHTML = list.length ? list.map(function (m) {
                var title = m.title || (m.category === 'advisor' ? '导师' : '');
                var research = m.research || m.direction || '';
                return '<div class="pa-person" onclick="showModule(\'members\')">' + avatarHtml(m, 'pa-av') +
                    '<div><div class="name">' + esc(m.name) + '</div><div class="meta">' + esc(title) +
                    (research ? ' · ' + esc(String(research).slice(0, 24)) : '') + '</div></div></div>';
            }).join('') : '<div style="color:#94a3b8;font-size:13px;">暂无公开师资信息，请先在「团队成员档案」维护并同步。</div>';
        }

        var dirGrid = document.getElementById('aboutDirGrid');
        if (dirGrid) {
            dirGrid.innerHTML = (c.directions || []).map(function (dir) {
                return '<div class="pa-dir"><h3>' + esc(dir.name) + '</h3>' +
                    '<p><strong>核心技术：</strong>' + esc(dir.tech) + '</p>' +
                    '<p style="margin-top:6px;"><strong>应用场景：</strong>' + esc(dir.scene) + '</p>' +
                    '<div class="tags"><span class="tag">' + esc(dir.output) + '</span></div></div>';
            }).join('');
        }

        var gallery = document.getElementById('aboutGallery');
        if (gallery) {
            gallery.innerHTML = (c.galleryTips || []).map(function (t) {
                return '<div class="slot">' + esc(t) + '<br><span style="opacity:.7">可在前台内容配置中上传风采图</span></div>';
            }).join('');
        }

        var partners = document.getElementById('aboutPartners');
        if (partners) {
            partners.innerHTML = (c.partners || []).map(function (p) {
                return '<span>' + esc(p) + '</span>';
            }).join('');
        }

        setupAboutAnchors();
    }

    function setupAboutAnchors() {
        var aside = document.getElementById('aboutAsideNav');
        if (!aside) return;
        aside.querySelectorAll('a[data-anchor]').forEach(function (a) {
            a.onclick = function (ev) {
                ev.preventDefault();
                var id = a.getAttribute('data-anchor');
                var el = document.getElementById(id);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            };
        });
        var sections = Array.prototype.slice.call(document.querySelectorAll('#about .pa-section[id]'));
        if (!sections.length) return;
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (!en.isIntersecting) return;
                aside.querySelectorAll('a').forEach(function (x) {
                    x.classList.toggle('active', x.getAttribute('data-anchor') === en.target.id);
                });
            });
        }, { rootMargin: '-30% 0px -55% 0px', threshold: 0.01 });
        sections.forEach(function (s) { io.observe(s); });
        observers.push(io);
    }

    /* ---------- 团队成果（浅紫主题 + ECharts 多图） ---------- */
    var achChartInstances = [];

    function disposeAchCharts() {
        if (window.__achChartPulse) {
            clearInterval(window.__achChartPulse);
            window.__achChartPulse = null;
        }
        achChartInstances.forEach(function (c) {
            try { c.dispose(); } catch (e) {}
        });
        achChartInstances = [];
    }

    function startAchChartPulse() {
        if (window.__achChartPulse) {
            clearInterval(window.__achChartPulse);
            window.__achChartPulse = null;
        }
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        var tick = 0;
        window.__achChartPulse = setInterval(function () {
            if (!achChartInstances.length) return;
            var focus = tick % achChartInstances.length;
            achChartInstances.forEach(function (ch, i) {
                try {
                    ch.dispatchAction({ type: 'downplay' });
                    if (i !== focus) return;
                    var opt = ch.getOption();
                    var series = (opt && opt.series) || [];
                    for (var si = 0; si < series.length; si++) {
                        var data = series[si].data || [];
                        var n = data.length || 1;
                        ch.dispatchAction({
                            type: 'highlight',
                            seriesIndex: si,
                            dataIndex: tick % n
                        });
                    }
                } catch (e) {}
            });
            tick += 1;
        }, 1000);
    }

    function yearBucket(list, fields) {
        var map = {};
        (list || []).forEach(function (it) {
            if (!it) return;
            var y = '';
            for (var i = 0; i < fields.length; i++) {
                var v = it[fields[i]];
                if (v == null || v === '') continue;
                var m = String(v).match(/(20\d{2})/);
                if (m) { y = m[1]; break; }
            }
            if (!y) y = '其他';
            map[y] = (map[y] || 0) + 1;
        });
        var years = Object.keys(map).sort();
        return { years: years, values: years.map(function (y) { return map[y]; }) };
    }

    function renderAchievementsPortal() {
        var root = document.getElementById('achievements');
        if (!root) return;
        disposeAchCharts();
        root.classList.remove('page-achievement-tech');
        root.classList.add('page-achievement-theme');

        var d = getPortalOverview();
        var c = d.counts;
        var paperN = c.paper;
        var patentN = c.patent;
        var stdN = c.standard;
        var copyN = c.copyright;
        var awardN = c.competition;
        var fund = c.fundingWan;

        var lonFund = 0, horFund = 0, schFund = 0;
        (d.projects || []).forEach(function (p) {
            var f = parseFloat(p && p.funding) || 0;
            if (p._src === '横向') horFund += f;
            else if (p._src === '校级') schFund += f;
            else lonFund += f;
        });

        function topItems(list, titleKey, badge) {
            return (list || []).slice(0, 6).map(function (it, idx) {
                var title = it[titleKey] || it.title || it.name || '未命名';
                var mod = badge === 'paper' ? 'paper_management' : (badge === 'patent' ? 'patent_management' : 'competition_management');
                return '<div class="ach-item" style="--i:' + idx + '" onclick="showModule(\'' + mod + '\')">' +
                    '<span>' + esc(String(title).slice(0, 40)) + '</span><span class="badge ' + badge + '">' +
                    (badge === 'paper' ? '论文' : (badge === 'patent' ? '专利' : '荣誉')) + '</span></div>';
            }).join('') || '<div class="ach-item" style="--i:0"><span>暂无公开条目，请在成果管理模块录入</span></div>';
        }

        function sparkCard(wave, moduleId, value, delta, label) {
            var bars = '';
            for (var b = 0; b < 7; b++) {
                var h = 35 + ((wave * 3 + b * 17) % 55);
                bars += '<i style="--b:' + b + ';height:' + h + '%"></i>';
            }
            return '<div class="ach-card ach-stat portal-reveal" style="--d:' + (60 + wave * 50) + 'ms;--wave:' + wave +
                '" onclick="showModule(\'' + moduleId + '\')">' +
                '<div class="n" data-count="' + value + '">0</div>' +
                '<div class="delta">' + esc(delta) + '</div>' +
                '<div class="l">' + esc(label) + '</div>' +
                '<div class="ach-spark" aria-hidden="true">' + bars + '</div></div>';
        }

        root.innerHTML =
            '<div class="ach-hero portal-reveal" style="--d:0ms">' +
            '<h1>团队成果</h1>' +
            '<p>数据与系统成果 / 项目模块同源聚合 · 紫色主题可视化看板</p></div>' +
            '<div class="ach-stats">' +
            sparkCard(0, 'projects', fund, '万元', '科研经费') +
            sparkCard(1, 'paper_management', paperN, '同源统计', '高水平论文') +
            sparkCard(2, 'patent_management', patentN, '知识产权', '专利') +
            sparkCard(3, 'standard_management', stdN, '规范成果', '标准 / 专著') +
            sparkCard(4, 'competition_management', awardN, '竞赛荣誉', '获奖成果') +
            '</div>' +
            '<div class="ach-charts-row" style="--wave-cycle:5s">' +
            '<div class="ach-card ach-chart-card portal-reveal" style="--d:300ms;--wave:0"><h3>成果分类对比（柱状图）</h3><div class="ach-chart-box" id="achChartBarCats"></div></div>' +
            '<div class="ach-card ach-chart-card portal-reveal" style="--d:360ms;--wave:1"><h3>知识产权结构（环形图）</h3><div class="ach-chart-box sm" id="achChartPieIp"></div></div>' +
            '<div class="ach-card ach-chart-card portal-reveal" style="--d:420ms;--wave:2"><h3>项目类型经费（柱状图）</h3><div class="ach-chart-box sm" id="achChartBarFund"></div></div>' +
            '</div>' +
            '<div class="ach-charts-row-2" style="--wave-cycle:5s">' +
            '<div class="ach-card ach-chart-card portal-reveal" style="--d:480ms;--wave:3"><h3>近年成果产出趋势（折线 + 柱状）</h3><div class="ach-chart-box" id="achChartTrend"></div></div>' +
            '<div class="ach-card ach-chart-card portal-reveal" style="--d:540ms;--wave:4"><h3>成果雷达画像</h3><div class="ach-chart-box" id="achChartRadar"></div></div>' +
            '</div>' +
            '<div class="ach-cats">' +
            '<div class="ach-card ach-cat portal-reveal" style="--d:600ms"><div class="hd">学术成果</div>' + topItems(d.papers, 'title', 'paper') + '</div>' +
            '<div class="ach-card ach-cat portal-reveal" style="--d:660ms"><div class="hd">技术成果</div>' + topItems(d.patents, 'name', 'patent') + '</div>' +
            '<div class="ach-card ach-cat portal-reveal" style="--d:720ms"><div class="hd">荣誉称号</div>' + topItems(d.competitions, 'name', 'award') + '</div>' +
            '</div>' +
            '<div class="ach-card ach-timeline portal-reveal" style="--d:780ms"><h3>里程碑成果</h3>' +
            (d.content.milestones || []).map(function (m) {
                return '<div class="ach-tl-item portal-reveal"><div class="ach-tl-card"><div class="year">' + esc(m.year) +
                    '</div><div class="tt">' + esc(m.title) + '</div><div class="bd">' + esc(m.body) + '</div></div></div>';
            }).join('') +
            '</div>';

        root.querySelectorAll('[data-count]').forEach(function (el) {
            animateCount(el, el.getAttribute('data-count'));
        });
        setupReveal(root);

        setTimeout(function () {
            mountAchCharts({
                paperN: paperN,
                patentN: patentN,
                copyN: copyN,
                stdN: stdN,
                awardN: awardN,
                lonFund: lonFund,
                horFund: horFund,
                schFund: schFund,
                papers: d.papers,
                patents: d.patents,
                projects: d.projects
            });
        }, 40);
    }

    function mountAchCharts(s) {
        if (typeof echarts === 'undefined') return;
        var purple = ['#7c3aed', '#8b5cf6', '#a78bfa', '#6366f1', '#4f46e5', '#c4b5fd'];

        function make(id, option) {
            var el = document.getElementById(id);
            if (!el) return null;
            var chart = echarts.init(el);
            option.animation = true;
            option.animationDuration = 1100;
            option.animationEasing = 'cubicOut';
            option.animationDelay = function (idx) { return idx * 80; };
            chart.setOption(option);
            achChartInstances.push(chart);
            return chart;
        }

        make('achChartBarCats', {
            color: purple,
            tooltip: { trigger: 'axis' },
            grid: { left: 40, right: 16, top: 28, bottom: 32 },
            xAxis: {
                type: 'category',
                data: ['论文', '专利', '软著', '标准', '荣誉'],
                axisLabel: { color: '#64748b' },
                axisLine: { lineStyle: { color: '#e9e4f8' } }
            },
            yAxis: {
                type: 'value', minInterval: 1,
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: '#f1eef9' } }
            },
            series: [{
                type: 'bar',
                barWidth: 28,
                animationDelay: function (idx) { return idx * 100; },
                emphasis: {
                    focus: 'series',
                    itemStyle: { shadowBlur: 16, shadowColor: 'rgba(124,58,237,0.45)' }
                },
                data: [
                    { value: s.paperN, itemStyle: { color: '#6366f1' } },
                    { value: s.patentN, itemStyle: { color: '#7c3aed' } },
                    { value: s.copyN, itemStyle: { color: '#8b5cf6' } },
                    { value: s.stdN, itemStyle: { color: '#a78bfa' } },
                    { value: s.awardN, itemStyle: { color: '#4f46e5' } }
                ],
                itemStyle: { borderRadius: [6, 6, 0, 0] },
                label: { show: true, position: 'top', color: '#5b21b6', fontWeight: 700 }
            }]
        });

        make('achChartPieIp', {
            color: ['#7c3aed', '#6366f1', '#a78bfa'],
            tooltip: { trigger: 'item' },
            legend: { bottom: 0, textStyle: { color: '#64748b' } },
            series: [{
                type: 'pie',
                radius: ['42%', '68%'],
                center: ['50%', '44%'],
                label: { color: '#5b21b6' },
                animationType: 'scale',
                animationEasing: 'elasticOut',
                emphasis: {
                    scale: true,
                    scaleSize: 8,
                    itemStyle: { shadowBlur: 18, shadowColor: 'rgba(124,58,237,0.4)' }
                },
                data: [
                    { name: '专利', value: s.patentN },
                    { name: '软著', value: s.copyN },
                    { name: '标准', value: s.stdN }
                ]
            }]
        });

        make('achChartBarFund', {
            color: purple,
            tooltip: { trigger: 'axis' },
            grid: { left: 48, right: 12, top: 28, bottom: 32 },
            xAxis: {
                type: 'category',
                data: ['纵向', '横向', '校级'],
                axisLabel: { color: '#64748b' },
                axisLine: { lineStyle: { color: '#e9e4f8' } }
            },
            yAxis: {
                type: 'value',
                name: '万元',
                nameTextStyle: { color: '#94a3b8' },
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: '#f1eef9' } }
            },
            series: [{
                type: 'bar',
                barWidth: 32,
                emphasis: {
                    itemStyle: { shadowBlur: 16, shadowColor: 'rgba(124,58,237,0.45)' }
                },
                data: [
                    { value: Math.round(s.lonFund * 10) / 10, itemStyle: { color: '#7c3aed' } },
                    { value: Math.round(s.horFund * 10) / 10, itemStyle: { color: '#6366f1' } },
                    { value: Math.round(s.schFund * 10) / 10, itemStyle: { color: '#a78bfa' } }
                ],
                itemStyle: { borderRadius: [6, 6, 0, 0] },
                label: { show: true, position: 'top', color: '#5b21b6', fontWeight: 650 }
            }]
        });

        var paperY = yearBucket(s.papers, ['year', 'publishDate', 'publish_date', 'date']);
        var patentY = yearBucket(s.patents, ['year', 'applicationDate', 'grantDate', 'date']);
        var years = {};
        paperY.years.forEach(function (y) { years[y] = 1; });
        patentY.years.forEach(function (y) { years[y] = 1; });
        var yearList = Object.keys(years).filter(function (y) { return y !== '其他'; }).sort().slice(-6);
        if (!yearList.length) yearList = ['2023', '2024', '2025'];
        var paperMap = {};
        paperY.years.forEach(function (y, i) { paperMap[y] = paperY.values[i]; });
        var patentMap = {};
        patentY.years.forEach(function (y, i) { patentMap[y] = patentY.values[i]; });

        make('achChartTrend', {
            color: ['#7c3aed', '#6366f1'],
            tooltip: { trigger: 'axis' },
            legend: { data: ['论文', '专利'], top: 0, textStyle: { color: '#64748b' } },
            grid: { left: 40, right: 16, top: 36, bottom: 28 },
            xAxis: {
                type: 'category',
                data: yearList,
                axisLabel: { color: '#64748b' },
                axisLine: { lineStyle: { color: '#e9e4f8' } }
            },
            yAxis: {
                type: 'value', minInterval: 1,
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: '#f1eef9' } }
            },
            series: [
                {
                    name: '论文',
                    type: 'bar',
                    barWidth: 16,
                    data: yearList.map(function (y) { return paperMap[y] || 0; }),
                    itemStyle: { color: '#a78bfa', borderRadius: [4, 4, 0, 0] },
                    emphasis: { itemStyle: { shadowBlur: 12, shadowColor: 'rgba(124,58,237,0.4)' } }
                },
                {
                    name: '专利',
                    type: 'line',
                    smooth: true,
                    data: yearList.map(function (y) { return patentMap[y] || 0; }),
                    symbolSize: 8,
                    lineStyle: { width: 3, color: '#7c3aed' },
                    itemStyle: { color: '#7c3aed' },
                    areaStyle: { color: 'rgba(124,58,237,0.08)' },
                    emphasis: { scale: true, itemStyle: { borderWidth: 3, shadowBlur: 10, shadowColor: 'rgba(124,58,237,0.45)' } }
                }
            ]
        });

        var maxR = Math.max(s.paperN, s.patentN, s.copyN, s.stdN, s.awardN, 1);
        make('achChartRadar', {
            color: ['#7c3aed'],
            tooltip: {},
            radar: {
                indicator: [
                    { name: '论文', max: maxR },
                    { name: '专利', max: maxR },
                    { name: '软著', max: maxR },
                    { name: '标准', max: maxR },
                    { name: '荣誉', max: maxR }
                ],
                axisName: { color: '#64748b' },
                splitArea: { areaStyle: { color: ['#faf8ff', '#f5f3ff'] } },
                splitLine: { lineStyle: { color: '#e9e4f8' } },
                axisLine: { lineStyle: { color: '#ddd6fe' } }
            },
            series: [{
                type: 'radar',
                data: [{
                    value: [s.paperN, s.patentN, s.copyN, s.stdN, s.awardN],
                    name: '团队成果',
                    areaStyle: { color: 'rgba(124,58,237,0.22)' },
                    lineStyle: { color: '#7c3aed', width: 2 },
                    itemStyle: { color: '#7c3aed' },
                    emphasis: {
                        areaStyle: { color: 'rgba(124,58,237,0.38)' },
                        lineStyle: { width: 3 },
                        itemStyle: { shadowBlur: 14, shadowColor: 'rgba(124,58,237,0.5)' }
                    }
                }]
            }]
        });

        var onResize = function () {
            achChartInstances.forEach(function (ch) {
                try { ch.resize(); } catch (e) {}
            });
        };
        window.removeEventListener('resize', window.__achChartResize);
        window.__achChartResize = onResize;
        window.addEventListener('resize', onResize);
        startAchChartPulse();
    }

    /* ---------- 团队项目 ---------- */
    var pjChartInstances = [];

    function disposePjCharts() {
        if (window.__pjChartPulse) {
            clearInterval(window.__pjChartPulse);
            window.__pjChartPulse = null;
        }
        pjChartInstances.forEach(function (c) {
            try { c.dispose(); } catch (e) {}
        });
        pjChartInstances = [];
    }

    function renderProjectsPortal() {
        var root = document.getElementById('projects');
        if (!root) return;
        disposePjCharts();
        root.classList.add('page-project-tech');
        var d = getPortalOverview();
        var active = d.activeProjects;
        var done = d.doneProjects;
        if (!done.length && d.projects.length) {
            done = d.projects.filter(function (p) { return !isActiveProject(p); });
        }
        var partners = d.content.partners || [];
        var lonFund = 0, horFund = 0, schFund = 0;
        (d.projects || []).forEach(function (p) {
            var f = parseFloat(p && p.funding) || 0;
            if (p._src === '横向') horFund += f;
            else if (p._src === '校级') schFund += f;
            else lonFund += f;
        });
        var totalFund = Math.round((d.funding || 0) * 10) / 10;
        var maxFund = Math.max.apply(null, (d.projects || []).map(function (p) {
            return parseFloat(p && p.funding) || 0;
        }).concat([1]));

        function sparkCard(wave, moduleId, value, delta, label) {
            var bars = '';
            for (var b = 0; b < 7; b++) {
                var h = 35 + ((wave * 3 + b * 17) % 55);
                bars += '<i style="--b:' + b + ';height:' + h + '%"></i>';
            }
            return '<div class="pj-stat portal-reveal" style="--d:' + (40 + wave * 45) + 'ms;--wave:' + wave +
                '" onclick="showModule(\'' + moduleId + '\')">' +
                '<div class="n" data-count="' + value + '">0</div>' +
                '<div class="delta">' + esc(delta) + '</div>' +
                '<div class="l">' + esc(label) + '</div>' +
                '<div class="pj-spark" aria-hidden="true">' + bars + '</div></div>';
        }

        function itemHtml(p, live, idx) {
            var name = p.name || p.title || p.projectName || '未命名项目';
            var fund = parseFloat(p.funding) || 0;
            var src = p._src || p.type || '项目';
            var st = p.status || (live ? '在研' : '已完成');
            var pct = Math.max(8, Math.round((fund / maxFund) * 100));
            return '<div class="pj-item portal-reveal" style="--i:' + (idx || 0) + '" onclick="showModule(\'longitudinal_project\')">' +
                '<div class="pj-item-top">' +
                '<span class="pj-dot ' + (live ? 'live' : 'done') + '" style="--i:' + (idx || 0) + '"></span>' +
                '<div class="pj-item-main"><div class="pj-name">' + esc(name) + '</div>' +
                '<div class="pj-meta">' + esc(src) + ' · ' + esc(st) +
                (fund ? ' · 经费 <strong>' + fund + '</strong> 万元' : '') + '</div></div>' +
                '<span class="pj-tag ' + (live ? 'live' : 'done') + '">' + esc(live ? '在研' : '结题') + '</span></div>' +
                (fund ? '<div class="pj-fundbar" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' : '') +
                '</div>';
        }

        var partnerHtml = partners.map(function (p, idx) {
            return '<div class="pj-chip portal-reveal" style="--d:' + (520 + idx * 40) + 'ms;--i:' + idx + '">' +
                '<span class="pj-dot partner" style="--i:' + idx + '"></span>' +
                '<div><div class="pj-name">' + esc(p) + '</div><div class="pj-meta">合作交流单位</div></div></div>';
        }).join('');

        root.innerHTML =
            '<div class="pj-title-wrap portal-reveal" style="--d:0ms">' +
            '<h1>团队项目</h1>' +
            '<p>在研推进 · 结题沉淀 · 产学研合作 — 与项目管理模块同源</p>' +
            '<div class="pj-flow"></div></div>' +
            '<div class="pj-stats">' +
            sparkCard(0, 'longitudinal_project', totalFund, '万元累计', '科研经费') +
            sparkCard(1, 'longitudinal_project', active.length, '推进中', '在研项目') +
            sparkCard(2, 'longitudinal_project', done.length, '已结题', '完成项目') +
            sparkCard(3, 'projects', partners.length, '产学研', '合作单位') +
            '</div>' +
            '<div class="pj-charts-row">' +
            '<div class="pj-block pj-chart-card portal-reveal" style="--d:260ms;--wave:0">' +
            '<span class="pj-block-scan" aria-hidden="true"></span>' +
            '<h2>项目状态结构</h2><div class="pj-chart-box" id="pjChartStatus"></div></div>' +
            '<div class="pj-block pj-chart-card portal-reveal" style="--d:320ms;--wave:1">' +
            '<span class="pj-block-scan" aria-hidden="true"></span>' +
            '<h2>类型经费分布（万元）</h2><div class="pj-chart-box" id="pjChartFund"></div></div>' +
            '</div>' +
            '<div class="pj-cols">' +
            '<div class="pj-block portal-reveal" style="--d:380ms;--wave:2"><span class="pj-block-scan" aria-hidden="true"></span>' +
            '<h2>在研项目 <span class="cnt">' + active.length + ' 项</span></h2>' +
            (active.length ? active.map(function (p, i) { return itemHtml(p, true, i); }).join('') :
                '<div class="pj-empty">暂无在研项目，请在纵向 / 横向 / 校级项目管理中录入</div>') +
            '</div>' +
            '<div class="pj-block portal-reveal" style="--d:440ms;--wave:3"><span class="pj-block-scan" aria-hidden="true"></span>' +
            '<h2>已完成 / 结题 <span class="cnt">' + done.length + ' 项</span></h2>' +
            (done.length ? done.map(function (p, i) { return itemHtml(p, false, i); }).join('') :
                '<div class="pj-empty">暂无结题项目，完成项目后将自动汇总至此</div>') +
            '</div></div>' +
            '<div class="pj-block portal-reveal" style="--d:500ms;--wave:4"><span class="pj-block-scan" aria-hidden="true"></span>' +
            '<h2>项目合作 <span class="cnt">' + partners.length + '</span></h2>' +
            '<p class="pj-desc">团队与高校、科研院所及行业单位保持紧密合作，共同推进城市安全数智化研究与工程落地。</p>' +
            '<div class="pj-chips">' + (partnerHtml || '<div class="pj-empty">暂无合作单位配置</div>') + '</div></div>';

        root.querySelectorAll('[data-count]').forEach(function (el) {
            animateCount(el, el.getAttribute('data-count'));
        });
        setupReveal(root);
        setTimeout(function () {
            mountPjCharts({
                activeN: active.length,
                doneN: done.length,
                lonFund: lonFund,
                horFund: horFund,
                schFund: schFund
            });
        }, 60);
    }

    function mountPjCharts(s) {
        if (typeof echarts === 'undefined') return;
        function make(id, option) {
            var el = document.getElementById(id);
            if (!el) return null;
            var chart = echarts.init(el);
            option.animation = true;
            option.animationDuration = 1000;
            option.animationEasing = 'cubicOut';
            chart.setOption(option);
            pjChartInstances.push(chart);
            return chart;
        }

        make('pjChartStatus', {
            color: ['#7c3aed', '#a78bfa'],
            tooltip: { trigger: 'item' },
            legend: { bottom: 0, textStyle: { color: '#64748b' } },
            series: [{
                type: 'pie',
                radius: ['46%', '70%'],
                center: ['50%', '44%'],
                label: { color: '#5b21b6', formatter: '{b}\n{c}' },
                animationType: 'scale',
                animationEasing: 'elasticOut',
                emphasis: {
                    scale: true,
                    scaleSize: 8,
                    itemStyle: { shadowBlur: 16, shadowColor: 'rgba(124,58,237,0.4)' }
                },
                data: [
                    { name: '在研', value: s.activeN },
                    { name: '结题', value: s.doneN }
                ]
            }]
        });

        make('pjChartFund', {
            color: ['#7c3aed', '#8b5cf6', '#a78bfa'],
            tooltip: { trigger: 'axis' },
            grid: { left: 48, right: 14, top: 28, bottom: 32 },
            xAxis: {
                type: 'category',
                data: ['纵向', '横向', '校级'],
                axisLabel: { color: '#64748b' },
                axisLine: { lineStyle: { color: '#e9e4f8' } }
            },
            yAxis: {
                type: 'value',
                name: '万元',
                nameTextStyle: { color: '#94a3b8' },
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: '#f1eef9' } }
            },
            series: [{
                type: 'bar',
                barWidth: 34,
                emphasis: { itemStyle: { shadowBlur: 14, shadowColor: 'rgba(124,58,237,0.4)' } },
                data: [
                    { value: Math.round(s.lonFund * 10) / 10, itemStyle: { color: '#7c3aed' } },
                    { value: Math.round(s.horFund * 10) / 10, itemStyle: { color: '#8b5cf6' } },
                    { value: Math.round(s.schFund * 10) / 10, itemStyle: { color: '#a78bfa' } }
                ],
                itemStyle: { borderRadius: [6, 6, 0, 0] },
                label: { show: true, position: 'top', color: '#5b21b6', fontWeight: 650 }
            }]
        });

        var tick = 0;
        if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
            window.__pjChartPulse = setInterval(function () {
                if (!pjChartInstances.length) return;
                var focus = tick % pjChartInstances.length;
                pjChartInstances.forEach(function (ch, i) {
                    try {
                        ch.dispatchAction({ type: 'downplay' });
                        if (i !== focus) return;
                        var opt = ch.getOption();
                        var series = (opt && opt.series) || [];
                        for (var si = 0; si < series.length; si++) {
                            var n = (series[si].data || []).length || 1;
                            ch.dispatchAction({ type: 'highlight', seriesIndex: si, dataIndex: tick % n });
                        }
                    } catch (e) {}
                });
                tick += 1;
            }, 1000);
        }

        var onResize = function () {
            pjChartInstances.forEach(function (ch) {
                try { ch.resize(); } catch (e) {}
            });
        };
        window.removeEventListener('resize', window.__pjChartResize);
        window.__pjChartResize = onResize;
        window.addEventListener('resize', onResize);
    }

    /* ---------- 团队成员 ---------- */
    var membersTab = 'advisor';

    function renderMembersPortal(tab) {
        var root = document.getElementById('members');
        if (!root) return;
        if (tab) membersTab = tab;
        var d = getPortalOverview();
        var list = [];
        if (membersTab === 'advisor') list = d.advisors;
        else if (membersTab === 'student') list = d.students;
        else list = d.members;

        root.innerHTML =
            '<div class="portal-members">' +
            '<div class="pm-head"><h1>团队成员</h1><p>公开名录仅展示姓名、职称与研究方向，联系方式已脱敏。</p></div>' +
            '<div class="pm-tabs">' +
            '<button type="button" class="' + (membersTab === 'advisor' ? 'active' : '') + '" onclick="renderMembersPortal(\'advisor\')">导师 (' + d.advisors.length + ')</button>' +
            '<button type="button" class="' + (membersTab === 'student' ? 'active' : '') + '" onclick="renderMembersPortal(\'student\')">在读学生 (' + d.students.length + ')</button>' +
            '<button type="button" class="' + (membersTab === 'all' ? 'active' : '') + '" onclick="renderMembersPortal(\'all\')">全部公开 (' + d.members.length + ')</button>' +
            '</div>' +
            '<div class="pm-grid">' +
            (list.length ? list.map(function (m) {
                var title = m.title || (m.category === 'advisor' ? '导师' : ((m.category || '') + '级'));
                var research = m.research || m.direction || m.field || '研究方向完善中';
                var mid = m.id != null ? m.id : '';
                return '<div class="pm-card" onclick="portalOpenMemberDetail(' + JSON.stringify(String(mid)) + ')">' +
                    '<div class="row">' + avatarHtml(m) +
                    '<div><div class="name">' + esc(m.name) + '</div><div class="meta">' + esc(title) + '</div></div></div>' +
                    '<div class="research">' + esc(String(research).slice(0, 80)) + '</div></div>';
            }).join('') : '<div style="grid-column:1/-1;color:#94a3b8;padding:24px;text-align:center;">暂无公开成员，请在团队成员档案维护后同步。</div>') +
            '</div></div>';
    }
    global.renderMembersPortal = renderMembersPortal;

    function portalOpenMemberDetail(id) {
        if (id === '' || id == null) {
            showModule('member_archive');
            return;
        }
        // 访客仅看公开页卡片信息；登录用户可进档案
        var role = global.currentUser && global.currentUser.role;
        if (role === 'visitor' || !role) {
            alert('公开门户仅展示基本信息。如需完整档案，请使用内部账号登录。');
            return;
        }
        showModule('member_archive');
        setTimeout(function () {
            try { if (typeof global.showMemberDetail === 'function') global.showMemberDetail(Number(id) || id); } catch (e) {}
        }, 100);
    }
    global.portalOpenMemberDetail = portalOpenMemberDetail;

    /* ---------- 联系我们 ---------- */
    function renderContactPortal() {
        var root = document.getElementById('contact');
        if (!root) return;
        var c = loadPortalContent().contact;
        var d = getPortalOverview();

        root.innerHTML =
            '<div class="portal-contact">' +
            '<div class="pc-head"><h1>联系我们</h1><p>欢迎学术交流、合作洽谈与报考咨询</p></div>' +
            '<div class="pc-grid">' +
            '<div class="pc-card"><h2>联系方式</h2>' +
            '<div class="pc-line"><span>邮箱</span><div>' + esc(c.email) + '</div></div>' +
            '<div class="pc-line"><span>电话</span><div>' + esc(c.phone) + '</div></div>' +
            '<div class="pc-line"><span>地址</span><div>' + esc(c.address) + '</div></div>' +
            '<div class="pc-line"><span>时间</span><div>' + esc(c.hours) + '</div></div>' +
            '<h2 style="margin-top:18px;">公开师资</h2>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            (d.advisors.slice(0, 6).map(function (m) {
                return '<span style="padding:6px 10px;border-radius:999px;background:#f5f3ff;color:#6d28d9;font-size:12px;font-weight:650;">' + esc(m.name) + '</span>';
            }).join('') || '<span style="color:#94a3b8;font-size:13px;">暂无公开师资</span>') +
            '</div></div>' +
            '<div class="pc-card"><h2>留言反馈</h2>' +
            '<input id="portalFbName" placeholder="您的姓名（可选）">' +
            '<input id="portalFbContact" placeholder="联系邮箱 / 手机">' +
            '<select id="portalFbType"><option value="交流">学术交流</option><option value="合作">合作洽谈</option><option value="报考">报考咨询</option><option value="其他">其他</option></select>' +
            '<textarea id="portalFbContent" rows="5" placeholder="请填写留言内容…"></textarea>' +
            '<button type="button" class="pc-submit" onclick="submitPortalFeedback()">提交反馈</button>' +
            '<div id="portalFbHint" style="margin-top:8px;font-size:12px;color:#94a3b8;"></div>' +
            '</div>' +
            '<div class="pc-card pc-help" style="grid-column:1/-1;"><h2>常见问题</h2>' +
            '<details open><summary>如何报考本团队研究生？</summary><p>请关注学校研究生招生简章，并通过本页留言或邮件说明研究方向意向，导师将视情况回复。</p></details>' +
            '<details><summary>如何开展横向合作？</summary><p>请通过邮箱或留言说明合作需求、预期周期与联系人，团队秘书将协助对接。</p></details>' +
            '<details><summary>公开成果数据从哪里来？</summary><p>门户页论文、专利、项目等数据与系统「成果管理 / 项目管理」同源聚合，后台更新后自动反映到前台。</p></details>' +
            '</div></div></div>';
    }

    function submitPortalFeedback() {
        var name = (document.getElementById('portalFbName') || {}).value || '';
        var contact = (document.getElementById('portalFbContact') || {}).value || '';
        var type = (document.getElementById('portalFbType') || {}).value || '其他';
        var content = (document.getElementById('portalFbContent') || {}).value || '';
        var hint = document.getElementById('portalFbHint');
        if (!String(content).trim()) {
            if (hint) { hint.style.color = '#dc2626'; hint.textContent = '请填写留言内容'; }
            return;
        }
        if (!String(contact).trim()) {
            if (hint) { hint.style.color = '#dc2626'; hint.textContent = '请留下联系邮箱或手机，便于回复'; }
            return;
        }
        var item = {
            id: Date.now(),
            name: String(name).trim(),
            contact: String(contact).trim(),
            type: type,
            content: String(content).trim(),
            at: new Date().toISOString(),
            status: 'pending'
        };
        var list = [];
        try { list = JSON.parse(localStorage.getItem(PORTAL_FEEDBACK_KEY) || '[]') || []; } catch (e) { list = []; }
        list.unshift(item);
        try { localStorage.setItem(PORTAL_FEEDBACK_KEY, JSON.stringify(list.slice(0, 200))); } catch (e2) {}
        try {
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('门户反馈', '提交', type + '：' + item.content.slice(0, 40), { feedbackId: item.id }, { success: true }, 1, '', 0);
            }
        } catch (e3) {}
        // 可选：写入通知给管理员
        try {
            if (typeof global.normalizeNoticeRecord === 'function' && Array.isArray(global.noticeData) && typeof global.saveNoticeData === 'function') {
                var admins = [];
                (global.accountData || []).forEach(function (a) {
                    if (a && (a.role === 'admin' || a.role === 'leader') && a.realName) admins.push(a.realName);
                });
                if (admins.length) {
                    global.noticeData.push(global.normalizeNoticeRecord({
                        id: Date.now() + 1,
                        title: '【门户留言】' + type,
                        type: 'notice',
                        content: '来自 ' + (item.name || '访客') + '（' + item.contact + '）：\n' + item.content,
                        publishTime: new Date().toLocaleString('zh-CN'),
                        publisher: '门户系统',
                        audience: 'custom',
                        audienceNames: admins,
                        status: 'published',
                        reads: []
                    }));
                    global.saveNoticeData({ silent: true, log: { action: '门户留言', desc: '访客反馈转站内信' } });
                }
            }
        } catch (e4) {}
        if (hint) { hint.style.color = '#16a34a'; hint.textContent = '已提交，感谢您的反馈！'; }
        var ta = document.getElementById('portalFbContent');
        if (ta) ta.value = '';
    }
    global.submitPortalFeedback = submitPortalFeedback;

    /* ---------- 入场动画 / 回到顶部 ---------- */
    function setupReveal(root) {
        if (!root) return;
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (en.isIntersecting) en.target.classList.add('in');
            });
        }, { threshold: 0.12 });
        root.querySelectorAll('.portal-reveal').forEach(function (el) { io.observe(el); });
        // 首屏立即显示，避免等待滚动
        setTimeout(function () {
            root.querySelectorAll('.portal-reveal').forEach(function (el, idx) {
                var rect = el.getBoundingClientRect();
                if (rect.top < window.innerHeight * 0.92) el.classList.add('in');
            });
        }, 30);
        observers.push(io);
    }

    function ensureBackTop() {
        var btn = document.getElementById('portalBackTop');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'portalBackTop';
            btn.className = 'portal-back-top';
            btn.type = 'button';
            btn.title = '回到顶部';
            btn.textContent = '↑';
            btn.onclick = function () {
                var main = document.querySelector('.main-content');
                if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
                window.scrollTo({ top: 0, behavior: 'smooth' });
            };
            document.body.appendChild(btn);
        }
        var onScroll = function () {
            var y = window.scrollY || document.documentElement.scrollTop || 0;
            var main = document.querySelector('.main-content');
            var my = main ? main.scrollTop : 0;
            btn.classList.toggle('show', y > 400 || my > 400);
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        var main = document.querySelector('.main-content');
        if (main) main.addEventListener('scroll', onScroll, { passive: true });
    }

    function cleanupPortalObservers() {
        observers.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
        observers = [];
        try { disposeAchCharts(); } catch (e2) {}
        try { disposePjCharts(); } catch (e3) {}
    }

    function renderPortalModule(moduleId) {
        cleanupPortalObservers();
        invalidatePortalCache();
        syncPublicNavActive(moduleId);
        if (moduleId === 'about') renderAboutPortal();
        else if (moduleId === 'achievements') renderAchievementsPortal();
        else if (moduleId === 'projects') renderProjectsPortal();
        else if (moduleId === 'members') renderMembersPortal(membersTab);
        else if (moduleId === 'contact') renderContactPortal();
        ensureBackTop();
    }
    global.renderPortalModule = renderPortalModule;

    function patchShowModule() {
        if (typeof global.showModule !== 'function' || global.showModule.__portalPatched) return;
        var orig = global.showModule;
        global.showModule = function (moduleId) {
            var ret = orig.apply(this, arguments);
            try {
                if (['about', 'achievements', 'projects', 'members', 'contact'].indexOf(moduleId) >= 0) {
                    renderPortalModule(moduleId);
                } else {
                    syncPublicNavActive('');
                    // 离开科技页时移除科技类，避免残留观感（内容已被替换则无妨）
                    var ach = document.getElementById('achievements');
                    var pj = document.getElementById('projects');
                    if (ach && moduleId !== 'achievements') { ach.classList.remove('page-achievement-tech'); ach.classList.remove('page-achievement-theme'); }
                    if (pj && moduleId !== 'projects') pj.classList.remove('page-project-tech');
                }
            } catch (e) { console.warn('[portal]', e); }
            return ret;
        };
        global.showModule.__portalPatched = true;
    }

    function boot() {
        patchShowModule();
        // 业务数据变更时失效缓存
        global.addEventListener('storage', function (ev) {
            if (!ev || !ev.key) return;
            var hot = { teamMemberData:1, paperData:1, patentData:1, standardData:1, copyrightData:1, competitionData:1, longitudinalData:1, horizontalData:1, schoolData:1, portalContentConfig_v1:1 };
            if (hot[ev.key]) invalidatePortalCache();
        });
        setTimeout(function () {
            var active = document.querySelector('.module.active');
            if (active && ['about','achievements','projects','members','contact'].indexOf(active.id) >= 0) {
                renderPortalModule(active.id);
            }
        }, 500);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})(typeof window !== 'undefined' ? window : this);
