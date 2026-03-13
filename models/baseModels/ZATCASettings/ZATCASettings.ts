import { Doc } from 'fyo/model/doc';

export class ZATCASettings extends Doc {
    sellerName?: string;
    vatNumber?: string;
    environment?: string;
    clientId?: string;
    clientSecret?: string;
    privateKey?: string;
}
