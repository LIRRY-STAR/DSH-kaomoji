/**
 * 冒烟测试：不需要真跑 Host，用最小 ctx 桩把 apply() 拉起来，
 * 验证「取词不重复 / 参数钳制 / 状态落盘 / 统计可用」四件事。
 *   node scripts/smoke.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'kaomoji-smoke-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

function mount(config) {
  const tools = new Map()
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    get: () => undefined,
    effect: (fn) => fn(),
  }
  apply(ctx, config)
  return tools
}

try {
  const tools = mount({ historySize: 600, defaultCount: 5 })
  assert.ok(tools.has('kaomoji'), '缺少 kaomoji 工具')
  assert.ok(tools.has('kaomoji_stats'), '缺少 kaomoji_stats 工具')

  const kaomoji = tools.get('kaomoji')

  // 1. 指定桶 + 条数
  const first = await kaomoji.execute({ mood: 'cute', count: 5 })
  assert.equal(first.items.length, 5, 'count=5 应返回 5 条')
  for (const item of first.items) assert.equal(item.bucket, 'cute')
  assert.ok(first.items.every((item) => typeof item.kaomoji === 'string' && item.kaomoji.length > 0))

  // 2. 连打 20 轮 × 5 条 = 100 条，桶里 110 条，应当一条都不重
  const unique = new Set(first.items.map((item) => item.kaomoji))
  for (let round = 0; round < 19; round++) {
    const res = await kaomoji.execute({ mood: 'cute', count: 5 })
    for (const item of res.items) unique.add(item.kaomoji)
  }
  assert.equal(unique.size, 100, `100 次取词应完全去重，实际只有 ${unique.size} 条不同`)

  // 3. 未知 mood 回落到随机桶，不报错
  const wild = await kaomoji.execute({ mood: 'not-a-bucket', count: 3 })
  assert.equal(wild.items.length, 3)

  // 4. count 钳制
  assert.equal((await kaomoji.execute({ mood: 'happy', count: 999 })).items.length, 20)
  assert.equal((await kaomoji.execute({ mood: 'happy', count: 0 })).items.length, 1)
  assert.equal((await kaomoji.execute({ mood: 'happy' })).items.length, 5)

  // 5. 状态落盘
  const stateFile = join(home, 'storages', 'kaomoji-pool', 'state.json')
  assert.ok(existsSync(stateFile), '状态文件没写出来')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(Array.isArray(state.history) && state.history.length >= 100)
  assert.ok(state.history.every((row) => typeof row.k === 'string' && typeof row.t === 'number'))

  // 6. 统计工具
  const stats = tools.get('kaomoji_stats')
  const report = await stats.execute()
  assert.equal(report.buckets.length, 14)
  assert.ok(report.totalPicks >= 100)
  assert.ok(report.buckets.every((row) => row.total > 0))

  // 7. render 出的是文本块
  const rendered = kaomoji.output.render({}, first)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.split('\n').length === 5)

  // 8. historySize 调很小也不崩（走到「用过的里补」分支）
  const small = mount({ historySize: 8, defaultCount: 5 })
  for (let round = 0; round < 10; round++) {
    const res = await small.get('kaomoji').execute({ mood: 'sorry', count: 5 })
    assert.equal(res.items.length, 5)
  }
  const smallState = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(smallState.history.length <= 8, 'historySize=8 但历史没被裁剪')

  console.log('SMOKE OK — 去重 / 钳制 / 落盘 / 统计 / 降级 全部通过')
} finally {
  rmSync(home, { recursive: true, force: true })
}
