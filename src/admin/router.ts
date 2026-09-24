import { Router } from 'express';
import { credentialsRouter } from './credentials.routes.js';
import { deploymentsRouter } from './deployments.routes.js';
import { logsRouter } from './logs.routes.js';
import { apiKeysRouter } from './api-keys.routes.js';

export const adminRouter = Router();

adminRouter.use('/credentials', credentialsRouter);
adminRouter.use('/deployments', deploymentsRouter);
adminRouter.use('/logs', logsRouter);
adminRouter.use('/api-keys', apiKeysRouter);
