// Tiny DOM helpers for the HUD. All HUD nodes are built once at init and cached —
// nothing here is ever queried per frame.

export function el(tag, className, parent, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
