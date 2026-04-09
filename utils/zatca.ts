export function getTLV(tag: number, value: string): Uint8Array {
    const valueBytes = new TextEncoder().encode(value);
    const result = new Uint8Array(2 + valueBytes.length);
    result[0] = tag;
    result[1] = valueBytes.length;
    result.set(valueBytes, 2);
    return result;
}

export function generateZatcaQr(
    sellerName: string,
    vatNumber: string,
    timestamp: Date,
    invoiceTotal: string,
    vatTotal: string
): string {
    const tlvs = [
        getTLV(1, sellerName),
        getTLV(2, vatNumber),
        getTLV(3, timestamp.toISOString()),
        getTLV(4, invoiceTotal),
        getTLV(5, vatTotal),
    ];

    const totalLength = tlvs.reduce((n, t) => n + t.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const tlv of tlvs) {
        merged.set(tlv, offset);
        offset += tlv.length;
    }

    // Browser-safe base64 — avoids Buffer which is Node-only
    let binary = '';
    for (let i = 0; i < merged.length; i++) {
        binary += String.fromCharCode(merged[i]);
    }
    return btoa(binary);
}
