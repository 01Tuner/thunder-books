import { ZATCASimplifiedTaxInvoice } from 'zatca-xml-js';
import { EGS } from 'zatca-xml-js';
import QRCode from 'qrcode';
import { SalesInvoice } from '../models/baseModels/SalesInvoice/SalesInvoice';
import { ZATCASettings } from '../models/baseModels/ZATCASettings/ZATCASettings';
import { ModelNameEnum } from '../models/types';
import { Fyo } from 'fyo';

const INITIAL_HASH = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

/** Populated by the patched generateQR so the IPC response can surface TLV diagnostics to the renderer. */
let __lastQrDiagnostics: Record<string, unknown> | null = null;

/** BT-29 (scheme CRN): values like 1234567890 / repeated digits fail BR-KSA-F-13 (Fatoora community list). */
const ZATCA_REJECTED_CRN_PATTERNS = new Set([
    '0123456789',
    '1234567890',
    '0987654321',
    '0000000000',
    '1111111111',
    '2222222222',
    '3333333333',
    '4444444444',
    '5555555555',
    '6666666666',
    '7777777777',
    '8888888888',
    '9999999999',
]);

/**
 * Normalizes seller CRN for UBL PartyIdentification (schemeID=CRN). Must be a real 10-digit MoCI number.
 */
function normalizeAndValidateZatcaCrn(crnInput: string | undefined | null): string {
    const digits = String(crnInput ?? '')
        .trim()
        .replace(/\D/g, '');
    if (digits.length !== 10) {
        throw new Error(
            'ZATCA: Commercial Registration Number (CRN) in Setup → ZATCA must be exactly 10 digits. Fatoora rejects invalid seller Other IDs (BR-KSA-F-13 / BT-29).'
        );
    }
    if (ZATCA_REJECTED_CRN_PATTERNS.has(digits)) {
        throw new Error(
            'ZATCA: CRN cannot be a test or sequential pattern (e.g. 1234567890). Use your real CRN from the Ministry of Commerce (BR-KSA-F-13).'
        );
    }
    return digits;
}

/**
 * zatca-xml-js hardcodes InvoiceTypeCode @name="0211010" (summary + third-party + nominal per BR-KSA-06),
 * which triggers BR-KSA-71 / BR-KSA-F-13 with an empty AccountingCustomerParty.
 * We rewrite to B2C simplified "0200000" and inject a minimal buyer legal name, then re-parse so the
 * signed XML and Fatoora submission always match (object mutation alone can fail after some bundlers).
 */
function escapeXmlText(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function applyZatcaSimplifiedB2CXmlFixes(
    zatcaInvoice: InstanceType<typeof ZATCASimplifiedTaxInvoice>,
    buyerRegistrationName: string
): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { XMLDocument } = require('zatca-xml-js/lib/parser') as {
        XMLDocument: new (xml: string) => { toString: (o: { no_header: boolean }) => string };
    };
    let xmlStr = zatcaInvoice.getXML().toString({ no_header: false });
    xmlStr = xmlStr.replace(
        /(<cbc:InvoiceTypeCode\s+)name="0211010"/,
        '$1name="0200000"'
    );
    const buyer = escapeXmlText((buyerRegistrationName || '').trim() || 'Walk-in Customer');
    const buyerBlock =
        `<cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${buyer}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>`;
    xmlStr = xmlStr.replace(
        /<cac:AccountingCustomerParty>\s*<\/cac:AccountingCustomerParty>/,
        buyerBlock
    );
    (zatcaInvoice as unknown as { invoice_xml: InstanceType<typeof XMLDocument> }).invoice_xml =
        new XMLDocument(xmlStr);
}

/**
 * Converts a private key from any Frappe/ZATCA storage format into PEM.
 * Possible formats: already-PEM, base64(PEM), PKCS8 DER, SEC1 DER, raw 32-byte scalar.
 */
function toPrivateKeyPEM(keyOrPem: string): string {
    if (keyOrPem.includes('-----BEGIN')) return keyOrPem.trim();

    const crypto = require('crypto');
    const cleaned = keyOrPem.replace(/\s/g, '');

    // Case 1: maybe it's base64(PEM string)
    try {
        const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
        if (decoded.includes('-----BEGIN')) {
            console.log('[ZATCA] Private key detected as base64-encoded PEM');
            return decoded.trim();
        }
    } catch { /* not utf8 text */ }

    const buf = Buffer.from(cleaned, 'base64');
    console.log('[ZATCA] Private key raw bytes length:', buf.length, 'first4hex:', buf.slice(0, 4).toString('hex'));

    // Case 2: PKCS#8 DER (-----BEGIN PRIVATE KEY-----)
    try {
        const keyObj = crypto.createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
        console.log('[ZATCA] Private key parsed as PKCS8 DER');
        return (keyObj.export({ format: 'pem', type: 'pkcs8' }) as string).trim();
    } catch { /* try next */ }

    // Case 3: SEC1 DER (-----BEGIN EC PRIVATE KEY-----)
    try {
        const keyObj = crypto.createPrivateKey({ key: buf, format: 'der', type: 'sec1' });
        console.log('[ZATCA] Private key parsed as SEC1 DER');
        return (keyObj.export({ format: 'pem', type: 'sec1' }) as string).trim();
    } catch { /* try next */ }

    // Case 4: Raw 32-byte EC private key scalar → build SEC1 DER manually for P-256
    const rawKey = Uint8Array.from(buf.length === 32 ? buf : buf.slice(buf.length - 32));
    console.log('[ZATCA] Private key treating as raw 32-byte scalar, building SEC1 DER');
    // SEC1 DER for P-256 (prime256v1 OID: 2a 86 48 ce 3d 03 01 07)
    //   30 LL  02 01 01  04 20 [32-byte key]  a0 0a  06 08 [8-byte oid]
    const oid = Uint8Array.from(Buffer.from('2a8648ce3d030107', 'hex'));
    const oidTag = Uint8Array.from([0x06, 0x08]);
    const ctx0Tag = Uint8Array.from([0xa0, 0x0a]);
    const privTag = Uint8Array.from([0x04, 0x20]);
    const verBytes = Uint8Array.from([0x02, 0x01, 0x01]);
    const inner = new Uint8Array([
        ...verBytes,
        ...privTag, ...rawKey,
        ...ctx0Tag, ...oidTag, ...oid,
    ]);
    const seq = new Uint8Array([0x30, inner.length, ...inner]);
    try {
        const keyObj = crypto.createPrivateKey({ key: Buffer.from(seq), format: 'der', type: 'sec1' });
        return (keyObj.export({ format: 'pem', type: 'sec1' }) as string).trim();
    } catch (e: any) {
        console.error('[ZATCA] All private key parse attempts failed:', e?.message);
    }

    // Final fallback: manual PEM wrap of original base64 body
    const body = cleaned.match(/.{1,64}/g)?.join('\n') ?? cleaned;
    return `-----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----`;
}

