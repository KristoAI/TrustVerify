import { Camera, disposeImage, readImage } from './camera';
import { loadFaceModels } from './face';
import { collectSelfie } from './selfie';
import { selfieOutcome, selfieThreshold, verificationMethods } from './flow';
import { documentCountries, documentKinds, documentRegions, requiresDocumentRegion, documentProfile, type DocumentKind, type DocumentSelection } from './document-options';
import { readDocument, DocumentReadError } from './document';
import { inspectDocumentQuality, documentQualityAdvice } from './document-quality';
import { meetsRequiredAge, type DateOrder } from './dates';
import { cropReview, type Selection } from './crop-review';
import { Continuation, type VerificationConfig } from './continuation';
import { button, element, render, request, safeCompletionUrl } from './ui';
import { clearDiagnostics, diagnosticReport } from './diagnostics';
import { emailExperimentAvailable, launchEmail } from './email';

const camera = new Camera();
let controller = new AbortController();
let documentImage: HTMLCanvasElement | null = null;
let submitting = false;
let config: VerificationConfig;
let continuation: Continuation;
let language: 'eng' | 'fra' = 'eng';
// A known printed order for the selected document; dates are otherwise read in any common format.
let dateOrder: DateOrder | undefined;
let selectedDocumentProfile: ReturnType<typeof documentProfile> = null;
// The reader handles most clear photos, so an unreadable scan first asks for a better photo;
// the manual date box is offered only after this many retakes also fail.
const DOCUMENT_RETAKES = 2;
let unreadableScans = 0;

function clearSensitive() {
  controller.abort();
  camera.stop();
  disposeImage(documentImage);
  documentImage = null;
  document.body.classList.remove('screen-light');
  document.body.style.removeProperty('--screen-light-level');
}

function newAttempt() {
  clearSensitive();
  clearDiagnostics();
  controller = new AbortController();
  return controller.signal;
}

function goBack() { if (!submitting) { clearSensitive(); showMethods(); } }

function addExit(actions: HTMLElement) {
  actions.append(button('Back to verification options', goBack, true));
}

function showMethods() {
  if (submitting) return;
  clearSensitive();
  const color = config.branding?.color;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) document.documentElement.style.setProperty('--brand-color', color);
  const view = render('Choose your age check', `Confirm that you are ${config.requiredAge} or older for ${config.siteName}. Choose how you would like to continue.`);
  if (config.methods.includes('selfie')) {
    const card = element('div', undefined, 'method-card');
    const description = `Use your camera for a live age estimate. If the estimate is below ${selfieThreshold(config.requiredAge)}, continue with Document ID.`;
    card.append(element('h2', 'Live AI Age Check'), element('p', description), button('Live AI Age Check', startSelfie));
    view.content.append(card);
  }
  if (config.methods.includes('document')) {
    const card = element('div', undefined, 'method-card');
    card.append(element('h2', 'Document ID'), element('p', 'Use your driver’s license, passport or government ID to confirm your age. No selfie is needed.'), button('Document ID', () => documentSetup()));
    view.content.append(card);
  }
  if (emailExperimentAvailable(config)) {
    const card = element('div', undefined, 'method-card');
    card.append(element('h2', 'Email check · experimental'), element('p', 'Check email history and inbox access. This optional experiment does not confirm your age.'), button('Try the email check', () => launchEmail(config, goBack, newAttempt())));
    view.content.append(card);
  }
  if (config.mode !== 'phone') view.actions.append(button('Continue on your phone', () => continuation.startDesktop(), true));
}

