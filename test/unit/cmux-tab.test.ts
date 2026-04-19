import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCmuxSpawnCommand, getCmuxTabAction, isCmuxTabModeEnabled, shellEscape } from "../../cmux-tab.ts";

describe("cmux-tab helpers", () => {
	it("detects cmux-tab mode from env", () => {
		assert.equal(isCmuxTabModeEnabled({ PI_SUBAGENTS_SPAWN_ENGINE: "cmux-tab" } as NodeJS.ProcessEnv), true);
		assert.equal(isCmuxTabModeEnabled({ PI_SUBAGENTS_SPAWN_ENGINE: "subprocess" } as NodeJS.ProcessEnv), false);
		assert.equal(isCmuxTabModeEnabled({} as NodeJS.ProcessEnv), false);
	});

	it("uses the configured tab action or falls back to new-terminal-right", () => {
		assert.equal(getCmuxTabAction({ PI_SUBAGENTS_CMUX_TAB_ACTION: "duplicate" } as NodeJS.ProcessEnv), "duplicate");
		assert.equal(getCmuxTabAction({} as NodeJS.ProcessEnv), "new-terminal-right");
	});

	it("shell-escapes single quotes", () => {
		assert.equal(shellEscape("it's"), "'it'\\''s'");
	});

	it("builds a shell command that preserves cwd, env, and redirects", () => {
		const command = buildCmuxSpawnCommand({
			cwd: "/tmp/project folder",
			command: "/usr/local/bin/node",
			args: ["/tmp/pi.js", "--mode", "json", "Task: review auth"],
			env: {
				FOO: "bar baz",
				MCP_DIRECT_TOOLS: "__none__",
			},
			stdoutPath: "/tmp/stdout file.jsonl",
			stderrPath: "/tmp/stderr file.log",
			exitCodePath: "/tmp/exit file.code",
		});
		assert.match(command, /cd '.*project folder'/);
		assert.ok(command.includes("bar baz"));
		assert.ok(command.includes("MCP_DIRECT_TOOLS"));
		assert.ok(command.includes("/usr/local/bin/node"));
		assert.ok(command.includes("Task: review auth"));
		assert.ok(command.includes("/tmp/stdout file.jsonl"));
		assert.ok(command.includes("/tmp/stderr file.log"));
		assert.ok(command.includes("/tmp/exit file.code"));
	});
});
