/* MRI Experimental Design Planner - interface layer.
 *
 * Controls are declarative: every slider, field and toggle names a dot-path
 * into the design state.  Editing any control writes the state, re-solves the
 * whole design and refreshes every registered control and view, so a change
 * anywhere propagates everywhere. */

(function (global) {
  'use strict';

  var M = global.PlannerModel;
  var H = M.helpers;

  /* Wright State palette, cycled so any number of experiments gets a colour. */
  var SERIES_COLOURS = [
    '#046A38', '#CBA052', '#719949', '#00482B', '#AE8643',
    '#8FA9C4', '#B36A5E', '#5E7D6A', '#D8B45C', '#6b767b'
  ];

  var App = {
    boot: null,
    state: null,
    report: null,
    protocols: {},
    activePanel: 'overview',
    controls: [],
    views: [],
    panels: {},
    railItems: {},
    suspend: false
  };

  function colourFor(index) {
    return SERIES_COLOURS[Math.abs(index) % SERIES_COLOURS.length];
  }

  function experimentColour(id) {
    var list = (App.state && App.state.experiments) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return colourFor(i);
    return SERIES_COLOURS[0];
  }

  /* ------------------------------------------------------------ dom util */

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'style') node.setAttribute('style', value);
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getPath(root, path) {
    return path.split('.').reduce(function (acc, key) {
      return acc === undefined || acc === null ? undefined : acc[key];
    }, root);
  }

  function setPath(root, path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    var target = keys.reduce(function (acc, key) {
      if (acc[key] === undefined || acc[key] === null) acc[key] = {};
      return acc[key];
    }, root);
    target[last] = value;
  }

  function toast(message, kind) {
    var host = document.getElementById('toasts');
    var node = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: message });
    host.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .25s';
      node.style.opacity = '0';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, kind === 'bad' ? 5200 : 2600);
  }

  function copy(text, label) {
    function done() { toast((label || 'Copied') + ' to clipboard', 'ok'); }
    function fallback() {
      var area = h('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); }
      catch (err) { toast('Copy failed; select the text manually.', 'bad'); }
      document.body.removeChild(area);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }

  /* ------------------------------------------------------- rich clipboard */

  /* Word, Google Docs and LibreOffice all build a native table out of the
   * clipboard's text/html flavour, so "copy for Word" is an HTML <table> with
   * its borders and alignment already inline.  A tab-separated flavour rides
   * alongside for anything that only takes plain text. */

  var WORD_CELL = 'border:1px solid #7f7f7f;padding:4pt 6pt;vertical-align:top;';

  function wordTableHtml(table) {
    var head = table.columns.map(function (label, index) {
      return '<th style="' + WORD_CELL + 'background:#e8eae6;font-weight:bold;text-align:'
        + (table.numeric[index] ? 'right' : 'left') + '">' + escapeHtml(label) + '</th>';
    }).join('');
    var body = table.rows.map(function (cells) {
      return '<tr>' + cells.map(function (cell, index) {
        return '<td style="' + WORD_CELL + 'text-align:'
          + (table.numeric[index] ? 'right' : 'left') + '">' + escapeHtml(cell) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<meta charset="utf-8">'
      + (table.caption ? '<p style="font-family:Calibri,Arial,sans-serif;font-size:10pt;'
        + 'margin:0 0 4pt 0"><b>' + escapeHtml(table.caption) + '</b></p>' : '')
      + '<table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;'
      + 'font-family:Calibri,Arial,sans-serif;font-size:10pt">'
      + '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function wordTableText(table) {
    return (table.caption ? [table.caption] : [])
      .concat([table.columns.join('\t')])
      .concat(table.rows.map(function (cells) { return cells.join('\t'); }))
      .join('\n');
  }

  /* The old selection-and-execCommand route: it is what keeps the rich copy
   * working on a plain-http origin, where navigator.clipboard is not there. */
  function copyRichFallback(html, plain, label) {
    var holder = h('div', {
      contenteditable: 'true',
      style: 'position:fixed;left:-9999px;top:0;white-space:normal'
    });
    holder.innerHTML = html;
    document.body.appendChild(holder);
    var selection = global.getSelection();
    var range = document.createRange();
    range.selectNodeContents(holder);
    selection.removeAllRanges();
    selection.addRange(range);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    selection.removeAllRanges();
    document.body.removeChild(holder);
    if (ok) toast((label || 'Table') + ' copied - paste into Word as a table', 'ok');
    else copy(plain, label);
  }

  function copyRichTable(table, label) {
    var html = wordTableHtml(table);
    var plain = wordTableText(table);
    if (!(global.ClipboardItem && navigator.clipboard && navigator.clipboard.write)) {
      copyRichFallback(html, plain, label);
      return;
    }
    var item = new global.ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' })
    });
    navigator.clipboard.write([item]).then(function () {
      toast((label || 'Table') + ' copied - paste into Word as a table', 'ok');
    }, function () { copyRichFallback(html, plain, label); });
  }

  function tableMarkdown(table) {
    return M.mdTable(table.columns, table.rows, table.numeric.map(function (numeric) {
      return numeric ? 'right' : 'left';
    }));
  }

  /* ---------------------------------------------------------- registries */

  function registerControl(sync, owner) { App.controls.push({ sync: sync, owner: owner || null }); }
  function dropControls(owner) {
    App.controls = App.controls.filter(function (entry) { return entry.owner !== owner; });
  }

  /* Views and controls both carry an owner so that a panel which rebuilds its
   * editor - the library panels do, every time the selection changes - can
   * discard the previous generation instead of accumulating them. */
  function registerView(render, owner) {
    App.views.push({ render: render, owner: owner || null });
    return render;
  }
  function dropViews(owner) {
    App.views = App.views.filter(function (entry) { return entry.owner !== owner; });
  }
  function syncOwner(owner) {
    App.controls.forEach(function (entry) {
      if (entry.owner === owner) {
        try { entry.sync(); } catch (error) { /* stale control */ }
      }
    });
    App.views.forEach(function (entry) {
      if (entry.owner === owner && App.report) {
        try { entry.render(App.report); } catch (error) { /* stale view */ }
      }
    });
  }

  /* ------------------------------------------------------------ controls */

  function paintRange(input) {
    var min = parseFloat(input.min) || 0;
    var max = parseFloat(input.max);
    var value = parseFloat(input.value);
    var pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', H.clamp(pct, 0, 100) + '%');
  }

  function slider(options) {
    var decimals = options.decimals === undefined ? 0 : options.decimals;
    var range = h('input', {
      type: 'range', min: options.min, max: options.max,
      step: options.step || 1, class: options.gold ? 'gold' : ''
    });
    var box = h('input', {
      type: 'number', min: options.min, max: options.max, step: options.step || 1
    });

    /* A slider either owns a dot-path into the state or, when the quantity is
     * derived (scanner hours per experiment, solved session counts), a
     * get/set pair. */
    function readValue() {
      return H.num(options.get ? options.get(App.state, App.report)
        : getPath(App.state, options.path));
    }

    function commit(raw) {
      var value = H.clamp(H.num(raw), options.min, options.max);
      if (decimals >= 0) value = H.round(value, decimals);
      if (options.set) options.set(value, App.state);
      else setPath(App.state, options.path, value);
      if (options.onChange) options.onChange(value);
      App.refresh();
    }

    range.addEventListener('input', function () { commit(range.value); });
    box.addEventListener('change', function () { commit(box.value); });
    box.addEventListener('blur', function () { commit(box.value); });

    var node = h('div', { class: 'control' }, [
      h('label', {}, [
        h('span', { text: options.label }),
        options.hint ? h('span', { class: 'hint', text: options.hint }) : null
      ]),
      range,
      h('div', { class: 'value-box' }, [
        box,
        options.unit ? h('span', { class: 'unit', text: options.unit }) : null
      ])
    ]);

    registerControl(function () {
      var value = readValue();
      if (document.activeElement !== range) range.value = value;
      if (document.activeElement !== box) box.value = H.round(value, Math.max(decimals, 0));
      paintRange(range);
      var off = options.disabledWhen ? options.disabledWhen(App.state) : false;
      range.disabled = !!off;
      box.disabled = !!off;
      node.style.opacity = off ? '.5' : '1';
      if (options.dynamicMax) {
        var top = options.dynamicMax(App.state, App.report);
        if (isFinite(top) && top > options.min) {
          range.max = top; box.max = top;
          paintRange(range);
        }
      }
      if (options.dynamicLabel) {
        var label = node.querySelector('label span');
        if (label) label.textContent = options.dynamicLabel(App.state, App.report);
      }
      if (options.dynamicUnit) {
        var unit = node.querySelector('.unit');
        if (unit) unit.textContent = options.dynamicUnit(App.state, App.report);
      }
    }, options.owner);
    return node;
  }

  function field(options) {
    var input;
    if (options.type === 'select') {
      input = h('select', {});
    } else if (options.type === 'textarea') {
      input = h('textarea', { rows: options.rows || 3 });
    } else {
      input = h('input', {
        type: options.type || 'text', step: options.step,
        min: options.min, max: options.max, placeholder: options.placeholder
      });
    }

    function fillOptions() {
      if (options.type !== 'select') return;
      var wanted = options.options
        || (options.optionsFrom ? options.optionsFrom(App.state, App.report) : []);
      var signature = wanted.map(function (option) {
        return option.value + ' ' + option.label;
      }).join('');
      if (input.dataset.signature === signature) return;
      input.dataset.signature = signature;
      clear(input);
      wanted.forEach(function (option) {
        input.appendChild(h('option', { value: option.value, text: option.label }));
      });
    }
    fillOptions();

    function commit() {
      var value = options.type === 'number' ? H.num(input.value) : input.value;
      if (options.set) options.set(value, App.state);
      else setPath(App.state, options.path, value);
      if (options.onChange) options.onChange(value);
      App.refresh();
    }
    input.addEventListener('change', commit);
    if (options.type !== 'select') input.addEventListener('blur', commit);

    var node = h('div', { class: 'control' + (options.stack ? ' stack' : ' wide') }, [
      h('label', {}, [
        h('span', { text: options.label }),
        options.hint ? h('span', { class: 'hint', text: options.hint }) : null
      ]),
      input
    ]);

    registerControl(function () {
      fillOptions();
      var value = options.get ? options.get(App.state, App.report)
        : getPath(App.state, options.path);
      if (document.activeElement !== input) {
        input.value = value === undefined || value === null ? '' : value;
      }
      var off = options.disabledWhen ? options.disabledWhen(App.state) : false;
      input.disabled = !!off;
    }, options.owner);
    return node;
  }

  function checkbox(options) {
    var input = h('input', { type: 'checkbox' });
    input.addEventListener('change', function () {
      if (options.set) options.set(input.checked, App.state);
      else setPath(App.state, options.path, input.checked);
      if (options.onChange) options.onChange(input.checked);
      App.refresh();
    });
    registerControl(function () {
      input.checked = options.get ? !!options.get(App.state) : !!getPath(App.state, options.path);
    }, options.owner);
    return h('label', { class: 'checkline', title: options.hint || '' }, [
      input, h('span', { text: options.label })
    ]);
  }

  function segmented(options) {
    var buttons = options.options.map(function (option) {
      var button = h('button', { type: 'button', text: option.label, title: option.hint || '' });
      button.addEventListener('click', function () {
        if (options.set) options.set(option.value, App.state);
        else setPath(App.state, options.path, option.value);
        if (options.onChange) options.onChange(option.value);
        App.refresh();
      });
      button.dataset.value = option.value;
      return button;
    });
    var wrap = h('div', { class: 'seg' }, buttons);
    registerControl(function () {
      var value = options.get ? options.get(App.state) : getPath(App.state, options.path);
      buttons.forEach(function (button) {
        button.classList.toggle('active', button.dataset.value === String(value));
      });
    }, options.owner);
    return h('div', { class: 'control wide' }, [
      h('label', {}, [
        h('span', { text: options.label }),
        options.hint ? h('span', { class: 'hint', text: options.hint }) : null
      ]),
      wrap
    ]);
  }

  function card(title, note, body, headExtra) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h3', { text: title }),
        headExtra || (note ? h('span', { class: 'head-note', text: note }) : null)
      ]),
      h('div', { class: 'card-body' }, body)
    ]);
  }

  function flushCard(title, note, body, headExtra) {
    var node = card(title, note, [], headExtra);
    node.classList.add('flush');
    var holder = node.querySelector('.card-body');
    (body || []).forEach(function (kid) { holder.appendChild(kid); });
    return node;
  }

  function readoutCell(key, value, modifier) {
    return h('div', { class: 'cell' + (modifier ? ' ' + modifier : '') }, [
      h('div', { class: 'k', text: key }),
      h('div', { class: 'v', html: value })
    ]);
  }

  function iconButton(label, title, action, kind) {
    return h('button', {
      class: 'btn ' + (kind || 'quiet') + ' sm', type: 'button', text: label,
      title: title, onclick: action
    });
  }

  /* ------------------------------------------------------------- tables */

  /* Every table in the planner carries the same two copy actions, so any of
   * them can go straight into a Markdown document or land in Word as a real
   * table.  The model is derived from the cells that were rendered, HTML
   * stripped, so what gets copied is what is on screen. */

  function cellText(cell) {
    var content = cell && typeof cell === 'object' ? cell : { text: cell };
    if (content.copy !== undefined) return String(content.copy);
    if (content.html) {
      return String(content.html).replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }
    return content.text === undefined || content.text === null ? '' : String(content.text);
  }

  function tableModel(caption, headers, rows) {
    var columns = headers.map(function (header) {
      return String((header && header.label !== undefined) ? header.label : header);
    });
    var numeric = headers.map(function (header) { return !!(header && header.num); });
    var body = rows.map(function (row) { return (row.cells || row).map(cellText); });

    /* The last column is usually the row's own move/delete buttons: an unnamed
     * header over cells that copy as nothing.  Nobody wants that column in a
     * document, so drop any trailing columns that are empty top to bottom. */
    while (columns.length > 1 && !columns[columns.length - 1].trim()
      && body.every(function (cells) {
        return !String(cells[columns.length - 1] || '').trim();
      })) {
      columns.pop();
      numeric.pop();
      body = body.map(function (cells) { return cells.slice(0, columns.length); });
    }

    return { caption: caption || '', columns: columns, numeric: numeric, rows: body };
  }

  function tableActions(model, extra) {
    return h('div', { class: 'table-actions' }, [
      h('span', { class: 'table-caption', text: model.caption || '' }),
      h('div', { class: 'btn-row' }, [
        iconButton('Copy Markdown', 'Copy this table as a GitHub-flavoured Markdown table',
          function () { copy(tableMarkdown(model), model.caption || 'Table'); }),
        iconButton('Copy for Word', 'Copy as rich text: pastes into Word, Google Docs or '
          + 'LibreOffice as a real table',
          function () { copyRichTable(model, model.caption || 'Table'); })
      ].concat(extra || []))
    ]);
  }

  function dataTable(headers, rows, options) {
    options = options || {};
    var thead = h('thead', {}, [h('tr', {}, headers.map(function (header) {
      return h('th', {
        class: header && header.num ? 'num' : '',
        text: (header && header.label !== undefined) ? header.label : header
      });
    }))]);
    var body = h('tbody', {}, rows.map(function (row) {
      return h('tr', { class: row.className || '' }, (row.cells || row).map(function (cell) {
        var content = cell && typeof cell === 'object' ? cell : { text: cell };
        return h('td', {
          class: (content.num ? 'num ' : '') + (content.className || ''),
          html: content.html,
          text: content.html ? null : (content.text === undefined ? '' : String(content.text))
        });
      }));
    }));
    var table = h('table', { class: 'data' }, [thead, body]);
    var scroll = options.scroll === false ? table : h('div', { class: 'table-scroll' }, [table]);
    if (options.actions === false) return scroll;
    var model = tableModel(options.caption, headers, rows);
    return h('div', { class: 'table-block' }, [scroll, tableActions(model, options.extraActions)]);
  }

  /* --------------------------------------------------------------- plots */

  function sizeCanvas(canvas, height) {
    var ratio = global.devicePixelRatio || 1;
    var width = canvas.parentNode.clientWidth || 640;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.height = height + 'px';
    var context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context: context, width: width, height: height };
  }

  var TICK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 300, 600, 900, 1800];

  function niceStep(span, target) {
    for (var i = 0; i < TICK_STEPS.length; i += 1) {
      if (span / TICK_STEPS[i] <= target) return TICK_STEPS[i];
    }
    return TICK_STEPS[TICK_STEPS.length - 1];
  }

  var TRACE_COLOURS = { stimulus: '#00482B', a: '#CBA052', b: '#719949' };

  /* HRF regressor trace.  `view` carries the visible window so the same draw
   * routine serves the fitted plot and any zoomed or panned state. */
  function drawRegressors(canvas, efficiency, labels, view) {
    var height = view.height || 300;
    var box = sizeCanvas(canvas, height);
    var context = box.context;
    context.clearRect(0, 0, box.width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, box.width, height);

    var series = efficiency && efficiency.series;
    if (!series || !series.t.length) {
      context.fillStyle = '#6b767b';
      context.font = '12px "Inter", sans-serif';
      context.fillText('No simulated run to plot', 14, height / 2);
      return null;
    }

    var total = series.t[series.t.length - 1] || 1;
    var minSpan = Math.min(total, 12);
    var span = H.clamp(view.span || total, minSpan, total);
    var start = H.clamp(view.start || 0, 0, Math.max(0, total - span));
    var stop = start + span;

    var padLeft = 46, padRight = 14, padTop = 30, padBottom = 26;
    var plotWidth = Math.max(10, box.width - padLeft - padRight);
    var plotHeight = Math.max(10, height - padTop - padBottom);

    function xAt(t) { return padLeft + ((t - start) / span) * plotWidth; }

    /* Only the visible window sets the vertical scale, so zooming in on a
     * quiet stretch actually shows what is happening there. */
    var first = 0, last = series.t.length - 1;
    while (first < last && series.t[first + 1] < start) first += 1;
    while (last > first && series.t[last - 1] > stop) last -= 1;

    var maxValue = 0;
    for (var i = first; i <= last; i += 1) {
      maxValue = Math.max(maxValue, Math.abs(series.stimulus[i]),
        Math.abs(series.responseA[i]), Math.abs(series.responseB[i]));
    }
    if (!(maxValue > 0)) maxValue = 1;
    maxValue *= 1.08;

    function yAt(value) { return padTop + plotHeight / 2 - (value / maxValue) * (plotHeight / 2); }

    /* Event bands: where the stimulus and response windows actually sit. */
    var events = efficiency.events || {};
    function band(list, colour) {
      if (!list) return;
      context.fillStyle = colour;
      list.forEach(function (event) {
        if (event.onset > stop || event.onset + event.duration < start) return;
        var x1 = xAt(Math.max(start, event.onset));
        var x2 = xAt(Math.min(stop, event.onset + event.duration));
        context.fillRect(x1, padTop, Math.max(1.2, x2 - x1), plotHeight);
      });
    }
    band(events.stimulus, 'rgba(0, 72, 43, .10)');
    band(events.responseA, 'rgba(203, 160, 82, .22)');
    band(events.responseB, 'rgba(113, 153, 73, .20)');

    /* Horizontal gridlines and value labels. */
    context.font = '9.5px "SF Mono", Menlo, monospace';
    [-1, -0.5, 0, 0.5, 1].forEach(function (level) {
      var y = yAt(level * maxValue);
      context.strokeStyle = level === 0 ? '#b9c0b4' : '#EFEEE9';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padLeft, y);
      context.lineTo(padLeft + plotWidth, y);
      context.stroke();
      context.fillStyle = '#6b767b';
      context.fillText(H.round(level * maxValue, 2).toString(), 3, y + 3);
    });

    /* Time axis. */
    var step = niceStep(span, 9);
    var tick = Math.ceil(start / step) * step;
    context.textAlign = 'center';
    for (; tick <= stop + 0.001; tick += step) {
      var x = xAt(tick);
      context.strokeStyle = '#F2F1F0';
      context.beginPath();
      context.moveTo(x, padTop);
      context.lineTo(x, padTop + plotHeight);
      context.stroke();
      context.fillStyle = '#6b767b';
      context.fillText(H.round(tick, tick < 10 ? 1 : 0) + 's', x, height - 8);
    }
    context.textAlign = 'left';

    context.strokeStyle = '#d8dcd5';
    context.strokeRect(padLeft + 0.5, padTop + 0.5, plotWidth, plotHeight);

    function line(values, colour, width) {
      context.strokeStyle = colour;
      context.lineWidth = width;
      context.lineJoin = 'round';
      context.beginPath();
      var started = false;
      for (var k = first; k <= last; k += 1) {
        var px = xAt(series.t[k]);
        var py = yAt(values[k]);
        if (!started) { context.moveTo(px, py); started = true; } else context.lineTo(px, py);
      }
      context.stroke();
    }
    line(series.stimulus, TRACE_COLOURS.stimulus, 1.4);
    line(series.responseB, TRACE_COLOURS.b, 1.8);
    line(series.responseA, TRACE_COLOURS.a, 1.8);

    /* Legend. */
    var legend = [
      [labels.stimulus, TRACE_COLOURS.stimulus],
      [labels.a, TRACE_COLOURS.a],
      [labels.b, TRACE_COLOURS.b]
    ];
    var lx = padLeft;
    context.font = '10px "Inter", sans-serif';
    legend.forEach(function (item) {
      context.strokeStyle = item[1];
      context.lineWidth = 2.4;
      context.beginPath();
      context.moveTo(lx, 14);
      context.lineTo(lx + 16, 14);
      context.stroke();
      context.fillStyle = '#3d4a4f';
      context.fillText(item[0], lx + 21, 17);
      lx += 26 + context.measureText(item[0]).width + 16;
    });
    context.fillStyle = '#6b767b';
    context.font = '9.5px "SF Mono", Menlo, monospace';
    context.textAlign = 'right';
    context.fillText(H.round(start, 1) + ' - ' + H.round(stop, 1) + ' s of '
      + H.round(total, 0) + ' s', box.width - padRight, 17);
    context.textAlign = 'left';

    /* Hover crosshair. */
    var hover = null;
    if (view.hoverX !== null && view.hoverX !== undefined
      && view.hoverX >= padLeft && view.hoverX <= padLeft + plotWidth) {
      var time = start + ((view.hoverX - padLeft) / plotWidth) * span;
      var index = first;
      var best = Infinity;
      for (var j = first; j <= last; j += 1) {
        var distance = Math.abs(series.t[j] - time);
        if (distance < best) { best = distance; index = j; }
      }
      var hx = xAt(series.t[index]);
      context.strokeStyle = 'rgba(16, 24, 32, .35)';
      context.lineWidth = 1;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(hx, padTop);
      context.lineTo(hx, padTop + plotHeight);
      context.stroke();
      context.setLineDash([]);
      [[series.stimulus[index], TRACE_COLOURS.stimulus],
        [series.responseA[index], TRACE_COLOURS.a],
        [series.responseB[index], TRACE_COLOURS.b]].forEach(function (pair) {
        context.fillStyle = pair[1];
        context.beginPath();
        context.arc(hx, yAt(pair[0]), 3, 0, Math.PI * 2);
        context.fill();
      });
      hover = {
        t: series.t[index],
        stimulus: series.stimulus[index],
        a: series.responseA[index],
        b: series.responseB[index],
        x: hx
      };
    }

    return {
      start: start, span: span, total: total, hover: hover,
      padLeft: padLeft, plotWidth: plotWidth, minSpan: minSpan
    };
  }

  /* A pannable, zoomable regressor plot. */
  function regressorPlot() {
    var view = { start: 0, span: null, hoverX: null, height: 300 };
    var canvas = h('canvas', { class: 'zoomable' });
    var last = null;
    var efficiency = null;
    var labels = { stimulus: 'Stimulus', a: 'Condition A', b: 'Condition B' };

    var reading = h('div', { class: 'plot-reading' });
    var zoomRange = h('input', { type: 'range', min: 1, max: 60, step: 0.5, value: 1 });

    function currentZoom() {
      if (!last || !last.total || !last.span) return 1;
      return last.total / last.span;
    }

    function paint() {
      last = drawRegressors(canvas, efficiency, labels, view);
      if (last) {
        view.start = last.start;
        view.span = last.span;
        if (document.activeElement !== zoomRange) zoomRange.value = H.round(currentZoom(), 2);
        paintRange(zoomRange);
      }
      clear(reading);
      if (last && last.hover) {
        reading.appendChild(h('span', {
          class: 'mono', text: 't = ' + H.round(last.hover.t, 1) + ' s'
        }));
        reading.appendChild(h('span', {
          style: 'color:' + TRACE_COLOURS.stimulus,
          text: labels.stimulus + ' ' + H.round(last.hover.stimulus, 3)
        }));
        reading.appendChild(h('span', {
          style: 'color:#AE8643', text: labels.a + ' ' + H.round(last.hover.a, 3)
        }));
        reading.appendChild(h('span', {
          style: 'color:' + TRACE_COLOURS.b, text: labels.b + ' ' + H.round(last.hover.b, 3)
        }));
      } else {
        reading.appendChild(h('span', {
          class: 'muted',
          text: 'Scroll to zoom, drag to pan, double-click to fit. Shaded bands are the '
            + 'stimulus and response windows.'
        }));
      }
    }

    function setZoom(factor, anchorTime) {
      if (!last) return;
      var span = H.clamp(last.total / Math.max(1, factor), last.minSpan, last.total);
      var anchor = anchorTime === undefined ? view.start + view.span / 2 : anchorTime;
      var fraction = view.span > 0 ? (anchor - view.start) / view.span : 0.5;
      view.span = span;
      view.start = H.clamp(anchor - fraction * span, 0, Math.max(0, last.total - span));
      paint();
    }

    function timeAt(clientX) {
      if (!last) return 0;
      var rect = canvas.getBoundingClientRect();
      var x = clientX - rect.left;
      return view.start + ((x - last.padLeft) / last.plotWidth) * view.span;
    }

    canvas.addEventListener('wheel', function (event) {
      if (!last) return;
      event.preventDefault();
      var direction = event.deltaY > 0 ? 1 / 1.18 : 1.18;
      setZoom(currentZoom() * direction, timeAt(event.clientX));
    }, { passive: false });

    var drag = null;
    canvas.addEventListener('mousedown', function (event) {
      if (!last) return;
      event.preventDefault();
      drag = { x: event.clientX, start: view.start };
      canvas.classList.add('grabbing');
    });
    canvas.addEventListener('mousemove', function (event) {
      if (drag || !last) return;
      view.hoverX = event.clientX - canvas.getBoundingClientRect().left;
      paint();
    });
    canvas.addEventListener('mouseleave', function () {
      if (view.hoverX === null) return;
      view.hoverX = null;
      paint();
    });
    /* Panning continues while the pointer is outside the canvas, so the drag
     * listeners - and only those - live on the window. */
    global.addEventListener('mousemove', function (event) {
      if (!drag || !last) return;
      var shift = (event.clientX - drag.x) / last.plotWidth * view.span;
      view.start = H.clamp(drag.start - shift, 0, Math.max(0, last.total - view.span));
      paint();
    });
    global.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      canvas.classList.remove('grabbing');
    });
    canvas.addEventListener('dblclick', function () {
      view.start = 0;
      view.span = last ? last.total : null;
      paint();
    });
    zoomRange.addEventListener('input', function () { setZoom(H.num(zoomRange.value)); });

    var toolbar = h('div', { class: 'plot-toolbar' }, [
      h('span', { class: 'k', text: 'Zoom' }),
      zoomRange,
      iconButton('-', 'Zoom out', function () { setZoom(currentZoom() / 1.6); }),
      iconButton('+', 'Zoom in', function () { setZoom(currentZoom() * 1.6); }),
      iconButton('Fit', 'Show the whole simulated run', function () {
        view.start = 0;
        view.span = last ? last.total : null;
        paint();
      }),
      iconButton('First trial', 'Zoom to the opening trials', function () {
        if (!last) return;
        view.span = H.clamp(last.total / 8, last.minSpan, last.total);
        view.start = 0;
        paint();
      })
    ]);

    return {
      node: h('div', {}, [toolbar, h('div', { class: 'plot-wrap tall' }, [canvas]), reading]),
      render: function (nextEfficiency, nextLabels) {
        efficiency = nextEfficiency;
        if (nextLabels) labels = nextLabels;
        paint();
      }
    };
  }

  /* ------------------------------------------------------------ figures */

  var TIMELINE_SANS = 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  var TIMELINE_MONO = 'SF Mono, IBM Plex Mono, JetBrains Mono, Menlo, Consolas, monospace';

  var ROLE_FILL = {
    baseline: '#DCD59A',
    stimulus: '#046A38',
    delay: '#E7E3C6',
    response: '#CBA052',
    other: '#B9C0B4',
    gap: '#D8DCD5'
  };
  var ROLE_DARK = { stimulus: true };

  function figureClip(text, budget) {
    var value = String(text || '');
    if (budget < 4 || value.length <= budget) return value;
    return value.slice(0, budget - 1).replace(/\s+$/, '') + '…';
  }

  function figureSeconds(value) { return String(H.round(H.num(value), 2)); }

  /* The dark stimulus screen and whatever the participant sees on it. */
  function figureScreen(x, y, size, role) {
    var cx = x + size / 2;
    var cy = y + size / 2;
    var parts = ['<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size
      + '" rx="3" fill="#101820" stroke="#00482B" stroke-width="1.5"/>'];

    if (role === 'delay') return parts.join('');  /* a blank screen shows nothing */

    if (role === 'stimulus') {
      var inset = Math.round(size * 0.17);
      var lineX = x + inset;
      var usable = size - inset * 2;
      parts.push('<rect x="' + lineX + '" y="' + (y + inset) + '" width="' + usable
        + '" height="' + usable + '" rx="2" fill="none" stroke="#ffffff" stroke-width="1.4"/>');
      [0.74, 0.92, 0.52].forEach(function (fraction, index) {
        var lineY = y + inset + usable * (0.3 + index * 0.2);
        parts.push('<rect x="' + (lineX + usable * 0.08) + '" y="' + lineY + '" width="'
          + H.round(usable * 0.84 * fraction, 1) + '" height="3" rx="1.5" fill="#F2F1F0"/>');
      });
    } else if (role === 'response') {
      var arm = H.round(size * 0.16, 1);
      var armStroke = H.round(size * 0.036, 2);
      parts.push('<line x1="' + H.round(cx - arm, 1) + '" y1="' + cy + '" x2="'
        + H.round(cx + arm, 1) + '" y2="' + cy + '" stroke="#ffffff" stroke-width="'
        + armStroke + '"/>');
      parts.push('<line x1="' + cx + '" y1="' + H.round(cy - arm, 1) + '" x2="' + cx
        + '" y2="' + H.round(cy + arm, 1) + '" stroke="#ffffff" stroke-width="'
        + armStroke + '"/>');
    } else if (role === 'baseline') {
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + H.round(size * 0.062, 1)
        + '" fill="#ffffff"/>');
    } else {
      var side = Math.round(size * 0.3);
      parts.push('<rect x="' + (cx - side / 2) + '" y="' + (cy - side / 2) + '" width="' + side
        + '" height="' + side + '" fill="none" stroke="#ffffff" stroke-width="1.6"/>');
    }
    return parts.join('');
  }

  function figureTickStep(total) {
    var candidates = [1, 2, 5, 10, 15, 20, 30, 60, 120];
    for (var i = 0; i < candidates.length; i += 1) {
      if (total / candidates[i] <= 9) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  /* The trial as a strip of screens with their durations, then the same trial
   * drawn to scale underneath. */
  function trialFigureMarkup(trial, extraGap) {
    if (!trial) return '';
    var uid = String(trial.id || 'trial').replace(/[^A-Za-z0-9_-]/g, '');
    var steps = (trial.phases || []).map(function (phase) {
      var min = H.num(phase.min);
      var max = Math.max(min, H.num(phase.max));
      return {
        name: phase.name || 'Phase',
        role: M.normaliseRole(phase.role),
        min: min, max: max, mean: (min + max) / 2
      };
    });
    if (extraGap > 0) {
      steps.push({
        name: 'Inter-trial gap', role: 'gap',
        min: extraGap, max: extraGap, mean: extraGap
      });
    }
    if (!steps.length) return '';

    var spanMin = H.sum(steps, function (step) { return step.min; });
    var spanMax = H.sum(steps, function (step) { return step.max; });

    var count = steps.length;
    var colWidth = count > 7 ? 148 : (count > 5 ? 168 : 196);
    var padLeft = 30, padRight = 48;
    var width = padLeft + padRight + colWidth * count;
    var inner = width - padLeft - padRight;
    var screen = Math.min(colWidth - 34, 116);

    var screenTop = 16;
    var nameY = screenTop + screen + 24;
    var durationY = nameY + 17;
    var meanY = durationY + 15;
    var axisY = meanY + 26;
    var tickY = axisY + 20;
    var scaleTitleY = tickY + 36;
    var barTop = scaleTitleY + 10;
    var barHeight = 26;
    var barBottom = barTop + barHeight;
    var rulerY = barBottom + 13;
    var legendY = rulerY + 26;
    var height = legendY + 14;

    var svg = [];
    svg.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height
      + '" width="' + width + '" height="' + height + '" role="img">');
    svg.push('<title>' + escapeHtml(trial.name) + ' trial timeline</title>');
    svg.push('<defs><pattern id="tl-jitter-' + uid + '" width="7" height="7" '
      + 'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
      + '<rect width="7" height="7" fill="#ffffff" fill-opacity="0"/>'
      + '<line x1="0" y1="0" x2="0" y2="7" stroke="#101820" stroke-opacity="0.22" stroke-width="2.5"/>'
      + '</pattern></defs>');
    svg.push('<rect width="' + width + '" height="' + height + '" fill="#ffffff"/>');

    /* Row one: the screens, their names and their second bounds. */
    steps.forEach(function (step, index) {
      var colX = padLeft + colWidth * index;
      var centre = colX + colWidth / 2;
      svg.push(figureScreen(H.round(centre - screen / 2, 1), screenTop, screen, step.role));
      var label = figureClip(step.name, Math.floor(colWidth / 7.2));
      svg.push('<text x="' + centre + '" y="' + nameY + '" text-anchor="middle" font-family="'
        + TIMELINE_SANS + '" font-size="13" font-weight="600" fill="#101820">'
        + '<title>' + escapeHtml(step.name) + '</title>' + escapeHtml(label) + '</text>');

      var bounds = step.min === step.max
        ? figureSeconds(step.min) + ' s'
        : figureSeconds(step.min) + ' – ' + figureSeconds(step.max) + ' s';
      svg.push('<text x="' + centre + '" y="' + durationY + '" text-anchor="middle" font-family="'
        + TIMELINE_MONO + '" font-size="12.5" fill="#00482B">' + bounds + '</text>');
      if (step.min !== step.max) {
        svg.push('<text x="' + centre + '" y="' + meanY + '" text-anchor="middle" font-family="'
          + TIMELINE_SANS + '" font-size="10.5" fill="#6b767b">jittered, mean '
          + figureSeconds(step.mean) + ' s</text>');
      }
    });

    /* Row two: the arrow axis carrying the cumulative mean onsets. */
    svg.push('<line x1="' + padLeft + '" y1="' + axisY + '" x2="' + (width - padRight + 12)
      + '" y2="' + axisY + '" stroke="#101820" stroke-width="2.4"/>');
    svg.push('<polygon points="' + (width - padRight + 12) + ',' + (axisY - 6) + ' '
      + (width - padRight + 26) + ',' + axisY + ' ' + (width - padRight + 12) + ',' + (axisY + 6)
      + '" fill="#101820"/>');

    var onset = 0;
    for (var boundary = 0; boundary <= count; boundary += 1) {
      var markX = padLeft + colWidth * boundary;
      if (boundary === count) markX -= 2;
      svg.push('<line x1="' + markX + '" y1="' + axisY + '" x2="' + markX + '" y2="'
        + (axisY - 22) + '" stroke="#046A38" stroke-width="1.6"/>');
      svg.push('<polygon points="' + markX + ',' + (axisY - 28) + ' ' + (markX - 4.5) + ','
        + (axisY - 19) + ' ' + (markX + 4.5) + ',' + (axisY - 19) + '" fill="#046A38"/>');
      svg.push('<text x="' + markX + '" y="' + tickY + '" text-anchor="middle" font-family="'
        + TIMELINE_MONO + '" font-size="11.5" fill="#101820">t = ' + figureSeconds(onset)
        + ' s</text>');
      if (boundary < count) onset += steps[boundary].mean;
    }

    /* Row three: the same trial drawn to scale. */
    var total = onset || 1;
    svg.push('<text x="' + padLeft + '" y="' + scaleTitleY + '" font-family="' + TIMELINE_SANS
      + '" font-size="10.5" letter-spacing="1.4" fill="#6b767b">DRAWN TO SCALE '
      + '— MEAN TRIAL ' + figureSeconds(total) + ' S'
      + (spanMin === spanMax ? ''
        : ' (' + figureSeconds(spanMin) + '–' + figureSeconds(spanMax) + ' S)')
      + '</text>');

    var cursor = padLeft;
    steps.forEach(function (step) {
      var segment = inner * (step.mean / total);
      var fill = ROLE_FILL[step.role] || ROLE_FILL.other;
      svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + barTop + '" width="'
        + H.round(segment, 2) + '" height="' + barHeight + '" fill="' + fill
        + '" stroke="#ffffff" stroke-width="1"/>');
      if (step.min !== step.max) {
        svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + barTop + '" width="'
          + H.round(segment, 2) + '" height="' + barHeight + '" fill="url(#tl-jitter-' + uid
          + ')" stroke="none"/>');
      }
      if (segment > 42) {
        svg.push('<text x="' + H.round(cursor + segment / 2, 2) + '" y="' + (barTop + 17)
          + '" text-anchor="middle" font-family="' + TIMELINE_MONO + '" font-size="11" fill="'
          + (ROLE_DARK[step.role] ? '#F2F1F0' : '#101820') + '">'
          + figureSeconds(step.mean) + ' s</text>');
      }
      cursor += segment;
    });
    svg.push('<rect x="' + padLeft + '" y="' + barTop + '" width="' + inner + '" height="'
      + barHeight + '" fill="none" stroke="#b9c0b4" stroke-width="1"/>');

    var tickStep = figureTickStep(total);
    for (var mark = 0; mark <= total + 0.001; mark += tickStep) {
      var x = padLeft + inner * (mark / total);
      svg.push('<line x1="' + H.round(x, 2) + '" y1="' + barBottom + '" x2="' + H.round(x, 2)
        + '" y2="' + (barBottom + 5) + '" stroke="#6b767b" stroke-width="1"/>');
      svg.push('<text x="' + H.round(x, 2) + '" y="' + rulerY + '" text-anchor="middle" '
        + 'font-family="' + TIMELINE_MONO + '" font-size="10.5" fill="#6b767b">'
        + figureSeconds(mark) + '</text>');
    }

    /* Legend: only the roles this trial actually uses. */
    var seen = {};
    var legendX = padLeft;
    steps.forEach(function (item) {
      if (seen[item.role]) return;
      seen[item.role] = true;
      var label = item.role === 'gap' ? 'inter-trial gap' : item.role;
      svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" fill="'
        + (ROLE_FILL[item.role] || ROLE_FILL.other) + '" stroke="#b9c0b4" stroke-width="1"/>');
      svg.push('<text x="' + (legendX + 16) + '" y="' + legendY + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" fill="#3d4a4f">' + escapeHtml(label) + '</text>');
      legendX += 26 + label.length * 6.4;
    });
    svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" '
      + 'fill="#ffffff" stroke="#b9c0b4" stroke-width="1"/>');
    svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" '
      + 'fill="url(#tl-jitter-' + uid + ')" stroke="none"/>');
    svg.push('<text x="' + (legendX + 16) + '" y="' + legendY + '" font-family="' + TIMELINE_SANS
      + '" font-size="10.5" fill="#3d4a4f">jittered phase</text>');

    svg.push('</svg>');
    return svg.join('');
  }

  /* -------------------------------------------------------- assembly figure */

  /* The assembly table drawn as the figure it describes: trial, block, run,
   * session and experiment, each row to scale on its own axis, with the
   * element that the row above expands picked out and joined to it.  Same
   * palette as the trial timeline, so the two figures read as one pair. */

  var ASSEMBLY_FILL = {
    trial: '#00482B', gap: '#D8DCD5', block: '#00482B', rest: '#E7E3C6',
    dummy: '#B9C0B4', lead: '#DCD59A', run: '#00482B', setup: '#CBA052',
    brk: '#F8E08E', session: '#00482B'
  };
  var ASSEMBLY_DARK = { trial: true, block: true, run: true, session: true };
  var ASSEMBLY_LEGEND = [
    { kind: 'gap', label: 'inter-trial gap' },
    { kind: 'rest', label: 'inter-block rest' },
    { kind: 'dummy', label: 'dummy volumes' },
    { kind: 'lead', label: 'lead-in / lead-out' },
    { kind: 'setup', label: 'setup and structurals' },
    { kind: 'brk', label: 'in-scanner break' }
  ];

  function countLabel(value, noun) {
    var count = H.round(H.num(value), 2);
    var text = Math.abs(count - Math.round(count)) < 0.005
      ? H.fmtNumber(Math.round(count)) : H.trim(count, 2);
    return text + ' ' + noun + (Math.abs(count - 1) < 0.005 ? '' : 's');
  }

  function minutesLabel(value) {
    var minutes = H.num(value);
    if (minutes >= 90) return H.round(minutes / 60, 2) + ' h';
    return H.round(minutes, 1) + ' min';
  }

  /* One repeating element, laid out `count` times with `gap` between; a
   * fractional count draws its remainder as a cut-off final element. */
  function repeatParts(parts, count, span, kind, gap, gapKind) {
    var whole = Math.floor(count + 1e-6);
    var remainder = count - whole;
    for (var index = 0; index < whole && index < 400; index += 1) {
      parts.push({ span: span, kind: kind });
      if (gap > 0 && (index < whole - 1 || remainder > 0)) {
        parts.push({ span: gap, kind: gapKind });
      }
    }
    if (remainder > 0.01) parts.push({ span: span * remainder, kind: kind, cut: true });
    return parts;
  }

  /* Build the five assembly rows for one experiment, using its busiest run
   * design as the representative trial and run. */
  function assemblyRows(experimentReport) {
    if (!experimentReport || !App.report) return null;
    var runReport = null;
    if (experimentReport.leadRunId) {
      runReport = App.report.runs.filter(function (run) {
        return run.id === experimentReport.leadRunId;
      })[0] || null;
    }
    if (!runReport || runReport.missing) return null;
    var trialReport = App.report.trials.filter(function (trial) {
      return trial.id === runReport.trialId;
    })[0];
    if (!trialReport || !trialReport.phases.length) return null;

    var structure = runReport.structure;
    var derived = runReport.derived;
    var d = experimentReport.derived;
    var weeks = H.num(App.state.budget.weeksAvailable);

    var trialParts = trialReport.phases.map(function (phase) {
      var min = H.num(phase.min);
      var max = Math.max(min, H.num(phase.max));
      return {
        span: (min + max) / 2, kind: M.normaliseRole(phase.role),
        role: true, label: phase.name
      };
    });

    var blockParts = repeatParts([], structure.trialsPerBlock, derived.trialMean,
      'trial', structure.interTrialGap, 'gap');

    var runParts = [];
    if (derived.dummySeconds > 0) runParts.push({ span: derived.dummySeconds, kind: 'dummy' });
    if (structure.leadIn > 0) runParts.push({ span: structure.leadIn, kind: 'lead' });
    repeatParts(runParts, structure.blocksPerRun, derived.blockMean,
      'block', structure.interBlockRest, 'rest');
    if (structure.leadOut > 0) runParts.push({ span: structure.leadOut, kind: 'lead' });

    /* The session row uses the plan's leading session, so the picture is of a
     * real session rather than an average of several. */
    var sessionReport = null;
    if (experimentReport.plan.length) {
      var leadPlan = experimentReport.plan.slice().sort(function (a, b) {
        return b.sessions - a.sessions;
      })[0];
      sessionReport = App.report.sessions.filter(function (session) {
        return session.id === leadPlan.sessionId;
      })[0] || null;
    }

    var sessionParts = [];
    if (sessionReport) {
      if (sessionReport.setupMinutes > 0) {
        sessionParts.push({ span: sessionReport.setupMinutes, kind: 'setup' });
      }
      sessionReport.items.forEach(function (item) {
        repeatParts(sessionParts, item.count, item.minutesEach, 'run',
          sessionReport.breakMinutes, 'brk');
      });
    }

    var experimentParts = repeatParts([], Math.min(d.sessions, 200),
      d.sessionMeanMinutes, 'session', 0, null);

    /* Where the row above lands inside this row: the first repeating element. */
    function offsetOf(parts, kind) {
      var at = 0;
      for (var index = 0; index < parts.length; index += 1) {
        if (parts[index].kind === kind) return { from: at, to: at + parts[index].span };
        at += parts[index].span;
      }
      return null;
    }

    return [
      {
        level: 'Trial', parts: trialParts, unit: 's',
        note: trialReport.name + ' · '
          + H.fmtRange(trialReport.timing.min, trialReport.timing.max)
      },
      {
        level: 'Block', parts: blockParts, unit: 's',
        note: countLabel(structure.trialsPerBlock, 'trial') + ' · '
          + minutesLabel(derived.blockMean / 60),
        zoom: offsetOf(blockParts, 'trial')
      },
      {
        level: 'Run', parts: runParts, unit: 's',
        note: runReport.name + ' · ' + countLabel(structure.blocksPerRun, 'block')
          + ' · ' + countLabel(derived.trialsPerRun, 'trial') + ' · '
          + minutesLabel(derived.runMean / 60) + ' · '
          + H.fmtNumber(derived.volumesPerRun) + ' volumes',
        zoom: offsetOf(runParts, 'block')
      },
      {
        level: 'Session', parts: sessionParts, unit: 'min',
        note: (sessionReport ? sessionReport.name + ' · ' : '')
          + countLabel(sessionReport ? sessionReport.runs : 0, 'run') + ' · '
          + countLabel(sessionReport ? sessionReport.trials : 0, 'trial') + ' · '
          + minutesLabel(sessionReport ? sessionReport.meanMinutes : 0),
        zoom: offsetOf(sessionParts, 'run')
      },
      {
        level: 'Experiment', parts: experimentParts, unit: 'min',
        note: countLabel(d.sessions, 'session') + ' over ' + countLabel(weeks, 'week')
          + ' · ' + countLabel(d.trials, 'trial') + ' · '
          + H.round(d.totalHours, 1) + ' h',
        zoom: offsetOf(experimentParts, 'session')
      }
    ];
  }

  function assemblyFigureMarkup(experimentReport) {
    var rows = assemblyRows(experimentReport);
    if (!rows) return '';
    var uid = String(experimentReport.id).replace(/[^A-Za-z0-9_-]/g, '');

    var width = 1120;
    var padLeft = 26, padRight = 26;
    var inner = width - padLeft - padRight;
    var barHeight = 32;
    var connector = 34;
    var rowPitch = 18 + barHeight + connector;
    var top = 20;

    var svg = [];
    var lastBottom = top + (rows.length - 1) * rowPitch + 18 + barHeight;
    svg.push('<defs><pattern id="mx-cut-' + uid + '" width="6" height="6" '
      + 'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
      + '<line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" stroke-opacity="0.75" stroke-width="2"/>'
      + '</pattern></defs>');

    rows.forEach(function (row, index) {
      var barTop = top + index * rowPitch + 18;
      var total = H.sum(row.parts, function (part) { return part.span; }) || 1;
      row.barTop = barTop;
      row.scale = function (value) { return padLeft + inner * (value / total); };

      svg.push('<text x="' + padLeft + '" y="' + (barTop - 7) + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" letter-spacing="1.6" font-weight="600" fill="#00482B">'
        + row.level.toUpperCase() + '</text>');
      svg.push('<text x="' + (width - padRight) + '" y="' + (barTop - 7) + '" text-anchor="end" '
        + 'font-family="' + TIMELINE_SANS + '" font-size="11" fill="#3d4a4f">'
        + escapeHtml(row.note) + '</text>');

      var cursor = 0;
      var thin = row.parts.length > 1 && inner / row.parts.length < 3.5;
      row.parts.forEach(function (part) {
        var x = row.scale(cursor);
        var segment = inner * (part.span / total);
        var fill = part.role
          ? (ROLE_FILL[part.kind] || ROLE_FILL.other)
          : (ASSEMBLY_FILL[part.kind] || ASSEMBLY_FILL.trial);
        svg.push('<rect x="' + H.round(x, 2) + '" y="' + barTop + '" width="'
          + H.round(Math.max(segment, 0.6), 2) + '" height="' + barHeight + '" fill="' + fill
          + (thin ? '"' : '" stroke="#ffffff" stroke-width="1"') + '/>');
        if (part.cut) {
          svg.push('<rect x="' + H.round(x, 2) + '" y="' + barTop + '" width="'
            + H.round(Math.max(segment, 0.6), 2) + '" height="' + barHeight
            + '" fill="url(#mx-cut-' + uid + ')"/>');
        }
        if (segment > 46) {
          var text = row.unit === 'min'
            ? minutesLabel(part.span)
            : (part.span >= 120 ? minutesLabel(part.span / 60) : figureSeconds(part.span) + ' s');
          svg.push('<text x="' + H.round(x + segment / 2, 2) + '" y="' + (barTop + 20)
            + '" text-anchor="middle" font-family="' + TIMELINE_MONO + '" font-size="10.5" fill="'
            + (part.role
              ? (ROLE_DARK[part.kind] ? '#F2F1F0' : '#101820')
              : (ASSEMBLY_DARK[part.kind] ? '#F2F1F0' : '#101820'))
            + '">' + text + '</text>');
        }
        cursor += part.span;
      });
      svg.push('<rect x="' + padLeft + '" y="' + barTop + '" width="' + inner + '" height="'
        + barHeight + '" fill="none" stroke="#b9c0b4" stroke-width="1"/>');
    });

    /* Join each row to the element of the row below that contains it. */
    rows.forEach(function (row, index) {
      if (!row.zoom || index === 0) return;
      var above = rows[index - 1];
      var aboveBottom = above.barTop + barHeight;
      var left = row.scale(row.zoom.from);
      var right = Math.max(left + 1.2, row.scale(row.zoom.to));

      svg.push('<polygon points="' + padLeft + ',' + aboveBottom + ' ' + (width - padRight) + ','
        + aboveBottom + ' ' + H.round(right, 2) + ',' + row.barTop + ' ' + H.round(left, 2) + ','
        + row.barTop + '" fill="#CBA052" fill-opacity="0.12"/>');
      svg.push('<line x1="' + padLeft + '" y1="' + aboveBottom + '" x2="' + H.round(left, 2)
        + '" y2="' + row.barTop + '" stroke="#AE8643" stroke-width="1" stroke-dasharray="4 3"/>');
      svg.push('<line x1="' + (width - padRight) + '" y1="' + aboveBottom + '" x2="'
        + H.round(right, 2) + '" y2="' + row.barTop
        + '" stroke="#AE8643" stroke-width="1" stroke-dasharray="4 3"/>');
      svg.push('<rect x="' + H.round(left, 2) + '" y="' + row.barTop + '" width="'
        + H.round(right - left, 2) + '" height="' + barHeight
        + '" fill="none" stroke="#AE8643" stroke-width="1.6"/>');
    });

    /* Legend: trial phase roles first, then the structural elements. */
    var legendY = lastBottom + 26;
    var legendX = padLeft;
    var seen = {};
    var entries = [];
    rows[0].parts.forEach(function (part) {
      if (seen[part.kind]) return;
      seen[part.kind] = true;
      entries.push({ fill: ROLE_FILL[part.kind] || ROLE_FILL.other, label: part.kind });
    });
    ASSEMBLY_LEGEND.forEach(function (entry) {
      var used = rows.some(function (row, index) {
        return index > 0 && row.parts.some(function (part) { return part.kind === entry.kind; });
      });
      if (used) entries.push({ fill: ASSEMBLY_FILL[entry.kind], label: entry.label });
    });

    entries.forEach(function (entry) {
      var span = 26 + entry.label.length * 6.4;
      if (legendX + span > width - padRight) { legendX = padLeft; legendY += 18; }
      svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" fill="'
        + entry.fill + '" stroke="#b9c0b4" stroke-width="1"/>');
      svg.push('<text x="' + (legendX + 16) + '" y="' + legendY + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" fill="#3d4a4f">' + escapeHtml(entry.label) + '</text>');
      legendX += span;
    });

    var height = legendY + 14;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height
      + '" width="' + width + '" height="' + height + '" role="img">'
      + '<title>' + escapeHtml(experimentReport.name) + ' assembly</title>'
      + '<rect width="' + width + '" height="' + height + '" fill="#ffffff"/>'
      + svg.join('') + '</svg>';
  }

  /* ----------------------------------------------------------- study figure */

  /* The whole study on one axis: every experiment as a band of sessions, drawn
   * to scale against the usable budget, with what the plan leaves unspent. */
  function studyFigureMarkup() {
    if (!App.report) return '';
    var experiments = App.report.experiments;
    if (!experiments.length) return '';
    var totals = App.report.totals;

    var width = 1120;
    var padLeft = 150, padRight = 90;
    var inner = width - padLeft - padRight;
    var rowHeight = 34, rowGap = 12;
    var top = 54;
    var budgetHours = Math.max(totals.usableHours, totals.committedHours, 0.01);

    var svg = [];
    svg.push('<text x="' + padLeft + '" y="22" font-family="' + TIMELINE_SANS
      + '" font-size="10.5" letter-spacing="1.6" font-weight="600" fill="#00482B">'
      + 'SCANNER TIME — ' + H.round(totals.committedHours, 1) + ' H COMMITTED OF '
      + H.round(totals.usableHours, 1) + ' H USABLE</text>');

    /* The budget ruler across the top. */
    var hourStep = niceStep(budgetHours, 8);
    for (var hour = 0; hour <= budgetHours + 0.001; hour += hourStep) {
      var x = padLeft + inner * (hour / budgetHours);
      svg.push('<line x1="' + H.round(x, 2) + '" y1="34" x2="' + H.round(x, 2) + '" y2="'
        + (top + experiments.length * (rowHeight + rowGap) + 4)
        + '" stroke="#EFEEE9" stroke-width="1"/>');
      svg.push('<text x="' + H.round(x, 2) + '" y="30" text-anchor="middle" font-family="'
        + TIMELINE_MONO + '" font-size="10.5" fill="#6b767b">' + H.round(hour, 1) + ' h</text>');
    }

    experiments.forEach(function (experiment, index) {
      var y = top + index * (rowHeight + rowGap);
      var d = experiment.derived;
      var colour = experimentColour(experiment.id);
      var barWidth = inner * (d.totalHours / budgetHours);

      svg.push('<text x="' + (padLeft - 10) + '" y="' + (y + 15) + '" text-anchor="end" '
        + 'font-family="' + TIMELINE_SANS + '" font-size="12" font-weight="600" fill="#101820">'
        + escapeHtml(figureClip(experiment.name, 24)) + '</text>');
      svg.push('<text x="' + (padLeft - 10) + '" y="' + (y + 28) + '" text-anchor="end" '
        + 'font-family="' + TIMELINE_MONO + '" font-size="10" fill="#6b767b">'
        + H.fmtNumber(d.units) + ' ' + escapeHtml(experiment.unit.plural) + '</text>');

      /* One tick per session, so the granularity of the plan is visible. */
      var sessions = Math.max(0, d.sessions);
      var perSession = sessions > 0 ? barWidth / sessions : 0;
      svg.push('<rect x="' + padLeft + '" y="' + y + '" width="' + H.round(Math.max(barWidth, 0), 2)
        + '" height="' + rowHeight + '" fill="' + colour + '" fill-opacity="0.9"/>');
      if (perSession > 2.5 && sessions <= 260) {
        for (var s = 1; s < sessions; s += 1) {
          var sx = padLeft + perSession * s;
          svg.push('<line x1="' + H.round(sx, 2) + '" y1="' + y + '" x2="' + H.round(sx, 2)
            + '" y2="' + (y + rowHeight) + '" stroke="#ffffff" stroke-opacity="0.55" '
            + 'stroke-width="1"/>');
        }
      }
      svg.push('<rect x="' + padLeft + '" y="' + y + '" width="' + inner + '" height="' + rowHeight
        + '" fill="none" stroke="#d8dcd5" stroke-width="1"/>');
      svg.push('<text x="' + (padLeft + inner + 8) + '" y="' + (y + 14) + '" font-family="'
        + TIMELINE_MONO + '" font-size="10.5" fill="#101820">' + H.round(d.totalHours, 1)
        + ' h</text>');
      svg.push('<text x="' + (padLeft + inner + 8) + '" y="' + (y + 27) + '" font-family="'
        + TIMELINE_MONO + '" font-size="10" fill="#6b767b">' + countLabel(d.sessions, 'sess')
        + '</text>');
    });

    var barsBottom = top + experiments.length * (rowHeight + rowGap);

    /* The unspent remainder. */
    var spent = inner * (Math.min(totals.committedHours, budgetHours) / budgetHours);
    svg.push('<rect x="' + padLeft + '" y="' + (barsBottom + 6) + '" width="' + inner
      + '" height="14" fill="#F2F1F0" stroke="#d8dcd5" stroke-width="1"/>');
    svg.push('<rect x="' + padLeft + '" y="' + (barsBottom + 6) + '" width="'
      + H.round(spent, 2) + '" height="14" fill="#00482B" fill-opacity="0.82"/>');
    svg.push('<text x="' + (padLeft - 10) + '" y="' + (barsBottom + 17) + '" text-anchor="end" '
      + 'font-family="' + TIMELINE_SANS + '" font-size="11" fill="#3d4a4f">Budget</text>');
    svg.push('<text x="' + (padLeft + inner + 8) + '" y="' + (barsBottom + 17) + '" font-family="'
      + TIMELINE_MONO + '" font-size="10.5" fill="#101820">' + totals.utilisationPct + ' %</text>');

    var legendY = barsBottom + 44;
    svg.push('<text x="' + padLeft + '" y="' + legendY + '" font-family="' + TIMELINE_SANS
      + '" font-size="10.5" fill="#6b767b">Each division is one session. '
      + H.fmtNumber(totals.sessions) + ' sessions, ' + H.fmtNumber(totals.runs) + ' runs, '
      + H.fmtNumber(totals.trials) + ' trials, ' + totals.dataVolumeGb + ' GB.</text>');

    var height = legendY + 18;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height
      + '" width="' + width + '" height="' + height + '" role="img">'
      + '<title>' + escapeHtml(App.state.meta.studyTitle) + ' scanner time</title>'
      + '<rect width="' + width + '" height="' + height + '" fill="#ffffff"/>'
      + svg.join('') + '</svg>';
  }

  /* ------------------------------------------------------- figure export */

  function fileStem(text, suffix) {
    return String(text || 'figure').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + (suffix ? '-' + suffix : '');
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = h('a', { href: url, download: filename, style: 'display:none' });
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(function () {
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }, 400);
  }

  function downloadFigureSvg(markup, stem) {
    if (!markup) { toast('Nothing to export yet.', 'bad'); return; }
    saveBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), stem + '.svg');
    toast('Figure SVG downloaded', 'ok');
  }

  /* PNG goes through an <img> of the serialised SVG, drawn larger than nominal
   * so the figure stays sharp in a slide or a grant page. */
  function figurePng(markup, scale) {
    return new Promise(function (resolve, reject) {
      if (!markup) { reject(new Error('no figure')); return; }
      /* Decoding is the browser's business and it can simply never come back -
       * a background tab, a paused renderer.  The bundle must not wait for
       * ever, so give up and let the caller ship the SVG on its own. */
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('PNG rasterisation timed out'));
      }, 10000);
      function finish(fn) {
        return function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
      }
      resolve = finish(resolve);
      reject = finish(reject);

      var image = new Image();
      image.onload = function () {
        var factor = scale || 3;
        var canvas = h('canvas');
        canvas.width = Math.max(1, image.width * factor);
        canvas.height = Math.max(1, image.height * factor);
        var pen = canvas.getContext('2d');
        pen.fillStyle = '#ffffff';
        pen.fillRect(0, 0, canvas.width, canvas.height);
        pen.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('toBlob failed')); return; }
          resolve({ blob: blob, canvas: canvas });
        }, 'image/png');
      };
      image.onerror = function () { reject(new Error('SVG could not be rasterised')); };
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    });
  }

  function downloadFigurePng(markup, stem) {
    figurePng(markup, 3).then(function (result) {
      saveBlob(result.blob, stem + '.png');
      toast('Figure PNG downloaded', 'ok');
    }).catch(function () { toast('PNG export failed; use the SVG instead.', 'bad'); });
  }

  /* A figure card with its own SVG/PNG buttons and a live re-render. */
  function figureCard(title, note, render, stem, extraButtons, owner) {
    var host = h('div', { class: 'timeline-figure' });
    var caption = h('div', { class: 'plot-caption' });
    var markup = '';

    var node = card(title, note, [
      host, caption,
      h('div', { class: 'btn-row mt' }, [
        iconButton('Download SVG', 'Vector figure for a manuscript or a grant page',
          function () { downloadFigureSvg(markup, stem()); }),
        iconButton('Download PNG', 'Raster figure at three times nominal size',
          function () { downloadFigurePng(markup, stem()); })
      ].concat(extraButtons || []))
    ]);

    registerView(function () {
      var result = render() || {};
      markup = result.markup || '';
      host.innerHTML = markup;
      if (!markup) {
        clear(host);
        host.appendChild(h('div', {
          class: 'notice', text: result.empty || 'Nothing to draw yet.'
        }));
      }
      caption.textContent = markup ? (result.caption || '') : '';
    }, owner);

    node.figure = function () { return markup; };
    return node;
  }

  /* Everything the export bundle should carry as a picture. */
  function collectFigures() {
    var figures = [];
    if (!App.report) return figures;
    figures.push({ name: 'study-scanner-time', svg: studyFigureMarkup() });
    App.report.trials.forEach(function (trial) {
      var stateTrial = M.byId(App.state.trials, trial.id);
      figures.push({
        name: fileStem(trial.name, 'trial-timeline'),
        svg: trialFigureMarkup(stateTrial, 0)
      });
    });
    App.report.experiments.forEach(function (experiment) {
      figures.push({
        name: fileStem(experiment.name, 'assembly'),
        svg: assemblyFigureMarkup(experiment)
      });
    });
    return figures.filter(function (figure) { return figure.svg; });
  }

  /* --------------------------------------------------- allocation units */

  /* The experiment sliders can be driven in whichever unit the user is
   * actually thinking in: share of scanner time, hours of scanner time, or
   * number of sessions.  All three write the same underlying allocation. */

  function usableHours(state) {
    return H.num(state.budget.totalScannerHours)
      * (1 - H.clamp(H.num(state.budget.contingencyPct), 0, 90) / 100);
  }

  function allocationUnit() { return App.state.budget.allocationUnit || 'percent'; }

  function solvedSessions(id) {
    if (!App.report) return 0;
    var record = App.report.experiments.filter(function (item) { return item.id === id; })[0];
    return record ? record.derived.sessions : 0;
  }

  /* Switching to the session unit means the numbers on the sliders have to be
   * the ones the solver is using, so seed them and move into manual mode. */
  function adoptSessionUnit() {
    App.state.experiments.forEach(function (experiment) {
      if (!experiment.enabled) return;
      experiment.manualSessions = solvedSessions(experiment.id);
    });
    App.state.budget.solveMode = 'manual';
  }

  function allocationUnitToggle(label) {
    return segmented({
      label: label || 'Drive the sliders in',
      path: 'budget.allocationUnit',
      hint: 'Percent of scanner time, hours of it, or sessions',
      options: M.ALLOCATION_UNITS.map(function (unit) {
        return { value: unit.id, label: unit.label };
      }),
      onChange: function (value) {
        if (value === 'sessions') adoptSessionUnit();
      }
    });
  }

  function allocationSlider(experiment, owner) {
    var id = experiment.id;
    return slider({
      owner: owner,
      label: experiment.name,
      min: 0,
      max: 100,
      step: 0.5,
      decimals: 1,
      unit: '%',
      get: function (state) {
        var target = M.experimentById(state, id);
        var unit = allocationUnit();
        if (unit === 'hours') {
          return H.num(target && target.requestedPct) / 100 * usableHours(state);
        }
        if (unit === 'sessions') {
          return H.num(target && target.manualSessions, solvedSessions(id));
        }
        return H.num(target && target.requestedPct);
      },
      set: function (value, state) {
        var target = M.experimentById(state, id);
        if (!target) return;
        var unit = allocationUnit();
        if (unit === 'sessions') {
          target.manualSessions = Math.max(0, Math.round(value));
          state.budget.solveMode = 'manual';
          return;
        }
        if (unit === 'hours') {
          var hours = usableHours(state);
          target.requestedPct = hours > 0 ? H.clamp(value / hours * 100, 0, 100) : 0;
        } else {
          target.requestedPct = H.clamp(value, 0, 100);
        }
        M.normaliseAllocation(state, id);
      },
      dynamicMax: function (state) {
        var unit = allocationUnit();
        if (unit === 'hours') return Math.max(1, usableHours(state));
        if (unit === 'sessions') return Math.max(1, H.num(state.caps.maxSessionsTotal, 100));
        return 100;
      },
      dynamicUnit: function () {
        var unit = allocationUnit();
        return unit === 'hours' ? 'h' : (unit === 'sessions' ? 'sess' : '%');
      },
      disabledWhen: function (state) {
        var target = M.experimentById(state, id);
        return !target || !target.enabled
          || (allocationUnit() !== 'sessions' && !!target.locked);
      }
    });
  }

  /* One row per experiment: the slider, a lock, and whatever the caller wants
   * to hang beside it. */
  function allocationRows(owner, decorate) {
    var host = h('div', {});
    registerView(function () {
      dropControls(owner);
      clear(host);
      (App.state.experiments || []).forEach(function (experiment) {
        var lock = h('button', {
          class: 'btn quiet sm' + (experiment.locked ? ' active' : ''),
          type: 'button',
          text: experiment.locked ? 'Locked' : 'Lock',
          title: 'Hold this share while the others redistribute',
          onclick: function () {
            experiment.locked = !experiment.locked;
            App.refresh();
          }
        });
        var row = h('div', { class: 'alloc-row' }, [
          h('span', { class: 'swatch', style: 'background:' + experimentColour(experiment.id) }),
          allocationSlider(experiment, owner),
          lock
        ]);
        if (decorate) decorate(row, experiment);
        host.appendChild(row);
      });
      App.controls.forEach(function (entry) {
        if (entry.owner === owner) entry.sync();
      });
    });
    return host;
  }

  function allocationBar() {
    var bar = h('div', { class: 'alloc-bar' });
    var legend = h('div', { class: 'alloc-legend' });
    registerView(function (report) {
      clear(bar);
      clear(legend);
      report.experiments.forEach(function (experiment) {
        var share = experiment.derived.sharePct;
        if (share <= 0) return;
        bar.appendChild(h('div', {
          class: 'seg-fill',
          style: 'width:' + share + '%;background:' + experimentColour(experiment.id),
          title: experiment.name + ' - ' + share + '%'
        }));
        legend.appendChild(h('span', { class: 'legend-item' }, [
          h('span', { class: 'swatch', style: 'background:' + experimentColour(experiment.id) }),
          h('span', { text: experiment.name + ' ' + H.round(share, 1) + '%' })
        ]));
      });
      if (!bar.children.length) {
        bar.appendChild(h('div', {
          class: 'seg-fill', style: 'width:100%;background:#EFEEE9'
        }));
      }
    });
    return h('div', {}, [bar, legend]);
  }

  /* ------------------------------------------------------------- masthead */

  function buildMetrics() {
    var host = document.getElementById('metrics');
    registerView(function (report) {
      var totals = report.totals;
      clear(host);

      function metric(key, value, tone) {
        host.appendChild(h('div', { class: 'metric' + (tone ? ' ' + tone : '') }, [
          h('div', { class: 'k', text: key }),
          h('div', { class: 'v', text: value })
        ]));
      }

      metric('Sessions', H.fmtNumber(totals.sessions));
      metric('Trials', H.fmtNumber(totals.trials));

      report.experiments.forEach(function (experiment) {
        var d = experiment.derived;
        host.appendChild(h('div', {
          class: 'metric chip',
          title: experiment.name + ': ' + H.fmtNumber(d.units) + ' ' + experiment.unit.plural
            + ', ' + d.sessions + ' sessions, ' + d.totalHours + ' h'
        }, [
          h('div', { class: 'k' }, [
            h('span', { class: 'swatch', style: 'background:' + experimentColour(experiment.id) }),
            h('span', { text: experiment.short || experiment.name })
          ]),
          h('div', {
            class: 'v',
            text: H.fmtNumber(d.units) + ' · ' + d.sessions + 's · ' + d.sharePct + '%'
          })
        ]));
      });

      metric('Hours', totals.committedHours + ' / ' + totals.usableHours);
      metric('Utilisation', totals.utilisationPct + ' %',
        totals.utilisationPct > 100 ? 'bad' : (totals.utilisationPct > 92 ? 'warn' : 'ok'));
      metric('Data', totals.dataVolumeGb + ' GB');
      metric('Flags', String(totals.warningCount),
        totals.warningCount ? 'warn' : 'ok');
    });
  }

  /* ------------------------------------------------------------- overview */

  function experimentTiles() {
    var host = h('div', { class: 'tiles' });
    registerView(function (report) {
      clear(host);
      report.experiments.forEach(function (experiment) {
        var d = experiment.derived;
        var colour = experimentColour(experiment.id);
        var progress = H.clamp(d.targetProgressPct, 0, 100);

        host.appendChild(h('div', { class: 'tile', style: '--accent:' + colour }, [
          h('div', { class: 'tile-head' }, [
            h('span', { class: 'swatch', style: 'background:' + colour }),
            h('h4', { text: experiment.name }),
            h('span', { class: 'pill', text: d.sharePct + '% of time' })
          ]),
          h('div', { class: 'tile-figure' }, [
            h('span', { class: 'big', text: H.fmtNumber(d.units) }),
            h('span', { class: 'unit', text: experiment.unit.plural + ' recorded' })
          ]),
          h('div', { class: 'tile-grid' }, [
            readoutCell('Trials', H.fmtNumber(d.trials)),
            readoutCell('Control', H.fmtNumber(d.controlTrials)),
            readoutCell('Per session', H.fmtNumber(d.unitsPerSession, 1)),
            readoutCell('Sessions', H.fmtNumber(d.sessions)),
            readoutCell('Runs', H.fmtNumber(d.runs)),
            readoutCell('Scanner time', d.totalHours + ' h'),
            readoutCell('Data', d.gbTotal + ' GB'),
            readoutCell('Session length', d.sessionMeanMinutes + ' min')
          ]),
          d.targetUnits > 0 ? h('div', { class: 'tile-goal' }, [
            h('div', { class: 'goal-bar' }, [
              h('div', {
                class: 'goal-fill',
                style: 'width:' + progress + '%;background:' + colour
              })
            ]),
            h('div', {
              class: 'goal-note',
              text: H.fmtNumber(d.units) + ' of ' + H.fmtNumber(d.targetUnits) + ' '
                + experiment.unit.plural + ' · ' + d.targetProgressPct + '%'
            })
          ]) : null
        ]));
      });
      if (!host.children.length) {
        host.appendChild(h('div', {
          class: 'notice',
          text: 'No experiments are enabled. Turn one on in the Experiments panel.'
        }));
      }
    });
    return host;
  }

  function buildOverview() {
    var owner = 'overview';
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'Overview' }),
      h('p', {
        text: 'The whole study on one page: what each experiment collects, what it costs, '
          + 'and the handful of controls that move the plan.'
      })
    ]));

    var headline = h('div', { class: 'headline-strip' });
    registerView(function (report) {
      var totals = report.totals;
      clear(headline);
      [
        ['Sessions', H.fmtNumber(totals.sessions)],
        ['Runs', H.fmtNumber(totals.runs)],
        ['Trials', H.fmtNumber(totals.trials)],
        ['Scanner hours', totals.committedHours + ' h'],
        ['Usable hours', totals.usableHours + ' h'],
        ['Utilisation', totals.utilisationPct + ' %'],
        ['Weeks needed', totals.weeksNeeded + ' / ' + totals.weeksAvailable],
        ['Raw data', totals.dataVolumeGb + ' GB']
      ].forEach(function (pair) {
        headline.appendChild(h('div', { class: 'headline-cell' }, [
          h('div', { class: 'k', text: pair[0] }),
          h('div', { class: 'v', text: pair[1] })
        ]));
      });
    });

    var goalReadback = h('div', { class: 'notice mt' });
    registerView(function (report) {
      var totals = report.totals;
      var mode = App.state.budget.solveMode;
      if (mode === 'fill' && totals.goalTotal > 0) {
        goalReadback.textContent = H.fmtNumber(totals.units) + ' of the '
          + H.fmtNumber(totals.goalTotal) + ' asked for (' + totals.goalProgressPct
          + '%), spending ' + totals.committedHours + ' of ' + totals.usableHours
          + ' usable hours (' + totals.utilisationPct + '%).';
      } else if (mode === 'budget') {
        goalReadback.textContent = 'Spending the whole budget: ' + totals.committedHours
          + ' of ' + totals.usableHours + ' usable hours buys ' + H.fmtNumber(totals.trials)
          + ' trials across ' + H.fmtNumber(totals.sessions) + ' sessions.';
      } else if (mode === 'target') {
        goalReadback.textContent = 'Running each experiment to its own goal needs '
          + totals.committedHours + ' h against ' + totals.usableHours + ' h usable ('
          + totals.utilisationPct + '%).';
      } else {
        goalReadback.textContent = H.fmtNumber(totals.sessions)
          + ' sessions set by hand cost ' + totals.committedHours + ' h of the '
          + totals.usableHours + ' h usable (' + totals.utilisationPct + '%).';
      }
    });

    var masterCard = card('Master controls', 'What to solve for, and how much time there is', [
      segmented({
        label: 'Solve for', path: 'budget.solveMode',
        options: M.SOLVE_MODES.map(function (mode) {
          return { value: mode.id, label: mode.label, hint: mode.blurb };
        })
      }),
      slider({
        label: 'Total primary events to collect', path: 'budget.targetUnitsTotal',
        min: 0, max: 20000, step: 50, unit: 'ev',
        hint: 'Used by the "One total goal" mode',
        disabledWhen: function (state) { return state.budget.solveMode !== 'fill'; }
      }),
      slider({
        label: 'Scanner hours available', path: 'budget.totalScannerHours',
        min: 1, max: 600, step: 1, unit: 'h', gold: true
      }),
      slider({
        label: 'Contingency reserve', path: 'budget.contingencyPct',
        min: 0, max: 40, step: 1, unit: '%',
        hint: 'Held back for aborted runs and re-scans'
      }),
      slider({
        label: 'Sessions per week', path: 'budget.sessionsPerWeek',
        min: 1, max: 14, step: 1, unit: '/wk'
      }),
      slider({
        label: 'Weeks available', path: 'budget.weeksAvailable',
        min: 1, max: 104, step: 1, unit: 'wk'
      }),
      slider({
        label: 'Longest session', path: 'caps.maxSessionMinutes',
        min: 20, max: 240, step: 5, unit: 'min'
      }),
      goalReadback
    ]);

    var allocationCard = card('Time split between experiments',
      'Drag one and the rest redistribute', [
        allocationUnitToggle(),
        allocationRows(owner),
        allocationBar(),
        h('div', { class: 'btn-row mt' }, [
          iconButton('Balance to the goals',
            'Set the shares implied by each experiment\'s own goal',
            function () {
              var next = M.balanceToTarget(App.state, App.boot);
              App.adopt(next);
              toast('Shares balanced against the per-experiment goals', 'ok');
            }),
          iconButton('Even split', 'Give every enabled experiment the same share', function () {
            var active = M.enabledExperiments(App.state);
            active.forEach(function (experiment) {
              experiment.locked = false;
              experiment.requestedPct = active.length ? H.round(100 / active.length, 2) : 0;
            });
            M.normaliseAllocation(App.state, null);
            App.refresh();
          })
        ])
      ]);

    var goalsHost = h('div', {});
    registerView(function () {
      dropControls('overview-goals');
      clear(goalsHost);
      (App.state.experiments || []).forEach(function (experiment) {
        if (!experiment.enabled) return;
        var unit = M.unitOf(experiment);
        goalsHost.appendChild(slider({
          owner: 'overview-goals',
          label: experiment.name + ' goal',
          min: 0, max: 20000, step: 25, unit: unit.short,
          get: function (state) {
            var target = M.experimentById(state, experiment.id);
            return H.num(target && target.targetUnits);
          },
          set: function (value, state) {
            var target = M.experimentById(state, experiment.id);
            if (target) target.targetUnits = Math.max(0, Math.round(value));
          },
          hint: unit.plural
        }));
      });
      App.controls.forEach(function (entry) {
        if (entry.owner === 'overview-goals') entry.sync();
      });
    });

    var goalCard = card('Per-experiment goals', 'What each experiment is trying to collect',
      [goalsHost]);

    var studyFigure = figureCard('Scanner time across the study', '', function () {
      return {
        markup: studyFigureMarkup(),
        caption: 'Each division is one session, drawn to scale against the usable budget.',
        empty: 'Add an experiment to draw the study figure.'
      };
    }, function () { return fileStem(App.state.meta.studyTitle, 'scanner-time'); });

    var summaryHost = h('div', {});
    registerView(function (report) {
      clear(summaryHost);
      summaryHost.appendChild(dataTable(
        [{ label: 'Experiment' }, { label: 'Unit' }, { label: 'Sessions', num: true },
          { label: 'Runs', num: true }, { label: 'Trials', num: true },
          { label: 'Collected', num: true }, { label: 'Goal', num: true },
          { label: 'Hours', num: true }, { label: 'Share', num: true },
          { label: 'Data', num: true }],
        report.experiments.map(function (experiment) {
          var d = experiment.derived;
          return [
            { html: '<span class="swatch" style="background:'
              + experimentColour(experiment.id) + '"></span>' + escapeHtml(experiment.name),
              copy: experiment.name },
            experiment.unit.plural,
            { text: H.fmtNumber(d.sessions), num: true },
            { text: H.fmtNumber(d.runs), num: true },
            { text: H.fmtNumber(d.trials), num: true },
            { text: H.fmtNumber(d.units), num: true },
            { text: d.targetUnits ? H.fmtNumber(d.targetUnits) : '-', num: true },
            { text: d.totalHours + ' h', num: true },
            { text: d.sharePct + ' %', num: true },
            { text: d.gbTotal + ' GB', num: true }
          ];
        }).concat([{
          className: 'total',
          cells: [
            'Total', '', { text: H.fmtNumber(report.totals.sessions), num: true },
            { text: H.fmtNumber(report.totals.runs), num: true },
            { text: H.fmtNumber(report.totals.trials), num: true },
            { text: H.fmtNumber(report.totals.units), num: true },
            { text: report.totals.goalTotal ? H.fmtNumber(report.totals.goalTotal) : '-', num: true },
            { text: report.totals.committedHours + ' h', num: true },
            { text: '100 %', num: true },
            { text: report.totals.dataVolumeGb + ' GB', num: true }
          ]
        }]),
        { caption: 'Study summary' }
      ));
    });

    panel.appendChild(headline);
    panel.appendChild(experimentTiles());
    panel.appendChild(h('div', { class: 'grid split' }, [
      h('div', {}, [masterCard, goalCard]),
      h('div', {}, [allocationCard, buildWarningsCard()])
    ]));
    panel.appendChild(studyFigure);
    panel.appendChild(card('Study summary', 'Every experiment, side by side', [summaryHost]));
    return panel;
  }

  function buildWarningsCard() {
    var host = h('div', {});
    var node = card('Constraint report', 'What the solver had to change', [host]);
    registerView(function (report) {
      clear(host);
      if (!report.warnings.length) {
        host.appendChild(h('div', {
          class: 'notice ok', text: 'No constraint flags: every cap is satisfied.'
        }));
        return;
      }
      var list = h('ul', { class: 'warn-list' });
      report.warnings.forEach(function (warning) {
        list.appendChild(h('li', { text: warning }));
      });
      host.appendChild(list);
      host.appendChild(h('div', { class: 'btn-row mt' }, [
        iconButton('Copy constraint report', 'Copy the flags as Markdown', function () {
          copy(App.report.markdownTables['Constraint report'] || '', 'Constraint report');
        })
      ]));
    });
    return node;
  }

  /* --------------------------------------------------------------- budget */

  function buildBudgetPanel() {
    var owner = 'budget';
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'Budget and constraints' }),
      h('p', {
        text: 'The scanner-time envelope every experiment is solved inside, and the caps '
          + 'the solver is allowed to repair a design against.'
      })
    ]));

    var solveCard = card('Solve mode', 'How session counts are decided', [
      segmented({
        label: 'Solve for', path: 'budget.solveMode',
        options: M.SOLVE_MODES.map(function (mode) {
          return { value: mode.id, label: mode.label, hint: mode.blurb };
        })
      }),
      h('div', { class: 'notice', id: 'solve-blurb' }),
      slider({
        label: 'Total primary events to collect', path: 'budget.targetUnitsTotal',
        min: 0, max: 40000, step: 50, unit: 'ev',
        disabledWhen: function (state) { return state.budget.solveMode !== 'fill'; }
      }),
      checkbox({
        label: 'Count setup, structurals and breaks against the budget',
        path: 'budget.countOverheadAgainstBudget',
        hint: 'Off means only functional acquisition is charged to the hours'
      }),
      checkbox({
        label: 'Auto-clamp designs that break a cap',
        path: 'budget.autoClamp',
        hint: 'Reduces blocks, trials per block or runs per session, and says so'
      })
    ]);

    registerView(function () {
      var blurb = document.getElementById('solve-blurb');
      if (!blurb) return;
      var mode = M.SOLVE_MODES.filter(function (entry) {
        return entry.id === App.state.budget.solveMode;
      })[0];
      blurb.textContent = mode ? mode.blurb : '';
    });

    var envelopeCard = card('Scanner-time envelope', 'What is actually available', [
      slider({
        label: 'Total scanner hours', path: 'budget.totalScannerHours',
        min: 1, max: 1000, step: 1, unit: 'h', gold: true
      }),
      slider({
        label: 'Contingency reserve', path: 'budget.contingencyPct',
        min: 0, max: 50, step: 1, unit: '%'
      }),
      slider({
        label: 'Sessions per week', path: 'budget.sessionsPerWeek',
        min: 1, max: 14, step: 1, unit: '/wk'
      }),
      slider({
        label: 'Weeks available', path: 'budget.weeksAvailable',
        min: 1, max: 156, step: 1, unit: 'wk'
      })
    ]);

    var capsCard = card('Constraint envelope', 'Caps the solver may repair against', [
      segmented({
        label: 'Apply caps to', path: 'caps.applyTo',
        hint: 'The expected duration, or the worst-case longest one',
        options: [
          { value: 'expected', label: 'Expected duration' },
          { value: 'longest', label: 'Longest duration' }
        ]
      }),
      slider({ label: 'Maximum run duration', path: 'caps.maxRunMinutes', min: 1, max: 60, step: 1, unit: 'min' }),
      slider({ label: 'Maximum session duration', path: 'caps.maxSessionMinutes', min: 20, max: 300, step: 5, unit: 'min' }),
      slider({ label: 'Maximum runs per session', path: 'caps.maxRunsPerSession', min: 1, max: 20, step: 1, unit: 'runs' }),
      slider({ label: 'Maximum sessions in total', path: 'caps.maxSessionsTotal', min: 1, max: 500, step: 1, unit: 'sess' }),
      slider({ label: 'Continuous-scanning comfort limit', path: 'caps.maxContinuousMinutes', min: 5, max: 60, step: 1, unit: 'min' }),
      slider({ label: 'Minimum per experiment', path: 'caps.minUnitsPerExperiment', min: 0, max: 2000, step: 10, unit: 'ev' })
    ]);

    var allocationCard = card('Allocation', 'One set of sliders, in whichever unit you think in', [
      allocationUnitToggle(),
      allocationRows(owner),
      allocationBar()
    ]);

    var budgetTable = h('div', {});
    registerView(function (report) {
      clear(budgetTable);
      var totals = report.totals;
      budgetTable.appendChild(h('div', { class: 'readout' }, [
        readoutCell('Total hours', totals.totalScannerHours + ' h'),
        readoutCell('Usable hours', totals.usableHours + ' h'),
        readoutCell('Committed', totals.committedHours + ' h'),
        readoutCell('Functional', totals.functionalHours + ' h'),
        readoutCell('Overhead', totals.overheadHours + ' h'),
        readoutCell('Remaining', totals.remainingHours + ' h'),
        readoutCell('Utilisation', totals.utilisationPct + ' %'),
        readoutCell('Weeks needed', totals.weeksNeeded + ' / ' + totals.weeksAvailable)
      ]));
      budgetTable.appendChild(dataTable(
        [{ label: 'Experiment' }, { label: 'Requested', num: true },
          { label: 'Solved share', num: true }, { label: 'Sessions', num: true },
          { label: 'Functional h', num: true }, { label: 'Overhead h', num: true },
          { label: 'Total h', num: true }],
        report.experiments.map(function (experiment) {
          var d = experiment.derived;
          return [
            experiment.name,
            { text: H.round(experiment.requestedPct, 1) + ' %', num: true },
            { text: d.sharePct + ' %', num: true },
            { text: H.fmtNumber(d.sessions), num: true },
            { text: d.functionalHours, num: true },
            { text: d.overheadHours, num: true },
            { text: d.totalHours, num: true }
          ];
        }).concat([{
          className: 'total',
          cells: ['Total', { text: '100 %', num: true }, { text: '100 %', num: true },
            { text: H.fmtNumber(totals.sessions), num: true },
            { text: totals.functionalHours, num: true },
            { text: totals.overheadHours, num: true },
            { text: totals.committedHours, num: true }]
        }]),
        { caption: 'Budget and allocation' }
      ));
    });

    panel.appendChild(h('div', { class: 'grid split' }, [
      h('div', {}, [solveCard, envelopeCard]),
      h('div', {}, [allocationCard, capsCard])
    ]));
    panel.appendChild(card('Budget breakdown', 'Where the hours go', [budgetTable]));
    panel.appendChild(buildWarningsCard());
    return panel;
  }

  /* ------------------------------------------------------------- metadata */

  function buildStudyPanel() {
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'Study details' }),
      h('p', { text: 'What goes on the front of every export.' })
    ]));
    panel.appendChild(card('Identification', null, [
      field({ label: 'Study title', path: 'meta.studyTitle', stack: true }),
      field({ label: 'Investigator', path: 'meta.investigator', stack: true }),
      field({ label: 'Institution', path: 'meta.institution', stack: true }),
      field({ label: 'Participant ID', path: 'meta.participantId', stack: true }),
      field({ label: 'Design ID', path: 'meta.designId', stack: true }),
      field({ label: 'Notes', path: 'meta.notes', type: 'textarea', rows: 4, stack: true })
    ]));
    return panel;
  }

  /* ------------------------------------------------------------------ rail */

  var PANELS = [
    { id: 'overview', label: 'Overview', hint: 'The whole study on one page', build: buildOverview },
    { id: 'experiments', label: 'Experiments', hint: 'Sessions combined into experiments',
      build: function () { return global.PlannerLibrary.buildExperiments(); } },
    { id: 'sessions', label: 'Sessions', hint: 'Named sessions built from runs',
      build: function () { return global.PlannerLibrary.buildSessions(); } },
    { id: 'runs', label: 'Runs', hint: 'Trials laid out into blocks and runs',
      build: function () { return global.PlannerLibrary.buildRuns(); } },
    { id: 'trials', label: 'Trials', hint: 'What one trial looks like',
      build: function () { return global.PlannerLibrary.buildTrials(); } },
    { id: 'hrf', label: 'HRF model', hint: 'The response, and what counts as separated',
      build: function () { return global.PlannerLibrary.buildHrf(); } },
    { id: 'budget', label: 'Budget', hint: 'Scanner time and caps', build: buildBudgetPanel },
    { id: 'acquisition', label: 'Acquisition', hint: 'Scanner parameter cards',
      build: function () { return global.PlannerProtocols.build(); } },
    { id: 'study', label: 'Study details', hint: 'Titles and identifiers', build: buildStudyPanel },
    { id: 'export', label: 'Report and export', hint: 'Markdown, PsychoPy, XLSX, zip',
      build: function () { return global.PlannerExport.build(); } }
  ];

  function buildRail() {
    var rail = document.getElementById('rail');
    clear(rail);
    PANELS.forEach(function (entry) {
      var button = h('button', { class: 'rail-item', type: 'button' }, [
        h('span', { class: 'label', text: entry.label }),
        h('span', { class: 'hint', text: entry.hint })
      ]);
      button.addEventListener('click', function () { show(entry.id); });
      rail.appendChild(button);
      App.railItems[entry.id] = button;
    });
  }

  function show(id) {
    var workspace = document.getElementById('workspace');
    App.activePanel = id;
    Object.keys(App.railItems).forEach(function (key) {
      App.railItems[key].classList.toggle('active', key === id);
    });
    clear(workspace);
    if (!App.panels[id]) {
      var entry = PANELS.filter(function (item) { return item.id === id; })[0];
      App.panels[id] = entry ? entry.build() : h('div', { class: 'panel' });
    }
    App.panels[id].classList.add('active');
    workspace.appendChild(App.panels[id]);
    App.refresh();
    workspace.scrollTop = 0;
  }

  /* -------------------------------------------------------------- runtime */

  var saveTimer = null;
  function scheduleAutosave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch('/api/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'current', design: App.state })
      }).catch(function () { /* autosave is best-effort */ });
    }, 1200);
  }

  function syncControls() {
    App.controls.forEach(function (entry) {
      try { entry.sync(); } catch (error) { /* a control for a deleted item */ }
    });
  }

  /* Merge a solved list back into the one on screen, matching on id so the
   * objects survive.  Anything new, renamed away or without an id is taken as
   * it comes. */
  function adoptById(current, next) {
    var known = {};
    (current || []).forEach(function (item) {
      if (item && item.id) known[item.id] = item;
    });
    return (next || []).map(function (item) {
      var existing = item && item.id ? known[item.id] : null;
      if (!existing) return item;
      Object.keys(existing).forEach(function (key) {
        if (!(key in item)) delete existing[key];
      });
      Object.keys(item).forEach(function (key) { existing[key] = item[key]; });
      return existing;
    });
  }

  function refresh(force) {
    if (App.suspend) return;
    App.suspend = true;
    try {
      M.applyHrf(App.state);
      App.report = M.solve(App.state, App.boot);
      /* The solver repairs the design against the caps; adopt the repairs so
       * what the editors show is what actually runs.  Written into the objects
       * already in the state rather than over them, because an open editor
       * holds those objects: swapping them would leave the panel editing a
       * copy nothing else can see. */
      if (App.report.state) {
        ['trials', 'runs', 'sessions', 'experiments'].forEach(function (key) {
          App.state[key] = adoptById(App.state[key], App.report.state[key]);
        });
      }
      /* A view may rebuild an editor and so drop or add views mid-pass; walk a
       * snapshot and skip anything that has since been discarded. */
      var pending = App.views.slice();
      pending.forEach(function (view) {
        if (App.views.indexOf(view) < 0) return;
        try { view.render(App.report); } catch (error) {
          if (global.console) global.console.error(error);
        }
      });
      syncControls();
      if (force !== 'quiet') scheduleAutosave();
    } finally {
      App.suspend = false;
    }
  }

  /* Replace the working state wholesale (import, reset, an optimiser result). */
  function adopt(next) {
    var merged = M.migrateState(H.deepCopy(next));
    Object.keys(App.state).forEach(function (key) {
      if (!(key in merged)) delete App.state[key];
    });
    Object.keys(merged).forEach(function (key) { App.state[key] = merged[key]; });
    App.panels = {};
    App.controls = [];
    App.views = [];
    buildMetrics();
    show(App.activePanel);
  }

  function mergeState(saved) {
    return M.migrateState(H.deepCopy(saved));
  }

  function start() {
    var veil = document.getElementById('veil');
    fetch('/api/bootstrap').then(function (response) {
      return response.json();
    }).then(function (boot) {
      App.boot = boot;
      App.protocols = boot.protocols || {};
      App.state = boot.design ? mergeState(boot.design) : M.defaultState();
      M.applyHrf(App.state);
      buildMetrics();
      buildRail();

      document.getElementById('btn-save-design').addEventListener('click', function () {
        global.PlannerExport.saveDesign();
      });
      document.getElementById('btn-export-bundle').addEventListener('click', function () {
        global.PlannerExport.downloadBundle();
      });

      show('overview');
      if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    }).catch(function (error) {
      if (veil) {
        veil.textContent = 'Could not reach the planner API: ' + error.message;
        veil.classList.add('bad');
      }
    });
  }

  App.h = h;
  App.clear = clear;
  App.escapeHtml = escapeHtml;
  App.toast = toast;
  App.copy = copy;
  App.copyRichTable = copyRichTable;
  App.tableModel = tableModel;
  App.tableMarkdown = tableMarkdown;
  App.dataTable = dataTable;
  App.card = card;
  App.flushCard = flushCard;
  App.readoutCell = readoutCell;
  App.iconButton = iconButton;
  App.slider = slider;
  App.field = field;
  App.checkbox = checkbox;
  App.segmented = segmented;
  App.registerControl = registerControl;
  App.registerView = registerView;
  App.dropControls = dropControls;
  App.dropViews = dropViews;
  App.syncOwner = syncOwner;
  App.regressorPlot = regressorPlot;
  App.trialFigureMarkup = trialFigureMarkup;
  App.assemblyFigureMarkup = assemblyFigureMarkup;
  App.studyFigureMarkup = studyFigureMarkup;
  App.figureCard = figureCard;
  App.collectFigures = collectFigures;
  App.figurePng = figurePng;
  App.downloadFigureSvg = downloadFigureSvg;
  App.downloadFigurePng = downloadFigurePng;
  App.saveBlob = saveBlob;
  App.fileStem = fileStem;
  App.experimentColour = experimentColour;
  App.colourFor = colourFor;
  App.usableHours = usableHours;
  App.allocationRows = allocationRows;
  App.allocationBar = allocationBar;
  App.allocationUnitToggle = allocationUnitToggle;
  App.buildWarningsCard = buildWarningsCard;
  App.refresh = refresh;
  App.adopt = adopt;
  App.mergeState = mergeState;
  App.show = show;
  App.start = start;

  global.PlannerApp = App;
}(window));
