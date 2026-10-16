# 飞书接入调研（Feishu/Lark Integration Research）

日期：2026-10-16 · 状态：**仅调研，未实现** · 范围：飞书/Lark 接入的最小增量方案

本文只回答“怎么在现有 Cahciua 代码上接飞书”，不实现代码、不安装依赖、不改配置、不启动机器人。

标注约定：

- **【事实】**：有代码或官方文档/官方 SDK 源码证据，附链接。
- **【建议】**：本文的判断与推荐，可以改。
- **【待验证】**：无法从公开资料确认，必须在真实租户/应用里实测。
- 本文不对上游 `Menci/Cahciua` 的既有行为做价值判断；指向仓库的链接均为本次调研时抓取的提交，代码只读不复制。

---

## 0. 结论摘要

1. **【建议】接入载体：官方 Node SDK [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk)（MIT，本次核对版本 1.76.0，commit `b188be60134d409b61259546bcf69c731d2b0b7c`）**。用 `WSClient` + `EventDispatcher` 收长连接事件，用包内导出的 `normalize()` 把原始事件规范化成文本/markdown + 附件描述，用自己的代码产生 `CanonicalIMEvent`；出站用 `client.im.v1.message.create/reply`。不采用 SDK 的高层 `Channel` 模块，因为它自带一整套 dedup/policy/限流/批处理/队列语义，会和 Driver 的 debounce、probe 门控和 ingress 队列形成第二个调度器；`normalize()` 单独导出，正好只借它的解析能力。

2. **【事实】全链路真正需要动的地方是“消息 ID 一律是字符串”这条缝**：Driver 依赖签名、`react`/`send_message`/reply 校验、附件 `file-id` 解析、`messages` 表主键都默认 `messageId: number`。飞书 `message_id` 形如 `om_xxx`、`chat_id` 形如 `oc_xxx`、用户 `open_id` 形如 `ou_xxx`，无法转数字。把这条缝收敛到一处平台接口，是并行开发的前提（见 §5）。

3. **【事实】飞书事件不会被完整补发**：长连接只在在线时推送，官方说明“特殊情况下可能会收到重复的推送，如有幂等需求请使用 `message_id` 去重，不要依赖 `event_id`”，且长连接有“3 秒内处理完成否则超时重推”“集群模式、多客户端只有一个随机收到”的限制。因此去重键必须是 `message_id` 且要能跨重启；必须有断线补洞，且**不能承诺看到全部历史**（见 §2.5/§2.7）。

4. **【事实】机器人自己的消息不会作为事件推回来**（`im:message.group_msg` 明确“不包含机器人消息”）。现有“synthetic self-event”机制在飞书不是优化而是**必需**：每次成功发送后必须自己注入 `isSelfSent=true` 的 canonical 事件，否则 bot 看不到自己说过什么。

5. **【事实】飞书没有“消息编辑”事件**。官方 Node SDK 事件表里 IM 域只有 13 个事件，无 edit/update；编辑只能靠拉取消息时的 `updated`/`update_time` 字段发现。撤回有独立事件 `im.message.recalled_v1`。因此第一版应支持撤回（delete），不支持编辑（edit），并明确记录该限制（见 §2.6）。

6. **【建议】第一版范围**：群聊 + p2p 文本消息、@、引用、稳定身份、发送、表情、撤回、成员/改名服务事件、去重、断线补洞。媒体、卡片/流式、编辑、ban_spammer、typing 指示、通用插件框架都不做。第一版**可以不改数据库 schema**：飞书事件只写 `events`（canonical），不写 Telegram 专用的 `messages` 表，从而绕开 `messages.message_id integer → text` 迁移（见 §4.4）。

7. **【建议】权限最小集**：`im:message` + `im:message.group_msg`（敏感、可能需管理员审批）+ `im:message:send_as_bot` + `im:resource` + `im:chat`/`im:chat.members:read` + `contact:user.base:readonly`（昵称解析），事件订阅 `im.message.receive_v1`、`im.message.recalled_v1`、成员/群变更事件；并在开发者后台开启长连接、发布版本。完整清单见 §6.3。

8. **【建议】CLI/MCP 不是第一版的接入方式**。官方 `larksuite/cli`（MIT，commit `017b19a793ad71794a02887ede04757f3d82e10d`）与 `lark-openapi-mcp` 适合后续作为“查历史/查成员/查资料”的**工具**，不适合与自建 WS 客户端同时跑：同一个 app 的长连接是集群模式，多客户端只有一个能收到事件，两个 ingress 同时在线会随机丢事件。官方 README 也明确提示不要把 CLI 接入的机器人拉进群聊。详见 §3.6。

---

## 1. 现有链路追踪（代码证据）

数据流：**平台事件 → canonical event → DB → Projection(IC) → Rendering(RC) → Driver(probe/primary) → 平台发送 → synthetic self-event**。

### 1.1 逐段职责

| 阶段 | 关键文件 | 当前实现要点 |
| --- | --- | --- |
| 平台客户端 | `src/telegram/bot.ts`、`src/telegram/userbot.ts`、`src/telegram/tdjson.ts` | 两个 TDLib 客户端；启动前 `tdl.configure()`；发送要等 `updateMessageSendSucceeded` 才拿到最终 id |
| 入口聚合 | `src/telegram/manager.ts` | 事件总线、`ingressQueue`（per-chat 有序、失败无限重试、只提交连续前缀）；阻塞式元数据/媒体 hydrate |
| 平台→canonical | `src/telegram/adaptation.ts` | `parseContent` 把 text+entities 解析成 `ContentNode[]`；消息/编辑/删除/服务事件 |
| 落库 | `src/db/persistence.ts` | `persistMessage`（`messages` 表，upsert）、`persistEvent`（`events` 表，append-only） |
| 发布 | `src/telegram/event-sink.ts` | configured chat 白名单 → hydrate alt text → `pipeline.pushEvent` → `DriverInputBus.handleEvent`；用 WeakSet/WeakMap 保证 persist/publish/notify 幂等 |
| 活处理 | `src/telegram/live-handlers.ts` | 平台事件 → canonical → 落库 → 发布；编辑的“幽灵编辑”检测 |
| Projection | `src/projection/reduce.ts`、`src/projection/types.ts` | 纯 reducer；edit/delete 原地改节点；user rename 产生系统事件；`ICUserState` 记录首/末见与消息数 |
| Rendering | `src/rendering/index.ts` | IC → XML 段；`mentionsMe`/`repliesToMe` 用于唤醒；`<attachment file-id="messageId:index">` |
| Pipeline | `src/pipeline.ts` | per-chat IC/RC residency、compact cursor、`getRenderParams`（`botUserId`、`blockedUserIds`） |
| Driver | `src/driver/index.ts` | 组装 deps；per-chat scheduler/compaction/runner；`handleEvent`/`handleTyping` |
| Probe/Primary | `src/driver/wakeup.ts`、`src/driver/runner.ts` | probe 门控；`forceToolChoice: 'any'`；`maxSteps: Infinity`；无 send 时的 forced-send fallback |
| 工具 | `src/driver/primary-tools.ts`、`src/driver/tools/*` | `send_message`/`react`/`read_image`/`download_file`/`read_old_messages`/`bash`… |
| 出站 + 自事件 | `src/telegram/driver-hooks.ts` | Markdown→Telegram HTML；发送；`injectSyntheticEvent` 写 `isSelfSent` canonical 事件（不唤醒 Driver） |
| 启动 | `src/startup/index.ts`、`src/container/**` | 模块顶层 `tdl.configure({ tdjson })`；容器 → 冷回放 → attach Driver → live handlers → telegram.start → activate → postStartup |
| 配置 | `src/config/config.ts` | `telegram` 为必填；`chats.<chatId>` 白名单；`models`/`runtime`/`tools` 平台无关 |

### 1.2 飞书接入必须改动的具体位置

