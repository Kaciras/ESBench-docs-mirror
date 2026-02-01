import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		target: "esnext",
	},
	publicDir: false,
	test: {
		// Some tests are depend on execution time,
		// so we disabled threads to improve accuracy.
		maxWorkers: 1,
		pool: "threads",
		coverage: {
			reporter: ["lcovonly"],
			provider: "v8",
		},
		mockReset: true,
		include: ["**/__tests__/**/*.spec.ts"],
	},
});
