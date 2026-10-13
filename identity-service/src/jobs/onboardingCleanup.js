// Background scheduler for the abandoned-onboarding sweep.
//
// This module owns only the SCHEDULING + logging; the policy lives in
// services/onboarding.service.js. Two rules keep it safe to run next to the API:
//
//   * the interval is `unref()`d, so it never holds the event loop open (the HTTP
//     listener does) and a graceful shutdown needs no special handling;
//   * every pass is error-isolated — a database hiccup logs and returns, and the
//     next tick simply tries again. A cleanup job must never be able to crash the
//     service.
const env = require('../config/env');
const { runAbandonedCleanup } = require('../services/onboarding.service');

let timer = null;

async function runOnce(trigger) {
  try {
    const summary = await runAbandonedCleanup({
      olderThanDays: env.onboardingAbandonAfterDays,
      limit: env.onboardingCleanupBatchLimit,
    });
    if (summary.removed > 0 || summary.archived > 0) {
      console.log(
        `[onboarding-cleanup] (${trigger}) scanned=${summary.scanned} removed=${summary.removed} archived=${summary.archived} olderThanDays=${summary.olderThanDays}`
      );
    } else {
      console.log('[onboarding-cleanup] (' + trigger + ') nothing to reclaim');
    }
    return summary;
  } catch (err) {
    console.error(`[onboarding-cleanup] (${trigger}) failed: ${err.message}`);
    return { scanned: 0, removed: 0, archived: 0, error: err.message };
  }
}

/**
 * Start the sweep. Idempotent: repeated calls share the one timer. Returns the
 * timer, or null when the scheduler is disabled (interval of 0).
 */
function startOnboardingCleanup() {
  if (timer) return timer;

  const intervalMs = env.onboardingCleanupIntervalMs;
  if (!intervalMs || intervalMs <= 0) {
    console.log('[onboarding-cleanup] scheduler disabled (ONBOARDING_CLEANUP_INTERVAL_MS=0)');
    return null;
  }

  if (env.onboardingCleanupRunOnStart) {
    // Fire and forget — the first pass must not delay readiness.
    runOnce('startup');
  }

  timer = setInterval(() => runOnce('interval'), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[onboarding-cleanup] scheduled every ${intervalMs}ms (abandoned after ${env.onboardingAbandonAfterDays} day(s))`
  );
  return timer;
}

function stopOnboardingCleanup() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startOnboardingCleanup,
  stopOnboardingCleanup,
  runOnboardingCleanupOnce: () => runOnce('manual'),
};