按“不改就无法接”到“可以后补”排序。

**A. 消息/回复 ID 类型：number → string（核心）**

- `src/driver/index.ts`：deps 里 `sendMessage` 返回 `{ messageId: number }`、`banSpammer(messageId: number)`、`setMessageReaction(messageId: number)`、`loadMessageAttachments(messageId: number)`、`messageExists(messageId: number)`、`downloadMessageMedia(messageId: number)`。
- `src/driver/primary-tools.ts`：`sendMessage` 的 `replyToMessageId?: number`、`replyTo ? Number(replyTo) : undefined`、`String(sent.messageId)`。
- `src/driver/tools/send-message.ts`：`messageExists(messageId: number)`、`Number(reply_to)`、`Number.isFinite` 校验。
- `src/driver/tools/react.ts`：`messageExists(messageId: number)`、`Number(message_id)`。
- `src/driver/tools/attachment-downloader.ts`：`file-id` 用 `lastIndexOf(':')` + `parseInt(messageId)` 解析；`om_xxx:0` 会 `NaN`。
- `src/rendering/index.ts`：`file-id="${messageId}:${index}"`（本身已是字符串，但生成的 ID 类型变了）。
- `src/telegram/driver-hooks.ts`、`src/telegram/bot.ts`、`src/telegram/manager.ts`、`src/telegram/moderation*.ts`：在 Telegram 侧内部把 string 转回 number（`Number(chatId)`、`serverToTdLibMessageId`），转换点收敛到 Telegram hook 内部。
- `src/db/persistence.ts`：`persistMessage`/`loadMessageAttachments`/`messageExists`/`persistMessageDelete` 用 `messages.messageId integer`；`src/db/schema.ts` 的 `messages.messageId`/`replyToMessageId` 为 integer。**建议第一版让飞书走 `events` 表绕开该迁移**（见 §4.4）。
- `src/db/moderation.ts`：`loadModerationMessageIds` 把 `events.messageId` `cast as integer`；这是 Telegram 专用，飞书第一版禁用 `ban_spammer` 即可。

**B. 平台生命周期与 DI**

- `src/startup/index.ts` 顶部 `import * as tdl` + `tdl.configure({ tdjson: resolveTdjson() })` 是模块级副作用：只要进程启动就要求 TDLib 可用。必须改为按平台初始化。
- `src/container/registrars/telegram.ts`、`tokens.ts`、`registrars/driver.ts`、`registrars/pipeline.ts`、`registrars/media.ts` 全部硬编码 `TELEGRAM_CLIENTS`/`TELEGRAM_MANAGER`/`TELEGRAM_DRIVER_HOOKS`/`TELEGRAM_LIVE_HANDLERS`/`TELEGRAM_POST_STARTUP_TASKS`。
- `src/pipeline.ts` 的 `botUserId`、`src/container/registrars/driver.ts` 的 `createModerationService`、`bot.raw()`、`bot.botUserId()` 都是 Telegram 形状。
- `src/telegram/event-sink.ts` 与 `src/telegram/session-ingress-queue.ts` 实际是平台无关的（只依赖 `CanonicalIMEvent` 和 `{chatId}`），推荐原样移动到 `src/im/` 复用，避免飞书复制一份。
- `src/telegram/post-startup.ts` 是动画 hash 回填，Telegram 专用；飞书第一版空实现。

**C. 配置**

- `ConfigSchema.telegram` 必填（`botToken`/`apiId`/`apiHash`）。飞书模式下不应被迫填 Telegram 凭证；需要新增 `feishu` 段并允许二者其一。
- `chats` 白名单、`blockedUserIds`、`debounce`、`compaction`、`tools` 等可以原样复用，chat id 本来就是字符串（`oc_xxx`）。

**D. 提示词与“频道名”**

- `src/driver/wakeup.ts` 两处 `currentChannel: 'telegram'` 硬编码；`prompts/system.velin.md`（`You are a chatbot, participating in a Telegram group chat.`、Telegram-flavored Markdown、quoted reply 说明）和 `prompts/late-binding.velin.md` 也写明 Telegram。**这属于 driver/人设线的文件**，飞书线只提供 `platformName` 参数，不改提示词策略（见 §5）。

**E. 出站能力差异（飞书侧实现，不是现有代码 bug）**

- Telegram 出站走 `parseTextEntities` + `inputMessageRichMessage`；飞书没有 TDLib 解析器，需要自己的 Markdown 包装（官方推荐 `post` + `md` 标签，见 §2.9）。
- Telegram 用 `sendChatAction` 发送 typing；**未见飞书机器人有对应的 typing 指示 API**（【待验证】），飞书 hook 应 no-op，并把 chat 配置 `sendTypingAction: false`。
- `setMessageReaction` 在 Telegram 传 unicode emoji；飞书要传枚举 `emoji_type`（`SMILE`/`THUMBSUP`…），且删除需要 `reaction_id`（见 §2.9）。
- 附件：Telegram 用 `(chatId, messageId)` 重新 `getMessage` 下载；飞书用 `(message_id, file_key, type)` 调 `message_resource`，所以飞书侧的 `downloadMessageMedia` 需要用已存的事件内容找出 `file_key`（第一版媒体不启用，可先返回失败）。

**F. 可以不动的部分**

`src/adaptation/types.ts`（canonical 类型已经是平台无关的粗粒度形状）、`src/projection/**`、`src/rendering/**` 主体、`src/driver/{scheduler,runner,turn-loop,compaction*,context,merge}.ts`、`src/llm/**`、`src/unified-api/**`、`src/media/**`（媒体后期再接，接口本身平台无关）、`src/background-task/**`。这些是“复用现有工程”的主体。

---

## 2. 飞书/Lark 平台事实核实

官方文档支持在 URL 后加 `.md` 直接取 Markdown（官方 CLI README 明确说明：任意开放平台文档 URL 加 `.md` 即可）。下面链接均为本次实际抓取过的原文。

### 2.1 环境与长连接

**【事实】**

- 长连接（WebSocket）与 webhook 两种订阅方式并存；长连接**仅支持企业自建应用**（store app 不支持），需要本机可访问公网，不需要公网 IP/域名。
- 收到事件后**必须在 3 秒内处理完成且不抛异常**，否则触发超时重推。
- 每个应用最多 50 个长连接。
- 推送是**集群模式，不支持广播**：同一应用部署多个客户端时，只有**其中随机一个**会收到某条事件。
- 国内版飞书与国际版 Lark 通过 SDK 的 `domain` 区分（`feishu` / `lark`）；AstrBot 文档明确“国内版和国际版飞书均支持长连接”。
- 官方 SDK：`@larksuiteoapi/node-sdk`（MIT，1.76.0），`WSClient.start({ eventDispatcher })` 从 1.24.0 起支持；`Channel.connect()` 会在 15 秒内等真实握手。
- 事件与回调是开发者后台两个配置项；`card.action.trigger` 回调可以走同一条长连接（官方 CLI 文档明确“events are delivered over the existing WebSocket long connection — no additional [URL]”，但 Node SDK README 在别处写过“长连接模式仅支持事件订阅，不支持回调订阅”，**两处口径不一致，需在目标应用验证**）。

证据：  
- 长连接模式：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>  
- Node SDK README（长连接示例与注意事项）：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/README.md#L557>  
- `Channel.connect()`：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/channel.ts#L103>  
- AstrBot 文档（domain 与 socket/webhook）：<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/docs/zh/platform/lark.md#L81>  
- CLI card 回调走 WS：<https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/skills/lark-im/references/lark-im-card-action-reply.md>

**【建议】** 飞书进程只跑**一个** WS 客户端；不要同时跑 CLI 的 `event consume` 或第二个实例，否则事件随机分投，双方都会缺事件。

### 2.2 群全量消息权限

**【事实】** `im:message.receive_v1` 的权限决定“能看到什么”，不是同一个 scope：

