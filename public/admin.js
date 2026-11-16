'use strict';
// 管理画面（カレンダー・通知・分析・データ読み込み・設定）
const $ = (id) => document.getElementById(id);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS = { booked: '予約済', completed: '完了', noshow: '無断キャンセル', cancelled: 'キャンセル' };
const state = { config: null, weekStart: null, staffFilter: '', seenNotes: null };

const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const wd = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const jp = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}（${WD[wd(s)]}）`;
const pct = (v) => Math.round(v * 100) + '%';
function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  node.append(...children.filter((c) => c != null));
  return node;
}

async function call(path, method, body) {
  for (;;) {
    const res = await fetch(path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': sessionStorage.getItem('adminPassword') || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      const pw = prompt('管理用パスワードを入力してください');
      if (pw == null) throw new Error('パスワードが必要です。ページを再読み込みして入力してください。');
      sessionStorage.setItem('adminPassword', pw);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '通信に失敗しました。');
    return data;
  }
}
function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}
const guard = (fn) => async (...args) => {
  try { showError(''); await fn(...args); } catch (e) { showError(e.message); }
};
function toast(text) {
  const t = el('div', { className: 'toast', textContent: text });
  $('toasts').append(t);
  setTimeout(() => t.remove(), 7000);
}

// ---------- タブ ----------
const loaders = { calendar: loadCalendar, notes: () => loadNotes(false), analytics: loadAnalytics, import: () => {}, settings: renderSettings };
function openTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  Object.keys(loaders).forEach((t) => { $('tab-' + t).hidden = t !== name; });
  guard(loaders[name])();
}
$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (b) openTab(b.dataset.tab);
});

// ---------- カレンダー ----------
function mondayOf(date) { return addDays(date, -((wd(date) + 6) % 7)); }
async function loadCalendar() {
  const from = state.weekStart;
  const to = addDays(from, 6);
  $('calRange').textContent = `${jp(from)}〜${jp(to)}`;
  const data = await call(`/api/admin/calendar?from=${from}&to=${to}`);
  const staffName = (id) => (state.config.staff.find((s) => s.id === id) || { name: '（削除済み）' }).name;
  const serviceName = (id) => (state.config.services.find((s) => s.id === id) || { name: '（削除済み）' }).name;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const items = []
      .concat(data.bookings.filter((b) => b.date === d).map((b) => ({ kind: 'booking', ...b })))
      .concat(data.blocks.filter((k) => k.date === d).map((k) => ({ kind: 'block', ...k })))
      .filter((x) => !state.staffFilter || x.staffId === state.staffFilter)
      .sort((a, b) => a.start.localeCompare(b.start));
    const box = el('div', { className: 'day' + (d === state.config.today ? ' today' : '') }, el('h3', { textContent: jp(d) }));
    if (!items.length) box.append(el('p', { className: 'muted', textContent: '予定なし' }));
    for (const x of items) {
      const isBooking = x.kind === 'booking';
      const btn = el('button', { className: 'item ' + (isBooking ? x.status : 'block') },
        el('b', { textContent: `${x.start}〜${x.end}` }),
        isBooking ? `${x.customerName} 様／${staffName(x.staffId)}` : `${x.title}／${staffName(x.staffId)}`);
      btn.addEventListener('click', () => (isBooking ? openBooking(x, staffName, serviceName) : openBlock(x, staffName)));
      box.append(btn);
    }
    days.push(box);
  }
  $('week').replaceChildren(...days);
}
function summary(rows) {
  $('detailBody').replaceChildren(...rows.filter((r) => r[1]).flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
}
function openBooking(b, staffName, serviceName) {
  $('detailTitle').textContent = '予約の詳細';
  summary([['日時', `${jp(b.date)} ${b.start}〜${b.end}`], ['メニュー', serviceName(b.serviceId)], ['担当者', staffName(b.staffId)],
    ['お名前', `${b.customerName} 様`], ['メール', b.email], ['電話', b.phone], ['相談内容', b.note], ['状態', STATUS[b.status]]]);
  $('detailActions').replaceChildren(...Object.keys(STATUS).filter((s) => s !== b.status).map((s) => {
    const btn = el('button', { className: 'small' + (s === 'cancelled' ? ' danger' : ''), textContent: `「${STATUS[s]}」にする` });
    btn.addEventListener('click', guard(async () => {
      $('detail').close();
      await call(`/api/admin/bookings/${b.id}`, 'PATCH', { status: s });
      await loadCalendar();
      pollNotes();
    }));
    return btn;
  }));
  $('detail').showModal();
}
function openBlock(k, staffName) {
  $('detailTitle').textContent = '予定の詳細';
  summary([['日時', `${jp(k.date)} ${k.start}〜${k.end}`], ['内容', k.title], ['担当者', staffName(k.staffId)]]);
  const del = el('button', { className: 'small danger', textContent: 'この予定を削除する' });
  del.addEventListener('click', guard(async () => {
    $('detail').close();
    await call(`/api/admin/blocks/${k.id}`, 'DELETE');
    await loadCalendar();
  }));
  $('detailActions').replaceChildren(del);
  $('detail').showModal();
}
$('detailClose').addEventListener('click', () => $('detail').close());
$('calPrev').addEventListener('click', guard(() => { state.weekStart = addDays(state.weekStart, -7); return loadCalendar(); }));
$('calNext').addEventListener('click', guard(() => { state.weekStart = addDays(state.weekStart, 7); return loadCalendar(); }));
$('calToday').addEventListener('click', guard(() => { state.weekStart = mondayOf(state.config.today); return loadCalendar(); }));
$('calStaff').addEventListener('change', guard((ev) => { state.staffFilter = ev.target.value; return loadCalendar(); }));

$('addBlock').addEventListener('click', () => {
  const f = $('blockForm');
  f.staffId.replaceChildren(...state.config.staff.map((s) => el('option', { value: s.id, textContent: s.name })));
  if (state.staffFilter) f.staffId.value = state.staffFilter;
  f.date.value = state.config.today >= state.weekStart && state.config.today <= addDays(state.weekStart, 6) ? state.config.today : state.weekStart;
  $('blockError').hidden = true;
  $('blockDialog').showModal();
});
$('blockCancel').addEventListener('click', () => $('blockDialog').close());
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
async function loadAnalytics() {
  const a = await call(`/api/admin/analytics?days=${$('days').value}`);
  const t = a.totals;
  const kpi = (label, value, sub) => el('div', { className: 'card kpi' }, el('span', { className: 'muted', textContent: label }), el('b', { textContent: value }), el('span', { className: 'muted', textContent: sub || '' }));
  $('kpis').replaceChildren(
    kpi('予約件数', `${t.total}件`, `実施 ${t.completed}／予約中 ${t.upcoming}`),
    kpi('稼働率', pct(t.utilization), '受付可能時間に対する割合'),
    kpi('キャンセル率', pct(t.cancelRate), `${t.cancelled}件`),
    kpi('無断キャンセル率', pct(t.noshowRate), `${t.noshow}件`),
    kpi('平均リードタイム', t.avgLeadDays == null ? '—' : `${t.avgLeadDays.toFixed(1)}日`, '申し込みから面談日まで'),
    kpi('リピート率', t.customers ? pct(t.repeatRate) : '—', `顧客 ${t.customers}人`));
  const tags = { warn: '要対応', idea: '提案', info: '注意', good: '良好' };
  $('suggestions').replaceChildren(...(a.suggestions.length ? a.suggestions.map((s) => el('div', { className: 'card sug ' + s.level },
    el('span', { className: 'tag', textContent: tags[s.level] }), el('h3', { textContent: s.title }),
    el('p', { className: 'muted', textContent: '根拠: ' + s.evidence }), el('p', { textContent: s.action })))
    : [el('p', { className: 'muted', textContent: '改善案を出すためのデータがまだありません。' })]));
  bars('chartWeekday', a.byWeekday.filter((w) => w.capacity > 0).map((w) => ({ label: w.label + '曜', value: w.utilization, count: w.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartHour', a.byHour.map((h) => ({ label: h.label, value: h.count })), (r) => `${r.value}件`);
  bars('chartStaff', a.byStaff.map((s) => ({ label: s.label, value: s.utilization, count: s.count })), (r) => `${pct(r.value)}・${r.count}件`);
  bars('chartService', a.byService.map((s) => ({ label: s.label, value: s.count })), (r) => `${r.value}件`);
}
$('days').addEventListener('change', guard(loadAnalytics));

// ---------- データ読み込み ----------
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
  $('calStaff').replaceChildren(el('option', { value: '', textContent: '全員の予定' }),
    ...state.config.staff.map((s) => el('option', { value: s.id, textContent: s.name })));
  $('calStaff').value = state.staffFilter;
}
guard(async () => {
  await refreshConfig();
  state.weekStart = mondayOf(state.config.today);
  await loadCalendar();
  await loadNotes(true);
  setInterval(() => {
    pollNotes();
    if (!$('tab-calendar').hidden && !$('detail').open && !$('blockDialog').open) loadCalendar().catch(() => {});
  }, 15000);
})();
