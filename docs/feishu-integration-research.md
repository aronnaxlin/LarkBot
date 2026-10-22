# Feishu/Lark Integration Research

Date: 2026-10-16 · Status: **research only, not implemented** · Scope: the smallest incremental plan for Feishu/Lark integration

This document answers only "how to connect Feishu on top of the existing Cahciua code". It implements no code, installs no dependencies, changes no configuration and starts no bot.

Labelling conventions:

- **[Fact]**: backed by code or official documentation / official SDK source, with a link.
- **[Suggestion]**: this document's judgement and recommendation, open to change.
- **[To verify]**: cannot be confirmed from public material and must be tested in a real tenant/app.
- This document makes no value judgement on existing behaviour of the upstream `Menci/Cahciua`; links pointing to repositories are the commits fetched during this research, and the code is read-only and not copied.

---

## 0. Summary of conclusions

1. **[Suggestion] Integration vehicle: the official Node SDK [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk) (MIT, version 1.76.0 checked, commit `b188be60134d409b61259546bcf69c731d2b0b7c`)**. Use `WSClient` + `EventDispatcher` to receive long-connection events, use the `normalize()` exported by the package to normalize raw events into text/markdown + attachment descriptions, produce `CanonicalIMEvent` with our own code, and use `client.im.v1.message.create/reply` for outbound. Do not use the SDK's high-level `Channel` module, because it brings a whole set of dedup/policy/rate-limit/batching/queue semantics that would form a second scheduler alongside the Driver's debounce, probe gating and the ingress queue; `normalize()` is exported on its own, so we borrow only its parsing ability.

2. **[Fact] The place that really has to change across the whole path is the seam "message IDs are always strings"**: the Driver's dependency signatures, the `react`/`send_message`/reply validation, the attachment `file-id` parsing and the primary key of the `messages` table all assume `messageId: number`. Feishu's `message_id` looks like `om_xxx`, `chat_id` like `oc_xxx` and a user's `open_id` like `ou_xxx`, none convertible to numbers. Converging this seam into one platform interface is the prerequisite for parallel development (see §5).

3. **[Fact] Feishu events are not replayed in full**: the long connection pushes only while online; the official note says "in special cases duplicate pushes may be received; if you need idempotency please deduplicate by `message_id` and do not rely on `event_id`" (特殊情况下可能会收到重复的推送，如有幂等需求请使用 `message_id` 去重，不要依赖 `event_id`), and the long connection has the limits "processing must complete within 3 seconds or the push times out and is retried" and "cluster mode: with multiple clients only one randomly receives it". So the dedup key must be `message_id` and must survive restarts; there must be gap filling after disconnects, and **it cannot be promised that all history will be visible** (see §2.5/§2.7).

4. **[Fact] The bot's own messages are not pushed back as events** (`im:message.group_msg` explicitly says "does not include bot messages"). The existing "synthetic self-event" mechanism is not an optimization on Feishu but **required**: after every successful send the bot must inject an `isSelfSent=true` canonical event itself, otherwise the bot cannot see what it said.

5. **[Fact] Feishu has no "message edit" event**. In the official Node SDK event table the IM domain has only 13 events, with no edit/update; edits can only be discovered through the `updated`/`update_time` fields when fetching messages. Recalls have their own event `im.message.recalled_v1`. So the first version should support recalls (delete) and not edits (edit), and record this limitation explicitly (see §2.6).

6. **[Suggestion] Scope of the first version**: group chats + p2p text messages, @-mentions, quotes, stable identity, sending, reactions, recalls, member/rename service events, deduplication, gap filling after disconnects. Media, cards/streaming, edits, ban_spammer, typing indicators and a generic plugin framework are all out. The first version **can leave the database schema unchanged**: Feishu events are written only to `events` (canonical), not to the Telegram-specific `messages` table, thereby avoiding the `messages.message_id integer → text` migration (see §4.4).

7. **[Suggestion] Minimum permission set**: `im:message` + `im:message.group_msg` (sensitive, may need administrator approval) + `im:message:send_as_bot` + `im:resource` + `im:chat`/`im:chat.members:read` + `contact:user.base:readonly` (display-name resolution), with event subscriptions `im.message.receive_v1`, `im.message.recalled_v1` and member/chat change events; and enable the long connection in the developer console and publish a version. The full list is in §6.3.

8. **[Suggestion] CLI/MCP is not the integration method for the first version**. The official `larksuite/cli` (MIT, commit `017b19a793ad71794a02887ede04757f3d82e10d`) and `lark-openapi-mcp` suit later use as **tools** for "look up history / look up members / look up documents", and are not suited to run at the same time as a self-built WS client: the long connection of one app is in cluster mode, only one of several clients can receive events, and two ingresses online at once will randomly lose events. The official README also explicitly warns against adding a CLI-connected bot to group chats. See §3.6.

---

## 1. Tracing the existing path (code evidence)

Data flow: **platform event → canonical event → DB → Projection (IC) → Rendering (RC) → Driver (probe/primary) → platform send → synthetic self-event**.

### 1.1 Responsibilities stage by stage

| Stage | Key files | Current implementation notes |
| --- | --- | --- |
| Platform clients | `src/telegram/bot.ts`, `src/telegram/userbot.ts`, `src/telegram/tdjson.ts` | Two TDLib clients; `tdl.configure()` before startup; a send has to wait for `updateMessageSendSucceeded` to get the final id |
| Ingress aggregation | `src/telegram/manager.ts` | Event bus, `ingressQueue` (ordered per chat, unbounded retry on failure, commits only a contiguous prefix); blocking metadata/media hydration |
| Platform→canonical | `src/telegram/adaptation.ts` | `parseContent` parses text+entities into `ContentNode[]`; messages/edits/deletes/service events |
| Persistence | `src/db/persistence.ts` | `persistMessage` (the `messages` table, upsert), `persistEvent` (the `events` table, append-only) |
| Publication | `src/telegram/event-sink.ts` | Configured chat whitelist → hydrate alt text → `pipeline.pushEvent` → `DriverInputBus.handleEvent`; WeakSet/WeakMap make persist/publish/notify idempotent |
| Live handling | `src/telegram/live-handlers.ts` | Platform event → canonical → persist → publish; "ghost edit" detection for edits |
| Projection | `src/projection/reduce.ts`, `src/projection/types.ts` | Pure reducer; edit/delete modify nodes in place; user rename produces a system event; `ICUserState` records first/last seen and message count |
| Rendering | `src/rendering/index.ts` | IC → XML segments; `mentionsMe`/`repliesToMe` are used for waking; `<attachment file-id="messageId:index">` |
| Pipeline | `src/pipeline.ts` | Per-chat IC/RC residency, compact cursor, `getRenderParams` (`botUserId`, `blockedUserIds`) |
| Driver | `src/driver/index.ts` | Assembles deps; per-chat scheduler/compaction/runner; `handleEvent`/`handleTyping` |
| Probe/Primary | `src/driver/wakeup.ts`, `src/driver/runner.ts` | Probe gating; `forceToolChoice: 'any'`; `maxSteps: Infinity`; forced-send fallback when nothing is sent |
| Tools | `src/driver/primary-tools.ts`, `src/driver/tools/*` | `send_message`/`react`/`read_image`/`download_file`/`read_old_messages`/`bash`… |
| Outbound + self-event | `src/telegram/driver-hooks.ts` | Markdown→Telegram HTML; send; `injectSyntheticEvent` writes the `isSelfSent` canonical event (does not wake the Driver) |
| Startup | `src/startup/index.ts`, `src/container/**` | Module top-level `tdl.configure({ tdjson })`; container → cold replay → attach Driver → live handlers → telegram.start → activate → postStartup |
| Configuration | `src/config/config.ts` | `telegram` is required; the `chats.<chatId>` whitelist; `models`/`runtime`/`tools` are platform-independent |