| 想接收 | 需要的权限 |
| --- | --- |
| 单聊 | `im:message.p2p_msg` 或 `im:message.p2p_msg:readonly` |
| 群里 @ 机器人（用户+其他机器人） | `im:message.group_at_msg.include_bot:readonly` |
| 群里 @ 机器人（仅用户） | `im:message.group_at_msg` 或 `im:message.group_at_msg:readonly` |
| 群里**所有**消息（用户+其他机器人，不含自己） | `im:message.group_msg.include_bot:read` |
| 群里所有消息（不含机器人消息） | `im:message.group_msg`（官方在订阅列表里标注“敏感权限”） |

默认只推 @ 机器人的群消息；要“旁听”必须开 `im:message.group_msg`，而它被标记为敏感权限、需要发布版本（很可能需要企业管理员审批）。群历史查询 `GET /im/v1/messages` 在应用身份下也要求先有单聊场景的权限、再开 `im:message.group_msg`。

证据：  
- 接收消息事件（权限与“特殊情况可能重复推送，请用 message_id 去重”）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive>  
- 历史消息（群聊需 `im:message.group_msg`）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list>  
- AstrBot 文档（`im:message.group_msg` 与一键权限链接）：<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/docs/zh/platform/lark.md#L38>

### 2.3 稳定 user/open/union ID 与机器人自身身份

**【事实】** 官方用户身份模型：

| ID | 范围 | 稳定性 | 备注 |
| --- | --- | --- | --- |
| `lark_id` | 全局 | 稳定 | 开发者不可见，无需关注 |
| `user_id` | 租户 | 租户内稳定 | 即 employee_id；要拿到需要敏感字段权限 `contact:user.employee_id:readonly` |
| `open_id` | 应用 | 单应用内稳定，换应用会变 | 事件里**始终存在**（`ou_` 前缀）；**禁止跨应用使用** |
| `union_id` | 开发者/服务商 | 同一服务商多个应用间稳定 | `on_` 前缀；同一开发主体的多应用可关联 |

事件里 `sender.sender_id` 同时可能带 `open_id`/`user_id`/`union_id`，取决于租户的 `sender_id_type` 设置；`user_id` 缺失是正常的。Hermes 的实现注释把这一点写得很清楚，并把 `union_id` 当作跨应用稳定的备用身份、`open_id` 作为主键回退。

机器人自身身份：`GET /open-apis/bot/v3/info`（tenant token）返回 `bot.open_id` 与 `bot.app_name`，这也是群里 @ 机器人时 `mentions[].id.open_id` 的值。nanobot、AstrBot、官方 node-sdk `Channel` 三处实现都走这个接口。

证据：  
- 官方用户身份概述：<https://open.feishu.cn/document/home/user-identity-introduction/introduction>  
- Hermes 适配器文件头的身份模型注释：<https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py#L1>  
- node-sdk `fetchBotIdentity()`：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/channel.ts#L406>  
- nanobot `_fetch_bot_open_id()`：<https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py#L1173>  
- AstrBot `request_lark_bot_info()`：<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/bot_info.py>

**【建议】** 第一版 `CanonicalUser.id = open_id`（事件里必有、单应用内稳定），同时把 `user_id`/`union_id`（若事件里有）存进 existing 的 `CanonicalUser` 扩展字段或 `events.sender` JSON，供未来跨应用/跨租户迁移和逐人记忆使用；**不要**在缺少 `user_id` 时编造。`displayName` 需要额外解析（事件里发送者只有 ID，没有昵称）：AstrBot/Hermes 都用通讯录 `GET /contact/v3/users/:id` 并做缓存，建议照做（见 §6.3 权限）。

**【待验证】** 目标租户的 `sender_id_type` 实际返回哪些 ID；`contact:user.base:readonly` 之类的昵称 scope 是否需管理员审批；企业是否开启“外部群/外部用户”。

### 2.4 @、引用、thread/话题

**【事实】**

- 文本消息里 @ 会被替换成 `@_user_N` 占位符，真实对象在 `message.mentions[]`：`{key, id:{open_id,user_id,union_id}, name, mentioned_type}`。@all 在 content 里是 `@_all`。
- 回复/话题：`root_id`（根消息）、`parent_id`（直接父消息）、`thread_id`（话题 ID）。**话题内回复的 `root_id` 和 `parent_id` 都指向话题根消息**。
- 接收事件不带被引用消息的正文；要引用内容必须再调 `GET /im/v1/messages/:message_id`（nanobot、AstrBot、Hermes 都这么做）。
- 发送侧用 `reply` 接口 + `reply_in_thread` 可指定“以话题形式回复”；`root_id`/`thread_id` 会在回复响应里返回。话题群不支持 `reply_in_thread` 时会报 `230071`。

证据：  
- 消息管理概述（root/parent/thread/deleted/updated 字段）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro>  
- 回复消息：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply>  
- nanobot 引用内容拉取：<https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py#L2752> 附近  
- AstrBot 引用解析：<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/lark_adapter.py#L407>

**【建议】** 第一版：`parent_id → CanonicalMessageEvent.replyToMessageId`；引用正文优先复用 Pipeline 的 `replyToPreview`/`replyToContent` 快照（父消息还在 IC 里时天然可用），并增加“按需拉取父消息并缓存”的补强（一次 API 调用，失败软降级）。**不按 thread 拆会话**（符合“不需要多对话管理”），但把 `thread_id` 作为可选字段透传并在渲染时作为属性输出，避免话题群里模型误读上下文。

### 2.5 事件目录、去重与重推

**【事实】** 官方 Node SDK 事件类型表里 IM 域共 13 个事件（本次枚举）：

```
im.message.receive_v1              im.message.message_read_v1
im.message.reaction.created_v1     im.message.reaction.deleted_v1
im.message.recalled_v1             im.chat.updated_v1
im.chat.disbanded_v1               im.chat.member.bot.added_v1
im.chat.member.bot.deleted_v1      im.chat.member.user.added_v1
im.chat.member.user.deleted_v1     im.chat.member.user.withdrawn_v1
im.chat.access_event.bot_p2p_chat_entered_v1
```

- **没有消息编辑事件**。
- `im.message.reaction.created_v1` 只带 message_id / emoji_type / operator / action_time，**不带 `reaction_id`**；机器人只能删除自己添加的表情，所以删除要靠自己 create 时缓存的 `reaction_id`。
- 官方接收事件文档明确：“特殊情况下可能会收到重复的推送，如有幂等需求请使用 `message_id` 去重，不要依赖 `event_id`。” 长连接的 3 秒超时重推是重复的另一来源。
- AstrBot 用 `event_id` 去重（30 分钟窗口），与官方建议相悖；nanobot 用 `message_id` 的 1000 条内存 LRU（重启即丢）；Hermes 用 `message_id` + 时间戳、带 TTL、落盘 JSON 跨重启。

证据：  
- 事件类型完整表：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/code-gen/events-template.ts#L4309>（recalled）、`#L4426`（receive）  
- 官方接收事件“用 message_id 去重”：见 §2.2 链接  
- AstrBot `_is_duplicate_event`：<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/lark_adapter.py#L528>  
- nanobot dedup：<https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py#L2678>  
- Hermes 持久化 dedup：<https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py#L3550>、`#L3592`

**【建议】** 三层去重：① 内存 LRU（挡住 3 秒重推）；② **落库判定**：发布前查该 `(chatId, messageId)` 是否已有 canonical 事件，有则跳过（跨重启）；③ 出站发送带 `uuid`（1 小时内同 uuid 至多成功一条），避免重试造成重复发言。**不要用 event_id**。

### 2.6 编辑与删除（撤回）事件支持与限制

**【事实】**

