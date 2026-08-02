# 城市安全团队系统 · 统一部署

`deploy/` 是本机演示和公司服务器共用的部署入口。两端运行完全相同的应用镜像、数据库迁移和服务拓扑，区别只来自环境文件与 Compose 覆盖文件。

## 目录

```text
deploy/
├── compose.yaml                 # 共用基础架构
├── compose.local.yaml           # Windows 本机：仅 127.0.0.1:8080
├── compose.server.yaml          # Linux 服务器：Nginx 80/443
├── db/
│   ├── migrate.py               # 带哈希漂移检测的迁移器
│   └── migrations/              # 按文件名顺序执行的 SQL
├── env/
│   ├── local.example            # 本机模板
│   └── server.example           # 服务器模板
├── nginx/container/             # 容器入口、TLS、限流和安全代理
└── scripts/
    ├── stack.ps1                # 本机一键启动/停止/检查
    ├── bootstrap-server.sh      # 服务器首次部署与后续更新
    ├── deploy-server.ps1        # Windows 一键触发服务器安全更新
    ├── smoke.py                 # 就绪与登录冒烟测试
    ├── backup.sh                # 全栈备份
    └── restore-verify.sh        # 隔离恢复验证
```

## 架构与端口

```text
Browser
   │
   ▼
edge / Nginx
   │
   ├── /api/* ──► gateway ──► PostgreSQL
   │                         └► MinIO
   └── 静态页面
```

| 服务 | 本机宿主端口 | 服务器宿主端口 |
|---|---:|---:|
| Nginx | `127.0.0.1:8080` | `80/443` |
| Gateway | 无 | 无 |
| PostgreSQL | 无 | 无 |
| MinIO API / Console | 默认无 | 无 |

MinIO 控制台仅在本机显式启用 `console` profile 后绑定 `127.0.0.1:9001`。

## Windows 本机

```powershell
# 首次和后续启动
.\deploy\scripts\stack.ps1 -Action up

# 状态 / 日志 / 冒烟
.\deploy\scripts\stack.ps1 -Action status
.\deploy\scripts\stack.ps1 -Action logs
.\deploy\scripts\stack.ps1 -Action smoke

# 停止但保留全部数据
.\deploy\scripts\stack.ps1 -Action down
```

首次运行自动创建 `deploy/env/.env.local` 和随机管理员临时密码。该文件已被 Git 忽略。访问 <http://127.0.0.1:8080>，首次登录后立即改密。

启用本机 MinIO 控制台：

```powershell
.\deploy\scripts\stack.ps1 -Action up -WithMinioConsole
```

## Linux 公司服务器

首次部署或后续更新使用同一命令：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain citysafe.example.com \
  --issue-cert \
  --email admin@example.com
```

已有公司证书时，证书需位于：

```text
/etc/letsencrypt/live/<域名>/fullchain.pem
/etc/letsencrypt/live/<域名>/privkey.pem
```

然后去掉 `--issue-cert --email`。服务器密钥保存在 `/etc/citysafe/server.env`；脚本重复运行不会轮换现有密钥、清空数据库或删除对象。

### 无域名：IP + 自签 HTTPS

暂时没有公网域名时，可用服务器公网 IP 部署自签证书（浏览器会提示证书不受信任，团队内点「继续访问」即可）：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain 203.0.113.10 \
  --self-signed
```

后续更新请继续带上 `--self-signed`，以便健康检查跳过自签证书校验。有正式域名后，再改为 `--issue-cert` 或挂载公司证书。

服务器已有仓库并配置好 SSH/sudo 后，也可以从 Windows 本机触发后续更新：

```powershell
.\deploy\scripts\deploy-server.ps1 `
  -Server deployer@server.example.com `
  -Domain citysafe.example.com `
  -RemotePath /opt/city-safety-team-system `
  -Ref refs/tags/v1.0.0
```

IP 自签场景：

```powershell
.\deploy\scripts\deploy-server.ps1 `
  -Server root@203.0.113.10 `
  -Domain 203.0.113.10 `
  -RemotePath /opt/city-safety-team-system `
  -Ref main `
  -SelfSigned
```

该入口只接受安全格式的服务器、路径和 Git 引用；服务器工作区不干净或分支不能
fast-forward 时会中止。使用 `-WhatIf` 可先预演。

## 运行时配置

浏览器只接收以下公开配置：

- `APP_ENV`
- `SHOW_DEMO_ACCOUNTS`
- `GATEWAY_AUTH_ENABLED`
- `DATA_BACKEND=gateway`
- 同源 `API_PROXY`

Nginx 启动时生成 `config.runtime.js`。数据库密码、MinIO 密钥、上传令牌、MLOps 令牌和 AI 密钥永远不会写入该文件。

服务端主要配置：

- `PG*`：PostgreSQL 连接；
- `AUTH_SIGNING_SECRET`：会话签名；
- `BOOTSTRAP_ADMIN_*`：仅空账号库时创建首个管理员；
- `MINIO_*`：内部对象存储；
- `MLOPS_TOKEN`、`ANNOTATION_UPLOAD_TOKEN`、`DATASET_UPLOAD_TOKEN`：非交互客户端令牌；
- `CORS_ALLOW_ORIGINS`：确需跨域时的精确白名单。

## 数据迁移

迁移器会：

1. 等待 PostgreSQL 就绪；
2. 按文件名字典序读取 `db/migrations/*.sql`；
3. 对每个文件记录 SHA-256；
4. 相同文件重复部署时跳过；
5. 已执行文件发生修改时立即失败；
6. 使用 PostgreSQL advisory lock 防止两个部署同时迁移。

已上线的迁移文件不得修改；结构变化必须新增下一个编号文件。

## 本机数据与生产数据

部署代码和迁移数据是两件独立的事：

- 重复部署代码会保留目标机器上的持久卷；
- 本机演示数据不会自动复制到服务器；
- 如需带数据上线，先生成全栈备份，再在隔离环境执行恢复验证，最后安排明确迁移窗口；
- 禁止直接复制本机 `.env.local` 到服务器。

更多排障、备份和恢复命令见 [RUNBOOK.md](RUNBOOK.md)。
