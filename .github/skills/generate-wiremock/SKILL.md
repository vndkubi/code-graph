---
name: generate-wiremock
description: 'Generate WireMock stub configurations and response files by analyzing external HTTP service calls in the codebase. Learns existing WireMock patterns and conventions, creates mappings for success, error, and timeout scenarios with response templating. Supports stateful scenarios for multi-step workflows and devcontainer integration. Use when asked to create mock data, add WireMock stubs, or set up local service mocking.'
---

# Generate WireMock Stubs

Create WireMock mappings and response files by learning from codebase patterns.

## When to Use

- Adding mocks for a new external service call
- Setting up local development environment with mocked dependencies
- Creating integration test fixtures
- Updating stubs for changed external APIs

## Workflow

### Step 1: Discover External Calls

Search the codebase for HTTP client usage:
- `HttpClient`, `WebClient`, `RestTemplate`
- JAX-RS Client: `ClientBuilder.newClient()`, `@RegisterRestClient`
- Feign clients: `@FeignClient`
- Configuration files with external URLs

For each call, identify:
- HTTP method and URL pattern
- Request headers (especially Authorization, Content-Type)
- Request body format
- Expected response format and status codes

### Step 2: Learn Existing Patterns

If the project already has WireMock stubs:
- Read `src/test/resources/wiremock/mappings/` for mapping format
- Read `src/test/resources/__files/` for response body format
- Learn naming conventions, organization, and shared patterns
- Match the exact JSON structure and style

### Step 3: Create Stub Files

For each external service call, create:

**Mapping file** (`mappings/[service]/[scenario].json`):
```json
{
  "request": {
    "method": "GET",
    "urlPathPattern": "/api/v1/resource/[0-9]+",
    "headers": { "Accept": { "contains": "application/json" } }
  },
  "response": {
    "status": 200,
    "headers": { "Content-Type": "application/json" },
    "bodyFileName": "[service]/[response-file].json"
  },
  "metadata": { "description": "[Clear description]" }
}
```

**Response file** (`__files/[service]/[response-file].json`):
```json
{ "id": 1, "name": "Test", ... }
```

### Step 4: Create All Scenarios

For each service call:
- ✅ Success (200/201)
- ❌ Not Found (404)
- ❌ Validation Error (400/422)
- ❌ Server Error (500)
- ⏱️ Timeout (delay + 200)
- 📭 Empty response (200 with empty body/array)

### Step 5: Docker Compose Integration

If docker-compose exists, add WireMock service:
```yaml
wiremock:
  image: wiremock/wiremock:latest
  ports: ["8081:8080"]
  volumes: ["./src/test/resources/wiremock:/home/wiremock"]
  command: --verbose --global-response-templating
```

## Validation

- [ ] All external service calls have corresponding stubs
- [ ] Each stub has metadata.description
- [ ] Success AND error scenarios covered
- [ ] Response data matches actual API contract
- [ ] Stubs organized by service subdirectory
