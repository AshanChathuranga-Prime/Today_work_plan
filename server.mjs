import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { sendWithSmtp } from './smtp.mjs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse
} from '@simplewebauthn/server';

const root = process.cwd();
const publicDir = join(root, 'public');
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REQUESTS_PER_WINDOW = 8;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_SENDER_NAME = 'Ashan Chathuranga';
const AUTH_COOKIE = 'twp_session';

async function authStore() {
  if (process.env.NETLIFY) {
    const { getStore } = await import('@netlify/blobs');
    const blobs = getStore('today-work-plan-auth');
    return { async get(key) { return await blobs.get(key, { type: 'json' }); }, async set(key, value) { if (value === null) return blobs.delete(key); return blobs.setJSON(key, value); } };
  }
  const { readFile, writeFile } = await import('node:fs/promises');
  const path = join(root, '.local-auth-store.json');
  return { async get(key) { try { const data = JSON.parse(await readFile(path, 'utf8')); return data[key] ?? null; } catch { return null; } }, async set(key, value) { let data = {}; try { data = JSON.parse(await readFile(path, 'utf8')); } catch {} if (value === null) delete data[key]; else data[key] = value; await writeFile(path, JSON.stringify(data), { mode: 0o600 }); } };
}

function cookieValue(header, name) { return String(header || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || ''; }
function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function validSession(request, secret) { const token = cookieValue(request.headers.cookie, AUTH_COOKIE); const [id, signature] = token.split('.'); if (!id || !signature) return false; const expected = sign(id, secret); const a = Buffer.from(signature); const b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'self'; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'");
}

async function readJson(request) {
  const parts = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Payload is too large.');
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new Error('Invalid request data.');
  }
}

function clean(value, maximum, field, required = true) {
  if (typeof value !== 'string') throw new Error(`${field} is required.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required.`);
  if (result.length > maximum) throw new Error(`${field} is too long.`);
  return result;
}

function displayDate(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

export function createEmailMessage(body, { date = new Date(), senderName = DEFAULT_SENDER_NAME } = {}) {
  const topic = clean(body.topic, 120, 'Topic');
  const content = clean(body.content, 6_000, 'Task list');
  const name = clean(senderName || DEFAULT_SENDER_NAME, 100, 'Sender name');
  const isMorning = body.reportType === 'morning';
  const isEndOfDay = body.reportType === 'end_of_day';
  if (!isMorning && !isEndOfDay) throw new Error('Choose a valid update type.');
  const subjectPrefix = isMorning ? 'Morning Plan' : 'Daily Task Log Summary';
  const heading = isMorning ? `Morning Plan - ${topic}` : `Daily Task Log Summary - ${topic}`;
  const introduction = isMorning
    ? `Today, I plan to focus on ${topic}. The planned tasks are:`
    : `Today, I focused on ${topic}. The key tasks completed are:`;
  const tasks = content.split(/\r?\n/)
    .map((task) => task.trim().replace(/^\d+[.)]\s*|^[-•]\s*/, ''))
    .filter(Boolean)
    .map((task, index) => `${index + 1}. ${task}`)
    .join('\n');
  return {
    subject: `${subjectPrefix} – ${topic} – ${displayDate(date)}`,
    text: [
      'Dear Sir/Madam,',
      '',
      `Date : ${displayDate(date)}`,
      '',
      heading,
      '',
      introduction,
      '',
      tasks,
      '',
      'Best regards,',
      name
    ].join('\n')
  };
}

function validateEditedEmail(body) {
  return {
    subject: clean(body.subject, 220, 'Email subject'),
    text: clean(body.text, 8_000, 'Email body')
  };
}

