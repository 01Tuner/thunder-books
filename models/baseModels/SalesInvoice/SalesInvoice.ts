import { Fyo, t } from 'fyo';
import { Action, ListViewSettings, ValidationMap } from 'fyo/model/types';
import { LedgerPosting } from 'models/Transactional/LedgerPosting';
import { ModelNameEnum } from 'models/types';
import {
  getAddedLPWithGrandTotal,
  getInvoiceActions,
  getReturnLoyaltyPoints,
  getTransactionStatusColumn,
  getZatcaStatusColumn,
} from '../../helpers';
import { generateZatcaQr } from '../../../utils/zatca';
import QRCode from 'qrcode';
import { Invoice } from '../Invoice/Invoice';
import { SalesInvoiceItem } from '../SalesInvoiceItem/SalesInvoiceItem';
import { LoyaltyProgram } from '../LoyaltyProgram/LoyaltyProgram';
import { DocValue } from 'fyo/core/types';
import { Party } from '../Party/Party';
import { ValidationError } from 'fyo/utils/errors';
import { Money } from 'pesa';
import { Doc } from 'fyo/model/doc';
import { ZATCASettings } from '../ZATCASettings/ZATCASettings';

export class SalesInvoice extends Invoice {
  items?: SalesInvoiceItem[];
  zatca_qr?: string;
  zatca_uuid?: string;
  zatca_hash?: string;
  zatca_xml?: string;
  zatca_status?: string;

  async beforeSubmit() {
    await super.beforeSubmit();
  }

