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
function toast(text) {
  const t = el('div', { className: 'toast', textContent: text });
  $('toasts').append(t);
  while ($('toasts').children.length > 2) $('toasts').firstChild.remove(); // 画面をふさがないよう2件まで
  setTimeout(() => t.remove(), 6000);
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
  $('week').hidden = $('strip').hidden = month;
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
  weekData = await call(`/api/admin/calendar?from=${from}&to=${to}`);
  drawWeek();
}
function drawWeek() {
  const from = mondayOf(state.cursor);
  const days = [];
  const strip = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const closed = weekData.closedDays.find((c) => c.date === d);
    const items = []
      .concat(weekData.bookings.filter((b) => b.date === d).map((b) => ({ kind: 'booking', ...b })))
      .concat(weekData.blocks.filter((k) => k.date === d).map((k) => ({ kind: 'block', ...k })))
      .filter(visible)
      .sort((a, b) => a.start.localeCompare(b.start));
    const active = items.filter((x) => x.kind === 'booking' && x.status !== 'cancelled').length;
    const isToday = d === state.config.today;
    const box = el('div', { className: 'day' + (isToday ? ' today' : '') + (d === state.cursor ? ' sel' : '') },
      el('h3', null, jp(d), isToday ? el('span', { className: 'tag', textContent: '今日' }) : null,
        closed ? el('span', { className: 'tag closed', textContent: closed.title }) : null));
    if (!items.length) box.append(el('p', { className: 'muted', textContent: closed ? '休業日です' : '予定はありません' }));
    for (const x of items) {
      const isBooking = x.kind === 'booking';
      const btn = el('button', { className: 'item ' + (isBooking ? x.status : 'block') },
        el('b', { textContent: `${x.start}〜${x.end}` }),
        isBooking ? `${x.customerName} 様／${staffName(x.staffId)}` : `${x.recurring ? '毎週・' : ''}${x.title}／${staffName(x.staffId)}`);
      btn.addEventListener('click', () => (isBooking ? openBooking(x) : openBlock(x)));
      box.append(btn);
    }
    days.push(box);
    // スマホ用: 日付を選ぶボタン
    const sb = el('button', { className: isToday ? 'today' : '' }, el('small', { textContent: WD[wd(d)] }),
      el('span', { textContent: String(Number(d.slice(8))) }), el('span', { className: 'cnt', textContent: closed ? '休' : active ? `${active}件` : '' }));
    sb.setAttribute('aria-pressed', String(d === state.cursor));
    sb.setAttribute('aria-label', `${jp(d)} 予約${active}件`);
    sb.addEventListener('click', () => { state.cursor = d; drawWeek(); });
    strip.push(sb);
  }
  $('week').replaceChildren(...days);
  $('strip').replaceChildren(...strip);
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
}
const SOURCE = { web: '予約ページ', admin: '管理画面', import: 'CSV読み込み', sample: 'サンプル' };
function openBooking(b) {
  $('detailTitle').textContent = '予約の詳細';
  summary([['日時', `${jp(b.date)} ${b.start}〜${b.end}`], ['メニュー', serviceName(b.serviceId)], ['担当者', staffName(b.staffId)],
    ['お名前', `${b.customerName} 様`], ['メール', b.email], ['電話', b.phone], ['相談内容', b.note], ['状態', STATUS[b.status]], ['登録元', SOURCE[b.source]]]);
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
$('fab').addEventListener('click', () => openBookingForm(null));
$('bookingForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    if (editing) await call(`/api/admin/bookings/${editing.id}`, 'PATCH', body);
    else await call('/api/admin/bookings', 'POST', body);
    $('bookingDialog').close();
    toast(editing ? '日時を変更しました。' : '予約を登録しました。');
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
async function loadList() {
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
  summary([['メール', c.email], ['電話', c.phone], ['予約回数', `${c.total}回（実施 ${c.completed}／キャンセル ${c.cancelled}／無断 ${c.noshow}）`]]);
  $('detailExtra').hidden = false;
  $('detailExtra').replaceChildren(...c.history.map((h) => el('div', null,
    el('div', { className: 'row' }, el('strong', { textContent: `${jpFull(h.date)} ${h.start}` }), pill(h.status)),
    el('div', { className: 'muted', textContent: `${h.serviceName}／${h.staffName}${h.note ? '／' + h.note : ''}` }))));
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
  const every = Math.ceil(buckets.length / (window.innerWidth < 760 ? 5 : 9)); // ラベルが重ならないよう間引く
  $('trendTitle').textContent = `予約件数の推移（${a.trend.unit}ごと）`;
  $('trend').replaceChildren(...buckets.map((b, i) => el('div', { className: 'col', title: `${b.label}〜: 実施・予約中 ${b.active}件／キャンセル ${b.cancelled}件` },
    el('div', { textContent: buckets.length <= 14 ? String(b.active + b.cancelled) : '' }),
    el('div', { className: 'area' },
      el('div', { className: 'c', style: `height:${(b.cancelled / max) * 100}%` }),
      el('div', { className: 'a', style: `height:${(b.active / max) * 100}%` })),
    el('div', { className: 'lab', textContent: i % every === 0 ? b.label : '' }))));
  $('trend').setAttribute('role', 'img');
  $('trend').setAttribute('aria-label', `${a.trend.unit}ごとの予約件数。` + buckets.map((b) => `${b.label} ${b.active + b.cancelled}件`).join('、'));

  const tags = { warn: '要対応', idea: '提案', info: '注意', good: '良好' };
  $('suggestions').replaceChildren(...(a.suggestions.length ? a.suggestions.map((s) => el('div', { className: 'card sug ' + s.level },
    el('div', { className: 'head' }, el('span', { className: 'rank', textContent: `優先度 ${s.priority}` }), el('span', { className: 'kind', textContent: tags[s.level] })),
    el('h3', { textContent: s.title }),
    el('p', { className: 'muted', textContent: '根拠: ' + s.evidence }), el('p', { textContent: s.action }),
    s.impact ? el('p', { className: 'impact', textContent: s.impact.text }) : null))
    : [empty('改善案を出すためのデータがまだありません。')]));
  bars('chartWeekday', a.byWeekday.filter((w) => w.capacity > 0).map((w) => ({ label: w.label + '曜', value: w.utilization, count: w.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartHour', a.byHour.map((h) => ({ label: h.label, value: h.count })), (r) => `${r.value}件`);
  bars('chartStaff', a.byStaff.map((s) => ({ label: s.label, value: s.utilization, count: s.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartService', a.byService.map((s) => ({ label: s.label, value: s.count })), (r) => `${r.value}件`);

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
const dirty = () => { $('saved').textContent = '変更があります。「設定を保存する」を押すと反映されます。'; };
async function loadSettings() {
  if (!draft) draft = JSON.parse(JSON.stringify(state.config));
  renderSettings();
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
  $('setReminder').checked = st.mail.reminder;
  $('setReminderHour').replaceChildren(...Array.from({ length: 24 }, (_, h) => el('option', { value: h, textContent: `${h}時` })));
  $('setReminderHour').value = st.mail.reminderHour;
  const mail = state.config.mail;
  $('mailStatus').className = 'msg ' + (mail.enabled ? 'ok' : 'info');
  $('mailStatus').textContent = mail.enabled
    ? `メール送信は有効です（差出人: ${mail.from}）。予約・変更・キャンセルのときに、お客様へ自動でメールを送ります。` +
      (mail.hasPublicUrl ? '' : ' ※ PUBLIC_URL が未設定のため、メールに予約確認ページのリンクは入りません。')
    : 'メール送信は、まだ設定されていません。サーバーに SMTP の設定（README の「メールを送る設定」）を入れると有効になります。';

  // 担当者: 曜日ごとの受付時間と休憩
  $('staffList').replaceChildren(...draft.staff.map((s, i) => {
    const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const row = el('div', { className: 'h' });
      const draw = () => {
        const h = s.hours[d];
        const time = (key, label) => {
          const t = input({ type: 'time', value: h ? h[key] || '' : '', disabled: !h }, (x) => { s.hours[d][key] = x.value; });
          t.setAttribute('aria-label', `${WD[d]}曜の${label}`);
          return t;
        };
        const on = el('input', { type: 'checkbox', checked: Boolean(h) });
        on.addEventListener('change', () => { s.hours[d] = on.checked ? { start: '09:00', end: '18:00' } : null; dirty(); draw(); });
        row.className = 'h' + (h ? '' : ' off');
        row.replaceChildren(el('label', { className: 'check' }, on, `${WD[d]}曜`),
          time('start', '開始'), time('end', '終了'), el('span', { className: 'rest', textContent: '休憩' }), time('breakStart', '休憩開始'), time('breakEnd', '休憩終了'));
      };
      draw();
      return row;
    });
    const copy = el('button', { className: 'small', textContent: '月曜の時間を平日すべてにコピー' });
    copy.addEventListener('click', () => {
      for (const d of [2, 3, 4, 5]) s.hours[d] = s.hours[1] ? { ...s.hours[1] } : null;
      dirty(); renderSettings();
    });
    return el('div', { className: 'stack-s', style: 'border-top:1px solid var(--line);padding-top:14px' },
      el('div', { className: 'row' },
        el('label', { className: 'grow' }, '名前', input({ value: s.name, maxLength: 40 }, (x) => { s.name = x.value; })),
        el('div', { style: 'align-self:end' }, remove(draft.staff, i, s.name || '担当者'))),
      el('div', { className: 'hours-head', textContent: '受付する曜日／開始〜終了／休憩（任意）' }),
      el('div', { className: 'hours' }, ...rows), copy);
  }));
  $('serviceList').replaceChildren(...draft.services.map((v, i) => el('div', { className: 'stack-s', style: 'border-top:1px solid var(--line);padding-top:14px' },
    el('div', { className: 'row' },
      el('label', { className: 'grow' }, 'メニュー名', input({ value: v.name, maxLength: 40 }, (x) => { v.name = x.value; })),
      el('label', { style: 'width:7.5em' }, '所要時間（分）', input({ type: 'number', inputMode: 'numeric', min: 5, max: 480, step: 5, value: v.minutes }, (x) => { v.minutes = Number(x.value); })),
      el('div', { style: 'align-self:end' }, remove(draft.services, i, v.name || 'メニュー'))),
    el('label', null, '説明（任意。予約ページに表示されます）', input({ value: v.description || '', maxLength: 200 }, (x) => { v.description = x.value; })))));
}
// 画面上部の入力欄は、入力のたびに下書きへ写す（担当者欄などを描き直しても、入力が消えないようにする）
function readTopFields() {
  Object.assign(draft.settings, {
    slotMinutes: Number($('setSlot').value), windowDays: Number($('setWindow').value), minLeadMinutes: Number($('setLead').value),
    site: { name: $('setName').value, intro: $('setIntro').value, cancelDeadlineHours: Number($('setDeadline').value) },
    mail: { reminder: $('setReminder').checked, reminderHour: Number($('setReminderHour').value) },
  });
}
['setName', 'setIntro', 'setDeadline', 'setSlot', 'setWindow', 'setLead', 'setReminder', 'setReminderHour']
  .forEach((id) => $(id).addEventListener('input', () => { readTopFields(); dirty(); }));
$('staffAdd').addEventListener('click', () => {
  draft.staff.push({ id: '', name: '', hours: [null, 1, 1, 1, 1, 1, null].map((x) => (x ? { start: '09:00', end: '18:00' } : null)) });
  dirty(); renderSettings();
});
$('serviceAdd').addEventListener('click', () => { draft.services.push({ id: '', name: '', minutes: 60, description: '' }); dirty(); renderSettings(); });
$('saveSettings').addEventListener('click', guard(async () => {
  readTopFields();
  await call('/api/admin/config', 'PUT', draft);
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

// 休業日（追加・削除はすぐに反映）
async function loadClosed() {
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
  $('logout').hidden = !state.config.protected;
  $('who').textContent = state.config.protected ? `${state.config.user.name}（${ROLE[state.config.user.role]}）` : '';
  $('calStaff').replaceChildren(el('option', { value: '', textContent: '全員の予定' }), ...options(state.config.staff));
  $('calStaff').value = state.staffFilter;
}
async function start() {
  const session = await call('/api/admin/session');
  if (!session.loggedIn) return showLogin();
  $('login').hidden = true;
  $('app').hidden = false;
  await refreshConfig();
  buildNav();
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
