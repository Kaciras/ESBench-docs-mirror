import { expect, it } from "vitest";
import { createTable } from "../../src/client/index.js";

it("should works", () => {
	const table = createTable([{
		name: "test",
		paramDef: {},
		notes: [],
		scenes: [[
			{ name: "foo", metrics: { time: [0, 1, 1, 1] } },
			{ name: "bar", metrics: { time: [1, 2, 2, 2] } },
		]],
	}]);
	expect(Array.from(table)).toStrictEqual([
		["No.", "Name", "time"],
		["0", "foo", "750.00 us"],
		["1", "bar", "1,750.00 us"],
	]);
	expect(table.hints).toHaveLength(0);
});

it("should allow a column has different units", () => {
	const table = createTable([{
		name: "test",
		notes: [],
		paramDef: {},
		scenes: [[
			{ name: "foo", metrics: { time: [0, 1, 1, 1] } },
			{ name: "bar", metrics: { time: [1, 2, 2, 2] } },
		]],
	}], {
		flexUnit: true,
	});
	expect(Array.from(table)).toStrictEqual([
		["No.", "Name", "time"],
		["0", "foo", "750 us"],
		["1", "bar", "1.75 ms"],
	]);
});