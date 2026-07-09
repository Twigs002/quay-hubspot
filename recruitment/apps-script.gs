/**
 * Quay 1 — Recruitment intake backend (Google Apps Script Web App)
 * ---------------------------------------------------------------------------
 * Receives a POST from the dashboard recruitment form and:
 *   1. verifies a shared secret token
 *   2. creates a per-hire folder under "Broker Onboarding"
 *   3. saves any uploaded documents (ID / proof of address / bank / FFC)
 *   4. generates the Memorandum of Agreement from the Google Doc template,
 *      resolving every conditional term from the chosen broker activity,
 *      and exports it to PDF into the folder
 *   5. appends a row to the tracking Sheet
 *   6. returns { ok, folderUrl, pdfUrl }
 *
 * SETUP (fill these in, then Deploy → New deployment → Web app,
 *        "Execute as: me", "Who has access: Anyone with the link"):
 */
var CONFIG = {
  SECRET_TOKEN: 'CHANGE_ME_LONG_RANDOM_STRING',   // must match the form's token
  PARENT_FOLDER_NAME: 'Broker Onboarding',        // created at Drive root if missing
  TEMPLATE_DOC_ID: 'PASTE_GOOGLE_DOC_TEMPLATE_ID', // the uploaded template as a Google Doc
  TRACKING_SHEET_ID: 'PASTE_TRACKING_SHEET_ID',    // a Google Sheet; tab "Log"
};

// Broker-activity definitions + axes. Keys match the form's activity `code`.
var ACTIVITIES = {
  sell_res_sb: { txn: 'sale',   prop: 'residential', def: 'The selling and/or brokerage of immovable residential property or a broker performing his/her/their functions to such an end; and/or' },
  sell_res_jb: { txn: 'sale',   prop: 'residential', def: 'The selling and/or brokerage of immovable residential property or an assistant to a broker performing his/her/their functions to such an end; and/or' },
  sell_com_sb: { txn: 'sale',   prop: 'commercial',  def: 'The selling and/or brokerage of immovable commercial property or a broker performing his/her/their functions to such an end; and/or' },
  sell_com_jb: { txn: 'sale',   prop: 'commercial',  def: 'The selling and/or brokerage of immovable commercial property or an assistant to a broker performing his/her/their functions to such an end; and/or' },
  rent_res_sb: { txn: 'rental', prop: 'residential', def: 'The renting and/or brokerage for rent of immovable residential property or a broker performing his/her/their functions to such an end; and/or' },
  rent_res_jb: { txn: 'rental', prop: 'residential', def: 'The renting and/or brokerage for rent of immovable residential property or an assistant to a broker performing his/her/their functions to such an end; and/or' },
  rent_com_sb: { txn: 'rental', prop: 'commercial',  def: 'The renting and/or brokerage for rent of immovable commercial property or a broker performing his/her/their functions to such an end; and/or' },
  rent_com_jb: { txn: 'rental', prop: 'commercial',  def: 'The renting and/or brokerage for rent of immovable commercial property or an assistant to broker performing his/her/their functions to such an end.' },
};

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    // Candidate upload page is public — authorised by the folder-id capability
    // in its link, not the admin secret token.
    if (body.kind === 'candidate_upload') return _json(handleCandidateUpload_(body));
    if (body.token !== CONFIG.SECRET_TOKEN) return _json({ ok: false, error: 'unauthorized' });

    var f = body.fields || {};
    var folder = _hireFolder_(f.full_name, f.id_number);

    // 1) Save uploaded documents.
    (body.files || []).forEach(function (file) {
      if (!file || !file.dataBase64) return;
      var blob = Utilities.newBlob(Utilities.base64Decode(file.dataBase64), file.mimeType, file.name);
      folder.createFile(blob);
    });

    // 2) Generate the MOA (contract) if an activity was chosen.
    var pdfUrl = '';
    if (f.activity && ACTIVITIES[f.activity] && CONFIG.TEMPLATE_DOC_ID.indexOf('PASTE') !== 0) {
      pdfUrl = _generateContract_(folder, f);
    }

    // 3) Log to the tracking Sheet.
    if (CONFIG.TRACKING_SHEET_ID.indexOf('PASTE') !== 0) {
      var sh = SpreadsheetApp.openById(CONFIG.TRACKING_SHEET_ID).getSheetByName('Log')
            || SpreadsheetApp.openById(CONFIG.TRACKING_SHEET_ID).insertSheet('Log');
      sh.appendRow([new Date(), f.full_name || '', f.id_number || '', f.team || '',
                    f.senior_broker || '', f.start_date || '', f.activity || '',
                    f.commission || '', folder.getUrl(), pdfUrl]);
    }

    return _json({ ok: true, folderUrl: folder.getUrl(), pdfUrl: pdfUrl });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

