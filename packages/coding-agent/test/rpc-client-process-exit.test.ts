import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ice-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", (line) => {
 const command = JSON.parse(line);
 if (command.type === "get_capabilities") {
  process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{protocolVersion:1, commands:["get_capabilities"], features:[], limits:{maxInputLineBytes:16777216}, host:{subagents:false}}}) + "\\n");
 } else process.exit(43);
});
`),
		});

		try {
			await client.start();
			await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
		} finally {
			await client.stop();
		}
	});
});
