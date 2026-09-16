import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decode } from "fast-png";
import { LABELS } from "../src/importer.js";
import { BARCODE, CODE, FALLBACK, gif, html, message, resource } from "./helpers/fixtures.js";
import { json, mimeMessage, runtime } from "./helpers/apps-runtime.js";

test("bundled Apps Script executes without Buffer and labels only the source message after send", () => {
  const untouched = mimeMessage("source-unlabelled", message({ labels: ["INBOX"] }));
  const r = runtime({ messages: [mimeMessage(), untouched] });
  assert.equal("Buffer" in r.context, false);
  assert.equal("URL" in r.context, false);
  assert.deepEqual(json(r.api.runImport()), [{ id: "source-1", status: "IMPORTED" }]);
  assert.equal(r.count("telegram"), 1);
  assert.equal(r.count("provider"), 0);
  assert.equal(r.count("unlock"), 1);
  assert.deepEqual(r.messages.get("source-unlabelled").labels, ["INBOX"]);
  const operations = r.operations("modify");
  assert.equal(operations.length, 2);
  assert.ok(operations.every(operation => operation.user === "me" && operation.id === "source-1"));
  const key = `Cibus/Key/${createHash("sha256").update(`cibus-v1:${CODE}`).digest("hex")}`;
  assert.deepEqual(operations[0].add, [LABELS.processing, key]);
  assert.deepEqual(operations[0].remove, []);
  assert.deepEqual(operations[1].add, [LABELS.imported]);
  assert.deepEqual(operations[1].remove, [LABELS.processing, LABELS.review, "INBOX"]);
  assert.ok(r.events.indexOf(operations[0]) < r.events.findIndex(e => e.type === "telegram"));
  assert.ok(r.events.indexOf(operations[1]) > r.events.findIndex(e => e.type === "telegram"));
  assert.deepEqual(r.messages.get("source-1").labels, [LABELS.candidate, key, LABELS.imported]);
  assert.deepEqual(r.operations("get")[0].query, { format: "full" });
  const request = r.operations("telegram")[0];
  assert.match(request.url, /^https:\/\/api\.telegram\.org\/bot123:synthetic_test_token\/sendDocument$/);
  assert.equal(request.init.method, "post");
  assert.equal(request.init.followRedirects, false);
  assert.equal(request.init.muteHttpExceptions, true);
  assert.equal(request.init.payload.chat_id, "-123456");
  assert.equal(request.init.payload.document.getContentType(), "image/png");
  assert.equal(request.init.payload.document.getName(), `voucher-${CODE}.png`);
  assert.match(request.init.payload.caption, /^חנות בדיקה\nValue: ILS 123\.45\nPurchased: 16 Sep 2026/);
  const png = decode(Uint8Array.from(request.init.payload.document.getBytes(), b => b & 255));
  assert.deepEqual([png.width, png.height], [1064, 304]);
  assert.ok(request.init.payload.caption.includes(`Voucher: ${CODE}`));
  assert.ok(!request.init.payload.caption.includes(FALLBACK));
  assert.ok(!JSON.stringify(r.operations("log")).includes(CODE));
  assert.ok(!JSON.stringify(r.operations("error")).includes(CODE));
});

test("Gmail MIME HTML and attachment bytes survive signed byte APIs, including Hebrew UTF-8", () => {
  for (const externalHtml of [false, true]) {
    const r = runtime({ messages: [mimeMessage("source-1", message(), { externalHtml })] });
    assert.equal(r.api.runImport()[0].status, "IMPORTED");
    assert.match(r.operations("telegram")[0].init.payload.caption, /^חנות בדיקה/);
    const retrieved = r.operations("attachment").map(e => e.attachmentId);
    assert.deepEqual(retrieved, externalHtml
      ? ["synthetic-html", "synthetic-image-0"] : ["synthetic-image-0"]);
    assert.ok(r.operations("blob").some(blob => blob.bytes.some(b => b < 0)), "exercise signed UTF-8 and PNG bytes");
    assert.ok(r.operations("blob").every(blob => blob.bytes.every(b => b >= -128 && b <= 127)));
    assert.ok(!retrieved.includes("never-download-logo"));
    assert.equal(r.count("decode"), 0, "already-decoded byte arrays must not be Base64 decoded");
  }
});