/**
 * Converts stored CSID / certificate material into PEM for zatca-xml-js.
 *
 * Fatoora returns `binarySecurityToken` as base64(DER) — we store that string as clientId.
 * Some setups may store full PEM or base64-wrapped PEM bodies; we accept those too.
 *
 * Important: `zatca-xml-js` puts `cleanUpCertificateString(cert)` inside `<ds:X509Certificate>`.
 * Offline/SDK validators expect that value to be **one continuous Base64 string** (no line breaks).
 * PEM bodies split with \\n every 64 chars end up as invalid "base64" in the XML and trigger
 * errors like "The inserted certificate should be encoded using base64...".
 */
function toCertificatePEM(csidOrPem: string): string {
    const crypto = require('crypto') as typeof import('crypto');
    const normalized = csidOrPem.trim().replace(/\r\n/g, '\n');

    const pemFromDer = (der: Buffer): string => {
        const body = der.toString('base64');
        return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
    };

    const pemBlock = normalized.match(
        /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/
    );
    if (pemBlock) {
        const body = pemBlock[1].replace(/\s/g, '');
        try {
            const der = Buffer.from(body, 'base64');
            new crypto.X509Certificate(der);
            return pemFromDer(der);
        } catch {
            throw new Error(
                'ZATCA: The compliance certificate in settings is not a valid X.509 certificate. Re-issue the CSID in Fatoora.'
            );
        }
    }

    const cleaned = normalized.replace(/\s/g, '');

    // binarySecurityToken from API: base64(DER)
    try {
        const der = Buffer.from(cleaned, 'base64');
        if (der.length > 0) {
            new crypto.X509Certificate(der);
            return pemFromDer(der);
        }
    } catch {
        /* not base64(DER) */
    }

    // Rare: base64(ASCII PEM body only)
    try {
        const ascii = Buffer.from(cleaned, 'base64').toString('utf8');
        const inner = ascii.replace(/\s/g, '');
        if (inner.length > 64 && /^[A-Za-z0-9+/]+=*$/.test(inner)) {
            const der = Buffer.from(inner, 'base64');
            new crypto.X509Certificate(der);
            return pemFromDer(der);
        }
    } catch {
        /* fall through */
    }

    throw new Error(
        'ZATCA: Could not parse the compliance certificate (CSID). Use the binarySecurityToken from Fatoora or a valid PEM.'
    );
}

/**
 * Patches the zatca-xml-js signing module to use @noble/curves (pure JS secp256k1)
 * instead of Node crypto.createSign — Electron's BoringSSL doesn't support secp256k1.
 *
 * The library's createInvoiceDigitalSignature:
 *   1. Strips PEM headers from private_key_string to get raw base64 body
 *   2. Wraps it as -----BEGIN EC PRIVATE KEY-----
 *   3. Calls crypto.createSign('sha256').sign(...)  ← this fails in Electron
 *
 * We replace step 3 with @noble/curves secp256k1 ECDSA.
 */
