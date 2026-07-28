import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Tempo plugin — manage the team's capacity plan (Tempo Planner) over MCP via the Tempo Cloud
 * REST API v4 (https://api.tempo.io/4). In-process TypeScript, like Kravn's other native plugins.
 *
 * Auth is a single Bearer token (an "API integration" token), marked `secret: true` so PluginManager
 * stores it encrypted and masks it write-only. Create it in Tempo:
 *
 *     Tempo → Settings → Data Access → API integration → New token
 *
 * Covers: plans (read / allocations / create / update / delete), user & team capacity (user-schedule),
 * teams & members, accounts, logged time (worklogs) and workload schemes.
 *
 * v4 gotchas surfaced in the tool docs: a plan's `planItemId` is the NUMERIC Jira issue/project id (not
 * the ABC-123 key), `assigneeId` is the Atlassian accountId, and v4 responses no longer carry display
 * names (resolve them via the Jira plugin if needed).
 */
export const TEMPO_ID = 'kravn-tempo';

const TEMPO_BASE = 'https://api.tempo.io/4';
const MAX_RESPONSE_BYTES = 10_000_000;
const PAGE_LIMIT = 1000; // Tempo allows up to 5000/call; 1000 is plenty for a capacity view.
const TEAM_CAPACITY_MEMBER_CAP = 40; // fan-out ceiling for the composite team-capacity tool.

