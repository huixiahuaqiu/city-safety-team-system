# 城市安全团队系统 · 生产部署底座（deploy/）

企业级内网部署的可落盘配置与脚本。**不改变本地开发默认行为**：`BIND_HOST`/`CORS` 仅在生产 `.env` 收紧。

## 选型（已定）

| 项 | 结论 |
|----|------|
| 结构化数据 | Supabase **内网自建**（见 `supabase/`） |
| 大文件 | MinIO + **预签名直传**；现有分片 `/api/dataset/*` 保留 |
| 对外入口 | 仅 Nginx 80/443；网关/MinIO/DB 绑 `127.0.0.1` |

## 目录

```
deploy/
├── nginx/           # 全量站点、安全头、CSP Report-Only、限流、MinIO 反代
├── systemd/         # citysafe-gateway + minio
├── fail2ban/        # sshd + nginx 4xx + 网关鉴权失败
├── logrotate/       # 应用日志 + Nginx 180 天
├── scripts/         # install / release / rollback / backup / health / disk
├── minio/           # 策略、初始化脚本、env 模板
├── supabase/        # 内网 Postgres compose + RLS SQL
├── sysctl/          # 内核调优
├── cron/            # 健康/磁盘/备份定时
├── .env.production.example
└── RUNBOOK.md       # 运维速查
```

## 快速安装（服务器）

```bash
# 1) 系统依赖
sudo apt update && sudo apt install -y nginx python3 python3-venv python3-pip \
  fail2ban logrotate rsync curl ufw

# 2) 一键落配置
sudo bash deploy/scripts/install-base.sh

# 3) 填密钥
sudo nano /opt/citysafe/.env
sudo nano /etc/default/minio
sudo nano /etc/nginx/sites-available/citysafe.conf   # YOUR_DOMAIN

# 4) MinIO 二进制（若尚未安装）
wget https://dl.min.io/server/minio/release/linux-amd64/minio -O /usr/local/bin/minio
chmod +x /usr/local/bin/minio

# 5) Python venv + 依赖
sudo -u appsvc python3 -m venv /opt/citysafe/venv
sudo -u appsvc /opt/citysafe/venv/bin/pip install minio

# 6) 首次发布
sudo -u appsvc SRC="$(pwd)/123123" bash /opt/citysafe/bin/release.sh

# 7) 启服务
sudo systemctl enable --now minio citysafe-gateway nginx fail2ban
bash deploy/minio/init-bucket.sh   # 需先 export 根账号与业务密钥

# 8) 冒烟
curl -s http://127.0.0.1:8000/api/health
```

## 发布 / 回滚

```bash
sudo -u appsvc SRC=/path/to/123123 bash /opt/citysafe/bin/release.sh
bash /opt/citysafe/bin/rollback.sh                 # 上一版
bash /opt/citysafe/bin/rollback.sh 2026-07-14_013000
```

## 本机 Docker 预演 MinIO（Windows）

数据目录：`D:\Docker\data\minio`。密钥模板：`deploy/minio/.env.local.example`（复制为 `.env.local`，已 gitignore）。

```powershell
docker compose -f deploy/minio/docker-compose.yml --env-file deploy/minio/.env.local up -d
# 初始化桶/业务账号后写入 123123/.env：
#   SHARED_STORAGE_BACKEND=minio
#   MINIO_ENDPOINT=127.0.0.1:9000
#   MINIO_ACCESS_KEY / MINIO_SECRET_KEY = APP_*
python 123123/start_web.py
curl http://127.0.0.1:8000/api/health   # 期望 minioReady/presignEnabled=true
```

控制台：http://127.0.0.1:9001 ；API：http://127.0.0.1:9000。浏览器直传 ≥8MB 共享文件会走预签名 PUT。

## 与现有功能的关系

- 本地 `python start_web.py`：默认仍监听 `0.0.0.0:8000`，CORS `*`，行为不变。
- 生产 `.env`：`BIND_HOST=127.0.0.1`、`CORS_ALLOW_ORIGIN=https://域名`。
- 新增 `/api/health`、`/api/shared-file/presign`、`/api/shared-file/confirm`：**纯增量**；旧上传/分片路径未改。
- 前端未强制切换预签名；启用 MinIO 后可按需对接，不影响现网 multipart。

## 优先级对照

1. **P1 已交付**：Nginx / CSP / fail2ban / 软链回滚 / 日志轮转 / 备份·健康·Runbook  
2. **P2 已交付**：网关预签名 + confirm + Nginx `/minio-upload/`  
3. **P3 脚手架**：`supabase/docker-compose.yml` + `sql/rls_app_sync.sql`（迁移按窗口执行）

详见 [RUNBOOK.md](./RUNBOOK.md) 与仓库根目录 `部署方案.md`。
