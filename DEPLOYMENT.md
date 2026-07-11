# 生产部署说明

## 环境要求

- Python 3.8 及以上
- 现代浏览器（Chrome / Edge）
- 可访问 Supabase 的网络环境（需要云同步时）

## 配置步骤

1. 进入服务目录：

```bash
cd 123123
```

2. 创建服务端配置：

```bash
copy .env.example .env
```

填写 `SUPABASE_URL`、`SUPABASE_KEY`、`MLOPS_TOKEN`、`ANNOTATION_UPLOAD_TOKEN`。所有 token 应使用随机强值，并通过团队密钥管理工具分发。

3. 创建前端本地配置：

```bash
copy config.example.js config.local.js
```

`config.local.js` 中的 Supabase 配置用于浏览器端云同步，`ANNOTATION_UPLOAD_TOKEN` 用于本机标注上传接口鉴权。

4. 安装依赖：

```bash
python -m pip install -r requirements.txt
```

当前 Python 网关仅使用标准库，保留 `requirements.txt` 作为依赖管理入口。

## 启动服务

```bash
python start_web.py
```

默认访问地址为 `http://localhost:8000`。日志写入 `123123/logs/server_audit.log`，真实上传文件写入 `123123/uploads/annotations/`。

## 远程训练机接入

远程训练机需要能访问门户所在机器的 `8000` 端口，并使用相同的 `MLOPS_TOKEN`：

```bash
python mlops_report.py --endpoint http://<portal-host>:8000/api/mlops/report --job-id exp-1 --status training --progress 30 --token "$MLOPS_TOKEN"
```

## 标注文件全员共享

标注数据集默认上传到 Supabase Storage 桶 `annotations`，任务元数据走现有云端同步，因此团队成员都能查看并导出真实文件。

开通步骤（只需一次）：

1. 打开 Supabase Dashboard → SQL Editor
2. 执行 `123123/supabase_annotations_storage.sql`
3. 确认本机已配置 `123123/config.local.js` 与 `123123/.env` 中的 `SUPABASE_URL` / `SUPABASE_KEY`
4. 重启 `python start_web.py` 后重新创建标注任务并上传

上传优先级：

1. 云端共享（全员可见）
2. 本机网关备份（同一门户实例可导出）
3. 浏览器 IndexedDB（仅本机兜底，不作为团队共享）

## 安全要求

- 禁止提交 `.env`、`config.local.js`、上传目录、日志文件和本地状态文件。
- 生产环境必须配置 `MLOPS_TOKEN` 与 `ANNOTATION_UPLOAD_TOKEN`，未配置时写接口会拒绝请求。
- 上传扩展名和大小通过 `ALLOWED_UPLOAD_EXTENSIONS`、`MAX_UPLOAD_BYTES` 控制。
- 对外暴露服务时应放在 HTTPS 反向代理后，并启用来源限制、访问日志和网络防火墙。

## 版本迭代规范

- 每次功能变更必须同步更新配置模板、部署说明或排障说明。
- 涉及数据结构变更时，提交说明中写清迁移策略和回滚方式。
- Git commit message 使用简体中文，例如 `feat: 加固标注文件上传鉴权`。
