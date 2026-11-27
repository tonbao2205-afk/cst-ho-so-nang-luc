"""Máy chủ trang CST.,JSC kèm trang quản trị (admin).

Chạy:   python admin/server.py            → trang:  http://localhost:8080/
                                            admin:  http://localhost:8080/admin/
        python admin/server.py --lan      → cho máy khác cùng mạng LAN vào được (cẩn thận mật khẩu)
        python admin/server.py --port 8090

Chạy trong Docker (xem DEPLOY.md): --lan --root /data/site --data /data/admin, sau proxy HTTPS (Caddy).
Biến môi trường:
  CST_ADMIN_USER / CST_ADMIN_PASSWORD  tạo tài khoản admin lần đầu khi chưa có (máy chủ không cho tạo qua mạng)
  CST_COOKIE_SECURE=1                  cookie đăng nhập chỉ gửi qua HTTPS (bật khi chạy sau proxy HTTPS)

Chỉ dùng thư viện chuẩn của Python. Dữ liệu admin (mật khẩu, bản lưu) nằm trong admin/data/ và không bao giờ được phục vụ ra ngoài.
"""
import argparse, hashlib, hmac, html, json, os, re, secrets, shutil, socket, sys, threading, time, unicodedata, webbrowser, zipfile
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "admin", "data")
BACKUPS = os.path.join(DATA, "backups")
CONFIG = os.path.join(DATA, "config.json")
PAGE = os.path.join(ROOT, "index.html")
COOKIE = "cst_admin"
COOKIE_FLAGS = "Path=/; HttpOnly; SameSite=Strict" + ("; Secure" if os.environ.get("CST_COOKIE_SECURE") == "1" else "")
SESSION_TTL = 12 * 3600
MAX_UPLOAD = 40 * 1024 * 1024
MAX_PAGE = 8 * 1024 * 1024
KEEP_BACKUPS = 60

# Thư mục được phép tải lên và đuôi tệp tương ứng.
UPLOAD_DIRS = {
    "img/uploads": {".jpg", ".jpeg", ".png", ".webp"},
    "img/giay-to": {".jpg", ".jpeg", ".png", ".webp"},
    "giay-to": {".pdf", ".zip", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".xls", ".xlsx"},
}
# Không bao giờ phục vụ các đường dẫn này ra ngoài.
BLOCKED = ("/admin/data", "/admin/server.py", "/.claude", "/sentry", "/.git")

LOCK = threading.Lock()
SESSIONS = {}  # token -> hạn
FAILS = {"n": 0, "until": 0.0}


# ---------------- mật khẩu ----------------
def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def hash_pw(password, salt=None, iterations=310_000):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations).hex()
    return {"salt": salt, "hash": digest, "iterations": iterations}


def save_password(password, username=None):
    os.makedirs(DATA, exist_ok=True)
    cfg = load_config() or {}
    cfg.update(hash_pw(password))
    if username is not None:
        cfg["username"] = username
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    os.replace(tmp, CONFIG)


def check_password(password, username=None):
    cfg = load_config()
    if not cfg:
        return False
    if username is not None and cfg.get("username") and username.strip().lower() != cfg["username"].lower():
        hash_pw(password, cfg["salt"], cfg["iterations"])  # giữ thời gian xử lý như nhau
        return False
    test = hash_pw(password, cfg["salt"], cfg["iterations"])["hash"]
    return hmac.compare_digest(test, cfg["hash"])


# ---------------- tiện ích ----------------
def slugify(name):
    name = name.replace("đ", "d").replace("Đ", "D")
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-._").lower()
    return re.sub(r"-{2,}", "-", name) or "tep"


