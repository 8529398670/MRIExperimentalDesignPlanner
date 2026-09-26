/* MRI Experimental Design Planner - who can change things, and the one-time
 * links that let them.
 *
 * Anyone can look at the planner.  Changing anything, or exporting it, needs
 * a session, and the only way to get one is a link made here and opened
 * once.  Everybody signed in can do all of it - add someone, remove someone,
 * make anyone a link - so it is a panel for everyone rather than something
 * behind a role nobody has. */

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

  /* ---------------------------------------------------------------- panel */

  function build() {
    var h = App.h;
    var listHost = h('div', { class: 'people-list' }, [h('div', { class: 'muted', text: 'Loading…' })]);
    var linkHost = h('div');
    var loadedAt = 0;
    var mine = '';

    var nameBox = h('input', {
      type: 'text', placeholder: 'Their name', maxlength: 32, autocomplete: 'off',
      spellcheck: 'false', 'aria-label': 'Name of the person to add'
    });
    var addButton = h('button', { class: 'btn sm', type: 'button', text: 'Add and make a link' });

    function load() {
      loadedAt = Date.now();
      return api('GET', '/api/auth/users').then(function (got) {
        mine = got.me || '';
        App.clear(listHost);
        (got.users || []).forEach(function (person) { listHost.appendChild(row(person)); });
      }).catch(function (error) {
        if (error.status === 401) { global.location.reload(); return; }
        App.clear(listHost);
        listHost.appendChild(h('div', { class: 'notice bad', text: error.message }));
      });
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
      if (!global.confirm('Remove ' + person.name + '?\n\n' + where + 'Any link made for them '
        + 'stops working. They can still look at the planner, like anyone. Nothing in the designs '
        + 'changes.')) return;
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

    /* The link, once.  Only its hash is kept on the server, so dismissing this
     * is the last anyone sees of it - another is a click away. */
    function showLink(name, made) {
      var box = h('input', {
        type: 'text', readonly: true, class: 'people-link', 'aria-label': 'Login link for ' + name
      });
      box.value = made.url;
      box.addEventListener('focus', function () { box.select(); });
      App.clear(linkHost);
      linkHost.appendChild(App.card('Login link for ' + name, 'Shown once', [
        h('div', { class: 'split-inline people-link-row' }, [
          box,
          h('button', {
            class: 'btn sm', type: 'button', text: 'Copy',
            onclick: function () { App.copy(made.url, 'Login link for ' + name); }
          }),
          App.iconButton('Done', 'Put the link away; it keeps working until it is used',
            function () { App.clear(linkHost); })
        ]),
        h('p', {
          class: 'people-hint',
          text: 'It works once: whoever opens it first is signed in as ' + name + ' on that '
            + 'browser, for good. Unopened, it stops working ' + ago(made.expiresAt) + '.'
        }),
        h('p', {
          class: 'people-hint',
          text: 'Do not open it yourself: it would sign this browser in as ' + name + '.'
        })
      ]));
      box.focus();
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

    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'People' }),
      h('p', {
        text: 'Everyone listed here can change the designs and the acquisition cards and take '
          + 'exports, and can add and remove people. Anyone else who opens the planner can only '
          + 'look.'
      })
    ]));
    panel.appendChild(App.card('People', 'Everyone who can sign in', [listHost]));
    panel.appendChild(App.card('Add someone', 'They get a one-time login link', [
      h('div', { class: 'split-inline people-add' }, [nameBox, addButton])
    ]));
    panel.appendChild(linkHost);
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
