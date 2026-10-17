import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";

test("MIT QR encoder preserves continuation URLs when read by an independent decoder", async () => {
  for (const url of [
    "https://trustbunny.example/continue-phone#0123456789_abcdefghijklmnopqrstuvwxyz-ABCDE",
    "http://127.0.0.1:3318/continue-phone#synthetic-local-only-token",
  ]) {
    const png = PNG.sync.read(await QRCode.toBuffer(url, { width: 288, margin: 4, errorCorrectionLevel: "M" }));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.equal(decoded?.data, url);
  }
});