### 1.2 Exact places that must change for Feishu

Ordered from "cannot connect without changing" to "can be added later".

**A. Message/reply ID type: number → string (core)**

- `src/driver/index.ts`: in the deps, `sendMessage` returns `{ messageId: number }`, `banSpammer(messageId: number)`, `setMessageReaction(messageId: number)`, `loadMessageAttachments(messageId: number)`, `messageExists(messageId: number)`, `downloadMessageMedia(messageId: number)`.
- `src/driver/primary-tools.ts`: `replyToMessageId?: number` of `sendMessage`, `replyTo ? Number(replyTo) : undefined`, `String(sent.messageId)`.
- `src/driver/tools/send-message.ts`: `messageExists(messageId: number)`, `Number(reply_to)`, `Number.isFinite` validation.
- `src/driver/tools/react.ts`: `messageExists(messageId: number)`, `Number(message_id)`.
- `src/driver/tools/attachment-downloader.ts`: `file-id` is parsed with `lastIndexOf(':')` + `parseInt(messageId)`; `om_xxx:0` gives `NaN`.
- `src/rendering/index.ts`: `file-id="${messageId}:${index}"` (itself already a string, but the type of the generated ID changes).
- `src/telegram/driver-hooks.ts`, `src/telegram/bot.ts`, `src/telegram/manager.ts`, `src/telegram/moderation*.ts`: convert string back to number inside the Telegram side (`Number(chatId)`, `serverToTdLibMessageId`), converging the conversion points inside the Telegram hook.
- `src/db/persistence.ts`: `persistMessage`/`loadMessageAttachments`/`messageExists`/`persistMessageDelete` use `messages.messageId integer`; `messages.messageId`/`replyToMessageId` in `src/db/schema.ts` are integer. **Suggest that the first version has Feishu go through the `events` table to avoid this migration** (see §4.4).
- `src/db/moderation.ts`: `loadModerationMessageIds` does `cast as integer` on `events.messageId`; this is Telegram-specific, and the first Feishu version just disables `ban_spammer`.

**B. Platform lifecycle and DI**

- The top of `src/startup/index.ts`, `import * as tdl` + `tdl.configure({ tdjson: resolveTdjson() })`, is a module-level side effect: TDLib must be available as soon as the process starts. It must become per-platform initialization.
- `src/container/registrars/telegram.ts`, `tokens.ts`, `registrars/driver.ts`, `registrars/pipeline.ts`, `registrars/media.ts` all hardcode `TELEGRAM_CLIENTS`/`TELEGRAM_MANAGER`/`TELEGRAM_DRIVER_HOOKS`/`TELEGRAM_LIVE_HANDLERS`/`TELEGRAM_POST_STARTUP_TASKS`.
- `botUserId` in `src/pipeline.ts`, and `createModerationService`, `bot.raw()` and `bot.botUserId()` in `src/container/registrars/driver.ts` all have a Telegram shape.
- `src/telegram/event-sink.ts` and `src/telegram/session-ingress-queue.ts` are actually platform-independent (they depend only on `CanonicalIMEvent` and `{chatId}`); recommend moving them as they are to `src/im/` for reuse so Feishu does not copy them.
- `src/telegram/post-startup.ts` is the animation hash backfill, Telegram-specific; an empty implementation for the first Feishu version.

**C. Configuration**

- `ConfigSchema.telegram` is required (`botToken`/`apiId`/`apiHash`). In Feishu mode one should not be forced to fill in Telegram credentials; a `feishu` section must be added and either of the two allowed.
- `chats` whitelist, `blockedUserIds`, `debounce`, `compaction`, `tools` etc. can be reused as they are; chat ids are strings anyway (`oc_xxx`).

**D. Prompts and the "channel name"**

- `src/driver/wakeup.ts` hardcodes `currentChannel: 'telegram'` in two places; `prompts/system.velin.md` (`You are a chatbot, participating in a Telegram group chat.`, Telegram-flavored Markdown, the quoted-reply description) and `prompts/late-binding.velin.md` also say Telegram. **These are files of the driver/persona line**; the Feishu line only supplies a `platformName` parameter and does not change prompt strategy (see §5).

**E. Outbound capability differences (implemented on the Feishu side, not bugs in existing code)**

- Telegram outbound uses `parseTextEntities` + `inputMessageRichMessage`; Feishu has no TDLib parser and needs its own Markdown wrapping (officially recommended `post` + `md` tag, see §2.9).
- Telegram sends typing with `sendChatAction`; **no typing indicator API for a Feishu bot was found** ([to verify]); the Feishu hook should be a no-op, and the chat config set `sendTypingAction: false`.
- `setMessageReaction` passes a unicode emoji in Telegram; Feishu needs the enum `emoji_type` (`SMILE`/`THUMBSUP`…), and deletion needs a `reaction_id` (see §2.9).
- Attachments: Telegram re-downloads with `(chatId, messageId)` through `getMessage`; Feishu calls `message_resource` with `(message_id, file_key, type)`, so the Feishu-side `downloadMessageMedia` needs to find the `file_key` from the stored event content (media is not enabled in the first version, so it may return failure for now).

**F. Parts that need no change**

`src/adaptation/types.ts` (the canonical types are already a platform-independent coarse shape), `src/projection/**`, the main body of `src/rendering/**`, `src/driver/{scheduler,runner,turn-loop,compaction*,context,merge}.ts`, `src/llm/**`, `src/unified-api/**`, `src/media/**` (media connected later; the interface itself is platform-independent), `src/background-task/**`. These are the bulk of "reusing the existing engineering".

---

## 2. Verified facts about the Feishu/Lark platform

The official documentation supports appending `.md` to a URL to get the Markdown directly (the official CLI README states it explicitly: append `.md` to any Open Platform documentation URL). The links below are all originals actually fetched in this research.

### 2.1 Environment and the long connection

**[Fact]**

- The long connection (WebSocket) and webhook subscription methods coexist; the long connection **supports only enterprise self-built apps** (store apps are not supported), needs the local machine to be able to reach the public internet, and needs no public IP/domain.
- After receiving an event it **must finish processing within 3 seconds and not throw**, otherwise a timeout re-push is triggered.
- At most 50 long connections per app.
- Pushes are **cluster mode and do not support broadcast**: when one app deploys several clients, only **one of them, at random**, receives a given event.
- The China edition Feishu and the international edition Lark are distinguished through the SDK's `domain` (`feishu` / `lark`); the AstrBot documentation states explicitly "both the China and the international edition of Feishu support the long connection".
- Official SDK: `@larksuiteoapi/node-sdk` (MIT, 1.76.0), `WSClient.start({ eventDispatcher })` supported since 1.24.0; `Channel.connect()` waits for a real handshake within 15 seconds.
- Events and callbacks are two configuration items in the developer console; `card.action.trigger` callbacks can go over the same long connection (the official CLI docs say explicitly "events are delivered over the existing WebSocket long connection — no additional [URL]", but the Node SDK README says elsewhere that "long-connection mode supports only event subscription, not callback subscription"; **the two statements disagree and must be verified in the target app**).

Evidence:  
- Long-connection mode: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>  
- Node SDK README (long-connection example and notes): <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/README.md#L557>  
- `Channel.connect()`: <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/channel.ts#L103>  
- AstrBot docs (domain and socket/webhook): <https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/docs/zh/platform/lark.md#L81>  
- CLI card callbacks over WS: <https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/skills/lark-im/references/lark-im-card-action-reply.md>

**[Suggestion]** The Feishu process should run only **one** WS client; do not run the CLI's `event consume` or a second instance at the same time, otherwise events are distributed at random and both sides miss events.

