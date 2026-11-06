import { startService } from './app';
import { configFromEnv } from './config';

async function main() {
  const app = await startService(configFromEnv());
  console.log(`Pane Cloud service listening on ${app.url}`);
  const shutdown = () => void app.close().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
