// Public frontend config (safe to commit).
// Publishable Supabase key is intended for browser clients with RLS.
// Local overrides go in config.local.js (gitignored).
window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, {
    SUPABASE_URL: 'https://havxlphglhjgcfgwowae.supabase.co',
    SUPABASE_KEY: 'sb_publishable_jhRxljv8ocdnXBknablKiA_kRBzlEnC',
    ANNOTATION_STORAGE_BUCKET: 'annotations'
});
