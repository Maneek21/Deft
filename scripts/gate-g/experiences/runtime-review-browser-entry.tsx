import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeAppInputReview, type RuntimeReviewIdentity } from '../../../apps/web/src/components/runtime-app-input-review';

function Fixture() {
  const [bindingId, setBindingId] = useState('binding-one');
  const [reviewed, setReviewed] = useState<RuntimeReviewIdentity | null>(null);
  const ready = reviewed?.runId === 'run-one' && reviewed.bindingId === bindingId;
  return <main className="shell">
    <div className="eyebrow">Runtime App action</div>
    <h1>Create shipping label</h1>
    <p>Review the exact input before approving this external write.</p>
    <RuntimeAppInputReview runId="run-one" bindingId={bindingId} busy={false} onReviewed={setReviewed} />
    <div className="controls">
      <button type="button" id="approve" disabled={!ready}>Approve Runtime action</button>
      <button type="button" id="change-binding" onClick={() => setBindingId('binding-two')}>Change binding</button>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
