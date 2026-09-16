import vm from "node:vm";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { bundleOptions } from "../../scripts/build-config.js";
import { LABELS } from "../../src/importer.js";
import { message as fixtureMessage, resource } from "./fixtures.js";

// Use deployment settings in memory so parallel test processes cannot race on dist.
const bundle = (await build({ ...bundleOptions, write: false })).outputFiles[0].text;

export const signed = bytes => Array.from(bytes, byte => byte > 127 ? byte - 256 : byte);
const encoded = bytes => Buffer.from(bytes).toString("base64url");
export const json = value => JSON.parse(JSON.stringify(value));

export function mimeMessage(id = "source-1", source = fixtureMessage(), { externalHtml = false, dataFormat = "bytes" } = {}) {
  const encode = dataFormat === "base64" ? encoded : signed;
  const htmlBytes = Buffer.from(source.html, "utf8");
  const external = {};
  const htmlBody = externalHtml
    ? (external["synthetic-html"] = encode(htmlBytes), { attachmentId: "synthetic-html", size: htmlBytes.length })
    : { data: encode(htmlBytes), size: htmlBytes.length };
  const images = source.attachments.map((attachment, i) => {
    const attachmentId = `synthetic-image-${i}`;
    external[attachmentId] = encode(attachment.bytes);
    return {
      mimeType: attachment.contentType, filename: attachment.filename,
      headers: [{ name: "Content-ID", value: `<${attachment.contentId}>` }],
      body: { attachmentId, size: attachment.bytes.length },
    };
  });
  return {
    id, labels: [...source.labels], external,
    payload: {
      mimeType: "multipart/related",
      headers: [{ name: "From", value: source.from }, { name: "Subject", value: source.subject }],
      parts: [{
        mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: encode(Buffer.from("Synthetic plain text")) } },
          { mimeType: "text/html", body: htmlBody },
        ],
      }, ...images, {
        mimeType: "image/gif", filename: "unrelated-logo.gif",
        headers: [{ name: "Content-ID", value: "<unrelated-logo>" }],
        body: { attachmentId: "never-download-logo", size: 99999999 },
      }],
    },
  };
}

