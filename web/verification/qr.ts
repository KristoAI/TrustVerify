import QRCode from 'qrcode';

export async function renderQr(canvas: HTMLCanvasElement, url: string) {
  await QRCode.toCanvas(canvas, url, { errorCorrectionLevel: 'M', margin: 4, width: 288, color: { dark: '#172b25', light: '#ffffff' } });
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Scan this QR code with your phone camera to continue verification.');
}
