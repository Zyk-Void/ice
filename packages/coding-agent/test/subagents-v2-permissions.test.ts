import { describe, expect, it } from "vitest";
import { ApprovalBroker, type ApprovalRequest } from "../src/subagents/permissions/approval.ts";
import { childDelegationTools, deriveChildDecision } from "../src/subagents/permissions/derive-child.ts";
import {
	evaluatePermission,
	evaluatePermissionSubjects,
	type PermissionRuleSet,
} from "../src/subagents/permissions/evaluate.ts";
import {
	AGENT_PERMISSION_MODES,
	CHILD_MUTATION_CEILING,
	globMatches,
	PERMISSION_DECISIONS,
	type PermissionRuleScope,
	permissionRank,
} from "../src/subagents/permissions/rules.ts";
import {
	bashGrantPrefix,
	extractPermissionSubjects,
	type PermissionSubject,
	splitShellCommand,
} from "../src/subagents/permissions/subjects.ts";

const set = (scope: PermissionRuleScope, rules: PermissionRuleSet["rules"]): PermissionRuleSet => ({
	origin: { scope, carrier: "settings" },
	rules,
});
const bash = (command: string) => extractPermissionSubjects({ tool: "bash", args: { command }, cwd: "/repo" });
const one = (subjects: PermissionSubject[]) => subjects[0]!;

describe("subagent V2 rule matching and subjects", () => {
	it("matches path globs gitignore-style and other globs freely", () => {
		expect(globMatches("src/**", "src/a/b.ts", true)).toBe(true);
		expect(globMatches("src/*", "src/a/b.ts", true)).toBe(false);
		expect(globMatches("**/.env*", ".env.local", true)).toBe(true);
		expect(globMatches("**/.env*", "pkg/.env", true)).toBe(true);
		expect(globMatches("git push*", "git push origin main")).toBe(true);
		expect(globMatches("mcp__github__*", "mcp__github__create_issue")).toBe(true);
		expect(globMatches("a.b", "aXb")).toBe(false);
	});

	it("splits shell commands at separators but not at redirections", () => {
		expect(splitShellCommand("npm test 2>&1 | tee log; git status && echo ok")).toEqual([
			"npm test 2>&1",
			"tee log",
			"git status",
			"echo ok",
		]);
		expect(splitShellCommand("sleep 1 & rm -rf x")).toEqual(["sleep 1", "rm -rf x"]);
		expect(one(bash("echo $(cat ~/.ssh/id_rsa)")).opaque).toBe(true);
	});

	it("adds an external_directory subject for paths outside cwd", () => {
		const subjects = extractPermissionSubjects({ tool: "edit", args: { path: "../other/x.ts" }, cwd: "/repo" });
		expect(subjects.map((subject) => [subject.tool, subject.value, subject.subjectClass])).toEqual([
			["edit", "/other/x.ts", "edit-write"],
			["external_directory", "/other/x.ts", "external-directory"],
		]);
		expect(extractPermissionSubjects({ tool: "read", args: { path: "src/a.ts" }, cwd: "/repo" })[0]?.value).toBe(
			"src/a.ts",
		);
	});

	it("classifies adapters by declared access and fails unknown tools safe", () => {
		const mcp = (adapterAccess?: "read-only" | "mutation" | "unknown") =>
			one(
				extractPermissionSubjects({
					tool: "mcp__gh__list",
					args: {},
					cwd: "/",
					...(adapterAccess ? { adapterAccess } : {}),
				}),
			).subjectClass;
		expect(mcp("read-only")).toBe("read");
		expect(mcp("mutation")).toBe("mutation-adapter");
		expect(mcp()).toBe("mutation-adapter");
	});

	it("offers a subcommand-aware session grant prefix", () => {
		expect(bashGrantPrefix("git push origin main")).toBe("git push");
		expect(bashGrantPrefix("npm run build -- --watch")).toBe("npm run build");
		expect(bashGrantPrefix("ls -la src")).toBe("ls");
	});
});

