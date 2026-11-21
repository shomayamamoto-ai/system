'use strict';
// 管理画面（カレンダー・予約一覧・顧客・通知・分析・データ・設定・操作履歴）
const $ = (id) => document.getElementById(id);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS = { booked: '予約済', completed: '完了', noshow: '無断キャンセル', cancelled: 'キャンセル' };
const ROLE = { owner: '管理者', staff: '担当者' };
const state = { config: null, cursor: null, view: 'week', staffFilter: '', seenNotes: null, tab: 'calendar', timer: null };

const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const wd = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const jp = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}（${WD[wd(s)]}）`;
const jpFull = (s) => `${s.slice(0, 4)}/${jp(s)}`;
const pct = (v) => Math.round(v * 100) + '%';
const mondayOf = (date) => addDays(date, -((wd(date) + 6) % 7));
const shiftMonth = (date, n) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 10);
const staffName = (id) => (state.config.staff.find((s) => s.id === id) || { name: '（削除済み）' }).name;
const serviceName = (id) => (state.config.services.find((s) => s.id === id) || { name: '（削除済み）' }).name;
const isOwner = () => state.config.user.role === 'owner';
function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  node.append(...children.filter((c) => c != null));
  return node;
}
function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
const when = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function call(path, method, body) {
  const res = await fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。'); }
  if (!res.ok) throw new Error(data.error || '通信に失敗しました。');
  return data;
}
function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}
const guard = (fn) => async (...args) => {
  try { showError(''); await fn(...args); } catch (e) { showError(e.message); }
};
// warn: 見落としてほしくない警告。長めに表示し、ふつうのお知らせより先には消さない
function toast(text, warn) {
  const t = el('div', { className: 'toast' + (warn ? ' warn' : ''), textContent: text });
  t.setAttribute('role', warn ? 'alert' : 'status');
  $('toasts').append(t);
  while ($('toasts').children.length > 2) { // 画面をふさがないよう2件まで
    const plain = [...$('toasts').children].find((x) => !x.classList.contains('warn') && x !== t);
    (plain || $('toasts').firstChild).remove();
  }
  setTimeout(() => t.remove(), warn ? 15000 : 6000);
}
const empty = (text) => el('div', { className: 'empty', textContent: text });
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
// ダイアログの外側（暗い部分）を押しても閉じられるようにする
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }));

// ---------- ログイン ----------
function showLogin() {
  clearInterval(state.timer);
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('app').hidden = true;
  $('login').hidden = false;
  $('loginForm').loginId.focus();
}
$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('loginError').hidden = true;
  try {
    await call('/api/admin/login', 'POST', { loginId: ev.target.loginId.value.trim(), password: ev.target.password.value });
    ev.target.reset();
    state.tab = 'calendar';
    await start();
  } catch (e) {
    $('loginError').textContent = e.message;
    $('loginError').hidden = false;
  }
});
// 自分のアカウント（パスワード変更・ログアウト）
$('me').addEventListener('click', () => {
  const u = state.config.user;
  $('meName').textContent = `${u.name}（${ROLE[u.role]}）`;
  $('pwForm').hidden = u.builtin;
  $('pwBuiltin').hidden = !u.builtin;
  $('pwForm').reset();
  $('pwError').hidden = true;
  $('meDialog').showModal();
});
$('pwForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await call('/api/admin/me/password', 'PUT', { current: ev.target.current.value, next: ev.target.next.value });
    $('meDialog').close();
    toast('パスワードを変更しました。');
  } catch (e) {
    $('pwError').textContent = e.message;
    $('pwError').hidden = false;
  }
});
$('logout').addEventListener('click', async () => {
  await call('/api/admin/logout', 'POST').catch(() => {});
  showLogin();
});

// ---------- メニュー（PCは上、スマホは下に固定） ----------
const TABS = [
  { id: 'calendar', label: 'カレンダー', d: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
  { id: 'list', label: '予約一覧', d: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' },
  { id: 'notes', label: '通知', d: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0' },
  { id: 'analytics', label: '分析', d: 'M5 20V11M12 20V4M19 20v-6M3 20h18' },
  { id: 'customers', label: '顧客', extra: true, d: 'M5 20v-1a7 7 0 0 1 14 0v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8' },
  { id: 'import', label: 'データ', extra: true, owner: true, d: 'M12 4v11M7 10l5 5 5-5M4 20h16' },
  { id: 'settings', label: '設定', extra: true, owner: true, d: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4' },
  { id: 'audit', label: '操作履歴', extra: true, owner: true, d: 'M12 7v5l3 2M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4 4v4h4' },
];
const loaders = { calendar: loadCalendar, list: loadList, customers: loadCustomers, notes: () => loadNotes(false), analytics: loadAnalytics, import: () => {}, settings: loadSettings, audit: loadAudit };
function buildNav() {
  const tabs = TABS.filter((t) => !t.owner || isOwner());
  const button = (t) => {
    const b = el('button', { className: t.extra ? 'extra' : '' }, icon(t.d), el('span', { textContent: t.label }));
    b.dataset.tab = t.id;
    if (t.id === 'notes') b.append(el('span', { id: 'unread', className: 'badge', hidden: true }));
    b.addEventListener('click', () => { $('moreSheet').close(); openTab(t.id); });
    return b;
  };
  const more = el('button', { className: 'more' }, icon('M5 12h.01M12 12h.01M19 12h.01'), el('span', { textContent: 'その他' }));
  more.dataset.tab = 'more';
  more.addEventListener('click', () => $('moreSheet').showModal());
  $('tabs').replaceChildren(...tabs.map(button), more);
  $('moreList').replaceChildren(...tabs.filter((t) => t.extra).map(button));
}
function openTab(name) {
  if (!loaders[name] || (TABS.find((t) => t.id === name).owner && !isOwner())) name = 'calendar';
  state.tab = name;
  const extra = TABS.find((t) => t.id === name).extra;
  document.querySelectorAll('#tabs button').forEach((b) => {
    const on = b.dataset.tab === name || Boolean(b.dataset.tab === 'more' && extra);
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  Object.keys(loaders).forEach((t) => { $('tab-' + t).hidden = t !== name; });
  window.scrollTo({ top: 0 });
  guard(loaders[name])();
}
const refresh = () => loaders[state.tab]();

// ---------- カレンダー ----------
async function loadCalendar() {
  const month = state.view === 'month';
  $('week').hidden = $('strip').hidden = $('weekFoot').hidden = month;
  $('month').hidden = !month;
  $('viewWeek').classList.toggle('on', !month);
  $('viewMonth').classList.toggle('on', month);
  return month ? loadMonth() : loadWeek();
}
const visible = (x) => !state.staffFilter || x.staffId === state.staffFilter;
let weekData = null;
async function loadWeek() {
  const from = mondayOf(state.cursor);
  const to = addDays(from, 6);
  $('calRange').textContent = `${jp(from)}〜${jp(to)}`;
  const data = await call(`/api/admin/calendar?from=${from}&to=${to}`);
  if (from !== mondayOf(state.cursor)) return; // 待っている間に別の週へ移っていたら、この応答は捨てる
  weekData = data;
  drawWeek();
}
// 同じ時間に重なる予定を、横に並べるための列（レーン）を割り振る
function layout(items) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const list = items.map((x) => ({ x, s: toMin(x.start), e: Math.max(toMin(x.end), toMin(x.start) + 15) })).sort((p, q) => p.s - q.s || q.e - p.e);
  let group = [];
  let groupEnd = -1;
  const close = () => { const n = Math.max(...group.map((g) => g.lane)) + 1; group.forEach((g) => { g.lanes = n; }); group = []; };
  for (const it of list) {
    if (group.length && it.s >= groupEnd) close();
    const used = new Set(group.filter((g) => g.e > it.s).map((g) => g.lane));
    it.lane = 0;
    while (used.has(it.lane)) it.lane++;
    group.push(it);
    groupEnd = Math.max(groupEnd, it.e);
  }
  if (group.length) close();
  return list;
}
// 表示中の担当者（絞り込み中ならその人、なければ全員）の、その日の稼働率。
// 全員表示のときも、1人でも「8割」を超えた担当者がいれば印を付ける（平均にすると埋もれてしまうため）
function loadOf(d) {
  const per = (weekData.loads || {})[d] || {};
  const limit = Math.min(weekData.loadCap || 80, 80) / 100 + 1e-9; // 設定の上限が8割より低ければ、その値
  let booked = 0;
  let capacity = 0;
  let worst = null;
  for (const [id, l] of Object.entries(per)) {
    if (state.staffFilter && id !== state.staffFilter) continue;
    booked += l.booked;
    capacity += l.capacity;
    const r = l.capacity ? l.booked / l.capacity : (l.booked ? 1 : 0);
    if (!worst || r > worst.rate) worst = { id, rate: r };
  }
  if (!capacity) return null;
  const rate = booked / capacity;
  const over = Boolean(worst && worst.rate > limit);
  const detail = Object.entries(per).filter(([id]) => !state.staffFilter || id === state.staffFilter)
    .map(([id, l]) => `${staffName(id)} ${l.capacity ? Math.round((l.booked / l.capacity) * 100) : 0}%`).join('／');
  return { booked, capacity, pct: Math.round(rate * 100), over, detail,
    text: over && !state.staffFilter && Object.keys(per).length > 1 ? `${staffName(worst.id)} ${Math.round(worst.rate * 100)}%` : `稼働 ${Math.round(rate * 100)}%` };
}
function drawWeek() {
  const from = mondayOf(state.cursor);
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const showCancelled = $('showCancelled').checked;
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const items = []
      .concat(weekData.bookings.filter((b) => b.date === d && (showCancelled || b.status !== 'cancelled')).map((b) => ({ kind: 'booking', ...b })))
      .concat(weekData.blocks.filter((k) => k.date === d).map((k) => ({ kind: 'block', ...k })))
      .filter(visible);
    week.push({ d, items, closed: weekData.closedDays.find((c) => c.date === d), active: items.filter((x) => x.kind === 'booking' && x.status !== 'cancelled').length });
  }
  // 表示する時間帯: 受付時間と、その週の予約・予定がすべて入る範囲
  const staff = state.config.staff.filter((s) => !state.staffFilter || s.id === state.staffFilter);
  const dayHoursOf = (d) => staff.map((x) => ((weekData.loads || {})[d] || {})[x.id]).filter((l) => l && l.open != null);
  const opens = week.flatMap((w) => dayHoursOf(w.d).map((l) => l.open));
  const closes = week.flatMap((w) => dayHoursOf(w.d).map((l) => l.close));
  const all = week.flatMap((w) => w.items);
  const first = Math.floor(Math.min(9 * 60, ...opens, ...all.map((x) => toMin(x.start))) / 60);
  const last = Math.ceil(Math.max(18 * 60, ...closes, ...all.map((x) => toMin(x.end))) / 60);
  const hh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hh')) || 52;
  const y = (min) => ((min - first * 60) / 60) * hh;
  const height = (last - first) * hh;

  const labels = el('div', { className: 'tlabels', style: `height:${height}px` });
  for (let h = first; h < last; h++) labels.append(el('span', { style: `top:${y(h * 60)}px`, textContent: `${h}:00` }));
  const head = [el('div')];
  const cols = [labels];
  const strip = [];
  const jst = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  for (const w of week) {
    const { d } = w;
    const isToday = d === state.config.today;
    const ld = loadOf(d);
    head.push(el('div', { className: isToday ? 'today' : '' }, `${WD[wd(d)]}`, el('span', { className: 'd', textContent: String(Number(d.slice(8))) }),
      w.closed ? el('span', { className: 'tag', textContent: w.closed.title }) : null,
      dayHoursOf(d).some((l) => l.override) || staff.some((x) => (((weekData.loads || {})[d] || {})[x.id] || {}).override) ? el('span', { className: 'tag', textContent: '時間変更あり' }) : null,
      !w.closed && ld ? el('span', { className: 'load' + (ld.over ? ' over' : ''), title: `稼働率（予約で埋まった時間の割合）: ${ld.detail}`, textContent: ld.text }) : null));
    const col = el('div', { className: 'tcol' + (w.closed ? ' closed' : '') + (d === state.cursor ? ' sel' : ''), style: `height:${height}px` });
    // 受付時間の外をうすく塗る（全員が休みの時間帯）
    if (!w.closed) {
      const hs = dayHoursOf(d);
      const open = hs.length ? Math.min(...hs.map((h) => h.open)) : last * 60;
      const shut = hs.length ? Math.max(...hs.map((h) => h.close)) : last * 60;
      if (open > first * 60) col.append(el('div', { className: 'off', style: `top:0;height:${y(Math.min(open, last * 60))}px` }));
      if (hs.length && shut < last * 60) col.append(el('div', { className: 'off', style: `top:${y(shut)}px;bottom:0` }));
    }
    for (const it of layout(w.items)) {
      const x = it.x;
      const isBooking = x.kind === 'booking';
      const btn = el('button', { className: 'ev ' + (isBooking ? x.status : 'block') + (it.e - it.s <= 30 ? ' short' : ''),
        style: `top:${y(it.s)}px;height:${Math.max(22, ((it.e - it.s) / 60) * hh - 1)}px;left:calc(${(it.lane / it.lanes) * 100}% + 2px);width:calc(${100 / it.lanes}% - 4px)` },
        el('b', { textContent: `${isBooking && x.risk && x.risk.level === 'high' ? '⚠ ' : ''}${x.start} ${isBooking ? x.customerName : (x.recurring ? '毎週・' : '') + x.title}` }),
        el('span', { textContent: `${isBooking ? serviceName(x.serviceId) + '／' : ''}${staffName(x.staffId)}` }));
      btn.title = `${x.start}〜${x.end} ${isBooking ? x.customerName + ' 様／' + STATUS[x.status] : x.title}／${staffName(x.staffId)}`;
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); (isBooking ? openBooking(x) : openBlock(x)); });
      col.append(btn);
    }
    if (isToday) {
      const now = toMin(jst);
      if (now > first * 60 && now < last * 60) col.append(el('div', { className: 'nowline', style: `top:${y(now)}px` }));
    }
    // 空いている場所を押すと、その時刻（30分きざみ）で予約を追加する
    if (!w.closed) {
      col.addEventListener('click', (ev) => {
        if (ev.target !== col) return;
        const min = first * 60 + Math.floor(((ev.offsetY / hh) * 60) / 30) * 30;
        openBookingForm(null, { date: d, start: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}` });
      });
    }
    cols.push(col);
    // スマホ用: 日付を選ぶボタン
    const sb = el('button', { className: isToday ? 'today' : '' }, el('small', { textContent: WD[wd(d)] }),
      el('span', { className: 'd', textContent: String(Number(d.slice(8))) }), el('span', { className: 'cnt' + (loadOf(d) && loadOf(d).over ? ' over' : ''), textContent: w.closed ? '休' : w.active ? `${w.active}件` : '' }));
    sb.setAttribute('aria-pressed', String(d === state.cursor));
    sb.setAttribute('aria-label', `${jp(d)} 予約${w.active}件`);
    sb.addEventListener('click', () => { state.cursor = d; drawWeek(); focusDay(); });
    strip.push(sb);
  }
  $('weekHead').replaceChildren(...head);
  $('weekBody').replaceChildren(...cols);
  $('strip').replaceChildren(...strip);
}
$('showCancelled').addEventListener('change', () => { if (weekData) drawWeek(); });
// スマホでは1日ぶんが縦に長いので、選んだ日の最初の予定（なければ現在時刻）が見える位置まで動かす
function focusDay() {
  if (!window.matchMedia('(max-width: 760px)').matches) return;
  const col = document.querySelector('#weekBody .tcol.sel');
  const target = col && (col.querySelector('.ev') || col.querySelector('.nowline'));
  if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
async function loadMonth() {
  const first = state.cursor.slice(0, 8) + '01';
  const last = addDays(shiftMonth(first, 1), -1);
  const from = mondayOf(first);
  const to = addDays(mondayOf(last), 6);
  $('calRange').textContent = `${Number(first.slice(0, 4))}年${Number(first.slice(5, 7))}月`;
  const data = await call(`/api/admin/calendar?from=${from}&to=${to}`);
  const cells = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const bookings = data.bookings.filter((b) => b.date === d && b.status !== 'cancelled' && visible(b)).length;
    const blocks = data.blocks.filter((k) => k.date === d && visible(k)).length;
    const closed = data.closedDays.some((c) => c.date === d);
    const btn = el('button', { className: (d === state.config.today ? 'today ' : '') + (d < first || d > last ? 'other' : '') },
      el('span', { className: 'num', textContent: String(Number(d.slice(8))) }),
      closed ? el('span', { className: 'chip block', textContent: '休業' }) : null,
      bookings ? el('span', { className: 'chip' }, el('span', { className: 'long', textContent: '予約 ' }), `${bookings}件`) : null,
      blocks ? el('span', { className: 'chip block' }, el('span', { className: 'long', textContent: '予定 ' }), `${blocks}件`) : null);
    btn.setAttribute('aria-label', `${jp(d)} 予約${bookings}件 予定${blocks}件${closed ? ' 休業日' : ''}`);
    const date = d;
    btn.addEventListener('click', guard(() => { state.cursor = date; state.view = 'week'; return loadCalendar(); }));
    cells.push(btn);
  }
  $('monthGrid').replaceChildren(...cells);
}
const move = (n) => guard(() => {
  state.cursor = state.view === 'month' ? shiftMonth(state.cursor, n) : addDays(state.cursor, 7 * n);
  return loadCalendar();
});
$('calPrev').addEventListener('click', move(-1));
$('calNext').addEventListener('click', move(1));
$('calToday').addEventListener('click', guard(() => { state.cursor = state.config.today; return loadCalendar(); }));
$('viewWeek').addEventListener('click', guard(() => { state.view = 'week'; return loadCalendar(); }));
$('viewMonth').addEventListener('click', guard(() => { state.view = 'month'; return loadCalendar(); }));
$('calStaff').addEventListener('change', guard((ev) => { state.staffFilter = ev.target.value; return loadCalendar(); }));

