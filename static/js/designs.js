/* MRI Experimental Design Planner - starting and deleting designs.
 *
 * Every design is the same kind of thing: a name, and its own link,
 * /designs/<name>, where changes save to it as they are made.  A new one
 * starts from the default settings; any one can be deleted, after asking.
 * The list at / uses this, and so does the planner from inside a design. */

(function (global) {
  'use strict';

  function call(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error(response.status === 401
            ? 'Sign in with a login link to add or delete designs.'
            : response.status === 403 && payload.viewOnly
              ? 'View only: an admin can add or delete designs.'
              : payload.error || ('The server said ' + response.status));
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function pathOf(name) {
    return '/designs/' + encodeURIComponent(name);
  }

  /* A new design under this name: from the default settings, or from a
   * design object (an imported file).  Resolves to where it opens; a name
   * already taken is refused, not written over. */
  function create(name, design) {
    var wanted = String(name || '').trim();
    if (!wanted) return Promise.reject(new Error('Give the new design a name first.'));
    var body = design ? { name: wanted, design: design } : { name: wanted, from: 'default' };
    return call('POST', '/api/v1/designs', body).then(function (made) {
      return pathOf(made.name);
    });
  }

  /* Delete a design, once the person has said yes.  Resolves to whether it
   * was deleted. */
  function remove(name) {
    if (!global.confirm('Delete the design "' + name + '"?\n\nIts link stops working for '
      + 'everyone, and anyone who has it open is told it is gone. This cannot be undone.')) {
      return Promise.resolve(false);
    }
    return call('DELETE', '/api/v1/designs/' + encodeURIComponent(name)).then(function () {
      return true;
    });
  }

  /* ------------------------------------------------------------- the list */

  function home() {
    var root = document.getElementById('designs-home');
    if (!root) return;
    var form = document.getElementById('home-add');
    var box = document.getElementById('home-name');
    var problem = document.getElementById('home-problem');

    function say(message) {
      if (!problem) { if (message) global.alert(message); return; }
      problem.textContent = message || '';
      problem.hidden = !message;
    }

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var button = form.querySelector('button');
        button.disabled = true;
        say('');
        create(box.value).then(function (path) {
          global.location.href = path;
        }).catch(function (error) {
          say(error.message);
          button.disabled = false;
          box.focus();
        });
      });
    }

    root.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-delete]') : null;
      if (!button) return;
      remove(button.getAttribute('data-delete')).then(function (gone) {
        if (gone) global.location.reload();
      }).catch(function (error) { say(error.message); });
    });
  }

  global.PlannerDesigns = { create: create, remove: remove, pathOf: pathOf };
  home();
}(window));
