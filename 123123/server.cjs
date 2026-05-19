// 简单的 Node.js 服务器
// 提供静态文件服务 + 代理转发到通义千问 API

const http = require('http');
const fs = require('fs');
const path = require('path');

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
                console.log('[百度OCR] 收到请求');
                const { image } = JSON.parse(body);
                console.log('[百度OCR] 图片Base64长度:', image ? image.length : 0);
                const token = await getBaiduOcrToken();
                console.log('[百度OCR] Token获取成功');
                const ocrUrl = `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${token}`;
                console.log('[百度OCR] 请求URL:', ocrUrl);
                const response = await fetch(ocrUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: image })
                });
                console.log('[百度OCR] 响应状态:', response.status);
                const responseText = await response.text();
                console.log('[百度OCR] 响应内容:', responseText.substring(0, 500));
                const data = JSON.parse(responseText);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch (error) {
                console.error('[百度OCR] 错误:', error);
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
