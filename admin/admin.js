/* Quản trị nội dung trang CST.,JSC.
   Cách làm: tải mã nguồn index.html, tắt toàn bộ script (để trang hiện bản tĩnh, dễ sửa), hiện trong khung iframe.
   Người dùng bấm vào chữ / ảnh / nút để sửa trực tiếp; thêm, nhân bản, đổi thứ tự, xóa từng mục.
   Khi lưu: bỏ dấu vết của admin, bật lại script, đồng bộ dữ liệu ảnh của hành trình 3D (#featured-data), gửi về máy chủ. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const frame = $('#frame');
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';

  const S = {
    doc: null, sel: null, hover: null, editing: null, editBefore: null,
    undo: [], redo: [], dirty: false, mtime: 0, files: [], saving: false,
  };

  /* ================= tiện ích ================= */
  async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
    const opts = { method, credentials: 'same-origin', headers: { 'X-CST-Admin': '1', ...headers } };
    if (json !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(json);
    } else if (body !== undefined) opts.body = body;
    const r = await fetch(`/api/${path}`, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `Lỗi ${r.status}`), { status: r.status, data: d });
    return d;
  }

  let toastTimer;
  function toast(msg, err = false, ms = 3800) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-err', err);
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
  }

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
    return el;
  }

  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const clip = (t, n = 48) => { t = clean(t); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const isImgPath = (p) => /\.(jpe?g|png|webp|gif)$/i.test(p || '');
  const isDocPath = (p) => /\.(pdf|zip|docx?|xlsx?)$/i.test(p || '');
  const url = (p) => (/^(https?:|mailto:|tel:|#|\/)/.test(p) ? p : `/${p}`);

  function setDirty(v) {
    S.dirty = v;
    const st = $('#status');
    st.textContent = v ? '● Có thay đổi chưa lưu' : (S.savedAt ? `Đã lưu lúc ${S.savedAt}` : 'Chưa có thay đổi');
    st.classList.toggle('is-dirty', v);
    $('#btn-save').disabled = !v || S.saving;
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = $('#pick-file');
      inp.value = '';
      inp.accept = accept || '';
      inp.onchange = () => resolve(inp.files[0] || null);
      inp.click();
    });
  }

  async function busy(msg, fn) {
    document.body.classList.add('busy');
    toast(msg, false, 60000);
    try { return await fn(); } finally { document.body.classList.remove('busy'); }
  }

  /* ================= đăng nhập ================= */
  async function boot() {
    let me;
    try { me = await api('me'); } catch (e) {
      document.body.textContent = 'Không kết nối được máy chủ admin. Hãy chạy: python admin/server.py';
      return;
    }
    if (me.authed) { $('#who').textContent = me.user ? `Đang đăng nhập: ${me.user}` : ''; return startEditor(); }
    showAuth(me.setup);
  }

  function showAuth(setup) {
    $('#app').hidden = true;
    $('#auth').hidden = false;
    $('#auth-title').textContent = setup ? 'Tạo mật khẩu quản trị' : 'Đăng nhập quản trị';
    $('#auth-hint').textContent = setup
      ? 'Lần đầu sử dụng: đặt tên tài khoản và mật khẩu. Hãy ghi nhớ.'
      : 'Nhập tài khoản và mật khẩu để sửa nội dung trang.';
    $('#auth-pw2-wrap').hidden = !setup;
    $('#auth-pw').autocomplete = setup ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = setup ? 'Tạo mật khẩu và vào trang quản trị' : 'Đăng nhập';
    $('#auth-user').focus();
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const pw = $('#auth-pw').value;
      const username = $('#auth-user').value.trim();
      const err = $('#auth-error');
      err.textContent = '';
      try {
        if (setup) {
          if (!username || !pw) throw new Error('Cần nhập tài khoản và mật khẩu.');
          if (pw !== $('#auth-pw2').value) throw new Error('Hai lần nhập mật khẩu không khớp.');
          await api('setup', { method: 'POST', json: { username, password: pw } });
        } else {
          await api('login', { method: 'POST', json: { username, password: pw } });
        }
        $('#auth-pw').value = '';
        $('#auth-pw2').value = '';
        $('#who').textContent = `Đang đăng nhập: ${username}`;
        startEditor();
      } catch (ex) {
        err.textContent = ex.message;
      }
    };
  }

  /* ================= nạp trang vào khung sửa ================= */
  const ID = 'data-admin-id'; // số thứ tự phần tử trong mã gốc, để biết phần nào đã đổi
  const FROM = 'data-admin-from'; // bản sao: sao từ phần tử gốc nào
  const FRAME_CSS = `
    [data-opening]{display:none!important}
    html{scroll-behavior:auto!important}
    [data-admin-hover]{outline:2px dashed rgba(47,111,222,.8)!important;outline-offset:2px!important;cursor:pointer!important}
    [data-admin-sel]{outline:2px solid #2f6fde!important;outline-offset:2px!important}
    [data-admin-ce][contenteditable="true"]{outline:2px solid #2f6fde!important;outline-offset:3px!important;
      background-color:rgba(47,111,222,.10)!important;cursor:text!important;caret-color:#2f6fde}
    img{-webkit-user-drag:none}
    [data-auto],tbody td:first-child:is(.num){text-decoration:underline dotted rgba(47,111,222,.7)!important;text-underline-offset:3px}
  `;

  async function startEditor() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    await loadPage();
    loadFiles();
  }

  async function loadPage(text, keepScroll = false) {
    if (!text) {
      const d = await api('page');
      text = d.html;
      S.mtime = d.mtime;
    }
    const scroll = keepScroll && S.doc ? S.doc.scrollingElement.scrollTop : 0;
    S.orig = text; // mã gốc: khi lưu chỉ thay đúng những phần đã sửa
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('*').forEach((e, i) => e.setAttribute(ID, i));
    doc.querySelectorAll('script').forEach((s) => {
      const t = s.getAttribute('type');
      if (t && /json/i.test(t)) return; // dữ liệu, không chạy
      s.setAttribute('data-admin-type', t === null ? '__none__' : t);
      s.setAttribute('type', 'text/x-admin-off');
    });
    const base = doc.createElement('base');
    base.href = '/';
    base.setAttribute('data-admin', '');
    doc.head.prepend(base);
    const st = doc.createElement('style');
    st.setAttribute('data-admin', '');
    st.textContent = FRAME_CSS;
    doc.head.append(st);

    const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
    frame.srcdoc = `<!doctype html>\n${doc.documentElement.outerHTML}`;
    await loaded;
    S.doc = frame.contentDocument;
    S.sel = S.hover = S.editing = null;
    S.undo = [];
    S.redo = [];
    bindFrame(S.doc);
    syncAuto(S.doc);
    if (scroll) S.doc.scrollingElement.scrollTop = scroll;
    updUndo();
    setDirty(false);
    renderEditPanel();
    fillPageTab();
  }

  /* ================= nhận biết phần tử ================= */
  const NO_TEXT = new Set(['HTML', 'BODY', 'MAIN', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'UL', 'OL', 'DL',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'IMG', 'SVG', 'SCRIPT', 'STYLE', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME',
    'VIDEO', 'FIGURE', 'PICTURE', 'BR', 'HR', 'DIALOG', 'FORM']);
  const INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'SMALL', 'SPAN', 'A', 'SUB', 'SUP', 'MARK', 'U', 'S', 'CODE',
    'ABBR', 'TIME', 'BR', 'Q', 'CITE', 'DATA', 'LABEL', 'WBR']);
  const ALWAYS_REP = new Set(['LI', 'TR', 'ARTICLE', 'FIGURE', 'SECTION', 'DT', 'DD', 'OPTION']);
  const NAMES = {
    SECTION: 'Mục', ARTICLE: 'Khối', LI: 'Dòng', TR: 'Hàng bảng', TD: 'Ô bảng', TH: 'Ô tiêu đề', FIGURE: 'Ảnh kèm chú thích',
    IMG: 'Ảnh', A: 'Nút / liên kết', P: 'Đoạn chữ', H1: 'Tiêu đề lớn', H2: 'Tiêu đề', H3: 'Tiêu đề nhỏ', H4: 'Tiêu đề nhỏ',
    DL: 'Bảng thông tin', DT: 'Nhãn', DD: 'Giá trị', UL: 'Danh sách', OL: 'Danh sách', TABLE: 'Bảng', HEADER: 'Phần đầu',
    FOOTER: 'Chân trang', NAV: 'Mục lục', DIV: 'Khung', SPAN: 'Chữ', B: 'Chữ đậm', STRONG: 'Chữ đậm', EM: 'Chữ nghiêng',
    I: 'Chữ nghiêng', SMALL: 'Chữ nhỏ', BUTTON: 'Nút', FIGCAPTION: 'Chú thích ảnh', MAIN: 'Nội dung', BLOCKQUOTE: 'Trích dẫn',
    LABEL: 'Nhãn', INPUT: 'Ô nhập', SVG: 'Hình vẽ', THEAD: 'Đầu bảng', TBODY: 'Thân bảng', CAPTION: 'Tên bảng',
  };

  const tag = (e) => e.tagName.toUpperCase();

  function label(e) {
    if (e.matches('[data-journey] .chapter-step')) return 'Công trình (hành trình 3D)';
    if (e.matches('.cert')) return 'Thẻ giấy tờ';
    if (tag(e) === 'SECTION') {
      const hd = e.querySelector('h2, h1');
      return hd ? `Mục: ${clip(hd.textContent, 30)}` : 'Mục';
    }
    const name = NAMES[tag(e)] || e.tagName.toLowerCase();
    // Khung không tên: thêm gợi ý từ tên lớp để phân biệt (vd. "Khung · certs").
    return tag(e) === 'DIV' && e.classList[0] ? `${name} · ${e.classList[0].replace(/[_-]+/g, ' ')}` : name;
  }

  function snippet(e) {
    if (tag(e) === 'IMG') return e.getAttribute('alt') || e.getAttribute('src');
    const hd = /^H\d$/.test(tag(e)) ? null : e.querySelector('h1,h2,h3,h4');
    return clip((hd || e).textContent, 70);
  }

  function target(el) {
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || !S.doc) return null;
    const svg = el.closest('svg');
    if (svg) el = svg.parentElement || svg;
    const auto = el.closest('[data-auto]');
    if (auto && INLINE.has(tag(auto)) && auto.parentElement) el = auto.parentElement;
    if (el === S.doc.body || el === S.doc.documentElement || el.closest('[data-admin]')) return null;
    return el;
  }

  function inlineDeep(n) {
    if (tag(n) === 'SVG') return true;
    if (!INLINE.has(tag(n))) return false;
    return [...n.children].every(inlineDeep);
  }

  // Ô STT (cột đầu bảng có tiêu đề "STT"): tự đánh số, không sửa tay.
  function isSttCell(el) {
    const td = el.closest('td');
    const t = td && td.closest('table');
    if (!t || td.cellIndex !== 0 || !td.closest('tbody')) return false;
    return clean(t.querySelector('thead th')?.textContent).toUpperCase() === 'STT';
  }

  function isTextEditable(el) {
    if (NO_TEXT.has(tag(el)) || el.closest('svg') || el.closest('[data-auto]') || isSttCell(el)) return false;
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (n.textContent.trim()) hasText = true; } else if (n.nodeType === 1) {
        if (tag(n) === 'SVG' || tag(n) === 'BR') continue;
        if (!inlineDeep(n)) return false;
        if (n.textContent.trim()) hasText = true;
      }
    }
    return hasText;
  }

  const sig = (e) => `${tag(e)}.${e.classList[0] || ''}`;
  function isRepeatable(e) {
    const p = e.parentElement;
    if (!p || e === S.doc.body || p === S.doc.documentElement) return false;
    if (e.closest('svg') || e.closest('head')) return false;
    if (['SCRIPT', 'STYLE', 'MAIN', 'BR'].includes(tag(e))) return false;
    if (ALWAYS_REP.has(tag(e))) return true;
    return [...p.children].some((c) => c !== e && sig(c) === sig(e));
  }

  function repeatChain(el) {
    const out = [];
    for (let e = el; e && e !== S.doc.body; e = e.parentElement) {
      if (isRepeatable(e) && !(tag(e) === 'DD' && out.some((o) => tag(o) === 'DT'))) out.push(e);
      if (out.length >= 3) break;
    }
    return out;
  }

  // Một "mục" có thể gồm nhiều nút: cặp Nhãn (dt) + Giá trị (dd).
  function unitOf(e) {
    if (tag(e) === 'DT') {
      const g = [e];
      for (let n = e.nextElementSibling; n && tag(n) === 'DD'; n = n.nextElementSibling) g.push(n);
      return g;
    }
    if (tag(e) === 'DD') {
      let s = e;
      while (s.previousElementSibling && tag(s.previousElementSibling) === 'DD') s = s.previousElementSibling;
      const dt = s.previousElementSibling;
      if (dt && tag(dt) === 'DT') return unitOf(dt);
    }
    return [e];
  }

  /* ================= hoàn tác ================= */
  function snapshot() {
    const b = S.doc.body.cloneNode(true);
    b.querySelectorAll('[data-admin-hover],[data-admin-sel]').forEach((n) => {
      n.removeAttribute('data-admin-hover');
      n.removeAttribute('data-admin-sel');
    });
    b.querySelectorAll('[data-admin-ce]').forEach((n) => { n.removeAttribute('contenteditable'); n.removeAttribute('data-admin-ce'); });
    return b.innerHTML;
  }
  function updUndo() {
    $('#btn-undo').disabled = !S.undo.length;
    $('#btn-redo').disabled = !S.redo.length;
  }
  function pushUndo(snap) {
    S.undo.push(snap);
    if (S.undo.length > 80) S.undo.shift();
    S.redo = [];
    updUndo();
  }
  function mutate(fn) {
    endEdit();
    const before = snapshot();
    const r = fn();
    syncAuto(S.doc);
    if (snapshot() !== before) {
      pushUndo(before);
      setDirty(true);
    }
    return r;
  }
  function restore(html) {
    const y = S.doc.scrollingElement.scrollTop;
    S.doc.body.innerHTML = html;
    S.doc.scrollingElement.scrollTop = y;
    S.sel = S.hover = S.editing = null;
    renderEditPanel();
    setDirty(true);
    updUndo();
  }
  function undo() {
    endEdit();
    if (!S.undo.length) return;
    S.redo.push(snapshot());
    restore(S.undo.pop());
  }
  function redo() {
    endEdit();
    if (!S.redo.length) return;
    S.undo.push(snapshot());
    restore(S.redo.pop());
  }

  /* ================= chọn & sửa chữ ================= */
  function select(el, point) {
    endEdit();
    if (S.sel) S.sel.removeAttribute('data-admin-sel');
    S.sel = el || null;
    if (el) {
      el.setAttribute('data-admin-sel', '');
      if (isTextEditable(el)) beginEdit(el, point);
      switchTab('edit');
    }
    renderEditPanel();
  }

  function beginEdit(el, point) {
    S.editing = el;
    S.editBefore = snapshot();
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-admin-ce', '');
    el.setAttribute('spellcheck', 'false');
    el.querySelectorAll('svg, img, [data-auto]').forEach((s) => { s.setAttribute('contenteditable', 'false'); s.setAttribute('data-admin-ce', ''); });
    el.focus({ preventScroll: true });
    const sel = S.doc.getSelection();
    let range = null;
    if (point && S.doc.caretRangeFromPoint) range = S.doc.caretRangeFromPoint(point.x, point.y);
    if (!range || !el.contains(range.startContainer)) {
      range = S.doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function endEdit() {
    const el = S.editing;
    if (!el) return;
    S.editing = null;
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-admin-ce');
    el.removeAttribute('spellcheck');
    el.querySelectorAll('[data-admin-ce]').forEach((s) => { s.removeAttribute('contenteditable'); s.removeAttribute('data-admin-ce'); });
    // Trình duyệt hay để lại <br> thừa ở cuối khi xóa hết chữ.
    if (el.lastChild && el.lastChild.nodeName === 'BR' && el.childNodes.length === 1) el.lastChild.remove();
    el.normalize();
    S.doc.getSelection()?.removeAllRanges();
    syncAuto(S.doc);
    const now = snapshot();
    if (now !== S.editBefore) {
      pushUndo(S.editBefore);
      setDirty(true);
    }
    S.editBefore = null;
  }

  function bindFrame(d) {
    d.addEventListener('mouseover', (e) => {
      const t = target(e.target);
      if (S.hover && S.hover !== t) S.hover.removeAttribute('data-admin-hover');
      S.hover = t;
      if (t && t !== S.editing && t !== S.sel) t.setAttribute('data-admin-hover', '');
    });
    d.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget && S.hover) { S.hover.removeAttribute('data-admin-hover'); S.hover = null; }
    });
    d.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (S.editing && S.editing.contains(e.target)) return;
      const t = target(e.target);
      if (t) t.removeAttribute('data-admin-hover');
      select(t, { x: e.clientX, y: e.clientY });
    }, true);
    d.addEventListener('submit', (e) => e.preventDefault(), true);
    d.addEventListener('dragstart', (e) => e.preventDefault());
    d.addEventListener('input', () => {
      if (!S.editing) return;
      setDirty(true);
      syncMirror();
      if (S.editing.closest('.bars, table')) syncAuto(S.doc); // cột doanh thu, tổng giá trị… đổi ngay khi gõ
    });
    d.addEventListener('paste', (e) => {
      if (!S.editing) return;
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '');
      text.split('\n').forEach((line, i) => {
        if (i) d.execCommand('insertLineBreak');
        if (line) d.execCommand('insertText', false, line);
      });
    });
    d.addEventListener('keydown', (e) => {
      if (S.editing && e.key === 'Enter') {
        e.preventDefault();
        const el = S.editing;
        if (tag(el) === 'LI' && !e.shiftKey) {
          // Enter trong danh sách: thêm dòng mới ngay sau.
          const li = mutate(() => insertCopy([el], true)[0]);
          select(li);
        } else if (/^H\d$/.test(tag(el)) || el.closest('a, button')) {
          endEdit();
          renderEditPanel();
        } else d.execCommand('insertLineBreak');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (S.editing) { endEdit(); renderEditPanel(); } else select(null);
        return;
      }
      keys(e);
    }, true);
  }

  function keys(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '');
    if (k === 's') { e.preventDefault(); save(); } else if (k === 'z' && !e.shiftKey && !S.editing && !field) { e.preventDefault(); undo(); } else if ((k === 'y' || (k === 'z' && e.shiftKey)) && !S.editing && !field) { e.preventDefault(); redo(); }
  }

  /* ================= thao tác khối ================= */
  // Chèn bản sao của một mục ngay sau nó (giữ thụt lề). empty = xóa chữ trong bản sao.
  function insertCopy(unit, empty = false) {
    const last = unit[unit.length - 1];
    const ws = unit[0].previousSibling && unit[0].previousSibling.nodeType === 3 ? unit[0].previousSibling.textContent : '';
    let ref = last.nextSibling;
    const parent = last.parentNode;
    const copies = unit.map((n) => {
      const c = n.cloneNode(true);
      c.removeAttribute('data-admin-sel');
      c.removeAttribute('data-admin-hover');
      c.querySelectorAll('[data-admin-sel],[data-admin-hover]').forEach((x) => { x.removeAttribute('data-admin-sel'); x.removeAttribute('data-admin-hover'); });
      // Bản sao là phần mới; nhớ nó sao từ phần nào để khi lưu viết mã giống hệt phần đó.
      [c, ...c.querySelectorAll(`[${ID}]`)].forEach((x) => { x.setAttribute(FROM, x.getAttribute(ID)); x.removeAttribute(ID); });
      [c, ...c.querySelectorAll('[id]')].forEach((x) => {
        if (!x.id) return;
        let i = 2;
        while (S.doc.getElementById(`${x.id}-${i}`)) i++;
        x.id = `${x.id}-${i}`;
      });
      if (empty) c.textContent = '';
      return c;
    });
    copies.forEach((c) => {
      if (ws) parent.insertBefore(S.doc.createTextNode(ws), ref);
      parent.insertBefore(c, ref);
    });
    // Thêm cột doanh thu: năm mới = năm lớn nhất + 1.
    copies.filter((c) => c.matches('.bars > .bar')).forEach((c) => {
      const yearOf = (b) => b.querySelector(':scope > span:not(.bar__val)');
      const years = [...c.parentElement.querySelectorAll(':scope > .bar')].map((b) => parseInt(yearOf(b)?.textContent, 10)).filter((y) => y > 0);
      if (years.length && yearOf(c)) yearOf(c).textContent = String(Math.max(...years) + 1);
    });
    syncAuto(S.doc);
    return copies;
  }

  // Doanh thu: "24.624.046.912 đ", "24,6 tỷ", "850 triệu" → số đồng.
  function money(text) {
    const t = (text || '').toLowerCase();
    const m = t.match(/\d[\d.,\s]*/);
    if (!m) return 0;
    let num = m[0].replace(/\s/g, '');
    const unit = /tỷ|ty\b/.test(t) ? 1e9 : /triệu|trieu/.test(t) ? 1e6 : 1;
    if (unit > 1) num = num.replace(/\./g, '').replace(',', '.'); // 24,6 tỷ
    else num = num.replace(/[.,]/g, ''); // 24.624.046.912
    return (parseFloat(num) || 0) * unit;
  }

  // Độ dài cột doanh thu theo số tiền: năm nhiều nhất = cột dài nhất, các năm khác dài/ngắn theo tỉ lệ.
  function syncBars(root) {
    root.querySelectorAll('.bars').forEach((box) => {
      const bars = [...box.querySelectorAll(':scope > .bar')];
      const vals = bars.map((b) => money(b.querySelector('.bar__val')?.textContent));
      const max = Math.max(0, ...vals);
      bars.forEach((b, i) => {
        const fill = b.querySelector('.bar__fill');
        const val = b.querySelector('.bar__val');
        if (!fill) return;
        const pct = (max > 0 && vals[i] > 0 ? Math.max(1, (vals[i] / max) * 100) : 0).toFixed(1);
        if (fill.getAttribute('style') !== `width:${pct}%`) fill.setAttribute('style', `width:${pct}%`);
        // --w: chữ số tiền sáng trên cột, tối ở phần ngoài cột (CSS .bar__val).
        if (val && val.getAttribute('style') !== `--w:${pct}%`) val.setAttribute('style', `--w:${pct}%`);
        if (b.classList.contains('bar--short')) b.classList.remove('bar--short'); // cách cũ, không dùng nữa
      });
      // Tiêu đề "Doanh thu 2023–2025" và ghi chú "3 năm gần nhất" theo các năm đang có.
      const years = bars.map((b) => parseInt(b.querySelector(':scope > span:not(.bar__val)')?.textContent, 10)).filter((y) => y > 1900);
      const wrap = box.parentElement;
      const h2 = wrap && wrap.querySelector('h2');
      if (years.length && h2) {
        const span = years.length > 1 ? `${Math.min(...years)}–${Math.max(...years)}` : `${years[0]}`;
        for (const t of [...h2.childNodes].filter((n) => n.nodeType === 3)) {
          const nt = t.data.replace(/\b(19|20)\d{2}(\s*[–-]\s*(19|20)\d{2})?\b/, span);
          if (nt !== t.data) { t.data = nt; break; }
        }
      }
      const note = wrap && [...wrap.querySelectorAll('.note')].find((n) => /\d+\s+năm gần nhất/.test(n.textContent));
      if (note && bars.length) {
        for (const t of [...note.childNodes].filter((n) => n.nodeType === 3)) {
          const nt = t.data.replace(/\d+(\s+năm gần nhất)/, `${bars.length}$1`);
          if (nt !== t.data) { t.data = nt; break; }
        }
      }
    });
  }

  /* ================= số tự tính ================= */
  const AUTO_INFO = {
    'so-cong-trinh': 'số hàng trong bảng "Công trình đã và đang thi công"',
    'so-di-tich': 'số công trình loại Di tích trong bảng đó',
    'tong-gia-tri': 'tổng cột "Giá trị HĐ" của bảng đó',
    'tong-gia-tri-ty': 'tổng cột "Giá trị HĐ" của bảng đó',
    'tu-nam': 'năm sớm nhất trong cột "Thời gian"',
    'den-nam': 'năm muộn nhất trong cột "Thời gian"',
    'so-tieu-bieu': 'số công trình trong hành trình 3D',
    'stt-cong-trinh': 'số thứ tự của công trình này trong bảng "Công trình đã và đang thi công"',
    'so-nam': 'năm nay trừ năm thành lập (tự tăng mỗi năm)',
    'nam-gan': 'theo số năm hoạt động (tự đổi mỗi năm)',
    'nam-thanh-lap': 'ô "Năm thành lập" ở đầu trang',
    stt: 'số thứ tự: tự đánh lại 1, 2, 3… khi thêm / xóa / đổi chỗ hàng',
  };
  const dots = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  function setAuto(root, key, text) {
    root.querySelectorAll(`[data-auto="${key}"]`).forEach((el) => { if (el.textContent !== text) el.textContent = text; });
  }

  // Mọi số phụ thuộc vào nội dung khác: tính lại sau mỗi lần thêm / xóa / sửa.
  function syncAuto(root) {
    syncBars(root);
    // STT các bảng: đánh lại 1, 2, 3… theo thứ tự hàng.
    root.querySelectorAll('table').forEach((t) => {
      const th = t.querySelector('thead th');
      if (!th || clean(th.textContent).toUpperCase() !== 'STT' || !t.tBodies[0]) return;
      let n = 0;
      [...t.tBodies[0].rows].forEach((r) => {
        const c = r.cells[0];
        if (!c || tag(c) !== 'TD' || r.cells.length < 2) return; // hàng tiêu đề nhóm
        const v = String(++n);
        if (clean(c.textContent) !== v) c.textContent = v;
      });
    });
    // Bảng công trình: số công trình, số di tích, tổng giá trị, khoảng năm.
    const works = root.querySelector('table[data-works]');
    if (works && works.tBodies[0]) {
      const rows = [...works.tBodies[0].rows].filter((r) => r.cells.length >= 5);
      const heads = [...works.querySelectorAll('thead th')].map((x) => clean(x.textContent).toLowerCase());
      const col = (re, d) => { const i = heads.findIndex((x) => re.test(x)); return i < 0 ? d : i; };
      const cv = col(/giá trị/, 4);
      const cy = col(/thời gian|năm/, 5);
      const sum = rows.reduce((a, r) => a + (parseInt((r.cells[cv]?.textContent || '').replace(/\D/g, ''), 10) || 0), 0);
      const years = rows.flatMap((r) => (r.cells[cy]?.textContent.match(/\b(19|20)\d{2}\b/g) || []).map(Number));
      setAuto(root, 'so-cong-trinh', String(rows.length));
      setAuto(root, 'so-di-tich', String(rows.filter((r) => r.getAttribute('data-category') === 'di-tich').length));
      setAuto(root, 'tong-gia-tri', `${dots(sum)} đ`);
      setAuto(root, 'tong-gia-tri-ty', (Math.round(sum / 1e8) / 10).toFixed(1).replace('.', ','));
      if (years.length) {
        setAuto(root, 'tu-nam', String(Math.min(...years)));
        setAuto(root, 'den-nam', String(Math.max(...years)));
      }
      // "Công trình số 10 / 40" trong hành trình 3D: số thứ tự của hàng tương ứng (data-ref = id của hàng).
      root.querySelectorAll('[data-auto="stt-cong-trinh"][data-ref]').forEach((sp) => {
        const k = rows.findIndex((r) => r.id === sp.getAttribute('data-ref'));
        if (k >= 0 && sp.textContent !== String(k + 1)) sp.textContent = String(k + 1);
      });
    }
    setAuto(root, 'so-tieu-bieu', String(root.querySelectorAll('[data-journey] .chapter-step').length));
    // Số năm hoạt động: năm nay − năm thành lập (giống đoạn mã trên trang thật).
    const founded = parseInt(root.querySelector('[data-founded]')?.textContent, 10);
    if (founded > 1900) {
      const y = new Date().getFullYear() - founded;
      const r = y % 5;
      setAuto(root, 'so-nam', String(y));
      setAuto(root, 'nam-gan', r === 0 ? `${y} năm` : r >= 3 ? `Gần ${y - r + 5} năm` : `Hơn ${y - r} năm`);
      setAuto(root, 'nam-thanh-lap', String(founded));
    }
  }

  // Loại công trình (Di tích / Dân dụng / Cần xác nhận): đổi cả nhãn trong ô tên và data-category để bộ lọc, số đếm đúng.
  const KINDS = [['di-tich', 'Di tích', 'tag'], ['dan-dung', 'Dân dụng', 'tag tag--civil'], ['chua-ro', 'Cần xác nhận', 'tag tag--unknown']];
  function setKind(tr, kind) {
    const k = KINDS.find((x) => x[0] === kind);
    if (!k) return;
    tr.setAttribute('data-category', kind);
    const cell = tr.cells[1];
    if (!cell) return;
    let t = cell.querySelector('.tag');
    if (!t) {
      cell.append(S.doc.createElement('br'));
      t = S.doc.createElement('span');
      cell.append(t);
    }
    if (t.getAttribute('class') !== k[2]) t.setAttribute('class', k[2]);
    if (clean(t.textContent) !== k[1]) t.textContent = k[1];
  }

  function moveUnit(el, dir) {
    const unit = unitOf(el);
    const first = unit[0];
    const last = unit[unit.length - 1];
    if (dir < 0) {
      const prev = first.previousElementSibling;
      if (!prev) return false;
      const pu = unitOf(prev);
      unit.forEach((n) => pu[0].parentNode.insertBefore(n, pu[0]));
    } else {
      const next = last.nextElementSibling;
      if (!next) return false;
      const nu = unitOf(next);
      let ref = nu[nu.length - 1].nextSibling;
      unit.forEach((n) => last.parentNode.insertBefore(n, ref));
    }
    return true;
  }

  function removeUnit(el) {
    unitOf(el).forEach((n) => {
      const ws = n.previousSibling;
      if (ws && ws.nodeType === 3 && !ws.textContent.trim()) ws.remove();
      n.remove();
    });
  }

  /* ================= ảnh & tệp ================= */
  // Dùng XMLHttpRequest thay vì fetch: một số tiện ích trình duyệt bọc fetch và làm hỏng việc gửi tệp.
  async function uploadBlob(blob, folder, name) {
    if (!blob) throw new Error('Không đọc được tệp.');
    const data = await blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/upload');
      x.withCredentials = true;
      x.setRequestHeader('X-CST-Admin', '1');
      x.setRequestHeader('X-Folder', folder);
      x.setRequestHeader('X-Filename', encodeURIComponent(name));
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* bỏ qua */ }
        if (x.status >= 200 && x.status < 300) resolve(d.path);
        else reject(new Error(d.error || `Tải lên lỗi ${x.status}`));
      };
      x.onerror = () => reject(new Error('Mất kết nối tới máy chủ khi tải tệp lên.'));
      x.send(data);
    });
  }

  const canvasBlob = (c, type = 'image/jpeg', q = 0.86) => new Promise((r) => c.toBlob(r, type, q));

  // Thu nhỏ ảnh quá lớn và đổi sang JPG (nhẹ, và hành trình 3D chỉ đọc .jpg).
  async function prepImage(file, { forceJpg = false, maxSide = 2200 } = {}) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Chỉ nhận ảnh JPG, PNG hoặc WEBP.');
    const bmp = await createImageBitmap(file);
    const stem = file.name.replace(/\.[^.]+$/, '');
    if (file.type === 'image/png' && !forceJpg && file.size < 3e6 && Math.max(bmp.width, bmp.height) <= maxSide) {
      return { blob: file, name: file.name, w: bmp.width, h: bmp.height };
    }
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return { blob: await canvasBlob(c), name: `${stem}.jpg`, w: c.width, h: c.height };
  }

  async function uploadImage(file, folder = 'img/uploads', forceJpg = false) {
    const p = await prepImage(file, { forceJpg });
    const path = await uploadBlob(p.blob, folder, p.name);
    return { path, w: p.w, h: p.h };
  }

  function loadScript(src) {
    return new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => no(new Error('Không tải được thư viện đọc PDF (cần mạng Internet).'));
      document.head.append(s);
    });
  }

  // Vẽ trang 1 của PDF thành ảnh (để làm ảnh xem trước giấy tờ).
  async function renderPdf(file) {
    if (!window.pdfjsLib) {
      await loadScript(`${PDFJS}pdf.min.js`);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
    }
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const page = await pdf.getPage(1);
    const v0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 1800 / v0.height });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const s = document.createElement('canvas');
    s.width = 720;
    s.height = Math.round(c.height * (720 / c.width));
    s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
    return {
      pages: pdf.numPages,
      full: { blob: await canvasBlob(c), w: c.width, h: c.height },
      small: { blob: await canvasBlob(s, 'image/jpeg', 0.82), w: s.width, h: s.height },
    };
  }

  const inJourney = (el) => !!el.closest('[data-journey] .chapter-step');

  function applyImage(img, path, w, h, fullPath) {
    if (inJourney(img) && !/\.jpg$/i.test(path)) {
      toast('Ảnh trong hành trình công trình phải là tệp .jpg. Hãy dùng nút "Thay ảnh…" để tải lên (tự đổi sang JPG).', true, 6000);
      return;
    }
    mutate(() => {
      img.setAttribute('src', path);
      img.removeAttribute('srcset');
      if (w && h && (img.hasAttribute('width') || img.hasAttribute('height'))) {
        img.setAttribute('width', w);
        img.setAttribute('height', h);
      }
      const a = img.closest('a');
      if (a && isImgPath(a.getAttribute('href'))) a.setAttribute('href', fullPath || path);
    });
    renderEditPanel();
  }

  function natural(path) {
    return new Promise((r) => {
      const im = new Image();
      im.onload = () => r([im.naturalWidth, im.naturalHeight]);
      im.onerror = () => r([0, 0]);
      im.src = url(path);
    });
  }

  async function replaceImage(img) {
    const file = await pickFile('image/jpeg,image/png,image/webp');
    if (!file) return;
    try {
      const folder = img.closest('.cert') ? 'img/giay-to' : 'img/uploads';
      const up = await busy('Đang tải ảnh lên…', () => uploadImage(file, folder, inJourney(img)));
      applyImage(img, up.path, up.w, up.h);
      toast('Đã thay ảnh. Nhớ bấm Lưu thay đổi.');
    } catch (e) { toast(e.message, true); }
  }

  function applyLink(a, path) {
    mutate(() => {
      a.setAttribute('href', path);
      if (isDocPath(path)) a.setAttribute('download', '');
    });
    renderEditPanel();
  }

  async function replaceLinkFile(a) {
    const file = await pickFile('');
    if (!file) return;
    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      if (file.type.startsWith('image/')) {
        const up = await busy('Đang tải ảnh lên…', () => uploadImage(file));
        applyLink(a, up.path);
      } else if (isPdf) {
        await attachPdf(a, file);
      } else {
        const path = await busy('Đang tải tệp lên…', () => uploadBlob(file, 'giay-to', file.name));
        applyLink(a, path);
      }
      loadFiles();
      toast('Đã gắn tệp mới. Nhớ bấm Lưu thay đổi.');
    } catch (e) { toast(e.message, true); }
  }

  // Gắn PDF vào nút; nếu nút nằm trong thẻ giấy tờ thì tự tạo ảnh xem trước + cập nhật số trang.
  async function attachPdf(a, file) {
    await busy('Đang tải PDF lên và tạo ảnh xem trước…', async () => {
      const path = await uploadBlob(file, 'giay-to', file.name);
      const cert = a.closest('.cert');
      let info = null;
      let full = null;
      let small = null;
      try {
        info = await renderPdf(file);
        if (cert) {
          const stem = file.name.replace(/\.[^.]+$/, '');
          full = await uploadBlob(info.full.blob, 'img/giay-to', `${stem}.jpg`);
          small = await uploadBlob(info.small.blob, 'img/giay-to', `${stem}-nho.jpg`);
        }
      } catch (e) {
        toast(`Đã tải PDF, nhưng không tạo được ảnh xem trước: ${e.message}`, true, 7000);
      }
      mutate(() => {
        a.setAttribute('href', path);
        a.setAttribute('download', '');
        if (!cert) return;
        const note = cert.querySelector('.cert__actions .src');
        if (note && info) note.textContent = `PDF · ${info.pages} trang`;
        const scan = cert.querySelector('.cert__scan');
        const img = scan && scan.querySelector('img');
        if (img && full && small) {
          scan.setAttribute('href', full);
          img.setAttribute('src', small);
          img.setAttribute('width', info.small.w);
          img.setAttribute('height', info.small.h);
        }
      });
    });
    renderEditPanel();
  }

  async function addJourneyPhoto(step) {
    const file = await pickFile('image/jpeg,image/png,image/webp');
    if (!file) return;
    try {
      const up = await busy('Đang tải ảnh lên…', () => uploadImage(file, 'img/uploads', true));
      const gallery = step.querySelector('.gallery');
      const fig = mutate(() => {
        let f;
        const tpl = gallery.querySelector('figure');
        if (tpl) {
          f = insertCopy([gallery.querySelectorAll('figure')[gallery.querySelectorAll('figure').length - 1]])[0];
        } else {
          f = S.doc.createElement('figure');
          f.innerHTML = '<img loading="lazy"><figcaption></figcaption>';
          gallery.append(f);
        }
        const img = f.querySelector('img');
        img.setAttribute('src', up.path);
        img.setAttribute('width', up.w);
        img.setAttribute('height', up.h);
        f.querySelector('figcaption').textContent = 'Chú thích ảnh mới';
        return f;
      });
      loadFiles();
      select(fig.querySelector('figcaption'));
      toast('Đã thêm ảnh. Hãy sửa chú thích (đang chọn), rồi Lưu.');
    } catch (e) { toast(e.message, true); }
  }

  /* ================= khung "Đang chọn" ================= */
  function renderEditPanel() {
    const p = $('#panel-edit');
    p.replaceChildren();
    const el = S.sel;
    if (!el || !el.isConnected) {
      S.sel = null;
      p.append(h('div', { class: 'empty' },
        h('b', { text: 'Bấm vào chữ, ảnh, nút hoặc một mục bất kỳ trên trang để sửa.' }),
        h('ul', {},
          h('li', { text: 'Chữ: bấm vào rồi gõ trực tiếp.' }),
          h('li', { text: 'Ảnh, tệp PDF: bấm vào ảnh/nút rồi chọn "Thay…" ở khung này.' }),
          h('li', { text: 'Thêm mới: chọn một mục có sẵn rồi bấm "Thêm mục giống thế này".' }),
          h('li', { text: 'Xong bấm "Lưu thay đổi" ở trên cùng.' }))));
      return;
    }

    p.append(h('p', { class: 'sel-title', text: label(el) }));
    const sn = snippet(el);
    if (sn) p.append(h('p', { class: 'sel-kind', text: sn }));
    let tools = 0; // số công cụ hiện ra cho phần đang chọn

    // sửa chữ
    if (S.editing === el) {
      tools++;
      p.append(h('div', { class: 'hint-edit' },
        el.closest('a, button') ? 'Đang sửa chữ trên nút. ' : 'Đang sửa chữ trực tiếp trên trang. ',
        tag(el) === 'LI' ? 'Enter = thêm dòng mới. ' : (/^H\d$/.test(tag(el)) || el.closest('a, button') ? '' : 'Enter = xuống dòng. '),
        'Esc = xong.'));
    } else if (isTextEditable(el)) {
      tools++;
      p.append(h('div', { class: 'row' }, h('button', { class: 'btn btn--sm', type: 'button', onclick: () => { beginEdit(el); renderEditPanel(); } }, 'Sửa chữ')));
    }

    // ảnh
    const imgs = tag(el) === 'IMG' ? [el] : [...el.querySelectorAll('img')];
    if (imgs.length === 1) {
      tools++;
      const img = imgs[0];
      const card = h('div', { class: 'card' }, h('h3', {}, 'Ảnh'));
      card.append(h('img', { class: 'preview', src: url(img.getAttribute('src') || ''), alt: '' }));
      card.append(h('div', { class: 'row' },
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => replaceImage(img) }, 'Thay ảnh…'),
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => { switchTab('files'); toast('Bấm vào một ảnh trong danh sách để thay.'); } }, 'Chọn ảnh có sẵn')));
      p.append(card);
    }

    // nút tải tệp (PDF…) và liên kết ra ngoài (web, điện thoại, email)
    const link = el.closest('a') || (el.querySelectorAll('a').length === 1 ? el.querySelector('a') : null);
    const hrefNow = link ? link.getAttribute('href') || '' : '';
    if (link && isDocPath(hrefNow)) {
      tools++;
      const card = h('div', { class: 'card' }, h('h3', {}, 'Tệp gắn kèm'));
      card.append(h('p', { class: 'path', text: hrefNow }));
      card.append(h('div', { class: 'row' },
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => replaceLinkFile(link) }, 'Thay tệp…'),
        h('a', { class: 'btn btn--sm', href: url(hrefNow), target: '_blank', rel: 'noopener' }, 'Mở xem')));
      if (link.closest('.cert') && link.matches('.cert__btn')) {
        card.append(h('p', { class: 'note', text: 'Ảnh xem trước của thẻ và tệp .zip "Tải cả bộ giấy tờ" tự cập nhật khi lưu.' }));
      }
      p.append(card);
    } else if (link && /^(https?:|tel:|mailto:)/i.test(hrefNow)) {
      tools++;
      const href = h('input', { type: 'text', value: hrefNow });
      href.addEventListener('change', () => mutate(() => link.setAttribute('href', href.value.trim())));
      p.append(h('div', { class: 'card' }, h('h3', {}, 'Liên kết'),
        h('label', { class: 'field' }, 'Địa chỉ (https://…, tel:…, mailto:…)', href)));
    }

    // ảnh của công trình trong hành trình
    const step = el.closest('[data-journey] .chapter-step');
    if (step && step.querySelector('.gallery')) {
      tools++;
      const figs = [...step.querySelectorAll('.gallery figure')];
      const card = h('div', { class: 'card' }, h('h3', {}, 'Ảnh của công trình ', h('small', { text: `(${figs.length} ảnh)` })));
      card.append(h('p', { class: 'note', text: 'Ảnh đầu tiên hiện trên vòng ảnh 3D. Bấm vào ảnh/chú thích trên trang để thay hoặc sửa.' }));
      const list = h('div', { class: 'chapter-imgs' });
      figs.forEach((f, i) => {
        const im = f.querySelector('img');
        list.append(h('div', { class: 'ci' },
          h('img', { src: url(im?.getAttribute('src') || ''), alt: '' }),
          h('div', {},
            h('div', { class: 'note', style: 'margin:0 0 4px', text: clip(f.querySelector('figcaption')?.textContent, 60) }),
            h('div', { class: 'row', style: 'margin:0' },
              h('button', { class: 'btn btn--sm', type: 'button', disabled: i === 0, title: 'Lên', onclick: () => { mutate(() => moveUnit(f, -1)); renderEditPanel(); } }, '↑'),
              h('button', { class: 'btn btn--sm', type: 'button', disabled: i === figs.length - 1, title: 'Xuống', onclick: () => { mutate(() => moveUnit(f, 1)); renderEditPanel(); } }, '↓'),
              h('button', { class: 'btn btn--sm', type: 'button', onclick: () => { select(im); f.scrollIntoView({ block: 'center' }); } }, 'Chọn'),
              h('button', {
                class: 'btn btn--sm btn--danger', type: 'button', disabled: figs.length < 2, title: figs.length < 2 ? 'Cần ít nhất 1 ảnh' : 'Xóa ảnh',
                onclick: () => { if (confirm('Xóa ảnh này khỏi công trình?')) { mutate(() => removeUnit(f)); renderEditPanel(); } },
              }, 'Xóa')))));
      });
      card.append(list);
      card.append(h('div', { class: 'row' }, h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => addJourneyPhoto(step) }, '+ Thêm ảnh cho công trình…')));
      p.append(card);
    }

    // số tự tính
    const autos = [...new Set([el, ...el.querySelectorAll('[data-auto]')].filter((x) => x.matches('[data-auto]')).map((x) => x.getAttribute('data-auto')))];
    if (isSttCell(el)) autos.push('stt');
    if (autos.length) {
      tools++;
      p.append(h('div', { class: 'card' }, h('h3', {}, 'Số tự tính'),
        h('p', { class: 'note', style: 'margin:0 0 4px', text: 'Số gạch chân chấm không cần sửa tay, tự đổi khi thêm / xóa / sửa:' }),
        h('ul', { class: 'note', style: 'margin:0;padding-left:18px' }, ...autos.map((k) => h('li', { text: AUTO_INFO[k] || k })))));
    }
    if (el.matches('[data-founded]')) {
      tools++;
      p.append(h('p', { class: 'note', text: 'Sửa năm thành lập thì số năm hoạt động ("19 năm", "Gần 20 năm"…) tự tính lại.' }));
    }

    // loại công trình trong bảng công trình
    const wrow = el.closest('table[data-works] tbody tr');
    if (wrow && wrow.cells.length >= 5) {
      tools++;
      const sel = h('select', {}, ...KINDS.map(([v, t]) => h('option', { value: v, text: t })));
      sel.value = wrow.getAttribute('data-category') || '';
      sel.addEventListener('change', () => { mutate(() => setKind(wrow, sel.value)); renderEditPanel(); });
      p.append(h('div', { class: 'card' }, h('h3', {}, 'Loại công trình'),
        h('label', { class: 'field' }, 'Dùng cho nút lọc và số "Di tích"', sel)));
    }

    // thêm mục giống mục có sẵn / đổi thứ tự / xóa — chỉ với dòng, thẻ, hàng… (không với cả mục lớn hay menu)
    const reps = repeatChain(el).filter((r) => !['SECTION', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'TD', 'TH'].includes(tag(r))
      && !r.closest('nav, .site-header, .menu-sheet') && !r.matches('.gallery figure')).slice(0, 2);
    tools += reps.length;
    reps.forEach((r) => {
      const unit = unitOf(r);
      const sibs = [...r.parentElement.children].filter((c) => sig(c) === sig(r));
      const idx = sibs.indexOf(unit[0]) + 1;
      const name = label(r);
      const card = h('div', { class: 'card' }, h('h3', {}, name, ' ', h('small', { text: tag(r) === 'DT' || tag(r) === 'DD' ? '(nhãn + giá trị)' : `(${idx}/${sibs.length})` })));
      if (r !== el) card.append(h('p', { class: 'note', style: 'margin-top:0', text: snippet(r) }));
      card.append(h('div', { class: 'row', style: 'margin-bottom:0' },
        h('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          onclick: () => {
            const c = mutate(() => insertCopy(unit));
            select(c[0]);
            c[0].scrollIntoView({ block: 'center' });
            toast('Đã thêm bản sao ngay bên dưới. Sửa nội dung rồi Lưu.');
          },
        }, '+ Thêm mục giống thế này'),
        h('button', { class: 'btn btn--sm', type: 'button', title: 'Đưa lên trước', disabled: !unit[0].previousElementSibling, onclick: () => { mutate(() => moveUnit(r, -1)); r.scrollIntoView({ block: 'nearest' }); renderEditPanel(); } }, '↑'),
        h('button', { class: 'btn btn--sm', type: 'button', title: 'Đưa xuống sau', disabled: !unit[unit.length - 1].nextElementSibling, onclick: () => { mutate(() => moveUnit(r, 1)); r.scrollIntoView({ block: 'nearest' }); renderEditPanel(); } }, '↓'),
        h('button', {
          class: 'btn btn--sm btn--danger', type: 'button',
          onclick: () => {
            if (!confirm(`Xóa "${name}: ${clip(snippet(r), 40)}"?\n(Có thể Hoàn tác nếu xóa nhầm.)`)) return;
            const next = unit[unit.length - 1].nextElementSibling || unit[0].previousElementSibling;
            mutate(() => removeUnit(r));
            select(next && next.isConnected ? next : null);
          },
        }, 'Xóa')));
      p.append(card);
    });

    if (!tools) {
      p.append(h('p', { class: 'note', text: 'Phần này không cần sửa. Hãy bấm thẳng vào chữ, ảnh, nút tải tệp hoặc một dòng / thẻ trên trang.' }));
    }
  }

  function syncMirror() {
    const ta = $('#panel-edit textarea[data-mirror]');
    if (ta && S.editing && document.activeElement !== ta) ta.value = S.editing.innerText.replace(/\n$/, '');
  }

  /* ================= tab Trang ================= */
  function fillPageTab() {
    const d = S.doc;
    const title = $('#page-title');
    title.value = d.title;
    title.oninput = () => { d.title = title.value; setDirty(true); };
    let meta = d.querySelector('meta[name="description"]');
    const desc = $('#page-desc');
    desc.value = meta ? meta.getAttribute('content') : '';
    desc.oninput = () => {
      if (!meta) { meta = d.createElement('meta'); meta.name = 'description'; d.head.append(meta); }
      meta.setAttribute('content', desc.value);
      setDirty(true);
    };
    const toc = $('#toc');
    toc.replaceChildren();
    const list = [d.querySelector('[data-journey]'), ...d.querySelectorAll('main .section'), d.querySelector('.site-footer')].filter(Boolean);
    list.forEach((s) => {
      const hd = s.matches('[data-journey]') ? 'Hành trình công trình (3D)' : clean(s.querySelector('h2')?.textContent) || label(s);
      const eb = s.querySelector('.eyebrow');
      toc.append(h('li', {}, h('button', {
        type: 'button',
        onclick: () => { s.scrollIntoView({ block: 'start' }); select(s); },
      }, hd, eb && !s.matches('[data-journey]') ? h('small', { text: ` · ${clip(eb.firstChild?.textContent || eb.textContent, 34)}` }) : null)));
    });
  }

  /* ================= tab Tệp ================= */
  async function loadFiles() {
    try {
      S.files = (await api('files')).files;
      renderFiles();
    } catch (e) { toast(e.message, true); }
  }

  function renderFiles() {
    const q = clean($('#files-filter').value).toLowerCase();
    const box = $('#files');
    box.replaceChildren();
    S.files.filter((f) => !q || f.path.toLowerCase().includes(q)).slice(0, 300).forEach((f) => {
      const name = f.path.split('/').pop();
      const ext = (name.split('.').pop() || '').toUpperCase();
      box.append(h('button', { class: 'file', type: 'button', title: f.path, onclick: () => useFile(f.path) },
        isImgPath(f.path) ? h('img', { src: url(f.path), alt: '', loading: 'lazy' }) : h('span', { class: 'file__icon', text: ext }),
        name));
    });
    if (!box.children.length) box.append(h('p', { class: 'empty', text: 'Không có tệp nào.' }));
  }

  async function useFile(path) {
    const el = S.sel;
    const img = el && (tag(el) === 'IMG' ? el : (el.querySelectorAll('img').length === 1 ? el.querySelector('img') : null));
    const link = el && (el.closest('a') || (el.querySelectorAll('a').length === 1 ? el.querySelector('a') : null));
    if (img && isImgPath(path)) {
      const [w, hh] = await natural(path);
      applyImage(img, path, w, hh);
      switchTab('edit');
      toast('Đã thay ảnh. Nhớ bấm Lưu thay đổi.');
    } else if (link) {
      applyLink(link, path);
      switchTab('edit');
      toast('Đã gắn tệp vào liên kết. Nhớ bấm Lưu thay đổi.');
    } else {
      try { await navigator.clipboard.writeText(path); } catch { /* bỏ qua */ }
      toast(`Chưa chọn ảnh/nút trên trang. Đã chép đường dẫn: ${path}`);
    }
  }

  async function uploadMany(files) {
    const folder = $('#up-folder').value;
    let ok = 0;
    await busy('Đang tải lên…', async () => {
      for (const f of files) {
        try {
          if (folder.startsWith('img/') && f.type.startsWith('image/')) await uploadImage(f, folder);
          else await uploadBlob(f, folder, f.name);
          ok++;
        } catch (e) { toast(`${f.name}: ${e.message}`, true, 6000); }
      }
    });
    await loadFiles();
    if (ok) toast(`Đã tải lên ${ok} tệp.`);
  }

  /* ================= tab Bản lưu ================= */
  async function loadBackups() {
    const ul = $('#backups');
    ul.replaceChildren(h('li', {}, 'Đang tải…'));
    try {
      const { backups } = await api('backups');
      ul.replaceChildren();
      if (!backups.length) ul.append(h('li', {}, 'Chưa có bản lưu nào.'));
      backups.forEach((b) => {
        const t = new Date(b.time * 1000);
        ul.append(h('li', {},
          h('span', {}, t.toLocaleString('vi-VN'), h('small', { text: `${b.name.includes('khoi-phuc') ? 'Trước khi khôi phục' : 'Trước khi lưu'} · ${Math.round(b.size / 1024)} KB` })),
          h('button', {
            class: 'btn btn--sm', type: 'button',
            onclick: async () => {
              if (!confirm(`Khôi phục trang về bản lúc ${t.toLocaleString('vi-VN')}?${S.dirty ? '\nCác thay đổi chưa lưu sẽ mất.' : ''}`)) return;
              try {
                await api('restore', { method: 'POST', json: { name: b.name } });
                await loadPage();
                loadBackups();
                toast('Đã khôi phục.');
              } catch (e) { toast(e.message, true); }
            },
          }, 'Khôi phục')));
      });
    } catch (e) { ul.replaceChildren(h('li', {}, e.message)); }
  }

  /* ================= lưu ================= */
  // Dựng lại dữ liệu ảnh cho hành trình 3D và bảng ảnh từ các ảnh đang có trong từng công trình.
  function syncJourney(root) {
    const dataEl = root.querySelector('#featured-data');
    if (!dataEl) return;
    const steps = [...root.querySelectorAll('[data-journey] .chapter-step')];
    const data = steps.map((st, i) => {
      const title = clean(st.querySelector('h2')?.textContent) || `Công trình ${i + 1}`;
      const images = [...st.querySelectorAll('.gallery figure')].map((f) => {
        const img = f.querySelector('img');
        const cap = clean(f.querySelector('figcaption')?.textContent);
        const src = (img?.getAttribute('src') || '').replace(/^\//, '');
        const m = src.match(/^img\/(.+)\.jpg$/i);
        if (!m) throw new Error(`Công trình "${title}": ảnh "${src}" phải là tệp .jpg trong thư mục img. Hãy thay lại bằng nút "Thay ảnh…".`);
        const alt = cap ? `${cap} — ${title}` : title;
        if (img.getAttribute('alt') !== alt) img.setAttribute('alt', alt);
        return [m[1], cap];
      });
      if (!images.length) throw new Error(`Công trình "${title}" cần ít nhất 1 ảnh.`);
      const ol = st.querySelector('.captions');
      const same = ol && ol.children.length === images.length && [...ol.children].every((li, k) => clean(li.textContent) === images[k][1]);
      if (ol && !same) {
        const pad = (ol.previousSibling && ol.previousSibling.nodeType === 3 ? ol.previousSibling.textContent : '\n').replace(/^\n*/, '');
        ol.replaceChildren();
        images.forEach(([, c]) => {
          ol.append(root.ownerDocument.createTextNode(`\n${pad}  `));
          const li = root.ownerDocument.createElement('li');
          li.textContent = c;
          ol.append(li);
        });
        ol.append(root.ownerDocument.createTextNode(`\n${pad}`));
      }
      return { title, images };
    });
    let old = null;
    try { old = JSON.stringify(JSON.parse(dataEl.textContent)); } catch { /* dữ liệu hỏng: ghi lại */ }
    if (old !== JSON.stringify(data)) dataEl.textContent = JSON.stringify(data).replace(/</g, '\\u003c');
  }

  // Bản sạch của trang đang sửa (bỏ dấu admin, bật lại script); giữ ID nếu keepIds.
  function cleanRoot(keepIds) {
    const root = S.doc.documentElement.cloneNode(true);
    root.querySelectorAll('[data-admin]').forEach((n) => n.remove());
    root.querySelectorAll('[data-admin-ce]').forEach((n) => { n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); });
    // Tiện ích trình duyệt (VPN, chặn quảng cáo, kiểm tra chính tả…) tự chèn mã vào khung sửa: bỏ hết, không ghi vào trang.
    root.querySelectorAll('*').forEach((n) => {
      const fromExt = /^(chrome|moz|safari-web|ms-browser)-extension:/i.test(n.getAttribute('src') || n.getAttribute('href') || '');
      const injected = !n.hasAttribute(ID) && !n.hasAttribute(FROM)
        && (/^(SCRIPT|LINK|STYLE|IFRAME|OBJECT|EMBED)$/.test(n.tagName) || n.tagName.includes('-'));
      if (fromExt || injected) n.remove();
    });
    [root, ...root.querySelectorAll('*')].forEach((el) => {
      for (const a of [...el.attributes]) {
        if (/^(bis_|__|data-gr-|data-gramm|data-new-gr|data-lt-|data-darkreader|cz-shortcut|data-dynamic-id)/i.test(a.name)) el.removeAttribute(a.name);
      }
    });
    root.querySelectorAll('script[data-admin-type]').forEach((s) => {
      const t = s.getAttribute('data-admin-type');
      s.removeAttribute('data-admin-type');
      if (t === '__none__') s.removeAttribute('type'); else s.setAttribute('type', t);
    });
    [root, ...root.querySelectorAll('*')].forEach((el) => {
      for (const a of [...el.attributes]) {
        if (a.name.startsWith('data-admin-') && !(keepIds && (a.name === ID || a.name === FROM))) el.removeAttribute(a.name);
      }
    });
    return root;
  }

  // Vị trí [đầu, cuối) trong mã gốc của từng thẻ mở, theo đúng thứ tự xuất hiện.
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea', 'title']);
  function sourceRanges(src) {
    const out = [];
    const stack = [];
    const re = /<!--[\s\S]*?-->|<![^>]*>|<\/([A-Za-z][\w:-]*)[^>]*>|<([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[1]) { // thẻ đóng
        const name = m[1].toLowerCase();
        const k = stack.map((x) => x.name).lastIndexOf(name);
        if (k < 0) continue;
        while (stack.length > k) {
          const x = stack.pop();
          if (stack.length === k) { x.end = re.lastIndex; x.closeStart = m.index; } else x.end = m.index;
        }
      } else if (m[2]) { // thẻ mở
        const name = m[2].toLowerCase();
        const rec = { name, start: m.index, end: re.lastIndex, openEnd: re.lastIndex };
        out.push(rec);
        if (VOID.has(name) || /\/\s*$/.test(m[3])) { rec.empty = true; continue; }
        if (RAW.has(name)) {
          const close = src.toLowerCase().indexOf(`</${name}`, re.lastIndex);
          if (close < 0) return null;
          const gt = src.indexOf('>', close);
          rec.closeStart = close;
          rec.end = gt + 1;
          re.lastIndex = gt + 1;
          continue;
        }
        stack.push(rec);
      }
    }
    return out;
  }

  // Mỗi phần tử của bản gốc (theo ID) ứng với vị trí nào trong mã gốc; thẻ trình duyệt tự thêm (html, head, body, tbody) không có.
  function mapSource(src, doc0) {
    const recs = sourceRanges(src);
    if (!recs) return null;
    const map = new Map();
    let j = 0;
    for (const e of doc0.querySelectorAll('*')) {
      if (j < recs.length && recs[j].name === e.tagName.toLowerCase()) map.set(e.getAttribute(ID), recs[j++]);
    }
    return j === recs.length ? map : null;
  }

  const attrsOf = (e) => [...e.attributes].filter((a) => a.name !== ID && a.name !== FROM).map((a) => `${a.name}=${a.value}`).sort().join('\u0001');
  const kids = (e) => [...e.childNodes].filter((n) => n.nodeType === 1 || n.nodeType === 3 || n.nodeType === 8);
  function stripIds(e) {
    const c = e.cloneNode(true);
    [c, ...c.querySelectorAll(`[${ID}],[${FROM}]`)].forEach((x) => { x.removeAttribute(ID); x.removeAttribute(FROM); });
    return c.outerHTML;
  }

  const escText = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');

  // So bản gốc với bản đang sửa: chỉ thay đúng đoạn mã đã đổi, phần còn lại giữ nguyên từng ký tự.
  function patchSource(src, root) {
    const doc0 = new DOMParser().parseFromString(src, 'text/html');
    doc0.querySelectorAll('*').forEach((e, i) => e.setAttribute(ID, i));
    const map = mapSource(src, doc0);
    if (!map) return null;
    const id = (e) => e.getAttribute(ID);
    const ref = (e) => e.getAttribute(ID) || e.getAttribute(FROM); // phần tử gốc, hoặc phần tử được sao ra nó
    const byId = new Map([root, ...root.querySelectorAll(`[${ID}]`)].map((e) => [id(e), e]));
    const byId0 = new Map([...doc0.querySelectorAll(`[${ID}]`)].map((e) => [id(e), e]));
    const sameShape = (a, b, ka, kb, key = id) => attrsOf(a) === attrsOf(b) && ka.length === kb.length && ka.every((x, i) => {
      const y = kb[i];
      if (x.nodeType !== y.nodeType) return false;
      if (x.nodeType !== 1) return x.data === y.data;
      return id(x) === key(y);
    });
    // Mã cho phần tử b (bản đang sửa) có gốc là a: giữ mã gốc, chỉ thay phần con đã đổi.
    const srcOf = (a, b) => {
      const r = map.get(id(a));
      if (!r || attrsOf(a) !== attrsOf(b)) return stripIds(b);
      if (r.empty) return src.slice(r.start, r.end);
      if (r.closeStart == null) return stripIds(b);
      const ka = kids(a);
      const kb = kids(b);
      if (sameShape(a, b, ka, kb, ref)) {
        let s = '';
        let pos = r.start;
        for (let i = 0; i < ka.length; i++) {
          if (ka[i].nodeType !== 1) continue;
          const rx = map.get(id(ka[i]));
          if (!rx) return stripIds(b);
          s += src.slice(pos, rx.start) + srcOf(ka[i], kb[i]);
          pos = rx.end;
        }
        return s + src.slice(pos, r.end);
      }
      const raw = RAW.has(b.tagName.toLowerCase());
      const inner = kb.map((y) => {
        if (y.nodeType === 3) return raw ? y.data : escText(y.data);
        if (y.nodeType === 8) return `<!--${y.data}-->`;
        const x = ref(y) != null ? byId0.get(ref(y)) : null;
        return x && map.get(id(x)) ? srcOf(x, y) : stripIds(y); // phần cũ giữ mã gốc, phần mới thêm thì tạo mã
      }).join('');
      return src.slice(r.start, r.openEnd) + inner + src.slice(r.closeStart, r.end);
    };
    const edits = [];
    // html, head, body không có trong mã gốc: chỉ đi xuống các phần tử con.
    const walk = (a) => {
      const b = byId.get(id(a));
      if (!b) return false;
      const r = map.get(id(a));
      if (r) {
        const t = srcOf(a, b);
        if (t !== src.slice(r.start, r.end)) edits.push([r.start, r.end, t]);
        return true;
      }
      const ka = kids(a);
      const kb = kids(b);
      if (!sameShape(a, b, ka, kb)) return false;
      return ka.every((x) => x.nodeType !== 1 || walk(x));
    };
    if (!walk(doc0.documentElement)) return null;
    let out = src;
    edits.sort((x, y) => y[0] - x[0]).forEach(([s, e, t]) => { out = out.slice(0, s) + t + out.slice(e); });
    return out;
  }

  // Dạng chuẩn để kiểm tra: hai mã cho ra cùng một trang hay không.
  function canon(n) {
    if (n.nodeType === 8) return `c${n.data}`;
    if (n.nodeType !== 1) return '';
    let out = '';
    let text = ''; // các đoạn chữ liền nhau gộp làm một (như khi trình duyệt đọc lại mã)
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { text += c.data; continue; }
      if (text) { out += `t${text}`; text = ''; }
      out += canon(c);
    }
    if (text) out += `t${text}`;
    return `<${n.tagName}${attrsOf(n)}>${out}</>`;
  }

  function buildHtml() {
    const root = cleanRoot(true);
    syncAuto(root);
    syncJourney(root);
    const full = () => { const r = root.cloneNode(true); [r, ...r.querySelectorAll(`[${ID}],[${FROM}]`)].forEach((x) => { x.removeAttribute(ID); x.removeAttribute(FROM); }); return r; };
    const patched = S.orig ? patchSource(S.orig, root) : null;
    if (patched !== null) {
      const check = new DOMParser().parseFromString(patched, 'text/html').documentElement;
      if (canon(check) === canon(full())) return patched;
      console.warn('Lưu từng phần không khớp, chuyển sang ghi cả trang.');
    }
    return `<!doctype html>\n${full().outerHTML}\n`;
  }

  async function save(force = false) {
    if (S.saving || !S.doc) return;
    endEdit();
    if (!S.dirty && !force) { toast('Không có thay đổi nào để lưu.'); return; }
    let html;
    try { html = buildHtml(); } catch (e) { toast(e.message, true, 8000); return; }
    S.saving = true;
    $('#btn-save').disabled = true;
    $('#btn-save').textContent = 'Đang lưu…';
    try {
      const d = await api('page', { method: 'POST', json: { html, mtime: S.mtime, force } });
      S.mtime = d.mtime;
      S.savedAt = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      if (d.html !== html) await loadPage(d.html, true); // máy chủ vừa cập nhật thêm (vd. dung lượng tệp zip)
      setDirty(false);
      toast('Đã lưu. Trang thật đã cập nhật; bản cũ được cất trong "Bản lưu".');
    } catch (e) {
      if (e.status === 409 && confirm(`${e.message}\n\nBấm OK để lưu đè bằng nội dung đang sửa ở đây.`)) {
        S.saving = false;
        $('#btn-save').textContent = 'Lưu thay đổi';
        return save(true);
      }
      if (e.status === 401) { toast('Hết phiên đăng nhập. Hãy đăng nhập lại ở tab mới rồi bấm Lưu lần nữa (thay đổi vẫn còn ở đây).', true, 9000); window.open('/admin/', '_blank'); } else toast(e.message, true, 8000);
    } finally {
      S.saving = false;
      $('#btn-save').textContent = 'Lưu thay đổi';
      setDirty(S.dirty);
    }
  }

  /* ================= giao diện chung ================= */
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('is-on', p.dataset.panel === name));
    if (name === 'history') loadBackups();
    if (name === 'files') renderFiles();
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('[data-device]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-device]').forEach((x) => x.classList.toggle('is-on', x === b));
    $('#canvas').classList.toggle('is-phone', b.dataset.device === 'phone');
  }));
  $('#btn-save').addEventListener('click', () => save());
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#files-filter').addEventListener('input', renderFiles);
  $('#up-input').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) uploadMany(fs); });
  $('#btn-logout').addEventListener('click', async () => {
    if (S.dirty && !confirm('Có thay đổi chưa lưu. Vẫn đăng xuất?')) return;
    await api('logout', { method: 'POST' }).catch(() => {});
    S.dirty = false;
    location.reload();
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('#pw-new').value !== $('#pw-new2').value) { toast('Hai lần nhập mật khẩu mới không khớp.', true); return; }
    try {
      await api('password', { method: 'POST', json: { current: $('#pw-cur').value, password: $('#pw-new').value } });
      e.target.reset();
      toast('Đã đổi mật khẩu.');
    } catch (ex) { toast(ex.message, true); }
  });
  document.addEventListener('keydown', keys);
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // Cho phép kiểm thử tự động gọi vài hàm.
  window.cstAdmin = { syncAuto, setKind, S, save, select, undo, buildHtml, mutate, insertCopy, attachPdf, uploadImage, applyImage, patchSource, sourceRanges, mapSource, cleanRoot, canon };

  // Điện thoại: chỉ hiện thông báo "Chỉ dùng trên máy tính", không tải trình sửa.
  const PHONE = '(max-width: 760px), (hover: none) and (pointer: coarse) and (max-height: 500px)';
  const phoneQuery = window.matchMedia(PHONE);
  if (!phoneQuery.matches) boot();
  else phoneQuery.addEventListener('change', function wake(e) {
    if (e.matches) return;
    phoneQuery.removeEventListener('change', wake);
    boot();
  });
})();
