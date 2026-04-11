import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Container, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { ToolDefinition } from "../extensions/types.js";
import {
	detectLineEnding,
	type Edit,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { computeLineHash, parseHashRef } from "./line-hash.js";
import { resolveToCwd } from "./path-utils.js";
import { invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

type EditRenderState = Record<string, never>;

// --- Hashline edit schema ---

const hashlineLocationSchema = Type.Union([
	Type.Literal("append"),
	Type.Literal("prepend"),
	Type.Object({
		append: Type.String({ description: "Anchor after which to insert, e.g. '7#NK'" }),
	}),
	Type.Object({
		prepend: Type.String({ description: "Anchor before which to insert, e.g. '5#ZP'" }),
	}),
	Type.Object({
		range: Type.Object({
			pos: Type.String({ description: "Start anchor (inclusive), e.g. '5#ZP'" }),
			end: Type.Optional(Type.String({ description: "End anchor (inclusive). If omitted, only pos line is targeted." })),
		}),
	}),
]);

const hashlineEditSchema = Type.Object({
	loc: hashlineLocationSchema,
	content: Type.Union([
		Type.Array(Type.String()),
		Type.String(),
		Type.Null(),
	], { description: "Replacement content: array of lines, a single string, or null to delete." }),
});

const hashlineEditParamsSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(hashlineEditSchema, {
		description: "One or more hash-anchored edit operations. Each edit references lines by their LINE#HASH anchors from the read tool output.",
	}),
}, { additionalProperties: false });

export type HashlineEditToolInput = Static<typeof hashlineEditParamsSchema>;

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	operations?: EditOperations;
}

// --- Legacy oldText/newText schema (kept as fallback) ---

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const legacyEditSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description: "One or more targeted replacements.",
		}),
	},
	{ additionalProperties: false },
);

type LegacyEditToolInput = Static<typeof legacyEditSchema>;

// --- Argument preparation: detect hashline vs legacy format ---

function isHashlineEdit(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const args = input as Record<string, unknown>;
	if (!Array.isArray(args.edits) || args.edits.length === 0) return false;
	const firstEdit = args.edits[0] as Record<string, unknown>;
	if (firstEdit && typeof firstEdit.loc !== "undefined") return true;
	return false;
}

function prepareEditArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;

	const args = input as Record<string, unknown>;

	// If it has top-level oldText/newText (legacy single-edit format), wrap into edits[]
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		if (!Array.isArray(args.edits)) args.edits = [];
		(args.edits as unknown[]).push({ oldText: args.oldText, newText: args.newText });
		const { oldText: _oldText, newText: _newText, ...rest } = args;
		return rest;
	}

	return input;
}

// --- Hashline edit execution ---

interface ParsedEdit {
	type: "replace_range" | "append_at" | "prepend_at" | "append_file" | "prepend_file";
	posLine: number;
	endLine: number;
	content: string[];
}

function parseHashlineEdit(
	edit: Static<typeof hashlineEditSchema>,
	fileLines: string[],
	editIndex: number,
	path: string,
): ParsedEdit {
	const loc = edit.loc;

	// Normalize content to array of lines
	let contentLines: string[];
	if (edit.content === null || edit.content === undefined) {
		contentLines = [];
	} else if (typeof edit.content === "string") {
		contentLines = edit.content.split("\n");
	} else {
		contentLines = edit.content;
	}

	if (loc === "append") {
		return { type: "append_file", posLine: 0, endLine: 0, content: contentLines };
	}
	if (loc === "prepend") {
		return { type: "prepend_file", posLine: 0, endLine: 0, content: contentLines };
	}
	if (typeof loc === "object" && "append" in loc && typeof loc.append === "string") {
		const ref = parseHashRef(loc.append);
		if (!ref || ref.line < 1 || ref.line > fileLines.length) {
			throw new Error(`edits[${editIndex}]: invalid append anchor "${loc.append}" in ${path}`);
		}
		const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
		if (actualHash !== ref.hash) {
			throw new Error(
				`edits[${editIndex}]: hash mismatch for append anchor "${loc.append}" in ${path}. ` +
				`Line ${ref.line} has hash ${actualHash}. The file may have changed since you read it. Re-read and retry.`,
			);
		}
		return { type: "append_at", posLine: ref.line, endLine: ref.line, content: contentLines };
	}
	if (typeof loc === "object" && "prepend" in loc && typeof loc.prepend === "string") {
		const ref = parseHashRef(loc.prepend);
		if (!ref || ref.line < 1 || ref.line > fileLines.length) {
			throw new Error(`edits[${editIndex}]: invalid prepend anchor "${loc.prepend}" in ${path}`);
		}
		const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
		if (actualHash !== ref.hash) {
			throw new Error(
				`edits[${editIndex}]: hash mismatch for prepend anchor "${loc.prepend}" in ${path}. ` +
				`Line ${ref.line} has hash ${actualHash}. The file may have changed since you read it. Re-read and retry.`,
			);
		}
		return { type: "prepend_at", posLine: ref.line, endLine: ref.line, content: contentLines };
	}
	if (typeof loc === "object" && "range" in loc && loc.range !== null && typeof loc.range === "object") {
		const range = loc.range as { pos: string; end?: string };
		const posRef = parseHashRef(range.pos);
		if (!posRef || posRef.line < 1 || posRef.line > fileLines.length) {
			throw new Error(`edits[${editIndex}]: invalid range.pos anchor "${range.pos}" in ${path}`);
		}
		const posHash = computeLineHash(posRef.line, fileLines[posRef.line - 1]);
		if (posHash !== posRef.hash) {
			throw new Error(
				`edits[${editIndex}]: hash mismatch for range.pos "${range.pos}" in ${path}. ` +
				`Line ${posRef.line} has hash ${posHash}. The file may have changed since you read it. Re-read and retry.`,
			);
		}

		let endLine = posRef.line;
		if (range.end && typeof range.end === "string") {
			const endRef = parseHashRef(range.end);
			if (!endRef || endRef.line < 1 || endRef.line > fileLines.length) {
				throw new Error(`edits[${editIndex}]: invalid range.end anchor "${range.end}" in ${path}`);
			}
			if (endRef.line < posRef.line) {
				throw new Error(`edits[${editIndex}]: range.end (${endRef.line}) must be >= range.pos (${posRef.line}) in ${path}`);
			}
			const endHash = computeLineHash(endRef.line, fileLines[endRef.line - 1]);
			if (endHash !== endRef.hash) {
				throw new Error(
					`edits[${editIndex}]: hash mismatch for range.end "${range.end}" in ${path}. ` +
					`Line ${endRef.line} has hash ${endHash}. The file may have changed since you read it. Re-read and retry.`,
				);
			}
			endLine = endRef.line;
		}

		return { type: "replace_range", posLine: posRef.line, endLine, content: contentLines };
	}

	throw new Error(`edits[${editIndex}]: unrecognised loc format in ${path}`);
}

