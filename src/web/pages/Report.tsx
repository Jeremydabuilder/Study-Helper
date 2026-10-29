import { useState } from 'react';
import { ApiError, post } from '../api';
import { ErrorBox, Field, Modal } from '../ui';

/** "Report a problem". Nothing from the student's account is attached automatically: anything they add is shown back to them before it is sent. */
export function ReportProblem({ label = 'Report a problem' }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return <><button className="linklike" onClick={() => setOpen(true)}>{label}</button>{open && <ReportModal onClose={() => setOpen(false)} />}</>;
}

function ReportModal({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState(''); const [attach, setAttach] = useState('');
  const [preview, setPreview] = useState<any>(null); const [sent, setSent] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  const body = () => ({ message, ...(attach.trim() ? { attach: { kind: 'text you chose to share', text: attach } } : {}) });
  const run = async (confirmed: boolean) => {
    setBusy(true); setErr(null);
    try { const r = await post('/report', { ...body(), confirmed, previewOnly: !confirmed }); if (r.sent) setSent(true); else setPreview(r.preview); }
    catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <Modal title="Report a problem" onClose={onClose}>
      {sent ? <><p role="status">Thank you. Your report was sent to the person running this pilot.</p><button className="btn primary" onClick={onClose}>Close</button></> : preview ? (
        <>
          <p className="small muted">This is exactly what will be sent. Nothing else from your account is included.</p>
          <div className="card"><strong>Message</strong><p style={{ whiteSpace: 'pre-wrap' }}>{preview.message}</p>{preview.attachment && <><strong>Text you chose to include</strong><blockquote className="quote" style={{ whiteSpace: 'pre-wrap' }}>{preview.attachment.text}</blockquote></>}</div>
          {err && <ErrorBox error={err} />}
          <div className="row"><button className="btn primary" disabled={busy} onClick={() => run(true)}>{busy ? 'Sending…' : 'Send this'}</button><button className="btn" onClick={() => setPreview(null)}>Edit</button></div>
        </>
      ) : (
        <>
          <Field label="What went wrong?" hint="For example: a question looked wrong, grading seemed unfair, something would not load."><textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} maxLength={2000} /></Field>
          <Field label="Anything you want to show us (optional)" hint="Paste a question or message if it helps. You will see it again before it is sent."><textarea value={attach} onChange={(e) => setAttach(e.target.value)} rows={3} maxLength={4000} /></Field>
          {err && <ErrorBox error={err} />}
          <div className="row mt-s"><button className="btn primary" disabled={busy || message.trim().length < 5} onClick={() => run(false)}>Preview</button><button className="btn" onClick={onClose}>Cancel</button></div>
        </>
      )}
    </Modal>
  );
}
