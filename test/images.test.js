import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode } from "fast-png";
import omggif from "omggif";
import { normalizeImage, providerUrl, voucherImage } from "../src/images.js";
import { parseVoucher } from "../src/parser.js";
import { BARCODE, CID, CODE, FALLBACK, gif, html, message, resource, errorCode } from "./helpers/fixtures.js";

test("two-pixel GIF becomes PNG with exact nearest-neighbor bars and 32px white margins", () => {
  const source = gif();
  const result = normalizeImage(source.bytes, "image/gif");
  assert.equal(result.contentType, "image/png");
  assert.deepEqual([result.width, result.height], [1064, 304]);
  assert.deepEqual([...result.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const png = decode(result.bytes);
  assert.deepEqual([png.width, png.height, png.channels], [1064, 304, 4]);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const inside = x >= 32 && x < 1032 && y >= 32 && y < 272;
      const expected = inside
        ? (source.pixels[Math.floor((y - 32) * 2 / 240) * 100 + Math.floor((x - 32) / 10)] ? 0 : 255)
        : 255;
      const offset = (y * png.width + x) * 4;
      if (png.data[offset] !== expected || png.data[offset + 1] !== expected
        || png.data[offset + 2] !== expected || png.data[offset + 3] !== 255) {
        assert.fail(`Incorrect pixel at (${x}, ${y}), expected opaque ${expected}`);
      }
    }
  }
});

test("PNG RGB and RGBA sources are accepted and transparency is composited on white", () => {
  for (const channels of [3, 4]) {
    const data = new Uint8Array(100 * channels);
    for (let x = 0; x < 100; x++) {
      data.set(channels === 3 ? [20, 40, 60] : [20, 40, 60, 128], x * channels);
    }
    data.set(channels === 3 ? [0, 0, 0] : [0, 0, 0, 255], 98 * channels);
    data.set(channels === 3 ? [255, 255, 255] : [255, 255, 255, 255], 99 * channels);
    const png = decode(normalizeImage(encode({ width: 100, height: 1, channels, data }),
      "image/png; charset=binary").bytes);
    const offset = (32 * png.width + 32) * 4;
    assert.deepEqual([...png.data.slice(offset, offset + 4)],
      channels === 3 ? [20, 40, 60, 255] : [137, 147, 157, 255]);
  }
});

test("blank black, white and grey GIFs and PNGs have no barcode contrast", () => {
  for (const value of [0, 64, 128, 192, 255]) {
    const buffer = new Uint8Array(4096);
    const color = value * 0x010101;
    const writer = new omggif.GifWriter(buffer, 100, 2, { palette: [color, color] });
    writer.addFrame(0, 0, 100, 2, new Uint8Array(200));
    assert.throws(() => normalizeImage(buffer.slice(0, writer.end()), "image/gif"),
      errorCode("IMAGE_HAS_NO_BARCODE_CONTRAST"));
    const png = encode({ width: 100, height: 2, channels: 3, data: new Uint8Array(600).fill(value) });
    assert.throws(() => normalizeImage(png, "image/png"), errorCode("IMAGE_HAS_NO_BARCODE_CONTRAST"));
  }
});

test("transparent dark bars cannot fake barcode contrast when composited on white", () => {
  const data = new Uint8Array(100 * 2 * 4);
  for (let i = 0; i < 200; i++) {
    data.set(i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 0], i * 4);
  }
  assert.throws(() => normalizeImage(encode({ width: 100, height: 2, channels: 4, data }), "image/png"),
    errorCode("IMAGE_HAS_NO_BARCODE_CONTRAST"));
});

