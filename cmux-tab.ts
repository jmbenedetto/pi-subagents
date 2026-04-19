import { spawnSync } from "node:child_process";

export interface CmuxSurfaceHandle {
	workspaceRef: string;
	surfaceRef: string;
}

interface CmuxCallerInfo {
	pane_ref?: string;
	surface_ref?: string;
	tab_ref?: string;
	workspace_ref?: string;
}

interface CmuxIdentifyResponse {
	caller?: CmuxCallerInfo;
}

interface CmuxSurfaceInfo {
	ref?: string;
}

interface CmuxPaneSurfacesResponse {
	surfaces?: CmuxSurfaceInfo[];
}

const CMUX_TIMEOUT_MS = 5000;
const TAB_READY_ATTEMPTS = 20;
const TAB_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 250;

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runCmux(args: string[], env?: NodeJS.ProcessEnv): {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
} {
	try {
		const result = spawnSync("cmux", args, {
			encoding: "utf-8",
			timeout: CMUX_TIMEOUT_MS,
			env,
		});
		if (result.error) {
			return {
				ok: false,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				error: result.error.message,
			};
		}
		if (result.signal === "SIGTERM") {
			return {
				ok: false,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				error: "cmux command timed out",
			};
		}
		if (result.status !== 0) {
			return {
				ok: false,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				error: (result.stderr || result.stdout || `cmux exited with code ${result.status}`).trim(),
			};
		}
		return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (error) {
		return {
			ok: false,
			stdout: "",
			stderr: "",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function isCmuxTabModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_SUBAGENTS_SPAWN_ENGINE?.trim().toLowerCase() === "cmux-tab";
}

export function getCmuxTabAction(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SUBAGENTS_CMUX_TAB_ACTION?.trim() || "new-terminal-right";
}

function getCaller(env?: NodeJS.ProcessEnv): CmuxCallerInfo | null {
	const result = runCmux(["--json", "identify"], env);
	if (!result.ok) return null;
	const parsed = parseJson<CmuxIdentifyResponse>(result.stdout);
	if (!parsed?.caller?.workspace_ref || !parsed.caller.pane_ref || !parsed.caller.tab_ref) return null;
	return parsed.caller;
}

function listPaneSurfaceRefs(workspaceRef: string, paneRef: string, env?: NodeJS.ProcessEnv): string[] | null {
	const result = runCmux(["--json", "list-pane-surfaces", "--workspace", workspaceRef, "--pane", paneRef], env);
	if (!result.ok) return null;
	const parsed = parseJson<CmuxPaneSurfacesResponse>(result.stdout);
	return (parsed?.surfaces ?? []).map((surface) => surface.ref).filter((ref): ref is string => Boolean(ref));
}

export function buildCmuxSpawnCommand(input: {
	cwd: string;
	command: string;
	args: string[];
	env?: Record<string, string | undefined>;
	stdoutPath: string;
	stderrPath: string;
	exitCodePath: string;
}): string {
	const envPrefix = Object.entries(input.env ?? {})
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${shellEscape(value as string)}`)
		.join(" ");
	const commandParts = [shellEscape(input.command), ...input.args.map((arg) => shellEscape(arg))];
	const commandLine = `${envPrefix ? `${envPrefix} ` : ""}${commandParts.join(" ")}`;
	const shellLine = `${commandLine} > ${shellEscape(input.stdoutPath)} 2> ${shellEscape(input.stderrPath)}; code=$?; printf '%s' "$code" > ${shellEscape(input.exitCodePath)}`;
	return `cd ${shellEscape(input.cwd)} && exec sh -lc ${shellEscape(shellLine)}`;
}

export function openCmuxTabForCommand(input: {
	command: string;
	title?: string;
	env?: NodeJS.ProcessEnv;
	action?: string;
}): CmuxSurfaceHandle | null {
	const env = input.env ?? process.env;
	const caller = getCaller(env);
	if (!caller?.workspace_ref || !caller.pane_ref || !caller.tab_ref) return null;
	const beforeRefs = new Set(listPaneSurfaceRefs(caller.workspace_ref, caller.pane_ref, env) ?? []);
	const action = input.action ?? getCmuxTabAction(env);
	const actionResult = runCmux([
		"tab-action",
		"--workspace",
		caller.workspace_ref,
		"--tab",
		caller.tab_ref,
		"--action",
		action,
	], env);
	if (!actionResult.ok) return null;

	let surfaceRef: string | undefined;
	for (let attempt = 0; attempt < TAB_READY_ATTEMPTS; attempt++) {
		const refs = listPaneSurfaceRefs(caller.workspace_ref, caller.pane_ref, env);
		if (refs) {
			surfaceRef = refs.find((ref) => !beforeRefs.has(ref));
			if (surfaceRef) break;
		}
		sleepSync(TAB_READY_DELAY_MS);
	}
	if (!surfaceRef) return null;
	if (SURFACE_BOOT_DELAY_MS > 0) sleepSync(SURFACE_BOOT_DELAY_MS);

	const respawnResult = runCmux([
		"respawn-pane",
		"--workspace",
		caller.workspace_ref,
		"--surface",
		surfaceRef,
		"--command",
		input.command,
	], env);
	if (!respawnResult.ok) return null;

	if (input.title?.trim()) {
		runCmux([
			"rename-tab",
			"--workspace",
			caller.workspace_ref,
			"--surface",
			surfaceRef,
			input.title.trim(),
		], env);
	}

	return {
		workspaceRef: caller.workspace_ref,
		surfaceRef,
	};
}

export function closeCmuxSurface(surface: CmuxSurfaceHandle, env?: NodeJS.ProcessEnv): void {
	runCmux([
		"close-surface",
		"--workspace",
		surface.workspaceRef,
		"--surface",
		surface.surfaceRef,
	], env);
}
