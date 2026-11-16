'use strict';
// 面談・相談予約システムのサーバー。外部ライブラリなしで動く。
//   起動:  node server.js
//   環境変数: PORT / ADMIN_PASSWORD / DATA_FILE / TRUST_PROXY（プロキシの後ろで動かすとき 1）

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./lib/core');
const { analyze, updateRules } = require('./lib/analytics');

const { AppError } = core;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const SESSION_HOURS = 12;
// どの応答にも付ける安全用のヘッダー
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', // 予約確認リンクが外部サイトへ漏れないようにする
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// 一定時間あたりの回数を数えて、多すぎるアクセスを止める
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count++;
    return h.count <= max;
  };
}

function createServer({ dataFile, adminPassword, trustProxy, limits } = {}) {
  const store = new core.Store(dataFile);
  const db = () => store.db;
  const sessions = new Map(); // ログイン中の合言葉 → 有効期限
  const L = Object.assign({ api: 300, booking: 10, login: 8 }, limits);
  const allowApi = limiter(L.api, 60 * 1000);              // 全API: 1分に300回まで
  const allowBooking = limiter(L.booking, 10 * 60 * 1000); // 予約・キャンセル: 10分に10回まで
  const allowLogin = limiter(L.login, 15 * 60 * 1000);     // ログイン: 15分に8回まで

  const ipOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const isHttps = (req) => Boolean(trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const send = (res, status, body, headers) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS, headers));
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 3 * 1024 * 1024) { reject(new AppError('データが大きすぎます（3MBまで）。', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const data = JSON.parse(text);
        resolve(data && typeof data === 'object' ? data : {});
      } catch { reject(new AppError('送信データの形式が正しくありません。')); }
    });
    req.on('error', reject);
  });

  // ----- ログイン -----
  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const sidOf = (req) => (/(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || '') || [])[1];
  const cookie = (req, value, maxAge) => `sid=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  const isAdmin = (req) => {
    if (!adminPassword) return true;
    const sid = sidOf(req);
    const exp = sid && sessions.get(sid);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(sid); return false; }
    return true;
  };

  // お客様に見せてよい項目だけを返す
  const publicBooking = (b) => {
    const d = db();
    return {
      id: b.id, token: b.token, date: b.date, start: core.toHM(b.start), end: core.toHM(b.end), status: b.status,
      customerName: b.customerName,
      serviceName: (d.services.find((v) => v.id === b.serviceId) || {}).name || '',
      staffName: (d.staff.find((s) => s.id === b.staffId) || {}).name || '',
    };
  };
  const adminBooking = (b) => Object.assign({}, b, { token: undefined, start: core.toHM(b.start), end: core.toHM(b.end) });
  const optDate = (v) => {
    if (!v) return '';
    if (!core.isDate(v)) throw new AppError('日付の指定が正しくありません。');
    return v;
  };

  async function api(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;
    const m = req.method;
    const d = db();
    const ip = ipOf(req);

    if (!allowApi(ip)) throw new AppError('アクセスが集中しています。1分ほど待ってからもう一度お試しください。', 429);
    // 書き込みは JSON だけ受け付ける（ほかのサイトに置かれたフォームからの送信を防ぐ）
    if (m !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new AppError('送信データの形式が正しくありません。', 415);
    }

    // ----- お客様向け -----
    if (m === 'GET' && p === '/api/public/config') {
      return send(res, 200, {
        services: d.services, staff: d.staff.map((s) => ({ id: s.id, name: s.name })),
        windowDays: d.settings.windowDays, today: core.nowJST().date,
      });
    }
    if (m === 'GET' && p === '/api/public/availability') {
      return send(res, 200, { days: core.availability(d, { from: q.get('from'), to: q.get('to'), serviceId: q.get('serviceId'), staffId: q.get('staffId') }) });
    }
    if (m === 'GET' && p === '/api/public/slots') {
      const slots = core.freeSlots(d, { date: q.get('date'), serviceId: q.get('serviceId'), staffId: q.get('staffId') });
      return send(res, 200, { slots: slots.map((s) => s.start) });
    }
    if (m === 'POST' && p === '/api/public/bookings') {
      if (!allowBooking(ip)) throw new AppError('短い時間に予約の操作が続いたため、一時的に受付を止めています。10分ほど待ってからお試しください。', 429);
      const b = core.createBooking(d, await readBody(req));
      store.save();
      return send(res, 201, publicBooking(b));
    }
    if (m === 'GET' && p === '/api/public/booking') {
      const token = String(q.get('token') || '');
      const b = d.bookings.find((x) => x.id === q.get('id'));
      const ok = b && b.token && token.length === b.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(b.token));
      if (!ok) throw new AppError('予約が見つかりません。', 404);
      return send(res, 200, publicBooking(b));
    }
    if (m === 'POST' && p === '/api/public/cancel') {
      if (!allowBooking(ip)) throw new AppError('短い時間に操作が続いたため、一時的に受付を止めています。10分ほど待ってからお試しください。', 429);
      const body = await readBody(req);
      const b = core.cancelByCustomer(d, body.id, body.token);
      store.save();
      return send(res, 200, publicBooking(b));
    }

    // ----- 管理者向け -----
    if (!p.startsWith('/api/admin/')) throw new AppError('見つかりません。', 404);

    if (m === 'GET' && p === '/api/admin/session') {
      return send(res, 200, { loggedIn: isAdmin(req), protected: Boolean(adminPassword) });
    }
    if (m === 'POST' && p === '/api/admin/login') {
      if (!allowLogin(ip)) throw new AppError('ログインの失敗が続いたため、一時的に止めています。15分ほど待ってからお試しください。', 429);
      const body = await readBody(req);
      if (!adminPassword || typeof body.password !== 'string' || !crypto.timingSafeEqual(sha(body.password), sha(adminPassword))) {
        throw new AppError('パスワードが違います。', 401);
      }
      const sid = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, Date.now() + SESSION_HOURS * 3600 * 1000);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, sid, SESSION_HOURS * 3600) });
    }
    if (m === 'POST' && p === '/api/admin/logout') {
      sessions.delete(sidOf(req));
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (!isAdmin(req)) throw new AppError('ログインが必要です。', 401);

    if (m === 'GET' && p === '/api/admin/config') {
      return send(res, 200, { settings: d.settings, staff: d.staff, services: d.services, today: core.nowJST().date, protected: Boolean(adminPassword) });
    }
    if (m === 'PUT' && p === '/api/admin/config') {
      core.updateConfig(d, await readBody(req));
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/calendar') {
      const from = q.get('from');
      const to = q.get('to');
      if (!core.isDate(from) || !core.isDate(to) || core.diffDays(to, from) > 62) throw new AppError('期間の指定が正しくありません。');
      return send(res, 200, {
        bookings: d.bookings.filter((b) => b.date >= from && b.date <= to).map(adminBooking),
        blocks: d.blocks.filter((k) => k.date >= from && k.date <= to)
          .map((k) => Object.assign({}, k, { start: core.toHM(k.start), end: core.toHM(k.end) })),
      });
    }
    if (m === 'GET' && p === '/api/admin/bookings') {
      const r = core.searchBookings(d, { q: q.get('q'), from: optDate(q.get('from')), to: optDate(q.get('to')), status: q.get('status') });
      return send(res, 200, { total: r.total, bookings: r.bookings.map(adminBooking) });
    }
    if (m === 'POST' && p === '/api/admin/bookings') {
      const b = core.createBooking(d, await readBody(req), new Date(), { admin: true });
      store.save();
      return send(res, 201, adminBooking(b));
    }
    let match = /^\/api\/admin\/bookings\/([\w-]+)$/.exec(p);
    if (m === 'PATCH' && match) {
      const body = await readBody(req);
      const b = body.status ? core.setBookingStatus(d, match[1], body.status) : core.rescheduleBooking(d, match[1], body);
      store.save();
      return send(res, 200, adminBooking(b));
    }
    if (m === 'GET' && p === '/api/admin/customers') {
      return send(res, 200, core.customers(d, q.get('q')));
    }
    if (m === 'GET' && p === '/api/admin/export') {
      const csv = core.exportCsv(d, optDate(q.get('from')), optDate(q.get('to')));
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="yoyaku-${core.nowJST().date}.csv"`,
      });
    }
    if (m === 'POST' && p === '/api/admin/blocks') {
      const k = core.addBlock(d, await readBody(req));
      store.save();
      return send(res, 201, k);
    }
    match = /^\/api\/admin\/blocks\/([\w-]+)$/.exec(p);
    if (m === 'DELETE' && match) {
      d.blocks = d.blocks.filter((k) => k.id !== match[1]);
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/notifications') {
      const list = d.notifications.slice().reverse();
      return send(res, 200, { unread: list.filter((n) => !n.read).length, notifications: list.slice(0, 100) });
    }
    if (m === 'POST' && p === '/api/admin/notifications/read') {
      d.notifications.forEach((n) => { n.read = true; });
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/import') {
      const result = core.importCsv(d, String((await readBody(req)).csv || ''));
      store.save();
      return send(res, 200, result);
    }
    if (m === 'POST' && p === '/api/admin/sample') {
      const count = core.seedSample(d);
      store.save();
      return send(res, 200, { count });
    }
    if (m === 'DELETE' && p === '/api/admin/sample') {
      const count = core.clearSample(d);
      store.save();
      return send(res, 200, { count });
    }
    if (m === 'GET' && p === '/api/admin/analytics') {
      const today = core.nowJST().date;
      const days = Math.min(730, Math.max(7, Number(q.get('days')) || 90));
      return send(res, 200, analyze(d, core.addDays(today, -(days - 1)), today));
    }
    if (m === 'PUT' && p === '/api/admin/rules') {
      const rules = updateRules(d, await readBody(req));
      store.save();
      return send(res, 200, { rules });
    }
    throw new AppError('見つかりません。', 404);
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
      return res.end('ページが見つかりません');
    }
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      let pathname = '/__invalid__';
      try { pathname = decodeURIComponent(url.pathname); } catch { /* 壊れたURLは404にする */ }
      return serveStatic(res, pathname);
    }
    api(req, res, url).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof AppError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'サーバーでエラーが起きました。時間をおいてもう一度お試しください。' });
    });
  });
  server.requestTimeout = 30000; // 応答しない接続をためこまない
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  createServer({
    dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'),
    adminPassword, trustProxy: process.env.TRUST_PROXY === '1',
  }).listen(port, () => {
    console.log(`予約ページ:  http://localhost:${port}/`);
    console.log(`管理画面:    http://localhost:${port}/admin`);
    if (!adminPassword) console.log('注意: ADMIN_PASSWORD が未設定のため、管理画面は誰でも開けます。');
  });
}

module.exports = { createServer };
