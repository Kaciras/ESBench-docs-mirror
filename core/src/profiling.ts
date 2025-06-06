import { Awaitable, cartesianObject } from "@kaciras/utilities/browser";
import { LogLevel } from "./host/context.js";
import { RunSuiteOption } from "./runner.js";
import { BenchCase, NormalizedSuite, Scene } from "./suite.js";
import { RE_ANY, runFns } from "./utils.js";

export type LogType = Exclude<LogLevel, "off">;

/**
 * Calling this function always requires `await` in order to send the message as soon as possible.
 */
export type LogHandler = (message: string | undefined, level: LogType) => Awaitable<any>;

const consoleLogHandler: LogHandler = (message = "", level) => console[level](message);

/**
 * Metrics of a benchmark case measured by profilers.
 *
 * The value of any metric can be absent, reporters should be able to handle this.
 */
export type Metrics = Record<string, number | number[] | string | undefined>;

/**
 * Bench cases in the scene with their metrics.
 */
export type SceneResult = Record<string, Metrics>;

export enum MetricAnalysis {
	/**
	 * There is no analyze performed to the metric. This is the default value.
	 */
	None,

	/**
	 * Reporters should show diff & ratio with another result if present for the metric.
	 * The metric value must be a number or an array of number with at least 1 element.
	 */
	Compare,

	/**
	 * Reporters should display statistical indicators (stdDev, percentiles...) for the metric.
	 * The metric value must be an array of number with at least 1 element.
	 *
	 * Setting this value will also apply `MetricAnalysis.Compare`.
	 */
	Statistics,
}

export interface MetricMeta {
	/**
	 * Property name of the metric in Metrics.
	 */
	key: string;

	/**
	 * Specific the format when this metric displayed as text (numeric metric only).
	 * If not defined, the value will be converted using `.toString`.
	 *
	 * @example
	 * "{duration.ms}" // The metric is millisecond and should be formatted as duration.
	 * "{number} ops/s" // The value 2000 will be formatted to "2K ops/s".
	 */
	format?: string;

	/**
	 * Control which metrics can be derived from this (numeric metric only).
	 *
	 * @default MetricAnalysis.None
	 */
	analysis?: MetricAnalysis;

	/**
	 * Does a smaller value of the metric mean better performance?
	 * This option must be set if `analysis` is not `None`.
	 */
	lowerIsBetter?: boolean;
}

export interface Note {
	type: "info" | "warn";
	text: string;
	caseId?: number;
}

export interface Profiler {
	/**
	 * Called on each `ProfilingContext.run` (`runSuite` invokes it once).
	 * This is the recommended hook to add descriptions of metrics.
	 */
	onStart?: (ctx: ProfilingContext) => Awaitable<void>;

	/**
	 * Called on each scene (after `setup` of the suite).
	 */
	onScene?: (ctx: ProfilingContext, scene: Scene) => Awaitable<void>;

	/**
	 * Called for each case. In there you can add metrics as properties to `metrics`.
	 */
	onCase?: (ctx: ProfilingContext, case_: BenchCase, metrics: Metrics) => Awaitable<void>;

	/**
	 * Called at the end of `ProfilingContext.run`.
	 */
	onFinish?: (ctx: ProfilingContext) => Awaitable<void>;
}

export interface SuiteContext {
	/**
	 * Using this method will generate warnings, which are logs with log level "warn".
	 *
	 * There is no "error" level, just throw an Error object if you get a condition
	 * where you can't continue to run.
	 *
	 * Because the suite may be running in a different process, it is recommended to
	 * use `await` to ensure that log messages are sent to the host immediately.
	 *
	 * @example
	 * export default defineSuite({
	 *    async beforeAll(ctx) {
	 *        await ctx.debug("debug log");
	 *    },
	 *    async setup(scene) {
	 *        await scene.info("info log");
	 *        scene.bench("...", () => {});
	 *    },
	 *    async afterAll(ctx) {
	 *        await ctx.warn("warning log");
	 *    },
	 * });
	 */
	warn(message?: string): Awaitable<unknown>;

