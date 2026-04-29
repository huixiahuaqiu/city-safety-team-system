// 简单的 Node.js 代理服务器
// 用于转发请求到通义千问 API，解决跨域问题

const http = require('http');

const PORT = 3000;

const server = http.createServer((req, res) => {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 只处理 POST 请求
    if (req.method === 'POST' && req.url === '/api/aliyun') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const requestData = JSON.parse(body);
                const { apiKey, model, messages, temperature, max_tokens } = requestData;

                console.log('📤 转发请求到通义千问 API...');
                console.log('模型:', model);
                console.log('消息数量:', messages.length);

                // 转发到通义千问 API
                const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: messages,
                        temperature: temperature || 0.7,
                        max_tokens: max_tokens || 2000
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    console.log('✅ API 调用成功');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data));
                } else {
                    const errorText = await response.text();
                    console.error('❌ API 调用失败:', response.status, errorText);
                    res.writeHead(response.status);
                    res.end(errorText);
                }

            } catch (error) {
                console.error('❌ 服务器错误:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });

    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`🚀 代理服务器运行在 http://localhost:${PORT}`);
    console.log(`📡 代理端点：http://localhost:${PORT}/api/aliyun`);
    console.log(`⚠️  按 Ctrl+C 停止服务器`);
});
