import test from "node:test";
import assert from "node:assert/strict";
import { parseVoucher, caption, voucherFilename, purchaseDate, decodeHtml, attributes } from "../src/parser.js";
import { CODE, CID, FALLBACK, html, message, errorCode } from "./helpers/fixtures.js";

test("parses a synthetic Hebrew voucher's value and purchase date without an expiry", () => {
  const voucher = parseVoucher(message());
  assert.deepEqual(voucher, {
    code: CODE, valueCents: 12345, currency: "ILS", purchased: "2026-09-16",
    retailer: "חנות בדיקה", imageReference: CID, fallbackUrl: null,
  });
  assert.equal(caption(voucher, "message_1"),
    `חנות בדיקה\nValue: ILS 123.45\nPurchased: 16 Sep 2026\nVoucher: ${CODE}\nSource: message_1`);
  assert.equal(voucherFilename(voucher), `voucher-${CODE}.png`);
  assert.ok(!caption(voucher, "message_1").includes("Expiry"));
});

test("decodes HTML entities, nested formatting, directional marks and comma-separated value", () => {
  const source = message({
    subject: "שובר על סך ₪1,234.50 - Synthetic & Store",
    from: "NOREPLY@NOTIFICATIONS.PLUXEE.CO.IL",
    html: html({ amount: "1,234.50", fallback: true })
      .replace("סכום הזמנה:", "<strong>סכום הזמנה:</strong>\u200f&nbsp;")
      .replace("₪", "&#8362;")
      .replace("נרכש ב:", "<b>נרכש ב:</b>")
      .replace("</body>", "<script>סכום הזמנה: ₪999.00</script></body>"),
  });
  assert.equal(parseVoucher(source).valueCents, 123450);
  assert.equal(parseVoucher(source).fallbackUrl, FALLBACK);
  assert.equal(decodeHtml("&lt;&gt;&amp;&quot;&apos;&#x5d0;"), '<>&"\'א');
  assert.deepEqual(attributes('<img SRC="cid:fixture" alt=\'A &amp; B\'>'), {
    src: "cid:fixture", alt: "A & B",
  });
});

test("subject and body must agree on value", () => {
  assert.throws(() => parseVoucher(message({ html: html({ amount: "123.46" }) })),
    errorCode("CONFLICTING_VALUE"));
});

for (const amount of ["0.00", "123", "123.4", "1,23.45", "900719925474099.99"]) {
  test(`rejects invalid or unsafe monetary value ${amount}`, () => {
    assert.throws(() => parseVoucher(message({
      subject: `שובר על סך ₪${amount} - בדיקה`, html: html({ amount }),
    })), errorCode("INVALID_VALUE"));
  });
}

test("supports exactly one voucher and one identified barcode", () => {
  for (const count of [0, 2, 3]) {
    assert.throws(() => parseVoucher(message({ html: html({ count }) })),
      errorCode("UNSUPPORTED_VOUCHER_SECTION"));
  }
  assert.throws(() => parseVoucher(message({ html: html() + html() })),
    errorCode("UNSUPPORTED_VOUCHER_SECTION"));
  for (const code of ["12345", "0".repeat(25), "not-a-code"]) {
    assert.throws(() => parseVoucher(message({ html: html({ code }) })),
      errorCode("UNSUPPORTED_VOUCHER_SECTION"));
  }
  assert.throws(() => parseVoucher(message({ html: html().replace(`cid:${CID}`, "cid:logo") })),
    errorCode("MISSING_OR_AMBIGUOUS_BARCODE_IMAGE"));
  assert.throws(() => parseVoucher(message({ html: html() + `<img src="cid:${CID}">` })),
    errorCode("MISSING_OR_AMBIGUOUS_BARCODE_IMAGE"));
});

