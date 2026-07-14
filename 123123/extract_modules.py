# -*- coding: utf-8 -*-
"""Extract large .module HTML blocks into modules/*.html and leave lazy shells in index.html."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
MOD_DIR = ROOT / "modules"
# Extract these first (large / already have external JS). Keep home/login/shell in index.
EXTRACT_IDS = [
    "patent_management",
    "paper_management",
    "standard_management",
    "software_copyright",
    "longitudinal_project",
    "horizontal_project",
    "school_project",
    "model_training",
    "data_annotation",
    "chat",
    "literature_analysis",
    "openai",
    "excel",
    "document_analysis",
    "member_archive",
    "role_permission",
    "task_management",
    "weekly_report",
    "application_center",
    "notice_publish",
    "news_management",
    "meeting_management",
    "literature_library",
    "dataset_library",
    "project_report",
    "shared_files",
    "account_permission",
    "system_config",
    "operation_log",
    "data_backup",
    "comparison",
    "trend",
    "competition_management",
    "collection",
]


def find_module_span(html: str, mid: str):
    """Return (start, end) of outer <div id="mid" class="module...">...</div> using depth count."""
    # match opening tag
    m = re.search(
        rf'<div\s+id="{re.escape(mid)}"\s+class="module[^"]*"[^>]*>',
        html,
    )
    if not m:
        # alternate attribute order
        m = re.search(
            rf'<div\s+class="module[^"]*"[^>]*\sid="{re.escape(mid)}"[^>]*>',
            html,
        )
    if not m:
        return None
    start = m.start()
    i = m.end()
    depth = 1
    tag_re = re.compile(r"</?div\b[^>]*>", re.I)
    for tm in tag_re.finditer(html, i):
        tag = tm.group(0)
        if tag.startswith("</"):
            depth -= 1
            if depth == 0:
                return start, tm.end()
        elif not tag.endswith("/>"):
            depth += 1
    return None


def main():
    html = INDEX.read_text(encoding="utf-8")
    MOD_DIR.mkdir(exist_ok=True)
    extracted = []
    for mid in EXTRACT_IDS:
        span = find_module_span(html, mid)
        if not span:
            print("SKIP missing", mid)
            continue
        a, b = span
        block = html[a:b]
        # inner HTML only (strip outer wrapper)
        open_end = block.find(">") + 1
        close_start = block.rfind("</div>")
        inner = block[open_end:close_start]
        # capture opening attrs for class/style
        open_tag = block[:open_end]
        style_m = re.search(r'style="([^"]*)"', open_tag)
        style_attr = f' style="{style_m.group(1)}"' if style_m else ""
        (MOD_DIR / f"{mid}.html").write_text(inner.strip() + "\n", encoding="utf-8")
        shell = (
            f'<div id="{mid}" class="module" data-lazy="1" data-loaded="0"{style_attr}>'
            f'<!-- lazy: modules/{mid}.html --></div>'
        )
        html = html[:a] + shell + html[b:]
        extracted.append((mid, len(inner)))
        print(f"OK {mid} inner={len(inner)} bytes")

    # wire showModule to await loadModuleHtml — patch app-core if function exists
    core = ROOT / "js" / "app-core.js"
    if core.exists():
        c = core.read_text(encoding="utf-8")
        if "loadModuleHtml" not in c and "function showModule" in c:
            c = c.replace(
                "function showModule(moduleId) {",
                "async function showModule(moduleId) {\n"
                "            if (typeof window.loadModuleHtml === 'function') {\n"
                "                try { await window.loadModuleHtml(moduleId); } catch (e) { console.warn(e); }\n"
                "            }",
                1,
            )
            # also expose sync wrapper for onclick handlers that don't await
            if "window.showModule =" not in c:
                c += (
                    "\n// onclick 兼容：保持全局可调用\n"
                    "window.showModule = showModule;\n"
                )
            core.write_text(c, encoding="utf-8")
            print("patched showModule in app-core.js")

    INDEX.write_text(html, encoding="utf-8")
    lines = html.count("\n") + 1
    print(f"DONE extracted={len(extracted)} index_lines≈{lines}")


if __name__ == "__main__":
    main()
