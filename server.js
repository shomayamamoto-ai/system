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
const { forecast } = require('./lib/forecast');
const wl = require('./lib/waitlist');
const { riskModel } = require('./lib/risk');
const { createMailer, buildMail, buildStaffMail, dueReminders, dueCatchUp, stillRelevant } = require('./lib/mailer');

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
// 失敗だけを数える版: blocked() で止まっているかを調べ、fail() で失敗を1回ぶん数える
function failLimiter(max, windowMs) {
  const hits = new Map();
  const live = (key) => { const h = hits.get(key); return h && h.reset >= Date.now() ? h : null; };
  return {
    blocked: (key) => { const h = live(key); return Boolean(h && h.count >= max); },
    fail: (key) => {
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < Date.now()) hits.delete(k);
      const h = live(key) || { count: 0, reset: Date.now() + windowMs };
      h.count++;
      hits.set(key, h);
    },
  };
}

function createServer({ dataFile, adminPassword, trustProxy, limits, publicUrl, mailer } = {}) {
  const store = new core.Store(dataFile);
  // 保存のたびに版を1つ進める（空き状況の使い回しを、データが変わったら捨てるため）
  let version = 0;
  const rawSave = store.save.bind(store);
  store.save = () => { version++; rawSave(); };
  const availCache = new Map();
  const db = () => store.db;
  const mail = mailer || createMailer();
  const sessions = new Map(); // ログイン中の合言葉 → { user, exp }
  const L = Object.assign({ api: 300, booking: 10, login: 8 }, limits);
  const allowApi = limiter(L.api, 60 * 1000);              // 全API: 1分に300回まで
  const allowBooking = limiter(L.booking, 10 * 60 * 1000); // 予約・変更・キャンセル: 10分に10回まで
  const loginByIp = failLimiter(L.login, 15 * 60 * 1000);         // ログインの失敗: 同じ接続元から15分に8回まで
  const loginById = failLimiter(L.loginId || 20, 15 * 60 * 1000); // 同じログインIDでの失敗: 15分に20回まで
  const allowResend = limiter(3, 10 * 60 * 1000);          // メールの送り直し: 同じ予約へ10分に3回まで
  const allowExportLog = limiter(1, 60 * 1000);            // 書き出しの履歴は、1人につき1分に1行まで
  // ログイン失敗は1件ずつ残さず、10分ごとに回数をまとめて1行にする（履歴を失敗で埋めつくされないため）
  let failRow = null;
  let failUntil = 0;
  function noteLoginFailure(d) {
    if (!failRow || Date.now() > failUntil || !d.audit.includes(failRow)) {
      auth.audit(d, null, 'ログイン失敗', '1回');
      failRow = d.audit[d.audit.length - 1];
      failRow.count = 1;
      failUntil = Date.now() + 10 * 60 * 1000;
    } else {
      failRow.count++;
      failRow.detail = `${failRow.count}回（10分間の合計）`;
    }
  }

  // パスワードもアカウントもなければ、だれでも開ける「お試し」の状態
  // この状態を許すのは、サーバーと同じ機械から直接開いたときだけ。公開用の設定がある場合は許さない
  const hasAccounts = () => Boolean(adminPassword) || db().users.length > 0;
  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const isProtected = (req) => hasAccounts() || httpsSite || !isLocal(req);
  const OPEN_USER = { id: 'open', name: '（ログインなし）', role: 'owner' };

  // X-Forwarded-For の左側は利用者が自由に書けるので使わない。手前のプロキシが足した「いちばん右」を接続元とみなす
  const rawIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';
  // IPv6 は1人で大量の番号を持てるので、上位64ビット（/64）ごとにまとめて数える
  const ipOf = (req) => {
    const ip = rawIp(req).replace(/^::ffff:/, '');
    if (!ip.includes(':')) return ip;
    const [head, tail = ''] = ip.split('::');
    const a = head ? head.split(':') : [];
    const b = tail ? tail.split(':') : [];
    const full = a.concat(Array(Math.max(0, 8 - a.length - b.length)).fill('0'), b);
    return full.slice(0, 4).join(':') + '::/64';
  };
  const httpsSite = Boolean(trustProxy) || /^https:/i.test(publicUrl || ''); // プロキシの後ろ、または公開URLが https なら HTTPS 運用とみなす
  const isHttps = () => httpsSite;
  const send = (res, status, body, headers) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS,
      httpsSite ? { 'Strict-Transport-Security': 'max-age=15552000' } : null, headers));
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
    if (!isProtected(req)) return OPEN_USER;
    const sid = sidOf(req);
    const s = sid && sessions.get(sid);
    if (!s) return null;
    if (s.exp < Date.now()) { sessions.delete(sid); return null; }
    return s.user;
  };

  // ----- メール -----
  let lastMailError = 0;
  const RETRY_AFTER_MIN = [10, 60, 360]; // 失敗したメールは、10分後・1時間後・6時間後に送り直す（3回まで）
  // 予約ごとに「いつ・何を送ったか」を残す（直近20件）
  function logMail(b, kind, ok, retry) {
    if (!Array.isArray(b.mails)) b.mails = [];
    b.mails.push({ at: new Date().toISOString(), kind, ok, retry: retry || undefined });
    if (b.mails.length > 20) b.mails.splice(0, b.mails.length - 20);
  }
  async function sendMail(kind, b, opts = {}) {
    if (!mail.enabled || !b.email || !['web', 'admin'].includes(b.source)) return false;
    const d = db();
    try {
      await mail.send(buildMail(kind, d, b, publicUrl));
      logMail(b, kind, true, opts.retry);
      d.outbox = d.outbox.filter((o) => o.bookingId !== b.id); // 新しいメールが届いたら、古い送り直しは不要
      store.save();
      return true;
    } catch (err) {
      console.error('メール送信に失敗:', err.message);
      logMail(b, kind, false, opts.retry);
      // 予約確認・変更・キャンセルは、あとで送り直す（リマインドは次の確認のときにもう一度試す）
      if (['confirm', 'change', 'cancel'].includes(kind)) {
        const attempts = (opts.attempts || 0) + 1;
        d.outbox = d.outbox.filter((o) => o.bookingId !== b.id);
        if (attempts <= RETRY_AFTER_MIN.length) {
          d.outbox.push({ bookingId: b.id, kind, attempts, nextAt: Date.now() + RETRY_AFTER_MIN[attempts - 1] * 60000 });
        }
      }
      if (Date.now() - lastMailError > 3600 * 1000) { // 同じ知らせが並ばないよう、1時間に1回まで
        lastMailError = Date.now();
        core.notify(d, 'mail_error', 'メールを送れませんでした',
          `${b.customerName} 様あてのメール送信に失敗しました。時間をおいて自動で送り直します。続く場合は、設定でメールの設定を確認してください。（${String(err.message).slice(0, 120)}）`);
      }
      store.save();
      if (opts.rethrow) throw err;
      return false;
    }
  }
  const mailLater = (kind, b) => { sendMail(kind, b); }; // 応答を待たせないよう、送信は裏で行う
  // お客様の操作（予約・変更・キャンセル）を、設定した通知先へメールで知らせる
  const tellStaff = (kind, b) => {
    if (!mail.enabled || !db().settings.mail.notifyTo) return;
    mail.send(buildStaffMail(kind, db(), b, publicUrl)).catch((err) => console.error('担当者あてメールの送信に失敗:', err.message));
  };
  // 定期的に行うメールの仕事: 失敗したメールの送り直し → 前日リマインド → 送りそこねた分の当日リマインド
  // キャンセル待ち: 空きが出たら、登録の早い順に1人ずつ枠を取り置いて知らせる（予約が空いたとき・1分ごとの確認のときに呼ぶ）
  let checkingWaitlist = false;
  const waitMails = []; // 直近1時間に送ったキャンセル待ちのメールの時刻（送りすぎを防ぐ）
  const WAIT_MAILS_PER_HOUR = 60;
  const canSendWaitMail = () => {
    const hour = Date.now() - 3600 * 1000;
    while (waitMails.length && waitMails[0] < hour) waitMails.shift();
    if (waitMails.length >= WAIT_MAILS_PER_HOUR) return false;
    waitMails.push(Date.now());
    return true;
  };
  async function checkWaitlist(now = new Date()) {
    if (!mail.enabled || checkingWaitlist) return 0;
    checkingWaitlist = true;
    try {
      const d = db();
      let sent = 0;
      const before = JSON.stringify([d.holds || [], (d.waitlist || []).map((w) => w.status)]);
      for (const { w, hold } of wl.makeOffers(d, now)) {
        try {
          if (!canSendWaitMail()) throw new Error('キャンセル待ちのメールが1時間の上限に達しました');
          await mail.send(wl.buildWaitlistMail('offer', d, w, hold, publicUrl));
          sent++;
        } catch (err) {
          // 送れなかったときは取り置きを外し、次の確認でもう一度ご案内する
          console.error('キャンセル待ちのお知らせの送信に失敗:', err.message);
          wl.releaseHold(d, w);
          w.status = 'waiting';
          delete w.offeredAt;
        }
      }
      if (sent) noteCount(d, 'waitlist_offer', 'キャンセル待ちの方へ、空きをご案内しました', '人（枠を30分取り置き中）');
      if (sent || before !== JSON.stringify([d.holds || [], (d.waitlist || []).map((w) => w.status)])) store.save();
      return sent;
    } finally { checkingWaitlist = false; }
  }
  // 同じ種類のお知らせは、1時間ごとに1行へまとめて件数だけ増やす（通知の一覧を埋めつくさないため）
  const counters = new Map();
  function noteCount(d, type, title, unit) {
    const c = counters.get(type);
    if (c && Date.now() - c.at < 3600 * 1000 && d.notifications.includes(c.row)) {
      c.n++;
      c.row.body = `直近1時間で ${c.n}${unit}`;
      c.row.read = false;
      return;
    }
    const row = core.notify(d, type, title, `直近1時間で 1${unit}`);
    counters.set(type, { at: Date.now(), n: 1, row });
  }
  const kickWaitlist = () => { setImmediate(() => checkWaitlist().catch((e) => console.error(e))); };

  // キャンセルの起きやすさの予測（計算が重めなので、1分間は結果を使い回す）
  let riskCache = null;
  function risk(now = new Date()) {
    if (riskCache && Date.now() - riskCache.at < 60000 && riskCache.size === db().bookings.length) return riskCache.value;
    const value = riskModel(db(), now);
    // 古いデータで作った予測が、新しいデータで「当てずっぽう」より十分よく当たったときだけ、印を付けてよいとみなす
    value.reliable = Boolean(value.ready && value.check && value.check.auc != null && value.check.auc >= 0.6);
    riskCache = { at: Date.now(), size: db().bookings.length, value };
    return value;
  }

  async function runReminders(now = new Date()) {
    if (!mail.enabled) return 0;
    const d = db();
    for (const o of d.outbox.filter((x) => x.nextAt <= now.getTime())) {
      const b = d.bookings.find((x) => x.id === o.bookingId);
      d.outbox = d.outbox.filter((x) => x !== o);
      if (stillRelevant(o.kind, b, now)) await sendMail(o.kind, b, { retry: true, attempts: o.attempts });
    }
    await checkWaitlist(now);
    let sent = 0;
    for (const [kind, list] of [['remind', dueReminders(d, now)], ['remind_today', dueCatchUp(d, now)]]) {
      for (const b of list) {
        if (await sendMail(kind, b)) { b.remindedAt = now.toISOString(); sent++; }
      }
    }
    // キャンセルになりやすい予約には、3日前にも確認のメールを送る（設定で有効にしたとき。予測の見分ける力が十分なときだけ）
    if (d.settings.mail.riskConfirm) {
      const r = risk(now);
      if (r.reliable) {
        const target = core.addDays(core.nowJST(now).date, 3);
        for (const x of r.upcoming.filter((u) => u.level === 'high' && u.date === target)) {
          const b = d.bookings.find((y) => y.id === x.id);
          if (b && b.status === 'booked' && !b.riskMailedAt && await sendMail('confirm3', b)) { b.riskMailedAt = now.toISOString(); sent++; }
        }
      }
    }
    store.save();
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
        site: d.settings.site, questions: d.settings.questions, waitlist: mail.enabled,
        services: d.services, staff: d.staff.map((s) => ({ id: s.id, name: s.name })),
        windowDays: d.settings.windowDays, today: core.nowJST().date,
      });
    }
    if (m === 'GET' && p === '/api/public/availability') {
      // 計算が重めなので、データが変わっていなければ5秒間は同じ結果を使い回す（日時変更中の問い合わせは使い回さない）
      const own = ownBooking();
      const key = [q.get('from'), q.get('to'), q.get('serviceId'), q.get('staffId')].join('|');
      const hit = !own && availCache.get(key);
      if (hit && hit.version === version && Date.now() - hit.at < 5000) return send(res, 200, { days: hit.days });
      const days = core.availability(d, { from: q.get('from'), to: q.get('to'), serviceId: q.get('serviceId'), staffId: q.get('staffId'), exceptBookingId: own });
      if (!own) {
        if (availCache.size > 500) availCache.clear();
        availCache.set(key, { at: Date.now(), version, days });
      }
      return send(res, 200, { days });
    }
    if (m === 'GET' && p === '/api/public/slots') {
      const slots = core.freeSlots(d, { date: q.get('date'), serviceId: q.get('serviceId'), staffId: q.get('staffId'), exceptBookingId: ownBooking() });
      return send(res, 200, { slots: slots.map((s) => s.start) });
    }
    if (m === 'POST' && p === '/api/public/bookings') {
      busy();
      const body = await readBody(req);
      let b;
      if (body.holdId) {
        // 取り置きの枠で予約する: 取り置きを外してから、その枠で予約を作る（失敗したら取り置きを戻す）
        const h = wl.holdByToken(d, body.holdId, body.holdToken);
        d.holds = d.holds.filter((x) => x !== h);
        try {
          b = core.createBooking(d, Object.assign({}, body, { serviceId: h.serviceId, staffId: h.staffId, date: h.date, start: core.toHM(h.start) }));
        } catch (err) { d.holds.push(h); throw err; }
        const w = (d.waitlist || []).find((x) => x.id === h.waitlistId);
        if (w) { w.status = 'booked'; delete w.holdId; }
      } else {
        b = core.createBooking(d, body);
      }
      store.save();
      mailLater('confirm', b);
      tellStaff('confirm', b);
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
      tellStaff('change', b);
      kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
      return send(res, 200, publicBooking(b));
    }
    if (m === 'POST' && p === '/api/public/cancel') {
      busy();
      const body = await readBody(req);
      const b = core.cancelByCustomer(d, body.id, body.token);
      store.save();
      mailLater('cancel', b);
      tellStaff('cancel', b);
      kickWaitlist();
      return send(res, 200, publicBooking(b));
    }
    if (m === 'POST' && p === '/api/public/waitlist') {
      busy();
      if (!mail.enabled) throw new AppError('キャンセル待ちは、いまは受け付けていません。', 409);
      const { entry: w, created } = wl.addWaitlist(d, await readBody(req));
      // 重複・上限のときは登録もメールもしないが、返事は同じにする（登録の有無を外から調べられないように）
      if (created) {
        noteCount(d, 'waitlist', 'キャンセル待ちの登録がありました', '件');
        store.save();
        if (canSendWaitMail()) mail.send(wl.buildWaitlistMail('accepted', d, w, null, publicUrl)).catch((err) => console.error('キャンセル待ちの受付メールの送信に失敗:', err.message));
      }
      return send(res, 201, { date: w.date, part: w.part, status: 'waiting' });
    }
    if (m === 'GET' && p === '/api/public/waitlist') {
      const w = wl.findByToken(d, q.get('id'), q.get('token'));
      return send(res, 200, { id: w.id, date: w.date, part: wl.PARTS[w.part], status: w.status, customerName: w.customerName,
        serviceName: (core.findService(d, w.serviceId) || {}).name || '' });
    }
    if (m === 'POST' && p === '/api/public/waitlist/cancel') {
      busy();
      const body = await readBody(req);
      const w = wl.cancelWaitlist(d, body.id, body.token);
      store.save();
      kickWaitlist(); // 取り置き中だった枠を、次の人へ回す
      return send(res, 200, { id: w.id, status: w.status });
    }
    if (m === 'GET' && p === '/api/public/hold') {
      const h = wl.holdByToken(d, q.get('id'), q.get('token'));
      const w = (d.waitlist || []).find((x) => x.id === h.waitlistId) || {};
      return send(res, 200, { id: h.id, date: h.date, start: core.toHM(h.start), end: core.toHM(h.end), serviceId: h.serviceId, staffId: h.staffId,
        serviceName: (core.findService(d, h.serviceId) || {}).name || '', staffName: (core.findStaff(d, h.staffId) || {}).name || '',
        expiresAt: new Date(h.expiresAt).toISOString(), customerName: w.customerName || '', email: w.email || '' });
    }

    // ----- 管理者向け -----
    if (!p.startsWith('/api/admin/')) throw new AppError('見つかりません。', 404);

    if (m === 'GET' && p === '/api/admin/session') {
      const u = userOf(req);
      return send(res, 200, { loggedIn: Boolean(u), protected: isProtected(req), user: u && { name: u.name, role: u.role } });
    }
    if (m === 'POST' && p === '/api/admin/login') {
      if (loginByIp.blocked(ip)) throw new AppError('ログインの失敗が続いたため、一時的に止めています。15分ほど待ってからお試しください。', 429);
      if (!hasAccounts()) throw new AppError('サーバーにパスワードが設定されていません。ADMIN_PASSWORD を設定して起動し直してください。', 503);
      const body = await readBody(req);
      const loginId = core.clean(body.loginId, 30);
      // 接続元を変えながらの総当たりに備えて、ログインIDごとにも回数を数える
      if (loginById.blocked(loginId.toLowerCase())) throw new AppError('このログインIDでの失敗が続いたため、一時的に止めています。15分ほど待ってからお試しください。', 429);
      const user = await auth.authenticate(d, body.loginId, body.password, adminPassword);
      if (!user) {
        loginByIp.fail(ip);
        loginById.fail(loginId.toLowerCase());
        noteLoginFailure(d);
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
        overrides: (d.overrides || []).filter((o) => o.date >= core.nowJST().date),
        today: core.nowJST().date, protected: isProtected(req), user: { name: me.name, role: me.role, builtin: me.id === 'admin' || me.id === 'open' },
        mail: { enabled: mail.enabled, from: mail.from, hasPublicUrl: Boolean(publicUrl) },
      });
    }
    if (m === 'PUT' && p === '/api/admin/config') {
      ownerOnly();
      core.updateConfig(d, await readBody(req));
      log('設定を変更', '担当者・メニュー・受け付け方');
      kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/calendar') {
      const from = q.get('from');
      const to = q.get('to');
      if (!core.isDate(from) || !core.isDate(to) || core.diffDays(to, from) > 62) throw new AppError('期間の指定が正しくありません。');
      return send(res, 200, {
        bookings: (() => {
          // 予測の見分ける力が十分なときだけ、キャンセルになりやすい予約に印を付ける
          const r = risk();
          const byId = new Map(r.reliable ? r.upcoming.map((x) => [x.id, x]) : []);
          return d.bookings.filter((b) => b.date >= from && b.date <= to).map((b) => {
            const x = byId.get(b.id);
            return Object.assign(adminBooking(b), x ? { risk: { p: x.p, level: x.level, reasons: x.reasons } } : {});
          });
        })(),
        blocks: d.blocks.filter((k) => k.date >= from && k.date <= to).concat(core.expandRecurring(d, from, to))
          .concat((d.holds || []).filter((h) => h.date >= from && h.date <= to).map((h) => ({ id: h.id, hold: true, staffId: h.staffId, date: h.date, start: h.start, end: h.end, title: 'キャンセル待ちの方へ取り置き中', expiresAt: new Date(h.expiresAt).toISOString() }))).map(hm),
        closedDays: d.closedDays.filter((c) => c.date >= from && c.date <= to),
        // 日ごと・担当者ごとの稼働率（カレンダーで「8割」を超えた日を目立たせるため）
        loads: (() => {
          const out = {};
          for (let day = from; day <= to; day = core.addDays(day, 1)) {
            out[day] = {};
            for (const st of d.staff) {
              const l = core.dayLoad(d, st, day);
              const h = core.dayHours(d, st, day);
              if (l.capacity || l.booked || h) {
                out[day][st.id] = { booked: l.booked, capacity: l.capacity, open: h ? h.open : null, close: h ? h.close : null, override: Boolean(core.overrideFor(d, st.id, day)) };
              }
            }
          }
          return out;
        })(),
        loadCap: d.settings.loadCap == null ? 80 : d.settings.loadCap,
      });
    }
    if (m === 'GET' && p === '/api/admin/bookings') {
      const r = core.searchBookings(d, { q: q.get('q'), from: optDate(q.get('from')), to: optDate(q.get('to')), status: q.get('status') });
      return send(res, 200, { total: r.total, bookings: r.bookings.map(adminBooking) });
    }
    if (m === 'POST' && p === '/api/admin/bookings') {
      const b = core.createBooking(d, await readBody(req), new Date(), { admin: true });
      log('予約を追加', say(b));
      // 管理画面からは上限を超えても登録できる。そのかわり、超えたことを知らせる
      const l = core.dayLoad(d, core.findStaff(d, b.staffId), b.date);
      const capNow = d.settings.loadCap == null ? 80 : d.settings.loadCap;
      const loadWarning = l.capacity && l.booked / l.capacity > Math.min(capNow, 80) / 100 ? Math.round((l.booked / l.capacity) * 100) : undefined;
      store.save();
      mailLater('confirm', b);
      return send(res, 201, Object.assign(adminBooking(b), { loadWarning }));
    }
    match = /^\/api\/admin\/bookings\/([\w-]+)$/.exec(p);
    if (m === 'PATCH' && match) {
      const body = await readBody(req);
      let b;
      if (body.actual && typeof body.actual === 'object') {
        b = core.setActual(d, match[1], body.actual);
        log('実際の面談時間を記録', `${say(b)}${b.actualStart == null ? '（取り消し）' : `→ 実際 ${core.toHM(b.actualStart)}〜${b.actualEnd == null ? '' : core.toHM(b.actualEnd)}`}`);
      } else if (typeof body.memo === 'string') {
        b = core.setMemo(d, match[1], body.memo);
        log('面談メモを保存', say(b));
      } else if (body.status) {
        b = core.setBookingStatus(d, match[1], body.status);
        log('予約の状態を変更', `${say(b)} →「${{ booked: '予約済', completed: '完了', noshow: '無断キャンセル', cancelled: 'キャンセル' }[b.status]}」`);
        if (b.status === 'cancelled' && b.date >= core.nowJST().date) mailLater('cancel', b);
        kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
      } else {
        b = core.rescheduleBooking(d, match[1], body);
        log('予約の日時を変更', say(b));
        mailLater('change', b);
        kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
      }
      store.save();
      return send(res, 200, adminBooking(b));
    }
    match = /^\/api\/admin\/bookings\/([\w-]+)\/mail$/.exec(p);
    if (m === 'POST' && match) { // 予約確認メールを、手動で送り直す
      const b = d.bookings.find((x) => x.id === match[1]);
      if (!b) throw new AppError('予約が見つかりません。', 404);
      if (!mail.enabled) throw new AppError('メール送信が設定されていません。');
      if (!b.email) throw new AppError('この予約には、メールアドレスが登録されていません。');
      if (b.status !== 'booked') throw new AppError('送り直せるのは「予約済」の予約だけです。', 409);
      if (!['web', 'admin'].includes(b.source)) throw new AppError('CSVで読み込んだ予約とサンプルには、メールを送れません。', 409);
      if (!allowResend(b.id)) throw new AppError('同じ予約への送り直しは、10分に3回までです。', 429);
      try {
        await sendMail('confirm', b, { retry: true, rethrow: true, attempts: RETRY_AFTER_MIN.length });
      } catch (err) {
        throw new AppError(`送信できませんでした。メールの設定を確認してください。（${String(err.message).slice(0, 160)}）`, 502);
      }
      log('予約確認メールを送り直し', say(b));
      store.save();
      return send(res, 200, adminBooking(b));
    }
    if (m === 'GET' && p === '/api/admin/waitlist') {
      const today = core.nowJST().date;
      const holdOf = (w) => (d.holds || []).find((h) => h.id === w.holdId);
      const list = (d.waitlist || []).filter((w) => w.date >= today && ['waiting', 'offered'].includes(w.status))
        .sort((x, y) => (x.date === y.date ? (x.createdAt < y.createdAt ? -1 : 1) : x.date < y.date ? -1 : 1))
        .map((w) => ({ id: w.id, date: w.date, part: wl.PARTS[w.part], status: w.status, customerName: w.customerName, email: w.email,
          serviceName: (core.findService(d, w.serviceId) || {}).name || '', staffName: w.staffId === 'any' ? '指名なし' : (core.findStaff(d, w.staffId) || {}).name || '',
          createdAt: w.createdAt, offeredAt: w.offeredAt, holdUntil: holdOf(w) ? new Date(holdOf(w).expiresAt).toISOString() : null,
          holdTime: holdOf(w) ? `${core.toHM(holdOf(w).start)}〜${core.toHM(holdOf(w).end)}` : null }));
      return send(res, 200, { waitlist: list, enabled: mail.enabled });
    }
    match = /^\/api\/admin\/waitlist\/([\w-]+)$/.exec(p);
    if (m === 'DELETE' && match) {
      const w = (d.waitlist || []).find((x) => x.id === match[1]);
      if (!w) throw new AppError('キャンセル待ちの登録が見つかりません。', 404);
      wl.releaseHold(d, w);
      w.status = 'cancelled';
      kickWaitlist(); // 取り置き中だった枠を、次の人へ回す
      log('キャンセル待ちを削除', `${w.date}／${w.customerName} 様`);
      store.save();
      return send(res, 200, { ok: true });
    }
    match = /^\/api\/admin\/holds\/([\w-]+)$/.exec(p);
    if (m === 'DELETE' && match) { // 取り置きを解除して、次の方へ回す
      const w = (d.waitlist || []).find((x) => x.holdId === match[1]);
      if (!w) throw new AppError('取り置きが見つかりません。', 404);
      wl.releaseHold(d, w);
      w.status = 'missed';
      log('取り置きを解除', `${w.date}／${w.customerName} 様`);
      store.save();
      kickWaitlist();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/customers') {
      return send(res, 200, core.customers(d, q.get('q')));
    }
    if (m === 'GET' && p === '/api/admin/export') {
      const csv = core.exportCsv(d, optDate(q.get('from')), optDate(q.get('to')));
      if (allowExportLog(me.id)) {
        log('CSVを書き出し', `${q.get('from') || '最初'}〜${q.get('to') || '最後'}`);
        store.save();
      }
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
      kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/overrides') {
      ownerOnly();
      const o = core.setOverride(d, await readBody(req));
      const who = (core.findStaff(d, o.staffId) || {}).name;
      log('特定の日の受付時間を設定', `${o.date}／${who}／${o.off ? '休み' : `${core.toHM(o.start)}〜${core.toHM(o.end)}`}`);
      kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
      store.save();
      return send(res, 201, o);
    }
    match = /^\/api\/admin\/overrides\/([\w-]+)$/.exec(p);
    if (m === 'DELETE' && match) {
      ownerOnly();
      const o = (d.overrides || []).find((x) => x.id === match[1]);
      if (!o) throw new AppError('設定が見つかりません。', 404);
      // 元の受付時間に戻すと予約が受付時間の外になる場合は止める
      const tmp = d.overrides.filter((x) => x !== o);
      const staff = core.findStaff(d, o.staffId);
      const back = staff && core.dayHours(Object.assign({}, d, { overrides: tmp }), staff, o.date);
      const outside = d.bookings.filter((b) => b.staffId === o.staffId && b.date === o.date && b.status === 'booked' &&
        (!back || b.start < back.open || b.end > back.close || back.rests.some(([x, y]) => core.overlaps(b.start, b.end, x, y))));
      if (outside.length) throw new AppError(`元の受付時間に戻すと、予約 ${outside.length}件が受付時間の外になります。先に予約を調整してください。`, 409);
      d.overrides = tmp;
      log('特定の日の受付時間を削除', `${o.date}／${staff ? staff.name : ''}`);
      kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
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
    if (m === 'POST' && p === '/api/admin/closed/holidays') {
      ownerOnly();
      const r = core.addHolidays(d, (await readBody(req)).year);
      log('祝日をまとめて登録', `追加 ${r.added.length}件／スキップ ${r.skipped.length}件`);
      store.save();
      return send(res, 200, r);
    }
    match = /^\/api\/admin\/closed\/(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (m === 'DELETE' && match) {
      ownerOnly();
      d.closedDays = d.closedDays.filter((c) => c.date !== match[1]);
      log('休業日を削除', match[1]);
      kickWaitlist(); // 空きが出たかもしれないので、キャンセル待ちを確認する
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
    if (m === 'PUT' && p === '/api/admin/me/password') {
      const body = await readBody(req);
      auth.changeOwnPassword(d, me.id, body.current, body.next);
      for (const [sid, s] of sessions) if (s.user.id === me.id && sid !== sidOf(req)) sessions.delete(sid); // ほかの端末のログインは切る
      log('自分のパスワードを変更', '');
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/risk') {
      const r = risk();
      return send(res, 200, Object.assign({}, r, { upcoming: r.upcoming.map((x) => Object.assign({}, x, { start: core.toHM(x.start) })) }));
    }
    if (m === 'GET' && p === '/api/admin/forecast') {
      return send(res, 200, forecast(d));
    }
    if (m === 'GET' && p === '/api/admin/analytics') {
      const today = core.nowJST().date;
      // month=YYYY-MM なら、その月の1日〜末日（今月なら今日まで）を集計する
      const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') && core.isDate(q.get('month') + '-01') ? q.get('month') : '';
      if (month) {
        const first = month + '-01';
        const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
        const last = core.addDays(next, -1);
        const to = last > today && first <= today ? today : last;
        // 比べる相手は「前の月」。今月の途中なら、前の月の同じ日までと比べる
        const prevFirst = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
        const prevLast = core.addDays(first, -1);
        const sameDay = core.addDays(prevFirst, core.diffDays(to, first));
        return send(res, 200, analyze(d, first, to, new Date(), false, { from: prevFirst, to: to === last || sameDay > prevLast ? prevLast : sameDay }));
      }
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
      for (const [sid, s] of sessions) if (s.user.id === u.id && sid !== sidOf(req)) sessions.delete(sid);
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
      if (!/^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/.test(to)) throw new AppError('メールアドレスの形式が正しくありません。');
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
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch { // 「//」のような壊れたアドレスは、ここで受け止める（放っておくとサーバーごと止まる）
      res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
      return res.end('リクエストの形式が正しくありません');
    }
    if (url.pathname === '/healthz') { // 監視用: サーバーが動いているかだけを返す
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('ok');
    }
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
    // 取り置きの期限切れと、次の人へのご案内は1分ごとに確認する
    const holdTimer = setInterval(() => checkWaitlist().catch((e) => console.error(e)), 60 * 1000);
    holdTimer.unref();
    server.on('close', () => { clearInterval(timer); clearInterval(holdTimer); });
  }
  server.checkWaitlist = checkWaitlist;
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
  // 止める合図を受けたら、処理中の応答を終えてから終了する
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log('サーバーを停止します。');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

module.exports = { createServer };
