import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, subagentUsageFromEntry } from "../../../core/usage-totals.ts";
import type { IceSubagentOverview } from "../../../ice-agent-view-bridge.ts";
import { createDefaultAppearance } from "../appearance/appearance-defaults.ts";
import type { FooterAppearance, FooterFieldId } from "../appearance/appearance-types.ts";
import { applyTextPresentation } from "../appearance/text-presentation.ts";
import type { NoticeCounts } from "../notice-center.ts";
import { sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { middleTruncate } from "./session-header.ts";
import { layoutStatusLine, REQUIRED_PRIORITY, type StatusSegment } from "./status-line.ts";
import { clickOrKeyHint, ICE_ACTION_URL_PREFIX, linkIceAction } from "./tool-toggle-link.ts";

/** Internal link on the footer's shell count; InteractiveMode routes a click on it to the Shells panel. */
export const OPEN_SHELLS_URL = `${ICE_ACTION_URL_PREFIX}open-shells`;
/** Internal link on the footer's subagent segment; InteractiveMode routes a click on it to the Agent Hub. */
export const OPEN_AGENTS_URL = `${ICE_ACTION_URL_PREFIX}open-agents`;

const DEFAULT_FOOTER_APPEARANCE = createDefaultAppearance().footer;

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
export type FooterStyle = "compact" | "legacy";

function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Right-align `right` on `left`, truncating `left` first when space is short. */
function placeRight(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth + 2 > width) return truncateToWidth(left, width, theme.fg("dim", "..."));
	const fittedLeft = truncateToWidth(left, width - rightWidth - 2, theme.fg("dim", "..."));
	return fittedLeft + " ".repeat(width - visibleWidth(fittedLeft) - rightWidth) + right;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private appearance: FooterAppearance | null = null;
	private getNoticeCounts: (() => NoticeCounts) | undefined;
	private getNoticesHint: () => string = () => "";
	private getCapabilities: () => readonly string[] = () => [];
	private getBackgroundTaskCount: () => number = () => 0;
	private getSubagentOverview: () => IceSubagentOverview | undefined = () => undefined;
	private style: FooterStyle = "legacy";

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setDataProvider(footerData: ReadonlyFooterDataProvider): void {
		this.footerData = footerData;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}
	/** Show a right-aligned notices badge on the first footer row. */
	setNoticeSource(getCounts: () => NoticeCounts, getHint: () => string): void {
		this.getNoticeCounts = getCounts;
		this.getNoticesHint = getHint;
	}

	/** `compact`: one Codex-style status row. `legacy`: the multi-row usage footer. */
	setStyle(style: FooterStyle): void {
		this.style = style;
	}

	/** Elevated capabilities (e.g. "bash", "external") shown next to the execution mode. */
	setCapabilitySource(getCapabilities: () => readonly string[]): void {
		this.getCapabilities = getCapabilities;
	}

	/** Running background bash commands shown as a right-side segment. */
	setBackgroundTaskSource(getCount: () => number): void {
		this.getBackgroundTaskCount = getCount;
	}

	/** Subagent capacity (running/max), queue, and pending approvals shown as a right-side segment. */
	setSubagentSource(getOverview: () => IceSubagentOverview | undefined): void {
		this.getSubagentOverview = getOverview;
	}

	setAppearance(appearance: FooterAppearance | null): void {
		this.appearance = appearance ? structuredClone(appearance) : null;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const customized =
			this.appearance && JSON.stringify(this.appearance) !== JSON.stringify(DEFAULT_FOOTER_APPEARANCE)
				? this.appearance
				: null;
		const customLayout =
			customized &&
			(JSON.stringify(customized.order) !== JSON.stringify(DEFAULT_FOOTER_APPEARANCE.order) ||
				JSON.stringify(customized.visible) !== JSON.stringify(DEFAULT_FOOTER_APPEARANCE.visible) ||
				customized.separator !== DEFAULT_FOOTER_APPEARANCE.separator);
		// Color-only customization must not switch the compact footer to a multi-row layout.
		if (!customLayout && this.style === "compact") return this.renderStatusLine(width, customized);
		const lines = customized ? this.renderCustomized(width, customized) : this.renderLegacy(width);
		const subagents = this.renderSubagentSegment(customized)?.text;
		const notices = this.renderNoticesBadge();
		const badge =
			subagents && notices
				? `${subagents}${theme.fg("dim", ` ${sym("separator")} `)}${notices}`
				: (subagents ?? notices);
		if (!badge || lines.length === 0) return lines;
		return [placeRight(lines[0]!, badge, width), ...lines.slice(1)];
	}

	private renderStatusLine(width: number, appearance: FooterAppearance | null): string[] {
		const state = this.session.state;
		const dim = (text: string) =>
			appearance ? applyTextPresentation(appearance.secondary, text) : theme.fg("dim", text);
		const primary = (text: string) =>
			appearance ? applyTextPresentation(appearance.primary, text) : theme.fg("accent", text);
		const statuses = this.footerData.getExtensionStatuses();
		const left: StatusSegment[] = [];
		const right: StatusSegment[] = [];

		const mode = statuses.get("ice-mode");
		const capabilities = this.getCapabilities();
		if (mode || capabilities.length > 0) {
			// Space-joined and abbreviated: the risk color, not the separator, marks the capabilities.
			const parts = [
				...(mode ? [primary(sanitizeStatusText(mode))] : []),
				...capabilities.map((capability) => theme.fg("error", capability === "external" ? "ext" : capability)),
			];
			left.push({ text: parts.join(" "), priority: REQUIRED_PRIORITY });
		}

		const cwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		left.push({ text: dim(cwd), priority: 60, shrink: (max) => dim(middleTruncate(cwd, max)), minWidth: 16 });
		const branch = this.footerData.getGitBranch();
		if (branch) {
			// Counts ride with the branch: shrinking truncates the branch name, never the counts.
			const git = this.footerData.getGitStatus?.();
			const counts = [
				git?.ahead ? theme.fg("success", `${sym("ahead")}${git.ahead}`) : "",
				git?.behind ? theme.fg("warning", `${sym("behind")}${git.behind}`) : "",
				git?.dirty ? theme.fg("warning", `${sym("dirty")}${git.dirty}`) : "",
			].filter(Boolean);
			const suffix = counts.length > 0 ? ` ${counts.join(" ")}` : "";
			const label = `${sym("branch")} ${branch}`;
			left.push({
				text: dim(label) + suffix,
				// Above the cwd (60): a long path middle-truncates before the branch name is cut.
				priority: 65,
				shrink: (max) =>
					dim(truncateToWidth(label, Math.max(1, max - visibleWidth(suffix)), sym("ellipsis"))) + suffix,
				minWidth: 12 + visibleWidth(suffix),
			});
		}
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) left.push({ text: dim(sanitizeStatusText(sessionName)), priority: 30 });
		const otherStatuses = [...statuses.entries()]
			.filter(([key]) => key !== "ice-mode")
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.filter(Boolean);
		if (otherStatuses.length > 0) left.push({ text: dim(otherStatuses.join(" ")), priority: 20 });

		const modelId = state.model?.id ?? "no model";
		const thinking = state.model?.reasoning ? (state.thinkingLevel ?? "off") : undefined;
		right.push({ text: dim(thinking ? `${modelId} ${thinking}` : modelId), priority: 70 });

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		if (contextWindow > 0) {
			const percent = contextUsage?.percent;
			const label = `${typeof percent === "number" ? `${Math.round(percent)}%` : "?"}/${formatTokens(contextWindow)}`;
			const color =
				typeof percent === "number" && percent > 90
					? "error"
					: typeof percent === "number" && percent > 70
						? "warning"
						: "dim";
			right.push({ text: color === "dim" ? dim(label) : theme.fg(color, label), priority: 90 });
		}

		const backgroundTasks = this.getBackgroundTaskCount();
		if (backgroundTasks > 0) {
			// Down on an empty editor, or a click in fullscreen, opens the Shells panel for these.
			const openKey = keyText("app.shells.open");
			right.push({
				text: linkIceAction(
					primary(`${backgroundTasks} shell${backgroundTasks === 1 ? "" : "s"}`) +
						(openKey ? dim(` (${clickOrKeyHint(openKey)})`) : ""),
					OPEN_SHELLS_URL,
				),
				priority: 95,
			});
		}
		const subagents = this.renderSubagentSegment(appearance);
		if (subagents) right.push(subagents);
		const badge = this.renderNoticesBadge(appearance);
		if (badge) right.push({ text: badge, priority: REQUIRED_PRIORITY });
		return layoutStatusLine(left, right, width);
	}

	/** `agents running/max`, queued turns, and pending approvals; undefined without a subagent runtime. */
	private renderSubagentSegment(appearance?: FooterAppearance | null): StatusSegment | undefined {
		const subagents = this.getSubagentOverview();
		if (!subagents) return undefined;
		const dim = (text: string) =>
			appearance ? applyTextPresentation(appearance.secondary, text) : theme.fg("dim", text);
		const primary = (text: string) =>
			appearance ? applyTextPresentation(appearance.primary, text) : theme.fg("accent", text);
		const { running, queued, max } = subagents.capacity;
		const approvals = subagents.approvals.length;
		const idle = subagents.children.filter((child) => child.state === "idle").length;
		const parts = [
			subagents.enabled ? `agents ${running}/${max}` : "agents off",
			...(queued > 0 ? [`${queued} queued`] : []),
			...(idle > 0 ? [`${idle} idle`] : []),
		];
		const text = parts.join(` ${sym("separator")} `);
		const label = running > 0 || queued > 0 ? primary(text) : dim(text);
		const approvalLabel =
			approvals > 0 ? theme.fg("warning", `${approvals} approval${approvals === 1 ? "" : "s"}`) : "";
		return {
			text: linkIceAction(
				approvalLabel ? `${label}${dim(` ${sym("separator")} `)}${approvalLabel}` : label,
				OPEN_AGENTS_URL,
			),
			// Capacity outranks the working directory; activity and approvals outrank the model.
			priority: approvals > 0 ? REQUIRED_PRIORITY : running > 0 || queued > 0 ? 96 : 65,
		};
	}

	private renderNoticesBadge(appearance?: FooterAppearance | null): string | undefined {
		const counts = this.getNoticeCounts?.();
		if (!counts) return undefined;
		const parts: string[] = [];
		const problems = counts.warning + counts.error;
		if (problems > 0) {
			parts.push(theme.fg(counts.error > 0 ? "error" : "warning", `${sym("warning")} ${problems}`));
		}
		if (counts.update > 0) {
			const label = sym("update");
			parts.push(appearance ? applyTextPresentation(appearance.primary, label) : theme.fg("accent", label));
		}
		if (parts.length === 0) return undefined;
		const secondary = (text: string) =>
			appearance ? applyTextPresentation(appearance.secondary, text) : theme.fg("dim", text);
		const hint = this.getNoticesHint();
		if (hint) parts.push(secondary(hint));
		return parts.join(" ");
	}

	private renderLegacy(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let subagentCost = 0;
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			const subagentUsage = subagentUsageFromEntry(entry);
			if (subagentUsage) {
				addUsageToTotals(usageTotals, subagentUsage);
				subagentCost += subagentUsage.cost.total;
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts: string[] = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingOAuth(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";
		const childCostHint = ` (+$${subagentCost.toFixed(3)} subagents)`;
		if (
			subagentCost > 0 &&
			visibleWidth(statsLeft) + visibleWidth(childCostHint) + visibleWidth(modelName) + 2 <= width
		) {
			const costIndex = statsParts.findIndex((part) => part.startsWith("$"));
			// Keep the hint beside the amount it explains, before any "(sub)" marker.
			statsParts[costIndex] = statsParts[costIndex]!.replace(/^\$[\d.]+/, (total) => total + childCostHint);
			statsLeft = statsParts.join(" ");
		}

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
	private renderCustomized(width: number, appearance: FooterAppearance): string[] {
		const state = this.session.state;
		const usageTotals = createUsageTotals();
		let subagentCost = 0;
		let latestCacheHitRate: number | undefined;
		for (const entry of this.session.sessionManager.getEntries()) {
			const subagentUsage = subagentUsageFromEntry(entry);
			if (subagentUsage) {
				addUsageToTotals(usageTotals, subagentUsage);
				subagentCost += subagentUsage.cost.total;
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
				const prompt = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate = prompt > 0 ? (entry.message.usage.cacheRead / prompt) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = typeof contextUsage?.percent === "number" ? contextUsage.percent.toFixed(1) : "?";
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingOAuth(state.model.provider)
			: false;
		const extensionStatuses = Array.from(this.footerData.getExtensionStatuses().entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const fields: Partial<Record<FooterFieldId, string>> = {
			cwd: formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
			branch: this.footerData.getGitBranch() || undefined,
			session: this.session.sessionManager.getSessionName() || undefined,
			usage:
				[
					usageTotals.input ? `↑${formatTokens(usageTotals.input)}` : "",
					usageTotals.output ? `↓${formatTokens(usageTotals.output)}` : "",
				]
					.filter(Boolean)
					.join(" ") || undefined,
			cache:
				[
					usageTotals.cacheRead ? `R${formatTokens(usageTotals.cacheRead)}` : "",
					usageTotals.cacheWrite ? `W${formatTokens(usageTotals.cacheWrite)}` : "",
					latestCacheHitRate !== undefined && (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0)
						? `CH${latestCacheHitRate.toFixed(1)}%`
						: "",
				]
					.filter(Boolean)
					.join(" ") || undefined,
			cost:
				usageTotals.cost || usingSubscription
					? `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`
					: undefined,
			context: `${contextPercent === "?" ? "?" : `${contextPercent}%`}/${formatTokens(contextWindow)}${this.autoCompactEnabled ? " (auto)" : ""}`,
			provider: this.footerData.getAvailableProviderCount() > 1 ? state.model?.provider : undefined,
			model: state.model?.id || "no-model",
			thinking: state.model?.reasoning ? `thinking ${state.thinkingLevel || "off"}` : undefined,
			extensions: extensionStatuses.length ? extensionStatuses.join(" ") : undefined,
		};
		if (areExperimentalFeaturesEnabled()) fields.usage = [fields.usage, "xp"].filter(Boolean).join(" ");

		const renderField = (id: FooterFieldId, text: string, secondary: boolean): string => {
			if (id === "context" && contextPercentValue > 90) return theme.fg("error", text);
			if (id === "context" && contextPercentValue > 70) return theme.fg("warning", text);
			return applyTextPresentation(secondary ? appearance.secondary : appearance.primary, text);
		};
		const renderGroup = (allowed: ReadonlySet<FooterFieldId>, secondary: boolean): string | undefined => {
			const parts = appearance.order
				.filter((id) => allowed.has(id) && appearance.visible[id] && fields[id])
				.map((id) => ({ id, text: renderField(id, fields[id]!, secondary) }));
			const costPart = parts.find((part) => part.id === "cost");
			const childCostHint = ` (+$${subagentCost.toFixed(3)} subagents)`;
			if (
				costPart &&
				subagentCost > 0 &&
				visibleWidth(parts.map((part) => part.text).join(appearance.separator)) + visibleWidth(childCostHint) <=
					width
			) {
				costPart.text = renderField(
					"cost",
					fields.cost!.replace(/^\$[\d.]+/, (total) => total + childCostHint),
					secondary,
				);
			}
			while (parts.length > 1 && visibleWidth(parts.map((part) => part.text).join(appearance.separator)) > width)
				parts.pop();
			if (!parts.length) return undefined;
			return truncateToWidth(parts.map((part) => part.text).join(appearance.separator), width, "…");
		};
		const primaryIds = new Set<FooterFieldId>(["cwd", "branch", "session"]);
		const secondaryIds = new Set<FooterFieldId>([
			"usage",
			"cache",
			"cost",
			"context",
			"provider",
			"model",
			"thinking",
		]);
		const lines = [renderGroup(primaryIds, false), renderGroup(secondaryIds, true)].filter((line): line is string =>
			Boolean(line),
		);
		if (appearance.visible.extensions && fields.extensions) {
			lines.push(truncateToWidth(applyTextPresentation(appearance.extensions, fields.extensions), width, "…"));
		}
		return lines;
	}
}
