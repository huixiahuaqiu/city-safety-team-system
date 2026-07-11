# 故障排查手册

## 服务无法启动

- 检查 `8000` 端口是否被占用。
- 确认当前目录为 `123123` 或通过 `python 123123/start_web.py` 启动。
- 查看 `123123/logs/server_audit.log` 中的异常堆栈。

## 云同步不可用

- 确认 `123123/config.local.js` 中存在 `SUPABASE_URL` 与 `SUPABASE_KEY`。
- 确认 `123123/.env` 中同样配置了服务端 Supabase 参数，否则 MLOps 台账不会服务端推云。
- 浏览器控制台若提示 `Supabase 未配置`，说明前端本地配置未生效。

## 标注文件上传失败

- `401 invalid upload token`：检查 `.env` 与 `config.local.js` 中的 `ANNOTATION_UPLOAD_TOKEN` 是否一致，并重启 `start_web.py`。
- `413 file too large`：调大 `.env` 中的 `MAX_UPLOAD_BYTES`，或压缩数据集后再上传。
- `file extension not allowed`：在 `ALLOWED_UPLOAD_EXTENSIONS` 中增加经过安全评估的扩展名。
- 云端桶不可用 / HTTP 404：在 Supabase SQL Editor 执行 `123123/supabase_annotations_storage.sql`。
- 提示“仅保存到本浏览器 / 其他人看不到”：说明云端上传失败，按上面开通云端桶后重新上传。
- 上传成功后，云端对象路径为 `annotations/tasks/<taskId>/...`；本机备份位于 `123123/uploads/annotations/<taskId>/`。

## 其他人看不到上传文件

1. 确认任务卡片显示「云端共享（全员可看）」。
2. 确认 `annotationData` 已云端同步（右下角同步提示）。
3. 其他人点击「导出」应优先从云端拉取；若仍失败，检查 Storage 桶策略是否允许 public read。
4. 若 storage 仅为 `idb` 或 `server`，说明未上云，其他人无法访问真实文件。

## MLOps 上报失败

- `401 invalid token`：训练脚本传入的 `--token` 与服务端 `.env` 中 `MLOPS_TOKEN` 不一致。
- `jobId or name required`：上报体缺少任务标识，至少传入 `--job-id` 或 `--name`。
- 远程训练机无法连接：检查门户机器防火墙、局域网 IP、端口映射和反向代理配置。

## 导出没有真实文件

- 先确认任务创建时上传结果显示成功。
- 访问 `/api/annotation/files?taskId=<taskId>` 检查服务端是否能列出文件。
- 如果只存在浏览器 IndexedDB 备份而服务端没有文件，说明上传接口当时未配置 token 或请求被拦截。

## 日志与审计

- API 写入、拒绝、异常均记录到 `123123/logs/server_audit.log`。
- 排查问题时优先按 `event`、`taskId`、`jobId` 过滤日志。
- 日志文件禁止提交 Git，已由 `.gitignore` 过滤。
