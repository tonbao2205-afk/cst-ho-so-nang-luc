#!/bin/sh
# Khởi động container: chép trang từ image sang volume (giữ phần admin đã sửa), rồi chạy máy chủ trang + admin.
set -eu

SITE="${CST_SITE_DIR:-/data/site}"
DATA="${CST_DATA_DIR:-/data/admin}"
mkdir -p "$SITE" "$DATA"

python /app/docker/seed.py /app/site "$SITE" "$DATA"

exec python /app/admin/server.py --lan --port "${PORT:-8080}" --root "$SITE" --data "$DATA"
