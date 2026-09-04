/* The design library: trial designs, run designs, sessions and experiments.
 *
 * Every level is the same shape - a named list on the left, an editor for the
 * selected item on the right - so adding, duplicating, renaming, reordering
 * and deleting work identically wherever you are in the hierarchy. */

(function (global) {
  'use strict';

  var App, M, H;

  /* --------------------------------------------------------------- shell */

  /* One library panel.  `spec` says what the list holds and how to draw the
   * editor for whichever item is selected. */
  function libraryPanel(spec) {
    var owner = spec.id + '-editor';
    var local = { selected: null };
    var listHost = App.h('div', { class: 'proto-list' });
    var editorHost = App.h('div', {});

    function items() { return spec.items(App.state) || []; }

    function current() {
      var list = items();
      var found = list.filter(function (item) { return item.id === local.selected; })[0];
      if (!found) found = list[0] || null;
      local.selected = found ? found.id : null;
      return found;
    }

    function select(id) {
      local.selected = id;
      renderList();
      renderEditor();
    }

    function renderList() {
      App.clear(listHost);
      var list = items();
      if (!list.length) {
        listHost.appendChild(App.h('div', {
          class: 'notice', text: spec.emptyList || 'Nothing here yet.'
        }));
        return;
      }
      list.forEach(function (item, index) {
        var meta = spec.meta ? spec.meta(item, App.report) : [];
        var button = App.h('button', {
          class: 'proto-item' + (local.selected === item.id ? ' active' : ''),
          type: 'button'
        }, [
          App.h('div', { class: 'name' }, [
            spec.colour ? App.h('span', {
              class: 'swatch', style: 'background:' + spec.colour(item, index)
            }) : null,
            App.h('span', { text: item.name || 'Untitled' }),
            item.enabled === false ? App.h('span', { class: 'pill off', text: 'off' }) : null
          ])
        ].concat(meta.map(function (line) {
          return App.h('div', { class: 'meta', text: line });
        })));
        button.addEventListener('click', function () { select(item.id); });
        listHost.appendChild(button);

        var tools = App.h('div', { class: 'proto-tools' }, [
          App.iconButton('↑', 'Move up', function () {
            if (M.Library.move(items(), item.id, -1)) App.refresh();
            renderList();
          }),
          App.iconButton('↓', 'Move down', function () {
            if (M.Library.move(items(), item.id, 1)) App.refresh();
            renderList();
          }),
          App.iconButton('Duplicate', 'Copy this ' + spec.noun, function () {
            var copy = spec.duplicate(App.state, item.id);
            if (copy) {
              App.refresh();
              select(copy.id);
              App.toast('Duplicated as "' + copy.name + '"', 'ok');
            }
          }),
          App.iconButton('Delete', 'Remove this ' + spec.noun, function () {
            var error = spec.remove(App.state, item.id);
            if (error) { App.toast(error, 'bad'); return; }
            if (local.selected === item.id) local.selected = null;
            App.refresh();
            renderList();
            renderEditor();
            App.toast('Deleted "' + item.name + '"');
          }, 'danger')
        ]);
        listHost.appendChild(tools);
      });
    }

    function renderEditor() {
      App.dropControls(owner);
      App.dropViews(owner);
      App.clear(editorHost);
      var item = current();
      if (!item) {
        editorHost.appendChild(App.h('div', {
          class: 'notice',
          text: 'Nothing selected. Add a ' + spec.noun + ' with the button above.'
        }));
        return;
      }
      spec.buildEditor(item, editorHost, owner, select);
      App.syncOwner(owner);
    }

    var addButton = App.h('button', {
      class: 'btn sm', type: 'button', text: 'Add ' + spec.noun,
      onclick: function () {
        var created = spec.add(App.state);
        if (!created) return;
        App.refresh();
        select(created.id);
        App.toast('Added "' + created.name + '"', 'ok');
      }
    });

    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: spec.title }),
      App.h('p', { text: spec.blurb })
    ]));

    var listCard = App.flushCard(spec.listTitle || spec.title, null, [listHost],
      App.h('div', { class: 'btn-row' }, [addButton]));
    panel.appendChild(App.h('div', { class: 'proto-layout' }, [listCard, editorHost]));

    /* A single registered view keeps the list fresh; the editor re-registers
     * its own views under `owner` each time the selection changes. */
    App.registerView(function () {
      var before = local.selected;
      renderList();
      if (before !== local.selected || !editorHost.firstChild) renderEditor();
    });

    renderList();
    renderEditor();
    panel.select = select;
    return panel;
  }

  /* Name / note header shared by every editor. */
  function identityCard(item, owner, extra) {
    return App.card('Identity', null, [
      App.field({
        owner: owner, label: 'Name', stack: true,
        get: function () { return item.name; },
        set: function (value) { item.name = String(value || '').trim() || item.name; }
      }),
      App.field({
        owner: owner, label: 'Note', stack: true, type: 'textarea', rows: 2,
        get: function () { return item.note || ''; },
        set: function (value) { item.note = value; }
      })
    ].concat(extra || []));
  }

  function numberInput(get, set, options) {
    options = options || {};
    var input = App.h('input', {
      type: 'number', step: options.step || 'any',
      min: options.min, max: options.max, class: 'cell-input'
    });
    input.value = get();
    function commit() {
      set(H.num(input.value));
      App.refresh();
    }
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    return input;
  }

  function textInput(get, set, placeholder) {
    var input = App.h('input', { type: 'text', class: 'cell-input', placeholder: placeholder });
    input.value = get();
    function commit() { set(input.value); App.refresh(); }
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    return input;
  }

  function selectInput(get, set, options) {
    var select = App.h('select', { class: 'cell-input' });
    options.forEach(function (option) {
      select.appendChild(App.h('option', { value: option.value, text: option.label }));
    });
    select.value = get();
    select.addEventListener('change', function () { set(select.value); App.refresh(); });
    return select;
  }

  function cardOptions(role) {
    return (App.boot.manifest || []).filter(function (entry) {
      return !role || entry.role === role;
    }).map(function (entry) {
      return { value: entry.slug, label: entry.label + '  (' + entry.slug + ')' };
    });
  }

  /* ------------------------------------------------------------- trials */

  function buildTrials() {
    return libraryPanel({
      id: 'trials',
      noun: 'trial design',
      title: 'Trial designs',
      blurb: 'What one trial looks like, second by second. A trial design is a list of '
        + 'phases; run designs point at it, so editing here changes every run that uses it.',
      listTitle: 'Trial designs',
      items: function (state) { return state.trials; },
      add: function (state) { return M.Library.addTrial(state); },
      duplicate: function (state, id) { return M.Library.duplicateTrial(state, id); },
      remove: function (state, id) { return M.Library.removeTrial(state, id); },
      meta: function (trial) {
        var timing = M.trialTiming(trial);
        return [
          H.fmtRange(timing.min, timing.max) + '  ·  ' + trial.phases.length + ' phases',
          (M.objectiveDef(App.state, trial.objective).label)
        ];
      },
      buildEditor: buildTrialEditor
    });
  }

  function buildTrialEditor(trial, host, owner) {
    var objectives = M.OBJECTIVES.map(function (objective) {
      return {
        value: objective.id,
        label: M.objectiveDef(App.state, objective.id).label,
        hint: M.objectiveDef(App.state, objective.id).blurb
      };
    });

    host.appendChild(identityCard(trial, owner, [
      App.segmented({
        owner: owner, label: 'Objective',
        hint: 'What this trial design is trying to buy',
        options: objectives,
        get: function () { return trial.objective; },
        set: function (value) { trial.objective = value; },
        onChange: function () {
          App.adopt(M.applyObjectiveDefaults(App.state, trial.id));
          App.toast('Adopted the timing this objective implies', 'ok');
        }
      }),
      App.h('div', { class: 'notice', text: M.objectiveDef(App.state, trial.objective).blurb })
    ]));

    /* --- conditions ---------------------------------------------------- */
    host.appendChild(App.card('Conditions', 'The two levels the response window is split by', [
      App.field({
        owner: owner, label: 'Condition A', stack: true,
        get: function () { return (trial.conditions || {}).a || ''; },
        set: function (value) {
          if (!trial.conditions) trial.conditions = {};
          trial.conditions.a = value;
        }
      }),
      App.field({
        owner: owner, label: 'Condition B', stack: true,
        get: function () { return (trial.conditions || {}).b || ''; },
        set: function (value) {
          if (!trial.conditions) trial.conditions = {};
          trial.conditions.b = value;
        }
      }),
      App.slider({
        owner: owner, label: 'Share assigned to condition A', min: 0, max: 100, step: 1, unit: '%',
        get: function () { return H.num(trial.conditionBalance, 50); },
        set: function (value) { trial.conditionBalance = value; }
      }),
      App.slider({
        owner: owner, label: 'Embedded control / null trials',
        min: 0, max: 60, step: 1, unit: '%',
        hint: 'Subtracted from the trial count to give the primary event count',
        get: function () { return H.num(trial.controlPct); },
        set: function (value) { trial.controlPct = value; }
      }),
      App.slider({
        owner: owner, label: 'Jitter seed', min: 1, max: 99999999, step: 1, unit: '',
        hint: 'Same seed, same simulated run',
        get: function () { return H.num(trial.seed, 20260823); },
        set: function (value) { trial.seed = Math.round(value); }
      })
    ]));

    /* --- phases -------------------------------------------------------- */
    var phaseHost = App.h('div', {});
    function renderPhases() {
      App.clear(phaseHost);
      var rows = trial.phases.map(function (phase, index) {
        return [
          { text: String(index + 1), num: true },
          { html: '', node: textInput(
            function () { return phase.name; },
            function (value) { phase.name = value || 'Phase'; }
          ), copy: phase.name },
          { node: selectInput(
            function () { return M.normaliseRole(phase.role); },
            function (value) { phase.role = value; },
            M.PHASE_ROLES.map(function (role) {
              return { value: role.id, label: role.label };
            })
          ), copy: M.normaliseRole(phase.role) },
          { node: numberInput(
            function () { return H.round(H.num(phase.min), 2); },
            function (value) {
              phase.min = Math.max(0, value);
              if (phase.max < phase.min) phase.max = phase.min;
            }, { min: 0, step: 0.5 }
          ), num: true, copy: H.trim(phase.min, 1) },
          { node: numberInput(
            function () { return H.round(H.num(phase.max), 2); },
            function (value) { phase.max = Math.max(H.num(phase.min), value); },
            { min: 0, step: 0.5 }
          ), num: true, copy: H.trim(phase.max, 1) },
          { node: (function () {
            var box = App.h('input', { type: 'checkbox' });
            box.checked = !!phase.jitter;
            box.addEventListener('change', function () {
              phase.jitter = box.checked;
              App.refresh();
            });
            return box;
          }()), copy: phase.jitter ? 'yes' : 'no' },
          { node: App.h('div', { class: 'btn-row tight' }, [
            App.iconButton('↑', 'Move up', function () {
              if (index === 0) return;
              var moved = trial.phases.splice(index, 1)[0];
              trial.phases.splice(index - 1, 0, moved);
              renderPhases();
              App.refresh();
            }),
            App.iconButton('↓', 'Move down', function () {
              if (index >= trial.phases.length - 1) return;
              var moved = trial.phases.splice(index, 1)[0];
              trial.phases.splice(index + 1, 0, moved);
              renderPhases();
              App.refresh();
            }),
            App.iconButton('×', 'Remove this phase', function () {
              if (trial.phases.length <= 1) {
                App.toast('A trial needs at least one phase.', 'bad');
                return;
              }
              trial.phases.splice(index, 1);
              renderPhases();
              App.refresh();
            }, 'danger')
          ]), copy: '' }
        ];
      });

      var table = App.dataTable(
        [{ label: '#', num: true }, { label: 'Phase' }, { label: 'Role' },
          { label: 'Min (s)', num: true }, { label: 'Max (s)', num: true },
          { label: 'Jitter' }, { label: '' }],
        rows.map(function (row) {
          return row.map(function (cell) {
            return { text: cell.text, num: cell.num, className: cell.node ? 'cell' : '',
              copy: cell.copy };
          });
        }),
        { caption: trial.name + ' - phases' }
      );

      /* Put the live inputs into the cells the table just rendered. */
      var bodyRows = table.querySelectorAll('tbody tr');
      rows.forEach(function (row, rowIndex) {
        var tr = bodyRows[rowIndex];
        if (!tr) return;
        row.forEach(function (cell, cellIndex) {
          if (!cell.node) return;
          var td = tr.children[cellIndex];
          App.clear(td);
          td.appendChild(cell.node);
        });
      });

      phaseHost.appendChild(table);
      phaseHost.appendChild(App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Add phase', 'Append a phase to the trial', function () {
          trial.phases.push({
            name: 'Phase ' + (trial.phases.length + 1), role: 'baseline',
            min: 2, max: 2, jitter: false
          });
          renderPhases();
          App.refresh();
        }, ''),
        App.iconButton('Reset to the objective default',
          'Replace the phases with the recommended timing for this objective', function () {
            App.adopt(M.applyRecommendedTiming(App.state, trial.id));
            App.toast('Recommended timing applied', 'ok');
          }),
        App.iconButton('Optimise delay and tail',
          'Search the delay and post-response fixation for this objective', function () {
            App.toast('Searching the timing grid…');
            setTimeout(function () {
              App.adopt(M.optimiseTiming(App.state, App.boot, trial.id, 'auto'));
              App.toast('Timing optimised for the objective', 'ok');
            }, 30);
          })
      ]));
    }
    renderPhases();

    var timingReadout = App.h('div', { class: 'readout' });
    App.registerView(function (report) {
      App.clear(timingReadout);
      var record = report.trials.filter(function (item) { return item.id === trial.id; })[0];
      if (!record) return;
      timingReadout.appendChild(App.readoutCell('Shortest trial', record.timing.min + ' s'));
      timingReadout.appendChild(App.readoutCell('Mean trial', record.timing.mean + ' s'));
      timingReadout.appendChild(App.readoutCell('Longest trial', record.timing.max + ' s'));
      timingReadout.appendChild(App.readoutCell('Phases', String(record.phases.length)));
      timingReadout.appendChild(App.readoutCell('Control share', record.controlPct + ' %'));
      timingReadout.appendChild(App.readoutCell('Used by',
        record.usedBy.length ? App.escapeHtml(record.usedBy.join(', ')) : '—'));
    }, owner);

    host.appendChild(App.card('Trial phases',
      'Order, duration and jitter; roles drive the regressor model',
      [timingReadout, phaseHost]));

    host.appendChild(buildSeparationCard(trial, owner));

    host.appendChild(App.figureCard('Trial timeline', '', function () {
      return {
        markup: App.trialFigureMarkup(trial, 0),
        caption: 'Onsets are cumulative means; jittered phases vary trial to trial.',
        empty: 'Add at least one phase to draw the timeline.'
      };
    }, function () { return App.fileStem(trial.name, 'trial-timeline'); }, [
      App.iconButton('Copy sequence', 'Copy the phase sequence as text', function () {
        App.copy(trial.phases.map(H.phaseLabel).join(' -> '), 'Trial sequence');
      })
    ], owner));
  }

  /* The separation solver: one slider that solves the delay and the tail from
   * the response shape, with the objective's own definition of "separated". */
  function buildSeparationCard(trial, owner) {
    var readout = App.h('div', { class: 'readout' });
    var note = App.h('div', { class: 'notice' });

    function solved() {
      return M.separationTiming(App.state, trial,
        H.num(trial.separationTolerancePct, M.objectiveDef(App.state, trial.objective).tolerancePct));
    }

    function render() {
      App.clear(readout);
      var result = solved();
      var objective = M.objectiveDef(App.state, trial.objective);
      if (!result) {
        note.textContent = 'This solver needs one phase with the Stimulus role and one with '
          + 'the Response role. Set those roles above and it comes alive.';
        return;
      }
      var index = M.phaseIndices(trial);
      var matchesDelay = index.delay < 0
        || (Math.abs(H.num(trial.phases[index.delay].min) - result.delayMin) < 0.05);
      var matchesTail = index.tailBaseline < 0
        || (Math.abs(H.num(trial.phases[index.tailBaseline].min) - result.tailMin) < 0.05);

      readout.appendChild(App.readoutCell('Solved delay',
        result.delayMin === result.delayMax
          ? result.delayMin + ' s'
          : result.delayMin + ' - ' + result.delayMax + ' s'));
      readout.appendChild(App.readoutCell('Solved tail fixation',
        result.tailMin === result.tailMax
          ? result.tailMin + ' s'
          : result.tailMin + ' - ' + result.tailMax + ' s'));
      readout.appendChild(App.readoutCell('Mean trial', H.round(result.trialMean, 1) + ' s'));
      readout.appendChild(App.readoutCell('Stimulus still present',
        H.round(result.stimulusResidualPct, 2) + ' %'));
      readout.appendChild(App.readoutCell('Carryover at next trial',
        H.round(result.carryResidualPct, 2) + ' %'));
      readout.appendChild(App.readoutCell('Separated after',
        (result.overrideSeconds > 0
          ? result.overrideSeconds + ' s (pinned)'
          : H.round(result.responseDecay, 1) + ' s (from HRF)')));

      note.textContent = objective.label + ' is currently defined as '
        + (result.overrideSeconds > 0
          ? 'a fixed ' + result.overrideSeconds + ' s of recovery'
          : 'a residual under ' + H.round(result.tolerancePct, 2) + '% of the event peak')
        + ', read ' + H.round(result.readLagSeconds, 1) + ' s after the next event\'s onset. '
        + 'Change that definition in the HRF model panel. '
        + (matchesDelay && matchesTail
          ? 'The trial above matches this solution.'
          : 'The trial above does not match yet - apply it to adopt these values.');
    }

    App.registerView(render, owner);

    var slider = App.slider({
      owner: owner,
      label: 'Allowed residual at the next event',
      min: 0.25, max: 60, step: 0.25, decimals: 2, unit: '%', gold: true,
      hint: 'Drag to solve the delay and the tail fixation from the response shape',
      get: function () {
        return H.num(trial.separationTolerancePct,
          M.objectiveDef(App.state, trial.objective).tolerancePct);
      },
      set: function (value) { trial.separationTolerancePct = value; },
      onChange: render
    });

    var presets = App.h('div', { class: 'btn-row' }, [1, 4, 10, 25, 45].map(function (value) {
      return App.iconButton(value + ' %', 'Solve at a ' + value + '% residual', function () {
        App.adopt(M.applySeparationTiming(App.state, trial.id, value));
        App.toast('Timing solved at a ' + value + '% residual', 'ok');
      });
    }));

    return App.card('Separation solver',
      'Solve the delay and tail from the response shape', [
        slider,
        presets,
        readout,
        note,
        App.h('div', { class: 'btn-row mt' }, [
          App.h('button', {
            class: 'btn gold sm', type: 'button', text: 'Apply this solution',
            onclick: function () {
              App.adopt(M.applySeparationTiming(App.state, trial.id,
                H.num(trial.separationTolerancePct, 4)));
              App.toast('Solved timing written into the trial', 'ok');
            }
          })
        ])
      ]);
  }

  /* --------------------------------------------------------------- runs */

  function buildRuns() {
    return libraryPanel({
      id: 'runs',
      noun: 'run design',
      title: 'Run designs',
      blurb: 'A trial design laid out into blocks and bound to an acquisition card. '
        + 'A run is what the scanner and the presentation computer actually execute.',
      listTitle: 'Run designs',
      items: function (state) { return state.runs; },
      add: function (state) {
        var card = (App.boot.manifest || []).filter(function (entry) {
          return entry.role === 'functional';
        })[0];
        return M.Library.addRun(state, (state.trials[0] || {}).id, card ? card.slug : null);
      },
      duplicate: function (state, id) { return M.Library.duplicateRun(state, id); },
      remove: function (state, id) { return M.Library.removeRun(state, id); },
      meta: function (run) {
        var trial = M.trialById(App.state, run.trial);
        var ctx = M.protocolContext(App.boot, run.protocol);
        var geometry = M.runGeometry(run, trial, ctx.trSeconds);
        return [
          (trial ? trial.name : 'no trial design') + '  ·  ' + ctx.label,
          geometry.trialsPerRun + ' trials  ·  '
            + H.fmtRange(geometry.run.min, geometry.run.max)
        ];
      },
      buildEditor: buildRunEditor
    });
  }

  function buildRunEditor(run, host, owner) {
    host.appendChild(identityCard(run, owner, [
      App.field({
        owner: owner, label: 'Trial design', type: 'select', stack: true,
        optionsFrom: function (state) {
          return state.trials.map(function (trial) {
            return { value: trial.id, label: trial.name };
          });
        },
        get: function () { return run.trial; },
        set: function (value) { run.trial = value; }
      }),
      App.field({
        owner: owner, label: 'Acquisition card', type: 'select', stack: true,
        hint: 'TR, matrix and slices come from this card',
        optionsFrom: function () { return cardOptions(); },
        get: function () { return run.protocol; },
        set: function (value) { run.protocol = value; }
      })
    ]));

    host.appendChild(App.card('Run structure', 'How trials are stacked into a run', [
      App.slider({
        owner: owner, label: 'Trials per block', min: 1, max: 60, step: 1, unit: 'tr',
        get: function () { return H.num(run.trialsPerBlock, 1); },
        set: function (value) {
          run.trialsPerBlock = Math.max(1, Math.round(value));
          if (run.labelOrder === 'blocked') run.labelRunLength = run.trialsPerBlock;
        }
      }),
      App.slider({
        owner: owner, label: 'Blocks per run', min: 1, max: 30, step: 1, unit: 'bl',
        get: function () { return H.num(run.blocksPerRun, 1); },
        set: function (value) { run.blocksPerRun = Math.max(1, Math.round(value)); }
      }),
      App.slider({
        owner: owner, label: 'Inter-trial gap', min: 0, max: 30, step: 0.5, decimals: 1, unit: 's',
        get: function () { return H.num(run.interTrialGap); },
        set: function (value) { run.interTrialGap = value; }
      }),
      App.slider({
        owner: owner, label: 'Inter-block rest', min: 0, max: 120, step: 1, unit: 's',
        get: function () { return H.num(run.interBlockRest); },
        set: function (value) { run.interBlockRest = value; }
      }),
      App.slider({
        owner: owner, label: 'Dummy volumes', min: 0, max: 60, step: 1, unit: 'vol',
        hint: 'Discarded while magnetisation settles',
        get: function () { return H.num(run.dummyVolumes); },
        set: function (value) { run.dummyVolumes = Math.max(0, Math.round(value)); }
      }),
      App.slider({
        owner: owner, label: 'Lead-in', min: 0, max: 60, step: 1, unit: 's',
        get: function () { return H.num(run.leadIn); },
        set: function (value) { run.leadIn = value; }
      }),
      App.slider({
        owner: owner, label: 'Lead-out', min: 0, max: 60, step: 1, unit: 's',
        get: function () { return H.num(run.leadOut); },
        set: function (value) { run.leadOut = value; }
      })
    ]));

    host.appendChild(App.card('Condition ordering', 'How the two conditions are sequenced', [
      App.segmented({
        owner: owner, label: 'Ordering',
        options: M.LABEL_ORDERS.map(function (order) {
          return { value: order.id, label: order.label };
        }),
        get: function () { return run.labelOrder || 'intermixed'; },
        set: function (value) {
          run.labelOrder = value;
          run.labelRunLength = value === 'blocked'
            ? Math.max(1, Math.round(H.num(run.trialsPerBlock, 1))) : 1;
        }
      }),
      App.slider({
        owner: owner, label: 'Same-condition run length', min: 1, max: 60, step: 1, unit: 'tr',
        hint: 'Blocked ordering only',
        get: function () { return H.num(run.labelRunLength, 1); },
        set: function (value) { run.labelRunLength = Math.max(1, Math.round(value)); },
        disabledWhen: function () { return run.labelOrder !== 'blocked'; }
      }),
      App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Optimise blocks and trials',
          'Search the block structure for this trial design\'s objective', function () {
            App.toast('Searching the structure grid…');
            setTimeout(function () {
              App.adopt(M.optimiseStructure(App.state, App.boot, run.id, 'auto'));
              App.toast('Run structure optimised', 'ok');
            }, 30);
          })
      ])
    ]));

    /* --- readouts ------------------------------------------------------ */
    var readout = App.h('div', { class: 'readout' });
    var assembly = App.h('div', {});
    App.registerView(function (report) {
      var record = report.runs.filter(function (item) { return item.id === run.id; })[0];
      App.clear(readout);
      App.clear(assembly);
      if (!record || record.missing) return;
      var d = record.derived;
      [
        ['Trial', H.fmtRange(d.trialMin, d.trialMax)],
        ['Block', H.fmtRange(d.blockMin, d.blockMax)],
        ['Run', H.fmtRange(d.runMin, d.runMax)],
        ['Trials per run', H.fmtNumber(d.trialsPerRun)],
        ['Primary events per run', H.fmtNumber(d.unitsPerRun)],
        ['Volumes per run', H.fmtNumber(d.volumesPerRun)],
        ['Seconds per trial', d.secondsPerTrial + ' s'],
        ['Trials per hour', H.fmtNumber(d.trialsPerHour, 1)],
        ['Card', App.escapeHtml(record.protocolLabel)],
        ['TR / TE', H.round(record.trMs, 0) + ' / ' + H.round(record.teMs, 1) + ' ms'],
        ['Data per run', record.dataVolume.mbPerRun + ' MB'],
        ['Scheduled runs', H.fmtNumber(d.totalRuns)]
      ].forEach(function (pair) {
        readout.appendChild(App.readoutCell(pair[0], pair[1]));
      });

      assembly.appendChild(App.dataTable(
        [{ label: 'Level' }, { label: 'Composition' }, { label: 'Trials', num: true },
          { label: 'Duration', num: true }],
        [
          ['Trial', record.trialName, { text: '1', num: true },
            { text: H.fmtRange(d.trialMin, d.trialMax), num: true }],
          ['Block', d.trialsPerRun / record.structure.blocksPerRun + ' trials'
            + (record.structure.interTrialGap > 0
              ? ' with ' + record.structure.interTrialGap + ' s gaps' : ''),
            { text: H.fmtNumber(record.structure.trialsPerBlock), num: true },
            { text: H.fmtRange(d.blockMin, d.blockMax), num: true }],
          ['Run', record.structure.dummyVolumes + ' dummies + '
            + record.structure.leadIn + ' s lead-in + '
            + record.structure.blocksPerRun + ' blocks + '
            + record.structure.leadOut + ' s lead-out',
            { text: H.fmtNumber(d.trialsPerRun), num: true },
            { text: H.fmtRange(d.runMin, d.runMax), num: true }]
        ],
        { caption: record.name + ' - run assembly' }
      ));
      if (record.usedBy.length) {
        assembly.appendChild(App.h('div', {
          class: 'notice mt', text: 'Used by: ' + record.usedBy.join(', ') + '.'
        }));
      } else {
        assembly.appendChild(App.h('div', {
          class: 'notice mt',
          text: 'Not in any session yet. Add it to a session in the Sessions panel.'
        }));
      }
    }, owner);

    host.appendChild(App.card('Solved run', 'What this run design costs', [readout, assembly]));
    host.appendChild(buildEfficiencyCard(run, owner));
  }

  function buildEfficiencyCard(run, owner) {
    var plot = App.regressorPlot();
    var readout = App.h('div', { class: 'readout' });
    var caption = App.h('div', { class: 'plot-caption' });

    App.registerView(function (report) {
      var record = report.runs.filter(function (item) { return item.id === run.id; })[0];
      App.clear(readout);
      if (!record || record.missing || !record.efficiency) {
        caption.textContent = '';
        return;
      }
      var trial = M.trialById(App.state, run.trial);
      var conditions = (trial && trial.conditions) || {};
      var ctx = M.protocolContext(App.boot, run.protocol);
      var geometry = M.runGeometry(run, trial, ctx.trSeconds);
      var series = global.PlannerEfficiency.evaluate(
        M.runDesign(App.state, run), ctx.trSeconds, geometry, { series: true, singleTrial: false }
      );
      plot.render(series, {
        stimulus: 'Stimulus',
        a: conditions.a || 'Condition A',
        b: conditions.b || 'Condition B'
      });

      var e = record.efficiency;
      [
        ['Duty cycle', H.round(e.sustainPct, 1) + ' %'],
        ['Stacking gain', H.round(e.saturationIndex, 2) + ' x'],
        ['Single-trial efficiency', H.round(e.singleTrialEff, 3)],
        ['Carryover', H.round(e.carryoverPct, 1) + ' %'],
        ['Stimulus bleed', H.round(e.stimulusBleedPct, 1) + ' %'],
        [(conditions.a || 'A') + ' vs ' + (conditions.b || 'B'), H.round(e.effAvsB, 3)],
        ['Response vs baseline', H.round(e.effResponseVsBaseline, 3)],
        ['Stimulus vs response', H.round(e.effStimulusVsResponse, 3)],
        ['Stimulus / response r', H.round(e.corrStimulusResponse, 3)],
        ['Max VIF', H.round(e.maxVif, 2)],
        ['Objective score', H.round(e.objectiveScore, 4)],
        ['Simulated volumes', H.fmtNumber(e.volumes)]
      ].forEach(function (pair) {
        readout.appendChild(App.readoutCell(pair[0], pair[1]));
      });

      caption.textContent = 'Simulated at TR ' + H.round(record.trMs / 1000, 2) + ' s over '
        + H.fmtNumber(e.volumes) + ' volumes. Duty cycle high means the response never '
        + 'settles; near zero means full recovery between trials.';
    }, owner);

    return App.card('Design efficiency', 'HRF-convolved regressors and what they buy', [
      plot.node, caption, readout
    ]);
  }

  /* ----------------------------------------------------------- sessions */

  function buildSessions() {
    return libraryPanel({
      id: 'sessions',
      noun: 'session',
      title: 'Sessions',
      blurb: 'A named session: the setup block, the structural and reference scans, and the '
        + 'runs in the order the console runs them. Experiments combine these.',
      listTitle: 'Session library',
      items: function (state) { return state.sessions; },
      add: function (state) {
        return M.Library.addSession(state, (state.runs[0] || {}).id);
      },
      duplicate: function (state, id) { return M.Library.duplicateSession(state, id); },
      remove: function (state, id) { return M.Library.removeSession(state, id); },
      meta: function (session) {
        var record = App.report && App.report.sessions.filter(function (item) {
          return item.id === session.id;
        })[0];
        if (!record || record.missing) return ['not solved yet'];
        return [
          record.runs + ' runs  ·  ' + record.meanMinutes + ' min (longest '
            + record.maxMinutes + ')',
          H.fmtNumber(record.trials) + ' trials  ·  ' + record.gb + ' GB'
            + (record.scheduled ? '  ·  ' + H.fmtNumber(record.scheduled) + ' scheduled' : '')
        ];
      },
      buildEditor: buildSessionEditor
    });
  }

  function buildSessionEditor(session, host, owner) {
    host.appendChild(identityCard(session, owner));

    host.appendChild(App.card('Setup and breaks', 'Time in the session that is not a run', [
      App.slider({
        owner: owner, label: 'Safety screening and consent', min: 0, max: 40, step: 1, unit: 'min',
        get: function () { return H.num(session.screeningMinutes); },
        set: function (value) { session.screeningMinutes = value; }
      }),
      App.slider({
        owner: owner, label: 'Positioning and coil placement', min: 0, max: 40, step: 1, unit: 'min',
        get: function () { return H.num(session.positioningMinutes); },
        set: function (value) { session.positioningMinutes = value; }
      }),
      App.slider({
        owner: owner, label: 'Task practice', min: 0, max: 40, step: 1, unit: 'min',
        get: function () { return H.num(session.practiceMinutes); },
        set: function (value) { session.practiceMinutes = value; }
      }),
      App.slider({
        owner: owner, label: 'Break between runs', min: 0, max: 30, step: 0.5, decimals: 1,
        unit: 'min',
        get: function () { return H.num(session.breakMinutes); },
        set: function (value) { session.breakMinutes = value; }
      })
    ]));

    /* --- structurals --------------------------------------------------- */
    var structuralHost = App.h('div', {});
    function renderStructurals() {
      App.clear(structuralHost);
      var rows = session.structurals.map(function (entry, index) {
        var ctx = M.protocolContext(App.boot, entry.protocol);
        var minutes = (ctx.durationSeconds / 60) * Math.max(0, H.num(entry.count, 1));
        return {
          entry: entry, ctx: ctx, minutes: minutes, index: index,
          cells: [
            { node: (function () {
              var box = App.h('input', { type: 'checkbox' });
              box.checked = !!entry.enabled;
              box.addEventListener('change', function () {
                entry.enabled = box.checked;
                App.refresh();
                renderStructurals();
              });
              return box;
            }()), copy: entry.enabled ? 'yes' : 'no' },
            { node: selectInput(
              function () { return entry.protocol; },
              function (value) { entry.protocol = value; renderStructurals(); },
              cardOptions()
            ), copy: ctx.label },
            { node: numberInput(
              function () { return Math.max(0, Math.round(H.num(entry.count, 1))); },
              function (value) { entry.count = Math.max(0, Math.round(value)); renderStructurals(); },
              { min: 0, step: 1 }
            ), num: true, copy: String(entry.count) },
            { text: H.round(ctx.durationSeconds / 60, 2) + ' min', num: true },
            { text: entry.enabled ? H.round(minutes, 2) + ' min' : '—', num: true },
            { node: App.iconButton('×', 'Remove this row', function () {
              session.structurals.splice(index, 1);
              renderStructurals();
              App.refresh();
            }, 'danger'), copy: '' }
          ]
        };
      });

      var total = H.sum(rows, function (row) {
        return row.entry.enabled ? row.minutes : 0;
      });

      var table = App.dataTable(
        [{ label: 'On' }, { label: 'Card' }, { label: 'Count', num: true },
          { label: 'Each', num: true }, { label: 'Minutes', num: true }, { label: '' }],
        rows.map(function (row) {
          return row.cells.map(function (cell) {
            return { text: cell.text, num: cell.num, copy: cell.copy };
          });
        }).concat([{
          className: 'total',
          cells: ['Total', '', '', '', { text: H.round(total, 2) + ' min', num: true }, '']
        }]),
        { caption: session.name + ' - structurals' }
      );
      var bodyRows = table.querySelectorAll('tbody tr');
      rows.forEach(function (row, rowIndex) {
        var tr = bodyRows[rowIndex];
        if (!tr) return;
        row.cells.forEach(function (cell, cellIndex) {
          if (!cell.node) return;
          var td = tr.children[cellIndex];
          App.clear(td);
          td.appendChild(cell.node);
        });
      });
      structuralHost.appendChild(table);

      var picker = App.h('select', {});
      cardOptions().forEach(function (option) {
        picker.appendChild(App.h('option', { value: option.value, text: option.label }));
      });
      structuralHost.appendChild(App.h('div', { class: 'split-inline mt' }, [
        picker,
        App.iconButton('Add card to the setup block', 'Append a structural or reference scan',
          function () {
            if (!picker.value) return;
            session.structurals.push({ protocol: picker.value, enabled: true, count: 1 });
            renderStructurals();
            App.refresh();
          })
      ]));
    }
    renderStructurals();

    host.appendChild(App.card('Structural and reference scans',
      'What runs before the functional runs', [structuralHost]));

    /* --- runs in the session ------------------------------------------- */
    var runHost = App.h('div', {});
    function renderRuns() {
      App.clear(runHost);
      if (!App.state.runs.length) {
        runHost.appendChild(App.h('div', {
          class: 'notice', text: 'No run designs exist yet. Build one in the Runs panel first.'
        }));
        return;
      }
      var rows = session.items.map(function (item, index) {
        var run = M.runById(App.state, item.run);
        var trial = run ? M.trialById(App.state, run.trial) : null;
        var ctx = run ? M.protocolContext(App.boot, run.protocol) : null;
        var geometry = run ? M.runGeometry(run, trial, ctx.trSeconds) : null;
        var count = Math.max(0, Math.round(H.num(item.count, 1)));
        return {
          index: index,
          cells: [
            { node: selectInput(
              function () { return item.run; },
              function (value) { item.run = value; renderRuns(); },
              App.state.runs.map(function (entry) {
                return { value: entry.id, label: entry.name };
              })
            ), copy: run ? run.name : '' },
            { text: trial ? trial.name : '—' },
            { text: ctx ? ctx.label : '—' },
            { node: numberInput(
              function () { return count; },
              function (value) { item.count = Math.max(0, Math.round(value)); renderRuns(); },
              { min: 0, step: 1 }
            ), num: true, copy: String(count) },
            { text: geometry ? H.round(geometry.run.mean / 60, 2) + ' min' : '—', num: true },
            { text: geometry ? H.round(count * geometry.run.mean / 60, 2) + ' min' : '—', num: true },
            { text: geometry ? H.fmtNumber(count * geometry.trialsPerRun) : '—', num: true },
            { node: App.h('div', { class: 'btn-row tight' }, [
              App.iconButton('↑', 'Run earlier in the session', function () {
                if (index === 0) return;
                var moved = session.items.splice(index, 1)[0];
                session.items.splice(index - 1, 0, moved);
                renderRuns();
                App.refresh();
              }),
              App.iconButton('↓', 'Run later in the session', function () {
                if (index >= session.items.length - 1) return;
                var moved = session.items.splice(index, 1)[0];
                session.items.splice(index + 1, 0, moved);
                renderRuns();
                App.refresh();
              }),
              App.iconButton('×', 'Remove this run from the session', function () {
                session.items.splice(index, 1);
                renderRuns();
                App.refresh();
              }, 'danger')
            ]), copy: '' }
          ]
        };
      });

      var table = App.dataTable(
        [{ label: 'Run design' }, { label: 'Trial design' }, { label: 'Card' },
          { label: 'Count', num: true }, { label: 'Each', num: true },
          { label: 'Minutes', num: true }, { label: 'Trials', num: true }, { label: '' }],
        rows.length ? rows.map(function (row) {
          return row.cells.map(function (cell) {
            return { text: cell.text, num: cell.num, copy: cell.copy };
          });
        }) : [['No runs in this session yet.', '', '', '', '', '', '', '']],
        { caption: session.name + ' - runs' }
      );
      var bodyRows = table.querySelectorAll('tbody tr');
      rows.forEach(function (row, rowIndex) {
        var tr = bodyRows[rowIndex];
        if (!tr) return;
        row.cells.forEach(function (cell, cellIndex) {
          if (!cell.node) return;
          var td = tr.children[cellIndex];
          App.clear(td);
          td.appendChild(cell.node);
        });
      });
      runHost.appendChild(table);

      var picker = App.h('select', {});
      App.state.runs.forEach(function (entry) {
        picker.appendChild(App.h('option', { value: entry.id, text: entry.name }));
      });
      runHost.appendChild(App.h('div', { class: 'split-inline mt' }, [
        picker,
        App.iconButton('Add run to this session', 'Append a run design', function () {
          if (!picker.value) return;
          session.items.push({ run: picker.value, count: 1 });
          renderRuns();
          App.refresh();
        })
      ]));
    }
    renderRuns();

    host.appendChild(App.card('Runs in this session',
      'In the order the console runs them', [runHost]));

    /* --- solved session ------------------------------------------------ */
    var readout = App.h('div', { class: 'readout' });
    var timeline = App.h('div', {});
    App.registerView(function (report) {
      var record = report.sessions.filter(function (item) { return item.id === session.id; })[0];
      App.clear(readout);
      App.clear(timeline);
      if (!record || record.missing) return;
      [
        ['Runs', String(record.runs)],
        ['Setup block', record.setupMinutes + ' min'],
        ['Structurals', record.structuralMinutes + ' min'],
        ['Functional', record.functionalMinutes + ' min'],
        ['Shortest session', record.minMinutes + ' min'],
        ['Expected session', record.meanMinutes + ' min'],
        ['Longest session', record.maxMinutes + ' min'],
        ['Trials', H.fmtNumber(record.trials)],
        ['Primary events', H.fmtNumber(record.units)],
        ['Data per session', record.gb + ' GB'],
        ['Scheduled', H.fmtNumber(record.scheduled)],
        ['Used by', record.usedBy.length
          ? App.escapeHtml(record.usedBy.join(', ')) : '—']
      ].forEach(function (pair) {
        readout.appendChild(App.readoutCell(pair[0], pair[1]));
      });

      timeline.appendChild(App.dataTable(
        [{ label: '#', num: true }, { label: 'Item' }, { label: 'Card' },
          { label: 'Minutes', num: true }, { label: 'Cumulative', num: true },
          { label: 'Category' }],
        record.timeline.map(function (row) {
          return [
            { text: row.order, num: true },
            row.item,
            row.protocolLabel || '—',
            { text: row.minutes, num: true },
            { text: row.cumulative, num: true },
            row.category
          ];
        }),
        { caption: record.name + ' - timeline' }
      ));
    }, owner);

    host.appendChild(App.card('Solved session', 'Console order, start to finish',
      [readout, timeline]));
  }

  /* -------------------------------------------------------- experiments */

  function buildExperiments() {
    return libraryPanel({
      id: 'experiments',
      noun: 'experiment',
      title: 'Experiments',
      blurb: 'Sessions combined into an experiment, and experiments combined into one '
        + 'budget. Each experiment names its own unit, sets its own goal, and takes a '
        + 'share of the scanner time.',
      listTitle: 'Experiments',
      items: function (state) { return state.experiments; },
      colour: function (item) { return App.experimentColour(item.id); },
      add: function (state) {
        return M.Library.addExperiment(state, (state.sessions[0] || {}).id);
      },
      duplicate: function (state, id) { return M.Library.duplicateExperiment(state, id); },
      remove: function (state, id) { return M.Library.removeExperiment(state, id); },
      meta: function (experiment) {
        var record = App.report && App.report.experiments.filter(function (item) {
          return item.id === experiment.id;
        })[0];
        if (!record) return [experiment.enabled ? 'not scheduled' : 'disabled'];
        var d = record.derived;
        return [
          H.fmtNumber(d.units) + ' ' + record.unit.plural + '  ·  ' + d.sessions + ' sessions',
          d.totalHours + ' h  ·  ' + d.sharePct + '% of the budget'
        ];
      },
      buildEditor: buildExperimentEditor
    });
  }

  function buildExperimentEditor(experiment, host, owner) {
    host.appendChild(identityCard(experiment, owner, [
      App.field({
        owner: owner, label: 'Short name', stack: true,
        hint: 'Used on the masthead chip',
        get: function () { return experiment.short || ''; },
        set: function (value) { experiment.short = value; }
      }),
      App.checkbox({
        owner: owner, label: 'Include this experiment in the budget',
        get: function () { return experiment.enabled !== false; },
        set: function (value, state) {
          experiment.enabled = value;
          M.normaliseAllocation(state, null);
        }
      })
    ]));

    host.appendChild(App.card('Unit', 'What this experiment counts', [
      App.h('div', {
        class: 'notice',
        text: 'Goals, floors and readouts for this experiment are denominated in whatever '
          + 'you name here. Trials minus the trial design\'s control share give the count.'
      }),
      App.field({
        owner: owner, label: 'Singular', stack: true, placeholder: 'trial',
        get: function () { return M.unitOf(experiment).noun; },
        set: function (value) {
          if (!experiment.unit) experiment.unit = {};
          experiment.unit.noun = value;
          if (!experiment.unit.plural) experiment.unit.plural = value + 's';
        }
      }),
      App.field({
        owner: owner, label: 'Plural', stack: true, placeholder: 'trials',
        get: function () { return M.unitOf(experiment).plural; },
        set: function (value) {
          if (!experiment.unit) experiment.unit = {};
          experiment.unit.plural = value;
        }
      }),
      App.field({
        owner: owner, label: 'Slider abbreviation', stack: true, placeholder: 'tr',
        get: function () { return M.unitOf(experiment).short; },
        set: function (value) {
          if (!experiment.unit) experiment.unit = {};
          experiment.unit.short = value;
        }
      })
    ]));

    host.appendChild(App.card('Goal and share', 'What it is after, and what it gets', [
      App.slider({
        owner: owner,
        label: 'Goal',
        min: 0, max: 40000, step: 25, gold: true,
        dynamicLabel: function () {
          return M.unitOf(experiment).plural.replace(/^./, function (char) {
            return char.toUpperCase();
          }) + ' to collect';
        },
        dynamicUnit: function () { return M.unitOf(experiment).short; },
        get: function () { return H.num(experiment.targetUnits); },
        set: function (value) { experiment.targetUnits = Math.max(0, Math.round(value)); }
      }),
      App.slider({
        owner: owner, label: 'Share of scanner time', min: 0, max: 100, step: 0.5,
        decimals: 1, unit: '%',
        get: function () { return H.num(experiment.requestedPct); },
        set: function (value, state) {
          experiment.requestedPct = H.clamp(value, 0, 100);
          M.normaliseAllocation(state, experiment.id);
        },
        disabledWhen: function () { return !!experiment.locked; }
      }),
      App.checkbox({
        owner: owner, label: 'Lock this share while the others redistribute',
        get: function () { return !!experiment.locked; },
        set: function (value) { experiment.locked = value; }
      }),
      App.slider({
        owner: owner, label: 'Sessions (session-count mode)', min: 0, max: 400, step: 1,
        unit: 'sess',
        get: function () { return H.num(experiment.manualSessions); },
        set: function (value) { experiment.manualSessions = Math.max(0, Math.round(value)); },
        disabledWhen: function (state) {
          return state.budget.solveMode !== 'manual' || !!experiment.lockPlan;
        }
      }),
      App.checkbox({
        owner: owner,
        label: 'Run the plan exactly as written, whatever the budget says',
        hint: 'The counts below become literal instead of a mix the solver scales',
        get: function () { return !!experiment.lockPlan; },
        set: function (value) { experiment.lockPlan = value; }
      })
    ]));

    /* --- session plan -------------------------------------------------- */
    var planHost = App.h('div', {});
    function renderPlan() {
      App.clear(planHost);
      if (!App.state.sessions.length) {
        planHost.appendChild(App.h('div', {
          class: 'notice', text: 'No sessions exist yet. Build one in the Sessions panel first.'
        }));
        return;
      }
      var record = App.report && App.report.experiments.filter(function (item) {
        return item.id === experiment.id;
      })[0];

      var rows = experiment.plan.map(function (entry, index) {
        var session = M.sessionById(App.state, entry.session);
        var solvedRow = record ? record.plan.filter(function (row) {
          return row.sessionId === entry.session;
        })[0] : null;
        return {
          index: index,
          cells: [
            { node: selectInput(
              function () { return entry.session; },
              function (value) { entry.session = value; renderPlan(); },
              App.state.sessions.map(function (item) {
                return { value: item.id, label: item.name };
              })
            ), copy: session ? session.name : '' },
            { node: numberInput(
              function () { return Math.max(0, Math.round(H.num(entry.count, 1))); },
              function (value) { entry.count = Math.max(0, Math.round(value)); renderPlan(); },
              { min: 0, step: 1 }
            ), num: true, copy: String(entry.count) },
            { text: solvedRow ? H.fmtNumber(solvedRow.sessions) : '—', num: true },
            { text: solvedRow ? solvedRow.minutesEach + ' min' : '—', num: true },
            { text: solvedRow ? H.fmtNumber(solvedRow.unitsEach) : '—', num: true },
            { text: solvedRow ? H.fmtNumber(solvedRow.units) : '—', num: true },
            { text: solvedRow ? solvedRow.minutes + ' min' : '—', num: true },
            { node: App.h('div', { class: 'btn-row tight' }, [
              App.iconButton('↑', 'Move up', function () {
                if (index === 0) return;
                var moved = experiment.plan.splice(index, 1)[0];
                experiment.plan.splice(index - 1, 0, moved);
                renderPlan();
                App.refresh();
              }),
              App.iconButton('↓', 'Move down', function () {
                if (index >= experiment.plan.length - 1) return;
                var moved = experiment.plan.splice(index, 1)[0];
                experiment.plan.splice(index + 1, 0, moved);
                renderPlan();
                App.refresh();
              }),
              App.iconButton('×', 'Remove from the plan', function () {
                experiment.plan.splice(index, 1);
                renderPlan();
                App.refresh();
              }, 'danger')
            ]), copy: '' }
          ]
        };
      });

      var table = App.dataTable(
        [{ label: 'Session' }, { label: 'Asked for', num: true },
          { label: 'Scheduled', num: true }, { label: 'Minutes each', num: true },
          { label: M.unitOf(experiment).plural + ' each', num: true },
          { label: 'Total ' + M.unitOf(experiment).plural, num: true },
          { label: 'Total minutes', num: true }, { label: '' }],
        rows.length ? rows.map(function (row) {
          return row.cells.map(function (cell) {
            return { text: cell.text, num: cell.num, copy: cell.copy };
          });
        }) : [['No sessions in this plan yet.', '', '', '', '', '', '', '']],
        { caption: experiment.name + ' - session plan' }
      );
      var bodyRows = table.querySelectorAll('tbody tr');
      rows.forEach(function (row, rowIndex) {
        var tr = bodyRows[rowIndex];
        if (!tr) return;
        row.cells.forEach(function (cell, cellIndex) {
          if (!cell.node) return;
          var td = tr.children[cellIndex];
          App.clear(td);
          td.appendChild(cell.node);
        });
      });
      planHost.appendChild(table);

      planHost.appendChild(App.h('div', {
        class: 'notice mt',
        text: experiment.lockPlan
          ? 'The plan is locked, so "asked for" is what runs, whatever the budget says.'
          : 'The counts are a mix, not a total: the solver buys as many whole sessions as the '
            + 'budget or the goal allows and splits them in this ratio.'
      }));

      var picker = App.h('select', {});
      App.state.sessions.forEach(function (item) {
        picker.appendChild(App.h('option', { value: item.id, text: item.name }));
      });
      planHost.appendChild(App.h('div', { class: 'split-inline mt' }, [
        picker,
        App.iconButton('Add session to the plan', 'Append a session', function () {
          if (!picker.value) return;
          experiment.plan.push({ session: picker.value, count: 1 });
          renderPlan();
          App.refresh();
        })
      ]));
    }
    renderPlan();
    App.registerView(function () { renderPlan(); }, owner);

    host.appendChild(App.card('Session plan', 'Which sessions this experiment runs', [planHost]));

    /* --- solved experiment --------------------------------------------- */
    var readout = App.h('div', { class: 'readout' });
    var assembly = App.h('div', {});
    App.registerView(function (report) {
      var record = report.experiments.filter(function (item) {
        return item.id === experiment.id;
      })[0];
      App.clear(readout);
      App.clear(assembly);
      if (!record) {
        readout.appendChild(App.h('div', {
          class: 'notice',
          text: 'This experiment is switched off, so the budget skips it.'
        }));
        return;
      }
      var d = record.derived;
      [
        ['Sessions', H.fmtNumber(d.sessions)],
        ['Runs', H.fmtNumber(d.runs)],
        ['Trials', H.fmtNumber(d.trials)],
        [record.unit.plural, H.fmtNumber(d.units)],
        ['Control trials', H.fmtNumber(d.controlTrials)],
        ['Per session', H.fmtNumber(d.unitsPerSession, 1)],
        ['Session length', d.sessionMeanMinutes + ' min'],
        ['Longest session', d.sessionMaxMinutes + ' min'],
        ['Functional hours', d.functionalHours + ' h'],
        ['Overhead hours', d.overheadHours + ' h'],
        ['Total hours', d.totalHours + ' h'],
        ['Share of budget', d.sharePct + ' %'],
        ['Goal', d.targetUnits ? H.fmtNumber(d.targetUnits) + ' (' + d.targetProgressPct + '%)' : '—'],
        ['Data volume', d.gbTotal + ' GB']
      ].forEach(function (pair) {
        readout.appendChild(App.readoutCell(pair[0], pair[1]));
      });

      assembly.appendChild(App.dataTable(
        [{ label: 'Level' }, { label: 'Composition' }, { label: 'Trials', num: true },
          { label: 'Duration', num: true }],
        record.table.map(function (row) {
          return [row.level, row.sequence,
            { text: H.fmtNumber(row.count), num: true },
            { text: row.duration, num: true }];
        }),
        { caption: record.name + ' - assembly' }
      ));

      if (record.runs.length) {
        assembly.appendChild(App.dataTable(
          [{ label: 'Run design' }, { label: 'Trial design' }, { label: 'Card' },
            { label: 'Per session', num: true }, { label: 'Total runs', num: true },
            { label: 'Trials', num: true }, { label: record.unit.plural, num: true }],
          record.runs.map(function (row) {
            return [row.name, row.trialName, row.protocolLabel,
              { text: row.perSession, num: true },
              { text: H.fmtNumber(row.totalRuns), num: true },
              { text: H.fmtNumber(row.trials), num: true },
              { text: H.fmtNumber(row.units), num: true }];
          }),
          { caption: record.name + ' - runs recorded' }
        ));
      }
    }, owner);

    host.appendChild(App.card('Solved experiment', 'What the budget actually buys',
      [readout, assembly]));

    host.appendChild(App.figureCard('Assembly figure', '', function () {
      var record = App.report && App.report.experiments.filter(function (item) {
        return item.id === experiment.id;
      })[0];
      if (!record) {
        return { markup: '', empty: 'This experiment is switched off.' };
      }
      return {
        markup: App.assemblyFigureMarkup(record),
        caption: 'Trial, block, run, session and experiment, each drawn to scale on its own '
          + 'axis. Durations are means; jitter moves every level.',
        empty: 'Add a session with at least one run to draw the assembly figure.'
      };
    }, function () { return App.fileStem(experiment.name, 'assembly'); }, [], owner));
  }

  /* ------------------------------------------------------------ HRF model */

  function drawHrf(canvas, hrf) {
    var ratio = global.devicePixelRatio || 1;
    var width = canvas.parentNode.clientWidth || 640;
    var height = 240;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.height = height + 'px';
    var pen = canvas.getContext('2d');
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    pen.fillStyle = '#ffffff';
    pen.fillRect(0, 0, width, height);

    var span = H.num(hrf.spanSeconds, 40);
    var padLeft = 42, padRight = 14, padTop = 16, padBottom = 24;
    var plotWidth = Math.max(10, width - padLeft - padRight);
    var plotHeight = Math.max(10, height - padTop - padBottom);

    var values = [];
    var peak = 0;
    for (var t = 0; t <= span; t += 0.1) {
      var v = global.PlannerEfficiency.canonicalHrf(t);
      values.push({ t: t, v: v });
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    if (!(peak > 0)) peak = 1;

    function xAt(time) { return padLeft + (time / span) * plotWidth; }
    function yAt(value) {
      return padTop + plotHeight * 0.72 - (value / peak) * plotHeight * 0.68;
    }

    pen.font = '9.5px "SF Mono", Menlo, monospace';
    [1, 0.5, 0, -0.25].forEach(function (level) {
      var y = yAt(level * peak);
      pen.strokeStyle = level === 0 ? '#b9c0b4' : '#EFEEE9';
      pen.beginPath();
      pen.moveTo(padLeft, y);
      pen.lineTo(padLeft + plotWidth, y);
      pen.stroke();
      pen.fillStyle = '#6b767b';
      pen.fillText(String(level), 6, y + 3);
    });

    var step = span > 30 ? 5 : 2;
    pen.textAlign = 'center';
    for (var tick = 0; tick <= span + 0.001; tick += step) {
      pen.fillStyle = '#6b767b';
      pen.fillText(H.round(tick, 0) + 's', xAt(tick), height - 8);
    }
    pen.textAlign = 'left';

    pen.strokeStyle = '#00482B';
    pen.lineWidth = 2;
    pen.beginPath();
    values.forEach(function (point, index) {
      var px = xAt(point.t);
      var py = yAt(point.v);
      if (index === 0) pen.moveTo(px, py); else pen.lineTo(px, py);
    });
    pen.stroke();

    /* Mark the peak and the undershoot the parameters put there. */
    [[H.num(hrf.peakDelay, 6), '#CBA052', 'peak'],
      [H.num(hrf.undershootDelay, 16), '#719949', 'undershoot']].forEach(function (mark) {
      var x = xAt(mark[0]);
      if (mark[0] > span) return;
      pen.strokeStyle = mark[1];
      pen.setLineDash([3, 3]);
      pen.beginPath();
      pen.moveTo(x, padTop);
      pen.lineTo(x, padTop + plotHeight);
      pen.stroke();
      pen.setLineDash([]);
      pen.fillStyle = mark[1];
      pen.fillText(mark[2] + ' ' + H.round(mark[0], 1) + 's', x + 4, padTop + 10);
    });
  }

  function buildHrf() {
    var owner = 'hrf';
    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'HRF model and objectives' }),
      App.h('p', {
        text: 'The haemodynamic response every timing decision is solved against, and what '
          + 'the planner treats as separated. Change the definition here and every trial '
          + 'design re-solves against it.'
      })
    ]));

    var canvas = App.h('canvas', {});
    var hrfCaption = App.h('div', { class: 'plot-caption' });

    var shapeCard = App.card('Response shape', 'A double gamma, with its parameters exposed', [
      App.h('div', { class: 'plot-wrap' }, [canvas]),
      hrfCaption,
      App.slider({
        owner: owner, label: 'Peak delay', path: 'hrf.peakDelay',
        min: 2, max: 14, step: 0.1, decimals: 1, unit: 's'
      }),
      App.slider({
        owner: owner, label: 'Peak dispersion', path: 'hrf.peakDispersion',
        min: 0.3, max: 3, step: 0.05, decimals: 2, unit: ''
      }),
      App.slider({
        owner: owner, label: 'Undershoot delay', path: 'hrf.undershootDelay',
        min: 6, max: 34, step: 0.5, decimals: 1, unit: 's'
      }),
      App.slider({
        owner: owner, label: 'Undershoot dispersion', path: 'hrf.undershootDispersion',
        min: 0.3, max: 3, step: 0.05, decimals: 2, unit: ''
      }),
      App.slider({
        owner: owner, label: 'Peak to undershoot ratio', path: 'hrf.undershootRatio',
        min: 1, max: 24, step: 0.5, decimals: 1, unit: ''
      }),
      App.slider({
        owner: owner, label: 'Evaluate the response over', path: 'hrf.spanSeconds',
        min: 12, max: 120, step: 1, unit: 's',
        hint: 'How far out the response is treated as non-zero'
      }),
      App.slider({
        owner: owner, label: 'Read residuals this far after onset', path: 'hrf.readLagSeconds',
        min: 0, max: 20, step: 0.5, decimals: 1, unit: 's',
        hint: 'Where an earlier event\'s leftover signal is measured'
      }),
      App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Reset to the canonical response',
          'SPM double gamma: peak 6 s, undershoot 16 s, ratio 6', function () {
            App.state.hrf = Object.assign(M.defaultHrf(), {
              objectives: App.state.hrf.objectives
            });
            App.refresh();
            App.toast('Canonical HRF restored', 'ok');
          })
      ])
    ]);

    /* --- objective definitions ----------------------------------------- */
    var objectiveHost = App.h('div', {});
    function renderObjectives() {
      /* Both registries have to be cleared: this runs on every refresh, and a
       * view left behind would be re-registered for ever. */
      App.dropControls('hrf-objectives');
      App.dropViews('hrf-objectives');
      App.clear(objectiveHost);
      M.OBJECTIVES.forEach(function (base) {
        var stored = App.state.hrf.objectives[base.id];
        if (!stored) {
          stored = {
            label: base.label, blurb: base.blurb,
            tolerancePct: base.tolerancePct, separationSeconds: 0
          };
          App.state.hrf.objectives[base.id] = stored;
        }
        var readout = App.h('div', { class: 'readout' });

        objectiveHost.appendChild(App.card(base.label, base.id, [
          App.field({
            owner: 'hrf-objectives', label: 'Name shown in the planner', stack: true,
            get: function () { return stored.label; },
            set: function (value) { stored.label = value || base.label; }
          }),
          App.field({
            owner: 'hrf-objectives', label: 'Description', stack: true,
            type: 'textarea', rows: 2,
            get: function () { return stored.blurb; },
            set: function (value) { stored.blurb = value; }
          }),
          App.slider({
            owner: 'hrf-objectives', label: 'Residual tolerance',
            min: 0.25, max: 90, step: 0.25, decimals: 2, unit: '%',
            hint: 'A response under this fraction of its own peak counts as gone',
            get: function () { return H.num(stored.tolerancePct, base.tolerancePct); },
            set: function (value) { stored.tolerancePct = value; },
            onChange: renderObjectives,
            disabledWhen: function () { return H.num(stored.separationSeconds) > 0; }
          }),
          App.slider({
            owner: 'hrf-objectives', label: 'Or pin the recovery duration',
            min: 0, max: 90, step: 0.5, decimals: 1, unit: 's', gold: true,
            hint: 'Zero means solve it from the tolerance instead',
            get: function () { return H.num(stored.separationSeconds); },
            set: function (value) { stored.separationSeconds = Math.max(0, value); },
            onChange: renderObjectives
          }),
          readout
        ]));

        /* What this definition costs, for a typical 3 s and 4 s event. */
        App.registerView(function () {
          App.clear(readout);
          var definition = M.objectiveDef(App.state, base.id);
          var tolerance = definition.tolerancePct / 100;
          function span(duration) {
            if (definition.separationSeconds > 0) return definition.separationSeconds;
            return global.PlannerEfficiency.decayTime(duration, tolerance);
          }
          readout.appendChild(App.readoutCell('Definition in force',
            definition.separationSeconds > 0
              ? 'pinned at ' + definition.separationSeconds + ' s'
              : 'residual under ' + H.round(definition.tolerancePct, 2) + ' %'));
          readout.appendChild(App.readoutCell('A 3 s event is separated after',
            H.round(span(3), 1) + ' s'));
          readout.appendChild(App.readoutCell('A 4 s event is separated after',
            H.round(span(4), 1) + ' s'));
          readout.appendChild(App.readoutCell('Residual at 10 s',
            H.round(global.PlannerEfficiency.residualAt(3, 10) * 100, 2) + ' %'));
          var users = (App.state.trials || []).filter(function (trial) {
            return trial.objective === base.id;
          }).map(function (trial) { return trial.name; });
          readout.appendChild(App.readoutCell('Trial designs using it',
            users.length ? App.escapeHtml(users.join(', ')) : '—'));
        }, 'hrf-objectives');
      });
      App.syncOwner('hrf-objectives');
    }
    renderObjectives();

    /* --- decay table ---------------------------------------------------- */
    var decayHost = App.h('div', {});
    App.registerView(function () {
      App.clear(decayHost);
      var durations = [1, 2, 3, 4, 6, 8, 12];
      var tolerances = [1, 4, 10, 25, 45];
      decayHost.appendChild(App.dataTable(
        [{ label: 'Event duration', num: true }].concat(tolerances.map(function (value) {
          return { label: value + ' % residual', num: true };
        })),
        durations.map(function (duration) {
          return [{ text: duration + ' s', num: true }].concat(tolerances.map(function (value) {
            return {
              text: H.round(global.PlannerEfficiency.decayTime(duration, value / 100), 1) + ' s',
              num: true
            };
          }));
        }),
        { caption: 'Seconds until an event is separated, by residual tolerance' }
      ));
    }, owner);

    App.registerView(function () {
      drawHrf(canvas, App.state.hrf);
      var hrf = App.state.hrf;
      hrfCaption.textContent = 'Peak at ' + H.round(H.num(hrf.peakDelay, 6), 1)
        + ' s, undershoot at ' + H.round(H.num(hrf.undershootDelay, 16), 1)
        + ' s, ratio ' + H.round(H.num(hrf.undershootRatio, 6), 1)
        + ', evaluated over ' + H.round(H.num(hrf.spanSeconds, 40), 0) + ' s.';
      renderObjectives();
    }, owner);

    panel.appendChild(App.h('div', { class: 'grid split' }, [
      App.h('div', {}, [shapeCard]),
      objectiveHost
    ]));
    panel.appendChild(App.card('How long recovery takes',
      'Read straight off the response, for any tolerance', [decayHost]));
    return panel;
  }

  /* ---------------------------------------------------------------- init */

  function ready() {
    App = global.PlannerApp;
    M = global.PlannerModel;
    H = M.helpers;
  }

  global.PlannerLibrary = {
    buildTrials: function () { ready(); return buildTrials(); },
    buildRuns: function () { ready(); return buildRuns(); },
    buildSessions: function () { ready(); return buildSessions(); },
    buildExperiments: function () { ready(); return buildExperiments(); },
    buildHrf: function () { ready(); return buildHrf(); }
  };
}(window));
