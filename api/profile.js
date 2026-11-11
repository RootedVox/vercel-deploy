import * as handlers from '../functions/api/profile.js';
import { createVercelFunction } from '../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/api/profile' });
