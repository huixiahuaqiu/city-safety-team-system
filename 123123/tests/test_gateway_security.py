import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


APP_DIR = Path(__file__).resolve().parents[1]


def load_gateway():
    secure_env = {
        "BIND_HOST": "127.0.0.1",
        "CORS_ALLOW_ORIGINS": "https://team.example.edu",
        "DATASET_UPLOAD_TOKEN": "dataset-test-token",
        "ANNOTATION_UPLOAD_TOKEN": "annotation-test-token",
        "MLOPS_TOKEN": "mlops-test-token",
        "ALLOW_INSECURE_LOCAL_WRITES": "0",
        "CITYSAFE_ENV": "development",
        "AUTH_REQUIRED": "0",
        "AUTH_SIGNING_SECRET": "test-signing-secret-at-least-32-bytes-long",
        "SUPABASE_URL": "",
        "SUPABASE_KEY": "",
        "SUPABASE_SERVICE_ROLE_KEY": "",
    }
    os.environ.update(secure_env)
    spec = importlib.util.spec_from_file_location(
        "citysafe_gateway_under_test", APP_DIR / "working_proxy.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeHandler:
    def __init__(self, headers=None, client_ip="127.0.0.1", path="/"):
        self.headers = headers or {}
        self.client_address = (client_ip, 12345)
        self.path = path
        self.response_headers = {}

    def send_header(self, name, value):
        self.response_headers[name] = value


class GatewaySecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gateway = load_gateway()

    def test_dataset_token_is_required_and_checked(self):
        self.assertFalse(self.gateway.check_dataset_token(FakeHandler()))
        self.assertFalse(
            self.gateway.check_dataset_token(
                FakeHandler({"X-Upload-Token": "wrong"})
            )
        )
        self.assertTrue(
            self.gateway.check_dataset_token(
                FakeHandler({"X-Upload-Token": "dataset-test-token"})
            )
        )

    def test_annotation_token_is_required_and_checked(self):
        self.assertFalse(self.gateway.check_upload_token(FakeHandler()))
        self.assertTrue(
            self.gateway.check_upload_token(
                FakeHandler({"Authorization": "Bearer annotation-test-token"})
            )
        )

    def test_mlops_secret_is_header_only_and_query_is_redacted_from_logs(self):
        query_handler = FakeHandler(
            path="/api/mlops/jobs?token=mlops-test-token&other=value"
        )
        self.assertFalse(self.gateway.check_token(query_handler))
        self.assertTrue(
            self.gateway.check_token(
                FakeHandler(
                    {"X-MLOps-Token": "mlops-test-token"},
                    path="/api/mlops/jobs",
                )
            )
        )
        with mock.patch.object(self.gateway.logger, "info") as log:
            self.gateway.WorkingProxyHandler.log_message(
                query_handler,
                '"%s" %s',
                "GET /api/mlops/jobs?token=mlops-test-token&other=value HTTP/1.1",
                "200",
            )
        rendered = " ".join(str(arg) for arg in log.call_args.args)
        self.assertNotIn("mlops-test-token", rendered)
        self.assertIn("/api/mlops/jobs", rendered)

    def test_dataset_identifier_rejects_empty_or_unsafe_value(self):
        with self.assertRaises(ValueError):
            self.gateway._safe_dataset_id("../")
        with self.assertRaises(ValueError):
            self.gateway._safe_dataset_id("safe/../collision")
        with self.assertRaises(ValueError):
            self.gateway._safe_dataset_id(
                "x" * (self.gateway.DATASET_UPLOAD_ID_MAX_LENGTH + 1)
            )
        self.assertEqual(self.gateway._safe_dataset_id("task_01-a"), "task_01-a")

    def test_binary_upload_is_rejected_before_request_body_is_read(self):
        class FailIfRead:
            def __init__(self):
                self.called = False

            def read(self, *_args, **_kwargs):
                self.called = True
                raise AssertionError("request body must not be read")

        def exercise(claims):
            handler = object.__new__(self.gateway.WorkingProxyHandler)
            handler.path = "/api/dataset/chunk"
            handler.headers = {
                "Content-Length": str(self.gateway.DATASET_MAX_CHUNK_BYTES + 1),
            }
            handler.client_address = ("127.0.0.1", 12345)
            handler.rfile = FailIfRead()
            responses = []
            handler._json = lambda status, body: responses.append((status, body))
            with mock.patch.object(
                self.gateway,
                "_dataset_request_claims",
                return_value=claims,
            ):
                handler.do_POST()
            self.assertFalse(handler.rfile.called)
            self.assertEqual(len(responses), 1)
            return responses[0][0]

        self.assertEqual(exercise(None), 401)
        self.assertEqual(
            exercise({"sid": "alice", "sub": "alice", "role": "student"}),
            413,
        )

    def test_dataset_upload_owner_and_purge_permissions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_root = Path(temp_dir) / "datasets"
            registry_path = dataset_root / "_registry.json"
            with (
                mock.patch.object(
                    self.gateway, "DATASET_UPLOAD_ROOT", str(dataset_root)
                ),
                mock.patch.object(
                    self.gateway, "DATASET_META_PATH", str(registry_path)
                ),
            ):
                created = self.gateway.init_dataset_upload(
                    {
                        "uploadId": "owned-upload",
                        "fileName": "sample.csv",
                        "size": 4,
                        "chunkSize": self.gateway.DATASET_MIN_CHUNK_BYTES,
                    },
                    actor="alice",
                    role="student",
                )
                self.assertEqual(created["totalChunks"], 1)

                with self.assertRaises(PermissionError):
                    self.gateway.save_dataset_chunk(
                        "owned-upload",
                        0,
                        b"data",
                        total_chunks=1,
                        actor="bob",
                        role="student",
                    )
                with self.assertRaises(PermissionError):
                    self.gateway.abort_dataset_upload(
                        "owned-upload",
                        actor="bob",
                        role="student",
                    )

                removed = self.gateway.abort_dataset_upload(
                    "owned-upload",
                    actor="team-leader",
                    role="leader",
                )
                self.assertTrue(removed["removed"])

                self.gateway.init_dataset_upload(
                    {
                        "uploadId": "purge-target",
                        "fileName": "sample.csv",
                        "size": 4,
                        "chunkSize": self.gateway.DATASET_MIN_CHUNK_BYTES,
                    },
                    actor="alice",
                    role="student",
                )
                with self.assertRaises(PermissionError):
                    self.gateway.purge_incomplete_dataset_uploads(
                        actor="alice",
                        role="student",
                    )
                purge_result = self.gateway.purge_incomplete_dataset_uploads(
                    actor="root-admin",
                    role="admin",
                )
                self.assertEqual(purge_result["purged"], ["purge-target"])

    def test_dataset_chunk_requires_initialized_bounded_session(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_root = Path(temp_dir) / "datasets"
            registry_path = dataset_root / "_registry.json"
            with (
                mock.patch.object(
                    self.gateway, "DATASET_UPLOAD_ROOT", str(dataset_root)
                ),
                mock.patch.object(
                    self.gateway, "DATASET_META_PATH", str(registry_path)
                ),
            ):
                with self.assertRaises(FileNotFoundError):
                    self.gateway.save_dataset_chunk(
                        "never-initialized",
                        0,
                        b"x",
                        total_chunks=1,
                        actor="alice",
                        role="student",
                    )
                self.assertFalse(
                    (dataset_root / "_tmp" / "never-initialized").exists()
                )

                for invalid_chunk_size in (
                    self.gateway.DATASET_MIN_CHUNK_BYTES - 1,
                    self.gateway.DATASET_MAX_CHUNK_BYTES + 1,
                ):
                    with self.subTest(chunk_size=invalid_chunk_size):
                        with self.assertRaisesRegex(ValueError, "chunkSize"):
                            self.gateway.init_dataset_upload(
                                {
                                    "fileName": "sample.csv",
                                    "size": 4,
                                    "chunkSize": invalid_chunk_size,
                                },
                                actor="alice",
                                role="student",
                            )

                self.gateway.init_dataset_upload(
                    {
                        "uploadId": "bounded-upload",
                        "fileName": "sample.csv",
                        "size": 4,
                        "chunkSize": self.gateway.DATASET_MIN_CHUNK_BYTES,
                    },
                    actor="alice",
                    role="student",
                )
                with self.assertRaisesRegex(ValueError, "totalChunks"):
                    self.gateway.validate_dataset_chunk_request(
                        "bounded-upload",
                        0,
                        4,
                        total_chunks=2_147_483_647,
                        actor="alice",
                        role="student",
                    )
                with self.assertRaisesRegex(ValueError, "index"):
                    self.gateway.validate_dataset_chunk_request(
                        "bounded-upload",
                        1_000_000_000,
                        4,
                        total_chunks=1,
                        actor="alice",
                        role="student",
                    )

                registry = self.gateway._dataset_registry_load()
                registry["uploads"]["bounded-upload"]["totalChunks"] = 2_147_483_647
                self.gateway._dataset_registry_save(registry)
                with self.assertRaisesRegex(ValueError, "totalChunks"):
                    self.gateway.complete_dataset_upload(
                        {"uploadId": "bounded-upload"},
                        actor="alice",
                        role="student",
                    )

    def test_dataset_purge_all_route_is_admin_only(self):
        body = json.dumps({"purgeAll": True}).encode("utf-8")
        handler = object.__new__(self.gateway.WorkingProxyHandler)
        handler.path = "/api/dataset/abort"
        handler.headers = {"Content-Length": str(len(body))}
        handler.client_address = ("127.0.0.1", 12345)
        handler.rfile = io.BytesIO(body)
        responses = []
        handler._json = lambda status, payload: responses.append((status, payload))
        student = {"sid": "alice", "sub": "alice", "role": "student"}
        with (
            mock.patch.object(
                self.gateway,
                "_dataset_request_claims",
                return_value=student,
            ),
            mock.patch.object(self.gateway, "audit_event"),
            mock.patch.object(
                self.gateway, "purge_incomplete_dataset_uploads"
            ) as purge,
        ):
            handler.do_POST()
        self.assertEqual(responses[0][0], 403)
        purge.assert_not_called()

    def test_dataset_upload_happy_path_remains_compatible(self):
        import hashlib

        content = b"name,value\nsample,1\n"
        digest = hashlib.md5(content).hexdigest()
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_root = Path(temp_dir) / "datasets"
            registry_path = dataset_root / "_registry.json"
            with (
                mock.patch.object(
                    self.gateway, "DATASET_UPLOAD_ROOT", str(dataset_root)
                ),
                mock.patch.object(
                    self.gateway, "DATASET_META_PATH", str(registry_path)
                ),
                mock.patch.object(self.gateway, "CLAMAV_SCAN", False),
            ):
                initialized = self.gateway.init_dataset_upload(
                    {
                        "uploadId": "happy-upload",
                        "fileName": "sample.csv",
                        "size": len(content),
                        "md5": digest,
                        "chunkSize": self.gateway.DATASET_CHUNK_SIZE,
                    },
                    actor="alice",
                    role="student",
                )
                self.assertEqual(initialized["totalChunks"], 1)
                chunk_result = self.gateway.save_dataset_chunk(
                    "happy-upload",
                    0,
                    content,
                    total_chunks=1,
                    actor="alice",
                    role="student",
                )
                self.assertEqual(chunk_result["received"], 1)
                status = self.gateway.get_dataset_upload_status(
                    "happy-upload",
                    actor="alice",
                    role="student",
                )
                self.assertEqual(status["uploadedChunks"], [0])

                completed = self.gateway.complete_dataset_upload(
                    {
                        "uploadId": "happy-upload",
                        "fileName": "sample.csv",
                        "size": len(content),
                        "md5": digest,
                        "fileId": "happy-file",
                    },
                    actor="alice",
                    role="student",
                )
                self.assertEqual(completed["fileId"], "happy-file")
                self.assertEqual(completed["md5"], digest)
                registry = self.gateway._dataset_registry_load()
                self.assertNotIn("happy-upload", registry["uploads"])
                self.assertEqual(
                    registry["files"]["happy-file"]["owner"],
                    "alice",
                )
                self.assertTrue(
                    Path(registry["files"]["happy-file"]["path"]).is_file()
                )

    def test_minio_download_is_streamed_in_bounded_chunks(self):
        payload = (b"streamed-data-" * 100_000) + b"done"

        class FakeResponse:
            def __init__(self, value):
                self.value = value
                self.offset = 0
                self.read_sizes = []
                self.closed = False
                self.released = False

            def read(self, size):
                if not isinstance(size, int) or size <= 0:
                    raise AssertionError("download attempted an unbounded read")
                self.read_sizes.append(size)
                chunk = self.value[self.offset:self.offset + size]
                self.offset += len(chunk)
                return chunk

            def close(self):
                self.closed = True

            def release_conn(self):
                self.released = True

        response = FakeResponse(payload)

        class FakeClient:
            def stat_object(self, _bucket, _object_key):
                return type("Stat", (), {"size": len(payload)})()

            def get_object(self, _bucket, _object_key):
                return response

        class FakeStreamHandler:
            def __init__(self):
                self.status = None
                self.headers = {}
                self.wfile = io.BytesIO()
                self.close_connection = False

            def send_response(self, status):
                self.status = status

            def send_header(self, name, value):
                self.headers[name] = value

            def _cors(self):
                return None

            def end_headers(self):
                return None

        handler = FakeStreamHandler()
        streamed = self.gateway._stream_minio_download(
            handler,
            FakeClient(),
            "shared/large-object.bin",
            "large-object.bin",
        )
        self.assertTrue(streamed)
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.headers["Content-Length"], str(len(payload)))
        self.assertEqual(handler.wfile.getvalue(), payload)
        self.assertGreater(len(response.read_sizes), 1)
        self.assertTrue(all(size <= 1024 * 1024 for size in response.read_sizes))
        self.assertTrue(response.closed)
        self.assertTrue(response.released)

    def test_secure_network_defaults_are_explicit(self):
        self.assertEqual(self.gateway.BIND_HOST, "127.0.0.1")
        self.assertNotIn("*", self.gateway.CORS_ALLOW_ORIGINS)

    def test_security_headers_and_origin_allowlist(self):
        trusted = FakeHandler({"Origin": "https://team.example.edu"})
        self.gateway.WorkingProxyHandler._cors(trusted)
        self.assertEqual(trusted.response_headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(trusted.response_headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertIn("object-src 'none'", trusted.response_headers["Content-Security-Policy"])
        self.assertEqual(
            trusted.response_headers["Access-Control-Allow-Origin"],
            "https://team.example.edu",
        )

        hostile = FakeHandler({"Origin": "https://evil.example"})
        self.gateway.WorkingProxyHandler._cors(hostile)
        self.assertNotIn("Access-Control-Allow-Origin", hostile.response_headers)

    def test_signed_gateway_session_is_tamper_evident_and_role_aware(self):
        token, claims = self.gateway.issue_session_token(
            {
                "id": 7,
                "studentId": "stu007",
                "realName": "测试成员",
                "role": "student",
            }
        )
        self.assertEqual(self.gateway.verify_session_token(token)["sub"], "7")
        self.assertIsNone(self.gateway.verify_session_token(token + "tampered"))

        handler = FakeHandler({"Authorization": "Bearer " + token})
        self.assertTrue(self.gateway.check_dataset_token(handler, ("student",)))
        self.assertFalse(self.gateway.check_dataset_token(handler, ("admin", "leader")))
        self.assertEqual(claims["sid"], "stu007")

    def test_gateway_session_is_revoked_after_sensitive_account_changes(self):
        account = {
            "id": 7,
            "studentId": "stu007",
            "realName": "Test Member",
            "role": "student",
            "status": "active",
            "passwordUpdatedAt": 1700000000000,
            "sessionVersion": 3,
        }
        token, claims = self.gateway.issue_session_token(account)
        self.assertEqual(claims["pwu"], account["passwordUpdatedAt"])
        self.assertEqual(claims["sv"], account["sessionVersion"])
        handler = FakeHandler({"Authorization": "Bearer " + token})

        with (
            mock.patch.object(self.gateway, "AUTH_REQUIRED", True),
            mock.patch.object(
                self.gateway, "load_gateway_accounts", return_value=[dict(account)]
            ),
        ):
            self.assertIsNotNone(self.gateway.check_gateway_session(handler))

        changed_accounts = {
            "password change": {
                **account,
                "passwordUpdatedAt": account["passwordUpdatedAt"] + 1,
            },
            "account disabled": {**account, "status": "disabled"},
            "role change": {**account, "role": "leader"},
            "logout": {**account, "sessionVersion": account["sessionVersion"] + 1},
        }
        for reason, changed_account in changed_accounts.items():
            with self.subTest(reason=reason):
                with (
                    mock.patch.object(self.gateway, "AUTH_REQUIRED", True),
                    mock.patch.object(
                        self.gateway,
                        "load_gateway_accounts",
                        return_value=[changed_account],
                    ),
                ):
                    self.assertIsNone(self.gateway.check_gateway_session(handler))

    def test_prepare_gateway_accounts_removes_plaintext_and_preserves_verifier(self):
        existing = {
            "id": 7,
            "studentId": "stu007",
            "realName": "Existing Member",
            "role": "student",
            "status": "active",
            "passwordScheme": "pbkdf2-sha256",
            "passwordSalt": "existing-salt",
            "passwordIterations": 210000,
            "passwordHash": "existing-verifier",
            "passwordUpdatedAt": 1700000000000,
        }
        incoming = {
            "id": 7,
            "studentId": "stu007",
            "realName": "Renamed Member",
            "role": "student",
            "status": "active",
            "password": "",
        }

        prepared = self.gateway._prepare_gateway_accounts([incoming], [existing])[0]

        self.assertNotIn("password", prepared)
        for field in (
            "passwordScheme",
            "passwordSalt",
            "passwordIterations",
            "passwordHash",
            "passwordUpdatedAt",
        ):
            self.assertEqual(prepared[field], existing[field])
        self.assertEqual(prepared["realName"], "Renamed Member")

    def test_sync_write_permissions_follow_role_boundaries(self):
        roles = ("admin", "leader", "student", "visitor")

        admin_only = {
            role: self.gateway._sync_write_allowed(
                {"role": role}, "permissionMatrix"
            )
            for role in roles
        }
        self.assertEqual(
            admin_only,
            {"admin": True, "leader": False, "student": False, "visitor": False},
        )

        leader_write = {
            role: self.gateway._sync_write_allowed(
                {"role": role}, "teamMemberData"
            )
            for role in roles
        }
        self.assertEqual(
            leader_write,
            {"admin": True, "leader": False, "student": False, "visitor": False},
        )

        member_write = {
            role: self.gateway._sync_write_allowed({"role": role}, "patentData")
            for role in roles
        }
        self.assertEqual(
            member_write,
            {"admin": True, "leader": False, "student": False, "visitor": False},
        )
        self.assertFalse(self.gateway._sync_write_allowed({}, "patentData"))

        scoped_write = {
            role: self.gateway._sync_write_allowed({"role": role}, "taskData")
            for role in roles
        }
        self.assertEqual(
            scoped_write,
            {"admin": True, "leader": True, "student": True, "visitor": False},
        )

    def test_server_verifies_browser_pbkdf2_record(self):
        import base64
        import hashlib

        password = "Secure-Password-123"
        salt = b"0123456789abcdef"
        iterations = 120000
        verifier = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations, dklen=32
        )
        account = {
            "passwordScheme": "pbkdf2-sha256",
            "passwordSalt": base64.b64encode(salt).decode("ascii"),
            "passwordIterations": iterations,
            "passwordHash": base64.b64encode(verifier).decode("ascii"),
        }
        self.assertTrue(self.gateway.verify_gateway_password(account, password))
        self.assertFalse(self.gateway.verify_gateway_password(account, "wrong"))

    def test_production_rejects_disabled_gateway_authentication(self):
        with (
            mock.patch.object(self.gateway, "CITYSAFE_ENV", "production"),
            mock.patch.object(self.gateway, "AUTH_REQUIRED", False),
        ):
            with self.assertRaisesRegex(RuntimeError, "AUTH_REQUIRED"):
                self.gateway.validate_runtime_config()

    def test_static_path_resolution_blocks_traversal_and_private_files(self):
        index_path = self.gateway.resolve_static_file_path("/")
        self.assertEqual(Path(index_path).name, "index.html")

        for unsafe_path in (
            "/../123123-sibling/secret.txt",
            "/%2e%2e/secret.txt",
            r"/..\secret.txt",
            "/.env",
            "/config.local.js",
            "/working_proxy.py",
            "/uploads/private.bin",
            "/logs/server_audit.log",
        ):
            with self.subTest(path=unsafe_path):
                with self.assertRaises(PermissionError):
                    self.gateway.resolve_static_file_path(unsafe_path)

    def test_public_registration_requires_mentor_approval(self):
        accounts = []

        def load_accounts(force=False):
            return list(accounts)

        def save_accounts(next_accounts, actor='gateway-auth'):
            accounts[:] = list(next_accounts)

        with (
            mock.patch.object(self.gateway, "POSTGRES_DATA_BACKEND", True),
            mock.patch.object(self.gateway, "load_gateway_accounts", side_effect=load_accounts),
            mock.patch.object(self.gateway, "save_gateway_accounts", side_effect=save_accounts),
            mock.patch.object(self.gateway, "validate_new_password", return_value=True),
            mock.patch.object(
                self.gateway,
                "create_gateway_password_record",
                return_value={
                    "passwordScheme": "pbkdf2-sha256",
                    "passwordSalt": "c2FsdA==",
                    "passwordIterations": 120000,
                    "passwordHash": "aGFzaA==",
                    "passwordUpdatedAt": 1,
                },
            ),
            mock.patch.object(self.gateway, "verify_gateway_password", return_value=True),
        ):
            created = self.gateway.register_gateway_account({
                "username": "newstu01",
                "realName": "新同学",
                "password": "SafePass12",
                "role": "student",
                "note": "请导师批准",
            }, client_ip="127.0.0.1")
            self.assertEqual(created["status"], "pending")
            self.assertFalse(created.get("mustChangePwd"))
            self.assertFalse(created.get("firstLogin"))
            self.assertEqual(len(accounts), 1)
            self.assertEqual(accounts[0]["studentId"], "newstu01")

            approved = self.gateway.approve_gateway_registration("newstu01", "admin")
            self.assertEqual(approved["status"], "active")
            self.assertFalse(approved.get("mustChangePwd"))
            self.assertFalse(approved.get("firstLogin"))
            self.assertEqual(accounts[0]["status"], "active")

            accounts[0]["status"] = "pending"
            rejected = self.gateway.reject_gateway_registration("newstu01", "admin", reason="信息不符")
            self.assertEqual(rejected["studentId"], "newstu01")
            self.assertEqual(accounts, [])

    def test_prepare_gateway_accounts_allows_pending_status(self):
        prepared = self.gateway._prepare_gateway_accounts(
            [{
                "studentId": "pending01",
                "realName": "待审",
                "role": "student",
                "status": "pending",
                "password": "SafePass12",
            }],
            [],
        )
        self.assertEqual(prepared[0]["status"], "pending")
        self.assertTrue(prepared[0].get("passwordHash"))

    def test_server_password_policy_can_be_tightened_but_not_weakened(self):
        strict_policy = {
            "value": {
                "minLength": 12,
                "requireUpper": True,
                "requireLower": True,
                "requireDigit": False,
                "requireSpecial": True,
            }
        }
        with (
            mock.patch.object(self.gateway, "POSTGRES_DATA_BACKEND", True),
            mock.patch.object(
                self.gateway.data_store,
                "get_sync_value",
                return_value=strict_policy,
            ),
        ):
            self.assertTrue(self.gateway.validate_new_password("StrongPass1!x"))
            self.assertFalse(self.gateway.validate_new_password("lowercase1!x"))
            self.assertFalse(self.gateway.validate_new_password("StrongPassword!"))
            self.assertFalse(self.gateway.validate_new_password("Short1!"))

        weak_policy = {
            "value": {
                "minLength": 4,
                "requireUpper": False,
                "requireLower": False,
                "requireDigit": False,
                "requireSpecial": False,
            }
        }
        with (
            mock.patch.object(self.gateway, "POSTGRES_DATA_BACKEND", True),
            mock.patch.object(
                self.gateway.data_store,
                "get_sync_value",
                return_value=weak_policy,
            ),
        ):
            self.assertFalse(self.gateway.validate_new_password("onlytext"))
            self.assertTrue(self.gateway.validate_new_password("safe1234"))

    def test_request_client_ip_honors_trusted_proxy_headers(self):
        edge = FakeHandler(
            {"X-Real-IP": "203.0.113.50"},
            client_ip="172.18.0.2",
        )
        self.assertEqual(self.gateway.request_client_ip(edge), "203.0.113.50")

        spoofed = FakeHandler(
            {"X-Real-IP": "203.0.113.50"},
            client_ip="198.51.100.9",
        )
        self.assertEqual(self.gateway.request_client_ip(spoofed), "198.51.100.9")

    def test_password_change_gate_blocks_sync_but_allows_me(self):
        claims = {
            "sub": "u1",
            "sid": "student01",
            "role": "student",
            "mustChangePwd": True,
        }
        sync_handler = FakeHandler(path="/api/sync/upsert")
        self.assertTrue(self.gateway._password_change_required(sync_handler, claims))
        me_handler = FakeHandler(path="/api/auth/me")
        self.assertFalse(self.gateway._password_change_required(me_handler, claims))
        change_handler = FakeHandler(path="/api/auth/change-password")
        self.assertFalse(self.gateway._password_change_required(change_handler, claims))


if __name__ == "__main__":
    unittest.main()
