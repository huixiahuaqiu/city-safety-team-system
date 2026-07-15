// 项目/成员/成果台账模块（从 app-core 机械外置）
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

        var DEFAULT_MEMBER_GRADE_YEARS = ['2026', '2025', '2024', '2023', '2022'];
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
            // 新年级在上，老年级（如 2016）在下
            years = Array.from(new Set(years)).sort(function (a, b) { return Number(b) - Number(a); });
            return years.length ? years : DEFAULT_MEMBER_GRADE_YEARS.slice().sort(function (a, b) { return Number(b) - Number(a); });
        }

        function saveMemberGradeYears(years) {
            const cleaned = Array.from(new Set((years || []).map(String).filter(isMemberYearCategory)))
                .sort(function (a, b) { return Number(b) - Number(a); });
            const finalYears = cleaned.length ? cleaned : DEFAULT_MEMBER_GRADE_YEARS.slice().sort(function (a, b) { return Number(b) - Number(a); });
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

        function syncTeamMembersAcrossSystem(options) {
            options = options || {};
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

            let protectId = null;
            let protectStudentId = '';
            try {
                if (typeof currentUser !== 'undefined' && currentUser) {
                    protectId = currentUser.id;
                    protectStudentId = currentUser.studentId || '';
                }
            } catch (e1) {}
            try {
                var sess = JSON.parse(localStorage.getItem('currentSession') || 'null');
                if (sess) {
                    if (protectId == null) protectId = sess.userId;
                    if (!protectStudentId) protectStudentId = sess.studentId || '';
                }
            } catch (eSess) {}

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
            accountData.forEach(function(a) {
                if (!a || a.role === 'visitor') return;
                if (linkedAccountIds.has(a.id)) return;
                // 保护当前登录会话账号，避免刷新被踢
                if (protectId != null && Number(a.id) === Number(protectId)) {
                    if (!a.teamOrphan) { a.teamOrphan = true; changed = true; }
                    return;
                }
                if (protectStudentId && String(a.studentId || '') === String(protectStudentId)) {
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

            try { window.accountData = accountData; } catch (eWinAcc) {}
            try { if (typeof rematchSessionAfterAccountSync === 'function') rematchSessionAfterAccountSync(); } catch (eRematch2) {}

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
            card.style.cssText = 'background:#fff;border-radius:12px;padding:18px 14px 16px;width:148px;text-align:center;cursor:pointer;transition:all 0.25s cubic-bezier(0.22,1,0.36,1);box-shadow:0 1px 3px rgba(0,0,0,0.06),0 0 0 1px rgba(0,0,0,0.04);position:relative;overflow:hidden;';
            card.onmouseenter = function() { this.style.transform = 'translateY(-4px)'; this.style.boxShadow = '0 8px 24px rgba(102,126,234,0.15),0 0 0 1px rgba(102,126,234,0.12)'; };
            card.onmouseleave = function() { this.style.transform = ''; this.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06),0 0 0 1px rgba(0,0,0,0.04)'; };
            if (typeof canEditTeamMembers === 'function' && canEditTeamMembers()) {
                const actionsDiv = document.createElement('div');
                actionsDiv.style.cssText = 'position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:10;opacity:0;transition:opacity 0.2s;';
                card.onmouseenter = function() {
                    this.style.transform = 'translateY(-4px)';
                    this.style.boxShadow = '0 8px 24px rgba(102,126,234,0.15),0 0 0 1px rgba(102,126,234,0.12)';
                    actionsDiv.style.opacity = '1';
                };
                card.onmouseleave = function() {
                    this.style.transform = '';
                    this.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06),0 0 0 1px rgba(0,0,0,0.04)';
                    actionsDiv.style.opacity = '0';
                };
                const editBtn = document.createElement('span');
                editBtn.style.cssText = 'width:24px;height:24px;border-radius:50%;background:#667eea;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.15s;';
                editBtn.innerHTML = '✎';
                editBtn.title = '编辑';
                editBtn.onmouseenter = function() { this.style.transform = 'scale(1.15)'; };
                editBtn.onmouseleave = function() { this.style.transform = ''; };
                editBtn.onclick = function(e) { e.stopPropagation(); editMember(m.id); };
                const delBtn = document.createElement('span');
                delBtn.style.cssText = 'width:24px;height:24px;border-radius:50%;background:#ef4444;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.15s;';
                delBtn.innerHTML = '×';
                delBtn.title = '删除';
                delBtn.onmouseenter = function() { this.style.transform = 'scale(1.15)'; };
                delBtn.onmouseleave = function() { this.style.transform = ''; };
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
                avatar.style.cssText = 'width:64px;height:64px;border-radius:50%;object-fit:cover;margin:0 auto 10px;box-shadow:0 3px 10px rgba(0,0,0,0.08);';
            } else {
                avatar = document.createElement('div');
                avatar.style.cssText = 'width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:0 auto 10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;box-shadow:0 3px 10px rgba(102,126,234,0.25);';
                avatar.textContent = m.name.charAt(0);
            }
            const nameEl = document.createElement('div');
            nameEl.style.cssText = 'font-size:14px;font-weight:700;color:#1f2937;margin-bottom:4px;line-height:1.3;';
            nameEl.textContent = m.name;
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-size:12px;color:#9ca3af;line-height:1.4;';
            titleEl.textContent = m.title || '';
            card.appendChild(avatar);
            card.appendChild(nameEl);
            card.appendChild(titleEl);
            if (isMemberGraduated(m)) {
                const badge = document.createElement('div');
                badge.style.cssText = 'margin-top:10px;display:inline-block;padding:3px 10px;border-radius:12px;background:#fef2f2;color:#dc2626;font-size:11px;font-weight:600;border:1px solid #fecaca;';
                badge.textContent = '已毕业';
                card.appendChild(badge);
            } else if (m.category !== 'advisor') {
                const badge = document.createElement('div');
                badge.style.cssText = 'margin-top:10px;display:inline-block;padding:3px 10px;border-radius:12px;background:#ecfdf5;color:#059669;font-size:11px;font-weight:600;border:1px solid #a7f3d0;';
                badge.textContent = '在读';
                card.appendChild(badge);
            }
            return card;
        }

        function createAddMemberCard(category) {
            const card = document.createElement('div');
            card.style.cssText = 'background:#fff;border-radius:12px;padding:16px;width:148px;text-align:center;cursor:pointer;transition:all 0.25s cubic-bezier(0.22,1,0.36,1);border:2px dashed #d1d5db;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:160px;color:#9ca3af;';
            card.onmouseenter = function() { this.style.borderColor = '#667eea'; this.style.background = '#f5f7ff'; this.style.color = '#667eea'; this.style.transform = 'translateY(-3px)'; };
            card.onmouseleave = function() { this.style.borderColor = '#d1d5db'; this.style.background = '#fff'; this.style.color = '#9ca3af'; this.style.transform = ''; };
            card.onclick = function() { showAddMemberModal(category); };
            card.innerHTML = '<div style="font-size:36px;line-height:1;margin-bottom:8px;transition:transform 0.2s;">＋</div><div style="font-size:13px;font-weight:700;letter-spacing:0.3px;">增加人员</div>';
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
            const canSensitive = canViewMemberSensitiveFields();
            const content = document.getElementById('memberDetailContent');
            const graduatedBadge = m.category === 'advisor' ? '' : (isMemberGraduated(m)
                ? '<span style="display:inline-block;background:#fef2f2;color:#dc2626;padding:3px 10px;border-radius:20px;font-size:12px;margin-left:8px;border:1px solid #fecaca;">已毕业（不接收通知）</span>'
                : '<span style="display:inline-block;background:#ecfdf5;color:#059669;padding:3px 10px;border-radius:20px;font-size:12px;margin-left:8px;border:1px solid #a7f3d0;">在读</span>');
            const avatarClick = canEdit ? `onclick="changeMemberAvatar(${m.id})"` : '';
            const avatarCursor = canEdit ? 'cursor:pointer;' : '';
            const phoneDisplay = canSensitive ? (m.phone || '-') : (maskPhoneNumber(m.phone) || '-');
            const infoCards = [
                { icon: '🎓', label: '职称/身份', value: m.title || '-' },
                { icon: '🔬', label: '研究方向', value: m.research || m.thesis || '-' },
                { icon: '📚', label: '教育背景', value: m.education || '-' },
                { icon: '📱', label: '联系电话', value: phoneDisplay },
                { icon: '📧', label: '电子邮箱', value: m.email || '-' },
                { icon: '📋', label: '主持项目', value: m.projects || '-' },
                { icon: '👨‍🏫', label: '校内导师', value: m.advisor || '-' },
                { icon: '🏢', label: '校外导师', value: m.advisorExternal ? (m.advisorExternal + (m.advisorOrg ? '（' + m.advisorOrg + '）' : '')) : '-' }
            ];
            if (canSensitive && m.idCard) {
                infoCards.push({ icon: '🪪', label: '身份证（保密）', value: maskIdCardNumber(m.idCard) + ' · 仅管理员可见脱敏号' });
            }
            content.innerHTML = `
                <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:-40px -40px 24px;padding:32px 40px 28px;border-radius:16px 16px 0 0;text-align:center;position:relative;">
                    <div id="memberAvatarPreview">
                    ${(pendingMemberAvatar && pendingMemberAvatar.id === m.id && pendingMemberAvatar.dataUrl) ? `<img src="${pendingMemberAvatar.dataUrl}" style="width:88px;height:88px;border-radius:50%;object-fit:cover;margin:0 auto 12px;border:4px solid #52c41a;box-shadow:0 4px 16px rgba(82,196,26,0.3);" />` : (m.avatar ? `<img src="${m.avatar}" style="width:88px;height:88px;border-radius:50%;object-fit:cover;margin:0 auto 12px;${avatarCursor}border:4px solid rgba(255,255,255,0.9);box-shadow:0 4px 16px rgba(0,0,0,0.15);" ${avatarClick} />` : `<div style="width:88px;height:88px;border-radius:50%;background:rgba(255,255,255,0.2);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:36px;font-weight:bold;${avatarCursor}border:4px solid rgba(255,255,255,0.9);box-shadow:0 4px 16px rgba(0,0,0,0.15);backdrop-filter:blur(4px);" ${avatarClick}>${m.name.charAt(0)}</div>`)}
                    </div>
                    ${canEdit ? `<p style="font-size:12px;color:rgba(255,255,255,0.75);margin-top:4px;cursor:pointer;" onclick="changeMemberAvatar(${m.id})">📷 点击更换头像</p>` : ''}
                    <div id="memberAvatarPendingTip" style="display:${(pendingMemberAvatar && pendingMemberAvatar.id === m.id) ? 'block' : 'none'};margin:10px auto 0;padding:8px 12px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;color:#389e0d;font-size:12px;width:fit-content;">✅ 已选择新头像，请点击下方「保存头像」完成保存与同步</div>
                    <h2 style="margin: 12px 0 0; color: #fff; font-size: 22px; font-weight: 700; letter-spacing: 0.5px;">${m.name}</h2>
                    <div style="margin-top:10px;">
                        <span style="display:inline-block;background:rgba(255,255,255,0.2);color:#fff;padding:5px 18px;border-radius:20px;font-size:13px;font-weight:600;backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.25);">${getMemberCategoryLabel(m.category)}</span>${graduatedBadge}
                    </div>
                </div>
                ${m.bio ? `<div style="background:#f8fafc;padding:20px 24px;border-radius:12px;margin-bottom:20px;border-left:4px solid #667eea;line-height:1.8;">
                    <div style="font-size:12px;color:#667eea;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">📝 个人简介</div>
                    <p style="margin:0;color:#374151;font-size:15px;line-height:1.8;">${m.bio}</p>
                </div>` : `<div style="background:#f8fafc;padding:16px 24px;border-radius:12px;margin-bottom:20px;border-left:4px solid #d1d5db;text-align:center;color:#9ca3af;font-size:14px;">暂无个人简介</div>`}
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                    ${infoCards.map(function(card) { return `<div style="background:#f8fafc;padding:14px 16px;border-radius:10px;border:1px solid #f1f5f9;transition:all 0.2s;">
                        <div style="font-size:12px;color:#9ca3af;font-weight:600;margin-bottom:6px;letter-spacing:0.5px;">${card.icon} ${card.label}</div>
                        <div style="color:#1f2937;font-size:14px;font-weight:500;word-break:break-all;">${card.value}</div>
                    </div>`; }).join('')}
                </div>
                ${m.awards ? `<div style="background:linear-gradient(135deg,#fffbeb 0%,#fef3c7 100%);padding:16px 24px;border-radius:10px;margin-top:12px;border:1px solid #fde68a;">
                    <div style="font-size:12px;color:#d97706;font-weight:700;letter-spacing:1px;margin-bottom:6px;">🏆 获奖情况</div>
                    <p style="margin:0;color:#92400e;font-size:14px;line-height:1.7;">${m.awards}</p>
                </div>` : ''}
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px;flex-wrap:wrap;position:sticky;bottom:0;background:#fff;padding-top:16px;border-top:1px solid #f3f4f6;">
                    <button class="btn btn-secondary" onclick="cancelPendingMemberAvatar();closeMemberDetailModal();" style="border-radius:8px;padding:10px 24px;font-weight:600;">关闭</button>
                    ${canEdit ? `<button class="btn" onclick="closeMemberDetailModal();editMember(${m.id});" style="border-radius:8px;padding:10px 24px;font-weight:600;background:linear-gradient(135deg,#667eea,#764ba2);border:none;color:#fff;box-shadow:0 4px 14px rgba(102,126,234,0.35);">${(typeof canEditTeamMembers === 'function' && canEditTeamMembers()) ? '✏️ 编辑资料' : '✏️ 完善我的资料'}</button>
                    <button class="btn" id="saveMemberAvatarBtn" onclick="saveMemberAvatar()" style="border-radius:8px;padding:10px 24px;font-weight:600;${(pendingMemberAvatar && pendingMemberAvatar.id === m.id) ? 'background:#8b5cf6;border:none;color:#fff;box-shadow:0 4px 14px rgba(139,92,246,0.35);' : 'opacity:0.5;'}">🖼️ 保存头像</button>` : ''}
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
            var allowSensitive = canViewMemberSensitiveFields();
            if (!allowSensitive) {
                alert('当前账号无权导出含联系方式的完整档案，将导出脱敏版本。');
            }
            let csv = '\ufeff姓名,分类,是否毕业,职称/身份,研究方向,教育背景,联系电话,电子邮箱,校内导师,校外导师,校外单位,主持项目,获奖情况,个人简介\n';
            teamMemberData.forEach(d => {
                var phoneOut = allowSensitive ? (d.phone || '') : maskPhoneNumber(d.phone);
                csv += `"${d.name}","${getMemberCategoryLabel(d.category)}","${isMemberGraduated(d) ? '已毕业' : (d.category === 'advisor' ? '-' : '在读')}","${d.title || ''}","${d.research || ''}","${d.education || ''}","${phoneOut}","${d.email || ''}","${d.advisor || ''}","${d.advisorExternal || ''}","${d.advisorOrg || ''}","${d.projects || ''}","${d.awards || ''}","${(d.bio || '').replace(/"/g, '""')}"\n`;
            });
            // 身份证永不写入导出文件
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
                if (typeof ensureVendor === 'function') await ensureVendor('mammoth');
                if (!window.mammoth) {
                    throw new Error('Word 解析库未加载，请刷新页面后重试');
                }
                const arrayBuffer = await file.arrayBuffer();
                const result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer });
                return result.value || '';
            }
            if (ext === 'pdf') {
                if (typeof ensureVendor === 'function') await ensureVendor('pdfjs');
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
                resultDiv.innerHTML = `<div style="padding:14px 16px;background:#fffbeb;border-radius:8px;color:#d97706;border:1px solid #fde68a;display:flex;align-items:center;gap:8px;"><span style="font-size:18px;">⚠️</span> 未从文档中提取到成员信息，请检查是否包含姓名等字段</div>`;
                return;
            }
            var FIELD_LABELS = {
                name: '姓名', category: '年级', title: '职称', research: '研究方向/论文', education: '学历',
                phone: '手机', email: '邮箱', projects: '项目', awards: '奖项', bio: '简介',
                thesis: '论文题目', advisor: '校内导师', advisorExternal: '校外导师',
                advisorOrg: '校外单位', advisorPhone: '校外导师手机', idCard: '身份证'
            };
            var mapHtml = '';
            if (pendingImportMeta && pendingImportMeta.columnMap) {
                var parts = Object.keys(pendingImportMeta.columnMap).map(function (k) {
                    var col = pendingImportMeta.columnMap[k];
                    var header = (pendingImportMeta.headers && pendingImportMeta.headers[col]) || ('列' + (col + 1));
                    return '<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;background:#eef2ff;color:#4338ca;border-radius:999px;font-size:11px;">' +
                        (FIELD_LABELS[k] || k) + ' ← ' + header + '</span>';
                });
                mapHtml = '<div style="padding:10px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-bottom:none;font-size:12px;color:#4b5563;line-height:1.7;">' +
                    '<div style="font-weight:600;margin-bottom:4px;color:#374151;">🔎 已自动识别字段</div>' + parts.join('') +
                    '<div style="margin-top:6px;color:#b45309;font-size:11px;">敏感信息已脱敏预览；确认导入后完整手机号仅用于团队内部档案，身份证不展示在公开名片。</div></div>';
            }
            let html = mapHtml + `<div style="padding:12px 16px;background:#ecfdf5;border-radius:8px 8px 0 0;color:#059669;margin-bottom:0;border:1px solid #a7f3d0;border-bottom:none;display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;"><span>✅</span> 成功识别 <strong>${pendingImportMembers.length}</strong> 位成员，请确认后导入（可点击 × 移除误识别项）</div>`;
            html += '<div style="max-height:320px;overflow-y:auto;border:1px solid #d1d5db;border-top:none;border-radius:0 0 8px 8px;background:#fff;">';
            pendingImportMembers.forEach((m, idx) => {
                const catLabels = {};
                const years = typeof getMemberGradeYears === 'function' ? getMemberGradeYears() : ['2022','2023','2024','2025','2026'];
                catLabels.advisor = '导师';
                years.forEach(function(y) { catLabels[y] = y + '级'; });
                const avatarSrc = importImages && importImages[idx] ? importImages[idx] : '';
                const avatarHtml = avatarSrc ? `<img src="${avatarSrc}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;" />` : `<div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;display:flex;justify-content:center;align-items:center;font-size:14px;font-weight:bold;flex-shrink:0;">${(m.name || '未')[0]}</div>`;
                var phoneShow = maskPhoneNumber(m.phone);
                var idShow = m.idCard ? ('身份证 ' + maskIdCardNumber(m.idCard)) : '';
                var advisorShow = [m.advisor ? ('校内导师 ' + m.advisor) : '', m.advisorExternal ? ('校外导师 ' + m.advisorExternal) : ''].filter(Boolean).join(' · ');
                var researchShow = m.research || m.thesis || '';
                html += `<div style="padding:10px 14px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:12px;transition:background 0.15s;" onmouseenter="this.style.background='#f9fafb'" onmouseleave="this.style.background=''">
                    ${avatarHtml}
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <strong style="font-size:14px;color:#1f2937;">${m.name || '未知'}</strong>
                            <span style="font-size:11px;padding:2px 10px;border-radius:12px;background:#ede9fe;color:#7c3aed;font-weight:600;white-space:nowrap;">${(typeof getMemberCategoryLabel === 'function' ? getMemberCategoryLabel(normalizeMemberCategory(m.category, m.title)) : (catLabels[m.category] || m.category || '未分类'))}${m.graduated ? ' · 已毕业' : ''}</span>
                        </div>
                        <div style="font-size:12px;color:#6b7280;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${[m.title, researchShow].filter(Boolean).join(' · ') || '无研究方向/职称'}</div>
                        <div style="font-size:11px;color:#9ca3af;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${[phoneShow, idShow, advisorShow, m.email].filter(Boolean).join(' · ') || '无附加信息'}</div>
                    </div>
                    <span onclick="removePendingImportMember(${idx})" title="移除此成员" style="cursor:pointer;color:#d1d5db;font-size:18px;line-height:1;padding:4px 8px;border-radius:6px;transition:all 0.15s;flex-shrink:0;" onmouseenter="this.style.color='#ef4444';this.style.background='#fef2f2'" onmouseleave="this.style.color='#d1d5db';this.style.background='transparent'">×</span>
                </div>`;
            });
            html += '</div>';
            resultDiv.innerHTML = html;
        }

        function removePendingImportMember(index) {
            if (index >= 0 && index < pendingImportMembers.length) {
                pendingImportMembers.splice(index, 1);
                renderPendingImportMembers([]);
                const btn = document.getElementById('confirmImportBtn');
                if (btn) btn.disabled = pendingImportMembers.length === 0;
            }
        }
        window.removePendingImportMember = removePendingImportMember;

        function showImportMembersModal() {
            var existing = document.getElementById('importMembersModal');
            if (existing) existing.remove();
            {
                const modalDiv = document.createElement('div');
                modalDiv.id = 'importMembersModal';
                modalDiv.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:3000;justify-content:center;align-items:center;';
                modalDiv.innerHTML = `
                    <div style="background:#fff;border-radius:16px;padding:28px;width:620px;max-width:94vw;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.15);">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
                            <h3 style="margin:0;color:#1f2937;font-size:18px;font-weight:700;">📥 导入团队成员</h3>
                            <span onclick="closeImportMembersModal()" style="cursor:pointer;font-size:22px;color:#d1d5db;line-height:1;padding:4px;" onmouseenter="this.style.color='#6b7280'" onmouseleave="this.style.color='#d1d5db'">×</span>
                        </div>
                        <div style="margin-bottom:20px;">
                            <label style="display:block;margin-bottom:10px;font-weight:700;color:#374151;font-size:14px;">选择导入方式</label>
                            <div style="display:flex;gap:8px;margin-bottom:14px;">
                                <button class="btn" onclick="importAdvisorsFromProfileUI()" id="importModeProfile" style="flex:1;min-width:150px;padding:12px 16px;border-radius:10px;font-weight:600;font-size:13px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;color:#fff;box-shadow:0 3px 10px rgba(102,126,234,0.25);transition:all 0.2s;">👤 从个人信息库导入</button>
                                <button class="btn" onclick="setImportMode('csv')" id="importModeCsv" style="flex:1;min-width:100px;padding:12px 16px;border-radius:10px;font-weight:600;font-size:13px;">📊 CSV / Excel</button>
                                <button class="btn btn-secondary" onclick="setImportMode('doc')" id="importModeDoc" style="flex:1;min-width:100px;padding:12px 16px;border-radius:10px;font-weight:600;font-size:13px;">📄 Word/PDF</button>
                            </div>
                            <p style="color:#9ca3af;font-size:12px;margin:0;line-height:1.5;">💡 一键导入：王丽萍、罗文文、罗钧（自动同步到云端）</p>
                        </div>
                        <div id="csvImportSection" style="display:none;margin-bottom:16px;">
                            <div style="background:#f8fafc;padding:14px 16px;border-radius:10px;margin-bottom:12px;border:1px solid #e5e7eb;">
                                <p style="color:#374151;font-size:13px;margin:0 0 6px;line-height:1.6;">支持 <strong style="color:#667eea;">CSV / Excel(.xlsx)</strong>。<strong>自动识别表头</strong>，模板列名不必完全一致。</p>
                                <code style="display:block;font-size:12px;color:#6b7280;background:#f1f5f9;padding:6px 10px;border-radius:6px;word-break:break-all;line-height:1.55;">可识别：姓名/名字、年级/类别、手机号、论文题目/研究方向、校内导师、校外导师及单位、职称、学历、邮箱、项目、奖项、简介 等</code>
                                <p style="color:#b45309;font-size:11px;margin:8px 0 0;line-height:1.5;">🔐 身份证号、手机号等敏感字段将脱敏展示；身份证不进入公开名片，仅授权管理员可查看完整信息。</p>
                            </div>
                            <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;">
                                <button type="button" class="btn btn-secondary" onclick="downloadTeamMemberImportTemplate()" style="font-size:12px;padding:8px 14px;border-radius:8px;font-weight:600;">📥 下载 CSV 模板</button>
                                <span style="font-size:11px;color:#9ca3af;">或直接拖拽文件到下方区域</span>
                            </div>
                            <label for="csvFileInput" style="display:block;padding:24px 16px;border:2px dashed #d1d5db;border-radius:10px;text-align:center;cursor:pointer;transition:all 0.2s;background:#fafbfc;" id="csvDropZone"
                                ondragover="event.preventDefault();this.style.borderColor='#667eea';this.style.background='#f5f7ff';"
                                ondragleave="this.style.borderColor='#d1d5db';this.style.background='#fafbfc';"
                                ondrop="event.preventDefault();this.style.borderColor='#d1d5db';this.style.background='#fafbfc';var dt=event.dataTransfer;if(dt&&dt.files&&dt.files.length){var inp=document.getElementById('csvFileInput');inp.files=dt.files;inp.dispatchEvent(new Event('change'));}">
                                <div style="font-size:28px;margin-bottom:6px;">📂</div>
                                <div style="font-size:13px;color:#6b7280;font-weight:600;">点击选择文件或拖拽到此处</div>
                                <div style="font-size:11px;color:#9ca3af;margin-top:4px;">支持 .csv / .xlsx / .xls</div>
                            </label>
                            <input type="file" id="csvFileInput" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display:none;">
                        </div>
                        <div id="docImportSection" style="display:none;margin-bottom:16px;">
                            <p style="color:#6b7280;font-size:13px;margin-bottom:10px;line-height:1.5;">上传 <strong>Word(.docx)</strong>、<strong>PDF</strong> 或 <strong>TXT</strong> 文档，系统将在浏览器本地自动提取成员信息</p>
                            <label for="docFileInput" style="display:block;padding:24px 16px;border:2px dashed #d1d5db;border-radius:10px;text-align:center;cursor:pointer;transition:all 0.2s;background:#fafbfc;" id="docDropZone"
                                ondragover="event.preventDefault();this.style.borderColor='#667eea';this.style.background='#f5f7ff';"
                                ondragleave="this.style.borderColor='#d1d5db';this.style.background='#fafbfc';"
                                ondrop="event.preventDefault();this.style.borderColor='#d1d5db';this.style.background='#fafbfc';var dt=event.dataTransfer;if(dt&&dt.files&&dt.files.length){var inp=document.getElementById('docFileInput');inp.files=dt.files;inp.dispatchEvent(new Event('change'));}">
                                <div style="font-size:28px;margin-bottom:6px;">📄</div>
                                <div style="font-size:13px;color:#6b7280;font-weight:600;">点击选择文件或拖拽到此处</div>
                                <div style="font-size:11px;color:#9ca3af;margin-top:4px;">支持 .docx / .pdf / .txt</div>
                            </label>
                            <input type="file" id="docFileInput" accept=".docx,.pdf,.txt" style="display:none;">
                        </div>
                        <div id="importMembersResult" style="margin-top:12px;"></div>
                        <div id="importMembersLoading" style="display:none;text-align:center;padding:28px;">
                            <div style="display:inline-block;width:36px;height:36px;border:3px solid #e5e7eb;border-top:3px solid #667eea;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
                            <p style="margin-top:14px;color:#6b7280;font-size:14px;font-weight:500;">正在解析文件并提取成员信息...</p>
                        </div>
                        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px;padding-top:16px;border-top:1px solid #f3f4f6;">
                            <button class="btn btn-secondary" onclick="closeImportMembersModal()" style="border-radius:8px;padding:10px 24px;font-weight:600;">取消</button>
                            <button class="btn" onclick="confirmImportMembers()" id="confirmImportBtn" style="border-radius:8px;padding:10px 28px;font-weight:600;background:linear-gradient(135deg,#667eea,#764ba2);border:none;color:#fff;box-shadow:0 4px 14px rgba(102,126,234,0.3);">✅ 确认导入</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modalDiv);
            }
            document.getElementById('importMembersModal').style.display = 'flex';
            setImportMode('csv');
            document.getElementById('importMembersResult').innerHTML = '';
            var csvEl = document.getElementById('csvFileInput');
            var docEl = document.getElementById('docFileInput');
            if (csvEl) csvEl.value = '';
            if (docEl) docEl.value = '';
            pendingImportMembers = [];
            pendingImportMeta = null;
            bindMemberImportFileHandlers();
        }

        function downloadTeamMemberImportTemplate() {
            var csv = '\ufeff姓名,类别,职称,研究方向,学历,手机,邮箱,项目,奖项,简介\n'
                + '张三,2025,研究生,城市安全监测,硕士,13800000001,zhangsan@example.com,,,\n'
                + '李四,导师,副教授,结构抗震,博士,13800000002,lisi@example.com,,,\n';
            var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = '团队成员导入模板.csv';
            a.click();
            URL.revokeObjectURL(url);
        }
        window.downloadTeamMemberImportTemplate = downloadTeamMemberImportTemplate;

        function closeImportMembersModal() {
            document.getElementById('importMembersModal').style.display = 'none';
        }

        let currentImportMode = 'csv';
        let pendingImportMembers = [];
        let pendingImportMeta = null;
        let __memberImportHandlersBound = false;

        function setImportMode(mode) {
            currentImportMode = mode;
            const csvBtn = document.getElementById('importModeCsv');
            const docBtn = document.getElementById('importModeDoc');
            const csvSection = document.getElementById('csvImportSection');
            const docSection = document.getElementById('docImportSection');

            const activeStyle = 'background:linear-gradient(135deg,#667eea,#764ba2);border:none;color:#fff;box-shadow:0 3px 10px rgba(102,126,234,0.25);';
            const inactiveStyle = '';

            if (mode === 'csv') {
                if (csvBtn) { csvBtn.className = 'btn'; csvBtn.style.cssText = activeStyle; }
                if (docBtn) { docBtn.className = 'btn btn-secondary'; docBtn.style.cssText = inactiveStyle; }
                if (csvSection) csvSection.style.display = 'block';
                if (docSection) docSection.style.display = 'none';
            } else {
                if (csvBtn) { csvBtn.className = 'btn btn-secondary'; csvBtn.style.cssText = inactiveStyle; }
                if (docBtn) { docBtn.className = 'btn'; docBtn.style.cssText = activeStyle; }
                if (csvSection) csvSection.style.display = 'none';
                if (docSection) docSection.style.display = 'block';
            }
            pendingImportMembers = [];
            pendingImportMeta = null;
            var resultDiv = document.getElementById('importMembersResult');
            if (resultDiv) resultDiv.innerHTML = '';
        }

        function maskPhoneNumber(phone) {
            var d = String(phone || '').replace(/\D/g, '');
            if (d.length < 7) return phone ? '***' : '';
            if (d.length >= 11) return d.slice(0, 3) + '****' + d.slice(-4);
            return d.slice(0, 2) + '****' + d.slice(-2);
        }

        function maskIdCardNumber(idCard) {
            var s = String(idCard || '').replace(/\s/g, '');
            if (s.length < 8) return s ? '********' : '';
            return s.slice(0, 4) + '**********' + s.slice(-4);
        }

        function canViewMemberSensitiveFields() {
            try {
                if (typeof canEditTeamMembers === 'function') return !!canEditTeamMembers();
            } catch (e) { /* ignore */ }
            var u = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : (window.currentUser || null);
            return !!(u && (u.role === 'admin' || u.role === 'leader'));
        }

        function normalizeHeaderCell(h) {
            return String(h == null ? '' : h)
                .replace(/^\ufeff/, '')
                .replace(/[\s　]/g, '')
                .replace(/[（(].*?[）)]/g, '')
                .toLowerCase();
        }

        /** 表头别名 → 标准字段（多模板自动识别） */
        var MEMBER_IMPORT_FIELD_ALIASES = {
            name: ['姓名', '名字', '学生姓名', '学员姓名', '成员姓名', '人员姓名', 'name'],
            category: ['年级', '类别', '分类', '入学年级', '届别', '年级类别', 'grade'],
            title: ['职称', '身份', '职务', '职位', '头衔'],
            research: ['研究方向', '研究领域', '方向', '专业方向'],
            thesis: ['论文题目', '论文标题', '课题名称', '毕业论文', '题目'],
            education: ['学历', '教育背景', '教育', '学位'],
            phone: ['手机', '手机号', '手机号码', '电话', '联系电话', '联系方式', '本人手机'],
            email: ['邮箱', '电子邮箱', '邮件', 'email', 'e-mail'],
            projects: ['项目', '主持项目', '参与项目'],
            awards: ['奖项', '获奖', '获奖情况'],
            bio: ['简介', '个人简介', '备注', '说明'],
            idCard: ['身份证', '身份证号', '身份证号码', '证件号码', '证件号'],
            advisor: ['校内导师', '导师', '指导教师', '校内指导老师', '第一导师'],
            advisorExternal: ['校外导师', '企业导师', '校外指导老师'],
            advisorOrg: ['校外导师所在单位', '校外单位', '工作单位', '所在单位', '单位'],
            advisorPhone: ['校外导师手机号码', '校外导师手机', '校外导师电话', '企业导师手机']
        };

        function matchImportHeaderField(headerText) {
            var h = normalizeHeaderCell(headerText);
            if (!h) return null;
            var best = null;
            var bestScore = -1;
            var keys = Object.keys(MEMBER_IMPORT_FIELD_ALIASES);
            for (var i = 0; i < keys.length; i++) {
                var field = keys[i];
                var aliases = MEMBER_IMPORT_FIELD_ALIASES[field];
                for (var j = 0; j < aliases.length; j++) {
                    var a = normalizeHeaderCell(aliases[j]);
                    if (!a) continue;
                    var hit = (h === a) || h.indexOf(a) >= 0 || (a.indexOf(h) >= 0 && h.length >= 2);
                    if (!hit) continue;
                    // 精确匹配优先；否则按别名长度，避免「导师」误吃「校外导师」
                    var score = (h === a) ? (1000 + a.length) : a.length;
                    if (score > bestScore) {
                        bestScore = score;
                        best = field;
                    }
                }
            }
            return best;
        }

        function scoreImportHeaderRow(cells) {
            var score = 0;
            var seen = {};
            (cells || []).forEach(function (c) {
                var f = matchImportHeaderField(c);
                if (f && !seen[f]) {
                    seen[f] = true;
                    score += (f === 'name' ? 5 : 1);
                }
            });
            return score;
        }

        function detectImportHeaderRow(aoa) {
            var bestIdx = 0;
            var bestScore = -1;
            var limit = Math.min((aoa || []).length, 15);
            for (var i = 0; i < limit; i++) {
                var s = scoreImportHeaderRow(aoa[i] || []);
                if (s > bestScore) {
                    bestScore = s;
                    bestIdx = i;
                }
            }
            return bestScore >= 3 ? bestIdx : 0;
        }

        function buildImportColumnMap(headerCells) {
            var map = {};
            (headerCells || []).forEach(function (cell, idx) {
                var field = matchImportHeaderField(cell);
                if (!field) return;
                // 同名字段保留首次匹配（避免重复列覆盖）
                if (map[field] == null) map[field] = idx;
            });
            return map;
        }

        function cellAt(row, idx) {
            if (idx == null || idx < 0) return '';
            var v = row && row[idx];
            return String(v == null ? '' : v).trim();
        }

        function parseTeamMemberRowsFromAoa(aoa) {
            aoa = Array.isArray(aoa) ? aoa : [];
            if (!aoa.length) return { rows: [], columnMap: {}, headerRow: 0, headers: [] };

            var headerRow = detectImportHeaderRow(aoa);
            var headers = (aoa[headerRow] || []).map(function (h) { return String(h == null ? '' : h).trim(); });
            var columnMap = buildImportColumnMap(headers);
            // 无表头兜底：旧模板按固定列序
            if (columnMap.name == null && headers.length && !matchImportHeaderField(headers[0])) {
                columnMap = {
                    name: 0, category: 1, title: 2, research: 3, education: 4,
                    phone: 5, email: 6, projects: 7, awards: 8, bio: 9
                };
                headerRow = -1;
            }

            var rows = [];
            var lastGrade = '';
            var start = headerRow >= 0 ? headerRow + 1 : 0;
            for (var i = start; i < aoa.length; i++) {
                var row = aoa[i] || [];
                if (!row.some(function (c) { return String(c == null ? '' : c).trim(); })) continue;

                var name = cellAt(row, columnMap.name);
                if (!name || /^(姓名|名字|合计|总计|备注)$/.test(name)) continue;

                var gradeRaw = cellAt(row, columnMap.category);
                if (gradeRaw) lastGrade = gradeRaw;
                else gradeRaw = lastGrade; // 合并单元格：年级向下填充

                var research = cellAt(row, columnMap.research);
                var thesis = cellAt(row, columnMap.thesis);
                if (!research && thesis) research = thesis;

                var advisor = cellAt(row, columnMap.advisor);
                var advisorExternal = cellAt(row, columnMap.advisorExternal);
                var advisorOrg = cellAt(row, columnMap.advisorOrg);
                var advisorPhone = cellAt(row, columnMap.advisorPhone);
                var idCard = cellAt(row, columnMap.idCard).replace(/\s/g, '');
                var phone = cellAt(row, columnMap.phone).replace(/[^\d+]/g, '');
                var bioParts = [];
                var bio = cellAt(row, columnMap.bio);
                if (bio) bioParts.push(bio);
                if (thesis && thesis !== research) bioParts.push('论文题目：' + thesis);
                if (advisor) bioParts.push('校内导师：' + advisor);
                if (advisorExternal) bioParts.push('校外导师：' + advisorExternal + (advisorOrg ? '（' + advisorOrg + '）' : ''));

                var title = cellAt(row, columnMap.title);
                if (!title && gradeRaw && !/导师|教授/.test(gradeRaw)) {
                    var y = String(gradeRaw).match(/20\d{2}/);
                    title = y ? (y[0] + '级硕士研究生') : '';
                }

                rows.push({
                    name: name,
                    category: gradeRaw,
                    title: title,
                    research: research,
                    education: cellAt(row, columnMap.education),
                    phone: phone,
                    email: cellAt(row, columnMap.email),
                    projects: cellAt(row, columnMap.projects),
                    awards: cellAt(row, columnMap.awards),
                    bio: bioParts.join('；'),
                    thesis: thesis,
                    advisor: advisor,
                    advisorExternal: advisorExternal,
                    advisorOrg: advisorOrg,
                    advisorPhone: advisorPhone,
                    idCard: idCard,
                    _importMapped: Object.keys(columnMap)
                });
            }
            return { rows: rows, columnMap: columnMap, headerRow: headerRow, headers: headers };
        }

        function parseTeamMemberRowsFromCsvText(text) {
            var lines = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/);
            var aoa = [];
            for (var i = 0; i < lines.length; i++) {
                if (!String(lines[i] || '').trim()) continue;
                aoa.push(parseCSVLine(lines[i]));
            }
            return parseTeamMemberRowsFromAoa(aoa).rows;
        }

        async function parseTeamMemberFile(file) {
            var name = String(file && file.name || '').toLowerCase();
            if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
                if (typeof ensureVendor === 'function') await ensureVendor('xlsx');
                if (typeof XLSX === 'undefined') throw new Error('Excel 组件未加载');
                var buf = await file.arrayBuffer();
                var wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
                var sheet = wb.Sheets[wb.SheetNames[0]];
                var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
                var parsed = parseTeamMemberRowsFromAoa(aoa);
                pendingImportMeta = {
                    fileName: file.name,
                    columnMap: parsed.columnMap,
                    headers: parsed.headers,
                    headerRow: parsed.headerRow
                };
                return parsed.rows;
            }
            var text = await new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function (ev) { resolve(ev.target.result); };
                reader.onerror = function () { reject(new Error('文件读取失败')); };
                reader.readAsText(file, 'UTF-8');
            });
            var lines = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/);
            var aoa = [];
            for (var i = 0; i < lines.length; i++) {
                if (!String(lines[i] || '').trim()) continue;
                aoa.push(parseCSVLine(lines[i]));
            }
            var parsedCsv = parseTeamMemberRowsFromAoa(aoa);
            pendingImportMeta = {
                fileName: file.name,
                columnMap: parsedCsv.columnMap,
                headers: parsedCsv.headers,
                headerRow: parsedCsv.headerRow
            };
            return parsedCsv.rows;
        }

        function bindMemberImportFileHandlers() {
            var csvInput = document.getElementById('csvFileInput');
            var docInput = document.getElementById('docFileInput');
            if (!csvInput || !docInput) return;

            csvInput.onchange = async function(e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                var loading = document.getElementById('importMembersLoading');
                var btn = document.getElementById('confirmImportBtn');
                if (loading) loading.style.display = 'block';
                if (btn) btn.disabled = true;
                pendingImportMembers = [];
                try {
                    pendingImportMembers = await parseTeamMemberFile(file);
                    if (pendingImportMembers.length) {
                        renderPendingImportMembers([]);
                    } else {
                        document.getElementById('importMembersResult').innerHTML =
                            '<div style="padding:12px; background:#fff3e0; border-radius:6px; color:#e65100;">⚠ 未解析到成员行。请确认表中含「姓名/名字」列；系统会自动识别年级、手机、论文、导师等列，无需固定模板。</div>';
                    }
                } catch (err) {
                    document.getElementById('importMembersResult').innerHTML =
                        '<div style="padding:12px; background:#ffebee; border-radius:6px; color:#c62828;">✗ 解析失败：' + (err && err.message ? err.message : err) + '</div>';
                } finally {
                    if (loading) loading.style.display = 'none';
                    if (btn) btn.disabled = false;
                }
            };

            docInput.onchange = async function(e) {
                var file = e.target.files && e.target.files[0];
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
                    document.getElementById('importMembersResult').innerHTML =
                        '<div style="padding:12px; background:#ffebee; border-radius:6px; color:#c62828;">✗ 识别失败：' + error.message + '</div>';
                } finally {
                    document.getElementById('importMembersLoading').style.display = 'none';
                    document.getElementById('confirmImportBtn').disabled = false;
                }
            };
        }

        function importMembers() {
            showImportMembersModal();
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
                const phoneDigits = String(m.phone || '').replace(/\D/g, '');
                const idx = teamMemberData.findIndex(function(d) {
                    const dPhone = String(d.phone || '').replace(/\D/g, '');
                    return d.name === m.name || (m.email && d.email === m.email) || (phoneDigits && dPhone && dPhone === phoneDigits);
                });
                const next = {
                    name: m.name || '',
                    category: normalizeMemberCategory(m.category || '2024', m.title),
                    title: m.title || '',
                    research: m.research || m.thesis || '',
                    education: m.education || '',
                    phone: phoneDigits || (m.phone || ''),
                    email: m.email || '',
                    projects: m.projects || '',
                    awards: m.awards || '',
                    bio: m.bio || '',
                    avatar: m.avatar || '',
                    fileName: m.fileName || '',
                    thesis: m.thesis || '',
                    advisor: m.advisor || '',
                    advisorExternal: m.advisorExternal || '',
                    advisorOrg: m.advisorOrg || '',
                    // 敏感字段：完整值仅存内部档案，不进公开展示字段
                    idCard: m.idCard || '',
                    advisorPhone: m.advisorPhone || ''
                };
                if (idx >= 0) {
                    teamMemberData[idx] = Object.assign({}, teamMemberData[idx], next, {
                        id: teamMemberData[idx].id,
                        avatar: next.avatar || teamMemberData[idx].avatar || '',
                        // 空值不覆盖已有敏感信息
                        idCard: next.idCard || teamMemberData[idx].idCard || '',
                        advisorPhone: next.advisorPhone || teamMemberData[idx].advisorPhone || '',
                        phone: next.phone || teamMemberData[idx].phone || ''
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
            alert(`导入完成：新增 ${count} 条，更新 ${updated} 条。敏感字段已按保密规则保存。`);
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
        
        async function initPatentMgmtData(options) {
            options = options || {};
            try {
                const data = await supabaseRequest('GET', 'patents', { select: '*', order: 'grant_date.desc.nullslast' });
                // 过滤掉云端同步占位记录，避免出现在专利台账
                patentMgmtData = (data || []).filter(function(p) {
                    return !(p && (p.classification === '__APP_SYNC__' || (p.patent_number && String(p.patent_number).indexOf('__SYNC_KV__') === 0)));
                });
                persistPatentMgmtGlobalMirror();
            } catch (e) {
                console.error('加载专利数据失败:', e);
                try {
                    var local = JSON.parse(localStorage.getItem('patentMgmtData') || localStorage.getItem('patentData') || '[]');
                    patentMgmtData = Array.isArray(local) ? local : [];
                } catch (e2) {
                    patentMgmtData = [];
                }
            }
            try { window.patentMgmtData = patentMgmtData; } catch (eW) {}
            patentPage = 1;
            filteredPatentMgmtData = [...patentMgmtData];
            updatePatentMgmtFilterCounts();
            renderPatentMgmtTable();
        }

        /** 专利台账镜像到 KV / 首页 / 门户，实现全局联动 */
        function persistPatentMgmtGlobalMirror() {
            try {
                localStorage.setItem('patentMgmtData', JSON.stringify(patentMgmtData || []));
            } catch (e) {}
            try {
                // 兼容首页/门户仍读 patentData 的路径
                localStorage.setItem('patentData', JSON.stringify(patentMgmtData || []));
            } catch (e2) {}
            try {
                window.patentMgmtData = patentMgmtData;
                window.patentData = patentMgmtData;
                if (typeof patentData !== 'undefined') patentData = patentMgmtData;
            } catch (e3) {}
            try { if (typeof invalidatePortalCache === 'function') invalidatePortalCache(); } catch (e4) {}
            try { if (typeof invalidateHomeOverviewCache === 'function') invalidateHomeOverviewCache('patent'); } catch (e5) {}
        }
        
        async function savePatentMgmtData() {
            persistPatentMgmtGlobalMirror();
        }
        
        function updatePatentMgmtFilterCounts() {
            if (!document.getElementById('patentMgmtCountAll')) return;
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
            if (!tbody) return;
            tbody.innerHTML = '';
            if (filteredPatentMgmtData.length === 0) {
                if (emptyMsg) emptyMsg.style.display = 'block';
                return;
            }
            if (emptyMsg) emptyMsg.style.display = 'none';
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
                persistPatentMgmtGlobalMirror();
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
                persistPatentMgmtGlobalMirror();
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
        
        async function initPaperData(options) {
            options = options || {};
            try {
                const data = await supabaseRequest('GET', 'papers', { select: '*', order: 'publish_date.desc' });
                paperData = data || [];
                persistPaperGlobalMirror();
            } catch (e) {
                console.error('加载论文数据失败:', e);
                try {
                    var local = JSON.parse(localStorage.getItem('paperData') || '[]');
                    paperData = Array.isArray(local) ? local : [];
                } catch (e2) {
                    paperData = [];
                }
            }
            try { window.paperData = paperData; } catch (eW) {}
            filteredPaperData = [...paperData];
            updatePaperFilterCounts();
            renderPaperTable();
        }

        function persistPaperGlobalMirror() {
            try {
                localStorage.setItem('paperData', JSON.stringify(paperData || []));
            } catch (e) {}
            try { window.paperData = paperData; } catch (e2) {}
            try { if (typeof invalidatePortalCache === 'function') invalidatePortalCache(); } catch (e3) {}
            try { if (typeof invalidateHomeOverviewCache === 'function') invalidateHomeOverviewCache('paper'); } catch (e4) {}
        }
        
        async function savePaperData() {
            persistPaperGlobalMirror();
            // 尽力双写云表，失败不影响本地/KV 全局联动
            try {
                if (!Array.isArray(paperData) || !paperData.length) return;
                // 仅在导入等本地批量变更时调用；单条 CRUD 仍走 savePaper 的云表写入
            } catch (e) {}
        }
        
        function updatePaperFilterCounts() {
            if (!document.getElementById('paperCountAll')) return;
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
            if (!tbody) return;
            tbody.innerHTML = '';
            if (filteredPaperData.length === 0) { if (emptyMsg) emptyMsg.style.display = 'block'; return; }
            if (emptyMsg) emptyMsg.style.display = 'none';
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
                persistPaperGlobalMirror();
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
                persistPaperGlobalMirror();
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
                reader.onload = async function(event) {
                    const text = event.target.result;
                    const lines = text.split('\n');
                    let count = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        if (cols.length >= 8) {
                            const title = (cols[1] || '').trim();
                            const author = (cols[2] || '').trim();
                            if (!title || !author) continue;
                            const record = {
                                title: title,
                                author: author,
                                journal: (cols[3] || '').trim(),
                                index: (cols[4] || '').trim(),
                                unit: (cols[5] || '').trim(),
                                publish_date: (cols[6] || '').trim(),
                                status: (cols[7] || '审核中').trim(),
                                remark: ''
                            };
                            try {
                                await supabaseRequest('POST', 'papers', record);
                                count++;
                            } catch (ePost) {
                                // 云表失败时仍写入本地，保证可导入
                                const newId = paperData.length > 0 ? Math.max(...paperData.map(d => Number(d.id) || 0)) + 1 : 1;
                                paperData.push(Object.assign({ id: newId }, record));
                                count++;
                            }
                        }
                    }
                    await initPaperData();
                    persistPaperGlobalMirror();
                    updatePaperFilterCounts();
                    applyPaperFilters();
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
