// Excel 处理（从 app-core 机械外置）
        // Excel处理相关函数
        let uploadedExcelFiles = [];
        let excelData = []; // 存储Excel文件数据
        let mergedWorkbook = null; // 存储合并后的工作簿
        let dataTypes = []; // 存储提取的数据类型
        
        // 处理Excel文件上传
        async function handleExcelFileUpload(event) {
            try {
                if (typeof ensureVendor === 'function') await ensureVendor('xlsx');
            } catch (e) {
                alert('Excel 组件加载失败，请检查网络或 vendor/xlsx');
                return;
            }
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
                    dlog('文件上传成功，开始 AI 预处理...');
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
                dlog('⚠️ 未设置 API Key，跳过 AI 预处理');
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
                
                dlog('🔄 正在预处理文件:', excelItem.file.name);
                
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
                    
                    dlog('✅ AI 预处理完成');
                    
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
            
            dlog('excelData 长度:', excelData.length);
            dlog('uploadedExcelFiles 长度:', uploadedExcelFiles.length);
            
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
                
                dlog('发送给 AI 的 Excel 数据:', JSON.stringify(excelDataForAI, null, 2));
                dlog('数据大小:', JSON.stringify(excelDataForAI).length, '字节');
                
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
                    
                    dlog('AI 响应:', aiResponse);
                    
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
            dlog('=== 打开智能指令面板 ===');
            dlog('excelData 长度:', excelData.length);
            dlog('uploadedExcelFiles 长度:', uploadedExcelFiles.length);
            
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
                dlog('=== 发送给 AI 的 Excel 数据 ===');
                dlog('数据大小:', jsonDataString.length, '字节');
                dlog('文件数量:', excelDataForAI.length);
                dlog('===============================');
                
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
                    dlog('API 返回数据:', data);
                    
                    const aiResponse = data.choices?.[0]?.message?.content;
                    
                    if (!aiResponse) {
                        console.error('AI 响应为空:', data);
                        showInstructionStatus('❌ AI 返回空响应。请检查服务器日志或重试。', 'error');
                        return;
                    }
                    
                    dlog('智能指令 AI 响应:', aiResponse);
                    
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
                    dlog('本地代理不可用，使用备用方案');
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
                    
                    dlog('AI 响应:', aiResponse);
                    
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
                dlog('⚠️ API 调用失败，使用演示模式');
                
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
                    
                    dlog('✅ 演示图表已生成');
                    
                } catch (demoError) {
                    console.error('演示模式失败:', demoError);
                    showStatusMessage('演示模式也失败了：' + demoError.message, 'error');
                }
            }
        }
