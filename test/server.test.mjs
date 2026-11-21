import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../server.mjs';

const env = {
  MAIL_FROM: 'Personal Sender <person@example.com>',
  MAIL_TO: 'updates@company.example',
  MAIL_CC: 'team@company.example',
  SMTP_USER: 'person@example.com',
  SMTP_APP_PASSWORD: 'app-password',
  SUBMISSION_TOKEN: 'correct-horse-battery-staple',
  APP_ORIGIN: 'http://127.0.0.1'
};

async function request(app, { method = 'POST', url = '/api/updates', headers = {}, body } = {}) {
  const requestStream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(requestStream, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
  const response = { headers: {}, status: 0, body: '', setHeader(name, value) { this.headers[name] = value; }, writeHead(status, responseHeaders = {}) { this.status = status; Object.assign(this.headers, responseHeaders); }, end(value = '') { this.body += value; } };
  await app(requestStream, response);
  return response;
}

function validPayload(overrides = {}) {
  return { accessCode: env.SUBMISSION_TOKEN, employeeName: 'Asha Perera', employeeId: 'P-102', workDate: '2026-11-21', summary: 'Finished the daily report.', accomplishments: '', blockers: '', nextSteps: '', ...overrides };
}

test('sends a valid update without storing its content', async () => {
  const sent = [];
  const app = createApp({ env, deliver: async (message) => { sent.push(message); } });
  const response = await request(app, { headers: { origin: env.APP_ORIGIN }, body: validPayload() });
  assert.equal(response.status, 202);
  assert.equal(JSON.parse(response.body).message, 'Your daily update was sent successfully.');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, env.MAIL_FROM);
  assert.deepEqual(sent[0].to, [env.MAIL_TO]);
  assert.deepEqual(sent[0].cc, [env.MAIL_CC]);
});

test('rejects missing or incorrect access codes', async () => {
  const app = createApp({ env, deliver: async () => {} });
  const response = await request(app, { headers: { origin: env.APP_ORIGIN }, body: validPayload({ accessCode: 'wrong' }) });
  assert.equal(response.status, 401);
});

test('rejects requests from another origin', async () => {
  const app = createApp({ env, deliver: async () => {} });
  const response = await request(app, { headers: { origin: 'https://attacker.example' }, body: validPayload() });
  assert.equal(response.status, 403);
});
