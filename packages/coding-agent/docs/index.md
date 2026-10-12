# Ice Documentation

Ice is a minimal terminal coding harness. It is designed to stay small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and ice packages.

## Quick start

Install Ice with npm:

```bash
npm install -g --ignore-scripts @zykairotis/ice-coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Ice does not require install scripts for normal npm installs.

On Linux or macOS, you can also use the installer:

```bash
curl -fsSL https://ice.dev/install.sh | sh
```

To uninstall ice itself, use npm for curl and npm installs:

```bash
npm uninstall -g @zykairotis/ice-coding-agent
```

For pnpm, Yarn, or Bun installs, use the matching global remove command: `pnpm remove -g @zykairotis/ice-coding-agent`, `yarn global remove @zykairotis/ice-coding-agent`, or `bun uninstall -g @zykairotis/ice-coding-agent`.

Then run it in a project directory:

```bash
ice
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting ice.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Ice](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [llama.cpp](llama-cpp.md) - run a local router and manage models with `/llama`.
- [Security](security.md) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](containerization.md) - sandbox ice with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) - global and project settings.
- [Subagents V2](subagents-v2.md) - agent definitions, permissions, child lifecycle, and worktree patches.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Ice packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed ice in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Subagents V2 schema and settings](subagents-v2-reference.md)
- [Subagents V2 migration](subagents-v2-migration.md)
- [Subagents V2 architecture](subagents-v2-architecture.md)
- [Environment variables](environment-variables.md) - Ice process configuration and session metadata available to bash tools.
- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
