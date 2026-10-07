import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Explicit live test: one read-only ICE tool call, no edits, no arbitrary shell commands.
const cwd = await fs.mkdtemp(join(tmpdir(), "ice-claude-sdk-smoke-"));
const marker = randomUUID();
const filename = join(cwd, "proof.txt");
const extension = fileURLToPath(new URL("../src/claude-sdk/extension.ts", import.meta.url));
const worktree = fileURLToPath(new URL("../../../", import.meta.url));
const launcher = join(worktree, "ice-test.sh");
await fs.writeFile(filename, `${marker}\n`, { mode: 0o600 });
let capturedRecords = [];
try {
  const pending = promisify(execFile)("/usr/bin/bash", [launcher,
    "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-session",
    "--provider", "claude-sdk", "--model", "claude-haiku-4-5-20251001", "--thinking", "off", "--tools", "read", "--mode", "json", "-p",
    `Read the local file ${filename} using the read tool, then answer only with its complete contents. Do not guess, do not run commands, and do not read other files.`,
  ], { cwd, env: { ...process.env, ICE_OFFLINE: "1" }, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  // ICE consumes piped stdin before a print-mode prompt. The test owns this pipe.
  pending.child.stdin.end();
  const result = await pending;
  const records = result.stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  capturedRecords = records;
  const starts = records.filter((event) => event.type === "tool_execution_start");
  const ends = records.filter((event) => event.type === "tool_execution_end");
  const serialized = JSON.stringify(records);
  assert.ok(starts.length >= 1, "The native ICE loop did not emit a tool execution.");
  assert.ok(starts.every((event) => event.toolName === "read"), "An unexpected tool executed.");
  assert.ok(ends.every((event) => event.isError !== true), "A native tool failed.");
  assert.ok(serialized.includes(marker), "The real file result did not reach the native ICE conversation.");
  const final = records.filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1)?.message;
  assert.ok(final?.content?.some((block) => block.type === "text" && block.text.includes(marker)), "The model did not receive the real ICE tool result.");
  assert.equal(final.provider, "claude-sdk");
  assert.notEqual(final.stopReason, "error");
  console.log(JSON.stringify({ passed: true, worktree, chain: "ICE CLI -> worktree extension -> local OmniRoute SDK bridge -> official Claude SDK -> ICE read tool -> Claude final answer", toolExecutions: starts.length, provider: final.provider, stopReason: final.stopReason }));
} catch (error) {
  // Never print an entire child transcript or environment. Report only the assertion or exit classification.
  const code = error && typeof error === "object" && "code" in error ? error.code : "assertion";
  const transcript = typeof error?.stdout === "string" ? error.stdout : "";
  const parsed = transcript.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const events = (parsed.length ? parsed : capturedRecords).slice(-24).map((event) => ({ type: event.type, toolName: event.toolName, isError: event.isError, role: event.message?.role, stopReason: event.message?.stopReason, error: typeof event.message?.errorMessage === "string" && event.message.errorMessage.startsWith("Claude SDK") ? event.message.errorMessage : undefined }));
  console.error(JSON.stringify({ passed: false, code, eventCount: parsed.length || capturedRecords.length, events, stderrBytes: typeof error?.stderr === "string" ? error.stderr.length : 0, detail: error instanceof assert.AssertionError ? error.message : "Live CLI process failed; inspect a targeted diagnostic." }));
  process.exitCode = 1;
} finally { await fs.rm(cwd, { recursive: true, force: true }); }
