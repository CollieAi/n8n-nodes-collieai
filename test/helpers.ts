import type { CheckDeps, HttpRequest, HttpResponse } from '../nodes/CollieAi/check';

export type Step =
	| HttpResponse
	| { reject: true; abort?: boolean; advanceS?: number }
	| { respond: HttpResponse; advanceS: number };

export function json(statusCode: number, body: unknown, headers: Record<string, unknown> = {}) {
	return { statusCode, headers, body };
}

export function job(status: string, phaseResult?: Record<string, unknown>, extra = {}) {
	const body: Record<string, unknown> = { job_id: 'job-1', status, ...extra };
	if (phaseResult !== undefined) {
		body.inbound_result = phaseResult;
		body.outbound_result = phaseResult;
	}
	return json(200, body);
}

export const ALLOWED = {
	allowed: true,
	blocked: false,
	filtered_content: null,
	block_message: null,
	triggered_rules: [],
};

/** Each request takes this long on the manual clock, as a real one does: the
 * pacer's last sleeps before the deadline can be shorter than the clock's
 * resolution, and only the requests' own time moves the clock past them. */
export const RTT_S = 0.001;

/**
 * Scripted HTTP plus a manual clock: `sleep` advances the clock, a request
 * advances it by RTT_S or by its step's own time (a slow answer), and
 * `deadline` hands out signals the script can abort.
 */
export function fakeDeps(steps: Step[]) {
	const requests: HttpRequest[] = [];
	const sleeps: number[] = [];
	const signals: AbortController[] = [];
	let now = 1000;
	const deps: CheckDeps = {
		request: async (req) => {
			requests.push(req);
			now += RTT_S;
			const step = steps.shift();
			if (step === undefined) throw new Error(`no scripted answer for request ${requests.length}`);
			if ('reject' in step) {
				if (step.abort) signals[signals.length - 1].abort();
				now += step.advanceS ?? 0;
				throw new Error('socket hang up');
			}
			if ('respond' in step) {
				now += step.advanceS;
				return step.respond;
			}
			return step;
		},
		sleep: async (seconds) => {
			sleeps.push(seconds);
			now += seconds;
		},
		monotonic: () => now,
		rand: () => 0.5,
		deadline: () => {
			const controller = new AbortController();
			signals.push(controller);
			return controller.signal;
		},
	};
	return { deps, requests, sleeps, left: () => steps.length };
}
