        // ========== 软著管理功能 ==========
        let copyrightData = [];
        let filteredData = [];
        let currentSortField = '';
        let currentSortOrder = 'asc';
        let editingCopyrightId = null;
        let selectedCopyrights = new Set();
        // 列头筛选薄封装（通用工具 acShowColFilter/acColRows 定义于 achievements-modules.js）
        function openCopyrightColFilter(ev, field, label) {
            if (typeof acShowColFilter === 'function') acShowColFilter(ev, 'copyright', field, label, copyrightData, 'renderCopyrightTable');
        }
        
        // 初始化软著数据
        function initCopyrightData() {
            const stored = localStorage.getItem('copyrightData');
            if (stored) {
                copyrightData = JSON.parse(stored);
            } else {
                // 示例数据
                copyrightData = [
                    {
                        id: 1,
                        name: '智能数据分析平台V1.0',
                        regNumber: '2026SR001234',
                        applicant: '张三',
                        unit: '计算机学院',
                        category: '系统软件',
                        regDate: '2026-03-15',
                        status: '已通过',
                        fileName: '',
                        remark: ''
                    },
                    {
                        id: 2,
                        name: '工业控制系统软件V2.0',
                        regNumber: '2026SR002345',
                        applicant: '李四',
                        unit: '自动化学院',
                        category: '工业软件',
                        regDate: '2026-04-10',
                        status: '审核中',
                        fileName: '',
                        remark: ''
                    },
                    {
                        id: 3,
                        name: '嵌入式设备管理平台',
                        regNumber: '2025SR009876',
                        applicant: '王五',
                        unit: '电子工程学院',
                        category: '嵌入式软件',
                        regDate: '2025-12-20',
                        status: '已通过',
                        fileName: '',
                        remark: ''
                    }
                ];
                saveCopyrightData();
            }
            filteredData = [...copyrightData];
            updateFilterCounts();
            renderCopyrightTable();
        }
        
        // 保存数据
        function saveCopyrightData() {
            localStorage.setItem('copyrightData', JSON.stringify(copyrightData));
        }
        
        // 更新筛选标签数量
        function updateFilterCounts() {
            const currentYear = new Date().getFullYear().toString();
            const elAll = document.getElementById('countAll');
            if (!elAll) return; // 软著模块未加载时相关元素不存在，直接跳过
            elAll.textContent = copyrightData.length;
            document.getElementById('countCurrentYear').textContent = copyrightData.filter(d => d.regDate && d.regDate.startsWith(currentYear)).length;
            document.getElementById('countReviewing').textContent = copyrightData.filter(d => d.status === '审核中').length;
            document.getElementById('countApproved').textContent = copyrightData.filter(d => d.status === '已通过').length;
            document.getElementById('countRejected').textContent = copyrightData.filter(d => d.status === '已驳回').length;
        }
        
        // 渲染表格
        function renderCopyrightTable() {
            const tbody = document.getElementById('copyrightTableBody');
            const emptyMsg = document.getElementById('emptyMessage');
            if (!tbody || !emptyMsg) return; // 软著模块未加载时相关元素不存在，直接跳过

            tbody.innerHTML = '';
            const rows = (typeof acColRows === 'function') ? acColRows('copyright', filteredData) : filteredData;
            
            if (rows.length === 0) {
                emptyMsg.style.display = 'block';
                return;
            }
            
            emptyMsg.style.display = 'none';
            
            rows.forEach(item => {
                const row = document.createElement('tr');
                const statusClass = item.status === '已通过' ? 'tag-success' : item.status === '审核中' ? 'tag-warning' : 'tag-danger';
                row.innerHTML = `
                    <td><input type="checkbox" ${selectedCopyrights.has(item.id) ? 'checked' : ''} onchange="toggleSelect(${item.id}, this)"></td>
                    <td>${item.regDate ? escapeHtml(item.regDate.substring(0, 4)) : '-'}</td>
                    <td>${escapeHtml(item.regNumber || '-')}</td>
                    <td>${escapeHtml(item.name)}</td>
                    <td>${escapeHtml(item.category || '-')}</td>
                    <td>${escapeHtml(item.applicant || '-')}</td>
                    <td>${escapeHtml(item.unit || '-')}</td>
                    <td>${escapeHtml(item.regDate || '-')}</td>
                    <td><span class="tag ${statusClass}">${escapeHtml(item.status)}</span></td>
                    <td>
                        <button class="btn" style="padding: 4px 10px; font-size: 12px; margin-right: 5px;" onclick="editCopyright(${item.id})">编辑</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="deleteCopyright(${item.id})">删除</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
        
        // 显示新增弹窗
        function showAddCopyrightModal() {
            editingCopyrightId = null;
            document.getElementById('modalTitle').textContent = '新增软著';
            document.getElementById('copyrightName').value = '';
            document.getElementById('copyrightRegNumber').value = '';
            document.getElementById('copyrightApplicant').value = '';
            document.getElementById('copyrightUnit').value = '';
            document.getElementById('copyrightCategory').value = '';
            document.getElementById('copyrightRegDate').value = '';
            document.getElementById('copyrightStatus').value = '审核中';
            document.getElementById('copyrightFile').value = '';
            document.getElementById('copyrightRemark').value = '';
            document.getElementById('copyrightModal').style.display = 'flex';
        }
        
        // 关闭弹窗
        function closeCopyrightModal() {
            document.getElementById('copyrightModal').style.display = 'none';
        }
        
        // 保存软著
        function saveCopyright() {
            const name = document.getElementById('copyrightName').value.trim();
            const regNumber = document.getElementById('copyrightRegNumber').value.trim();
            const applicant = document.getElementById('copyrightApplicant').value.trim();
            const unit = document.getElementById('copyrightUnit').value.trim();
            const category = document.getElementById('copyrightCategory').value;
            const regDate = document.getElementById('copyrightRegDate').value;
            const status = document.getElementById('copyrightStatus').value;
            const remark = document.getElementById('copyrightRemark').value.trim();
            
            if (!name || !regNumber || !applicant || !unit || !category || !regDate) {
                alert('请填写所有必填字段');
                return;
            }
            
            if (editingCopyrightId) {
                // 编辑模式
                const index = copyrightData.findIndex(d => d.id === editingCopyrightId);
                if (index !== -1) {
                    copyrightData[index] = {
                        ...copyrightData[index],
                        name, regNumber, applicant, unit, category, regDate, status, remark
                    };
                }
            } else {
                // 新增模式
                const newId = copyrightData.length > 0 ? Math.max(...copyrightData.map(d => d.id)) + 1 : 1;
                copyrightData.push({
                    id: newId,
                    name, regNumber, applicant, unit, category, regDate, status,
                    fileName: '',
                    remark
                });
            }
            
            saveCopyrightData();
            updateFilterCounts();
            applyFilters();
            closeCopyrightModal();
            alert('保存成功！');
        }
        
        // 编辑软著
        function editCopyright(id) {
            const item = copyrightData.find(d => d.id === id);
            if (!item) return;
            
            editingCopyrightId = id;
            document.getElementById('modalTitle').textContent = '编辑软著';
            document.getElementById('copyrightName').value = item.name;
            document.getElementById('copyrightRegNumber').value = item.regNumber;
            document.getElementById('copyrightApplicant').value = item.applicant;
            document.getElementById('copyrightUnit').value = item.unit;
            document.getElementById('copyrightCategory').value = item.category;
            document.getElementById('copyrightRegDate').value = item.regDate;
            document.getElementById('copyrightStatus').value = item.status;
            document.getElementById('copyrightRemark').value = item.remark || '';
            document.getElementById('copyrightModal').style.display = 'flex';
        }
        
        // 删除软著
        function deleteCopyright(id) {
            if (!confirm('确定要删除这条软著记录吗？')) return;
            copyrightData = copyrightData.filter(d => d.id !== id);
            selectedCopyrights.delete(id);
            saveCopyrightData();
            updateFilterCounts();
            applyFilters();
        }
        
        // 全选/取消全选
        function toggleSelectAll(checkbox) {
            if (checkbox.checked) {
                filteredData.forEach(d => selectedCopyrights.add(d.id));
            } else {
                selectedCopyrights.clear();
            }
            renderCopyrightTable();
        }
        
        // 单个选择
        function toggleSelect(id, checkbox) {
            if (checkbox.checked) {
                selectedCopyrights.add(id);
            } else {
                selectedCopyrights.delete(id);
            }
        }
        
        // 筛选标签
        function filterByTag(tag, element) {
            // 更新标签样式
            document.querySelectorAll('.filter-tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            
            const currentYear = new Date().getFullYear().toString();
            
            switch(tag) {
                case 'all':
                    filteredData = [...copyrightData];
                    break;
                case 'current_year':
                    filteredData = copyrightData.filter(d => d.regDate && d.regDate.startsWith(currentYear));
                    break;
                case 'reviewing':
                    filteredData = copyrightData.filter(d => d.status === '审核中');
                    break;
                case 'approved':
                    filteredData = copyrightData.filter(d => d.status === '已通过');
                    break;
                case 'rejected':
                    filteredData = copyrightData.filter(d => d.status === '已驳回');
                    break;
            }
            
            renderCopyrightTable();
        }
        
        // 更多条件
        function toggleMoreFilters() {
            const moreFilters = document.getElementById('moreFilters');
            moreFilters.style.display = moreFilters.style.display === 'none' ? 'block' : 'none';
        }
        
        // 应用筛选
        function applyFilters() {
            const name = document.getElementById('filterName').value.trim().toLowerCase();
            const regNumber = document.getElementById('filterRegNumber').value.trim().toLowerCase();
            const applicant = document.getElementById('filterApplicant').value.trim().toLowerCase();
            const year = document.getElementById('filterYear').value;
            const status = document.getElementById('filterStatus').value;
            const category = document.getElementById('filterCategory').value;
            const unit = document.getElementById('filterUnit').value.trim().toLowerCase();
            const dateFrom = document.getElementById('filterDateFrom').value;
            const dateTo = document.getElementById('filterDateTo').value;
            
            filteredData = copyrightData.filter(d => {
                if (name && !d.name.toLowerCase().includes(name)) return false;
                if (regNumber && !d.regNumber.toLowerCase().includes(regNumber)) return false;
                if (applicant && !d.applicant.toLowerCase().includes(applicant)) return false;
                if (year && (!d.regDate || !d.regDate.startsWith(year))) return false;
                if (status && d.status !== status) return false;
                if (category && d.category !== category) return false;
                if (unit && (!d.unit || !d.unit.toLowerCase().includes(unit))) return false;
                if (dateFrom && (!d.regDate || d.regDate < dateFrom)) return false;
                if (dateTo && (!d.regDate || d.regDate > dateTo)) return false;
                return true;
            });
            
            renderCopyrightTable();
        }
        
        // 重置筛选
        function resetFilters() {
            document.getElementById('filterName').value = '';
            document.getElementById('filterRegNumber').value = '';
            document.getElementById('filterApplicant').value = '';
            document.getElementById('filterYear').value = '';
            document.getElementById('filterStatus').value = '';
            document.getElementById('filterCategory').value = '';
            document.getElementById('filterUnit').value = '';
            document.getElementById('filterDateFrom').value = '';
            document.getElementById('filterDateTo').value = '';
            document.getElementById('moreFilters').style.display = 'none';
            
            // 重置标签
            document.querySelectorAll('.filter-tag').forEach(t => t.classList.remove('active'));
            document.querySelector('.filter-tag').classList.add('active');
            
            filteredData = [...copyrightData];
            renderCopyrightTable();
        }
        
        // 排序
        function sortTable(field) {
            if (currentSortField === field) {
                currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                currentSortField = field;
                currentSortOrder = 'asc';
            }
            
            filteredData.sort((a, b) => {
                let valA = a[field] || '';
                let valB = b[field] || '';
                
                if (typeof valA === 'string') {
                    valA = valA.toLowerCase();
                    valB = valB.toLowerCase();
                }
                
                if (valA < valB) return currentSortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return currentSortOrder === 'asc' ? 1 : -1;
                return 0;
            });
            
            renderCopyrightTable();
        }
        
        // 批量删除
        function batchDeleteCopyrights() {
            if (selectedCopyrights.size === 0) {
                alert('请先选择要删除的记录');
                return;
            }
            if (!confirm(`确定要删除选中的 ${selectedCopyrights.size} 条记录吗？`)) return;
            
            copyrightData = copyrightData.filter(d => !selectedCopyrights.has(d.id));
            selectedCopyrights.clear();
            saveCopyrightData();
            updateFilterCounts();
            applyFilters();
        }
        
        // 批量审核
        function batchAuditCopyrights() {
            if (selectedCopyrights.size === 0) {
                alert('请先选择要审核的记录');
                return;
            }
            
            const newStatus = prompt('请输入新状态（审核中/已通过/已驳回）：');
            if (!newStatus || !['审核中', '已通过', '已驳回'].includes(newStatus)) {
                alert('请输入有效的状态');
                return;
            }
            
            copyrightData.forEach(d => {
                if (selectedCopyrights.has(d.id)) {
                    d.status = newStatus;
                }
            });
            
            selectedCopyrights.clear();
            saveCopyrightData();
            updateFilterCounts();
            applyFilters();
        }
        
        // 导出
        function exportCopyrights() {
            if (filteredData.length === 0) {
                alert('没有可导出的数据');
                return;
            }
            
            let csv = '\ufeff所属年度,登记号,软著名称,分类,申请人,所属单位,登记日期,状态\n';
            filteredData.forEach(d => {
                csv += `${d.regDate ? d.regDate.substring(0,4) : ''},${d.regNumber},${d.name},${d.category},${d.applicant},${d.unit},${d.regDate},${d.status}\n`;
            });
            
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '软著数据_' + new Date().toISOString().slice(0,10) + '.csv';
            link.click();
        }
        
        // 导入
        function importCopyrights() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.csv';
            input.onchange = function(e) {
                const file = e.target.files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 8) {
                            const newId = copyrightData.length > 0 ? Math.max(...copyrightData.map(d => d.id)) + 1 : 1;
                            copyrightData.push({
                                id: newId,
                                year: cols[0] || '',
                                regNumber: cols[1] || '',
                                name: cols[2] || '',
                                category: cols[3] || '',
                                applicant: cols[4] || '',
                                unit: cols[5] || '',
                                regDate: cols[6] || '',
                                status: cols[7] || '审核中',
                                fileName: '',
                                remark: ''
                            });
                            count++;
                        }
                    }
                    
                    saveCopyrightData();
                    updateFilterCounts();
                    applyFilters();
                    alert(`成功导入 ${count} 条记录`);
                };
                reader.readAsText(file, 'UTF-8');
            };
            input.click();
        }
        
        // 统计
        function viewCopyrightStats() {
            const total = copyrightData.length;
            const currentYear = new Date().getFullYear().toString();
            const thisYear = copyrightData.filter(d => d.regDate && d.regDate.startsWith(currentYear)).length;
            const approved = copyrightData.filter(d => d.status === '已通过').length;
            const reviewing = copyrightData.filter(d => d.status === '审核中').length;
            const rejected = copyrightData.filter(d => d.status === '已驳回').length;
            
            alert(`软著数据统计：\n总数：${total}\n当年登记：${thisYear}\n已通过：${approved}\n审核中：${reviewing}\n已驳回：${rejected}`);
        }
        
        // 在页面加载时初始化各模块数据
        const prevWindowOnload = window.onload;
        window.onload = function() {
            if (prevWindowOnload) prevWindowOnload();
            // 必须先恢复登录会话，再跑团队/云端联动，否则会重写账号 ID 导致刷新掉线
            try {
                if (typeof initAccountSystem === 'function') initAccountSystem();
            } catch (eAccInit) {
                console.warn('initAccountSystem failed', eAccInit);
            }
            initCopyrightData();
            initTeamMemberData();
            initLongitudinalData();
            initHorizontalData();
            initSchoolData();
            initPatentMgmtData();
            initPaperData();
            initStandardData();
            try { if (typeof initCompetitionManagement === 'function') initCompetitionManagement(); } catch (eCmp0) {}
        };
    