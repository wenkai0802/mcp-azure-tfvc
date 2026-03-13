# mcp-azure-tfvc

MCP (Model Context Protocol) server for **Azure DevOps Team Foundation Version Control** — read-only access.

Lets AI assistants (Claude Desktop, Gemini, etc.) browse TFVC source trees, read file contents, and inspect changesets via structured tools.

---

## Setup

### 1. Install dependencies

```powershell
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-org
AZURE_DEVOPS_PAT=your_personal_access_token
AZURE_DEVOPS_PROJECT=YourProjectName
```

> **PAT Scope required:** Code → **Read** only.

### 3. Run the server

```powershell
node src/index.js
```

---

## Registering with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tfvc": {
      "command": "npx",
      "args": [
        "mcp-azure-tfvc"
      ],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-org",
        "AZURE_DEVOPS_PAT": "your_pat",
        "AZURE_DEVOPS_PROJECT": "YourProject"
      }
    }
  }
}
```

## Testing with MCP Inspector

```powershell
npx @modelcontextprotocol/inspector node src/index.js
```

---

## Available Tools

| Tool | Description |
|---|---|
| `tfvc_list_items` | List files/folders at a TFVC path. Supports `None`, `OneLevel`, `Full` recursion. |
| `tfvc_get_file_content` | Read the content of a file at a given TFVC path. |
| `tfvc_list_changesets` | List recent changesets. Filter by path, author, date range, max count. |
| `tfvc_get_changeset` | Full details of a changeset — file changes, work items, check-in notes. |
| `tfvc_get_item_versions` | History of a specific file/folder path (which changesets touched it). |

---

## Example Tool Calls

**List root folders:**
```json
{ "tool": "tfvc_list_items", "arguments": { "scopePath": "$/", "recursionLevel": "OneLevel" } }
```

**Read a file:**
```json
{ "tool": "tfvc_get_file_content", "arguments": { "path": "$/ProjectName/filePath" } }
```

**Latest 10 changesets:**
```json
{ "tool": "tfvc_list_changesets", "arguments": { "maxCount": 10 } }
```

**Changeset details:**
```json
{ "tool": "tfvc_get_changeset", "arguments": { "changesetId": 12345 } }
```

**File history:**
```json
{ "tool": "tfvc_get_item_versions", "arguments": { "itemPath": "$/ProjectName/filePath" } }
```
