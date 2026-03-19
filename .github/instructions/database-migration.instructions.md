---
description: 'Database migration conventions for Flyway and Liquibase including naming standards, versioning, rollback strategies, Oracle-specific patterns, and data migration best practices.'
applyTo: '**/*.sql,**/db/migration/**'
---

# Database Migration Standards

## Migration Tool
- Use Flyway or Liquibase — match the project's existing tool
- Store migrations in `src/main/resources/db/migration/` (Flyway) or `db/changelog/` (Liquibase)
- Never modify an existing migration that has been applied — create a new one

## Naming Convention

### Flyway
```
V{version}__{description}.sql

Examples:
V1__create_orders_table.sql
V2__add_customer_email_column.sql
V3__create_order_items_table.sql
V4__add_index_on_order_status.sql
V5__insert_default_order_statuses.sql
```

### Versioning Rules
- Use sequential integers: V1, V2, V3...
- For team environments, use timestamp-based: V20260305120000__description.sql
- Description: lowercase, underscores, descriptive action
- One logical change per migration file

## Migration Content Structure
```sql
-- =============================================================
-- Migration: V5__add_discount_rules_table.sql
-- Description: Creates discount rules table for VIP pricing
-- Author: [name]
-- Date: [date]
-- PBI: [PBI-123]
-- =============================================================

-- Forward migration
CREATE TABLE DISCOUNT_RULES (
    ID NUMBER(19) NOT NULL,
    CUSTOMER_TYPE VARCHAR2(50) NOT NULL,
    MIN_ORDER_AMOUNT NUMBER(19,2),
    DISCOUNT_PERCENT NUMBER(5,2) NOT NULL,
    ACTIVE NUMBER(1) DEFAULT 1 NOT NULL,
    CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT PK_DISCOUNT_RULES PRIMARY KEY (ID),
    CONSTRAINT CHK_DISCOUNT_PERCENT CHECK (DISCOUNT_PERCENT BETWEEN 0 AND 100)
);

CREATE SEQUENCE DISCOUNT_RULE_SEQ START WITH 1 INCREMENT BY 1;
CREATE INDEX IDX_DISCOUNT_RULES_CUST_TYPE ON DISCOUNT_RULES(CUSTOMER_TYPE);
CREATE INDEX IDX_DISCOUNT_RULES_ACTIVE ON DISCOUNT_RULES(ACTIVE);

COMMENT ON TABLE DISCOUNT_RULES IS 'Discount rules per customer type';
COMMENT ON COLUMN DISCOUNT_RULES.CUSTOMER_TYPE IS 'Customer type: VIP, REGULAR, WHOLESALE';

-- =============================================================
-- Rollback (for reference — execute manually if needed)
-- =============================================================
-- DROP INDEX IDX_DISCOUNT_RULES_ACTIVE;
-- DROP INDEX IDX_DISCOUNT_RULES_CUST_TYPE;
-- DROP SEQUENCE DISCOUNT_RULE_SEQ;
-- DROP TABLE DISCOUNT_RULES;
```

## Oracle-Specific Rules
- Use `NUMBER(19)` for IDs (maps to Java Long)
- Use `VARCHAR2` instead of `VARCHAR`
- Use `NUMBER(1)` for boolean flags (0/1)
- Use `TIMESTAMP` for date/time columns
- Always create sequences for ID generation
- Always add indexes for foreign keys and frequently queried columns
- Use `COMMENT ON` for table and column documentation

## Best Practices

### Schema Changes
- Add columns as `NULL` first, then backfill, then add `NOT NULL` constraint (3 migrations)
- Never rename columns in production — add new, migrate data, drop old
- Always add indexes for foreign key columns
- Consider partitioning for large tables (>10M rows)

### Data Migrations
- Separate schema changes from data changes (different migration files)
- Use batched updates for large data migrations (commit every N rows)
- Log progress for long-running data migrations
- Test data migrations with production-like data volumes

### Safety
- Always include rollback SQL in comments
- Test migrations against a copy of production data
- Never use DDL and DML in the same transaction (Oracle auto-commits DDL)
- Validate foreign key constraints before adding them
- Check for locks and long-running queries before deploying migrations

### Performance
- Add indexes concurrently when possible (to avoid table locks)
- Estimate migration duration for large tables
- Schedule large migrations during maintenance windows
- Monitor tablespace usage before adding large columns
