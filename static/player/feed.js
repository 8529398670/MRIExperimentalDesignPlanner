// One event stream from the stage, to three places at once:
//
//   the debug popup      BroadcastChannel `innerspeech-demo` (debug.js)
//   the JS console       styled groups, one per trial (open devtools)
//   window.innerspeech   the same events, plus controls (launcher.js)
//
// The popup can open or reopen at any point: it says `hello` and gets a snapshot.

export const CHANNEL = 'innerspeech-demo';
const KEEP = 4000;                       // events kept for late joiners and the console API

// mid-tone colours that read on both light and dark devtools
const C = {
  badge: 'background:#046A38;color:#fff;border-radius:3px;padding:1px 5px;font-weight:600',
  gold: 'background:#CBA052;color:#101820;border-radius:3px;padding:1px 5px;font-weight:600',
  red: 'background:#B42318;color:#fff;border-radius:3px;padding:1px 5px;font-weight:600',
  dim: 'color:#8a8f94',
  bold: 'font-weight:600',
  plain: '',
  late: 'color:#d48a00;font-weight:600',
};
// by the token's role (stage.js `_role`): the first answer label, the second, a constant word, silence
export const TOKEN_COLOUR = { first: '#22a35a', second: '#d49b00', constant: '#1ba3b8', none: '#8a8f94' };

/** A trial brief's answer and token; `silent` is the config's responses.silent_label. */
export function badge(trial) {
  const token = trial.token;
  return `${trial.answer} → ${token ? token.toUpperCase() : trial.silent}`;
}

export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Feed {
  constructor() {
    this.events = [];
    this.meta = null;
    this.live = null;
    this.onCommand = null;               // set by the launcher: (cmd, arg) => void
    this.inGroup = false;
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e) => this._receive(e.data || {});
    } catch {
      this.channel = null;               // no popup, the console still works
    }
  }

  // ------------------------------------------------------------- channel ---
  _post(msg) {
    try { this.channel?.postMessage(msg); } catch { /* closed while unloading */ }
  }

  _receive(msg) {
    if (msg.kind === 'hello') {
      this._post({ kind: 'snapshot', meta: this.meta, live: this.live, events: this.events.slice(-800) });
    } else if (msg.kind === 'command' && this.onCommand) {
      this.onCommand(msg.cmd, msg.arg);
    }
  }

  // ---------------------------------------------------------------- stage ---
  /** A new run: header facts for the popup, the plan for the console. */
  begin(meta, plan) {
    this._closeGroup();
    this.meta = meta;
    this.events = [];
    this.live = null;
    this._post({ kind: 'begin', meta });
    this._logPlan(meta, plan);
  }

  emit(type, data = {}) {
    const event = { type, wall: Date.now(), ...data };
    this.events.push(event);
    if (this.events.length > KEEP) this.events.splice(0, this.events.length - KEEP);
    this._post({ kind: 'event', event });
    this._log(event);
    return event;
  }

  /** Live state, ~10 times a second; not kept, not logged. */
  tick(live) {
    this.live = live;
    this._post({ kind: 'tick', live });
  }

  idle() {
    this._closeGroup();
    this.live = { state: 'idle' };
    this._post({ kind: 'tick', live: this.live });
  }

  // -------------------------------------------------------------- console ---
  _closeGroup() {
    if (this.inGroup) { console.groupEnd(); this.inGroup = false; }
  }

  _logPlan(meta, plan) {
    console.groupCollapsed(
      `%cinnerspeech%c ${meta.label} · seed ${meta.seed} · ${meta.n_trials} trials · est. ${clock(meta.total)}`,
      C.badge, C.bold);
    console.log('source ', meta.source);
    console.log('config ', plan.cfg);
    console.table(plan.trials.map((t) => ({
      trial: t.trial + 1, block: t.block + 1, condition: t.condition, view: t.view,
      answer: t.answer, token: t.response_token ?? plan.cfg.responses.silent_label, cue: t.cue,
      text: t.show_question ? t.text : '(cue only)',
      ...Object.fromEntries(Object.entries(t.durations).map(([k, v]) => [k, v])),
    })));
    console.log(`%cPsychoPy, same trials (a participant with no earlier runs):%c ${meta.command}`, C.dim, C.plain);
    console.groupEnd();
    console.info('%cinnerspeech%c window.innerspeech: pause() resume() skip() jump(n) speed(5) abort() debug() hud() help() · state, trials, events',
      C.badge, C.dim);
  }

  _log(e) {
    switch (e.type) {
      case 'trial': {
        this._closeGroup();
        const t = e.trial;
        const colour = `color:${TOKEN_COLOUR[t.role]};font-weight:600`;
        console.groupCollapsed(
          `%ctrial ${t.i + 1}/${t.n}%c b${t.block + 1} · ${t.condition} %c${badge(t)}%c ${t.show_question ? t.text : '(cue only - not shown)'}`,
          C.badge, C.dim, colour, C.plain);
        this.inGroup = true;
        return;
      }
      case 'phase': {
        if (e.trial == null) this._closeGroup();       // the lead-in and lead-out stand alone
        const late = e.drift_ms != null && Math.abs(e.drift_ms) > 25;
        const drift = e.meas == null ? 'skipped - frame never shown'
          : `Δ ${e.drift_ms >= 0 ? '+' : ''}${e.drift_ms.toFixed(1)} ms`;
        console.log(`%c${e.name.padEnd(14)}%c ${e.show.padEnd(8)} t=${e.sched.toFixed(3)} s  ${e.dur.toFixed(2)} s  %c${drift}`,
          C.bold, C.dim, late || e.meas == null ? C.late : C.dim);
        return;
      }
      case 'pulse':
        console.debug(`pulse ${e.n}/${e.of} (${e.how})`);
        return;
      case 'trigger':
        console.debug(`${e.vol == null ? 'trigger key' : `volume ${e.vol}`} at t=${e.t.toFixed(3)} s (${e.how})`);
        return;
      case 'scan_start':
        console.info(`%cscan%c t0 ${e.how}`, C.gold, C.plain);
        return;
      case 'state':
        if (!['running', 'paused'].includes(e.state)) console.info(`%c${e.state}%c ${e.detail || ''}`, C.gold, C.dim);
        return;
      case 'pause': case 'resume': case 'skip': case 'speed':
        console.info(`%c${e.type}%c ${e.text}`, C.gold, C.plain);
        return;
      case 'warn':
        console.warn(`innerspeech: ${e.text}`);
        return;
      case 'done': case 'abort':
        this._closeGroup();
        console.info(`%c${e.type === 'done' ? 'complete' : 'aborted'}%c ${e.text}`,
          e.type === 'done' ? C.badge : C.red, C.plain, e.summary);
        return;
      default:
        console.log(e.type, e);
    }
  }
}
