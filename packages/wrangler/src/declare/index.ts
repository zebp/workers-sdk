import * as fs from "fs";
import path from "path";
import { execa } from "execa";
import { readConfig } from "../config";
import { experimental_patchConfig as patchConfig } from "../config/patch-config";
import { createCommand } from "../core/create-command";
import { confirm } from "../dialogs";
import { UserError } from "../errors";
import { logger } from "../logger";
import { dedent } from "../utils/dedent";
import type { Config } from "../config";
import type * as _ts from "typescript";

export const declareCommand = createCommand({
	metadata: {
		description:
			"👷 Declare Durable Objects in your config from your Worker code",
		owner: "Workers: Workers Observability",
		status: "experimental",
	},
	args: {
		name: {
			describe: "Name of the Worker",
			type: "string",
			requiresArg: true,
		},
		script: {
			describe: "The path to an entry point for your Worker",
			type: "string",
		},
		"legacy-env": {
			type: "boolean",
			describe: "Use legacy environments",
			hidden: true,
		},
	},
	async handler(args) {
		const config = readConfig(args);

		const program = await createTypescript(config);
		const checker = program.getTypeChecker();

		const resolverFile =
			program.getSourceFile("/wrangler/resolver.ts") ??
			bail("Resolver file was not found");
		const sourceFileSymbol =
			checker.getSymbolAtLocation(resolverFile) ??
			bail("resolver file symbol was not found");

		const exports = checker.getExportsOfModule(sourceFileSymbol);
		const defaultExport =
			exports.find((e) => e.name === "default") ??
			bail("Default export was not found");
		const defaultType = checker.getTypeOfSymbol(defaultExport);

		const itemsExtendingDurableObject = defaultType.isUnion()
			? defaultType.types.map((it) =>
					checker.typeToString(it).replaceAll('"', "")
				)
			: undefined;

		if (!itemsExtendingDurableObject) {
			throw new UserError("No Durable Objects found in your Worker");
		}

		logger.warn(
			`Found ${itemsExtendingDurableObject.length} Durable Objects that aren't present in your wrangler config`
		);

		const confirmed = await confirm(
			`Are you sure you want to declare these Durable Objects? This will add them to your wrangler config and create a migration for them.`
		);

		if (!confirmed) {
			return;
		}

		patchConfig(config.configPath ?? bail("No config path found"), {
			durable_objects: {
				bindings: itemsExtendingDurableObject.map((it) => ({
					name: it,
					class_name: it,
				})),
			},
			migrations: [
				{
					tag: `${new Date().toISOString()}-${itemsExtendingDurableObject.join("-")}`,
					new_sqlite_classes: itemsExtendingDurableObject,
				},
			],
		});

		logger.log(`Declared ${itemsExtendingDurableObject.join(", ")}`);
	},
});

// We need to find the actual path to the TypeScript library, not just the package name,
// so for the POC we'll just get node to resolve it for us.
async function findTypeScriptPath(): Promise<string | undefined> {
	const script = dedent`
  try {
    console.log(require.resolve("typescript"));
  } catch (error) {
    console.error(error);
  }
  `;

	const result = await execa("node", ["-e", script]);
	const typescriptPath = result.stdout.trim();
	return typescriptPath.length > 0 ? typescriptPath : undefined;
}

function bail(message: string): never {
	throw new Error(message);
}

function userBail(message: string): never {
	throw new UserError(message);
}

// This function is responsible for creating a file with a default export that is a union of all
// the durable objects that are defined in the worker. Doing this logic via the compiler API is
// a bit of a pain, so we're going to off-load it to the compiler's internals and just grab the
// result from the type checker.
function durableObjectResolverFile(
	ts: typeof _ts,
	workerMain: string
): _ts.SourceFile {
	return ts.createSourceFile(
		"/wrangler/resolver.ts",
		dedent`
    import type { DurableObject as DurableObjectEntrypoint } from 'cloudflare:workers';
    import type * as worker from "${path.resolve(workerMain)}";

    type Worker = typeof worker;

    type IsDurableObject<T> = T extends { new (...args: any[]): DurableObject }
      ? true
      : T extends { new (...args: any[]): DurableObjectEntrypoint }
      ? true
      : false;

    type FindDos<T extends keyof Worker> = {
      [K in T]: IsDurableObject<Worker[K]> extends true ? K : never;
    }[T];

    type A = FindDos<keyof Worker>;

    export default null as any as FindDos<keyof Worker>;
    `,
		{
			languageVersion: ts.ScriptTarget.ESNext,
		}
	);
}

async function createTypescript(wranglerConfig: Config, script?: string) {
	const tsPath = await findTypeScriptPath();
	if (!tsPath) {
		throw new UserError("TypeScript must be installed to use this command");
	}

	const ts: typeof _ts = await import(tsPath);

	const tsConfig = ts.readConfigFile("./tsconfig.json", (typescriptPath) =>
		fs.readFileSync(typescriptPath, "utf-8")
	);

	const main =
		script ?? wranglerConfig.main ?? userBail("Worker main was not found");

	const resolverFile = durableObjectResolverFile(ts, main);

	const host = ts.createCompilerHost(tsConfig.config);
	const program = ts.createProgram({
		rootNames: ["/wrangler/resolver.ts"],
		options: {
			...tsConfig.config,
			types: ["@cloudflare/workers-types"],
		},
		host: {
			...host,
			getSourceFile(
				fileName,
				languageVersionOrOptions,
				onError,
				shouldCreateNewSourceFile
			) {
				if (fileName === "/wrangler/resolver.ts") {
					return resolverFile;
				}

				return host.getSourceFile(
					fileName,
					languageVersionOrOptions,
					onError,
					shouldCreateNewSourceFile
				);
			},
		},
	});

	return program;
}