class TempoError extends Error {}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function clip(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function readToken(config: Record<string, unknown>): string {
  const apiToken = String(config.apiToken ?? '').trim();
  if (!apiToken) {
    throw new TempoError(
      'Tempo is not configured. Add an API token — create one in Tempo → Settings → Data Access → ' +
        'API integration → New token, then paste it here.',
    );
  }
  return apiToken;
}
const hours = (seconds: number): string => `${(Number(seconds || 0) / 3600).toFixed(1)}h`;
function reqDate(v: unknown, name: string): string {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new TempoError(`${name} must be a date as YYYY-MM-DD.`);
  return s;
}

async function tempoFetch(token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, jsonBody?: unknown): Promise<any> {
  const res = await fetch(`${TEMPO_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    redirect: 'error', // never follow a redirect with the token attached (anti-SSRF / anti-exfil)
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new TempoError('Tempo rejected the token (401/403). Check the API integration token and its scopes (Tempo → Settings → Data Access).');
  }
  if (res.status === 204) return {};
  if (res.status === 404) throw new TempoError('Not found (check the id / accountId / teamId).');
  if (Number(res.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
    throw new TempoError('Tempo response is too large to process.');
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any = {};
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const msg =
      (Array.isArray(data?.errors) && data.errors.map((e: any) => e?.message).filter(Boolean).join('; ')) ||
      data?.message ||
      `Tempo HTTP ${res.status}`;
    throw new TempoError(clip(String(msg)));
  }
  return data;
}

const arr = (data: any): any[] => (Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : []);

// ─── Formatting ──────────────────────────────────────────────────────────────────────────────────

function fmtPlan(p: any): string {
  const item = p?.planItem ?? {};
  const who = p?.assignee?.id ?? '—';
  const perDay = p?.plannedSecondsPerDay ?? p?.secondsPerDay ?? 0;
  const range = `${p?.startDate ?? '?'} → ${p?.endDate ?? '?'}`;
  const desc = p?.description ? `  “${clip(String(p.description), 80)}”` : '';
  return `• plan ${p?.id ?? '?'}  ${item.type ?? '?'} ${item.id ?? '?'}  assignee ${who}  ${range}  ${hours(perDay)}/day${desc}`;
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

const PLAN_ITEM_NOTE =
  'planItemType is ISSUE or PROJECT. planItemId is the NUMERIC Jira issue/project id (NOT the "ABC-123" key) — ' +
  'get it from the Jira plugin (jira_get_issue returns the numeric id) or the issue URL. assigneeId is the ' +
  'Atlassian accountId. Times are hours/day (converted to Tempo seconds).';

const TOOLS: McpToolDef[] = [
  {
    name: 'tempo_get_plans',
    description:
      'List capacity plans (Tempo Planner allocations) in a date range — who is planned on what, for how many ' +
      'hours/day. Pass `assigneeId` (an Atlassian accountId) to see one person\'s plans, or omit it for everyone. ' +
      'Each row: plan id, work item (ISSUE/PROJECT + id), assignee, date range and hours/day.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Range start, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Range end, YYYY-MM-DD.' },
        assigneeId: { type: 'string', description: 'Optional Atlassian accountId to filter to one person.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'tempo_get_plan',
    description: 'Get one capacity plan by its id (full detail: work item, assignee, dates, hours/day, description).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The plan id.' } }, required: ['id'] },
  },
  {
    name: 'tempo_get_allocations',
    description:
      'Show the plans ALLOCATED to a specific work item (a Jira issue or project) in a date range — i.e. who is ' +
      'planned on it and for how long. ' + PLAN_ITEM_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        planItemId: { type: 'string', description: 'Numeric Jira issue or project id.' },
        planItemType: { type: 'string', enum: ['ISSUE', 'PROJECT'], description: 'ISSUE or PROJECT.' },
        from: { type: 'string', description: 'Range start, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Range end, YYYY-MM-DD.' },
      },
      required: ['planItemId', 'planItemType', 'from', 'to'],
    },
  },
  {
    name: 'tempo_create_plan',
    description: 'Create a capacity plan: allocate a person to a Jira issue/project for a date range at N hours/day. ' + PLAN_ITEM_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        assigneeId: { type: 'string', description: 'Atlassian accountId of the person to plan.' },
        assigneeType: { type: 'string', enum: ['USER', 'GENERIC'], description: 'USER (default) or GENERIC resource.' },
        planItemId: { type: 'string', description: 'Numeric Jira issue or project id.' },
        planItemType: { type: 'string', enum: ['ISSUE', 'PROJECT'], description: 'ISSUE or PROJECT.' },
        startDate: { type: 'string', description: 'Plan start, YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'Plan end, YYYY-MM-DD.' },
        hoursPerDay: { type: 'number', description: 'Planned hours per working day (e.g. 4 or 7.5).' },
        description: { type: 'string', description: 'Optional note on the plan.' },
        includeNonWorkingDays: { type: 'boolean', description: 'Also plan on weekends/holidays (default false).' },
      },
      required: ['assigneeId', 'planItemId', 'planItemType', 'startDate', 'endDate', 'hoursPerDay'],
    },
  },
  {
    name: 'tempo_update_plan',
    description:
      'Update an existing capacity plan by id. Only pass the fields you want to change — the rest are kept from the ' +
      'current plan (Tempo requires the full object, which this fills in for you). ' + PLAN_ITEM_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The plan id to update.' },
        assigneeId: { type: 'string', description: 'New Atlassian accountId (optional).' },
        assigneeType: { type: 'string', enum: ['USER', 'GENERIC'], description: 'USER or GENERIC (optional).' },
        planItemId: { type: 'string', description: 'New numeric Jira issue/project id (optional).' },
        planItemType: { type: 'string', enum: ['ISSUE', 'PROJECT'], description: 'ISSUE or PROJECT (optional).' },
        startDate: { type: 'string', description: 'New start, YYYY-MM-DD (optional).' },
        endDate: { type: 'string', description: 'New end, YYYY-MM-DD (optional).' },
        hoursPerDay: { type: 'number', description: 'New planned hours per working day (optional).' },
        description: { type: 'string', description: 'New note (optional).' },
        includeNonWorkingDays: { type: 'boolean', description: 'Plan on weekends/holidays (optional).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tempo_delete_plan',
    description: 'Delete a capacity plan by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The plan id to delete.' } }, required: ['id'] },
  },
  {
    name: 'tempo_get_user_capacity',
    description:
      'A person\'s WORK CAPACITY (required working time) per day over a date range, from their Tempo user schedule / ' +
      'workload scheme + holidays. Returns the total required hours and a per-day breakdown. Compare against ' +
      'tempo_get_plans to see how loaded they are.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Atlassian accountId of the person.' },
        from: { type: 'string', description: 'Range start, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Range end, YYYY-MM-DD.' },
      },
      required: ['accountId', 'from', 'to'],
    },
  },
  {
    name: 'tempo_get_team_capacity',
    description:
      'Aggregate WORK CAPACITY for a whole team over a date range: fetches the team\'s members and sums each ' +
      'member\'s required working time (user schedule). Returns the team total plus per-member hours. Use tempo_list_teams ' +
      'to find the teamId.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'The Tempo team id.' },
        from: { type: 'string', description: 'Range start, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Range end, YYYY-MM-DD.' },
      },
      required: ['teamId', 'from', 'to'],
    },
  },
  {
    name: 'tempo_list_teams',
    description: 'List Tempo teams (id + name). Optionally filter by name.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional case-insensitive filter over team name.' } } },
  },
  {
    name: 'tempo_get_team_members',
    description: 'List the members of a Tempo team (their Atlassian accountIds), for use with the capacity and plan tools.',
    inputSchema: { type: 'object', properties: { teamId: { type: 'string', description: 'The Tempo team id.' } }, required: ['teamId'] },
  },
  {
    name: 'tempo_list_accounts',
    description: 'List Tempo accounts (id, key, name, status) — the cost/billing accounts work can be booked against. Optionally filter.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional case-insensitive filter over account key/name.' } } },
  },
  {
    name: 'tempo_get_worklogs',
    description:
      'LOGGED (actual) time in a date range — Tempo worklogs. Pass `accountId` for one person, or omit for everyone the ' +
      'token can see. Use this against tempo_get_plans / capacity to compare planned vs. actual.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Range start, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Range end, YYYY-MM-DD.' },
        accountId: { type: 'string', description: 'Optional Atlassian accountId to filter to one person.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'tempo_list_workload_schemes',
    description: 'List workload schemes — the working-hours-per-weekday definitions that underlie capacity. Shows which is the default.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Tool implementations ──────────────────────────────────────────────────────────────────────

async function getPlans(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const from = reqDate(args.from, 'from');
  const to = reqDate(args.to, 'to');
  const assigneeId = String(args.assigneeId ?? '').trim();
  let plans: any[];
  if (assigneeId) {
    const data = await tempoFetch(token, 'GET', `/plans/user/${encodeURIComponent(assigneeId)}?from=${from}&to=${to}&offset=0&limit=${PAGE_LIMIT}`);
    plans = arr(data);
  } else {
    const data = await tempoFetch(token, 'POST', '/plans/search', { from, to, offset: 0, limit: PAGE_LIMIT });
    plans = arr(data);
  }
  if (!plans.length) return text(`No plans between ${from} and ${to}${assigneeId ? ` for ${assigneeId}` : ''}.`);
  return text(`${plans.length} plan(s) ${from} → ${to}:\n\n${plans.map(fmtPlan).join('\n')}`);
}

async function getPlan(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id ?? '').trim();
  if (!id) return text('Error: id is required.', true);
  const p = await tempoFetch(token, 'GET', `/plans/${encodeURIComponent(id)}`);
  const item = p?.planItem ?? {};
  const out = [
    `# Plan ${p?.id ?? id}`,
    `Work item: ${item.type ?? '?'} ${item.id ?? '?'}`,
    `Assignee:  ${p?.assignee?.id ?? '—'} (${p?.assignee?.type ?? '—'})`,
    `Dates:     ${p?.startDate ?? '?'} → ${p?.endDate ?? '?'}`,
    `Per day:   ${hours(p?.plannedSecondsPerDay ?? p?.secondsPerDay ?? 0)}`,
    ...(p?.includeNonWorkingDays ? ['Includes non-working days: yes'] : []),
    ...(p?.description ? ['', `Description: ${p.description}`] : []),
  ];
  return text(out.join('\n'));
}

async function getAllocations(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const planItemId = String(args.planItemId ?? '').trim();
  const planItemType = String(args.planItemType ?? '').trim().toUpperCase();
  const from = reqDate(args.from, 'from');
  const to = reqDate(args.to, 'to');
  if (!planItemId || !['ISSUE', 'PROJECT'].includes(planItemType)) {
    return text('Error: planItemId and planItemType (ISSUE|PROJECT) are required.', true);
  }
  const data = await tempoFetch(token, 'POST', '/plans/search', {
    from,
    to,
    offset: 0,
    limit: PAGE_LIMIT,
    planItemIds: [planItemId],
    planItemTypes: [planItemType],
  });
  const plans = arr(data);
  if (!plans.length) return text(`No one is allocated to ${planItemType} ${planItemId} between ${from} and ${to}.`);
  return text(`${plans.length} allocation(s) on ${planItemType} ${planItemId} (${from} → ${to}):\n\n${plans.map(fmtPlan).join('\n')}`);
}

function planBody(args: Record<string, unknown>, base: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (args.assigneeId !== undefined) out.assigneeId = String(args.assigneeId).trim();
  if (args.assigneeType !== undefined) out.assigneeType = String(args.assigneeType).trim().toUpperCase();
  if (args.planItemId !== undefined) out.planItemId = String(args.planItemId).trim();
  if (args.planItemType !== undefined) out.planItemType = String(args.planItemType).trim().toUpperCase();
  if (args.startDate !== undefined) out.startDate = reqDate(args.startDate, 'startDate');
  if (args.endDate !== undefined) out.endDate = reqDate(args.endDate, 'endDate');
  if (args.hoursPerDay !== undefined) out.plannedSecondsPerDay = Math.round(Number(args.hoursPerDay) * 3600);
  if (args.description !== undefined) out.description = String(args.description);
  if (args.includeNonWorkingDays !== undefined) out.includeNonWorkingDays = !!args.includeNonWorkingDays;
  return out;
}

async function createPlan(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const body = planBody(args, { assigneeType: 'USER' });
  for (const req of ['assigneeId', 'planItemId', 'planItemType', 'startDate', 'endDate', 'plannedSecondsPerDay']) {
    if (body[req] === undefined || body[req] === '') return text(`Error: ${req === 'plannedSecondsPerDay' ? 'hoursPerDay' : req} is required.`, true);
  }
  const created = await tempoFetch(token, 'POST', '/plans', body);
  return text(`Created plan ${created?.id ?? '(unknown)'}: ${body.planItemType} ${body.planItemId} → ${body.assigneeId}, ${body.startDate}–${body.endDate}, ${hours(Number(body.plannedSecondsPerDay))}/day.`);
}

async function updatePlan(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id ?? '').trim();
  if (!id) return text('Error: id is required.', true);
  // Tempo's PUT requires the whole object — fetch the current plan and merge the caller's changes over it.
  const cur = await tempoFetch(token, 'GET', `/plans/${encodeURIComponent(id)}`);
  const base: Record<string, unknown> = {
    assigneeId: cur?.assignee?.id,
    assigneeType: cur?.assignee?.type ?? 'USER',
    planItemId: cur?.planItem?.id != null ? String(cur.planItem.id) : undefined,
    planItemType: cur?.planItem?.type,
    startDate: cur?.startDate,
    endDate: cur?.endDate,
    plannedSecondsPerDay: cur?.plannedSecondsPerDay ?? cur?.secondsPerDay,
    ...(cur?.description ? { description: cur.description } : {}),
    ...(cur?.includeNonWorkingDays != null ? { includeNonWorkingDays: cur.includeNonWorkingDays } : {}),
  };
  const body = planBody(args, base);
  const updated = await tempoFetch(token, 'PUT', `/plans/${encodeURIComponent(id)}`, body);
  return text(`Updated plan ${updated?.id ?? id}: ${body.planItemType} ${body.planItemId} → ${body.assigneeId}, ${body.startDate}–${body.endDate}, ${hours(Number(body.plannedSecondsPerDay))}/day.`);
}

