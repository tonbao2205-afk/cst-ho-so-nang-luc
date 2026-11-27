"""Kiểm thử nhanh (chỉ thư viện chuẩn) — chạy trong CI và trên máy: python tests/smoke_test.py

1. docker/seed.py: chép trang sang thư mục dữ liệu; lần sau giữ phần admin đã sửa, cập nhật phần chưa sửa.
2. admin/server.py: phục vụ trang, chặn tệp nội bộ, tạo tài khoản từ biến môi trường, đăng nhập, lưu trang, bản lưu.
Có tham số --url thì chỉ kiểm máy chủ đang chạy sẵn (vd. container Docker): python tests/smoke_test.py --url http://127.0.0.1:8080
"""
import http.cookiejar, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILS = []


def check(cond, msg):
    print(("  OK   " if cond else "  LỖI  ") + msg)
    if not cond:
        FAILS.append(msg)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(self, path, data=None, headers=None, method=None):
        body = json.dumps(data).encode() if data is not None else None
        h = {"Content-Type": "application/json"} if body else {}
        h.update(headers or {})
        r = urllib.request.Request(self.base + path, data=body, headers=h, method=method)
        try:
            with self.opener.open(r, timeout=30) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def api(self, path, data=None):
        st, raw, _ = self.req("/api/" + path, data, {"X-CST-Admin": "1"} if data is not None else None)
        try:
            return st, json.loads(raw or b"{}")
        except ValueError:
            return st, {}


def wait_up(base, secs=20):
    for _ in range(secs * 10):
        try:
            urllib.request.urlopen(base + "/", timeout=1)
            return True
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    return False


def test_server(base, user=None, password=None):
    print(f"Máy chủ {base}")
    c = Client(base)
    st, raw, hd = c.req("/")
    check(st == 200 and raw.lstrip().lower().startswith(b"<!doctype html"), "trang chủ trả về index.html")
    check("no-cache" in hd.get("Cache-Control", ""), "trang chủ có Cache-Control: no-cache")
    for path in ("/admin/", "/admin/admin.js", "/admin/admin.css"):
        st, _, _ = c.req(path)
        check(st == 200, f"phục vụ {path}")
    for path in ("/admin/data/config.json", "/admin/server.py", "/.git/config", "/.claude/settings.json"):
        st, _, _ = c.req(path)
        check(st == 404, f"chặn {path}")
    st, body = c.api("me")
    check(st == 200 and body.get("setup") is False, "đã có tài khoản admin (không cho tạo qua mạng)")
    st, _, _ = c.req("/api/login", {"username": "x", "password": "x"})
    check(st == 403, "POST thiếu header X-CST-Admin bị chặn")
    st, _ = c.api("setup", {"username": "x", "password": "x"})
    check(st == 403, "không tạo lại mật khẩu được")
    if not user:
        return
    st, _ = c.api("login", {"username": user, "password": password + "-sai"})
    check(st == 401, "sai mật khẩu bị từ chối")
    st, _ = c.api("login", {"username": user, "password": password})
    check(st == 200, "đăng nhập đúng")
    st, page = c.api("page")
    check(st == 200 and "<!doctype html" in page.get("html", "").lower(), "đọc trang qua API")
    st, saved = c.api("page", {"html": page["html"], "mtime": page["mtime"]})
    check(st == 200 and saved.get("ok"), "lưu trang qua API")
    st, bk = c.api("backups")
    check(st == 200 and any(b["name"] == saved.get("backup") for b in bk.get("backups", [])), "bản lưu được tạo")
    st, _ = c.api("page", {"html": "<p>hỏng</p>", "mtime": saved.get("mtime")})
    check(st == 400, "từ chối nội dung trang không hợp lệ")


def test_seed(tmp):
    print("Chép trang (docker/seed.py)")
    seed = os.path.join(tmp, "seed")
    os.makedirs(os.path.join(seed, "img"))
    os.makedirs(os.path.join(seed, "admin"))
    for rel, text in {"index.html": "<!doctype html>v1", "img/a.txt": "a1", "img/b.txt": "b1", "admin/admin.js": "js1"}.items():
        with open(os.path.join(seed, rel), "w", encoding="utf-8") as f:
            f.write(text)
    site, data = os.path.join(tmp, "s-site"), os.path.join(tmp, "s-data")
    run = lambda: subprocess.run([sys.executable, os.path.join(ROOT, "docker", "seed.py"), seed, site, data], check=True, capture_output=True)
    read = lambda *p: open(os.path.join(*p), encoding="utf-8").read()
    run()
    check(read(site, "index.html") == "<!doctype html>v1" and read(site, "img", "a.txt") == "a1", "lần đầu: chép đủ trang")
    # admin sửa index.html và a.txt; mã nguồn đổi index.html, a.txt, b.txt, admin.js
    with open(os.path.join(site, "index.html"), "w", encoding="utf-8") as f:
        f.write("<!doctype html>admin")
    with open(os.path.join(site, "img", "a.txt"), "w", encoding="utf-8") as f:
        f.write("a-admin")
    for rel, text in {"index.html": "<!doctype html>v2", "img/a.txt": "a2", "img/b.txt": "b2", "admin/admin.js": "js2"}.items():
        with open(os.path.join(seed, rel), "w", encoding="utf-8") as f:
            f.write(text)
    run()
    check(read(site, "index.html") == "<!doctype html>admin", "giữ index.html admin đã sửa")
    check(read(site, "img", "a.txt") == "a-admin", "giữ tệp admin đã sửa")
    check(read(site, "img", "b.txt") == "b2", "cập nhật tệp admin chưa sửa")
    check(read(site, "admin", "admin.js") == "js2", "mã admin luôn theo bản mới")
    offered = [f for f in os.listdir(os.path.join(data, "backups")) if f.endswith("-ban-moi-tu-ma-nguon.html")]
    check(len(offered) == 1 and read(data, "backups", offered[0]) == "<!doctype html>v2", "bản index.html mới được cất vào Bản lưu")
    run()
    offered = [f for f in os.listdir(os.path.join(data, "backups")) if f.endswith("-ban-moi-tu-ma-nguon.html")]
    check(len(offered) == 1, "không cất trùng bản mới ở lần khởi động sau")


def main():
    if "--url" in sys.argv:
        url = sys.argv[sys.argv.index("--url") + 1]
        user = os.environ.get("CST_ADMIN_USER")
        test_server(url, user, os.environ.get("CST_ADMIN_PASSWORD") if user else None)
    else:
        tmp = tempfile.mkdtemp(prefix="cst-smoke-")
        try:
            test_seed(tmp)
            site, data = os.path.join(tmp, "site"), os.path.join(tmp, "data")
            subprocess.run([sys.executable, os.path.join(ROOT, "docker", "seed.py"), ROOT, site, data], check=True)
            port = free_port()
            env = dict(os.environ, CST_ADMIN_USER="ci", CST_ADMIN_PASSWORD="ci-" + os.urandom(6).hex(), PYTHONIOENCODING="utf-8")
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "admin", "server.py"), "--port", str(port),
                                     "--root", site, "--data", data], env=env)
            try:
                base = f"http://127.0.0.1:{port}"
                check(wait_up(base), "máy chủ khởi động")
                test_server(base, env["CST_ADMIN_USER"], env["CST_ADMIN_PASSWORD"])
            finally:
                proc.terminate()
                proc.wait(10)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'KẾT QUẢ: OK' if not FAILS else f'KẾT QUẢ: {len(FAILS)} LỖI'}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    main()
