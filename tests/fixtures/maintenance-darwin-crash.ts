import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";

const [root, point] = process.argv.slice(2);
if (!root || !["temp_written", "file_synced", "renamed", "directory_synced"].includes(point ?? "")) throw new Error("invalid fixture input");
const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) };
const store = await ArtifactStore.open(root, source, { after: current => {
  if (current === point) process.kill(process.pid, "SIGKILL"); // Only this deliberately created fixture child.
} });
await store.putBytes("source-file-payload", Buffer.from("macos-publication-crash-fixture"));
throw new Error("fault point not reached");