- 撤回：`im.message.recalled_v1`，只有在机器人所在的会话内才会推送；字段为 `message_id`、`chat_id`、`recall_time`、`recall_type`（message_owner / group_owner / group_manager / enterprise_manager），**没有操作人 ID**。订阅该事件需要 `im:message` 或 `im:message:readonly`。
- 撤回耗时 1 年的限制只针对“机器人在群里撤回他人消息”（需要机器人是群主/管理员/创建者且消息不超过 1 年）；机器人撤回自己的消息没有这条 1 年限制，但受企业管理员设置的撤回时限约束。
- 编辑：无事件。拉取消息时可看到 `updated`/`update_time`；`im.message.receive_v1` 里 `message.update_time` 只在消息被编辑过且被重新投递时可能非空（**【待验证】** 实际行为）。

证据：  
- 撤回事件：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/recalled>  
- 撤回接口限制：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/delete>

**【建议】** 第一版把 `im.message.recalled_v1` 映射为 canonical `delete` 事件（不改动 Projection：现有 reducer 会把目标节点标记 `deleted`）。`CanonicalEditEvent` 保留类型但飞书不产生；文档明确“飞书编辑不可见”，并把“若需要显示编辑，只能在拉取历史/引用时以 `updated` 字段补标”记为后续工作。

### 2.7 历史补查

**【事实】**

- `GET /im/v1/messages`（container_id_type=chat）支持 `start_time`/`end_time`（秒级）、`sort_type`、`page_size` ≤ 50，接口限频 1000 次/分、50 次/秒。
- 应用身份读群消息要求 `im:message.group_msg`；机器人必须在群里。
- 长连接掉线期间的事件不会补发（只有 3 秒超时重推），所以“断线补洞”只能靠自己用历史接口回查。
- **【待验证】** 机器人**入群之前**的历史消息能否读到（文档只写“机器人必须在被查询的群组中”，未写时间边界）；外部群、话题群的历史行为也需实测。因此**不保证能看到全部历史**。

**【建议】** 第一版把补洞做成可选的启动/重连动作：以本地最后一条事件的 `timestampSec` 为 `start_time`，`ByCreateTimeAsc` 翻页，逐条走同一套 dedup + canonical 流程（幂等，不会重复）。补洞失败只记日志，不阻塞主流程。入群前历史不在承诺范围内。

### 2.8 成员信息

**【事实】** `GET /im/v1/chats/:chat_id/members`：不返回机器人成员；同一时间入群的人会一次性返回，所以返回条数可能少于也可能多于 `page_size`；`page_size` ≤ 100；支持 `member_id_type`（open_id/union_id/user_id）；需要 `im:chat`/`im:chat:readonly`/`im:chat.members:read`。群信息 `GET /im/v1/chats/:chat_id` 返回群名、群类型、外部群标记、各类权限设置。入群事件 `im.chat.member.user.added_v1` 自带 `users[].name` 与群名。

证据：  
- 群成员：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/get>  
- 群信息：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get>  
- 官方 CLI 成员/群命令：<https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/affordance/im.md>（`+chat-members-list`、`+chat-search`）

**【建议】** 第一版用“事件里的名字 + 通讯录按需解析”为主，群成员列表作为后续“人物记忆”的补充数据源；不要依赖成员列表推断“群里有哪些人”。

### 2.9 发送、表情、附件

**【事实】** 发送（`POST /im/v1/messages`）：

- `receive_id_type`：open_id / union_id / user_id / email / chat_id；用户推荐 open_id。
- 限频：向同一用户 5 QPS，向同一群 5 QPS（**全群机器人共享**）；接口级 1000/分、50/秒。
- `msg_type`：text / post / image / file / audio / media / sticker / interactive / share_chat / share_user / system；文本 ≤150KB，卡片/富文本 ≤30KB。
- **Markdown 官方推荐 `post` + `md` 标签**：CommonMark 0.31 + GFM（表格、任务列表、删除线、自动链接），额外支持 `<at user_id="ou_xxx">名字</at>`、`<at user_id="all"></at>`、`![alt](img_v3_xxx)`。示例 content：`{"zh_cn":{"content":[[{"tag":"md","text":"..."}]]}}`。
- `uuid` 参数用于发送去重：同 uuid 1 小时内至多成功一条（≤50 字符）。
- 回复用 `POST /im/v1/messages/:message_id/reply`，支持 `reply_in_thread`。

表情（`POST /im/v1/messages/:message_id/reactions`）：

- 传枚举 `reaction_type.emoji_type`（如 `SMILE`、`THUMBSUP`），不是 unicode；需要 `im:message` 或 `im:message.reactions:write_only`；机器人/用户必须在会话内。删除需要 `reaction_id`（create 响应里有）。

附件：先 `POST /im/v1/images` 或 `/im/v1/files` 上传拿 key，再用 key 发消息；音频/视频上传需要时长；机器人只能发自己上传的文件（错误码 230017）。下载用 `GET /im/v1/messages/:message_id/resources/:file_key?type=image|file`，需要 `im:resource`。

证据：  
- 发送消息：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create>  
- 发送内容与 `md` 标签：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json>  
- 回复：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply>  
- 表情 create：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/create>  
- 接收内容结构：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content>  
- node-sdk 的 reactions 约束说明：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/docs/channel.md>

**【建议】** 第一版：`post`+`md` 发文本（把整段 Markdown 塞进一个 `md` 节点），超长（例如 >4000 字符，客户端约 4096 会分屏）按段落切分成多条，首条用 reply；表情做 unicode→emoji_type 映射表，并缓存自己 create 得到的 `reaction_id` 以支持 remove；附件全部后置。

### 2.10 其他限制与坑（都会影响实现）

- **3 秒事件处理上限**：入口 handler 必须快速返回，重活丢队列（现有 `session-ingress-queue` 正好是这个形状）。
- **幂等键是 message_id**（§2.5）。
- **bot 自己的消息不会回推**（`im:message.group_msg` 文档措辞）。必须 synthetic self-event。
- **消息编辑不可见**（§2.6）。
- **发送限频 5 QPS/群且群内机器人共享**：tool loop 连续发言会被限流；这正是“有界工具执行”要解决的问题，飞书线只负责把错误如实返回。
- **长连接集群模式**：不能多开；与 CLI event consumer 互斥（§2.1/§3.6）。
- **撤回事件没有操作人 ID**：canonical delete 事件的 `actor` 留空。
- **typing 指示**：未找到飞书机器人可用的 typing API（【待验证】），需要把 `sendTypingAction` 对飞书置 false 或 no-op。
- **提示注入**：CLI/MCP 官方 README 明确建议不要把这类机器人拉群；说明群消息内容属于不可信输入，后续接 CLI/MCP 工具时要按不可信数据处理。

### 2.11 待验证清单（实现前/联调时必须实测）

1. 目标租户能否获批 `im:message.group_msg`（敏感权限，可能需管理员审批）；外部群是否可用。
2. 接收事件里 `sender_id` 实际返回哪些 ID（open_id 之外是否有 user_id/union_id）。
3. 消息**编辑**是否完全不会重推；`update_time` 在接收事件里的实际表现。
4. 机器人**入群前**历史消息能否读到；入群后历史读到的起点。
5. 机器人被 @ 时 `mentions[].id.open_id` 是否恒等于 `/bot/v3/info` 的 open_id（三个参考实现都依赖这一点）。
6. `@all` 消息是否会在 `im:message.group_msg` 下推送给机器人。
7. 长连接是否支持 `card.action.trigger` 回调（官方两处口径不一致）。
8. 飞书是否存在机器人 typing/正在输入能力。
9. 昵称解析 scope 的确切名称与是否需要审批（`contact:user.base:readonly` 与 `contact:contact.base:readonly` 在 AstrBot 的示例里同时出现）。
10. 5 QPS/群限流下，模型连续多条发言的实际表现与错误码。

---

## 3. 参考实现核对（仓库存在性 + 真实源码 + commit）

