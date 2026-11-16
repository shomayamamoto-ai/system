'use strict';
// 予約システムの中心となる処理。
// 日付は "YYYY-MM-DD"、時刻は 0時からの「分」で持ち、
// タイムゾーンのずれが起きないようにしている（日本時間で運用する前提）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { holidays } = require('./holidays');

const TZ = 'Asia/Tokyo';
const ACTIVE = ['booked', 'completed', 'noshow']; // 枠を使っている状態
const STATUSES = ['booked', 'completed', 'noshow', 'cancelled'];

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- 日付・時刻の小道具 ----------
function toMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return NaN;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && v <= 1440 ? v : NaN;
}
function toHM(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function addDays(s, n) {
  return new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function weekday(s) {
  return new Date(s + 'T00:00:00Z').getUTCDay();
}
function diffDays(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}
function nowJST(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
const newId = (prefix) => prefix + crypto.randomBytes(6).toString('hex');
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;
// 1行の入力欄用: 改行などの見えない文字は空白に置きかえる（メール本文に好きな行を差し込まれないため）
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
// 複数行の入力欄用（相談内容・メモ・案内文）: 改行は残し、それ以外の見えない文字だけ取り除く
const cleanText = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const EMAIL = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;
const MAX_ACTIVE_PER_EMAIL = 3; // 予約ページから、同じメールアドレスで同時に持てる「これからの予約」の数

// ---------- データの保存 ----------
function weekdayHours(start, end) {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => (d >= 1 && d <= 5 ? { start, end } : null));
}
function defaultData() {
  return {
    settings: {
      slotMinutes: 30, windowDays: 30, minLeadMinutes: 60,
      site: { name: '面談・相談のご予約', intro: '', cancelDeadlineHours: 0 },
      mail: { reminder: true, reminderHour: 18, notifyTo: '' },
      questions: [], // 予約時にお客様へ聞く質問（事前アンケート）
    },
    staff: [
      { id: 's1', name: '担当者A', hours: weekdayHours('09:00', '18:00') },
      { id: 's2', name: '担当者B', hours: weekdayHours('10:00', '19:00') },
    ],
    services: [
      { id: 'v1', name: '初回相談（30分）', minutes: 30 },
      { id: 'v2', name: '個別面談（60分）', minutes: 60 },
    ],
    bookings: [],
    blocks: [],
    recurring: [],   // 毎週くり返す予定
    closedDays: [],  // 休業日（全員）
    users: [],       // 担当者のログイン用アカウント
    audit: [],       // 操作履歴
    notifications: [],
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = defaultData();
    if (file && fs.existsSync(file)) {
      let saved;
      try {
        saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        // 壊れたファイルを空データで上書きしないよう、ここで止める
        throw new Error(`データファイル ${file} を読み込めません。backups フォルダの控えから戻してください。(${e.message})`);
      }
      this.db = Object.assign(defaultData(), saved);
      const base = defaultData().settings;
      this.db.settings = Object.assign(base, saved.settings);
      this.db.settings.site = Object.assign(defaultData().settings.site, (saved.settings || {}).site);
      this.db.settings.mail = Object.assign(defaultData().settings.mail, (saved.settings || {}).mail);
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.backup();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 }); // 個人情報が入るので、動かしている本人だけが読める設定にする
    fs.renameSync(tmp, this.file); // 書き込み途中で壊れないよう、別名で書いてから差し替える
  }
}

// 1日1回、その日の最初の保存の前に、前日までのデータを控えとして残す（直近14日分）
Store.prototype.backup = function backup(keep = 14) {
  const day = nowJST().date;
  if (this.lastBackup === day || !fs.existsSync(this.file)) return;
  this.lastBackup = day;
  const dir = path.join(path.dirname(this.file), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `db-${day}.json`);
  if (!fs.existsSync(dest)) { fs.copyFileSync(this.file, dest); fs.chmodSync(dest, 0o600); }
  const old = fs.readdirSync(dir).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(dir, f));
};

// ---------- 通知 ----------
function notify(db, type, title, body, now = new Date()) {
  const n = { id: newId('n'), type, title, body, createdAt: now.toISOString(), read: false };
  db.notifications.push(n);
  if (db.notifications.length > 300) db.notifications.splice(0, db.notifications.length - 300);
  return n;
}

// ---------- 空き枠の計算（スケジュール連動の本体） ----------
const findStaff = (db, id) => db.staff.find((s) => s.id === id);
const findService = (db, id) => db.services.find((s) => s.id === id);

const isClosed = (db, date) => db.closedDays.some((c) => c.date === date);
const recurringFor = (db, staffId, date) => db.recurring.filter((r) => r.staffId === staffId &&
  r.weekday === weekday(date) && date >= r.from && (!r.until || date <= r.until));

// その担当者のその日の受付時間。休業日・休みの曜日なら null
function dayHours(db, staff, date) {
  const h = staff.hours[weekday(date)];
  if (!h || isClosed(db, date)) return null;
  const out = { open: toMin(h.start), close: toMin(h.end), rest: null };
  if (h.breakStart && h.breakEnd) out.rest = [toMin(h.breakStart), toMin(h.breakEnd)];
  return out;
}

