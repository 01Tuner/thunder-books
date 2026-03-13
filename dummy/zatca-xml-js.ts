// Dummy mock for Vite frontend bundling
export class ZATCASimplifiedTaxInvoice {
    constructor() { }
}
export class EGS {
    constructor() { }
    async generateNewKeysAndCSR() { }
    async issueComplianceCertificate() { }
    signInvoice() { return { signed_invoice_string: '', invoice_hash: '', qr: '' }; }
}
