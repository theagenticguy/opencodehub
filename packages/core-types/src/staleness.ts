export interface StalenessEnvelope {
  readonly isStale: boolean;
  readonly commitsBehind: number;
  readonly hint?: string;
  readonly lastIndexedCommit?: string;
  readonly currentCommit?: string;
}
