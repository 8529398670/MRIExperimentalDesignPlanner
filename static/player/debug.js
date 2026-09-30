// The debug popup: follows the stage over BroadcastChannel (feed.js). It shows
// the same header and live block as the operator console (innerspeech/console.py),
// plus every event with its onset drift, and sends controls back. Keys pressed
// here are relayed to the stage, so this window can keep the focus.

import { CHANNEL, badge, clock } from './feed.js';
import { keyName } from './stage.js';

const $ = (sel) => document.querySelector(sel);
const MAX_ROWS = 3000;
const CATEGORY = {
  trial: 'trial', phase: 'phase', pulse: 'pulse', scan_start: 'pulse', trigger: 'volume',
  state: 'control', pause: 'control', resume: 'control', skip: 'control', speed: 'control',
};

let channel = null;
let meta = null;
let live = null;
let events = [];
let lastMessage = 0;

function send(cmd, arg) {
  channel?.postMessage({ kind: 'command', cmd, arg });
}

// =============================================================== header ===
function renderMeta() {
  const dl = $('#meta');
  $('#copy').disabled = !meta?.command;
  if (!meta) {
    dl.replaceChildren();
    $('#title').textContent = 'Waiting for the stage…';
    return;
  }
  const src = meta.source || {};
  const o = meta.options || {};
  const rows = [
    ['config', meta.label],
    ['file', meta.file],
    ['source', src.source === 'planner'
      ? `planner ${src.design} · rev ${src.rev} · ${src.id}${src.fetched ? ` · fetched ${src.fetched.slice(0, 16).replace('T', ' ')}` : ''}`
      : 'local config/'],
    ['seed', `${meta.seed}`],
    ['trials', `${meta.n_trials}  (${meta.n_blocks} blocks × ${meta.per_block}) · bank ${meta.n_questions} questions`],
    ['phases', meta.phases.join(' › ')],
    ['scanner', `TR ${meta.tr} s · ${meta.dummies} dummy pulses on key \`${meta.trigger_key}\` · ${o.scanner}`],
    ['plan', `est. ${clock(meta.total)} · ${[o.auto && 'auto', o.debug && 'debug keys', o.fullscreen && 'fullscreen'].filter(Boolean).join(' · ') || 'no extras'}`],
  ];
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dd.title = v;
    return [dt, dd];
  }));
}

// ================================================================= live ===
function tokenClass(trial) {
  return `badge tok-${trial.role}`;
}

function question(prefix, trial) {
  const text = $(`#${prefix}-text`);
  const b = $(`#${prefix}-badge`);
  if (!trial) {
    text.textContent = '—';
    b.textContent = '';
    return;
  }
  text.textContent = trial.show_question ? trial.text : '(cue only — not shown)';
  text.title = `${trial.category} · ${trial.family} · ${trial.view} · ${trial.uuid}`;
  b.textContent = `${trial.condition} · ${badge(trial)}`;
  b.className = tokenClass(trial);
}

