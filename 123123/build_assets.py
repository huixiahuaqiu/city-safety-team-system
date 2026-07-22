"""静态资源缓存戳自动化（零依赖，仅标准库）。

作用：扫描 HTML 中对本地 js/、css/ 资源的引用，按文件**内容哈希**重写其
`?v=` 查询串。内容变了哈希才变，浏览器就会拉新文件；内容没变则保持不变，
不产生无谓的 git 变更。

用法：
    python build_assets.py                # 处理默认的 index.html
    python build_assets.py a.html b.html  # 处理指定文件
    python build_assets.py --check        # 只检查是否需要更新（CI 用），有差异则退出码 1

设计说明：
- 只改写 js/ 与 css/ 目录下的本地资源；config.js、外链、vendor/ 一律不动。
- 幂等：重复运行且文件未变 → 无改动。
- 任何单个文件缺失只告警、不中断，不会因此写坏 HTML。
"""
import hashlib
import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TARGETS = ["index.html"]

# 动态加载的模块 HTML 目录，及自动生成的模块清单（供 module-loader.js 精准缓存）。
MODULES_DIRNAME = "modules"
MANIFEST_REL = os.path.join("js", "module-manifest.js")

# 匹配 <script src="js/xxx.js?..."> 或 <link href="css/xxx.css?...">
# 只认 js/ 与 css/ 开头的本地相对路径；带不带 ?query 都能匹配。
ASSET_RE = re.compile(
    r'(?P<attr>\b(?:src|href))='
    r'(?P<q>["\'])'
    r'(?P<path>(?:js|css)/[^"\'?#]+)'
    r'(?:\?[^"\']*)?'
    r'(?P=q)'
)

HASH_LEN = 10


def content_hash(abs_path: str) -> str:
    """返回文件内容的短哈希（sha1 前 10 位十六进制）。"""
    h = hashlib.sha1()
    with open(abs_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:HASH_LEN]


def rewrite_html(text: str, root_dir: str):
    """重写单个 HTML 文本，返回 (新文本, 变更记录列表, 缺失文件列表)。"""
    changes = []
    missing = []

    def repl(m: "re.Match") -> str:
        attr = m.group("attr")
        q = m.group("q")
        path = m.group("path")
        abs_path = os.path.join(root_dir, path.replace("/", os.sep))
        if not os.path.isfile(abs_path):
            missing.append(path)
            return m.group(0)  # 缺文件：原样保留，不写哈希
        digest = content_hash(abs_path)
        new_ref = f'{attr}={q}{path}?v={digest}{q}'
        if new_ref != m.group(0):
            changes.append((path, digest))
        return new_ref

    return ASSET_RE.sub(repl, text), changes, missing


def process_file(target: str, check_only: bool) -> bool:
    """处理单个 HTML 文件。返回该文件是否发生（或需要发生）改动。"""
    abs_target = target if os.path.isabs(target) else os.path.join(BASE_DIR, target)
    if not os.path.isfile(abs_target):
        print(f"[build_assets] 跳过：找不到 {target}")
        return False

    root_dir = os.path.dirname(abs_target)
    with open(abs_target, "r", encoding="utf-8") as f:
        original = f.read()

    new_text, changes, missing = rewrite_html(original, root_dir)

    for path in missing:
        print(f"[build_assets] 警告：引用的资源不存在，已保持原样 → {path}")

    if new_text == original:
        print(f"[build_assets] {os.path.basename(abs_target)} 无需更新（{len(changes)} 项已是最新）")
        return False

    if check_only:
        print(f"[build_assets] 需要更新 {os.path.basename(abs_target)}：{len(changes)} 项资源哈希变化")
        for path, digest in changes:
            print(f"    - {path} → {digest}")
        return True

    with open(abs_target, "w", encoding="utf-8", newline="") as f:
        f.write(new_text)
    print(f"[build_assets] 已更新 {os.path.basename(abs_target)}：{len(changes)} 项")
    for path, digest in changes:
        print(f"    - {path} → {digest}")
    return True


def build_module_manifest(root_dir: str, check_only: bool = False) -> bool:
    """扫描 modules/*.html，生成/刷新 js/module-manifest.js。

    产物为 `window.__MODULE_VERSIONS = { 模块id: 内容哈希 }`，供 module-loader.js
    按模块做精准缓存控制。返回是否发生（或需要发生）改动。
    """
    modules_dir = os.path.join(root_dir, MODULES_DIRNAME)
    if not os.path.isdir(modules_dir):
        return False

    entries = {}
    for name in sorted(os.listdir(modules_dir)):
        if not name.endswith(".html"):
            continue
        mid = name[:-len(".html")]
        entries[mid] = content_hash(os.path.join(modules_dir, name))

    lines = [
        "// 本文件由 build_assets.py 自动生成，请勿手动修改。",
        "// modules/*.html 的内容哈希，供 module-loader.js 做精准缓存控制。",
        "window.__MODULE_VERSIONS = {",
    ]
    items = list(entries.items())
    for i, (mid, digest) in enumerate(items):
        comma = "," if i < len(items) - 1 else ""
        lines.append(f'  {json.dumps(mid, ensure_ascii=False)}: "{digest}"{comma}')
    lines.append("};")
    new_text = "\n".join(lines) + "\n"

    manifest_path = os.path.join(root_dir, MANIFEST_REL)
    old_text = ""
    if os.path.isfile(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            old_text = f.read()

    if new_text == old_text:
        print(f"[build_assets] module-manifest.js 无需更新（{len(entries)} 个模块）")
        return False

    if check_only:
        print(f"[build_assets] 需要更新 module-manifest.js（{len(entries)} 个模块）")
        return True

    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8", newline="") as f:
        f.write(new_text)
    print(f"[build_assets] 已更新 module-manifest.js（{len(entries)} 个模块）")
    return True


def build(targets=None, check_only: bool = False) -> bool:
    """对外入口：供 start_web.py 等直接调用。返回是否存在改动。"""
    targets = targets or DEFAULT_TARGETS
    changed = False
    # 先刷新模块清单（它本身也是 index.html 里的一个 js 资源，随后会被一并打戳）
    if build_module_manifest(BASE_DIR, check_only=check_only):
        changed = True
    for t in targets:
        if process_file(t, check_only):
            changed = True
    return changed


def main(argv) -> int:
    check_only = "--check" in argv
    files = [a for a in argv if not a.startswith("--")]
    changed = build(files or None, check_only=check_only)
    # --check 模式：有差异返回 1，便于 CI 拦截“忘了重建”
    if check_only and changed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
