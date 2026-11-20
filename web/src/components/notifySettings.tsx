import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api';
import { ErrorText, Loading } from './ui';

interface NotifySettings {
  webhookUrl: string;
  baseUrl: string;
  events: { mentions: boolean; comments: boolean; testFailures: boolean; backupFailures: boolean };
}

const EVENTS: { key: keyof NotifySettings['events']; label: string }[] = [
  { key: 'mentions', label: 'Someone is @mentioned in a comment' },
  { key: 'comments', label: 'Every new comment' },
  { key: 'testFailures', label: 'A wire fails its test on the build checklist' },
  { key: 'backupFailures', label: 'An automatic backup fails, or fails its restore test' },
];

/** Admin panel: where to send notifications (Slack, Discord, Teams, ntfy… via a webhook). */
export function NotifySettingsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notify'], queryFn: () => api.get<NotifySettings>('/api/admin/notify') });
  const [s, setS] = useState<NotifySettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && !s) setS({ ...q.data, baseUrl: q.data.baseUrl || window.location.origin });
  }, [q.data, s]);

  if (!s) return <Loading error={q.error} />;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await api.put('/api/admin/notify', s);
      await qc.invalidateQueries({ queryKey: ['notify'] });
      setMsg('Saved.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function test() {
    setError(null);
    setMsg(null);
    try {
      await api.post('/api/admin/notify/test', s);
      setMsg('Test message sent.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="panel admin-narrow">
      <h3>Notifications</h3>
      <p className="small muted">
        Posts a message to a chat or notification service through a webhook: Slack and Microsoft Teams "incoming webhook",
        Discord channel webhook, ntfy topic URL, or anything that accepts a JSON POST with a <code>text</code> field. Every
        user also sees their @mentions under the @ button in the top bar.
      </p>
      <form className="form" onSubmit={save}>
        <label>
          Webhook URL
          <input
            value={s.webhookUrl}
            onChange={(e) => setS({ ...s, webhookUrl: e.target.value })}
            placeholder="https://hooks.slack.com/services/…  (empty = off)"
          />
        </label>
        <label>
          Address of this server, for links in messages
          <input value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} placeholder="https://wiring.example.com" />
        </label>
        <fieldset className="plain-fieldset">
          <legend className="small muted">Send a message when</legend>
          {EVENTS.map((ev) => (
            <label key={ev.key} className="check">
              <input
                type="checkbox"
                checked={s.events[ev.key]}
                onChange={(e) => setS({ ...s, events: { ...s.events, [ev.key]: e.target.checked } })}
              />{' '}
              {ev.label}
            </label>
          ))}
        </fieldset>
        <ErrorText error={error} />
        {msg && <p className="small ok-text">{msg}</p>}
        <div className="btn-row">
          <button type="button" className="btn" onClick={test} disabled={!s.webhookUrl}>
            Send a test message
          </button>
          <button className="btn btn-primary">Save</button>
        </div>
      </form>
    </div>
  );
}
