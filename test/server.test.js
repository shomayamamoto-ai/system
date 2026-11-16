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
  return { dir, dataFile, req, close: () => { server.close(); server.closeAllConnections(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('ログイン: パスワードなしでは管理APIを使えず、ログイン後は使える', async () => {
  const s = await boot({ adminPassword: 'secret-pass' });
  try {
    assert.equal((await s.req('/api/admin/config')).status, 401);
    assert.equal((await s.req('/api/admin/export')).status, 401);
    assert.deepEqual(await (await s.req('/api/admin/session')).json(), { loggedIn: false, protected: true });
    assert.equal((await s.req('/api/admin/login', 'POST', { password: 'wrong' })).status, 401);
    assert.equal((await s.req('/api/admin/login', 'POST', { password: ['secret-pass'] })).status, 401);

    const login = await s.req('/api/admin/login', 'POST', { password: 'secret-pass' });
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
    for (let i = 0; i < 3; i++) assert.equal((await s.req('/api/admin/login', 'POST', { password: 'x' })).status, 401);
    assert.equal((await s.req('/api/admin/login', 'POST', { password: 'secret-pass' })).status, 429);
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
