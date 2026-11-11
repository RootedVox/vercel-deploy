import * as handlers from '../../functions/auth/logout.js';
import { createVercelFunction } from '../../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/auth/logout' });
