'use strict';
// 予約システムの中心となる処理。
// 日付は "YYYY-MM-DD"、時刻は 0時からの「分」で持ち、
// タイムゾーンのずれが起きないようにしている（日本時間で運用する前提）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ---------- データの保存 ----------
function weekdayHours(start, end) {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => (d >= 1 && d <= 5 ? { start, end } : null));
}
function defaultData() {
  return {
    settings: { slotMinutes: 30, windowDays: 30, minLeadMinutes: 60 },
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
    notifications: [],
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = defaultData();
    if (file && fs.existsSync(file)) {
      this.db = Object.assign(defaultData(), JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file); // 書き込み途中で壊れないよう、別名で書いてから差し替える
  }
}

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

// その担当者・その日に「埋まっている時間帯」を返す（予約 + 個別の予定）
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
  return out;
}

function isFree(db, staffId, date, start, end, exceptBookingId) {
  return !busyIntervals(db, staffId, date, exceptBookingId).some(([s, e]) => overlaps(start, end, s, e));
}

function staffSlots(db, staff, date, minutes, now) {
  const hours = staff.hours[weekday(date)];
  if (!hours) return [];
  const { slotMinutes, minLeadMinutes } = db.settings;
  const today = nowJST(now);
  const open = toMin(hours.start);
  const close = toMin(hours.end);
  const busy = busyIntervals(db, staff.id, date);
  const out = [];
  for (let t = open; t + minutes <= close; t += slotMinutes) {
    if (date === today.date && t < today.min + minLeadMinutes) continue; // 直前すぎる枠は出さない
    if (busy.some(([s, e]) => overlaps(t, t + minutes, s, e))) continue;
    out.push(t);
  }
  return out;
}

// 予約できる時間の一覧。staffId が 'any' なら「誰か空いている時間」をまとめる
function freeSlots(db, { date, serviceId, staffId }, now = new Date()) {
  if (!isDate(date)) throw new AppError('日付の形式が正しくありません。');
  const service = findService(db, serviceId);
  if (!service) throw new AppError('メニューが見つかりません。');
  const today = nowJST(now).date;
  if (date < today || diffDays(date, today) > db.settings.windowDays) return [];
  const targets = staffId && staffId !== 'any' ? [findStaff(db, staffId)].filter(Boolean) : db.staff;
  const map = new Map();
  for (const s of targets) {
    for (const t of staffSlots(db, s, date, service.minutes, now)) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(s.id);
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, staffIds]) => ({ start: toHM(t), staffIds }));
}

// ---------- 予約 ----------
function createBooking(db, input, now = new Date()) {
  const service = findService(db, input.serviceId);
  if (!service) throw new AppError('メニューを選んでください。');
  const customerName = clean(input.customerName, 80);
  const email = clean(input.email, 120);
  if (!customerName) throw new AppError('お名前を入力してください。');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('メールアドレスの形式が正しくありません。');
  const start = toMin(input.start);
  if (Number.isNaN(start)) throw new AppError('時間を選んでください。');

  const slot = freeSlots(db, { date: input.date, serviceId: service.id, staffId: input.staffId }, now)
    .find((s) => s.start === toHM(start));
  if (!slot) throw new AppError('申し訳ありません。その時間はすでに埋まっています。別の時間をお選びください。', 409);

  // 指名なしの場合は、その日の予約がいちばん少ない担当者に割り振る
  const load = (id) => db.bookings.filter((b) => b.staffId === id && b.date === input.date && ACTIVE.includes(b.status)).length;
  const staffId = slot.staffIds.slice().sort((a, b) => load(a) - load(b))[0];

  const booking = {
    id: newId('b'), token: crypto.randomBytes(12).toString('hex'),
    serviceId: service.id, staffId, date: input.date, start, end: start + service.minutes,
    customerName, email, phone: clean(input.phone, 30), note: clean(input.note, 500),
    status: 'booked', source: 'web', createdAt: now.toISOString(),
  };
  db.bookings.push(booking);
  notify(db, 'booking_new', '新しい予約が入りました',
    `${booking.date} ${toHM(start)}〜${toHM(booking.end)}／${service.name}／${findStaff(db, staffId).name}／${customerName} 様`, now);
  return booking;
}

function setBookingStatus(db, id, status, now = new Date(), byCustomer = false) {
  const b = db.bookings.find((x) => x.id === id);
  if (!b) throw new AppError('予約が見つかりません。', 404);
  if (!STATUSES.includes(status)) throw new AppError('ステータスが正しくありません。');
  if (b.status === status) return b;
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

function cancelByCustomer(db, id, token, now = new Date()) {
  const b = db.bookings.find((x) => x.id === id);
  const ok = b && b.token && typeof token === 'string' && token.length === b.token.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(b.token));
  if (!ok) throw new AppError('予約が見つかりません。', 404);
  if (b.status !== 'booked') throw new AppError('この予約はキャンセルできない状態です。', 409);
  return setBookingStatus(db, id, 'cancelled', now, true);
}