function documentSetup(reason?: string) {
  if (!config.methods.includes('document')) return;
  unreadableScans = 0;
  clearSensitive();
  const view = render('Prepare your document', `${reason ? `${reason} ` : ''}We will read the printed date of birth on your identity document. No selfie or portrait comparison is needed for this document check.`);
  const choose = (caption: string, placeholder: string, choices: readonly {value:string;label:string}[]) => {
    const label = element('label', caption);
    const select = element('select');
    const empty = element('option', placeholder); empty.value = ''; select.append(empty);
    for (const choice of choices) { const option = element('option', choice.label); option.value = choice.value; select.append(option); }
    label.append(select);
    view.content.append(label);
    return { label, select };
  };
  const country = choose('Issuing country', 'Choose the issuing country', documentCountries.map((country) => ({ value: country.code, label: country.label })));
  const kind = choose('Document type', 'Choose a document type', documentKinds);
  const region = choose('Issuing state, province or territory', 'Choose the issuing region', []);
  region.label.hidden = true;
  const hint = element('p', '', 'subtle');
  view.content.append(hint);
  const lang = choose('Document language', 'Choose the document language', [{ value: 'eng', label: 'English' }, { value: 'fra', label: 'French' }]);
  view.content.append(element('p', 'Check the suggested language against your document. Change it if needed before continuing.', 'subtle'));
  const selection = (): DocumentSelection => ({ country: country.select.value, kind: kind.select.value as DocumentKind, ...(region.select.value ? { region: region.select.value } : {}) });
  const next = button('Continue to document scan', () => {
    const profile = documentProfile(selection());
    if (!profile || !lang.select.value) return;
    selectedDocumentProfile = profile;
    language = lang.select.value as typeof language;
    dateOrder = profile.dateOrder;
    return documentCapture(newAttempt());
  });
  next.disabled = true;
  const validate = () => { next.disabled = !documentProfile(selection()) || !lang.select.value; };
  const updateProfile = () => {
    const profile = documentProfile(selection());
    lang.select.value = profile?.language || '';
    hint.textContent = profile?.readerHint || 'Select the issuing country and document type to prepare the reader.';
    validate();
  };
  const updateRegion = () => {
    const empty = element('option', 'Choose the issuing region'); empty.value = '';
    region.select.replaceChildren(empty);
    for (const area of documentRegions(country.select.value)) { const option = element('option', area.label); option.value = area.code; region.select.append(option); }
    region.select.value = '';
    region.label.hidden = !requiresDocumentRegion(selection());
    updateProfile();
  };
  country.select.addEventListener('change', updateRegion);
  kind.select.addEventListener('change', updateRegion);
  region.select.addEventListener('change', updateProfile);
  lang.select.addEventListener('change', validate);
  view.actions.append(next);
  addExit(view.actions);
}

function cameraTools(actions: HTMLElement, signal: AbortSignal, status: HTMLElement, documentMode = false) {
  const switchCamera = button('Switch camera', async () => {
    switchCamera.disabled = true;
    try { await camera.switch(signal); }
    catch { if (!signal.aborted) status.textContent = 'Could not switch cameras. Choose another method and try again.'; }
    finally { if (!signal.aborted) switchCamera.disabled = false; }
  }, true);
  const light = button(`Screen light: ${documentMode ? 'on' : 'off'}`, () => {
    const active = document.body.classList.toggle('screen-light');
    light.textContent = `Screen light: ${active ? 'on' : 'off'}`;
    light.setAttribute('aria-pressed', String(active));
    intensity.disabled = !active;
  }, true);
  light.setAttribute('aria-pressed', String(documentMode));
  document.body.classList.toggle('screen-light', documentMode);
  document.body.style.setProperty('--screen-light-level', '1');
  const lightLabel = element('label', 'Screen light intensity');
  const intensity = element('input');
  intensity.type = 'range'; intensity.min = '20'; intensity.max = '100'; intensity.value = '100'; intensity.disabled = !documentMode;
  intensity.addEventListener('input', () => document.body.style.setProperty('--screen-light-level', String(Number(intensity.value) / 100)));
  lightLabel.append(intensity);
  actions.append(switchCamera, light, lightLabel);
  void navigator.mediaDevices.enumerateDevices().then((devices) => {
    if (signal.aborted || actions.dataset.locked === 'true') return;
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    if (cameras.length < 2) return;
    const label = element('label', 'Camera');
    const select = element('select');
    const current = element('option', 'Select a camera'); current.value = ''; select.append(current);
    cameras.forEach((device, index) => { const option = element('option', device.label || `Camera ${index + 1}`); option.value = device.deviceId; select.append(option); });
    select.addEventListener('change', async () => {
      if (!select.value) return;
      select.disabled = true;
      try { await camera.start(documentMode ? 'environment' : 'user', signal, select.value); }
      catch { if (!signal.aborted) status.textContent = 'This camera could not start. Try selecting a different camera.'; }
      finally { if (!signal.aborted) select.disabled = false; }
    });
    label.append(select); actions.append(label);
  }).catch(() => { /* Facing-mode switch remains available if enumeration is denied. */ });
  return switchCamera;
}

