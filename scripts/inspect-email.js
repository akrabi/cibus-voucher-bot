import { readFile } from "node:fs/promises";
import { simpleParser } from "mailparser";
import { parseVoucher, caption } from "../src/parser.js";
import { voucherImage } from "../src/images.js";
import { VoucherError, safeCode } from "../src/errors.js";

const [path, flag] = process.argv.slice(2);
if (!path || (flag && flag !== "--fetch-fallback")) {
  console.error('Usage: npm run inspect-email -- "C:\\path\\voucher.eml" [--fetch-fallback]');
  process.exitCode = 1;
} else {
  try {
    const mail = await simpleParser(await readFile(path));
    const voucher = parseVoucher({ from: mail.from?.text, subject: mail.subject, html: mail.html });
    const attachments = mail.attachments.map(a => ({
      filename: a.filename, contentId: a.contentId?.replace(/^<|>$/g, ""),
      contentType: a.contentType, bytes: new Uint8Array(a.content),
    }));
    // Production fetch is synchronous; inspect approved fallback responses into a local cache.
    const resources = new Map();
    if (flag === "--fetch-fallback") {
      const { providerUrl } = await import("../src/images.js");
      const { tags } = await import("../src/parser.js");
      let url = providerUrl(voucher.fallbackUrl);
      for (let hop = 0; hop < 8; hop++) {
        const response = await fetch(url, {
          redirect: "manual", signal: AbortSignal.timeout(30000),
          headers: { "User-Agent": "CibusVoucherBot/0.1" },
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 2 * 1024 * 1024) throw new VoucherError("IMAGE_SIZE_LIMIT");
        const contentType = response.headers.get("content-type") || "";
        const text = /^text\/html/i.test(contentType) ? new TextDecoder().decode(bytes) : undefined;
        resources.set(url, { status: response.status, bytes, contentType, text, location: response.headers.get("location") });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          url = providerUrl(response.headers.get("location"), url);
        } else if (response.status === 200 && text) {
          const images = tags(text, "img");
          if (images.length !== 1 || images[0].alt !== voucher.code) throw new VoucherError("FALLBACK_VOUCHER_MISMATCH");
          url = providerUrl(images[0].src, url);
        } else break;
      }
    }
    const fetchResource = url => {
      if (!resources.has(url)) throw new VoucherError("FALLBACK_NOT_FETCHED");
      return resources.get(url);
    };
    const image = voucherImage(voucher, attachments, fetchResource, code => console.warn(code));
    const result = { caption: caption(voucher, "local-preview", { redactVoucherNumber: true }),
      image: { width: image.width, height: image.height, bytes: image.bytes.length } };
    if (flag === "--fetch-fallback") {
      const fallback = voucherImage(voucher, [], fetchResource);
      result.fallback = { width: fallback.width, height: fallback.height, matchesAttachment: Buffer.from(image.bytes).equals(Buffer.from(fallback.bytes)) };
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Inspection failed: ${safeCode(error)}. No email or voucher URL has been logged.`);
    process.exitCode = 1;
  }
}
