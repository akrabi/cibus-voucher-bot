# cibus-voucher-bot

Send Cibus vouchers from a dedicated Gmail account into a private Telegram
group. Each message contains an uncompressed barcode PNG, its value, retailer,
**purchase date**, and **voucher number**. The file is named
`voucher-<voucher-number>.png`, using the exact number beneath the email's
embedded barcode, including leading zeros. Successfully imported emails are
archived, not deleted.
After the cashier accepts a voucher, manually delete its Telegram message
**for everyone**.

Runs on Google Apps Script once daily, between 9 and 10 AM in `Asia/Jerusalem`
(Israel time, including daylight-saving changes). No server, database, webhook,
wallet UI, or inbound bot commands are required. Gmail retains delivery state
and original vouchers. This project is not affiliated with Cibus or Pluxee.

## Supported email format

The first version supports the inspected Hebrew Cibus/Pluxee template:

- Sender: `noreply@notifications.pluxee.co.il`.
- Subject starting with `שובר על סך ₪`, with the amount and retailer.
- Exactly one voucher; value must agree between subject and order amount.
- An explicit purchase date following `נרכש ב:`, in `DD/MM/YYYY` format.
- Barcode GIF referenced as `cid:img1.<digits>.<digits>.GIF`, matched against
  either attachment Content-ID **or filename**.
- If the attachment is absent or broken, a fallback link on
  `https://myconsumers.pluxee.co.il/b?...`. Its supported HTML page must contain
  a single image whose `alt` matches the voucher number in the email.

The observed barcode is only two pixels high. The importer decodes its GIF,
enlarges it with nearest-neighbor sampling, and adds white margins. It uploads
PNG using Telegram `sendDocument` to avoid photo compression. Telegram shows
it as an image document; tap it to open the barcode. The importer does not
generate or guess barcode contents.
The Apps Script Gmail advanced service can return already-decoded byte arrays.
Those bytes are validated and used directly, without a second Base64 decode.
String responses in standard Base64 or Base64URL are normalized, validated, and
padded before decoding. Both paths check the decoded length against Gmail's
declared body size. ASCII whitespace is allowed in encoded text; malformed data
still fails explicitly.

Expiry is deliberately **not** extracted or calculated. Purchase date is not
an expiry date. The bot does not verify merchant redemption or remaining
balance. Unknown templates, multiple vouchers, inconsistent fields, unexpected
image hosts, and invalid images require manual review.

## Local development

Use Node.js 22 or newer and npm. On Windows, `npm.cmd` avoids PowerShell
argument-forwarding surprises.

```powershell
npm.cmd ci
npm.cmd run check
```

Source modules are in `src`; tests use synthetic vouchers only. `npm run build`
bundles dependencies into `dist` for the Apps Script V8 runtime. `dist` is
generated and ignored by Git.

Inspect a locally downloaded Gmail `.eml` without uploading it or changing
Gmail/Telegram:

```powershell
node .\scripts\inspect-email.js 'C:\private\voucher.eml'
```

To also fetch the private fallback directly from the expected Cibus host:

```powershell
node .\scripts\inspect-email.js 'C:\private\voucher.eml' --fetch-fallback
```

This reports the caption with the voucher number redacted, output dimensions, and whether the normalized
attachment and fallback match. It never outputs the barcode number or private
link, saves no images, and does not send anything to Telegram. Keep real emails
and images outside the repository. Fixtures must be synthetic, not merely
renamed copies of real vouchers.

## One-time Google setup

1. Sign in to the **dedicated voucher Gmail account** and enable the Apps
   Script API at <https://script.google.com/home/usersettings>.
2. Authenticate the local deployment tool with that account:

   ```powershell
   npm.cmd run clasp -- login
   ```

   On Google's permission screen, select **Create and update Google Apps Script
   projects**. This is sufficient for creating this standalone project and
   uploading code; leave Drive browsing, deployment, logging, web-app publishing,
   service-management, and broad Google Cloud permissions unchecked. The
   importer's Gmail/runtime permissions are authorized separately on first run.

3. Create a standalone project. Do this **before** the first build/push for a
   new project; creation may write a generated manifest.

   ```powershell
   npm.cmd run clasp -- create --type standalone --title cibus-voucher-bot --rootDir dist
   npm.cmd run build
   npm.cmd run clasp -- show-file-status
   npm.cmd run clasp -- push
   ```

   For a newly created, empty remote project, clasp may ask to replace its
   default manifest. Confirm that prompt. In a noninteractive terminal, use
   `npm.cmd run clasp -- push --force` for this initial upload only. Do not
   overwrite an existing project's manifest without reviewing the changes.

   Only `bundle.js`, `entrypoints.js`, and `appsscript.json` should be uploaded.
   `.clasp.json` and local authentication files are excluded from Git.
   The project commands use the named `cibus-voucher-bot` login in the ignored
   local `.clasprc.json`, not your default/global clasp credentials. Keep using
   these commands for login, project creation, and deployment.
   If you already created the project, use its Script ID in a local
   `.clasp.json` with `"rootDir": "dist"` instead of creating another project.
   Do not use `clasp pull` as a source-editing workflow: edit `src` and rebuild.
