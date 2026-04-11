/**
 * Hashline utility for line-addressable editing.
 *
 * Each line gets a 2-char hash appended when displayed by the read tool,
 * allowing the edit tool to reference lines by LINE#HASH anchors instead
 * of requiring exact text reproduction.
 *
 * Uses Node.js built-in crypto (MD5) — no external dependencies needed.
 * Hash alphabet avoids digits to prevent confusion with line numbers.
 */

import { createHash } from "node:crypto";

/** 16-char alphabet for 2-char hex output — no digits, avoids line-number confusion */
const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";

/**
 * Compute a 2-character hash for a line of text.
 *
 * For lines with alphanumeric content, uses the line text as-is.
 * For blank/punctuation-only lines, mixes in the line number as seed
 * to avoid collisions on repeated empty lines.
 */
export function computeLineHash(lineNumber: number, lineText: string): string {
	const trimmed = lineText.trimEnd();
	const hasAlphanumeric = /[a-zA-Z0-9]/.test(trimmed);

	const input = hasAlphanumeric ? lineText : `${lineNumber}:${lineText}`;
	const hash = createHash("md5").update(input).digest();
	const val = hash.readUInt32BE(0);

	const c1 = HASH_ALPHABET[val % 16];
	const c2 = HASH_ALPHABET[Math.floor(val / 16) % 16];
	return `${c1}${c2}`;
}

/**
 * Format a single line with hashline prefix: `LINE#HASH:text`
 */
export function formatHashLine(lineNumber: number, lineText: string): string {
	const hash = computeLineHash(lineNumber, lineText);
	return `${lineNumber}#${hash}:${lineText}`;
}

/**
 * Format multiple lines with hashline prefixes.
 * @param text - Full file content (LF-normalized)
 * @param startLine - 1-indexed start line number
 * @returns Formatted string with LINE#HASH: prefix on each line
 */
export function formatHashLines(text: string, startLine: number): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatHashLine(startLine + i, line)).join("\n");
}

/**
 * Parse a hashline anchor reference like "42#ZP" or "  42#ZP" or "+42#ZP"
 * into { line, hash } components.
 *
 * Tolerates leading +/-/> chars and whitespace for flexibility
 * when models copy anchors from diff-like output.
 */
export function parseHashRef(ref: string): { line: number; hash: string } | null {
	const cleaned = ref.replace(/^[>+\-\s]+/, "");
	const match = cleaned.match(/^(\d+)\s*#\s*([A-Za-z]{2})$/);
	if (!match) return null;
	return {
		line: parseInt(match[1], 10),
		hash: match[2].toUpperCase(),
	};
}

/**
 * Validate that a hash reference matches the current file content.
 * Returns true if the hash matches, false otherwise.
 */
export function validateHashRef(
	ref: string,
	fileLines: string[],
): { valid: boolean; line?: number; hash?: string; actualHash?: string } {
	const parsed = parseHashRef(ref);
	if (!parsed) return { valid: false };

	const { line, hash } = parsed;
	if (line < 1 || line > fileLines.length) return { valid: false, line, hash };

	const actualHash = computeLineHash(line, fileLines[line - 1]);
	return {
		valid: actualHash === hash,
		line,
		hash,
		actualHash,
	};
}
