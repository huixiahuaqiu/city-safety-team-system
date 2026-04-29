from http.server import HTTPServer, BaseHTTPRequestHandler
import json

class SimpleProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"{self.client_address[0]} - - [{self.log_date_time_string()}] {format % args}")
    
    def do_POST(self):
        print(f"Received POST request to: {self.path}")
        print(f"Headers: {dict(self.headers)}")
        
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        print(f"POST data: {post_data.decode('utf-8')}")
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'message': 'POST request received'}).encode('utf-8'))
    
    def do_GET(self):
        print(f"Received GET request to: {self.path}")
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'<html><body><h1>Simple Proxy Server</h1></body></html>')

def run_simple_proxy(port=8000):
    server_address = ('', port)
    httpd = HTTPServer(server_address, SimpleProxyHandler)
    print(f'Simple proxy server running at http://localhost:{port}')
    httpd.serve_forever()

if __name__ == '__main__':
    run_simple_proxy()
