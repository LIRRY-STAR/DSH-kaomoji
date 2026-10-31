#!/usr/bin/env node
/**
 * 从 kaomoji-collection 的原始 kaomoji.json 生成本插件的精选情绪词库。
 *
 * 源包: kaomoji-collection@1.0.0 (MIT), 内容源自 kaomojiya.org (免费使用)
 * 用法: node scripts/build-catalog.mjs [源 kaomoji.json 路径]
 *
 * 设计取舍:
 * - 每桶有上限, 只留"可读 + 短 + 不含 emoji"的条目, 避免生僻乱码和超长脸
 * - 采样用固定 seed, 同一份源数据重复跑结果一致, 方便 diff
 * - 只产数据, 不塞进插件代码里; index.js 运行时读 JSON
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const SRC = resolve(process.argv[2]
  || 'C:/Users/mechrevo/AppData/Local/Temp/kaomoji-src/package/kaomoji.json')
const OUT = join(PLUGIN_ROOT, 'data', 'catalog.json')

const PER_BUCKET = 110
const MIN_LEN = 3
const MAX_LEN = 26
const SEED = 20261029

// 情绪桶 -> kaomoji-collection 的类别名(罗马字日文)
const BUCKETS = [
  { id: 'cute', label: '可爱', hint: '撒娇卖萌、动物系',
    categories: ['cute', 'cat', 'dog', 'rabbit', 'animal', 'kuma', 'kitsune', 'tanuki',
      'momonga', 'pengin', 'hiyoko', 'ahiru', 'azarashi', 'kamome', 'kurage', 'nyaa',
      'kitty', 'mofumofu', 'fuwafuwa', 'momimomi', 'mochimochi', 'munimuni',
      'nikukyuu', 'hamusutaa', 'pugyaa', 'shisa'] },
  { id: 'happy', label: '开心', hint: '高兴、雀跃、夸赞',
    categories: ['smile', 'happy', 'yorokobu', 'yatta', 'sumairu', 'ahaha', 'nikkori',
      'niconico', 'kirakira', 'wakuwaku', 'ukiuki', 'tanoshii', 'saikou', 'iine',
      'yeay', 'weei', 'yossha', 'nichaa', 'fufufu', 'bakushou', 'waai', 'goo'] },
  { id: 'love', label: '心动', hint: '喜欢、好感、贴贴',
    categories: ['love', 'heart', 'meromero', 'dokidoki', 'kyun', 'kyururun', 'zukyun',
      'chu', 'kiss', 'ichaicha', 'nadenade', 'dakitsuku', 'gyu', 'hug', 'kando',
      'urayamashii'] },
  { id: 'shy', label: '害羞', hint: '不好意思、脸红',
    categories: ['shy', 'hazukashii', 'niyaniya', 'peropero', 'uhuhu', 'ehehe'] },
  { id: 'playful', label: '俏皮', hint: '得瑟、调皮、嘴硬',
    categories: ['tehe', 'tehepero', 'tobokeru', 'hengao', 'gyaru', 'otaku', 'aho',
      'waruikao', 'ehhen', 'doya', 'muhuhu', 'kerakera', 'kusukusu', 'tension-takai'] },
  { id: 'sad', label: '难过', hint: '低落、失落、丧',
    categories: ['sad', 'shun', 'shonbori', 'gakkari', 'shinpai', 'fuan', 'zawazawa',
      'tameiki', 'tsurai', 'sabishii', 'ijikeru', 'kuyashii', 'oteage', 'shinikake',
      'shindoi'] },
  { id: 'cry', label: '大哭', hint: '泪目、委屈、破防',
    categories: ['cry', 'nakiwarai', 'happy-tears', 'uruuru', 'pien', 'uwaan', 'gyaa'] },
  { id: 'angry', label: '生气', hint: '不爽、吐槽、炸毛',
    categories: ['angry', 'mukatsuku', 'mukimuki', 'punpun', 'iraira', 'gao', 'abareru',
      'oraora', 'gununu', 'oko', 'bishi', 'tsuntsun', 'suneru', 'fukurettsura', 'iyan'] },
  { id: 'surprised', label: '惊讶', hint: '震惊、傻眼、意外',
    categories: ['surprise', 'shock', 'pokaan', 'hah', 'nandato', 'gakuburu', 'gyapi',
      'buwaa', 'obieru', 'kyaa', 'hawawa', 'dokodoko', 'gaa', 'donbiki', 'chiin'] },
  { id: 'confused', label: '困惑', hint: '无语、懵、看不懂',
    categories: ['komaru', 'wakaranai', 'nayamu', 'hatena', 'gimon', 'kyorokyoro',
      'shobon', 'yareyare', 'atamakakaeru', 'pasokon', 'uun', 'jii', 'jitome'] },
  { id: 'encourage', label: '鼓励', hint: '加油、打气、安慰',
    categories: ['fight', 'ganbaru', 'ouen', 'genki', 'good-job', 'yoshiyoshi', 'banzai',
      'furefure', 'sugoi', 'erai', 'kakkoii'] },
  { id: 'thanks', label: '感谢', hint: '谢谢、道谢',
    categories: ['thanks', 'azasu', 'orei', 'yoroshiku', 'douzo', 'gochisousama',
      'itadakimasu'] },
  { id: 'sorry', label: '道歉', hint: '抱歉、认错、讨好',
    categories: ['sorry', 'sumimasen', 'moushiwakenai', 'ayamaru', 'dogeza'] },
  { id: 'greeting', label: '问候', hint: '打招呼、告别、日常寒暄',
    categories: ['aisatsu', 'good-morning', 'good-night', 'konbanwa', 'itterasshai',
      'ittekimasu', 'tadaima', 'okaeri', 'matane', 'byebye', 'sayounara', 'otsukaresama',
      'odaijini'] },
]

const BRACKET_RE = /[()（）\[\]【】｢｣〈〉<>]/
const ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z]+);/i
const PICTO_RE = /\p{Extended_Pictographic}/u
const CONTROL_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/

function unescapeEntities(s) {
  return s
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 一条候选是否值得进词库 */
function accept(s) {
  if (typeof s !== 'string') return false
  if (s.length < MIN_LEN || s.length > MAX_LEN) return false
  if (CONTROL_RE.test(s)) return false
  if (ENTITY_RE.test(s)) return false      // unescape 之后还残留实体 = 源数据坏了
  if (PICTO_RE.test(s)) return false       // emoji 混进来就不像颜文字了
  if (!BRACKET_RE.test(s)) return false    // 至少要有括号, 挡掉 ☺︎ / ⑅◡̈* 这类碎片
  // 括号内至少一个可见字符, 挡掉 ( ) (()) 这种空壳
  const inner = s.replace(/[()（）\[\]【】｢｣〈〉<>\s·・.。,，]/g, '')
  if ([...inner].length < 1) return false
  // 纯 ASCII 表情太土, 挡掉 -_- ;) 之类
  if (!/[^\x00-\x7f]/.test(s)) return false
  return true
}

