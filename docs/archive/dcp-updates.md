# DCP RFC Implementation Updates

The following are the design changes and refinements made relative to the original RFC during the implementation of Cahciua.

---

## 1. New: dual-timestamp ordering

The RFC assumed that each event carrying the server-side `date` field was enough to determine order. Implementation showed that server timestamps alone cannot guarantee **deterministic replay**: clock skew between servers and network reordering make the event order of a cold-start replay differ from that of online processing.

Every `CanonicalIMEvent` now carries two timestamps:

| Field | Precision | Source | Purpose |
|------|------|------|------|
| `receivedAtMs` | milliseconds | `Date.now()` at adaptation time | The sole source of ordering; the DB sorts by `(received_at, id)` |
| `timestampSec` | seconds | server `date` | The message time shown to the LLM |

A delete event has no server time, so its `timestampSec` is derived from `Math.floor(receivedAtMs / 1000)`.

## 2. Change: slimmer event types

The RFC proposed several independent event types (`StickerEvent`, `UserUpdateEvent`, `MemberJoinEvent` / `MemberLeaveEvent`). The implementation slimmed them down:

- **Sticker** is not its own event type; it is handled as `type: 'sticker'` in the `attachments` of a `CanonicalMessageEvent`. This matches the actual structure of the Telegram API, where a sticker is simply an attachment of a message.
- **UserUpdateEvent / MemberJoinEvent / MemberLeaveEvent** are not independent CanonicalIMEvent types for now. User state changes are detected from ordinary messages through the **MetaReducer pattern** (see item 4 below), without relying on platform-specific events. Join and leave events are left until they are needed.

Currently `CanonicalIMEvent = CanonicalMessageEvent | CanonicalEditEvent | CanonicalDeleteEvent`.

## 3. Change: Projection does not split the Reducer

The RFC proposed ContentReducer and MetaReducer as independent code abstractions. The implementation decided **not to split them for now**:

- There is currently a single `reduce(ic, event)` function, and the MetaReducer logic (user-state change detection) runs as one of its steps
- The time to split is when genuinely independent meta event types (`UserUpdateEvent`, `MemberJoinEvent`, etc.) appear

This avoids premature abstraction: with only the three event kinds message/edit/delete, the boundary between ContentReducer and MetaReducer is not clear.

## 4. New: the MetaReducer pattern (user state change detection)

This makes the RFC's MetaReducer concept concrete, but implemented differently: not through platform-specific events, but by **inference from ordinary message events**:

As the Reducer processes each message, it compares `event.sender` with the record in the `ic.users` Map. If `displayName` or `username` changed, it inserts an `ICSystemEvent` node at the current position of the IC, so the LLM knows "user A renamed to B".

This does not need Telegram to provide a `UserUpdateEvent` (the Bot API itself does not push such events either); equivalent information is extracted from data already available.

## 5. Change: the IC has no CompactSummaryNode

The RFC's IC contained three node kinds: `MessageNode`, `SystemEventNode`, `CompactSummaryNode`. The implementation removed `CompactSummaryNode`:

- The compaction summary is prepended by the Driver before the merge stage and does not go through Rendering. `RenderParams` carries only the cursor and the bot identity.
- The IC always holds the uncompacted working set and does not mix in compaction products
- This keeps the IC pure: it is only a structured projection of the event stream and contains no rendering-layer or Driver-layer artifacts

Currently `ICNode = ICMessage | ICSystemEvent`.

## 6. New: in-place marking semantics for Edit/Delete

The RFC did not specify in detail how Projection handles edit/delete. The implementation settled on concrete semantics:

- **Edit**: find the `ICMessage` with the matching `messageId` in the IC, update `content`/`attachments` in place and set `editedAtSec`
- **Delete**: find the matching node and set `deleted: true` (the node is not removed and no new node is appended)
- If the target message is not in the current IC (already garbage-collected), silently ignore it

This mimics the real behaviour of an IM: edits and deletes modify the original message position and do not produce new timeline entries.

Edit/delete events come entirely from the userbot (gramjs / MTProto). The Bot API does not push edit or delete notifications, so without a userbot client the system does not need to handle these two kinds of events.

## 6a. New: the two kinds of IC mutation and their KV cache impact

IC changes fall into two classes with different KV cache characteristics:

- **In-place mutation** (edit, delete): modifies an existing node at its original position in the IC, with a marker (`editedAtSec`, `deleted: true`). Rendering renders the node's current state. This invalidates the KV cache from the point of mutation onward. That is acceptable: edits are infrequent (~5-10%) and usually target recent messages (so the invalidated range is small); messages already covered by compaction are not in the IC, and edits/deletes of them are silently ignored.
- **Append-only mutation** (a user renaming; in future: join/leave): inserts a system event node at the end of the IC and does not modify older messages. Older messages keep their original `sender` field, and Rendering uses `node.sender` (the name at the time the message was sent) and does not look up `ic.users`. Naturally friendly to the KV cache.

Design rule: **entity metadata changes (users, group settings) → append-only; content changes to a specific message → in-place modification + marker.**

## 7. Major change: a new Driver layer

The RFC's three-layer pipeline (Adaptation → Projection → Rendering) was extended to **four layers** in the implementation. The reason:

The LLM APIs (OpenAI Chat Completions, OpenAI Responses) differ in their tool call formats and in the metadata that must be passed back (IDs, signatures). This metadata is generated server-side, cannot be derived from the IC, and cannot be expressed in a provider-agnostic way in the Rendering output. Both API formats are implemented and switched with the `apiFormat` setting.

The architecture now:

```
Adaptation → Projection → Rendering → Driver
                            (pure)     (stateful)
```

| Layer | Responsibility | Purity |
|---|---|---|
| **Rendering** | `render(IC, RenderParams) → RC`: serialize the IC into a provider-agnostic RC | Pure function |
| **Driver** | Holds the TRs (conversation history), merges RC + TRs, manages the tool call loop | Stateful |

The RC (Rendered Context) is not the final LLM request; it is one of the inputs of the Driver's merge. The Driver interleaves the RC and the TRs by timestamp (`receivedAtMs`/`requestedAtMs`) into the final API request.

## 8. New: storing conversation history in the raw provider format

The RFC did not cover how to store the bot's own replies and tool call history. The current design:

- **Storage unit**: Turn Response / TR (the output of one LLM interaction), stored in the raw provider format
- **Same-provider reads**: zero conversion, which guarantees losslessness
- **Cross-provider switching**: explicit A→B conversion functions, direct structural mapping, independently testable
- Switching provider does not change existing data in the database; it only changes the translation logic at read time

Design principle: storing directly is simpler than an intermediate format and avoids the information loss that normalization causes. N*(N-1) converters; with N=2-3 that is 2-6 functions, implemented on demand.

**Implemented provider formats**:
- `openai-chat`: OpenAI Chat Completions compatible format (`TRDataEntry[]`: assistant + tool role entries)
- `responses`: OpenAI Responses API format (output items: `message`, `function_call`, `reasoning`, `function_call_output`)

**Conversion architecture**: `composeContext` always outputs `Message[]` in the openai-chat format as the lingua franca. TR data in the Responses format is turned into openai-chat messages at compose time through `responsesOutputToMessages`. If the target API is Responses, the runner does the final conversion through `messagesToResponsesInput` before sending. Reasoning is preserved in the conversion (`encrypted_content` ↔ `reasoning_opaque`, `summary` ↔ `reasoning_text`), and cross-provider reasoning signatures are handled uniformly by `sanitizeReasoningForTR`.

## 9. Change: compaction ownership moved from the Orchestrator to the Driver

The RFC described compaction as "driven by an external Orchestrator". The implementation gives ownership of compaction explicitly to the **Driver layer**:

- The Driver controls the token budget and the cache strategy, and knows the best compaction boundary (providers differ a lot in caching mechanisms)
- The tool call loop can be compacted more aggressively by the Driver (it understands the structure of tool calls)
- Some providers have native compaction support (such as the OpenAI Responses API)
- After compaction the Driver updates the compact cursor, and Rendering filters the viewport accordingly

The app layer can supply importance annotations (for example, a pinned message should not be compacted) as hints, but does not own the compaction mechanism itself.

## 10. Refinement: conclusions on the RFC discussion points

The RFC closed with two points for discussion; the current conclusions:

