import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
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
// (§12 gate A). Refresh tokens are stored as keyed HMAC-SHA256 (peppered with
// JWT_REFRESH_SECRET) so a sessions-table leak never yields a usable token.
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
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.refreshTokenTtlSec * 1000);

    await this.db.insert(sessions).values({
      id: sessionId,
      userId,
      refreshTokenHash: this.hash(refreshToken),
      expiresAt,
    });

    const accessToken = await this.mintAccessToken(userId, sessionId);
    const user = await this.getUserById(userId);
    return { accessToken, refreshToken, refreshExpiresAt: expiresAt, user };
  }

  // Rotating refresh tokens, rotated IN PLACE on a stable session row:
  //   - presented matches the row's CURRENT hash  → rotate: mint a new access
  //     token (same session id), generate a new refresh token, and overwrite
  //     the row's current hash (demoting the old one to prev_refresh_token_hash).
  //   - presented matches a row's PREV hash        → the token was already
  //     rotated away and is being replayed. Treat as theft and revoke the whole
  //     session (the token family), so neither the legitimate holder nor an
  //     attacker keeps it (fail-closed).
  //   - no match / expired                         → null (401).
  // A client that retries a refresh with the same (now-superseded) token after a
  // successful rotation therefore loses the session; that strictness is the
  // intended reuse-detection tradeoff.
  async rotateRefresh(presented: string): Promise<IssuedSession | null> {
    const presentedHash = this.hash(presented);

    const currentRows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, presentedHash))
      .limit(1);
    const current = currentRows[0];
    if (current) {
      if (current.expiresAt.getTime() < Date.now()) {
        await this.revokeSession(current.id);
        return null;
      }
      const nextRefresh = randomBytes(48).toString('base64url');
      const expiresAt = new Date(
        Date.now() + this.env.refreshTokenTtlSec * 1000,
      );
      await this.db
        .update(sessions)
        .set({
          prevRefreshTokenHash: current.refreshTokenHash,
          refreshTokenHash: this.hash(nextRefresh),
          rotatedAt: new Date(),
          expiresAt,
        })
        .where(eq(sessions.id, current.id));
      const accessToken = await this.mintAccessToken(
        current.userId,
        current.id,
      );
      const user = await this.getUserById(current.userId);
      return {
        accessToken,
        refreshToken: nextRefresh,
        refreshExpiresAt: expiresAt,
        user,
      };
    }

    // Reuse of an already-rotated token → revoke the whole session family.
    const reuseRows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.prevRefreshTokenHash, presentedHash))
      .limit(1);
    if (reuseRows[0]) await this.revokeSession(reuseRows[0].id);
    return null;
  }

  private mintAccessToken(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sub: userId, sid: sessionId, type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + this.env.accessTokenTtlSec,
      )
      .sign(new TextEncoder().encode(this.env.jwtAccessSecret));
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  // A→B/C boundary: hands out the user's decrypted GitHub token (plaintext) to
  // slices that legitimately need it — B (picker) and C (dispatch). Reading the
  // vault entry still goes through A alone; no other slice queries github_tokens
  // (docs/control-plane.md §4.A, §5 rule 1).
  async getGithubToken(userId: string): Promise<string | null> {
    const row = await this.db
      .select()
      .from(githubTokens)
      .where(eq(githubTokens.userId, userId))
      .limit(1);
    if (!row[0]) return null;
    return this.vault.decrypt(row[0].ciphertext);
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

  // Refresh tokens are stored as a keyed HMAC-SHA256, not a bare digest: the
  // JWT_REFRESH_SECRET is the server-side pepper, so a sessions-table leak alone
  // (without the secret) yields neither a usable token nor a lookup oracle.
  private hash(token: string): string {
    return createHmac('sha256', this.env.jwtRefreshSecret)
      .update(token)
      .digest('hex');
  }
}
