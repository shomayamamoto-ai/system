'use strict';
// キャンセルの起きやすさの予測。
// 過去の予約（結果が出たもの: 完了・キャンセル・無断キャンセル）から、次の手がかりごとに
// 「キャンセルか無断キャンセルになった割合」を数え、予約ごとの起きやすさ（%）を出す。
//   ・申し込みから面談までの日数（先の予約ほどキャンセルされやすい、など）
//   ・初めての予約か、2回目以降か
//   ・そのお客様に、過去のキャンセル・無断キャンセルがあるか
//   ・メニュー
// 計算は「ナイーブベイズ」と呼ばれる単純な方法（手がかりごとの効き目を足し合わせる）。
// 件数の少ない手がかりは、全体の割合に引き寄せて（ならして）使い、たまたまの偏りに振り回されないようにする。
// あわせて、古いデータで作った予測で新しいデータを当てられるかを試し、「見分ける力」を示す。

const { addDays, diffDays, nowJST } = require('./core');
const { groupCustomers } = require('./identity');

const SMOOTH = 10;     // ならしの強さ（件数がこれくらい集まるまでは、全体の割合に寄せる）
const MIN_TRAIN = 50;  // 学習に必要な件数
const MIN_BAD = 5;     // 学習に必要な「キャンセル・無断キャンセル」の件数

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const decided = (b) => ['completed', 'cancelled', 'noshow'].includes(b.status);
const isBad = (b) => b.status === 'cancelled' || b.status === 'noshow';
const createdDay = (b) => nowJST(new Date(b.createdAt)).date;

function leadBucket(b) {
  if (b.leadUnknown) return null;
  const L = Math.max(0, diffDays(b.date, createdDay(b)));
  return L <= 1 ? '0-1' : L <= 6 ? '2-6' : L <= 13 ? '7-13' : '14+';
}
const LEAD_LABEL = { '0-1': '申し込みから面談まで1日以内', '2-6': '申し込みから面談まで2〜6日', '7-13': '申し込みから面談まで7〜13日', '14+': '申し込みから面談まで14日以上' };

// 予約ごとの手がかり。そのお客様の「この予約を申し込む前」の履歴だけを使う（あとから分かる情報は使わない）
function featuresOf(bookings) {
  const out = new Map();
  for (const g of groupCustomers(bookings)) {
    const list = g.bookings.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    list.forEach((b, i) => {
      const before = list.slice(0, i); // この予約より前に申し込まれた予約
      // この予約を申し込んだ時点で、すでに分かっていたキャンセル・無断キャンセルだけを数える
      const priorBad = before.filter((x) => (x.status === 'noshow' && x.date < createdDay(b)) ||
        (x.status === 'cancelled' && (x.cancelledAt ? x.cancelledAt < b.createdAt : x.date < createdDay(b)))).length;
      out.set(b, {
        lead: leadBucket(b),
        visit: before.length ? 'repeat' : 'first',
        history: priorBad ? 'hadBad' : 'clean',
        service: 'svc:' + b.serviceId,
      });
    });
  }
  return out;
}

// 学習: 手がかりの値ごとに、キャンセル・無断キャンセルになった割合を数える
function train(rows, feats) {
  const n = rows.length;
  const bad = rows.filter(isBad).length;
  if (n < MIN_TRAIN || bad < MIN_BAD) return null;
  const base = bad / n;
  const table = {};
  for (const b of rows) {
    for (const [k, v] of Object.entries(feats.get(b))) {
      if (v == null) continue;
      const key = k + '=' + v;
      if (!table[key]) table[key] = { n: 0, bad: 0 };
      table[key].n++;
      if (isBad(b)) table[key].bad++;
    }
  }
  // ならした割合 → 全体との差（ロジット）
  const effect = {};
  for (const [key, t] of Object.entries(table)) {
    const p = (t.bad + SMOOTH * base) / (t.n + SMOOTH);
    effect[key] = { lift: logit(p) - logit(base), rate: p, n: t.n };
  }
  return { base, n, bad, effect };
}