test("inline base64url MIME image data works without downloading an attachment", () => {
  const raw = mimeMessage("source-1", message(), { dataFormat: "base64" });
  const image = raw.payload.parts[1];
  image.body.data = raw.external[image.body.attachmentId];
  delete image.body.attachmentId;
  const r = runtime({ messages: [raw] });
  assert.equal(r.api.runImport()[0].status, "IMPORTED");
  assert.equal(r.count("attachment"), 0);
});

test("Gmail body decoding normalizes every unpadded remainder and preserves existing padding", () => {
  for (const suffix of ["", " ", "  "]) {
    for (const externalHtml of [false, true]) {
      for (const padded of [false, true]) {
        const raw = mimeMessage("source-1", message({ html: html() + suffix }), { externalHtml, dataFormat: "base64" });
        const body = raw.payload.parts[0].parts[1].body;
        const container = externalHtml ? raw.external : body;
        const key = externalHtml ? body.attachmentId : "data";
        if (padded) container[key] += "=".repeat((4 - container[key].length % 4) % 4);
        const r = runtime({ messages: [raw] });
        assert.equal(r.api.previewImport()[0].status, "READY");
        assert.ok(r.operations("decode").every(e => e.data.length % 4 === 0));
        assert.equal(r.count("modify"), 0);
        assert.equal(r.count("telegram"), 0);
      }
    }
  }
});

