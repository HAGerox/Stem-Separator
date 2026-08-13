FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ARG AUDIO_SEPARATOR_COMMIT=dccdbe5fafa8d2c4274ebf76a3ff1c27bf0c86d3
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    STEM_SEPARATOR_HOST=0.0.0.0 \
    STEM_SEPARATOR_PORT=7860 \
    STEM_SEPARATOR_DATA_DIR=/data \
    STEM_SEPARATOR_MODEL_DIR=/models

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates ffmpeg git python3.12 python3.12-dev python3-pip python3-venv \
    && useradd --create-home --uid 10001 stem-separator \
    && mkdir -p /data /models \
    && chown stem-separator:stem-separator /data /models \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app/server
RUN python3.12 -m venv /opt/stem-separator \
    && /opt/stem-separator/bin/pip install --upgrade pip \
    && /opt/stem-separator/bin/pip install torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128 \
    && /opt/stem-separator/bin/pip install --extra-index-url https://download.pytorch.org/whl/cu128 \
       "audio-separator[gpu] @ git+https://github.com/HAGerox/python-audio-separator.git@${AUDIO_SEPARATOR_COMMIT}" \
       torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 \
       audioread "librosa<0.11" \
    && /opt/stem-separator/bin/pip install /app/server \
    && /opt/stem-separator/bin/python -m compileall -q /opt/stem-separator/lib/python3.12/site-packages

ENV PATH=/opt/stem-separator/bin:$PATH
LABEL org.opencontainers.image.source="https://github.com/HAGerox/Stem-Separator"
VOLUME ["/data", "/models"]
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/healthz', timeout=3)"
USER stem-separator
CMD ["stem-separator-server", "--host", "0.0.0.0", "--port", "7860"]
