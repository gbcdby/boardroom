export const at:string;
export function logicalReason(input:string):string;
export function fixture(input?:string,suffix?:string): { reason:string; slot:{projectId:string;taskId:string;roundId:string}; ids:Record<string,string>;values:Record<string,unknown>;raw:Record<string,string>;command:any;request:any;rows:Record<string,Record<string,any>[]>;task:any };
export function parentRows(f:ReturnType<typeof fixture>):Record<string,Record<string,any>[]>;
export function storageFixture(input?:string,suffix?:string):ReturnType<typeof fixture>&{graph:Record<string,Record<string,any>[]>};