**Discussion point 1, "Where should the boundary of a pure-function pipeline be drawn?"**:
The three DCP layers (Adaptation / Projection / Rendering) stay pure functions. Side effects (LLM calls, tool execution, compaction) are carried by the added Driver layer. This is "pure core + side-effect shell": the complexity stays controllable, because the Driver is the outermost layer of the pipeline and does not contaminate the internal data flow.

**Discussion point 2, "Breaking the 1:1 response paradigm"**:
The direction is unchanged: the bot decides on its own whether to reply through the `send_message` tool call. This paradigm shift is absorbed in the Driver layer and does not affect the inside of the DCP pipeline.

## 11. Change: rich text from an offset format to a content node tree

The RFC / Gemini chat discussion proposed that the IC should be a "Context AST", with the ContentReducer "responsible for parsing rich-text entities". The implementation goes further and moves rich-text parsing forward into the **Adaptation layer**:

- `text + entities[]` (Telegram's offset-annotation format) is a platform-specific encoding and should not leak into the DCP
- Adaptation parses it into a `ContentNode[]` tree: leaf nodes (text/code/pre) + container nodes (bold/italic/link/mention/...)
- The `CanonicalEntity` type was deleted, and `CanonicalMessageEvent` and `CanonicalEditEvent` now use `content: ContentNode[]`
- ICMessage was changed to `content: ContentNode[]` as well
- Rendering receives the structured content tree and only serializes it (a strategy decides how to emit each node type); it does not need to parse any encoding

Responsibility boundaries: Adaptation does format decoding (mechanical conversion), Projection does state management (does not touch content representation), Rendering does serialization (strategy).

## 12. Change: ID types in the canonical layer from number to string

Telegram uses numeric message IDs, but other IM platforms (Discord snowflakes, Slack timestamps) use strings. `messageId: number` is a leak of Telegram's type.

- `CanonicalMessageEvent.messageId`, `CanonicalEditEvent.messageId`: `number` → `string`
- `CanonicalDeleteEvent.messageIds`: `number[]` → `string[]`
- `CanonicalMessageEvent.replyToMessageId`: `number` → `string`
- Adaptation performs `String(msg.messageId)` during conversion
- The messageId/replyToMessageId of ICMessage are already strings, and Projection no longer needs to convert types
- The `message_id` and `reply_to_message_id` columns of the events table changed from INTEGER to TEXT
- The messages table is unchanged: it stores raw platform data, where the Telegram messageId is a number

## 13. New: scheduling belongs to the Driver layer

The RFC / early design described debounce/throttle as unassigned scheduling logic "between Projection and Rendering". It now explicitly belongs to the **Driver layer**:

- The Driver already manages the tool call loop and knows when the IC should be re-rendered; if debounce lived in an external orchestration layer, that layer would have to coordinate with the Driver ("are you in a loop? should a re-render be inserted?"), which adds needless coupling
- The Driver controls the token budget and the provider cache strategy, which directly affect scheduling behaviour (for example judging whether a new request is worthwhile)
- The concrete scheduling parameters are still strategy, not architecture

Current implementation: **no debounce**. The Driver's reply effect fires immediately after detecting a new external message (`setTimeout(0)` is used only to get out of the synchronous signal graph). Natural batching is achieved through the `running` signal: while running, no new call is started, messages arriving in the meantime accumulate naturally, and the next call handles them together.

## 14. New: the tool call loop can be interrupted by new messages

Each LLM API call produces its own TR (rather than the whole tool call loop being synthesized into one TR).

**TR structure**: each TR stores the full output of the current step: the assistant response + the tool results executed in this step. TR₁ = `[assistant₁, tool_result₁]` (if assistant₁ made a tool call), TR₂ = `[assistant₂]` (if assistant₂ made no tool call). Append-only: each TR is written once, after its API call has returned and its tools have finished executing.

**Interrupt mechanism**: each iteration of the tool call loop checks through `checkInterrupt` whether a new external message has arrived. If so, the loop breaks immediately, and the Driver's reactive effect schedules a complete new LLM call (re-composing the context, re-rendering the system prompt, resetting the step budget). This is an **interrupt + re-schedule** mechanism, not mid-loop re-rendering.

The `receivedAtMs` of the new message is necessarily > the `requestedAtMs` of the TR that triggered the tool call (causality), so in the merge it naturally sorts after that TR.
