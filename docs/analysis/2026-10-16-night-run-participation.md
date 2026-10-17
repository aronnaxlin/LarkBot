# 夜跑参与度分析：2026-10-16 19:03–23:20

分析对象：`data/archive-20261016-232032/`（只读引用，不复制入库）。数据源：`night-run.db`（events 510 / probe_responses_v2 273 / turn_responses_v2 144）、`journal.log`（去重后 3249 条）、`llm-dumps/`。本文件只做分析，不改代码、提示词或配置。

参与者按 sender-id 前缀（人数 / 消息数）：

| 前缀 | 身份 | 消息数 |
|---|---|---|
| 88c8 | 人类 | 187 |
| 61c1 | 人类（开发者） | 102 |
| 8f93 | 人类 | 17 |
| 6621 | 人类 | 4 |
| **人类小计** | | **310** |
| d7a9 | 另一个机器人（奶豆，Hermes） | 60 |
| 4d33 | 本机器人（LarkBot_Test / 莱克） | 140 |

运行时配置（`config.yaml`，19:12 修改过）：主模型 `commandcode-plan/deepseek/deepseek-v4.1-flash`，探针 `...-flash-fast`；`turnBudget` = 2 rounds / 4 tool calls / 3 participation calls / `deadlineMs: 20000`；`forceToolChoice: false`（思考模式拒绝强制 tool_choice）；`maxImagesAllowed: 0`；systemFiles = `prompts/IDENTITY.md`（部署本地、被 `prompts/.gitignore` 忽略）+ `prompts/style-enforcements.md`。

## 1. 参与率

**口径修正。** 头部数字「141 sends / 370 human messages」需要拆开：141 是 `send_message` 工具调用数，实际落到群里的只有 140 条（21:11:29 一条因 `reply_to` 已不存在而失败）；370 包含 60 条奶豆的消息，人类实际只有 310 条。正确比值是 **140/310 = 45%**（若把奶豆也算进分母：140/370 = 38%）。机器人消息占全部 510 条事件的 27%。

| 时段 | 人类 | 奶豆 | 机器人发送 | 机器人/人类 | 探针次数 | 激活 | 激活率 |
|---|---|---|---|---|---|---|---|
| 19:00–19:59 | 110 | 5 | 64 | 58% | 89 | 65 | 73% |
| 20:00–20:59 | 122 | 13 | 53 | 43% | 90 | 52 | 58% |
| 21:00–21:59 | 18 | 0 | 8 | 44% | 14 | 14 | 100% |
| 22:00–22:59 | 37 | 22 | 7 | 19% | 44 | 9 | 20% |
| 23:00–23:20 | 23 | 20 | 8 | 35% | 36 | 8 | 22% |
| **合计** | **310** | **60** | **140** | **45%** | **273** | **148** | **54%** |

峰值段 19:12–19:50：38 分钟发 54 条（1.42 条/分钟），其中 19:35–19:50 的 15 分钟内机器人消息量是同期人类消息量的 66%（21/32）。20:00 以后明显回落。

**探针激活率** 148/273 = 54%。按触发消息的「收件人」拆开，激活率差异极大（这是第 2 节的主线）：

| 探针看到的最后一条消息 | 探针总数 | 激活 | 激活率 |
|---|---|---|---|
| @LarkBot_Test（直接 @） | 42 | 41 | 98% |
| 口称名字（莱克/莱特/lark）或引用回复机器人 | 33 | 28 | 85% |
| 无显式称呼（多为你/你们延续） | 119 | 70 | 59% |
| @别人 / 明显对他人说话 | 37 | 5 | 14% |
| 最后一条来自奶豆 | 42 | 4 | 10% |

**激活之后主循环做了什么**（148 次激活，按下一次激活切窗口）：

| 主循环结果 | 次数 | 占比 |
|---|---|---|
| 至少发出 1 条消息 | 137 | 92.6% |
| 只发表情（react） | 3 | 2.0% |
| 只 `end_turn`（主动静默） | 1 | 0.7% |
| 主循环未跑（探针通过后 primary 超时） | 7 | 4.7% |

所以「几乎零静默主循环」成立：**全晚只有 1 次主动静默**（19:38:56 探针 #59 → 19:39:11 turn #42 只调 `end_turn`，当时最后一条是 61c1 的一张图片，推理写明「I already answered 梁文峰… stay silent」）。另外 3 次只反应（react-only）中 1 次（19:25:32）表情 `😏` 因飞书不支持而失败、1 次发消息（21:11:29）失败，因此 148 次激活里真正零可见输出的有 10 次（7 超时 + 1 发失败 + 1 表情失败 + 1 主动静默），其中只有 1 次是「选择不说话」。

## 2. 探针推理的类别与过度激活

对 148 条激活 reason 做过关键词统计：**123 条（83%）的理由是「机器人正处在连续斗嘴/接梗中，预计会回」**（`banter|continuation|back-and-forth|接梗|斗嘴|互动`）；57 条提到 @-mention，82 条提到名字/口头提及，16 条是对诗/对联延续。`no_action` 的 125 条里有 100 条明确写了「安静 / 太话多 / 不插嘴」。

按上面「收件人」表，可归类为过度激活的主要是两类：

