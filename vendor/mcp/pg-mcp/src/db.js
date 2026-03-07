import pg from "pg";

const { Pool } = pg;

function normalizeTimeout(value, fallback = 10000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export class DbManager {
  constructor(config) {
    this.config = config;
    this.pools = new Map();
  }

  getConnectionNames() {
    return Object.keys(this.config.connections);
  }

  getConnectionConfig(name) {
    const cfg = this.config.connections[name];
    if (!cfg) {
      const available = this.getConnectionNames().join(", ");
      throw new Error(`Baglanti bulunamadi: '${name}'. Mevcut baglantilar: ${available}`);
    }
    return cfg;
  }

  getPool(name, databaseOverride = null) {
    const connection = this.getConnectionConfig(name);
    const database = databaseOverride || connection.database;
    const poolKey = `${name}::${database}`;

    if (!this.pools.has(poolKey)) {
      const c = this.getConnectionConfig(name);
      this.pools.set(
        poolKey,
        new Pool({
          host: c.host,
          port: c.port,
          user: c.user,
          password: c.password,
          database,
          ssl: c.ssl ? { rejectUnauthorized: false } : false,
          max: 5,
        })
      );
    }

    return this.pools.get(poolKey);
  }

  async runReadOnly(connectionName, sql, params = [], options = {}) {
    const connection = this.getConnectionConfig(connectionName);
    const statementTimeout = normalizeTimeout(connection.statement_timeout_ms);
    const database = options.database || null;

    const client = await this.getPool(connectionName, database).connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${statementTimeout}`);
      const result = await client.query(sql, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ROLLBACK hatasi olursa asil hatayi koruyoruz.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async closeAll() {
    const tasks = [];
    for (const pool of this.pools.values()) {
      tasks.push(pool.end());
    }
    await Promise.all(tasks);
  }
}
