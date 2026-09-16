import { importMessage, LABELS } from "./importer.js";
import { requireValue, VoucherError } from "./errors.js";

function config() {
  const values = PropertiesService.getScriptProperties().getProperties();
  requireValue(/^\d+:[A-Za-z0-9_-]+$/.test(values.TELEGRAM_BOT_TOKEN || ""), "CONFIG_BOT_TOKEN");
  requireValue(/^-\d+$/.test(values.TELEGRAM_CHAT_ID || ""), "CONFIG_GROUP_CHAT_ID");
  requireValue(values.EXPECTED_GMAIL_ACCOUNT, "CONFIG_EXPECTED_GMAIL_ACCOUNT");
  requireValue(Gmail.Users.getProfile("me").emailAddress.toLowerCase() === values.EXPECTED_GMAIL_ACCOUNT.toLowerCase(),
    "WRONG_GMAIL_ACCOUNT");
  return values;
}

function retryGmail(action) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return action();
    } catch {
      if (attempt === 2) throw new VoucherError("GMAIL_OPERATION_FAILED");
      Utilities.sleep(500 * (attempt + 1));
    }
  }
}

function gmailPorts(settings) {
  const labels = new Map((Gmail.Users.Labels.list("me").labels || []).map(l => [l.name, l.id]));
  const names = new Map([...labels].map(([name, id]) => [id, name]));
  function label(name) {
    if (!labels.has(name)) {
      let created;
      try {
        created = Gmail.Users.Labels.create({ name, labelListVisibility: "labelHide", messageListVisibility: "show" }, "me");
      } catch {
        throw new VoucherError("GMAIL_LABEL_CREATE_FAILED");
      }
      labels.set(name, created.id);
      names.set(created.id, name);
    }
    return labels.get(name);
  }
  Object.values(LABELS).forEach(label);
  function modify(id, add, remove = []) {
    return retryGmail(() => Gmail.Users.Messages.modify({
      addLabelIds: add.map(label),
      removeLabelIds: remove.map(name => name === "INBOX" ? name : label(name)),
    }, "me", id));
  }
  function rawBytes(body, id) {
    const data = body?.data ?? (body?.attachmentId
      ? Gmail.Users.Messages.Attachments.get("me", id, body.attachmentId).data : undefined);
    requireValue(data != null, "MISSING_GMAIL_BODY_DATA");
    function checkedBytes(bytes) {
      requireValue(body?.size == null || bytes.length === body.size, "GMAIL_BODY_SIZE_MISMATCH");
      return bytes;
    }
    // The Apps Script advanced service can expose decoded bytes instead of REST Base64 text.
    if (Array.isArray(data)) {
      requireValue(Array.from(data).every(byte => Number.isInteger(byte) && byte >= -128 && byte <= 255),
        "INVALID_GMAIL_BODY_BYTES");
      return checkedBytes(new Uint8Array(Array.from(data, byte => byte & 255)));
    }
    function invalidEncoding() {
      const text = typeof data === "string" ? data : "";
      console.error(JSON.stringify({
        source: id, code: "GMAIL_BODY_ENCODING_DETAILS",
        dataType: typeof data, isArray: Array.isArray(data),
        lengthModuloFour: typeof data === "string" ? data.length % 4 : null,
        standardAlphabet: /[+/]/.test(text), urlSafeAlphabet: /[-_]/.test(text),
        whitespace: /[ \t\r\n]/.test(text),
        unexpectedCharacters: /[^A-Za-z0-9+/_= \t\r\n-]/.test(text),
      }));
      throw new VoucherError("INVALID_GMAIL_BODY_ENCODING");
    }
    if (typeof data !== "string") invalidEncoding();
    const normalized = data.replace(/[ \t\r\n]/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(normalized)) invalidEncoding();
    const unpadded = normalized.replace(/=+$/, "");
    const padding = (4 - unpadded.length % 4) % 4;
    if (unpadded.length % 4 === 1
      || (normalized !== unpadded && normalized.length - unpadded.length !== padding)) invalidEncoding();
    // Normalize both Base64 alphabets and restore padding for the native decoder.
    const padded = unpadded + "=".repeat(padding);
    let bytes;
    try {
      bytes = new Uint8Array(Array.from(Utilities.base64DecodeWebSafe(padded), b => b & 255));
    } catch {
      throw new VoucherError("GMAIL_BODY_DECODE_FAILED");
    }
    return checkedBytes(bytes);
  }
  function getMessage(id) {
    const message = Gmail.Users.Messages.get("me", id, { format: "full" });
    const header = name => message.payload.headers.find(h => h.name.toLowerCase() === name)?.value || "";
    const html = [];
    const attachments = [];
    function walk(part) {
      if (part.mimeType === "text/html") {
        requireValue((part.body?.size || 0) <= 500000, "EMAIL_HTML_TOO_LARGE");
        html.push(Utilities.newBlob(Array.from(rawBytes(part.body, id), b => b > 127 ? b - 256 : b)).getDataAsString("UTF-8"));
      } else if (part.mimeType?.startsWith("image/")) {
        const cid = part.headers?.find(h => h.name.toLowerCase() === "content-id")?.value.replace(/^<|>$/g, "");
        // Do not download unrelated logos or tracking images.
        if (/^img1\.\d+\.\d+\.gif$/i.test(part.filename || "") || /^img1\.\d+\.\d+\.gif$/i.test(cid || "")) {
          requireValue((part.body?.size || 0) <= 2 * 1024 * 1024, "IMAGE_SIZE_LIMIT");
          attachments.push({ filename: part.filename, contentId: cid, contentType: part.mimeType, bytes: rawBytes(part.body, id) });
        }
      }
      (part.parts || []).forEach(walk);
    }
    walk(message.payload);
    requireValue(html.length === 1, "UNSUPPORTED_MIME_STRUCTURE");
    return { from: header("from"), subject: header("subject"), html: html[0], attachments,
      labels: (message.labelIds || []).map(id => names.get(id) || id) };
  }
  return {
    getMessage,
    voucherKey(code) {
      const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `cibus-v1:${code}`, Utilities.Charset.UTF_8);
      return `Cibus/Key/${bytes.map(b => (b & 255).toString(16).padStart(2, "0")).join("")}`;
    },
    hasOtherSource(key, id) {
      if (!labels.has(key)) return false;
      const messages = Gmail.Users.Messages.list("me", { labelIds: [labels.get(key)], maxResults: 2, includeSpamTrash: true }).messages || [];
      return messages.some(message => message.id !== id);
    },
    claim: (id, key) => modify(id, [LABELS.processing, key]),
    finalize: id => modify(id, [LABELS.imported], [LABELS.processing, LABELS.review, "INBOX"]),
    review: id => modify(id, [LABELS.review]),
    fetchResource(url) {
      let response;
      try {
        response = UrlFetchApp.fetch(url, {
          followRedirects: false, muteHttpExceptions: true,
          headers: { "User-Agent": "CibusVoucherBot/0.1" },
        });
      } catch {
        throw new VoucherError("IMAGE_NETWORK_ERROR");
      }
      const headers = Object.fromEntries(Object.entries(response.getAllHeaders()).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const contentType = headers["content-type"] || "";
      return { status: response.getResponseCode(), contentType, location: headers.location,
        bytes: new Uint8Array(response.getContent().map(b => b & 255)),
        text: /^text\/html/i.test(contentType) ? response.getContentText("UTF-8") : undefined };
    },
    send(image, text) {
      requireValue(typeof image.filename === "string" && image.filename === image.filename.trim()
        && /^voucher-\d{6,24}\.png$/.test(image.filename),
        "INVALID_VOUCHER_FILENAME");
      const blob = Utilities.newBlob(Array.from(image.bytes, b => b > 127 ? b - 256 : b), "image/png", image.filename);
      let response;
      try {
        response = UrlFetchApp.fetch(`https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/sendDocument`, {
          method: "post", muteHttpExceptions: true, followRedirects: false,
          payload: { chat_id: settings.TELEGRAM_CHAT_ID, document: blob, caption: text },
        });
      } catch {
        throw new VoucherError("TELEGRAM_DELIVERY_UNCERTAIN");
      }
      let body;
      try {
        body = JSON.parse(response.getContentText());
      } catch {
        throw new VoucherError("TELEGRAM_DELIVERY_UNCERTAIN");
      }
      requireValue(response.getResponseCode() === 200 && body.ok === true
        && Number.isInteger(body.result?.message_id)
        && String(body.result?.chat?.id) === settings.TELEGRAM_CHAT_ID, "TELEGRAM_NOT_CONFIRMED");
    },
    log(id, code, details) { console.error(JSON.stringify({ source: id, code, details })); },
    list(query, limit = 20) {
      return (Gmail.Users.Messages.list("me", { q: query, maxResults: limit }).messages || []).map(m => m.id);
    },
  };
}

