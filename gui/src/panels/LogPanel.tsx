import { useEffect, useState } from 'react';
import { api } from '../ipc';

export function LogPanel() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const l = await api.logs(100);
        if (alive) setLines(l);
      } catch { /* 内核未启动时忽略 */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <section className="card">
      <h2>内核日志</h2>
      <pre className="log">{lines.join('\n') || '暂无日志'}</pre>
    </section>
  );
}
