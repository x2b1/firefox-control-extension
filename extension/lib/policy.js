'use strict';
/* Domain policy matching, shared by the background page and the content script.
 *
 * This exists as a single module because it is a security boundary: three
 * hand-rolled copies of the same subdomain rule is three chances to get the dot
 * guard wrong, and the copy that is subtly wrong is the one that decides
 * whether a page gets access.
 *
 * Deny-by-default: an empty allow list permits nothing.
 */
/* `var`, not `const`: every file listed in a manifest content_scripts or
 * background.scripts array is compiled as its own script, and only `var`
 * reliably lands on the shared sandbox global that the other files read from.
 * A `const` here compiles fine and throws "PBPolicy is not defined" the moment
 * a sibling file calls it. */
var PBPolicy = (() => {
  const hostOf = (url) => {
    try {
      return new URL(String(url)).hostname.toLowerCase();
    } catch {
      return '';
    }
  };

  /**
   * An entry matches the exact host, any subdomain of it, or (with a leading
   * "*.") both the apex and its subdomains.
   *
   * The dot before the suffix is essential: a naive `endsWith(entry)` would let
   * "notexample.com" match an allow rule for "example.com", handing a
   * completely different registrable domain access. We deliberately do not
   * implement public-suffix handling, since an omitted entry can only ever
   * make the policy stricter, never looser.
   */
  const hostMatches = (host, entry) => {
    if (!host || !entry) return false;
    const h = String(host).toLowerCase();
    const e = String(entry).toLowerCase();
    if (e === '*') return true;
    if (e.startsWith('*.')) {
      const apex = e.slice(2);
      if (!apex) return false;
      return h === apex || h.endsWith('.' + apex);
    }
    return h === e || h.endsWith('.' + e);
  };

  /**
   * allow-all is an explicit, deliberate opt-out: it is a single flag you set
   * to hand the bridge your whole browser. Everything else denies by default,
   * including a missing or malformed policy.
   */
  const isAllowed = (url, policy) => {
    if (policy && policy.mode === 'allow-all') return true;
    const host = hostOf(url);
    if (!host) return false;
    return (policy?.allow || []).some((entry) => hostMatches(host, entry));
  };

  /** Same as isAllowed but for a bare hostname rather than a URL. */
  const isHostAllowed = (host, policy) => {
    if (policy && policy.mode === 'allow-all') return true;
    if (!host) return false;
    return (policy?.allow || []).some((entry) => hostMatches(String(host).toLowerCase(), entry));
  };

  return { hostOf, hostMatches, isAllowed, isHostAllowed };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PBPolicy;
