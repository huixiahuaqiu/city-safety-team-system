"""本地网页服务：静态文件 + 阿里云代理 + MLOps 训练回调。"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MLOPS_STORE_PATH = os.path.join(BASE_DIR, 'mlops_store.json')
MLOPS_TOKEN = os.environ.get('MLOPS_TOKEN', 'city-safety-mlops')

# 与前端 index.html 中云端同步配置保持一致（publishable key）
SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://havxlphglhjgcfgwowae.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', 'sb_publishable_jhRxljv8ocdnXBknablKiA_kRBzlEnC')
CLOUD_SYNC_MARK = '__APP_SYNC__'
CLOUD_SYNC_PN = '__SYNC_KV__modelTrainingData'

_store_lock = threading.Lock()


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
        print('[MLOps] cloud sync ok, jobs=', len(jobs))
    except Exception as e:
        print('[MLOps] cloud sync failed:', e)


def check_token(handler):
    auth = handler.headers.get('Authorization') or ''
    token = handler.headers.get('X-MLOps-Token') or ''
    if auth.lower().startswith('bearer '):
        token = auth[7:].strip() or token
    q = urllib.parse.urlparse(handler.path).query
    qs = urllib.parse.parse_qs(q)
    if qs.get('token'):
        token = qs['token'][0]
    return token == MLOPS_TOKEN


class WorkingProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"{self.client_address[0]} - - [{self.log_date_time_string()}] {format % args}")

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MLOps-Token')

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
        post_data = self.rfile.read(content_length) if content_length else b'{}'

        if path.startswith('/api/mlops/report'):
            if not check_token(self):
                self._json(401, {'ok': False, 'error': 'invalid token'})
                return
            try:
                payload = json.loads(post_data.decode('utf-8') or '{}')
            except json.JSONDecodeError as e:
                self._json(400, {'ok': False, 'error': f'invalid json: {e}'})
                return
            if not (payload.get('jobId') or payload.get('job_id') or payload.get('name')):
                self._json(400, {'ok': False, 'error': 'jobId or name required'})
                return
            job = upsert_job(payload)
            self._json(200, {'ok': True, 'job': job})
            return

        if path.startswith('/api/aliyun'):
            try:
                request_data = json.loads(post_data.decode('utf-8'))
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
            # 防目录穿越
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
        server_address = ('', port)
        httpd = HTTPServer(server_address, WorkingProxyHandler)
        print(f'Server running at http://localhost:{port}')
        print(f'API proxy: http://localhost:{port}/api/aliyun')
        print(f'MLOps report: POST http://localhost:{port}/api/mlops/report')
        print(f'MLOps jobs:   GET  http://localhost:{port}/api/mlops/jobs')
        print(f'MLOps token:  {MLOPS_TOKEN}  (可用环境变量 MLOPS_TOKEN 覆盖)')
        httpd.serve_forever()
    except Exception as e:
        print(f'Server error: {e}')
        import traceback
        traceback.print_exc()


if __name__ == '__main__':
    run_server()
