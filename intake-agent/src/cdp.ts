/**
 * Thin wrapper over chrome.debugger. Attaching paints Chrome's "started
 * debugging this browser" banner — that is expected and documented in the
 * README, not an accident.
 */
let tabId: number | null = null;

/**
 * Requests started and not yet finished or failed. One of the two signals
 * settle() waits on — the other is the accessibility tree going quiet.
 */
const pending = new Set<string>();
export const inflight = (): number => pending.size;

/** Set by the panel. One consumer, so one callback rather than a subscriber list. */
export let onStale: (reason: string) => void = () => {};
export function setStaleHandler(fn: typeof onStale): void {
  onStale = fn;
}

// Guarded so the pure perception code can be imported outside a browser.
if (globalThis.chrome?.debugger) {
  chrome.debugger.onEvent.addListener((_src, method, params) => {
    // Anything that can move the page out from under a snapshot: navigation, a
    // document swap, or a React re-render that replaces the tree wholesale.
    if (method === 'Page.frameNavigated' || method === 'DOM.documentUpdated' || method === 'Page.loadEventFired') {
      onStale(method);
    }
    const id = (params as { requestId?: string })?.requestId;
    if (!id) return;
    if (method === 'Network.requestWillBeSent') pending.add(id);
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') pending.delete(id);
  });

  chrome.debugger.onDetach.addListener(() => {
    tabId = null;
    onStale('detached');
  });
}

export async function attach(id: number): Promise<void> {
  if (tabId === id) return;
  pending.clear();
  if (tabId !== null) await detach();
  await chrome.debugger.attach({ tabId: id }, '1.3');
  tabId = id;
  try {
    await send('DOM.enable');
    await send('Page.enable');
    await send('Accessibility.enable');
    await send('Network.enable'); // in-flight requests, for settle(). No extra permission.
  } catch (err) {
    await detach(); // never leave a half-enabled debugger session attached
    throw err;
  }
}

export async function detach(): Promise<void> {
  const id = tabId;
  tabId = null;
  pending.clear();
  if (id !== null) await chrome.debugger.detach({ tabId: id }).catch(() => {});
}

/** Detach when the panel goes away, so no tab is left under a debugger. */
export function detachOnUnload(): void {
  globalThis.addEventListener?.('pagehide', () => void detach());
}

export async function send<T = any>(method: string, params: object = {}): Promise<T> {
  if (tabId === null) throw new Error('not attached to a tab');
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}