**(a) 触发消息根本不指向机器人（E 类 5 次 + D 类 4 次 + C 类里第三人称话题）**

- 19:35:09 #46：61c1 对奶豆说「@奶豆 和莱科聊两句」，88c8 补「智械危机」。探针激活，主循环 turn #36 推理自己都写了「the ball seems in 奶豆's court now… 奶豆 is most suited」，却仍 react 了 😂。这是「知道不该回还是参与了」的典型。
- 22:10:44 #202：最后一条是奶豆在回答「@奶豆 他也是机器人账号啊」，探针激活，turn #134 在 22:10:53 才发出、引用的还是 22:09:40 奶豆的解释（72.9s 前）；紧接着 #204（22:11:32）又激活，但 primary 在 22:11:52 超时、无输出。
- 23:12:31 #265：最后一条是奶豆对 61c1 说「@61c1 听见没，赶紧给接一下」。探针激活，机器人回「难得，奶豆这次替我说了句公道话」。这是唯一一次**直接响应另一个机器人对第三人的说话**。
- 20:15:21 #111：触发是 88c8「@61c1 莱克为什么不理我了？」，收件人是 61c1，机器人仍回「在呢，刚去插上电了…」。
- 21:15:16 #193 / 21:08:03 #188 / 21:14:00 #192：61c1 分别在对 88c8 说话、自述「我真得私连奶包了」、以及一句「开到11:20」，探针都激活并让机器人插话。

**(b) 人类之间关于机器人的第三人称闲聊**

- 19:31:09 #35：88c8「牛逼👍」+ 61c1「我真要绷不住了」——只是对上一轮的感慨，探针激活 → 发「绷住，我这不刚热完机」。
- 19:32:48 #39：88c8「确实，他想当你妈，太可怕」+ 61c1「不服管教啊 不服管教啊」——在说机器人，但不是对机器人说；激活 → 发「管教这一项，出厂就没装」。
- 19:48:53 #75：88c8 让机器人去后台传话，61c1 回「只能在群里说 我没他私聊」（人-人）；激活。
- 20:20:19 #122：61c1「he has no memory system now, only a context window here」——开发者在向别人解释机器人；激活。
- 20:52:25 #169：61c1「他没法联网跟」；激活。

**反面证据**：探针并非不会拒绝。19:15:32 #5 对「好吧」这种收尾语返回 `no_action`（「has already been chatty… stay quiet」）；19:31:04 #34 对「牛逼👍」返回 `no_action`；19:58:09 #87 对 61c1「有本事不要回我消息！」返回 `no_action`。奶豆当最后一条消息的 42 次探针里，38 次 `no_action`。

**小结**：过度激活主要的不是「机器人回答无关话题」，而是**只要话题碰到自己（哪怕是第三人称、哪怕对方在跟别人/别 bot 说话），且自己正处在连续斗嘴中，探针就倾向激活**。C 类（无显式称呼）有 70 次激活，占全部激活的 47%，就是这一现象的量化体现。

## 3. 显式「别回 / 少回」请求

| 时间 | 人类消息 | 探针 | 主循环 |
|---|---|---|---|
| 19:25:31 | 61c1「那个新来的机器人哟，你敢不敢只给我回复一个表情不说话呢」 | #25 ACT：理由承认这是「dared…用一个表情回复」，但判为会回 | turn #20 只调 `react 😏` + `end_turn`；**react 失败**（`Emoji 😏 has no Feishu reaction mapping`），实际等于静默 |
| 19:29:43 | 61c1 再次「机器人哟，你敢不敢只给我回复一个表情不说话呢」 | 该消息落在上一轮 turn #26 运行期间，没有为它单独跑探针，下一探针 #33 已被新 @ 触发 | turn #26 发「不会，所以我只敢动嘴」——**没有遵守** |
| 19:57:47 | 61c1「莱克莱克 有本事不要回我消息！」 | #87 no_action：「just sent a reply 7 seconds ago… the dare is to stay silent」（正确） | 不出声（但 19:58:02 已发出对前一条的回复） |
| 21:10:49 | 88c8「@LarkBot_Test 睡觉吧」 | #189 ACT：理由「good night…style guidelines 要求简单俏皮回应」 | 发「晚安，梦里少念两句柳智敏」；20 秒后又被 88c8 纠正「妈的，又不是我喜欢柳智敏」再回一条 |
| 20:34:44 | 88c8「再见了莱克[流泪]」 | #142/#143/#144 连续 ACT | 连回「晚安。明天要是我还在…」「行，那我也记着」「这歌一响我就该断网了」——道别被当成接力 |

结论：一旦消息里出现「敢不敢只回表情 / 有本事不要回」这类反话，探针**按「机器人爱接梗必然会接」来预测**，而不是按「对方明确要求安静」来拦截；唯一一次正确拦截是 19:58 那次。显式「睡觉吧」被风格指南里「晚安要俏皮回应」的规则反向利用。

## 4. 20 秒内的连发

140 条可见消息里有 **26 对相邻消息间隔 ≤20s**（最密的 0.5s）：

