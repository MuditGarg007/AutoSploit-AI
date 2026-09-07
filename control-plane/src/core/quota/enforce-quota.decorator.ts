import { SetMetadata } from '@nestjs/common';

export const ENFORCE_QUOTA_KEY = 'enforce-quota';

// Route marker for the one gated dispatch path. Lives in core/ so C can import
// it without importing the Quota domain — the same allowed direction as C already
// importing SessionGuard from core/guards (docs/component-q-quota.md §3.3). The
// global QuotaInterceptor reads this via Reflector; interceptors run AFTER guards,
// so request.user is populated when the quota check fires.
export const EnforceQuota = (): MethodDecorator =>
  SetMetadata(ENFORCE_QUOTA_KEY, true);
