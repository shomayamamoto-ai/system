'use strict';
// 面談・相談予約システムのサーバー。外部ライブラリなしで動く。
//   起動:  node server.js   （PORT / ADMIN_PASSWORD / DATA_FILE を環境変数で指定できる）

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./lib/core');
const { analyze } = require('./lib/analytics');

const { AppError } = core;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function createServer({ dataFile, adminPassword } = {}) {
  const store = new core.Store(dataFile);
  const db = () => store.db;

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
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
      try { resolve(JSON.parse(text)); } catch { reject(new AppError('送信データの形式が正しくありません。')); }
    });
    req.on('error', reject);
  });
  const isAdmin = (req) => {
    if (!adminPassword) return true;
    const given = Buffer.from(String(req.headers['x-admin-password'] || ''));
    const want = Buffer.from(adminPassword);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
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

  async function api(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;
    const m = req.method;
    const d = db();

    // ----- お客様向け -----
    if (m === 'GET' && p === '/api/public/config') {
      return send(res, 200, {
        services: d.services, staff: d.staff.map((s) => ({ id: s.id, name: s.name })),
        windowDays: d.settings.windowDays, today: core.nowJST().date,
      });
    }
    if (m === 'GET' && p === '/api/public/slots') {
      const slots = core.freeSlots(d, { date: q.get('date'), serviceId: q.get('serviceId'), staffId: q.get('staffId') });
      return send(res, 200, { slots: slots.map((s) => s.start) });
    }
    if (m === 'POST' && p === '/api/public/bookings') {
      const b = core.createBooking(d, await readBody(req));
      store.save();
      return send(res, 201, publicBooking(b));
    }
    if (m === 'GET' && p === '/api/public/booking') {
      const b = d.bookings.find((x) => x.id === q.get('id') && x.token === q.get('token'));
      if (!b) throw new AppError('予約が見つかりません。', 404);
      return send(res, 200, publicBooking(b));
    }
    if (m === 'POST' && p === '/api/public/cancel') {
      const body = await readBody(req);
      const b = core.cancelByCustomer(d, body.id, body.token);
      store.save();
      return send(res, 200, publicBooking(b));
    }

    // ----- 管理者向け -----
    if (!p.startsWith('/api/admin/')) throw new AppError('見つかりません。', 404);
    if (!isAdmin(req)) throw new AppError('パスワードが必要です。', 401);

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
      if (!core.isDate(from) || !core.isDate(to)) throw new AppError('期間の指定が正しくありません。');
      return send(res, 200, {
        bookings: d.bookings.filter((b) => b.date >= from && b.date <= to).map(adminBooking),
        blocks: d.blocks.filter((k) => k.date >= from && k.date <= to)
          .map((k) => Object.assign({}, k, { start: core.toHM(k.start), end: core.toHM(k.end) })),
      });
    }
    let match = /^\/api\/admin\/bookings\/([\w-]+)$/.exec(p);
    if (m === 'PATCH' && match) {
      const b = core.setBookingStatus(d, match[1], (await readBody(req)).status);
      store.save();
      return send(res, 200, adminBooking(b));
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
    throw new AppError('見つかりません。', 404);
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ページが見つかりません');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      let pathname = '/__invalid__';
      try { pathname = decodeURIComponent(url.pathname); } catch { /* 壊れたURLは404にする */ }
      return serveStatic(res, pathname);
    }
    api(req, res, url).catch((err) => {
      if (err instanceof AppError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'サーバーでエラーが起きました。時間をおいてもう一度お試しください。' });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  createServer({ dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'), adminPassword })
    .listen(port, () => {
      console.log(`予約ページ:  http://localhost:${port}/`);
      console.log(`管理画面:    http://localhost:${port}/admin`);
      if (!adminPassword) console.log('注意: ADMIN_PASSWORD が未設定のため、管理画面は誰でも開けます。');
    });
}

module.exports = { createServer };
