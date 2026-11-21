'use strict';
// キャンセル待ち: 埋まっている日にお客様が登録しておき、空きが出たらメールで知らせる。
// 空いた枠をむだにしないための仕組み。知らせは「先着順」で、登録した人の予約を自動では取らない。

const crypto = require('node:crypto');
const { AppError, freeSlots, isOpenFor, findService, findStaff, canServe, isDate, nowJST, diffDays, toHM, weekday, clean, newId } = require('./core');

const EMAIL = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;
const MAX_PER_EMAIL = 3; // 同じメールアドレスで同時に待てる件数
const PARTS = { any: '終日', am: '午前（12時まで）', pm: '午後（12時から）' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const jp = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${WD[weekday(d)]}）`;

// その登録の条件に合う、いまの空き時間
function matchingSlots(db, w, now = new Date()) {
  const service = findService(db, w.serviceId);
  if (!service) return [];
  return freeSlots(db, { date: w.date, serviceId: w.serviceId, staffId: w.staffId }, now).map((x) => x.start)
    .filter((t) => w.part === 'any' || (w.part === 'am' ? t < '12:00' : t >= '12:00'));
}

function addWaitlist(db, input, now = new Date()) {
  if (!Array.isArray(db.waitlist)) db.waitlist = [];
  const service = findService(db, input.serviceId);
  if (!service) throw new AppError('ご相談内容を選んでください。');
  const staffId = input.staffId && input.staffId !== 'any' ? input.staffId : 'any';
  if (staffId !== 'any' && (!findStaff(db, staffId) || !canServe(service, staffId))) throw new AppError('担当者を選び直してください。');
  const today = nowJST(now).date;
  if (!isDate(input.date) || input.date < today || diffDays(input.date, today) > db.settings.windowDays) throw new AppError('キャンセル待ちができるのは、予約を受け付けている期間の日付です。');
  const part = Object.hasOwn(PARTS, input.part) ? input.part : 'any';
  const customerName = clean(input.customerName, 80);
  const email = clean(input.email, 120).normalize('NFKC').toLowerCase();
  if (!customerName) throw new AppError('お名前を入力してください。');
  if (/:\/\/|www\./i.test(customerName)) throw new AppError('お名前に、URL は入力できません。');
  if (!EMAIL.test(email)) throw new AppError('メールアドレスの形式が正しくありません。');
  const w = { id: newId('w'), token: crypto.randomBytes(12).toString('hex'), serviceId: service.id, staffId, date: input.date, part,
    customerName, email, status: 'waiting', createdAt: now.toISOString() };
  if (!isOpenFor(db, w, now)) throw new AppError('この日は、受付をしていません。別の日をお選びください。', 409);
  if (matchingSlots(db, w, now).length) throw new AppError('ご希望の条件で、いま空いている時間があります。そのままご予約ください。', 409);
  const mine = db.waitlist.filter((x) => x.status === 'waiting' && x.email === email);
  if (mine.some((x) => x.date === w.date && x.serviceId === w.serviceId && x.staffId === w.staffId && x.part === w.part)) {
    throw new AppError('同じ条件で、すでにキャンセル待ちに登録されています。', 409);
  }
  if (mine.length >= MAX_PER_EMAIL) throw new AppError(`キャンセル待ちは、同じメールアドレスで${MAX_PER_EMAIL}件までです。`, 409);
  db.waitlist.push(w);
  return w;
}

function cancelWaitlist(db, id, token) {
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const w = (db.waitlist || []).find((x) => x.id === id);
  if (!w || typeof token !== 'string' || !crypto.timingSafeEqual(digest(token), digest(w.token))) throw new AppError('キャンセル待ちの登録が見つかりません。', 404);
  if (w.status === 'waiting') w.status = 'cancelled';
  return w;
}

// いま知らせるべき登録（空きが出たもの）を返す。日付が過ぎた登録は「期限切れ」にする
function dueWaitlist(db, now = new Date()) {
  const today = nowJST(now).date;
  const out = [];
  for (const w of db.waitlist || []) {
    if (w.status !== 'waiting') continue;
    if (w.date < today) { w.status = 'expired'; continue; }
    const slots = matchingSlots(db, w, now);
    if (slots.length) out.push({ w, slots });
  }
  return out;
}

function buildWaitlistMail(kind, db, w, slots, publicUrl) {
  const site = db.settings.site;
  const service = findService(db, w.serviceId);
  const staff = w.staffId === 'any' ? null : findStaff(db, w.staffId);
  const base = publicUrl ? publicUrl.replace(/\/+$/, '') : '';
  const lines = [`${w.customerName} 様`, ''];
  if (kind === 'open') {
    lines.push('キャンセル待ちに登録いただいた日時に、空きが出ました。', '',
      `■ 日付　　: ${jp(w.date)}（${PARTS[w.part]}）`, `■ 内容　　: ${service ? service.name : ''}`, `■ 担当者　: ${staff ? staff.name : '指名なし'}`,
      `■ 空いた時間: ${slots.slice(0, 8).join('、')}${slots.length > 8 ? ' ほか' : ''}`, '',
      '先着順のため、ご予約の時点で埋まっている場合があります。ご了承ください。',
      base ? `ご予約はこちら: ${base}/?date=${w.date}&service=${w.serviceId}` : 'ご予約は、予約ページからお願いします。');
  } else {
    lines.push('キャンセル待ちを受け付けました。空きが出たら、このメールアドレスにお知らせします。', '',
      `■ 日付　　: ${jp(w.date)}（${PARTS[w.part]}）`, `■ 内容　　: ${service ? service.name : ''}`, `■ 担当者　: ${staff ? staff.name : '指名なし'}`);
    if (base) lines.push('', `登録の取り消しはこちら: ${base}/?wl=${w.id}&token=${w.token}`);
  }
  lines.push('', '※ このメールは送信専用です。お心当たりのない場合は、お手数ですが破棄してください。', '', site.name);
  const subject = kind === 'open' ? 'ご希望の日時に空きが出ました' : 'キャンセル待ちを受け付けました';
  return { to: w.email, subject: `【${site.name}】${subject}`, text: lines.join('\n') };
}

module.exports = { addWaitlist, cancelWaitlist, dueWaitlist, matchingSlots, buildWaitlistMail, PARTS };
