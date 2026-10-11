import { buildApp } from './app';
import { loadConfig } from './config';
import { createServices } from './services';

const config = loadConfig();
const services = createServices(config);
const app = await buildApp(services, { logger: true });
services.start();

const shutdown = async () => {
  services.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
const clock = services.clock.info();
app.log.info(`Q26 Options API on :${config.port} — clock ${clock.mode} ${clock.date} ${clock.time} (speed ${clock.speed}x)`);