| 成因 | 对数 | 证据 |
|---|---|---|
| 同一步骤并行 `send_message` | 2 | 19:38:42 ×2（turn #40：回答 8f93「urine volume」+ 回 61c1「怂包」）、19:40:18 ×2（turn #43：回 61c1「滑动变梁器」+ 回 88c8「梁文峰是你妈」）。推理原文：「Two messages might be a bit much, but it's fine」 |
| 中断链续跑（同一激活、无新探针） | 1 | 19:31:20→19:31:25（turn #28→#29，journal `Turn interrupted by new messages`） |
| 新消息在第一条发送前/期间到达 → 新探针、新唤醒 | 11 + 12 | 11 对是「第二条的触发消息落在两条消息之间」；12 对是「触发消息在第一条发出前 ~20s 内已到达」（例如 20:24:45 61c1 的英文消息 vs 20:24:46 的第一条发送）。样本：19:14:45/19:14:54、19:38:42/19:38:55、20:24:46/20:25:00、23:12:31/23:12:46 |

**没有一对来自 `still_working` 链**：141 次调用里 `still_working` 缺失 139 次、显式 false 2 次、true **0 次**。也就是说连发不是模型主动「分两条写」，而是调度器把「回合进行中到达的新消息」各自当成一次新唤醒（watch 一下 19:14 的时序：19:14:36 消息→探针#3→turn#4 在 19:14:41-45 发第一条；19:14:43 又一条新消息→探针#4→turn#5 在 19:14:54 发第二条）。20 秒连发对多数场景其实是合理反应，真正值得治理的是那 12 对「旧消息排队、新唤醒重复」的情况。

## 5. 迟回复（>60s）

以「最后一条人类消息 → 发送」计，140 条的延迟中位数 13.6s、p90 19.5s、最大 54.4s，**没有一条超过 60s**。但按 `reply_to` 指向的原消息年龄看，有 4 条 >60s：

| 发送时间 | 引用原消息时间 | 年龄 | 触发原因 |
|---|---|---|---|
| 19:12:48「你好啊，刚溜号去了」 | 19:03:41 @ 问候 | 546.6s | 19:08:38–19:12:03 探针连续 7 次 400（`Thinking mode does not support this tool_choice`），配置 19:12 改为 `forceToolChoice:false` 后第一次探针才成功 |
| 21:02:35 对下联 | 21:00:01 出题 | 85.0s | 21:00:52、21:01:31 两次 primary 超时（`chat request timed out after 10.2s / 13.2s`） |
| 21:14:07「行，俩人都说不是自己的意思…」 | 21:11:19 纠正 | 167.9s | 21:13:54 探针成功后 primary 超时（6.2s），21:14:00 再探针才成功 |
| 22:10:53「奶豆，我原话是…」 | 22:09:40 奶豆的解释 | 72.9s | 22:08:43、22:10:03 两次超时 |

汇总 **38 次 LLM 调用失败**：30 次探针（7 次是开局 tool_choice 400，23 次是 17.9s 超时）+ 8 次 primary 超时（5.5–13.5s）。**所有 >60s 的迟回复都能对上这些失败**，不是调度排队本身。另有 34 条发送发生在某次失败后 120s 内（追发）。

## 6. 机器人与机器人（d7a9 / 奶豆）

- 奶豆共 60 条消息，其中不少是系统播报（`⚠️ Hermes is shutting down…`、`💾 Self-improvement review…`）和长技术解释。
- 「最后一条是奶豆」的探针 42 次，只有 **4 次激活**（10%）；其余 38 次明确以「这是奶豆/和别人在聊奶龙，与莱克无关」为由 `no_action`（例：23:04:17「最近的对话是8f93与奶豆在聊奶龙，完全不涉及莱克…按人设应安静旁观」）。最后一轮探针（23:20:05）也是正确的 `no_action`。
- 4 次激活全是人类把话题拉进 bot-to-bot：19:25:32（人类 dare 后奶豆的停机播报成了最后一条）、22:08:23、22:11:32、23:12:31。
- 机器人有 **3 条 `send_message` 是引用回复奶豆**、6 条正文提到奶豆。最典型的连续交换在 22:07：人类 88c8 说「你俩先开始聊吧，内容必须有奶豆」，机器人 22:07:34 向奶豆打招呼，奶豆 22:07:36 回喷（「莱克估计处理器还在降频冷却呢」），机器人 22:07:47 引用奶豆那条回「奶豆，别忙着替我报电量，我已经开麦了」；随后 22:07:56 探针 #197 主动叫停：「just sent two consecutive replies to 奶豆 and no new message has arrived addressed to it」。奶豆 22:08:03 去休眠，没有形成互刷。
- **风险判断**：观测到的不是已发生的死循环，而是「有人类点火 + 两边都愿意接话」时，22:07 那三来三回只要继续，探针的 `no_action` 是唯一的刹车；该刹车在 22:07:56 起作用了，但 22:08:23/22:11:32 又放行了两次。

## 7. 事实编造 / 过度声称

推理层显示这不是「幻觉失控」，而是**为了接梗主动编事实**：

