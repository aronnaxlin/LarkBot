# LuckyBot

> **Feishu/Lark-first LLM group-chat member with personality and per-person memory, not an assistant.**
> 
> Based on **[Cahciua (菜花)](https://github.com/Menci/Cahciua)** by **[Menci](https://github.com/Menci)**.

LuckyBot is an open-source, Feishu/Lark-first adaptation of [Cahciua (菜花)](https://github.com/Menci/Cahciua) by Menci. It retains upstream Git history and Cahciua's core architectural strengths—message persistence, the deterministic context pipeline, reply scheduling, tool execution, and context compaction—while evolving the bot into an authentic group-chat participant with long-term memory, personality, and bounded participation.

Rather than acting as an obedient productivity assistant, LuckyBot behaves as an authentic member of a small community group: it speaks when it has something meaningful to say, reacts with emoji, declines requests in character, or remains silent.

## Origin & Heritage

This project is a direct adaptation of **[Cahciua (菜花)](https://github.com/Menci/Cahciua)**, created by **[Menci](https://github.com/Menci)** and released under the MIT License.

LuckyBot keeps Cahciua's foundation: message persistence and deterministic replay, the Deterministic Context Pipeline (`IC' = reduce(IC, event)` rendered to provider-independent XML), the probe gate and reply scheduling, the tool loop, provider transports, and background context compaction.

On top of it, LuckyBot adds:
- Native Feishu/Lark integration over the official long connection.
- Per-person Markdown long-term memory with provenance checks enforced in code.
- Bounded participation: legitimate silence or reaction-only turns, per-turn tool and time budgets, and per-chat talkativeness controls.
- A trusted maintainer list, and a Docker deployment with the Bash tool in a separate sandbox container.

## Features

- **Natural Group-Chat Participation:** Uses an outside-judge probe gate before primary execution to decide whether to respond (`send_message`), react only (`react_only`), or remain silent (`no_action`).
- **Feishu/Lark First:** Native integration with Feishu/Lark via the official WebSocket SDK (`@larksuiteoapi/node-sdk`), supporting ambient and @-mention messages, quoted replies, image inspection (`read_image`), reactions, and member identity tracking.
- **Telegram Support:** Inherited full-featured Telegram adapter powered by TDLib with userbot/bot separation, media understanding, and spam moderation.
- **Deterministic Context Pipeline (DCP):** Pure reducer architecture (`IC' = reduce(IC, event)`) that projects canonical platform events into in-memory context and renders provider-independent XML (`RC`) optimized for prompt-prefix caching.
- **Per-Person Long-Term Memory (Phase 1):** Human-readable Markdown cards per member (`people/<open_id>.md`) and self-notes (`SELF.md`), maintained by an asynchronous background consolidator with strict provenance validation, owner-evidence requirements, and prompt-injection safety guards.
- **Safe & Bounded Tool Execution:** Strict per-turn budgets (tool rounds, work-tool limits, model deadlines) prevent runaway loops. System shell access (`bash`, `kill_task`, `read_task_output`) is strictly gated by a trusted maintainer list and executed inside an isolated sandbox container.
- **Autonomous Context Compaction:** Background compaction controller summarizes older context when estimated token counts exceed thresholds, preserving conversation continuity.
- **Modular Plugin System:** Capability-based plugin host running independent extension modules (mounted from `plugins/`, e.g. group mini-game webhooks, web search & fetch) with tool and scene extension points, strict memory/chat privacy isolation, and per-chat gating.

## Quick Start

### Local Setup

Prerequisites: Node.js >= 22, pnpm >= 10.

```sh
pnpm install
cp config.example.yaml config.yaml
cp prompts/IDENTITY.example.md prompts/IDENTITY.md
```

1. Edit `config.yaml` with your platform credentials (`feishu` or `telegram`), model endpoints, and configured chat IDs.
2. Edit `prompts/IDENTITY.md` to define the bot's persona and character traits (see `prompts/IDENTITY.example.md` for section guidelines).
3. Start the bot:

```sh
pnpm start
```

### Production Deployment

For production environments, LuckyBot deploys via Docker Compose with host firewall isolation and a separate sandbox container for the Bash tool:

- Follow the [Docker Deployment Guide](docs/deploy.md) for full instructions on image building, volume setup, SSH key configuration, and firewall management.

## Configuration Pointers

All runtime configuration lives in `config.yaml` (see [config.example.yaml](config.example.yaml)):

- `platform`: Select `'feishu'` or `'telegram'`.
- `feishu`: App credentials (`appId`, `appSecret`, `domain`).
- `telegram`: Bot token, API ID, API hash, and userbot options.
- `models`: Provider endpoints (`openai-chat`, `anthropic-messages`, `responses`) and model settings.
- `maintainers`: Top-level list of canonical platform user IDs authorized to unlock maintainer-gated tools.
- `chats.<chatId>`: Per-chat allowlist configuration, including participation style (`quiet`, `normal`, `lively`), turn budgets, memory toggles, and tool exposure.

## Documentation Index

Detailed architectural and operational documentation is organized as follows:

### Design
- [Plugin System Specification](docs/plugins.md): Architecture of the capability-based plugin host, extension points, and privacy invariants.
- [Context Pipeline Design](docs/dcp-design.md): Architecture of the pure projection reducer, canonical events, and XML rendering pipeline.
- [Driver Feature Guide](docs/driver-feature-guide.md): Driver lifecycle, probe gating, primary tool loop, turn budgets, and tool authoring.
- [Driver Participation Implementation](docs/driver-participation-implementation.md): Participation policy, wake-up decisions, and volume controls.
- [Per-Person Memory Design](docs/memory-design.md): Phase 1 Markdown memory store, background consolidator, provenance rules, and prompt injection.
- [Content-Aware Frame Selection](docs/content-aware-frame-selection.md): Frame selection strategy and deferred work for animations and video stickers.

### Deployment
- [Docker Deployment Guide](docs/deploy.md): Production deployment runbook with Docker Compose, firewall rules, and sandboxed Bash execution.

### Platform
- [Feishu Implementation Notes](docs/feishu-implementation.md): Feishu/Lark WebSocket adapter architecture, event handling, ingress/egress, and permissions.
- [Feishu Integration Research](docs/feishu-integration-research.md): Feishu open-platform research, official Node SDK evaluation, and API constraints.
- [Telegram Module Architecture](docs/telegram-module-architecture.md): Telegram TDLib client integration, session ingress queues, and spam moderation.

### History & Archive
- [Integration Status](docs/integration-status.md): Feishu integration validation status, live run logs, and coordinator history.
- [Context Pipeline Updates](docs/archive/dcp-updates.md): Historical record of context pipeline updates and refinements.
- [Unified API Integration](docs/archive/unified-api-integration.md): Historical notes on provider-independent LLM conversation IR.

For developer guidelines and core invariants, see [AGENTS.md](AGENTS.md).

## Development

```sh
pnpm dev        # Start development runner with file watching
pnpm build      # Bundle application with tsdown
pnpm typecheck  # Run TypeScript type check
pnpm lint       # Lint source code with ESLint
pnpm test:run   # Run test suite with Vitest
```

Never commit credentials, local databases (`data/*.db`), user session tokens, or LLM request dumps (`/tmp/cahciua/`).

## Roadmap

- **Browser Exploration:** Isolated browser tool for web search and page inspection.
- **Feishu Document Lookup:** Workspace and document search tools via Feishu OpenAPI / CLI / MCP.
- **Probe alternatives:** Compare Jev and other judges against the current probe on anonymized chats.
- **Media Enhancements:** Content-aware frame selection for animated stickers and video clips.

## Acknowledgements

Special thanks to **[Menci](https://github.com/Menci)** for creating **[Cahciua (菜花)](https://github.com/Menci/Cahciua)**, providing the foundation and inspiration for this project.

## Sponsors

LuckyBot runs on paid model API calls and hosting, and its presence in the group is sustained by people who choose to fund it. Thanks to **[liuyuze2005](https://github.com/liuyuze2005)** for his financial support, which goes directly toward keeping LuckyBot alive in the chat.

## License

LuckyBot is released under the [MIT License](LICENSE). It is derived from [Cahciua](https://github.com/Menci/Cahciua), which is MIT-licensed by Menci; the original copyright notice is retained in `LICENSE`.
