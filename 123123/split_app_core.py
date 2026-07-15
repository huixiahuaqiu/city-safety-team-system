# -*- coding: utf-8 -*-
"""Split large sections out of app-core.js into dedicated files (pure move)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CORE = ROOT / "js" / "app-core.js"
lines = CORE.read_text(encoding="utf-8").splitlines(keepends=True)

# 1-based inclusive ranges from earlier analysis
CHUNKS = [
    # (start, end, outfile, banner)
    (3515, 6342, "js/excel-tools.js", "// Excel 处理（从 app-core 机械外置）\n"),
    (6344, 10366, "js/achievements-modules.js", "// 项目/成员/成果台账模块（从 app-core 机械外置）\n"),
]

# Process from bottom to top so line numbers stay valid
for start, end, out, banner in sorted(CHUNKS, key=lambda x: -x[0]):
    piece = lines[start - 1 : end]
    # drop trailing window.showModule if accidentally included
    text = "".join(piece)
    if "window.showModule" in text:
        # keep only before that marker
        idx = text.find("\n// onclick")
        if idx < 0:
            idx = text.find("window.showModule")
        if idx > 0:
            text = text[:idx]
    out_path = ROOT / out
    out_path.write_text(banner + text.rstrip() + "\n", encoding="utf-8")
    # replace with stub comment in core
    stub = f"\n        // [moved] see {out}\n"
    lines[start - 1 : end] = [stub]
    print(f"extracted {out}: {end - start + 1} lines -> {out_path.stat().st_size} bytes")

CORE.write_text("".join(lines), encoding="utf-8")
print("app-core lines now", len(Path(CORE).read_text(encoding="utf-8").splitlines()))
