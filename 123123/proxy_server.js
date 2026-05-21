import http from 'http';
import fs from 'fs';
import path from 'path';
import https from 'https';

const PORT = 3000;
const BAIDU_OCR_API_KEY = process.env.BAIDU_OCR_API_KEY || '';
const BAIDU_OCR_SECRET_KEY = process.env.BAIDU_OCR_SECRET_KEY || '';

function postJson(url, payload, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const requestUrl = new URL(url);
        const options = {
            hostname: requestUrl.hostname,
            path: `${requestUrl.pathname}${requestUrl.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...headers
            }
        };

        const req = https.request(options, (resp) => {
            let body = '';
            resp.on('data', chunk => {
                body += chunk.toString();
            });
            resp.on('end', () => {
                resolve({ statusCode: resp.statusCode, body });
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function fetchBaiduAccessToken() {
    return new Promise((resolve, reject) => {
        const tokenPath = `/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(BAIDU_OCR_API_KEY)}&client_secret=${encodeURIComponent(BAIDU_OCR_SECRET_KEY)}`;
        const req = https.request({
            hostname: 'aip.baidubce.com',
            path: tokenPath,
            method: 'GET'
        }, (resp) => {
            let body = '';
            resp.on('data', chunk => {
                body += chunk.toString();
            });
            resp.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.access_token) {
                        reject(new Error(data.error_description || data.error || '获取百度 access_token 失败'));
                        return;
                    }
                    resolve(data.access_token);
                } catch (err) {
                    reject(new Error(`解析百度 token 响应失败: ${err.message}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

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

    if (req.method === 'POST' && req.url.startsWith('/api/baidu-ocr')) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                if (!BAIDU_OCR_API_KEY || !BAIDU_OCR_SECRET_KEY) {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'Baidu OCR credentials are not configured on server' }));
                    return;
                }

                const requestData = JSON.parse(body || '{}');
                const image = requestData.image;
                if (!image) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'image is required' }));
                    return;
                }

                const accessToken = await fetchBaiduAccessToken();
                const ocrResult = await postJson(
                    `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${encodeURIComponent(accessToken)}`,
                    { image }
                );

                res.statusCode = ocrResult.statusCode || 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(ocrResult.body);
            } catch (error) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `Baidu OCR proxy error: ${error.message}` }));
            }
        });
    } else if (req.method === 'POST' && req.url.startsWith('/api/aliyun')) {
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
    console.log(`OCR proxy available at http://localhost:${PORT}/api/baidu-ocr`);
});
