import { Doc } from 'fyo/model/doc';

export class ZATCASettings extends Doc {
    zatcaEnabled?: boolean;
    zatcaPhase?: string;
    sellerName?: string;
    vatNumber?: string;
    crnNumber?: string;
    city?: string;
    street?: string;
    postalZone?: string;
    branchName?: string;
    branchIndustry?: string;
    environment?: string;
    clientId?: string;
    clientSecret?: string;
    privateKey?: string;
    csr?: string;
    complianceRequestId?: string;
    lastInvoiceCounter?: number;
    lastInvoiceHash?: string;
}