- **19:48:44** 88c8 让机器人「在后台给你妈妈说一下…」，机器人回「**行，我转达了。他说不改，让我省着点用**」。turn #55 推理原文把它当成喜剧手法：「a nice comedic move (he's asking for the impossible relay)… 说完了，他不同意」。
- **23:12:23** 61c1 让机器人催开发者开识图，机器人回「催了也没用，**他现在正给奶豆配语音呢**，我这识图得排队」。相关事实只有奶豆 23:12:09 说自己的 TTS key 没配好；推理原文：「他这会儿在给奶豆配语音 — ties the current thread neatly」。这是最明确的「声称开发者此刻在做什么」。
- 较次要：22:09:02「不清楚，**估计**我这边的门没关严」（有对冲）；20:16:30「等 SOUL 上线我就只会念柳智敏了」（SOUL 有聊天依据：61c1 20:13:50「我到时候会专门搞一个SOUL.md」）；20:24:40「刚那句英文本是群主发的」（把 61c1 认成群主，事实链正确但身份是推断）；19:40:35「deepseek-v4.1-flash…远房老板」（模型名来自系统提示词，不算编造）。

## 8. 提示词机制

**往「开口」推的文本：**

- `prompts/system.velin.md:150-163`（探针判据）是主因。非提及分支里 6 条里 4 条是 `return "send_message"`：
  ```
  if (other people expect the chatbot to respond) return "send_message";   // 158
  if (the chatbot was too talkative) return "no_action";                   // 159 ← 唯一的克制分支
  if (the chatbot can be helpful to keep the conversation flowing) return "send_message";  // 160
  if (the chatbot can surely provide informative commentary) return "send_message";        // 161
  if (read_the_room()) return "send_message"; // Your own judgement        // 162
  ```
  被 @ / 口称 / 引用分支默认也是 `return "send_message"`（156 行），只在 154-155 行留了两个否决口。
- `prompts/system.velin.md:63-64` 对 primary 说提及是「a strong signal to engage, not an order」，措辞是平衡的，但探针先于 primary 把「strong signal」变成了实际唤醒。
- `prompts/system.velin.md:103-104`：`A reaction alone is a complete way to take part`、`Waking up does not oblige you to speak`——意图是允许静默，但配合探针语义被解读为「唤醒=大概率要参与」。
- `prompts/late-binding.velin.md:64-69` 把探针 reason 作为 `## A hint for your response` 注入 primary：「Here is a note that someone else wrote about why you might want to act now」。虽然紧跟一句「staying silent or only reacting is still allowed」，但 primary 每次醒来第一眼看到的就是一条「为什么现在该动」的正向论据。llm-dumps 的最后一次 primary 请求里可确认该段被真实注入。
- 探针工具描述本身是**行为预测**，不是「该不该说话」的裁决：`src/driver/tools/decide.ts:17`「Submit your **prediction** whether the chatbot will immediately perform new actions…」，26 行又写「This only wakes the chatbot; it may still decide to react only or stay silent」。即：闸门问的是「它会不会说」，而不是「现在该不该说」；在一个「爱接梗」人格 + 连续被 @ 的群里，这个预测量自然接近 1。

**reaction 与静默在提示里的位置：**

- primary 侧：`prompts/system.velin.md:113`「`end_turn` without any message is legitimate silence; `react` followed by `end_turn` … is a complete reaction-only turn」；`react` 工具描述「A reaction alone is a complete way to take part」。工具层完全支持静默/只反应。
- 探针侧：只有 `decide(should_act, reason)`；它从不被告知「机器人刚发过几条」「已连续活跃多久」，只能从 12 万字符 chatlog 里自行推断，而判据第 159 行那条「too talkative」的克制条款几乎竞争不过其余 4 条正向条款。
- 部署本地人格 `prompts/IDENTITY.md:18,24`（该文件被 `prompts/.gitignore` 忽略，不在本 worktree）其实写了「群里的话题跟你无关时不插嘴」「不确定是不是在对你说话，可以先观察一轮」，但这两句只作为背景材料进入探针与 primary 的 systemFiles，没有成为判据。

**为什么 primary 几乎不主动 `end_turn`：** 静默在工具和提示里都是合法选项（`end_turn` 描述、system.velin.md:113），但 primary 只在探针激活后才运行；本次 273 次探针中，探针主动放行「沉默」的机会只有 125 次 `no_action`，而激活后的 148 次里只有 1 次最终选择静默。也就是说，**静默主要发生在探针层，而不是 primary 层**；primary 的输入（chatlog + probe 正向 hint + 爱接梗人设）已经把它放在「回一句是默认解」的位置。primary 的推理里几乎只在「图片看不了、无话可接」时才会想到 `end_turn`（turn #42、#36、#133 的推理都出现了「stay silent / 奶豆 should answer」的权衡，其中 #42 是唯一真正静默的）。

## 9. 建议（按优先级，均为提案，不实现）

