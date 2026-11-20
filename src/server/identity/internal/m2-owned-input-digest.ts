import { createHash } from 'node:crypto';
import type { P0Request } from './m2-p0-types.ts';
import { fState } from './m2-p0-artifacts-common.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import { m2RequestData } from './m2-p0-request.ts';

const grammar=Object.freeze({
  start:Buffer.from('["m2-pc-closure-input/r2",{"artifacts":['),
  selected:Buffer.from('{"artifact":'),hex:Buffer.from(',"bytesHex":"'),kind:Buffer.from('","kind":'),
  close:Buffer.from('}'),comma:Buffer.from(','),contract:Buffer.from('],"contract":'),
  evidence:Buffer.from(',"evidence":'),graph:Buffer.from(',"graph":'),deletion:Buffer.from(',"proposedDeletion":null}]'),
});

/** Exact original inputDigest domain. This fixed owner streams the actual
 * admitted primitive-JSON input instead of building a second full Encoding
 * tree for its large selected hex fields. It grants no semantic result. */
export function m2OwnedInputDigest(request:P0Request):string {
  const f:FState=fState(request),owned=m2RequestData(request);
  f.require(owned?.rootKind==='profile-origin-history'&&owned.originalInput===request.input
    &&request.input.graph.observation.phase==='p1'&&request.input.proposedDeletion===null);
  f.charge(1,0,1);const hash=createHash('sha256');
  const token=(bytes:Buffer):void=>{f.charge(1,bytes.length);hash.update(bytes);};
  const value=(item:unknown):void=>{f.freeze(item);const bytes=f.encode(item);f.charge(1,bytes.bytes);f.hashEncoding(hash,bytes);};
  token(grammar.start);
  for(let index=0;index<request.input.artifacts.length;index++){
    f.charge(1);if(index)token(grammar.comma);const selected=request.input.artifacts[index]!;
    token(grammar.selected);value(selected.artifact);token(grammar.hex);
    // The actual M2 admission checked each lowercase hex nibble and SHA. ASCII
    // Latin-1 emission is exactly UTF-8 here; still pay conversion and SHA read.
    f.charge(2,selected.bytesHex.length*2);hash.update(selected.bytesHex,'latin1');
    token(grammar.kind);value(selected.kind);token(grammar.close);
  }
  token(grammar.contract);value(request.input.contract);token(grammar.evidence);value(request.input.evidence);
  token(grammar.graph);value(request.input.graph);token(grammar.deletion);f.charge(1,64);
  return hash.digest('hex');
}
