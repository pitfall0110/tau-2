/**
 * agent-beat: best-of-N solver orchestrator.
 *
 * When invoked in solver-like mode (--mode json --no-session -p "<task>"),
 * fork N child copies of this same CLI against independent git clones of
 * the original cwd, pick the one with the largest non-empty patch, and
 * apply it back to the original cwd before exiting. The winner's stdout
 * (the JSON event stream) is relayed so the validator's parser sees a
 * normal single-agent run.
 *
 * Children are invoked with env TAU_BON=0 to prevent recursion.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BestOfNOptions {
	n: number;
	/** argv passed to each child node process (after the cli.js path). */
	childArgv: string[];
	/** Absolute path to the cli.js entrypoint to re-exec. */
	selfPath: string;
	/** Original cwd; winner's patch lands here. */
	origCwd: string;
	/** Overall wall-clock budget across all children, ms. */
	budgetMs: number;
	/** Optional logger; writes to stderr by default. */
	log?: (msg: string) => void;
}

export interface BestOfNResult {
	winnerIndex: number;
	winnerStdout: string;
	patchLines: number;
	perWorkerLines: number[];
}

function isGitRepo(cwd: string): boolean {
	try {
		execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function cloneWorkspace(origCwd: string, targetDir: string): void {
	if (isGitRepo(origCwd)) {
		try {
			execFileSync("git", ["clone", "--local", "--no-hardlinks", origCwd, targetDir], {
				stdio: "ignore",
			});
			// Mirror any uncommitted worktree state so workers start from the same point.
			execFileSync("bash", [
				"-lc",
				`cp -a ${JSON.stringify(origCwd)}/. ${JSON.stringify(targetDir)}/ 2>/dev/null || true`,
			], { stdio: "ignore" });
			return;
		} catch {
			// fall through to cp
		}
	}
	execFileSync("cp", ["-a", `${origCwd}/.`, targetDir], { stdio: "ignore" });
}

function collectPatch(cwd: string): string {
	try {
		// Mirror the validator's collector: tracked diff + untracked as /dev/null diffs.
		const script = [
			`cd ${JSON.stringify(cwd)}`,
			"{ git diff --binary HEAD 2>/dev/null || git diff --binary; }",
			"while IFS= read -r -d '' path; do",
			'  git diff --binary --no-index -- /dev/null "$path" || test $? -eq 1',
			"done < <(git ls-files --others --exclude-standard -z)",
		].join("\n");
		return execFileSync("bash", ["-lc", script], {
			encoding: "utf-8",
			maxBuffer: 128 * 1024 * 1024,
		});
	} catch {
		return "";
	}
}

const SYNTAX_CHECK_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".json", ".css", ".scss", ".html", ".vue", ".svelte",
	".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".cs",
]);

function fileExt(path: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	if (dot <= slash) return "";
	return path.slice(dot).toLowerCase();
}

