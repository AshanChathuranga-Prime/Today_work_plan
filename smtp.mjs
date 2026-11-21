import tls from 'node:tls';

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(value)}?=`;
}

function assertAddress(value, name) {
  if (typeof value !== 'string' || /[\r\n]/.test(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new Error(`${name} is not a valid email address.`);
  }
  return value.trim();
}

function makeConnection({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP connection timed out.'));
    }, 12_000);
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function session(socket) {
  let buffer = '';
  let responseLines = [];
  let waiter;
  let failure;

  function settleError(error) {
    failure = error;
    if (waiter) {
      waiter.reject(error);
      waiter = undefined;
    }
  }

  socket.on('error', settleError);
  socket.on('close', () => settleError(new Error('SMTP connection closed unexpectedly.')));
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let boundary;
    while ((boundary = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      responseLines.push(line);
      if (/^\d{3} /.test(line) && waiter) {
        const current = responseLines;
        responseLines = [];
        const active = waiter;
        waiter = undefined;
        active.resolve(current);
      }
    }
  });

  function receive() {
    if (failure) return Promise.reject(failure);
    if (waiter) return Promise.reject(new Error('SMTP protocol error.'));
    return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  }

  async function command(text, accepted) {
    const response = receive();
    socket.write(`${text}\r\n`);
    const lines = await response;
    const code = Number(lines.at(-1).slice(0, 3));
    if (!accepted.includes(code)) throw new Error(`SMTP rejected the message (${code}).`);
  }

  return { receive, command };
}

export async function sendWithSmtp(message, env) {
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(env.SMTP_PORT || 465);
  const from = assertAddress(message.from, 'Sender');
  const to = message.to.map((address) => assertAddress(address, 'Recipient'));
  const cc = message.cc.map((address) => assertAddress(address, 'CC recipient'));
  const username = assertAddress(env.SMTP_USER, 'SMTP user');
  if (!env.SMTP_APP_PASSWORD || /[\r\n]/.test(env.SMTP_APP_PASSWORD)) throw new Error('SMTP app password is not configured.');

  const socket = await makeConnection({ host, port });
  const smtp = session(socket);
  try {
    const greeting = await smtp.receive();
    if (!greeting.at(-1).startsWith('220 ')) throw new Error('SMTP server rejected the connection.');
    await smtp.command('EHLO today-work-plan', [250]);
    await smtp.command(`AUTH PLAIN ${base64(`\0${username}\0${env.SMTP_APP_PASSWORD}`)}`, [235]);
    await smtp.command(`MAIL FROM:<${from}>`, [250]);
    for (const recipient of [...to, ...cc]) await smtp.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await smtp.command('DATA', [354]);
    const headers = [
      `From: ${from}`,
      `To: ${to.join(', ')}`,
      ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
      `Subject: ${encodeHeader(message.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit'
    ];
    const safeBody = message.text.replace(/\r?\n\./g, '\r\n..');
    await smtp.command(`${headers.join('\r\n')}\r\n${safeBody}\r\n.`, [250]);
    await smtp.command('QUIT', [221]);
  } finally {
    socket.destroy();
  }
}
