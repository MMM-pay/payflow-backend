# @mmm-pay/payflow-client

Typed, dependency-free client for the [Payflow](https://github.com/MMM-pay/payflow-backend)
REST API.

The response types are the same declarations the backend route handlers use,
so the client cannot drift from the API. Amounts are always decimal strings in
the token's smallest unit; the client never converts money to a JavaScript
number.

## Install

```bash
npm install @mmm-pay/payflow-client
```

## Quick start

```ts
import { PayflowClient, PayflowApiError } from "@mmm-pay/payflow-client";

async function main() {
  const api = new PayflowClient("https://payflow-backend.onrender.com");

  const { plans } = await api.plans();
  if (plans.length > 0) {
    const plan = await api.plan(plans[0]!.id);
    console.log(plan.name, plan.amount);
  }

  try {
    await api.plan(999);
  } catch (err) {
    if (err instanceof PayflowApiError && err.status === 404) {
      console.error("no such plan", err.body);
    }
  }
}

void main();
```

Pass a `fetch` implementation to `PayflowClient` when the runtime does not
provide one, or to stub requests in tests:

```ts
const api = new PayflowClient({ baseUrl: "http://localhost:8080", fetch: myFetch });
```

## Endpoints

`health`, `plans`, `plan`, `planStats`, `mandates`, `mandate`, `charges`,
`due`, `merchantSummary`, `merchantForecast`, `merchantSubscribers`,
`merchantChurn`, `merchantRevenue`, `subscriberSummary`, `stats`, `protocol`,
`vault`, `vaultEvents`, and `keeper`.

## Requirements

Node.js 18 or newer, or any runtime with a global `fetch`. The package has no
runtime dependencies.

## License

Apache-2.0.
