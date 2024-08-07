import { expect, it, vi } from "vitest";
import { noop } from "@kaciras/utilities/node";
import { emptySuite, PartialSuite, runProfilers, spin } from "./helper.js";
import { ExecutionTimeMeasurement, TimeProfiler, TimeProfilerOptions } from "../src/time.js";
import { BenchCase, ProfilingContext, Scene } from "../src/index.ts";

function newContext() {
	return new ProfilingContext(emptySuite, [], { log: noop });
}

function measureTime(options: TimeProfilerOptions, suite?: PartialSuite) {
	const profiler = new TimeProfiler({
		iterations: 1,
		samples: 1,
		warmup: 0,
		...options,
	});
	return runProfilers([profiler], suite);
}

// Mock heavy overhead to make the test stable and fast.
function mockZeroMeasurement(measurement: ExecutionTimeMeasurement) {
	measurement.measure = function (name, iterator, count) {
		if (name === "Overhead") {
			return Promise.resolve([22, 22]);
		}
		if (name === "Actual") {
			return Promise.resolve([1, 1]);
		}
		return ExecutionTimeMeasurement.prototype.measure.call(this, name, iterator, count);
	};
}

it.each([
	[{ unrollFactor: 0 }, "The unrollFactor must be at least 1"],
	[{ samples: 0 }, "The number of samples must be at least 1"],
	[{ iterations: 0 }, "The number of iterations cannot be 0 or negative"],
	[{ iterations: "0m" }, "Iteration time must be > 0"],
	[{ iterations: "-2s" }, "Iteration time must be > 0"],
	[
		{ unrollFactor: 2, iterations: 3 },
		"iterations must be a multiple of unrollFactor",
	],
])("should validate options %#", (options, msg) => {
	return expect(async () => measureTime(options)).rejects.toThrow(msg);
});

it("should run iteration hooks", async () => {
	const invocations: unknown[] = [];
	await measureTime({
		iterations: 2,
	}, {
		setup(scene) {
			scene.beforeIteration(() => invocations.push("before"));
			scene.afterIteration(() => invocations.push("after"));
			scene.bench("A", () => invocations.push("bench A"));
			scene.benchAsync("B", () => invocations.push("bench B"));
		},
	});
	expect(invocations).toStrictEqual([
		"before", "bench A", "after", "before", "bench A", "after",
		"before", "bench B", "after", "before", "bench B", "after",
	]);
});

it("should support specify number of samples", async () => {
	const fn = vi.fn(spin);
	const result = await measureTime({
		warmup: 3,
		samples: 22,
	}, {
		setup: scene => scene.benchAsync("Test", fn),
	});
	expect(fn).toHaveBeenCalledTimes(25);
	expect(result.scenes[0].Test.time).toHaveLength(22);
});

it("should support specify number of iterations", async () => {
	const fn = vi.fn();
	const result = await measureTime({
		iterations: 16,
		unrollFactor: 8,
	}, {
		setup: scene => scene.bench("Test", fn),
	});
	expect(fn).toHaveBeenCalledTimes(16);
	expect(result.scenes[0].Test.time).toHaveLength(1);
});

it.each([
	[0.1, "165ms", 1650, 16],
	[1, "100ms", 100, 1],
	[42, "100ms", 2, 1],
])("should estimate iterations %#", async (s, t, i, c) => {
	const scene = new Scene({});
	const case_ = new BenchCase(scene, "Test", () => spin(s), false);

	const etm = new ExecutionTimeMeasurement(newContext(), case_);
	const [iterations, iter] = await etm.estimate(t);

	expect(iter.calls).toBe(c);
	expect(Math.round(iterations)).toBeLessThan(i * 1.05); // ±5%
	expect(Math.round(iterations)).toBeGreaterThan(i * 0.95);
});

it("should check zero measurement", async () => {
	const ctx = newContext();
	const scene = new Scene({});
	scene.bench("Test", noop);

	const measurement = new ExecutionTimeMeasurement(ctx, scene.cases[0], {
		iterations: 1,
	});
	mockZeroMeasurement(measurement);

	const time = await measurement.run();
	expect(time).toStrictEqual([0]);
	expect(ctx.notes[0].type).toBe("warn");
	expect(ctx.notes[0].text).toBe("The function duration is indistinguishable from the empty function duration.");
});

it("should not set throughput for zero measurement", async () => {
	const run = vi.spyOn(ExecutionTimeMeasurement.prototype, "run");
	run.mockResolvedValue([0]);
	const mockProfiler = new TimeProfiler({ throughput: "s" });

	const result = await runProfilers([mockProfiler], {
		setup: scene => scene.bench("Test", noop),
	});
	expect(result.scenes[0].Test).toStrictEqual({});
});

it("should skip overhead stage if evaluateOverhead is false", async () => {
	const stubFn = vi.fn(noop);
	const result = await measureTime({
		evaluateOverhead: false,
	}, {
		setup: scene => scene.bench("Test", stubFn),
	});
	expect(stubFn).toHaveBeenCalledTimes(1);
	expect((result.scenes[0].Test.time as number[])[0]).toBeGreaterThan(0);
});

it("should measure time as duration", async () => {
	const result = await measureTime({
		iterations: 32,
	}, {
		setup: scene => scene.bench("Test", spin),
	});

	const metrics = result.scenes[0].Test;
	expect(result.meta.time).toBeDefined();
	expect((metrics.time as number[])[0]).toBeCloseTo(1, 1);
});

it("should measure time as throughput", async () => {
	const result = await measureTime({
		throughput: "s",
		iterations: 512,
	}, {
		setup: scene => scene.bench("Test", spin),
	});

	expect(result.meta.time).toBeUndefined();
	expect(result.meta.throughput).toBeDefined();

	const metrics = result.scenes[0].Test;
	const [throughput] = metrics.throughput as number[];
	expect(metrics.time).toBeUndefined();
	expect(throughput).toBeLessThan(1005);
	expect(throughput).toBeGreaterThan(985);
});

it("should set small throughput value", async () => {
	const result = await measureTime({
		throughput: "ms",
		iterations: 10,
	}, {
		setup: scene => scene.bench("Test", () => spin(10)),
	});

	const metrics = result.scenes[0].Test;
	const [throughput] = metrics.throughput as number[];
	expect(throughput).toBeCloseTo(0.1, 2);
});
