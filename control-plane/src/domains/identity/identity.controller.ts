import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { EnvService } from '../../config/env.service.js';
import { SessionGuard } from '../../core/guards/session.guard.js';
import { CurrentUser } from '../../core/guards/current-user.decorator.js';
import type { AuthenticatedUser } from '../../core/guards/session.guard.js';
import { IdentityService } from './identity.service.js';

const STATE_COOKIE = 'gh_oauth_state';
const REFRESH_COOKIE = 'refresh_token';
const ACCESS_TOKEN_PARAM = 'access_token';

// GET /auth/github, /auth/callback, /me (docs/control-plane.md §4.A).
// OAuth handshake is manual fetch, not passport — keeps the code and the
// consent record readable, and avoids passport-session baggage.
@Controller()
export class IdentityController {
  constructor(
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  // 1. Redirect into GitHub OAuth; state cookie guards the callback (CSRF).
  @Get('auth/github')
  login(@Res() res: FastifyReply): void {
    const state = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: this.env.githubClientId,
      redirect_uri: this.env.githubCallbackUrl,
      scope: 'repo',
      state,
    });
    res.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.env.isProd,
    });
    res.redirect(
      302,
      `https://github.com/login/oauth/authorize?${params.toString()}`,
    );
  }

  // 2. Exchange code → user + token, upsert user, vault-encrypt token, issue
  //    session (JWT + refresh cookie), redirect to the dashboard.
  @Get('auth/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const savedState = req.cookies?.[STATE_COOKIE];
    if (!savedState || savedState !== state) {
      throw new UnauthorizedException('OAuth state mismatch');
    }

    const { githubId, login, githubToken } = await this.exchangeCode(code);
    const session = await this.identity.completeGitHubLogin({
      githubId,
      login,
      githubToken,
    });

    res.clearCookie(STATE_COOKIE, { path: '/' });
    res.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.env.isProd,
      expires: session.refreshExpiresAt,
    });
    res.redirect(
      302,
      `/?${ACCESS_TOKEN_PARAM}=${encodeURIComponent(session.accessToken)}`,
    );
  }

  // 3. /me — the authenticated user from a valid session.
  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentUser() auth: AuthenticatedUser) {
    const user = await this.identity.getUserBySession(auth.sessionId);
    if (!user) throw new UnauthorizedException('Session no longer valid');
    return user;
  }

  // Exchange the OAuth code for the user's access token + profile. Throws on
  // GitHub error → 401 (fail-closed).
  private async exchangeCode(code: string): Promise<{
    githubId: string;
    login: string;
    githubToken: string;
  }> {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.env.githubClientId,
        client_secret: this.env.githubClientSecret,
        code,
      }),
    });
    if (!tokenRes.ok) throw new UnauthorizedException('GitHub token exchange failed');
    const tokenBody = (await tokenRes.json()) as { access_token?: string };
    if (!tokenBody.access_token) throw new UnauthorizedException('GitHub token exchange failed');

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    if (!userRes.ok) throw new UnauthorizedException('GitHub user fetch failed');
    const profile = (await userRes.json()) as { id: number; login: string };

    return {
      githubId: String(profile.id),
      login: profile.login,
      githubToken: tokenBody.access_token,
    };
  }
}
