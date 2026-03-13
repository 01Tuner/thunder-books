export function getTLV(tag: number, value: string): Uint8Array {
    const valueBuffer = Buffer.from(value, 'utf8');
    return new Uint8Array(Buffer.concat([
        Buffer.from([tag, valueBuffer.length]),
        valueBuffer
    ]));
}

export function generateZatcaQr(
    sellerName: string,
    vatNumber: string,
    timestamp: Date,
    invoiceTotal: string,
    vatTotal: string
): string {
    const tlv1 = getTLV(1, sellerName);
    const tlv2 = getTLV(2, vatNumber);

    // ZATCA expects timestamp in essentially ISO format or a specific timezone
    // For safety, we use ISO string
    const tlv3 = getTLV(3, timestamp.toISOString());
    const tlv4 = getTLV(4, invoiceTotal);
    const tlv5 = getTLV(5, vatTotal);

    const qrBuffer = Buffer.concat([tlv1, tlv2, tlv3, tlv4, tlv5]);
    return qrBuffer.toString('base64');
}