// ---------- 予約・予定の詳細 ----------
function summary(rows) {
  $('detailBody').replaceChildren(...rows.filter((r) => r[1]).flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  $('detailExtra').hidden = true;
  $('memoBox').hidden = true;
  $('actualBox').hidden = true;
  $('mailBox').hidden = true;
}
const RISK = { high: '高い（要確認）', mid: 'やや高い', low: '低い' };
const SOURCE = { web: '予約ページ', admin: '管理画面', import: 'CSV読み込み', sample: 'サンプル' };
function openBooking(b) {
  $('detailTitle').textContent = '予約の詳細';
  summary([['日時', `${jp(b.date)} ${b.start}〜${b.end}`], ['メニュー', serviceName(b.serviceId)], ['担当者', staffName(b.staffId)],
    ['お名前', `${b.customerName} 様`], ['メール', b.email], ['電話', b.phone], ['相談内容', b.note],
    ...(b.answers || []).map((a) => [a.label, a.value]), ['状態', STATUS[b.status]], ['登録元', SOURCE[b.source]],
    ['キャンセルの起きやすさ', b.risk ? `${RISK[b.risk.level]}（約${Math.round(b.risk.p * 100)}%）${b.risk.reasons.length ? '・' + b.risk.reasons.join('、') : ''}` : '']]);
  // 実際の面談時間
  const hhmm = (m) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const nowHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  $('actualBox').hidden = !['booked', 'completed'].includes(b.status) || b.date > state.config.today;
  $('actStart').value = hhmm(b.actualStart);
  $('actEnd').value = hhmm(b.actualEnd);
  $('actSaved').textContent = '';
  const saveActual = async () => {
    try {
      const fresh = await call(`/api/admin/bookings/${b.id}`, 'PATCH', { actual: { start: $('actStart').value, end: $('actEnd').value } });
      const changed = fresh.status !== b.status;
      Object.assign(b, { actualStart: fresh.actualStart, actualEnd: fresh.actualEnd, status: fresh.status });
      const toM = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const plan = toM(b.end) - toM(b.start);
      const diff = b.actualEnd != null ? (b.actualEnd - b.actualStart) - plan : null;
      $('actSaved').textContent = b.actualStart == null ? '記録を消しました。'
        : diff == null ? '開始を記録しました。' : `記録しました（予定より${diff === 0 ? 'ちょうど' : diff > 0 ? `${diff}分長い` : `${-diff}分短い`}）。`;
      if (changed) { toast('面談が終わったので「完了」にしました。'); refresh(); }
    } catch (e) { $('actSaved').textContent = e.message; }
  };
  $('actualBox').onsubmit = (ev) => { ev.preventDefault(); saveActual(); };
  $('actNowStart').onclick = () => { $('actStart').value = nowHM(); saveActual(); };
  $('actNowEnd').onclick = () => {
    if (!$('actStart').value) $('actStart').value = b.start; // 開始を押し忘れたときは、予定の開始時刻で記録する
    $('actEnd').value = nowHM();
    saveActual();
  };
  $('memoBox').hidden = false;
  $('memoText').value = b.memo || '';
  $('memoSaved').textContent = '';
  $('memoBox').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await call(`/api/admin/bookings/${b.id}`, 'PATCH', { memo: $('memoText').value });
      b.memo = $('memoText').value;
      const inWeek = weekData && weekData.bookings.find((x) => x.id === b.id);
      if (inWeek) inWeek.memo = b.memo;
      $('memoSaved').textContent = '保存しました。';
    } catch (e) { $('memoSaved').textContent = e.message; }
  };
  // メールの記録
  const MAIL = { confirm: '予約確認', change: '日時変更', cancel: 'キャンセル', remind: '前日リマインド', remind_today: '当日リマインド' };
  const mails = b.mails || [];
  const canMail = state.config.mail.enabled && b.email && ['web', 'admin'].includes(b.source);
  $('mailBox').hidden = !mails.length && !canMail;
  $('mailLog').textContent = mails.length
    ? 'メールの記録: ' + mails.slice(-5).map((x) => `${when(x.at)} ${MAIL[x.kind] || x.kind}${x.retry ? '（送り直し）' : ''}${x.ok ? '' : '→失敗'}`).join('／')
    : 'メールの記録: まだ送っていません。';
  $('mailResend').hidden = !(canMail && b.status === 'booked');
  $('mailResent').textContent = '';
  $('mailResend').onclick = async () => {
    $('mailResend').disabled = true;
    try {
      const fresh = await call(`/api/admin/bookings/${b.id}/mail`, 'POST', {});
      b.mails = fresh.mails;
      $('mailResent').textContent = '送りました。';
    } catch (e) { $('mailResent').textContent = e.message; }
    $('mailResend').disabled = false;
  };
  const actions = Object.keys(STATUS).filter((s) => s !== b.status).map((s) => {
    const btn = el('button', { className: 'small' + (s === 'cancelled' ? ' danger' : ''), textContent: `「${STATUS[s]}」にする` });
    btn.addEventListener('click', guard(async () => {
      if (s === 'cancelled' && !confirm(`${b.customerName} 様の予約をキャンセルします。よろしいですか？`)) return;
      $('detail').close();
      await call(`/api/admin/bookings/${b.id}`, 'PATCH', { status: s });
      toast(`「${STATUS[s]}」にしました。`);
      await refresh();
      pollNotes();
    }));
    return btn;
  });
  if (b.status === 'booked') {
    const change = el('button', { className: 'small primary', textContent: '日時・担当者を変更する' });
    change.addEventListener('click', () => { $('detail').close(); openBookingForm(b); });
    actions.unshift(change);
  }
  $('detailActions').replaceChildren(...actions);
  $('detail').showModal();
}
function openBlock(k) {
  $('detailTitle').textContent = k.recurring ? '毎週の予定' : '予定の詳細';
  summary([['日時', k.recurring ? `毎週${WD[wd(k.date)]}曜 ${k.start}〜${k.end}` : `${jp(k.date)} ${k.start}〜${k.end}`], ['内容', k.title], ['担当者', staffName(k.staffId)]]);
  const del = el('button', { className: 'small danger', textContent: k.recurring ? 'この毎週の予定を、すべて削除する' : 'この予定を削除する' });
  del.addEventListener('click', guard(async () => {
    if (k.recurring && !confirm('この予定を、過去・未来のすべての週から削除します。よろしいですか？')) return;
    $('detail').close();
    await call(`/api/admin/${k.recurring ? 'recurring' : 'blocks'}/${k.id}`, 'DELETE');
    await refresh();
  }));
  $('detailActions').replaceChildren(del);
  $('detail').showModal();
}

