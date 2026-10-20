# 飞书接入实现说明（第一版）

> Historical agent handoff snapshot. Coordinator changes supersede the integration TODOs and budget/error guarantees below; see [integration-status.md](integration-status.md) for current behavior and verification.

日期：2026-10-16 · 分支：`feat/feishu-adapter` · 状态：已实现，离线测试通过；**未联机验证**（没有读取真实凭证，没有建立 WS 连接，没有发送消息）。

> 2026-10-17 补充（`feat/feishu-images`）：入站图片已接入 canonical 附件与 `read_image(file_id)` / `download_file`，见 §1.1、§2、§9.5。

> 2026-10-17 联机验证：真实群聊里已跑通 @ 提及、图片 `read_image`、引用回复、表情、synthetic self-event、重启回放/去重和断线重连。通讯录昵称 API 对权限范围外的成员返回 `41050`，昵称回退为早前见过的名字；图片仍无被动描述。

本文记录第一版飞书接入实际实现了什么、怎么配置、怎么手动联调，以及已知限制。调研背景见调研报告（`research-feishu-integration` 分支的 `docs/feishu-integration-research.md`）。

## 1. 范围

### 已实现

- 只接收**已配置的群聊**（`chats` 中的 `oc_...` 键）。私聊和未配置的群直接丢弃，不归档。注意这与 Telegram 不同：Telegram 会归档未配置的会话。
- 入站消息类型：`text`、`post`、`image`。文本中的 `@_user_N` / `@_all` 占位符、post 中的 `at` 元素都转换为 `mention` 节点，`userId` 是 open_id，因此 Rendering 能正确计算 `mentionsMe`。post 的粗体、斜体、下划线、删除线、行内代码、链接、代码块都会保留。
- 其他消息类型（文件、语音、视频、表情包、卡片、合并转发等）显示为 `[image]`、`[unsupported message type: x]` 这类占位文本，不带附件（图片除外，见 §1.1）。
- 引用：`parent_id` 映射为 `replyToMessageId`。引用内容复用 Projection 的 IC 快照，只有父消息已在上下文中时才能显示；不另外调用 API 拉取父消息。
- 撤回：`im.message.recalled_v1` 映射为 canonical `delete`。
- 发送者身份：`CanonicalUser.id` 取 open_id（应用内稳定）；`isBot = sender_type !== 'user'`。昵称来源依次是通讯录 API（等待上限 1 秒，结果缓存 6 小时，失败后 10 分钟内不重试）；通讯录拿不到名字时，用本群成员列表（`im.v1.chatMembers.get`，只需群权限，也能覆盖通讯录范围外和外部成员，不含机器人；按群缓存 6 小时，等待上限同样 1 秒，列表里没有此人时 10 分钟后才重新拉取）；再往后是本进程见过的 @ 名字、IC 中的历史名字；都没有时为空，Rendering 回退显示 open_id。已存档消息保留当时的发送者快照，不会因为后来学到名字而改写（保持前缀缓存稳定）；需要给历史消息补名字时用 `contacts.json`。
- 发送：`post` 消息，内容是单个 `md` 元素（CommonMark + GFM）；有 `reply_to` 时调用 reply 接口。
- 发送 @：模型在 `send_message` 文本里写 `<at user_id="ou_...">名字</at>`，`src/feishu/post-content.ts` 校验后原样放进 `md` 元素（飞书 md 扩展语法）。open_id 必须是本群见过的参与者（本进程见过的发送者或被 @ 者，或 IC 中的历史发送者），否则工具报错；不支持 @所有人；代码块和行内代码里的标签按字面发送。飞书模式下 chatlog 的 `<message>` 带 `uid` 属性，供模型复制 open_id；Telegram 渲染不变。
- Synthetic self-event：每次发送成功后，用服务端返回的 `message_id` 写入一条 `isSelfSent=true` 的 canonical 事件，再发布到 Pipeline，不唤醒 Driver。飞书不会把机器人自己的消息推回来，所以机器人只能通过这条路径看到自己说过的话。
- 去重和崩溃恢复，见 §3。
- 表情：为常用 Unicode emoji 做了 `emoji_type` 映射（第一版 30 个，2026-10-17 又补约 37 个，含 😏 `SMIRK`、😎 `SMART`）。未映射的 emoji 直接报错，不会假装成功；移除表情需要本进程记录的 `reaction_id`，重启后无法移除或替换之前加的表情，同样会报错。

### 1.1 入站图片与 file_id

