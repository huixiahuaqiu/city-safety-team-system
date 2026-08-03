from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def service_section(compose_text: str, service: str, next_service: str) -> str:
    start = f"\n  {service}:\n"
    end = f"\n  {next_service}:\n"
    return compose_text.split(start, 1)[1].split(end, 1)[0]


class DeployArchitectureTests(unittest.TestCase):
    def test_gateway_never_receives_minio_root_credentials(self):
        compose = read("deploy/compose.yaml")
        minio = service_section(compose, "minio", "minio-init")
        gateway = service_section(compose, "gateway", "edge")

        self.assertIn("MINIO_ROOT_USER:", minio)
        self.assertIn("MINIO_ROOT_PASSWORD:", minio)
        self.assertNotIn("MINIO_ROOT_USER:", gateway)
        self.assertNotIn("MINIO_ROOT_PASSWORD:", gateway)
        self.assertIn("MINIO_ACCESS_KEY:", gateway)
        self.assertIn("MINIO_SECRET_KEY:", gateway)

    def test_minio_initializer_uses_a_bucket_scoped_application_policy(self):
        compose = read("deploy/compose.yaml")
        initializer = service_section(compose, "minio-init", "gateway")

        self.assertIn("citysafe-app-policy.json", initializer)
        self.assertIn("arn:aws:s3:::", initializer)
        self.assertIn("mc admin user add", initializer)
        self.assertIn("mc admin policy attach", initializer)
        self.assertIn("root and application users must be different", initializer)

    def test_host_port_boundaries_are_explicit(self):
        local = read("deploy/compose.local.yaml")
        server = read("deploy/compose.server.yaml")

        self.assertIn("127.0.0.1:${CITYSAFE_HTTP_PORT:-8080}:8080", local)
        self.assertNotIn("5432:", local)
        self.assertNotIn("8000:", local)
        self.assertNotIn("9000:", local)
        self.assertIn("${CITYSAFE_HTTP_BIND:-0.0.0.0}:80:8080", server)
        self.assertIn("${CITYSAFE_HTTPS_BIND:-0.0.0.0}:443:8443", server)
        self.assertNotIn("5432:", server)
        self.assertNotIn("8000:", server)
        self.assertNotIn("9000:", server)

    def test_rollout_and_backup_share_a_maintenance_lock(self):
        bootstrap = read("deploy/scripts/bootstrap-server.sh")
        backup = read("deploy/scripts/backup.sh")
        restore = read("deploy/scripts/restore-verify.sh")
        remote_deploy = read("deploy/scripts/deploy-server.ps1")
        lock_dir = "/run/lock/citysafe"
        lock_path = "${MAINTENANCE_LOCK_DIR}/maintenance.lock"

        self.assertIn(lock_dir, bootstrap)
        self.assertIn(lock_dir, backup)
        self.assertIn(lock_dir, restore)
        self.assertIn(lock_dir, remote_deploy)
        self.assertIn(lock_path, bootstrap)
        self.assertIn(lock_path, backup)
        self.assertIn(lock_path, restore)
        self.assertIn("flock -n", bootstrap)
        self.assertIn("flock -n", backup)
        self.assertIn("flock -n", restore)
        self.assertIn("flock -s -n 9", restore)
        self.assertIn("${BACKUP_ROOT}/.backup.lock", restore)
        self.assertIn("flock -n 9", remote_deploy)
        self.assertIn("maintenance lock file may not be a symlink", bootstrap)
        self.assertIn("maintenance lock file may not be a symlink", backup)
        self.assertIn("maintenance lock file may not be a symlink", restore)
        self.assertIn("maintenance lock file may not be a symlink", remote_deploy)
        self.assertIn("CITYSAFE_MAINTENANCE_LOCK_HELD=1", remote_deploy)
        self.assertLess(
            remote_deploy.index("flock -n 9"),
            remote_deploy.index("git checkout --quiet"),
        )

    def test_edge_is_recreated_and_redirect_does_not_trust_host_header(self):
        stack = read("deploy/scripts/stack.ps1")
        bootstrap = read("deploy/scripts/bootstrap-server.sh")
        nginx = read("deploy/nginx/container/server.conf.template")

        edge_refresh = "'--no-deps', '--force-recreate', '--wait', 'edge'"
        self.assertIn(edge_refresh, stack)
        self.assertIn("--no-deps --force-recreate --wait edge", bootstrap)
        self.assertIn("https://${SERVER_NAME}$request_uri", nginx)
        self.assertNotIn("https://$host$request_uri", nginx)

    def test_location_cache_rules_do_not_shadow_security_headers(self):
        locations = read("deploy/nginx/container/citysafe-locations.conf")
        # Nginx stops inheriting every server-level add_header as soon as a
        # location declares one. Cache directives must therefore use expires
        # (or upstream headers) so CSP/HSTS/frame protection reaches clients.
        self.assertNotIn("add_header", locations)
        self.assertIn("expires epoch", locations)

    def test_environment_templates_separate_root_and_application_secrets(self):
        for relative_path in (
            "deploy/env/local.example",
            "deploy/env/server.example",
        ):
            with self.subTest(path=relative_path):
                template = read(relative_path)
                self.assertIn("MINIO_ROOT_USER=", template)
                self.assertIn("MINIO_ROOT_PASSWORD=", template)
                self.assertIn("MINIO_ACCESS_KEY=", template)
                self.assertIn("MINIO_SECRET_KEY=", template)

    def test_restore_verification_upgrades_and_initializes_before_gateway(self):
        restore = read("deploy/scripts/restore-verify.sh")

        migrate = restore.index("run_isolated_oneshot migrate")
        minio_init = restore.index("run_isolated_oneshot minio-init")
        gateway = restore.index('"${COMPOSE[@]}" create --no-build --no-deps gateway')
        self.assertLess(migrate, minio_init)
        self.assertLess(minio_init, gateway)
        self.assertIn("safe_tar_list", restore)
        self.assertNotIn('restore_dir="${WORK}/restored/', restore)
        self.assertNotIn('-C "${restore_dir}" -xzf', restore)
        self.assertIn("restore_volume_archive state", restore)
        self.assertIn("restore_volume_archive minio", restore)
        self.assertIn(
            "next(iter(client.list_objects(bucket, recursive=True)), None)",
            restore,
        )
        self.assertNotIn(
            "list(client.list_objects(bucket, recursive=True))",
            restore,
        )
        self.assertIn("/run/lock/citysafe", restore)
        self.assertIn("flock -n 8", restore)
        self.assertIn('[[ "${EUID}" -eq 0 ]]', restore)
        self.assertIn("maintenance lock file may not be a symlink", restore)

    def test_runbook_explains_minio_credential_revocation(self):
        runbook = read("deploy/RUNBOOK.md")

        self.assertIn("常规轮换保持 `MINIO_ACCESS_KEY` 不变", runbook)
        self.assertIn("显式删除旧应用用户", runbook)

    def test_scheduled_backup_uses_the_root_maintenance_identity(self):
        cron = read("deploy/cron/citysafe.cron")

        self.assertIn(" root cd ", cron)
        self.assertIn("deploy/scripts/backup.sh", cron)
        self.assertIn("deploy/scripts/restore-verify.sh", cron)
        self.assertNotIn(" appsvc ", cron)


if __name__ == "__main__":
    unittest.main()
