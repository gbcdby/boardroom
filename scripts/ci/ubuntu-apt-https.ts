/** The browser container source preparation has no package or network operations. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type UriChange = { before: string; after: string };
type FieldPart = { line: number; offset: number; value: string };
const trustOptions = new Set(['trusted', 'allow-insecure', 'allow-weak', 'allow-downgrade-to-insecure']);
const tokens = (value: string): string[] => value.trim().split(/\s+/).filter(Boolean);
function invalid(): never { throw new Error('unexpected active APT source structure or trust option'); }

export function convertUbuntuSources(source: string, format: 'list' | 'sources') {
  if (source.includes('\0')) invalid();
  const uris: UriChange[] = [];
  const uri = (before: string): string => {
    if (!/^https?:\/\/(archive|security)\.ubuntu\.com\/ubuntu\/?$/.test(before)) {
      // Do not copy an unexpected URL (which could contain credentials) to errors.
      throw new Error('unexpected active APT URI; only the existing official Ubuntu archive/security roots are allowed');
    }
    const after = before.replace(/^http:/, 'https:');
    uris.push({ before, after }); return after;
  };
  const disabledTrust = (name: string, value: string): void => {
    if (trustOptions.has(name.toLowerCase()) && !['no', 'false', '0'].includes(value.trim().toLowerCase())) invalid();
  };
  if (format === 'list') {
    const after = source.split('\n').map(line => {
      if (!line.trim() || line.trimStart().startsWith('#')) return line;
      const match = /^(\s*deb(?:-src)?\s+(?:\[[^\]\r\n]*\]\s+)?)(\S+)(\s+[^#]+)(#.*)?$/.exec(line);
      if (!match || tokens(match[3]!).length < 2) invalid();
      for (const option of match[1]!.matchAll(/\b([a-z-]+)\s*=\s*([^\s\]]+)/gi)) disabledTrust(option[1]!, option[2]!);
      return match[1]! + uri(match[2]!) + line.slice(match[1]!.length + match[2]!.length);
    }).join('\n');
    return { after, uris };
  }
  const after = source.split(/(\r?\n[ \t]*\r?\n)/).map((stanza, index) => {
    if (index % 2) return stanza; // Preserve the original blank separators, including CRLF.
    const lines = stanza.split('\n'), fields = new Map<string, FieldPart[]>();
    let current: FieldPart[] | undefined;
    for (let line = 0; line < lines.length; line++) {
      const text = lines[line]!;
      if (!text.trim() || text.trimStart().startsWith('#')) continue;
      const field = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*/.exec(text);
      if (field) {
        const name = field[1]!.toLowerCase();
        if (fields.has(name)) invalid();
        current = [{ line, offset: field[0].length, value: text.slice(field[0].length) }];
        fields.set(name, current);
      } else {
        const continuation = /^[ \t]+/.exec(text);
        if (!continuation || !current) invalid();
        current.push({ line, offset: continuation[0].length, value: text.slice(continuation[0].length) });
      }
    }
    if (!fields.size) return stanza;
    const value = (name: string): string => (fields.get(name) ?? []).map(part => part.value.trim()).join(' ');
    if (fields.has('enabled') && !['yes', 'no'].includes(value('enabled').toLowerCase())) invalid();
    if (value('enabled').toLowerCase() === 'no') return stanza;
    if (!tokens(value('types')).length || tokens(value('types')).some(type => type !== 'deb' && type !== 'deb-src')
      || !tokens(value('suites')).length || !tokens(value('components')).length || !tokens(value('uris')).length) invalid();
    for (const name of trustOptions) if (fields.has(name)) disabledTrust(name, value(name));
    for (const part of fields.get('uris')!) {
      lines[part.line] = lines[part.line]!.slice(0, part.offset) + part.value.replace(/\S+/g, uri);
    }
    return lines.join('\n');
  }).join('');
  return { after, uris };
}

function main(args: string[]): void {
  if (args.length !== 4 || args[0] !== '--apt-root' || args[2] !== '--evidence' || !args[1] || !args[3]) {
    throw new Error('usage: ubuntu-apt-https.ts --apt-root DIRECTORY --evidence DIRECTORY');
  }
  const root = path.resolve(args[1]), evidence = path.resolve(args[3]);
  mkdirSync(evidence, { recursive: true });
  const receipt = (value: unknown): void => writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(value, null, 2) + '\n');
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
  try {
    if (!lstatSync(root).isDirectory()) throw new Error('APT root must be a regular directory');
    const names: string[] = existsSync(path.join(root, 'sources.list')) ? ['sources.list'] : [];
    const parts = path.join(root, 'sources.list.d');
    if (existsSync(parts)) {
      if (!lstatSync(parts).isDirectory()) throw new Error('APT source parts must be a regular directory');
      for (const name of readdirSync(parts).sort()) {
        if (/^[A-Za-z0-9_.-]+\.(list|sources)$/.test(name)) names.push(path.join('sources.list.d', name));
      }
    }
    // Validate the whole active set before changing any source file.
    const files = names.map(name => {
      const filename = path.join(root, name);
      if (!lstatSync(filename).isFile()) throw new Error('APT source must be a regular file');
      const bytes = readFileSync(filename), before = bytes.toString('utf8');
      if (!bytes.equals(Buffer.from(before))) throw new Error('unexpected APT source text encoding');
      const converted = convertUbuntuSources(before, name.endsWith('.sources') ? 'sources' : 'list');
      return { name, filename, before, ...converted };
    });
    const hosts = new Set(files.flatMap(file => file.uris.map(uri => new URL(uri.after).hostname)));
    if (!hosts.has('archive.ubuntu.com') || !hosts.has('security.ubuntu.com')) {
      throw new Error('expected official Ubuntu archive/security sources are missing');
    }
    for (const file of files) {
      const destination = path.join(evidence, 'before', file.name);
      mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, file.before);
    }
    for (const file of files) {
      if (file.before !== file.after) writeFileSync(file.filename, file.after);
      const actual = readFileSync(file.filename, 'utf8');
      if (actual !== file.after) throw new Error('APT source readback differs from the validated conversion');
      const destination = path.join(evidence, 'after', file.name);
      mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, actual);
    }
    const changedFiles = files.filter(file => file.before !== file.after).length;
    const result = { schema: 'ubuntu-apt-https/v1', status: changedFiles ? 'CONVERTED' : 'ALREADY_HTTPS',
      root, changedFiles, files: files.map(file => ({ path: file.name, beforeSha256: hash(file.before),
        afterSha256: hash(file.after), uris: file.uris })) };
    receipt(result); process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    receipt({ schema: 'ubuntu-apt-https/v1', status: 'FAIL', root,
      error: error instanceof Error ? error.message : 'source preparation failed' });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`APT HTTPS preparation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