- `image` 消息的 `image_key`，以及 post 中每个 `tag=img` 元素的 `image_key`，都会转成 canonical photo 附件。`image_key` 作为附件对象上的 `fileKey` 属性一起持久化到 `events.attachments`，下载时用它调消息资源接口。post 的 `media` 元素虽然也带 `image_key`（视频封面），但不会被当成图片。
- 图片不再产生 `[image]` 占位文本；解析失败（拿不到 key）时才保留占位符。
- Rendering 按共享规则把附件渲染成 `<attachment type="photo" ... file-id="<message_id>:<index>"/>`（多图 post 每个图一个 index），模型把这个 `file-id` 传给 `read_image` / `download_file`。下载链路：`file-id` → `(message_id, index)` → 从已落库事件取第 index 个附件的 `image_key` → `GET /open-apis/im/v1/messages/{message_id}/resources/{image_key}?type=image`。共享下载器会校验 `0 <= index < attachments.length`，越界报平台无关的错误。
- 下载在流式读取时 20 MB 截断（`readMessageResourceStream`），Content-Length 超限会在读流前直接拒绝，否则边读边计数；总读取超时 30 s，到点 destroy 流。超限/超时是本模块自己的错误，原样返回；流中途的传输错误会过一遍 `toApiError` 再返回模型，避免把请求细节带进工具结果。
- 2026-10-17 联机验证：真实群聊图片已用 `read_image(file_id)` 成功读取；多图 post、尺寸与 MIME 未逐项核对。

### 未实现（后续工作）

媒体出站（发送附件）、图片的被动描述（`imageToText` 不会自动为收到的图片生成 alt text，模型必须显式调用 `read_image(file_id)`）、消息编辑同步（飞书没有编辑事件）、话题 / `thread_id`、断线补洞（拉取历史）、成员进出与群改名等服务事件、入站表情事件、私聊、卡片与流式输出、`ban_spammer`、正在输入提示、发送超长消息时自动分片。

`read_image` 一直保留，因为它的 `path` 参数仍然可用。飞书模式下 `download_file` 和 `read_image(file_id)` 已暴露（需要 `im:resource`），`send_message.attachments` 不暴露（`supportsOutboundAttachments` 未声明）；实际取字节前如果附件没有 `fileKey`（升级前归档的旧消息），会得到一条明确的错误。`ban_spammer` 在飞书模式不暴露。

## 2. 公共接缝（供父 agent 审查）

| 接缝 | 位置 | 说明 |
| --- | --- | --- |
| `DriverPlatform` | `src/driver/platform.ts` | Driver 面向平台的能力集合。消息 ID 一律是 string。可选成员（入站 `loadMessageAttachments`+`downloadMessageMedia`、出站 `supportsOutboundAttachments`、`banSpammer`）缺失时，对应工具和参数不暴露给模型。`createDriver` 的 deps 是 `Omit<DriverPlatform,'name'>` 再加上原有依赖，字段名与之前保持一致（平铺）。 |
| Telegram 适配 | `src/telegram/driver-platform.ts` | 只有这里会把 string 转回 TDLib 用的 number（`parseTelegramMessageId` / `requireTelegramMessageId`，位于 `message/id-conversion.ts`）。非数字 ID 不会传到 TDLib。 |
| 平台生命周期 | `src/startup/platform.ts` | `PlatformIdentity`（`prepare`、`botUserId`）和 `PlatformRuntime`（`startIngress`、`start`、`stop`、`runPostStartup`）。startup 不再引用 Telegram token。 |
| 平台选择 | `src/container/registrars/platform.ts` | 根据 `config.platform` 把 `PLATFORM_IDENTITY`、`PLATFORM_RUNTIME`、`DRIVER_PLATFORM` 解析到对应实现。工厂是惰性的，未选中的平台不会被构造。 |
| TDLib 惰性化 | `src/container/registrars/telegram.ts` | `tdl.configure` 从 `startup/index.ts` 的模块顶层挪到 `TELEGRAM_CLIENTS` 工厂里，飞书模式不会加载 libtdjson。 |
| EventSink | `src/event-sink.ts` | 原 `src/telegram/event-sink.ts` 原样移动并改名（`TelegramEventSink` → `EventSink`，token 改为 `EVENT_SINK`），逻辑不变。 |
| 去重键 | `events.dedup_key` + 唯一索引 `(chat_id, dedup_key)` | 迁移 `drizzle/0033_events_dedup_key.sql`。Telegram 写入 NULL，SQLite 中多个 NULL 不冲突。新增 `persistDedupedEvent`、`hasEventDedupKey`、`canonicalMessageExists`。 |
| 工具 | `send-message.ts`、`react.ts`、`attachment-downloader.ts`、`ban-spammer.ts` | 改为 string ID；`file-id` 按最后一个冒号拆分，消息 ID 部分不再要求是数字；错误信息中的 “TDLib” 改为 “the platform API”。 |
| 飞书入站附件 | `src/feishu/{content,adaptation,driver-platform,api,sdk}.ts` + `container/registrars/feishu.ts` | `parseFeishuAttachments` 提取 `image_key`，adaptation 写入共享 `CanonicalAttachment.fileKey`。registrar 把 `loadMessageAttachments`（用 `loadEventsByMessageIds` 同步读归档附件）和 `getMessageResource`（SDK 字节传输）接给 `createFeishuDriverPlatform`；两者成对出现，入站能力生效。 |
| 消息资源下载 | `FeishuApi.getMessageResource` + `src/feishu/sdk.ts` | 调 `client.im.v1.messageResource.get`，返回流由 `readMessageResourceStream` 读成 Buffer：20 MB 上限（Content-Length 预检 + 边读边计数）、30 s 总读取超时、错误按本地错误 vs `toApiError` 分流。 |

