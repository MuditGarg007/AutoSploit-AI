import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import NodeVault from 'node-vault';
import { EnvService } from '../src/config/env.service.js';
import { VaultService } from '../src/domains/identity/vault/vault.service.js';

// Component A gate: the GitHub token is decryptable ONLY through Vault Transit
// (docs/control-plane.md §12 gate A). Real Vault in dev mode, not a mock (§9.1) —
// same posture as the Postgres Testcontainers gate.
describe('VaultService against real Vault Transit', () => {
  let vault: StartedTestContainer;
  let token: string;
  let service: VaultService;

  beforeAll(async () => {
    // EnvService reads every required var at construction (fail-fast boot), so
    // set minimal dummies — the vault spec only exercises Vault, not Postgres.
    process.env.DATABASE_URL = 'postgres://placeholder';
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/auth/callback';
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';

    vault = await new GenericContainer('hashicorp/vault:1.15')
      .withExposedPorts(8200)
      .withCommand(['server', '-dev', '-dev-root-token-id', 'root-token'])
      .start();

    const endpoint = `http://${vault.getHost()}:${vault.getMappedPort(8200)}`;

    // Vault dev mode auto-enables only KV — mount Transit explicitly, then create
    // the key the service expects.
    const admin = NodeVault({ endpoint, token: 'root-token' });
    await admin.mount({ mount_point: 'transit', type: 'transit' });
    await admin.transitCreateKey({ name: 'github-tokens' });

    const env = new EnvService();
    // The field is readonly but settable at runtime; only used for construction.
    Object.assign(env, { vaultAddr: endpoint, vaultToken: 'root-token' });
    service = new VaultService(env);
    await service.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    await vault?.stop();
  });

  it('encrypts to opaque ciphertext, never the plaintext', async () => {
    const secret = 'ghp_super_secret_token_12345';
    const stored = await service.encrypt(secret);

    expect(stored.startsWith('vault:v1:')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(Buffer.from(secret).toString('base64'));
  });

  it('decrypts ciphertext back to the original plaintext', async () => {
    const secret = 'ghp_another_token_67890';
    const stored = await service.encrypt(secret);
    expect(await service.decrypt(stored)).toBe(secret);
  });

  it('round-trips a long token (GitHub fine-grained PATs are long)', async () => {
    const secret = 'github_pat_'.concat('a'.repeat(80));
    const stored = await service.encrypt(secret);
    expect(await service.decrypt(stored)).toBe(secret);
  });
});
