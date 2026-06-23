import { Logger } from 'homebridge';
import * as http from 'http';
import * as crypto from 'crypto';
import axios from 'axios';

/**
 * Verifies the IETF HTTP Signature (draft-cavage) that SmartThings attaches to every
 * inbound webhook POST. SmartThings signs requests with its rotating x.509 "Padlock CA"
 * certificate (signatureType ST_PADLOCK); the public cert is served at
 * `https://key.smartthings.com{keyId}` where keyId comes from the Authorization header.
 *
 * Every code path is total: any malformed input, fetch failure, or crypto error resolves
 * to `false` (=> the caller returns 401). Nothing here throws to the request handler.
 */

const KEY_HOST = 'https://key.smartthings.com';
const KEY_FETCH_TIMEOUT_MS = 5000;
// Hard cap so a cache entry can never outlive this even if validTo parsing misbehaves.
const CERT_TTL_CAP_MS = 24 * 60 * 60 * 1000;
// Reject requests whose Date header is outside this window (anti-replay; tolerant of clock skew).
const DATE_SKEW_TOLERANCE_MS = 15 * 60 * 1000;
// Bound the cert cache and briefly remember failed fetches so a flood of distinct keyIds
// can't drive unbounded outbound requests to key.smartthings.com.
const MAX_CERT_CACHE_ENTRIES = 32;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
// SmartThings always signs these; require them in the signed set so the digest/date checks
// are actually bound to the RSA signature rather than self-referential.
const REQUIRED_SIGNED_HEADERS = ['(request-target)', 'digest', 'date'];
// keyId is attacker-influenced (it comes from the request header); only allow a safe path shape.
const KEY_ID_PATTERN = /^\/[A-Za-z0-9._\-/]+$/;

interface ParsedSignature {
  keyId: string;
  signature: string;
  headers: string[];
  algorithm: string;
}

interface CachedCert {
  pem: string;
  expiresAt: number;
}

export class SignatureVerifier {
  private readonly certCache = new Map<string, CachedCert>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly negativeCache = new Map<string, number>();

  constructor(private readonly log: Logger) {}

  /**
   * Returns true only if the request carries a valid, fresh SmartThings signature over the
   * given raw body. Logs a specific reason on failure to aid diagnosis of 401s.
   */
  public async verify(
    rawBody: Buffer,
    method: string | undefined,
    path: string,
    headers: http.IncomingHttpHeaders,
  ): Promise<boolean> {
    try {
      const parsed = this.parseSignatureHeader(headers['authorization']);
      if (!parsed) {
        this.log.warn('Webhook signature: missing or malformed Authorization signature header');
        return false;
      }

      // The RSA signature only authenticates the headers listed in `headers="..."`. Require the
      // body-/replay-binding headers to be present, else digest/date are checked but not signed.
      const signedSet = parsed.headers.map(h => h.toLowerCase());
      if (!REQUIRED_SIGNED_HEADERS.every(h => signedSet.includes(h))) {
        this.log.warn('Webhook signature: signed header list must include (request-target), digest, and date');
        return false;
      }

      if (!this.verifyDigest(rawBody, headers['digest'])) {
        this.log.warn('Webhook signature: body digest mismatch');
        return false;
      }

      if (!this.verifyDateFreshness(headers['date'])) {
        return false;
      }

      const signingString = this.buildSigningString(parsed.headers, method, path, headers);
      if (signingString === null) {
        this.log.warn('Webhook signature: could not build signing string (a signed header is missing)');
        return false;
      }

      const certPem = await this.getCertificate(parsed.keyId);
      if (!certPem) {
        this.log.warn(`Webhook signature: could not obtain certificate for keyId ${parsed.keyId}`);
        return false;
      }

      if (!this.rsaVerify(signingString, parsed.signature, certPem)) {
        this.log.warn('Webhook signature: RSA signature verification failed');
        return false;
      }

      return true;
    } catch (error) {
      this.log.warn('Webhook signature: unexpected error during verification:', error);
      return false;
    }
  }

  /**
   * Parses `Authorization: Signature keyId="...",signature="...",headers="...",algorithm="..."`.
   * Returns null if the scheme is wrong or any required member is missing.
   */
  private parseSignatureHeader(authHeader: string | string[] | undefined): ParsedSignature | null {
    if (typeof authHeader !== 'string') {
      return null;
    }
    const trimmed = authHeader.trim();
    if (!/^signature\s+/i.test(trimmed)) {
      return null;
    }
    const paramStr = trimmed.replace(/^signature\s+/i, '');

    const params: Record<string, string> = {};
    const re = /(\w+)\s*=\s*"([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(paramStr)) !== null) {
      params[match[1].toLowerCase()] = match[2];
    }

    const keyId = params['keyid'];
    const signature = params['signature'];
    const headers = params['headers'];
    const algorithm = params['algorithm'];
    if (!keyId || !signature || !headers || !algorithm) {
      return null;
    }