// ---------- 担当者の予定（この時間は予約を受け付けない） ----------
function addBlock(db, input) {
  const staff = findStaff(db, input.staffId);
  if (!staff) throw new AppError('担当者を選んでください。');
  if (!isDate(input.date)) throw new AppError('日付を入力してください。');
  const start = toMin(input.start);
  const end = toMin(input.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) throw new AppError('開始・終了の時刻を正しく入力してください。');
  const clash = db.bookings.find((b) => b.staffId === staff.id && b.date === input.date &&
    ACTIVE.includes(b.status) && overlaps(start, end, b.start, b.end));
  if (clash) throw new AppError(`その時間には予約（${toHM(clash.start)}〜 ${clash.customerName} 様）が入っています。`, 409);
  const block = { id: newId('k'), staffId: staff.id, date: input.date, start, end, title: clean(input.title, 60) || '予定' };
  db.blocks.push(block);
  return block;
}

// ---------- 設定（担当者・メニュー）の更新 ----------
function updateConfig(db, input) {
  const staff = (Array.isArray(input.staff) ? input.staff : []).map((s) => {
    const name = clean(s.name, 40);
    if (!name) throw new AppError('担当者名を入力してください。');
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const h = Array.isArray(s.hours) ? s.hours[d] : null;
      if (!h) return null;
      const a = toMin(h.start);
      const z = toMin(h.end);
      if (Number.isNaN(a) || Number.isNaN(z) || a >= z) throw new AppError(`${name} さんの受付時間が正しくありません。`);
      return { start: toHM(a), end: toHM(z) };
    });
    return { id: db.staff.some((x) => x.id === s.id) ? s.id : newId('s'), name, hours };
  });
  const services = (Array.isArray(input.services) ? input.services : []).map((v) => {
    const name = clean(v.name, 40);
    const minutes = Number(v.minutes);
    if (!name) throw new AppError('メニュー名を入力してください。');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) throw new AppError('所要時間は5〜480分で入力してください。');
    return { id: db.services.some((x) => x.id === v.id) ? v.id : newId('v'), name, minutes };
  });
  if (!staff.length || !services.length) throw new AppError('担当者とメニューは、それぞれ1件以上必要です。');
  const today = nowJST().date;
  const orphan = db.bookings.find((b) => b.status === 'booked' && b.date >= today &&
    (!staff.some((s) => s.id === b.staffId) || !services.some((v) => v.id === b.serviceId)));
  if (orphan) throw new AppError('これからの予約が入っている担当者・メニューは削除できません。先に予約を整理してください。', 409);
  const st = input.settings || {};
  const num = (v, min, max, cur) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : cur);
  db.settings = {
    slotMinutes: num(st.slotMinutes, 5, 120, db.settings.slotMinutes),
    windowDays: num(st.windowDays, 1, 365, db.settings.windowDays),
    minLeadMinutes: num(st.minLeadMinutes, 0, 10080, db.settings.minLeadMinutes),
  };
  db.staff = staff;
  db.services = services;
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
  const get = (r, key) => (col[key] >= 0 ? String(r[col[key]] || '').trim() : '');
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

    const serviceName = clean(get(r, 'service'), 40) || db.services[0].name;
    let service = db.services.find((v) => v.name === serviceName);
    if (!service) {
      const m = Number(get(r, 'minutes'));
      service = { id: newId('v'), name: serviceName, minutes: Number.isInteger(m) && m >= 5 && m <= 480 ? m : 60 };
      db.services.push(service);
      result.createdServices.push(service.name);
    }
    const staffName = clean(get(r, 'staff'), 40) || db.staff[0].name;
    let staff = db.staff.find((s) => s.name === staffName);
    if (!staff) {
      staff = { id: newId('s'), name: staffName, hours: weekdayHours('09:00', '18:00') };
      db.staff.push(staff);
      result.createdStaff.push(staff.name);
    }
    const end = start + service.minutes;
    if (end > 1440) return skip('終了時刻が24時を超えます');
    const customerName = clean(get(r, 'name'), 80) || '（名前なし）';
    const dup = db.bookings.some((b) => b.date === date && b.start === start && b.staffId === staff.id && b.customerName === customerName);
    if (dup) return skip('同じ予約がすでに登録されています');
    // これからの予約は、いまのスケジュールとぶつからないものだけ取り込む
    if (date >= today && status === 'booked' && !isFree(db, staff.id, date, start, end)) {
      return skip('その時間には別の予約・予定が入っています');
    }
    const createdRaw = get(r, 'created').replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
    const createdAt = isDate(createdRaw) ? createdRaw + 'T03:00:00.000Z' : date + 'T00:00:00.000Z';
    db.bookings.push({
      id: newId('b'), token: crypto.randomBytes(12).toString('hex'),
      serviceId: service.id, staffId: staff.id, date, start, end,
      customerName, email: clean(get(r, 'email'), 120), phone: '', note: '',
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
  if (result.createdStaff.length) parts.push(`担当者を追加: ${result.createdStaff.join('、')}`);
  if (result.createdServices.length) parts.push(`メニューを追加: ${result.createdServices.join('、')}`);
  notify(db, 'import', 'CSVデータを読み込みました', parts.join('。') + '。分析タブで傾向と改善案を確認できます。', now);
  return result;
}

// ---------- 動作確認用のサンプルデータ ----------
function seedSample(db, now = new Date()) {
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
  notify, freeSlots, createBooking, setBookingStatus, cancelByCustomer,
  addBlock, updateConfig, parseCsv, importCsv, seedSample, clearSample,
};
