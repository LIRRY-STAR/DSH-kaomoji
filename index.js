/**
 * dsh-kaomoji-pool — 本地颜文字库 + 去重采样
 *
 * 为什么要有这个插件：
 * 模型每次「随手写」颜文字，都会从训练里最熟的那几句开始挑，于是同一个会话里
 * 反复出现 (๑•̀ㅂ•́)و✧、(≧▽≦) 这一小撮。问题不在词库里没词，而在生成时的采样偏好。
 * 所以这里把「取词」从生成里拆出来：一个带磁盘记忆的工具，自动跳过最近用过的条目。
 *
 * 设计：
 * - 词库是构建产物（scripts/build-catalog.mjs 生成），运行时只读，插件零外部依赖
 * - 状态落在 <DSH_HOME>/storages/kaomoji-pool/state.json，只存「用过哪些」，不存配置
 * - 每次取词会从「最久没用」的候选里随机挑，既不复读也不会永远固定顺序
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'kaomoji-pool'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_PATH = join(HERE, 'data', 'catalog.json')

const DEFAULTS = {
  defaultCount: 5,   // 不传 count 时返回几条
  maxCount: 20,      // 单次上限
  historySize: 600,  // 磁盘保留条数 = 参与去重的窗口
  prompt: true,      // 是否注入 systemPrompt 使用说明
}

function loadCatalog() {
  try {
    const doc = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
    if (!doc || typeof doc.buckets !== 'object' || doc.buckets === null) {
      throw new Error('结构不对：缺少 buckets')
    }
    return doc
  } catch (error) {
    throw new Error(`[kaomoji-pool] 词库读取失败 ${CATALOG_PATH}: ${error.message}`)
  }
}

const CATALOG = loadCatalog()
const BUCKET_IDS = Object.keys(CATALOG.buckets)

const GUIDANCE = [
  '<kaomoji-pool>',
  '要颜文字时调用 kaomoji 工具取候选，别凭记忆顺手写——凭记忆挑出来的永远是那几句。',
  '- mood 按语气选：cute 可爱撒娇 / happy 开心 / love 心动贴贴 / shy 害羞 / playful 俏皮嘴硬 / sad 难过 / cry 委屈破防 / angry 吐槽炸毛 / surprised 惊讶 / confused 无语 / encourage 打气 / thanks 感谢 / sorry 道歉 / greeting 问候',
  '- 工具会自动避开最近用过的条目，返回的候选可以直接用，不用再筛。',
  '- 一条消息放 1-2 个就够，别堆。',
  '</kaomoji-pool>',
].join('\n')

/** 状态文件：<DSH_HOME>/storages/kaomoji-pool/state.json */
function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'kaomoji-pool', 'state.json')
}

function readState(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (doc && Array.isArray(doc.history)) {
      const history = doc.history.filter((row) => row && typeof row.k === 'string')
      return { version: 1, history }
    }
  } catch {
    // 首次运行、文件还没建、或者被写坏了 —— 都从空历史开始，不拦路
  }
  return { version: 1, history: [] }
}

function writeState(file, state, historySize) {
  const history = state.history.slice(-historySize)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), history }),
    'utf8',
  )
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
  }
  return list
}

/** 把目标桶的候选分成「最近没用过」和「最近用过」两组，各按最久未用排序 */
function collect(bucketIds, state, historySize) {
  const history = state.history
  const recent = new Set(history.slice(-historySize).map((row) => row.k))
  const lastSeenAt = new Map()
  history.forEach((row, index) => lastSeenAt.set(row.k, index))

  const seen = new Set()
  const fresh = []
  const stale = []
  for (const id of bucketIds) {
    const bucket = CATALOG.buckets[id]
    if (!bucket || !Array.isArray(bucket.items)) continue
    for (const item of bucket.items) {
      if (seen.has(item)) continue
      seen.add(item)
      const row = { k: item, b: id, last: lastSeenAt.has(item) ? lastSeenAt.get(item) : -1 }
      if (recent.has(item)) stale.push(row)
      else fresh.push(row)
    }
  }
  const byAge = (a, b) => a.last - b.last
  fresh.sort(byAge)
  stale.sort(byAge)
  return { fresh, stale }
}

/**
 * 取 count 条：优先给「没出现过 / 最久没用」的，不够再从用过的里按 LRU 补。
 * 从前 2×count 条里洗牌，既保证新鲜度，又不至于每次都是固定那几条打头。
 */