    return {
      keyId,
      signature,
      headers: headers.split(/\s+/).filter(h => h.length > 0),
      algorithm,
    };
  }

  /**
   * Confirms base64(sha256(rawBody)) equals the value in the Digest header.
   * Accepts both `SHA256=` and `SHA-256=` prefixes.
   */
  private verifyDigest(rawBody: Buffer, digestHeader: string | string[] | undefined): boolean {
    if (typeof digestHeader !== 'string') {
      return false;
    }
    const m = /^\s*SHA-?256\s*=\s*(.+?)\s*$/i.exec(digestHeader);
    if (!m) {
      return false;
    }
    const expected = m[1];
    const actual = crypto.createHash('sha256').update(rawBody).digest('base64');
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(actual);
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  }

  /**
   * Rejects requests whose Date header is missing, unparseable, or outside the skew tolerance.
   */
  private verifyDateFreshness(dateHeader: string | string[] | undefined): boolean {
    if (typeof dateHeader !== 'string') {
      this.log.warn('Webhook signature: missing Date header');
      return false;
    }
    const dateMs = Date.parse(dateHeader);
    if (Number.isNaN(dateMs)) {
      this.log.warn('Webhook signature: unparseable Date header');
      return false;
    }
    const skew = Math.abs(Date.now() - dateMs);
    if (skew > DATE_SKEW_TOLERANCE_MS) {
      this.log.warn(
        `Webhook signature: Date header outside ${DATE_SKEW_TOLERANCE_MS / 60000}-minute window ` +
        `(skew ${Math.round(skew / 1000)}s) - rejecting as stale/replayed. Check the host clock if this is unexpected.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Builds the signing string from the signed header list, verbatim and in order.
   * `(request-target)` => "<method> <path>"; every other token => "<name>: <value>".
   * Returns null if any named header is absent or multi-valued.
   */
  private buildSigningString(
    headerList: string[],
    method: string | undefined,
    path: string,
    headers: http.IncomingHttpHeaders,
  ): string | null {
    const lines: string[] = [];
    for (const name of headerList) {
      if (name === '(request-target)') {
        lines.push(`(request-target): ${(method || '').toLowerCase()} ${path}`);
        continue;
      }
      const value = headers[name];
      if (value === undefined || Array.isArray(value)) {
        return null;
      }
      lines.push(`${name}: ${value}`);
    }
    return lines.join('\n');
  }

  /**
   * Returns the PEM cert for a keyId, using a per-keyId cache and de-duplicating concurrent
   * fetches. keyId rotation is handled implicitly: a new keyId is simply a new cache key.
   */
  private async getCertificate(keyId: string): Promise<string | null> {
    this.pruneExpired();

    const cached = this.certCache.get(keyId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.pem;
    }

    const negativeUntil = this.negativeCache.get(keyId);
    if (negativeUntil !== undefined && Date.now() < negativeUntil) {
      return null;
    }

    const existing = this.inFlight.get(keyId);
    if (existing) {
      return existing;
    }

    const fetchPromise = this.fetchCertificate(keyId)
      .then(pem => {
        if (pem) {
          this.evictIfFull();
          this.certCache.set(keyId, { pem, expiresAt: this.computeExpiry(pem) });
        } else {
          this.negativeCache.set(keyId, Date.now() + NEGATIVE_CACHE_TTL_MS);
        }
        return pem;
      })
      .finally(() => {
        this.inFlight.delete(keyId);
      });

    this.inFlight.set(keyId, fetchPromise);
    return fetchPromise;
  }

  private async fetchCertificate(keyId: string): Promise<string | null> {
    // Defend against keyId injecting an absolute URL / different host or scheme, or a flood of
    // distinct malformed keyIds. Only a plain key-path shape is allowed.
    if (!KEY_ID_PATTERN.test(keyId)) {
      this.log.warn(`Webhook signature: refusing to fetch certificate for malformed keyId ${keyId}`);
      return null;
    }
    try {
      const resp = await axios.get(`${KEY_HOST}${keyId}`, {
        timeout: KEY_FETCH_TIMEOUT_MS,
        responseType: 'text',
        maxRedirects: 0,
        validateStatus: status => status === 200,
      });
      return typeof resp.data === 'string' ? resp.data : String(resp.data);
    } catch (error) {
      this.log.warn(`Webhook signature: failed to fetch certificate ${keyId}:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  private computeExpiry(pem: string): number {
    const cap = Date.now() + CERT_TTL_CAP_MS;
    try {
      const validTo = Date.parse(new crypto.X509Certificate(pem).validTo);
      if (!Number.isNaN(validTo)) {
        return Math.min(validTo, cap);
      }
    } catch {
      // Fall through to the hard cap if the cert can't be parsed for an expiry.
    }
    return cap;
  }

  private rsaVerify(signingString: string, signatureB64: string, certPem: string): boolean {
    try {
      return crypto
        .createVerify('RSA-SHA256')
        .update(signingString)
        .verify(certPem, signatureB64, 'base64');
    } catch (error) {
      this.log.debug('Webhook signature: crypto verify threw:', error);
      return false;
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [keyId, entry] of this.certCache) {
      if (now >= entry.expiresAt) {
        this.certCache.delete(keyId);
      }
    }
    for (const [keyId, until] of this.negativeCache) {
      if (now >= until) {
        this.negativeCache.delete(keyId);
      }
    }
  }

  // Bound cache growth: if at capacity, drop the oldest entry (Map preserves insertion order).
  private evictIfFull(): void {
    while (this.certCache.size >= MAX_CERT_CACHE_ENTRIES) {
      const oldest = this.certCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.certCache.delete(oldest);
    }
  }
}
