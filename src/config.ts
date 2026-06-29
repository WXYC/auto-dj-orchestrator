/**
 * Typed, validated configuration. Parsed once at boot; any missing/invalid
 * value aborts startup with a clear message (fail-fast).
 */
import { z } from 'zod';

const schema = z.object({
  // Server
  ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(8090),
  ORCHESTRATOR_PUBLIC_URL: z.string().url().default('http://localhost:8090'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  SENTRY_DSN: z.string().optional(),

  // Arduino-facing management channel
  AUTO_DJ_KEY: z.string().min(1),
  DEVICE_OFFLINE_THRESHOLD_MS: z.coerce.number().int().positive().default(60_000),
  WS_PING_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),

  // AzuraCast
  AZURACAST_WS_URL: z.string().url(),
  AZURACAST_HTTP_URL: z.string().url(),
  AZURACAST_STATION_SHORTCODE: z.string().min(1),
  AZURACAST_SAFETY_POLL_MS: z.coerce.number().int().positive().default(60_000),
  AZURACAST_FALLBACK_POLL_MS: z.coerce.number().int().positive().default(20_000),

  // Backend-Service (single flowsheet backend)
  BACKEND_SERVICE_URL: z.string().url(),
  AUTH_SERVICE_URL: z.string().url(),
  AUTH_TRUSTED_ORIGIN: z.string().url(),
  AUTO_DJ_EMAIL: z.string().min(1),
  AUTO_DJ_PASSWORD: z.string().min(1),
  AUTO_DJ_SHOW_NAME: z.string().default('Auto DJ'),
  TOKEN_REFRESH_SKEW_MS: z.coerce.number().int().nonnegative().default(60_000),

  // dj-site JWT verification
  BETTER_AUTH_JWKS_URL: z.string().url(),
  BETTER_AUTH_ISSUER: z.string().min(1),
  BETTER_AUTH_AUDIENCE: z.string().min(1),

  // Restart recovery
  STATE_STORE_PATH: z.string().default('./auto-dj-state.json'),
});

export type Config = z.infer<typeof schema> & { corsAllowedOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid orchestrator configuration:\n${issues}`);
  }
  return {
    ...parsed.data,
    corsAllowedOrigins: parsed.data.CORS_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
