import serverless from 'serverless-http';
import { createApp } from '../../server.mjs';

const app = createApp();

export const handler = serverless(app, {
  basePath: '/.netlify/functions/api'
});