#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mechanically slim 123123/index.html without changing runtime behavior."""

from __future__ import annotations

import html.parser
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(r"d:\Desktop\city-safety-team-system")
BASE = ROOT / "123123"
INDEX = BASE / "index.html"
BAK = BASE / "index.html.bak-20260714"

DIRS = ["css", "js", "vendor", "modules"]

VENDOR_URLS = {
    BASE / "vendor/xlsx/xlsx.full.min.js": "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    BASE / "vendor/echarts/echarts.min.js": "https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js",
    BASE / "vendor/pdfjs/pdf.min.js": "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.min.js",
    BASE / "vendor/pdfjs/pdf.worker.min.js": "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js",
    BASE / "vendor/mammoth/mammoth.browser.min.js": "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js",
    BASE / "vendor/tailwind/tailwindcss.js": "https://cdn.tailwindcss.com",
    BASE / "vendor/wangeditor/style.css": "https://cdn.jsdelivr.net/npm/@wangeditor/editor@5.1.23/dist/css/style.css",
    BASE / "vendor/wangeditor/index.min.js": "https://cdn.jsdelivr.net/npm/@wangeditor/editor@5.1.23/dist/index.min.js",
    BASE / "vendor/cropperjs/cropper.css": "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.css",
    BASE / "vendor/cropperjs/cropper.min.js": "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.js",
}

FONTS_LOCAL_CSS = """\
:root {
  --font-sans: "Outfit", "Segoe UI", system-ui, sans-serif;
  --font-serif: "Noto Serif SC", "Songti SC", serif;
}
body, .font-sans {
  font-family: var(--font-sans);
}
.font-serif, .brand-serif {
  font-family: var(--font-serif);
}
"""

MODULE_LOADER_JS = """\
(function () {
  'use strict';

  async function loadModuleHtml(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    if (el.getAttribute('data-lazy') !== '1') return false;
    if (el.getAttribute('data-loaded') === '1') return true;
    var inner = (el.innerHTML || '').replace(/\\s+/g, '');
    if (inner.length > 20) return false;

    try {
      var res = await fetch('modules/' + encodeURIComponent(id) + '.html', { credentials: 'same-origin' });
      if (!res.ok) {
        console.warn('[loadModuleHtml] fetch failed', id, res.status);
        return false;
      }
      var html = await res.text();
      el.innerHTML = html;
      el.setAttribute('data-loaded', '1');
      return true;
    } catch (err) {
      console.warn('[loadModuleHtml] error', id, err);
      return false;
    }
  }

  window.loadModuleHtml = loadModuleHtml;
})();
"""

MODULES_README = """\
# Module HTML fragments

Lazy-loaded UI fragments live here as `{id}.html`, where `{id}` matches a DOM element id in `index.html`.

## Convention

- Target element: `#<id>` with `data-lazy="1"` and empty (or near-empty) inner HTML.
- Loader: `js/module-loader.js` exposes `window.loadModuleHtml(id)`.
- After a successful fetch, the element gets `data-loaded="1"`.

## Example

```html
<div id="my-panel" data-lazy="1"></div>
<script>
  loadModuleHtml('my-panel');
</script>
```

Place `modules/my-panel.html` beside this README.
"""

VENDOR_SYNC_SH = """\
#!/usr/bin/env bash
# Re-download third-party vendor assets into 123123/vendor/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/123123/vendor"
mkdir -p "$V/xlsx" "$V/echarts" "$V/pdfjs" "$V/mammoth" "$V/tailwind" \\
  "$V/wangeditor" "$V/cropperjs" "$V/fonts"

curl -fsSL -o "$V/xlsx/xlsx.full.min.js" \\
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
curl -fsSL -o "$V/echarts/echarts.min.js" \\
  "https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"
curl -fsSL -o "$V/pdfjs/pdf.min.js" \\
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.min.js"
curl -fsSL -o "$V/pdfjs/pdf.worker.min.js" \\
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js"
curl -fsSL -o "$V/mammoth/mammoth.browser.min.js" \\
  "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js"
curl -fsSL -o "$V/tailwind/tailwindcss.js" \\
  "https://cdn.tailwindcss.com"
curl -fsSL -o "$V/wangeditor/style.css" \\
  "https://cdn.jsdelivr.net/npm/@wangeditor/editor@5.1.23/dist/css/style.css"
curl -fsSL -o "$V/wangeditor/index.min.js" \\
  "https://cdn.jsdelivr.net/npm/@wangeditor/editor@5.1.23/dist/index.min.js"
curl -fsSL -o "$V/cropperjs/cropper.css" \\
  "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.css"
curl -fsSL -o "$V/cropperjs/cropper.min.js" \\
  "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.js"

# fonts-local.css uses system fallbacks; no Google font binaries required.
cat > "$V/fonts/fonts-local.css" <<'EOF'
:root {
  --font-sans: "Outfit", "Segoe UI", system-ui, sans-serif;
  --font-serif: "Noto Serif SC", "Songti SC", serif;
}
body, .font-sans { font-family: var(--font-sans); }
.font-serif, .brand-serif { font-family: var(--font-serif); }
EOF

echo "Vendor sync complete under $V"
"""

