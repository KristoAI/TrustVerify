import { bounded } from './async';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(label: string, action: () => void | Promise<void>, secondary = false) {
  const node = element('button', label, secondary ? 'button secondary' : 'button');
  node.type = 'button';
  node.addEventListener('click', () => { void action(); });
  return node;
}

export function render(title: string, description: string) {
  const root = document.querySelector<HTMLElement>('#verification')!;
  root.replaceChildren();
  root.setAttribute('aria-busy', 'false');
  const heading = element('h1', title);
  heading.tabIndex = -1;
  const intro = element('p', description, 'intro');
  const content = element('div', undefined, 'flow-content');
  const status = element('p', '', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const actions = element('div', undefined, 'actions');
  root.append(heading, intro, content, status, actions);
  heading.focus({ preventScroll: true });
  return { root, content, status, actions };
}

export function safeCompletionUrl(value: unknown, origin = window.location.origin): string {
  if (typeof value !== 'string') throw new Error('INVALID_COMPLETION');
  const url = new URL(value, origin);
  if (url.origin !== origin || !/^\/complete\/[A-Za-z0-9_-]+$/.test(url.pathname) || !url.searchParams.get('handoff')) throw new Error('INVALID_COMPLETION');
  return url.href;
}

export const REQUEST_TIMEOUT_MS = 15000;

export async function request<T = any>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const transport = new AbortController();
  const work = (async () => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: transport.signal });
    if (!response.ok) throw new Error(response.status === 410 ? 'SESSION_EXPIRED' : 'REQUEST_FAILED');
    return await response.json() as T;
  })();
  try {
    // Include response-body consumption in the deadline. The race also bounds a
    // stalled browser transport, while abort below releases its network work.
    return await bounded(work, signal, REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (error instanceof Error && error.message === 'OPERATION_TIMEOUT') throw new Error('REQUEST_TIMEOUT');
    if (error instanceof Error && error.message === 'SESSION_EXPIRED') throw new Error('SESSION_EXPIRED');
    throw new Error('REQUEST_FAILED');
  } finally {
    transport.abort();
  }
}