async function patchZatcaSigning(privateKeyBase64Body: string) {
    // @noble/curves v2 is ESM-only — must use dynamic import()
    const { secp256k1 } = await import('@noble/curves/secp256k1.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const signingModule = require('zatca-xml-js/lib/zatca/signing');

    // Parse SEC1 DER to extract the 32-byte private key scalar d
    // SEC1 structure: 30 LL 02 01 01 04 20 [32 bytes d] a0 ...
    const sec1 = Buffer.from(privateKeyBase64Body.replace(/\s/g, ''), 'base64');
    let privKeyBytes: Uint8Array;
    if (sec1.length === 32) {
        privKeyBytes = Uint8Array.from(sec1);
    } else if (sec1[0] === 0x30) {
        // Walk the SEC1 DER: 30 LL 02 01 01 04 20 [key]
        // offset: 1(tag) + 1(len) + 3(version) + 2(octet-string header) = 7
        const offset = 7;
        privKeyBytes = Uint8Array.from(sec1.slice(offset, offset + 32));
    } else {
        privKeyBytes = Uint8Array.from(sec1.slice(sec1.length - 32));
    }

    const { createHash } = require('crypto') as typeof import('crypto');

    // Derive the uncompressed public key from privKeyBytes and log its hex prefix for mismatch detection.
    const derivedPubKeyUncompressed = secp256k1.getPublicKey(privKeyBytes, false); // 65 bytes: 04 || x || y
    console.log('[ZATCA] Derived pubkey (from privKey, uncompressed, hex prefix):', Buffer.from(derivedPubKeyUncompressed).toString('hex').slice(0, 32));

    signingModule.createInvoiceDigitalSignature = (invoice_hash: string, _private_key_string: string): string => {
        // invoice_hash is the base64-encoded SHA-256 digest of the canonicalized invoice XML.
        // @noble/curves secp256k1.sign does NOT pre-hash by default (prehash option defaults to false).
        // Node.js createSign('sha256').update(rawBytes).sign() internally applies SHA-256 to rawBytes.
        // So we must manually SHA-256 the raw 32 bytes before passing to noble, to match that behaviour.
        const hashBytes = Uint8Array.from(Buffer.from(invoice_hash, 'base64'));
        const digest = new Uint8Array(createHash('sha256').update(hashBytes).digest());
        // Sign in DER format (matches what Node.js createSign('sha256') produces).
        const sigDer = secp256k1.sign(digest, privKeyBytes, { format: 'der' });
        const sigB64 = Buffer.from(sigDer).toString('base64');
        // Self-verify using compact format (secp256k1.verify expects compact 64-byte, not DER).
        // secp256k1 uses RFC 6979 deterministic nonces, so same key+digest → same compact sig.
        const sigCompact = secp256k1.sign(digest, privKeyBytes); // compact 64-byte Uint8Array
        const verified = secp256k1.verify(sigCompact, digest, derivedPubKeyUncompressed);
        console.log('[ZATCA] Sig self-verify (privKey→pubKey):', verified, '| DER sigPrefix:', sigB64.slice(0, 16));
        return sigB64;
    };

    console.log('[ZATCA] Signing module patched with @noble/curves secp256k1 (pure JS)');

    // Replace zatca-xml-js generateQR with a correct Phase 2 TLV builder.
    // The library's TLV function is private (not exported), so we inline it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const moment = require('moment');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zatcaSigning = require('zatca-xml-js/lib/zatca/signing');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const qrModule = require('zatca-xml-js/lib/zatca/qr');

    const toBuf = (x: string | Buffer | Uint8Array): Buffer => {
        if (typeof x === 'string') return Buffer.from(x, 'utf8');
        if (Buffer.isBuffer(x)) return x;
        return Buffer.from(x);
    };

    // Exact replica of the library's private TLV function (qr/index.js), but fixed with ASN.1 BER length encoding
    const buildTLV = (tags: Array<string | Buffer | Uint8Array>): Buffer => {
        const parts: Buffer[] = [];
        tags.forEach((tag, i) => {
            const val = toBuf(tag);
            let lenBuf: Buffer;
            if (val.length < 128) {
                lenBuf = Buffer.from([val.length]);
            } else if (val.length < 256) {
                lenBuf = Buffer.from([0x81, val.length]);
            } else {
                lenBuf = Buffer.from([0x82, val.length >> 8, val.length & 0xff]);
            }
            // @ts-ignore - node typing mismatch for Buffer.concat
            parts.push(Buffer.concat([Buffer.from([i + 1]), lenBuf, val]));
        });
        // @ts-ignore
        return Buffer.concat(parts);
    };

    qrModule.generateQR = ({
        invoice_xml,
        digital_signature,
        public_key,
        certificate_signature,
    }: {
        invoice_xml: { get: (path: string) => unknown[] | undefined };
        digital_signature: string | Buffer | Uint8Array;
        public_key: Buffer | Uint8Array;
        certificate_signature: Buffer | Uint8Array;
    }) => {
        const invoiceHashB64 = zatcaSigning.getInvoiceHash(invoice_xml) as string;

        const textFromNode = (node: unknown): string => {
            if (node == null) return '';
            if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
                return String(node);
            }
            if (Array.isArray(node)) {
                return node.map((n) => textFromNode(n)).find((s) => s.trim() !== '') ?? '';
            }
            if (typeof node === 'object') {
                const rec = node as Record<string, unknown>;
                for (const k of ['#text', '_text', 'text', 'value']) {
                    const v = rec[k];
                    if (v != null && String(v).trim() !== '') return String(v);
                }
                for (const v of Object.values(rec)) {
                    const s = textFromNode(v);
                    if (s.trim() !== '') return s;
                }
            }
            return '';
        };

        const sellerName = invoice_xml.get(
            'Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'
        )?.[0];
        const vatCell = invoice_xml.get(
            'Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID'
        )?.[0];
        const totalCell = invoice_xml.get('Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount')?.[0];
        const taxTotalCell = invoice_xml.get('Invoice/cac:TaxTotal')?.[0];

        const sellerStr = textFromNode(sellerName);
        const vatStr = textFromNode(vatCell);
        // Library's original qr/index.js extracts with `.toString()` on the #text Number.
        // ZATCA validator recomputes the XML hash and compares QR tags 4/5 numerically,
        // but also checks the raw text matches what's in the XML. We must therefore use
        // the exact same textual representation as the signed XML — no reformatting.
        const invoiceTotalStr = textFromNode(totalCell);
        const vatTotalStr =
            textFromNode(
                typeof taxTotalCell === 'object' && taxTotalCell !== null
                    ? (taxTotalCell as Record<string, unknown>)['cbc:TaxAmount']
                    : taxTotalCell
            ) || textFromNode(invoice_xml.get('Invoice/cac:TaxTotal/cbc:TaxAmount')?.[0]);

        const issueDate = invoice_xml.get('Invoice/cbc:IssueDate')?.[0];
        const issueTime = invoice_xml.get('Invoice/cbc:IssueTime')?.[0];
        const issueDateStr =
            issueDate == null ? '' : typeof issueDate === 'string' ? issueDate : String(issueDate);
        const issueTimeStr =
            issueTime == null ? '' : typeof issueTime === 'string' ? issueTime : String(issueTime);
        const formattedDatetimeBase =
            issueDateStr.trim() !== '' && issueTimeStr.trim() !== ''
                ? `${issueDateStr.trim()}T${issueTimeStr.trim()}`
                : moment(`${issueDate} ${issueTime}`).format('YYYY-MM-DDTHH:mm:ss');
        const formattedDatetime = /(?:Z|[+-]\d{2}:\d{2})$/.test(formattedDatetimeBase)
            ? formattedDatetimeBase
            : `${formattedDatetimeBase}Z`;

        const sigB64Str =
            typeof digital_signature === 'string'
                ? digital_signature
                : toBuf(digital_signature).toString('base64');

        // Fatoora's QR validator expects tags 6 and 7 as the BASE64 TEXT of
        // the hash/signature encoded as UTF-8 (what zatca-xml-js's original
        // generateQR does), not the raw binary bytes. The spec reads like raw,
        // but the sandbox/production validator consistently accepts the
        // base64-text form. Tags 8 and 9 remain raw DER (that part ZATCA is
        // unambiguous about). See TAG_ENCODING note in the repo history.
        const invoiceHashTag = Buffer.from(invoiceHashB64, 'utf8'); // 44 bytes
        const sigTag = Buffer.from(sigB64Str, 'utf8');              // ~96 bytes

        // Kept for diagnostics only — the raw forms of the same payloads.
        const invoiceHashRawBytes = Buffer.from(invoiceHashB64, 'base64');
        const sigRawBytes = Buffer.from(sigB64Str, 'base64');

        const pubKeyBuf = toBuf(public_key);
        const certSigBuf = toBuf(certificate_signature);

        // CRITICAL diagnostic: verify the certificate's EC point matches the private key.
        // If these don't match, ZATCA will reject with QRCODE_INVALID because the
        // signature in tag 7 cannot be verified with the public key in tag 8.
        let keysMatch: boolean | null = null;
        let certPointHex = '';
        let derivedHex = '';
        try {
            // SPKI DER for secp256k1 ends with the BIT STRING containing 04 || X || Y (65 bytes).
            // The last 65 bytes of the SPKI DER are the uncompressed EC point.
            const certPoint = pubKeyBuf.slice(pubKeyBuf.length - 65);
            derivedHex = Buffer.from(derivedPubKeyUncompressed).toString('hex');
            certPointHex = certPoint.toString('hex');
            keysMatch = certPointHex === derivedHex;
            console.log('[ZATCA] Cert EC point (hex first 32):', certPointHex.slice(0, 32));
            console.log('[ZATCA] Derived EC point (hex first 32):', derivedHex.slice(0, 32));
            console.log('[ZATCA] ✓ Private key ↔ Certificate match:', keysMatch);
            if (!keysMatch) {
                console.error(
                    '[ZATCA] *** KEY MISMATCH *** The private key does not correspond to the ' +
                    'public key in the CSID certificate. Re-run the ZATCA onboarding (CSR + ' +
                    'compliance CSID) so the key pair and certificate match. This is the root ' +
                    'cause of QRCODE_INVALID.'
                );
            }
        } catch (e) {
            console.warn('[ZATCA] Could not compare cert vs derived public key:', (e as Error).message);
        }

        const qrTlv = buildTLV([
            sellerStr,                        // tag 1 — UTF-8 string
            vatStr,                           // tag 2 — UTF-8 string
            formattedDatetime,                // tag 3 — UTF-8 string
            invoiceTotalStr,                  // tag 4 — UTF-8 string
            vatTotalStr,                      // tag 5 — UTF-8 string
            invoiceHashTag,                   // tag 6 — base64 text (UTF-8)
            sigTag,                           // tag 7 — base64 text (UTF-8)
            pubKeyBuf,                        // tag 8 — raw SPKI DER
            certSigBuf,                       // tag 9 — raw cert signature
        ]);

        __lastQrDiagnostics = {
            tag1_seller: sellerStr,
            tag2_vat: vatStr,
            tag3_datetime: formattedDatetime,
            tag4_total: invoiceTotalStr,
            tag5_vatTotal: vatTotalStr,
            tag6_encoding: 'base64-text-as-utf8',
            tag6_sentBytes: invoiceHashTag.length,
            tag6_hashBase64: invoiceHashB64,
            tag6_hashHexRaw: invoiceHashRawBytes.toString('hex'),
            tag7_encoding: 'base64-text-as-utf8',
            tag7_sentBytes: sigTag.length,
            tag7_sigBase64: sigB64Str,
            tag7_sigHexRaw: sigRawBytes.toString('hex'),
            tag8_pubKeyHex: pubKeyBuf.toString('hex'),
            tag8_bytes: pubKeyBuf.length,
            tag9_certSigHex: certSigBuf.toString('hex'),
            tag9_bytes: certSigBuf.length,
            keysMatch,
            certPointHex,
            derivedPubKeyHex: derivedHex,
            qrBase64: qrTlv.toString('base64'),
            tlvTotalBytes: qrTlv.length,
        };

        console.log('[ZATCA] ─── QR TLV tag breakdown ───');
        console.log('[ZATCA]  1 seller      :', JSON.stringify(sellerStr), '(len', Buffer.byteLength(sellerStr, 'utf8'), ')');
        console.log('[ZATCA]  2 vat         :', JSON.stringify(vatStr));
        console.log('[ZATCA]  3 datetime    :', JSON.stringify(formattedDatetime));
        console.log('[ZATCA]  4 total       :', JSON.stringify(invoiceTotalStr));
        console.log('[ZATCA]  5 vatTotal    :', JSON.stringify(vatTotalStr));
        console.log('[ZATCA]  6 hash        : base64="', invoiceHashB64, '" (sent as UTF-8, bytes', invoiceHashTag.length, ')');
        console.log('[ZATCA]  7 sig         : base64="', sigB64Str.slice(0, 32), '…" (sent as UTF-8, bytes', sigTag.length, ')');
        console.log('[ZATCA]  8 pubKey(hex) :', pubKeyBuf.toString('hex').slice(0, 40), '... (bytes', pubKeyBuf.length, ')');
        console.log('[ZATCA]  9 certSig(hex):', certSigBuf.toString('hex').slice(0, 40), '... (bytes', certSigBuf.length, ')');
        console.log('[ZATCA] Total TLV length:', qrTlv.length, '| base64 length:', qrTlv.toString('base64').length);
        return qrTlv.toString('base64');
    };
    console.log('[ZATCA] QR module patched (inline TLV)');
}



