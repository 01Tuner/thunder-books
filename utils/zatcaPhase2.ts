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
 * Converts a CSID from ZATCA/Frappe into a PEM certificate.
 * The CSID stored in Frappe is the raw base64 body of an X.509 DER certificate.
 * It must be wrapped in PEM headers AS-IS — do NOT decode it first.
 */
function toCertificatePEM(csidOrPem: string): string {
    if (csidOrPem.includes('-----BEGIN')) return csidOrPem; // already PEM
    // Strip any whitespace/newlines, then re-chunk into 64-char lines per PEM spec
    const body = csidOrPem.replace(/\s/g, '').match(/.{1,64}/g)?.join('\n') ?? csidOrPem;
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
            privateKeyBody = privateKey
                .replace('-----BEGIN EC PRIVATE KEY-----', '')
                .replace('-----END EC PRIVATE KEY-----', '')
                .replace(/\s/g, '');
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
        CRN_number: "454634645645654",
        VAT_name: (settingsData.sellerName as string) || "Unknown Seller",
        VAT_number: (settingsData.vatNumber as string) || "300000000000003",
        location: {
            city: "Riyadh",
            city_subdivision: "Default",
            street: "Default",
            plot_identification: "0000",
            building: "0000",
            postal_zone: "12345"
        },
        branch_name: "Head Office",
        branch_industry: "Retail",
        // private_key must be a PEM string — library strips headers internally
        private_key: privateKey ? toPrivateKeyPEM(privateKey) : undefined,
        compliance_certificate: csid ? toCertificatePEM(csid) : undefined,
    };

    // Determine previous invoice hash from DB
    let prevHash = INITIAL_HASH;
    try {
        const lastInvoices = await databaseManager.call('getAll', 'SalesInvoice', {
            fields: ['name', 'zatca_hash'],
            filters: { submitted: true },
            orderBy: 'creation',
            order: 'desc',
            limit: 2
        });
        const validPrev = (lastInvoices || []).find((v: any) => v.name !== invoiceData.name);
        if (validPrev && validPrev.zatca_hash) {
            prevHash = validPrev.zatca_hash;
        }
    } catch { /* use default */ }

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
    const zatcaInvoice = new ZATCASimplifiedTaxInvoice({
        props: {
            egs_info: egsunit,
            invoice_counter_number: 1,
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

        if (!privateKey || !csid) {
            // Dev/test mode: generate fresh keys and get compliance cert from ZATCA sandbox
            console.log('[ZATCA] No stored keys, generating new keys and requesting compliance cert from ZATCA sandbox...');
            await egs.generateNewKeysAndCSR(false, "thunder_books");
            await egs.issueComplianceCertificate("123345");
        }

        const { signed_invoice_string, invoice_hash, qr } = egs.signInvoice(zatcaInvoice);
        console.log('[ZATCA] Invoice signed successfully, QR length:', qr?.length);

        // Convert raw TLV base64 to QR Code image data URL
        let qrImageData = qr;
        try {
            const dataUrl = await QRCode.toDataURL(qr);
            // Strip "data:image/png;base64," to keep only the raw base64 as expected by the templates
            qrImageData = dataUrl.replace('data:image/png;base64,', '');
            console.log('[ZATCA] QR image generated successfully');
        } catch (e) {
            console.error('[ZATCA] QR code generation failed:', e);
        }

        return {
            zatca_xml: signed_invoice_string,
            zatca_hash: invoice_hash,
            zatca_qr: qrImageData,
            zatca_uuid: egsunit.uuid,
            zatca_status: 'REPORTED',
        };
    } catch (err: any) {
        const msg = err?.message || String(err);
        console.error("ZATCA Phase 2 Error:", msg);
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
        privateKey: (settings as any).privateKey,
        clientId: (settings as any).clientId,
        clientSecret: (settings as any).clientSecret,
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

export async function generateZatcaCSR(settingsData: Record<string, unknown>): Promise<{ csr: string, privateKey: string }> {
    const egsunit: any = {
        uuid: require('crypto').randomUUID(),
        custom_id: (settingsData.sellerName as string) || "EGS1-12345",
        model: "Desktop",
        CRN_number: "454634645645654",
        VAT_name: (settingsData.sellerName as string) || "Unknown Seller",
        VAT_number: (settingsData.vatNumber as string) || "300000000000003",
        location: {
            city: "Riyadh",
            city_subdivision: "Default",
            street: "Default",
            plot_identification: "0000",
            building: "0000",
            postal_zone: "12345"
        },
        branch_name: "Head Office",
        branch_industry: "Retail",
    };

    const egs = new EGS(egsunit as any);
    const isProduction = settingsData.environment === 'Production';
    
    // Set baseURL based on environment
    const environment = (settingsData.environment as string) || 'Sandbox';
    let baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
    if (environment === 'Production') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core";
    else if (environment === 'Simulation') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation";
    
    // @ts-ignore
    if (egs.api) egs.api.baseURL = baseURL;

    await egs.generateNewKeysAndCSR(isProduction, "thunder_books");
    
    const info = egs.get();
    return { 
        csr: info.csr as string, 
        privateKey: info.private_key as string 
    };
}

export async function issueZatcaCertificate(
    settingsData: Record<string, unknown>,
    otp: string
): Promise<any> {
    const privateKey = settingsData.privateKey as string;
    const csr = settingsData.csr as string;

    const egsunit: any = {
        uuid: require('crypto').randomUUID(),
        custom_id: (settingsData.sellerName as string) || "EGS1-12345",
        model: "Desktop",
        CRN_number: "454634645645654",
        VAT_name: (settingsData.sellerName as string) || "Unknown Seller",
        VAT_number: (settingsData.vatNumber as string) || "300000000000003",
        location: {
            city: "Riyadh",
            city_subdivision: "Default",
            street: "Default",
            plot_identification: "0000",
            building: "0000",
            postal_zone: "12345"
        },
        branch_name: "Head Office",
        branch_industry: "Retail",
    };

    const egs = new EGS(egsunit as any);
    
    // Set baseURL based on environment
    const environment = (settingsData.environment as string) || 'Sandbox';
    let baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
    if (environment === 'Production') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core";
    else if (environment === 'Simulation') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation";
    
    // @ts-ignore
    if (egs.api) egs.api.baseURL = baseURL;

    egs.set({
        private_key: privateKey,
        csr: csr
    });

    const res = await egs.issueComplianceCertificate(otp);
    
    const info = egs.get();
    return {
        clientId: info.compliance_certificate as string,
        clientSecret: info.compliance_api_secret as string,
        complianceRequestId: res, // issueComplianceCertificate returns request_id
    };
}

export async function issueZatcaProductionCertificate(
    settingsData: Record<string, unknown>,
    complianceRequestId: string
): Promise<any> {
    const privateKey = settingsData.privateKey as string;
    const csr = settingsData.csr as string;

    const egsunit: any = {
        uuid: require('crypto').randomUUID(),
        custom_id: (settingsData.sellerName as string) || "EGS1-12345",
        model: "Desktop",
        CRN_number: "454634645645654",
        VAT_name: (settingsData.sellerName as string) || "Unknown Seller",
        VAT_number: (settingsData.vatNumber as string) || "300000000000003",
        location: {
            city: "Riyadh",
            city_subdivision: "Default",
            street: "Default",
            plot_identification: "0000",
            building: "0000",
            postal_zone: "12345"
        },
        branch_name: "Head Office",
        branch_industry: "Retail",
    };

    const egs = new EGS(egsunit as any);
    
    // Set baseURL based on environment
    const environment = (settingsData.environment as string) || 'Sandbox';
    let baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
    if (environment === 'Production') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core";
    else if (environment === 'Simulation') baseURL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation";
    
    // @ts-ignore
    if (egs.api) egs.api.baseURL = baseURL;

    egs.set({
        private_key: privateKey,
        csr: csr
    });

    await egs.issueProductionCertificate(complianceRequestId);
    
    const info = egs.get();
    return {
        clientId: info.production_certificate as string,
        clientSecret: info.production_api_secret as string,
    };
}