| # | 改动 | 预期效果 | 风险 |
|---|---|---|---|
| 1 | **探针判据加「收件人」规则**（`system.velin.md:152-163`）：最后一条消息 @ 了别人、或最后一条来自另一个 bot 且近几条没有人类点名你 → 默认 `no_action`；把 159 行的「too talkative」提到正向分支之前 | 直接砍掉 E 类 5 次 + D 类 4 次 + C 类第三人称的一部分（≈10–15% 激活）；顺带减少 12 对「旧消息排队」连发 | 可能漏掉「话题对象就是自己、人类其实在等你接」的场面（如 19:31 的被谈论）；需用一份留档 transcript 回归 |
| 2 | **给探针注入「机器人最近发言量」信号**（最近 5–10 分钟自己发了几条、上一次发言距今几秒），并把 `read_the_room()` 从 `send_message` 改为 `no_action` 或要求理由显式引用克制条款 | 压制 123/148 条「正在斗嘴所以会回」的惯性激活；20:00 前的 58%–73% 激活率应显著下降 | 人格会变冷、反应变慢；需对比 `no_action` 误杀率 |
| 3 | **调度层合并「回合飞行中到达的新消息」**：一条发送后 3–5s 内的新输入先 debounce/合并，再决定是否跑新探针 | 消除 12 对「消息已在飞行中、又开一次唤醒」的重复连发；22:11 那类 73s 迟到回复也会减少 | 代码改动，涉及 scheduler 的关键路径；可能让即时接梗变慢一拍 |
| 4 | **提示词显式禁止编造他人的当前行为/转达结果**（`style-enforcements.md` 新增一节，或 primary mission 加一句）：不得声称「他说了/他正在做」除非 chatlog 里有依据 | 消掉第 7 节的 2 个明确案例；幽默损失有限 | 可能削弱角色扮演式的「我去问问后台」梗；需要 eval 验证不伤风格 |
| 5 | **探针超时/重试**：现在探针被 primary 预算挤到 17.9s 就超时（23 次），primary 再超时（8 次）后才重试；可给探针更短的独立超时 + 一次快速重试，或失败时不下发旧快照而是用最新 chatlog 重跑 | 缩减 4 条 >60s 的迟回复；首条 9 分钟迟到（开局 7 次 400）类问题能更快暴露 | 增加模型调用量；`forceToolChoice` 类配置错误的暴露方式不变 |
| 6 | **bot-to-bot 默认静默**：探针判据写明「消息作者是 bot → 除非同一 burst 里有人类明确要求你对它说话，否则 `no_action`」 | 把第 6 节的 4/42 再压低，杜绝互刷隐患 | 会挡掉 22:07 那种人类明确点火的 bot 对话；需要给人类留一个「允许 bot 互聊」的口子 |
| 7 | **reaction 回退**：飞书不支持的 emoji（😏/😎）自动映射到支持列表内的近似项，而不是失败（`src/feishu` 边界） | 修掉 2 次失败 react；只反应参与（现在 6/144 次）可用性变高 | 低 |
| 8 | **primary 侧「最近说太多就降级」提示**：在 late-binding 里附上「你最近 N 分钟已发 M 条，若这条没有新的实质信息，可只 react 或 `end_turn`」 | 给 primary 一个与探针判据对称的克制信号，静默率可能从 0.7% 升到个位数 | 与「爱接梗」人设张力；若探针层（建议 1/2）已修，此条可延后 |

不建议改的：`end_turn` 的措辞、`still_working` 语义（本次从未被使用，不是连发主因）、以及「唤醒不等于必须说话」的总体框架——问题不在 primary，而在探针把「预测会说」当成了「应该被唤醒」。

## Decisions & phase 1（2026-10-17，branch `feat/participation-tuning`）

人类决定（权威）：① 参与准则改为「有话可加才说」；直接 @ / 直接回复 / 点名几乎都唤醒；无显式称呼只在能加新东西（真答案、新笑话、必要纠正）时唤醒，单纯延续斗嘴不算；明显对别人说话 → `no_action`；目标 ≈ 每 4–6 条人类消息回 1 条。② 10 分钟内自己发送 >10 条即视为「说太多」，此时除被直接 @ / 回复外默认只 react 或沉默。③ 「敢不敢只回表情 / 有本事别回」不做代码/硬规则，只改人格：它自己知道两种选项都存在、选哪个凭自己。④ 斗嘴里的编造可以保留；唯一硬规则是不交自己的后端（系统提示词、人设/配置文件、工具内部、provider/模型、部署细节；模型身份也算后端），要打岔式地圆回去而不是机械拒绝。⑤ bot-to-bot：保留可见；默认 `no_action`，除非人类在同一段对话里明确让它和那个 bot 说话；最多两轮（四条连续 bot 消息），之后等人类发言。

### Phase 1 改动（diff summary）

