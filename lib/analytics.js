'use strict';
// 予約データの集計と、決まったルールによる改善案の作成。
// AI は使わず、下の RULES のしきい値と比べて判定する。
// しきい値は「目安」として置いた初期値で、業界の公式基準ではない。運用に合わせて変えてよい。

const { AppError, ACTIVE, dayHours, recurringFor, toMin, toHM, addDays, weekday, diffDays, nowJST } = require('./core');

const RULES = {
  minSample: 20,          // これ未満の件数では「データ不足」と注意書きを出す
  cancelRate: 0.15,       // キャンセル率がこれ以上なら注意
  noshowRate: 0.05,       // 無断キャンセル率がこれ以上なら注意
  lowUtilization: 0.3,    // 全体の稼働率がこれ未満なら「枠を開けすぎ」
  weekdayLowRatio: 0.5,   // 全体の稼働率のこの割合に届かない曜日は「空きが多い」
  highUtilization: 0.8,   // 稼働率がこれ以上の曜日は「混みすぎ」
  peakHourShare: 0.25,    // 1つの時間帯に予約がこの割合以上集まったら「集中」
  shortLeadDays: 2,       // 平均リードタイムがこれ未満なら「直前予約が多い」
  longLeadDays: 10,       // 平均リードタイムがこれ以上なら「先まで埋まっている」
  leadCancelGap: 0.1,     // 早期予約と直前予約のキャンセル率の差
  staffImbalance: 2,      // 担当者間の稼働率の差（倍率）
  repeatRate: 0.2,        // リピート率がこれ未満なら注意
};
// 画面から目安を変更するときの、表示名・単位・入力できる範囲
const RULE_META = [
  { key: 'minSample', label: '分析に必要な最低件数', unit: '件', min: 1, max: 1000 },
  { key: 'cancelRate', label: 'キャンセル率の上限', unit: '%', min: 0, max: 1 },
  { key: 'noshowRate', label: '無断キャンセル率の上限', unit: '%', min: 0, max: 1 },
  { key: 'lowUtilization', label: '稼働率の下限（全体）', unit: '%', min: 0, max: 1 },
  { key: 'weekdayLowRatio', label: '「空きが多い曜日」とみなす割合（全体比）', unit: '%', min: 0, max: 1 },
  { key: 'highUtilization', label: '「混みすぎ」とみなす稼働率', unit: '%', min: 0, max: 1 },
  { key: 'peakHourShare', label: '「集中」とみなす1時間帯の割合', unit: '%', min: 0, max: 1 },
  { key: 'shortLeadDays', label: '「直前予約が多い」平均日数', unit: '日', min: 0, max: 365 },
  { key: 'longLeadDays', label: '「先まで埋まっている」平均日数', unit: '日', min: 0, max: 365 },
  { key: 'leadCancelGap', label: '早期予約と直前予約のキャンセル率の差', unit: '%', min: 0, max: 1 },
  { key: 'staffImbalance', label: '担当者間の偏り', unit: '倍', min: 1, max: 20 },
  { key: 'repeatRate', label: 'リピート率の下限', unit: '%', min: 0, max: 1 },
];
const rulesOf = (db) => Object.assign({}, RULES, db.settings.rules || {});