test("standard and URL-safe Base64 decode identically for bodies and attachments", () => {
  for (const externalHtml of [false, true]) {
    for (const alphabet of ["standard", "url-safe"]) {
      for (const padding of [false, true]) {
        for (const whitespace of [false, true]) {
          const raw = mimeMessage("source-1", message({ html: html() + "<!-- \uFFFF\uFFFF -->" }),
            { externalHtml, dataFormat: "base64" });
          const convert = input => {
            let encoded = Buffer.from(input, "base64url").toString("base64");
            if (alphabet === "url-safe") encoded = encoded.replace(/\+/g, "-").replace(/\//g, "_");
            if (!padding) encoded = encoded.replace(/=+$/, "");
            if (whitespace) encoded = " \t" + encoded.replace(/.{60}/g, "$&\r\n") + "\n";
            return encoded;
          };
          const body = raw.payload.parts[0].parts[1].body;
          if (body.data) body.data = convert(body.data);
          for (const key of Object.keys(raw.external)) raw.external[key] = convert(raw.external[key]);
          const bodyData = body.data ?? raw.external[body.attachmentId];
          assert.ok(alphabet === "standard" ? /[+/]/.test(bodyData) : /[-_]/.test(bodyData));
          const r = runtime({ messages: [raw] });
          const result = r.api.previewImport()[0];
          assert.equal(result.status, "READY");
          assert.match(result.caption, /Value: ILS 123\.45\nPurchased: 16 Sep 2026/);
          assert.equal(r.count("modify"), 0);
          assert.equal(r.count("telegram"), 0);
          assert.ok(r.operations("decode").every(e => /^[A-Za-z0-9_-]*={0,2}$/.test(e.data)));
        }
      }
    }
  }
});

test("missing and malformed Gmail Base64 fail explicitly without logging the body", () => {
  for (const [data, code] of [
    [undefined, "MISSING_GMAIL_BODY_DATA"],
    ["a", "INVALID_GMAIL_BODY_ENCODING"],
    ["secret%body", "INVALID_GMAIL_BODY_ENCODING"],
    ["abcd==", "INVALID_GMAIL_BODY_ENCODING"],
    [1234, "INVALID_GMAIL_BODY_ENCODING"],
  ]) {
    const raw = mimeMessage();
    raw.payload.parts[0].parts[1].body.data = data;
    const r = runtime({ messages: [raw] });
    const result = r.api.previewImport()[0];
    assert.equal(result.reason, `PREPARING_${code}`);
    assert.equal(r.count("telegram"), 0);
    assert.equal(r.count("modify"), 0);
    assert.ok(!JSON.stringify(r.operations("error")).includes("secret"));
    const detail = r.operations("error").map(event => JSON.parse(event.text))
      .find(event => event.code === "GMAIL_BODY_ENCODING_DETAILS");
    if (data === undefined) {
      assert.equal(detail, undefined);
    } else {
      assert.deepEqual(Object.keys(detail).sort(), [
        "code", "dataType", "isArray", "lengthModuloFour", "source",
        "standardAlphabet", "unexpectedCharacters", "urlSafeAlphabet", "whitespace",
      ]);
      assert.equal(detail.dataType, typeof data);
    }
  }
});

test("unsigned Gmail byte arrays preserve HTML and barcode bytes without decoding again", () => {
  const raw = mimeMessage();
  const body = raw.payload.parts[0].parts[1].body;
  body.data = body.data.map(byte => byte & 255);
  for (const key of Object.keys(raw.external)) raw.external[key] = raw.external[key].map(byte => byte & 255);
  const r = runtime({ messages: [raw] });
  const result = r.api.previewImport()[0];
  assert.equal(result.status, "READY");
  assert.match(result.caption, /Value: ILS 123\.45\nPurchased: 16 Sep 2026/);
  assert.equal(r.count("decode"), 0);
  assert.equal(r.count("modify"), 0);
  assert.equal(r.count("telegram"), 0);
});

test("invalid or truncated Gmail byte arrays fail before parsing without exposing content", () => {
  for (const [data, code] of [
    [[-129], "INVALID_GMAIL_BODY_BYTES"],
    [[256], "INVALID_GMAIL_BODY_BYTES"],
    [[1.5], "INVALID_GMAIL_BODY_BYTES"],
    [["secret"], "INVALID_GMAIL_BODY_BYTES"],
    [[null], "INVALID_GMAIL_BODY_BYTES"],
    [[NaN], "INVALID_GMAIL_BODY_BYTES"],
    [[Infinity], "INVALID_GMAIL_BODY_BYTES"],
    [new Array(2), "INVALID_GMAIL_BODY_BYTES"],
    [[65], "GMAIL_BODY_SIZE_MISMATCH"],
  ]) {
    const raw = mimeMessage();
    raw.payload.parts[0].parts[1].body.data = data;
    const r = runtime({ messages: [raw] });
    assert.equal(r.api.previewImport()[0].reason, `PREPARING_${code}`);
    assert.equal(r.count("decode"), 0);
    assert.equal(r.count("modify"), 0);
    assert.equal(r.count("telegram"), 0);
    assert.ok(!JSON.stringify(r.operations("error")).includes("secret"));
  }
});

test("Gmail only downloads matching CID or filename images, never unrelated oversized logos", () => {
  for (const match of ["cid", "filename"]) {
    const raw = mimeMessage();
    const image = raw.payload.parts[1];
    if (match === "cid") image.filename = "unrelated-name.gif";
    else image.headers = [{ name: "Content-ID", value: "<unrelated-cid>" }];
    const r = runtime({ messages: [raw] });
    assert.equal(r.api.runImport()[0].status, "IMPORTED");
    assert.deepEqual(r.operations("attachment").map(e => e.attachmentId), ["synthetic-image-0"]);
  }
});

test("unsupported multiple HTML MIME parts and oversized MIME bodies fail before send", () => {
  const multiple = mimeMessage();
  multiple.payload.parts[0].parts.push(structuredClone(multiple.payload.parts[0].parts[1]));
  const largeHtml = mimeMessage();
  largeHtml.payload.parts[0].parts[1].body.size = 500001;
  const largeImage = mimeMessage();
  largeImage.payload.parts[1].body.size = 2 * 1024 * 1024 + 1;
  for (const [raw, code] of [
    [multiple, "UNSUPPORTED_MIME_STRUCTURE"],
    [largeHtml, "EMAIL_HTML_TOO_LARGE"],
    [largeImage, "IMAGE_SIZE_LIMIT"],
  ]) {
    const r = runtime({ messages: [raw] });
    assert.equal(r.api.runImport()[0].reason, `PREPARING_${code}`);
    assert.equal(r.count("telegram"), 0);
    assert.ok(r.messages.get("source-1").labels.includes("INBOX"));
    assert.ok(r.messages.get("source-1").labels.includes(LABELS.review));
    if (raw === largeImage) assert.equal(r.count("attachment"), 0);
  }
});

test("preview is usable while disabled, validates one candidate and performs no message mutations", () => {
  const r = runtime({ properties: { IMPORT_ENABLED: "false" },
    messages: [mimeMessage("source-1"), mimeMessage("source-2")] });
  const results = r.api.previewImport();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "READY");
  assert.ok(results[0].caption.includes("Voucher: [redacted]"));
  assert.ok(!JSON.stringify(results).includes(CODE));
  assert.ok(!JSON.stringify(r.operations("log")).includes(CODE));
  assert.equal(r.count("telegram"), 0);
  assert.equal(r.count("modify"), 0);
  assert.equal(r.count("get"), 1);
  assert.equal(r.count("unlock"), 1);
  assert.equal(r.operations("list")[0].query.maxResults, 1);
  assert.ok(r.messages.get("source-1").labels.includes("INBOX"));
});

