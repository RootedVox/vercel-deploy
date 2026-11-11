import * as handlers from '../../functions/auth/session.js';
import { createVercelFunction } from '../../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/auth/session' });
