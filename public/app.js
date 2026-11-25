import { startRegistration, startAuthentication } from 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@14/+esm';
const authCard = document.querySelector('#auth-card');
const workspace = document.querySelector('#workspace');
const authButton = document.querySelector('#auth-button');
const authStatus = document.querySelector('#auth-status');
const setupLabel = document.querySelector('#setup-label');
const setupSecret = document.querySelector('#setup-secret');
let enrolled = false;
async function authRequest(path, body) { const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Authentication failed.'); return data; }
async function refreshAuth() { try { const state = await authRequest('/api/auth/status'); enrolled = state.enrolled; if (state.authenticated) unlock(); else { authCard.hidden = false; workspace.hidden = true; setupLabel.hidden = enrolled; authButton.textContent = enrolled ? 'Unlock with Windows Hello' : 'Register this device'; } } catch (error) { authStatus.textContent = error.message; } }
function unlock() { authCard.hidden = true; workspace.hidden = false; }
authButton.addEventListener('click', async () => { authButton.disabled = true; authStatus.textContent = 'Waiting for Windows Hello…'; try { if (!enrolled) { const options = await authRequest('/api/auth/register/options', { setupSecret: setupSecret.value }); const attestation = await startRegistration({ optionsJSON: options }); await authRequest('/api/auth/register/verify', attestation); } else { const options = await authRequest('/api/auth/login/options', {}); const assertion = await startAuthentication({ optionsJSON: options }); await authRequest('/api/auth/login/verify', assertion); } authStatus.textContent = 'Unlocked successfully.'; unlock(); } catch (error) { authStatus.textContent = error.message; } finally { authButton.disabled = false; } });
document.querySelector('#logout').addEventListener('click', async () => { await authRequest('/api/auth/logout', {}); workspace.hidden = true; authCard.hidden = false; });
refreshAuth();
const form = document.querySelector('#update-form');
const status = document.querySelector('#status');
const button = form.querySelector('button');
const reportTypes = form.querySelectorAll('[name="reportType"]');
const taskLabel = document.querySelector('#task-label');
const taskInput = form.querySelector('[name="content"]');
const preview = document.querySelector('#preview');
const previewSubject = document.querySelector('#preview-subject');
const previewBody = document.querySelector('#preview-body');
const previewStatus = document.querySelector('#preview-status');
const sendButton = document.querySelector('#send-email');
const editButton = document.querySelector('#edit-draft');

function updateFormText() {
  const isMorning = form.elements.reportType.value === 'morning';
  taskLabel.firstChild.textContent = isMorning ? 'Today’s planned tasks *' : 'Today’s completed tasks *';
  taskInput.placeholder = isMorning ? 'Enter one planned task on each line.' : 'Enter one completed task on each line.';
}

reportTypes.forEach((input) => input.addEventListener('change', updateFormText));
updateFormText();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.className = '';
  if (!form.reportValidity()) return;
  button.disabled = true;
  button.textContent = 'Generating preview…';
  const payload = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to generate the preview.');
    previewSubject.value = result.subject;
    previewBody.value = result.text;
    preview.hidden = false;
    previewStatus.textContent = '';
    previewStatus.className = '';
    preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    status.textContent = 'Review and edit the email before sending.';
    status.className = 'success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'error';
  } finally {
    button.disabled = false;
    button.textContent = 'Generate email preview';
  }
});

editButton.addEventListener('click', () => {
  preview.hidden = true;
  form.querySelector('[name="topic"]').focus();
});

sendButton.addEventListener('click', async () => {
  previewStatus.className = '';
  if (!previewSubject.reportValidity() || !previewBody.reportValidity()) return;
  sendButton.disabled = true;
  sendButton.textContent = 'Sending…';
  try {
    const response = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: previewSubject.value, text: previewBody.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to send the email.');
    previewStatus.textContent = result.message;
    previewStatus.className = 'success';
    form.reset();
    updateFormText();
  } catch (error) {
    previewStatus.textContent = error.message;
    previewStatus.className = 'error';
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = 'Send email';
  }
});
