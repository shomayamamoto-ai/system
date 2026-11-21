'use strict';
// これからの予約数の見込み（予測）。
//
// 2つの見込み方を用意し、過去のデータで「どちらがよく当たるか」を試してから使う。
//   A. 曜日の平均: 同じ曜日の過去8週間の予約数（キャンセルを除く）の平均。
//   B. 入り方（ペース）も使う: 「面談日の L日前の時点で、最終的な予約の何割が入っているか」を過去の実績から求め、
//      いま入っている件数 ÷ その割合 で最終的な件数を見込む。これを A と混ぜる（すでに多く入っている日ほど B を重く見る）。
//      あわせて、週ごとの件数に増減の傾向がはっきりある場合は、その分を見込みに足し引きする。
// 休業日など受付のなかった日は、平均から外す。見込みには「幅」（おおよそ8割の確率で入る範囲）を付ける。

const { ACTIVE, addDays, weekday, diffDays, nowJST, capacityMinutes } = require('./core');
const { trendOf } = require('./stats');

const Z80 = 1.2816; // 8割の確率で入る範囲の目安（正規分布の上下10%点）
const MAX_LEAD = 60; // ペースを調べる最大の日数

// 同じ集計を何度もくり返すので、1回の forecast() の間だけ、日付ごとの予約の一覧と受付の有無を覚えておく
let memo = null;
function begin(db) {
  const byDate = new Map();
  for (const b of db.bookings) {
    if (!ACTIVE.includes(b.status)) continue;
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }
  memo = { byDate, open: new Map(), created: new Map() };
}
const createdDay = (b) => {
  if (!memo) return nowJST(new Date(b.createdAt)).date;
  if (!memo.created.has(b)) memo.created.set(b, nowJST(new Date(b.createdAt)).date);
  return memo.created.get(b);
};
const isOpen = (db, date) => {
  if (memo && memo.open.has(date)) return memo.open.get(date);
  const v = db.staff.some((s) => capacityMinutes(db, s, date) > 0);
  if (memo) memo.open.set(date, v);
  return v;
};
const activeOn = (db, date) => (memo ? memo.byDate.get(date) || [] : db.bookings.filter((b) => b.date === date && ACTIVE.includes(b.status)));
const dayCount = (db, date) => activeOn(db, date).length;
// asOf の時点で、その日に入っていた予約の数（いまキャンセルされているものは数えない）
const countAsOf = (db, date, asOf) => activeOn(db, date).filter((b) => !b.leadUnknown && createdDay(b) <= asOf).length;

// date と同じ曜日で、before より前の直近 weeks 週ぶんのうち、受付のあった日の予約数の一覧
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

// 入り方のペース: pace[L] ＝ 面談日の L日前までに入っていた予約の割合（before より前の面談だけで計算する）
function paceCurve(db, before, weeks) {
  const key = 'pace|' + before + '|' + weeks;
  if (memo && memo.open.has(key)) return memo.open.get(key);
  const v = paceCurveRaw(db, before, weeks);
  if (memo) memo.open.set(key, v);
  return v;
}
function paceCurveRaw(db, before, weeks) {
  const from = addDays(before, -7 * weeks);
  const leads = db.bookings.filter((b) => ACTIVE.includes(b.status) && !b.leadUnknown && b.date < before && b.date >= from)
    .map((b) => Math.max(0, diffDays(b.date, createdDay(b))));
  if (leads.length < 30) return null; // 件数が少ないと、割合がぶれて当てにならない
  const pace = [];
  for (let L = 0; L <= MAX_LEAD; L++) pace.push(leads.filter((x) => x >= L).length / leads.length);
  return { pace, n: leads.length };
}

// 週ごとの件数の傾向（before の前の週から、さかのぼって weeks 週）。1週あたりの増減の割合を返す
function weeklyTrend(db, before, weeks) {
  const monday = addDays(before, -((weekday(before) + 6) % 7)); // before を含む週の月曜（この週は途中なので使わない）
  const totals = [];
  for (let w = weeks; w >= 1; w--) {
    const start = addDays(monday, -7 * w);
    let n = 0;
    for (let i = 0; i < 7; i++) n += dayCount(db, addDays(start, i));
    totals.push(n);
  }
  const t = trendOf(totals);
  if (t.direction !== 'up' && t.direction !== 'down') return { rate: 0, direction: t.direction };
  return { rate: t.mean ? t.slope / t.mean : 0, direction: t.direction };
}