describe("subagent V2 permission evaluator", () => {
	it("lets deny win over ask over allow across rule sets", () => {
		const subject = one(bash("git push origin"));
		const evaluate = (ruleSets: PermissionRuleSet[]) =>
			evaluatePermission({ subject, ruleSets, fallback: "allow", mode: "build" }).decision;
		expect(evaluate([set("user", { allow: ["bash"] }), set("project", { ask: ["bash(git *)"] })])).toBe("ask");
		expect(evaluate([set("user", { allow: ["bash(git push*)"] }), set("cli", { deny: ["bash(git push*)"] })])).toBe(
			"deny",
		);
		expect(evaluate([])).toBe("allow");
	});

	it("never auto-allows a command substitution", () => {
		const subject = one(bash("echo $(whoami)"));
		expect(
			evaluatePermission({ subject, ruleSets: [set("user", { allow: ["bash"] })], fallback: "allow", mode: "build" })
				.decision,
		).toBe("ask");
	});

	it("holds plan/review limits regardless of allow rules", () => {
		const edit = one(extractPermissionSubjects({ tool: "edit", args: { path: "a.ts" }, cwd: "/repo" }));
		for (const mode of ["plan", "review"] as const) {
			const result = evaluatePermission({
				subject: edit,
				ruleSets: [set("managed", { allow: ["edit"] })],
				fallback: "allow",
				mode,
			});
			expect(result).toMatchObject({ decision: "deny", limitedByMode: true });
		}
	});

	it("requires every subcommand to pass", () => {
		const ruleSets = [set("user", { allow: ["bash(git status*)"], deny: ["bash(rm *)"] })];
		const decide = (command: string) =>
			evaluatePermissionSubjects(
				bash(command),
				(subject) => evaluatePermission({ subject, ruleSets, fallback: "ask", mode: "build" }).decision,
			);
		expect(decide("git status")).toBe("allow");
		expect(decide("git status && rm -rf /")).toBe("deny");
		expect(decide("git status; make")).toBe("ask");
	});
});

