import { Injectable } from '@nestjs/common';

// Typed, fail-fast access to process.env. Reads once at construction so a missing
// required var crashes boot, not a request. OPENROUTER_API_KEY is deliberately
// absent — the control plane never holds the model key (§6 secret split).
@Injectable()
export class EnvService {
  readonly port = Number(process.env.PORT ?? 3000);
  readonly databaseUrl = this.required('DATABASE_URL');
  readonly isProd = process.env.NODE_ENV === 'production';
  // Optional until P3 — nothing uses Redis before BullMQ (dispatch) + the SSE
  // last-mile land. Falls back to the local default so P0 dev/CI needs no fake var.
  readonly redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  // --- GitHub OAuth (Identity slice A, §4.A) ---
  readonly githubClientId = this.required('GITHUB_CLIENT_ID');
  readonly githubClientSecret = this.required('GITHUB_CLIENT_SECRET');
  readonly githubCallbackUrl = this.required('GITHUB_CALLBACK_URL');

  // --- Sessions: short-lived access JWT + rotating refresh (jose) ---
  readonly jwtAccessSecret = this.required('JWT_ACCESS_SECRET');
  readonly jwtRefreshSecret = this.required('JWT_REFRESH_SECRET');
  readonly accessTokenTtlSec = Number(process.env.ACCESS_TOKEN_TTL_SEC ?? 15 * 60);
  readonly refreshTokenTtlSec = Number(process.env.REFRESH_TOKEN_TTL_SEC ?? 30 * 24 * 60 * 60);

  // --- Vault (token vault, Transit engine, k8s auth — §9.1) ---
  // KUBERNETES_SERVICE_HOST is injected by k8s, not read from .env; when it is
  // set, VaultService authenticates with the pod service-account token. Outside
  // k8s (local dev + Testcontainers) the client falls back to VAULT_TOKEN, so
  // there is no static bootstrap secret in the app image.
  readonly vaultAddr = process.env.VAULT_ADDR ?? 'http://localhost:8200';
  readonly vaultTransitKey = this.required('VAULT_TRANSIT_KEY');
  readonly vaultToken = process.env.VAULT_TOKEN ?? process.env.VAULT_DEV_ROOT_TOKEN_ID ?? '';

  private required(key: string): string {
    const v = process.env[key];
    if (!v) throw new Error(`Missing required env var: ${key}`);
    return v;
  }
}
