import json
import urllib.request
import urllib.error

# 直接处理API请求
def handle_api_request(data):
    try:
        # 解析请求数据
        request_data = json.loads(data)
        api_key = request_data.get('apiKey')
        model = request_data.get('model', 'qwen3.6-plus')
        messages = request_data.get('messages', [{'role': 'user', 'content': 'Hello'}])
        temperature = request_data.get('temperature', 0.7)
        max_tokens = request_data.get('max_tokens', 1000)
        
        if not api_key:
            return {'error': 'API key is required'}, 400
        
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
        req = urllib.request.Request(aliyun_url, 
                                   data=json.dumps(payload).encode('utf-8'),
                                   headers=headers,
                                   method='POST')
        
        with urllib.request.urlopen(req) as response:
            response_data = response.read().decode('utf-8')
            print(f"阿里云API响应: {response_data}")
            return json.loads(response_data), 200
            
    except json.JSONDecodeError as e:
        return {'error': f'Invalid JSON: {e}'}, 400
    except urllib.error.HTTPError as e:
        # 处理阿里云API返回的错误
        error_data = e.read().decode('utf-8')
        print(f"HTTP error: {e.code} - {error_data}")
        return json.loads(error_data), e.code
    except Exception as e:
        print(f"Internal server error: {e}")
        import traceback
        traceback.print_exc()
        return {'error': f'Internal server error: {e}'}, 500

# 测试函数
def test_direct_proxy():
    test_data = {
        "apiKey": "test",
        "messages": [{"role": "user", "content": "Hello"}]
    }
    
    print("Testing direct proxy...")
    print(f"Test data: {json.dumps(test_data)}")
    
    result, status_code = handle_api_request(json.dumps(test_data))
    print(f"Result: {json.dumps(result)}")
    print(f"Status code: {status_code}")

if __name__ == '__main__':
    test_direct_proxy()
