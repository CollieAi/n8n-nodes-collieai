/**
 * The node's own error. Its message comes from a fixed vocabulary and its
 * server code is checked to be an identifier, so an error never carries the
 * API key, the checked text or a server message that might echo the text.
 */

export type CheckErrorCode =
	| 'retry_on_fail_unsupported'
	| 'invalid_base_url'
	| 'invalid_parameter'
	| 'empty_text'
	| 'unauthorized'
	| 'rejected'
	| 'rate_limited'
	| 'quota_exceeded'
	| 'server_error'
	| 'connection_error'
	| 'timeout'
	| 'job_failed'
	| 'invalid_response'
	| 'node_error';

/** What to do next, per code: the description n8n shows under the message.
 * n8n's UX guidelines: a description tells how to get unstuck, and neither it
 * nor the message uses the words error, problem, failure or mistake. */
export const NEXT_STEP: Record<CheckErrorCode, string> = {
	retry_on_fail_unsupported: "Open the node's Settings and turn off 'Retry On Fail'",
	invalid_base_url: "Correct 'Base URL' in the 'CollieAi API' credential",
	invalid_parameter: 'Correct the parameter the message names, then run the node again',
	empty_text: "Map a non-empty value to 'Text', or leave the empty items out before this node",
	unauthorized:
		"Check 'API Key' in the 'CollieAi API' credential: it must be an active key of your CollieAi project",
	rejected: "Check 'Text' and the node's parameters, then run the node again",
	rate_limited:
		"Run the workflow again in a minute, or raise 'Rate limit' in the project's settings in CollieAi",
	quota_exceeded: 'Wait until the monthly quota resets, or upgrade the plan in CollieAi',
	server_error:
		'Run the workflow again in a minute; if it repeats, send the details in parentheses to CollieAi support',
	connection_error:
		"Check 'Base URL' in the 'CollieAi API' credential and that n8n can reach it, then run the workflow again",
	timeout: "Run the workflow again; if it repeats, raise 'Timeout' in the node's options",
	job_failed:
		'Run the workflow again; if it repeats, send the details in parentheses to CollieAi support',
	invalid_response:
		'Run the workflow again; if it repeats, send the details in parentheses to CollieAi support',
	node_error: "Check the node's parameters and its 'CollieAi API' credential",
};

const SERVER_CODE = /^[a-z0-9_.-]{1,64}$/;

export class CheckError extends Error {
	readonly code: CheckErrorCode;
	readonly httpStatus?: number;
	readonly serverCode?: string;
	readonly jobId?: string;

	constructor(
		code: CheckErrorCode,
		message: string,
		details: { httpStatus?: number; serverCode?: unknown; jobId?: string } = {},
	) {
		super(message);
		this.name = 'CheckError';
		this.code = code;
		if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
		if (typeof details.serverCode === 'string' && SERVER_CODE.test(details.serverCode)) {
			this.serverCode = details.serverCode;
		}
		if (details.jobId !== undefined) this.jobId = details.jobId;
	}

	/** The error as the node puts it into an item: code and message only. */
	toJSON(): Record<string, string | number> {
		const out: Record<string, string | number> = { code: this.code, message: this.message };
		if (this.httpStatus !== undefined) out.httpStatus = this.httpStatus;
		if (this.serverCode !== undefined) out.serverCode = this.serverCode;
		if (this.jobId !== undefined) out.jobId = this.jobId;
		return out;
	}
}

interface ServerError {
	type?: string;
	code?: string;
}

/** The server's error identifiers from an OpenAI-style `{"error": {...}}` body,
 * or from FastAPI's `{"detail": {"error": {...}}}`. Never its message. */
export function serverError(body: unknown): ServerError {
	const pick = (o: unknown): ServerError | undefined => {
		if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
		const e = (o as Record<string, unknown>).error;
		if (e === null || typeof e !== 'object' || Array.isArray(e)) return undefined;
		const err = e as Record<string, unknown>;
		const out: ServerError = {};
		if (typeof err.type === 'string') out.type = err.type;
		if (typeof err.code === 'string') out.code = err.code;
		return out;
	};
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
	return pick(body) ?? pick((body as Record<string, unknown>).detail) ?? {};
}

/** A non-2xx answer as the node's error. 429 is split by the server's type:
 * the monthly quota (`billing_limit`) or the project's RPM. */
export function httpError(status: number, body: unknown, jobId?: string): CheckError {
	const server = serverError(body);
	const details = { httpStatus: status, serverCode: server.code ?? server.type, jobId };
	if (status === 401 || status === 403) {
		return new CheckError('unauthorized', 'CollieAi refused the API key', details);
	}
	if (status === 429) {
		if (server.type === 'billing_limit' || server.code === 'billing_limit') {
			return new CheckError(
				'quota_exceeded',
				"The project's monthly CollieAi quota is used up",
				details,
			);
		}
		return new CheckError(
			'rate_limited',
			"CollieAi rate-limited the request (the project's RPM)",
			details,
		);
	}
	if (status >= 500) {
		return new CheckError('server_error', `CollieAi answered HTTP ${status}`, details);
	}
	return new CheckError('rejected', `CollieAi rejected the request (HTTP ${status})`, details);
}
