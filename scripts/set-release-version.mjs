import { readFile, writeFile } from "node:fs/promises";

const version = process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("Expected a numeric semantic version such as 0.42.1.");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const packageJson = await readJson("package.json");
packageJson.version = version;
await writeJson("package.json", packageJson);

const packageLock = await readJson("package-lock.json");
packageLock.version = version;
if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
await writeJson("package-lock.json", packageLock);

const tauriConfig = await readJson("src-tauri/tauri.conf.json");
tauriConfig.version = version;
await writeJson("src-tauri/tauri.conf.json", tauriConfig);

const cargoPath = "src-tauri/Cargo.toml";
const cargoToml = await readFile(cargoPath, "utf8");
const cargoVersionPattern = /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m;
if (!cargoVersionPattern.test(cargoToml)) {
  throw new Error("Could not update the package version in src-tauri/Cargo.toml.");
}
const updatedCargoToml = cargoToml.replace(
  cargoVersionPattern,
  `$1${version}$2`,
);
await writeFile(cargoPath, updatedCargoToml, "utf8");

console.log(`Release version set to ${version}`);
