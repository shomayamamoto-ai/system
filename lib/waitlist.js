'use strict';
// キャンセル待ち（取り置き式）。
// 空きが出たら、登録の早い順に1人ずつ、その枠を一定時間（30分）だけ取り置いて知らせる。
// 期限までに予約されなければ取り置きを外し、次の人へ回す。先着順より公平で、空いた枠もむだになりにくい。
//
// 悪用への備え（誰でも登録できるため）:
//   ・同じメールアドレス（+以降の別名はまとめる）での登録は、24時間で3件まで（取り消しても数は戻らない）
//   ・待っている登録は、全体で300件・1日あたり30件まで
//   ・すでに登録済み・上限に達した場合も、外からは区別できない同じ返事を返し、メールは送らない

const crypto = require('node:crypto');
const { AppError, freeSlots, isOpenFor, findService, findStaff, canServe, isDate, nowJST, diffDays, toHM, toMin, weekday, clean, newId, dayHours } = require('./core');

const EMAIL = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;
const PER_EMAIL_24H = 3;
const MAX_WAITING = 300;
const MAX_WAITING_PER_DAY = 30;
const HOLD_MINUTES = 30;
const PARTS = { any: '終日', am: '午前（12時まで）', pm: '午後（12時から）' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const jp = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${WD[weekday(d)]}）`;
// メールアドレスの「+」以降（別名）を除いて、同じ人のアドレスとしてそろえる
const baseEmail = (e) => e.replace(/\+[^@]*@/, '@');
// 名前に入れられない文字列（URL や「example.com」のようなドメイン名）
const LINKISH = /:\/\/|www\.|\b[\w-]+\.[a-z]{2,}\b/i;

const inPart = (part, t) => part === 'any' || (part === 'am' ? t < '12:00' : t >= '12:00');

// その登録の条件に合う、いまの空き時間（cache を渡すと、同じ日・メニュー・担当者の計算を使い回す）
function matchingSlots(db, w, now = new Date(), cache) {
  const key = `${w.date}|${w.serviceId}|${w.staffId}`;
  let all = cache && cache.get(key);
  if (!all) {
    all = findService(db, w.serviceId) ? freeSlots(db, { date: w.date, serviceId: w.serviceId, staffId: w.staffId }, now) : [];
    if (cache) cache.set(key, all);
  }
  return all.filter((x) => inPart(w.part, x.start));
}

// その日・その時間帯に、まだ受付時間が残っているか（「今日の午前」を午後に登録する、などを防ぐ）
function partStillOpen(db, w, now) {
  const service = findService(db, w.serviceId);
  const t = nowJST(now);
  const targets = (w.staffId === 'any' ? db.staff : [findStaff(db, w.staffId)].filter(Boolean)).filter((x) => canServe(service, x.id));
  return targets.some((x) => {
    const h = dayHours(db, x, w.date);
    if (!h) return false;
    let from = h.open;
    let to = h.close;
    if (w.part === 'am') to = Math.min(to, 720);
    if (w.part === 'pm') from = Math.max(from, 720);
    if (w.date === t.date) from = Math.max(from, t.min + db.settings.minLeadMinutes);
    return to - from >= service.minutes;
  });
}

// 登録。返り値の created が false のときは「登録したことにして、何もしない」（重複・上限）
function addWaitlist(db, input, now = new Date()) {
  if (!Array.isArray(db.waitlist)) db.waitlist = [];
  const service = findService(db, input.serviceId);
  if (!service) throw new AppError('ご相談内容を選んでください。');
  const staffId = input.staffId && input.staffId !== 'any' ? input.staffId : 'any';
  if (staffId !== 'any' && (!findStaff(db, staffId) || !canServe(service, staffId))) throw new AppError('担当者を選び直してください。');
  const today = nowJST(now).date;
  if (!isDate(input.date) || input.date < today || diffDays(input.date, today) > db.settings.windowDays) throw new AppError('キャンセル待ちができるのは、予約を受け付けている期間の日付です。');
  const part = typeof input.part === 'string' && Object.hasOwn(PARTS, input.part) ? input.part : 'any';
  const customerName = clean(input.customerName, 80).normalize('NFKC');
  const email = clean(input.email, 120).normalize('NFKC').toLowerCase();
  if (!customerName) throw new AppError('お名前を入力してください。');
  if (LINKISH.test(customerName)) throw new AppError('お名前に、URL やドメイン名は入力できません。');
  if (!EMAIL.test(email)) throw new AppError('メールアドレスの形式が正しくありません。');
  const w = { id: newId('w'), token: crypto.randomBytes(12).toString('hex'), serviceId: service.id, staffId, date: input.date, part,
    customerName, email, status: 'waiting', createdAt: now.toISOString() };
  if (!isOpenFor(db, w, now) || !partStillOpen(db, w, now)) throw new AppError('この日・この時間帯は、受付をしていません。別の日時をお選びください。', 409);
  if (matchingSlots(db, w, now).length) throw new AppError('ご希望の条件で、いま空いている時間があります。そのままご予約ください。', 409);
  const waiting = db.waitlist.filter((x) => x.status === 'waiting' || x.status === 'offered');
  if (waiting.length >= MAX_WAITING || waiting.filter((x) => x.date === w.date).length >= MAX_WAITING_PER_DAY) {
    throw new AppError('申し訳ありません。この日のキャンセル待ちは、受付を締め切りました。', 409);
  }
  const since = now.getTime() - 24 * 3600 * 1000;
  const recent = db.waitlist.filter((x) => baseEmail(x.email) === baseEmail(email) && Date.parse(x.createdAt) > since);
  const dup = waiting.some((x) => x.email === email && x.date === w.date && x.serviceId === w.serviceId && x.staffId === w.staffId && x.part === w.part);
  // 重複・上限のときも、外からは同じ返事にする（登録の有無を調べられないように）
  if (dup || recent.length >= PER_EMAIL_24H) return { entry: w, created: false };
  db.waitlist.push(w);
  return { entry: w, created: true };
}

function findByToken(db, id, token) {
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const w = (db.waitlist || []).find((x) => x.id === id);
  if (!w || typeof token !== 'string' || !crypto.timingSafeEqual(digest(token), digest(w.token))) throw new AppError('キャンセル待ちの登録が見つかりません。', 404);
  return w;
}

function releaseHold(db, w) {
  if (w.holdId) db.holds = (db.holds || []).filter((h) => h.id !== w.holdId);
  delete w.holdId;
}

function cancelWaitlist(db, id, token) {
  const w = findByToken(db, id, token);
  if (w.status === 'waiting' || w.status === 'offered') { releaseHold(db, w); w.status = 'cancelled'; }
  return w;
}

// 期限の切れた取り置きを外す（その人は「見送り」になり、次の人へ回る）。日付が過ぎた登録は「期限切れ」にする
function sweep(db, now = new Date()) {
  const today = nowJST(now).date;
  const ms = now.getTime();
  let changed = 0;
  for (const w of db.waitlist || []) {
    if (w.status === 'offered') {
      const h = (db.holds || []).find((x) => x.id === w.holdId);
      if (!h || h.expiresAt <= ms) { releaseHold(db, w); w.status = 'missed'; changed++; }
    } else if (w.status === 'waiting' && w.date < today) { w.status = 'expired'; changed++; }
  }
  db.holds = (db.holds || []).filter((h) => h.expiresAt > ms);
  // 終わった登録は、30日たったら消す（データが増え続けないように）
  const old = ms - 30 * 24 * 3600 * 1000;
  db.waitlist = (db.waitlist || []).filter((w) => ['waiting', 'offered'].includes(w.status) || Date.parse(w.createdAt) > old);
  return changed;
}

// 空きが出た登録へ、早い順に1人ずつ取り置きを作る。返り値: 知らせる相手と取り置きの一覧
function makeOffers(db, now = new Date()) {
  sweep(db, now);
  if (!Array.isArray(db.holds)) db.holds = [];
  const t = nowJST(now);
  const cache = new Map();
  const out = [];
  const queue = (db.waitlist || []).filter((w) => w.status === 'waiting').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const w of queue) {
    const slots = matchingSlots(db, w, now, cache);
    if (!slots.length) continue;
    const slot = slots[0];
    const service = findService(db, w.serviceId);
    const start = toMin(slot.start);
    // 取り置きの期限は30分。ただし、面談の受付締切を過ぎないようにする
    const deadline = (diffDays(w.date, t.date) * 1440 + start - db.settings.minLeadMinutes - t.min) * 60000;
    const minutes = Math.min(HOLD_MINUTES * 60000, deadline);
    if (minutes < 10 * 60000) continue; // 10分もないときは、取り置いても予約が間に合わない
    const hold = { id: newId('h'), token: crypto.randomBytes(12).toString('hex'), waitlistId: w.id, serviceId: w.serviceId,
      staffId: slot.staffIds[0], date: w.date, start, end: start + service.minutes, expiresAt: now.getTime() + minutes };
    db.holds.push(hold);
    Object.assign(w, { status: 'offered', holdId: hold.id, offeredAt: now.toISOString() });
    cache.clear(); // 取り置いた枠は、ほかの人には出さない
    out.push({ w, hold });
  }
  return out;
}

// 取り置きの確認（予約ページで使う）
function holdByToken(db, id, token, now = new Date()) {
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const h = (db.holds || []).find((x) => x.id === id);
  if (!h || typeof token !== 'string' || !crypto.timingSafeEqual(digest(token), digest(h.token))) throw new AppError('取り置きが見つかりません。期限が切れた可能性があります。', 404);
  if (h.expiresAt <= now.getTime()) throw new AppError('取り置きの期限が切れました。申し訳ありません。', 410);
  return h;
}

const hm = (ms) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

function buildWaitlistMail(kind, db, w, hold, publicUrl) {
  const site = db.settings.site;
  const service = findService(db, w.serviceId);
  const staff = hold ? findStaff(db, hold.staffId) : w.staffId === 'any' ? null : findStaff(db, w.staffId);
  const base = publicUrl ? publicUrl.replace(/\/+$/, '') : '';
  const lines = [`${w.customerName} 様`, ''];
  if (kind === 'offer') {
    lines.push(`キャンセル待ちに登録いただいた日に、空きが出ました。${hm(hold.expiresAt)}まで、あなたのために取り置いています。`, '',
      `■ 日時　　: ${jp(hold.date)} ${toHM(hold.start)}〜${toHM(hold.end)}`, `■ 内容　　: ${service ? service.name : ''}`, `■ 担当者　: ${staff ? staff.name : ''}`, '',
      base ? `ご予約の確定はこちら（${hm(hold.expiresAt)}まで）: ${base}/?hold=${hold.id}&token=${hold.token}` : 'ご予約は、予約ページからお願いします。',
      '期限を過ぎると、次にお待ちの方へご案内します。');
  } else {
    lines.push('キャンセル待ちを受け付けました。空きが出たら、登録の早い順にお知らせし、一定時間その枠を取り置きます。', '',
      `■ 日付　　: ${jp(w.date)}（${PARTS[w.part]}）`, `■ 内容　　: ${service ? service.name : ''}`, `■ 担当者　: ${staff ? staff.name : '指名なし'}`);
    if (base) lines.push('', `登録の取り消しはこちら: ${base}/?wl=${w.id}&token=${w.token}`);
  }
  lines.push('', '※ このメールは送信専用です。お心当たりのない場合は、お手数ですが破棄してください。', '', site.name);
  const subject = kind === 'offer' ? `空きが出ました（${hm(hold.expiresAt)}まで取り置き中）` : 'キャンセル待ちを受け付けました';
  return { to: w.email, subject: `【${site.name}】${subject}`, text: lines.join('\n') };
}

module.exports = { addWaitlist, cancelWaitlist, findByToken, makeOffers, sweep, holdByToken, releaseHold, matchingSlots, buildWaitlistMail, PARTS, HOLD_MINUTES, LINKISH };
