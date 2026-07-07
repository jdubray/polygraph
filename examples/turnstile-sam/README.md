# turnstile-sam — Step 2 for SAM-pattern code

The same turnstile as `examples/turnstile/`, but built as a real
`@cognitive-fab/sam-pattern` instance and instrumented with `withSamTracing`
(`scripts/instrument/sam-emitter.mjs`). It shows how to capture
`{pre, action, data, post}` windows from SAM code with no change to the model's
behavior.

Run it (writes a scenario to an NDJSON file):

```bash
node examples/turnstile-sam/turnstile-sam.mjs traces/s1.ndjson
```

`withSamTracing(component, project, file)` prepends a capture acceptor and
appends an emit reactor to your `component`; `project(model)` returns only your
contract's observable keys. sam-pattern intents are async, so `await` each
dispatch. The action name is read from `__actionName ?? __name`, covering both
plain-function actions (name in `__name`) and `[label, fn]` tuples (library sets
`__actionName`).

The self-test (`npm test`, section 6) drives this instance, checks the emitted
windows are well-formed, chain, and record the PUSH-while-LOCKED no-op as
`post == pre`, then replays the shared `examples/turnstile` reference `next()`
against the SAM-captured corpus and confirms it scores 100%.
