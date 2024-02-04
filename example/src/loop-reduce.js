import { defineSuite } from "esbench";

export default defineSuite({
	name: "For-loop vs Array.reduce",
	baseline: {
		type: "Name",
		value: "For-index",
	},
	params: {
		size: [0, 100, 10_00],
	},
	setup(scene) {
		const { size } = scene.params;
		const values = new Array(size);

		for (let i = 0; i < size; i++) {
			values.push(Math.random());
		}

		scene.bench("For-index", () => {
			let sum = 0;
			for (let i = 0; i < size; i++) {
				sum += values[i];
			}
			return sum;
		});

		scene.bench("For-of", () => {
			let sum = 0;
			for (const v of values) sum += v;
			return sum;
		});

		scene.bench("Array.reduce", () => {
			return values.reduce((v, s) => s * v, 0);
		});
	},
});
