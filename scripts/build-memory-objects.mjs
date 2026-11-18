import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2) throw new Error("memory_native:unsupported_build_argument");
if (!["linux", "darwin"].includes(process.platform) || Number(process.versions.napi) < 8)
  throw new Error("memory_native:unsupported_build_platform");
const root = fileURLToPath(new URL("../", import.meta.url));
const headers = path.join(root, "native", "node-api", "v24.22.1");
const sources = JSON.parse(readFileSync(path.join(headers, "SOURCES.json"), "utf8"));
if (sources.upstreamVersion !== "v24.22.1" || sources.napiVersion !== 8 ||
    !Array.isArray(sources.files) || sources.files.length !== 5)
  throw new Error("memory_native:header_source_mismatch");
for (const name of ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "LICENSE"]) {
  const entries = sources.files.filter(entry => entry.name === name);
  if (entries.length !== 1 || createHash("sha256").update(readFileSync(path.join(headers, name))).digest("hex") !== entries[0].sha256)
    throw new Error("memory_native:header_checksum_mismatch");
}
const directory = path.join(root, "build", "memory-objects");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = path.join(directory, `memory-objects-${process.platform}-${process.arch}.node`);
const temporary = `${target}.${randomUUID()}.tmp`;
try {
  const built = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=boardroom_memory_objects", "-pthread",
    ...(process.platform === "linux" ? ["-shared", "-fPIC"] : ["-bundle", "-undefined", "dynamic_lookup"]),
    "-I", headers, path.join(root, "native", "memory-objects.c"), "-o", temporary,
    ...(process.platform === "linux" ? ["-ldl"] : [])], { encoding: "utf8", timeout: 60_000 });
  if (built.error || built.status !== 0) {
    process.stderr.write(built.stderr ?? "");
    throw new Error("memory_native:compiler_failed");
  }
  chmodSync(temporary, 0o700);
  const stat = lstatSync(temporary);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700)
    throw new Error("memory_native:output_identity_mismatch");
  renameSync(temporary, target);
} finally {
  rmSync(temporary, { force: true });
}
