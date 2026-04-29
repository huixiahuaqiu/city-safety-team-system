import requests
import json

# 测试直接调用阿里云百炼API
def test_aliyun_api():
    api_key = "sk-997a88dd8f274103a2e3d427bf29a873"
    # 使用正确的阿里云百炼API端点
    url = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    data = {
        "model": "ep-20240416170429-9qz6n",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"}
        ],
        "temperature": 0.7,
        "max_tokens": 1000
    }
    
    try:
        print("正在测试直接调用阿里云百炼API...")
        response = requests.post(url, headers=headers, json=data)
        print(f"响应状态码: {response.status_code}")
        print(f"响应内容: {response.text}")
        
        if response.status_code == 200:
            try:
                result = response.json()
                print("API调用成功！")
                print(f"AI响应: {result['choices'][0]['message']['content']}")
            except json.JSONDecodeError:
                print("JSON解析失败")
        else:
            print("API调用失败")
            try:
                error = response.json()
                print(f"错误信息: {error}")
            except json.JSONDecodeError:
                print(f"错误响应: {response.text}")
    except Exception as e:
        print(f"异常: {e}")

# 测试使用本地代理服务器
def test_proxy_server():
    api_key = "sk-997a88dd8f274103a2e3d427bf29a873"
    url = "http://localhost:8000/api/aliyun"
    
    headers = {
        "Content-Type": "application/json"
    }
    
    data = {
        "apiKey": api_key,
        "model": "qwen3.6-plus",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"}
        ],
        "temperature": 0.7,
        "max_tokens": 1000
    }
    
    try:
        print("\n正在测试使用本地代理服务器...")
        response = requests.post(url, headers=headers, json=data)
        print(f"响应状态码: {response.status_code}")
        print(f"响应内容: {response.text}")
        
        if response.status_code == 200:
            try:
                result = response.json()
                print("代理服务器调用成功！")
                print(f"AI响应: {result['choices'][0]['message']['content']}")
            except json.JSONDecodeError:
                print("JSON解析失败")
        else:
            print("代理服务器调用失败")
            try:
                error = response.json()
                print(f"错误信息: {error}")
            except json.JSONDecodeError:
                print(f"错误响应: {response.text}")
    except Exception as e:
        print(f"异常: {e}")

if __name__ == "__main__":
    test_aliyun_api()
    test_proxy_server()