function pick(bucketIds, count, state, historySize) {
  const { fresh, stale } = collect(bucketIds, state, historySize)
  const chosen = []

  const fromFresh = Math.min(fresh.length, count)
  if (fromFresh > 0) {
    const window = Math.min(fresh.length, Math.max(fromFresh * 2, fromFresh))
    chosen.push(...shuffleInPlace(fresh.slice(0, window)).slice(0, fromFresh))
  }
  if (chosen.length < count && stale.length > 0) {
    const need = count - chosen.length
    const window = Math.min(stale.length, Math.max(need * 2, need))
    chosen.push(...shuffleInPlace(stale.slice(0, window)).slice(0, need))
  }
  return chosen
}

function remember(state, picked) {
  const now = Date.now()
  for (const row of picked) state.history.push({ k: row.k, t: now, b: row.b })
  return state
}

function formatList(rows) {
  const width = String(rows.length).length
  return rows
    .map((row, index) => {
      const no = String(index + 1).padStart(width)
      return `${no}. ${row.kaomoji}   [${row.bucket} ${row.bucketLabel}]`
    })
    .join('\n')
}

const MOOD_DOC = BUCKET_IDS
  .map((id) => `${id} ${CATALOG.buckets[id].label}`)
  .join(' / ')

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const file = statePath()

  ctx.tools.register({
    name: 'kaomoji',
    description: [
      '从本地颜文字库取「最近没出现过」的候选，用来避免翻来覆去只用那几句。',
      `mood 选情绪桶：${MOOD_DOC}。不传就随机挑一个桶。`,
      '返回结果按桶标注，可以直接用；一条消息 1-2 个即可。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        mood: {
          type: 'string',
          description: `情绪桶：${MOOD_DOC}。不传则随机。`,
          enum: BUCKET_IDS,
        },
        count: {
          type: 'number',
          description: `返回几条候选，默认 ${DEFAULTS.defaultCount}，上限 ${DEFAULTS.maxCount}`,
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        if (!value || !Array.isArray(value.items) || value.items.length === 0) {
          return [{ type: 'text', text: '（这个词库是空的，检查 data/catalog.json）' }]
        }
        return [{ type: 'text', text: formatList(value.items) }]
      },
    },
    async execute(args) {
      const count = clampInt(args?.count, 1, cfg.maxCount, cfg.defaultCount)
      const mood = typeof args?.mood === 'string' ? args.mood.trim().toLowerCase() : ''
      const buckets = CATALOG.buckets[mood] ? [mood] : [BUCKET_IDS[Math.floor(Math.random() * BUCKET_IDS.length)]]

      const state = readState(file)
      const picked = pick(buckets, count, state, cfg.historySize)
      remember(state, picked)
      writeState(file, state, cfg.historySize)

      return {
        mood: buckets,
        count: picked.length,
        items: picked.map((row) => ({
          kaomoji: row.k,
          bucket: row.b,
          bucketLabel: CATALOG.buckets[row.b]?.label ?? row.b,
        })),
      }
    },
  })

  ctx.tools.register({
    name: 'kaomoji_stats',
    description: '查看本地颜文字库用量：每个情绪桶有多少条、已经用过多少条、最近用过哪些。排查「怎么总给我同几句」时用。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        const lines = value.buckets.map((row) =>
          `${row.id.padEnd(10)} ${String(row.total).padStart(4)} 条  用过 ${String(row.used).padStart(4)}`,
        )
        lines.push('')
        lines.push(`累计取词 ${value.totalPicks} 次，记录窗口 ${value.historySize} 条`)
        if (value.recent.length > 0) {
          lines.push('最近用过：')
          lines.push(...value.recent.map((row) => `  ${row.kaomoji}  [${row.bucket}]`))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const state = readState(file)
      const used = new Map()
      for (const row of state.history) used.set(row.b, (used.get(row.b) ?? 0) + 1)

      const buckets = BUCKET_IDS.map((id) => ({
        id,
        label: CATALOG.buckets[id].label,
        total: CATALOG.buckets[id].items.length,
        used: used.get(id) ?? 0,
      }))

      return {
        buckets,
        totalPicks: state.history.length,
        historySize: cfg.historySize,
        recent: state.history.slice(-8).reverse().map((row) => ({ kaomoji: row.k, bucket: row.b })),
      }
    },
  })

  if (cfg.prompt) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      ctx.effect(() =>
        systemPrompt.section({
          name: 'kaomoji-pool:guidance',
          order: 177,
          text: GUIDANCE,
        }),
      )
    }
  }
}
