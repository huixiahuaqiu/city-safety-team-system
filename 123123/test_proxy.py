import requests
import json

def test_proxy():
    print("Testing proxy server...")
    try:
        # Test GET request to root
        response = requests.get('http://localhost:3000/')
        print(f"GET / response status: {response.status_code}")
        print(f"Response content (first 100 chars): {response.text[:100]}...")
    except Exception as e:
        print(f"GET / error: {e}")
    
    try:
        # Test POST request to API endpoint
        data = {
            "apiKey": "test",
            "messages": [{"role": "user", "content": "Hello"}]
        }
        url = 'http://localhost:3000/api/aliyun'
        print(f"Sending POST request to {url} with data: {json.dumps(data)}")
        response = requests.post(url, json=data, timeout=10)
        print(f"POST {url} response status: {response.status_code}")
        print(f"Response headers: {dict(response.headers)}")
        print(f"Response content: {response.text}")
        
        # Test with different variations of the URL
        print("\nTesting with different URL variations...")
        
        # Test with trailing slash
        url_with_slash = 'http://localhost:3000/api/aliyun/'
        print(f"Sending POST request to {url_with_slash}")
        response2 = requests.post(url_with_slash, json=data, timeout=10)
        print(f"POST {url_with_slash} response status: {response2.status_code}")
        
    except Exception as e:
        print(f"POST error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_proxy()
