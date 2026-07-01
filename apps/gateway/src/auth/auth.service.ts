import {
  permissionsForRole,
  type Role,
  type SetupRequest,
  type RegisterRequest,
  type CreateUserRequest,
} from '@kravn/contracts';
import { hashPassword, verifyPassword, newId } from '../crypto.js';
import type { Repos, UserRecord } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { Env } from '../config/env.js';
import type { Logger } from 'pino';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: readonly string[];
  teams: string[];
}

export class AuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export function toAuthUser(
  u: UserRecord | { id: string; email: string; name: string; role: string },
  teams: string[] = [],
): AuthUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    permissions: permissionsForRole(u.role as Role),
    teams,
  };
}

export class AuthService {
  constructor(
    private repos: Repos,
    private settings: SettingsService,
    private env: Env,
    private log: Logger,
  ) {}

  async setupRequired(): Promise<boolean> {
    return (await this.repos.users.count()) === 0;
  }

  /** Optionally bootstrap the first admin from env (skips the UI wizard). */
  async bootstrapFromEnv(): Promise<void> {
    if (!(await this.setupRequired())) return;
    if (this.env.adminEmail && this.env.adminPassword) {
      const admin = await this.repos.users.create({
        id: newId(),
        email: this.env.adminEmail,
        name: 'Administrator',
        role: 'admin',
        passwordHash: hashPassword(this.env.adminPassword),
      });
      await this.repos.teams.ensurePlatformAdminMembership(admin.id);
      this.log.info({ email: this.env.adminEmail }, 'bootstrapped admin user from environment');
    }
  }

  async setup(req: SetupRequest): Promise<UserRecord> {
    if (!(await this.setupRequired())) {
      throw new AuthError('already_initialized', 'Kravn is already set up.', 409);
    }
    const user = await this.repos.users.create({
      id: newId(),
      email: req.email,
      name: req.name || 'Administrator',
      role: 'admin',
      passwordHash: hashPassword(req.password),
    });
    // The first admin seeds and joins the Platform Administrator Team — the gate for the admin console.
    await this.repos.teams.ensurePlatformAdminMembership(user.id);
    if (req.instanceName) {
      await this.settings.update({ general: { instanceName: req.instanceName } });
    }
    this.log.info({ email: req.email }, 'initial admin created via setup wizard');
    return user;
  }

  async login(email: string, password: string): Promise<UserRecord> {
    const user = await this.repos.users.getByEmail(email);
    // Constant-ish work even when user missing, to avoid a trivial timing oracle.
    const hash = user?.passwordHash ?? 'scrypt$AAAA$AAAA';
    const ok = verifyPassword(password, hash);
    if (!user || !ok) {
      throw new AuthError('invalid_credentials', 'Invalid email or password.', 401);
    }
    return user;
  }

  async register(req: RegisterRequest): Promise<UserRecord> {
    if (!this.settings.get().auth.publicRegistrationEnabled) {
      throw new AuthError('registration_disabled', 'Public registration is disabled.', 403);
    }
    if (await this.repos.users.getByEmail(req.email)) {
      throw new AuthError('email_taken', 'That email is already registered.', 409);
    }
    return this.repos.users.create({
      id: newId(),
      email: req.email,
      name: req.name,
      role: 'viewer',
      passwordHash: hashPassword(req.password),
    });
  }

  async createUser(req: CreateUserRequest): Promise<UserRecord> {
    if (await this.repos.users.getByEmail(req.email)) {
      throw new AuthError('email_taken', 'That email is already registered.', 409);
    }
    const user = await this.repos.users.create({
      id: newId(),
      email: req.email,
      name: req.name,
      role: req.role,
      passwordHash: hashPassword(req.password),
    });
    // An admin created here must be able to reach the console; a viewer/editor must NOT (they're consumers).
    if (req.role === 'admin') await this.repos.teams.ensurePlatformAdminMembership(user.id);
    return user;
  }
}
