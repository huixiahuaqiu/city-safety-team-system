from http.server import HTTPServer, BaseHTTPRequestHandler
import json

class SimplePostHandler(BaseHTTPRequestHandler):
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
        self.wfile.write(b'<html><body><h1>Simple Post Server</h1></body></html>')

def run_server(port=3000):
    server_address = ('', port)
    httpd = HTTPServer(server_address, SimplePostHandler)
    print(f'Server running at http://localhost:{port}')
    httpd.serve_forever()

if __name__ == '__main__':
    run_server()