**只读参考，不复制代码。** 各仓库许可：nanobot MIT、hermes-agent MIT、node-sdk MIT、larksuite/cli MIT、lark-openapi-mcp MIT；**AstrBot 为 AGPL-3.0**，其代码不得复制进本仓库，只能作为行为参考。

### 3.1 HKUDS/nanobot（MIT，Python）

仓库存在、默认分支 `main`、commit `67248790c76b150af39dab5026608ee2c449b0d3`。

- 适配器主文件（2905 行）：<https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py>
  - 收消息与门控：`#L2633` `_on_message`：`sender_type == "bot"` 直接丢；群聊未 @ 机器人直接丢；`message_id` 内存 LRU 去重；收到即回一个 `THUMBSUP` 表情；`parent_id` 拉父消息正文；用 `root_id/message_id` 做 topic 会话隔离（可配置 `topic_isolation`）。
  - 发送：`#L2076` `_send_message_sync`（`im.v1.message.create`）、`#L1944` `_reply_message_sync`（`im.v1.message.reply`，支持 `reply_in_thread`）。
  - @ 解析：`#L1201` `_resolve_mentions` 把 `@_user_N` 替换成 `@姓名 (open_id, user id: xxx)`。
  - WS 运行：<https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/websocket.py>（把 `lark_oapi` 的模块级 loop 补丁到自己的工作线程，避免多实例冲突）。
  - 配置形状：<https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/config.py>（`group_policy: open|mention`、`reply_to_message`、`streaming`、`topic_isolation`）。
  - 测试目录有 20+ 个飞书测试（mention、post、reply、reaction、table split、media filename security 等）：<https://github.com/HKUDS/nanobot/tree/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/tests>
- 值得借鉴：**测试组织方式**（每个飞书消息类型/交互一个测试文件）和 `topic_isolation` 的取舍记录。
- 不建议照搬：内存去重不跨重启；把 topic 作为独立 session 的策略与 LarkBot“单上下文”方向相反。

### 3.2 NousResearch/hermes-agent（MIT，Python）

仓库存在、默认分支 `main`、commit `53bec2a311979ad6f77580ba491eca261ab988e0`。

- 适配器主文件（4493 行）：<https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py>
  - 文件头身份模型注释（open_id/user_id/union_id）：`#L1`
  - bot 判定：`#L347` `_is_bot_sender`（接收文档说 `{user, bot}`，实现防御性接受 `app`）
  - 准入策略：`#L3382` `_admit`：self-echo 过滤、bot 消息策略（none/mentions/all）、群策略（open/allowlist/blacklist/admin_only/disabled）、require_mention；@all 视为提到自己。
  - **持久化去重**：`#L3550`/`#L3580`/`#L3592`，`message_id → 时间戳` 落盘 JSON + TTL + 容量上限。
  - 事件处理与线程：`#L2016` `_on_message_event`（loop 未就绪时排队重放）、`#L2615` `_process_inbound_message`（`thread_id` 才当话题，`root_id` 不能当话题，否则普通引用会被误判为话题——这是他们踩过的坑）。
  - 出站：`#L1652` `send`（markdown → post，失败降级纯文本）、`#L1704` `edit_message`、`#L1732` `delete_message`、`#L1983` `get_chat_info`。
  - WS 生命周期：`#L1493` `connect`、`#L1545` `disconnect`、`#L1574` `_teardown_ws_thread`（**先发 WebSocket CLOSE 帧再拆线程**，否则服务端继续把事件路由到已死连接；“同一 app_id 本地只允许一个实例”的 app lock）。
- 权限文档（scopes 表）：<https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/website/docs/user-guide/messaging/feishu.md#L62>
- 插件清单：<https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/plugin.yaml>
- 值得借鉴：**身份 ID 优先级（open_id > user_id > name）**、**持久化去重**、**CLOSE 帧/单实例锁**、`thread_id` 与 `root_id` 的区分、markdown→post 的降级策略。
- 不建议照搬：整套 gateway/多 profile/multiplex 架构，远超 LarkBot 当前需要。

### 3.3 AstrBotDevs/AstrBot（AGPL-3.0，仅行为参考）

仓库存在、默认分支 `master`、commit `9441402872f65fffc35685b0ead5bd3337033cb2`。

- `<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/lark_adapter.py>`：`register_p2_im_message_receive_v1` + `lark.ws.Client`；`convert_msg`（`#L586`）；`_build_reply_from_parent_id`（`#L407`）；`event_id` 去重（`#L517`，与官方 message_id 建议相悖）；通讯录昵称解析与缓存。
- 文档：<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/docs/zh/platform/lark.md>（权限、socket/webhook、一键权限链接）。
- 已确认的官方口径：`im:message.group_msg` 是“接收群聊中所有消息”的关键权限。

### 3.4 larksuite/node-sdk（官方，MIT）

仓库存在、默认分支 `main`、commit `b188be60134d409b61259546bcf69c731d2b0b7c`、版本 1.76.0。

- 长连接与事件：`WSClient` + `EventDispatcher`；README `#L557`。
- 高层 `Channel`：`channel/channel.ts`、`channel/safety/dedup-cache.ts`（两层去重：内存 LRU + 可注入长效 Cache）、`channel/normalize/**`（消息类型 → markdown + XML 标签的统一表示）、`channel/outbound/**`（markdown→post、分片、重试、错误分类）、`docs/channel.md`。
- **关键：`normalize` / `normalizeCardAction` / `normalizeReaction` / `normalizeBotAdded` / `normalizeComment` 在包根导出**（`channel/index.ts` 的 `export { normalize, ... } from './normalize'`），文档也写明“For webhook-mode integrations, historical event replay, or custom event pipelines, the internal normalizers are exported as well”。这意味着可以**只借解析器、不要 Channel 的调度语义**。
- `NormalizedMessage` 字段（`docs/channel.md`）：`messageId`/`chatId`/`chatType`/`senderId`（open_id 优先，回退 user_id/union_id）/`content`（markdown + XML 媒体标签）/`resources`/`mentions`（不含 bot 自己）/`mentionAll`/`mentionedBot`/`rootId`/`threadId`/`replyToMessageId`/`createTime`。
- 发送侧 `SendOptions` 支持 `replyTo`、`replyInThread`、结构化 `mentions`；内置 `target_revoked` 自动去掉 replyTo 重发、`format_error` 降级纯文本；`LarkChannelError` 分类 `rate_limited`/`permission_denied` 等。
- 依赖很轻：axios、lodash.*、protobufjs、qs、ws。

### 3.5 其他可参考的官方材料

- 服务端 SDK 文档：<https://open.feishu.cn/document/ukTMukTMukTM/uETO1YjLxkTN24SM5UjN>
- 事件列表入口：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-list>

### 3.6 官方 CLI（larksuite/cli）与 MCP

**larksuite/cli**：仓库存在、`main`、commit `017b19a793ad71794a02887ede04757f3d82e10d`、MIT、Go、200+ 命令 + 26 个 Skill。

- 实时事件：`lark-cli event consume <EventKey>` 走长连接，stdout 输出 NDJSON；有 ready marker、`--max-events`/`--timeout`、退出码约定；一次只能消费一个 EventKey。<https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/skills/lark-event/SKILL.md>
- IM 事件目录（12 个，含 reaction/chat.member，**不含 recalled**）：<https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/skills/lark-event/references/lark-event-im.md>
- 消息/成员操作：`+chat-messages-list`、`+messages-search`、`+messages-mget`、`+chat-members-list`、`+messages-reply`、`+messages-edit`、`reactions create/list/delete`、`+messages-resources-download` 等：<https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/affordance/im.md>
- `--as user|bot` 切换 user_access_token / tenant_access_token；`lark-cli auth login --recommend`。
- README 安全警告：建议把 CLI 接入的机器人当私人助手，**不要拉进群聊**、不要让其他用户与之交互，以免权限被滥用。<https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/README.zh.md>

