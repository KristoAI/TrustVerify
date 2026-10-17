import { Camera, disposeImage } from './camera';
import { clearFaces, faceDistance, inspectFaces, type FaceSample } from './face';

export { selfieThreshold } from './flow';
export const SELFIE_MATCH_LIMIT = 0.5;

export function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

export function consistentSample(reference: FaceSample, candidate: FaceSample) {
  return Number.isFinite(candidate.age) && Number.isFinite(candidate.happy) && candidate.score >= 0.5 &&
    Math.abs(reference.age - candidate.age) <= 12 && faceDistance(reference.descriptor, candidate.descriptor) < SELFIE_MATCH_LIMIT;
}

/** Bounded neutral → smile → relaxed sequence. This remains browser-asserted. */
export async function collectSelfie(camera: Camera, signal: AbortSignal, onStatus: (message: string) => void) {
  const samples: FaceSample[] = [];
  const deadline = Date.now() + 60_000;
  let phase = 0;
  let accepted = 0;
  let attempts = 0;
  const prompts = ['Look at the camera with a relaxed expression.', 'Now give us a smile.', 'Relax your expression again.'];
  try {
    while (phase < 3 && Date.now() < deadline && attempts < 80) {
      signal.throwIfAborted();
      attempts += 1;
      onStatus(prompts[phase]);
      const frame = camera.capture();
      let faces: FaceSample[];
      try { faces = await inspectFaces(frame, signal); } finally { disposeImage(frame); }
      if (faces.length !== 1) {
        clearFaces(faces);
        accepted = 0;
        onStatus(faces.length > 1 ? 'Only one person should be visible.' : 'Move into the frame and look toward the camera.');
        await delay(550, signal);
        continue;
      }
      const face = faces[0];
      if (!Number.isFinite(face.age) || !Number.isFinite(face.happy)) { clearFaces(faces); throw new Error('FACE_UNREADABLE'); }
      if (samples.length && !consistentSample(samples[0], face)) { clearFaces(faces); throw new Error('FACE_CHANGED'); }
      const expressionMatches = phase === 1 ? face.happy >= 0.65 : face.happy <= 0.4;
      if (expressionMatches) {
        samples.push(face);
        accepted += 1;
        if (accepted >= (phase === 2 ? 2 : 3)) { phase += 1; accepted = 0; }
      } else { clearFaces(faces); accepted = 0; }
      await delay(400, signal);
    }
    signal.throwIfAborted();
    if (phase !== 3) throw new Error('SELFIE_TIMEOUT');
    const ages = samples.map((face) => face.age).sort((a, b) => a - b);
    const estimate = ages[Math.floor(ages.length / 2)];
    return { estimate };
  } finally { clearFaces(samples); }
}
