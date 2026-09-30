// A DOM small enough to run the vendored PsychoPy stage (static/player/stage.js)
// under QuickJS, and no larger.  Everything here exists because stage.js
// touches it; nothing here pretends to be a browser.
//
// Time and animation frames are driven from the outside, by the harness, so a
// run plays deterministically and as fast as the loop can turn.

var __now = 0;                            // milliseconds, set by the harness
var __frame = null;                       // the one pending rAF callback
var __timers = [];                        // {id, due, fn}
var __nextTimer = 1;

function performanceNow() { return __now; }
var performance = { now: performanceNow };

function requestAnimationFrame(fn) { __frame = fn; return 1; }
function cancelAnimationFrame() { __frame = null; }

function setTimeout(fn, ms) {
  var id = __nextTimer++;
  __timers.push({ id: id, due: __now + (ms || 0), fn: fn });
  return id;
}
function clearTimeout(id) {
  __timers = __timers.filter(function (t) { return t.id !== id; });
}
var setInterval = setTimeout;
var clearInterval = clearTimeout;

/* --------------------------------------------------------------- nodes --- */

function Style() { this.cssText = ''; this._props = {}; }
Style.prototype.setProperty = function (k, v) { this._props[k] = String(v); };
Style.prototype.getPropertyValue = function (k) { return this._props[k] || ''; };

function ClassList(node) { this.node = node; }
ClassList.prototype.add = function (c) {
  var have = this.node.className ? this.node.className.split(' ') : [];
  if (have.indexOf(c) < 0) have.push(c);
  this.node.className = have.join(' ').trim();
};
ClassList.prototype.remove = function (c) {
  this.node.className = (this.node.className || '').split(' ')
    .filter(function (x) { return x && x !== c; }).join(' ');
};
ClassList.prototype.contains = function (c) {
  return (this.node.className || '').split(' ').indexOf(c) >= 0;
};
ClassList.prototype.toggle = function (c, on) {
  if (on === undefined) on = !this.contains(c);
  if (on) this.add(c); else this.remove(c);
  return on;
};

function Node(tag) {
  this.tagName = String(tag || '').toUpperCase();
  this.children = [];
  this.parent = null;
  this.attrs = {};
  this.className = '';
  this.classList = new ClassList(this);
  this.style = new Style();
  this.dataset = {};
  this.hidden = false;
  this._text = '';
  this.listeners = {};
}
Object.defineProperty(Node.prototype, 'textContent', {
  get: function () {
    if (!this.children.length) return this._text;
    return this.children.map(function (c) { return c.textContent; }).join('');
  },
  set: function (value) { this._text = String(value == null ? '' : value); this.children = []; }
});
Node.prototype.append = function () {
  for (var i = 0; i < arguments.length; i++) {
    var kid = arguments[i];
    if (kid == null) continue;
    if (typeof kid === 'string') { kid = new Node('#text'); kid._text = arguments[i]; }
    kid.parent = this;
    this.children.push(kid);
  }
};
Node.prototype.appendChild = function (kid) { this.append(kid); return kid; };
Node.prototype.replaceChildren = function () {
  this.children = [];
  Node.prototype.append.apply(this, arguments);
};
Node.prototype.remove = function () {
  if (!this.parent) return;
  var mine = this.parent.children;
  var at = mine.indexOf(this);
  if (at >= 0) mine.splice(at, 1);
  this.parent = null;
};
Node.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
Node.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
};
Node.prototype.addEventListener = function (type, fn) {
  (this.listeners[type] = this.listeners[type] || []).push(fn);
};
Node.prototype.removeEventListener = function (type, fn) {
  var have = this.listeners[type] || [];
  var at = have.indexOf(fn);
  if (at >= 0) have.splice(at, 1);
};
/* The stage builds its end panel with innerHTML and then reaches into it for
   one button to focus.  There is no parser here, so hand back a node: the
   harness cares what the run painted, not what the panel looks like. */
Node.prototype.querySelector = function () { return new Node('button'); };
Node.prototype.closest = function () { return null; };
Object.defineProperty(Node.prototype, 'innerHTML', {
  get: function () { return this._text; },
  set: function (value) { this._text = String(value == null ? '' : value); this.children = []; }
});
Node.prototype.focus = function () { document.activeElement = this; };

function Image() {
  Node.call(this, 'img');
  this.naturalWidth = 0;
  this.naturalHeight = 0;
}
Image.prototype = Object.create(Node.prototype);

var document = {
  hidden: false,
  activeElement: null,
  createElement: function (tag) { return new Node(tag); },
  createElementNS: function (_ns, tag) { return new Node(tag); },
  createTextNode: function (text) { var n = new Node('#text'); n._text = String(text); return n; },
  addEventListener: function () {},
  removeEventListener: function () {},
};
document.body = new Node('body');

var window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: function () {},
  removeEventListener: function () {},
};
var navigator = { clipboard: null };
var console = { log: function () {}, info: function () {}, warn: function () {},
                error: function () {}, group: function () {}, groupEnd: function () {} };
