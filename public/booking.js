'use strict';
// お客様向けの予約ページ
const $ = (id) => document.getElementById(id);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const state = { config: null, serviceId: null, staffId: 'any', month: null, date: null, start: null, days: {} };

const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const wd = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const jp = (s) => `${Number(s.slice(5, 7))}月${Number(s.slice(8))}日（${WD[wd(s)]}）`;
const shiftMonth = (m, n) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const lastDay = () => addDays(state.config.today, state.config.windowDays);

async function call(path, options) {
  const res = await fetch(path, options && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '通信に失敗しました。');
  return data;
}
function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
  if (message) $('error').scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  node.append(...children);
  return node;
}
function choice(parent, label, selected, onClick) {
  const b = el('button', { type: 'button', textContent: label });
  b.setAttribute('aria-pressed', String(selected));
  b.addEventListener('click', onClick);
  parent.append(b);
  return b;
}

function render() {
  const { config } = state;
  $('services').replaceChildren();
  config.services.forEach((v) => choice($('services'), v.name, v.id === state.serviceId, () => { state.serviceId = v.id; state.start = null; render(); }));
  $('staff').replaceChildren();
  [{ id: 'any', name: '指名なし（おまかせ）' }].concat(config.staff)
    .forEach((s) => choice($('staff'), s.name, s.id === state.staffId, () => { state.staffId = s.id; state.start = null; render(); }));
  $('monthLabel').textContent = `${Number(state.month.slice(0, 4))}年${Number(state.month.slice(5, 7))}月`;
  $('prev').disabled = state.month <= config.today.slice(0, 7);
  $('next').disabled = state.month >= lastDay().slice(0, 7);
  renderPicked();
  loadMonth();
}

// 月カレンダー: 日ごとの空き状況を ○ △ × で表示する
let monthRequest = 0;
async function loadMonth() {
  const first = state.month + '-01';
  const last = addDays(shiftMonth(state.month, 1) + '-01', -1);
  const mine = ++monthRequest;
  drawMonth(first, last, null);
  try {
    const { days } = await call(`/api/public/availability?from=${first}&to=${last}&serviceId=${state.serviceId}&staffId=${state.staffId}`);
    if (mine !== monthRequest) return; // 古い応答は捨てる
    state.days = days;
    // 選んでいる日が予約できないときは、その月でいちばん近い空き日を選び直す
    if (!days[state.date]) {
      state.date = Object.keys(days).sort().find((d) => days[d] > 0) || null;
      state.start = null;
    }
    drawMonth(first, last, days);
    renderPicked();
    loadSlots();
  } catch (e) {
    $('slotsNote').textContent = e.message;
  }
}
function drawMonth(first, last, days) {
  const cells = [];
  for (let i = 0; i < (wd(first) + 6) % 7; i++) cells.push(el('span'));
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const count = days ? days[d] : undefined;
    const mark = count === undefined ? '－' : count === 0 ? '×' : count <= 3 ? '△' : '○';
    const word = count === undefined ? '受付期間外' : count === 0 ? '空きなし' : count <= 3 ? '残りわずか' : '空きあり';
    const b = el('button', { type: 'button', disabled: !count, className: d === state.config.today ? 'today' : '' },
      el('span', { textContent: String(Number(d.slice(8))) }),
      el('span', { className: 'mark' + (count > 0 && count <= 3 ? ' few' : ''), textContent: days ? mark : '…' }));
    b.setAttribute('aria-pressed', String(d === state.date));
    b.setAttribute('aria-label', `${jp(d)} ${word}`);
    const date = d;
    b.addEventListener('click', () => { state.date = date; state.start = null; drawMonth(first, last, state.days); renderPicked(); loadSlots(); });
    cells.push(b);
  }
  $('days').replaceChildren(...cells);
}

