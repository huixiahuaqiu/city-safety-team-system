// Copy this file to config.local.js and fill deployment-specific values.
// Never commit config.local.js.
window.APP_CONFIG = {
    SUPABASE_URL: '',
    SUPABASE_KEY: '',
    MLOPS_TOKEN: '',
    ANNOTATION_UPLOAD_TOKEN: '',
    // 标注真实文件云端共享桶（需先执行 supabase_annotations_storage.sql）
    ANNOTATION_STORAGE_BUCKET: 'annotations'
};
