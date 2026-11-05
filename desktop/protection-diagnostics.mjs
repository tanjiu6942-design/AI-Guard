export async function collectProtectionDiagnostics({ controller, guard }) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const [p, g] = await Promise.allSettled([controller('proxies'), guard.status()]);
        const groups = {};
        if (p.status === 'fulfilled') for (const [name, value] of Object.entries(p.value?.proxies || {})) {
          if (!name.startsWith('AI Guard')) continue;
          groups[name] = { type: value.type, now: value.now, count: value.all?.length, alive: value.alive };
        }
        return { groups, controllerAvailable: p.status === 'fulfilled', guard: g.status === 'fulfilled'
          ? { locked: g.value.locked, complete: g.value.complete, filterCount: g.value.filterCount }
          : { unavailable: true } };
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 2500); }),
    ]);
  } finally { clearTimeout(timer); }
}
