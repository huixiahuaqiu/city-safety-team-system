import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "deploy" / "db" / "migrate.py"
SPEC = importlib.util.spec_from_file_location("citysafe_db_migrate", MODULE_PATH)
MIGRATE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MIGRATE
SPEC.loader.exec_module(MIGRATE)


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.row = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def execute(self, sql, params=None):
        normalized = " ".join(str(sql).split())
        if normalized == "SELECT 1":
            self.row = (1,)
        elif "CREATE TABLE IF NOT EXISTS public.schema_migrations" in normalized:
            self.row = None
        elif "pg_advisory_xact_lock" in normalized:
            self.row = (None,)
        elif normalized.startswith(
            "SELECT sha256 FROM public.schema_migrations"
        ):
            digest = self.connection.applied.get(params[0])
            self.row = (digest,) if digest is not None else None
        elif normalized.startswith(
            "INSERT INTO public.schema_migrations"
        ):
            self.connection.applied[params[0]] = params[1]
            self.row = None
        else:
            if "BROKEN" in normalized:
                raise RuntimeError("simulated SQL failure")
            self.connection.business_sql.append(str(sql).strip())
            self.row = None

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self):
        self.applied = {}
        self.business_sql = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class MigrationTests(unittest.TestCase):
    def test_connection_url_takes_precedence_and_pg_values_are_supported(self):
        target = MIGRATE.connection_target(
            {
                "DATABASE_URL": "postgresql://example.invalid/db",
                "PGHOST": "ignored",
            }
        )
        self.assertEqual(target.dsn, "postgresql://example.invalid/db")
        self.assertEqual(target.kwargs, {})

        target = MIGRATE.connection_target(
            {
                "PGHOST": "db",
                "PGPORT": "5433",
                "PGDATABASE": "citysafe",
                "PGUSER": "app",
                "PGPASSWORD": "secret",
            }
        )
        self.assertEqual(
            target.kwargs,
            {
                "host": "db",
                "port": 5433,
                "dbname": "citysafe",
                "user": "app",
                "password": "secret",
            },
        )

    def test_migrations_are_sorted_and_repeated_run_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            (directory / "010_second.sql").write_text(
                "CREATE TABLE second_table(id int);", encoding="utf-8"
            )
            (directory / "001_first.sql").write_text(
                "CREATE TABLE first_table(id int);", encoding="utf-8"
            )
            (directory / "README.txt").write_text("ignored", encoding="utf-8")

            migrations = MIGRATE.discover_migrations(directory)
            self.assertEqual(
                [item.filename for item in migrations],
                ["001_first.sql", "010_second.sql"],
            )

            connection = FakeConnection()
            applied, skipped = MIGRATE.apply_migrations(
                connection, migrations, log=lambda _message: None
            )
            self.assertEqual((applied, skipped), (2, 0))
            first_business_sql = list(connection.business_sql)

            applied, skipped = MIGRATE.apply_migrations(
                connection, migrations, log=lambda _message: None
            )
            self.assertEqual((applied, skipped), (0, 2))
            self.assertEqual(connection.business_sql, first_business_sql)

    def test_repository_initial_migration_uses_migrator_tracking(self):
        migrations = MIGRATE.discover_migrations(
            ROOT / "deploy" / "db" / "migrations"
        )
        self.assertEqual(
            [item.filename for item in migrations],
            ["001_initial.sql"],
        )
        initial = migrations[0]
        self.assertIn("CREATE TABLE IF NOT EXISTS app_sync", initial.sql)
        self.assertNotIn("CREATE TABLE IF NOT EXISTS schema_migrations", initial.sql)
        self.assertNotIn("\nBEGIN;", "\n" + initial.sql.upper())
        self.assertNotIn("\nCOMMIT;", "\n" + initial.sql.upper())

        connection = FakeConnection()
        self.assertEqual(
            MIGRATE.apply_migrations(
                connection, migrations, log=lambda _message: None
            ),
            (1, 0),
        )
        self.assertEqual(
            MIGRATE.apply_migrations(
                connection, migrations, log=lambda _message: None
            ),
            (0, 1),
        )

    def test_changed_applied_migration_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "001_initial.sql"
            path.write_text("SELECT 42;", encoding="utf-8")
            migration = MIGRATE.discover_migrations(Path(temp_dir))[0]
            connection = FakeConnection()
            connection.applied[migration.filename] = "0" * 64

            with self.assertRaises(MIGRATE.MigrationDriftError):
                MIGRATE.apply_migrations(
                    connection, [migration], log=lambda _message: None
                )
            self.assertGreaterEqual(connection.rollbacks, 1)
            self.assertEqual(connection.business_sql, [])

    def test_database_wait_retries_before_returning_connection(self):
        connection = FakeConnection()
        attempts = []

        def connect(*_args, **_kwargs):
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError("not ready")
            return connection

        result = MIGRATE.wait_for_database(
            connect,
            MIGRATE.ConnectionTarget(kwargs={"host": "db"}),
            wait_seconds=1,
            poll_interval=0,
            sleep=lambda _seconds: None,
            log=lambda _message: None,
        )
        self.assertIs(result, connection)
        self.assertEqual(len(attempts), 2)

    def test_failed_migration_rolls_back_and_is_not_recorded(self):
        migration = MIGRATE.Migration(
            filename="001_broken.sql",
            path=Path("001_broken.sql"),
            sha256="a" * 64,
            sql="BROKEN",
        )
        connection = FakeConnection()
        with self.assertRaises(MIGRATE.MigrationError):
            MIGRATE.apply_migrations(
                connection, [migration], log=lambda _message: None
            )
        self.assertNotIn(migration.filename, connection.applied)
        self.assertGreaterEqual(connection.rollbacks, 1)


if __name__ == "__main__":
    unittest.main()
