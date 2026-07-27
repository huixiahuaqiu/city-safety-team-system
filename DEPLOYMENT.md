# 部署说明

系统现已统一为同一套 Docker 架构：

```text
浏览器 → Nginx 唯一入口 → Python 网关 → PostgreSQL
                                  └→ MinIO
```

本机演示与公司服务器使用同一个 `deploy/compose.yaml`，只通过本地/服务器覆盖文件和环境变量区分。浏览器不会直接连接数据库、MinIO 或 Supabase。

## 本机一键启动（Windows）

前置条件：安装并启动 Docker Desktop。

在仓库根目录打开 PowerShell：

```powershell
.\deploy\scripts\stack.ps1
```

首次运行会：

1. 生成仅保存在本机、已被 Git 忽略的 `deploy/env/.env.local`；
2. 生成随机数据库、MinIO、会话和上传密钥；
3. 构建并启动 PostgreSQL、迁移器、MinIO、网关和 Nginx；
4. 创建首个管理员并显示一次临时密码；
5. 等待所有依赖真实就绪。

访问：<http://127.0.0.1:8080>

首次登录后必须修改临时密码。默认仅 `127.0.0.1:8080` 对本机开放；数据库、MinIO 和网关没有宿主机端口。

常用命令：

```powershell
.\deploy\scripts\stack.ps1 -Action status
.\deploy\scripts\stack.ps1 -Action logs
.\deploy\scripts\stack.ps1 -Action smoke
.\deploy\scripts\stack.ps1 -Action restart
.\deploy\scripts\stack.ps1 -Action down
```

`down` 不删除数据卷。需要查看 MinIO 控制台时，显式加 `-WithMinioConsole`，控制台也只绑定本机。

## 本机部署并让外地同事访问（临时公网）

本机 Docker 默认只在 `127.0.0.1:8080`。若需要**同一套真实数据**给外地同事用，可开 Cloudflare 临时隧道：

```powershell
# 1) 先保证本机栈已起来
.\deploy\scripts\stack.ps1 -Action up

# 2) 再开公网分享（窗口保持打开）
.\deploy\scripts\share-tunnel.ps1
```

脚本会安装/调用 `cloudflared`，生成形如 `https://xxxx.trycloudflare.com` 的地址，并自动写入 `PUBLIC_ORIGIN` / CORS 后重启入口。把该地址和本机账号发给同事即可。

注意：

- 你的电脑必须保持开机、Docker 与隧道窗口不能关；睡眠或断网后链接失效；
- 每次重新运行，公网地址可能变化；
- 仅适合演示/内测。长期多人使用请部署到公司云服务器（见下一节）。

局域网同事若在同一 Wi‑Fi，也可直接用 `http://你的局域网IP:8080`（需防火墙放行 8080），但外地访问仍需隧道或云服务器。

## 公司服务器一键部署（Linux）

前置条件：

- Docker Engine 与 Docker Compose 插件；
- 域名已解析到服务器；
- 公司证书已放入 `/etc/letsencrypt/live/<域名>/`，或服务器可使用 Certbot；
- 防火墙仅放行 SSH、80、443。

将仓库放到服务器后执行：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain citysafe.example.com \
  --issue-cert \
  --email admin@example.com
```

若公司已提供证书，去掉 `--issue-cert` 和 `--email`。脚本会把服务器密钥写入权限为 `0600` 的 `/etc/citysafe/server.env`，后续重复执行会保留密钥和数据，只更新应用版本。

服务器只发布 Nginx 的 80/443；PostgreSQL 5432、MinIO 9000/9001、网关 8000 均只存在于 Docker 内部网络。

服务器完成首次克隆和 SSH/sudo 准备后，后续版本可以直接在 Windows 本机一键触发：

```powershell
.\deploy\scripts\deploy-server.ps1 `
  -Server deployer@server.example.com `
  -Domain citysafe.example.com `
  -RemotePath /opt/city-safety-team-system `
  -Ref refs/tags/v1.0.0
```

建议生产始终部署审查过的 Git 标签或完整提交哈希。脚本遇到服务器工作区有未提交内容、
分支不能快进或任一步失败都会停止，不会覆盖服务器上的临时改动。正式执行前可加
`-WhatIf` 预演。

只生成配置、不启动：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --domain citysafe.example.com \
  --prepare-only
```

## 数据边界

- 结构化数据：PostgreSQL 持久卷；
- 共享文件与标注包：MinIO 持久卷；
- 分片数据集、日志和本地状态：独立持久卷；
- 数据库结构：`deploy/db/migrations/*.sql`，启动前由迁移容器按哈希校验并执行；
- 浏览器离线修改：进入本地待同步队列，恢复连接后按版本提交；
- 多人同时修改：版本不一致时拒绝静默覆盖，保留本机修改并提示处理。

本机数据不会在代码部署时自动上传到公司服务器。需要迁移演示数据时，应使用经过校验的备份/恢复流程，避免把本机密钥、测试账号或无关文件带入生产。

## 安全要求

- 不提交 `deploy/env/.env.local`、`/etc/citysafe/server.env`、`.env` 或 `config.local.js`；
- 生产必须使用 HTTPS、强随机密钥和服务端会话认证；
- 不能把数据库、MinIO、上传、MLOps 或 AI 密钥写入任何前端 JavaScript；
- 生产配置拒绝通配符跨域、明文外部 MinIO 地址和不安全预签名；
- 首次管理员、账号管理、密码重置均由服务端保存 PBKDF2 验证器；
- 关键同步采用版本比较，旧版本写入返回冲突，不会覆盖他人新数据；
- 备份必须同时覆盖 PostgreSQL、MinIO 和应用持久卷，并定期做隔离恢复验证。

详细运维命令见 [deploy/README.md](deploy/README.md) 与 [deploy/RUNBOOK.md](deploy/RUNBOOK.md)。
