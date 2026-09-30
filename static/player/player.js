// The planner's launcher for the demo player.
//
// The lab's own launcher (V1/web/launcher.js) is a catalog of `config/*.yaml`
// and of designs mirrored from the planner.  Inside the planner there is
// nothing to mirror and the Export panel is the catalog, so this is the half
// that remains: the options, the run and bank pickers, and starting the stage.
//
// Everything below the surface is the lab's: stage.js plays the run, feed.js
// sends it to the debug window and the console, and the run itself is built by
// the builder's own code on the server (planner/demo.py).

import { Feed, clock } from './feed.js';
import { Stage, SPEEDS } from './stage.js';

const DEFAULTS = {
  seed: '', blocks: '', scanner: 'simulate', speed: 1,
  auto: false, debug: true, fullscreen: false, popup: false, hud: false,
};
const PRESETS = {
  quick: { blocks: 2, scanner: 'none', auto: true, speed: 5, debug: true },
  full: { blocks: '', scanner: 'simulate', auto: false, speed: 1 },
};
const SCANNER_LABEL = { none: 'no scanner', simulate: 'simulated pulses', key: 'trigger key' };
const STORE = 'planner-demo/options';
const THEME = 'planner-demo/theme';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** h('div', {class: 'x', onclick}, child, 'text', …) */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private window, blocked storage: fine */ }
  return undefined;
}

// ================================================================ state ===
const design = document.body.dataset.design;
const base = `/designs/${encodeURIComponent(design)}/demo/`;
const runs = JSON.parse($('#run-data').textContent);
const byStem = new Map(runs.map((r) => [r.stem, r]));

const feed = new Feed();
const stageEl = $('#stage');
const stage = new Stage(stageEl, feed, { onBack: back, onReplay: replay, openDebug });
let opts = { ...DEFAULTS, ...(store(STORE) || {}) };
let current = null;                      // {run, options, plan} while on stage
let debugWin = null;

feed.onCommand = (cmd, arg) => {
  if (stage.state === 'idle') return;
  switch (cmd) {
    case 'toggle-pause': stage.togglePause(); break;
    case 'skip': stage.skip(); break;
    case 'speed': stage.setSpeed(arg); break;
    case 'abort': stage.abort(); break;
    case 'hud': stage.toggleHud(); break;
    case 'jump': stage.jump(Number(arg)); break;
    case 'key': stage.key(arg); break;
    default: break;
  }
};

// ============================================================== pickers ===
function chosenRun() {
  return byStem.get($('#run').value) || runs[0];
}

function chosenBank() {
  const picker = $('#bank');
  return picker && picker.value ? picker.value : 'builtin';
}

/** A demo shortens a run, never lengthens it. */
function effectiveBlocks(run, o) {
  const b = parseInt(o.blocks, 10);
  if (!b || !run.n_blocks) return null;
  const n = Math.min(b, run.n_blocks);
  return n === run.n_blocks ? null : n;
}

