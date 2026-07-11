"""Production-ready local gateway: static files, AI proxy, MLOps and annotation APIs."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, '.env')
MLOPS_STORE_PATH = os.path.join(BASE_DIR, 'mlops_store.json')
ANNOTATION_UPLOAD_ROOT = os.path.join(BASE_DIR, 'uploads', 'annotations')
AUDIT_LOG_PATH = os.path.join(BASE_DIR, 'logs', 'server_audit.log')


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

MLOPS_TOKEN = os.environ.get('MLOPS_TOKEN', '')
ANNOTATION_UPLOAD_TOKEN = os.environ.get('ANNOTATION_UPLOAD_TOKEN', '')
MAX_UPLOAD_BYTES = int(os.environ.get('MAX_UPLOAD_BYTES', str(200 * 1024 * 1024)))
ALLOWED_UPLOAD_EXTENSIONS = {
    ext.strip().lower()
    for ext in os.environ.get(
        'ALLOWED_UPLOAD_EXTENSIONS',
        '.jpg,.jpeg,.png,.bmp,.webp,.gif,.txt,.xml,.csv,.json,.yaml,.yml',
    ).split(',')
    if ext.strip()
}

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
CLOUD_SYNC_MARK = '__APP_SYNC__'
CLOUD_SYNC_PN = '__SYNC_KV__modelTrainingData'

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
            + '&select=id,abstract'
        )
        req = urllib.request.Request(q, headers=headers, method='GET')
        with urllib.request.urlopen(req, timeout=15) as resp:
            rows = json.loads(resp.read().decode('utf-8'))
        existing = []
        row_id = None
        if rows:
            row_id = rows[0].get('id')
            try:
                existing = json.loads(rows[0].get('abstract') or '[]')
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
            'classification': CLOUD_SYNC_MARK,
            'patent_number': CLOUD_SYNC_PN,
            'title': 'APP_SYNC:modelTrainingData',
            'abstract': json.dumps(merged, ensure_ascii=False),
            'inventors': 'system',
            'applicant': 'system',
            'application_date': _today(),
            'status': 'synced',
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


class WorkingProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.info("%s - %s", self.client_address[0], format % args)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-MLOps-Token, X-Upload-Token, X-Task-Id, X-Rel-Path'
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

        self.send_error(404, 'Not found')

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

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
        server_address = ('', port)
        httpd = ThreadingHTTPServer(server_address, WorkingProxyHandler)
        logger.info('server running at http://localhost:%s', port)
        logger.info('api proxy: http://localhost:%s/api/aliyun', port)
        logger.info('mlops report: POST http://localhost:%s/api/mlops/report', port)
        logger.info('annotation upload: POST http://localhost:%s/api/annotation/upload', port)
        logger.info('annotation export: GET http://localhost:%s/api/annotation/export?taskId=...', port)
        if not MLOPS_TOKEN:
            logger.warning('MLOPS_TOKEN is not configured; /api/mlops/report will reject writes')
        if not ANNOTATION_UPLOAD_TOKEN:
            logger.warning('ANNOTATION_UPLOAD_TOKEN is not configured; /api/annotation/upload will reject writes')
        if not SUPABASE_URL or not SUPABASE_KEY:
            logger.warning('SUPABASE_URL/SUPABASE_KEY not configured; server-side cloud sync disabled')
        httpd.serve_forever()
    except Exception as e:
        import traceback
        logger.error('server error: %s', e)
        traceback.print_exc()


if __name__ == '__main__':
    run_server()
