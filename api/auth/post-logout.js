import * as handlers from '../../functions/auth/post-logout.js';
import { createVercelFunction } from '../../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/auth/post-logout' });