// 目安の数値を保存する。reset が true なら初期値に戻す
function updateRules(db, input) {
  if (input && input.reset) { delete db.settings.rules; return rulesOf(db); }
  const next = {};
  for (const m of RULE_META) {
    const v = Number((input || {})[m.key]);
    if (!Number.isFinite(v) || v < m.min || v > m.max) throw new AppError(`「${m.label}」の値が正しくありません。`);
    next[m.key] = v;
  }
  if (next.shortLeadDays >= next.longLeadDays) throw new AppError('「直前予約が多い」日数は、「先まで埋まっている」日数より小さくしてください。');
  db.settings.rules = next;
  return rulesOf(db);
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pct = (v) => Math.round(v * 100) + '%';
const rate = (a, b) => (b ? a / b : 0);

// 担当者がその日に予約を受けられる時間（分）。休憩・個別の予定・毎週の予定の分は引く
function capacityMinutes(db, staff, date) {
  const h = dayHours(db, staff, date);
  if (!h) return 0;
  const clip = (start, end) => Math.max(0, Math.min(end, h.close) - Math.max(start, h.open));
  let blocked = h.rest ? clip(h.rest[0], h.rest[1]) : 0;
  for (const k of db.blocks) if (k.staffId === staff.id && k.date === date) blocked += clip(k.start, k.end);
  for (const r of recurringFor(db, staff.id, date)) blocked += clip(r.start, r.end);
  return Math.max(0, h.close - h.open - blocked);
}

function analyze(db, from, to, now = new Date(), inner = false) {
  const R = rulesOf(db);
  const rows = db.bookings.filter((b) => b.date >= from && b.date <= to);
  const active = rows.filter((b) => ACTIVE.includes(b.status));
  const count = (s) => rows.filter((b) => b.status === s).length;
  const total = rows.length;
  const cancelled = count('cancelled');
  const noshow = count('noshow');
  const past = count('completed') + noshow; // 面談日を迎えた予約（キャンセルは除く）

  // 曜日別・担当者別の「受付可能時間」と「予約で埋まった時間」
  const byWeekday = WD.map((label) => ({ label, count: 0, capacity: 0, booked: 0 }));
  const byStaff = db.staff.map((s) => ({ id: s.id, label: s.name, count: 0, capacity: 0, booked: 0 }));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    db.staff.forEach((s, i) => {
      const c = capacityMinutes(db, s, d);
      byWeekday[weekday(d)].capacity += c;
      byStaff[i].capacity += c;
    });
  }
  const byHourMap = new Map();
  const byService = db.services.map((v) => ({ id: v.id, label: v.name, count: 0, cancelled: 0 }));
  for (const b of rows) {
    const sv = byService.find((v) => v.id === b.serviceId);
    if (sv) { sv.count++; if (b.status === 'cancelled') sv.cancelled++; }
  }
  for (const b of active) {
    const w = byWeekday[weekday(b.date)];
    w.count++; w.booked += b.end - b.start;
    const st = byStaff.find((s) => s.id === b.staffId);
    if (st) { st.count++; st.booked += b.end - b.start; }
    const hour = Math.floor(b.start / 60);
    byHourMap.set(hour, (byHourMap.get(hour) || 0) + 1);
  }
  const util = (x) => Object.assign(x, { utilization: rate(x.booked, x.capacity) });
  byWeekday.forEach(util);
  byStaff.forEach(util);
  const hours = [...byHourMap.keys()];
  const byHour = [];
  if (hours.length) {
    for (let h = Math.min(...hours); h <= Math.max(...hours); h++) {
      byHour.push({ hour: h, label: toHM(h * 60), count: byHourMap.get(h) || 0 });
    }
  }
  const capacity = byStaff.reduce((a, s) => a + s.capacity, 0);
  const booked = byStaff.reduce((a, s) => a + s.booked, 0);

  // リードタイム（申し込みから面談日までの日数）
  const withLead = rows.filter((b) => !b.leadUnknown)
    .map((b) => ({ b, lead: Math.max(0, diffDays(b.date, nowJST(new Date(b.createdAt)).date)) }));
  const avgLead = withLead.length ? withLead.reduce((a, x) => a + x.lead, 0) / withLead.length : null;
  const early = withLead.filter((x) => x.lead >= 7);
  const late = withLead.filter((x) => x.lead < 7);
  const cancelOf = (list) => rate(list.filter((x) => x.b.status === 'cancelled').length, list.length);

  // リピート率（同じメールアドレスで2回以上予約した人の割合）
  const perCustomer = new Map();
  for (const b of rows) {
    if (b.email) perCustomer.set(b.email.toLowerCase(), (perCustomer.get(b.email.toLowerCase()) || 0) + 1);
  }
  const customers = perCustomer.size;
  const repeaters = [...perCustomer.values()].filter((n) => n >= 2).length;

  const totals = {
    total, active: active.length, completed: count('completed'), upcoming: count('booked'), cancelled, noshow,
    cancelRate: rate(cancelled, total), noshowRate: rate(noshow, past),
    utilization: rate(booked, capacity), avgLeadDays: avgLead,
    customers, repeatRate: rate(repeaters, customers),
  };

  // ---------- ルールによる改善案 ----------
  const suggestions = [];
  const add = (level, title, evidence, action, impact) => suggestions.push({ level, title, evidence, action, impact: impact || null, gain: impact ? impact.gain : 0 });

  // 試算: 目安まで改善できたら、この期間で実施できた面談が何件増えたか
  const gainOf = (n, premise) => (Math.round(n) >= 1 ? { gain: Math.round(n), text: `試算: ${premise}、この期間で実施できた面談は約${Math.round(n)}件増えます。` } : null);
  if (total < R.minSample) {
    add('info', 'データがまだ少ないため、参考程度にご覧ください',
      `対象期間の予約は ${total}件です（目安: ${R.minSample}件以上）。`,
      '件数が少ないと、たまたまの偏りを傾向と見誤りやすくなります。期間を広げるか、過去の予約データをCSVで読み込んでください。');
  }
  if (total >= 5 && totals.cancelRate >= R.cancelRate) {
    add('warn', 'キャンセル率が高めです',
      `キャンセル率 ${pct(totals.cancelRate)}（${cancelled}件／${total}件）。目安は ${pct(R.cancelRate)} 未満です。`,
      '面談の前日にリマインド連絡を入れる、日程変更の方法を予約完了画面で案内する、の2点から始めるのがおすすめです。',
      gainOf(cancelled - total * R.cancelRate, 'キャンセル率を目安まで下げた場合'));
  }
  if (early.length >= 5 && late.length >= 5 && cancelOf(early) - cancelOf(late) >= R.leadCancelGap) {
    add('warn', '早く入った予約ほどキャンセルされやすい傾向があります',
      `7日以上前の予約のキャンセル率 ${pct(cancelOf(early))}、6日以内は ${pct(cancelOf(late))}。`,
      `受付期間（現在 ${db.settings.windowDays}日先まで）を短くする、または面談の3日前に確認連絡を入れると、空振りを減らせます。`);
  }
  if (past >= 5 && totals.noshowRate >= R.noshowRate) {
    add('warn', '無断キャンセルが目立ちます',
      `無断キャンセル率 ${pct(totals.noshowRate)}（${noshow}件／面談日を迎えた${past}件）。目安は ${pct(R.noshowRate)} 未満です。`,
      '前日と当日朝のリマインド、予約時の電話番号入力の必須化、事前アンケートの回答依頼などで、来談の意思を事前に確認してください。',
      gainOf(noshow - past * R.noshowRate, '無断キャンセル率を目安まで下げた場合'));
  }
  const openDays = byWeekday.filter((w) => w.capacity > 0);
  const low = openDays.filter((w) => w.utilization < totals.utilization * R.weekdayLowRatio);
  const high = openDays.filter((w) => w.utilization >= R.highUtilization);
  if (total >= 5 && low.length && low.length < openDays.length) {
    add('idea', `${low.map((w) => w.label + '曜').join('・')}は空き枠が多く残っています`,
      low.map((w) => `${w.label}曜の稼働率 ${pct(w.utilization)}`).join('、') + `（全体 ${pct(totals.utilization)}）。`,
      'この曜日の受付時間を短くして別の業務にあてるか、予約ページで「空きあり」と案内して予約を誘導してください。');
  }
  if (total >= R.minSample && totals.utilization < R.lowUtilization) {
    add('idea', '全体として、開けている枠に対して予約が少なめです',
      `稼働率 ${pct(totals.utilization)}（目安は ${pct(R.lowUtilization)} 以上）。`,
      '予約が入りにくい曜日・時間帯の受付を減らし、空いた時間を別の業務にあてることを検討してください。枠を減らしたくない場合は、予約ページへの導線（Webサイト・メール署名・SNSなど）を増やしてください。');
  }
  if (high.length) {
    add('warn', `${high.map((w) => w.label + '曜').join('・')}は枠がほぼ埋まっています`,
      high.map((w) => `${w.label}曜の稼働率 ${pct(w.utilization)}`).join('、') + '。',
      '予約を取りこぼしている可能性があります。この曜日の受付時間を延ばす、担当者を増やす、空いている曜日へ誘導する、のいずれかを検討してください。');
  }
  const peak = byHour.slice().sort((a, b) => b.count - a.count)[0];
  if (peak && active.length >= 10 && byHour.length >= 4 && peak.count / active.length >= R.peakHourShare) {
    add('idea', `${peak.label}台に予約が集中しています`,
      `${peak.label}台の予約が全体の ${pct(peak.count / active.length)}（${peak.count}件／${active.length}件）。`,
      'この時間帯は複数の担当者が受けられるようにし、会議などの予定は別の時間に動かすと、受けられる件数が増えます。');
  }
  const quiet = byHour.filter((h) => h.count === 0);
  if (quiet.length && active.length >= R.minSample) {
    add('idea', '予約が1件も入っていない時間帯があります',
      `${quiet.map((h) => h.label + '台').join('、')} は対象期間の予約が0件です。`,
      'この時間帯の受付をやめて、事務作業や準備の時間として確保することを検討してください。');
  }
  if (avgLead != null && withLead.length >= 5) {
    if (avgLead < R.shortLeadDays) {
      add('idea', '直前の予約が多い傾向です',
        `申し込みから面談日までの平均は ${avgLead.toFixed(1)}日です。`,
        '当日・翌日の枠を必ず空けておくと取りこぼしを防げます。直前すぎる予約が負担なら、受付締切（現在 ' + db.settings.minLeadMinutes + '分前）を長くしてください。');
    } else if (avgLead >= R.longLeadDays) {
      add('idea', '予約が先の日程に流れています',
        `申し込みから面談日までの平均は ${avgLead.toFixed(1)}日です。`,
        '近い日程の枠が足りていない可能性があります。受付時間や担当者を増やせないか確認してください。');
    }
  }
  const worked = byStaff.filter((s) => s.capacity > 0);
  if (worked.length >= 2 && active.length >= 10) {
    const sorted = worked.slice().sort((a, b) => b.utilization - a.utilization);
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];
    if (top.utilization > 0 && top.utilization >= Math.max(bottom.utilization, 0.01) * R.staffImbalance) {
      add('idea', '担当者によって予約の入り方に偏りがあります',
        `${top.label} ${pct(top.utilization)}（${top.count}件）に対し、${bottom.label} ${pct(bottom.utilization)}（${bottom.count}件）。`,
        '予約ページで「指名なし」を初期選択にすると、空いている担当者へ自動で割り振られます。対応できるメニューの差が原因なら、引き継ぎや研修も有効です。');
    }
  }
  if (customers >= 10 && totals.repeatRate < R.repeatRate) {
    add('idea', '2回目の予約につながっている人が少なめです',
      `リピート率 ${pct(totals.repeatRate)}（${repeaters}人／${customers}人）。目安は ${pct(R.repeatRate)} 以上です。`,
      '面談の最後に次回の日程をその場で決める、終了後にお礼と次回予約の案内を送る、といった流れを作ってください。');
  }
  const worstService = byService.filter((v) => v.count >= 5)
    .map((v) => Object.assign({ r: rate(v.cancelled, v.count) }, v)).sort((a, b) => b.r - a.r)[0];
  if (worstService && byService.filter((v) => v.count >= 5).length >= 2 && worstService.r >= totals.cancelRate + 0.1) {
    add('idea', `「${worstService.label}」のキャンセルが他より多くなっています`,
      `このメニューのキャンセル率 ${pct(worstService.r)}（全体 ${pct(totals.cancelRate)}）。`,
      '内容や所要時間の説明が伝わっているか、予約ページの案内文を見直してください。');
  }
  if (total >= R.minSample && !suggestions.some((s) => s.level !== 'info')) {
    add('good', '大きな問題は見つかりませんでした',
      `キャンセル率 ${pct(totals.cancelRate)}、稼働率 ${pct(totals.utilization)}。`,
      'いまの運用を続けながら、月に一度この画面で変化を確認してください。');
  }

  // 優先順位: 要対応 → 提案 → 注意 の順。同じ区分の中では、試算の件数が大きいものを先に出す
  const order = { warn: 0, idea: 1, info: 2, good: 3 };
  suggestions.sort((x, y) => order[x.level] - order[y.level] || y.gain - x.gain);
  suggestions.forEach((x, i) => { x.priority = i + 1; delete x.gain; });

  const result = { period: { from, to }, totals, byWeekday, byHour, byService, byStaff, suggestions };
  if (inner) return result;

  // 同じ長さの「ひとつ前の期間」と比べる
  const span = diffDays(to, from) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  const prev = analyze(db, prevFrom, prevTo, now, true);
  result.previous = { period: prev.period, totals: prev.totals };

  // 推移: 180日までは週ごと、それより長ければ月ごと
  const monthly = span > 180;
  const bucketOf = (d) => (monthly ? d.slice(0, 7) : addDays(d, -((weekday(d) + 6) % 7)));
  const buckets = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const k = bucketOf(d);
    if (!buckets.has(k)) {
      buckets.set(k, { key: k, label: monthly ? `${Number(k.slice(5, 7))}月` : `${Number(k.slice(5, 7))}/${Number(k.slice(8))}`, active: 0, cancelled: 0 });
    }
  }
  for (const b of rows) buckets.get(bucketOf(b.date))[b.status === 'cancelled' ? 'cancelled' : 'active']++;
  result.trend = { unit: monthly ? '月' : '週', buckets: [...buckets.values()] };
  result.rules = R;
  result.ruleMeta = RULE_META;
  result.ruleDefaults = RULES;
  return result;
}

module.exports = { analyze, updateRules, RULES, RULE_META, capacityMinutes };
