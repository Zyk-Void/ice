---
name: ice-subagent-create
description: Create or revise ICE agent definition files with specialist roles, tool lists, permissions, models, skills, prompts, MCP selections, and hook selections. Use when asked to add an agent, create a reviewer/coder role, import a Claude Code agent, or explain how a custom subagent is defined.
---

# Create an ICE agent

Read `../../../packages/coding-agent/docs/subagents-v2.md` before authoring. Resolve that path relative to this skill directory. Read the definition schema (`src/subagents/definitions/schema.ts`) if the doc and runtime disagree.

1. Inspect existing `.ice/agents` and `~/.ice/agents` files. Do not overwrite an existing agent without confirming intentional replacement. `/agents new <name> [--project]` creates a valid starter file.
2. Choose the narrowest tools. An agent file requests capabilities; it never grants more than the parent has.
3. Use only supported frontmatter keys (`name`, `description`, `tools`, `disallowedTools`, `model`, `permissions`, `permissionMode`, `isolation`, `skills`, `prompts`, `context`, `mcp`, `hooks`, `spawns`, and the rest in the doc). Unknown or removed keys reject with the replacement named.
4. Keep the body as task guidance: scope, expected output, evidence, and checks not run. No secrets or policy in prose.
5. Validate with `ice agents validate <path>` and `ice agents list`. Never start an agent or spend provider tokens merely to validate a file.
6. Report path, intended role, requested tools, and unrun validation.

Example:

```markdown
---
name: api-review
description: Inspect API compatibility and validation with file-level evidence.
tools: [read, grep, find, ls]
permissionMode: review
---
Inspect the requested scope. Return concrete findings and existing evidence paths.
Distinguish observed facts, uncertainties, and checks not run.
```