function applyHashlineEdits(
	fileLines: string[],
	edits: ParsedEdit[],
): string[] {
	// Sort edits bottom-up so splices don't shift subsequent line numbers
	const sorted = [...edits].sort((a, b) => {
		// Get the "action line" for ordering
		const aLine = a.type === "append_at" ? a.posLine : a.type === "prepend_at" ? a.posLine - 0.5 : a.posLine;
		const bLine = b.type === "append_at" ? b.posLine : b.type === "prepend_at" ? b.posLine - 0.5 : b.posLine;
		return bLine - aLine; // reverse order
	});

	const lines = [...fileLines];

	for (const edit of sorted) {
		switch (edit.type) {
			case "replace_range": {
				// Replace lines posLine..endLine (1-indexed, inclusive) with content
				const start = edit.posLine - 1;
				const end = edit.endLine;
				lines.splice(start, end - start + 1, ...edit.content);
				break;
			}
			case "append_at": {
				// Insert after posLine (1-indexed)
				lines.splice(edit.posLine, 0, ...edit.content);
				break;
			}
			case "prepend_at": {
				// Insert before posLine (1-indexed)
				lines.splice(edit.posLine - 1, 0, ...edit.content);
				break;
			}
			case "append_file": {
				lines.push(...edit.content);
				break;
			}
			case "prepend_file": {
				lines.unshift(...edit.content);
				break;
			}
		}
	}

	return lines;
}

// --- Unified edit tool definition ---

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: unknown[];
	oldText?: string;
	newText?: string;
};