async function deletePlan(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id ?? '').trim();
  if (!id) return text('Error: id is required.', true);
  await tempoFetch(token, 'DELETE', `/plans/${encodeURIComponent(id)}`);
  return text(`Deleted plan ${id}.`);
}

/** Sum a user-schedule response's required seconds; returns total + a compact per-day list. */
function summarizeSchedule(data: any): { totalSeconds: number; days: Array<{ date: string; seconds: number; type: string }> } {
  const days = arr(data).map((d: any) => ({
    date: String(d?.date ?? '?'),
    seconds: Number(d?.requiredSeconds ?? 0),
    type: String(d?.type ?? ''),
  }));
  return { totalSeconds: days.reduce((s, d) => s + d.seconds, 0), days };
}

async function getUserCapacity(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const accountId = String(args.accountId ?? '').trim();
  const from = reqDate(args.from, 'from');
  const to = reqDate(args.to, 'to');
  if (!accountId) return text('Error: accountId is required.', true);
  const data = await tempoFetch(token, 'GET', `/user-schedule/${encodeURIComponent(accountId)}?from=${from}&to=${to}`);
  const { totalSeconds, days } = summarizeSchedule(data);
  const working = days.filter((d) => d.seconds > 0);
  const lines = working.map((d) => `  ${d.date}: ${hours(d.seconds)}${d.type ? `  (${d.type.toLowerCase()})` : ''}`);
  return text(
    `Capacity for ${accountId}, ${from} → ${to}:\n` +
      `Required total: ${hours(totalSeconds)} across ${working.length} working day(s).\n\n${lines.join('\n') || '  (no working days in range)'}`,
  );
}

