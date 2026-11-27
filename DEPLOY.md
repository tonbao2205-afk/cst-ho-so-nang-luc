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

## Khi có máy chủ

Cần VPS Linux có Docker và tên miền đã trỏ bản ghi A về IP máy chủ.

1. Trên máy chủ, tạo thư mục `~/cst-site` và chép vào đó 3 tệp: `docker-compose.yml`, `Caddyfile`, `.env.example`.
2. Đổi tên `.env.example` thành `.env` rồi điền `DOMAIN`, `IMAGE`, `CST_ADMIN_USER` và `CST_ADMIN_PASSWORD`. Dùng **mật khẩu mạnh**, vì admin mở ra Internet; mật khẩu "1" đang dùng trên máy là không được.
3. Nếu image riêng tư, đăng nhập trước: `docker login ghcr.io` (dùng token có quyền `read:packages`).
4. Chạy `docker compose up -d`. Trang ở `https://<tên miền>`, admin ở `https://<tên miền>/admin/`.

Muốn đưa nội dung đã sửa trên máy hiện tại lên máy chủ: sau lần chạy đầu, vào admin → Bản lưu, hoặc chép `index.html` vào ổ dữ liệu.

### Bật deploy tự động từ GitHub

Vào repo → Settings → Secrets and variables → Actions.

- **Variables**:
  - `DEPLOY_ENABLED` = `true`
  - (tùy chọn) `DEPLOY_PATH` = `~/cst-site`
- **Secrets**:
  - `DEPLOY_HOST`: IP hoặc tên máy chủ
  - `DEPLOY_USER`: người dùng SSH
  - `DEPLOY_SSH_KEY`: khóa SSH riêng
  - (tùy chọn) `DEPLOY_PORT`
  - `GHCR_READ_USER` và `GHCR_READ_TOKEN`: chỉ cần khi image riêng tư

Từ đó mỗi lần push lên `main`, sau khi kiểm thử đạt, GitHub SSH vào máy chủ, kéo image mới và khởi động lại.