async function startSelfie() {
  if (!config.methods.includes('selfie')) return;
  const signal = newAttempt();
  const view = render('Let’s check your age', 'Face the camera in even light. We will ask you to relax, smile and relax again. Keep just one face in view.');
  const frame = element('div', undefined, 'camera-frame');
  frame.append(camera.video);
  view.content.append(frame);
  view.status.textContent = 'Opening your camera and loading the private check…';
  addExit(view.actions);
  try {
    await Promise.all([camera.start('user', signal), loadFaceModels(signal)]);
    signal.throwIfAborted();
    const tools = element('div', undefined, 'camera-tools');
    view.content.append(tools);
    const switchCamera = cameraTools(tools, signal, view.status);
    const start = button('I’m ready', async () => {
      start.disabled = true;
      switchCamera.disabled = true;
      tools.dataset.locked = 'true';
      tools.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach((control) => { control.disabled = true; });
      try {
        const selfie = await collectSelfie(camera, signal, (message) => { if (!signal.aborted) view.status.textContent = message; });
        if (signal.aborted) return;
        camera.stop();
        document.body.classList.remove('screen-light');
        const outcome = selfieOutcome(config.methods, config.requiredAge, selfie.estimate);
        if (outcome === 'passed') return finish('success', 'selfie');
        return documentSetup('We need a document to confirm your age. Continue with your driver’s license, passport or government ID.');
      } catch { if (!signal.aborted) showProblem('We could not complete the live selfie check. Try again in steady light with one person in view.', 'selfie'); }
    });
    view.status.textContent = 'Camera ready. Start when you are comfortable.';
    view.actions.prepend(start);
  } catch {
    if (!signal.aborted) showProblem('The camera or face check could not start. Allow camera access in your browser, then try again.', 'selfie');
  }
}

async function documentCapture(signal: AbortSignal) {
  const cameraStage = new AbortController();
  const endCameraStage = () => cameraStage.abort();
  signal.addEventListener('abort', endCameraStage, { once: true });
  if (signal.aborted) { cameraStage.abort(); return; }
  const view = render(selectedDocumentProfile?.captureTitle || 'Scan your identity document', selectedDocumentProfile?.captureInstruction || 'Keep the document in view with the printed date of birth sharp and free from glare. Your face does not need to be in the picture.');
  const frame = element('div', undefined, 'camera-frame document-camera');
  frame.append(camera.video);
  view.content.append(frame);
  addExit(view.actions);
  const uploadLabel = element('label', 'Or choose a document image', 'file-label');
  const upload = element('input');
  upload.type = 'file'; upload.accept = 'image/jpeg,image/png,image/webp';
  uploadLabel.append(upload);
  view.content.append(uploadLabel);
  let busy = false;
  const accept = async (image: HTMLCanvasElement) => {
    if (signal.aborted) { disposeImage(image); return; }
    cameraStage.abort();
    signal.removeEventListener('abort', endCameraStage);
    camera.stop();
    document.body.classList.remove('screen-light');
    documentImage = image;
    const quality = inspectDocumentQuality(image);
    if (signal.aborted) return;
    if (quality.issues.length) {
      const review = render('Check your document image', 'A clearer image may help us find the printed date of birth automatically.');
      for (const issue of quality.issues) review.content.append(element('p', documentQualityAdvice(issue)));
      review.actions.append(button('Retake or choose another image', () => documentCapture(newAttempt())));
      const useImage = button('Use this image anyway', async () => {
        if (signal.aborted || useImage.disabled) return;
        useImage.disabled = true;
        await extractDate(signal);
      }, true);
      review.actions.append(useImage);
      addExit(review.actions);
      return;
    }
    await extractDate(signal);
  };
  upload.addEventListener('change', async () => {
    if (busy || !upload.files?.[0]) return;
    busy = true;
    upload.disabled = true;
    try { await accept(await readImage(upload.files[0], signal)); }
    catch { if (!signal.aborted) { view.status.textContent = 'Choose a JPEG, PNG or WebP image under 15 MB with a clearly visible document.'; busy = false; upload.disabled = false; } }
    finally { upload.value = ''; }
  });
  try {
    await camera.start('environment', cameraStage.signal);
    cameraStage.signal.throwIfAborted();
    const capture = button('Capture document', async () => {
      if (busy) return;
      busy = true; capture.disabled = true;
      try { await accept(camera.capture()); }
      catch { if (!signal.aborted) { busy = false; capture.disabled = false; view.status.textContent = 'Capture failed. Hold the document steady and try again.'; } }
    });
    const tools = element('div', undefined, 'camera-tools');
    cameraTools(tools, cameraStage.signal, view.status, true);
    view.content.append(tools);
    view.actions.prepend(capture);
    view.status.textContent = 'Ready to capture. Images are processed here and are not uploaded.';
  } catch {
    if (!cameraStage.signal.aborted) view.status.textContent = 'The document camera could not open. Choose an image, or go back and retry camera access.';
  }
}

