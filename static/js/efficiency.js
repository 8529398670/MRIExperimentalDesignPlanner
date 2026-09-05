/* Design efficiency engine.
 *
 * Simulates one run of a given run design, builds the HRF-convolved design
 * matrix at the acquisition TR and reports contrast efficiency, regressor
 * collinearity and variance inflation.  Fast enough to sit inside the
 * optimiser's grid search: HRF convolution is evaluated analytically from a
 * precomputed integral of the response rather than by dense convolution.
 *
 * The haemodynamic response itself is not hard-wired.  `configure()` takes the
 * double-gamma parameters from the design state, so the peak delay, the
 * undershoot and the span the planner treats as "recovered" are all editable
 * and every derived number follows them. */

(function (global) {
  'use strict';

  var HRF_DT = 0.05;

  /* SPM's canonical double gamma, as defaults rather than as constants. */
  var DEFAULT_HRF = {
    peakDelay: 6,
    peakDispersion: 1,
    undershootDelay: 16,
    undershootDispersion: 1,
    undershootRatio: 6,
    spanSeconds: 40
  };

  var hrf = copy(DEFAULT_HRF);
  var HRF_INTEGRAL = null;
  var HRF_PEAK = 1;
  var PEAK_CACHE = {};
  var DECAY_CACHE = {};

  function copy(source) {
    var out = {};
    Object.keys(source).forEach(function (key) { out[key] = source[key]; });
    return out;
  }

  function positive(value, fallback) {
    var parsed = typeof value === 'number' ? value : parseFloat(value);
    return isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /* Adopt a new response shape.  Returns true when something actually moved,
   * so callers can skip a re-solve when nothing has. */
  function configure(params) {
    var next = {
      peakDelay: positive(params && params.peakDelay, DEFAULT_HRF.peakDelay),
      peakDispersion: positive(params && params.peakDispersion, DEFAULT_HRF.peakDispersion),
      undershootDelay: positive(params && params.undershootDelay, DEFAULT_HRF.undershootDelay),
      undershootDispersion: positive(params && params.undershootDispersion,
        DEFAULT_HRF.undershootDispersion),
      undershootRatio: positive(params && params.undershootRatio, DEFAULT_HRF.undershootRatio),
      spanSeconds: Math.min(120, Math.max(12,
        positive(params && params.spanSeconds, DEFAULT_HRF.spanSeconds)))
    };
    var changed = Object.keys(next).some(function (key) { return next[key] !== hrf[key]; });
    if (!changed) return false;
    hrf = next;
    HRF_INTEGRAL = null;
    PEAK_CACHE = {};
    DECAY_CACHE = {};
    return true;
  }

  function hrfParams() { return copy(hrf); }
  function span() { return hrf.spanSeconds; }

  /* ------------------------------------------------------------------ hrf */

  function gammaPdf(t, shape, scale) {
    if (t <= 0) return 0;
    var logValue = (shape - 1) * Math.log(t) - t / scale
      - logGamma(shape) - shape * Math.log(scale);
    return Math.exp(logValue);
  }

  function logGamma(x) {
    var cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    var ser = 1.000000000190015;
    for (var j = 0; j < 6; j += 1) { y += 1; ser += cof[j] / y; }
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  function canonicalHrf(t) {
    return gammaPdf(t, hrf.peakDelay / hrf.peakDispersion, hrf.peakDispersion)
      - gammaPdf(t, hrf.undershootDelay / hrf.undershootDispersion, hrf.undershootDispersion)
      / hrf.undershootRatio;
  }

  function buildHrfIntegral() {
    var steps = Math.round(hrf.spanSeconds / HRF_DT) + 1;
    var values = new Float64Array(steps);
    var peak = 0;
    for (var i = 0; i < steps; i += 1) {
      var v = canonicalHrf(i * HRF_DT);
      values[i] = v;
      if (v > peak) peak = v;
    }
    HRF_PEAK = peak || 1;
    var integral = new Float64Array(steps);
    var running = 0;
    for (var k = 1; k < steps; k += 1) {
      running += (values[k] + values[k - 1]) / 2 * HRF_DT;
      integral[k] = running;
    }
    /* Scale so a long boxcar asymptotes near unit amplitude per second of HRF peak. */
    for (var m = 0; m < steps; m += 1) integral[m] /= HRF_PEAK;
    HRF_INTEGRAL = integral;
  }

  function hrfIntegralAt(t) {
    if (!HRF_INTEGRAL) buildHrfIntegral();
    if (t <= 0) return 0;
    if (t >= hrf.spanSeconds) return HRF_INTEGRAL[HRF_INTEGRAL.length - 1];
    var position = t / HRF_DT;
    var lower = Math.floor(position);
    var frac = position - lower;
    return HRF_INTEGRAL[lower] * (1 - frac) + HRF_INTEGRAL[lower + 1] * frac;
  }

  function boxcarResponse(time, onset, duration) {
    return hrfIntegralAt(time - onset) - hrfIntegralAt(time - onset - duration);
  }

  function singleEventPeak(duration) {
    var key = Math.round(duration * 100);
    if (PEAK_CACHE[key] !== undefined) return PEAK_CACHE[key];
    var peak = 0;
    var limit = hrf.peakDelay * 4;
    for (var t = 0; t <= limit; t += 0.1) {
      var value = boxcarResponse(t, 0, duration);
      if (value > peak) peak = value;
    }
    PEAK_CACHE[key] = peak || 1;
    return PEAK_CACHE[key];
  }

  /* How long after an event onset the predicted response stays above a given
   * fraction of its own peak, undershoot included.  This is the quantity that
   * decides how much rest a design needs for clean separation, and it can be
   * read straight off the HRF rather than searched for. */
  function decayTime(duration, tolerance) {
    var key = Math.round(duration * 100) + ':' + Math.round(tolerance * 1e6);
    if (DECAY_CACHE[key] !== undefined) return DECAY_CACHE[key];
    var peak = singleEventPeak(duration);
    var limit = Math.max(1e-9, tolerance) * peak;
    var step = 0.1;
    var last = 0;
    for (var t = 0; t <= hrf.spanSeconds + duration; t += step) {
      if (Math.abs(boxcarResponse(t, 0, duration)) > limit) last = t;
    }
    DECAY_CACHE[key] = Math.round((last + step) * 10) / 10;
    return DECAY_CACHE[key];
  }

  /* Residual, as a fraction of the event's own peak, a given time after onset. */
  function residualAt(duration, elapsed) {
    var peak = singleEventPeak(duration);
    if (peak <= 0) return 0;
    return Math.abs(boxcarResponse(elapsed, 0, duration)) / peak;
  }

  /* --------------------------------------------------------------- random */

  /* Jitter is sampled from a fixed stream so the same design always solves to
   * the same numbers.  What the participant actually sees on any given run is
   * the presentation software's business, not the planner's. */
  var JITTER_SEED = 20260823;

  function mulberry32(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------- timeline */

  /* Phase roles the regressor model understands.  Everything else is baseline. */
  function roleOf(phase) {
    var role = String((phase && phase.role) || '').toLowerCase();
    if (role === 'question' || role === 'cue') return 'stimulus';   /* legacy names */
    if (role === 'answer') return 'response';
    if (role === 'stimulus' || role === 'response') return role;
    return 'baseline';
  }

  /* `design` is a run design flattened against its trial: its phases and
   * nothing else.  Everything geometric comes in through `geometry`.  What
   * gets presented in each trial is the presentation software's business, so
   * every response window lands in one regressor here. */
  function buildRun(design, geometry, rng, maxTrials) {
    var events = { stimulus: [], response: [] };
    var trials = [];
    var time = geometry.leadIn;
    var cap = maxTrials && maxTrials > 0
      ? Math.min(geometry.trialsPerRun, maxTrials) : geometry.trialsPerRun;
    var phases = design.phases || [];

    var trialIndex = 0;
    var stop = false;
    for (var block = 0; block < geometry.blocksPerRun && !stop; block += 1) {
      if (block > 0) time += geometry.interBlockRest;
      for (var trial = 0; trial < geometry.trialsPerBlock; trial += 1) {
        if (trialIndex >= cap) { stop = true; break; }
        var record = { start: time, stimulus: null, response: null };
        for (var p = 0; p < phases.length; p += 1) {
          var phase = phases[p];
          var lo = Math.max(0, Number(phase.min) || 0);
          var hi = Math.max(lo, Number(phase.max) || lo);
          var duration = hi > lo ? lo + rng() * (hi - lo) : lo;
          var role = roleOf(phase);
          if (role === 'stimulus') {
            var sEvent = { onset: time, duration: duration };
            events.stimulus.push(sEvent);
            if (!record.stimulus) record.stimulus = sEvent;
          } else if (role === 'response') {
            var rEvent = { onset: time, duration: duration };
            events.response.push(rEvent);
            record.response = rEvent;
          }
          time += duration;
        }
        time += geometry.interTrialGap;
        record.end = time;
        trials.push(record);
        trialIndex += 1;
      }
    }
    return { events: events, trials: trials, duration: time + geometry.leadOut };
  }

  /* --------------------------------------------------------------- matrix */

  function invert(matrix) {
    var n = matrix.length;
    var augmented = [];
    for (var i = 0; i < n; i += 1) {
      augmented.push(matrix[i].slice());
      for (var j = 0; j < n; j += 1) augmented[i].push(i === j ? 1 : 0);
    }
    for (var col = 0; col < n; col += 1) {
      var pivot = col;
      for (var row = col + 1; row < n; row += 1) {
        if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
      }
      if (Math.abs(augmented[pivot][col]) < 1e-12) return null;
      var tmp = augmented[col]; augmented[col] = augmented[pivot]; augmented[pivot] = tmp;
      var lead = augmented[col][col];
      for (var k = 0; k < 2 * n; k += 1) augmented[col][k] /= lead;
      for (var other = 0; other < n; other += 1) {
        if (other === col) continue;
        var factor = augmented[other][col];
        if (factor === 0) continue;
        for (var m = 0; m < 2 * n; m += 1) augmented[other][m] -= factor * augmented[col][m];
      }
    }
    var inverse = [];
    for (var r = 0; r < n; r += 1) inverse.push(augmented[r].slice(n));
    return inverse;
  }

  function gram(columns) {
    var n = columns.length;
    var out = [];
    for (var i = 0; i < n; i += 1) {
      out.push(new Array(n).fill(0));
    }
    for (var a = 0; a < n; a += 1) {
      for (var b = a; b < n; b += 1) {
        var total = 0;
        var ca = columns[a], cb = columns[b];
        for (var k = 0; k < ca.length; k += 1) total += ca[k] * cb[k];
        out[a][b] = total;
        out[b][a] = total;
      }
    }
    return out;
  }

  function correlation(a, b) {
    var n = Math.min(a.length, b.length);
    if (!n) return 0;
    var meanA = 0, meanB = 0;
    for (var i = 0; i < n; i += 1) { meanA += a[i]; meanB += b[i]; }
    meanA /= n; meanB /= n;
    var num = 0, da = 0, db = 0;
    for (var k = 0; k < n; k += 1) {
      var x = a[k] - meanA, y = b[k] - meanB;
      num += x * y; da += x * x; db += y * y;
    }
    if (da <= 0 || db <= 0) return 0;
    return num / Math.sqrt(da * db);
  }

  function contrastEfficiency(inverse, contrast) {
    var n = contrast.length;
    var total = 0;
    for (var i = 0; i < n; i += 1) {
      for (var j = 0; j < n; j += 1) {
        total += contrast[i] * inverse[i][j] * contrast[j];
      }
    }
    if (!(total > 0)) return 0;
    return 1 / total;
  }

  function varianceInflation(columns) {
    var n = columns.length;
    var correlations = [];
    for (var i = 0; i < n; i += 1) {
      correlations.push(new Array(n).fill(0));
    }
    for (var a = 0; a < n; a += 1) {
      for (var b = 0; b < n; b += 1) {
        correlations[a][b] = a === b ? 1 : correlation(columns[a], columns[b]);
      }
    }
    var inverse = invert(correlations);
    if (!inverse) return { max: Infinity, values: [] };
    var values = [];
    var max = 0;
    for (var k = 0; k < n; k += 1) {
      values.push(inverse[k][k]);
      if (inverse[k][k] > max) max = inverse[k][k];
    }
    return { max: max, values: values };
  }

  /* ------------------------------------------------------------- evaluate */

  var MAX_VOLUMES = 4000;
  var MAX_LSA_TRIALS = 64;

  /* Least-squares-all estimability: one regressor per response event.  The mean
   * variance of those trial betas is what single-trial decoding pays for. */
  function singleTrialEfficiency(run, tr, volumes, stimulus, intercept, linear, quadratic) {
    var trials = run.trials.filter(function (record) { return record.response; });
    if (!trials.length) return 0;
    var step = Math.max(1, Math.ceil(trials.length / MAX_LSA_TRIALS));
    var selected = [];
    for (var i = 0; i < trials.length; i += step) selected.push(trials[i]);
    if (selected.length < 2) return 0;

    var reach = span();
    var columns = selected.map(function (record) {
      var column = new Float64Array(volumes);
      var start = Math.max(0, Math.floor((record.response.onset - 1) / tr));
      var stop = Math.min(volumes,
        Math.ceil((record.response.onset + record.response.duration + reach) / tr));
      for (var k = start; k < stop; k += 1) {
        column[k] = boxcarResponse(k * tr, record.response.onset, record.response.duration);
      }
      return column;
    });
    columns.push(stimulus, intercept, linear, quadratic);

    var xtx = gram(columns);
    for (var d = 0; d < xtx.length; d += 1) xtx[d][d] += 1e-8;
    var inverse = invert(xtx);
    if (!inverse) return 0;
    var total = 0;
    for (var t = 0; t < selected.length; t += 1) total += inverse[t][t];
    var meanVariance = total / selected.length;
    return meanVariance > 0 ? 1 / meanVariance : 0;
  }

  function evaluate(design, trSeconds, geometry, options) {
    options = options || {};
    var tr = trSeconds > 0 ? trSeconds : 2;
    var reach = span();
    var rng = mulberry32(JITTER_SEED);
    var run = buildRun(design, geometry, rng, options.maxTrials);
    var volumes = Math.min(MAX_VOLUMES, Math.max(8, Math.ceil(run.duration / tr)));

    var stimulus = new Float64Array(volumes);
    var response = new Float64Array(volumes);

    function fill(target, list) {
      for (var e = 0; e < list.length; e += 1) {
        var onset = list[e].onset;
        var duration = list[e].duration;
        var start = Math.max(0, Math.floor((onset - 1) / tr));
        var stop = Math.min(volumes, Math.ceil((onset + duration + reach) / tr));
        for (var k = start; k < stop; k += 1) {
          target[k] += boxcarResponse(k * tr, onset, duration);
        }
      }
    }
    fill(stimulus, run.events.stimulus);
    fill(response, run.events.response);

    var intercept = new Float64Array(volumes);
    var linear = new Float64Array(volumes);
    var quadratic = new Float64Array(volumes);
    for (var v = 0; v < volumes; v += 1) {
      var position = volumes > 1 ? (2 * v / (volumes - 1)) - 1 : 0;
      intercept[v] = 1;
      linear[v] = position;
      quadratic[v] = 1.5 * position * position - 0.5;
    }

    var columns = [stimulus, response, intercept, linear, quadratic];
    var xtx = gram(columns);
    var inverse = invert(xtx);
    if (!inverse) {
      for (var d = 0; d < xtx.length; d += 1) xtx[d][d] += 1e-6;
      inverse = invert(xtx);
    }

    var result = {
      volumes: volumes,
      regressors: columns.length,
      trSeconds: tr,
      runSeconds: Math.round(run.duration * 10) / 10,
      trialCount: geometry.trialsPerRun,
      effResponseVsBaseline: 0,
      effStimulusVsResponse: 0,
      corrStimulusResponse: 0,
      maxVif: 0,
      saturationIndex: 0,
      sustainPct: 0,
      carryoverPct: 0,
      stimulusBleedPct: 0,
      singleTrialEff: 0
    };

    if (inverse) {
      result.effResponseVsBaseline = contrastEfficiency(inverse, [0, 1, 0, 0, 0]);
      result.effStimulusVsResponse = contrastEfficiency(inverse, [1, -1, 0, 0, 0]);
    }

    result.corrStimulusResponse = correlation(stimulus, response);
    var vif = varianceInflation([stimulus, response]);
    result.maxVif = isFinite(vif.max) ? vif.max : 999;
    result.vif = vif.values;

    /* --- design-quality diagnostics ----------------------------------- */
    var responseDuration = run.trials.length && run.trials[0].response
      ? run.trials[0].response.duration : 3;
    var unitPeak = singleEventPeak(responseDuration);

    /* Peak of one isolated trial (its stimulus plus its response), which is the
     * reference a saturating design is supposed to exceed. */
    var reference = run.trials[0];
    var unitTrialPeak = unitPeak;
    if (reference && reference.stimulus && reference.response) {
      var trialSpan = (reference.response.onset - reference.stimulus.onset) + reach * 0.6;
      var trialPeak = 0;
      for (var u = 0; u <= trialSpan; u += 0.2) {
        var level = boxcarResponse(reference.stimulus.onset + u, reference.stimulus.onset,
          reference.stimulus.duration)
          + boxcarResponse(reference.stimulus.onset + u, reference.response.onset,
            reference.response.duration);
        if (level > trialPeak) trialPeak = level;
      }
      if (trialPeak > 0) unitTrialPeak = trialPeak;
    }

    /* Total predicted task signal, sampled inside the trial sequence only. */
    var firstSample = Math.max(0, Math.floor(geometry.leadIn / tr));
    var lastSample = Math.min(volumes, Math.ceil(
      (run.trials.length ? run.trials[run.trials.length - 1].end : run.duration) / tr
    ));
    var task = [];
    var stacked = 0;
    for (var m = firstSample; m < lastSample; m += 1) {
      var total = stimulus[m] + response[m];
      task.push(total);
      if (total > stacked) stacked = total;
    }
    result.saturationIndex = unitTrialPeak > 0 ? stacked / unitTrialPeak : 0;

    /* Duty cycle: how much of the run the predicted signal spends elevated.
     * A saturating design holds a high median relative to its peak; a design
     * that recovers fully sits at baseline between events, so the median
     * collapses towards zero. */
    if (task.length > 8) {
      var sorted = task.slice().sort(function (a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length * 0.5)];
      var ceiling = sorted[Math.floor(sorted.length * 0.95)];
      result.sustainPct = ceiling > 0
        ? Math.max(0, Math.min(100, (median / ceiling) * 100)) : 0;
    } else {
      result.sustainPct = 0;
    }

    var carry = 0, carryCount = 0;
    for (var t = 1; t < run.trials.length; t += 1) {
      var previous = run.trials[t - 1].response;
      var nextStimulus = run.trials[t].stimulus;
      if (!previous || !nextStimulus) continue;
      carry += Math.abs(boxcarResponse(nextStimulus.onset, previous.onset, previous.duration)) / unitPeak;
      carryCount += 1;
    }
    result.carryoverPct = carryCount ? (carry / carryCount) * 100 : 0;

    var residual = 0, residualCount = 0;
    for (var q = 0; q < run.trials.length; q += 1) {
      var ownStimulus = run.trials[q].stimulus;
      var ownResponse = run.trials[q].response;
      if (!ownStimulus || !ownResponse) continue;
      var stimulusPeak = singleEventPeak(ownStimulus.duration);
      residual += Math.abs(
        boxcarResponse(ownResponse.onset + hrf.peakDelay * 0.85, ownStimulus.onset,
          ownStimulus.duration)
      ) / stimulusPeak;
      residualCount += 1;
    }
    result.stimulusBleedPct = residualCount ? (residual / residualCount) * 100 : 0;

    if (options.singleTrial !== false) {
      result.singleTrialEff = singleTrialEfficiency(run, tr, volumes, stimulus,
        intercept, linear, quadratic);
    }

    if (options.series) {
      var stride = Math.max(1, Math.ceil(volumes / 900));
      var series = { t: [], stimulus: [], response: [] };
      for (var s = 0; s < volumes; s += stride) {
        series.t.push(Math.round(s * tr * 10) / 10);
        series.stimulus.push(stimulus[s]);
        series.response.push(response[s]);
      }
      result.series = series;
      result.events = run.events;
    }

    return result;
  }

  /* Objective scores: what "good" means differs by design objective.
   *   detection  - saturation: stack same-condition responses, power per minute
   *   estimation - single-trial beta estimability, throughput as tiebreak
   *   separation - stimulus and response HRFs resolved, baseline recovered
   */
  function objectiveScore(objective, metrics, runMinutes, trialsPerHour) {
    var minutes = Math.max(0.01, runMinutes);
    var throughput = Math.max(1, trialsPerHour || 0);
    var separation = 1 - Math.min(1, Math.abs(metrics.corrStimulusResponse || 0));
    var recovery = 1 - Math.min(1, (metrics.carryoverPct || 0) / 100);
    var stimulusClear = 1 - Math.min(1, (metrics.stimulusBleedPct || 0) / 100);
    var duty = Math.min(1, (metrics.sustainPct || 0) / 100);

    if (objective === 'detection') {
      /* Reward a high duty cycle and any genuine stacking, per minute of run,
       * with throughput breaking ties between equally saturating designs. */
      return ((metrics.effResponseVsBaseline || 0) / minutes)
        * (1 + Math.max(0, (metrics.saturationIndex || 0) - 1))
        * (0.3 + 1.7 * duty)
        * Math.sqrt(throughput);
    }
    if (objective === 'estimation') {
      /* Trial betas must be individually estimable and uncontaminated by the
       * stimulus response that precedes them. */
      return (metrics.singleTrialEff || 0)
        * Math.sqrt(throughput)
        * separation * stimulusClear;
    }
    if (objective === 'separation') {
      /* Cleanliness dominates: the stimulus response and the previous trial
       * must both be gone. Throughput is only a weak tiebreak. */
      var clean = separation * recovery * stimulusClear;
      return Math.pow(clean, 3) * Math.pow(throughput, 0.25);
    }
    return throughput;
  }

  global.PlannerEfficiency = {
    configure: configure,
    hrfParams: hrfParams,
    defaultHrf: function () { return copy(DEFAULT_HRF); },
    span: span,
    evaluate: evaluate,
    objectiveScore: objectiveScore,
    decayTime: decayTime,
    residualAt: residualAt,
    canonicalHrf: canonicalHrf,
    boxcarResponse: boxcarResponse,
    singleEventPeak: singleEventPeak,
    roleOf: roleOf,
    invert: invert
  };
}(window));
