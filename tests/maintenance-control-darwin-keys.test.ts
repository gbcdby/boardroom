import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { encodeControlJournalCandidate, parseControlJournalCandidate } from "../src/server/storage/maintenance/control-candidate/codec.ts";
import { controlVector } from "./fixtures/maintenance-control-candidate.ts";

const invalid = (error: unknown) => error instanceof MaintenanceFailure && error.code === "journal_invalid";

// Pure format controls. Native Darwin uses begin/size, while Linux uses start/end.
// These constructed facts are never a native observation or an ownership grant.
function darwinMapping(key: string) {
  const value: any = structuredClone(controlVector({ platform: "darwin" }).captured);
  const facts = value.controlProof.facts;
  facts.sessions.ownedResources = [{ key, device: "1", inode: "2" }];
  facts.sessions.inventory.items = [{ kind: "handle", pid: facts.actor.process.pid,
    startSeconds: facts.actor.process.startSeconds, startMicroseconds: facts.actor.process.startMicroseconds,
    key, fd: -1, path: "/a12/source.sqlite", device: "1", inode: "2", links: "1" }];
  return value;
}

test("A12-B Darwin native begin/size keys retain their exact canonical bytes", () => {
  for (const key of ["map:4294967296:16384", "map:0:4096", "map:18446744073709551614:1"]) {
    const value = darwinMapping(key);
    assert.deepEqual(parseControlJournalCandidate(value), value);
    assert.deepEqual(encodeControlJournalCandidate(value), Buffer.from(canonicalJson(value)));
  }
});

test("A12-B Darwin keys reject empty mappings and uint64 overflow on both collections", () => {
  for (const key of ["map:4294967296:0", "map:18446744073709551615:1", "map:0:18446744073709551616"]) {
    const ownedOnly = darwinMapping(key);
    ownedOnly.controlProof.facts.sessions.inventory.items = [];
    assert.throws(() => parseControlJournalCandidate(ownedOnly), invalid);
    const inventoryOnly = darwinMapping("map:4294967296:16384");
    inventoryOnly.controlProof.facts.sessions.inventory.items[0].key = key;
    assert.throws(() => parseControlJournalCandidate(inventoryOnly), invalid);
  }
});

test("A12-B Darwin mapping ownership stays exact without end/size normalization", () => {
  for (const mutate of [
    (item: any) => { item.key = "map:4294967296:4294983680"; },
    (item: any) => { item.inode = "3"; },
    (item: any) => { item.device = "3"; },
    (item: any) => { item.fd = 23; },
  ]) {
    const value = darwinMapping("map:4294967296:16384");
    mutate(value.controlProof.facts.sessions.inventory.items[0]);
    assert.throws(() => parseControlJournalCandidate(value), invalid);
  }
});

test("A12-B leaves Linux start/end mapping semantics strict", () => {
  const value: any = structuredClone(controlVector().captured);
  const facts = value.controlProof.facts;
  for (const [key, accepted] of [["map:1:9:0:r--p", true], ["map:9:2:0:r--p", false], ["map:9:9:0:r--p", false]] as const) {
    facts.sessions.ownedResources = [{ key, device: "1", inode: "2" }];
    facts.sessions.matches = [{ pid: facts.actor.process.pid, startTicks: facts.actor.process.startTicks,
      key, device: "1", inode: "2", sourceRole: "main" }];
    if (accepted) assert.deepEqual(parseControlJournalCandidate(value), value);
    else assert.throws(() => parseControlJournalCandidate(value), invalid);
  }
});
