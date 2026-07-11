const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

// 轻量加载 .env（不引入额外依赖），仅在变量未设置时填充。
(function loadDotEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) continue;
            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (!(key in process.env)) process.env[key] = val;
        }
    } catch (e) {
        console.warn('[WARN] 读取 .env 失败:', e.message);
    }
})();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } });

// 敏感密钥必须通过环境变量注入，禁止硬编码提交。
// 部署时在 .env 或运行环境设置 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY。
const BAIDU_OCR_API_KEY = process.env.BAIDU_OCR_API_KEY || '';
const BAIDU_OCR_SECRET_KEY = process.env.BAIDU_OCR_SECRET_KEY || '';

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

async function extractFromDocx(buffer) {
    const images = [];
    const result = await mammoth.convertToHtml({ buffer }, {
        convertImage: mammoth.images.imgElement(function(image) {
            return image.read().then(function(buffer) {
                const base64 = buffer.toString('base64');
                const mimeType = image.contentType || 'image/png';
                const dataUrl = `data:${mimeType};base64,${base64}`;
                images.push(dataUrl);
                return { src: dataUrl };
            });
        })
    });
    const text = result.value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { text, images };
}

async function extractFromPdf(buffer) {
    const images = [];
    const data = await pdfParse(buffer);
    const text = data.text;
    return { text, images };
}

async function extractMembersWithAI(text, apiKey, imageCount) {
    const prompt = `你是一个专业的个人信息提取助手。请仔细分析以下文档内容，提取其中包含的人员信息。

文档可能是：
1. 团队成员列表（包含多人信息）
2. 个人简历（只包含一人信息）
3. 其他类型文档

文档中可能包含 ${imageCount} 张图片。请识别每个成员对应的头像图片。

请识别文档中的人员信息并返回严格的 JSON 数组格式。

每个成员的字段说明：
- name: 姓名（必填）
- category: 分类，根据身份判断：
  - 导师/教授/博导/硕导 → "advisor"
  - 研究生/博士生/硕士生 → 根据入学年份填 "2022"、"2023"、"2024"、"2025"、"2026"
  - 其他人员 → 根据毕业年份或身份推断最合适的年份，如无法确定填 "2024"
- title: 职称/身份（必填），如"教授/博士生导师"、"2024级硕士研究生"、"助理研究员"等
- research: 研究方向（从文档中提取，如"城市安全"、"计算机视觉"、"自然语言处理"等）
- education: 教育背景（可选）
- phone: 联系电话（可选，从文档中提取）
- email: 电子邮箱（可选，从文档中提取）
- projects: 主持/参与项目（可选）
- awards: 获奖情况（可选）
- bio: 个人简介（可选，简短描述）
- avatarImageIndex: 头像图片索引（可选，整数，从 0 开始，表示文档中提取的第几张图片是该成员的头像，如果无法确定则返回 -1）

提取规则：
1. 如果是个人简历，提取该人的信息
2. 如果是团队列表，提取所有成员
3. 如果文档中没有明确的人员信息，返回空数组 []
4. 不要凭空捏造信息，只提取文档中明确提到的内容
5. category 字段必须从以下值中选择："advisor"、"2022"、"2023"、"2024"、"2025"、"2026"
6. 如果文档中有图片且能识别出是该成员的头像，请填写 avatarImageIndex，否则填 -1

请直接返回 JSON 数组，不要有任何多余的文字或 markdown 标记。

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

app.post('/api/baidu-ocr', async (req, res) => {
    try {
        if (!BAIDU_OCR_API_KEY || !BAIDU_OCR_SECRET_KEY) {
            return res.status(503).json({ error: '百度 OCR 未配置：请在 .env 设置 BAIDU_OCR_API_KEY 与 BAIDU_OCR_SECRET_KEY' });
        }
        const { image } = req.body;
        const token = await getBaiduOcrToken();
        const ocrUrl = `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${token}`;
        const response = await fetch(ocrUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `image=${encodeURIComponent(image)}`
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/aliyun', async (req, res) => {
    try {
        const { apiKey, model, messages, temperature, max_tokens } = req.body;
        const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, temperature: temperature || 0.7, max_tokens: max_tokens || 2000 })
        });
        if (response.ok) {
            const data = await response.json();
            res.json(data);
        } else {
            const errorText = await response.text();
            res.status(response.status).send(errorText);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/import-members', upload.single('file'), async (req, res) => {
    try {
        console.log('[DEBUG] 收到导入请求');
        console.log('[DEBUG] 文件:', req.file ? req.file.originalname : '无');
        console.log('[DEBUG] 文件大小:', req.file ? req.file.size + ' bytes' : '0');
        console.log('[DEBUG] API Key:', req.body.apiKey ? req.body.apiKey.substring(0, 10) + '...' : '未提供');

        if (!req.file) {
            return res.status(400).json({ error: '未找到上传的文件' });
        }

        const filename = req.file.originalname.toLowerCase();
        const fileBuffer = req.file.buffer;

        let text = '';
        let images = [];
        if (filename.endsWith('.docx')) {
            console.log('[DEBUG] 开始解析 DOCX:', filename);
            const result = await extractFromDocx(fileBuffer);
            text = result.text;
            images = result.images;
        } else if (filename.endsWith('.pdf')) {
            console.log('[DEBUG] 开始解析 PDF:', filename);
            const result = await extractFromPdf(fileBuffer);
            text = result.text;
            images = result.images;
        } else if (filename.endsWith('.doc')) {
            return res.status(400).json({ error: '.doc 格式暂不支持，请转换为 .docx 格式后再上传' });
        } else {
            return res.status(400).json({ error: '不支持的文件格式，请上传 .docx 或 .pdf 文件' });
        }

        console.log('[DEBUG] 提取到文本长度:', text.length, '字符');
        console.log('[DEBUG] 提取到图片数量:', images.length);
        console.log('[DEBUG] 文本预览:', text.substring(0, 300));

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: '文档中未提取到文本内容' });
        }

        let members = [];
        if (req.body.apiKey && req.body.apiKey.trim()) {
            console.log('[DEBUG] 开始调用 AI 提取成员信息');
            members = await extractMembersWithAI(text, req.body.apiKey.trim(), images.length);
            console.log('[DEBUG] AI 返回成员数量:', members.length);
        } else {
            return res.status(400).json({ error: '请先在系统设置中配置阿里云百炼 API Key' });
        }

        res.json({
            success: true,
            text: text.substring(0, 2000),
            images: images,
            members: members
        });
    } catch (error) {
        console.error('[ERROR] 导入成员失败:', error);
        console.error('[ERROR] 堆栈:', error.stack);
        res.status(500).json({ error: error.message || '处理失败' });
    }
});

app.listen(PORT, () => {
    console.log('Server running at http://localhost:' + PORT);
    console.log('Homepage: http://localhost:' + PORT + '/');
});