function score(model, f) {
  let x = logit(model.base);
  const reasons = [];
  for (const [k, v] of Object.entries(f)) {
    if (v == null) continue;
    const e = model.effect[k + '=' + v];
    if (!e) continue;
    x += e.lift;
    if (e.lift > 0.25 && e.n >= 5) reasons.push({ key: k, value: v, rate: e.rate, lift: e.lift });
  }
  const p = Math.min(0.95, Math.max(0.01, sigmoid(x)));
  reasons.sort((a, b) => b.lift - a.lift);
  return { p, reasons };
}

// 見分ける力（AUC）: キャンセルになった予約とならなかった予約を1組ずつ比べ、前者の点数が高かった割合。
// 0.5 は当てずっぽうと同じ、1.0 は完全に見分けられる
function auc(pairs) {
  const pos = pairs.filter((x) => x.bad).map((x) => x.p);
  const neg = pairs.filter((x) => !x.bad).map((x) => x.p);
  if (!pos.length || !neg.length) return null;
  let win = 0;
  for (const a of pos) for (const b of neg) win += a > b ? 1 : a === b ? 0.5 : 0;
  return win / (pos.length * neg.length);
}

function levelOf(p, base) {
  if (p >= Math.max(0.2, base * 1.8)) return 'high';
  if (p >= base * 1.25) return 'mid';
  return 'low';
}

function reasonText(r, db) {
  if (r.key === 'lead') return LEAD_LABEL[r.value];
  if (r.key === 'visit') return r.value === 'first' ? '初めてのご予約' : '2回目以降のご予約';
  if (r.key === 'history') return r.value === 'hadBad' ? '過去にキャンセル・無断キャンセルあり' : '';
  if (r.key === 'service') {
    const v = db.services.find((x) => 'svc:' + x.id === r.value);
    return `メニュー「${v ? v.name : '（削除済み）'}」`;
  }
  return '';
}

// 予測の全体: 学習・当たり具合の確認・これからの予約への点数づけ
function riskModel(db, now = new Date(), { days = 14 } = {}) {
  const today = nowJST(now).date;
  const feats = featuresOf(db.bookings);
  const past = db.bookings.filter((b) => decided(b) && b.date < today);

  // 当たり具合の確認: 直近30日より前で学習し、直近30日を当てる
  const cut = addDays(today, -30);
  const trainOld = train(past.filter((b) => b.date < cut), feats);
  const test = past.filter((b) => b.date >= cut);
  let check = null;
  if (trainOld && test.length >= 20 && test.some(isBad)) {
    const pairs = test.map((b) => ({ p: score(trainOld, feats.get(b)).p, bad: isBad(b) }));
    const hi = pairs.filter((x) => levelOf(x.p, trainOld.base) === 'high');
    const rest = pairs.filter((x) => levelOf(x.p, trainOld.base) !== 'high');
    const rateOf = (list) => (list.length ? list.filter((x) => x.bad).length / list.length : null);
    check = { auc: auc(pairs), tested: pairs.length, highCount: hi.length, highRate: rateOf(hi), restRate: rateOf(rest) };
  }

  const model = train(past, feats);
  if (!model) return { ready: false, needed: MIN_TRAIN, have: past.length, check: null, upcoming: [] };
  const upcoming = db.bookings.filter((b) => b.status === 'booked' && b.date >= today && b.date <= addDays(today, days))
    .map((b) => {
      const s = score(model, feats.get(b));
      return { id: b.id, date: b.date, start: b.start, staffId: b.staffId, serviceId: b.serviceId, customerName: b.customerName,
        p: s.p, level: levelOf(s.p, model.base), reasons: s.reasons.map((r) => reasonText(r, db)).filter(Boolean) };
    })
    .sort((a, b) => b.p - a.p);
  return { ready: true, base: model.base, trained: model.n, bad: model.bad, check, upcoming };
}

module.exports = { riskModel, featuresOf, auc, levelOf };
