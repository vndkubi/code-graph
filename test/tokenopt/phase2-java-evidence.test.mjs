import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assembleSpringContext } from "../../dist/tokenopt/assemblers/spring-context-assembler.js";
import { filterJakartaAnnotations } from "../../dist/tokenopt/filters/jakarta-annotation-filter.js";
import { prepareJavaDiff } from "../../dist/tokenopt/processors/java-diff-processor.js";

test("Java diff processor classifies semantic Java review hints", () => {
  const summary = prepareJavaDiff([
    "diff --git a/src/main/java/com/acme/OrderService.java b/src/main/java/com/acme/OrderService.java",
    "--- a/src/main/java/com/acme/OrderService.java",
    "+++ b/src/main/java/com/acme/OrderService.java",
    "@@ -1,6 +1,9 @@",
    "-import lombok.Getter;",
    "+import lombok.Setter;",
    "+import jakarta.transaction.Transactional;",
    " public class OrderService {",
    "+  @Transactional",
    "+  public Order approve(Order order) { return order.approve(); }",
    " }"
  ].join("\n"));

  assert.equal(summary.changedFiles.length, 1);
  assert.equal(summary.categories["lombok-change"], 1);
  assert.equal(summary.categories["transaction-boundary"], 1);
  assert.equal(summary.categories["business-logic"], 1);
  assert.equal(summary.impactedSymbols.includes("approve"), true);
  assert.equal(summary.likelyTests.some((file) => file.endsWith("OrderServiceTest.java")), true);
});

test("Jakarta annotation filter collapses Lombok but preserves Jakarta/JPA annotations", () => {
  const result = filterJakartaAnnotations([
    "@Entity",
    "@Table(name = \"orders\")",
    "@Getter",
    "@Setter",
    "@EqualsAndHashCode",
    "public class OrderEntity {}"
  ].join("\n"));

  assert.match(result.text, /@Entity/);
  assert.match(result.text, /@Table/);
  assert.match(result.text, /\[Lombok: @Getter, @Setter, @EqualsAndHashCode\]/);
  assert.doesNotMatch(result.text, /^@Getter$/m);
  assert.equal(result.collapsedGroups, 1);
});

test("Spring context assembler extracts high-signal bean slices", () => {
  const assembly = assembleSpringContext(JSON.stringify({
    contexts: {
      application: {
        beans: {
          orderController: {
            type: "com.acme.web.OrderController",
            dependencies: ["orderService"]
          },
          orderService: {
            type: "com.acme.service.OrderService",
            dependencies: ["orderRepository", "transactionManager"]
          },
          orderRepository: {
            type: "com.acme.data.OrderRepository",
            dependencies: ["dataSource"]
          },
          securityFilterChain: {
            type: "org.springframework.security.web.SecurityFilterChain",
            dependencies: []
          },
          jmsListener: {
            type: "com.acme.messaging.OrderJmsListener",
            dependencies: ["orderService"]
          },
          transactionManager: {
            type: "org.springframework.transaction.PlatformTransactionManager",
            dependencies: ["dataSource"]
          }
        }
      }
    }
  }));

  assert.equal(assembly.beanCount, 6);
  assert.equal(assembly.entryPoints.some((bean) => bean.name === "orderController"), true);
  assert.equal(assembly.securityChain.some((bean) => bean.name === "securityFilterChain"), true);
  assert.equal(assembly.dataLayer.some((bean) => bean.name === "orderRepository"), true);
  assert.equal(assembly.messaging.some((bean) => bean.name === "jmsListener"), true);
  assert.equal(assembly.transactionBoundaries.some((bean) => bean.name === "transactionManager"), true);
});

test("MCP full mode exposes and runs Phase 2 Java diff tool", async () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-phase2-artifacts-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/tokenopt/cli.js"), "mcp"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TOKENOPT_MCP_MODE: "full",
      TOKENOPT_ARTIFACT_DIR: artifactDir
    }
  });
  const client = new Client({ name: "tokenopt-phase2-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "tokenopt_prepare_java_diff",
      arguments: {
        diff: [
          "diff --git a/src/main/java/com/acme/PaymentListener.java b/src/main/java/com/acme/PaymentListener.java",
          "--- a/src/main/java/com/acme/PaymentListener.java",
          "+++ b/src/main/java/com/acme/PaymentListener.java",
          "@@ -1,4 +1,5 @@",
          "+import jakarta.jms.Queue;",
          "+@JmsListener(destination = \"payments\")",
          " public class PaymentListener {}"
        ].join("\n")
      }
    });

    assert.equal(result.isError ?? false, false);
    assert.match(result.content[0].text, /TokenOpt Java diff summary/);
    assert.match(result.content[0].text, /jms-config/);
    assert.equal(result.structuredContent.categories["jms-config"], 1);

    const packet = await client.callTool({
      name: "tokenopt_compile_evidence",
      arguments: {
        task_type: "review_diff",
        task: [
          "Review this Java diff",
          "diff --git a/src/main/java/com/acme/PaymentListener.java b/src/main/java/com/acme/PaymentListener.java",
          "--- a/src/main/java/com/acme/PaymentListener.java",
          "+++ b/src/main/java/com/acme/PaymentListener.java",
          "@@ -1,4 +1,5 @@",
          "+import jakarta.jms.Queue;",
          "+@JmsListener(destination = \"payments\")",
          " public class PaymentListener {}"
        ].join("\n"),
        detail: "full",
        include_structured_packet: true
      }
    });

    assert.equal(packet.isError ?? false, false);
    assert.match(packet.content[0].text, /semantic_diff: covered/);
    assert.match(packet.content[0].text, /java_categories=.*jms-config/);
    assert.match(packet.content[0].text, /likely_tests=.*PaymentListenerTest\.java/);
  } finally {
    await client.close();
  }
});
