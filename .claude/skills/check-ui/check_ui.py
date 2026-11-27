"""Kiểm tra giao diện trang CST.,JSC trên máy tính và điện thoại bằng Edge/Chrome headless.

Chạy:  python -I .claude/skills/check-ui/check_ui.py [--quick] [--url http://localhost:8080/] [--out .claude/ui-check]

Với mỗi khổ màn hình: chụp màn mở đầu, từng công trình trong hành trình, bảng ảnh (mở/chuyển ảnh),
cảnh kết và vài mục hồ sơ; đồng thời đo tự động các lỗi hay gặp. Kết quả: ảnh PNG + report.json + in tóm tắt.
"""
import argparse, asyncio, base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.request

try:
    import websockets
except ImportError:
    sys.exit("Thiếu thư viện websockets: python -m pip install websockets")

VIEWPORTS = [
    # tên, rộng, cao, điện thoại?
    ("desktop-1366x768", 1366, 768, False),
    ("laptop-1024x640", 1024, 640, False),
    ("phone-390x844", 390, 844, True),
    ("phone-375x667", 375, 667, True),
]
QUICK = {"desktop-1366x768", "phone-390x844"}
PORT = 9333

# Đo trong trang: các lỗi bố cục hay gặp ở bước hiện tại.
MEASURE = r"""
(() => {
  const vw = innerWidth, vh = innerHeight, issues = [];
  const r = (el) => el && el.getBoundingClientRect();
  const overlap = (a, b) => a && b && a.width && b.width && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`tràn ngang: scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  const step = document.querySelector('[data-journey] > .step.is-active');
  const box = step && r(step.querySelector('.chapter, .intro, .outro'));
  const header = r(document.querySelector('.site-header'));
  const rail = document.querySelector('[data-journey] > .journey__rail');
  const railRect = rail && getComputedStyle(rail).opacity !== '0' && getComputedStyle(rail).display !== 'none' ? r(rail) : null;
  const inJourney = document.documentElement.classList.contains('in-journey') || (step && scrollY < 50);
  if (step && step.classList.contains('chapter-step') && Math.abs(step.getBoundingClientRect().top) > 3)
    issues.push(`cuộn dừng lệch bước công trình ${Math.round(step.getBoundingClientRect().top)}px (ảnh/khung chữ bị xô)`);
  if (box && inJourney) {
    if (box.bottom > vh + 1) issues.push(`khung chữ bị cắt ở đáy: bottom ${Math.round(box.bottom)} > ${vh}`);
    if (header && box.top < header.bottom - 1 && step.classList.contains('chapter-step')) issues.push(`khung chữ chui dưới thanh đầu trang: top ${Math.round(box.top)}`);
    if (overlap(box, railRect)) issues.push('thanh chấm tứ giác đè lên khung chữ');
    if (header && overlap(header, railRect)) issues.push('thanh chấm tứ giác bị thanh đầu trang che');
    // Điện thoại: ảnh công trình đang xem (đo từ 3D) phải nằm giữa thanh đầu trang và khung chữ, không chạm chấm.
    const p = vw <= 760 && step.classList.contains('chapter-step') && !document.documentElement.classList.contains('gallery-open') && window.cstPhotoRect && window.cstPhotoRect();
    if (p) {
      if (header && p.top < header.bottom + 6) issues.push(`ảnh sát/chui thanh đầu trang: mép trên ảnh ${Math.round(p.top)}, header ${Math.round(header.bottom)}`);
      if (p.bottom > box.top - 4) issues.push(`ảnh đè khung chữ: đáy ảnh ${Math.round(p.bottom)}, khung ${Math.round(box.top)}`);
      if (box.top - p.bottom > Math.max(40, vh * 0.06)) issues.push(`khoảng trống thừa giữa ảnh và khung chữ: ${Math.round(box.top - p.bottom)}px`);
      if (railRect && p.right > railRect.left - 2 && p.bottom > railRect.top && p.top < railRect.bottom) issues.push(`chấm tứ giác chạm ảnh: mép phải ảnh ${Math.round(p.right)}, chấm ${Math.round(railRect.left)}`);
      if (p.left < 4) issues.push(`ảnh sát mép trái: ${Math.round(p.left)}`);
      if (Math.abs((p.left + p.right) / 2 - vw / 2) > 6) issues.push(`ảnh không căn giữa ngang: tâm ${Math.round((p.left + p.right) / 2)}, giữa màn ${Math.round(vw / 2)}`);
    }
  }
  const g = document.getElementById('gallery3d');
  if (g && !g.hidden) {
    const card = r(g.querySelector('.gallery3d__card'));
    if (card && card.bottom > vh + 1) issues.push(`bảng ảnh: khung chữ bị cắt ở đáy (${Math.round(card.bottom)} > ${vh})`);
    const gr = g.querySelector('.gallery3d__rail');
    if (gr && !gr.hidden && overlap(card, r(gr))) issues.push('bảng ảnh: chấm đè lên khung chữ');
    // Điện thoại: khe [nút đóng → ảnh], [ảnh → chấm đếm], [chấm → khung chữ] phải gần bằng nhau, không khe nào thừa.
    const gp = vw <= 760 && window.cstGalleryPhotoRect && window.cstGalleryPhotoRect();
    if (gp && gr && !gr.hidden && card) {
      const close = r(g.querySelector('.gallery3d__close'));
      const rr = r(gr);
      const gaps = [gp.top - close.bottom, rr.top - gp.bottom, card.top - rr.bottom].map(Math.round);
      if (Math.min(...gaps) < 6) issues.push(`bảng ảnh: thành phần sát/đè nhau, khe ${gaps.join('/')}px`);
      if (Math.max(...gaps) - Math.min(...gaps) > 24) issues.push(`bảng ảnh: khoảng cách không đều (nút đóng→ảnh / ảnh→chấm / chấm→khung) ${gaps.join('/')}px`);
      if (Math.abs((gp.left + gp.right) / 2 - vw / 2) > 6) issues.push('bảng ảnh: ảnh không căn giữa ngang');
      if (Math.abs((rr.left + rr.right) / 2 - vw / 2) > 6) issues.push('bảng ảnh: chấm đếm không căn giữa');
    }
  }
  const hidden = [...document.querySelectorAll('[data-journey] > .step.is-active > .wrap > *')].some((el) => getComputedStyle(el).opacity === '0');
  if (hidden) issues.push('chữ của bước đang xem bị ẩn (opacity 0)');
  return {y: Math.round(scrollY), vw, vh, active: [...document.querySelectorAll('[data-journey] > .step')].findIndex((s) => s.classList.contains('is-active')),
    box: box && {top: Math.round(box.top), bottom: Math.round(box.bottom)},
    photo: window.cstPhotoRect && step && step.classList.contains('chapter-step') ? (({left, right, top, bottom}) => ({left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: Math.round(bottom)}))(window.cstPhotoRect()) : null, issues};
})()
"""


