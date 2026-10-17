# 飞书接入实现说明（第一版）

> Historical agent handoff snapshot. Coordinator changes supersede the integration TODOs and budget/error guarantees below; see [integration-status.md](integration-status.md) for current behavior and verification.

日期：2026-10-16 · 分支：`feat/feishu-adapter` · 状态：已实现，离线测试通过；**未联机验证**（没有读取真实凭证，没有建立 WS 连接，没有发送消息）。

本文记录第一版飞书接入实际实现了什么、怎么配置、怎么手动联调，以及已知限制。调研背景见调研报告（`research-feishu-integration` 分支的 `docs/feishu-integration-research.md`）。

## 1. 范围

### 已实现

- 只接收**已配置的群聊**（`chats` 中的 `oc_...` 键）。私聊和未配置的群直接丢弃，不归档。注意这与 Telegram 不同：Telegram 会归档未配置的会话。
- 入站消息类型：`text`、`post`。文本中的 `@_user_N` / `@_all` 占位符、post 中的 `at` 元素都转换为 `mention` 节点，`userId` 是 open_id，因此 Rendering 能正确计算 `mentionsMe`。post 的粗体、斜体、下划线、删除线、行内代码、链接、代码块都会保留。
- 其他消息类型（图片、文件、语音、视频、表情包、卡片、合并转发等）显示为 `[image]`、`[unsupported message type: x]` 这类占位文本，不带附件。
- 引用：`parent_id` 映射为 `replyToMessageId`。引用内容复用 Projection 的 IC 快照，只有父消息已在上下文中时才能显示；不另外调用 API 拉取父消息。
- 撤回：`im.message.recalled_v1` 映射为 canonical `delete`。
- 发送者身份：`CanonicalUser.id` 取 open_id（应用内稳定）；`isBot = sender_type !== 'user'`。昵称来源依次是通讯录 API（等待上限 1 秒，结果缓存 6 小时，失败后 10 分钟内不重试）、本进程见过的 @ 名字、IC 中的历史名字；都没有时为空，Rendering 回退显示 open_id。
- 发送：`post` 消息，内容是单个 `md` 元素（CommonMark + GFM）；有 `reply_to` 时调用 reply 接口。
- 发送 @：模型在 `send_message` 文本里写 `<at user_id="ou_...">名字</at>`，`src/feishu/post-content.ts` 校验后原样放进 `md` 元素（飞书 md 扩展语法）。open_id 必须是本群见过的参与者（本进程见过的发送者或被 @ 者，或 IC 中的历史发送者），否则工具报错；不支持 @所有人；代码块和行内代码里的标签按字面发送。飞书模式下 chatlog 的 `<message>` 带 `uid` 属性，供模型复制 open_id；Telegram 渲染不变。
- Synthetic self-event：每次发送成功后，用服务端返回的 `message_id` 写入一条 `isSelfSent=true` 的 canonical 事件，再发布到 Pipeline，不唤醒 Driver。飞书不会把机器人自己的消息推回来，所以机器人只能通过这条路径看到自己说过的话。
- 去重和崩溃恢复，见 §3。
- 表情：为常用 Unicode emoji 做了 `emoji_type` 映射（含 😏 `SMIRK`、😎 `SMART`）。未映射的 emoji 直接报错，不会假装成功；移除表情需要本进程记录的 `reaction_id`，重启后无法移除或替换之前加的表情，同样会报错。

### 未实现（后续工作）

媒体收发、`download_file`、`read_image(file_id)`、消息编辑同步（飞书没有编辑事件）、话题 / `thread_id`、断线补洞（拉取历史）、成员进出与群改名等服务事件、入站表情事件、私聊、卡片与流式输出、`ban_spammer`、正在输入提示、发送超长消息时自动分片。

模型看不到不支持的工具：飞书模式下不暴露 `download_file`、`ban_spammer`，`send_message` 的 schema 里也没有 `attachments`。`read_image` 保留，因为它的 `path` 参数仍然可用；传入 `file_id` 会得到明确的错误。

## 2. 公共接缝（供父 agent 审查）

