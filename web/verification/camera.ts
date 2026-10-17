import { bounded } from './async';

/** Native camera lifecycle. Frames remain in browser memory. */
export class Camera {
  readonly video = document.createElement('video');
  private stream: MediaStream | null = null;
  private generation = 0;
  private removeAbortListener: (() => void) | null = null;
  private facing: 'user' | 'environment' = 'user';

  constructor() {
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-label', 'Live camera preview');
  }

  async start(facing: 'user' | 'environment', signal: AbortSignal, deviceId?: string) {
    this.stop();
    const generation = this.generation;
    this.facing = facing;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('CAMERA_UNAVAILABLE');
    const stream = await bounded(navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } }), width: { ideal: 1920 }, height: { ideal: 1080 } },
    }), signal, 20000, (lateStream) => lateStream.getTracks().forEach((track) => track.stop()));
    if (signal.aborted || generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Cancelled', 'AbortError');
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.classList.toggle('mirrored', facing === 'user');
    const stopOwnedStream = () => { if (generation === this.generation) this.stop(); };
    signal.addEventListener('abort', stopOwnedStream, { once: true });
    this.removeAbortListener = () => signal.removeEventListener('abort', stopOwnedStream);
    try {
      await bounded(this.video.play(), signal, 15000);
      if (generation !== this.generation) throw new DOMException('Superseded', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        if (this.video.videoWidth && this.video.readyState >= 2) return resolve();
        const cleanup = () => {
          clearTimeout(timer);
          this.video.removeEventListener('loadeddata', ready);
          signal.removeEventListener('abort', cancelled);
        };
        const ready = () => { cleanup(); resolve(); };
        const cancelled = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('CAMERA_TIMEOUT')); }, 15000);
        this.video.addEventListener('loadeddata', ready, { once: true });
        signal.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted) cancelled();
      });
      signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException('Superseded', 'AbortError');
    } catch (error) {
      // A previous camera's late rejection must never tear down its replacement.
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  async switch(signal: AbortSignal) {
    return this.start(this.facing === 'user' ? 'environment' : 'user', signal);
  }

  capture() {
    if (!this.stream || this.video.readyState < 2 || !this.video.videoWidth) throw new Error('CAMERA_NOT_READY');
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('CANVAS_UNAVAILABLE');
    // The preview may be mirrored; recognition always receives native pixels.
    context.drawImage(this.video, 0, 0);
    return canvas;
  }

  stop() {
    this.removeAbortListener?.();
    this.removeAbortListener = null;
    this.generation += 1;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
  }
}

export function disposeImage(canvas: HTMLCanvasElement | null) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

export async function readImage(file: File, signal: AbortSignal) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 15 * 1024 * 1024) throw new Error('IMAGE_FORMAT');
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await bounded(image.decode(), signal, 15000);
    signal.throwIfAborted();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 32_000_000) throw new Error('IMAGE_SIZE');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('CANVAS_UNAVAILABLE');
    context.drawImage(image, 0, 0);
    return canvas;
  } finally { URL.revokeObjectURL(url); image.src = ''; }
}