test("candidate queries exclude Imported, Processing and Review; unlabelled mail is untouched", () => {
  const r = runtime({ messages: [
    mimeMessage("unlabelled", message({ labels: ["INBOX"] })),
    mimeMessage("review", message({ labels: [LABELS.candidate, LABELS.review, "INBOX"] })),
    mimeMessage("processing", message({ labels: [LABELS.candidate, LABELS.processing, "INBOX"] })),
    mimeMessage("imported", message({ labels: [LABELS.candidate, LABELS.imported] })),
  ] });
  assert.deepEqual(json(r.api.runImport()), []);
  assert.equal(r.count("get"), 0);
  assert.equal(r.count("telegram"), 0);
  assert.deepEqual(r.operations("modify").map(e => e.id), ["processing"]);
  assert.match(r.operations("list").at(-1).query.q,
    /label:Cibus\/Candidate -label:Cibus\/Imported -label:Cibus\/Processing -label:Cibus\/Review-needed/);
});

test("untrusted sender in the candidate label is reviewed, not sent or archived", () => {
  const r = runtime({ messages: [mimeMessage("source-1", message({ from: "spoof@example.invalid" }))] });
  assert.equal(r.api.runImport()[0].reason, "PREPARING_UNEXPECTED_SENDER");
  assert.equal(r.count("telegram"), 0);
  assert.ok(r.messages.get("source-1").labels.includes("INBOX"));
  assert.deepEqual(r.operations("modify").map(e => e.add), [[LABELS.review]]);
});

test("duplicate vouchers across distinct Gmail messages send once, including same-thread sources", () => {
  const r = runtime({ messages: [mimeMessage("source-1"), mimeMessage("source-2")] });
  assert.deepEqual(json(r.api.runImport()).map(result => result.status), ["IMPORTED", "DUPLICATE_VOUCHER"]);
  assert.equal(r.count("telegram"), 1);
  assert.ok(r.messages.get("source-2").labels.includes(LABELS.review));
  assert.ok(r.messages.get("source-2").labels.includes("INBOX"));
  assert.equal(r.count("label-create"), 1);
  assert.match(r.operations("label-create")[0].body.name, /^Cibus\/Key\/[a-f0-9]{64}$/);
  const duplicateQuery = r.operations("list").find(e => e.query.labelIds);
  assert.equal(duplicateQuery.query.includeSpamTrash, true);
  assert.equal(duplicateQuery.query.maxResults, 2);
  r.api.runImport();
  assert.equal(r.count("telegram"), 1);
});

test("stale interrupted claims are marked Review without an automatic resend", () => {
  const r = runtime({ messages: [mimeMessage("source-1", message({
    labels: [LABELS.candidate, LABELS.processing, "INBOX"],
  }))] });
  assert.deepEqual(json(r.api.runImport()), []);
  assert.deepEqual(r.messages.get("source-1").labels,
    [LABELS.candidate, LABELS.processing, "INBOX", LABELS.review]);
  assert.match(r.operations("error")[0].text, /INTERRUPTED_DELIVERY_REVIEW_REQUIRED/);
  r.api.runImport();
  assert.equal(r.count("modify"), 1);
  assert.equal(r.count("telegram"), 0);
});

test("existing Imported messages retry finalization and archive without sending Telegram again", () => {
  let failures = 0;
  const r = runtime({
    messages: [mimeMessage("source-1", message({
      labels: [LABELS.imported, LABELS.processing, LABELS.review, "INBOX"],
    }))],
    failModify: event => event.add.includes(LABELS.imported) && failures++ < 2,
  });
  assert.deepEqual(json(r.api.runImport()), []);
  assert.deepEqual(r.messages.get("source-1").labels, [LABELS.imported]);
  assert.equal(r.count("telegram"), 0);
  assert.equal(r.count("modify"), 3);
  assert.deepEqual(r.operations("sleep").map(e => e.milliseconds), [500, 1000]);
  r.api.runImport();
  assert.equal(r.count("modify"), 3);
  assert.equal(r.count("telegram"), 0);
});

test("temporary post-send finalization failure retries Gmail only", () => {
  let failures = 0;
  const r = runtime({ failModify: event => event.add.includes(LABELS.imported) && failures++ < 2 });
  assert.equal(r.api.runImport()[0].status, "IMPORTED");
  assert.equal(r.count("telegram"), 1);
  assert.equal(r.operations("modify").filter(e => e.add.includes(LABELS.imported)).length, 3);
  assert.ok(!r.messages.get("source-1").labels.includes("INBOX"));
  r.api.runImport();
  assert.equal(r.count("telegram"), 1);
});

