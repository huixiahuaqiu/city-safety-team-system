"""Production-ready local gateway: static files, AI proxy, MLOps and annotation APIs."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import base64
import hashlib
import json
import logging
import os
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
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
DATASET_UPLOAD_TOKEN = os.environ.get('DATASET_UPLOAD_TOKEN', '') or os.environ.get('ANNOTATION_UPLOAD_TOKEN', '')
# 生产网络加固：监听地址与 CORS 来源，默认值保持本地开发行为不变。
# 生产 .env 建议设 BIND_HOST=127.0.0.1（只允许 Nginx 反代）与 CORS_ALLOW_ORIGIN=https://你的域名。
BIND_HOST = os.environ.get('BIND_HOST', '0.0.0.0')
CORS_ALLOW_ORIGIN = os.environ.get('CORS_ALLOW_ORIGIN', '*')
MINIO_PRESIGN_EXPIRE = int(os.environ.get('MINIO_PRESIGN_EXPIRE', '600'))
MINIO_PUBLIC_UPLOAD_PREFIX = (os.environ.get('MINIO_PUBLIC_UPLOAD_PREFIX') or '').strip().rstrip('/')
MINIO_PRESIGN_MAX_BYTES = int(os.environ.get('MINIO_PRESIGN_MAX_BYTES', str(MAX_DATASET_BYTES)))
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

_baidu_ocr_token = {'access_token': '', 'expire_at': 0}
_store_lock = threading.Lock()

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
    """把 MLOps jobs 合并写入 Supabase modelTrainingData 同步键。"""
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


def audit_event(event, **fields):
    payload = {'event': event, 'time': _now_iso()}
    payload.update(fields)
    logger.info('AUDIT %s', json.dumps(payload, ensure_ascii=False, sort_keys=True))


def sniff_allowed_upload(content, filename):
    """Magic-byte / content sniffing secondary gate; allow-list remains primary."""
    ext = os.path.splitext(str(filename or '').lower())[1]
    if ext in DANGEROUS_UPLOAD_EXTENSIONS:
        raise ValueError('dangerous file extension not allowed: %s' % ext)
    head = (content or b'')[:512].lstrip().lower()
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


def check_token(handler):
    if not MLOPS_TOKEN:
        return False
    auth = handler.headers.get('Authorization') or ''
    token = handler.headers.get('X-MLOps-Token') or ''
    if auth.lower().startswith('bearer '):
        token = auth[7:].strip() or token
    q = urllib.parse.urlparse(handler.path).query
    qs = urllib.parse.parse_qs(q)
    if qs.get('token'):
        token = qs['token'][0]
    return secrets.compare_digest(str(token), str(MLOPS_TOKEN))


def check_upload_token(handler):
    if not ANNOTATION_UPLOAD_TOKEN:
        return False
    token = handler.headers.get('X-Upload-Token') or ''
    auth = handler.headers.get('Authorization') or ''
    if auth.lower().startswith('bearer '):
        token = auth[7:].strip() or token
    return secrets.compare_digest(str(token), str(ANNOTATION_UPLOAD_TOKEN))


def check_dataset_token(handler):
    """本地网关：未配置 token 时允许数据集上传；配置后必须校验。"""
    if not DATASET_UPLOAD_TOKEN:
        return True
    token = handler.headers.get('X-Upload-Token') or handler.headers.get('X-Dataset-Token') or ''
    auth = handler.headers.get('Authorization') or ''
    if auth.lower().startswith('bearer '):
        token = auth[7:].strip() or token
    return secrets.compare_digest(str(token), str(DATASET_UPLOAD_TOKEN))


def _safe_dataset_id(value):
    tid = ''.join(c for c in str(value or '') if c.isalnum() or c in ('-', '_'))
    if not tid:
        raise ValueError('invalid dataset/upload id')
    return tid


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


def abort_dataset_upload(upload_id):
    """取消未完成上传并删除临时分片（成功入库的文件不动）。"""
    uid = _safe_dataset_id(upload_id)
    if not uid:
        raise ValueError('uploadId required')
    bytes_removed = _remove_dataset_upload_dir(uid)

    def _mutate(reg):
        existed = uid in (reg.get('uploads') or {})
        reg.setdefault('uploads', {}).pop(uid, None)
        return existed

    existed = _dataset_registry_update(_mutate)
    return {
        'ok': True,
        'uploadId': uid,
        'removed': existed or bytes_removed > 0,
        'bytesRemoved': bytes_removed,
    }


def purge_incomplete_dataset_uploads(md5=None, size=None):
    """清理未完成会话。md5/size 给定时只清匹配项，否则清全部未完成。"""
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
            total_bytes += _remove_dataset_upload_dir(uid)
            purged.append(uid)
        except Exception:
            pass

    def _mutate(reg2):
        for uid in purged:
            reg2.setdefault('uploads', {}).pop(uid, None)
        return len(purged)

    _dataset_registry_update(_mutate)
    return {'ok': True, 'purged': purged, 'count': len(purged), 'bytesRemoved': total_bytes}


def init_dataset_upload(payload):
    file_name = str(payload.get('fileName') or payload.get('name') or 'dataset.bin')
    size = int(payload.get('size') or 0)
    md5 = str(payload.get('md5') or '').strip().lower()
    chunk_size = int(payload.get('chunkSize') or DATASET_CHUNK_SIZE)
    if size <= 0:
        raise ValueError('文件大小无效（不能为 0），请选择有效文件')
    if size > MAX_DATASET_BYTES:
        raise ValueError('文件过大：最大允许 %s 字节' % MAX_DATASET_BYTES)
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
        }

    # 未成功上传不留存：同文件旧的未完成分片先清掉，再开新会话
    if md5:
        purge_incomplete_dataset_uploads(md5=md5, size=size)

    upload_id = _safe_dataset_id(payload.get('uploadId') or ('up_' + secrets.token_hex(8)))
    up_dir = _dataset_upload_dir(upload_id)
    os.makedirs(up_dir, exist_ok=True)

    def _mutate(reg):
        reg['uploads'][upload_id] = {
            'uploadId': upload_id,
            'fileName': file_name,
            'size': size,
            'md5': md5,
            'chunkSize': chunk_size,
            'createdAt': _now_iso(),
            'updatedAt': _now_iso(),
            'received': [],
        }
        return None

    _dataset_registry_update(_mutate)
    return {
        'uploadId': upload_id,
        'exists': False,
        'instant': False,
        'uploadedChunks': [],
        'chunkSize': chunk_size,
        'size': size,
        'md5': md5,
    }


def save_dataset_chunk(upload_id, index, content, total_chunks=None):
    index = int(index)
    if index < 0:
        raise ValueError('分片序号无效')
    if len(content) > DATASET_CHUNK_SIZE * 2:
        raise ValueError('分片过大')
    up_dir = _dataset_upload_dir(upload_id)
    os.makedirs(up_dir, exist_ok=True)
    part_path = os.path.join(up_dir, 'chunk_%d.part' % index)
    tmp_path = part_path + '.tmp'
    with open(tmp_path, 'wb') as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, part_path)

    def _mutate(reg):
        meta = reg['uploads'].get(upload_id) or {
            'uploadId': upload_id,
            'received': [],
            'createdAt': _now_iso(),
        }
        received = set(meta.get('received') or [])
        received.add(index)
        meta['received'] = sorted(received)
        if total_chunks is not None:
            meta['totalChunks'] = int(total_chunks)
        meta['updatedAt'] = _now_iso()
        reg['uploads'][upload_id] = meta
        return {
            'ok': True,
            'index': index,
            'received': len(meta['received']),
            'bytes': len(content),
        }

    return _dataset_registry_update(_mutate)


def complete_dataset_upload(payload):
    upload_id = _safe_dataset_id(payload.get('uploadId'))
    reg = _dataset_registry_load()
    meta = reg['uploads'].get(upload_id)
    if not meta:
        raise FileNotFoundError('upload session not found')
    file_name = str(payload.get('fileName') or meta.get('fileName') or 'dataset.bin')
    expect_size = int(payload.get('size') or meta.get('size') or 0)
    expect_md5 = str(payload.get('md5') or meta.get('md5') or '').strip().lower()
    chunk_size = int(meta.get('chunkSize') or DATASET_CHUNK_SIZE)
    up_dir = _dataset_upload_dir(upload_id)
    if not os.path.isdir(up_dir):
        raise FileNotFoundError('upload chunks missing')

    received = sorted(meta.get('received') or [])
    if not received:
        raise ValueError('no chunks uploaded')
    total_chunks = int(meta.get('totalChunks') or (max(received) + 1))
    missing = [i for i in range(total_chunks) if i not in set(received)]
    if missing:
        raise ValueError('missing chunks: %s' % missing[:20])

    file_id = _safe_dataset_id(payload.get('fileId') or ('dsf_' + secrets.token_hex(8)))
    final_path = _dataset_final_path(file_id, file_name)
    os.makedirs(os.path.dirname(final_path), exist_ok=True)

    hasher = hashlib.md5()
    written = 0
    with open(final_path, 'wb') as out:
        for i in range(total_chunks):
            part_path = os.path.join(up_dir, 'chunk_%d.part' % i)
            with open(part_path, 'rb') as inp:
                while True:
                    buf = inp.read(1024 * 1024)
                    if not buf:
                        break
                    out.write(buf)
                    hasher.update(buf)
                    written += len(buf)

    actual_md5 = hasher.hexdigest()
    if expect_size and written != expect_size:
        try:
            os.remove(final_path)
        except OSError:
            pass
        raise ValueError('size mismatch: got %s expect %s' % (written, expect_size))
    if expect_md5 and actual_md5 != expect_md5:
        # 前端可能只给了轻量指纹；仅在双方都是 32 位 hex 时强制校验
        if len(expect_md5) == 32 and all(c in '0123456789abcdef' for c in expect_md5):
            try:
                os.remove(final_path)
            except OSError:
                pass
            raise ValueError('md5 mismatch')

    with open(final_path, 'rb') as _sniff_f:
        sniff_allowed_upload(_sniff_f.read(512), file_name)
    enforce_clamav_scan(final_path, context='dataset_complete')

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
        'inspect': inspect,
    }
    reg = _dataset_registry_load()
    reg['files'][file_id] = file_meta
    reg['uploads'].pop(upload_id, None)
    _dataset_registry_save(reg)

    # 清理临时分片
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


def get_dataset_upload_status(upload_id):
    upload_id = _safe_dataset_id(upload_id)
    reg = _dataset_registry_load()
    meta = reg['uploads'].get(upload_id)
    if not meta:
        raise FileNotFoundError('upload session not found')
    return {
        'ok': True,
        'uploadId': upload_id,
        'uploadedChunks': meta.get('received') or [],
        'size': meta.get('size'),
        'md5': meta.get('md5'),
        'fileName': meta.get('fileName'),
        'chunkSize': meta.get('chunkSize') or DATASET_CHUNK_SIZE,
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
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    count = i + 1
                    if i < 101:
                        preview_lines.append(line.rstrip('\n'))
            result['sampleCount'] = max(0, count - 1)
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
            result['note'] = 'CSV/TSV 已统计记录数与字段'
        elif ext == '.json':
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
    reg = _shared_registry_load()
    reg['files'][file_id] = meta
    _shared_registry_save(reg)
    return meta


def get_shared_file_meta(file_id, allow_deleted=False):
    file_id = _safe_dataset_id(file_id)
    reg = _shared_registry_load()
    meta = reg['files'].get(file_id)
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
    reg = _shared_registry_load()
    meta = reg['files'].get(file_id)
    if not meta:
        raise FileNotFoundError('shared file not found')
    meta['deletedAt'] = _now_iso()
    meta['deleted'] = True
    reg['files'][file_id] = meta
    _shared_registry_save(reg)
    return meta


def restore_shared_file(file_id):
    file_id = _safe_dataset_id(file_id)
    reg = _shared_registry_load()
    meta = reg['files'].get(file_id)
    if not meta:
        raise FileNotFoundError('shared file not found')
    meta.pop('deletedAt', None)
    meta['deleted'] = False
    reg['files'][file_id] = meta
    _shared_registry_save(reg)
    return meta


def purge_shared_file(file_id):
    """物理删除：磁盘/MinIO + 注册表。"""
    file_id = _safe_dataset_id(file_id)
    reg = _shared_registry_load()
    meta = reg['files'].pop(file_id, None)
    if not meta:
        raise FileNotFoundError('shared file not found')
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
    _shared_registry_save(reg)
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


def create_shared_presign(file_name, file_type, remark, size, content_type='', original_name=''):
    """签发 MinIO PUT 预签名；文件体不经网关。未启用 minio 时抛错，前端可回退 multipart。"""
    size = int(size or 0)
    if size <= 0:
        raise ValueError('文件大小无效（不能为 0）')
    if size > MINIO_PRESIGN_MAX_BYTES:
        raise ValueError('文件过大：最大允许 %s 字节' % MINIO_PRESIGN_MAX_BYTES)
    client = _get_minio_client()
    if not client:
        raise RuntimeError('对象存储未就绪：请检查 MinIO 配置')
    name = original_name or file_name or 'file'
    ext = os.path.splitext(str(name).lower())[1]
    if ext and ext not in _shared_allow_extensions():
        raise ValueError('file extension not allowed: %s' % ext)
    file_id = 'sf_' + secrets.token_hex(8)
    date_path = datetime.now().strftime('%Y%m')
    safe_name = ''.join(c for c in (file_name or 'file') if c not in '\\/:*?"<>|')[:120] or 'file'
    stored = file_id + (ext or '.bin')
    object_key = 'shared/%s/%s' % (date_path, stored)
    expire = max(60, min(MINIO_PRESIGN_EXPIRE, 3600))
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


def confirm_shared_presign(file_id, md5='', size=None):
    """直传完成后确认：校验对象存在并写入注册表。"""
    file_id = _safe_dataset_id(file_id)
    reg = _shared_registry_load()
    meta = reg['files'].get(file_id)
    if not meta:
        raise FileNotFoundError('shared file not found')
    if not meta.get('pendingConfirm'):
        return meta
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
    actual_size = int(getattr(stat, 'size', 0) or 0)
    expected = int(meta.get('size') or 0)
    if expected and actual_size and actual_size > MINIO_PRESIGN_MAX_BYTES:
        raise ValueError('uploaded object too large')
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
    reg['files'][file_id] = meta
    _shared_registry_save(reg)
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


def share_annotation_task_to_cloud(task_id):
    """Zip local task files and publish as chunked rows in patents (team-wide readable)."""
    raw = zip_annotation_task(task_id)
    if len(raw) > ANNOTATION_BLOB_MAX_BYTES:
        raise ValueError('dataset zip too large for cloud share: %s bytes (max %s)' % (len(raw), ANNOTATION_BLOB_MAX_BYTES))
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


class WorkingProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.info("%s - %s", self.client_address[0], format % args)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN)
        if CORS_ALLOW_ORIGIN != '*':
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
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get('Content-Length') or 0)
        if path.startswith('/api/annotation/upload') and content_length > MAX_UPLOAD_BYTES:
            audit_event('annotation_upload_denied', ip=self.client_address[0], reason='too_large', bytes=content_length)
            self._json(413, {'ok': False, 'error': 'file too large'})
            return
        post_data = self.rfile.read(content_length) if content_length else b''

        # 团队共享文件：multipart 上传到磁盘
        if path.startswith('/api/shared-file/upload'):
            if not check_dataset_token(self):
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
            if not check_dataset_token(self):
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
                )
                audit_event('shared_presign_ok', ip=self.client_address[0], fileId=result.get('fileId'), bytes=payload.get('size'))
                self._json(200, {'ok': True, **result})
            except Exception as e:
                audit_event('shared_presign_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/shared-file/confirm'):
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                meta = confirm_shared_presign(
                    payload.get('fileId') or '',
                    md5=payload.get('md5') or '',
                    size=payload.get('size'),
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
            if not check_dataset_token(self):
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
            if not check_dataset_token(self):
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
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                info = init_dataset_upload(payload)
                audit_event('dataset_init_ok', ip=self.client_address[0], uploadId=info.get('uploadId'), instant=info.get('instant'))
                self._json(200, {'ok': True, **info})
            except Exception as e:
                audit_event('dataset_init_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/chunk'):
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            upload_id = self.headers.get('X-Upload-Id') or ''
            try:
                index = int(self.headers.get('X-Chunk-Index') or -1)
            except ValueError:
                self._json(400, {'ok': False, 'error': 'invalid chunk index'})
                return
            total_raw = self.headers.get('X-Chunk-Total')
            total_chunks = int(total_raw) if total_raw not in (None, '') else None
            if content_length > DATASET_CHUNK_SIZE * 2:
                self._json(413, {'ok': False, 'error': 'chunk too large'})
                return
            try:
                info = save_dataset_chunk(upload_id, index, post_data or b'', total_chunks=total_chunks)
                self._json(200, info)
            except Exception as e:
                audit_event('dataset_chunk_failed', ip=self.client_address[0], uploadId=upload_id, error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/complete'):
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                info = complete_dataset_upload(payload)
                audit_event('dataset_complete_ok', ip=self.client_address[0], fileId=info.get('fileId'), bytes=info.get('size'))
                self._json(200, info)
            except Exception as e:
                audit_event('dataset_complete_failed', ip=self.client_address[0], error=str(e))
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/dataset/abort'):
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            try:
                payload = json.loads((post_data or b'{}').decode('utf-8') or '{}')
                upload_id = payload.get('uploadId') or self.headers.get('X-Upload-Id') or ''
                if payload.get('purgeAll'):
                    info = purge_incomplete_dataset_uploads(
                        md5=payload.get('md5') or None,
                        size=payload.get('size') if payload.get('size') not in (None, '') else None,
                    )
                else:
                    info = abort_dataset_upload(upload_id)
                audit_event('dataset_abort_ok', ip=self.client_address[0], uploadId=upload_id or 'purge', bytes=info.get('bytesRemoved'))
                self._json(200, info)
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

        self.send_error(404, 'Not found')

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == '/api/health' or path.startswith('/api/health'):
            minio_ready = False
            if SHARED_STORAGE_BACKEND == 'minio':
                try:
                    minio_ready = bool(_get_minio_client())
                except Exception:
                    minio_ready = False
            clamav_ready = False
            if CLAMAV_SCAN:
                clamav_ready = bool(shutil.which(CLAMSCAN_BIN))
            self._json(200, {
                'ok': True,
                'service': 'citysafe-gateway',
                'time': _now_iso(),
                'bindHost': BIND_HOST,
                'storageBackend': SHARED_STORAGE_BACKEND,
                'minioReady': minio_ready,
                'presignEnabled': SHARED_STORAGE_BACKEND == 'minio' and minio_ready,
                'clamavEnabled': CLAMAV_SCAN,
                'clamavReady': clamav_ready,
                'clamscanBin': CLAMSCAN_BIN if CLAMAV_SCAN else None,
                'checks': {
                    'dataset': True,
                    'sharedFile': True,
                    'mlops': True,
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
                self._json(401, {'ok': False, 'error': 'invalid upload token'})
                return
            file_id = (qs.get('fileId') or [''])[0]
            try:
                meta = get_shared_file_meta(file_id)
                filename = meta.get('fileName') or file_id
                if meta.get('storage') == 'minio' and meta.get('objectKey'):
                    client = _get_minio_client()
                    if not client:
                        raise FileNotFoundError('minio unavailable')
                    resp = client.get_object(MINIO_BUCKET, meta['objectKey'])
                    try:
                        data = resp.read()
                    finally:
                        resp.close()
                        resp.release_conn()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Content-Disposition', 'attachment; filename="%s"' % filename.replace('"', ''))
                    self._cors()
                    self.end_headers()
                    self.wfile.write(data)
                    return
                path_file = meta.get('path')
                size = os.path.getsize(path_file)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.send_header('Content-Disposition', 'attachment; filename="%s"' % filename.replace('"', ''))
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
            if not check_dataset_token(self):
                self._json(401, {'ok': False, 'error': 'invalid dataset token'})
                return
            upload_id = (qs.get('uploadId') or [''])[0]
            try:
                self._json(200, get_dataset_upload_status(upload_id))
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
                self.send_header('Content-Disposition', 'inline; filename="%s"' % filename.replace('"', ''))
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
                self.send_header('Content-Disposition', 'attachment; filename="%s"' % filename.replace('"', ''))
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
            task_id = (qs.get('taskId') or [''])[0]
            try:
                files = list_annotation_files(task_id)
                self._json(200, {'ok': True, 'taskId': task_id, 'files': files, 'count': len(files)})
            except Exception as e:
                self._json(400, {'ok': False, 'error': str(e)})
            return

        if path.startswith('/api/annotation/export'):
            task_id = (qs.get('taskId') or [''])[0]
            try:
                raw = zip_annotation_task(task_id)
                filename = 'annotation-task-%s.zip' % task_id
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Disposition', 'attachment; filename="%s"' % filename)
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
            task_id = (qs.get('taskId') or [''])[0]
            try:
                raw, meta = fetch_annotation_task_from_cloud(task_id)
                filename = 'annotation-task-%s.zip' % task_id
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Disposition', 'attachment; filename="%s"' % filename)
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
        if path == '/':
            path = '/index.html'
        try:
            file_path = os.path.join(BASE_DIR, path.lstrip('/'))
            file_path = os.path.abspath(file_path)
            if not file_path.startswith(os.path.abspath(BASE_DIR)):
                self.send_error(403, 'Forbidden')
                return
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
            self._cors()
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_error(404, 'File not found')
        except Exception as e:
            self.send_error(500, f'Internal server error: {e}')


def run_server(port=8000):
    try:
        os.makedirs(ANNOTATION_UPLOAD_ROOT, exist_ok=True)
        os.makedirs(DATASET_UPLOAD_ROOT, exist_ok=True)
        os.makedirs(os.path.join(DATASET_UPLOAD_ROOT, 'files'), exist_ok=True)
        os.makedirs(SHARED_FILE_UPLOAD_ROOT, exist_ok=True)
        os.makedirs(os.path.join(SHARED_FILE_UPLOAD_ROOT, 'files'), exist_ok=True)
        server_address = (BIND_HOST, port)
        httpd = ThreadingHTTPServer(server_address, WorkingProxyHandler)
        logger.info('server running at http://%s:%s', BIND_HOST or '0.0.0.0', port)
        logger.info('api proxy: http://localhost:%s/api/aliyun', port)
        logger.info('baidu ocr: POST http://localhost:%s/api/baidu-ocr', port)
        logger.info('mlops report: POST http://localhost:%s/api/mlops/report', port)
        logger.info('dataset upload: POST http://localhost:%s/api/dataset/init|chunk|complete', port)
        if not BAIDU_OCR_API_KEY or not BAIDU_OCR_SECRET_KEY:
            logger.warning('BAIDU_OCR_* is not configured; scanned PDF OCR will fall back to cloud worker if available')
        logger.info('annotation upload: POST http://localhost:%s/api/annotation/upload', port)
        logger.info('annotation export: GET http://localhost:%s/api/annotation/export?taskId=...', port)
        if not MLOPS_TOKEN:
            logger.warning('MLOPS_TOKEN is not configured; /api/mlops/report will reject writes')
        if not ANNOTATION_UPLOAD_TOKEN:
            logger.warning('ANNOTATION_UPLOAD_TOKEN is not configured; /api/annotation/upload will reject writes')
        if not DATASET_UPLOAD_TOKEN:
            logger.info('DATASET_UPLOAD_TOKEN not set; dataset upload allowed on local gateway')
        if not SUPABASE_URL or not SUPABASE_KEY:
            logger.warning('SUPABASE_URL/SUPABASE_KEY not configured; server-side cloud sync disabled')
        httpd.serve_forever()
    except Exception as e:
        import traceback
        logger.error('server error: %s', e)
        traceback.print_exc()


if __name__ == '__main__':
    run_server()