  async afterSubmit() {
    await super.afterSubmit?.();
    console.log('[ZATCA] afterSubmit triggered for', this.name);

    const zatcaSettings = (await this.fyo.doc.getDoc(
      ModelNameEnum.ZATCASettings,
      ModelNameEnum.ZATCASettings
    )) as ZATCASettings;

    if (!zatcaSettings?.zatcaEnabled) {
      console.log('[ZATCA] Skipping: ZATCA not enabled');
      return;
    }

    if (!zatcaSettings.sellerName || !zatcaSettings.vatNumber) {
      console.warn('[ZATCA] Skipping: ZATCA common settings incomplete (sellerName/vatNumber)');
      return;
    }

    const phase = zatcaSettings.zatcaPhase || 'Phase 1';

    if (phase === 'Phase 1') {
      try {
        console.log('[ZATCA] Processing Phase 1 (Simple QR)...');
        const vatTotal = await this.getTotalTax();
        
        const rawTlv = generateZatcaQr(
          zatcaSettings.sellerName,
          zatcaSettings.vatNumber,
          new Date(this.date as any),
          this.baseGrandTotal!.float.toFixed(2),
          vatTotal.float.toFixed(2)
        );

        const dataUrl = await QRCode.toDataURL(rawTlv);
        const qrImageData = dataUrl.replace('data:image/png;base64,', '');

        await this.fyo.db.update(ModelNameEnum.SalesInvoice, {
          name: this.name as string,
          zatca_qr: qrImageData,
          zatca_status: 'REPORTED',
        });

        this.zatca_qr = qrImageData;
        this.zatca_status = 'REPORTED';
        console.log('[ZATCA] Phase 1 QR saved successfully');
        const { showToast } = await import('src/utils/interactive');
        showToast({
          type: 'success',
          message: t`ZATCA Phase 1: QR code added to this invoice.`,
          duration: 'short',
        });
      } catch (err: any) {
        console.error('[ZATCA] Phase 1 Error:', err?.message || err);
        const { showToast } = await import('src/utils/interactive');
        showToast({
          type: 'error',
          message: `${t`ZATCA Phase 1 failed`}: ${err?.message ?? err}`,
          duration: 'long',
        });
      }
      return;
    }

    // Phase 2 Logic
    const invoiceData: Record<string, unknown> = {
      name: this.name,
      date: this.date,
      zatca_uuid: this.zatca_uuid,
      items: (this.items || []).map((item) => ({
        name: item.name,
        item: (item as any).item,
        quantity: item.quantity,
        rate: (item.rate as any)?.float ?? (item.rate as any) ?? 0,
        itemDiscountAmount: (item as any).itemDiscountAmount?.float ?? 0,
      })),
    };

    const privateKey = (zatcaSettings as any).privateKey as string | undefined;
    const clientId = (zatcaSettings as any).clientId as string | undefined;

    if (!privateKey?.trim() || !clientId?.trim()) {
      const { showToast } = await import('src/utils/interactive');
      showToast({
        type: 'warning',
        message: t`ZATCA Phase 2 is enabled but onboarding is incomplete. Open Setup → ZATCA to add keys and certificate.`,
        duration: 'long',
      });
      return;
    }

    const settingsData: Record<string, unknown> = {
      sellerName: zatcaSettings.sellerName,
      vatNumber: zatcaSettings.vatNumber,
      crnNumber: zatcaSettings.crnNumber,
      city: zatcaSettings.city,
      street: zatcaSettings.street,
      postalZone: zatcaSettings.postalZone,
      branchName: zatcaSettings.branchName,
      branchIndustry: zatcaSettings.branchIndustry,
      environment: zatcaSettings.environment,
      privateKey,
      clientId,
      clientSecret: (zatcaSettings as any).clientSecret,
      lastInvoiceCounter: zatcaSettings.lastInvoiceCounter,
      lastInvoiceHash: zatcaSettings.lastInvoiceHash,
    };

    try {
      let result: Record<string, unknown> | null = null;

      if (this.fyo.isElectron && (window as any)?.ipc) {
        console.log('[ZATCA] Invoking Phase 2 zatcaProcess via IPC...');
        const resp = await (window as any).ipc.zatcaProcess(invoiceData, settingsData);
        console.log('[ZATCA] Raw IPC response:', JSON.stringify(resp, null, 2));
        if (resp?.error) {
          console.error('[ZATCA] IPC error:', resp.error?.message || resp.error);
          const { showToast } = await import('src/utils/interactive');
          showToast({
            type: 'error',
            message: `${t`ZATCA Phase 2 signing failed`}: ${resp.error?.message ?? resp.error}`,
            duration: 'long',
          });
        }
        if (resp?.data) {
          result = resp.data as Record<string, unknown>;
        }
      } else {
        const { processZatcaPhase2 } = await import('../../../utils/zatcaPhase2');
        await processZatcaPhase2(this, zatcaSettings, this.fyo);
        return;
      }

      if (result) {
        await this.fyo.db.update(ModelNameEnum.SalesInvoice, {
          name: this.name as string,
          zatca_xml: (result.zatca_xml as string) ?? null,
          zatca_hash: (result.zatca_hash as string) ?? null,
          zatca_qr: (result.zatca_qr as string) ?? null,
          zatca_uuid: (result.zatca_uuid as string) ?? null,
          zatca_status: (result.zatca_status as string) ?? null,
        });
        this.zatca_xml = result.zatca_xml as string;
        this.zatca_hash = result.zatca_hash as string;
        this.zatca_qr = result.zatca_qr as string;
        this.zatca_uuid = result.zatca_uuid as string;
        this.zatca_status = result.zatca_status as string;

        const apiResp = result.zatca_api_response as Record<string, unknown> | null;
        console.log('[ZATCA] Phase 2 fields saved successfully');
        console.log('[ZATCA] UUID    :', this.zatca_uuid);
        console.log('[ZATCA] Status  :', this.zatca_status);
        console.log('[ZATCA] Hash    :', this.zatca_hash?.slice(0, 44) + '…');
        console.log('[ZATCA] QR bytes:', (this.zatca_qr?.length ?? 0), '(base64 PNG)');
        console.log('[ZATCA] XML bytes:', (this.zatca_xml?.length ?? 0));
        if (apiResp) {
          console.log('[ZATCA] Fatoora API response:', JSON.stringify(apiResp, null, 2));
        }

        const { showToast } = await import('src/utils/interactive');
        const isError = this.zatca_status === 'ERROR' || this.zatca_status === 'NOT_CLEARED';

        // Build a detailed message from the actual API response
        let toastMessage = `ZATCA: ${this.zatca_status}`;
        if (apiResp) {
          const errors = (apiResp.errorMessages as Array<{ code: string; message: string }>) ?? [];
          const warnings = (apiResp.warningMessages as Array<{ code: string; message: string }>) ?? [];
          const reportingStatus = apiResp.reportingStatus as string;
          if (reportingStatus) toastMessage += ` (${reportingStatus})`;
          if (errors.length > 0) {
            toastMessage += ' — ' + errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
          } else if (warnings.length > 0) {
            toastMessage += ' — ' + warnings.map((w) => `[${w.code}] ${w.message}`).join('; ');
          }
        }

        showToast({
          type: isError ? 'error' : 'success',
          message: toastMessage,
          duration: isError ? 'long' : 'short',
        });
      }
    } catch (err: any) {
      console.error('[ZATCA] Phase 2 Error:', err?.message || err);
      const { showToast } = await import('src/utils/interactive');
      showToast({
        type: 'error',
        message: `${t`ZATCA Phase 2 failed`}: ${err?.message ?? err}`,
        duration: 'long',
      });
    }
  }

