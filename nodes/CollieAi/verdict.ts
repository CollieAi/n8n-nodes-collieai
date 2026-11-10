/**
 * The verdict of a finished job, by the Node SDK's fail-safe table
 * (node/src/moderation.ts in CollieAi/collieai-sdk, toModerationResult /
 * toOutputModerationResult):
 * allowed only with an explicit `allowed === true` and no block signal; an
 * ambiguous answer is blocked; a job without its phase result is malformed
 * (returned as an error, never thrown). The node never derives a decision
 * from the triggered rules. An input check also reads the job's context
 * result (`context_result`, on the job, not in the phase result): a context
 * block blocks, and its message stands in when the phase result has none. The
 * SDKs' shared vectors (conformance/verdict_cases.json in CollieAi/collieai-sdk)
 * run against it from their copy, test/verdict_cases.json.
 */

import { CheckError } from './errors';

export type Phase = 'input' | 'output';

export interface TriggeredRule {
	ruleId: string;
	ruleName: string;
	ruleType: string;
	decision: string;
	monitoring: boolean;
	matchInfo?: Record<string, unknown> | null;
}

export interface CheckResult {
	allowed: boolean;
	blocked: boolean;
	/** The text to pass on: the masked text when a rule masked it, else the
	 * original. `null` when blocked. */
	text: string | null;
	blockMessage: string | null;
	triggeredRules: TriggeredRule[];
	jobId: string;
	requestId: string | null;
}

export const PHASES = {
	input: {
		result: 'inbound_result',
		verdictStatuses: new Set(['completed', 'inbound_blocked']),
		blockedStatus: 'inbound_blocked',
	},
	output: {
		result: 'outbound_result',
		verdictStatuses: new Set(['completed', 'outbound_blocked']),
		blockedStatus: 'outbound_blocked',
	},
} as const;

export const FAILED_STATUSES = new Set(['failed', 'expired']);

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

function toRule(r: unknown, includeMatchDetails: boolean): TriggeredRule | null {
	if (!isObject(r)) return null;
	const rule: TriggeredRule = {
		ruleId: str(r.rule_id),
		ruleName: str(r.rule_name),
		ruleType: str(r.rule_type),
		decision: str(r.decision),
		monitoring: Boolean(r.monitoring),
	};
	if (includeMatchDetails) rule.matchInfo = isObject(r.match_info) ? r.match_info : null;
	return rule;
}

export function toCheckResult(
	phase: Phase,
	originalText: string,
	jobId: string,
	requestId: string | null,
	job: Record<string, unknown>,
	includeMatchDetails: boolean,
): CheckResult | CheckError {
	const malformed = new CheckError('invalid_response', 'CollieAi returned a malformed result', {
		jobId,
	});
	const spec = PHASES[phase];
	const result = job[spec.result];
	if (!isObject(result)) return malformed;
	const rawRules = result.triggered_rules ?? [];
	if (!Array.isArray(rawRules)) return malformed;
	const triggeredRules: TriggeredRule[] = [];
	for (const raw of rawRules) {
		const rule = toRule(raw, includeMatchDetails);
		if (rule === null) return malformed;
		triggeredRules.push(rule);
	}
	const filtered = result.filtered_content;
	if (filtered !== undefined && filtered !== null && typeof filtered !== 'string') {
		return malformed;
	}

	const context = phase === 'input' && isObject(job.context_result) ? job.context_result : null;
	const contextBlocked = context !== null && Boolean(context.blocked);
	const hardBlocked =
		job.status === spec.blockedStatus ||
		Boolean(result.blocked) ||
		result.allowed === false ||
		contextBlocked;
	const allowed = result.allowed === true && !hardBlocked;
	let blockMessage = typeof result.block_message === 'string' ? result.block_message : null;
	if (blockMessage === null && contextBlocked && typeof context.block_message === 'string') {
		blockMessage = context.block_message;
	}
	return {
		allowed,
		blocked: !allowed,
		text: allowed ? (typeof filtered === 'string' ? filtered : originalText) : null,
		blockMessage,
		triggeredRules,
		jobId,
		requestId,
	};
}
