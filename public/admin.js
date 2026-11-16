'use strict';
// 管理画面（カレンダー・予約一覧・顧客・通知・分析・データ・設定）
const $ = (id) => document.getElementById(id);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS = { booked: '予約済', completed: '完了', noshow: '無断キャンセル', cancelled: 'キャンセル' };
const state = { config: null, cursor: null, view: 'week', staffFilter: '', seenNotes: null, tab: 'calendar', timer: null };

const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const wd = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const jp = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}（${WD[wd(s)]}）`;
const pct = (v) => Math.round(v * 100) + '%';
const mondayOf = (date) => addDays(date, -((wd(date) + 6) % 7));
const shiftMonth = (date, n) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 10);
const staffName = (id) => (state.config.staff.find((s) => s.id === id) || { name: '（削除済み）' }).name;
const serviceName = (id) => (state.config.services.find((s) => s.id === id) || { name: '（削除済み）' }).name;
function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  node.append(...children.filter((c) => c != null));
  return node;
}

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
function toast(text) {
  const t = el('div', { className: 'toast', textContent: text });
  $('toasts').append(t);
  while ($('toasts').children.length > 2) $('toasts').firstChild.remove(); // 画面をふさがないよう2件まで
  setTimeout(() => t.remove(), 6000);
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- ログイン ----------
function showLogin() {
  clearInterval(state.timer);
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('app').hidden = true;
  $('login').hidden = false;
  $('loginForm').password.focus();
}
$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('loginError').hidden = true;
  try {
    await call('/api/admin/login', 'POST', { password: ev.target.password.value });
    ev.target.reset();
    await start();
  } catch (e) {
    $('loginError').textContent = e.message;
    $('loginError').hidden = false;
  }
});
$('logout').addEventListener('click', async () => {
  await call('/api/admin/logout', 'POST').catch(() => {});
  showLogin();
});

// ---------- タブ ----------
const loaders = { calendar: loadCalendar, list: loadList, customers: loadCustomers, notes: () => loadNotes(false), analytics: loadAnalytics, import: () => {}, settings: renderSettings };
function openTab(name) {
  state.tab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  Object.keys(loaders).forEach((t) => { $('tab-' + t).hidden = t !== name; });
  guard(loaders[name])();
}
const refresh = () => loaders[state.tab]();
$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (b) openTab(b.dataset.tab);
});

// ---------- カレンダー ----------
async function loadCalendar() {
  const month = state.view === 'month';
  $('week').hidden = month;
  $('month').hidden = !month;
  $('viewWeek').classList.toggle('on', !month);
  $('viewMonth').classList.toggle('on', month);
  return month ? loadMonth() : loadWeek();
}
const visible = (x) => !state.staffFilter || x.staffId === state.staffFilter;
async function loadWeek() {
  const from = mondayOf(state.cursor);
  const to = addDays(from, 6);
  $('calRange').textContent = `${jp(from)}〜${jp(to)}`;
  const data = await call(`/api/admin/calendar?from=${from}&to=${to}`);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const items = []
      .concat(data.bookings.filter((b) => b.date === d).map((b) => ({ kind: 'booking', ...b })))
      .concat(data.blocks.filter((k) => k.date === d).map((k) => ({ kind: 'block', ...k })))
      .filter(visible)
      .sort((a, b) => a.start.localeCompare(b.start));
    const box = el('div', { className: 'day' + (d === state.config.today ? ' today' : '') }, el('h3', { textContent: jp(d) + (d === state.config.today ? ' 今日' : '') }));
    if (!items.length) box.append(el('p', { className: 'muted', textContent: '予定なし' }));
    for (const x of items) {
      const isBooking = x.kind === 'booking';
      const btn = el('button', { className: 'item ' + (isBooking ? x.status : 'block') },
        el('b', { textContent: `${x.start}〜${x.end}` }),
        isBooking ? `${x.customerName} 様／${staffName(x.staffId)}` : `${x.title}／${staffName(x.staffId)}`);
      btn.addEventListener('click', () => (isBooking ? openBooking(x) : openBlock(x)));
      box.append(btn);
    }
    days.push(box);
  }
  $('week').replaceChildren(...days);
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
    const btn = el('button', { className: (d === state.config.today ? 'today ' : '') + (d < first || d > last ? 'other' : '') },
      el('span', { className: 'num', textContent: String(Number(d.slice(8))) }),
      bookings ? el('span', { className: 'chip' }, el('span', { className: 'long', textContent: '予約 ' }), `${bookings}件`) : null,
      blocks ? el('span', { className: 'chip block' }, el('span', { className: 'long', textContent: '予定 ' }), `${blocks}件`) : null);
    btn.setAttribute('aria-label', `${jp(d)} 予約${bookings}件 予定${blocks}件`);
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
}
const SOURCE = { web: '予約ページ', admin: '管理画面', import: 'CSV読み込み', sample: 'サンプル' };
function openBooking(b) {
  $('detailTitle').textContent = '予約の詳細';
  summary([['日時', `${jp(b.date)} ${b.start}〜${b.end}`], ['メニュー', serviceName(b.serviceId)], ['担当者', staffName(b.staffId)],
    ['お名前', `${b.customerName} 様`], ['メール', b.email], ['電話', b.phone], ['相談内容', b.note], ['状態', STATUS[b.status]], ['登録元', SOURCE[b.source]]]);
  const actions = Object.keys(STATUS).filter((s) => s !== b.status).map((s) => {
    const btn = el('button', { className: 'small' + (s === 'cancelled' ? ' danger' : ''), textContent: `「${STATUS[s]}」にする` });
    btn.addEventListener('click', guard(async () => {
      $('detail').close();
      await call(`/api/admin/bookings/${b.id}`, 'PATCH', { status: s });
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
  $('detailTitle').textContent = '予定の詳細';
  summary([['日時', `${jp(k.date)} ${k.start}〜${k.end}`], ['内容', k.title], ['担当者', staffName(k.staffId)]]);
  const del = el('button', { className: 'small danger', textContent: 'この予定を削除する' });
  del.addEventListener('click', guard(async () => {
    $('detail').close();
    await call(`/api/admin/blocks/${k.id}`, 'DELETE');
    await refresh();
  }));
  $('detailActions').replaceChildren(del);
  $('detail').showModal();
}
$('detailClose').addEventListener('click', () => $('detail').close());

// ---------- 予約の追加・日時変更 ----------
const options = (list) => list.map((s) => el('option', { value: s.id, textContent: s.name }));
let editing = null;
function openBookingForm(booking) {
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
    f.date.value = state.cursor;
    f.start.value = '10:00';
  }
  $('bookingError').hidden = true;
  $('bookingDialog').showModal();
}
$('addBooking').addEventListener('click', () => openBookingForm(null));
$('bookingForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    if (editing) await call(`/api/admin/bookings/${editing.id}`, 'PATCH', body);
    else await call('/api/admin/bookings', 'POST', body);
    $('bookingDialog').close();
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
  f.staffId.replaceChildren(...options(state.config.staff));
  if (state.staffFilter) f.staffId.value = state.staffFilter;
  f.date.value = state.cursor;
  $('blockError').hidden = true;
  $('blockDialog').showModal();
});
$('blockForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await call('/api/admin/blocks', 'POST', Object.fromEntries(new FormData(ev.target)));
    $('blockDialog').close();
    await loadCalendar();
  } catch (e) {
    $('blockError').textContent = e.message;
    $('blockError').hidden = false;
  }
});

// ---------- 予約一覧 ----------
const pill = (status) => el('span', { className: 'pill ' + status, textContent: STATUS[status] });
const query = (form) => new URLSearchParams([...new FormData(form)].filter(([, v]) => v)).toString();
async function loadList() {
  const data = await call('/api/admin/bookings?' + query($('listForm')));
  $('listCount').textContent = data.total > data.bookings.length
    ? `${data.total}件のうち、新しい順に${data.bookings.length}件を表示しています。条件を絞り込んでください。`
    : `${data.total}件`;
  $('listTable').replaceChildren(
    el('tr', null, ...['日付', '時刻', 'お名前', 'メニュー', '担当者', '状態'].map((h) => el('th', { textContent: h }))),
    ...data.bookings.map((b) => {
      const tr = el('tr', { className: 'click', tabIndex: 0 },
        el('td', { textContent: `${b.date.slice(0, 4)}/${jp(b.date)}` }), el('td', { textContent: `${b.start}〜${b.end}` }),
        el('td', { textContent: b.customerName }), el('td', { textContent: serviceName(b.serviceId) }),
        el('td', { textContent: staffName(b.staffId) }), el('td', null, pill(b.status)));
      tr.addEventListener('click', () => openBooking(b));
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openBooking(b); });
      return tr;
    }));
  if (!data.bookings.length) $('listTable').append(el('tr', null, el('td', { colSpan: 6, className: 'muted', textContent: '条件に合う予約はありません。' })));
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
  const day = (d) => (d ? `${d.slice(0, 4)}/${jp(d)}` : '—');
  $('custTable').replaceChildren(
    el('tr', null, ...['お名前', 'メール', '予約', '実施', 'キャンセル', '無断', '最後の来談', '次回の予約'].map((h) => el('th', { textContent: h }))),
    ...data.customers.map((c) => {
      const tr = el('tr', { className: 'click', tabIndex: 0 },
        el('td', { textContent: c.name }), el('td', { textContent: c.email || '—' }),
        ...[c.total, c.completed, c.cancelled, c.noshow].map((n) => el('td', { textContent: `${n}回` })),
        el('td', { textContent: day(c.last) }), el('td', { textContent: day(c.next) }));
      const open = () => openCustomer(c);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
      return tr;
    }));
  if (!data.customers.length) $('custTable').append(el('tr', null, el('td', { colSpan: 8, className: 'muted', textContent: '条件に合うお客様はいません。' })));
}
function openCustomer(c) {
  $('detailTitle').textContent = `${c.name} 様`;
  summary([['メール', c.email], ['電話', c.phone], ['予約回数', `${c.total}回（実施 ${c.completed}／キャンセル ${c.cancelled}／無断 ${c.noshow}）`]]);
  $('detailExtra').hidden = false;
  $('detailExtra').replaceChildren(...c.history.map((h) => el('div', null,
    el('div', { className: 'row' }, el('strong', { textContent: `${h.date.slice(0, 4)}/${jp(h.date)} ${h.start}` }), pill(h.status)),
    el('div', { className: 'muted', textContent: `${h.serviceName}／${h.staffName}${h.note ? '／' + h.note : ''}` }))));
  $('detailActions').replaceChildren();
  $('detail').showModal();
}
$('custForm').addEventListener('submit', guard((ev) => { ev.preventDefault(); return loadCustomers(); }));

// ---------- 通知 ----------
function when(iso) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function loadNotes(silent) {
  const data = await call('/api/admin/notifications');
  $('unread').textContent = data.unread;
  $('unread').hidden = !data.unread;
  // 前回の確認以降に届いた通知を、画面右下にも表示する
  const ids = new Set(data.notifications.map((n) => n.id));
  if (state.seenNotes) {
    data.notifications.filter((n) => !state.seenNotes.has(n.id)).slice(0, 3).reverse()
      .forEach((n) => toast(`${n.title}: ${n.body}`));
  }
  state.seenNotes = ids;
  if (silent && $('tab-notes').hidden) return;
  $('notes').replaceChildren(...(data.notifications.length
    ? data.notifications.map((n) => el('div', { className: 'note' + (n.read ? '' : ' unread') },
      el('h3', { textContent: n.title }), el('p', { textContent: n.body }), el('p', { className: 'muted', textContent: when(n.createdAt) })))
    : [el('p', { className: 'muted', textContent: '通知はまだありません。予約が入ったときや、データを読み込んだときにここへ届きます。' })]));
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
// 前の期間との差を「+3件」「-2pt」のように表す
function versus(cur, prev, kind, hasPrev) {
  if (!hasPrev || prev == null || cur == null) return '前の期間: データなし';
  const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);
  if (kind === 'rate') return `前の期間 ${pct(prev)}（${sign(Math.round(cur * 100) - Math.round(prev * 100))}pt）`;
  if (kind === 'days') return `前の期間 ${prev.toFixed(1)}日（${sign(Number((cur - prev).toFixed(1)))}日）`;
  return `前の期間 ${prev}件（${sign(cur - prev)}件）`;
}
let rulesInfo = null;
async function loadAnalytics() {
  const a = await call(`/api/admin/analytics?days=${$('days').value}`);
  const t = a.totals;
  const p = a.previous.totals;
  const has = p.total > 0;
  $('periodNote').textContent = `集計期間 ${a.period.from}〜${a.period.to}。比較している「前の期間」は ${a.previous.period.from}〜${a.previous.period.to} です。`;
  const kpi = (label, value, ...subs) => el('div', { className: 'card kpi' }, el('span', { className: 'muted', textContent: label }),
    el('b', { textContent: value }), ...subs.map((s) => el('span', { className: 'muted', style: 'display:block', textContent: s })));
  $('kpis').replaceChildren(
    kpi('予約件数', `${t.total}件`, versus(t.total, p.total, 'count', has)),
    kpi('稼働率', pct(t.utilization), versus(t.utilization, p.utilization, 'rate', has)),
    kpi('キャンセル率', pct(t.cancelRate), versus(t.cancelRate, p.cancelRate, 'rate', has)),
    kpi('無断キャンセル率', pct(t.noshowRate), versus(t.noshowRate, p.noshowRate, 'rate', has)),
    kpi('平均リードタイム', t.avgLeadDays == null ? '—' : `${t.avgLeadDays.toFixed(1)}日`, versus(t.avgLeadDays, p.avgLeadDays, 'days', has)),
    kpi('リピート率', t.customers ? pct(t.repeatRate) : '—', versus(t.repeatRate, p.repeatRate, 'rate', has && p.customers > 0)));

  // 推移グラフ（積み上げ棒）
  const buckets = a.trend.buckets;
  const max = Math.max(1, ...buckets.map((b) => b.active + b.cancelled));
  const every = Math.ceil(buckets.length / 9); // ラベルが重ならないよう間引く
  $('trendTitle').textContent = `予約件数の推移（${a.trend.unit}ごと）`;
  $('trend').replaceChildren(...buckets.map((b, i) => {
    const col = el('div', { className: 'col', title: `${b.label}〜: 実施・予約中 ${b.active}件／キャンセル ${b.cancelled}件` },
      el('div', { textContent: buckets.length <= 14 ? String(b.active + b.cancelled) : '' }),
      el('div', { className: 'area' },
        el('div', { className: 'c', style: `height:${(b.cancelled / max) * 100}%` }),
        el('div', { className: 'a', style: `height:${(b.active / max) * 100}%` })),
      el('div', { className: 'lab', textContent: i % every === 0 ? b.label : '' }));
    return col;
  }));
  $('trend').setAttribute('role', 'img');
  $('trend').setAttribute('aria-label', `${a.trend.unit}ごとの予約件数。` + buckets.map((b) => `${b.label} ${b.active + b.cancelled}件`).join('、'));

  const tags = { warn: '要対応', idea: '提案', info: '注意', good: '良好' };
  $('suggestions').replaceChildren(...(a.suggestions.length ? a.suggestions.map((s) => el('div', { className: 'card sug ' + s.level },
    el('div', { className: 'head' }, el('span', { className: 'rank', textContent: `優先度 ${s.priority}` }), el('span', { className: 'tag', textContent: tags[s.level] })),
    el('h3', { textContent: s.title }),
    el('p', { className: 'muted', textContent: '根拠: ' + s.evidence }), el('p', { textContent: s.action }),
    s.impact ? el('p', { className: 'impact', textContent: s.impact.text }) : null))
    : [el('p', { className: 'muted', textContent: '改善案を出すためのデータがまだありません。' })]));
  bars('chartWeekday', a.byWeekday.filter((w) => w.capacity > 0).map((w) => ({ label: w.label + '曜', value: w.utilization, count: w.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartHour', a.byHour.map((h) => ({ label: h.label, value: h.count })), (r) => `${r.value}件`);
  bars('chartStaff', a.byStaff.map((s) => ({ label: s.label, value: s.utilization, count: s.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartService', a.byService.map((s) => ({ label: s.label, value: s.count })), (r) => `${r.value}件`);

  // 目安の数値の入力欄（割合は % に直して表示する）
  rulesInfo = a.ruleMeta;
  $('rules').replaceChildren(...a.ruleMeta.map((m) => {
    const isRate = m.unit === '%';
    const input = el('input', { type: 'number', name: m.key, step: 'any', min: isRate ? m.min * 100 : m.min, max: isRate ? m.max * 100 : m.max,
      value: isRate ? Math.round(a.rules[m.key] * 1000) / 10 : a.rules[m.key] });
    const def = isRate ? Math.round(a.ruleDefaults[m.key] * 100) : a.ruleDefaults[m.key];
    return el('label', null, `${m.label}（${m.unit}）`, input, el('span', { className: 'muted', style: 'font-weight:400', textContent: `初期値 ${def}${m.unit}` }));
  }));
}
$('days').addEventListener('change', guard(loadAnalytics));
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
  $('csvResult').textContent = `${r.imported}件を取り込みました（スキップ ${r.skipped.length}件）。分析タブで結果を確認できます。`;
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
function renderSettings() {
  if (!draft) draft = JSON.parse(JSON.stringify(state.config));
  const input = (props, onInput) => { const i = el('input', props); i.addEventListener('input', () => onInput(i)); return i; };
  const remove = (list, i) => { const b = el('button', { className: 'small danger', textContent: '削除' }); b.addEventListener('click', () => { list.splice(i, 1); renderSettings(); }); return b; };
  $('staffTable').replaceChildren(
    el('tr', null, ...['名前', '受付する曜日', '開始', '終了', ''].map((h) => el('th', { textContent: h }))),
    ...draft.staff.map((s, i) => {
      const first = s.hours.find(Boolean) || { start: '09:00', end: '18:00' };
      const setTime = (key, v) => { s.hours = s.hours.map((h) => (h ? { ...h, [key]: v } : null)); };
      return el('tr', null,
        el('td', null, input({ value: s.name, maxLength: 40, ariaLabel: '担当者名' }, (x) => { s.name = x.value; })),
        el('td', null, ...WD.map((w, d) => {
          const c = input({ type: 'checkbox', checked: Boolean(s.hours[d]) }, (x) => {
            const cur = s.hours.find(Boolean) || first;
            s.hours[d] = x.checked ? { start: cur.start, end: cur.end } : null;
          });
          return el('label', { style: 'display:inline-block;font-weight:400;margin-right:8px;white-space:nowrap' }, c, w);
        })),
        el('td', null, input({ type: 'time', value: first.start, ariaLabel: '開始時刻' }, (x) => setTime('start', x.value))),
        el('td', null, input({ type: 'time', value: first.end, ariaLabel: '終了時刻' }, (x) => setTime('end', x.value))),
        el('td', null, remove(draft.staff, i)));
    }));
  $('serviceTable').replaceChildren(
    el('tr', null, ...['メニュー名', '所要時間（分）', ''].map((h) => el('th', { textContent: h }))),
    ...draft.services.map((v, i) => el('tr', null,
      el('td', null, input({ value: v.name, maxLength: 40, ariaLabel: 'メニュー名' }, (x) => { v.name = x.value; })),
      el('td', null, input({ type: 'number', min: 5, max: 480, step: 5, value: v.minutes, ariaLabel: '所要時間' }, (x) => { v.minutes = Number(x.value); })),
      el('td', null, remove(draft.services, i)))));
  $('setSlot').value = draft.settings.slotMinutes;
  $('setWindow').value = draft.settings.windowDays;
  $('setLead').value = draft.settings.minLeadMinutes;
}
$('staffAdd').addEventListener('click', () => {
  draft.staff.push({ id: '', name: '', hours: [null, 1, 1, 1, 1, 1, null].map((x) => (x ? { start: '09:00', end: '18:00' } : null)) });
  renderSettings();
});
$('serviceAdd').addEventListener('click', () => { draft.services.push({ id: '', name: '', minutes: 60 }); renderSettings(); });
$('saveSettings').addEventListener('click', guard(async () => {
  $('saved').textContent = '';
  draft.settings = { slotMinutes: Number($('setSlot').value), windowDays: Number($('setWindow').value), minLeadMinutes: Number($('setLead').value) };
  await call('/api/admin/config', 'PUT', draft);
  await refreshConfig();
  draft = null;
  renderSettings();
  $('saved').textContent = '保存しました。';
}));

// ---------- 起動 ----------
async function refreshConfig() {
  state.config = await call('/api/admin/config');
  $('openWarn').hidden = state.config.protected;
  $('logout').hidden = !state.config.protected;
  $('calStaff').replaceChildren(el('option', { value: '', textContent: '全員の予定' }), ...options(state.config.staff));
  $('calStaff').value = state.staffFilter;
}
async function start() {
  const session = await call('/api/admin/session');
  if (!session.loggedIn) return showLogin();
  $('login').hidden = true;
  $('app').hidden = false;
  await refreshConfig();
  if (!state.cursor) state.cursor = state.config.today;
  draft = null;
  openTab(state.tab);
  await loadNotes(true);
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    pollNotes();
    if (state.tab === 'calendar' && !document.querySelector('dialog[open]')) loadCalendar().catch(() => {});
  }, 15000);
}
guard(start)();
