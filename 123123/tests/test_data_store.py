from contextlib import contextmanager
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest import mock


APP_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = APP_DIR.parent


def load_data_store():
    spec = importlib.util.spec_from_file_location(
        "citysafe_data_store_under_test",
        APP_DIR / "data_store.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeCursor:
    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.current = {}
        self.statements = []
        self.executemany_calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, query, params=None):
        self.statements.append((str(query), params))
        self.current = self.responses.pop(0) if self.responses else {}
        error = self.current.get("error")
        if error:
            raise error
        return self

    def executemany(self, query, params):
        values = list(params)
        self.executemany_calls.append((str(query), values))
        self.current = self.responses.pop(0) if self.responses else {}
        error = self.current.get("error")
        if error:
            raise error
        return self

    def fetchone(self):
        return self.current.get("one")

    def fetchall(self):
        return list(self.current.get("all") or [])


class FakeConnection:
    def __init__(self, responses=None):
        self.cursor_instance = FakeCursor(responses)
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self.cursor_instance


@contextmanager
def fake_connection(connection):
    try:
        yield connection
    except BaseException:
        connection.rolled_back = True
        raise
    else:
        connection.committed = True


class DataStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = load_data_store()

    def patch_connection(self, connection):
        return mock.patch.object(
            self.store,
            "_connection",
            return_value=fake_connection(connection),
        )

    def test_import_does_not_require_psycopg_and_database_flag_is_dynamic(self):
        with mock.patch.dict(os.environ, {"DATABASE_URL": "", "PGHOST": ""}):
            self.assertFalse(self.store.database_enabled())
            self.assertFalse(self.store.healthcheck())
        with mock.patch.dict(
            os.environ,
            {"DATABASE_URL": "postgresql://local/example"},
        ):
            self.assertTrue(self.store.database_enabled())

    def test_missing_psycopg_has_actionable_error(self):
        missing = ModuleNotFoundError(
            "No module named 'psycopg'",
            name="psycopg",
        )
        with mock.patch.object(
            self.store.importlib,
            "import_module",
            side_effect=missing,
        ):
            with self.assertRaisesRegex(
                self.store.DatabaseDriverUnavailable,
                r"psycopg 3.*pip install",
            ):
                self.store._load_psycopg()

    def test_healthcheck_executes_parameter_free_select(self):
        connection = FakeConnection([{"one": (1,)}])
        with (
            mock.patch.dict(
                os.environ,
                {"DATABASE_URL": "postgresql://local/example"},
            ),
            self.patch_connection(connection),
        ):
            self.assertTrue(self.store.healthcheck())
        self.assertTrue(connection.committed)
        self.assertEqual(
            connection.cursor_instance.statements,
            [("SELECT 1", None)],
        )

    def test_sync_create_uses_parameterized_atomic_insert(self):
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        dangerous = "x'); DROP TABLE app_sync; --"
        returned = (
            "noticeData",
            {"title": dangerous},
            1,
            now,
            "admin-1",
        )
        connection = FakeConnection([{"one": returned}])
        with self.patch_connection(connection):
            result = self.store.put_sync_value(
                "noticeData",
                {"title": dangerous},
                0,
                "admin-1",
            )

        self.assertEqual(result["version"], 1)
        self.assertEqual(result["updatedAt"], now.isoformat())
        query, params = connection.cursor_instance.statements[0]
        self.assertIn("ON CONFLICT (sync_key) DO NOTHING", query)
        self.assertNotIn(dangerous, query)
        self.assertEqual(params[0], "noticeData")
        self.assertEqual(json.loads(params[1]), {"title": dangerous})
        self.assertTrue(connection.committed)

    def test_sync_update_is_compare_and_swap_and_conflict_rolls_back(self):
        connection = FakeConnection(
            [
                {"one": None},
                {"one": (8,)},
            ]
        )
        with self.patch_connection(connection):
            with self.assertRaises(self.store.VersionConflict) as raised:
                self.store.put_sync_value(
                    "weeklyReportData",
                    [{"id": 9}],
                    7,
                    "leader-1",
                )

        conflict = raised.exception
        self.assertEqual(conflict.expected_version, 7)
        self.assertEqual(conflict.current_version, 8)
        self.assertEqual(conflict.as_dict()["error"], "version_conflict")
        update_query, update_params = connection.cursor_instance.statements[0]
        self.assertIn("WHERE sync_key = %s AND version = %s", update_query)
        self.assertEqual(update_params[-2:], ("weeklyReportData", 7))
        self.assertTrue(connection.rolled_back)
        self.assertFalse(connection.committed)

    def test_empty_sync_key_list_does_not_open_database(self):
        with mock.patch.object(
            self.store,
            "_connection",
            side_effect=AssertionError("database should not be opened"),
        ):
            self.assertEqual(self.store.list_sync_values([]), [])
        with self.assertRaises(TypeError):
            self.store.list_sync_values("noticeData")

    def test_record_filters_are_json_parameters_not_sql_fragments(self):
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        dangerous = "x' OR TRUE; --"
        row = (
            5,
            "patent",
            {"status": dangerous},
            2,
            now,
            now,
            "admin",
            "admin",
        )
        connection = FakeConnection([{"all": [row]}])
        with self.patch_connection(connection):
            records = self.store.list_records(
                "patent",
                filters={"status": dangerous},
                order_by="updated_at",
                limit=20,
            )

        self.assertEqual(records[0]["payload"]["status"], dangerous)
        query, params = connection.cursor_instance.statements[0]
        self.assertIn("payload @> %s::jsonb", query)
        self.assertNotIn(dangerous, query)
        self.assertEqual(json.loads(params[1]), {"status": dangerous})
        self.assertEqual(params[-2:], [20, 0])

    def test_record_sort_column_is_allowlisted(self):
        with self.assertRaises(ValueError):
            self.store.list_records(
                "patent",
                order_by="updated_at; DROP TABLE app_records",
            )
        with self.assertRaises(TypeError):
            self.store.list_records("patent", record_ids="123")
        with self.assertRaises(TypeError):
            self.store.list_records("patent", descending="false")

    def test_bulk_mutations_require_a_selector(self):
        with self.assertRaisesRegex(ValueError, "record_ids"):
            self.store.update_records(
                "patent",
                {"status": "approved"},
                actor="admin",
            )
        with self.assertRaisesRegex(ValueError, "record_ids"):
            self.store.delete_records("patent", actor="admin")

    def test_replace_accounts_is_atomic_and_preserves_order(self):
        accounts = [
            {"studentId": "s2", "realName": "Second"},
            {"studentId": "s1", "realName": "First"},
        ]
        connection = FakeConnection()
        with self.patch_connection(connection):
            count = self.store.replace_accounts(accounts, "admin")

        self.assertEqual(count, 2)
        statements = connection.cursor_instance.statements
        self.assertIn("LOCK TABLE app_accounts", statements[0][0])
        self.assertEqual(statements[1][0], "DELETE FROM app_accounts")
        query, values = connection.cursor_instance.executemany_calls[0]
        self.assertIn("%s::jsonb", query)
        self.assertEqual([value[0] for value in values], ["s2", "s1"])
        self.assertEqual([value[2] for value in values], [0, 1])
        self.assertTrue(connection.committed)

    def test_replace_accounts_rejects_duplicate_and_accidental_empty_set(self):
        with self.assertRaisesRegex(ValueError, "allow_empty"):
            self.store.replace_accounts([], "admin")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.store.replace_accounts(
                [
                    {"studentId": "CaseSensitive"},
                    {"studentId": "casesensitive"},
                ],
                "admin",
            )

    def test_load_and_bootstrap_accounts_use_server_side_table(self):
        load_connection = FakeConnection(
            [{"all": [({"studentId": "s1"},), ({"studentId": "s2"},)]}]
        )
        with self.patch_connection(load_connection):
            self.assertEqual(
                self.store.load_accounts(),
                [{"studentId": "s1"}, {"studentId": "s2"}],
            )

        existing_connection = FakeConnection(
            [
                {},
                {"one": (True,)},
            ]
        )
        with self.patch_connection(existing_connection):
            self.assertFalse(
                self.store.bootstrap_account(
                    {"studentId": "admin"},
                    actor="bootstrap",
                )
            )
        self.assertEqual(len(existing_connection.cursor_instance.statements), 2)

        empty_connection = FakeConnection(
            [
                {},
                {"one": (False,)},
                {},
            ]
        )
        with self.patch_connection(empty_connection):
            self.assertTrue(
                self.store.bootstrap_account(
                    {"studentId": "admin"},
                    actor="bootstrap",
                )
            )
        insert_query, insert_params = empty_connection.cursor_instance.statements[2]
        self.assertIn("INSERT INTO app_accounts", insert_query)
        self.assertEqual(insert_params[0], "admin")
        self.assertTrue(empty_connection.committed)

    def test_record_create_update_delete_and_audit_return_stable_shapes(self):
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        created_row = (
            12,
            "paper",
            {"title": "T"},
            1,
            now,
            now,
            "leader",
            "leader",
        )
        create_connection = FakeConnection([{"one": created_row}])
        with self.patch_connection(create_connection):
            created = self.store.create_record(
                "paper",
                {"title": "T"},
                "leader",
            )
        self.assertEqual(created["id"], 12)
        self.assertEqual(created["recordType"], "paper")

        updated_row = (
            12,
            "paper",
            {"title": "T", "status": "published"},
            2,
            now,
            now,
            "leader",
            "admin",
        )
        update_connection = FakeConnection([{"all": [updated_row]}])
        with self.patch_connection(update_connection):
            updated = self.store.update_records(
                "paper",
                {"status": "published"},
                actor="admin",
                record_ids=[12],
            )
        self.assertEqual(updated[0]["version"], 2)
        update_query, update_params = update_connection.cursor_instance.statements[0]
        self.assertIn("payload || %s::jsonb", update_query)
        self.assertEqual(update_params[-1], [12])

        delete_connection = FakeConnection([{"all": [(12,), (13,)]}])
        with self.patch_connection(delete_connection):
            deleted = self.store.delete_records(
                "paper",
                actor="admin",
                record_ids=[12, 13],
            )
        self.assertEqual(deleted, 2)

        audit_row = (
            4,
            "records_deleted",
            "admin",
            "paper",
            "12,13",
            {"count": 2},
            now,
        )
        audit_connection = FakeConnection([{"one": audit_row}])
        with self.patch_connection(audit_connection):
            audit = self.store.append_audit(
                "records_deleted",
                "admin",
                subject_type="paper",
                subject_id="12,13",
                details={"count": 2},
            )
        self.assertEqual(audit["id"], 4)
        self.assertEqual(audit["details"], {"count": 2})
        audit_query, audit_params = audit_connection.cursor_instance.statements[0]
        self.assertIn("INSERT INTO audit_events", audit_query)
        self.assertEqual(json.loads(audit_params[-1]), {"count": 2})

    def test_non_finite_json_is_rejected_before_opening_database(self):
        with mock.patch.object(
            self.store,
            "_connection",
            side_effect=AssertionError("database should not be opened"),
        ):
            with self.assertRaisesRegex(ValueError, "finite JSON"):
                self.store.put_sync_value(
                    "systemConfigData",
                    {"ratio": float("nan")},
                    0,
                    "admin",
                )

    def test_initial_migration_contains_every_required_table(self):
        migration = (
            REPO_DIR / "deploy" / "db" / "migrations" / "001_initial.sql"
        ).read_text(encoding="utf-8")
        for table in (
            "app_sync",
            "app_accounts",
            "app_records",
            "audit_events",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", migration)
        self.assertIn("profile       jsonb NOT NULL", migration)
        self.assertIn("payload       jsonb NOT NULL", migration)
        migrator = (REPO_DIR / "deploy" / "db" / "migrate.py").read_text(encoding="utf-8")
        self.assertIn("CREATE TABLE IF NOT EXISTS public.schema_migrations", migrator)
        self.assertIn("filename", migrator)
        self.assertIn("sha256", migrator)


if __name__ == "__main__":
    unittest.main()