// その担当者・その日に「埋まっている時間帯」を返す（予約 + 個別の予定 + 毎週の予定）
function busyIntervals(db, staffId, date, exceptBookingId) {
  const out = [];
  for (const b of db.bookings) {
    if (b.staffId === staffId && b.date === date && ACTIVE.includes(b.status) && b.id !== exceptBookingId) {
      out.push([b.start, b.end]);
    }
  }
  for (const k of db.blocks) {
    if (k.staffId === staffId && k.date === date) out.push([k.start, k.end]);
  }
  for (const r of recurringFor(db, staffId, date)) out.push([r.start, r.end]);
  return out;
}

function isFree(db, staffId, date, start, end, exceptBookingId) {
  return !busyIntervals(db, staffId, date, exceptBookingId).some(([s, e]) => overlaps(start, end, s, e));
}

function staffSlots(db, staff, date, minutes, now, exceptBookingId) {
  const hours = dayHours(db, staff, date);
  if (!hours) return [];
  const { slotMinutes, minLeadMinutes } = db.settings;
  const today = nowJST(now);
  const busy = busyIntervals(db, staff.id, date, exceptBookingId);
  if (hours.rest) busy.push(hours.rest); // 休憩時間は、お客様の予約ページには出さない
  const out = [];
  for (let t = hours.open; t + minutes <= hours.close; t += slotMinutes) {
    if (diffDays(date, today.date) * 1440 + t < today.min + minLeadMinutes) continue; // 直前すぎる枠は出さない（日付をまたいでも数える）
    if (busy.some(([s, e]) => overlaps(t, t + minutes, s, e))) continue;
    out.push(t);
  }
  return out;
}

// 予約できる時間の一覧。staffId が 'any' なら「誰か空いている時間」をまとめる
function freeSlots(db, { date, serviceId, staffId, exceptBookingId }, now = new Date()) {
  if (!isDate(date)) throw new AppError('日付の形式が正しくありません。');
  const service = findService(db, serviceId);
  if (!service) throw new AppError('メニューが見つかりません。');
  const today = nowJST(now).date;
  if (date < today || diffDays(date, today) > db.settings.windowDays) return [];
  const targets = staffId && staffId !== 'any' ? [findStaff(db, staffId)].filter(Boolean) : db.staff;
  // 日時変更のときは、メニューの今の所要時間ではなく、その予約自身の長さで空きを探す
  const own = exceptBookingId && db.bookings.find((b) => b.id === exceptBookingId);
  const minutes = own ? own.end - own.start : service.minutes;
  const map = new Map();
  for (const s of targets) {
    for (const t of staffSlots(db, s, date, minutes, now, exceptBookingId)) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(s.id);
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, staffIds]) => ({ start: toHM(t), staffIds }));
}

// ---------- 予約 ----------
// opts.admin が true のときは管理画面からの登録。受付時間や締切にしばられず、
// ほかの予約・予定と重ならなければ登録できる
function createBooking(db, input, now = new Date(), opts = {}) {
  const admin = Boolean(opts.admin);
  const service = findService(db, input.serviceId);
  if (!service) throw new AppError('メニューを選んでください。');
  const customerName = clean(input.customerName, 80);
  const email = clean(input.email, 120);
  if (!customerName) throw new AppError('お名前を入力してください。');
  const emailOk = EMAIL.test(email);
  if (admin ? email && !emailOk : !emailOk) throw new AppError('メールアドレスの形式が正しくありません。');
  if (!admin) {
    // 予約ページは誰でも使えるため、宣伝文の差し込みや枠の買い占めを防ぐ
    if (/:\/\/|www\./i.test(customerName)) throw new AppError('お名前に、URL は入力できません。');
    const today = nowJST(now).date;
    const mine = db.bookings.filter((b) => b.status === 'booked' && b.date >= today && b.email && b.email.toLowerCase() === email.toLowerCase()).length;
    if (mine >= MAX_ACTIVE_PER_EMAIL) throw new AppError(`同じメールアドレスでのご予約は、同時に${MAX_ACTIVE_PER_EMAIL}件までです。追加のご予約は、直接ご連絡ください。`, 409);
  }
  const start = toMin(input.start);
  if (Number.isNaN(start)) throw new AppError(admin ? '開始時刻を入力してください。' : '時間を選んでください。');

  let staffId;
  if (admin) {
    const staff = findStaff(db, input.staffId);
    if (!staff) throw new AppError('担当者を選んでください。');
    if (!isDate(input.date)) throw new AppError('日付を入力してください。');
    if (start + service.minutes > 1440) throw new AppError('終了時刻が24時を超えます。');
    if (!isFree(db, staff.id, input.date, start, start + service.minutes)) {
      throw new AppError('その時間には別の予約・予定が入っています。', 409);
    }
    staffId = staff.id;
  } else {
    const slot = freeSlots(db, { date: input.date, serviceId: service.id, staffId: input.staffId }, now)
      .find((x) => x.start === toHM(start));
    if (!slot) throw new AppError('申し訳ありません。その時間はすでに埋まっています。別の時間をお選びください。', 409);
    // 指名なしの場合は、その日の予約がいちばん少ない担当者に割り振る
    const load = (id) => db.bookings.filter((x) => x.staffId === id && x.date === input.date && ACTIVE.includes(x.status)).length;
    staffId = slot.staffIds.slice().sort((x, y) => load(x) - load(y))[0];
  }

  const booking = {
    id: newId('b'), token: crypto.randomBytes(12).toString('hex'),
    serviceId: service.id, staffId, date: input.date, start, end: start + service.minutes,
    customerName, email, phone: clean(input.phone, 30), note: cleanText(input.note, 500),
    answers: admin ? [] : readAnswers(db, input.answers),
    status: 'booked', source: admin ? 'admin' : 'web', createdAt: now.toISOString(),
  };
  db.bookings.push(booking);
  notify(db, 'booking_new', admin ? '予約を登録しました' : '新しい予約が入りました',
    `${booking.date} ${toHM(start)}〜${toHM(booking.end)}／${service.name}／${findStaff(db, staffId).name}／${customerName} 様`, now);
  return booking;
}

