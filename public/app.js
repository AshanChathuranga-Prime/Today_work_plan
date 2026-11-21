const form = document.querySelector('#update-form');
const status = document.querySelector('#status');
const button = form.querySelector('button');
document.querySelector('[name="workDate"]').value = new Date().toISOString().slice(0, 10);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.className = '';
  if (!form.reportValidity()) return;
  button.disabled = true;
  button.textContent = 'Sending…';
  const payload = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch('/api/updates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to send the update.');
    form.reset();
    document.querySelector('[name="workDate"]').value = new Date().toISOString().slice(0, 10);
    status.textContent = result.message;
    status.className = 'success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'error';
  } finally {
    button.disabled = false;
    button.textContent = 'Send daily update';
  }
});
