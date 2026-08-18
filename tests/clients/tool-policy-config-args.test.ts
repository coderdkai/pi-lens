import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePackagePath } from "../../clients/package-root.js";
import {
	biomeConfigArgs,
	findBiomeProjectRoot,
	markdownlintConfigArgs,
	resolveBiomeConfigPath,
	ruffConfigArgs,
} from "../../clients/tool-policy.js";

/**
 * Shared config-args seam regression tests (#1247).
 *
 * The lint runners and the autofix surfaces MUST both consume the builders
 * under test — this suite pins the exact args they produce for the two
 * project states (no config → package-owned fallback; config present → user
 * config wins / empty). If a builder drifts, both surfaces drift together and
 * the divergence that caused the whole-file CHANGELOG/AGENTS.md markdownlint
 * reformat (`#946` → `# 946`) is reintroduced.
 */
describe("shared lint/autofix config-args builders (#1247)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-config-args-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("markdownlintConfigArgs", () => {
		it("falls back to the package-owned core.json when the project has no config", () => {
			const args = markdownlintConfigArgs(tmpDir);
			expect(args).toEqual([
				"--config",
				resolvePackagePath(import.meta.url, "config/markdownlint/core.json"),
			]);
		});

		it("passes no --config when the project ships its own markdownlint config", () => {
			fs.writeFileSync(path.join(tmpDir, ".markdownlint.json"), "{}");
			expect(markdownlintConfigArgs(tmpDir)).toEqual([]);
		});

		it("respects a config nested below the start dir (walk-up discovery)", () => {
			const nested = path.join(tmpDir, "a", "b");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, "a", ".markdownlint.yaml"),
				"MD013: false\n",
			);
			expect(markdownlintConfigArgs(nested)).toEqual([]);
		});
	});

	describe("ruffConfigArgs", () => {
		it("falls back to the package-owned core.toml when the project has no config", () => {
			const args = ruffConfigArgs(tmpDir);
			expect(args).toEqual([
				"--config",
				resolvePackagePath(import.meta.url, "config/ruff/core.toml"),
			]);
		});

		it("passes no --config when the project ships a ruff section in pyproject.toml", () => {
			fs.writeFileSync(
				path.join(tmpDir, "pyproject.toml"),
				"[tool.ruff]\nline-length = 100\n",
			);
			expect(ruffConfigArgs(tmpDir)).toEqual([]);
		});
	});

	describe("biomeConfigArgs", () => {
		it("falls back to the package-owned core.jsonc when the project has no config", () => {
			const args = biomeConfigArgs(tmpDir);
			expect(args).toEqual([
				`--config-path=${resolvePackagePath(
					import.meta.url,
					"config/biome/core.jsonc",
				)}`,
			]);
		});

		it("prefers the user's biome.json over the package fallback", () => {
			const userConfig = path.join(tmpDir, "biome.json");
			fs.writeFileSync(userConfig, "{}");
			expect(biomeConfigArgs(tmpDir)).toEqual([
				`--config-path=${userConfig}`,
			]);
		});
	});

	describe("resolveBiomeConfigPath precedence chain", () => {
		// Helper: make a git-backed repo root under tmpDir with a nested source dir.
		const makeRepo = (name: string) => {
			const root = path.join(tmpDir, name);
			fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
			fs.mkdirSync(path.join(root, ".git"), { recursive: true });
			return { root, nested: path.join(root, "src", "deep") };
		};

		it("resolves the root biome.json from a nested file within the .git boundary", () => {
			const { root, nested } = makeRepo("r1");
			const cfg = path.join(root, "biome.json");
			fs.writeFileSync(cfg, "{}");
			expect(resolveBiomeConfigPath(nested)).toBe(cfg);
		});

		it("prefers biome.jsonc over biome.json at the same directory", () => {
			const { root, nested } = makeRepo("r2");
			fs.writeFileSync(path.join(root, "biome.json"), "{}");
			const jsonc = path.join(root, "biome.jsonc");
			fs.writeFileSync(jsonc, "{}");
			expect(resolveBiomeConfigPath(nested)).toBe(jsonc);
		});

		it("never escapes the .git boundary to an unrelated parent config", () => {
			// A biome.json at the repo's SIBLING layer (above the .git boundary)
			// must not be picked up — the .git boundary stops the climb before
			// the walk reaches it, and there is no config inside the repo.
			const stray = path.join(tmpDir, "sibling-biome.json");
			fs.writeFileSync(stray, "{}");
			const { nested } = makeRepo("r3");
			expect(resolveBiomeConfigPath(nested)).toBeUndefined();
			fs.rmSync(path.join(tmpDir, "biome.json"), { force: true });
		});

		it("resolves a project-scoped .pi config ahead of the global layer", () => {
			const { root, nested } = makeRepo("r4");
			const piCfg = path.join(
				root,
				".pi",
				".extensions",
				"pi-lens",
				"biome.json",
			);
			fs.mkdirSync(path.dirname(piCfg), { recursive: true });
			fs.writeFileSync(piCfg, "{}");
			// Global layer points at a distinct userDir; project .pi wins.
			expect(resolveBiomeConfigPath(nested, { userDir: tmpDir })).toBe(piCfg);
		});

		it("resolves the global ~/.pi config when no project config exists", () => {
			const { nested } = makeRepo("r5");
			const userDir = path.join(tmpDir, "user-home");
			const globalCfg = path.join(
				userDir,
				".extensions",
				"pi-lens",
				"biome.jsonc",
			);
			fs.mkdirSync(path.dirname(globalCfg), { recursive: true });
			fs.writeFileSync(globalCfg, "{}");
			expect(resolveBiomeConfigPath(nested, { userDir })).toBe(globalCfg);
		});

		it("prefers the project biome.json over project-scoped and global .pi configs", () => {
			const { root, nested } = makeRepo("r6");
			const projectCfg = path.join(root, "biome.json");
			fs.writeFileSync(projectCfg, "{}");
			const piCfg = path.join(
				root,
				".pi",
				".extensions",
				"pi-lens",
				"biome.json",
			);
			fs.mkdirSync(path.dirname(piCfg), { recursive: true });
			fs.writeFileSync(piCfg, "{}");
			const globalCfg = path.join(
				tmpDir,
				"glob",
				".extensions",
				"pi-lens",
				"biome.json",
			);
			fs.mkdirSync(path.dirname(globalCfg), { recursive: true });
			fs.writeFileSync(globalCfg, "{}");
			expect(resolveBiomeConfigPath(nested, { userDir: tmpDir })).toBe(
				projectCfg,
			);
		});

		it("findBiomeProjectRoot anchors on a nested file's git root even when no config is present", () => {
			const { root, nested } = makeRepo("r7");
			expect(findBiomeProjectRoot(nested)).toBe(root);
		});

		it("findBiomeProjectRoot falls back to the nearest package.json for non-git dirs", () => {
			const root = path.join(tmpDir, "nongit");
			const nested = path.join(root, "pkg");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(root, "package.json"), "{}");
			expect(findBiomeProjectRoot(nested)).toBe(root);
		});
	});
});
