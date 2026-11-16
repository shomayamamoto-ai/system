'use strict';
// 日本の祝日を計算する（「国民の祝日に関する法律」のルールにもとづく）。
// 対象は2020年〜2099年。春分の日・秋分の日は天文計算の近似式による予測で、
// 正式な日付は前年2月に国（国立天文台）が発表する。ずれた場合は休業日を手で直す。

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const weekdayOf = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// その月の第n月曜日
function nthMonday(y, m, n) {
  const first = weekdayOf(ymd(y, m, 1));
  return ymd(y, m, 1 + ((8 - first) % 7) + (n - 1) * 7);
}

function holidays(year) {
  if (!Number.isInteger(year) || year < 2020 || year > 2099) return [];
  const spring = Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  const autumn = Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  const list = [
    [ymd(year, 1, 1), '元日'],
    [nthMonday(year, 1, 2), '成人の日'],
    [ymd(year, 2, 11), '建国記念の日'],
    [ymd(year, 2, 23), '天皇誕生日'],
    [ymd(year, 3, spring), '春分の日'],
    [ymd(year, 4, 29), '昭和の日'],
    [ymd(year, 5, 3), '憲法記念日'],
    [ymd(year, 5, 4), 'みどりの日'],
    [ymd(year, 5, 5), 'こどもの日'],
    [nthMonday(year, 7, 3), '海の日'],
    [ymd(year, 8, 11), '山の日'],
    [nthMonday(year, 9, 3), '敬老の日'],
    [ymd(year, 9, autumn), '秋分の日'],
    [nthMonday(year, 10, 2), 'スポーツの日'],
    [ymd(year, 11, 3), '文化の日'],
    [ymd(year, 11, 23), '勤労感謝の日'],
  ];
  // 2020年・2021年は東京オリンピックのための特例で、3つの祝日が移動した
  const special = {
    2020: { '海の日': '2020-07-23', 'スポーツの日': '2020-07-24', '山の日': '2020-08-10' },
    2021: { '海の日': '2021-07-22', 'スポーツの日': '2021-07-23', '山の日': '2021-08-08' },
  }[year];
  if (special) for (const h of list) if (special[h[1]]) h[0] = special[h[1]];

  const map = new Map(list.map(([date, title]) => [date, title]));
  // 国民の休日: 前日と翌日がどちらも祝日の平日
  for (const [date] of list) {
    const mid = addDays(date, 1);
    if (!map.has(mid) && map.has(addDays(date, 2)) && weekdayOf(mid) !== 0) map.set(mid, '国民の休日');
  }
  // 振替休日: 祝日が日曜なら、そのあとの最初の「祝日でない日」が休みになる
  for (const [date] of [...map]) {
    if (weekdayOf(date) !== 0) continue;
    let d = addDays(date, 1);
    while (map.has(d)) d = addDays(d, 1);
    map.set(d, '振替休日');
  }
  return [...map].map(([date, title]) => ({ date, title })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

module.exports = { holidays };
