import * as handlers from '../functions/api/messages.js';
import { createVercelFunction } from '../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/api/messages' });
