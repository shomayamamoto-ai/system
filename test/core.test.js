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

test('管理画面からの予約: 受付時間外でも登録でき、重なりは拒否する', () => {
  const db = fresh();
  const b = core.createBooking(db, { serviceId: 'v1', staffId: 's1', date: '2026-11-21', start: '20:00', customerName: '電話のお客様' }, NOW, { admin: true });
  assert.equal(b.source, 'admin');
  assert.throws(() => core.createBooking(db, { serviceId: 'v1', staffId: 's1', date: '2026-11-21', start: '20:15', customerName: '別の人' }, NOW, { admin: true }), /別の予約/);
  assert.throws(() => core.createBooking(db, { serviceId: 'v1', staffId: 's1', date: '2026-11-21', start: '21:00', customerName: 'x', email: 'bad' }, NOW, { admin: true }), /メールアドレス/);
});

test('日時変更: 空いていれば移動でき、元の枠が空く。重なりは拒否する', () => {
  const db = fresh();
  const a = book(db);
  const other = book(db, { start: '14:00', customerName: '佐藤' });
  assert.throws(() => core.rescheduleBooking(db, a.id, { date: '2026-11-17', start: '14:30' }, NOW), /別の予約/);
  core.rescheduleBooking(db, a.id, { date: '2026-11-17', start: '10:30' }, NOW); // 自分自身とは重なってよい
  core.rescheduleBooking(db, a.id, { date: '2026-11-18', start: '09:00', staffId: 's2' }, NOW);
  assert.deepEqual([a.date, a.start, a.end, a.staffId], ['2026-11-18', 540, 600, 's2']);
  assert.ok(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW).some((s) => s.start === '10:00'));
  assert.equal(db.notifications.at(-1).type, 'booking_change');
  core.setBookingStatus(db, other.id, 'completed', NOW);
  assert.throws(() => core.rescheduleBooking(db, other.id, { date: '2026-11-19', start: '09:00' }, NOW), /予約済/);
});