### 2.2 Permission for all group messages

**[Fact]** The permissions for `im:message.receive_v1` decide "what can be seen"; they are not one scope:

| Want to receive | Permission needed |
| --- | --- |
| Private chat | `im:message.p2p_msg` or `im:message.p2p_msg:readonly` |
| @-mentions of the bot in groups (users + other bots) | `im:message.group_at_msg.include_bot:readonly` |
| @-mentions of the bot in groups (users only) | `im:message.group_at_msg` or `im:message.group_at_msg:readonly` |
| **All** messages in groups (users + other bots, not itself) | `im:message.group_msg.include_bot:read` |
| All messages in groups (without bot messages) | `im:message.group_msg` (the official subscription list marks it "sensitive permission") |

By default only group messages that @-mention the bot are pushed; to "listen in", `im:message.group_msg` must be enabled, and it is marked a sensitive permission and requires publishing a version (likely needing enterprise administrator approval). The group history query `GET /im/v1/messages` under app identity also requires the private-chat permission first, and then `im:message.group_msg`.

Evidence:  
- Receive-message event (permissions and "in special cases duplicates may be pushed, deduplicate by message_id"): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive>  
- History messages (groups need `im:message.group_msg`): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list>  
- AstrBot docs (`im:message.group_msg` and the one-click permission link): <https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/docs/zh/platform/lark.md#L38>

### 2.3 Stable user/open/union IDs and the bot's own identity

**[Fact]** The official user identity model:

| ID | Scope | Stability | Notes |
| --- | --- | --- | --- |
| `lark_id` | Global | Stable | Not visible to developers; no need to care |
| `user_id` | Tenant | Stable within the tenant | That is, employee_id; obtaining it needs the sensitive field permission `contact:user.employee_id:readonly` |
| `open_id` | App | Stable within one app, changes across apps | **Always present** in events (`ou_` prefix); **must not be used across apps** |
| `union_id` | Developer/ISV | Stable across multiple apps of the same ISV | `on_` prefix; multiple apps of the same developer entity can be linked |

`sender.sender_id` in an event may carry `open_id`/`user_id`/`union_id` at the same time, depending on the tenant's `sender_id_type` setting; a missing `user_id` is normal. The comments in Hermes' implementation spell this out, and treat `union_id` as a backup identity that is stable across apps and `open_id` as the primary-key fallback.

The bot's own identity: `GET /open-apis/bot/v3/info` (tenant token) returns `bot.open_id` and `bot.app_name`, which is also the value of `mentions[].id.open_id` when the bot is @-mentioned in a group. The nanobot, AstrBot and official node-sdk `Channel` implementations all use this endpoint.

Evidence:  
- Official user identity overview: <https://open.feishu.cn/document/home/user-identity-introduction/introduction>  
- Identity-model comment at the top of the Hermes adapter file: <https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py#L1>  
- node-sdk `fetchBotIdentity()`: <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/channel.ts#L406>  
- nanobot `_fetch_bot_open_id()`: <https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py#L1173>  
- AstrBot `request_lark_bot_info()`: <https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/bot_info.py>

**[Suggestion]** In the first version `CanonicalUser.id = open_id` (always in events, stable within one app), and also store `user_id`/`union_id` (if present in the event) in an existing `CanonicalUser` extension field or the `events.sender` JSON, for future cross-app / cross-tenant migration and per-person memory; **do not** make up a `user_id` when it is missing. `displayName` needs extra resolution (the sender in an event has only an ID and no display name): AstrBot/Hermes both use the contacts `GET /contact/v3/users/:id` with caching, and it is recommended to do the same (see the §6.3 permissions).

**[To verify]** Which IDs the target tenant's `sender_id_type` actually returns; whether name scopes such as `contact:user.base:readonly` need administrator approval; whether the enterprise has enabled "external groups / external users".

### 2.4 @-mentions, quotes, thread/topic

**[Fact]**

- In a text message an @ is replaced with an `@_user_N` placeholder, and the real object is in `message.mentions[]`: `{key, id:{open_id,user_id,union_id}, name, mentioned_type}`. @all in the content is `@_all`.
- Reply/topic: `root_id` (the root message), `parent_id` (the direct parent message), `thread_id` (the topic ID). **For a reply inside a topic, both `root_id` and `parent_id` point to the topic root message**.
- The receive event does not carry the body of the quoted message; to get the quoted content you must call `GET /im/v1/messages/:message_id` again (nanobot, AstrBot and Hermes all do so).
- On the send side the `reply` endpoint + `reply_in_thread` can specify "reply in topic form"; `root_id`/`thread_id` are returned in the reply response. When a topic group does not support `reply_in_thread` it reports `230071`.

Evidence:  
- Message management overview (root/parent/thread/deleted/updated fields): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro>  
- Reply to message: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply>  
- nanobot quote-content fetching: <https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py#L2752> and nearby  
- AstrBot quote parsing: <https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/lark_adapter.py#L407>

**[Suggestion]** First version: `parent_id → CanonicalMessageEvent.replyToMessageId`; for the quoted text, prefer reusing the Pipeline's `replyToPreview`/`replyToContent` snapshot (naturally available while the parent message is still in the IC), and add the reinforcement "fetch the parent message on demand and cache it" (one API call, soft degradation on failure). **Do not split conversations by thread** (consistent with "no multi-conversation management needed"), but pass `thread_id` through as an optional field and output it as an attribute at render time, to keep the model from misreading context in topic groups.

### 2.5 Event catalogue, deduplication and re-push

**[Fact]** In the official Node SDK event type table the IM domain has 13 events (enumerated in this research):

```
im.message.receive_v1              im.message.message_read_v1
im.message.reaction.created_v1     im.message.reaction.deleted_v1
im.message.recalled_v1             im.chat.updated_v1
im.chat.disbanded_v1               im.chat.member.bot.added_v1
im.chat.member.bot.deleted_v1      im.chat.member.user.added_v1
im.chat.member.user.deleted_v1     im.chat.member.user.withdrawn_v1
im.chat.access_event.bot_p2p_chat_entered_v1
```

- **There is no message edit event**.
- `im.message.reaction.created_v1` carries only message_id / emoji_type / operator / action_time and **no `reaction_id`**; a bot can only delete reactions it added itself, so deletion depends on the `reaction_id` it cached at create time.
- The official receive-event doc states: "in special cases duplicate pushes may be received; if you need idempotency please use `message_id` to deduplicate, and do not rely on `event_id`." The 3-second timeout re-push of the long connection is another source of duplicates.
- AstrBot deduplicates by `event_id` (30-minute window), contrary to the official advice; nanobot uses a 1000-entry in-memory LRU of `message_id` (lost on restart); Hermes uses `message_id` + timestamp, with a TTL, persisted to a JSON file across restarts.

Evidence:  
- Full event type table: <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/code-gen/events-template.ts#L4309> (recalled), `#L4426` (receive)  
- Official receive event "deduplicate by message_id": see the link in §2.2  
- AstrBot `_is_duplicate_event`: <https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/lark_adapter.py#L528>  
- nanobot dedup: <https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py#L2678>  
- Hermes persistent dedup: <https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py#L3550>, `#L3592`

**[Suggestion]** Three layers of deduplication: ① an in-memory LRU (blocks the 3-second re-push); ② **a persistence check**: before publishing, check whether a canonical event already exists for that `(chatId, messageId)`, and skip if so (across restarts); ③ outbound sends carry a `uuid` (the same uuid succeeds at most once within 1 hour), so retries do not cause duplicate speech. **Do not use event_id**.

### 2.6 Edit and delete (recall) event support and limits

**[Fact]**

