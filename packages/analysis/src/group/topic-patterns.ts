/**
 * Regex-based topic / queue contract extractor for SQS, SNS, and Kafka.
 *
 * Producers:
 *   - TS / JS aws-sdk v2 + v3: `sqs.sendMessage({ QueueUrl: 'x' })`,
 *     `sns.publish({ TopicArn: 'x' })`, `new SendMessageCommand({ QueueUrl: 'x' })`.
 *   - Python boto3: `sqs.send_message(QueueUrl='x', ...)`,
 *     `sns.publish(TopicArn='x', ...)`.
 *   - Kafka.js producer.send({ topic: 'x' }) / kafka-python producer.send('x').
 *
 * Consumers:
 *   - TS / JS: `receiveMessage({ QueueUrl: 'x' })`, Kafka.js
 *     `consumer.subscribe({ topic: 'x' })`.
 *   - Python boto3: `receive_message(QueueUrl='x', ...)`. Kafka:
 *     `consumer.subscribe(['x'])`.
 *
 * The canonical signature is the queue URL / topic ARN / topic name — we
 * strip leading AWS ARN prefixes so `arn:aws:sns:us-east-1:123:orders`
 * pairs with a consumer referencing `orders`.
 */

import type { Contract, ContractType } from "./types.js";

/** `sqs.sendMessage({ QueueUrl: 'x', ... })` — method-name + queue key. */
const JS_SQS_SEND_RE =
  /\b(?:sendMessage|SendMessageCommand)\s*\(\s*\{[^}]*QueueUrl\s*:\s*['"`]([^'"`]+)['"`]/g;
const JS_SNS_PUB_RE =
  /\b(?:publish|PublishCommand)\s*\(\s*\{[^}]*TopicArn\s*:\s*['"`]([^'"`]+)['"`]/g;
const JS_SQS_RECV_RE =
  /\b(?:receiveMessage|ReceiveMessageCommand)\s*\(\s*\{[^}]*QueueUrl\s*:\s*['"`]([^'"`]+)['"`]/g;

/** Kafka.js: `producer.send({ topic: 'x', ... })`. */
const JS_KAFKA_SEND_RE =
  /\b(?:producer|this\.producer)\.send\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/g;
/** Kafka.js: `consumer.subscribe({ topic: 'x' })`. */
const JS_KAFKA_SUBSCRIBE_RE =
  /\b(?:consumer|this\.consumer)\.subscribe\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/g;

const PY_SQS_SEND_RE = /\bsend_message\s*\([^)]*QueueUrl\s*=\s*['"]([^'"]+)['"]/g;
const PY_SQS_RECV_RE = /\breceive_message\s*\([^)]*QueueUrl\s*=\s*['"]([^'"]+)['"]/g;
const PY_SNS_PUB_RE = /\bpublish\s*\([^)]*TopicArn\s*=\s*['"]([^'"]+)['"]/g;

/** Kafka-python producer.send('topic'). */
const PY_KAFKA_SEND_RE = /\bproducer\.send\s*\(\s*['"]([^'"]+)['"]/g;
/** Kafka-python consumer.subscribe(['topic']) or subscribe(topics=['x']). */
const PY_KAFKA_SUBSCRIBE_RE =
  /\bconsumer\.subscribe\s*\(\s*(?:topics\s*=\s*)?\[\s*['"]([^'"]+)['"]/g;

/** Collapse an SQS URL or SNS ARN to the trailing resource identifier. */
export function normalizeTopicSignature(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  // SNS ARN: arn:aws:sns:<region>:<account>:<topic>
  if (trimmed.startsWith("arn:")) {
    const last = trimmed.split(":").pop() ?? trimmed;
    return last;
  }
  // SQS queue URL: https://sqs.<region>.amazonaws.com/<account>/<queue>
  if (/^https?:\/\//.test(trimmed)) {
    const parts = trimmed.split("/");
    return parts[parts.length - 1] ?? trimmed;
  }
  return trimmed;
}

function lineNumberOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

export interface TopicExtractOptions {
  readonly repo: string;
  readonly file: string;
  readonly source: string;
  readonly language: "js" | "ts" | "py";
}

export function extractTopicContracts(opts: TopicExtractOptions): readonly Contract[] {
  const { repo, file, source, language } = opts;
  const out: Contract[] = [];

  if (language === "js" || language === "ts") {
    emitMatches(source, JS_SQS_SEND_RE, "topic_producer", repo, file, out);
    emitMatches(source, JS_SNS_PUB_RE, "topic_producer", repo, file, out);
    emitMatches(source, JS_KAFKA_SEND_RE, "topic_producer", repo, file, out);
    emitMatches(source, JS_SQS_RECV_RE, "topic_consumer", repo, file, out);
    emitMatches(source, JS_KAFKA_SUBSCRIBE_RE, "topic_consumer", repo, file, out);
  }

  if (language === "py") {
    emitMatches(source, PY_SQS_SEND_RE, "topic_producer", repo, file, out);
    emitMatches(source, PY_SNS_PUB_RE, "topic_producer", repo, file, out);
    emitMatches(source, PY_KAFKA_SEND_RE, "topic_producer", repo, file, out);
    emitMatches(source, PY_SQS_RECV_RE, "topic_consumer", repo, file, out);
    emitMatches(source, PY_KAFKA_SUBSCRIBE_RE, "topic_consumer", repo, file, out);
  }

  return out;
}

function emitMatches(
  source: string,
  re: RegExp,
  type: ContractType,
  repo: string,
  file: string,
  out: Contract[],
): void {
  for (const match of source.matchAll(re)) {
    const raw = match[1] ?? "";
    if (raw.length === 0) continue;
    const sig = normalizeTopicSignature(raw);
    const line = lineNumberOf(source, match.index ?? 0);
    out.push({ type, signature: sig, repo, file, line });
  }
}