test('空き状況: 日ごとの枠数が返り、埋まると減る', () => {
  const db = fresh();
  const before = core.availability(db, { from: '2026-11-01', to: '2026-11-30', serviceId: 'v2', staffId: 's1' }, NOW);
  assert.equal(before['2026-11-15'], undefined); // 過去
  assert.equal(before['2026-11-21'], 0); // 土曜
  book(db);
  const after = core.availability(db, { from: '2026-11-17', to: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW);
  assert.equal(after['2026-11-17'], before['2026-11-17'] - 3);
});

test('検索・顧客・書き出し: 書き出したCSVは、そのまま読み込み直せる', () => {
  const db = fresh();
  book(db, { note: '=SUM(A1)と"引用符", 改行\nあり', phone: '090-0000-0000' });
  book(db, { start: '14:00' });
  core.setBookingStatus(db, db.bookings[1].id, 'cancelled', NOW);
  book(db, { start: '16:00', customerName: '佐藤', email: 'b@example.com' });
  assert.equal(core.searchBookings(db, { q: '佐藤' }).total, 1);
  assert.equal(core.searchBookings(db, { status: 'cancelled' }).total, 1);
  assert.equal(core.searchBookings(db, { from: '2026-11-18' }).total, 0);
  const { customers } = core.customers(db);
  const yamada = customers.find((c) => c.email === 'a@example.com');
  assert.deepEqual([yamada.total, yamada.cancelled, yamada.history.length, yamada.phone], [2, 1, 2, '090-0000-0000']);

  const csv = core.exportCsv(db);
  assert.ok(csv.includes(`"'=SUM(A1)と""引用符"", 改行\nあり"`)); // 数式として動かないよう ' が付く
  const copy = fresh();
  const r = core.importCsv(copy, csv, NOW);
  assert.equal(r.imported, 3);
  assert.deepEqual(copy.bookings.map((b) => [b.date, b.start, b.customerName, b.status]).sort(),
    db.bookings.map((b) => [b.date, b.start, b.customerName, b.status]).sort());
});

test('分析: 前の期間との比較・推移・優先順位・目安の変更', () => {
  const { updateRules } = require('../lib/analytics');
  const db = fresh();
  core.seedSample(db, NOW);
  const a = analyze(db, '2026-10-18', '2026-11-16', NOW);
  assert.deepEqual(a.previous.period, { from: '2026-09-18', to: '2026-10-17' });
  assert.ok(a.previous.totals.total > 0);
  assert.equal(a.trend.unit, '週');
  assert.equal(a.trend.buckets.reduce((n, b) => n + b.active + b.cancelled, 0), a.totals.total);
  assert.deepEqual(a.suggestions.map((s) => s.priority), a.suggestions.map((_, i) => i + 1));
  const levels = a.suggestions.map((s) => ['warn', 'idea', 'info', 'good'].indexOf(s.level));
  assert.deepEqual(levels, levels.slice().sort());
  assert.equal(analyze(db, '2025-11-17', '2026-11-16', NOW).trend.unit, '月');

  // 無断キャンセル率の目安を100%にすると、その改善案は出なくなる
  assert.ok(a.suggestions.some((s) => s.title.startsWith('無断キャンセル')));
  updateRules(db, Object.assign({}, a.rules, { noshowRate: 1 }));
  assert.ok(!analyze(db, '2026-10-18', '2026-11-16', NOW).suggestions.some((s) => s.title.startsWith('無断キャンセル')));
  assert.throws(() => updateRules(db, Object.assign({}, a.rules, { cancelRate: 5 })), /キャンセル率/);
  core.updateConfig(db, { staff: db.staff, services: db.services, settings: {} });
  assert.equal(db.settings.rules.noshowRate, 1); // 設定を保存しても目安は消えない
  updateRules(db, { reset: true });
  assert.equal(db.settings.rules, undefined);
});

test('受付時間: 曜日ごとの時間・休憩・休業日・毎週の予定が空き枠に反映される', () => {
  const db = fresh();
  db.staff[0].hours[2] = { start: '10:00', end: '16:00', breakStart: '12:00', breakEnd: '13:00' }; // 火曜だけ短縮＋昼休み
  const tue = core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW).map((s) => s.start);
  assert.equal(tue[0], '10:00');
  assert.equal(tue.at(-1), '15:00');
  for (const t of ['11:30', '12:00', '12:30']) assert.ok(!tue.includes(t), t); // 休憩にかかる枠は出ない
  assert.ok(tue.includes('11:00') && tue.includes('13:00'));
  // 休憩中でも、管理画面からなら登録できる
  core.createBooking(db, { serviceId: 'v1', staffId: 's1', date: '2026-11-17', start: '12:00', customerName: '特別対応' }, NOW, { admin: true });

  core.addBlock(db, { staffId: 's1', date: '2026-11-18', start: '09:00', end: '11:00', title: '定例会議', repeat: true, until: '2026-11-30' }, NOW);
  const slotsOn = (date) => core.freeSlots(db, { date, serviceId: 'v2', staffId: 's1' }, NOW).map((s) => s.start);
  assert.equal(slotsOn('2026-11-18')[0], '11:00');
  assert.equal(slotsOn('2026-11-25')[0], '11:00');
  assert.equal(slotsOn('2026-12-02')[0], '09:00'); // 終了日を過ぎたら元に戻る
  assert.equal(core.expandRecurring(db, '2026-11-16', '2026-12-06').length, 2);

  core.addClosedDay(db, { date: '2026-11-19', title: '臨時休業' });
  assert.deepEqual(slotsOn('2026-11-19'), []);
  assert.equal(core.availability(db, { from: '2026-11-19', to: '2026-11-19', serviceId: 'v1', staffId: 'any' }, NOW)['2026-11-19'], 0);
  assert.throws(() => core.addClosedDay(db, { date: '2026-11-19' }), /すでに/);
  book(db, { date: '2026-11-20' });
  assert.throws(() => core.addClosedDay(db, { date: '2026-11-20' }), /予約が1件/);
  book(db, { date: '2026-11-24', start: '14:00', customerName: '佐藤' });
  assert.throws(() => core.addBlock(db, { staffId: 's1', date: '2026-11-17', start: '14:00', end: '15:00', repeat: true }, NOW), /重なります/);

  // 分析の「受付可能時間」にも反映される
  const { capacityMinutes } = require('../lib/analytics');
  assert.equal(capacityMinutes(db, db.staff[0], '2026-11-17'), 5 * 60); // 6時間 − 休憩1時間
  assert.equal(capacityMinutes(db, db.staff[0], '2026-11-18'), 7 * 60); // 9時間 − 毎週の予定2時間
  assert.equal(capacityMinutes(db, db.staff[0], '2026-11-19'), 0);

  assert.throws(() => core.updateConfig(db, { staff: [{ id: 's1', name: 'A', hours: [null, { start: '09:00', end: '18:00', breakStart: '08:00', breakEnd: '10:00' }] }], services: db.services }), /休憩時間/);
});

test('お客様による日時変更: 自分の枠は空きとして扱い、同じ担当者を優先する', () => {
  const db = fresh();
  const b = book(db); // 火曜 10:00〜11:00 担当者A
  assert.throws(() => core.rescheduleByCustomer(db, b.id, 'x'.repeat(24), { date: '2026-11-17', start: '10:30' }, NOW), /見つかりません/);
  core.rescheduleByCustomer(db, b.id, b.token, { date: '2026-11-17', start: '10:30' }, NOW); // 自分の枠と重なる時間へ
  assert.deepEqual([b.start, b.end, b.staffId], [630, 690, 's1']);
  core.addBlock(db, { staffId: 's1', date: '2026-11-18', start: '09:00', end: '18:00' }, NOW);
  core.rescheduleByCustomer(db, b.id, b.token, { date: '2026-11-18', start: '11:00' }, NOW);
  assert.equal(b.staffId, 's2'); // 担当者Aが埋まっている日は、空いている担当者に変わる
  assert.throws(() => core.rescheduleByCustomer(db, b.id, b.token, { date: '2026-11-21', start: '11:00' }, NOW), /埋まっています/);
  assert.equal(core.changeBlockedReason(db, b, new Date('2026-11-18T03:00:00Z')).includes('過ぎている'), true); // 開始後
});

