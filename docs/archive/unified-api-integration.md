# Unified API Integration Design (working document)

> This document records the investigation findings, settled decisions and open
> items for integrating `src/unified-api/` into the whole Cahciua repository.
> Claude updates it after each round of discussion, so work can resume across compactions.
> `src/unified-api/` itself **must not** be modified.

## 1. Background and overall boundaries

### Architecture boundary

```
┌──────────────────────────────────────────────────────┐
│ LLM API client layer (HTTP only, provider-native wire)│
│   chat.ts                (OpenAI Chat Completions)   │
│   responses.ts           (OpenAI Responses)          │
│   messages.ts            (Anthropic Messages)        │
└────────────┬─────────────────────────────┬───────────┘
             │ from*Output                 │ to*Input
             ▼                             ▲
┌──────────────────────────────────────────────────────┐
│ Business layer (operates on ConversationEntry[] only, IR)│
│   runner · context · merge · compaction              │
│   send-message-human-likeness · probe analysis       │
│   DB access                                          │
└──────────────────────────────────────────────────────┘
```

**Hard rules**:
- Convert to IR immediately after leaving the API client; business code must
  not see any wire-format LLM data (assistant message, function_call,
  tool_use, reasoning, etc.).
- Inside the tool call loop, assistant output is converted to IR first, and
  tool results are appended as `ToolResult` IR entries.
- Only before issuing the next API call is it converted back to wire with `to*Input`.

### Files involved (to change/add)

| File | Action |
|---|---|
| `src/db/schema.ts` | Add the `turn_responses_v2` / `probe_responses_v2` tables |
| `drizzle/XXXX_create_v2_tables.sql` | Table-creation SQL |
| `src/db/persistence.ts` | Change persist/load signatures to return IR, add the startup migration function |
| `src/db/migrate-v2.ts` (new) | v1→v2 backfill logic |
| `src/rendering/types.ts` | `RenderedContentPiece` image switches to Sharp |
| `src/rendering/*` | Downstream producers switch to Sharp |
| `src/telegram/*` | Image download yields Sharp instead of a base64 data URL |
| `src/driver/types.ts` | Delete `TRDataEntry`/`ResponsesTRDataItem`/`ExtendedMessage` etc., rebuild the types |
| `src/driver/context.ts` | `composeContext` returns `ConversationEntry[]` |
| `src/driver/merge.ts` | Operates on IR |
| `src/driver/convert.ts` | **Deleted entirely** (functionality belongs to unified-api) |
| `src/driver/runner.ts` | Convert to IR, unified loop |
| `src/driver/compaction.ts` | Switch to IR |
| `src/driver/send-message-human-likeness.ts` | Rewrite, scanning IR |
| `src/driver/messages.ts` | Native Anthropic HTTP |
| `src/driver/index.ts` | Entry point and dispatch |
| Each `*.test.ts` | Test migration |

## 2. Settled decisions

### D1. Images: Sharp throughout
- The image variant of `RenderedContentPiece` at the RC layer changes from `{url:string}`
  to `{image: Sharp}`.
- The Buffer produced by the telegram download is wrapped immediately with `sharp(buf)`.
- Only at the **serialization boundary** (storing to DB, sending to the LLM API) is it
  converted to base64 or put into the request body through the codec/Sharp pipeline.
- The codec registers Sharp:
  - serialize (async): `await sharp.toBuffer()` + `metadata()` to get the format → `{base64, format}`.
  - deserialize (async): `sharp(Buffer.from(base64, 'base64'))` (codec handlers are async, so this is OK).

### D2. Reasoning gate: use the model name instead of a compat string
- The v2 tables have a column `model_name TEXT NOT NULL DEFAULT ''`.
- When a TR is written, record the model name actually used for that call
  (for example `'gpt-5'`, `'claude-sonnet-4-5-20250929'`).
- On read, compare it as a string with the **primary model name configured for the current chat**.
  If not equal → run `stripReasoning` on that TR's `entries`.
- Delete the old `reasoningSignatureCompat` field from the config.

### D3. Simplify trim while moving to IR
- `trimImages` / `trimToolResults` (image detail downgrade)
  are written once at the `InputPart[]` level,
  no longer once each on the chat and responses wire paths.
- The assistant↔tool alignment in `trimContext` is correlated by `callId`,
  no longer by position in the message array.
- `sanitizeToolCallIdsForMessagesApi` (the Anthropic id regex)
  is handled by `toMessagesInput` (if unified-api does not do it, stop and discuss).

### D4. Tool results containing images are lifted into a user message
- Handled by `toChatCompletionsInput`; the business layer does not care.
- If implementation finds that unified-api does not do it, stop and discuss
  (current decision: do not touch unified-api).

