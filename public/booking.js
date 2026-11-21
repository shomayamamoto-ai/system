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
  // 選んだメニューに対応できる担当者だけを出す
  const service = config.services.find((v) => v.id === state.serviceId);
  const able = config.staff.filter((s) => !service || !service.staffIds || !service.staffIds.length || service.staffIds.includes(s.id));
  if (state.staffId !== 'any' && !able.some((s) => s.id === state.staffId)) state.staffId = 'any';
  [{ id: 'any', name: '指名なし（おまかせ）' }].concat(able)
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
    if (!days[state.date] && !(canWait() && days[state.date] === 0)) {
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
    const word = count === undefined ? '受付なし' : count === 0 ? '空きなし' : count <= 3 ? '残りわずか' : '空きあり';
    // 空きのない日も、キャンセル待ちができるときは選べるようにする
    const b = el('button', { type: 'button', disabled: !count && !(canWait() && count === 0), className: d === state.config.today ? 'today' : '' },
      el('span', { textContent: String(Number(d.slice(8))) }),
      el('span', { className: 'mark' + (count > 0 && count <= 3 ? ' few' : ''), textContent: days ? mark : '…' }));
    b.setAttribute('aria-pressed', String(d === state.date));
    b.setAttribute('aria-label', `${jp(d)} ${word}${count === 0 && canWait() ? '（キャンセル待ちができます）' : ''}`);
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

// ---------- キャンセル待ち ----------
const canWait = () => Boolean(state.config && state.config.waitlist && !state.moving);
function drawWaitBox(open, full) {
  const box = $('waitBox');
  box.hidden = !canWait() || !state.date;
  if (box.hidden) return;
  if (!open) {
    const link = el('button', { type: 'button', className: 'ghost small', textContent: 'ご希望の時間が埋まっている場合は、キャンセル待ちに登録できます' });
    link.addEventListener('click', () => drawWaitBox(true, false));
    return box.replaceChildren(link);
  }
  const form = el('form', { className: 'stack-s' });
  const part = el('select', { name: 'part' }, ...[['any', '終日（どの時間でもよい）'], ['am', '午前（12時まで）'], ['pm', '午後（12時から）']].map(([v, t]) => el('option', { value: v, textContent: t })));
  const name = el('input', { name: 'customerName', required: true, maxLength: 80, autocomplete: 'name', value: $('customer').customerName.value });
  const email = el('input', { name: 'email', type: 'email', inputMode: 'email', required: true, maxLength: 120, autocomplete: 'email', autocapitalize: 'off', value: $('customer').email.value });
  const msg = el('p', { className: 'muted', role: 'status' });
  const submit = el('button', { type: 'submit', className: 'primary', textContent: 'キャンセル待ちに登録する' });
  form.append(
    el('h3', { textContent: `${jp(state.date)}のキャンセル待ち` }),
    el('p', { className: 'muted', textContent: (full ? 'この日は埋まっています。' : '') + '登録しておくと、空きが出たときに、登録の早い順にメールでお知らせします。お知らせした方のために、その枠を30分間取り置きます。' }),
    el('label', null, 'ご希望の時間帯', part), el('label', null, 'お名前（必須）', name), el('label', null, 'メールアドレス（必須）', email), submit, msg);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      const w = await call('/api/public/waitlist', { body: { serviceId: state.serviceId, staffId: state.staffId, date: state.date, part: part.value, customerName: name.value, email: email.value } });
      box.replaceChildren(el('div', { className: 'msg ok', textContent: `${jp(w.date)}のキャンセル待ちを受け付けました。空きが出たら、登録の早い順にメールでお知らせし、30分間その枠を取り置きます。` }));
    } catch (e) { msg.textContent = e.message; submit.disabled = false; }
  });
  box.replaceChildren(form);
}
async function showWaitlist(id, token) {
  const w = await call(`/api/public/waitlist?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
  $('form').hidden = $('cta').hidden = true;
  $('done').hidden = false;
  const active = w.status === 'waiting' || w.status === 'offered';
  $('doneTitle').textContent = { waiting: 'キャンセル待ちの登録', offered: '空きが出て、取り置き中です（メールをご確認ください）', booked: 'キャンセル待ちから予約されました', missed: '取り置きの期限が切れました', cancelled: 'キャンセル待ちを取り消しました', expired: 'このキャンセル待ちは終了しています' }[w.status] || 'このキャンセル待ちは終了しています';
  $('doneIcon').classList.toggle('off', !active);
  $('doneMail').hidden = $('doneLinkBox').hidden = $('doneBlocked').hidden = true;
  $('doneSummary').replaceChildren(...[['日付', `${jp(w.date)}（${w.part}）`], ['ご相談内容', w.serviceName], ['お名前', `${w.customerName} 様`]]
    .flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  $('ics').hidden = $('gcal').hidden = $('change').hidden = true;
  $('cancel').hidden = !active;
  $('cancel').textContent = 'キャンセル待ちを取り消す';
  $('cancel').onclick = async () => {
    if (!confirm('キャンセル待ちの登録を取り消します。よろしいですか？')) return;
    try { await call('/api/public/waitlist/cancel', { body: { id, token } }); await showWaitlist(id, token); showError(''); } catch (e) { showError(e.message); }
  };
}

// 取り置きの枠で予約する（キャンセル待ちのお知らせメールのリンクから来たとき）
async function startHold(id, token) {
  const h = await call(`/api/public/hold?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
  Object.assign(state, { hold: { id, token }, serviceId: h.serviceId, staffId: h.staffId, date: h.date, start: h.start, month: h.date.slice(0, 7) });
  $('form').hidden = $('cta').hidden = false;
  $('secService').hidden = $('secStaff').hidden = $('secDate').hidden = true;
  $('changeNote').hidden = false;
  const until = new Date(h.expiresAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  $('changeNote').textContent = `キャンセル待ちの空きを、${until}まで取り置いています: ${jp(h.date)} ${h.start}〜${h.end}／${h.serviceName}／${h.staffName}。下の欄に入力して、予約を確定してください。`;
  $('customer').customerName.value = h.customerName;
  $('customer').email.value = h.email;
  renderPicked();
}

let slotRequest = 0;
async function loadSlots() {
  const box = $('slots');
  const note = $('slotsNote');
  box.replaceChildren();
  $('slotTitle').textContent = state.date ? `${jp(state.date)}の空き時間` : '';
  $('waitBox').hidden = true;
  if (!state.date) { note.textContent = 'この月は予約できる日がありません。「次の月」を押すか、別の担当者をお選びください。'; return; }
  note.textContent = '空き時間を確認しています…';
  const mine = ++slotRequest;
  try {
    const { slots } = await call(`/api/public/slots?date=${state.date}&serviceId=${state.serviceId}&staffId=${state.staffId}${own()}`);
    if (mine !== slotRequest) return;
    note.textContent = slots.length ? '' : `${jp(state.date)}は予約できる時間がありません。${canWait() ? '' : '別の日をお選びください。'}`;
    drawWaitBox(!slots.length, !slots.length);
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
  // 事前アンケートの回答は、質問ごとにまとめて送る
  const answers = {};
  for (const q of state.config.questions) { answers[q.id] = body['q_' + q.id] || ''; delete body['q_' + q.id]; }
  Object.assign(body, { answers, serviceId: state.serviceId, staffId: state.staffId, date: state.date, start: state.start });
  if (state.hold) Object.assign(body, { holdId: state.hold.id, holdToken: state.hold.token });
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
    if (q.get('wl') && q.get('token')) return showWaitlist(q.get('wl'), q.get('token'));
    if (q.get('id') && q.get('token')) {
      return showBooking(await call(`/api/public/booking?id=${encodeURIComponent(q.get('id'))}&token=${encodeURIComponent(q.get('token'))}`));
    }
    // 事前アンケート（設定画面で追加した質問）の入力欄を作る
    $('questions').replaceChildren(...state.config.questions.map((q) => {
      const name = 'q_' + q.id;
      const field = q.type === 'select'
        ? el('select', { name, required: q.required }, el('option', { value: '', textContent: '選択してください' }), ...q.options.map((o) => el('option', { value: o, textContent: o })))
        : el('input', { name, required: q.required, maxLength: 500 });
      return el('label', null, `${q.label}（${q.required ? '必須' : '任意'}）`, field);
    }));
    if (q.get('hold') && q.get('token')) return startHold(q.get('hold'), q.get('token')); // アンケートの欄を作ってから
    state.month = state.config.today.slice(0, 7);
    state.date = state.config.today;
    state.serviceId = state.config.services[0].id;
    // 空きのお知らせメールのリンク（?date=…&service=…）から来たときは、その日とメニューを選んだ状態にする
    const qd = q.get('date');
    if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd) && qd >= state.config.today && qd <= lastDay()) { state.date = qd; state.month = qd.slice(0, 7); }
    if (state.config.services.some((v) => v.id === q.get('service'))) state.serviceId = q.get('service');
    $('form').hidden = $('cta').hidden = false;
    render();
  } catch (e) {
    showError(e.message);
  }
})();
