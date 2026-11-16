'use strict';
// 面談・相談予約システムのサーバー。
//   起動:  node server.js
//   環境変数: PORT / ADMIN_PASSWORD / DATA_FILE / TRUST_PROXY / PUBLIC_URL
//             メール送信: SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./lib/core');
const auth = require('./lib/auth');
const { analyze, updateRules } = require('./lib/analytics');
const { createMailer, buildMail, dueReminders } = require('./lib/mailer');

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

function createServer({ dataFile, adminPassword, trustProxy, limits, publicUrl, mailer } = {}) {
  const store = new core.Store(dataFile);
  const db = () => store.db;
  const mail = mailer || createMailer();
  const sessions = new Map(); // ログイン中の合言葉 → { user, exp }
  const L = Object.assign({ api: 300, booking: 10, login: 8 }, limits);
  const allowApi = limiter(L.api, 60 * 1000);              // 全API: 1分に300回まで
  const allowBooking = limiter(L.booking, 10 * 60 * 1000); // 予約・変更・キャンセル: 10分に10回まで
  const allowLogin = limiter(L.login, 15 * 60 * 1000);     // ログイン: 15分に8回まで

  // パスワードもアカウントもなければ、だれでも開ける「お試し」の状態
  const isProtected = () => Boolean(adminPassword) || db().users.length > 0;
  const OPEN_USER = { id: 'open', name: '（ログインなし）', role: 'owner' };

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
  const sidOf = (req) => (/(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || '') || [])[1];
  const cookie = (req, value, maxAge) => `sid=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  const userOf = (req) => {
    if (!isProtected()) return OPEN_USER;
    const sid = sidOf(req);
    const s = sid && sessions.get(sid);
    if (!s) return null;
    if (s.exp < Date.now()) { sessions.delete(sid); return null; }
    return s.user;
  };

  // ----- メール -----
  let lastMailError = 0;
  async function sendMail(kind, b) {
    if (!mail.enabled || !b.email || !['web', 'admin'].includes(b.source)) return false;
    try {
      await mail.send(buildMail(kind, db(), b, publicUrl));
      return true;
    } catch (err) {
      console.error('メール送信に失敗:', err.message);
      if (Date.now() - lastMailError > 3600 * 1000) { // 同じ知らせが並ばないよう、1時間に1回まで
        lastMailError = Date.now();
        core.notify(db(), 'mail_error', 'メールを送れませんでした',
          `${b.customerName} 様あてのメール送信に失敗しました。設定タブでメールの設定を確認してください。（${String(err.message).slice(0, 120)}）`);
        store.save();
      }
      return false;
    }
  }
  const mailLater = (kind, b) => { sendMail(kind, b); }; // 応答を待たせないよう、送信は裏で行う
  async function runReminders(now = new Date()) {
    if (!mail.enabled) return 0;
    let sent = 0;
    for (const b of dueReminders(db(), now)) {
      if (await sendMail('remind', b)) { b.remindedAt = now.toISOString(); sent++; }
    }
    if (sent) store.save();
    return sent;
  }

  // お客様に見せてよい項目だけを返す
  const publicBooking = (b) => {
    const d = db();
    const blocked = core.changeBlockedReason(d, b);
    return {
      id: b.id, token: b.token, date: b.date, start: core.toHM(b.start), end: core.toHM(b.end), status: b.status,
      customerName: b.customerName, serviceId: b.serviceId,
      serviceName: (core.findService(d, b.serviceId) || {}).name || '',
      staffName: (core.findStaff(d, b.staffId) || {}).name || '',
      canChange: !blocked, blockedReason: b.status === 'booked' ? blocked : '',
      mailSent: mail.enabled,
    };
  };
  const adminBooking = (b) => Object.assign({}, b, { token: undefined, start: core.toHM(b.start), end: core.toHM(b.end) });
  const hm = (k) => Object.assign({}, k, { start: core.toHM(k.start), end: core.toHM(k.end) });
  const say = (b) => `${b.date} ${core.toHM(b.start)}〜／${b.customerName} 様`;
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
    const busy = () => { if (!allowBooking(ip)) throw new AppError('短い時間に操作が続いたため、一時的に受付を止めています。10分ほど待ってからお試しください。', 429); };
    // 日時変更のときは、自分の予約が入っている枠を「空き」として扱う
    const ownBooking = () => (q.get('bookingId') ? core.bookingByToken(d, q.get('bookingId'), q.get('token')).id : undefined);

    // ----- お客様向け -----
    if (m === 'GET' && p === '/api/public/config') {
      return send(res, 200, {
        site: d.settings.site,
        services: d.services, staff: d.staff.map((s) => ({ id: s.id, name: s.name })),
        windowDays: d.settings.windowDays, today: core.nowJST().date,
      });
    }
    if (m === 'GET' && p === '/api/public/availability') {
      return send(res, 200, { days: core.availability(d, { from: q.get('from'), to: q.get('to'), serviceId: q.get('serviceId'), staffId: q.get('staffId'), exceptBookingId: ownBooking() }) });
    }
    if (m === 'GET' && p === '/api/public/slots') {
      const slots = core.freeSlots(d, { date: q.get('date'), serviceId: q.get('serviceId'), staffId: q.get('staffId'), exceptBookingId: ownBooking() });
      return send(res, 200, { slots: slots.map((s) => s.start) });
    }
    if (m === 'POST' && p === '/api/public/bookings') {
      busy();
      const b = core.createBooking(d, await readBody(req));
      store.save();
      mailLater('confirm', b);
      return send(res, 201, publicBooking(b));
    }
    if (m === 'GET' && p === '/api/public/booking') {
      return send(res, 200, publicBooking(core.bookingByToken(d, q.get('id'), q.get('token'))));
    }
    if (m === 'GET' && p === '/api/public/ics') {
      const b = core.bookingByToken(d, q.get('id'), q.get('token'));
      return send(res, 200, core.buildIcs(d, b), { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="yoyaku.ics"' });
    }
    if (m === 'POST' && p === '/api/public/reschedule') {
      busy();
      const body = await readBody(req);
      const b = core.rescheduleByCustomer(d, body.id, body.token, body);
      store.save();
      mailLater('change', b);
      return send(res, 200, publicBooking(b));
    }
    if (m === 'POST' && p === '/api/public/cancel') {
      busy();
      const body = await readBody(req);
      const b = core.cancelByCustomer(d, body.id, body.token);
      store.save();
      mailLater('cancel', b);
      return send(res, 200, publicBooking(b));
    }

    // ----- 管理者向け -----
    if (!p.startsWith('/api/admin/')) throw new AppError('見つかりません。', 404);

    if (m === 'GET' && p === '/api/admin/session') {
      const u = userOf(req);
      return send(res, 200, { loggedIn: Boolean(u), protected: isProtected(), user: u && { name: u.name, role: u.role } });
    }
    if (m === 'POST' && p === '/api/admin/login') {
      if (!allowLogin(ip)) throw new AppError('ログインの失敗が続いたため、一時的に止めています。15分ほど待ってからお試しください。', 429);
      const body = await readBody(req);
      const user = auth.authenticate(d, body.loginId, body.password, adminPassword);
      if (!user) {
        auth.audit(d, null, 'ログイン失敗', `ログインID: ${core.clean(body.loginId, 30)}`);
        store.save();
        throw new AppError('ログインIDまたはパスワードが違います。', 401);
      }
      const sid = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, { user, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
      auth.audit(d, user, 'ログイン', '');
      store.save();
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, sid, SESSION_HOURS * 3600) });
    }
    if (m === 'POST' && p === '/api/admin/logout') {
      sessions.delete(sidOf(req));
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    const me = userOf(req);
    if (!me) throw new AppError('ログインが必要です。', 401);
    const ownerOnly = () => { if (me.role !== 'owner') throw new AppError('この操作は「管理者」権限のアカウントだけが行えます。', 403); };
    const log = (action, detail) => auth.audit(d, me, action, detail);
    let match;

    if (m === 'GET' && p === '/api/admin/config') {
      return send(res, 200, {
        settings: d.settings, staff: d.staff, services: d.services, closedDays: d.closedDays,
        today: core.nowJST().date, protected: isProtected(), user: { name: me.name, role: me.role },
        mail: { enabled: mail.enabled, from: mail.from, hasPublicUrl: Boolean(publicUrl) },
      });
    }
    if (m === 'PUT' && p === '/api/admin/config') {
      ownerOnly();
      core.updateConfig(d, await readBody(req));
      log('設定を変更', '担当者・メニュー・受け付け方');
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/calendar') {
      const from = q.get('from');
      const to = q.get('to');
      if (!core.isDate(from) || !core.isDate(to) || core.diffDays(to, from) > 62) throw new AppError('期間の指定が正しくありません。');
      return send(res, 200, {
        bookings: d.bookings.filter((b) => b.date >= from && b.date <= to).map(adminBooking),
        blocks: d.blocks.filter((k) => k.date >= from && k.date <= to).concat(core.expandRecurring(d, from, to)).map(hm),
        closedDays: d.closedDays.filter((c) => c.date >= from && c.date <= to),
      });
    }
    if (m === 'GET' && p === '/api/admin/bookings') {
      const r = core.searchBookings(d, { q: q.get('q'), from: optDate(q.get('from')), to: optDate(q.get('to')), status: q.get('status') });
      return send(res, 200, { total: r.total, bookings: r.bookings.map(adminBooking) });
    }
    if (m === 'POST' && p === '/api/admin/bookings') {
      const b = core.createBooking(d, await readBody(req), new Date(), { admin: true });
      log('予約を追加', say(b));
      store.save();
      mailLater('confirm', b);
      return send(res, 201, adminBooking(b));
    }
    match = /^\/api\/admin\/bookings\/([\w-]+)$/.exec(p);
    if (m === 'PATCH' && match) {
      const body = await readBody(req);
      let b;
      if (body.status) {
        b = core.setBookingStatus(d, match[1], body.status);
        log('予約の状態を変更', `${say(b)} →「${{ booked: '予約済', completed: '完了', noshow: '無断キャンセル', cancelled: 'キャンセル' }[b.status]}」`);
        if (b.status === 'cancelled') mailLater('cancel', b);
      } else {
        b = core.rescheduleBooking(d, match[1], body);
        log('予約の日時を変更', say(b));
        mailLater('change', b);
      }
      store.save();
      return send(res, 200, adminBooking(b));
    }
    if (m === 'GET' && p === '/api/admin/customers') {
      return send(res, 200, core.customers(d, q.get('q')));
    }
    if (m === 'GET' && p === '/api/admin/export') {
      const csv = core.exportCsv(d, optDate(q.get('from')), optDate(q.get('to')));
      log('CSVを書き出し', `${q.get('from') || '最初'}〜${q.get('to') || '最後'}`);
      store.save();
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="yoyaku-${core.nowJST().date}.csv"`,
      });
    }
    if (m === 'POST' && p === '/api/admin/blocks') {
      const k = core.addBlock(d, await readBody(req));
      log(k.from ? '毎週の予定を追加' : '予定を追加', `${k.from || k.date} ${core.toHM(k.start)}〜${core.toHM(k.end)}／${k.title}`);
      store.save();
      return send(res, 201, k);
    }
    match = /^\/api\/admin\/(blocks|recurring)\/([\w-]+)$/.exec(p);
    if (m === 'DELETE' && match) {
      const key = match[1];
      const item = d[key].find((k) => k.id === match[2]);
      d[key] = d[key].filter((k) => k.id !== match[2]);
      if (item) log(key === 'recurring' ? '毎週の予定を削除' : '予定を削除', item.title);
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/closed') {
      ownerOnly();
      const c = core.addClosedDay(d, await readBody(req));
      log('休業日を追加', `${c.date}／${c.title}`);
      store.save();
      return send(res, 201, c);
    }
    match = /^\/api\/admin\/closed\/(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (m === 'DELETE' && match) {
      ownerOnly();
      d.closedDays = d.closedDays.filter((c) => c.date !== match[1]);
      log('休業日を削除', match[1]);
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
    if (m === 'GET' && p === '/api/admin/analytics') {
      const today = core.nowJST().date;
      const days = Math.min(730, Math.max(7, Number(q.get('days')) || 90));
      return send(res, 200, analyze(d, core.addDays(today, -(days - 1)), today));
    }

    // ----- ここから下は「管理者」権限だけ -----
    ownerOnly();
    if (m === 'POST' && p === '/api/admin/import') {
      const result = core.importCsv(d, String((await readBody(req)).csv || ''));
      log('CSVを読み込み', `取り込み ${result.imported}件／スキップ ${result.skipped.length}件`);
      store.save();
      return send(res, 200, result);
    }
    if (m === 'POST' && p === '/api/admin/sample') {
      const count = core.seedSample(d);
      log('サンプルを登録', `${count}件`);
      store.save();
      return send(res, 200, { count });
    }
    if (m === 'DELETE' && p === '/api/admin/sample') {
      const count = core.clearSample(d);
      log('サンプルを削除', `${count}件`);
      store.save();
      return send(res, 200, { count });
    }
    if (m === 'PUT' && p === '/api/admin/rules') {
      const rules = updateRules(d, await readBody(req));
      log('分析の目安を変更', '');
      store.save();
      return send(res, 200, { rules });
    }
    if (m === 'GET' && p === '/api/admin/users') {
      return send(res, 200, { users: d.users.map(auth.publicUser), builtin: Boolean(adminPassword) });
    }
    if (m === 'POST' && p === '/api/admin/users') {
      const u = auth.addUser(d, await readBody(req), { needOwner: !adminPassword && !d.users.length });
      log('アカウントを追加', `${u.name}（${u.loginId}／${auth.ROLES[u.role]}）`);
      store.save();
      // お試し状態から最初のアカウントを作ったら、その場でその人としてログインした状態にする
      if (me === OPEN_USER) {
        const sid = crypto.randomBytes(24).toString('hex');
        sessions.set(sid, { user: u, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
        return send(res, 201, u, { 'Set-Cookie': cookie(req, sid, SESSION_HOURS * 3600) });
      }
      return send(res, 201, u);
    }
    match = /^\/api\/admin\/users\/([\w-]+)$/.exec(p);
    if (m === 'DELETE' && match) {
      const u = auth.removeUser(d, match[1], { keepOwner: !adminPassword });
      for (const [sid, s] of sessions) if (s.user.id === u.id) sessions.delete(sid); // その人のログインも切る
      log('アカウントを削除', `${u.name}（${u.loginId}）`);
      store.save();
      return send(res, 200, { ok: true });
    }
    match = /^\/api\/admin\/users\/([\w-]+)\/password$/.exec(p);
    if (m === 'PUT' && match) {
      const u = auth.resetPassword(d, match[1], (await readBody(req)).password);
      for (const [sid, s] of sessions) if (s.user.id === u.id && s.user.id !== me.id) sessions.delete(sid);
      log('パスワードを変更', `${u.name}（${u.loginId}）`);
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/audit') {
      return send(res, 200, { total: d.audit.length, audit: d.audit.slice(-300).reverse() });
    }
    if (m === 'POST' && p === '/api/admin/mail/test') {
      if (!mail.enabled) throw new AppError('メール送信が設定されていません。README の「メールを送る設定」をご覧ください。');
      const to = core.clean((await readBody(req)).to, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new AppError('メールアドレスの形式が正しくありません。');
      try {
        await mail.send({ to, subject: `【${d.settings.site.name}】テスト送信`, text: 'これはテスト送信です。このメールが届いていれば、メールの設定は正しく動いています。' });
      } catch (err) {
        throw new AppError(`送信できませんでした。SMTP の設定を確認してください。（${String(err.message).slice(0, 160)}）`, 502);
      }
      log('テストメールを送信', to);
      store.save();
      return send(res, 200, { ok: true });
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

  // 前日リマインドは10分ごとに確認する
  if (mail.enabled) {
    const timer = setInterval(() => runReminders().catch((e) => console.error(e)), 10 * 60 * 1000);
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  server.runReminders = runReminders;
  server.mailEnabled = mail.enabled;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  const server = createServer({
    dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'),
    adminPassword, trustProxy: process.env.TRUST_PROXY === '1', publicUrl: process.env.PUBLIC_URL || '',
  });
  server.listen(port, () => {
    console.log(`予約ページ:  http://localhost:${port}/`);
    console.log(`管理画面:    http://localhost:${port}/admin`);
    console.log(`メール送信:  ${server.mailEnabled ? '有効' : '未設定（SMTP_HOST と MAIL_FROM を設定すると有効になります）'}`);
    if (!adminPassword) console.log('注意: ADMIN_PASSWORD が未設定です。アカウントを作るまで、管理画面は誰でも開けます。');
  });
}

module.exports = { createServer };
