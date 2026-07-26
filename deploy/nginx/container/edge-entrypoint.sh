#!/bin/sh
set -eu

runtime_dir=/usr/share/nginx/runtime
runtime_file="${runtime_dir}/config.runtime.js"
runtime_tmp="${runtime_file}.tmp"

mkdir -p "${runtime_dir}"
umask 022

js_escape() {
    # Runtime values are operator-controlled, but still escape them before
    # embedding into JavaScript. Newlines are not meaningful in these values.
    printf '%s' "$1" \
        | tr -d '\r\n' \
        | sed 's/\\/\\\\/g; s/"/\\"/g'
}

js_bool() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) printf 'true' ;;
        *) printf 'false' ;;
    esac
}

app_env="$(js_escape "${APP_ENV:-local}")"
api_proxy="$(js_escape "${API_PROXY:-}")"
annotation_bucket="$(js_escape "${ANNOTATION_STORAGE_BUCKET:-annotations}")"
show_demo="$(js_bool "${SHOW_DEMO_ACCOUNTS:-false}")"
gateway_auth="$(js_bool "${GATEWAY_AUTH_ENABLED:-true}")"

# This file is intentionally public. Never add database, MinIO, upload,
# MLOps, AI-provider, or session-signing secrets here.
{
    printf '%s\n' '// Generated at container start. Public values only.'
    printf '%s\n' 'window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, {'
    printf '    APP_ENV: "%s",\n' "${app_env}"
    printf '    SHOW_DEMO_ACCOUNTS: %s,\n' "${show_demo}"
    printf '    GATEWAY_AUTH_ENABLED: %s,\n' "${gateway_auth}"
    printf '%s\n' '    DATA_BACKEND: "gateway",'
    printf '    API_PROXY: "%s",\n' "${api_proxy}"
    printf '%s\n' '    SUPABASE_URL: "",'
    printf '%s\n' '    SUPABASE_KEY: "",'
    printf '%s\n' '    MLOPS_TOKEN: "",'
    printf '%s\n' '    ANNOTATION_UPLOAD_TOKEN: "",'
    printf '%s\n' '    DATASET_UPLOAD_TOKEN: "",'
    printf '    ANNOTATION_STORAGE_BUCKET: "%s"\n' "${annotation_bucket}"
    printf '%s\n' '});'
} > "${runtime_tmp}"

mv -f "${runtime_tmp}" "${runtime_file}"

exec /docker-entrypoint.sh "$@"
