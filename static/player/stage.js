// Plays one run in the browser, the way innerspeech/session.py presents it.
//
// Time zero is the last dummy pulse. Every phase boundary is an absolute offset
// from it (lead-in, trials, lead-out on one schedule), a phase ends half a frame
// early so the next screen lands on time, and a phase's onset is measured at the
// first frame after the screen changed. The trials come from the task's own
// builder (POST /api/plan), so a seed gives the same run as PsychoPy.
//
// The run clock is virtual so a demo can go faster than real time, pause (t0
// moves forward, as with --debug), or skip a phase. Nothing is recorded.
//
// Everything on screen comes from the merged config (plan.cfg, over
// config/defaults.yaml), as it does in PsychoPy.

import { badge, clock } from './feed.js';

const SVG = 'http://www.w3.org/2000/svg';
const TICK_MS = 100;                     // live state to the popup, like console.refresh_hz: 10
export const SPEEDS = [1, 2, 5, 10, 30];

/** KeyboardEvent -> PsychoPy key name. */
export function keyName(e) {
  const named = {
    ' ': 'space', Escape: 'escape', Enter: 'return', Tab: 'tab', Backspace: 'backspace',
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    '+': 'plus', '=': 'equal', '-': 'minus',
  };
  return named[e.key] || (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
}

/** PsychoPy rgb (-1..1) or a colour name -> CSS. */
function css(colour) {
  if (Array.isArray(colour)) {
    const [r, g, b] = colour.map((v) => Math.round(Math.min(1, Math.max(0, (v + 1) / 2)) * 255));
    return `rgb(${r} ${g} ${b})`;
  }
  return String(colour ?? 'white');
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** Python's str.format for plain `{name}` fields, as the config's messages use. */
const format = (template, vars) => String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/** Run-clock seconds: base + real time since anchor × speed; frozen while paused. */
class RunClock {
  constructor(speed) { this.base = 0; this.anchor = 0; this.speed = speed; this.running = false; }
  start(at) { this.base = 0; this.anchor = at; this.running = true; }
  at(ms) { return this.running ? this.base + ((ms - this.anchor) / 1000) * this.speed : this.base; }
  now() { return this.at(performance.now()); }
  _rebase() { const now = performance.now(); this.base = this.at(now); this.anchor = now; }
  pause() { this._rebase(); this.running = false; }
  resume() { this.anchor = performance.now(); this.running = true; }
  setSpeed(x) { this._rebase(); this.speed = x; }
  shift(seconds) { this._rebase(); this.base += seconds; }
}

export class Stage {
  constructor(root, feed, hooks) {
    this.root = root;
    this.feed = feed;
    this.hooks = hooks;                  // { onBack, onReplay(sameSeed), openDebug }
    this.state = 'idle';
    this.raf = 0;
    this._onKey = (e) => this._keydown(e);
    this._onResize = () => this._layout();
    this._onVisibility = () => {
      if (document.hidden && ['running', 'waiting'].includes(this.state)) {
        this.feed.emit('warn', { text: 'tab hidden - the browser stops drawing frames; phases will be skipped' });
      }
    };
  }

  // ================================================================ setup ===
  start(plan, opts, meta) {
    this.stop();
    this.plan = plan;
    this.opts = opts;
    this.meta = meta;
    const cfg = this.cfg = plan.cfg;
    this.trials = plan.trials;
    this.keys = {
      quit: cfg.keys.quit,
      advance: cfg.keys.advance,
      pause: cfg.keys.pause,
      trigger: String(cfg.scanner.trigger_key),
    };
    this.clock = new RunClock(opts.speed || 1);
    this.segs = this._schedule();
    this.idx = -1;
    this.cur = null;
    this.pending = null;
    this.vol = 0;
    this.pulses = 0;
    this.pauses = [];
    this.skips = 0;
    this.speedsUsed = new Set([this.clock.speed]);
    this.presented = 0;
    this.drifts = [];
    this.frames = { last: 0, intervals: [], dur: 1000 / 60, dropped: 0, count: 0 };
    this.nextTick = 0;
    this.realStart = performance.now();
    this.hud = !!opts.hud;

    this._build();
    this._preload();
    this.feed.begin(meta, plan);
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
    this.raf = requestAnimationFrame((ts) => this._frame(ts));
    this._instructions();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.root.replaceChildren();
    if (this.state !== 'idle') this.feed.idle();
    this.state = 'idle';
  }

  /** Every on-screen segment, lead-in to lead-out, as overview.Design._timeline. */
  _schedule() {
    const { lead_in: li, lead_out: lo } = this.cfg.run;
    const leads = this.plan.leads;       // drawn by bank.lead_durations, as session.py
    const segs = [{ t0: 0, t1: leads.lead_in, show: li.show, name: li.name, trial: null }];
    let cursor = round4(leads.lead_in);
    for (const trial of this.trials) {
      trial.t_start = round4(cursor);
      for (const phase of this.cfg.trial.phases) {
        const start = cursor;
        cursor += trial.durations[phase.name];
        // session.run_trial paints nothing for the question on cue-only trials
        const show = phase.show === 'question' && !trial.show_question ? 'blank' : phase.show;
        segs.push({ t0: start, t1: cursor, show, kind: phase.show, name: phase.name, trial });
      }
      cursor = round4(cursor);           // trial["t_end"] = round(cursor, 4)
    }
    segs.push({ t0: cursor, t1: cursor + leads.lead_out, show: lo.show, name: lo.name, trial: null });
    this.total = cursor + leads.lead_out;
    return segs;
  }

  _build() {
    const cfg = this.cfg;
    const font = `"${cfg.text.font}", "Helvetica Neue", Helvetica, Arial, sans-serif`;
    this.root.replaceChildren();
    this.root.classList.toggle('hide-cursor', !cfg.window.mouse_visible);

    const screen = this.screen = document.createElement('div');
    screen.className = 'screen';
    screen.style.background = css(cfg.window.color);
    screen.style.fontFamily = font;

    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.classList.add('shapes');
    this.polys = Array.from({ length: cfg.views.shapes.max_shapes }, () => {
      const p = document.createElementNS(SVG, 'polygon');
      this.svg.append(p);
      return p;
    });
    this.img = document.createElement('img');
    this.img.className = 'image';
    this.img.alt = '';

    const el = ([x, y], h, colour, wrap, family) => {
      const e = document.createElement('div');
      e.className = 'el';
      e.style.setProperty('--x', x);
      e.style.setProperty('--y', y);
      e.style.setProperty('--h', h);
      if (wrap) e.style.setProperty('--w', wrap);
      e.style.color = css(colour);
      e.style.textAlign = cfg.text.align;
      if (family) e.style.fontFamily = `"${family}", ${font}`;
      return e;
    };
    const t = cfg.text;
    // fixation and every other `screens:` entry
    this.screens = Object.fromEntries(Object.entries(cfg.screens).map(([name, s]) => {
      const e = el(s.pos, s.height, s.color, null, s.font);
      e.textContent = s.text;
      return [name, e];
    }));
    this.cue = el(cfg.cue.pos, cfg.cue.height, cfg.cue.color);
    this.message = el([0, 0], t.height, t.color, t.wrap_width);
    this.qtext = el([0, 0], t.height, t.color, t.wrap_width);
    const p = cfg.messages.paused;
    this.paused = el(p.pos, p.height, p.color, null, p.font);
    this.paused.textContent = format(p.text, { keys: this.keys.pause.join('/') });
    screen.append(this.svg, this.img, ...Object.values(this.screens), this.cue, this.qtext,
      this.message, this.paused);

    this.hudEl = document.createElement('div');
    this.hudEl.className = 'hud';
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'stage-toast';
    this.endEl = document.createElement('div');
    this.endEl.className = 'stage-end';
    this.root.append(screen, this.hudEl, this.toastEl, this.endEl);
    this._paint('blank');
    this._layout();
    this.hudEl.hidden = !this.hud;
    this.paused.hidden = true;
    this.toastEl.hidden = true;
    this.endEl.hidden = true;
  }

  /** Height units: 1 = the screen's height. Windowed keeps window.size's aspect. */
  _layout() {
    if (!this.screen) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let w = vw, h = vh;
    if (!this.opts.fullscreen) {
      const [sw, sh] = this.cfg.window.size;
      const aspect = sw / sh;
      if (vw / vh > aspect) { h = vh; w = h * aspect; } else { w = vw; h = w / aspect; }
    }
    this.screen.style.width = `${w}px`;
    this.screen.style.height = `${h}px`;
    this.screen.style.setProperty('--u', `${h}px`);
    this.unit = h;
    const a = w / h;
    this.svg.setAttribute('viewBox', `${-a / 2} -0.5 ${a} 1`);
    this._sizeImage();
  }

  _preload() {
    const urls = new Set(this.trials.map((t) => t.image_url).filter(Boolean));
    this.images = {};
    for (const url of urls) {
      const im = new Image();
      im.src = url;
      this.images[url] = im;
    }
    for (const t of this.trials) {
      if (t.view === 'image' && !t.image_url) {
        this.feed.emit('warn', { text: `image not found for "${t.text}": ${t.params.image} (PsychoPy would stop here)` });
      }
    }
  }

  // ============================================================== drawing ===
  _paint(show, trial) {
    for (const e of [...Object.values(this.screens), this.cue, this.qtext, this.message]) e.hidden = true;
    for (const p of this.polys) p.setAttribute('points', '');
    this.img.hidden = true;
    if (this.screens[show]) this.screens[show].hidden = false;
    else if (show === 'cue') { this.cue.textContent = trial.cue; this.cue.hidden = false; }
    else if (show === 'question') this._question(trial);
    else if (show === '@message') this.message.hidden = false;   // instructions and pulses; '@' keeps it apart from screen names
  }

  _question(trial) {
    const t = this.cfg.text;
    const view = trial.view;
    const [x, y] = view === 'text' ? this.cfg.views.text.pos : t.title_pos;
    this.qtext.style.setProperty('--x', x);
    this.qtext.style.setProperty('--y', y);
    this.qtext.textContent = trial.text;
    this.qtext.hidden = false;
    if (view === 'shapes') {
      const shapes = this.cfg.views.shapes;
      (trial.params.shapes || []).slice(0, shapes.max_shapes).forEach((spec, i) => {
        const edges = shapes.edges[spec.kind];
        if (!edges) { this._toast(`unknown shape kind "${spec.kind}" (PsychoPy would stop here)`); return; }
        const r = spec.size ?? shapes.size;
        // first vertex straight up; PsychoPy's ori turns clockwise
        const ori = ((spec.ori ?? shapes.default_ori[spec.kind] ?? 0) * Math.PI) / 180;
        const [px, py] = spec.pos;
        const pts = [];
        for (let e = 0; e < edges; e++) {
          const a = (e * 2 * Math.PI) / edges + ori;
          pts.push(`${(px + r * Math.sin(a)).toFixed(5)},${(-(py + r * Math.cos(a))).toFixed(5)}`);
        }
        const poly = this.polys[i];
        poly.setAttribute('points', pts.join(' '));
        poly.setAttribute('fill', css(spec.color ?? shapes.color));
        poly.setAttribute('stroke', css(spec.color ?? shapes.color));
        poly.setAttribute('stroke-width', '0.002');
      });
    } else if (view === 'image' && trial.image_url) {
      this.img.src = trial.image_url;
      this.imgTrial = trial;
      this.img.hidden = false;
      this._sizeImage();
    } else if (view !== 'text' && view !== 'image') {
      this._toast(`unknown view "${view}" - shown as text`);
    }
  }

  /** ImageStim at views.image.pos: params.size, else its pixels ÷ window height. */
  _sizeImage() {
    const trial = this.imgTrial;
    if (!trial || this.img.hidden) return;
    const im = this.images[trial.image_url];
    let [w, h] = trial.params.size || [];
    if (!w) {
      const winH = this.cfg.window.size[1];
      if (!im?.naturalWidth) { im?.addEventListener('load', () => this._sizeImage(), { once: true }); return; }
      [w, h] = [im.naturalWidth / winH, im.naturalHeight / winH];
    }
    const [x, y] = this.cfg.views.image.pos;
    Object.assign(this.img.style, {
      width: `${w * this.unit}px`, height: `${h * this.unit}px`,
      left: `calc(50% + ${x * this.unit}px)`, top: `calc(50% - ${y * this.unit}px)`,
    });
  }

  _toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, 1800);
  }

  // ============================================================ run flow ===
  _setState(state, detail) {
    this.state = state;
    this.feed.emit('state', { state, detail });
    this._tick(performance.now(), true);
  }

  _instructions() {
    this.message.textContent = this.cfg.instructions || '';
    this._paint('@message');
    this._setState('instructions', this.opts.auto ? 'auto-advancing'
      : `press ${this.keys.advance.join('/')}`);
    if (this.opts.auto) this.timer = setTimeout(() => this._waitForScanner(), this.cfg.pilot.auto_advance * 1000);
  }

  _waitForScanner() {
    const n = this.cfg.scanner.wait_for_triggers;
    const mode = this.opts.scanner;
    if (mode === 'none' || !n) {
      this._scanStart(performance.now(), 'no scanner - t0 is now');
      return;
    }
    this.pulses = 0;
    this._showPulses();
    this._setState('waiting', mode === 'key'
      ? `press ${this.keys.trigger} ${n}× (the trigger key)`
      : `simulating ${n} dummy pulses at TR ${this.cfg.scanner.tr} s`);
    if (mode === 'simulate') this._simulatePulse();
  }

  _showPulses() {
    const n = this.cfg.scanner.wait_for_triggers;
    this.message.textContent = format(this.cfg.messages.waiting, { seen: this.pulses, total: n });
    this._paint('@message');
  }

  _simulatePulse() {
    this.timer = setTimeout(() => {
      if (this.state !== 'waiting') return;
      this._pulse(performance.now(), 'simulated');
      if (this.state === 'waiting') this._simulatePulse();
    }, (this.cfg.scanner.tr * 1000) / this.clock.speed);
  }

  _pulse(at, how) {
    const n = this.cfg.scanner.wait_for_triggers;
    this.pulses += 1;
    this.feed.emit('pulse', { n: this.pulses, of: n, how });
    this._showPulses();
    this._tick(performance.now(), true);
    if (this.pulses >= n) this._scanStart(at, `locked to pulse ${n}/${n} (${how})`);
  }

  _scanStart(at, how) {
    clearTimeout(this.timer);
    this.clock.start(at);
    this.vol = 0;
    this.feed.emit('scan_start', { how });
    if (document.hidden) {
      this.feed.emit('warn', { text: 'the scan started in a hidden tab - the browser draws no frames there, so phases will be skipped' });
    }
    this._setState('running');
  }

  _frame(ts) {
    if (this.state === 'done' || this.state === 'aborted') return;
    this.raf = requestAnimationFrame((t) => this._frame(t));
    this._frameStats(ts);
    if (this.state !== 'running' && this.state !== 'paused') {
      this._tick(ts);
      return;
    }
    const t = this.clock.at(ts);
    let changed = false;
    if (this.pending && ts > this.pending.dirty) this._measure(t);
    if (this.state === 'running') {
      // like session._present: a phase ends half a frame early, so the next lands on time
      const half = (this.frames.dur / 1000) * this.clock.speed / 2;
      let i = Math.max(this.idx, 0);
      while (i < this.segs.length && t >= this.segs[i].t1 - half) i++;
      if (i >= this.segs.length) { this._finish(t); return; }
      if (i !== this.idx) { this._enter(i, ts); changed = true; }
      if (this.opts.scanner === 'simulate') {
        const vol = Math.floor(t / this.cfg.scanner.tr) + 1;
        if (vol > this.vol) {
          this.vol = vol;
          this.feed.emit('trigger', { vol, t: round4(t), how: 'simulated' });
        }
      }
    }
    this._tick(ts, changed);             // a new phase always reaches the popup
  }

  _enter(i, ts) {
    // segments jumped over in one frame (a fast speed, a hidden tab) never showed
    for (let j = this.idx + 1; j < i; j++) {
      const seg = this.segs[j];
      if (seg.trial && seg.trial !== this.cur) this._trial(seg.trial);
      this._phase(seg, null);
    }
    const seg = this.segs[i];
    this.idx = i;
    if (seg.trial !== this.cur) this._trial(seg.trial);
    this._paint(seg.show, seg.trial);
    if (this.pending) this._phase(this.pending.seg, null);
    this.pending = { seg, dirty: ts };
  }

  _trial(trial) {
    this.cur = trial;
    if (!trial) return;
    this.presented += 1;
    const next = this.trials[trial.trial + 1] || null;
    this.feed.emit('trial', { trial: this._brief(trial), next: next && this._brief(next) });
  }

  _measure(t) {
    const seg = this.pending.seg;
    this.pending = null;
    this._phase(seg, t);
  }

  _phase(seg, meas) {
    const drift = meas == null ? null : ((meas - seg.t0) / this.clock.speed) * 1000;   // real ms
    if (drift != null && this.clock.speed === 1) this.drifts.push(drift);
    this.feed.emit('phase', {
      name: seg.name, show: seg.show, trial: seg.trial ? seg.trial.trial : null,
      sched: round4(seg.t0), meas: meas == null ? null : round4(meas),
      dur: round4(seg.t1 - seg.t0), drift_ms: drift == null ? null : Math.round(drift * 10) / 10,
    });
  }

  _finish(t) {
    this.state = 'done';
    this.pending = null;
    const summary = this._summary(t);
    this.feed.emit('done', { text: `${summary.trials} trials in ${clock(t)} (${this._realText()} real)`, summary });
    this._setState('done');
    this._paint('blank');
    this._end(summary);
  }

  // ============================================================= controls ===
  abort() {
    if (['idle', 'done', 'aborted'].includes(this.state)) return;
    clearTimeout(this.timer);
    const t = this.clock.running || this.state === 'paused' ? this.clock.now() : null;
    const summary = this._summary(t);
    const where = t == null ? `before the scan started (${this.state})` : `at ${clock(t)}`;
    this.state = 'aborted';
    this.feed.emit('abort', { text: `${where} - ${summary.trials}/${summary.n_trials} trials presented`, summary });
    this._setState('aborted', where);
    this.paused.hidden = true;
    this._end(summary);
  }

  pause() {
    if (this.state !== 'running') return false;
    this.clock.pause();
    this.pauses.push({ at: round4(this.clock.base), duration: null, real: performance.now() });
    this.state = 'paused';
    this.paused.hidden = false;
    this.feed.emit('pause', { t: round4(this.clock.base), text: `paused at ${clock(this.clock.base)}` });
    this._setState('paused');
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    const entry = this.pauses[this.pauses.length - 1];
    const held = (performance.now() - entry.real) / 1000;
    entry.duration = round4(held);
    this.clock.resume();
    this.state = 'running';
    this.paused.hidden = true;
    this.feed.emit('resume', { t: entry.at, held: entry.duration, text: `after ${held.toFixed(1)} s - t0 moved forward` });
    this._setState('running');
    return true;
  }

  togglePause() { return this.pause() || this.resume(); }

  /** End the current phase now; everything after it moves up. */
  skip() {
    if (this.state === 'instructions') { clearTimeout(this.timer); this._waitForScanner(); return; }
    if (this.state === 'waiting') { this._scanStart(performance.now(), 'skipped the dummy pulses'); return; }
    if (this.state !== 'running' || this.idx < 0) return;
    const seg = this.segs[this.idx];
    const left = seg.t1 - this.clock.now();
    if (left <= 0) return;
    this.clock.shift(left);
    this.skips += 1;
    this.feed.emit('skip', { name: seg.name, by: round4(left), text: `${seg.name}: ${left.toFixed(2)} s skipped` });
  }

  /** Go to trial `n` (1-based), at its first phase or the one named; debugging only. */
  jump(n, phase = null) {
    if (this.state !== 'running' && this.state !== 'paused') return false;
    const k = this.segs.findIndex((s) => s.trial && s.trial.trial === n - 1 && (!phase || s.name === phase));
    if (k < 1) return false;
    this.clock.shift(this.segs[k].t0 - this.clock.now());
    this.idx = k - 1;                    // the next frame enters segment k
    this.cur = null;                     // so the jump announces its trial
    this.pending = null;
    this.skips += 1;
    const where = `trial ${n}${phase ? ` ${phase}` : ''}`;
    this.feed.emit('skip', { name: where, by: null, text: `jumped to ${where} at ${clock(this.segs[k].t0)}` });
    if (this.state === 'paused') {       // show it now, and stay paused
      this._enter(k, performance.now());
      this.pending = null;
    }
    this._tick(performance.now(), true);
    return true;
  }

  setSpeed(x) {
    x = Number(x);
    if (!SPEEDS.includes(x) || !this.clock || x === this.clock.speed) return;
    this.clock.setSpeed(x);
    this.speedsUsed.add(x);
    this.feed.emit('speed', { speed: x, text: `×${x}` });
    this._toast(`speed ×${x}`);
    if (this.state === 'waiting' && this.opts.scanner === 'simulate') {
      clearTimeout(this.timer);
      this._simulatePulse();
    }
    this._tick(performance.now(), true);
  }

  faster(dir) {
    const i = SPEEDS.indexOf(this.clock.speed) + dir;
    if (i >= 0 && i < SPEEDS.length) this.setSpeed(SPEEDS[i]);
  }

  toggleHud() {
    this.hud = !this.hud;
    this.hudEl.hidden = !this.hud;
    if (this.hud) this._hud(this.clock.now());
  }

  /** A key by PsychoPy name, from this window or relayed from the popup. */
  key(name, at = performance.now()) {
    const k = this.keys;
    if (this.state === 'done' || this.state === 'aborted') {
      if (k.quit.includes(name) || name === 'escape') this.hooks.onBack();
      else if (name === 'r') this.hooks.onReplay(true);
      else if (name === 'n') this.hooks.onReplay(false);
      return true;
    }
    if (k.quit.includes(name)) { this.abort(); return true; }
    if (this.state === 'instructions') {
      if (k.advance.includes(name)) { clearTimeout(this.timer); this._waitForScanner(); return true; }
    } else if (this.state === 'waiting') {
      if (name === k.trigger && this.opts.scanner === 'key') { this._pulse(at, 'key'); return true; }
    } else if (this.state === 'running' || this.state === 'paused') {
      if (this.opts.debug && k.pause.includes(name)) { this.togglePause(); return true; }
      if (name === k.trigger && this.state === 'running') {
        this.feed.emit('trigger', { vol: null, t: round4(this.clock.at(at)), how: 'key' });
        return true;
      }
    }
    if (this.opts.debug) {
      if (name === 'right') { this.skip(); return true; }
      if (name === 'plus' || name === 'equal') { this.faster(1); return true; }
      if (name === 'minus') { this.faster(-1); return true; }
    }
    if (name === 'h') { this.toggleHud(); return true; }
    if (name === 'd') { this.hooks.openDebug(); return true; }
    return false;
  }

  _keydown(e) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('.stage-end') && ['space', 'return'].includes(keyName(e))) return;   // buttons
    if (this.key(keyName(e), e.timeStamp)) e.preventDefault();
  }

  // ========================================================== live state ===
  _frameStats(ts) {
    const f = this.frames;
    if (f.last) {
      const dt = ts - f.last;
      f.intervals.push(dt);
      if (f.intervals.length > 120) f.intervals.shift();
      if (f.count++ % 30 === 0 && f.intervals.length >= 20) {
        const sorted = [...f.intervals].sort((a, b) => a - b);
        f.dur = sorted[Math.floor(sorted.length / 2)];
      }
      if (this.state === 'running' && !document.hidden && dt > f.dur * 1.5 && dt < 1000) f.dropped += 1;
    }
    f.last = ts;
  }

  _fps() {
    const iv = this.frames.intervals.slice(-30);
    return iv.length ? 1000 / (iv.reduce((a, b) => a + b, 0) / iv.length) : 0;
  }

  /** The token's colour role: the first answer label, the second, a constant word, or silence. */
  _role(token) {
    const [first, second] = this.cfg.responses.labels;
    return token == null ? 'none' : token === first ? 'first' : token === second ? 'second' : 'constant';
  }

  _brief(trial) {
    return {
      i: trial.trial, n: this.trials.length, block: trial.block, n_blocks: this.cfg.run.n_blocks,
      condition: trial.condition, answer: trial.answer, token: trial.response_token,
      role: this._role(trial.response_token), silent: this.cfg.responses.silent_label,
      text: trial.text, show_question: trial.show_question, view: trial.view, cue: trial.cue,
      family: trial.family, category: trial.category, uuid: trial.question_uuid,
      t_start: trial.t_start,
    };
  }

  _live(t) {
    const seg = this.idx >= 0 ? this.segs[this.idx] : null;
    const next = this.cur ? this.trials[this.cur.trial + 1] : this.trials[0];
    const maxDrift = this.drifts.length ? Math.max(...this.drifts.map(Math.abs)) : null;
    return {
      state: this.state, t: t == null ? null : round4(t), total: round4(this.total),
      speed: this.clock.speed, pulses: this.pulses, dummies: this.cfg.scanner.wait_for_triggers,
      span: seg && { name: seg.name, t0: seg.t0, t1: seg.t1, show: seg.show },
      phases: this.cfg.trial.phases.map((p) => p.name),
      now: this.cur && this._brief(this.cur), next: next ? this._brief(next) : null,
      trial_i: this.cur ? this.cur.trial : null, n_trials: this.trials.length,
      n_blocks: this.cfg.run.n_blocks, vol: this.vol, fps: Math.round(this._fps()),
      dropped: this.frames.dropped, max_drift_ms: maxDrift == null ? null : Math.round(maxDrift),
      pauses: this.pauses.length, skips: this.skips,
    };
  }

  _tick(ts, force = false) {
    if (!force && ts < this.nextTick) return;
    this.nextTick = ts + TICK_MS;
    const running = this.state === 'running' || this.state === 'paused';
    const t = running ? this.clock.at(ts) : null;
    this.feed.tick(this._live(t));
    if (this.hud) this._hud(t);
  }

  _hud(t) {
    const L = this._live(t);
    const lines = [`${this.meta.label}  ·  seed ${this.meta.seed}  ·  ×${L.speed}  ·  ${L.state}`];
    if (L.t == null) {
      lines.push(this.state === 'waiting' ? `pulses ${L.pulses}/${L.dummies}` : 'before the scan');
    } else {
      const pct = Math.min(100, Math.round((L.t / L.total) * 100));
      lines.push(`run    ${clock(L.t)} / ${clock(L.total)}  ${String(pct).padStart(3)}%   `
        + (L.now ? `trial ${L.now.i + 1}/${L.n_trials}  block ${L.now.block + 1}/${L.n_blocks}` : (L.span?.name ?? this.cfg.run.lead_in.name)));   // outside a trial: the lead-in or lead-out
      if (L.span) {
        const left = Math.max(0, L.span.t1 - L.t);
        lines.push(`phase  ${L.span.name}  ${left.toFixed(1)} s left`);
      }
      if (L.now) lines.push(`now    ${L.now.condition} · ${badge(L.now)}`);
      lines.push(`vol ${L.vol || '-'}  fps ${L.fps}  dropped ${L.dropped}  Δmax ${L.max_drift_ms ?? '-'} ms`);
    }
    const keys = ['h hud', 'd debug'];
    if (this.opts.debug) keys.unshift(`${this.keys.pause.join('/')} pause`, '→ skip', '+/- speed');
    lines.push(keys.join(' · '));
    this.hudEl.textContent = lines.join('\n');
  }

  _realText() {
    return clock((performance.now() - this.realStart) / 1000);
  }

  _summary(t) {
    const d = this.drifts;
    return {
      state: this.state, trials: this.presented, n_trials: this.trials.length,
      run_clock: t == null ? null : round4(t), total: round4(this.total),
      real_s: round4((performance.now() - this.realStart) / 1000),
      speeds: [...this.speedsUsed], pauses: this.pauses.map(({ at, duration }) => ({ at, duration })),
      skips: this.skips, dropped_frames: this.frames.dropped, frame_ms: round4(this.frames.dur),
      onset_drift_ms: d.length ? {
        n: d.length, mean: Math.round((d.reduce((a, b) => a + b, 0) / d.length) * 10) / 10,
        max_abs: Math.round(Math.max(...d.map(Math.abs)) * 10) / 10,
      } : null,
    };
  }

  // ============================================================ end panel ===
  _end(s) {
    const aborted = this.state === 'aborted';
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const drift = s.onset_drift_ms
      ? `mean ${s.onset_drift_ms.mean} ms · max |Δ| ${s.onset_drift_ms.max_abs} ms over ${s.onset_drift_ms.n} phases at ×1`
      : 'measured at ×1 only';
    this.endEl.innerHTML = `
      <div class="panel" role="dialog" aria-label="Run finished">
        <h2><span class="dot ${aborted ? 'aborted' : ''}"></span>${aborted ? 'Aborted' : 'Run complete'}</h2>
        <div class="file mono">${esc(this.meta.label)} · seed ${this.meta.seed}</div>
        <dl>
          ${row('trials', `${s.trials} / ${s.n_trials} presented`)}
          ${row('run clock', s.run_clock == null ? 'the scan never started' : `${clock(s.run_clock)} of ${clock(s.total)}`)}
          ${row('real time', `${clock(s.real_s)} at ×${s.speeds.join(', ×')}`)}
          ${row('frames', `${(1000 / s.frame_ms).toFixed(0)} Hz · ${s.dropped_frames} dropped`)}
          ${row('onsets', drift)}
          ${s.pauses.length || s.skips ? row('debug', `${s.pauses.length} pauses · ${s.skips} skips or jumps`) : ''}
        </dl>
        <div class="command"><span>${esc(this.meta.command)}</span><button class="small" data-act="copy">Copy</button></div>
        <div class="buttons">
          <button class="primary" data-act="again">Again, same seed</button>
          <button data-act="new">New seed</button>
          <button data-act="debug">Debug window</button>
          <button class="ghost" data-act="back">Back to list</button>
        </div>
        <div class="keys">r again · n new seed · esc back. The command reruns this seed in PsychoPy; it gives these trials for a participant with no earlier runs.</div>
      </div>`;
    this.endEl.hidden = false;
    this.root.classList.remove('hide-cursor');
    this.endEl.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'again') this.hooks.onReplay(true);
      else if (act === 'new') this.hooks.onReplay(false);
      else if (act === 'back') this.hooks.onBack();
      else if (act === 'debug') this.hooks.openDebug();
      else if (act === 'copy') {
        navigator.clipboard?.writeText(this.meta.command).then(() => this._toast('copied'), () => this._toast('copy failed'));
      }
    };
    this.endEl.querySelector('[data-act="again"]').focus();
  }
}