function quote(s) {
  s = String(s);
  return /^[\w./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** The PsychoPy command that runs this same config with these same options. */
function commandFor(run, o, seed) {
  const parts = ['./run.sh', 'planner', '--design', quote(design),
    '--run', quote(run.id || run.stem)];
  if (seed !== '' && seed != null) parts.push('--seed', seed);
  const blocks = effectiveBlocks(run, o);
  if (blocks) parts.push('--blocks', blocks);
  if (o.scanner === 'none') parts.push('--no-scanner');
  if (o.auto) parts.push('--auto');
  if (o.debug) parts.push('--debug');
  if (!o.fullscreen) parts.push('--windowed');
  return parts.join(' ');
}

// =============================================================== banner ===
function banner(what, detail) {
  const el = $('#banner');
  el.replaceChildren();
  if (!what) { el.hidden = true; return; }
  el.append(h('strong', { class: 'what' }, what), detail || '');
  el.hidden = false;
}

// ============================================================= run card ===
function renderRun() {
  const run = chosenRun();
  const card = $('#run-card');
  history.replaceState(null, '', base + encodeURIComponent(run.stem) + location.search);
  document.title = `Demo — ${run.name || run.stem} — ${design}`;

  if (run.error) {
    card.replaceChildren();
    banner(`The builder will not load ${run.file}`, run.error);
    $('#play').disabled = true;
    return;
  }
  banner(null);
  $('#play').disabled = false;

  const [lo, hi] = run.run_len;
  const length = lo === hi ? clock(lo) : `${clock(lo)}–${clock(hi)}`;
  const skipped = Object.entries(run.skipped || {}).filter(([, v]) => v > 0);

  card.replaceChildren(h('div', { class: 'run-card' },
    h('h2', {}, run.name || run.stem),
    h('div', { class: 'file' }, `${run.file} · ${run.id}`),
    h('div', { class: 'stats' },
      h('span', {}, 'TR ', h('b', {}, `${run.tr} s`)),
      h('span', {}, h('b', {}, run.n_trials), ` trials (${run.n_blocks}×${run.per_block})`),
      h('span', { title: 'run length, shortest to longest jitter draw (m:ss)' },
        h('b', {}, length)),
      h('span', {}, `${run.dummies} dummies on `, h('code', {}, run.trigger_key))),
    h('div', { class: 'strip', title: 'one trial, phases at their mean length' },
      ...run.phases.map((p) => h('span', {
        style: `flex:${Math.max((p.lo + p.hi) / 2, 0.05)};background:var(--show-${p.show})`,
        title: `${p.name} · ${p.show} · ${p.lo === p.hi ? `${p.lo} s` : `${p.lo}–${p.hi} s ${p.jitter}`}`,
      }))),
    h('div', { class: 'strip-legend' },
      ...run.phases.map((p) => h('span', {},
        h('i', { style: `background:var(--show-${p.show})` }),
        `${p.name} ${p.lo === p.hi ? p.lo : `${p.lo}–${p.hi}`} s`))),
    h('div', { class: 'conds' },
      ...Object.entries(run.conditions).filter(([, n]) => n > 0)
        .map(([k, n]) => h('span', { class: 'chip' }, `${k} `, h('b', {}, n)))),
    skipped.length ? h('div', { class: 'footnote' },
      'Booked by the planner but not run by the task, so this clock is shorter than the '
      + 'design\'s run length: '
      + skipped.map(([k, v]) => `${k} ${v} s`).join(', ') + '.') : null));
}

// ================================================================ demo ===
async function play(overrides = {}) {
  const run = chosenRun();
  const o = { ...opts, ...overrides };
  // both need the click's user activation, so they come before any await
  if (o.popup) openDebug();
  if (o.fullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});

  const query = new URLSearchParams({ bank: chosenBank() });
  if (o.seed !== '' && o.seed != null) query.set('seed', o.seed);
  const blocks = effectiveBlocks(run, o);
  if (blocks) query.set('blocks', blocks);

  let plan;
  try {
    const res = await fetch(`${base}${encodeURIComponent(run.stem)}.json?${query}`,
      { headers: { Accept: 'application/json' } });
    plan = await res.json().catch(() => { throw new Error(`${res.status} ${res.statusText}`); });
    if (!res.ok) throw new Error(plan.error || `${res.status} ${res.statusText}`);
  } catch (e) {
    banner(`${run.name || run.stem} did not build`, e.message);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return;
  }
  /* The stage reads plan.leads and cfg.run.lead_in.show; a server from before
   * those existed answers without them, and the run would go black rather
   * than say why. Cheaper to notice here than to debug on a stage. */
  if (!plan.leads || !plan.cfg?.run?.lead_in?.name) {
    banner('This page and the server disagree',
      'The run came back without its lead-in and lead-out, which this player needs. '
      + 'Reload the page: it is running code from before the server was last rebuilt.');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return;
  }
  banner(null);

  const { cfg } = plan;
  const meta = {
    label: `${design} · ${run.name || run.stem}`,
    seed: plan.seed, source: plan.source, file: plan.source.file, experiment: cfg.experiment,
    n_trials: plan.trials.length, n_blocks: cfg.run.n_blocks, per_block: cfg.run.trials_per_block,
    phases: cfg.trial.phases.map((p) => p.name), lead_in: cfg.run.lead_in.name,
    tr: cfg.scanner.tr,
    dummies: cfg.scanner.wait_for_triggers, trigger_key: String(cfg.scanner.trigger_key),
    total: plan.total, n_questions: plan.n_questions, reused: plan.reused,
    options: { scanner: o.scanner, speed: o.speed, auto: o.auto, debug: o.debug, fullscreen: o.fullscreen },
    command: commandFor(run, o, plan.seed),
  };
  current = { run, options: o, plan };
  if (plan.reused) {
    toast(`${plan.reused} of ${plan.trials.length} trials reuse a question: `
      + `the bank holds ${plan.n_questions}.`);
  }
  $('#launcher').hidden = true;
  stageEl.hidden = false;
  document.body.classList.add('on-stage');
  stageEl.focus();
  stage.start(plan, o, meta);
}

function replay(sameSeed) {
  if (!current) return;
  const { options, plan } = current;
  play({ ...options, seed: sameSeed ? plan.seed : '' });
}

function back() {
  stage.stop();
  current = null;
  stageEl.hidden = true;
  document.body.classList.remove('on-stage');
  $('#launcher').hidden = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#play').focus();
}

function openDebug() {
  if (debugWin && !debugWin.closed) {
    debugWin.focus();
    return debugWin;
  }
  debugWin = window.open(`${base}debug.html`, 'planner-demo-debug', 'popup=yes,width=660,height=900');
  if (!debugWin) toast('The browser blocked the debug window. Allow popups for this page; the JS console has everything too.', true);
  return debugWin;
}

// ============================================================= options ===
function syncOptions() {
  store(STORE, opts);
  const form = $('#options');
  form.seed.value = opts.seed;
  form.blocks.value = opts.blocks;
  for (const name of ['auto', 'debug', 'fullscreen', 'popup', 'hud']) form[name].checked = !!opts[name];
  for (const seg of $$('.seg[data-name]', form)) {
    for (const b of $$('button', seg)) b.setAttribute('aria-pressed', String(b.dataset.value === String(opts[seg.dataset.name])));
  }
  for (const b of $$('[data-preset]')) {
    const p = PRESETS[b.dataset.preset];
    b.setAttribute('aria-pressed', String(Object.entries(p).every(([k, v]) => String(opts[k]) === String(v))));
  }
  const chips = [
    opts.seed !== '' ? `seed ${opts.seed}` : 'random seed',
    opts.blocks ? `≤ ${opts.blocks} blocks` : 'all blocks',
    SCANNER_LABEL[opts.scanner], `×${opts.speed}`,
    opts.auto && 'auto', opts.debug && 'debug keys', opts.fullscreen && 'fullscreen',
    opts.popup && 'debug window', opts.hud && 'HUD',
  ].filter(Boolean);
  $('#opt-chips').replaceChildren(...chips.map((c) => h('span', { class: 'chip' }, c)));
}

function bindOptions() {
  const form = $('#options');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    const el = e.target;
    if (el.type === 'checkbox') opts[el.name] = el.checked;
    else if (el.name === 'seed' || el.name === 'blocks') opts[el.name] = el.value.trim();
    syncOptions();
  });
  for (const seg of $$('.seg[data-name]', form)) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const name = seg.dataset.name;
      opts[name] = name === 'speed' ? Number(b.dataset.value) : b.dataset.value;
      syncOptions();
    });
  }
  for (const b of $$('[data-preset]')) {
    b.addEventListener('click', () => { Object.assign(opts, PRESETS[b.dataset.preset]); syncOptions(); });
  }
  $('#toggle-options').addEventListener('click', (e) => {
    form.hidden = !form.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
  });
  if (!SPEEDS.includes(Number(opts.speed))) opts.speed = 1;
  syncOptions();
}