**lark-openapi-mcp**：仓库存在、`main`、commit `21920354ec6e3966b52e89152620c5085e496b55`、2025-08 后无更新。<https://github.com/larksuite/lark-openapi-mcp>

**【建议】** CLI/MCP 的定位：

1. **不作为接入 ingress**：它与自建 WS 客户端争抢同一 app 的集群推送（§2.1），且多一个常驻进程/bus daemon。
2. **后续作为工具候选**：查历史、查群成员、读文档等交给 `lark-cli`（子进程 + `--as bot` + 最小 scope），或 MCP。但必须按“不可信输出”处理，且不能用于权限判定（维护者权限仍来自本地可信配置）。
3. 若要试 CLI ingress，只能用**同一个 app 的同一 WS 连接策略**：要么全部交给 CLI（由它 `event consume` 再喂给本进程），要么全部自己接；不能两者并存。

---

## 4. 推荐的最小增量方案

### 4.1 设计原则

- 不建通用插件框架，不为“以后可能接的平台”抽象；只为**当前两个实现**（Telegram、Feishu）抽出必要接缝。
- 复用既有 canonical 类型、Projection、Rendering、Driver、DB、compaction、scheduler。
- 第一版能用官方 SDK 解决的都不自己写；能用 DB 幂等解决的都不加新表。

### 4.2 模块划分（新增）

```text
src/
├── im/                        # 平台无关、从 telegram/ 抽出（纯移动，逻辑不变）
│   ├── event-sink.ts          # 原 telegram/event-sink.ts
│   └── session-ingress-queue.ts  # 原 telegram/session-ingress-queue.ts
├── feishu/                    # 新增，唯一允许写飞书平台细节的地方
│   ├── client.ts              # WSClient + Client + bot 身份 + start/stop + 断线重连
│   ├── adaptation.ts          # 原始事件 -> CanonicalIMEvent（含 delete/service）
│   ├── content.ts             # normalize() 结果/原始 content -> ContentNode[]；parent 引用解析
│   ├── live-handlers.ts       # dedup 闸门 + persist + publish（对照 telegram/live-handlers.ts）
│   ├── user-names.ts          # open_id -> 昵称缓存（通讯录 API，失败软降级）
│   ├── reactions.ts           # unicode <-> emoji_type 映射 + reaction_id 缓存
│   ├── markdown.ts            # Markdown -> post/md 包装 + 分片
│   └── driver-hooks.ts        # sendMessage/reaction/download/typing(no-op) + synthetic self-event
└── driver/platform.ts         # 最小接缝接口（见 §5.2）
```

### 4.3 接入方式（第一版逐项）

| 能力 | 做法 | 依赖权限 |
| --- | --- | --- |
| 收群消息（含旁听） | `WSClient` + `EventDispatcher` 订 `im.message.receive_v1`；chat id 在 `chats` 白名单内才进 pipeline | `im:message.group_msg`（+群@权限） |
| 收单聊 | 同上，`chat_type == 'p2p'` | `im:message.p2p_msg:readonly` |
| 文本解析 | `normalize()` 拿 `content`（markdown + XML 标签）+ `mentions`/`mentionAll`；再转 `ContentNode[]` | — |
| 发送者身份 | `open_id` 为主键；`isBot = sender_type !== 'user'`；昵称经通讯录缓存解析，失败回退 ID | 昵称：`contact:user.base:readonly` |
| @ / 提到我 | `mentions[].id.open_id == botOpenId`（botOpenId 来自 `/bot/v3/info`）；`@_all` 记为 mention-all | — |
| 引用 | `parent_id` → `replyToMessageId`；正文优先 IC 快照，缺失时按需 `GET /im/v1/messages/:id`（带缓存，失败软降级） | `im:message`/`im:message:readonly` |
| 话题 | `thread_id` 作为可选字段透传渲染，不拆会话 | — |
| 撤回 | `im.message.recalled_v1` → canonical `delete` | `im:message`/`im:message:readonly` |
| 服务事件 | `im.chat.member.user.added_v1` → members_joined；`...deleted_v1` → member_left；`im.chat.updated_v1` 的 `after_change.name` → chat_renamed；`im.chat.member.bot.added_v1` 用于拿群名/记录入群 | 订阅对应事件 |
| 去重 | 内存 LRU + `events` 表存在性检查（跨重启） | — |
| 断线补洞 | 重连/启动时按本地最后时间戳调历史接口回查，逐条走同一去重流程 | `im:message.group_msg`（群） |
| 发送 | `post`+`md`；>4000 字符按段落分片；首条 reply；带 `uuid` | `im:message:send_as_bot` |
| 表情 | unicode→emoji_type 映射；create 后缓存 reaction_id 支持 remove | `im:message.reactions:write_only` |
| typing | no-op；飞书 chat 配置 `sendTypingAction: false` | — |
| 自消息 | 每次发送成功后注入 `isSelfSent=true` canonical 事件（含真实 `create_time`） | — |
| 媒体 | **第一版不做**：附件不 hydrate、`download_file`/`read_image` 对飞书返回明确不支持错误 | 后期 `im:resource` |

### 4.4 数据库：第一版可以零迁移

**【建议】** 飞书事件只写 `events`（canonical，`message_id` 已是 text），不写 Telegram 专用的 `messages` 表：

- `messageExists` 的飞书实现查 `events`（现有 `loadLatestMessageContent` 已示范按 `chatId + messageId` 查 `events`）。
- 附件读取从 `events.attachments`（canonical JSON）取；第一版媒体关闭，返回空/失败即可。
- 因此**不需要**把 `messages.message_id integer` 改成 text，**不需要**新 Drizzle 迁移。Telegram 行为不变。
- 代价：飞书没有平台原始 JSON 归档、没有 `messages.deletedAt`（撤回只体现在 canonical IC/events）。若后续要做媒体，再决定是迁移 `messages` 还是给飞书建独立附件表；届时按项目规范补迁移。

### 4.5 明确不做（YAGNI）

- 通用平台/插件框架、平台注册中心、第二种消息 ID 抽象层。
- 按 thread 拆上下文、多会话管理。
- 卡片、流式输出、流式打字机效果（`cardkit` 相关权限）。
- 媒体上传下载、自定义表情、图片 alt text。
- 消息编辑同步、ban_spammer、消息删除（只有撤回）。
- CLI/MCP 接入、Jev/Mem0 接入（见 §5.3）。
- 历史全量导入；只做“断线补洞”。

---

## 5. 与 driver 行为开发线并行：文件所有权与最小接缝

### 5.1 文件所有权建议

| 归属 | 文件 | 规则 |
| --- | --- | --- |
| **飞书线独占** | `src/feishu/**`（新增）、`src/container/registrars/feishu.ts`（新增）、`docs/feishu-integration-research.md` | 可自由改 |
| **driver 行为线独占** | `src/driver/wakeup.ts`、`runner.ts`、`turn-loop.ts`、`context.ts`、`compaction*.ts`、`scheduler.ts`、`tools/end-turn.ts`、`tools/decide.ts`、`prompts/**` | 飞书线不碰 |
| **共享、需一次“接缝提交”锁定** | `src/driver/index.ts`、`src/driver/primary-tools.ts`、`src/driver/platform.ts`（新增）、`src/driver/tools/{send-message,react,attachment-downloader,download-file,read-image}.ts`、`src/db/persistence.ts`、`src/db/schema.ts`、`src/container/{tokens.ts,index.ts,registrars/{driver,pipeline,core,media}.ts}`、`src/startup/index.ts`、`src/config/config.ts`、`src/pipeline.ts` | 先合接缝，再各自动工；后续改这些文件要互相同步 |
| **纯移动（一次提交）** | `src/telegram/event-sink.ts` → `src/im/event-sink.ts`；`src/telegram/session-ingress-queue.ts` → `src/im/session-ingress-queue.ts` | 只改 import/路径，不改逻辑，方便 diff 审查 |

