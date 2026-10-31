# dsh-kaomoji-pool

给 DeepSeek Harness 用的本地颜文字库。核心不是「有词」，而是**取词时会躲开最近用过的**——同一个会话里不会翻来覆去只剩那几句。

## 为什么不是靠提示词

模型每次随手写颜文字，都是从训练里最熟的几个开始挑。给它一份白名单，它照样只从白名单里最熟的那几个挑。所以这里把取词拆出来变成一个带磁盘记忆的工具：

- 词库是构建产物，插件运行时只读，零外部依赖
- 每次取词从「最久没用」的候选里随机挑，既不复读，也不会固定顺序
- 用完就落盘，跨回合、跨会话都记得

## 工具

### `kaomoji(mood?, count?)`

按情绪桶取候选，返回按桶标注的列表。

| mood | 含义 | mood | 含义 |
| --- | --- | --- | --- |
| `cute` | 可爱撒娇 | `angry` | 吐槽炸毛 |
| `happy` | 开心 | `surprised` | 惊讶 |
| `love` | 心动贴贴 | `confused` | 无语困惑 |
| `shy` | 害羞 | `encourage` | 打气 |
| `playful` | 俏皮嘴硬 | `thanks` | 感谢 |
| `sad` | 难过 | `sorry` | 道歉 |
| `cry` | 委屈破防 | `greeting` | 问候 |

- `mood` 不传则随机挑一个桶。
- `count` 默认 5，上限 20。返回的全部会记进「用过」窗口，所以拿多几条不浪费。

### `kaomoji_stats()`

看每个桶有多少条、用过多少、最近用过哪些。怀疑「是不是又绕回那几句」时先看它。

## 状态与配置

使用记录写 `<DSH_HOME>/storages/kaomoji-pool/state.json`（`DSH_HOME` 缺省为 `~/.dsh`），只存条目字符串和时间戳，删掉即重置。

挂载时可选配置：

```yaml
- id: kaomoji-pool
  name: dsh-kaomoji-pool
  config:
    defaultCount: 5   # 不传 count 时的条数
    maxCount: 20      # 单次上限
    historySize: 600  # 磁盘保留条数，同时是去重窗口
    prompt: true      # 是否注入使用说明到 systemPrompt
```

## 重新生成词库

```bash
node scripts/build-catalog.mjs [源 kaomoji.json 路径]
```

固定随机种子，同一份源数据重复跑结果一致，方便 diff。过滤规则在脚本的 `accept()` 里：长度 3–26、必须带括号、括号内得有内容、去掉纯 ASCII 和混进 emoji 的、去掉残留 HTML 实体的。

## 词库来源与许可

颜文字数据来自 [kaomoji-collection](https://www.npmjs.com/package/kaomoji-collection)（MIT，内容源自 [kaomojiya.org](https://kaomojiya.org/)，免费使用）。本插件代码 MIT。