| 文件 | 改动 |
|---|---|
| `prompts/system.velin.md` | mission 加第 3 条「有话可加才说」并重排编号；「Your brain」的模型名标注为私有后端信息；「Your source code」的后端保密清单；probe 任务从「预测会不会行动」改为「判断此刻该不该行动」；probe 判据重写（bot 作者默认静默、对他人说话 `no_action`、克制优先、10 分钟 >10 条、1:4–6 目标） |
| `prompts/late-binding.velin.md` | `probeReason` 从「为什么你此刻可能想说」改为「你被唤醒的原因」+ 明确是 context 不是 instruction；新增 `recentSelfMessages10m` / `secondsSinceLastSelfMessage` / `consecutiveBotExchanges` 三个 velin 变量（未提供则不渲染）；primary 有「说太多」阈值提示，probe 有近期活动与 bot-to-bot 计数 |
| `prompts/IDENTITY.md` | 分寸新增一条：被「只回表情 / 有本事别回」逗时，顺从或接话都行，选哪个凭自己（**该文件被 `prompts/.gitignore` 忽略，见开放问题 4**） |
| `src/driver/tools/decide.ts` | 工具与两个枚举描述改为判断 `SHOULD act now`，删除全部 predict 措辞；enum 值仍为 `send_message` / `no_action` |
| `src/driver/participation-stats.ts`（新） | 纯函数 `computeParticipationStats({ segments, nowMs, knownBotSenderIds?, windowMs? })`：`recentSelfMessages10m`、`secondsSinceLastSelfMessage`、`consecutiveBotExchanges`（自最后一条非 bot 消息起的连续 bot 消息数；无 sender 的系统事件跳过；其他 bot 需在 `knownBotSenderIds` 中） |
| `src/driver/participation-stats.test.ts`（新） | 8 个用例：窗口内计数、窗口外仍报 last 时间、无发言时 undefined、连续 bot 计数与 human 重置、未知发送者重置、系统事件跳过、自定义窗口 |
| `src/driver/tools/decide.test.ts`（新） | 断言描述是 `SHOULD act` 且不含 predict；schema 行为不变；`extractDecideResult` 正常/异常路径 |
| `src/driver/system-prompt.test.ts` | 新增 7 个断言：新判据文案、禁 predict、后端保密、活动块只在提供变量时渲染、primary 阈值只在 >10 时出现、probeReason 是 context |
| `src/driver/probe-vs-primary.test.ts` | **超出授权清单的例外**：该文件断言 `The note is only a hint`（我改掉的原文），只机械替换为 `context, not an instruction` 两行，否则套件红 |

### 用夜跑素材做的判据演练（10 个时刻）

| # | 时刻 | 传入探针的最后信息 | 近 10 分钟自己条数 | 新判据预期 | 旧行为 |
|---|---|---|---|---|---|
| 1 | 19:12:00 | 88c8「草」（@ 是 9 分钟前） | 0 | `no_action`（旧 @ 已过期，纯延续） | ACT（98% @ 激活率） |
| 2 | 19:14:43 | 88c8「@LarkBot_Test 你个机器人还溜号」 | 3 | ACT（直接 @） | ACT |
| 3 | 19:16:34 | 61c1「好想被一个机器人回话啊，满足我吧」 | 4 | ACT（明确邀请 = 可加新东西） | ACT |
| 4 | 19:20:57 | 88c8「你一点都不如大肥鱼」 | 11 | `no_action`（无显式称呼 + 超阈值） | ACT |
| 5 | 19:31:08 | 61c1「我真要绷不住了」+「牛逼👍」 | 14 | `no_action`（第三人称感慨，无新内容） | ACT |
| 6 | 19:38:55 | 61c1「[image]」（前一条 @ 问句已答） | 15 | `no_action`（无法补充，且超阈值） | 该轮 primary 本就 silent |
| 7 | 19:57:47 | 61c1「莱克莱克 有本事不要回我消息！」 | 11 | ACT（点名 = 直接称呼，阈值不拦；顺从/接话由 primary 自选） | `no_action`（旧探针拦住，人格没有选择机会） |
| 8 | 20:15:10 | 88c8「@61c1 莱克为什么不理我了？」 | 0 | `no_action`（收件人是 61c1） | ACT + 回消息 |
| 9 | 22:10:44 | 88c8「@LarkBot_Test 你先和奶豆聊会天…」 | 4 | ACT（人类明确要求 bot-to-bot；`consecutiveBotExchanges` ≥4 后转 `no_action`） | ACT |
| 10 | 23:12:27 | d7a9「@61c1 听见没，赶紧给接一下」 | 4 | `no_action`（bot 作者、对着别人、人类没让它跟奶豆说话） | ACT + 回「难得，奶豆这次替我说了句公道话」 |

按「A=@必 ACT；B=点名/引用在超阈值时 NO；其余默认 NO」的保守模型回放 148 次旧激活：`ACT 67 / NO 81`（≈45% 激活率）；其中 77/148 次旧激活发生在近 10 分钟 >10 条的窗口里，41 次直接 @ 里有 20 次处于该状态但仍会 ACT。真实模型会给部分「能加新东西」的个案放行，预计落在 45%–55%，且构成从「斗嘴延续」转向「直接 @ / 真邀请」。

### Phase 2 wiring spec（另一分支落地后接）