刻意没有做：通用插件框架、平台注册中心、预留字段、用 SDK 的 `Channel`。SDK 的 `normalize()` 也没有用：它会把 mention 压平成 `@名字` 文本，默认还会删掉对机器人的 @，丢失 open_id 和位置，`mentionsMe` 就无法计算。

## 3. 去重与崩溃恢复

- 去重键按动作区分：`message:<message_id>`、`recall:<message_id>`。撤回不会被同一条消息的去重键吞掉，反之亦然。
- WS 事件处理器（SDK 等处理器 resolve 后才 ack）在 canonical 事件**落库之后**才返回，所以已经 ack 的事件不会丢。
- 同一 chat 内串行处理，Pipeline 发布顺序与到达顺序一致。
- 并发重复投递：第二次投递等待第一次的结果，并返回同样的结果。
- 落库成功、发布前崩溃：重启后冷回放从 `events` 表重建；之后的重复投递会被去重键跳过。
- 进程内发布失败：已落库的事件留在内存里，处理器抛错，飞书会重推；重推到达时只补发布，不重复写库。
- 格式错误的事件只记日志并 ack，因为重推也不会成功。
- 发送：每条逻辑消息一个 `uuid`，同一次发送的所有重试复用它，下一条消息换新的。只对 99991400 限流、HTTP 429/5xx、无响应重试，最多 2 次（间隔 1 秒和 3 秒），最终错误原样返回给工具结果，不会无限静默重试。
- 发送成功但 self-event 写入失败时只记 error 日志，不让工具报错，避免模型重发同一条消息。

## 4. 运行配置

`config.yaml`：

```yaml
platform: feishu
feishu:
  appId: "cli_xxxxxxxxxxxxxxxx"   # 必须形如 cli_ + 16 位十六进制
  appSecret: ""
  domain: "feishu"                # 可选：feishu（默认）、lark 或 https:// 基础 URL
chats:
  default:
    sendTypingAction: false   # 飞书没有机器人“正在输入”API；保持 true 也只是空操作
    # tools.banSpammer 必须为 false，否则启动时报错
  "oc_xxx": {}               # 目标群 chat_id
```

- 飞书模式下不需要 `telegram` 段；Telegram 模式（默认）仍然必填。
- 飞书模式下 `feishu` 段必填，凭证和 Telegram token、模型 API key 一样写在 `config.yaml` 里（该文件已被 git 忽略）。群 ID 写在 `chats` 里。
- 凭证值只在内存中使用：不写入 `process.env`（bash 工具的子进程会继承它），校验报错只说明哪个字段不合法、不回显取值，SDK 日志会删掉 `config`、`headers`、`*token*`、`app_secret` 等字段，再替换掉 app secret 本身。

## 5. 飞书后台需要的权限与事件

最小集如下，需要发布版本后生效；`im:message.group_msg` 是敏感权限，可能要管理员审批：

- 接收群消息：`im:message.group_msg`（旁听全部群消息）；只开 `im:message.group_at_msg:readonly` 时只能收到 @ 机器人的消息。
- 发送和回复：`im:message:send_as_bot`。
- 撤回事件：`im:message` 或 `im:message:readonly`。
- 表情：`im:message.reactions:write_only`（或 `im:message`）。
- 下载消息里的图片 / 文件资源（`read_image(file_id)`、`download_file`）：`im:resource`。缺这个权限时资源接口会返回权限错误；已在 2026-10-17 联机读取真实图片。
- 昵称：通讯录读取权限（`contact.user.get`，如 `contact:user.base:readonly`）。该权限已开通，但还必须把「通讯录权限范围」（contact data range）配成包含群成员：范围外的成员返回 `41050` "no user authority"，此时改用群成员列表的名字（见 §1），再没有才回退为早前见过的名字或 open_id。
- 事件订阅方式选“长连接”，订阅 `im.message.receive_v1`、`im.message.recalled_v1`。
- 一个应用只能运行一个长连接消费者：不要同时运行第二个 LarkBot 进程或 `lark-cli event consume`，否则事件会被随机分到其中一个。

