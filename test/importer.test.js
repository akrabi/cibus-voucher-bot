import test from "node:test";
import assert from "node:assert/strict";
import { importMessage, LABELS } from "../src/importer.js";
import { VoucherError } from "../src/errors.js";
import { CODE, message } from "./helpers/fixtures.js";

function harness({ source = message(), duplicate = false, fail = {} } = {}) {
  const calls = [];
  const ports = {};
  const actions = {
    getMessage: () => source,
    voucherKey: code => `synthetic-key:${code}`,
    hasOtherSource: () => duplicate,
    claim: (_id, key) => { source.labels.push(LABELS.processing, key); },
    finalize: () => {
      source.labels = source.labels.filter(label => ![LABELS.processing, LABELS.review, "INBOX"].includes(label));
      if (!source.labels.includes(LABELS.imported)) source.labels.push(LABELS.imported);
    },
    review: () => { if (!source.labels.includes(LABELS.review)) source.labels.push(LABELS.review); },
    send: () => {},
    fetchResource: () => assert.fail("unit importer test must not use the network"),
    log: () => {},
  };
  for (const [name, action] of Object.entries(actions)) {
    ports[name] = (...args) => {
      calls.push({ name, args });
      if (fail[name]) throw fail[name];
      return action(...args);
    };
  }
  return { ports, calls, source, fail, names: () => calls.map(call => call.name) };
}

test("successful import claims before sending and archives only after sending", () => {
  const h = harness();
  assert.deepEqual(importMessage("source-1", h.ports), { id: "source-1", status: "IMPORTED" });
  assert.deepEqual(h.names(), ["getMessage", "voucherKey", "hasOtherSource", "claim", "send", "finalize"]);
  assert.deepEqual(h.calls.find(c => c.name === "claim").args, ["source-1", `synthetic-key:${CODE}`]);
  assert.equal(h.calls.find(c => c.name === "send").args[0].contentType, "image/png");
  assert.match(h.calls.find(c => c.name === "send").args[1], /Purchased: 16 Sep 2026/);
  assert.ok(h.source.labels.includes(LABELS.imported));
  assert.ok(!h.source.labels.includes("INBOX"));
  assert.ok(!h.source.labels.includes(LABELS.processing));
});

test("dry run validates and renders but never claims, sends, reviews or archives", () => {
  const h = harness();
  const before = [...h.source.labels];
  const result = importMessage("source-1", h.ports, { dryRun: true });
  assert.equal(result.status, "READY");
  assert.equal(result.width, 1064);
  assert.equal(result.height, 304);
  assert.match(result.caption, /Value: ILS 123\.45/);
  assert.deepEqual(h.names(), ["getMessage", "voucherKey", "hasOtherSource"]);
  assert.deepEqual(h.source.labels, before);
});

test("different source with an existing voucher key is reviewed and never sent", () => {
  for (const dryRun of [false, true]) {
    const h = harness({ duplicate: true });
    assert.equal(importMessage("source-2", h.ports, { dryRun }).status, "DUPLICATE_VOUCHER");
    assert.ok(!h.names().includes("send"));
    assert.ok(!h.names().includes("claim"));
    assert.ok(!h.names().includes("finalize"));
    assert.equal(h.source.labels.includes(LABELS.review), !dryRun);
    assert.ok(h.source.labels.includes("INBOX"));
    assert.deepEqual(h.calls.find(c => c.name === "log").args, ["source-2", "DUPLICATE_VOUCHER"]);
  }
});

test("preexisting Imported is finalized without parsing/rendering/resending", () => {
  for (const dryRun of [false, true]) {
    const h = harness({ source: message({
      labels: [LABELS.imported, LABELS.processing, LABELS.review, "INBOX"], html: "not parsed",
    }) });
    assert.equal(importMessage("source-1", h.ports, { dryRun }).status, "ALREADY_IMPORTED");
    assert.deepEqual(h.names(), dryRun ? ["getMessage"] : ["getMessage", "finalize"]);
    assert.equal(h.source.labels.includes("INBOX"), dryRun);
  }
});