test("exhausted post-send finalization retries retain claim and review, never resending", () => {
  let failing = true;
  const r = runtime({ failModify: event => failing && event.add.includes(LABELS.imported) });
  assert.equal(r.api.runImport()[0].reason, "FINALIZING_GMAIL_OPERATION_FAILED");
  assert.equal(r.count("telegram"), 1);
  for (const label of [LABELS.processing, LABELS.review, "INBOX"]) {
    assert.ok(r.messages.get("source-1").labels.includes(label));
  }
  assert.ok(!r.messages.get("source-1").labels.includes(LABELS.imported));
  failing = false;
  assert.deepEqual(json(r.api.runImport()), []);
  assert.equal(r.count("telegram"), 1);
});

test("failed Gmail claim does not send Telegram or archive", () => {
  const r = runtime({ failModify: event => event.add.includes(LABELS.processing) });
  assert.equal(r.api.runImport()[0].reason, "PREPARING_GMAIL_OPERATION_FAILED");
  assert.equal(r.count("telegram"), 0);
  assert.equal(r.operations("modify").filter(e => e.add.includes(LABELS.processing)).length, 3);
  assert.ok(r.messages.get("source-1").labels.includes(LABELS.review));
  assert.ok(r.messages.get("source-1").labels.includes("INBOX"));
});

test("uncertain Telegram network/JSON outcomes never automatically resend or archive", () => {
  for (const telegram of [
    () => { throw new Error("synthetic network interruption"); },
    () => ({ status: 200, text: "not json" }),
  ]) {
    const r = runtime({ telegram });
    assert.equal(r.api.runImport()[0].reason, "SENDING_TELEGRAM_DELIVERY_UNCERTAIN");
    for (const label of [LABELS.processing, LABELS.review, "INBOX"]) {
      assert.ok(r.messages.get("source-1").labels.includes(label));
    }
    assert.equal(r.operations("modify").filter(e => e.remove.includes("INBOX")).length, 0);
    r.api.runImport();
    assert.equal(r.count("telegram"), 1);
  }
});

test("Telegram requires 200, ok:true, integer message id and the configured destination", () => {
  for (const [status, body] of [
    [429, { ok: false }],
    [200, { ok: false }],
    [200, { ok: true, result: { message_id: "101", chat: { id: -123456 } } }],
    [200, { ok: true, result: { message_id: 101, chat: { id: -999999 } } }],
    [500, { ok: true, result: { message_id: 101, chat: { id: -123456 } } }],
  ]) {
    const r = runtime({ telegram: () => ({ status, text: JSON.stringify(body) }) });
    assert.equal(r.api.runImport()[0].reason, "SENDING_TELEGRAM_NOT_CONFIRMED");
    assert.ok(r.messages.get("source-1").labels.includes("INBOX"));
    r.api.runImport();
    assert.equal(r.count("telegram"), 1);
  }
});

test("Telegram failures expose actionable codes without raw responses or voucher data", () => {
  for (const [status, body, reason] of [
    [400, { error_code: 400, parameters: { migrate_to_chat_id: -100123456 } }, "CHAT_MIGRATED"],
    [429, { error_code: 429, parameters: { retry_after: 30 } }, "RATE_LIMITED"],
    [401, { error_code: 401 }, "INVALID_BOT_TOKEN"],
    [400, { description: `Bad Request: chat not found ${CODE}` }, "CHAT_NOT_FOUND"],
    [400, { description: `Bad Request: invalid user_id specified ${CODE}` }, "INVALID_USER_ID"],
    [400, { description: `Bad Request: user not found ${CODE}` }, "MEMBER_NOT_FOUND"],
    [400, { description: `Bad Request: member list is inaccessible ${CODE}` }, "MEMBER_LOOKUP_FORBIDDEN"],
    [403, { description: `Forbidden: bot was kicked ${CODE}` }, "BOT_NOT_IN_CHAT"],
    [403, { description: `not enough rights to send ${CODE}` }, "BOT_CANNOT_SEND"],
    [500, {}, "TELEGRAM_SERVER_ERROR"],
  ]) {
    const r = runtime({ telegram: () => ({ status, text: JSON.stringify({ ok: false, ...body }) }) });
    assert.equal(r.api.runImport()[0].reason, "SENDING_TELEGRAM_NOT_CONFIRMED");
    const detail = r.operations("error").map(e => JSON.parse(e.text))
      .find(e => e.code === "TELEGRAM_RESPONSE_DETAILS");
    assert.equal(detail.reason, reason);
    assert.equal(detail.httpStatus, status);
    assert.equal(detail.retryAfterSeconds, body.parameters?.retry_after ?? null);
    assert.equal(detail.suggestedChatId,
      body.parameters?.migrate_to_chat_id ? String(body.parameters.migrate_to_chat_id) : null);
    assert.ok(!JSON.stringify(r.operations("error")).includes(CODE));
    assert.ok(!JSON.stringify(r.operations("error")).includes("synthetic_test_token"));
  }
});

