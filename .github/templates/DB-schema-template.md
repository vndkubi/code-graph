# Database Schema: [Feature/Domain Name]

## Overview

| Field | Value |
|-------|-------|
| **Database** | Oracle / PostgreSQL / MySQL / SQL Server |
| **Schema** | [Schema Name] |
| **Domain** | [Business Domain] |
| **Migration Tool** | Flyway / Liquibase / Alembic / Django |
| **Version** | V[N]__[description] |

## Entity-Relationship Diagram (DBML)

```dbml
// Use https://dbdiagram.io to visualize

Table [table_name] {
  id bigint [pk, increment, note: 'Primary key']
  [field_name] varchar(255) [not null, note: '[Business meaning]']
  [field_name] varchar(50) [not null, note: '[Business meaning]']
  status varchar(20) [not null, default: 'DRAFT', note: 'Entity lifecycle status']
  [fk_field] bigint [not null, ref: > other_table.id, note: 'FK to [entity]']
  created_at timestamp [not null, default: `CURRENT_TIMESTAMP`]
  created_by varchar(100) [not null]
  updated_at timestamp [not null, default: `CURRENT_TIMESTAMP`]
  updated_by varchar(100) [not null]
  version integer [not null, default: 0, note: 'Optimistic locking']

  indexes {
    [field_name] [name: 'idx_[table]_[field]']
    ([field1], [field2]) [unique, name: 'uk_[table]_[field1]_[field2]']
    status [name: 'idx_[table]_status']
    created_at [name: 'idx_[table]_created_at']
  }

  note: '[Business description of this entity]'
}

Table [other_table] {
  id bigint [pk, increment]
  // ... fields
}

Ref: [table_name].[fk_field] > [other_table].id
```

## Tables

### [TABLE_NAME]

**Business Purpose:** [What this table stores and why]

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | BIGINT | NO | sequence | Primary key |
| `[column]` | VARCHAR(255) | NO | — | [Business meaning] |
| `[column]` | VARCHAR(20) | NO | 'DRAFT' | Status: [list values] |
| `[fk_column]` | BIGINT | NO | — | FK → [table.column] |
| `created_at` | TIMESTAMP | NO | CURRENT_TIMESTAMP | Record creation time |
| `created_by` | VARCHAR(100) | NO | — | Creator user ID |
| `updated_at` | TIMESTAMP | NO | CURRENT_TIMESTAMP | Last update time |
| `updated_by` | VARCHAR(100) | NO | — | Last updater user ID |
| `version` | INTEGER | NO | 0 | Optimistic lock version |

**Constraints:**
| Type | Name | Columns | Details |
|------|------|---------|---------|
| PK | `pk_[table]` | `id` | — |
| FK | `fk_[table]_[ref]` | `[fk_column]` | → `[ref_table].id` |
| UQ | `uk_[table]_[fields]` | `[columns]` | Business uniqueness |
| CK | `ck_[table]_[field]` | `[column]` | `IN ('VALUE1','VALUE2')` |

**Indexes:**
| Name | Columns | Type | Rationale |
|------|---------|------|-----------|
| `idx_[table]_[field]` | `[column]` | B-Tree | [Query pattern it supports] |
| `idx_[table]_status` | `status` | B-Tree | Status filter queries |
| `idx_[table]_created` | `created_at` | B-Tree | Date range queries |

### [NEXT TABLE]
<!-- Repeat structure for each table -->

## Relationships

| Parent | Child | Cardinality | FK Column | On Delete |
|--------|-------|-------------|-----------|-----------|
| [table] | [table] | 1:N | `[fk_column]` | RESTRICT / CASCADE |
| [table] | [table] | M:N | junction table | CASCADE |

## Status/Enum Values

### [Entity]Status

| Value | Description | Transitions From | Transitions To |
|-------|-------------|-----------------|----------------|
| DRAFT | Initial state | — | SUBMITTED |
| SUBMITTED | Awaiting approval | DRAFT | APPROVED, REJECTED |
| APPROVED | Approved | SUBMITTED | ACTIVE |
| REJECTED | Rejected | SUBMITTED | DRAFT |
| ACTIVE | Currently active | APPROVED | INACTIVE, ARCHIVED |
| INACTIVE | Temporarily disabled | ACTIVE | ACTIVE, ARCHIVED |
| ARCHIVED | Permanently archived | ACTIVE, INACTIVE | — |

## Migration Scripts

### V[N]__[description].sql

```sql
-- Forward migration
CREATE TABLE [table_name] (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    [column]    VARCHAR(255) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    [fk_col]   BIGINT NOT NULL REFERENCES [other_table](id),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by  VARCHAR(100) NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  VARCHAR(100) NOT NULL,
    version     INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT ck_[table]_status CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','ACTIVE','INACTIVE','ARCHIVED'))
);

CREATE INDEX idx_[table]_status ON [table_name](status);
CREATE INDEX idx_[table]_[fk] ON [table_name]([fk_col]);
CREATE INDEX idx_[table]_created ON [table_name](created_at);
```

### V[N]__[description]_rollback.sql

```sql
-- Rollback migration
DROP TABLE IF EXISTS [table_name];
```

## Data Volumes & Performance

| Table | Expected Rows (1yr) | Growth Rate | Partition Strategy |
|-------|--------------------|-----------:|-------------------|
| [table] | [estimate] | [N]/day | [None / Date / Range] |

## Notes

- [Any Oracle-specific syntax notes: sequences, hints, materialized views]
- [Any data migration considerations]
- [Any cross-schema dependency notes]
