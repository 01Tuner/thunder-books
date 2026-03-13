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

    console.log('[ZATCA] settings sellerName:', zatcaSettings?.sellerName, 'vatNumber:', zatcaSettings?.vatNumber);

    if (!(zatcaSettings && zatcaSettings.sellerName && zatcaSettings.vatNumber)) {
      console.warn('[ZATCA] Skipping: ZATCA settings incomplete');
      return;
    }

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

    const settingsData: Record<string, unknown> = {
      sellerName: zatcaSettings.sellerName,
      vatNumber: zatcaSettings.vatNumber,
      privateKey: (zatcaSettings as any).privateKey,
      clientId: (zatcaSettings as any).clientId,
      clientSecret: (zatcaSettings as any).clientSecret,
    };

    console.log('[ZATCA] isElectron:', this.fyo.isElectron, 'ipc exists:', !!(window as any)?.ipc, 'zatcaProcess fn:', !!(window as any)?.ipc?.zatcaProcess);

    try {
      let result: Record<string, unknown> | null = null;

      if (this.fyo.isElectron && (window as any)?.ipc) {
        // Run on the main (Node.js) process via IPC to access crypto modules
        console.log('[ZATCA] Invoking zatcaProcess via IPC...');
        const resp = await (window as any).ipc.zatcaProcess(invoiceData, settingsData);
        console.log('[ZATCA] IPC response:', resp);
        if (resp?.error) {
          console.error('[ZATCA] IPC error from main process:', resp.error?.message || resp.error);
        }
        if (resp?.data) {
          result = resp.data as Record<string, unknown>;
        }
      } else {
        // Non-Electron / test context: run directly (requires Node.js env)
        const { processZatcaPhase2 } = await import('../../../utils/zatcaPhase2');
        await processZatcaPhase2(this, zatcaSettings, this.fyo);
        return;
      }

      if (result) {
        // Persist ZATCA fields back to the already-submitted invoice record
        await this.fyo.db.update(ModelNameEnum.SalesInvoice, {
          name: this.name as string,
          zatca_xml: (result.zatca_xml as string) ?? null,
          zatca_hash: (result.zatca_hash as string) ?? null,
          zatca_qr: (result.zatca_qr as string) ?? null,
          zatca_uuid: (result.zatca_uuid as string) ?? null,
          zatca_status: (result.zatca_status as string) ?? null,
        });
        // Update in-memory values too
        this.zatca_xml = result.zatca_xml as string;
        this.zatca_hash = result.zatca_hash as string;
        this.zatca_qr = result.zatca_qr as string;
        this.zatca_uuid = result.zatca_uuid as string;
        this.zatca_status = result.zatca_status as string;
        console.log('[ZATCA] Fields saved successfully. QR:', this.zatca_qr?.substring(0, 30));
      } else {
        console.warn('[ZATCA] IPC returned no data');
      }
    } catch (err: any) {
      console.error('[ZATCA] afterSubmit error:', err?.message || err);
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