  async getPosting() {
    const exchangeRate = this.exchangeRate ?? 1;
    const posting: LedgerPosting = new LedgerPosting(this, this.fyo);
    if (this.isReturn) {
      await posting.credit(this.account!, this.baseGrandTotal!);
    } else {
      await posting.debit(this.account!, this.baseGrandTotal!);
    }

    for (const item of this.items!) {
      if (this.isReturn) {
        await posting.debit(item.account!, item.amount!.mul(exchangeRate));
        continue;
      }
      await posting.credit(item.account!, item.amount!.mul(exchangeRate));
    }

    if (this.redeemLoyaltyPoints) {
      const loyaltyProgramDoc = (await this.fyo.doc.getDoc(
        ModelNameEnum.LoyaltyProgram,
        this.loyaltyProgram
      )) as LoyaltyProgram;

      let loyaltyAmount;

      if (this.isReturn) {
        loyaltyAmount = this.fyo.pesa(await getReturnLoyaltyPoints(this));
      } else {
        loyaltyAmount = await getAddedLPWithGrandTotal(
          this.fyo,
          this.loyaltyProgram as string,
          this.loyaltyPoints as number
        );
      }

      await posting.debit(
        loyaltyProgramDoc.expenseAccount as string,
        loyaltyAmount
      );
    }

    if (this.taxes) {
      for (const tax of this.taxes) {
        if (this.isReturn) {
          await posting.debit(tax.account!, tax.amount!.mul(exchangeRate));
          continue;
        }
        await posting.credit(tax.account!, tax.amount!.mul(exchangeRate));
      }
    }

    const discountAmount = this.getTotalDiscount();
    const discountAccount = this.fyo.singles.AccountingSettings
      ?.discountAccount as string | undefined;
    if (discountAccount && discountAmount.isPositive()) {
      if (this.isReturn) {
        await posting.credit(discountAccount, discountAmount.mul(exchangeRate));
      } else {
        await posting.debit(discountAccount, discountAmount.mul(exchangeRate));
      }
    }

    await posting.makeRoundOffEntry();
    return posting;
  }

  validations: ValidationMap = {
    loyaltyPoints: async (value: DocValue) => {
      if (!this.redeemLoyaltyPoints || this.isSubmitted || this.isReturn) {
        return;
      }

      const partyDoc = (await this.fyo.doc.getDoc(
        ModelNameEnum.Party,
        this.party
      )) as Party;

      if ((value as number) <= 0) {
        throw new ValidationError(t`Points must be greather than 0`);
      }

      if ((value as number) > (partyDoc?.loyaltyPoints || 0)) {
        throw new ValidationError(
          t`${this.party as string} only has ${partyDoc.loyaltyPoints as number
            } points`
        );
      }

      const loyaltyProgramDoc = (await this.fyo.doc.getDoc(
        ModelNameEnum.LoyaltyProgram,
        this.loyaltyProgram
      )) as LoyaltyProgram;
      const toDate = loyaltyProgramDoc?.toDate as Date;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (toDate && new Date(toDate).getTime() < today.getTime()) {
        return;
      }

      if (!this?.grandTotal) {
        return;
      }

      const loyaltyPoint =
        ((value as number) || 0) *
        ((loyaltyProgramDoc?.conversionFactor as number) || 0);

      if (!this.isReturn) {
        const totalDiscount = this.getTotalDiscount();
        let baseGrandTotal;

        if (!this.taxes!.length) {
          baseGrandTotal = (this.netTotal as Money).sub(totalDiscount);
        } else {
          baseGrandTotal = ((this.taxes ?? []) as Doc[])
            .map((doc) => doc.amount as Money)
            .reduce((a, b) => {
              if (this.isReturn) {
                return a.abs().add(b.abs()).neg();
              }
              return a.add(b.abs());
            }, (this.netTotal as Money).abs())
            .sub(totalDiscount);
        }

        if (baseGrandTotal?.lt(loyaltyPoint)) {
          throw new ValidationError(
            t`no need ${value as number} points to purchase this item`
          );
        }
      }
    },
  };

  static getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'name',
        getTransactionStatusColumn(),
        getZatcaStatusColumn(),
        'party',
        'date',
        'baseGrandTotal',
        'outstandingAmount',
      ],
    };
  }

  static getActions(fyo: Fyo): Action[] {
    return getInvoiceActions(fyo, ModelNameEnum.SalesInvoice);
  }
}
