import { useState } from 'react';
import { api, type CheckResult } from '../ipc';

const LABEL: Record<string, string> = {
  ok: '通过', fail: '失败', warn: '警告', unknown: '未知',
};

export function DoctorPanel() {
  const [items, setItems] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      setItems(await api.doctor());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="row">
        <h2>检测项</h2>
        <button onClick={run} disabled={busy}>
          {busy ? '检测中…' : '检测'}
        </button>
      </div>
      {!items && <p className="hint">点击「检测」运行六项体检</p>}
      <ul className="checks">
        {items?.map((i) => (
          <li key={i.key}>
            <span className={`badge ${i.state}`}>{LABEL[i.state]}</span>
            <strong>{i.title}</strong>
            <span className="detail">{i.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
