import { createWriteStream } from "fs";
import { stdout } from "process";
import { Writable } from "stream";
import { once } from "events";
import chalk, { Chalk } from "chalk";
import stringLength from "string-width";
import { ESBenchResult } from "../connect.js";
import { Reporter } from "../host/config.js";
import { FormatOptions, SummaryTable, SummaryTableOptions } from "../table.js";

export interface TextReporterOptions extends SummaryTableOptions, FormatOptions {
	/**
	 * Write the report to a text file.
	 */
	file?: string;

	/**
	 * Set to false to disable print the report to console.
	 *
	 * @default true
	 */
	console?: boolean;
}

function print(
	result: ESBenchResult,
	previous: ESBenchResult,
	options: TextReporterOptions,
	out: Writable,
) {
	const stainer = options.chalk ?? chalk;
	const entries = Object.entries(result);
	out.write(stainer.blueBright(`Text reporter: Format benchmark results of ${entries.length} suites:`));

	for (const [name, toolchains] of entries) {
		const diff = previous[name];
		const table = SummaryTable.from(toolchains, diff, options);

		out.write(stainer.greenBright("\nSuite: "));
		out.write(name);
		out.write("\n");
		out.write(table.format(options).toMarkdown(stringLength));
		out.write("\n");

		if (table.hints.length > 0) {
			out.write(stainer.cyan("Hints:\n"));
			for (const note of table.hints) {
				out.write(stainer.cyan(note));
				out.write("\n");
			}
		}

		if (table.warnings.length > 0) {
			out.write(stainer.yellowBright("Warnings:\n"));
			for (const note of table.warnings) {
				out.write(stainer.yellowBright(note));
				out.write("\n");
			}
		}

		out.write("\n");
	}
}

/**
 * Format the results into text and output to various streams.
 */
export default function (options: TextReporterOptions = {}): Reporter {
	const { file, console = true } = options;
	return async (result, prev) => {
		if (console) {
			options.chalk = chalk;
			print(result, prev, options, stdout);
		}
		if (file) {
			const stream = createWriteStream(file);
			options.chalk = new Chalk({ level: 0 });
			print(result, prev, options, stream);
			await once(stream.end(), "finish");
		}
	};
}
