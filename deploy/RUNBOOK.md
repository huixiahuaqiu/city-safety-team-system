# 城市安全团队系统运维手册

本手册只适用于当前统一的 Docker Compose 部署：

```text
浏览器 → Nginx（唯一入口）→ Python 网关 → PostgreSQL
                                      └→ MinIO
```

本机和服务器共用 `deploy/compose.yaml`，分别叠加
`deploy/compose.local.yaml` 和 `deploy/compose.server.yaml`。不要再使用旧的
systemd、独立 Nginx 或直接启动 Python 的运维命令。

## 1. 运维底线

- 服务器防火墙只放行管理所需的 SSH，以及业务入口 `80/443`。
- PostgreSQL `5432`、网关 `8000`、MinIO `9000/9001` 不得发布到服务器宿主机或公网。
- 不提交或复制 `deploy/env/.env.local`、`/etc/citysafe/server.env`、证书私钥和备份加密密钥。
- 停止栈时不得添加 `--volumes` 或 `-v`；它们会删除业务数据卷。
- 已经执行过的 `deploy/db/migrations/*.sql` 不得修改，变更结构时只能新增迁移文件。
- 发布代码与迁移数据是两件事。本机数据不会因部署代码而自动进入服务器。
- 任何生产更新、密钥轮换或恢复操作前，先生成备份并完成隔离恢复验证。

### 1.1 二进制真源与迁移

- 共享文件、数据集、标注三类真实二进制均以 **MinIO 为真源**
  （`SHARED_STORAGE_BACKEND` / `DATASET_STORAGE_BACKEND` / `ANNOTATION_STORAGE_BACKEND` = `minio`）：
  - 共享文件：预签名直传或网关代传后写入 `shared/` 前缀；
  - 数据集：分片先落网关磁盘临时目录，合并校验通过后上传 `datasets/` 并自动清理本地副本；
  - 标注：双写（本地热缓存 + MinIO），异机导出时自动从 `annotations/` 前缀补齐。
- 因此 `uploads/` 目录只剩分片缓存与标注热缓存；**服务器迁移只需搬 MinIO 数据卷 + PostgreSQL**。
- 存量本地文件迁入 MinIO（幂等，先 dry-run）：

  ```bash
  cd 123123
  python scripts/migrate_binaries_to_minio.py --dry-run
  python scripts/migrate_binaries_to_minio.py            # 上传并回写注册表
  python scripts/migrate_binaries_to_minio.py --purge-local  # 确认后清理本地副本
  ```

## 2. Windows 本机运维

在仓库根目录打开 PowerShell。首次启动和日常更新都使用：

```powershell
.\deploy\scripts\stack.ps1 -Action up
```

首次运行会生成已被 Git 忽略的 `deploy/env/.env.local`，写入随机密钥和管理员临时密码。
访问地址为 <http://127.0.0.1:8080>。临时密码只在首次创建时显示，登录后应立即修改。

常用命令：

```powershell
# 查看容器状态
.\deploy\scripts\stack.ps1 -Action status

# 持续查看最近 200 行日志；Ctrl+C 只退出日志查看，不会停止服务
.\deploy\scripts\stack.ps1 -Action logs

# 检查 Compose 配置
.\deploy\scripts\stack.ps1 -Action config

# 检查 /api/health
.\deploy\scripts\stack.ps1 -Action smoke

# 只重启网关和 Nginx
.\deploy\scripts\stack.ps1 -Action restart

# 停止服务但保留所有数据卷
.\deploy\scripts\stack.ps1 -Action down
```

`restart` 不会重新构建镜像，也不会把环境文件的新值装入已有容器。修改代码、镜像或
`deploy/env/.env.local` 后，应再次执行 `-Action up`。

本机需要临时查看 MinIO 控制台时：

```powershell
.\deploy\scripts\stack.ps1 -Action up -WithMinioConsole
```

控制台仅绑定 `127.0.0.1:9001`。公司服务器不得叠加本地 Compose 文件，也不得启用该
`console` profile。

使用其他本地环境文件时，所有命令都可以增加：

```powershell
-EnvFile D:\安全目录\citysafe.local.env
```

## 3. Linux 服务器部署与更新

### 3.1 从 Windows 一键触发服务器部署

