import { fromDrizzle, type Db, type DrizzleTransactionLike } from "pg-boss";

import { sql } from "@startup/db";

/**
 * The `db` option that makes a pg-boss call part of a Drizzle transaction: the
 * job is saved, or rolled back, together with everything else in it.
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await tx.insert(...);
 *   await queue.send(name, data, { db: inTransaction(tx) });
 * });
 * ```
 */
export function inTransaction(tx: DrizzleTransactionLike): Db {
  return fromDrizzle(tx, sql);
}
