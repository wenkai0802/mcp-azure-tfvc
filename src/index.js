#!/usr/bin/env node

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  listItems,
  getFileContent,
  listChangesets,
  getChangeset,
  getItemVersions,
} from './tfvc.js';

// ── Server setup ──────────────────────────────────────────────────────────────
if (!process.env.AZURE_DEVOPS_PAT || !process.env.AZURE_DEVOPS_ORG) {
  console.error("Error: AZURE_DEVOPS_PAT and AZURE_DEVOPS_ORG environment variables are required.");
  process.exit(1);
}
const server = new Server(
  { name: 'mcp-tfvc', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'tfvc_list_items',
    description:
      'List files and folders at a given TFVC path. ' +
      'Use recursionLevel "None" for a single item, "OneLevel" for immediate children, "Full" for the full subtree.',
    inputSchema: {
      type: 'object',
      properties: {
        scopePath: {
          type: 'string',
          description: 'TFVC version-control path to list (e.g. "$/" or "$/ProjectName/src"). Defaults to "$/".',
        },
        recursionLevel: {
          type: 'string',
          enum: ['None', 'OneLevel', 'Full'],
          description: 'Depth of recursion. Default is "OneLevel".',
        },
        version: {
          type: 'string',
          description: 'Optional changeset number to retrieve items at that version (e.g. "12345").',
        },
      },
    },
  },
  {
    name: 'tfvc_get_file_content',
    description: 'Retrieve the text content of a specific TFVC file.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Full TFVC path to the file (e.g. "$/ProjectName/filePath").',
        },
        version: {
          type: 'string',
          description: 'Optional changeset number to retrieve the file at that version.',
        },
      },
    },
  },
  {
    name: 'tfvc_list_changesets',
    description:
      'List recent TFVC changesets with optional filters. Returns changeset ID, author, date, and comment.',
    inputSchema: {
      type: 'object',
      properties: {
        itemPath: {
          type: 'string',
          description: 'Filter by TFVC path — only changesets that touched this path are returned.',
        },
        author: {
          type: 'string',
          description: 'Filter by author alias or display name.',
        },
        fromDate: {
          type: 'string',
          description: 'ISO 8601 start date filter (e.g. "2024-01-01").',
        },
        toDate: {
          type: 'string',
          description: 'ISO 8601 end date filter (e.g. "2024-12-31").',
        },
        maxCount: {
          type: 'number',
          description: 'Maximum number of changesets to return (default 20, max 100).',
        },
        skip: {
          type: 'number',
          description: 'Number of changesets to skip for pagination (default 0).',
        },
      },
    },
  },
  {
    name: 'tfvc_get_changeset',
    description:
      'Get full details of a specific TFVC changeset: check-in comment, author, file changes, and associated work items.',
    inputSchema: {
      type: 'object',
      required: ['changesetId'],
      properties: {
        changesetId: {
          type: 'number',
          description: 'The numeric ID of the changeset.',
        },
        includeWorkItems: {
          type: 'boolean',
          description: 'Whether to include associated work items (default true).',
        },
        maxChanges: {
          type: 'number',
          description: 'Max number of file-change entries to return (0–100, default 100).',
        },
      },
    },
  },
  {
    name: 'tfvc_get_item_versions',
    description:
      'Get the version history (list of changesets) for a specific TFVC file or folder path.',
    inputSchema: {
      type: 'object',
      required: ['itemPath'],
      properties: {
        itemPath: {
          type: 'string',
          description: 'Full TFVC path to the file or folder.',
        },
        maxCount: {
          type: 'number',
          description: 'Maximum number of history entries to return (default 20).',
        },
      },
    },
  },
];

// ── List tools handler ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Call tool handler ─────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;

    switch (name) {
      case 'tfvc_list_items':
        result = await listItems(
          args.scopePath ?? '$/',
          args.recursionLevel ?? 'OneLevel',
          args.version ?? null
        );
        break;

      case 'tfvc_get_file_content':
        result = await getFileContent(args.path, args.version ?? null);
        break;

      case 'tfvc_list_changesets':
        result = await listChangesets({
          itemPath: args.itemPath,
          author: args.author,
          fromDate: args.fromDate,
          toDate: args.toDate,
          maxCount: args.maxCount ?? 20,
          skip: args.skip ?? 0,
        });
        break;

      case 'tfvc_get_changeset':
        result = await getChangeset(
          args.changesetId,
          args.includeWorkItems ?? true,
          args.maxChanges ?? 100
        );
        break;

      case 'tfvc_get_item_versions':
        result = await getItemVersions(args.itemPath, args.maxCount ?? 20);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('mcp-tfvc server running on stdio');
