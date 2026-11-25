# Today Work Plan

A small, privacy-focused daily work update application for PrimeOne employees. It sends an update from a configured **personal Gmail address** to the line manager, with selected team members in CC. The application does not save updates to a database or local file.

## Features

- Separate Morning Plan and End-of-Day Task Log workflows with a topic and one-task-per-line input
- Automatic professional email generation with an editable subject and body preview before delivery
- Server-side validation, body-size limits, origin protection, and rate limiting
- Security headers and no-store API responses
- Direct Gmail SMTP delivery through a Google App Password; the normal Gmail password is never used or stored

## Set up locally

1. Copy `.env.example` to `.env`.
2. Set `MAIL_FROM` and `SMTP_USER` to your personal Gmail address, `MAIL_TO` to the line manager, and `MAIL_CC` to the team members who should receive a copy.
3. The automatic sign-off defaults to `Ashan Chathuranga`. Enable Google 2-Step Verification and create a dedicated Google App Password. Add it as `SMTP_APP_PASSWORD`, alongside the public `APP_ORIGIN` before production deployment.
4. Run `npm start`, then open `http://localhost:3000`.

For a local test, temporarily omit `APP_ORIGIN` or set it to the local URL the app is serving from.

## Verify

Run `npm test`. Tests verify both email previews and the final send path using a mocked SMTP delivery function, so they never send mail.

## Deployment notes

- Add environment variables in the hosting service; never commit `.env`.
- Never use a normal Gmail password. Revoke the dedicated Google App Password if the service is ever retired.
- Use HTTPS and set `APP_ORIGIN` to the exact deployed site URL.
- The form has no access-code field. Before a public launch, add allowlisted personal-email sign-in plus a WebAuthn passkey, which unlocks Face ID or fingerprint verification on compatible devices. This is important to prevent an unauthenticated public page from being used to send unwanted emails.
- The intended production target is Netlify. Before publishing, the API must be deployed as a Netlify Function and its environment variables set in Netlify rather than committed to Git.

## Windows Hello / passkey protection

Set these Netlify environment variables before enabling the private workspace:

- `AUTH_SETUP_SECRET`: a long, private one-time owner-enrollment key. Enter it only during the first device registration.
- `SESSION_SECRET`: a random secret of at least 32 characters used to sign login sessions.
- `APP_ORIGIN`: the exact HTTPS site origin, for example `https://your-site.netlify.app` (no trailing slash).

The first visitor with the setup key can enroll the owner passkey. Registration closes automatically after the first credential is saved in Netlify Blobs. The browser uses Windows Hello (fingerprint where configured, otherwise Windows Hello PIN). Biometric data stays on the device. Keep the setup key private and rotate it after enrollment. Do not commit `.env` or secrets.
