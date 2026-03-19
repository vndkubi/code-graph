# API Contract: [API Name]

## Overview

| Field | Value |
|-------|-------|
| **Service** | [Service Name] |
| **Base Path** | `/api/v1/[resource]` |
| **Version** | v1 |
| **Owner** | [Team] |
| **Status** | Draft / Approved / Deprecated |

## OpenAPI Specification

```yaml
openapi: 3.0.3
info:
  title: [API Name]
  description: [Brief description]
  version: "1.0.0"
  contact:
    name: [Team Name]

servers:
  - url: /api/v1
    description: Base API path

paths:
  /[resource]:
    get:
      summary: List [resources]
      operationId: list[Resources]
      tags:
        - [Resource]
      parameters:
        - name: page
          in: query
          schema:
            type: integer
            default: 0
        - name: size
          in: query
          schema:
            type: integer
            default: 20
            maximum: 100
        - name: sort
          in: query
          schema:
            type: string
            default: "createdAt,desc"
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/[Resource]PageResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'

    post:
      summary: Create [resource]
      operationId: create[Resource]
      tags:
        - [Resource]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Create[Resource]Request'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/[Resource]Response'
          headers:
            Location:
              schema:
                type: string
              description: URI of the created resource
        '400':
          $ref: '#/components/responses/BadRequest'
        '409':
          $ref: '#/components/responses/Conflict'

  /[resource]/{id}:
    get:
      summary: Get [resource] by ID
      operationId: get[Resource]
      tags:
        - [Resource]
      parameters:
        - $ref: '#/components/parameters/ResourceId'
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/[Resource]Response'
        '404':
          $ref: '#/components/responses/NotFound'

    put:
      summary: Update [resource]
      operationId: update[Resource]
      tags:
        - [Resource]
      parameters:
        - $ref: '#/components/parameters/ResourceId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Update[Resource]Request'
      responses:
        '200':
          description: Updated
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/[Resource]Response'
        '400':
          $ref: '#/components/responses/BadRequest'
        '404':
          $ref: '#/components/responses/NotFound'
        '409':
          $ref: '#/components/responses/Conflict'

    delete:
      summary: Delete [resource]
      operationId: delete[Resource]
      tags:
        - [Resource]
      parameters:
        - $ref: '#/components/parameters/ResourceId'
      responses:
        '204':
          description: Deleted
        '404':
          $ref: '#/components/responses/NotFound'

components:
  parameters:
    ResourceId:
      name: id
      in: path
      required: true
      schema:
        type: integer
        format: int64

  schemas:
    Create[Resource]Request:
      type: object
      required:
        - name
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 255
        description:
          type: string
          maxLength: 2000
        # Add fields here

    Update[Resource]Request:
      type: object
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 255
        description:
          type: string
          maxLength: 2000
        # Add fields here

    [Resource]Response:
      type: object
      properties:
        id:
          type: integer
          format: int64
        name:
          type: string
        description:
          type: string
        status:
          $ref: '#/components/schemas/[Resource]Status'
        createdAt:
          type: string
          format: date-time
        updatedAt:
          type: string
          format: date-time

    [Resource]PageResponse:
      type: object
      properties:
        content:
          type: array
          items:
            $ref: '#/components/schemas/[Resource]Response'
        page:
          type: integer
        size:
          type: integer
        totalElements:
          type: integer
          format: int64
        totalPages:
          type: integer

    [Resource]Status:
      type: string
      enum:
        - DRAFT
        - ACTIVE
        - INACTIVE
        - ARCHIVED

    ErrorResponse:
      type: object
      properties:
        timestamp:
          type: string
          format: date-time
        status:
          type: integer
        error:
          type: string
        message:
          type: string
        path:
          type: string
        errorCode:
          type: string
          description: Machine-readable error code
        details:
          type: array
          items:
            $ref: '#/components/schemas/FieldError'

    FieldError:
      type: object
      properties:
        field:
          type: string
        message:
          type: string
        rejectedValue:
          type: string

  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    Unauthorized:
      description: Authentication required
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    Conflict:
      description: Resource conflict (duplicate, version mismatch)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
```

## API Endpoints Summary

| Method | Path | Description | Auth | Rate Limit |
|--------|------|-------------|------|-----------|
| GET | `/api/v1/[resource]` | List (paginated) | Required | 100/min |
| POST | `/api/v1/[resource]` | Create | Required | 30/min |
| GET | `/api/v1/[resource]/{id}` | Get by ID | Required | 100/min |
| PUT | `/api/v1/[resource]/{id}` | Update | Required | 30/min |
| DELETE | `/api/v1/[resource]/{id}` | Delete | Required | 10/min |

## Error Codes

| HTTP Status | Error Code | Description | Client Action |
|------------|-----------|-------------|--------------|
| 400 | `VALIDATION_ERROR` | Invalid request body/params | Fix input and retry |
| 401 | `UNAUTHORIZED` | Missing or invalid token | Re-authenticate |
| 403 | `FORBIDDEN` | Insufficient permissions | Request access |
| 404 | `NOT_FOUND` | Resource does not exist | Check ID |
| 409 | `CONFLICT` | Duplicate or version conflict | Refresh and retry |
| 429 | `RATE_LIMITED` | Too many requests | Back off and retry |
| 500 | `INTERNAL_ERROR` | Server error | Report to team |

## Versioning Strategy

- URL-based versioning: `/api/v1/`, `/api/v2/`
- Breaking changes require new version
- Non-breaking additions (new optional fields) allowed in current version
- Deprecation: minimum 2 sprints notice before removal

## Consumer Contracts

| Consumer | Integration | Notes |
|----------|------------|-------|
| [Frontend App] | REST | Uses fields: [list] |
| [Mobile App] | REST | Min version: [version] |
| [Other Service] | REST/Feign | Depends on: [fields] |
