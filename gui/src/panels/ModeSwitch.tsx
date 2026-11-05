import { api } from '../ipc';

interface Props {
  mode: 'strict' | 'precise';
  onChange: () => void;
}

export function ModeSwitch({ mode, onChange }: Props) {
  async function pick(next: 'strict' | 'precise') {
    if (next === mode) return;
    await api.setMode(next);
    onChange();
  }

  return (
    <section className="card">
      <h2>分流模式</h2>
      <div className="segmented">
        <button
          className={mode === 'strict' ? 'active' : ''}
          onClick={() => pick('strict')}
        >
          严格
        </button>
        <button
          className={mode === 'precise' ? 'active' : ''}
          onClick={() => pick('precise')}
        >
          精确
        </button>
      </div>
      <p className="hint">
        {mode === 'strict'
          ? 'Cloudflare 全家桶走独享 IP，出口绝对一致，防封最强。流量消耗较高。'
          : '仅 AI 主域名走独享 IP，省流量。注意：Cloudflare 新子域可能走错出口。'}
      </p>
    </section>
  );
}
