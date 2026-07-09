import crypto from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native AWS plugin — read-only cost & diagnostics over the AWS REST APIs (no external runner, no SDK).
 *
 * Curated, **read-only** toolset:
 *   • Cost Explorer  — spend grouped by service/etc ("cost by service type")
 *   • CloudWatch Logs Insights — run a Logs Insights query (start + poll) for diagnostics
 *   • CloudWatch Logs — list log groups (to discover what to query)
 *   • Resource Groups Tagging — list resources (ARNs + tags) across the account
 *
 * There are NO write tools by construction. Auth is an IAM access key (id + secret [+ optional session token],
 * `secret: true` → encrypted at rest); every request is signed with **AWS Signature V4** using node:crypto —
 * no aws-sdk dependency. Hosts are fixed per AWS service/region (never user-supplied) so there is no SSRF
 * surface; outbound requests refuse redirects, time out and cap the body. Grant the key read-only IAM
 * (e.g. `ce:GetCostAndUsage`, `logs:StartQuery`/`GetQueryResults`/`DescribeLogGroups`, `tag:GetResources`).
 */
export const AWS_ID = 'kravn-aws';

class AwsError extends Error {}

interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
}

const MAX_RESPONSE_BYTES = 10_000_000;
const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/; // e.g. us-east-1, eu-west-2

