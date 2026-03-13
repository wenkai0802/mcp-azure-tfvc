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

// ── helpers ──────────────────────────────────────────────────────────────────

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