function changedFileSet(workspaceDir: string): Set<string> {
	try {
		const out = execFileSync(
			"bash",
			["-lc", `cd ${JSON.stringify(workspaceDir)} && { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard; } | sort -u`],
			{ encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
		);
		return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
	} catch {
		return new Set();
	}
}

/**
 * Check the modified files in a worker for obvious syntactic breakage:
 * - unbalanced braces/parens/brackets in code files
 * - file ending with an opening token like `{`, `(`, `,` (truncation marker)
 * Returns true if the worker's patch leaves files in a likely-broken state.
 */
function patchLeavesBrokenFiles(workspaceDir: string): boolean {
	let changed = "";
	try {
		changed = execFileSync(
			"bash",
			["-lc", `cd ${JSON.stringify(workspaceDir)} && { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard; } | sort -u`],
			{ encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
		);
	} catch {
		return false;
	}
	const files = changed.split("\n").map((s) => s.trim()).filter(Boolean);
	for (const rel of files) {
		const ext = fileExt(rel);
		if (!SYNTAX_CHECK_EXTS.has(ext)) continue;
		let content: string;
		try {
			content = readFileSync(`${workspaceDir}/${rel}`, "utf-8");
		} catch {
			continue;
		}
		if (content.length === 0) continue;
		// Strip trailing whitespace/newlines for end-token check.
		const trimmed = content.replace(/\s+$/, "");
		const lastChar = trimmed.slice(-1);
		// File ends with an opening token => almost certainly truncated.
		if (lastChar === "{" || lastChar === "(" || lastChar === "[" || lastChar === ",") {
			return true;
		}
		// Brace balance check (ignores strings/comments — coarse but catches the truncation case).
		let curly = 0, paren = 0, square = 0;
		for (let i = 0; i < content.length; i++) {
			const c = content.charCodeAt(i);
			if (c === 123) curly++; // {
			else if (c === 125) curly--; // }
			else if (c === 40) paren++; // (
			else if (c === 41) paren--; // )
			else if (c === 91) square++; // [
			else if (c === 93) square--; // ]
		}
		// Allow small imbalance (template strings, etc.) but big skew = truncation.
		if (Math.abs(curly) >= 2 || Math.abs(paren) >= 4 || Math.abs(square) >= 2) {
			return true;
		}
	}
	return false;
}

function countPatchLines(patchText: string): number {
	let n = 0;
	for (const line of patchText.split("\n")) {
		if (line.length === 0) continue;
		const c = line.charCodeAt(0);
		// '+' = 43, '-' = 45
		if (c === 43 && !line.startsWith("+++")) n++;
		else if (c === 45 && !line.startsWith("---")) n++;
	}
	return n;
}

function applyPatch(targetCwd: string, patch: string): boolean {
	if (!patch.trim()) return false;
	try {
		execFileSync("git", ["-C", targetCwd, "apply", "--binary", "--whitespace=nowarn", "-"], {
			input: patch,
			stdio: ["pipe", "ignore", "ignore"],
			maxBuffer: 128 * 1024 * 1024,
		});
		return true;
	} catch {
		return false;
	}
}

export async function runBestOfN(opts: BestOfNOptions): Promise<BestOfNResult> {
	const log = opts.log ?? ((m: string) => process.stderr.write(`[bon] ${m}\n`));
	const { n, childArgv, selfPath, origCwd, budgetMs } = opts;

	const workspaces: string[] = [];
	const outs: string[] = [];
	for (let i = 0; i < n; i++) {
		const dir = mkdtempSync(join(tmpdir(), `bon-${i}-`));
		try {
			cloneWorkspace(origCwd, dir);
		} catch (e) {
			log(`clone ${i} failed: ${String(e)}`);
		}
		workspaces.push(dir);
		outs.push("");
	}
	log(`spawned ${n} workers with budget ${budgetMs}ms`);

	const procs = workspaces.map((dir, i) => {
		const proc = spawn(process.execPath, [selfPath, ...childArgv], {
			cwd: dir,
			env: {
				...process.env,
				TAU_BON: "0",
				TAU_BON_INDEX: String(i),
				TAU_BON_N: String(n),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout!.on("data", (buf) => {
			outs[i] += buf.toString();
		});
		proc.stderr!.on("data", () => {
			// swallow child stderr; keep parent stdout clean for the winner
		});
		proc.on("error", (err) => log(`worker ${i} spawn error: ${err.message}`));
		return proc;
	});

	let hardTimeout: NodeJS.Timeout | undefined;
	const killAll = () => {
		for (const p of procs) {
			try { p.kill("SIGKILL"); } catch {}
		}
	};
	hardTimeout = setTimeout(() => {
		log(`budget exceeded after ${budgetMs}ms, killing stragglers`);
		killAll();
	}, budgetMs);

	await Promise.all(
		procs.map((p) => new Promise<void>((res) => p.on("close", () => res()))),
	);
	if (hardTimeout) clearTimeout(hardTimeout);

	const perWorkerLines: number[] = [];
	const patches: string[] = [];
	const broken: boolean[] = [];
	const fileSets: Set<string>[] = [];
	for (let i = 0; i < n; i++) {
		const patch = collectPatch(workspaces[i]);
		const lines = countPatchLines(patch);
		perWorkerLines.push(lines);
		patches.push(patch);
		const isBroken = lines > 0 && patchLeavesBrokenFiles(workspaces[i]);
		broken.push(isBroken);
		fileSets.push(changedFileSet(workspaces[i]));
	}
	log(`per-worker lines: ${perWorkerLines.join(", ")}; files: ${fileSets.map((s) => s.size).join(", ")}; broken: ${broken.map((b, i) => b ? `#${i}` : "").filter(Boolean).join(",") || "(none)"}`);

	// Build candidate set: workers with non-empty, non-broken patches first.
	const candidates: number[] = [];
	for (let i = 0; i < n; i++) {
		if (perWorkerLines[i] > 0 && !broken[i]) candidates.push(i);
	}
	// Fallback: if all are broken, accept broken ones (better than nothing).
	if (candidates.length === 0) {
		for (let i = 0; i < n; i++) {
			if (perWorkerLines[i] > 0) candidates.push(i);
		}
	}

	let winnerIndex = -1;
	let bestLines = 0;
	let winnerPatch = "";
	if (candidates.length > 0) {
		// Variance-aware selector. Two regimes:
		// - LOW variance (workers agree on patch size, e.g., [109, 111, 116]):
		//   pick the median — most likely the canonical answer; max would over-
		//   reach into surplus deletions.
		// - HIGH variance (most workers stalled, one finished, e.g., [4, 36, 108]):
		//   pick max — the others didn't finish; the big one is the real attempt.
		// Threshold: if max > 2 * median, treat as high variance.
		const lineCounts = candidates.map((i) => perWorkerLines[i]).sort((a, b) => a - b);
		const medianLines = lineCounts[Math.floor((lineCounts.length - 1) / 2)] || 1;
		const maxLines = lineCounts[lineCounts.length - 1];
		const highVariance = maxLines > 2 * medianLines;
		const target = highVariance ? maxLines : medianLines;
		const sorted = candidates.slice().sort((a, b) => {
			const da = Math.abs(perWorkerLines[a] - target);
			const db = Math.abs(perWorkerLines[b] - target);
			if (da !== db) return da - db;
			return fileSets[b].size - fileSets[a].size;
		});
		winnerIndex = sorted[0];
		bestLines = perWorkerLines[winnerIndex];
		winnerPatch = patches[winnerIndex];
	}
	log(`candidates=[${candidates.join(",")}] winner=${winnerIndex} (${bestLines} lines, ${fileSets[winnerIndex]?.size ?? 0} files)`);

	if (winnerIndex >= 0) {
		const applied = applyPatch(origCwd, winnerPatch);
		if (!applied) {
			log(`git apply failed; trying cp fallback from worker ${winnerIndex}`);
			try {
				execFileSync("bash", [
					"-lc",
					`cp -a ${JSON.stringify(workspaces[winnerIndex])}/. ${JSON.stringify(origCwd)}/`,
				], { stdio: "ignore" });
			} catch (e) {
				log(`cp fallback failed: ${String(e)}`);
			}
		}
	}

	// Optional artifact dump for retrospective analysis (per-worker patches + stats).
	const artifactDir = process.env.TAU_BON_ARTIFACT_DIR;
	if (artifactDir) {
		try {
			const { mkdirSync, writeFileSync } = require("node:fs");
			mkdirSync(artifactDir, { recursive: true });
			for (let i = 0; i < n; i++) {
				writeFileSync(`${artifactDir}/worker_${i}.diff`, patches[i] ?? "");
			}
			writeFileSync(`${artifactDir}/stats.json`, JSON.stringify({
				perWorkerLines,
				fileSets: fileSets.map(s => [...s]),
				broken,
				candidates,
				winnerIndex,
				highVariance: candidates.length > 0 ? (Math.max(...candidates.map(i=>perWorkerLines[i])) > 2 * (candidates.map(i=>perWorkerLines[i]).sort((a,b)=>a-b)[Math.floor((candidates.length-1)/2)] || 1)) : false,
			}, null, 2));
		} catch (e) {
			log(`artifact dump failed: ${String(e)}`);
		}
	}

	for (const dir of workspaces) {
		try { rmSync(dir, { recursive: true, force: true }); } catch {}
	}

	return {
		winnerIndex,
		winnerStdout: winnerIndex >= 0 ? outs[winnerIndex] : "",
		patchLines: bestLines,
		perWorkerLines,
	};
}
