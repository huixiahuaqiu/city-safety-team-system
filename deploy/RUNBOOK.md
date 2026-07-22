# 运维速查 Runbook

## 服务状态

```bash
systemctl status citysafe-gateway minio nginx fail2ban
journalctl -u citysafe-gateway -n 100 --no-pager
journalctl -u minio -n 50 --no-pager
```

## 健康检查

```bash
curl -s http://127.0.0.1:8000/api/health | jq
curl -s http://127.0.0.1:8000/api/shared-file/health | jq
curl -s http://127.0.0.1:8000/api/dataset/health | jq
/opt/citysafe/bin/healthcheck.sh; echo $?
```

## 发布与回滚

```bash
# 发布（在含 123123 的机器上）
sudo -u appsvc SRC=/path/to/repo/123123 bash /opt/citysafe/bin/release.sh

# 回滚上一版
bash /opt/citysafe/bin/rollback.sh

# 回滚指定版本
ls /opt/citysafe/releases
bash /opt/citysafe/bin/rollback.sh 2026-07-14_013000
```

回滚本质：`ln -sfn releases/<旧版> current` + `systemctl restart citysafe-gateway` + `nginx reload`。

## 磁盘与大文件

```bash
df -h /data
du -sh /data/minio /data/uploads /data/backups
/opt/citysafe/bin/disk_alert.sh
mc du local/team-shared          # 需已 mc alias
```

阈值 ≥85%：扩容 LVM 或清理 `/data/backups` 旧包、MinIO 非当前版本。

### 超大文件数据集（100GB+）
- **路径**：只走「数据集资源库」`/api/dataset/*` 分片上传（共享文件库有 5GB 单次 PUT 硬限）。前端分片大小自动读取 `/api/dataset/health` 的 `chunkSize`（现 64MB）。
- **磁盘（关键）**：合并阶段"分片副本 + 最终文件"**同时存在**，峰值需 **≥2× 单文件大小**的空闲空间；数据集最终落**本地磁盘** `/data/uploads/datasets`（不进 MinIO）。按「2 × 最大单文件 × 并发上传数」规划 `/data`。
- **超时**：`/complete` 对 100GB 级做合并+校验可达数十分钟，已给 `/api/dataset/` 配 `proxy_read_timeout 3600s`。
- **上限**：`MAX_DATASET_BYTES`（生产 200GB）。需更大改此值即可。
- **ClamAV**：clamd 默认单文件上限远小于 100GB，超大文件会跳过/报错；对 100GB 级依赖上传前扫描或离线抽检，勿指望同步全量查杀。

## MinIO

```bash
systemctl status minio
# 控制台仅本机：127.0.0.1:9001，用 SSH 隧道访问
ssh -L 9001:127.0.0.1:9001 user@server
mc ls local/team-shared
```

预签名直传路径：浏览器 → `https://域名/minio-upload/...` → Nginx → `127.0.0.1:9000`。

## 备份 / 恢复

```bash
sudo -u appsvc /opt/citysafe/bin/backup.sh
ls -lt /data/backups | head
```

恢复要点：
1. 解包或解密 `citysafe_*.tar.gz(.enc)` 取 `state/*_registry.json`
2. `mc mirror` 从异地桶拉回 `team-shared`
3. 若有 `pg.sql.gz`：`gunzip -c pg.sql.gz | psql "$BACKUP_PG_URL"`
4. 重启 `citysafe-gateway`，用健康检查验证

季度至少做一次**异机恢复演练**，记录 RTO/RPO。

## 安全

```bash
sudo fail2ban-client status
sudo fail2ban-client status citysafe-nginx
sudo fail2ban-client status sshd
# 解封
sudo fail2ban-client set sshd unbanip x.x.x.x
```

轮换 token：改 `/opt/citysafe/.env` → `systemctl restart citysafe-gateway`。  
`.env` / `/etc/default/minio` / 证书私钥权限必须 `600`。

## 常见故障

| 现象 | 排查 |
|------|------|
| 502 Bad Gateway | `systemctl status citysafe-gateway`；确认 `BIND_HOST=127.0.0.1` 且监听 8000 |
| 上传 413 | Nginx `client_max_body_size` 与 `.env` `MAX_UPLOAD_BYTES` |
| MinIO 上传失败 | `SHARED_STORAGE_BACKEND=minio`、密钥、桶是否存在；看网关日志 fallback |
| 静态 404 | `readlink -f /opt/citysafe/current` 是否指向有效 release |
| CORS 报错 | 生产 `CORS_ALLOW_ORIGIN` 是否精确匹配前端 Origin（含 https） |
| CSP 告警 | 当前为 Report-Only，不阻断；本地化 CDN 后再改强制 |

## 灰度 / 蓝绿发布（降低硬切风险）

当前 `release.sh` 为软链硬切。需灰度时用双网关实例 + Nginx 权重：

```nginx
# conf.d 或站点内：蓝(现网) 90% / 绿(新版) 10%
upstream citysafe_gateway {
    server 127.0.0.1:8000 weight=9;   # blue（current）
    server 127.0.0.1:8001 weight=1;   # green（新版，另起一个 systemd 实例，端口 8001）
    keepalive 16;
}
```

流程：绿实例起在 8001（`PORT` 可用环境变量或复制 unit 覆盖）→ 观察 `/api/health` 的 `degraded`、`metrics.*SuccessRate` 与 Nginx 4xx/5xx → 无异常再把权重调到 5:5、最终 0:10 并切软链。异常直接把绿权重降 0，零停机回退。

## 可观测性（健康字段 / 指标 / 集中日志）

- `/api/health` 新增：`ready`/`degraded`（依赖+磁盘就绪）、`disk.usedPercent`、`presignHttpsOk`、`metrics.{upload,download,presign}SuccessRate`。探针应看 `ready`/`degraded`，不要只看进程存活。
- 采集：Prometheus blackbox 抓 `/api/health` JSON，对 `degraded==true`、`disk.usedPercent>=85`、`*SuccessRate<98` 配告警；`healthcheck.sh` 已在 `degraded` 时告警。
- 集中日志：`deploy/rsyslog/citysafe-forward.conf` 把审计日志实时转发到远端 syslog/Loki；本地 `/data/logs` 仍留 append-only 副本。

## 上传纵深防御（已内建）

- 网关 multipart：扩展名白名单 + `sniff_allowed_upload` 文件头魔数校验 + `enforce_clamav_scan`（`CLAMAV_SCAN=1` 启用）。
- MinIO 直传（预签名）：`confirm` 时拉取文件头做魔数兜底，识别 HTML/脚本/webshell 即删对象拒绝；预签名有效期硬上限 15 分钟、按 owner 归属校验。
- 大文件异步查杀（可选）：直传对象无法在网关同步扫描，用 cron 定期 `mc cp` 拉取近窗口对象送 `clamdscan`，命中则 `mc rm` + 注册表标记（详见 `deploy/scripts/clamav-setup-notes.md`）。

## 备份恢复演练

```bash
# 手动演练（只读，不覆盖生产）
BACKUP_ENCRYPT_KEY_FILE=/opt/citysafe/backup.key /opt/citysafe/bin/restore-verify.sh
tail -n 20 /data/logs/restore-verify.log     # 看 PASS/FAIL、近似 RTO、备份年龄(RPO)
```

cron 已配每周日 03:30 自动演练；季度做一次**异机**完整还原并记录 RTO/RPO。数据库 dump 与文件备份分开调度、分开存储。

## 防火墙（回顾）

仅放行 SSH + 80 + 443。**不要**对公网开放 8000 / 9000 / 9001 / 5432。
