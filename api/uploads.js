import * as handlers from '../functions/api/uploads.js';
import { createVercelFunction } from '../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/api/uploads' });
