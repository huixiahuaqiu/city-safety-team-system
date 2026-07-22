#!/usr/bin/env bash
# 一键安装底座到本机（需 root）。不会改业务代码，仅落配置与目录。
# 用法：sudo bash deploy/scripts/install-base.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="${REPO_ROOT}/deploy"

echo "[install] repo=${REPO_ROOT}"

id appsvc >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /opt/citysafe appsvc
id minio-user >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /data/minio minio-user

mkdir -p /opt/citysafe/{releases,venv} /data/{minio,uploads,backups,logs} /data/uploads/{shared,datasets,annotations}
chown -R appsvc:appsvc /opt/citysafe /data/uploads /data/backups /data/logs
chown -R minio-user:minio-user /data/minio

# 审计日志防篡改（等保 2.0 / 网络安全法）：核心审计文件设为 append-only，
# 服务被入侵也无法删除或改写历史；logrotate 轮转时会临时摘除该属性（见 logrotate/citysafe）。
touch /data/logs/server_audit.log
chown appsvc:appsvc /data/logs/server_audit.log
chmod 640 /data/logs/server_audit.log
if command -v chattr >/dev/null 2>&1; then
  chattr +a /data/logs/server_audit.log 2>/dev/null \
    && echo "[install] /data/logs/server_audit.log 已设为 append-only（chattr +a）" \
    || echo "[install] WARN: chattr +a 失败（文件系统可能不支持），请人工确认审计日志防篡改策略"
else
  echo "[install] WARN: 未找到 chattr，跳过审计日志 append-only 设置"
fi

# Nginx
mkdir -p /etc/nginx/snippets /etc/nginx/conf.d
cp -a "${DEPLOY}/nginx/snippets/citysafe-common.conf" /etc/nginx/snippets/
cp -a "${DEPLOY}/nginx/conf.d/citysafe-zones.conf" /etc/nginx/conf.d/
cp -a "${DEPLOY}/nginx/citysafe.conf" /etc/nginx/sites-available/citysafe.conf
# 若主 conf 内仍含 limit_req_zone，与 conf.d 重复时删主 conf 顶部 zone 行
if [[ -d /etc/nginx/sites-enabled ]]; then
  ln -sfn /etc/nginx/sites-available/citysafe.conf /etc/nginx/sites-enabled/citysafe.conf
fi

# systemd
cp -a "${DEPLOY}/systemd/citysafe-gateway.service" /etc/systemd/system/
cp -a "${DEPLOY}/systemd/minio.service" /etc/systemd/system/
if [[ ! -f /etc/default/minio ]]; then
  cp -a "${DEPLOY}/minio/env.minio.example" /etc/default/minio
  chmod 600 /etc/default/minio
  echo "[install] 请编辑 /etc/default/minio 填写强口令"
fi

# fail2ban / logrotate / sysctl
mkdir -p /etc/fail2ban/filter.d /etc/fail2ban/jail.d
cp -a "${DEPLOY}/fail2ban/filter.d/"*.conf /etc/fail2ban/filter.d/ 2>/dev/null || true
cp -a "${DEPLOY}/fail2ban/jail.d/citysafe.conf" /etc/fail2ban/jail.d/
cp -a "${DEPLOY}/logrotate/citysafe" /etc/logrotate.d/citysafe
cp -a "${DEPLOY}/sysctl/99-citysafe.conf" /etc/sysctl.d/
sysctl --system >/dev/null 2>&1 || true

# 脚本
mkdir -p /opt/citysafe/bin
cp -a "${DEPLOY}/scripts/"*.sh /opt/citysafe/bin/
chmod 750 /opt/citysafe/bin/*.sh
chown -R appsvc:appsvc /opt/citysafe/bin

# 生产 env 模板
if [[ ! -f /opt/citysafe/.env ]]; then
  cp -a "${DEPLOY}/.env.production.example" /opt/citysafe/.env
  chown appsvc:appsvc /opt/citysafe/.env
  chmod 600 /opt/citysafe/.env
  echo "[install] 请编辑 /opt/citysafe/.env 填写真实密钥"
fi

# cron
if [[ -d /etc/cron.d ]]; then
  cp -a "${DEPLOY}/cron/citysafe.cron" /etc/cron.d/citysafe
  chmod 644 /etc/cron.d/citysafe
fi

systemctl daemon-reload
echo "[install] 底座文件已就位。下一步："
echo "  1) 编辑 /etc/nginx/sites-available/citysafe.conf 中 YOUR_DOMAIN"
echo "  2) 编辑 /opt/citysafe/.env 与 /etc/default/minio"
echo "  3) 从仓库执行: sudo -u appsvc SRC=${REPO_ROOT}/123123 bash /opt/citysafe/bin/release.sh"
echo "  4) sudo systemctl enable --now minio citysafe-gateway nginx fail2ban"
echo "  5) curl -s http://127.0.0.1:8000/api/health"
