// Cloudflare Worker - 百度 OCR API 代理
// 部署步骤：
// 1. 登录 https://dash.cloudflare.com/
// 2. Workers & Pages → Create Application → Create Worker
// 3. 粘贴以下代码 → Save and Deploy

const BAIDU_OCR_API_KEY = 'oRABG7OrjSWqlB3zFidpzcaQ';
const BAIDU_OCR_SECRET_KEY = 'f4VsRRzAf19lViqj57wRrEmcrGGPidWN';
const ALIYUN_API_KEY = 'sk-997a88dd8f274103a2e3d427bf29a873';

let cachedToken = null;
let tokenExpiry = 0;

async function getBaiduOcrToken() {
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_OCR_API_KEY}&client_secret=${BAIDU_OCR_SECRET_KEY}`;
    const response = await fetch(tokenUrl);
    const data = await response.json();
    if (data.access_token) {
        cachedToken = data.access_token;
        tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
        return cachedToken;
    }
    throw new Error('Failed to get Baidu OCR token');
}

export default {
    async fetch(request, env, ctx) {
        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // Handle preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(request.url);

        // 百度 OCR 代理
        if (url.pathname === '/api/baidu-ocr' && request.method === 'POST') {
            try {
                const { image } = await request.json();
                const token = await getBaiduOcrToken();
                const ocrUrl = `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${token}`;
                const response = await fetch(ocrUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: image })
                });
                const data = await response.json();
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
        }

        // 阿里云 API 代理
        if (url.pathname === '/api/aliyun' && request.method === 'POST') {
            try {
                const data = await request.json();
                const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ALIYUN_API_KEY}` },
                    body: JSON.stringify({
                        model: data.model || 'qwen-turbo',
                        messages: data.messages,
                        temperature: data.temperature || 0.7,
                        max_tokens: data.max_tokens || 2000
                    })
                });
                const result = await response.json();
                return new Response(JSON.stringify(result), {
                    status: response.status,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }
};
