// The one owner of programmatic document navigation (A§9): sign-in, sign-out and stale-chunk reloads all leave
// the page through here. `location.assign`, `replace` and `reload` cannot be wrapped (L§4.6), so nothing else in
// host code calls them. A full load after an auth change drops every in-memory moss and bridge cache.

/** Replaces this history entry with `href`, so Back never returns to the page that was left. */
export function leaveTo(href: string): void {
  window.location.replace(href);
}

export function reloadDocument(): void {
  window.location.reload();
}
