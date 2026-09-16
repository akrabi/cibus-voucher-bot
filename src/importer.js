import { parseVoucher, caption } from "./parser.js";
import { voucherImage } from "./images.js";
import { safeCode } from "./errors.js";

export const LABELS = {
  candidate: "Cibus/Candidate",
  processing: "Cibus/Processing",
  imported: "Cibus/Imported",
  review: "Cibus/Review-needed",
};

export function importMessage(id, ports, { dryRun = false } = {}) {
  let phase = "PREPARING";
  try {
    const message = ports.getMessage(id);
    if (message.labels.includes(LABELS.imported)) {
      if (!dryRun) ports.finalize(id);
      return { id, status: "ALREADY_IMPORTED" };
    }
    if (message.labels.includes(LABELS.processing) || message.labels.includes(LABELS.review)) {
      return { id, status: "REVIEW_REQUIRED" };
    }
    const voucher = parseVoucher(message);
    const key = ports.voucherKey(voucher.code);
    if (ports.hasOtherSource(key, id)) {
      if (!dryRun) ports.review(id);
      ports.log(id, "DUPLICATE_VOUCHER");
      return { id, status: "DUPLICATE_VOUCHER" };
    }
    const image = voucherImage(voucher, message.attachments, ports.fetchResource,
      code => ports.log(id, `ATTACHMENT_FALLBACK_${code}`));
    const text = caption(voucher, id);
    if (dryRun) return { id, status: "READY", caption: text, width: image.width, height: image.height };
    // Claim the voucher before the non-idempotent send. Keep this claim on failure.
    ports.claim(id, key);
    phase = "SENDING";
    ports.send(image, text);
    phase = "FINALIZING";
    ports.finalize(id);
    return { id, status: "IMPORTED" };
  } catch (error) {
    const code = safeCode(error);
    ports.log(id, `${phase}_${code}`);
    if (!dryRun) ports.review(id);
    return { id, status: "REVIEW_REQUIRED", reason: `${phase}_${code}` };
  }
}
