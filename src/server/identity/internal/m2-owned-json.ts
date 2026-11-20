// Fixed M2 carrier reader. It constructs isolated data during the strict scan;
// there is no second whole-input JSON.parse or normal-path UTF-8 size scan.
// The original P0 scanner remains the default for its existing entry point.
import { assertP0State,chargeState, P0_LIMITS, siteData, throwP0 } from './m2-p0-budget.ts';
import type { P0State } from './m2-p0-budget.ts';
import type { P0Site } from './m2-p0-types.ts';
import { exactInteger } from './m2-p0-lexical.ts';

export interface M2OwnedCanonicalSource {
  readonly nodes:number;readonly text:number;readonly encoded:number;readonly sortWork:number;readonly sortBytes:number;
  readonly byteStart:number;readonly unitStart:number;readonly unitEnd:number;
  /** Exact syntax intersection with C-R3, including every descendant. */
  readonly r3:boolean;
}
const byteOwners=new WeakMap<object,{readonly state:P0State;readonly asciiKeys:boolean;readonly domain:'history'|'r3'|'s4';readonly source?:M2OwnedCanonicalSource}>();
const selectedBytes=new WeakMap<object,{readonly state:P0State;readonly bytes:Buffer}>();
/** Data provenance for the fixed canonical byte encoder, never a schema or
 * semantic result. Only this actual parser can create a membership. */
export function m2OwnedAsciiKeys(state:P0State,value:unknown):boolean {
  assertP0State(state);
  if(value===null||typeof value!=='object')return false;
  const own=byteOwners.get(value);return own?.state===state&&own.asciiKeys;
}
/** Exact syntax/size metadata from this one scan, never a schema decision. The
 * only stored nodes are the root and an object-valued top-level payload. */
export function m2OwnedCanonicalSource(state:P0State,value:unknown):M2OwnedCanonicalSource|undefined {
  assertP0State(state);if(value===null||typeof value!=='object')return undefined;
  const own=byteOwners.get(value);return own?.state===state&&own.asciiKeys&&own.domain==='r3'?own.source:undefined;
}
/** C-S4 has UTF-16 key ordering and finite fractional numbers. This separate
 * byte-data accessor cannot lend its source as C-R3 merely because it is frozen. */
export function m2OwnedS4Source(state:P0State,value:unknown):M2OwnedCanonicalSource|undefined {
  assertP0State(state);if(value===null||typeof value!=='object')return undefined;
  const own=byteOwners.get(value);return own?.state===state&&own.domain==='s4'?own.source:undefined;
}
/** Data decoded while the actual M2 carrier scanner read the same hex units.
 * Its later admission still checks length, selected limits and the full SHA. */
export function m2OwnedSelectedBytes(state:P0State,value:unknown):Buffer|undefined {
  assertP0State(state);if(value===null||typeof value!=='object')return undefined;
  const own=selectedBytes.get(value);return own?.state===state&&Object.isFrozen(value)?own.bytes:undefined;
}