async function extractDate(signal: AbortSignal, crop?: Selection) {
  if (!documentImage) return;
  const view = render('Reading the date of birth', 'Keep this page open while the document is read on your device.');
  let readingAttempt = 1;
  addExit(view.actions);
  try {
    const result = await readDocument({ image: documentImage, crop, language, dateOrder, signal,
      onProgress: (stage, progress) => {
        if (signal.aborted) return;
        if (stage === 'preparing-image') {
          readingAttempt = progress && progress >= 0.5 ? 2 : 1;
          view.status.textContent = crop ? 'Preparing your selected birth-date area…' : `Reading attempt ${readingAttempt} of 2: locating the birth date…`;
        } else if (stage === 'recognizing') view.status.textContent = `Reading attempt ${readingAttempt} of 2${progress === undefined ? '…' : `: ${Math.round(progress * 100)}%`}`;
        else view.status.textContent = 'Preparing the private document reader…';
      },
    });
    signal.throwIfAborted();
    if (meetsRequiredAge(result.birthDate, config.requiredAge)) return finish('success', 'document');
    showProblem('We could not confirm that this document meets the age requirement.', 'document');
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof DocumentReadError && error.code === 'DATE_UNREADABLE') {
      if (!crop && unreadableScans < DOCUMENT_RETAKES) return retakeDocument(++unreadableScans);
      return selectDateRegion(signal);
    }
    showProblem('The document reader could not finish. Please try again with a clear image and a stable connection.', 'document');
  }
}

function retakeDocument(retake: number) {
  clearSensitive();
  const view = render('Let’s retake the photo', `We could not read the date of birth from that photo. Retake ${retake} of ${DOCUMENT_RETAKES}: most unreadable photos come from glare, blur or part of the card being out of view.`);
  for (const tip of [
    'Use bright, even light. Tilt the card slightly if light reflects off it.',
    'Hold your phone steady, or rest your elbows on a table, and let the camera focus before capturing.',
    'Keep the whole card in view, flat and square to the camera, filling most of the frame.',
  ]) view.content.append(element('p', tip));
  view.actions.append(button('Retake photo', () => documentCapture(newAttempt())));
  addExit(view.actions);
}

