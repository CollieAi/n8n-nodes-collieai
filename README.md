# CollieAi node for n8n

An [n8n](https://n8n.io) community node that checks text against your
[CollieAi](https://collieai.io) project's policy: a user's message before it
reaches the model, and the model's reply before it reaches the user. Prompt
injection, PII, secrets, unsafe output and the other rules of the policy run
on CollieAi's side; the node tells the workflow whether the text may go on,
and gives back the masked text when a rule masked it.

You need a CollieAi project and its API key (`clai_…`). Sign up at
[app.collieai.io](https://app.collieai.io): the first visit to **Get Started**
sets up a project with the Starter policy and a key. The Starter policy starts
in Monitor, where rules only log: nothing is blocked or masked until you
switch the policy to Enforce on the **Policies** page.

- [Install](#install)
- [Credentials](#credentials)
- [Operations](#operations)
- [Output](#output)
- [Branching](#branching)
- [Errors](#errors)
- [Limits](#limits)
- [CollieAi or n8n's Guardrails node?](#collieai-or-n8ns-guardrails-node)

## Install

In n8n: **Settings → Community Nodes → Install**, package
`@collieai/n8n-nodes-collieai`. See n8n's
[guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

Create a **CollieAi API** credential:

| Field | Value |
|---|---|
| API Key | Your project's key, `clai_…` |
| Base URL | `https://app.collieai.io`. Change it only for a dedicated CollieAi host |

The key is sent over `https://` only, `http://` only on `localhost`, and only
to the Base URL's host: saving the credential with any other Base URL fails
before the key leaves n8n. Saving it checks the key against your project.

If your CollieAi account has an IP allowlist, add n8n's outgoing addresses
to it.

## Operations

| Operation | Checks | Against |
|---|---|---|
| **Check Input** | a user's message, before the model | the project's Input rules |
| **Check Output** | the model's reply, before the user | the project's Output rules |

| Parameter | |
|---|---|
| Text | The text to check. An empty text is an error |
| Conversation ID | Optional. Groups the turns of one conversation in CollieAi Logs, for example the Chat Trigger's `sessionId` |
| Options → Timeout | Seconds to wait for the verdict once the check is created. Default 30 |
| Options → Include Match Details | Adds each rule's match details. Off by default: for pattern rules they hold the matched text, which n8n keeps in its execution history |

Each check is one call against your plan's monthly quota: checking a turn
with both operations costs two.

## Output

Every input item comes out once, with its own fields and a `collieai`
object:

```json
{
  "collieai": {
    "allowed": true,
    "blocked": false,
    "text": "Call me at [PHONE]",
    "blockMessage": null,
    "triggeredRules": [
      { "ruleId": "…", "ruleName": "PII", "ruleType": "pii", "decision": "mask", "monitoring": false }
    ],
    "jobId": "…",
    "requestId": null
  }
}
```

| Field | |
|---|---|
| `allowed` | `true` only when the policy lets the text through |
| `blocked` | `true` when it does not, or when the answer was ambiguous |
| `text` | The text to pass on: masked when a rule masked it, else the original. `null` when blocked |
| `blockMessage` | The rule's message for the user, when one blocked |
| `triggeredRules` | The rules that matched. A rule in Monitor has `monitoring: true` and does not block |
| `jobId` | The check's ID in CollieAi Logs; give it to CollieAi support |
| `requestId` | `null`: CollieAi does not return a request ID for checks yet |

Pass `collieai.text` on, not the original text: it is the one the policy
masked.

## Branching

Add an **IF** node after CollieAi and branch on `{{ $json.collieai.allowed }}`
being `true` (boolean). Do not branch on `collieai.blocked`: an item without
the `collieai` object must never count as allowed.

A typical chat workflow:

```
Chat Trigger → CollieAi (Check Input) → IF allowed → AI Agent → CollieAi (Check Output) → IF allowed → reply
                                         └ else → reply with collieai.blockMessage       └ else → reply with collieai.blockMessage
```

If the agent's model already goes through CollieAi (its credential's Base URL
pointed at CollieAi), the same policy checks each turn twice, and a block
there is an error of the AI Agent node, which stops the workflow. Use one of
the two, or set the AI Agent's On Error to handle it.

## Errors

A check that cannot be made never comes out as allowed. What happens is
n8n's **On Error** setting of the node:

| On Error | What you get |
|---|---|
| Stop Workflow (default) | The workflow stops with the error |
| Continue | The item comes out blocked: `allowed: false`, `blocked: true`, and `collieai.error` with a `code` and a `message` |
| Continue (using error output) | The item goes to the error output; n8n replaces its fields with the error message |

The error never carries your API key or the checked text.

**Turn Retry On Fail off for this node.** n8n's Retry On Fail re-runs every
item of the node, so each retry would create new, billed checks. The node
refuses to run with it on. It does not repeat a check itself either: a check
that got no answer may still have been made.

A check is one request to create it and a few to read the verdict, paced by
CollieAi's hints. A `429` while reading is waited out; a `429` when creating
is an error: your project's rate limit (off by default) or its monthly
quota.

## Limits

- The node sees only the text you give it. The system prompt, memory and
  tool results inside an AI Agent are not checked by it.
- Output is checked once the model's reply is complete; there is no
  streaming check.
- n8n keeps a workflow's data in its execution history, the original text
  included, before the node runs. Masking further down the workflow does
  not remove it there.
- Items are checked one after another within an execution. Parallel
  executions run their checks at the same time; your project's rate limit,
  if set, applies to them together.

## CollieAi or n8n's Guardrails node?

n8n's Guardrails node runs its checks inside the workflow, set up node by
node, with your own chat model for the LLM-based ones. CollieAi keeps one
policy per project that every integration applies — this node, the
OpenAI-compatible proxy, the SDKs and LiteLLM — records each check in
CollieAi Logs, and lets you try a rule in Monitor before it blocks.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as
[SECURITY.md](SECURITY.md) says.

## License

[MIT](LICENSE)
