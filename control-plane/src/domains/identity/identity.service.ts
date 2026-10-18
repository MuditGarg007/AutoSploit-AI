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

// Refresh the GitHub access token this many seconds BEFORE it actually expires,
// so a request that reads the token never races the hard expiry boundary.
const GITHUB_TOKEN_SKEW_SEC = 120;

// GitHub's token endpoint response for a code exchange or a refresh_token grant.
interface GithubTokenGrant {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
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
    // Present only when the OAuth app issues expiring user tokens (GitHub App
    // with token expiration). Absent → non-expiring token, stored as-is.
    refreshToken?: string;
    expiresInSec?: number;
    refreshExpiresInSec?: number;
  }): Promise<IssuedSession> {
    const ciphertext = await this.vault.encrypt(input.githubToken);
    const refreshCiphertext = input.refreshToken
      ? await this.vault.encrypt(input.refreshToken)
      : null;
    const now = Date.now();
    const accessExpiresAt =
      input.expiresInSec != null ? new Date(now + input.expiresInSec * 1000) : null;
    const refreshExpiresAt =
      input.refreshExpiresInSec != null
        ? new Date(now + input.refreshExpiresInSec * 1000)
        : null;

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
        .values({
          userId: record.id,
          ciphertext,
          refreshCiphertext,
          accessExpiresAt,
          refreshExpiresAt,
        })
        .onConflictDoUpdate({
          target: githubTokens.userId,
          set: {
            ciphertext,
            refreshCiphertext,
            accessExpiresAt,
            refreshExpiresAt,
            updatedAt: new Date(),
          },
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

  // Non-rotating refresh on a stable session row. The refresh token is fixed for
  // the login's lifetime; /auth/refresh only mints a fresh short-lived access
  // token and slides the session's expiry. The refresh token itself is NOT
  // changed, so concurrent refreshes (multiple tabs, an SSE reconnect racing a
  // data fetch, a remount) are idempotent and safe — presenting the same cookie
  // twice simply mints two access tokens. This deliberately drops the earlier
  // rotate-on-every-refresh + replay-revoke scheme, which logged a browser out
  // within minutes because any of those routine races presented a just-rotated
  // (now "prev") cookie and the server nuked the whole session as suspected theft.
  //
  // The token is httpOnly + Secure + SameSite=None, so page JavaScript (and thus
  // an XSS payload) cannot read it; that is the theft control now. Access tokens
  // stay 15 min, and logout / expiry still revoke the session.
  //
  //   - presented matches a live session's hash → mint a new access token, slide
  //     expiry, return the SAME refresh token (so the cookie's max-age slides).
  //   - expired session                         → revoke + null (401).
  //   - no match                                → null (401, fail-closed).
  async refreshSession(presented: string): Promise<IssuedSession | null> {
    const presentedHash = this.hash(presented);

    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, presentedHash))
      .limit(1);
    const session = rows[0];
    if (!session) return null;

    if (session.expiresAt.getTime() < Date.now()) {
      await this.revokeSession(session.id);
      return null;
    }

    // Sliding session: an actively-refreshing client never expires; an idle one
    // lapses refreshTokenTtlSec after its last refresh.
    const expiresAt = new Date(Date.now() + this.env.refreshTokenTtlSec * 1000);
    await this.db
      .update(sessions)
      .set({ expiresAt, rotatedAt: new Date() })
      .where(eq(sessions.id, session.id));

    const accessToken = await this.mintAccessToken(
      session.userId,
      session.id,
    );
    const user = await this.getUserById(session.userId);
    return {
      accessToken,
      refreshToken: presented,
      refreshExpiresAt: expiresAt,
      user,
    };
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
    const row = (
      await this.db
        .select()
        .from(githubTokens)
        .where(eq(githubTokens.userId, userId))
        .limit(1)
    )[0];
    if (!row) return null;

    // Non-expiring token (classic OAuth App) or no refresh material: the stored
    // access token is good forever — use it as today.
    if (!row.accessExpiresAt || !row.refreshCiphertext) {
      return this.vault.decrypt(row.ciphertext);
    }

    // Still valid (with skew so we never hand out a token about to be rejected).
    if (row.accessExpiresAt.getTime() - GITHUB_TOKEN_SKEW_SEC * 1000 > Date.now()) {
      return this.vault.decrypt(row.ciphertext);
    }

    // Access token expired/expiring. If the refresh token is itself dead, the
    // user must re-login (fail-closed → caller maps missing token to 401).
    if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= Date.now()) {
      return null;
    }

    const refreshToken = await this.vault.decrypt(row.refreshCiphertext);
    const grant = await this.refreshGithubToken(refreshToken);
    if (!grant) return null; // refresh rejected → re-login

    await this.persistGithubGrant(userId, grant);
    return grant.accessToken;
  }

  // Exchange a refresh token for a fresh access+refresh pair (GitHub rotates both
  // on every refresh). Fail-closed: any transport error or error body yields null
  // so the caller treats the token as gone and prompts a re-login, rather than
  // throwing and 500-ing the whole request.
  private async refreshGithubToken(refreshToken: string): Promise<GithubTokenGrant | null> {
    let res: Response;
    try {
      res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: this.env.githubClientId,
          client_secret: this.env.githubClientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    // GitHub returns HTTP 200 with an `error` field (e.g. "bad_refresh_token")
    // on a dead/rotated refresh token, so the access_token presence is the real
    // success signal.
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
    } | null;
    if (!body?.access_token) return null;

    const now = Date.now();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: body.expires_in != null ? new Date(now + body.expires_in * 1000) : null,
      refreshExpiresAt:
        body.refresh_token_expires_in != null
          ? new Date(now + body.refresh_token_expires_in * 1000)
          : null,
    };
  }

  // Persist a refreshed grant back to github_tokens. Keeps the prior refresh
  // ciphertext/expiry when GitHub omits a new one (it normally rotates both).
  private async persistGithubGrant(userId: string, grant: GithubTokenGrant): Promise<void> {
    const ciphertext = await this.vault.encrypt(grant.accessToken);
    const set: Record<string, unknown> = {
      ciphertext,
      accessExpiresAt: grant.accessExpiresAt,
      updatedAt: new Date(),
    };
    if (grant.refreshToken) {
      set.refreshCiphertext = await this.vault.encrypt(grant.refreshToken);
      set.refreshExpiresAt = grant.refreshExpiresAt;
    }
    await this.db.update(githubTokens).set(set).where(eq(githubTokens.userId, userId));
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
