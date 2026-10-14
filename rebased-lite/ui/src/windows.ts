// The open windows (Compare, Review, History, Show Repository at Revision). Back and Forward close them
// before they open a place in another window.

const closers = new Set<() => void>();

/** Registers the close function of a window. The returned function takes it out again; call it when the
 * window closes. */
export function registerWindow(close: () => void): () => void {
  closers.add(close);
  return () => closers.delete(close);
}

/** Closes all open windows. */
export function closeWindows() {
  for (const close of [...closers]) close();
}
