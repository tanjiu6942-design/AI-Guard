import type { Status } from '../ipc';

interface Props {
  status: Status | null;
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`dot ${ok ? 'ok' : 'bad'}`} />;
}

export function StatusPanel({ status }: Props) {
  if (!status) return <section className="card">加载中…</section>;

  return (
    <section className="card">
      <h2>状态</h2>
      <dl>
        <dt>出口 IP</dt>
        <dd>
          {status.exitIp ?? '未知'}
          {status.exitCountry ? ` (${status.exitCountry})` : ''}
        </dd>
        <dt>模式</dt>
        <dd>{status.mode === 'strict' ? '严格' : '精确'}</dd>
        <dt>内核</dt>
        <dd>
          <Dot ok={status.running} />
          {status.running ? '运行中' : '已停止'}
        </dd>
        <dt>TUN</dt>
        <dd>{status.tunEnabled ? '已接管' : '未启用'}</dd>
      </dl>
    </section>
  );
}
