export class StorageInvalid extends Error {
  readonly code = 'decision_storage_invalid';
  readonly column: string;
  readonly stage: string;
  constructor(column:string, stage:string) {
    super(`decision_storage_invalid:${column}:${stage}`);
    this.column=column; this.stage=stage;
  }
}
