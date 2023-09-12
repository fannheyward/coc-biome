import { spawn } from "child_process";
import { existsSync } from "fs";
import { type Socket, connect } from "net";
import { join } from "path";
import {
	ExtensionContext,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	StreamInfo,
	services,
	workspace,
} from "coc.nvim";

type Architecture = "x64" | "arm64";

type PlatformTriplets = {
	[P in NodeJS.Platform]?: {
		[A in Architecture]: {
			triplet: string;
			package: string;
		};
	};
};

const PLATFORMS: PlatformTriplets = {
	win32: {
		x64: {
			triplet: "x86_64-pc-windows-msvc",
			package: "@biomejs/cli-win32-x64",
		},
		arm64: {
			triplet: "aarch64-pc-windows-msvc",
			package: "@biomejs/cli-win32-arm64",
		},
	},
	darwin: {
		x64: {
			triplet: "x86_64-apple-darwin",
			package: "@biomejs/cli-darwin-x64",
		},
		arm64: {
			triplet: "aarch64-apple-darwin",
			package: "@biomejs/cli-darwin-arm64",
		},
	},
	linux: {
		x64: {
			triplet: "x86_64-unknown-linux-gnu",
			package: "@biomejs/cli-linux-x64",
		},
		arm64: {
			triplet: "aarch64-unknown-linux-gnu",
			package: "@biomejs/cli-linux-arm64",
		},
	},
};

function resolveBiomeBin(): string {
	// 1. biome.bin in coc-settings
	// 2. local node_modules
	const cfg = workspace.getConfiguration("biome");
	let bin = cfg.get<string | null>("bin", null);
	if (bin && existsSync(bin)) {
		return bin;
	}

	bin = join(
		workspace.root,
		"node_modules",
		"@biomejs",
		"biome",
		"bin",
		"biome",
	);
	if (existsSync(bin)) {
		const packageName = PLATFORMS[process.platform]?.[process.arch]?.package;
		return join(
			workspace.root,
			"node_modules",
			packageName,
			process.platform === "win32" ? "biome.exe" : "biome",
		);
	}
	return "";
}

async function getSocketPath(command: string): Promise<string> {
	const tmpdir = (await workspace.nvim.eval("$TMPDIR")) as string;
	const child = spawn(command, ["__print_socket"], {
		stdio: "pipe",
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

	const requireConfiguration = workspace
		.getConfiguration("biome")
		.get("requireConfiguration", true);
	if (requireConfiguration) {
		const files = await workspace.findFiles("**/biome.json");
		if (files.length === 0) {
			return;
		}
	}

	const command = resolveBiomeBin();
	if (!command) {
		return;
	}

	const serverOptions: ServerOptions = createMessageTransports.bind(
		undefined,
		command,
	);
	const clientOptions: LanguageClientOptions = {
		progressOnInitialization: true,
		documentSelector: [
			{ scheme: "file", language: "javascript" },
			{ scheme: "file", language: "javascriptreact" },
			{ scheme: "file", language: "typescript" },
			{ scheme: "file", language: "typescriptreact" },
		],
	};

	const client = new LanguageClient("biome", serverOptions, clientOptions);
	context.subscriptions.push(services.registerLanguageClient(client));
}