PDF_WORKER_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js"
PDF_WORKER_LOCAL = "vendor/pdfjs/pdf.worker.min.js"

LARGE_INLINE_MIN = 800  # bytes; keeps tiny onerror handler inline

CDN_REPLACEMENTS = [
    (r'<script\s+src="https://cdn\.jsdelivr\.net/npm/xlsx@0\.18\.5/dist/xlsx\.full\.min\.js"\s*></script>',
     '<script src="vendor/xlsx/xlsx.full.min.js"></script>'),
    (r'<script\s+src="https://cdn\.jsdelivr\.net/npm/echarts@5\.4\.3/dist/echarts\.min\.js"\s*></script>',
     '<script src="vendor/echarts/echarts.min.js"></script>'),
    (r'<script\s+src="https://cdn\.jsdelivr\.net/npm/pdfjs-dist@3\.4\.120/build/pdf\.min\.js"\s*></script>',
     '<script src="vendor/pdfjs/pdf.min.js"></script>'),
    (r'<script\s+src="https://cdn\.jsdelivr\.net/npm/mammoth@1\.8\.0/mammoth\.browser\.min\.js"\s*></script>',
     '<script src="vendor/mammoth/mammoth.browser.min.js"></script>'),
    (r'<script\s+src="https://cdn\.tailwindcss\.com"\s*></script>',
     '<script src="vendor/tailwind/tailwindcss.js"></script>'),
    (r'<link\s+href="https://cdn\.jsdelivr\.net/npm/@wangeditor/editor@5\.1\.23/dist/css/style\.css"\s+rel="stylesheet"\s*/?>',
     '<link href="vendor/wangeditor/style.css" rel="stylesheet">'),
    (r'<script\s+src="https://cdn\.jsdelivr\.net/npm/@wangeditor/editor@5\.1\.23/dist/index\.min\.js"\s*></script>',
     '<script src="vendor/wangeditor/index.min.js"></script>'),
    (r'<link\s+href="https://cdn\.jsdelivr\.net/npm/cropperjs@1\.6\.2/dist/cropper\.css"\s+rel="stylesheet"\s*/?>',
     '<link href="vendor/cropperjs/cropper.css" rel="stylesheet">'),
    (r'<script\s+src="https://cdn\.jsdelivr\.net/npm/cropperjs@1\.6\.2/dist/cropper\.min\.js"\s*></script>',
     '<script src="vendor/cropperjs/cropper.min.js"></script>'),
]


def ensure_dirs() -> None:
    for d in DIRS:
        (BASE / d).mkdir(parents=True, exist_ok=True)


def download_vendors() -> list[str]:
    created: list[str] = []
    for path, url in VENDOR_URLS.items():
        if path.exists() and path.stat().st_size > 0:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {url} -> {path}")
        urllib.request.urlretrieve(url, path)
        created.append(str(path.relative_to(ROOT)))
    return created


def write_static_assets() -> list[str]:
    new_files: list[str] = []
    fonts_css = BASE / "vendor/fonts/fonts-local.css"
    if not fonts_css.exists() or fonts_css.read_text(encoding="utf-8") != FONTS_LOCAL_CSS:
        fonts_css.parent.mkdir(parents=True, exist_ok=True)
        fonts_css.write_text(FONTS_LOCAL_CSS, encoding="utf-8", newline="\n")
        new_files.append(str(fonts_css.relative_to(ROOT)))

    ml = BASE / "js/module-loader.js"
    if ml.read_text(encoding="utf-8") if ml.exists() else "" != MODULE_LOADER_JS:
        ml.write_text(MODULE_LOADER_JS, encoding="utf-8", newline="\n")
        new_files.append(str(ml.relative_to(ROOT)))

    readme = BASE / "modules/README.md"
    readme.write_text(MODULES_README, encoding="utf-8", newline="\n")
    new_files.append(str(readme.relative_to(ROOT)))

    sync = ROOT / "deploy/scripts/vendor-sync.sh"
    sync.parent.mkdir(parents=True, exist_ok=True)
    sync.write_text(VENDOR_SYNC_SH, encoding="utf-8", newline="\n")
    new_files.append(str(sync.relative_to(ROOT)))
    return new_files


