/* Report generation, clipboard handoff and the export bundle. */

(function (global) {
  'use strict';

  var App, M, H;
  var methodsBox, markdownBox, markdownPicker, presetHost, presetName;
  var psychopyButtons, psychopyPicker, psychopyBox, bundleStatus;

  function download(blob, filename) {
    App.saveBlob(blob, filename);
  }

  function stamp() { return new Date().toISOString().slice(0, 10); }

  function downloadXlsx() {
    App.toast('Building workbook...');
    fetch('/api/export/xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: App.report, protocols: App.protocols })
    }).then(function (response) {
      if (!response.ok) {
        return response.json().then(function (body) {
          throw new Error(body.error || 'export failed');
        });
      }
      var name = response.headers.get('X-Planner-Archive') || 'mri-design.xlsx';
      return response.blob().then(function (blob) { download(blob, name); return name; });
    }).then(function (name) {
      App.toast('Workbook exported: ' + name, 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function downloadJson() {
    var blob = new Blob([JSON.stringify({
      design: App.state, report: App.report
    }, null, 2)], { type: 'application/json' });
    download(blob, 'mri-design-' + stamp() + '.json');
    App.toast('Design JSON downloaded', 'ok');
  }

  function downloadMarkdown() {
    var blob = new Blob([M.allMarkdown(App.report)], { type: 'text/markdown' });
    download(blob, 'mri-design-' + stamp() + '.md');
    App.toast('Markdown downloaded', 'ok');
  }

  /* --------------------------------------------------------------- bundle */

  /* Everything, in one zip.  The figures only exist in the browser, so they
   * are rasterised here and posted alongside the design; the server adds the
   * workbook and the acquisition cards and packs the archive. */
  function collectPsychopy() {
    if (!App.report) return [];
    return App.report.runs.filter(function (run) { return !run.missing; })
      .map(function (run) {
        return { name: M.psychopyFileName(run), text: M.psychopyYaml(App.report, run) };
      });
  }

  function collectMarkdownTables() {
    if (!App.report) return [];
    return Object.keys(App.report.markdownTables).map(function (key) {
      return { name: key, text: App.report.markdownTables[key] };
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new Error('could not read PNG')); };
      reader.readAsDataURL(blob);
    });
  }

  /* SVG always; PNG too, when the browser will rasterise it. */
  function collectFigurePayload() {
    var figures = App.collectFigures();
    return Promise.all(figures.map(function (figure) {
      return App.figurePng(figure.svg, 2)
        .then(function (result) { return blobToDataUrl(result.blob); })
        .then(function (dataUrl) {
          return { name: figure.name, svg: figure.svg, png: dataUrl };
        })
        .catch(function () { return { name: figure.name, svg: figure.svg }; });
    }));
  }

  function setBundleStatus(text, kind) {
    if (!bundleStatus) return;
    bundleStatus.textContent = text || '';
    bundleStatus.className = 'notice' + (kind ? ' ' + kind : '');
  }

  function downloadBundle() {
    if (!App.report) { App.toast('Nothing solved yet.', 'bad'); return; }
    App.toast('Rendering figures for the bundle...');
    setBundleStatus('Rendering figures…');

    collectFigurePayload().then(function (figures) {
      setBundleStatus('Building the archive on the server…');
      return fetch('/api/export/bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report: App.report,
          design: App.state,
          protocols: App.protocols,
          markdown: M.allMarkdown(App.report),
          methods: App.report.methodsText,
          markdownTables: collectMarkdownTables(),
          psychopy: collectPsychopy(),
          figures: figures
        })
      });
    }).then(function (response) {
      if (!response.ok) {
        return response.json().then(function (body) {
          throw new Error(body.error || 'bundle failed');
        });
      }
      var name = response.headers.get('X-Planner-Archive') || 'mri-design.zip';
      var count = response.headers.get('X-Planner-Files') || '?';
      return response.blob().then(function (blob) {
        download(blob, name);
        return { name: name, count: count, size: blob.size };
      });
    }).then(function (result) {
      setBundleStatus('Downloaded ' + result.name + ' - ' + result.count + ' files, '
        + (result.size / 1024 / 1024).toFixed(1) + ' MB. A copy is archived in exports/.', 'ok');
      App.toast('Full export downloaded: ' + result.name, 'ok');
    }).catch(function (error) {
      setBundleStatus('Export failed: ' + error.message, 'bad');
      App.toast(error.message, 'bad');
    });
  }

  /* ------------------------------------------------------------- psychopy */

  function downloadPsychopy(runReport) {
    var name = M.psychopyFileName(runReport);
    var blob = new Blob([M.psychopyYaml(App.report, runReport)],
      { type: 'text/yaml;charset=utf-8' });
    download(blob, name);
    App.toast('PsychoPy config downloaded: ' + name, 'ok');
  }

  function refreshPsychopy() {
    if (!App.report || !psychopyButtons) return;
    var runs = App.report.runs.filter(function (run) { return !run.missing; });

    App.clear(psychopyButtons);
    if (!runs.length) {
      psychopyButtons.appendChild(App.h('span', {
        class: 'muted', text: 'No run designs, so there is nothing to export.'
      }));
    }
    runs.forEach(function (run) {
      psychopyButtons.appendChild(App.h('button', {
        class: 'btn sm', type: 'button', text: run.name,
        title: 'Download ' + M.psychopyFileName(run) + ' for ' + run.name,
        onclick: function () { downloadPsychopy(run); }
      }));
    });

    var previous = psychopyPicker.value;
    App.clear(psychopyPicker);
    runs.forEach(function (run) {
      psychopyPicker.appendChild(App.h('option', { value: run.id, text: run.name }));
    });
    if (previous && runs.some(function (run) { return run.id === previous; })) {
      psychopyPicker.value = previous;
    }
    renderPsychopyPreview();
  }

  function currentPsychopyRun() {
    var runs = (App.report && App.report.runs.filter(function (run) {
      return !run.missing;
    })) || [];
    return runs.filter(function (run) {
      return run.id === psychopyPicker.value;
    })[0] || runs[0] || null;
  }

  function renderPsychopyPreview() {
    if (!psychopyBox) return;
    var run = currentPsychopyRun();
    psychopyBox.textContent = run ? M.psychopyYaml(App.report, run) : '';
  }

  /* -------------------------------------------------------------- designs */

  /* How the design open in this page is named in a question. */
  function openHere() {
    return '"' + App.designName + '"';
  }

  /* Save the design open here, or a copy of it under another name.  False
   * when the user declined to write over an existing design. */
  function saveDesign(name) {
    var target = App.cleanName(name || App.designName);
    var ownDesign = target === App.designName;
    /* Designs are shared by link, so writing over one somebody may have open
     * is worth a question. */
    var taken = (App.boot.presets || []).some(function (preset) { return preset.name === target; });
    if (!ownDesign && taken && !global.confirm('Replace the design "' + target + '" with a copy of '
      + openHere() + '? Every page open on its link will show the change.')) return false;
    /* The design open here goes through the page's own save, which knows the
     * revision it started from; any other name is a plain copy. */
    var request = ownDesign ? App.saveWorking()
      : fetch('/api/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: target, design: App.state })
      }).then(function (response) { return response.json(); });
    request
      .then(function (result) {
        /* A refused save of the design open here has already said why, and
         * the page is now showing the version that won. */
        if (result.error) {
          if (!result.design) App.toast(result.error, 'bad');
          return;
        }
        App.boot.presets = result.presets || App.boot.presets;
        renderPresets();
        App.toast(ownDesign ? 'Design saved' : 'Saved a copy as "' + target + '"', 'ok');
      }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function fileStem(name) {
    return 'mri-design-' + String(name || 'design')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* Pull a design straight from the server and write it to disk, so any
   * design can leave this machine without being opened first. */
  function downloadPreset(name) {
    fetch('/api/design?name=' + encodeURIComponent(name))
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result.error) throw new Error(result.error);
        var blob = new Blob([JSON.stringify(result.design, null, 2)],
          { type: 'application/json' });
        download(blob, fileStem(name) + '.json');
        App.toast('Downloaded "' + name + '" as JSON', 'ok');
      }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  /* A design file becomes a new design of its own, named in the box or after
   * the file, and opens.  It never replaces the design open here: that one is
   * shared by its link.  The file may be a bare design or a downloaded
   * {design, report} envelope; anything it is missing comes from the
   * defaults, so an older or hand-edited file still loads. */
  function importDesign(file, name) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (error) {
        App.toast('Import failed: ' + error.message, 'bad');
        return;
      }
      var target = (name || '').trim() || String(file.name || '').replace(/\.json$/i, '');
      global.PlannerDesigns.create(target, parsed).then(function (path) {
        global.location.href = path;
      }).catch(function (error) { App.toast('Import failed: ' + error.message, 'bad'); });
    };
    reader.onerror = function () { App.toast('Could not read ' + file.name, 'bad'); };
    reader.readAsText(file);
  }

  /* Any design can go, the one open here too, once the person says so.  This
   * one gone, the page has nothing left to work on: back to the list. */
  function deleteDesign(name) {
    global.PlannerDesigns.remove(name).then(function (deleted) {
      if (!deleted) return;
      if (name === App.designName) {
        App.designGone({ home: true });
        return;
      }
      App.toast('Deleted "' + name + '"');
      refreshPresets();
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function renderPresets() {
    if (!presetHost) return;
    App.clear(presetHost);
    var presets = App.boot.presets || [];
    if (!presets.length) {
      presetHost.appendChild(App.h('div', { class: 'notice', text: 'No designs yet.' }));
      return;
    }

    /* Each name is the design's own link: following it opens that design,
     * and the page then works on it. */
    var table = App.dataTable(
      [{ label: 'Name' }, { label: 'Study title' }, { label: 'Saved', num: true },
        { label: 'Actions' }],
      presets.map(function (preset) {
        var here = preset.name === App.designName;
        return [
          {
            html: '<a href="' + App.designPath(preset.name) + '">'
              + App.escapeHtml(preset.name)
              + '</a>' + (here ? ' <span class="muted">open here</span>' : ''),
            copy: preset.name
          },
          { text: preset.title, className: 'seq' },
          { text: new Date(preset.modified * 1000).toLocaleString(), num: true },
          { text: '', copy: '' }
        ];
      }),
      { caption: 'Designs' }
    );
    presetHost.appendChild(table);

    var rows = presetHost.querySelectorAll('tbody tr');
    presets.forEach(function (preset, index) {
      var row = rows[index];
      if (!row) return;
      var cell = row.children[3];
      var here = preset.name === App.designName;
      App.clear(cell);
      var actions = App.h('div', { class: 'btn-row' }, [
        App.view(App.iconButton('Copy link', 'Copy a link that opens this design; changes '
          + 'made there save to it', function () {
          App.copy(App.designLink(preset.name), 'Link for "' + preset.name + '"');
        }))
      ]);
      actions.appendChild(App.iconButton('Download', 'Write this design out as a JSON file',
        function () { downloadPreset(preset.name); }));
      actions.appendChild(App.iconButton('Delete', here
        ? 'Delete this design, the one open here; its link stops working'
        : 'Delete this design; its link stops working', function () {
        deleteDesign(preset.name);
      }, 'danger'));
      cell.appendChild(actions);
    });
  }

  /* Another page or the API may have made or deleted designs since this page
   * loaded; take the list fresh whenever the card is built. */
  function refreshPresets() {
    fetch('/api/v1/designs').then(function (response) { return response.json(); })
      .then(function (result) {
        if (!Array.isArray(result.designs)) return;
        App.boot.presets = result.designs;
        renderPresets();
      }).catch(function () { /* keep the list from boot */ });
  }

  /* ------------------------------------------------------------- markdown */

  function refreshMarkdown() {
    if (!App.report || !markdownPicker) return;
    var choice = markdownPicker.value;
    markdownBox.textContent = choice === '__all__'
      ? M.allMarkdown(App.report)
      : (App.report.markdownTables[choice] || '');
  }

  function rebuildPicker() {
    if (!markdownPicker || !App.report) return;
    var previous = markdownPicker.value;
    App.clear(markdownPicker);
    markdownPicker.appendChild(App.h('option', {
      value: '__all__', text: 'All tables (full report)'
    }));
    Object.keys(App.report.markdownTables).forEach(function (key) {
      markdownPicker.appendChild(App.h('option', { value: key, text: key }));
    });
    if (previous && Array.prototype.some.call(markdownPicker.options, function (option) {
      return option.value === previous;
    })) markdownPicker.value = previous;
  }

  /* Whatever table is showing, as a Word table. */
  function copyShownForWord() {
    var choice = markdownPicker.value;
    if (choice === '__all__') {
      App.toast('Pick a single table to paste into Word.', 'bad');
      return;
    }
    var text = App.report.markdownTables[choice] || '';
    var lines = text.split('\n').filter(function (line) { return line.trim().charAt(0) === '|'; });
    if (lines.length < 2) { App.toast('Nothing to copy.', 'bad'); return; }
    function cells(line) {
      return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
        .split('|').map(function (cell) { return cell.trim(); });
    }
    var columns = cells(lines[0]);
    var alignment = cells(lines[1]);
    App.copyRichTable({
      caption: choice,
      columns: columns,
      numeric: alignment.map(function (rule) { return /-:$/.test(rule); }),
      rows: lines.slice(2).map(cells)
    }, choice);
  }

  /* ---------------------------------------------------------------- build */

  function figuresPath() {
    return '/designs/' + encodeURIComponent(App.designName) + '/figures/';
  }

  function build() {
    App = global.PlannerApp;
    M = global.PlannerModel;
    H = M.helpers;

    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'Report and export' }),
      App.h('p', {
        text: 'The generated methods narrative, every table as Markdown or as a Word table, '
          + 'a PsychoPy config per run design, the XLSX workbook, and one zip with all of it.'
      })
    ]));

    /* --- the everything button ----------------------------------------- */
    bundleStatus = App.h('div', { class: 'notice' });
    var bundleManifest = App.h('ul', { class: 'plain-list' });
    [
      'The XLSX workbook, one sheet per report section',
      'design.json and report.json - the design reloads from either',
      'report.md, and every table on its own as Markdown',
      'methods.txt, the paste-ready narrative',
      'One PsychoPy experiment YAML per run design',
      'Every figure as SVG and as PNG',
      'Every acquisition card as saved',
      'A README listing what each file is'
    ].forEach(function (line) {
      bundleManifest.appendChild(App.h('li', { text: line }));
    });

    var bundleCard = App.card('Download everything', 'One zip with the whole design', [
      App.h('div', { class: 'btn-row' }, [
        App.h('button', {
          class: 'btn gold', type: 'button', text: 'Download everything (.zip)',
          onclick: downloadBundle
        }),
        App.iconButton('XLSX only', 'Just the workbook', downloadXlsx),
        App.iconButton('Design JSON', 'The state plus the solved report', downloadJson),
        App.iconButton('Markdown only', 'The whole report as one .md file', downloadMarkdown)
      ]),
      bundleManifest,
      bundleStatus
    ]);
    setBundleStatus('Figures are rendered in the browser and packed on the server. '
      + 'A copy of every archive is kept in exports/.');

    /* --- figures at their own addresses ---------------------------------- */

    /* The zip is a snapshot; these are links.  Worth keeping apart, because
     * the useful thing about a link is exactly that it is not a snapshot. */
    var figureIndex = App.h('a', {
      class: 'btn gold', href: figuresPath(), text: 'Open the figure index',
      target: '_blank', rel: 'noopener'
    });
    /* Walk every figure, draw it the way Download PNG draws it, and hand each
     * one to the server, so every link serves the real picture rather than the
     * server's approximation of it. */
    var publishStatus = App.h('div', { class: 'notice' });
    function publishAllFigures(button) {
      var figures = App.collectFigures();
      if (!figures.length) {
        publishStatus.textContent = 'Nothing to publish yet.';
        return;
      }
      button.disabled = true;
      var done = 0;
      var failed = 0;
      publishStatus.textContent = 'Publishing 0 of ' + figures.length + '…';
      figures.reduce(function (chain, figure) {
        return chain.then(function () {
          return App.publishFigure(figure.name, figure.svg).then(function (stored) {
            done += 1;
            if (!stored) failed += 1;
            publishStatus.textContent = 'Publishing ' + done + ' of ' + figures.length + '…';
          });
        });
      }, Promise.resolve()).then(function () {
        button.disabled = false;
        if (failed === figures.length) {
          publishStatus.textContent = 'Nothing was published. Sign in with a login link '
            + 'first; until then the links serve the server\'s own rendering.';
          return;
        }
        publishStatus.textContent = (figures.length - failed) + ' of ' + figures.length
          + ' figures published. Their links now serve exactly what you see here'
          + (failed ? ', and ' + failed + ' could not be stored.' : '.');
      });
    }

    var figuresCard = App.card('Figures on the web', 'One address each, always current', [
      App.h('p', { class: 'hint-block', text: 'Every figure the planner draws also lives at '
        + 'its own address under this design, drawn from the design each time it is opened. '
        + 'Paste one into a protocol, a slide or a message and it keeps up with the design '
        + 'instead of going stale the way a pasted picture does. Each figure card has a '
        + 'Copy link button; the index below lists them all.' }),
      App.h('div', { class: 'btn-row' }, [
        figureIndex,
        App.h('button', {
          class: 'btn', type: 'button', text: 'Publish every figure',
          title: 'Draw each figure the way Download PNG draws it and hand it to the server',
          onclick: function () { publishAllFigures(this); }
        }),
        App.iconButton('Copy the index link', 'The address of this page of figures',
          function () { App.copy(global.location.origin + figuresPath(), 'Figure index link'); })
      ]),
      publishStatus,
      App.h('p', { class: 'muted', text: 'A figure can be named by its file name, which is '
        + 'readable but moves if you rename the item, or by the item\'s id, which never '
        + 'changes. Both work; the index shows each. A figure nobody has published is '
        + 'rendered by the server instead, which is close but uses the fonts the server '
        + 'has rather than the ones these figures ask for.' })
    ]);
    App.registerView(function () { figureIndex.href = figuresPath(); }, 'export');

    /* --- methods -------------------------------------------------------- */
    methodsBox = App.h('textarea', { class: 'prose-box', spellcheck: 'false' });
    var methodsCard = App.card('Methods text', 'Regenerated from the solved design', [
      methodsBox,
      App.h('div', { class: 'btn-row mt' }, [
        App.h('button', {
          class: 'btn', type: 'button', text: 'Copy methods text',
          onclick: function () { App.copy(methodsBox.value, 'Methods text'); }
        }),
        App.iconButton('Regenerate', 'Discard edits and rebuild from the design', function () {
          methodsBox.value = App.report.methodsText;
          App.toast('Methods text regenerated');
        }),
        App.h('span', {
          class: 'muted',
          text: 'Edits here are for copying only and are not saved with the design.'
        })
      ])
    ]);

    /* --- markdown ------------------------------------------------------- */
    markdownPicker = App.view(App.h('select', {}));
    markdownPicker.addEventListener('change', refreshMarkdown);
    markdownBox = App.h('pre', { class: 'code-box' });
    var markdownCard = App.card('Tables', 'Markdown, or straight into Word', [
      App.h('div', { class: 'split-inline mb' }, [
        markdownPicker,
        App.h('button', {
          class: 'btn', type: 'button', text: 'Copy Markdown',
          onclick: function () { App.copy(markdownBox.textContent, 'Markdown table'); }
        }),
        App.iconButton('Copy for Word',
          'Puts the shown table on the clipboard as rich text', copyShownForWord),
        App.iconButton('Copy every table', 'The whole report as Markdown', function () {
          App.copy(M.allMarkdown(App.report), 'Full Markdown report');
        }),
        App.iconButton('Download .md', 'Write the report out as a file', downloadMarkdown)
      ]),
      markdownBox
    ]);

    /* --- psychopy ------------------------------------------------------- */
    psychopyButtons = App.h('div', { class: 'btn-row' });
    psychopyPicker = App.view(App.h('select', {}));
    psychopyPicker.addEventListener('change', renderPsychopyPreview);
    psychopyBox = App.h('pre', { class: 'code-box', style: 'max-height:360px' });

    var psychopyCard = App.card('PsychoPy task config', 'One experiment YAML per run design', [
      App.h('div', {
        class: 'notice',
        text: 'Each file is the PsychoPy builder\'s lab template with the scanner block (TR, '
          + 'dummy volumes), run: (lead-in and lead-out, blocks per run, trials per block, '
          + 'inter-block rest, inter-trial gap), trial: (the phase list, durations and jitter, '
          + 'in the builder\'s own jitter and jitter_p keys, with each geometric window '
          + 'stopping on its top rung at this run\'s TR, so the builder reproduces exactly '
          + 'the timing the planner sized against) and the per_run counts of conditions: '
          + '(primary trials, and the control share spread over the control conditions) '
          + 'filled in. The conditions themselves, what each trial presents and in what '
          + 'order stay the lab\'s. Window, text, console, keys and instructions are passed '
          + 'through unchanged.'
      }),
      psychopyButtons,
      App.h('div', { class: 'split-inline mt mb' }, [
        psychopyPicker,
        App.iconButton('Copy YAML', 'Copy the shown config', function () {
          App.copy(psychopyBox.textContent, 'PsychoPy config');
        }),
        App.iconButton('Download shown', 'Write the shown config out', function () {
          var run = currentPsychopyRun();
          if (run) downloadPsychopy(run);
        })
      ]),
      psychopyBox
    ]);

    /* --- designs -------------------------------------------------------- */
    presetName = App.h('input', { type: 'text', placeholder: 'name for a copy or an import' });
    presetHost = App.h('div', { class: 'mt' });

    /* The file input stays out of the layout; the visible button drives it. */
    var importPicker = App.h('input', {
      type: 'file', accept: '.json,application/json', style: 'display:none'
    });
    importPicker.addEventListener('change', function () {
      var file = importPicker.files && importPicker.files[0];
      if (file) importDesign(file, presetName.value);
      importPicker.value = '';
    });

    var presetCard = App.card('Designs',
      'Stored server-side in presets/. Each opens at its own link; changes made there save to it', [
      App.h('div', { class: 'split-inline' }, [
        presetName,
        App.h('button', {
          class: 'btn sm', type: 'button', text: 'Save a copy as',
          onclick: function () {
            if (!presetName.value.trim()) {
              App.toast('Give the copy a name first', 'bad');
              return;
            }
            saveDesign(presetName.value.trim());
          }
        }),
        App.iconButton('Reset to defaults', 'Start this design again from the default settings',
          function () {
            if (!global.confirm('Replace ' + openHere() + ' with the default settings? Every '
              + 'page open on its link will show the change.')) return;
            if (App.act('design.reset')) App.toast('Design reset to the default settings');
          })
      ]),
      App.h('div', { class: 'btn-row mt' }, [
        App.iconButton('Import JSON file',
          'Make a new design from a design file, named above or after the file, and open it',
          function () { importPicker.click(); }),
        App.iconButton('Download this design', 'Write the design as it stands to a file',
          function () {
            var blob = new Blob([JSON.stringify(App.state, null, 2)],
              { type: 'application/json' });
            download(blob, fileStem(App.designName) + '.json');
            App.toast('Design downloaded', 'ok');
          }),
        importPicker,
        App.h('span', {
          class: 'muted',
          text: 'Import makes a new design; anything the file omits comes from the default '
            + 'settings. Designs from the earlier aim-based planner are converted on load.'
        })
      ]),
      presetHost
    ]);

    panel.appendChild(bundleCard);
    panel.appendChild(figuresCard);
    panel.appendChild(App.h('div', { class: 'grid split' }, [
      App.h('div', {}, [methodsCard, psychopyCard]),
      App.h('div', {}, [markdownCard, presetCard])
    ]));

    App.registerView(function (report) {
      if (document.activeElement !== methodsBox) methodsBox.value = report.methodsText;
      rebuildPicker();
      refreshMarkdown();
      refreshPsychopy();
    });

    renderPresets();
    refreshPresets();
    return panel;
  }

  global.PlannerExport = {
    build: build,
    downloadXlsx: downloadXlsx,
    downloadJson: downloadJson,
    downloadBundle: downloadBundle,
    saveDesign: function () { saveDesign(App.designName); },
    downloadPreset: downloadPreset,
    downloadPsychopy: downloadPsychopy,
    importDesign: importDesign
  };
}(window));