function parseRecipients(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function createApp({ env = process.env, deliver = sendWithSmtp, now = () => Date.now(), currentDate = () => new Date(), store: suppliedStore } = {}) {
  const rateLimits = new Map();
  const authEnabled = Boolean(env.AUTH_SETUP_SECRET && env.SESSION_SECRET);
  let storePromise;
  const store = () => storePromise ||= Promise.resolve(suppliedStore || authStore());
  const rpId = (() => { try { return new URL(env.APP_ORIGIN).hostname; } catch { return 'localhost'; } })();
  const expectedOrigin = env.APP_ORIGIN || `http://${rpId}`;

  function isRateLimited(request) {
    const ip = (request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const present = rateLimits.get(ip);
    const time = now();
    const window = !present || time - present.startedAt > RATE_WINDOW_MS ? { startedAt: time, count: 0 } : present;
    window.count += 1;
    rateLimits.set(ip, window);
    return window.count > MAX_REQUESTS_PER_WINDOW;
  }

  return async function app(request, response) {
    securityHeaders(response);
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/auth/')) {
      if (!authEnabled) return sendJson(response, 503, { error: 'Authentication is not configured. Set AUTH_SETUP_SECRET and SESSION_SECRET.' });
      try {
        const db = await store();
        const credentials = await db.get('credentials') || [];
        if (request.method === 'GET' && url.pathname === '/api/auth/status') return sendJson(response, 200, { enrolled: credentials.length > 0, authenticated: validSession(request, env.SESSION_SECRET) });
        if (request.method === 'POST' && url.pathname === '/api/auth/register/options') {
          if (credentials.length) return sendJson(response, 403, { error: 'Registration is closed. This app already has an owner.' });
          const body = await readJson(request);
          if (body.setupSecret !== env.AUTH_SETUP_SECRET) return sendJson(response, 403, { error: 'Invalid setup key.' });
          const options = await generateRegistrationOptions({ rpName: 'Today Work Plan', rpID: rpId, userName: 'owner', userDisplayName: 'Today Work Plan Owner', attestationType: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } });
          await db.set('registration', { challenge: options.challenge, setupVerified: true });
          return sendJson(response, 200, options);
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/register/verify') {
          const body = await readJson(request); const pending = await db.get('registration');
          if (credentials.length || !pending?.setupVerified) return sendJson(response, 403, { error: 'Registration is not available.' });
          const result = await verifyRegistrationResponse({ response: body, expectedChallenge: pending.challenge, expectedOrigin, expectedRPID: rpId, requireUserVerification: true });
          if (!result.verified || !result.registrationInfo) return sendJson(response, 400, { error: 'Fingerprint/passkey verification failed.' });
          const info = result.registrationInfo;
          await db.set('credentials', [{ id: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString('base64url'), counter: info.credential.counter, transports: body.response?.transports || [] }]);
          await db.set('registration', null);
          const sessionId = randomBytes(32).toString('base64url');
          response.setHeader('Set-Cookie', `${AUTH_COOKIE}=${sessionId}.${sign(sessionId, env.SESSION_SECRET)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
          return sendJson(response, 200, { verified: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/login/options') {
          if (!credentials.length) return sendJson(response, 409, { error: 'Complete the one-time owner setup first.' });
          const options = await generateAuthenticationOptions({ rpID: rpId, allowCredentials: credentials.map(c => ({ id: c.id, transports: c.transports })), userVerification: 'required' });
          await db.set('loginChallenge', options.challenge); return sendJson(response, 200, options);
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/login/verify') {
          const body = await readJson(request); const challenge = await db.get('loginChallenge');
          const credential = credentials.find(c => c.id === body.id);
          if (!credential || !challenge) return sendJson(response, 401, { error: 'Login challenge expired. Try again.' });
          const result = await verifyAuthenticationResponse({ response: body, expectedChallenge: challenge, expectedOrigin, expectedRPID: rpId, credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'), counter: credential.counter, transports: credential.transports }, requireUserVerification: true });
          if (!result.verified) return sendJson(response, 401, { error: 'Fingerprint verification failed.' });
          credential.counter = result.authenticationInfo.newCounter; await db.set('credentials', credentials); await db.set('loginChallenge', null);
          const sessionId = randomBytes(32).toString('base64url');
          response.setHeader('Set-Cookie', `${AUTH_COOKIE}=${sessionId}.${sign(sessionId, env.SESSION_SECRET)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
          return sendJson(response, 200, { verified: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/logout') { response.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`); return sendJson(response, 200, { loggedOut: true }); }
        return sendJson(response, 404, { error: 'Not found.' });
      } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : 'Authentication failed.' }); }
    }
    if (authEnabled && url.pathname.startsWith('/api/') && !validSession(request, env.SESSION_SECRET)) return sendJson(response, 401, { error: 'Please unlock the app with Windows Hello first.' });

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { ready: Boolean(env.MAIL_FROM && env.MAIL_TO && env.SMTP_USER && env.SMTP_APP_PASSWORD) });
    }

    if (request.method === 'POST' && (url.pathname === '/api/preview' || url.pathname === '/api/send')) {
      if (env.APP_ORIGIN && request.headers.origin !== env.APP_ORIGIN) return sendJson(response, 403, { error: 'Request origin was rejected.' });
      try {
        const body = await readJson(request);
        if (url.pathname === '/api/preview') {
          const email = createEmailMessage(body, { date: currentDate(), senderName: env.SENDER_NAME || DEFAULT_SENDER_NAME });
          return sendJson(response, 200, email);
        }
        if (isRateLimited(request)) return sendJson(response, 429, { error: 'Too many requests. Try again later.' });
        if (!env.MAIL_FROM || !env.MAIL_TO || !env.SMTP_USER || !env.SMTP_APP_PASSWORD) {
          throw new Error('Email delivery is not configured yet.');
        }
        const email = validateEditedEmail(body);
        await deliver({
          from: env.MAIL_FROM,
          to: parseRecipients(env.MAIL_TO),
          cc: parseRecipients(env.MAIL_CC),
          subject: email.subject,
          text: email.text
        }, env);
        return sendJson(response, 202, { message: 'Your email was sent successfully.' });
      } catch (error) {
        return sendJson(response, 400, { error: error instanceof Error ? error.message : 'Unable to submit the update.' });
      }
    }

    if (request.method === 'GET') {
      const fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const target = normalize(join(publicDir, fileName));
      if (!target.startsWith(`${publicDir}${process.platform === 'win32' ? '\\' : '/'}`) && target !== join(publicDir, 'index.html')) {
        response.writeHead(404); return response.end();
      }
      try {
        const file = await readFile(target);
        response.writeHead(200, { 'Content-Type': contentTypes[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return response.end(file);
      } catch {
        response.writeHead(404); return response.end();
      }
    }
    response.writeHead(405, { Allow: 'GET, POST' });
    response.end();
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('server.mjs')) {
  const port = Number(process.env.PORT || 3000);
  createServer(createApp()).listen(port, () => console.log(`Today Work Plan is running on http://localhost:${port}`));
}