def find_inline_script_end(html: str, start: int) -> int:
    """Return index after </script> for inline script body starting at `start`."""
    i = start
    n = len(html)
    in_single = False
    in_double = False
    in_template = False
    in_line_comment = False
    in_block_comment = False
    while i < n:
        ch = html[i]
        nxt = html[i + 1] if i + 1 < n else ""
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_single:
            if ch == "\\":
                i += 2
                continue
            if ch == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_double = False
            i += 1
            continue
        if in_template:
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                in_template = False
            i += 1
            continue
        if ch == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if ch == "'":
            in_single = True
            i += 1
            continue
        if ch == '"':
            in_double = True
            i += 1
            continue
        if ch == "`":
            in_template = True
            i += 1
            continue
        if ch == "<" and html[i : i + 9].lower() == "</script>":
            return i + 9
        i += 1
    raise ValueError("Unclosed inline <script> block")


class _ScriptCollector(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts_with_src = 0
        self.errors: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        d = {k.lower(): (v or "") for k, v in attrs}
        if "src" in d:
            self.scripts_with_src += 1


def parse_script_tags(html: str) -> list[dict]:
    """Return script tag records in document order."""
    records: list[dict] = []
    i = 0
    n = len(html)
    script_open = re.compile(r"<script(\s[^>]*)?>", re.I)
    while i < n:
        m = script_open.search(html, i)
        if not m:
            break
        start = m.start()
        open_tag = m.group(0)
        body_start = m.end()
        has_src = bool(re.search(r"\bsrc\s*=", open_tag, re.I))
        if has_src:
            end = html.lower().find("</script>", body_start)
            if end == -1:
                raise ValueError("Unclosed external script tag")
            end += len("</script>")
            records.append({
                "start": start,
                "end": end,
                "open_tag": open_tag,
                "has_src": True,
                "body": "",
                "body_len": 0,
            })
            i = end
            continue
        end = find_inline_script_end(html, body_start)
        body = html[body_start : end - len("</script>")]
        records.append({
            "start": start,
            "end": end,
            "open_tag": open_tag,
            "has_src": False,
            "body": body,
            "body_len": len(body),
        })
        i = end
    return records


def is_tailwind_config(body: str) -> bool:
    s = body.strip()
    return "tailwind.config" in s and len(s) < 500


def replace_google_fonts(html: str) -> str:
    html = re.sub(
        r"<link[^>]+href=\"https://fonts\.googleapis\.com\"[^>]*>\s*",
        "",
        html,
        flags=re.I,
    )
    html = re.sub(
        r"<link[^>]+href=\"https://fonts\.gstatic\.com\"[^>]*>\s*",
        "",
        html,
        flags=re.I,
    )
    html = re.sub(
        r"<link[^>]+href=\"https://fonts\.googleapis\.com/css2[^\"]+\"[^>]*>\s*",
        '    <link href="vendor/fonts/fonts-local.css" rel="stylesheet">\n',
        html,
        flags=re.I,
    )
    return html

def extract_style_block(html: str) -> tuple[str, str | None]:
    m = re.search(r"<style[^>]*>", html, re.I)
    if not m:
        return html, None
    start = m.start()
    body_start = m.end()
    end = html.lower().find("</style>", body_start)
    if end == -1:
        raise ValueError("Unclosed <style>")
    css = html[body_start:end]
    link = '<link rel="stylesheet" href="css/app-shell.css?v=20260714-shell1">'
    new_html = html[:start] + link + html[end + len("</style>") :]
    return new_html, css


def verify_html(html: str, expected_src_scripts: int) -> None:
    parser = _ScriptCollector()
    try:
        parser.feed(html)
        parser.close()
    except Exception as e:
        raise RuntimeError(f"HTML parse failed: {e}") from e
    if parser.scripts_with_src != expected_src_scripts:
        raise RuntimeError(
            f"External script count mismatch: got {parser.scripts_with_src}, expected {expected_src_scripts}"
        )
    if "</html>" not in html.lower():
        raise RuntimeError("Missing </html>")
    if "<!DOCTYPE html>" not in html[:200].upper().replace(" ", ""):
        # allow lowercase doctype
        if "<!doctype html>" not in html[:200].lower():
            raise RuntimeError("Missing doctype")


def main() -> int:
    if not INDEX.exists():
        print(f"Missing {INDEX}", file=sys.stderr)
        return 1

    ensure_dirs()
    downloaded = download_vendors()
    static_new = write_static_assets()

    original = INDEX.read_text(encoding="utf-8")
    orig_scripts = parse_script_tags(original)
    orig_src_count = sum(1 for s in orig_scripts if s["has_src"])

    # Count large inline blocks to extract (excluding tailwind config)
    large_inline = [
        s
        for s in orig_scripts
        if not s["has_src"] and s["body_len"] >= LARGE_INLINE_MIN and not is_tailwind_config(s["body"])
    ]
    if len(large_inline) != 3:
        print(
            f"Warning: expected 3 large inline scripts, found {len(large_inline)}; proceeding with mapping",
            file=sys.stderr,
        )

    js_names = ["js/app-core.js", "js/app-legacy-a.js", "js/app-legacy-b.js"]
    js_versions = ["?v=20260714-core1", "?v=20260714-core1", "?v=20260714-core1"]
    # legacy files get distinct cache busters per user example (all core1 in step 5 - user said app-core and legacy with same pattern)
    js_versions[1] = "?v=20260714-core1"
    js_versions[2] = "?v=20260714-core1"

    extracted_files: list[str] = []
    html = original

    # 1) Extract CSS
    html, css_content = extract_style_block(html)
    if css_content is None:
        raise RuntimeError("No <style> block found in head")
    css_path = BASE / "css/app-shell.css"
    css_path.write_text(css_content, encoding="utf-8", newline="\n")
    extracted_files.append(str(css_path.relative_to(ROOT)))

    # Re-parse scripts after style replacement (positions shifted)
    scripts = parse_script_tags(html)

    # 2) Extract large inline scripts from end to start
    large_idx = 0
    replacements: list[tuple[int, int, str]] = []
    name_idx = 0
    for rec in scripts:
        if rec["has_src"]:
            continue
        if rec["body_len"] < LARGE_INLINE_MIN or is_tailwind_config(rec["body"]):
            continue
        if name_idx >= len(js_names):
            raise RuntimeError("More large inline scripts than output files")
        rel = js_names[name_idx]
        out_path = BASE / rel
        body = rec["body"]
        if body.startswith("\n"):
            body = body[1:]
        out_path.write_text(body, encoding="utf-8", newline="\n")
        extracted_files.append(str(out_path.relative_to(ROOT)))
        tag = f'<script src="{rel}{js_versions[name_idx]}"></script>'
        replacements.append((rec["start"], rec["end"], tag))
        name_idx += 1

    for start, end, tag in sorted(replacements, key=lambda x: x[0], reverse=True):
        html = html[:start] + tag + html[end:]

    # 3) CDN -> local
    for pattern, repl in CDN_REPLACEMENTS:
        html, n = re.subn(pattern, repl, html, flags=re.I)
        if n == 0 and "cdn.jsdelivr" in pattern:
            # tailwind or already replaced
            pass

    html = replace_google_fonts(html)

    # 4) pdf worker in extracted js
    for rel in js_names[:name_idx]:
        p = BASE / rel
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8")
        if PDF_WORKER_CDN in text:
            text = text.replace(PDF_WORKER_CDN, PDF_WORKER_LOCAL)
            p.write_text(text, encoding="utf-8", newline="\n")

    # 5) module-loader before literature-compare
    marker = '<script src="js/literature-compare.js'
    insert = '<script src="js/module-loader.js?v=20260714-ml1"></script>\n    '
    if marker in html and "module-loader.js" not in html:
        html = html.replace(marker, insert + marker, 1)

    # Expected external scripts: original src + extracted large inline count + module-loader
    expected_src = orig_src_count + name_idx + (1 if "module-loader.js" in html else 0)

    verify_html(html, expected_src)

    # Backup only on success
    BAK.write_text(original, encoding="utf-8", newline="\n")
    INDEX.write_text(html, encoding="utf-8", newline="\n")

    # Stats
    line_count = INDEX.read_text(encoding="utf-8").count("\n") + 1
    all_new = sorted(set(extracted_files + static_new + downloaded))

    def fmt_size(path: Path) -> str:
        if path.exists():
            return f"{path.stat().st_size:,} B"
        return "missing"

    print("=== slim_index_html complete ===")
    print(f"index.html lines: {line_count}")
    print(f"index.html size: {fmt_size(INDEX)}")
    print(f"backup: {BAK.relative_to(ROOT)} ({fmt_size(BAK)})")
    print(f"original external scripts: {orig_src_count}")
    print(f"new external scripts: {expected_src}")
    print(f"large inline blocks extracted: {name_idx}")
    print("New/updated files:")
    for rel in all_new:
        print(f"  - {rel} ({fmt_size(ROOT / rel)})")
    for rel in ["css/app-shell.css"] + js_names[:name_idx]:
        if rel not in all_new:
            print(f"  - {rel} ({fmt_size(BASE / rel)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
