'use strict';
// 分析で使う統計の小道具。
// 「件数が少ないときの、たまたまの偏り」を傾向と見誤らないために使う。

// 割合の「確からしい範囲」（ウィルソンの信頼区間・95%）。
// 例: 10件中3件（30%）なら、本当の割合はおよそ 11%〜60% のどこか、という幅を返す。
function wilson(hits, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const mid = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (mid - half) / d), Math.min(1, (mid + half) / d)];
}

// 2つの割合の差が「偶然とは言いにくい」かどうか（2標本の比率の検定・有意水準5%）
function ratesDiffer(hitsA, nA, hitsB, nB) {
  if (!nA || !nB) return false;
  const p = (hitsA + hitsB) / (nA + nB);
  const se = Math.sqrt(p * (1 - p) * (1 / nA + 1 / nB));
  if (!se) return false;
  return Math.abs(hitsA / nA - hitsB / nB) / se >= 1.96;
}

// t分布の境目（両側5%）。自由度が小さいほど、偶然でも大きな値が出やすいので境目が高い
function tCritical(df) {
  const table = [[1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306],
    [9, 2.262], [10, 2.228], [12, 2.179], [15, 2.131], [20, 2.086], [30, 2.042], [60, 2.0]];
  for (const [d, t] of table) if (df <= d) return t;
  return 1.96;
}

// 数字の並びが、増えているか・減っているか（直線の当てはめ）。
// 傾きが偶然とは言いにくいときだけ up / down を返し、それ以外は flat を返す。
function trendOf(values) {
  const n = values.length;
  if (n < 6) return { direction: 'unknown', slope: 0, n };
  const mx = (n - 1) / 2;
  const my = values.reduce((a, v) => a + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  values.forEach((v, i) => { sxx += (i - mx) ** 2; sxy += (i - mx) * (v - my); });
  const slope = sxy / sxx;
  const sse = values.reduce((a, v, i) => a + (v - (my + slope * (i - mx))) ** 2, 0);
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const sure = se === 0 ? slope !== 0 : Math.abs(slope / se) >= tCritical(n - 2);
  return { direction: sure ? (slope > 0 ? 'up' : 'down') : 'flat', slope, mean: my, n };
}

// 待ち行列理論（M/M/1 モデル）による、待ち時間の目安。
// 稼働率 ρ のとき、平均の待ち時間は「1件あたりの所要時間 × ρ ÷ (1 − ρ)」になる。
// 例: 1時間に60人さばけるレジに48人（ρ=0.8）なら 1分×4＝約4分、54人（0.9）なら約9分、57人（0.95）なら約19分。
// 予約の運用では「1件が長引いたとき、後ろの予定へ広がる遅れの大きさ」の目安として使う。
// 実際の予約は時間が決まっているため、この式どおりにはならない（あくまで傾向をつかむための目安）。
function queueFactor(rho) {
  if (!(rho >= 0)) return 0;
  if (rho >= 1) return Infinity;
  return rho / (1 - rho);
}

module.exports = { wilson, ratesDiffer, tCritical, trendOf, queueFactor };