def find_browser():
    cands = [
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
    ]
    for c in cands:
        if c and os.path.exists(c):
            return c
    for name in ("msedge", "google-chrome", "chromium", "chrome"):
        if shutil.which(name):
            return shutil.which(name)
    sys.exit("Không tìm thấy Edge hoặc Chrome.")


async def run_viewport(browser, url, out, name, w, h, mobile):
    profile = tempfile.mkdtemp(prefix="checkui-")
    proc = subprocess.Popen([browser, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
                             "--no-first-run", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
                             "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
                             "--disable-background-timer-throttling", f"--window-size={w},{h}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = {"viewport": name, "shots": [], "steps": [], "console_errors": []}
    try:
        page = None
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                page = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.25)
        if not page:
            raise RuntimeError("không kết nối được trình duyệt headless")
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=80_000_000) as ws:
            n = 0

            async def call(method, **params):
                nonlocal n
                n += 1
                my = n
                await ws.send(json.dumps({"id": my, "method": method, "params": params}))
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 240))
                    m = msg.get("method")
                    if m == "Runtime.exceptionThrown":
                        d = msg["params"]["exceptionDetails"]
                        result["console_errors"].append((d.get("exception", {}).get("description") or d.get("text", ""))[:300])
                    elif m == "Runtime.consoleAPICalled" and msg["params"]["type"] == "error":
                        result["console_errors"].append(" ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"]["args"])[:300])
                    if msg.get("id") == my:
                        return msg

            async def js(expr):
                r = await call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
                return r.get("result", {}).get("result", {}).get("value")

            async def shot(label):
                r = await call("Page.captureScreenshot", format="png")
                path = os.path.join(out, f"{name}--{label}.png")
                with open(path, "wb") as f:
                    f.write(base64.b64decode(r["result"]["data"]))
                result["shots"].append(path)
                m = await js(MEASURE)
                result["steps"].append({"label": label, "shot": path, **(m or {})})

            await call("Runtime.enable")
            await call("Page.enable")
            await call("Page.bringToFront")
            await call("Emulation.setFocusEmulationEnabled", enabled=True)
            await call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=2 if mobile else 1, mobile=mobile)
            if mobile:
                await call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
                await call("Emulation.setUserAgentOverride", userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
            await call("Page.navigate", url=url)
            # Màn trống đồng chỉ mở khi cảnh 3D đã tải xong: chờ nó mở hẳn (tối đa 30s), rồi chờ hoạt cảnh tách đôi xong.
            await asyncio.sleep(2)
            for _ in range(56):
                if not await js("document.documentElement.classList.contains('opening-on')"):
                    break
                await asyncio.sleep(0.5)
            result["opening_still_on"] = bool(await js("document.documentElement.classList.contains('opening-on')"))
            await asyncio.sleep(2.5)
            has3d = await js("document.documentElement.classList.contains('has-3d')")
            result["has3d"] = has3d
            await shot("00-mo-dau")
            if result["opening_still_on"]:
                result["steps"][-1].setdefault("issues", []).append("màn trống đồng không mở sau 30s (cảnh 3D không báo sẵn sàng)")
            if mobile:
                # Lần cuộn đầu trên Safari: thanh địa chỉ thu lại giữa chừng → màn hình cao thêm ~56px.
                await js("window.dispatchEvent(new WheelEvent('wheel', {deltaY: 100, cancelable: true, bubbles: true}))")
                await asyncio.sleep(0.3)
                await call("Emulation.setDeviceMetricsOverride", width=w, height=h + 56, deviceScaleFactor=2, mobile=True)
                await asyncio.sleep(6)
                await shot("00b-luot-dau-thanh-dia-chi")
                await call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=2, mobile=True)
                await asyncio.sleep(3)
            count = await js("document.querySelectorAll('[data-journey] > .journey__rail button').length") or 0
            for i in range(count):
                await js(f"document.querySelectorAll('[data-journey] > .journey__rail button')[{i}].click()")
                await asyncio.sleep(4.5)
                await shot(f"{i + 1:02d}-cong-trinh")
            # Bảng ảnh của công trình 1: mở, sang ảnh 2.
            if await js("!!document.querySelector('#ct-1 .photos-btn')"):
                await js("document.querySelectorAll('[data-journey] > .journey__rail button')[0]?.click()")
                await asyncio.sleep(4)
                await js("document.querySelector('#ct-1 .photos-btn').click()")
                await asyncio.sleep(9)  # chờ ảnh 3D trượt vào đứng yên hẳn (máy ảo chậm)
                await shot("bang-anh-1")
                await js("(document.getElementById('gallery3d') && !document.getElementById('gallery3d').hidden ? document.getElementById('gallery3d') : window).dispatchEvent(new WheelEvent('wheel', {deltaY: 100, cancelable: true, bubbles: true}))")
                await asyncio.sleep(4)
                await shot("bang-anh-2")
                await js("document.querySelector('.gallery3d__close')?.click(); document.getElementById('gallery-pop')?.close?.()")
                await asyncio.sleep(3)
            # Công trình cuối → lăn chuột xuống: trống đồng lăn một lượt rồi dừng đúng ở mục "Giới thiệu chung".
            await js("(() => { const b = [...document.querySelectorAll('[data-journey] > .journey__rail button')]; b[b.length - 1]?.click(); })()")
            await asyncio.sleep(5)
            await js("window.dispatchEvent(new WheelEvent('wheel', {deltaY: 100, cancelable: true, bubbles: true}))")
            await asyncio.sleep(7)
            await shot("sang-ho-so")
            gt = await js("Math.round(document.getElementById('gioi-thieu')?.getBoundingClientRect().top ?? -1)")
            if gt is not None and not (40 <= gt <= 120):
                result["steps"][-1].setdefault("issues", []).append(f"lăn từ công trình cuối không dừng ở mục Giới thiệu chung (top {gt}px)")
            for sec in ("gioi-thieu", "cong-trinh", "lien-he"):
                await js(f"(() => {{ const s = document.getElementById('{sec}'); s.classList.add('is-in'); window.scrollTo({{top: s.getBoundingClientRect().top + scrollY - 70, behavior: 'instant'}}); }})()")
                await asyncio.sleep(1.5)
                await shot(f"muc-{sec}")
            if mobile:
                await js("document.querySelector('.menu-btn')?.click()")
                await asyncio.sleep(1)
                await shot("muc-luc")
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8080/index.html")
    ap.add_argument("--out", default=os.path.join(".claude", "ui-check"))
    ap.add_argument("--quick", action="store_true", help="chỉ 1 khổ máy tính + 1 khổ điện thoại")
    ap.add_argument("--only", help="tên khổ, ví dụ phone-390x844")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        urllib.request.urlopen(args.url, timeout=5)
    except Exception:
        sys.exit(f"Không mở được {args.url}. Chạy máy chủ trước: python -m http.server 8080")
    os.makedirs(args.out, exist_ok=True)
    for f in os.listdir(args.out):
        if f.endswith(".png"):
            os.remove(os.path.join(args.out, f))
    browser = find_browser()
    vps = [v for v in VIEWPORTS if (not args.quick or v[0] in QUICK) and (not args.only or v[0] == args.only)]
    report = []
    for name, w, h, mobile in vps:
        print(f"... {name}", flush=True)
        report.append(asyncio.run(run_viewport(browser, args.url + f"?check={int(time.time())}", args.out, name, w, h, mobile)))
    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    total = 0
    for r in report:
        problems = [(s["label"], i) for s in r["steps"] for i in s.get("issues", [])]
        total += len(problems) + len(r["console_errors"])
        print(f"\n== {r['viewport']} (3D: {r.get('has3d')}) — {len(r['shots'])} ảnh")
        for label, issue in problems:
            print(f"  ✗ {label}: {issue}")
        for e in r["console_errors"]:
            print(f"  ✗ lỗi console: {e}")
        if not problems and not r["console_errors"]:
            print("  ✓ không thấy lỗi tự động")
    print(f"\nẢnh và report.json trong: {os.path.abspath(args.out)}")
    print("KẾT QUẢ:", "OK" if total == 0 else f"{total} vấn đề")


if __name__ == "__main__":
    main()
