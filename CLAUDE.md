# Trang hồ sơ năng lực CST.,JSC

- Toàn bộ trang nằm trong `index.html` (Three.js ở `_vendor/`, ảnh ở `img/`, giấy tờ PDF + zip ở `giay-to/`). Chạy: `python admin/server.py` (hoặc bấm đúp `Mo trang admin.bat`) → trang `http://localhost:8080`, admin `http://localhost:8080/admin/`. Cổng bận thì tự chuyển 8081…
- Trả lời người dùng **ngắn, tiếng Việt**, chỉ nói đã làm gì + kết quả. Không giải thích dài.

## Quy trình bắt buộc khi sửa giao diện
1. Sửa code.
2. Gọi subagent **`ui-verifier`** (Agent tool, `subagent_type: "ui-verifier"`), đưa nguyên văn yêu cầu của người dùng + tóm tắt thay đổi. Subagent chạy skill `check-ui` (máy tính + điện thoại), xem ảnh và trả ĐẠT / CHƯA ĐẠT.
3. CHƯA ĐẠT → sửa tiếp và gọi lại `ui-verifier`. Chỉ báo người dùng "xong" khi ĐẠT.
4. Tự kiểm nhanh: `python -I .claude/skills/check-ui/check_ui.py --quick` (ảnh trong `.claude/ui-check/`).

## Trang admin (`admin/`)
- `admin/server.py`: máy chủ (chỉ thư viện chuẩn), phục vụ trang + API admin; một mật khẩu, lưu băm trong `admin/data/config.json`; mỗi lần lưu cất bản cũ vào `admin/data/backups/`. `admin/data/` không bao giờ được phục vụ ra ngoài.
- `admin/admin.js`: tải `index.html`, tắt script, sửa trực tiếp trong iframe. Khi lưu chỉ thay đúng đoạn mã của phần đã đổi (mỗi phần tử gắn `data-admin-id` theo thứ tự trong mã gốc; bản sao mang `data-admin-from`), phần còn lại giữ nguyên từng ký tự; nếu kiểm tra không khớp mới ghi lại cả trang. Trình sửa chỉ cho: sửa chữ, thêm/xóa/đổi thứ tự dòng–thẻ–hàng, thay ảnh, thay tệp PDF (không còn sửa mã HTML).
- Số tự tính (`syncAuto` trong admin.js, chạy sau mỗi thao tác và khi lưu): phần tử `data-auto="…"` (số công trình, số di tích, tổng giá trị, khoảng năm, số công trình 3D, "Công trình số N / 40" qua `data-ref` = id hàng bảng, số năm hoạt động từ `[data-founded]`), STT mọi bảng có cột "STT", cột doanh thu. Số năm (`so-nam`, `nam-gan`) còn được trang tự tính theo năm hiện tại (script cuối index.html). Thêm số phụ thuộc mới thì gắn `data-auto` + thêm vào `syncAuto`.
- Khi lưu, admin tự dựng lại `#featured-data` và `ol.captions` từ các `figure` trong `.chapter-step .gallery` (ảnh phải là `img/….jpg`), và máy chủ dựng lại `giay-to/CST-JSC-ho-so-phap-ly.zip` từ các nút `.cert__btn`. Sửa cấu trúc các phần này thì cập nhật cả `admin.js` / `server.py`.
- Người dùng có thể sửa `index.html` qua admin bất cứ lúc nào: đọc lại file trước khi sửa.

## Docker / CI (chi tiết: `DEPLOY.md`)
- `Dockerfile` + `docker/entrypoint.sh` + `docker/seed.py`: container chạy `server.py --lan --root /data/site --data /data/admin`; khi khởi động seed.py chép trang từ image sang volume (mã admin luôn đè; nội dung admin đã sửa thì giữ, `index.html` mới cất vào Bản lưu). Thêm thư mục nội dung mới thì cập nhật `CONTENT_DIRS` trong seed.py + `COPY` trong Dockerfile.
- Biến môi trường server: `CST_ADMIN_USER`/`CST_ADMIN_PASSWORD` (tạo tài khoản lần đầu), `CST_COOKIE_SECURE=1` (sau HTTPS).
- Web tĩnh: job `pages` trong ci.yml đăng `index.html` + `img/` + `giay-to/` lên https://tonbao2205-afk.github.io/cst-ho-so-nang-luc/ mỗi lần push `main` (không có admin; đường dẫn trong trang phải tương đối).
- `docker-compose.yml` (app + Caddy HTTPS), `docker-compose.local.yml` (chạy thử cổng 8080). CI: `.github/workflows/ci.yml` (test → build/chạy thử image → đẩy ghcr.io; job deploy tắt tới khi đặt biến `DEPLOY_ENABLED=true`).
- Sửa `server.py` / `seed.py` thì chạy `python tests/smoke_test.py` (phải "KẾT QUẢ: OK").
