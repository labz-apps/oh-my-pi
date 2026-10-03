/**
 * Token-budget arithmetic for the compaction trigger: the reserve and threshold
 * functions plus the {@link CompactionSettings} shape they read.
 *
 * Split out of `./compaction` so a leaf consumer can compute a threshold without
 * evaluating the compaction engine. `./compaction` is a value-import
 * heavyweight: it reaches the provider stack (`@oh-my-pi/pi-ai`), every
 * provider-specific compaction implementation, and the model catalog. The TUI
 * status line needs exactly two pure numeric helpers from it, and the status
 * line is on the cold-start path to the first frame the user can type into — so
 * importing the engine there put ~440 modules of provider and catalog surface in
 * front of that frame. Nothing in this file imports anything.
 *
 * `./compaction` re-exports every symbol here, so existing importers are
 * unaffected.
 */

export interface CompactionSettings {
	enabled: boolean;
	strategy?: "context-full" | "handoff" | "shake" | "snapcompact" | "off";
	thresholdPercent?: number;
	thresholdTokens?: number;
	midTurnEnabled?: boolean;
	/**
	 * Tokens reserved below the context window for the next prompt + response.
	 *
	 * Leave unset to use {@link DEFAULT_RESERVE_TOKENS}; the unset state is the
	 * provenance signal that lets small-window recovery replace the default with
	 * a proportional reserve (see {@link resolveBudgetReserveTokens}). An
	 * explicit value — even one equal to the default — is always honored.
	 */
	reserveTokens?: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	remoteEnabled?: boolean;
	remoteEndpoint?: string;
	remoteStreamingV2Enabled?: boolean;
	v2RetainedMessageBudget?: number;
}

/** Reserve applied when {@link CompactionSettings.reserveTokens} is unset. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/**
 * Effective reserve: at least 15% of context window or the configured floor
 * (defaulting to {@link DEFAULT_RESERVE_TOKENS} when unset), whichever is larger.
 */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

/**
 * Reserve used when deciding whether a prompt still fits inside the model window.
 *
 * The default absolute reserve predates small bundled windows and can leave no
 * practical budget there; recover a DEFAULTED reserve that is impossible for
 * the window with the 15% proportional reserve (clamped to >= 1 so the derived
 * threshold stays strictly below the window even for tiny test windows).
 * Explicit valid reserves — including one that happens to equal the default —
 * still win, because they intentionally shrink the usable prompt budget;
 * provenance is carried by `settings.reserveTokens` being unset, never by
 * comparing values against the default.
 */
export function resolveBudgetReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	const reserveTokens = effectiveReserveTokens(contextWindow, settings);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const reserveWasDefaulted = settings.reserveTokens === undefined;
	const defaultReserveIsEffectivelyImpossible =
		reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
	const reserveExceedsWindow = reserveTokens >= contextWindow;

	return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow ? proportionalReserveTokens : reserveTokens;
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || settings.strategy === "off" || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

/**
 * Context tokens to feed the compaction decision, floored by a local estimate of
 * the stored conversation.
 *
 * The provider-reported usage is normally ground truth, but a
 * `before_provider_request` payload transform — a compression extension (e.g.
 * Headroom), an obfuscator, or inline snapcompact — can shrink the request below
 * the real stored conversation. The provider then reports deflated prompt
 * tokens, so anchoring compaction purely on that usage lets the real history
 * grow unbounded until it overflows and native compaction can no longer run.
 * Flooring by the agent's own estimate of the stored conversation keeps the
 * compaction trigger honest regardless of on-wire compression. (Display/cost
 * accounting still uses the exact provider usage; only the compaction decision
 * takes the floor.)
 */
export function compactionContextTokens(providerContextTokens: number, storedConversationEstimate: number): number {
	return Math.max(Math.max(0, providerContextTokens), Math.max(0, storedConversationEstimate));
}

export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	// Fixed token limit takes priority over percentage
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		// Clamp to [1, contextWindow - 1] so there's always room
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}

	// Percentage-based threshold. The default absolute reserve can exceed bundled
	// small-context windows, or nearly consume a 16k-class window; in those
	// known-impossible default configurations, fall back to the proportional
	// reserve so threshold/recovery-band checks stay usable. Explicit valid
	// configured reserves still define the usable prompt budget. Cap at
	// contextWindow - 1 (matching the fixed-token clamp above) so the threshold
	// never reaches the whole window even when the reserve resolves to 0.
	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return Math.max(
			0,
			Math.min(contextWindow - 1, contextWindow - resolveBudgetReserveTokens(contextWindow, settings)),
		);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}
