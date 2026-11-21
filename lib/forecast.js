'use strict';
// これからの予約数の見込み（予測）。
// 考え方: 同じ曜日の過去8週間の予約数（キャンセルを除く）の平均を、その曜日の見込みとする。
// 休業日など受付のなかった日は、平均から外す。見込みには「幅」（おおよそ8割の確率で入る範囲）を付ける。
// あわせて、同じ方法で過去4週間を予測してみて、どれだけ当たったか（誤差）を示す。

const { ACTIVE, addDays, weekday, nowJST, capacityMinutes } = require('./core');

const Z80 = 1.2816; // 8割の確率で入る範囲の目安（正規分布の上下10%点）

function dayCount(db, date) {
  return db.bookings.filter((b) => b.date === date && ACTIVE.includes(b.status)).length;
}
const isOpen = (db, date) => db.staff.some((s) => capacityMinutes(db, s, date) > 0);

// date と同じ曜日で、before より前の直近 weeks 週ぶんのうち、受付のあった日の予約数の一覧。
// before（ふつうは今日）以降の日は、まだ予約が出そろっていないので使わない
function history(db, date, weeks, before) {
  let k = 1;
  while (addDays(date, -7 * k) >= before) k++;
  const out = [];
  for (let j = 0; j < weeks; j++) {
    const d = addDays(date, -7 * (k + j));
    if (isOpen(db, d)) out.push(dayCount(db, d));
  }
  return out;
}
function stats(values) {
  const n = values.length;
  const mean = n ? values.reduce((a, v) => a + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd };
}

function forecast(db, now = new Date(), { weeks = 8, horizon = 28 } = {}) {
  const today = nowJST(now).date;
  const cap = (db.settings.loadCap == null ? 80 : db.settings.loadCap) / 100;
  // 1件あたりの平均時間（過去の実績から。なければ60分）
  const past = db.bookings.filter((b) => ACTIVE.includes(b.status) && b.date < today && b.date >= addDays(today, -7 * weeks));
  const avgMinutes = past.length ? past.reduce((a, b) => a + (b.end - b.start), 0) / past.length : 60;

  const days = [];
  for (let i = 0; i < horizon; i++) {
    const date = addDays(today, i);
    const capacity = db.staff.reduce((a, s) => a + capacityMinutes(db, s, date), 0);
    if (!capacity) continue; // 受付のない日は見込みを出さない
    const confirmed = dayCount(db, date);
    // 見込みの元にするのは「今日より前」の実績だけ（今日以降の分は、まだ予約が出そろっていないため）
    const st = stats(history(db, date, weeks, today));
    if (st.n < 3) { days.push({ date, confirmed, capacity, enough: false }); continue; }
    // ばらつきは、実績のばらつきと「件数の数え方そのもののばらつき（√平均）」の大きいほうを使う
    const spread = Z80 * Math.max(st.sd, Math.sqrt(st.mean));
    const expected = Math.max(st.mean, confirmed); // すでに入っている予約より少ない見込みにはしない
    const load = (expected * avgMinutes) / capacity;
    days.push({
      date, confirmed, capacity, enough: true, samples: st.n,
      expected: Math.round(expected * 10) / 10,
      low: Math.max(confirmed, Math.floor(st.mean - spread)), high: Math.max(confirmed, Math.ceil(st.mean + spread)),
      load, level: load > cap ? 'busy' : load < 0.3 ? 'quiet' : 'normal',
    });
  }

  // 予測の当たり具合: 過去4週間の受付日を、その日より前のデータだけで予測して比べる
  let errSum = 0;
  let baseSum = 0;
  let n = 0;
  for (let i = 1; i <= 28; i++) {
    const date = addDays(today, -i);
    if (!isOpen(db, date)) continue;
    const st = stats(history(db, date, weeks, date));
    if (st.n < 3) continue;
    // 比べる相手: 曜日を区別せず「直近8週間の1日あたりの平均」で予測した場合
    const all = [];
    for (let k = 1; k <= weeks * 7; k++) { const d = addDays(date, -k); if (isOpen(db, d)) all.push(dayCount(db, d)); }
    const actual = dayCount(db, date);
    errSum += Math.abs(st.mean - actual);
    baseSum += Math.abs(stats(all).mean - actual);
    n++;
  }
  const accuracy = n ? { days: n, mae: errSum / n, baseline: baseSum / n } : null;
  return { today, weeks, avgMinutes, cap: Math.round(cap * 100), days, accuracy };
}

module.exports = { forecast };
