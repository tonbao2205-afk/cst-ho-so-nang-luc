---
name: check-ui
description: Kiểm tra giao diện trang CST.,JSC trên cả máy tính và điện thoại (chụp ảnh từng công trình, bảng ảnh, cảnh kết, mục hồ sơ, mục lục điện thoại) và đo lỗi bố cục tự động. Dùng sau mỗi thay đổi giao diện, hoặc khi người dùng nói "check giao diện", "kiểm tra máy tính và điện thoại".
---

# Kiểm tra giao diện máy tính + điện thoại

1. Đảm bảo máy chủ đang chạy ở `http://localhost:8080` (nếu không: chạy nền `python -m http.server 8080` trong thư mục dự án).
2. Chạy (mất ~3–5 phút; `--quick` ~1–2 phút):
   ```
   python -I .claude/skills/check-ui/check_ui.py            # 4 khổ: 1366x768, 1024x640, 390x844, 375x667
   python -I .claude/skills/check-ui/check_ui.py --quick    # 1366x768 + 390x844
   python -I .claude/skills/check-ui/check_ui.py --only phone-390x844
   ```
3. Đọc phần tóm tắt in ra (✗ = lỗi tự phát hiện: tràn ngang, khung chữ bị cắt/chui dưới header, chấm tứ giác đè khung, chữ bị ẩn, lỗi console).
4. **Luôn xem ảnh** trong `.claude/ui-check/` (Read từng file PNG cần thiết) — đo tự động không thấy được ảnh 3D xấu, chữ đè ảnh, khoảng trống lạ. So với yêu cầu của người dùng.
5. Báo ngắn: khổ nào OK, khổ nào lỗi gì (kèm tên ảnh).

Ghi chú: trình duyệt headless vẽ 3D bằng phần mềm (~6 khung hình/giây) nên script chờ lâu sau mỗi thao tác; nếu ảnh chụp đúng lúc đang chuyển động, chạy lại khổ đó với `--only`.
