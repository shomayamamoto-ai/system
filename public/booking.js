'use strict';
// お客様向けの予約ページ（新規予約・予約の確認・日時変更・キャンセル）
const $ = (id) => document.getElementById(id);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const state = { config: null, serviceId: null, staffId: 'any', month: null, date: null, start: null, days: {}, moving: null };

const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const wd = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const jp = (s) => `${Number(s.slice(5, 7))}月${Number(s.slice(8))}日（${WD[wd(s)]}）`;
const shiftMonth = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
const lastDay = () => addDays(state.config.today, state.config.windowDays);
// 日時変更中は、自分の予約が入っている枠も「空き」として問い合わせる
const own = () => (state.moving ? `&bookingId=${state.moving.id}&token=${state.moving.token}` : '');

async function call(path, options) {
  const res = await fetch(path, options && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '通信に失敗しました。電波の状態を確認して、もう一度お試しください。');
  return data;
}
function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
  if (message) $('error').scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  node.append(...children.filter((c) => c != null));
  return node;
}
function choice(parent, selected, onClick, title, sub) {
  const b = el('button', { type: 'button' }, el('span', { className: 'radio' }),
    el('span', { className: 'opt' }, el('span', { textContent: title }), sub ? el('small', { textContent: sub }) : null));
  b.setAttribute('aria-pressed', String(selected));
  b.addEventListener('click', onClick);
  parent.append(b);
}
const reveal = (id) => $(id).scrollIntoView({ block: 'start', behavior: 'smooth' });

function render() {
  const { config } = state;
  $('services').replaceChildren();
  config.services.forEach((v) => choice($('services'), v.id === state.serviceId,
    () => { state.serviceId = v.id; state.start = null; render(); }, v.name, [`所要時間 ${v.minutes}分`, v.description].filter(Boolean).join('／')));
  $('staff').replaceChildren();
  [{ id: 'any', name: '指名なし（おまかせ）' }].concat(config.staff)
    .forEach((s) => choice($('staff'), s.id === state.staffId, () => { state.staffId = s.id; state.start = null; render(); }, s.name));
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
    const { days } = await call(`/api/public/availability?from=${first}&to=${last}&serviceId=${state.serviceId}&staffId=${state.staffId}${own()}`);
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
    b.addEventListener('click', () => {
      state.date = date; state.start = null;
      drawMonth(first, last, state.days); renderPicked();
      loadSlots().then(() => reveal('slotTitle'));
    });
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
  if (!state.date) { note.textContent = 'この月は予約できる日がありません。「次の月」を押すか、別の担当者をお選びください。'; return; }
  note.textContent = '空き時間を確認しています…';
  const mine = ++slotRequest;
  try {
    const { slots } = await call(`/api/public/slots?date=${state.date}&serviceId=${state.serviceId}&staffId=${state.staffId}${own()}`);
    if (mine !== slotRequest) return;
    note.textContent = slots.length ? '' : `${jp(state.date)}は予約できる時間がありません。別の日をお選びください。`;
    for (const [title, list] of [['午前', slots.filter((t) => t < '12:00')], ['午後', slots.filter((t) => t >= '12:00')]]) {
      if (!list.length) continue;
      const grid = el('div', { className: 'slots' });
      list.forEach((t) => {
        const b = el('button', { type: 'button', textContent: t });
        b.setAttribute('aria-pressed', String(t === state.start));
        b.addEventListener('click', () => {
          state.start = t;
          renderPicked();
          box.querySelectorAll('button').forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === t)));
          if (!state.moving) reveal('secCustomer'); // 次に入力する場所まで自動で進める
        });
        grid.append(b);
      });
      box.append(el('div', { className: 'slot-group' }, el('h3', { textContent: title }), grid));
    }
  } catch (e) {
    note.textContent = e.message;
  }
}
// 画面下のバー: 選んだ内容と、次にすることを表示する
function renderPicked() {
  const ready = Boolean(state.serviceId && state.date && state.start);
  $('submit').disabled = !ready;
  const sv = state.config.services.find((v) => v.id === state.serviceId);
  const staff = state.config.staff.find((s) => s.id === state.staffId);
  $('picked').replaceChildren(...(ready
    ? [el('b', { textContent: `${jp(state.date)} ${state.start}〜` }), `${sv.name}／${state.moving ? '担当者は空き状況で決まります' : staff ? staff.name : '担当者おまかせ'}`]
    : [el('b', { textContent: '日時を選んでください' }), 'カレンダーで日付、続けて時間を選びます']));
}

