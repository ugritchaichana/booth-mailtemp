import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

function positional(sql, args) {
  const order = [];
  const flat = sql.replace(/\?(\d+)/g, (_, n) => {
    order.push(args[Number(n) - 1]);
    return "?";
  });
  return order.length ? [flat, order] : [sql, args];
}

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    [this.sql, this.args] = positional(sql, args);
    this.source = sql;
  }

  bind(...args) {
    return new Statement(this.db, this.source, args);
  }

  run() {
    const { changes } = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(changes) }, results: [] };
  }

  all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.args), meta: {} };
  }

  first(column) {
    const row = this.db.prepare(this.sql).get(...this.args) ?? null;
    return row && column ? row[column] : row;
  }
}

export function openD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of fs.readdirSync(MIGRATIONS).sort()) db.exec(fs.readFileSync(new URL(file, MIGRATIONS), "utf8"));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.run());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
