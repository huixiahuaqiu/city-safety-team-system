// Copy this file to config.local.js for machine-specific overrides (tokens, etc).
// Public defaults live in config.js and are safe to commit.
window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, {
    // Optional local overrides:
    // SUPABASE_URL: '',
    // SUPABASE_KEY: '',
    MLOPS_TOKEN: '',
    ANNOTATION_UPLOAD_TOKEN: '',
    ANNOTATION_STORAGE_BUCKET: 'annotations'
});
