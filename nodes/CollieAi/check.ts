/**
 * One check: create a job, poll it, read the verdict. The transport of the
 * Node SDK's `moderation.input` / `moderation.output` (node/src/moderation.ts
 * in CollieAi/collieai-sdk), without its dependencies:
 *
 * - the create `POST` is one attempt under its own request timeout; any
 *   error of it, 429 included, is the check's error (the job may exist, and a
 *   repeat would be a second billed call);
 * - the poll budget starts once the job exists; the pacing is the Poll
 *   Backoff Contract (`pacing.ts`, a byte copy of the SDK's);
 * - on the poll `GET`, a 429 is paced, a network error or 5xx is an error;
 * - each request ends at its deadline even if the transport ignores the
 *   signal (`untilAborted`);
 * - an answer that lands at or after the deadline is not accepted.
 *
 * Every failure is returned as a `CheckError`, never thrown: the node turns
 * it into n8n's own error or into a blocked item (CollieAi.node.ts).
 *
 * HTTP, sleeping and the clocks are injected, so the n8n glue stays thin and
 * the flow is tested without n8n.
 */

import { CheckError, httpError } from './errors';
import { PollPacer } from './pacing';
import { FAILED_STATUSES, PHASES, toCheckResult, type CheckResult, type Phase } from './verdict';

export interface HttpRequest {
	method: 'GET' | 'POST';
	path: string;
	body?: Record<string, unknown>;
	/** The `X-CollieAi-SDK-Origin` header value. */
	origin: string;
	timeoutMs: number;
	abortSignal: AbortSignal;
}

export interface HttpResponse {
	statusCode: number;
	headers: Record<string, unknown>;
	body: unknown;
}

export interface CheckDeps {
	/** Resolves with any HTTP status; rejects only when no answer came. */
	request(req: HttpRequest): Promise<HttpResponse>;
	sleep(seconds: number): Promise<void>;
	/** Seconds from a monotonic clock. */
	monotonic(): number;
	/** Uniform in [0, 1). */
	rand(): number;
	/** A signal that aborts after the given seconds: `deadlineSignal` of the
	 * pacer in the node, a controllable one in tests. */
	deadline(seconds: number): AbortSignal;
}

export interface CheckParams {
	phase: Phase;
	text: string;
	conversationId: string;
	/** The poll budget, seconds. */
	timeoutS: number;
	includeMatchDetails: boolean;
}

/** The create request's own timeout, as the SDK's default request timeout. */
export const REQUEST_TIMEOUT_S = 30;
/** The SDK's default poll interval. */
export const POLL_INTERVAL_S = 0.05;

export const ORIGINS: Record<Phase, string> = {
	input: 'n8n.check_input',
	output: 'n8n.check_output',
};

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One response header, by its lower-case name (n8n's HTTP client lowers them). */
export function header(headers: Record<string, unknown>, name: string): string | null {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		if (typeof value === 'string') return value;
		if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
	}
	return null;
}

/** RFC 9110 delay-seconds only, as the SDK: anything else is no usable header. */
export function retryAfterSeconds(headers: Record<string, unknown>): number | null {
	const v = header(headers, 'retry-after');
	if (v === null || !/^\d+$/.test(v)) return null;
	return Number(v);
}

/**
 * The request's answer, or its signal's abort, whichever comes first. n8n's
 * authenticated helper replaces a request's own signal with the execution's
 * cancel signal (n8n-core 2.46 to 3.1, `httpRequestWithAuthentication`), and
 * its timeout bounds only a silent connection, so the deadline cannot rest on
 * the transport. A late answer is dropped.
 */
export async function untilAborted<T>(answer: Promise<T>, signal: AbortSignal): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new CheckError('timeout', 'The request ran out of time'));
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort);
		answer.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

export async function runCheck(
	deps: CheckDeps,
	params: CheckParams,
): Promise<CheckResult | CheckError> {
	if (params.text === '') {
		return new CheckError('empty_text', 'Text is empty: there is nothing to check');
	}
	try {
		PollPacer.validate(POLL_INTERVAL_S, params.timeoutS);
	} catch {
		return new CheckError('invalid_parameter', 'Timeout must be a positive number of seconds');
	}

	const body: Record<string, unknown> =
		params.phase === 'input'
			? { message_input: params.text, inbound_only: true }
			: { message_output: params.text };
	if (params.conversationId !== '') body.conversation_id = params.conversationId;
	const origin = ORIGINS[params.phase];

	const createSignal = deps.deadline(REQUEST_TIMEOUT_S);
	let created: HttpResponse;
	try {
		created = await untilAborted(
			deps.request({
				method: 'POST',
				path: '/v1/jobs',
				body,
				origin,
				timeoutMs: REQUEST_TIMEOUT_S * 1000,
				abortSignal: createSignal,
			}),
			createSignal,
		);
	} catch {
		if (createSignal.aborted) {
			return new CheckError('timeout', `CollieAi did not answer within ${REQUEST_TIMEOUT_S} s`);
		}
		return new CheckError('connection_error', 'Could not reach CollieAi');
	}
	if (created.statusCode < 200 || created.statusCode >= 300) {
		return httpError(created.statusCode, created.body);
	}
	const jobId = isObject(created.body) ? created.body.job_id : undefined;
	if (typeof jobId !== 'string' || jobId === '') {
		return new CheckError('invalid_response', 'CollieAi did not return a job id');
	}
	const requestId = header(created.headers, 'x-request-id');

	const spec = PHASES[params.phase];
	const pacer = new PollPacer({
		intervalS: POLL_INTERVAL_S,
		timeoutS: params.timeoutS,
		monotonic: deps.monotonic,
		rand: deps.rand,
	});
	const timedOut = () =>
		new CheckError('timeout', `No verdict within ${params.timeoutS} s`, { jobId });

	for (;;) {
		const remaining = pacer.remaining();
		if (remaining <= 0) return timedOut();
		const signal = deps.deadline(remaining);
		let polled: HttpResponse;
		try {
			polled = await untilAborted(
				deps.request({
					method: 'GET',
					path: `/v1/jobs/${encodeURIComponent(jobId)}`,
					origin,
					timeoutMs: Math.ceil(remaining * 1000),
					abortSignal: signal,
				}),
				signal,
			);
		} catch {
			if (signal.aborted || pacer.remaining() <= 0) return timedOut();
			return new CheckError('connection_error', 'Lost the connection to CollieAi', { jobId });
		}
		// Strict acceptance: an answer that landed at or after the deadline
		// is not a verdict.
		if (pacer.remaining() <= 0) return timedOut();

		if (polled.statusCode === 429) {
			const sleepS = pacer.sleepFor429(retryAfterSeconds(polled.headers));
			if (sleepS === null) return httpError(429, polled.body, jobId);
			await deps.sleep(sleepS);
			continue;
		}
		if (polled.statusCode < 200 || polled.statusCode >= 300) {
			return httpError(polled.statusCode, polled.body, jobId);
		}
		if (!isObject(polled.body)) {
			return new CheckError('invalid_response', 'CollieAi returned a malformed result', { jobId });
		}
		const status = polled.body.status;
		if (typeof status === 'string' && spec.verdictStatuses.has(status)) {
			return toCheckResult(
				params.phase,
				params.text,
				jobId,
				requestId,
				polled.body,
				params.includeMatchDetails,
			);
		}
		if (typeof status === 'string' && FAILED_STATUSES.has(status)) {
			return new CheckError('job_failed', `The check ended as '${status}' without a verdict`, {
				jobId,
			});
		}
		await deps.sleep(pacer.nextSleep(polled.body.suggested_poll_ms));
	}
}
