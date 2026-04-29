from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import urllib.request
import urllib.error

class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"{self.client_address[0]} - - [{self.log_date_time_string()}] {format % args}")
    
    def do_OPTIONS(self):
        print(f"Received OPTIONS request to: {self.path}")
        # 处理预检请求
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
    
    def do_POST(self):
        print(f"Received POST request to: {self.path}")
        if self.path.startswith('/api/aliyun'):
            try:
                # 读取请求体
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                
                # 解析请求数据
                request_data = json.loads(post_data.decode('utf-8'))
                api_key = request_data.get('apiKey')
                model = request_data.get('model', 'qwen3.6-plus')
                messages = request_data.get('messages', [{'role': 'user', 'content': 'Hello'}])
                temperature = request_data.get('temperature', 0.7)
                max_tokens = request_data.get('max_tokens', 1000)
                
                if not api_key:
                    self.send_error(400, 'API key is required')
                    return
                
                # 构建阿里云API请求
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
                
                # 发送请求到阿里云API
                req = urllib.request.Request(aliyun_url, 
                                           data=json.dumps(payload).encode('utf-8'),
                                           headers=headers,
                                           method='POST')
                
                with urllib.request.urlopen(req) as response:
                    response_data = response.read().decode('utf-8')
                    
                    # 发送响应
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(response_data.encode('utf-8'))
                    
            except json.JSONDecodeError as e:
                print(f"JSON decode error: {e}")
                self.send_error(400, f'Invalid JSON: {e}')
            except urllib.error.HTTPError as e:
                # 处理阿里云API返回的错误
                error_data = e.read().decode('utf-8')
                print(f"HTTP error: {e.code} - {error_data}")
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(error_data.encode('utf-8'))
            except Exception as e:
                print(f"Internal server error: {e}")
                import traceback
                traceback.print_exc()
                self.send_error(500, f'Internal server error: {e}')
        else:
            print(f"Path not found: {self.path}")
            self.send_error(404, 'Not found')
    
    def do_GET(self):
        # 提供静态文件服务
        if self.path == '/':
            self.path = '/index.html'
        
        try:
            # 尝试打开并提供文件
            file_path = '.' + self.path
            with open(file_path, 'rb') as f:
                content = f.read()
                
                # 设置内容类型
                if self.path.endswith('.html'):
                    content_type = 'text/html'
                elif self.path.endswith('.js'):
                    content_type = 'text/javascript'
                elif self.path.endswith('.css'):
                    content_type = 'text/css'
                elif self.path.endswith('.json'):
                    content_type = 'application/json'
                else:
                    content_type = 'application/octet-stream'
                
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(content)
        except FileNotFoundError:
            self.send_error(404, 'File not found')
        except Exception as e:
            self.send_error(500, f'Internal server error: {e}')

def run_server(port=8000):
    try:
        server_address = ('', port)
        httpd = HTTPServer(server_address, ProxyHandler)
        print(f'Server running at http://localhost:{port}')
        print(f'API proxy available at http://localhost:{port}/api/aliyun')
        httpd.serve_forever()
    except Exception as e:
        print(f'Server error: {e}')
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    run_server()
