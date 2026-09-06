import type { Provider } from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import { EnvService } from '../../config/env.service.js';

export const OBJECT_STORE = Symbol('OBJECT_STORE');

// Reports (E) is the only in-app reader of the object store — the S3 sink (Kafka
// Connect) is the writer, out of process (docs/control-plane.md §8.2). So the S3
// client is scoped to this slice, not a global module.
//
// The stack names "AWS SDK v3" (§9.1); we use the `minio` client instead — it is
// S3-compatible (same presigned-URL contract against real S3 or MinIO), is the
// client already proven against the MinIO container in the D-b S3-sink spec, and
// keeps one object-store client across the codebase. Presigned GET URLs are the
// one capability E needs from it.
//
// Nullable, mirroring the REDIS provider: an empty S3_ACCESS_KEY means the store
// is unconfigured (pre-E slices, local dev), and the provider yields null so the
// app still boots. ReportsService degrades to null presigned URLs when it is null.
export const objectStoreProvider: Provider = {
  provide: OBJECT_STORE,
  inject: [EnvService],
  useFactory: (env: EnvService): MinioClient | null => {
    if (!env.s3AccessKey || !env.s3SecretKey) return null;
    const url = new URL(env.s3Endpoint);
    const useSSL = url.protocol === 'https:';
    return new MinioClient({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : useSSL ? 443 : 80,
      useSSL,
      accessKey: env.s3AccessKey,
      secretKey: env.s3SecretKey,
    });
  },
};
