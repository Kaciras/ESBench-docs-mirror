import type { TransformOptions } from "esbuild";
import { LoadHook, ModuleFormat, ResolveHook } from "module";
import { fileURLToPath } from "url";
import { dirname, join, sep } from "path";
import { readFileSync } from "fs";
import { parse, TSConfckCache } from "tsconfck";

type CompileFn = (code: string, filename: string) => string | Promise<string>;

async function swcCompiler(): Promise<CompileFn> {
	const swc = await import("@swc/core");
	const cache = new TSConfckCache<any>();

	return async (code, filename) => {
		const { tsconfig: { compilerOptions } } = await parse(filename, { cache });
		const { target = "es2022", module = "esnext" } = compilerOptions;

		const options: any = {
			filename,
			swcrc: false,
			sourceMaps: "inline",
			jsc: {
				target: target.toLowerCase(),
				parser: {
					syntax: "typescript",
					tsx: filename.endsWith("x"),
				},
			},
		};

		switch (options.jsc.target) {
			case "esnext":
			case "latest":
				options.jsc.target = "es2022";
		}

		options.module = {
			type: module.toLowerCase() === "commonjs" ? "commonjs" : "es6",
		};

		return (await swc.transform(code, options)).code;
	};
}

async function viteEsbuildCompiler(): Promise<CompileFn> {
	const { transformWithEsbuild } = await import("vite");
	return (code, filename) =>
		transformWithEsbuild(code, filename, { sourcemap: "inline" }).then(r => r.code);
}

async function esbuildCompiler(): Promise<CompileFn> {
	const { transform } = await import("esbuild");
	const cache = new TSConfckCache<any>();

	return async (code, sourcefile) => {
		const { tsconfig } = await parse(sourcefile, { cache });
		const options: TransformOptions = {
			sourcefile,
			loader: sourcefile.endsWith("x") ? "tsx" : "ts",
			sourcemap: "inline",
			tsconfigRaw: tsconfig,
		};
		return (await transform(code, options)).code;
	};
}

async function tsCompiler(): Promise<CompileFn> {
	const { default: ts } = await import("typescript");
	const cache = new TSConfckCache<any>();

	return async (code, fileName) => {
		const { tsconfig: { compilerOptions } } = await parse(fileName, { cache });

		compilerOptions.sourceMap = true;
		compilerOptions.inlineSourceMap = true;
		delete compilerOptions.outDir;

		/*
		 * "NodeNext" does not work with transpileModule().
		 * https://github.com/microsoft/TypeScript/issues/53022
		 */
		compilerOptions.module = "ESNext";

		return ts.transpileModule(code, { fileName, compilerOptions }).outputText;
	};
}

export const compilers = [swcCompiler, viteEsbuildCompiler, esbuildCompiler, tsCompiler];

let compile: CompileFn;

async function detectTypeScriptCompiler() {
	for (const create of compilers) {
		try {
			return await create();
		} catch (e) {
			if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
		}
	}
	throw new Error("No TypeScript transformer found");
}

/**
 * 1. Is a local file (starts with file protocol or relative path).
 * 2. Ends with a JS extension.
 * 3. Protocol and extension are case-insensitive.
 */
const jsFileRE = /^(?:file:|\.{1,2}\/).+\.([cm]?jsx?)$/i;

/**
 * For JS files, if they don't exist, then look for the corresponding TS source.
 *
 * When both `.ts` and `.js` files exist for a name, it's safe to assume
 * that the `.js` is compiled from the `.ts`, I haven't seen an exception yet.
 */
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
	try {
		return await nextResolve(specifier, context);
	} catch (e) {
		const match = jsFileRE.exec(specifier);
		if (!match || e.code !== "ERR_MODULE_NOT_FOUND") {
			throw e;
		}
		const [, ext] = match;
		const base = specifier.slice(0, -ext.length);
		return nextResolve(base + ext.replace("j", "t"), context);
	}
};

// noinspection JSUnusedGlobalSymbols
export const load: LoadHook = async (url, context, nextLoad) => {
	const match = /\.[cm]?tsx?$/i.exec(url);
	if (!match || !url.startsWith("file:")) {
		return nextLoad(url, context);
	}

	const raw = await nextLoad(url, {
		...context,
		format: "ts" as any,
	});

	const code = raw.source!.toString();
	const filename = fileURLToPath(url);

	let format: ModuleFormat;
	switch (match[0].charCodeAt(1)) {
		case 99: /* c */
			format = "commonjs";
			break;
		case 109: /* m */
			format = "module";
			break;
		default: /* t */
			format = getPackageType(filename);
	}

	if (!compile) {
		compile = await detectTypeScriptCompiler();
	}
	const source = await compile(code, filename);

	return { source, format, shortCircuit: true };
};

const node_modules = sep + "node_modules";

// make `load` 15.47% faster
export const typeCache = new Map<string, ModuleFormat>();

const cacheAndReturn = (dir: string, type: ModuleFormat) => {
	typeCache.set(dir, type);
	return type;
};

/**
 * https://nodejs.org/docs/latest/api/packages.html#type
 */
function getPackageType(filename: string): ModuleFormat {
	const dir = dirname(filename);

	const cached = typeCache.get(dir);
	if (cached) {
		return cached;
	}
	try {
		const json = readFileSync(join(dir, "package.json"), "utf8");
		return cacheAndReturn(dir, JSON.parse(json).type ?? "commonjs");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	if (!dir || dir.endsWith(node_modules)) {
		return cacheAndReturn(dir, "commonjs");
	} else {
		return cacheAndReturn(dir, getPackageType(dir));
	}
}