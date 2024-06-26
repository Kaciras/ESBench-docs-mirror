import { serializeError } from "serialize-error";
import { BenchCase, NormalizedSuite, normalizeSuite, Scene, UserSuite } from "./suite.js";
import { ExecutionValidator } from "./validate.js";
import { TimeProfiler } from "./time.js";
import { BUILTIN_VARS, kWorkingParams, toDisplayName } from "./utils.js";
import { LogHandler, MetricMeta, Note, Profiler, ProfilingContext, SceneResult } from "./profiling.js";

class DefaultEventLogger implements Profiler {

	private sceneIndex = 0;
	private caseOfScene = 0;

	async onScene(ctx: ProfilingContext, scene: Scene) {
		const caseCount = scene.cases.length;
		const sceneCount = ctx.suite.paramNames.reduce((s, v) => s * v.length, 1);

		const i = ++this.sceneIndex;
		this.caseOfScene = 0;

		let paramsText = "no parameters defined.";
		if (ctx.suite.paramNames.length !== 0) {
			paramsText = `params: \n${JSON.stringify(scene.params)}`;
		}
		return caseCount === 0
			? ctx.info(`\nNo case found from scene #${i}, ${paramsText}`)
			: ctx.info(`\nScene #${i} of ${sceneCount}, ${caseCount} cases, ${paramsText}`);
	}

	onCase(ctx: ProfilingContext, case_: BenchCase) {
		const { name, isAsync, beforeHooks, afterHooks } = case_;
		const hooks = beforeHooks.length + afterHooks.length > 0;
		const i = ++this.caseOfScene;
		return ctx.info(`\nCase #${i}: ${name} (Async=${isAsync}, InvocationHooks=${hooks})`);
	}
}

/**
 * Wrap the original error and provide more information.
 * The original error can be retrieved by the cause property.
 */
export class RunSuiteError extends Error {
	/**
	 * The params property of the scene that threw the error.
	 *
	 * This property is not serializable, it will be undefined in the host side.
	 */
	readonly params?: object;

	/** JSON represent of the params */
	readonly paramStr?: string;

	constructor(message?: string, cause?: Error, params?: object, ps?: string) {
		super(message, { cause });
		this.params = params;
		this.paramStr = ps;
		this.cause = cause; // For compatibility.
	}

	// noinspection JSUnusedGlobalSymbols; Used by serializeError()
	toJSON() {
		const { name, stack, message, paramStr } = this;
		return {
			name, stack, message, paramStr,
			cause: serializeError(this.cause),
		};
	}

	static fromScene(params: object, cause: Error) {
		const p: Record<string, string> = {};
		for (const [k, v] of Object.entries(params)) {
			p[k] = toDisplayName(v);
		}
		const s = JSON.stringify(p);
		const message = "Error occurred in scene " + s;
		return new RunSuiteError(message, cause, params, s);
	}
}

RunSuiteError.prototype.name = "RunSuiteError";

/**
 * `baseline` option of the suite, with `value` transformed to short string.
 */
export interface ResultBaseline {
	type: string;
	value: string;
}

export interface RunSuiteResult {
	scenes: SceneResult[];
	notes: Note[];
	meta: Record<string, MetricMeta>;
	paramDef: Array<[string, string[]]>;
	baseline?: ResultBaseline;
}

export interface RunSuiteOption {
	/**
	 * A function that intercepts log messages.
	 * If not supplied, logs are printed to the console.
	 */
	log?: LogHandler;

	/**
	 * Run benchmark with names matching the Regex pattern.
	 */
	pattern?: RegExp;
}

function resolveProfilers(suite: NormalizedSuite) {
	const { timing, validate } = suite;

	const resolved: any = [new DefaultEventLogger()];
	if (validate) {
		resolved.push(new ExecutionValidator(validate));
	}
	if (timing) {
		resolved.push(new TimeProfiler(timing));
	}
	if (suite.profilers) {
		resolved.push(...suite.profilers);
	}
	return resolved.filter(Boolean) as Profiler[];
}

function convertBaseline({ params, paramNames, baseline }: NormalizedSuite) {
	if (!baseline) {
		return;
	}
	const { type, value } = baseline;

	if (BUILTIN_VARS.includes(type)) {
		if (typeof value !== "string") {
			throw new Error(`Value of baseline (${type}) must be a string`);
		}
		return baseline as ResultBaseline;
	}

	const i = params.findIndex(e => e[0] === type);
	if (i === -1) {
		throw new Error(`Baseline (${type}) does not in params`);
	}

	const k = params[i][1].indexOf(value);
	if (k !== -1) {
		return { type, value: paramNames[i][1][k] };
	}
	throw new Error(`Baseline value (${value}) does not in params[${type}}`);
}

/**
 * Run a benchmark suite. Any exception that occur within this function is wrapped with `RunSuiteError`.
 */
export async function runSuite(userSuite: UserSuite, options: RunSuiteOption = {}) {
	const suite = normalizeSuite(userSuite);
	const { beforeAll, afterAll, paramNames: paramDef } = suite;

	let context: ProfilingContext | undefined = undefined;
	try {
		const baseline = convertBaseline(suite);
		const profilers = resolveProfilers(suite);

		context = new ProfilingContext(suite, profilers, options);
		await beforeAll?.();
		await context.run().finally(afterAll);

		const { scenes, notes, meta } = context;
		return { notes, meta, baseline, paramDef, scenes } as RunSuiteResult;
	} catch (e) {
		const wp = context?.[kWorkingParams];
		if (wp) {
			throw RunSuiteError.fromScene(wp, e);
		}
		throw new RunSuiteError("Error occurred when running suite.", e);
	}
}