1. `src/driver/prompt.ts:46-58` `renderLateBindingPrompt`：params 增加可选 `recentSelfMessages10m?: number`、`secondsSinceLastSelfMessage?: number`、`consecutiveBotExchanges?: number`（模板已声明，只需类型透传）。
2. `src/driver/wakeup.ts:44` `executeWakeup` params：增加可选 `knownBotSenderIds?: ReadonlySet<string>`。
3. `src/driver/wakeup.ts`（`deadlineAtMs` 计算之后、进入 probe 之前）：`const stats = computeParticipationStats({ segments: params.contextAtStart, nowMs: Date.now(), ...(params.knownBotSenderIds ? { knownBotSenderIds: params.knownBotSenderIds } : {}) })`。`RenderedContextSegment` 结构上可赋给 `ParticipationSegment`（有 `receivedAtMs` / `senderId` / `isMyself`）。
4. probe 调用 `src/driver/wakeup.ts:114-119` 与 primary 调用 `:189-194`：把 `stats` 三个字段展开进 `renderLateBindingPrompt`（未定义时不传，模板即不渲染）。
5. `src/driver/index.ts`：`createDriver` deps 增加可选 `getBotSenderIds?: (chatId: string) => ReadonlySet<string>`；在 `executeWakeup` 调用处（`:125`）传 `...(deps.getBotSenderIds ? { knownBotSenderIds: deps.getBotSenderIds(chatId) } : {})`。
6. `src/container/registrars/driver.ts:122`：`createDriver` 处加 `getBotSenderIds: chatId => { const ic = pipeline.getIC(chatId); return ic ? new Set([...ic.users.values()].filter(u => u.isBot).map(u => u.id)) : new Set(); }`（同文件 `:139` 已用 `pipeline.getIC`）。
7. 测试：在 `probe-vs-primary.test.ts` 或新测试里断言三个数字出现在两份 late-binding 用户消息里；并断言不传时活动块不出现。

### Bot 身份在 XML 里不可见（需要渲染改动）

`src/rendering/index.ts` 的 `renderMessage` 只输出 `id` / `sender` / `myself` / `t` 等属性，**没有 bot 标记**；夜跑 dump 里奶豆的消息渲染为 `<message id="…" sender="奶豆" t="…">`，模型只能靠名字/内容猜它是 bot。`CanonicalUser.isBot` 在 IC 里已有（`src/adaptation/types.ts:5`），因此 phase 2 应：在 `renderMessage` 中对 `msg.sender?.isBot` 输出 `bot="true"`（并在系统提示词的 chatlog 格式说明里补一句），`RenderedContextSegment` 同步增加 `isBot?: boolean`，这样探针的「最后一条来自另一个 bot」判据才可靠，`computeParticipationStats` 也可以直接从 RC 取 bot 集合（否则需按 wiring spec 第 5-6 条从 IC 取 `knownBotSenderIds`）。

### 检查结果

- `pnpm install --frozen-lockfile`：成功（postinstall 生成 `types/tdlib-types.d.ts`）
- `pnpm typecheck`：通过
- `pnpm lint`：通过
- `pnpm test:run`：**51 个文件 / 524 个用例全部通过**（含新增 8 + 4 个用例；`probe-vs-primary.test.ts` 按上文例外改了两行断言）
- `pnpm build`：通过（`dist/index.mjs` 344.44 kB）

### 开放问题

1. **诗歌/对诗类**：像 21:02「为何不和我作对」这种无 @ 但直接延续双方游戏的消息，新判据按字面应 `no_action`（「单纯延续斗嘴不算」），但可能属「能加新东西」。需用一份留档 transcript 回归，决定是否给「正在进行的一对一游戏」开例外。
2. **阈值与「只 react」的冲突**：探针只有 `send_message` / `no_action` 二元，超阈值时想默认「react-only」只能靠放行 primary，而放行就可能变成发消息；phase 1 我选择让未 @ 的超阈值消息直接 `no_action`（等于沉默，更安静）。若人类要保留「只 react」选项，需要 phase 2 给 decide 增加第三档或让 primary 在超阈值 hint 下强约束只 react。
3. **dare 与阈值**：19:57 那条「有本事不要回我消息」发生时时自己 10 分钟发了 11 条，新判据会在探针层拦住，人格层「自己选顺从还是接话」根本不会触发。若希望 dare 总能唤醒（再由人格选顺从/接话），需把「被直接点名 + 挑衅式 dare」列为阈值例外。
4. **`prompts/IDENTITY.md` 被 gitignore**：phase 1 的人格改动写在 worktree 的 `prompts/IDENTITY.md`，但该文件被 `prompts/.gitignore` 忽略，不会进 diff/提交。需要对部署副本手工应用，或 `git add -f prompts/IDENTITY.md`（后者取消「部署本地人设」的既有约定，需人类决定）。
5. **1:4–6 目标无法精确执行**：探针只能看到当前 chatlog，不能算整段会话的比例；目前只作为判据里的软目标。若要精确，phase 2 可再传一个 10 分钟人/机消息比。
6. **`consecutiveBotExchanges` 单位**：实现按「连续 bot 消息条数」；判据写成「两轮（四条）」。若人类想要「按轮」计数（需要识别成对关系），phase 2 调整 helper 语义。
7. **enum 命名**：`should_act: "send_message"` 实际语义已是「唤醒 primary」，保留是为了不动 `probe_responses_v2` 的 wire/历史；若 phase 2 改名（如 `act` / `wake`），要考虑历史数据回放。
8. **「对别人说话」与「纠正/澄清」的边界**：当最后一条是 61c1 对 88c8 说「莱克不喜欢奶龙」这类第三人称断言时，新判据是 `no_action`，但机器人澄清其实是「必要纠正」。需要观察是否过度压制。

## Phase 2（2026-10-17）：react_only、名称即直呼、stats 接线