def backup_page(reason):
    os.makedirs(BACKUPS, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    name = f"index-{stamp}-{slugify(reason)[:20]}.html"
    shutil.copy2(PAGE, os.path.join(BACKUPS, name))
    files = sorted(f for f in os.listdir(BACKUPS) if f.endswith(".html"))
    for old in files[:-KEEP_BACKUPS]:
        os.remove(os.path.join(BACKUPS, old))
    return name


def human_size(n):
    return f"{n / 1024 / 1024:.1f}".replace(".", ",") + " MB" if n >= 1024 * 1024 else f"{max(1, round(n / 1024))} KB"


def rebuild_cert_zip(page_html):
    """Gom các PDF đang gắn ở nút 'Tải PDF' của mục Pháp lý thành tệp zip của nút 'Tải cả bộ giấy tờ'.
    Trả về HTML đã cập nhật dòng mô tả (số tệp, dung lượng)."""
    m = re.search(r'<a[^>]*class="certs-dl__btn"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*class="certs-dl__btn"', page_html)
    if not m:
        return page_html
    zip_rel = unquote(m.group(1) or m.group(2)).lstrip("/")
    if not zip_rel.startswith("giay-to/") or not zip_rel.endswith(".zip"):
        return page_html
    items = []
    for art in re.findall(r'<article class="cert"[^>]*>(.*?)</article>', page_html, re.S):
        a = re.search(r'<a[^>]*class="cert__btn"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*class="cert__btn"', art)
        h = re.search(r"<h3[^>]*>(.*?)</h3>", art, re.S)
        if not a:
            continue
        rel = unquote(a.group(1) or a.group(2)).lstrip("/")
        path = os.path.normpath(os.path.join(ROOT, rel))
        if not path.startswith(ROOT) or not os.path.isfile(path):
            continue
        title = html.unescape(re.sub(r"<[^>]+>", "", h.group(1))) if h else os.path.basename(rel)
        items.append((path, title))
    if not items:
        return page_html
    zip_path = os.path.join(ROOT, zip_rel)
    os.makedirs(os.path.dirname(zip_path), exist_ok=True)
    tmp = zip_path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for i, (path, title) in enumerate(items, 1):
            ext = os.path.splitext(path)[1]
            z.write(path, f"{i} - {slugify(title)[:80]}{ext}")
    os.replace(tmp, zip_path)
    size = human_size(os.path.getsize(zip_path))
    return re.sub(r'(<div class="certs-dl">.*?<p>)(.*?)(</p>)',
                  lambda mm: f"{mm.group(1)}{len(items)} bản giấy tờ gốc trong một tệp .zip (khoảng {size}){mm.group(3)}",
                  page_html, count=1, flags=re.S)


# ---------------- máy chủ ----------------
class Handler(SimpleHTTPRequestHandler):
    server_version = "CST-Admin/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        if self.path.startswith("/admin") or self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "SAMEORIGIN")
        elif self.path.split("?")[0].endswith((".html", "/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ----- tĩnh -----
    def blocked(self):
        p = unquote(urlparse(self.path).path)
        return any(p == b or p.startswith(b + "/") for b in BLOCKED) or "/." in p

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.api("GET")
        if self.blocked():
            return self.send_error(HTTPStatus.NOT_FOUND)
        if urlparse(self.path).path == "/admin":
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", "/admin/")
            return self.end_headers()
        return super().do_GET()

    def do_HEAD(self):
        if self.blocked():
            return self.send_error(HTTPStatus.NOT_FOUND)
        return super().do_HEAD()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.api("POST")
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    # ----- api -----
    def send_json(self, data, status=200, cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return None

    def authed(self):
        t = self.token()
        with LOCK:
            exp = SESSIONS.get(t or "")
            if exp and exp > time.time():
                SESSIONS[t] = time.time() + SESSION_TTL
                return True
        return False

    def read_body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("Tệp quá lớn (tối đa %d MB)." % (limit // 1024 // 1024))
        return self.rfile.read(n)

    def read_json(self):
        return json.loads(self.read_body(MAX_PAGE + 1024 * 1024) or b"{}")

    def api(self, method):
        route = urlparse(self.path).path[len("/api/"):]
        try:
            # Chặn gửi yêu cầu giả từ trang khác: mọi POST phải có header riêng của admin.
            if method == "POST" and self.headers.get("X-CST-Admin") != "1":
                return self.send_json({"error": "Yêu cầu không hợp lệ."}, 403)
            public = {("GET", "me"), ("POST", "login"), ("POST", "setup")}
            if (method, route) not in public and not self.authed():
                return self.send_json({"error": "Cần đăng nhập."}, 401)
            fn = getattr(self, f"api_{method.lower()}_{route.replace('-', '_')}", None)
            if not fn:
                return self.send_json({"error": "Không có chức năng này."}, 404)
            return fn()
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"Lỗi API {route}: {e!r}\n")
            return self.send_json({"error": f"Lỗi máy chủ: {e}"}, 500)

    def api_get_me(self):
        authed = self.authed()
        cfg = load_config()
        return self.send_json({"setup": cfg is None, "authed": authed, "user": (cfg or {}).get("username") if authed else None})

    def start_session(self):
        t = secrets.token_urlsafe(32)
        with LOCK:
            now = time.time()
            for k in [k for k, v in SESSIONS.items() if v < now]:
                del SESSIONS[k]
            SESSIONS[t] = now + SESSION_TTL
        return f"{COOKIE}={t}; {COOKIE_FLAGS}; Max-Age={SESSION_TTL}"

    def api_post_setup(self):
        if load_config() is not None:
            return self.send_json({"error": "Đã có mật khẩu."}, 403)
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return self.send_json({"error": "Chỉ tạo mật khẩu lần đầu được trên chính máy chạy trang."}, 403)
        d = self.read_json()
        pw = str(d.get("password", ""))
        user = str(d.get("username", "")).strip()
        if not user:
            raise ValueError("Cần nhập tên tài khoản.")
        if not pw:
            raise ValueError("Cần nhập mật khẩu.")
        save_password(pw, user)
        return self.send_json({"ok": True}, cookie=self.start_session())

    def api_post_login(self):
        if time.time() < FAILS["until"]:
            return self.send_json({"error": "Sai quá nhiều lần, chờ 1 phút rồi thử lại."}, 429)
        d = self.read_json()
        pw = str(d.get("password", ""))
        if not check_password(pw, str(d.get("username", ""))):
            FAILS["n"] += 1
            if FAILS["n"] >= 5:
                FAILS.update(n=0, until=time.time() + 60)
            time.sleep(0.6)
            return self.send_json({"error": "Sai tài khoản hoặc mật khẩu."}, 401)
        FAILS["n"] = 0
        return self.send_json({"ok": True}, cookie=self.start_session())

    def api_post_logout(self):
        with LOCK:
            SESSIONS.pop(self.token() or "", None)
        return self.send_json({"ok": True}, cookie=f"{COOKIE}=; {COOKIE_FLAGS}; Max-Age=0")

    def api_post_password(self):
        d = self.read_json()
        if not check_password(str(d.get("current", ""))):
            raise ValueError("Mật khẩu hiện tại không đúng.")
        new = str(d.get("password", ""))
        if not new:
            raise ValueError("Cần nhập mật khẩu mới.")
        save_password(new)
        with LOCK:
            SESSIONS.clear()
        return self.send_json({"ok": True}, cookie=self.start_session())

    def api_get_page(self):
        with open(PAGE, encoding="utf-8") as f:
            text = f.read()
        return self.send_json({"html": text, "mtime": os.path.getmtime(PAGE)})

    def api_post_page(self):
        d = self.read_json()
        text = d.get("html")
        # Trang gốc không có thẻ </html> (admin chỉ thay đúng phần đã sửa) → chỉ cần mở đầu bằng <!doctype html>.
        if not isinstance(text, str) or len(text) < 2000 or not text.lstrip("﻿ \r\n\t").lower().startswith("<!doctype html"):
            raise ValueError("Nội dung trang không hợp lệ, chưa lưu.")
        if len(text.encode("utf-8")) > MAX_PAGE:
            raise ValueError("Trang quá lớn.")
        with LOCK:
            if d.get("mtime") and abs(os.path.getmtime(PAGE) - float(d["mtime"])) > 0.001 and not d.get("force"):
                return self.send_json({"error": "Trang vừa bị sửa ở nơi khác. Tải lại admin để lấy bản mới nhất, hoặc lưu đè.",
                                       "conflict": True}, 409)
            name = backup_page("truoc-khi-luu")
            text = rebuild_cert_zip(text)
            tmp = PAGE + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as f:
                f.write(text)
            os.replace(tmp, PAGE)
        return self.send_json({"ok": True, "backup": name, "mtime": os.path.getmtime(PAGE), "html": text})

    def api_get_backups(self):
        os.makedirs(BACKUPS, exist_ok=True)
        out = []
        for f in sorted(os.listdir(BACKUPS), reverse=True):
            if f.endswith(".html"):
                p = os.path.join(BACKUPS, f)
                out.append({"name": f, "time": os.path.getmtime(p), "size": os.path.getsize(p)})
        return self.send_json({"backups": out})

    def api_post_restore(self):
        name = os.path.basename(str(self.read_json().get("name", "")))
        src = os.path.join(BACKUPS, name)
        if not name.endswith(".html") or not os.path.isfile(src):
            raise ValueError("Không tìm thấy bản lưu.")
        with LOCK:
            backup_page("truoc-khi-khoi-phuc")
            shutil.copy2(src, PAGE)
            os.utime(PAGE, None)
        return self.send_json({"ok": True})

    def api_get_files(self):
        out = []
        for base in ("img", "giay-to"):
            top = os.path.join(ROOT, base)
            for dirpath, _, files in os.walk(top):
                for f in files:
                    p = os.path.join(dirpath, f)
                    rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
                    out.append({"path": rel, "size": os.path.getsize(p), "time": os.path.getmtime(p)})
        out.sort(key=lambda x: -x["time"])
        return self.send_json({"files": out})

    def api_post_upload(self):
        folder = self.headers.get("X-Folder", "img/uploads")
        if folder not in UPLOAD_DIRS:
            raise ValueError("Thư mục không được phép.")
        raw = unquote(self.headers.get("X-Filename", "tep"))
        stem, ext = os.path.splitext(os.path.basename(raw))
        ext = ext.lower()
        if ext not in UPLOAD_DIRS[folder]:
            raise ValueError(f"Không nhận tệp {ext or '(không đuôi)'} ở thư mục này.")
        data = self.read_body(MAX_UPLOAD)
        if not data:
            raise ValueError("Tệp rỗng.")
        if ext == ".pdf" and not data.startswith(b"%PDF"):
            raise ValueError("Tệp không phải PDF.")
        name = slugify(stem)[:80] + ext
        dest_dir = os.path.join(ROOT, *folder.split("/"))
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, name)
        i = 2
        while os.path.exists(dest):
            dest = os.path.join(dest_dir, f"{slugify(stem)[:80]}-{i}{ext}")
            i += 1
        with open(dest, "wb") as f:
            f.write(data)
        rel = os.path.relpath(dest, ROOT).replace(os.sep, "/")
        return self.send_json({"ok": True, "path": rel, "size": len(data)})


class Server(ThreadingHTTPServer):
    # Không cho hai máy chủ cùng chiếm một cổng (Windows mặc định cho phép, gây lẫn lộn).
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    for stream in (sys.stdout, sys.stderr):  # cửa sổ lệnh Windows không phải UTF-8
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(description="Máy chủ trang CST.,JSC + admin")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--lan", action="store_true", help="mở cho máy khác trong mạng LAN")
    ap.add_argument("--root", help="thư mục trang (mặc định: thư mục cha của admin/)")
    ap.add_argument("--data", help="thư mục dữ liệu admin (mặc định: admin/data)")
    ap.add_argument("--open", action="store_true", help="tự mở trang admin trong trình duyệt")
    args = ap.parse_args()
    global ROOT, DATA, BACKUPS, CONFIG, PAGE
    if args.root:
        ROOT = os.path.abspath(args.root)
        DATA = os.path.join(ROOT, "admin", "data")
    if args.data:
        DATA = os.path.abspath(args.data)
    BACKUPS = os.path.join(DATA, "backups")
    CONFIG = os.path.join(DATA, "config.json")
    PAGE = os.path.join(ROOT, "index.html")
    # Docker / máy chủ thật: tạo tài khoản admin lần đầu từ biến môi trường (không ai tạo được qua mạng).
    env_user = os.environ.get("CST_ADMIN_USER", "").strip()
    env_pw = os.environ.get("CST_ADMIN_PASSWORD", "")
    if load_config() is None and env_user and env_pw:
        save_password(env_pw, env_user)
        print(f"Đã tạo tài khoản admin \"{env_user}\" từ biến môi trường.")
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    srv = None
    port = args.port
    for port in range(args.port, args.port + 10):
        if port_in_use(port):
            print(f"Cổng {port} đang có chương trình khác dùng, thử cổng {port + 1}…")
            continue
        try:
            srv = Server((host, port), Handler)
            break
        except OSError:
            continue
    if not srv:
        sys.exit("Không tìm được cổng trống để chạy trang.")
    print(f"Trang:  http://localhost:{port}/")
    print(f"Admin:  http://localhost:{port}/admin/")
    if load_config() is None:
        print("Chưa có mật khẩu admin: mở trang admin trên máy này để tạo (Docker: đặt CST_ADMIN_USER + CST_ADMIN_PASSWORD).")
    print("Đóng cửa sổ này (hoặc bấm Ctrl+C) để tắt.")
    if args.open:
        webbrowser.open(f"http://localhost:{port}/admin/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
