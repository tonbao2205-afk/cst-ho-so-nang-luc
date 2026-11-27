# Trang hồ sơ năng lực CST.,JSC + trang admin. Chỉ cần Python (thư viện chuẩn).
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Ho_Chi_Minh \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin cst \
    && mkdir -p /data/site /data/admin \
    && chown -R cst:cst /data

WORKDIR /app

# Mã máy chủ + công cụ khởi động
COPY admin/server.py /app/admin/server.py
COPY docker/ /app/docker/
# Bản trang gốc trong image (chép sang volume /data/site khi khởi động, xem docker/seed.py)
COPY index.html /app/site/index.html
COPY img/ /app/site/img/
COPY giay-to/ /app/site/giay-to/
COPY admin/index.html admin/admin.js admin/admin.css /app/site/admin/

RUN sed -i 's/\r$//' /app/docker/entrypoint.sh && chmod +x /app/docker/entrypoint.sh

USER cst
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/' % os.environ.get('PORT','8080'), timeout=4)" || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
