#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""训练脚本回调：向本机 MLOps 接口上报进度（也可直写云端）。

用法示例：
  python mlops_report.py --job-id exp-crack-0612 --name 结构裂缝检测 --status training --progress 42 --metric "mAP 0.81" --token "$MLOPS_TOKEN"
  python mlops_report.py --job-id exp-crack-0612 --status completed --progress 100 --metric "mAP 94.6%" --weight-path D:/exp/best.pt --token "$MLOPS_TOKEN"

在训练循环中：
  from mlops_report import report
  report(job_id='exp-1', name='裂缝检测', status='training', progress=epoch/epochs*100, env='local')
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_ENDPOINT = os.environ.get('MLOPS_ENDPOINT', 'http://127.0.0.1:8000/api/mlops/report')
DEFAULT_TOKEN = os.environ.get('MLOPS_TOKEN', '')


def report(
    job_id,
    name='',
    status='training',
    progress=0,
    metric='',
    env='local',
    server='',
    owner='',
    dataset='',
    log_url='',
    weight_path='',
    model_type='YOLOv8',
    scenario='结构损伤诊断',
    description='',
    endpoint=None,
    token=None,
):
    payload = {
        'jobId': job_id,
        'name': name or job_id,
        'status': status,
        'progress': progress,
        'metric': metric,
        'env': env,
        'server': server or ('本机' if env == 'local' else 'remote-gpu'),
        'owner': owner,
        'dataset': dataset,
        'logUrl': log_url,
        'weightPath': weight_path,
        'type': model_type,
        'scenario': scenario,
        'description': description,
    }
    url = endpoint or DEFAULT_ENDPOINT
    tok = token or DEFAULT_TOKEN
    if not tok:
        raise RuntimeError('MLOPS_TOKEN is required. Set env MLOPS_TOKEN or pass --token.')
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Content-Type': 'application/json',
            'X-MLOps-Token': tok,
            'Authorization': 'Bearer ' + tok,
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        raise RuntimeError(f'MLOps report failed HTTP {e.code}: {body}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f'MLOps report failed: {e}. 请确认已运行 start_web.py，且 endpoint={url}'
        ) from e


def main(argv=None):
    p = argparse.ArgumentParser(description='向城市安全团队系统上报训练状态')
    p.add_argument('--job-id', required=True, help='任务号 / 实验目录名')
    p.add_argument('--name', default='', help='模型显示名称')
    p.add_argument('--status', default='training', choices=['pending', 'training', 'completed', 'failed'])
    p.add_argument('--progress', type=float, default=0)
    p.add_argument('--metric', default='')
    p.add_argument('--env', default='local', choices=['local', 'remote'])
    p.add_argument('--server', default='')
    p.add_argument('--owner', default='')
    p.add_argument('--dataset', default='')
    p.add_argument('--log-url', default='')
    p.add_argument('--weight-path', default='')
    p.add_argument('--type', dest='model_type', default='YOLOv8')
    p.add_argument('--scenario', default='结构损伤诊断')
    p.add_argument('--description', default='')
    p.add_argument('--endpoint', default=DEFAULT_ENDPOINT)
    p.add_argument('--token', default=DEFAULT_TOKEN)
    args = p.parse_args(argv)

    result = report(
        job_id=args.job_id,
        name=args.name,
        status=args.status,
        progress=args.progress,
        metric=args.metric,
        env=args.env,
        server=args.server,
        owner=args.owner,
        dataset=args.dataset,
        log_url=args.log_url,
        weight_path=args.weight_path,
        model_type=args.model_type,
        scenario=args.scenario,
        description=args.description,
        endpoint=args.endpoint,
        token=args.token,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