function renderLive() {
  const L = live || { state: 'idle' };
  const state = L.state;
  const dot = $('#dot');
  dot.className = `status-dot ${{ running: 'live', paused: 'paused', aborted: 'ended' }[state] || ''}`;
  if (meta) document.title = `Debug · ${meta.label} · ${state}`;
  $('#title').textContent = meta ? `${meta.label} · ${state}` : (state === 'idle' ? 'No demo running' : state);
  $('#pause').textContent = state === 'paused' ? 'Resume' : 'Pause';
  for (const b of document.querySelectorAll('#speed button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.value) === L.speed));
  }
  const active = ['instructions', 'waiting', 'running', 'paused'].includes(state);
  for (const id of ['pause', 'skip', 'abort', 'hud']) $(`#${id}`).disabled = !active;
  for (const el of $('#jump').elements) el.disabled = !['running', 'paused'].includes(state);
  for (const b of document.querySelectorAll('#speed button')) b.disabled = !active;

  if (L.t == null) {
    $('#run-bar').style.width = '0';
    $('#phase-bar').style.width = '0';
    $('#run-right').textContent = meta ? `0:00 / ${clock(meta.total)}` : '–';
    $('#run-where').textContent = {
      idle: 'no demo running - press ▶ Demo on the launcher',
      instructions: 'instructions on screen',
      waiting: `waiting for the scanner: ${L.pulses}/${L.dummies} pulses`,
      done: 'complete', aborted: 'aborted before the scan started',
    }[state] || state;
    $('#phase-right').textContent = '–';
    $('#phase-strip').textContent = meta ? meta.phases.map((p) => ` ${p.slice(0, 3)} `).join(' › ') : '';
    question('now', null);
    question('next', L.next || null);
  } else {
    const frac = Math.min(1, L.t / L.total);
    $('#run-bar').style.width = `${frac * 100}%`;
    $('#run-right').textContent = `${clock(L.t)} / ${clock(L.total)}  ${Math.round(frac * 100)}%`;
    const where = L.now ? `trial ${L.now.i + 1}/${L.n_trials} · block ${L.now.block + 1}/${L.n_blocks}` : (L.span?.name ?? meta?.lead_in);   // outside a trial: the lead-in or lead-out
    $('#run-where').textContent = `${where} · ${state}${L.speed !== 1 ? ` · ×${L.speed}` : ''}`;
    if (L.span) {
      const span = L.span;
      const left = Math.max(0, span.t1 - L.t);
      const len = span.t1 - span.t0;
      $('#phase-bar').style.width = `${len > 0 ? (1 - left / len) * 100 : 100}%`;
      $('#phase-right').textContent = `${span.name}  ${left.toFixed(1)} s`;
      const strip = $('#phase-strip');
      strip.replaceChildren(...L.phases.flatMap((p, i) => {
        const el = document.createElement(p === span.name ? 'b' : 'span');
        el.textContent = p === span.name ? `[${p.slice(0, 3)}]` : ` ${p.slice(0, 3)} `;
        return i ? [' › ', el] : [el];
      }));
    }
    question('now', L.now);
    question('next', L.next);
  }
  const stats = [
    L.vol ? `vol ${L.vol}` : null,
    L.fps != null ? `${L.fps} fps` : null,
    L.dropped != null ? `${L.dropped} dropped` : null,
    L.max_drift_ms != null ? `max |Δ| ${L.max_drift_ms} ms` : null,
    L.pauses ? `${L.pauses} pauses` : null,
    L.skips ? `${L.skips} skipped` : null,
  ].filter(Boolean);
  $('#stats').textContent = stats.join('  ·  ');
}

// ================================================================== log ===
function row(e) {
  const r = document.createElement('div');
  const cat = CATEGORY[e.type] || e.type;
  r.className = `r ${cat === 'control' ? 'control' : ''} ${e.type === 'trial' ? 'trial' : ''} ${e.type === 'warn' ? 'warn' : ''} ${e.type === 'abort' ? 'abort' : ''}`;
  r.dataset.cat = cat;
  const t = e.type === 'phase' ? e.sched : e.t;
  let kind = e.type;
  let detail = '';
  let extra = '';
  let late = false;
  switch (e.type) {
    case 'trial': {
      const tr = e.trial;
      detail = `${tr.i + 1}/${tr.n} · b${tr.block + 1} · ${tr.condition} · ${badge(tr)} · ${tr.show_question ? tr.text : '(cue only)'}`;
      break;
    }
    case 'phase':
      detail = `${e.name.padEnd(14)} ${e.show.padEnd(8)} ${e.dur.toFixed(2)} s`;
      if (e.meas == null) { extra = 'not shown'; late = true; } else {
        extra = `Δ ${e.drift_ms >= 0 ? '+' : ''}${e.drift_ms.toFixed(1)} ms`;
        late = Math.abs(e.drift_ms) > 25;
      }
      break;
    case 'pulse': detail = `dummy ${e.n}/${e.of} (${e.how})`; break;
    case 'trigger': kind = 'volume'; detail = e.vol == null ? 'trigger key' : `vol ${e.vol} (${e.how})`; break;
    case 'scan_start': kind = 'scan'; detail = `t0 ${e.how}`; break;
    case 'state': detail = `${e.state}${e.detail ? ` - ${e.detail}` : ''}`; break;
    case 'done': kind = 'complete'; detail = e.text; break;
    default: detail = e.text ?? JSON.stringify(e);
  }
  const cell = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const d = cell('d', detail);
  d.title = detail;
  if (e.type === 'trial') d.classList.add(`tok-${e.trial.role}`);
  const x = cell(`x ${late ? 'late' : ''}`, extra);
  r.append(cell('t', t == null ? '—' : t.toFixed(2)), cell('k', kind), d, x);
  r.dataset.text = `${kind} ${detail}`.toLowerCase();
  return r;
}

function visible(r) {
  const box = document.querySelector(`[data-cat="${r.dataset.cat}"]`);
  const text = $('#filter').value.trim().toLowerCase();
  return (!box || box.checked) && (!text || r.dataset.text.includes(text));
}

function append(e) {
  const log = $('#log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const r = row(e);
  r.hidden = !visible(r);
  log.append(r);
  while (log.childElementCount > MAX_ROWS) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function rebuild() {
  const log = $('#log');
  log.replaceChildren();
  for (const e of events.slice(-MAX_ROWS)) {
    const r = row(e);
    r.hidden = !visible(r);
    log.append(r);
  }
  log.scrollTop = log.scrollHeight;
}

function refilter() {
  for (const r of $('#log').children) r.hidden = !visible(r);
}

// ============================================================== channel ===
function connect() {
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    $('#title').textContent = 'This browser has no BroadcastChannel - use the JS console on the stage';
    return;
  }
  channel.onmessage = ({ data }) => {
    lastMessage = Date.now();
    switch (data.kind) {
      case 'snapshot':
        meta = data.meta;
        live = data.live;
        events = data.events || [];
        renderMeta(); renderLive(); rebuild();
        break;
      case 'begin':
        meta = data.meta;
        live = null;
        events = [];
        renderMeta(); renderLive(); rebuild();
        break;
      case 'event':
        events.push(data.event);
        if (events.length > MAX_ROWS) events.splice(0, events.length - MAX_ROWS);
        append(data.event);
        break;
      case 'tick':
        live = data.live;
        renderLive();
        break;
      default: break;
    }
  };
  channel.postMessage({ kind: 'hello' });
}

setInterval(() => {
  const running = live && ['running', 'waiting'].includes(live.state);
  if (running && Date.now() - lastMessage > 2000) {
    $('#dot').className = 'status-dot';
    $('#title').textContent = `${meta?.label ?? ''} · no signal - is the stage tab hidden or closed?`;
  }
}, 1000);

// ============================================================= controls ===
$('#pause').addEventListener('click', () => send('toggle-pause'));
$('#skip').addEventListener('click', () => send('skip'));
$('#abort').addEventListener('click', () => send('abort'));
$('#hud').addEventListener('click', () => send('hud'));
$('#jump').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Number(e.currentTarget.n.value);
  if (n > 0) send('jump', n);
});
$('#speed').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) send('speed', Number(b.dataset.value));
});
$('#copy').addEventListener('click', () => {
  if (meta?.command) navigator.clipboard?.writeText(meta.command);
});
$('#clear').addEventListener('click', () => { events = []; $('#log').replaceChildren(); });
$('#filter').addEventListener('input', refilter);
for (const box of document.querySelectorAll('[data-cat]')) box.addEventListener('change', refilter);

// keys typed here drive the stage, so this window can keep the focus
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea')) return;
  const name = keyName(e);
  if (e.target.closest('button') && (name === 'space' || name === 'return')) return;
  if (!live || live.state === 'idle') return;
  send('key', name);
  e.preventDefault();
});

// theme, shared with the launcher
const THEME = 'innerspeech-demo/theme';
function applyTheme(value) {
  if (value === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  $('#theme').textContent = `Theme: ${value}`;
}
let theme = 'auto';
try { theme = JSON.parse(localStorage.getItem(THEME)) || 'auto'; } catch { /* storage blocked */ }
applyTheme(theme);
$('#theme').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  theme = order[(order.indexOf(theme) + 1) % order.length];
  try { localStorage.setItem(THEME, JSON.stringify(theme)); } catch { /* storage blocked */ }
  applyTheme(theme);
});

renderMeta();
renderLive();
connect();
