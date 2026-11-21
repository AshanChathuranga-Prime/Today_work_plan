import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendWithSmtp } from './smtp.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REQUESTS_PER_WINDOW = 8;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'self'; script-src 'self'; connect-src 'self'");
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

function validateUpdate(body) {
  const update = {
    employeeName: clean(body.employeeName, 80, 'Name'),
    employeeId: clean(body.employeeId, 40, 'Employee ID'),
    workDate: clean(body.workDate, 10, 'Work date'),
    summary: clean(body.summary, 800, 'Summary'),
    accomplishments: clean(body.accomplishments, 1600, 'Accomplishments', false),
    blockers: clean(body.blockers, 1000, 'Blockers', false),
    nextSteps: clean(body.nextSteps, 1200, 'Tomorrow plan', false)
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(update.workDate) || Number.isNaN(Date.parse(`${update.workDate}T00:00:00Z`))) {
    throw new Error('Work date is invalid.');
  }
  return update;
}

function toEmailText(update) {
  return [
    `Daily work update — ${update.workDate}`,
    '',
    `Employee: ${update.employeeName}`,
    `Employee ID: ${update.employeeId}`,
    '',
    'Summary', update.summary,
    '',
    'Accomplishments', update.accomplishments || 'None provided.',
    '',
    'Blockers', update.blockers || 'None reported.',
    '',
    'Tomorrow plan', update.nextSteps || 'None provided.'
  ].join('\n');
}

function parseRecipients(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function createApp({ env = process.env, deliver = sendWithSmtp, now = () => Date.now() } = {}) {
  const rateLimits = new Map();

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

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { ready: Boolean(env.MAIL_FROM && env.MAIL_TO && env.RESEND_API_KEY && env.SUBMISSION_TOKEN) });
    }

    if (request.method === 'POST' && url.pathname === '/api/updates') {
      if (env.APP_ORIGIN && request.headers.origin !== env.APP_ORIGIN) return sendJson(response, 403, { error: 'Request origin was rejected.' });
      if (isRateLimited(request)) return sendJson(response, 429, { error: 'Too many requests. Try again later.' });
      try {
        const body = await readJson(request);
        if (!safeEqual(body.accessCode, env.SUBMISSION_TOKEN)) return sendJson(response, 401, { error: 'The access code is incorrect.' });
        const update = validateUpdate(body);
        if (!env.MAIL_FROM || !env.MAIL_TO || !env.SMTP_USER || !env.SMTP_APP_PASSWORD || !env.SUBMISSION_TOKEN) {
          throw new Error('Email delivery is not configured yet.');
        }
        await deliver({
          from: env.MAIL_FROM,
          to: parseRecipients(env.MAIL_TO),
          cc: parseRecipients(env.MAIL_CC),
          subject: `Daily work update — ${update.employeeName} — ${update.workDate}`,
          text: toEmailText(update)
        }, env);
        return sendJson(response, 202, { message: 'Your daily update was sent successfully.' });
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer(createApp()).listen(port, () => console.log(`Today Work Plan is running on http://localhost:${port}`));
}
