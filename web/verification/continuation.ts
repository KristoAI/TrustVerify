import { button, element, render, request, safeCompletionUrl } from './ui';
import { renderQr } from './qr';
import { verificationMethods } from './flow';
import { delay } from './selfie';

export type VerificationConfig = {
  sessionId: string; capability: string; methods: ('selfie' | 'document')[];
  initialMethod?: 'selfie' | 'document';
  emailExperiment?: boolean;
  emailHistoryYears?: number;
  requiredAge: number; siteName: string; branding?: { color?: string }; mode?: 'phone'; completed?: boolean;
};
type ContinuationStatus = Partial<VerificationConfig> & {
  id?: string; state: string; pairingPhrase?: string; outcome?: string; expiresAt?: string;
};
const api = (id: string, action: string) => `/api/continuation/${encodeURIComponent(id)}/${action}`;

export class Continuation {
  private controller = new AbortController();
  private phoneId = '';
  private active = false;
  constructor(private config: VerificationConfig, private onReady: () => void, private onStop: () => void) {}

  stop() { this.controller.abort(); this.active = false; }

  private begin() {
    this.stop();
    this.onStop();
    this.controller = new AbortController();
    this.active = true;
    return this.controller.signal;
  }

  async recoverDesktop(): Promise<boolean> {
    try {
      const status = await request<ContinuationStatus>(api(this.config.sessionId, 'status'));
      if (['awaiting_approval', 'active', 'completed', 'offered'].includes(status.state)) {
        const signal = this.begin();
        void this.desktopStatus(status, signal);
        return true;
      }
    } catch { /* No invitation or desktop binding exists before first use. */ }
    return false;
  }

  async startDesktop() {
    const signal = this.begin();
    const view = render('Continue on your phone', 'We will connect your phone to this check. Your computer will receive the result.');
    view.status.textContent = 'Creating a private invitation…';
    try {
      const invitation = await request<{id:string;url:string;expiresAt:string}>(api(this.config.sessionId, 'invite'), { launch: this.config.capability }, signal);
      signal.throwIfAborted();
      const canvas = element('canvas');
      await renderQr(canvas, invitation.url);
      signal.throwIfAborted();
      view.content.append(canvas);
      view.status.textContent = 'Scan with your phone camera, then tap Connect phone.';
      view.actions.append(this.cancelButton(signal));
      const expires = element('p', '', 'subtle');
      view.content.append(expires);
      await this.pollDesktop(signal, (status) => {
        if (status.state === 'offered') {
          const remaining = Math.max(0, Math.ceil((new Date(invitation.expiresAt).getTime() - Date.now()) / 1000));
          expires.textContent = `Invitation expires in ${remaining} seconds.`;
          return false;
        }
        return true;
      });
    } catch (error) {
      if (signal.aborted) return;
      view.status.textContent = 'We could not create or read this invitation. Cancel it before using this device.';
      view.actions.replaceChildren(this.cancelButton(signal));
    }
  }

  private cancelButton(signal: AbortSignal) {
    const cancel = button('Cancel / use this device', async () => {
      cancel.disabled = true;
      try {
        const result = await request<{launch?:string;state:string}>(api(this.config.sessionId, 'cancel'), {}, signal);
        signal.throwIfAborted();
        if (result.launch) {
          this.config.capability = result.launch;
          const url = new URL(window.location.href);
          url.searchParams.delete('launch');
          window.history.replaceState(null, '', url);
        }
        this.stop();
        this.onReady();
      } catch {
        if (signal.aborted) return;
        cancel.disabled = false;
        cancel.textContent = 'Could not cancel — try again';
      }
    }, true);
    return cancel;
  }

