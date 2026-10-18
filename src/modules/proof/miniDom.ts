// A minimal DOM for the module proof tests — just enough for react-dom/client to mount the app's real components,
// run their effects and dispatch clicks / input / pointer events through React's own event system.
//
// WHY NOT JSDOM: this tree has no DOM environment (no jsdom, no happy-dom, no testing-library — see the note at the
// top of src/components/ProgramLog.layout.test.tsx), and the proofs must not add packages. So this file installs a
// small DOM on globalThis. It is test scaffolding only: it never ships, and it renders nothing to pixels. Pixels are
// Jeff's receipt (CLAUDE.md: the only valid UI test is launching the app).
//
// IMPORT IT FIRST in a proof test, before anything that imports react-dom: react-dom reads `window.document` once
// when it loads (canUseDOM).

const ELEMENT_NODE = 1, TEXT_NODE = 3, COMMENT_NODE = 8, DOCUMENT_NODE = 9, FRAGMENT_NODE = 11;

type Listener = { fn: any; capture: boolean; once: boolean };

export interface MiniEvent {
  type: string; bubbles: boolean; cancelable: boolean; defaultPrevented: boolean; returnValue: boolean;
  target: any; currentTarget: any; srcElement: any; eventPhase: number; timeStamp: number; isTrusted: boolean;
  cancelBubble: boolean; _stop: boolean; _stopNow: boolean;
  preventDefault(): void; stopPropagation(): void; stopImmediatePropagation(): void;
  [k: string]: any;
}

export function makeEvent(type: string, init: Record<string, any> = {}): MiniEvent {
  return {
    type, bubbles: true, cancelable: true, defaultPrevented: false, returnValue: true,
    target: null, currentTarget: null, srcElement: null, eventPhase: 0, timeStamp: Date.now(), isTrusted: true,
    cancelBubble: false, _stop: false, _stopNow: false,
    button: 0, buttons: 0, clientX: 0, clientY: 0, screenX: 0, screenY: 0, pageX: 0, pageY: 0,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, detail: 0,
    getModifierState() { return false; },
    preventDefault() { this.defaultPrevented = true; this.returnValue = false; },
    stopPropagation() { this._stop = true; this.cancelBubble = true; },
    stopImmediatePropagation() { this._stop = true; this._stopNow = true; this.cancelBubble = true; },
    ...init,
  };
}

class MiniStyle {
  [k: string]: any;
  setProperty(name: string, value: string) { this[name] = value; }
  removeProperty(name: string) { delete this[name]; }
  getPropertyValue(name: string) { return this[name] ?? ""; }
}

class MiniNode {
  nodeType: number;
  nodeName: string;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  ownerDocument: any;
  _listeners = new Map<string, Listener[]>();

  constructor(doc: any, nodeType: number, nodeName: string) {
    this.ownerDocument = doc; this.nodeType = nodeType; this.nodeName = nodeName;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  get previousSibling(): MiniNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] ?? null : null; }
  get parentElement(): MiniNode | null { return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null; }
  get isConnected() { let n: MiniNode | null = this; while (n) { if (n.nodeType === DOCUMENT_NODE) return true; n = n.parentNode; } return false; }
  hasChildNodes() { return this.childNodes.length > 0; }
  appendChild(c: MiniNode) { return this.insertBefore(c, null); }
  insertBefore(c: MiniNode, ref: MiniNode | null) {
    if (c.nodeType === FRAGMENT_NODE) { for (const k of [...c.childNodes]) this.insertBefore(k, ref); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: MiniNode) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceChild(n: MiniNode, old: MiniNode) { this.insertBefore(n, old); this.removeChild(old); return old; }
  remove() { this.parentNode?.removeChild(this); }
  contains(n: MiniNode | null) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  getRootNode() { let n: MiniNode = this; while (n.parentNode) n = n.parentNode; return n; }
  cloneNode() { return this.ownerDocument.createTextNode(""); }
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && v !== "") this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  addEventListener(type: string, fn: any, opts?: boolean | { capture?: boolean; once?: boolean }) {
    if (!fn) return;
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const once = typeof opts === "object" && !!opts?.once;
    const l = this._listeners.get(type) || [];
    if (!l.some(x => x.fn === fn && x.capture === capture)) l.push({ fn, capture, once });
    this._listeners.set(type, l);
  }
  removeEventListener(type: string, fn: any, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const l = this._listeners.get(type);
    if (l) this._listeners.set(type, l.filter(x => !(x.fn === fn && x.capture === capture)));
  }
  _fire(ev: MiniEvent, capturePhase: boolean) {
    const l = this._listeners.get(ev.type);
    if (!l) return;
    for (const x of [...l]) {
      if (x.capture !== capturePhase) continue;
      ev.currentTarget = this;
      if (x.once) this.removeEventListener(ev.type, x.fn, x.capture);
      if (typeof x.fn === "function") x.fn.call(this, ev); else x.fn?.handleEvent?.(ev);
      if (ev._stopNow) return;
    }
  }
  dispatchEvent(ev: MiniEvent) {
    ev.target = this; ev.srcElement = this;
    const path: MiniNode[] = [];
    for (let n: MiniNode | null = this; n; n = n.parentNode) path.push(n);
    for (let i = path.length - 1; i >= 0 && !ev._stop; i--) { ev.eventPhase = i === 0 ? 2 : 1; path[i]._fire(ev, true); }
    for (let i = 0; i < path.length && !ev._stop; i++) {
      if (i > 0 && !ev.bubbles) break;
      ev.eventPhase = i === 0 ? 2 : 3;
      path[i]._fire(ev, false);
    }
    ev.currentTarget = null;
    return !ev.defaultPrevented;
  }
}

