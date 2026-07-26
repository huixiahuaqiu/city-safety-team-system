# syntax=docker/dockerfile:1.7

FROM python:3.11.9-slim-bookworm

ARG APP_UID=10001
ARG APP_GID=10001

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    CITYSAFE_NO_BROWSER=1 \
    CITYSAFE_SKIP_BUILD=1

WORKDIR /opt/citysafe/123123

RUN groupadd --gid "${APP_GID}" citysafe \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" \
        --home-dir /opt/citysafe --create-home --shell /usr/sbin/nologin citysafe

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY . /opt/citysafe/123123
# `citysafe_db` is a BuildKit named context supplied by deploy/compose.yaml.
COPY --from=citysafe_db / /opt/citysafe/deploy/db

# Build cache-busting asset stamps once, then keep all mutable state outside
# the immutable application tree. The named volumes inherit these ownerships
# when Docker creates them for the first time.
RUN python build_assets.py \
    && rm -rf /opt/citysafe/123123/uploads /opt/citysafe/123123/logs \
    && rm -f /opt/citysafe/123123/mlops_store.json \
    && mkdir -p /data/uploads /data/logs /data/state \
    && ln -s /data/uploads /opt/citysafe/123123/uploads \
    && ln -s /data/logs /opt/citysafe/123123/logs \
    && ln -s /data/mlops_store.json /opt/citysafe/123123/mlops_store.json \
    && chown -R citysafe:citysafe /opt/citysafe /data

USER citysafe

EXPOSE 8000

CMD ["python", "start_web.py"]