// 事前アンケートの回答を確かめて、質問文と一緒に控える（あとで質問を変えても、当時の内容が残る）
function readAnswers(db, input) {
  const given = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = [];
  for (const q of db.settings.questions) {
    const value = clean(typeof given[q.id] === 'string' ? given[q.id] : '', 500);
    if (!value) {
      if (q.required) throw new AppError(`「${q.label}」にお答えください。`);
      continue;
    }
    if (q.type === 'select' && !q.options.includes(value)) throw new AppError(`「${q.label}」は、選択肢の中からお選びください。`);
    out.push({ label: q.label, value });
  }
  return out;
}

// 面談メモ（担当者だけが見る記録）を保存する
function setMemo(db, id, memo) {
  const b = db.bookings.find((x) => x.id === id);
  if (!b) throw new AppError('予約が見つかりません。', 404);
  b.memo = cleanText(typeof memo === 'string' ? memo : '', 2000);
  return b;
}

function rescheduleBooking(db, id, input, now = new Date()) {
  const b = db.bookings.find((x) => x.id === id);
  if (!b) throw new AppError('予約が見つかりません。', 404);
  if (b.status !== 'booked') throw new AppError('日時を変更できるのは「予約済」の予約だけです。', 409);
  const staff = findStaff(db, input.staffId || b.staffId);
  if (!staff) throw new AppError('担当者を選んでください。');
  if (!isDate(input.date)) throw new AppError('日付を入力してください。');
  const start = toMin(input.start);
  const minutes = b.end - b.start;
  if (Number.isNaN(start)) throw new AppError('開始時刻を入力してください。');
  if (start + minutes > 1440) throw new AppError('終了時刻が24時を超えます。');
  if (!isFree(db, staff.id, input.date, start, start + minutes, b.id)) {
    throw new AppError('その時間には別の予約・予定が入っています。', 409);
  }
  const before = `${b.date} ${toHM(b.start)}`;
  Object.assign(b, { staffId: staff.id, date: input.date, start, end: start + minutes });
  delete b.remindedAt;
  notify(db, 'booking_change', '予約の日時を変更しました',
    `${before} → ${b.date} ${toHM(b.start)}〜／${staff.name}／${b.customerName} 様`, now);
  return b;
}

// 月カレンダー用: 日ごとの「予約できる枠の数」
function availability(db, { from, to, serviceId, staffId, exceptBookingId }, now = new Date()) {
  if (!isDate(from) || !isDate(to) || diffDays(to, from) > 62) throw new AppError('期間の指定が正しくありません。');
  const today = nowJST(now).date;
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (d < today || diffDays(d, today) > db.settings.windowDays) continue;
    days[d] = freeSlots(db, { date: d, serviceId, staffId, exceptBookingId }, now).length;
  }
  return days;
}

function setBookingStatus(db, id, status, now = new Date(), byCustomer = false) {
  const b = db.bookings.find((x) => x.id === id);
  if (!b) throw new AppError('予約が見つかりません。', 404);
  if (!STATUSES.includes(status)) throw new AppError('ステータスが正しくありません。');
  if (b.status === status) return b;
  if (b.status === 'cancelled' && (!findStaff(db, b.staffId) || !findService(db, b.serviceId))) {
    throw new AppError('この予約の担当者またはメニューが削除されているため、元に戻せません。新しく予約を登録してください。', 409);
  }
  if (b.status === 'cancelled' && !isFree(db, b.staffId, b.date, b.start, b.end, b.id)) {
    throw new AppError('その時間には別の予約・予定が入っているため、元に戻せません。', 409);
  }
  b.status = status;
  if (status === 'cancelled') {
    b.cancelledAt = now.toISOString();
    const service = findService(db, b.serviceId);
    notify(db, 'booking_cancel', byCustomer ? 'お客様が予約をキャンセルしました' : '予約をキャンセルしました',
      `${b.date} ${toHM(b.start)}〜／${service ? service.name : ''}／${b.customerName} 様`, now);
  } else {
    delete b.cancelledAt;
  }
  return b;
}