// ---------- 予約完了・確認 ----------
function showBooking(b, title) {
  state.moving = null;
  $('form').hidden = $('cta').hidden = true;
  $('done').hidden = false;
  const cancelled = b.status === 'cancelled';
  const active = b.status === 'booked';
  $('doneTitle').textContent = cancelled ? 'この予約はキャンセル済みです' : title || 'ご予約内容の確認';
  $('doneIcon').classList.toggle('off', !active);
  $('doneMail').hidden = !(title && b.mailSent);
  const rows = [['日時', `${jp(b.date)} ${b.start}〜${b.end}`], ['ご相談内容', b.serviceName], ['担当者', b.staffName], ['お名前', `${b.customerName} 様`]];
  $('doneSummary').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  const link = `${location.origin}/?id=${b.id}&token=${b.token}`;
  $('doneLink').value = link;
  history.replaceState(null, '', link);
  $('doneLinkBox').hidden = cancelled;
  $('doneBlocked').hidden = !b.blockedReason;
  $('doneBlocked').textContent = b.blockedReason;
  $('ics').hidden = $('gcal').hidden = !active;
  $('change').hidden = $('cancel').hidden = !b.canChange;
  $('ics').href = `/api/public/ics?id=${b.id}&token=${b.token}`;
  const stamp = (t) => b.date.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
  $('gcal').href = 'https://calendar.google.com/calendar/render?action=TEMPLATE&ctz=Asia/Tokyo' +
    `&text=${encodeURIComponent(b.serviceName)}&dates=${stamp(b.start)}/${stamp(b.end)}&details=${encodeURIComponent('担当: ' + b.staffName)}`;
  $('cancel').onclick = async () => {
    if (!confirm('この予約をキャンセルします。よろしいですか？')) return;
    try { showBooking(await call('/api/public/cancel', { body: { id: b.id, token: b.token } })); showError(''); }
    catch (e) { showError(e.message); }
  };
  $('change').onclick = () => startMove(b);
  window.scrollTo({ top: 0 });
}
// 日時の変更: カレンダーだけを表示して選び直してもらう
async function startMove(b) {
  try {
    if (!state.config) state.config = await call('/api/public/config');
    Object.assign(state, { moving: b, serviceId: b.serviceId, staffId: 'any', month: b.date.slice(0, 7), date: b.date, start: null });
    $('done').hidden = true;
    $('form').hidden = $('cta').hidden = false;
    $('secService').hidden = $('secStaff').hidden = $('secCustomer').hidden = true;
    $('changeNote').hidden = false;
    $('changeNote').textContent = `現在のご予約: ${jp(b.date)} ${b.start}〜${b.end}／${b.serviceName}。新しい日時を選んでください。`;
    $('submit').textContent = 'この日時に変更';
    $('submit').type = 'button';
    $('submit').onclick = async () => {
      $('submit').disabled = true;
      try {
        showBooking(await call('/api/public/reschedule', { body: { id: b.id, token: b.token, date: state.date, start: state.start } }), '日時を変更しました');
        showError('');
      } catch (e) {
        showError(e.message);
        state.start = null;
        state.moving = b;
        render();
      }
    };
    showError('');
    render();
    window.scrollTo({ top: 0 });
  } catch (e) {
    showError(e.message);
  }
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
  if (state.moving) return;
  const body = Object.fromEntries(new FormData(ev.target));
  Object.assign(body, { serviceId: state.serviceId, staffId: state.staffId, date: state.date, start: state.start });
  $('submit').disabled = true;
  $('submit').textContent = '送信中…';
  try {
    showBooking(await call('/api/public/bookings', { body }), 'ご予約を受け付けました');
    showError('');
  } catch (e) {
    showError(e.message);
    state.start = null;
    render(); // 埋まってしまった枠を消すため、空き状況を取り直す
  } finally {
    $('submit').textContent = '予約する';
  }
});

(async function init() {
  try {
    const q = new URLSearchParams(location.search);
    state.config = await call('/api/public/config');
    const site = state.config.site;
    document.title = site.name;
    $('siteName').textContent = site.name;
    $('siteIntro').textContent = site.intro;
    $('siteIntro').hidden = !site.intro;
    $('foot').textContent = site.name;
    if (q.get('id') && q.get('token')) {
      return showBooking(await call(`/api/public/booking?id=${encodeURIComponent(q.get('id'))}&token=${encodeURIComponent(q.get('token'))}`));
    }
    state.month = state.config.today.slice(0, 7);
    state.date = state.config.today;
    state.serviceId = state.config.services[0].id;
    $('form').hidden = $('cta').hidden = false;
    render();
  } catch (e) {
    showError(e.message);
  }
})();
