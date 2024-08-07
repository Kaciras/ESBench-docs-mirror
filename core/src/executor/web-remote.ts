import * as http from "node:http";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import * as https from "node:https";
import { json } from "node:stream/consumers";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { extname, join } from "node:path";
import { AddressInfo } from "node:net";
import { ClientMessage } from "../connect.js";
import { transformer } from "./transform.js";
import { Executor, SuiteTask } from "../host/toolchain.js";
import { HostContext } from "../host/context.js";

const moduleMime: Record<string, string | undefined> = {
	css: "text/css",
	js: "text/javascript",
	json: "application/json",
	wasm: "application/wasm",
};

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>ESBench Client</title>
<script type="module" src="/_es-bench/loader.js"></script>
</head>
<body></body>
</html>`;

// https://developer.mozilla.org/en-US/docs/Web/API/Performance/now#security_requirements
export const htmlEntryHeaders = {
	"Content-Type": "text/html",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

const loader = `\
const postMessage = message => fetch("/_es-bench/message", {
	method: "POST",
	body: JSON.stringify(message),
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let imported = false

async function executeBenchmarks({ entry, file, pattern }) {
	try {
		const module = await import(entry);
		imported = true;
		return module.default(postMessage, file, pattern);
	} catch (e) {
		const { name, message, stack } = e;
		return postMessage({ e: { name, message, stack } });
	}
}

for (; ;) {
	try {
		const response = await fetch("./_es-bench/task");
		if (!response.ok) {
			continue; // Server is switching task.
		}
		/*
		 * If ESBench quits, the page doesn't exist, and refreshing won't
		 * re-enter the page, so we must wait for the next request.
		 */
		if (imported) {
			// Refresh the page to reset globals.
			location.reload();
		}
		await executeBenchmarks(await response.json());
	} catch {
		await sleep(5000); // ESBench quits, reduce polling frequency.
	}
}`;

function resolveUrl(server: Server, options: WebRemoteExecutorOptions) {
	const info = server.address() as AddressInfo;
	let hostname = info.address;
	switch (hostname) {
		case "0.0.0.0":
		case "::":
		case "0000:0000:0000:0000:0000:0000:0000:0000":
			hostname = "localhost";
	}
	if (hostname.includes(":")) {
		hostname = `[${hostname}]`;
	}
	const protocol = options.key ? "https" : "http";
	return `${protocol}://${hostname}:${info.port}`;
}

interface WebRemoteExecutorOptions extends https.ServerOptions {
	/**
	 * The host parameter of `Server.listen`.
	 */
	host?: string;

	/**
	 * The port parameter of `Server.listen`.
	 *
	 * @default 14715
	 */
	port?: number;
}

/**
 * Benchmark on any device that has HTTP access to the machine!
 *
 * @see https://esbench.vercel.app/guide/toolchains#webremoteexecutor
 */
export default class WebRemoteExecutor implements Executor {

	private server!: Server;
	private task?: SuiteTask;

	private readonly options: WebRemoteExecutorOptions;

	/**
	 * Create a new WebRemoteExecutor instance, if `options.key`
	 * is set, it will create an HTTPS server.
	 */
	constructor(options: WebRemoteExecutorOptions = {}) {
		this.options = options;
	}

	get name() {
		return "web remote";
	}

	async start(ctx: HostContext) {
		const listener = this.handleRequest.bind(this);

		this.server = this.options.key
			? https.createServer(this.options, listener)
			: http.createServer(this.options, listener);

		const { host, port = 14715 } = this.options;
		this.server.listen(port, host);
		await once(this.server, "listening");

		const url = resolveUrl(this.server, this.options);
		ctx.info("[WebRemoteExecutor] Waiting for connection to: " + url);
	}

	close() {
		return new Promise((resolve, reject) => {
			this.server.on("close", resolve);
			this.server.close(reject);
			this.server.closeAllConnections();
		});
	}

	execute(task: SuiteTask) {
		this.task = task;
	}

	async handleRequest(request: IncomingMessage, response: ServerResponse) {
		const [path] = request.url!.split("?", 2);

		// Page and the loader code.
		switch (path) {
			case "/":
				return response.writeHead(200, htmlEntryHeaders).end(html);
			case "/_es-bench/loader.js":
				return response
					.writeHead(200, { "Content-Type": "text/javascript" })
					.end(loader);
		}

		if (!this.task) {
			return response.writeHead(404).end();
		}

		const { root, file, pattern, dispatch } = this.task;
		if (path === "/_es-bench/message") {
			const message = await json(request) as ClientMessage;
			if ("e" in message) {
				const protocol = this.options.key ? "https" : "http";
				const origin = `${protocol}://${request.headers.host}`;
				transformer.fixStack(message.e, origin, root);
			}
			dispatch(message);
			if (!("level" in message)) {
				this.task = undefined; // Execution finished.
			}
			return response.writeHead(204).end();
		}

		if (path === "/_es-bench/task") {
			const body = { entry: "/index.js", file, pattern };
			return response.end(JSON.stringify(body));
		}

		try {
			const parsed = transformer.parse(root, path);
			if (!parsed) {
				// Non-import request or resolving disabled.
				return this.sendFile(join(root, path), response);
			}
			// The module may need to be transformed.
			const body = await transformer.load(parsed);
			if (body) {
				const headers = { "Content-Type": "text/javascript" };
				return response.writeHead(200, headers).end(body);
			} else {
				return this.sendFile(parsed, response);
			}
		} catch (e) {
			return response.writeHead(404).end(e.message);
		}
	}

	sendFile(fullPath: string, response: ServerResponse) {
		const stream = createReadStream(fullPath);
		stream.on("open", () => {
			const headers: http.OutgoingHttpHeaders = {};
			const mime = moduleMime[extname(fullPath).slice(1)];
			if (mime) {
				headers["Content-Type"] = mime;
			}
			stream.pipe(response.writeHead(200, headers));
		});
		stream.on("error", () => response.writeHead(404).end());
	}
}
