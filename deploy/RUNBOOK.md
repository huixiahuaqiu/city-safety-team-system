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

## 防火墙（回顾）

仅放行 SSH + 80 + 443。**不要**对公网开放 8000 / 9000 / 9001 / 5432。
