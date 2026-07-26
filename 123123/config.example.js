// Copy this file to config.local.js for machine-specific overrides (tokens, etc).
// Public defaults live in config.js and are safe to commit.
// Important: always Object.assign — never replace window.APP_CONFIG entirely.
window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, {
    // 生产部署建议：
    // APP_ENV: 'production',
    // SHOW_DEMO_ACCOUNTS: false,
    // GATEWAY_AUTH_ENABLED: true,
    // DATA_BACKEND: 'gateway', // 浏览器只访问同源网关，绝不直连数据库
    // API_PROXY: '', // 留空即使用同源 /api 网关；仅在完全信任的自建代理场景设置
    // CLOUD_HOME_POLL_MS: 15000,
    // CLOUD_BACKGROUND_POLL_MS: 60000,
    // CLOUD_RETRY_MAX_MS: 300000,
    ANNOTATION_STORAGE_BUCKET: 'annotations',
    // 密钥只放服务端 .env；不要把数据库、MinIO、上传或 AI 密钥写进本文件。
});
