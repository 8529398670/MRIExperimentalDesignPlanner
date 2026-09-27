/* MRI Experimental Design Planner - the action layer.
 *
 * One named action for every button and control that changes a design.  An
 * action takes the design state (and the acquisition cards, in `boot`),
 * changes it exactly as the matching control would, and returns a small
 * result.  The same file runs in two places:
 *
 *   - the browser, where the buttons call these actions through App.act, and
 *   - the server, inside QuickJS, behind POST /api/v1/designs/<name>/actions,
 *     so an agent can build a whole study over HTTP without a browser.
 *
 * The catalogue below is also the reference documentation: GET /api/v1 serves
 * it, and every call is validated against these argument specs, so what the
 * docs say and what the code accepts cannot drift apart.
 *
 * A few actions touch files on the server (acquisition cards, saved designs).
 * They are listed here with `host: 'server'` so they validate and document the
 * same way; the server carries them out. */

(function (global) {
  'use strict';

  var M = global.PlannerModel;
  var H = M.helpers;

  /* ------------------------------------------------------------- errors */

  /* A refusal the caller can act on: a bad argument, a missing name, a rule
   * the design enforces.  Anything else that is thrown is a bug. */
  function ActionError(message) {
    this.name = 'ActionError';
    this.message = message;
    this.planner = true;
  }
  ActionError.prototype = Object.create(Error.prototype);
  ActionError.prototype.constructor = ActionError;

  function fail(message) { throw new ActionError(message); }

  /* ------------------------------------------------------ argument specs */

  function spec(type, doc, extra) {
    var out = { type: type, doc: doc };
    Object.keys(extra || {}).forEach(function (key) { out[key] = extra[key]; });
    return out;
  }
  function str(doc, extra) { return spec('string', doc, extra); }
  function name(doc, extra) { return spec('string', doc, Object.assign({ nonEmpty: true }, extra)); }
  function number(doc, min, max, extra) {
    return spec('number', doc, Object.assign({ min: min, max: max }, extra));
  }
  function integer(doc, min, max, extra) {
    return spec('integer', doc, Object.assign({ min: min, max: max }, extra));
  }
  function bool(doc, extra) { return spec('boolean', doc, extra); }
  function choice(values, doc, extra) {
    return spec('enum', doc, Object.assign({ values: values }, extra));
  }
  function ref(kind, doc, extra) { return spec('ref', doc, Object.assign({ ref: kind }, extra)); }
  function object(doc, extra) { return spec('object', doc, extra); }
  function list(doc, extra) { return spec('array', doc, extra); }
  function required(item) { item.required = true; return item; }

  /* The item an action is about.  A design.get item carries its own `id`,
   * so `id` is accepted in place of this argument. */
  function subject(kind, doc) {
    return required(ref(kind, doc, { aliases: ['id'] }));
  }

  /* {key: value, ...rest} for a key held in a variable. */
  function keyed(key, value, rest) {
    var out = {};
    out[key] = value;
    return Object.assign(out, rest || {});
  }

  var PHASE_ROLE_IDS = M.PHASE_ROLES.map(function (role) { return role.id; });
  var OBJECTIVE_IDS = M.OBJECTIVES.map(function (objective) { return objective.id; });
  var SOLVE_MODE_IDS = M.SOLVE_MODES.map(function (mode) { return mode.id; });
  var UNIT_IDS = M.ALLOCATION_UNITS.map(function (unit) { return unit.id; });

  var NOUNS = {
    trial: 'trial design', run: 'run design', session: 'session',
    experiment: 'experiment', card: 'acquisition card'
  };
  var LISTS = { trial: 'trials', run: 'runs', session: 'sessions', experiment: 'experiments' };

  /* Move by one of two means, never both. */
  var MOVE_ARGS = {
    to: integer('New 0-based position (clamped to the list)', 0),
    delta: integer('Steps to move: -1 is one earlier, +1 one later')
  };

  /* --------------------------------------------------------- references */

  function describe(items) {
    return items.map(function (item) {
      return '"' + item.name + '" (' + item.id + ')';
    }).join(', ');
  }

  function keyOf(value) {
    if (value && typeof value === 'object' && value.id) return String(value.id);
    return String(value === undefined || value === null ? '' : value).trim();
  }

  /* An item by id, then by exact name, then by name ignoring case. */
  function find(state, kind, value) {
    var items = state[LISTS[kind]] || [];
    var key = keyOf(value);
    if (!key) fail('Say which ' + NOUNS[kind] + ', by id or by name.');
    var hits = items.filter(function (item) { return item.id === key; });
    if (!hits.length) hits = items.filter(function (item) { return item.name === key; });
    if (!hits.length) {
      hits = items.filter(function (item) {
        return String(item.name).toLowerCase() === key.toLowerCase();
      });
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      fail('More than one ' + NOUNS[kind] + ' is called "' + key + '": ' + describe(hits)
        + '. Use the id.');
    }
    fail('No ' + NOUNS[kind] + ' "' + key + '". '
      + (items.length ? 'The design has: ' + describe(items) + '.' : 'The design has none yet.'));
    return null;
  }

  /* A card by slug, then by label, each exact before ignoring case. */
  function findCard(boot, value) {
    var manifest = (boot && boot.manifest) || [];
    var key = keyOf(value);
    if (!key) fail('Say which acquisition card, by slug or by name.');
    var lower = key.toLowerCase();
    var tests = [
      function (entry) { return entry.slug === key; },
      function (entry) { return entry.label === key; },
      function (entry) { return String(entry.slug).toLowerCase() === lower; },
      function (entry) { return String(entry.label).toLowerCase() === lower; }
    ];
    for (var i = 0; i < tests.length; i += 1) {
      var hits = manifest.filter(tests[i]);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        fail('More than one card matches "' + key + '": '
          + hits.map(function (entry) { return entry.slug; }).join(', ') + '. Use the slug.');
      }
    }
    fail('No acquisition card "' + key + '". Cards: '
      + manifest.map(function (entry) { return entry.slug; }).join(', ') + '.');
    return null;
  }

  function firstFunctionalCard(boot) {
    var entry = ((boot && boot.manifest) || []).filter(function (item) {
      return item.role === 'functional';
    })[0];
    return entry ? entry.slug : null;
  }

  /* Names are how an agent refers to what it just built, so an action that
   * sets one refuses a name another item at the same level already has. */
  function claimName(state, kind, wanted, self) {
    var clean = String(wanted).trim();
    if (!clean) fail('A ' + NOUNS[kind] + ' needs a name.');
    var clash = (state[LISTS[kind]] || []).filter(function (item) {
      return item !== self && String(item.name).toLowerCase() === clean.toLowerCase();
    })[0];
    if (clash) {
      fail('A ' + NOUNS[kind] + ' called "' + clash.name + '" already exists (' + clash.id
        + '). Pick another name, or edit that one with ' + kind + '.update.');
    }
    return clean;
  }

  /* An id nothing else in the design already has. */
  function freshId(state, prefix) {
    var taken = {};
    ['trials', 'runs', 'sessions', 'experiments'].forEach(function (key) {
      (state[key] || []).forEach(function (item) { taken[item.id] = true; });
    });
    (state.sessions || []).forEach(function (session) {
      (session.blocks || []).forEach(function (block) { taken[block.id] = true; });
    });
    var id = M.makeId(prefix);
    while (taken[id]) id = M.makeId(prefix);
    return id;
  }

  /* ---------------------------------------------------------- validation */

  function checkValue(item, value, label, ctx) {
    if (value === null && item.nullable) return null;
    var n;
    switch (item.type) {
      case 'string':
        if (typeof value === 'number') value = String(value);
        if (typeof value !== 'string') fail(label + ' must be a string.');
        if (item.nonEmpty && !value.trim()) fail(label + ' cannot be empty.');
        return item.nonEmpty ? value.trim() : value;
      case 'number':
      case 'integer':
        n = typeof value === 'number' ? value
          : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
        if (!isFinite(n)) fail(label + ' must be a number.');
        if (item.type === 'integer' && Math.round(n) !== n) fail(label + ' must be a whole number.');
        if (item.min !== undefined && n < item.min) fail(label + ' must be at least ' + item.min + '.');
        if (item.max !== undefined && n > item.max) fail(label + ' must be at most ' + item.max + '.');
        return n;
      case 'boolean':
        if (value === true || value === false) return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return fail(label + ' must be true or false.');
      case 'enum':
        if (item.values.indexOf(value) < 0) {
          fail(label + ' must be one of: ' + item.values.join(', ') + '.');
        }
        return value;
      case 'ref':
        if (item.ref === 'card') return findCard(ctx.boot, value).slug;
        return find(ctx.state, item.ref, value).id;
      case 'object':
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          fail(label + ' must be an object.');
        }
        return value;
      case 'array':
        if (!Array.isArray(value)) fail(label + ' must be a list.');
        return value;
      case 'position':
        if (typeof value === 'number' && Math.round(value) === value && value >= 0) return value;
        if (typeof value === 'string' && value.trim()) return value.trim();
        return fail(label + ' must be a 0-based position or ' + item.named + '.');
      default:
        return value;
    }
  }

  /* Accepts `{action, ...args}` or `{action, args: {...}}`. */
  function splitCall(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('Each action must be an object like {"action": "run.update", ...}.');
    }
    var nameValue = raw.action;
    if (typeof nameValue !== 'string' || !nameValue) {
      fail('Each action needs an "action" field naming it, e.g. "trial.add".');
    }
    var args = {};
    if (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) {
      Object.keys(raw.args).forEach(function (key) { args[key] = raw.args[key]; });
    }
    Object.keys(raw).forEach(function (key) {
      if (key !== 'action' && key !== 'args') args[key] = raw[key];
    });
    return { name: nameValue, args: args };
  }

  function suggest(nameValue) {
    var lower = nameValue.toLowerCase();
    var group = lower.split('.')[0];
    var close = ACTIONS.filter(function (entry) {
      var other = entry.name.toLowerCase();
      return other.indexOf(lower) >= 0 || lower.indexOf(other) >= 0
        || other.split('.')[0] === group;
    }).map(function (entry) { return entry.name; });
    return close.length ? ' Did you mean: ' + close.slice(0, 8).join(', ') + '?'
      : ' GET /api/v1 lists every action.';
  }

  function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

  /* Equal as data: the same JSON, whatever order the keys arrive in. */
  function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      return a.length === b.length && a.every(function (item, index) { return same(item, b[index]); });
    }
    var keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(function (key) {
      return hasOwn(b, key) && same(a[key], b[key]);
    });
  }

  /* What design.get returns, the write actions take back.  Three rules make
   * that hold:
   *
   *   - a stored field name is accepted for its argument (`protocol` for
   *     `card`, an item's `id` for the item argument);
   *   - a field the item already holds, sent with the value it already has, is
   *     accepted as it is - even one the action cannot change, even one that
   *     would not pass validation as a new value;
   *   - anything else unknown is refused, naming the action that does take it.
   *
   * `entry.target(ctx, args)` finds the item an update writes to; `entry.locate`
   * lists the arguments it needs resolved first. */
  function validate(ctx, entry, args) {
    var input = {};
    Object.keys(args).forEach(function (key) { input[key] = args[key]; });

    Object.keys(entry.args).forEach(function (key) {
      var item = entry.args[key];
      (item.aliases || []).forEach(function (alias) {
        if (input[alias] === undefined) return;
        if (input[key] !== undefined && !same(input[key], input[alias])) {
          var a = checkValue(item, input[key], entry.name + ' "' + key + '"', ctx);
          var b = checkValue(item, input[alias], entry.name + ' "' + alias + '"', ctx);
          if (!same(a, b)) {
            fail(entry.name + ': "' + key + '" and "' + alias + '" are the same argument and they '
              + 'disagree (' + JSON.stringify(input[key]) + ' and ' + JSON.stringify(input[alias])
              + '). Give one of them.');
          }
        }
        if (input[key] === undefined) input[key] = input[alias];
        delete input[alias];
      });
    });

    var out = {};
    function take(key, target) {
      var item = entry.args[key];
      var value = input[key];
      if (value === undefined) {
        if (item.required) fail(entry.name + ' needs "' + key + '": ' + item.doc + '.');
        if (item.default !== undefined) out[key] = item.default;
        return;
      }
      var stored = item.stored || key;
      if (target && hasOwn(target, stored) && same(target[stored], value)) {
        out[key] = value;
        return;
      }
      out[key] = checkValue(item, value, entry.name + ' "' + key + '"', ctx);
    }

    var first = entry.locate || [];
    first.forEach(function (key) { take(key, null); });
    var target = entry.target ? entry.target(ctx, out) : null;
    Object.keys(entry.args).forEach(function (key) {
      if (first.indexOf(key) < 0) take(key, target);
    });

    Object.keys(input).forEach(function (key) {
      if (entry.args[key]) return;
      if (target && hasOwn(target, key) && same(target[key], input[key])) return;
      fail(refusal(entry, key, input[key], target));
    });
    return out;
  }

  function accepts(entry, key) {
    return Object.keys(entry.args).some(function (name) {
      return name === key || (entry.args[name].aliases || []).indexOf(key) >= 0;
    });
  }

  /* Why an argument was turned down, and which action would have taken it. */
  function refusal(entry, key, value, target) {
    if (target && key === 'kind' && hasOwn(target, 'kind')) {
      return 'A block\'s kind cannot change (this one is ' + target.kind + '). Remove it and add '
        + 'a block of the new kind.';
    }
    if (key === 'id' && /\.add$/.test(entry.name)) {
      return entry.name + ' gives what it creates an id of its own; leave "id" out.';
    }
    var holds = target && hasOwn(target, key);
    var adding = /\.add$/.test(entry.name);
    var takers = ACTIONS.filter(function (other) {
      return other !== entry && other.group === entry.group && accepts(other, key)
        && (adding || !/\.add$/.test(other.name));
    }).sort(function (a, b) {
      return (/\.update$/.test(b.name) ? 1 : 0) - (/\.update$/.test(a.name) ? 1 : 0);
    }).map(function (other) { return other.name; }).slice(0, 2);
    var known = Object.keys(entry.args);
    return (holds ? entry.name + ' cannot change "' + key + '".'
      : entry.name + ' has no argument "' + key + '".')
      + ' ' + (known.length ? 'It takes: ' + known.join(', ') + '.' : 'It takes none.')
      + (takers.length ? ' ' + takers.join(' and ') + (takers.length > 1 ? ' take' : ' takes')
        + ' "' + key + '".' : '');
  }

  /* ------------------------------------------------------------- helpers */

  function has(args, key) { return args[key] !== undefined; }

  function move(listValue, from, args) {
    if (!has(args, 'to') && !has(args, 'delta')) {
      fail('Say where to move it: "to" (a 0-based position) or "delta" (-1 earlier, +1 later).');
    }
    if (has(args, 'to') && has(args, 'delta')) fail('Give "to" or "delta", not both.');
    var target = has(args, 'to') ? args.to : from + args.delta;
    target = Math.max(0, Math.min(listValue.length - 1, target));
    if (target !== from) {
      var item = listValue.splice(from, 1)[0];
      listValue.splice(target, 0, item);
    }
    return { from: from, to: target };
  }

  function positionIn(listValue, index, noun) {
    if (index < 0 || index >= listValue.length) {
      fail('There is no ' + noun + ' at position ' + index + '; positions run 0 to '
        + (listValue.length - 1) + '.');
    }
    return index;
  }

  function insertAt(listValue, item, index) {
    if (index === undefined || index === null || index >= listValue.length) {
      listValue.push(item);
      return listValue.length - 1;
    }
    listValue.splice(Math.max(0, index), 0, item);
    return Math.max(0, index);
  }

  function created(item) { return { id: item.id, name: item.name }; }

  function usableHours(state) {
    return H.num(state.budget.totalScannerHours)
      * (1 - H.clamp(H.num(state.budget.contingencyPct), 0, 90) / 100);
  }

  function shares(state) {
    return (state.experiments || []).map(function (experiment) {
      return {
        experiment: experiment.name, enabled: experiment.enabled !== false,
        locked: !!experiment.locked, requestedPct: H.num(experiment.requestedPct)
      };
    });
  }

  /* Copy the listed fields from args onto a target and name the ones that
   * actually changed; a value that is already there is left alone. */
  function assign(target, args, fields) {
    var changed = [];
    fields.forEach(function (key) {
      if (!has(args, key) || same(target[key], args[key])) return;
      target[key] = args[key];
      changed.push(key);
    });
    return changed;
  }

  function nothingToChange(entry, args, fields) {
    var any = fields.some(function (key) { return has(args, key); });
    if (!any) fail(entry + ' needs at least one of: ' + fields.join(', ') + '.');
  }

  /* ---------------------------------------------------- phase helpers */

  var PHASE_FIELDS = {
    name: name('Phase name'),
    role: choice(PHASE_ROLE_IDS, 'What the regressor model reads: baseline, stimulus, delay, '
      + 'response or other'),
    min: number('Shortest duration in seconds', 0),
    max: number('Longest duration in seconds; equal to min means no jitter', 0),
    jitter: bool('Whether the wait varies trial to trial inside min..max')
  };

  /* One phase of a whole list.  `position` is where it sits: trial.inspect
   * numbers its phases, and a phase sent back with that `index` is taken if the
   * number still matches where it is. */
  function cleanPhase(raw, label, position) {
    if (!raw || typeof raw !== 'object') fail(label + ' must be an object.');
    Object.keys(raw).forEach(function (key) {
      if (key === 'index' && position !== undefined) {
        if (raw.index !== position) {
          fail(label + ' says index ' + JSON.stringify(raw.index) + ' but is at position '
            + position + '. The list order is the phase order: drop "index" or reorder the list.');
        }
        return;
      }
      if (!PHASE_FIELDS[key]) {
        fail(label + ' has no field "' + key + '". Phases take: '
          + Object.keys(PHASE_FIELDS).join(', ') + '.');
      }
    });
    if (raw.min === undefined) fail(label + ' needs "min" (seconds).');
    var min = checkValue(PHASE_FIELDS.min, raw.min, label + ' min');
    var max = raw.max === undefined ? min : checkValue(PHASE_FIELDS.max, raw.max, label + ' max');
    if (max < min) fail(label + ': max (' + max + ') is below min (' + min + ').');
    /* In the order the design stores a phase, so an unchanged list saves byte
     * for byte as it was. */
    return {
      name: raw.name === undefined ? 'Phase' : checkValue(PHASE_FIELDS.name, raw.name, label + ' name'),
      min: min,
      max: max,
      jitter: raw.jitter === undefined ? max > min
        : checkValue(PHASE_FIELDS.jitter, raw.jitter, label + ' jitter'),
      role: raw.role === undefined ? 'baseline'
        : checkValue(PHASE_FIELDS.role, raw.role, label + ' role')
    };
  }

  function cleanPhases(rows, label) {
    if (!rows.length) fail('A trial needs at least one phase.');
    return rows.map(function (raw, index) { return cleanPhase(raw, label + ' ' + index, index); });
  }

  /* A phase by 0-based position, or by a name only one phase carries. */
  function phaseIndex(trial, value) {
    var phases = trial.phases || [];
    if (typeof value === 'number') return positionIn(phases, value, 'phase in "' + trial.name + '"');
    var lower = String(value).toLowerCase();
    var hits = [];
    phases.forEach(function (phase, index) {
      if (String(phase.name).toLowerCase() === lower) hits.push(index);
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      fail('"' + trial.name + '" has ' + hits.length + ' phases called "' + value
        + '" (positions ' + hits.join(', ') + '). Use the 0-based position.');
    }
    return fail('"' + trial.name + '" has no phase "' + value + '". Its phases: '
      + phases.map(function (phase, index) { return index + ' ' + phase.name; }).join(', ') + '.');
  }

  /* ---------------------------------------------------- block helpers */

  var BLOCK_FIELDS = {
    prep: ['label', 'minutes', 'enabled'],
    break: ['label', 'minutes', 'enabled'],
    structural: ['card', 'count', 'enabled'],
    run: ['run', 'count', 'enabled']
  };

  function blockIndex(session, value) {
    var blocks = session.blocks || [];
    if (typeof value === 'number') return positionIn(blocks, value, 'block in "' + session.name + '"');
    for (var i = 0; i < blocks.length; i += 1) if (blocks[i].id === value) return i;
    return fail('"' + session.name + '" has no block "' + value + '". Use a block id from '
      + 'design.get, or a 0-based position.');
  }

  /* Apply block fields, refusing any that do not belong to the block's kind. */
  function writeBlock(ctx, block, args, label) {
    var allowed = BLOCK_FIELDS[block.kind];
    ['label', 'minutes', 'card', 'run', 'count', 'enabled'].forEach(function (key) {
      if (has(args, key) && allowed.indexOf(key) < 0) {
        fail(label + ': "' + key + '" does not apply to a ' + M.BLOCK_LABELS[block.kind].toLowerCase()
          + ' block. It takes: ' + allowed.join(', ') + '.');
      }
    });
    if (has(args, 'label')) block.label = args.label;
    if (has(args, 'minutes')) block.minutes = args.minutes;
    if (has(args, 'card')) block.protocol = args.card;
    if (has(args, 'run')) block.run = args.run;
    if (has(args, 'count')) block.count = args.count;
    if (has(args, 'enabled')) block.enabled = args.enabled;
    return block;
  }

  var BLOCK_ARGS = {
    label: name('Setup or break blocks: what it is'),
    minutes: number('Setup or break blocks: how long, in minutes', 0),
    card: ref('card', 'Structural blocks: the acquisition card to run (stored as "protocol")',
      { aliases: ['protocol'], stored: 'protocol' }),
    run: ref('run', 'Run blocks: the run design to run'),
    count: integer('Structural or run blocks: how many back to back', 0),
    enabled: bool('Off keeps the block in the design without running it')
  };

  /* One block of a whole list, in the shape design.get shows it: `protocol`
   * works for `card`, and an `id` is kept. */
  function cleanBlock(ctx, raw, label) {
    if (!raw || typeof raw !== 'object') fail(label + ' must be an object.');
    var kind = raw.kind;
    if (M.BLOCK_KINDS.indexOf(kind) < 0) {
      fail(label + ' needs "kind": one of ' + M.BLOCK_KINDS.join(', ') + '.');
    }
    var fields = {};
    Object.keys(raw).forEach(function (key) {
      if (key === 'kind' || key === 'id') return;
      var field = key === 'protocol' ? 'card' : key;
      if (!BLOCK_ARGS[field]) {
        fail(label + ' has no field "' + key + '". Blocks take: id, kind, '
          + Object.keys(BLOCK_ARGS).join(', ') + ' (or protocol for card).');
      }
      if (fields[field] !== undefined && !same(fields[field], raw[key])) {
        fail(label + ': "card" and "protocol" are the same field and they disagree. Give one.');
      }
      fields[field] = raw[key];
    });
    var args = {};
    Object.keys(fields).forEach(function (field) {
      args[field] = checkValue(BLOCK_ARGS[field], fields[field], label + ' ' + field, ctx);
    });
    var block = newBlock(ctx, kind, args, label);
    if (raw.id !== undefined) {
      if (typeof raw.id !== 'string' || !raw.id.trim()) fail(label + ': "id" must be a non-empty string.');
      block.id = raw.id.trim();
    }
    return block;
  }

  /* A whole block list.  A row that is an existing block of this session,
   * unchanged, is kept exactly as it is, so a list read from design.get goes
   * back even if, say, a card it names has since been deleted. */
  function cleanBlocks(ctx, session, rows, label) {
    var existing = {};
    (session.blocks || []).forEach(function (block) { existing[block.id] = block; });
    var seen = {};
    return rows.map(function (raw, index) {
      var where = label + ' ' + index;
      var kept = raw && typeof raw === 'object' && existing[raw.id];
      var block = kept && same(kept, raw) ? H.deepCopy(kept) : cleanBlock(ctx, raw, where);
      if (hasOwn(seen, block.id)) {
        fail(where + ': block id "' + block.id + '" is already used by block ' + seen[block.id]
          + '. Leave "id" out of a new block and it gets one of its own.');
      }
      seen[block.id] = index;
      return block;
    });
  }

  /* A block of a kind, with the defaults the "+" buttons use: the first card
   * for a structural, the first run design for a run. */
  function newBlock(ctx, kind, args, label) {
    var extra = {};
    if (kind === 'structural' && !has(args, 'card')) {
      var first = ((ctx.boot && ctx.boot.manifest) || [])[0];
      if (!first) fail('There are no acquisition cards to add.');
      extra.protocol = first.slug;
    }
    if (kind === 'run' && !has(args, 'run')) {
      if (!(ctx.state.runs || []).length) fail('Build a run design first.');
      extra.run = ctx.state.runs[0].id;
    }
    var block = M.makeBlock(kind, extra);
    block.id = freshId(ctx.state, 'blk');
    return writeBlock(ctx, block, args, label);
  }

  /* ------------------------------------------------- plan-row helpers */

  function rowIndex(state, experiment, value) {
    var plan = experiment.plan || [];
    if (typeof value === 'number') return positionIn(plan, value, 'row in the plan of "' + experiment.name + '"');
    var session = find(state, 'session', value);
    var hits = [];
    plan.forEach(function (row, index) { if (row.session === session.id) hits.push(index); });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      fail('"' + session.name + '" is in the plan of "' + experiment.name + '" ' + hits.length
        + ' times (rows ' + hits.join(', ') + '). Use the 0-based row.');
    }
    return fail('"' + session.name + '" is not in the plan of "' + experiment.name + '".');
  }

  function cleanPlan(state, rows, label) {
    return rows.map(function (raw, index) {
      var where = label + ' row ' + index;
      if (!raw || typeof raw !== 'object') fail(where + ' must be {"session": ..., "count": n}.');
      Object.keys(raw).forEach(function (key) {
        if (key !== 'session' && key !== 'count') {
          fail(where + ' has no field "' + key + '". Plan rows take: session, count.');
        }
      });
      if (raw.session === undefined) fail(where + ' needs "session".');
      return {
        session: find(state, 'session', raw.session).id,
        count: raw.count === undefined ? 1
          : checkValue(integer('count', 0), raw.count, where + ' count')
      };
    });
  }

  /* --------------------------------------------------------- summaries */

  function round(value, digits) { return H.round(H.num(value), digits === undefined ? 2 : digits); }

  /* The solved design in the few numbers an agent needs after every call. */
  function summarise(report) {
    if (!report) return null;
    return {
      study: (report.meta || {}).studyTitle || '',
      solveMode: (report.budget || {}).solveMode,
      totals: report.totals,
      experiments: (report.experiments || []).map(function (experiment) {
        var d = experiment.derived;
        return {
          id: experiment.id,
          name: experiment.name,
          unit: experiment.unit.plural,
          sessions: d.sessions,
          runs: d.runs,
          units: d.units,
          goal: d.targetUnits,
          goalPct: d.targetProgressPct,
          totalHours: d.totalHours,
          sharePct: d.sharePct,
          sessionMinutes: d.sessionMeanMinutes,
          plan: (experiment.plan || []).map(function (row) {
            return { session: row.name, mix: row.requested, sessions: row.sessions };
          })
        };
      }),
      sessions: (report.sessions || []).map(function (session) {
        return {
          id: session.id,
          name: session.name,
          runs: session.runs,
          meanMinutes: session.meanMinutes,
          maxMinutes: session.maxMinutes,
          units: session.units,
          scheduled: session.scheduled
        };
      }),
      runs: (report.runs || []).map(function (run) {
        if (run.missing) return { id: run.id, name: run.name, missing: true };
        var d = run.derived;
        return {
          id: run.id,
          name: run.name,
          trial: run.trialName,
          card: run.protocol,
          trialsPerRun: d.trialsPerRun,
          meanMinutes: round(d.runMean / 60),
          maxMinutes: round(d.runMax / 60),
          volumes: d.volumesPerRun,
          scheduled: d.totalRuns
        };
      }),
      trials: (report.trials || []).map(function (trial) {
        return {
          id: trial.id,
          name: trial.name,
          objective: trial.objective,
          phases: (trial.phases || []).length,
          seconds: trial.timing,
          sequence: trial.sequence
        };
      }),
      warnings: report.warnings || []
    };
  }

  /* The report without the working state it carries (the design is returned
   * separately) and without the long regressor arrays. */
  function slimReport(report) {
    var copy = H.deepCopy(report);
    delete copy.state;
    return copy;
  }

  /* What "Apply solved timing" writes into a run's card. */
  function solvedCardUpdates(report, runId) {
    var record = (report.runs || []).filter(function (item) { return item.id === runId; })[0];
    if (!record || record.missing) return null;
    return {
      card: record.protocol,
      updates: {
        'dyn scans': String(record.acquisition.dynScansSolved),
        'dummy scans': String(record.acquisition.dummyScansSolved),
        'Total scan duration': record.acquisition.durationSolved
      }
    };
  }

  function cardUsage(state, slug) {
    var runs = (state.runs || []).filter(function (run) { return run.protocol === slug; })
      .map(function (run) { return run.name; });
    var sessions = (state.sessions || []).filter(function (session) {
      return (session.blocks || []).some(function (block) {
        return block.kind === 'structural' && block.protocol === slug && block.enabled !== false;
      });
    }).map(function (session) { return session.name; });
    return { runs: runs, sessions: sessions };
  }

  function repointCard(state, from, to) {
    var changed = 0;
    (state.runs || []).forEach(function (run) {
      if (run.protocol === from) { run.protocol = to; changed += 1; }
    });
    (state.sessions || []).forEach(function (session) {
      (session.blocks || []).forEach(function (block) {
        if (block.kind === 'structural' && block.protocol === from) {
          block.protocol = to;
          changed += 1;
        }
      });
    });
    return changed;
  }

  /* A minimal study: one of each level, wired together. */
  function blankState(boot) {
    var state = M.defaultState();
    var trial = M.defaultTrial('estimation', 'Trial design');
    var run = M.defaultRun(trial.id, firstFunctionalCard(boot) || 'EPI-TR2000-Task', 'Run design');
    var session = M.defaultSession('Session');
    session.blocks.push(M.makeBlock('run', { run: run.id, count: 1 }));
    var experiment = M.defaultExperiment('Experiment', 'EXP');
    experiment.plan = [{ session: session.id, count: 1 }];
    state.trials = [trial];
    state.runs = [run];
    state.sessions = [session];
    state.experiments = [experiment];
    return state;
  }

  /* ------------------------------------------------------------ catalogue */

  /* Each entry: name, group, the control it mirrors (`ui`), a one-line
   * summary, its arguments, and `run(ctx, args)`.  `query: true` marks the
   * ones that read without changing anything. */
  var ACTIONS = [];

  function action(entry) {
    entry.args = entry.args || {};
    entry.host = entry.host || 'js';
    ACTIONS.push(entry);
    return entry;
  }

  /* --- design --------------------------------------------------------- */

  action({
    name: 'design.get', group: 'Design', query: true,
    ui: 'Report and export > Designs > Download this design',
    summary: 'The whole design as stored: every trial, run, session, experiment and setting, with ids',
    run: function (ctx) { return H.deepCopy(ctx.state); }
  });

  action({
    name: 'design.reset', group: 'Design',
    ui: 'Report and export > Designs > Reset to defaults',
    summary: 'Start again. The shipped example study, or with blank=true one trial, run, '
      + 'session and experiment wired together',
    args: {
      blank: bool('One of each level instead of the three-experiment example', { default: false })
    },
    run: function (ctx, args) {
      ctx.replace(args.blank ? blankState(ctx.boot) : M.defaultState());
      return { blank: args.blank, trials: ctx.state.trials.map(created),
        runs: ctx.state.runs.map(created), sessions: ctx.state.sessions.map(created),
        experiments: ctx.state.experiments.map(created) };
    }
  });

  action({
    name: 'design.replace', group: 'Design',
    ui: 'Report and export > Designs > Import JSON file (into a new design)',
    summary: 'Replace the design with a JSON design (a bare design or a downloaded '
      + '{design, report} file); anything missing is filled from the defaults',
    args: { design: required(object('The design object, as design.get returns it')) },
    run: function (ctx, args) {
      var design = args.design.design && typeof args.design.design === 'object'
        ? args.design.design : args.design;
      if (!(design.experiments || design.aims)) fail('That object does not contain a planner design.');
      ctx.replace(M.migrateState(H.deepCopy(design)));
      return { trials: ctx.state.trials.length, runs: ctx.state.runs.length,
        sessions: ctx.state.sessions.length, experiments: ctx.state.experiments.length };
    }
  });

  var TOP_KEYS = ['meta', 'budget', 'caps', 'hrf', 'jitter', 'trials', 'runs', 'sessions',
    'experiments', 'dynScansFrom'];

  action({
    name: 'design.set', group: 'Design',
    ui: 'Any field, by its path in the design',
    summary: 'Escape hatch: write one value at a dot path such as "budget.totalScannerHours" '
      + 'or "runs.0.leadIn". No validation beyond the path existing - prefer the typed actions',
    args: {
      path: required(name('Dot path from the top of the design, e.g. "caps.maxRunMinutes"')),
      value: required(spec('any', 'The value to write'))
    },
    run: function (ctx, args) {
      var parts = args.path.split('.');
      if (TOP_KEYS.indexOf(parts[0]) < 0) {
        fail('design.set paths start with one of: ' + TOP_KEYS.join(', ') + '.');
      }
      if (parts.length === 1) fail('design.set writes a single field, not a whole section.');
      var node = ctx.state;
      for (var i = 0; i < parts.length - 1; i += 1) {
        var key = Array.isArray(node) ? Number(parts[i]) : parts[i];
        if (node[key] === undefined || node[key] === null || typeof node[key] !== 'object') {
          fail('Nothing at "' + parts.slice(0, i + 1).join('.') + '".');
        }
        node = node[key];
      }
      var leaf = parts[parts.length - 1];
      var previous = node[leaf];
      node[leaf] = H.deepCopy(args.value);
      return { path: args.path, previous: previous === undefined ? null : previous, value: args.value };
    }
  });

  action({
    name: 'design.saveAs', group: 'Design', host: 'server',
    ui: 'Report and export > Designs > Save a copy as',
    summary: 'Save a copy of this design under another name (the design you are editing is saved '
      + 'automatically)',
    args: { name: required(name('Name for the saved copy; letters, digits, dot, dash, underscore')) }
  });

  /* --- study details and budget -------------------------------------- */

  var META_FIELDS = ['studyTitle', 'investigator', 'institution', 'participantId', 'designId', 'notes'];

  action({
    name: 'study.update', group: 'Study',
    ui: 'Study details panel',
    summary: 'Titles and identifiers printed on every export',
    args: {
      studyTitle: str('Study title'),
      investigator: str('Investigator'),
      institution: str('Institution'),
      participantId: str('Participant ID'),
      designId: str('Design ID'),
      notes: str('Free notes')
    },
    target: function (ctx) { return ctx.state.meta; },
    run: function (ctx, args) {
      nothingToChange('study.update', args, META_FIELDS);
      return { changed: assign(ctx.state.meta, args, META_FIELDS), meta: H.deepCopy(ctx.state.meta) };
    }
  });

  var BUDGET_FIELDS = ['solveMode', 'targetUnitsTotal', 'countOverheadAgainstBudget', 'autoClamp',
    'totalScannerHours', 'contingencyPct', 'sessionsPerWeek', 'weeksAvailable', 'allocationUnit'];

  /* Driving the sliders in sessions means the numbers on them must be the
   * ones the solver is using, so seed them and move into session-count mode. */
  function adoptSessionUnit(ctx) {
    var report = ctx.solved();
    ctx.state.experiments.forEach(function (experiment) {
      if (!experiment.enabled) return;
      var record = report.experiments.filter(function (item) { return item.id === experiment.id; })[0];
      experiment.manualSessions = record ? record.derived.sessions : 0;
    });
    ctx.state.budget.solveMode = 'manual';
  }

  action({
    name: 'budget.update', group: 'Budget',
    ui: 'Budget panel > Solve mode and Scanner-time envelope; Overview > Drive the sliders in',
    summary: 'Scanner hours, contingency, calendar and how session counts are decided',
    args: {
      solveMode: choice(SOLVE_MODE_IDS, 'budget: spend the hours; fill: one study-wide goal; '
        + 'target: each experiment to its own goal; manual: session counts set by hand'),
      targetUnitsTotal: integer('The study-wide goal used by solveMode "fill"', 0),
      countOverheadAgainstBudget: bool('Charge setup, structurals and breaks to the hours'),
      autoClamp: bool('Let the solver reduce blocks, trials or runs that break a cap'),
      totalScannerHours: number('Scanner hours available', 0.1),
      contingencyPct: number('Reserve held back from the hours, percent', 0, 90),
      sessionsPerWeek: number('Sessions per week, for the calendar', 0.1),
      weeksAvailable: number('Weeks available, for the calendar', 0.1),
      allocationUnit: choice(UNIT_IDS, 'What the allocation sliders are driven in. "sessions" '
        + 'seeds each experiment\'s session count from the current solution and switches to '
        + 'solveMode "manual", as the interface does')
    },
    target: function (ctx) { return ctx.state.budget; },
    run: function (ctx, args) {
      nothingToChange('budget.update', args, BUDGET_FIELDS);
      var before = ctx.state.budget.allocationUnit;
      var fields = BUDGET_FIELDS.filter(function (key) { return key !== 'allocationUnit'; });
      var changed = assign(ctx.state.budget, args, fields);
      if (has(args, 'allocationUnit') && args.allocationUnit !== before) {
        if (args.allocationUnit === 'sessions') adoptSessionUnit(ctx);
        ctx.state.budget.allocationUnit = args.allocationUnit;
        changed.push('allocationUnit');
      }
      return { changed: changed, budget: H.deepCopy(ctx.state.budget),
        usableHours: round(usableHours(ctx.state)) };
    }
  });

  var CAP_FIELDS = ['applyTo', 'maxRunMinutes', 'maxSessionMinutes', 'maxRunsPerSession',
    'maxSessionsTotal', 'maxContinuousMinutes', 'minUnitsPerExperiment'];

  action({
    name: 'caps.update', group: 'Budget',
    ui: 'Budget panel > Constraint envelope',
    summary: 'The caps the solver repairs against',
    args: {
      applyTo: choice(['expected', 'longest'], 'Judge caps against the expected or the longest duration'),
      maxRunMinutes: number('Longest a run may be, minutes', 0.1),
      maxSessionMinutes: number('Longest a session may be, minutes', 0.1),
      maxRunsPerSession: integer('Most runs in one session', 1),
      maxSessionsTotal: integer('Most sessions in the whole study', 1),
      maxContinuousMinutes: number('Continuous-scanning comfort limit, minutes', 0.1),
      minUnitsPerExperiment: integer('Floor on what each experiment collects', 0)
    },
    target: function (ctx) { return ctx.state.caps; },
    run: function (ctx, args) {
      nothingToChange('caps.update', args, CAP_FIELDS);
      return { changed: assign(ctx.state.caps, args, CAP_FIELDS), caps: H.deepCopy(ctx.state.caps) };
    }
  });

  /* --- allocation ------------------------------------------------------ */

  action({
    name: 'allocation.set', group: 'Allocation',
    ui: 'Overview > Time split between experiments (the slider, in any unit)',
    summary: 'Set one experiment\'s share of scanner time; the unlocked others redistribute so '
      + 'shares total 100. Give exactly one of percent, hours or sessions',
    args: {
      experiment: required(ref('experiment', 'Which experiment')),
      percent: number('Share of scanner time, percent', 0, 100),
      hours: number('Hours of the usable budget', 0),
      sessions: integer('Session count; switches solveMode to "manual"', 0)
    },
    run: function (ctx, args) {
      var given = ['percent', 'hours', 'sessions'].filter(function (key) { return has(args, key); });
      if (given.length !== 1) fail('allocation.set takes exactly one of percent, hours or sessions.');
      var experiment = M.experimentById(ctx.state, args.experiment);
      if (!experiment.enabled) {
        fail('"' + experiment.name + '" is switched off. Turn it on with experiment.update '
          + '{"enabled": true} first.');
      }
      if (given[0] === 'sessions') {
        experiment.manualSessions = args.sessions;
        ctx.state.budget.solveMode = 'manual';
        return { experiment: experiment.name, manualSessions: args.sessions, solveMode: 'manual' };
      }
      if (experiment.locked) {
        fail('"' + experiment.name + '" has its share locked. Unlock it with allocation.lock '
          + '{"locked": false} first.');
      }
      if (given[0] === 'hours') {
        var hours = usableHours(ctx.state);
        if (hours <= 0) fail('The budget has no usable hours to share.');
        experiment.requestedPct = H.clamp(args.hours / hours * 100, 0, 100);
      } else {
        experiment.requestedPct = args.percent;
      }
      M.normaliseAllocation(ctx.state, experiment.id);
      return { experiment: experiment.name, requestedPct: experiment.requestedPct,
        shares: shares(ctx.state) };
    }
  });

  action({
    name: 'allocation.lock', group: 'Allocation',
    ui: 'Overview > Lock / Locked; Experiments > Lock this share',
    summary: 'Hold an experiment\'s share while the others redistribute',
    args: {
      experiment: required(ref('experiment', 'Which experiment')),
      locked: bool('true to lock, false to unlock', { default: true })
    },
    run: function (ctx, args) {
      var experiment = M.experimentById(ctx.state, args.experiment);
      experiment.locked = args.locked;
      return { experiment: experiment.name, locked: experiment.locked };
    }
  });

  action({
    name: 'allocation.balanceToGoals', group: 'Allocation',
    ui: 'Overview > Balance to the goals',
    summary: 'Set every share from what each experiment\'s own goal costs in scanner time',
    run: function (ctx) {
      ctx.replace(M.balanceToTarget(ctx.state, ctx.boot));
      return { shares: shares(ctx.state) };
    }
  });

  action({
    name: 'allocation.evenSplit', group: 'Allocation',
    ui: 'Overview > Even split',
    summary: 'Give every switched-on experiment the same share, unlocking them all',
    run: function (ctx) {
      var active = M.enabledExperiments(ctx.state);
      active.forEach(function (experiment) {
        experiment.locked = false;
        experiment.requestedPct = active.length ? H.round(100 / active.length, 2) : 0;
      });
      M.normaliseAllocation(ctx.state, null);
      return { shares: shares(ctx.state) };
    }
  });

  /* --- library levels: add, duplicate, remove, move ------------------- */

  function libraryActions(kind, group, panel, extra) {
    var Kind = kind.charAt(0).toUpperCase() + kind.slice(1);
    var noun = NOUNS[kind];

    action({
      name: kind + '.duplicate', group: group,
      ui: panel + ' > Duplicate',
      summary: 'Copy a ' + noun + ' and place the copy right after it',
      args: keyed(kind, subject(kind, 'The ' + noun + ' to copy'), {
        name: name('Name for the copy (default: "<name> (copy)")')
      }),
      run: function (ctx, args) {
        if (has(args, 'name')) claimName(ctx.state, kind, args.name);
        var copy = M.Library['duplicate' + Kind](ctx.state, args[kind]);
        copy.id = freshId(ctx.state, copy.id.split('-')[0]);
        if (kind === 'session') {
          copy.blocks.forEach(function (block) { block.id = freshId(ctx.state, 'blk'); });
        }
        if (has(args, 'name')) copy.name = args.name;
        return created(copy);
      }
    });

    action({
      name: kind + '.remove', group: group,
      ui: panel + ' > Delete',
      summary: extra.removeRule,
      args: keyed(kind, subject(kind, 'The ' + noun + ' to delete')),
      run: function (ctx, args) {
        var item = M.byId(ctx.state[LISTS[kind]], args[kind]);
        var error = M.Library['remove' + Kind](ctx.state, args[kind]);
        if (error) fail(error);
        return { removed: created(item) };
      }
    });

    action({
      name: kind + '.move', group: group,
      ui: panel + ' > up / down arrows',
      summary: 'Reorder the ' + noun + ' list',
      args: keyed(kind, subject(kind, 'The ' + noun + ' to move'), MOVE_ARGS),
      run: function (ctx, args) {
        var items = ctx.state[LISTS[kind]];
        var from = items.indexOf(M.byId(items, args[kind]));
        return move(items, from, args);
      }
    });
  }

  /* --- trials ---------------------------------------------------------- */

  action({
    name: 'trial.add', group: 'Trials',
    ui: 'Trials > Add trial design',
    summary: 'A new trial design with the recommended phases for its objective',
    args: {
      name: name('Name (default "Trial design", numbered if taken)'),
      objective: choice(OBJECTIVE_IDS, 'detection, estimation or separation; sets the starting '
        + 'phases and tolerance', { default: 'estimation' }),
      note: str('Free note')
    },
    run: function (ctx, args) {
      if (has(args, 'name')) claimName(ctx.state, 'trial', args.name);
      var trial = M.Library.addTrial(ctx.state, args.objective);
      trial.id = freshId(ctx.state, 'trial');
      if (has(args, 'name')) trial.name = args.name;
      if (has(args, 'note')) trial.note = args.note;
      return Object.assign(created(trial), { phases: H.deepCopy(trial.phases) });
    }
  });

  libraryActions('trial', 'Trials', 'Trials', {
    removeRule: 'Delete a trial design. Refused while a run design uses it, or if it is the last one'
  });

  action({
    name: 'trial.update', group: 'Trials',
    ui: 'Trials > Identity, Embedded control slider, Separation solver slider, Trial phases',
    summary: 'Change any of a trial design\'s fields',
    args: {
      trial: subject('trial', 'Which trial design'),
      name: name('New name'),
      note: str('Free note'),
      objective: choice(OBJECTIVE_IDS, 'The objective alone; trial.setObjective also adopts its '
        + 'recommended timing'),
      phases: list('Every phase, as in trial.setPhases'),
      controlPct: number('Embedded control / null trials, percent of trials', 0, 100),
      separationTolerancePct: number('Residual allowed at the next event, percent', 0.25, 90)
    },
    locate: ['trial'],
    target: function (ctx, args) { return M.byId(ctx.state.trials, args.trial); },
    run: function (ctx, args) {
      var fields = ['name', 'note', 'objective', 'controlPct', 'separationTolerancePct'];
      nothingToChange('trial.update', args, fields.concat('phases'));
      var trial = M.byId(ctx.state.trials, args.trial);
      if (has(args, 'name')) claimName(ctx.state, 'trial', args.name, trial);
      var changed = assign(trial, args, fields);
      if (has(args, 'phases')) {
        var phases = cleanPhases(args.phases, 'phase');
        if (!same(phases, trial.phases)) {
          trial.phases = phases;
          changed.push('phases');
        }
      }
      return { id: trial.id, changed: changed };
    }
  });

  action({
    name: 'trial.setObjective', group: 'Trials',
    ui: 'Trials > Objective',
    summary: 'Change what the trial design is for. Like the interface, this adopts the timing '
      + 'and tolerance that objective implies unless adoptDefaults is false',
    args: {
      trial: subject('trial', 'Which trial design'),
      objective: required(choice(OBJECTIVE_IDS, 'detection, estimation or separation')),
      adoptDefaults: bool('Replace the phases with the objective\'s recommended timing',
        { default: true })
    },
    run: function (ctx, args) {
      var trial = M.trialById(ctx.state, args.trial);
      trial.objective = args.objective;
      if (args.adoptDefaults) ctx.replace(M.applyObjectiveDefaults(ctx.state, trial.id));
      var now = M.trialById(ctx.state, args.trial);
      return { id: now.id, objective: now.objective, phases: H.deepCopy(now.phases),
        separationTolerancePct: now.separationTolerancePct };
    }
  });

  action({
    name: 'trial.setPhases', group: 'Trials',
    ui: 'Trials > Trial phases (the whole table at once)',
    summary: 'Replace every phase. Each phase is {name, role, min, max, jitter}; max defaults to '
      + 'min and jitter to max > min',
    args: {
      trial: subject('trial', 'Which trial design'),
      phases: required(list('The phases in order, at least one'))
    },
    locate: ['trial'],
    target: function (ctx, args) { return M.byId(ctx.state.trials, args.trial); },
    run: function (ctx, args) {
      var trial = M.byId(ctx.state.trials, args.trial);
      trial.phases = cleanPhases(args.phases, 'phase');
      return { id: trial.id, phases: H.deepCopy(trial.phases) };
    }
  });

  action({
    name: 'trial.resetTiming', group: 'Trials',
    ui: 'Trials > Reset to the objective default',
    summary: 'Replace the phases with the recommended timing for the trial\'s objective',
    args: { trial: subject('trial', 'Which trial design') },
    run: function (ctx, args) {
      ctx.replace(M.applyRecommendedTiming(ctx.state, args.trial));
      return { id: args.trial, phases: H.deepCopy(M.trialById(ctx.state, args.trial).phases) };
    }
  });

  action({
    name: 'trial.optimiseTiming', group: 'Trials',
    ui: 'Trials > Optimise delay and tail',
    summary: 'Grid-search the delay and post-response fixation for the objective. Slow on the '
      + 'server (up to ~30 s); trial.solveSeparation is the fast analytic alternative',
    args: { trial: subject('trial', 'Which trial design') },
    run: function (ctx, args) {
      ctx.replace(M.optimiseTiming(ctx.state, ctx.boot, args.trial, 'auto'));
      return { id: args.trial, phases: H.deepCopy(M.trialById(ctx.state, args.trial).phases) };
    }
  });

  action({
    name: 'trial.solveSeparation', group: 'Trials',
    ui: 'Trials > Separation solver > Apply this solution, and the 1 / 4 / 10 / 25 / 45 % presets',
    summary: 'Solve the delay and tail fixation from the HRF so no response exceeds the '
      + 'tolerance at the next event, and write them into the trial',
    args: {
      trial: subject('trial', 'Which trial design'),
      tolerancePct: number('Allowed residual, percent (default: the trial\'s own setting)', 0.25, 90)
    },
    run: function (ctx, args) {
      var trial = M.trialById(ctx.state, args.trial);
      if (!M.separationTiming(ctx.state, trial, 4, 2)) {
        fail('"' + trial.name + '" needs one phase with role "stimulus" and one with role '
          + '"response" before the separation solver can work.');
      }
      var tolerance = has(args, 'tolerancePct') ? args.tolerancePct
        : H.num(trial.separationTolerancePct, 4);
      ctx.replace(M.applySeparationTiming(ctx.state, trial.id, tolerance,
        M.representativeTr(ctx.state, ctx.boot, trial)));
      var now = M.trialById(ctx.state, trial.id);
      return { id: now.id, tolerancePct: now.separationTolerancePct, phases: H.deepCopy(now.phases) };
    }
  });

  action({
    name: 'trial.inspect', group: 'Trials', query: true,
    ui: 'Trials > Trial responses and Separation solver readouts',
    summary: 'Timing, the separation solver\'s answer at a tolerance, and where each response '
      + 'peaks - without changing anything',
    args: {
      trial: subject('trial', 'Which trial design'),
      tolerancePct: number('Tolerance to preview the separation solver at', 0.25, 90)
    },
    run: function (ctx, args) {
      var trial = M.trialById(ctx.state, args.trial);
      var report = ctx.solved();
      var record = report.trials.filter(function (item) { return item.id === trial.id; })[0];
      var trSeconds = M.representativeTr(ctx.state, ctx.boot, trial);
      var tolerance = has(args, 'tolerancePct') ? args.tolerancePct
        : H.num(trial.separationTolerancePct, M.objectiveDef(ctx.state, trial.objective).tolerancePct);
      var separation = M.separationTiming(ctx.state, trial, tolerance, trSeconds);
      var model = M.trialHrfSeries(ctx.state, trial, { repeats: 2, trSeconds: trSeconds });
      return {
        id: trial.id,
        name: trial.name,
        objective: trial.objective,
        phases: trial.phases.map(function (phase, index) {
          return Object.assign({ index: index }, phase);
        }),
        seconds: record ? record.timing : null,
        sequence: record ? record.sequence : '',
        trSeconds: trSeconds,
        usedBy: record ? record.usedBy : [],
        separation: separation ? {
          tolerancePct: round(separation.tolerancePct),
          pinnedSeconds: separation.overrideSeconds,
          delay: { phase: separation.delayIndex, min: separation.delayMin, max: separation.delayMax },
          tail: { phase: separation.tailIndex, min: separation.tailMin, max: separation.tailMax },
          trialMeanSeconds: round(separation.trialMean),
          stimulusResidualPct: round(separation.stimulusResidualPct),
          carryoverPct: round(separation.carryResidualPct)
        } : null,
        responses: model && model.traces.length ? {
          closestPeakGapSeconds: model.closestPeakGap,
          worstOverlapPct: model.worstBleedPct,
          worstCarryoverPct: model.worstCarryoverPct,
          traces: model.traces.map(function (trace) {
            return {
              phase: trace.phaseIndex, label: trace.label, role: trace.role,
              onset: trace.onset, duration: trace.duration, peakTime: trace.peakTime,
              peak: round(trace.peak, 4), underNextPeakPct: trace.bleedPct,
              leftAtNextTrialPct: trace.carryoverPct
            };
          })
        } : null,
        jitter: record ? record.jitter : null
      };
    }
  });

  /* --- phases ----------------------------------------------------------- */

  var PHASE_REF = spec('position', '0-based position in the trial, or a phase name only one '
    + 'phase carries; trial.inspect calls it "index"', { named: 'a phase name', aliases: ['index'] });

  action({
    name: 'phase.add', group: 'Trials',
    ui: 'Trials > Add phase',
    summary: 'Add a phase (default: appended, a fixed 2 s baseline)',
    args: {
      trial: required(ref('trial', 'Which trial design')),
      name: PHASE_FIELDS.name,
      role: PHASE_FIELDS.role,
      min: PHASE_FIELDS.min,
      max: PHASE_FIELDS.max,
      jitter: PHASE_FIELDS.jitter,
      index: integer('0-based position to insert at (default: the end)', 0)
    },
    run: function (ctx, args) {
      var trial = M.trialById(ctx.state, args.trial);
      var raw = { min: has(args, 'min') ? args.min : 2 };
      ['name', 'role', 'max', 'jitter'].forEach(function (key) {
        if (has(args, key)) raw[key] = args[key];
      });
      if (!has(args, 'name')) raw.name = 'Phase ' + (trial.phases.length + 1);
      var phase = cleanPhase(raw, 'phase.add');
      var at = insertAt(trial.phases, phase, args.index);
      return { id: trial.id, index: at, phase: H.deepCopy(phase) };
    }
  });

  action({
    name: 'phase.update', group: 'Trials',
    ui: 'Trials > Trial phases (a row\'s name, role, min, max and jitter)',
    summary: 'Edit one phase. As in the table, max is lifted to min if it would fall below it '
      + '(the result notes it)',
    args: {
      trial: required(ref('trial', 'Which trial design')),
      phase: required(PHASE_REF),
      name: PHASE_FIELDS.name,
      role: PHASE_FIELDS.role,
      min: PHASE_FIELDS.min,
      max: PHASE_FIELDS.max,
      jitter: PHASE_FIELDS.jitter
    },
    locate: ['trial', 'phase'],
    target: function (ctx, args) {
      var trial = M.byId(ctx.state.trials, args.trial);
      return trial.phases[phaseIndex(trial, args.phase)];
    },
    run: function (ctx, args) {
      var fields = ['name', 'role', 'min', 'max', 'jitter'];
      nothingToChange('phase.update', args, fields);
      var trial = M.trialById(ctx.state, args.trial);
      var index = phaseIndex(trial, args.phase);
      var phase = trial.phases[index];
      var min = has(args, 'min') ? args.min : H.num(phase.min);
      var max = has(args, 'max') ? args.max : H.num(phase.max);
      /* The table never lets max sit below min: it lifts max instead. */
      var notes = [];
      if (max < min) { max = min; notes.push('max set to ' + min + ' so it is not below min'); }
      if (has(args, 'name')) phase.name = args.name;
      if (has(args, 'role')) phase.role = args.role;
      if (has(args, 'jitter')) phase.jitter = args.jitter;
      phase.min = min;
      phase.max = max;
      return { id: trial.id, index: index, phase: H.deepCopy(phase), notes: notes };
    }
  });

  action({
    name: 'phase.move', group: 'Trials',
    ui: 'Trials > Trial phases > up / down arrows',
    summary: 'Reorder a phase within its trial',
    args: Object.assign({
      trial: required(ref('trial', 'Which trial design')),
      phase: required(PHASE_REF)
    }, MOVE_ARGS),
    run: function (ctx, args) {
      var trial = M.trialById(ctx.state, args.trial);
      return move(trial.phases, phaseIndex(trial, args.phase), args);
    }
  });

  action({
    name: 'phase.remove', group: 'Trials',
    ui: 'Trials > Trial phases > x',
    summary: 'Delete a phase; a trial keeps at least one',
    args: {
      trial: required(ref('trial', 'Which trial design')),
      phase: required(PHASE_REF)
    },
    run: function (ctx, args) {
      var trial = M.trialById(ctx.state, args.trial);
      var index = phaseIndex(trial, args.phase);
      if (trial.phases.length <= 1) fail('A trial needs at least one phase.');
      var removed = trial.phases.splice(index, 1)[0];
      return { id: trial.id, removed: removed, index: index };
    }
  });

  /* --- runs -------------------------------------------------------------- */

  var RUN_FIELDS = {
    trialsPerBlock: integer('Trials per block', 1),
    blocksPerRun: integer('Blocks per run', 1),
    interTrialGap: number('Gap between trials, seconds', 0),
    interBlockRest: number('Rest between blocks, seconds', 0),
    dummyVolumes: integer('Volumes discarded while magnetisation settles', 0),
    leadIn: number('Lead-in, seconds', 0),
    leadOut: number('Lead-out, seconds', 0)
  };
  var RUN_FIELD_NAMES = Object.keys(RUN_FIELDS);

  action({
    name: 'run.add', group: 'Runs',
    ui: 'Runs > Add run design',
    summary: 'A new run design: a trial design laid into blocks and bound to an acquisition card',
    args: Object.assign({
      name: name('Name (default "Run design", numbered if taken)'),
      trial: ref('trial', 'Trial design it runs (default: the first one)'),
      card: ref('card', 'Acquisition card it is bound to, stored as "protocol" (default: the '
        + 'first functional card)', { aliases: ['protocol'] }),
      note: str('Free note')
    }, RUN_FIELDS),
    run: function (ctx, args) {
      if (!ctx.state.trials.length) fail('Build a trial design first (trial.add).');
      if (has(args, 'name')) claimName(ctx.state, 'run', args.name);
      var trialId = has(args, 'trial') ? args.trial : ctx.state.trials[0].id;
      var card = has(args, 'card') ? args.card : firstFunctionalCard(ctx.boot);
      var run = M.Library.addRun(ctx.state, trialId, card);
      run.id = freshId(ctx.state, 'run');
      if (has(args, 'name')) run.name = args.name;
      if (has(args, 'note')) run.note = args.note;
      assign(run, args, RUN_FIELD_NAMES);
      return Object.assign(created(run), { trial: run.trial, card: run.protocol });
    }
  });

  libraryActions('run', 'Runs', 'Runs', {
    removeRule: 'Delete a run design. Refused while a session uses it'
  });

  action({
    name: 'run.update', group: 'Runs',
    ui: 'Runs > Identity and Run structure sliders',
    summary: 'Change any of a run design\'s fields',
    args: Object.assign({
      run: subject('run', 'Which run design'),
      name: name('New name'),
      note: str('Free note'),
      trial: ref('trial', 'Trial design it runs'),
      card: ref('card', 'Acquisition card it is bound to (sets TR, matrix, slices); stored as '
        + '"protocol"', { aliases: ['protocol'], stored: 'protocol' })
    }, RUN_FIELDS),
    locate: ['run'],
    target: function (ctx, args) { return M.byId(ctx.state.runs, args.run); },
    run: function (ctx, args) {
      var fields = ['name', 'note', 'trial', 'card'].concat(RUN_FIELD_NAMES);
      nothingToChange('run.update', args, fields);
      var run = M.byId(ctx.state.runs, args.run);
      if (has(args, 'name')) claimName(ctx.state, 'run', args.name, run);
      var values = Object.assign({}, args);
      if (has(args, 'card')) values.protocol = args.card;
      var changed = assign(run, values, ['name', 'note', 'trial', 'protocol'].concat(RUN_FIELD_NAMES))
        .map(function (key) { return key === 'protocol' ? 'card' : key; });
      return { id: run.id, changed: changed };
    }
  });

  action({
    name: 'run.optimiseStructure', group: 'Runs',
    ui: 'Runs > Optimise blocks and trials',
    summary: 'Search trials per block and blocks per run for the trial\'s objective, within the '
      + 'run-length cap',
    args: { run: subject('run', 'Which run design') },
    run: function (ctx, args) {
      ctx.replace(M.optimiseStructure(ctx.state, ctx.boot, args.run, 'auto'));
      var run = M.runById(ctx.state, args.run);
      return { id: run.id, trialsPerBlock: run.trialsPerBlock, blocksPerRun: run.blocksPerRun };
    }
  });

  action({
    name: 'run.inspect', group: 'Runs', query: true,
    ui: 'Runs > Solved run and Design efficiency readouts',
    summary: 'The solved run: durations, volumes, data, efficiency diagnostics and what '
      + '"Apply solved timing" would write to its card',
    args: { run: subject('run', 'Which run design') },
    run: function (ctx, args) {
      var report = ctx.solved();
      var record = report.runs.filter(function (item) { return item.id === args.run; })[0];
      var copy = H.deepCopy(record);
      if (copy.efficiency) delete copy.efficiency.vif;
      copy.cardUpdates = solvedCardUpdates(report, args.run);
      return copy;
    }
  });

  /* --- sessions ---------------------------------------------------------- */

  action({
    name: 'session.add', group: 'Sessions',
    ui: 'Sessions > Add session',
    summary: 'A new session: the default setup steps and structural scans, then one run block',
    args: {
      name: name('Name (default "Session", numbered if taken)'),
      run: ref('run', 'Run design for the first run block (default: the first one; null '
        + 'for none)', { nullable: true }),
      count: integer('How many of that run, back to back', 0, undefined, { default: 1 }),
      defaultBlocks: bool('Start with the default setup steps and structural scans; false '
        + 'starts empty', { default: true }),
      note: str('Free note'),
      autoBreak: bool('Insert a break between back-to-back runs'),
      breakMinutes: number('Length of that automatic break, minutes', 0)
    },
    run: function (ctx, args) {
      if (has(args, 'name')) claimName(ctx.state, 'session', args.name);
      var session = M.Library.addSession(ctx.state, null);
      session.id = freshId(ctx.state, 'session');
      if (!args.defaultBlocks) session.blocks = [];
      session.blocks.forEach(function (block) { block.id = freshId(ctx.state, 'blk'); });
      var runId = args.run === undefined ? ((ctx.state.runs[0] || {}).id || null) : args.run;
      if (runId) {
        var block = M.makeBlock('run', { run: runId, count: args.count });
        block.id = freshId(ctx.state, 'blk');
        session.blocks.push(block);
      }
      if (has(args, 'name')) session.name = args.name;
      assign(session, args, ['note', 'autoBreak', 'breakMinutes']);
      return Object.assign(created(session), { blocks: H.deepCopy(session.blocks) });
    }
  });

  libraryActions('session', 'Sessions', 'Sessions', {
    removeRule: 'Delete a session. Refused while an experiment\'s plan uses it'
  });

  action({
    name: 'session.update', group: 'Sessions',
    ui: 'Sessions > Identity, Automatic break, Session sequence',
    summary: 'Change any of a session\'s fields, blocks included',
    args: {
      session: subject('session', 'Which session'),
      name: name('New name'),
      note: str('Free note'),
      autoBreak: bool('Insert a break between back-to-back runs'),
      breakMinutes: number('Length of that automatic break, minutes', 0),
      blocks: list('Every block, as in session.setBlocks')
    },
    locate: ['session'],
    target: function (ctx, args) { return M.byId(ctx.state.sessions, args.session); },
    run: function (ctx, args) {
      var fields = ['name', 'note', 'autoBreak', 'breakMinutes'];
      nothingToChange('session.update', args, fields.concat('blocks'));
      var session = M.byId(ctx.state.sessions, args.session);
      if (has(args, 'name')) claimName(ctx.state, 'session', args.name, session);
      var blocks = has(args, 'blocks') ? cleanBlocks(ctx, session, args.blocks, 'block') : null;
      var changed = assign(session, args, fields);
      if (blocks && !same(blocks, session.blocks)) {
        session.blocks = blocks;
        changed.push('blocks');
      }
      return { id: session.id, changed: changed };
    }
  });

  action({
    name: 'session.setBlocks', group: 'Sessions',
    ui: 'Sessions > Session sequence (the whole list at once)',
    summary: 'Replace the block list, in blocks as design.get shows them: {id, kind, ...}. Prep '
      + 'and break take label and minutes; structural takes card (or protocol) and count; run '
      + 'takes run and count; all take enabled. An id sent back is kept; leave it out and a '
      + 'block gets a new one',
    args: {
      session: subject('session', 'Which session'),
      blocks: required(list('The blocks in console order'))
    },
    locate: ['session'],
    target: function (ctx, args) { return M.byId(ctx.state.sessions, args.session); },
    run: function (ctx, args) {
      var session = M.byId(ctx.state.sessions, args.session);
      session.blocks = cleanBlocks(ctx, session, args.blocks, 'block');
      return { id: session.id, blocks: H.deepCopy(session.blocks) };
    }
  });

  action({
    name: 'session.resetOrder', group: 'Sessions',
    ui: 'Sessions > Reset to the default order',
    summary: 'Sort the blocks: setup, then structurals, then runs, then breaks',
    args: { session: subject('session', 'Which session') },
    run: function (ctx, args) {
      var session = M.sessionById(ctx.state, args.session);
      var rank = { prep: 0, structural: 1, run: 2, break: 3 };
      /* Array.sort is not stable everywhere; carry the position as a tiebreak. */
      var order = session.blocks.map(function (block, index) { return { block: block, index: index }; });
      order.sort(function (a, b) {
        return (rank[a.block.kind] - rank[b.block.kind]) || (a.index - b.index);
      });
      session.blocks = order.map(function (entry) { return entry.block; });
      return { id: session.id, order: session.blocks.map(function (block) { return block.kind; }) };
    }
  });

  /* --- session blocks ---------------------------------------------------- */

  var BLOCK_REF = spec('position', 'Block id (from design.get), or its 0-based position',
    { named: 'a block id', aliases: ['id'] });

  action({
    name: 'block.add', group: 'Sessions',
    ui: 'Sessions > + Setup step / + Structural / reference / + Run / + Break',
    summary: 'Add a block to a session (default: appended). Structural defaults to the first card, '
      + 'run to the first run design',
    args: Object.assign({
      session: required(ref('session', 'Which session')),
      kind: required(choice(M.BLOCK_KINDS, 'prep (a setup step), structural, run or break')),
      index: integer('0-based position to insert at (default: the end)', 0)
    }, BLOCK_ARGS),
    run: function (ctx, args) {
      var session = M.sessionById(ctx.state, args.session);
      var block = newBlock(ctx, args.kind, args, 'block.add');
      var at = insertAt(session.blocks, block, args.index);
      return { session: session.id, index: at, block: H.deepCopy(block) };
    }
  });

  action({
    name: 'block.update', group: 'Sessions',
    ui: 'Sessions > Session sequence (a row\'s switch, subject, count or minutes)',
    summary: 'Edit one block. Only the fields that belong to its kind can change',
    args: Object.assign({
      session: required(ref('session', 'Which session')),
      block: required(BLOCK_REF)
    }, BLOCK_ARGS),
    locate: ['session', 'block'],
    target: function (ctx, args) {
      var session = M.byId(ctx.state.sessions, args.session);
      return session.blocks[blockIndex(session, args.block)];
    },
    run: function (ctx, args) {
      nothingToChange('block.update', args, Object.keys(BLOCK_ARGS));
      var session = M.sessionById(ctx.state, args.session);
      var index = blockIndex(session, args.block);
      var block = writeBlock(ctx, session.blocks[index], args, 'block.update');
      return { session: session.id, index: index, block: H.deepCopy(block) };
    }
  });

  action({
    name: 'block.move', group: 'Sessions',
    ui: 'Sessions > Session sequence > drag handle and up / down arrows',
    summary: 'Move a block to another place in the session',
    args: Object.assign({
      session: required(ref('session', 'Which session')),
      block: required(BLOCK_REF)
    }, MOVE_ARGS),
    run: function (ctx, args) {
      var session = M.sessionById(ctx.state, args.session);
      return move(session.blocks, blockIndex(session, args.block), args);
    }
  });

  action({
    name: 'block.duplicate', group: 'Sessions',
    ui: 'Sessions > Session sequence > duplicate',
    summary: 'Copy a block and place the copy right after it',
    args: {
      session: required(ref('session', 'Which session')),
      block: required(BLOCK_REF)
    },
    run: function (ctx, args) {
      var session = M.sessionById(ctx.state, args.session);
      var index = blockIndex(session, args.block);
      var copy = H.deepCopy(session.blocks[index]);
      copy.id = freshId(ctx.state, 'blk');
      session.blocks.splice(index + 1, 0, copy);
      return { session: session.id, index: index + 1, block: H.deepCopy(copy) };
    }
  });

  action({
    name: 'block.remove', group: 'Sessions',
    ui: 'Sessions > Session sequence > x',
    summary: 'Delete a block from a session',
    args: {
      session: required(ref('session', 'Which session')),
      block: required(BLOCK_REF)
    },
    run: function (ctx, args) {
      var session = M.sessionById(ctx.state, args.session);
      var index = blockIndex(session, args.block);
      return { session: session.id, index: index, removed: session.blocks.splice(index, 1)[0] };
    }
  });

  /* --- experiments ------------------------------------------------------- */

  var UNIT_ARG = object('What the experiment counts: {noun, plural, short}; plural defaults to '
    + 'noun + "s"');

  function writeUnit(experiment, unit) {
    Object.keys(unit).forEach(function (key) {
      if (['noun', 'plural', 'short'].indexOf(key) < 0) {
        fail('unit has no field "' + key + '". It takes: noun, plural, short.');
      }
      if (typeof unit[key] !== 'string' || !unit[key].trim()) fail('unit.' + key + ' must be a non-empty string.');
    });
    var next = Object.assign({}, experiment.unit || {});
    if (unit.noun) {
      next.noun = unit.noun.trim();
      if (!unit.plural) next.plural = next.noun + 's';
    }
    if (unit.plural) next.plural = unit.plural.trim();
    if (unit.short) next.short = unit.short.trim();
    experiment.unit = next;
  }

  var EXPERIMENT_FIELDS = {
    short: name('Short name for the masthead chip'),
    note: str('Free note'),
    enabled: bool('Include in the budget'),
    unit: UNIT_ARG,
    targetUnits: integer('Goal, in the experiment\'s own unit', 0),
    requestedPct: number('Share of scanner time, percent; the unlocked others redistribute', 0, 100),
    locked: bool('Hold the share while the others redistribute'),
    manualSessions: integer('Total sessions, used when solveMode is "manual"', 0),
    lockPlan: bool('Run the plan counts literally, whatever the budget says')
  };

  /* Only what actually changes is written, and only a real change to the share
   * or the switch redistributes the other experiments - as with the sliders,
   * which only fire when they move. */
  function writeExperiment(ctx, experiment, args) {
    var changed = [];
    Object.keys(EXPERIMENT_FIELDS).forEach(function (key) {
      if (!has(args, key)) return;
      if (key === 'unit') {
        var before = H.deepCopy(experiment.unit);
        writeUnit(experiment, args.unit);
        if (!same(before, experiment.unit)) changed.push(key);
        return;
      }
      if (same(experiment[key], args[key])) return;
      changed.push(key);
      if (key === 'requestedPct') {
        experiment.requestedPct = args.requestedPct;
        M.normaliseAllocation(ctx.state, experiment.id);
      } else if (key === 'enabled') {
        experiment.enabled = args.enabled;
        M.normaliseAllocation(ctx.state, null);
      } else experiment[key] = args[key];
    });
    return changed;
  }

  action({
    name: 'experiment.add', group: 'Experiments',
    ui: 'Experiments > Add experiment',
    summary: 'A new experiment with one session in its plan and a 0% share (the others '
      + 'redistribute)',
    args: Object.assign({
      name: name('Name (default "Experiment", numbered if taken)'),
      session: ref('session', 'Session for the first plan row (default: the first one; null '
        + 'for none)', { nullable: true })
    }, EXPERIMENT_FIELDS),
    run: function (ctx, args) {
      if (has(args, 'name')) claimName(ctx.state, 'experiment', args.name);
      var sessionId = args.session === undefined ? ((ctx.state.sessions[0] || {}).id || null)
        : args.session;
      var experiment = M.Library.addExperiment(ctx.state, sessionId);
      experiment.id = freshId(ctx.state, 'exp');
      if (has(args, 'name')) experiment.name = args.name;
      writeExperiment(ctx, experiment, args);
      return Object.assign(created(experiment), { plan: H.deepCopy(experiment.plan),
        requestedPct: experiment.requestedPct });
    }
  });

  libraryActions('experiment', 'Experiments', 'Experiments', {
    removeRule: 'Delete an experiment; a study keeps at least one'
  });

  action({
    name: 'experiment.update', group: 'Experiments',
    ui: 'Experiments > Identity, Unit, Goal and share, Session plan',
    summary: 'Change any of an experiment\'s fields, its plan included',
    args: Object.assign({
      experiment: subject('experiment', 'Which experiment'),
      name: name('New name'),
      plan: list('Every plan row, as in experiment.setPlan')
    }, EXPERIMENT_FIELDS),
    locate: ['experiment'],
    target: function (ctx, args) { return M.byId(ctx.state.experiments, args.experiment); },
    run: function (ctx, args) {
      nothingToChange('experiment.update', args,
        ['name', 'plan'].concat(Object.keys(EXPERIMENT_FIELDS)));
      var experiment = M.byId(ctx.state.experiments, args.experiment);
      var changed = [];
      if (has(args, 'name') && args.name !== experiment.name) {
        experiment.name = claimName(ctx.state, 'experiment', args.name, experiment);
        changed.push('name');
      }
      if (has(args, 'plan')) {
        var plan = cleanPlan(ctx.state, args.plan, 'plan');
        if (!same(plan, experiment.plan)) {
          experiment.plan = plan;
          changed.push('plan');
        }
      }
      return { id: experiment.id, changed: changed.concat(writeExperiment(ctx, experiment, args)),
        requestedPct: experiment.requestedPct };
    }
  });

  action({
    name: 'experiment.setPlan', group: 'Experiments',
    ui: 'Experiments > Session plan (the whole table at once)',
    summary: 'Replace the session plan: [{session, count}]. Counts are a mix the solver scales, '
      + 'unless lockPlan is on',
    args: {
      experiment: subject('experiment', 'Which experiment'),
      plan: required(list('Rows of {session, count}'))
    },
    locate: ['experiment'],
    target: function (ctx, args) { return M.byId(ctx.state.experiments, args.experiment); },
    run: function (ctx, args) {
      var experiment = M.experimentById(ctx.state, args.experiment);
      experiment.plan = cleanPlan(ctx.state, args.plan, 'plan');
      return { id: experiment.id, plan: H.deepCopy(experiment.plan) };
    }
  });

  var ROW_REF = spec('position', '0-based row, or the session (id or name) if it is in the plan '
    + 'once', { named: 'a session' });

  action({
    name: 'plan.add', group: 'Experiments',
    ui: 'Experiments > Add session to the plan',
    summary: 'Append a session to an experiment\'s plan',
    args: {
      experiment: required(ref('experiment', 'Which experiment')),
      session: required(ref('session', 'Session to add')),
      count: integer('Its weight in the mix (or literal count with lockPlan)', 0, undefined,
        { default: 1 })
    },
    run: function (ctx, args) {
      var experiment = M.experimentById(ctx.state, args.experiment);
      experiment.plan.push({ session: args.session, count: args.count });
      return { id: experiment.id, row: experiment.plan.length - 1, plan: H.deepCopy(experiment.plan) };
    }
  });

  action({
    name: 'plan.update', group: 'Experiments',
    ui: 'Experiments > Session plan (a row\'s session or count)',
    summary: 'Change one row of an experiment\'s plan',
    args: {
      experiment: required(ref('experiment', 'Which experiment')),
      row: required(ROW_REF),
      session: ref('session', 'Session for this row'),
      count: integer('Its weight in the mix (or literal count with lockPlan)', 0)
    },
    locate: ['experiment', 'row'],
    target: function (ctx, args) {
      var experiment = M.byId(ctx.state.experiments, args.experiment);
      return experiment.plan[rowIndex(ctx.state, experiment, args.row)];
    },
    run: function (ctx, args) {
      nothingToChange('plan.update', args, ['session', 'count']);
      var experiment = M.experimentById(ctx.state, args.experiment);
      var index = rowIndex(ctx.state, experiment, args.row);
      assign(experiment.plan[index], args, ['session', 'count']);
      return { id: experiment.id, row: index, plan: H.deepCopy(experiment.plan) };
    }
  });

  action({
    name: 'plan.move', group: 'Experiments',
    ui: 'Experiments > Session plan > up / down arrows',
    summary: 'Reorder a row of an experiment\'s plan',
    args: Object.assign({
      experiment: required(ref('experiment', 'Which experiment')),
      row: required(ROW_REF)
    }, MOVE_ARGS),
    run: function (ctx, args) {
      var experiment = M.experimentById(ctx.state, args.experiment);
      return move(experiment.plan, rowIndex(ctx.state, experiment, args.row), args);
    }
  });

  action({
    name: 'plan.remove', group: 'Experiments',
    ui: 'Experiments > Session plan > x',
    summary: 'Take a row out of an experiment\'s plan',
    args: {
      experiment: required(ref('experiment', 'Which experiment')),
      row: required(ROW_REF)
    },
    run: function (ctx, args) {
      var experiment = M.experimentById(ctx.state, args.experiment);
      var index = rowIndex(ctx.state, experiment, args.row);
      experiment.plan.splice(index, 1);
      return { id: experiment.id, plan: H.deepCopy(experiment.plan) };
    }
  });

  /* --- jitter and HRF ------------------------------------------------------ */

  var JITTER_FIELDS = ['mode', 'p', 'truncation', 'nMaxCap'];

  action({
    name: 'jitter.update', group: 'Jitter and HRF',
    ui: 'Jitter panel > Jitter sampling',
    summary: 'How jittered waits are drawn: flat across the window, or a truncated geometric '
      + 'in whole TRs',
    args: {
      mode: choice(['uniform', 'geometric'], 'uniform (flat window) or geometric'),
      p: number('Geometric p: low approaches flat, high pins to the minimum', 0.02, 0.98),
      truncation: choice(['window', 'trs'], 'Cap the longest delay at each phase\'s max, or at '
        + 'nMaxCap TRs'),
      nMaxCap: integer('Longest delay allowed in TRs, when truncation is "trs"', 0)
    },
    target: function (ctx) { return ctx.state.jitter || null; },
    run: function (ctx, args) {
      nothingToChange('jitter.update', args, JITTER_FIELDS);
      if (!ctx.state.jitter) ctx.state.jitter = M.defaultJitter();
      var changed = assign(ctx.state.jitter, args, JITTER_FIELDS);
      return { changed: changed, jitter: M.jitterSettings(ctx.state) };
    }
  });

  var HRF_FIELDS = {
    peakDelay: number('Peak delay, seconds', 2, 14),
    peakDispersion: number('Peak dispersion', 0.3, 3),
    undershootDelay: number('Undershoot delay, seconds', 6, 34),
    undershootDispersion: number('Undershoot dispersion', 0.3, 3),
    undershootRatio: number('Peak to undershoot ratio', 1, 24),
    spanSeconds: number('How far out the response is evaluated, seconds', 12, 120),
    readLagSeconds: number('Where an earlier event\'s residual is read, seconds after onset', 0, 20)
  };

  var OBJECTIVE_FIELDS = ['label', 'blurb', 'tolerancePct', 'separationSeconds'];
  var OBJECTIVE_ARGS = {
    label: name('Name shown throughout the planner'),
    blurb: str('Description'),
    tolerancePct: number('A response under this share of its peak counts as gone, percent', 0.25, 90),
    separationSeconds: number('Pinned recovery duration in seconds; 0 solves it from the '
      + 'tolerance', 0)
  };

  /* An objective's stored definition, created from the shipped one the first
   * time it is edited. */
  function storedObjective(state, id) {
    var stored = state.hrf.objectives[id];
    if (!stored) {
      var base = M.OBJECTIVES.filter(function (item) { return item.id === id; })[0];
      stored = { label: base.label, blurb: base.blurb, tolerancePct: base.tolerancePct,
        separationSeconds: base.separationSeconds };
      state.hrf.objectives[id] = stored;
    }
    return stored;
  }

  /* hrf.objectives as design.get shows it: {<objective>: {label, blurb, ...}}. */
  function writeObjectives(ctx, objectives) {
    var changed = [];
    Object.keys(objectives).forEach(function (id) {
      var where = 'objectives.' + id;
      if (OBJECTIVE_IDS.indexOf(id) < 0) {
        fail('There is no objective "' + id + '". Objectives: ' + OBJECTIVE_IDS.join(', ') + '.');
      }
      var definition = objectives[id];
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        fail(where + ' must be an object.');
      }
      var stored = storedObjective(ctx.state, id);
      var values = {};
      Object.keys(definition).forEach(function (key) {
        if (!OBJECTIVE_ARGS[key]) {
          fail(where + ' has no field "' + key + '". It takes: ' + OBJECTIVE_FIELDS.join(', ') + '.');
        }
        values[key] = same(stored[key], definition[key]) ? definition[key]
          : checkValue(OBJECTIVE_ARGS[key], definition[key], where + '.' + key, ctx);
      });
      assign(stored, values, OBJECTIVE_FIELDS).forEach(function (key) {
        changed.push(where + '.' + key);
      });
    });
    return changed;
  }

  action({
    name: 'hrf.update', group: 'Jitter and HRF',
    ui: 'HRF model > Response shape sliders and objective definitions',
    summary: 'The double-gamma response every separation and efficiency figure is solved against, '
      + 'and (as objectives) what each objective counts as separated',
    args: Object.assign({}, HRF_FIELDS, {
      objectives: object('{<objective>: {label, blurb, tolerancePct, separationSeconds}}, as in '
        + 'objective.update')
    }),
    target: function (ctx) { return ctx.state.hrf; },
    run: function (ctx, args) {
      nothingToChange('hrf.update', args, Object.keys(HRF_FIELDS).concat('objectives'));
      var changed = assign(ctx.state.hrf, args, Object.keys(HRF_FIELDS));
      if (has(args, 'objectives')) changed = changed.concat(writeObjectives(ctx, args.objectives));
      return { changed: changed };
    }
  });

  action({
    name: 'hrf.reset', group: 'Jitter and HRF',
    ui: 'HRF model > Reset to the canonical response',
    summary: 'Back to the SPM double gamma (peak 6 s, undershoot 16 s, ratio 6); objective '
      + 'definitions are kept',
    run: function (ctx) {
      ctx.state.hrf = Object.assign(M.defaultHrf(), { objectives: ctx.state.hrf.objectives });
      return { hrf: H.deepCopy(ctx.state.hrf) };
    }
  });

  action({
    name: 'objective.update', group: 'Jitter and HRF',
    ui: 'HRF model > objective definitions',
    summary: 'What "separated" means for one objective: its name, description, residual '
      + 'tolerance, or a pinned recovery duration',
    args: Object.assign({
      objective: required(choice(OBJECTIVE_IDS, 'detection, estimation or separation'))
    }, OBJECTIVE_ARGS),
    locate: ['objective'],
    target: function (ctx, args) { return ctx.state.hrf.objectives[args.objective] || null; },
    run: function (ctx, args) {
      nothingToChange('objective.update', args, OBJECTIVE_FIELDS);
      var stored = storedObjective(ctx.state, args.objective);
      var changed = assign(stored, args, OBJECTIVE_FIELDS);
      return { objective: args.objective, changed: changed,
        definition: M.objectiveDef(ctx.state, args.objective) };
    }
  });

  /* --- acquisition cards --------------------------------------------------- */

  action({
    name: 'card.list', group: 'Acquisition cards', query: true,
    ui: 'Acquisition panel > card list',
    summary: 'Every card with its role, TR, TE, series duration and what in this design uses it',
    run: function (ctx) {
      return ((ctx.boot && ctx.boot.manifest) || []).map(function (entry) {
        var acquisition = (ctx.boot.acquisition || {})[entry.slug] || {};
        return {
          slug: entry.slug, label: entry.label, role: entry.role, note: entry.note,
          trMs: acquisition.trMs, teMs: acquisition.teMs,
          durationSeconds: acquisition.durationSeconds,
          headline: entry.headline, usedBy: cardUsage(ctx.state, entry.slug)
        };
      });
    }
  });

  action({
    name: 'card.get', group: 'Acquisition cards', query: true,
    ui: 'Acquisition panel > card editor',
    summary: 'One card with every parameter, grouped by console page',
    args: { card: required(ref('card', 'Card slug or name')) },
    run: function (ctx, args) {
      var data = ((ctx.boot && ctx.boot.protocols) || {})[args.card];
      return { slug: args.card, data: H.deepCopy(data || {}), usedBy: cardUsage(ctx.state, args.card) };
    }
  });

  /* planner/protocols.py ROLES */
  var ROLE_IDS = ['functional', 'reference', 'structural', 'other'];

  action({
    name: 'card.create', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > New card, and New card from this one',
    summary: 'A new card, blank or copied from a base card. Cards are shared by every design',
    args: {
      label: required(name('Card name')),
      role: choice(ROLE_IDS, 'What the card is for', { default: 'functional' }),
      note: str('Free note'),
      base: ref('card', 'Copy every parameter from this card'),
      slug: name('File name to use (default: derived from the label)')
    }
  });

  action({
    name: 'card.duplicate', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > Duplicate',
    summary: 'Copy a card',
    args: {
      card: required(ref('card', 'Card to copy')),
      label: name('Name for the copy')
    }
  });

  action({
    name: 'card.rename', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > Rename (optionally renaming the file)',
    summary: 'Rename a card. With renameFile the slug follows the name and every run and '
      + 'structural block in this design is repointed',
    args: {
      card: required(ref('card', 'Card to rename')),
      label: required(name('New name')),
      renameFile: bool('Rename the file (and so the slug) too', { default: false })
    }
  });

  action({
    name: 'card.setMeta', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > name, role and note fields',
    summary: 'Set a card\'s name, role or note',
    args: {
      card: required(ref('card', 'Which card')),
      label: name('Name'),
      role: choice(ROLE_IDS, 'Role'),
      note: str('Note')
    }
  });

  action({
    name: 'card.setParameters', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > parameter values, then Save card',
    summary: 'Write parameter values by name, e.g. {"Act. TR/TE (ms)": "2000 / 30"}. Names '
      + 'match case-insensitively; every name must exist on the card',
    args: {
      card: required(ref('card', 'Which card')),
      values: required(object('Parameter name to new value'))
    }
  });

  action({
    name: 'card.replace', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > add, rename, indent, reorder or delete parameters and pages, then Save card',
    summary: 'Replace a card\'s whole JSON (pages and rows). Take it from card.get, edit, send it '
      + 'back',
    args: {
      card: required(ref('card', 'Which card')),
      data: required(object('The card JSON: {"_meta": {...}, "PAGE": [{"parameter", "value", ...}]}'))
    }
  });

  action({
    name: 'card.delete', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > Delete',
    summary: 'Delete a card. Refused while this design uses it, or if it is the last card',
    args: { card: required(ref('card', 'Card to delete')) },
    prepare: function (ctx, args) {
      var usage = cardUsage(ctx.state, args.card);
      var users = usage.runs.concat(usage.sessions);
      if (users.length) {
        fail('"' + args.card + '" is still used by ' + users.join(', ')
          + '. Point those somewhere else first.');
      }
      return args;
    }
  });

  action({
    name: 'card.applySolvedTiming', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > Apply solved timing',
    summary: 'Write the solved dyn scans, dummy scans and total scan duration of a run design '
      + 'into the card it is bound to',
    args: { run: required(ref('run', 'Run design whose solved timing to write')) },
    prepare: function (ctx, args) {
      var solved = solvedCardUpdates(ctx.solved(), args.run);
      if (!solved) fail('That run design has no solved timing (is its card missing?).');
      return Object.assign({}, args, solved);
    }
  });

  action({
    name: 'card.backups', group: 'Acquisition cards', host: 'server', query: true,
    ui: 'Acquisition > Backups',
    summary: 'The snapshots taken before each save of a card, newest first',
    args: { card: required(ref('card', 'Which card')) }
  });

  action({
    name: 'card.restore', group: 'Acquisition cards', host: 'server',
    ui: 'Acquisition > Backups > restore',
    summary: 'Put a snapshot back (the current card is itself backed up first)',
    args: {
      card: required(ref('card', 'Which card')),
      file: required(name('Snapshot file name from card.backups'))
    }
  });

  /* --- results and export -------------------------------------------------- */

  action({
    name: 'report', group: 'Results and export', query: true,
    ui: 'Overview, and every Solved ... readout',
    summary: 'Solve the design. view "summary" (default) is the key numbers; "full" is the '
      + 'whole report; "warnings" is the constraint report alone',
    args: { view: choice(['summary', 'full', 'warnings'], 'How much to return', { default: 'summary' }) },
    run: function (ctx, args) {
      var report = ctx.solved();
      if (args.view === 'warnings') return report.warnings;
      if (args.view === 'full') return slimReport(report);
      return summarise(report);
    }
  });

  action({
    name: 'export.markdown', group: 'Results and export', query: true,
    ui: 'Report and export > Copy every table / Download .md / table picker',
    summary: 'The report as Markdown: every table, or one by name',
    args: { table: str('One table by name, e.g. "Study summary" (default: the whole report)') },
    run: function (ctx, args) {
      var report = ctx.solved();
      if (!has(args, 'table')) return { markdown: M.allMarkdown(report) };
      var tables = report.markdownTables;
      var key = Object.keys(tables).filter(function (item) {
        return item.toLowerCase() === args.table.toLowerCase();
      })[0];
      if (!key) fail('No table "' + args.table + '". Tables: ' + Object.keys(tables).join('; ') + '.');
      return { table: key, markdown: tables[key] };
    }
  });

  action({
    name: 'export.methods', group: 'Results and export', query: true,
    ui: 'Report and export > Copy methods text',
    summary: 'The paste-ready methods paragraph generated from the solved design',
    run: function (ctx) { return { methods: ctx.solved().methodsText }; }
  });

  action({
    name: 'export.psychopy', group: 'Results and export', query: true,
    ui: 'Report and export > PsychoPy task config',
    summary: 'The PsychoPy YAML for every run design, or for one',
    args: { run: ref('run', 'One run design (default: all)') },
    run: function (ctx, args) {
      var report = ctx.solved();
      return report.runs.filter(function (run) {
        return !run.missing && (!has(args, 'run') || run.id === args.run);
      }).map(function (run) {
        return { run: run.name, file: M.psychopyFileName(run), yaml: M.psychopyYaml(report, run) };
      });
    }
  });

  action({
    name: 'export.figures', group: 'Results and export', query: true,
    ui: 'Every figure card > Download SVG',
    summary: 'The figures as SVG markup: study scanner time, one timeline per trial design, '
      + 'one assembly figure per experiment',
    args: { name: str('One figure by file stem (default: all)') },
    run: function (ctx, args) {
      var App = global.PlannerApp;
      if (!App || !App.collectFigures) fail('Figures are not available in this host.');
      var saved = { state: App.state, report: App.report, boot: App.boot };
      App.state = ctx.state;
      App.report = ctx.solved();
      App.boot = ctx.boot;
      try {
        return App.collectFigures().filter(function (figure) {
          return !has(args, 'name') || figure.name === args.name;
        });
      } finally {
        App.state = saved.state;
        App.report = saved.report;
        App.boot = saved.boot;
      }
    }
  });

  /* ------------------------------------------------------------- sessions */

  /* A working session over one design.  Actions run in order against the same
   * state; the solved report is cached until something changes it. */
  function openSession(state, boot, options) {
    var opts = options || {};
    var ctx = {
      state: opts.migrate === false ? state : M.migrateState(state),
      boot: boot || {},
      report: null,
      solved: function () {
        if (!ctx.report) {
          M.applyHrf(ctx.state);
          ctx.report = M.solve(ctx.state, ctx.boot);
        }
        return ctx.report;
      },
      replace: function (next) { ctx.state = next; }
    };

    function lookup(nameValue) {
      var entry = ACTIONS.filter(function (item) { return item.name === nameValue; })[0];
      if (!entry) fail('No action "' + nameValue + '".' + suggest(nameValue));
      return entry;
    }

    /* Validate a call and resolve its references.  Server-hosted actions also
     * run their design-side checks here, so the server only acts on calls the
     * design has already accepted. */
    function prepare(raw) {
      var call = splitCall(raw);
      var entry = lookup(call.name);
      var args = validate(ctx, entry, call.args);
      if (entry.prepare) args = entry.prepare(ctx, args);
      return { action: entry.name, host: entry.host, query: !!entry.query, args: args };
    }

    function run(prepared) {
      var entry = lookup(prepared.action);
      if (entry.host !== 'js') {
        fail(entry.name + ' changes files on the server; call it through POST '
          + '/api/v1/designs/<name>/actions.');
      }
      var result = entry.run(ctx, prepared.args);
      if (!entry.query) ctx.report = null;
      return result === undefined ? null : result;
    }

    function execute(raw) { return run(prepare(raw)); }

    /* Solve, and take the solver's repairs into the design - exactly what the
     * interface does after every edit, so the design saved is the one that
     * actually runs. */
    function finish() {
      var report = ctx.solved();
      if (report.state) {
        ['trials', 'runs', 'sessions', 'experiments'].forEach(function (key) {
          ctx.state[key] = report.state[key];
        });
      }
      return { state: ctx.state, report: report, summary: summarise(report) };
    }

    return {
      ctx: ctx,
      prepare: prepare,
      run: run,
      execute: execute,
      finish: finish,
      state: function () { return ctx.state; },
      setBoot: function (next) { ctx.boot = next || {}; ctx.report = null; },
      replace: function (next) { ctx.state = M.migrateState(next); ctx.report = null; },
      repointCard: function (from, to) {
        var changed = repointCard(ctx.state, from, to);
        ctx.report = null;
        return changed;
      },
      summary: function () { return summarise(ctx.solved()); }
    };
  }

  /* One action against a state the caller owns - what the interface's
   * buttons use.  The state is changed in place where the action allows;
   * `state` in the answer is a different object when the action replaced it
   * wholesale, and the caller should adopt that one. */
  function execute(state, boot, raw) {
    var working = openSession(state, boot, { migrate: false });
    var result = working.execute(raw);
    return { state: working.state(), result: result };
  }

  /* The catalogue in plain JSON, for GET /api/v1 and for the docs. */
  function catalogue() {
    return ACTIONS.map(function (entry) {
      var args = {};
      Object.keys(entry.args).forEach(function (key) {
        var item = entry.args[key];
        var out = { type: item.type === 'position' ? 'integer|string' : item.type };
        if (item.type === 'ref') out.type = 'ref:' + item.ref;
        ['required', 'values', 'min', 'max', 'default', 'nullable', 'aliases'].forEach(function (field) {
          if (item[field] !== undefined) out[field] = item[field];
        });
        out.doc = item.doc;
        args[key] = out;
      });
      return {
        name: entry.name,
        group: entry.group,
        summary: entry.summary,
        ui: entry.ui,
        changesDesign: !entry.query,
        server: entry.host === 'server',
        /* Takes its item back whole, as design.get shows it. */
        roundTrip: !!entry.target,
        args: args
      };
    });
  }

  global.PlannerActions = {
    ActionError: ActionError,
    catalogue: catalogue,
    session: openSession,
    execute: execute,
    summarise: summarise,
    solvedCardUpdates: solvedCardUpdates,
    cardUsage: cardUsage,
    repointCard: repointCard,
    names: function () { return ACTIONS.map(function (entry) { return entry.name; }); }
  };
}(typeof window !== 'undefined' ? window : globalThis));
