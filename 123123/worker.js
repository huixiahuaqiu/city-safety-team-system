export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                },
            });
        }

        const url = new URL(request.url);

        if (url.pathname === '/api/baidu-ocr' && request.method === 'POST') {
            return handleBaiduOcr(request, env);
        }

        if (url.pathname === '/api/aliyun' && request.method === 'POST') {
            return handleAliyun(request, env);
        }

        return new Response('Not Found', { status: 404 });
    },
};

async function handleBaiduOcr(request, env) {
    try {
        const { image } = await request.json();

        const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${env.BAIDU_OCR_API_KEY}&client_secret=${env.BAIDU_OCR_SECRET_KEY}`;
        const tokenRes = await fetch(tokenUrl);
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            return jsonResponse({ error: 'Failed to get Baidu OCR token', details: tokenData }, 500);
        }

        const ocrUrl = `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${tokenData.access_token}`;
        const ocrRes = await fetch(ocrUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `image=${encodeURIComponent(image)}`,
        });
        const ocrData = await ocrRes.json();

        return jsonResponse(ocrData);
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

async function handleAliyun(request, env) {
    try {
        const requestData = await request.json();
        const { apiKey, model, messages, temperature, max_tokens } = requestData;

        const effectiveApiKey = apiKey || env.ALIYUN_API_KEY;

        const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${effectiveApiKey}`,
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: temperature || 0.7,
                max_tokens: max_tokens || 2000,
            }),
        });

        const data = await response.json();
        return jsonResponse(data, response.ok ? 200 : response.status);
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
