from http.server import HTTPServer, BaseHTTPRequestHandler
import json

class MinimalProxyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        print(f"Received POST request to: {self.path}")
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'message': 'POST request received'}).encode('utf-8'))
    
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'<html><body><h1>Minimal Proxy Server</h1></body></html>')

def run_minimal_proxy(port=9000):
    server_address = ('', port)
    httpd = HTTPServer(server_address, MinimalProxyHandler)
    print(f'Minimal proxy server running at http://localhost:{port}')
    httpd.serve_forever()

if __name__ == '__main__':
    run_minimal_proxy()