describe("subagent V2 child permission derivation", () => {
	const base = {
		childRuleSets: [] as PermissionRuleSet[],
		agentMode: "inherit" as const,
		subYolo: false,
		worktree: false,
	};

	it("never makes a child more permissive than its parent (exhaustive)", () => {
		const subjects: PermissionSubject[] = [
			one(extractPermissionSubjects({ tool: "read", args: { path: "a" }, cwd: "/r" })),
			one(extractPermissionSubjects({ tool: "edit", args: { path: "a" }, cwd: "/r" })),
			one(bash("make")),
			one(bash("echo $(id)")),
			one(extractPermissionSubjects({ tool: "mcp__x__y", args: {}, cwd: "/r", adapterAccess: "mutation" })),
			{ tool: "external_directory", value: "/tmp/x", pathMode: true, subjectClass: "external-directory" },
			{ tool: "agent", value: "explore", pathMode: false, subjectClass: "delegation" },
		];
		const ruleChoices: PermissionRuleSet[][] = [
			[],
			[set("user", { allow: ["*"] })],
			[set("managed", { allow: ["*"] })],
			[set("project", { allow: ["*"] })],
			[set("project", { ask: ["*"] })],
			[set("user", { deny: ["*"] })],
		];
		let cases = 0;
		for (const subject of subjects)
			for (const parent of PERMISSION_DECISIONS)
				for (const childRuleSets of ruleChoices)
					for (const agentMode of AGENT_PERMISSION_MODES)
						for (const subYolo of [false, true])
							for (const worktree of [false, true]) {
								const { decision } = deriveChildDecision(subject, parent, {
									childRuleSets,
									agentMode,
									subYolo,
									worktree,
								});
								expect(permissionRank(decision)).toBeLessThanOrEqual(permissionRank(parent));
								cases++;
							}
		expect(cases).toBe(7 * 3 * 6 * AGENT_PERMISSION_MODES.length * 4);
	});

	it("keeps mutation at ask by default and lets only the listed raisers lift it", () => {
		const edit = one(extractPermissionSubjects({ tool: "edit", args: { path: "a" }, cwd: "/r" }));
		const run = one(bash("npm test"));
		const derive = (
			subject: PermissionSubject,
			overrides: Partial<typeof base> & { childRuleSets?: PermissionRuleSet[] },
		) => deriveChildDecision(subject, "allow", { ...base, ...overrides });
		expect(derive(edit, {}).decision).toBe("ask");
		expect(derive(run, {}).decision).toBe("ask");
		expect(derive(edit, { worktree: true })).toEqual({ decision: "allow", raisedBy: "worktree-isolation" });
		expect(derive(run, { worktree: true }).decision).toBe("ask");
		expect(derive(run, { subYolo: true })).toEqual({ decision: "allow", raisedBy: "sub-yolo" });
		expect(derive(run, { childRuleSets: [set("user", { allow: ["bash(npm test*)"] })] })).toEqual({
			decision: "allow",
			raisedBy: "user-allow",
		});
		// A trusted project definition cannot grant itself unattended Bash.
		expect(derive(run, { childRuleSets: [set("project", { allow: ["bash(*)"] })] }).decision).toBe("ask");
		const adapter = one(
			extractPermissionSubjects({ tool: "mcp__x__y", args: {}, cwd: "/r", adapterAccess: "mutation" }),
		);
		expect(derive(adapter, { subYolo: true }).decision).toBe("ask");
	});

	it("lets child rules and agent mode narrow but never widen", () => {
		const read = one(extractPermissionSubjects({ tool: "read", args: { path: ".env" }, cwd: "/r" }));
		expect(
			deriveChildDecision(read, "allow", { ...base, childRuleSets: [set("project", { deny: ["read(**/.env*)"] })] })
				.decision,
		).toBe("deny");
		const edit = one(extractPermissionSubjects({ tool: "edit", args: { path: "a" }, cwd: "/r" }));
		expect(
			deriveChildDecision(edit, "allow", { ...base, agentMode: "plan", subYolo: true, worktree: true }).decision,
		).toBe("deny");
		expect(deriveChildDecision(edit, "ask", { ...base, subYolo: true }).decision).toBe("ask");
	});

	it("caps external directories at ask unless managed policy or --sub-yolo allows", () => {
		const outside: PermissionSubject = {
			tool: "external_directory",
			value: "/tmp/x",
			pathMode: true,
			subjectClass: "external-directory",
		};
		expect(deriveChildDecision(outside, "allow", base).decision).toBe("ask");
		expect(deriveChildDecision(outside, "allow", { ...base, subYolo: true })).toEqual({
			decision: "allow",
			raisedBy: "sub-yolo",
		});
		// --sub-yolo never lifts a child above its parent.
		expect(deriveChildDecision(outside, "ask", { ...base, subYolo: true }).decision).toBe("ask");
		expect(
			deriveChildDecision(outside, "allow", {
				...base,
				childRuleSets: [set("user", { allow: ["external_directory"] })],
			}).decision,
		).toBe("ask");
		expect(
			deriveChildDecision(outside, "allow", {
				...base,
				childRuleSets: [set("managed", { allow: ["external_directory"] })],
			}).decision,
		).toBe("allow");
	});

	it("gates recursive delegation on spawns, depth, parent tool, and parent deny", () => {
		const gate = (overrides: Partial<Parameters<typeof childDelegationTools>[0]>) =>
			childDelegationTools({
				spawns: ["explore", "general"],
				depth: 0,
				maxDepth: 1,
				parentHasAgentTool: true,
				parentDecisionForAgent: (name) => (name === "general" ? "deny" : "allow"),
				...overrides,
			});
		expect(gate({})).toEqual({ tools: ["agent", "agent_control"], spawnable: ["explore"] });
		expect(gate({ maxDepth: 0 }).tools).toEqual([]);
		expect(gate({ spawns: [] }).tools).toEqual([]);
		expect(gate({ parentHasAgentTool: false }).tools).toEqual([]);
		expect(gate({ spawns: ["general"] }).tools).toEqual([]);
		expect(gate({}).tools).not.toContain("agent_patch");
	});

	it("keeps the ceiling table free of project raisers", () => {
		for (const entry of CHILD_MUTATION_CEILING) expect(entry.raisableBy.join()).not.toMatch(/project/);
	});
});

