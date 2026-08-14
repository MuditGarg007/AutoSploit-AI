import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { DRIZZLE, type Db } from '../../db/drizzle.module.js';
import { EnvService } from '../../config/env.service.js';
import { githubTokens, sessions, users } from './identity.schema.js';
import { VaultService } from './vault/vault.service.js';

export interface SessionUser {
  id: string;
  githubId: string;
  login: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: SessionUser;
}

// Sole writer of users / sessions / github_tokens (docs/control-plane.md §4.A).
// Token writes go through VaultService first so only ciphertext reaches Postgres
// (§12 gate A). Refresh tokens are stored as SHA-256 hashes so a sessions-table
// leak never yields a usable token.
@Injectable()
export class IdentityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(VaultService) private readonly vault: VaultService,
  ) {}

  // Login IS the consent record: upsert the user from the GitHub identity, store
  // the access token as vault ciphertext, and issue a fresh session. All-or-
  // nothing via a transaction so a failure never leaves a partial write.
  async completeGitHubLogin(input: {
    githubId: string;
    login: string;
    githubToken: string;
  }): Promise<IssuedSession> {
    const ciphertext = await this.vault.encrypt(input.githubToken);

    const user = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(users)
        .where(eq(users.githubId, input.githubId))
        .limit(1);
      let record = existing[0];
      if (!record) {
        const created = await tx
          .insert(users)
          .values({ githubId: input.githubId, login: input.login })
          .returning();
        record = created[0];
      } else if (record.login !== input.login) {
        const updated = await tx
          .update(users)
          .set({ login: input.login })
          .where(eq(users.id, record.id))
          .returning();
        record = updated[0];
      }
      await tx
        .insert(githubTokens)
        .values({ userId: record.id, ciphertext })
        .onConflictDoUpdate({
          target: githubTokens.userId,
          set: { ciphertext, updatedAt: new Date() },
        });
      return record;
    });

    return this.issueSession(user.id);
  }

  async issueSession(userId: string): Promise<IssuedSession> {
    const sessionId = randomUUID();
    const accessToken = await new SignJWT({
      sub: userId,
      sid: sessionId,
      type: 'access',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + this.env.accessTokenTtlSec,
      )
      .sign(new TextEncoder().encode(this.env.jwtAccessSecret));

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.env.refreshTokenTtlSec * 1000,
    );

    await this.db.insert(sessions).values({
      id: sessionId,
      userId,
      refreshTokenHash: this.hash(refreshToken),
      expiresAt,
    });

    const user = await this.getUserById(userId);
    return {
      accessToken,
      refreshToken,
      refreshExpiresAt: expiresAt,
      user,
    };
  }

  // Rotating refresh tokens: consume the presented token, issue a new one, and
  // stamp the row. A presented token that has already been rotated is a reuse →
  // revoke the session (fail-closed).
  async rotateRefresh(
    presented: string,
  ): Promise<IssuedSession | null> {
    const hash = this.hash(presented);
    const row = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.refreshTokenHash, hash)))
      .limit(1);

    const session = row[0];
    if (!session || session.expiresAt.getTime() < Date.now()) return null;
    if (session.rotatedAt) {
      await this.revokeSession(session.id);
      return null;
    }

    const next = await this.issueSession(session.userId);
    await this.db
      .update(sessions)
      .set({ rotatedAt: new Date() })
      .where(eq(sessions.id, session.id));
    return next;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async getUserBySession(sessionId: string): Promise<SessionUser | null> {
    const row = await this.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row[0] ? this.toSessionUser(row[0].user) : null;
  }

  private async getUserById(id: string): Promise<SessionUser> {
    const row = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return this.toSessionUser(row[0]);
  }

  private toSessionUser(row: typeof users.$inferSelect): SessionUser {
    return { id: row.id, githubId: row.githubId, login: row.login };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