export async function processZatcaPhase2FromIPC(
    invoiceData: Record<string, unknown>,
    settingsData: Record<string, unknown>,
    databaseManager: any
): Promise<Record<string, unknown> | null> {

    const privateKey = settingsData.privateKey as string | undefined;
    const csid = settingsData.clientId as string | undefined;

    // Extract the raw base64 body of the private key (strip PEM headers if present)
    let privateKeyBody: string | undefined;
    if (privateKey) {
        if (privateKey.includes('-----BEGIN EC PRIVATE KEY-----')) {
            // Use regex to extract ONLY the body between the EC PRIVATE KEY headers.
            // Simple string replace would leave EC PARAMETERS block content before the key body.
            const match = privateKey.match(/-----BEGIN EC PRIVATE KEY-----\s*([\s\S]+?)\s*-----END EC PRIVATE KEY-----/);
            privateKeyBody = match ? match[1].replace(/\s/g, '') : privateKey.replace(/\s/g, '');
        } else if (privateKey.includes('-----BEGIN')) {
            // PKCS8 or other — convert to SEC1 first
            const crypto = require('crypto');
            const buf = Buffer.from(privateKey.replace(/\s/g, ''), 'base64');
            try {
                const k = crypto.createPrivateKey({ key: buf, format: 'der', type: 'sec1' });
                const sec1pem = k.export({ format: 'pem', type: 'sec1' }) as string;
                privateKeyBody = sec1pem
                    .replace('-----BEGIN EC PRIVATE KEY-----', '')
                    .replace('-----END EC PRIVATE KEY-----', '')
                    .replace(/\s/g, '');
            } catch {
                privateKeyBody = privateKey.replace(/\s/g, '');
            }
        } else {
            // Assume raw base64 SEC1 DER body already
            privateKeyBody = privateKey.replace(/\s/g, '');
        }
    }

    // Patch the signing module BEFORE constructing EGS
    if (privateKeyBody) {
        await patchZatcaSigning(privateKeyBody);
    }

    const crnDigits = normalizeAndValidateZatcaCrn(settingsData.crnNumber as string | undefined);

    const egsunit: any = {
        uuid: (invoiceData.zatca_uuid as string) || require('crypto').randomUUID(),
        custom_id: (settingsData.sellerName as string) || "EGS1-12345",
        model: "Desktop",
        CRN_number: crnDigits,
        VAT_name: (settingsData.sellerName as string) || "Unknown Seller",
        VAT_number: (settingsData.vatNumber as string) || "300000000000003",
        location: {
            city: (settingsData.city as string) || "Riyadh",
            city_subdivision: "Default",
            street: (settingsData.street as string) || "Default",
            plot_identification: "0000",
            building: "0000",
            postal_zone: (settingsData.postalZone as string) || "12345"
        },
        branch_name: (settingsData.branchName as string) || "Head Office",
        branch_industry: (settingsData.branchIndustry as string) || "Retail",
        // private_key must be a PEM string — library strips headers internally
        private_key: privateKey ? toPrivateKeyPEM(privateKey) : undefined,
        compliance_certificate: csid ? toCertificatePEM(csid) : undefined,
    };

    // Determine previous invoice hash from Settings (Serial Locking)
    const prevHash = (settingsData.lastInvoiceHash as string) || INITIAL_HASH;
    // Ensure arithmetic addition even if DB returns a string (e.g. "1" + 1 = "11" otherwise)
    const nextCounter = (Number(settingsData.lastInvoiceCounter) || 0) + 1;
    const icvUUID = (invoiceData.zatca_uuid as string) || require('crypto').randomUUID();

    const items = (invoiceData.items as any[]) || [];
    const line_items = items.map((item: any, index: number) => ({
        id: (index + 1).toString(),
        name: item.name || item.item || "Item",
        quantity: item.quantity || 1,
        tax_exclusive_price: item.rate || 0,
        VAT_percent: 0.15,
        other_taxes: [],
        discounts: item.itemDiscountAmount
            ? [{ amount: item.itemDiscountAmount, reason: "Discount" }]
            : []
    }));

    const invoiceDate = new Date((invoiceData.date as string) || Date.now());
    egsunit.uuid = icvUUID;

    const zatcaInvoice = new ZATCASimplifiedTaxInvoice({
        props: {
            egs_info: egsunit,
            // BR-KSA-34: ICV (KSA-16) must contain only digits — pass the sequential integer counter
            invoice_counter_number: nextCounter,
            invoice_serial_number: (invoiceData.name as string) || "INV-1",
            issue_date: invoiceDate.toISOString().split('T')[0],
            issue_time: invoiceDate.toISOString().split('T')[1].substring(0, 8),
            previous_invoice_hash: prevHash,
            line_items: line_items
        }
    });
    const buyerNameForZatca =
        (invoiceData.buyer_name as string | undefined)?.trim() || 'Walk-in Customer';
    applyZatcaSimplifiedB2CXmlFixes(zatcaInvoice, buyerNameForZatca);

    try {
        const egs = new EGS(egsunit as any);

        // Set baseURL based on environment
        const environment = (settingsData.environment as string) || 'Sandbox';
        let baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
        if (environment === 'Production') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core";
        else if (environment === 'Simulation') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation";

        // @ts-ignore
        if (egs.api) egs.api.baseURL = baseURL;

        if (!privateKey?.trim() || !csid?.trim()) {
            throw new Error(
                'Missing ZATCA Phase 2 credentials. Open Setup → ZATCA and finish onboarding (private key and CSID).'
            );
        }

        const { signed_invoice_string, invoice_hash, qr } = egs.signInvoice(zatcaInvoice);
        console.log('[ZATCA] Invoice signed locally, QR TLV length:', qr?.length);

        // Dump the FINAL signed XML + raw QR TLV to disk so we can forensically
        // diff against a known-good ZATCA sandbox submission when Fatoora keeps
        // returning QRCODE_INVALID despite all internal checks passing.
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs') as typeof import('fs');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const os = require('os') as typeof import('os');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require('path') as typeof import('path');
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const home = os.homedir();
            const desktop = home ? path.join(home, 'Desktop') : '';
            const dirs = [
                path.join(os.tmpdir(), 'zatca-debug'),
                ...(home && desktop && fs.existsSync(desktop)
                    ? [path.join(desktop, 'zatca-debug-invoices')]
                    : home
                      ? [path.join(home, 'zatca-debug-invoices')]
                      : []),
            ];
            for (const dir of dirs) {
                fs.mkdirSync(dir, { recursive: true });
                const xmlPath = path.join(dir, `invoice-${ts}.xml`);
                const qrPath = path.join(dir, `qr-${ts}.txt`);
                fs.writeFileSync(xmlPath, signed_invoice_string, 'utf8');
                fs.writeFileSync(
                    qrPath,
                    `QR TLV (base64):\n${qr}\n\nQR TLV (hex):\n${Buffer.from(qr, 'base64').toString('hex')}\n\nInvoice hash (base64):\n${invoice_hash}\n`,
                    'utf8'
                );
                console.log('[ZATCA] Signed XML for offline validator:', xmlPath);
                console.log('[ZATCA] QR / hash sidecar              :', qrPath);
            }
        } catch (e) {
            console.warn('[ZATCA] Could not write forensic dump:', (e as Error).message);
        }

        // ── CRITICAL diagnostic: recompute the hash the way ZATCA will ──
        // ZATCA's validator takes our signed_invoice_string, strips
        // ext:UBLExtensions + cac:Signature + cac:AdditionalDocumentReference[id=QR],
        // canonicalizes and re-hashes. If that hash != QR tag 6, Fatoora answers
        // QRCODE_INVALID. Run the SAME library routine on the FINAL signed XML
        // (not the pre-sign in-memory object) to expose any canonicalization drift.
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { XMLDocument: XMLDoc2 } = require('zatca-xml-js/lib/parser') as {
                XMLDocument: new (xml: string) => unknown;
            };
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const sigLib = require('zatca-xml-js/lib/zatca/signing') as {
                getInvoiceHash: (doc: unknown) => string;
            };
            const reparsed = new XMLDoc2(signed_invoice_string);
            const roundtripHashB64 = sigLib.getInvoiceHash(reparsed);
            const tag6Hex = Buffer.from(invoice_hash, 'base64').toString('hex');
            const rtHex = Buffer.from(roundtripHashB64, 'base64').toString('hex');
            const hashesMatch = tag6Hex === rtHex;
            console.log('[ZATCA] Tag6 hash (hex)       :', tag6Hex);
            console.log('[ZATCA] Roundtrip hash (hex) :', rtHex);
            console.log(
                hashesMatch
                    ? '[ZATCA] ✓ Signed-XML hash matches QR tag 6'
                    : '[ZATCA] *** HASH MISMATCH *** ZATCA will reject with QRCODE_INVALID because our signed XML re-hashes to a different value than tag 6.'
            );
            if (__lastQrDiagnostics) {
                __lastQrDiagnostics.roundtripHashHex = rtHex;
                __lastQrDiagnostics.roundtripHashBase64 = roundtripHashB64;
                __lastQrDiagnostics.hashesMatch = hashesMatch;
            }
        } catch (e) {
            console.warn(
                '[ZATCA] Could not run hash roundtrip diagnostic:',
                (e as Error).message
            );
        }

        // Convert raw TLV base64 to QR Code image data URL
        let qrImageData = qr;
        try {
            const dataUrl = await QRCode.toDataURL(qr);
            qrImageData = dataUrl.replace('data:image/png;base64,', '');
            console.log('[ZATCA] QR image generated successfully');
        } catch (e) {
            console.error('[ZATCA] QR code generation failed:', e);
        }

        // ── Report / validate with the actual Fatoora API ──────────────────
        let zatcaStatus = 'Reported';
        let fatooraResponse: FatooraReportResult | null = null;
        let fatooraSubmission: ZatcaFatooraSubmissionLog | null = null;

        try {
            const report = await reportInvoiceToFatoora(
                signed_invoice_string,
                invoice_hash,
                egsunit.uuid as string,
                csid,
                (settingsData.clientSecret as string) ?? '',
                environment
            );
            fatooraSubmission = report.submissionDebug;
            fatooraResponse = {
                status: report.status,
                reportingStatus: report.reportingStatus,
                warningMessages: report.warningMessages,
                errorMessages: report.errorMessages,
                raw: report.raw,
            };

            console.log('');
            console.log('┌─── ZATCA Fatoora API Response ───────────────────────────────');
            console.log('│ Endpoint env  :', environment);
            console.log('│ Status        :', fatooraResponse.status);
            console.log('│ Reporting     :', fatooraResponse.reportingStatus || '(none)');
            if (fatooraResponse.warningMessages.length > 0) {
                console.log('│ Warnings      :');
                fatooraResponse.warningMessages.forEach(w =>
                    console.log(`│   [${w.code}] ${w.category} — ${w.message}`)
                );
            }
            if (fatooraResponse.errorMessages.length > 0) {
                console.log('│ Errors        :');
                fatooraResponse.errorMessages.forEach(e =>
                    console.log(`│   [${e.code}] ${e.category} — ${e.message}`)
                );
            }
            console.log('│ Full response :', JSON.stringify(fatooraResponse.raw, null, 2).split('\n').map(l => '│   ' + l).join('\n'));
            console.log('└──────────────────────────────────────────────────────────────');
            console.log('');

            // Use the raw status from ZATCA — reportingStatus takes priority,
            // fall back to validationResults.status if not present.
            zatcaStatus = fatooraResponse.reportingStatus || fatooraResponse.status || 'REPORTED';
        } catch (reportErr: unknown) {
            // Reporting failure must not block the invoice from being saved —
            // the invoice is already cryptographically stamped.
            const reportErrMsg = reportErr instanceof Error ? reportErr.message : String(reportErr);
            const withDebug = reportErr as Error & { zatcaSubmissionDebug?: ZatcaFatooraSubmissionLog };
            if (withDebug.zatcaSubmissionDebug) {
                fatooraSubmission = withDebug.zatcaSubmissionDebug;
            }
            console.error('[ZATCA] Fatoora reporting call failed:', reportErrMsg);
            console.warn('[ZATCA] Invoice was signed locally but could not be confirmed by Fatoora.');
            zatcaStatus = 'ERROR';
        }

        return {
            zatca_xml: signed_invoice_string,
            zatca_hash: invoice_hash,
            zatca_qr: qrImageData,
            zatca_uuid: egsunit.uuid as string,
            zatca_status: zatcaStatus,
            zatca_counter: nextCounter,
            zatca_api_response: fatooraResponse ? {
                status: fatooraResponse.status,
                reportingStatus: fatooraResponse.reportingStatus,
                warningMessages: fatooraResponse.warningMessages,
                errorMessages: fatooraResponse.errorMessages,
                raw: fatooraResponse.raw,
            } : null,
            zatca_fatoora_submission: fatooraSubmission,
            zatca_qr_debug: __lastQrDiagnostics,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('ZATCA Phase 2 Error:', msg);
        // Re-throw so the IPC handler can capture and return it as resp.error
        throw new Error(`ZATCA Phase 2: ${msg}`);
    }
}

