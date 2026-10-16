# LarkBot

> [!WARNING]
> Work in progress. LarkBot is under active development and is not ready for use. The current codebase still runs the upstream Telegram implementation; Feishu/Lark support and the changes described below are planned, not yet implemented.

LarkBot is a Feishu/Lark-first, LLM-driven group-chat bot for a small private community. It is meant to hang out in a group, with its own personality and memories—not to serve as a personal assistant or a productivity tool.

## Origin

This project is based on [Cahciua (菜花)](https://github.com/Menci/Cahciua) by [Menci](https://github.com/Menci). It retains the upstream Git history and builds on Cahciua's message persistence, context pipeline, reply scheduling, tool execution, and context compaction.

Because substantial changes are planned and the direction differs from upstream, this project is currently maintained as a separate repository rather than a GitHub fork. This does not change its origin or the credit due to the original author.

Menci has granted permission for this private, non-commercial adaptation. That permission is not a license grant to third parties; any future distribution must follow the applicable permissions and license terms.

## Planned Direction

- Feishu/Lark integration first, with room for other chat platforms later.
- Mention-triggered and ambient participation, with the freedom to respond, react, decline, or stay silent—even after using tools.
- A consistent identity and personality, with long-term memories of individual group members.
- An explicitly configured owner/maintainer list, separate from conversational memory.
- Bounded tool execution for timely conversation, with isolated Bash and browser access when needed.
- Feishu context lookup through CLI/Skills or MCP, alongside the existing context compaction mechanism.

## Development

The inherited implementation uses TypeScript, Node.js >=22, pnpm, and SQLite. Existing architecture and contributor documentation describe the current Telegram implementation, not completed LarkBot features:

- [Agent guide](AGENTS.md)
- [Context pipeline design](docs/dcp-design.md)
- [Driver development guide](docs/driver-feature-guide.md)
- [Project discussion notes (Chinese)](docs/项目讨论记录.md)

Do not commit credentials, local databases, sessions, or model request dumps.
