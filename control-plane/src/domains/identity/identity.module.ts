import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { VaultService } from './vault/vault.service.js';

// A · Identity — GitHub OAuth handshake (login IS the consent record), session
// issuance, and the GitHub-token vault. VaultService is exported because
// Lifecycle (C) decrypts the token at dispatch via this slice's boundary — no
// other slice writes a user or token (docs/control-plane.md §4.A).
@Module({
  controllers: [IdentityController],
  providers: [IdentityService, VaultService],
  exports: [IdentityService, VaultService],
})
export class IdentityModule {}