/**
 * Original model-level function (kept for non-Electron contexts / tests).
 */
export async function processZatcaPhase2(invoice: SalesInvoice, settings: ZATCASettings, fyo: Fyo) {
    let buyer_name = 'Walk-in Customer';
    if (invoice.party) {
        try {
            const nm = (await fyo.getValue(
                ModelNameEnum.Party,
                invoice.party,
                'name'
            )) as string | undefined;
            buyer_name = (nm && String(nm).trim()) || String(invoice.party);
        } catch {
            buyer_name = String(invoice.party);
        }
    }

    const invoiceData: Record<string, unknown> = {
        name: invoice.name,
        date: invoice.date,
        zatca_uuid: invoice.zatca_uuid,
        buyer_name,
        items: (invoice.items || []).map((item) => ({
            name: item.name,
            item: (item as any).item,
            quantity: item.quantity,
            rate: item.rate?.float ?? 0,
            itemDiscountAmount: (item as any).itemDiscountAmount?.float ?? 0,
        })),
    };

    const settingsData: Record<string, unknown> = {
        sellerName: settings.sellerName,
        vatNumber: settings.vatNumber,
        crnNumber: (settings as any).crnNumber,
        city: (settings as any).city,
        street: (settings as any).street,
        postalZone: (settings as any).postalZone,
        branchName: (settings as any).branchName,
        branchIndustry: (settings as any).branchIndustry,
        environment: settings.environment,
        privateKey: (settings as any).privateKey,
        clientId: (settings as any).clientId,
        clientSecret: (settings as any).clientSecret,
        lastInvoiceCounter: settings.lastInvoiceCounter,
        lastInvoiceHash: settings.lastInvoiceHash,
    };

    const mockDm = {
        call: async (_method: string, tableName: string, options: any) => {
            return fyo.db.getAll(tableName, options);
        }
    };

    const result = await processZatcaPhase2FromIPC(invoiceData, settingsData, mockDm);
    if (!result) return;

    invoice.zatca_xml = result.zatca_xml as string;
    invoice.zatca_hash = result.zatca_hash as string;
    invoice.zatca_qr = result.zatca_qr as string;
    invoice.zatca_uuid = result.zatca_uuid as string;
    invoice.zatca_status = result.zatca_status as string;
}

