/** Selected skill/prompt/context resource resolution and revalidation (moved from ice-subagents.ts). */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import {
	findNearestDirectory,
	hashSource,
	type SubagentResourceResolutionOptions,
} from "../definitions/legacy-profiles.ts";
import { canonicalPath, isPathWithin } from "../tools/paths.ts";
import type {
	ResolvedSubagentResources,
	SubagentProfileSource,
	SubagentResourceKind,
	SubagentResourceProvenance,
	SubagentResourceSelection,
} from "../types.ts";
import { SubagentError } from "./helpers.ts";

type ResourceRoot = {
	source: Exclude<SubagentProfileSource, "self">;
	path: string;
};

function resourceRoots(kind: SubagentResourceKind, options: SubagentResourceResolutionOptions): ResourceRoot[] {
	const agentDir = options.agentDir ?? getAgentDir();
	const userPath = join(agentDir, kind === "skill" ? "skills" : kind === "prompt" ? "prompts" : "context");
	const projectPath =
		kind === "context"
			? options.cwd
			: findNearestDirectory(options.cwd, join(CONFIG_DIR_NAME, kind === "skill" ? "skills" : "prompts"));
	// ice resolves global(user) first; the trusted project layer is the fallback.
	const roots: ResourceRoot[] = [{ source: "user", path: userPath }];
	if (projectPath) roots.push({ source: "project", path: projectPath });
	return roots;
}

function selectedResourceCandidate(kind: SubagentResourceKind, name: string, root: string, cwd: string): string {
	const explicit = isAbsolute(name) || name.startsWith(".") || name.includes("/") || name.includes("\\");
	if (explicit) return resolve(cwd, name);
	if (kind === "skill") return join(root, name, "SKILL.md");
	return kind === "prompt" ? join(root, `${name}.md`) : join(root, name);
}

const MAX_SELECTED_RESOURCE_BYTES = 128 * 1024;
export const MAX_SELECTED_RESOURCES_BYTES = 512 * 1024;

function readBoundedResourceFile(path: string, kind: SubagentResourceKind, name: string): Buffer {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(path);
	} catch {
		throw new SubagentError("untrusted_resource", `Selected ${kind} changed or disappeared: ${name}`);
	}
	if (!stats.isFile()) {
		throw new SubagentError("untrusted_resource", `Selected ${kind} is not a file: ${name}`);
	}
	if (stats.size > MAX_SELECTED_RESOURCE_BYTES) {
		throw new SubagentError("malformed_result", `Selected ${kind} is too large: ${name}`);
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		throw new SubagentError("untrusted_resource", `Selected ${kind} cannot be read: ${name}`);
	}
	if (bytes.byteLength > MAX_SELECTED_RESOURCE_BYTES) {
		throw new SubagentError("malformed_result", `Selected ${kind} is too large: ${name}`);
	}
	return bytes;
}

function assertSelectedResourceByteBudget(resources: ResolvedSubagentResources): void {
	let totalBytes = 0;
	for (const resource of [...resources.skills, ...resources.prompts, ...resources.context]) {
		let size: number;
		try {
			size = statSync(resource.canonicalPath).size;
		} catch {
			throw new SubagentError(
				"untrusted_resource",
				`Selected ${resource.kind} changed or disappeared: ${resource.name}`,
			);
		}
		if (size > MAX_SELECTED_RESOURCE_BYTES) {
			throw new SubagentError("malformed_result", `Selected ${resource.kind} is too large: ${resource.name}`);
		}
		totalBytes += size;
		if (totalBytes > MAX_SELECTED_RESOURCES_BYTES) {
			throw new SubagentError("malformed_result", "Selected resources exceed the aggregate byte budget.");
		}
	}
}

