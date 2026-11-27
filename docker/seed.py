"""Chép trang từ image Docker sang ổ dữ liệu (volume) mỗi lần container khởi động.

Trên máy chủ thật, admin sửa trang ngay trong volume (/data/site) nên volume là bản chính của NỘI DUNG.
Image mới (sau mỗi lần deploy) mang bản mới của MÃ. Quy tắc:

- Mã trang admin (admin/index.html, admin.js, admin.css): luôn chép đè bằng bản trong image.
- Nội dung (index.html, img/, giay-to/):
    * tệp chưa có trong volume → chép vào;
    * tệp trong volume chưa bị admin sửa kể từ lần chép trước (cùng mã băm với lần chép trước) → cập nhật theo image;
    * tệp đã bị admin sửa → giữ nguyên, KHÔNG ghi đè. Riêng index.html: bản mới trong image được cất vào
      "Bản lưu" của admin (tên ...-ban-moi-tu-ma-nguon.html) để chọn Khôi phục nếu muốn dùng bản mới.
- Không bao giờ xóa tệp trong volume.

Chạy: python seed.py <thư mục trang trong image> <thư mục trang trong volume> <thư mục dữ liệu admin>
"""
import hashlib, json, os, shutil, sys
from datetime import datetime

CODE = ["admin/index.html", "admin/admin.js", "admin/admin.css"]
CONTENT_FILES = ["index.html"]
CONTENT_DIRS = ["img", "giay-to"]
MANIFEST = ".seed-manifest.json"  # mã băm các tệp đã chép từ image ở lần trước


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".seed-tmp"
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def main(seed, site, data):
    os.makedirs(site, exist_ok=True)
    man_path = os.path.join(data, MANIFEST)
    try:
        with open(man_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (FileNotFoundError, ValueError):
        manifest = {}

    for rel in CODE:
        src = os.path.join(seed, rel)
        if os.path.isfile(src):
            copy(src, os.path.join(site, rel))

    rels = list(CONTENT_FILES)
    for d in CONTENT_DIRS:
        for dirpath, _, files in os.walk(os.path.join(seed, d)):
            for name in files:
                rels.append(os.path.relpath(os.path.join(dirpath, name), seed).replace(os.sep, "/"))

    added = updated = kept = 0
    for rel in rels:
        src = os.path.join(seed, rel)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(site, *rel.split("/"))
        new = digest(src)
        if not os.path.exists(dst):
            copy(src, dst)
            manifest[rel] = new
            added += 1
            continue
        cur = digest(dst)
        if cur == new:
            manifest[rel] = new
            continue
        if manifest.get(rel) == cur:  # admin chưa sửa tệp này → theo bản mới trong image
            copy(src, dst)
            manifest[rel] = new
            updated += 1
            continue
        kept += 1
        if rel == "index.html" and manifest.get("index.html#offered") != new:
            backups = os.path.join(data, "backups")
            os.makedirs(backups, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            shutil.copy2(src, os.path.join(backups, f"index-{stamp}-ban-moi-tu-ma-nguon.html"))
            manifest["index.html#offered"] = new
            print("index.html trên máy chủ đã được sửa qua admin nên được giữ nguyên. Bản mới từ mã nguồn "
                  "nằm trong admin > Bản lưu (…-ban-moi-tu-ma-nguon.html).", flush=True)

    os.makedirs(data, exist_ok=True)
    tmp = man_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=0)
    os.replace(tmp, man_path)
    print(f"Chép trang: {added} tệp mới, {updated} tệp cập nhật, {kept} tệp giữ bản đã sửa trên máy chủ.", flush=True)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