test("a send failure stops the batch without claiming or reviewing further vouchers", () => {
  const r = runtime({
    messages: [mimeMessage("source-1"), mimeMessage("source-2")],
    telegram: () => ({ status: 429, text: JSON.stringify({ ok: false, error_code: 429 }) }),
  });
  assert.equal(r.api.runImport().length, 1);
  assert.equal(r.count("telegram"), 1);
  assert.deepEqual(r.messages.get("source-2").labels, [LABELS.candidate, "INBOX"]);
  assert.equal(r.count("get"), 1);
});

test("read-only Telegram check uses JSON integer IDs while imports are disabled and does not access vouchers", () => {
  const botId = 7999999999;
  const r = runtime({ properties: { IMPORT_ENABLED: "false" }, telegram: (url, init) => {
    const method = url.split("/").at(-1);
    assert.equal(init.contentType, "application/json");
    assert.equal(typeof init.payload, "string");
    const payload = JSON.parse(init.payload);
    if (method === "getChatMember") {
      assert.deepEqual(payload, { chat_id: "-123456", user_id: botId });
      assert.ok(init.payload.includes('"user_id":7999999999'));
    }
    const result = {
      getChat: { id: -123456, type: "supergroup", title: "private-title", permissions: { can_send_documents: true } },
      getMe: { id: botId, is_bot: true, username: "private-bot" },
      getChatMember: { status: "member", user: { id: botId } },
    }[method];
    assert.ok(result, "diagnostic must not send a message");
    return { status: 200, text: JSON.stringify({ ok: true, result }) };
  } });
  assert.deepEqual(json(r.api.checkTelegramConnection()), {
    status: "CONNECTION_OK", reason: "NO_KNOWN_SEND_RESTRICTION", chatType: "supergroup",
  });
  assert.equal(r.count("modify"), 0);
  assert.equal(r.count("get"), 0);
  assert.equal(r.count("list"), 0);
  assert.equal(r.count("labels-list"), 0);
  assert.equal(r.count("telegram"), 3);
  assert.ok(!JSON.stringify(r.operations("log")).includes("private-"));
});

test("read-only Telegram check reports migrated group ID without changing configuration or sending", () => {
  const r = runtime({ properties: { IMPORT_ENABLED: "false" }, telegram: url => {
    assert.ok(url.endsWith("/getChat"));
    return { status: 400, text: JSON.stringify({ ok: false, error_code: 400,
      description: `private response ${CODE}`, parameters: { migrate_to_chat_id: -100123456 } }) };
  } });
  const result = r.api.checkTelegramConnection();
  assert.equal(result.status, "CHECK_FAILED");
  assert.equal(result.reason, "CHAT_MIGRATED");
  assert.equal(result.suggestedChatId, "-100123456");
  assert.equal(r.properties.TELEGRAM_CHAT_ID, "-123456");
  assert.equal(r.count("telegram"), 1);
  assert.equal(r.count("modify"), 0);
  assert.ok(!JSON.stringify(r.operations("error")).includes(CODE));
});

test("Telegram check respects group permissions, bot restrictions and admin exemption", () => {
  for (const [status, membership, permissions, expected] of [
    ["member", {}, { can_send_documents: false }, "CHECK_FAILED"],
    ["member", {}, { can_send_messages: false }, "CHECK_FAILED"],
    ["administrator", {}, { can_send_documents: false }, "CONNECTION_OK"],
    ["restricted", { is_member: false, can_send_documents: true }, {}, "CHECK_FAILED"],
    ["restricted", { is_member: true, can_send_documents: false }, {}, "CHECK_FAILED"],
    ["left", {}, {}, "CHECK_FAILED"],
    ["kicked", {}, {}, "CHECK_FAILED"],
  ]) {
    const r = runtime({ telegram: url => {
      const result = {
        getChat: { id: -123456, type: "supergroup", permissions },
        getMe: { id: 123, is_bot: true },
        getChatMember: { status, user: { id: 123 }, ...membership },
      }[url.split("/").at(-1)];
      assert.ok(result);
      return { status: 200, text: JSON.stringify({ ok: true, result }) };
    } });
    assert.equal(r.api.checkTelegramConnection().status, expected);
    assert.equal(r.count("modify"), 0);
  }
});

