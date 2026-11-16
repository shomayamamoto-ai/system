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
  const s = await boot({ mailer, publicUrl: 'https://yoyaku.example.com/' });
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
    const notes = (await (await s.req('/api/admin/notifications')).json()).notifications;
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