4. Open the project at <https://script.google.com>. The manifest enables the
   Gmail advanced service. If using a manually associated standard Google Cloud
   project, enable **Gmail API** in that project's Cloud console as well.
5. Under **Project Settings > Script properties**, add:

   | Property | Value |
   |---|---|
   | `EXPECTED_GMAIL_ACCOUNT` | The dedicated account's exact email address |
   | `TELEGRAM_BOT_TOKEN` | Token obtained from BotFather |
   | `TELEGRAM_CHAT_ID` | Private group's numeric ID, including its leading minus sign |
   | `IMPORT_ENABLED` | `false` initially |

   Do not paste tokens in code, terminal commands, issues, or screenshots.
   Script editors can read these properties, so restrict project access.

The account check prevents accidentally processing your primary mailbox.
Gmail's `gmail.modify` OAuth permission still covers the whole dedicated
mailbox; candidate labels are an application filter, not an OAuth boundary.
Initial execution prompts for Gmail access, external HTTP requests, and
scheduled-trigger management.

## Telegram setup

1. Create a bot with the official **@BotFather**, then a private group containing
   you, your spouse, and the bot. Leave bot privacy mode enabled.
2. Both people must be group admins able to delete others' messages. The bot
   only needs to send documents; it does not need admin rights or permission
   to read all messages.
3. Obtain the group ID from a local call to Telegram `getUpdates` after sending
   a command mentioning the bot in the group. Keep the token in a hidden prompt,
   not a browser URL, and print only chat IDs:

   ```powershell
   $secret = Read-Host 'Bot token' -AsSecureString
   $token = [System.Net.NetworkCredential]::new('', $secret).Password
   try {
     $base = "https://api.telegram.org/bot$token"
     $me = Invoke-RestMethod "$base/getMe"
     Write-Host "Using bot: @$($me.result.username)"
     $response = Invoke-RestMethod "$base/getUpdates"
     $groups = @(
       $response.result |
         ForEach-Object { $_.message.chat; $_.my_chat_member.chat } |
         Where-Object { $_.type -in @('group', 'supergroup') } |
         Select-Object -Unique id, type
     )
     if ($groups.Count) {
       $groups | Format-Table
     } else {
       Write-Host "No group found. Send /start@$($me.result.username) in the group, then retry."
     }
   } catch {
     Write-Error 'Telegram lookup failed; verify the token and try again. Do not share raw errors.'
   } finally {
     Remove-Variable token, secret, base, me, response, groups -ErrorAction SilentlyContinue
   }
   ```

   Run this only in a trusted local terminal with no HTTP debugging/transcription.
   If the group is converted to a supergroup later, update its ID before
   importing more vouchers.

Telegram bot/group chats are not end-to-end encrypted. Uploaded vouchers are
spendable secrets stored in Telegram's cloud; private membership is essential.

## First import and schedule

1. In Gmail create the label **Cibus/Candidate**. Initially apply it to **one
   known-unused voucher only**. Do not bulk import historical emails: some
   vouchers may already have been redeemed.
2. Run `previewImport` in the Apps Script editor and authorize the requested
   scopes. This may create bookkeeping labels and fetch the Cibus image, but
   does not send to Telegram, change email labels, or archive messages.
   It reports `READY` with value, purchase date, and image dimensions, or a
   safe review reason. The voucher number appears as `[redacted]` in preview
   output/logs; the real Telegram caption and document filename include it.
3. Set `IMPORT_ENABLED` to `true` and run `runImport` manually. Check the image
   and caption on both phones. Verify that only the imported email left the
   inbox and remains under **Cibus/Imported** and **All Mail**.
4. Confirm scanning at your usual supermarket before relying on the automation.
   Delete the voucher message for everyone **only after cashier acceptance**.
   Also check deletion of an older, non-redeemable test message; Bot API's
   48-hour delete limit is irrelevant to human-admin manual deletion.
5. Create a Gmail filter for new mail from the expected sender with
   `שובר על סך` in its subject. Apply **Cibus/Candidate**, but **do not** select
   "Skip the Inbox". Do not apply it to all old conversations unless you have
   manually checked those vouchers.
