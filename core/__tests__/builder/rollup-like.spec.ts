import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { NormalizedInputOptions } from "rollup";
import { expect, it, vi } from "vitest";
import { UserConfig } from "vite";
import { RollupBuilder, ViteBuilder } from "../../src/builder/rollup-like.ts";
import { Builder } from "../../src/host/index.ts";

const directory = mkdtempSync(join(tmpdir(), "esbench-"));

async function testBundle(builder: Builder) {
	const file = "./__tests__/fixtures/no-case.js";
	await builder.build(directory, [file]);

	const url = pathToFileURL(join(directory, "index.js"));
	const module = await import(url.href);

	const postMessage = vi.fn();
	await module.default(postMessage, file);

	const result = postMessage.mock.calls.at(-1)![0];
	expect(result.meta.foobar).toBeTypeOf("object");

	return [readFileSync(url, "utf8"), module];
}

it.each([
	[new RollupBuilder(), "Rollup"],
	[new ViteBuilder(), "Vite"],
])("should suggest a name %#", (executor, name) => {
	expect(executor.name).toBe(name);
});

it("should generate loader entry with Rollup", () => {
	return testBundle(new RollupBuilder());
});

it("should merge config in Rollup", async () => {
	let options!: NormalizedInputOptions;

	await testBundle(new RollupBuilder({
		external: undefined,
		input: "foo.js",
		plugins: {
			name: "test",
			buildStart: arg0 => { options = arg0; },
		},
	}));

	expect(options.input).not.toBe("foo.js");
	expect(options.external("fs", "x.js", true)).toBe(false);
});

it("should generate loader entry with Vite", async () => {
	const [code] = await testBundle(new ViteBuilder());
	expect(code).not.toContain("__vitePreload");
});

it("should merge config in Vite", async () => {
	let options: UserConfig = {};

	await testBundle(new ViteBuilder({
		build: {
			rollupOptions: {
				input: "foo.js",
			},
		},
		plugins: [{
			name: "test",
			config: arg0 => { options = arg0; },
		}],
	}));
	expect(options).toHaveProperty("configFile", false);
	expect(options.build!.rollupOptions!.input).not.toBe("foo.js");
});
