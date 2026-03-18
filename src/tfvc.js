import 'dotenv/config';
import * as azdev from 'azure-devops-node-api';

const ORG_URL = process.env.AZURE_DEVOPS_ORG_URL;
const PAT = process.env.AZURE_DEVOPS_PAT;
const PROJECT = process.env.AZURE_DEVOPS_PROJECT;

if (!ORG_URL || !PAT || !PROJECT) {
  throw new Error(
    'Missing required env vars: AZURE_DEVOPS_ORG_URL, AZURE_DEVOPS_PAT, AZURE_DEVOPS_PROJECT'
  );
}

let _tfvcClient = null;

async function getTfvcClient() {
  if (_tfvcClient) return _tfvcClient;
  const authHandler = azdev.getPersonalAccessTokenHandler(PAT);
  const connection = new azdev.WebApi(ORG_URL, authHandler);
  _tfvcClient = await connection.getTfvcApi();
  return _tfvcClient;
}

/**
 * List TFVC items (files/folders) at the given path.
 * @param {string} scopePath   - TFVC path, e.g. "$/" or "$/ProjectName/src"
 * @param {string} recursionLevel - "None" | "OneLevel" | "Full"
 * @param {string|null} version - Optional changeset version, e.g. "12345"
 */
export async function listItems(scopePath = '$/', recursionLevel = 'OneLevel', version = null) {
  const client = await getTfvcClient();

  const versionDescriptor = version
    ? { version, versionType: 2 /* changeset */ }
    : undefined;

  const items = await client.getItems(
    PROJECT,
    scopePath,
    recursionLevel,
    true,       // includeLinks
    versionDescriptor
  );

  if (!items || items.length === 0) return [];

  return items.map(item => ({
    path: item.path,
    isFolder: item.isFolder ?? false,
    changesetVersion: item.changesetVersion,
    size: item.size,
    url: item.url,
  }));
}

/**
 * Get the text content of a single TFVC file.
 * Uses a direct REST API call because the SDK's getItemContent stream returns empty.
 * @param {string} path     - Full TFVC path, e.g. "$/ProjectName/src/App.cs"
 * @param {string|null} version - Optional changeset version number as string
 */
export async function getFileContent(path, version = null) {
  // Build query params
  const params = new URLSearchParams({
    path,
    download: 'false',
    includeContent: 'true',
    'api-version': '7.1',
  });
  if (version) {
    params.set('versionDescriptor.version', version);
    params.set('versionDescriptor.versionType', 'changeset');
  }

  const url = `${ORG_URL}/${encodeURIComponent(PROJECT)}/_apis/tfvc/items?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(':' + PAT).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`TFVC API error ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();

  // `content` holds the file text when includeContent=true
  if (typeof json.content === 'string') {
    return json.content;
  }

  throw new Error(`No content returned for path: ${path}`);
}

/**
 * List TFVC changesets with optional filters.
 * @param {object} options
 * @param {string}  [options.itemPath]  - Filter by TFVC item path
 * @param {string}  [options.author]    - Filter by author alias
 * @param {string}  [options.fromDate]  - ISO date string
 * @param {string}  [options.toDate]    - ISO date string
 * @param {number}  [options.maxCount]  - Max changesets to return (default 20)
 * @param {number}  [options.skip]      - Number of changesets to skip
 */
export async function listChangesets(options = {}) {
  const client = await getTfvcClient();
  const {
    itemPath,
    author,
    fromDate,
    toDate,
    maxCount = 20,
    skip = 0,
  } = options;

  const searchCriteria = {};
  if (itemPath) searchCriteria.itemPath = itemPath;
  if (author) searchCriteria.author = author;
  if (fromDate) searchCriteria.fromDate = fromDate;
  if (toDate) searchCriteria.toDate = toDate;

  const changesets = await client.getChangesets(
    PROJECT,
    maxCount,
    skip,
    undefined, // orderby
    searchCriteria
  );

  if (!changesets || changesets.length === 0) return [];

  return changesets.map(cs => ({
    changesetId: cs.changesetId,
    author: cs.author?.displayName,
    authorUnique: cs.author?.uniqueName,
    createdDate: cs.createdDate,
    comment: cs.comment,
    url: cs.url,
  }));
}