6. Run `enableSchedule` once to create a daily trigger between 9 and 10 AM
   Israel time. Google selects the exact time within that hour; it is not
   guaranteed to run at 9:00 sharp. The function replaces existing importer
   triggers, including older five-minute schedules, while preserving unrelated
   triggers. Repeated calls leave one importer trigger. Uploading code alone
   does not change an existing trigger: rerun `enableSchedule` after upgrading.
   New vouchers normally wait until the next daily run; use `runImport`
   manually for an immediate import when needed.
   Review Apps Script **Executions** and
   **Cibus/Review-needed** regularly, including Google's trigger failure emails.

Run `disableSchedule` to remove this project's importer triggers, and set
`IMPORT_ENABLED=false` to prevent subsequent manual imports. Disabling does
not cancel an already-running execution.
Schedule changes share the import lock. If a command reports
`IMPORT_ALREADY_RUNNING`, retry it after the current execution finishes.

## Delivery state and recovery

| Gmail label | Meaning |
|---|---|
| `Cibus/Candidate` | Selected for import, including manually archived candidates |
| `Cibus/Processing` | Claimed before send; interrupted/uncertain delivery must be reconciled |
| `Cibus/Imported` | Telegram confirmed image/caption delivery; source is archived |
| `Cibus/Review-needed` | Unsupported content, duplicate voucher, or failed/uncertain operation |
| `Cibus/Key/<hash>` | Voucher identity claim, preventing duplicates across separate emails |

The per-voucher label uses a SHA-256 fingerprint, never a barcode number in the
label name. Keep these labels private and intact. It is persistent bookkeeping
inside Gmail, not an external database; one label is created per attempted
unique voucher. Gmail's label limits make this suitable for household use, not
an unbounded service. Do not delete key labels to reduce clutter: that removes
duplicate protection.
Keep the original emails too: permanently deleting a claimed source can remove
the evidence used to recognize its voucher in a later duplicate email.

The sender/subject checks select supported mail; they are not cryptographic
sender authentication. Keep candidate selection restricted to legitimate mail.

All state changes are **per message**, not per Gmail conversation. Removing
`INBOX` from an imported email does not archive a new, unprocessed email in the
same thread. An Imported source will never be resent automatically, even if
its Telegram message is deleted. If it reappears in the inbox, the importer
archives it again without sending.

Gmail labels and Telegram sends cannot form a single transaction. The importer
locks concurrent runs, claims the voucher before sending, and **never retries
a Telegram send automatically after failure or uncertainty**. It retries
idempotent Gmail finalization up to three times. Failed/uncertain deliveries
remain unarchived and are marked for review. If a label mutation was accepted
by Gmail but its response was lost, reconcile the actual Gmail state.

### Manual review

- **No send happened** (for example, an unsupported template): correct the
  cause, then remove Review-needed. Keep Candidate. Do not change source
  content just to bypass checks.
- **Send may have happened**: first inspect Telegram for the message's
  `Source: <Gmail message ID>`. If delivered, manually add Imported, remove
  Processing/Review-needed, and archive that source. Keep the key label.
- **Confirmed not delivered and not redeemed**: after explicit reconciliation,
  remove Processing and Review-needed on that source to allow a retry.
  The key on the same source is permitted; another source with the same key
  remains blocked.
- **Duplicate email**: leave it in Review-needed or archive it manually after
  checking the original. Do not clear the original's identity claim.
- **Deleted the wrong Telegram message**: find the original under Imported or
  All Mail, verify it was not redeemed, and restore it manually. Do not clear
  Imported labels or bulk rebuild the Telegram chat.

Review errors contain source IDs and fixed error codes, not email bodies,
voucher numbers, tokens, private links, or raw HTTP responses. A failure to
write the review label fails the execution visibly rather than pretending
recovery succeeded.
Unexpected errors also include the failing operation, a standard error type,
and line numbers from the generated script. Raw exception messages and stack
traces are not logged.
Invalid body encodings report only their data type, length modulo four, and
format flags (alphabet, whitespace, unexpected characters), never body content.

## Repository and deployment

Maintain a **private** GitHub repository. Commit source, this guide, tests, and
`package-lock.json`; never commit real mail, voucher images, signed URLs, bot
tokens, `.clasp.json`, or authentication files. `.gitignore` is a safety net,
not a substitute for checking staged files.

After a code change:

```powershell
npm.cmd run check
npm.cmd run push
```

No web-app deployment or public endpoint is needed. Triggers execute the
pushed source. Keep automatic CI deployment out of the initial setup.

References: [Apps Script/clasp](https://developers.google.com/apps-script/guides/clasp),
[Telegram Bot API](https://core.telegram.org/bots/api),
[Gmail message modification](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify).
