/* MRI Experimental Design Planner - who can change things, the one-time
 * links that let them, and the API keys that let scripts and agents.
 *
 * Anyone can look at the planner.  Changing anything, or exporting it, needs
 * a session, and the only way to get one is a link made here and opened
 * once - or, for an agent, a key made here.  Everybody signed in can do all
 * of it - add someone, remove someone, make anyone a link, make or revoke a
 * key - so it is a panel for everyone rather than something behind a role
 * nobody has. */

(function (global) {
  'use strict';

  var App = global.PlannerApp;
  var KEPT = 'planner.session.v1';        // the copy login.js keeps of the session
  var RESUMED = 'planner.session.resumed';
  var STALE_MS = 10000;

  /* ------------------------------------------------------------ transport */

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error(payload.error || ('The server said ' + response.status));
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function kept() {
    try { return global.localStorage.getItem(KEPT) || ''; } catch (error) { return ''; }
  }

  function forget() {
    try { global.localStorage.removeItem(KEPT); } catch (error) { /* nothing kept */ }
  }

  /* Whether this tab handed a session back within the last minute.  If it
   * did and the page still came up signed out, the browser is not keeping
   * the cookie, and asking again would go round for ever. */
  function justResumed() {
    try { return Date.now() - Number(global.sessionStorage.getItem(RESUMED) || 0) < 60000; }
    catch (error) { return false; }
  }

  function noteResumed() {
    try { global.sessionStorage.setItem(RESUMED, String(Date.now())); } catch (error) { /* no storage */ }
  }

  /* The page came up signed out, but this browser kept a session: its cookie
   * went.  Hand it back and load again.  True when the page is reloading. */
  function resume() {
    var token = kept();
    if (!token) return Promise.resolve(false);
    if (justResumed()) {
      setTimeout(function () {
        App.toast('This browser is not keeping cookies for this site, so it cannot stay '
          + 'signed in. Allow cookies for it, then reload.', 'bad');
      }, 0);
      return Promise.resolve(false);
    }
    return api('POST', '/api/auth/resume', { token: token }).then(function () {
      noteResumed();
      global.location.reload();
      return true;
    }).catch(function (error) {
      if (error.status === 401) forget();      // removed, or signed out: it is dead
      return false;
    });
  }

  /* ------------------------------------------------------------- wording */

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function ago(iso) {
    var then = new Date(iso).getTime();
    if (!isFinite(then)) return '';
    var seconds = Math.round((Date.now() - then) / 1000);
    var future = seconds < 0;
    var s = Math.abs(seconds);
    var text = s < 60 ? 'moments'
      : s < 3600 ? plural(Math.round(s / 60), 'minute', 'minutes')
        : s < 86400 ? plural(Math.round(s / 3600), 'hour', 'hours')
          : plural(Math.round(s / 86400), 'day', 'days');
    return future ? 'in ' + text : text + ' ago';
  }

  function active(iso) {
    return Date.now() - new Date(iso).getTime() < 60000 ? 'active now' : 'active ' + ago(iso);
  }

  function used(iso) {
    if (!iso) return 'never used';
    return Date.now() - new Date(iso).getTime() < 60000 ? 'used just now' : 'used ' + ago(iso);
  }

  /* ---------------------------------------------------------------- panel */

  function build() {
    var h = App.h;
    var listHost = h('div', { class: 'people-list' }, [h('div', { class: 'muted', text: 'Loading…' })]);
    var keyHost = h('div', { class: 'people-list' });
    var linkHost = h('div');
    var keyShown = h('div');
    var loadedAt = 0;
    var mine = '';
    var keys = [];

    var nameBox = h('input', {
      type: 'text', placeholder: 'Their name', maxlength: 32, autocomplete: 'off',
      spellcheck: 'false', 'aria-label': 'Name of the person to add'
    });
    var addButton = h('button', { class: 'btn sm', type: 'button', text: 'Add and make a link' });

    var keyBox = h('input', {
      type: 'text', placeholder: 'name', maxlength: 32,
      autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Name of the API key to make'
    });
    var keyButton = h('button', { class: 'btn sm', type: 'button', text: 'Make a key' });

    function load() {
      loadedAt = Date.now();
      return api('GET', '/api/auth/users').then(function (got) {
        mine = got.me || '';
        keys = got.keys || [];
        App.clear(listHost);
        (got.users || []).forEach(function (person) { listHost.appendChild(row(person)); });
        App.clear(keyHost);
        keys.forEach(function (made) { keyHost.appendChild(keyRow(made)); });
        if (!keys.length) keyHost.appendChild(h('div', { class: 'muted', text: 'No API keys yet.' }));
      }).catch(function (error) {
        if (error.status === 401) { global.location.reload(); return; }
        App.clear(listHost);
        listHost.appendChild(h('div', { class: 'notice bad', text: error.message }));
      });
    }

    function keysMadeBy(person) {
      return keys.filter(function (made) { return made.user === person.id; }).length;
    }

    function keyRow(made) {
      var meta = [made.madeBy ? 'made by ' + made.madeBy : 'made', ago(made.createdAt), used(made.seenAt)];
      return h('div', { class: 'people-row' }, [
        h('div', { class: 'people-top' }, [
          h('div', { class: 'people-main' }, [
            h('div', { class: 'people-name' }, [h('span', { text: made.name })]),
            h('div', { class: 'people-meta', text: meta.join(' · ') })
          ]),
          h('div', { class: 'btn-row' }, [
            App.iconButton('Revoke', 'Stop this key working', function () { revokeKey(made); }, 'danger')
          ])
        ])
      ]);
    }

    function row(person) {
      var isMe = person.id === mine;
      var meta = [person.devices
        ? 'signed in on ' + plural(person.devices, 'browser', 'browsers')
        : 'not signed in yet'];
      if (person.seenAt) meta.push(active(person.seenAt));
      if (person.createdBy) meta.push('added by ' + person.createdBy);

      var pending = person.links.map(function (made) {
        return h('div', { class: 'people-pending' }, [
          h('span', {
            text: 'Unused link, made ' + ago(made.createdAt) + ' · stops working '
              + ago(made.expiresAt)
          }),
          App.iconButton('Cancel', 'Stop this link from working', function () {
            cancelLink(made);
          })
        ]);
      });

      return h('div', { class: 'people-row' }, [
        h('div', { class: 'people-top' }, [
          h('div', { class: 'people-main' }, [
            h('div', { class: 'people-name' }, [
              h('span', { text: person.name }),
              isMe ? h('span', { class: 'pill', text: 'you' }) : null
            ]),
            h('div', { class: 'people-meta', text: meta.join(' · ') })
          ]),
          h('div', { class: 'btn-row' }, [
            App.iconButton('Login link', 'A new one-time link that signs a browser in as '
              + person.name, function (event) { makeLink(person, event.target); }),
            /* You cannot take yourself out: somebody else has to, which is also
             * what stops the last person in locking everybody out by accident. */
            isMe ? null : App.iconButton('Remove', 'Take ' + person.name + ' out', function () {
              removePerson(person);
            }, 'danger')
          ])
        ])
      ].concat(pending));
    }

    function addPerson() {
      var wanted = nameBox.value.trim();
      if (!wanted) { nameBox.focus(); return; }
      addButton.disabled = true;
      api('POST', '/api/auth/users', { name: wanted }).then(function (got) {
        nameBox.value = '';
        /* Somebody is added to be let in, so the link comes straight up. */
        if (got.link) showLink(got.user.name, got.link);
        return load();
      }).catch(function (error) {
        App.toast(error.message, 'bad');
      }).then(function () { addButton.disabled = false; });
    }

    function makeLink(person, button) {
      if (button) button.disabled = true;
      api('POST', '/api/auth/users/' + encodeURIComponent(person.id) + '/link').then(function (made) {
        showLink(person.name, made);
        return load();
      }).catch(function (error) {
        App.toast(error.message, 'bad');
      }).then(function () { if (button) button.disabled = false; });
    }

    function removePerson(person) {
      var where = !person.devices ? ''
        : person.devices === 1 ? person.name + ' is signed out of the browser they use, straight away. '
          : person.name + ' is signed out of all ' + person.devices + ' browsers they use, straight away. ';
      var made = keysMadeBy(person);
      var theirKeys = !made ? ''
        : made === 1 ? 'The API key they made stops working too. '
          : 'The ' + made + ' API keys they made stop working too. ';
      if (!global.confirm('Remove ' + person.name + '?\n\n' + where + 'Any link made for them '
        + 'stops working. ' + theirKeys + 'They can still look at the planner, like anyone. '
        + 'Nothing in the designs changes.')) return;
      api('DELETE', '/api/auth/users/' + encodeURIComponent(person.id)).then(function () {
        App.toast(person.name + ' removed', 'ok');
      }).catch(function (error) {
        App.toast(error.message, 'bad');
      }).then(load);
    }

    function cancelLink(made) {
      api('DELETE', '/api/auth/links/' + encodeURIComponent(made.id)).then(function () {
        App.toast('Link cancelled; it will not work now', 'ok');
      }).catch(function (error) {
        App.toast(error.message, 'bad');
      }).then(load);
    }

    function makeKey() {
      var wanted = keyBox.value.trim();
      if (!wanted) { keyBox.focus(); return; }
      keyButton.disabled = true;
      api('POST', '/api/auth/keys', { name: wanted }).then(function (got) {
        keyBox.value = '';
        showKey(got.key);
        return load();
      }).catch(function (error) {
        App.toast(error.message, 'bad');
      }).then(function () { keyButton.disabled = false; });
    }

    function revokeKey(made) {
      if (!global.confirm('Revoke the API key ' + made.name + '?\n\nWhatever uses it is refused '
        + 'from its next call. Nothing it has already changed is undone.')) return;
      api('DELETE', '/api/auth/keys/' + encodeURIComponent(made.id)).then(function () {
        App.toast('API key ' + made.name + ' revoked', 'ok');
      }).catch(function (error) {
        App.toast(error.message, 'bad');
      }).then(load);
    }

    /* A link or a key, once.  Only its hash is kept on the server, so
     * dismissing this is the last anyone sees of it - another is a click away. */
    function showSecret(host, title, value, doneTip, hints) {
      var box = h('input', {
        type: 'text', readonly: true, class: 'people-link', 'aria-label': title
      });
      box.value = value;
      box.addEventListener('focus', function () { box.select(); });
      App.clear(host);
      host.appendChild(App.card(title, 'Shown once', [
        h('div', { class: 'split-inline people-link-row' }, [
          box,
          h('button', {
            class: 'btn sm', type: 'button', text: 'Copy',
            onclick: function () { App.copy(value, title); }
          }),
          App.iconButton('Done', doneTip, function () { App.clear(host); })
        ])
      ].concat(hints.map(function (hint) {
        return h('p', { class: 'people-hint', text: hint });
      }))));
      box.focus();
    }

    function showLink(name, made) {
      showSecret(linkHost, 'Login link for ' + name, made.url,
        'Put the link away; it keeps working until it is used', [
          'It works once: whoever opens it first is signed in as ' + name + ' on that '
            + 'browser, for good. Unopened, it stops working ' + ago(made.expiresAt) + '.',
          'Do not open it yourself: it would sign this browser in as ' + name + '.'
        ]);
    }

    function showKey(made) {
      showSecret(keyShown, 'API key for ' + made.name, made.token,
        'Put the key away; it keeps working until it is revoked', [
          'Send it with every call to the API, as the header Authorization: Bearer <key>. '
            + 'API.md, or /api/v1/docs on this server, has the rest.',
          'It can change and export anything, like someone signed in, but cannot add or remove '
            + 'people or make links or keys. It works until it is revoked here, or until '
            + App.me.name + ' is removed.',
          'This is the only time it is shown: only a hash of it is kept. If it is lost, make '
            + 'another and revoke this one.'
        ]);
    }

    function signOut() {
      if (!global.confirm('Sign out of this browser?\n\nThe planner stays open to look at. '
        + 'Changing anything again takes a new login link from somebody who is signed in.')) return;
      /* Whatever is still on its way to the server goes first: after this
       * there is no session to send it with. */
      var flushed = App.busySaving() ? App.saveWorking() : Promise.resolve();
      flushed.then(function () {
        return api('POST', '/api/auth/logout');
      }).then(function () {
        forget();
        global.location.reload();
      }).catch(function (error) {
        App.toast(error.message, 'bad');
      });
    }

    addButton.addEventListener('click', addPerson);
    nameBox.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addPerson(); }
    });
    keyButton.addEventListener('click', makeKey);
    keyBox.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); makeKey(); }
    });

    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'People' }),
      h('p', {
        text: 'Everyone listed here can change the designs and the acquisition cards and take '
          + 'exports, and can add and remove people. So can a script or an agent given an API '
          + 'key, except for managing people and keys. Anyone else who opens the planner can '
          + 'only look.'
      })
    ]));
    panel.appendChild(App.card('People', 'Everyone who can sign in', [listHost]));
    panel.appendChild(App.card('Add someone', 'They get a one-time login link', [
      h('div', { class: 'split-inline people-add' }, [nameBox, addButton])
    ]));
    panel.appendChild(linkHost);
    panel.appendChild(App.card('API keys', 'For scripts and agents', [
      keyHost,
      h('div', { class: 'split-inline people-add people-key-add' }, [keyBox, keyButton])
    ]));
    panel.appendChild(keyShown);
    panel.appendChild(App.card('This browser', null, [
      h('div', { class: 'split-inline people-self' }, [
        h('span', { text: 'Signed in as ' + App.me.name + '.' }),
        App.iconButton('Sign out of this browser', 'Back to view only here', signOut, 'danger')
      ])
    ]));

    /* Load when first shown, and again on coming back to it. */
    App.registerView(function () {
      if (App.activePanel === 'people' && Date.now() - loadedAt > STALE_MS) load();
    }, panel);
    return panel;
  }

  global.PlannerPeople = { build: build, resume: resume };
}(window));
