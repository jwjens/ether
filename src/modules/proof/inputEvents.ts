// Import AFTER ./miniDom and BEFORE react-dom: React decides once, when it loads, whether the document has `oninput`;
// the mini DOM does not, so React would fall back to the old IE event path (attachEvent). With this a text field's
// onChange comes from a plain "input" event, as in a browser.
(globalThis as any).document.oninput = null;
export {};
