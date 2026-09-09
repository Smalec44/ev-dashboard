/**
 * Minimal Flyway-equivalent: applies db/migrations/V*.sql in version order,
 * each in its own transaction, recording checksums so an edited-after-apply
 * migration is caught rather than silently ignored.
 *
 * Run: npm run db:migrate
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../db/migrations");

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://ev:ev@localhost:5432/ev_dashboard";

const FILENAME = /^V(\d+)__(.+)\.sql$/;

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .map((file) => {
      const match = FILENAME.exec(file);
      if (!match) return null;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return {
        version: Number(match[1]),
        name: match[2].replace(/_/g, " "),
        file,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

async function main() {
  const migrations = loadMigrations();
  if (migrations.length === 0) {
    console.log("No migrations found.");
    return;
  }

  const client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await client.query(
    "SELECT version, name, checksum FROM schema_migration",
  );
  const byVersion = new Map(applied.map((r) => [r.version, r]));

  for (const migration of migrations) {
    const previous = byVersion.get(migration.version);

    if (previous) {
      if (previous.checksum !== migration.checksum) {
        throw new Error(
          `V${migration.version} was modified after being applied. ` +
            `Add a new migration instead of editing ${migration.file}.`,
        );
      }
      console.log(`  = V${migration.version} ${migration.name} (already applied)`);
      continue;
    }

    process.stdout.write(`  + V${migration.version} ${migration.name} … `);
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migration (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.checksum],
      );
      await client.query("COMMIT");
      console.log("ok");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`V${migration.version} failed: ${error.message}`);
    }
  }

  const { rows } = await client.query(
    "SELECT count(*)::int AS n FROM schema_migration",
  );
  console.log(`\nSchema at ${rows[0].n} migration(s).`);
  await client.end();
}

main().catch((error) => {
  console.error("\nMigration failed:", error.message);
  process.exit(1);
});