/** Create/find "Broker Onboarding / «Name — ID»". */
function _hireFolder_(name, id) {
  var root = _folderByName_(DriveApp.getRootFolder(), CONFIG.PARENT_FOLDER_NAME, true);
  var label = ((name || 'Unknown') + ' — ' + (id || '')).trim();
  return _folderByName_(root, label, true);
}

function _folderByName_(parent, name, createIfMissing) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return createIfMissing ? parent.createFolder(name) : null;
}

/** Copy the template, resolve all tokens, export PDF into the folder. */
function _generateContract_(folder, f) {
  var a = ACTIVITIES[f.activity];
  var sale = a.txn === 'sale';
  var partnershipActivity = a.prop === 'commercial'
      ? 'selling or leasing immovable commercial property'
      : (sale ? 'selling immovable residential property'
              : 'renting/leasing immovable residential property');

  var map = {
    '{{full_name}}':   f.full_name || '',
    '{{id_number}}':   f.id_number || '',
    '{{start_date}}':  f.start_date || '',
    '{{senior_broker}}': f.senior_broker || '',
    '{{commission}}':  String(f.commission || ''),
    '{{definition}}':  a.def,
    '{{partnership_activity}}': partnershipActivity,
    '{{prop}}':    a.prop,
    '{{verb}}':    sale ? 'sell' : 'rent',
    '{{price}}':   sale ? 'purchase' : 'rental',
    '{{buyers}}':  sale ? 'purchasers' : 'tenants',
    '{{seller}}':  sale ? 'seller' : 'lessor',
    '{{saledoc}}': sale ? 'Deed of Sale' : 'Lease Agreement',
  };

  var docName = 'Memorandum of Agreement - ' + (f.full_name || 'Broker');
  var copyId = DriveApp.getFileById(CONFIG.TEMPLATE_DOC_ID).makeCopy(docName, folder).getId();
  var doc = DocumentApp.openById(copyId);
  var b = doc.getBody();
  Object.keys(map).forEach(function (k) {
    b.replaceText(_escRe_(k), map[k]);   // literal token -> value
  });
  doc.saveAndClose();

  var pdfFile = folder.createFile(DriveApp.getFileById(copyId).getAs('application/pdf')).setName(docName + '.pdf');

  // Email the contract to the candidate, CC the requesting manager, and include
  // the candidate's personal upload link (for their docs + address/banking).
  if (f.candidate_email) {
    var uploadLink = _uploadLinkFor_(folder.getId());
    var body =
      'Hi ' + (f.full_name || '') + ',\n\n' +
      'Please find your Quay 1 Broker Agreement attached.\n\n' +
      'Next step: upload your supporting documents (ID, proof of address, proof of bank) ' +
      'and complete your details here:\n' + uploadLink + '\n\n' +
      'Kind regards,\nQuay 1 International Realty';
    GmailApp.sendEmail(f.candidate_email, 'Your Quay 1 Broker Agreement', body, {
      cc: f.requester_email || '',
      name: 'Quay 1 International Realty',
      attachments: [pdfFile.getAs('application/pdf')],
    });
  }
  return pdfFile.getUrl();
}

/** Public upload page URL carrying a token that maps to the hire's folder. */
function _uploadLinkFor_(folderId) {
  // Capability token = folder id (candidate-facing). Swap for a random token
  // stored in the Sheet if you want to decouple the URL from the folder id.
  return 'https://twigs002.github.io/quay-hubspot/intake.html?f=' + encodeURIComponent(folderId);
}

/**
 * Candidate upload handler (called by intake.html). Adds their uploaded docs to
 * the existing hire folder and records the plain-text details on the Sheet.
 * Payload: { token, folderId, details:{...}, files:[{name,mimeType,dataBase64}] }
 */
function handleCandidateUpload_(body) {
  var folder = DriveApp.getFolderById(body.folderId);   // token = folderId for now
  (body.files || []).forEach(function (file) {
    if (!file || !file.dataBase64) return;
    folder.createFile(Utilities.newBlob(Utilities.base64Decode(file.dataBase64), file.mimeType, file.name));
  });
  // Save the plain-text details as a note file in the folder + flag on the Sheet.
  var d = body.details || {};
  folder.createFile('Candidate details.txt', Object.keys(d).map(function (k) { return k + ': ' + d[k]; }).join('\n'));
  if (CONFIG.TRACKING_SHEET_ID.indexOf('PASTE') !== 0) {
    var sh = SpreadsheetApp.openById(CONFIG.TRACKING_SHEET_ID).getSheetByName('Log');
    if (sh) sh.appendRow([new Date(), '(candidate upload)', '', '', '', '', '', '', folder.getUrl(),
                          'docs+details received']);
  }
  return { ok: true, folderUrl: folder.getUrl() };
}

function _escRe_(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function _json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