### D5. probe_responses also becomes v2
- Reason: unified schema, easier querying/analysis,
  and the startup migration logic reuses that of TR v2.
- Probe is write-only; besides `turn_responses`, which is scanned by
  `send-message-human-likeness.ts` for the late-binding prompt,
  nothing reads `probe_responses`.

### D6. One-time backfill at startup (not done by an SQL migration)
- Table creation is the job of drizzle SQL (only CREATE TABLE + indexes).
- Data movement is done by a TS startup hook:
  ```
  if (SELECT COUNT(*) FROM turn_responses_v2 == 0
      AND SELECT COUNT(*) FROM turn_responses > 0) {
    BEGIN TRANSACTION;
      scan v1 → migrateChatEntries/migrateResponsesEntries
            → encode via codec → INSERT v2
    COMMIT;
  }
  ```
- A **single transaction** wraps the whole backfill (a single-database SQLite transaction, with a manageable row count).
- probe v2 uses the same logic.
- The v1 tables are **kept and not dropped**, for the record / rollback.

### D7. v2 table shape

```sql
CREATE TABLE turn_responses_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  entries TEXT NOT NULL,            -- codec JSON: ConversationEntry[]
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  model_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX turn_responses_v2_chat_requested_idx
  ON turn_responses_v2 (chat_id, requested_at);

CREATE TABLE probe_responses_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  entries TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  model_name TEXT NOT NULL DEFAULT '',
  is_activated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX probe_responses_v2_chat_idx
  ON probe_responses_v2 (chat_id);
```

**Column changes** (relative to v1):
- Drop `provider` (the IR is provider-agnostic)
- Drop `session_meta` (v1 never wrote a non-null value)
- Drop `data` → replaced by `entries` (codec-wrapped JSON)
- `reasoning_signature_compat` → `model_name`
- Rows backfilled from v1 get `model_name = ''` (an empty string is treated as a mismatch,
  so reasoning is always stripped on read).
- probe v2 also keeps `model_name` (convenient for querying).

### D8. Business layer must use IR
- The boundary is as in the "Architecture boundary" diagram.
- `send-message-human-likeness.ts` is rewritten: scan `ConversationEntry[]`,
  find `kind:'toolCall' && name:'send_message'` in `OutputMessage.parts`,
  pair it with the following `ToolResult(callId)` and look at its `payload` for `ok:true`,
  and extract `text` from the `args` JSON.

### D9. The native Anthropic path is done in this pass too
- Add `src/driver/messages.ts`.
- Add `apiFormat: 'anthropic-messages'` to the config.
- The HTTP client does not care about provider differences; headers/URL are passed
  through to fetch per provider, with no wrapper abstraction.
- **Important**: `ProviderFormat` does not go into the DB; it exists only in the config and at the runner dispatch.

### D10. Sharp async handler
Codec handlers may be async, and `sharp(Buffer.from(base64))` is written as `async v => sharp(...)`. The sharp constructor is synchronous with lazy decoding, so `await` has no real cost.

### D11. Delete reasoningSignatureCompat
Remove this field everywhere: the config schema, the `LlmEndpoint` type, `config.yaml`, etc. On read, compare model_name instead.

### D12. Images produced by tools also use Sharp
When `read_image` / `download_file` etc. in `src/driver/tools.ts` produce a `ToolResult.payload`, images use Sharp instances directly and no longer data URLs. That way all images in the IR are Sharp.

### D13. The RC producer switches to Sharp
The data URL assembled from thumbnailWebp at `src/rendering/index.ts:164` becomes `sharp(Buffer.from(att.thumbnailWebp, 'base64'))`. The thumbnailWebp field in the DB is untouched. Tests are updated accordingly.

### D14. One-time migration at startup (timing A)
After the drizzle migrator finishes and before the driver/pipeline starts, run the v1→v2 backfill in the startup flow of `src/index.ts`.

### D15. Backfill error handling
If any row's migration throws, roll back the whole transaction and crash the whole program, requiring manual intervention. No swallowing errors, no skipping rows.

### D16. Test strategy B
First understand the behaviours covered by the original `convert.test.ts` / `merge.test.ts` / `context.test.ts`, then rewrite the tests on IR aimed at those behaviours. Delete the old tests.

## 4. Assumptions that need verification but are currently unverified

- [ ] `toChatCompletionsInput` handles a `ToolResult` that contains images
      (lifted into the next user message): verify during implementation.
- [ ] `toMessagesInput` does the Anthropic tool id regex sanitize:
      verify during implementation.
- [ ] `toMessagesInput` parses `ToolCallPart.args` and falls back to `{}`:
      already confirmed to exist in the IR comments of `unified-api/types.ts`.
