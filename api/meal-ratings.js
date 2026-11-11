import * as handlers from '../functions/api/meal-ratings.js';
import { createVercelFunction } from '../vercel/adapter.js';

export default createVercelFunction(handlers, { route: '/api/meal-ratings' });