interface FatooraReportResult {
    /** Top-level status returned by ZATCA: PASS | WARNING | ERROR */
    status: string;
    /** reportingStatus or clearanceStatus field from the response */
    reportingStatus: string;
    warningMessages: Array<{ type: string; code: string; category: string; message: string }>;
    errorMessages:   Array<{ type: string; code: string; category: string; message: string }>;
    /** Raw JSON response from ZATCA (for logging) */
    raw: Record<string, unknown>;
}

/** URL + body (invoice base64 may be truncated) for renderer DevTools logging */
export interface ZatcaFatooraSubmissionLog {
    url: string;
    requestBody: Record<string, string>;
}

/**
 * Sends a locally-signed simplified invoice to the Fatoora portal.
 *
 * - Sandbox  → POST /compliance/invoices   (compliance validation, no live reporting)
 * - Simulation / Production → POST /invoices/reporting/single
 *
 * Auth: Basic base64("<binarySecurityToken>:<secret>")
 * The binarySecurityToken stored in clientId is used directly (not re-encoded).
 */
async function reportInvoiceToFatoora(
    signedXML: string,
    invoiceHash: string,
    invoiceUUID: string,
    clientId: string,
    clientSecret: string,
    environment: string
): Promise<FatooraReportResult & { submissionDebug: ZatcaFatooraSubmissionLog }> {
    const baseURL = getFatooraBaseURL(environment);
    const isSandbox = environment === 'Sandbox';

    const endpoint = isSandbox
        ? `${baseURL}/compliance/invoices`
        : `${baseURL}/invoices/reporting/single`;

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const body: Record<string, string> = {
        invoiceHash: invoiceHash,
        uuid: invoiceUUID,
        invoice: Buffer.from(signedXML).toString('base64'),
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept-Version': 'V2',
        'Accept-Language': 'en',
        'Authorization': `Basic ${basicAuth}`,
    };

    // Simplified invoices use reporting (not clearance), Clearance-Status: 0
    if (!isSandbox) {
        headers['Clearance-Status'] = '0';
    }

    const invoiceB64 = body.invoice;
    const payloadForLog = {
        ...body,
        invoice:
            invoiceB64.length > 300
                ? `${invoiceB64.slice(0, 200)}… (+${invoiceB64.length - 200} more base64 chars)`
                : invoiceB64,
    };
    const submissionDebug: ZatcaFatooraSubmissionLog = {
        url: endpoint,
        requestBody: payloadForLog,
    };
    console.log('[ZATCA] Invoice submission — URL:', endpoint);
    console.log('[ZATCA] Invoice submission — request body:', payloadForLog);

    const nodeFetch = require('node-fetch') as typeof fetch;
    let res: Response;
    try {
        res = await nodeFetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        Object.assign(e, { zatcaSubmissionDebug: submissionDebug });
        throw e;
    }

    let raw: Record<string, unknown> = {};
    try {
        raw = await res.json() as Record<string, unknown>;
    } catch {
        const text = await res.text().catch(() => '');
        raw = { _raw: text };
    }

    const validation = (raw.validationResults ?? {}) as Record<string, unknown>;
    const status: string         = (validation.status as string) ?? (res.ok ? 'PASS' : 'ERROR');
    const reportingStatus: string = (raw.reportingStatus as string) ?? (raw.clearanceStatus as string) ?? '';
    const warningMessages        = (validation.warningMessages as FatooraReportResult['warningMessages']) ?? [];
    const errorMessages          = (validation.errorMessages   as FatooraReportResult['errorMessages'])   ?? [];

    if (!res.ok && errorMessages.length === 0) {
        errorMessages.push({
            type: 'ERROR',
            code: String(res.status),
            category: 'HTTP',
            message: `HTTP ${res.status} from Fatoora`,
        });
    }

    return { status, reportingStatus, warningMessages, errorMessages, raw, submissionDebug };
}