服务器上已有仓库、已配置 `origin`，并完成 SSH 和 sudo 权限准备后，可以直接从本机
PowerShell 触发更新：

```powershell
.\deploy\scripts\deploy-server.ps1 `
  -Server deployer@server.example.com `
  -Domain citysafe.example.com `
  -RemotePath /opt/city-safety-team-system `
  -Ref refs/tags/v1.0.0
```

建议生产使用经过验证的标签或完整提交哈希。分支更新只允许 fast-forward；标签和提交会
以 detached HEAD 检出。远端仓库只要存在未提交或未跟踪文件，脚本就会在更新前中止，
不会覆盖服务器上的修改。

首次申请证书时增加：

```powershell
-IssueCert -Email admin@example.com
```

自定义服务器环境文件、证书目录或仅检查配置时，可分别增加：

```powershell
-EnvFile /etc/citysafe/server.env
-TlsRoot /etc/letsencrypt
-PrepareOnly
```

正式执行前可先追加 `-WhatIf` 预演。该入口使用本机系统 OpenSSH，远端 sudo 可能要求
交互输入密码；服务器生成的初始管理员密码会在 SSH 输出中自动隐藏，不会回传本机。
因此首次建站应由授权人员在服务器侧安全取得临时密码，或先在服务器直接执行下一节的
引导命令。

### 3.2 在服务器直接首次部署

前置条件：

- Docker Engine 和 Docker Compose 插件可用；
- 域名已经解析到服务器；
- 公司证书位于 `/etc/letsencrypt/live/<域名>/fullchain.pem` 和
  `/etc/letsencrypt/live/<域名>/privkey.pem`，或服务器已安装 Certbot；
- 防火墙仅放行 SSH、80、443。

由脚本申请 Let's Encrypt 证书并启动：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain citysafe.example.com \
  --issue-cert \
  --email admin@example.com
```

已有公司证书时，去掉 `--issue-cert --email`：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain citysafe.example.com
```

无公网域名、先用公网 IP 访问时，使用自签证书（浏览器会告警，团队内可继续访问）：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain 203.0.113.10 \
  --self-signed
```

`--self-signed` 与 `--issue-cert` 互斥；证书写入
`/etc/letsencrypt/live/<IP或主机名>/`，与 Nginx 模板路径一致。后续更新请继续带上
`--self-signed`。

脚本首次运行会创建权限为 `0600` 的 `/etc/citysafe/server.env`，生成随机密钥，构建并
等待所有容器就绪。初始管理员为 `admin`，临时密码只在首次创建环境文件时显示。

只生成并检查配置、不启动服务：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain citysafe.example.com \
  --prepare-only
```

`--prepare-only` 仍会检查域名对应的证书。自定义路径时可使用：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain citysafe.example.com \
  --env-file /安全目录/server.env \
  --tls-root /安全目录/证书
