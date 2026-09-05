/* Acquisition parameter card editor.
 *
 * Nothing about a card is fixed: the parameters, the console pages they sit
 * on, the card's name and its role are all editable, and cards can be created
 * from a base, duplicated, renamed and deleted.  Edits update the in-memory
 * card immediately, re-derive the acquisition values the solver depends on
 * (TR, TE, slices, matrix, series duration) and re-solve the whole design.
 * Saving writes the JSON back to disk with a timestamped backup. */

(function (global) {
  'use strict';

  var App, M, H;

  var DERIVED_PARAMETERS = ['dyn scans', 'dummy scans', 'total scan duration'];
  var SECTION_ORDER = ['INFO PAGE', 'GEOMETRY', 'CONTRAST', 'POST/PROC', 'MOTION', 'DYN/ANG'];

  var ROLE_LABELS = {
    functional: 'Functional EPI',
    reference: 'Reference and field maps',
    structural: 'Structural and localiser',
    other: 'Other'
  };

  var state = {
    active: null,
    filter: '',
    dirty: {},
    collapsed: {},
    listHost: null,
    editorHost: null
  };

  /* ------------------------------------------------------------- parsing */

  function sectionsOf(data) {
    var keys = Object.keys(data || {}).filter(function (key) {
      return key.charAt(0) !== '_' && Array.isArray(data[key]);
    });
    var known = SECTION_ORDER.filter(function (section) { return keys.indexOf(section) >= 0; });
    var extra = keys.filter(function (section) { return SECTION_ORDER.indexOf(section) < 0; });
    return known.concat(extra);
  }

  function metaOf(slug) {
    var data = App.protocols[slug] || {};
    var meta = data._meta || {};
    return {
      label: meta.label || slug,
      role: meta.role || 'other',
      note: meta.note || ''
    };
  }

  function findValue(data, parameter) {
    var target = String(parameter).trim().toLowerCase();
    var found = '';
    sectionsOf(data).forEach(function (section) {
      data[section].forEach(function (row) {
        if (!found && String(row.parameter || '').trim().toLowerCase() === target) {
          found = String(row.value);
        }
      });
    });
    return found;
  }

  function parseDurationSeconds(text) {
    var parts = String(text || '').trim().split(':');
    if (!parts.length || parts[0] === '') return 0;
    var seconds = 0;
    for (var i = 0; i < parts.length; i += 1) {
      var value = parseFloat(parts[i]);
      if (!isFinite(value)) return 0;
      seconds = seconds * 60 + value;
    }
    return seconds;
  }

  function pad(value) { return (value < 10 ? '0' : '') + Math.floor(value); }

  function formatDuration(seconds) {
    var value = Math.max(0, Number(seconds) || 0);
    var minutes = Math.floor(value / 60);
    var rest = value - minutes * 60;
    if (minutes >= 60) {
      var hours = Math.floor(minutes / 60);
      return pad(hours) + ':' + pad(minutes % 60) + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
    }
    return pad(minutes) + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  function numbersIn(text) {
    var matches = String(text || '').match(/[-+]?\d*\.?\d+/g);
    return (matches || []).map(Number);
  }

  function headlineFrom(data) {
    var trTe = numbersIn(findValue(data, 'Act. TR/TE (ms)'));
    return {
      duration: findValue(data, 'Total scan duration'),
      tr: trTe.length ? String(trTe[0]) : '',
      te: trTe.length > 1 ? String(trTe[1]) : '',
      voxel: findValue(data, 'ACQ voxel MPS (mm)'),
      slices: findValue(data, 'slices'),
      mbFactor: findValue(data, 'MB Factor'),
      senseP: findValue(data, 'P reduction (AP)'),
      flip: findValue(data, 'Flip angle (deg)'),
      dynScans: findValue(data, 'dyn scans'),
      dummyScans: findValue(data, 'dummy scans'),
      matrix: findValue(data, 'Reconstruction matrix'),
      technique: findValue(data, 'technique'),
      scanMode: findValue(data, 'Scan mode')
    };
  }

  /* Re-derive everything the design solver reads out of this card. */
  function syncAcquisition(slug) {
    var data = App.protocols[slug];
    if (!data) return;
    var trTe = numbersIn(findValue(data, 'Act. TR/TE (ms)'));
    App.boot.acquisition[slug] = {
      trMs: trTe.length ? trTe[0] : 0,
      teMs: trTe.length > 1 ? trTe[1] : 0,
      durationSeconds: parseDurationSeconds(findValue(data, 'Total scan duration'))
    };
    var meta = metaOf(slug);
    var entry = (App.boot.manifest || []).filter(function (item) {
      return item.slug === slug;
    })[0];
    if (entry) {
      entry.headline = headlineFrom(data);
      entry.label = meta.label;
      entry.role = meta.role;
      entry.note = meta.note;
      entry.sections = sectionsOf(data);
      entry.parameterCount = sectionsOf(data).reduce(function (total, section) {
        return total + data[section].length;
      }, 0);
    }
  }

  /* Absorb a card response from the server: data, manifest and acquisition. */
  function absorb(result) {
    if (!result || result.error) throw new Error((result && result.error) || 'request failed');
    if (result.slug && result.data) App.protocols[result.slug] = result.data;
    if (result.manifest) App.boot.manifest = result.manifest;
    if (result.acquisition) {
      Object.keys(result.acquisition).forEach(function (slug) {
        App.boot.acquisition[slug] = result.acquisition[slug];
      });
    }
    if (result.protocols) App.protocols = result.protocols;
    return result;
  }

  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || (response.status + ' ' + response.statusText));
        return body;
      });
    });
  }

  /* ---------------------------------------------------------------- view */

  function boundRuns(slug) {
    return (App.state.runs || []).filter(function (run) { return run.protocol === slug; });
  }

  function structuralUses(slug) {
    return (App.state.sessions || []).filter(function (session) {
      return (session.blocks || []).some(function (block) {
        return block.kind === 'structural' && block.protocol === slug
          && block.enabled !== false;
      });
    });
  }

  function solvedUpdatesFor(slug) {
    var runs = boundRuns(slug);
    if (!runs.length || !App.report) return null;
    var record = App.report.runs.filter(function (item) {
      return item.id === runs[0].id;
    })[0];
    if (!record || record.missing) return null;
    return {
      run: record,
      updates: {
        'dyn scans': String(record.acquisition.dynScansSolved),
        'dummy scans': String(record.acquisition.dummyScansSolved),
        'Total scan duration': record.acquisition.durationSolved
      }
    };
  }

  function renderList() {
    var host = state.listHost;
    App.clear(host);
    var groups = {};
    (App.boot.manifest || []).forEach(function (entry) {
      if (!groups[entry.role]) groups[entry.role] = [];
      groups[entry.role].push(entry);
    });
    var order = ['functional', 'reference', 'structural', 'other'];

    order.forEach(function (role) {
      if (!groups[role]) return;
      host.appendChild(App.h('div', { class: 'rail-group', text: ROLE_LABELS[role] || role }));
      groups[role].forEach(function (entry) {
        var used = boundRuns(entry.slug).map(function (run) { return run.name; })
          .concat(structuralUses(entry.slug).map(function (session) { return session.name; }));
        var button = App.h('button', {
          class: 'proto-item' + (state.active === entry.slug ? ' active' : ''), type: 'button'
        }, [
          App.h('div', { class: 'name' }, [
            App.h('span', { text: entry.label }),
            state.dirty[entry.slug] ? App.h('span', { class: 'dirty', text: '  *' }) : null
          ]),
          App.h('div', {
            class: 'meta',
            text: (entry.headline.tr ? 'TR ' + entry.headline.tr + ' ms  ' : '')
              + (entry.headline.duration ? entry.headline.duration + '  ' : '')
              + entry.parameterCount + ' params'
          }),
          used.length ? App.h('div', { class: 'meta' }, [
            App.h('span', { class: 'pill leaf', text: 'used by: ' + used.join(', ') })
          ]) : null
        ]);
        button.addEventListener('click', function () { select(entry.slug); });
        host.appendChild(button);
      });
    });
  }

  function inputFor(row, slug, onEdit) {
    var raw = String(row.value);
    var lowered = raw.trim().toLowerCase();
    var input;

    if (lowered === 'yes' || lowered === 'no') {
      input = App.h('select', {}, [
        App.h('option', { value: 'yes', text: 'yes' }),
        App.h('option', { value: 'no', text: 'no' })
      ]);
      input.value = lowered;
    } else if (/^[-+]?\d*\.?\d+$/.test(raw.trim()) && raw.trim() !== '') {
      input = App.h('input', { type: 'number', step: 'any', value: raw.trim() });
    } else {
      input = App.h('input', { type: 'text', value: raw });
    }

    function commit() {
      var value = String(input.value);
      if (value === String(row.value)) return;
      row.value = value;
      state.dirty[slug] = true;
      onEdit();
    }
    input.addEventListener('change', commit);
    if (input.tagName !== 'SELECT') input.addEventListener('blur', commit);
    return input;
  }

  /* The parameter name is editable too, so a card can carry whatever the
   * console actually shows rather than whatever shipped with the planner. */
  function parameterNameInput(row, slug, onEdit, onRename) {
    var input = App.h('input', {
      type: 'text', class: 'param-name', value: row.parameter, title: row.parameter
    });
    function commit() {
      var value = String(input.value).trim();
      if (!value) { input.value = row.parameter; return; }
      if (value === row.parameter) return;
      row.parameter = value;
      state.dirty[slug] = true;
      onEdit();
      if (onRename) onRename();
    }
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    return input;
  }

  function renderEditor() {
    var host = state.editorHost;
    App.clear(host);
    if (!state.active || !App.protocols[state.active]) {
      host.appendChild(App.h('div', { class: 'notice', text: 'Select a card to edit.' }));
      return;
    }

    var slug = state.active;
    var data = App.protocols[slug];
    var meta = metaOf(slug);
    var solved = solvedUpdatesFor(slug);
    var updates = solved ? solved.updates : {};

    function onEdit() {
      syncAcquisition(slug);
      renderList();
      App.refresh();
      renderHeadline();
    }

    /* --- headline ------------------------------------------------------ */
    var headlineHost = App.h('div', { class: 'readout' });
    function renderHeadline() {
      App.clear(headlineHost);
      var current = headlineFrom(App.protocols[slug]);
      [
        ['Duration', current.duration], ['TR', current.tr ? current.tr + ' ms' : ''],
        ['TE', current.te ? current.te + ' ms' : ''], ['Voxel', current.voxel],
        ['Slices', current.slices], ['Matrix', current.matrix],
        ['Multiband', current.mbFactor], ['In-plane', current.senseP],
        ['Flip', current.flip ? current.flip + ' deg' : ''],
        ['Dynamics', current.dynScans], ['Dummies', current.dummyScans],
        ['Technique', [current.technique, current.scanMode].filter(Boolean).join(' / ')]
      ].forEach(function (pair) {
        headlineHost.appendChild(App.h('div', { class: 'cell' }, [
          App.h('div', { class: 'k', text: pair[0] }),
          App.h('div', { class: 'v', text: pair[1] || '-' })
        ]));
      });
    }
    renderHeadline();

    /* --- card identity -------------------------------------------------- */
    var labelInput = App.h('input', { type: 'text', value: meta.label });
    var roleSelect = App.h('select', {}, Object.keys(ROLE_LABELS).map(function (role) {
      return App.h('option', { value: role, text: ROLE_LABELS[role] });
    }));
    roleSelect.value = meta.role;
    var noteInput = App.h('input', {
      type: 'text', value: meta.note, placeholder: 'What this card is for'
    });
    var renameFile = App.h('input', { type: 'checkbox' });

    function commitMeta() {
      data._meta = {
        label: String(labelInput.value).trim() || slug,
        role: roleSelect.value,
        note: noteInput.value
      };
      state.dirty[slug] = true;
      onEdit();
    }
    [labelInput, noteInput].forEach(function (input) {
      input.addEventListener('change', commitMeta);
      input.addEventListener('blur', commitMeta);
    });
    roleSelect.addEventListener('change', commitMeta);

    var identityCard = App.card('Card', slug, [
      App.h('div', { class: 'control stack' }, [
        App.h('label', {}, [App.h('span', { text: 'Name' })]), labelInput
      ]),
      App.h('div', { class: 'control stack' }, [
        App.h('label', {}, [App.h('span', { text: 'Role' })]), roleSelect
      ]),
      App.h('div', { class: 'control stack' }, [
        App.h('label', {}, [App.h('span', { text: 'Note' })]), noteInput
      ]),
      App.h('label', { class: 'checkline' }, [
        renameFile, App.h('span', { text: 'Rename the file to match the name' })
      ]),
      App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Rename', 'Write the name into the card, and the file if asked',
          function () { renameCard(slug, labelInput.value, renameFile.checked); }),
        App.iconButton('Duplicate card', 'Copy this card under a new name',
          function () { duplicateCard(slug); }),
        App.iconButton('New card from this one',
          'Create a fresh card starting from these parameters',
          function () { createCard(slug); }),
        App.iconButton('Delete card', 'Remove this card from disk',
          function () { deleteCard(slug); }, 'danger')
      ])
    ]);

    /* --- toolbar -------------------------------------------------------- */
    var search = App.h('input', {
      type: 'text', value: state.filter, placeholder: 'Filter parameters'
    });
    search.addEventListener('input', function () {
      state.filter = search.value.toLowerCase();
      renderSections();
    });

    var actions = App.h('div', { class: 'btn-row' }, [
      App.h('button', {
        class: 'btn sm', type: 'button', text: 'Save to disk',
        onclick: function () { save(slug); }
      }),
      App.iconButton('Reload from disk', 'Discard unsaved edits',
        function () { reload(slug); }),
      solved ? App.h('button', {
        class: 'btn gold sm', type: 'button',
        text: 'Apply solved timing (' + solved.run.name + ')',
        title: 'Write the solved dynamics, dummies and duration into this card',
        onclick: function () { applyDerived(solved.run.id); }
      }) : null,
      App.iconButton('Copy card as Markdown', 'Every page and parameter, as a Markdown table',
        function () { App.copy(cardMarkdown(slug), 'Acquisition card'); }),
      App.iconButton('Copy card for Word', 'Paste into Word as real tables',
        function () { copyCardForWord(slug); }),
      App.iconButton('Backups', 'Restore a timestamped snapshot',
        function () { showBackups(slug); })
    ]);

    /* --- pages and parameters ------------------------------------------- */
    var sectionsHost = App.h('div', {});

    function addRow(section) {
      data[section].push({ parameter: 'New parameter', value: '', indent: 0 });
      state.dirty[slug] = true;
      onEdit();
      renderSections();
    }

    function renderSections() {
      App.clear(sectionsHost);
      sectionsOf(data).forEach(function (section) {
        var all = data[section];
        var rows = all.filter(function (row) {
          if (!state.filter) return true;
          return (String(row.parameter) + ' ' + String(row.value))
            .toLowerCase().indexOf(state.filter) >= 0;
        });

        var body = App.h('div', { class: 'section-body' });
        rows.forEach(function (row) {
          var position = all.indexOf(row);
          var key = String(row.parameter).trim().toLowerCase();
          var isDerived = DERIVED_PARAMETERS.indexOf(key) >= 0 && !!solved;
          var input = inputFor(row, slug, onEdit);
          var solvedValue = updates[row.parameter] !== undefined
            ? updates[row.parameter]
            : updates[Object.keys(updates).filter(function (name) {
              return name.toLowerCase() === key;
            })[0]];
          var mismatch = isDerived && solvedValue !== undefined
            && String(solvedValue) !== String(row.value);

          body.appendChild(App.h('div', {
            class: 'param-row editable' + (isDerived ? ' derived' : '')
              + (mismatch ? ' changed' : ''),
            title: row.parameter
          }, [
            App.h('div', {
              class: 'param-label',
              style: 'padding-left:' + (Number(row.indent) || 0) * 14 + 'px'
            }, [parameterNameInput(row, slug, onEdit, renderSections)]),
            input,
            App.h('div', { class: 'param-tools' }, [
              App.iconButton('⇥', 'Indent this parameter', function () {
                row.indent = Math.min(4, (Number(row.indent) || 0) + 1);
                state.dirty[slug] = true;
                onEdit();
                renderSections();
              }),
              App.iconButton('⇤', 'Outdent this parameter', function () {
                row.indent = Math.max(0, (Number(row.indent) || 0) - 1);
                state.dirty[slug] = true;
                onEdit();
                renderSections();
              }),
              App.iconButton('↑', 'Move up', function () {
                if (position <= 0) return;
                var moved = all.splice(position, 1)[0];
                all.splice(position - 1, 0, moved);
                state.dirty[slug] = true;
                onEdit();
                renderSections();
              }),
              App.iconButton('↓', 'Move down', function () {
                if (position >= all.length - 1) return;
                var moved = all.splice(position, 1)[0];
                all.splice(position + 1, 0, moved);
                state.dirty[slug] = true;
                onEdit();
                renderSections();
              }),
              App.iconButton('×', 'Delete this parameter', function () {
                all.splice(position, 1);
                state.dirty[slug] = true;
                onEdit();
                renderSections();
              }, 'danger')
            ]),
            App.h('span', {
              class: 'flag',
              text: mismatch ? '!' : (isDerived ? '=' : ''),
              title: mismatch ? 'Solver says ' + solvedValue
                : (isDerived ? 'Derived from the design' : '')
            })
          ]));
        });

        body.appendChild(App.h('div', { class: 'section-foot' }, [
          App.iconButton('Add parameter', 'Append a row to this page',
            function () { addRow(section); }),
          App.iconButton('Rename page', 'Change this page name', function () {
            var next = global.prompt('Page name', section);
            if (!next || next === section) return;
            if (data[next]) { App.toast('That page already exists.', 'bad'); return; }
            var reordered = {};
            Object.keys(data).forEach(function (key) {
              if (key === section) reordered[next] = data[key];
              else reordered[key] = data[key];
            });
            App.protocols[slug] = reordered;
            data = reordered;
            state.dirty[slug] = true;
            onEdit();
            renderSections();
          }),
          App.iconButton('Delete page', 'Remove this page and every parameter on it',
            function () {
              if (sectionsOf(data).length <= 1) {
                App.toast('A card needs at least one page.', 'bad');
                return;
              }
              if (!global.confirm('Delete the page "' + section + '" and its '
                + all.length + ' parameters?')) return;
              delete data[section];
              state.dirty[slug] = true;
              onEdit();
              renderSections();
            }, 'danger')
        ]));

        var open = !state.collapsed[section];
        var head = App.h('button', { class: 'section-head', type: 'button' }, [
          App.h('span', { text: (open ? '−  ' : '+  ') + section }),
          App.h('span', { class: 'flag', text: rows.length + ' parameters' })
        ]);
        head.addEventListener('click', function () {
          state.collapsed[section] = !state.collapsed[section];
          renderSections();
        });
        body.style.display = open ? '' : 'none';
        sectionsHost.appendChild(App.h('div', { class: 'section-block' }, [head, body]));
      });

      sectionsHost.appendChild(App.h('div', { class: 'section-foot standalone' }, [
        App.iconButton('Add page', 'Create a new console page on this card', function () {
          var name = global.prompt('New page name', 'NEW PAGE');
          if (!name) return;
          if (data[name]) { App.toast('That page already exists.', 'bad'); return; }
          data[name] = [{ parameter: 'New parameter', value: '', indent: 0 }];
          state.dirty[slug] = true;
          onEdit();
          renderSections();
        })
      ]));
    }
    renderSections();

    host.appendChild(identityCard);
    host.appendChild(App.flushCard(meta.label, slug, [
      App.h('div', { style: 'padding:14px 14px 0' }, [headlineHost]),
      App.h('div', { style: 'padding:12px 14px', class: 'split-inline' }, [search, actions]),
      sectionsHost
    ]));
  }

  /* ------------------------------------------------------------ markdown */

  function cardTables(slug) {
    var data = App.protocols[slug];
    var meta = metaOf(slug);
    return sectionsOf(data).map(function (section) {
      return {
        caption: meta.label + ' - ' + section,
        columns: ['Parameter', 'Value'],
        numeric: [false, false],
        rows: data[section].map(function (row) {
          var indent = Number(row.indent) || 0;
          return [(indent ? '    '.repeat(indent) : '') + row.parameter, String(row.value)];
        })
      };
    });
  }

  function cardMarkdown(slug) {
    var meta = metaOf(slug);
    var data = App.protocols[slug];
    var lines = ['## ' + meta.label + ' (' + slug + ')', ''];
    if (meta.note) lines.push(meta.note, '');
    sectionsOf(data).forEach(function (section) {
      lines.push('### ' + section, '');
      lines.push(M.mdTable(['Parameter', 'Value'], data[section].map(function (row) {
        var indent = Number(row.indent) || 0;
        return [(indent ? '&nbsp;'.repeat(indent * 4) + ' ' : '') + row.parameter,
          String(row.value)];
      })));
      lines.push('');
    });
    return lines.join('\n');
  }

  /* Word takes one table per page, stacked, so the card pastes in whole. */
  function copyCardForWord(slug) {
    var meta = metaOf(slug);
    var tables = cardTables(slug);
    var merged = {
      caption: meta.label + ' (' + slug + ')',
      columns: ['Page', 'Parameter', 'Value'],
      numeric: [false, false, false],
      rows: []
    };
    tables.forEach(function (table) {
      var page = table.caption.split(' - ').pop();
      table.rows.forEach(function (row, index) {
        merged.rows.push([index === 0 ? page : '', row[0], row[1]]);
      });
    });
    App.copyRichTable(merged, 'Acquisition card');
  }

  /* -------------------------------------------------------------- server */

  function save(slug) {
    api('/api/protocols/' + encodeURIComponent(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: App.protocols[slug] })
    }).then(function (result) {
      absorb(result);
      delete state.dirty[slug];
      syncAcquisition(slug);
      renderList();
      renderEditor();
      App.refresh();
      App.toast('Saved ' + slug + '.json'
        + (result.backup ? ' (backup ' + result.backup + ')' : ''), 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function reload(slug) {
    api('/api/protocols/' + encodeURIComponent(slug)).then(function (result) {
      absorb(result);
      delete state.dirty[slug];
      syncAcquisition(slug);
      renderList();
      renderEditor();
      App.refresh();
      App.toast('Reloaded ' + slug + '.json from disk');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function createCard(base) {
    var label = global.prompt(base
      ? 'Name for the new card, starting from ' + metaOf(base).label
      : 'Name for the new card', base ? metaOf(base).label + ' variant' : 'New EPI card');
    if (!label) return;
    api('/api/protocols', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: label,
        role: base ? metaOf(base).role : 'functional',
        note: base ? metaOf(base).note : '',
        base: base || null
      })
    }).then(function (result) {
      absorb(result);
      syncAcquisition(result.slug);
      select(result.slug);
      App.refresh();
      App.toast('Created ' + result.slug + '.json', 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function duplicateCard(slug) {
    api('/api/protocols/' + encodeURIComponent(slug) + '/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: metaOf(slug).label + ' (copy)' })
    }).then(function (result) {
      absorb(result);
      syncAcquisition(result.slug);
      select(result.slug);
      App.refresh();
      App.toast('Duplicated as ' + result.slug + '.json', 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  /* Renaming the file moves every reference in the design with it, so a run
   * design or a session's sequence never ends up pointing at nothing. */
  function repoint(from, to) {
    if (from === to) return;
    (App.state.runs || []).forEach(function (run) {
      if (run.protocol === from) run.protocol = to;
    });
    (App.state.sessions || []).forEach(function (session) {
      (session.blocks || []).forEach(function (block) {
        if (block.kind === 'structural' && block.protocol === from) block.protocol = to;
      });
    });
  }

  function renameCard(slug, label, renameFile) {
    var clean = String(label || '').trim();
    if (!clean) { App.toast('A card needs a name.', 'bad'); return; }
    api('/api/protocols/' + encodeURIComponent(slug) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: clean, slug: renameFile ? clean : null })
    }).then(function (result) {
      if (result.renamed && result.renamed.from !== result.renamed.to) {
        delete App.protocols[result.renamed.from];
        delete App.boot.acquisition[result.renamed.from];
        repoint(result.renamed.from, result.renamed.to);
      }
      absorb(result);
      delete state.dirty[slug];
      syncAcquisition(result.slug);
      select(result.slug);
      App.refresh();
      App.toast('Renamed to "' + clean + '"'
        + (result.renamed && result.renamed.from !== result.renamed.to
          ? ' (' + result.renamed.to + '.json)' : ''), 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function deleteCard(slug) {
    var used = boundRuns(slug).map(function (run) { return run.name; })
      .concat(structuralUses(slug).map(function (session) { return session.name; }));
    var warning = 'Delete ' + slug + '.json?'
      + (used.length ? '\n\nStill used by: ' + used.join(', ')
        + '.\nThose will fall back to default acquisition values.' : '')
      + '\n\nA backup is kept in scanner-parameters/.backups/.';
    if (!global.confirm(warning)) return;

    api('/api/protocols/' + encodeURIComponent(slug), { method: 'DELETE' })
      .then(function (result) {
        delete App.protocols[slug];
        delete App.boot.acquisition[slug];
        absorb(result);
        state.active = null;
        renderList();
        renderEditor();
        App.refresh();
        App.toast('Deleted ' + slug + '.json');
      }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function applyDerived(runId) {
    if (!App.report) return;
    var record = App.report.runs.filter(function (item) { return item.id === runId; })[0];
    if (!record || record.missing) return;
    api('/api/apply-derived', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: record.protocol,
        updates: {
          'dyn scans': String(record.acquisition.dynScansSolved),
          'dummy scans': String(record.acquisition.dummyScansSolved),
          'Total scan duration': record.acquisition.durationSolved
        }
      })
    }).then(function (result) {
      absorb(result);
      delete state.dirty[record.protocol];
      syncAcquisition(record.protocol);
      renderList();
      if (state.active === record.protocol) renderEditor();
      App.refresh();
      App.toast('Wrote solved dynamics and duration into ' + record.protocol + '.json', 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function showBackups(slug) {
    api('/api/protocols/' + encodeURIComponent(slug) + '/backups').then(function (result) {
      var host = state.editorHost;
      var rows = (result.backups || []).map(function (backup) {
        return [
          { text: backup.file },
          { text: (backup.size / 1024).toFixed(1) + ' kB', num: true },
          { text: new Date(backup.modified * 1000).toLocaleString(), num: true },
          { html: '<button class="btn quiet sm" data-restore="' + backup.file
            + '" type="button">Restore</button>', copy: '' }
        ];
      });
      var node = App.card('Backups for ' + slug, rows.length + ' snapshots', [
        rows.length ? App.dataTable(
          [{ label: 'File' }, { label: 'Size', num: true }, { label: 'Saved', num: true },
            { label: '' }],
          rows,
          { caption: 'Backups for ' + slug }
        ) : App.h('div', {
          class: 'notice', text: 'No backups yet; one is written before every save.'
        }),
        App.h('div', { class: 'btn-row mt' }, [
          App.iconButton('Back to the editor', '', function () { renderEditor(); })
        ])
      ]);
      node.addEventListener('click', function (event) {
        var file = event.target.getAttribute && event.target.getAttribute('data-restore');
        if (!file) return;
        api('/api/protocols/' + encodeURIComponent(slug) + '/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: file })
        }).then(function (restored) {
          absorb(restored);
          syncAcquisition(slug);
          renderList();
          renderEditor();
          App.refresh();
          App.toast('Restored ' + file, 'ok');
        }).catch(function (error) { App.toast(error.message, 'bad'); });
      });
      App.clear(host);
      host.appendChild(node);
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function select(slug) {
    state.active = slug;
    state.filter = '';
    renderList();
    renderEditor();
  }

  /* --------------------------------------------------------------- build */

  function build() {
    App = global.PlannerApp;
    M = global.PlannerModel;
    H = M.helpers;

    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'Acquisition parameter cards' }),
      App.h('p', {
        text: 'Every parameter on every card is editable, and so is the set of parameters: '
          + 'add and remove rows and pages, duplicate a card, start a new one from a base, '
          + 'rename it. Edits feed straight into the solver; saving writes the JSON file '
          + 'with a timestamped backup.'
      })
    ]));

    state.listHost = App.h('div', { class: 'proto-list' });
    state.editorHost = App.h('div', {});

    var listCard = App.flushCard('Cards', null, [state.listHost],
      App.h('div', { class: 'btn-row' }, [
        App.h('button', {
          class: 'btn sm', type: 'button', text: 'New card',
          title: 'Create a blank card',
          onclick: function () { createCard(null); }
        })
      ]));
    panel.appendChild(App.h('div', { class: 'proto-layout' }, [listCard, state.editorHost]));

    App.registerView(function () {
      renderList();
      if (state.active && !state.editorHost.firstChild) renderEditor();
    });

    var firstFunctional = (App.boot.manifest || []).filter(function (entry) {
      return entry.role === 'functional';
    })[0];
    state.active = firstFunctional ? firstFunctional.slug
      : ((App.boot.manifest || [])[0] || {}).slug || null;
    renderList();
    renderEditor();
    return panel;
  }

  global.PlannerProtocols = {
    build: build,
    select: select,
    applyDerived: applyDerived,
    findValue: findValue,
    headlineFrom: headlineFrom,
    formatDuration: formatDuration,
    parseDurationSeconds: parseDurationSeconds,
    cardMarkdown: cardMarkdown,
    cardTables: cardTables
  };
}(window));
