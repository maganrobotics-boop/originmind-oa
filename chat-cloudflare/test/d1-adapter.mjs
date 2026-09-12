import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class D1PreparedAdapter {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1PreparedAdapter(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.values),
      success: true,
    };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

export class D1DatabaseAdapter {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    const migration = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
    this.sqlite.exec(migration);
  }

  prepare(sql) {
    return new D1PreparedAdapter(this.sqlite, sql);
  }

  close() {
    this.sqlite.close();
  }
}
