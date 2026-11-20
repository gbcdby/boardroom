import manifest from "./module-manifest.json" with { type: "json" };
import dependencies from "./direct-dependencies.json" with { type: "json" };
import { fixedSql } from "./fixed-sql.ts";

type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

/** Reviewed source data only. Importing it does not install functions or qualify a server. */
export const PG_CATALOG_GUARD_MODULE = freeze(manifest);
export const PG_CATALOG_GUARD_DEPENDENCIES = freeze(dependencies);
export const PG_CATALOG_GUARD_SQL = freeze(fixedSql);

/** Byte identities of the accepted, unchanged source manifests (including their historical labels). */
export const PG_CATALOG_GUARD_SOURCE_DIGESTS = Object.freeze({
  module: "39e2c146e65016d037ff83223b982513f0e327ea0efc15b752c3aa82049eba57",
  dependencies: "f33dcfd51e268b7228a85a430650e755a459f67c626180f5f455bd4db5bf0935",
});