/** Returns the correct Fatoora base URL for an environment. */
function getFatooraBaseURL(environment: string): string {
    if (environment === 'Production') return 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core';
    if (environment === 'Simulation') return 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation';
    // Sandbox / default
    return 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';
}

/** Redacts cert/secret fields for console logs (compliance + production CSID calls). */
function sanitizeZatcaCsidApiResponseForLog(parsed: unknown): unknown {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return parsed;
    }
    const o = { ...(parsed as Record<string, unknown>) };
    if (typeof o.binarySecurityToken === 'string' && o.binarySecurityToken.length > 0) {
        const t = o.binarySecurityToken;
        o.binarySecurityToken = {
            length: t.length,
            preview: `${t.slice(0, 16)}…${t.slice(-12)}`,
        };
    }
    if (typeof o.secret === 'string' && o.secret.length > 0) {
        o.secret = '[present, redacted]';
    }
    return o;
}

/**
 * Direct HTTP call to the Fatoora API — bypasses zatca-xml-js's
 * internal API client which still points to the old gw-apic-gov.gazt.gov.sa hostname.
 */
async function fatooraPost(
    url: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {}
): Promise<any> {
    const nodeFetch = require('node-fetch') as typeof fetch;
    const res = await nodeFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept-Version': 'V2',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    });

    let text: string;
    try {
        text = await res.text();
    } catch {
        text = '';
    }

    if (!res.ok) {
        const kind =
            url.includes('/production/csids') ? 'production CSID (PCSID)' : 'compliance CSID';
        console.error(
            `[ZATCA] ${kind} — API error`,
            { url, status: res.status, body: text.slice(0, 800) }
        );
        throw new Error(
            `ZATCA API ${res.status} at ${url}: ${text.slice(0, 300)}`
        );
    }

    try {
        const parsed = JSON.parse(text);
        const kind =
            url.includes('/production/csids') ? 'production CSID (PCSID)' : 'compliance CSID';
        console.log(
            `[ZATCA] ${kind} — API response`,
            { url, payload: sanitizeZatcaCsidApiResponseForLog(parsed) }
        );
        return parsed;
    } catch {
        const kind =
            url.includes('/production/csids') ? 'production CSID (PCSID)' : 'compliance CSID';
        console.warn(`[ZATCA] ${kind} — non-JSON response`, { url, body: text.slice(0, 500) });
        return text;
    }
}

