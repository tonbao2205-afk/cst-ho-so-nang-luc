# Docker, CI/CD và triển khai

## Gồm những gì

| Tệp | Việc |
|---|---|
| `Dockerfile` | Image trang + admin (Python 3.13, không cần thư viện ngoài). |
| `docker/entrypoint.sh`, `docker/seed.py` | Khi container khởi động: chép trang từ image sang ổ dữ liệu `/data`, rồi chạy máy chủ. |
| `docker-compose.yml` + `Caddyfile` | Chạy trên máy chủ: app + Caddy (tự cấp HTTPS). |
| `docker-compose.local.yml` | Chạy thử trên máy, không HTTPS. |
| `.github/workflows/ci.yml` | CI: kiểm tra mã → kiểm thử → build + chạy thử image → đẩy image lên `ghcr.io` → (deploy, đang tắt). |
| `tests/smoke_test.py` | Kiểm thử máy chủ admin + chép trang (`python tests/smoke_test.py`). |

## Web tĩnh trên GitHub Pages

Mỗi lần push lên `main`, sau khi kiểm thử đạt, CI đăng trang lên **https://tonbao2205-afk.github.io/cst-ho-so-nang-luc/**.

- Trang đăng lên gồm `index.html`, `img/` và `giay-to/`.
- Trang tĩnh **không có admin**. Muốn sửa nội dung thì sửa bằng admin trên máy, rồi commit và push để đăng lại.

## Dữ liệu nằm ở đâu (quan trọng)

Trên máy chủ, admin sửa trang ngay trong ổ dữ liệu `cst-data` (`/data`):

- `/data/site`: trang đang chạy (`index.html`, `img/`, `giay-to/`), gồm cả ảnh và tệp tải lên qua admin.
- `/data/admin`: mật khẩu (đã băm) và các bản lưu.

Khi deploy image mới:

- Mã admin luôn được cập nhật.
- Ảnh và tệp chưa bị sửa trên máy chủ: cập nhật theo bản mới.
- Tệp đã sửa qua admin: **giữ nguyên, không ghi đè**.
- Nếu `index.html` đã sửa qua admin mà mã nguồn cũng có `index.html` mới: bản mới được cất vào **admin → Bản lưu**, tên `…-ban-moi-tu-ma-nguon.html`. Muốn dùng thì bấm Khôi phục.

Sao lưu ổ dữ liệu:

```
docker run --rm -v cst-site_cst-data:/data -v "$PWD":/b alpine tar czf /b/cst-data.tgz -C /data .
```

## Chạy thử Docker trên máy

Cần Docker Desktop đang chạy.

```
set CST_ADMIN_USER=quantri
set CST_ADMIN_PASSWORD=mat-khau-thu
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build app
```

Mở trang ở http://localhost:8080, admin ở http://localhost:8080/admin/. Kiểm thử container đang chạy:

```
python tests/smoke_test.py --url http://127.0.0.1:8080
```

## Đưa lên GitHub (bật CI)

1. Tạo repo **riêng tư** trên GitHub.
2. Trong thư mục dự án, chạy:

   ```
   git init -b main
   git add .
   git commit -m "Trang CST.,JSC + Docker + CI"
   git remote add origin https://github.com/<tài-khoản>/<repo>.git
   git push -u origin main
   ```

3. Mỗi lần push, xem tab **Actions**. Push lên `main` sẽ đẩy image `ghcr.io/<tài-khoản>/<repo>:latest`, kèm `:sha-<commit>`. Tag `v1.0.0` sẽ đẩy thêm `:v1.0.0`.

`admin/data/` (mật khẩu, bản lưu trên máy) và `.env` không bao giờ được đưa lên GitHub (xem `.gitignore`).

## Máy chủ đang chạy (VPS)

**VPS:** `103.159.52.49`, Ubuntu 24.04. Trang đang chạy ở http://103.159.52.49/

- **Docker và tường lửa:** đã cài Docker. Tường lửa `ufw` chỉ mở các cổng 22, 80 và 443.
- **Tài khoản `deploy`:** chỉ đăng nhập bằng khóa SSH, thuộc nhóm docker. GitHub Actions dùng tài khoản này, không dùng mật khẩu root.
- **Thư mục cấu hình** `/home/deploy/cst-site/` gồm `docker-compose.yml`, `Caddyfile`, `Caddyfile.ip` và `.env`. Tệp `.env` chứa mật khẩu admin và không có trên GitHub.
- **Chưa có tên miền:** `.env` đang đặt `CADDYFILE=Caddyfile.ip`, nên trang chỉ chạy HTTP và **trang admin bị chặn (403)**.

### Deploy tự động

Mỗi lần push lên `main`, nếu kiểm thử và build image đều đạt, job `deploy` sẽ:

1. SSH vào VPS bằng tài khoản `deploy`.
2. Ghi `IMAGE=…:sha-<commit>` vào `.env`.
3. Chạy `docker compose pull` rồi `docker compose up -d`.
4. Kiểm tra `SITE_URL` có trả về 200.

Cấu hình trên GitHub (Settings → Secrets and variables → Actions):

- **Secrets:** `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.
- **Variables:** `DEPLOY_ENABLED=true`, `DEPLOY_PATH=~/cst-site`, `SITE_URL`.

Muốn tạm dừng deploy tự động thì đặt `DEPLOY_ENABLED=false`.

### Khi có tên miền

1. Trỏ bản ghi A của tên miền (và `www` nếu dùng) về `103.159.52.49`.
2. Trên VPS, sửa `/home/deploy/cst-site/.env`:
   - `DOMAIN=<tên miền>`
   - `CADDYFILE=Caddyfile`
3. Chạy `docker compose up -d` trong thư mục đó. Caddy tự lấy chứng chỉ HTTPS và trang admin mở ở `https://<tên miền>/admin/`.
4. Trên GitHub, đổi biến `SITE_URL` thành `https://<tên miền>/`.

### Lưu ý về nội dung

- Khi admin trên VPS đã mở, nội dung sửa qua admin nằm trên VPS (ổ dữ liệu `cst-site_cst-data`).
- Bản sửa bằng admin trên máy tính chỉ lên VPS qua commit và push. Nếu trang trên VPS đã bị sửa qua admin, bản mới được cất vào **Bản lưu** để chọn Khôi phục (xem mục "Dữ liệu nằm ở đâu").
- Nên chọn một nơi sửa chính để tránh hai bản khác nhau.
