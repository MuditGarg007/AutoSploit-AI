import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import NodeVault from 'node-vault';
import { EnvService } from '../../../config/env.service.js';

const K8S_SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const VAULT_PREFIX = 'vault:v1:';

// Wraps a single node-vault client (Transit engine, k8s auth — docs/control-plane.md
// §9.1). The app holds ciphertext only and never the key; on k8s the pod service
// account authenticates to Vault, so there is no static bootstrap secret to leak.
// Outside k8s (local dev + Testcontainers) it falls back to VAULT_TOKEN.
@Injectable()
export class VaultService implements OnModuleInit {
  private readonly logger = new Logger(VaultService.name);
  private readonly client: NodeVault.client;

  constructor(@Inject(EnvService) private readonly env: EnvService) {
    this.client = NodeVault({
      endpoint: env.vaultAddr,
      token: env.vaultToken || undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  // Authenticate with the pod service-account token when running in k8s (no
  // static bootstrap secret). Falls back to the env token outside the cluster.
  private async authToken(): Promise<string> {
    if (process.env.KUBERNETES_SERVICE_HOST) {
      try {
        const jwt = await readFile(K8S_SA_TOKEN_PATH, 'utf8');
        const { auth } = await this.client.kubernetesLogin({
          role: 'control-plane',
          jwt,
        });
        return auth?.client_token ?? '';
      } catch {
        this.logger.warn('k8s Vault auth failed, falling back to VAULT_TOKEN');
      }
    }
    return this.env.vaultToken;
  }

  // Ensure the Transit key exists. In prod the key is provisioned by Terraform;
  // this is a no-op when it does (Vault returns 204 on an existing key). Also
  // enables the dev/CI path where the spec creates the key itself.
  async onModuleInit(): Promise<void> {
    try {
      await this.applyToken();
      await this.client.transitCreateKey({ name: this.env.vaultTransitKey });
    } catch (err) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status !== 204) {
        this.logger.warn(
          `Vault Transit key "${this.env.vaultTransitKey}" not created: ${status ?? 'unknown error'}. ` +
            'In prod this is provisioned by Terraform; ensure it exists before use.',
        );
      }
    }
  }

  // Resolve a live Vault token (k8s SA login in-cluster, else env) and apply it
  // to the shared client before a Transit call. On k8s env.vaultToken is empty,
  // so without this the client sends no token and Vault answers 403 → the request
  // surfaces as a 500 (docs/control-plane.md §9.1). onModuleInit does not set it
  // because the token is request-scoped and the k8s lease can rotate.
  private async applyToken(): Promise<void> {
    this.client.token = await this.authToken();
  }

  // Encrypt via Vault Transit. Returns the vault:v1: prefixed ciphertext that is
  // the ONLY thing persisted in github_tokens (§4.A). base64 is per the Transit
  // API; the prefix version-tags the key generation for future rotation.
  async encrypt(plaintext: string): Promise<string> {
    await this.applyToken();
    const { data } = await this.client.encryptData({
      name: this.env.vaultTransitKey,
      plaintext: Buffer.from(plaintext, 'utf8').toString('base64'),
    });
    return `${VAULT_PREFIX}${data.ciphertext}`;
  }

  // Decrypt vault:v1: ciphertext. Reached via IdentityService.getGithubToken by
  // B (picker reads) and Lifecycle (C) at dispatch — handed to the provisioner
  // env for clone, never logged, never to the harness (§6 secret split).
  async decrypt(ciphertext: string): Promise<string> {
    const stored = ciphertext.startsWith(VAULT_PREFIX)
      ? ciphertext.slice(VAULT_PREFIX.length)
      : ciphertext;
    await this.applyToken();
    const { data } = await this.client.decryptData({
      name: this.env.vaultTransitKey,
      ciphertext: stored,
    });
    return Buffer.from(data.plaintext, 'base64').toString('utf8');
  }
}