```

### 3.3 后续一键更新

在服务器切换到已经审查、测试过的新版本源码后，重复执行同一条
`bootstrap-server.sh` 命令。脚本会保留现有环境文件、密钥和数据卷，并用当前 Git
提交短哈希作为默认镜像标签；也可通过 `CITYSAFE_IMAGE_TAG` 指定不可变发布标签。
日常也可使用第 3.1 节的本机入口完成远端源码更新和同一次引导部署。

服务器发布、全栈备份和隔离恢复验证共用 root 私有目录
`/run/lock/citysafe/maintenance.lock`。远程发布从切换工作区源码开始持锁，直到容器更新、
边缘入口重建和健康检查结束；锁被占用时命令会安全退出，不会和正在运行的备份交叉执行。
隔离恢复验证还会对 `BACKUP_ROOT/.backup.lock` 取共享锁，避免与备份保留清理交叉删档。

推荐发布顺序：

1. 记录当前源码提交和 `CITYSAFE_IMAGE_TAG`；
2. 执行全栈备份；
3. 对该备份执行隔离恢复验证；
4. 切换到新版本源码；
5. 重复执行 `bootstrap-server.sh`；
6. 检查容器、外部健康接口、登录和关键业务流程；
7. 观察日志后再结束变更窗口。

### 3.4 回滚原则

- 保留每个已验证发布对应的源码提交、镜像标签和备份编号。
- 代码回滚时，必须先切回对应的旧源码，再重新执行 `bootstrap-server.sh`；不要给新源码
  贴旧镜像标签来冒充回滚。
- Compose 更新和普通 `down` 不会删除数据卷。
- 数据库迁移只向前执行，不会自动反向迁移。若新迁移不兼容旧代码，不能只回滚镜像。
- 涉及数据库或对象数据回退时，必须进入维护窗口，使用已验证的全栈备份制定独立恢复
  方案。本仓库的 `restore-verify.sh` 只做隔离验证，不会恢复或覆盖生产数据。

## 4. 服务器状态、日志与健康

以下命令在仓库根目录执行。可先定义当前服务器 Compose 命令：

```bash
COMPOSE=(
  docker compose
  --env-file /etc/citysafe/server.env
  -f deploy/compose.yaml
  -f deploy/compose.server.yaml
)
```

状态与日志：

```bash
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" logs --tail 200
"${COMPOSE[@]}" logs --follow --tail 200 gateway edge db minio migrate
```

`migrate` 显示 `Exited (0)` 是迁移成功后的正常状态。其余长期服务应为运行且健康。

外部健康检查：

```bash
curl -fsS https://citysafe.example.com/healthz
curl -fsS https://citysafe.example.com/api/health
curl -fsS https://citysafe.example.com/api/shared-file/health
curl -fsS https://citysafe.example.com/api/dataset/health
```

`/healthz` 只证明 Nginx 可访问；发布判定应以 `/api/health` 返回成功，且 JSON 中
`ready=true`、`degraded` 不为 `true` 为准。

检查 Compose 配置：

```bash
"${COMPOSE[@]}" config --quiet
```

检查宿主机端口：

```bash
ss -lntp | grep -E ':(80|443|5432|8000|9000|9001)\b'
```

正常情况下，业务相关的宿主机监听只有 `80/443`。`5432/8000/9000/9001` 不应出现。
MinIO 上传由 Nginx 的 `/minio-upload/` 路径转发到内部服务，不需要开放 MinIO 端口。

## 5. 全栈备份

`deploy/scripts/backup.sh` 备份：

- PostgreSQL 事务一致的 custom-format dump；
- MinIO 数据卷；
- 网关状态、上传文件和日志数据卷；
- 清单、内部 SHA-256、外部 SHA-256 和 `.verified` 标记。

环境文件和密钥不会写入备份。脚本会短暂停止网关和 MinIO，以取得协调一致的文件卷
快照，随后自动恢复服务；应在低峰期执行。备份盘应按业务卷体量预留约 2～3 倍单次
归档空间，避免压缩、加密和最终归档并存时耗尽磁盘。

使用默认服务器环境文件和备份目录：

```bash
sudo bash deploy/scripts/backup.sh
```

默认配置：

- 环境文件：`/etc/citysafe/server.env`
- 备份目录：`/srv/citysafe/backups`
- 保留天数：`14`
- 服务停止超时：`60` 秒
- 服务恢复健康超时：`180` 秒

定时执行可使用 `deploy/cron/citysafe.cron`。安装前先把其中
`CITYSAFE_REPO_ROOT` 改成服务器实际仓库路径；该任务必须以 `root` 运行，才能进入
root 私有维护锁目录并安全访问隔离 Docker 卷。

显式配置示例：

```bash
sudo env \
  CITYSAFE_ENV_FILE=/etc/citysafe/server.env \
  BACKUP_ROOT=/srv/citysafe/backups \
  BACKUP_KEEP_DAYS=30 \
  bash deploy/scripts/backup.sh
```

需要加密时，将独立保管、权限受控的密钥文件传给脚本：

```bash
sudo env \
  BACKUP_ENCRYPT_KEY_FILE=/etc/citysafe/backup.key \
  bash deploy/scripts/backup.sh
