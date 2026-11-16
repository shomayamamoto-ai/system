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

// いま前日リマインドを送るべき予約の一覧
function dueReminders(db, now = new Date()) {
  const { reminder, reminderHour } = db.settings.mail;
  const t = nowJST(now);
  if (!reminder || t.min < reminderHour * 60) return [];
  const tomorrow = addDays(t.date, 1);
  const halfDay = 12 * 3600 * 1000; // 予約直後は確認メールが届いたばかりなので、リマインドは送らない
  return db.bookings.filter((b) => b.status === 'booked' && b.date === tomorrow && b.email && !b.remindedAt &&
    ['web', 'admin'].includes(b.source) && now.getTime() - Date.parse(b.createdAt) > halfDay);
}

module.exports = { createMailer, buildMail, dueReminders };
