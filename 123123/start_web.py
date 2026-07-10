"""一键启动网页端：启动本地服务并自动打开浏览器。"""
import os
import socket
import sys
import threading
import time
import webbrowser

# 保证从任意目录运行都能找到同目录下的模块和静态文件
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from working_proxy import run_server

PORT = 8000
URL = f"http://localhost:{PORT}"


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def open_browser_when_ready(url: str, port: int, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_port_in_use(port):
            webbrowser.open(url)
            print(f"已打开浏览器: {url}")
            return
        time.sleep(0.2)
    print(f"服务启动较慢，请手动访问: {url}")


def main() -> None:
    if is_port_in_use(PORT):
        print(f"端口 {PORT} 已被占用，直接打开已有服务: {URL}")
        webbrowser.open(URL)
        return

    print("=" * 50)
    print("城市安全团队系统 - 网页端一键启动")
    print(f"访问地址: {URL}")
    print("按 Ctrl+C 可停止服务")
    print("=" * 50)

    threading.Thread(
        target=open_browser_when_ready,
        args=(URL, PORT),
        daemon=True,
    ).start()

    run_server(PORT)


if __name__ == "__main__":
    main()
