#!/usr/bin/env bash
# Re-download third-party vendor assets into 123123/vendor/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/123123/vendor"
mkdir -p "$V/xlsx" "$V/echarts" "$V/pdfjs" "$V/mammoth" "$V/tailwind" \
  "$V/wangeditor" "$V/cropperjs" "$V/fonts"

curl -fsSL -o "$V/xlsx/xlsx.full.min.js" \
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
curl -fsSL -o "$V/echarts/echarts.min.js" \
  "https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"
curl -fsSL -o "$V/pdfjs/pdf.min.js" \
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.min.js"
curl -fsSL -o "$V/pdfjs/pdf.worker.min.js" \
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js"
curl -fsSL -o "$V/mammoth/mammoth.browser.min.js" \
  "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js"
curl -fsSL -o "$V/tailwind/tailwindcss.js" \
  "https://cdn.tailwindcss.com"
curl -fsSL -o "$V/wangeditor/style.css" \
  "https://cdn.jsdelivr.net/npm/@wangeditor/editor@5.1.23/dist/css/style.css"
curl -fsSL -o "$V/wangeditor/index.min.js" \
  "https://cdn.jsdelivr.net/npm/@wangeditor/editor@5.1.23/dist/index.min.js"
curl -fsSL -o "$V/cropperjs/cropper.css" \
  "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.css"
curl -fsSL -o "$V/cropperjs/cropper.min.js" \
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
