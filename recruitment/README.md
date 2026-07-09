# Recruitment backend — deploy steps

The recruitment forms POST to a Google Apps Script Web App that files everything
into Google Drive and generates the Memorandum of Agreement. Nothing is sent
until this is deployed and the endpoint is wired into `app.js`.

## Files here
- `Broker Agreement - TEMPLATE.docx` — the contract template with `{{tokens}}`
  (converted from the blank Broker Agreement; legal wording unchanged).
- `apps-script.gs` — the Web App backend.

## One-time setup (you do this in your Google account)
1. **Upload the template as a Google Doc.** Upload `Broker Agreement - TEMPLATE.docx`
   to Drive → open with Google Docs → File → Save as Google Doc. Copy its **doc ID**
   (the long string in the URL `/document/d/<ID>/edit`).
2. **Make a tracking Sheet.** New Google Sheet, add a tab named `Log`. Copy its **sheet ID**.
3. **Create the Apps Script.** script.google.com → New project → paste `apps-script.gs`.
   Fill `CONFIG`:
   - `SECRET_TOKEN` — a long random string (I'll put the same one in `app.js`).
   - `TEMPLATE_DOC_ID` — from step 1.
   - `TRACKING_SHEET_ID` — from step 2.
   - `PARENT_FOLDER_NAME` — leave as `Broker Onboarding` (auto-created).
4. **Deploy.** Deploy → New deployment → type **Web app** → Execute as **Me** →
   Who has access **Anyone with the link** → Deploy. Authorize the Drive/Docs/Sheets
   scopes when prompted. Copy the **Web app URL**.
5. **Send me** the Web app URL + the SECRET_TOKEN you chose. I set `RECRUIT_ENDPOINT`
   and `RECRUIT_TOKEN` in `app.js`, and the form goes live.

## Token map (contract merge)
`{{full_name}} {{id_number}} {{start_date}} {{senior_broker}} {{commission}}` = direct fills.
`{{definition}}` = the chosen broker-activity paragraph.
Activity also drives: `{{prop}}` (residential/commercial), `{{verb}}` (sell/rent),
`{{price}}` (purchase/rental), `{{buyers}}` (purchasers/tenants), `{{seller}}` (seller/lessor),
`{{saledoc}}` (Deed of Sale/Lease Agreement), `{{partnership_activity}}` (clause 4.3.2).