- Recall: `im.message.recalled_v1`, pushed only inside conversations where the bot is present; fields are `message_id`, `chat_id`, `recall_time`, `recall_type` (message_owner / group_owner / group_manager / enterprise_manager), **with no operator ID**. Subscribing to this event needs `im:message` or `im:message:readonly`.
- The 1-year limit on recall age applies only to "the bot recalling other people's messages in a group" (the bot must be the group owner/administrator/creator and the message no older than 1 year); the bot recalling its own message has no such 1-year limit, but is bound by the recall time limit set by the enterprise administrator.
- Edit: no event. `updated`/`update_time` can be seen when fetching messages; in `im.message.receive_v1`, `message.update_time` may be non-empty only when the message was edited and delivered again (**[to verify]** actual behaviour).

Evidence:  
- Recall event: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/recalled>  
- Recall endpoint limits: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/delete>

**[Suggestion]** In the first version map `im.message.recalled_v1` to a canonical `delete` event (Projection unchanged: the existing reducer marks the target node `deleted`). `CanonicalEditEvent` keeps its type but Feishu does not produce it; the document states "Feishu edits are invisible", and records "if edits need to be shown, they can only be marked from the `updated` field when fetching history / quotes" as future work.

### 2.7 History lookup

**[Fact]**

- `GET /im/v1/messages` (container_id_type=chat) supports `start_time`/`end_time` (seconds), `sort_type`, `page_size` ≤ 50, with endpoint rate limits of 1000 per minute and 50 per second.
- Reading group messages under app identity needs `im:message.group_msg`; the bot must be in the group.
- Events during a long-connection outage are not replayed (only the 3-second timeout re-push), so "gap filling after a disconnect" can only be done by querying back with the history endpoint ourselves.
- **[To verify]** Whether history from **before the bot joined** the group can be read (the docs say only "the bot must be in the queried group" and give no time boundary); the history behaviour of external groups and topic groups also needs testing. So **seeing all history is not guaranteed**.

**[Suggestion]** In the first version make gap filling an optional startup/reconnect action: take the `timestampSec` of the last local event as `start_time`, page with `ByCreateTimeAsc`, and run each entry through the same dedup + canonical flow (idempotent, no duplicates). A failure in gap filling is only logged and does not block the main flow. History from before joining the group is outside the promise.

### 2.8 Member information

**[Fact]** `GET /im/v1/chats/:chat_id/members`: does not return bot members; people who joined at the same time are returned in one batch, so the number of returned entries may be less or more than `page_size`; `page_size` ≤ 100; supports `member_id_type` (open_id/union_id/user_id); needs `im:chat`/`im:chat:readonly`/`im:chat.members:read`. The chat info `GET /im/v1/chats/:chat_id` returns the group name, group type, the external-group flag and the various permission settings. The join event `im.chat.member.user.added_v1` carries `users[].name` and the group name.

Evidence:  
- Chat members: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/get>  
- Chat info: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get>  
- Official CLI member/chat commands: <https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/affordance/im.md> (`+chat-members-list`, `+chat-search`)

**[Suggestion]** In the first version rely mainly on "names in events + on-demand contacts resolution", and treat the member list as a supplementary data source for later "person memory"; do not rely on the member list to infer "who is in the group".

### 2.9 Sending, reactions, attachments

**[Fact]** Sending (`POST /im/v1/messages`):

- `receive_id_type`: open_id / union_id / user_id / email / chat_id; open_id is recommended for users.
- Rate limits: 5 QPS to the same user, 5 QPS to the same group (**shared by all bots in the group**); endpoint level 1000/minute, 50/second.
- `msg_type`: text / post / image / file / audio / media / sticker / interactive / share_chat / share_user / system; text ≤150KB, cards/rich text ≤30KB.
- **For Markdown the official recommendation is `post` + the `md` tag**: CommonMark 0.31 + GFM (tables, task lists, strikethrough, autolinks), plus `<at user_id="ou_xxx">name</at>`, `<at user_id="all"></at>` and `![alt](img_v3_xxx)`. Example content: `{"zh_cn":{"content":[[{"tag":"md","text":"..."}]]}}`.
- The `uuid` parameter is used for send deduplication: the same uuid succeeds at most once within 1 hour (≤50 characters).
- Replies use `POST /im/v1/messages/:message_id/reply`, which supports `reply_in_thread`.

Reactions (`POST /im/v1/messages/:message_id/reactions`):

- Pass the enum `reaction_type.emoji_type` (such as `SMILE`, `THUMBSUP`), not unicode; needs `im:message` or `im:message.reactions:write_only`; the bot/user must be in the conversation. Deletion needs a `reaction_id` (in the create response).

Attachments: first upload with `POST /im/v1/images` or `/im/v1/files` to get a key, then send the message with the key; audio/video upload needs the duration; a bot can only send files it uploaded itself (error code 230017). Download with `GET /im/v1/messages/:message_id/resources/:file_key?type=image|file`, which needs `im:resource`.

Evidence:  
- Send message: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create>  
- Send content and the `md` tag: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json>  
- Reply: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply>  
- Reaction create: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/create>  
- Receive content structure: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content>  
- node-sdk notes on reaction constraints: <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/docs/channel.md>

**[Suggestion]** First version: send text with `post`+`md` (put the whole Markdown into one `md` node), split overlong content (for example >4000 characters; the client splits screens at about 4096) by paragraph into several messages with the first one using reply; reactions use a unicode→emoji_type mapping table, and cache the `reaction_id` obtained from our own create to support remove; attachments all deferred.

### 2.10 Other limits and pitfalls (all affect the implementation)

- **3-second event processing cap**: the entry handler must return quickly and push heavy work to a queue (the existing `session-ingress-queue` has exactly this shape).
- **The idempotency key is message_id** (§2.5).
- **The bot's own messages are not pushed back** (wording of the `im:message.group_msg` docs). A synthetic self-event is required.
- **Message edits are invisible** (§2.6).
- **Send rate limit 5 QPS/group, shared by the bots in the group**: consecutive speech in a tool loop will be rate-limited; this is exactly the problem "bounded tool execution" solves, and the Feishu line only has to return the error faithfully.
- **Long-connection cluster mode**: cannot be opened multiple times; mutually exclusive with the CLI event consumer (§2.1/§3.6).
- **The recall event has no operator ID**: the `actor` of the canonical delete event is left empty.
- **Typing indicator**: no typing API usable by a Feishu bot was found ([to verify]), so `sendTypingAction` must be set to false or no-op for Feishu.
- **Prompt injection**: the CLI/MCP official README explicitly advises against adding such bots to groups; this shows group message content is untrusted input, and when CLI/MCP tools are connected later they must be treated as untrusted data.

### 2.11 Checklist to verify (must be tested before implementation / during integration)