// ================================================================ bits ===
let toastTimer = 0;
function toast(text, error = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3500);
}

function theme(next) {
  const order = ['auto', 'light', 'dark'];
  const value = next ?? store(THEME) ?? 'auto';
  if (value === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  $('#theme').textContent = `Theme: ${value}`;
  store(THEME, value);
  return order[(order.indexOf(value) + 1) % order.length];
}

// ========================================================= console API ===
window.demo = {
  get runs() { return runs; },
  get options() { return { ...opts }; },
  get state() { return stage.state; },
  get live() { return feed.live; },
  get plan() { return current?.plan ?? null; },
  get cfg() { return current?.plan.cfg ?? null; },
  get trials() { return current?.plan.trials ?? []; },
  get events() { return feed.events; },
  /** demo.play({speed: 10}), demo.play({seed: 7, blocks: 1}) */
  play: (overrides = {}) => play(overrides),
  /** demo.run('run-aim-2-question-run') picks it, then play() */
  run(stem) {
    if (!byStem.has(stem)) return console.warn(`no run ${JSON.stringify(stem)}; try one of`, [...byStem.keys()]);
    $('#run').value = stem;
    renderRun();
    return stem;
  },
  pause: () => stage.pause(),
  resume: () => stage.resume(),
  skip: () => stage.skip(),
  jump: (n, phase) => stage.jump(n, phase),
  speed: (x) => stage.setSpeed(x),
  abort: () => stage.abort(),
  hud: () => stage.toggleHud(),
  debug: () => openDebug(),
  back: () => back(),
  help() {
    console.log([
      'demo.run("<run stem>") · demo.play({speed, blocks, seed, scanner, auto, debug})',
      'demo.pause() resume() skip() jump(trial, phase?) speed(1|2|5|10|30) abort() hud() debug() back()',
      'demo.state · live · plan · cfg · trials · events · runs · options',
    ].join('\n'));
  },
};

// ================================================================ boot ===
bindOptions();
let nextTheme = theme();
$('#theme').addEventListener('click', () => { nextTheme = theme(nextTheme); });
$('#open-debug').addEventListener('click', openDebug);
$('#play').addEventListener('click', () => play());
$('#run').addEventListener('change', renderRun);
$('#bank').addEventListener('change', () => store('planner-demo/bank', chosenBank()));
const keptBank = store('planner-demo/bank');
if (keptBank && [...$('#bank').options].some((o) => o.value === keptBank)) $('#bank').value = keptBank;
document.addEventListener('keydown', (e) => {
  if (!stageEl.hidden) return;
  if (e.key === 'Enter' && !e.target.closest('input, select, textarea, button, a')) play();
});
feed.idle();
renderRun();