function locked(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.warn("IMPORT_ALREADY_RUNNING");
    return;
  }
  try { return action(); } finally { lock.releaseLock(); }
}

const candidates = `label:${LABELS.candidate} -label:${LABELS.imported} -label:${LABELS.processing} -label:${LABELS.review}`;

export function runImport() {
  return locked(() => {
    const settings = config();
    requireValue(settings.IMPORT_ENABLED === "true", "IMPORT_DISABLED");
    const ports = gmailPorts(settings);
    const started = Date.now();
    // Stale claims are never automatically resent.
    for (const id of ports.list(`label:${LABELS.processing} -label:${LABELS.imported} -label:${LABELS.review}`)) {
      ports.review(id);
      ports.log(id, "INTERRUPTED_DELIVERY_REVIEW_REQUIRED");
    }
    for (const id of ports.list(`label:${LABELS.imported} in:inbox`)) ports.finalize(id);
    const results = [];
    for (const id of ports.list(candidates)) {
      if (Date.now() - started > 240000) break;
      const result = importMessage(id, ports);
      results.push(result);
      console.log(JSON.stringify(result));
      Utilities.sleep(1100);
    }
    return results;
  });
}

export function previewImport() {
  return locked(() => {
    const ports = gmailPorts(config());
    const results = ports.list(candidates, 1).map(id => importMessage(id, ports, { dryRun: true }));
    console.log(JSON.stringify(results));
    return results;
  });
}

export function enableSchedule() {
  return locked(() => {
    const settings = config();
    requireValue(settings.IMPORT_ENABLED === "true", "IMPORT_DISABLED");
    const previous = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "runImport");
    const replacement = ScriptApp.newTrigger("runImport").timeBased()
      .atHour(9).everyDays(1).inTimezone("Asia/Jerusalem").create();
    try {
      for (const trigger of previous) ScriptApp.deleteTrigger(trigger);
    } catch (error) {
      ScriptApp.deleteTrigger(replacement);
      throw error;
    }
  });
}

export function disableSchedule() {
  return locked(() => {
    for (const trigger of ScriptApp.getProjectTriggers()) {
      if (trigger.getHandlerFunction() === "runImport") ScriptApp.deleteTrigger(trigger);
    }
  });
}
