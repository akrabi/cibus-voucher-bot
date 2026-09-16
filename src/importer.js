import { parseVoucher, caption, voucherFilename } from "./parser.js";
import { voucherImage } from "./images.js";
import { safeCode, safeErrorDetails } from "./errors.js";

export const LABELS = {
  candidate: "Cibus/Candidate",
  processing: "Cibus/Processing",
  imported: "Cibus/Imported",
  review: "Cibus/Review-needed",
};

export function importMessage(id, ports, { dryRun = false } = {}) {
  let phase = "PREPARING";
  let operation = "READ_EMAIL";
  try {
    const message = ports.getMessage(id);
    if (message.labels.includes(LABELS.imported)) {
      operation = "FINALIZE_ARCHIVE";
      if (!dryRun) ports.finalize(id);
      return { id, status: "ALREADY_IMPORTED" };
    }
    if (message.labels.includes(LABELS.processing) || message.labels.includes(LABELS.review)) {
      return { id, status: "REVIEW_REQUIRED" };
    }
    operation = "PARSE_VOUCHER";
    const voucher = parseVoucher(message);
    operation = "IDENTIFY_VOUCHER";
    const key = ports.voucherKey(voucher.code);
    operation = "CHECK_DUPLICATE";
    if (ports.hasOtherSource(key, id)) {
      if (!dryRun) ports.review(id);
      ports.log(id, "DUPLICATE_VOUCHER");
      return { id, status: "DUPLICATE_VOUCHER" };
    }
    operation = "LOAD_IMAGE";
    const image = voucherImage(voucher, message.attachments, ports.fetchResource,
      code => ports.log(id, `ATTACHMENT_FALLBACK_${code}`));
    operation = "BUILD_CAPTION";
    const text = caption(voucher, id);
    const document = { ...image, filename: voucherFilename(voucher) };
    if (dryRun) return { id, status: "READY",
      caption: caption(voucher, id, { redactVoucherNumber: true }), width: image.width, height: image.height };
    // Claim the voucher before the non-idempotent send. Keep this claim on failure.
    operation = "CLAIM_VOUCHER";
    ports.claim(id, key);
    phase = "SENDING";
    operation = "SEND_TELEGRAM";
    ports.send(document, text);
    phase = "FINALIZING";
    operation = "FINALIZE_ARCHIVE";
    ports.finalize(id);
    return { id, status: "IMPORTED" };
  } catch (error) {
    const code = safeCode(error);
    if (code === "UNEXPECTED_ERROR") {
      ports.log(id, `${phase}_${code}`, { operation, ...safeErrorDetails(error) });
    } else {
      ports.log(id, `${phase}_${code}`);
    }
    if (!dryRun) ports.review(id);
    return { id, status: "REVIEW_REQUIRED", reason: `${phase}_${code}` };
  }
}