function formatEditCall(
	args: RenderableEditArgs | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const invalidArg = invalidArgText(theme);
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: EditToolDetails;
	},
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText) {
			return undefined;
		}
		return `\n${theme.fg("error", errorText)}`;
	}

	const resultDiff = result.details?.diff;
	if (!resultDiff) {
		return undefined;
	}
	return `\n${renderDiff(resultDiff, { filePath: rawPath ?? undefined })}`;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof hashlineEditParamsSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file using hash-anchored line references from the read tool. " +
			"Each edit targets lines by their LINE#HASH anchor. " +
			"Operations: replace a range (range.pos to range.end), append after a line, prepend before a line, or append/prepend to the file. " +
			"Set content to null to delete lines. Multiple edits in one call are applied together.",
		promptSnippet:
			"Edit files using hash-anchored LINE#HASH references from read output",
		promptGuidelines: [
			"Use the LINE#HASH anchors from read output to specify precise edit locations.",
			"To replace lines N-M, use { range: { pos: 'N#XX', end: 'M#YY' } } with your new content.",
			"To insert after line N, use { append: 'N#XX' }. To insert before line N, use { prepend: 'N#XX' }.",
			"Set content to null to delete lines. Set content to [] for an empty replacement.",
			"You can make multiple edits in a single call. Edits are applied in reverse line order to preserve anchors.",
			"If you get a hash mismatch error, the file was modified. Re-read it and retry with fresh anchors.",
			"When replacing lines, match the surrounding code style exactly (indentation, quotes, semicolons, trailing commas).",
		],
		parameters: hashlineEditParamsSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: unknown, signal?: AbortSignal, _onUpdate?, _ctx?) {
			// Detect format: hashline (has edits[].loc) vs legacy (has edits[].oldText)
			if (isHashlineEdit(input)) {
				return executeHashlineEdit(input as HashlineEditToolInput, cwd, ops, signal);
			} else {
				// Legacy fallback: convert to hashline by reading file first
				return executeLegacyEdit(input as LegacyEditToolInput, cwd, ops, signal);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatEditCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const output = formatEditResult(context.args, result as any, theme, context.isError);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

async function executeHashlineEdit(
	input: HashlineEditToolInput,
	cwd: string,
	ops: EditOperations,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: EditToolDetails | undefined }> {
	const { path, edits } = input;
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new Error("Edit tool requires at least one edit in the edits array.");
	}

	const absolutePath = resolveToCwd(path, cwd);

	return withFileMutationQueue(
		absolutePath,
		() =>
			new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: EditToolDetails | undefined;
			}>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};
				if (signal) signal.addEventListener("abort", onAbort, { once: true });

				void (async () => {
					try {
						try {
							await ops.access(absolutePath);
						} catch {
							if (signal) signal.removeEventListener("abort", onAbort);
							reject(new Error(`File not found: ${path}`));
							return;
						}
						if (aborted) return;

						const buffer = await ops.readFile(absolutePath);
						const rawContent = buffer.toString("utf-8");
						if (aborted) return;

						const { bom, text: content } = stripBom(rawContent);
						const originalEnding = detectLineEnding(content);
						const normalizedContent = normalizeToLF(content);
						const fileLines = normalizedContent.split("\n");

						// Parse and validate all edits before applying any
						const parsedEdits = edits.map((edit, i) =>
							parseHashlineEdit(edit, fileLines, i, path),
						);

						if (aborted) return;

						// Apply edits
						const newLines = applyHashlineEdits(fileLines, parsedEdits);
						const newContent = newLines.join("\n");

						if (normalizedContent === newContent) {
							if (signal) signal.removeEventListener("abort", onAbort);
							reject(new Error(`No changes made to ${path}. The edits produced identical content.`));
							return;
						}

						if (aborted) return;

						const finalContent = bom + restoreLineEndings(newContent, originalEnding);
						await ops.writeFile(absolutePath, finalContent);

						if (aborted) return;

						if (signal) signal.removeEventListener("abort", onAbort);

						const diffResult = generateDiffString(normalizedContent, newContent);
						resolve({
							content: [
								{
									type: "text",
									text: `Successfully applied ${edits.length} hashline edit(s) to ${path}.`,
								},
							],
							details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
						});
					} catch (error: unknown) {
						if (signal) signal.removeEventListener("abort", onAbort);
						if (!aborted) reject(error instanceof Error ? error : new Error(String(error)));
					}
				})();
			}),
	);
}

async function executeLegacyEdit(
	input: LegacyEditToolInput,
	cwd: string,
	ops: EditOperations,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: EditToolDetails | undefined }> {
	// Dynamic import to avoid circular dependency
	const { applyEditsToNormalizedContent } = await import("./edit-diff.js");

	const { path, edits } = input;
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new Error("Edit tool requires at least one edit in the edits array.");
	}
	const absolutePath = resolveToCwd(path, cwd);

	return withFileMutationQueue(
		absolutePath,
		() =>
			new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: EditToolDetails | undefined;
			}>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};
				if (signal) signal.addEventListener("abort", onAbort, { once: true });

				void (async () => {
					try {
						try {
							await ops.access(absolutePath);
						} catch {
							if (signal) signal.removeEventListener("abort", onAbort);
							reject(new Error(`File not found: ${path}`));
							return;
						}
						if (aborted) return;

						const buffer = await ops.readFile(absolutePath);
						const rawContent = buffer.toString("utf-8");
						if (aborted) return;

						const { bom, text: content } = stripBom(rawContent);
						const originalEnding = detectLineEnding(content);
						const normalizedContent = normalizeToLF(content);
						const { baseContent, newContent } = applyEditsToNormalizedContent(
							normalizedContent,
							edits,
							path,
						);

						if (aborted) return;

						const finalContent = bom + restoreLineEndings(newContent, originalEnding);
						await ops.writeFile(absolutePath, finalContent);

						if (aborted) return;

						if (signal) signal.removeEventListener("abort", onAbort);

						const diffResult = generateDiffString(baseContent, newContent);
						resolve({
							content: [
								{
									type: "text",
									text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
								},
							],
							details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
						});
					} catch (error: unknown) {
						if (signal) signal.removeEventListener("abort", onAbort);
						if (!aborted) reject(error instanceof Error ? error : new Error(String(error)));
					}
				})();
			}),
	);
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof hashlineEditParamsSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

/** Default edit tool using process.cwd() for backwards compatibility. */
export const editToolDefinition = createEditToolDefinition(process.cwd());
export const editTool = createEditTool(process.cwd());