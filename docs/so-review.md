# SO Review

Admin-only section of the app that checks every SO waiting in a **NEED TO RELEASE** folder: are the release documents there, do their values match the app, and has the SO been released by email.

## How it works

The app runs in the cloud and cannot reach the office share or Outlook, so the checks run on an office PC (the **review PC**) and send their results to the app.

| Part | Where | What it does |
|---|---|---|
| `agent/so-review-agent.js` | review PC (Task Scheduler) | scans the folders, reads the PDFs, compares them with the app, reads Outlook, moves released folders, sends results |
| `agent/so-docs.js` | review PC | document readers, field checks, release decision (unit-tested in `tests/so-review.test.js`) |
| `agent/outlook-release-mail.ps1` | review PC | read-only export of the "RELEASE SO…" emails from Outlook desktop |
| `supabase/so-review.sql` | database | `so_review_sos` (one row per SO), `so_reviews` (history), `so_folder_moves` (move log), `so_review_requests` (Run now / Confirm release) |
| API `sr*` actions | edge function | admin page actions; `srAgent*` actions only accept the review PC's key (`SO_REVIEW_AGENT_KEY` secret) |
| SO Review page | app, admins only | summary, per-SO results with every check, release evidence, Confirm release, move log, history |

### Folders
`SO RELEASE STATUS\<CUSTOMER>\NEED TO RELEASE*\<SO#>` (and the top-level `NEED TO RELEASE`). Only folders named like an SO (`25808`, `25865R`, `R23666`) are reviewed; others (e.g. `MRB PULL SO LIST`) are listed as skipped. A released SO moves to the customer's own `RELEASED*` folder (`RAYMOND\RELEASED`, `IR\RELEASED IR`, …). Files are never edited or deleted; a folder is never moved twice or onto an existing one.

### The five required documents
1. Routing (`PART ROUTER`) 2. Traveler (`PART TRAVELER`) 3. Material PO (`PO`) or stock requisition (`REQ. FORM`) 4. Supplier sales confirmation (`Sales_Acknowledgment`, `Sales_Confirmation`, `…_Order`); not needed when material comes from stock 5. Part print (scanned: presence only).

### Field checks (app vs documents)
SO number (folder, routing, traveler, PO), part number, description (routing vs traveler), customer, order quantity, part price, steel type/grade, material cost per piece, due date, bar size, pieces per bar, routing operations and sequence (routing vs traveler), material PO number and total, PO lists this SO, supplier confirmation is for the same PO and names the SO/part, supplier total vs PO total, steel grade on the material order.

**Result:** MISSING DOCUMENT (a required document missing or unreadable) · FAIL (any critical/major mismatch, or the SO is not in the app) · PASS (everything present and matching) · PENDING REVIEW (not reviewed yet).

### Release confirmation
Only replies from Charlotte Hamblin or Jay Green in that SO's `RELEASE SO…` thread count:
- **Released** (folder moved automatically): a clear statement such as "Released." / "Approved." with no hedging.
- **Possible release**: any other reply ("yes", an image, "should be released") – an admin clicks **Confirm release** to move it.
- **Not released**: no reply, "Not yet", or a change request (also flagged).
A released SO whose documents did not PASS is moved but flagged **Released with problems**.

## Setup on the review PC
1. Node.js, Outlook desktop signed in to the mailbox, access to `\\192.168.10.10\Public`, and `pdftotext` (comes with Git for Windows).
2. `agent/so-review.config.json` (not in git): `apiUrl`, `agentKey`, `root`, `pdftotext`, `approvers`, `mailDays`, `fullEveryMinutes`, `moveFolders`.
3. Database: run `supabase/so-review.sql` once. Secret: `SO_REVIEW_AGENT_KEY` must equal `agentKey`.
4. `powershell -ExecutionPolicy Bypass -File agent\install-task.ps1` registers the task (every 2 minutes; a full review every 30 minutes or when requested). It runs only while the user is signed in.

## Commands
- `node agent/so-review-agent.js` full review now · `--dry-run` no folder moves · `--no-submit` do not send to the app · `--full-mail` re-read a year of email
- `node agent/test/run-scenarios.js` end-to-end test on made-up folders (no app, no real folders)
- Logs: `%LOCALAPPDATA%\so-review-agent\agent.log`, last run: `last-run.json`

## Troubleshooting
Problems appear at the top of the SO Review page: share unreachable, Outlook unavailable, SO not in the app, duplicate folder, destination already exists, move failed.
