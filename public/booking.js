'use strict';
// お客様向けの予約ページ
const $ = (id) => document.getElementById(id);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const state = { config: null, serviceId: null, staffId: 'any', weekStart: null, date: null, start: null };

const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const wd = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const jp = (s) => `${Number(s.slice(5, 7))}月${Number(s.slice(8))}日（${WD[wd(s)]}）`;

async function call(path, options) {
  const res = await fetch(path, options && { method: options.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '通信に失敗しました。');
  return data;
}
function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
  if (message) $('error').scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function choice(parent, label, selected, onClick, sub) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(selected));
  b.textContent = label;
  if (sub) { const s = document.createElement('small'); s.textContent = sub; b.prepend(s); }
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

function render() {
  const { config } = state;
  $('services').replaceChildren();
  config.services.forEach((v) => choice($('services'), v.name, v.id === state.serviceId, () => { state.serviceId = v.id; state.start = null; render(); }));
  $('staff').replaceChildren();
  [{ id: 'any', name: '指名なし（おまかせ）' }].concat(config.staff)
    .forEach((s) => choice($('staff'), s.name, s.id === state.staffId, () => { state.staffId = s.id; state.start = null; render(); }));

  const last = addDays(config.today, config.windowDays);
  $('days').replaceChildren();
  for (let i = 0; i < 7; i++) {
    const d = addDays(state.weekStart, i);
    const b = choice($('days'), String(Number(d.slice(8))), d === state.date, () => { state.date = d; state.start = null; render(); }, WD[wd(d)]);
    b.disabled = d < config.today || d > last;
    b.setAttribute('aria-label', jp(d));
  }
  $('range').textContent = `${jp(state.weekStart)}〜`;
  $('prev').disabled = state.weekStart <= config.today;
  $('next').disabled = addDays(state.weekStart, 7) > last;
  renderPicked();
  loadSlots();
}

let slotRequest = 0;
async function loadSlots() {
  const box = $('slots');
  const note = $('slotsNote');
  box.replaceChildren();
  if (!state.serviceId) { note.textContent = '先にご相談内容を選んでください。'; return; }
  if (!state.date) { note.textContent = '日付を選ぶと、予約できる時間が表示されます。'; return; }
  note.textContent = '空き時間を確認しています…';
  const mine = ++slotRequest;
  try {
    const { slots } = await call(`/api/public/slots?date=${state.date}&serviceId=${state.serviceId}&staffId=${state.staffId}`);
    if (mine !== slotRequest) return; // 古い応答は捨てる
    note.textContent = slots.length ? '' : `${jp(state.date)}は予約できる時間がありません。別の日をお選びください。`;
    slots.forEach((t) => choice(box, t, t === state.start, () => { state.start = t; renderPicked(); [...box.children].forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === t))); }));
  } catch (e) {
    note.textContent = e.message;
  }
}
function renderPicked() {
  const ready = state.serviceId && state.date && state.start;
  $('submit').disabled = !ready;
  const sv = state.config.services.find((v) => v.id === state.serviceId);
  $('picked').textContent = ready
    ? `ご予約内容: ${jp(state.date)} ${state.start}〜／${sv.name}`
    : '日時を選ぶと、ここに予約内容が表示されます。';
}

function showBooking(b, isNew) {
  $('form').hidden = true;
  $('done').hidden = false;
  const cancelled = b.status === 'cancelled';
  $('doneTitle').textContent = cancelled ? 'この予約はキャンセル済みです' : isNew ? 'ご予約を受け付けました' : 'ご予約内容の確認';
  const rows = [['日時', `${jp(b.date)} ${b.start}〜${b.end}`], ['ご相談内容', b.serviceName], ['担当者', b.staffName], ['お名前', `${b.customerName} 様`]];
  $('doneSummary').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
  const link = `${location.origin}/?id=${b.id}&token=${b.token}`;
  $('doneLink').value = link;
  history.replaceState(null, '', link);
  $('doneNote').hidden = $('doneLink').hidden = cancelled;
  $('cancel').hidden = b.status !== 'booked';
  $('cancel').onclick = async () => {
    if (!confirm('この予約をキャンセルします。よろしいですか？')) return;
    try { showBooking(await call('/api/public/cancel', { body: { id: b.id, token: b.token } }), false); showError(''); }
    catch (e) { showError(e.message); }
  };
  window.scrollTo({ top: 0 });
}

$('prev').addEventListener('click', () => { state.weekStart = addDays(state.weekStart, -7); if (state.weekStart < state.config.today) state.weekStart = state.config.today; render(); });
$('next').addEventListener('click', () => { state.weekStart = addDays(state.weekStart, 7); render(); });
$('customer').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  Object.assign(body, { serviceId: state.serviceId, staffId: state.staffId, date: state.date, start: state.start });
  $('submit').disabled = true;
  try {
    showBooking(await call('/api/public/bookings', { body }), true);
    showError('');
  } catch (e) {
    showError(e.message);
    state.start = null;
    render(); // 埋まってしまった枠を消すため、空き時間を取り直す
  }
});

(async function init() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('id') && q.get('token')) {
      return showBooking(await call(`/api/public/booking?id=${encodeURIComponent(q.get('id'))}&token=${encodeURIComponent(q.get('token'))}`), false);
    }
    state.config = await call('/api/public/config');
    state.weekStart = state.config.today;
    state.date = state.config.today;
    if (state.config.services.length === 1) state.serviceId = state.config.services[0].id;
    render();
  } catch (e) {
    showError(e.message);
  }
})();
