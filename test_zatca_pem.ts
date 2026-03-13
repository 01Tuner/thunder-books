import { processZatcaPhase2FromIPC } from './utils/zatcaPhase2';

const PRIVATE_KEY = "MHQCAQEEIL14JV+5nr/sE8Sppaf2IySovrhVBtt8+yz+g4NRKyz8oAcGBSuBBAAKoUQDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeA==";
const CSID = "TUlJQzVEQ0NBb3FnQXdJQkFnSUdBWnR3TmFLZ01Bb0dDQ3FHU000OUJBTUNNQlV4RXpBUkJnTlZCQU1NQ21WSmJuWnZhV05wYm1jd0hoY05NalV4TWpNd01UY3dNVFUyV2hjTk16QXhNakk1TWpFd01EQXdXakNCL1RFTE1Ba0dBMVVFQmhNQ1UwRXhUakJNQmdOVkJBc01SZG1GMktUWXM5aXoyS2tnMlliWmlOaXgyS2tnMkxYWmh0bUsySy9ZclNEWXRkbUMyTEVnMktmWmhOaTUyS3JaaXRpbzJZb2cyS2ZaaE5pcTJLellwOWl4MllyWXFURk9NRXdHQTFVRUNneEYyWVhZcE5pejJMUFlxU0RaaHRtSTJMSFlxU0RZdGRtRzJZcllyOWl0SU5pMTJZTFlzU0RZcDltRTJMbllxdG1LMktqWmlpRFlwOW1FMktyWXJOaW4yTEhaaXRpcE1VNHdUQVlEVlFRRERFWFpoZGlrMkxQWXM5aXBJTm1HMllqWXNkaXBJTmkxMlliWml0aXYySzBnMkxYWmd0aXhJTmluMllUWXVkaXEyWXJZcU5tS0lOaW4yWVRZcXRpczJLZllzZG1LMktrd1ZqQVFCZ2NxaGtqT1BRSUJCZ1VyZ1FRQUNnTkNBQVR3MUlIT1hNZ1RocS9SdkZ4ZnZGYkpnQTJQb0t4WG5yV0tPU2cwVk5lMkFHbEVrV1h1bUNGcmY1U2EwZS95NExLbGZjRFdpVUtPYkRsQVBLV2NkbkRFbzRIZk1JSGNNQXdHQTFVZEV3RUIvd1FDTUFBd2djc0dBMVVkRVFTQnd6Q0J3S1NCdlRDQnVqRStNRHdHQTFVRUJBdzFNUzFGVWxCT1pYaDBmREl0TVRWOE15MDJNelUyTWpBNVppMWxZMlJtTFRReFlUSXRPV1ZrTmkxa1pXSmxNemszT1dKaE5XTXhIekFkQmdvSmtpYUprL0lzWkFFQkRBOHpPVGs1T1RrNU9UazVNREF3TURNeERUQUxCZ05WQkF3TUJEQXhNREF4TmpBMEJnTlZCQm9NTFRRek9UQWdXblZvWVdseUlHSnBiaUJUWVhKa0xDQkJiQ0JHWVd0b2NtbDVZV2dnUkdsemRDd2dRV1pwWmpFUU1BNEdBMVVFRHd3SFZISmhaR2x1WnpBS0JnZ3Foa2pPUFFRREFnTklBREJGQWlFQXVQS2FSOCtUVUZYNExxVWNjUjRSU0tFNmtwd3F4K2JhL2dBZlhQU3dHRUlDSUQ5VG5KY1Z5aXN3NGlNVU5reW4yQ01ZR1pqS0h5TjFDTzl3MDV1V1p2UEE=";

const mockDm = { call: async () => ([]) };

const invoiceData = {
  name: "TEST-001",
  date: "2025-01-01",
  items: [{ item: "Test Item", quantity: 1, rate: 100, itemDiscountAmount: 0 }]
};

const settingsData = {
  sellerName: "Test Seller",
  vatNumber: "301121971500003",
  privateKey: PRIVATE_KEY,
  clientId: CSID,
  clientSecret: "secret"
};

async function run() {
  try {
    const result = await processZatcaPhase2FromIPC(invoiceData as any, settingsData, mockDm);
    if (result) {
      console.log("SUCCESS! QR length:", result.zatca_qr?.toString().length);
    } else {
      console.log("FAILED: returned null");
    }
  } catch (e: any) {
    console.error("ERROR:", e.message);
  }
}

run();
