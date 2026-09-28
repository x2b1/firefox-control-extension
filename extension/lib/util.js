'use strict';
/* Small helpers shared by the background page. Kept separate so the popup and
 * background can share them without a module loader (MV2 CSP). */
/* `var` so it lands on the shared sandbox global; see the note in
 * lib/policy.js about manifest script scoping. */
var PB = {
  stamp: () => new Date().toISOString().slice(11, 23),

  fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`;
  },

  async saveText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
