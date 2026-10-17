import type { VerificationConfig } from './continuation';
import { button, element, render, request } from './ui';

export type EmailCheckStatus = 'queued' | 'checking' | 'eligible' | 'send_requested' | 'sending' | 'sent' | 'verified' | 'not_eligible' | 'unavailable' | 'expired' | 'locked';
type EmailCheck = { id: string; status: EmailCheckStatus };
const statuses = new Set<EmailCheckStatus>(['queued', 'checking', 'eligible', 'send_requested', 'sending', 'sent', 'verified', 'not_eligible', 'unavailable', 'expired', 'locked']);
const POLL_INTERVAL_MS = 2000;
// Only challenge metadata survives leaving this view; email addresses and codes do not.
const knownChecks = new Map<string, EmailCheck>();

export function emailExperimentAvailable(config: Pick<VerificationConfig, 'emailExperiment' | 'mode'>) {
  return config.emailExperiment === true && config.mode !== 'phone';
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, POLL_INTERVAL_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Optional history/inbox experiment. It never submits an age-verification result. */
export function launchEmail(config: VerificationConfig, onBack: () => void, signal: AbortSignal) {
  if (signal.aborted || !emailExperimentAvailable(config)) return;
  let version = 0;
  const historyYears = Number.isInteger(config.emailHistoryYears) && config.emailHistoryYears! > 0 ? config.emailHistoryYears! : 10;
  const privateInputs = new Set<HTMLInputElement>();
  const footer = document.querySelector<HTMLElement>('footer');
  const previousFooter = footer?.textContent || '';
  if (footer) footer.textContent = 'For this optional email check, your email address is sent to TrustBunny and XposedOrNot with your consent. A code is emailed only when you request it. Camera images and document details are not part of this check.';
  const clearInputs = () => { for (const input of privateInputs) input.value = ''; privateInputs.clear(); };
  const cleanup = () => { version += 1; clearInputs(); if (footer) footer.textContent = previousFooter; };
  signal.addEventListener('abort', cleanup, { once: true });
  const back = () => { cleanup(); signal.removeEventListener('abort', cleanup); onBack(); };
  const current = (generation: number) => !signal.aborted && generation === version;
  const base = `/api/verification/${encodeURIComponent(config.sessionId)}/email`;
  const resource = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const statusUrl = (id: string) => `${resource(id)}?capability=${encodeURIComponent(config.capability)}`;
  const checkResponse = (value: EmailCheck) => {
    if (!value || typeof value.id !== 'string' || !value.id || !statuses.has(value.status)) throw new Error('INVALID_EMAIL_STATUS');
    return value;
  };
  const readStatus = async (id: string) => checkResponse(await request<EmailCheck>(statusUrl(id), undefined, signal));
  const exit = (actions: HTMLElement) => actions.append(button('Back to age verification', back, true));

  function showForm() {
    if (signal.aborted) return;
    const generation = ++version;
    clearInputs();
    const view = render('Email check · experimental', `This optional check looks for an email-history record at least ${historyYears} years old, then confirms access to your inbox. It does not confirm your age or replace the age check.`);
    const emailLabel = element('label', 'Email address');
    const email = element('input');
    email.type = 'email'; email.autocomplete = 'email'; email.inputMode = 'email'; email.maxLength = 254; email.required = true;
    privateInputs.add(email);
    emailLabel.append(email);
    const consentLabel = element('label', undefined, 'email-consent');
    const consent = element('input'); consent.type = 'checkbox';
    consentLabel.append(consent, element('span', 'I agree to share this email address with TrustBunny and XposedOrNot for this optional email-history check.'));
    view.content.append(emailLabel, consentLabel, element('p', 'Only one email address can be checked in this verification session. One code can be requested; replacement codes are not sent.', 'subtle'));
    let submittedEmail: string | null = null;
    const valid = () => consent.checked && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim());
    const start = button('Check email history', async () => {
      if (!current(generation) || !valid()) return;
      submittedEmail ||= email.value.trim();
      start.disabled = true; email.disabled = true; consent.disabled = true;
      view.status.textContent = 'Starting your email-history check…';
      try {
        const result = checkResponse(await request<EmailCheck>(base, { capability: config.capability, email: submittedEmail, consent: true }, signal));
        if (current(generation)) showState(result);
      } catch {
        if (!current(generation)) return;
        view.status.textContent = 'We could not confirm this request. Retry the same email check, or return to age verification. To use another email address, start a fresh verification session.';
        start.textContent = 'Retry this email check';
        start.disabled = false;
      }
    });
    start.disabled = true;
    const validate = () => { start.disabled = !valid(); };
    email.addEventListener('input', validate); consent.addEventListener('change', validate);
    view.actions.append(start); exit(view.actions);
  }

  function showState(result: EmailCheck) {
    if (signal.aborted) return;
    knownChecks.set(config.sessionId, { id: result.id, status: result.status });
    const generation = ++version;
    clearInputs();
    const view = render('Email check · experimental', `This checks for email history at least ${historyYears} years old and confirms inbox access only. Your age still needs to be checked separately.`);
    const { id, status } = result;
    const refresh = async () => {
      const next = await readStatus(id);
      if (current(generation)) showState(next);
    };
    const reconnect = () => {
      const retry = button('Check status again', async () => {
        retry.disabled = true;
        try { await refresh(); }
        catch { if (current(generation)) { retry.disabled = false; view.status.textContent = 'The email check is still unavailable. Try again or use an age-verification option.'; } }
      });
      view.actions.prepend(retry);
    };

    if (status === 'eligible') {
      view.status.textContent = 'The history check is eligible. You can request one code; replacement codes are not sent. Send the code to confirm that you can access this inbox.';
      const send = button('Send me a verification code', async () => {
        if (!current(generation)) return;
        send.disabled = true;
        view.status.textContent = 'Requesting your verification code…';
        try {
          const next = checkResponse(await request<EmailCheck>(`${resource(id)}/send`, { capability: config.capability }, signal));
          if (current(generation)) showState(next);
        } catch {
          if (!current(generation)) return;
          view.status.textContent = 'We could not confirm whether the code was sent. Check its status before making another request.';
          reconnect();
        }
      });
      view.actions.append(send);
    } else if (status === 'sent') {
      view.status.textContent = 'Enter the six-digit code from your email. No age-verification result will be submitted.';
      const label = element('label', 'Six-digit verification code');
      const code = element('input');
      code.type = 'text'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.maxLength = 6; code.pattern = '[0-9]{6}';
      privateInputs.add(code); label.append(code); view.content.append(label);
      const verify = button('Confirm inbox access', async () => {
        if (!current(generation) || !/^\d{6}$/.test(code.value)) return;
        verify.disabled = true; code.disabled = true;
        try {
          const next = checkResponse(await request<EmailCheck>(`${resource(id)}/verify`, { capability: config.capability, code: code.value }, signal));
          if (!current(generation)) return;
          if (next.status === 'sent') {
            code.value = ''; code.disabled = false; verify.disabled = true;
            view.status.textContent = 'That code did not match. Try again.';
            code.focus();
          } else showState(next);
        } catch {
          if (!current(generation)) return;
          code.disabled = false; verify.disabled = !/^\d{6}$/.test(code.value);
          view.status.textContent = 'The code could not be confirmed. Check the code and try again, or return to age verification.';
        }
      });
      verify.disabled = true;
      code.addEventListener('input', () => { verify.disabled = !/^\d{6}$/.test(code.value); });
      view.actions.append(verify);
      void poll(id, status, generation, view.status, reconnect);
    } else if (status === 'verified') {
      view.status.textContent = 'Email history and inbox access checked. This does not confirm your age. Continue with one of the age-verification options.';
    } else if (status === 'not_eligible' || status === 'unavailable' || status === 'expired' || status === 'locked') {
      const explanations = {
        not_eligible: 'This address could not complete the experimental history check. This says nothing about your age.',
        unavailable: 'The experimental email check is currently unavailable. You can still use an age-verification option.',
        expired: 'This email check or verification code has expired. No replacement code has been sent.',
        locked: 'This email check cannot accept more code attempts. No replacement code has been sent.',
      };
      view.status.textContent = explanations[status];
      view.content.append(element('p', 'To try email again, return to the requesting website and start a fresh verification session. You can continue with an age-verification option in this session.'));
    } else {
      view.status.textContent = status === 'queued' || status === 'checking' ? 'Checking email history…' : 'Preparing your requested verification email…';
      void poll(id, status, generation, view.status, reconnect);
    }
    exit(view.actions);
  }

  async function poll(id: string, previous: EmailCheckStatus, generation: number, statusNode: HTMLElement, reconnect: () => void) {
    let failures = 0;
    const deadline = Date.now() + 10 * 60 * 1000;
    try {
      while (current(generation) && Date.now() < deadline) {
        await pause(signal);
        if (!current(generation)) return;
        try {
          const next = await readStatus(id);
          if (!current(generation)) return;
          failures = 0;
          if (next.status !== previous) { showState(next); return; }
        } catch {
          if (!current(generation)) return;
          statusNode.textContent = 'Connection interrupted. Reconnecting to the email check…';
          if (++failures >= 3) { statusNode.textContent = 'We cannot read the email check right now. You can retry or return to age verification.'; reconnect(); return; }
        }
      }
      if (current(generation)) { statusNode.textContent = 'This email check has taken too long. Check its status again or return to age verification.'; reconnect(); }
    } catch { /* Aborting this screen stops its poll and all pending requests. */ }
  }

  const previous = knownChecks.get(config.sessionId);
  if (previous) showState(previous);
  else showForm();
}