async function teamMemberIds(token: string, teamId: string): Promise<string[]> {
  const data = await tempoFetch(token, 'GET', `/teams/${encodeURIComponent(teamId)}/members`);
  return arr(data)
    .map((m: any) => m?.member?.accountId ?? m?.accountId ?? m?.member?.id ?? m?.id)
    .filter((x: any) => typeof x === 'string' && x);
}

async function getTeamCapacity(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const teamId = String(args.teamId ?? '').trim();
  const from = reqDate(args.from, 'from');
  const to = reqDate(args.to, 'to');
  if (!teamId) return text('Error: teamId is required.', true);
  const members = await teamMemberIds(token, teamId);
  if (!members.length) return text(`Team ${teamId} has no members (or none visible to this token).`);
  const capped = members.slice(0, TEAM_CAPACITY_MEMBER_CAP);
  const perMember = await Promise.all(
    capped.map(async (accountId) => {
      try {
        const data = await tempoFetch(token, 'GET', `/user-schedule/${encodeURIComponent(accountId)}?from=${from}&to=${to}`);
        return { accountId, seconds: summarizeSchedule(data).totalSeconds };
      } catch {
        return { accountId, seconds: 0 }; // a single member's schedule failing shouldn't sink the whole team view
      }
    }),
  );
  const total = perMember.reduce((s, m) => s + m.seconds, 0);
  const lines = perMember.map((m) => `  ${m.accountId}: ${hours(m.seconds)}`);
  const note = members.length > capped.length ? `\n\n(showing the first ${capped.length} of ${members.length} members)` : '';
  return text(
    `Team ${teamId} capacity, ${from} → ${to}:\n` +
      `Team required total: ${hours(total)} across ${capped.length} member(s).\n\n${lines.join('\n')}${note}`,
  );
}