class MiniText extends MiniNode {
  data: string;
  constructor(doc: any, data: string) { super(doc, TEXT_NODE, "#text"); this.data = data; }
  get nodeValue() { return this.data; }
  set nodeValue(v: string) { this.data = String(v); }
  get textContent() { return this.data; }
  set textContent(v: string) { this.data = String(v); }
}

class MiniComment extends MiniNode {
  data: string;
  constructor(doc: any, data: string) { super(doc, COMMENT_NODE, "#comment"); this.data = data; }
  get textContent() { return ""; }
  set textContent(_v: string) { /* comments carry no text content */ }
}

/** Simple selectors only: tag, #id, .class, [attr], [attr="v"], compounds of those, and descendant lists split by ",". */
function matchesSimple(el: MiniElement, sel: string): boolean {
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g;
  let m: RegExpExecArray | null, any = false;
  while ((m = re.exec(sel))) {
    any = true;
    if (m[1] && el.localName !== m[1].toLowerCase()) return false;
    if (m[2] && el.getAttribute("id") !== m[2]) return false;
    if (m[3] && !(el.getAttribute("class") || "").split(/\s+/).includes(m[3])) return false;
    if (m[4] && (m[5] === undefined ? !el.hasAttribute(m[4]) : el.getAttribute(m[4]) !== m[5])) return false;
  }
  return any;
}

