// Pipelines, stages (add / rename / reorder / delete safely / required fields) and custom fields — no code needed.
import { useState } from 'react';
import { api, patch, post, put } from '../lib/api.js';
import { useApi, useAction } from '../lib/app.jsx';
import { Badge, Button, ErrorNotice, Field, Loading, Modal, PageHeader, Table } from '../components/ui.jsx';

export default function Pipelines() {
  const { data, error, reload } = useApi('/pipelines', { live: ['config'] });
  const [pid, setPid] = useState(null);
  const [run, busy] = useAction();
  const [newPipe, setNewPipe] = useState('');
  const [newStage, setNewStage] = useState({ name: '', kind: 'open' });
  const [stageEdit, setStageEdit] = useState(null);
  const [delStage, setDelStage] = useState(null);
  const [fieldModal, setFieldModal] = useState(null);
  if (!data) return error ? <ErrorNotice error={error} onRetry={reload} /> : <Loading />;
  const pipe = data.pipelines.find((p) => p.id === pid) || data.pipelines[0];
  const stages = pipe.stages;
  const fieldsFor = (p) => data.fields.filter((f) => f.entity === 'opportunity' && (!f.pipeline_id || f.pipeline_id === p.id));
  const reqOptions = [...data.builtinRequirable, ...fieldsFor(pipe).map((f) => ({ key: f.key, label: f.label }))];
  const move = (i, d) => {
    const ids = stages.map((s) => s.id);
    const [x] = ids.splice(i, 1); ids.splice(i + d, 0, x);
    run(() => put(`/pipelines/${pipe.id}/stage-order`, { stageIds: ids }).then(reload));
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title="Pipelines & custom fields" subtitle="Shape the CRM to your business. Changes apply immediately and are recorded in the audit log." />
      <section className="card">
        <div className="card-header">
          <h2>Pipelines</h2>
          <form className="row" onSubmit={async (e) => { e.preventDefault(); const p = await run(() => post('/pipelines', { name: newPipe }), { success: 'Pipeline created' }); if (p) { setNewPipe(''); setPid(p.id); reload(); } }}>
            <input aria-label="New pipeline name" placeholder="New pipeline name" value={newPipe} onChange={(e) => setNewPipe(e.target.value)} required style={{ width: 200 }} />
            <Button type="submit" className="sm" busy={busy}>Add pipeline</Button>
          </form>
        </div>
        <div className="row" role="tablist" aria-label="Pipelines">
          {data.pipelines.map((p) => <button key={p.id} role="tab" aria-selected={p.id === pipe.id} className={`btn sm ${p.id === pipe.id ? 'primary' : ''}`} onClick={() => setPid(p.id)}>{p.name}</button>)}
        </div>
        <hr />
        <div className="row">
          <button className="btn sm" onClick={() => { const n = window.prompt('Rename pipeline', pipe.name); if (n) run(() => patch(`/pipelines/${pipe.id}`, { name: n }).then(reload), { success: 'Renamed' }); }}>Rename “{pipe.name}”</button>
          {data.pipelines.length > 1 && <button className="btn sm" onClick={() => run(() => api(`/pipelines/${pipe.id}`, { method: 'DELETE' }).then(() => { setPid(null); reload(); }), { success: 'Pipeline deleted' })}>Delete pipeline</button>}
        </div>
        <h3 style={{ marginTop: 14 }}>Stages</h3>
        <ol className="stack" style={{ paddingLeft: 0, listStyle: 'none' }}>
          {stages.map((s, i) => (
            <li key={s.id} className="card" style={{ padding: 10 }}>
              <div className="row">
                <span className="muted small" aria-hidden>{i + 1}.</span>
                <strong style={{ flex: '1 1 140px' }}>{s.name}</strong>
                <Badge tone={s.kind === 'won' ? 'ok' : s.kind === 'lost' ? 'muted' : 'info'} plain>{s.kind}</Badge>
                <span className="small muted">{s.opp_count} opp.</span>
                {s.required_fields.length > 0 && <span className="small">Requires: {s.required_fields.map((k) => reqOptions.find((o) => o.key === k)?.label || k).join(', ')}</span>}
                <span style={{ flex: 1 }} />
                <button className="btn sm" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn sm" aria-label={`Move ${s.name} down`} disabled={i === stages.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn sm" onClick={() => setStageEdit(s)}>Edit</button>
                <button className="btn sm" onClick={() => setDelStage(s)}>Delete</button>
              </div>
            </li>
          ))}
        </ol>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => post(`/pipelines/${pipe.id}/stages`, newStage), { success: 'Stage added' }); if (ok) { setNewStage({ name: '', kind: 'open' }); reload(); } }}>
          <input aria-label="New stage name" placeholder="New stage name" value={newStage.name} onChange={(e) => setNewStage({ ...newStage, name: e.target.value })} required style={{ maxWidth: 220 }} />
          <select aria-label="Stage type" value={newStage.kind} onChange={(e) => setNewStage({ ...newStage, kind: e.target.value })} style={{ width: 'auto' }}><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select>
          <Button type="submit" busy={busy}>Add stage</Button>
        </form>
      </section>

      <section className="card">
        <div className="card-header"><h2>Custom fields</h2><button className="btn primary sm" onClick={() => setFieldModal({ pipelineId: pipe.id })}>+ Add field</button></div>
        <p className="muted small">Fields appear on forms and detail pages immediately. Opportunity fields can be limited to one pipeline, so different pipelines show different fields while sharing the same contact information.</p>
        <Table caption="Custom fields" rows={data.fields} empty="No custom fields yet." columns={[
          { key: 'label', label: 'Field', render: (f) => <div><strong>{f.label}</strong><div className="tiny muted mono">{f.key}</div></div> },
          { key: 'entity', label: 'Applies to', render: (f) => (f.entity === 'opportunity' ? `Opportunities — ${f.pipeline_id ? data.pipelines.find((p) => p.id === f.pipeline_id)?.name : 'all pipelines'}` : f.entity === 'contact' ? 'Contacts' : 'Companies') },
          { key: 'type', label: 'Type', render: (f) => <span>{f.type}{f.options.length ? ` (${f.options.join(', ')})` : ''}</span> },
          { key: 'act', label: '', render: (f) => <div className="row" style={{ gap: 4 }}><button className="btn sm" onClick={() => setFieldModal({ field: f })}>Edit</button><button className="btn sm" onClick={() => { if (window.confirm(`Delete "${f.label}"? Its stored values will be removed from all records.`)) run(() => api(`/fields/${f.id}`, { method: 'DELETE' }).then(reload), { success: 'Field deleted' }); }}>Delete</button></div> },
        ]} />
      </section>

      {stageEdit && <StageModal stage={stageEdit} options={reqOptions} onClose={() => setStageEdit(null)} onDone={reload} />}
      {delStage && <DeleteStageModal stage={delStage} stages={stages} onClose={() => setDelStage(null)} onDone={reload} />}
      {fieldModal && <FieldModal {...fieldModal} pipelines={data.pipelines} onClose={() => setFieldModal(null)} onDone={reload} />}
    </div>
  );
}