// ---------- 予約の追加・日時変更 ----------
const options = (list) => list.map((s) => el('option', { value: s.id, textContent: s.name }));
let editing = null;
function openBookingForm(booking, preset) {
  const f = $('bookingForm');
  editing = booking || null;
  f.reset();
  f.serviceId.replaceChildren(...options(state.config.services));
  f.staffId.replaceChildren(...options(state.config.staff));
  $('bookingTitle').textContent = editing ? '日時・担当者を変更' : '予約を追加';
  $('bookingLead').textContent = editing
    ? `${editing.customerName} 様の予約を変更します。所要時間は変わりません。`
    : '電話や対面で受けた予約を登録します。受付時間外でも、ほかの予約・予定と重ならなければ登録できます。';
  $('bookingSubmit').textContent = editing ? '変更する' : '登録する';
  $('bkCustomer').disabled = $('bkCustomer').hidden = Boolean(editing);
  $('bkServiceWrap').hidden = f.serviceId.disabled = Boolean(editing);
  if (editing) {
    f.staffId.value = editing.staffId;
    f.date.value = editing.date;
    f.start.value = editing.start;
  } else {
    if (state.staffFilter) f.staffId.value = state.staffFilter;
    f.date.value = preset ? preset.date : state.cursor;
    f.start.value = preset ? preset.start : '10:00';
  }
  $('bookingError').hidden = true;
  $('bookingDialog').showModal();
}
$('addBooking').addEventListener('click', () => openBookingForm(null));
$('fab').addEventListener('click', () => openBookingForm(null));
$('bookingForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    if (editing) await call(`/api/admin/bookings/${editing.id}`, 'PATCH', body);
    const made = editing ? null : await call('/api/admin/bookings', 'POST', body);
    $('bookingDialog').close();
    toast(editing ? '日時を変更しました。' : made.loadWarning
      ? `予約を登録しました。この日の${staffName(made.staffId)}の稼働率が${made.loadWarning}%になり、8割を超えています。遅れが連鎖しやすいため、ほかの予約をずらせないか確認してください。`
      : '予約を登録しました。', Boolean(made && made.loadWarning));
    if (state.tab === 'calendar') state.cursor = body.date;
    await refresh();
    pollNotes();
  } catch (e) {
    $('bookingError').textContent = e.message;
    $('bookingError').hidden = false;
  }
});

