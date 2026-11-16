'use strict';
// 予約データの集計と、決まったルールによる改善案の作成。
// AI は使わず、下の RULES のしきい値と比べて判定する。
// しきい値は「目安」として置いた初期値で、業界の公式基準ではない。運用に合わせて変えてよい。

const { ACTIVE, toMin, toHM, addDays, weekday, diffDays, nowJST } = require('./core');

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
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pct = (v) => Math.round(v * 100) + '%';
const rate = (a, b) => (b ? a / b : 0);

// 担当者がその日に予約を受けられる時間（分）。個別の予定が入っている分は引く
function capacityMinutes(db, staff, date) {
  const h = staff.hours[weekday(date)];
  if (!h) return 0;
  const open = toMin(h.start);
  const close = toMin(h.end);
  let blocked = 0;
  for (const k of db.blocks) {
    if (k.staffId === staff.id && k.date === date) {
      blocked += Math.max(0, Math.min(k.end, close) - Math.max(k.start, open));
    }
  }
  return Math.max(0, close - open - blocked);
}

function analyze(db, from, to, now = new Date()) {
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
  const add = (level, title, evidence, action) => suggestions.push({ level, title, evidence, action });

  if (total < RULES.minSample) {
    add('info', 'データがまだ少ないため、参考程度にご覧ください',
      `対象期間の予約は ${total}件です（目安: ${RULES.minSample}件以上）。`,
      '件数が少ないと、たまたまの偏りを傾向と見誤りやすくなります。期間を広げるか、過去の予約データをCSVで読み込んでください。');
  }
  if (total >= 5 && totals.cancelRate >= RULES.cancelRate) {
    add('warn', 'キャンセル率が高めです',
      `キャンセル率 ${pct(totals.cancelRate)}（${cancelled}件／${total}件）。目安は ${pct(RULES.cancelRate)} 未満です。`,
      '面談の前日にリマインド連絡を入れる、日程変更の方法を予約完了画面で案内する、の2点から始めるのがおすすめです。');
  }
  if (early.length >= 5 && late.length >= 5 && cancelOf(early) - cancelOf(late) >= RULES.leadCancelGap) {
    add('warn', '早く入った予約ほどキャンセルされやすい傾向があります',
      `7日以上前の予約のキャンセル率 ${pct(cancelOf(early))}、6日以内は ${pct(cancelOf(late))}。`,
      `受付期間（現在 ${db.settings.windowDays}日先まで）を短くする、または面談の3日前に確認連絡を入れると、空振りを減らせます。`);
  }
  if (past >= 5 && totals.noshowRate >= RULES.noshowRate) {
    add('warn', '無断キャンセルが目立ちます',
      `無断キャンセル率 ${pct(totals.noshowRate)}（${noshow}件／面談日を迎えた${past}件）。目安は ${pct(RULES.noshowRate)} 未満です。`,
      '前日と当日朝のリマインド、予約時の電話番号入力の必須化、事前アンケートの回答依頼などで、来談の意思を事前に確認してください。');
  }
  const openDays = byWeekday.filter((w) => w.capacity > 0);
  const low = openDays.filter((w) => w.utilization < totals.utilization * RULES.weekdayLowRatio);
  const high = openDays.filter((w) => w.utilization >= RULES.highUtilization);
  if (total >= 5 && low.length && low.length < openDays.length) {
    add('idea', `${low.map((w) => w.label + '曜').join('・')}は空き枠が多く残っています`,
      low.map((w) => `${w.label}曜の稼働率 ${pct(w.utilization)}`).join('、') + `（全体 ${pct(totals.utilization)}）。`,
      'この曜日の受付時間を短くして別の業務にあてるか、予約ページで「空きあり」と案内して予約を誘導してください。');
  }
  if (total >= RULES.minSample && totals.utilization < RULES.lowUtilization) {
    add('idea', '全体として、開けている枠に対して予約が少なめです',
      `稼働率 ${pct(totals.utilization)}（目安は ${pct(RULES.lowUtilization)} 以上）。`,
      '予約が入りにくい曜日・時間帯の受付を減らし、空いた時間を別の業務にあてることを検討してください。枠を減らしたくない場合は、予約ページへの導線（Webサイト・メール署名・SNSなど）を増やしてください。');
  }
  if (high.length) {
    add('warn', `${high.map((w) => w.label + '曜').join('・')}は枠がほぼ埋まっています`,
      high.map((w) => `${w.label}曜の稼働率 ${pct(w.utilization)}`).join('、') + '。',
      '予約を取りこぼしている可能性があります。この曜日の受付時間を延ばす、担当者を増やす、空いている曜日へ誘導する、のいずれかを検討してください。');
  }
  const peak = byHour.slice().sort((a, b) => b.count - a.count)[0];
  if (peak && active.length >= 10 && byHour.length >= 4 && peak.count / active.length >= RULES.peakHourShare) {
    add('idea', `${peak.label}台に予約が集中しています`,
      `${peak.label}台の予約が全体の ${pct(peak.count / active.length)}（${peak.count}件／${active.length}件）。`,
      'この時間帯は複数の担当者が受けられるようにし、会議などの予定は別の時間に動かすと、受けられる件数が増えます。');
  }
  const quiet = byHour.filter((h) => h.count === 0);
  if (quiet.length && active.length >= RULES.minSample) {
    add('idea', '予約が1件も入っていない時間帯があります',
      `${quiet.map((h) => h.label + '台').join('、')} は対象期間の予約が0件です。`,
      'この時間帯の受付をやめて、事務作業や準備の時間として確保することを検討してください。');
  }
  if (avgLead != null && withLead.length >= 5) {
    if (avgLead < RULES.shortLeadDays) {
      add('idea', '直前の予約が多い傾向です',
        `申し込みから面談日までの平均は ${avgLead.toFixed(1)}日です。`,
        '当日・翌日の枠を必ず空けておくと取りこぼしを防げます。直前すぎる予約が負担なら、受付締切（現在 ' + db.settings.minLeadMinutes + '分前）を長くしてください。');
    } else if (avgLead >= RULES.longLeadDays) {
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
    if (top.utilization > 0 && top.utilization >= Math.max(bottom.utilization, 0.01) * RULES.staffImbalance) {
      add('idea', '担当者によって予約の入り方に偏りがあります',
        `${top.label} ${pct(top.utilization)}（${top.count}件）に対し、${bottom.label} ${pct(bottom.utilization)}（${bottom.count}件）。`,
        '予約ページで「指名なし」を初期選択にすると、空いている担当者へ自動で割り振られます。対応できるメニューの差が原因なら、引き継ぎや研修も有効です。');
    }
  }
  if (customers >= 10 && totals.repeatRate < RULES.repeatRate) {
    add('idea', '2回目の予約につながっている人が少なめです',
      `リピート率 ${pct(totals.repeatRate)}（${repeaters}人／${customers}人）。目安は ${pct(RULES.repeatRate)} 以上です。`,
      '面談の最後に次回の日程をその場で決める、終了後にお礼と次回予約の案内を送る、といった流れを作ってください。');
  }
  const worstService = byService.filter((v) => v.count >= 5)
    .map((v) => Object.assign({ r: rate(v.cancelled, v.count) }, v)).sort((a, b) => b.r - a.r)[0];
  if (worstService && byService.filter((v) => v.count >= 5).length >= 2 && worstService.r >= totals.cancelRate + 0.1) {
    add('idea', `「${worstService.label}」のキャンセルが他より多くなっています`,
      `このメニューのキャンセル率 ${pct(worstService.r)}（全体 ${pct(totals.cancelRate)}）。`,
      '内容や所要時間の説明が伝わっているか、予約ページの案内文を見直してください。');
  }
  if (total >= RULES.minSample && !suggestions.some((s) => s.level !== 'info')) {
    add('good', '大きな問題は見つかりませんでした',
      `キャンセル率 ${pct(totals.cancelRate)}、稼働率 ${pct(totals.utilization)}。`,
      'いまの運用を続けながら、月に一度この画面で変化を確認してください。');
  }

  return { period: { from, to }, totals, byWeekday, byHour, byService, byStaff, suggestions, rules: RULES };
}

module.exports = { analyze, RULES, capacityMinutes };
