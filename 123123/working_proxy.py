"""Production-ready local gateway: static files, AI proxy, MLOps and annotation APIs."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import base64
import binascii
import hashlib
import hmac
import io
import ipaddress
import json
import logging
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
import data_store
import sync_policy

ENV_PATH = os.path.join(BASE_DIR, '.env')
MLOPS_STORE_PATH = os.path.join(BASE_DIR, 'mlops_store.json')
ANNOTATION_UPLOAD_ROOT = os.path.join(BASE_DIR, 'uploads', 'annotations')
DATASET_UPLOAD_ROOT = os.path.join(BASE_DIR, 'uploads', 'datasets')
SHARED_FILE_UPLOAD_ROOT = os.path.join(BASE_DIR, 'uploads', 'shared')
DATASET_META_PATH = os.path.join(DATASET_UPLOAD_ROOT, '_registry.json')
SHARED_FILE_META_PATH = os.path.join(SHARED_FILE_UPLOAD_ROOT, '_registry.json')
AUDIT_LOG_PATH = os.path.join(BASE_DIR, 'logs', 'server_audit.log')
ANNOTATION_BLOB_MARK = '__APP_SYNC_BLOB__'
ANNOTATION_BLOB_PREFIX = '__SYNC_BLOB__anno_'

_minio_client = None
_minio_init_tried = False


def load_env_file(path):
    """Load simple KEY=VALUE pairs without introducing a runtime dependency."""
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


load_env_file(ENV_PATH)

# 容器内把可变数据统一放在挂载目录；本地直接运行时仍兼容原目录。
_data_root_raw = (
    os.environ.get('CITYSAFE_DATA_DIR')
    or os.environ.get('CITYSAFE_DATA_ROOT')
    or BASE_DIR
).strip()
CITYSAFE_DATA_DIR = os.path.abspath(
    _data_root_raw if os.path.isabs(_data_root_raw) else os.path.join(BASE_DIR, _data_root_raw)
)
_state_root_raw = (os.environ.get('CITYSAFE_STATE_ROOT') or CITYSAFE_DATA_DIR).strip()
CITYSAFE_STATE_DIR = os.path.abspath(
    _state_root_raw if os.path.isabs(_state_root_raw) else os.path.join(CITYSAFE_DATA_DIR, _state_root_raw)
)
MLOPS_STORE_PATH = os.path.join(CITYSAFE_STATE_DIR, 'mlops_store.json')
ANNOTATION_UPLOAD_ROOT = os.path.join(CITYSAFE_DATA_DIR, 'uploads', 'annotations')
DATASET_UPLOAD_ROOT = os.path.join(CITYSAFE_DATA_DIR, 'uploads', 'datasets')
SHARED_FILE_UPLOAD_ROOT = os.path.join(CITYSAFE_DATA_DIR, 'uploads', 'shared')
DATASET_META_PATH = os.path.join(DATASET_UPLOAD_ROOT, '_registry.json')
SHARED_FILE_META_PATH = os.path.join(SHARED_FILE_UPLOAD_ROOT, '_registry.json')
AUDIT_LOG_PATH = os.path.join(CITYSAFE_DATA_DIR, 'logs', 'server_audit.log')

# 共享文件可选对象存储（S3 / MinIO 兼容）——须在 load_env_file 之后读取
SHARED_STORAGE_BACKEND = (os.environ.get('SHARED_STORAGE_BACKEND') or 'local').strip().lower()
MINIO_ENDPOINT = (os.environ.get('MINIO_ENDPOINT') or '').strip().rstrip('/')
MINIO_ACCESS_KEY = os.environ.get('MINIO_ACCESS_KEY', '')
MINIO_SECRET_KEY = os.environ.get('MINIO_SECRET_KEY', '')
MINIO_BUCKET = os.environ.get('MINIO_BUCKET', 'team-shared')
MINIO_SECURE = (os.environ.get('MINIO_SECURE') or 'false').strip().lower() in ('1', 'true', 'yes')
MINIO_REGION = os.environ.get('MINIO_REGION', 'us-east-1')

MLOPS_TOKEN = os.environ.get('MLOPS_TOKEN', '')
ANNOTATION_UPLOAD_TOKEN = os.environ.get('ANNOTATION_UPLOAD_TOKEN', '')
MAX_UPLOAD_BYTES = int(os.environ.get('MAX_UPLOAD_BYTES', str(200 * 1024 * 1024)))
MAX_DATASET_BYTES = int(os.environ.get('MAX_DATASET_BYTES', str(10 * 1024 * 1024 * 1024)))
DATASET_CHUNK_SIZE = int(os.environ.get('DATASET_CHUNK_SIZE', str(8 * 1024 * 1024)))
DATASET_MIN_CHUNK_BYTES = 64 * 1024
DATASET_MAX_CHUNK_BYTES = 64 * 1024 * 1024
DATASET_MAX_CHUNKS = 100_000
DATASET_UPLOAD_ID_MAX_LENGTH = 128
MAX_JSON_BODY_BYTES = int(os.environ.get('MAX_JSON_BODY_BYTES', str(2 * 1024 * 1024)))
DATASET_UPLOAD_TOKEN = os.environ.get('DATASET_UPLOAD_TOKEN', '') or os.environ.get('ANNOTATION_UPLOAD_TOKEN', '')
# 安全默认值：网关仅监听本机且不开放跨域。需要跨域时显式配置逗号分隔的白名单；
# 旧变量 CORS_ALLOW_ORIGIN 仍兼容，但不再默认使用通配符。
BIND_HOST = os.environ.get('BIND_HOST', '127.0.0.1').strip() or '127.0.0.1'
_cors_raw = os.environ.get('CORS_ALLOW_ORIGINS', '') or os.environ.get('CORS_ALLOW_ORIGIN', '')
CORS_ALLOW_ORIGINS = {
    item.strip().rstrip('/')
    for item in _cors_raw.split(',')
    if item.strip()
}
ALLOW_INSECURE_LOCAL_WRITES = (
    os.environ.get('ALLOW_INSECURE_LOCAL_WRITES') or '0'
).strip().lower() in ('1', 'true', 'yes')
CITYSAFE_ENV = (os.environ.get('CITYSAFE_ENV') or 'development').strip().lower()
AUTH_REQUIRED = (os.environ.get('AUTH_REQUIRED') or '0').strip().lower() in ('1', 'true', 'yes')
AUTH_SIGNING_SECRET = os.environ.get('AUTH_SIGNING_SECRET', '')
AUTH_SESSION_TTL_SECONDS = max(
    900,
    min(int(os.environ.get('AUTH_SESSION_TTL_SECONDS', '28800')), 7 * 24 * 60 * 60),
)
AUTH_ACCOUNT_CACHE_SECONDS = max(
    5,
    min(int(os.environ.get('AUTH_ACCOUNT_CACHE_SECONDS', '30')), 300),
)
AUTH_LOGIN_MAX_ATTEMPTS = max(3, min(int(os.environ.get('AUTH_LOGIN_MAX_ATTEMPTS', '5')), 20))
AUTH_LOGIN_LOCK_SECONDS = max(30, min(int(os.environ.get('AUTH_LOGIN_LOCK_SECONDS', '900')), 86400))
# Only honor X-Real-IP / X-Forwarded-For when the immediate peer is a trusted
# reverse proxy (Compose edge by default). Comma-separated IPs or CIDRs.
_TRUSTED_PROXY_RAW = (
    os.environ.get('TRUSTED_PROXY_IPS')
    or os.environ.get('TRUSTED_PROXY_CIDRS')
    or '127.0.0.1,::1,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16'
)
PASSWORD_CHANGE_ALLOWED_PATHS = frozenset(
    {
        '/api/auth/me',
        '/api/auth/change-password',
        '/api/auth/logout',
        '/api/health',
        '/api/ready',
    }
)
BOOTSTRAP_ADMIN_USERNAME = (os.environ.get('BOOTSTRAP_ADMIN_USERNAME') or '').strip()
BOOTSTRAP_ADMIN_NAME = (os.environ.get('BOOTSTRAP_ADMIN_NAME') or '系统管理员').strip()
BOOTSTRAP_ADMIN_PASSWORD = os.environ.get('BOOTSTRAP_ADMIN_PASSWORD', '')
BOOTSTRAP_ADMIN_PASSWORD_FILE = (os.environ.get('BOOTSTRAP_ADMIN_PASSWORD_FILE') or '').strip()
MINIO_PRESIGN_EXPIRE = int(os.environ.get('MINIO_PRESIGN_EXPIRE', '600'))
MINIO_PUBLIC_UPLOAD_PREFIX = (os.environ.get('MINIO_PUBLIC_UPLOAD_PREFIX') or '').strip().rstrip('/')
MINIO_PRESIGN_MAX_BYTES = int(os.environ.get('MINIO_PRESIGN_MAX_BYTES', str(MAX_DATASET_BYTES)))
# P2 加固：仅当对外前缀是 HTTPS 时才启用预签名直传，否则回退网关代理上传，
# 避免浏览器拿到 http:// 或内网直连的预签名 URL（明文传输 / 前缀不匹配上传失败）。
# 内网测试如必须放开，显式设 MINIO_ALLOW_INSECURE_PRESIGN=1（严禁用于公网）。
MINIO_ALLOW_INSECURE_PRESIGN = (os.environ.get('MINIO_ALLOW_INSECURE_PRESIGN') or '0').strip().lower() in ('1', 'true', 'yes')
# S3/MinIO 单次预签名 PUT 的硬上限为 5GiB；超过者共享文件直传无法完成，应走数据集分片上传。
SINGLE_PUT_MAX_BYTES = 5 * 1024 * 1024 * 1024
ALLOWED_UPLOAD_EXTENSIONS = {
    ext.strip().lower()
    for ext in os.environ.get(
        'ALLOWED_UPLOAD_EXTENSIONS',
        '.jpg,.jpeg,.png,.bmp,.webp,.gif,.txt,.xml,.csv,.json,.yaml,.yml',
    ).split(',')
    if ext.strip()
}
DATASET_ALLOWED_EXTENSIONS = {
    ext.strip().lower()
    for ext in os.environ.get(
        'DATASET_ALLOWED_EXTENSIONS',
        '.csv,.tsv,.json,.xml,.zip,.jpg,.jpeg,.png,.bmp,.webp,.xlsx,.xls,.txt,.yaml,.yml',
    ).split(',')
    if ext.strip()
}

# ClamAV 可选病毒扫描：本地开发默认关闭（CLAMAV_SCAN=0），生产可按 deploy/scripts/clamav-setup-notes.md 启用。
CLAMAV_SCAN = (os.environ.get('CLAMAV_SCAN') or '0').strip().lower() in ('1', 'true', 'yes')
CLAMSCAN_BIN = (os.environ.get('CLAMSCAN_BIN') or 'clamdscan').strip()

DANGEROUS_UPLOAD_EXTENSIONS = {
    '.html', '.htm', '.svg', '.js', '.exe', '.sh', '.php', '.bat', '.cmd',
}
IMAGE_PDF_SAFE_EXTENSIONS = {
    '.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif', '.pdf',
}
_HTML_SCRIPT_SNIFF_PREFIXES = (b'<html', b'<script', b'<?php')
# 可执行体魔数（与 head.lower() 比较）：ELF / Mach-O 均为非 ASCII，零误伤；
# Windows PE 单看 'MZ' 易误伤以 MZ 开头的文本，故在函数内额外要求 DOS stub 文案。
_EXECUTABLE_MAGICS = (
    b'\x7felf',                                   # Linux ELF
    b'\xfe\xed\xfa\xce', b'\xfe\xed\xfa\xcf',      # Mach-O 32/64
    b'\xce\xfa\xed\xfe', b'\xcf\xfa\xed\xfe',      # Mach-O 反序
    b'\xca\xfe\xba\xbe',                          # Mach-O fat / Java class
)
_PE_DOS_STUB = b'this program cannot be run in dos mode'

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
SUPABASE_SERVICE_ROLE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
ANNOTATION_STORAGE_BUCKET = os.environ.get('ANNOTATION_STORAGE_BUCKET', 'annotations')
ANNOTATION_BLOB_CHUNK_SIZE = int(os.environ.get('ANNOTATION_BLOB_CHUNK_SIZE', str(160 * 1024)))
ANNOTATION_BLOB_MAX_BYTES = int(os.environ.get('ANNOTATION_BLOB_MAX_BYTES', str(40 * 1024 * 1024)))
BAIDU_OCR_API_KEY = os.environ.get('BAIDU_OCR_API_KEY', '')
BAIDU_OCR_SECRET_KEY = os.environ.get('BAIDU_OCR_SECRET_KEY', '')
CLOUD_SYNC_MARK = '__APP_SYNC__'
CLOUD_SYNC_PN = '__SYNC_KV__modelTrainingData'
DATA_BACKEND = (os.environ.get('DATA_BACKEND') or 'postgres').strip().lower()
POSTGRES_DATA_BACKEND = DATA_BACKEND in ('postgres', 'postgresql', 'gateway', 'local')
APP_SYNC_KEYS = set(sync_policy.APP_SYNC_KEYS)

_baidu_ocr_token = {'access_token': '', 'expire_at': 0}
_store_lock = threading.Lock()
_shared_registry_lock = threading.Lock()  # 保护共享文件注册表的读改写，支持并发上传而不丢记录
_auth_lock = threading.Lock()
_account_write_lock = threading.RLock()
_dataset_upload_locks_guard = threading.Lock()
_dataset_upload_locks = {}
_auth_failures = {}
_account_cache = {'loaded_at': 0.0, 'accounts': []}

os.makedirs(os.path.dirname(AUDIT_LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=os.environ.get('LOG_LEVEL', 'INFO').upper(),
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(AUDIT_LOG_PATH, encoding='utf-8'),
    ],
)
logger = logging.getLogger('city_safety_gateway')


def _now_iso():
    return datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M:%S')


def _today():
    return datetime.now().strftime('%Y-%m-%d')


def get_baidu_ocr_token():
    """Fetch/cache Baidu OCR access_token from env credentials."""
    if not BAIDU_OCR_API_KEY or not BAIDU_OCR_SECRET_KEY:
        raise RuntimeError('百度 OCR 未配置：请在 .env 设置 BAIDU_OCR_API_KEY 与 BAIDU_OCR_SECRET_KEY')
    now = time.time()
    if _baidu_ocr_token['access_token'] and now < _baidu_ocr_token['expire_at']:
        return _baidu_ocr_token['access_token']
    token_url = (
        'https://aip.baidubce.com/oauth/2.0/token'
        '?grant_type=client_credentials'
        '&client_id=%s&client_secret=%s'
        % (urllib.parse.quote(BAIDU_OCR_API_KEY), urllib.parse.quote(BAIDU_OCR_SECRET_KEY))
    )
    with urllib.request.urlopen(token_url, timeout=20) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    token = data.get('access_token')
    if not token:
        raise RuntimeError('获取百度 OCR token 失败: %s' % json.dumps(data, ensure_ascii=False)[:240])
    _baidu_ocr_token['access_token'] = token
    _baidu_ocr_token['expire_at'] = now + max(60, int(data.get('expires_in', 2592000)) - 300)
    return token


def run_baidu_ocr(image_b64, accurate=False):
    """Call Baidu OCR. image_b64 should be raw base64 without data-url prefix."""
    image_b64 = (image_b64 or '').strip()
    if image_b64.startswith('data:'):
        image_b64 = image_b64.split(',', 1)[-1]
    if not image_b64:
        raise ValueError('image required')
    if len(image_b64) > 5_500_000:
        raise ValueError('image too large for OCR (keep under ~4MB)')
    token = get_baidu_ocr_token()
    path = 'accurate_basic' if accurate else 'general_basic'
    ocr_url = 'https://aip.baidubce.com/rest/2.0/ocr/v1/%s?access_token=%s' % (path, token)
    body = urllib.parse.urlencode({
        'image': image_b64,
        'detect_direction': 'true',
    }).encode('utf-8')
    req = urllib.request.Request(
        ocr_url,
        data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8'))


def load_mlops_store():
    with _store_lock:
        if not os.path.exists(MLOPS_STORE_PATH):
            data = {'jobs': [], 'updatedAt': _now_iso()}
            with open(MLOPS_STORE_PATH, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return data
        with open(MLOPS_STORE_PATH, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return {'jobs': [], 'updatedAt': _now_iso()}


def save_mlops_store(data):
    with _store_lock:
        data = dict(data)
        data['updatedAt'] = _now_iso()
        with open(MLOPS_STORE_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def normalize_job(payload, existing=None):
    existing = existing or {}
    status = str(payload.get('status') or existing.get('status') or 'training').lower()
    if status not in ('pending', 'training', 'completed', 'failed'):
        status = 'training'
    progress = payload.get('progress', existing.get('progress', 0))
    try:
        progress = int(progress)
    except (TypeError, ValueError):
        progress = 0
    progress = max(0, min(100, progress))
    if status == 'completed':
        progress = 100

    job_id = str(payload.get('jobId') or payload.get('job_id') or existing.get('jobId') or '').strip()
    name = str(payload.get('name') or existing.get('name') or job_id or '未命名训练任务').strip()
    env = str(payload.get('env') or existing.get('env') or 'remote').lower()
    if env not in ('local', 'remote'):
        env = 'remote'

    return {
        'id': existing.get('id') or int(time.time() * 1000) % 100000000,
        'jobId': job_id or ('job-' + str(int(time.time()))),
        'name': name,
        'code': str(payload.get('code') or existing.get('code') or name.replace(' ', '-')),
        'type': str(payload.get('type') or existing.get('type') or '其他'),
        'scenario': str(payload.get('scenario') or existing.get('scenario') or '城市安全监测'),
        'env': env,
        'server': str(payload.get('server') or existing.get('server') or ('本机' if env == 'local' else 'remote-gpu')),
        'owner': str(payload.get('owner') or existing.get('owner') or ''),
        'dataset': str(payload.get('dataset') or existing.get('dataset') or ''),
        'status': status,
        'metric': str(payload.get('metric') or existing.get('metric') or ('—' if status == 'pending' else '训练中')),
        'progress': progress,
        'logUrl': str(payload.get('logUrl') or payload.get('log_url') or existing.get('logUrl') or ''),
        'weightPath': str(payload.get('weightPath') or payload.get('weight_path') or existing.get('weightPath') or ''),
        'description': str(payload.get('description') or existing.get('description') or ''),
        'createdAt': existing.get('createdAt') or _today(),
        'updatedAt': _today(),
        'lastReportAt': _now_iso(),
        'syncSource': 'mlops',
    }


def upsert_job(payload):
    store = load_mlops_store()
    jobs = list(store.get('jobs') or [])
    job_id = str(payload.get('jobId') or payload.get('job_id') or '').strip()
    existing = None
    idx = -1
    if job_id:
        for i, j in enumerate(jobs):
            if str(j.get('jobId') or '') == job_id:
                existing = j
                idx = i
                break
    job = normalize_job(payload, existing)
    if idx >= 0:
        jobs[idx] = job
    else:
        # 保证 id 唯一
        max_id = max([int(j.get('id') or 0) for j in jobs] + [0])
        job['id'] = max_id + 1
        jobs.insert(0, job)
    store['jobs'] = jobs
    save_mlops_store(store)
    # 异步推送到云端 KV，供全员门户拉取
    threading.Thread(target=push_jobs_to_cloud, args=(jobs,), daemon=True).start()
    return job


def push_jobs_to_cloud(jobs):
    """把 MLOps jobs 合并写入团队同步存储。"""
    if POSTGRES_DATA_BACKEND:
        try:
            for _attempt in range(3):
                current = data_store.get_sync_value('modelTrainingData')
                existing = (current or {}).get('value') or []
                if not isinstance(existing, list):
                    existing = []
                by_job = {
                    str(item.get('jobId')): dict(item)
                    for item in existing
                    if isinstance(item, dict) and item.get('jobId')
                }
                for job in jobs:
                    if not isinstance(job, dict) or not job.get('jobId'):
                        continue
                    job_id = str(job['jobId'])
                    merged_job = dict(by_job.get(job_id) or {})
                    merged_job.update(job)
                    by_job[job_id] = merged_job
                merged = [
                    item for item in existing
                    if isinstance(item, dict) and not item.get('jobId')
                ]
                merged.extend(by_job.values())
                merged.sort(
                    key=lambda item: str(item.get('lastReportAt') or item.get('updatedAt') or ''),
                    reverse=True,
                )
                try:
                    data_store.put_sync_value(
                        'modelTrainingData',
                        merged,
                        int((current or {}).get('version') or 0),
                        'mlops-worker',
                    )
                    logger.info('mlops database sync ok jobs=%s', len(jobs))
                    return
                except data_store.VersionConflict:
                    continue
            raise RuntimeError('modelTrainingData changed repeatedly during merge')
        except Exception as exc:
            logger.exception('mlops database sync failed: %s', exc)
            return

    if not SUPABASE_URL or not SUPABASE_KEY:
        logger.warning('skip cloud sync: SUPABASE_URL/SUPABASE_KEY not configured')
        return
    try:
        headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
        }
        # 先读现有云端台账
        q = (
            SUPABASE_URL + '/rest/v1/patents'
            + '?classification=eq.' + urllib.parse.quote(CLOUD_SYNC_MARK)
            + '&patent_number=eq.' + urllib.parse.quote(CLOUD_SYNC_PN)
            + '&select=id,summary'
        )
        req = urllib.request.Request(q, headers=headers, method='GET')
        with urllib.request.urlopen(req, timeout=15) as resp:
            rows = json.loads(resp.read().decode('utf-8'))
        existing = []
        row_id = None
        if rows:
            row_id = rows[0].get('id')
            try:
                existing = json.loads(rows[0].get('summary') or '[]')
            except Exception:
                existing = []
        if not isinstance(existing, list):
            existing = []

        by_job = {}
        for item in existing:
            jid = str(item.get('jobId') or '')
            if jid:
                by_job[jid] = item
        for job in jobs:
            jid = str(job.get('jobId') or '')
            if not jid:
                continue
            base = dict(by_job.get(jid) or {})
            base.update(job)
            by_job[jid] = base

        # 保留无 jobId 的人工登记项
        merged = [x for x in existing if not x.get('jobId')]
        merged.extend(by_job.values())
        # 按 updatedAt / lastReportAt 粗排
        merged.sort(key=lambda x: str(x.get('lastReportAt') or x.get('updatedAt') or ''), reverse=True)

        body = {
            'patent_type': '同步',
            'name': 'APP_SYNC:modelTrainingData',
            'classification': CLOUD_SYNC_MARK,
            'patent_number': CLOUD_SYNC_PN,
            'summary': json.dumps(merged, ensure_ascii=False),
            'inventor': 'system',
            'applicant': 'system',
            'application_date': _today(),
            'status': 'SYNC',
            'remark': 'mlops-cloud-sync',
        }
        data = json.dumps(body).encode('utf-8')
        if row_id:
            url = SUPABASE_URL + '/rest/v1/patents?id=eq.' + urllib.parse.quote(str(row_id))
            req = urllib.request.Request(url, data=data, headers=headers, method='PATCH')
        else:
            url = SUPABASE_URL + '/rest/v1/patents'
            req = urllib.request.Request(url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
        logger.info('mlops cloud sync ok jobs=%s', len(jobs))
    except Exception as e:
        logger.exception('mlops cloud sync failed: %s', e)


# 轻量业务指标（内存计数，进程重启清零）：供 /api/health 暴露成功率，接监控可采集告警。
_metrics_lock = threading.Lock()
_metrics = {
    'uploads_ok': 0, 'uploads_fail': 0,
    'downloads_ok': 0, 'downloads_fail': 0,
    'presign_ok': 0, 'presign_fail': 0,
}


def _metrics_note(event):
    """按审计事件名粗粒度累计成功/失败，供健康接口计算业务成功率（防“假活”）。"""
    try:
        ev = str(event or '')
        if 'presign' in ev:
            bucket = 'presign'
        elif 'download' in ev:
            bucket = 'downloads'
        elif 'upload' in ev or 'confirm' in ev:
            bucket = 'uploads'
        else:
            return
        if ev.endswith('_ok'):
            key = bucket + '_ok'
        elif ev.endswith(('_failed', '_denied', '_reject')):
            key = bucket + '_fail'
        else:
            return
        with _metrics_lock:
            if key in _metrics:
                _metrics[key] += 1
    except Exception:
        pass


def _health_metrics_snapshot():
    with _metrics_lock:
        m = dict(_metrics)

    def _rate(ok, fail):
        tot = ok + fail
        return round(ok / tot * 100, 1) if tot else 100.0

    m['uploadSuccessRate'] = _rate(m['uploads_ok'], m['uploads_fail'])
    m['downloadSuccessRate'] = _rate(m['downloads_ok'], m['downloads_fail'])
    m['presignSuccessRate'] = _rate(m['presign_ok'], m['presign_fail'])
    return m


def audit_event(event, **fields):
    payload = {'event': event, 'time': _now_iso()}
    payload.update(fields)
    logger.info('AUDIT %s', json.dumps(payload, ensure_ascii=False, sort_keys=True))
    _metrics_note(event)


def sniff_allowed_upload(content, filename):
    """Magic-byte / content sniffing secondary gate; allow-list remains primary."""
    ext = os.path.splitext(str(filename or '').lower())[1]
    if ext in DANGEROUS_UPLOAD_EXTENSIONS:
        raise ValueError('dangerous file extension not allowed: %s' % ext)
    head = (content or b'')[:512].lstrip().lower()
    # 可执行文件魔数：无论扩展名一律拒绝（防 .exe/.elf 改名 .txt/.zip 等混入木马/可执行体）
    for magic in _EXECUTABLE_MAGICS:
        if head.startswith(magic):
            raise ValueError('executable binary not allowed by content sniff')
    # Windows PE：'MZ' 开头且含 DOS stub 文案才判定，避免误伤以 MZ 开头的文本
    if head.startswith(b'mz') and _PE_DOS_STUB in head:
        raise ValueError('executable binary not allowed by content sniff')
    if ext in IMAGE_PDF_SAFE_EXTENSIONS:
        for prefix in _HTML_SCRIPT_SNIFF_PREFIXES:
            if head.startswith(prefix):
                raise ValueError('content looks like HTML/script but claimed as image/pdf-safe type')


def scan_file_clamav(path):
    """Run ClamAV on disk file. Returns (ok, detail); skipped when CLAMAV_SCAN=0."""
    if not CLAMAV_SCAN:
        return True, 'skipped'
    if not os.path.isfile(path):
        return False, 'file not found'
    if not shutil.which(CLAMSCAN_BIN):
        return False, 'scanner not found: %s' % CLAMSCAN_BIN
    try:
        proc = subprocess.run(
            [CLAMSCAN_BIN, '--no-summary', path],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode == 0:
            return True, 'clean'
        if proc.returncode == 1:
            detail = (proc.stdout or proc.stderr or 'infected').strip()
            return False, detail or 'infected'
        detail = (proc.stderr or proc.stdout or 'scan error').strip()
        return False, detail or 'scan error'
    except subprocess.TimeoutExpired:
        return False, 'scan timeout'
    except Exception as e:
        return False, str(e)


def _quarantine_file(path):
    """Rename suspicious file aside; best-effort."""
    qpath = path + '.quarantine'
    try:
        os.replace(path, qpath)
    except OSError:
        try:
            os.remove(path)
        except OSError:
            pass
    return qpath


def enforce_clamav_scan(path, context=''):
    """Scan local file; quarantine and raise ValueError on failure."""
    ok, detail = scan_file_clamav(path)
    if ok:
        return detail
    qpath = _quarantine_file(path)
    audit_event('clamav_quarantine', path=path, quarantine=qpath, detail=detail, context=context)
    raise ValueError('malware scan failed: %s' % detail)


def _b64url_encode(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _b64url_decode(value):
    text = str(value or '')
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def issue_session_token(account):
    """签发短期 HMAC 会话；只包含最小身份声明，不包含密码验证器。"""
    if not AUTH_SIGNING_SECRET:
        raise RuntimeError('gateway authentication is not configured')
    now = int(time.time())
    payload = {
        'sub': str(account.get('id') or account.get('studentId') or ''),
        'sid': str(account.get('studentId') or ''),
        'name': str(account.get('realName') or '')[:80],
        'role': str(account.get('role') or 'visitor'),
        'pwu': int(account.get('passwordUpdatedAt') or 0),
        'sv': int(account.get('sessionVersion') or 0),
        'iat': now,
        'exp': now + AUTH_SESSION_TTL_SECONDS,
        'jti': secrets.token_urlsafe(12),
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    body = _b64url_encode(raw)
    sig = hmac.new(
        AUTH_SIGNING_SECRET.encode('utf-8'),
        body.encode('ascii'),
        hashlib.sha256,
    ).digest()
    return body + '.' + _b64url_encode(sig), payload


def verify_session_token(token):
    if not AUTH_SIGNING_SECRET or not token or '.' not in str(token):
        return None
    try:
        body, signature = str(token).split('.', 1)
        expected = hmac.new(
            AUTH_SIGNING_SECRET.encode('utf-8'),
            body.encode('ascii'),
            hashlib.sha256,
        ).digest()
        provided = _b64url_decode(signature)
        if not hmac.compare_digest(provided, expected):
            return None
        payload = json.loads(_b64url_decode(body).decode('utf-8'))
        if int(payload.get('exp') or 0) <= int(time.time()):
            return None
        if not payload.get('sub') or payload.get('role') not in ('admin', 'leader', 'student', 'visitor'):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def _bearer_token(handler):
    auth = handler.headers.get('Authorization') or ''
    if auth.lower().startswith('bearer '):
        return auth[7:].strip()
    return ''


def check_gateway_session(handler, roles=None):
    payload = verify_session_token(_bearer_token(handler))
    if not payload:
        return None
    account = None
    try:
        account = _find_gateway_account(
            load_gateway_accounts(),
            payload.get('sid') or payload.get('sub'),
        )
    except Exception:
        account = None
    if AUTH_REQUIRED:
        if (
            not account
            or str(account.get('status') or 'active') != 'active'
            or str(account.get('role') or 'visitor') != str(payload.get('role') or '')
            or int(account.get('passwordUpdatedAt') or 0) != int(payload.get('pwu') or 0)
            or int(account.get('sessionVersion') or 0) != int(payload.get('sv') or 0)
        ):
            return None
    if roles and payload.get('role') not in set(roles):
        return None
    out = dict(payload)
    out['mustChangePwd'] = bool(account.get('mustChangePwd')) if account else False
    return out


def _password_change_required(handler, claims):
    if not claims or not bool(claims.get('mustChangePwd')):
        return False
    path = urllib.parse.urlparse(getattr(handler, 'path', '') or '').path
    return path.startswith('/api/') and path not in PASSWORD_CHANGE_ALLOWED_PATHS


def _auth_denied_response(handler):
    if getattr(handler, '_password_change_required', False):
        return 403, {
            'ok': False,
            'error': 'password change required',
            'code': 'password_change_required',
        }
    return 401, {'ok': False, 'error': 'valid session required'}


def check_token(handler):
    if check_gateway_session(handler, ('admin', 'leader')):
        return True
    if not MLOPS_TOKEN:
        return False
    token = handler.headers.get('X-MLOps-Token') or ''
    bearer = _bearer_token(handler)
    if bearer and not verify_session_token(bearer):
        token = bearer
    return secrets.compare_digest(str(token), str(MLOPS_TOKEN))


def check_upload_token(handler, roles=('admin', 'leader', 'student')):
    claims = check_gateway_session(handler, roles)
    if claims:
        return not _password_change_required(handler, claims)
    if AUTH_REQUIRED:
        return False
    if not ANNOTATION_UPLOAD_TOKEN:
        return False
    token = handler.headers.get('X-Upload-Token') or ''
    bearer = _bearer_token(handler)
    if bearer and not verify_session_token(bearer):
        token = bearer
    return secrets.compare_digest(str(token), str(ANNOTATION_UPLOAD_TOKEN))


def check_dataset_token(handler, roles=None):
    """所有文件写入/读取默认需要 token；仅可显式放开本机开发请求。"""
    if check_gateway_session(handler, roles):
        return True
    if AUTH_REQUIRED:
        return False
    if not DATASET_UPLOAD_TOKEN:
        client_ip = str((handler.client_address or ('',))[0] or '').strip().lower()
        is_loopback = client_ip in ('127.0.0.1', '::1', 'localhost')
        return bool(ALLOW_INSECURE_LOCAL_WRITES and is_loopback)
    token = handler.headers.get('X-Upload-Token') or handler.headers.get('X-Dataset-Token') or ''
    bearer = _bearer_token(handler)
    if bearer and not verify_session_token(bearer):
        token = bearer
    return secrets.compare_digest(str(token), str(DATASET_UPLOAD_TOKEN))


def _safe_dataset_id(value):
    tid = str(value or '').strip()
    if (
        not tid
        or len(tid) > DATASET_UPLOAD_ID_MAX_LENGTH
        or any(not (c.isalnum() or c in ('-', '_')) for c in tid)
    ):
        raise ValueError('invalid dataset/upload id')
    return tid


def _dataset_upload_lock(upload_id):
    """Return a process-local lock that serializes one upload lifecycle."""
    uid = _safe_dataset_id(upload_id)
    with _dataset_upload_locks_guard:
        lock = _dataset_upload_locks.get(uid)
        if lock is None:
            lock = threading.RLock()
            _dataset_upload_locks[uid] = lock
        return lock


def _normalize_dataset_actor(actor):
    value = str(actor or '').strip()
    if not value or len(value) > 200:
        raise ValueError('authenticated dataset owner is required')
    return value


def _dataset_layout(size, chunk_size):
    if isinstance(size, bool) or isinstance(chunk_size, bool):
        raise ValueError('dataset size and chunkSize must be integers')
    try:
        size_i = int(size)
        chunk_i = int(chunk_size)
    except (TypeError, ValueError) as exc:
        raise ValueError('dataset size and chunkSize must be integers') from exc
    if size_i <= 0 or size_i > MAX_DATASET_BYTES:
        raise ValueError('dataset size is outside the allowed range')
    if chunk_i < DATASET_MIN_CHUNK_BYTES or chunk_i > DATASET_MAX_CHUNK_BYTES:
        raise ValueError(
            'chunkSize must be between %s and %s bytes'
            % (DATASET_MIN_CHUNK_BYTES, DATASET_MAX_CHUNK_BYTES)
        )
    total_chunks = (size_i + chunk_i - 1) // chunk_i
    if total_chunks < 1 or total_chunks > DATASET_MAX_CHUNKS:
        raise ValueError('dataset requires too many chunks')
    return size_i, chunk_i, total_chunks


def _require_dataset_upload_access(meta, actor, role, *, allow_privileged=True):
    owner = str((meta or {}).get('owner') or '').strip()
    current_actor = _normalize_dataset_actor(actor)
    current_role = str(role or '').strip().lower()
    if owner and secrets.compare_digest(owner, current_actor):
        return
    if allow_privileged and current_role in ('admin', 'leader'):
        return
    raise PermissionError('dataset upload belongs to another user')


def _load_dataset_upload_meta(upload_id):
    uid = _safe_dataset_id(upload_id)
    meta = (_dataset_registry_load().get('uploads') or {}).get(uid)
    if not isinstance(meta, dict):
        raise FileNotFoundError('upload session not found')
    return uid, meta


def validate_dataset_chunk_request(
    upload_id,
    index,
    content_length,
    *,
    total_chunks=None,
    actor,
    role,
):
    """Validate an initialized, owned chunk before its request body is read."""
    uid, meta = _load_dataset_upload_meta(upload_id)
    _require_dataset_upload_access(meta, actor, role)
    size, chunk_size, expected_total = _dataset_layout(
        meta.get('size'),
        meta.get('chunkSize') or DATASET_CHUNK_SIZE,
    )
    stored_total = int(meta.get('totalChunks') or expected_total)
    if stored_total != expected_total:
        raise ValueError('upload session totalChunks does not match its size')
    if isinstance(index, bool):
        raise ValueError('chunk index must be an integer')
    try:
        index_i = int(index)
    except (TypeError, ValueError) as exc:
        raise ValueError('chunk index must be an integer') from exc
    if index_i < 0 or index_i >= expected_total:
        raise ValueError('chunk index is outside the initialized upload')
    if total_chunks is not None:
        if isinstance(total_chunks, bool):
            raise ValueError('totalChunks must be an integer')
        try:
            supplied_total = int(total_chunks)
        except (TypeError, ValueError) as exc:
            raise ValueError('totalChunks must be an integer') from exc
        if supplied_total != expected_total:
            raise ValueError('totalChunks does not match the initialized upload')
    if isinstance(content_length, bool):
        raise ValueError('chunk length must be an integer')
    try:
        length_i = int(content_length)
    except (TypeError, ValueError) as exc:
        raise ValueError('chunk length must be an integer') from exc
    offset = index_i * chunk_size
    expected_length = min(chunk_size, size - offset)
    if length_i != expected_length:
        raise ValueError(
            'chunk length mismatch: got %s expect %s'
            % (length_i, expected_length)
        )
    return {
        'uploadId': uid,
        'index': index_i,
        'totalChunks': expected_total,
        'size': size,
        'chunkSize': chunk_size,
        'offset': offset,
        'expectedLength': expected_length,
    }


def _dataset_registry_load():
    os.makedirs(DATASET_UPLOAD_ROOT, exist_ok=True)
    if not os.path.exists(DATASET_META_PATH):
        return {'files': {}, 'uploads': {}}
    try:
        with open(DATASET_META_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {'files': {}, 'uploads': {}}
        data.setdefault('files', {})
        data.setdefault('uploads', {})
        return data
    except Exception:
        return {'files': {}, 'uploads': {}}


def _dataset_registry_save(data):
    os.makedirs(DATASET_UPLOAD_ROOT, exist_ok=True)
    tmp = DATASET_META_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DATASET_META_PATH)


def _dataset_registry_update(mutator):
    """线程安全地读改写数据集登记簿。"""
    with _store_lock:
        reg = _dataset_registry_load()
        result = mutator(reg)
        _dataset_registry_save(reg)
        return result


def _dataset_upload_dir(upload_id):
    uid = _safe_dataset_id(upload_id)
    root = os.path.abspath(DATASET_UPLOAD_ROOT)
    target = os.path.abspath(os.path.join(root, '_tmp', uid))
    if not target.startswith(root + os.sep):
        raise ValueError('invalid upload path')
    return target


def _dataset_final_path(file_id, file_name=''):
    fid = _safe_dataset_id(file_id)
    ext = os.path.splitext(str(file_name or ''))[1].lower()
    if ext not in DATASET_ALLOWED_EXTENSIONS:
        ext = '.bin'
    root = os.path.abspath(DATASET_UPLOAD_ROOT)
    target = os.path.abspath(os.path.join(root, 'files', fid + ext))
    if not target.startswith(root + os.sep):
        raise ValueError('invalid file path')
    return target


def find_dataset_file_by_md5(md5):
    md5 = str(md5 or '').strip().lower()
    if not md5:
        return None
    reg = _dataset_registry_load()
    for fid, meta in (reg.get('files') or {}).items():
        if str(meta.get('md5') or '').lower() == md5 and os.path.isfile(meta.get('path') or ''):
            return dict(meta, fileId=fid)
    return None


def _remove_dataset_upload_dir(upload_id):
    up_dir = _dataset_upload_dir(upload_id)
    if not os.path.isdir(up_dir):
        return 0
    removed = 0
    for name in os.listdir(up_dir):
        path = os.path.join(up_dir, name)
        try:
            if os.path.isfile(path):
                removed += os.path.getsize(path)
            os.remove(path)
        except OSError:
            try:
                import shutil
                shutil.rmtree(path, ignore_errors=True)
            except Exception:
                pass
    try:
        os.rmdir(up_dir)
    except OSError:
        pass
    return removed


def abort_dataset_upload(upload_id, *, actor, role):
    """取消未完成上传并删除临时分片（成功入库的文件不动）。"""
    uid = _safe_dataset_id(upload_id)
    with _dataset_upload_lock(uid):
        def _mutate(reg):
            meta = (reg.get('uploads') or {}).get(uid)
            if not isinstance(meta, dict):
                raise FileNotFoundError('upload session not found')
            _require_dataset_upload_access(meta, actor, role)
            bytes_removed = _remove_dataset_upload_dir(uid)
            reg.setdefault('uploads', {}).pop(uid, None)
            return bytes_removed

        bytes_removed = _dataset_registry_update(_mutate)
    return {
        'ok': True,
        'uploadId': uid,
        'removed': True,
        'bytesRemoved': bytes_removed,
    }


def purge_incomplete_dataset_uploads(md5=None, size=None, *, actor, role):
    """清理未完成会话。md5/size 给定时只清匹配项，否则清全部未完成。"""
    if str(role or '').strip().lower() != 'admin':
        raise PermissionError('administrator role required to purge uploads')
    admin_actor = _normalize_dataset_actor(actor)
    md5 = str(md5 or '').strip().lower()
    size_i = int(size) if size not in (None, '') else None
    reg = _dataset_registry_load()
    targets = []
    for uid, umeta in list((reg.get('uploads') or {}).items()):
        if not isinstance(umeta, dict):
            targets.append(uid)
            continue
        if md5 and str(umeta.get('md5') or '').lower() != md5:
            continue
        if size_i is not None and int(umeta.get('size') or 0) != size_i:
            continue
        targets.append(uid)

    # 磁盘上有、登记簿没有的孤儿目录也清掉
    tmp_root = os.path.join(DATASET_UPLOAD_ROOT, '_tmp')
    if os.path.isdir(tmp_root):
        for name in os.listdir(tmp_root):
            if name not in targets:
                if md5:
                    # 指定 md5 时不误删无关孤儿
                    continue
                targets.append(name)

    purged = []
    total_bytes = 0
    for uid in targets:
        try:
            info = abort_dataset_upload(
                uid,
                actor=admin_actor,
                role='admin',
            )
            total_bytes += int(info.get('bytesRemoved') or 0)
            purged.append(uid)
        except FileNotFoundError:
            try:
                total_bytes += _remove_dataset_upload_dir(uid)
                purged.append(uid)
            except Exception:
                continue

            def _drop_orphan(reg2, orphan_id=uid):
                reg2.setdefault('uploads', {}).pop(orphan_id, None)

            _dataset_registry_update(_drop_orphan)
    return {'ok': True, 'purged': purged, 'count': len(purged), 'bytesRemoved': total_bytes}


def init_dataset_upload(payload, *, actor, role):
    if not isinstance(payload, dict):
        raise ValueError('dataset initialization requires a JSON object')
    owner = _normalize_dataset_actor(actor)
    file_name = str(payload.get('fileName') or payload.get('name') or 'dataset.bin')
    size, chunk_size, total_chunks = _dataset_layout(
        payload.get('size') or 0,
        payload.get('chunkSize') or DATASET_CHUNK_SIZE,
    )
    md5 = str(payload.get('md5') or '').strip().lower()
    ext = os.path.splitext(file_name.lower())[1]
    if not ext:
        raise ValueError('文件缺少扩展名，请使用 .csv / .json / .zip 等格式')
    if ext not in DATASET_ALLOWED_EXTENSIONS:
        raise ValueError('不支持的文件扩展名：%s' % ext)

    existing = find_dataset_file_by_md5(md5) if md5 else None
    if existing:
        return {
            'uploadId': existing.get('fileId'),
            'fileId': existing.get('fileId'),
            'exists': True,
            'instant': True,
            'size': existing.get('size'),
            'md5': existing.get('md5'),
            'path': existing.get('savedAs'),
            'uploadedChunks': [],
            'chunkSize': chunk_size,
            'totalChunks': total_chunks,
        }

    upload_id = _safe_dataset_id(payload.get('uploadId') or ('up_' + secrets.token_hex(8)))
    with _dataset_upload_lock(upload_id):
        up_dir = _dataset_upload_dir(upload_id)
        assembled_path = os.path.join(up_dir, 'assembled.bin')

        def _mutate(reg):
            current = (reg.get('uploads') or {}).get(upload_id)
            if isinstance(current, dict):
                _require_dataset_upload_access(current, owner, role)
                current_size, current_chunk, current_total = _dataset_layout(
                    current.get('size'),
                    current.get('chunkSize') or DATASET_CHUNK_SIZE,
                )
                if (
                    current_size != size
                    or current_chunk != chunk_size
                    or current_total != total_chunks
                    or str(current.get('fileName') or '') != file_name
                    or str(current.get('md5') or '').lower() != md5
                ):
                    raise ValueError('uploadId is already initialized with different metadata')
                if not current.get('owner'):
                    current['owner'] = owner
                    reg['uploads'][upload_id] = current
                return {
                    'uploadId': upload_id,
                    'exists': False,
                    'instant': False,
                    'uploadedChunks': list(current.get('received') or []),
                    'chunkSize': current_chunk,
                    'totalChunks': current_total,
                    'size': current_size,
                    'md5': str(current.get('md5') or ''),
                }
            if os.path.exists(assembled_path):
                raise ValueError('uploadId already has unregistered temporary data')
            os.makedirs(up_dir, exist_ok=True)
            with open(assembled_path, 'wb') as preallocated:
                preallocated.truncate(size)
                preallocated.flush()
                os.fsync(preallocated.fileno())
            now = _now_iso()
            reg.setdefault('uploads', {})[upload_id] = {
                'uploadId': upload_id,
                'fileName': file_name,
                'size': size,
                'md5': md5,
                'chunkSize': chunk_size,
                'totalChunks': total_chunks,
                'owner': owner,
                'createdAt': now,
                'updatedAt': now,
                'received': [],
            }
            return {
                'uploadId': upload_id,
                'exists': False,
                'instant': False,
                'uploadedChunks': [],
                'chunkSize': chunk_size,
                'totalChunks': total_chunks,
                'size': size,
                'md5': md5,
            }

        return _dataset_registry_update(_mutate)


def save_dataset_chunk(
    upload_id,
    index,
    content,
    total_chunks=None,
    *,
    actor,
    role,
):
    uid = _safe_dataset_id(upload_id)
    with _dataset_upload_lock(uid):
        request_meta = validate_dataset_chunk_request(
            uid,
            index,
            len(content),
            total_chunks=total_chunks,
            actor=actor,
            role=role,
        )
        up_dir = _dataset_upload_dir(uid)
        assembled_path = os.path.join(up_dir, 'assembled.bin')
        if not os.path.isfile(assembled_path):
            raise FileNotFoundError('initialized upload data is missing')
        with open(assembled_path, 'r+b') as f:
            f.seek(request_meta['offset'])
            f.write(content)
            f.flush()
            os.fsync(f.fileno())

        def _mutate(reg):
            meta = (reg.get('uploads') or {}).get(uid)
            if not isinstance(meta, dict):
                raise FileNotFoundError('upload session not found')
            _require_dataset_upload_access(meta, actor, role)
            received = {
                int(item)
                for item in (meta.get('received') or [])
                if not isinstance(item, bool)
            }
            received.add(request_meta['index'])
            meta['received'] = sorted(received)
            meta['totalChunks'] = request_meta['totalChunks']
            meta['updatedAt'] = _now_iso()
            reg['uploads'][uid] = meta
            return {
                'ok': True,
                'index': request_meta['index'],
                'received': len(meta['received']),
                'bytes': len(content),
            }

        return _dataset_registry_update(_mutate)


def complete_dataset_upload(payload, *, actor, role):
    if not isinstance(payload, dict):
        raise ValueError('dataset completion requires a JSON object')
    upload_id = _safe_dataset_id(payload.get('uploadId'))
    with _dataset_upload_lock(upload_id):
        _, meta = _load_dataset_upload_meta(upload_id)
        _require_dataset_upload_access(meta, actor, role)
        expect_size, chunk_size, expected_total = _dataset_layout(
            meta.get('size'),
            meta.get('chunkSize') or DATASET_CHUNK_SIZE,
        )
        stored_total = int(meta.get('totalChunks') or expected_total)
        if stored_total != expected_total:
            raise ValueError('upload session totalChunks does not match its size')

        initialized_name = str(meta.get('fileName') or 'dataset.bin')
        supplied_name = payload.get('fileName')
        if supplied_name not in (None, '') and str(supplied_name) != initialized_name:
            raise ValueError('fileName does not match the initialized upload')
        file_name = initialized_name
        supplied_size = payload.get('size')
        if supplied_size not in (None, '') and int(supplied_size) != expect_size:
            raise ValueError('size does not match the initialized upload')
        initialized_md5 = str(meta.get('md5') or '').strip().lower()
        supplied_md5 = str(payload.get('md5') or '').strip().lower()
        if initialized_md5 and supplied_md5 and initialized_md5 != supplied_md5:
            raise ValueError('md5 does not match the initialized upload')
        expect_md5 = initialized_md5 or supplied_md5

        received = set()
        for raw_index in meta.get('received') or []:
            if isinstance(raw_index, bool):
                raise ValueError('upload session contains an invalid chunk index')
            try:
                parsed_index = int(raw_index)
            except (TypeError, ValueError) as exc:
                raise ValueError('upload session contains an invalid chunk index') from exc
            if parsed_index < 0 or parsed_index >= expected_total:
                raise ValueError('upload session contains an out-of-range chunk index')
            received.add(parsed_index)
        if not received:
            raise ValueError('no chunks uploaded')
        if len(received) != expected_total:
            missing_preview = []
            for chunk_index in range(expected_total):
                if chunk_index not in received:
                    missing_preview.append(chunk_index)
                    if len(missing_preview) >= 20:
                        break
            raise ValueError('missing chunks: %s' % missing_preview)

        up_dir = _dataset_upload_dir(upload_id)
        assembled_path = os.path.join(up_dir, 'assembled.bin')
        if not os.path.isfile(assembled_path):
            raise FileNotFoundError('assembled file missing')

        # 直写模式：分片已落到最终位置，这里只顺序读取校验，不构造第二份大文件。
        hasher = hashlib.md5()
        written = 0
        with open(assembled_path, 'rb') as inp:
            for buf in iter(lambda: inp.read(1024 * 1024), b''):
                hasher.update(buf)
                written += len(buf)
        actual_md5 = hasher.hexdigest()
        if written != expect_size:
            raise ValueError('size mismatch: got %s expect %s' % (written, expect_size))
        # 前端对 >8MB 文件用轻量指纹，仅当双方都是 32 位 hex 时才强制 md5 校验。
        if (
            expect_md5
            and len(expect_md5) == 32
            and all(c in '0123456789abcdef' for c in expect_md5)
            and actual_md5 != expect_md5
        ):
            raise ValueError('md5 mismatch')

        # 内容安全：文件头魔数（512B）+ 可选 ClamAV，均在改名入库前拦截。
        with open(assembled_path, 'rb') as sniff_file:
            sniff_allowed_upload(sniff_file.read(512), file_name)
        enforce_clamav_scan(assembled_path, context='dataset_complete')

        file_id = _safe_dataset_id(payload.get('fileId') or ('dsf_' + secrets.token_hex(8)))
        current_registry = _dataset_registry_load()
        if file_id in (current_registry.get('files') or {}):
            raise ValueError('fileId already exists')
        final_path = _dataset_final_path(file_id, file_name)
        if os.path.exists(final_path):
            raise ValueError('dataset destination already exists')
        os.makedirs(os.path.dirname(final_path), exist_ok=True)
        os.replace(assembled_path, final_path)

        inspect = inspect_dataset_file(final_path, file_name)
        file_meta = {
            'fileId': file_id,
            'fileName': file_name,
            'size': written,
            'md5': actual_md5,
            'path': final_path,
            'savedAs': os.path.relpath(final_path, DATASET_UPLOAD_ROOT).replace('\\', '/'),
            'createdAt': _now_iso(),
            'chunkSize': chunk_size,
            'owner': str(meta.get('owner') or actor),
            'inspect': inspect,
        }

        def _finalize(reg):
            current = (reg.get('uploads') or {}).get(upload_id)
            if not isinstance(current, dict):
                raise FileNotFoundError('upload session not found')
            _require_dataset_upload_access(current, actor, role)
            if file_id in (reg.get('files') or {}):
                raise ValueError('fileId already exists')
            reg.setdefault('files', {})[file_id] = file_meta
            reg.setdefault('uploads', {}).pop(upload_id, None)

        _dataset_registry_update(_finalize)

        try:
            for name in os.listdir(up_dir):
                os.remove(os.path.join(up_dir, name))
            os.rmdir(up_dir)
        except OSError:
            pass

        return {
            'ok': True,
            'fileId': file_id,
            'size': written,
            'md5': actual_md5,
            'savedAs': file_meta['savedAs'],
            'inspect': inspect,
        }


def get_dataset_upload_status(upload_id, *, actor, role):
    upload_id = _safe_dataset_id(upload_id)
    reg = _dataset_registry_load()
    meta = reg['uploads'].get(upload_id)
    if not isinstance(meta, dict):
        raise FileNotFoundError('upload session not found')
    _require_dataset_upload_access(meta, actor, role)
    size, chunk_size, total_chunks = _dataset_layout(
        meta.get('size'),
        meta.get('chunkSize') or DATASET_CHUNK_SIZE,
    )
    return {
        'ok': True,
        'uploadId': upload_id,
        'uploadedChunks': meta.get('received') or [],
        'size': size,
        'md5': meta.get('md5'),
        'fileName': meta.get('fileName'),
        'chunkSize': chunk_size,
        'totalChunks': total_chunks,
    }


def get_dataset_file_meta(file_id):
    file_id = _safe_dataset_id(file_id)
    reg = _dataset_registry_load()
    meta = reg['files'].get(file_id)
    if not meta or not os.path.isfile(meta.get('path') or ''):
        raise FileNotFoundError('dataset file not found')
    return meta


def inspect_dataset_file(path, file_name=''):
    """解析数据集文件元数据：表格行数 / ZIP 内图像与标注统计。"""
    import zipfile
    name = file_name or os.path.basename(path)
    ext = os.path.splitext(name.lower())[1]
    result = {
        'format': (ext[1:] if ext else 'bin').upper(),
        'fileName': name,
        'size': os.path.getsize(path) if os.path.isfile(path) else 0,
        'sampleCount': 0,
        'fieldCount': 0,
        'imageCount': 0,
        'labelCount': 0,
        'classCount': 0,
        'classes': [],
        'sampleImages': [],
        'labelFiles': [],
        'dataType': 'table',
        'annoTypeHint': 'none',
        'note': '',
    }
    try:
        if ext in ('.csv', '.tsv', '.txt'):
            sep = '\t' if ext == '.tsv' else ','
            preview_lines = []
            count = 0
            huge = result['size'] > 1024 * 1024 * 1024  # >1GB 跳过全量行数统计，避免再全量读一遍
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i < 101:
                        preview_lines.append(line.rstrip('\n'))
                    if huge and i >= 101:
                        break
                    count = i + 1
            result['sampleCount'] = 0 if huge else max(0, count - 1)
            if preview_lines:
                cols = [c.strip().strip('"') for c in preview_lines[0].split(sep)]
                result['fieldCount'] = len(cols)
                result['preview'] = {
                    'columns': cols,
                    'rows': [
                        [c.strip().strip('"') for c in row.split(sep)]
                        for row in preview_lines[1:21]
                    ],
                }
            result['dataType'] = 'table'
            result['note'] = '超大文件：仅预览前 100 行，未统计总记录数' if huge else 'CSV/TSV 已统计记录数与字段'
        elif ext == '.json':
            if result['size'] > 256 * 1024 * 1024:
                result['note'] = '超大 JSON（>256MB）：跳过全量解析以防内存溢出'
            else:
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    data = json.load(f)
                if isinstance(data, list):
                    result['sampleCount'] = len(data)
                    if data and isinstance(data[0], dict):
                        cols = list(data[0].keys())
                        result['fieldCount'] = len(cols)
                        result['preview'] = {
                            'columns': cols,
                            'rows': [[row.get(c) for c in cols] for row in data[:20]],
                        }
                elif isinstance(data, dict) and isinstance(data.get('images'), list):
                    result['sampleCount'] = len(data['images'])
                    result['imageCount'] = len(data['images'])
                    result['dataType'] = 'image'
                result['note'] = 'JSON 已解析'
        elif ext == '.zip':
            result['dataType'] = 'image'
            img_exts = {'.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif'}
            label_exts = {'.xml', '.json', '.txt', '.yaml', '.yml'}
            classes = set()
            with zipfile.ZipFile(path, 'r') as zf:
                names = [n for n in zf.namelist() if not n.endswith('/')]
                images = [n for n in names if os.path.splitext(n.lower())[1] in img_exts]
                labels = [n for n in names if os.path.splitext(n.lower())[1] in label_exts]
                result['imageCount'] = len(images)
                result['labelCount'] = len(labels)
                result['sampleCount'] = len(images) or len(names)
                result['sampleImages'] = images[:20]
                result['labelFiles'] = labels[:20]
                # 粗略从路径推断类别
                for n in images:
                    parts = n.replace('\\', '/').split('/')
                    if len(parts) >= 2:
                        classes.add(parts[-2])
                # YOLO labels: class id in txt
                for lf in labels[:50]:
                    if not lf.lower().endswith('.txt'):
                        continue
                    try:
                        raw = zf.read(lf).decode('utf-8', errors='ignore')
                        for line in raw.splitlines()[:20]:
                            tid = line.strip().split(' ')[0]
                            if tid.isdigit():
                                classes.add('class_' + tid)
                    except Exception:
                        pass
                if labels:
                    result['annoTypeHint'] = 'detection'
            result['classes'] = sorted(classes)[:50]
            result['classCount'] = len(result['classes'])
            result['note'] = 'ZIP 已统计图像/标注/类别'
        elif ext in ('.jpg', '.jpeg', '.png', '.bmp', '.webp'):
            result['dataType'] = 'image'
            result['imageCount'] = 1
            result['sampleCount'] = 1
            result['sampleImages'] = [name]
        elif ext == '.xml':
            result['dataType'] = 'image'
            result['annoTypeHint'] = 'detection'
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                text = f.read(800000)
            result['sampleCount'] = text.lower().count('<object')
            result['labelCount'] = 1
            result['note'] = 'XML 标注文件'
    except Exception as e:
        result['note'] = 'inspect failed: %s' % e
    return result


def read_dataset_zip_sample(file_id, member_path, max_bytes=3 * 1024 * 1024):
    import zipfile
    meta = get_dataset_file_meta(file_id)
    path = meta.get('path')
    member_path = str(member_path or '').replace('\\', '/')
    if not member_path or '..' in member_path.split('/'):
        raise ValueError('invalid member path')
    with zipfile.ZipFile(path, 'r') as zf:
        info = zf.getinfo(member_path)
        if info.file_size > max_bytes:
            raise ValueError('sample too large')
        data = zf.read(member_path)
    ext = os.path.splitext(member_path.lower())[1]
    mime = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif',
        '.xml': 'application/xml', '.json': 'application/json', '.txt': 'text/plain',
    }.get(ext, 'application/octet-stream')
    return data, mime, os.path.basename(member_path)


# ---------- 团队共享文件库：磁盘落盘 ----------
def _shared_registry_load():
    os.makedirs(SHARED_FILE_UPLOAD_ROOT, exist_ok=True)
    if not os.path.exists(SHARED_FILE_META_PATH):
        return {'files': {}}
    try:
        with open(SHARED_FILE_META_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {'files': {}}
        data.setdefault('files', {})
        return data
    except Exception:
        return {'files': {}}


def _shared_registry_save(data):
    os.makedirs(SHARED_FILE_UPLOAD_ROOT, exist_ok=True)
    tmp = SHARED_FILE_META_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SHARED_FILE_META_PATH)


def _content_disposition(filename, disposition='attachment'):
    """构造 Content-Disposition，兼容中文/非 ASCII 文件名（RFC 5987）。
    HTTP 响应头按 latin-1 编码，非 ASCII 文件名直接放入会让 send_header 抛错、
    导致响应头体错乱（浏览器报 ERR_CONTENT_LENGTH_MISMATCH / 协议冲突）。
    这里输出纯 ASCII：filename 兜底 + filename* 承载 UTF-8 百分号编码真实名。"""
    name = str(filename or 'download')
    ascii_name = name.encode('ascii', 'ignore').decode('ascii').replace('"', '').replace('\\', '').strip() or 'download'
    utf8_name = urllib.parse.quote(name, safe='')
    return "%s; filename=\"%s\"; filename*=UTF-8''%s" % (disposition, ascii_name, utf8_name)


def _stream_minio_download(handler, client, object_key, filename):
    """Stream a MinIO object with bounded memory instead of buffering it."""
    stat = client.stat_object(MINIO_BUCKET, object_key)
    object_size = int(getattr(stat, 'size', 0) or 0)
    response = client.get_object(MINIO_BUCKET, object_key)
    response_started = False
    try:
        handler.send_response(200)
        response_started = True
        handler.send_header('Content-Type', 'application/octet-stream')
        handler.send_header('Content-Length', str(object_size))
        handler.send_header('Content-Disposition', _content_disposition(filename))
        handler._cors()
        handler.end_headers()
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handler.wfile.write(chunk)
        return True
    except (BrokenPipeError, ConnectionResetError):
        handler.close_connection = True
        return False
    except Exception:
        if not response_started:
            raise
        handler.close_connection = True
        logger.exception('minio download stream failed for object=%s', object_key)
        return False
    finally:
        close = getattr(response, 'close', None)
        if callable(close):
            close()
        release = getattr(response, 'release_conn', None)
        if callable(release):
            release()


def save_shared_upload(file_name, file_type, remark, content, original_name=''):
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError('file too large: max %s bytes' % MAX_UPLOAD_BYTES)
    ext = os.path.splitext(str(original_name or file_name).lower())[1]
    allow = DATASET_ALLOWED_EXTENSIONS | ALLOWED_UPLOAD_EXTENSIONS | {'.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.zip', '.pdf'}
    if ext and ext not in allow:
        raise ValueError('file extension not allowed: %s' % ext)
    sniff_allowed_upload(content, original_name or file_name)
    file_id = 'sf_' + secrets.token_hex(8)
    date_path = datetime.now().strftime('%Y%m')
    safe_name = ''.join(c for c in (file_name or 'file') if c not in '\\/:*?"<>|')[:120] or 'file'
    stored = file_id + (ext or '.bin')
    md5 = hashlib.md5(content).hexdigest()
    meta = {
        'fileId': file_id,
        'fileName': safe_name,
        'originalName': original_name or safe_name,
        'fileType': file_type or 'other',
        'remark': remark or '',
        'size': len(content),
        'md5': md5,
        'createdAt': _now_iso(),
        'deleted': False,
        'storage': 'local',
    }
    client = _get_minio_client()
    if client:
        object_key = 'shared/%s/%s' % (date_path, stored)
        try:
            import io
            client.put_object(
                MINIO_BUCKET,
                object_key,
                io.BytesIO(content),
                length=len(content),
                content_type='application/octet-stream',
            )
            meta['storage'] = 'minio'
            meta['objectKey'] = object_key
            meta['bucket'] = MINIO_BUCKET
            meta['path'] = ''
            meta['savedAs'] = object_key
        except Exception as e:
            logging.warning('MinIO put failed, fallback local: %s', e)
            client = None
    if meta['storage'] != 'minio':
        rel_dir = os.path.join('files', date_path)
        abs_dir = os.path.join(SHARED_FILE_UPLOAD_ROOT, rel_dir)
        os.makedirs(abs_dir, exist_ok=True)
        full = os.path.join(abs_dir, stored)
        with open(full, 'wb') as f:
            f.write(content)
        meta['path'] = full
        meta['savedAs'] = os.path.relpath(full, SHARED_FILE_UPLOAD_ROOT).replace('\\', '/')
        enforce_clamav_scan(full, context='shared_upload')
    with _shared_registry_lock:
        reg = _shared_registry_load()
        reg['files'][file_id] = meta
        _shared_registry_save(reg)
    return meta


def get_shared_file_meta(file_id, allow_deleted=False):
    file_id = _safe_dataset_id(file_id)
    with _shared_registry_lock:
        reg = _shared_registry_load()
        meta = dict(reg['files'].get(file_id) or {})
    if not meta:
        raise FileNotFoundError('shared file not found')
    if meta.get('pendingConfirm'):
        raise FileNotFoundError('shared file not confirmed')
    if meta.get('deletedAt') and not allow_deleted:
        raise FileNotFoundError('shared file deleted')
    path = meta.get('path') or ''
    if meta.get('storage') == 'minio':
        return meta
    if not path or not os.path.isfile(path):
        raise FileNotFoundError('shared file not found')
    return meta


def soft_delete_shared_file(file_id):
    file_id = _safe_dataset_id(file_id)
    with _shared_registry_lock:
        reg = _shared_registry_load()
        meta = reg['files'].get(file_id)
        if not meta:
            raise FileNotFoundError('shared file not found')
        meta['deletedAt'] = _now_iso()
        meta['deleted'] = True
        reg['files'][file_id] = meta
        _shared_registry_save(reg)
        return dict(meta)


def restore_shared_file(file_id):
    file_id = _safe_dataset_id(file_id)
    with _shared_registry_lock:
        reg = _shared_registry_load()
        meta = reg['files'].get(file_id)
        if not meta:
            raise FileNotFoundError('shared file not found')
        meta.pop('deletedAt', None)
        meta['deleted'] = False
        reg['files'][file_id] = meta
        _shared_registry_save(reg)
        return dict(meta)


def purge_shared_file(file_id):
    """物理删除：磁盘/MinIO + 注册表。"""
    file_id = _safe_dataset_id(file_id)
    with _shared_registry_lock:
        reg = _shared_registry_load()
        meta = reg['files'].pop(file_id, None)
        if not meta:
            raise FileNotFoundError('shared file not found')
        _shared_registry_save(reg)
    path = meta.get('path') or ''
    if path and os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass
    if meta.get('storage') == 'minio' and meta.get('objectKey'):
        try:
            client = _get_minio_client()
            if client:
                client.remove_object(MINIO_BUCKET, meta['objectKey'])
        except Exception as e:
            logging.warning('minio purge failed: %s', e)
    return {'fileId': file_id, 'purged': True}


def _get_minio_client():
    global _minio_client, _minio_init_tried
    if SHARED_STORAGE_BACKEND != 'minio':
        return None
    if _minio_client is not None:
        return _minio_client
    if _minio_init_tried:
        return None
    _minio_init_tried = True
    if not (MINIO_ENDPOINT and MINIO_ACCESS_KEY and MINIO_SECRET_KEY):
        logging.warning('SHARED_STORAGE_BACKEND=minio but credentials incomplete; fallback local')
        return None
    try:
        from minio import Minio  # type: ignore
        endpoint = MINIO_ENDPOINT.replace('https://', '').replace('http://', '')
        client = Minio(
            endpoint,
            access_key=MINIO_ACCESS_KEY,
            secret_key=MINIO_SECRET_KEY,
            secure=MINIO_SECURE,
            region=MINIO_REGION or None,
        )
        if not client.bucket_exists(MINIO_BUCKET):
            client.make_bucket(MINIO_BUCKET)
        _minio_client = client
        logging.info('MinIO client ready: bucket=%s', MINIO_BUCKET)
        return _minio_client
    except Exception as e:
        logging.warning('MinIO init failed (%s); fallback local disk', e)
        return None


def _shared_allow_extensions():
    return DATASET_ALLOWED_EXTENSIONS | ALLOWED_UPLOAD_EXTENSIONS | {
        '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.zip', '.pdf',
    }


def _rewrite_presign_url(url):
    """把内网 MinIO 地址改写成经 Nginx /minio-upload/ 的对外前缀。"""
    if not MINIO_PUBLIC_UPLOAD_PREFIX or not url:
        return url
    try:
        parsed = urllib.parse.urlparse(url)
        path = parsed.path or ''
        return '%s%s%s' % (
            MINIO_PUBLIC_UPLOAD_PREFIX,
            path if path.startswith('/') else '/' + path,
            ('?' + parsed.query) if parsed.query else '',
        )
    except Exception:
        return url


def _presign_https_ok():
    """P2：仅当对外前缀为 HTTPS（或显式放开内网测试）时才允许预签名直传。
    否则应回退网关代理上传，避免浏览器拿到明文 / 前缀不匹配的直传 URL。"""
    return MINIO_PUBLIC_UPLOAD_PREFIX.lower().startswith('https://') or MINIO_ALLOW_INSECURE_PRESIGN


def _dir_size_and_count(root):
    """统计目录下所有文件的总字节与数量（跳过注册表文件）。"""
    total = 0
    count = 0
    if not os.path.isdir(root):
        return 0, 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name == '_registry.json':
                continue
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
                count += 1
            except OSError:
                pass
    return total, count


def compute_storage_usage():
    """全系统存储用量聚合：共享文件 + 数据集 + 标注（协同底座，服务端真值）。"""
    shared_bytes = shared_count = 0
    try:
        for meta in (_shared_registry_load().get('files') or {}).values():
            if meta.get('deletedAt') or meta.get('pendingConfirm'):
                continue
            shared_bytes += int(meta.get('size') or 0)
            shared_count += 1
    except Exception:
        pass
    dataset_bytes = dataset_count = 0
    try:
        for meta in (_dataset_registry_load().get('files') or {}).values():
            dataset_bytes += int(meta.get('size') or 0)
            dataset_count += 1
    except Exception:
        pass
    anno_bytes, anno_count = _dir_size_and_count(ANNOTATION_UPLOAD_ROOT)
    return {
        'shared': {'bytes': shared_bytes, 'count': shared_count},
        'datasets': {'bytes': dataset_bytes, 'count': dataset_count},
        'annotations': {'bytes': anno_bytes, 'count': anno_count},
        'appTotalBytes': shared_bytes + dataset_bytes + anno_bytes,
    }


def create_shared_presign(file_name, file_type, remark, size, content_type='', original_name='', owner=''):
    """签发 MinIO PUT 预签名；文件体不经网关。未启用 minio 时抛错，前端可回退 multipart。"""
    size = int(size or 0)
    if size <= 0:
        raise ValueError('文件大小无效（不能为 0）')
    if size > MINIO_PRESIGN_MAX_BYTES:
        raise ValueError('文件过大：最大允许 %s 字节' % MINIO_PRESIGN_MAX_BYTES)
    if size > SINGLE_PUT_MAX_BYTES:
        raise ValueError('单文件超过 5GB，共享文件直传不支持（S3 单次 PUT 上限）；请改用「数据集资源库」分片上传')
    client = _get_minio_client()
    if not client:
        raise RuntimeError('对象存储未就绪：请检查 MinIO 配置')
    if not _presign_https_ok():
        # P2：未配置 HTTPS 对外前缀时禁用直传，交由前端回退网关 multipart 代理上传。
        raise RuntimeError('presign_disabled_insecure：未配置 HTTPS 对外前缀，已回退网关代理上传')
    name = original_name or file_name or 'file'
    ext = os.path.splitext(str(name).lower())[1]
    if ext and ext not in _shared_allow_extensions():
        raise ValueError('file extension not allowed: %s' % ext)
    file_id = 'sf_' + secrets.token_hex(8)
    date_path = datetime.now().strftime('%Y%m')
    safe_name = ''.join(c for c in (file_name or 'file') if c not in '\\/:*?"<>|')[:120] or 'file'
    stored = file_id + (ext or '.bin')
    object_key = 'shared/%s/%s' % (date_path, stored)
    expire = max(60, min(MINIO_PRESIGN_EXPIRE, 900))
    ctype = (content_type or 'application/octet-stream').strip() or 'application/octet-stream'
    upload_url = client.presigned_put_object(
        MINIO_BUCKET,
        object_key,
        expires=timedelta(seconds=expire),
    )
    upload_url = _rewrite_presign_url(upload_url)
    meta = {
        'fileId': file_id,
        'fileName': safe_name,
        'originalName': name,
        'fileType': file_type or 'other',
        'remark': remark or '',
        'owner': str(owner or '')[:120],
        'size': size,
        'md5': '',
        'createdAt': _now_iso(),
        'deleted': False,
        'storage': 'minio',
        'objectKey': object_key,
        'bucket': MINIO_BUCKET,
        'path': '',
        'savedAs': object_key,
        'pendingConfirm': True,
        'contentType': ctype,
        'presignExpiresAt': (datetime.now(timezone.utc) + timedelta(seconds=expire)).astimezone().strftime('%Y-%m-%d %H:%M:%S'),
    }
    with _shared_registry_lock:
        reg = _shared_registry_load()
        reg['files'][file_id] = meta
        _shared_registry_save(reg)
    return {
        'fileId': file_id,
        'objectKey': object_key,
        'bucket': MINIO_BUCKET,
        'uploadUrl': upload_url,
        'expiresIn': expire,
        'headers': {'Content-Type': ctype},
        'method': 'PUT',
    }


def confirm_shared_presign(file_id, md5='', size=None, owner=''):
    """直传完成后确认：校验对象存在、归属与文件头，再写入注册表。"""
    file_id = _safe_dataset_id(file_id)
    with _shared_registry_lock:
        reg = _shared_registry_load()
        meta = dict(reg['files'].get(file_id) or {})
    if not meta:
        raise FileNotFoundError('shared file not found')
    if not meta.get('pendingConfirm'):
        return meta
    # P2：仅允许本人确认本人签发的预签名（双方都带 owner 时强校验，记入审计）。
    if meta.get('owner') and owner and not secrets.compare_digest(str(owner), str(meta.get('owner'))):
        raise PermissionError('presign owner mismatch')
    client = _get_minio_client()
    if not client:
        raise RuntimeError('minio unavailable')
    object_key = meta.get('objectKey') or ''
    if not object_key:
        raise ValueError('missing objectKey')
    try:
        stat = client.stat_object(MINIO_BUCKET, object_key)
    except Exception as e:
        raise FileNotFoundError('object not uploaded yet: %s' % e)
    # P2/四：直传字节不经网关，此处按文件头魔数兜底校验（只取前若干字节，
    # 避免大文件全量下载）；识别为 HTML/脚本/webshell 等危险内容则删对象并拒绝。
    try:
        resp = client.get_object(MINIO_BUCKET, object_key, offset=0, length=512)
        try:
            head = resp.read()
        finally:
            resp.close()
            resp.release_conn()
    except Exception as e:
        head = None
        logging.warning('presign head sniff skipped (%s): %s', object_key, e)
    if head:
        try:
            sniff_allowed_upload(head, meta.get('originalName') or meta.get('fileName') or object_key)
        except Exception as e:
            try:
                client.remove_object(MINIO_BUCKET, object_key)
            except Exception:
                pass
            with _shared_registry_lock:
                latest_reg = _shared_registry_load()
                latest_reg['files'].pop(file_id, None)
                _shared_registry_save(latest_reg)
            audit_event('shared_presign_sniff_reject', fileId=file_id, error=str(e))
            raise ValueError('uploaded content rejected by content sniff: %s' % e)
    actual_size = int(getattr(stat, 'size', 0) or 0)
    expected = int(meta.get('size') or 0)
    oversized = (
        actual_size > MINIO_PRESIGN_MAX_BYTES
        or (expected > 0 and actual_size > expected)
    )
    if oversized:
        try:
            client.remove_object(MINIO_BUCKET, object_key)
        except Exception:
            pass
        with _shared_registry_lock:
            reg = _shared_registry_load()
            reg['files'].pop(file_id, None)
            _shared_registry_save(reg)
        audit_event(
            'shared_presign_size_reject',
            fileId=file_id,
            expected=expected,
            actual=actual_size,
        )
        raise ValueError('uploaded object size mismatch or too large')
    meta['size'] = actual_size or expected
    if md5:
        meta['md5'] = str(md5).strip().lower()
    meta['pendingConfirm'] = False
    meta['confirmedAt'] = _now_iso()
    if size is not None:
        try:
            meta['reportedSize'] = int(size)
        except Exception:
            pass
    with _shared_registry_lock:
        latest_reg = _shared_registry_load()
        latest = latest_reg['files'].get(file_id)
        if not latest or latest.get('objectKey') != object_key:
            raise FileNotFoundError('shared file registration changed during confirmation')
        latest_reg['files'][file_id] = meta
        _shared_registry_save(latest_reg)
    return meta


def parse_multipart(handler, post_data):
    """极简 multipart 解析：返回 {fields, file_name, file_content, content_type}。"""
    ctype = handler.headers.get('Content-Type') or ''
    if 'multipart/form-data' not in ctype:
        raise ValueError('expected multipart/form-data')
    boundary = ''
    for part in ctype.split(';'):
        part = part.strip()
        if part.startswith('boundary='):
            boundary = part.split('=', 1)[1].strip().strip('"')
    if not boundary:
        raise ValueError('missing boundary')
    delim = ('--' + boundary).encode('utf-8')
    parts = post_data.split(delim)
    fields = {}
    file_name = ''
    file_content = b''
    content_type = 'application/octet-stream'
    for raw in parts:
        if not raw or raw in (b'--\r\n', b'--', b'\r\n'):
            continue
        if raw.startswith(b'--'):
            continue
        if raw.startswith(b'\r\n'):
            raw = raw[2:]
        if raw.endswith(b'\r\n'):
            raw = raw[:-2]
        header_blob, _, body = raw.partition(b'\r\n\r\n')
        headers = header_blob.decode('utf-8', errors='ignore')
        disp = ''
        for line in headers.split('\r\n'):
            if line.lower().startswith('content-disposition:'):
                disp = line
            if line.lower().startswith('content-type:'):
                content_type = line.split(':', 1)[1].strip()
        name = ''
        fname = ''
        for token in disp.split(';'):
            token = token.strip()
            if token.startswith('name='):
                name = token.split('=', 1)[1].strip().strip('"')
            if token.startswith('filename='):
                fname = token.split('=', 1)[1].strip().strip('"')
        if fname:
            file_name = fname
            file_content = body
        elif name:
            fields[name] = body.decode('utf-8', errors='ignore')
    return {
        'fields': fields,
        'file_name': file_name,
        'file_content': file_content,
        'content_type': content_type,
    }


def safe_annotation_task_dir(task_id):
    tid = ''.join(c for c in str(task_id) if c.isalnum() or c in ('-', '_'))
    if not tid:
        raise ValueError('invalid task id')
    root = os.path.abspath(ANNOTATION_UPLOAD_ROOT)
    target = os.path.abspath(os.path.join(root, tid))
    if not target.startswith(root + os.sep) and target != root:
        raise ValueError('invalid task path')
    return target


def safe_join_under(root, rel_path):
    rel = str(rel_path or '').replace('\\', '/').lstrip('/')
    parts = []
    for p in rel.split('/'):
        if not p or p in ('.', '..'):
            continue
        parts.append(p)
    if not parts:
        raise ValueError('empty relative path')
    root_abs = os.path.abspath(root)
    full = os.path.abspath(os.path.join(root_abs, *parts))
    if not full.startswith(root_abs + os.sep):
        raise ValueError('path escape')
    return full


def save_annotation_file(task_id, rel_path, content):
    ext = os.path.splitext(str(rel_path).lower())[1]
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        raise ValueError('file extension not allowed: %s' % ext)
    sniff_allowed_upload(content, rel_path)
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError('file too large: %s bytes' % len(content))
    task_dir = safe_annotation_task_dir(task_id)
    full = safe_join_under(task_dir, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'wb') as f:
        f.write(content)
    return {
        'taskId': str(task_id),
        'path': str(rel_path).replace('\\', '/'),
        'size': len(content),
        'savedAs': os.path.relpath(full, ANNOTATION_UPLOAD_ROOT).replace('\\', '/')
    }


def list_annotation_files(task_id):
    task_dir = safe_annotation_task_dir(task_id)
    if not os.path.isdir(task_dir):
        return []
    files = []
    for root, _dirs, names in os.walk(task_dir):
        for name in names:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, task_dir).replace('\\', '/')
            files.append({'path': rel, 'size': os.path.getsize(full)})
    return files


def zip_annotation_task(task_id):
    import io
    import zipfile
    task_dir = safe_annotation_task_dir(task_id)
    if not os.path.isdir(task_dir):
        raise FileNotFoundError('task files not found')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, names in os.walk(task_dir):
            for name in names:
                full = os.path.join(root, name)
                arc = os.path.relpath(full, task_dir).replace('\\', '/')
                zf.write(full, arcname=arc)
    return buf.getvalue()


def _supabase_headers(prefer=None, admin=False):
    key = SUPABASE_SERVICE_ROLE_KEY if (admin and SUPABASE_SERVICE_ROLE_KEY) else SUPABASE_KEY
    if not SUPABASE_URL or not key:
        raise RuntimeError('SUPABASE_URL/SUPABASE_KEY not configured')
    headers = {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': prefer or 'return=representation',
    }
    return headers


def _blob_meta_pn(task_id):
    return ANNOTATION_BLOB_PREFIX + str(task_id) + '_meta'


def _blob_chunk_pn(task_id, index):
    return ANNOTATION_BLOB_PREFIX + str(task_id) + '_c' + str(index)


def _upsert_patent_row(patent_number, title, summary, headers):
    q = (
        SUPABASE_URL + '/rest/v1/patents'
        + '?classification=eq.' + urllib.parse.quote(ANNOTATION_BLOB_MARK)
        + '&patent_number=eq.' + urllib.parse.quote(patent_number)
        + '&select=id'
    )
    req = urllib.request.Request(q, headers=headers, method='GET')
    with urllib.request.urlopen(req, timeout=30) as resp:
        rows = json.loads(resp.read().decode('utf-8'))
    body = {
        'patent_type': '同步',
        'name': str(title)[:200],
        'patent_number': patent_number,
        'classification': ANNOTATION_BLOB_MARK,
        'status': 'SYNC',
        'applicant': 'system',
        'summary': summary,
        'remark': 'annotation-cloud-blob',
    }
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    if rows:
        url = SUPABASE_URL + '/rest/v1/patents?id=eq.' + urllib.parse.quote(str(rows[0]['id']))
        req = urllib.request.Request(url, data=data, headers=headers, method='PATCH')
    else:
        url = SUPABASE_URL + '/rest/v1/patents'
        req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=60) as resp:
        resp.read()


def _get_patent_summary(patent_number, headers):
    q = (
        SUPABASE_URL + '/rest/v1/patents'
        + '?classification=eq.' + urllib.parse.quote(ANNOTATION_BLOB_MARK)
        + '&patent_number=eq.' + urllib.parse.quote(patent_number)
        + '&select=summary'
    )
    req = urllib.request.Request(q, headers=headers, method='GET')
    with urllib.request.urlopen(req, timeout=30) as resp:
        rows = json.loads(resp.read().decode('utf-8'))
    if not rows:
        return None
    return rows[0].get('summary')


def _get_app_sync_summary(key):
    if POSTGRES_DATA_BACKEND:
        item = data_store.get_sync_value(str(key))
        if not item:
            return None
        return json.dumps(item.get('value'), ensure_ascii=False, separators=(',', ':'))
    if not SUPABASE_URL or not (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY):
        raise RuntimeError('Supabase account source is not configured')
    headers = _supabase_headers(
        prefer='return=minimal',
        admin=bool(SUPABASE_SERVICE_ROLE_KEY),
    )
    q = (
        SUPABASE_URL + '/rest/v1/patents'
        + '?classification=eq.' + urllib.parse.quote(CLOUD_SYNC_MARK)
        + '&patent_number=eq.' + urllib.parse.quote('__SYNC_KV__' + str(key))
        + '&select=summary'
        + '&limit=1'
    )
    req = urllib.request.Request(q, headers=headers, method='GET')
    with urllib.request.urlopen(req, timeout=15) as resp:
        rows = json.loads(resp.read().decode('utf-8'))
    if not rows:
        return None
    return rows[0].get('summary')


def load_gateway_accounts(force=False):
    now = time.time()
    with _auth_lock:
        if (
            not force
            and _account_cache.get('accounts')
            and now - float(_account_cache.get('loaded_at') or 0) < AUTH_ACCOUNT_CACHE_SECONDS
        ):
            return list(_account_cache['accounts'])
    if POSTGRES_DATA_BACKEND:
        accounts = data_store.load_accounts()
    else:
        summary = _get_app_sync_summary('accountData')
        accounts = json.loads(summary or '[]')
    if not isinstance(accounts, list):
        raise ValueError('cloud accountData is not a list')
    safe_accounts = [item for item in accounts if isinstance(item, dict)]
    with _auth_lock:
        _account_cache['accounts'] = safe_accounts
        _account_cache['loaded_at'] = now
    return list(safe_accounts)


def save_gateway_accounts(accounts, actor='gateway-auth'):
    if POSTGRES_DATA_BACKEND:
        data_store.replace_accounts(accounts, actor=str(actor or 'gateway-auth'))
        with _auth_lock:
            _account_cache['accounts'] = list(accounts)
            _account_cache['loaded_at'] = time.time()
        return
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError('server-side Supabase account storage is not configured')
    headers = _supabase_headers(prefer='return=representation', admin=True)
    patent_number = '__SYNC_KV__accountData'
    q = (
        SUPABASE_URL + '/rest/v1/patents'
        + '?classification=eq.' + urllib.parse.quote(CLOUD_SYNC_MARK)
        + '&patent_number=eq.' + urllib.parse.quote(patent_number)
        + '&select=id'
        + '&limit=1'
    )
    req = urllib.request.Request(q, headers=headers, method='GET')
    with urllib.request.urlopen(req, timeout=15) as resp:
        rows = json.loads(resp.read().decode('utf-8'))
    body = {
        'patent_type': '同步',
        'name': '[SYNC] accountData',
        'patent_number': patent_number,
        'classification': CLOUD_SYNC_MARK,
        'status': 'SYNC',
        'applicant': 'gateway-auth',
        'summary': json.dumps(accounts, ensure_ascii=False, separators=(',', ':')),
        'remark': 'gateway-auth:' + datetime.now(timezone.utc).isoformat(),
    }
    raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
    if rows:
        url = SUPABASE_URL + '/rest/v1/patents?id=eq.' + urllib.parse.quote(str(rows[0]['id']))
        req = urllib.request.Request(url, data=raw, headers=headers, method='PATCH')
    else:
        req = urllib.request.Request(
            SUPABASE_URL + '/rest/v1/patents',
            data=raw,
            headers=headers,
            method='POST',
        )
    with urllib.request.urlopen(req, timeout=20) as resp:
        resp.read()
    with _auth_lock:
        _account_cache['accounts'] = list(accounts)
        _account_cache['loaded_at'] = time.time()


def create_gateway_password_record(password, iterations=210000):
    salt = secrets.token_bytes(16)
    verifier = hashlib.pbkdf2_hmac(
        'sha256',
        str(password).encode('utf-8'),
        salt,
        int(iterations),
        dklen=32,
    )
    return {
        'passwordScheme': 'pbkdf2-sha256',
        'passwordSalt': base64.b64encode(salt).decode('ascii'),
        'passwordIterations': int(iterations),
        'passwordHash': base64.b64encode(verifier).decode('ascii'),
        'passwordUpdatedAt': int(time.time() * 1000),
    }


def gateway_password_policy():
    """Return the server-enforced policy, allowing the admin policy to tighten it."""
    configured = {}
    try:
        if POSTGRES_DATA_BACKEND:
            record = data_store.get_sync_value('passwordPolicy')
            value = (record or {}).get('value')
        else:
            raw = _get_app_sync_summary('passwordPolicy')
            value = json.loads(raw) if raw else None
        if isinstance(value, dict):
            configured = value
    except Exception as exc:
        logger.warning('password policy lookup failed; using secure baseline: %s', exc)
    try:
        configured_minimum = int(configured.get('minLength') or 8)
    except (TypeError, ValueError):
        configured_minimum = 8
    return {
        # The browser policy may tighten these requirements, but it cannot
        # weaken the server baseline of eight characters + a letter + a digit.
        'minLength': max(8, min(configured_minimum, 128)),
        'requireUpper': bool(configured.get('requireUpper')),
        'requireLower': bool(configured.get('requireLower')),
        'requireDigit': True,
        'requireSpecial': bool(configured.get('requireSpecial')),
    }


def validate_new_password(password):
    value = str(password or '')
    policy = gateway_password_policy()
    has_ascii_letter = any(
        ('a' <= character <= 'z') or ('A' <= character <= 'Z')
        for character in value
    )
    if not (
        policy['minLength'] <= len(value) <= 512
        and has_ascii_letter
        and any(character.isdigit() for character in value)
    ):
        return False
    if policy['requireUpper'] and not any('A' <= character <= 'Z' for character in value):
        return False
    if policy['requireLower'] and not any('a' <= character <= 'z' for character in value):
        return False
    if policy['requireSpecial'] and not any(character in '!@#$%^&*' for character in value):
        return False
    return value.casefold() not in ('123456', 'password', 'password123')


def _bootstrap_admin_password():
    if BOOTSTRAP_ADMIN_PASSWORD_FILE:
        with open(BOOTSTRAP_ADMIN_PASSWORD_FILE, 'r', encoding='utf-8') as secret_file:
            return secret_file.read().strip()
    return BOOTSTRAP_ADMIN_PASSWORD


def bootstrap_gateway_admin():
    """Create exactly one initial administrator when the account table is empty."""
    if not POSTGRES_DATA_BACKEND:
        return False
    if data_store.load_accounts():
        return False
    username = BOOTSTRAP_ADMIN_USERNAME
    password = _bootstrap_admin_password()
    if not username or not password:
        raise RuntimeError(
            'account database is empty; configure BOOTSTRAP_ADMIN_USERNAME and '
            'BOOTSTRAP_ADMIN_PASSWORD (or BOOTSTRAP_ADMIN_PASSWORD_FILE)'
        )
    if not validate_new_password(password):
        raise RuntimeError('BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy')
    account = {
        'id': 1,
        'studentId': username,
        'realName': BOOTSTRAP_ADMIN_NAME or username,
        'role': 'admin',
        'status': 'active',
        'mustChangePwd': True,
        'firstLogin': True,
        'createdAt': _today(),
    }
    account.update(create_gateway_password_record(password))
    created = data_store.bootstrap_account(account, actor='bootstrap')
    if created:
        with _auth_lock:
            _account_cache['accounts'] = [account]
            _account_cache['loaded_at'] = time.time()
        logger.info('initial administrator created for username=%s', username)
    return created


_ACCOUNT_AUTH_FIELDS = {
    'password', 'passwordScheme', 'passwordSalt', 'passwordIterations',
    'passwordHash', 'passwordUpdatedAt', 'sessionVersion',
}


def _gateway_account_key(account):
    for field in ('studentId', 'id', 'email'):
        value = str((account or {}).get(field) or '').strip()
        if value:
            return value.casefold()
    return ''


def _public_gateway_account(account):
    return {
        key: value
        for key, value in dict(account or {}).items()
        if key not in _ACCOUNT_AUTH_FIELDS
    }


def _gateway_accounts_digest(accounts):
    canonical = json.dumps(
        list(accounts or []),
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(canonical).hexdigest()


def _prepare_gateway_accounts(incoming, existing):
    if not isinstance(incoming, list) or not incoming or len(incoming) > 5000:
        raise ValueError('accounts must be a non-empty list with at most 5000 items')
    existing_by_key = {
        _gateway_account_key(account): account
        for account in existing
        if _gateway_account_key(account)
    }
    prepared = []
    for raw_account in incoming:
        if not isinstance(raw_account, dict):
            raise ValueError('every account must be a JSON object')
        account = dict(raw_account)
        key = _gateway_account_key(account)
        if not key:
            raise ValueError('every account requires a login identifier')
        previous = existing_by_key.get(key) or {}
        plaintext = str(account.pop('password', '') or '')
        supplied_verifier = bool(account.get('passwordHash') and account.get('passwordSalt'))
        if plaintext:
            if not validate_new_password(plaintext):
                raise ValueError('account password does not meet the password policy')
            account.update(create_gateway_password_record(plaintext))
        elif not supplied_verifier:
            for field in _ACCOUNT_AUTH_FIELDS:
                if field != 'password' and previous.get(field) is not None:
                    account[field] = previous[field]
        if not account.get('passwordHash') or not account.get('passwordSalt'):
            raise ValueError('new accounts require a password')
        role = str(account.get('role') or 'visitor')
        if role not in ('admin', 'leader', 'student', 'visitor'):
            raise ValueError('invalid account role')
        account['role'] = role
        status = str(account.get('status') or 'active')
        if status not in ('active', 'disabled'):
            raise ValueError('invalid account status')
        account['status'] = status
        prepared.append(account)
    return prepared


class AccountDigestConflict(RuntimeError):
    def __init__(self, current_digest):
        super().__init__('account list changed; refresh before saving')
        self.current_digest = current_digest


def replace_gateway_accounts_if_match(incoming, expected_digest, actor):
    with _account_write_lock:
        current_accounts = load_gateway_accounts(force=True)
        current_digest = _gateway_accounts_digest(current_accounts)
        if not expected_digest or not secrets.compare_digest(expected_digest, current_digest):
            raise AccountDigestConflict(current_digest)
        prepared = _prepare_gateway_accounts(incoming, current_accounts)
        actor_account = _find_gateway_account(prepared, actor)
        active_admins = [
            account for account in prepared
            if account.get('role') == 'admin' and account.get('status') == 'active'
        ]
        if not actor_account or actor_account.get('role') != 'admin' or actor_account.get('status') != 'active':
            raise ValueError('the current administrator cannot remove or disable itself')
        if not active_admins:
            raise ValueError('at least one active administrator is required')
        save_gateway_accounts(prepared, actor=actor)
        return prepared, _gateway_accounts_digest(prepared)


def _find_gateway_account(accounts, login_id):
    needle = str(login_id or '').strip().lower()
    digits = ''.join(c for c in needle if c.isdigit())
    for account in accounts:
        values = [
            account.get('studentId'),
            account.get('realName'),
            account.get('email'),
        ]
        values.extend(account.get('loginAliases') or [])
        if any(str(value or '').strip().lower() == needle for value in values):
            return account
        phone = ''.join(c for c in str(account.get('phone') or '') if c.isdigit())
        if len(digits) >= 6 and phone and phone == digits:
            return account
    return None


def verify_gateway_password(account, password):
    if not account or not account.get('passwordHash') or not account.get('passwordSalt'):
        return False
    if str(account.get('passwordScheme') or '').lower() != 'pbkdf2-sha256':
        return False
    try:
        iterations = int(account.get('passwordIterations') or 120000)
        if iterations < 10000 or iterations > 2000000:
            return False
        salt = base64.b64decode(str(account['passwordSalt']), validate=True)
        expected = base64.b64decode(str(account['passwordHash']), validate=True)
        actual = hashlib.pbkdf2_hmac(
            'sha256',
            str(password or '').encode('utf-8'),
            salt,
            iterations,
            dklen=len(expected),
        )
        return bool(expected) and hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, binascii.Error):
        return False


def _parse_ip_literal(value):
    text = str(value or '').strip()
    if not text or len(text) > 64:
        return None
    try:
        return ipaddress.ip_address(text.split('%', 1)[0])
    except ValueError:
        return None


def _trusted_proxy_networks():
    nets = []
    for item in _TRUSTED_PROXY_RAW.split(','):
        text = item.strip()
        if not text:
            continue
        try:
            nets.append(ipaddress.ip_network(text, strict=False))
        except ValueError:
            logger.warning('ignoring invalid TRUSTED_PROXY entry: %s', text)
    return tuple(nets)


_TRUSTED_PROXY_NETWORKS = _trusted_proxy_networks()


def _is_trusted_proxy(peer_ip):
    parsed = _parse_ip_literal(peer_ip)
    if parsed is None:
        return False
    return any(parsed in network for network in _TRUSTED_PROXY_NETWORKS)


def request_client_ip(handler):
    """Return the real client IP when the peer is a trusted reverse proxy."""
    peer = str((handler.client_address or ('',))[0] or '').strip()
    if _is_trusted_proxy(peer):
        forwarded = (
            str(handler.headers.get('X-Real-IP') or '').strip()
            or str(handler.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
        )
        if _parse_ip_literal(forwarded) is not None:
            return forwarded
    return peer or 'unknown'


def _auth_attempt_key(handler, username):
    ip = request_client_ip(handler)
    return ip + '|' + str(username or '').strip().lower()[:120]


def auth_attempt_status(handler, username):
    key = _auth_attempt_key(handler, username)
    now = time.time()
    with _auth_lock:
        state = _auth_failures.get(key) or {'count': 0, 'locked_until': 0.0}
        if float(state.get('locked_until') or 0) > now:
            return False, max(1, int(float(state['locked_until']) - now))
        if float(state.get('locked_until') or 0):
            _auth_failures.pop(key, None)
        return True, 0


def record_auth_attempt(handler, username, success):
    key = _auth_attempt_key(handler, username)
    with _auth_lock:
        if success:
            _auth_failures.pop(key, None)
            return
        state = _auth_failures.get(key) or {'count': 0, 'locked_until': 0.0}
        state['count'] = int(state.get('count') or 0) + 1
        if state['count'] >= AUTH_LOGIN_MAX_ATTEMPTS:
            state['locked_until'] = time.time() + AUTH_LOGIN_LOCK_SECONDS
            state['count'] = 0
        _auth_failures[key] = state


def share_annotation_task_to_cloud(task_id):
    """Zip local task files and publish them to the configured shared storage."""
    raw = zip_annotation_task(task_id)
    if len(raw) > ANNOTATION_BLOB_MAX_BYTES:
        raise ValueError('dataset zip too large for cloud share: %s bytes (max %s)' % (len(raw), ANNOTATION_BLOB_MAX_BYTES))
    if POSTGRES_DATA_BACKEND:
        safe_task_id = _safe_dataset_id(task_id)
        digest = hashlib.sha256(raw).hexdigest()
        object_key = 'annotation-shares/task-%s.zip' % safe_task_id
        client = _get_minio_client()
        if client:
            client.put_object(
                MINIO_BUCKET,
                object_key,
                io.BytesIO(raw),
                len(raw),
                content_type='application/zip',
                metadata={'sha256': digest, 'task-id': safe_task_id},
            )
            share_mode = 'minio'
        else:
            share_root = os.path.join(CITYSAFE_DATA_DIR, 'annotation-shares')
            os.makedirs(share_root, exist_ok=True)
            with open(os.path.join(share_root, 'task-%s.zip' % safe_task_id), 'wb') as output:
                output.write(raw)
            share_mode = 'local'
        return {
            'taskId': safe_task_id,
            'bytes': len(raw),
            'sha256': digest,
            'updatedAt': _now_iso(),
            'contentType': 'application/zip',
            'shareMode': share_mode,
            'objectKey': object_key if client else None,
        }

    headers = _supabase_headers(prefer='return=minimal')
    digest = hashlib.sha256(raw).hexdigest()
    chunks = []
    size = ANNOTATION_BLOB_CHUNK_SIZE
    for i in range(0, len(raw), size):
        chunks.append(raw[i:i + size])
    for idx, chunk in enumerate(chunks):
        b64 = base64.b64encode(chunk).decode('ascii')
        _upsert_patent_row(
            _blob_chunk_pn(task_id, idx),
            'ANNO_BLOB:%s:%s' % (task_id, idx),
            b64,
            headers,
        )
    meta = {
        'taskId': str(task_id),
        'chunks': len(chunks),
        'bytes': len(raw),
        'sha256': digest,
        'updatedAt': _now_iso(),
        'contentType': 'application/zip',
        'shareMode': 'cloud-kv',
    }
    _upsert_patent_row(
        _blob_meta_pn(task_id),
        'ANNO_BLOB_META:%s' % task_id,
        json.dumps(meta, ensure_ascii=False),
        headers,
    )
    return meta


def fetch_annotation_task_from_cloud(task_id):
    if POSTGRES_DATA_BACKEND:
        safe_task_id = _safe_dataset_id(task_id)
        object_key = 'annotation-shares/task-%s.zip' % safe_task_id
        client = _get_minio_client()
        if client:
            try:
                response = client.get_object(MINIO_BUCKET, object_key)
                try:
                    raw = response.read()
                finally:
                    response.close()
                    response.release_conn()
                stat = client.stat_object(MINIO_BUCKET, object_key)
                expected = str((stat.metadata or {}).get('x-amz-meta-sha256') or '')
            except Exception as exc:
                raise FileNotFoundError('shared annotation package not found') from exc
            mode = 'minio'
        else:
            local_path = os.path.join(
                CITYSAFE_DATA_DIR,
                'annotation-shares',
                'task-%s.zip' % safe_task_id,
            )
            if not os.path.isfile(local_path):
                raise FileNotFoundError('shared annotation package not found')
            with open(local_path, 'rb') as source:
                raw = source.read()
            expected = ''
            mode = 'local'
        digest = hashlib.sha256(raw).hexdigest()
        if expected and not secrets.compare_digest(expected, digest):
            raise ValueError('shared annotation package checksum mismatch')
        return raw, {
            'taskId': safe_task_id,
            'bytes': len(raw),
            'sha256': digest,
            'contentType': 'application/zip',
            'shareMode': mode,
        }

    headers = _supabase_headers()
    meta_raw = _get_patent_summary(_blob_meta_pn(task_id), headers)
    if not meta_raw:
        raise FileNotFoundError('cloud share meta not found')
    meta = json.loads(meta_raw)
    chunks = int(meta.get('chunks') or 0)
    if chunks <= 0:
        raise FileNotFoundError('cloud share empty')
    parts = []
    for idx in range(chunks):
        b64 = _get_patent_summary(_blob_chunk_pn(task_id, idx), headers)
        if not b64:
            raise FileNotFoundError('missing cloud chunk %s' % idx)
        parts.append(base64.b64decode(b64))
    raw = b''.join(parts)
    expect = str(meta.get('sha256') or '')
    if expect:
        got = hashlib.sha256(raw).hexdigest()
        if got != expect:
            raise ValueError('cloud share checksum mismatch')
    return raw, meta


def _request_claims(handler, roles=None):
    try:
        handler._password_change_required = False
    except Exception:
        pass
    claims = check_gateway_session(handler, roles)
    if claims:
        if _password_change_required(handler, claims):
            try:
                handler._password_change_required = True
            except Exception:
                pass
            return None
        return claims
    if AUTH_REQUIRED:
        return None
    client_ip = str((handler.client_address or ('',))[0] or '').strip().lower()
    if ALLOW_INSECURE_LOCAL_WRITES and client_ip in ('127.0.0.1', '::1', 'localhost'):
        local_claims = {
            'sub': 'local-development',
            'sid': 'local-development',
            'name': 'Local Development',
            'role': 'admin',
            'mustChangePwd': False,
        }
        if not roles or local_claims['role'] in set(roles):
            return local_claims
    return None


def _claims_actor(claims):
    return str((claims or {}).get('sid') or (claims or {}).get('sub') or 'unknown')[:200]


def _dataset_request_claims(handler, roles=None):
    """Resolve a session principal while retaining the legacy local token flow."""
    try:
        handler._password_change_required = False
    except Exception:
        pass
    claims = check_gateway_session(handler, roles)
    if claims:
        if _password_change_required(handler, claims):
            try:
                handler._password_change_required = True
            except Exception:
                pass
            return None
        return claims
    if AUTH_REQUIRED:
        return None
    if not check_dataset_token(handler):
        return None
    # Legacy dataset tokens predate role-aware sessions and are only allowed
    # when AUTH_REQUIRED is disabled. Preserve that local integration as an
    # explicitly privileged service principal.
    local_claims = {
        'sub': 'dataset-token',
        'sid': 'dataset-token',
        'name': 'Dataset Integration',
        'role': 'admin',
        'mustChangePwd': False,
    }
    if roles and local_claims['role'] not in set(roles):
        return None
    return local_claims


def _sync_write_allowed(claims, key):
    if str((claims or {}).get('role') or '') == 'admin':
        return sync_policy.can_write(claims, key, None)
    matrix_record = None
    try:
        if data_store.database_enabled():
            matrix_record = data_store.get_sync_value('permissionMatrix')
    except Exception as exc:
        # Permission checks fail closed to the built-in least-privilege matrix
        # when the database is unavailable; the write itself will still fail
        # later rather than silently granting a broader role.
        logger.warning('permission matrix lookup failed; using secure defaults: %s', exc)
    permission_matrix = (
        matrix_record.get('value')
        if isinstance(matrix_record, dict)
        else None
    )
    return sync_policy.can_write(claims, key, permission_matrix)


def _record_selector(resource):
    parsed = urllib.parse.urlparse(str(resource or ''))
    record_type = parsed.path.strip('/').lower()
    if record_type not in ('patents', 'papers'):
        raise ValueError('unsupported data resource')
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    record_ids = None
    filters = {}
    for field, values in query.items():
        if field in ('select', 'order', 'limit', 'offset') or not values:
            continue
        expression = str(values[0] or '')
        if expression.startswith('eq.'):
            raw_value = expression[3:]
            if field == 'id':
                record_ids = [int(raw_value)]
            else:
                filters[field] = raw_value
        elif field == 'id' and expression.startswith('in.(') and expression.endswith(')'):
            raw_ids = expression[4:-1].split(',')
            record_ids = [int(item.strip()) for item in raw_ids if item.strip()]
        else:
            raise ValueError('unsupported data filter')
    return record_type, record_ids, filters, query


def _public_record(record):
    payload = dict((record or {}).get('payload') or {})
    payload['id'] = int(record['id'])
    return payload


def _handle_record_operation(operation, resource, body_data, request_options, claims):
    record_type, record_ids, filters, resource_query = _record_selector(resource)
    operation = str(operation or 'GET').upper()
    actor = _claims_actor(claims)
    options = request_options if isinstance(request_options, dict) else {}
    data_options = body_data if operation == 'GET' and isinstance(body_data, dict) else {}

    if operation == 'GET':
        raw_limit = (
            data_options.get('limit')
            or options.get('limit')
            or (resource_query.get('limit') or [500])[0]
        )
        raw_offset = (
            data_options.get('offset')
            or options.get('offset')
            or (resource_query.get('offset') or [0])[0]
        )
        limit = max(1, min(int(raw_limit or 500), 1000))
        offset = max(0, int(raw_offset or 0))
        rows = data_store.list_records(
            record_type,
            record_ids=record_ids,
            filters=filters or None,
            order_by='updated_at',
            descending=True,
            limit=limit,
            offset=offset,
        )
        public_rows = [_public_record(row) for row in rows]
        order = str(data_options.get('order') or options.get('order') or '')
        if order:
            parts = order.split('.')
            field = parts[0]
            descending = len(parts) > 1 and parts[1].lower() == 'desc'
            public_rows.sort(
                key=lambda item: (item.get(field) is None, str(item.get(field) or '')),
                reverse=descending,
            )
        return public_rows

    if claims.get('role') not in ('admin', 'leader'):
        raise PermissionError('admin or leader role required for data changes')
    if operation == 'POST':
        if not isinstance(body_data, dict):
            raise ValueError('record data must be a JSON object')
        return [_public_record(data_store.create_record(record_type, body_data, actor))]
    if operation == 'PATCH':
        if not isinstance(body_data, dict):
            raise ValueError('record data must be a JSON object')
        rows = data_store.update_records(
            record_type,
            body_data,
            actor=actor,
            record_ids=record_ids,
            filters=filters or None,
        )
        return [_public_record(row) for row in rows]
    if operation == 'DELETE':
        deleted = data_store.delete_records(
            record_type,
            actor=actor,
            record_ids=record_ids,
            filters=filters or None,
        )
        return [], deleted
    raise ValueError('unsupported data operation')


_STATIC_BLOCKED_ROOTS = {
    '__pycache__', 'logs', 'node_modules', 'tests', 'uploads',
}
_STATIC_BLOCKED_NAMES = {
    '.dockerignore', '.env', '.env.local', 'config.local.js', 'dockerfile',
    'package.json', 'package-lock.json', 'requirements.txt',
    'proxy_server.js', 'server.cjs', 'start_web.py', 'worker.js',
    'working_proxy.py',
}
_STATIC_BLOCKED_EXTENSIONS = {
    '.bak', '.conf', '.db', '.env', '.ini', '.key', '.log', '.md',
    '.pem', '.ps1', '.py', '.pyc', '.pyo', '.service', '.sh', '.sql',
    '.sqlite', '.sqlite3', '.toml', '.yaml', '.yml',
}


def resolve_static_file_path(request_path):
    """Resolve a public asset without allowing traversal or source/state reads."""
    decoded = urllib.parse.unquote(str(request_path or '/'))
    if '\x00' in decoded:
        raise PermissionError('invalid static path')
    # Treat backslashes as separators on every platform so Windows development
    # behaves like the Linux container and cannot gain a traversal bypass.
    parts = [part for part in decoded.replace('\\', '/').split('/') if part]
    if not parts:
        parts = ['index.html']
    folded_parts = [part.casefold() for part in parts]
    if (
        any(part in ('.', '..') or part.startswith('.') for part in folded_parts)
        or folded_parts[0] in _STATIC_BLOCKED_ROOTS
        or folded_parts[-1] in _STATIC_BLOCKED_NAMES
        or os.path.splitext(folded_parts[-1])[1] in _STATIC_BLOCKED_EXTENSIONS
    ):
        raise PermissionError('static path is not public')
    base_path = os.path.realpath(BASE_DIR)
    file_path = os.path.realpath(os.path.join(base_path, *parts))
    try:
        inside_base = os.path.commonpath((base_path, file_path)) == base_path
    except ValueError:
        inside_base = False
    if not inside_base:
        raise PermissionError('static path escapes application root')
    return file_path


class WorkingProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        message = format % args
        request_target = str(getattr(self, 'path', '') or '')
        if request_target:
            safe_target = urllib.parse.urlsplit(request_target).path or '/'
            message = message.replace(request_target, safe_target)
        logger.info("%s - %s", self.client_address[0], message)

    def _cors(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        # 先落地与现有内联脚本兼容的强制策略；后续逐步移除内联事件后可再收紧 script-src/style-src。
        self.send_header(
            'Content-Security-Policy',
            "base-uri 'self'; object-src 'none'; frame-ancestors 'self'",
        )
        origin = (self.headers.get('Origin') or '').strip().rstrip('/')
        if origin and ('*' in CORS_ALLOW_ORIGINS or origin in CORS_ALLOW_ORIGINS):
            self.send_header('Access-Control-Allow-Origin', '*' if '*' in CORS_ALLOW_ORIGINS else origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-MLOps-Token, X-Upload-Token, X-Task-Id, X-Rel-Path, '
            'X-Upload-Id, X-Chunk-Index, X-Chunk-Total, X-Dataset-Token'
        )

    def _json(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        origin = (self.headers.get('Origin') or '').strip().rstrip('/')
        if origin and '*' not in CORS_ALLOW_ORIGINS and origin not in CORS_ALLOW_ORIGINS:
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        dataset_claims = None
        dataset_chunk_request = None
        try:
            content_length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            self._json(400, {'ok': False, 'error': 'invalid content length'})
            return
        if content_length < 0:
            self._json(400, {'ok': False, 'error': 'invalid content length'})
            return
        if path.startswith('/api/dataset/'):
            dataset_claims = _dataset_request_claims(
                self,
                ('admin', 'leader', 'student'),
            )
            if not dataset_claims:
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
        is_binary_upload = (
            path.startswith('/api/annotation/upload')
            or path.startswith('/api/shared-file/upload')
            or path.startswith('/api/dataset/chunk')
        )
        if path.startswith('/api/annotation/upload'):
            if not check_upload_token(self):
                audit_event('annotation_upload_denied', ip=self.client_address[0], reason='invalid_token')
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            if content_length > MAX_UPLOAD_BYTES:
                audit_event('annotation_upload_denied', ip=self.client_address[0], reason='too_large', bytes=content_length)
                self._json(413, {'ok': False, 'error': 'file too large'})
                return
        elif path.startswith('/api/shared-file/upload'):
            if not check_dataset_token(self, ('admin', 'leader', 'student')):
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            if content_length > MAX_UPLOAD_BYTES:
                self._json(413, {'ok': False, 'error': 'file too large'})
                return
        elif path.startswith('/api/dataset/chunk'):
            if content_length > DATASET_MAX_CHUNK_BYTES:
                self._json(413, {'ok': False, 'error': 'chunk too large'})
                return
            upload_id = self.headers.get('X-Upload-Id') or ''
            try:
                chunk_index = int(self.headers.get('X-Chunk-Index') or -1)
                total_raw = self.headers.get('X-Chunk-Total')
                total_chunks = int(total_raw) if total_raw not in (None, '') else None
                dataset_chunk_request = validate_dataset_chunk_request(
                    upload_id,
                    chunk_index,
                    content_length,
                    total_chunks=total_chunks,
                    actor=_claims_actor(dataset_claims),
                    role=dataset_claims.get('role'),
                )
            except PermissionError as exc:
                self._json(403, {'ok': False, 'error': str(exc)})
                return
            except FileNotFoundError as exc:
                self._json(404, {'ok': False, 'error': str(exc)})
                return
            except (TypeError, ValueError) as exc:
                self._json(400, {'ok': False, 'error': str(exc)})
                return
        if not is_binary_upload and content_length > MAX_JSON_BODY_BYTES:
            self._json(413, {'ok': False, 'error': 'request body too large'})
            return
        post_data = self.rfile.read(content_length) if content_length else b''

        if path == '/api/sync/upsert':
            if not POSTGRES_DATA_BACKEND:
                self._json(503, {'ok': False, 'error': 'gateway sync backend is not enabled'})
                return
            claims = _request_claims(self)
            if not claims:
                status, body = _auth_denied_response(self)
                self._json(status, body)
                return
            try:
                body = json.loads((post_data or b'{}').decode('utf-8'))
                if not isinstance(body, dict):
                    raise ValueError('JSON object required')
                key = str(body.get('key') or '').strip()
                if key not in APP_SYNC_KEYS:
                    raise ValueError('unsupported sync key')
                if not _sync_write_allowed(claims, key):
                    self._json(403, {'ok': False, 'error': 'role cannot update this sync key'})
                    return
                incoming_value = sync_policy.validate_value(key, body.get('value'))
                current_item = data_store.get_sync_value(key)
                current_value = (
                    current_item.get('value')
                    if isinstance(current_item, dict)
                    else []
                )
                value = sync_policy.merge_scoped_write(
                    key,
                    incoming_value,
                    current_value,
                    claims,
                )
                base_version = body.get('baseVersion', 0)
                if isinstance(base_version, bool):
                    raise ValueError('baseVersion must be an integer')
                base_version = int(base_version)
                item = data_store.put_sync_value(
                    key,
                    value,
                    base_version,
                    _claims_actor(claims),
                )
                try:
                    data_store.append_audit(
                        'sync_value_updated',
                        _claims_actor(claims),
                        subject_type='sync',
                        subject_id=key,
                        details={'version': item.get('version')},
                    )
                except Exception as audit_exc:
                    logger.warning('database audit append failed: %s', audit_exc)
                self._json(200, {'ok': True, 'item': item})
            except data_store.VersionConflict as conflict:
                self._json(409, {'ok': False, **conflict.as_dict()})
            except sync_policy.SyncPolicyError as exc:
                self._json(400, {'ok': False, 'error': str(exc)})
            except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                self._json(400, {'ok': False, 'error': str(exc)})
            except Exception as exc:
                logger.exception('sync upsert failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'sync storage unavailable'})
            return

        if path == '/api/data/records':
            if not POSTGRES_DATA_BACKEND:
                self._json(503, {'ok': False, 'error': 'gateway data backend is not enabled'})
                return
            claims = _request_claims(self)
            if not claims:
                status, body = _auth_denied_response(self)
                self._json(status, body)
                return
            try:
                body = json.loads((post_data or b'{}').decode('utf-8'))
                if not isinstance(body, dict):
                    raise ValueError('JSON object required')
                result = _handle_record_operation(
                    body.get('operation'),
                    body.get('resource'),
                    body.get('data'),
                    body.get('options'),
                    claims,
                )
                if isinstance(result, tuple):
                    rows, deleted = result
                else:
                    rows, deleted = result, 0
                operation = str(body.get('operation') or 'GET').upper()
                if operation != 'GET':
                    try:
                        data_store.append_audit(
                            'records_' + operation.lower(),
                            _claims_actor(claims),
                            subject_type='record_collection',
                            subject_id=str(body.get('resource') or '').split('?', 1)[0],
                            details={'affected': deleted if operation == 'DELETE' else len(rows)},
                        )
                    except Exception as audit_exc:
                        logger.warning('database audit append failed: %s', audit_exc)
                self._json(200, {'ok': True, 'rows': rows, 'deleted': deleted})
            except PermissionError as exc:
                self._json(403, {'ok': False, 'error': str(exc)})
            except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                self._json(400, {'ok': False, 'error': str(exc)})
            except Exception as exc:
                logger.exception('record operation failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'data storage unavailable'})
            return

        if path == '/api/auth/admin/accounts/replace':
            claims = _request_claims(self, ('admin',))
            if not claims:
                self._json(403, {'ok': False, 'error': 'admin session required'})
                return
            try:
                body = json.loads((post_data or b'{}').decode('utf-8'))
                if not isinstance(body, dict):
                    raise ValueError('JSON object required')
                expected_digest = str(body.get('expectedDigest') or '')
                actor = _claims_actor(claims)
                prepared, next_digest = replace_gateway_accounts_if_match(
                    body.get('accounts'),
                    expected_digest,
                    actor,
                )
                try:
                    data_store.append_audit(
                        'accounts_replaced',
                        actor,
                        subject_type='account_collection',
                        subject_id='all',
                        details={'count': len(prepared)},
                    )
                except Exception as audit_exc:
                    logger.warning('database audit append failed: %s', audit_exc)
                self._json(200, {
                    'ok': True,
                    'digest': next_digest,
                    'accounts': [_public_gateway_account(item) for item in prepared],
                })
            except AccountDigestConflict as conflict:
                self._json(409, {
                    'ok': False,
                    'error': str(conflict),
                    'currentDigest': conflict.current_digest,
                })
            except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                self._json(400, {'ok': False, 'error': str(exc)})
            except Exception as exc:
                logger.exception('account replace failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'account service unavailable'})
            return

        if path == '/api/auth/login':
            if not AUTH_SIGNING_SECRET:
                self._json(503, {'ok': False, 'error': 'gateway authentication is not configured'})
                return
            try:
                body = json.loads((post_data or b'{}').decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._json(400, {'ok': False, 'error': 'invalid JSON body'})
                return
            if not isinstance(body, dict):
                self._json(400, {'ok': False, 'error': 'JSON object required'})
                return
            username = str(body.get('username') or '').strip()
            password = str(body.get('password') or '')
            if not username or not password or len(username) > 120 or len(password) > 512:
                self._json(400, {'ok': False, 'error': 'username and password are required'})
                return
            allowed, retry_after = auth_attempt_status(self, username)
            if not allowed:
                self.send_response(429)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Retry-After', str(retry_after))
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({
                    'ok': False,
                    'error': 'too many login attempts',
                    'retryAfter': retry_after,
                }, ensure_ascii=False).encode('utf-8'))
                return
            try:
                accounts = load_gateway_accounts()
                account = _find_gateway_account(accounts, username)
                valid = bool(
                    account
                    and str(account.get('status') or 'active') == 'active'
                    and verify_gateway_password(account, password)
                )
            except Exception as exc:
                logger.warning('gateway auth account source failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'account service unavailable'})
                return
            if not valid:
                # 未知账号也执行一次固定成本派生，降低账号枚举侧信道。
                if not account:
                    hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), b'citysafe-auth-dummy', 210000)
                record_auth_attempt(self, username, False)
                audit_event('gateway_login_failed', ip=request_client_ip(self), username=username[:120])
                self._json(401, {'ok': False, 'error': 'invalid username or password'})
                return
            record_auth_attempt(self, username, True)
            token, claims = issue_session_token(account)
            audit_event(
                'gateway_login_ok',
                ip=request_client_ip(self),
                studentId=claims.get('sid'),
                role=claims.get('role'),
            )
            self._json(200, {
                'ok': True,
                'token': token,
                'expiresAt': claims['exp'] * 1000,
                'user': {
                    'id': claims['sub'],
                    'studentId': claims['sid'],
                    'realName': claims['name'],
                    'role': claims['role'],
                    'mustChangePwd': bool(account.get('mustChangePwd')),
                },
            })
            return

        if path == '/api/auth/change-password':
            claims = check_gateway_session(self)
            if not claims:
                self._json(401, {'ok': False, 'error': 'invalid or expired session'})
                return
            try:
                body = json.loads((post_data or b'{}').decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._json(400, {'ok': False, 'error': 'invalid JSON body'})
                return
            if not isinstance(body, dict):
                self._json(400, {'ok': False, 'error': 'JSON object required'})
                return
            current_password = str(body.get('currentPassword') or '')
            new_password = str(body.get('newPassword') or '')
            if not validate_new_password(new_password):
                self._json(400, {'ok': False, 'error': 'new password does not meet policy'})
                return
            try:
                with _account_write_lock:
                    accounts = load_gateway_accounts(force=True)
                    account = _find_gateway_account(accounts, claims.get('sid') or claims.get('sub'))
                    if not account or str(account.get('status') or 'active') != 'active':
                        self._json(403, {'ok': False, 'error': 'account unavailable'})
                        return
                    if not account.get('mustChangePwd') and not verify_gateway_password(account, current_password):
                        self._json(401, {'ok': False, 'error': 'current password is invalid'})
                        return
                    if verify_gateway_password(account, new_password):
                        self._json(400, {'ok': False, 'error': 'new password must differ from the current password'})
                        return
                    account.update(create_gateway_password_record(new_password))
                    account['mustChangePwd'] = False
                    account['firstLogin'] = False
                    save_gateway_accounts(accounts, actor=_claims_actor(claims))
                    refreshed_token, refreshed_claims = issue_session_token(account)
            except Exception as exc:
                logger.warning('gateway password change failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'account service unavailable'})
                return
            audit_event('gateway_password_changed', ip=self.client_address[0], studentId=claims.get('sid'))
            self._json(200, {
                'ok': True,
                'token': refreshed_token,
                'expiresAt': refreshed_claims['exp'] * 1000,
                'user': {
                    'id': refreshed_claims['sub'],
                    'studentId': refreshed_claims['sid'],
                    'realName': refreshed_claims['name'],
                    'role': refreshed_claims['role'],
                    'mustChangePwd': False,
                },
            })
            return

        if path == '/api/auth/admin/reset-password':
            claims = check_gateway_session(self, ('admin',))
            if not claims:
                self._json(403, {'ok': False, 'error': 'admin session required'})
                return
            try:
                body = json.loads((post_data or b'{}').decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._json(400, {'ok': False, 'error': 'invalid JSON body'})
                return
            if not isinstance(body, dict):
                self._json(400, {'ok': False, 'error': 'JSON object required'})
                return
            target = str(body.get('studentId') or '').strip()
            new_password = str(body.get('newPassword') or '')
            if not target or not validate_new_password(new_password):
                self._json(400, {'ok': False, 'error': 'target and policy-compliant password are required'})
                return
            try:
                with _account_write_lock:
                    accounts = load_gateway_accounts(force=True)
                    account = _find_gateway_account(accounts, target)
                    if not account:
                        self._json(404, {'ok': False, 'error': 'account not found'})
                        return
                    account.update(create_gateway_password_record(new_password))
                    account['mustChangePwd'] = True
                    account['firstLogin'] = True
                    save_gateway_accounts(accounts, actor=_claims_actor(claims))
            except Exception as exc:
                logger.warning('gateway admin password reset failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'account service unavailable'})
                return
            audit_event(
                'gateway_password_reset',
                ip=self.client_address[0],
                actor=claims.get('sid'),
                target=target,
            )
            self._json(200, {'ok': True})
            return

        if path == '/api/auth/logout':
            claims = check_gateway_session(self)
            if not claims:
                self._json(401, {'ok': False, 'error': 'valid session required'})
                return
            try:
                with _account_write_lock:
                    accounts = load_gateway_accounts(force=True)
                    account = _find_gateway_account(
                        accounts,
                        claims.get('sid') or claims.get('sub'),
                    )
                    if not account:
                        self._json(401, {'ok': False, 'error': 'valid session required'})
                        return
                    account['sessionVersion'] = int(account.get('sessionVersion') or 0) + 1
                    save_gateway_accounts(accounts, actor=_claims_actor(claims))
            except Exception as exc:
                logger.warning('gateway logout revocation failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'logout service unavailable'})
                return
            audit_event(
                'gateway_logout',
                ip=self.client_address[0],
                studentId=claims.get('sid'),
            )
            self._json(200, {'ok': True})
            return

        # 团队共享文件：multipart 上传到磁盘
        if path.startswith('/api/shared-file/upload'):
            if not check_dataset_token(self, ('admin', 'leader', 'student')):
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            if content_length > MAX_UPLOAD_BYTES:
                self._json(413, {'ok': False, 'error': 'file too large'})
                return
            try:
                parsed = parse_multipart(self, post_data or b'')
                fields = parsed.get('fields') or {}
                content = parsed.get('file_content') or b''
                if not content:
                    self._json(400, {'ok': False, 'error': 'file required'})
                    return
                meta = save_shared_upload(
                    fields.get('fileName') or parsed.get('file_name') or 'file',
                    fields.get('fileType') or 'other',
                    fields.get('remark') or '',
                    content,
                    original_name=parsed.get('file_name') or '',
                )
                audit_event('shared_upload_ok', ip=self.client_address[0], fileId=meta.get('fileId'), bytes=meta.get('size'), storage=meta.get('storage'))
                self._json(200, {'ok': True, 'fileId': meta['fileId'], 'savedAs': meta['savedAs'], 'size': meta['size'], 'md5': meta['md5'], 'storage': meta.get('storage')})
            except Exception as e:
                audit_event('shared_upload_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        # MinIO 预签名直传（增量接口；未启用 minio 时返回错误，前端可回退 multipart）
        if path.startswith('/api/shared-file/presign'):
            if not check_dataset_token(self, ('admin', 'leader', 'student')):
                audit_event('shared_presign_denied', ip=self.client_address[0], reason='invalid_token')
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                result = create_shared_presign(
                    payload.get('fileName') or payload.get('name') or 'file',
                    payload.get('fileType') or 'other',
                    payload.get('remark') or '',
                    payload.get('size') or 0,
                    content_type=payload.get('contentType') or payload.get('type') or '',
                    original_name=payload.get('originalName') or payload.get('fileName') or '',
                    owner=payload.get('owner') or payload.get('ownerId') or '',
                )
                audit_event('shared_presign_ok', ip=self.client_address[0], fileId=result.get('fileId'), bytes=payload.get('size'))
                self._json(200, {'ok': True, **result})
            except Exception as e:
                # 未启用/未就绪/未配 HTTPS：回传 fallback，前端改走网关 multipart 代理上传。
                msg = str(e)
                fallback = ('presign_disabled_insecure' in msg
                            or '对象存储未就绪' in msg
                            or 'minio' in msg.lower())
                audit_event('shared_presign_failed', ip=self.client_address[0], error=msg, fallback=fallback)
                self._json(400, {'ok': False, 'fallback': fallback, 'error': msg})
            return

        if path.startswith('/api/shared-file/confirm'):
            if not check_dataset_token(self, ('admin', 'leader', 'student')):
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                meta = confirm_shared_presign(
                    payload.get('fileId') or '',
                    md5=payload.get('md5') or '',
                    size=payload.get('size'),
                    owner=payload.get('owner') or payload.get('ownerId') or '',
                )
                audit_event('shared_confirm_ok', ip=self.client_address[0], fileId=meta.get('fileId'), bytes=meta.get('size'))
                self._json(200, {
                    'ok': True,
                    'fileId': meta['fileId'],
                    'savedAs': meta.get('savedAs'),
                    'size': meta.get('size'),
                    'md5': meta.get('md5'),
                    'storage': meta.get('storage'),
                })
            except Exception as e:
                audit_event('shared_confirm_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/shared-file/delete'):
            if not check_dataset_token(self, ('admin', 'leader')):
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                file_id = payload.get('fileId') or ''
                mode = (payload.get('mode') or 'soft').strip().lower()
                if mode == 'purge':
                    info = purge_shared_file(file_id)
                else:
                    info = soft_delete_shared_file(file_id)
                audit_event('shared_delete_ok', ip=self.client_address[0], fileId=file_id, mode=mode)
                self._json(200, {'ok': True, **info})
            except Exception as e:
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/shared-file/restore'):
            if not check_dataset_token(self, ('admin', 'leader')):
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                info = restore_shared_file(payload.get('fileId') or '')
                audit_event('shared_restore_ok', ip=self.client_address[0], fileId=info.get('fileId'))
                self._json(200, {'ok': True, **info})
            except Exception as e:
                self._json(400, {'ok': False, 'error': str(e)})
            return

        # 数据集分片上传：初始化 / 分片 / 合并
        if path.startswith('/api/dataset/init'):
            dataset_actor = _claims_actor(dataset_claims)
            dataset_role = dataset_claims.get('role')
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                info = init_dataset_upload(
                    payload,
                    actor=dataset_actor,
                    role=dataset_role,
                )
                audit_event('dataset_init_ok', ip=self.client_address[0], uploadId=info.get('uploadId'), instant=info.get('instant'))
                self._json(200, {'ok': True, **info})
            except PermissionError as e:
                audit_event('dataset_init_denied', ip=self.client_address[0], error=str(e))
                self._json(403, {'ok': False, 'error': str(e)})
            except Exception as e:
                audit_event('dataset_init_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/chunk'):
            upload_id = dataset_chunk_request['uploadId']
            try:
                info = save_dataset_chunk(
                    upload_id,
                    dataset_chunk_request['index'],
                    post_data or b'',
                    total_chunks=dataset_chunk_request['totalChunks'],
                    actor=_claims_actor(dataset_claims),
                    role=dataset_claims.get('role'),
                )
                self._json(200, info)
            except PermissionError as e:
                audit_event('dataset_chunk_denied', ip=self.client_address[0], uploadId=upload_id, error=str(e))
                self._json(403, {'ok': False, 'error': str(e)})
            except Exception as e:
                audit_event('dataset_chunk_failed', ip=self.client_address[0], uploadId=upload_id, error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/complete'):
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                info = complete_dataset_upload(
                    payload,
                    actor=_claims_actor(dataset_claims),
                    role=dataset_claims.get('role'),
                )
                audit_event('dataset_complete_ok', ip=self.client_address[0], fileId=info.get('fileId'), bytes=info.get('size'))
                self._json(200, info)
            except PermissionError as e:
                audit_event('dataset_complete_denied', ip=self.client_address[0], error=str(e))
                self._json(403, {'ok': False, 'error': str(e)})
            except Exception as e:
                audit_event('dataset_complete_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/abort'):
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                upload_id = payload.get('uploadId') or self.headers.get('X-Upload-Id') or ''
                if payload.get('purgeAll'):
                    if dataset_claims.get('role') != 'admin':
                        raise PermissionError('administrator role required to purge uploads')
                    info = purge_incomplete_dataset_uploads(
                        md5=payload.get('md5') or None,
                        size=payload.get('size') if payload.get('size') not in (None, '') else None,
                        actor=_claims_actor(dataset_claims),
                        role=dataset_claims.get('role'),
                    )
                else:
                    info = abort_dataset_upload(
                        upload_id,
                        actor=_claims_actor(dataset_claims),
                        role=dataset_claims.get('role'),
                    )
                audit_event('dataset_abort_ok', ip=self.client_address[0], uploadId=upload_id or 'purge', bytes=info.get('bytesRemoved'))
                self._json(200, info)
            except PermissionError as e:
                audit_event('dataset_abort_denied', ip=self.client_address[0], error=str(e))
                self._json(403, {'ok': False, 'error': str(e)})
            except Exception as e:
                audit_event('dataset_abort_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        # 真实标注文件上传：二进制 body + X-Task-Id / X-Rel-Path
        if path.startswith('/api/annotation/upload'):
            if not check_upload_token(self):
                audit_event('annotation_upload_denied', ip=self.client_address[0], reason='invalid_token')
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            task_id = self.headers.get('X-Task-Id') or ''
            rel_path = urllib.parse.unquote(self.headers.get('X-Rel-Path') or '')
            if not task_id or not rel_path:
                self._json(400, {'ok': False, 'error': 'X-Task-Id and X-Rel-Path required'})
                return
            try:
                info = save_annotation_file(task_id, rel_path, post_data or b'')
                audit_event('annotation_upload_ok', ip=self.client_address[0], taskId=task_id, path=rel_path, bytes=len(post_data or b''))
                self._json(200, {'ok': True, 'file': info})
            except Exception as e:
                audit_event('annotation_upload_failed', ip=self.client_address[0], taskId=task_id, path=rel_path, error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        # 把本机已落盘的任务打包并分片写入云端 patents，供全员导出
        if path.startswith('/api/annotation/share-cloud'):
            if not check_upload_token(self):
                audit_event('annotation_share_denied', ip=self.client_address[0], reason='invalid_token')
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
            except json.JSONDecodeError as e:
                self._json(400, {'ok': False, 'error': f'invalid json: {e}'})
                return
            task_id = str(payload.get('taskId') or payload.get('task_id') or '').strip()
            if not task_id:
                self._json(400, {'ok': False, 'error': 'taskId required'})
                return
            try:
                meta = share_annotation_task_to_cloud(task_id)
                audit_event('annotation_share_ok', ip=self.client_address[0], taskId=task_id, bytes=meta.get('bytes'), chunks=meta.get('chunks'))
                self._json(200, {'ok': True, 'share': meta})
            except FileNotFoundError as e:
                self._json(404, {'ok': False, 'error': str(e)})
            except urllib.error.HTTPError as e:
                detail = e.read().decode('utf-8', errors='ignore')
                audit_event('annotation_share_failed', ip=self.client_address[0], taskId=task_id, error=detail or str(e))
                self._json(400, {'ok': False, 'error': detail or str(e)})
            except Exception as e:
                audit_event('annotation_share_failed', ip=self.client_address[0], taskId=task_id, error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/mlops/report'):
            if not check_token(self):
                audit_event('mlops_report_denied', ip=self.client_address[0], reason='invalid_token')
                self._json(401, {'ok': False, 'error': 'invalid token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
            except json.JSONDecodeError as e:
                self._json(400, {'ok': False, 'error': f'invalid json: {e}'})
                return
            if not (payload.get('jobId') or payload.get('job_id') or payload.get('name')):
                self._json(400, {'ok': False, 'error': 'jobId or name required'})
                return
            job = upsert_job(payload)
            audit_event('mlops_report_ok', ip=self.client_address[0], jobId=job.get('jobId'), status=job.get('status'))
            self._json(200, {'ok': True, 'job': job})
            return

        if path.startswith('/api/aliyun'):
            if AUTH_REQUIRED and not check_gateway_session(self, ('admin', 'leader', 'student')):
                self._json(401, {'ok': False, 'error': 'authenticated session required'})
                return
            try:
                request_data = json.loads((post_data or b'{}').decode('utf-8'))
                api_key = request_data.get('apiKey')
                model = request_data.get('model', 'qwen3.6-plus')
                messages = request_data.get('messages', [{'role': 'user', 'content': 'Hello'}])
                temperature = request_data.get('temperature', 0.7)
                max_tokens = request_data.get('max_tokens', 1000)

                if not api_key:
                    self.send_error(400, 'API key is required')
                    return

                aliyun_url = 'https://dashscope.aliyuncs.com/api/v1/chat/completions'
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {api_key}'
                }
                payload = {
                    'model': model,
                    'messages': messages,
                    'temperature': temperature,
                    'max_tokens': max_tokens
                }
                req = urllib.request.Request(
                    aliyun_url,
                    data=json.dumps(payload).encode('utf-8'),
                    headers=headers,
                    method='POST'
                )
                with urllib.request.urlopen(req) as response:
                    response_data = response.read().decode('utf-8')
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self._cors()
                    self.end_headers()
                    self.wfile.write(response_data.encode('utf-8'))
            except json.JSONDecodeError as e:
                self.send_error(400, f'Invalid JSON: {e}')
            except urllib.error.HTTPError as e:
                error_data = e.read().decode('utf-8')
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self._cors()
                self.end_headers()
                self.wfile.write(error_data.encode('utf-8'))
            except Exception as e:
                import traceback
                traceback.print_exc()
                self.send_error(500, f'Internal server error: {e}')
            return

        if path.startswith('/api/baidu-ocr'):
            if AUTH_REQUIRED and not check_gateway_session(self, ('admin', 'leader', 'student')):
                self._json(401, {'ok': False, 'error': 'authenticated session required'})
                return
            try:
                request_data = json.loads((post_data or b'{}').decode('utf-8') or '{}')
            except json.JSONDecodeError as e:
                self._json(400, {'error': 'invalid json: %s' % e})
                return
            image = request_data.get('image') or ''
            accurate = bool(request_data.get('accurate'))
            try:
                result = run_baidu_ocr(image, accurate=accurate)
                audit_event('baidu_ocr_ok', ip=self.client_address[0], words=len(result.get('words_result') or []))
                self._json(200, result)
            except RuntimeError as e:
                audit_event('baidu_ocr_denied', ip=self.client_address[0], error=str(e))
                self._json(503, {'error': str(e)})
            except Exception as e:
                audit_event('baidu_ocr_failed', ip=self.client_address[0], error=str(e))
                self._json(500, {'error': str(e)})
            return

        # CSP 违规上报收集：Report-Only 阶段持续排查，确认无误伤后再切强制策略。
        if path.startswith('/api/csp-report'):
            try:
                raw = (post_data or b'')[:4096].decode('utf-8', errors='ignore')
                try:
                    parsed_report = json.loads(raw or '{}')
                    rep = parsed_report.get('csp-report') or parsed_report or {}
                except Exception:
                    rep = {'raw': raw}
                audit_event(
                    'csp_violation',
                    ip=self.client_address[0],
                    documentUri=rep.get('document-uri') or rep.get('documentURL') or '',
                    violatedDirective=rep.get('violated-directive') or rep.get('effectiveDirective') or '',
                    blockedUri=rep.get('blocked-uri') or rep.get('blockedURL') or '',
                )
            except Exception:
                pass
            self._json(200, {'ok': True})
            return

        self.send_error(404, 'Not found')

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == '/api/auth/me':
            claims = check_gateway_session(self)
            if not claims:
                self._json(401, {'ok': False, 'error': 'invalid or expired session'})
                return
            self._json(200, {
                'ok': True,
                'user': {
                    'id': claims.get('sub'),
                    'studentId': claims.get('sid'),
                    'realName': claims.get('name'),
                    'role': claims.get('role'),
                    'mustChangePwd': bool(claims.get('mustChangePwd')),
                },
                'expiresAt': int(claims.get('exp') or 0) * 1000,
            })
            return

        if path == '/api/auth/admin/accounts':
            claims = _request_claims(self, ('admin',))
            if not claims:
                self._json(403, {'ok': False, 'error': 'admin session required'})
                return
            try:
                accounts = load_gateway_accounts(force=True)
                self._json(200, {
                    'ok': True,
                    'digest': _gateway_accounts_digest(accounts),
                    'accounts': [_public_gateway_account(item) for item in accounts],
                })
            except Exception as exc:
                logger.exception('account list failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'account service unavailable'})
            return

        if path == '/api/sync':
            if not POSTGRES_DATA_BACKEND:
                self._json(503, {'ok': False, 'error': 'gateway sync backend is not enabled'})
                return
            claims = _request_claims(self)
            if not claims:
                status, body = _auth_denied_response(self)
                self._json(status, body)
                return
            try:
                requested_keys = [
                    value.strip()
                    for value in (qs.get('key') or [])
                    if value.strip() in APP_SYNC_KEYS
                ]
                keys = requested_keys or sorted(APP_SYNC_KEYS)
                keys = [
                    key for key in keys
                    if sync_policy.can_read(claims, key)
                ]
                items = data_store.list_sync_values(keys)
                for item in items:
                    item['value'] = sync_policy.filter_read_value(
                        item.get('syncKey', ''),
                        item.get('value'),
                        claims,
                    )
                self._json(200, {'ok': True, 'items': items})
            except Exception as exc:
                logger.exception('sync read failed: %s', exc)
                self._json(503, {'ok': False, 'error': 'sync storage unavailable'})
            return

        if path.startswith('/api/storage/usage'):
            if AUTH_REQUIRED and not check_gateway_session(self, ('admin', 'leader')):
                self._json(403, {'ok': False, 'error': 'admin or leader session required'})
                return
            # 全系统存储协同视图：应用各模块真实占用 + 磁盘物理容量 + 各路径上限。
            usage = compute_storage_usage()
            disk = {}
            try:
                probe = SHARED_FILE_UPLOAD_ROOT if os.path.isdir(SHARED_FILE_UPLOAD_ROOT) else BASE_DIR
                du = shutil.disk_usage(probe)
                disk = {
                    'totalGB': round(du.total / (1024 ** 3), 2),
                    'freeGB': round(du.free / (1024 ** 3), 2),
                    'usedPercent': round(du.used / du.total * 100, 1) if du.total else 0,
                }
            except Exception:
                disk = {}
            self._json(200, {
                'ok': True,
                'time': _now_iso(),
                'storageBackend': SHARED_STORAGE_BACKEND,
                'usage': usage,
                'disk': disk,
                'limits': {
                    'sharedGatewayMaxBytes': MAX_UPLOAD_BYTES,
                    'sharedPresignMaxBytes': SINGLE_PUT_MAX_BYTES,
                    'datasetMaxBytes': MAX_DATASET_BYTES,
                    'datasetChunkSize': DATASET_CHUNK_SIZE,
                },
            })
            return

        if path == '/api/health' or path.startswith('/api/health'):
            database_ready = not POSTGRES_DATA_BACKEND
            if POSTGRES_DATA_BACKEND:
                try:
                    database_ready = data_store.healthcheck()
                except Exception:
                    database_ready = False
            minio_ready = False
            if SHARED_STORAGE_BACKEND == 'minio':
                try:
                    minio_ready = bool(_get_minio_client())
                except Exception:
                    minio_ready = False
            clamav_ready = False
            if CLAMAV_SCAN:
                clamav_ready = bool(shutil.which(CLAMSCAN_BIN))
            presign_https_ok = _presign_https_ok()
            presign_enabled = SHARED_STORAGE_BACKEND == 'minio' and minio_ready and presign_https_ok
            # 磁盘水位探活：避免“进程活着但盘满”的假活故障
            disk = {}
            try:
                probe_path = SHARED_FILE_UPLOAD_ROOT if os.path.isdir(SHARED_FILE_UPLOAD_ROOT) else BASE_DIR
                du = shutil.disk_usage(probe_path)
                disk = {
                    'path': probe_path,
                    'totalGB': round(du.total / (1024 ** 3), 2),
                    'freeGB': round(du.free / (1024 ** 3), 2),
                    'usedPercent': round(du.used / du.total * 100, 1) if du.total else 0,
                }
            except Exception:
                disk = {}
            minio_ok = (SHARED_STORAGE_BACKEND != 'minio') or minio_ready
            disk_ok = disk.get('usedPercent', 0) < 90
            # ready=依赖就绪；ok 保持进程存活（liveness），避免依赖抖动触发重启风暴
            ready = bool(database_ready and minio_ok and disk_ok)
            self._json(200, {
                'ok': True,
                'ready': ready,
                'degraded': not ready,
                'service': 'citysafe-gateway',
                'time': _now_iso(),
                'bindHost': BIND_HOST,
                'environment': CITYSAFE_ENV,
                'authRequired': AUTH_REQUIRED,
                'authConfigured': bool(AUTH_SIGNING_SECRET),
                'dataBackend': DATA_BACKEND,
                'databaseReady': database_ready,
                'storageBackend': SHARED_STORAGE_BACKEND,
                'minioReady': minio_ready,
                'presignEnabled': presign_enabled,
                'presignHttpsOk': presign_https_ok,
                'clamavEnabled': CLAMAV_SCAN,
                'clamavReady': clamav_ready,
                'clamscanBin': CLAMSCAN_BIN if CLAMAV_SCAN else None,
                'disk': disk,
                'metrics': _health_metrics_snapshot(),
                'checks': {
                    'dataset': True,
                    'sharedFile': True,
                    'mlops': True,
                    'database': database_ready,
                    'minio': minio_ok,
                    'disk': disk_ok,
                },
            })
            return

        if path.startswith('/api/dataset/health'):
            self._json(200, {
                'ok': True,
                'service': 'dataset',
                'tokenRequired': bool(DATASET_UPLOAD_TOKEN),
                'maxBytes': MAX_DATASET_BYTES,
                'chunkSize': DATASET_CHUNK_SIZE,
                'time': _now_iso(),
            })
            return

        if path.startswith('/api/shared-file/health'):
            minio_ready = bool(_get_minio_client()) if SHARED_STORAGE_BACKEND == 'minio' else False
            self._json(200, {
                'ok': True,
                'service': 'shared-file',
                'tokenRequired': bool(DATASET_UPLOAD_TOKEN),
                'maxBytes': MAX_UPLOAD_BYTES,
                'storageBackend': SHARED_STORAGE_BACKEND,
                'minioReady': minio_ready,
                'presignEnabled': SHARED_STORAGE_BACKEND == 'minio' and minio_ready,
                'time': _now_iso(),
            })
            return

        if path.startswith('/api/shared-file/download'):
            if not check_dataset_token(self):
                audit_event('shared_download_denied', ip=self.client_address[0], reason='invalid_token')
                self._json(401, {'ok': False, 'error': 'invalid download token'})
                return
            file_id = (qs.get('fileId') or [''])[0]
            try:
                meta = get_shared_file_meta(file_id)
                filename = meta.get('fileName') or file_id
                if meta.get('storage') == 'minio' and meta.get('objectKey'):
                    client = _get_minio_client()
                    if not client:
                        raise FileNotFoundError('minio unavailable')
                    _stream_minio_download(
                        self,
                        client,
                        meta['objectKey'],
                        filename,
                    )
                    return
                path_file = meta.get('path')
                size = os.path.getsize(path_file)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.send_header('Content-Disposition', _content_disposition(filename))
                self._cors()
                self.end_headers()
                with open(path_file, 'rb') as f:
                    while True:
                        buf = f.read(1024 * 1024)
                        if not buf:
                            break
                        self.wfile.write(buf)
            except Exception as e:
                self._json(404, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/status'):
            claims = _dataset_request_claims(
                self,
                ('admin', 'leader', 'student'),
            )
            if not claims:
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            upload_id = (qs.get('uploadId') or [''])[0]
            try:
                self._json(200, get_dataset_upload_status(
                    upload_id,
                    actor=_claims_actor(claims),
                    role=claims.get('role'),
                ))
            except PermissionError as e:
                self._json(403, {'ok': False, 'error': str(e)})
            except Exception as e:
                self._json(404, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/inspect'):
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            file_id = (qs.get('fileId') or [''])[0]
            try:
                meta = get_dataset_file_meta(file_id)
                inspect = inspect_dataset_file(meta.get('path'), meta.get('fileName'))
                self._json(200, {'ok': True, 'fileId': file_id, 'inspect': inspect, 'meta': {
                    'fileName': meta.get('fileName'), 'size': meta.get('size'), 'md5': meta.get('md5')
                }})
            except Exception as e:
                self._json(404, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/sample'):
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            file_id = (qs.get('fileId') or [''])[0]
            member = (qs.get('path') or [''])[0]
            try:
                data, mime, filename = read_dataset_zip_sample(file_id, member)
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Content-Disposition', _content_disposition(filename, 'inline'))
                self._cors()
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/download'):
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            file_id = (qs.get('fileId') or [''])[0]
            try:
                meta = get_dataset_file_meta(file_id)
                path_file = meta.get('path')
                size = os.path.getsize(path_file)
                filename = meta.get('fileName') or os.path.basename(path_file)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.send_header('Content-Disposition', _content_disposition(filename))
                self._cors()
                self.end_headers()
                with open(path_file, 'rb') as f:
                    while True:
                        buf = f.read(1024 * 1024)
                        if not buf:
                            break
                        self.wfile.write(buf)
            except Exception as e:
                self._json(404, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/annotation/files'):
            if not check_upload_token(self):
                self._json(401, {'ok': False, 'error': 'invalid annotation token'})
                return
            task_id = (qs.get('taskId') or [''])[0]
            try:
                files = list_annotation_files(task_id)
                self._json(200, {'ok': True, 'taskId': task_id, 'files': files, 'count': len(files)})
            except Exception as e:
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/annotation/export'):
            if not check_upload_token(self):
                self._json(401, {'ok': False, 'error': 'invalid annotation token'})
                return
            task_id = (qs.get('taskId') or [''])[0]
            try:
                raw = zip_annotation_task(task_id)
                filename = 'annotation-task-%s.zip' % task_id
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Disposition', _content_disposition(filename))
                self.send_header('Content-Length', str(len(raw)))
                self._cors()
                self.end_headers()
                self.wfile.write(raw)
            except FileNotFoundError:
                self._json(404, {'ok': False, 'error': 'no uploaded files for this task'})
            except Exception as e:
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/annotation/fetch-cloud'):
            if not check_upload_token(self):
                self._json(401, {'ok': False, 'error': 'invalid annotation token'})
                return
            task_id = (qs.get('taskId') or [''])[0]
            try:
                raw, meta = fetch_annotation_task_from_cloud(task_id)
                filename = 'annotation-task-%s.zip' % task_id
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Disposition', _content_disposition(filename))
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('X-Cloud-Share-Bytes', str(meta.get('bytes') or len(raw)))
                self._cors()
                self.end_headers()
                self.wfile.write(raw)
            except FileNotFoundError as e:
                self._json(404, {'ok': False, 'error': str(e)})
            except Exception as e:
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/mlops/jobs'):
            if AUTH_REQUIRED and not check_token(self):
                self._json(401, {'ok': False, 'error': 'invalid MLOps token or session'})
                return
            store = load_mlops_store()
            self._json(200, {
                'ok': True,
                'updatedAt': store.get('updatedAt'),
                'jobs': store.get('jobs') or [],
                'endpoint': '/api/mlops/report',
                'tokenHint': 'Header X-MLOps-Token or Authorization: Bearer <token>'
            })
            return

        if path.startswith('/api/mlops/health'):
            self._json(200, {
                'ok': True,
                'service': 'mlops',
                'tokenConfigured': bool(MLOPS_TOKEN),
                'time': _now_iso()
            })
            return

        # 静态文件
        try:
            file_path = resolve_static_file_path(path)
            if path == '/':
                path = '/index.html'
            with open(file_path, 'rb') as f:
                content = f.read()
            if path.endswith('.html'):
                content_type = 'text/html; charset=utf-8'
            elif path.endswith('.js'):
                content_type = 'text/javascript'
            elif path.endswith('.css'):
                content_type = 'text/css'
            elif path.endswith('.json'):
                content_type = 'application/json'
            else:
                content_type = 'application/octet-stream'
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            # 缓存策略（与生产 Nginx 一致，保证内容哈希 cache-busting 生效）：
            # 带 ?v= 的哈希化 js/css/模块html 可长缓存 immutable；入口 index.html 及无版本资源
            # 必须 no-cache 每次 revalidate，否则浏览器复用旧 index.html 就看不到新的 ?v=。
            versioned = bool(qs.get('v'))
            if versioned and (path.endswith('.js') or path.endswith('.css') or path.endswith('.html')):
                self.send_header('Cache-Control', 'public, max-age=604800, immutable')
            else:
                self.send_header('Cache-Control', 'no-cache, must-revalidate')
            self._cors()
            self.end_headers()
            self.wfile.write(content)
        except PermissionError:
            self.send_error(404, 'File not found')
        except FileNotFoundError:
            self.send_error(404, 'File not found')
        except Exception as e:
            self.send_error(500, f'Internal server error: {e}')


def validate_runtime_config():
    errors = []
    if POSTGRES_DATA_BACKEND and not data_store.database_enabled():
        errors.append('PostgreSQL is required: configure DATABASE_URL or standard PG* variables')
    if DATASET_CHUNK_SIZE < DATASET_MIN_CHUNK_BYTES or DATASET_CHUNK_SIZE > DATASET_MAX_CHUNK_BYTES:
        errors.append(
            'DATASET_CHUNK_SIZE must be between %s and %s bytes'
            % (DATASET_MIN_CHUNK_BYTES, DATASET_MAX_CHUNK_BYTES)
        )
    if AUTH_REQUIRED:
        if len(AUTH_SIGNING_SECRET.encode('utf-8')) < 32:
            errors.append('AUTH_SIGNING_SECRET must contain at least 32 bytes when AUTH_REQUIRED=1')
        if not POSTGRES_DATA_BACKEND and (not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY):
            errors.append('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when AUTH_REQUIRED=1')
    if CITYSAFE_ENV == 'production':
        if not AUTH_REQUIRED:
            errors.append('AUTH_REQUIRED=1 is mandatory in production')
        if ALLOW_INSECURE_LOCAL_WRITES:
            errors.append('ALLOW_INSECURE_LOCAL_WRITES must be 0 in production')
        if '*' in CORS_ALLOW_ORIGINS:
            errors.append('wildcard CORS is forbidden in production')
        if SUPABASE_URL and not SUPABASE_URL.lower().startswith('https://'):
            errors.append('SUPABASE_URL must use HTTPS in production')
        if MINIO_ALLOW_INSECURE_PRESIGN:
            errors.append('MINIO_ALLOW_INSECURE_PRESIGN must be 0 in production')
        if MINIO_PUBLIC_UPLOAD_PREFIX and not MINIO_PUBLIC_UPLOAD_PREFIX.lower().startswith('https://'):
            errors.append('MINIO_PUBLIC_UPLOAD_PREFIX must use HTTPS in production')
        if not MLOPS_TOKEN:
            errors.append('MLOPS_TOKEN is required in production')
    if errors:
        raise RuntimeError('invalid runtime configuration: ' + '; '.join(errors))
    return True


def run_server(port=8000):
    try:
        validate_runtime_config()
        os.makedirs(CITYSAFE_STATE_DIR, exist_ok=True)
        os.makedirs(ANNOTATION_UPLOAD_ROOT, exist_ok=True)
        os.makedirs(DATASET_UPLOAD_ROOT, exist_ok=True)
        os.makedirs(os.path.join(DATASET_UPLOAD_ROOT, 'files'), exist_ok=True)
        os.makedirs(SHARED_FILE_UPLOAD_ROOT, exist_ok=True)
        os.makedirs(os.path.join(SHARED_FILE_UPLOAD_ROOT, 'files'), exist_ok=True)
        bootstrap_gateway_admin()
        server_address = (BIND_HOST, port)
        httpd = ThreadingHTTPServer(server_address, WorkingProxyHandler)
        logger.info('server running at http://%s:%s', BIND_HOST or '0.0.0.0', port)
        logger.info('api proxy: http://localhost:%s/api/aliyun', port)
        logger.info('baidu ocr: POST http://localhost:%s/api/baidu-ocr', port)
        logger.info('mlops report: POST http://localhost:%s/api/mlops/report', port)
        logger.info('dataset upload: POST http://localhost:%s/api/dataset/init|chunk|complete', port)
        logger.info('gateway auth: required=%s configured=%s ttl=%ss', AUTH_REQUIRED, bool(AUTH_SIGNING_SECRET), AUTH_SESSION_TTL_SECONDS)
        if not BAIDU_OCR_API_KEY or not BAIDU_OCR_SECRET_KEY:
            logger.warning('BAIDU_OCR_* is not configured; scanned PDF OCR will fall back to cloud worker if available')
        logger.info('annotation upload: POST http://localhost:%s/api/annotation/upload', port)
        logger.info('annotation export: GET http://localhost:%s/api/annotation/export?taskId=...', port)
        if not MLOPS_TOKEN:
            logger.warning('MLOPS_TOKEN is not configured; /api/mlops/report will reject writes')
        if not ANNOTATION_UPLOAD_TOKEN:
            logger.warning('ANNOTATION_UPLOAD_TOKEN is not configured; /api/annotation/upload will reject writes')
        if not DATASET_UPLOAD_TOKEN:
            if ALLOW_INSECURE_LOCAL_WRITES:
                logger.warning('DATASET_UPLOAD_TOKEN not set; insecure file access is enabled for loopback clients only')
            else:
                logger.warning('DATASET_UPLOAD_TOKEN not set; dataset/shared-file access will reject requests')
        if not POSTGRES_DATA_BACKEND and (not SUPABASE_URL or not SUPABASE_KEY):
            logger.warning('SUPABASE_URL/SUPABASE_KEY not configured; server-side cloud sync disabled')
        httpd.serve_forever()
    except Exception as e:
        import traceback
        logger.error('server error: %s', e)
        traceback.print_exc()
        raise


if __name__ == '__main__':
    run_server()
