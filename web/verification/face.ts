import { bounded } from './async';

/** Integration written against the MIT face-api public API; no engine wrappers. */
declare global { interface Window { faceapi: any } }

export type FaceSample = { age: number; happy: number; descriptor: Float32Array; score: number };
let ready: Promise<void> | null = null;
let inferencePending = false;

export function loadFaceModels(signal?: AbortSignal): Promise<void> {
  if (!ready) ready = (async () => {
    const api = window.faceapi;
    if (!api?.nets) throw new Error('MODELS_UNAVAILABLE');
    await api.tf.ready();
    await Promise.all([
      api.nets.tinyFaceDetector.loadFromUri('/assets/models/face'),
      api.nets.faceLandmark68Net.loadFromUri('/assets/models/face'),
      api.nets.faceRecognitionNet.loadFromUri('/assets/models/face'),
      api.nets.faceExpressionNet.loadFromUri('/assets/models/face'),
      api.nets.ageGenderNet.loadFromUri('/assets/models/face'),
    ]);
  })().catch((error) => { ready = null; throw error; });
  return bounded(ready, signal, 45000);
}

export async function inspectFaces(image: HTMLCanvasElement, signal: AbortSignal): Promise<FaceSample[]> {
  await loadFaceModels(signal);
  signal.throwIfAborted();
  const api = window.faceapi;
  if (inferencePending) throw new Error('INFERENCE_BUSY');
  inferencePending = true;
  const work = Promise.resolve().then(() => api.detectAllFaces(image, new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
    .withFaceLandmarks().withFaceDescriptors().withFaceExpressions().withAgeAndGender()).finally(() => { inferencePending = false; });
  const result = await bounded<any[]>(work, signal, 15000, (faces) => faces.forEach((face) => face.descriptor?.fill(0)));
  if (signal.aborted) {
    result.forEach((face: any) => face.descriptor?.fill(0));
    signal.throwIfAborted();
  }
  return result.map((face: any) => ({ age: Number(face.age), happy: Number(face.expressions.happy), descriptor: face.descriptor, score: Number(face.detection.score) }));
}

export function faceDistance(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (!a.length || a.length !== b.length) return Infinity;
  let squared = 0;
  for (let i = 0; i < a.length; i += 1) squared += (a[i] - b[i]) ** 2;
  return Math.sqrt(squared);
}

export function clearFaces(faces: FaceSample[]) { faces.forEach((face) => face.descriptor.fill(0)); }
