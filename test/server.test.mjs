import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../server.mjs';

const env = {
  MAIL_FROM: 'person@example.com',
  MAIL_TO: 'updates@company.example',
  MAIL_CC: 'team@company.example',
  SMTP_USER: 'person@example.com',
  SMTP_APP_PASSWORD: 'app-password',
  APP_ORIGIN: 'http://127.0.0.1'
};

async function request(app, { method = 'POST', url = '/api/preview', headers = {}, body } = {}) {
  const requestStream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(requestStream, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
  const response = { headers: {}, status: 0, body: '', setHeader(name, value) { this.headers[name] = value; }, writeHead(status, responseHeaders = {}) { this.status = status; Object.assign(this.headers, responseHeaders); }, end(value = '') { this.body += value; } };
  await app(requestStream, response);
  return response;
}

function validPayload(overrides = {}) {
  return { reportType: 'morning', topic: 'Backend API Development', content: 'Complete the assigned backend API development.\nWork on frontend integration.\nTest the application functionalities.', ...overrides };
}

test('generates a morning preview without sending an email', async () => {
  const sent = [];
  const app = createApp({ env, currentDate: () => new Date('2026-11-21T00:00:00Z'), deliver: async (message) => { sent.push(message); } });
  const response = await request(app, { headers: { origin: env.APP_ORIGIN }, body: validPayload() });
  const preview = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 0);
  assert.equal(preview.subject, 'Morning Plan – Backend API Development – 21/11/2026');
  assert.match(preview.text, /Morning Plan - Backend API Development/);
  assert.match(preview.text, /Today, I plan to focus on Backend API Development/);
  assert.match(preview.text, /1\. Complete the assigned backend API development\./);
  assert.match(preview.text, /Best regards,\nAshan Chathuranga/);
});

test('generates an end-of-day preview without sending an email', async () => {
  const sent = [];
  const app = createApp({ env, currentDate: () => new Date('2026-11-21T00:00:00Z'), deliver: async (message) => { sent.push(message); } });
  const response = await request(app, { headers: { origin: env.APP_ORIGIN }, body: validPayload({ reportType: 'end_of_day', content: 'Completed backend API development.\nIntegrated frontend components.' }) });
  const preview = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 0);
  assert.equal(preview.subject, 'Daily Task Log Summary – Backend API Development – 21/11/2026');
  assert.match(preview.text, /Daily Task Log Summary - Backend API Development/);
  assert.match(preview.text, /Today, I focused on Backend API Development/);
  assert.match(preview.text, /1\. Completed backend API development\./);
  assert.match(preview.text, /2\. Integrated frontend components\./);
});

test('sends only the edited preview after the final send action', async () => {
  const sent = [];
  const app = createApp({ env, deliver: async (message) => { sent.push(message); } });
  const response = await request(app, { url: '/api/send', headers: { origin: env.APP_ORIGIN }, body: { subject: 'Edited subject', text: 'Edited email body' } });
  assert.equal(response.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Edited subject');
  assert.equal(sent[0].text, 'Edited email body');
  assert.equal(sent[0].from, env.MAIL_FROM);
  assert.deepEqual(sent[0].to, [env.MAIL_TO]);
  assert.deepEqual(sent[0].cc, [env.MAIL_CC]);
});

test('uses the default sender name when no environment value is configured', async () => {
  const sent = [];
  const app = createApp({ env: { ...env, SENDER_NAME: '' }, currentDate: () => new Date('2026-11-21T00:00:00Z'), deliver: async (message) => { sent.push(message); } });
  const previewResponse = await request(app, { headers: { origin: env.APP_ORIGIN }, body: validPayload() });
  assert.equal(previewResponse.status, 200);
  assert.match(JSON.parse(previewResponse.body).text, /Best regards,\nAshan Chathuranga/);
  const sendResponse = await request(app, { url: '/api/send', headers: { origin: env.APP_ORIGIN }, body: { subject: 'Edited subject', text: 'Edited email body' } });
  assert.equal(sendResponse.status, 202);
  assert.equal(sent.length, 1);
});

test('rejects an empty topic or task list', async () => {
  const app = createApp({ env, deliver: async () => {} });
  const response = await request(app, { headers: { origin: env.APP_ORIGIN }, body: validPayload({ topic: '' }) });
  assert.equal(response.status, 400);
});

test('rejects requests from another origin', async () => {
  const app = createApp({ env, deliver: async () => {} });
  const response = await request(app, { headers: { origin: 'https://attacker.example' }, body: validPayload() });
  assert.equal(response.status, 403);
});
