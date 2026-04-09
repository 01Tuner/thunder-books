import { ZATCASimplifiedTaxInvoice } from 'zatca-xml-js';
import { EGS } from 'zatca-xml-js';
import QRCode from 'qrcode';
import { SalesInvoice } from '../models/baseModels/SalesInvoice/SalesInvoice';
import { ZATCASettings } from '../models/baseModels/ZATCASettings/ZATCASettings';
import { Fyo } from 'fyo';

const INITIAL_HASH = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

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
 * Converts a stored CSID into a PEM certificate string for the signing library.
 *
 * ZATCA's `binarySecurityToken` is base64(PEM_body), i.e. it encodes the
 * already-base64 body of the DER certificate — not the raw DER bytes.
 * We must decode it once to obtain the PEM body (e.g. "MIIC5D...") before
 * wrapping in headers; using the raw token as the body yields the wrong bytes
 * for ASN.1 parsing (WRONG_TAG).
 *
 * Handles three forms that may be in storage:
 *   1. Already a full PEM string (-----BEGIN CERTIFICATE-----)
 *   2. binarySecurityToken = base64(PEM_body)  ← ZATCA API response
 *   3. Raw PEM body (MIIC…) stored directly
 */
function toCertificatePEM(csidOrPem: string): string {
    const trimmed = csidOrPem.trim();
    if (trimmed.includes('-----BEGIN')) return trimmed;

    const cleaned = trimmed.replace(/\s/g, '');

    // Attempt to base64-decode the token; if the result is printable ASCII
    // (i.e. it looks like a PEM body), use it — this is the binarySecurityToken case.
    try {
        const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
        if (/^[A-Za-z0-9+/=\r\n]+$/.test(decoded) && decoded.length > 64) {
            const body = decoded.replace(/\s/g, '').match(/.{1,64}/g)?.join('\n') ?? decoded;
            return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
        }
    } catch { /* fall through */ }

    // Fallback: treat as raw PEM body already
    const body = cleaned.match(/.{1,64}/g)?.join('\n') ?? cleaned;
    return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
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
    const { createHash } = require('crypto');
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

    signingModule.createInvoiceDigitalSignature = (invoice_hash: string, _private_key_string: string): string => {
        // invoice_hash is base64 encoded
        const hashBytes = Buffer.from(invoice_hash, 'base64');
        // SHA-256 the hash bytes, then ECDSA sign with secp256k1
        const digest = createHash('sha256').update(hashBytes).digest();
        const sig = secp256k1.sign(digest, privKeyBytes, { format: 'der' });
        // Return DER-encoded signature as base64
        return Buffer.from(sig).toString('base64');
    };

    console.log('[ZATCA] Signing module patched with @noble/curves secp256k1 (pure JS)');
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

    const egsunit: any = {
        uuid: (invoiceData.zatca_uuid as string) || require('crypto').randomUUID(),
        custom_id: (settingsData.sellerName as string) || "EGS1-12345",
        model: "Desktop",
        CRN_number: (settingsData.crnNumber as string) || "1234567890",
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

        try {
            fatooraResponse = await reportInvoiceToFatoora(
                signed_invoice_string,
                invoice_hash,
                egsunit.uuid as string,
                csid,
                (settingsData.clientSecret as string) ?? '',
                environment
            );

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
    const invoiceData: Record<string, unknown> = {
        name: invoice.name,
        date: invoice.date,
        zatca_uuid: invoice.zatca_uuid,
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
): Promise<FatooraReportResult> {
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

    console.log(`[ZATCA] Reporting to Fatoora → ${endpoint}`);

    const nodeFetch = require('node-fetch') as typeof fetch;
    const res = await nodeFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

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

    return { status, reportingStatus, warningMessages, errorMessages, raw };
}

/** Returns the correct Fatoora base URL for an environment. */
function getFatooraBaseURL(environment: string): string {
    if (environment === 'Production') return 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core';
    if (environment === 'Simulation') return 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation';
    // Sandbox / default
    return 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';
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
        throw new Error(
            `ZATCA API ${res.status} at ${url}: ${text.slice(0, 300)}`
        );
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

export async function generateZatcaCSR(settingsData: Record<string, unknown>): Promise<{ csr: string, privateKey: string }> {
    const egsunit: any = {
        uuid: require('crypto').randomUUID(),
        custom_id: (settingsData.sellerName as string) || "EGS1-12345",
        model: "Desktop",
        CRN_number: (settingsData.crnNumber as string) || "1234567890",
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
