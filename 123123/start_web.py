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

# 缓存戳工具（内容哈希）。以 best-effort 方式引入，缺失也不影响启动。
try:
    import build_assets
except Exception:  # pragma: no cover - 容错：任何导入异常都不应阻断启动
    build_assets = None

PORT = 8000
URL = f"http://localhost:{PORT}"
# 生产 systemd 设 CITYSAFE_NO_BROWSER=1，避免无头服务器弹浏览器
NO_BROWSER = (os.environ.get('CITYSAFE_NO_BROWSER') or '').strip().lower() in ('1', 'true', 'yes')


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
        if not NO_BROWSER:
            webbrowser.open(URL)
        return

    print("=" * 50)
    print("城市安全团队系统 - 网页端一键启动")
    print(f"访问地址: {URL}")
    print("按 Ctrl+C 可停止服务")
    print("=" * 50)

    # 生产不可变制品：发布阶段（release.sh）已完成缓存戳构建，启动一律不再重建，
    # 避免回滚到旧版后启动期重新构建导致版本漂移。生产 systemd 设 CITYSAFE_NO_BROWSER=1
    # 即视为生产；也可显式 CITYSAFE_SKIP_BUILD=1 强制跳过。仅本地开发时自动刷新，方便调试。
    skip_build = NO_BROWSER or (os.environ.get('CITYSAFE_SKIP_BUILD') or '').strip().lower() in ('1', 'true', 'yes')
    if skip_build:
        print("[start_web] 不可变模式：跳过启动期资源构建（缓存戳由 release.sh 负责）")
    elif build_assets is not None:
        try:
            build_assets.build()
        except Exception as exc:  # 刷新失败绝不阻断服务启动
            print(f"[start_web] 资源缓存戳刷新已跳过：{exc}")

    if not NO_BROWSER:
        threading.Thread(
            target=open_browser_when_ready,
            args=(URL, PORT),
            daemon=True,
        ).start()

    run_server(PORT)


if __name__ == "__main__":
    main()