| 接缝 | 位置 | 说明 |
| --- | --- | --- |
| `DriverPlatform` | `src/driver/platform.ts` | Driver 面向平台的能力集合。消息 ID 一律是 string。可选成员（`loadMessageAttachments`+`downloadMessageMedia`、`banSpammer`）缺失时，对应工具和参数不暴露给模型。`createDriver` 的 deps 是 `Omit<DriverPlatform,'name'>` 再加上原有依赖，字段名与之前保持一致（平铺）。 |
| Telegram 适配 | `src/telegram/driver-platform.ts` | 只有这里会把 string 转回 TDLib 用的 number（`parseTelegramMessageId` / `requireTelegramMessageId`，位于 `message/id-conversion.ts`）。非数字 ID 不会传到 TDLib。 |
| 平台生命周期 | `src/startup/platform.ts` | `PlatformIdentity`（`prepare`、`botUserId`）和 `PlatformRuntime`（`startIngress`、`start`、`stop`、`runPostStartup`）。startup 不再引用 Telegram token。 |
| 平台选择 | `src/container/registrars/platform.ts` | 根据 `config.platform` 把 `PLATFORM_IDENTITY`、`PLATFORM_RUNTIME`、`DRIVER_PLATFORM` 解析到对应实现。工厂是惰性的，未选中的平台不会被构造。 |
| TDLib 惰性化 | `src/container/registrars/telegram.ts` | `tdl.configure` 从 `startup/index.ts` 的模块顶层挪到 `TELEGRAM_CLIENTS` 工厂里，飞书模式不会加载 libtdjson。 |
| EventSink | `src/event-sink.ts` | 原 `src/telegram/event-sink.ts` 原样移动并改名（`TelegramEventSink` → `EventSink`，token 改为 `EVENT_SINK`），逻辑不变。 |
| 去重键 | `events.dedup_key` + 唯一索引 `(chat_id, dedup_key)` | 迁移 `drizzle/0033_events_dedup_key.sql`。Telegram 写入 NULL，SQLite 中多个 NULL 不冲突。新增 `persistDedupedEvent`、`hasEventDedupKey`、`canonicalMessageExists`。 |
| 工具 | `send-message.ts`、`react.ts`、`attachment-downloader.ts`、`ban-spammer.ts` | 改为 string ID；`file-id` 按最后一个冒号拆分，消息 ID 部分不再要求是数字；错误信息中的 “TDLib” 改为 “the platform API”。 |

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
  credentialsFile: ".config/feishu_cn.env"   # 默认值，可省略
chats:
  default:
    sendTypingAction: false   # 飞书没有机器人“正在输入”API；保持 true 也只是空操作
    # tools.banSpammer 必须为 false，否则启动时报错
  "oc_xxx": {}               # 目标群 chat_id
```

- 飞书模式下不需要 `telegram` 段；Telegram 模式（默认）仍然必填。
- 凭证文件采用 dotenv 格式。程序读取 `FEISHU_APP_ID`（必须形如 `cli_` + 16 位十六进制）、`FEISHU_APP_SECRET`、`FEISHU_DOMAIN`（可选：`feishu`、`lark` 或 `https://` 基础 URL，默认 `feishu`）。`REGION`、`CHAT_ID` 不读取；群 ID 写在 `chats` 里。
- 凭证值只在内存中使用：不写入 `process.env`（bash 工具的子进程会继承它），出错时只报 key 名或行号，SDK 日志会删掉 `config`、`headers`、`*token*`、`app_secret` 等字段，再替换掉 app secret 本身。
- `.config/` 已加入 `.gitignore`。

## 5. 飞书后台需要的权限与事件

最小集如下，需要发布版本后生效；`im:message.group_msg` 是敏感权限，可能要管理员审批：

- 接收群消息：`im:message.group_msg`（旁听全部群消息）；只开 `im:message.group_at_msg:readonly` 时只能收到 @ 机器人的消息。
- 发送和回复：`im:message:send_as_bot`。
- 撤回事件：`im:message` 或 `im:message:readonly`。
- 表情：`im:message.reactions:write_only`（或 `im:message`）。
- 昵称：`contact:user.base:readonly`（确切名称待验证；缺少时自动降级为 @ 名或 open_id）。
- 事件订阅方式选“长连接”，订阅 `im.message.receive_v1`、`im.message.recalled_v1`。
- 一个应用只能运行一个长连接消费者：不要同时运行第二个 LarkBot 进程或 `lark-cli event consume`，否则事件会被随机分到其中一个。

## 6. 离线验证结果

依赖已安装：执行 `pnpm install --frozen-lockfile --ignore-scripts`，然后 `pnpm rebuild` 了 better-sqlite3、sharp、esbuild、unrs-resolver、ffmpeg-static，并运行 `pnpm tdlib:types`。SDK 通过 `pnpm add @larksuiteoapi/node-sdk@1.76.0` 加入。本机缺少 `rlottie` 头文件，lottie-frame 没有编译。

- `pnpm lint`：通过。
- `pnpm build`：通过。
- `pnpm test:run`：490 个测试中 486 个通过。4 个失败都与本分支无关：3 个 TGS 测试需要原生 lottie-frame；`probe-vs-primary` 中断言 “evaluator's notes” 的那个测试，在本分支未改动的 prompt 和测试文件上同样失败。
- `pnpm typecheck`：剩 5 个错误。4 个是 §9.2 中两个 Driver 行为测试的类型补丁（不在本线修改范围内）；1 个是已有的 `markdown-it-math-loose` 缺少类型声明。
- 新增测试：`src/feishu/{credentials,content,user-names,reactions,ingress}.test.ts`、`src/telegram/driver-platform.test.ts`、`src/config/platform-config.test.ts`、`src/container/feishu-mode.test.ts`。最后一个用合成凭证和 mock 掉的 SDK 构建完整容器，并断言 `tdl.configure` 和 `tdl.createClient` 都没有被调用。
- 离线确认：node-sdk 1.76.0 的 CJS 命名导出在 Node ESM 和 tsx 下都能通过 `import * as lark` 取到。