test('前日リマインド: 設定の時刻以降に、明日の予約だけが対象になる', () => {
  const { dueReminders, buildMail } = require('../lib/mailer');
  const db = fresh();
  const b = book(db); // 11/17（火）
  b.createdAt = '2026-11-10T00:00:00.000Z';
  const other = book(db, { date: '2026-11-18', start: '14:00', customerName: '佐藤' });
  other.createdAt = '2026-11-10T00:00:00.000Z';
  assert.deepEqual(dueReminders(db, new Date('2026-11-16T08:00:00Z')), []); // 日本時間17時: まだ早い
  assert.deepEqual(dueReminders(db, new Date('2026-11-16T09:30:00Z')).map((x) => x.id), [b.id]); // 18時半
  b.remindedAt = 'x';
  assert.deepEqual(dueReminders(db, new Date('2026-11-16T09:30:00Z')), []);
  delete b.remindedAt;
  db.settings.mail.reminder = false;
  assert.deepEqual(dueReminders(db, new Date('2026-11-16T09:30:00Z')), []);
  const m = buildMail('remind', db, b, '');
  assert.match(m.subject, /明日のご予約/);
  assert.ok(!m.text.includes('http')); // 公開URLが未設定ならリンクは入れない
});

test('祝日: 法律のルールどおりに計算され、休業日へまとめて登録できる', () => {
  const { holidays } = require('../lib/holidays');
  const of = (y) => Object.fromEntries(holidays(y).map((h) => [h.date, h.title]));
  const y26 = of(2026);
  assert.equal(Object.keys(y26).length, 18);
  assert.equal(y26['2026-01-12'], '成人の日'); // 1月の第2月曜
  assert.equal(y26['2026-03-20'], '春分の日');
  assert.equal(y26['2026-05-06'], '振替休日'); // 5/3（日）の振替は、祝日が続くので 5/6
  assert.equal(y26['2026-09-22'], '国民の休日'); // 敬老の日と秋分の日にはさまれた平日
  const y27 = of(2027);
  assert.equal(y27['2027-03-21'], '春分の日');
  assert.equal(y27['2027-03-22'], '振替休日');
  assert.equal(of(2021)['2021-07-23'], 'スポーツの日'); // 東京オリンピックの特例
  assert.equal(of(2024)['2024-02-12'], '振替休日');
  assert.deepEqual(holidays(1999), []);

  const db = fresh();
  book(db, { date: '2026-11-23', start: '10:00' }); // 勤労感謝の日に予約あり
  const r = core.addHolidays(db, 2026, NOW);
  assert.deepEqual(r.added.map((h) => h.date), []); // 11/16 以降の祝日は 11/23 だけで、予約があるので登録しない
  assert.match(r.skipped[0].reason, /予約が1件/);
  const next = core.addHolidays(db, 2027, NOW);
  assert.equal(next.added.length, 17);
  assert.deepEqual(core.freeSlots(db, { date: '2027-01-01', serviceId: 'v1', staffId: 'any' }, new Date('2026-12-20T00:00:00Z')), []);
  assert.equal(core.addHolidays(db, 2027, NOW).added.length, 0); // 2回押しても重複しない
  assert.throws(() => core.addHolidays(db, 1990, NOW), /2020年〜2099年/);
});

test('事前アンケート: 必須・選択肢を確かめ、回答を質問文と一緒に保存する', () => {
  const db = fresh();
  core.updateConfig(db, { staff: db.staff, services: db.services, settings: { questions: [
    { label: 'ご希望の面談方法', type: 'select', options: '対面\nオンライン', required: true },
    { label: 'きっかけ', type: 'text' },
  ] } });
  const [q1, q2] = db.settings.questions;
  assert.deepEqual(q1.options, ['対面', 'オンライン']);
  assert.throws(() => book(db), /ご希望の面談方法/);
  assert.throws(() => book(db, { answers: { [q1.id]: '電話' } }), /選択肢の中から/);
  assert.throws(() => book(db, { answers: [] }), /ご希望の面談方法/);
  const b = book(db, { answers: { [q1.id]: 'オンライン', [q2.id]: ' 知人の紹介 ', other: 'x', __proto__: { a: 1 } } });
  assert.deepEqual(b.answers, [{ label: 'ご希望の面談方法', value: 'オンライン' }, { label: 'きっかけ', value: '知人の紹介' }]);
  // 管理画面からの登録では、アンケートは求めない
  core.createBooking(db, { serviceId: 'v1', staffId: 's2', date: '2026-11-17', start: '20:00', customerName: '電話' }, NOW, { admin: true });
  // 質問を変えても、当時の回答は残る。ほかの設定を保存しても質問は消えない
  core.updateConfig(db, { staff: db.staff, services: db.services, settings: { slotMinutes: 30 } });
  assert.equal(db.settings.questions.length, 2);
  core.updateConfig(db, { staff: db.staff, services: db.services, settings: { questions: [] } });
  assert.equal(b.answers.length, 2);
  assert.throws(() => core.updateConfig(db, { staff: db.staff, services: db.services, settings: { questions: [{ label: 'x', type: 'select', options: ['1つだけ'] }] } }), /2つ以上/);
  assert.throws(() => core.updateConfig(db, { staff: db.staff, services: db.services, settings: { mail: { notifyTo: 'a@example.com, b@example.com' } } }), /通知先/);
});

test('面談メモ: 保存・検索・顧客履歴・CSVに反映される', () => {
  const db = fresh();
  const b = book(db);
  core.setMemo(db, b.id, '次回までに資料を準備してもらう');
  assert.equal(core.searchBookings(db, { q: '資料' }).total, 1);
  assert.equal(core.customers(db).customers[0].history[0].memo, '次回までに資料を準備してもらう');
  const copy = fresh();
  core.importCsv(copy, core.exportCsv(db), NOW);
  assert.equal(copy.bookings[0].memo, '次回までに資料を準備してもらう');
  assert.throws(() => core.setMemo(db, 'nope', 'x'), /見つかりません/);
});

