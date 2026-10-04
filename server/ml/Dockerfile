# Optional machine-learning service for Open Dash Cam smart search (CLIP).
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/cache \
    SENTENCE_TRANSFORMERS_HOME=/cache \
    PORT=3003

# ffmpeg decodes and re-encodes video for plate/face blurring.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch keeps the image far smaller than the default GPU build.
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

WORKDIR /app
COPY app.py blur.py ./

VOLUME /cache
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD python -c "import urllib.request,json,sys; sys.exit(0 if json.load(urllib.request.urlopen('http://127.0.0.1:3003/health'))['ready'] else 1)"

CMD ["python", "app.py"]
