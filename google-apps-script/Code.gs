const SCRIPT_VERSION = 'time-machine-source-of-truth-v1';
const DEFAULT_SPREADSHEET_ID = '1K-Gu_ffMlY2N7rOy_yUpPSByQh61U40959CJrXUhCso';
const STATE_SHEET_NAME = 'TimeMachineState';
const AUDIT_SHEET_NAME = 'TimeMachineAudit';
const STATE_CHUNK_SIZE = 45000;

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || 'health');
  let payload;

  try {
    if (action === 'health') payload = healthPayload_();
    else if (action === 'state') payload = statePayload_();
    else if (action === 'status') payload = statusPayload_(params.token);
    else payload = { ok: false, scriptVersion: SCRIPT_VERSION, message: 'Unknown action' };
  } catch (error) {
    payload = errorPayload_(error);
  }

  return output_(payload, params.callback);
}

function doPost(e) {
  let request = {};
  try {
    request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    handlePost_(request);
    return output_({ ok: true, scriptVersion: SCRIPT_VERSION });
  } catch (error) {
    if (request && request.syncToken) {
      setStatus_(request.syncToken, {
        ok: true,
        token: request.syncToken,
        status: 'failed',
        message: safeErrorMessage_(error),
      });
    }
    return output_(errorPayload_(error));
  }
}

function handlePost_(request) {
  const action = String(request.action || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureSchema_();
    if (action === 'setupKey') return setupKey_(request);
    if (action === 'verifyKey') return verifyKey_(request);
    if (action === 'saveState') return saveState_(request);
    if (action === 'repairSchema') return repairSchema_(request);
    throw new Error('Unknown action');
  } finally {
    lock.releaseLock();
  }
}

function healthPayload_() {
  ensureSchema_();
  return {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    keyConfigured: keyConfigured_(),
    revision: currentRevision_(),
    schemaOk: true,
    updatedAt: getStateMap_().updatedAt || '',
  };
}

function statePayload_() {
  ensureSchema_();
  const state = readMasterState_();
  if (!state) {
    return {
      ok: false,
      scriptVersion: SCRIPT_VERSION,
      keyConfigured: keyConfigured_(),
      revision: currentRevision_(),
      schemaOk: true,
      message: 'No Google master backup yet',
    };
  }
  const map = getStateMap_();
  return {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    keyConfigured: keyConfigured_(),
    schemaOk: true,
    revision: currentRevision_(),
    updatedAt: map.updatedAt || '',
    state: state,
  };
}

function statusPayload_(token) {
  const cleanToken = String(token || '');
  if (!cleanToken) return { ok: false, scriptVersion: SCRIPT_VERSION, message: 'Missing token' };
  const raw = PropertiesService.getScriptProperties().getProperty(statusKey_(cleanToken));
  if (!raw) {
    return {
      ok: false,
      scriptVersion: SCRIPT_VERSION,
      token: cleanToken,
      status: '',
      message: 'Status not ready',
    };
  }
  return JSON.parse(raw);
}

function setupKey_(request) {
  const token = String(request.syncToken || '');
  const passKey = String(request.passKey || '');
  if (passKey.length < 4) throw new Error('Principal key must have at least 4 characters');

  let status;
  if (!keyConfigured_()) {
    const salt = Utilities.getUuid();
    setScriptProperty_('principalKeySalt', salt);
    setScriptProperty_('principalKeyHash', hashKey_(passKey, salt));
    status = 'key-created';
    appendAudit_('setupKey', 'Shared Principal key created');
  } else if (principalKeyMatches_(passKey)) {
    status = 'verified';
  } else {
    status = 'rejected';
  }

  setStatus_(token, {
    ok: true,
    token: token,
    status: status,
    scriptVersion: SCRIPT_VERSION,
    keyConfigured: keyConfigured_(),
    revision: currentRevision_(),
    message: status === 'rejected' ? 'Wrong Principal key' : 'Principal key ready',
  });
}

function verifyKey_(request) {
  const token = String(request.syncToken || '');
  const verified = principalKeyMatches_(String(request.passKey || ''));
  setStatus_(token, {
    ok: true,
    token: token,
    status: verified ? 'verified' : 'rejected',
    scriptVersion: SCRIPT_VERSION,
    keyConfigured: keyConfigured_(),
    revision: currentRevision_(),
    message: verified ? 'Principal key verified' : 'Wrong Principal key',
  });
}

function saveState_(request) {
  const token = String(request.syncToken || '');
  if (!keyConfigured_()) throw new Error('Create the Principal key first');
  if (!principalKeyMatches_(String(request.passKey || ''))) {
    setRejectedStatus_(token, 'Wrong Principal key');
    return;
  }

  const baseRevision = Number(request.baseRevision || 0);
  const revision = currentRevision_();
  if (revision > 0 && baseRevision < revision) {
    setStatus_(token, {
      ok: true,
      token: token,
      status: 'conflict',
      scriptVersion: SCRIPT_VERSION,
      keyConfigured: true,
      revision: revision,
      message: 'This device is stale. Force connect before saving.',
    });
    return;
  }

  const nextState = request.state;
  if (!nextState || typeof nextState !== 'object') throw new Error('Missing app state');
  const nextRevision = revision + 1;
  const savedAt = new Date().toISOString();
  writeMasterState_(nextState, nextRevision, savedAt);
  appendAudit_('saveState', 'Master timetable saved');
  setStatus_(token, {
    ok: true,
    token: token,
    status: 'saved',
    scriptVersion: SCRIPT_VERSION,
    keyConfigured: true,
    revision: nextRevision,
    savedAt: savedAt,
    message: 'Google saved',
  });
}

