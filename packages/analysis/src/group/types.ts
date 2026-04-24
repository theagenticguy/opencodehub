/**
 * Shared types for the cross-repo contract extractor pipeline.
 *
 * A Contract is one observed producer or consumer endpoint in a single
 * file. A CrossLink pairs a producer with a consumer when their
 * signatures align. The ContractRegistry is the per-group persisted
 * snapshot written to `<home>/.codehub/groups/<name>/contracts.json`.
 */

export type ContractType =
  | "http_route"
  | "http_call"
  | "grpc_service"
  | "grpc_client"
  | "topic_producer"
  | "topic_consumer";

export type MatchReason = "signature" | "manifest" | "path";

export interface Contract {
  /** Kind of contract. */
  readonly type: ContractType;
  /**
   * Canonical signature used for exact-match correlation across repos.
   * Producers and consumers with equal (type family, signature) pair up.
   * Format is per-type-family:
   *   - http_*   : `METHOD <normalized-path>`
   *   - grpc_*   : `<package>.<service>/<rpc>` or `<package>.<service>` when rpc missing
   *   - topic_*  : `<queue-or-topic-name>`
   */
  readonly signature: string;
  /** Repo name (matches registry entry). */
  readonly repo: string;
  /** File path relative to the repo root. */
  readonly file: string;
  /** 1-based line number of the detected site. */
  readonly line: number;
}

export interface CrossLink {
  readonly producer: Contract;
  readonly consumer: Contract;
  /** How the pair was identified. */
  readonly matchReason: MatchReason;
}

export interface ContractRegistry {
  /** Registered repo names that participated in the sync. */
  readonly repos: readonly string[];
  readonly contracts: readonly Contract[];
  readonly crossLinks: readonly CrossLink[];
  /** ISO-8601 UTC timestamp the registry was computed. */
  readonly computedAt: string;
}
