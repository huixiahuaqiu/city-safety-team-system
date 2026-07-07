// 简单的 Node.js 服务器
// 提供静态文件服务 + 代理转发到通义千问 API

const http = require('http');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const PORT = 3000;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function serveStaticFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File Not Found: ' + filePath);
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

// 百度 OCR 配置
const BAIDU_OCR_API_KEY = 'oRABG7OrjSWqlB3zFidpzcaQ';
const BAIDU_OCR_SECRET_KEY = 'f4VsRRzAf19lViqj57wRrEmcrGGPidWN';

// 获取百度 OCR Access Token（带缓存）
let baiduOcrToken = null;
let baiduOcrTokenExpireTime = 0;

async function getBaiduOcrToken() {
    if (baiduOcrToken && Date.now() < baiduOcrTokenExpireTime) {
        return baiduOcrToken;
    }
    const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_OCR_API_KEY}&client_secret=${BAIDU_OCR_SECRET_KEY}`;
    const response = await fetch(tokenUrl);
    const data = await response.json();
    if (data.access_token) {
        baiduOcrToken = data.access_token;
        baiduOcrTokenExpireTime = Date.now() + (data.expires_in - 300) * 1000;
        return baiduOcrToken;
    }
    throw new Error('Failed to get Baidu OCR token: ' + JSON.stringify(data));
}

function parseMultipartFormData(body, boundary) {
    const result = {};
    const parts = body.split('--' + boundary);
    for (const part of parts) {
        if (!part || part === '--\r\n' || part === '--') continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.substring(0, headerEnd);
        const content = part.substring(headerEnd + 4);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
                const cleanContent = content.endsWith('\r\n') ? content.slice(0, -2) : content;
                result[name] = { filename: filenameMatch[1], content: cleanContent, headers };
            } else {
                const cleanContent = content.endsWith('\r\n') ? content.slice(0, -2) : content;
                result[name] = cleanContent;
            }
        }
    }
    return result;
}

async function extractTextFromDocx(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
}

async function extractTextFromPdf(buffer) {
    const data = await pdfParse(buffer);
    return data.text;
}

async function extractMembersWithAI(text, apiKey) {
    const prompt = `你是一个团队成员信息提取助手。请从以下文档内容中提取所有团队成员的信息，返回严格的 JSON 格式数组。

每个成员的字段说明：
- name: 姓名（必填）
- category: 分类，只能是以下值之一：advisor（导师）、2022、2023、2024、2025、2026（根据年级或身份判断，导师填 advisor，学生填入学年份）
- title: 职称/身份，如"教授/博士生导师"、"2024级硕士研究生"等（必填）
- research: 研究方向（可选）
- education: 教育背景（可选）
- phone: 联系电话（可选）
- email: 电子邮箱（可选）
- projects: 主持/参与项目（可选）
- awards: 获奖情况（可选）
- bio: 个人简介（可选，简短描述）

请直接返回 JSON 数组，不要有任何多余的文字或 markdown 标记。如果文档中没有找到团队成员信息，返回空数组 []。

文档内容：
${text.substring(0, 8000)}`;

    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: 'qwen-plus',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 4000
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error('AI 请求失败: ' + errorText);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    content = content.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    content = content.replace(/^```\s*/i, '').replace(/\s*```$/, '');

    try {
        return JSON.parse(content);
    } catch (e) {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error('AI 返回内容无法解析为 JSON: ' + content.substring(0, 200));
    }
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/api/baidu-ocr') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { image } = JSON.parse(body);
                const token = await getBaiduOcrToken();
                const ocrUrl = `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${token}`;
                const response = await fetch(ocrUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `image=${encodeURIComponent(image)}`
                });
                const data = await response.json();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/api/aliyun') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const requestData = JSON.parse(body);
                const { apiKey, model, messages, temperature, max_tokens } = requestData;
                const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model, messages, temperature: temperature || 0.7, max_tokens: max_tokens || 2000 })
                });
                if (response.ok) {
                    const data = await response.json();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data));
                } else {
                    const errorText = await response.text();
                    res.writeHead(response.status);
                    res.end(errorText);
                }
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/api/import-members') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            try {
                const buffer = Buffer.concat(chunks);
                const contentType = req.headers['content-type'] || '';
                const boundaryMatch = contentType.match(/boundary=(.+)$/);
                if (!boundaryMatch) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '无效的请求格式' }));
                    return;
                }
                const boundary = boundaryMatch[1];
                const formData = parseMultipartFormData(buffer.toString('binary'), boundary);

                const fileField = formData.file;
                const apiKey = formData.apiKey;

                if (!fileField || !fileField.filename) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '未找到上传的文件' }));
                    return;
                }

                const filename = fileField.filename.toLowerCase();
                const fileBuffer = Buffer.from(fileField.content, 'binary');

                let text = '';
                if (filename.endsWith('.docx')) {
                    text = await extractTextFromDocx(fileBuffer);
                } else if (filename.endsWith('.pdf')) {
                    text = await extractTextFromPdf(fileBuffer);
                } else if (filename.endsWith('.doc')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '.doc 格式暂不支持，请转换为 .docx 格式后再上传' }));
                    return;
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '不支持的文件格式，请上传 .docx 或 .pdf 文件' }));
                    return;
                }

                if (!text || text.trim().length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '文档中未提取到文本内容' }));
                    return;
                }

                let members = [];
                if (apiKey && apiKey.trim()) {
                    members = await extractMembersWithAI(text, apiKey.trim());
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '请先在系统设置中配置阿里云百炼 API Key' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    text: text.substring(0, 2000),
                    members: members
                }));
            } catch (error) {
                console.error('导入成员失败:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message || '处理失败' }));
            }
        });
    } else {
        let filePath = req.url === '/' ? '/index.html' : req.url;
        filePath = path.join(__dirname, filePath);
        serveStaticFile(res, filePath);
    }
});

server.listen(PORT, () => {
    console.log('Server running at http://localhost:' + PORT);
    console.log('Homepage: http://localhost:' + PORT + '/');
    console.log('Import page: http://localhost:' + PORT + '/import_supabase.html');
});