- [ ] Codec handlers support async: the `CustomType` serialize/deserialize at `codec.ts:14-18`
      both return Promises, confirmed.

## 5. Suggested implementation order

1. drizzle SQL: create the two v2 tables.
2. Add the v2 definitions to schema.ts.
3. Switch the rendering layer to Sharp (RC `image` variant).
4. Adapt the telegram download side to produce Sharp.
5. Register the codec Sharp in `src/db/codec.ts` (new).
6. `src/db/migrate-v2.ts` backfill logic.
7. Add v2 read/write functions to `persistence.ts`, and have the startup hook call the migration.
8. Connect the runner + API client to IR: from*Output inside the runner.
9. Switch context.ts / merge.ts to operate on IR.
10. Rewrite send-message-human-likeness.ts.
11. Switch compaction.ts to IR.
12. Glue it in driver/index.ts.
13. messages.ts (Anthropic) + runner dispatch.
14. Delete the old `convert.ts` and the obsolete types in the old `types.ts`.
15. Test migration.

## 6. Key reference locations

| Concern | File | Lines |
|---|---|---|
| Current TR schema | `src/db/schema.ts` | 95-107 |
| persist/load TR | `src/db/persistence.ts` | 306-354 |
| runner chat loop | `src/driver/runner.ts` | 69-124 |
| runner responses loop | `src/driver/runner.ts` | 126-186 |
| composeContext | `src/driver/context.ts` | 529-581 |
| mergeContext | `src/driver/merge.ts` | 20-75 |
| reasoning gate | `src/driver/context.ts` | 119-156 |
| Lifting tool results with images into user | `src/driver/convert.ts` | 51-114 |
| Anthropic tool id sanitize | `src/driver/context.ts` | 369-420 |
| trim suite | `src/driver/context.ts` | 58-101, 243-367 |
| IR invariants | `src/unified-api/types.ts` | 1-25 |
| Migration helpers | `src/unified-api/migrations.ts` | whole file |
| codec (async handler) | `src/unified-api/codec.ts` | 14-18 |
| RC types | `src/rendering/types.ts` | 9-40 |
| probe writer | `src/driver/index.ts` | 350-355 |
| send-message evaluation entry | `src/driver/index.ts` | 295 |

## 7. Discussion history summary

**Round 1** (overall investigation): identified 9 friction points and open questions.

**Round 2** (user decisions):
- Images all Sharp.
- Reasoning uses model_name instead of compat.
- Trim simplified on IR.
- Tool results with images belong to unified-api.
- probe also v2.
- One-time backfill.
- v2 shape confirmed, compat → model_name.
- The business layer must not see wire.
- Anthropic done in this pass, HTTP passes headers through.

**Round 3** (further user decisions):
- The codec Sharp uses an async handler.
- v1 is not dropped, kept for the record.
- Backfill in a single transaction.
- v2 backfilled rows leave model_name empty.
- probe v2 also stores model_name.
- The HTTP client passes headers through, no abstraction.

**Round 4** (further user decisions):
- Delete the reasoningSignatureCompat field from the config.
- Images produced by tools also use Sharp.
- The RC producer switches to Sharp.
- Startup migration timing is A (after drizzle, before the driver).
- Backfill errors: rollback + crash.
- Tests: first understand the coverage, then rewrite on IR.

**Round 5** (further user decisions):
- No dual writes, write only v2.
- One drizzle migration file, creating both tables together.
- The codec instance goes in `src/db/codec.ts`, built through `createCodec` and registering Sharp.
- Clean up compat entirely: primaryModel / probeModel / compactionModel / sanitize*ForTR all deleted.
- The new signature of `loadTurnResponses` returns `TurnResponseV2[]` (with `entries`/`modelName`). `composeContext` takes `TurnResponseV2[]` + the current modelName, and runs `stripReasoning` on a mismatch.
- The merge logic is unchanged, with the operand switched to IR.
- RC → IR: consecutive RC segments are merged into one InputMessage (role:'user').
- The startup migration must run before all other modules are initialized and after drizzle migrate. A failed migration must not allow any other side effect.

**Round 6** (exceptional decision):
- **Modifying unified-api is allowed**. Reasons:
  (1) `toChatCompletionsInput` currently leaves "lifting tool results containing images into a user message" to the outside (`driver/convert`), but driver/convert is to be deleted;
  (2) `toMessagesInput` does not do the Anthropic tool_use id regex sanitize.
- These two capabilities **must go into unified-api**, without discounting the principle that the business layer does not see wire.
- Keep the scope of the change minimal: only change `to-chat-input.ts` and `to-messages-input.ts`.
