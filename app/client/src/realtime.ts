import { useEffect } from 'react';
import { session } from './api';

/**
 * Client for the server's real-time stream (GET /api/events, Server-Sent Events).
 * Uses fetch streaming instead of EventSource so the session token travels in the Authorization header,
 * never in a URL. Reconnects with backoff; events are re-broadcast as window events for components.
 */
export interface ChangeEvent { type: 'change'; projectKey: string; keys: string[]; actor: string; scope: 'issue' | 'space' }
export type LiveState = 'connecting' | 'live' | 'offline';

export function startRealtime(handlers: {
  onChange: (e: ChangeEvent) => void;
  onNotification: () => void;
  onState: (s: LiveState) => void;
}) {
  let stopped = false;
  let ctl: AbortController | null = null;
  let delay = 1000;

  const loop = async () => {
    while (!stopped) {
      handlers.onState('connecting');
      ctl = new AbortController();
      try {
        const res = await fetch('/api/events', {
          headers: session.token ? { authorization: `Bearer ${session.token}` } : {},
          signal: ctl.signal,
          cache: 'no-store',
        });
        if (res.status === 401) { handlers.onState('offline'); return; } // signed out: stop
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event === 'hello') { handlers.onState('live'); delay = 1000; }
            else if (event === 'change' && data) handlers.onChange(JSON.parse(data));
            else if (event === 'notification') handlers.onNotification();
          }
        }
      } catch {
        if (stopped) return;
      }
      if (stopped) return;
      handlers.onState('offline');
      await new Promise((r) => setTimeout(r, delay + Math.random() * 500));
      delay = Math.min(delay * 2, 30_000);
    }
  };
  loop();
  return () => { stopped = true; ctl?.abort(); };
}

/** Subscribe a component to change events (re-broadcast by the shell as `tracker:change`). */
export function useLiveChanges(handler: (e: ChangeEvent) => void, deps: unknown[]) {
  useEffect(() => {
    const fn = (ev: Event) => handler((ev as CustomEvent<ChangeEvent>).detail);
    window.addEventListener('tracker:change', fn);
    return () => window.removeEventListener('tracker:change', fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
