'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core');
const { analyze } = require('../lib/analytics');

// 2026-11-16（月）09:00 JST を「現在」として固定する
const NOW = new Date('2026-11-16T00:00:00Z');
const fresh = () => core.defaultData();
const book = (db, over = {}) => core.createBooking(db, Object.assign({
  serviceId: 'v2', staffId: 's1', date: '2026-11-17', start: '10:00', customerName: '山田', email: 'a@example.com',
}, over), NOW);

test('空き枠: 受付時間内だけが出て、休みの日は出ない', () => {
  const db = fresh();
  const slots = core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW).map((s) => s.start);
  assert.equal(slots[0], '09:00');
  assert.equal(slots.at(-1), '17:00'); // 60分の面談は18:00終了が最後
  assert.deepEqual(core.freeSlots(db, { date: '2026-11-21', serviceId: 'v2', staffId: 's1' }, NOW), []); // 土曜
});

test('空き枠: 当日は直前の枠を出さず、受付期間の外も出さない', () => {
  const db = fresh();
  const today = core.freeSlots(db, { date: '2026-11-16', serviceId: 'v1', staffId: 's1' }, NOW).map((s) => s.start);
  assert.equal(today[0], '10:00'); // 9:00現在 + 60分前締切
  assert.deepEqual(core.freeSlots(db, { date: '2026-11-13', serviceId: 'v1', staffId: 's1' }, NOW), []);
  assert.deepEqual(core.freeSlots(db, { date: '2027-01-20', serviceId: 'v1', staffId: 's1' }, NOW), []);
});

test('スケジュール連動: 予約と予定が入った時間は空き枠から消える', () => {
  const db = fresh();
  book(db);
  core.addBlock(db, { staffId: 's1', date: '2026-11-17', start: '13:00', end: '14:00', title: '会議' });
  const slots = core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW).map((s) => s.start);
  for (const t of ['09:30', '10:00', '10:30', '12:30', '13:00', '13:30']) assert.ok(!slots.includes(t), t);
  for (const t of ['09:00', '11:00', '12:00', '14:00']) assert.ok(slots.includes(t), t);
});

test('二重予約はできず、指名なしなら空いている担当者に入る', () => {
  const db = fresh();
  book(db);
  assert.throws(() => book(db, { start: '10:30' }), /埋まっています/);
  const b = book(db, { staffId: 'any' });
  assert.equal(b.staffId, 's2');
  assert.throws(() => book(db, { staffId: 'any' }), /埋まっています/);
});

test('入力チェック: 名前・メールが不正なら予約できない', () => {
  const db = fresh();
  assert.throws(() => book(db, { customerName: ' ' }), /お名前/);
  assert.throws(() => book(db, { email: 'abc' }), /メールアドレス/);
  assert.equal(db.bookings.length, 0);
});

test('キャンセルすると枠が空き、通知が届く。トークン違いは拒否', () => {
  const db = fresh();
  const b = book(db);
  assert.throws(() => core.cancelByCustomer(db, b.id, 'x'.repeat(24), NOW), /見つかりません/);
  core.cancelByCustomer(db, b.id, b.token, NOW);
  assert.ok(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW).some((s) => s.start === '10:00'));
  assert.deepEqual(db.notifications.map((n) => n.type), ['booking_new', 'booking_cancel']);
  // 空いた枠に別の予約が入ったら、キャンセルは元に戻せない
  book(db, { customerName: '佐藤' });
  assert.throws(() => core.setBookingStatus(db, b.id, 'booked', NOW), /元に戻せません/);
});

test('予約が入っている時間には予定を入れられない', () => {
  const db = fresh();
  book(db);
  assert.throws(() => core.addBlock(db, { staffId: 's1', date: '2026-11-17', start: '10:30', end: '11:30' }), /予約/);
});

test('CSV読み込み: 日本語見出し・引用符・重複・不正行を扱い、通知を出す', () => {
  const db = fresh();
  const csv = '﻿日付,開始,メニュー,担当者,氏名,メール,ステータス,受付日\r\n' +
    '2026/10/1,10:00,初回相談（30分）,担当者A,"山田, 太郎",t@example.com,完了,2026-09-25\r\n' +
    '2026-10-02,14:00,新メニュー,新人C,佐藤,s@example.com,キャンセル,\r\n' +
    '2026-10-02,14:00,新メニュー,新人C,佐藤,s@example.com,キャンセル,\r\n' +
    'いつか,10:00,,,,,,\r\n' +
    '2026-10-05,25:99,,,,,,\r\n';
  const r = core.importCsv(db, csv, NOW);
  assert.equal(r.imported, 2);
  assert.deepEqual(r.skipped.map((s) => s.line), [4, 5, 6]);
  assert.equal(db.bookings[0].customerName, '山田, 太郎');
  assert.equal(db.bookings[0].date, '2026-10-01');
  assert.deepEqual(r.createdStaff, ['新人C']);
  assert.equal(db.notifications.at(-1).type, 'import');
  assert.match(db.notifications.at(-1).body, /取り込み 2件／スキップ 3件/);
  assert.throws(() => core.importCsv(db, '名前\n山田', NOW), /日付/);
});

test('分析: 件数と率が合い、サンプルデータから改善案が出る', () => {
  const db = fresh();
  core.importCsv(db, '日付,開始,担当者,メール,ステータス\n' +
    '2026-11-10,10:00,担当者A,a@example.com,完了\n2026-11-10,11:00,担当者A,a@example.com,キャンセル\n' +
    '2026-11-11,10:00,担当者A,b@example.com,無断キャンセル\n2026-11-12,10:00,担当者A,c@example.com,完了\n', NOW);
  const a = analyze(db, '2026-11-09', '2026-11-15', NOW);
  assert.equal(a.totals.total, 4);
  assert.equal(a.totals.cancelRate, 0.25);
  assert.equal(a.totals.noshowRate, 1 / 3); // 無断1件 ÷ 面談日を迎えた3件
  assert.equal(a.totals.avgLeadDays, null); // 受付日がないので計算しない
  assert.equal(a.byStaff[0].booked, 90); // 30分 × 3件（キャンセルは除く）
  assert.equal(a.byStaff[0].capacity, 5 * 9 * 60);
  assert.equal(a.totals.repeatRate, 1 / 3);
  assert.ok(a.suggestions.some((s) => s.level === 'info')); // データ不足の注意

  const big = fresh();
  core.seedSample(big, NOW);
  const s = analyze(big, '2026-08-19', '2026-11-16', NOW);
  assert.ok(s.totals.total > 100);
  assert.ok(s.suggestions.length >= 3);
  assert.ok(s.suggestions.every((x) => x.title && x.evidence && x.action));
  assert.ok(core.clearSample(big) > 100);
  assert.equal(big.bookings.length, 0);
});

test('設定: これからの予約がある担当者は削除できない', () => {
  const db = fresh();
  book(db);
  db.bookings[0].date = core.addDays(core.nowJST().date, 3); // 実際の「今日」より先の予約にする
  assert.throws(() => core.updateConfig(db, { staff: [db.staff[1]], services: db.services }), /削除できません/);
  core.updateConfig(db, { staff: db.staff.concat({ name: '新人', hours: [null, { start: '9:00', end: '12:00' }] }), services: db.services, settings: { slotMinutes: 15 } });
  assert.equal(db.staff.length, 3);
  assert.equal(db.staff[2].hours[1].start, '09:00');
  assert.equal(db.settings.slotMinutes, 15);
});
