'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');
const core = require('../lib/core');

async function boot(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoyaku-'));
  const dataFile = path.join(dir, 'db.json');
  const server = createServer(Object.assign({ dataFile }, options));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (p, method = 'GET', body, headers = {}) => fetch(base + p, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined,
  });
  return { dir, dataFile, req, server, close: () => { server.close(); server.closeAllConnections(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('ログイン: パスワードなしでは管理APIを使えず、ログイン後は使える', async () => {
  const s = await boot({ adminPassword: 'secret-pass' });
  try {
    assert.equal((await s.req('/api/admin/config')).status, 401);
    assert.equal((await s.req('/api/admin/export')).status, 401);
    assert.deepEqual(await (await s.req('/api/admin/session')).json(), { loggedIn: false, protected: true, user: null });
    assert.equal((await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'wrong' })).status, 401);
    assert.equal((await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: ['secret-pass'] })).status, 401);

    const login = await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    assert.equal((await s.req('/api/admin/config', 'GET', null, { cookie })).status, 200);
    const csv = await s.req('/api/admin/export', 'GET', null, { cookie });
    assert.match(csv.headers.get('content-type'), /text\/csv/);

    await s.req('/api/admin/logout', 'POST', null, { cookie });
    assert.equal((await s.req('/api/admin/config', 'GET', null, { cookie })).status, 401);
  } finally { s.close(); }
});

test('連続アクセスの制限: ログインと予約は回数を超えると止まる', async () => {
  const s = await boot({ adminPassword: 'secret-pass', limits: { login: 3, booking: 2 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'x' })).status, 401);
    assert.equal((await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' })).status, 429);
    for (let i = 0; i < 2; i++) assert.equal((await s.req('/api/public/bookings', 'POST', {})).status, 400);
    assert.equal((await s.req('/api/public/bookings', 'POST', {})).status, 429);
  } finally { s.close(); }
});