let slotRequest = 0;
async function loadSlots() {
  const box = $('slots');
  const note = $('slotsNote');
  box.replaceChildren();
  $('slotTitle').textContent = state.date ? `${jp(state.date)}の空き時間` : '';
  if (!state.date) { note.textContent = 'この月は予約できる日がありません。別の月か、別の担当者をお選びください。'; return; }
  note.textContent = '空き時間を確認しています…';
  const mine = ++slotRequest;
  try {
    const { slots } = await call(`/api/public/slots?date=${state.date}&serviceId=${state.serviceId}&staffId=${state.staffId}`);
    if (mine !== slotRequest) return;
    note.textContent = slots.length ? '' : `${jp(state.date)}は予約できる時間がありません。別の日をお選びください。`;
    const groups = [['午前', slots.filter((t) => t < '12:00')], ['午後', slots.filter((t) => t >= '12:00')]];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const grid = el('div', { className: 'slots' });
      list.forEach((t) => choice(grid, t, t === state.start, () => {
        state.start = t;
        renderPicked();
        box.querySelectorAll('button').forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === t)));
      }));
      box.append(el('div', { className: 'slot-group' }, el('h3', { textContent: title }), grid));
    }
  } catch (e) {
    note.textContent = e.message;
  }
}
function renderPicked() {
  const ready = Boolean(state.serviceId && state.date && state.start);
  $('submit').disabled = !ready;
  const sv = state.config.services.find((v) => v.id === state.serviceId);
  const staff = state.config.staff.find((s) => s.id === state.staffId);
  $('picked').className = ready ? 'picked' : 'muted';
  $('picked').textContent = ready
    ? `ご予約内容: ${jp(state.date)} ${state.start}〜／${sv.name}／${staff ? staff.name : '担当者おまかせ'}`
    : '日時を選ぶと、ここに予約内容が表示されます。';
}

function showBooking(b, isNew) {
  $('form').hidden = true;
  $('done').hidden = false;
  const cancelled = b.status === 'cancelled';
  $('doneTitle').textContent = cancelled ? 'この予約はキャンセル済みです' : isNew ? 'ご予約を受け付けました' : 'ご予約内容の確認';
  const rows = [['日時', `${jp(b.date)} ${b.start}〜${b.end}`], ['ご相談内容', b.serviceName], ['担当者', b.staffName], ['お名前', `${b.customerName} 様`]];
  $('doneSummary').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  const link = `${location.origin}/?id=${b.id}&token=${b.token}`;
  $('doneLink').value = link;
  history.replaceState(null, '', link);
  $('doneNote').hidden = $('doneLinkRow').hidden = cancelled;
  $('cancel').hidden = b.status !== 'booked';
  $('cancel').onclick = async () => {
    if (!confirm('この予約をキャンセルします。よろしいですか？')) return;
    try { showBooking(await call('/api/public/cancel', { body: { id: b.id, token: b.token } }), false); showError(''); }
    catch (e) { showError(e.message); }
  };
  window.scrollTo({ top: 0 });
}
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('doneLink').value); } catch { $('doneLink').select(); document.execCommand('copy'); }
  $('copy').textContent = 'コピーしました';
  setTimeout(() => { $('copy').textContent = 'コピー'; }, 2000);
});

$('prev').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); render(); });
$('next').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); render(); });
$('customer').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  Object.assign(body, { serviceId: state.serviceId, staffId: state.staffId, date: state.date, start: state.start });
  $('submit').disabled = true;
  $('submit').textContent = '予約しています…';
  try {
    showBooking(await call('/api/public/bookings', { body }), true);
    showError('');
  } catch (e) {
    showError(e.message);
    state.start = null;
    render(); // 埋まってしまった枠を消すため、空き状況を取り直す
  } finally {
    $('submit').textContent = 'この内容で予約する';
  }
});

(async function init() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('id') && q.get('token')) {
      return showBooking(await call(`/api/public/booking?id=${encodeURIComponent(q.get('id'))}&token=${encodeURIComponent(q.get('token'))}`), false);
    }
    state.config = await call('/api/public/config');
    state.month = state.config.today.slice(0, 7);
    state.date = state.config.today;
    state.serviceId = state.config.services[0].id;
    render();
  } catch (e) {
    showError(e.message);
  }
})();