async function listTeams(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim().toLowerCase();
  let teams = arr(await tempoFetch(token, 'GET', '/teams'));
  if (q) teams = teams.filter((t: any) => `${t?.name ?? ''}`.toLowerCase().includes(q));
  if (!teams.length) return text('No teams found.');
  return text(`Teams:\n\n${teams.map((t: any) => `• ${t?.id ?? '?'}  —  ${t?.name ?? '(unnamed)'}`).join('\n')}`);
}

async function getTeamMembers(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const teamId = String(args.teamId ?? '').trim();
  if (!teamId) return text('Error: teamId is required.', true);
  const members = await teamMemberIds(token, teamId);
  if (!members.length) return text(`Team ${teamId} has no members (or none visible to this token).`);
  return text(`Team ${teamId} members (${members.length}):\n\n${members.map((a) => `• ${a}`).join('\n')}`);
}

async function listAccounts(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim().toLowerCase();
  let accounts = arr(await tempoFetch(token, 'GET', '/accounts'));
  if (q) accounts = accounts.filter((a: any) => `${a?.key ?? ''} ${a?.name ?? ''}`.toLowerCase().includes(q));
  if (!accounts.length) return text('No accounts found.');
  const lines = accounts.map((a: any) => `• ${a?.key ?? a?.id ?? '?'}  —  ${a?.name ?? '(unnamed)'}${a?.status ? `  [${a.status}]` : ''}`);
  return text(`Accounts:\n\n${lines.join('\n')}`);
}