// 確認用リンクの合言葉が合っている予約だけを返す
function bookingByToken(db, id, token) {
  const b = db.bookings.find((x) => x.id === id);
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const ok = b && b.token && typeof token === 'string' && crypto.timingSafeEqual(digest(token), digest(b.token));
  if (!ok) throw new AppError('予約が見つかりません。', 404);
  return b;
}

// お客様自身が変更・キャンセルできるか。できない場合は理由を返す
function changeBlockedReason(db, b, now = new Date()) {
  if (b.status !== 'booked') return 'この予約は変更・キャンセルできない状態です。';
  const t = nowJST(now);
  const minutesLeft = diffDays(b.date, t.date) * 1440 + b.start - t.min;
  if (minutesLeft <= 0) return '面談の開始時刻を過ぎているため、変更・キャンセルできません。';
  const hours = db.settings.site.cancelDeadlineHours;
  if (hours > 0 && minutesLeft < hours * 60) {
    return `面談の${hours}時間前を過ぎているため、この画面からは変更・キャンセルできません。お手数ですが、直接ご連絡ください。`;
  }
  return '';
}

function cancelByCustomer(db, id, token, now = new Date()) {
  const b = bookingByToken(db, id, token);
  const reason = changeBlockedReason(db, b, now);
  if (reason) throw new AppError(reason, 409);
  return setBookingStatus(db, id, 'cancelled', now, true);
}

function rescheduleByCustomer(db, id, token, input, now = new Date()) {
  const b = bookingByToken(db, id, token);
  const reason = changeBlockedReason(db, b, now);
  if (reason) throw new AppError(reason, 409);
  const start = toMin(input.start);
  const slot = freeSlots(db, { date: input.date, serviceId: b.serviceId, staffId: 'any', exceptBookingId: b.id }, now)
    .find((x) => x.start === toHM(start));
  if (!slot) throw new AppError('申し訳ありません。その時間はすでに埋まっています。別の時間をお選びください。', 409);
  // 同じ担当者が空いていればそのまま、空いていなければ別の担当者に変わる
  const staffId = slot.staffIds.includes(b.staffId) ? b.staffId : slot.staffIds[0];
  const before = `${b.date} ${toHM(b.start)}`;
  const minutes = b.end - b.start;
  Object.assign(b, { staffId, date: input.date, start, end: start + minutes });
  delete b.remindedAt;
  notify(db, 'booking_change', 'お客様が予約の日時を変更しました',
    `${before} → ${b.date} ${toHM(b.start)}〜／${findStaff(db, staffId).name}／${b.customerName} 様`, now);
  return b;
}

// スマホやPCのカレンダーに取り込める形式（iCalendar）で予約を書き出す
function buildIcs(db, b) {
  const utc = (date, min) => new Date(Date.parse(date + 'T00:00:00Z') + (min - 9 * 60) * 60000)
    .toISOString().replace(/[-:]|\.\d{3}/g, '');
  const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
  const service = findService(db, b.serviceId);
  const staff = findStaff(db, b.staffId);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mendan-yoyaku//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${b.id}@mendan-yoyaku`, `DTSTAMP:${utc(nowJST().date, nowJST().min)}`,
    `DTSTART:${utc(b.date, b.start)}`, `DTEND:${utc(b.date, b.end)}`,
    `SUMMARY:${esc((service ? service.name : '面談') + '（' + db.settings.site.name + '）')}`,
    `DESCRIPTION:${esc('担当: ' + (staff ? staff.name : ''))}`,
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

// ---------- 担当者の予定（この時間は予約を受け付けない） ----------
function addBlock(db, input, now = new Date()) {
  const staff = findStaff(db, input.staffId);
  if (!staff) throw new AppError('担当者を選んでください。');
  if (!isDate(input.date)) throw new AppError('日付を入力してください。');
  const start = toMin(input.start);
  const end = toMin(input.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) throw new AppError('開始・終了の時刻を正しく入力してください。');
  const title = clean(input.title, 60) || '予定';
  const say = (b) => `${b.date} ${toHM(b.start)}〜 ${b.customerName} 様`;

  if (input.repeat) { // 毎週くり返す予定
    const until = input.until || '';
    if (until && (!isDate(until) || until < input.date)) throw new AppError('くり返しの終了日を正しく入力してください。');
    const item = { id: newId('r'), staffId: staff.id, weekday: weekday(input.date), start, end, title, from: input.date, until };
    const today = nowJST(now).date;
    const clash = db.bookings.find((b) => b.staffId === staff.id && b.status === 'booked' && b.date >= today &&
      b.date >= item.from && (!until || b.date <= until) && weekday(b.date) === item.weekday && overlaps(start, end, b.start, b.end));
    if (clash) throw new AppError(`すでに入っている予約（${say(clash)}）と重なります。先に予約を調整してください。`, 409);
    db.recurring.push(item);
    return item;
  }
  const clash = db.bookings.find((b) => b.staffId === staff.id && b.date === input.date &&
    ACTIVE.includes(b.status) && overlaps(start, end, b.start, b.end));
  if (clash) throw new AppError(`その時間には予約（${say(clash)}）が入っています。`, 409);
  const block = { id: newId('k'), staffId: staff.id, date: input.date, start, end, title };
  db.blocks.push(block);
  return block;
}

// カレンダー表示用: 期間内の「毎週の予定」を、日付ごとの予定に展開する
function expandRecurring(db, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const r of db.recurring) {
      if (r.weekday === weekday(d) && d >= r.from && (!r.until || d <= r.until)) {
        out.push({ id: r.id, recurring: true, staffId: r.staffId, date: d, start: r.start, end: r.end, title: r.title });
      }
    }
  }
  return out;
}

