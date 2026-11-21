# Today Work Plan

A small, privacy-focused daily work update application for PrimeOne employees. It sends an update from a configured **personal Gmail address** to the line manager, with selected team members in CC. The application does not save updates to a database or local file.

## Features

- Responsive employee update form
- Server-side validation, body-size limits, origin protection, and rate limiting
- Employee access-code check using timing-safe comparison
- Security headers and no-store API responses
- Direct Gmail SMTP delivery through a Google App Password; the normal Gmail password is never used or stored

## Set up locally

1. Copy `.env.example` to `.env`.
2. Set `MAIL_FROM` and `SMTP_USER` to your personal Gmail address, `MAIL_TO` to the line manager, and `MAIL_CC` to the team members who should receive a copy.
3. Enable Google 2-Step Verification and create a dedicated Google App Password. Add it as `SMTP_APP_PASSWORD`, alongside a long random `SUBMISSION_TOKEN` and the public `APP_ORIGIN` before production deployment.
4. Run `npm start`, then open `http://localhost:3000`.

For a local test, temporarily omit `APP_ORIGIN` or set it to the local URL the app is serving from.

## Verify

Run `npm test`. Tests use a mocked email provider and never send mail.

## Deployment notes

- Add environment variables in the hosting service; never commit `.env`.
- Never use a normal Gmail password. Revoke the dedicated Google App Password if the service is ever retired.
- Use HTTPS and set `APP_ORIGIN` to the exact deployed site URL.
- The provided access code is a lightweight gate. The next security phase is an allowlisted personal-email sign-in plus a WebAuthn passkey, which unlocks Face ID or fingerprint verification on compatible devices. This requires passkey credential storage and must be set up before a public launch.
- The intended production target is Netlify. Before publishing, the API must be deployed as a Netlify Function and its environment variables set in Netlify rather than committed to Git.
