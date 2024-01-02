import { spawn } from "child_process";
import { existsSync } from "fs";
import { type Socket, connect } from "net";
import os from "os";
import { join } from "path";
import {
	ExtensionContext,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	StreamInfo,
	services,
	window,
	workspace,
} from "coc.nvim";

function resolveBiomeBin(): string {
	// 1. biome.bin in coc-settings
	// 2. local node_modules
	const cfg = workspace.getConfiguration("biome");
	let bin = cfg.get<string | null>("bin", null);
	if (bin && existsSync(bin)) {
		return bin;
	}

	bin = join(workspace.root, "node_modules", ".bin", "biome");
	return existsSync(bin) ? bin : "";
}

async function getSocketPath(command: string): Promise<string> {
	const nvim = workspace.nvim;
	const tmpdir = ((await nvim.eval("$TMPDIR")) || os.tmpdir()) as string;
	const child = spawn(command, ["__print_socket"], {
		stdio: "pipe",
		shell: true,
		env: { ...process.env, TMPDIR: tmpdir },
	});
	return new Promise((resolve, reject) => {
		child.once("error", (err) => {
			console.error(err);
			reject("");
		});

		child.stdout.on("data", (data) => {
			resolve(data.toString("utf-8").trim());
		});
	});
}

async function createMessageTransports(command: string): Promise<StreamInfo> {
	const socketPath = await getSocketPath(command);
	if (!socketPath) {
		throw new Error("Could not get socket path from `biome __print_socket`");
	}

	let socket: Socket;
	try {
		socket = connect(socketPath);
	} catch (err) {
		throw new Error(`Could not connect to the Biome server at: ${socketPath}`);
	}

	await new Promise((resolve, reject) => {
		socket.once("ready", resolve);
		socket.once("error", (err) => reject(err));
	});

	return { writer: socket, reader: socket };
}

export async function activate(context: ExtensionContext): Promise<void> {
	const enable = workspace.getConfiguration("biome").get<boolean>("enable");
	if (!enable) {
		return;
	}

	const outputChannel = window.createOutputChannel("Biome");
	const requireConfiguration = workspace
		.getConfiguration("biome")
		.get("requireConfiguration", true);
	if (requireConfiguration) {
		const files = await workspace.findFiles("**/biome.json");
		if (files.length === 0) {
			outputChannel.appendLine("No biome.json file found");
			return;
		}
	}

	const command = resolveBiomeBin();
	if (!command) {
		outputChannel.appendLine("No biome binary file found");
		return;
	}

	const serverOptions: ServerOptions = createMessageTransports.bind(
		undefined,
		command,
	);
	const clientOptions: LanguageClientOptions = {
		outputChannel,
		progressOnInitialization: true,
		documentSelector: [
			{ scheme: "file", language: "json" },
			{ scheme: "file", language: "jsonc" },
			{ scheme: "file", language: "javascript" },
			{ scheme: "file", language: "javascriptreact" },
			{ scheme: "file", language: "typescript" },
			{ scheme: "file", language: "typescriptreact" },
		],
	};

	const client = new LanguageClient("biome", serverOptions, clientOptions);
	context.subscriptions.push(services.registerLanguageClient(client));
}