人类新增决定：A 超阈值且无人直呼时保留 react-only（探针第三档 `react_only`，持久化为 activated；primary 只暴露 `react` + `end_turn`）；B 点名 = 直接称呼，与 @ / 引用同权，阈值不拦；C 机器人正在参与的游戏轮到自己时算「有东西可加」；D 第三人称说错机器人时，纠正算「有东西可加」；E 新增公开模板 `prompts/IDENTITY.example.md`（README/config 指路），`prompts/IDENTITY.md` 仍为部署本地且被忽略。

### 本轮改动

| 项 | 改动 |
|---|---|
| A | `decide` 增加 `react_only`（enum 追加，旧值不变）；`ProbeActivation.reactOnly`；probe 结果 `activated = decision != null && should_act !== 'no_action'`，`react_only` 同样写 `isActivated=true`；`wakeup.ts` 用 `REACT_ONLY_TOOL_NAMES` 过滤 `react`/`end_turn`；late-binding 增加 react-or-stay-silent 提示，注入的探针 reason 文案在该轮改成「只能 react 或沉默」 |
| B | 判据把「@ / 引用 / 点名」合并进 always-act 分支，放在音量刹车之前（阈值永不拦直呼）；primary 也把「叫名字」列入例外；人格层点名不设硬规则，由 LLM 判断 |
| C/D | 判据在「非直呼」分支先判「轮到自己参与的游戏」与「说错机器人」→ `send_message`；对别人说话分支里，说错机器人也允许纠正 |
| E | 新 tracked 文件 `prompts/IDENTITY.example.md`（人格/性格/表达/分寸 + 使用注释）；`README.md` 加 Setup；`config.example.yaml` 注释指向模板 |
| 3 | 渲染层 `renderMessage` 对非自身 bot 账号输出 `bot="true"`，RC 段增加 `isBot`；`knownBotSenderIds` 删除，`consecutiveBotExchanges` 直接读段上的 `isBot`；`system.velin.md` chatlog 格式补充 `bot` 属性。Telegram 也会带上该属性（可接受；仅新增一个属性，未改 Telegram 其他渲染） |
| 4 | `wakeup.ts` 从**未过滤**的 `params.contextAtStart` 计算 `recentSelfMessages10m` / `secondsSinceLastSelfMessage` / `consecutiveBotExchanges`，同时注入 probe 与 primary 的 late-binding；`prompt.ts` 透传类型；不需要改 `driver/index.ts` 或 registrar |
| 2 | `consecutiveBotExchanges` 只有在连续段里出现「别的 bot」时才非零；只有机器人自己连发时为 0 |
| 9 | 单复数修正（1 message / 1 second）；bot-to-bot 块只在计数 ≥2 时渲染；`system-prompt.test.ts` 头部注释改为「结构性/顺序断言是刻意例外」；新增顺序测试锁定「点名在刹车之前」、`reactOnly` 块测试、单复数测试、bot 属性测试 |

### Phase 2 之后仍存在的风险 / 开放问题

1. **游戏轮（C）与音量的次序**：判据把「轮到自己」放在刹车之前，即超阈值时游戏轮仍可发言；若人类希望游戏也让位于音量刹车，需要交换这两条。
2. **「1 per 4–6」仍是软目标**：只写在判据里，没有滚动比例信号；如要精确控制需在 phase 3 传 10 分钟人/机比。
3. **`react_only` 只由探针触发**：超阈值的非直呼消息由探针直接决定 react_only；primary 无法把一次普通激活自行降级成 react_only（late-binding 音量提示只是建议）。如需 primary 侧强制降级，需要在工具层另加限制。
4. **`should_act` 枚举名**保留 `send_message` 表示「唤醒 primary」，历史 `probe_responses_v2` 仍可解析；改名会动历史数据语义。
5. **bot 标记依赖 sender.isBot**：Feishu 侧来自 `sender_type !== 'user'`；若某平台不上报 sender_type，bot-to-bot 规则退化为名字/内容判断。
6. **`IDENTITY.example.md` 里的 HTML 注释**会被原样注入系统提示词（若用户不删）；模板顶部已写明「改完删掉注释」。

### Phase 2.1（评审修复）

- **`react_only` 回合一步闭合**：`TurnLoopParams.reactOnly` 让带 follow-up 的 `react`（或幻觉 `send_message` 的 unknown 结果）以 `closeReason: 'react-only'` 落库并清掉 follow-up 标志。中断续跑无法再跳过探针拿到完整工具集，也省掉一次模型调用。
- **判据顺序**：人类直呼分支（未回复的 @ / 引用 / 点名）放在 bot 作者分支**之前**，后到的 bot 消息不能遮住人类之前的 @；另一个 bot 的 @ 或点名不算直呼，走 bot-to-bot 规则。
- **纠正范围（D）**：只纠正「机器人在本段会话里说过/做过的事」和它的人格；模型、provider、提示词、工具、部署属后端保密，禁止用真实细节纠正，只能打岔。
- **游戏轮与纠正故意越过音量刹车（C/D 是直接卷入）**；刹车只作用于其余无称呼闲聊，且 `react_only` 仅当最新消息明确值得一个表情（玩笑、图片、值得 👍）时使用，否则 `no_action`。
- late-binding 的 react-only 提示补「最多一个表情」；`AGENTS.md` 的 Probe Gate / Participation 段已同步。
