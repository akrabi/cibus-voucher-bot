import { requireValue } from "./errors.js";

export const SENDER = "noreply@notifications.pluxee.co.il";

export function decodeHtml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (code[0] !== "#") return named[code.toLowerCase()];
    const number = code[1].toLowerCase() === "x"
      ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    requireValue(number > 0 && number <= 0x10ffff, "INVALID_HTML_ENTITY");
    return String.fromCodePoint(number);
  });
}

export function attributes(tag) {
  const result = {};
  const pattern = /([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of tag.matchAll(pattern)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

export function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(m => attributes(m[0]));
}

function textContent(html) {
  return decodeHtml(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")).replace(/[\s\u200e\u200f]+/g, " ").trim();
}

function oneMatch(text, pattern, code) {
  const matches = [...text.matchAll(pattern)];
  requireValue(matches.length === 1, code);
  return matches[0];
}

function money(value) {
  requireValue(/^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(value), "INVALID_VALUE");
  const cents = Number(value.replace(/[,.]/g, ""));
  requireValue(Number.isSafeInteger(cents) && cents > 0, "INVALID_VALUE");
  return cents;
}

export function purchaseDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  requireValue(match, "INVALID_PURCHASE_DATE");
  const [, day, month, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  requireValue(year >= 2000 && year <= 2100 && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day, "INVALID_PURCHASE_DATE");
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseVoucher(message) {
  requireValue(typeof message.html === "string" && message.html.length <= 500000, "INVALID_EMAIL_HTML");
  const from = (message.from || "").trim();
  const address = /<([^<>]+)>$/.exec(from)?.[1] ?? from;
  requireValue(address.toLowerCase() === SENDER, "UNEXPECTED_SENDER");
  const subject = oneMatch(message.subject || "",
    /^שובר על סך ₪([\d,.]+) - (.+)$/g, "UNSUPPORTED_SUBJECT");
  const text = textContent(message.html);
  const order = oneMatch(text,
    /מה הזמנת:\s*1 שובר לרכישה,\s*(\d{6,24})\s+יש להדפיס/g,
    "UNSUPPORTED_VOUCHER_SECTION");
  const amount = oneMatch(text, /סכום הזמנה:\s*₪([\d,.]+)/g, "MISSING_OR_AMBIGUOUS_VALUE");
  const date = oneMatch(text, /נרכש ב:\s*(\d{2}\/\d{2}\/\d{4})/g, "MISSING_OR_AMBIGUOUS_PURCHASE_DATE");
  const valueCents = money(subject[1]);
  requireValue(valueCents === money(amount[1]), "CONFLICTING_VALUE");
  const images = tags(message.html, "img").filter(image => /^cid:img1\.\d+\.\d+\.gif$/i.test(image.src || ""));
  requireValue(images.length === 1, "MISSING_OR_AMBIGUOUS_BARCODE_IMAGE");
  const links = [...new Set(tags(message.html, "a").map(a => a.href)
    .filter(href => /^https:\/\/myconsumers\.pluxee\.co\.il\/b\/?\?[^#]+$/i.test(href || "")))];
  requireValue(links.length <= 1, "AMBIGUOUS_FALLBACK");
  return {
    code: order[1],
    valueCents,
    currency: "ILS",
    purchased: purchaseDate(date[1]),
    retailer: subject[2].trim(),
    imageReference: images[0].src.slice(4),
    fallbackUrl: links[0] || null,
  };
}

function voucherNumber(voucher) {
  requireValue(typeof voucher.code === "string" && voucher.code.length >= 6 && voucher.code.length <= 24
    && !/\D/.test(voucher.code), "INVALID_VOUCHER_NUMBER");
  return voucher.code;
}

export function voucherFilename(voucher) {
  return `voucher-${voucherNumber(voucher)}.png`;
}

export function caption(voucher, sourceId, { redactVoucherNumber = false } = {}) {
  requireValue(/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId), "INVALID_SOURCE_ID");
  const number = voucherNumber(voucher);
  const [year, month, day] = voucher.purchased.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const value = (voucher.valueCents / 100).toFixed(2);
  const result = `${voucher.retailer}\nValue: ${voucher.currency} ${value}\nPurchased: ${day} ${months[Number(month) - 1]} ${year}\nVoucher: ${redactVoucherNumber ? "[redacted]" : number}\nSource: ${sourceId}`;
  requireValue(result.length <= 1024, "CAPTION_TOO_LONG");
  return result;
}
