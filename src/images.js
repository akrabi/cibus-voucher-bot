import omggif from "omggif";
import { decode, encode } from "fast-png";
import { tags } from "./parser.js";
import { requireValue, VoucherError, safeCode } from "./errors.js";

const ORIGIN = "https://myconsumers.pluxee.co.il";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 2000000;

// A narrowly scoped URL resolver also works in Apps Script, which has no URL global.
export function providerUrl(value, base = `${ORIGIN}/b/`) {
  requireValue(typeof value === "string" && !/[\s\\#]/.test(value), "UNSAFE_IMAGE_URL");
  let url = value;
  if (url.startsWith("/")) {
    requireValue(!url.startsWith("//"), "UNSAFE_IMAGE_URL");
    url = ORIGIN + url;
  } else if (!/^https?:\/\//i.test(url)) {
    requireValue(/^(?:bar\.ashx\?|[?])/.test(url), "UNSAFE_IMAGE_URL");
    url = base.split("?")[0].replace(/[^/]*$/, "") + url;
  }
  // This provider issues an HTTP Location for /b -> /b/. Never send it over HTTP.
  url = url.replace(/^http:\/\/myconsumers\.pluxee\.co\.il\//i, `${ORIGIN}/`);
  requireValue(/^https:\/\/myconsumers\.pluxee\.co\.il\/b(?:\/(?:bar\.ashx)?)?\?[^#\s]+$/i.test(url),
    "UNSAFE_IMAGE_URL");
  return url;
}

function getResource(url, fetchResource) {
  let current = providerUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    const response = fetchResource(current);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      current = providerUrl(response.location, current);
      continue;
    }
    requireValue(response.status === 200, "IMAGE_HTTP_ERROR");
    requireValue(response.bytes.length > 0 && response.bytes.length <= MAX_BYTES, "IMAGE_SIZE_LIMIT");
    return { ...response, url: current };
  }
  throw new VoucherError("IMAGE_REDIRECT_LIMIT");
}

export function normalizeImage(bytes, contentType) {
  requireValue(bytes.length > 0 && bytes.length <= MAX_BYTES, "IMAGE_SIZE_LIMIT");
  let width, height, rgba;
  try {
    if (/^image\/gif(?:;|$)/i.test(contentType) &&
      String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/)) {
      const reader = new omggif.GifReader(bytes);
      ({ width, height } = reader);
      requireValue(reader.numFrames() === 1, "ANIMATED_IMAGE_UNSUPPORTED");
      requireValue(width >= 100 && height >= 1 && width * height <= MAX_PIXELS, "INVALID_IMAGE_DIMENSIONS");
      const frame = reader.frameInfo(0);
      requireValue(frame.x === 0 && frame.y === 0 && frame.width === width && frame.height === height,
        "UNSUPPORTED_GIF_FRAME");
      rgba = new Uint8Array(width * height * 4);
      reader.decodeAndBlitFrameRGBA(0, rgba);
    } else if (/^image\/png(?:;|$)/i.test(contentType) &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) {
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      width = header.getUint32(16);
      height = header.getUint32(20);
      requireValue(width >= 100 && height >= 1 && width * height <= MAX_PIXELS, "INVALID_IMAGE_DIMENSIONS");
      const image = decode(bytes);
      requireValue(image.depth === 8 && [3, 4].includes(image.channels), "UNSUPPORTED_PNG_FORMAT");
      rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba.set(image.data.subarray(i * image.channels, i * image.channels + 3), i * 4);
        rgba[i * 4 + 3] = image.channels === 4 ? image.data[i * 4 + 3] : 255;
      }
    } else {
      throw new VoucherError("UNSUPPORTED_IMAGE_FORMAT");
    }
    let darkPixels = 0;
    let lightPixels = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = rgba[i + 3] / 255;
      const lightness = ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3) * alpha + 255 * (1 - alpha);
      if (lightness < 64) darkPixels++;
      if (lightness > 192) lightPixels++;
    }
    requireValue(darkPixels > 0 && lightPixels > 0, "IMAGE_HAS_NO_BARCODE_CONTRAST");
    // Preserve discrete bars, especially the source's two-pixel-high GIF.
    const scale = width < 1000 ? Math.ceil(1000 / width) : 1;
    const targetWidth = width * scale;
    const targetHeight = Math.max(240, height * scale);
    const margin = 32;
    const outputWidth = targetWidth + 2 * margin;
    const outputHeight = targetHeight + 2 * margin;
    requireValue(outputWidth * outputHeight <= MAX_PIXELS, "IMAGE_SIZE_LIMIT");
    const data = new Uint8Array(outputWidth * outputHeight * 4).fill(255);
    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const src = (Math.floor(y * height / targetHeight) * width + Math.floor(x / scale)) * 4;
        const dst = ((y + margin) * outputWidth + x + margin) * 4;
        const alpha = rgba[src + 3] / 255;
        for (let c = 0; c < 3; c++) data[dst + c] = Math.round(rgba[src + c] * alpha + 255 * (1 - alpha));
      }
    }
    return { bytes: encode({ width: outputWidth, height: outputHeight, data, channels: 4 }),
      contentType: "image/png", width: outputWidth, height: outputHeight };
  } catch (error) {
    if (error instanceof VoucherError) throw error;
    throw new VoucherError("INVALID_IMAGE_DATA");
  }
}

export function voucherImage(voucher, attachments, fetchResource, warn = () => {}) {
  const matches = attachments.filter(a => a.contentId === voucher.imageReference || a.filename === voucher.imageReference);
  requireValue(matches.length <= 1, "AMBIGUOUS_IMAGE_ATTACHMENT");
  if (matches.length) {
    try {
      const attachment = matches[0];
      return normalizeImage(attachment.bytes, attachment.contentType);
    } catch (error) {
      warn(safeCode(error));
      requireValue(voucher.fallbackUrl, "INVALID_ATTACHMENT_NO_FALLBACK");
    }
  }
  requireValue(voucher.fallbackUrl, "MISSING_IMAGE_SOURCE");
  let resource = getResource(voucher.fallbackUrl, fetchResource);
  if (/^text\/html(?:;|$)/i.test(resource.contentType)) {
    requireValue(typeof resource.text === "string" && resource.text.length <= 100000, "UNSUPPORTED_FALLBACK_PAGE");
    const images = tags(resource.text, "img");
    requireValue(images.length === 1 && images[0].alt === voucher.code, "FALLBACK_VOUCHER_MISMATCH");
    const imageUrl = providerUrl(images[0].src, resource.url);
    requireValue(imageUrl.startsWith(`${ORIGIN}/b/bar.ashx?`), "UNSUPPORTED_FALLBACK_PAGE");
    resource = getResource(imageUrl, fetchResource);
  }
  return normalizeImage(resource.bytes, resource.contentType);
}
