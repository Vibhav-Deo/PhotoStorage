/**
 * Sync Lambda handler — delta pull and push for the metadata change log.
 *
 * Requirements:
 * - JWT verification against the User Pool JWKS (Req 8.1, 8.4).
 * - Atomic version counter increment via DynamoDB ADD (design: DynamoDB change log).
 * - Delta pull: PK = U#{sub} AND version > cursor, ScanIndexForward = true, Limit = 500.
 * - Delta push: write records, assign version numbers, reject keys outside caller's partition.
 * - Reject any record whose key falls outside the caller's own partition (Req 13.3).
 *
 * This Lambda handles metadata only — never bytes. The narrow interface is what makes
 * removing the backend subtraction rather than restructuring (Req 13.5).
 */

import {
  DynamoDBClient,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import * as https from 'node:https';

const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env['TABLE_NAME'] ?? '';
const USER_POOL_ID = process.env['USER_POOL_ID'] ?? '';
const AWS_REGION_ENV = process.env['AWS_REGION'] ?? 'us-east-1';

const JWKS_URL = `https://cognito-idp.${AWS_REGION_ENV}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;

// ── JWKS cache ────────────────────────────────────────────────────────────

interface JwksKey {
  kid: string;
  n: string;
  e: string;
}

let jwksCache: JwksKey[] | null = null;

async function fetchJwks(): Promise<JwksKey[]> {
  if (jwksCache !== null) return jwksCache;
  const body = await new Promise<string>((resolve, reject) => {
    https
      .get(JWKS_URL, (res) => {
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(data);
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });
  const parsed = JSON.parse(body) as { keys: JwksKey[] };
  jwksCache = parsed.keys;
  return jwksCache;
}

// ── JWT verification ──────────────────────────────────────────────────────

interface JwtClaims {
  sub: string;
  exp: number;
  iss: string;
  token_use: string;
}

/**
 * Verifies a Cognito ID token and returns its claims.
 * Uses the Web Crypto API available in Node 18+ Lambda runtime.
 */
async function verifyJwt(token: string): Promise<JwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as {
    kid: string;
    alg: string;
  };
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as JwtClaims;

  // Basic claim checks before touching crypto.
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('Token expired');
  if (!payload.iss.includes(USER_POOL_ID)) throw new Error('Wrong issuer');
  if (payload.token_use !== 'id' && payload.token_use !== 'access') {
    throw new Error('Wrong token_use');
  }

  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown key id');

  // Import the RSA public key and verify the signature.
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, 'base64url');
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    Buffer.from(signingInput),
  );
  if (!valid) throw new Error('Invalid signature');

  return payload;
}

// ── Key partition enforcement ─────────────────────────────────────────────

/** Rejects any record whose pk does not match the caller's sub (Req 13.3). */
function assertOwnPartition(pk: string, sub: string): void {
  if (pk !== `U#${sub}`) {
    throw new Error(`Partition key ${pk} is outside caller's partition U#${sub}`);
  }
}

// ── Version counter ───────────────────────────────────────────────────────

/** Atomically increments the per-user version counter and returns the new value. */
async function nextVersion(sub: string): Promise<number> {
  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ pk: `U#${sub}`, sk: 'META#counter' }),
      UpdateExpression: 'ADD #v :one',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: marshall({ ':one': 1 }),
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const attrs = result.Attributes ? unmarshall(result.Attributes) : {};
  return (attrs['version'] as number | undefined) ?? 1;
}

// ── Handlers ──────────────────────────────────────────────────────────────

interface PullRequest {
  cursor: number;
  limit?: number;
}

interface PushRequest {
  records: Record<string, unknown>[];
}

interface LambdaEvent {
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string>;
  body?: string;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

async function handlePull(sub: string, req: PullRequest): Promise<LambdaResponse> {
  const limit = Math.min(req.limit ?? 500, 500);
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'LSI1-version',
      KeyConditionExpression: 'pk = :pk AND #v > :cursor',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: marshall({
        ':pk': `U#${sub}`,
        ':cursor': req.cursor,
      }),
      ScanIndexForward: true,
      Limit: limit,
    }),
  );

  const records = (result.Items ?? []).map((item) => unmarshall(item));
  const nextCursor =
    records.length > 0
      ? (((records[records.length - 1] as Record<string, unknown>)['version'] as
          number | undefined) ?? req.cursor)
      : req.cursor;

  return ok({ records, cursor: nextCursor });
}

async function handlePush(sub: string, req: PushRequest): Promise<LambdaResponse> {
  if (!Array.isArray(req.records) || req.records.length === 0) {
    return ok({ cursor: 0 });
  }
  if (req.records.length > 25) {
    return error(400, 'Push batch exceeds 25 items (DynamoDB TransactWriteItems limit)');
  }

  // Validate all partition keys before touching DynamoDB.
  for (const record of req.records) {
    const pk = record['pk'];
    if (typeof pk !== 'string') return error(400, 'Record missing pk');
    assertOwnPartition(pk, sub);
  }

  const version = await nextVersion(sub);

  await dynamo.send(
    new TransactWriteItemsCommand({
      TransactItems: req.records.map((record) => ({
        Put: {
          TableName: TABLE_NAME,
          Item: marshall({ ...record, version }),
        },
      })),
    }),
  );

  return ok({ cursor: version });
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  try {
    const authHeader = event.headers?.['authorization'] ?? event.headers?.['Authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!token) return error(401, 'Missing Authorization header');

    const claims = await verifyJwt(token);
    const { sub } = claims;

    const method = event.requestContext?.http?.method ?? 'POST';
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};

    if (method === 'GET' || body['action'] === 'pull') {
      return await handlePull(sub, body as unknown as PullRequest);
    }
    if (method === 'POST' || body['action'] === 'push') {
      return await handlePush(sub, body as unknown as PushRequest);
    }
    return error(405, `Method ${method} not allowed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Auth errors → 401, everything else → 500.
    const status =
      msg.includes('expired') ||
      msg.includes('signature') ||
      msg.includes('issuer') ||
      msg.includes('Missing')
        ? 401
        : 500;
    return error(status, msg);
  }
}

function ok(body: unknown): LambdaResponse {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function error(statusCode: number, message: string): LambdaResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}
