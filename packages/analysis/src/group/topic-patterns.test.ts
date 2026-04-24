import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTopicContracts, normalizeTopicSignature } from "./topic-patterns.js";

test("normalizeTopicSignature strips ARN + URL prefixes", () => {
  assert.equal(
    normalizeTopicSignature("arn:aws:sns:us-east-1:123456789012:orders-topic"),
    "orders-topic",
  );
  assert.equal(
    normalizeTopicSignature("https://sqs.us-east-1.amazonaws.com/123456789012/orders-queue"),
    "orders-queue",
  );
  assert.equal(normalizeTopicSignature("plain-topic"), "plain-topic");
});

test("extractTopicContracts: Python boto3 sqs.send_message producer", () => {
  const source = [
    "import boto3",
    "sqs = boto3.client('sqs')",
    "sqs.send_message(QueueUrl='https://sqs.us-east-1.amazonaws.com/111/orders', MessageBody='x')",
  ].join("\n");
  const out = extractTopicContracts({
    repo: "producer",
    file: "pub.py",
    source,
    language: "py",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.type, "topic_producer");
  assert.equal(out[0]?.signature, "orders");
});

test("extractTopicContracts: TS aws-sdk receiveMessage consumer", () => {
  const source = [
    "const params = { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/222/orders', MaxNumberOfMessages: 10 };",
    "await sqs.receiveMessage(params).promise();",
    "await sqs.receiveMessage({ QueueUrl: 'https://sqs.us-east-1.amazonaws.com/222/orders' }).promise();",
  ].join("\n");
  const out = extractTopicContracts({
    repo: "consumer",
    file: "consume.ts",
    source,
    language: "ts",
  });
  const consumers = out.filter((c) => c.type === "topic_consumer");
  assert.ok(consumers.length >= 1);
  assert.equal(consumers[0]?.signature, "orders");
});

test("extractTopicContracts: Kafka.js producer.send + consumer.subscribe", () => {
  const src = [
    "await producer.send({ topic: 'events', messages: [{ value: 'hi' }] });",
    "await consumer.subscribe({ topic: 'events' });",
  ].join("\n");
  const out = extractTopicContracts({
    repo: "svc",
    file: "kafka.ts",
    source: src,
    language: "ts",
  });
  const producer = out.find((c) => c.type === "topic_producer");
  const consumer = out.find((c) => c.type === "topic_consumer");
  assert.ok(producer);
  assert.ok(consumer);
  assert.equal(producer?.signature, "events");
  assert.equal(consumer?.signature, "events");
});