接缝提交的验收标准：`pnpm typecheck && pnpm lint && pnpm test:run && pnpm build` 全绿，Telegram 行为不变（现有测试 + characterization 测试保护）。

### 5.2 最小接口接缝（建议形态）

把现在散落在 `createDriver` deps 里的平台形状收敛成一个接口，消息 ID 一律 `string`：

```ts
// src/driver/platform.ts —— 飞书线提供，driver 线评审
import type { CanonicalAttachment } from '../adaptation/types';
import type { BanSpammerResult } from './platform-types';

export interface PlatformAttachmentRef {
  type: string;
  fileName?: string;
  mimeType?: string;
  fileKey?: string;          // 飞书：message_resource 下载所需
  resourceType?: 'image' | 'file';
}

export interface DriverPlatform {
  name: 'telegram' | 'feishu';       // 供 wakeup 的 currentChannel 使用
  botUserId: string;                 // pipeline 的 botUserId / isMyself / mentionsMe
  start(): Promise<void>;
  stop(): Promise<void>;

  sendMessage(
    chatId: string, text: string, replyToMessageId?: string,
    attachments?: SendMessageAttachment[],
  ): Promise<{ messageId: string; date: number }>;

  sendTypingAction(chatId: string): Promise<void>;
  setMessageReaction(chatId: string, messageId: string, emoji: string | undefined): Promise<void>;
  onDebounceStateChange(chatId: string, isDebouncing: boolean): void;

  loadMessageAttachments(chatId: string, messageId: string): PlatformAttachmentRef[] | undefined;
  downloadMessageMedia(chatId: string, messageId: string): Promise<Buffer | undefined>;
  messageExists(chatId: string, messageId: string): boolean;

  // 平台可选能力：飞书第一版不实现；调用方按 undefined 处理
  banSpammer?: (chatId: string, messageId: string) => Promise<BanSpammerResult>;
  getCustomEmojiInfo?: (ids: string[]) => Promise<CustomEmojiMedia[]>;
}
```

Driver 侧只改“形状”不改语义：

- `createDriver(config, deps)` 里的六个平台回调替换为 `platform: DriverPlatform`；其余 persistence/model/backgroundTask 依赖不动。
- `primary-tools` 的 `sendMessage` 不再 `Number(replyTo)`，直接透传字符串；`send-message.ts`/`react.ts` 的 `messageExists(messageId: string)`。
- `attachment-downloader` 的 `file-id` 解析改成 `lastIndexOf(':')` + 保留字符串 messageId。
- Telegram 平台实现内部保留 `Number(...)`/`serverToTdLibMessageId` 转换，行为不变。
- `DriverConfig` 增加 `platformName`（或从 `platform.name` 取），`wakeup.ts` 不再硬编码 `'telegram'`。这行改动请由 driver 线在它的 prompt 改动里顺带落，或由飞书线在接缝提交中只改这一处并请 driver 线 rebase。

`DriverPlatform` 的 `start/stop` 只负责平台客户端生命周期；ingress 的 live handler 与 post-startup 仍由容器/startup 组装（`PlatformRuntime` token 可选，若不想动 startup 太多，也可以只在 `registerDriver` 里按配置二选一 —— 见下）。

**更懒的替代方案**（若不希望动 startup）：保留 Telegram 的 token 名，新增 `TOKENS.FEISHU_*`，在 `registerDriver` 里 `const platform = config.feishu ? feishuPlatform() : telegramPlatform()`。代价是 startup 仍要处理平台 start/stop/liveHandlers/postStartup，耦合更深。推荐仍取 `PlatformRuntime` 形态，一次改干净。

### 5.3 与记忆/工具预算线的接口依赖（只指出，不实现）

- **Probe 替换（Jev）**：只影响 `src/driver/wakeup.ts` 的 probe 调用与 `probe.model` 配置形状（`decide` 工具的 schema 与 `probe_responses_v2` 落库）。飞书线不依赖 probe 实现，只要求“probe 之后可能沉默”与“@ 是强信号但不是强制回复”最终一致；飞书侧的 `mentionsMe` 已在 RC 段上提供，可直接作为信号输入。
- **有界工具执行**：`maxSteps: Infinity` 与 `checkInterrupt`（新消息延长当前轮）都在 driver 线；飞书线**不得**依赖“新消息延长当前轮”，并应保证 `send_message` 的返回格式（`{ok:true,message_id}`）不变，否则 tool loop 判定会坏。飞书 5 QPS/群 的限流真实存在，工具预算落定前，飞书 hook 只能如实抛出 `rate_limited`。
- **逐人记忆（Mem0/Nowledge/文件）**：按架构约束，外部记忆只能经 late-binding prompt 或工具结果进入，不得改 IC。接口点：`renderLateBindingPrompt` 的参数、`chats.<id>.systemFiles`、以及稳定的 `CanonicalUser.id`（=飞书 open_id）。`events.sender` 已含 `id/displayName/username/isBot`，如需 `union_id`/`user_id` 需要在 `CanonicalUser` 上扩展字段（建议第一版就预留 JSON 字段，避免二次迁移）。
- **维护者鉴权**：来自可信配置（`maintainers.yaml`），不得从聊天内容/记忆推断；飞书线只负责提供稳定 open_id。

---

## 6. 验收测试与需要的用户配置

### 6.1 单元/回放测试（CI，不连网）

1. **适配回放**：录制的原始事件 JSON fixture（text 带 @、post 带 md、引用、话题、撤回、成员加入、改名、bot 入群）→ `CanonicalIMEvent` 快照测试；断言 `messageId`/`chatId` 都是字符串、mention userId = open_id、`replyToMessageId = parent_id`。
2. **去重**：同一 `message_id` 事件投递两次（模拟 3 秒重推/重启重放），断言 `events` 只新增一行、pipeline 只收到一次。
3. **ID 接缝**：`send_message.reply_to = "om_x"`、`react.message_id = "om_x"`、`file-id = "om_x:0"` 都能正确解析；非法 ID 被拒绝且不调用平台 API。
4. **发送渲染**：Markdown → post/md JSON 的包装与分片；`uuid` 存在且每次不同；synthetic self-event 的 `isSelfSent=true` 且不唤醒 Driver。
5. **撤回**：`recalled_v1` → canonical delete → 渲染 `<message deleted="true"/>`。
6. **回归保护**：Telegram 适配/管理器的现有测试全部保持通过（接缝提交的核心验收）。
7. **SDK 兼容**：对 `normalize()` 输出做一次“锁定行为”的测试；升级 `@larksuiteoapi/node-sdk` 时若解析结构变了会失败。

### 6.2 手工联调清单（需要真实租户）

1. 群里普通发言（无 @）能被归档并进入 IC/RC；`im:message.group_msg` 未开时只能收到 @ 消息（预期行为）。
2. 机器人能看到自己的发言（synthetic self-event），且 probe 前不会因为看不到自己而重复回应。
3. @ 机器人、@all、回复机器人、话题内回复，四种情况下的 `mentionsMe`/`repliesToMe` 正确。
4. 重启进程：历史 RC 正确重建、无重复事件、去重仍生效（重启后重推同一 message_id 不重复）。
5. 断线 30 秒后重连：补洞能补齐期间消息（若开启），且不重复。
6. 撤回一条群消息：IC 中该消息变 deleted，模型可见。
7. 连续发送超过 5 QPS/群：错误被如实返回，不出现静默丢消息。
8. 长消息（>4000 字符）：分片、顺序正确、reply 只在首条。
9. 表情：加/删各一次；删的是自己加的那个。
10. 长连接与 CLI `event consume` **不同时**运行。

### 6.3 需要用户（应用管理员）配置的权限与开关

