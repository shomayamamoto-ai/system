'use strict';
// お客様へのメール（予約確認・変更・キャンセル・前日リマインド）。
// 送信には SMTP を使う。SMTP_HOST と MAIL_FROM が設定されていないときは、何も送らない。

const { toHM, nowJST, addDays, weekday, findStaff, findService } = require('./core');

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const jp = (d) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${WD[weekday(d)]}）`;

function createMailer(env = process.env, transport) {
  const from = env.MAIL_FROM || '';
  if (!transport && (!env.SMTP_HOST || !from)) {
    return { enabled: false, from: '', send: async () => { throw new Error('メール送信が設定されていません。'); } };
  }
  if (!transport) {
    const port = Number(env.SMTP_PORT) || 587;
    transport = require('nodemailer').createTransport({
      host: env.SMTP_HOST, port, secure: port === 465, // 465番は最初から暗号化、それ以外は接続後に暗号化（STARTTLS）
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
      connectionTimeout: 15000, socketTimeout: 20000,
    });
  }
  return { enabled: true, from, send: ({ to, subject, text }) => transport.sendMail({ from, to, subject, text }) };
}

// メールの件名と本文を作る。kind: confirm / change / cancel / remind
function buildMail(kind, db, b, publicUrl) {
  const site = db.settings.site;
  const service = findService(db, b.serviceId);
  const staff = findStaff(db, b.staffId);
  const head = {
    confirm: ['ご予約を受け付けました', 'ご予約ありがとうございます。下記の内容で受け付けました。'],
    change: ['ご予約の日時が変更されました', 'ご予約の内容が、下記のとおり変更されました。'],
    cancel: ['ご予約をキャンセルしました', '下記のご予約をキャンセルしました。'],
    remind: ['明日のご予約のご案内', '明日のご予約について、あらためてご案内します。'],
    remind_today: ['本日のご予約のご案内', '本日のご予約について、あらためてご案内します。'],
  }[kind];
  const lines = [
    `${b.customerName} 様`, '', head[1], '',
    `■ 日時　　: ${jp(b.date)} ${toHM(b.start)}〜${toHM(b.end)}`,
    `■ 内容　　: ${service ? service.name : ''}`,
    `■ 担当者　: ${staff ? staff.name : ''}`,
  ];
  if (publicUrl && kind !== 'cancel') {
    lines.push('', 'ご予約の確認・日時の変更・キャンセルは、下記のページから行えます。',
      `${publicUrl.replace(/\/+$/, '')}/?id=${b.id}&token=${b.token}`);
  }
  lines.push('', '※ このメールは送信専用です。お心当たりのない場合は、お手数ですが破棄してください。', '', site.name);
  return { to: b.email, subject: `【${site.name}】${head[0]}`, text: lines.join('\n') };
}

// 担当者あての知らせ（お客様が予約・変更・キャンセルしたとき）
function buildStaffMail(kind, db, b, publicUrl) {
  const service = findService(db, b.serviceId);
  const staff = findStaff(db, b.staffId);
  const head = { confirm: '新しい予約が入りました', change: 'お客様が予約の日時を変更しました', cancel: 'お客様が予約をキャンセルしました' }[kind];
  const lines = [
    head + '。', '',
    `■ 日時　　: ${jp(b.date)} ${toHM(b.start)}〜${toHM(b.end)}`,
    `■ 内容　　: ${service ? service.name : ''}`,
    `■ 担当者　: ${staff ? staff.name : ''}`,
    `■ お名前　: ${b.customerName} 様`,
    `■ メール　: ${b.email || '—'}`,
    `■ 電話　　: ${b.phone || '—'}`,
  ];
  if (b.note) lines.push(`■ 相談内容: ${b.note}`);
  for (const a of b.answers || []) lines.push(`■ ${a.label}: ${a.value}`);
  if (publicUrl) lines.push('', '管理画面: ' + publicUrl.replace(/\/+$/, '') + '/admin');
  return { to: db.settings.mail.notifyTo, subject: `【${db.settings.site.name}】${head}（${b.date} ${toHM(b.start)}〜）`, text: lines.join('\n') };
}

// いま前日リマインドを送るべき予約の一覧
function dueReminders(db, now = new Date()) {
  const { reminder, reminderHour } = db.settings.mail;
  const t = nowJST(now);
  if (!reminder || t.min < reminderHour * 60) return [];
  const tomorrow = addDays(t.date, 1);
  // きょうの送信時刻より後に入った予約は、確認メールが届いたばかりなので送らない
  const cutoff = Date.parse(t.date + 'T00:00:00+09:00') + reminderHour * 3600 * 1000;
  return db.bookings.filter((b) => b.status === 'booked' && b.date === tomorrow && b.email && !b.remindedAt &&
    ['web', 'admin'].includes(b.source) && Date.parse(b.createdAt) < cutoff);
}

// 前日に送りそこねたリマインド（サーバーが止まっていた、など）を、当日に送り直す対象の一覧。
// 面談まで1時間以上あり、前日の送信時刻より前から入っていた予約だけを対象にする。
function dueCatchUp(db, now = new Date()) {
  const { reminder, reminderHour } = db.settings.mail;
  if (!reminder) return [];
  const t = nowJST(now);
  const cutoff = Date.parse(addDays(t.date, -1) + 'T00:00:00+09:00') + reminderHour * 3600 * 1000;
  return db.bookings.filter((b) => b.status === 'booked' && b.date === t.date && b.start >= t.min + 60 && b.email && !b.remindedAt &&
    ['web', 'admin'].includes(b.source) && Date.parse(b.createdAt) < cutoff);
}

// 送り直しの時点で、そのメールにまだ意味があるか（例: キャンセル済みの予約に「予約確認」は送らない）
function stillRelevant(kind, b, now = new Date()) {
  if (!b || !b.email || b.date < nowJST(now).date) return false;
  return kind === 'cancel' ? b.status === 'cancelled' : b.status === 'booked';
}

module.exports = { createMailer, buildMail, buildStaffMail, dueReminders, dueCatchUp, stillRelevant };
