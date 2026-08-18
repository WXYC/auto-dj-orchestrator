/**
 * Boot-time preflight checks. Validates that external prerequisites are in
 * place before wiring the service. Currently checks only the AzuraCast station
 * shortcode, which is the one misconfiguration that fails *silently* — a wrong
 * shortcode subscribes to Centrifugo successfully and then never receives a
 * publication, quietly degrading to 20s HTTP polling with nothing in the logs
 * to explain why (see #33).
 *
 * Auth/account issues are deliberately NOT checked here: TokenManager's first
 * sign-in is seconds away and handles 401/403/429 with proper retry-after
 * backoff and clear log messages. A preflight sign-in would double the boot
 * sign-in count, leave a stale session row, and risk pushing a crash-restart
 * loop into Better-Auth's 3-per-10s rate limit.
 *
 * Failures are warnings (not fatal) so a partial environment (local dev, CI,
 * staging mock) doesn't block startup.
 */
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface PreflightResult {
  azuracastShortcodeOk: boolean;
}

export async function runPreflight(
  config: Config,
  logger: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<PreflightResult> {
  const result: PreflightResult = {
    azuracastShortcodeOk: false,
  };

  try {
    result.azuracastShortcodeOk = await checkAzuracastShortcode(config, logger, fetchFn);
  } catch (err) {
    logger.warn({ err }, 'preflight check threw unexpectedly');
  }

  if (result.azuracastShortcodeOk) {
    logger.info('preflight: all checks passed');
  } else {
    logger.warn(result, 'preflight: AzuraCast shortcode check failed (see warning above)');
  }
  return result;
}

async function checkAzuracastShortcode(
  config: Config,
  logger: Logger,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const base = new URL(config.AZURACAST_HTTP_URL);
    const checkUrl = `${base.origin}/api/nowplaying/${config.AZURACAST_STATION_SHORTCODE}`;
    const resp = await fetchFn(checkUrl, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      logger.warn(
        { shortcode: config.AZURACAST_STATION_SHORTCODE, status: resp.status },
        'preflight: AzuraCast station shortcode returned non-200',
      );
      return false;
    }

    const body: unknown = await resp.json();

    // AzuraCast returns 200 for *any* identifier: a real shortcode yields a
    // single station object; an unknown one yields the full station array.
    // An array back means the shortcode is wrong.
    if (Array.isArray(body)) {
      logger.warn(
        { shortcode: config.AZURACAST_STATION_SHORTCODE },
        'preflight: AzuraCast returned the all-stations list — shortcode does not match a station. ' +
          'The Centrifugo channel will silently receive no publications.',
      );
      return false;
    }

    // Verify the returned station's shortcode matches what we configured.
    const returnedShortcode =
      body != null && typeof body === 'object' && 'station' in body
        ? (body as { station?: { shortcode?: string } }).station?.shortcode
        : undefined;

    if (returnedShortcode && returnedShortcode !== config.AZURACAST_STATION_SHORTCODE) {
      logger.warn(
        { expected: config.AZURACAST_STATION_SHORTCODE, actual: returnedShortcode },
        'preflight: AzuraCast station shortcode mismatch',
      );
      return false;
    }

    logger.info(
      { shortcode: config.AZURACAST_STATION_SHORTCODE },
      'preflight: AzuraCast station shortcode verified',
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, shortcode: config.AZURACAST_STATION_SHORTCODE },
      'preflight: AzuraCast shortcode check unreachable',
    );
    return false;
  }
}