describe("subagent V2 approval broker", () => {
	const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
		id: "r1",
		ownerSessionId: "s1",
		childId: `ag_${"a".repeat(26)}`,
		agent: "worker",
		tool: "bash",
		summary: "bash: git push",
		sessionRule: "bash(git push*)",
		foreground: true,
		...overrides,
	});
	const manualTimers = () => {
		const timers: Array<() => void> = [];
		return {
			timers,
			setTimer: (callback: () => void) => {
				timers.push(callback);
				return { cancel: () => timers.splice(timers.indexOf(callback), 1) };
			},
		};
	};

	it("denies immediately with no approval channel", async () => {
		const broker = new ApprovalBroker({});
		await expect(broker.request(request())).resolves.toEqual({ decision: "deny", source: "no-channel" });
		await expect(broker.request(request({ foreground: false }))).resolves.toEqual({
			decision: "deny",
			source: "no-channel",
		});
	});

	it("lets automated checks decide before prompting", async () => {
		let prompted = false;
		const broker = new ApprovalBroker({
			interactive: async () => {
				prompted = true;
				return "allow-once";
			},
			automatedCheck: async () => "deny",
		});
		await expect(broker.request(request())).resolves.toEqual({ decision: "deny", source: "automated" });
		expect(prompted).toBe(false);
	});

	it("prompts foreground children and returns the session rule for allow-session", async () => {
		const broker = new ApprovalBroker({ interactive: async () => "allow-session" });
		await expect(broker.request(request())).resolves.toEqual({
			decision: "allow",
			source: "user",
			sessionRule: "bash(git push*)",
		});
	});

	it("queues background asks for the inbox and denies on timeout", async () => {
		const { timers, setTimer } = manualTimers();
		const seen: number[] = [];
		const broker = new ApprovalBroker({
			hasInbox: () => true,
			setTimer,
			onChange: (pending) => seen.push(pending.length),
		});
		const answered = broker.request(request({ id: "a", foreground: false }));
		const expired = broker.request(request({ id: "b", foreground: false }));
		await Promise.resolve();
		await Promise.resolve();
		expect(broker.pending.map((pending) => pending.request.id)).toEqual(["a", "b"]);
		expect(broker.respond("a", "allow-once")).toBe(true);
		await expect(answered).resolves.toEqual({ decision: "allow", source: "user" });
		timers[0]!();
		await expect(expired).resolves.toEqual({ decision: "deny", source: "timeout" });
		expect(broker.respond("b", "allow-once")).toBe(false);
		expect(seen.at(-1)).toBe(0);
	});

	it("denies pending asks on owner disconnect and on dispose", async () => {
		const { setTimer } = manualTimers();
		const broker = new ApprovalBroker({ hasInbox: () => true, setTimer });
		const mine = broker.request(request({ id: "x", foreground: false }));
		const other = broker.request(request({ id: "y", ownerSessionId: "s2", foreground: false }));
		await Promise.resolve();
		await Promise.resolve();
		broker.denyOwner("s1");
		await expect(mine).resolves.toEqual({ decision: "deny", source: "disposed" });
		broker.dispose();
		await expect(other).resolves.toEqual({ decision: "deny", source: "disposed" });
		await expect(broker.request(request({ id: "z" }))).resolves.toEqual({ decision: "deny", source: "disposed" });
	});
});
