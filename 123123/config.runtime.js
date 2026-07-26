// Safe fallback used when the app is started without the container stack.
// Docker replaces this file at runtime using non-secret environment values.
window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {});
