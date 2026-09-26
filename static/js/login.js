/* MRI Experimental Design Planner - the page a login link opens.
 *
 *   /login#<token>   spends the link and signs this browser in for good
 *
 * The token is the part of the link after the #, which a browser never sends
 * anywhere.  A chat app fetching the link to draw a preview asks for /login
 * and gets this page with nothing in it to spend, so the preview cannot use
 * the link up before the person it was sent to has opened it.
 *
 * Nobody is turned away: a link that has been used or has lapsed says so and
 * offers the planner as it is to everyone, view only. */

(function (global) {
  'use strict';

  var KEPT = 'planner.session.v1';     // the copy people.js reads if the cookie goes

  function keep(token) {
    try { global.localStorage.setItem(KEPT, token); } catch (error) { /* the cookie still works */ }
  }

  function kept() {
    try { return global.localStorage.getItem(KEPT) || ''; } catch (error) { return ''; }
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.ok ? response.json() : null;
    }).catch(function () { return null; });
  }

  /* The link's token, taken out of the address bar before anything else. */
  function takeLink() {
    var raw = global.location.hash.slice(1);
    if (raw) global.history.replaceState(null, '', global.location.pathname);
    return /^[A-Za-z0-9_-]{20,128}$/.test(raw) ? raw : '';
  }

  /* A page being got ready out of sight - a prerender, a preview drawn in a
   * hidden view - is not somebody opening the link.  It is spent only once it
   * is on screen. */
  function onScreen() {
    return new Promise(function (resolve) {
      if (document.visibilityState === 'visible') { resolve(); return; }
      function look() {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', look);
        resolve();
      }
      document.addEventListener('visibilitychange', look);
    });
  }

  function say(title, text) {
    var veil = document.getElementById('veil');
    while (veil.firstChild) veil.removeChild(veil.firstChild);
    var box = document.createElement('div');
    box.className = 'veil-box';
    var head = document.createElement('div');
    head.className = 'title';
    head.textContent = title;
    var body = document.createElement('div');
    body.textContent = text;
    var links = document.createElement('div');
    links.className = 'links';
    var open = document.createElement('a');
    open.href = '/';
    open.textContent = 'Open the planner (view only)';
    links.appendChild(open);
    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(links);
    veil.appendChild(box);
  }

  function main() {
    var link = takeLink();
    var spend = link
      ? onScreen().then(function () { return post('/api/auth/redeem', { token: link }); })
      : Promise.resolve(null);
    spend.then(function (got) {
      if (got && got.token) {
        keep(got.token);
        global.location.replace('/');
        return null;
      }
      /* Spent, or lapsed.  This browser may be signed in already, though -
       * the same link opened a second time - so that is asked next. */
      var token = kept();
      return post('/api/auth/resume', token ? { token: token } : {}).then(function (back) {
        if (back) { global.location.replace('/'); return; }
        say(link ? 'This login link has been used, or has lapsed' : 'No login link here',
          'A login link works once, in the first browser that opens it. Ask someone who is '
          + 'signed in to make you a new one. Anyone can still look at the planner; changing '
          + 'or exporting anything needs a sign-in.');
      });
    });
  }

  main();
}(window));
