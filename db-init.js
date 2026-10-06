// Loads schema.sql into DATABASE_URL, creating the database first if it doesn't exist.
// Replaces `psql -f schema.sql` so it works on machines without psql on PATH.
import pg from 'pg';
import fs from 'node:fs';

// Locally, no .env means the docker-compose database: user "postgres" with the throwaway
// password from docker-compose.yml, on host port 5433. Not used on Vercel.
const localDatabaseUrl = () => {
  const u = new URL('postgres://localhost:5433/tablekeeper');
  u.username = 'postgres';
  u.password = 'tk';
  return u.href;
};
const url = new URL(process.env.DATABASE_URL || localDatabaseUrl());
const dbName = decodeURIComponent(url.pathname.slice(1));

const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).href });
await admin.connect();
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (!rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
await admin.end();

const db = new pg.Client({ connectionString: url.href });
await db.connect();
await db.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const { rows } = await db.query('SELECT count(*)::int AS n FROM restaurants');
await db.end();
console.log(`Loaded schema into ${dbName} on ${url.host} (${rows[0].n} restaurants).`);
