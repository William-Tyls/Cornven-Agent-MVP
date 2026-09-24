import { createApp } from './app.js';
import { createReportRuntime } from './modules/reporting/report-runtime.js';
const port = Number(process.env.API_PORT ?? 3119);
const reports = createReportRuntime();
const app = createApp(reports);
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Cornven API: http://127.0.0.1:${port}`),
);
const stopScheduler = reports.scheduler.start();
const stopDelivery = reports.delivery.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopScheduler();
    stopDelivery();
    server.close(() => {
      void reports.repository.db.$disconnect().finally(() => process.exit(0));
    });
  });