test('安全用ヘッダーが付き、JSON以外の書き込みと不正なパスは拒否する', async () => {
  const s = await boot({});
  try {
    const page = await s.req('/');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const form = await s.req('/api/public/bookings', 'POST', null, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    assert.equal((await s.req('/%2e%2e/server.js')).status, 404);
    assert.equal((await s.req('/api/admin/calendar?from=2020-01-01&to=2026-01-01')).status, 400);
  } finally { s.close(); }
});

test('予約の流れ: 空き状況 → 予約 → 管理画面で日時変更 → お客様の確認', async () => {
  const s = await boot({});
  try {
    const today = core.nowJST().date;
    const days = (await (await s.req(`/api/public/availability?from=${today}&to=${core.addDays(today, 20)}&serviceId=v1&staffId=any`)).json()).days;
    const date = Object.keys(days).sort().find((d) => d > today && days[d] > 0);
    const { slots } = await (await s.req(`/api/public/slots?date=${date}&serviceId=v1&staffId=any`)).json();
    const made = await (await s.req('/api/public/bookings', 'POST', { serviceId: 'v1', staffId: 'any', date, start: slots[0], customerName: '山田', email: 'a@example.com' })).json();
    assert.equal(made.status, 'booked');
    assert.equal((await s.req(`/api/public/booking?id=${made.id}&token=${'0'.repeat(24)}`)).status, 404);

    const moved = await s.req(`/api/admin/bookings/${made.id}`, 'PATCH', { date, start: slots[2] });
    assert.equal(moved.status, 200);
    const seen = await (await s.req(`/api/public/booking?id=${made.id}&token=${made.token}`)).json();
    assert.equal(seen.start, slots[2]);
    const list = await (await s.req('/api/admin/bookings?q=山田')).json();
    assert.equal(list.total, 1);
    assert.equal(list.bookings[0].token, undefined); // 管理画面にも確認用の合言葉は出さない
  } finally { s.close(); }
});

test('バックアップ: 日付が変わって最初の保存で控えを作り、古い控えは14個まで', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoyaku-'));
  try {
    const file = path.join(dir, 'db.json');
    const store = new core.Store(file);
    store.save(); // まだ元ファイルがないので控えは作らない
    assert.ok(!fs.existsSync(path.join(dir, 'backups')));
    fs.mkdirSync(path.join(dir, 'backups'));
    for (let i = 1; i <= 20; i++) fs.writeFileSync(path.join(dir, 'backups', `db-2020-01-${String(i).padStart(2, '0')}.json`), '{}');
    store.lastBackup = null;
    store.db.bookings.push({ id: 'after' });
    store.save();
    const files = fs.readdirSync(path.join(dir, 'backups')).sort();
    assert.equal(files.length, 14);
    assert.equal(files.at(-1), `db-${core.nowJST().date}.json`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backups', files.at(-1)), 'utf8')).bookings.length, 0); // 変更前の状態
    fs.writeFileSync(file, '{こわれたデータ');
    assert.throws(() => new core.Store(file), /読み込めません/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('アカウントと権限: 担当者は設定を変えられず、操作は履歴に残る', async () => {
  const s = await boot({ adminPassword: 'secret-pass' });
  try {
    const loginAs = async (loginId, password) => {
      const r = await s.req('/api/admin/login', 'POST', { loginId, password });
      return r.status === 200 ? { cookie: r.headers.get('set-cookie').split(';')[0] } : null;
    };
    const owner = await loginAs('admin', 'secret-pass');
    assert.equal((await s.req('/api/admin/users', 'POST', { name: '山本', loginId: 'yama', password: 'short', role: 'staff' }, owner)).status, 400);
    assert.equal((await s.req('/api/admin/users', 'POST', { name: '山本', loginId: 'yama', password: 'long-enough-pw', role: 'staff' }, owner)).status, 201);
    assert.equal((await s.req('/api/admin/users', 'POST', { name: '別人', loginId: 'yama', password: 'long-enough-pw', role: 'staff' }, owner)).status, 400);
    assert.equal(await loginAs('yama', 'wrong-password'), null);
    const staff = await loginAs('yama', 'long-enough-pw');

    // 担当者: 予約の操作はできるが、設定・アカウント・履歴・読み込みはできない
    const date = core.addDays(core.nowJST().date, 3);
    const made = await s.req('/api/admin/bookings', 'POST', { serviceId: 'v1', staffId: 's1', date, start: '21:00', customerName: '電話の方' }, staff);
    assert.equal(made.status, 201);
    for (const [path, method] of [['/api/admin/config', 'PUT'], ['/api/admin/users', 'GET'], ['/api/admin/audit', 'GET'], ['/api/admin/import', 'POST'], ['/api/admin/closed', 'POST'], ['/api/admin/rules', 'PUT']]) {
      assert.equal((await s.req(path, method, method === 'GET' ? null : {}, staff)).status, 403, path);
    }
    // 保存されたデータに、パスワードそのものは残っていない
    const raw = fs.readFileSync(s.dataFile, 'utf8');
    assert.ok(!raw.includes('long-enough-pw'));

    const audit = (await (await s.req('/api/admin/audit', 'GET', null, owner)).json()).audit;
    assert.ok(audit.some((a) => a.action === '予約を追加' && a.user === '山本'));
    assert.ok(audit.some((a) => a.action === 'ログイン失敗'));
    assert.ok(audit.some((a) => a.action === 'アカウントを追加' && a.user === '管理者'));

    // アカウントを削除すると、その人のログインも切れる
    const id = (await (await s.req('/api/admin/users', 'GET', null, owner)).json()).users[0].id;
    assert.equal((await s.req(`/api/admin/users/${id}`, 'DELETE', null, owner)).status, 200);
    assert.equal((await s.req('/api/admin/calendar?from=2026-01-01&to=2026-01-07', 'GET', null, staff)).status, 401);
  } finally { s.close(); }
});

test('お試し状態: 最初のアカウントは管理者に限り、作った時点でログインが必要になる', async () => {
  const s = await boot({});
  try {
    assert.equal((await s.req('/api/admin/users', 'POST', { name: 'A', loginId: 'aaa', password: 'long-enough-pw', role: 'staff' })).status, 400);
    const made = await s.req('/api/admin/users', 'POST', { name: 'A', loginId: 'aaa', password: 'long-enough-pw', role: 'owner' });
    assert.equal(made.status, 201);
    const cookie = made.headers.get('set-cookie').split(';')[0];
    assert.equal((await s.req('/api/admin/config')).status, 401);
    assert.equal((await s.req('/api/admin/config', 'GET', null, { cookie })).status, 200);
    const id = (await made.json()).id;
    assert.equal((await s.req(`/api/admin/users/${id}`, 'DELETE', null, { cookie })).status, 400); // 最後の管理者は消せない
  } finally { s.close(); }
});

test('メール: 予約・変更・キャンセルで送られ、前日リマインドは1回だけ送る', async () => {
  const sent = [];
  let fail = false;
  const mailer = { enabled: true, from: 'no-reply@example.com', send: async (m) => { if (fail) throw new Error('接続できません'); sent.push(m); } };
  const s = await boot({ mailer, publicUrl: 'https://yoyaku.example.com/', adminPassword: 'secret-pass' });
  try {
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const today = core.nowJST().date;
    const days = (await (await s.req(`/api/public/availability?from=${today}&to=${core.addDays(today, 20)}&serviceId=v1&staffId=s1`)).json()).days;
    const day5 = Object.keys(days).sort().find((d) => d > core.addDays(today, 2) && days[d] > 3);
    const { slots } = await (await s.req(`/api/public/slots?date=${day5}&serviceId=v1&staffId=s1`)).json();
    const made = await (await s.req('/api/public/bookings', 'POST', { serviceId: 'v1', staffId: 's1', date: day5, start: slots[0], customerName: '山田', email: 'yamada@example.com' })).json();
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'yamada@example.com');
    assert.match(sent[0].subject, /ご予約を受け付けました/);
    assert.ok(sent[0].text.includes(`https://yoyaku.example.com/?id=${made.id}&token=${made.token}`));

    await s.req('/api/public/reschedule', 'POST', { id: made.id, token: made.token, date: day5, start: slots[1] });
    await tick();
    assert.match(sent[1].subject, /変更/);
    assert.ok(sent[1].text.includes(slots[1]));

    // リマインド: 面談の前日、設定した時刻（18時）以降に1回だけ送る
    const dayBefore = core.addDays(day5, -1);
    assert.equal(await s.server.runReminders(new Date(Date.parse(dayBefore + 'T03:00:00Z'))), 0); // 日本時間12時: まだ早い
    assert.equal(await s.server.runReminders(new Date(Date.parse(dayBefore + 'T12:00:00Z'))), 1); // 日本時間21時
    assert.match(sent[2].subject, /明日のご予約/);
    assert.equal(await s.server.runReminders(new Date(Date.parse(dayBefore + 'T12:30:00Z'))), 0); // 2回目は送らない

    await s.req('/api/public/cancel', 'POST', { id: made.id, token: made.token });
    await tick();
    assert.match(sent.at(-1).subject, /キャンセル/);

    // 送信に失敗しても予約は成立し、管理画面に知らせが出る
    fail = true;
    const again = await s.req('/api/public/bookings', 'POST', { serviceId: 'v1', staffId: 's1', date: day5, start: slots[0], customerName: '鈴木', email: 'suzuki@example.com' });
    assert.equal(again.status, 201);
    await tick();
    // 公開用の設定（https）があるときは、ログインなしでは管理APIを使えない
    assert.equal((await s.req('/api/admin/notifications')).status, 401);
    const login = await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' });
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    assert.match(login.headers.get('strict-transport-security'), /max-age/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const notes = (await (await s.req('/api/admin/notifications', 'GET', null, { cookie })).json()).notifications;
    assert.ok(notes.some((n) => n.type === 'mail_error'));
  } finally { s.close(); }
});

test('お客様による変更: 締切を過ぎると変更・キャンセルできない。カレンダー用ファイルを取得できる', async () => {
  const s = await boot({});
  try {
    const today = core.nowJST().date;
    const tomorrow = core.addDays(today, 1);
    const cfg = await (await s.req('/api/admin/config')).json();
    cfg.settings.site = { name: 'やまもと相談室', intro: '初回無料', cancelDeadlineHours: 72 };
    assert.equal((await s.req('/api/admin/config', 'PUT', cfg)).status, 200);
    const pub = await (await s.req('/api/public/config')).json();
    assert.equal(pub.site.name, 'やまもと相談室');

    await s.req('/api/admin/bookings', 'POST', { serviceId: 'v1', staffId: 's1', date: tomorrow, start: '21:00', customerName: '山田', email: 'a@example.com' });
    const db = JSON.parse(fs.readFileSync(s.dataFile, 'utf8'));
    const b = db.bookings[0];
    const seen = await (await s.req(`/api/public/booking?id=${b.id}&token=${b.token}`)).json();
    assert.equal(seen.canChange, false);
    assert.match(seen.blockedReason, /72時間前/);
    assert.equal((await s.req('/api/public/cancel', 'POST', { id: b.id, token: b.token })).status, 409);
    assert.equal((await s.req('/api/public/reschedule', 'POST', { id: b.id, token: b.token, date: tomorrow, start: '10:00' })).status, 409);

    const ics = await s.req(`/api/public/ics?id=${b.id}&token=${b.token}`);
    assert.match(ics.headers.get('content-type'), /text\/calendar/);
    const text = await ics.text();
    assert.ok(text.includes(`DTSTART:${tomorrow.replace(/-/g, '')}T120000Z`)); // 日本時間21:00 = 世界標準時12:00
    assert.ok(text.includes('やまもと相談室'));
    assert.equal((await s.req(`/api/public/ics?id=${b.id}&token=bad`)).status, 404);
  } finally { s.close(); }
});

test('SMTP: 実際にメールサーバーへ接続して送信できる（テスト用の簡易サーバーで確認）', async () => {
  const net = require('node:net');
  const { createMailer } = require('../lib/mailer');
  let received = '';
  const smtp = net.createServer((sock) => {
    let inData = false;
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      const text = chunk.toString();
      if (inData) {
        received += text;
        if (received.endsWith('\r\n.\r\n')) { inData = false; sock.write('250 OK\r\n'); }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        if (/^EHLO/i.test(line)) sock.write('250 test\r\n');
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  try {
    assert.equal(createMailer({}).enabled, false); // 未設定なら無効
    const mailer = createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), MAIL_FROM: 'no-reply@example.com' });
    assert.equal(mailer.enabled, true);
    await mailer.send({ to: 'yamada@example.com', subject: 'テスト件名', text: '本文です' });
    assert.match(received, /From: no-reply@example\.com/);
    assert.match(received, /To: yamada@example\.com/);
  } finally { smtp.close(); }
});

test('担当者への通知・面談メモ・自分のパスワード変更・月次の集計・監視用アドレス', async () => {
  const sent = [];
  const mailer = { enabled: true, from: 'no-reply@example.com', send: async (m) => { sent.push(m); } };
  const s = await boot({ adminPassword: 'secret-pass', mailer, publicUrl: 'https://yoyaku.example.com' });
  try {
    assert.equal(await (await s.req('/healthz')).text(), 'ok');
    const login = async (loginId, password) => ({ cookie: (await s.req('/api/admin/login', 'POST', { loginId, password })).headers.get('set-cookie').split(';')[0] });
    const owner = await login('admin', 'secret-pass');
    const cfg = await (await s.req('/api/admin/config', 'GET', null, owner)).json();
    cfg.settings.mail.notifyTo = 'staff@example.com';
    assert.equal((await s.req('/api/admin/config', 'PUT', cfg, owner)).status, 200);

    const today = core.nowJST().date;
    const days = (await (await s.req(`/api/public/availability?from=${today}&to=${core.addDays(today, 20)}&serviceId=v1&staffId=any`)).json()).days;
    const date = Object.keys(days).sort().find((d) => d > today && days[d] > 0);
    const { slots } = await (await s.req(`/api/public/slots?date=${date}&serviceId=v1&staffId=any`)).json();
    const made = await (await s.req('/api/public/bookings', 'POST', { serviceId: 'v1', staffId: 'any', date, start: slots[0], customerName: '山田', email: 'yamada@example.com', note: '相続の相談' })).json();
    await new Promise((r) => setTimeout(r, 20));
    const toStaff = sent.find((m) => m.to === 'staff@example.com');
    assert.match(toStaff.subject, /新しい予約が入りました/);
    assert.ok(toStaff.text.includes('相続の相談') && toStaff.text.includes('https://yoyaku.example.com/admin'));
    assert.ok(!toStaff.text.includes(made.token)); // お客様用の合言葉は載せない

    // 面談メモは管理画面だけで見え、お客様用の応答には出ない
    assert.equal((await s.req(`/api/admin/bookings/${made.id}`, 'PATCH', { memo: '社外秘のメモ' }, owner)).status, 200);
    const pub = await (await s.req(`/api/public/booking?id=${made.id}&token=${made.token}`)).text();
    assert.ok(!pub.includes('社外秘'));
    assert.ok((await (await s.req('/api/admin/bookings?q=社外秘', 'GET', null, owner)).text()).includes('社外秘のメモ'));

    // 自分のパスワード変更
    await s.req('/api/admin/users', 'POST', { name: '山本', loginId: 'yama', password: 'first-password', role: 'staff' }, owner);
    const staff = await login('yama', 'first-password');
    assert.equal((await s.req('/api/admin/me/password', 'PUT', { current: 'wrong', next: 'second-password' }, staff)).status, 403);
    assert.equal((await s.req('/api/admin/me/password', 'PUT', { current: 'first-password', next: 'short' }, staff)).status, 400);
    assert.equal((await s.req('/api/admin/me/password', 'PUT', { current: 'first-password', next: 'second-password' }, staff)).status, 200);
    assert.equal((await s.req('/api/admin/login', 'POST', { loginId: 'yama', password: 'first-password' })).status, 401);
    assert.equal((await s.req('/api/admin/login', 'POST', { loginId: 'yama', password: 'second-password' })).status, 200);
    assert.equal((await s.req('/api/admin/me/password', 'PUT', { current: 'secret-pass', next: 'another-password' }, owner)).status, 400); // admin は環境変数で変更

    // 月を指定した集計
    const month = today.slice(0, 7);
    const a = await (await s.req(`/api/admin/analytics?month=${month}`, 'GET', null, staff)).json();
    assert.equal(a.period.from, month + '-01');
    assert.equal(a.period.to, today);
    assert.equal((await s.req('/api/admin/closed/holidays', 'POST', { year: 2027 }, staff)).status, 403);
    assert.equal((await (await s.req('/api/admin/closed/holidays', 'POST', { year: Number(today.slice(0, 4)) + 1 }, owner)).json()).added.length > 10, true);
  } finally { s.close(); }
});

test('点検で見つかった問題の再発防止（安全性）', async () => {
  const net = require('node:net');
  const s = await boot({ adminPassword: 'secret-pass', trustProxy: true, limits: { login: 3 } });
  try {
    // 壊れたアドレスを送られても、サーバーは止まらない
    const port = Number(new URL((await s.req('/healthz')).url).port);
    const raw = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let buf = '';
      sock.on('data', (c) => { buf += c; });
      sock.on('close', () => resolve(buf));
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await s.req('/healthz')).status, 200);

    // X-Forwarded-For の左側を書きかえても、回数制限は逃れられない（右端＝プロキシが足した値で数える）
    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'bad' }, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` })).status);
    }
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    // 成功したログインは回数に数えない
    for (let i = 0; i < 5; i++) {
      assert.equal((await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' }, { 'x-forwarded-for': '198.51.100.7' })).status, 200);
    }
    // ログイン失敗は、操作履歴を埋めつくさないよう1行にまとめる
    const cookie = (await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' }, { 'x-forwarded-for': '198.51.100.7' })).headers.get('set-cookie').split(';')[0];
    const audit = (await (await s.req('/api/admin/audit', 'GET', null, { cookie })).json()).audit;
    assert.equal(audit.filter((a) => a.action === 'ログイン失敗').length, 1);
    // CSV書き出しを連打しても、履歴は1分に1行
    for (let i = 0; i < 3; i++) await s.req('/api/admin/export', 'GET', null, { cookie });
    const after = (await (await s.req('/api/admin/audit', 'GET', null, { cookie })).json()).audit;
    assert.equal(after.filter((a) => a.action === 'CSVを書き出し').length, 1);

    // 合言葉に全角文字を入れても、エラー（500）にならず「見つかりません」になる
    const today = core.nowJST().date;
    const made = await (await s.req('/api/admin/bookings', 'POST', { serviceId: 'v1', staffId: 's1', date: core.addDays(today, 2), start: '21:00', customerName: '山田' }, { cookie })).json();
    assert.equal((await s.req(`/api/public/booking?id=${made.id}&token=${encodeURIComponent('あ'.repeat(24))}`)).status, 404);
    // 設定の形が壊れていても 500 にしない。存在しない権限は受け付けない
    assert.equal((await s.req('/api/admin/config', 'PUT', { staff: [null], services: [] }, { cookie })).status, 400);
    assert.equal((await s.req('/api/admin/users', 'POST', { name: 'x', loginId: 'xxx', password: 'long-enough-pw', role: 'constructor' }, { cookie })).status, 400);
    // データファイルは、動かしている本人だけが読める
    assert.equal(fs.statSync(s.dataFile).mode & 0o077, 0);
  } finally { s.close(); }
});

test('お試し状態は同じ機械からだけ。予約ページの悪用（宣伝文の差し込み・枠の買い占め）を防ぐ', async () => {
  const s = await boot({});
  try {
    assert.equal((await (await s.req('/api/admin/session')).json()).protected, false); // テストは 127.0.0.1 から
    const today = core.nowJST().date;
    const days = (await (await s.req(`/api/public/availability?from=${today}&to=${core.addDays(today, 20)}&serviceId=v1&staffId=s1`)).json()).days;
    const date = Object.keys(days).sort().find((d) => d > today && days[d] > 5);
    const { slots } = await (await s.req(`/api/public/slots?date=${date}&serviceId=v1&staffId=s1`)).json();
    const post = (i, over) => s.req('/api/public/bookings', 'POST', Object.assign({ serviceId: 'v1', staffId: 's1', date, start: slots[i], customerName: '山田', email: 'victim@example.org' }, over));
    assert.equal((await post(0, { customerName: 'FREE MONEY http://evil.example/x' })).status, 400);
    assert.equal((await post(0, { email: 'a,b<c>@example.org' })).status, 400);
    const ok = await (await post(0, { customerName: '山田\n■ 当選のお知らせ', note: '1行目\n2行目' })).json();
    assert.equal(ok.customerName, '山田 ■ 当選のお知らせ'); // 名前の改行は空白になる
    assert.equal((await post(1)).status, 201);
    assert.equal((await post(2)).status, 201);
    assert.equal((await post(3)).status, 409); // 同じメールアドレスでは3件まで
    assert.equal((await post(3, { email: 'other@example.org' })).status, 201);
  } finally { s.close(); }
});

test('メールの送り直し: 失敗を記録し、時間をおいて自動で送り直す。手動でも送り直せる', async () => {
  const sent = [];
  let fail = true;
  const mailer = { enabled: true, from: 'no-reply@example.com', send: async (m) => { if (fail) throw new Error('接続できません'); sent.push(m); } };
  const s = await boot({ mailer, adminPassword: 'secret-pass' });
  try {
    const cookie = (await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' })).headers.get('set-cookie').split(';')[0];
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const date = core.addDays(core.nowJST().date, 3);
    const made = await (await s.req('/api/admin/bookings', 'POST', { serviceId: 'v1', staffId: 's1', date, start: '21:00', customerName: '山田', email: 'yamada@example.com' }, { cookie })).json();
    await tick();
    const read = async () => (await (await s.req(`/api/admin/bookings?q=山田`, 'GET', null, { cookie })).json()).bookings[0];
    assert.deepEqual((await read()).mails.map((x) => [x.kind, x.ok]), [['confirm', false]]);
    assert.equal(JSON.parse(fs.readFileSync(s.dataFile, 'utf8')).outbox.length, 1);

    // 10分たつ前は送り直さない。10分後に送り直し、成功したら待ち行列から消える
    fail = false;
    await s.server.runReminders(new Date(Date.now() + 5 * 60000));
    assert.equal(sent.length, 0);
    await s.server.runReminders(new Date(Date.now() + 11 * 60000));
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /ご予約を受け付けました/);
    assert.deepEqual((await read()).mails.map((x) => [x.kind, x.ok, Boolean(x.retry)]), [['confirm', false, false], ['confirm', true, true]]);
    assert.equal(JSON.parse(fs.readFileSync(s.dataFile, 'utf8')).outbox.length, 0);

    // 手動の送り直し（10分に3回まで）。お客様用の応答には、メールの記録を出さない
    for (let i = 0; i < 3; i++) assert.equal((await s.req(`/api/admin/bookings/${made.id}/mail`, 'POST', {}, { cookie })).status, 200);
    assert.equal((await s.req(`/api/admin/bookings/${made.id}/mail`, 'POST', {}, { cookie })).status, 429);
    assert.equal(sent.length, 4);
    const db = JSON.parse(fs.readFileSync(s.dataFile, 'utf8'));
    const pub = await (await s.req(`/api/public/booking?id=${made.id}&token=${db.bookings[0].token}`)).text();
    assert.ok(!pub.includes('mails'));

    // 送り直しを待つ間にキャンセルされた予約には、「予約確認」を送らない
    fail = true;
    const other = await (await s.req('/api/admin/bookings', 'POST', { serviceId: 'v1', staffId: 's2', date, start: '21:00', customerName: '佐藤', email: 'sato@example.com' }, { cookie })).json();
    await tick();
    await s.req(`/api/admin/bookings/${other.id}`, 'PATCH', { status: 'cancelled' }, { cookie });
    await tick();
    fail = false;
    const before = sent.length;
    await s.server.runReminders(new Date(Date.now() + 11 * 60000));
    assert.deepEqual(sent.slice(before).map((m) => m.subject.includes('キャンセル')), [true]); // キャンセルの知らせだけが届く
  } finally { s.close(); }
});

test('特定の日の受付時間: 管理者だけが設定でき、カレンダーに反映される', async () => {
  const s = await boot({ adminPassword: 'secret-pass' });
  try {
    const owner = { cookie: (await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' })).headers.get('set-cookie').split(';')[0] };
    await s.req('/api/admin/users', 'POST', { name: '山本', loginId: 'yama', password: 'long-enough-pw', role: 'staff' }, owner);
    const staff = { cookie: (await s.req('/api/admin/login', 'POST', { loginId: 'yama', password: 'long-enough-pw' })).headers.get('set-cookie').split(';')[0] };
    const date = core.addDays(core.nowJST().date, 10);
    const body = { staffId: 's1', date, start: '13:00', end: '16:00' };
    assert.equal((await s.req('/api/admin/overrides', 'POST', body, staff)).status, 403);
    const made = await (await s.req('/api/admin/overrides', 'POST', body, owner)).json();
    const cal = await (await s.req(`/api/admin/calendar?from=${date}&to=${date}`, 'GET', null, owner)).json();
    assert.deepEqual([cal.loads[date].s1.open, cal.loads[date].s1.close, cal.loads[date].s1.override], [780, 960, true]);
    const cfg = await (await s.req('/api/admin/config', 'GET', null, owner)).json();
    assert.equal(cfg.overrides.length, 1);
    // 特別な時間に入った予約があると、元に戻せない
    await s.req('/api/admin/bookings', 'POST', { serviceId: 'v1', staffId: 's1', date, start: '13:00', customerName: '山田' }, owner);
    const wk = core.weekday(date);
    if (wk === 0 || wk === 6) assert.equal((await s.req(`/api/admin/overrides/${made.id}`, 'DELETE', null, owner)).status, 409);
    else assert.equal((await s.req(`/api/admin/overrides/${made.id}`, 'DELETE', null, owner)).status, 200); // 平日は13:00も元々受付時間内
  } finally { s.close(); }
});

test('キャンセル待ち: 登録すると受付メール、キャンセルで空くと空きのお知らせが届く', async () => {
  const sent = [];
  const mailer = { enabled: true, from: 'no-reply@example.com', send: async (m) => { sent.push(m); } };
  const s = await boot({ mailer, publicUrl: 'https://yoyaku.example.com', adminPassword: 'secret-pass' });
  try {
    const owner = { cookie: (await s.req('/api/admin/login', 'POST', { loginId: 'admin', password: 'secret-pass' })).headers.get('set-cookie').split(';')[0] };
    const tick = () => new Promise((r) => setTimeout(r, 30));
    // 3日後以降の平日を1つ選び、担当者Aの午前を管理画面からすべて埋める
    let date = core.addDays(core.nowJST().date, 3);
    while ([0, 6].includes(core.weekday(date))) date = core.addDays(date, 1);
    const made = [];
    for (const t of ['09:00', '10:00', '11:00']) {
      made.push(await (await s.req('/api/admin/bookings', 'POST', { serviceId: 'v2', staffId: 's1', date, start: t, customerName: `埋${t}`, email: `u${t.slice(0, 2)}@example.com` }, owner)).json());
    }
    const cfg = await (await s.req('/api/public/config')).json();
    assert.equal(cfg.waitlist, true);
    const w = await s.req('/api/public/waitlist', 'POST', { serviceId: 'v2', staffId: 's1', date, part: 'am', customerName: '待つ人', email: 'wait@example.com' });
    assert.equal(w.status, 201);
    const reg = await w.json();
    await tick();
    assert.ok(sent.some((m) => m.to === 'wait@example.com' && /キャンセル待ちを受け付けました/.test(m.subject) && m.text.includes(`?wl=${reg.id}&token=${reg.token}`)));
    assert.equal((await (await s.req('/api/admin/waitlist', 'GET', null, owner)).json()).waitlist.length, 1);
    // 10:00 の予約をキャンセル → すぐに空きのお知らせ
    await s.req(`/api/admin/bookings/${made[1].id}`, 'PATCH', { status: 'cancelled' }, owner);
    await tick(); await tick();
    const open = sent.find((m) => m.to === 'wait@example.com' && /空きが出ました/.test(m.subject));
    assert.ok(open);
    assert.ok(open.text.includes('10:00'));
    const st = await (await s.req(`/api/public/waitlist?id=${reg.id}&token=${reg.token}`)).json();
    assert.equal(st.status, 'notified');
    // 2回目のキャンセルでは、すでに知らせた人へ重ねて送らない
    const before = sent.length;
    await s.req(`/api/admin/bookings/${made[2].id}`, 'PATCH', { status: 'cancelled' }, owner);
    await tick(); await tick();
    assert.equal(sent.filter((m, i) => i >= before && m.to === 'wait@example.com').length, 0);
    // お客様による取り消し（取り消した登録には、空きが出ても知らせない）
    await s.req(`/api/admin/bookings/${made[1].id}`, 'PATCH', { status: 'booked' }, owner);
    await s.req(`/api/admin/bookings/${made[2].id}`, 'PATCH', { status: 'booked' }, owner);
    const r2 = await (await s.req('/api/public/waitlist', 'POST', { serviceId: 'v2', staffId: 's1', date, part: 'am', customerName: '別の人', email: 'b@example.com' })).json();
    assert.equal((await s.req('/api/public/waitlist/cancel', 'POST', { id: r2.id, token: r2.token })).status, 200);
    const n = sent.length;
    await s.req(`/api/admin/bookings/${made[0].id}`, 'PATCH', { status: 'cancelled' }, owner);
    await tick(); await tick();
    assert.equal(sent.slice(n).filter((m) => m.to === 'b@example.com').length, 0);
  } finally { s.close(); }
});

test('キャンセル待ち: メール送信が設定されていなければ受け付けない', async () => {
  const s = await boot({});
  try {
    assert.equal((await (await s.req('/api/public/config')).json()).waitlist, false);
    const r = await s.req('/api/public/waitlist', 'POST', { serviceId: 'v1', staffId: 'any', date: core.nowJST().date, customerName: 'x', email: 'x@example.com' });
    assert.equal(r.status, 409);
  } finally { s.close(); }
});
