<p align="center">
  <a href="https://ice.dev">
    <img alt="ice logo" src="https://ice.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@zykairotis/ice-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@zykairotis/ice-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Ice Agent Harness

This is the home of the Ice agent harness project including our self extensible coding agent.

* **[@zykairotis/ice-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@zykairotis/ice-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@zykairotis/ice-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Ice:

* [Visit ice.dev](https://ice.dev), the project website with demos
* [Read the documentation](https://ice.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@zykairotis/ice-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@zykairotis/ice-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@zykairotis/ice-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@zykairotis/ice-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

The ICE `ice` launcher includes policy controls such as guarded plan/build modes and Subagents V2 allow/ask/deny decisions. These controls do not sandbox filesystem, process, network, or credential access: tools and child processes still run with the permissions of the user who launched ICE. For an independent security boundary, containerize or sandbox ICE. See the [Subagents V2 guide](packages/coding-agent/docs/subagents-v2.md), [security documentation](packages/coding-agent/docs/security.md), and [containerization guide](packages/coding-agent/docs/containerization.md) for details and three isolation patterns:

- **Gondolin extension**: keep `ice` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `ice` process in a local container for simple isolation.
- **OpenShell**: run the whole `ice` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Ice can also be found in [RFCs](https://rfc.earendil.com/keyword/ice/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./ice-test.sh         # Run ice from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "ice-${VERSION}-source.tar.gz"
cd "ice-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `ICE_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `ice update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Ice or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `ice-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `ice-mono` sessions.

I regularly publish my own `ice-mono` work sessions here:

- [badlogicgames/ice-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/ice-mono)

## License

MIT

<p align="center">
  <a href="https://ice.dev">ice.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