function selectDateRegion(signal: AbortSignal) {
  if (!documentImage) return;
  const view = render('Select the printed birth date', 'We could not read the date confidently. Drag a tight box around only the printed birth date, or define the box with the sliders. The DOB label is optional. Keep issue, expiry and all other dates outside the box. Only one valid date can be read.');
  let selection: Selection | undefined;
  const read = button('Read selected area', async () => {
    if (!selection) return;
    read.disabled = true;
    await extractDate(signal, selection);
  });
  read.disabled = true;
  view.content.append(cropReview(documentImage, (crop, edited) => {
    selection = edited ? crop : undefined;
    read.disabled = !edited;
  }));
  view.actions.append(read);
  addExit(view.actions);
}

function showProblem(message: string, method: 'selfie' | 'document') {
  clearSensitive();
  const view = render('Let’s try another way', message);
  view.actions.append(button('Try again', () => method === 'document' ? documentSetup() : startSelfie()));
  if (method === 'selfie' && config.methods.includes('document')) view.actions.append(button('Use an identity document', () => documentSetup('The selfie check could not finish. You can use your document instead.'), true));
  if (config.mode !== 'phone') view.actions.append(button('Continue on your phone', () => continuation.startDesktop(), true));
  view.actions.append(button('Finish without verification', () => finish('fail', method), true));
}

async function finish(outcome: 'success' | 'fail', method: 'selfie' | 'document') {
  if (submitting) return;
  submitting = true;
  clearSensitive();
  const view = render('Finishing your check', 'Sending only your verification outcome.');
  const deliver = async () => {
    if (config.mode === 'phone') return continuation.finishPhone(outcome, method);
    const result = await request<{content?:{completionUrl?:string}}>(`/result/${outcome}`, { token: config.capability, sessionId: config.sessionId, stepId: method === 'selfie' ? 3 : 5 });
    window.location.assign(safeCompletionUrl(result.content?.completionUrl));
  };
  try { await deliver(); }
  catch {
    view.status.textContent = 'Your result could not be confirmed. Retry sending it before leaving this page.';
    const retry = button('Retry sending result', async () => {
      retry.disabled = true;
      try { await deliver(); } catch { retry.disabled = false; view.status.textContent = 'Still unable to confirm the result. Please try again.'; }
    });
    view.actions.append(retry);
  }
}

async function recoverCompleted() {
  submitting = true;
  clearSensitive();
  const view = render('Your check is finished', 'Retrieving the result for this browser. You do not need to repeat the check.');
  const retrieve = async () => {
    const result = await request<{url:string}>(`/api/verification/${encodeURIComponent(config.sessionId)}/recover`, { launch: config.capability });
    window.location.assign(safeCompletionUrl(result.url));
  };
  try { await retrieve(); }
  catch {
    view.status.textContent = 'The result could not be retrieved. Reconnect and try again.';
    const retry = button('Retrieve result', async () => {
      retry.disabled = true;
      try { await retrieve(); }
      catch { retry.disabled = false; view.status.textContent = 'The result is still unavailable. Please try again.'; }
    });
    view.actions.append(retry);
  }
}

async function bootstrap() {
  try {
    config = JSON.parse(document.querySelector('#verification-config')?.textContent || '{}');
    if (config.mode !== 'phone' && (!config.sessionId || !config.capability || !Number.isInteger(config.requiredAge) || !Array.isArray(config.methods))) throw new Error('INVALID_CONFIG');
    config.methods = verificationMethods(config.methods || []);
    if (config.mode !== 'phone' && !config.methods.length) throw new Error('NO_METHODS');
    continuation = new Continuation(config, showMethods, clearSensitive);
    if (config.mode === 'phone') await continuation.startPhone();
    else if (config.completed) await recoverCompleted();
    else if (!(await continuation.recoverDesktop())) {
      if (config.initialMethod === 'document' && config.methods.includes('document')) documentSetup();
      else if (config.initialMethod === 'selfie' && config.methods.includes('selfie')) await startSelfie();
      else showMethods();
    }
  } catch { render('This age check is unavailable', 'Return to the requesting website and start a new verification session.'); }
}

window.addEventListener('pagehide', () => { clearSensitive(); continuation?.stop(); });
Object.defineProperty(window, 'TrustBunnyDiagnostics', { value: Object.freeze({ report: diagnosticReport }), configurable: false });
void bootstrap();
