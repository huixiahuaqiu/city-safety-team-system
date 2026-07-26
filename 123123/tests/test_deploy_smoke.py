from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import threading
import unittest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "deploy" / "scripts" / "smoke.py"
SPEC = importlib.util.spec_from_file_location("citysafe_deploy_smoke", MODULE_PATH)
SMOKE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(SMOKE)


class SmokeHandler(BaseHTTPRequestHandler):
    healthy = True
    seen_authorization = None

    def _json(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/health":
            self._json(
                200,
                {
                    "ok": True,
                    "ready": self.healthy,
                    "degraded": not self.healthy,
                },
            )
            return
        if self.path == "/api/auth/me":
            type(self).seen_authorization = self.headers.get("Authorization")
            if self.headers.get("Authorization") != "Bearer smoke-token":
                self._json(401, {"ok": False})
                return
            self._json(
                200,
                {
                    "ok": True,
                    "user": {"id": "7", "studentId": "demo", "role": "admin"},
                },
            )
            return
        self._json(404, {"ok": False})

    def do_POST(self):
        if self.path != "/api/auth/login":
            self._json(404, {"ok": False})
            return
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if payload != {"username": "demo", "password": "correct-password"}:
            self._json(401, {"ok": False})
            return
        self._json(
            200,
            {
                "ok": True,
                "token": "smoke-token",
                "user": {"id": "7", "studentId": "demo", "role": "admin"},
            },
        )

    def log_message(self, _format, *_args):
        return


class SmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), SmokeHandler)
        cls.thread = threading.Thread(
            target=cls.server.serve_forever,
            daemon=True,
        )
        cls.thread.start()
        host, port = cls.server.server_address
        cls.base_url = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        SmokeHandler.healthy = True
        SmokeHandler.seen_authorization = None

    def test_health_only_smoke_passes(self):
        result = SMOKE.run_smoke(
            self.base_url,
            wait_seconds=0,
            log=lambda _message: None,
        )
        self.assertTrue(result["health"]["ready"])
        self.assertNotIn("login", result)

    def test_degraded_health_fails_readiness(self):
        SmokeHandler.healthy = False
        with self.assertRaisesRegex(SMOKE.SmokeError, "readiness timed out"):
            SMOKE.run_smoke(
                self.base_url,
                wait_seconds=0,
                log=lambda _message: None,
            )

    def test_login_and_me_validate_the_same_session(self):
        result = SMOKE.run_smoke(
            self.base_url,
            username="demo",
            password="correct-password",
            wait_seconds=0,
            log=lambda _message: None,
        )
        self.assertEqual(result["me"]["user"]["id"], "7")
        self.assertEqual(
            SmokeHandler.seen_authorization,
            "Bearer smoke-token",
        )

    def test_partial_credentials_are_rejected(self):
        with self.assertRaisesRegex(
            SMOKE.SmokeError, "must be provided together"
        ):
            SMOKE.run_smoke(
                self.base_url,
                username="demo",
                wait_seconds=0,
                log=lambda _message: None,
            )

    def test_base_url_rejects_embedded_credentials(self):
        with self.assertRaisesRegex(SMOKE.SmokeError, "must not contain credentials"):
            SMOKE.normalize_base_url("http://user:secret@example.test")


if __name__ == "__main__":
    unittest.main()