for (const label of [LABELS.processing, LABELS.review]) {
  test(`preexisting ${label} never attempts a send or clears its guard`, () => {
    const h = harness({ source: message({ labels: [LABELS.candidate, label, "INBOX"] }) });
    assert.equal(importMessage("source-1", h.ports).status, "REVIEW_REQUIRED");
    assert.deepEqual(h.names(), ["getMessage"]);
    assert.ok(h.source.labels.includes(label));
    assert.ok(h.source.labels.includes("INBOX"));
  });
}

test("pre-send validation failure is reviewed and remains in inbox without a claim", () => {
  const h = harness({ source: message({ from: "attacker@example.invalid" }) });
  assert.deepEqual(importMessage("source-1", h.ports), {
    id: "source-1", status: "REVIEW_REQUIRED", reason: "PREPARING_UNEXPECTED_SENDER",
  });
  assert.deepEqual(h.names(), ["getMessage", "log", "review"]);
  assert.ok(h.source.labels.includes("INBOX"));
  assert.ok(!h.source.labels.includes(LABELS.processing));
});

test("get/duplicate lookup/claim failures cannot trigger a send", () => {
  for (const operation of ["getMessage", "hasOtherSource", "claim"]) {
    const h = harness({ fail: { [operation]: new VoucherError("GMAIL_OPERATION_FAILED") } });
    assert.equal(importMessage("source-1", h.ports).reason, "PREPARING_GMAIL_OPERATION_FAILED");
    assert.ok(!h.names().includes("send"));
    assert.ok(!h.names().includes("finalize"));
    assert.ok(h.source.labels.includes(LABELS.review));
    assert.ok(h.source.labels.includes("INBOX"));
  }
});

test("dry-run failures do not mutate Gmail and unexpected errors are redacted", () => {
  const h = harness({ fail: { getMessage: new Error("sensitive synthetic diagnostic") } });
  const result = importMessage("source-1", h.ports, { dryRun: true });
  assert.equal(result.reason, "PREPARING_UNEXPECTED_ERROR");
  assert.deepEqual(h.names(), ["getMessage", "log"]);
  assert.ok(!JSON.stringify(result).includes("sensitive"));
  assert.deepEqual(h.calls.find(c => c.name === "log").args, ["source-1", "PREPARING_UNEXPECTED_ERROR"]);
});

for (const code of ["TELEGRAM_DELIVERY_UNCERTAIN", "TELEGRAM_NOT_CONFIRMED"]) {
  test(`${code} retains claim and inbox; another import never resends`, () => {
    const h = harness({ fail: { send: new VoucherError(code) } });
    assert.equal(importMessage("source-1", h.ports).reason, `SENDING_${code}`);
    assert.ok(h.source.labels.includes(LABELS.processing));
    assert.ok(h.source.labels.includes(`synthetic-key:${CODE}`));
    assert.ok(h.source.labels.includes(LABELS.review));
    assert.ok(h.source.labels.includes("INBOX"));
    delete h.fail.send;
    assert.equal(importMessage("source-1", h.ports).status, "REVIEW_REQUIRED");
    assert.equal(h.names().filter(n => n === "send").length, 1);
    assert.ok(!h.names().includes("finalize"));
  });
}

test("after confirmed send, label finalization failure retains claim and cannot resend", () => {
  const h = harness({ fail: { finalize: new VoucherError("GMAIL_OPERATION_FAILED") } });
  assert.equal(importMessage("source-1", h.ports).reason, "FINALIZING_GMAIL_OPERATION_FAILED");
  assert.ok(h.source.labels.includes(LABELS.processing));
  assert.ok(h.source.labels.includes(LABELS.review));
  assert.ok(h.source.labels.includes("INBOX"));
  delete h.fail.finalize;
  assert.equal(importMessage("source-1", h.ports).status, "REVIEW_REQUIRED");
  assert.equal(h.names().filter(n => n === "send").length, 1);
});

test("retrying finalization for an already Imported message never sends again", () => {
  const h = harness({
    source: message({ labels: [LABELS.imported, LABELS.processing, "INBOX"] }),
    fail: { finalize: new VoucherError("GMAIL_OPERATION_FAILED") },
  });
  assert.equal(importMessage("source-1", h.ports).status, "REVIEW_REQUIRED");
  delete h.fail.finalize;
  assert.equal(importMessage("source-1", h.ports).status, "ALREADY_IMPORTED");
  assert.deepEqual(h.source.labels, [LABELS.imported]);
  assert.ok(!h.names().includes("send"));
});