$('addBlock').addEventListener('click', () => {
  const f = $('blockForm');
  f.reset();
  f.staffId.replaceChildren(...options(state.config.staff));
  if (state.staffFilter) f.staffId.value = state.staffFilter;
  f.date.value = state.cursor;
  $('blockUntilWrap').hidden = true;
  $('blockError').hidden = true;
  $('blockDialog').showModal();
});
$('blockRepeat').addEventListener('change', (ev) => { $('blockUntilWrap').hidden = !ev.target.checked; });
$('blockForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  body.repeat = ev.target.repeat.checked;
  try {
    await call('/api/admin/blocks', 'POST', body);
    $('blockDialog').close();
    toast(body.repeat ? '毎週の予定を追加しました。' : '予定を追加しました。');
    state.cursor = body.date;
    await loadCalendar();
  } catch (e) {
    $('blockError').textContent = e.message;
    $('blockError').hidden = false;
  }
});

// ---------- 予約一覧 ----------
const pill = (status) => el('span', { className: 'pill ' + status, textContent: STATUS[status] });
const query = (form) => new URLSearchParams([...new FormData(form)].filter(([, v]) => v)).toString();
// キャンセル待ち（これからの日付で、待っている人・お知らせ済みの人）
async function loadWaitlist() {
  const data = await call('/api/admin/waitlist');
  $('waitNote').textContent = data.enabled
    ? '空きが出ると、登録した人へ自動でメールを送ります（先着順のご案内）。お知らせのあと、予約が自動で確定することはありません。'
    : 'メール送信が設定されていないため、予約ページではキャンセル待ちを受け付けていません。';
  $('waitRows').replaceChildren(...(data.waitlist.length ? data.waitlist.map((w) => {
    const del = el('button', { className: 'small danger', textContent: '削除' });
    del.addEventListener('click', guard(async () => {
      if (!confirm(`${w.customerName} 様のキャンセル待ちを削除します。よろしいですか？`)) return;
      await call(`/api/admin/waitlist/${w.id}`, 'DELETE');
      await loadWaitlist();
    }));
    return el('div', { className: 'rowitem' },
      el('span', { className: 'main', textContent: `${jpFull(w.date)}（${w.part}）　${w.customerName} 様` }),
      el('span', { className: 'sub', textContent: `${w.serviceName}／${w.staffName}／${w.email}／登録 ${when(w.createdAt)}${w.notifiedAt ? `／お知らせ ${when(w.notifiedAt)}` : ''}` }),
      el('span', { className: 'side row' }, el('span', { className: 'pill' + (w.status === 'notified' ? ' completed' : ''), textContent: w.status === 'notified' ? 'お知らせ済み' : '待っています' }), del));
  }) : [empty('キャンセル待ちの登録はありません。')]));
}
async function loadList() {
  loadWaitlist().catch(() => {});
  const data = await call('/api/admin/bookings?' + query($('listForm')));
  $('listCount').textContent = data.total > data.bookings.length
    ? `${data.total}件のうち、新しい順に${data.bookings.length}件を表示しています。条件を絞り込んでください。`
    : `${data.total}件`;
  $('listRows').replaceChildren(...(data.bookings.length ? data.bookings.map((b) => {
    const row = el('button', { className: 'rowitem' },
      el('span', { className: 'main', textContent: `${b.customerName} 様` }),
      el('span', { className: 'sub', textContent: `${jpFull(b.date)} ${b.start}〜${b.end}／${serviceName(b.serviceId)}／${staffName(b.staffId)}` }),
      el('span', { className: 'side' }, pill(b.status)));
    row.addEventListener('click', () => openBooking(b));
    return row;
  }) : [empty('条件に合う予約はありません。')]));
}
$('listForm').addEventListener('submit', guard((ev) => { ev.preventDefault(); return loadList(); }));
$('exportCsv').addEventListener('click', () => {
  const f = $('listForm');
  const p = new URLSearchParams();
  if (f.from.value) p.set('from', f.from.value);
  if (f.to.value) p.set('to', f.to.value);
  location.href = '/api/admin/export?' + p; // 期間だけを条件にして書き出す
});

// ---------- 顧客 ----------
async function loadCustomers() {
  const data = await call('/api/admin/customers?' + query($('custForm')));
  $('custCount').textContent = `${data.total}人`;
  $('custRows').replaceChildren(...(data.customers.length ? data.customers.map((c) => {
    const row = el('button', { className: 'rowitem' },
      el('span', { className: 'main', textContent: `${c.name} 様` }),
      el('span', { className: 'sub', textContent: `予約${c.total}回（実施${c.completed}・キャンセル${c.cancelled}・無断${c.noshow}）${c.email ? '／' + c.email : ''}` }),
      el('span', { className: 'side' }, c.next ? el('span', { className: 'pill', textContent: `次回 ${jp(c.next)}` })
        : el('span', { textContent: c.last ? `最後の来談 ${jpFull(c.last)}` : '来談なし' })));
    row.addEventListener('click', () => openCustomer(c));
    return row;
  }) : [empty('条件に合うお客様はいません。')]));
}
function openCustomer(c) {
  $('detailTitle').textContent = `${c.name} 様`;
  summary([['メール', c.email], ['電話', c.phone], ['別の表記', (c.aliases || []).join('、')], ['予約回数', `${c.total}回（実施 ${c.completed}／キャンセル ${c.cancelled}／無断 ${c.noshow}）`]]);
  $('detailExtra').hidden = false;
  $('detailExtra').replaceChildren(...c.history.map((h) => el('div', null,
    el('div', { className: 'row' }, el('strong', { textContent: `${jpFull(h.date)} ${h.start}` }), pill(h.status)),
    el('div', { className: 'muted', textContent: `${h.serviceName}／${h.staffName}${h.note ? '／' + h.note : ''}` }),
    h.memo ? el('div', { style: 'white-space:pre-wrap', textContent: `メモ: ${h.memo}` }) : null)));
  $('detailActions').replaceChildren();
  $('detail').showModal();
}
$('custForm').addEventListener('submit', guard((ev) => { ev.preventDefault(); return loadCustomers(); }));

// ---------- 通知 ----------
async function loadNotes(silent) {
  const data = await call('/api/admin/notifications');
  const badge = $('unread');
  if (badge) { badge.textContent = data.unread > 99 ? '99+' : data.unread; badge.hidden = !data.unread; }
  // 前回の確認以降に届いた通知を、画面にも表示する
  const ids = new Set(data.notifications.map((n) => n.id));
  if (state.seenNotes) {
    data.notifications.filter((n) => !state.seenNotes.has(n.id)).slice(0, 2).reverse()
      .forEach((n) => toast(`${n.title}: ${n.body}`));
  }
  state.seenNotes = ids;
  if (silent && $('tab-notes').hidden) return;
  $('notes').replaceChildren(...(data.notifications.length
    ? data.notifications.map((n) => el('div', { className: 'note' + (n.read ? '' : ' unread') },
      el('h3', { textContent: n.title }), el('p', { textContent: n.body }), el('p', { className: 'muted', textContent: when(n.createdAt) })))
    : [empty('通知はまだありません。予約が入ったときや、データを読み込んだときにここへ届きます。')]));
}
const pollNotes = () => loadNotes(true).catch(() => {});
$('markRead').addEventListener('click', guard(async () => { await call('/api/admin/notifications/read', 'POST'); await loadNotes(false); }));