1. Whether the target tenant can get `im:message.group_msg` approved (a sensitive permission, may need administrator approval); whether external groups work.
2. Which IDs `sender_id` in receive events actually returns (whether there is a user_id/union_id besides open_id).
3. Whether message **edits** are really never re-pushed; the actual behaviour of `update_time` in receive events.
4. Whether history from **before the bot joined** can be read; the starting point of history readable after joining.
5. Whether `mentions[].id.open_id` always equals the open_id of `/bot/v3/info` when the bot is @-mentioned (all three reference implementations depend on this).
6. Whether `@all` messages are pushed to the bot under `im:message.group_msg`.
7. Whether the long connection supports the `card.action.trigger` callback (the two official statements disagree).
8. Whether Feishu has a bot typing/is-typing capability.
9. The exact name of the display-name resolution scope and whether it needs approval (`contact:user.base:readonly` and `contact:contact.base:readonly` both appear in AstrBot's examples).
10. The actual behaviour and error codes when the model sends several messages in a row under the 5 QPS/group limit.

---

## 3. Check of the reference implementations (repository existence + real source + commit)

**Read-only references, no code copied.** Licenses of each repository: nanobot MIT, hermes-agent MIT, node-sdk MIT, larksuite/cli MIT, lark-openapi-mcp MIT; **AstrBot is AGPL-3.0**, so its code must not be copied into this repository and can only serve as a behaviour reference.

### 3.1 HKUDS/nanobot (MIT, Python)

Repository exists, default branch `main`, commit `67248790c76b150af39dab5026608ee2c449b0d3`.

- Main adapter file (2905 lines): <https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/runtime.py>
  - Receiving and gating: `#L2633` `_on_message`: `sender_type == "bot"` is dropped directly; an unmentioned group message is dropped directly; in-memory LRU dedup by `message_id`; a `THUMBSUP` reaction is sent immediately on receipt; the parent message body is fetched with `parent_id`; topic session isolation uses `root_id/message_id` (configurable `topic_isolation`).
  - Sending: `#L2076` `_send_message_sync` (`im.v1.message.create`), `#L1944` `_reply_message_sync` (`im.v1.message.reply`, supports `reply_in_thread`).
  - @ parsing: `#L1201` `_resolve_mentions` replaces `@_user_N` with `@name (open_id, user id: xxx)`.
  - WS operation: <https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/websocket.py> (patches the module-level loop of `lark_oapi` onto its own worker thread to avoid multi-instance conflicts).
  - Config shape: <https://github.com/HKUDS/nanobot/blob/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/config.py> (`group_policy: open|mention`, `reply_to_message`, `streaming`, `topic_isolation`).
  - The test directory has 20+ Feishu tests (mention, post, reply, reaction, table split, media filename security, etc.): <https://github.com/HKUDS/nanobot/tree/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu/tests>
- Worth borrowing: **the test organization** (one test file per Feishu message type/interaction) and the recorded trade-offs of `topic_isolation`.
- Not recommended to copy: in-memory dedup does not survive restarts; the strategy of making a topic an independent session runs opposite to LuckyBot's "single context" direction.

### 3.2 NousResearch/hermes-agent (MIT, Python)

Repository exists, default branch `main`, commit `53bec2a311979ad6f77580ba491eca261ab988e0`.

- Main adapter file (4493 lines): <https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py>
  - Identity-model comment at the file head (open_id/user_id/union_id): `#L1`
  - Bot detection: `#L347` `_is_bot_sender` (the receive docs say `{user, bot}`, and the implementation defensively also accepts `app`)
  - Admission policy: `#L3382` `_admit`: self-echo filtering, bot message policy (none/mentions/all), group policy (open/allowlist/blacklist/admin_only/disabled), require_mention; @all counts as mentioning itself.
  - **Persistent dedup**: `#L3550`/`#L3580`/`#L3592`, `message_id → timestamp` persisted to JSON + TTL + capacity cap.
  - Event handling and threads: `#L2016` `_on_message_event` (queues for replay when the loop is not ready), `#L2615` `_process_inbound_message` (only `thread_id` counts as a topic and `root_id` must not, otherwise an ordinary quote is misjudged as a topic — a pitfall they hit).
  - Outbound: `#L1652` `send` (markdown → post, degrading to plain text on failure), `#L1704` `edit_message`, `#L1732` `delete_message`, `#L1983` `get_chat_info`.
  - WS lifecycle: `#L1493` `connect`, `#L1545` `disconnect`, `#L1574` `_teardown_ws_thread` (**send the WebSocket CLOSE frame first and then tear down the thread**, otherwise the server keeps routing events to the dead connection; an app lock "only one instance per app_id locally").
- Permissions doc (scopes table): <https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/website/docs/user-guide/messaging/feishu.md#L62>
- Plugin manifest: <https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/plugin.yaml>
- Worth borrowing: **identity ID priority (open_id > user_id > name)**, **persistent dedup**, **CLOSE frame / single-instance lock**, the distinction between `thread_id` and `root_id`, the markdown→post degradation strategy.
- Not recommended to copy: the whole gateway / multi-profile / multiplex architecture, far beyond what LuckyBot currently needs.

### 3.3 AstrBotDevs/AstrBot (AGPL-3.0, behaviour reference only)

Repository exists, default branch `master`, commit `9441402872f65fffc35685b0ead5bd3337033cb2`.

- `<https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark/lark_adapter.py>`: `register_p2_im_message_receive_v1` + `lark.ws.Client`; `convert_msg` (`#L586`); `_build_reply_from_parent_id` (`#L407`); `event_id` dedup (`#L517`, contrary to the official message_id advice); contacts display-name resolution and caching.
- Docs: <https://github.com/AstrBotDevs/AstrBot/blob/9441402872f65fffc35685b0ead5bd3337033cb2/docs/zh/platform/lark.md> (permissions, socket/webhook, one-click permission link).
- Confirmed official position: `im:message.group_msg` is the key permission for "receiving all messages in group chats".

### 3.4 larksuite/node-sdk (official, MIT)

Repository exists, default branch `main`, commit `b188be60134d409b61259546bcf69c731d2b0b7c`, version 1.76.0.

- Long connection and events: `WSClient` + `EventDispatcher`; README `#L557`.
- The high-level `Channel`: `channel/channel.ts`, `channel/safety/dedup-cache.ts` (two-layer dedup: in-memory LRU + an injectable long-lived Cache), `channel/normalize/**` (a unified representation of message type → markdown + XML tags), `channel/outbound/**` (markdown→post, chunking, retry, error classification), `docs/channel.md`.
- **Key: `normalize` / `normalizeCardAction` / `normalizeReaction` / `normalizeBotAdded` / `normalizeComment` are exported at the package root** (`export { normalize, ... } from './normalize'` in `channel/index.ts`), and the docs also say "For webhook-mode integrations, historical event replay, or custom event pipelines, the internal normalizers are exported as well". This means we can **borrow only the parser without the Channel's scheduling semantics**.
- `NormalizedMessage` fields (`docs/channel.md`): `messageId`/`chatId`/`chatType`/`senderId` (open_id first, falling back to user_id/union_id)/`content` (markdown + XML media tags)/`resources`/`mentions` (excluding the bot itself)/`mentionAll`/`mentionedBot`/`rootId`/`threadId`/`replyToMessageId`/`createTime`.
- The send-side `SendOptions` supports `replyTo`, `replyInThread` and structured `mentions`; built-in `target_revoked` automatically drops replyTo and resends, `format_error` degrades to plain text; `LarkChannelError` classifies `rate_limited`/`permission_denied` etc.
- Very light dependencies: axios, lodash.*, protobufjs, qs, ws.

### 3.5 Other official material worth consulting

- Server SDK docs: <https://open.feishu.cn/document/ukTMukTMukTM/uETO1YjLxkTN24SM5UjN>
- Event list entry: <https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-list>

### 3.6 The official CLI (larksuite/cli) and MCP

**larksuite/cli**: repository exists, `main`, commit `017b19a793ad71794a02887ede04757f3d82e10d`, MIT, Go, 200+ commands + 26 Skills.

- Real-time events: `lark-cli event consume <EventKey>` goes over the long connection and prints NDJSON on stdout; it has a ready marker, `--max-events`/`--timeout` and exit-code conventions; only one EventKey can be consumed at a time. <https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/skills/lark-event/SKILL.md>
- IM event catalogue (12, including reaction/chat.member, **not including recalled**): <https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/skills/lark-event/references/lark-event-im.md>
- Message/member operations: `+chat-messages-list`, `+messages-search`, `+messages-mget`, `+chat-members-list`, `+messages-reply`, `+messages-edit`, `reactions create/list/delete`, `+messages-resources-download` and so on: <https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/affordance/im.md>
- `--as user|bot` switches between user_access_token / tenant_access_token; `lark-cli auth login --recommend`.
- README security warning: it advises treating a CLI-connected bot as a personal assistant, **not adding it to group chats** and not letting other users interact with it, to avoid abuse of permissions. <https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/README.zh.md>

**lark-openapi-mcp**: repository exists, `main`, commit `21920354ec6e3966b52e89152620c5085e496b55`, no updates since 2025-08. <https://github.com/larksuite/lark-openapi-mcp>

**[Suggestion]** The positioning of CLI/MCP:

1. **Not as the ingress**: it competes with the self-built WS client for the cluster push of the same app (§2.1), and adds a resident process/bus daemon.
2. **Later as a tool candidate**: looking up history, looking up group members, reading documents etc. left to `lark-cli` (subprocess + `--as bot` + minimal scope), or MCP. But it must be treated as "untrusted output", and cannot be used for permission decisions (maintainer permission still comes from the local trusted configuration).
3. If a CLI ingress is to be tried, only with **one WS connection strategy for the same app**: either everything goes to the CLI (it runs `event consume` and feeds this process), or everything is connected by ourselves; the two cannot coexist.

---

## 4. Recommended minimal incremental plan

### 4.1 Design principles

- Build no generic plugin framework and abstract nothing for "platforms that may be connected later"; extract the necessary seams only for the **current two implementations** (Telegram, Feishu).
- Reuse the existing canonical types, Projection, Rendering, Driver, DB, compaction, scheduler.
- In the first version, whatever the official SDK can solve is not written ourselves; whatever DB idempotency can solve gets no new table.

### 4.2 Module layout (new)

```text
src/
├── im/                        # platform-independent, extracted from telegram/ (pure move, logic unchanged)
│   ├── event-sink.ts          # formerly telegram/event-sink.ts
│   └── session-ingress-queue.ts  # formerly telegram/session-ingress-queue.ts
├── feishu/                    # new; the only place allowed to hold Feishu platform details
│   ├── client.ts              # WSClient + Client + bot identity + start/stop + reconnect after disconnect
│   ├── adaptation.ts          # raw event -> CanonicalIMEvent (including delete/service)
│   ├── content.ts             # normalize() result / raw content -> ContentNode[]; parent quote resolution
│   ├── live-handlers.ts       # dedup gate + persist + publish (cf. telegram/live-handlers.ts)
│   ├── user-names.ts          # open_id -> display-name cache (contacts API, soft degradation on failure)
│   ├── reactions.ts           # unicode <-> emoji_type mapping + reaction_id cache
│   ├── markdown.ts            # Markdown -> post/md wrapping + chunking
│   └── driver-hooks.ts        # sendMessage/reaction/download/typing(no-op) + synthetic self-event
└── driver/platform.ts         # minimal seam interface (see §5.2)
```

### 4.3 How to connect (first version, item by item)

| Capability | Approach | Permission needed |
| --- | --- | --- |
| Receive group messages (including listening in) | `WSClient` + `EventDispatcher` subscribing to `im.message.receive_v1`; a chat id enters the pipeline only if it is in the `chats` whitelist | `im:message.group_msg` (+ group @ permission) |
| Receive private chats | Same, `chat_type == 'p2p'` | `im:message.p2p_msg:readonly` |
| Text parsing | `normalize()` gives `content` (markdown + XML tags) + `mentions`/`mentionAll`; then convert to `ContentNode[]` | — |
| Sender identity | `open_id` as the primary key; `isBot = sender_type !== 'user'`; display name resolved through the contacts cache, falling back to the ID on failure | Names: `contact:user.base:readonly` |
| @ / mentions me | `mentions[].id.open_id == botOpenId` (botOpenId from `/bot/v3/info`); `@_all` is recorded as mention-all | — |
| Quotes | `parent_id` → `replyToMessageId`; body from the IC snapshot first, and when missing fetched on demand with `GET /im/v1/messages/:id` (cached, soft degradation on failure) | `im:message`/`im:message:readonly` |
| Topics | `thread_id` passed through as an optional field for rendering, no conversation splitting | — |
| Recalls | `im.message.recalled_v1` → canonical `delete` | `im:message`/`im:message:readonly` |
| Service events | `im.chat.member.user.added_v1` → members_joined; `...deleted_v1` → member_left; `after_change.name` of `im.chat.updated_v1` → chat_renamed; `im.chat.member.bot.added_v1` used to get the group name / record joining | Subscribe to the corresponding events |
| Dedup | In-memory LRU + an existence check in the `events` table (across restarts) | — |
| Gap filling after disconnect | On reconnect/startup query back through the history endpoint from the last local timestamp, each entry going through the same dedup flow | `im:message.group_msg` (groups) |
| Sending | `post`+`md`; >4000 characters split by paragraph; first one is a reply; with a `uuid` | `im:message:send_as_bot` |
| Reactions | unicode→emoji_type mapping; cache reaction_id after create to support remove | `im:message.reactions:write_only` |
| Typing | no-op; Feishu chat config `sendTypingAction: false` | — |
| Own messages | After each successful send inject an `isSelfSent=true` canonical event (with the real `create_time`) | — |
| Media | **Not in the first version**: attachments are not hydrated, `download_file`/`read_image` return an explicit not-supported error for Feishu | Later `im:resource` |

### 4.4 Database: the first version can have zero migrations

**[Suggestion]** Feishu events are written only to `events` (canonical; `message_id` is already text) and not to the Telegram-specific `messages` table:

- The Feishu implementation of `messageExists` queries `events` (the existing `loadLatestMessageContent` already demonstrates querying `events` by `chatId + messageId`).
- Attachment reads come from `events.attachments` (canonical JSON); in the first version media is off, so returning empty/failure is enough.
- So there is **no need** to change `messages.message_id integer` into text and **no need** for a new Drizzle migration. Telegram behaviour is unchanged.
- Cost: Feishu has no raw platform JSON archive and no `messages.deletedAt` (a recall appears only in the canonical IC/events). If media is done later, decide then whether to migrate `messages` or give Feishu a separate attachment table; the migration is then added per the project conventions.

### 4.5 Explicitly not done (YAGNI)

- A generic platform/plugin framework, a platform registry, a second message-ID abstraction layer.
- Splitting context by thread, multi-conversation management.
- Cards, streaming output, streaming typewriter effects (`cardkit`-related permissions).
- Media upload/download, custom emoji, image alt text.
- Message edit sync, ban_spammer, message deletion (recall only).
- CLI/MCP integration, Jev/Mem0 integration (see §5.3).
- Full history import; only "gap filling after disconnects".

---

## 5. Parallel to the driver behaviour line: file ownership and the minimal seam

### 5.1 File ownership suggestion

| Owner | Files | Rule |
| --- | --- | --- |
| **Feishu line exclusive** | `src/feishu/**` (new), `src/container/registrars/feishu.ts` (new), `docs/feishu-integration-research.md` | Free to change |
| **Driver behaviour line exclusive** | `src/driver/wakeup.ts`, `runner.ts`, `turn-loop.ts`, `context.ts`, `compaction*.ts`, `scheduler.ts`, `tools/end-turn.ts`, `tools/decide.ts`, `prompts/**` | Feishu line does not touch |
| **Shared, to be locked by one "seam commit"** | `src/driver/index.ts`, `src/driver/primary-tools.ts`, `src/driver/platform.ts` (new), `src/driver/tools/{send-message,react,attachment-downloader,download-file,read-image}.ts`, `src/db/persistence.ts`, `src/db/schema.ts`, `src/container/{tokens.ts,index.ts,registrars/{driver,pipeline,core,media}.ts}`, `src/startup/index.ts`, `src/config/config.ts`, `src/pipeline.ts` | Merge the seam first, then each starts work; later changes to these files must be synced with each other |
| **Pure move (one commit)** | `src/telegram/event-sink.ts` → `src/im/event-sink.ts`; `src/telegram/session-ingress-queue.ts` → `src/im/session-ingress-queue.ts` | Change only imports/paths, not logic, to ease diff review |

Acceptance criterion of the seam commit: `pnpm typecheck && pnpm lint && pnpm test:run && pnpm build` all green, Telegram behaviour unchanged (protected by the existing tests + characterization tests).

### 5.2 Minimal interface seam (suggested form)

Converge the platform shape now scattered in the `createDriver` deps into one interface, with message IDs always `string`:

```ts
// src/driver/platform.ts — provided by the Feishu line, reviewed by the driver line
import type { CanonicalAttachment } from '../adaptation/types';
import type { BanSpammerResult } from './platform-types';

export interface PlatformAttachmentRef {
  type: string;
  fileName?: string;
  mimeType?: string;
  fileKey?: string;          // Feishu: needed for message_resource download
  resourceType?: 'image' | 'file';
}

export interface DriverPlatform {
  name: 'telegram' | 'feishu';       // for currentChannel in wakeup
  botUserId: string;                 // pipeline's botUserId / isMyself / mentionsMe
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

  // Optional platform capabilities: not implemented by Feishu in the first version; callers treat as undefined
  banSpammer?: (chatId: string, messageId: string) => Promise<BanSpammerResult>;
  getCustomEmojiInfo?: (ids: string[]) => Promise<CustomEmojiMedia[]>;
}
```

The Driver side changes only the "shape", not the semantics:

- The six platform callbacks in `createDriver(config, deps)` are replaced with `platform: DriverPlatform`; the other persistence/model/backgroundTask dependencies are untouched.
- `sendMessage` in `primary-tools` no longer does `Number(replyTo)` and passes the string through; `messageExists(messageId: string)` in `send-message.ts`/`react.ts`.
- The `file-id` parsing in `attachment-downloader` changes to `lastIndexOf(':')` + keeping the messageId as a string.
- The Telegram platform implementation keeps the `Number(...)`/`serverToTdLibMessageId` conversion internally, behaviour unchanged.
- `DriverConfig` gains `platformName` (or takes it from `platform.name`), and `wakeup.ts` no longer hardcodes `'telegram'`. Please have the driver line land this one-line change together with its prompt changes, or have the Feishu line change only this spot in the seam commit and ask the driver line to rebase.

The `start/stop` of `DriverPlatform` is only responsible for the platform client lifecycle; the ingress live handler and post-startup are still assembled by the container/startup (the `PlatformRuntime` token is optional; if you do not want to change startup much, you can also just pick one of two by configuration in `registerDriver` — see below).

**A lazier alternative** (if you do not want to touch startup): keep the Telegram token names, add `TOKENS.FEISHU_*`, and in `registerDriver` do `const platform = config.feishu ? feishuPlatform() : telegramPlatform()`. The cost is that startup still has to handle platform start/stop/liveHandlers/postStartup, so the coupling is deeper. The `PlatformRuntime` form is still recommended, to clean it up in one go.

### 5.3 Interface dependencies on the memory / tool-budget lines (pointed out only, not implemented)

- **Probe replacement (Jev)**: affects only the probe call in `src/driver/wakeup.ts` and the shape of the `probe.model` config (the schema of the `decide` tool and the `probe_responses_v2` persistence). The Feishu line does not depend on the probe implementation and only requires that "silence is possible after the probe" and "an @-mention is a strong signal but not a forced reply" end up consistent; Feishu's `mentionsMe` is already provided on the RC segment and can be used directly as a signal input.
- **Bounded tool execution**: `maxSteps: Infinity` and `checkInterrupt` (a new message extending the current turn) are both in the driver line; the Feishu line **must not** depend on "a new message extends the current turn", and should keep the return format of `send_message` (`{ok:true,message_id}`) unchanged, otherwise the tool loop's judgement breaks. The Feishu 5 QPS/group rate limit is real, and until the tool budget is settled the Feishu hook can only throw `rate_limited` faithfully.
- **Per-person memory (Mem0/Nowledge/files)**: by the architecture constraints, external memory can enter only through the late-binding prompt or tool results and must not change the IC. Interface points: the parameters of `renderLateBindingPrompt`, `chats.<id>.systemFiles`, and the stable `CanonicalUser.id` (= Feishu open_id). `events.sender` already contains `id/displayName/username/isBot`; if `union_id`/`user_id` are needed, fields must be extended on `CanonicalUser` (suggest reserving a JSON field in the first version to avoid a second migration).
- **Maintainer authentication**: comes from trusted configuration (`maintainers.yaml`), and must not be inferred from chat content/memory; the Feishu line is only responsible for supplying a stable open_id.

---

## 6. Acceptance tests and the user configuration needed

### 6.1 Unit/replay tests (CI, offline)

1. **Adaptation replay**: recorded raw event JSON fixtures (text with @, post with md, quote, topic, recall, member join, rename, bot joining) → `CanonicalIMEvent` snapshot tests; assert that `messageId`/`chatId` are both strings, mention userId = open_id, and `replyToMessageId = parent_id`.
2. **Dedup**: deliver the event with the same `message_id` twice (simulating a 3-second re-push / restart replay), and assert that `events` gains only one row and the pipeline receives it only once.
3. **ID seam**: `send_message.reply_to = "om_x"`, `react.message_id = "om_x"` and `file-id = "om_x:0"` all parse correctly; an illegal ID is rejected without calling the platform API.
4. **Send rendering**: the Markdown → post/md JSON wrapping and chunking; the `uuid` exists and differs each time; the synthetic self-event has `isSelfSent=true` and does not wake the Driver.
5. **Recall**: `recalled_v1` → canonical delete → renders `<message deleted="true"/>`.
6. **Regression protection**: all existing Telegram adaptation/manager tests keep passing (the core acceptance of the seam commit).
7. **SDK compatibility**: one "behaviour-locking" test on the `normalize()` output; if the parse structure changes when `@larksuiteoapi/node-sdk` is upgraded, it fails.

### 6.2 Manual integration checklist (needs a real tenant)

1. Ordinary messages in a group (without @) are archived and enter the IC/RC; with `im:message.group_msg` not enabled only @ messages can be received (expected behaviour).
2. The bot can see its own messages (synthetic self-event), and before the probe it will not respond repeatedly because it cannot see itself.
3. `mentionsMe`/`repliesToMe` are correct in four cases: @-mention of the bot, @all, reply to the bot, reply inside a topic.
4. Restart the process: the historical RC is rebuilt correctly, there are no duplicate events, and dedup still works (re-pushing the same message_id after restart does not duplicate).
5. Reconnect after a 30-second disconnect: gap filling fills in the messages in between (if enabled), without duplicates.
6. Recall a group message: that message becomes deleted in the IC and the model can see it.
7. Send more than 5 QPS/group continuously: the error is returned faithfully, with no silent message loss.
8. Long message (>4000 characters): chunking, correct order, reply only on the first one.
9. Reactions: add once, delete once; the one deleted is the one it added.
10. The long connection and the CLI `event consume` are **not** run at the same time.

### 6.3 Permissions and switches the user (app administrator) must configure

**Permissions (apply for them in "Permission management" of the developer console)**:

- Receiving messages: `im:message` (all group messages additionally need **`im:message.group_msg`**, a sensitive permission); group @: `im:message.group_at_msg:readonly`; private chat: `im:message.p2p_msg:readonly`.
- Sending messages: `im:message:send_as_bot` (or `im:message`).
- Recall events: `im:message` or `im:message:readonly`.
- Reactions: `im:message.reactions:write_only`; receiving reaction events additionally needs `im:message.reactions:read`.
- Attachments: `im:resource` (not enabled in the first version; can be left unapplied for now).
- Chat info/members: `im:chat` (or `im:chat:readonly` / `im:chat.members:read`).
- Display-name resolution: `contact:user.base:readonly` (**to verify** the exact name; `user_id` additionally needs `contact:user.employee_id:readonly`).

**Event subscriptions ("Events and callbacks" page)**:

- `im.message.receive_v1` (required)
- `im.message.recalled_v1`
- `im.chat.member.user.added_v1`, `im.chat.member.user.deleted_v1`
- `im.chat.updated_v1`, `im.chat.member.bot.added_v1` (to get the group name / joining)
- Optional: `im.message.reaction.created_v1` / `im.message.reaction.deleted_v1`

**Other**:

- Enable the bot capability, and choose **long connection** as the event subscription method (it can be saved successfully only while the local client is online).
- **Publish an app version** (permission and event changes need a release; an enterprise self-built app may need administrator approval); configure the **availability scope** (private chats with users outside the availability scope fail with 230013).
- Configure `feishu.appId/appSecret/domain` in `config.yaml`, and `chats."oc_xxx"`.
- Suggest using that app **only for the LuckyBot process** (long-connection cluster mode + single instance).

### 6.4 Suggested landing order (each step independently verifiable)

1. **Seam commit**: the `DriverPlatform` interface + string IDs + the `im/` move + Telegram adaptation; Feishu is not connected, tests all green.
2. **Configuration and startup**: the `feishu` config section, `PlatformRuntime`, lazy `tdl.configure`; even an empty Feishu implementation can `pnpm start` to the "client ready" log.
3. **Read-only ingress**: receive messages → persist → pipeline → visible in the log/RC; complete dedup and the recall/service events.
4. **Outbound**: send (text first, then post/md) → synthetic self-event → a complete turn loop.
5. **Gap filling + integration checklist**: gap filling after disconnects, @/quote/topic, long messages, rate-limit errors.
6. **Prompts and channel name**: change `currentChannel` and the Telegram-specific wording together with the driver/persona line.

---

## 7. Risks and unverified items

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `im:message.group_msg` cannot be approved (sensitive permission / administrator approval) | The bot can only receive @ messages and cannot listen in | First get the @ mode working; make "listening in" an explicit configurable capability, with a log hint when the permission is missing |
| Long-connection cluster mode + single-instance lock | Running several instances / running with the CLI randomly loses events | Document "one app runs only one client"; implement single-instance detection at startup (see the Hermes app lock) |
| 3-second processing timeout | Triggers re-pushes and rate limiting | The ingress returns immediately and pushes heavy work to a queue; dedup by message_id |
| Edits invisible | The IC and the actual content in the group may be inconsistent | State it in the docs; later mark it on the fetch path with `updated`/`update_time` |
| Display-name resolution scope/approval | The model sees only `ou_xxx` | Contacts resolution + cache + fallback on failure; the group member list can also fill in names first |
| Unbounded tool loop + 5 QPS/group rate limit | Slow replies, rate-limit errors, flooding (same source as the Hermes pain point) | The driver behaviour line implements the bounded budget; the Feishu hook only passes errors through |
| History visibility scope not verified | Users mistakenly think all history is visible | Make no promise of "full history import"; gap filling promises only "the online period + the disconnect window" |
| `normalize()` is a fairly new API | An SDK upgrade may change behaviour | Pin the version + a behaviour-locking test |
| AstrBot is AGPL | Copying code would bring license problems | Reference behaviour only, copy no code; at the time of writing this project's upstream also had no public LICENSE yet and Menci's authorization scope had to be respected (superseded: upstream adopted MIT on 2026-10-17) |

---

## 8. Summary of evidence links

**Official documentation (`open.feishu.cn`; append `.md` to the URL to get the original)**

- Receive-message event (permissions, message_id dedup): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive>
- Long-connection mode (3 seconds, 50 connections, cluster mode, self-built apps only): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- User identity overview (open_id/user_id/union_id): <https://open.feishu.cn/document/home/user-identity-introduction/introduction>
- Message management overview (root/parent/thread/updated): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro>
- Receive-message content structure: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content>
- Recall-message event: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/recalled>
- Send message (rate limit, uuid, message types): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create>
- Send content and Markdown (`post`+`md`): <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json>
- Reply to message: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply>
- Recall-message endpoint: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/delete>
- Get history messages: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list>
- Get a specified message: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/get>
- Create reaction: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/create>
- Reaction events: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/events/created>
- Chat member list: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/get>
- Chat info: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get>
- Message resource download: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get>

**Official SDK / CLI**

- node-sdk (MIT, `b188be60134d409b61259546bcf69c731d2b0b7c`, 1.76.0): <https://github.com/larksuite/node-sdk>
  - `channel/channel.ts`: <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/channel.ts>
  - `channel/safety/dedup-cache.ts`: <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/channel/safety/dedup-cache.ts>
  - `docs/channel.md`: <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/docs/channel.md>
  - `code-gen/events-template.ts` (`im.message.recalled_v1` at `#L4309`, `im.message.receive_v1` at `#L4426`): <https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/code-gen/events-template.ts>
  - `channel/normalize`: <https://github.com/larksuite/node-sdk/tree/b188be60134d409b61259546bcf69c731d2b0b7c/channel/normalize>
- larksuite/cli (MIT, `017b19a793ad71794a02887ede04757f3d82e10d`): <https://github.com/larksuite/cli>
  - `skills/lark-event/SKILL.md`, `skills/lark-event/references/lark-event-im.md`, `skills/lark-im/SKILL.md`, `affordance/im.md`
  - README security warning: <https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/README.zh.md>
- lark-openapi-mcp: <https://github.com/larksuite/lark-openapi-mcp> (`21920354ec6e3966b52e89152620c5085e496b55`)

**Third-party reference implementations**

- nanobot (MIT, `67248790c76b150af39dab5026608ee2c449b0d3`): <https://github.com/HKUDS/nanobot/tree/67248790c76b150af39dab5026608ee2c449b0d3/nanobot/channels/feishu>
- hermes-agent (MIT, `53bec2a311979ad6f77580ba491eca261ab988e0`): <https://github.com/NousResearch/hermes-agent/blob/53bec2a311979ad6f77580ba491eca261ab988e0/plugins/platforms/feishu/adapter.py>
- AstrBot (**AGPL-3.0, read-only reference**, `9441402872f65fffc35685b0ead5bd3337033cb2`): <https://github.com/AstrBotDevs/AstrBot/tree/9441402872f65fffc35685b0ead5bd3337033cb2/astrbot/core/platform/sources/lark>

**Code anchors in this repository**

- Platform→canonical: `src/telegram/adaptation.ts`, `src/telegram/message/tdlib.ts`
- Ingress and publication: `src/telegram/manager.ts`, `src/telegram/live-handlers.ts`, `src/telegram/event-sink.ts`
- Numeric ID coupling: `src/telegram/message/types.ts` (`messageId: number`), `src/db/schema.ts` (`messages.messageId integer`), `src/db/persistence.ts` (`loadMessageAttachments`/`messageExists`)
- Driver seam: `src/driver/index.ts`, `src/driver/primary-tools.ts`, `src/driver/tools/send-message.ts`, `react.ts`, `attachment-downloader.ts`
- Outbound and self-event: `src/telegram/driver-hooks.ts`, `src/telegram/bot.ts`
- Startup and DI: `src/startup/index.ts`, `src/container/**`
- Prompt channel name: `src/driver/wakeup.ts`, `prompts/system.velin.md`, `prompts/late-binding.velin.md`