test("contrast thresholds require pixels strictly below 64 and strictly above 192", () => {
  for (const [dark, light, valid] of [[64, 255, false], [0, 192, false], [63, 193, true]]) {
    const data = new Uint8Array(300);
    for (let x = 0; x < 100; x++) data.fill(x % 2 ? dark : light, x * 3, x * 3 + 3);
    const png = encode({ width: 100, height: 1, channels: 3, data });
    if (valid) assert.equal(normalizeImage(png, "image/png").contentType, "image/png");
    else assert.throws(() => normalizeImage(png, "image/png"), errorCode("IMAGE_HAS_NO_BARCODE_CONTRAST"));
  }
});

test("GIF image frames must cover the full logical canvas, including zero offsets", () => {
  for (const [x, y, width, height] of [[0, 0, 99, 2], [0, 0, 100, 1], [1, 0, 99, 2], [0, 1, 100, 1]]) {
    const buffer = new Uint8Array(4096);
    const writer = new omggif.GifWriter(buffer, 100, 2, { palette: [0xffffff, 0x000000] });
    writer.addFrame(x, y, width, height, Uint8Array.from({ length: width * height }, (_, i) => i % 2));
    assert.throws(() => normalizeImage(buffer.slice(0, writer.end()), "image/gif"),
      errorCode("UNSUPPORTED_GIF_FRAME"));
  }
});

test("synthetic 252px attachment and authorized fallback produce identical 1072x304 PNGs", () => {
  const bytes = gif({ width: 252 }).bytes;
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  const attached = voucherImage(voucher,
    [{ contentId: CID, contentType: "image/gif", bytes }], () => assert.fail("attachment must avoid network"));
  const fallback = voucherImage(voucher, [], url => {
    if (url === FALLBACK) return resource(Uint8Array.of(1), "text/html", {
      text: `<img alt="${CODE}" src="/b/bar.ashx?fixture=synthetic">`,
    });
    assert.equal(url, BARCODE);
    return resource(bytes);
  });
  assert.deepEqual([attached.width, attached.height], [1072, 304]);
  assert.deepEqual(fallback.bytes, attached.bytes);
  assert.equal(voucher.purchased, "2026-09-16");
});