```

可选参数：

- `BACKUP_OFFSITE_RSYNC`：把已验证的归档、校验文件和标记同步到 rsync 目标；
- `BACKUP_QUIESCE_TIMEOUT_SECONDS`：停止网关和 MinIO 的超时；
- `BACKUP_HEALTH_TIMEOUT_SECONDS`：重新启动后等待健康的超时；
- `CITYSAFE_COMPOSE_FILE`、`CITYSAFE_SERVER_OVERRIDE`：自定义 Compose 文件路径。

成功后会得到一组不可拆分的文件：

```text
citysafe_<UTC时间>_<随机编号>.tar.gz[.enc]
citysafe_<UTC时间>_<随机编号>.tar.gz[.enc].sha256
citysafe_<UTC时间>_<随机编号>.tar.gz[.enc].verified
```

只有三者齐全且校验通过的备份才可用于恢复。加密密钥不得和备份放在同一位置。至少保留
一份受控的异机或离线副本，并监控最近一次成功备份时间。

## 6. 隔离恢复验证

`deploy/scripts/restore-verify.sh` 会：

1. 取得维护锁，并对备份目录 `.backup.lock` 取共享锁；
2. 校验归档、`.sha256` 和 `.verified`；
3. 拒绝异常路径、链接、特殊文件和不符合格式的内容；
4. 流式列举并校验四个文件卷，不在 `/tmp` 重复完整解包大卷；
5. 创建随机命名的隔离 Compose 项目和独立数据卷；
6. 恢复 MinIO 与 PostgreSQL；
7. 在隔离副本上依次运行当前数据库迁移和 MinIO 应用身份初始化；
8. 挂载状态、上传和日志卷，启动无宿主机端口的隔离网关；
9. 检查必要数据表、账号、同步数据，以及 MinIO 对象列举和抽样读取；
10. 输出备份年龄和近似恢复耗时，最后删除隔离容器、卷和临时目录。

它不会把生产容器或生产卷作为恢复目标。

验证最新的已确认备份：

```bash
sudo bash deploy/scripts/restore-verify.sh
```

验证指定归档：

```bash
sudo bash deploy/scripts/restore-verify.sh \
  /srv/citysafe/backups/citysafe_20260726T010203Z_1234abcd.tar.gz
```

验证加密归档：

```bash
sudo env \
  BACKUP_ENCRYPT_KEY_FILE=/etc/citysafe/backup.key \
  bash deploy/scripts/restore-verify.sh \
  /srv/citysafe/backups/citysafe_20260726T010203Z_1234abcd.tar.gz.enc
