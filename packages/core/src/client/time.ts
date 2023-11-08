import { Awaitable, durationFmt } from "@kaciras/utilities/browser";
import { BenchCase, SuiteConfig } from "./suite.js";
import { BenchmarkWorker, Logger } from "./runner.js";
import { runHooks, timeDetail } from "./utils.js";
import { Metrics } from "./collect.js";

type IterateFn = (count: number) => Awaitable<number>;

function createInvoker(case_: BenchCase): IterateFn {
	const { fn, isAsync, setupHooks, cleanHooks } = case_;

	async function noSetup(count: number) {
		const start = performance.now();
		if (isAsync) {
			while (count-- > 0) await fn();
		} else {
			while (count-- > 0) fn();
		}
		return performance.now() - start;
	}

	async function syncWithSetup(count: number) {
		let timeUsage = 0;
		while (count-- > 0) {
			await runHooks(setupHooks);

			timeUsage -= performance.now();
			fn();
			timeUsage += performance.now();

			await runHooks(cleanHooks);
		}
		return timeUsage;
	}

	async function asyncWithSetup(count: number) {
		let timeUsage = 0;
		while (count-- > 0) {
			await runHooks(setupHooks);

			timeUsage -= performance.now();
			await fn();
			timeUsage += performance.now();

			await runHooks(cleanHooks);
		}
		return timeUsage;
	}

	const setup = setupHooks.length && cleanHooks.length;
	return setup ? isAsync ? asyncWithSetup : syncWithSetup : noSetup;
}

export class TimeWorker implements BenchmarkWorker {

	private readonly config: SuiteConfig;

	constructor(config: SuiteConfig) {
		this.config = config;
	}

	async onCase(case_: BenchCase, metrics: Metrics, logger: Logger) {
		const { warmup = 5, samples = 10, iterations = "1s" } = this.config;
		const iterate = createInvoker(case_);
		await logger(`\nBenchmark: ${case_.name}`);

		// noinspection SuspiciousTypeOfGuard (false positive)
		const count = typeof iterations === "number"
			? iterations
			: await this.getIterations(iterate, iterations, logger);

		if (samples <= 0) {
			throw new Error("The number of samples must be at least 1.");
		}
		if (count <= 0) {
			throw new Error("The number of iterations cannot be 0 or negative.");
		}

		for (let i = 0; i < warmup; i++) {
			const time = await iterate(count);
			await logger(`Wramup: ${timeDetail(time, count)}`);
		}

		// noinspection JSMismatchedCollectionQueryUpdate
		const values: number[] = metrics.time = [];
		await logger("");

		for (let i = 0; i < samples; i++) {
			const time = await iterate(count);
			values.push(time / count);
			await logger(`Actual: ${timeDetail(time, count)}`);
		}
	}

	async getIterations(fn: IterateFn, target: string, logger: Logger) {
		const targetMS = durationFmt.parse(target, "ms");

		let count = 1;
		let time = 0;
		while (time < targetMS) {
			time = await fn(count);
			await logger(`Pilot: ${timeDetail(time, count)}`);
			count *= 2;
		}

		await logger("");
		return Math.ceil(count / 2 * targetMS / time);
	}
}
