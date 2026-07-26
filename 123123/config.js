// Public frontend defaults (safe to commit).
// Environment-specific values are generated into config.runtime.js.
// Secrets must never be added to browser configuration.
window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, {
    APP_ENV: 'local',
    SHOW_DEMO_ACCOUNTS: true,
    GATEWAY_AUTH_ENABLED: true,
    DATA_BACKEND: 'gateway',
    API_PROXY: '',
    CLOUD_HOME_POLL_MS: 15000,
    CLOUD_BACKGROUND_POLL_MS: 60000,
    CLOUD_RETRY_MAX_MS: 300000
});
