# LuckyBot Plugin Specification

This document is the normative architectural and API specification for LuckyBot plugins. All plugins implemented in the plugin repository (`plugins/`, submodule pointing to `LuckyBot-Plugin`) follow the contracts and invariants defined here.

---

## 1. System Overview and Core/Plugin Boundary

LuckyBot's core operates as the **host**. The plugin repository holds the **contract (`src/sdk/`)** and independent plugin modules. Core mounts the plugin repository as a Git submodule at `plugins/`.

```text
LuckyBot (Core Host)
  ├── src/plugins/            Plugin host, capability providers, HTTP server
  ├── src/runtime-event.ts    Generic 'plugin_event' runtime representation
  └── plugins/ (submodule)    LuckyBot-Plugin repository
        ├── src/sdk/          Plugin SDK type definitions and definePlugin
        ├── src/tavern/       Tavern webhook protocol implementation
        ├── src/games/        Game modules (e.g. Liar's Bar)
        └── src/index.ts      Static registry of plugins
```

### Core Invariants

1. **Static Composition**: Plugins are registered via static imports in `plugins/src/index.ts`. There is no filesystem scanning, dynamic `import()`, or runtime reflection.
2. **Strict Encapsulation**: Plugins **never** receive:
   - The DI container (`tsyringe`).
   - The SQLite database connection (`DB`).
   - Platform clients (TDLib, Feishu SDK/WSClient).
   - The Deterministic Context Pipeline (IC/RC) or conversation chat logs.
3. **Capability Injection**: Plugins interact with LuckyBot solely through capabilities explicitly passed by the host into `setup(ctx)`.

---

## 2. Plugin Declaration

Every plugin exports a definition created with `definePlugin`:

```ts
import { CURRENT_SDK_VERSION, definePlugin } from '../sdk';
import * as v from 'valibot';

export interface MyPluginConfig {
  apiKey: string;
}

export const myPlugin = definePlugin<MyPluginConfig>({
  id: 'my_plugin',
  sdkVersion: CURRENT_SDK_VERSION,
  configSchema: v.object({
    apiKey: v.string(),
  }),
  contributes: {
    promptHints: (chatId: string) => [
      {
        placement: 'system',
        text: 'Optional prompt instructions for this chat.',
      },
    ],
  },
  setup(ctx) {
    // Register HTTP routes, initialize state
  },
  stop() {
    // Clean up timers, in-flight work
  },
});
```

### SDK Version Policy

- The current SDK version is `CURRENT_SDK_VERSION = 1`.
- Any breaking change to `PluginCapabilities`, `PluginContext`, or the extension point interfaces requires bumping `CURRENT_SDK_VERSION`.
- During startup, the host checks `plugin.sdkVersion === CURRENT_SDK_VERSION`. Any version mismatch throws an error immediately to prevent undefined runtime behavior.

---

## 3. Injected Capabilities

When an enabled plugin is started, the host passes `PluginContext<TConfig>` containing `config` and `capabilities`:

### 1. `callModel(modelName, prompt, options)`

Invokes an LLM endpoint configured in core (`config.models[modelName]`) via `src/llm/call.ts`.

- `prompt`: String or `{ system?: string; user: string }`.
- `options.timeoutSec`: Request timeout in seconds.
- `options.dumpId`: Optional debug dump identifier (e.g. `${chatId}.plugin`).

### 2. `http.route(route)`

Registers an HTTP route on the host's unified HTTP server (`node:http`):

- `route.method`: `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | '*'`.
- `route.path`: Route pattern with optional parameter extraction (e.g. `/v1/games/:game/matches/:match_id`).
- `route.handler`: Receives `HttpRequest` with `headers`, parsed `params`, `rawBody` (Buffer), and parsed `body` (JSON if applicable). Returns `HttpResponse` (`status`, `headers`, `body`).
- Handlers run behind a body size limit (64 KB). Any thrown error is caught by the host and returned as HTTP 500 without leaking stack traces or internal secrets.

> **Path Preservation Notice for Reverse Proxies**: Protocols such as Tavern compute HMAC signatures over the exact request path (`timestamp.METHOD.path.rawBody`). When deploying behind a reverse proxy (e.g. Cloudflare Tunnel, Nginx, frp), the proxy **must pass the request path through without rewriting, stripping, or modifying prefixes**, otherwise signature verification will fail.

### 3. `chat.publish(chatId, options)`

The **only** authorized mechanism for a plugin to publish messages into a chat:

- `options.kind`: Optional event category (e.g. `'game_event'`).
- `options.text`: Sanitized public text to display in the group.
- `options.wake`: Whether this event should wake the Driver (`notifyDriver`).

