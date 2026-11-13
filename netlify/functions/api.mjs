// Netlify Function: the whole Express API. netlify.toml rewrites /api/* here.
import serverless from 'serverless-http';
import { createApp } from '../../server/app.js';

const app = createApp();
export const handler = serverless(app, { binary: ['audio/*', 'image/*', 'application/octet-stream', 'multipart/form-data'] });
