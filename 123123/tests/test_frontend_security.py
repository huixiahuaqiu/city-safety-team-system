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

    def test_gateway_outbox_isolation_revision_and_error_quarantine(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for the gateway sync regression test")

        source_path = APP_DIR / "js" / "app-core.js"
        script = r"""
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
(async function() {

class MemoryStorage {
    constructor() { this.values = Object.create(null); }
    getItem(key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
    }
    setItem(key, value) { this.values[String(key)] = String(value); }
    removeItem(key) { delete this.values[String(key)]; }
    clear() { this.values = Object.create(null); }
    key(index) { return Object.keys(this.values)[index] || null; }
    get length() { return Object.keys(this.values).length; }
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
const listeners = Object.create(null);
const elements = new Map();
function makeElement() {
    return {
        id: '',
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {},
        removeChild() {},
        remove() {},
        addEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        hasAttribute() { return false; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        focus() {},
        click() {},
        textContent: '',
        innerHTML: '',
        value: ''
    };
}
const document = {
    readyState: 'loading',
    body: makeElement(),
    documentElement: makeElement(),
    addEventListener() {},
    createElement() { return makeElement(); },
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
};
class TestCustomEvent {
    constructor(type, options) {
        this.type = type;
        this.detail = options && options.detail;
    }
}
const location = {
    href: 'http://localhost/index.html',
    origin: 'http://localhost',
    reload() {}
};
let fetchImpl = async function() {
    return makeResponse(200, { item: { version: 1 } });
};
function makeResponse(status, payload) {
    return {
        status,
        ok: status >= 200 && status < 300,
        async json() { return payload; },
        async text() { return JSON.stringify(payload || {}); }
    };
}
const quietConsole = { log() {}, warn() {}, error() {}, info() {} };
const window = {
    APP_CONFIG: {
        GATEWAY_AUTH_ENABLED: true,
        DATA_BACKEND: 'gateway',
        APP_ENV: 'development'
    },
    document,
    localStorage,
    sessionStorage,
    location,
    fetch() { return fetchImpl.apply(null, arguments); },
    addEventListener(type, listener) {
        (listeners[type] || (listeners[type] = [])).push(listener);
    },
    dispatchEvent(event) {
        (listeners[event.type] || []).slice().forEach(function(listener) { listener(event); });
        return true;
    }
};
window.window = window;

const context = vm.createContext({
    window,
    document,
    localStorage,
    sessionStorage,
    Storage: MemoryStorage,
    CustomEvent: TestCustomEvent,
    location,
    URL,
    Headers,
    Request,
    Blob,
    console: quietConsole,
    fetch() { return fetchImpl.apply(null, arguments); },
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    navigator: {},
    alert() {},
    confirm() { return true; }
});

function setSession(user) {
    MemoryStorage.prototype.setItem.call(sessionStorage, 'citysafeGatewaySession', JSON.stringify({
        token: 'token-' + user.id + '-' + user.role,
        expiresAt: Date.now() + 600000,
        user
    }));
}
function readMap(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); }
    catch (_) { return {}; }
}
function clearMap(key) {
    MemoryStorage.prototype.removeItem.call(localStorage, key);
}
async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(function(resolve) { setImmediate(resolve); });
    }
    throw new Error('timed out waiting for sync state');
}

setSession({ id: 1, studentId: 'same', role: 'admin' });
vm.runInContext(source, context, { filename: process.argv[1] });
vm.runInContext(`
window.__coreSyncTest = {
    currentCloudPrincipal,
    principalStorageKey,
    rememberCloudMutation,
    clearCloudMutation,
    advanceCloudMutationBase,
    cloudUpsert,
    flushCloudOutbox,
    syncKeys: Array.from(CLOUD_SYNC_KEYS)
};
`, context);
const api = window.__coreSyncTest;

MemoryStorage.prototype.setItem.call(localStorage, 'permissionMatrix', JSON.stringify([
    ['内部任务待办（创建/分配）', true, true, true, false],
    ['内部任务待办（查看自己的）', true, true, true, false]
]));

const adminPrincipal = api.currentCloudPrincipal();
const adminOutboxKey = api.principalStorageKey('citysafeSyncOutbox');
const adminEntry = api.rememberCloudMutation('taskData', JSON.stringify({ owner: 'admin' }));
setSession({ id: 1, studentId: 'same', role: 'leader' });
const leaderPrincipal = api.currentCloudPrincipal();
const leaderOutboxKey = api.principalStorageKey('citysafeSyncOutbox');
const leaderEntry = api.rememberCloudMutation('taskData', JSON.stringify({ owner: 'leader' }));
const isolation = {
    adminPrincipal,
    leaderPrincipal,
    adminOutboxKey,
    leaderOutboxKey,
    adminEntry,
    leaderEntry,
    adminStored: readMap(adminOutboxKey).taskData,
    leaderStored: readMap(leaderOutboxKey).taskData
};
clearMap(adminOutboxKey);
clearMap(leaderOutboxKey);

setSession({ id: 20, studentId: 'race', role: 'admin' });
const raceOutboxKey = api.principalStorageKey('citysafeSyncOutbox');
clearMap(raceOutboxKey);
clearMap(api.principalStorageKey('citysafeSyncVersions'));
const pending = [];
const raceRequests = [];
fetchImpl = function(url, options) {
    const body = JSON.parse(options.body || '{}');
    raceRequests.push(body);
    return new Promise(function(resolve) {
        pending.push(function(version) {
            resolve(makeResponse(200, { item: { version } }));
        });
    });
};
const firstWrite = api.cloudUpsert('taskData', JSON.stringify({ revision: 1 }));
await waitFor(function() { return pending.length === 1; });
const secondWrite = api.cloudUpsert('taskData', JSON.stringify({ revision: 2 }));
const afterSecondQueue = readMap(raceOutboxKey).taskData;
pending.shift()(1);
await waitFor(function() { return pending.length === 1; });
pending.shift()(2);
await Promise.all([firstWrite, secondWrite]);
const race = {
    afterSecondQueue,
    requests: raceRequests,
    finalOutbox: readMap(raceOutboxKey)
};

const quarantine = {};
for (const status of [400, 403, 413]) {
    setSession({ id: 100 + status, studentId: 'status-' + status, role: 'admin' });
    const outboxKey = api.principalStorageKey('citysafeSyncOutbox');
    const rejectedKey = api.principalStorageKey('citysafeSyncRejected');
    clearMap(outboxKey);
    clearMap(rejectedKey);
    const seen = [];
    fetchImpl = async function(url, options) {
        const body = JSON.parse(options.body || '{}');
        seen.push(body.key);
        if (body.key === 'taskData') {
            return makeResponse(status, { error: 'rejected-' + status });
        }
        return makeResponse(200, { item: { version: 1 } });
    };
    api.rememberCloudMutation('taskData', JSON.stringify({ bad: status }));
    api.rememberCloudMutation('weeklyReportData', JSON.stringify({ good: status }));
    await api.flushCloudOutbox();
    quarantine[status] = {
        seen,
        outbox: readMap(outboxKey),
        rejected: readMap(rejectedKey)
    };
}

setSession({ id: 900, studentId: 'logs', role: 'admin' });
const logOutboxKey = api.principalStorageKey('citysafeSyncOutbox');
clearMap(logOutboxKey);
const logs = {
    loginAccepted: api.rememberCloudMutation('loginLogData', '[]') !== null,
    operationAccepted: api.rememberCloudMutation('operationLogData', '[]') !== null,
    syncKeys: api.syncKeys,
    outbox: readMap(logOutboxKey)
};

let expiredEvent = null;
window.addEventListener('citysafe:auth-expired', function(event) {
    expiredEvent = event && event.detail;
});
setSession({ id: 999, studentId: 'expired', role: 'admin' });
fetchImpl = async function() {
    return makeResponse(401, { error: 'invalid or expired session' });
};
await window.GatewayAuth.fetch('/api/private', { method: 'GET' });
const auth = {
    expiredEvent,
    sessionAfter401: sessionStorage.getItem('citysafeGatewaySession')
};

process.stdout.write(JSON.stringify({ isolation, race, quarantine, logs, auth }));
})().catch(function(error) {
    process.stderr.write(String(error && error.stack || error));
    process.exitCode = 1;
});
"""
        completed = subprocess.run(
            [node, "--input-type=commonjs", "-e", script, str(source_path)],
            cwd=APP_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)

        isolation = result["isolation"]
        self.assertNotEqual(isolation["adminPrincipal"], isolation["leaderPrincipal"])
        self.assertNotEqual(isolation["adminOutboxKey"], isolation["leaderOutboxKey"])
        self.assertEqual(isolation["adminPrincipal"], isolation["adminEntry"]["owner"])
        self.assertEqual(isolation["leaderPrincipal"], isolation["leaderEntry"]["owner"])
        self.assertEqual('{"owner":"admin"}', isolation["adminStored"]["rawValue"])
        self.assertEqual('{"owner":"leader"}', isolation["leaderStored"]["rawValue"])

        race = result["race"]
        self.assertEqual(2, race["afterSecondQueue"]["revision"])
        self.assertEqual([1, 2], [item["value"]["revision"] for item in race["requests"]])
        self.assertEqual([0, 1], [item["baseVersion"] for item in race["requests"]])
        self.assertEqual({}, race["finalOutbox"])

        for status in ("400", "403", "413"):
            case = result["quarantine"][status]
            self.assertEqual(["taskData", "weeklyReportData"], case["seen"])
            self.assertEqual({}, case["outbox"])
            self.assertEqual(int(status), case["rejected"]["taskData"]["status"])

        logs = result["logs"]
        self.assertFalse(logs["loginAccepted"])
        self.assertFalse(logs["operationAccepted"])
        self.assertNotIn("loginLogData", logs["syncKeys"])
        self.assertNotIn("operationLogData", logs["syncKeys"])
        self.assertEqual({}, logs["outbox"])

        self.assertEqual(
            "server-rejected-session",
            result["auth"]["expiredEvent"]["reason"],
        )
        self.assertIsNone(result["auth"]["sessionAfter401"])

    def test_gateway_accounts_drop_verifiers_and_batch_passwords_are_unique(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for the account security regression test")

        source_path = APP_DIR / "js" / "app-legacy-b.js"
        script = r"""
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[1], 'utf8');

class MemoryStorage {
    constructor() { this.values = Object.create(null); }
    getItem(key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
    }
    setItem(key, value) { this.values[String(key)] = String(value); }
    removeItem(key) { delete this.values[String(key)]; }
    clear() { this.values = Object.create(null); }
}
const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
const listeners = Object.create(null);
const elements = new Map();
function makeElement() {
    return {
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        appendChild() {},
        removeChild() {},
        remove() {},
        setAttribute() {},
        removeAttribute() {},
        hasAttribute() { return false; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        focus() {},
        click() {},
        value: '',
        checked: false,
        textContent: '',
        innerHTML: ''
    };
}
const document = {
    readyState: 'loading',
    body: makeElement(),
    documentElement: makeElement(),
    addEventListener() {},
    createElement() { return makeElement(); },
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
};
let randomCall = 0;
const deterministicCrypto = {
    getRandomValues(bytes) {
        randomCall += 1;
        for (let i = 0; i < bytes.length; i++) bytes[i] = (randomCall * 29 + i * 7) % 256;
        return bytes;
    }
};
const gatewayAuth = {
    enabled: true,
    hasSession() { return false; },
    read() { return null; },
    clear() {},
    async fetch() {
        return { ok: true, status: 200, async json() { return {}; } };
    }
};
const window = {
    GatewayAuth: gatewayAuth,
    crypto: deterministicCrypto,
    AppStorage: {
        getJson(key, fallback) {
            const raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        },
        setJson(key, value) {
            MemoryStorage.prototype.setItem.call(localStorage, key, JSON.stringify(value));
            return true;
        }
    },
    addEventListener(type, listener) {
        (listeners[type] || (listeners[type] = [])).push(listener);
    },
    dispatchEvent(event) {
        (listeners[event.type] || []).slice().forEach(function(listener) { listener(event); });
    },
    location: { href: 'http://localhost/', reload() {} },
    matchMedia() { return { matches: true }; }
};
window.window = window;
const quietConsole = { log() {}, warn() {}, error() {}, info() {} };
const context = vm.createContext({
    window,
    document,
    localStorage,
    sessionStorage,
    Storage: MemoryStorage,
    console: quietConsole,
    navigator: {},
    location: window.location,
    URL,
    Blob,
    crypto: deterministicCrypto,
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    TextEncoder,
    Uint8Array,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    alert() {},
    confirm() { return true; },
    prompt() { return null; },
    showModule() {},
    getComputedStyle() { return {}; },
    CSS: { escape(value) { return String(value); } }
});
vm.runInContext(source, context, { filename: process.argv[1] });
vm.runInContext(`
window.__legacyAccountTest = {
    setAccountPassword,
    saveAccountData,
    sanitizeGatewayAccountsForBrowser,
    generateTemporaryPassword,
    confirmAccountImport,
    setAccounts: function(value) { accountData = value; },
    getAccounts: function() { return accountData; },
    setCurrentUser: function(value) { currentUser = value; },
    setImportPreview: function(value) { importPreviewData = value; }
};
`, context);
const api = window.__legacyAccountTest;

(async function() {
    const account = {
        id: 1,
        studentId: 'gateway-user',
        role: 'student',
        password: 'plain-text',
        passwordScheme: 'pbkdf2-sha256',
        passwordSalt: 'salt',
        passwordIterations: 120000,
        passwordHash: 'hash',
        passwordUpdatedAt: 123
    };
    api.setAccounts([account]);
    api.setCurrentUser(null);
    const passwordResult = await api.setAccountPassword(account, 'new-password');
    api.saveAccountData();
    const persisted = JSON.parse(localStorage.getItem('accountData') || '[]');

    api.setAccounts([]);
    api.setCurrentUser({ id: 99, studentId: 'admin', role: 'admin' });
    api.setImportPreview([
        {
            rowNum: 1,
            studentId: 'student-a',
            realName: 'A',
            role: 'student',
            group: '第一小组',
            grade: '2026',
            research: '',
            phone: '',
            email: ''
        },
        {
            rowNum: 2,
            studentId: 'student-b',
            realName: 'B',
            role: 'student',
            group: '第二小组',
            grade: '2026',
            research: '',
            phone: '',
            email: ''
        },
        {
            rowNum: 3,
            studentId: 'student-c',
            realName: 'C',
            role: 'leader',
            group: '第三小组',
            grade: '2025',
            research: '',
            phone: '',
            email: ''
        }
    ]);
    api.confirmAccountImport();
    const imported = api.getAccounts().map(function(account) {
        return {
            studentId: account.studentId,
            password: account.password,
            mustChangePwd: account.mustChangePwd
        };
    });

    process.stdout.write(JSON.stringify({
        passwordResult,
        accountAfterSet: account,
        persisted,
        imported,
        randomCall
    }));
})().catch(function(error) {
    process.stderr.write(String(error && error.stack || error));
    process.exitCode = 1;
});
"""
        completed = subprocess.run(
            [node, "-e", script, str(source_path)],
            cwd=APP_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)

        self.assertTrue(result["passwordResult"]["serverManaged"])
        verifier_fields = {
            "password",
            "passwordScheme",
            "passwordSalt",
            "passwordIterations",
            "passwordHash",
        }
        self.assertTrue(verifier_fields.isdisjoint(result["accountAfterSet"]))
        self.assertEqual(1, len(result["persisted"]))
        self.assertTrue(
            (verifier_fields | {"passwordUpdatedAt"}).isdisjoint(result["persisted"][0])
        )

        imported = result["imported"]
        self.assertEqual(3, len(imported))
        passwords = [account["password"] for account in imported]
        self.assertEqual(3, len(set(passwords)))
        # 生成器已加强：12 位混合大小写/数字（排除易混淆字符）+ 固定 'A9!' 后缀
        self.assertTrue(all(re.fullmatch(r"Tmp-[0-9a-zA-Z]{12}A9!", pwd) for pwd in passwords))
        self.assertTrue(all(account["mustChangePwd"] for account in imported))
        self.assertEqual(3, result["randomCall"])

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
