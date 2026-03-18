import express, { Express } from 'express';
import { config } from './config';
import { apiKeyMiddleware } from './middleware/apiKey';
import { errorHandler } from './middleware/errorHandler';
import healthRouter from './routes/health';
import sessionRouter from './routes/session';
import enrollRouter from './routes/enroll';

const app: Express = express();

app.use(express.json({ limit: '10mb' }));

app.use(healthRouter);

app.use(apiKeyMiddleware);
app.use(sessionRouter);
app.use(enrollRouter);

app.use(errorHandler);

const PORT = config.PORT;

app.listen(PORT, () => {
  console.log(`🚀 hv-api running on port ${PORT}`);
  console.log(`📍 Environment: ${config.NODE_ENV}`);
});

export default app;