```

可选参数：

- `BACKUP_ROOT`：未给归档参数时，从该目录选择最新 `.verified` 备份；
- `RESTORE_VERIFY_TMP_ROOT`：隔离恢复的临时目录根路径，默认 `/tmp`；
- `RESTORE_VERIFY_HEALTH_TIMEOUT_SECONDS`：隔离服务健康超时，默认 `180` 秒；
- `RESTORE_VERIFY_MAX_AGE_HOURS`：允许的最大备份年龄，默认 `26` 小时；内容验证会继续
  完成，但超过该 RPO 上限时脚本最终返回失败；
- `HEALTH_WEBHOOK_URL`：验证失败时发送简短告警；
- `CITYSAFE_ENV_FILE`、`CITYSAFE_COMPOSE_FILE`、`CITYSAFE_SERVER_OVERRIDE`：自定义路径。

日志以 `restore verification PASS` 结束且退出码为 0 才算验证通过。建议每天自动备份、
每天或每周自动隔离验证，并定期在另一台机器进行完整恢复演练，记录 RPO 和 RTO。

## 7. 数据与数据库迁移

启动时，`migrate` 容器会等待 PostgreSQL 健康，按文件名字典序执行
`deploy/db/migrations/*.sql`。它使用 advisory lock 防止两个部署同时迁移，并在
`schema_migrations` 中记录每个文件的 SHA-256。

迁移规则：

- 已执行文件内容不变时会安全跳过；
- 已执行文件被修改时会故意失败，避免不同环境出现同名不同结构；
- 新结构使用下一个编号的新 SQL 文件；
- 破坏性变更应拆成“先兼容、再清理”的多个发布；
- 发布前用生产数据量级的副本估算锁表时间和磁盘增长；
- `migrate` 失败时不要删除迁移记录或数据卷，应先检查迁移日志和文件哈希。

本机演示数据不会被 `bootstrap-server.sh` 上传。确需把演示数据迁入生产时：

1. 明确需要迁移的账号、数据库记录、MinIO 对象和上传文件；
2. 不复制本机 `.env.local`，在服务器生成全新的生产密钥；
3. 生成完整备份并先做隔离恢复验证；
4. 清理测试账号、测试日志和敏感样例；
5. 在维护窗口按批准的恢复方案导入；
6. 再次执行迁移、健康检查、权限检查和抽样核对。

禁止直接复制 Docker 内部卷目录或只迁移 PostgreSQL 而遗漏 MinIO、上传和状态卷。

### 7.1 本机 Windows Docker → 已部署 Linux 服务器

前置：服务器已用 `bootstrap-server.sh` 跑通；本机 `stack.ps1 -Action up` 正常。

1. 本机导出（不打包 `.env.local`）：

```powershell
.\deploy\scripts\stack.ps1 -Action up
.\deploy\scripts\backup-local.ps1
```

备份写在 `deploy/backups/citysafe_*.tar.gz`（及 `.sha256` / `.verified`）。

2. 上传到服务器并隔离验证（验证时传入本机 MinIO 根账号，因 MinIO 卷里仍是本机根凭据）：

```powershell
scp deploy\backups\citysafe_XXXX.tar.gz* root@服务器:/srv/citysafe/backups/
```

```bash
cd /opt/city-safety-team-system
git pull --ff-only origin main
sudo env \
  SOURCE_MINIO_ROOT_USER='本机.env.local中的MINIO_ROOT_USER' \
  SOURCE_MINIO_ROOT_PASSWORD='本机.env.local中的MINIO_ROOT_PASSWORD' \
  RESTORE_VERIFY_MAX_AGE_HOURS=168 \
  bash deploy/scripts/restore-verify.sh \
  /srv/citysafe/backups/citysafe_XXXX.tar.gz
```

必须出现 `restore verification PASS`。

3. 维护窗口写入生产（会清空当前生产数据卷并覆盖）：

```bash
sudo env \
  CONFIRM_PRODUCTION_RESTORE=YES \
  SOURCE_MINIO_ROOT_USER='...' \
  SOURCE_MINIO_ROOT_PASSWORD='...' \
  bash deploy/scripts/restore-production.sh \
  /srv/citysafe/backups/citysafe_XXXX.tar.gz
```

脚本会保留服务器 `AUTH_*`、上传令牌和 `MINIO_ACCESS_KEY/SECRET`，并把
`MINIO_ROOT_*` 更新为与备份卷一致的本机根凭据。恢复后用**本机原账号**登录核对。

## 8. 密钥与证书轮换

服务器密钥保存在 `/etc/citysafe/server.env`，文件权限必须保持 `0600`。修改环境文件
后不能只执行 `docker compose restart`，因为已有容器不会重新读取环境变量；应使用
`up -d --force-recreate` 重建受影响容器。

轮换前先备份并完成隔离验证：

- `AUTH_SIGNING_SECRET`：更新后强制重建 `gateway`，所有现有登录会话都会失效。
- `MLOPS_TOKEN`、`ANNOTATION_UPLOAD_TOKEN`、`DATASET_UPLOAD_TOKEN`：先安排调用方切换，
  再更新环境文件并强制重建 `gateway`。当前配置不支持新旧令牌并行。
- PostgreSQL 密码：必须先在数据库中安全修改角色密码，再同步更新环境文件，并重建
  `db`、`migrate` 和 `gateway`；只改 `POSTGRES_PASSWORD` 不会修改已有数据卷中的角色密码。
- MinIO 根凭据：`MINIO_ROOT_USER/MINIO_ROOT_PASSWORD` 只提供给 MinIO 和一次性初始化
  服务，不进入网关。轮换根密码时在维护窗口重建 `minio`，再运行 `minio-init` 并检查网关。
- MinIO 应用凭据：常规轮换保持 `MINIO_ACCESS_KEY` 不变，只更新
  `MINIO_SECRET_KEY`；运行 `minio-init` 更新应用密码后重建 `gateway`。若确需更换
  `MINIO_ACCESS_KEY`，先完成新账号切换，再用 MinIO 管理命令显式删除旧应用用户；仅创建
  新用户不会自动撤销旧访问密钥。
- `BOOTSTRAP_ADMIN_PASSWORD`：只在账号库为空时创建首个管理员。修改该变量不会重置已有
  管理员密码，应通过系统内的密码修改或管理员重置流程处理。
- TLS 证书：证书更新后重建或重新加载 `edge`，再从外部检查证书链、有效期和 HTTPS。
- 备份加密密钥：独立于服务器环境文件保存；轮换后旧密钥仍需保留到对应旧备份过期。

重新创建单个普通服务的命令示例：

```bash
"${COMPOSE[@]}" up -d --force-recreate gateway
"${COMPOSE[@]}" ps
curl -fsS https://citysafe.example.com/api/health
```

数据库和 MinIO 凭据轮换涉及服务端真实凭据变更，不应直接照抄单容器示例。

## 9. 常见故障

| 现象 | 处理 |
|---|---|
| 本机脚本提示找不到 Docker | 启动 Docker Desktop，确认 Docker Compose 可用，再执行 `stack.ps1 -Action config` |
| 本机 `8080` 被占用 | 修改 `deploy/env/.env.local` 中的 `CITYSAFE_HTTP_PORT`，再执行 `-Action up` |
| 服务器启动前提示证书不存在 | 检查域名和证书目录；首次申请时使用 `--issue-cert --email`，并确保 80 端口可用 |
| `migrate` 退出码非 0 | 查看迁移日志；重点检查是否修改了已执行 SQL。恢复原文件并新增迁移，不要删表或清空迁移记录 |
| `migrate` 显示 `Exited (0)` | 正常，表示一次性迁移任务已成功完成 |
| 页面出现 502/504 | 用 `ps` 检查 `gateway/db/minio` 健康状态，再分别查看其日志和 `/api/health` |
| `/healthz` 正常但 `/api/health` 失败 | Nginx 正常但网关或依赖异常；检查网关、数据库、MinIO、磁盘和迁移日志 |
| 登录失败或忘记首次密码 | 临时密码只在首次创建环境文件时显示；修改 `BOOTSTRAP_ADMIN_PASSWORD` 不会重置已存在账号 |
| 上传返回 413 | 核对 Nginx 路径限制、`MAX_UPLOAD_BYTES` 和数据集分片大小；大型数据应走 `/api/dataset/*` 分片流程 |
| MinIO 预签名上传失败 | 检查 MinIO 健康、服务器时间、`MINIO_PUBLIC_UPLOAD_PREFIX=https://<域名>/minio-upload` 和 HTTPS |
| 修改环境文件后没有生效 | `restart` 不重读环境；使用 `up -d --force-recreate` 重建受影响服务 |
| 备份立即失败 | 确认 `db/gateway/minio` 正在运行，环境文件是普通文件，备份目录不在 Docker 内部目录，且没有另一备份持锁 |
| 恢复验证找不到备份 | 确认归档、`.sha256`、`.verified` 三个文件齐全，或显式传入归档路径 |
| 磁盘空间不足 | 检查 Docker 数据目录和备份目录；先扩容或按保留策略处理已验证旧备份，不要直接删除活动数据卷 |

## 10. 应急处置

发现入侵、凭据泄漏、异常删除或数据损坏时：

1. 记录发现时间、受影响账号、来源地址和当前版本，暂停非必要发布。
2. 保存 `docker compose ps`、相关容器日志、审计日志和外部告警；不要先清日志或删容器。
3. 需要立即阻断业务时，先在防火墙限制 `80/443`，或执行
   `"${COMPOSE[@]}" stop edge gateway`。不要停止后立刻删除容器或卷。
4. 令牌或会话密钥泄漏时，轮换 `AUTH_SIGNING_SECRET` 和受影响的客户端令牌，强制重建
   网关，并通知用户重新登录。
5. 数据库或 MinIO 凭据泄漏时，进入维护窗口按第 8 节同步轮换，检查异常账号、对象和
   审计记录。
6. 数据被破坏时，冻结写入，保留现场和当前数据副本，选择最近的已验证备份；先在隔离
   环境确认恢复结果，再制定生产恢复步骤。
7. 恢复后检查端口、容器健康、登录、权限、同步、上传下载和关键记录数量。
8. 记录根因、影响范围、RPO/RTO、轮换项和防复发措施，再解除维护状态。

任何应急场景都不要运行 `docker compose down -v`、手工删除 Docker 卷，或用未经验证的
备份直接覆盖生产。
