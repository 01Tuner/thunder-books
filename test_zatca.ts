import { Fyo } from 'fyo';
import { SalesInvoice } from './models/baseModels/SalesInvoice/SalesInvoice';
import { ZATCASettings } from './models/baseModels/ZATCASettings/ZATCASettings';
import { processZatcaPhase2 } from './utils/zatcaPhase2';

async function run() {
    const invoice = {
        name: "test",
        zatca_uuid: "",
        items: [{ rate: { float: 100 }, itemDiscountAmount: { float: 0 }, quantity: 1, item: "Item" }],
        date: "2023-11-20"
    };
    const settings = { sellerName: "Test", vatNumber: "123456789012345" };

    // Mock Fyo
    const fyo = {
        db: {
            getAll: async () => ([])
        }
    };

    try {
        console.log("Running processZatcaPhase2...");
        await processZatcaPhase2(invoice as any, settings as any, fyo as any);
        console.log("Success!", invoice);
    } catch (e) {
        console.error("Error:", e);
    }
}

run();
