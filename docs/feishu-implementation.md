# Feishu Integration Implementation Notes (First Version)

> Historical agent handoff snapshot. Coordinator changes supersede the integration TODOs and budget/error guarantees below; see [integration-status.md](integration-status.md) for current behavior and verification.

Date: 2026-10-16 · Branch: `feat/feishu-adapter` · Status: implemented, offline tests pass; **not verified online** (no real credentials were read, no WS connection was made, no message was sent).

> Addendum 2026-10-17 (`feat/feishu-images`): inbound images are wired into canonical attachments and `read_image(file_id)` / `download_file`; see §1.1, §2, §9.5.

> Online verification 2026-10-17: in a real group chat, @-mentions, image `read_image`, quote-replies, reactions, synthetic self-events, restart replay/deduplication and reconnection after disconnects all worked. The contacts display-name API returns `41050` for members outside the permission scope, and the name falls back to one seen earlier; images still have no passive description.

This document records what the first version of the Feishu integration actually implements, how to configure it, how to debug it by hand, and the known limitations. For the research background see the research report (`docs/feishu-integration-research.md` on the `research-feishu-integration` branch).

## 1. Scope

### Implemented

- Only **configured group chats** are received (the `oc_...` keys in `chats`). Private chats and unconfigured groups are dropped without being archived. Note that this differs from Telegram, which archives unconfigured conversations.
- Inbound message types: `text`, `post`, `image`. The `@_user_N` / `@_all` placeholders in text and the `at` elements in a post are converted to `mention` nodes whose `userId` is an open_id, so Rendering can compute `mentionsMe` correctly. A post's bold, italic, underline, strikethrough, inline code, links and code blocks are all preserved.
- Other message types (files, audio, video, stickers, cards, merged forwards, etc.) are shown as placeholder text such as `[image]` or `[unsupported message type: x]`, with no attachment (images are the exception, see §1.1).
- Quotes: `parent_id` maps to `replyToMessageId`. The quoted content reuses the Projection's IC snapshot, so it can only be shown when the parent message is already in context; no API call is made to fetch the parent message.
- Recalls: `im.message.recalled_v1` maps to a canonical `delete`.
- Sender identity: `CanonicalUser.id` is the open_id (stable within the app); `isBot = sender_type !== 'user'`. Display names come from the following sources in order: the contacts API (wait capped at 1 second, result cached for 6 hours, no retry for 10 minutes after a failure); if the contacts API cannot give a name, the chat's member list (`im.v1.chatMembers.get`, which needs only the chat permission, also covers members outside the contacts scope and external members, and does not include bots; cached per chat for 6 hours, wait capped at the same 1 second, and if the person is not in the list it is only refetched after 10 minutes); after that, names seen in @-mentions in this process and historical names in the IC; if none exists the name is empty and Rendering falls back to showing the open_id. Archived messages keep the sender snapshot of the time and are not rewritten when a name is learned later (to keep the prefix cache stable); to backfill names on historical messages use `contacts.json`.
- Sending: a `post` message whose content is a single `md` element (CommonMark + GFM); when `reply_to` is present the reply endpoint is called.
- Sending @-mentions: the model writes `<at user_id="ou_...">name</at>` in the `send_message` text, and `src/feishu/post-content.ts` validates it and places it unchanged into the `md` element (Feishu's md extension syntax). The open_id must belong to a participant seen in this chat (a sender or mentioned user seen by this process, or a historical sender in the IC), otherwise the tool reports an error; @-all is not supported; tags inside code blocks and inline code are sent literally. In Feishu mode the chatlog's `<message>` carries a `uid` attribute from which the model copies the open_id; Telegram rendering is unchanged.
- Synthetic self-event: after every successful send, the `message_id` returned by the server is used to write a canonical event with `isSelfSent=true`, which is then published to the Pipeline without waking the Driver. Feishu does not push the bot's own messages back, so this path is the only way the bot sees what it said.
- Deduplication and crash recovery, see §3.
- Reactions: a mapping from common Unicode emoji to `emoji_type` (30 in the first version, about 37 more added on 2026-10-17, including 😏 `SMIRK` and 😎 `SMART`). An unmapped emoji errors out directly and does not pretend to succeed; removing a reaction needs the `reaction_id` recorded by this process, so after a restart a reaction added earlier cannot be removed or replaced, which likewise errors.

### 1.1 Inbound images and file_id

- The `image_key` of an `image` message, and the `image_key` of every `tag=img` element in a post, are converted to canonical photo attachments. The `image_key` is persisted to `events.attachments` as the `fileKey` property on the attachment object, and is used to call the message-resource endpoint when downloading. A post's `media` element also carries an `image_key` (the video cover), but is not treated as an image.
- Images no longer produce `[image]` placeholder text; the placeholder is only kept when parsing fails (the key cannot be obtained).
- Rendering follows the shared rules and renders the attachment as `<attachment type="photo" ... file-id="<message_id>:<index>"/>` (one index per image in a multi-image post), and the model passes this `file-id` to `read_image` / `download_file`. The download path: `file-id` → `(message_id, index)` → take the `image_key` of the index-th attachment from the stored event → `GET /open-apis/im/v1/messages/{message_id}/resources/{image_key}?type=image`. The shared downloader checks `0 <= index < attachments.length` and reports a platform-independent error when out of range.
- Downloads are cut off at 20 MB while the stream is read (`readMessageResourceStream`): a Content-Length over the limit is rejected before the stream is read, otherwise bytes are counted as they are read; the total read timeout is 30 s, and the stream is destroyed when it expires. Exceeding the limit or the timeout are this module's own errors and are returned as they are; a transport error in the middle of the stream goes through `toApiError` before being returned to the model, to avoid carrying request details into the tool result.
- Online verification 2026-10-17: a real group-chat image was read successfully with `read_image(file_id)`; multi-image posts, sizes and MIME types were not checked one by one.

### Not implemented (future work)

Outbound media (sending attachments), passive description of images (`imageToText` does not automatically generate alt text for received images; the model must call `read_image(file_id)` explicitly), message-edit sync (Feishu has no edit event), topics / `thread_id`, gap filling after disconnects (fetching history), service events such as members joining and leaving and group renames, inbound reaction events, private chats, cards and streaming output, `ban_spammer`, typing indicators, and automatic chunking of overlong messages on send.

`read_image` has always been kept, because its `path` parameter still works. In Feishu mode `download_file` and `read_image(file_id)` are exposed (they need `im:resource`), and `send_message.attachments` is not exposed (`supportsOutboundAttachments` is not declared); if an attachment has no `fileKey` when the bytes are about to be fetched (an old message archived before the upgrade), a clear error is returned. `ban_spammer` is not exposed in Feishu mode.

## 2. Shared seams (for the parent agent to review)

| Seam | Location | Notes |
| --- | --- | --- |
| `DriverPlatform` | `src/driver/platform.ts` | The set of platform-facing capabilities of the Driver. Message IDs are always strings. When the optional members (inbound `loadMessageAttachments`+`downloadMessageMedia`, outbound `supportsOutboundAttachments`, `banSpammer`) are missing, the corresponding tools and parameters are not exposed to the model. The `createDriver` deps are `Omit<DriverPlatform,'name'>` plus the original dependencies, and the field names stay as before (flat). |
| Telegram adaptation | `src/telegram/driver-platform.ts` | The only place that converts strings back to the numbers TDLib uses (`parseTelegramMessageId` / `requireTelegramMessageId`, in `message/id-conversion.ts`). Non-numeric IDs never reach TDLib. |
| Platform lifecycle | `src/startup/platform.ts` | `PlatformIdentity` (`prepare`, `botUserId`) and `PlatformRuntime` (`startIngress`, `start`, `stop`, `runPostStartup`). Startup no longer references the Telegram token. |
| Platform selection | `src/container/registrars/platform.ts` | Resolves `PLATFORM_IDENTITY`, `PLATFORM_RUNTIME` and `DRIVER_PLATFORM` to the matching implementation according to `config.platform`. The factories are lazy; a platform that is not selected is never constructed. |
| Lazy TDLib | `src/container/registrars/telegram.ts` | `tdl.configure` moved from the module top level of `startup/index.ts` into the `TELEGRAM_CLIENTS` factory, so Feishu mode does not load libtdjson. |
| EventSink | `src/event-sink.ts` | The former `src/telegram/event-sink.ts`, moved and renamed unchanged (`TelegramEventSink` → `EventSink`, token changed to `EVENT_SINK`); logic unchanged. |
| Dedup key | `events.dedup_key` + unique index `(chat_id, dedup_key)` | Migration `drizzle/0033_events_dedup_key.sql`. Telegram writes NULL, and multiple NULLs do not conflict in SQLite. Added `persistDedupedEvent`, `hasEventDedupKey`, `canonicalMessageExists`. |
| Tools | `send-message.ts`, `react.ts`, `attachment-downloader.ts`, `ban-spammer.ts` | Changed to string IDs; `file-id` is split at the last colon and the message ID part no longer has to be numeric; "TDLib" in error messages was changed to "the platform API". |
| Feishu inbound attachments | `src/feishu/{content,adaptation,driver-platform,api,sdk}.ts` + `container/registrars/feishu.ts` | `parseFeishuAttachments` extracts the `image_key`, and adaptation writes it into the shared `CanonicalAttachment.fileKey`. The registrar wires `loadMessageAttachments` (synchronously reads archived attachments with `loadEventsByMessageIds`) and `getMessageResource` (SDK byte transport) into `createFeishuDriverPlatform`; the two come as a pair, and the inbound capability takes effect. |
| Message-resource download | `FeishuApi.getMessageResource` + `src/feishu/sdk.ts` | Calls `client.im.v1.messageResource.get`, and the returned stream is read into a Buffer by `readMessageResourceStream`: 20 MB limit (Content-Length precheck + counting while reading), 30 s total read timeout, and errors are routed as local errors vs `toApiError`. |

Deliberately not done: a generic plugin framework, a platform registry, reserved fields, using the SDK's `Channel`. The SDK's `normalize()` is not used either: it flattens mentions into `@name` text and by default deletes @-mentions of the bot, which loses the open_id and the position, so `mentionsMe` could not be computed.

## 3. Deduplication and crash recovery

- Dedup keys are distinguished by action: `message:<message_id>`, `recall:<message_id>`. A recall is not swallowed by the dedup key of the same message, and vice versa.
- The WS event handler (the SDK acks only after the handler resolves) returns only **after** the canonical event has been persisted, so an event that has been acked is not lost.
- Processing is serial within a chat, and the Pipeline publication order matches the arrival order.
- Concurrent duplicate delivery: the second delivery waits for the result of the first and returns the same result.
- Crash after persisting but before publishing: after a restart, cold replay rebuilds from the `events` table; later duplicate deliveries are skipped by the dedup key.
- In-process publication failure: the persisted event stays in memory and the handler throws, so Feishu pushes again; when the re-push arrives only the publication is redone and nothing is written to the database twice.
- Malformed events are only logged and acked, because a re-push would not succeed either.
- Sending: one `uuid` per logical message, reused by all retries of the same send, and replaced for the next message. Only 99991400 rate limiting, HTTP 429/5xx and no response are retried, at most 2 times (after 1 second and 3 seconds); the final error is returned to the tool result as it is, and there is no unbounded silent retry.
- If the send succeeds but writing the self-event fails, only an error log is written and the tool does not report an error, to keep the model from resending the same message.

## 4. Runtime configuration

`config.yaml`:

```yaml
platform: feishu
feishu:
  appId: "cli_xxxxxxxxxxxxxxxx"   # must look like cli_ + 16 hex digits
  appSecret: ""
  domain: "feishu"                # optional: feishu (default), lark, or an https:// base URL
chats:
  default:
    sendTypingAction: false   # Feishu has no bot "typing" API; leaving true is only a no-op
    # tools.banSpammer must be false, otherwise startup reports an error
  "oc_xxx": {}               # chat_id of the target group
```

- The `telegram` section is not needed in Feishu mode; it is still required in Telegram mode (the default).
- In Feishu mode the `feishu` section is required, and the credentials are written in `config.yaml` just like the Telegram token and the model API keys (that file is git-ignored). The group IDs go in `chats`.
- Credential values are only used in memory: they are not written to `process.env` (the child processes of the bash tool would inherit it), a validation error says only which field is invalid and does not echo the value, and the SDK logs drop fields such as `config`, `headers`, `*token*` and `app_secret` and then replace the app secret itself.

## 5. Permissions and events needed in the Feishu console

The minimum set is as follows and takes effect after a version is published; `im:message.group_msg` is a sensitive permission and may need administrator approval:

- Receiving group messages: `im:message.group_msg` (listening to all group messages); with only `im:message.group_at_msg:readonly` enabled, only messages that @-mention the bot are received.
- Sending and replying: `im:message:send_as_bot`.
- Recall events: `im:message` or `im:message:readonly`.
- Reactions: `im:message.reactions:write_only` (or `im:message`).
- Downloading image / file resources in messages (`read_image(file_id)`, `download_file`): `im:resource`. Without this permission the resource endpoint returns a permission error; a real image was read online on 2026-10-17.
- Display names: contacts read permission (`contact.user.get`, such as `contact:user.base:readonly`). This permission has been granted, but the "contact data range" (通讯录权限范围, "contact data range") must also be configured to include the group members: members outside the range return `41050` "no user authority", in which case the names from the chat member list are used instead (see §1), and failing that the name falls back to one seen earlier or the open_id.
- Choose "long connection" as the event subscription method, and subscribe to `im.message.receive_v1` and `im.message.recalled_v1`.
- An app can run only one long-connection consumer: do not run a second LuckyBot process or `lark-cli event consume` at the same time, otherwise events are randomly distributed to one of them.

## 6. Offline verification results

Dependencies installed: `pnpm install --frozen-lockfile --ignore-scripts` was run, then `pnpm rebuild` for better-sqlite3, sharp, esbuild, unrs-resolver and ffmpeg-static, and `pnpm tdlib:types` was run. The SDK was added with `pnpm add @larksuiteoapi/node-sdk@1.76.0`. The `rlottie` headers are missing on this machine, so lottie-frame was not compiled.

- `pnpm lint`: passes.
- `pnpm build`: passes.
- `pnpm test:run`: 486 of 490 tests pass. The 4 failures are all unrelated to this branch: 3 TGS tests need the native lottie-frame; the test in `probe-vs-primary` that asserts "evaluator's notes" fails the same way on the prompt and test file this branch did not touch.
- `pnpm typecheck`: 5 errors remain. 4 are the type patches for the two Driver behaviour tests in §9.2 (outside this line's scope to change); 1 is the existing missing type declaration for `markdown-it-math-loose`.
- New tests: `src/feishu/{content,user-names,reactions,ingress}.test.ts`, `src/telegram/driver-platform.test.ts`, `src/config/platform-config.test.ts`, `src/container/feishu-mode.test.ts`. The last one builds the full container with synthetic credentials and a mocked SDK, and asserts that neither `tdl.configure` nor `tdl.createClient` was called.
- Confirmed offline: the CJS named exports of node-sdk 1.76.0 can be obtained through `import * as lark` under both Node ESM and tsx.

Re-run after the image integration on 2026-10-17 (`feat/feishu-images`): `pnpm typecheck`, `pnpm lint`, `pnpm test:run` (53 files / 527 tests) and `pnpm build` all pass. Test coverage: image parsing, attachment capability pairing, download by index (including multi-image posts), the invariant error for a missing `fileKey`, the `send_message.attachments` capability split, the 20 MB limit and the Content-Length precheck, the 30 s timeout and stream destruction, redaction of mid-stream errors, and end-to-end registrar wiring (image event → `events.attachments.fileKey` → `getMessageResource` download). `client.im.v1.messageResource.get` was only type-checked and unit-tested against a mocked SDK, and was not verified online.

## 7. Manual debugging steps (to be run only after separate confirmation from the user)

1. Install dependencies as above. A full install needs the system package `rlottie` first (it only affects Telegram TGS stickers).
2. Run `pnpm typecheck && pnpm lint && pnpm test:run && pnpm build`.
3. Prepare `config.yaml` (see §4), configuring only one test group at first.
4. Run `pnpm start`; the log should show `Feishu long connection ready` and `Cahciua is running`; TDLib should not be loaded.
5. In the group, verify in turn: an ordinary message is stored (a `dedup_key = 'message:om_...'` appears in the `events` table); `mentionsMe` appears in the RC when the bot is @-mentioned; `repliesToMe` appears when a bot message is quoted; after the bot replies, a row with `is_self_sent = 1` appears in `events`; after a recall, the message is marked `deleted="true"` in the RC.
6. Images: send an image (and a multi-image post), confirm that `{"type":"photo","fileKey":"img_v3_..."}` appears in order in `events.attachments`, and that `<attachment type="photo" ... file-id="om_...:0"/>`, `:1` and so on appear in the RC; have the bot `read_image` any of those `file-id`s (needs `im:resource`; not verified online).
7. Restart the process during processing: confirm there are no duplicate events, cold replay is correct, and re-pushes are skipped.
8. Verify reactions: add once, replace once, remove once; then use an unmapped emoji to confirm it errors.
9. Send several messages in quick succession and watch whether rate-limit errors are returned faithfully.

## 8. Unverified items and limitations

- `src/feishu/sdk.ts` passes type checking and was used online on 2026-10-17. The endpoints used are `im.v1.message.create/reply`, `im.v1.messageReaction.create/delete`, `contact.v3.user.get`, `Client.request` (`/open-apis/bot/v3/info`), `WSClient` and `EventDispatcher`.
- The actual value format of `feishu.domain` has not been confirmed; a value that does not match the format in §4 makes startup report an error (the error message does not contain the value).
- Whether `mentions[].id.open_id` equals the open_id returned by `/bot/v3/info` when the bot is @-mentioned: confirmed online on 2026-10-17 (@-mentions and `mentionsMe` work).
- In received posts, `at` elements use the `@_user_N` placeholder per the documentation; the code also handles the case where the open_id is given directly.
- A `[text](url)` link in a text message is kept as plain text and not parsed into a link node.
- The prompts still say Telegram (see §9).
- Images: `fileKey` (`image_key`) is now declared on the shared `CanonicalAttachment` and `Attachment` types; Telegram does not set it and keeps downloading by `(chatId, messageId)`.
- Image download: every index of a multi-image message can be downloaded (the shared downloader takes the attachment by index); real image download was verified online on 2026-10-17, sizes and MIME types were not checked one by one.
- The inbound image capability is wired in the registrar: `read_image(file_id)` / `download_file` are available for Feishu but need the `im:resource` permission; verified online on 2026-10-17.
- `send_message.attachments` is not exposed on Feishu: `DriverPlatform.supportsOutboundAttachments` is true only for the Telegram platform, and Feishu does not declare it, so the tool schema has no `attachments`.
- Passive image description is not wired: the automatic description path of `imageToText` needs the ingress to download the image before persisting, generate `thumbnailWebp` and call `imageToText.resolve`, and `src/feishu/ingress.ts` currently has no media-runtime dependency (see §9.5).
- Telegram-specific logic such as the `tg://` announcement of `ban_spammer` is unchanged and not enabled in Feishu mode.

## 9. Items to hand to the parent agent for integration

The following files are outside this line's scope to change; suggested patches are given here:

1. **`currentChannel` in `src/driver/wakeup.ts`** (`'telegram'` hardcoded in two places). Suggest adding a parameter `currentChannel: string` to `executeWakeup` to replace the two `currentChannel: 'telegram'`. When `src/driver/index.ts` calls it, it passes the platform name, which requires adding `platformName: DriverPlatform['name']` to the `createDriver` deps (supplied by `platform.name` in `registrars/driver.ts`). This branch did not change `wakeup.ts`, so the deps do not have this field yet.
2. **Type patches for the Driver behaviour tests**: in `src/driver/driver-characterization.test.ts` and `src/driver/probe-vs-primary.test.ts`, the `messageId: 1` / `999` returned by the `sendMessage` mock are numbers and need to become `'1'` / `'999'` for the types (the extra `date` field can stay). This only affects `tsc`; running vitest is not affected. The other deps field names are unchanged; `loadMessageAttachments`, `downloadMessageMedia` and `banSpammer` merely became optional.
3. **Prompts**: `prompts/system.velin.md` says "Telegram group chat", "Telegram-flavored Markdown" and a `t.me` link prefix, and `prompts/late-binding.velin.md` says "Telegram group chat". Suggest branching on `currentChannel`: Feishu output is CommonMark + GFM (tables supported) and does not support Telegram's spoiler; @-mentioning someone needs `<at user_id="ou_...">name</at>` (now wired in, see §1; the model writing `@name` is still only plain text); no message deep links are provided.
4. **`AGENTS.md`**: in Ownership, `telegram/` no longer contains the event-sink, and `src/feishu/` and `src/event-sink.ts` need to be added; the location of the event-sink in the "Telegram Clients And Ingress" section needs updating; the startup order becomes "migrate → platform identity prepare → cold replay → … → platform start"; the Configured chats section should note that Feishu does not archive unconfigured conversations; record `events.dedup_key`. If `docs/telegram-module-architecture.md` references the event-sink path, it needs to be synced too.
5. **Passive image description (suggested, future work)**: add an optional hook `prepareAttachments?: (event: CanonicalMessageEvent) => Promise<void>` to the build stage of `createFeishuIngress`, implemented by the registrar with the `imageResolvers`, `generateThumbnail` and `downloadMessageMedia` of `MEDIA_RUNTIME`: download the image → `thumbnailWebp` → `imageToText.resolve`. Then the existing `hydrateAltText` in `EventSink.publish` fills the cached description back onto the attachment. `src/media/**` itself needs no change.
