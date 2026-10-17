# LarkBot

> [!WARNING]
> Work in progress. LarkBot is under active development and is not ready for use. A Feishu/Lark adapter with bounded, optional participation is implemented and has run in a real private group (live runs on 2026-10-16 and 2026-10-17). Long-term memory, a trusted maintainer list, and isolated Bash/browser access are still planned. This is not a production-ready release.

LarkBot is a Feishu/Lark-first, LLM-driven group-chat bot for a small private community. It is meant to hang out in a group, with its own personality and memories—not to serve as a personal assistant or a productivity tool.

## Origin

This project is based on [Cahciua (菜花)](https://github.com/Menci/Cahciua) by [Menci](https://github.com/Menci). It retains the upstream Git history and builds on Cahciua's message persistence, context pipeline, reply scheduling, tool execution, and context compaction.

Because substantial changes are planned and the direction differs from upstream, this project is currently maintained as a separate repository rather than a GitHub fork. This does not change its origin or the credit due to the original author.

## Planned Direction

- Feishu/Lark integration first, with room for other chat platforms later.
- Mention-triggered and ambient participation, with the freedom to respond, react, decline, or stay silent—even after using tools.
- A consistent identity and personality, with long-term memories of individual group members.
- An explicitly configured owner/maintainer list, separate from conversational memory.
- Bounded tool execution for timely conversation, with isolated Bash and browser access when needed.
- Feishu context lookup through CLI/Skills or MCP, alongside the existing context compaction mechanism.

## Setup

```sh
pnpm install
cp config.example.yaml config.yaml     # then fill in models and chat ids
cp prompts/IDENTITY.example.md prompts/IDENTITY.md   # then write the bot's persona
```

`prompts/IDENTITY.md` is deployment-local and gitignored (`prompts/.gitignore`); `prompts/IDENTITY.example.md` is the tracked neutral template showing the expected sections. Replace its sample text with your own persona and delete its one template comment. Both are loaded through the chat's `systemFiles` list in `config.yaml`.

## Development

The inherited implementation uses TypeScript, Node.js >=22, pnpm, and SQLite. See the implementation notes for the current scope, configuration, and remaining limitations. Browser isolation, per-person long-term memory, and maintainer authorization are still planned; the inherited Bash tool is not automatically sandboxed:

- [Feishu implementation notes](docs/feishu-implementation.md)
- [Integration status](docs/integration-status.md)

Architecture and contributor documentation:

- [Agent guide](AGENTS.md)
- [Context pipeline design](docs/dcp-design.md)
- [Driver development guide](docs/driver-feature-guide.md)
- [Project discussion notes (Chinese)](docs/项目讨论记录.md)

Do not commit credentials, local databases, sessions, or model request dumps.

## License

LarkBot is released under the [MIT License](LICENSE). It is derived from [Cahciua](https://github.com/Menci/Cahciua), which is MIT-licensed by Menci; the original copyright notice is retained in `LICENSE`.