export async function generateZatcaCSR(settingsData: Record<string, unknown>): Promise<{ csr: string, privateKey: string }> {
    const crnDigits = normalizeAndValidateZatcaCrn(settingsData.crnNumber as string | undefined);

    const egsunit: any = {
        uuid: require('crypto').randomUUID(),
        custom_id: (settingsData.sellerName as string) || "EGS1-12345",
        model: "Desktop",
        CRN_number: crnDigits,
        VAT_name: (settingsData.sellerName as string) || "Unknown Seller",
        VAT_number: (settingsData.vatNumber as string) || "300000000000003",
        location: {
            city: (settingsData.city as string) || "Riyadh",
            city_subdivision: "Default",
            street: (settingsData.street as string) || "Default",
            plot_identification: "0000",
            building: "0000",
            postal_zone: (settingsData.postalZone as string) || "12345"
        },
        branch_name: (settingsData.branchName as string) || "Head Office",
        branch_industry: (settingsData.branchIndustry as string) || "Retail",
    };

    const egs = new EGS(egsunit as any);
    const isProduction = settingsData.environment === 'Production';

    await egs.generateNewKeysAndCSR(isProduction, "thunder_books");

    const info = egs.get();
    return {
        csr: info.csr as string,
        privateKey: info.private_key as string
    };
}

/**
 * Issues a compliance CSID from the Fatoora portal using the provided OTP.
 * Makes a direct HTTP call so the correct hostname is always used regardless
 * of what the zatca-xml-js library has hardcoded internally.
 */
export async function issueZatcaCertificate(
    settingsData: Record<string, unknown>,
    otp: string
): Promise<{ clientId: string; clientSecret: string; complianceRequestId: string }> {
    const csr = (settingsData.csr as string)?.trim();
    if (!csr) throw new Error('No CSR found in settings — generate device keys first.');

    const environment = (settingsData.environment as string) || 'Sandbox';
    const baseURL = getFatooraBaseURL(environment);

    const csrBase64 = Buffer.from(csr).toString('base64');
    const data = await fatooraPost(
        `${baseURL}/compliance`,
        { csr: csrBase64 },
        { OTP: otp }
    );

    // binarySecurityToken is the base64-encoded DER cert body — store it as-is
    // so toCertificatePEM() in processZatcaPhase2FromIPC can wrap it correctly.
    const token: string = data.binarySecurityToken;
    const secret: string = data.secret;
    const requestID: string = String(data.requestID ?? '');

    if (!token) throw new Error('ZATCA response missing binarySecurityToken.');

    return {
        clientId: token,
        clientSecret: secret,
        complianceRequestId: requestID,
    };
}

/**
 * Issues a production CSID once the solution has been approved for go-live.
 */
export async function issueZatcaProductionCertificate(
    settingsData: Record<string, unknown>,
    complianceRequestId: string
): Promise<{ clientId: string; clientSecret: string }> {
    const complianceCert = (settingsData.clientId as string)?.trim();
    const complianceSecret = (settingsData.clientSecret as string)?.trim();
    if (!complianceCert || !complianceSecret) {
        throw new Error('Compliance CSID / secret not found — complete the compliance step first.');
    }
    if (!complianceRequestId?.trim()) {
        throw new Error('Compliance request ID is missing — cannot request production CSID.');
    }

    const environment = (settingsData.environment as string) || 'Sandbox';
    const baseURL = getFatooraBaseURL(environment);

    // Basic auth: base64("<binarySecurityToken>:<secret>")
    const basicAuth = Buffer.from(`${complianceCert}:${complianceSecret}`).toString('base64');

    const data = await fatooraPost(
        `${baseURL}/production/csids`,
        { compliance_request_id: complianceRequestId },
        { Authorization: `Basic ${basicAuth}` }
    );

    const token: string = data.binarySecurityToken;
    if (!token) throw new Error('ZATCA response missing binarySecurityToken.');

    return {
        clientId: token,
        clientSecret: data.secret as string,
    };
}
