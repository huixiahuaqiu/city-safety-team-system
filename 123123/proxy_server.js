const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = 3000;

const server = http.createServer((req, res) => {
    // 处理CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url.startsWith('/api/aliyun')) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const requestData = JSON.parse(body);
                const apiKey = requestData.apiKey;
                const model = requestData.model || 'qwen3.6-plus';
                const messages = requestData.messages || [{ role: 'user', content: 'Hello' }];
                const temperature = requestData.temperature || 0.7;
                const max_tokens = requestData.max_tokens || 1000;

                if (!apiKey) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'API key is required' }));
                    return;
                }

                // 构建阿里云API请求
                const aliyunUrl = 'https://dashscope.aliyuncs.com/api/v1/chat/completions';
                const options = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    }
                };

                const payload = {
                    model: model,
                    messages: messages,
                    temperature: temperature,
                    max_tokens: max_tokens
                };

                // 发送请求到阿里云API
                const aliyunReq = https.request(aliyunUrl, options, (aliyunRes) => {
                    let aliyunBody = '';
                    aliyunRes.on('data', chunk => {
                        aliyunBody += chunk.toString();
                    });
                    aliyunRes.on('end', () => {
                        res.statusCode = aliyunRes.statusCode;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(aliyunBody);
                    });
                });

                aliyunReq.on('error', (error) => {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: `Internal server error: ${error.message}` }));
                });

                aliyunReq.write(JSON.stringify(payload));
                aliyunReq.end();

            } catch (error) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `Invalid JSON: ${error.message}` }));
            }
        });
    } else if (req.method === 'GET') {
        // 提供静态文件服务
        let filePath = '.' + req.url;
        if (filePath === './') {
            filePath = './index.html';
        }

        const extname = String(path.extname(filePath)).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.wav': 'audio/wav',
            '.mp4': 'video/mp4',
            '.woff': 'application/font-woff',
            '.ttf': 'application/font-ttf',
            '.eot': 'application/vnd.ms-fontobject',
            '.otf': 'application/font-otf',
            '.wasm': 'application/wasm'
        };

        const contentType = mimeTypes[extname] || 'application/octet-stream';

        fs.readFile(filePath, (error, content) => {
            if (error) {
                if (error.code === 'ENOENT') {
                    res.statusCode = 404;
                    res.setHeader('Content-Type', 'text/html');
                    res.end('<h1>404 Not Found</h1>', 'utf-8');
                } else {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'text/html');
                    res.end(`<h1>500 Internal Server Error</h1>${error.code}`, 'utf-8');
                }
            } else {
                res.statusCode = 200;
                res.setHeader('Content-Type', contentType);
                res.end(content, 'utf-8');
            }
        });
    } else {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html');
        res.end('<h1>404 Not Found</h1>', 'utf-8');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`API proxy available at http://localhost:${PORT}/api/aliyun`);
});
