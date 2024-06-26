import { pathToFileURL } from "url";
import { resolve, sep } from "path";
import { readFileSync } from "fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { transform } from "ts-directly";
import WebRemoteExecutor, { transformer } from "../../src/executor/web-remote.ts";
import { executorTester } from "../helper.ts";

vi.mock("ts-directly");

const importerURL = pathToFileURL("module.js").toString();

const lines = (...args: string[]) => args.join("\n");

// Path is system-depend, so we use placeholder __ROOT__/ and replace it in tests.
const stacks = [{
	type: "webkit",
	raw: lines(
		"main@http://localhost:14715/index.js:5:29",
		"@",
		"@http://localhost:14715/loader.js:2:20",
		"module code@http://localhost:14715/loader.js:1:32",
	),
	expected: lines(
		"Error: the message",
		"    at main (__ROOT__/index.js:5:29)",
		"    at __ROOT__/loader.js:2:20",
		"    at module code (__ROOT__/loader.js:1:32)",
	),
}, {
	type: "chromium",
	raw: lines(
		"Error",
		"    at gen (http://localhost:14715/index.js:2:8)",
		"    at gen.next (<anonymous>)",
		"    at x (http://localhost:14715/index.js:6:13)",
		"    at http://localhost:14715/index.js:10:3",
	),
	expected: lines(
		"Error: the message",
		"    at gen (__ROOT__/index.js:2:8)",
		"    at gen.next (<anonymous>)",
		"    at x (__ROOT__/index.js:6:13)",
		"    at __ROOT__/index.js:10:3",
	),
}];

it.each(stacks)("should convert error stack of $type", input => {
	const rootResolved = resolve("www");
	input.expected = input.expected.replaceAll("__ROOT__/", rootResolved + sep);

	const error = {
		name: "Error",
		message: "the message",
		stack: input.raw,
		cause: {
			name: "Error",
			message: "the message",
			stack: input.raw,
		},
	};
	transformer.fixStack(error, "http://localhost:14715", "www");

	expect(error.stack).toStrictEqual(input.expected);
	expect(error.cause.stack).toStrictEqual(input.expected);
});

it("should resolve transformed import paths in error stack", () => {
	const instance = Object.create(transformer);
	instance.enabled = true;

	const error = {
		message: "the message",
		name: "Error",
		stack: "main@http://[::1]/@fs/C:/temp/foobar.js:5:29",
	};

	instance.fixStack(error, "http://[::1]", "C:/www");
	expect(error.stack).toStrictEqual("Error: the message\n    at main (C:/temp/foobar.js:5:29)");
});

describe("transformer", () => {
	const instance = Object.create(transformer) as typeof transformer;
	instance.enabled = true;

	it("should not parse imports if transform disabled", () => {
		expect(transformer.parse("root", "/index.js")).toBeUndefined();
		expect(transformer.parse("root", "/@fs/foo.js")).toBeUndefined();
	});

	it.each([
		["/index.js", "root/index.js"],
		["foo.js", undefined],
		["/@fs/foo.ts", "foo.ts"],
	])("should get the path if transform might be required", (path, expected) => {
		expected = expected?.replaceAll("/", sep);
		expect(instance.parse("root", path)).toBe(expected);
	});

	it("should compile TS", async () => {
		const path = import.meta.filename;
		vi.mocked(transform).mockResolvedValue({
			format: "module",
			source: "foobar",
			shortCircuit: true,
		});

		const code = await transformer.load(path);

		expect(code).toBe("foobar");
		expect(transform).toHaveBeenCalledWith(readFileSync(path, "utf8"), path, "module");
	});

	it("should replace imports", () => {
		const mock = vi.spyOn(instance, "resolve");
		mock.mockReturnValue("foobar.js");

		const code = `\
			import x from "./x.js";
			const y = import(window.main);
			const z = import("y");
		`;
		const output = instance.transformImports(code, "module.js");

		expect(output).toBe(`\
			import x from "/@fs/foobar.js";
			const y = import(window.main);
			const z = import("/@fs/foobar.js");
		`);
		expect(mock).toHaveBeenNthCalledWith(1, "y", importerURL);
		expect(mock).toHaveBeenNthCalledWith(2, "./x.js", importerURL);
	});

	it("should throw ENOENT when file not found", async () => {
		return expect(instance.load("./foo.js"))
			.rejects
			.toHaveProperty("code", "ENOENT");
	});

	it("should not load non-JS files", () => {
		return expect(instance.load("./foo.wasm")).resolves.toBeUndefined();
	});
});

describe("WebRemoteExecutor", async () => {
	const tester = executorTester(new WebRemoteExecutor());

	const browser = await chromium.launch();
	const context = await browser.newContext();

	afterAll(() => browser.close());

	const baseExecute = tester.execute;
	tester.execute = async build => {
		const page = await context.newPage();
		try {
			await page.goto("http://localhost:14715");
			return await baseExecute(build);
		} finally {
			await page.close();
		}
	};

	it("should transfer messages", tester.successCase());

	it("should forward errors from runAndSend()", tester.insideError());

	it("should forward top level errors", tester.outsideError());

	it("should support import attributes", tester.importJSON());
});
