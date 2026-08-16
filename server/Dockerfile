# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web-build

WORKDIR /source
COPY package.json package-lock.json /source/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html /source/
COPY src /source/src
COPY catalog /source/catalog
RUN npm run build:server-web

FROM nvidia/cuda:12.8.2-base-ubuntu24.04 AS python-deps

ARG AUDIO_SEPARATOR_COMMIT=e66045e5f0a06206d9ea5062cc7dd53df22d38c0
ENV DEBIAN_FRONTEND=noninteractive \
    VIRTUAL_ENV=/opt/stem-separator \
    PATH=/opt/stem-separator/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates git python3.12 python3.12-dev python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.10.11 /uv /usr/local/bin/uv
COPY server/pyproject.toml server/uv.lock /tmp/server/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv --python /usr/bin/python3.12 --seed /opt/stem-separator \
    && uv pip install --python /opt/stem-separator/bin/python \
       torch==2.8.0 torchvision==0.23.0 \
       --index-url https://download.pytorch.org/whl/cu128 \
    && uv pip install --python /opt/stem-separator/bin/python \
       --extra-index-url https://download.pytorch.org/whl/cu128 \
       "audio-separator[gpu] @ git+https://github.com/HAGerox/python-audio-separator.git@${AUDIO_SEPARATOR_COMMIT}" \
       torch==2.8.0 torchvision==0.23.0 \
       "onnxruntime-gpu>=1.21,<1.27" audioread "librosa<0.11" \
    && uv sync --project /tmp/server --active --locked --no-dev --no-install-project --inexact

FROM python-deps AS server-build

WORKDIR /app
COPY server/pyproject.toml server/README.md /app/server/
COPY server/src /app/server/src
COPY --from=web-build /source/server/src/stem_separator_server/web /app/server/src/stem_separator_server/web
RUN uv build --wheel --out-dir /app/wheels /app/server

FROM nvidia/cuda:12.8.2-base-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    STEM_SEPARATOR_HOST=0.0.0.0 \
    STEM_SEPARATOR_PORT=7860 \
    STEM_SEPARATOR_DATA_DIR=/data \
    STEM_SEPARATOR_MODEL_DIR=/models \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    PATH=/opt/stem-separator/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 python3.12 zlib1g \
    && useradd --create-home --uid 10001 stem-separator \
    && mkdir -p /data /models \
    && chown stem-separator:stem-separator /data /models \
    && rm -rf /var/lib/apt/lists/*

COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/stem-separator/
COPY --from=python-deps /opt/stem-separator /opt/stem-separator
COPY --from=server-build /app/wheels /tmp/wheels
RUN /opt/stem-separator/bin/pip install --no-deps /tmp/wheels/*.whl \
    && rm -rf /tmp/wheels \
    && /opt/stem-separator/bin/python -c "import onnxruntime, torch; onnxruntime.preload_dlls(directory=''); assert 'CUDAExecutionProvider' in onnxruntime.get_available_providers(); print(f'PyTorch {torch.__version__}, CUDA {torch.version.cuda}, ONNX providers {onnxruntime.get_available_providers()}')"

ENV NUMBA_CACHE_DIR=/data/.cache/numba
LABEL org.opencontainers.image.source="https://github.com/HAGerox/Stem-Separator"
VOLUME ["/data", "/models"]
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/healthz', timeout=3)"
USER stem-separator
CMD ["stem-separator-server", "--host", "0.0.0.0", "--port", "7860"]