function repairSchema_(request) {
  const token = String(request.syncToken || '');
  if (keyConfigured_() && !principalKeyMatches_(String(request.passKey || ''))) {
    setRejectedStatus_(token, 'Wrong Principal key');
    return;
  }
  ensureSchema_();
  setStatus_(token, {
    ok: true,
    token: token,
    status: 'schema-repaired',
    scriptVersion: SCRIPT_VERSION,
    keyConfigured: keyConfigured_(),
    revision: currentRevision_(),
    message: 'Google Sheet format repaired',
  });
}

function ensureSchema_() {
  const stateSheet = getOrCreateSheet_(STATE_SHEET_NAME);
  if (stateSheet.getLastRow() === 0) {
    stateSheet.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
    stateSheet.setFrozenRows(1);
  }
  const auditSheet = getOrCreateSheet_(AUDIT_SHEET_NAME);
  if (auditSheet.getLastRow() === 0) {
    auditSheet.getRange(1, 1, 1, 3).setValues([['Timestamp', 'Action', 'Summary']]);
    auditSheet.setFrozenRows(1);
  }
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(DEFAULT_SPREADSHEET_ID);
}

function getOrCreateSheet_(name) {
  const ss = getSpreadsheet_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getStateMap_() {
  ensureSchema_();
  const sheet = getOrCreateSheet_(STATE_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values.reduce(function (memo, row) {
    const key = String(row[0] || '');
    if (key) memo[key] = String(row[1] || '');
    return memo;
  }, {});
}

function writeStateMap_(map) {
  const sheet = getOrCreateSheet_(STATE_SHEET_NAME);
  sheet.clearContents();
  const rows = [['Key', 'Value']].concat(
    Object.keys(map)
      .sort()
      .map(function (key) {
        return [key, map[key]];
      })
  );
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.setFrozenRows(1);
}

function readMasterState_() {
  const map = getStateMap_();
  const chunks = Object.keys(map)
    .filter(function (key) {
      return key.indexOf('state:') === 0;
    })
    .sort(function (a, b) {
      return Number(a.split(':')[1]) - Number(b.split(':')[1]);
    })
    .map(function (key) {
      return map[key];
    });
  if (!chunks.length) return null;
  return JSON.parse(chunks.join(''));
}

function writeMasterState_(state, revision, savedAt) {
  const json = JSON.stringify(state);
  const map = getStateMap_();
  Object.keys(map).forEach(function (key) {
    if (key.indexOf('state:') === 0) delete map[key];
  });
  for (let index = 0; index < json.length; index += STATE_CHUNK_SIZE) {
    map['state:' + String(index / STATE_CHUNK_SIZE).padStart(4, '0')] = json.slice(index, index + STATE_CHUNK_SIZE);
  }
  map.revision = String(revision);
  map.updatedAt = savedAt;
  map.scriptVersion = SCRIPT_VERSION;
  writeStateMap_(map);
}

function currentRevision_() {
  return Number(getStateMap_().revision || 0);
}

function keyConfigured_() {
  const props = PropertiesService.getScriptProperties();
  return Boolean(props.getProperty('principalKeyHash') && props.getProperty('principalKeySalt'));
}

function principalKeyMatches_(passKey) {
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('principalKeySalt') || '';
  const hash = props.getProperty('principalKeyHash') || '';
  if (!salt || !hash || !passKey) return false;
  return hashKey_(passKey, salt) === hash;
}

function hashKey_(passKey, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + passKey, Utilities.Charset.UTF_8);
  return digest
    .map(function (byte) {
      const value = byte < 0 ? byte + 256 : byte;
      return value.toString(16).padStart(2, '0');
    })
    .join('');
}

function setScriptProperty_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

function setStatus_(token, payload) {
  if (!token) return;
  const cleanPayload = Object.assign({ scriptVersion: SCRIPT_VERSION }, payload);
  PropertiesService.getScriptProperties().setProperty(statusKey_(token), JSON.stringify(cleanPayload));
}

function setRejectedStatus_(token, message) {
  setStatus_(token, {
    ok: true,
    token: token,
    status: 'rejected',
    keyConfigured: keyConfigured_(),
    revision: currentRevision_(),
    message: message,
  });
}

function statusKey_(token) {
  return 'status:' + String(token || '').slice(0, 120);
}

function appendAudit_(action, summary) {
  const sheet = getOrCreateSheet_(AUDIT_SHEET_NAME);
  sheet.appendRow([new Date().toISOString(), action, summary]);
}

function output_(payload, callback) {
  const json = JSON.stringify(payload);
  const cleanCallback = String(callback || '');
  if (cleanCallback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(cleanCallback)) {
    return ContentService.createTextOutput(cleanCallback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function errorPayload_(error) {
  let revision = 0;
  let keyConfigured = false;
  try {
    revision = currentRevision_();
    keyConfigured = keyConfigured_();
  } catch (ignored) {
    revision = 0;
    keyConfigured = false;
  }
  return {
    ok: false,
    scriptVersion: SCRIPT_VERSION,
    keyConfigured: keyConfigured,
    revision: revision,
    schemaOk: false,
    message: safeErrorMessage_(error),
  };
}

function safeErrorMessage_(error) {
  return String((error && error.message) || error || 'Request failed').slice(0, 240);
}
