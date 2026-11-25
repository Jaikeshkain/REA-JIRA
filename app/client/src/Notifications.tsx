import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type AppNotification, type Inbox } from './api';
import { Avatar, Popover, timeAgo } from './ui';

const POLL_MS = 120_000; // fallback only: the live stream pings on new notifications

function sentence(n: AppNotification) {
  const who = <strong>{n.actor.displayName}</strong>;
  const key = <strong>{n.issue.key}</strong>;
  switch (n.kind) {
    case 'assigned': return <>{who} assigned {key} to you</>;
    case 'mentioned': return <>{who} mentioned you {n.data.where === 'description' ? 'in the description of' : 'on'} {key}</>;
    case 'commented': return <>{who} commented on {key}</>;
    case 'status': return <>{who} moved {key} from <em>{n.data.from}</em> to <em>{n.data.to}</em></>;
  }
}

/** Top-bar bell: unread badge, Direct (assigned, mentions) / Watching (comments, status) tabs. Polls every 30 s. */
export function NotificationBell({ version }: { version: number }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'direct' | 'watching'>('direct');
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);

  const load = useCallback(() => api.notifications(tab, 30).then(setInbox, () => {}), [tab]);
  useEffect(() => {
    window.addEventListener('tracker:notify', load);
    return () => window.removeEventListener('tracker:notify', load);
  }, [load]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load, version]);

  const unread = inbox?.unread.unread ?? 0;
  const items = (inbox?.items ?? []).filter((n) => !onlyUnread || !n.read);

  return (
    <div className="menu-anchor">
      <button className="icon-btn bell" onClick={() => { setOpen((o) => !o); load(); }} aria-haspopup="dialog" aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
        🔔{unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="right">
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            <label className="check small-check"><input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> Only unread</label>
          </div>
          <div className="tabs small" role="tablist">
            {(['direct', 'watching'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'direct' ? 'Direct' : 'Watching'}
                {(inbox?.unread[t] ?? 0) > 0 && <span className="count">{inbox!.unread[t]}</span>}
              </button>
            ))}
            <span className="grow" />
            {(inbox?.unread[tab] ?? 0) > 0 && (
              <button className="link-btn" onClick={() => api.markRead({ all: true, tab }).then(load)}>Mark all as read</button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="muted small empty">{tab === 'direct' ? 'Nothing assigned to you or mentioning you yet.' : 'No updates on work you watch.'}</p>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.id}>
                  <button className={`notif ${n.read ? '' : 'unread'}`} onClick={() => {
                    if (!n.read) api.markRead({ ids: [n.id] }).then(load);
                    setOpen(false);
                    nav(`/browse/${n.issue.key}`);
                  }}>
                    <Avatar user={n.actor} size={28} />
                    <span className="notif-body">
                      <span>{sentence(n)}</span>
                      <span className="muted small notif-summary">{n.issue.summary}</span>
                      {n.data.excerpt && <span className="notif-excerpt">“{n.data.excerpt}”</span>}
                      <span className="muted small">{timeAgo(n.created)}</span>
                    </span>
                    {!n.read && <span className="dot" aria-label="Unread" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Popover>
    </div>
  );
}
