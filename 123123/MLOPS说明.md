# 自动 MLOps 接入说明

本系统不在浏览器里跑训练，而是接收**本机 / 远程训练脚本**的状态上报，自动写入「模型训练台账」并同步云端。

## 架构

1. 训练机执行训练，周期性调用上报接口
2. 本机 `start_web.py` 的 `/api/mlops/report` 接收并写入 `mlops_store.json`
3. 服务端合并推送到云端 `modelTrainingData`
4. 门户页每 8 秒拉取 `/api/mlops/jobs`（并走原有云端同步），全员可见

## 启动

```bash
cd 123123
python start_web.py
```

启动前必须配置 `MLOPS_TOKEN`，不要把真实 Token 提交到 Git。推荐复制 `.env.example` 为 `.env` 后填写。

## 训练脚本上报

```bash
python mlops_report.py --job-id exp-crack-0612 --name 结构裂缝检测-YOLOv8 --status training --progress 42 --metric "mAP 0.81" --env local --server 本机-RTX4090 --log-url http://127.0.0.1:6006 --token "$MLOPS_TOKEN"
```

训练结束：

```bash
python mlops_report.py --job-id exp-crack-0612 --status completed --progress 100 --metric "mAP 94.6%" --weight-path D:/experiments/crack/best.pt --token "$MLOPS_TOKEN"
```

代码内调用：

```python
from mlops_report import report
report(job_id='exp-1', name='裂缝检测', status='training', progress=50, env='local')
```

远程服务器若能访问门户本机 IP，把 `--endpoint` 改成：

`http://<你的电脑局域网IP>:8000/api/mlops/report`

## 接口

- `POST /api/mlops/report`  
  Header: `X-MLOps-Token: <MLOPS_TOKEN>`  
  Body JSON: `jobId`, `name`, `status`, `progress`, `metric`, `env`, `server`, `logUrl`, `weightPath`, ...
- `GET /api/mlops/jobs`
- `GET /api/mlops/health`

## 门户操作

进入「模型训练台账」→ **MLOps 接入** 查看地址与示例 → **立即同步** 可手动拉取。
