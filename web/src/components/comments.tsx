import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Attachment, type CommentDto, type MentionDto } from '../api';
import { useCan, useMe } from '../auth';
import { ErrorText } from './ui';

type EntityType = CommentDto['entityType'];

const when = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Shows @name mentions highlighted. */
function CommentBody({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9._-]{2,40})/gi);
  return (
    <p className="comment-body">
      {parts.map((p, i) => (p.startsWith('@') ? <span key={i} className="mention">{p}</span> : p))}
    </p>
  );
}

function useUserNames() {
  return useQuery({
    queryKey: ['user-names'],
    queryFn: () => api.get<{ username: string; displayName: string }[]>('/api/users/names'),
    staleTime: 5 * 60_000,
  }).data;
}

/** Comments on a connection, component or project, with @mentions and resolving. */
export function CommentThread({ entityType, entityId, projectId }: { entityType: EntityType; entityId: string; projectId?: string }) {
  const qc = useQueryClient();
  const me = useMe();
  const canResolve = useCan('projects.edit');
  const key = ['comments', entityType, entityId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<CommentDto[]>(`/api/comments?entityType=${entityType}&entityId=${entityId}`),
  });
  const users = useUserNames();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['mentions'] });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/comments', { entityType, entityId, projectId: projectId ?? null, body: text });
      setText('');
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      refresh();
    } catch (err) {
      alert(errorMessage(err));
    }
  }

  // @mention suggestion: the word being typed at the caret.
  const [caret, setCaret] = useState(0);
  const typed = /@([a-z0-9._-]*)$/i.exec(text.slice(0, caret))?.[1];
  const suggestions =
    typed !== undefined
      ? (users ?? []).filter((u) => u.username.startsWith(typed.toLowerCase()) && u.username !== me.username).slice(0, 6)
      : [];
  function pick(username: string) {
    const before = text.slice(0, caret).replace(/@([a-z0-9._-]*)$/i, `@${username} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(before.length, before.length);
    });
  }

  const all = q.data ?? [];
  const open = all.filter((c) => !c.resolvedAt);
  const resolved = all.filter((c) => c.resolvedAt);
  const list = showResolved ? all : open;

  return (
    <div className="comments">
      {list.length === 0 && <p className="small muted">No {resolved.length ? 'open ' : ''}comments.</p>}
      <ul className="comment-list">
        {list.map((c) => (
          <li key={c.id} className={`comment ${c.resolvedAt ? 'comment-resolved' : ''}`}>
            <div className="comment-head small">
              <strong>{c.userName}</strong> <span className="muted">{when(c.createdAt)}</span>
              {c.resolvedAt && <span className="badge">resolved by {c.resolvedBy}</span>}
              <span className="grow" />
              {(canResolve || c.userId === me.id) && (
                <button
                  className="btn-link small"
                  onClick={() => act(() => api.patch(`/api/comments/${c.id}`, { resolved: !c.resolvedAt }))}
                >
                  {c.resolvedAt ? 'Reopen' : 'Resolve'}
                </button>
              )}
              {(c.userId === me.id || me.isAdmin) && (
                <button
                  className="btn-link small danger-link"
                  onClick={() => confirm('Delete this comment?') && act(() => api.del(`/api/comments/${c.id}`))}
                >
                  Delete
                </button>
              )}
            </div>
            <CommentBody text={c.body} />
          </li>
        ))}
      </ul>
      {resolved.length > 0 && (
        <button className="btn-link small" onClick={() => setShowResolved(!showResolved)}>
          {showResolved ? 'Hide resolved' : `Show ${resolved.length} resolved`}
        </button>
      )}
      <form onSubmit={submit} className="comment-form">
        <div className="comment-input">
          <textarea
            ref={area}
            rows={2}
            value={text}
            placeholder="Add a comment… type @ to notify someone"
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
              if (suggestions.length && (e.key === 'Tab' || e.key === 'Enter') && !e.ctrlKey) {
                e.preventDefault();
                pick(suggestions[0].username);
              }
            }}
            aria-label="Comment"
          />
          {suggestions.length > 0 && (
            <ul className="ac-list mention-list">
              {suggestions.map((u) => (
                <li key={u.username}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(u.username)}>
                    @{u.username} {u.displayName && <span className="muted">{u.displayName}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ErrorText error={error} />
        <div className="btn-row">
          <button className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>
            Comment
          </button>
          <span className="small muted">Ctrl+Enter</span>
        </div>
      </form>
    </div>
  );
}

/** Top-bar button listing open comments that mention the signed-in user. */
export function MentionsButton() {
  const q = useQuery({
    queryKey: ['mentions'],
    queryFn: () => api.get<MentionDto[]>('/api/comments/mentions'),
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const items = q.data ?? [];
  const link = (m: MentionDto) =>
    m.entityType === 'connection' && m.projectId
      ? `/projects/${m.projectId}/connections/${m.entityId}`
      : m.entityType === 'component' && m.projectId
        ? `/projects/${m.projectId}/pcbs/${m.entityId}`
        : m.projectId
          ? `/projects/${m.projectId}?tab=history`
          : '/';
  return (
    <div className="mentions" ref={ref}>
      <button className="topbar-help" onClick={() => setOpen(!open)} title="Comments that mention you" aria-label="Mentions">
        @{items.length > 0 && <span className="mentions-count">{items.length}</span>}
      </button>
      {open && (
        <div className="mentions-pop">
          <div className="small muted mentions-title">Open comments that mention you</div>
          {items.length === 0 && <p className="small muted">Nothing new.</p>}
          {items.map((m) => (
            <Link key={m.id} to={link(m)} className="mentions-item" onClick={() => setOpen(false)}>
              <span className="small">
                <strong>{m.userName}</strong> on {m.entityName}
                {m.projectName && m.entityType !== 'project' && <span className="muted"> · {m.projectName}</span>}
              </span>
              <span className="small muted mentions-text">{m.body}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/** Datasheets, pinouts and other files on a library component. */
export function Attachments({ pcbId, readOnly }: { pcbId: string; readOnly: boolean }) {
  const qc = useQueryClient();
  const key = ['attachments', pcbId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Attachment[]>(`/api/pcbs/${pcbId}/attachments`) });
  const canEdit = useCan('library.edit') && !readOnly;
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', f, f.name);
        await api.post(`/api/pcbs/${pcbId}/attachments`, fd);
      }
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: key });
    }
  }

  async function remove(a: Attachment) {
    if (!confirm(`Delete "${a.fileName}"?`)) return;
    try {
      await api.del(`/api/attachments/${a.id}`);
      void qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  const list = q.data ?? [];
  return (
    <div className="attachments">
      {list.length === 0 && <p className="small muted">No files yet. Attach datasheets, pinouts or measurements.</p>}
      <ul className="attachment-list">
        {list.map((a) => (
          <li key={a.id}>
            <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">
              📄 {a.fileName}
            </a>
            <span className="small muted">
              {' '}
              {fmtSize(a.size)} · {a.uploadedBy}
            </span>
            <span className="grow" />
            <a className="small" href={`/api/attachments/${a.id}?download=1`}>
              Download
            </a>
            {canEdit && (
              <button className="btn-link small danger-link" onClick={() => remove(a)}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <label className={`btn btn-sm ${busy ? 'disabled' : ''}`}>
          {busy ? 'Uploading…' : '+ Attach files'}
          <input type="file" multiple hidden disabled={busy} onChange={(e) => upload(e.target.files).then(() => (e.target.value = ''))} />
        </label>
      )}
    </div>
  );
}
