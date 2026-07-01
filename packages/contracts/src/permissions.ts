import { z } from 'zod';

/**
 * Roles are intentionally simple for the MVP. They expand cleanly later
 * (the original ContextForge uses a far richer inheritance graph; Kravn starts
 * with three flat roles and a dot-notation permission model that can grow).
 */
export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

/**
 * Permission strings use `resource.action` dot notation, with `*` wildcard support
 * (e.g. `servers.*`, `*`). The resolver in the server expands wildcards.
 */
export const PERMISSIONS = [
  'servers.read',
  'servers.write',
  'servers.delete',
  'registry.read',
  'registry.write',
  'virtualservers.read',
  'virtualservers.write',
  'virtualservers.delete',
  'settings.read',
  'settings.write',
  'users.read',
  'users.write',
  'teams.read',
  'teams.write',
  'logs.read',
  'mcp.invoke',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Static role → permissions map (the wildcard `*` means "everything"). */
export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  admin: ['*'],
  editor: [
    'servers.read',
    'servers.write',
    'registry.read',
    'registry.write',
    'virtualservers.read',
    'virtualservers.write',
    'settings.read',
    'teams.read',
    'logs.read',
    'mcp.invoke',
  ],
  viewer: [
    'servers.read',
    'registry.read',
    'virtualservers.read',
    'settings.read',
    'teams.read',
    'logs.read',
    // A viewer is a read-only operator AND an MCP consumer. `mcp.invoke` no longer decides WHICH MCP a
    // user may use — the per-virtual-server access policy + per-team tool grants do. So a "consumer" user
    // (e.g. a partner) can be a viewer: able to invoke, but only the servers/tools they've been granted.
    'mcp.invoke',
  ],
};

/** Does the granted permission set satisfy the required permission (wildcard-aware)? */
export function permissionMatches(granted: readonly string[], required: string): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  const [resource] = required.split('.');
  return granted.includes(`${resource}.*`);
}

export function permissionsForRole(role: Role): readonly string[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