/** 固定种子的 PRNG, 保证可复现 */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function main() {
  const raw = JSON.parse(readFileSync(SRC, 'utf8'))
  const rand = mulberry32(SEED)
  const missing = []
  const buckets = {}
  const report = []

  for (const bucket of BUCKETS) {
    const seen = new Set()
    const kept = []
    let pulled = 0
    for (const cat of bucket.categories) {
      const list = raw[cat]
      if (!Array.isArray(list)) { missing.push(`${bucket.id}:${cat}`); continue }
      pulled += list.length
      for (const entry of list) {
        if (typeof entry !== 'string') continue
        const s = unescapeEntities(entry).replace(/\s+/g, ' ').trim()
        if (!accept(s) || seen.has(s)) continue
        seen.add(s)
        kept.push(s)
      }
    }
    // Fisher-Yates, 再按长度/字典序排一次让结果稳定
    for (let i = kept.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[kept[i], kept[j]] = [kept[j], kept[i]]
    }
    const picked = kept.slice(0, PER_BUCKET).sort()
    buckets[bucket.id] = { label: bucket.label, hint: bucket.hint, items: picked }
    report.push(`${bucket.id.padEnd(10)} src=${String(pulled).padStart(6)}  valid=${String(kept.length).padStart(5)}  kept=${String(picked.length).padStart(3)}`)
  }

  const total = Object.values(buckets).reduce((n, b) => n + b.items.length, 0)
  const doc = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'kaomoji-collection@1.0.0 (MIT) / kaomojiya.org',
    note: '每个情绪桶的候选; 由 scripts/build-catalog.mjs 生成, 手改会被覆盖',
    buckets,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8')

  console.log(report.join('\n'))
  console.log(`\ntotal=${total}  buckets=${Object.keys(buckets).length}  -> ${OUT}`)
  if (missing.length) console.log(`missing categories(${missing.length}): ${missing.join(' ')}`)
}

main()