function clip(s: string, max = 6000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function readConfig(config: Record<string, unknown>): AwsConfig {
  const accessKeyId = String(config.accessKeyId ?? '').trim();
  const secretAccessKey = String(config.secretAccessKey ?? '').trim();
  const sessionToken = String(config.sessionToken ?? '').trim();
  const region = String(config.region ?? 'us-east-1').trim() || 'us-east-1';
  if (!accessKeyId || !secretAccessKey) {
    throw new AwsError('AWS is not configured. Set the Access Key ID and Secret Access Key of an IAM principal with read-only permissions.');
  }
  if (!REGION_RE.test(region)) throw new AwsError('Invalid AWS region (e.g. us-east-1).');
  return { accessKeyId, secretAccessKey, sessionToken, region };
}

// ─── AWS Signature V4 (node:crypto, no SDK) ─────────────────────────────────────────────────────────
function hmac(key: crypto.BinaryLike | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}
function amzDate(now: number): { date: string; stamp: string } {
  const iso = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260709T183000Z
  return { date: iso, stamp: iso.slice(0, 8) };
}

interface SignedCall {
  service: string;
  region: string;
  host: string;
  target: string; // X-Amz-Target (JSON protocol)
  body: string;
}

async function awsJson(cfg: AwsConfig, call: SignedCall): Promise<any> {
  const { date, stamp } = amzDate(Date.now());
  const payloadHash = sha256hex(call.body);
  const contentType = 'application/x-amz-json-1.1';
  // Canonical headers (sorted, lowercase). Include session token when present.
  const headers: Record<string, string> = {
    'content-type': contentType,
    host: call.host,
    'x-amz-date': date,
    'x-amz-target': call.target,
  };
  if (cfg.sessionToken) headers['x-amz-security-token'] = cfg.sessionToken;
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${stamp}/${call.region}/${call.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, stamp);
  const kRegion = hmac(kDate, call.region);
  const kService = hmac(kRegion, call.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let res: Response;
  try {
    res = await fetch(`https://${call.host}/`, {
      method: 'POST',
      headers: { ...headers, authorization },
      body: call.body,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new AwsError(`Could not reach AWS (${call.service}): ${(err as Error).message}`);
  }
  const bodyText = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new AwsError(`AWS returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const msg = data?.message || data?.Message || data?.__type || `HTTP ${res.status}`;
    throw new AwsError(clip(`AWS ${call.service} error: ${msg}`, 800));
  }
  return data;
}

// ─── Tools (all read-only) ──────────────────────────────────────────────────────────────────────────

const TOOLS: McpToolDef[] = [
  {
    name: 'aws_cost_by_service',
    description:
      'Total AWS cost grouped by a dimension (default **SERVICE** — "cost by service type"). Optional `start`/`end` ' +
      '(ISO dates, default this month-to-date; end is exclusive), `granularity` (MONTHLY | DAILY, default MONTHLY), ' +
      '`groupBy` (SERVICE | REGION | LINKED_ACCOUNT | USAGE_TYPE | INSTANCE_TYPE), `metric` (UnblendedCost default | BlendedCost | AmortizedCost).',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO start date (default first of this month).' },
        end: { type: 'string', description: 'ISO end date, exclusive (default tomorrow).' },
        granularity: { type: 'string', description: 'MONTHLY (default) or DAILY.' },
        groupBy: { type: 'string', description: 'SERVICE (default) | REGION | LINKED_ACCOUNT | USAGE_TYPE | INSTANCE_TYPE.' },
        metric: { type: 'string', description: 'UnblendedCost (default) | BlendedCost | AmortizedCost | NetUnblendedCost.' },
      },
    },
  },
  {
    name: 'aws_list_log_groups',
    description: 'List CloudWatch log groups (name + stored bytes) — use to discover what to query with aws_logs_query. Optional `prefix` filter.',
    inputSchema: {
      type: 'object',
      properties: { prefix: { type: 'string', description: 'Optional log-group name prefix.' } },
    },
  },
  {
    name: 'aws_logs_query',
    description:
      'Run a **CloudWatch Logs Insights** query for diagnostics. `logGroupNames` is a JSON array of log-group ' +
      'names (from aws_list_log_groups). `query` is a Logs Insights query, e.g. ' +
      "`fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 50`. " +
      'Optional `hours` (lookback window, default 1), `limit` (default 100).',
    inputSchema: {
      type: 'object',
      properties: {
        logGroupNames: { type: 'string', description: 'JSON array of CloudWatch log-group names.' },
        query: { type: 'string', description: 'A CloudWatch Logs Insights query string.' },
        hours: { type: 'number', description: 'Lookback window in hours (default 1).' },
        limit: { type: 'number', description: 'Max rows (default 100).' },
      },
      required: ['logGroupNames', 'query'],
    },
  },
  {
    name: 'aws_list_resources',
    description:
      'List resources across the account with their ARNs and tags (Resource Groups Tagging API). Optional ' +
      '`resourceTypes` (JSON array, e.g. ["ec2:instance","rds:db"]) and `tagKey`/`tagValues` to filter. Paginated (first page).',
    inputSchema: {
      type: 'object',
      properties: {
        resourceTypes: { type: 'string', description: 'Optional JSON array of resource-type filters, e.g. ["ec2:instance","s3"].' },
        tagKey: { type: 'string', description: 'Optional tag key to filter by.' },
        tagValues: { type: 'string', description: 'Optional JSON array of tag values (with tagKey).' },
      },
    },
  },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseJsonArray(v: unknown, what: string): string[] {
  let arr: unknown;
  try {
    arr = typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    throw new AwsError(`${what} must be a JSON array.`);
  }
  if (!Array.isArray(arr) || !arr.length) throw new AwsError(`${what} must be a non-empty JSON array.`);
  return arr.map((x) => String(x));
}

const COST_GROUPS = ['SERVICE', 'REGION', 'LINKED_ACCOUNT', 'USAGE_TYPE', 'INSTANCE_TYPE', 'PURCHASE_TYPE'];
const COST_METRICS = ['UnblendedCost', 'BlendedCost', 'AmortizedCost', 'NetUnblendedCost', 'NetAmortizedCost'];

async function costByService(cfg: AwsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const now = new Date();
  const start = String(args.start ?? isoDate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const end = String(args.end ?? isoDate(new Date(now.getTime() + 86_400_000)));
  const granularity = String(args.granularity ?? 'MONTHLY').toUpperCase();
  if (!['MONTHLY', 'DAILY'].includes(granularity)) throw new AwsError('granularity must be MONTHLY or DAILY.');
  const groupBy = String(args.groupBy ?? 'SERVICE').toUpperCase();
  if (!COST_GROUPS.includes(groupBy)) throw new AwsError(`groupBy must be one of: ${COST_GROUPS.join(', ')}.`);
  const metric = String(args.metric ?? 'UnblendedCost');
  if (!COST_METRICS.includes(metric)) throw new AwsError(`metric must be one of: ${COST_METRICS.join(', ')}.`);
  // Cost Explorer is a global service pinned to us-east-1.
  const data = await awsJson(cfg, {
    service: 'ce',
    region: 'us-east-1',
    host: 'ce.us-east-1.amazonaws.com',
    target: 'AWSInsightsIndexService.GetCostAndUsage',
    body: JSON.stringify({
      TimePeriod: { Start: start, End: end },
      Granularity: granularity,
      Metrics: [metric],
      GroupBy: [{ Type: 'DIMENSION', Key: groupBy }],
    }),
  });
  const out: string[] = [];
  for (const period of (data.ResultsByTime ?? []) as any[]) {
    out.push(`# ${period.TimePeriod?.Start} → ${period.TimePeriod?.End}`);
    const groups = (period.Groups ?? []) as any[];
    const rows = groups
      .map((g) => ({ key: (g.Keys ?? []).join('/'), amount: Number(g.Metrics?.[metric]?.Amount ?? 0), unit: g.Metrics?.[metric]?.Unit }))
      .sort((a, b) => b.amount - a.amount);
    for (const r of rows) out.push(`  ${r.amount.toFixed(2)} ${r.unit ?? ''}  —  ${r.key}`);
    if (!groups.length) out.push(`  (total ${period.Total?.[metric]?.Amount ?? '0'} ${period.Total?.[metric]?.Unit ?? ''})`);
  }
  return text(clip(out.join('\n')) || 'No cost data for the period.');
}

async function listLogGroups(cfg: AwsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = { limit: 50 };
  if (args.prefix) body.logGroupNamePrefix = String(args.prefix);
  const data = await awsJson(cfg, {
    service: 'logs',
    region: cfg.region,
    host: `logs.${cfg.region}.amazonaws.com`,
    target: 'Logs_20140328.DescribeLogGroups',
    body: JSON.stringify(body),
  });
  const groups = ((data.logGroups ?? []) as any[]).map((g) => `• ${g.logGroupName}  (${g.storedBytes ?? 0} bytes)`);
  return text(groups.length ? clip(groups.join('\n')) : 'No log groups found.');
}

async function logsQuery(cfg: AwsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const logGroupNames = parseJsonArray(args.logGroupNames, 'logGroupNames');
  const query = String(args.query ?? '').trim();
  if (!query) return text('Error: query (a Logs Insights query) is required.', true);
  const hours = Math.min(168, Math.max(1, Number(args.hours) || 1));
  const limit = Math.min(1000, Math.max(1, Number(args.limit) || 100));
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - hours * 3600;
  const started = await awsJson(cfg, {
    service: 'logs',
    region: cfg.region,
    host: `logs.${cfg.region}.amazonaws.com`,
    target: 'Logs_20140328.StartQuery',
    body: JSON.stringify({ logGroupNames, queryString: query, startTime, endTime, limit }),
  });
  const queryId = started.queryId;
  if (!queryId) throw new AwsError('CloudWatch did not return a queryId.');
  // Poll for results (bounded).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await awsJson(cfg, {
      service: 'logs',
      region: cfg.region,
      host: `logs.${cfg.region}.amazonaws.com`,
      target: 'Logs_20140328.GetQueryResults',
      body: JSON.stringify({ queryId }),
    });
    if (r.status === 'Complete' || r.status === 'Failed' || r.status === 'Cancelled' || r.status === 'Timeout') {
      if (r.status !== 'Complete') return text(`Query ${r.status}.`, r.status !== 'Complete');
      const rows = ((r.results ?? []) as any[][]).map((row) =>
        Object.fromEntries(row.filter((f: any) => f.field !== '@ptr').map((f: any) => [f.field, f.value])),
      );
      return text(`${rows.length} row(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
    }
  }
  return text('Query still running after 30s — narrow the time window or query and try again.', true);
}

async function listResources(cfg: AwsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = { ResourcesPerPage: 100 };
  if (args.resourceTypes) body.ResourceTypeFilters = parseJsonArray(args.resourceTypes, 'resourceTypes');
  if (args.tagKey) {
    const filter: Record<string, unknown> = { Key: String(args.tagKey) };
    if (args.tagValues) filter.Values = parseJsonArray(args.tagValues, 'tagValues');
    body.TagFilters = [filter];
  }
  const data = await awsJson(cfg, {
    service: 'tagging',
    region: cfg.region,
    host: `tagging.${cfg.region}.amazonaws.com`,
    target: 'ResourceGroupsTaggingAPI_20170126.GetResources',
    body: JSON.stringify(body),
  });
  const items = ((data.ResourceTagMappingList ?? []) as any[]).map((r) => ({
    arn: r.ResourceARN,
    tags: Object.fromEntries((r.Tags ?? []).map((t: any) => [t.Key, t.Value])),
  }));
  const more = data.PaginationToken ? '\n\n(more resources available — refine with resourceTypes/tags)' : '';
  return text(`${items.length} resource(s):\n\n${clip(JSON.stringify(items, null, 2))}${more}`);
}

const SETUP = [
  'AWS cost & diagnostics use an **IAM principal** (access key) with **read-only** permissions. Once:',
  '',
  '1. In **IAM → Users** (or a role) create/choose a principal for Kravn and generate an **access key** (Access Key ID + Secret Access Key). For temporary credentials you may also pass a **session token**.',
  '2. Attach a **read-only** policy. The simplest is the AWS-managed **`ReadOnlyAccess`**, or a scoped policy with just:',
  '   `ce:GetCostAndUsage`, `logs:DescribeLogGroups`, `logs:StartQuery`, `logs:GetQueryResults`, `tag:GetResources`.',
  '3. **Enable Cost Explorer** once in the Billing console (Cost Explorer must be turned on before its API works).',
  '',
  'Then set: **Access Key ID**, **Secret Access Key**, optional **Session Token**, and **Region** (default us-east-1; Cost Explorer is always queried in us-east-1 regardless). Every tool here is read-only.',
].join('\n');

export function awsPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: AWS_ID,
      name: 'AWS',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Read-only AWS cost & diagnostics over the AWS REST APIs — Cost Explorer (spend by service), CloudWatch ' +
        'Logs Insights (log queries) + log-group discovery, and Resource Groups Tagging (resource inventory). ' +
        'IAM access-key auth, requests signed with AWS Signature V4 (no aws-sdk). No write tools.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          accessKeyId: { type: 'string', title: 'Access Key ID', description: 'IAM access key ID.' },
          secretAccessKey: { type: 'string', title: 'Secret Access Key', description: 'IAM secret access key.', secret: true },
          sessionToken: { type: 'string', title: 'Session Token', description: 'Optional session token (for temporary/STS credentials).', secret: true },
          region: { type: 'string', title: 'Region', description: 'Default AWS region, e.g. us-east-1.' },
        },
        required: ['accessKeyId', 'secretAccessKey'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          switch (name) {
            case 'aws_cost_by_service':
              return await costByService(cfg, args);
            case 'aws_list_log_groups':
              return await listLogGroups(cfg, args);
            case 'aws_logs_query':
              return await logsQuery(cfg, args);
            case 'aws_list_resources':
              return await listResources(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'AWS request failed.', true);
        }
      },
    },
  };
}
