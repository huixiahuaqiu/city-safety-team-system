from flask import Flask, request, jsonify
import requests
import json

app = Flask(__name__)

@app.route('/api/aliyun', methods=['POST', 'OPTIONS'])
def aliyun_proxy():
    if request.method == 'OPTIONS':
        return '', 200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    
    try:
        print(f"Received POST request to /api/aliyun")
        print(f"Headers: {dict(request.headers)}")
        
        # 尝试获取请求数据
        data = request.json
        print(f"Data: {data}")
        
        if data is None:
            # 尝试从请求体中读取数据
            raw_data = request.get_data().decode('utf-8')
            print(f"Raw data: {raw_data}")
            data = json.loads(raw_data)
        
        api_key = data.get('apiKey')
        model = data.get('model', 'qwen3.6-plus')
        messages = data.get('messages', [{'role': 'user', 'content': 'Hello'}])
        temperature = data.get('temperature', 0.7)
        max_tokens = data.get('max_tokens', 1000)
        
        if not api_key:
            return jsonify({'error': 'API key is required'}), 400
        
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
        
        print(f"Sending request to阿里云API: {aliyun_url}")
        print(f"Headers: {headers}")
        print(f"Payload: {json.dumps(payload)}")
        
        # 发送请求到阿里云API
        response = requests.post(aliyun_url, json=payload, headers=headers)
        print(f"阿里云API响应状态码: {response.status_code}")
        print(f"阿里云API响应内容: {response.text}")
        
        return response.json(), response.status_code, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Internal server error: {str(e)}'}), 500

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static(path):
    if path == '':
        path = 'index.html'
    try:
        with open(f'.{path}', 'rb') as f:
            content = f.read()
        return content, 200, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/html'
        }
    except FileNotFoundError:
        return '<h1>404 Not Found</h1>', 404

if __name__ == '__main__':
    app.run(port=3000, debug=True)