class MiniElement extends MiniNode {
  localName: string;
  tagName: string;
  namespaceURI: string;
  _attrs = new Map<string, string>();
  style = new MiniStyle();
  innerHTMLValue = "";
  scrollTop = 0; scrollLeft = 0; scrollHeight = 0; scrollWidth = 0;
  clientWidth = 0; clientHeight = 0; offsetWidth = 0; offsetHeight = 0; offsetTop = 0; offsetLeft = 0;
  offsetParent: any = null;
  constructor(doc: any, tag: string, ns = "http://www.w3.org/1999/xhtml") {
    super(doc, ELEMENT_NODE, tag.toUpperCase());
    this.localName = tag.toLowerCase(); this.tagName = tag.toUpperCase(); this.namespaceURI = ns;
  }
  setAttribute(n: string, v: any) { this._attrs.set(n, String(v)); }
  setAttributeNS(_ns: string | null, n: string, v: any) { this._attrs.set(n, String(v)); }
  getAttribute(n: string) { return this._attrs.has(n) ? this._attrs.get(n)! : null; }
  hasAttribute(n: string) { return this._attrs.has(n); }
  removeAttribute(n: string) { this._attrs.delete(n); }
  removeAttributeNS(_ns: string | null, n: string) { this._attrs.delete(n); }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  get id() { return this.getAttribute("id") || ""; }
  set id(v: string) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") || ""; }
  set className(v: string) { this.setAttribute("class", v); }
  get title() { return this.getAttribute("title") || ""; }
  get classList() {
    const el = this;
    const list = () => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const set = (xs: string[]) => el.setAttribute("class", xs.join(" "));
    return {
      add: (...c: string[]) => set([...new Set([...list(), ...c])]),
      remove: (...c: string[]) => set(list().filter(x => !c.includes(x))),
      contains: (c: string) => list().includes(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !list().includes(c);
        set(on ? [...new Set([...list(), c])] : list().filter(x => x !== c));
        return on;
      },
      get length() { return list().length; },
      item: (i: number) => list()[i] ?? null,
      [Symbol.iterator]: () => list()[Symbol.iterator](),
    };
  }
  _dataset: Record<string, string> = {};
  get dataset() { return this._dataset; }
  get children() { return this.childNodes.filter(c => c.nodeType === ELEMENT_NODE) as MiniElement[]; }
  get innerHTML() { return this.innerHTMLValue; }
  set innerHTML(v: string) { this.textContent = ""; this.innerHTMLValue = v; }
  get innerText() { return this.textContent; }
  set innerText(v: string) { this.textContent = v; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(makeEvent("click")); }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return this; } }; }
  getClientRects() { return []; }
  scrollIntoView() { /* no layout */ }
  scrollTo() { /* no layout */ }
  scrollBy() { /* no layout */ }
  setPointerCapture() { /* no pointer */ }
  releasePointerCapture() { /* no pointer */ }
  hasPointerCapture() { return false; }
  animate() { return { cancel() {}, finished: Promise.resolve(), onfinish: null }; }
  matches(sel: string) { return sel.split(",").some(s => matchesSimple(this, s.trim().split(/\s+/).pop() || "")); }
  closest(sel: string) { for (let n: any = this; n && n.nodeType === ELEMENT_NODE; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel: string): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (n: MiniNode) => { for (const c of n.childNodes) if (c.nodeType === ELEMENT_NODE) { if ((c as MiniElement).matches(sel)) out.push(c as MiniElement); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  getElementsByTagName(tag: string) { return this.querySelectorAll(tag); }
}

class MiniInput extends MiniElement {
  value = ""; defaultValue = ""; checked = false; defaultChecked = false; disabled = false;
  selectionStart = 0; selectionEnd = 0;
  get type() { return this.getAttribute("type") || "text"; }
  set type(v: string) { this.setAttribute("type", v); }
  select() { /* no selection */ }
  setSelectionRange() { /* no selection */ }
}
class MiniTextArea extends MiniElement {
  value = ""; defaultValue = ""; selectionStart = 0; selectionEnd = 0;
  select() { /* no selection */ }
}
class MiniOption extends MiniElement {
  selected = false; defaultSelected = false; disabled = false;
  get value() { return this.getAttribute("value") ?? this.textContent; }
  set value(v: string) { this.setAttribute("value", v); }
}
class MiniSelect extends MiniElement {
  multiple = false; disabled = false;
  get options() { return this.querySelectorAll("option") as unknown as MiniOption[]; }
  get value() { const o = this.options.find(x => x.selected) || this.options[0]; return o ? o.value : ""; }
  set value(v: string) { for (const o of this.options) o.selected = o.value === v; }
  get selectedIndex() { return this.options.findIndex(o => o.selected); }
  set selectedIndex(i: number) { this.options.forEach((o, k) => { o.selected = k === i; }); }
}
class MiniButton extends MiniElement { disabled = false; }
class MiniCanvas extends MiniElement {
  width = 300; height = 150;
  getContext() { return null; }
}

class MiniDocument extends MiniNode {
  documentElement: MiniElement;
  head: MiniElement;
  body: MiniElement;
  activeElement: any;
  defaultView: any;
  readyState = "complete";
  visibilityState = "visible";
  hidden = false;
  cookie = "";
  constructor() {
    super(null, DOCUMENT_NODE, "#document");
    this.ownerDocument = null;
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string): MiniElement {
    const t = tag.toLowerCase();
    const C = t === "input" ? MiniInput : t === "textarea" ? MiniTextArea : t === "select" ? MiniSelect
      : t === "option" ? MiniOption : t === "button" ? MiniButton : t === "canvas" ? MiniCanvas : MiniElement;
    return new C(this, t);
  }
  createElementNS(ns: string, tag: string) { return new MiniElement(this, tag, ns); }
  createTextNode(data: string) { return new MiniText(this, data); }
  createComment(data: string) { return new MiniComment(this, data); }
  createDocumentFragment() { return new MiniNode(this, FRAGMENT_NODE, "#document-fragment"); }
  getElementById(id: string) { return this.documentElement.querySelector(`#${id}`); }
  querySelector(sel: string) { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel: string) { return this.documentElement.querySelectorAll(sel); }
  getElementsByTagName(tag: string) { return this.documentElement.querySelectorAll(tag); }
  hasFocus() { return true; }
  getSelection() { return { rangeCount: 0, removeAllRanges() {}, addRange() {} }; }
  execCommand() { return false; }
}

// ── install ───────────────────────────────────────────────────────────────────────────────────────────

const g = globalThis as any;
if (!g.__miniDomInstalled) {
  g.__miniDomInstalled = true;
  const doc = new MiniDocument();
  g.window = g;
  g.document = doc;
  doc.defaultView = g;
  g.self = g;
  g.Node = MiniNode;
  g.Element = MiniElement;
  g.HTMLElement = MiniElement;
  g.SVGElement = MiniElement;
  g.HTMLInputElement = MiniInput;
  g.HTMLTextAreaElement = MiniTextArea;
  g.HTMLSelectElement = MiniSelect;
  g.HTMLOptionElement = MiniOption;
  g.HTMLButtonElement = MiniButton;
  g.HTMLCanvasElement = MiniCanvas;
  g.HTMLIFrameElement = class HTMLIFrameElement extends MiniElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement extends MiniElement {};
  g.Text = MiniText;

  // window-level events: a real EventTarget, so app code's window.addEventListener / dispatchEvent(new CustomEvent)
  // behave as in a browser.
  const winEvents = new EventTarget();
  g.addEventListener = winEvents.addEventListener.bind(winEvents);
  g.removeEventListener = winEvents.removeEventListener.bind(winEvents);
  g.dispatchEvent = winEvents.dispatchEvent.bind(winEvents);

  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(g, "localStorage", { value: storage, configurable: true, writable: true });
  Object.defineProperty(g, "sessionStorage", { value: { ...storage }, configurable: true, writable: true });

  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  g.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  g.requestAnimationFrame = (cb: any) => setTimeout(() => cb(Date.now()), 16) as any;
  g.cancelAnimationFrame = (id: any) => clearTimeout(id);
  g.requestIdleCallback = (cb: any) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 1) as any;
  g.cancelIdleCallback = (id: any) => clearTimeout(id);
  g.getComputedStyle = () => new MiniStyle();
  g.matchMedia = () => ({ matches: false, media: "", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  g.scrollTo = () => {};
  g.alert = () => {};
  g.confirm = () => true;
  g.prompt = () => null;
  g.innerWidth = 1600; g.innerHeight = 900; g.devicePixelRatio = 1;
  g.location = { href: "http://localhost/", hash: "", search: "", pathname: "/", origin: "http://localhost", reload() {}, assign() {}, replace() {} };
  g.history = { pushState() {}, replaceState() {}, back() {} };
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

/** The text of a node and everything under it. */
export function textOf(n: any): string { return n?.textContent ?? ""; }

/** Every element under `root` (inclusive) whose own text, trimmed, equals `text`. */
export function findAllByText(root: any, text: string): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n.nodeType === ELEMENT_NODE) {
      if ((n.textContent || "").trim() === text) out.push(n);
      for (const c of n.childNodes) walk(c);
    }
  };
  walk(root);
  // innermost first: an element whose child also matches is a wrapper, not the control
  return out.filter(el => !out.some(o => o !== el && el.contains(o)));
}

/** Every element under `root` whose attribute `name` equals `value`. */
export function findAllByAttr(root: any, name: string, value: string): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n.nodeType === ELEMENT_NODE) {
      if (n.getAttribute(name) === value) out.push(n);
      for (const c of n.childNodes) walk(c);
    }
  };
  walk(root);
  return out;
}

/** Dispatch a DOM event on an element through the mini DOM (React's root listener receives it). */
export function fire(el: any, type: string, init: Record<string, any> = {}) {
  return el.dispatchEvent(makeEvent(type, init));
}

/** A key press as the browser delivers it to window listeners (the cart wall's hotkeys listen there). */
export function pressKey(key: string) {
  const ev = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    key: { value: key }, code: { value: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}` },
    ctrlKey: { value: false }, shiftKey: { value: false }, altKey: { value: false }, metaKey: { value: false },
  });
  (globalThis as any).dispatchEvent(ev);
}
