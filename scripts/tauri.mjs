import tauriCli from "@tauri-apps/cli";

const args = process.argv.slice(2);

// Tauri's built-in static dev server opens a TCP listener even when devUrl is
// omitted. The desktop app can load frontendDist through its asset protocol,
// so keep local development entirely serverless unless explicitly overridden.
if (args[0] === "dev" && !args.includes("--no-dev-server")) {
  args.splice(1, 0, "--no-dev-server");
}

try {
  await tauriCli.run(args, "npm run tauri");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