## 6. 离线验证结果

依赖已安装：执行 `pnpm install --frozen-lockfile --ignore-scripts`，然后 `pnpm rebuild` 了 better-sqlite3、sharp、esbuild、unrs-resolver、ffmpeg-static，并运行 `pnpm tdlib:types`。SDK 通过 `pnpm add @larksuiteoapi/node-sdk@1.76.0` 加入。本机缺少 `rlottie` 头文件，lottie-frame 没有编译。

- `pnpm lint`：通过。
- `pnpm build`：通过。
- `pnpm test:run`：490 个测试中 486 个通过。4 个失败都与本分支无关：3 个 TGS 测试需要原生 lottie-frame；`probe-vs-primary` 中断言 “evaluator's notes” 的那个测试，在本分支未改动的 prompt 和测试文件上同样失败。
- `pnpm typecheck`：剩 5 个错误。4 个是 §9.2 中两个 Driver 行为测试的类型补丁（不在本线修改范围内）；1 个是已有的 `markdown-it-math-loose` 缺少类型声明。
- 新增测试：`src/feishu/{content,user-names,reactions,ingress}.test.ts`、`src/telegram/driver-platform.test.ts`、`src/config/platform-config.test.ts`、`src/container/feishu-mode.test.ts`。最后一个用合成凭证和 mock 掉的 SDK 构建完整容器，并断言 `tdl.configure` 和 `tdl.createClient` 都没有被调用。
- 离线确认：node-sdk 1.76.0 的 CJS 命名导出在 Node ESM 和 tsx 下都能通过 `import * as lark` 取到。

2026-10-17 图片接入后重跑（`feat/feishu-images`）：`pnpm typecheck`、`pnpm lint`、`pnpm test:run`（53 files / 527 tests）、`pnpm build` 全部通过。测试覆盖：图片解析、附件能力配对、按 index 下载（含多图 post）、无 `fileKey` 不变式错误、`send_message.attachments` 能力拆分、20 MB 上限与 Content-Length 预检、30 s 超时与流销毁、中途错误的脱敏、registrar 端到端接线（图片事件 → `events.attachments.fileKey` → `getMessageResource` 下载）。`client.im.v1.messageResource.get` 只做了类型检查和模拟 SDK 的单元测试，没有联机验证。

## 7. 手动联调步骤（需用户另行确认后执行）

1. 依赖安装同上。完整安装需要先装系统包 `rlottie`（只影响 Telegram TGS 贴纸）。
2. 运行 `pnpm typecheck && pnpm lint && pnpm test:run && pnpm build`。
3. 准备 `config.yaml`（见 §4），先只配一个测试群。
4. 运行 `pnpm start`，日志里应出现 `Feishu long connection ready` 和 `Cahciua is running`；不应加载 TDLib。
5. 在群里依次验证：普通发言入库（`events` 表出现 `dedup_key = 'message:om_...'`）；@ 机器人时 RC 中带 `mentionsMe`；引用机器人消息时带 `repliesToMe`；机器人回复后，`events` 中出现 `is_self_sent = 1` 的行；撤回后 RC 中该消息标记为 `deleted="true"`。
6. 图片：发一张图片（以及一条多图 post），确认 `events.attachments` 里按顺序出现 `{"type":"photo","fileKey":"img_v3_..."}`，RC 中出现 `<attachment type="photo" ... file-id="om_...:0"/>`、`:1` 等；让机器人 `read_image` 其中任意一个 `file-id`（需要 `im:resource`；未联机验证）。
7. 在处理过程中重启进程：确认没有重复事件、冷回放正确、重推被跳过。
8. 验证表情：加一次、换一次、移除一次；再用一个未映射的 emoji 确认会报错。
9. 连续快速发送，观察限流错误是否如实返回。

## 8. 未验证事项与限制

