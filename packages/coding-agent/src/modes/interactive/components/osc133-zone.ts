const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Mark rendered rows as one OSC 133 prompt zone. Markers go at line starts, never line ends (#3090).
 * A one-row zone keeps them in order A, B, C: prefixing B and C before A would open the zone after
 * closing it, and prompt navigation looks for a row that starts with A.
 */
export function markOsc133Zone(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	if (lines.length === 1) {
		lines[0] = OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[0];
		return lines;
	}
	lines[0] = OSC133_ZONE_START + lines[0];
	lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
	return lines;
}