// ---------- 分析 ----------
function bars(id, rows, valueText) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const box = $(id);
  if (!rows.length) return box.replaceChildren(el('p', { className: 'muted', textContent: 'データがありません。' }));
  box.replaceChildren(...rows.flatMap((r) => [
    el('span', { textContent: r.label }),
    el('span', { className: 'track' }, el('span', { className: 'fill', style: `display:block;width:${(r.value / max) * 100}%` })),
    el('span', { className: 'val', textContent: valueText(r) }),
  ]));
}
// 前の期間との差を「▲ 3件」「▼ 2pt」のような印で表す。upIsGood: 増えるのが良いことか（null は良し悪しなし）
// sure が false のときは、差があっても「誤差の範囲」として色を付けない。range は「確からしい範囲」
function delta(cur, prev, kind, hasPrev, upIsGood, sure, range) {
  const extra = range ? [el('span', { className: 'prev', textContent: `確からしい範囲 ${pct(range[0])}〜${pct(range[1])}` })] : [];
  if (!hasPrev || prev == null || cur == null) return [el('span', { className: 'delta', textContent: '比較なし' }), ...extra];
  if (sure === false) {
    const d0 = Math.round(cur * 100) - Math.round(prev * 100);
    return [el('span', { className: 'delta', textContent: d0 === 0 ? '変わらず' : `${d0 > 0 ? '▲' : '▼'} ${Math.abs(d0)}pt・誤差の範囲` }),
      el('span', { className: 'prev', textContent: `前の期間 ${pct(prev)}` }), ...extra];
  }
  const diff = kind === 'rate' ? Math.round(cur * 100) - Math.round(prev * 100) : kind === 'days' ? Number((cur - prev).toFixed(1)) : cur - prev;
  const unit = { rate: 'pt', days: '日', count: '件' }[kind];
  const tone = diff === 0 || upIsGood == null ? '' : (diff > 0) === upIsGood ? ' good' : ' bad';
  const word = diff === 0 ? '変わらず' : `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}${unit}`;
  const before = kind === 'rate' ? pct(prev) : kind === 'days' ? `${prev.toFixed(1)}日` : `${prev}件`;
  return [el('span', { className: 'delta' + tone, textContent: word }), el('span', { className: 'prev', textContent: `前の期間 ${before}` }), ...extra];
}
let rulesInfo = null;
// これからの予約の見込み（分析の期間とは関係なく、今日から4週間）
async function loadForecast() {
  const f = await call('/api/admin/forecast');
  const busy = f.days.filter((d) => d.level === 'busy');
  const acc = f.accuracy;
  $('fcSummary').replaceChildren(el('p', null,
    busy.length ? el('strong', { textContent: `混む見込みの日が ${busy.length}日あります（見込み稼働率が${f.cap}%を超える日）。` }) : `見込み稼働率が${f.cap}%を超える日はありません。`,
    acc ? ` 過去4週間を、面談日の1・3・7日前の時点から${acc.trials}回予測し直したところ、1日あたりの誤差は「曜日の平均」で ±${acc.mean.toFixed(2)}件、「予約の入り方も使う方法」で ±${acc.pace.toFixed(2)}件でした。いまは誤差が小さい${f.method === 'pace' ? '「予約の入り方も使う方法」' : '「曜日の平均」'}で見込んでいます。` : ' 予測の当たり具合を確かめるには、もう少し過去の実績が必要です。',
    f.trend === 'up' ? ' 週ごとの予約は増加傾向で、その分を見込みに足しています。' : f.trend === 'down' ? ' 週ごとの予約は減少傾向で、その分を見込みから引いています。' : ''));
  const tag = (d) => (!d.enough ? el('span', { className: 'muted', textContent: '実績不足' })
    : d.level === 'busy' ? el('span', { className: 'pill noshow', textContent: '混む見込み' })
      : d.level === 'quiet' ? el('span', { className: 'pill plain', textContent: '空きが多い見込み' }) : el('span', { className: 'muted', textContent: '—' }));
  $('fcTable').replaceChildren(
    el('tr', null, ...['日付', '確定済み', '見込み（幅）', '見込み稼働率', ''].map((h) => el('th', { textContent: h }))),
    ...f.days.map((d) => el('tr', { className: d.level === 'busy' ? 'busy' : '' },
      el('td', { textContent: jp(d.date) + (d.date === f.today ? ' 今日' : '') }),
      el('td', { textContent: `${d.confirmed}件` }),
      el('td', { textContent: d.enough ? `${d.expected}件（${d.low}〜${d.high}）` : '—' }),
      el('td', { textContent: d.enough ? pct(d.load) : '—' }),
      el('td', null, tag(d)))));
}
// キャンセルになりやすい予約（これから2週間）
async function loadRisk() {
  const r = await call('/api/admin/risk');
  if (!r.ready) {
    $('riskSummary').replaceChildren(el('p', { className: 'muted', textContent: `予測を作るには、結果の出た予約（完了・キャンセル・無断キャンセル）が${r.needed}件以上必要です（いまは${r.have}件）。` }));
    return $('riskRows').replaceChildren();
  }
  const c = r.check;
  const power = c && c.auc != null ? c.auc : null;
  $('riskSummary').replaceChildren(el('p', null,
    `これまでの予約 ${r.trained}件のうち、${pct(r.bad / r.trained)}がキャンセル・無断キャンセルでした。`,
    power == null ? ' 見分ける力を確かめるには、直近30日の結果がもう少し必要です。'
      : el('span', null, ' 見分ける力は ', el('strong', { textContent: power.toFixed(2) }),
        power >= 0.6 ? `です（直近30日で「要確認」とした予約は、${c.highCount ? `実際に ${pct(c.highRate)} がキャンセル・無断キャンセルになりました。それ以外は ${pct(c.restRate)}` : '該当がありませんでした'}）。`
          : 'で、まだ当てずっぽうと大きく変わりません。印は付けず、目安として並べています。')));
  const list = r.upcoming.filter((x) => x.level !== 'low').slice(0, 10);
  $('riskRows').replaceChildren(...(list.length ? list.map((x) => {
    const row = el('div', { className: 'rowitem' },
      el('span', { className: 'main', textContent: `${jpFull(x.date)} ${x.start}　${x.customerName} 様` }),
      el('span', { className: 'sub', textContent: x.reasons.length ? x.reasons.join('、') : '目立つ理由はありません' }),
      el('span', { className: 'side' }, el('span', { className: 'pill' + (x.level === 'high' && r.reliable ? ' noshow' : ' plain'), textContent: `約${Math.round(x.p * 100)}%` })));
    return row;
  }) : [empty('これから2週間に、起きやすさが高めの予約はありません。')]));
}
async function loadAnalytics() {
  loadRisk().catch((e) => { $('riskSummary').textContent = e.message; });
  loadForecast().catch((e) => { $('fcSummary').textContent = e.message; });
  const v = $('days').value;
  const a = await call(`/api/admin/analytics?${v.includes('-') ? 'month=' + v : 'days=' + v}`);
  $('printHead').textContent = `${state.config.settings.site.name}　予約レポート（${a.period.from}〜${a.period.to}）`;
  const t = a.totals;
  const p = a.previous.totals;
  const has = p.total > 0;
  $('periodNote').textContent = `集計期間 ${a.period.from}〜${a.period.to}。比較している「前の期間」は ${a.previous.period.from}〜${a.previous.period.to} です。`;
  const kpi = (label, value, unit, parts) => el('div', { className: 'card kpi' }, el('span', { className: 'lbl', textContent: label }),
    el('b', null, value, el('small', { textContent: unit })), ...parts);
  $('kpis').replaceChildren(
    kpi('予約件数', String(t.total), '件', delta(t.total, p.total, 'count', has, true)),
    kpi('稼働率', String(Math.round(t.utilization * 100)), '%', delta(t.utilization, p.utilization, 'rate', has, true)),
    kpi('キャンセル率', String(Math.round(t.cancelRate * 100)), '%', delta(t.cancelRate, p.cancelRate, 'rate', has, false, a.significant.cancelRate, t.total ? t.cancelRange : null)),
    kpi('無断キャンセル率', String(Math.round(t.noshowRate * 100)), '%', delta(t.noshowRate, p.noshowRate, 'rate', has, false, a.significant.noshowRate, t.noshowBase ? t.noshowRange : null)),
    kpi('平均リードタイム', t.avgLeadDays == null ? '—' : t.avgLeadDays.toFixed(1), t.avgLeadDays == null ? '' : '日', delta(t.avgLeadDays, p.avgLeadDays, 'days', has, null)),
    kpi('リピート率', t.customers ? String(Math.round(t.repeatRate * 100)) : '—', t.customers ? '%' : '', delta(t.repeatRate, p.repeatRate, 'rate', has && p.customers > 0, true, a.significant.repeatRate, t.customers ? t.repeatRange : null)));

  // 推移グラフ（積み上げ棒）
  const buckets = a.trend.buckets;
  const max = Math.max(1, ...buckets.map((b) => b.active + b.cancelled));
  const every = Math.ceil(buckets.length / (window.innerWidth < 760 ? 5 : 9)); // ラベルが重ならないよう間引く
  $('trendTitle').textContent = `予約件数の推移（${a.trend.unit}ごと）`;
  $('trend').replaceChildren(...buckets.map((b, i) => el('div', { className: 'col' + (b.partial ? ' partial' : ''), title: `${b.label}〜${b.partial ? '（途中）' : ''}: 実施・予約中 ${b.active}件／キャンセル ${b.cancelled}件` },
    el('div', { textContent: buckets.length <= 14 ? String(b.active + b.cancelled) : '' }),
    el('div', { className: 'area' },
      el('div', { className: 'c', style: `height:${(b.cancelled / max) * 100}%` }),
      el('div', { className: 'a', style: `height:${(b.active / max) * 100}%` })),
  )));
  $('trendLabels').replaceChildren(...buckets.map((b, i) => el('span', { textContent: i % every === 0 ? b.label : '' })));
  const u = a.trend.unit;
  const words = { up: '増加傾向です', down: '減少傾向です', flat: 'はっきりした増減は見られません（ばらつきの範囲です）', unknown: `そろった${u}が6つ未満のため、増減の傾向はまだ判定できません` };
  $('trendNote').textContent = `うすい色の棒は、期間の端で切れている、またはまだ終わっていない${u}です（途中の数字）。` +
    `増減の傾向は、そろった${a.trend.fullCount}${u}分で判定しています: ${words[a.trend.direction]}。`;
  $('trend').setAttribute('role', 'img');
  $('trend').setAttribute('aria-label', `${a.trend.unit}ごとの予約件数。` + buckets.map((b) => `${b.label} ${b.active + b.cancelled}件`).join('、'));

  const tags = { warn: '要対応', idea: '提案', info: '注意', good: '良好' };
  $('suggestions').replaceChildren(...(a.suggestions.length ? a.suggestions.map((s) => el('div', { className: 'card sug ' + s.level },
    el('div', { className: 'rank' }, el('small', { textContent: '優先度' }), String(s.priority)),
    el('div', null, el('span', { className: 'kind', textContent: tags[s.level] }), el('h3', { textContent: s.title }),
      el('p', { className: 'evi', textContent: '根拠: ' + s.evidence }), el('p', { textContent: s.action }),
      s.impact ? el('p', { className: 'impact', textContent: s.impact.text }) : null)))
    : [empty('改善案を出すためのデータがまだありません。')]));
  bars('chartWeekday', a.byWeekday.filter((w) => w.capacity > 0).map((w) => ({ label: w.label + '曜', value: w.utilization, count: w.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartHour', a.byHour.map((h) => ({ label: h.label, value: h.count })), (r) => `${r.value}件`);
  bars('chartStaff', a.byStaff.map((s) => ({ label: s.label, value: s.utilization, count: s.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartService', a.byService.map((s) => ({ label: s.label, value: s.count })), (r) => `${r.value}件`);
  // 曜日 × 時間帯の混み具合（数字も必ず表示し、色だけに頼らない）
  const heat = a.heat;
  $('heat').style.gridTemplateColumns = `3em repeat(${heat.hours.length}, minmax(34px, 1fr))`;
  $('heat').replaceChildren(...(heat.rows.length ? [
    el('span'), ...heat.hours.map((h) => el('span', { className: 'hh', textContent: `${h}時` })),
    ...heat.rows.flatMap((r) => [el('span', { className: 'hw', textContent: r.label }),
      ...r.cells.map((n, i) => {
        const level = n === 0 ? 0 : Math.max(1, Math.ceil((n / heat.max) * 4));
        const c = el('span', { className: `hc l${level}`, textContent: n || '' });
        c.title = `${r.label}曜 ${heat.hours[i]}時台: ${n}件`;
        return c;
      })]),
  ] : [el('p', { className: 'muted', textContent: 'データがありません。' })]));
  // 予定のゆとり（待ち行列理論）
  const L = a.load;
  $('loadSummary').replaceChildren(el('p', null,
    L.worked ? `予約のあった ${L.worked}日（担当者ごとに数えた日数）のうち、稼働率が${L.threshold}%を超えた日は ` : '',
    L.worked ? el('strong', { textContent: `${L.over}日（${pct(L.over / L.worked)}）` }) : '対象期間に予約のあった日はありません。',
    L.worked ? `です。予約のあった日の平均稼働率は ${pct(L.avgWorkedRate)}、予約ページの上限は ${L.cap >= 100 ? '設定なし' : L.cap + '%'} です。` : ''));
  $('loadTable').replaceChildren(
    el('tr', null, el('th', { textContent: '稼働率' }), ...L.table.map((r) => el('th', { className: r.rate > 0.8 ? 'hot' : '', textContent: pct(r.rate) }))),
    el('tr', null, el('td', { textContent: '遅れの広がりやすさ' }), ...L.table.map((r) => el('td', { className: r.rate > 0.8 ? 'hot' : '', textContent: `約${r.factor}倍` }))));
  $('loadDays').replaceChildren(...(L.overList.length ? L.overList.map((x) => el('div', { className: 'rowitem' },
    el('span', { className: 'main', textContent: `${jpFull(x.date)}　${x.staff}` }),
    el('span', { className: 'sub', textContent: `予約 ${Math.round(x.booked / 6) / 10}時間／受付できる時間 ${Math.round(x.capacity / 6) / 10}時間` }),
    el('span', { className: 'side' }, el('span', { className: 'pill noshow', textContent: `稼働 ${pct(x.rate)}` })))) : []));
  $('loadDays').hidden = !L.overList.length;
  // 実績で見た延長と遅れ
  const A = a.actuals;
  $('actualSummary').replaceChildren(el('p', { className: A.n ? '' : 'muted' }, A.n
    ? `実際の時間を記録した面談は ${A.n}件です。予定より長くなった時間は平均 ${A.avgOverrun.toFixed(1)}分で、${pct(A.overrunShare)}が5分以上延びました（4件に3件は ${A.p75Overrun}分以内）。前の面談の延長で次の開始が遅れたことが ${A.chained}回${A.chained ? `（平均 ${A.avgChained.toFixed(1)}分）` : ''}ありました。`
    : 'まだ記録がありません。予約の詳細で「いま開始」「いま終了」を押すと記録でき、ここに延長と遅れの実績が出ます。'));
  $('actualTable').replaceChildren(...(A.n ? [
    el('tr', null, el('th', { textContent: 'その日の稼働率' }), ...A.byLoad.map((x) => el('th', { className: x.key === 'high' ? 'hot' : '', textContent: x.label }))),
    el('tr', null, el('td', { textContent: '開始の遅れ（平均）' }), ...A.byLoad.map((x) => el('td', { className: x.key === 'high' ? 'hot' : '', textContent: x.n ? `${x.avgLate.toFixed(1)}分` : '—' }))),
    el('tr', null, el('td', { textContent: '記録した件数' }), ...A.byLoad.map((x) => el('td', { textContent: `${x.n}件` }))),
  ] : []));

  // 目安の数値の入力欄（割合は % に直して表示する）
  $('rulesBox').hidden = !isOwner();
  rulesInfo = a.ruleMeta;
  $('rules').replaceChildren(...a.ruleMeta.map((m) => {
    const isRate = m.unit === '%';
    const input = el('input', { type: 'number', inputMode: 'decimal', name: m.key, step: 'any', min: isRate ? m.min * 100 : m.min, max: isRate ? m.max * 100 : m.max,
      value: isRate ? Math.round(a.rules[m.key] * 1000) / 10 : a.rules[m.key] });
    const def = isRate ? Math.round(a.ruleDefaults[m.key] * 100) : a.ruleDefaults[m.key];
    return el('label', null, `${m.label}（${m.unit}）`, input, el('span', { className: 'muted', style: 'font-weight:400', textContent: `初期値 ${def}${m.unit}` }));
  }));
}
$('days').addEventListener('change', guard(loadAnalytics));
$('printReport').addEventListener('click', () => window.print());
// 集計期間に「今月」「先月」などの月単位の選択肢を足す
function addMonthOptions() {
  if ($('days').querySelector('[data-month]')) return;
  const first = state.config.today.slice(0, 8) + '01';
  for (let i = 0; i < 4; i++) {
    const m = shiftMonth(first, -i).slice(0, 7);
    const o = el('option', { value: m, textContent: `${Number(m.slice(0, 4))}年${Number(m.slice(5))}月${i === 0 ? '（今月）' : i === 1 ? '（先月）' : ''}` });
    o.dataset.month = '1';
    $('days').append(o);
  }
}
$('rulesSave').addEventListener('click', guard(async () => {
  const body = {};
  for (const m of rulesInfo) {
    const v = Number($('rules').querySelector(`[name=${m.key}]`).value);
    body[m.key] = m.unit === '%' ? v / 100 : v;
  }
  await call('/api/admin/rules', 'PUT', body);
  await loadAnalytics();
  toast('目安を保存し、改善案を出し直しました。');
}));
$('rulesReset').addEventListener('click', guard(async () => {
  if (!confirm('目安の数値をすべて初期値に戻します。よろしいですか？')) return;
  await call('/api/admin/rules', 'PUT', { reset: true });
  await loadAnalytics();
  toast('目安を初期値に戻しました。');
}));

// ---------- データ ----------
$('csvRun').addEventListener('click', guard(async () => {
  const file = $('csvFile').files[0];
  if (!file) throw new Error('CSVファイルを選んでください。');
  const r = await call('/api/admin/import', 'POST', { csv: await file.text() });
  $('csvResult').hidden = false;
  $('csvResult').textContent = `${r.imported}件を取り込みました（スキップ ${r.skipped.length}件）。分析で結果を確認できます。`;
  $('csvSkipped').hidden = !r.skipped.length;
  if (r.skipped.length) {
    $('csvSkipped').replaceChildren(el('table', null,
      el('tr', null, el('th', { textContent: '行' }), el('th', { textContent: 'スキップした理由' })),
      ...r.skipped.slice(0, 50).map((s) => el('tr', null, el('td', { textContent: `${s.line}行目` }), el('td', { textContent: s.reason })))));
  }
  await refreshConfig();
  pollNotes();
}));
$('sampleAdd').addEventListener('click', guard(async () => {
  const r = await call('/api/admin/sample', 'POST');
  toast(`サンプル ${r.count}件を登録しました。`);
  pollNotes();
}));
$('sampleDel').addEventListener('click', guard(async () => {
  if (!confirm('サンプルの予約だけを削除します。よろしいですか？')) return;
  const r = await call('/api/admin/sample', 'DELETE');
  toast(`サンプル ${r.count}件を削除しました。`);
}));

// ---------- 設定 ----------
let draft = null;
let isDirty = false; // 保存していない変更があるか
const dirty = () => { isDirty = true; $('saved').textContent = '変更があります。「設定を保存する」を押すと反映されます。'; };
async function loadSettings() {
  if (!draft) draft = JSON.parse(JSON.stringify(state.config));
  renderSettings();
  loadOverrides();
  await Promise.all([loadClosed(), loadUsers()]);
}
function renderSettings() {
  const input = (props, onInput) => { const i = el('input', props); i.addEventListener('input', () => { onInput(i); dirty(); }); return i; };
  const remove = (list, i, label) => {
    const b = el('button', { className: 'small danger', textContent: '削除' });
    b.setAttribute('aria-label', `${label}を削除`);
    b.addEventListener('click', () => { list.splice(i, 1); dirty(); renderSettings(); });
    return b;
  };
  const st = draft.settings;
  $('setName').value = st.site.name;
  $('setIntro').value = st.site.intro;
  $('setDeadline').value = st.site.cancelDeadlineHours;
  $('setSlot').value = st.slotMinutes;
  $('setWindow').value = st.windowDays;
  $('setLead').value = st.minLeadMinutes;
  $('setBuffer').value = st.bufferMinutes || 0;
  $('setMaxPerDay').value = st.maxPerDay || 0;
  $('setLoadCap').value = st.loadCap == null ? 80 : st.loadCap;
  $('setReminder').checked = st.mail.reminder;
  $('setReminderHour').replaceChildren(...Array.from({ length: 24 }, (_, h) => el('option', { value: h, textContent: `${h}時` })));
  $('setReminderHour').value = st.mail.reminderHour;
  $('setNotify').value = st.mail.notifyTo || '';
  $('setRiskConfirm').checked = Boolean(st.mail.riskConfirm);
  // 事前アンケートの質問
  st.questions = st.questions || [];
  $('questionList').replaceChildren(...(st.questions.length ? st.questions.map((q, i) => {
    const type = el('select', null, el('option', { value: 'text', textContent: '自由に入力' }), el('option', { value: 'select', textContent: '選択肢から選ぶ' }));
    type.value = q.type;
    type.addEventListener('change', () => { q.type = type.value; dirty(); renderSettings(); });
    const required = el('input', { type: 'checkbox', checked: Boolean(q.required) });
    required.addEventListener('change', () => { q.required = required.checked; dirty(); });
    const opts = el('textarea', { value: (q.options || []).join('\n'), placeholder: '例:\n対面\nオンライン', style: 'min-height:84px' });
    opts.addEventListener('input', () => { q.options = opts.value.split('\n').map((o) => o.trim()).filter(Boolean); dirty(); });
    return el('div', { className: 'stack-s block-item' },
      el('div', { className: 'row' },
        el('label', { className: 'grow' }, '質問文', input({ value: q.label, maxLength: 80, placeholder: '例: ご希望の面談方法' }, (x) => { q.label = x.value; })),
        el('label', { style: 'width:11em' }, '答え方', type),
        el('div', { style: 'align-self:end' }, remove(st.questions, i, q.label || '質問'))),
      q.type === 'select' ? el('label', null, '選択肢（1行に1つ）', opts) : null,
      el('label', { className: 'check' }, required, '回答を必須にする'));
  }) : [empty('質問はまだありません。')]));
  const mail = state.config.mail;
  $('mailStatus').className = 'msg ' + (mail.enabled ? 'ok' : 'info');
  $('mailStatus').textContent = mail.enabled
    ? `メール送信は有効です（差出人: ${mail.from}）。予約・変更・キャンセルのときに、お客様へ自動でメールを送ります。` +
      (mail.hasPublicUrl ? '' : ' ※ PUBLIC_URL が未設定のため、メールに予約確認ページのリンクは入りません。')
    : 'メール送信は、まだ設定されていません。サーバーに SMTP の設定（README の「メールを送る設定」）を入れると有効になります。';

  // 担当者: 曜日ごとの受付時間と休憩
  $('staffList').replaceChildren(...draft.staff.map((s, i) => {
    const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const row = el('div', { className: 'hgroup' });
      const draw = () => {
        const h = s.hours[d];
        if (h && !Array.isArray(h.breaks)) h.breaks = h.breakStart && h.breakEnd ? [{ start: h.breakStart, end: h.breakEnd }] : [];
        const time = (obj, key, label) => {
          const t = input({ type: 'time', value: obj ? obj[key] || '' : '', disabled: !h }, (x) => { obj[key] = x.value; });
          t.setAttribute('aria-label', `${WD[d]}曜の${label}`);
          return t;
        };
        const on = el('input', { type: 'checkbox', checked: Boolean(h) });
        on.addEventListener('change', () => { s.hours[d] = on.checked ? { start: '09:00', end: '18:00', breaks: [] } : null; dirty(); draw(); });
        const breaks = h ? h.breaks : [];
        const first = breaks[0] || (h ? (breaks[0] = { start: '', end: '' }) : null);
        const addBtn = el('button', { type: 'button', className: 'small', textContent: '＋', disabled: !h || breaks.length >= 5 });
        addBtn.setAttribute('aria-label', `${WD[d]}曜の休憩を追加`);
        addBtn.addEventListener('click', () => { breaks.push({ start: '', end: '' }); dirty(); draw(); });
        const lines = [el('div', { className: 'h' + (h ? '' : ' off') }, el('label', { className: 'check' }, on, `${WD[d]}曜`),
          time(h, 'start', '開始'), time(h, 'end', '終了'), el('span', { className: 'rest', textContent: '休憩' }),
          time(first, 'start', '休憩開始'), time(first, 'end', '休憩終了'), addBtn)];
        breaks.slice(1).forEach((br, i) => {
          const del = el('button', { type: 'button', className: 'small danger', textContent: '×' });
          del.setAttribute('aria-label', `${WD[d]}曜の休憩${i + 2}を削除`);
          del.addEventListener('click', () => { breaks.splice(i + 1, 1); dirty(); draw(); });
          lines.push(el('div', { className: 'h extra' }, el('span'), el('span'), el('span'), el('span', { className: 'rest', textContent: `休憩${i + 2}` }),
            time(br, 'start', `休憩${i + 2}の開始`), time(br, 'end', `休憩${i + 2}の終了`), del));
        });
        row.replaceChildren(...lines);
      };
      draw();
      return row;
    });
    const copy = el('button', { className: 'small', textContent: '月曜の時間を平日すべてにコピー' });
    copy.addEventListener('click', () => {
      for (const d of [2, 3, 4, 5]) s.hours[d] = s.hours[1] ? JSON.parse(JSON.stringify(s.hours[1])) : null;
      dirty(); renderSettings();
    });
    return el('div', { className: 'stack-s block-item' },
      el('div', { className: 'row' },
        el('label', { className: 'grow' }, '名前', input({ value: s.name, maxLength: 40 }, (x) => { s.name = x.value; })),
        el('div', { style: 'align-self:end' }, remove(draft.staff, i, s.name || '担当者'))),
      el('div', { className: 'hours-head', textContent: '受付する曜日／開始〜終了／休憩（任意）' }),
      el('div', { className: 'hours' }, ...rows), copy);
  }));
  $('serviceList').replaceChildren(...draft.services.map((v, i) => el('div', { className: 'stack-s block-item' },
    el('div', { className: 'row' },
      el('label', { className: 'grow' }, 'メニュー名', input({ value: v.name, maxLength: 40 }, (x) => { v.name = x.value; })),
      el('label', { style: 'width:7.5em' }, '所要時間（分）', input({ type: 'number', inputMode: 'numeric', min: 5, max: 480, step: 5, value: v.minutes }, (x) => { v.minutes = Number(x.value); })),
      el('div', { style: 'align-self:end' }, remove(draft.services, i, v.name || 'メニュー'))),
    el('label', null, '説明（任意。予約ページに表示されます）', input({ value: v.description || '', maxLength: 200 }, (x) => { v.description = x.value; })),
    // 対応する担当者（全員にチェック＝だれでも対応できる）
    el('div', null, el('div', { className: 'hours-head', textContent: 'このメニューに対応する担当者' }),
      el('div', { className: 'row' }, ...draft.staff.filter((x) => x.id).map((x) => {
        const all = !v.staffIds || !v.staffIds.length;
        const box = el('input', { type: 'checkbox', checked: all || v.staffIds.includes(x.id) });
        box.addEventListener('change', () => {
          const ids = draft.staff.filter((y) => y.id);
          const cur = new Set(all ? ids.map((y) => y.id) : v.staffIds);
          if (box.checked) cur.add(x.id); else cur.delete(x.id);
          if (!cur.size) { box.checked = true; return toast('対応する担当者は、1人以上必要です。'); }
          v.staffIds = cur.size === ids.length ? [] : [...cur];
          dirty(); renderSettings();
        });
        return el('label', { className: 'check' }, box, x.name || '（名前なし）');
      }), draft.staff.some((x) => !x.id) ? el('span', { className: 'muted', textContent: '追加したばかりの担当者は、保存したあとに選べます。' }) : null)))));
}
// 画面上部の入力欄は、入力のたびに下書きへ写す（担当者欄などを描き直しても、入力が消えないようにする）
const numOrKeep = (id) => ($(id).value.trim() === '' ? '' : Number($(id).value)); // 空欄なら、いまの値のままにする
function readTopFields() {
  Object.assign(draft.settings, {
    slotMinutes: numOrKeep('setSlot'), windowDays: numOrKeep('setWindow'), minLeadMinutes: numOrKeep('setLead'),
    bufferMinutes: numOrKeep('setBuffer'), maxPerDay: numOrKeep('setMaxPerDay'), loadCap: numOrKeep('setLoadCap'),
    site: { name: $('setName').value, intro: $('setIntro').value, cancelDeadlineHours: numOrKeep('setDeadline') },
    mail: { reminder: $('setReminder').checked, reminderHour: Number($('setReminderHour').value), notifyTo: $('setNotify').value.trim(), riskConfirm: $('setRiskConfirm').checked },
  });
}
['setName', 'setIntro', 'setDeadline', 'setSlot', 'setWindow', 'setLead', 'setBuffer', 'setMaxPerDay', 'setLoadCap', 'setReminder', 'setReminderHour', 'setNotify', 'setRiskConfirm']
  .forEach((id) => $(id).addEventListener('input', () => { readTopFields(); dirty(); }));
$('staffAdd').addEventListener('click', () => {
  draft.staff.push({ id: '', name: '', hours: [null, 1, 1, 1, 1, 1, null].map((x) => (x ? { start: '09:00', end: '18:00' } : null)) });
  dirty(); renderSettings();
});
$('questionAdd').addEventListener('click', () => {
  if (draft.settings.questions.length >= 10) return toast('質問は10件までです。');
  draft.settings.questions.push({ id: '', label: '', type: 'text', options: [], required: false });
  dirty(); renderSettings();
});
$('serviceAdd').addEventListener('click', () => { draft.services.push({ id: '', name: '', minutes: 60, description: '' }); dirty(); renderSettings(); });
$('saveSettings').addEventListener('click', guard(async () => {
  readTopFields();
  for (const st of draft.staff) for (const h of st.hours) if (h && Array.isArray(h.breaks)) h.breaks = h.breaks.filter((x) => x.start || x.end);
  await call('/api/admin/config', 'PUT', draft);
  isDirty = false;
  await refreshConfig();
  draft = JSON.parse(JSON.stringify(state.config));
  renderSettings();
  $('saved').textContent = '保存しました。';
  toast('設定を保存しました。');
}));
$('mailTest').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  await call('/api/admin/mail/test', 'POST', { to: ev.target.to.value });
  toast('テストメールを送信しました。受信箱を確認してください。');
}));

// 特定の日の受付時間（追加・削除はすぐに反映）
function loadOverrides() {
  const f = $('overrideForm');
  f.staffId.replaceChildren(...options(state.config.staff));
  if (!f.date.value) f.date.value = state.config.today;
  const list = state.config.overrides || [];
  $('overrideList').replaceChildren(...(list.length ? list.map((o) => {
    const del = el('button', { className: 'small danger', textContent: '削除' });
    del.addEventListener('click', guard(async () => { await call(`/api/admin/overrides/${o.id}`, 'DELETE'); await refreshConfig(); loadOverrides(); toast('元の受付時間に戻しました。'); }));
    const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const what = o.off ? '休み' : `${hm(o.start)}〜${hm(o.end)}${o.breaks.length ? `（休憩 ${o.breaks.map((x) => `${hm(x.start)}〜${hm(x.end)}`).join('、')}）` : ''}`;
    return el('div', { className: 'rowitem' }, el('span', { className: 'main', textContent: `${jpFull(o.date)}　${staffName(o.staffId)}` }),
      el('span', { className: 'sub', textContent: what + (o.note ? `／${o.note}` : '') }), el('span', { className: 'side' }, del));
  }) : [empty('これからの日付の設定はありません。')]));
}
$('overrideForm').mode.addEventListener('change', (ev) => { $('overrideTimes').hidden = ev.target.value === 'off'; });
$('overrideForm').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = { staffId: f.staffId.value, date: f.date.value, off: f.mode.value === 'off', start: f.start.value, end: f.end.value, note: f.note.value,
    breaks: f.breakStart.value || f.breakEnd.value ? [{ start: f.breakStart.value, end: f.breakEnd.value }] : [] };
  await call('/api/admin/overrides', 'POST', body);
  await refreshConfig();
  loadOverrides();
  toast(`${jp(body.date)}の${staffName(body.staffId)}の受付時間を設定しました。`);
}));