function addClosedDay(db, input) {
  if (!isDate(input.date)) throw new AppError('日付を入力してください。');
  if (isClosed(db, input.date)) throw new AppError('その日はすでに休業日に登録されています。');
  const count = db.bookings.filter((b) => b.date === input.date && b.status === 'booked').length;
  if (count) throw new AppError(`その日には予約が${count}件入っています。先に予約を調整してください。`, 409);
  const item = { date: input.date, title: clean(input.title, 40) || '休業日' };
  db.closedDays.push(item);
  db.closedDays.sort((a, b) => (a.date < b.date ? -1 : 1));
  return item;
}

// 指定した年の祝日を、休業日としてまとめて登録する（登録済みの日と、予約が入っている日は飛ばす）
function addHolidays(db, year, now = new Date()) {
  const list = holidays(Number(year));
  if (!list.length) throw new AppError('祝日を登録できるのは、2020年〜2099年です。');
  const today = nowJST(now).date;
  const result = { added: [], skipped: [] };
  for (const h of list) {
    if (h.date < today) continue;
    if (isClosed(db, h.date)) { result.skipped.push({ ...h, reason: '登録済み' }); continue; }
    const count = db.bookings.filter((b) => b.date === h.date && b.status === 'booked').length;
    if (count) { result.skipped.push({ ...h, reason: `予約が${count}件あります` }); continue; }
    db.closedDays.push(h);
    result.added.push(h);
  }
  db.closedDays.sort((a, b) => (a.date < b.date ? -1 : 1));
  return result;
}

// ---------- 設定（担当者・メニュー）の更新 ----------
function updateConfig(db, input) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(input)) throw new AppError('送信データの形式が正しくありません。');
  const staff = (Array.isArray(input.staff) ? input.staff : []).map((s) => {
    if (!isObj(s)) throw new AppError('担当者の形式が正しくありません。');
    const name = clean(s.name, 40);
    if (!name) throw new AppError('担当者名を入力してください。');
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const h = Array.isArray(s.hours) ? s.hours[d] : null;
      if (!h) return null;
      const a = toMin(h.start);
      const z = toMin(h.end);
      if (Number.isNaN(a) || Number.isNaN(z) || a >= z) throw new AppError(`${name} さんの受付時間が正しくありません。`);
      const out = { start: toHM(a), end: toHM(z) };
      if (h.breakStart || h.breakEnd) { // 休憩は、開始・終了の両方があり、受付時間の中に収まること
        const bs = toMin(h.breakStart);
        const be = toMin(h.breakEnd);
        if (Number.isNaN(bs) || Number.isNaN(be) || bs >= be || bs < a || be > z) {
          throw new AppError(`${name} さんの休憩時間が正しくありません。受付時間の中で、開始と終了の両方を入力してください。`);
        }
        Object.assign(out, { breakStart: toHM(bs), breakEnd: toHM(be) });
      }
      return out;
    });
    return { id: db.staff.some((x) => x.id === s.id) ? s.id : newId('s'), name, hours };
  });
  const services = (Array.isArray(input.services) ? input.services : []).map((v) => {
    if (!isObj(v)) throw new AppError('メニューの形式が正しくありません。');
    const name = clean(v.name, 40);
    const minutes = Number(v.minutes);
    if (!name) throw new AppError('メニュー名を入力してください。');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) throw new AppError('所要時間は5〜480分で入力してください。');
    return { id: db.services.some((x) => x.id === v.id) ? v.id : newId('v'), name, minutes, description: clean(v.description, 200) };
  });
  if (!staff.length || !services.length) throw new AppError('担当者とメニューは、それぞれ1件以上必要です。');
  const today = nowJST().date;
  const orphan = db.bookings.find((b) => b.status === 'booked' && b.date >= today &&
    (!staff.some((s) => s.id === b.staffId) || !services.some((v) => v.id === b.serviceId)));
  if (orphan) throw new AppError('これからの予約が入っている担当者・メニューは削除できません。先に予約を整理してください。', 409);
  const st = isObj(input.settings) ? input.settings : {};
  const num = (v, min, max, cur) => (v !== '' && v != null && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : cur);
  const site = isObj(st.site) ? st.site : {};
  const mail = isObj(st.mail) ? st.mail : {};
  const notifyTo = clean(typeof mail.notifyTo === 'string' ? mail.notifyTo : '', 120);
  if (notifyTo && !EMAIL.test(notifyTo)) throw new AppError('通知先のメールアドレスの形式が正しくありません。');
  const rawQuestions = Array.isArray(st.questions) ? st.questions : [];
  if (rawQuestions.length > 10) throw new AppError('事前アンケートの質問は10件までです。');
  const questions = rawQuestions.map((q) => {
    if (!isObj(q)) throw new AppError('事前アンケートの形式が正しくありません。');
    const label = clean(q.label, 80);
    if (!label) throw new AppError('事前アンケートの質問文を入力してください。');
    const type = q.type === 'select' ? 'select' : 'text';
    const options = type === 'select'
      ? [...new Set((Array.isArray(q.options) ? q.options : String(q.options || '').split(/\r?\n|,|、/)).map((o) => clean(o, 60)).filter(Boolean))].slice(0, 20)
      : [];
    if (type === 'select' && options.length < 2) throw new AppError(`「${label}」の選択肢を2つ以上入力してください。`);
    const id = typeof q.id === 'string' && /^q[0-9a-f]{12}$/.test(q.id) ? q.id : newId('q');
    return { id, label, type, options, required: Boolean(q.required) };
  });
  const cur = db.settings;
  db.settings = Object.assign({}, cur, {
    slotMinutes: num(st.slotMinutes, 5, 120, cur.slotMinutes),
    windowDays: num(st.windowDays, 1, 365, cur.windowDays),
    minLeadMinutes: num(st.minLeadMinutes, 0, 10080, cur.minLeadMinutes),
    site: {
      name: clean(site.name, 40) || cur.site.name,
      intro: site.intro == null ? cur.site.intro : cleanText(site.intro, 400),
      cancelDeadlineHours: num(site.cancelDeadlineHours, 0, 720, cur.site.cancelDeadlineHours),
    },
    mail: {
      reminder: mail.reminder == null ? cur.mail.reminder : Boolean(mail.reminder),
      reminderHour: num(mail.reminderHour, 0, 23, cur.mail.reminderHour),
      notifyTo: mail.notifyTo == null ? cur.mail.notifyTo : notifyTo,
    },
    questions: Array.isArray(st.questions) ? questions : cur.questions,
  });
  db.staff = staff;
  db.services = services;
  db.recurring = db.recurring.filter((r) => staff.some((x) => x.id === r.staffId));
  db.blocks = db.blocks.filter((k) => staff.some((x) => x.id === k.staffId));
}