test("malformed Telegram responses fail safely without sending diagnostic messages", () => {
  for (const text of ["null", "[]", "not-json"]) {
    const r = runtime({ telegram: () => ({ status: 200, text }) });
    assert.throws(() => r.api.checkTelegramConnection(), error => error.code === "TELEGRAM_CHECK_FAILED");
    assert.equal(r.count("telegram"), 1);
    assert.equal(r.count("modify"), 0);
    assert.equal(r.count("unlock"), 1);
  }
});

test("provider fetches use bounded redirects, signed response bytes and explicit User-Agent", () => {
  const r = runtime({
    messages: [mimeMessage("source-1", message({ html: html({ fallback: true }), attachments: [] }))],
    provider: url => {
      if (url === FALLBACK) return { status: 302, location: "/b/?fixture=synthetic" };
      if (url === "https://myconsumers.pluxee.co.il/b/?fixture=synthetic") {
        return resource(Uint8Array.of(1), "text/html; charset=utf-8", {
          text: `<img alt="${CODE}" src="bar.ashx?fixture=synthetic">`,
        });
      }
      assert.equal(url, BARCODE);
      return resource(gif().bytes);
    },
  });
  assert.equal(r.api.runImport()[0].status, "IMPORTED");
  assert.deepEqual(r.operations("provider").map(e => e.url),
    [FALLBACK, "https://myconsumers.pluxee.co.il/b/?fixture=synthetic", BARCODE]);
  for (const request of r.operations("provider")) {
    assert.equal(request.init.followRedirects, false);
    assert.equal(request.init.muteHttpExceptions, true);
    assert.equal(request.init.headers["User-Agent"], "CibusVoucherBot/0.1");
  }
});

test("provider network failure or unsafe redirect fails before claim/send", () => {
  for (const [provider, code] of [
    [() => { throw new Error("synthetic provider unavailable"); }, "IMAGE_NETWORK_ERROR"],
    [() => ({ status: 302, location: "https://evil.invalid/b?fixture=synthetic" }), "UNSAFE_IMAGE_URL"],
  ]) {
    const r = runtime({ provider,
      messages: [mimeMessage("source-1", message({ html: html({ fallback: true }), attachments: [] }))] });
    assert.equal(r.api.runImport()[0].reason, `PREPARING_${code}`);
    assert.equal(r.count("provider"), 1);
    assert.equal(r.count("telegram"), 0);
    assert.deepEqual(r.operations("modify").map(e => e.add), [[LABELS.review]]);
  }
});

test("configuration guards enforce account, private group destination and explicit import enablement", () => {
  for (const [options, code] of [
    [{ properties: { TELEGRAM_BOT_TOKEN: "" } }, "CONFIG_BOT_TOKEN"],
    [{ properties: { TELEGRAM_CHAT_ID: "123456" } }, "CONFIG_GROUP_CHAT_ID"],
    [{ properties: { EXPECTED_GMAIL_ACCOUNT: "" } }, "CONFIG_EXPECTED_GMAIL_ACCOUNT"],
    [{ account: "other@example.invalid" }, "WRONG_GMAIL_ACCOUNT"],
    [{ properties: { IMPORT_ENABLED: "false" } }, "IMPORT_DISABLED"],
    [{ properties: { IMPORT_ENABLED: "TRUE" } }, "IMPORT_DISABLED"],
  ]) {
    const r = runtime(options);
    assert.throws(() => r.api.runImport(), error => error.code === code);
    assert.equal(r.count("telegram"), 0);
    assert.equal(r.count("modify"), 0);
    assert.equal(r.count("list"), 0);
    assert.equal(r.count("unlock"), 1);
  }
  const r = runtime({ account: "FIXTURE@EXAMPLE.INVALID", messages: [] });
  assert.deepEqual(json(r.api.runImport()), []);
});

test("busy script lock prevents concurrent imports and does not release another execution's lock", () => {
  const r = runtime({ lockAvailable: false });
  assert.equal(r.api.runImport(), undefined);
  assert.equal(r.api.previewImport(), undefined);
  assert.equal(r.count("profile"), 0);
  assert.equal(r.count("telegram"), 0);
  assert.equal(r.count("unlock"), 0);
  assert.equal(r.count("warn"), 2);
});

