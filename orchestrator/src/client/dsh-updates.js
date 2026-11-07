// dsh 桌面端更新加锁会 await 所有已接入请求结束，installing 阶段要先断开并暂停
// 流式连接，离开 installing 再恢复；普通浏览器没有 dshDesktop.updates，保持无副作用。
let installing = false
let stopUpdates = null
const consumers = new Set()

export const updateInstalling = () => installing
export const subscribeUpdatePause = (pause, resume) => {
  const consumer = { pause, resume }
  consumers.add(consumer)
  if (!stopUpdates) {
    const updates = globalThis.dshDesktop?.updates
    if (updates) stopUpdates = updates.subscribe(event => {
      const next = event.phase === 'installing'
      if (next === installing) return
      installing = next
      for (const other of consumers) (next ? other.pause : other.resume)()
    })
  }
  if (installing) pause()
  return () => {
    consumers.delete(consumer)
    if (consumers.size === 0) { installing = false; stopUpdates?.(); stopUpdates = null }
  }
}