function owned(state:P0State,text:string,site:P0Site,domain:'history'|'r3'|'s4'):unknown {
  assertP0State(state);
  const canonical=domain!=='history',s4=domain==='s4';
  const base=siteData(state,site).depth;
  const limit=():never=>throwP0(state,{code:'resource_limit',rule:'PC1B-RAW01',site});
  if(typeof text!=='string')throwP0(state,{code:'invalid_value',rule:'PC1B-RAW01',site});
  if(text.length>P0_LIMITS.outerBytes)return limit();
  // One character scan and one bounded materialization of decoded string data.
  // Additional escaped-string fragments/joins and numeric/key operations below
  // have separate reservations. Metadata precedes every shell/slot allocation.
  chargeState(state,{work:1,bytes:text.length*2},site);
  let at=0,utf8=text.length,maximumDepth=base,asciiKeys=true,utf8Delta=0,canonicalMismatch=false,r3=true;
  let nodeCount=0,stringUnits=0,sortWork=0,sortBytes=0;
  let payload:object|undefined,payloadSource:M2OwnedCanonicalSource|undefined;
  // UTF-16 reads were reserved above. Accumulate their UTF-8 size difference
  // without rounding each character into a separate work unit; reserve that
  // difference before the decoded value/fragment is materialized.
  const flushUtf8=():void=>{if(utf8Delta){chargeState(state,{bytes:utf8Delta*2},site);utf8Delta=0;}};
  const fail=():never=>{
    // The old reader rejects an overlarge UTF-8 wire before a syntax error even
    // if that error occurs at byte zero. Only this failing path needs the full
    // measurement that the successful single scan already performs itself.
    flushUtf8();chargeState(state,{work:1,bytes:text.length},site);
    const bytes=Buffer.byteLength(text,'utf8');
    chargeState(state,{bytes:bytes-text.length},site);
    if(bytes>P0_LIMITS.outerBytes)return limit();
    return throwP0(state,{code:s4?'semantic_unsupported':'invalid_value',rule:'PC1B-RAW01',site});
  };
  // S4 historically scans the complete strict syntax before its canonical
  // equality check. Record a spelling discrepancy and retain that precedence.
  const spelling=():void=>{if(s4)canonicalMismatch=true;else fail();};
  const take=():number=>{
    if(at>=text.length)return fail();
    const code=text.charCodeAt(at++);let extra=0;
    if(code>=0x80&&code<0x800)extra=1;
    else if(code>=0x800){
      if(code>=0xdc00&&code<=0xdfff&&at>1){const high=text.charCodeAt(at-2);extra=high>=0xd800&&high<=0xdbff?0:2;}
      else extra=2;
    }
    if(extra){utf8Delta+=extra;utf8+=extra;if(utf8>P0_LIMITS.outerBytes)return limit();}
    return code;
  };
  const space=():void=>{
    while(at<text.length){const c=text.charCodeAt(at);if(c!==32&&c!==9&&c!==10&&c!==13)break;if(canonical)spelling();take();}
  };
  const node=(depth:number):void=>{
    if(depth>P0_LIMITS.depth)return limit();maximumDepth=Math.max(maximumDepth,depth);
    chargeState(state,{work:1,nodes:1},site);nodeCount++;
  };
  const string=(key=false,selected?:Record<string,unknown>):string=>{
    if(take()!==34)return fail();let start=at,pendingHigh=false,highEscaped=false,parts:string[]|undefined,decodedUnits=0;
    let binary:Buffer|undefined,pendingNibble=0;
    if(selected!==undefined){
      // The parser has already created these own data properties. No external
      // object/callback, caller budget or checksum verdict enters this branch.
      const artifact=selected.artifact;
      const size=artifact!==null&&typeof artifact==='object'&&!Array.isArray(artifact)?(artifact as Record<string,unknown>).bytes:undefined;
      chargeState(state,{work:5,bytes:14},site);
      if(typeof size==='string'&&size.length<=7&&/^(?:0|[1-9][0-9]*)$/.test(size)){
        const count=Number(size);
        if(count<=P0_LIMITS.artifactBytes&&text.charCodeAt(at+count*2)===34){
          chargeState(state,{work:1,bytes:count,tuples:1},site);binary=Buffer.allocUnsafe(count);
        }
      }
    }
    const remember=(code:number,escaped:boolean):void=>{
      if(key&&code>127)asciiKeys=false;
      if(s4){
        if(pendingHigh){
          pendingHigh=false;
          if(code>=0xdc00&&code<=0xdfff){if(highEscaped||escaped)spelling();}
          else {r3=false;if(!highEscaped)spelling();
            if(code>=0xd800&&code<=0xdbff){pendingHigh=true;highEscaped=escaped;}
            else if(code>=0xdc00&&code<=0xdfff){r3=false;if(!escaped)spelling();}}
        }else if(code>=0xd800&&code<=0xdbff){pendingHigh=true;highEscaped=escaped;}
        else if(code>=0xdc00&&code<=0xdfff){r3=false;if(!escaped)spelling();}
      }else {
        if(pendingHigh){if(code<0xdc00||code>0xdfff)return fail();pendingHigh=false;}
        else if(code>=0xd800&&code<=0xdbff)pendingHigh=true;
        else if(code>=0xdc00&&code<=0xdfff)return fail();
      }
      decodedUnits++;
      if(binary!==undefined){
        const nibble=code>=48&&code<=57?code-48:code>=97&&code<=102?code-87:-1;
        if(nibble<0||decodedUnits>binary.length*2)binary=undefined;
        else if(decodedUnits%2)pendingNibble=nibble;
        else binary[decodedUnits/2-1]=(pendingNibble<<4)|nibble;
      }
    };
    const fragment=(end:number):void=>{
      if(end<=start)return;
      flushUtf8();
      chargeState(state,{work:1,bytes:(end-start)*2,tuples:1},site);parts!.push(text.slice(start,end));
    };
    while(at<text.length){
      let code=take(),escaped=false;
      if(code===34){
        if(pendingHigh){if(!s4)return fail();r3=false;if(!highEscaped)spelling();}
        stringUnits+=decodedUnits;
        if(selected!==undefined&&binary!==undefined&&decodedUnits===binary.length*2){
          chargeState(state,{work:1,tuples:2},site);selectedBytes.set(selected,{state,bytes:binary});
        }
        if(parts===undefined){flushUtf8();return text.slice(start,at-1);}
        fragment(at-1);chargeState(state,{work:1,bytes:decodedUnits*4},site);return parts.join('');
      }
      if(code<32)return fail();
      if(code===92){
        escaped=true;
        if(parts===undefined){chargeState(state,{work:1,tuples:1},site);parts=[];}
        fragment(at-1);const escape=take();
        if(escape===117){
          code=0;
          for(let digit=0;digit<4;digit++){
            const hex=take();let nibble:number;
            if(hex>=48&&hex<=57)nibble=hex-48;
            else if(hex>=65&&hex<=70){if(canonical)spelling();nibble=hex-55;}
            else if(hex>=97&&hex<=102)nibble=hex-87;
            else return fail();code=code*16+nibble;
          }
          if(canonical&&((code>=32&&!(s4&&code>=0xd800&&code<=0xdfff))||code===8||code===9||code===10||code===12||code===13))spelling();
        }else if(escape===34||escape===92)code=escape;
        else if(escape===47){if(canonical)spelling();code=47;}
        else if(escape===98)code=8;
        else if(escape===102)code=12;
        else if(escape===110)code=10;
        else if(escape===114)code=13;
        else if(escape===116)code=9;
        else return fail();
        flushUtf8();chargeState(state,{work:1,bytes:4,tuples:1},site);parts.push(String.fromCharCode(code));start=at;
      }
      remember(code,escaped);
    }
    return fail();
  };
  const before=(a:string,b:string):boolean=>{
    chargeState(state,{work:1,bytes:(a.length+b.length)*2},site);let x=0,y=0;
    if(s4)return a<b;
    while(x<a.length&&y<b.length){const p=a.codePointAt(x)!,q=b.codePointAt(y)!;if(p!==q)return p<q;x+=p>0xffff?2:1;y+=q>0xffff?2:1;}
    return a.length<b.length;
  };
  type Role='root'|'selections'|'selection'|'other';
  const record=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
  const value=(depth:number,role:Role='other',selected?:Record<string,unknown>):unknown=>{
    space();node(depth);const first=text.charCodeAt(at);
    if(first===34)return string(false,selected);
    if(first===123||first===91){
      const sourceUnit=at,sourceByte=at+utf8-text.length,sourceNodes=nodeCount-1,sourceText=stringUnits,sourceWork=sortWork,sourceSortBytes=sortBytes;
      take();const array=first===91;flushUtf8();chargeState(state,{work:1},site);
      // Semantic JSON shells/edges are already covered by the original nodes
      // ledger. Null prototypes allow direct data writes with no accessor or
      // __proto__ setter, eliminating per-property descriptor allocations.
      const result:unknown[]|Record<string,unknown>=array?Object.setPrototypeOf([],null) as unknown[]:Object.create(null) as Record<string,unknown>;
      state.depths.set(result,depth);space();
      let fields=0,maximumKey=0;
      const finish=():unknown=>{chargeState(state,{work:3},site);sortWork+=fields*fields;sortBytes+=fields*fields*maximumKey*2;
        // Native S4 consumers also canonicalize immutable nested values. Record
        // their byte intervals during this scan so those actual encodings need
        // not be reconstructed later. This contains syntax data only.
        if(s4){chargeState(state,{work:6,tuples:3},site);byteOwners.set(result,{state,asciiKeys,domain,
          source:Object.freeze({nodes:nodeCount-sourceNodes,text:(stringUnits-sourceText)*2,encoded:at+utf8-text.length-sourceByte,
            sortWork:sortWork-sourceWork,sortBytes:sortBytes-sourceSortBytes,byteStart:sourceByte,unitStart:sourceUnit,unitEnd:at,r3:r3&&asciiKeys})});}
        Object.setPrototypeOf(result,array?Array.prototype:Object.prototype);return Object.freeze(result);};
      const end=array?93:125;
      if(text.charCodeAt(at)===end){take();return finish();}
      let index=0,previous:string|undefined;
      for(;;){
        let key:string;
        if(array){chargeState(state,{work:1,bytes:32},site);key=String(index++);}
        else{
          node(depth+1);key=string(true);chargeState(state,{work:2,bytes:key.length*4},site);
          if(Object.hasOwn(result,key))return fail();
          if(canonical&&previous!==undefined&&!before(previous,key))spelling();
          fields++;maximumKey=Math.max(maximumKey,key.length);
          previous=key;space();if(take()!==58)return fail();
        }
        const capture=domain==='r3'&&!array&&depth===base&&key==='payload';
        const startUnit=at,startByte=at+utf8-text.length,startNodes=nodeCount,startText=stringUnits,startWork=sortWork,startSortBytes=sortBytes;
        let childRole:Role=array&&role==='selections'?'selection':'other';
        if(!array&&role==='root'&&(key==='selectedArtifacts'||key==='artifacts')){
          const root=result as Record<string,unknown>,graph=record(root.graph),observation=record(graph?.observation),roots=record(root.roots);
          chargeState(state,{work:8},site);
          if(key==='selectedArtifacts'&&root.contract==='m2-durable-validation/r2'&&roots?.kind==='m2-origin'
            ||key==='artifacts'&&root.contract==='m2-history-closure-input/r2'&&graph?.kind==='m2-observation'&&observation?.phase==='p1')childRole='selections';
        }
        const child=value(depth+1,childRole,!array&&role==='selection'&&key==='bytesHex'?result as Record<string,unknown>:undefined);
        if(capture&&child!==null&&typeof child==='object'){
          chargeState(state,{work:6,tuples:1},site);payload=child;
          payloadSource=Object.freeze({nodes:nodeCount-startNodes,text:(stringUnits-startText)*2,encoded:at+utf8-text.length-startByte,
            sortWork:sortWork-startWork,sortBytes:sortBytes-startSortBytes,byteStart:startByte,unitStart:startUnit,unitEnd:at,r3:false});
        }
        chargeState(state,{work:1},site);(result as Record<string,unknown>)[key]=child;
        space();const separator=take();if(separator===end)return finish();if(separator!==44)return fail();space();
      }
    }
    const start=at;while(at<text.length){const c=text.charCodeAt(at);if(c===32||c===9||c===10||c===13||c===44||c===125||c===93)break;take();}
    const token=text.slice(start,at);
    if(token==='true')return true;if(token==='false')return false;if(token==='null')return null;
    chargeState(state,{work:1,bytes:token.length*4},site);
    if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token))return fail();
    const number=Number(token);
    if(s4){
      if(!Number.isFinite(number))return fail();
      if(Object.is(number,-0)||Number.isInteger(number)&&!Number.isSafeInteger(number))spelling();
      if(!Number.isSafeInteger(number))r3=false;
    }else if(!exactInteger(token,false))return fail();
    if(canonical&&String(number)!==token)spelling();return number;
  };
  const result=value(base,'root');space();if(at!==text.length)return fail();flushUtf8();
  if(canonicalMismatch)throwP0(state,{code:'artifact_semantic_mismatch',rule:'PC1B-ART01',condition:'format-mismatch',site});
  if(result!==null&&typeof result==='object'){
    state.jsonHeights.set(result,maximumDepth-base);chargeState(state,{work:2,tuples:s4?1:canonical?3:2},site);
    if(!s4)byteOwners.set(result,{state,asciiKeys,domain,...canonical?{source:Object.freeze({nodes:nodeCount,text:stringUnits*2,encoded:utf8,sortWork,sortBytes,byteStart:0,unitStart:0,unitEnd:at,r3:r3&&asciiKeys})}:{}});
    if(payload!==undefined&&payloadSource!==undefined){chargeState(state,{work:1,tuples:3},site);byteOwners.set(payload,{state,asciiKeys,domain,source:Object.freeze({...payloadSource,r3:r3&&asciiKeys})});}
  }
  return result;
}

export function scanM2OwnedCanonical(state:P0State,text:string,site:P0Site):unknown{return owned(state,text,site,'r3');}
export function scanM2OwnedHistory(state:P0State,text:string,site:P0Site):unknown{return owned(state,text,site,'history');}
export function scanM2OwnedS4Canonical(state:P0State,text:string,site:P0Site):unknown{return owned(state,text,site,'s4');}
