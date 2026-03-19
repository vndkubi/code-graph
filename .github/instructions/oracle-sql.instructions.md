---
description: 'Oracle Database SQL coding standards including sequences, indexes, pagination, and query optimization.'
applyTo: '**/*.sql'
---

# Oracle SQL Coding Standards

## Formatting

- **UPPERCASE** SQL keywords: `SELECT`, `FROM`, `WHERE`, `JOIN`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`
- Consistent indentation for multi-line queries
- One clause per line for readability

```sql
-- ✅ Readable formatting
SELECT o.ID,
       o.STATUS,
       o.TOTAL,
       c.NAME AS CUSTOMER_NAME
  FROM ORDERS o
  JOIN CUSTOMERS c ON c.ID = o.CUSTOMER_ID
 WHERE o.STATUS = :status
   AND o.CREATED_AT >= :startDate
 ORDER BY o.CREATED_AT DESC;
```

## Sequences

```sql
-- ✅ Use sequences for primary key generation
CREATE SEQUENCE ORDER_SEQ START WITH 1 INCREMENT BY 1;

-- ✅ Usage
INSERT INTO ORDERS (ID, CUSTOMER_ID, STATUS, CREATED_AT)
VALUES (ORDER_SEQ.NEXTVAL, :customerId, 'CREATED', SYSTIMESTAMP);
```

## Timestamps

```sql
-- ✅ Use SYSTIMESTAMP for precision timestamps
CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP

-- ✅ Use SYSDATE when date-only is sufficient
CREATED_DATE DATE DEFAULT SYSDATE
```

## Null Handling

```sql
-- ✅ Use NVL for simple default
SELECT NVL(DISCOUNT, 0) AS DISCOUNT FROM ORDERS;

-- ✅ Use NVL2 for conditional on null
SELECT NVL2(DISCOUNT, TOTAL - DISCOUNT, TOTAL) AS FINAL_PRICE FROM ORDERS;

-- ✅ Use COALESCE for multiple fallbacks
SELECT COALESCE(PREFERRED_NAME, FIRST_NAME, 'Unknown') AS DISPLAY_NAME FROM CUSTOMERS;
```

## Indexes

```sql
-- ✅ Create indexes on foreign key columns
CREATE INDEX IDX_ORDER_CUSTOMER ON ORDERS(CUSTOMER_ID);

-- ✅ Create indexes on frequently queried columns
CREATE INDEX IDX_ORDER_STATUS ON ORDERS(STATUS);
CREATE INDEX IDX_ORDER_CREATED ON ORDERS(CREATED_AT);

-- ✅ Composite index for common query patterns
CREATE INDEX IDX_ORDER_STATUS_DATE ON ORDERS(STATUS, CREATED_AT);

-- ❌ Don't create indexes on low-cardinality columns
CREATE INDEX IDX_ORDER_ACTIVE ON ORDERS(IS_ACTIVE); -- only TRUE/FALSE, not selective
```

## Pagination

```sql
-- ✅ Modern Oracle (12c+): FETCH FIRST / OFFSET
SELECT ID, STATUS, TOTAL
  FROM ORDERS
 ORDER BY CREATED_AT DESC
OFFSET :offset ROWS FETCH FIRST :pageSize ROWS ONLY;

-- ✅ Legacy Oracle: ROWNUM
SELECT * FROM (
    SELECT a.*, ROWNUM rn FROM (
        SELECT ID, STATUS, TOTAL
          FROM ORDERS
         ORDER BY CREATED_AT DESC
    ) a WHERE ROWNUM <= :endRow
) WHERE rn > :startRow;
```

## Bind Variables

```sql
-- ✅ Always use bind variables
SELECT * FROM ORDERS WHERE STATUS = :status AND CUSTOMER_ID = :customerId;

-- ❌ NEVER concatenate values (SQL injection risk + hard parse)
SELECT * FROM ORDERS WHERE STATUS = '" + status + "';
```

## Query Optimization

```sql
-- ✅ Select only needed columns
SELECT ID, STATUS, CREATED_AT FROM ORDERS WHERE STATUS = :status;

-- ❌ Avoid SELECT * in production queries
SELECT * FROM ORDERS;

-- ✅ Use EXPLAIN PLAN to verify execution plan
EXPLAIN PLAN FOR
SELECT o.ID, o.TOTAL
  FROM ORDERS o
  JOIN CUSTOMERS c ON c.ID = o.CUSTOMER_ID
 WHERE o.STATUS = 'PENDING';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);

-- ✅ Use optimizer hints when needed
SELECT /*+ INDEX(o IDX_ORDER_STATUS) */ o.ID, o.TOTAL
  FROM ORDERS o
 WHERE o.STATUS = 'PENDING';
```

## Migration Scripts

```sql
-- ✅ Structure: version prefix + description
-- V1__create_orders_table.sql
-- V2__add_order_discount_column.sql

-- ✅ Always include rollback at bottom as comments
CREATE TABLE ORDERS (
    ID           NUMBER(19)    NOT NULL,
    CUSTOMER_ID  NUMBER(19)    NOT NULL,
    STATUS       VARCHAR2(50)  NOT NULL,
    TOTAL        NUMBER(19,2)  DEFAULT 0,
    CREATED_AT   TIMESTAMP     DEFAULT SYSTIMESTAMP,
    UPDATED_AT   TIMESTAMP     DEFAULT SYSTIMESTAMP,
    CONSTRAINT PK_ORDERS PRIMARY KEY (ID),
    CONSTRAINT FK_ORDERS_CUSTOMER FOREIGN KEY (CUSTOMER_ID) REFERENCES CUSTOMERS(ID)
);

CREATE SEQUENCE ORDER_SEQ START WITH 1 INCREMENT BY 1;
CREATE INDEX IDX_ORDER_CUSTOMER ON ORDERS(CUSTOMER_ID);
CREATE INDEX IDX_ORDER_STATUS ON ORDERS(STATUS);

-- Rollback:
-- DROP INDEX IDX_ORDER_STATUS;
-- DROP INDEX IDX_ORDER_CUSTOMER;
-- DROP SEQUENCE ORDER_SEQ;
-- DROP TABLE ORDERS;
```

## Stored Procedures

```sql
-- ✅ Use packages for grouping related procedures
CREATE OR REPLACE PACKAGE ORDER_PKG AS
    PROCEDURE CREATE_ORDER(
        p_customer_id IN NUMBER,
        p_status      IN VARCHAR2,
        p_order_id    OUT NUMBER
    );
END ORDER_PKG;
/

-- ✅ Exception handling in procedures
CREATE OR REPLACE PACKAGE BODY ORDER_PKG AS
    PROCEDURE CREATE_ORDER(
        p_customer_id IN NUMBER,
        p_status      IN VARCHAR2,
        p_order_id    OUT NUMBER
    ) IS
    BEGIN
        SELECT ORDER_SEQ.NEXTVAL INTO p_order_id FROM DUAL;
        INSERT INTO ORDERS (ID, CUSTOMER_ID, STATUS, CREATED_AT)
        VALUES (p_order_id, p_customer_id, p_status, SYSTIMESTAMP);
    EXCEPTION
        WHEN OTHERS THEN
            RAISE_APPLICATION_ERROR(-20001, 'Failed to create order: ' || SQLERRM);
    END CREATE_ORDER;
END ORDER_PKG;
/
```