## 7. 手动联调步骤（需用户另行确认后执行）

1. 依赖安装同上。完整安装需要先装系统包 `rlottie`（只影响 Telegram TGS 贴纸）。
2. 运行 `pnpm typecheck && pnpm lint && pnpm test:run && pnpm build`。
3. 准备 `config.yaml`（见 §4），先只配一个测试群。
4. 运行 `pnpm start`，日志里应出现 `Feishu long connection ready` 和 `Cahciua is running`；不应加载 TDLib。
5. 在群里依次验证：普通发言入库（`events` 表出现 `dedup_key = 'message:om_...'`）；@ 机器人时 RC 中带 `mentionsMe`；引用机器人消息时带 `repliesToMe`；机器人回复后，`events` 中出现 `is_self_sent = 1` 的行；撤回后 RC 中该消息标记为 `deleted="true"`。
6. 在处理过程中重启进程：确认没有重复事件、冷回放正确、重推被跳过。
7. 验证表情：加一次、换一次、移除一次；再用一个未映射的 emoji 确认会报错。
8. 连续快速发送，观察限流错误是否如实返回。

## 8. 未验证事项与限制

- `src/feishu/sdk.ts` 已通过类型检查，但从未连接过真实服务。用到的接口有 `im.v1.message.create/reply`、`im.v1.messageReaction.create/delete`、`contact.v3.user.get`、`Client.request`（`/open-apis/bot/v3/info`）、`WSClient` 和 `EventDispatcher`。
- 尚未确认 `FEISHU_DOMAIN` 的实际取值格式；值不符合 §4 中的格式时，启动会报错（错误信息不包含值）。
- 机器人被 @ 时，`mentions[].id.open_id` 是否等于 `/bot/v3/info` 返回的 open_id：参考实现都按相等处理，需实测。
- 收到的 post 中，`at` 元素按文档使用 `@_user_N` 占位符；代码同时兼容直接给出 open_id 的情况。
- 文本消息里的 `[文本](url)` 链接按纯文本保留，不解析成链接节点。
- 提示词仍写的是 Telegram（见 §9）。
- `ban_spammer` 的 `tg://` 公告等 Telegram 专属逻辑保持不变，飞书模式下不启用。

## 9. 交给父 agent 集成的事项

以下文件不在本线修改范围内，这里给出建议补丁：

1. **`src/driver/wakeup.ts` 的 `currentChannel`**（两处硬编码 `'telegram'`）。建议给 `executeWakeup` 增加参数 `currentChannel: string`，替换这两处 `currentChannel: 'telegram'`。`src/driver/index.ts` 调用时传入平台名，需要在 `createDriver` 的 deps 中加上 `platformName: DriverPlatform['name']`（`registrars/driver.ts` 中由 `platform.name` 提供）。本分支没有改 `wakeup.ts`，所以 deps 里暂时没有这个字段。
2. **Driver 行为测试的类型补丁**：`src/driver/driver-characterization.test.ts` 和 `src/driver/probe-vs-primary.test.ts` 中，`sendMessage` mock 返回的 `messageId: 1` / `999` 是 number，类型上需要改成 `'1'` / `'999'`（多余的 `date` 字段可以留着）。这只影响 `tsc`，vitest 运行不受影响。其余 deps 字段名没变，`loadMessageAttachments`、`downloadMessageMedia`、`banSpammer` 只是变成了可选。
3. **提示词**：`prompts/system.velin.md` 写的是 “Telegram group chat”、“Telegram-flavored Markdown” 和 `t.me` 链接前缀，`prompts/late-binding.velin.md` 写的是 “Telegram group chat”。建议按 `currentChannel` 分支：飞书输出的是 CommonMark + GFM（支持表格），不支持 Telegram 的 spoiler；@ 某人需要写 `<at user_id="ou_...">名字</at>`（本版未接入，模型写 `@名字` 只会显示为纯文本）；不提供消息深链。
4. **`AGENTS.md`**：Ownership 中的 `telegram/` 不再包含 event-sink，需要新增 `src/feishu/` 和 `src/event-sink.ts`；“Telegram Clients And Ingress” 一节中 event-sink 的位置要更新；Startup order 改为 “migrate → platform identity prepare → cold replay → … → platform start”；Configured chats 一节注明飞书不归档未配置的会话；记录 `events.dedup_key`。`docs/telegram-module-architecture.md` 如果引用了 event-sink 的路径，也需要同步。
