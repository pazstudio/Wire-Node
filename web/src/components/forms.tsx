import { useState, type FormEvent } from 'react';
import { api, errorMessage, imgUrl, type Cable, type ConnectorType, type Pcb, type Project } from '../api';
import { ColorPicker, ErrorText, Modal } from './ui';

// ---------- Project ----------

export function ProjectForm({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [machine, setMachine] = useState(project?.machine ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, machine, description };
      const saved = project
        ? await api.put<Project>(`/api/projects/${project.id}`, body)
        : await api.post<Project>('/api/projects', body);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={project ? 'Edit project' : 'New project'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Machine
          <input value={machine} onChange={(e) => setMachine(e.target.value)} placeholder="e.g. Voron 2.4 350" />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Component (PCB, motor, power supply, ...) ----------

export function PcbForm({
  pcb,
  projectId,
  onClose,
  onSaved,
}: {
  pcb?: Pcb;
  projectId?: string;
  onClose: () => void;
  onSaved: (p: Pcb) => void;
}) {
  const [name, setName] = useState(pcb?.name ?? '');
  const [description, setDescription] = useState(pcb?.description ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>(pcb ? imgUrl(pcb.thumbPath) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pcb && !file) {
      setError('Please choose a picture of the component');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('description', description);
      if (projectId && !pcb) fd.append('projectId', projectId);
      if (file) fd.append('image', file);
      const saved = pcb ? await api.put<Pcb>(`/api/pcbs/${pcb.id}`, fd) : await api.post<Pcb>('/api/pcbs', fd);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={pcb ? 'Edit component' : 'Upload component'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <label>
          {pcb ? 'Replace picture (optional)' : 'Picture'}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f) setPreview(URL.createObjectURL(f));
            }}
          />
        </label>
        {pcb && file && (
          <p className="muted small">
            Drawn connectors keep their relative position. Use a picture with the same framing.
          </p>
        )}
        {preview && <img src={preview} alt="" className="form-preview" />}
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Uploading…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Connector type ----------

export function ConnectorTypeForm({
  type,
  onClose,
  onSaved,
}: {
  type?: ConnectorType;
  onClose: () => void;
  onSaved: (t: ConnectorType) => void;
}) {
  const [name, setName] = useState(type?.name ?? '');
  const [pinCount, setPinCount] = useState(type?.pinCount ?? 2);
  const [rowCount, setRowCount] = useState(type?.rowCount ?? 1);
  const [crimpName, setCrimpName] = useState(type?.crimpName ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [preview, setPreview] = useState(type ? imgUrl(type.thumbPath) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('pinCount', String(pinCount));
      fd.append('rowCount', String(rowCount));
      fd.append('crimpName', crimpName);
      if (removeImage) fd.append('removeImage', 'true');
      if (file) fd.append('image', file);
      const saved = type
        ? await api.put<ConnectorType>(`/api/connector-types/${type.id}`, fd)
        : await api.post<ConnectorType>('/api/connector-types', fd);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={type ? 'Edit connector' : 'New connector'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. JST-XH 4P" />
        </label>
        <div className="form-row">
          <label>
            Number of pins
            <input type="number" min={1} max={500} value={pinCount} onChange={(e) => setPinCount(+e.target.value)} required />
          </label>
          <label>
            Number of rows
            <input type="number" min={1} max={20} value={rowCount} onChange={(e) => setRowCount(+e.target.value)} required />
          </label>
        </div>
        <label>
          Crimp name (optional)
          <input value={crimpName} onChange={(e) => setCrimpName(e.target.value)} placeholder="e.g. SXH-001T-P0.6" />
        </label>
        <label>
          Picture (optional)
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setRemoveImage(false);
              if (f) setPreview(URL.createObjectURL(f));
            }}
          />
        </label>
        {preview && !removeImage && <img src={preview} alt="" className="form-preview" />}
        {type?.imagePath && !file && (
          <label className="check">
            <input type="checkbox" checked={removeImage} onChange={(e) => setRemoveImage(e.target.checked)} /> Remove picture
          </label>
        )}
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Cable ----------

const GAUGE_PRESETS = ['28 AWG', '26 AWG', '24 AWG', '22 AWG', '20 AWG', '18 AWG', '16 AWG', '0.14 mm²', '0.25 mm²', '0.5 mm²', '0.75 mm²', '1.0 mm²', '1.5 mm²'];

export function CableForm({
  cable,
  onClose,
  onSaved,
}: {
  cable?: Cable;
  onClose: () => void;
  onSaved: (c: Cable) => void;
}) {
  const [name, setName] = useState(cable?.name ?? '');
  const [description, setDescription] = useState(cable?.description ?? '');
  const [coreCount, setCoreCount] = useState(cable?.coreCount ?? 2);
  const [cores, setCores] = useState<string[]>(cable?.cores.map((c) => c.color) ?? ['red', 'black']);
  const [shielded, setShielded] = useState(cable?.shielded ?? false);
  const [gauge, setGauge] = useState(cable?.gauge ?? '');
  const [lengthMm, setLengthMm] = useState<string>(cable?.lengthMm != null ? String(cable.lengthMm) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visibleCores = Array.from({ length: Math.max(1, coreCount || 1) }, (_, i) => cores[i] ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name,
        description,
        coreCount: Math.max(1, coreCount || 1),
        cores: visibleCores.map((color) => ({ color })),
        shielded,
        gauge,
        lengthMm: lengthMm.trim() === '' ? null : Number(lengthMm),
      };
      const saved = cable ? await api.put<Cable>(`/api/cables/${cable.id}`, body) : await api.post<Cable>('/api/cables', body);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={cable ? 'Edit cable' : 'New cable'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </label>
        <div className="form-row">
          <label>
            Number of cores
            <input type="number" min={1} max={200} value={coreCount} onChange={(e) => setCoreCount(+e.target.value)} required />
          </label>
          <label>
            Gauge
            <input list="gauge-presets" value={gauge} onChange={(e) => setGauge(e.target.value)} placeholder="e.g. 22 AWG" />
            <datalist id="gauge-presets">
              {GAUGE_PRESETS.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label>
            Length (mm)
            <input type="number" min={0} step="any" value={lengthMm} onChange={(e) => setLengthMm(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={shielded} onChange={(e) => setShielded(e.target.checked)} /> Shielded
        </label>
        <fieldset className="cores">
          <legend>Core colors</legend>
          {visibleCores.map((c, i) => (
            <div key={i} className="core-row">
              <span className="core-num">{i + 1}</span>
              <ColorPicker
                value={c}
                onChange={(v) =>
                  setCores((prev) => {
                    const next = [...prev];
                    while (next.length <= i) next.push('');
                    next[i] = v;
                    return next;
                  })
                }
              />
            </div>
          ))}
        </fieldset>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