async function getWorklogs(token: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const from = reqDate(args.from, 'from');
  const to = reqDate(args.to, 'to');
  const accountId = String(args.accountId ?? '').trim();
  const path = accountId
    ? `/worklogs/user/${encodeURIComponent(accountId)}?from=${from}&to=${to}&offset=0&limit=${PAGE_LIMIT}`
    : `/worklogs?from=${from}&to=${to}&offset=0&limit=${PAGE_LIMIT}`;
  const logs = arr(await tempoFetch(token, 'GET', path));
  if (!logs.length) return text(`No worklogs between ${from} and ${to}${accountId ? ` for ${accountId}` : ''}.`);
  const total = logs.reduce((s: number, w: any) => s + Number(w?.timeSpentSeconds ?? 0), 0);
  const lines = logs
    .slice(0, 100)
    .map((w: any) => `• ${w?.startDate ?? '?'}  ${hours(w?.timeSpentSeconds ?? 0)}  issue ${w?.issue?.id ?? '—'}  by ${w?.author?.accountId ?? '—'}${w?.description ? `  “${clip(String(w.description), 60)}”` : ''}`);
  const more = logs.length > 100 ? `\n\n(showing 100 of ${logs.length})` : '';
  return text(`${logs.length} worklog(s) ${from} → ${to} — logged total ${hours(total)}:\n\n${lines.join('\n')}${more}`);
}

async function listWorkloadSchemes(token: string): Promise<McpToolResult> {
  const schemes = arr(await tempoFetch(token, 'GET', '/workload-schemes'));
  if (!schemes.length) return text('No workload schemes found.');
  const lines = schemes.map((s: any) => `• ${s?.id ?? '?'}  —  ${s?.name ?? '(unnamed)'}${s?.defaultScheme ? '  [default]' : ''}`);
  return text(`Workload schemes:\n\n${lines.join('\n')}`);
}

export function tempoPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: TEMPO_ID,
      name: 'Tempo',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Manage the team capacity plan in Tempo (Tempo Planner) over MCP via the Tempo Cloud REST API v4. ' +
        'Read plans and allocations, create / update / delete plans, and compare against user & team capacity ' +
        '(work schedules), logged time (worklogs), teams, accounts and workload schemes. Requires a Tempo API ' +
        'integration token: Tempo → Settings → Data Access → API integration.',
      author: 'Kravn',
      priority: 100,
      configSchema: {
        type: 'object',
        properties: {
          apiToken: {
            type: 'string',
            title: 'API Token',
            description:
              'Tempo API integration token. Create it in Tempo → Settings → Data Access → API integration → New token ' +
              '(grant the scopes you need, e.g. Plans, Teams, Accounts, Worklogs). Stored encrypted, never shown to the model.',
            secret: true,
          },
        },
        required: ['apiToken'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const token = readToken(config);
          switch (name) {
            case 'tempo_get_plans':
              return await getPlans(token, args);
            case 'tempo_get_plan':
              return await getPlan(token, args);
            case 'tempo_get_allocations':
              return await getAllocations(token, args);
            case 'tempo_create_plan':
              return await createPlan(token, args);
            case 'tempo_update_plan':
              return await updatePlan(token, args);
            case 'tempo_delete_plan':
              return await deletePlan(token, args);
            case 'tempo_get_user_capacity':
              return await getUserCapacity(token, args);
            case 'tempo_get_team_capacity':
              return await getTeamCapacity(token, args);
            case 'tempo_list_teams':
              return await listTeams(token, args);
            case 'tempo_get_team_members':
              return await getTeamMembers(token, args);
            case 'tempo_list_accounts':
              return await listAccounts(token, args);
            case 'tempo_get_worklogs':
              return await getWorklogs(token, args);
            case 'tempo_list_workload_schemes':
              return await listWorkloadSchemes(token);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Tempo request failed.', true);
        }
      },
    },
  };
}