**Identity & Gating**:
- The host automatically stamps the calling plugin's own ID (`plugin: pluginId`), preventing plugins from spoofing another plugin's identity.
- If the target `chatId` does not have `chats.<chatId>.plugins.<pluginId>.enabled: true`, the host drops the publication silently.

When allowed, the event is saved in the database as a generic runtime event (`kind: 'plugin_event'`) and rendered in context as:

```xml
<plugin-event plugin="tavern" t="10-22 20:30:00">Alice challenged Bob!</plugin-event>
```

### 4. `storage`

Provides access to an isolated, writable filesystem directory for the plugin under the host's data volume:

- `ctx.capabilities.storage.rootDir`: Points to `<dataDir>/plugins/<pluginId>/` (ensured to exist).

### 5. `log`

Provides a scoped logger (`ctx.capabilities.log`) outputting under context `plugin:<pluginId>`.

### 6. `media.send(chatId, media)`

Interface stub for sending outbound media. In the current release, invoking this method throws a typed error (`media.send is unsupported`).

---

## 4. Privacy Invariant

The privacy invariant is the most critical security boundary for plugins:

1. **Private State Isolation**: Private state (e.g. secret game hands, internal tokens, hidden session data) must reside solely in the plugin's in-memory state or local `storage`.
2. **Context Secrecy**: Private state must **never** enter:
   - Core projection or Intermediate Context (`IC`).
   - Rendered XML Context (`RC`).
   - SQLite `events` or `turn_responses` tables.
   - Long-term person memory.
   - The Driver's system or user prompts.
3. **Public Events Only**: Plugins only push public, broadcast-safe text through `chat.publish`.
4. **Mandatory Testing**: Every plugin handling private data must include automated regression tests asserting that private data is never forwarded to `chat.publish`.

---

## 5. Configuration & Secrets

Configuration follows core deployment practices:

### Core Configuration (`config.yaml`)

```yaml
plugins:
  server:
    host: "0.0.0.0"
    port: 8787
  tavern:
    secret: "shared_hmac_secret"
    model: "probe"
    decisionTimeoutMs: 10000
    tableName: "LuckyBot"

chats:
  default:
    plugins:
      tavern:
        enabled: false
  oc_example_group:
    plugins:
      tavern:
        enabled: true
```

- **Default-off**: Plugins are disabled globally and per chat by default.
- **Secrets redaction**: Plugin secrets in `config.yaml` are registered with `registerHttpSecret` so they are automatically redacted from error logs.
- **No secrets in repository**: Plugins must never hardcode credentials or commit sample secrets.

---

## 6. Extension Points

Declared in `plugin.contributes`:

| Extension Point | Status | Description |
|---|---|---|
| `httpRoutes` | Implemented | Static routes mounted on the core HTTP server. |
| `promptHints` | Implemented | `(chatId: string) => PromptHint[]` contributing system prompt instructions for chats where the plugin is enabled. |
| `tools` | Declared | Primary LLM tools callable during the Driver's turn loop. |
| `memoryBackend` | Declared | Custom memory storage backend (e.g. Mem0). |
| `mediaResolvers` | Declared | Media frame/transcription resolvers (e.g. speech-to-text). |
| `scenes` | Declared | Multi-turn contextual scene state machines (scheduled for round 2b). |

---

## 7. Lifecycle Order

1. **Process Start**: Container is built; database migrated; platform identity prepared.
2. **Plugin Host Initialization**: `PluginHost` resolves registered plugins, verifies `sdkVersion`, and validates configs.
3. **Driver Activation**: Driver is attached and input bus activated.
4. **Plugin Startup**:
   - `PluginHost.start()` starts the unified HTTP server if routes exist.
   - `plugin.setup(ctx)` is invoked for every enabled plugin.
5. **Process Shutdown**:
   - `PluginHost.stop()` is executed **first**: `plugin.stop?()` is called on each plugin, followed by closing the HTTP server.
   - Driver and background tasks shut down.
   - Platform clients stop.
   - Database closes and container disposes.

---

## 8. Step-by-Step: Adding a New Plugin

1. In `plugins/src/`: create directory for your plugin (e.g. `src/my-plugin/`).
2. Implement your plugin using `definePlugin`:
   - Set `sdkVersion: CURRENT_SDK_VERSION`.
   - Provide a Valibot `configSchema`.
   - Register routes via `ctx.capabilities.http.route` or `contributes.httpRoutes`.
   - Publish public chat events via `ctx.capabilities.chat.publish`.
3. Export your plugin in `plugins/src/index.ts`.
4. Add unit tests verifying:
   - Correct functionality under mocked capabilities.
   - Complete enforcement of the privacy invariant.
5. Configure `config.yaml`:
   - Add configuration under `plugins.<id>`.
   - Enable the plugin for desired chats under `chats.<chatId>.plugins.<id>.enabled: true`.