test("schedule creation keeps one daily Israel-morning trigger and preserves unrelated triggers", () => {
  const r = runtime({ triggers: ["unrelatedHandler"] });
  r.api.enableSchedule();
  r.api.enableSchedule();
  assert.equal(r.count("trigger-create"), 2);
  assert.deepEqual(r.operations("trigger-hour").map(e => e.hour), [9, 9]);
  assert.deepEqual(r.operations("trigger-days").map(e => e.days), [1, 1]);
  assert.deepEqual(r.operations("trigger-timezone").map(e => e.timezone), ["Asia/Jerusalem", "Asia/Jerusalem"]);
  assert.deepEqual(r.triggers.map(t => t.getHandlerFunction()), ["unrelatedHandler", "runImport"]);
  r.api.disableSchedule();
  r.api.disableSchedule();
  assert.deepEqual(r.triggers.map(t => t.getHandlerFunction()), ["unrelatedHandler"]);
  assert.equal(r.count("trigger-delete"), 2);
  assert.equal(r.count("telegram"), 0);
});

test("enableSchedule replaces existing legacy or duplicate importer triggers", () => {
  const r = runtime({ triggers: ["runImport", "unrelatedHandler", "runImport"] });
  const previous = [...r.triggers];
  r.api.enableSchedule();
  assert.deepEqual(r.triggers.map(t => t.getHandlerFunction()), ["unrelatedHandler", "runImport"]);
  assert.ok(r.triggers.includes(previous[1]));
  assert.ok(!r.triggers.includes(previous[0]));
  assert.ok(!r.triggers.includes(previous[2]));
  assert.equal(r.count("trigger-create"), 1);
  assert.equal(r.count("trigger-delete"), 2);
  assert.ok(r.events.findIndex(e => e.type === "trigger-create")
    < r.events.findIndex(e => e.type === "trigger-delete"));
});

test("failed replacement creation leaves the existing schedule intact", () => {
  const r = runtime({ triggers: ["runImport"], failTriggerCreate: true });
  const original = r.triggers[0];
  assert.throws(() => r.api.enableSchedule(), /synthetic trigger creation failure/);
  assert.deepEqual(r.triggers, [original]);
  assert.equal(r.count("trigger-delete"), 0);
  assert.equal(r.count("unlock"), 1);
});

test("failed old-trigger deletion rolls back the new schedule and reports failure", () => {
  let original;
  const r = runtime({ triggers: ["runImport"], failTriggerDelete: trigger => trigger === original });
  original = r.triggers[0];
  assert.throws(() => r.api.enableSchedule(), /synthetic trigger deletion failure/);
  assert.deepEqual(r.triggers, [original]);
  assert.equal(r.count("trigger-create"), 1);
  assert.equal(r.count("trigger-delete"), 2);
  assert.equal(r.count("unlock"), 1);
});

test("scheduling changes do not race a running import or another scheduling change", () => {
  const r = runtime({ triggers: ["runImport"], lockAvailable: false });
  const original = r.triggers[0];
  r.api.enableSchedule();
  r.api.disableSchedule();
  assert.deepEqual(r.triggers, [original]);
  assert.equal(r.count("trigger-create"), 0);
  assert.equal(r.count("trigger-delete"), 0);
  assert.equal(r.count("warn"), 2);
});

test("schedule enablement requires config and disable removes all importer triggers without config", () => {
  const disabled = runtime({ properties: { IMPORT_ENABLED: "false" } });
  assert.throws(() => disabled.api.enableSchedule(), error => error.code === "IMPORT_DISABLED");
  assert.equal(disabled.count("trigger-create"), 0);
  const wrongAccount = runtime({ account: "other@example.invalid" });
  assert.throws(() => wrongAccount.api.enableSchedule(), error => error.code === "WRONG_GMAIL_ACCOUNT");
  assert.equal(wrongAccount.count("trigger-create"), 0);
  const r = runtime({ properties: { TELEGRAM_BOT_TOKEN: "" },
    triggers: ["runImport", "unrelatedHandler", "runImport"] });
  r.api.disableSchedule();
  assert.deepEqual(r.triggers.map(t => t.getHandlerFunction()), ["unrelatedHandler"]);
  assert.equal(r.count("profile"), 0);
  assert.equal(r.count("trigger-delete"), 2);
});