// ---------- CSV の読み込み ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const HEADER_ALIASES = {
  date: ['date', '日付', '予約日'],
  start: ['start', '開始', '開始時刻', '時間', '時刻'],
  service: ['service', 'メニュー', '種別', '相談種別'],
  minutes: ['minutes', '所要時間', '分'],
  staff: ['staff', '担当者', '担当'],
  name: ['name', '顧客名', '氏名', 'お名前', '名前'],
  email: ['email', 'メール', 'メールアドレス'],
  phone: ['phone', '電話', '電話番号'],
  note: ['note', '相談内容', '備考', 'メモ'],
  memo: ['memo', '面談メモ'],
  status: ['status', 'ステータス', '状態'],
  created: ['created', '受付日', '予約受付日', '申込日'],
};
const STATUS_ALIASES = {
  booked: ['booked', '予約済', '予約済み', '予約'],
  completed: ['completed', '完了', '実施', '実施済', '来談'],
  cancelled: ['cancelled', 'canceled', 'キャンセル', '取消'],
  noshow: ['noshow', 'no-show', '無断キャンセル', '無断欠席', '欠席'],
};

function importCsv(db, text, now = new Date()) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new AppError('CSVにデータ行がありません。1行目は見出し、2行目以降にデータを入れてください。');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(HEADER_ALIASES)) {
    col[key] = head.findIndex((h) => names.includes(h));
  }
  for (const need of ['date', 'start']) {
    if (col[need] < 0) throw new AppError(`CSVの見出しに「${HEADER_ALIASES[need][1]}」の列が必要です。`);
  }
  const today = nowJST(now).date;
  // 書き出しのときに数式よけで付けた先頭の ' は、読み込むときに外す
  const get = (r, key) => (col[key] >= 0 ? String(r[col[key]] || '').trim().replace(/^'(?=[=+\-@])/, '') : '');
  const result = { imported: 0, skipped: [], createdStaff: [], createdServices: [], from: null, to: null, cancelled: 0 };

  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const skip = (reason) => result.skipped.push({ line, reason });
    const date = get(r, 'date').replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
    const start = toMin(get(r, 'start'));
    if (!isDate(date)) return skip('日付が読み取れません');
    if (Number.isNaN(start)) return skip('開始時刻が読み取れません');

    const rawStatus = get(r, 'status').toLowerCase();
    let status = Object.keys(STATUS_ALIASES).find((k) => STATUS_ALIASES[k].includes(rawStatus));
    if (!status) {
      if (rawStatus) return skip(`ステータス「${rawStatus}」が分かりません`);
      status = date < today ? 'completed' : 'booked';
    }

    // 担当者・メニューは、この行を取り込むと決まってから追加する（スキップした行の分を残さないため）
    const serviceName = clean(get(r, 'service'), 40) || db.services[0].name;
    const csvMinutes = Number(get(r, 'minutes'));
    const hasMinutes = Number.isInteger(csvMinutes) && csvMinutes >= 5 && csvMinutes <= 480;
    const service = db.services.find((v) => v.name === serviceName) ||
      { id: newId('v'), name: serviceName, minutes: hasMinutes ? csvMinutes : 60, description: '', isNew: true };
    const staffName = clean(get(r, 'staff'), 40) || db.staff[0].name;
    // 読み込みで追加した担当者は、受付時間を空にしておく（設定するまで、予約ページには出ない）
    const staff = db.staff.find((x) => x.name === staffName) ||
      { id: newId('s'), name: staffName, hours: [null, null, null, null, null, null, null], isNew: true };
    const end = start + (hasMinutes ? csvMinutes : service.minutes); // 所要時間の列があれば、当時の長さを優先する
    if (end > 1440) return skip('終了時刻が24時を超えます');
    const customerName = clean(get(r, 'name'), 80) || '（名前なし）';
    const dup = db.bookings.some((x) => x.date === date && x.start === start && x.staffId === staff.id && x.customerName === customerName);
    if (dup) return skip('同じ予約がすでに登録されています');
    // これからの予約は、いまのスケジュールとぶつからないものだけ取り込む
    if (date >= today && status === 'booked' && !staff.isNew && !isFree(db, staff.id, date, start, end)) {
      return skip('その時間には別の予約・予定が入っています');
    }
    if (service.isNew) { delete service.isNew; db.services.push(service); result.createdServices.push(service.name); }
    if (staff.isNew) { delete staff.isNew; db.staff.push(staff); result.createdStaff.push(staff.name); }
    const createdRaw = get(r, 'created').replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
    const createdAt = isDate(createdRaw) ? createdRaw + 'T03:00:00.000Z' : date + 'T00:00:00.000Z';
    db.bookings.push({
      id: newId('b'), token: crypto.randomBytes(12).toString('hex'),
      serviceId: service.id, staffId: staff.id, date, start, end,
      customerName, email: clean(get(r, 'email'), 120), phone: clean(get(r, 'phone'), 30), note: cleanText(get(r, 'note'), 500), memo: cleanText(get(r, 'memo'), 2000) || undefined,
      status, source: 'import', createdAt, leadUnknown: !isDate(createdRaw) || undefined,
    });
    result.imported++;
    if (status === 'cancelled') result.cancelled++;
    if (!result.from || date < result.from) result.from = date;
    if (!result.to || date > result.to) result.to = date;
  });

  const parts = [`取り込み ${result.imported}件／スキップ ${result.skipped.length}件`];
  if (result.imported) {
    parts.push(`期間 ${result.from}〜${result.to}`);
    parts.push(`うちキャンセル ${result.cancelled}件（${Math.round((result.cancelled / result.imported) * 100)}%）`);
  }
  if (result.createdStaff.length) parts.push(`担当者を追加: ${result.createdStaff.join('、')}（受付時間は未設定です。予約を受ける場合は、設定で受付時間を入れてください）`);
  if (result.createdServices.length) parts.push(`メニューを追加: ${result.createdServices.join('、')}`);
  notify(db, 'import', 'CSVデータを読み込みました', parts.join('。') + '。分析タブで傾向と改善案を確認できます。', now);
  return result;
}

