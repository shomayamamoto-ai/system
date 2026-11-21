'use strict';
// 顧客の名寄せ: 表記の違い（全角・半角、大文字・小文字、ハイフン、空白）で
// 同じお客様が別人として数えられないようにする。

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC'); // 全角英数字・全角空白などを半角にそろえる

const normEmail = (v) => nfkc(v).trim().toLowerCase();
// 電話番号は数字だけにする。国番号つき（+81 90…）は、国内の書き方（090…）に直す
function normPhone(v) {
  let t = nfkc(v).replace(/[^\d+]/g, '');
  if (t.startsWith('+81')) t = '0' + t.slice(3).replace(/^0/, '');
  t = t.replace(/\D/g, '');
  return t.length >= 10 ? t : ''; // 短すぎる番号（内線など）は、本人の手がかりにしない
}
const normName = (v) => nfkc(v).replace(/\s+/g, '').toLowerCase();

// 予約を「同じお客様」ごとにまとめる。
// メールアドレスか電話番号のどちらかが同じなら同一人物とみなす（どちらもない予約は、名前で判断する）。
function groupCustomers(bookings) {
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const join = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const keysOf = (b) => {
    const keys = [];
    if (normEmail(b.email)) keys.push('e:' + normEmail(b.email));
    if (normPhone(b.phone)) keys.push('p:' + normPhone(b.phone));
    if (!keys.length) keys.push('n:' + normName(b.customerName));
    return keys;
  };
  const all = bookings.map((b) => ({ b, keys: keysOf(b) }));
  for (const { keys } of all) {
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    for (const k of keys.slice(1)) join(keys[0], k);
  }
  const groups = new Map();
  for (const { b, keys } of all) {
    const root = find(keys[0]);
    if (!groups.has(root)) groups.set(root, { key: root, bookings: [] });
    groups.get(root).bookings.push(b);
  }
  return [...groups.values()];
}

module.exports = { normEmail, normPhone, normName, groupCustomers };
