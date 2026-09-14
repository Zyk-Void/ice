/**
 * Ice-vcc section types.
 *
 * Upstream: https://github.com/sting8k/ice-vcc (src/sections.ts)
 * Unmodified.
 */

export interface SectionData {
	recentActions: string[];
	sessionGoal: string[];
	outstandingContext: string[];
	filesAndChanges: string[];
	commits: string[];
	userPreferences: string[];
	briefTranscript: string;
}