// ---------- 一覧・検索・顧客・書き出し ----------
const STATUS_LABEL = { booked: '予約済', completed: '完了', cancelled: 'キャンセル', noshow: '無断キャンセル' };
const nameOf = (list, id) => (list.find((x) => x.id === id) || {}).name || '';
const nameOrGone = (list, id) => nameOf(list, id) || '（削除済み）';

function searchBookings(db, { q, from, to, status } = {}, limit = 300) {
  const word = clean(q, 80).toLowerCase();
  const hit = db.bookings.filter((b) => (!from || b.date >= from) && (!to || b.date <= to) &&
    (!status || b.status === status) &&
    (!word || [b.customerName, b.email, b.phone, b.note, b.memo].some((v) => String(v || '').toLowerCase().includes(word))));
  hit.sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? 1 : -1));
  return { total: hit.length, bookings: hit.slice(0, limit) };
}

// メールアドレス（なければ名前）が同じ予約を、1人の顧客としてまとめる
function customers(db, q) {
  const today = nowJST().date;
  const map = new Map();
  for (const b of db.bookings) {
    const key = b.email ? b.email.toLowerCase() : 'name:' + b.customerName;
    if (!map.has(key)) {
      map.set(key, { key, name: b.customerName, email: b.email, phone: '', total: 0, completed: 0, cancelled: 0, noshow: 0, last: '', next: '', history: [] });
    }
    const c = map.get(key);
    c.total++;
    if (b.status !== 'booked') c[b.status]++;
    if (b.phone) c.phone = b.phone;
    if (b.status === 'completed' && b.date > c.last) { c.last = b.date; c.name = b.customerName; }
    if (b.status === 'booked' && b.date >= today && (!c.next || b.date < c.next)) c.next = b.date;
    c.history.push({ id: b.id, date: b.date, start: toHM(b.start), status: b.status,
      serviceName: nameOf(db.services, b.serviceId), staffName: nameOf(db.staff, b.staffId), note: b.note, memo: b.memo || '' });
  }
  const word = clean(q, 80).toLowerCase();
  const list = [...map.values()].filter((c) => !word || [c.name, c.email, c.phone].some((v) => String(v || '').toLowerCase().includes(word)));
  for (const c of list) c.history.sort((a, b) => (a.date + a.start < b.date + b.start ? 1 : -1));
  list.sort((a, b) => ((b.next || b.last) > (a.next || a.last) ? 1 : -1));
  return { total: list.length, customers: list.slice(0, 300) };
}

