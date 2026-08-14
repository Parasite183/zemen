import { initDb, db } from './db.js';
import { initSchema } from './schema.js';
import { buildApp } from './app.js';
import { config } from './config.js';

async function main() {
  initDb();
  await initSchema();

  const app = buildApp();
  const server = app.listen(config.port, () => {
    console.log(`\n  ዘመን Zemen API running on http://localhost:${config.port}`);
    console.log(`  Storage: ${config.databaseUrl ? 'PostgreSQL' : `SQLite (${config.dbFile})`}`);
    console.log(`  Dev mode: ${config.devMode ? 'on (OTP peek endpoint enabled)' : 'off'}\n`);
  });

  const shutdown = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start Zemen:', err);
  process.exit(1);
});