test("missing and ambiguous body fields are rejected", () => {
  const cases = [
    [html().replace("סכום הזמנה:", "מחיר:"), "MISSING_OR_AMBIGUOUS_VALUE"],
    [html() + "<p>סכום הזמנה: ₪123.45</p>", "MISSING_OR_AMBIGUOUS_VALUE"],
    [html().replace("נרכש ב:", "תאריך:"), "MISSING_OR_AMBIGUOUS_PURCHASE_DATE"],
    [html() + "<p>נרכש ב: 16/09/2026</p>", "MISSING_OR_AMBIGUOUS_PURCHASE_DATE"],
  ];
  for (const [body, code] of cases) assert.throws(() => parseVoucher(message({ html: body })), errorCode(code));
});

test("validates calendar dates, leap years and supported year range", () => {
  assert.equal(purchaseDate("29/02/2024"), "2024-02-29");
  assert.equal(purchaseDate("01/01/2000"), "2000-01-01");
  assert.equal(purchaseDate("31/12/2100"), "2100-12-31");
  for (const date of ["29/02/2025", "31/04/2026", "00/01/2026", "01/13/2026",
    "01/01/1999", "01/01/2101", "1/01/2026", "2026-09-16"]) {
    assert.throws(() => purchaseDate(date), errorCode("INVALID_PURCHASE_DATE"));
  }
});

test("only the exact expected sender and Hebrew subject template are accepted", () => {
  for (const from of ["", "attacker@example.invalid", "noreply@notifications.pluxee.co.il.evil.invalid",
    "Spoof <noreply@notifications.pluxee.co.il> <attacker@example.invalid>"]) {
    assert.throws(() => parseVoucher(message({ from })), errorCode("UNEXPECTED_SENDER"));
  }
  for (const subject of ["", "Voucher 123.45", "Re: שובר על סך ₪123.45 - בדיקה"]) {
    assert.throws(() => parseVoucher(message({ subject })), errorCode("UNSUPPORTED_SUBJECT"));
  }
  for (const body of [null, "x".repeat(500001)]) {
    assert.throws(() => parseVoucher(message({ html: body })), errorCode("INVALID_EMAIL_HTML"));
  }
});

test("identical fallback links are deduplicated, different ones require review", () => {
  const body = html({ fallback: true });
  assert.equal(parseVoucher(message({ html: body + `<a href="${FALLBACK}">Again</a>` })).fallbackUrl, FALLBACK);
  assert.throws(() => parseVoucher(message({
    html: body + '<a href="https://myconsumers.pluxee.co.il/b?fixture=other-synthetic">Other</a>',
  })), errorCode("AMBIGUOUS_FALLBACK"));
});

test("caption includes the voucher number but excludes private links; previews redact the number", () => {
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  const text = caption(voucher, "synthetic-id");
  assert.ok(text.includes(`Voucher: ${CODE}`));
  assert.ok(!text.includes(FALLBACK));
  const preview = caption(voucher, "synthetic-id", { redactVoucherNumber: true });
  assert.ok(preview.includes("Voucher: [redacted]"));
  assert.ok(!preview.includes(CODE));
  assert.ok(!preview.includes(FALLBACK));
  for (const id of ["", "../secret", "line\nbreak", "x".repeat(101)]) {
    assert.throws(() => caption(voucher, id), errorCode("INVALID_SOURCE_ID"));
  }
  assert.throws(() => caption({ ...voucher, retailer: "x".repeat(1024) }, "id"),
    errorCode("CAPTION_TOO_LONG"));
  assert.throws(() => decodeHtml("&#1114112;"), errorCode("INVALID_HTML_ENTITY"));
});

test("voucher numbers stay exact strings in captions and filenames, including leading zeros and long codes", () => {
  for (const code of ["000123", "000000000000123456789012", "9".repeat(24)]) {
    const voucher = parseVoucher(message({ html: html({ code }) }));
    assert.equal(voucherFilename(voucher), `voucher-${code}.png`);
    assert.ok(caption(voucher, "id").includes(`\nVoucher: ${code}\n`));
  }
  for (const code of [123456, "../123456", "123456\n", "1".repeat(25), "12345"]) {
    const voucher = { ...parseVoucher(message()), code };
    assert.throws(() => voucherFilename(voucher), errorCode("INVALID_VOUCHER_NUMBER"));
    assert.throws(() => caption(voucher, "id"), errorCode("INVALID_VOUCHER_NUMBER"));
  }
});
