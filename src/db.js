const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');

require('dotenv').config();

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const schemaPath = path.join(__dirname, 'schema.sql');
let pool;

function getConnectConfig() {
  return {
    user: process.env.ORACLE_USER || 'system',
    password: process.env.ORACLE_PASSWORD || 'oracle',
    connectString: process.env.ORACLE_CONNECT_STRING || 'localhost/XEPDB1',
    poolMin: Number(process.env.ORACLE_POOL_MIN || 1),
    poolMax: Number(process.env.ORACLE_POOL_MAX || 5),
    poolIncrement: Number(process.env.ORACLE_POOL_INCREMENT || 1)
  };
}

async function getPool() {
  if (pool) return pool;
  pool = await oracledb.createPool(getConnectConfig());
  return pool;
}

async function runSchema() {
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const statements = schemaSql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      await execute(statement, {}, { autoCommit: true });
    } catch (error) {
      if (error.errorNum !== 955) {
        throw error;
      }
    }
  }
}

async function initDatabase() {
  await getPool();
  await runSchema();
}

async function query(sql, binds = {}, options = {}) {
  const activePool = await getPool();
  const connection = await activePool.getConnection();
  try {
    const result = await connection.execute(sql, binds, { autoCommit: false, ...options });
    return result.rows || [];
  } finally {
    await connection.close();
  }
}

async function execute(sql, binds = {}, options = {}) {
  const activePool = await getPool();
  const connection = await activePool.getConnection();
  try {
    return await connection.execute(sql, binds, { autoCommit: true, ...options });
  } finally {
    await connection.close();
  }
}

async function insert(table, fields, values, idColumn, tx) {
  const placeholders = [];
  const binds = {};

  fields.forEach((field, index) => {
    const key = `v${index + 1}`;
    placeholders.push(`:${key}`);
    binds[key] = values[index];
  });

  const cols = fields.join(', ');
  const vals = placeholders.join(', ');

  if (idColumn) {
    binds.out_id = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };
    const sql = `INSERT INTO ${table} (${cols}) VALUES (${vals}) RETURNING ${idColumn} INTO :out_id`;
    const result = tx
      ? await tx.execute(sql, binds)
      : await execute(sql, binds, { autoCommit: true });
    return result.outBinds.out_id[0];
  }

  const sql = `INSERT INTO ${table} (${cols}) VALUES (${vals})`;
  if (tx) {
    await tx.execute(sql, binds);
    return null;
  }
  await execute(sql, binds, { autoCommit: true });
  return null;
}

async function withTransaction(work) {
  const activePool = await getPool();
  const connection = await activePool.getConnection();

  const tx = {
    query: async (sql, binds = {}, options = {}) => {
      const result = await connection.execute(sql, binds, { autoCommit: false, ...options });
      return result.rows || [];
    },
    execute: async (sql, binds = {}, options = {}) =>
      connection.execute(sql, binds, { autoCommit: false, ...options }),
    insert: async (table, fields, values, idColumn) => insert(table, fields, values, idColumn, tx)
  };

  try {
    const result = await work(tx);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.close();
  }
}

async function closePool() {
  if (!pool) return;
  await pool.close(0);
  pool = null;
}

module.exports = {
  initDatabase,
  query,
  execute,
  insert,
  withTransaction,
  closePool
};