- `src/feishu/sdk.ts` 已通过类型检查，并已在 2026-10-17 联机使用。用到的接口有 `im.v1.message.create/reply`、`im.v1.messageReaction.create/delete`、`contact.v3.user.get`、`Client.request`（`/open-apis/bot/v3/info`）、`WSClient` 和 `EventDispatcher`。
- 尚未确认 `feishu.domain` 的实际取值格式；值不符合 §4 中的格式时，启动会报错（错误信息不包含值）。
- 机器人被 @ 时，`mentions[].id.open_id` 是否等于 `/bot/v3/info` 返回的 open_id：已在 2026-10-17 联机确认（@ 提及与 `mentionsMe` 正常）。
- 收到的 post 中，`at` 元素按文档使用 `@_user_N` 占位符；代码同时兼容直接给出 open_id 的情况。
- 文本消息里的 `[文本](url)` 链接按纯文本保留，不解析成链接节点。
- 提示词仍写的是 Telegram（见 §9）。
- 图片：`fileKey`（`image_key`）现在声明在共享的 `CanonicalAttachment` 和 `Attachment` 类型上；Telegram 不设置它，继续按 `(chatId, messageId)` 下载。
- 图片下载：多图消息的每个 index 都可下载（共享下载器按 index 取附件）；已在 2026-10-17 联机验证真实图片下载，尺寸和 MIME 未逐项核对。
- 入站图片能力已在 registrar 接好：`read_image(file_id)` / `download_file` 对飞书可用，但需要 `im:resource` 权限；已在 2026-10-17 联机验证。
- `send_message.attachments` 在飞书不暴露：`DriverPlatform.supportsOutboundAttachments` 只在 Telegram 平台为 true，飞书没有声明，工具 schema 里也就没有 `attachments`。
- 被动图片描述未接：`imageToText` 的自动描述链路需要 ingress 在落库前下载图片、生成 `thumbnailWebp` 并调用 `imageToText.resolve`，目前 `src/feishu/ingress.ts` 没有媒体运行时依赖（见 §9.5）。
- `ban_spammer` 的 `tg://` 公告等 Telegram 专属逻辑保持不变，飞书模式下不启用。

## 9. 交给父 agent 集成的事项

以下文件不在本线修改范围内，这里给出建议补丁：

1. **`src/driver/wakeup.ts` 的 `currentChannel`**（两处硬编码 `'telegram'`）。建议给 `executeWakeup` 增加参数 `currentChannel: string`，替换这两处 `currentChannel: 'telegram'`。`src/driver/index.ts` 调用时传入平台名，需要在 `createDriver` 的 deps 中加上 `platformName: DriverPlatform['name']`（`registrars/driver.ts` 中由 `platform.name` 提供）。本分支没有改 `wakeup.ts`，所以 deps 里暂时没有这个字段。
2. **Driver 行为测试的类型补丁**：`src/driver/driver-characterization.test.ts` 和 `src/driver/probe-vs-primary.test.ts` 中，`sendMessage` mock 返回的 `messageId: 1` / `999` 是 number，类型上需要改成 `'1'` / `'999'`（多余的 `date` 字段可以留着）。这只影响 `tsc`，vitest 运行不受影响。其余 deps 字段名没变，`loadMessageAttachments`、`downloadMessageMedia`、`banSpammer` 只是变成了可选。
3. **提示词**：`prompts/system.velin.md` 写的是 “Telegram group chat”、“Telegram-flavored Markdown” 和 `t.me` 链接前缀，`prompts/late-binding.velin.md` 写的是 “Telegram group chat”。建议按 `currentChannel` 分支：飞书输出的是 CommonMark + GFM（支持表格），不支持 Telegram 的 spoiler；@ 某人需要写 `<at user_id="ou_...">名字</at>`（现已接入，见 §1；模型写 `@名字` 仍只是纯文本）；不提供消息深链。
4. **`AGENTS.md`**：Ownership 中的 `telegram/` 不再包含 event-sink，需要新增 `src/feishu/` 和 `src/event-sink.ts`；“Telegram Clients And Ingress” 一节中 event-sink 的位置要更新；Startup order 改为 “migrate → platform identity prepare → cold replay → … → platform start”；Configured chats 一节注明飞书不归档未配置的会话；记录 `events.dedup_key`。`docs/telegram-module-architecture.md` 如果引用了 event-sink 的路径，也需要同步。
5. **被动图片描述（建议，后续工作）**：需要在 `createFeishuIngress` 的 build 阶段加一个可选的 `prepareAttachments?: (event: CanonicalMessageEvent) => Promise<void>` 钩子，由 registrar 用 `MEDIA_RUNTIME` 的 `imageResolvers`、`generateThumbnail` 和 `downloadMessageMedia` 实现：下载图片 → `thumbnailWebp` → `imageToText.resolve`。这样 `EventSink.publish` 里已有的 `hydrateAltText` 会把缓存里的描述回填到附件上。`src/media/**` 本身不需要改。