// 1日分の見込み（method: 'mean' か 'pace'）
function estimate(db, date, asOf, opts, method) {
  const st = stats(history(db, date, opts.weeks, asOf));
  if (st.n < 3) return null;
  let base = st.mean;
  if (method === 'pace') {
    // 増減の傾向: その日が何週先かに応じて足し引きする（極端にならないよう ±50% までにおさえる）
    const ahead = diffDays(date, asOf) / 7 + 1;
    base *= Math.min(1.5, Math.max(0.5, 1 + opts.trend.rate * ahead));
    const lead = Math.min(MAX_LEAD, Math.max(0, diffDays(date, asOf)));
    const p = opts.pace ? opts.pace.pace[lead] : 0;
    const confirmed = opts.confirmed;
    if (p >= 0.2) base = p * (confirmed / p) + (1 - p) * base; // すでに入っている割合が大きいほど、ペースの見込みを重く見る
  }
  return { mean: st.mean, sd: st.sd, n: st.n, value: base };
}

function forecast(db, now = new Date(), opts = {}) {
  begin(db);
  try {
    return run(db, now, opts);
  } finally {
    memo = null;
  }
}

function run(db, now, { weeks = 8, horizon = 28 } = {}) {
  const today = nowJST(now).date;
  const cap = (db.settings.loadCap == null ? 80 : db.settings.loadCap) / 100;
  const past = db.bookings.filter((b) => ACTIVE.includes(b.status) && b.date < today && b.date >= addDays(today, -7 * weeks));
  const avgMinutes = past.length ? past.reduce((a, b) => a + (b.end - b.start), 0) / past.length : 60;

  // ---------- 当たり具合の比べ: 過去4週間の受付日を、面談日の 1・3・7日前の時点から予測し直す ----------
  const errors = { mean: [], pace: [] };
  for (let i = 1; i <= 28; i++) {
    const date = addDays(today, -i);
    if (!isOpen(db, date)) continue;
    const actual = dayCount(db, date);
    for (const L of [1, 3, 7]) {
      const asOf = addDays(date, -L);
      const opts = { weeks, pace: paceCurve(db, asOf, 16), trend: weeklyTrend(db, asOf, 8), confirmed: countAsOf(db, date, asOf) };
      const a = estimate(db, date, asOf, opts, 'mean');
      const b = estimate(db, date, asOf, opts, 'pace');
      if (!a || !b) continue;
      errors.mean.push(Math.abs(Math.max(a.value, opts.confirmed) - actual));
      errors.pace.push(Math.abs(Math.max(b.value, opts.confirmed) - actual));
    }
  }
  const mae = (list) => (list.length ? list.reduce((x, y) => x + y, 0) / list.length : null);
  const maeMean = mae(errors.mean);
  const maePace = mae(errors.pace);
  // 試した件数が少ないとき、または新しい方法のほうが当たらなかったときは、曜日の平均を使う
  const method = maePace != null && errors.pace.length >= 10 && maePace <= maeMean ? 'pace' : 'mean';

  // ---------- これからの見込み ----------
  const pace = paceCurve(db, today, 16);
  const trend = weeklyTrend(db, today, 8);
  const days = [];
  for (let i = 0; i < horizon; i++) {
    const date = addDays(today, i);
    const capacity = db.staff.reduce((a, s) => a + capacityMinutes(db, s, date), 0);
    if (!capacity) continue; // 受付のない日は見込みを出さない
    const confirmed = dayCount(db, date);
    const e = estimate(db, date, today, { weeks, pace, trend, confirmed }, method);
    if (!e) { days.push({ date, confirmed, capacity, enough: false }); continue; }
    // 幅: 実績のばらつきと、件数の数え方そのもののばらつき（√平均）の大きいほうを使う。
    // ペースで見込むときは、すでに入っている割合が大きいほど幅を狭くする
    const p = method === 'pace' && pace ? pace.pace[Math.min(MAX_LEAD, i)] : 0;
    const spread = Z80 * Math.max(e.sd, Math.sqrt(Math.max(e.value, 0.5))) * (1 - 0.7 * p);
    const expected = Math.max(e.value, confirmed); // すでに入っている予約より少ない見込みにはしない
    const load = (expected * avgMinutes) / capacity;
    days.push({
      date, confirmed, capacity, enough: true, samples: e.n,
      expected: Math.round(expected * 10) / 10,
      low: Math.max(confirmed, Math.floor(expected - spread)), high: Math.max(confirmed, Math.ceil(expected + spread)),
      load, level: load > cap ? 'busy' : load < 0.3 ? 'quiet' : 'normal',
    });
  }
  const accuracy = errors.mean.length ? { trials: errors.mean.length, mean: maeMean, pace: maePace, method } : null;
  return { today, weeks, avgMinutes, cap: Math.round(cap * 100), method, trend: trend.direction, paceSamples: pace ? pace.n : 0, days, accuracy };
}

module.exports = { forecast, paceCurve };
