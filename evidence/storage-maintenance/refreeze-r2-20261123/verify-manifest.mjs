import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8'));

const expectedKeys = [
  'baseline', 'candidate_id', 'excluded_items',
  'generated_rules_version', 'members', 'notes', 'status',
];
const actualKeys = Object.keys(manifest).sort();
if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys.sort())) {
  throw new Error(`unexpected manifest keys: ${actualKeys.join(',')}`);
}
if (manifest.candidate_id !== 'BR-S4-T2-REFREEZE-20261123-R2') {
  throw new Error('unexpected candidate_id');
}
if (manifest.baseline.commit !== '0834f9e56001745d6cfff38f06654a44e944d911' ||
    manifest.baseline.tree !== '9b500b69cc8af7e8116443c8469f181205173d6f') {
  throw new Error('unexpected baseline commit/tree');
}
if (manifest.generated_rules_version !== 'canonical-json-v1-utf16-lexical') {
  throw new Error('unexpected generated_rules_version');
}

const memberKeys = ['bytes', 'origin', 'original_digest_match', 'path', 'role', 'sha256'];
const seen = new Set();
for (const member of manifest.members) {
  if (JSON.stringify(Object.keys(member).sort()) !== JSON.stringify([...memberKeys].sort())) {
    throw new Error(`unexpected member keys in ${member.path}: ${Object.keys(member).join(',')}`);
  }
  if (member.origin !== 'RECONSTRUCTED_NOT_ORIGINAL' || member.original_digest_match !== false) {
    throw new Error(`member ${member.path} must be reconstructed without original digest match`);
  }
  if (seen.has(member.path)) throw new Error(`duplicate member ${member.path}`);
  seen.add(member.path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(member.path) || member.path.includes('..') || member.path.startsWith('/')) {
    throw new Error(`unsafe member path ${member.path}`);
  }
  const bytes = readFileSync(join(root, member.path));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== member.bytes || digest !== member.sha256) {
    throw new Error(`member mismatch ${member.path}: bytes=${bytes.length} sha=${digest}`);
  }
}

const forbidden = manifest.members.filter((m) =>
  m.path.includes('validation-matrix') || m.path.includes('raw-results') ||
  m.path.includes('CANDIDATE') || m.origin === 'ORIGINAL');
if (forbidden.length > 0) {
  throw new Error(`reconstructed/original artifacts must not be archived: ${forbidden.map((m) => m.path).join(',')}`);
}

console.log(`OK: ${manifest.members.length} member(s) verified, candidate=${manifest.candidate_id}`);
