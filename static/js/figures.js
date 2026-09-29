/* The figure index: copy a figure's address to the clipboard.
 *
 * The page renders without this file - every address is a plain link, and
 * right-click copies it.  This only saves the trip through the context menu.
 */

(function (global) {
  'use strict';

  var host = document.getElementById('figure-index');
  if (!host) return;

  function absolute(path) {
    return global.location.origin + path;
  }

  /* The clipboard API needs a secure context, which a LAN address is not, so
   * the textarea fallback is the path most of the time rather than an edge. */
  function copy(text, button) {
    function done() {
      var was = button.textContent;
      button.textContent = 'Copied';
      global.setTimeout(function () { button.textContent = was; }, 1200);
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('style', 'position:fixed;left:-9999px;top:0');
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (error) { /* nothing to do */ }
      document.body.removeChild(area);
    }
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(done, fallback);
      return;
    }
    fallback();
  }

  host.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    event.preventDefault();
    copy(absolute(button.getAttribute('data-copy')), button);
  });
}(window));