// 休業日（追加・削除はすぐに反映）
$('holidayAdd').addEventListener('click', guard(async () => {
  const r = await call('/api/admin/closed/holidays', 'POST', { year: Number($('holidayYear').value) });
  $('holidayResult').hidden = false;
  $('holidayResult').textContent = `${r.added.length}日を休業日に登録しました。` +
    (r.skipped.length ? ` 登録しなかった日: ${r.skipped.map((h) => `${jp(h.date)} ${h.title}（${h.reason}）`).join('、')}` : '');
  await refreshConfig();
  await loadClosed();
}));
async function loadClosed() {
  if (!$('holidayYear').options.length) {
    const y = Number(state.config.today.slice(0, 4));
    $('holidayYear').replaceChildren(...[y, y + 1].map((v) => el('option', { value: v, textContent: `${v}年` })));
  }
  const list = state.config.closedDays.filter((c) => c.date >= state.config.today);
  $('closedList').replaceChildren(...(list.length ? list.map((c) => {
    const del = el('button', { className: 'small danger', textContent: '削除' });
    del.addEventListener('click', guard(async () => { await call(`/api/admin/closed/${c.date}`, 'DELETE'); await refreshConfig(); await loadClosed(); }));
    return el('div', { className: 'rowitem' }, el('span', { className: 'main', textContent: jpFull(c.date) }), el('span', { className: 'sub', textContent: c.title }), el('span', { className: 'side' }, del));
  }) : [empty('これからの休業日は登録されていません。')]));
}
$('closedForm').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  await call('/api/admin/closed', 'POST', Object.fromEntries(new FormData(ev.target)));
  ev.target.reset();
  await refreshConfig();
  await loadClosed();
  toast('休業日を追加しました。');
}));