test("rejects empty, oversized, unsupported, malformed and animated image data", () => {
  const cases = [
    [new Uint8Array(), "image/gif", "IMAGE_SIZE_LIMIT"],
    [new Uint8Array(2 * 1024 * 1024 + 1), "image/gif", "IMAGE_SIZE_LIMIT"],
    [Uint8Array.of(1, 2, 3), "image/gif", "UNSUPPORTED_IMAGE_FORMAT"],
    [gif().bytes, "image/jpeg", "UNSUPPORTED_IMAGE_FORMAT"],
    [Uint8Array.from([71, 73, 70, 56, 57, 97, 100, 0, 2, 0, 0, 0, 0, 255]), "image/gif", "INVALID_IMAGE_DATA"],
    [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png", "INVALID_IMAGE_DATA"],
    [gif({ frames: 2 }).bytes, "image/gif", "ANIMATED_IMAGE_UNSUPPORTED"],
    [gif({ width: 99 }).bytes, "image/gif", "INVALID_IMAGE_DIMENSIONS"],
  ];
  for (const [bytes, type, code] of cases) assert.throws(() => normalizeImage(bytes, type), errorCode(code));
});

test("checks declared pixel dimensions before decoding and limits output expansion", () => {
  const hugeGif = gif().bytes.slice();
  hugeGif.set([255, 255, 255, 255], 6);
  assert.throws(() => normalizeImage(hugeGif, "image/gif"), errorCode("INVALID_IMAGE_DIMENSIONS"));
  const hugePng = encode({ width: 100, height: 1, channels: 4, data: new Uint8Array(400) });
  new DataView(hugePng.buffer, hugePng.byteOffset, hugePng.byteLength).setUint32(16, 2000001);
  assert.throws(() => normalizeImage(hugePng, "image/png"), errorCode("INVALID_IMAGE_DIMENSIONS"));
  assert.throws(() => normalizeImage(gif({ width: 100, height: 2000 }).bytes, "image/gif"),
    errorCode("IMAGE_SIZE_LIMIT"));
  const grayscale = encode({ width: 100, height: 1, channels: 1, data: new Uint8Array(100) });
  assert.throws(() => normalizeImage(grayscale, "image/png"), errorCode("UNSUPPORTED_PNG_FORMAT"));
});

test("selects attachment by CID or filename without fetching unrelated resources", () => {
  const voucher = parseVoucher(message());
  for (const attachment of [
    { contentId: CID, filename: "synthetic-other.gif" },
    { contentId: "unrelated", filename: CID },
  ]) {
    const result = voucherImage(voucher, [
      { contentId: "logo", filename: "logo.gif", bytes: Uint8Array.of(1), contentType: "image/gif" },
      { ...attachment, bytes: gif().bytes, contentType: "image/gif" },
    ], () => assert.fail("must not fetch when attachment works"));
    assert.equal(result.contentType, "image/png");
  }
  assert.throws(() => voucherImage(voucher, [
    { contentId: CID }, { filename: CID },
  ], () => assert.fail("must not fetch ambiguous attachments")), errorCode("AMBIGUOUS_IMAGE_ATTACHMENT"));
  assert.throws(() => voucherImage(voucher, [], () => assert.fail("no fallback URL")),
    errorCode("MISSING_IMAGE_SOURCE"));
});

test("invalid attachment warns and falls back only when a fallback exists", () => {
  const attachment = { contentId: CID, bytes: Uint8Array.of(1), contentType: "image/gif" };
  const warnings = [];
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  let calls = 0;
  assert.equal(voucherImage(voucher, [attachment], url => {
    assert.equal(url, FALLBACK);
    calls++;
    return resource();
  }, warning => warnings.push(warning)).contentType, "image/png");
  assert.equal(calls, 1);
  assert.deepEqual(warnings, ["UNSUPPORTED_IMAGE_FORMAT"]);
  assert.throws(() => voucherImage({ ...voucher, fallbackUrl: null }, [attachment], () => assert.fail()),
    errorCode("INVALID_ATTACHMENT_NO_FALLBACK"));
});

test("HTML fallback verifies image alt identity and fetches only the provider barcode endpoint", () => {
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  const fetched = [];
  const result = voucherImage(voucher, [], url => {
    fetched.push(url);
    return url === FALLBACK
      ? resource(Uint8Array.of(1), "text/html; charset=utf-8", {
        text: `<img alt="${CODE}" src="/b/bar.ashx?fixture=synthetic">`,
      })
      : resource();
  });
  assert.equal(result.contentType, "image/png");
  assert.deepEqual(fetched, [FALLBACK, BARCODE]);
});

test("relative barcode links resolve against the redirected provider directory", () => {
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  const fetched = [];
  voucherImage(voucher, [], url => {
    fetched.push(url);
    if (fetched.length === 1) return { status: 302, location: "/b/?fixture=synthetic" };
    if (fetched.length === 2) return resource(Uint8Array.of(1), "text/html", {
      text: `<img alt="${CODE}" src="bar.ashx?fixture=synthetic">`,
    });
    return resource();
  });
  assert.deepEqual(fetched, [FALLBACK, "https://myconsumers.pluxee.co.il/b/?fixture=synthetic", BARCODE]);
});

test("fallback identity mismatch, missing/multiple images and unsafe source are rejected before fetch", () => {
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  const cases = [
    ["<p>No image</p>", "FALLBACK_VOUCHER_MISMATCH"],
    [`<img src="${BARCODE}" alt="000000000002">`, "FALLBACK_VOUCHER_MISMATCH"],
    [`<img src="${BARCODE}">`, "FALLBACK_VOUCHER_MISMATCH"],
    [`<img src="${BARCODE}" alt="${CODE}"><img src="${BARCODE}" alt="${CODE}">`, "FALLBACK_VOUCHER_MISMATCH"],
    [`<img src="https://evil.invalid/b/bar.ashx?fixture=synthetic" alt="${CODE}">`, "UNSAFE_IMAGE_URL"],
    [`<img src="${FALLBACK}" alt="${CODE}">`, "UNSUPPORTED_FALLBACK_PAGE"],
    ["x".repeat(100001), "UNSUPPORTED_FALLBACK_PAGE"],
    [undefined, "UNSUPPORTED_FALLBACK_PAGE"],
  ];
  for (const [text, code] of cases) {
    let calls = 0;
    assert.throws(() => voucherImage(voucher, [], () => {
      assert.equal(++calls, 1, "unsafe second request");
      return resource(Uint8Array.of(1), "text/html", { text });
    }), errorCode(code));
  }
});

test("provider URLs allow only the exact HTTPS origin and voucher/barcode paths", () => {
  assert.equal(providerUrl(FALLBACK), FALLBACK);
  assert.equal(providerUrl("/b?fixture=synthetic"), FALLBACK);
  assert.equal(providerUrl("http://myconsumers.pluxee.co.il/b?fixture=synthetic"), FALLBACK);
  assert.equal(providerUrl("bar.ashx?fixture=synthetic"), BARCODE);
  for (const url of [
    "//evil.invalid/b?fixture=synthetic",
    "https://myconsumers.pluxee.co.il.evil.invalid/b?fixture=synthetic",
    "https://myconsumers.pluxee.co.il@evil.invalid/b?fixture=synthetic",
    "https://evil.invalid@myconsumers.pluxee.co.il/b?fixture=synthetic",
    "https://myconsumers.pluxee.co.il:443/b?fixture=synthetic",
    "http://evil.invalid/b?fixture=synthetic",
    "https://myconsumers.pluxee.co.il/other?fixture=synthetic",
    "https://myconsumers.pluxee.co.il/b/../other?fixture=synthetic",
    "https://myconsumers.pluxee.co.il/b/%2e%2e/other?fixture=synthetic",
    `${FALLBACK}#fragment`, `${FALLBACK}\n`, `${FALLBACK}\\x`,
    "javascript:alert(1)", "data:image/gif;base64,AA==", "/b", "", undefined,
  ]) assert.throws(() => providerUrl(url), errorCode("UNSAFE_IMAGE_URL"));
});

test("all supported redirect statuses are manually followed, HTTP provider locations upgraded", () => {
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  for (const status of [301, 302, 303, 307, 308]) {
    const urls = [];
    voucherImage(voucher, [], url => {
      urls.push(url);
      return urls.length === 1
        ? { status, location: "http://myconsumers.pluxee.co.il/b/?fixture=synthetic" }
        : resource();
    });
    assert.deepEqual(urls, [FALLBACK, "https://myconsumers.pluxee.co.il/b/?fixture=synthetic"]);
  }
});

test("redirects cannot escape host/path and loops/HTTP errors/resource size are bounded", () => {
  const voucher = parseVoucher(message({ html: html({ fallback: true }) }));
  for (const location of ["https://evil.invalid/b?fixture=synthetic", "/private?fixture=synthetic", undefined]) {
    let requests = 0;
    assert.throws(() => voucherImage(voucher, [], () => {
      assert.equal(++requests, 1);
      return { status: 302, location };
    }), errorCode("UNSAFE_IMAGE_URL"));
  }
  let requests = 0;
  assert.throws(() => voucherImage(voucher, [], () => {
    requests++;
    return { status: 302, location: FALLBACK };
  }), errorCode("IMAGE_REDIRECT_LIMIT"));
  assert.equal(requests, 4);
  assert.throws(() => voucherImage(voucher, [], () => resource(undefined, undefined, { status: 503 })),
    errorCode("IMAGE_HTTP_ERROR"));
  for (const bytes of [new Uint8Array(), new Uint8Array(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => voucherImage(voucher, [], () => resource(bytes)), errorCode("IMAGE_SIZE_LIMIT"));
  }
});