function resolveSelectedResource(
	kind: SubagentResourceKind,
	name: string,
	options: SubagentResourceResolutionOptions,
): SubagentResourceProvenance {
	if (!name || name.length > 4096 || Buffer.byteLength(name) > 4096) {
		throw new SubagentError("malformed_result", `Selected ${kind} name is invalid.`);
	}
	const roots = resourceRoots(kind, options);
	const explicit = isAbsolute(name) || name.startsWith(".") || name.includes("/") || name.includes("\\");
	if (explicit) {
		const candidate = resolve(options.cwd, name);
		if (!roots.some((root) => isPathWithin(resolve(root.path), candidate))) {
			throw new SubagentError("untrusted_resource", `Selected ${kind} is outside approved resource roots: ${name}`);
		}
	}
	for (const root of roots) {
		if (!existsSync(root.path)) continue;
		const candidate = selectedResourceCandidate(kind, name, root.path, options.cwd);
		if (!existsSync(candidate)) continue;
		let canonicalSourcePath: string;
		try {
			canonicalSourcePath = canonicalPath(candidate);
		} catch {
			throw new SubagentError("untrusted_resource", `Selected ${kind} cannot be resolved: ${name}`);
		}
		let canonicalRoot: string;
		try {
			canonicalRoot = canonicalPath(root.path);
		} catch {
			continue;
		}
		if (!isPathWithin(canonicalRoot, canonicalSourcePath)) {
			throw new SubagentError(
				"untrusted_resource",
				`Selected ${kind} escapes its ${root.source} resource root: ${name}`,
			);
		}
		if (!statSync(canonicalSourcePath).isFile()) {
			throw new SubagentError("untrusted_resource", `Selected ${kind} is not a file: ${name}`);
		}
		if (root.source === "project" && !options.projectTrusted) {
			throw new SubagentError("untrusted_resource", `Project ${kind} "${name}" requires project trust.`);
		}
		const sourceBytes = readBoundedResourceFile(canonicalSourcePath, kind, name);
		return {
			kind,
			name,
			source: root.source,
			sourcePath: resolve(candidate),
			canonicalPath: canonicalSourcePath,
			sourceHash: hashSource(sourceBytes),
		};
	}
	throw new SubagentError("untrusted_resource", `Selected ${kind} was not found: ${name}`);
}

function resolveSelectedResources(
	kind: SubagentResourceKind,
	names: readonly string[] | undefined,
	options: SubagentResourceResolutionOptions,
): SubagentResourceProvenance[] {
	if (!names) return [];
	if (names.length > 16) throw new SubagentError("malformed_result", `Too many selected ${kind} resources.`);
	const resources: SubagentResourceProvenance[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const resource = resolveSelectedResource(kind, name, options);
		if (seen.has(resource.canonicalPath)) continue;
		seen.add(resource.canonicalPath);
		resources.push(resource);
	}
	return resources;
}

export function resolveSubagentResources(
	selection: SubagentResourceSelection,
	options: SubagentResourceResolutionOptions,
): ResolvedSubagentResources {
	const resources = {
		skills: resolveSelectedResources("skill", selection.skills, options),
		prompts: resolveSelectedResources("prompt", selection.prompts, options),
		context: resolveSelectedResources("context", selection.context, options),
	};
	assertSelectedResourceByteBudget(resources);
	return resources;
}

export function readValidatedResource(resource: SubagentResourceProvenance): Buffer {
	let currentPath: string;
	try {
		currentPath = canonicalPath(resource.sourcePath);
	} catch {
		throw new SubagentError(
			"untrusted_resource",
			`Selected ${resource.kind} changed or disappeared: ${resource.name}`,
		);
	}
	const bytes = readBoundedResourceFile(currentPath, resource.kind, resource.name);
	if (currentPath !== resource.canonicalPath || hashSource(bytes) !== resource.sourceHash) {
		throw new SubagentError("untrusted_resource", `Selected ${resource.kind} hash changed: ${resource.name}`);
	}
	return bytes;
}

export function revalidateSubagentResources(resources: ResolvedSubagentResources): void {
	assertSelectedResourceByteBudget(resources);
	for (const resource of [...resources.skills, ...resources.prompts, ...resources.context]) {
		readValidatedResource(resource);
	}
}