export function runtime(options = {}) {
  const events = [];
  const messages = new Map((options.messages ?? [mimeMessage()]).map(m => [m.id, structuredClone(m)]));
  const labels = new Map(Object.values(LABELS).map((name, i) => [name, `label-${i}`]));
  for (const item of messages.values()) {
    for (const name of item.labels) {
      if (name !== "INBOX" && !labels.has(name)) labels.set(name, `label-${labels.size}`);
    }
  }
  const triggers = (options.triggers ?? []).map(handler => ({ getHandlerFunction: () => handler }));
  const properties = {
    TELEGRAM_BOT_TOKEN: "123:synthetic_test_token",
    TELEGRAM_CHAT_ID: "-123456",
    EXPECTED_GMAIL_ACCOUNT: "fixture@example.invalid",
    IMPORT_ENABLED: "true",
    ...options.properties,
  };
  const nameOf = id => id === "INBOX" ? id : [...labels].find(([, value]) => value === id)?.[0];
  const record = (type, data = {}) => { const event = { type, ...data }; events.push(event); return event; };
  const response = r => ({
    getResponseCode: () => r.status,
    getAllHeaders: () => ({ "Content-Type": r.contentType, ...(r.location ? { Location: r.location } : {}) }),
    getContent: () => signed(r.bytes ?? []),
    getContentText: () => r.text ?? "",
  });
  const context = {
    console: {
      log: text => record("log", { text }), error: text => record("error", { text }),
      warn: text => record("warn", { text }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...properties }) }) },
    LockService: { getScriptLock: () => ({
      tryLock: timeout => { record("lock", { timeout }); return options.lockAvailable !== false; },
      releaseLock: () => record("unlock"),
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" }, Charset: { UTF_8: "UTF-8" },
      sleep: milliseconds => record("sleep", { milliseconds }),
      base64DecodeWebSafe: data => {
        record("decode", { data });
        if (typeof data !== "string" || data.length % 4 !== 0
          || !/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}==|[A-Za-z0-9_-]{3}=)?$/.test(data)) {
          throw new Error("Strict web-safe decoder requires valid padded Base64");
        }
        return signed(Buffer.from(data, "base64url"));
      },
      computeDigest: (_algorithm, text, charset) => {
        record("digest", { text, charset });
        return signed(createHash("sha256").update(text, "utf8").digest());
      },
      newBlob: (bytes, contentType, name) => {
        const values = Array.from(bytes);
        if (values.some(b => !Number.isInteger(b) || b < -128 || b > 127)) {
          throw new Error("Apps Script byte[] requires signed bytes");
        }
        const data = Buffer.from(values.map(b => b & 255));
        record("blob", { bytes: values, contentType, name });
        return {
          getDataAsString: () => data.toString("utf8"),
          getBytes: () => signed(data),
          getContentType: () => contentType,
          getName: () => name,
        };
      },
    },
    Gmail: { Users: {
      getProfile: user => {
        record("profile", { user });
        return { emailAddress: options.account ?? "fixture@example.invalid" };
      },
      Labels: {
        list: user => {
          record("labels-list", { user });
          return { labels: [...labels].map(([name, id]) => ({ name, id })) };
        },
        create: (body, user) => {
          record("label-create", { body: json(body), user });
          const id = `label-${labels.size}`;
          labels.set(body.name, id);
          return { id, name: body.name };
        },
      },
      Messages: {
        list: (user, query) => {
          record("list", { user, query: json(query) });
          let selected = [...messages.values()];
          if (query.labelIds) {
            selected = selected.filter(m => Array.from(query.labelIds).every(id => m.labels.includes(nameOf(id))));
          }
          if (query.q) {
            for (const match of query.q.matchAll(/(-?)label:([^\s]+)/g)) {
              selected = selected.filter(m => m.labels.includes(match[2]) === (match[1] !== "-"));
            }
            if (query.q.includes("in:inbox")) selected = selected.filter(m => m.labels.includes("INBOX"));
          }
          return { messages: selected.slice(0, query.maxResults ?? 100).map(m => ({ id: m.id })) };
        },
        get: (user, id, query) => {
          record("get", { user, id, query: json(query) });
          const m = messages.get(id);
          if (!m) throw new Error("unknown synthetic message");
          return { id, threadId: "synthetic-shared-thread", payload: structuredClone(m.payload),
            labelIds: m.labels.map(name => name === "INBOX" ? name : labels.get(name)) };
        },
        modify: (body, user, id) => {
          const add = Array.from(body.addLabelIds, nameOf);
          const remove = Array.from(body.removeLabelIds, nameOf);
          const event = record("modify", { user, id, add, remove, body: json(body) });
          if (options.failModify?.(event, events)) throw new Error("synthetic Gmail modify failure");
          const m = messages.get(id);
          m.labels = [...new Set([...m.labels.filter(name => !remove.includes(name)), ...add])];
          return { id, labelIds: m.labels.map(name => name === "INBOX" ? name : labels.get(name)) };
        },
        Attachments: { get: (user, id, attachmentId) => {
          record("attachment", { user, id, attachmentId });
          const data = messages.get(id)?.external[attachmentId];
          if (data === undefined) throw new Error("unexpected attachment retrieval");
          return { data };
        } },
      },
    } },
    UrlFetchApp: {
      fetch: (url, init) => {
        if (url.startsWith("https://api.telegram.org/")) {
          record("telegram", { url, init });
          if (options.telegram) return response(options.telegram(url, init, events));
          return response({ status: 200, text: JSON.stringify({
            ok: true, result: { message_id: 101, chat: { id: -123456 } },
          }) });
        }
        record("provider", { url, init: json(init) });
        if (!options.provider) throw new Error("unexpected provider request in synthetic test");
        return response(options.provider(url, init, events) ?? resource());
      },
    },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      newTrigger: handler => {
        record("new-trigger", { handler });
        const builder = {
          timeBased: () => builder,
          atHour: hour => { record("trigger-hour", { hour }); return builder; },
          everyDays: days => { record("trigger-days", { days }); return builder; },
          inTimezone: timezone => { record("trigger-timezone", { timezone }); return builder; },
          create: () => {
            if (options.failTriggerCreate) throw new Error("synthetic trigger creation failure");
            const trigger = { getHandlerFunction: () => handler };
            triggers.push(trigger);
            record("trigger-create", { handler });
            return trigger;
          },
        };
        return builder;
      },
      deleteTrigger: trigger => {
        record("trigger-delete", { handler: trigger.getHandlerFunction() });
        if (options.failTriggerDelete?.(trigger)) throw new Error("synthetic trigger deletion failure");
        triggers.splice(triggers.indexOf(trigger), 1);
      },
    },
  };
  // Intentionally omit Buffer, URL, process, require and any network implementation.
  vm.runInNewContext(bundle, context, { timeout: 10000, filename: "synthetic-apps-script-bundle.js" });
  return {
    api: context.CibusBot, context, events, messages, labels, properties, triggers,
    count: type => events.filter(event => event.type === type).length,
    operations: type => events.filter(event => event.type === type),
  };
}
