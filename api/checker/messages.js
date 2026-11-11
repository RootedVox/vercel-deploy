import * as handlers from '../../functions/api/checker/messages.js';
import { createVercelFunction } from '../../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/api/checker/messages' });
