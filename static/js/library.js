/* The design library: trial designs, run designs, sessions and experiments.
 *
 * Every level is the same shape - a named list on the left, an editor for the
 * selected item on the right - so adding, duplicating, renaming, reordering
 * and deleting work identically wherever you are in the hierarchy.
 *
 * A session goes one step further: its contents are a single sortable list, so
 * setup, structurals, runs and breaks are all reorderable against each other
 * rather than living in fixed sections. */

(function (global) {
  'use strict';

  var App, M, H;

  /* --------------------------------------------------------------- shell */

  /* One library panel.  `spec` says what the list holds and how to draw the
   * editor for whichever item is selected. */
  function libraryPanel(spec) {
    var owner = spec.id + '-editor';
    /* Held on App rather than here: adopting a new state rebuilds every panel,
     * and the editor should come back on the item it was showing. */
    if (!App.selection) App.selection = {};
    if (!App.selection[spec.id]) App.selection[spec.id] = { selected: null };
    var local = App.selection[spec.id];
    var listHost = App.h('div', { class: 'proto-list' });
    var editorHost = App.h('div', {});

    function items() { return spec.items(App.state) || []; }

    /* The arguments that name this item to its level's actions. */
    function itemArgs(item, extra) {
      var args = Object.assign({}, extra || {});
      args[spec.kind] = item.id;
      return args;
    }

    function current() {
      var list = items();
      var found = list.filter(function (item) { return item.id === local.selected; })[0];
      if (!found) found = list[0] || null;
      local.selected = found ? found.id : null;
      return found;
    }

    /* A person picking an item: the address follows (ui.js), so it can be
     * shared as /<panel>/<id>. */
    function select(id) {
      local.selected = id;
      renderList();
      renderEditor();
      App.address('push');
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
        listHost.appendChild(App.view(button));

        var tools = App.h('div', { class: 'proto-tools' }, [
          App.iconButton('↑', 'Move up', function () {
            if (index > 0) App.act(spec.kind + '.move', itemArgs(item, { delta: -1 }));
            renderList();
          }),
          App.iconButton('↓', 'Move down', function () {
            if (index < list.length - 1) App.act(spec.kind + '.move', itemArgs(item, { delta: 1 }));
            renderList();
          }),
          App.iconButton('Duplicate', 'Copy this ' + spec.noun, function () {
            var copy = App.act(spec.kind + '.duplicate', itemArgs(item));
            if (copy) {
              select(copy.id);
              App.toast('Duplicated as "' + copy.name + '"', 'ok');
            }
          }),
          App.iconButton('Delete', 'Remove this ' + spec.noun, function () {
            if (!App.act(spec.kind + '.remove', itemArgs(item))) return;
            if (local.selected === item.id) local.selected = null;
            current();          // falls back to the first, so the list can mark it
            renderList();
            renderEditor();
            App.address();
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
        var created = App.act(spec.kind + '.add');
        if (!created) return;
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
      kind: 'trial',
      noun: 'trial design',
      title: 'Trial designs',
      blurb: 'What one trial looks like, second by second. A trial design is a list of '
        + 'phases; run designs point at it, so editing here changes every run that uses it.',
      listTitle: 'Trial designs',
      items: function (state) { return state.trials; },
      meta: function (trial) {
        var timing = M.trialTiming(trial, M.representativeTr(App.state, App.boot, trial),
          M.jitterSettings(App.state));
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
        set: function (value) {
          if (App.write('trial.setObjective', { trial: trial.id, objective: value })) {
            App.toast('Adopted the timing this objective implies', 'ok');
          }
        }
      }),
      App.h('div', { class: 'notice', text: M.objectiveDef(App.state, trial.objective).blurb })
    ]));

    /* --- phases -------------------------------------------------------- */
    var phaseHost = App.h('div', {});

    /* A cell edit is phase.update, like any other caller; the input's own
     * commit refreshes afterwards. */
    function editPhase(index, fields) {
      App.write('phase.update', Object.assign({ trial: trial.id, phase: index }, fields));
    }

    /* The conditions this trial design can present, and the shape each one
     * draws.  With no control share only the primary condition ever comes
     * up, which is why a condition added and left at zero never appears on
     * screen however it is shaped. */
    function inPlay() {
      return M.conditionsInPlay(App.state, H.num(trial.controlPct));
    }

    /* What one `show` value actually puts on screen, named so the dropdown
     * and the strip below it can say the same thing. */
    function showLabel(show) {
      if (show === 'fixation') {
        var mark = M.screens(App.state).fixation;
        return mark ? 'The fixation mark  ' + mark
          : 'The fixation mark - set to nothing, so blank';
      }
      if (show === 'question') return 'The question';
      if (show === 'blank') return 'Nothing - a blank screen';
      if (show !== 'cue') return show;
      var shapes = inPlay().map(function (role) {
        return (role.shape || '(no shape)') + ' ' + role.name;
      });
      return shapes.length === 1
        ? 'The trial\'s condition cue  ' + shapes[0]
        : 'The trial\'s condition cue  (' + shapes.join(', ') + ')';
    }

    /* One line of what a participant sees, in order.  Everything above is a
     * setting; this is the consequence, which is the thing worth checking. */
    function renderScreen() {
      var strip = App.h('div', { class: 'screen-strip' });
      trial.phases.forEach(function (phase) {
        var show = M.phaseShow(phase);
        var glyph = show === 'fixation' ? (M.screens(App.state).fixation || '\u00b7')
          : show === 'question' ? 'Q?'
            : show === 'blank' ? '\u00b7'
              : (inPlay().map(function (r) { return r.shape || '?'; }).join('') || '?');
        strip.appendChild(App.h('span', { class: 'screen-step show-' + show, title:
          phase.name + ' \u2014 ' + showLabel(show) }, [
          App.h('b', { text: glyph }),
          App.h('i', { text: phase.name })
        ]));
      });
      return strip;
    }

    function renderPhases() {
      App.clear(phaseHost);
      var rows = trial.phases.map(function (phase, index) {
        return [
          { text: String(index + 1), num: true },
          { html: '', node: textInput(
            function () { return phase.name; },
            function (value) { editPhase(index, { name: String(value || '').trim() || 'Phase' }); }
          ), copy: phase.name },
          { node: selectInput(
            function () { return M.normaliseRole(phase.role); },
            function (value) { editPhase(index, { role: value }); },
            M.PHASE_ROLES.map(function (role) {
              return { value: role.id, label: role.label };
            })
          ), copy: M.normaliseRole(phase.role) },
          /* What the screen does, which the regressor role only suggests.
           * Every option names the thing it actually puts up, glyph and all,
           * so the column answers "what will I see" in the row rather than
           * in the documentation. */
          { node: selectInput(
            function () { return M.normaliseShow(phase.shows); },
            function (value) { editPhase(index, { shows: value }); },
            M.PHASE_SHOWS.map(function (show) {
              return {
                value: show.id,
                label: show.id ? showLabel(show.id)
                  : 'From the role \u2192 ' + showLabel(M.phaseShow({ role: phase.role }))
              };
            })
          ), copy: M.phaseShow(phase) },
          { node: numberInput(
            function () { return H.round(H.num(phase.min), 2); },
            function (value) { editPhase(index, { min: Math.max(0, value) }); },
            { min: 0, step: 0.5 }
          ), num: true, copy: H.trim(phase.min, 1) },
          { node: numberInput(
            function () { return H.round(H.num(phase.max), 2); },
            function (value) { editPhase(index, { max: Math.max(0, value) }); },
            { min: 0, step: 0.5 }
          ), num: true, copy: H.trim(phase.max, 1) },
          { node: (function () {
            var box = App.h('input', { type: 'checkbox' });
            box.checked = !!phase.jitter;
            box.addEventListener('change', function () {
              editPhase(index, { jitter: box.checked });
              App.refresh();
            });
            return box;
          }()), copy: phase.jitter ? 'yes' : 'no' },
          { node: App.h('div', { class: 'btn-row tight' }, [
            App.iconButton('↑', 'Move up', function () {
              if (index === 0) return;
              App.act('phase.move', { trial: trial.id, phase: index, delta: -1 });
              renderPhases();
            }),
            App.iconButton('↓', 'Move down', function () {
              if (index >= trial.phases.length - 1) return;
              App.act('phase.move', { trial: trial.id, phase: index, delta: 1 });
              renderPhases();
            }),
            App.iconButton('×', 'Remove this phase', function () {
              if (App.act('phase.remove', { trial: trial.id, phase: index })) renderPhases();
            }, 'danger')
          ]), copy: '' }
        ];
      });

      var table = App.dataTable(
        [{ label: '#', num: true }, { label: 'Phase' }, { label: 'Role' },
          { label: 'Shows' },
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
      phaseHost.appendChild(App.h('div', { class: 'screen-head' }, [
        App.h('span', { text: 'On screen' }),
        App.h('span', { class: 'muted', text:
          'what a participant sees, phase by phase - hover for why' })
      ]));
      phaseHost.appendChild(renderScreen());
      phaseHost.appendChild(App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Add phase', 'Append a phase to the trial', function () {
          if (App.act('phase.add', { trial: trial.id })) renderPhases();
        }, ''),
        App.iconButton('Reset to the objective default',
          'Replace the phases with the recommended timing for this objective', function () {
            if (App.act('trial.resetTiming', { trial: trial.id })) {
              App.toast('Recommended timing applied', 'ok');
            }
          }),
        App.iconButton('Optimise delay and tail',
          'Search the delay and post-response fixation for this objective', function () {
            App.toast('Searching the timing grid…');
            setTimeout(function () {
              if (App.act('trial.optimiseTiming', { trial: trial.id })) {
                App.toast('Timing optimised for the objective', 'ok');
              }
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
      'Order, duration and jitter; Role drives the regressor model, Shows drives the screen',
      [timingReadout,
        /* The word that used to be in two panels at once.  A phase's role is
         * a property of a slice of this timeline; what kind of trial this is
         * lives in Conditions, and neither list is the other's. */
        App.h('div', { class: 'notice' }, [
          App.h('span', { html:
            '<strong>Role</strong> here belongs to the phase - one slice of this trial - '
            + 'and is what the regressor model reads. <strong>Shows</strong> is what the '
            + 'screen does during it, which follows the role unless you say otherwise. '
            + 'What kind of trial this <em>is</em> - its condition, and the shape it '
            + 'wears - is a different list, in ' })
        ].concat([App.h('a', { href: '#', text: 'Conditions',
          onclick: function (event) { event.preventDefault(); App.go('conditions'); } }),
          App.h('span', { text: '.' })])),
        phaseHost, App.slider({
        owner: owner, label: 'Embedded control / null trials',
        min: 0, max: 60, step: 1, unit: '%',
        hint: 'Subtracted from the trial count to give the primary event count',
        get: function () { return H.num(trial.controlPct); },
        set: function (value) { trial.controlPct = value; }
      })]));

    host.appendChild(buildTrialHrfCard(trial, owner));
    host.appendChild(buildSeparationCard(trial, owner));

    host.appendChild(App.figureCard('Trial timeline', '', function () {
      return {
        markup: App.trialFigureMarkup(trial, 0),
        caption: M.jitterSettings(App.state).mode === 'geometric'
          ? 'Onsets are cumulative means; jittered waits are whole TRs drawn from the '
            + 'truncated geometric, so they sit nearer the short end of their window.'
          : 'Onsets are cumulative means; jittered phases vary trial to trial.',
        empty: 'Add at least one phase to draw the timeline.'
      };
    }, function () { return App.fileStem(trial.name, 'trial-timeline'); }, [
      App.iconButton('Copy sequence', 'Copy the phase sequence as text', function () {
        var trSeconds = M.representativeTr(App.state, App.boot, trial);
        var jitter = M.jitterSettings(App.state);
        App.copy(trial.phases.map(function (phase) {
          return H.phaseLabel(phase, trSeconds, jitter);
        }).join(' -> '), 'Trial sequence');
      })
    ], owner));
  }

  /* What every regressor phase in the trial predicts, and whether those
   * predictions actually come apart.  Nothing here needs a run: the responses
   * come from the trial's own phases, laid back to back at the trial's mean
   * length, which is the tightest spacing any run could ever give them - a
   * gap, a rest or jitter only pushes them further apart. */
  function buildTrialHrfCard(trial, owner) {
    var plot = App.trialHrfPlot();
    var readout = App.h('div', { class: 'readout' });
    var caption = App.h('div', { class: 'plot-caption' });
    var tableHost = App.h('div', { class: 'mt' });

    function swatch(colour) {
      return '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;'
        + 'margin-right:7px;vertical-align:middle;background:' + colour + '"></span>';
    }

    App.registerView(function () {
      var model = M.trialHrfSeries(App.state, trial, {
        repeats: 2, trSeconds: M.representativeTr(App.state, App.boot, trial)
      });
      App.clear(readout);
      App.clear(tableHost);
      plot.render(model);

      if (!model || !model.traces.length) {
        caption.textContent = 'Nothing in this trial drives a response yet. Give a phase the '
          + 'Stimulus / cue or Response / probe window role above and its HRF is drawn here.';
        return;
      }

      var colours = App.hrfTraceColours(model.traces);
      var span = global.PlannerEfficiency.span();

      [
        ['Responses', String(model.traces.length)],
        ['Trial length', H.round(model.period, 1) + ' s'],
        ['Closest peak gap', model.closestPeakGap === null
          ? '—' : H.round(model.closestPeakGap, 1) + ' s'],
        ['Overlap at a peak', model.worstBleedPct === null
          ? '—' : H.round(model.worstBleedPct, 1) + ' %'],
        ['Left at next trial', H.round(model.worstCarryoverPct, 1) + ' %'],
        ['Response span', H.round(span, 0) + ' s']
      ].forEach(function (pair) {
        readout.appendChild(App.readoutCell(pair[0], pair[1]));
      });

      tableHost.appendChild(App.dataTable(
        [{ label: 'Phase' }, { label: 'Role' }, { label: 'Window', num: true },
          { label: 'Peaks at', num: true }, { label: 'Peak', num: true },
          { label: 'Under next peak', num: true }, { label: 'Left at next trial', num: true }],
        model.traces.map(function (trace, index) {
          return [
            { html: swatch(colours[index]) + App.escapeHtml(trace.label), copy: trace.label },
            trace.roleLabel,
            { text: H.round(trace.onset, 1) + ' - ' + H.round(trace.onset + trace.duration, 1)
              + ' s', num: true },
            { text: H.round(trace.peakTime, 1) + ' s', num: true },
            { text: H.round(trace.peak, 3), num: true },
            { text: trace.bleedPct === null ? '—' : H.round(trace.bleedPct, 1) + ' %', num: true },
            { text: H.round(trace.carryoverPct, 1) + ' %', num: true }
          ];
        }),
        { caption: trial.name + ' - response peaks' }
      ));

      caption.textContent = 'Two trials back to back at the mean phase durations, with no '
        + 'inter-trial gap. "Under next peak" is how much of a response is still standing '
        + 'when the next one peaks; "left at next trial" is what it has when trial 2 opens. '
        + 'Both fall as you lengthen the delay and the tail fixation above.';
    }, owner);

    return App.card('Trial responses',
      'Every phase that drives an HRF, and how far apart the peaks land',
      [plot.node, caption, readout, tableHost]);
  }

  /* The separation solver: one slider that solves the delay and the tail from
   * the response shape, with the objective's own definition of "separated". */
  function buildSeparationCard(trial, owner) {
    var readout = App.h('div', { class: 'readout' });
    var note = App.h('div', { class: 'notice' });

    function solved() {
      return M.separationTiming(App.state, trial,
        H.num(trial.separationTolerancePct, M.objectiveDef(App.state, trial.objective).tolerancePct),
        M.representativeTr(App.state, App.boot, trial));
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
        if (App.act('trial.solveSeparation', { trial: trial.id, tolerancePct: value })) {
          App.toast('Timing solved at a ' + value + '% residual', 'ok');
        }
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
              if (App.act('trial.solveSeparation', { trial: trial.id })) {
                App.toast('Solved timing written into the trial', 'ok');
              }
            }
          })
        ])
      ]);
  }

  /* --------------------------------------------------------------- runs */

  function buildRuns() {
    return libraryPanel({
      id: 'runs',
      kind: 'run',
      noun: 'run design',
      title: 'Run designs',
      blurb: 'A trial design laid out into blocks and bound to an acquisition card. '
        + 'A run is what the scanner and the presentation computer actually execute.',
      listTitle: 'Run designs',
      items: function (state) { return state.runs; },
      meta: function (run) {
        var trial = M.trialById(App.state, run.trial);
        var ctx = M.protocolContext(App.boot, run.protocol);
        var geometry = M.runGeometry(run, trial, ctx.trSeconds, M.jitterSettings(App.state));
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
        set: function (value) { run.trialsPerBlock = Math.max(1, Math.round(value)); }
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
      }),
      App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Optimise blocks and trials',
          'Search the block structure for this trial design\'s objective', function () {
            App.toast('Searching the structure grid…');
            setTimeout(function () {
              if (App.act('run.optimiseStructure', { run: run.id })) {
                App.toast('Run structure optimised', 'ok');
              }
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

    host.appendChild(App.figureCard('Run structure', '', function () {
      var record = App.report && App.report.runs.filter(function (item) {
        return item.id === run.id;
      })[0];
      if (!record || record.missing) {
        return { markup: '', empty: 'Give this run a trial design to draw the figure.' };
      }
      return {
        markup: App.runFigureMarkup(record),
        caption: 'The trial, the block it repeats into and the whole run, each drawn to scale '
          + 'on its own axis. Durations are means; jitter moves every level.',
        empty: 'Give this run a trial design with at least one phase to draw the figure.'
      };
    }, function () { return App.fileStem(run.name, 'run-structure'); }, [], owner));

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
      var ctx = M.protocolContext(App.boot, run.protocol);
      var geometry = M.runGeometry(run, trial, ctx.trSeconds, M.jitterSettings(App.state));
      var series = global.PlannerEfficiency.evaluate(
        M.runDesign(App.state, run), ctx.trSeconds, geometry,
        { series: true, singleTrial: false, jitter: M.jitterSettings(App.state) }
      );
      plot.render(series, { stimulus: 'Stimulus', response: 'Response window' });

      var e = record.efficiency;
      [
        ['Duty cycle', H.round(e.sustainPct, 1) + ' %'],
        ['Stacking gain', H.round(e.saturationIndex, 2) + ' x'],
        ['Single-trial efficiency', H.round(e.singleTrialEff, 3)],
        ['Carryover', H.round(e.carryoverPct, 1) + ' %'],
        ['Stimulus bleed', H.round(e.stimulusBleedPct, 1) + ' %'],
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
      kind: 'session',
      noun: 'session',
      title: 'Sessions',
      blurb: 'A named session: one ordered list of setup steps, structural and reference '
        + 'scans, runs and breaks. Nothing is pinned - drag any block anywhere, switch any '
        + 'block off, and the session solves in the order you leave it. Experiments combine these.',
      listTitle: 'Session library',
      items: function (state) { return state.sessions; },
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

  /* --------------------------------------------------- session sequence */

  /* One editable, sortable row per block.  Every block kind renders into the
   * same skeleton - handle, on-switch, kind, what it is, how many, how long,
   * buttons - so the list reads as one sequence rather than four tables. */
  function sessionSequence(sessionId, owner) {
    var host = App.h('div', { class: 'seq' });

    /* Reordering is driven from pointer events rather than the HTML5 drag
     * protocol: the rows carry live inputs, and a pointer drag leaves those
     * alone, works the same under touch, and cannot leave a row stuck in a
     * half-dragged state if the pointer is released off the list. */
    var drag = null;

    /* Every read and write goes through the state, by id.  Re-solving the
     * design can hand back repaired counts, so a row must never hold on to
     * the block object it was drawn from. */
    function sess() { return M.sessionById(App.state, sessionId); }

    function blocks() {
      var session = sess();
      if (!session) return [];
      if (!Array.isArray(session.blocks)) session.blocks = [];
      return session.blocks;
    }

    function at(id) {
      return blocks().filter(function (block) { return block.id === id; })[0] || null;
    }

    function indexOf(id) {
      var list = blocks();
      for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return i;
      return -1;
    }

    /* Edit through this so a block that has gone missing is a no-op rather
     * than a thrown error. */
    function edit(id, change) {
      var block = at(id);
      if (!block) { render(); return; }
      change(block);
      commit();
    }

    /* Re-drawing the list detaches the input the edit came from, and that
     * fires its blur handler, which would commit again from inside the
     * re-draw.  One commit at a time: the value is already written. */
    var committing = false;
    function commit() {
      if (committing) return;
      committing = true;
      try {
        App.refresh();
        render();
      } finally {
        committing = false;
      }
    }

    /* Buttons run block and session actions, then redraw the list. */
    function runAction(name, args) {
      var done = App.act(name, Object.assign({ session: sessionId }, args || {}));
      render();
      return done;
    }

    function move(from, to) {
      if (from === to || from < 0 || from >= blocks().length) return;
      runAction('block.move', { block: from, to: to });
    }

    function blockMinutes(block) {
      if (block.kind === 'prep' || block.kind === 'break') {
        return Math.max(0, H.num(block.minutes));
      }
      var count = Math.max(0, Math.round(H.num(block.count, 1)));
      if (block.kind === 'structural') {
        return (M.protocolContext(App.boot, block.protocol).durationSeconds / 60) * count;
      }
      var run = M.runById(App.state, block.run);
      if (!run) return 0;
      var trial = M.trialById(App.state, run.trial);
      var ctx = M.protocolContext(App.boot, run.protocol);
      var geometry = M.runGeometry(run, trial, ctx.trSeconds, M.jitterSettings(App.state));
      return count * geometry.run.mean / 60;
    }

    /* What the block is: a card, a run design or a free-text label. */
    function subjectCell(block) {
      if (block.kind === 'structural') {
        var cards = cardOptions();
        if (!cards.length) return App.h('span', { class: 'seq-flat', text: block.protocol || '—' });
        return selectInput(
          function () { return block.protocol; },
          function (value) { edit(block.id, function (live) { live.protocol = value; }); },
          cards
        );
      }
      if (block.kind === 'run') {
        if (!App.state.runs.length) {
          return App.h('span', { class: 'seq-flat', text: 'No run designs yet' });
        }
        return selectInput(
          function () { return block.run; },
          function (value) { edit(block.id, function (live) { live.run = value; }); },
          App.state.runs.map(function (entry) {
            return { value: entry.id, label: entry.name };
          })
        );
      }
      return textInput(
        function () { return block.label || ''; },
        function (value) {
          edit(block.id, function (live) {
            live.label = String(value || '').trim() || live.label;
          });
        },
        block.kind === 'break' ? 'Break' : 'Setup step'
      );
    }

    /* How much of it: a repeat count for scans, a duration for everything
     * else the planner cannot time for you. */
    function amountCell(block) {
      if (block.kind === 'structural' || block.kind === 'run') {
        return App.h('div', { class: 'seq-amount' }, [
          numberInput(
            function () { return Math.max(0, Math.round(H.num(block.count, 1))); },
            function (value) {
              edit(block.id, function (live) {
                live.count = Math.max(0, Math.round(value));
              });
            },
            { min: 0, step: 1 }
          ),
          App.h('span', { class: 'seq-unit', text: '×' })
        ]);
      }
      return App.h('div', { class: 'seq-amount' }, [
        numberInput(
          function () { return H.round(H.num(block.minutes), 2); },
          function (value) {
            edit(block.id, function (live) { live.minutes = Math.max(0, value); });
          },
          { min: 0, step: 0.5 }
        ),
        App.h('span', { class: 'seq-unit', text: 'min' })
      ]);
    }

    function detailFor(block) {
      if (block.kind === 'run') {
        var run = M.runById(App.state, block.run);
        if (!run) return 'run design missing';
        var trial = M.trialById(App.state, run.trial);
        var ctx = M.protocolContext(App.boot, run.protocol);
        var geometry = M.runGeometry(run, trial, ctx.trSeconds, M.jitterSettings(App.state));
        return ctx.label + '  ·  ' + H.round(geometry.run.mean / 60, 2) + ' min each  ·  '
          + H.fmtNumber(geometry.trialsPerRun) + ' trials each';
      }
      if (block.kind === 'structural') {
        var card = M.protocolContext(App.boot, block.protocol);
        return card.slug + '  ·  ' + H.round(card.durationSeconds / 60, 2) + ' min each';
      }
      if (block.kind === 'break') return 'a break you placed yourself';
      return 'time in the session that is not a scan';
    }

    function row(block, index) {
      var enabled = block.enabled !== false;
      var node = App.h('div', {
        class: 'seq-row kind-' + block.kind + (enabled ? '' : ' off'),
        'data-index': String(index)
      });

      /* Only the handle starts a drag, so the inputs in the row stay usable. */
      var handle = App.h('button', {
        class: 'seq-handle', type: 'button', text: '⠿',
        title: 'Drag to reorder, or use the arrows',
        'aria-label': 'Reorder this block'
      });
      handle.addEventListener('pointerdown', function (event) {
        if (event.button) return;
        event.preventDefault();
        startDrag(block.id, node);
      });

      var box = App.h('input', { type: 'checkbox', title: 'Include this block in the session' });
      box.checked = enabled;
      box.addEventListener('change', function () {
        edit(block.id, function (live) { live.enabled = box.checked; });
      });

      node.appendChild(handle);
      node.appendChild(App.h('span', { class: 'seq-on' }, [box]));
      node.appendChild(App.h('span', {
        class: 'pill seq-kind', text: M.BLOCK_LABELS[block.kind] || block.kind
      }));
      node.appendChild(App.h('div', { class: 'seq-subject' }, [
        subjectCell(block),
        App.h('span', { class: 'seq-detail', text: detailFor(block) })
      ]));
      node.appendChild(amountCell(block));
      node.appendChild(App.h('span', {
        class: 'seq-minutes',
        text: enabled ? H.round(blockMinutes(block), 2) + ' min' : '—'
      }));
      node.appendChild(App.h('div', { class: 'btn-row tight seq-actions' }, [
        App.iconButton('↑', 'Move earlier in the session', function () {
          var here = indexOf(block.id);
          if (here > 0) move(here, here - 1);
        }),
        App.iconButton('↓', 'Move later in the session', function () {
          var here = indexOf(block.id);
          if (here >= 0 && here < blocks().length - 1) move(here, here + 1);
        }),
        App.iconButton('⧉', 'Duplicate this block', function () {
          if (indexOf(block.id) >= 0) runAction('block.duplicate', { block: block.id });
        }),
        App.iconButton('×', 'Remove this block', function () {
          if (indexOf(block.id) >= 0) runAction('block.remove', { block: block.id });
        }, 'danger')
      ]));
      return node;
    }

    function rowNodes() {
      return Array.prototype.slice.call(host.querySelectorAll('.seq-row'));
    }

    function clearMarkers() {
      rowNodes().forEach(function (node) {
        node.classList.remove('drop-before', 'drop-after');
      });
      tail.classList.remove('drop-before');
    }

    /* Where a drop at this height would insert: an index in 0..length, so the
     * far end of the list is as reachable as any gap between two rows. */
    function insertionAt(clientY) {
      var nodes = rowNodes();
      for (var i = 0; i < nodes.length; i += 1) {
        var box = nodes[i].getBoundingClientRect();
        if (clientY < box.top + box.height / 2) return i;
      }
      return nodes.length;
    }

    function paintMarker(insertion) {
      clearMarkers();
      var nodes = rowNodes();
      if (insertion >= nodes.length) tail.classList.add('drop-before');
      else nodes[insertion].classList.add('drop-before');
    }

    function endDrag(commitMove) {
      if (!drag) return;
      var state = drag;
      drag = null;
      document.removeEventListener('pointermove', onDragMove, true);
      document.removeEventListener('pointerup', onDragUp, true);
      document.removeEventListener('pointercancel', onDragCancel, true);
      document.removeEventListener('keydown', onDragKey, true);
      host.classList.remove('dragging');
      if (state.node) state.node.classList.remove('dragging');
      clearMarkers();
      if (!commitMove) return;
      var from = indexOf(state.id);
      if (from < 0) { render(); return; }
      var to = state.insertion > from ? state.insertion - 1 : state.insertion;
      move(from, to);
    }

    function onDragMove(event) {
      if (!drag) return;
      event.preventDefault();
      drag.insertion = insertionAt(event.clientY);
      paintMarker(drag.insertion);
    }

    function onDragUp(event) {
      if (!drag) return;
      event.preventDefault();
      drag.insertion = insertionAt(event.clientY);
      endDrag(true);
    }

    function onDragCancel() { endDrag(false); }

    function onDragKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); endDrag(false); }
    }

    function startDrag(id, node) {
      if (drag) endDrag(false);
      drag = { id: id, node: node, insertion: indexOf(id) };
      node.classList.add('dragging');
      host.classList.add('dragging');
      paintMarker(drag.insertion);
      document.addEventListener('pointermove', onDragMove, true);
      document.addEventListener('pointerup', onDragUp, true);
      document.addEventListener('pointercancel', onDragCancel, true);
      document.addEventListener('keydown', onDragKey, true);
    }

    /* A landing strip past the last row, so "run this last" is a place you can
     * aim at rather than the bottom edge of the final row. */
    var tail = App.h('div', { class: 'seq-tail', text: 'Drop here to run last' });

    function addBlock(kind) { runAction('block.add', { kind: kind }); }

    var adders = App.h('div', { class: 'btn-row mt' }, [
      App.iconButton('+ Setup step', 'Append a non-scan step', function () { addBlock('prep'); }),
      App.iconButton('+ Structural / reference', 'Append a structural or reference scan',
        function () { addBlock('structural'); }),
      App.iconButton('+ Run', 'Append a functional run', function () { addBlock('run'); }),
      App.iconButton('+ Break', 'Append a break you place yourself',
        function () { addBlock('break'); }),
      App.iconButton('Reset to the default order', 'Setup, then structurals, then runs',
        function () { runAction('session.resetOrder'); })
    ]);

    function render() {
      if (drag) endDrag(false);
      App.clear(host);
      var list = blocks();
      if (!list.length) {
        host.appendChild(App.h('div', {
          class: 'notice', text: 'This session is empty. Add setup, scans, runs and breaks below, '
            + 'in any order you like.'
        }));
      }
      list.forEach(function (block, index) {
        host.appendChild(row(block, index));
      });
      host.appendChild(tail);
      var total = H.sum(list, function (block) {
        return block.enabled === false ? 0 : blockMinutes(block);
      });
      host.appendChild(App.h('div', { class: 'seq-total' }, [
        App.h('span', { text: list.length + ' blocks' }),
        App.h('span', { text: H.round(total, 2) + ' min before automatic breaks' })
      ]));
    }

    render();
    return { host: host, adders: adders, render: render };
  }

  function buildSessionEditor(session, host, owner) {
    host.appendChild(identityCard(session, owner));

    var sessionId = session.id;
    function sess() { return M.sessionById(App.state, sessionId) || session; }

    var sequence = sessionSequence(sessionId, owner);

    host.appendChild(App.card('Session sequence',
      'Everything the console does, in the order you put it in',
      [
        App.h('p', { class: 'hint-block', text: 'A new session opens with setup, then the '
          + 'structural and reference scans, then its runs - but nothing is pinned there. '
          + 'Drag any row by its handle, or use the arrows, to run scans between runs, move '
          + 'the practice block to the middle, or drop a break wherever you want one. '
          + 'Switch a row off to keep it in the design without running it.' }),
        sequence.host,
        sequence.adders
      ]));

    host.appendChild(App.card('Automatic break', 'Only between two runs that end up adjacent', [
      App.checkbox({
        owner: owner, label: 'Insert a break between back-to-back runs',
        hint: 'Off means every break is a block you placed yourself.',
        get: function () { return sess().autoBreak !== false; },
        set: function (value) { sess().autoBreak = !!value; },
        onChange: function () { sequence.render(); }
      }),
      App.slider({
        owner: owner, label: 'Automatic break length', min: 0, max: 30, step: 0.5, decimals: 1,
        unit: 'min',
        get: function () { return H.num(sess().breakMinutes); },
        set: function (value) { sess().breakMinutes = value; },
        onChange: function () { sequence.render(); }
      })
    ]));

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
        ['Breaks', record.breakTotalMinutes + ' min'],
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

    host.appendChild(App.figureCard('Session overview', '', function () {
      var record = App.report && App.report.sessions.filter(function (item) {
        return item.id === session.id;
      })[0];
      if (!record || record.missing) {
        return { markup: '', empty: 'This session has not solved yet.' };
      }
      return {
        markup: App.sessionFigureMarkup(record),
        caption: 'The session as the console runs it, to scale in minutes. Numbers match the '
          + 'timeline table above; the hairlines inside a run are its blocks.',
        empty: 'Switch on at least one block to draw the session figure.'
      };
    }, function () { return App.fileStem(session.name, 'session'); }, [], owner));
  }

  /* -------------------------------------------------------- experiments */

  function buildExperiments() {
    return libraryPanel({
      id: 'experiments',
      kind: 'experiment',
      noun: 'experiment',
      title: 'Experiments',
      blurb: 'Sessions combined into an experiment, and experiments combined into one '
        + 'budget. Each experiment names its own unit, sets its own goal, and takes a '
        + 'share of the scanner time.',
      listTitle: 'Experiments',
      items: function (state) { return state.experiments; },
      colour: function (item) { return App.experimentColour(item.id); },
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
        set: function (value) {
          App.write('experiment.update', { experiment: experiment.id, enabled: value });
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
        set: function (value) {
          App.write('experiment.update', {
            experiment: experiment.id, requestedPct: H.clamp(value, 0, 100)
          });
        },
        disabledWhen: function () { return !!experiment.locked; }
      }),
      App.checkbox({
        owner: owner, label: 'Lock this share while the others redistribute',
        get: function () { return !!experiment.locked; },
        set: function (value) {
          App.write('allocation.lock', { experiment: experiment.id, locked: value });
        }
      }),
      App.slider({
        owner: owner, label: 'Total sessions (session-count mode)', min: 0, max: 400, step: 1,
        unit: 'sess',
        hint: 'One total, split across the session plan by the mix column below',
        get: function () { return H.num(experiment.manualSessions); },
        set: function (value) { experiment.manualSessions = Math.max(0, Math.round(value)); },
        disabledWhen: function (state) {
          return state.budget.solveMode !== 'manual' || !!experiment.lockPlan;
        }
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
                App.act('plan.move', { experiment: experiment.id, row: index, delta: -1 });
                renderPlan();
              }),
              App.iconButton('↓', 'Move down', function () {
                if (index >= experiment.plan.length - 1) return;
                App.act('plan.move', { experiment: experiment.id, row: index, delta: 1 });
                renderPlan();
              }),
              App.iconButton('×', 'Remove from the plan', function () {
                App.act('plan.remove', { experiment: experiment.id, row: index });
                renderPlan();
              }, 'danger')
            ]), copy: '' }
          ]
        };
      });

      var table = App.dataTable(
        [{ label: 'Session' },
          { label: experiment.lockPlan ? 'Sessions' : 'Mix', num: true },
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
          ? 'Session counts are set by hand: each number above is how many of that session '
            + 'run, whatever the budget says.'
          : 'The counts are a mix, not a total: the solver buys as many whole sessions as the '
            + 'budget or the goal allows and splits them in this ratio. Tick the box above to '
            + 'type the session counts yourself instead.'
      }));

      var picker = App.h('select', {});
      App.state.sessions.forEach(function (item) {
        picker.appendChild(App.h('option', { value: item.id, text: item.name }));
      });
      planHost.appendChild(App.h('div', { class: 'split-inline mt' }, [
        picker,
        App.iconButton('Add session to the plan', 'Append a session', function () {
          if (!picker.value) return;
          App.act('plan.add', { experiment: experiment.id, session: picker.value });
          renderPlan();
        })
      ]));
    }
    renderPlan();
    App.registerView(function () { renderPlan(); }, owner);

    /* Built once, outside renderPlan, so the redraws renderPlan does on every
     * refresh do not stack up another registered control each time.  Toggling
     * it redraws the table through that same view. */
    var directCounts = App.checkbox({
      owner: owner,
      label: 'Set the session counts here by hand',
      hint: 'The solver stops sizing this experiment: the number you type on each row is '
        + 'how many of that session run',
      get: function () { return !!experiment.lockPlan; },
      set: function (value) { experiment.lockPlan = value; }
    });

    host.appendChild(App.card('Session plan', 'Which sessions this experiment runs',
      [directCounts, planHost]));

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

    host.appendChild(App.figureCard('Experiment overview', '', function () {
      var record = App.report && App.report.experiments.filter(function (item) {
        return item.id === experiment.id;
      })[0];
      if (!record) {
        return { markup: '', empty: 'This experiment is switched off.' };
      }
      return {
        markup: App.experimentFigureMarkup(record),
        caption: 'Every session design in the plan on one minutes axis, with how many of each '
          + 'the budget buys and what that costs. Run internals are on the Runs panel.',
        empty: 'Add a session to the plan to draw the experiment figure.'
      };
    }, function () { return App.fileStem(experiment.name, 'experiment'); }, [], owner));
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

  /* The distribution laid out the way the source tabulates it, plus the two
   * columns the truncation argument needs.
   *
   * `Running total` is not decoration: it is literally the sampling recipe -
   * draw a uniform (0, 1) and take the first rung whose running total covers
   * it.  For p = .5 truncated at 4 TRs it reads .516, .774, .903, .968, 1,
   * which are the intervals the source quotes.
   *
   * `P(next TR)` is what the truncation costs.  Untruncated it would be flat
   * at p, which is the whole reason for choosing a geometric; truncated it
   * climbs towards the cap and hits certainty on the last rung, where an ideal
   * observer knows the stimulus is next. */
  function jitterDistributionTable(draw, label, caption) {
    return App.dataTable(
      [{ label: 'No. of TRs in delay', num: true }, { label: 'Wait', num: true },
        { label: 'P(delay)', num: true }, { label: 'Running total', num: true },
        { label: 'P(next TR)', num: true }],
      draw.probs.map(function (probability, n) {
        var last = n === draw.nMax && draw.nMax > 0;
        return {
          className: last ? 'total' : '',
          cells: [
            { text: String(n), num: true },
            { text: H.round(draw.min + n * draw.trSeconds, 2) + ' s', num: true },
            { text: H.round(probability, 4), num: true },
            { text: H.round(draw.cumulative[n], 4), num: true },
            { text: H.round(draw.hazard[n], 4) + (last ? ' (certain)' : ''), num: true }
          ]
        };
      }),
      { caption: caption || (label + ' - P(delay = n TRs) at p = ' + H.round(draw.p, 2)
        + ', TR ' + draw.trSeconds + ' s') }
    );
  }

  /* Every jittered phase in the design, with the TR it will be quantised
   * against.  One list, so the panel can talk about the design as a whole
   * rather than one trial at a time. */
  function jitteredPhases() {
    var out = [];
    (App.state.trials || []).forEach(function (trial) {
      var trSeconds = M.representativeTr(App.state, App.boot, trial);
      (trial.phases || []).forEach(function (phase, index) {
        var lo = H.num(phase.min);
        var hi = Math.max(lo, H.num(phase.max));
        if (!phase.jitter || hi - lo < 0.001) return;
        out.push({
          trial: trial, phase: phase, index: index,
          min: lo, max: hi, window: hi - lo, trSeconds: trSeconds,
          rungs: Math.max(0, Math.floor((hi - lo) / trSeconds + 1e-9))
        });
      });
    });
    return out;
  }

  /* --------------------------------------------------------- conditions */

  /* Trial conditions: what a trial presents, and the shape that tells the
   * participant which is which.  A study-wide list, like the jitter settings
   * - every run design's PsychoPy config gets the same ones - and the
   * builder's own word for them, which is also the YAML key they are written
   * into.
   *
   * They were called trial roles until that collided with a *phase's* role,
   * which is what the regressor model reads and is set in the Trials panel.
   * Two lists, both called Role, is how a phase came to be expected to carry
   * a condition.  The state and the API still say `role` (state.roles,
   * role.add); only what anyone reads says condition. */

  /* Offered in the shape box, not imposed: the field takes any text. */
  var SHAPE_CHOICES = ['\u25CF', '\u25CB', '\u25C6', '\u25C7', '\u25B2', '\u25B3',
    '\u25BC', '\u25BD', '\u25A0', '\u25A1', '\u2605', '\u2606', '\u2716', '\u271A',
    '\u2B1F', '\u2B22'];

  var SHAPE_LIST_ID = 'role-shape-choices';

  function buildRoles() {
    var owner = 'conditions';
    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'Conditions' }),
      App.h('p', {
        html: 'A condition is one of the things a trial can <em>be</em> - the primary task, '
          + 'a passive-reading control, a catch trial - and each one wears its own shape so '
          + 'the participant can tell them apart. This list is written straight into the '
          + 'PsychoPy config\'s <code>conditions:</code> block, which is where the name '
          + 'comes from. A condition belongs to a whole trial.<br>'
          + 'It is not a <strong>phase</strong>\'s role, which belongs to one slice of the '
          + 'trial\'s timeline and is what the regressor model reads; that is set per phase '
          + 'in the Trials panel.'
      })
    ]));

    /* --- the list ------------------------------------------------------- */

    var tableHost = App.h('div', {});

    /* `redraw` is for the two fields the action normalises - a name is
     * slugged, a shape is trimmed - so what lands in the design is what the
     * box shows, and a refused rename puts the old name back rather than
     * leaving invalid text sitting in the table. */
    function editRole(index, fields, redraw) {
      var out = App.write('role.update', Object.assign({ role: index }, fields));
      if (redraw) renderRoles();
      return out;
    }

    function renderRoles() {
      App.clear(tableHost);
      var roles = M.trialRoles(App.state);

      var rows = roles.map(function (role, index) {
        return [
          { text: String(index + 1), num: true },
          { node: textInput(
            function () { return role.name; },
            function (value) { editRole(index, { name: value }, true); }
          ), copy: role.name },
          { node: (function () {
            var input = textInput(
              function () { return role.shape; },
              function (value) { editRole(index, { shape: value }, true); },
              'none'
            );
            input.setAttribute('list', SHAPE_LIST_ID);
            input.classList.add('shape-input');
            return input;
          }()), copy: role.shape },
          { node: (function () {
            var box = App.h('input', { type: 'checkbox' });
            box.checked = !!role.showQuestion;
            box.addEventListener('change', function () {
              editRole(index, { showQuestion: box.checked });
              App.refresh();
            });
            return box;
          }()), copy: role.showQuestion ? 'yes' : 'no' },
          { node: selectInput(
            function () { return role.response; },
            function (value) { editRole(index, { response: value }, true); },
            M.RESPONSE_TOKENS.map(function (token) { return { value: token, label: token }; })
          ), copy: role.response },
          /* Only a response that repeats a fixed word has one; the others
           * show what they repeat instead, which is not ours to set. */
          { node: M.needsWord(role)
            ? textInput(
              function () { return role.word || M.DEFAULT_CONSTANT_WORD; },
              function (value) { editRole(index, { word: value }, true); }
            )
            : App.h('span', { class: 'muted', text:
              role.response === 'none' ? 'silent'
                : role.response === 'opposite' ? 'the other label' : 'the answer' }),
            copy: M.needsWord(role) ? (role.word || M.DEFAULT_CONSTANT_WORD) : '' },
          { node: (function () {
            var box = App.h('input', { type: 'checkbox' });
            box.checked = !!role.cueFromResponse;
            box.addEventListener('change', function () {
              editRole(index, { cueFromResponse: box.checked });
              App.refresh();
            });
            return box;
          }()), copy: role.cueFromResponse ? 'yes' : 'no' },
          { node: App.h('div', { class: 'btn-row tight' }, [
            App.iconButton('\u2191', 'Move up; the first role is the primary one', function () {
              if (index === 0) return;
              App.act('role.move', { role: index, delta: -1 });
              renderRoles();
            }),
            App.iconButton('\u2193', 'Move down', function () {
              if (index >= roles.length - 1) return;
              App.act('role.move', { role: index, delta: 1 });
              renderRoles();
            }),
            App.iconButton('\u00D7', 'Remove this role', function () {
              if (App.act('role.remove', { role: index })) renderRoles();
            }, 'danger')
          ]), copy: '' }
        ];
      });

      var table = App.dataTable(
        [{ label: '#', num: true }, { label: 'Condition' }, { label: 'Shape' },
          { label: 'Shows question' }, { label: 'Response' }, { label: 'Repeats' },
          { label: 'Cue from response' }, { label: '' }],
        rows.map(function (row) {
          return row.map(function (cell) {
            return { text: cell.text, num: cell.num, className: cell.node ? 'cell' : '',
              copy: cell.copy };
          });
        }),
        { caption: 'Trial conditions - the first one is the primary condition' }
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

      tableHost.appendChild(table);
      /* A condition with no shape writes `cue: ""`, and a phase that shows
       * the cue then paints nothing at all for those trials - which looks
       * like a blank screen rather than a mistake.  Worth saying here, where
       * it is fixed, rather than leaving it to be found on the stage. */
      /* A condition only comes up if some trial design withholds a control
       * share for it - the first one takes everything otherwise.  Adding one
       * and leaving every share at zero is silent today: it is written into
       * every config at per_run 0 and never presented, however it is shaped.
       * That is the thing that looks like "my condition is not being used". */
      var everUsed = {};
      (App.state.trials || []).forEach(function (design) {
        M.conditionsInPlay(App.state, H.num(design.controlPct)).forEach(function (role) {
          everUsed[role.name] = true;
        });
      });
      var idle = roles.filter(function (role) { return !everUsed[role.name]; });
      if (idle.length) {
        tableHost.appendChild(App.h('div', { class: 'notice warn mt' }, [
          App.h('span', { html:
            '<strong>' + App.escapeHtml(idle.map(function (r) { return r.name; }).join(', '))
            + '</strong> ' + (idle.length === 1 ? 'is' : 'are')
            + ' written into every config at <code>per_run: 0</code>, so '
            + (idle.length === 1 ? 'it never comes up' : 'they never come up')
            + ' and the shape is never drawn. The first condition takes every trial a '
            + 'trial design does not withhold as its <em>embedded control share</em>, and '
            + 'that share is 0% on every trial design here. Raise it in ' }),
          App.h('a', { href: '#', text: 'Trials',
            onclick: function (event) { event.preventDefault(); App.go('trials'); } }),
          App.h('span', { text: ', or reorder these so the one you want is first.' })
        ]));
      }

      var unshaped = roles.filter(function (role) { return !role.shape; });
      if (unshaped.length) {
        tableHost.appendChild(App.h('div', { class: 'notice warn mt' }, [
          (unshaped.length === 1 ? 'One condition has no shape: ' : 'These conditions have '
            + 'no shape: ')
            + unshaped.map(function (role) { return role.name; }).join(', ')
            + '. A phase that shows the cue paints nothing for those trials - a blank '
            + 'screen, not a missing glyph. Give each one a shape, or leave it only if '
            + 'those trials are meant to show nothing.'
        ]));
      }
      tableHost.appendChild(App.h('datalist', { id: SHAPE_LIST_ID },
        SHAPE_CHOICES.map(function (shape) { return App.h('option', { value: shape }); })));
      tableHost.appendChild(App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Add condition', 'Append a trial condition', function () {
          if (App.act('role.add')) renderRoles();
        }, ''),
        App.iconButton('Reset to the lab template',
          'Put the conditions back to the five the lab template ships with', function () {
            if (App.act('role.reset')) {
              App.toast('Conditions reset to the lab template', 'ok');
              renderRoles();
            }
          })
      ]));
    }
    renderRoles();

    panel.appendChild(App.card('Trial conditions',
      'Name, shape and what each one presents; the first condition is the primary one', [
      App.h('div', {
        class: 'notice',
        text: 'The first condition takes the trials the trial design does not withhold as '
          + 'its embedded control share, and the rest split that share as evenly as the '
          + 'count allows - so the up and down arrows decide which condition the primary '
          + 'trials belong to. The counts themselves stay with the trial design, and which '
          + 'trial comes when stays with the presentation software. Names are the config\'s '
          + 'condition keys, so they are slugged and no two may be the same.'
      }),
      tableHost
    ]));

    /* --- screens --------------------------------------------------------- */

    /* Everything on screen that is not a condition's cue.  It sits on this
     * page because planning a set of shapes means planning against all of
     * them at once - and because `+` is spoken for before you start. */

    var screenHost = App.h('div', {});

    function renderScreens() {
      App.clear(screenHost);
      var held = M.screens(App.state);

      var mark = App.h('input', {
        type: 'text', class: 'cell-input', maxlength: '8',
        list: SHAPE_LIST_ID, value: held.fixation,
        'aria-label': 'The fixation mark'
      });
      mark.addEventListener('change', function () {
        App.write('screen.update', { fixation: mark.value.trim() });
        App.refresh();
      });

      function endPicker(key, label) {
        return App.h('label', { class: 'screen-field' }, [
          App.h('span', { text: label }),
          selectInput(
            function () { return held[key]; },
            function (value) {
              var args = {};
              args[key] = value;
              App.write('screen.update', args);
            },
            M.LEAD_SHOWS.map(function (entry) {
              return {
                value: entry.id,
                label: entry.id === 'fixation'
                  ? 'The fixation mark  ' + (held.fixation || '(nothing)') : entry.label
              };
            })
          )
        ]);
      }

      screenHost.appendChild(App.h('div', { class: 'screen-fields' }, [
        App.h('label', { class: 'screen-field' }, [
          App.h('span', { text: 'Fixation mark' }), mark
        ]),
        endPicker('leadIn', 'Lead-in shows'),
        endPicker('leadOut', 'Lead-out shows'),
        App.iconButton('Reset', 'Put all three back to the lab template', function () {
          if (App.act('screen.reset')) App.refresh();
        })
      ]));

    }
    App.registerView(renderScreens, owner);
    renderScreens();

    panel.appendChild(App.card('Screens',
      'Everything on screen that is not a condition\'s cue', [
      App.h('div', {
        class: 'notice',
        html: 'The <strong>fixation mark</strong> is what every fixation phase draws, and '
          + 'the task reads it as <code>fixation.text</code>. The <strong>lead-in and '
          + 'lead-out</strong> are the quiet stretches at each end of a run, and each can '
          + 'show the mark or nothing. Below them are the two <strong>answer labels</strong> '
          + 'the question bank uses, how they are balanced within each condition, and how a '
          + 'cue-from-response cue writes the token it shows. Each is written into the '
          + 'config only when it differs from the task\'s own default.'
      }),
      screenHost
    ]));

    /* --- every symbol on screen ----------------------------------------- */

    /* One place to see the whole visual vocabulary of the study, because it
     * is spread over three: the fixation mark comes from the lab template,
     * the cues from this panel, and where each lands from the phase list in
     * Trials.  Planning a set of shapes means knowing what is already taken
     * - and `+` is taken before you start. */

    /* Glyphs a participant could mistake for one another, grouped by the
     * shape they read as rather than by codepoint. */
    var LOOKALIKES = [
      ['+', '\u271A', '\u2716', '\u2715', '\u2717', '\u00D7', 'x', 'X', '\u2573'],
      ['\u25CF', '\u25CB', '\u25CF', '\u2B24', '\u25EF', 'o', 'O', '0'],
      ['\u25A0', '\u25A1', '\u2B1B', '\u2B1C'],
      ['\u25B2', '\u25B3', '\u25BC', '\u25BD'],
      ['\u25C6', '\u25C7', '\u2B27', '\u2B26'],
      ['\u2605', '\u2606']
    ];

    function lookalikeGroup(glyph) {
      for (var i = 0; i < LOOKALIKES.length; i += 1) {
        if (LOOKALIKES[i].indexOf(glyph) >= 0) return i;
      }
      return -1;
    }

    /* Every glyph the task can put up, what it is, and where it lands. */
    function symbolRows() {
      var roles = M.trialRoles(App.state);
      var trials = App.state.trials || [];
      var where = { fixation: [], question: [], cue: [], blank: [] };
      var cueIn = {};

      trials.forEach(function (design) {
        var hasCue = false;
        (design.phases || []).forEach(function (phase) {
          var show = M.phaseShow(phase);
          if (show === 'cue') hasCue = true;
          (where[show] = where[show] || []).push(phase.name + ' \u2014 ' + design.name);
        });
        if (!hasCue) return;
        M.conditionsInPlay(App.state, H.num(design.controlPct)).forEach(function (role) {
          (cueIn[role.name] = cueIn[role.name] || []).push(design.name);
        });
      });

      var ends = M.screens(App.state);
      var endsAt = [];
      if (ends.leadIn === 'fixation') endsAt.push('Lead-in of every run');
      if (ends.leadOut === 'fixation') endsAt.push('Lead-out of every run');
      var rows = [{
        glyph: ends.fixation,
        what: 'Fixation mark',
        note: ends.fixation ? 'the config\'s fixation.text' : 'set to nothing, so a '
          + 'fixation phase draws a blank screen',
        where: endsAt.concat(where.fixation)
      }];
      ['leadIn', 'leadOut'].forEach(function (key) {
        if (ends[key] === 'fixation') return;
        rows.push({
          glyph: '\u00b7',
          what: (key === 'leadIn' ? 'Lead-in' : 'Lead-out') + ' \u2014 nothing',
          note: 'set on the Screens card above',
          where: ['Every run']
        });
      });

      roles.forEach(function (role) {
        /* cue_from_response replaces the shape with the token itself, so the
         * shape on that row is never drawn. */
        var token = role.cueFromResponse && role.response !== 'none';
        rows.push({
          glyph: token ? 'YES / NO' : role.shape,
          what: role.name + ' \u2014 condition cue',
          note: token
            ? 'cue from response: the token is drawn, so this condition\'s shape '
              + (role.shape ? '(' + role.shape + ') ' : '') + 'never appears'
            : (role.shape ? null : 'no shape: a cue phase paints nothing for these trials'),
          idle: !cueIn[role.name],
          where: cueIn[role.name]
            ? where.cue.filter(function (place) {
              return cueIn[role.name].some(function (name) {
                return place.indexOf('\u2014 ' + name) >= 0;
              });
            })
            : []
        });
      });

      rows.push({
        glyph: 'Q',
        what: 'The question itself',
        note: 'text, shapes or an image, from the question bank; blank instead on a '
          + 'condition that does not show the question',
        where: where.question
      });
      rows.push({
        glyph: '\u00b7',
        what: 'Nothing \u2014 a blank screen',
        note: null,
        where: where.blank
      });
      return rows;
    }

    var symbolHost = App.h('div', {});

    function renderSymbols() {
      App.clear(symbolHost);
      var rows = symbolRows();

      /* Anything drawn twice, or drawn as something easily mistaken for it. */
      var drawn = rows.filter(function (row) {
        return row.glyph && !row.idle && row.where.length;
      });
      var clashes = [];
      drawn.forEach(function (a, i) {
        drawn.slice(i + 1).forEach(function (b) {
          if (a.glyph === b.glyph) {
            clashes.push(a.glyph + ' is used by both ' + a.what + ' and ' + b.what);
          } else {
            var group = lookalikeGroup(a.glyph);
            if (group >= 0 && group === lookalikeGroup(b.glyph)) {
              clashes.push(a.glyph + ' (' + a.what + ') and ' + b.glyph + ' (' + b.what
                + ') read as the same shape');
            }
          }
        });
      });
      if (clashes.length) {
        symbolHost.appendChild(App.h('div', { class: 'notice warn' }, [
          App.h('span', { text: 'On screen together and hard to tell apart: '
            + clashes.join('; ') + '.' })
        ]));
      }

      symbolHost.appendChild(App.dataTable(
        [{ label: 'Symbol' }, { label: 'What it is' }, { label: 'Where it appears' }],
        rows.map(function (row) {
          var what = row.what + (row.note ? ' \u2014 ' + row.note : '');
          var place = row.idle ? 'never presented: per_run 0 in every run'
            : (row.where.length ? row.where.join(' \u00b7 ') : 'no phase shows it');
          return [
            { html: '<span class="glyph">' + App.escapeHtml(row.glyph || '\u2014')
              + '</span>', copy: row.glyph },
            { text: what },
            { text: place }
          ];
        }),
        { caption: 'Every symbol the task can put on screen' }
      ));
    }
    App.registerView(renderSymbols, owner);
    renderSymbols();

    panel.appendChild(App.card('Every symbol on screen',
      'The whole visual vocabulary of the study, in one place', [
      App.h('div', {
        class: 'notice',
        html: 'Shapes are only half of what a participant sees. The fixation mark comes '
          + 'from the lab template and is drawn during the <strong>lead-in and lead-out '
          + 'of every run</strong> as well as every fixation phase, so it is taken before '
          + 'you choose anything; the cues are this panel\'s; and which phase draws which '
          + 'is set in Trials. Plan against the whole list, not just the rows above.'
      }),
      symbolHost
    ]));

    /* --- what the export gets ------------------------------------------- */

    var previewPicker = App.view(App.h('select', {}));
    var previewBox = App.h('pre', { class: 'code-box' });

    function previewRun() {
      var runs = (App.report && App.report.runs.filter(function (run) {
        return !run.missing;
      })) || [];
      return runs.filter(function (run) {
        return run.id === previewPicker.value;
      })[0] || runs[0] || null;
    }

    function renderPreview() {
      var run = previewRun();
      previewBox.textContent = run
        ? M.psychopyRunConditions(App.report, run).join('\n')
        : 'Build a run design first; the counts come from one.';
    }
    previewPicker.addEventListener('change', renderPreview);

    App.registerView(function (report) {
      var runs = (report.runs || []).filter(function (run) { return !run.missing; });
      var previous = previewPicker.value;
      App.clear(previewPicker);
      runs.forEach(function (run) {
        previewPicker.appendChild(App.h('option', { value: run.id, text: run.name }));
      });
      if (previous && runs.some(function (run) { return run.id === previous; })) {
        previewPicker.value = previous;
      }
      renderPreview();
    }, owner);

    panel.appendChild(App.card('What the PsychoPy config gets',
      'The conditions: block, exactly as the export writes it', [
      App.h('div', {
        class: 'notice',
        text: 'This is the export\'s own text, not a second rendering of it. The per_run '
          + 'counts belong to the run design picked here; everything else on the line is '
          + 'the condition above.'
      }),
      App.h('div', { class: 'split-inline mb' }, [
        previewPicker,
        App.iconButton('Copy block', 'Copy the shown conditions block', function () {
          App.copy(previewBox.textContent, 'conditions block');
        })
      ]),
      previewBox
    ]));

    return panel;
  }

  /* ------------------------------------------------------------- jitter */

  function buildJitter() {
    var owner = 'jitter';
    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'Jitter' }),
      App.h('p', {
        text: 'Varying the gap between events is what makes a rapid event-related design '
          + 'estimable at all: without it every event lands on the same TR phase and only '
          + 'sums of betas can be recovered. This panel decides how that gap is drawn. '
          + 'Which phases vary is still set by the Jitter box on each phase, in the Trials '
          + 'panel.'
      })
    ]));

    /* --- how a phase gets its rungs ------------------------------------- */

    var ladderHost = App.h('div', {});
    var ladderNote = App.h('div', { class: 'notice' });

    App.registerView(function () {
      App.clear(ladderHost);
      var phases = jitteredPhases();
      if (!phases.length) {
        ladderNote.textContent = 'No phase is marked as jittered yet. In the Trials panel, '
          + 'tick Jitter on a phase and give it a max above its min.';
        return;
      }

      ladderHost.appendChild(App.dataTable(
        [{ label: 'Trial' }, { label: 'Phase' }, { label: 'Min', num: true },
          { label: 'Max', num: true }, { label: 'Window', num: true },
          { label: 'TR', num: true }, { label: 'Rungs', num: true },
          { label: 'Possible waits' }],
        phases.map(function (entry) {
          var waits = [];
          for (var n = 0; n <= entry.rungs; n += 1) {
            waits.push(H.round(entry.min + n * entry.trSeconds, 2));
          }
          return {
            className: entry.rungs === 0 ? 'total' : '',
            cells: [
              { text: entry.trial.name },
              { text: entry.phase.name || 'Phase' },
              { text: H.round(entry.min, 2) + ' s', num: true },
              { text: H.round(entry.max, 2) + ' s', num: true },
              { text: H.round(entry.window, 2) + ' s', num: true },
              { text: entry.trSeconds + ' s', num: true },
              { text: H.round(entry.window, 2) + ' / ' + entry.trSeconds + ' = '
                + entry.rungs, num: true },
              { text: waits.join(', ') + ' s' }
            ]
          };
        }),
        { caption: 'How many TR steps each jittered phase has room for' }
      ));

      /* The sizing rule in the other direction: what window buys N rungs. */
      var trs = [];
      phases.forEach(function (entry) {
        if (trs.indexOf(entry.trSeconds) < 0) trs.push(entry.trSeconds);
      });
      var counts = [1, 2, 3, 4, 5, 6, 8];
      ladderHost.appendChild(App.dataTable(
        [{ label: 'Rungs wanted', num: true }].concat(trs.map(function (tr) {
          return { label: 'Window at TR ' + tr + ' s', num: true };
        })),
        counts.map(function (count) {
          return [{ text: String(count), num: true }].concat(trs.map(function (tr) {
            return { text: H.round(count * tr, 2) + ' s', num: true };
          }));
        }),
        { caption: 'Window a phase needs for a given number of TR steps' }
      ));

      var sample = phases[0];
      ladderNote.textContent = 'A jittered wait moves in whole TRs, so the number of steps '
        + 'a phase has is set by how wide its window is, not by how long the waits are: '
        + 'rungs = (max - min) / TR. ' + sample.trial.name + ' / '
        + (sample.phase.name || 'Phase') + ' spans '
        + H.round(sample.window, 2) + ' s at a ' + sample.trSeconds + ' s TR, so it has '
        + sample.rungs + ' step' + (sample.rungs === 1 ? '' : 's') + ' and '
        + (sample.rungs + 1) + ' possible waits. Two phases with very different timings '
        + 'get the same number of steps whenever their windows are the same width - which '
        + 'is why several rows above look alike. The worked example in the source runs '
        + 'to 4 steps, which needs a window of 4 TRs - '
        + H.round(4 * sample.trSeconds, 2) + ' s at this TR.';
    }, owner);

    /* --- the distributions themselves ----------------------------------- */

    var distHost = App.h('div', {});

    App.registerView(function () {
      App.clear(distHost);
      var settings = M.jitterSettings(App.state);
      var phases = jitteredPhases();
      if (!phases.length) return;

      if (settings.mode !== 'geometric') {
        distHost.appendChild(App.h('div', {
          class: 'notice',
          text: 'Waits are flat across their window, so each averages its midpoint. Switch '
            + 'on the truncated geometric above and every jittered phase in the design is '
            + 'tabulated here, rung by rung.'
        }));
        distHost.appendChild(App.dataTable(
          [{ label: 'Trial' }, { label: 'Phase' }, { label: 'Window', num: true },
            { label: 'Expected wait', num: true }],
          phases.map(function (entry) {
            return [
              { text: entry.trial.name }, { text: entry.phase.name || 'Phase' },
              { text: H.round(entry.min, 2) + ' - ' + H.round(entry.max, 2) + ' s', num: true },
              { text: H.round((entry.min + entry.max) / 2, 2) + ' s', num: true }
            ];
          }),
          { caption: 'Flat-window means, as the planner is currently sizing them' }
        ));
        return;
      }

      (App.state.trials || []).forEach(function (trial) {
        var trSeconds = M.representativeTr(App.state, App.boot, trial);
        var profile = M.jitterProfile(trial, trSeconds, settings);
        if (!profile.phases.length) return;

        distHost.appendChild(App.h('h3', {
          class: 'sub-head',
          text: trial.name + '  -  ' + (profile.meanDeltaSeconds < 0 ? 'saves ' : 'costs ')
            + H.round(Math.abs(profile.meanDeltaSeconds), 2)
            + ' s per trial against a flat window'
        }));

        profile.phases.forEach(function (entry) {
          var readout = App.h('div', { class: 'readout' });
          readout.appendChild(App.readoutCell('Phase',
            'no. ' + (entry.index + 1) + ', ' + entry.name));
          readout.appendChild(App.readoutCell('Window',
            entry.min + ' - ' + entry.statedMax + ' s'));
          readout.appendChild(App.readoutCell('Steps',
            entry.nMax + ' TR' + (entry.nMax === 1 ? '' : 's') + ', '
              + (entry.nMax + 1) + ' possible wait' + (entry.nMax === 0 ? '' : 's')));
          readout.appendChild(App.readoutCell('Longest wait', entry.effMax + ' s',
            entry.effMax < entry.statedMax - 0.005 ? 'accent' : ''));
          readout.appendChild(App.readoutCell('Expected wait', entry.mean + ' s'));
          readout.appendChild(App.readoutCell('Anticipatable trials',
            H.round(entry.capProbability * 100, 2) + ' %',
            entry.degenerate ? 'alert' : ''));
          distHost.appendChild(readout);

          if (entry.degenerate) {
            distHost.appendChild(App.h('div', {
              class: 'notice',
              text: entry.name + ' spans ' + H.round(entry.statedMax - entry.min, 2)
                + ' s, less than one ' + trSeconds + ' s TR, so there is nowhere for it to '
                + 'step: it is a fixed ' + entry.min + ' s wait. Give it a max of at least '
                + H.round(entry.min + trSeconds, 2) + ' s to get one step.'
            }));
            return;
          }

          var draw = M.truncGeometric(entry.min, entry.statedMax, trSeconds, settings.p,
            settings.truncation === 'trs' ? settings.nMaxCap : undefined);
          distHost.appendChild(jitterDistributionTable(draw, entry.name,
            trial.name + ' / ' + entry.name + ' - P(delay = n TRs) at p = '
              + H.round(settings.p, 2) + ', TR ' + trSeconds + ' s'
              + (entry.limitedBy === 'cap' ? ', capped at ' + entry.nMax + ' TR'
                + (entry.nMax === 1 ? '' : 's') : '')));
        });
      });
    }, owner);

    /* --- settings ------------------------------------------------------- */

    var settingsCard = App.card('Sampling',
      'How the wait in a jittered phase is drawn', [
        App.h('div', {
          class: 'notice',
          text: 'Off by default: waits are flat across their window and average the '
            + 'midpoint. Turned on, a wait is a whole number of TRs drawn from a truncated '
            + 'geometric - the only distribution that tells the participant nothing about '
            + 'when the stimulus is due, because the chance it lands on the next TR stays p '
            + 'however long they have already waited. This changes what a trial is expected '
            + 'to cost, so it changes the hours the study needs.'
        }),
        App.checkbox({
          owner: owner,
          label: 'Draw jittered waits from a truncated geometric distribution',
          hint: 'Ashby, Statistical Analysis of fMRI Data, ch. 5',
          get: function (state) { return M.jitterSettings(state).mode === 'geometric'; },
          set: function (value, state) {
            if (!state.jitter) state.jitter = M.defaultJitter();
            state.jitter.mode = value ? 'geometric' : 'uniform';
          }
        }),
        App.slider({
          owner: owner, label: 'p', min: 0.02, max: 0.98, step: 0.01, decimals: 2, unit: '',
          hint: 'Low approaches a flat window - what the planner does with this off; '
            + '0.5 is the textbook default; high pins every wait to its minimum',
          get: function (state) { return M.jitterSettings(state).p; },
          set: function (value, state) {
            if (!state.jitter) state.jitter = M.defaultJitter();
            state.jitter.p = value;
          },
          disabledWhen: function (state) {
            return M.jitterSettings(state).mode !== 'geometric';
          }
        }),
        App.segmented({
          owner: owner, label: 'Truncate the longest delay',
          hint: 'An untruncated geometric puts some probability on arbitrarily long '
            + 'waits - cheap in a lab, expensive in a scanner',
          options: [
            { value: 'window', label: 'At the phase max',
              hint: 'The cap follows whatever each phase already says' },
            { value: 'trs', label: 'At a stated number of TRs',
              hint: 'One limit for the whole design, as the source states it' }
          ],
          get: function (state) { return M.jitterSettings(state).truncation; },
          set: function (value, state) {
            if (!state.jitter) state.jitter = M.defaultJitter();
            state.jitter.truncation = value;
          },
          disabledWhen: function (state) {
            return M.jitterSettings(state).mode !== 'geometric';
          }
        }),
        App.slider({
          owner: owner, label: 'Longest delay allowed', min: 0, max: 20, step: 1,
          unit: 'TR',
          hint: 'Applied on top of each phase’s own max, so it can only tighten',
          get: function (state) { return M.jitterSettings(state).nMaxCap; },
          set: function (value, state) {
            if (!state.jitter) state.jitter = M.defaultJitter();
            state.jitter.nMaxCap = Math.max(0, Math.round(value));
          },
          disabledWhen: function (state) {
            var settings = M.jitterSettings(state);
            return settings.mode !== 'geometric' || settings.truncation !== 'trs';
          }
        })
      ]);

    panel.appendChild(settingsCard);
    panel.appendChild(App.card('How many steps a phase has',
      'Rungs = (max - min) / TR', [ladderHost, ladderNote]));
    panel.appendChild(App.card('Delay distribution',
      'Every jittered phase, rung by rung', [distHost]));
    return panel;
  }

  function buildHrf() {
    var owner = 'hrf';
    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'HRF model and objectives' }),
      App.h('p', {
        text: 'The haemodynamic response every timing decision is solved against, and what '
          + 'the planner treats as separated. Change the definition here and every trial '
          + 'design re-solves against it. How the wait in a jittered phase is drawn lives '
          + 'in the Jitter panel.'
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
            if (App.act('hrf.reset')) App.toast('Canonical HRF restored', 'ok');
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
    buildHrf: function () { ready(); return buildHrf(); },
    buildJitter: function () { ready(); return buildJitter(); },
    buildRoles: function () { ready(); return buildRoles(); }
  };
}(window));
