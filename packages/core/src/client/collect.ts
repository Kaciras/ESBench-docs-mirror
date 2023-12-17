import { cartesianObject, MultiMap } from "@kaciras/utilities/browser";
import { BaselineOptions } from "./suite.js";
import { BUILTIN_FIELDS } from "./utils.js";
import { Metrics, WorkloadResult } from "./runner.js";

export function firstItem<T>(iterable: Iterable<T>) {
	for (const value of iterable) return value;
}

export type ESBenchResult = Record<string, StageResult[]>;

export interface StageResult {
	baseline?: BaselineOptions;
	executor?: string;
	builder?: string;
	paramDef: Record<string, string[]>;
	scenes: WorkloadResult[][];
}

const kMetrics = Symbol("metrics");

export type FlattedCase = Record<string, string> & {
	[kMetrics]: Metrics;
	Name: string;
	Builder?: string;
	Executor?: string;
}

export class SummaryTableFilter {

	readonly vars = new Map<string, Set<string>>();

	readonly table: FlattedCase[] = [];

	constructor(results: StageResult[]) {
		// Ensure the Name is the first entry.
		this.vars.set("Name", new Set());

		for (const result of results) {
			this.addStageResult(result);
		}
	}

	private addStageResult(stage: StageResult) {
		const { executor, builder, paramDef, scenes } = stage;
		const iter = cartesianObject(paramDef)[Symbol.iterator]();

		if (builder) {
			this.addToVar("Builder", builder);
		}
		if (executor) {
			this.addToVar("Executor", executor);
		}
		for (const [key, values] of Object.entries(paramDef)) {
			this.addToVar(key, ...values);
		}

		for (const scene of scenes) {
			const params = iter.next().value;
			for (const { name, metrics } of scene) {
				this.table.push({
					...params,
					Builder: builder,
					Executor: executor,
					Name: name,
					[kMetrics]: metrics,
				});
				this.addToVar("Name", name);
			}
		}
	}

	private addToVar(name: string, ...values: string[]) {
		let list = this.vars.get(name);
		if (!list) {
			this.vars.set(name, list = new Set());
		}
		for (const value of values) list.add(value);
	}

	get builtinParams() {
		return BUILTIN_FIELDS.filter(k => this.vars.has(k));
	}

	getMetrics(row: FlattedCase) {
		return row[kMetrics];
	}

	groupBy(key: string) {
		const group = new MultiMap<string, FlattedCase>();
		const hKeys = [...this.vars.keys()].filter(k => k !== key);
		for (const row of this.table) {
			group.add(this.hashKey(row, hKeys), row);
		}
		return group;
	}

	select(values: string[], axis: string) {
		return this.table.filter(row => {
			let index = 0;
			for (const k of this.vars.keys()) {
				const v = values[index++];
				if (k === axis) {
					continue;
				}
				if (row[k] !== v) {
					return false;
				}
			}
			return true;
		});
	}

	hashKey(row: FlattedCase, keys?: string[]) {
		const ks = keys ?? this.vars.keys();
		const parts = [];
		for (const k of ks) {
			parts.push(`${k}=${row[k]}`);
		}
		return parts.join(",");
	}

	createOptions() {
		return Array.from(this.vars.values(), firstItem) as string[];
	}
}
