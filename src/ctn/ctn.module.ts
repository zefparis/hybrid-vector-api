import { Express } from 'express';
import ctnNetworkRouter from './routes/network.routes';
import ctnThreatRouter from './routes/threat.routes';
import ctnScoreRouter from './routes/score.routes';
import ctnWidgetRouter from './routes/widget.routes';

export function registerCtnModule(app: Express): void {
  app.use(ctnNetworkRouter);
  app.use(ctnThreatRouter);
  app.use(ctnScoreRouter);
  app.use(ctnWidgetRouter);
}