// 読み込みと同じ見出しで書き出す（Excelで文字化けしないよう先頭にBOMを付ける）
function exportCsv(db, from, to) {
  const cell = (v) => {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // 表計算ソフトで数式として実行されるのを防ぐ
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const rows = db.bookings.filter((b) => (!from || b.date >= from) && (!to || b.date <= to))
    .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1))
    .map((b) => [b.date, toHM(b.start), nameOrGone(db.services, b.serviceId), b.end - b.start, nameOrGone(db.staff, b.staffId),
      b.customerName, b.email, b.phone, STATUS_LABEL[b.status], b.leadUnknown ? '' : nowJST(new Date(b.createdAt)).date, b.note, b.memo || '',
      (b.answers || []).map((a) => `${a.label}: ${a.value}`).join(' ／ ')]);
  const head = ['日付', '開始', 'メニュー', '所要時間', '担当者', '氏名', 'メール', '電話', 'ステータス', '受付日', '相談内容', '面談メモ', 'アンケート'];
  return '\uFEFF' + [head].concat(rows).map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------- 動作確認用のサンプルデータ ----------
function seedSample(db, now = new Date()) {
  if (db.bookings.some((b) => b.source === 'sample')) throw new AppError('サンプルはすでに登録されています。入れ直す場合は、先に「サンプルを削除する」を押してください。', 409);
  let seed = 20240501;
  const rand = () => { // 毎回同じ結果になる乱数
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const today = nowJST(now).date;
  const dayWeight = [0, 0.2, 0.55, 0.6, 0.95, 0.6, 0];
  const customers = Array.from({ length: 45 }, (_, i) => ({ name: `サンプル顧客${i + 1}`, email: `sample${i + 1}@example.com` }));
  let count = 0;
  for (let d = -90; d <= 14; d++) {
    const date = addDays(today, d);
    db.staff.forEach((staff, si) => {
      const hours = staff.hours[weekday(date)];
      if (!hours) return;
      for (let t = toMin(hours.start); t + 30 <= toMin(hours.end); t += 60) {
        const hour = Math.floor(t / 60);
        const hourWeight = hour >= 13 && hour <= 15 ? 1 : hour >= 17 ? 0.15 : 0.5;
        if (rand() > dayWeight[weekday(date)] * hourWeight * (si === 0 ? 1 : 0.45)) continue;
        const service = db.services[rand() < 0.6 ? 0 : db.services.length - 1];
        const end = t + service.minutes;
        if (end > toMin(hours.end)) continue;
        const lead = Math.floor(rand() * rand() * 21);
        const roll = rand();
        let status = 'booked';
        if (d < 0) status = roll < 0.12 + lead * 0.012 ? 'cancelled' : roll > 0.93 ? 'noshow' : 'completed';
        else if (roll < 0.08) status = 'cancelled';
        if (status !== 'cancelled' && !isFree(db, staff.id, date, t, end)) continue;
        const c = customers[Math.floor(rand() * rand() * customers.length)];
        db.bookings.push({
          id: newId('b'), token: crypto.randomBytes(12).toString('hex'),
          serviceId: service.id, staffId: staff.id, date, start: t, end,
          customerName: c.name, email: c.email, phone: '', note: '',
          status, source: 'sample', createdAt: new Date(Date.parse(addDays(date, -lead) + 'T03:00:00Z')).toISOString(),
        });
        count++;
      }
    });
  }
  notify(db, 'import', 'サンプルデータを読み込みました', `${count}件の予約（過去90日〜2週間先）を登録しました。分析タブで傾向と改善案を確認できます。`, now);
  return count;
}

function clearSample(db) {
  const before = db.bookings.length;
  db.bookings = db.bookings.filter((b) => b.source !== 'sample');
  return before - db.bookings.length;
}

module.exports = {
  AppError, Store, ACTIVE, STATUSES, defaultData,
  toMin, toHM, isDate, addDays, weekday, diffDays, nowJST, overlaps,
  notify, freeSlots, availability, createBooking, rescheduleBooking, setBookingStatus, cancelByCustomer,
  searchBookings, customers, exportCsv,
  addBlock, expandRecurring, addClosedDay, isClosed, dayHours, recurringFor, updateConfig,
  setMemo, addHolidays, bookingByToken, changeBlockedReason, rescheduleByCustomer, buildIcs, findStaff, findService, clean, newId, parseCsv, importCsv, seedSample, clearSample,
};
