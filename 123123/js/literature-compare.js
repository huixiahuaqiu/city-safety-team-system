/**
 * 文献对比分析模块（工程化落地版）
 * - 左库右析 + 四视图 Tab
 * - 实时勾选刷新、维度高亮、ECharts 可视化
 * - AI 综述缓存、插入周报、保存共享文件
 * - CSV / BibTeX 导入、DOI/标题去重、与文献资料库联动
 */
(function (global) {
    'use strict';

    var MAX_SELECT = 10;
    var STORAGE_KEY = 'compareLiteratureData';
    var STATE_KEY = 'compareLiteratureUIState';
    var CACHE_KEY = 'literatureCompareAiCache';
    var TEMPLATE_KEY = 'literatureCompareDimTemplate';
    var NAMED_TEMPLATES_KEY = 'literatureCompareNamedDimTemplates';

    var litCompareCharts = { scatter: null, radar: null, bar: null };
    var litAiBusy = false;
    var litActiveTab = 'table';
    var litFilterTag = '';
    var litFilterField = '';
    var litSortKey = 'year_desc';
    var litDimTemplate = null;
    var editingLiteratureId = null;

    var DEFAULT_DIMS = [
        { key: 'year', label: '年份', type: 'base' },
        { key: 'venue', label: '会议/期刊', type: 'base' },
        { key: 'field', label: '领域', type: 'base' },
        { key: 'backbone', label: '骨干网络', type: 'ext' },
        { key: 'map', label: 'mAP (%)', type: 'metric', highlight: 'max', good: 'high' },
        { key: 'fps', label: 'FPS', type: 'metric', highlight: 'max', good: 'high' },
        { key: 'paramsM', label: '参数量(M)', type: 'metric', highlight: 'min', good: 'low' },
        { key: 'dataset', label: '数据集', type: 'ext' },
        { key: 'openSource', label: '开源', type: 'ext' },
        { key: 'innovation', label: '核心创新', type: 'ext' },
        { key: 'scenario', label: '适用场景', type: 'ext' },
        { key: 'keywords', label: '关键词', type: 'base' },
        { key: 'summary', label: '摘要', type: 'base' }
    ];

    function _esc(s) {
        if (typeof global.escHtml === 'function') return global.escHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function _owner() {
        var u = global.currentUser;
        return (u && (u.realName || u.username)) || '团队成员';
    }

    function _isAdmin() {
        var u = global.currentUser;
        return !!(u && (u.role === 'admin' || u.role === 'leader'));
    }

    function canManageLit(item) {
        if (!item) return false;
        if (!global.currentUser) return true;
        if (_isAdmin()) return true;
        return item.owner === _owner() || item.owner === (global.currentUser && global.currentUser.username);
    }

    function buildDefaultCompareLiterature() {
        var owner = '系统';
        return [
            { id: 1, title: 'YOLOv8: Optimal Speed and Accuracy of Object Detection', authors: 'Glenn Jocher et al.', year: 2023, venue: 'arXiv', field: '计算机视觉', summary: 'YOLOv8 在速度与精度间取得良好平衡，支持检测/分割/分类等多任务。', keywords: ['YOLOv8', '目标检测', '深度学习'], doi: '', group: '目标检测', owner: owner, isShared: true, ext: { backbone: 'CSPDarknet', map: 53.9, fps: 280, paramsM: 68.2, dataset: 'COCO', openSource: true, innovation: '解耦头+任务对齐分配', scenario: '云端/边缘通用', pros: '生态成熟、部署方便', cons: '超大模型显存占用高' } },
            { id: 2, title: 'YOLOv5: Real-Time Object Detection', authors: 'Ultralytics', year: 2020, venue: 'arXiv', field: '计算机视觉', summary: '工业界广泛使用的实时检测框架，易用性与工程化完善。', keywords: ['YOLOv5', '目标检测', '实时'], doi: '', group: '目标检测', owner: owner, isShared: true, ext: { backbone: 'CSPDarknet', map: 50.7, fps: 140, paramsM: 46.5, dataset: 'COCO', openSource: true, innovation: '工程化训练管线', scenario: '边缘实时检测', pros: '社区活跃', cons: '精度不及后续版本' } },
            { id: 3, title: 'Faster R-CNN: Towards Real-Time Object Detection with Region Proposal Networks', authors: 'Ren Shaoqing et al.', year: 2015, venue: 'NIPS', field: '计算机视觉', summary: '引入 RPN，将两阶段检测推向近实时。', keywords: ['Faster R-CNN', '目标检测', 'RPN'], doi: '', group: '目标检测', owner: owner, isShared: true, ext: { backbone: 'VGG/ResNet', map: 42.7, fps: 17, paramsM: 135, dataset: 'COCO/VOC', openSource: true, innovation: '区域建议网络', scenario: '高精度离线分析', pros: '精度扎实', cons: '速度偏慢' } },
            { id: 4, title: 'SSD: Single Shot MultiBox Detector', authors: 'Liu Wei et al.', year: 2016, venue: 'ECCV', field: '计算机视觉', summary: '单次多尺度特征图检测，速度与精度较均衡。', keywords: ['SSD', '目标检测', '单次检测'], doi: '', group: '目标检测', owner: owner, isShared: true, ext: { backbone: 'VGG-16', map: 46.5, fps: 59, paramsM: 34.3, dataset: 'COCO/VOC', openSource: true, innovation: '多尺度默认框', scenario: '移动端检测', pros: '结构简单', cons: '小目标弱' } },
            { id: 5, title: 'EfficientDet: Scalable and Efficient Object Detection', authors: 'Tan Mingxing et al.', year: 2020, venue: 'CVPR', field: '计算机视觉', summary: '复合缩放实现检测模型高效扩展。', keywords: ['EfficientDet', '目标检测', '模型压缩'], doi: '', group: '目标检测', owner: owner, isShared: true, ext: { backbone: 'EfficientNet', map: 52.2, fps: 62, paramsM: 52, dataset: 'COCO', openSource: true, innovation: 'BiFPN+复合缩放', scenario: '资源受限部署', pros: '效率高', cons: '训练调参复杂' } },
            { id: 6, title: 'DETR: End-to-End Object Detection with Transformers', authors: 'Carion et al.', year: 2020, venue: 'ECCV', field: '计算机视觉', summary: '首次将 Transformer 引入端到端目标检测。', keywords: ['DETR', 'Transformer', '目标检测'], doi: '', group: '目标检测', owner: owner, isShared: true, ext: { backbone: 'ResNet-50', map: 42.0, fps: 28, paramsM: 41, dataset: 'COCO', openSource: true, innovation: '集合预测+匈牙利匹配', scenario: '研究/高精度', pros: '去掉 NMS', cons: '收敛慢、小目标弱' } },
            { id: 7, title: 'Mask R-CNN', authors: 'He Kaiming et al.', year: 2017, venue: 'ICCV', field: '计算机视觉', summary: '在 Faster R-CNN 上增加实例分割分支。', keywords: ['Mask R-CNN', '实例分割', '目标检测'], doi: '', group: '分割', owner: owner, isShared: true, ext: { backbone: 'ResNet-FPN', map: 37.1, fps: 11, paramsM: 44, dataset: 'COCO', openSource: true, innovation: 'RoIAlign+掩膜分支', scenario: '精细分割', pros: '框架统一', cons: '实时性差' } },
            { id: 8, title: 'Deep Residual Learning for Image Recognition', authors: 'He Kaiming et al.', year: 2016, venue: 'CVPR', field: '计算机视觉', summary: '残差连接解决深层网络退化问题。', keywords: ['ResNet', '深度学习', '图像识别'], doi: '10.1109/CVPR.2016.90', group: '骨干网络', owner: owner, isShared: true, ext: { backbone: 'ResNet', map: null, fps: null, paramsM: 25.6, dataset: 'ImageNet', openSource: true, innovation: '残差学习', scenario: '通用骨干', pros: '影响深远', cons: '非检测专用' } },
            { id: 9, title: 'Vision Transformer (ViT)', authors: 'Dosovitskiy et al.', year: 2021, venue: 'ICLR', field: '计算机视觉', summary: '将 Transformer 用于图像分类，开创视觉 Transformer。', keywords: ['ViT', 'Transformer', '图像分类'], doi: '', group: '骨干网络', owner: owner, isShared: true, ext: { backbone: 'ViT', map: null, fps: null, paramsM: 86, dataset: 'ImageNet/JFT', openSource: true, innovation: '图像分块序列化', scenario: '大规模预训练', pros: '可扩展', cons: '小数据弱' } },
            { id: 10, title: 'Cityscapes: Semantic Understanding of Urban Street Scenes', authors: 'Cordts et al.', year: 2016, venue: 'CVPR', field: '计算机视觉', summary: '大规模城市场景语义分割数据集。', keywords: ['Cityscapes', '语义分割', '城市场景'], doi: '', group: '数据集', owner: owner, isShared: true, ext: { backbone: '-', map: null, fps: null, paramsM: null, dataset: 'Cityscapes', openSource: true, innovation: '城市街景标注基准', scenario: '城市安全/自动驾驶', pros: '场景贴近城市', cons: '非算法论文' } },
            { id: 11, title: 'MobileNetV2: Inverted Residuals and Linear Bottlenecks', authors: 'Sandler et al.', year: 2018, venue: 'CVPR', field: '计算机视觉', summary: '倒残差与线性瓶颈，适合移动端。', keywords: ['MobileNet', '轻量化', '移动端'], doi: '', group: '骨干网络', owner: owner, isShared: true, ext: { backbone: 'MobileNetV2', map: null, fps: 200, paramsM: 3.4, dataset: 'ImageNet', openSource: true, innovation: '倒残差结构', scenario: '边缘轻量部署', pros: '参数少', cons: '精度上限较低' } },
            { id: 12, title: 'Qwen-VL: A Versatile Vision-Language Model', authors: 'Alibaba Cloud', year: 2024, venue: 'arXiv', field: '多模态', summary: '具备视觉理解与图文生成能力的多模态大模型。', keywords: ['Qwen-VL', '多模态', '大模型'], doi: '', group: '多模态', owner: owner, isShared: true, ext: { backbone: 'Qwen+ViT', map: null, fps: null, paramsM: null, dataset: '多源图文', openSource: true, innovation: '统一视觉语言接口', scenario: '图文理解/安监报告', pros: '能力全面', cons: '部署成本高' } },
            { id: 13, title: 'Transformer: Attention Is All You Need', authors: 'Vaswani et al.', year: 2017, venue: 'NIPS', field: '自然语言处理', summary: '自注意力架构，奠定现代大模型基础。', keywords: ['Transformer', '注意力机制', 'NLP'], doi: '', group: '基础模型', owner: owner, isShared: true, ext: { backbone: 'Transformer', map: null, fps: null, paramsM: 65, dataset: 'WMT', openSource: true, innovation: '自注意力', scenario: '通用序列建模', pros: '范式变革', cons: '非视觉专用' } },
            { id: 14, title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: 'Devlin et al.', year: 2019, venue: 'NAACL', field: '自然语言处理', summary: '双向 Transformer 预训练，多项 NLP 任务突破。', keywords: ['BERT', '预训练', 'NLP'], doi: '', group: '基础模型', owner: owner, isShared: true, ext: { backbone: 'Transformer', map: null, fps: null, paramsM: 110, dataset: 'BooksCorpus/Wiki', openSource: true, innovation: '掩码语言模型', scenario: '文本理解', pros: '迁移强', cons: '生成弱' } },
            { id: 15, title: 'GPT-3: Language Models are Few-Shot Learners', authors: 'Brown et al.', year: 2020, venue: 'NeurIPS', field: '自然语言处理', summary: '1750 亿参数大模型，展示少样本学习能力。', keywords: ['GPT-3', '大语言模型', '少样本'], doi: '', group: '基础模型', owner: owner, isShared: true, ext: { backbone: 'Transformer', map: null, fps: null, paramsM: 175000, dataset: '多源文本', openSource: false, innovation: '规模换能力', scenario: '通用生成/问答', pros: '能力强', cons: '闭源且昂贵' } }
        ].map(normalizeLitItem);
    }

    function normalizeLitItem(item, idx) {
        var x = Object.assign({}, item || {});
        x.id = Number(x.id) || (idx + 1);
        x.title = String(x.title || '').trim() || ('未命名文献' + x.id);
        x.authors = String(x.authors || x.author || '').trim();
        x.author = x.authors;
        x.year = parseInt(x.year, 10);
        if (isNaN(x.year)) x.year = null;
        x.venue = String(x.venue || x.journal || '').trim();
        x.journal = x.venue;
        x.field = String(x.field || '').trim() || '未分类';
        x.summary = String(x.summary || x.abstract || '').trim();
        x.keywords = Array.isArray(x.keywords)
            ? x.keywords.map(function (k) { return String(k).trim(); }).filter(Boolean)
            : String(x.keywords || x.tags || '').split(/[,，;/|]/).map(function (k) { return k.trim(); }).filter(Boolean);
        x.doi = String(x.doi || '').trim();
        x.paperUrl = String(x.paperUrl || x.url || '').trim();
        x.group = String(x.group || '').trim();
        x.owner = x.owner || _owner();
        x.isShared = x.isShared !== false;
        var ext = Object.assign({}, x.ext || x.ext_info || {});
        ['backbone', 'dataset', 'innovation', 'scenario', 'pros', 'cons'].forEach(function (k) {
            if (ext[k] == null) ext[k] = '';
            else ext[k] = String(ext[k]);
        });
        ['map', 'fps', 'paramsM'].forEach(function (k) {
            if (ext[k] === '' || ext[k] == null) ext[k] = null;
            else {
                var n = Number(ext[k]);
                ext[k] = isNaN(n) ? null : n;
            }
        });
        if (typeof ext.openSource === 'string') {
            ext.openSource = /^(1|true|yes|是|开源)$/i.test(ext.openSource);
        } else if (ext.openSource == null) {
            ext.openSource = false;
        }
        x.ext = ext;
        return x;
    }

    function saveCompareLiteratureData() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(global.compareLiteratureData || []));
        } catch (e) {}
        try {
            if (typeof global.cloudUpsert === 'function') {
                global.cloudUpsert(STORAGE_KEY, JSON.stringify(global.compareLiteratureData || []));
            }
        } catch (e2) {}
    }

    function saveLitUIState() {
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify({
                selected: global.selectedLiteratures || [],
                tab: litActiveTab,
                tag: litFilterTag,
                field: litFilterField,
                sort: litSortKey
            }));
        } catch (e) {}
    }

    function loadLitUIState() {
        try {
            var s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
            if (!s) return;
            global.selectedLiteratures = Array.isArray(s.selected) ? s.selected.map(Number).filter(Boolean) : [];
            litActiveTab = s.tab || 'table';
            litFilterTag = s.tag || '';
            litFilterField = s.field || '';
            litSortKey = s.sort || 'year_desc';
        } catch (e) {}
    }

    function loadDimTemplate() {
        try {
            var t = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || 'null');
            litDimTemplate = Array.isArray(t) && t.length ? t : DEFAULT_DIMS.map(function (d) { return d.key; });
        } catch (e) {
            litDimTemplate = DEFAULT_DIMS.map(function (d) { return d.key; });
        }
    }

    function saveDimTemplate() {
        try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(litDimTemplate)); } catch (e) {}
    }

    function loadNamedDimTemplates() {
        try {
            var o = JSON.parse(localStorage.getItem(NAMED_TEMPLATES_KEY) || '{}');
            return o && typeof o === 'object' ? o : {};
        } catch (e) { return {}; }
    }

    function saveNamedDimTemplates(map) {
        try { localStorage.setItem(NAMED_TEMPLATES_KEY, JSON.stringify(map || {})); } catch (e) {}
    }

    function saveNamedLitDimTemplate() {
        loadDimTemplate();
        var name = prompt('为当前对比维度组合命名（如：精度速度选型）');
        if (!name) return;
        name = String(name).trim();
        if (!name) return;
        var map = loadNamedDimTemplates();
        map[name] = litDimTemplate.slice();
        saveNamedDimTemplates(map);
        if (typeof global.showCloudSyncBanner === 'function') global.showCloudSyncBanner('已保存维度模板「' + name + '」', false);
        else alert('已保存模板「' + name + '」');
        renderLitTableView();
    }
    global.saveNamedLitDimTemplate = saveNamedLitDimTemplate;

    function applyNamedLitDimTemplate(name) {
        if (!name) return;
        var map = loadNamedDimTemplates();
        if (!map[name] || !Array.isArray(map[name])) return;
        litDimTemplate = map[name].slice();
        saveDimTemplate();
        renderLitTableView();
    }
    global.applyNamedLitDimTemplate = applyNamedLitDimTemplate;

    function deleteNamedLitDimTemplate(name) {
        if (!name) return;
        if (!confirm('删除命名模板「' + name + '」？')) return;
        var map = loadNamedDimTemplates();
        delete map[name];
        saveNamedDimTemplates(map);
        renderLitTableView();
    }
    global.deleteNamedLitDimTemplate = deleteNamedLitDimTemplate;

    function namedDimTemplateSelectHtml() {
        var map = loadNamedDimTemplates();
        var names = Object.keys(map);
        var opts = '<option value="">加载命名模板…</option>' + names.map(function (n) {
            return '<option value="' + _esc(n) + '">' + _esc(n) + '</option>';
        }).join('');
        return '<select class="form-control" style="width:150px;display:inline-block;padding:4px 8px;font-size:12px;" onchange="applyNamedLitDimTemplate(this.value); this.value=\'\';">' + opts + '</select>' +
            (names.length ? '<button class="btn btn-secondary" style="padding:4px 8px;font-size:12px;" onclick="(function(){var n=prompt(\'输入要删除的模板名：\\n' + names.map(function (x) { return _esc(x); }).join(' / ') + '\'); if(n) deleteNamedLitDimTemplate(n);})()">删模板</button>' : '');
    }

    function getAiCacheMap() {
        try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
    }

    function setAiCache(idsKey, text) {
        var map = getAiCacheMap();
        map[idsKey] = { text: text, at: new Date().toISOString(), model: ((document.getElementById('openaiModel') || {}).value) || 'qwen-plus' };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(map)); } catch (e) {}
    }

    function selectedIdsKey() {
        return (global.selectedLiteratures || []).slice().sort(function (a, b) { return a - b; }).join(',');
    }

    function getSelectedItems() {
        var ids = global.selectedLiteratures || [];
        return (global.compareLiteratureData || []).filter(function (l) { return ids.indexOf(l.id) >= 0; })
            .sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });
    }

    function litDedupKey(item) {
        var doi = String(item.doi || '').trim().toLowerCase();
        if (doi) return 'doi:' + doi;
        return 'title:' + String(item.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function findDuplicate(item) {
        var key = litDedupKey(item);
        return (global.compareLiteratureData || []).find(function (x) {
            return litDedupKey(x) === key;
        });
    }

    function syncFromLiteratureLibrary(silent) {
        if (typeof global.literatureData === 'undefined' || !Array.isArray(global.literatureData)) {
            if (!silent) alert('文献资料库暂无数据');
            return 0;
        }
        var added = 0;
        global.literatureData.forEach(function (lib) {
            var mapped = normalizeLitItem({
                title: lib.title,
                authors: lib.author || lib.authors,
                year: lib.year,
                venue: lib.journal || lib.venue,
                field: (lib.tags || '').split(/[,，]/)[0] || '文献资料库',
                summary: lib.summary || lib.description || '',
                keywords: lib.tags || lib.keywords || [],
                doi: lib.doi || '',
                owner: lib.uploader || _owner(),
                isShared: true,
                group: '文献资料库',
                ext: lib.ext || {}
            });
            if (findDuplicate(mapped)) return;
            var newId = (global.compareLiteratureData || []).length
                ? Math.max.apply(null, global.compareLiteratureData.map(function (l) { return Number(l.id) || 0; })) + 1
                : 1;
            mapped.id = newId;
            global.compareLiteratureData.push(mapped);
            added++;
        });
        if (added) {
            saveCompareLiteratureData();
            renderLiteratureCompareList();
            refreshLitCompareViews();
        }
        if (!silent) alert(added ? ('已从文献资料库同步 ' + added + ' 篇（已自动去重）') : '没有可同步的新文献（可能已全部存在）');
        return added;
    }

    function getFilteredSortedLiterature() {
        var q = String((document.getElementById('literatureSearch') || {}).value || '').trim().toLowerCase();
        var yearFrom = parseInt((document.getElementById('litYearFrom') || {}).value, 10);
        var yearTo = parseInt((document.getElementById('litYearTo') || {}).value, 10);
        var list = (global.compareLiteratureData || []).filter(function (item) {
            if (litFilterTag && (item.keywords || []).indexOf(litFilterTag) < 0) return false;
            if (litFilterField && item.field !== litFilterField) return false;
            if (!isNaN(yearFrom) && item.year && item.year < yearFrom) return false;
            if (!isNaN(yearTo) && item.year && item.year > yearTo) return false;
            if (!q) return true;
            var blob = [item.title, item.authors, item.venue, item.field, item.summary, item.doi, (item.keywords || []).join(' ')].join(' ').toLowerCase();
            return blob.indexOf(q) >= 0;
        });
        list.sort(function (a, b) {
            if (litSortKey === 'year_asc') return (a.year || 0) - (b.year || 0);
            if (litSortKey === 'year_desc') return (b.year || 0) - (a.year || 0);
            if (litSortKey === 'map_desc') return ((b.ext && b.ext.map) || -1) - ((a.ext && a.ext.map) || -1);
            if (litSortKey === 'fps_desc') return ((b.ext && b.ext.fps) || -1) - ((a.ext && a.ext.fps) || -1);
            if (litSortKey === 'title') return String(a.title).localeCompare(String(b.title), 'zh');
            return 0;
        });
        return list;
    }

    function collectTagStats() {
        var map = {};
        (global.compareLiteratureData || []).forEach(function (item) {
            (item.keywords || []).forEach(function (k) {
                map[k] = (map[k] || 0) + 1;
            });
        });
        var extra = typeof global.getLiteratureAllTags === 'function' ? global.getLiteratureAllTags() : [];
        extra.forEach(function (k) {
            if (!map[k]) map[k] = 0;
        });
        return Object.keys(map).sort(function (a, b) {
            if (map[b] !== map[a]) return map[b] - map[a];
            return a.localeCompare(b, 'zh-CN');
        }).slice(0, 20).map(function (k) {
            return { tag: k, count: map[k] };
        });
    }

    function collectFields() {
        var set = {};
        (global.compareLiteratureData || []).forEach(function (item) {
            if (item.field) set[item.field] = true;
        });
        return Object.keys(set).sort();
    }

    function renderLitTagChips() {
        var box = document.getElementById('litTagChips');
        if (!box) return;
        var tags = collectTagStats();
        box.innerHTML = '<button type="button" class="lit-chip' + (!litFilterTag ? ' active' : '') + '" onclick="setLitFilterTag(\'\')">全部</button>' +
            tags.map(function (t) {
                var countHtml = t.count ? (' <span>' + t.count + '</span>') : '';
                return '<button type="button" class="lit-chip' + (litFilterTag === t.tag ? ' active' : '') + '" onclick="setLitFilterTag(' + JSON.stringify(t.tag) + ')">#' + _esc(t.tag) + countHtml + '</button>';
            }).join('') +
            '<button type="button" class="lit-chip lit-chip-add" onclick="compareAddLitTag()">+ 添加</button>';
    }

    function compareAddLitTag() {
        var name = prompt('输入新标签名称（将同步到资料库标签库）：');
        if (!name) return;
        var addFn = global.addLiteratureCustomTag;
        var tag = typeof addFn === 'function' ? addFn(name) : String(name).trim();
        if (!tag) return;
        litFilterTag = tag;
        saveLitUIState();
        renderLiteratureCompareList();
    }
    global.compareAddLitTag = compareAddLitTag;

    function renderLitFieldFilter() {
        var sel = document.getElementById('litFieldFilter');
        if (!sel) return;
        var cur = litFilterField;
        sel.innerHTML = '<option value="">全部领域</option>' + collectFields().map(function (f) {
            return '<option value="' + _esc(f) + '"' + (cur === f ? ' selected' : '') + '>' + _esc(f) + '</option>';
        }).join('');
    }

    function setLitFilterTag(tag) {
        litFilterTag = tag || '';
        saveLitUIState();
        renderLiteratureCompareList();
    }
    global.setLitFilterTag = setLitFilterTag;

    function onLitFilterChange() {
        litFilterField = (document.getElementById('litFieldFilter') || {}).value || '';
        litSortKey = (document.getElementById('litSortKey') || {}).value || 'year_desc';
        saveLitUIState();
        renderLiteratureCompareList();
    }
    global.onLitFilterChange = onLitFilterChange;

    function metricBadge(item) {
        var parts = [];
        if (item.ext && item.ext.map != null) parts.push('mAP ' + item.ext.map);
        if (item.ext && item.ext.fps != null) parts.push('FPS ' + item.ext.fps);
        if (item.ext && item.ext.paramsM != null) parts.push(item.ext.paramsM + 'M');
        return parts.length ? ('<div class="lit-metrics">' + parts.map(function (p) { return '<span>' + _esc(p) + '</span>'; }).join('') + '</div>') : '';
    }

    function renderLiteratureCompareList() {
        var list = document.getElementById('literatureCompareList');
        var count = document.getElementById('literatureCount');
        var selBar = document.getElementById('litSelectionBar');
        if (!list) return;
        renderLitTagChips();
        renderLitFieldFilter();
        var rows = getFilteredSortedLiterature();
        if (count) count.textContent = rows.length + '/' + (global.compareLiteratureData || []).length + ' 篇';
        if (!rows.length) {
            list.innerHTML = '<div class="lit-empty">暂无匹配文献，可添加或从文献资料库同步</div>';
        } else {
            var maxed = (global.selectedLiteratures || []).length >= MAX_SELECT;
            list.innerHTML = rows.map(function (item) {
                var selected = (global.selectedLiteratures || []).indexOf(item.id) >= 0;
                var disabled = !selected && maxed;
                var preview = _esc((item.summary || '').slice(0, 160));
                return '<div class="lit-card' + (selected ? ' selected' : '') + (disabled ? ' disabled' : '') + '" data-id="' + item.id + '" onclick="toggleLiteratureSelection(' + item.id + ')" title="' + preview + '">' +
                    '<div class="lit-card-main">' +
                    '<input type="checkbox" ' + (selected ? 'checked' : '') + (disabled ? ' disabled' : '') + ' onclick="event.stopPropagation();toggleLiteratureSelection(' + item.id + ')">' +
                    '<div class="lit-card-body">' +
                    '<div class="lit-card-title">' + _esc(item.title) + '</div>' +
                    '<div class="lit-card-meta">' + _esc(item.authors || '未知作者') + ' · ' + (item.year || '-') + ' · ' + _esc(item.venue || '-') + '</div>' +
                    '<div class="lit-card-tags">' + (item.keywords || []).slice(0, 4).map(function (k) { return '<span>#' + _esc(k) + '</span>'; }).join('') + '</div>' +
                    metricBadge(item) +
                    '</div></div>' +
                    '<div class="lit-card-actions" onclick="event.stopPropagation()">' +
                    '<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="showEditLiteratureModal(' + item.id + ')">编辑</button>' +
                    (canManageLit(item) ? '<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;color:#dc2626;" onclick="deleteLiterature(' + item.id + ')">删除</button>' : '') +
                    '</div></div>';
            }).join('');
        }
        if (selBar) {
            var n = (global.selectedLiteratures || []).length;
            selBar.innerHTML = '<span>已选 <strong>' + n + '/' + MAX_SELECT + '</strong></span>' +
                '<span style="color:#9ca3af;">勾选即实时刷新右侧对比</span>' +
                '<button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="clearLitSelection()" ' + (n ? '' : 'disabled') + '>清空选择</button>';
        }
        var sortEl = document.getElementById('litSortKey');
        if (sortEl) sortEl.value = litSortKey;
    }
    global.renderLiteratureCompareList = renderLiteratureCompareList;

    function toggleLiteratureSelection(id) {
        id = Number(id);
        var arr = global.selectedLiteratures || (global.selectedLiteratures = []);
        var idx = arr.indexOf(id);
        if (idx >= 0) arr.splice(idx, 1);
        else {
            if (arr.length >= MAX_SELECT) {
                alert('最多选择 ' + MAX_SELECT + ' 篇文献进行对比');
                return;
            }
            arr.push(id);
        }
        saveLitUIState();
        renderLiteratureCompareList();
        refreshLitCompareViews();
    }
    global.toggleLiteratureSelection = toggleLiteratureSelection;

    function clearLitSelection() {
        global.selectedLiteratures = [];
        saveLitUIState();
        renderLiteratureCompareList();
        refreshLitCompareViews();
    }
    global.clearLitSelection = clearLitSelection;

    function switchLitTab(tab) {
        litActiveTab = tab || 'table';
        saveLitUIState();
        ['table', 'chart', 'ai', 'timeline'].forEach(function (t) {
            var pane = document.getElementById('litPane_' + t);
            var btn = document.getElementById('litTab_' + t);
            if (pane) pane.style.display = t === litActiveTab ? 'block' : 'none';
            if (btn) btn.classList.toggle('active', t === litActiveTab);
        });
        refreshLitCompareViews();
    }
    global.switchLitTab = switchLitTab;

    function dimValue(item, dim) {
        if (dim.type === 'base') {
            if (dim.key === 'keywords') return (item.keywords || []).join('、') || '-';
            if (dim.key === 'venue') return item.venue || '-';
            if (dim.key === 'year') return item.year != null ? String(item.year) : '-';
            return item[dim.key] != null && item[dim.key] !== '' ? String(item[dim.key]) : '-';
        }
        var v = item.ext ? item.ext[dim.key] : null;
        if (dim.key === 'openSource') return v ? '是' : '否';
        if (v == null || v === '') return '-';
        return String(v);
    }

    function computeHighlights(selected, dims) {
        var marks = {};
        dims.forEach(function (dim) {
            if (dim.type !== 'metric') return;
            var nums = selected.map(function (it) {
                var v = it.ext ? it.ext[dim.key] : null;
                return v == null ? null : Number(v);
            });
            var valid = nums.filter(function (n) { return n != null && !isNaN(n); });
            if (valid.length < 2) return;
            var best = dim.highlight === 'min' ? Math.min.apply(null, valid) : Math.max.apply(null, valid);
            var avg = valid.reduce(function (a, b) { return a + b; }, 0) / valid.length;
            selected.forEach(function (it, i) {
                var v = nums[i];
                if (v == null) return;
                marks[it.id + ':' + dim.key] = marks[it.id + ':' + dim.key] || [];
                if (v === best) marks[it.id + ':' + dim.key].push('best');
                if (avg > 0 && Math.abs(v - avg) / avg >= 0.3) marks[it.id + ':' + dim.key].push('gap');
            });
        });
        return marks;
    }

    function renderLitTableView() {
        var box = document.getElementById('litPane_table');
        if (!box) return;
        var selected = getSelectedItems();
        if (selected.length < 1) {
            box.innerHTML = emptyStateHtml('请从左侧勾选至少 1 篇文献，实时生成对比表');
            return;
        }
        loadDimTemplate();
        var dims = DEFAULT_DIMS.filter(function (d) { return litDimTemplate.indexOf(d.key) >= 0; });
        var marks = computeHighlights(selected, dims);
        var dimChecks = DEFAULT_DIMS.map(function (d) {
            return '<label class="lit-dim-check"><input type="checkbox" ' + (litDimTemplate.indexOf(d.key) >= 0 ? 'checked' : '') + ' onchange="toggleLitDim(' + JSON.stringify(d.key) + ', this.checked)"> ' + _esc(d.label) + '</label>';
        }).join('');

        var head = '<th class="sticky-col">维度</th>' + selected.map(function (it, i) {
            return '<th title="' + _esc(it.title) + '">文献' + (i + 1) + '<div class="lit-th-sub">' + _esc(it.title.slice(0, 28)) + (it.title.length > 28 ? '…' : '') + '</div></th>';
        }).join('');

        var body = dims.map(function (dim) {
            return '<tr><td class="sticky-col"><strong>' + _esc(dim.label) + '</strong></td>' + selected.map(function (it) {
                var val = dimValue(it, dim);
                var mk = marks[it.id + ':' + dim.key] || [];
                var cls = '';
                if (mk.indexOf('best') >= 0) cls = 'lit-cell-best';
                else if (mk.indexOf('gap') >= 0) cls = 'lit-cell-gap';
                return '<td class="' + cls + '">' + _esc(val) + '</td>';
            }).join('') + '</tr>';
        }).join('');

        box.innerHTML =
            '<div class="lit-dim-bar"><span>对比维度</span>' + dimChecks +
            '<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;margin-left:8px;" onclick="saveNamedLitDimTemplate()">保存为模板</button>' +
            namedDimTemplateSelectHtml() +
            '<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;margin-left:auto;" onclick="exportLitCompareCsv()">导出对比 CSV</button></div>' +
            '<div class="lit-table-wrap"><table class="lit-compare-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
            '<div class="lit-legend"><span class="lit-cell-best">最优指标</span><span class="lit-cell-gap">与均值差 ≥30%</span></div>';
    }

    function toggleLitDim(key, on) {
        loadDimTemplate();
        var i = litDimTemplate.indexOf(key);
        if (on && i < 0) litDimTemplate.push(key);
        if (!on && i >= 0) litDimTemplate.splice(i, 1);
        if (!litDimTemplate.length) litDimTemplate = ['year', 'venue', 'map', 'fps'];
        saveDimTemplate();
        renderLitTableView();
    }
    global.toggleLitDim = toggleLitDim;

    function emptyStateHtml(msg) {
        return '<div class="lit-empty-pane"><div class="lit-empty-ico">📊</div><div>' + _esc(msg) + '</div><div style="font-size:12px;color:#9ca3af;margin-top:6px;">最多可选 ' + MAX_SELECT + ' 篇</div></div>';
    }

    function destroyLitCharts() {
        Object.keys(litCompareCharts).forEach(function (k) {
            if (litCompareCharts[k]) {
                try { litCompareCharts[k].dispose(); } catch (e) {}
                litCompareCharts[k] = null;
            }
        });
    }

    function renderLitChartView() {
        var box = document.getElementById('litPane_chart');
        if (!box) return;
        destroyLitCharts();
        var selected = getSelectedItems();
        if (selected.length < 2) {
            box.innerHTML = emptyStateHtml('请至少勾选 2 篇文献以生成可视化对比');
            return;
        }
        if (typeof global.echarts === 'undefined') {
            box.innerHTML = emptyStateHtml('ECharts 未加载，请检查网络或刷新页面');
            return;
        }
        box.innerHTML =
            '<div class="lit-chart-grid">' +
            '<div class="lit-chart-card"><div class="lit-chart-title">精度-速度散点图（mAP vs FPS）</div><div id="litChartScatter" style="height:320px;"></div></div>' +
            '<div class="lit-chart-card"><div class="lit-chart-title">多维雷达图</div><div id="litChartRadar" style="height:320px;"></div></div>' +
            '<div class="lit-chart-card" style="grid-column:1/-1;"><div class="lit-chart-title">单维柱状对比</div>' +
            '<div style="margin-bottom:8px;"><select id="litBarMetric" class="form-control" style="width:160px;display:inline-block;" onchange="renderLitBarChart()">' +
            '<option value="map">mAP</option><option value="fps">FPS</option><option value="paramsM">参数量(M)</option></select></div>' +
            '<div id="litChartBar" style="height:300px;"></div></div></div>';

        var scatterData = selected.map(function (it) {
            return {
                name: it.title.slice(0, 24),
                value: [it.ext && it.ext.fps != null ? it.ext.fps : 0, it.ext && it.ext.map != null ? it.ext.map : 0, it.ext && it.ext.paramsM != null ? it.ext.paramsM : 10],
                full: it.title
            };
        }).filter(function (d) { return d.value[0] > 0 || d.value[1] > 0; });

        litCompareCharts.scatter = global.echarts.init(document.getElementById('litChartScatter'));
        litCompareCharts.scatter.setOption({
            tooltip: { formatter: function (p) { return p.data.full + '<br/>FPS: ' + p.data.value[0] + '<br/>mAP: ' + p.data.value[1]; } },
            grid: { left: 50, right: 20, top: 30, bottom: 40 },
            xAxis: { name: 'FPS', type: 'value', nameLocation: 'middle', nameGap: 28 },
            yAxis: { name: 'mAP (%)', type: 'value', nameLocation: 'middle', nameGap: 36 },
            series: [{
                type: 'scatter',
                symbolSize: function (val) { return Math.max(12, Math.min(40, (val[2] || 10) / 3)); },
                data: scatterData,
                itemStyle: { color: '#7c3aed' }
            }]
        });

        var radarDims = [
            { name: '精度', key: 'map', max: 70 },
            { name: '速度', key: 'fps', max: 300 },
            { name: '轻量', key: 'paramsM', invert: true, max: 100 },
            { name: '开源', key: 'openSource', max: 1 },
            { name: '年份新', key: 'year', max: 2026, min: 2014 }
        ];
        var radarSeries = selected.slice(0, 6).map(function (it) {
            return {
                name: it.title.slice(0, 18),
                value: radarDims.map(function (d) {
                    if (d.key === 'openSource') return it.ext && it.ext.openSource ? 1 : 0;
                    if (d.key === 'year') return Math.max(0, Math.min(1, ((it.year || 2014) - (d.min || 2014)) / ((d.max || 2026) - (d.min || 2014)))) * (d.max || 1);
                    var v = it.ext ? Number(it.ext[d.key]) : NaN;
                    if (isNaN(v)) return 0;
                    if (d.invert) return Math.max(0, d.max - Math.min(d.max, v));
                    return Math.min(d.max, v);
                })
            };
        });
        litCompareCharts.radar = global.echarts.init(document.getElementById('litChartRadar'));
        litCompareCharts.radar.setOption({
            tooltip: {},
            legend: { type: 'scroll', bottom: 0, data: radarSeries.map(function (s) { return s.name; }) },
            radar: {
                indicator: radarDims.map(function (d) { return { name: d.name, max: d.max }; }),
                radius: '58%'
            },
            series: [{ type: 'radar', data: radarSeries }]
        });

        renderLitBarChart();
    }

    function renderLitBarChart() {
        if (typeof global.echarts === 'undefined') return;
        var el = document.getElementById('litChartBar');
        if (!el) return;
        var metric = (document.getElementById('litBarMetric') || {}).value || 'map';
        var selected = getSelectedItems();
        var labels = selected.map(function (it, i) { return '文献' + (i + 1); });
        var values = selected.map(function (it) {
            var v = it.ext ? it.ext[metric] : null;
            return v == null ? 0 : Number(v);
        });
        if (litCompareCharts.bar) {
            try { litCompareCharts.bar.dispose(); } catch (e) {}
        }
        litCompareCharts.bar = global.echarts.init(el);
        litCompareCharts.bar.setOption({
            tooltip: {
                formatter: function (p) {
                    var it = selected[p.dataIndex];
                    return (it ? it.title : '') + '<br/>' + p.seriesName + ': ' + p.value;
                }
            },
            grid: { left: 50, right: 20, top: 30, bottom: 60 },
            xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: 20 } },
            yAxis: { type: 'value', name: metric },
            series: [{
                name: metric,
                type: 'bar',
                data: values,
                itemStyle: {
                    color: new global.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: '#a78bfa' },
                        { offset: 1, color: '#7c3aed' }
                    ])
                }
            }]
        });
    }
    global.renderLitBarChart = renderLitBarChart;

    function renderLitTimelineView() {
        var box = document.getElementById('litPane_timeline');
        if (!box) return;
        var selected = getSelectedItems().slice().sort(function (a, b) { return (a.year || 0) - (b.year || 0); });
        if (!selected.length) {
            box.innerHTML = emptyStateHtml('勾选文献后按发表年份生成技术时间线');
            return;
        }
        box.innerHTML = '<div class="lit-timeline">' + selected.map(function (it, i) {
            var next = selected[i + 1];
            var link = '';
            if (next) {
                var aKeys = it.keywords || [];
                var bKeys = next.keywords || [];
                var shared = aKeys.filter(function (k) { return bKeys.indexOf(k) >= 0; });
                if (shared.length) link = '<div class="lit-tl-link">技术关联：' + shared.slice(0, 3).map(function (k) { return '#' + _esc(k); }).join(' ') + '</div>';
                else if ((it.group && it.group === next.group) || (it.field && it.field === next.field)) {
                    link = '<div class="lit-tl-link">同领域演进：' + _esc(it.field || it.group) + '</div>';
                }
            }
            return '<div class="lit-tl-item">' +
                '<div class="lit-tl-year">' + (it.year || '?') + '</div>' +
                '<div class="lit-tl-card">' +
                '<div class="lit-tl-title">' + _esc(it.title) + '</div>' +
                '<div class="lit-tl-meta">' + _esc(it.authors) + ' · ' + _esc(it.venue) + '</div>' +
                '<div class="lit-tl-innov">' + _esc((it.ext && it.ext.innovation) || it.summary.slice(0, 100) || '—') + '</div>' +
                metricBadge(it) +
                '</div>' + link + '</div>';
        }).join('') + '</div>';
    }

    function renderLitAiView(preserveContent) {
        var box = document.getElementById('litPane_ai');
        if (!box) return;
        var selected = getSelectedItems();
        if (selected.length < 2) {
            box.innerHTML = emptyStateHtml('请至少勾选 2 篇文献，再生成 AI 深度综述');
            return;
        }
        if (preserveContent && box.querySelector('.lit-ai-result')) return;

        var cache = getAiCacheMap()[selectedIdsKey()];
        var body = cache
            ? '<div class="lit-ai-result" id="litAiResultText">' + _esc(cache.text) + '</div><div class="lit-ai-meta">缓存于 ' + _esc(cache.at) + ' · ' + _esc(cache.model || '') + '</div>'
            : '<div class="lit-ai-placeholder">点击下方按钮生成结构化综述（相关工作可直接复用）。相同文献组合会命中本地缓存。</div>';

        box.innerHTML =
            '<div class="lit-ai-toolbar">' +
            '<button class="btn" id="litAiRunBtn" onclick="aiCompareSelectedLiterature()" style="background:linear-gradient(135deg,#7c3aed,#4f46e5);">✨ AI 一键综述</button>' +
            '<button class="btn btn-secondary" onclick="copyLitAiResult()">复制</button>' +
            '<button class="btn btn-secondary" onclick="insertLitAiToWeeklyReport()">插入本周周报</button>' +
            '<button class="btn btn-secondary" onclick="saveLitAiToSharedFiles()">保存到共享文件库</button>' +
            '<button class="btn btn-secondary" onclick="clearLitAiCache()">清除本组缓存</button>' +
            '</div>' +
            '<div class="lit-ai-hint">输出结构：核心异同 · 技术演进 · 场景化选型（城市安全/工地） · 创新点启发</div>' +
            '<div id="litAiBody">' + body + '</div>' +
            '<div class="lit-ai-follow">' +
            '<input type="text" id="litAiFollowInput" class="form-control" placeholder="继续追问，例如：哪篇更适合边缘端部署？" onkeydown="if(event.key===\'Enter\'){litAiFollowUp();}">' +
            '<button class="btn btn-secondary" onclick="litAiFollowUp()">追问</button></div>';
    }

    function refreshLitCompareViews() {
        if (litActiveTab === 'table') renderLitTableView();
        else if (litActiveTab === 'chart') renderLitChartView();
        else if (litActiveTab === 'ai') renderLitAiView(true);
        else if (litActiveTab === 'timeline') renderLitTimelineView();
        // 非当前 tab 也预渲染 table 结构不必须；切 tab 时再渲
        var badge = document.getElementById('litSelectedBadge');
        if (badge) badge.textContent = (global.selectedLiteratures || []).length + ' 篇已选';
    }
    global.refreshLitCompareViews = refreshLitCompareViews;
    global.compareSelectedLiterature = function () {
        switchLitTab('table');
        refreshLitCompareViews();
    };

    async function callLitAliyun(messages, maxTokens) {
        var apiKey = typeof global.getChatApiKey === 'function' ? global.getChatApiKey() : (localStorage.getItem('openaiApiKey') || '');
        if (!apiKey) throw new Error('未配置百炼 API 密钥，请到「OpenAI入口」保存');
        var endpoint = (typeof global.API_PROXY !== 'undefined' && global.API_PROXY ? String(global.API_PROXY).replace(/\/$/, '') : '') + '/api/aliyun';
        var resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apiKey: apiKey,
                model: ((document.getElementById('openaiModel') || {}).value) || 'qwen-plus',
                messages: messages,
                temperature: 0.3,
                max_tokens: maxTokens || 2200
            })
        });
        var text = await resp.text();
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + text.slice(0, 160));
        var data = JSON.parse(text);
        var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content) throw new Error('模型无返回内容');
        return String(content).trim();
    }

    async function aiCompareSelectedLiterature(force) {
        if (litAiBusy) return;
        var selected = getSelectedItems();
        if (selected.length < 2) {
            alert('请至少选择 2 篇文献');
            return;
        }
        switchLitTab('ai');
        var key = selectedIdsKey();
        if (!force) {
            var cached = getAiCacheMap()[key];
            if (cached && cached.text) {
                renderLitAiView(false);
                return;
            }
        }
        litAiBusy = true;
        var btn = document.getElementById('litAiRunBtn');
        if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
        var body = document.getElementById('litAiBody');
        if (body) {
            body.innerHTML = '<div class="lit-ai-loading"><div class="team-chat-typing"><span></span><span></span><span></span></div> 正在生成结构化综述…</div>';
        }
        var listText = selected.map(function (l, i) {
            return (i + 1) + '. 《' + l.title + '》\n作者：' + l.authors + '；年份：' + (l.year || '-') + '；会议/期刊：' + l.venue +
                '；领域：' + l.field + '\n关键词：' + (l.keywords || []).join('、') +
                '\n指标：mAP=' + ((l.ext && l.ext.map) != null ? l.ext.map : '-') +
                ', FPS=' + ((l.ext && l.ext.fps) != null ? l.ext.fps : '-') +
                ', 参数量M=' + ((l.ext && l.ext.paramsM) != null ? l.ext.paramsM : '-') +
                ', 骨干=' + ((l.ext && l.ext.backbone) || '-') +
                '\n创新：' + ((l.ext && l.ext.innovation) || '-') +
                '\n摘要：' + (l.summary || '-');
        }).join('\n\n');
        try {
            var content = await callLitAliyun([
                {
                    role: 'system',
                    content: '你是城市安全数智创新团队的科研文献分析助手。必须基于给定文献信息输出简体中文结构化综述，不要编造未提供的指标或结论。固定四段标题：\n## 1. 核心异同总结\n## 2. 技术演进脉络\n## 3. 场景化选型建议（云端高精度 / 边缘实时 / 低光照复杂场景）\n## 4. 创新点启发\n每段简洁可直接用于论文「相关工作」。'
                },
                { role: 'user', content: '请对比以下 ' + selected.length + ' 篇文献：\n\n' + listText }
            ], 2200);
            setAiCache(key, content);
            if (body) {
                body.innerHTML = '<div class="lit-ai-result" id="litAiResultText">' + _esc(content) + '</div>';
            }
            if (typeof global.recordOperationLog === 'function') {
                global.recordOperationLog('文献对比', 'AI综述', 'AI 综述 ' + selected.length + ' 篇', { count: selected.length }, { success: true }, 1, '', 0);
            }
        } catch (e) {
            if (body) {
                body.innerHTML = '<div class="lit-ai-error">生成失败：' + _esc(e && e.message ? e.message : String(e)) + '<br>请确认 start_web.py 已启动且密钥有效。</div>';
            }
        } finally {
            litAiBusy = false;
            if (btn) { btn.disabled = false; btn.textContent = '✨ AI 一键综述'; }
        }
    }
    global.aiCompareSelectedLiterature = aiCompareSelectedLiterature;

    async function litAiFollowUp() {
        var input = document.getElementById('litAiFollowInput');
        var q = input ? input.value.trim() : '';
        if (!q) return;
        var prev = (document.getElementById('litAiResultText') || {}).textContent || '';
        if (!prev) {
            alert('请先生成综述再追问');
            return;
        }
        var selected = getSelectedItems();
        var body = document.getElementById('litAiBody');
        if (body) body.innerHTML = '<div class="lit-ai-loading"><div class="team-chat-typing"><span></span><span></span><span></span></div> 追问中…</div>';
        try {
            var content = await callLitAliyun([
                { role: 'system', content: '你是文献对比助手。基于已有综述与文献信息回答追问，简洁专业，不编造。' },
                { role: 'user', content: '已有综述：\n' + prev + '\n\n文献：' + selected.map(function (l) { return l.title; }).join('；') + '\n\n追问：' + q }
            ], 1200);
            var merged = prev + '\n\n---\n【追问】' + q + '\n' + content;
            setAiCache(selectedIdsKey(), merged);
            if (body) body.innerHTML = '<div class="lit-ai-result" id="litAiResultText">' + _esc(merged) + '</div>';
            if (input) input.value = '';
        } catch (e) {
            if (body) body.innerHTML = '<div class="lit-ai-result" id="litAiResultText">' + _esc(prev) + '</div><div class="lit-ai-error">追问失败：' + _esc(e.message || e) + '</div>';
        }
    }
    global.litAiFollowUp = litAiFollowUp;

    function getLitAiText() {
        var el = document.getElementById('litAiResultText');
        return el ? el.textContent : '';
    }

    function copyLitAiResult() {
        var text = getLitAiText();
        if (!text) { alert('暂无 AI 结果可复制'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { alert('已复制到剪贴板'); });
        } else {
            alert('当前浏览器不支持剪贴板 API');
        }
    }
    global.copyLitAiResult = copyLitAiResult;
    global.copyAiCompareResult = copyLitAiResult;

    function clearLitAiCache() {
        var map = getAiCacheMap();
        delete map[selectedIdsKey()];
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(map)); } catch (e) {}
        renderLitAiView(false);
    }
    global.clearLitAiCache = clearLitAiCache;

    function insertLitAiToWeeklyReport() {
        var text = getLitAiText();
        if (!text) { alert('请先生成 AI 综述'); return; }
        if (typeof global.weeklyReportData === 'undefined') {
            alert('周报模块未就绪');
            return;
        }
        var block = '\n\n【文献调研-' + new Date().toLocaleDateString('zh-CN') + '】\n' + text.slice(0, 2500);
        var myName = _owner();
        var weekRange = '';
        try {
            if (typeof global.getCurrentWeekRange === 'function') weekRange = global.getCurrentWeekRange();
        } catch (e) {}
        if (!weekRange) {
            var now = new Date();
            var day = now.getDay() || 7;
            var start = new Date(now); start.setDate(now.getDate() - day + 1);
            var end = new Date(start); end.setDate(start.getDate() + 6);
            weekRange = start.toISOString().slice(0, 10) + ' ~ ' + end.toISOString().slice(0, 10);
        }
        var report = (global.weeklyReportData || []).find(function (r) {
            return r.owner === myName && (r.weekRange === weekRange || !weekRange);
        });
        if (report) {
            report.content = (report.content || '') + block;
            report.status = 'pending';
            try {
                if (typeof global.saveWeeklyReportData === 'function') global.saveWeeklyReportData();
                else localStorage.setItem('weeklyReportData', JSON.stringify(global.weeklyReportData));
            } catch (e2) {}
            alert('已追加到本周周报「本周进展」。可到「团队工作周报」查看编辑。');
            if (typeof global.showModule === 'function') global.showModule('weekly_report');
        } else {
            var newId = (global.weeklyReportData || []).length
                ? Math.max.apply(null, global.weeklyReportData.map(function (r) { return Number(r.id) || 0; })) + 1
                : 1;
            global.weeklyReportData.push({
                id: newId,
                weekRange: weekRange,
                owner: myName,
                content: '文献对比分析调研：' + block,
                nextWeek: '',
                problems: '',
                notes: '由文献对比模块自动插入',
                status: 'pending',
                submitTime: new Date().toLocaleString('zh-CN'),
                reviewComment: '',
                visibility: 'all'
            });
            try {
                if (typeof global.saveWeeklyReportData === 'function') global.saveWeeklyReportData();
                else {
                    localStorage.setItem('weeklyReportData', JSON.stringify(global.weeklyReportData));
                    if (typeof global.cloudUpsert === 'function') global.cloudUpsert('weeklyReportData', JSON.stringify(global.weeklyReportData));
                }
            } catch (e3) {}
            alert('已创建本周周报草稿并写入文献调研内容。');
            if (typeof global.showModule === 'function') global.showModule('weekly_report');
        }
        if (typeof global.recordOperationLog === 'function') {
            global.recordOperationLog('文献对比', '插入周报', 'AI 综述插入周报', {}, { success: true }, 1, '', 0);
        }
    }
    global.insertLitAiToWeeklyReport = insertLitAiToWeeklyReport;

    async function saveLitAiToSharedFiles() {
        var text = getLitAiText();
        if (!text) { alert('请先生成 AI 综述'); return; }
        if (typeof global.sharedFileData === 'undefined') {
            alert('共享文件库未就绪');
            return;
        }
        var fileName = '文献对比综述_' + new Date().toISOString().slice(0, 10) + '.md';
        var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        var file = new File([blob], fileName, { type: 'text/markdown' });
        var newId = global.sharedFileData.length
            ? Math.max.apply(null, global.sharedFileData.map(function (f) { return Number(f.id) || 0; })) + 1
            : 1;
        try {
            if (typeof global.saveSharedFileBlob === 'function') {
                await global.saveSharedFileBlob(newId, file);
            }
        } catch (e) {
            console.warn(e);
        }
        global.sharedFileData.push({
            id: newId,
            name: fileName,
            size: (typeof global.formatFileSize === 'function' ? global.formatFileSize(file.size) : (file.size + ' B')),
            fileSizeBytes: file.size,
            type: 'md',
            mimeType: 'text/markdown',
            hasBlob: true,
            category: '文献调研成果',
            remark: '文献对比分析自动导出',
            uploader: _owner(),
            uploaderId: (global.currentUser && global.currentUser.id) || 0,
            uploadTime: new Date().toLocaleDateString('zh-CN'),
            downloadCount: 0,
            tags: ['文献对比', '调研']
        });
        localStorage.setItem('sharedFileData', JSON.stringify(global.sharedFileData));
        try {
            if (typeof global.cloudUpsert === 'function') global.cloudUpsert('sharedFileData', JSON.stringify(global.sharedFileData));
        } catch (e2) {}
        if (typeof global.recordOperationLog === 'function') {
            global.recordOperationLog('文献对比', '导出共享', '保存综述到共享文件库：' + fileName, { fileName: fileName }, { success: true }, 1, '', 0);
        }
        alert('已保存到共享文件库：' + fileName);
        if (typeof global.showModule === 'function') global.showModule('shared_files');
    }
    global.saveLitAiToSharedFiles = saveLitAiToSharedFiles;

    function exportLitCompareCsv() {
        var selected = getSelectedItems();
        if (!selected.length) { alert('请先选择文献'); return; }
        loadDimTemplate();
        var dims = DEFAULT_DIMS.filter(function (d) { return litDimTemplate.indexOf(d.key) >= 0; });
        var header = ['维度'].concat(selected.map(function (it, i) { return '文献' + (i + 1) + ':' + it.title.replace(/"/g, '""'); }));
        var lines = [header.map(function (h) { return '"' + h + '"'; }).join(',')];
        dims.forEach(function (dim) {
            var row = [dim.label].concat(selected.map(function (it) { return dimValue(it, dim); }));
            lines.push(row.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','));
        });
        var blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'literature_compare_' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
    }
    global.exportLitCompareCsv = exportLitCompareCsv;

    function exportLiteratureCsv() {
        var data = global.compareLiteratureData || [];
        if (!data.length) { alert('暂无文献可导出'); return; }
        var lines = ['title,authors,year,venue,field,keywords,doi,map,fps,paramsM,backbone,dataset,openSource,summary'];
        data.forEach(function (item) {
            var row = [
                item.title, item.authors, item.year || '', item.venue, item.field,
                (item.keywords || []).join(';'), item.doi || '',
                item.ext && item.ext.map != null ? item.ext.map : '',
                item.ext && item.ext.fps != null ? item.ext.fps : '',
                item.ext && item.ext.paramsM != null ? item.ext.paramsM : '',
                (item.ext && item.ext.backbone) || '',
                (item.ext && item.ext.dataset) || '',
                item.ext && item.ext.openSource ? '是' : '否',
                (item.summary || '').replace(/\n/g, ' ')
            ];
            lines.push(row.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','));
        });
        var blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'literature_library_' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
    }
    global.exportLiteratureCsv = exportLiteratureCsv;

    function parseCsvLine(line) {
        var out = []; var cur = ''; var inQ = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line[i];
            if (inQ) {
                if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (ch === '"') inQ = false;
                else cur += ch;
            } else {
                if (ch === '"') inQ = true;
                else if (ch === ',') { out.push(cur); cur = ''; }
                else cur += ch;
            }
        }
        out.push(cur);
        return out;
    }

    function importLiteratureCsv(event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            var text = String(reader.result || '').replace(/^\uFEFF/, '');
            var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
            if (lines.length < 2) { alert('CSV 内容为空'); event.target.value = ''; return; }
            var headers = parseCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
            var added = 0, skipped = 0;
            for (var i = 1; i < lines.length; i++) {
                var vals = parseCsvLine(lines[i]);
                var obj = {};
                headers.forEach(function (h, idx) { obj[h] = vals[idx] || ''; });
                var item = normalizeLitItem({
                    title: obj.title || obj['文献标题'] || obj['标题'],
                    authors: obj.authors || obj.author || obj['作者'],
                    year: obj.year || obj['年份'],
                    venue: obj.venue || obj.journal || obj['期刊'] || obj['会议'],
                    field: obj.field || obj['研究领域'] || obj['领域'],
                    keywords: obj.keywords || obj['关键词'],
                    summary: obj.summary || obj.abstract || obj['摘要'],
                    doi: obj.doi || '',
                    ext: {
                        map: obj.map || obj.map50 || obj['map'],
                        fps: obj.fps,
                        paramsM: obj.paramsm || obj.params || obj['参数量'],
                        backbone: obj.backbone || obj['骨干网络'],
                        dataset: obj.dataset || obj['数据集'],
                        openSource: obj.opensource || obj['开源'],
                        innovation: obj.innovation || obj['创新']
                    },
                    owner: _owner()
                });
                if (!item.title) continue;
                if (findDuplicate(item)) { skipped++; continue; }
                item.id = (global.compareLiteratureData.length ? Math.max.apply(null, global.compareLiteratureData.map(function (l) { return Number(l.id) || 0; })) : 0) + 1;
                global.compareLiteratureData.push(item);
                added++;
            }
            saveCompareLiteratureData();
            renderLiteratureCompareList();
            alert('导入完成：新增 ' + added + ' 篇，去重跳过 ' + skipped + ' 篇');
            event.target.value = '';
        };
        reader.readAsText(file, 'utf-8');
    }
    global.importLiteratureCsv = importLiteratureCsv;

    function parseBibTeX(text) {
        var entries = [];
        var re = /@(\w+)\s*\{\s*([^,]+)\s*,([\s\S]*?)\n\s*\}/g;
        var m;
        while ((m = re.exec(text)) !== null) {
            var fields = {};
            var body = m[3];
            var fre = /(\w+)\s*=\s*[\{\"]([\s\S]*?)[\}\"]\s*,?/g;
            var fm;
            while ((fm = fre.exec(body)) !== null) {
                fields[fm[1].toLowerCase()] = fm[2].replace(/\s+/g, ' ').trim();
            }
            entries.push(fields);
        }
        return entries;
    }

    function importLiteratureBibtex(event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            var entries = parseBibTeX(String(reader.result || ''));
            var added = 0, skipped = 0;
            entries.forEach(function (f) {
                var item = normalizeLitItem({
                    title: f.title,
                    authors: (f.author || '').replace(/\s+and\s+/gi, ', '),
                    year: f.year,
                    venue: f.journal || f.booktitle || f.publisher || '',
                    field: f.keywords ? String(f.keywords).split(/[,;]/)[0] : 'BibTeX导入',
                    keywords: f.keywords || '',
                    summary: f.abstract || '',
                    doi: f.doi || '',
                    paperUrl: f.url || '',
                    owner: _owner()
                });
                if (!item.title) return;
                if (findDuplicate(item)) { skipped++; return; }
                item.id = (global.compareLiteratureData.length ? Math.max.apply(null, global.compareLiteratureData.map(function (l) { return Number(l.id) || 0; })) : 0) + 1;
                global.compareLiteratureData.push(item);
                added++;
            });
            saveCompareLiteratureData();
            renderLiteratureCompareList();
            alert('BibTeX 导入完成：新增 ' + added + ' 篇，去重跳过 ' + skipped + ' 篇');
            event.target.value = '';
        };
        reader.readAsText(file, 'utf-8');
    }
    global.importLiteratureBibtex = importLiteratureBibtex;

    function batchDeleteSelectedLiterature() {
        var ids = (global.selectedLiteratures || []).slice();
        if (!ids.length) { alert('请先勾选要删除的文献'); return; }
        var managed = ids.filter(function (id) {
            var it = (global.compareLiteratureData || []).find(function (l) { return l.id === id; });
            return canManageLit(it);
        });
        if (!managed.length) { alert('没有可删除的文献（权限不足）'); return; }
        if (!confirm('确定删除选中的 ' + managed.length + ' 篇文献吗？')) return;
        global.compareLiteratureData = global.compareLiteratureData.filter(function (l) { return managed.indexOf(l.id) < 0; });
        global.selectedLiteratures = (global.selectedLiteratures || []).filter(function (id) { return managed.indexOf(id) < 0; });
        saveCompareLiteratureData();
        saveLitUIState();
        renderLiteratureCompareList();
        refreshLitCompareViews();
    }
    global.batchDeleteSelectedLiterature = batchDeleteSelectedLiterature;

    function showAddLiteratureModal() {
        editingLiteratureId = null;
        showCompareLiteratureModal();
    }
    global.showAddLiteratureModal = showAddLiteratureModal;

    function showEditLiteratureModal(id) {
        editingLiteratureId = id;
        showCompareLiteratureModal();
    }
    global.showEditLiteratureModal = showEditLiteratureModal;

    function showCompareLiteratureModal() {
        var item = editingLiteratureId ? (global.compareLiteratureData || []).find(function (l) { return l.id === editingLiteratureId; }) : null;
        if (item && !canManageLit(item) && editingLiteratureId) {
            alert('无权限编辑该文献');
            return;
        }
        var modalId = 'litCompareModal_' + Date.now();
        var modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'lit-modal-overlay';
        var ext = (item && item.ext) || {};
        modal.innerHTML =
            '<div class="lit-modal">' +
            '<div class="lit-modal-head"><h3>' + (item ? '编辑文献' : '添加文献') + '</h3>' +
            '<button class="btn btn-secondary" style="padding:4px 10px;" onclick="document.getElementById(\'' + modalId + '\').remove()">×</button></div>' +
            '<div class="lit-modal-body">' +
            '<div class="lit-form-grid">' +
            '<div class="full"><label>标题 *</label><input id="litTitle" class="form-control" value="' + _esc(item ? item.title : '') + '"></div>' +
            '<div><label>作者</label><input id="litAuthor" class="form-control" value="' + _esc(item ? item.authors : '') + '"></div>' +
            '<div><label>年份</label><input id="litYear" class="form-control" value="' + _esc(item && item.year != null ? item.year : '') + '"></div>' +
            '<div><label>会议/期刊</label><input id="litJournal" class="form-control" value="' + _esc(item ? item.venue : '') + '"></div>' +
            '<div><label>领域</label><input id="litField" class="form-control" value="' + _esc(item ? item.field : '') + '"></div>' +
            '<div><label>DOI</label><input id="litDoi" class="form-control" value="' + _esc(item ? item.doi : '') + '" placeholder="可选，用于去重"></div>' +
            '<div><label>关键词（逗号分隔）</label><input id="litKeywords" class="form-control" value="' + _esc(item ? (item.keywords || []).join(', ') : '') + '"></div>' +
            '<div><label>分组</label><input id="litGroup" class="form-control" value="' + _esc(item ? item.group : '') + '" placeholder="如：目标检测"></div>' +
            '<div><label>mAP</label><input id="litMap" class="form-control" value="' + _esc(ext.map != null ? ext.map : '') + '"></div>' +
            '<div><label>FPS</label><input id="litFps" class="form-control" value="' + _esc(ext.fps != null ? ext.fps : '') + '"></div>' +
            '<div><label>参数量(M)</label><input id="litParams" class="form-control" value="' + _esc(ext.paramsM != null ? ext.paramsM : '') + '"></div>' +
            '<div><label>骨干网络</label><input id="litBackbone" class="form-control" value="' + _esc(ext.backbone || '') + '"></div>' +
            '<div><label>数据集</label><input id="litDataset" class="form-control" value="' + _esc(ext.dataset || '') + '"></div>' +
            '<div><label>开源</label><select id="litOpenSource" class="form-control"><option value="true"' + (ext.openSource ? ' selected' : '') + '>是</option><option value="false"' + (!ext.openSource ? ' selected' : '') + '>否</option></select></div>' +
            '<div class="full"><label>核心创新</label><input id="litInnovation" class="form-control" value="' + _esc(ext.innovation || '') + '"></div>' +
            '<div class="full"><label>适用场景</label><input id="litScenario" class="form-control" value="' + _esc(ext.scenario || '') + '"></div>' +
            '<div class="full"><label>摘要</label><textarea id="litSummary" class="form-control" rows="4">' + _esc(item ? item.summary : '') + '</textarea></div>' +
            '</div></div>' +
            '<div class="lit-modal-foot">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'' + modalId + '\').remove()">取消</button>' +
            '<button class="btn" onclick="saveLiterature(\'' + modalId + '\')">保存</button></div></div>';
        document.body.appendChild(modal);
    }

    function saveLiterature(modalId) {
        var title = (document.getElementById('litTitle') || {}).value.trim();
        if (!title) { alert('请填写标题'); return; }
        var payload = normalizeLitItem({
            id: editingLiteratureId || undefined,
            title: title,
            authors: (document.getElementById('litAuthor') || {}).value,
            year: (document.getElementById('litYear') || {}).value,
            venue: (document.getElementById('litJournal') || {}).value,
            field: (document.getElementById('litField') || {}).value,
            doi: (document.getElementById('litDoi') || {}).value,
            keywords: (document.getElementById('litKeywords') || {}).value,
            group: (document.getElementById('litGroup') || {}).value,
            summary: (document.getElementById('litSummary') || {}).value,
            owner: _owner(),
            ext: {
                map: (document.getElementById('litMap') || {}).value,
                fps: (document.getElementById('litFps') || {}).value,
                paramsM: (document.getElementById('litParams') || {}).value,
                backbone: (document.getElementById('litBackbone') || {}).value,
                dataset: (document.getElementById('litDataset') || {}).value,
                openSource: (document.getElementById('litOpenSource') || {}).value,
                innovation: (document.getElementById('litInnovation') || {}).value,
                scenario: (document.getElementById('litScenario') || {}).value
            }
        });
        var dup = findDuplicate(payload);
        if (dup && (!editingLiteratureId || dup.id !== editingLiteratureId)) {
            if (!confirm('检测到可能重复的文献《' + dup.title + '》，仍要保存吗？')) return;
        }
        if (editingLiteratureId) {
            var idx = global.compareLiteratureData.findIndex(function (l) { return l.id === editingLiteratureId; });
            if (idx < 0) return;
            payload.id = editingLiteratureId;
            payload.owner = global.compareLiteratureData[idx].owner || payload.owner;
            global.compareLiteratureData[idx] = payload;
        } else {
            payload.id = (global.compareLiteratureData.length ? Math.max.apply(null, global.compareLiteratureData.map(function (l) { return Number(l.id) || 0; })) : 0) + 1;
            global.compareLiteratureData.unshift(payload);
        }
        saveCompareLiteratureData();
        var modal = document.getElementById(modalId);
        if (modal) modal.remove();
        renderLiteratureCompareList();
        refreshLitCompareViews();
        // 联动写入文献资料库（若不存在）
        try {
            if (typeof global.upsertLiteratureFromExternal === 'function') {
                global.upsertLiteratureFromExternal({
                    title: payload.title,
                    author: payload.authors,
                    journal: payload.venue,
                    year: payload.year || '',
                    tags: (payload.keywords || []).join(', '),
                    doi: payload.doi || '',
                    summary: payload.summary || '',
                    paperUrl: payload.paperUrl || '',
                    uploader: _owner(),
                    source: 'literature_compare'
                }, { skipIfExists: true, syncCompare: false });
            } else if (typeof global.literatureData !== 'undefined' && Array.isArray(global.literatureData)) {
                var exists = global.literatureData.some(function (l) {
                    return String(l.title || '').trim().toLowerCase() === payload.title.toLowerCase();
                });
                if (!exists) {
                    var lid = global.literatureData.length ? Math.max.apply(null, global.literatureData.map(function (l) { return Number(l.id) || 0; })) + 1 : 1;
                    global.literatureData.push({
                        id: lid,
                        title: payload.title,
                        author: payload.authors,
                        journal: payload.venue,
                        year: payload.year || '',
                        tags: (payload.keywords || []).join(', '),
                        doi: payload.doi || '',
                        summary: payload.summary || '',
                        uploader: _owner(),
                        uploadTime: new Date().toLocaleDateString('zh-CN')
                    });
                    localStorage.setItem('literatureData', JSON.stringify(global.literatureData));
                    if (typeof global.cloudUpsert === 'function') global.cloudUpsert('literatureData', JSON.stringify(global.literatureData));
                }
            }
        } catch (e) {}
    }
    global.saveLiterature = saveLiterature;

    function deleteLiterature(id) {
        var item = (global.compareLiteratureData || []).find(function (l) { return l.id === id; });
        if (!item) return;
        if (!canManageLit(item)) { alert('无权限删除'); return; }
        if (!confirm('确定删除《' + item.title + '》？')) return;
        global.compareLiteratureData = global.compareLiteratureData.filter(function (l) { return l.id !== id; });
        global.selectedLiteratures = (global.selectedLiteratures || []).filter(function (x) { return x !== id; });
        saveCompareLiteratureData();
        saveLitUIState();
        renderLiteratureCompareList();
        refreshLitCompareViews();
    }
    global.deleteLiterature = deleteLiterature;

    function initLiteratureAnalysis() {
        var saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                global.compareLiteratureData = JSON.parse(saved).map(normalizeLitItem);
            } catch (e) {
                global.compareLiteratureData = buildDefaultCompareLiterature();
            }
        } else {
            global.compareLiteratureData = buildDefaultCompareLiterature();
            saveCompareLiteratureData();
        }
        // 旧数据缺少指标时，按标题从内置种子补全（不覆盖用户已填值）
        var seedByTitle = {};
        buildDefaultCompareLiterature().forEach(function (s) {
            seedByTitle[String(s.title || '').toLowerCase()] = s;
        });
        var enriched = false;
        global.compareLiteratureData = global.compareLiteratureData.map(function (item) {
            var seed = seedByTitle[String(item.title || '').toLowerCase()];
            if (!seed) return normalizeLitItem(item);
            var ext = Object.assign({}, seed.ext || {}, item.ext || {});
            ['map', 'fps', 'paramsM', 'backbone', 'dataset', 'innovation', 'scenario'].forEach(function (k) {
                if ((item.ext == null || item.ext[k] == null || item.ext[k] === '') && seed.ext && seed.ext[k] != null && seed.ext[k] !== '') {
                    ext[k] = seed.ext[k];
                    enriched = true;
                }
            });
            if (item.ext && item.ext.openSource != null) ext.openSource = item.ext.openSource;
            item.ext = ext;
            if (!item.group && seed.group) { item.group = seed.group; enriched = true; }
            return normalizeLitItem(item);
        });
        if (enriched) saveCompareLiteratureData();
        loadLitUIState();
        loadDimTemplate();
        // 过滤掉已删除的选中 id
        var idSet = {};
        global.compareLiteratureData.forEach(function (l) { idSet[l.id] = true; });
        global.selectedLiteratures = (global.selectedLiteratures || []).filter(function (id) { return idSet[id]; });
        renderLiteratureCompareList();
        switchLitTab(litActiveTab || 'table');
        // 键盘快捷键
        var pane = document.getElementById('literature_analysis');
        if (pane && !pane._litKeyBound) {
            pane._litKeyBound = true;
            document.addEventListener('keydown', function (e) {
                var mod = document.getElementById('literature_analysis');
                if (!mod || !mod.classList.contains('active')) return;
                if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
                if (e.key === 'Escape') { clearLitSelection(); }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { aiCompareSelectedLiterature(true); }
            });
        }
    }
    global.initLiteratureAnalysis = initLiteratureAnalysis;
    global.syncFromLiteratureLibrary = syncFromLiteratureLibrary;

    // 确保全局数组存在，供云同步/全局检索引用
    if (!Array.isArray(global.compareLiteratureData)) global.compareLiteratureData = [];
    if (!Array.isArray(global.selectedLiteratures)) global.selectedLiteratures = [];

})(window);
