/* MRI Experimental Design Planner - design model, constraint solver and text
 * generation.  Pure functions over a plain state object so that the same state
 * can be persisted, re-solved and exported without side effects.
 *
 * The design is a library of named things at five levels, each built from the
 * one below it:
 *
 *   trial       phase list: what one trial looks like second by second
 *   run         a trial design laid out into blocks, bound to an acquisition card
 *   session     one ordered list of blocks - setup, structurals, runs and
 *               breaks - in the order the console runs them
 *   experiment  a plan of sessions, with a goal and a share of scanner time
 *   study       every experiment together, inside one scanner-time budget
 *
 * Nothing in the hierarchy is fixed in number: add, rename, duplicate and
 * delete at any level.  Solving walks the levels bottom-up. */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------ helpers */

  function num(value, fallback) {
    var parsed = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(parsed)) return fallback === undefined ? 0 : fallback;
    return parsed;
  }

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function round(value, digits) {
    var factor = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round(value * factor) / factor;
  }

  function sum(list, pick) {
    var total = 0;
    for (var i = 0; i < list.length; i += 1) total += pick ? pick(list[i], i) : list[i];
    return total;
  }

  function fmtNumber(value, digits) {
    return num(value).toLocaleString('en-US', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits === undefined ? 0 : digits
    });
  }

  function trim(value, digits) {
    var text = num(value).toFixed(digits === undefined ? 1 : digits);
    return text.indexOf('.') >= 0 ? text.replace(/\.?0+$/, '') : text;
  }

  function fmtSeconds(seconds) {
    var value = num(seconds);
    if (value < 90) return trim(value, 1) + ' s';
    return num(value / 60).toFixed(1) + ' min';
  }

  function fmtRange(minValue, maxValue) {
    var lo = num(minValue), hi = num(maxValue);
    if (Math.abs(hi - lo) < 0.05) return fmtSeconds(lo);
    if (hi < 90) return trim(lo, 1) + ' - ' + trim(hi, 1) + ' s';
    return (lo / 60).toFixed(1) + ' - ' + (hi / 60).toFixed(1) + ' min';
  }

  function fmtMinutes(minutes) {
    var value = num(minutes);
    if (value < 60) return round(value, 1) + ' min';
    var hours = Math.floor(value / 60);
    return hours + ' h ' + round(value - hours * 60, 0) + ' min';
  }

  function fmtClock(seconds) {
    var value = Math.max(0, num(seconds));
    var minutes = Math.floor(value / 60);
    var rest = value - minutes * 60;
    if (minutes >= 60) {
      var hours = Math.floor(minutes / 60);
      return hours + ':' + pad(minutes % 60) + ':' + pad(Math.round(rest));
    }
    return pad(minutes) + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  function pad(value) {
    return (value < 10 ? '0' : '') + Math.floor(value);
  }

  function phaseLabel(phase) {
    var lo = round(num(phase.min), 1);
    var hi = round(num(phase.max), 1);
    if (Math.abs(hi - lo) < 0.001) return phase.name + ' (' + lo + 's)';
    if (phase.jitter) return phase.name + ' (jitter, ' + lo + '-' + hi + 's)';
    return phase.name + ' (' + lo + '-' + hi + 's)';
  }

  function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function plural(count, one, many) {
    return Math.abs(num(count) - 1) < 0.005 ? one : (many || one + 's');
  }

  /* Stable, readable identifiers.  A design file is meant to be diffed. */
  var idCounter = 0;
  function makeId(prefix) {
    idCounter += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36);
  }

  function uniqueName(existing, wanted) {
    var taken = {};
    (existing || []).forEach(function (item) { taken[String(item.name).toLowerCase()] = true; });
    var base = String(wanted || 'Untitled').trim() || 'Untitled';
    if (!taken[base.toLowerCase()]) return base;
    for (var i = 2; i < 999; i += 1) {
      var candidate = base + ' ' + i;
      if (!taken[candidate.toLowerCase()]) return candidate;
    }
    return base + ' ' + Date.now();
  }

  /* --------------------------------------------------------- vocabulary */

  var PHASE_ROLES = [
    { id: 'baseline', label: 'Fixation / baseline', regressor: false },
    { id: 'stimulus', label: 'Stimulus / cue', regressor: true },
    { id: 'delay', label: 'Delay / retention', regressor: false },
    { id: 'response', label: 'Response / probe window', regressor: true },
    { id: 'other', label: 'Other', regressor: false }
  ];

  /* Designs written against the study-specific vocabulary still load. */
  var LEGACY_ROLES = {
    fixation: 'baseline', question: 'stimulus', cue: 'stimulus',
    rest: 'delay', answer: 'response'
  };

  function normaliseRole(role) {
    var key = String(role || '').toLowerCase();
    if (LEGACY_ROLES[key]) return LEGACY_ROLES[key];
    return PHASE_ROLES.some(function (entry) { return entry.id === key; }) ? key : 'other';
  }

  var OBJECTIVES = [
    {
      id: 'detection',
      label: 'Detection (saturating)',
      blurb: 'Stack same-condition responses so the BOLD level never settles; maximises '
        + 'univariate contrast power per minute.',
      tolerancePct: 45,
      separationSeconds: 0
    },
    {
      id: 'estimation',
      label: 'Single-trial estimation',
      blurb: 'Maximises the estimability of individual trial betas, which is what '
        + 'linear multivariate decoding is actually trained on.',
      tolerancePct: 12,
      separationSeconds: 0
    },
    {
      id: 'separation',
      label: 'Full HRF separation',
      blurb: 'Returns to baseline between trials and resolves the stimulus response from '
        + 'the response window, giving clean event-aligned clips.',
      tolerancePct: 4,
      separationSeconds: 0
    }
  ];

  var SOLVE_MODES = [
    {
      id: 'budget', label: 'Hours available',
      blurb: 'Spend the whole scanner budget; the count collected is whatever the hours buy.'
    },
    {
      id: 'fill', label: 'One total goal',
      blurb: 'Fill as much of one study-wide goal as the hours allow, keeping the '
        + 'per-experiment split of scanner time.'
    },
    {
      id: 'target', label: 'Per-experiment goals',
      blurb: 'Each experiment runs until it reaches its own goal, however many hours that takes.'
    },
    {
      id: 'manual', label: 'Session counts',
      blurb: 'You set the number of sessions per experiment directly.'
    }
  ];

  var ALLOCATION_UNITS = [
    { id: 'percent', label: 'Percent', unit: '%' },
    { id: 'hours', label: 'Hours', unit: 'h' },
    { id: 'sessions', label: 'Sessions', unit: 'sess' }
  ];

  var LABEL_ORDERS = [
    { id: 'blocked', label: 'Blocked by condition' },
    { id: 'alternating', label: 'Strict alternation' },
    { id: 'intermixed', label: 'Intermixed and balanced' }
  ];

  /* Recommended trial timing per objective.
   *   detection  - saturating: minimal delay so successive same-condition
   *                responses stack instead of returning to baseline
   *   estimation - moderate separation so single-trial betas are estimable
   *   separation - full recovery: the stimulus response and the previous trial
   *                are both back at baseline before the next response window
   */
  var RECOMMENDED_TIMING = {
    detection: [
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'baseline' },
      { name: 'Stimulus', min: 4, max: 4, jitter: false, role: 'stimulus' },
      { name: 'Delay', min: 1, max: 2, jitter: true, role: 'delay' },
      { name: 'Response', min: 3, max: 3, jitter: false, role: 'response' },
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'baseline' }
    ],
    estimation: [
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'baseline' },
      { name: 'Stimulus', min: 4, max: 4, jitter: false, role: 'stimulus' },
      { name: 'Delay', min: 6, max: 10, jitter: true, role: 'delay' },
      { name: 'Response cue', min: 3, max: 3, jitter: false, role: 'response' },
      { name: 'Fixation', min: 10, max: 14, jitter: true, role: 'baseline' }
    ],
    separation: [
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'baseline' },
      { name: 'Stimulus', min: 4, max: 4, jitter: false, role: 'stimulus' },
      { name: 'Delay', min: 14, max: 16, jitter: true, role: 'delay' },
      { name: 'Response cue', min: 3, max: 3, jitter: false, role: 'response' },
      { name: 'Fixation', min: 24, max: 28, jitter: true, role: 'baseline' }
    ]
  };

  var DEFAULT_UNIT = { noun: 'trial', plural: 'trials', short: 'tr' };

  function unitOf(experiment) {
    var unit = (experiment && experiment.unit) || {};
    var noun = String(unit.noun || DEFAULT_UNIT.noun).trim() || DEFAULT_UNIT.noun;
    return {
      noun: noun,
      plural: String(unit.plural || (noun + 's')).trim() || noun + 's',
      short: String(unit.short || noun.slice(0, 2)).trim() || 'u'
    };
  }

  /* ------------------------------------------------- structural defaults */

  var STRUCTURAL_DEFAULTS = [
    { protocol: 'Survey-Localizer', enabled: true, count: 1 },
    { protocol: 'SENSE-Reference', enabled: true, count: 1 },
    { protocol: 'T1-Anatomical-MPRAGE', enabled: true, count: 1 },
    { protocol: 'T2-FLAIR', enabled: false, count: 1 },
    { protocol: 'EPI-SBRef', enabled: true, count: 1 },
    { protocol: 'Field-Map-Reverse-PE', enabled: true, count: 1 },
    { protocol: 'EPI-Dummy-Prescan', enabled: false, count: 1 }
  ];

  /* ---------------------------------------------------- session blocks */

  /* A session is one ordered list of blocks and nothing in it is pinned.  The
   * setup steps, the structural and reference scans, the functional runs and
   * the breaks are all the same kind of row: reorder, disable, edit or delete
   * any of them, anywhere in the list.  The defaults below are only where a
   * new session starts, not a rule about what has to come first. */

  var SETUP_DEFAULTS = [
    { label: 'MRI safety screening and consent check', minutes: 6 },
    { label: 'Positioning, coil placement, stabilisation', minutes: 5 },
    { label: 'Task refresher and cadence practice', minutes: 4 }
  ];

  var BLOCK_KINDS = ['prep', 'structural', 'run', 'break'];

  var BLOCK_LABELS = {
    prep: 'Setup',
    structural: 'Structural',
    run: 'Run',
    break: 'Break'
  };

  function makeBlock(kind, extra) {
    var block = { id: makeId('blk'), kind: kind, enabled: true };
    if (kind === 'prep') { block.label = 'Setup step'; block.minutes = 5; }
    else if (kind === 'break') { block.label = 'Break'; block.minutes = 3; }
    else if (kind === 'structural') { block.protocol = ''; block.count = 1; }
    else { block.run = ''; block.count = 1; }
    return Object.assign(block, extra || {});
  }

  /* The opening order a new session gets: setup, then structurals and
   * references, then whatever runs are added.  Every one of them can be moved
   * out of that position afterwards. */
  function defaultBlocks() {
    var blocks = SETUP_DEFAULTS.map(function (entry) {
      return makeBlock('prep', { label: entry.label, minutes: entry.minutes });
    });
    STRUCTURAL_DEFAULTS.forEach(function (entry) {
      blocks.push(makeBlock('structural', {
        protocol: entry.protocol, enabled: entry.enabled, count: entry.count
      }));
    });
    return blocks;
  }

  /* Bring a session up to the block list, from the old fixed shape (setup
   * fields, a structural list and a run list) or from a partly written one. */
  function normaliseBlocks(session) {
    var blocks = Array.isArray(session.blocks) ? session.blocks : null;
    if (!blocks) {
      blocks = [];
      [
        ['MRI safety screening and consent check', session.screeningMinutes, 6],
        ['Positioning, coil placement, stabilisation', session.positioningMinutes, 5],
        ['Task refresher and cadence practice', session.practiceMinutes, 4]
      ].forEach(function (row) {
        blocks.push(makeBlock('prep', { label: row[0], minutes: num(row[1], row[2]) }));
      });
      (Array.isArray(session.structurals) ? session.structurals : STRUCTURAL_DEFAULTS)
        .forEach(function (entry) {
          blocks.push(makeBlock('structural', {
            protocol: entry.protocol,
            enabled: entry.enabled !== false,
            count: num(entry.count, 1)
          }));
        });
      (Array.isArray(session.items) ? session.items : []).forEach(function (item) {
        blocks.push(makeBlock('run', { run: item.run, count: num(item.count, 1) }));
      });
    }

    session.blocks = blocks.map(function (block) {
      var kind = BLOCK_KINDS.indexOf(block && block.kind) >= 0 ? block.kind : 'prep';
      var out = makeBlock(kind);
      out.id = String((block && block.id) || out.id);
      out.enabled = !block || block.enabled !== false;
      if (kind === 'prep' || kind === 'break') {
        out.label = String((block && block.label) || out.label);
        out.minutes = Math.max(0, num(block && block.minutes, out.minutes));
      } else {
        out.count = Math.max(0, Math.round(num(block && block.count, 1)));
        if (kind === 'structural') out.protocol = String((block && block.protocol) || '');
        else out.run = String((block && block.run) || '');
      }
      return out;
    });

    if (session.autoBreak === undefined) session.autoBreak = true;
    session.autoBreak = !!session.autoBreak;
    session.breakMinutes = Math.max(0, num(session.breakMinutes, 3));
    delete session.screeningMinutes;
    delete session.positioningMinutes;
    delete session.practiceMinutes;
    delete session.structurals;
    delete session.items;
    return session;
  }

  var DEFAULT_HRF = {
    peakDelay: 6,
    peakDispersion: 1,
    undershootDelay: 16,
    undershootDispersion: 1,
    undershootRatio: 6,
    spanSeconds: 40,
    /* Where the planner reads the residual of an earlier event: at the peak of
     * the response it might contaminate.  Editable, because "separated" is a
     * judgement about when you intend to measure. */
    readLagSeconds: 5,
    objectives: {}
  };

  function defaultHrf() {
    var hrf = deepCopy(DEFAULT_HRF);
    hrf.objectives = {};
    OBJECTIVES.forEach(function (objective) {
      hrf.objectives[objective.id] = {
        label: objective.label,
        blurb: objective.blurb,
        tolerancePct: objective.tolerancePct,
        separationSeconds: objective.separationSeconds
      };
    });
    return hrf;
  }

  /* The objective definition in force, falling back to the shipped one. */
  function objectiveDef(state, id) {
    var key = id || 'separation';
    var base = OBJECTIVES.filter(function (o) { return o.id === key; })[0] || OBJECTIVES[2];
    var stored = ((state && state.hrf && state.hrf.objectives) || {})[key] || {};
    return {
      id: base.id,
      label: String(stored.label || base.label),
      blurb: String(stored.blurb || base.blurb),
      tolerancePct: clamp(num(stored.tolerancePct, base.tolerancePct), 0.25, 90),
      separationSeconds: Math.max(0, num(stored.separationSeconds, 0)),
      readLagSeconds: Math.max(0, num(state && state.hrf && state.hrf.readLagSeconds,
        DEFAULT_HRF.readLagSeconds))
    };
  }

  function applyHrf(state) {
    if (!global.PlannerEfficiency) return false;
    return global.PlannerEfficiency.configure((state && state.hrf) || DEFAULT_HRF);
  }

  /* --------------------------------------------------------- defaults */

  function defaultTrial(preset, name) {
    var objective = preset || 'estimation';
    return {
      id: makeId('trial'),
      name: name || 'Trial design',
      note: '',
      objective: objective,
      phases: deepCopy(RECOMMENDED_TIMING[objective] || RECOMMENDED_TIMING.estimation),
      conditions: { a: 'Condition A', b: 'Condition B' },
      conditionBalance: 50,
      controlPct: 0,
      separationTolerancePct: (OBJECTIVES.filter(function (o) {
        return o.id === objective;
      })[0] || OBJECTIVES[1]).tolerancePct,
      seed: 20260823
    };
  }

  function defaultRun(trialId, protocol, name) {
    return {
      id: makeId('run'),
      name: name || 'Run design',
      note: '',
      trial: trialId,
      protocol: protocol,
      trialsPerBlock: 10,
      blocksPerRun: 3,
      interTrialGap: 0,
      interBlockRest: 12,
      dummyVolumes: 8,
      leadIn: 12,
      leadOut: 12,
      labelOrder: 'intermixed',
      labelRunLength: 1
    };
  }

  function defaultSession(name) {
    return {
      id: makeId('session'),
      name: name || 'Session',
      note: '',
      /* An automatic break between two runs that end up next to each other.
       * Turn it off and place break blocks by hand instead. */
      autoBreak: true,
      breakMinutes: 3,
      blocks: defaultBlocks()
    };
  }

  /* Append run blocks to a session, in the order given. */
  function addRunBlocks(session, list) {
    (list || []).forEach(function (entry) {
      session.blocks.push(makeBlock('run', {
        run: entry.run, count: Math.max(0, Math.round(num(entry.count, 1)))
      }));
    });
    return session;
  }

  function defaultExperiment(name, short) {
    return {
      id: makeId('exp'),
      name: name || 'Experiment',
      short: short || 'EXP',
      note: '',
      enabled: true,
      unit: deepCopy(DEFAULT_UNIT),
      requestedPct: 100,
      locked: false,
      lockPlan: false,
      plan: [],
      targetUnits: 500,
      manualSessions: 10
    };
  }

  /* The design the planner opens on: one experiment per objective, so the
   * three ways of spending scanner time are visible side by side and can be
   * renamed, duplicated or deleted like anything else. */
  function defaultState() {
    var detection = defaultTrial('detection', 'Blocked detection trial');
    detection.controlPct = 0;
    var estimation = defaultTrial('estimation', 'Event-related trial');
    var separation = defaultTrial('separation', 'Fully separated trial');

    var runDetection = defaultRun(detection.id, 'EPI-TR2000-Task', 'Blocked detection run');
    runDetection.trialsPerBlock = 12;
    runDetection.blocksPerRun = 4;
    runDetection.interBlockRest = 20;
    runDetection.dummyVolumes = 6;
    runDetection.labelOrder = 'blocked';
    runDetection.labelRunLength = 12;

    var runEstimation = defaultRun(estimation.id, 'EPI-TR1000-Task', 'Event-related run');
    runEstimation.trialsPerBlock = 10;
    runEstimation.blocksPerRun = 3;
    runEstimation.dummyVolumes = 12;

    var runSeparation = defaultRun(separation.id, 'EPI-TR800-Task', 'Separated run');
    runSeparation.trialsPerBlock = 10;
    runSeparation.blocksPerRun = 2;
    runSeparation.dummyVolumes = 12;

    var sessionDetection = defaultSession('Detection session');
    addRunBlocks(sessionDetection, [{ run: runDetection.id, count: 2 }]);
    var sessionEstimation = defaultSession('Event-related session');
    addRunBlocks(sessionEstimation, [{ run: runEstimation.id, count: 3 }]);
    var sessionSeparation = defaultSession('Separation session');
    addRunBlocks(sessionSeparation, [{ run: runSeparation.id, count: 4 }]);
    var sessionMixed = defaultSession('Mixed session');
    sessionMixed.note = 'One session carrying runs from more than one experiment.';
    addRunBlocks(sessionMixed, [
      { run: runEstimation.id, count: 2 },
      { run: runSeparation.id, count: 2 }
    ]);

    var expDetection = defaultExperiment('Detection experiment', 'DET');
    expDetection.requestedPct = 12;
    expDetection.targetUnits = 400;
    expDetection.plan = [{ session: sessionDetection.id, count: 1 }];

    var expEstimation = defaultExperiment('Estimation experiment', 'EST');
    expEstimation.requestedPct = 28;
    expEstimation.targetUnits = 900;
    expEstimation.plan = [{ session: sessionEstimation.id, count: 1 }];

    var expSeparation = defaultExperiment('Separation experiment', 'SEP');
    expSeparation.requestedPct = 60;
    expSeparation.targetUnits = 2000;
    expSeparation.plan = [{ session: sessionSeparation.id, count: 1 }];

    return {
      version: 2,
      meta: {
        studyTitle: 'MRI Experimental Design',
        investigator: '',
        institution: 'Wright State University',
        participantId: 'SUB-01',
        designId: 'DESIGN-001',
        notes: ''
      },
      budget: {
        totalScannerHours: 120,
        contingencyPct: 8,
        solveMode: 'budget',
        targetUnitsTotal: 3000,
        allocationUnit: 'percent',
        sessionsPerWeek: 3,
        weeksAvailable: 30,
        countOverheadAgainstBudget: true,
        autoClamp: true
      },
      caps: {
        applyTo: 'expected',
        maxRunMinutes: 20,
        maxSessionMinutes: 120,
        maxRunsPerSession: 8,
        maxSessionsTotal: 100,
        maxContinuousMinutes: 25,
        minUnitsPerExperiment: 50
      },
      hrf: defaultHrf(),
      trials: [detection, estimation, separation],
      runs: [runDetection, runEstimation, runSeparation],
      sessions: [sessionDetection, sessionEstimation, sessionSeparation, sessionMixed],
      experiments: [expDetection, expEstimation, expSeparation],
      dynScansFrom: 'max'
    };
  }

  /* ------------------------------------------------------------ lookups */

  function byId(list, id) {
    var items = list || [];
    for (var i = 0; i < items.length; i += 1) {
      if (items[i] && items[i].id === id) return items[i];
    }
    return null;
  }

  function trialById(state, id) { return byId(state.trials, id) || (state.trials || [])[0] || null; }
  function runById(state, id) { return byId(state.runs, id); }
  function sessionById(state, id) { return byId(state.sessions, id); }
  function experimentById(state, id) { return byId(state.experiments, id); }

  function enabledExperiments(state) {
    return (state.experiments || []).filter(function (item) { return item && item.enabled; });
  }

  /* A run design flattened against the trial design it uses: the shape the
   * efficiency engine and the geometry helpers both want. */
  function runDesign(state, run) {
    var trial = trialById(state, run.trial);
    return {
      id: run.id,
      name: run.name,
      phases: (trial && trial.phases) || [],
      seed: (trial && trial.seed) || 20260823,
      trial: trial,
      decode: {
        labelOrder: run.labelOrder || 'intermixed',
        labelRunLength: Math.max(1, Math.round(num(run.labelRunLength, 1)))
      }
    };
  }

  /* --------------------------------------------------- derived durations */

  function trialTiming(trial) {
    var minTotal = 0, maxTotal = 0;
    ((trial && trial.phases) || []).forEach(function (phase) {
      var lo = Math.max(0, num(phase.min));
      var hi = Math.max(lo, num(phase.max));
      minTotal += lo;
      maxTotal += hi;
    });
    return { min: minTotal, max: maxTotal, mean: (minTotal + maxTotal) / 2 };
  }

  function runGeometry(run, trial, trSeconds) {
    var timing = trialTiming(trial);
    var trialsPerBlock = Math.max(1, Math.round(num(run.trialsPerBlock, 1)));
    var blocksPerRun = Math.max(1, Math.round(num(run.blocksPerRun, 1)));
    var gap = Math.max(0, num(run.interTrialGap));
    var blockRest = Math.max(0, num(run.interBlockRest));
    var dummyVolumes = Math.max(0, Math.round(num(run.dummyVolumes)));
    var dummySeconds = dummyVolumes * trSeconds;
    var leadIn = Math.max(0, num(run.leadIn));
    var leadOut = Math.max(0, num(run.leadOut));

    var block = {
      min: trialsPerBlock * timing.min + (trialsPerBlock - 1) * gap,
      max: trialsPerBlock * timing.max + (trialsPerBlock - 1) * gap,
      mean: trialsPerBlock * timing.mean + (trialsPerBlock - 1) * gap
    };
    var fixed = dummySeconds + leadIn + leadOut + (blocksPerRun - 1) * blockRest;
    var total = {
      min: fixed + blocksPerRun * block.min,
      max: fixed + blocksPerRun * block.max,
      mean: fixed + blocksPerRun * block.mean
    };
    var functional = {
      min: total.min - dummySeconds,
      max: total.max - dummySeconds,
      mean: total.mean - dummySeconds
    };
    return {
      trial: timing,
      block: block,
      run: total,
      functional: functional,
      trialsPerBlock: trialsPerBlock,
      blocksPerRun: blocksPerRun,
      trialsPerRun: trialsPerBlock * blocksPerRun,
      dummyVolumes: dummyVolumes,
      dummySeconds: dummySeconds,
      leadIn: leadIn,
      leadOut: leadOut,
      interBlockRest: blockRest,
      interTrialGap: gap
    };
  }

  /* ------------------------------------------------------------- context */

  function protocolContext(boot, slug) {
    var acquisition = (boot.acquisition || {})[slug] || {};
    var manifest = (boot.manifest || []).filter(function (entry) {
      return entry.slug === slug;
    })[0] || {};
    var headline = manifest.headline || {};
    var trMs = num(acquisition.trMs, 2000);
    return {
      slug: slug,
      label: manifest.label || slug || 'No card',
      missing: !manifest.slug,
      role: manifest.role || 'other',
      trMs: trMs,
      trSeconds: trMs / 1000,
      teMs: num(acquisition.teMs, 0),
      durationSeconds: num(acquisition.durationSeconds, 0),
      slices: num(headline.slices, 0),
      matrix: num(headline.matrix, 0),
      voxel: headline.voxel || '',
      mbFactor: headline.mbFactor || '',
      senseP: headline.senseP || '',
      flip: headline.flip || '',
      dynScans: num(headline.dynScans, 0)
    };
  }

  function structuralMinutes(list, boot) {
    var rows = [];
    var total = 0;
    (list || []).forEach(function (entry) {
      var ctx = protocolContext(boot, entry.protocol);
      var count = Math.max(0, Math.round(num(entry.count, 1)));
      var minutes = (ctx.durationSeconds / 60) * count;
      if (entry.enabled) total += minutes;
      rows.push({
        protocol: entry.protocol,
        protocolLabel: ctx.label,
        enabled: !!entry.enabled,
        count: count,
        minutesEach: ctx.durationSeconds / 60,
        minutes: minutes
      });
    });
    return { rows: rows, minutes: total };
  }

  /* -------------------------------------------------------- data volume */

  function volumeBytes(ctx) {
    var matrix = ctx.matrix || 0;
    var slices = ctx.slices || 0;
    return matrix * matrix * slices * 2; /* 16-bit voxels */
  }

  /* ------------------------------------------------------- normalisation */

  function normaliseAllocation(state, changedId) {
    var active = enabledExperiments(state);
    if (!active.length) return;
    if (active.length === 1) { active[0].requestedPct = 100; return; }

    var changed = experimentById(state, changedId);
    var target = changed ? clamp(num(changed.requestedPct), 0, 100) : 0;
    if (changed && changed.enabled) changed.requestedPct = target;

    var adjustable = active.filter(function (item) {
      return item.id !== changedId && !item.locked;
    });
    var fixed = active.filter(function (item) {
      return item.id !== changedId && item.locked;
    });
    var fixedTotal = sum(fixed, function (item) { return num(item.requestedPct); });
    var anchor = changed && changed.enabled ? target : 0;
    var remaining = 100 - anchor - fixedTotal;

    if (!adjustable.length) {
      var scale = active.filter(function (item) { return item.id !== changedId; });
      var total = sum(scale, function (item) { return num(item.requestedPct); });
      if (total > 0) {
        scale.forEach(function (item) {
          item.requestedPct = round(num(item.requestedPct) / total * (100 - anchor), 2);
        });
      }
      return;
    }

    if (remaining < 0) remaining = 0;
    var pool = sum(adjustable, function (item) { return num(item.requestedPct); });
    adjustable.forEach(function (item, index) {
      var share = pool > 0 ? num(item.requestedPct) / pool : 1 / adjustable.length;
      item.requestedPct = round(remaining * share, 2);
      if (index === adjustable.length - 1) {
        var running = sum(active, function (other) { return num(other.requestedPct); });
        item.requestedPct = round(num(item.requestedPct) + (100 - running), 2);
      }
    });
    active.forEach(function (item) {
      item.requestedPct = clamp(round(num(item.requestedPct), 2), 0, 100);
    });
  }

  /* --------------------------------------------------------- migration */

  /* Carry a design written against the earlier, aim-shaped model forward: each
   * aim becomes a trial design, a run design, a session and an experiment, so
   * an old file opens as the same study expressed in the new hierarchy. */
  function migrateFromAims(old) {
    var state = defaultState();
    state.trials = [];
    state.runs = [];
    state.sessions = [];
    state.experiments = [];

    state.meta = Object.assign({}, state.meta, old.meta || {});
    state.budget = Object.assign({}, state.budget, old.budget || {});
    if (old.budget && old.budget.targetQuestionsTotal !== undefined) {
      state.budget.targetUnitsTotal = num(old.budget.targetQuestionsTotal);
    } else if (old.budget && old.budget.targetTrialsTotal !== undefined) {
      state.budget.targetUnitsTotal = num(old.budget.targetTrialsTotal);
    }
    delete state.budget.targetQuestionsTotal;
    delete state.budget.targetTrialsTotal;
    delete state.budget.sessionModel;

    state.caps = Object.assign({}, state.caps, old.caps || {});
    if (old.caps && old.caps.minQuestionsPerAim !== undefined) {
      state.caps.minUnitsPerExperiment = num(old.caps.minQuestionsPerAim);
    }
    delete state.caps.minQuestionsPerAim;
    delete state.caps.minTrialsPerAim;

    /* The old vocabulary: goals were denominated in questions. */
    var unit = { noun: 'question', plural: 'questions', short: 'q' };
    var controlPct = clamp(num((old.questionBank || {}).controlPct), 0, 100);
    var balance = clamp(num((old.questionBank || {}).yesPct, 50), 0, 100);

    /* Card slugs were renamed when the planner became generic. */
    var CARD_MAP = {
      'fMRI-Survey-Parameters': 'Survey-Localizer',
      'fMRI-SENSE-Reference-Parameters': 'SENSE-Reference',
      'fMRI-T1-Anatomical-Parameters': 'T1-Anatomical-MPRAGE',
      'fMRI-T2-FLAIR-Parameters': 'T2-FLAIR',
      'fMRI-SBRef-Parameters': 'EPI-SBRef',
      'fMRI-FieldMap-RevPE-Parameters': 'Field-Map-Reverse-PE',
      'fMRI-Dummy-Parameters': 'EPI-Dummy-Prescan',
      'fMRI-Base-Parameters': 'EPI-Base-Template',
      'fMRI-GLM-Parameters': 'EPI-TR2000-Task',
      'fMRI-MVPA-Parameters': 'EPI-TR1000-Task',
      'fMRI-Time-Series-Parameters-V3': 'EPI-TR800-Task'
    };
    function card(slug) { return CARD_MAP[slug] || slug; }
    function structurals(list) {
      return (list || deepCopy(STRUCTURAL_DEFAULTS)).map(function (entry) {
        return { protocol: card(entry.protocol), enabled: !!entry.enabled, count: num(entry.count, 1) };
      });
    }

    var shared = old.session || {};
    ['glm', 'mvpa', 'ts'].forEach(function (aimId) {
      var aim = (old.aims || {})[aimId];
      if (!aim) return;
      var decode = aim.decode || {};

      var trial = defaultTrial(decode.objective || 'estimation', aim.name + ' trial');
      trial.phases = (aim.phases || trial.phases).map(function (phase) {
        return {
          name: phase.name,
          min: num(phase.min),
          max: num(phase.max),
          jitter: !!phase.jitter,
          role: normaliseRole(phase.role)
        };
      });
      trial.conditions = { a: 'Yes', b: 'No' };
      trial.conditionBalance = balance;
      trial.controlPct = controlPct;
      trial.separationTolerancePct = num(aim.separationTolerancePct, 4);
      trial.seed = num(aim.seed, 20260823);
      state.trials.push(trial);

      var structure = aim.structure || {};
      var run = defaultRun(trial.id, card(aim.protocol), aim.name + ' run');
      run.trialsPerBlock = num(structure.trialsPerBlock, 10);
      run.blocksPerRun = num(structure.blocksPerRun, 3);
      run.interTrialGap = num(structure.interTrialGap, 0);
      run.interBlockRest = num(structure.interBlockRest, 12);
      run.dummyVolumes = num(structure.dummyVolumes, 8);
      run.leadIn = num(structure.leadIn, 12);
      run.leadOut = num(structure.leadOut, 12);
      run.labelOrder = decode.labelOrder || 'intermixed';
      run.labelRunLength = num(decode.labelRunLength, 1);
      state.runs.push(run);

      var perAim = ((shared.perAim || {})[aimId]) || {};
      var source = perAim.custom ? perAim : shared;
      /* Hand the old fixed shape to the block migration so both routes into
       * the planner end up with the same ordered list. */
      var session = defaultSession(aim.name + ' session');
      delete session.blocks;
      session.screeningMinutes = num(source.screeningMinutes, 6);
      session.positioningMinutes = num(source.positioningMinutes, 5);
      session.practiceMinutes = num(source.practiceMinutes, 4);
      session.breakMinutes = num(source.breakMinutes, 3);
      session.structurals = structurals(source.structurals);
      session.items = [{ run: run.id, count: Math.max(1, Math.round(num(structure.runsPerSession, 1))) }];
      normaliseBlocks(session);
      state.sessions.push(session);

      var experiment = defaultExperiment(aim.name, aim.short || aim.name);
      experiment.enabled = aim.enabled !== false;
      experiment.unit = deepCopy(unit);
      experiment.requestedPct = num(aim.requestedPct, 0);
      experiment.locked = !!aim.locked;
      experiment.targetUnits = num(aim.targetQuestions, num(aim.targetTrials, 500));
      experiment.manualSessions = Math.max(0, Math.round(num(aim.sessions, 0))) || 10;
      experiment.plan = [{ session: session.id, count: 1 }];
      state.experiments.push(experiment);
    });

    if (!state.experiments.length) return defaultState();
    return state;
  }

  /* Bring any saved design up to the current shape. */
  function migrateState(state) {
    if (!state || typeof state !== 'object') return defaultState();
    if (state.aims && !state.experiments) return migrateFromAims(state);

    var fresh = defaultState();
    state.version = 2;
    state.meta = Object.assign({}, fresh.meta, state.meta || {});
    state.budget = Object.assign({}, fresh.budget, state.budget || {});
    state.caps = Object.assign({}, fresh.caps, state.caps || {});
    delete state.questionBank;
    delete state.aims;
    delete state.session;

    state.hrf = Object.assign(defaultHrf(), state.hrf || {});
    state.hrf.objectives = Object.assign(defaultHrf().objectives, state.hrf.objectives || {});

    ['trials', 'runs', 'sessions', 'experiments'].forEach(function (key) {
      if (!Array.isArray(state[key])) state[key] = deepCopy(fresh[key]);
    });

    state.trials.forEach(function (trial) {
      if (!trial.id) trial.id = makeId('trial');
      trial.phases = (trial.phases || []).map(function (phase) {
        return {
          name: String(phase.name || 'Phase'),
          min: num(phase.min),
          max: Math.max(num(phase.min), num(phase.max)),
          jitter: !!phase.jitter,
          role: normaliseRole(phase.role)
        };
      });
      if (!trial.conditions) trial.conditions = { a: 'Condition A', b: 'Condition B' };
      if (trial.conditionBalance === undefined) trial.conditionBalance = 50;
      if (trial.controlPct === undefined) trial.controlPct = 0;
      if (!trial.objective) trial.objective = 'estimation';
    });
    state.runs.forEach(function (run) {
      if (!run.id) run.id = makeId('run');
      if (!trialById(state, run.trial) && state.trials.length) run.trial = state.trials[0].id;
      if (!run.labelOrder) run.labelOrder = 'intermixed';
    });
    state.sessions.forEach(function (session) {
      if (!session.id) session.id = makeId('session');
      normaliseBlocks(session);
      session.blocks = session.blocks.filter(function (block) {
        return block.kind !== 'run' || runById(state, block.run);
      });
    });
    state.experiments.forEach(function (experiment) {
      if (!experiment.id) experiment.id = makeId('exp');
      if (!experiment.unit) experiment.unit = deepCopy(DEFAULT_UNIT);
      if (!Array.isArray(experiment.plan)) experiment.plan = [];
      experiment.plan = experiment.plan.filter(function (entry) {
        return sessionById(state, entry.session);
      });
    });
    return state;
  }

  /* -------------------------------------------------------------- solver */

  /* Resolve every run design once: geometry, cap repair and the acquisition
   * card behind it.  Sessions and experiments then only ever refer to these. */
  function resolveRuns(state, boot, warnings) {
    var caps = state.caps;
    var basis = caps.applyTo === 'longest' ? 'max' : 'mean';
    var basisLabel = basis === 'max' ? 'longest' : 'expected';
    var out = {};

    (state.runs || []).forEach(function (run) {
      var trial = trialById(state, run.trial);
      var ctx = protocolContext(boot, run.protocol);
      var geometry = runGeometry(run, trial, ctx.trSeconds);

      if (ctx.missing) {
        warnings.push(run.name + ': acquisition card "' + run.protocol
          + '" is missing, so TR and data volume fall back to defaults.');
      }

      if (state.budget.autoClamp) {
        var guard = 0;
        while (geometry.run[basis] / 60 > num(caps.maxRunMinutes)
          && geometry.blocksPerRun > 1 && guard < 40) {
          run.blocksPerRun = geometry.blocksPerRun - 1;
          geometry = runGeometry(run, trial, ctx.trSeconds);
          guard += 1;
        }
        while (geometry.run[basis] / 60 > num(caps.maxRunMinutes)
          && geometry.trialsPerBlock > 1 && guard < 80) {
          run.trialsPerBlock = geometry.trialsPerBlock - 1;
          geometry = runGeometry(run, trial, ctx.trSeconds);
          guard += 1;
        }
        if (guard > 0) {
          warnings.push(run.name + ': run structure reduced to keep the ' + basisLabel
            + ' run within the ' + num(caps.maxRunMinutes) + ' min run cap (now '
            + round(geometry.run[basis] / 60, 1) + ' min ' + basisLabel + ', '
            + round(geometry.run.max / 60, 1) + ' min longest).');
        }
      } else if (geometry.run[basis] / 60 > num(caps.maxRunMinutes)) {
        warnings.push(run.name + ': ' + basisLabel + ' run is '
          + round(geometry.run[basis] / 60, 1) + ' min, over the '
          + num(caps.maxRunMinutes) + ' min cap. Auto-clamp is off.');
      }

      if (geometry.run.max / 60 > num(caps.maxContinuousMinutes)) {
        warnings.push(run.name + ': longest run (' + round(geometry.run.max / 60, 1)
          + ' min) exceeds the continuous-scanning comfort limit of '
          + num(caps.maxContinuousMinutes) + ' min.');
      }

      var controlPct = clamp(num(trial && trial.controlPct), 0, 100);
      var controlTrials = Math.round(geometry.trialsPerRun * controlPct / 100);
      var dynSource = state.dynScansFrom === 'mean'
        ? geometry.functional.mean : geometry.functional.max;
      var volumesPerRun = ctx.trSeconds > 0 ? Math.ceil(dynSource / ctx.trSeconds) : 0;
      var mbPerRun = volumeBytes(ctx) * volumesPerRun / (1024 * 1024);

      out[run.id] = {
        run: run,
        trial: trial,
        ctx: ctx,
        geometry: geometry,
        design: runDesign(state, run),
        minutes: {
          min: geometry.run.min / 60,
          mean: geometry.run.mean / 60,
          max: geometry.run.max / 60
        },
        trialsPerRun: geometry.trialsPerRun,
        controlTrials: controlTrials,
        unitsPerRun: Math.max(0, geometry.trialsPerRun - controlTrials),
        volumesPerRun: volumesPerRun,
        mbPerRun: mbPerRun
      };
    });
    return out;
  }

  /* Walk a session's blocks into the atomic things the console actually does,
   * in the order the blocks sit in.  Totals, the timeline and the cap repair
   * all read this one list, so what you see on screen is what is solved.
   *
   * The automatic break is only inserted between two functional acquisitions
   * that end up next to each other.  Move anything between them - a structural,
   * a setup step, a break you placed yourself - and no extra break appears. */
  function buildSessionPlan(session, boot, runInfo) {
    var autoBreak = session.autoBreak !== false;
    var autoMinutes = Math.max(0, num(session.breakMinutes));
    var entries = [];
    var seen = {};
    var lastWasRun = false;

    function fixed(minutes) {
      var value = Math.max(0, num(minutes));
      return { min: value, mean: value, max: value };
    }

    (session.blocks || []).forEach(function (block) {
      if (block.enabled === false) return;

      if (block.kind === 'prep' || block.kind === 'break') {
        var minutes = Math.max(0, num(block.minutes));
        if (minutes <= 0) return;
        entries.push({
          kind: block.kind, blockId: block.id,
          item: String(block.label || (block.kind === 'break' ? 'Break' : 'Setup step')),
          protocol: '', protocolLabel: '', minutes: fixed(minutes),
          category: block.kind === 'break' ? 'Break' : 'Non-acquisition'
        });
        lastWasRun = false;
        return;
      }

      if (block.kind === 'structural') {
        var ctx = protocolContext(boot, block.protocol);
        var count = Math.max(0, Math.round(num(block.count, 1)));
        if (count <= 0) return;
        entries.push({
          kind: 'structural', blockId: block.id, count: count,
          item: ctx.label + (count > 1 ? ' x' + count : ''),
          protocol: block.protocol, protocolLabel: ctx.label,
          minutes: fixed((ctx.durationSeconds / 60) * count),
          category: 'Structural / reference'
        });
        lastWasRun = false;
        return;
      }

      if (block.kind !== 'run') return;
      var info = runInfo[block.run];
      if (!info) return;
      var repeats = Math.max(0, Math.round(num(block.count, 1)));
      for (var i = 0; i < repeats; i += 1) {
        if (lastWasRun && autoBreak && autoMinutes > 0) {
          entries.push({
            kind: 'break', blockId: block.id, auto: true, item: 'Break',
            protocol: '', protocolLabel: '', minutes: fixed(autoMinutes),
            category: 'Break'
          });
        }
        seen[block.run] = (seen[block.run] || 0) + 1;
        entries.push({
          kind: 'run', blockId: block.id, runId: block.run, info: info,
          item: info.run.name + ' ' + seen[block.run],
          protocol: info.run.protocol, protocolLabel: info.ctx.label,
          minutes: info.minutes, category: 'Functional'
        });
        lastWasRun = true;
      }
    });
    return entries;
  }

  /* The structural rows a session declares, disabled ones included, so the
   * editor and the report can show what is switched off as well as on. */
  function structuralRows(session, boot) {
    return (session.blocks || []).filter(function (block) {
      return block.kind === 'structural';
    }).map(function (block) {
      var ctx = protocolContext(boot, block.protocol);
      var count = Math.max(0, Math.round(num(block.count, 1)));
      return {
        blockId: block.id,
        protocol: block.protocol,
        protocolLabel: ctx.label,
        enabled: block.enabled !== false,
        count: count,
        minutesEach: ctx.durationSeconds / 60,
        minutes: (ctx.durationSeconds / 60) * count
      };
    });
  }

  /* The setup rows a session declares, in list order. */
  function setupRows(session) {
    return (session.blocks || []).filter(function (block) {
      return block.kind === 'prep';
    }).map(function (block) {
      return {
        blockId: block.id,
        label: String(block.label || 'Setup step'),
        enabled: block.enabled !== false,
        minutes: Math.max(0, num(block.minutes))
      };
    });
  }

  /* Resolve every session: walk the blocks, repair against the caps, and lay
   * the result out as a timeline. */
  function resolveSessions(state, boot, runInfo, warnings) {
    var caps = state.caps;
    var basis = caps.applyTo === 'longest' ? 'max' : 'mean';
    var basisLabel = basis === 'max' ? 'longest' : 'expected';
    var maxRuns = Math.max(1, Math.round(num(caps.maxRunsPerSession, 8)));
    var out = {};

    (state.sessions || []).forEach(function (session) {
      /* The run blocks in list order: the cap repair trims from the end,
       * which is the last thing the console would have reached. */
      var runBlocks = (session.blocks || []).filter(function (block) {
        return block.kind === 'run' && block.enabled !== false && runInfo[block.run];
      });

      var entries = buildSessionPlan(session, boot, runInfo);

      function ofKind(list, kind) {
        return list.filter(function (entry) { return entry.kind === kind; });
      }
      function minutesOf(list, which) {
        return sum(list, function (entry) { return entry.minutes[which]; });
      }
      function runCount() { return ofKind(entries, 'run').length; }
      function sessionMinutes(which) { return minutesOf(entries, which); }

      /* Too many runs for the cap, or a session longer than the cap allows:
       * drop runs from the end of the list, so the session keeps its opening
       * structure - whatever the user has put there. */
      var trimmed = 0;
      function dropLastRun() {
        for (var i = runBlocks.length - 1; i >= 0; i -= 1) {
          var count = Math.max(0, Math.round(num(runBlocks[i].count, 1)));
          if (count > 0) {
            runBlocks[i].count = count - 1;
            trimmed += 1;
            entries = buildSessionPlan(session, boot, runInfo);
            return true;
          }
        }
        return false;
      }

      if (state.budget.autoClamp) {
        var guard = 0;
        while (runCount() > maxRuns && guard < 200 && dropLastRun()) guard += 1;
        while (runCount() > 1 && sessionMinutes(basis) > num(caps.maxSessionMinutes)
          && guard < 400 && dropLastRun()) guard += 1;
        if (trimmed > 0) {
          warnings.push(session.name + ': ' + trimmed + ' ' + plural(trimmed, 'run')
            + ' removed so the ' + basisLabel + ' session stays inside the '
            + num(caps.maxSessionMinutes) + ' min session cap and the '
            + maxRuns + '-run limit.');
        }
      } else if (sessionMinutes(basis) > num(caps.maxSessionMinutes)) {
        warnings.push(session.name + ': ' + basisLabel + ' session is '
          + round(sessionMinutes(basis), 1) + ' min, over the '
          + num(caps.maxSessionMinutes) + ' min cap. Auto-clamp is off.');
      }

      /* One entry per run block, for everything downstream that counts runs
       * rather than walking the order. */
      var items = runBlocks.map(function (block) {
        return {
          blockId: block.id,
          run: block.run,
          count: Math.max(0, Math.round(num(block.count, 1))),
          info: runInfo[block.run]
        };
      }).filter(function (item) { return item.info && item.count > 0; });

      var overhead = minutesOf(ofKind(entries, 'prep'), 'mean');
      var structuralTotal = minutesOf(ofKind(entries, 'structural'), 'mean');
      var breakTotal = minutesOf(ofKind(entries, 'break'), 'mean');
      var autoBreakTotal = minutesOf(ofKind(entries, 'break').filter(function (entry) {
        return entry.auto;
      }), 'mean');
      var runs = runCount();

      var builder = timelineBuilder();
      entries.forEach(function (entry) {
        builder.push(entry.item, entry.protocol, entry.protocolLabel,
          entry.minutes.mean, entry.category);
      });

      out[session.id] = {
        session: session,
        entries: entries,
        structural: { rows: structuralRows(session, boot), minutes: structuralTotal },
        setup: setupRows(session),
        items: items,
        runs: runs,
        overheadMinutes: overhead,
        structuralMinutes: structuralTotal,
        setupMinutes: structuralTotal + overhead,
        breakMinutes: Math.max(0, num(session.breakMinutes)),
        breakTotalMinutes: breakTotal,
        autoBreakMinutes: autoBreakTotal,
        minutes: {
          min: sessionMinutes('min'),
          mean: sessionMinutes('mean'),
          max: sessionMinutes('max')
        },
        functionalMinutes: minutesOf(ofKind(entries, 'run'), 'mean'),
        nonScanMinutes: overhead + breakTotal,
        trials: sum(items, function (item) { return item.count * item.info.trialsPerRun; }),
        units: sum(items, function (item) { return item.count * item.info.unitsPerRun; }),
        volumes: sum(items, function (item) { return item.count * item.info.volumesPerRun; }),
        gb: sum(items, function (item) { return item.count * item.info.mbPerRun; }) / 1024,
        timeline: builder.rows
      };
    });
    return out;
  }

  /* -------------------------------------------------------- timelines */

  function timelineBuilder() {
    var rows = [];
    var cumulative = 0;
    function push(item, protocol, protocolLabel, minutes, category) {
      var value = Math.max(0, num(minutes));
      cumulative += value;
      rows.push({
        order: rows.length + 1,
        item: item,
        protocol: protocol || '',
        protocolLabel: protocolLabel || '',
        minutes: round(value, 2),
        cumulative: round(cumulative, 2),
        category: category
      });
    }
    return { rows: rows, push: push, total: function () { return cumulative; } };
  }

  /* ------------------------------------------------ session distribution */

  /* Spread `total` sessions across an experiment's plan in the ratio the plan
   * asks for, by largest remainder, so the mix is preserved and the counts are
   * still whole sessions. */
  function distributeSessions(plan, total) {
    var weights = plan.map(function (entry) { return Math.max(0, num(entry.count, 1)); });
    var pool = sum(weights);
    if (!plan.length) return [];
    if (pool <= 0) {
      return plan.map(function (_, index) {
        return index === 0 ? Math.max(0, Math.round(total)) : 0;
      });
    }
    var exact = weights.map(function (weight) { return total * weight / pool; });
    var counts = exact.map(function (value) { return Math.floor(value); });
    var spare = Math.round(total) - sum(counts);
    var order = exact.map(function (value, index) {
      return { index: index, frac: value - Math.floor(value) };
    }).sort(function (a, b) { return b.frac - a.frac; });
    for (var i = 0; i < order.length && spare > 0; i += 1) {
      counts[order[i].index] += 1;
      spare -= 1;
    }
    /* A plan entry the user asked for should not silently vanish. */
    if (total >= plan.length) {
      counts.forEach(function (value, index) {
        if (value === 0 && weights[index] > 0) {
          var donor = counts.indexOf(Math.max.apply(null, counts));
          if (counts[donor] > 1) { counts[donor] -= 1; counts[index] = 1; }
        }
      });
    }
    return counts;
  }

  function applyTotalGoal(solved, goal, usableHours, warnings, unitLabel) {
    if (!(goal > 0) || !solved.length) return;
    var affordable = sum(solved, function (entry) {
      return entry.sessions * entry.unitsPerSession;
    });
    if (affordable <= goal + 0.5) {
      if (affordable < goal - 0.5) {
        warnings.push('Goal of ' + fmtNumber(goal) + ' ' + unitLabel + ' does not fit the budget: '
          + round(usableHours, 1) + ' usable hours buy about ' + fmtNumber(Math.round(affordable))
          + ' at the current allocation. The plan fills what the hours allow.');
      }
      return;
    }

    var scale = goal / affordable;
    var exact = solved.map(function (entry) { return entry.sessions * scale; });
    var scheduled = solved.map(function (entry) { return entry.sessions; });
    solved.forEach(function (entry, index) { entry.sessions = Math.floor(exact[index]); });

    /* Sessions are indivisible, so a small experiment can round to nothing.
     * Keeping it alive at one session and overshooting the goal slightly beats
     * dropping an experiment out of the study without saying so. */
    solved.forEach(function (entry, index) {
      if (entry.sessions === 0 && scheduled[index] > 0 && entry.unitsPerSession > 0) {
        entry.sessions = 1;
      }
    });

    var running = sum(solved, function (entry) {
      return entry.sessions * entry.unitsPerSession;
    });
    var order = exact.map(function (value, index) {
      return { index: index, frac: value - Math.floor(value) };
    }).sort(function (a, b) { return b.frac - a.frac; });
    order.forEach(function (record) {
      var entry = solved[record.index];
      if (entry.unitsPerSession <= 0) return;
      /* Take the extra session only while it lands nearer the goal than
       * stopping short of it does. */
      if (running + entry.unitsPerSession * 0.5 <= goal) {
        entry.sessions += 1;
        running += entry.unitsPerSession;
      }
    });

    warnings.push('Plan held at the ' + fmtNumber(goal) + ' ' + unitLabel + ' goal: '
      + fmtNumber(Math.round(running)) + ' across '
      + sum(solved, function (entry) { return entry.sessions; })
      + ' whole sessions, leaving the rest of the budget unspent.');
  }

  function clampSessions(solved, limit, warnings, reason) {
    var total = sum(solved, function (entry) { return entry.sessions; });
    if (total <= limit || total <= 0) return total;
    var scale = limit / total;
    var exact = solved.map(function (entry) { return entry.sessions * scale; });
    solved.forEach(function (entry, index) { entry.sessions = Math.floor(exact[index]); });
    var spare = limit - sum(solved, function (entry) { return entry.sessions; });
    var order = exact.map(function (value, index) {
      return { index: index, frac: value - Math.floor(value) };
    }).sort(function (a, b) { return b.frac - a.frac; });
    for (var i = 0; i < order.length && spare > 0; i += 1) {
      solved[order[i].index].sessions += 1;
      spare -= 1;
    }
    warnings.push('Total sessions reduced from ' + total + ' to '
      + sum(solved, function (entry) { return entry.sessions; }) + ' by ' + reason + '.');
    return sum(solved, function (entry) { return entry.sessions; });
  }

  /* ------------------------------------------------------------- solve */

  function solve(state, boot) {
    var warnings = [];
    var working = migrateState(deepCopy(state));
    applyHrf(working);

    var runInfo = resolveRuns(working, boot, warnings);
    var sessionInfo = resolveSessions(working, boot, runInfo, warnings);

    var experiments = enabledExperiments(working);
    var caps = working.caps;
    var budget = working.budget;

    /* --- per-experiment averages over the session plan ----------------- */
    var solved = experiments.map(function (experiment) {
      var plan = (experiment.plan || []).map(function (entry) {
        return {
          session: entry.session,
          requested: Math.max(0, Math.round(num(entry.count, 1))),
          info: sessionInfo[entry.session] || null
        };
      }).filter(function (entry) { return entry.info; });

      var weight = sum(plan, function (entry) { return entry.requested; });
      function weighted(pick) {
        if (weight <= 0) return plan.length ? pick(plan[0].info) : 0;
        return sum(plan, function (entry) { return entry.requested * pick(entry.info); }) / weight;
      }

      if (!plan.length) {
        warnings.push(experiment.name + ': the session plan is empty, so nothing is scheduled. '
          + 'Add a session to it in the Experiments panel.');
      }

      return {
        experiment: experiment,
        plan: plan,
        unit: unitOf(experiment),
        sessionMinutes: weighted(function (info) { return info.minutes.mean; }),
        sessionMinutesMin: weighted(function (info) { return info.minutes.min; }),
        sessionMinutesMax: weighted(function (info) { return info.minutes.max; }),
        functionalPerSession: weighted(function (info) { return info.functionalMinutes; }),
        setupPerSession: weighted(function (info) { return info.setupMinutes; }),
        nonScanPerSession: weighted(function (info) { return info.nonScanMinutes; }),
        trialsPerSession: weighted(function (info) { return info.trials; }),
        unitsPerSession: weighted(function (info) { return info.units; }),
        runsPerSession: weighted(function (info) { return info.runs; }),
        gbPerSession: weighted(function (info) { return info.gb; }),
        sessions: 0,
        planCounts: []
      };
    });

    /* --- allocation ---------------------------------------------------- */
    var requestedTotal = sum(solved, function (entry) {
      return num(entry.experiment.requestedPct);
    });
    if (requestedTotal <= 0) requestedTotal = 1;
    solved.forEach(function (entry) {
      entry.fraction = num(entry.experiment.requestedPct) / requestedTotal;
    });

    var usableHours = num(budget.totalScannerHours)
      * (1 - clamp(num(budget.contingencyPct), 0, 90) / 100);
    var usableMinutes = usableHours * 60;
    var maxSessions = Math.max(1, Math.round(num(caps.maxSessionsTotal, 60)));
    var calendarSessions = Math.max(1, Math.floor(num(budget.sessionsPerWeek, 3)
      * num(budget.weeksAvailable, 12)));
    var mode = budget.solveMode;

    solved.forEach(function (entry) {
      var perSession = entry.sessionMinutes;
      if (budget.countOverheadAgainstBudget === false) {
        perSession = Math.max(0.01, entry.functionalPerSession);
      }
      if (!(perSession > 0)) { entry.sessions = 0; return; }

      if (entry.experiment.lockPlan) {
        entry.sessions = sum(entry.plan, function (row) { return row.requested; });
        return;
      }
      if (mode === 'manual') {
        entry.sessions = Math.max(0, Math.round(num(entry.experiment.manualSessions, 0)));
        return;
      }
      if (mode === 'target') {
        var goal = num(entry.experiment.targetUnits);
        entry.sessions = entry.unitsPerSession > 0
          ? Math.ceil(goal / entry.unitsPerSession) : 0;
        return;
      }
      entry.sessions = Math.floor(entry.fraction * usableMinutes / perSession);
    });

    if (mode === 'fill') {
      applyTotalGoal(solved, num(budget.targetUnitsTotal), usableHours, warnings,
        'primary events');
    }

    /* --- caps ---------------------------------------------------------- */
    var floor = Math.max(0, num(caps.minUnitsPerExperiment));
    solved.forEach(function (entry) {
      if (entry.experiment.lockPlan || !entry.plan.length) return;
      if (floor > 0 && entry.unitsPerSession > 0) {
        var needed = Math.ceil(floor / entry.unitsPerSession);
        if (entry.sessions < needed) {
          entry.sessions = needed;
          warnings.push(entry.experiment.name + ': raised to ' + needed + ' '
            + plural(needed, 'session') + ' to clear the floor of ' + fmtNumber(floor)
            + ' ' + entry.unit.plural + '.');
        }
      }
    });

    var totalSessions = sum(solved, function (entry) { return entry.sessions; });
    if (totalSessions > maxSessions) {
      totalSessions = clampSessions(solved, maxSessions, warnings,
        'the ' + maxSessions + '-session cap');
    }
    if (totalSessions > calendarSessions) {
      totalSessions = clampSessions(solved, calendarSessions, warnings,
        'the calendar (' + num(budget.sessionsPerWeek) + ' per week over '
        + num(budget.weeksAvailable) + ' weeks)');
    }

    /* --- distribute across the plan, then total up --------------------- */
    solved.forEach(function (entry) {
      entry.planCounts = entry.experiment.lockPlan
        ? entry.plan.map(function (row) { return row.requested; })
        : distributeSessions(entry.plan, entry.sessions);
      entry.sessions = sum(entry.planCounts);

      entry.scannerMinutes = 0;
      entry.functionalMinutes = 0;
      entry.overheadMinutes = 0;
      entry.trials = 0;
      entry.units = 0;
      entry.runs = 0;
      entry.gb = 0;
      entry.plan.forEach(function (row, index) {
        var count = entry.planCounts[index] || 0;
        row.sessions = count;
        entry.scannerMinutes += count * row.info.minutes.mean;
        entry.functionalMinutes += count * row.info.functionalMinutes;
        entry.overheadMinutes += count * row.info.nonScanMinutes
          + count * row.info.structuralMinutes;
        entry.trials += count * row.info.trials;
        entry.units += count * row.info.units;
        entry.runs += count * row.info.runs;
        entry.gb += count * row.info.gb;
      });
      entry.totalMinutes = budget.countOverheadAgainstBudget === false
        ? entry.functionalMinutes : entry.scannerMinutes;
    });

    var committedMinutes = sum(solved, function (entry) { return entry.totalMinutes; });
    solved.forEach(function (entry) {
      entry.sharePct = committedMinutes > 0 ? entry.totalMinutes / committedMinutes * 100 : 0;
    });

    if (committedMinutes > usableMinutes + 0.5 && mode !== 'target' && mode !== 'manual') {
      warnings.push('The plan commits ' + round(committedMinutes / 60, 1)
        + ' h against ' + round(usableHours, 1) + ' usable hours.');
    }
    if (mode === 'target' || mode === 'manual') {
      if (committedMinutes > usableMinutes + 0.5) {
        warnings.push('The plan needs ' + round(committedMinutes / 60, 1) + ' h but only '
          + round(usableHours, 1) + ' h are available: '
          + round((committedMinutes - usableMinutes) / 60, 1) + ' h over budget.');
      }
    }
    solved.forEach(function (entry) {
      var goal = num(entry.experiment.targetUnits);
      if (mode !== 'manual' && goal > 0 && entry.units < goal - 0.5 && entry.plan.length) {
        warnings.push(entry.experiment.name + ': ' + fmtNumber(Math.round(entry.units))
          + ' of ' + fmtNumber(goal) + ' ' + entry.unit.plural + ' scheduled ('
          + round(entry.units / goal * 100, 0) + '%).');
      }
    });

    /* --- reports ------------------------------------------------------- */
    var report = {
      meta: deepCopy(working.meta),
      generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
      budget: deepCopy(working.budget),
      caps: deepCopy(working.caps),
      hrf: deepCopy(working.hrf),
      usableHours: round(usableHours, 2),
      warnings: warnings,
      trials: buildTrialReports(working, runInfo),
      runs: buildRunReports(working, runInfo, solved),
      sessions: buildSessionReports(working, sessionInfo, solved),
      experiments: solved.map(function (entry) {
        return buildExperimentReport(entry, working, runInfo, sessionInfo);
      }),
      state: working
    };

    report.totals = buildTotals(report, solved, working, usableHours, committedMinutes);
    report.markdownTables = buildMarkdown(report);
    report.methodsText = buildMethods(report);
    return report;
  }

  /* ------------------------------------------------------------ reports */

  function buildTrialReports(state, runInfo) {
    return (state.trials || []).map(function (trial) {
      var timing = trialTiming(trial);
      var usedBy = Object.keys(runInfo).map(function (key) { return runInfo[key]; })
        .filter(function (info) { return info.run.trial === trial.id; })
        .map(function (info) { return info.run.name; });
      var objective = objectiveDef(state, trial.objective);
      return {
        id: trial.id,
        name: trial.name,
        note: trial.note || '',
        objective: trial.objective,
        objectiveLabel: objective.label,
        phases: deepCopy(trial.phases),
        conditions: deepCopy(trial.conditions || {}),
        conditionBalance: num(trial.conditionBalance, 50),
        controlPct: num(trial.controlPct),
        separationTolerancePct: num(trial.separationTolerancePct, objective.tolerancePct),
        timing: {
          min: round(timing.min, 2),
          max: round(timing.max, 2),
          mean: round(timing.mean, 2)
        },
        sequence: (trial.phases || []).map(phaseLabel).join(' -> '),
        usedBy: usedBy
      };
    });
  }

  function buildRunReports(state, runInfo, solved) {
    /* Which experiments a run ends up inside, and how many times it runs. */
    var usage = {};
    solved.forEach(function (entry) {
      entry.plan.forEach(function (row) {
        row.info.items.forEach(function (item) {
          if (!usage[item.run]) usage[item.run] = { experiments: {}, total: 0 };
          usage[item.run].experiments[entry.experiment.name] = true;
          usage[item.run].total += (row.sessions || 0) * item.count;
        });
      });
    });

    return (state.runs || []).map(function (run) {
      var info = runInfo[run.id];
      if (!info) return { id: run.id, name: run.name, missing: true };
      var geometry = info.geometry;
      var ctx = info.ctx;
      var efficiency = global.PlannerEfficiency
        ? global.PlannerEfficiency.evaluate(info.design, ctx.trSeconds, geometry)
        : {};
      var trial = info.trial;
      var objective = (trial && trial.objective) || 'estimation';
      var perHour = geometry.run.mean > 0 ? geometry.trialsPerRun / (geometry.run.mean / 3600) : 0;
      if (global.PlannerEfficiency && efficiency) {
        efficiency.objectiveScore = global.PlannerEfficiency.objectiveScore(
          objective, efficiency, geometry.run.mean / 60, perHour
        );
      }
      var used = usage[run.id] || { experiments: {}, total: 0 };

      return {
        id: run.id,
        name: run.name,
        note: run.note || '',
        trialId: run.trial,
        trialName: (trial && trial.name) || 'No trial design',
        objective: objective,
        protocol: run.protocol,
        protocolLabel: ctx.label,
        protocolMissing: ctx.missing,
        trMs: ctx.trMs,
        teMs: ctx.teMs,
        decode: info.design.decode,
        conditions: deepCopy((trial && trial.conditions) || {}),
        structure: {
          trialsPerBlock: geometry.trialsPerBlock,
          blocksPerRun: geometry.blocksPerRun,
          interTrialGap: geometry.interTrialGap,
          interBlockRest: geometry.interBlockRest,
          dummyVolumes: geometry.dummyVolumes,
          leadIn: geometry.leadIn,
          leadOut: geometry.leadOut
        },
        derived: {
          trialMin: round(geometry.trial.min, 2),
          trialMax: round(geometry.trial.max, 2),
          trialMean: round(geometry.trial.mean, 2),
          blockMin: round(geometry.block.min, 2),
          blockMax: round(geometry.block.max, 2),
          blockMean: round(geometry.block.mean, 2),
          runMin: round(geometry.run.min, 2),
          runMax: round(geometry.run.max, 2),
          runMean: round(geometry.run.mean, 2),
          dummySeconds: round(geometry.dummySeconds, 2),
          trialsPerRun: geometry.trialsPerRun,
          controlTrials: info.controlTrials,
          unitsPerRun: info.unitsPerRun,
          volumesPerRun: info.volumesPerRun,
          trialsPerHour: round(perHour, 1),
          secondsPerTrial: geometry.trialsPerRun > 0
            ? round(geometry.run.mean / geometry.trialsPerRun, 1) : 0,
          totalRuns: used.total
        },
        usedBy: Object.keys(used.experiments),
        dataVolume: {
          matrix: ctx.matrix ? ctx.matrix + ' x ' + ctx.matrix : '',
          slices: ctx.slices,
          voxel: ctx.voxel,
          volumesPerRun: info.volumesPerRun,
          mbPerRun: round(info.mbPerRun, 1),
          gbTotal: round(info.mbPerRun * used.total / 1024, 3)
        },
        acquisition: {
          trMs: ctx.trMs, teMs: ctx.teMs, voxel: ctx.voxel, slices: ctx.slices,
          mbFactor: ctx.mbFactor, senseP: ctx.senseP, flip: ctx.flip,
          dynScansCurrent: ctx.dynScans, dynScansSolved: info.volumesPerRun,
          dummyScansSolved: geometry.dummyVolumes,
          durationSolved: fmtClock(geometry.run.max)
        },
        efficiency: efficiency
      };
    });
  }

  function buildSessionReports(state, sessionInfo, solved) {
    var usage = {};
    solved.forEach(function (entry) {
      entry.plan.forEach(function (row) {
        if (!usage[row.session]) usage[row.session] = { experiments: [], sessions: 0 };
        usage[row.session].experiments.push(entry.experiment.name);
        usage[row.session].sessions += row.sessions || 0;
      });
    });

    return (state.sessions || []).map(function (session) {
      var info = sessionInfo[session.id];
      if (!info) return { id: session.id, name: session.name, missing: true };
      var used = usage[session.id] || { experiments: [], sessions: 0 };
      return {
        id: session.id,
        name: session.name,
        note: session.note || '',
        runs: info.runs,
        items: info.items.map(function (item) {
          return {
            runId: item.run,
            runName: item.info.run.name,
            count: item.count,
            protocol: item.info.run.protocol,
            protocolLabel: item.info.ctx.label,
            minutesEach: round(item.info.minutes.mean, 2),
            minutes: round(item.count * item.info.minutes.mean, 2),
            trials: item.count * item.info.trialsPerRun
          };
        }),
        structurals: info.structural.rows,
        setup: info.setup.map(function (row) {
          return { label: row.label, enabled: row.enabled, minutes: round(row.minutes, 2) };
        }),
        blocks: (session.blocks || []).map(function (block) {
          return deepCopy(block);
        }),
        autoBreak: session.autoBreak !== false,
        breakMinutes: round(info.breakMinutes, 2),
        breakTotalMinutes: round(info.breakTotalMinutes, 2),
        setupMinutes: round(info.setupMinutes, 2),
        structuralMinutes: round(info.structuralMinutes, 2),
        overheadMinutes: round(info.overheadMinutes, 2),
        functionalMinutes: round(info.functionalMinutes, 2),
        minMinutes: round(info.minutes.min, 2),
        meanMinutes: round(info.minutes.mean, 2),
        maxMinutes: round(info.minutes.max, 2),
        trials: info.trials,
        units: info.units,
        gb: round(info.gb, 3),
        timeline: info.timeline,
        usedBy: used.experiments,
        scheduled: used.sessions
      };
    });
  }

  function buildExperimentReport(entry, state, runInfo, sessionInfo) {
    var experiment = entry.experiment;
    var unit = entry.unit;
    var sessions = entry.sessions;
    var goal = num(experiment.targetUnits);

    /* Which distinct runs this experiment ends up recording. */
    var runs = {};
    entry.plan.forEach(function (row) {
      row.info.items.forEach(function (item) {
        if (!runs[item.run]) {
          runs[item.run] = { info: item.info, perSession: 0, total: 0 };
        }
        runs[item.run].perSession += item.count * (entry.sessions > 0
          ? (row.sessions || 0) / entry.sessions : 0);
        runs[item.run].total += item.count * (row.sessions || 0);
      });
    });
    var runRows = Object.keys(runs).map(function (key) {
      var record = runs[key];
      return {
        runId: key,
        name: record.info.run.name,
        trialName: (record.info.trial && record.info.trial.name) || '',
        protocol: record.info.run.protocol,
        protocolLabel: record.info.ctx.label,
        perSession: round(record.perSession, 2),
        totalRuns: record.total,
        trialsPerRun: record.info.trialsPerRun,
        unitsPerRun: record.info.unitsPerRun,
        minutesEach: round(record.info.minutes.mean, 2),
        trials: record.total * record.info.trialsPerRun,
        units: record.total * record.info.unitsPerRun
      };
    });

    var planRows = entry.plan.map(function (row, index) {
      return {
        sessionId: row.session,
        name: row.info.session.name,
        requested: row.requested,
        sessions: entry.planCounts[index] || 0,
        minutesEach: round(row.info.minutes.mean, 2),
        minMinutes: round(row.info.minutes.min, 2),
        maxMinutes: round(row.info.minutes.max, 2),
        runsEach: row.info.runs,
        trialsEach: row.info.trials,
        unitsEach: row.info.units,
        minutes: round((entry.planCounts[index] || 0) * row.info.minutes.mean, 2),
        units: (entry.planCounts[index] || 0) * row.info.units
      };
    });

    /* The assembly table: one row per level of the hierarchy. */
    var lead = runRows.slice().sort(function (a, b) { return b.totalRuns - a.totalRuns; })[0];
    var leadInfo = lead ? runs[lead.runId].info : null;
    var table = [];
    if (leadInfo) {
      var geometry = leadInfo.geometry;
      table.push({
        level: 'Trial',
        sequence: (leadInfo.trial ? leadInfo.trial.phases.map(phaseLabel).join(' -> ') : ''),
        count: 1,
        duration: fmtRange(geometry.trial.min, geometry.trial.max)
      });
      table.push({
        level: 'Block',
        sequence: blockWording(leadInfo, geometry),
        count: geometry.trialsPerBlock,
        duration: fmtRange(geometry.block.min, geometry.block.max)
      });
      table.push({
        level: 'Run',
        sequence: runWording(geometry),
        count: geometry.trialsPerRun,
        duration: fmtRange(geometry.run.min, geometry.run.max)
      });
    }
    table.push({
      level: 'Session',
      sequence: planRows.length
        ? planRows.map(function (row) {
          return row.name + (row.sessions ? ' x' + row.sessions : '');
        }).join(', ')
        : 'No sessions in the plan',
      count: Math.round(entry.trialsPerSession),
      duration: round(entry.sessionMinutesMin, 1) + ' - ' + round(entry.sessionMinutesMax, 1) + ' min'
    });
    table.push({
      level: 'Experiment',
      sequence: sessions + ' ' + plural(sessions, 'session') + ' over '
        + round(num(state.budget.weeksAvailable), 0) + ' weeks',
      count: Math.round(entry.trials),
      duration: sessions > 0 ? round(entry.totalMinutes / 60, 1) + ' h total' : 'Not scheduled'
    });

    return {
      id: experiment.id,
      name: experiment.name,
      short: experiment.short,
      note: experiment.note || '',
      enabled: true,
      unit: unit,
      lockPlan: !!experiment.lockPlan,
      requestedPct: num(experiment.requestedPct),
      plan: planRows,
      runs: runRows,
      leadRunId: lead ? lead.runId : null,
      derived: {
        sessions: sessions,
        runs: Math.round(entry.runs),
        trials: Math.round(entry.trials),
        units: Math.round(entry.units),
        controlTrials: Math.round(entry.trials - entry.units),
        unitsPerSession: round(entry.unitsPerSession, 1),
        trialsPerSession: round(entry.trialsPerSession, 1),
        runsPerSession: round(entry.runsPerSession, 2),
        sessionMeanMinutes: round(entry.sessionMinutes, 2),
        sessionMinMinutes: round(entry.sessionMinutesMin, 2),
        sessionMaxMinutes: round(entry.sessionMinutesMax, 2),
        functionalHours: round(entry.functionalMinutes / 60, 3),
        overheadHours: round(entry.overheadMinutes / 60, 3),
        totalHours: round(entry.totalMinutes / 60, 3),
        sharePct: round(entry.sharePct, 2),
        unitsPerHour: entry.totalMinutes > 0
          ? round(entry.units / (entry.totalMinutes / 60), 1) : 0,
        secondsPerUnit: entry.units > 0 ? round(entry.totalMinutes * 60 / entry.units, 1) : 0,
        targetUnits: goal,
        targetProgressPct: goal > 0 ? round(entry.units / goal * 100, 1) : 0,
        gbTotal: round(entry.gb, 3),
        gbPerSession: round(entry.gbPerSession, 3)
      },
      table: table
    };
  }

  function blockWording(info, geometry) {
    var decode = info.design.decode;
    var conditions = (info.trial && info.trial.conditions) || {};
    var a = conditions.a || 'A';
    var b = conditions.b || 'B';
    if (decode.labelOrder === 'blocked') {
      var runLength = Math.max(1, Math.round(num(decode.labelRunLength, 1)));
      return geometry.trialsPerBlock + ' trials in same-condition runs of ' + runLength
        + ' (' + a + ' and ' + b + ' blocks alternate, no baseline recovery between them)';
    }
    if (decode.labelOrder === 'alternating') {
      return geometry.trialsPerBlock + ' strictly alternating ' + a + '/' + b + ' trials';
    }
    return geometry.trialsPerBlock + ' intermixed, condition-balanced trials';
  }

  function runWording(geometry) {
    return geometry.dummyVolumes + ' dummies (' + round(geometry.dummySeconds, 1) + 's) + '
      + round(geometry.leadIn, 0) + 's lead-in + ' + geometry.blocksPerRun + ' '
      + plural(geometry.blocksPerRun, 'block')
      + (geometry.interBlockRest > 0
        ? ' (' + round(geometry.interBlockRest, 0) + 's inter-block rest)' : '')
      + ' + ' + round(geometry.leadOut, 0) + 's lead-out';
  }

  function buildTotals(report, solved, state, usableHours, committedMinutes) {
    var sessions = sum(solved, function (entry) { return entry.sessions; });
    var trials = sum(solved, function (entry) { return entry.trials; });
    var units = sum(solved, function (entry) { return entry.units; });
    var runs = sum(solved, function (entry) { return entry.runs; });
    var functional = sum(solved, function (entry) { return entry.functionalMinutes; });
    var overhead = sum(solved, function (entry) { return entry.overheadMinutes; });
    var gb = sum(solved, function (entry) { return entry.gb; });
    var weeks = Math.max(1, num(state.budget.weeksAvailable, 1));

    return {
      sessions: sessions,
      runs: Math.round(runs),
      trials: Math.round(trials),
      units: Math.round(units),
      controlTrials: Math.round(trials - units),
      totalScannerHours: num(state.budget.totalScannerHours),
      usableHours: round(usableHours, 2),
      committedHours: round(committedMinutes / 60, 2),
      functionalHours: round(functional / 60, 2),
      overheadHours: round(overhead / 60, 2),
      remainingHours: round(usableHours - committedMinutes / 60, 2),
      utilisationPct: usableHours > 0 ? round(committedMinutes / 60 / usableHours * 100, 1) : 0,
      dataVolumeGb: round(gb, 2),
      sessionsPerWeek: num(state.budget.sessionsPerWeek),
      weeksAvailable: weeks,
      weeksNeeded: num(state.budget.sessionsPerWeek) > 0
        ? round(sessions / num(state.budget.sessionsPerWeek), 1) : 0,
      goalTotal: num(state.budget.targetUnitsTotal),
      goalProgressPct: num(state.budget.targetUnitsTotal) > 0
        ? round(units / num(state.budget.targetUnitsTotal) * 100, 1) : 0,
      warningCount: report.warnings.length
    };
  }

  /* ------------------------------------------------------------ markdown */

  function mdTable(headers, rows, aligns) {
    var lines = [];
    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('|' + headers.map(function (_, index) {
      var align = aligns && aligns[index];
      if (align === 'right') return ' ---: ';
      if (align === 'center') return ' :---: ';
      return ' --- ';
    }).join('|') + '|');
    rows.forEach(function (row) {
      lines.push('| ' + row.map(function (cell) {
        return String(cell === undefined || cell === null ? '' : cell).replace(/\|/g, '\\|');
      }).join(' | ') + ' |');
    });
    return lines.join('\n');
  }

  function buildMarkdown(report) {
    var tables = {};
    var totals = report.totals;

    tables['Study summary'] = mdTable(
      ['Measure', 'Value'],
      [
        ['Study', report.meta.studyTitle],
        ['Experiments', report.experiments.length],
        ['Sessions', fmtNumber(totals.sessions)],
        ['Runs', fmtNumber(totals.runs)],
        ['Trials', fmtNumber(totals.trials)],
        ['Primary events', fmtNumber(totals.units)],
        ['Control trials', fmtNumber(totals.controlTrials)],
        ['Scanner hours committed', totals.committedHours + ' h'],
        ['Usable hours', totals.usableHours + ' h'],
        ['Utilisation', totals.utilisationPct + ' %'],
        ['Raw data volume', totals.dataVolumeGb + ' GB'],
        ['Weeks needed', totals.weeksNeeded + ' of ' + totals.weeksAvailable]
      ],
      ['left', 'right']
    );

    tables['Experiments'] = mdTable(
      ['Experiment', 'Unit', 'Sessions', 'Runs', 'Trials', 'Collected', 'Goal',
        'Progress', 'Hours', 'Share', 'Data'],
      report.experiments.map(function (experiment) {
        var d = experiment.derived;
        return [
          experiment.name, experiment.unit.plural, fmtNumber(d.sessions), fmtNumber(d.runs),
          fmtNumber(d.trials), fmtNumber(d.units), fmtNumber(d.targetUnits),
          d.targetProgressPct + ' %', d.totalHours + ' h', d.sharePct + ' %',
          d.gbTotal + ' GB'
        ];
      }),
      ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']
    );

    tables['Trial designs'] = mdTable(
      ['Trial design', 'Objective', 'Phases', 'Duration', 'Control share', 'Used by'],
      report.trials.map(function (trial) {
        return [
          trial.name, trial.objectiveLabel, trial.sequence,
          fmtRange(trial.timing.min, trial.timing.max),
          trial.controlPct + ' %',
          trial.usedBy.join(', ') || '-'
        ];
      })
    );

    tables['Run designs'] = mdTable(
      ['Run design', 'Trial design', 'Card', 'TR', 'Blocks', 'Trials/block', 'Trials/run',
        'Duration', 'Volumes', 'Used by'],
      report.runs.filter(function (run) { return !run.missing; }).map(function (run) {
        return [
          run.name, run.trialName, run.protocolLabel, round(run.trMs, 0) + ' ms',
          run.structure.blocksPerRun, run.structure.trialsPerBlock,
          run.derived.trialsPerRun,
          fmtRange(run.derived.runMin, run.derived.runMax),
          fmtNumber(run.derived.volumesPerRun),
          run.usedBy.join(', ') || '-'
        ];
      }),
      ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left']
    );

    tables['Session library'] = mdTable(
      ['Session', 'Runs', 'Setup', 'Functional', 'Expected', 'Longest', 'Trials',
        'Data', 'Scheduled', 'Used by'],
      report.sessions.filter(function (session) { return !session.missing; })
        .map(function (session) {
          return [
            session.name, session.runs, session.setupMinutes + ' min',
            round(session.functionalMinutes, 1) + ' min',
            session.meanMinutes + ' min', session.maxMinutes + ' min',
            fmtNumber(session.trials), session.gb + ' GB',
            fmtNumber(session.scheduled),
            session.usedBy.join(', ') || '-'
          ];
        }),
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left']
    );

    report.experiments.forEach(function (experiment) {
      tables[experiment.name + ' - assembly'] = mdTable(
        ['Level', 'Composition', 'Trials', 'Duration'],
        experiment.table.map(function (row) {
          return [row.level, row.sequence, fmtNumber(row.count), row.duration];
        }),
        ['left', 'left', 'right', 'right']
      );
      if (experiment.plan.length) {
        tables[experiment.name + ' - session plan'] = mdTable(
          ['Session', 'Asked for', 'Scheduled', 'Runs each', 'Minutes each',
            'Trials each', experiment.unit.plural + ' each', 'Total minutes'],
          experiment.plan.map(function (row) {
            return [
              row.name, row.requested, row.sessions, row.runsEach, row.minutesEach,
              fmtNumber(row.trialsEach), fmtNumber(row.unitsEach), row.minutes
            ];
          }),
          ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right']
        );
      }
    });

    report.trials.forEach(function (trial) {
      tables[trial.name + ' - phases'] = mdTable(
        ['#', 'Phase', 'Role', 'Min (s)', 'Max (s)', 'Jitter'],
        trial.phases.map(function (phase, index) {
          var role = PHASE_ROLES.filter(function (entry) {
            return entry.id === normaliseRole(phase.role);
          })[0];
          return [
            index + 1, phase.name, (role && role.label) || phase.role,
            trim(phase.min, 1), trim(phase.max, 1), phase.jitter ? 'yes' : 'no'
          ];
        }),
        ['right', 'left', 'left', 'right', 'right', 'center']
      );
    });

    report.sessions.forEach(function (session) {
      if (session.missing || !session.timeline.length) return;
      tables[session.name + ' - timeline'] = mdTable(
        ['#', 'Item', 'Card', 'Minutes', 'Cumulative', 'Category'],
        session.timeline.map(function (row) {
          return [row.order, row.item, row.protocolLabel || '-',
            row.minutes, row.cumulative, row.category];
        }),
        ['right', 'left', 'left', 'right', 'right', 'left']
      );
    });

    tables['Efficiency diagnostics'] = mdTable(
      ['Run design', 'Duty cycle', 'Stacking', 'Single-trial eff.', 'Carryover',
        'Stimulus bleed', 'A vs B', 'Response vs base', 'Stim/resp r', 'Max VIF'],
      report.runs.filter(function (run) { return !run.missing && run.efficiency; })
        .map(function (run) {
          var e = run.efficiency;
          return [
            run.name, round(e.sustainPct, 1) + ' %', round(e.saturationIndex, 2) + ' x',
            round(e.singleTrialEff, 3), round(e.carryoverPct, 1) + ' %',
            round(e.stimulusBleedPct, 1) + ' %', round(e.effAvsB, 3),
            round(e.effResponseVsBaseline, 3), round(e.corrStimulusResponse, 3),
            round(e.maxVif, 2)
          ];
        }),
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']
    );

    tables['Data volume'] = mdTable(
      ['Run design', 'Matrix', 'Slices', 'Volumes/run', 'MB/run', 'Runs', 'Total GB'],
      report.runs.filter(function (run) { return !run.missing; }).map(function (run) {
        return [
          run.name, run.dataVolume.matrix, run.dataVolume.slices,
          fmtNumber(run.dataVolume.volumesPerRun), run.dataVolume.mbPerRun,
          fmtNumber(run.derived.totalRuns), run.dataVolume.gbTotal
        ];
      }),
      ['left', 'left', 'right', 'right', 'right', 'right', 'right']
    );

    tables['Budget and allocation'] = mdTable(
      ['Experiment', 'Requested %', 'Solved share', 'Sessions', 'Functional h',
        'Overhead h', 'Total h'],
      report.experiments.map(function (experiment) {
        var d = experiment.derived;
        return [
          experiment.name, round(experiment.requestedPct, 1) + ' %', d.sharePct + ' %',
          d.sessions, d.functionalHours, d.overheadHours, d.totalHours
        ];
      }).concat([[
        'Total', '100 %', '100 %', totals.sessions, totals.functionalHours,
        totals.overheadHours, totals.committedHours
      ]]),
      ['left', 'right', 'right', 'right', 'right', 'right', 'right']
    );

    tables['Constraint report'] = mdTable(
      ['#', 'Note'],
      report.warnings.length
        ? report.warnings.map(function (warning, index) { return [index + 1, warning]; })
        : [['-', 'No constraint flags: every cap is satisfied.']],
      ['right', 'left']
    );

    return tables;
  }

  function allMarkdown(report) {
    var lines = ['# ' + report.meta.studyTitle, ''];
    if (report.meta.investigator) lines.push('**Investigator:** ' + report.meta.investigator + '  ');
    if (report.meta.institution) lines.push('**Institution:** ' + report.meta.institution + '  ');
    if (report.meta.designId) lines.push('**Design ID:** ' + report.meta.designId + '  ');
    lines.push('**Generated:** ' + report.generated);
    lines.push('');
    Object.keys(report.markdownTables).forEach(function (key) {
      lines.push('## ' + key, '', report.markdownTables[key], '');
    });
    lines.push('## Methods text', '', report.methodsText, '');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------ psychopy */

  var PSYCHOPY_PRESENTATION = [
    'paths:',
    '  data_dir: data                 # the common JSON database lives here',
    '  stimuli: stimuli/index.json',
    '  images_dir: stimuli/images',
    '',
    'window:',
    '  size: [1280, 800]',
    '  fullscreen: true',
    '  screen: 0',
    '  color: [-1, -1, -1]            # PsychoPy rgb, -1..1  (black)',
    '  units: height',
    '  mouse_visible: false',
    '',
    'text:',
    '  font: Arial',
    '  height: 0.06',
    '  wrap_width: 1.3',
    '  color: [1, 1, 1]',
    '  title_pos: [0, 0.30]           # where views that also show graphics put the text',
    '',
    'fixation:',
    '  text: "+"',
    '  height: 0.08',
    '  color: [1, 1, 1]',
    '',
    'cue:',
    '  height: 0.12',
    '  color: [1, 1, 1]'
  ];

  var PSYCHOPY_KEYS = [
    'keys:',
    '  quit: ["escape"]',
    '  advance: ["space"]'
  ];

  /* What the screen shows during a phase, by the phase's planner role. */
  var PSYCHOPY_SHOW = {
    baseline: 'fixation',
    stimulus: 'stimulus',
    delay: 'blank',
    response: 'cue',
    other: 'blank'
  };

  var PSYCHOPY_COMMENT_COLUMN = 31;

  function padRight(text, width) {
    var out = String(text);
    while (out.length < width) out += ' ';
    return out;
  }

  function yamlSlug(text) {
    var slug = String(text === undefined || text === null ? '' : text)
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || 'phase';
  }

  function yamlComment(text) {
    return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function yamlSeconds(value) {
    var rounded = round(num(value), 2);
    return Math.abs(rounded - Math.round(rounded)) < 0.005
      ? Math.round(rounded).toFixed(1) : String(rounded);
  }

  function yamlSetting(key, value, comment) {
    return '  ' + padRight(key + ': ' + value, PSYCHOPY_COMMENT_COLUMN) + '# ' + comment;
  }

  /* Repeated phase names are the norm - most designs open and close on
   * fixation - so make them unique: _pre and _post for a pair, numbered
   * beyond that. */
  function psychopyPhaseNames(phases) {
    var counts = {};
    var bases = (phases || []).map(function (phase) {
      var base = yamlSlug(phase.name);
      counts[base] = (counts[base] || 0) + 1;
      return base;
    });
    var seen = {};
    return bases.map(function (base) {
      if (counts[base] < 2) return base;
      seen[base] = (seen[base] || 0) + 1;
      if (counts[base] === 2) return base + (seen[base] === 1 ? '_pre' : '_post');
      return base + '_' + seen[base];
    });
  }

  function psychopyFileName(runReport) {
    return 'run-' + yamlSlug(runReport.name).replace(/_/g, '-') + '.yaml';
  }

  /* One config per run design: the run is the thing the presentation computer
   * actually executes, so that is what the file describes. */
  function psychopyYaml(report, runReport) {
    var structure = runReport.structure || {};
    var derived = runReport.derived || {};
    var decode = runReport.decode || {};
    var trial = (report.trials || []).filter(function (item) {
      return item.id === runReport.trialId;
    })[0] || { phases: [], conditions: {}, conditionBalance: 50, controlPct: 0 };
    var usedIn = (report.experiments || []).filter(function (experiment) {
      return experiment.runs.some(function (row) { return row.runId === runReport.id; });
    });

    var blocksPerRun = Math.max(1, Math.round(num(structure.blocksPerRun, 1)));
    var trialsPerBlock = Math.max(1, Math.round(num(structure.trialsPerBlock, 1)));
    var trialsPerRun = blocksPerRun * trialsPerBlock;
    var dummyVolumes = Math.max(0, Math.round(num(structure.dummyVolumes)));
    var balance = round(clamp(num(trial.conditionBalance, 50), 0, 100), 1);
    var controlPct = round(clamp(num(trial.controlPct), 0, 100), 1);
    var controlTrials = Math.min(trialsPerRun, Math.round(trialsPerRun * controlPct / 100));
    var primaryTrials = trialsPerRun - controlTrials;
    var conditionA = trial.conditions.a || 'condition_a';
    var conditionB = trial.conditions.b || 'condition_b';

    var phases = trial.phases || [];
    var names = psychopyPhaseNames(phases);
    var responsePhase = phases.filter(function (phase) {
      return normaliseRole(phase.role) === 'response';
    })[0];
    var responseWindow = responsePhase
      ? trim(num(responsePhase.min), 1) + '-second' : 'response';

    var lines = [];
    lines.push('# PsychoPy task configuration - generated by the MRI Experimental Design Planner.');
    lines.push('# Study:      ' + yamlComment(report.meta.studyTitle));
    lines.push('# Run design: ' + yamlComment(runReport.name)
      + ' (trial design: ' + yamlComment(runReport.trialName) + ')');
    lines.push('# Objective:  ' + yamlComment(runReport.objective));
    lines.push('# Card:       ' + yamlComment(runReport.protocol)
      + ', TR ' + round(num(runReport.trMs), 1) + ' ms');
    if (usedIn.length) {
      lines.push('# Used by:    ' + usedIn.map(function (experiment) {
        return yamlComment(experiment.name);
      }).join(', '));
    }
    lines.push('# Generated:  ' + report.generated);
    lines.push('#');
    lines.push('# One run of this file is ' + trialsPerRun + ' trials, '
      + fmtRange(derived.runMin, derived.runMax) + '.');
    lines.push('# The plan calls for ' + fmtNumber(derived.totalRuns) + ' '
      + plural(derived.totalRuns, 'run') + ' in total, '
      + fmtNumber(derived.totalRuns * trialsPerRun) + ' trials.');
    lines.push('# The scanner, run, trial and conditions blocks are filled in from the solved');
    lines.push('# design. Everything else is the lab template, unchanged.');
    lines.push('');
    lines.push('experiment: ' + yamlSlug(runReport.name));
    lines.push('');
    lines = lines.concat(PSYCHOPY_PRESENTATION);

    lines.push('');
    lines.push('scanner:');
    lines.push(yamlSetting('tr', yamlSeconds(num(runReport.trMs) / 1000),
      yamlComment(runReport.protocol)));
    lines.push('  trigger_key: "5"');
    lines.push(yamlSetting('wait_for_triggers', dummyVolumes,
      'dummy volumes; t=0 is the LAST of these pulses'));
    lines.push('  log_triggers: true             # every pulse is written to the database');

    lines.push('');
    lines.push('run:');
    lines.push('  lead_in: ' + yamlSeconds(structure.leadIn));
    lines.push('  lead_out: ' + yamlSeconds(structure.leadOut));
    lines.push('  n_blocks: ' + blocksPerRun);
    lines.push(yamlSetting('trials_per_block', trialsPerBlock,
      '-> ' + trialsPerRun + ' trials/run'));
    lines.push(yamlSetting('inter_block_rest', yamlSeconds(structure.interBlockRest),
      'rest between blocks, inside the run'));
    lines.push(yamlSetting('inter_trial_gap', yamlSeconds(structure.interTrialGap),
      'dead time between successive trials'));
    lines.push(yamlSetting('condition_order', decode.labelOrder || 'intermixed',
      'how the two conditions are sequenced'));
    lines.push(yamlSetting('condition_run_length',
      Math.max(1, Math.round(num(decode.labelRunLength, 1))),
      'same-condition run length (blocked ordering only)'));
    lines.push(yamlSetting('condition_balance_pct', balance,
      'share of primary trials assigned to ' + yamlComment(conditionA)));

    lines.push('');
    lines.push('trial:');
    lines.push('  round_jitter_to_tr: true');
    lines.push('  phases:');
    var nameWidth = 0;
    names.forEach(function (name) { nameWidth = Math.max(nameWidth, name.length + 2); });
    phases.forEach(function (phase, index) {
      var lo = Math.max(0, num(phase.min));
      var hi = Math.max(lo, num(phase.max));
      var jittered = hi - lo > 0.001;
      lines.push('    - {name: ' + padRight(names[index] + ',', nameWidth)
        + 'show: ' + padRight((PSYCHOPY_SHOW[normaliseRole(phase.role)] || 'blank') + ',', 10)
        + 'dur: ' + (jittered ? '[' + yamlSeconds(lo) + ', ' + yamlSeconds(hi) + ']' : yamlSeconds(lo))
        + (jittered ? ', jitter: ' + (phase.jitter ? 'exponential' : 'uniform') : '')
        + '}');
    });

    lines.push('');
    lines.push('# Trial conditions. `per_run` must sum to n_blocks * trials_per_block ('
      + trialsPerRun + ').');
    lines.push('# The control share is the trial design\'s embedded control share ('
      + controlPct + '%).');
    lines.push('conditions:');
    var aTrials = Math.round(primaryTrials * balance / 100);
    var keyA = yamlSlug(conditionA);
    var keyB = yamlSlug(conditionB);
    var keyWidth = Math.max(keyA.length, keyB.length, 'control'.length) + 1;
    lines.push('  ' + padRight(keyA + ':', keyWidth + 1)
      + '{per_run: ' + aTrials + ', label: "' + conditionA + '"}');
    lines.push('  ' + padRight(keyB + ':', keyWidth + 1)
      + '{per_run: ' + (primaryTrials - aTrials) + ', label: "' + conditionB + '"}');
    if (controlTrials > 0) {
      lines.push('  ' + padRight('control:', keyWidth + 1)
        + '{per_run: ' + controlTrials + ', label: "Control / null"}');
    }

    lines.push('');
    lines = lines.concat(PSYCHOPY_KEYS);

    lines.push('');
    lines.push('instructions: |');
    lines.push('  Respond during the ' + responseWindow + ' window, then return to fixation.');
    lines.push('');
    lines.push('  Press SPACE when you are ready.');
    lines.push('');

    return lines.join('\n');
  }

  /* -------------------------------------------------------------- methods */

  function buildMethods(report) {
    var totals = report.totals;
    var parts = [];

    parts.push('**Design.** ' + (report.meta.studyTitle || 'The study')
      + ' comprises ' + report.experiments.length + ' '
      + plural(report.experiments.length, 'experiment') + ' sharing one scanner-time budget of '
      + fmtNumber(totals.totalScannerHours) + ' hours, of which '
      + fmtNumber(totals.usableHours, 1) + ' are usable after a '
      + round(num(report.budget.contingencyPct), 0) + '% contingency reserve. '
      + 'The plan schedules ' + fmtNumber(totals.sessions) + ' '
      + plural(totals.sessions, 'session') + ' carrying ' + fmtNumber(totals.runs)
      + ' functional ' + plural(totals.runs, 'run') + ' and ' + fmtNumber(totals.trials)
      + ' trials, committing ' + fmtNumber(totals.committedHours, 1) + ' hours ('
      + totals.utilisationPct + '% of the usable budget) over '
      + totals.weeksNeeded + ' of the ' + totals.weeksAvailable + ' weeks available at '
      + fmtNumber(totals.sessionsPerWeek) + ' sessions per week.');

    report.experiments.forEach(function (experiment) {
      var d = experiment.derived;
      var lead = experiment.runs.slice().sort(function (a, b) {
        return b.totalRuns - a.totalRuns;
      })[0];
      var runReport = lead ? (report.runs.filter(function (run) {
        return run.id === lead.runId;
      })[0] || null) : null;
      var trialReport = runReport ? (report.trials.filter(function (trial) {
        return trial.id === runReport.trialId;
      })[0] || null) : null;

      var sentence = '**' + experiment.name + '.** ';
      if (trialReport) {
        sentence += 'Each trial runs ' + trialReport.sequence + ', '
          + fmtRange(trialReport.timing.min, trialReport.timing.max) + ' in total, '
          + 'targeting ' + trialReport.objectiveLabel.toLowerCase() + '. ';
      }
      if (runReport) {
        sentence += 'A run holds ' + runReport.structure.blocksPerRun + ' '
          + plural(runReport.structure.blocksPerRun, 'block') + ' of '
          + runReport.structure.trialsPerBlock + ' trials ('
          + runReport.derived.trialsPerRun + ' trials, '
          + fmtRange(runReport.derived.runMin, runReport.derived.runMax) + ') acquired with '
          + runReport.protocolLabel + ' at TR = ' + round(runReport.trMs, 0) + ' ms, TE = '
          + round(runReport.teMs, 1) + ' ms'
          + (runReport.acquisition.voxel ? ', ' + runReport.acquisition.voxel + ' mm voxels' : '')
          + ', ' + fmtNumber(runReport.derived.volumesPerRun) + ' volumes per run. ';
      }
      sentence += 'The plan schedules ' + fmtNumber(d.sessions) + ' '
        + plural(d.sessions, 'session') + ' ('
        + experiment.plan.map(function (row) {
          return fmtNumber(row.sessions) + ' x ' + row.name;
        }).join(', ') + '), '
        + 'expected session duration ' + d.sessionMeanMinutes + ' min (longest '
        + d.sessionMaxMinutes + ' min), yielding ' + fmtNumber(d.units) + ' '
        + experiment.unit.plural
        + (d.controlTrials > 0 ? ' plus ' + fmtNumber(d.controlTrials) + ' control trials' : '')
        + ' in ' + d.totalHours + ' hours (' + d.sharePct + '% of committed scanner time).';
      if (d.targetUnits > 0) {
        sentence += ' That is ' + d.targetProgressPct + '% of the '
          + fmtNumber(d.targetUnits) + ' ' + experiment.unit.plural + ' sought.';
      }
      parts.push(sentence);
    });

    var hrf = report.hrf || {};
    parts.push('**Timing model.** Phase durations were solved against a double-gamma '
      + 'haemodynamic response with a peak at ' + round(num(hrf.peakDelay, 6), 1)
      + ' s, an undershoot at ' + round(num(hrf.undershootDelay, 16), 1)
      + ' s and a peak-to-undershoot ratio of ' + round(num(hrf.undershootRatio, 6), 1)
      + ', evaluated over ' + round(num(hrf.spanSeconds, 40), 0) + ' s. '
      + 'Residual carryover was read ' + round(num(hrf.readLagSeconds, 5), 1)
      + ' s after the onset of the event it might contaminate.');

    parts.push('**Data volume.** The plan generates approximately '
      + totals.dataVolumeGb + ' GB of raw functional data at 16 bits per voxel, before '
      + 'structurals, physiological logs and derivatives.');

    if (report.warnings.length) {
      parts.push('**Constraints.** ' + report.warnings.length + ' constraint '
        + plural(report.warnings.length, 'flag') + ' remains: '
        + report.warnings.join(' '));
    }
    return parts.join('\n\n');
  }

  /* ------------------------------------------------ HRF separation solver */

  function phaseIndices(trial) {
    var index = { stimulus: -1, delay: -1, response: -1, leadBaseline: -1, tailBaseline: -1 };
    (trial.phases || []).forEach(function (phase, position) {
      var role = normaliseRole(phase.role);
      if (role === 'stimulus' && index.stimulus < 0) index.stimulus = position;
      if (role === 'delay' && index.delay < 0 && index.stimulus >= 0) index.delay = position;
      if (role === 'response' && index.response < 0) index.response = position;
      if (role === 'baseline') {
        if (index.response < 0) { if (index.leadBaseline < 0) index.leadBaseline = position; }
        else index.tailBaseline = position;
      }
    });
    if (index.delay < 0) {
      (trial.phases || []).forEach(function (phase, position) {
        if (normaliseRole(phase.role) === 'delay' && index.delay < 0) index.delay = position;
      });
    }
    return index;
  }

  function phaseMean(phase) {
    if (!phase) return 0;
    var lo = Math.max(0, num(phase.min));
    return (lo + Math.max(lo, num(phase.max))) / 2;
  }

  /* How long the planner treats a response of this length as still present.
   * Read off the HRF for a residual tolerance, unless the objective pins an
   * explicit duration instead - that override is what makes "Full HRF
   * separation" mean whatever the user decides it means. */
  function separationSpan(durationSeconds, tolerance, override) {
    if (override > 0) return override;
    if (!global.PlannerEfficiency) return 0;
    return global.PlannerEfficiency.decayTime(durationSeconds, tolerance);
  }

  /* Solve the delay and post-response baseline needed so that no event's
   * predicted response exceeds the tolerance by the time the next event is
   * measured.  Everything comes from the HRF, so the answer is exact rather
   * than searched. */
  function separationTiming(state, trial, tolerancePct) {
    if (!global.PlannerEfficiency || !trial) return null;
    applyHrf(state);
    var index = phaseIndices(trial);
    if (index.stimulus < 0 || index.response < 0) return null;

    var objective = objectiveDef(state, trial.objective);
    var tolerance = clamp(num(tolerancePct, objective.tolerancePct), 0.25, 90) / 100;
    var override = objective.separationSeconds;
    var readLag = objective.readLagSeconds;

    var stimulusPhase = trial.phases[index.stimulus];
    var responsePhase = trial.phases[index.response];
    var delayPhase = index.delay >= 0 ? trial.phases[index.delay] : null;
    var leadPhase = index.leadBaseline >= 0 ? trial.phases[index.leadBaseline] : null;
    var tailPhase = index.tailBaseline >= 0 ? trial.phases[index.tailBaseline] : null;

    var stimulusSeconds = Math.max(0.1, phaseMean(stimulusPhase));
    var responseSeconds = Math.max(0.1, phaseMean(responsePhase));

    /* Stimulus bleed is read at the response peak, `readLag` after the
     * response onset, so the stimulus has had stimulus + delay + readLag to
     * decay. */
    var stimulusDecay = separationSpan(stimulusSeconds, tolerance, override);
    var delayNeeded = Math.max(0, stimulusDecay - stimulusSeconds - readLag);

    /* Carryover is read at the next stimulus onset, so the response has had
     * response + tail baseline + lead baseline to decay. */
    var responseDecay = separationSpan(responseSeconds, tolerance, override);
    var leadSeconds = Math.max(0, phaseMean(leadPhase));
    var tailNeeded = Math.max(0, responseDecay - responseSeconds - leadSeconds);

    var delaySpread = delayPhase ? Math.max(0, num(delayPhase.max) - num(delayPhase.min)) : 0;
    var tailSpread = tailPhase ? Math.max(0, num(tailPhase.max) - num(tailPhase.min)) : 0;

    var delayMin = Math.round(delayNeeded * 2) / 2;
    var tailMin = Math.round(tailNeeded * 2) / 2;

    var trialMean = 0;
    (trial.phases || []).forEach(function (phase, position) {
      if (position === index.delay) trialMean += delayMin + delaySpread / 2;
      else if (position === index.tailBaseline) trialMean += tailMin + tailSpread / 2;
      else trialMean += phaseMean(phase);
    });

    return {
      tolerancePct: tolerance * 100,
      overrideSeconds: override,
      readLagSeconds: readLag,
      delayIndex: index.delay,
      tailIndex: index.tailBaseline,
      delayMin: delayMin,
      delayMax: delayMin + delaySpread,
      tailMin: tailMin,
      tailMax: tailMin + tailSpread,
      stimulusDecay: stimulusDecay,
      responseDecay: responseDecay,
      stimulusSeconds: stimulusSeconds,
      responseSeconds: responseSeconds,
      leadSeconds: leadSeconds,
      trialMean: trialMean,
      /* What the design would actually deliver at these settings. */
      stimulusResidualPct: global.PlannerEfficiency.residualAt(
        stimulusSeconds, stimulusSeconds + delayMin + readLag) * 100,
      carryResidualPct: global.PlannerEfficiency.residualAt(
        responseSeconds, responseSeconds + tailMin + leadSeconds) * 100
    };
  }

  function applySeparationTiming(state, trialId, tolerancePct) {
    var draft = deepCopy(state);
    var trial = byId(draft.trials, trialId);
    if (!trial) return state;
    var objective = objectiveDef(draft, trial.objective);
    trial.separationTolerancePct = clamp(num(tolerancePct, objective.tolerancePct), 0.25, 90);
    var solved = separationTiming(draft, trial, trial.separationTolerancePct);
    if (!solved) return draft;
    if (solved.delayIndex >= 0) {
      trial.phases[solved.delayIndex].min = solved.delayMin;
      trial.phases[solved.delayIndex].max = solved.delayMax;
      trial.phases[solved.delayIndex].jitter = solved.delayMax > solved.delayMin;
    }
    if (solved.tailIndex >= 0) {
      trial.phases[solved.tailIndex].min = solved.tailMin;
      trial.phases[solved.tailIndex].max = solved.tailMax;
      trial.phases[solved.tailIndex].jitter = solved.tailMax > solved.tailMin;
    }
    return draft;
  }

  function applyRecommendedTiming(state, trialId) {
    var draft = deepCopy(state);
    var trial = byId(draft.trials, trialId);
    if (!trial) return state;
    var recommended = RECOMMENDED_TIMING[trial.objective];
    if (!recommended) return state;
    trial.phases = deepCopy(recommended);
    return draft;
  }

  /* Called when the objective changes: adopt the timing that objective
   * implies, and the tolerance it is defined at. */
  function applyObjectiveDefaults(state, trialId) {
    var draft = deepCopy(state);
    var trial = byId(draft.trials, trialId);
    if (!trial) return state;
    var objective = objectiveDef(draft, trial.objective);
    trial.phases = deepCopy(RECOMMENDED_TIMING[trial.objective] || trial.phases);
    trial.separationTolerancePct = objective.tolerancePct;
    draft.runs.forEach(function (run) {
      if (run.trial !== trial.id) return;
      if (trial.objective === 'detection') {
        run.labelOrder = 'blocked';
        run.labelRunLength = Math.max(1, Math.round(num(run.trialsPerBlock, 12)));
        run.interBlockRest = Math.max(num(run.interBlockRest), 20);
      } else {
        run.labelOrder = 'intermixed';
        run.labelRunLength = 1;
      }
    });
    return draft;
  }

  /* ---------------------------------------------------------- optimisers */

  function optimiseStructure(state, boot, runId, objective) {
    var draft = migrateState(deepCopy(state));
    var run = byId(draft.runs, runId);
    if (!run) return state;
    var trial = trialById(draft, run.trial);
    if (!objective || objective === 'auto') objective = (trial && trial.objective) || 'estimation';

    applyHrf(draft);
    var ctx = protocolContext(boot, run.protocol);
    var caps = draft.caps;
    var basis = caps.applyTo === 'longest' ? 'max' : 'mean';
    var best = null;

    /* Efficiency only depends on what happens inside a run, so memoise it on
     * the within-run geometry. */
    var cache = {};
    function metricsFor(probe, geometry) {
      var key = geometry.trialsPerBlock + '|' + geometry.blocksPerRun + '|'
        + geometry.interBlockRest;
      if (!cache[key]) {
        cache[key] = global.PlannerEfficiency
          ? global.PlannerEfficiency.evaluate(probe, ctx.trSeconds, geometry, { maxTrials: 18 })
          : {};
      }
      return cache[key];
    }

    for (var trialsPerBlock = 4; trialsPerBlock <= 24; trialsPerBlock += 1) {
      for (var blocksPerRun = 1; blocksPerRun <= 10; blocksPerRun += 1) {
        var candidate = deepCopy(run);
        candidate.trialsPerBlock = trialsPerBlock;
        candidate.blocksPerRun = blocksPerRun;
        if (candidate.labelOrder === 'blocked') candidate.labelRunLength = trialsPerBlock;
        var geometry = runGeometry(candidate, trial, ctx.trSeconds);
        if (geometry.run[basis] / 60 > num(caps.maxRunMinutes)) continue;

        var probe = {
          phases: (trial && trial.phases) || [],
          seed: (trial && trial.seed) || 20260823,
          decode: {
            labelOrder: candidate.labelOrder,
            labelRunLength: candidate.labelRunLength
          }
        };
        var metrics = objective === 'trials' ? {} : metricsFor(probe, geometry);
        var trialsPerHour = geometry.run.mean > 0
          ? geometry.trialsPerRun / (geometry.run.mean / 3600) : 0;
        var score = global.PlannerEfficiency
          ? global.PlannerEfficiency.objectiveScore(objective, metrics,
            geometry.run.mean / 60, trialsPerHour)
          : trialsPerHour;

        if (!best || score > best.score) {
          best = { score: score, trialsPerBlock: trialsPerBlock, blocksPerRun: blocksPerRun };
        }
      }
    }

    if (best) {
      run.trialsPerBlock = best.trialsPerBlock;
      run.blocksPerRun = best.blocksPerRun;
      if (run.labelOrder === 'blocked') run.labelRunLength = best.trialsPerBlock;
    }
    return draft;
  }

  function optimiseTiming(state, boot, trialId, objective) {
    var draft = migrateState(deepCopy(state));
    var trial = byId(draft.trials, trialId);
    if (!trial || !global.PlannerEfficiency) return state;
    if (!objective || objective === 'auto') objective = trial.objective || 'estimation';
    applyHrf(draft);

    /* Score the trial design inside whichever run uses it, so the cap that
     * matters is the one the run is actually subject to. */
    var run = (draft.runs || []).filter(function (item) { return item.trial === trial.id; })[0]
      || defaultRun(trial.id, (draft.runs[0] || {}).protocol);
    var ctx = protocolContext(boot, run.protocol);
    var basis = draft.caps.applyTo === 'longest' ? 'max' : 'mean';

    var index = phaseIndices(trial);
    if (index.delay < 0 || index.tailBaseline < 0) return state;

    var delayOptions = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18];
    var tailOptions = [2, 4, 6, 8, 12, 16, 20, 24, 28, 32];
    var spreadOptions = [0, 2, 4];
    var best = null;

    delayOptions.forEach(function (delayMin) {
      spreadOptions.forEach(function (delaySpread) {
        tailOptions.forEach(function (tailMin) {
          spreadOptions.forEach(function (tailSpread) {
            var probeTrial = deepCopy(trial);
            probeTrial.phases[index.delay].min = delayMin;
            probeTrial.phases[index.delay].max = delayMin + delaySpread;
            probeTrial.phases[index.delay].jitter = delaySpread > 0;
            probeTrial.phases[index.tailBaseline].min = tailMin;
            probeTrial.phases[index.tailBaseline].max = tailMin + tailSpread;
            probeTrial.phases[index.tailBaseline].jitter = tailSpread > 0;

            var geometry = runGeometry(run, probeTrial, ctx.trSeconds);
            if (geometry.run[basis] / 60 > num(draft.caps.maxRunMinutes)) return;

            var metrics = global.PlannerEfficiency.evaluate({
              phases: probeTrial.phases,
              seed: probeTrial.seed,
              decode: { labelOrder: run.labelOrder, labelRunLength: run.labelRunLength }
            }, ctx.trSeconds, geometry, { maxTrials: 16 });
            var trialsPerHour = 3600 / Math.max(1, geometry.trial.mean);
            var score = global.PlannerEfficiency.objectiveScore(
              objective, metrics, geometry.run.mean / 60, trialsPerHour
            );
            if (!best || score > best.score) {
              best = {
                score: score, delayMin: delayMin, delayMax: delayMin + delaySpread,
                tailMin: tailMin, tailMax: tailMin + tailSpread
              };
            }
          });
        });
      });
    });

    if (best) {
      trial.phases[index.delay].min = best.delayMin;
      trial.phases[index.delay].max = best.delayMax;
      trial.phases[index.delay].jitter = best.delayMax > best.delayMin;
      trial.phases[index.tailBaseline].min = best.tailMin;
      trial.phases[index.tailBaseline].max = best.tailMax;
      trial.phases[index.tailBaseline].jitter = best.tailMax > best.tailMin;
    }
    return draft;
  }

  /* Set the allocation percentages implied by each experiment's own goal. */
  function balanceToTarget(state, boot) {
    var draft = migrateState(deepCopy(state));
    var runInfo = resolveRuns(draft, boot, []);
    var sessionInfo = resolveSessions(draft, boot, runInfo, []);
    var weights = [];
    (draft.experiments || []).forEach(function (experiment) {
      if (!experiment.enabled) { weights.push({ experiment: experiment, weight: 0 }); return; }
      var plan = (experiment.plan || []).filter(function (row) {
        return sessionInfo[row.session];
      });
      var totalWeight = sum(plan, function (row) { return Math.max(0, num(row.count, 1)); });
      var minutes = 0, units = 0;
      plan.forEach(function (row) {
        var share = totalWeight > 0 ? Math.max(0, num(row.count, 1)) / totalWeight : 0;
        minutes += share * sessionInfo[row.session].minutes.mean;
        units += share * sessionInfo[row.session].units;
      });
      var minutesPerUnit = units > 0 ? minutes / units : 0;
      weights.push({ experiment: experiment, weight: num(experiment.targetUnits) * minutesPerUnit });
    });
    var total = sum(weights, function (entry) { return entry.weight; });
    if (total <= 0) return draft;
    weights.forEach(function (entry) {
      entry.experiment.requestedPct = round(entry.weight / total * 100, 2);
    });
    return draft;
  }

  /* --------------------------------------------------- library mutations */

  var Library = {
    addTrial: function (state, preset) {
      var trial = defaultTrial(preset || 'estimation',
        uniqueName(state.trials, 'Trial design'));
      state.trials.push(trial);
      return trial;
    },
    duplicateTrial: function (state, id) {
      var source = byId(state.trials, id);
      if (!source) return null;
      var copy = deepCopy(source);
      copy.id = makeId('trial');
      copy.name = uniqueName(state.trials, source.name + ' (copy)');
      state.trials.splice(state.trials.indexOf(source) + 1, 0, copy);
      return copy;
    },
    removeTrial: function (state, id) {
      if (state.trials.length <= 1) return 'A design needs at least one trial design.';
      var used = (state.runs || []).filter(function (run) { return run.trial === id; });
      if (used.length) {
        return 'Still used by ' + used.map(function (run) { return run.name; }).join(', ')
          + '. Point those run designs somewhere else first.';
      }
      state.trials = state.trials.filter(function (trial) { return trial.id !== id; });
      return null;
    },

    addRun: function (state, trialId, protocol) {
      var run = defaultRun(trialId || (state.trials[0] || {}).id, protocol,
        uniqueName(state.runs, 'Run design'));
      state.runs.push(run);
      return run;
    },
    duplicateRun: function (state, id) {
      var source = byId(state.runs, id);
      if (!source) return null;
      var copy = deepCopy(source);
      copy.id = makeId('run');
      copy.name = uniqueName(state.runs, source.name + ' (copy)');
      state.runs.splice(state.runs.indexOf(source) + 1, 0, copy);
      return copy;
    },
    removeRun: function (state, id) {
      var used = (state.sessions || []).filter(function (session) {
        return (session.blocks || []).some(function (block) {
          return block.kind === 'run' && block.run === id;
        });
      });
      if (used.length) {
        return 'Still used by ' + used.map(function (session) { return session.name; }).join(', ')
          + '. Remove it from those sessions first.';
      }
      state.runs = state.runs.filter(function (run) { return run.id !== id; });
      return null;
    },

    addSession: function (state, runId) {
      var session = defaultSession(uniqueName(state.sessions, 'Session'));
      if (runId) addRunBlocks(session, [{ run: runId, count: 1 }]);
      state.sessions.push(session);
      return session;
    },
    duplicateSession: function (state, id) {
      var source = byId(state.sessions, id);
      if (!source) return null;
      var copy = deepCopy(source);
      copy.id = makeId('session');
      copy.name = uniqueName(state.sessions, source.name + ' (copy)');
      state.sessions.splice(state.sessions.indexOf(source) + 1, 0, copy);
      return copy;
    },
    removeSession: function (state, id) {
      var used = (state.experiments || []).filter(function (experiment) {
        return (experiment.plan || []).some(function (row) { return row.session === id; });
      });
      if (used.length) {
        return 'Still in the plan of '
          + used.map(function (experiment) { return experiment.name; }).join(', ')
          + '. Remove it from those experiments first.';
      }
      state.sessions = state.sessions.filter(function (session) { return session.id !== id; });
      return null;
    },

    addExperiment: function (state, sessionId) {
      var experiment = defaultExperiment(uniqueName(state.experiments, 'Experiment'));
      experiment.short = 'EXP' + (state.experiments.length + 1);
      if (sessionId) experiment.plan = [{ session: sessionId, count: 1 }];
      experiment.requestedPct = 0;
      state.experiments.push(experiment);
      normaliseAllocation(state, null);
      return experiment;
    },
    duplicateExperiment: function (state, id) {
      var source = byId(state.experiments, id);
      if (!source) return null;
      var copy = deepCopy(source);
      copy.id = makeId('exp');
      copy.name = uniqueName(state.experiments, source.name + ' (copy)');
      copy.short = (source.short || 'EXP') + '-2';
      state.experiments.splice(state.experiments.indexOf(source) + 1, 0, copy);
      normaliseAllocation(state, null);
      return copy;
    },
    removeExperiment: function (state, id) {
      if (state.experiments.length <= 1) return 'A study needs at least one experiment.';
      state.experiments = state.experiments.filter(function (item) { return item.id !== id; });
      normaliseAllocation(state, null);
      return null;
    },

    move: function (list, id, delta) {
      var index = -1;
      for (var i = 0; i < list.length; i += 1) if (list[i].id === id) index = i;
      if (index < 0) return false;
      var target = index + delta;
      if (target < 0 || target >= list.length) return false;
      var item = list.splice(index, 1)[0];
      list.splice(target, 0, item);
      return true;
    }
  };

  global.PlannerModel = {
    PHASE_ROLES: PHASE_ROLES,
    OBJECTIVES: OBJECTIVES,
    SOLVE_MODES: SOLVE_MODES,
    ALLOCATION_UNITS: ALLOCATION_UNITS,
    LABEL_ORDERS: LABEL_ORDERS,
    RECOMMENDED_TIMING: RECOMMENDED_TIMING,
    STRUCTURAL_DEFAULTS: STRUCTURAL_DEFAULTS,
    DEFAULT_UNIT: DEFAULT_UNIT,

    defaultState: defaultState,
    defaultHrf: defaultHrf,
    defaultTrial: defaultTrial,
    defaultRun: defaultRun,
    defaultSession: defaultSession,
    defaultExperiment: defaultExperiment,
    migrateState: migrateState,
    makeId: makeId,
    uniqueName: uniqueName,

    byId: byId,
    trialById: trialById,
    runById: runById,
    sessionById: sessionById,
    experimentById: experimentById,
    enabledExperiments: enabledExperiments,
    runDesign: runDesign,
    unitOf: unitOf,
    normaliseRole: normaliseRole,
    objectiveDef: objectiveDef,
    applyHrf: applyHrf,

    solve: solve,
    protocolContext: protocolContext,
    trialTiming: trialTiming,
    runGeometry: runGeometry,
    structuralMinutes: structuralMinutes,
    buildSessionPlan: buildSessionPlan,
    structuralRows: structuralRows,
    setupRows: setupRows,
    makeBlock: makeBlock,
    BLOCK_KINDS: BLOCK_KINDS,
    BLOCK_LABELS: BLOCK_LABELS,
    normaliseAllocation: normaliseAllocation,
    distributeSessions: distributeSessions,

    optimiseStructure: optimiseStructure,
    optimiseTiming: optimiseTiming,
    applyRecommendedTiming: applyRecommendedTiming,
    applyObjectiveDefaults: applyObjectiveDefaults,
    separationTiming: separationTiming,
    applySeparationTiming: applySeparationTiming,
    phaseIndices: phaseIndices,
    balanceToTarget: balanceToTarget,

    Library: Library,
    allMarkdown: allMarkdown,
    mdTable: mdTable,
    psychopyYaml: psychopyYaml,
    psychopyFileName: psychopyFileName,

    helpers: {
      num: num, clamp: clamp, round: round, sum: sum, deepCopy: deepCopy,
      fmtNumber: fmtNumber, fmtSeconds: fmtSeconds, fmtRange: fmtRange, trim: trim,
      fmtMinutes: fmtMinutes, fmtClock: fmtClock, phaseLabel: phaseLabel, plural: plural
    }
  };
}(window));
