export async function waitFor(cond: () => boolean, ms = 8000, step = 50): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor 超时')
    await new Promise(r => setTimeout(r, step))
  }
}
