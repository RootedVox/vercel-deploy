import * as handlers from '../../functions/auth/login.js';
import { createVercelFunction } from '../../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/auth/login' });
