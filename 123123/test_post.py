import requests
import json

def test_post():
    url = 'http://localhost:3000/api/aliyun'
    data = {
        "apiKey": "test",
        "messages": [{"role": "user", "content": "Hello"}]
    }
    
    print(f"Sending POST request to {url}")
    print(f"Data: {json.dumps(data)}")
    
    try:
        response = requests.post(url, json=data, timeout=10)
        print(f"Response status: {response.status_code}")
        print(f"Response content: {response.text}")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_post()
