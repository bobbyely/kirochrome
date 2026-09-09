import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ProviderCheckResult } from "@kirochrome/shared";
import { dataDir, dbPath } from "./paths.js";

/**
 * SQLite is built into Node 22 (`node:sqlite`) — no native module, no build
 * toolchain, identical on macOS and Linux. See docs/DESIGN.md.
 *
 * The `events` table arrives in phase 3; phase 1 only needs check results.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path = dbPath()) {
    mkdirSync(dataDir(), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS provider_checks (
        provider_id TEXT PRIMARY KEY,
        status      TEXT NOT NULL,
        stage       TEXT,
        error_code  TEXT,
        result      TEXT NOT NULL,
        checked_at  INTEGER NOT NULL
      );
    `);
    // The database holds work conversations and source code. Keep it private.
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort; some filesystems (and Windows) will not have it.
    }
  }

  saveCheck(result: ProviderCheckResult): void {
    this.db
      .prepare(
        `INSERT INTO provider_checks (provider_id, status, stage, error_code, result, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           status = excluded.status, stage = excluded.stage,
           error_code = excluded.error_code, result = excluded.result,
           checked_at = excluded.checked_at`,
      )
      .run(
        result.providerId,
        result.status,
        result.stage,
        result.error?.code ?? null,
        JSON.stringify(result),
        result.checkedAt,
      );
  }

  lastCheck(providerId: string): ProviderCheckResult | null {
    const row = this.db
      .prepare(`SELECT result FROM provider_checks WHERE provider_id = ?`)
      .get(providerId) as { result?: string } | undefined;
    return row?.result ? (JSON.parse(row.result) as ProviderCheckResult) : null;
  }

  /**
   * Marks a provider as needing a re-check — used when a runtime failure
   * contradicts an earlier pass. Verified is a cached fact, not a guarantee.
   */
  markStale(providerId: string): void {
    this.db
      .prepare(`UPDATE provider_checks SET status = 'stale' WHERE provider_id = ?`)
      .run(providerId);
  }

  close(): void {
    this.db.close();
  }
}