/**
 * Get full details of a specific changeset.
 * @param {number} changesetId
 * @param {boolean} includeWorkItems - include associated work items
 * @param {number}  maxChanges       - max file changes to return (0–100)
 */
export async function getChangeset(changesetId, includeWorkItems = true, maxChanges = 100) {
  const client = await getTfvcClient();

  const cs = await client.getChangeset(
    changesetId,
    PROJECT,
    maxChanges,
    true,           // includeDetails (check-in notes, policy)
    includeWorkItems
  );

  const changes = await client.getChangesetChanges(changesetId).catch(() => []);

  return {
    changesetId: cs.changesetId,
    author: cs.author?.displayName,
    authorUnique: cs.author?.uniqueName,
    createdDate: cs.createdDate,
    comment: cs.comment,
    checkInNote: cs.checkinNote,
    workItems: (cs.workItems ?? []).map(wi => ({
      id: wi.id,
      title: wi.title,
      url: wi.webUrl,
    })),
    changes: (changes ?? []).map(ch => ({
      changeType: ch.changeType,
      path: ch.item?.path,
      version: ch.item?.changesetVersion,
    })),
  };
}

/**
 * Get the version history of a specific TFVC file/folder.
 * @param {string} itemPath  - TFVC path to the file
 * @param {number} maxCount  - Max history entries
 */
export async function getItemVersions(itemPath, maxCount = 20) {
  const client = await getTfvcClient();

  const history = await client.getChangesets(
    PROJECT,
    maxCount,
    0,
    undefined,
    { itemPath }
  );

  if (!history || history.length === 0) return [];

  return history.map(cs => ({
    changesetId: cs.changesetId,
    author: cs.author?.displayName,
    createdDate: cs.createdDate,
    comment: cs.comment,
  }));
}

/**
 * Compare a file at the requested changeset (N) against version N-1.
 * Returns a diff in conflict-marker style:
 *
 *   <<<<<<<<< changeset 123
 *   line only in previous version
 *   =========
 *   line only in requested version
 *   >>>>>>>>> changeset 124
 *
 * Unchanged hunks are shown with 3 lines of context on each side.
 * Outputs "No changes" if both versions are identical.
 *
 * @param {string} filePath  - Full TFVC path, e.g. "$/ProjectName/src/App.cs"
 * @param {string|number} changesetVersion - The changeset you want to inspect (N)
 * @returns {Promise<string>} - Human-readable diff string
 */
export async function getFileChanges(filePath, changesetVersion) {
  const targetVersion = Number(changesetVersion);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error(`Invalid changeset version: ${changesetVersion}`);
  }
  const prevVersion = targetVersion - 1;

  // ── 1. Fetch both versions concurrently (N and N-1) ──────────────────────
  const [newContent, oldContent] = await Promise.all([
    getFileContent(filePath, String(targetVersion)),
    prevVersion > 0
      ? getFileContent(filePath, String(prevVersion)).catch(() => '')
      : Promise.resolve(''),  // changeset 1 has no predecessor
  ]);

  const prevLabel = prevVersion > 0 ? `changeset ${prevVersion}` : '(new file)';
  const currLabel = `changeset ${targetVersion}`;

  // ── 2. Short-circuit if identical ────────────────────────────────────────
  if (oldContent === newContent) {
    return `No changes between ${prevLabel} and ${currLabel} for:\n${filePath}`;
  }

  // ── 3. Line-by-line diff ──────────────────────────────────────────────────
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);

  const hunks = computeDiffHunks(oldLines, newLines);

  if (hunks.length === 0) {
    return `No changes between ${prevLabel} and ${currLabel} for:\n${filePath}`;
  }

  // ── 4. Format output ──────────────────────────────────────────────────────
  const output = [`Diff for: ${filePath}`, `${prevLabel}  →  ${currLabel}`, ''];

  // Width for line-number column (based on longer file)
  const w = String(Math.max(oldLines.length, newLines.length)).length;
  const pad = (n) => String(n).padStart(w, ' ');

  for (const hunk of hunks) {
    if (hunk.type === 'equal') {
      for (const { oldLn, newLn, line } of hunk.lines) {
        // elision sentinel has no line numbers
        if (oldLn == null) {
          output.push(`  ${''.padStart(w * 2 + 1, ' ')}  ${line}`);
        } else {
          output.push(`  ${pad(oldLn)},${pad(newLn)}  ${line}`);
        }
      }
    } else {
      output.push(`<<<<<<<<< ${prevLabel}`);
      for (const { oldLn, line } of hunk.removed) output.push(`- ${pad(oldLn)}        ${line}`);
      output.push('=========');
      for (const { newLn, line } of hunk.added) output.push(`+ ${''.padStart(w, ' ')}${pad(newLn)}  ${line}`);
      output.push(`>>>>>>>>> ${currLabel}`);
    }
    output.push('');
  }

  return output.join('\n');
}


// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Very lightweight LCS-based diff that returns an array of hunks.
 * Each hunk is either:
 *   { type: 'equal',   lines: [{ oldLn, newLn, line }] }
 *   { type: 'change',  removed: [{ oldLn, line }], added: [{ newLn, line }] }
 *
 * Equal hunks are collapsed to at most contextLines on each side; the elided
 * middle is represented by a sentinel entry with oldLn/newLn = null.
 */
function computeDiffHunks(oldLines, newLines, contextLines = 3) {
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = LCS length of oldLines[0..i-1] and newLines[0..j-1]
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Back-track to get edit script; record 1-based line numbers
  const ops = []; // { op, line, oldLn?, newLn? }
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ op: 'eq', line: oldLines[i - 1], oldLn: i, newLn: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ op: 'ins', line: newLines[j - 1], newLn: j });
      j--;
    } else {
      ops.push({ op: 'del', line: oldLines[i - 1], oldLn: i });
      i--;
    }
  }
  ops.reverse();

  // Group into raw hunks
  const rawHunks = [];
  let cur = null;
  for (const entry of ops) {
    const { op } = entry;
    if (op === 'eq') {
      if (cur && cur.type !== 'equal') { rawHunks.push(cur); cur = null; }
      if (!cur) cur = { type: 'equal', lines: [] };
      cur.lines.push(entry);
    } else {
      if (cur && cur.type === 'equal') { rawHunks.push(cur); cur = null; }
      if (!cur) cur = { type: 'change', removed: [], added: [] };
      if (op === 'del') cur.removed.push(entry);
      else cur.added.push(entry);
    }
  }
  if (cur) rawHunks.push(cur);

  // Apply context collapsing to equal hunks
  const result = [];
  for (let h = 0; h < rawHunks.length; h++) {
    const hunk = rawHunks[h];
    if (hunk.type !== 'equal') {
      result.push(hunk);
      continue;
    }
    const isFirst = h === 0;
    const isLast = h === rawHunks.length - 1;
    const lines = hunk.lines;

    if (isFirst && isLast) continue; // entire file unchanged

    if (isFirst) {
      const ctx = lines.slice(Math.max(0, lines.length - contextLines));
      if (ctx.length) result.push({ type: 'equal', lines: ctx });
    } else if (isLast) {
      const ctx = lines.slice(0, contextLines);
      if (ctx.length) result.push({ type: 'equal', lines: ctx });
    } else {
      const head = lines.slice(0, contextLines);
      const tail = lines.slice(Math.max(0, lines.length - contextLines));
      if (head.length) result.push({ type: 'equal', lines: head });
      const elided = lines.length - contextLines * 2;
      if (elided > 0) {
        // sentinel entry — no line numbers, indicates skipped lines
        result.push({ type: 'equal', lines: [{ oldLn: null, newLn: null, line: `... (${elided} unchanged lines) ...` }] });
      }
      if (tail.length) result.push({ type: 'equal', lines: tail });
    }
  }

  return result;
}



function streamToString(stream) {
  return new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== 'function') {
      // Already a Buffer or string (some SDK versions return Buffer directly)
      if (Buffer.isBuffer(stream)) return resolve(stream.toString('utf8'));
      return resolve(String(stream ?? ''));
    }
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', err => reject(err));
  });
}