  private async pollDesktop(signal: AbortSignal, onStatus?: (status: ContinuationStatus) => boolean) {
    let errors = 0;
    while (!signal.aborted) {
      try {
        const status = await request<ContinuationStatus>(api(this.config.sessionId, 'status'), undefined, signal);
        signal.throwIfAborted();
        errors = 0;
        if (!onStatus || onStatus(status)) return this.desktopStatus(status, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (++errors >= 5) throw error;
      }
      await delay(document.hidden ? 6000 : 2000, signal);
    }
  }

  private async desktopStatus(first: ContinuationStatus, signal: AbortSignal) {
    let status = first;
    let previous = '';
    let view = render('Phone continuation', 'Keep this page open while you finish on your phone.');
    let errors = 0;
    try {
      while (!signal.aborted) {
        if (status.state !== previous) {
          previous = status.state;
          view = render('Phone continuation', 'Your phone completes the check; this computer receives the result.');
          if (status.state === 'awaiting_approval') {
            view.status.textContent = 'Check that this phrase matches the one on your phone.';
            view.content.append(element('p', status.pairingPhrase || '', 'pairing-phrase'));
            const approve = button('Approve phone', async () => {
              approve.disabled = true;
              try {
                status = await request<ContinuationStatus>(api(this.config.sessionId, 'approve'), {}, signal);
                signal.throwIfAborted();
              } catch { if (!signal.aborted) { approve.disabled = false; view.status.textContent = 'Approval could not be confirmed. Try again.'; } }
            });
            view.actions.append(approve);
          } else if (status.state === 'active') {
            view.status.textContent = 'Verification is in progress on your phone.';
          } else if (status.state === 'offered') {
            view.status.textContent = 'An invitation is waiting. Cancel it to create a new QR code.';
          } else if (status.state === 'completed') {
            view.status.textContent = 'Check complete. Returning the result to this computer…';
            const deliver = async () => {
              const result = await request<{url:string}>(api(this.config.sessionId, 'complete'), {}, signal);
              signal.throwIfAborted();
              window.location.assign(safeCompletionUrl(result.url));
            };
            try { await deliver(); } catch {
              if (!signal.aborted) {
                view.status.textContent = 'Your check is finished. Reconnect to retrieve the result.';
                view.actions.append(button('Retrieve result', async () => {
                  try { await deliver(); } catch { view.status.textContent = 'The result is not available yet. Please try again.'; }
                }));
              }
            }
            return;
          } else {
            view.status.textContent = 'This phone connection has ended or expired. Cancel it to return to this device.';
            view.actions.append(this.cancelButton(signal));
            return;
          }
          view.actions.append(this.cancelButton(signal));
        }
        await delay(document.hidden ? 6000 : 2000, signal);
        try {
          status = await request<ContinuationStatus>(api(this.config.sessionId, 'status'), undefined, signal);
          errors = 0;
        } catch (error) {
          if (signal.aborted) return;
          view.status.textContent = 'Connection interrupted. Reconnecting…';
          if (++errors >= 5) throw error;
        }
      }
    } catch {
      if (!signal.aborted) {
        view.status.textContent = 'We cannot reach the service. Reload this page to reconnect, or cancel the phone connection.';
      }
    }
  }

  async startPhone() {
    const signal = this.begin();
    const invitation = window.location.hash.slice(1);
    const queryId = new URL(window.location.href).searchParams.get('id');
    if (queryId && !invitation) {
      this.phoneId = queryId;
      return this.waitForPhone(signal);
    }
    const view = render('Connect your phone', 'This check will authorize the computer that displayed the QR code. Only connect if you requested it.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(invitation)) {
      view.status.textContent = 'This invitation is missing or invalid. Scan a new QR code on your computer.';
      return;
    }
    const connect = button('Connect phone', async () => {
      connect.disabled = true;
      try {
        const status = await request<ContinuationStatus>('/api/continuation/claim', { invitation }, signal);
        signal.throwIfAborted();
        this.phoneId = status.id || status.sessionId || '';
        if (!this.phoneId) throw new Error('PAIRING_FAILED');
        window.history.replaceState(null, '', `/continue-phone?id=${encodeURIComponent(this.phoneId)}`);
        await this.waitForPhone(signal, status);
      } catch {
        if (!signal.aborted) {
          view.status.textContent = 'This invitation could not be connected. Retry, or create a new QR code on your computer.';
          connect.disabled = false;
        }
      }
    });
    view.actions.append(connect);
  }

  private async waitForPhone(signal: AbortSignal, first?: ContinuationStatus) {
    const view = render('Confirm on your computer', 'Check the pairing phrase, then approve this phone on the computer.');
    let status = first;
    let errors = 0;
    while (!signal.aborted) {
      try {
        status ||= await request<ContinuationStatus>(api(this.phoneId, 'status'), undefined, signal);
        signal.throwIfAborted();
        errors = 0;
        if (status.state === 'active') {
          if (!Array.isArray(status.methods) || !Number.isFinite(status.requiredAge)) throw new Error('INVALID_CONFIG');
          this.config.sessionId = status.sessionId || this.phoneId;
          this.config.methods = verificationMethods(status.methods);
          this.config.requiredAge = status.requiredAge!;
          this.config.siteName = status.siteName || 'the requesting website';
          this.config.branding = status.branding;
          this.active = false;
          this.onReady();
          void this.monitorPhone(signal);
          return;
        }
        if (status.state === 'completed') { this.finished(); return; }
        if (status.state !== 'awaiting_approval') {
          view.status.textContent = 'This connection ended or expired. Request a new QR code on your computer.';
          return;
        }
        view.content.replaceChildren(element('p', status.pairingPhrase || '', 'pairing-phrase'));
        view.status.textContent = `Waiting for approval${status.siteName ? ` to verify for ${status.siteName}` : ''}…`;
        status = undefined;
      } catch {
        if (signal.aborted) return;
        view.status.textContent = 'Connection interrupted. Reconnecting…';
        if (++errors >= 5) { view.status.textContent = 'Could not reconnect. Reload this page to try again.'; return; }
      }
      try { await delay(document.hidden ? 6000 : 2000, signal); } catch { return; }
    }
  }

  private async monitorPhone(signal: AbortSignal) {
    let failures = 0;
    try {
      while (!signal.aborted) {
        await delay(document.hidden ? 6000 : 2000, signal);
        try {
          const status = await request<ContinuationStatus>(api(this.phoneId, 'status'), undefined, signal);
          signal.throwIfAborted();
          failures = 0;
          if (status.state === 'completed') { this.finished(); return; }
          if (status.state !== 'active') {
            this.onStop();
            render('Phone connection ended', 'This check was cancelled or expired. Return to your computer to start again.');
            return;
          }
        } catch {
          if (signal.aborted) return;
          if (++failures >= 5) {
            this.onStop();
            render('Connection interrupted', 'We stopped the camera because this phone connection could not be confirmed. Reload this page to reconnect.');
            return;
          }
        }
      }
    } catch { /* Cancellation stops the authority monitor. */ }
  }

  async finishPhone(outcome: 'success' | 'fail', method: 'selfie' | 'document') {
    await request(api(this.phoneId || this.config.sessionId, 'finish'), { outcome, method });
    this.finished();
  }

  private finished() {
    this.stop();
    this.onStop();
    render('Finished', 'Return to your computer to continue. Your verification inputs have been cleared from this page.');
  }
}