test('点検で見つかった問題の再発防止（不具合）', () => {
  // メニューの所要時間を短くしたあとでも、日時変更で二重予約にならない
  let db = fresh();
  const long = book(db); // 60分
  db.services[1].minutes = 30;
  const other = book(db, { start: '11:00', customerName: '佐藤', email: 'b@example.com' }); // 11:00〜11:30 担当者A
  core.addBlock(db, { staffId: 's2', date: '2026-11-17', start: '10:00', end: '19:00' }, NOW);
  assert.throws(() => core.rescheduleByCustomer(db, long.id, long.token, { date: '2026-11-17', start: '10:30' }, NOW), /埋まっています/);
  assert.throws(() => core.rescheduleByCustomer(db, long.id, long.token, { date: '2026-11-17', start: '17:30' }, NOW), /埋まっています/); // 18:00 を超える
  core.rescheduleByCustomer(db, long.id, long.token, { date: '2026-11-17', start: '12:00' }, NOW);
  assert.deepEqual([long.start, long.end, other.start], [720, 780, 660]);

  // 受付締切は日付をまたいでも効く
  db = fresh();
  db.settings.minLeadMinutes = 1440;
  const lateNight = new Date('2026-11-16T14:00:00Z'); // 日本時間 月曜23:00
  const tue = core.freeSlots(db, { date: '2026-11-17', serviceId: 'v1', staffId: 's1' }, lateNight).map((x) => x.start);
  assert.deepEqual(tue, []); // 火曜の受付（〜18:00）は、すべて24時間以内
  assert.equal(core.freeSlots(db, { date: '2026-11-18', serviceId: 'v1', staffId: 's1' }, lateNight)[0].start, '09:00');

  // CSV: スキップした行の担当者は作らない。追加した担当者は受付時間が空で、予約ページに出ない
  db = fresh();
  const r = core.importCsv(db, '日付,開始,担当者,メニュー,所要時間\n2026-10-01,23:50,退職者X,旧メニュー,60\n2026-10-02,10:00,新人Y,初回相談（30分）,45\n', NOW);
  assert.equal(r.imported, 1);
  assert.deepEqual(db.staff.map((x) => x.name), ['担当者A', '担当者B', '新人Y']);
  assert.equal(db.services.length, 2);
  assert.equal(db.bookings[0].end - db.bookings[0].start, 45); // 所要時間の列を優先
  assert.deepEqual(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v1', staffId: db.staff[2].id }, NOW), []);

  // CSV: 書き出しで付けた ' は読み込みで外れ、同じデータを読み直しても増えない
  db = fresh();
  book(db, { customerName: '-田中', phone: '+81-90-1111', note: '=相談' });
  const copy = fresh();
  core.importCsv(copy, core.exportCsv(db), NOW);
  assert.deepEqual([copy.bookings[0].customerName, copy.bookings[0].phone, copy.bookings[0].note], ['-田中', '+81-90-1111', '=相談']);
  assert.equal(core.importCsv(copy, core.exportCsv(db), NOW).imported, 0);

  // キャンセルを戻すとき、担当者が削除されていたら止める（設定が保存できなくなるのを防ぐ）
  db = fresh();
  const b = book(db, { staffId: 's2' });
  core.setBookingStatus(db, b.id, 'cancelled', NOW);
  core.updateConfig(db, { staff: [db.staff[0]], services: db.services });
  assert.throws(() => core.setBookingStatus(db, b.id, 'booked', NOW), /削除されている/);

  // サンプルは二重に登録できない。年をまたぐ推移グラフの見出しは重ならない
  db = fresh();
  core.seedSample(db, NOW);
  assert.throws(() => core.seedSample(db, NOW), /すでに登録/);
  const labels = analyze(db, '2025-11-17', '2026-11-16', NOW).trend.buckets.map((x) => x.label);
  assert.equal(new Set(labels).size, labels.length);

  // リマインド: 昼に入った翌日午後の予約にも送る。送信時刻より後に入った予約には送らない
  const { dueReminders } = require('../lib/mailer');
  db = fresh();
  const noon = book(db, { start: '15:00' });
  noon.createdAt = '2026-11-16T03:30:00.000Z'; // 日本時間 月曜12:30
  assert.deepEqual(dueReminders(db, new Date('2026-11-16T09:05:00Z')).map((x) => x.id), [noon.id]); // 18:05
  noon.createdAt = '2026-11-16T09:30:00.000Z'; // 18:30 に入った予約
  assert.deepEqual(dueReminders(db, new Date('2026-11-16T10:00:00Z')), []);
});

test('祝日: 内閣府が公表している日付と一致する', () => {
  // 出典: 内閣府「国民の祝日について」の CSV（2026-11-16 に取得。2020〜2027年の全143日が一致することを確認済み）
  // https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv
  const official = {
    2025: '01-01 01-13 02-11 02-23 02-24 03-20 04-29 05-03 05-04 05-05 05-06 07-21 08-11 09-15 09-23 10-13 11-03 11-23 11-24',
    2026: '01-01 01-12 02-11 02-23 03-20 04-29 05-03 05-04 05-05 05-06 07-20 08-11 09-21 09-22 09-23 10-12 11-03 11-23',
    2027: '01-01 01-11 02-11 02-23 03-21 03-22 04-29 05-03 05-04 05-05 07-19 08-11 09-20 09-23 10-11 11-03 11-23',
  };
  const { holidays } = require('../lib/holidays');
  for (const [year, list] of Object.entries(official)) {
    assert.deepEqual(holidays(Number(year)).map((h) => h.date.slice(5)), list.split(' '), `${year}年`);
  }
});

test('統計: 確からしい範囲・差の判定・傾向の判定', () => {
  const { wilson, ratesDiffer, trendOf } = require('../lib/stats');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} ≒ ${b}`);
  // よく知られた値との照合（10件中3件 → 約 10.8%〜60.3%、100件中30件 → 約 21.9%〜39.6%）
  near(wilson(3, 10)[0], 0.108); near(wilson(3, 10)[1], 0.603);
  near(wilson(30, 100)[0], 0.219); near(wilson(30, 100)[1], 0.396);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  near(wilson(0, 20)[0], 0); assert.ok(wilson(20, 20)[1] <= 1);
  // 10件中3件と10件中5件の差は偶然の範囲。1000件中300件と500件の差は偶然とは言えない
  assert.equal(ratesDiffer(3, 10, 5, 10), false);
  assert.equal(ratesDiffer(300, 1000, 500, 1000), true);
  assert.equal(ratesDiffer(0, 0, 5, 10), false);
  assert.equal(ratesDiffer(0, 10, 0, 10), false);
  // 傾向
  assert.equal(trendOf([10, 12, 14, 16, 18, 20, 22]).direction, 'up');
  assert.equal(trendOf([30, 27, 25, 22, 20, 17, 15, 12]).direction, 'down');
  assert.equal(trendOf([20, 18, 23, 19, 22, 20, 21, 19]).direction, 'flat'); // ばらつきだけ
  assert.equal(trendOf([10, 20, 30]).direction, 'unknown'); // 少なすぎる
  assert.equal(trendOf([5, 5, 5, 5, 5, 5]).direction, 'flat');
});

test('分析の精度: 件数が少ないときは断定せず、十分あるときだけ「要対応」にする', () => {
  const make = (n, cancelled) => {
    const db = fresh();
    let csv = '日付,開始,担当者,氏名,メール,ステータス\n';
    for (let i = 0; i < n; i++) {
      const d = core.addDays('2026-10-01', i % 40);
      csv += `${d},${String(9 + (i % 8)).padStart(2, '0')}:${i % 2 ? '30' : '00'},担当者${i % 2 ? 'A' : 'B'},客${i},c${i}@example.com,${i < cancelled ? 'キャンセル' : '完了'}\n`;
    }
    core.importCsv(db, csv, NOW);
    return analyze(db, '2026-10-01', '2026-11-15', NOW);
  };
  // 10件中2件（20%）: 目安15%は超えるが、範囲（約6〜51%）が目安をまたぐ → 断定しない
  const few = make(10, 2);
  const s1 = few.suggestions.find((s) => s.title.startsWith('キャンセル率'));
  assert.equal(s1.level, 'idea');
  assert.match(s1.title, /可能性/);
  assert.match(s1.evidence, /断定はできません/);
  // 200件中50件（25%）: 範囲の下限（約19%）でも目安を超える → 要対応
  const many = make(200, 50);
  const s2 = many.suggestions.find((s) => s.title.startsWith('キャンセル率'));
  assert.equal(s2.level, 'warn');
  assert.equal(s2.title, 'キャンセル率が高めです');
  assert.ok(many.totals.cancelRange[0] > 0.15 && many.totals.cancelRange[1] < 0.32);
  // 前の期間（データなし）との差は判定しない。混み具合の表の合計は、有効な予約の件数と一致する
  assert.equal(many.significant.cancelRate, false);
  assert.equal(many.heat.rows.flatMap((r) => r.cells).reduce((a, b) => a + b, 0), many.totals.active);
  // 推移: 期間の端で切れている週は「途中」になる（10/1 は木曜、11/15 は日曜）
  const b = many.trend.buckets;
  assert.equal(b[0].partial, true);
  assert.equal(b.at(-1).partial, false);
  assert.equal(many.trend.fullCount, b.filter((x) => !x.partial).length);
});

test('空き枠の精度: 準備時間・1日の上限・メニューごとの担当者', () => {
  let db = fresh();
  db.settings.bufferMinutes = 30;
  book(db); // 火曜 10:00〜11:00 担当者A
  const t = () => core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW).map((s) => s.start);
  for (const x of ['09:00', '09:30', '10:00', '10:30', '11:00']) assert.ok(!t().includes(x), x); // 前後30分も空ける
  assert.ok(t().includes('11:30'));
  assert.ok(!core.freeSlots(db, { date: '2026-11-17', serviceId: 'v1', staffId: 's1' }, NOW).map((s) => s.start).includes('09:30'));
  assert.ok(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v1', staffId: 's1' }, NOW).map((s) => s.start).includes('09:00')); // 30分の相談なら 9:00〜9:30 は可
  // 管理画面からなら、準備時間に関係なく登録できる
  core.createBooking(db, { serviceId: 'v1', staffId: 's1', date: '2026-11-17', start: '11:00', customerName: '急ぎ' }, NOW, { admin: true });
  // 自分の予約の前後は、日時変更のときは空きとして扱う
  const mine = db.bookings[0];
  assert.ok(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1', exceptBookingId: mine.id }, NOW).map((s) => s.start).includes('09:00'));

  db = fresh();
  db.settings.maxPerDay = 2;
  book(db, { start: '09:00' });
  book(db, { start: '13:00', email: 'b@example.com' });
  assert.deepEqual(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v1', staffId: 's1' }, NOW), []); // 上限に達した
  assert.ok(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v1', staffId: 'any' }, NOW).length > 0); // 担当者Bは受けられる
  assert.ok(core.freeSlots(db, { date: '2026-11-18', serviceId: 'v1', staffId: 's1' }, NOW).length > 0); // 翌日は別
  assert.throws(() => book(db, { start: '15:00', email: 'c@example.com' }), /埋まっています/);

  db = fresh();
  core.updateConfig(db, { staff: db.staff, services: [db.services[0], Object.assign({}, db.services[1], { staffIds: ['s2', 'nobody'] })] });
  assert.deepEqual(db.services[1].staffIds, ['s2']);
  assert.deepEqual(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW), []);
  assert.throws(() => book(db), /埋まっています/); // 対応していない担当者は指名できない
  assert.equal(book(db, { staffId: 'any' }).staffId, 's2');
  assert.equal(book(db, { serviceId: 'v1', start: '15:00' }).staffId, 's1'); // 制限のないメニューは従来どおり
  // 全員を選んだ場合は「制限なし」として保存する。担当できる人が0人になる変更は止める
  core.updateConfig(db, { staff: db.staff, services: [db.services[0], Object.assign({}, db.services[1], { staffIds: ['s1', 's2'] })] });
  assert.deepEqual(db.services[1].staffIds, []);
  assert.throws(() => core.updateConfig(db, { staff: db.staff, services: [db.services[0], Object.assign({}, db.services[1], { staffIds: ['gone'] })] }), /担当できる人がいなくなります/);
});

test('名寄せ: 表記が違っても同じお客様は1人として数える', () => {
  const id = require('../lib/identity');
  assert.equal(id.normEmail(' Ｔaro@Example.COM '), 'taro@example.com');
  assert.equal(id.normPhone('０９０-1234-5678'), '09012345678');
  assert.equal(id.normPhone('+81 90 1234 5678'), '09012345678');
  assert.equal(id.normPhone('内線123'), '');
  assert.equal(id.normName('山田　太郎'), id.normName('山田 太郎'));

  const db = fresh();
  book(db, { customerName: '山田 太郎', email: 'Taro@Example.com', phone: '090-1234-5678' });
  book(db, { start: '13:00', customerName: '山田　太郎', email: 'taro@example.com' });           // メールの大文字小文字
  book(db, { start: '15:00', customerName: 'ヤマダ タロウ', email: 'other@example.com', phone: '09012345678' }); // 電話番号で同一人物
  book(db, { date: '2026-11-18', customerName: '佐藤', email: 'sato@example.com', phone: '03-1111-2222' });
  core.createBooking(db, { serviceId: 'v1', staffId: 's2', date: '2026-11-18', start: '20:00', customerName: '田中　花子' }, NOW, { admin: true });
  core.createBooking(db, { serviceId: 'v1', staffId: 's2', date: '2026-11-19', start: '20:00', customerName: '田中 花子' }, NOW, { admin: true }); // 連絡先なしは名前で
  const { customers, total } = core.customers(db);
  assert.equal(total, 3);
  const yamada = customers.find((c) => c.total === 3);
  assert.deepEqual([yamada.name, yamada.phone], ['ヤマダ タロウ', '09012345678']);
  assert.ok(yamada.aliases.length >= 1);
  assert.equal(customers.find((c) => c.name === '田中 花子').total, 2);
  assert.equal(core.customers(db, '090 1234').total, 1); // 電話番号は、区切り方が違っても探せる
  assert.equal(core.customers(db, '山田太郎').total, 1);
  // リピート率も名寄せ後の人数で計算する（3人中2人が2回以上）
  const a = analyze(db, '2026-11-16', '2026-11-30', NOW);
  assert.deepEqual([a.totals.customers, a.totals.repeaters], [3, 2]);
  // 同じメールアドレスでの予約上限も、表記をそろえて数える
  book(db, { date: '2026-11-19', email: 'ｔａｒｏ@example.com' }); // 全角で入力されても同じアドレスとして数える（これで3件目）
  assert.equal(db.bookings.at(-1).email, 'taro@example.com');
  assert.throws(() => book(db, { date: '2026-11-20', email: 'TARO@EXAMPLE.COM' }), /同時に3件まで/);
});

test('メールの精度: 送りそこねたリマインドは当日に送り直し、意味のなくなったメールは送らない', () => {
  const { dueReminders, dueCatchUp, stillRelevant, buildMail } = require('../lib/mailer');
  const db = fresh();
  const b = book(db); // 11/17（火）10:00
  b.createdAt = '2026-11-10T00:00:00.000Z';
  const morning = new Date('2026-11-16T23:30:00Z'); // 日本時間 11/17 8:30（前日はサーバーが止まっていた想定）
  assert.deepEqual(dueReminders(db, morning), []);
  assert.deepEqual(dueCatchUp(db, morning).map((x) => x.id), [b.id]);
  assert.match(buildMail('remind_today', db, b, '').subject, /本日のご予約/);
  assert.deepEqual(dueCatchUp(db, new Date('2026-11-17T00:30:00Z')), []); // 9:30: 面談まで1時間を切ったら送らない
  b.remindedAt = 'x';
  assert.deepEqual(dueCatchUp(db, morning), []); // 送信済みなら送らない
  delete b.remindedAt;
  b.createdAt = '2026-11-16T10:00:00.000Z'; // 前日の19時（送信時刻のあと）に入った予約は対象外
  assert.deepEqual(dueCatchUp(db, morning), []);

  assert.equal(stillRelevant('confirm', b, morning), true);
  assert.equal(stillRelevant('cancel', b, morning), false);
  core.setBookingStatus(db, b.id, 'cancelled', NOW);
  assert.equal(stillRelevant('confirm', b, morning), false); // キャンセル後に「予約確認」は送らない
  assert.equal(stillRelevant('cancel', b, morning), true);
  assert.equal(stillRelevant('cancel', b, new Date('2026-11-20T00:00:00Z')), false); // 日付を過ぎたら送らない
});

test('待ち行列理論: 計算が動画の数字（4分・9分・19分）と一致する', () => {
  const { queueFactor } = require('../lib/stats');
  // 1時間に60人さばけるレジ（1人1分）に、48人・54人・57人が来たときの平均待ち時間（分）
  assert.equal(Math.round(queueFactor(48 / 60) * 1), 4);
  assert.equal(Math.round(queueFactor(54 / 60) * 1), 9);
  assert.equal(Math.round(queueFactor(57 / 60) * 1), 19);
  assert.equal(queueFactor(0), 0);
  assert.equal(queueFactor(1), Infinity);
});

test('待ち行列理論: 1日の予定は8割まで（超える枠は予約ページに出さない）', () => {
  const db = fresh(); // 担当者A: 9:00〜18:00 ＝ 540分。8割は 432分
  assert.equal(db.settings.loadCap, 80);
  const slots = () => core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1' }, NOW);
  // 60分の面談を7件入れると 420分（約78%）。8件目（480分＝約89%）は受け付けない
  for (const t of ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00']) book(db, { start: t, email: `${t.replace(':', '')}@example.com` });
  assert.deepEqual(slots(), []);
  assert.equal(Math.round(core.dayLoad(db, db.staff[0], '2026-11-17').rate * 100), 78);
  // 30分の相談なら 450分（約83%）で、やはり超えるので出さない
  assert.deepEqual(core.freeSlots(db, { date: '2026-11-17', serviceId: 'v1', staffId: 's1' }, NOW), []);
  // 上限を100%（制限なし）にすると、空いている時間はまた出る
  db.settings.loadCap = 100;
  assert.deepEqual(slots().map((x) => x.start), ['16:00', '16:30', '17:00']);
  // 管理画面からは、上限に関係なく登録できる
  db.settings.loadCap = 80;
  core.createBooking(db, { serviceId: 'v2', staffId: 's1', date: '2026-11-17', start: '16:00', customerName: '電話' }, NOW, { admin: true });
  // 日時変更のときは、自分の予約ぶんを除いて判定する
  db.bookings.pop(); // 管理画面の1件を取り消し、7件（420分）に戻す
  const own = db.bookings[0];
  const moves = core.freeSlots(db, { date: '2026-11-17', serviceId: 'v2', staffId: 's1', exceptBookingId: own.id }, NOW).map((x) => x.start);
  assert.ok(moves.includes('09:00') && moves.includes('16:00')); // 自分を除くと360分なので、同じ日の中で動かせる
  // 設定の範囲
  core.updateConfig(db, { staff: db.staff, services: db.services, settings: { loadCap: 30 } });
  assert.equal(db.settings.loadCap, 80); // 50〜100 以外は受け付けない
  core.updateConfig(db, { staff: db.staff, services: db.services, settings: { loadCap: 90 } });
  assert.equal(db.settings.loadCap, 90);
});

test('待ち行列理論: 「指名なし」は、その日の稼働率がいちばん低い担当者へ割り振る（混む人を避ける）', () => {
  const db = fresh();
  db.settings.loadCap = 100;
  // 担当者A（540分）に 60分×2件、担当者B（10:00〜19:00＝540分）に 30分×3件（件数はBが多いが、稼働率はAが高い）
  book(db, { start: '09:00', email: 'a1@example.com' });
  book(db, { start: '11:00', email: 'a2@example.com' });
  for (const t of ['10:00', '13:00', '15:00']) book(db, { staffId: 's2', serviceId: 'v1', start: t, email: `b${t.slice(0, 2)}@example.com` });
  const b = book(db, { staffId: 'any', serviceId: 'v1', start: '16:00', email: 'new@example.com' });
  assert.equal(b.staffId, 's2'); // 件数ではなく、埋まった時間の割合で選ぶ
});

test('待ち行列理論: 分析で、8割を超えた日を数えて改善案を出す', () => {
  const db = fresh();
  db.settings.loadCap = 100; // 上限なしで運用していた場合
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  let csv = '日付,開始,メニュー,担当者,氏名,メール,ステータス\n';
  days.forEach((d, i) => {
    const n = i < 3 ? 8 : 4; // 3日は 8時間（約89%）、2日は 4時間（約44%）
    for (let h = 0; h < n; h++) csv += `${d},${String(9 + h).padStart(2, '0')}:00,個別面談（60分）,担当者A,客${i}-${h},c${i}${h}@example.com,完了\n`;
  });
  core.importCsv(db, csv, NOW);
  const a = analyze(db, '2026-11-02', '2026-11-08', NOW);
  assert.equal(a.load.worked, 5);
  assert.equal(a.load.over, 3);
  assert.equal(a.load.overList[0].staff, '担当者A');
  assert.equal(Math.round(a.load.overList[0].rate * 100), 89);
  assert.deepEqual(a.load.table.map((r) => r.factor), [1, 2.3, 4, 9, 19]);
  const s = a.suggestions.find((x) => x.title === '予定を詰め込みすぎている日があります');
  assert.ok(s);
  assert.equal(s.level, 'warn'); // 5日中3日（60%）
  assert.match(s.action, /80%にすると/);
  // 8割以内に収まっていれば出さない
  const calm = fresh();
  core.importCsv(calm, csv.split('\n').filter((l) => !/,1[4-6]:00,/.test(l)).join('\n'), NOW);
  assert.equal(analyze(calm, '2026-11-02', '2026-11-08', NOW).load.over, 0);
});

test('受付時間: 休憩を1日に複数入れられ、以前の形式（休憩1つ）も読める', () => {
  const db = fresh();
  core.updateConfig(db, { staff: [Object.assign({}, db.staff[0], { hours: [null, { start: '09:00', end: '18:00', breaks: [{ start: '12:00', end: '13:00' }, { start: '15:00', end: '15:30' }, { start: '', end: '' }].filter((x) => x.start) }] })], services: db.services });
  db.settings.loadCap = 100;
  const mon = core.freeSlots(db, { date: '2026-11-23', serviceId: 'v1', staffId: 's1' }, NOW).map((x) => x.start);
  for (const t of ['12:00', '12:30', '15:00']) assert.ok(!mon.includes(t), t);
  for (const t of ['11:30', '13:00', '14:30', '15:30']) assert.ok(mon.includes(t), t);
  assert.equal(core.capacityMinutes(db, db.staff[0], '2026-11-23'), 540 - 90);
  const bad = (breaks) => () => core.updateConfig(db, { staff: [Object.assign({}, db.staff[0], { hours: [null, { start: '09:00', end: '18:00', breaks }] })], services: db.services });
  assert.throws(bad([{ start: '12:00', end: '13:00' }, { start: '12:30', end: '14:00' }]), /重なっています/);
  assert.throws(bad([{ start: '08:00', end: '09:30' }]), /休憩時間が正しくありません/);
  // 以前の形式で保存されたデータを読み込むと、休憩の一覧に直る
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoyaku-'));
  try {
    const old = core.defaultData();
    old.staff[0].hours[1] = { start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' };
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(old));
    const loaded = new core.Store(path.join(dir, 'db.json')).db;
    assert.deepEqual(loaded.staff[0].hours[1], { start: '09:00', end: '18:00', breaks: [{ start: '12:00', end: '13:00' }] });
    assert.deepEqual(loaded.overrides, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('特定の日の受付時間: 変更・休み・休業日の特別営業が空き枠に反映される', () => {
  const db = fresh();
  db.settings.loadCap = 100;
  const slots = (date) => core.freeSlots(db, { date, serviceId: 'v1', staffId: 's1' }, NOW).map((x) => x.start);
  // 11/24（火）だけ 9:00〜12:00、10:00〜10:30 は休憩
  core.setOverride(db, { staffId: 's1', date: '2026-11-24', start: '09:00', end: '12:00', breaks: [{ start: '10:00', end: '10:30' }], note: '研修' }, NOW);
  assert.deepEqual(slots('2026-11-24'), ['09:00', '09:30', '10:30', '11:00', '11:30']);
  assert.equal(slots('2026-12-01')[0], '09:00'); // ほかの火曜はいつもどおり
  assert.equal(slots('2026-12-01').at(-1), '17:30');
  // 同じ日に設定し直すと、置きかわる（休みにする）
  core.setOverride(db, { staffId: 's1', date: '2026-11-24', off: true }, NOW);
  assert.deepEqual(slots('2026-11-24'), []);
  assert.equal(db.overrides.length, 1);
  // 休業日でも、特定の日の設定があれば、その担当者だけ受け付ける（土曜の特別営業も同じ）
  core.addClosedDay(db, { date: '2026-11-26', title: '臨時休業' });
  core.setOverride(db, { staffId: 's1', date: '2026-11-26', start: '13:00', end: '15:00' }, NOW);
  assert.deepEqual(slots('2026-11-26'), ['13:00', '13:30', '14:00', '14:30']);
  assert.deepEqual(core.freeSlots(db, { date: '2026-11-26', serviceId: 'v1', staffId: 's2' }, NOW), []);
  core.setOverride(db, { staffId: 's1', date: '2026-11-28', start: '10:00', end: '12:00' }, NOW); // 土曜
  assert.equal(slots('2026-11-28').length, 4);
  assert.equal(core.capacityMinutes(db, db.staff[0], '2026-11-28'), 120);
  // 予約が受付時間の外になる変更は止める。過去の日付は設定できない
  book(db, { date: '2026-12-01', start: '15:00' });
  assert.throws(() => core.setOverride(db, { staffId: 's1', date: '2026-12-01', start: '09:00', end: '12:00' }, NOW), /受付時間の外/);
  assert.throws(() => core.setOverride(db, { staffId: 's1', date: '2026-12-01', off: true }, NOW), /受付時間の外/);
  assert.throws(() => core.setOverride(db, { staffId: 's1', date: '2026-11-10', off: true }, NOW), /過去/);
  // 担当者を削除すると、その人の設定も消える
  core.setBookingStatus(db, db.bookings[0].id, 'cancelled', NOW);
  core.updateConfig(db, { staff: [db.staff[1]], services: db.services });
  assert.deepEqual(db.overrides, []);
});
