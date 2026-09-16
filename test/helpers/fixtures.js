import omggif from "omggif";
import { LABELS } from "../../src/importer.js";

// Deliberately invented data: this is not an email, voucher, or URL from an account.
export const CODE = "000000000001";
export const CID = "img1.111.222.gif";
export const FALLBACK = "https://myconsumers.pluxee.co.il/b?fixture=synthetic";
export const BARCODE = "https://myconsumers.pluxee.co.il/b/bar.ashx?fixture=synthetic";

export function gif({ width = 100, height = 2, frames = 1 } = {}) {
  const buffer = new Uint8Array(Math.max(4096, width * height * 3));
  const writer = new omggif.GifWriter(buffer, width, height, { palette: [0xffffff, 0x000000] });
  const pixels = Uint8Array.from({ length: width * height }, (_, i) =>
    (Math.floor(i / width) + Math.floor((i % width) / 3)) % 2);
  for (let frame = 0; frame < frames; frame++) writer.addFrame(0, 0, width, height, pixels);
  return { bytes: buffer.slice(0, writer.end()), pixels, width, height };
}

export function html({
  code = CODE, amount = "123.45", date = "16/09/2026",
  count = 1, fallback = false,
} = {}) {
  return `<html><body>
    <p>מה הזמנת: ${count} שובר לרכישה, ${code} יש להדפיס</p>
    <p>סכום הזמנה: ₪${amount}</p><p>נרכש ב: ${date}</p>
    <img src="cid:${CID}" alt="Synthetic barcode">
    ${fallback ? `<a href="${FALLBACK}">Synthetic fallback</a>` : ""}
    </body></html>`;
}

export function message(overrides = {}) {
  return {
    from: 'Synthetic Fixture <noreply@notifications.pluxee.co.il>',
    subject: "שובר על סך ₪123.45 - חנות בדיקה",
    html: html(),
    labels: [LABELS.candidate, "INBOX"],
    attachments: [{ filename: CID, contentId: CID, contentType: "image/gif", bytes: gif().bytes }],
    ...overrides,
  };
}

export function resource(bytes = gif().bytes, contentType = "image/gif", overrides = {}) {
  return { status: 200, contentType, bytes, ...overrides };
}

export function errorCode(expected) {
  return error => {
    if (error?.code !== expected) {
      throw new Error(`Expected error code ${expected}, received ${error?.code}: ${error?.message}`);
    }
    return true;
  };
}
