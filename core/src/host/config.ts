import { Awaitable, identity } from "@kaciras/utilities/node";
import { ESBenchResult } from "../connect.js";
import { Builder, Executor, Nameable, ToolChainItem } from "./toolchain.js";
import { HostContext, LogLevel } from "./context.js";
import noBuild from "../builder/default.js";
import inProcess from "../executor/in-process.js";
import rawReporter from "../reporter/raw.js";
import textReporter from "../reporter/text.js";

export interface ESBenchConfig {
	/**
	 * Which files will be run as benchmark suites uses which toolchains.
	 */
	toolchains?: ToolchainOptions[];

	/**
	 * Choose dir that ESBench uses to save temporary files.
	 *
	 * @default ".esbench-tmp"
	 */
	tempDir?: string;

	/**
	 * Adjust console output verbosity.
	 *
	 * @default "debug"
	 */
	logLevel?: LogLevel;

	/**
	 * Choose whether or not to remove the temporary directory after benchmark.
	 *
	 * @default true
	 */
	cleanTempDir?: boolean;

	/**
	 * Specifies the path to a result file generated by `rawReporter`.
	 * If it is defined, the difference between the current result will be displayed on the report.
	 *
	 * @default "node_modules/.esbench/result.json"
	 */
	diff?: string | null;

	/**
	 * Configure reporters for processing benchmark results.
	 *
	 * @default [
	 *     textReporter(),
	 *     rawReporter("node_modules/.esbench/result.json")
	 * ]
	 */
	reporters?: Reporter[];
}

type ToolConfig<T> = Nameable<T> | undefined | null | false;

export interface ToolchainOptions {
	/**
	 * The micromatch patterns ESBench uses to glob suite files.
	 *
	 * @default ["./benchmark/**\/*.[jt]s?(x)"]
	 */
	include?: string[];

	/**
	 * The micromatch glob patterns to ignore files.
	 */
	exclude?: string[];

	/**
	 * Specific a list of builder to transform source files before execution,
	 * falsy values are ignored. Each build results as a new set of benchmarks.
	 *
	 * By default, it will perform no transform at all.
	 */
	builders?: Array<ToolConfig<Builder>>;

	/**
	 * With executors, you specify JS runtimes that ESBench execute your suites,
	 * falsy values are ignored.
	 *
	 * By default, ESBench run your suites in the current context.
	 */
	executors?: Array<ToolConfig<Executor>>;
}

/**
 * A reporter allows you to export results of your benchmark in different formats.
 *
 * @param result The result of all suites.
 * @param context A number of utility functions and informational bits.
 */
export type Reporter = (result: ESBenchResult, context: HostContext) => Awaitable<unknown>;

/**
 * Type helper to mark the object as an ESBench config.
 */
export const defineConfig = identity<ESBenchConfig>;

export type NormalizedConfig = Required<ESBenchConfig> & {
	toolchains: ToolChainItem[];
}

export function normalizeConfig(input: ESBenchConfig) {
	if (input.toolchains?.length === 0) {
		throw new Error("No toolchains.");
	}

	const defaultDiff = "node_modules/.esbench/result.json";
	const config: ESBenchConfig = {
		tempDir: ".esbench-tmp",
		logLevel: "debug",
		cleanTempDir: true,
		diff: defaultDiff,
		reporters: [rawReporter(defaultDiff), textReporter()],
		...input,
		toolchains: [],
	};

	for (let toolchain of input.toolchains ?? [{}]) {
		toolchain = {
			include: ["./benchmark/**/*.[jt]s?(x)"],
			builders: [noBuild],
			executors: [inProcess],
			...toolchain,
		};
		config.toolchains!.push(toolchain);

		toolchain.builders = toolchain.builders!.filter(Boolean);
		toolchain.executors = toolchain.executors!.filter(Boolean);

		if (toolchain.builders?.length === 0) {
			throw new Error("No builders.");
		}
		if (toolchain.executors!.length === 0) {
			throw new Error("No executors.");
		}
		if (toolchain.include?.length === 0) {
			throw new Error("No included files.");
		}
	}

	return config as NormalizedConfig;
}
