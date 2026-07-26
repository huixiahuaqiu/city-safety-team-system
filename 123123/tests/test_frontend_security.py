import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest


APP_DIR = Path(__file__).resolve().parents[1]


class FrontendSecurityRegressionTests(unittest.TestCase):
    def test_plaintext_password_is_removed_before_cloud_sync(self):
        source = (APP_DIR / "js" / "app-core.js").read_text(encoding="utf-8")
        self.assertIn("delete copy.password;", source)
        self.assertIn("passwordHash", source)

    def test_account_passwords_use_pbkdf2_migration(self):
        source = (APP_DIR / "js" / "app-legacy-b.js").read_text(encoding="utf-8")
        self.assertIn("PBKDF2", source)
        self.assertIn("delete account.password;", source)
        self.assertIn("verifyAccountPassword", source)

    def test_high_risk_detail_views_escape_user_content(self):
        source = (APP_DIR / "js" / "app-legacy-b.js").read_text(encoding="utf-8")
        self.assertIn("${escHtml(task.title || '')}", source)
        self.assertIn("${escHtml(meeting.title || '')}", source)
        self.assertIn("${escHtml(meeting.agenda || '暂无')}", source)

    def test_large_feature_scripts_are_loaded_on_demand(self):
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        loader = (APP_DIR / "js" / "module-loader.js").read_text(encoding="utf-8")
        manifest = (APP_DIR / "js" / "module-manifest.js").read_text(encoding="utf-8")
        for asset in (
            "js/literature-compare.js",
            "js/document-analysis.js",
            "js/shared-file-library.js",
        ):
            self.assertNotIn(f'<script src="{asset}', index)
            self.assertIn(asset, loader)
            self.assertIn(asset, manifest)
        self.assertIn("window.__ASSET_VERSIONS", manifest)

    def test_gateway_auth_and_sync_backoff_are_present(self):
        core = (APP_DIR / "js" / "app-core.js").read_text(encoding="utf-8")
        legacy = (APP_DIR / "js" / "app-legacy-b.js").read_text(encoding="utf-8")
        self.assertIn("window.GatewayAuth", core)
        self.assertIn("sessionStorage.setItem(STORAGE_KEY", core)
        self.assertIn("parsed.pathname.indexOf('/api/')", core)
        self.assertIn("CLOUD_RETRY_MAX_MS", core)
        self.assertIn("reason: 'backoff'", core)
        self.assertIn("window.GatewayAuth.login(studentId, password)", legacy)

    def test_ai_key_is_session_scoped_and_default_proxy_is_same_origin(self):
        core = (APP_DIR / "js" / "app-core.js").read_text(encoding="utf-8")
        config = (APP_DIR / "config.js").read_text(encoding="utf-8")
        self.assertIn("sessionStorage.setItem('openaiApiKey'", core)
        self.assertIn("localStorage.removeItem('openaiApiKey')", core)
        self.assertIn("API_PROXY: ''", config)

    def test_literature_cards_block_persisted_xss_and_inline_handler_injection(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for the frontend rendering regression test")

        source_path = APP_DIR / "js" / "literature-library.js"
        script = r"""
const fs = require('fs');
const vm = require('vm');
const file = process.argv[1];
const source = fs.readFileSync(file, 'utf8');
const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const window = {
    currentUser: { role: 'member', username: 'tester' },
    literatureData: [],
    escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    safeExternalUrl(value) {
        try {
            const parsed = new URL(String(value), 'http://localhost/');
            return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
        } catch (_) {
            return '';
        }
    }
};
window.window = window;
vm.runInNewContext(source, {
    window,
    localStorage: storage,
    console,
    URL,
    Blob,
    setTimeout,
    clearTimeout
}, { filename: file });

const imagePayload = '"><img src=x onerror="globalThis.__title_xss=1">';
const result = {
    html: window.LiteratureLibrary.renderLiteratureCardHtml({
        id: 7,
        title: imagePayload,
        author: '";globalThis.__quote_xss=1;//',
        journal: "Journal' onclick='globalThis.__journal_xss=1",
        year: '2026',
        tagList: [imagePayload],
        citations: '<img src=x onerror="globalThis.__citation_xss=1">',
        downloadCount: '";globalThis.__download_xss=1;//',
        readStatus: '" onmouseover="globalThis.__status_xss=1',
        paperUrl: 'javascript:globalThis.__url_xss=1',
        uploader: 'attacker',
        uploadTime: 'today',
        litType: 'journal'
    }),
    invalidIdHtml: window.LiteratureLibrary.renderLiteratureCardHtml({
        id: '7);globalThis.__id_xss=1;//',
        title: 'bad id'
    }),
    normalized: window.LiteratureLibrary.normalizeLiteratureRecord({
        id: '7);globalThis.__id_xss=1;//',
        citations: '<img onerror=globalThis.__citation_xss>',
        downloadCount: '1" onclick="globalThis.__download_xss=1',
        sharedFileId: -4,
        projectIds: [4, '5.5', -1, 'bad']
    })
};
process.stdout.write(JSON.stringify(result));
"""
        completed = subprocess.run(
            [node, "-e", script, str(source_path)],
            cwd=APP_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        result = json.loads(completed.stdout)
        html = result["html"]

        self.assertNotIn("<img", html)
        self.assertIn("&quot;&gt;&lt;img", html)
        self.assertNotIn('title=""><img', html)
        self.assertNotIn("__citation_xss", html)
        self.assertNotIn("__download_xss", html)
        self.assertNotIn("__status_xss", html)
        self.assertNotIn("downloadLibraryLiterature(7)", html)
        handlers = re.findall(r'\son(?:click|change)="([^"]*)"', html)
        self.assertTrue(handlers)
        self.assertTrue(all("globalThis" not in handler for handler in handlers))

        self.assertEqual("", result["invalidIdHtml"])
        self.assertEqual(0, result["normalized"]["id"])
        self.assertEqual(0, result["normalized"]["citations"])
        self.assertEqual(0, result["normalized"]["downloadCount"])
        self.assertIsNone(result["normalized"]["sharedFileId"])
        self.assertEqual([4], result["normalized"]["projectIds"])


if __name__ == "__main__":
    unittest.main()