// ログイン用アカウント
async function loadUsers() {
  const data = await call('/api/admin/users');
  const rows = [];
  if (data.builtin) {
    rows.push(el('div', { className: 'rowitem' }, el('span', { className: 'main', textContent: '管理者（admin）' }),
      el('span', { className: 'sub', textContent: 'サーバーに設定したパスワード（ADMIN_PASSWORD）でログインします' }), el('span', { className: 'side' }, el('span', { className: 'pill plain', textContent: '管理者' }))));
  }
  for (const u of data.users) {
    const reset = el('button', { className: 'small', textContent: 'パスワード変更' });
    reset.addEventListener('click', guard(async () => {
      const pw = prompt(`${u.name} さんの新しいパスワード（8文字以上）を入力してください。`);
      if (pw == null) return;
      await call(`/api/admin/users/${u.id}/password`, 'PUT', { password: pw });
      toast('パスワードを変更しました。');
    }));
    const del = el('button', { className: 'small danger', textContent: '削除' });
    del.addEventListener('click', guard(async () => {
      if (!confirm(`${u.name} さんのアカウントを削除します。よろしいですか？`)) return;
      await call(`/api/admin/users/${u.id}`, 'DELETE');
      await loadUsers();
    }));
    rows.push(el('div', { className: 'rowitem' }, el('span', { className: 'main', textContent: `${u.name}（${u.loginId}）` }),
      el('span', { className: 'sub' }, el('span', { className: 'pill plain', textContent: ROLE[u.role] })), el('span', { className: 'side row' }, reset, del)));
  }
  $('userList').replaceChildren(...(rows.length ? rows : [empty('アカウントはまだありません。')]));
}
$('userForm').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  await call('/api/admin/users', 'POST', Object.fromEntries(new FormData(ev.target)));
  ev.target.reset();
  toast('アカウントを追加しました。');
  await refreshConfig();
  await loadUsers();
}));