	/**
	 * Generate an "info" log. As these logs are displayed by default, use them for information
	 * that is not a warning but makes sense to display to all users.
	 */
	info(message?: string): Awaitable<unknown>;

	/**
	 * Generate a "debug" log. These logs are only processed if the `logLevel` option is
	 * explicitly set to "debug", otherwise it does nothing.
	 */
	debug(message?: string): Awaitable<unknown>;

	/**
	 * Add a note to result, it will print a log and displayed in the report.
	 *
	 * Different between notes and logs is that notes will be displayed in the report,
	 * while logs are only printed in console.
	 *
	 * @param type Type of the note, "info" or "warn".
	 * @param text The message of this note.
	 * @param case_ The case associated with this note.
	 */
	note(type: "info" | "warn", text: string, case_?: BenchCase): Awaitable<unknown>;
}

export class ProfilingContext implements SuiteContext {
	/**
	 * Result for each case in each scene.
	 */
	readonly scenes: SceneResult[] = [];

	/**
	 * Notes collected from the profiling.
	 *
	 * @see ProfilingContext.note
	 */
	readonly notes: Note[] = [];

	/**
	 * Descriptions of metrics.
	 *
	 * @see ProfilingContext.defineMetric
	 */
	readonly meta: Record<string, MetricMeta> = {};

	readonly suite: NormalizedSuite;
	readonly profilers: Profiler[];
	readonly pattern: RegExp;
	readonly logHandler: LogHandler;

	private hasRun = false;
	private caseIndex = 0;

	constructor(suite: NormalizedSuite, profilers: Profiler[], options: RunSuiteOption) {
		this.suite = suite;
		this.profilers = profilers;
		this.pattern = options.pattern ?? RE_ANY;
		this.logHandler = options.log ?? consoleLogHandler;
	}

	/**
	 * Profiler should add description for each metric that need to be reported.
	 *
	 * Values in the case metrics without descriptions will not be shown in the report,
	 * but they will still be serialized.
	 *
	 * @param description The description of the metric.
	 */
	defineMetric(description: MetricMeta) {
		this.meta[description.key] = description;
	}

	warn(message?: string) {
		return this.logHandler(message, "warn");
	}

	info(message?: string) {
		return this.logHandler(message, "info");
	}

	debug(message?: string) {
		return this.logHandler(message, "debug");
	}

	note(type: "info" | "warn", text: string, case_?: BenchCase) {
		this.notes.push({ type, text, caseId: case_?.id });
		return this.logHandler(text, type);
	}

	/**
	 * Create a new ProfilingContext for the same suite, profilers are not inherited.
	 */
	newWorkflow(profilers: Profiler[], options: RunSuiteOption = {}) {
		const { suite, pattern, logHandler } = this;
		options = { pattern, log: logHandler, ...options };
		return new ProfilingContext(suite, profilers, options);
	}

	/**
	 * Run the profiling, the result is saved at `scenes`, `notes` and `meta` properties.
	 *
	 * A ProfilingContext instance can only be run once.
	 */
	async run() {
		const { hasRun, suite: { params } } = this;
		if (hasRun) {
			throw new Error("A ProfilingContext can only be run once.");
		}
		this.hasRun = true;

		await this.runHooks("onStart");
		for (const comb of cartesianObject(params)) {
			await this.runScene(comb);
		}
		return this.runHooks("onFinish");
	}

	private async runScene(params: object) {
		const scene = new Scene(params, this);
		await this.suite.setup(scene);
		try {
			await this.runHooks("onScene", scene);

			const results: SceneResult = {};
			this.scenes.push(results);

			for (const case_ of scene.cases) {
				case_.id = this.caseIndex++;
				const metrics = {};
				await this.runHooks("onCase", case_, metrics);
				results[case_.name] = metrics;
			}
		} finally {
			await runFns(scene.teardownHooks);
		}
	}

	private async runHooks<K extends keyof Profiler>(name: K, ...args: any[]) {
		for (const profiler of this.profilers) {
			// @ts-expect-error Is it a TypeScript bug?
			await profiler[name]?.(this, ...args);
		}
	}
}