function StageModal({ stage, options, onClose, onDone }) {
  const [f, setF] = useState({ name: stage.name, kind: stage.kind, requiredFields: stage.required_fields });
  const [run, busy] = useAction();
  return (
    <Modal title={`Edit stage “${stage.name}”`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => patch(`/stages/${stage.id}`, f), { success: 'Stage saved' }); if (ok) { onDone(); onClose(); } }}>
        <Field label="Name">{(a) => <input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />}</Field>
        <Field label="Type" help="Won/Lost stages are excluded from open pipeline value">{(a) => <select {...a} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select>}</Field>
        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
          <legend className="label-text">Required before entering this stage</legend>
          {options.map((o) => <label key={o.key} className="check"><input type="checkbox" checked={f.requiredFields.includes(o.key)} onChange={(e) => setF({ ...f, requiredFields: e.target.checked ? [...f.requiredFields, o.key] : f.requiredFields.filter((k) => k !== o.key) })} /> {o.label}</label>)}
        </fieldset>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function DeleteStageModal({ stage, stages, onClose, onDone }) {
  const [moveTo, setMoveTo] = useState('');
  const [run, busy] = useAction();
  const others = stages.filter((s) => s.id !== stage.id);
  return (
    <Modal title={`Delete stage “${stage.name}”`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => api(`/stages/${stage.id}${moveTo ? `?moveTo=${moveTo}` : ''}`, { method: 'DELETE' }), { success: (r) => `Stage deleted${r.moved ? ` — ${r.moved} opportunit${r.moved === 1 ? 'y' : 'ies'} moved` : ''}` }); if (ok) { onDone(); onClose(); } }}>
        {stage.opp_count > 0 ? (
          <>
            <div className="notice warn">This stage contains {stage.opp_count} opportunit{stage.opp_count === 1 ? 'y' : 'ies'}. Choose where to move them — nothing will be lost.</div>
            <Field label="Move them to">{(a) => <select {...a} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} required><option value="">Choose a stage…</option>{others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
          </>
        ) : <p>This stage is empty and can be deleted safely.</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="danger" busy={busy}>Delete stage</Button></div>
      </form>
    </Modal>
  );
}

function FieldModal({ field, pipelineId, pipelines, onClose, onDone }) {
  const [f, setF] = useState(field ? { label: field.label, options: field.options.join(', ') } : { entity: 'opportunity', label: '', type: 'text', options: '', pipelineId: pipelineId || '' });
  const [run, busy] = useAction();
  const submit = async (e) => {
    e.preventDefault();
    const options = f.options ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined;
    const ok = await run(() => (field
      ? patch(`/fields/${field.id}`, { label: f.label, options: field.type === 'dropdown' ? options : undefined })
      : post('/fields', { entity: f.entity, label: f.label, type: f.type, options: f.type === 'dropdown' ? options : undefined, pipelineId: f.entity === 'opportunity' && f.pipelineId ? f.pipelineId : null })), { success: 'Field saved' });
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal title={field ? `Edit field “${field.label}”` : 'Add custom field'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!field && <Field label="Record type">{(a) => <select {...a} value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}><option value="opportunity">Opportunity</option><option value="contact">Contact</option><option value="company">Company</option></select>}</Field>}
        <Field label="Field name">{(a) => <input {...a} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required autoFocus maxLength={60} />}</Field>
        {!field && <Field label="Type">{(a) => <select {...a} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="dropdown">Dropdown</option><option value="checkbox">Checkbox</option></select>}</Field>}
        {(field ? field.type === 'dropdown' : f.type === 'dropdown') && <Field label="Options" help="Comma separated">{(a) => <input {...a} value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} required />}</Field>}
        {!field && f.entity === 'opportunity' && <Field label="Show in pipeline">{(a) => <select {...a} value={f.pipelineId} onChange={(e) => setF({ ...f, pipelineId: e.target.value })}><option value="">All pipelines</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name} only</option>)}</select>}</Field>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Save field</Button></div>
      </form>
    </Modal>
  );
}