// ---------- 操作履歴 ----------
async function loadAudit() {
  const data = await call('/api/admin/audit');
  $('auditCount').textContent = `全${data.total}件のうち、新しい順に${data.audit.length}件を表示しています（最大2000件まで保存）。`;
  $('auditRows').replaceChildren(...(data.audit.length ? data.audit.map((a) => el('div', { className: 'rowitem' },
    el('span', { className: 'main', textContent: a.action }),
    el('span', { className: 'sub', textContent: a.detail || '—' }),
    el('span', { className: 'side' }, el('span', { textContent: a.user }), el('br'), el('span', { textContent: when(a.at) }))))
    : [empty('操作の記録はまだありません。')]));
}

// ---------- 起動 ----------
async function refreshConfig() {
  state.config = await call('/api/admin/config');
  $('openWarn').hidden = state.config.protected;
  $('me').hidden = !state.config.protected;
  $('who').textContent = state.config.user.name;
  $('me').setAttribute('aria-label', `アカウント: ${state.config.user.name}`);
  $('calStaff').replaceChildren(el('option', { value: '', textContent: '全員の予定' }), ...options(state.config.staff));
  if (!state.config.staff.some((x) => x.id === state.staffFilter)) state.staffFilter = '';
  $('calStaff').value = state.staffFilter;
  if (!isDirty) draft = null; // 編集中でなければ、設定画面は最新の内容から作り直す
}
async function start() {
  const session = await call('/api/admin/session');
  if (!session.loggedIn) return showLogin();
  $('login').hidden = true;
  $('app').hidden = false;
  await refreshConfig();
  buildNav();
  addMonthOptions();
  if (!state.cursor) state.cursor = state.config.today;
  draft = null;
  openTab(state.tab);
  await loadNotes(true);
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const jstToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    if (jstToday !== state.config.today) refreshConfig().then(() => { if (state.tab === 'calendar') loadCalendar(); }).catch(() => {});
    pollNotes();
    if (state.tab === 'calendar' && !document.querySelector('dialog[open]')) loadCalendar().catch(() => {});
  }, 15000);
}
guard(start)();
