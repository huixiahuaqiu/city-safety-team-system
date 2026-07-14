# ClamAV 安装说明（Ubuntu）

网关 `123123/working_proxy.py` 支持可选上传后扫描。本地开发默认 `CLAMAV_SCAN=0`，无需安装 ClamAV。

## 安装

```bash
sudo apt update
sudo apt install -y clamav clamav-daemon
sudo systemctl enable --now clamav-daemon
sudo freshclam   # 首次更新病毒库，可能较慢
```

## 网关配置

在 `123123/.env`（或 systemd 环境）中：

```env
CLAMAV_SCAN=1
CLAMSCAN_BIN=clamdscan
```

- `clamdscan`：走 clamd 守护进程，适合生产（低延迟）。
- `clamscan`：单次进程扫描，无需 daemon，适合调试。

## 验证

```bash
clamdscan --version
curl -s http://127.0.0.1:8000/api/health | jq '.clamavEnabled, .clamavReady'
```

`clamavEnabled=true` 且 `clamavReady=true` 表示扫描已启用且二进制可用。

## 行为

- 数据集合并完成（`/api/dataset/complete`）与共享文件本机落盘后扫描。
- 检出恶意文件时重命名为 `*.quarantine` 并返回错误；审计日志事件 `clamav_quarantine`。
- MinIO 直传路径不经网关落盘，需在对象存储侧另行策略（如异步扫描任务）。

## 故障排查

| 现象 | 处理 |
|------|------|
| `clamavReady=false` | 确认 `CLAMSCAN_BIN` 在 PATH，或写绝对路径 |
| 扫描超时 | 大文件可调大 `working_proxy.py` 内 timeout，或改用 clamd |
| `freshclam` 失败 | 检查网络/代理；可手动下载 daily.cvd |
