---
description: 'WireMock stub configuration standards for HTTP service mocking in integration tests and local development.'
applyTo: '**/wiremock/**/*.json'
---

# WireMock Stub Standards

## Required Fields

```json
// ✅ Always include metadata.description
{
  "metadata": {
    "description": "Get customer by ID - success response"
  },
  "request": {
    "method": "GET",
    "urlPathPattern": "/api/v1/customers/[0-9]+"
  },
  "response": {
    "status": 200,
    "headers": {
      "Content-Type": "application/json"
    },
    "bodyFileName": "customer-service/customer-response.json"
  }
}

// ❌ Missing description
{
  "request": { "method": "GET", "url": "/api/customers/1" },
  "response": { "status": 200, "body": "{}" }
}
```

## URL Matching

```json
// ✅ Use urlPathPattern for flexible matching with regex
"urlPathPattern": "/api/v1/orders/[0-9]+"

// ✅ Use urlPath for exact match
"urlPath": "/api/v1/orders"

// ✅ Use queryParameters for query string matching
"queryParameters": {
  "status": { "equalTo": "PENDING" },
  "page": { "matches": "[0-9]+" }
}

// ❌ Avoid hardcoded URLs with specific IDs
"url": "/api/v1/orders/12345"
```

## Header Matching

```json
// ✅ Match required headers
"headers": {
  "Accept": {
    "contains": "application/json"
  },
  "Authorization": {
    "matches": "Bearer .*"
  }
}
```

## Priority

```json
// ✅ Use priority for overlapping patterns (lower number = higher priority)
{
  "priority": 1,
  "request": { "method": "GET", "urlPath": "/api/v1/customers/99999" },
  "response": { "status": 404 }
}
// Catches all other customer IDs with lower priority
{
  "priority": 5,
  "request": { "method": "GET", "urlPathPattern": "/api/v1/customers/[0-9]+" },
  "response": { "status": 200 }
}
```

## Response Templating

```json
// ✅ Use response-template for dynamic responses
{
  "response": {
    "status": 200,
    "headers": { "Content-Type": "application/json" },
    "jsonBody": {
      "id": "{{request.pathSegments.[3]}}",
      "timestamp": "{{now format='yyyy-MM-dd HH:mm:ss'}}",
      "requestId": "{{randomValue type='UUID'}}"
    },
    "transformers": ["response-template"]
  }
}
```

## Organization

```
wiremock/
├── mappings/
│   ├── customer-service/
│   │   ├── get-customer-success.json
│   │   ├── get-customer-not-found.json
│   │   └── create-customer-success.json
│   └── payment-service/
│       ├── process-payment-success.json
│       └── process-payment-declined.json
└── __files/
    ├── customer-service/
    │   └── customer-response.json
    └── payment-service/
        └── payment-response.json
```

## Scenario Coverage

For each external service endpoint, create stubs for:
- ✅ **Success** — 200/201 with realistic response body
- ❌ **Not Found** — 404 with error message
- ❌ **Validation Error** — 400/422 with error details
- ❌ **Server Error** — 500 with error response
- ⏱️ **Timeout** — 200 with `"fixedDelayMilliseconds": 5000`
- 📭 **Empty** — 200 with empty body or empty array

## Stateful Scenarios

```json
// ✅ Use scenarios for multi-step workflows
{
  "scenarioName": "Order Lifecycle",
  "requiredScenarioState": "Started",
  "newScenarioState": "Order Created",
  "request": { "method": "POST", "urlPath": "/api/v1/orders" },
  "response": { "status": 201, "jsonBody": { "id": 1, "status": "CREATED" } }
}
```
