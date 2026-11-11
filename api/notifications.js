import * as handlers from '../functions/api/notifications.js';
import { createVercelFunction } from '../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/api/notifications' });