**权限（在开发者后台“权限管理”中申请）**：

- 收消息：`im:message`（群全量消息另需 **`im:message.group_msg`**，敏感权限）；群 @：`im:message.group_at_msg:readonly`；单聊：`im:message.p2p_msg:readonly`。
- 发消息：`im:message:send_as_bot`（或 `im:message`）。
- 撤回事件：`im:message` 或 `im:message:readonly`。
- 表情：`im:message.reactions:write_only`；收表情事件另需 `im:message.reactions:read`。
- 附件：`im:resource`（第一版不启用，可暂不申请）。
- 群信息/成员：`im:chat`（或 `im:chat:readonly` / `im:chat.members:read`）。
- 昵称解析：`contact:user.base:readonly`（**待验证**确切名称；`user_id` 另需 `contact:user.employee_id:readonly`）。

**事件订阅（“事件与回调”页面）**：

- `im.message.receive_v1`（必需）
- `im.message.recalled_v1`
- `im.chat.member.user.added_v1`、`im.chat.member.user.deleted_v1`
- `im.chat.updated_v1`、`im.chat.member.bot.added_v1`（拿群名/入群）
- 可选：`im.message.reaction.created_v1` / `im.message.reaction.deleted_v1`

**其他**：

- 开启机器人能力，事件订阅方式选**长连接**（必须在本地客户端在线时保存成功）。
- **发布应用版本**（权限与事件变更需发版；企业自建应用可能需管理员审批）；配置**可用范围**（用户不在可用范围内的单聊会失败 230013）。
- 配置 `config.yaml` 的 `feishu.appId/appSecret/domain`，以及 `chats."oc_xxx"`。
- 建议把该 app **只给 LarkBot 进程**使用（长连接集群模式 + 单实例）。

### 6.4 建议的落地顺序（每步可独立验收）

1. **接缝提交**：`DriverPlatform` 接口 + string ID + `im/` 移动 + Telegram 适配；不接飞书，测试全绿。
2. **配置与启动**：`feishu` 配置段、`PlatformRuntime`、`tdl.configure` 惰性化；飞书空实现也能 `pnpm start` 到“客户端就绪”日志。
3. **只读 ingress**：收消息 → 落库 → pipeline → 日志/RC 可见；补齐 dedup 与撤回/服务事件。
4. **出站**：send（text 先跑通，再做 post/md）→ synthetic self-event → 完整回合闭环。
5. **补洞 + 联调清单**：断线补洞、@/引用/话题、长消息、限流错误。
6. **提示词与频道名**：与 driver/人设线一起把 `currentChannel` 与 Telegram 专属措辞改掉。

---

## 7. 风险与未验证项

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `im:message.group_msg` 批不下来（敏感权限/管理员审批） | 机器人只能收到 @ 消息，无法旁听 | 先按 @ 模式跑通；把“旁听”作为显式配置能力，缺权限时日志提示 |
| 长连接集群模式 + 单实例锁 | 多开/CLI 并跑会随机丢事件 | 文档化“一个 app 只跑一个客户端”；实现启动时的单实例检测（参考 Hermes app lock） |
| 3 秒处理超时 | 触发重推、被限流 | ingress 立即返回、重活丢队列；去重按 message_id |
| 编辑不可见 | IC 与群内实际内容可能不一致 | 文档写明；后续用 `updated`/`update_time` 在拉取路径补 |
| 昵称解析 scope/审批 | 模型只看到 `ou_xxx` | 通讯录解析 + 缓存 + 失败回退；也可先用群成员列表补名 |
| 无限工具循环 + 5 QPS/群限流 | 回复慢、限流报错、刷屏（与 Hermes 的痛点同源） | 由 driver 行为线实现有界预算；飞书 hook 只透传错误 |
| 历史可见范围未验证 | 用户误以为能看到全部历史 | 不做“全量历史导入”的承诺；补洞只承诺“在线期间 + 断线窗口” |
| `normalize()` 是较新 API | SDK 升级可能改行为 | 锁版本 + 行为锁定测试 |
| AstrBot 是 AGPL | 复制代码会引入许可问题 | 只参考行为，不复制代码；本项目上游也尚无公开 LICENSE，需遵守 Menci 的授权范围 |

---

## 8. 证据链接汇总

**官方文档（`open.feishu.cn`，URL 后加 `.md` 可取原文）**

- 接收消息事件（权限、message_id 去重）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive>
- 长连接模式（3 秒、50 连接、集群模式、仅自建应用）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- 用户身份概述（open_id/user_id/union_id）：<https://open.feishu.cn/document/home/user-identity-introduction/introduction>
- 消息管理概述（root/parent/thread/updated）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro>
- 接收消息内容结构：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content>
- 撤回消息事件：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/recalled>
- 发送消息（限频、uuid、消息类型）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create>
- 发送内容与 Markdown（`post`+`md`）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json>
- 回复消息：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply>
- 撤回消息接口：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/delete>
- 获取历史消息：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list>
- 获取指定消息：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/get>
- 表情回复创建：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/create>
- 表情回复事件：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/events/created>
- 群成员列表：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/get>
- 群信息：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get>
- 消息资源下载：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get>

**官方 SDK / CLI**

- node-sdk（MIT，`b188be60134d409b61259546bcf69c731d2b0b7c`，1.76.0）：<https://github.com/larksuite/node-sdk>
  - `channel/channel.ts`：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/channel.ts>
  - `channel/safety/dedup-cache.ts`：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/safety/dedup-cache.ts>
  - `docs/channel.md`：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/docs/channel.md>
  - `code-gen/events-template.ts`（`im.message.recalled_v1` 在 `#L4309`，`im.message.receive_v1` 在 `#L4426`）：<https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/code-gen/events-template.ts>
  - `channel/normalize`：<https://github.com/larksuite/node-sdk/tree/b188be60134d409b61259546bcf69c731d2b0b7c/channel/normalize>
- larksuite/cli（MIT，`017b19a793ad71794a02887ede04757f3d82e10d`）：<https://github.com/larksuite/cli>
  - `skills/lark-event/SKILL.md`、`skills/lark-event/references/lark-event-im.md`、`skills/lark-im/SKILL.md`、`affordance/im.md`
  - README 安全警告：<https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/README.zh.md>
- lark-openapi-mcp：<https://github.com/larksuite/lark-openapi-mcp>（`21920354ec6e3966b52e89152620c5085e496b55`）

**第三方参考实现**

- nanobot（MIT，`67248790c76b150af39dab5026608ee2c449b0d3`）：<https://github.com/HKUDS/nanobot/tree/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu>
- hermes-agent（MIT，`53bec2a311979ad6f77580ba491eca261ab988e0`）：<https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py>
- AstrBot（**AGPL-3.0，只读参考**，`9441402872f65fffc35685b0ead5bd3337033cb2`）：<https://github.com/AstrBotDevs/AstrBot/tree/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark>

**本仓库代码锚点**

- 平台→canonical：`src/telegram/adaptation.ts`、`src/telegram/message/tdlib.ts`
- 入口与发布：`src/telegram/manager.ts`、`src/telegram/live-handlers.ts`、`src/telegram/event-sink.ts`
- ID 数字耦合：`src/telegram/message/types.ts`（`messageId: number`）、`src/db/schema.ts`（`messages.messageId integer`）、`src/db/persistence.ts`（`loadMessageAttachments`/`messageExists`）
- Driver 接缝：`src/driver/index.ts`、`src/driver/primary-tools.ts`、`src/driver/tools/send-message.ts`、`react.ts`、`attachment-downloader.ts`
- 出站与自事件：`src/telegram/driver-hooks.ts`、`src/telegram/bot.ts`
- 启动与 DI：`src/startup/index.ts`、`src/container/**`
- 提示词频道名：`src/driver/wakeup.ts`、`prompts/system.velin.md`、`prompts/late-binding.velin.md`
