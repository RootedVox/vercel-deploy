import * as handlers from '../functions/api/moderation-worker.js';
import { createVercelFunction } from '../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/api/moderation-worker' });
