import * as handlers from '../../functions/auth/callback.js';
import { createVercelFunction } from '../../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/auth/callback' });
