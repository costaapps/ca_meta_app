import type { DataSource } from 'typeorm';
import { destinationKeyHash, validateProjectionTarget } from './legacy-projection.mapper.js';
import type { LegacyProjectionDestination, LegacyProjectionDestinationCatalog, LegacyProjectionTargetKey } from './legacy-projection.types.js';
import { MysqlLegacyProjectionDestination } from './mysql-legacy-projection.destination.js';

export interface LegacyProjectionCatalogEntry {
  readonly target: LegacyProjectionTargetKey;
  /** Preconstructed server-owned connection. This API accepts no request-supplied hostname, database or credentials. */
  readonly dataSource: DataSource;
}

/** Exact database+company+environment allowlist. Callers cannot select a connection by passing a DSN. */
export class AllowlistedLegacyProjectionCatalog implements LegacyProjectionDestinationCatalog {
  private readonly destinations = new Map<string, LegacyProjectionDestination>();

  constructor(entries: readonly LegacyProjectionCatalogEntry[]) {
    for (const entry of entries) {
      validateProjectionTarget(entry.target);
      const key = destinationKeyHash(entry.target);
      if (this.destinations.has(key)) throw new Error('Legacy projection catalog contains a duplicate destination key.');
      this.destinations.set(key, new MysqlLegacyProjectionDestination(entry.target, entry.dataSource));
    }
  }

  resolve(target: LegacyProjectionTargetKey): LegacyProjectionDestination | undefined {
    validateProjectionTarget(target);
    return this.destinations.get(destinationKeyHash(target));
  }
}
