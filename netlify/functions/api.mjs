import serverless from 'serverless-http';
import { connectLambda } from '@netlify/blobs';
import { createApp } from '../../server.mjs';

const app = createApp();
const serverlessHandler = serverless(app, {
  basePath: '/.netlify/functions/api'
});

export const handler = async (event, context) => {
  connectLambda(event);
  return serverlessHandler(event, context);
};
