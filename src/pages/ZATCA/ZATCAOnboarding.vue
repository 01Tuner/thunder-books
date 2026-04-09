<template>
  <FormContainer>
    <template #body>
      <FormHeader
        :form-title="t`ZATCA E-Invoicing`"
        :form-sub-title="headerSubtitle"
        class="sticky top-0 bg-white dark:bg-gray-890 border-b dark:border-gray-800 z-10"
      />

      <div class="flex-1 overflow-auto p-8 max-w-2xl mx-auto w-full">
        <!-- Status banner when already configured -->
        <div
          v-if="statusBannerText && !showSuccessScreen"
          class="mb-6 p-4 rounded-lg border dark:border-gray-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 text-sm"
        >
          {{ statusBannerText }}
        </div>

        <!-- Success -->
        <div v-if="showSuccessScreen" class="space-y-6 text-center py-4">
          <div
            class="inline-flex items-center justify-center w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full mb-2"
          >
            <feather-icon name="check" class="text-green-600 dark:text-green-400 w-8 h-8" />
          </div>
          <h2 class="text-2xl font-bold dark:text-gray-100">
            {{ successTitle }}
          </h2>
          <p class="text-gray-600 dark:text-gray-400 max-w-md mx-auto">
            {{ successBody }}
          </p>
          <div
            v-if="settings.zatcaEnabled"
            class="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg text-left text-sm space-y-2"
          >
            <p class="dark:text-gray-300">
              <strong>{{ t`Phase` }}:</strong> {{ settings.zatcaPhase }}
            </p>
            <p class="dark:text-gray-300">
              <strong>{{ t`Seller` }}:</strong> {{ settings.sellerName || '—' }}
            </p>
            <p class="dark:text-gray-300">
              <strong>{{ t`VAT` }}:</strong> {{ settings.vatNumber || '—' }}
            </p>
            <p class="dark:text-gray-300">
              <strong>{{ t`Environment` }}:</strong> {{ settings.environment }}
            </p>
            <p v-if="settings.zatcaPhase === 'Phase 2' && settings.clientId" class="dark:text-gray-300">
              <strong>{{ t`CSID` }}:</strong>
              {{ settings.clientId.substring(0, 24) }}…
            </p>
          </div>
          <div class="pt-4 flex flex-wrap gap-3 justify-center">
            <Button type="primary" @click="finish">{{ t`Go to Dashboard` }}</Button>
            <Button class="border dark:border-gray-700" @click="restartWizardFromStart">
              {{ t`Edit setup` }}
            </Button>
          </div>
        </div>

        <template v-else>
          <!-- Intro -->
          <div v-if="currentStepId === 'intro'" class="space-y-6">
            <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Saudi ZATCA` }}</h2>
            <p class="text-gray-600 dark:text-gray-400">
              {{
                t`Turn on e-invoicing to add compliant QR codes (Phase 1) or digitally sign invoices for the Fatoora platform (Phase 2).`
              }}
            </p>

            <div class="grid gap-4 sm:grid-cols-2 pt-2">
              <button
                type="button"
                class="text-left p-4 rounded-xl border dark:border-gray-700 transition"
                :class="
                  settings.zatcaPhase === 'Phase 1'
                    ? 'ring-2 ring-blue-500 bg-blue-50/80 dark:bg-blue-900/20'
                    : 'bg-gray-50 dark:bg-gray-800/50 hover:border-gray-400 dark:hover:border-gray-600'
                "
                @click="settings.zatcaPhase = 'Phase 1'"
              >
                <h3 class="font-semibold text-gray-900 dark:text-gray-100">{{ t`Phase 1` }}</h3>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {{ t`Simplified QR on PDFs. Seller name, VAT, totals, and timestamp — no portal keys.` }}
                </p>
              </button>
              <button
                type="button"
                class="text-left p-4 rounded-xl border dark:border-gray-700 transition"
                :class="
                  settings.zatcaPhase === 'Phase 2'
                    ? 'ring-2 ring-blue-500 bg-blue-50/80 dark:bg-blue-900/20'
                    : 'bg-gray-50 dark:bg-gray-800/50 hover:border-gray-400 dark:hover:border-gray-600'
                "
                @click="settings.zatcaPhase = 'Phase 2'"
              >
                <h3 class="font-semibold text-gray-900 dark:text-gray-100">{{ t`Phase 2` }}</h3>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {{
                    t`Cryptographic signing with CSID. Use Simulation or Production when you are ready; Sandbox for testing.`
                  }}
                </p>
              </button>
            </div>

            <div
              class="flex items-start gap-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border dark:border-gray-800"
            >
              <input
                id="zatca-enabled"
                v-model="settings.zatcaEnabled"
                type="checkbox"
                class="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <label for="zatca-enabled" class="font-medium text-gray-700 dark:text-gray-200 cursor-pointer">
                {{ t`Enable ZATCA on sales invoices` }}
              </label>
            </div>

            <div
              v-if="settings.zatcaEnabled && settings.zatcaPhase === 'Phase 2'"
              class="p-4 rounded-lg border border-blue-100 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-900 dark:text-blue-200"
            >
              {{
                t`You will need your VAT registration, Fatoora portal access, and OTP when requesting the compliance certificate.`
              }}
              <button
                type="button"
                class="mt-2 text-blue-700 dark:text-blue-300 underline"
                @click="openFatooraPortal"
              >
                {{ t`Open Fatoora (ZATCA)` }}
              </button>
            </div>
          </div>

          <!-- Organization -->
          <div v-else-if="currentStepId === 'organization'" class="space-y-6">
            <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Organization details` }}</h2>
            <p class="text-gray-600 dark:text-gray-400 text-sm">
              {{
                t`These values appear in the Phase 1 QR and in Phase 2 XML and CSR. Use the legal name and 15-digit VAT as registered with ZATCA.`
              }}
            </p>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{
                  t`Seller name`
                }}</label>
                <input
                  v-model="settings.sellerName"
                  type="text"
                  class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{
                  t`VAT registration number`
                }}</label>
                <input
                  v-model="settings.vatNumber"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  maxlength="15"
                  placeholder="300000000000003"
                  class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                />
                <p class="text-xs text-gray-500 mt-1">{{ t`Typically 15 digits for Saudi Arabia.` }}</p>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{
                  t`Commercial Registration Number (CRN)`
                }}</label>
                <input
                  v-model="settings.crnNumber"
                  type="text"
                  autocomplete="off"
                  placeholder="1234567890"
                  class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                />
                <p class="text-xs text-gray-500 mt-1">{{ t`Your ZATCA-registered commercial registration number.` }}</p>
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`City` }}</label>
                  <input
                    v-model="settings.city"
                    type="text"
                    placeholder="Riyadh"
                    class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`Postal zone` }}</label>
                  <input
                    v-model="settings.postalZone"
                    type="text"
                    placeholder="12345"
                    class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                  />
                </div>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`Street` }}</label>
                <input
                  v-model="settings.street"
                  type="text"
                  class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                />
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`Branch name` }}</label>
                  <input
                    v-model="settings.branchName"
                    type="text"
                    placeholder="Head Office"
                    class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`Branch industry` }}</label>
                  <select
                    v-model="settings.branchIndustry"
                    class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                  >
                    <option value="Retail">{{ t`Retail` }}</option>
                    <option value="Wholesale">{{ t`Wholesale` }}</option>
                    <option value="Manufacturing">{{ t`Manufacturing` }}</option>
                    <option value="Services">{{ t`Services` }}</option>
                    <option value="Construction">{{ t`Construction` }}</option>
                    <option value="Other">{{ t`Other` }}</option>
                  </select>
                </div>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{
                  t`Environment`
                }}</label>
                <select
                  v-model="settings.environment"
                  class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                >
                  <option value="Sandbox">{{ t`Sandbox` }} — {{ t`developer portal` }}</option>
                  <option value="Simulation">{{ t`Simulation` }}</option>
                  <option value="Production">{{ t`Production` }}</option>
                </select>
                <p class="text-xs text-gray-500 mt-1">
                  {{
                    t`Use Sandbox while integrating; switch to Simulation or Production only when your business is cleared for that environment.`
                  }}
                </p>
              </div>
            </div>
          </div>

          <!-- Identity -->
          <div v-else-if="currentStepId === 'identity'" class="space-y-6">
            <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Device keys` }}</h2>
            <p class="text-gray-600 dark:text-gray-400">
              {{
                t`A private key and CSR are created on this device. Upload the CSR in the Fatoora portal, then request an OTP to receive your compliance certificate (CSID).`
              }}
            </p>
            <div v-if="!settings.privateKey" class="flex justify-center py-6">
              <Button type="primary" :loading="loading" @click="generateCSR">
                {{ t`Generate private key & CSR` }}
              </Button>
            </div>
            <div v-else class="space-y-4">
              <div
                class="p-4 bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800 rounded-lg"
              >
                <p class="text-green-800 dark:text-green-300 text-sm">
                  {{ t`Keys generated. Your private key is stored in company settings.` }}
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button type="primary" class="text-sm" @click="copyCsr">{{ t`Copy CSR` }}</Button>
                <Button class="border dark:border-gray-700 text-sm" @click="openFatooraPortal">
                  {{ t`Fatoora portal` }}
                </Button>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {{
                  t`In Fatoora: Onboard a new EGS / device and paste this CSR. When prompted, enter the OTP from the portal on the next step.`
                }}
              </p>
            </div>
          </div>

          <!-- Compliance certificate -->
          <div v-else-if="currentStepId === 'compliance'" class="space-y-6">
            <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Compliance certificate` }}</h2>
            <p class="text-gray-600 dark:text-gray-400">
              {{ t`Enter the one-time password (OTP) shown in Fatoora after submitting your CSR.` }}
            </p>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{
            t`OTP`
                }}</label>
                <input
                  v-model="otp"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                  :placeholder="t`6-digit code`"
                  @keyup.enter="issueCertificate"
                />
              </div>
              <div class="flex justify-center py-2">
                <Button type="primary" :loading="loading" :disabled="!otp?.trim()" @click="issueCertificate">
                  {{ t`Request compliance CSID` }}
                </Button>
              </div>
            </div>
          </div>

          <!-- Production CSID -->
          <div v-else-if="currentStepId === 'production'" class="space-y-6">
            <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Production CSID` }}</h2>
            <p class="text-gray-600 dark:text-gray-400">
              {{
                t`After ZATCA clears your solution for go-live, request the production CSID here. This replaces the compliance CSID for live invoices.`
              }}
            </p>
            <div
              class="p-4 rounded-lg border border-amber-100 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-900 dark:text-amber-200"
            >
              {{ t`Only continue when your business is approved for Production in Fatoora.` }}
            </div>
            <div class="flex justify-center py-4">
              <Button type="primary" :loading="loading" @click="issueProductionCertificate">
                {{ t`Request production CSID` }}
              </Button>
            </div>
          </div>

          <!-- Danger -->
          <div
            v-if="hasExistingConfig && currentStepId === 'intro'"
            class="pt-8 mt-8 border-t dark:border-gray-800"
          >
            <h3 class="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">{{ t`Reset` }}</h3>
            <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {{
                t`Remove all ZATCA keys, CSIDs, and invoice sequence state for this company. You will need to onboard again.` }}
            </p>
            <Button type="danger" :loading="loading" @click="resetZatcaConfiguration">
              {{ t`Delete ZATCA configuration` }}
            </Button>
          </div>
        </template>
      </div>

      <div
        v-if="!showSuccessScreen"
        class="mt-auto p-4 flex items-center justify-between border-t dark:border-gray-800 sticky bottom-0 bg-white dark:bg-gray-890"
      >
        <Button v-if="stepIndex > 0" class="w-28 border dark:border-gray-800" @click="prevStep">{{
          t`Back`
        }}</Button>
        <div v-else></div>
        <Button v-if="showNextButton" type="primary" class="w-28" :disabled="!canGoNext" @click="nextStep">
          {{ t`Next` }}
        </Button>
      </div>
    </template>
  </FormContainer>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import FormContainer from 'src/components/FormContainer.vue';
import FormHeader from 'src/components/FormHeader.vue';
import Button from 'src/components/Button.vue';
import { fyo } from 'src/initFyo';
import { ModelNameEnum } from 'models/types';
import { showToast, showDialog } from 'src/utils/interactive';
import { routeTo } from 'src/utils/ui';
import { t } from 'fyo';

type StepId = 'intro' | 'organization' | 'identity' | 'compliance' | 'production';

export default defineComponent({
  name: 'ZATCAOnboarding',
  components: {
    FormContainer,
    FormHeader,
    Button,
  },
  data() {
    return {
      stepIndex: 0,
      showSuccessScreen: false,
      loading: false,
      otp: '',
      settings: {
        zatcaEnabled: false,
        zatcaPhase: 'Phase 1',
        sellerName: '',
        vatNumber: '',
        crnNumber: '',
        city: '',
        street: '',
        postalZone: '',
        branchName: '',
        branchIndustry: 'Retail',
        environment: 'Sandbox',
        clientId: '',
        clientSecret: '',
        privateKey: '',
        csr: '',
        complianceRequestId: '',
      } as Record<string, any>,
    };
  },
  computed: {
    stepIds(): StepId[] {
      if (!this.settings.zatcaEnabled) {
        return ['intro'];
      }
      if (this.settings.zatcaPhase === 'Phase 1') {
        return ['intro', 'organization'];
      }
      const ids: StepId[] = ['intro', 'organization', 'identity', 'compliance'];
      if (this.settings.environment !== 'Sandbox') {
        ids.push('production');
      }
      return ids;
    },
    currentStepId(): StepId {
      return this.stepIds[this.stepIndex] ?? 'intro';
    },
    headerSubtitle(): string {
      if (this.showSuccessScreen) {
        return t`Complete`;
      }
      const n = this.stepIds.length;
      if (n <= 1) {
        return t`Quick setup`;
      }
      return `${t`Step`} ${this.stepIndex + 1} ${t`of`} ${n}`;
    },
    showNextButton(): boolean {
      const id = this.currentStepId;
      if (id === 'compliance' || id === 'production') {
        return false;
      }
      return true;
    },
    canGoNext(): boolean {
      const id = this.currentStepId;
      if (id === 'intro') {
        return true;
      }
      if (id === 'organization') {
        return this.orgStepValid;
      }
      if (id === 'identity') {
        return !!this.settings.privateKey?.trim();
      }
      return false;
    },
    orgStepValid(): boolean {
      const vat = (this.settings.vatNumber || '').replace(/\D/g, '');
      return (
        !!this.settings.sellerName?.trim() &&
        vat.length >= 15 &&
        !!this.settings.environment
      );
    },
    hasExistingConfig(): boolean {
      return !!(
        this.settings.privateKey ||
        this.settings.clientId ||
        this.settings.sellerName ||
        this.settings.csr
      );
    },
    statusBannerText(): string {
      if (!this.settings.zatcaEnabled) {
        return '';
      }
      if (this.settings.zatcaPhase === 'Phase 1') {
        if (this.orgStepValid) {
          return String(
            t`Phase 1 is on. Simplified QR codes will be added when you submit sales invoices.`
          );
        }
        return String(t`Phase 1 is on — finish seller name and VAT on the Organization step.`);
      }
      if (!this.settings.privateKey) {
        return String(t`Phase 2 is on — generate device keys to continue onboarding.`);
      }
      if (!this.settings.clientId) {
        return String(t`Phase 2 is on — request the compliance CSID with your Fatoora OTP.`);
      }
      if (this.settings.environment !== 'Sandbox' && this.settings.complianceRequestId) {
        return String(
          t`Compliance CSID received — complete the production CSID step when you are cleared for go-live.`
        );
      }
      return String(
        t`Phase 2 credentials look complete. New invoices will be signed when you submit them.`
      );
    },
    successTitle(): string {
      if (!this.settings.zatcaEnabled) {
        return String(t`ZATCA turned off`);
      }
      if (this.settings.zatcaPhase === 'Phase 1') {
        return String(t`Phase 1 ready`);
      }
      return String(t`Phase 2 onboarding updated`);
    },
    successBody(): string {
      if (!this.settings.zatcaEnabled) {
        return String(t`Invoices will no longer receive ZATCA QR codes or signing.`);
      }
      if (this.settings.zatcaPhase === 'Phase 1') {
        return String(
          t`Submit a sales invoice to generate the simplified compliance QR on your print template.`
        );
      }
      return String(
        t`Submit a sales invoice to apply digital signing and the Phase 2 QR. Check invoice print/PDF for the code.`
      );
    },
  },
  async mounted() {
    await this.loadFromDoc();
    this.applyResumeStep();
  },
  methods: {
    openFatooraPortal() {
      ipc.openLink('https://fatoora.zatca.gov.sa/');
    },
    async copyCsr() {
      const csr = this.settings.csr as string;
      if (!csr?.trim()) {
        showToast({ message: t`No CSR to copy yet.`, type: 'warning' });
        return;
      }
      try {
        await navigator.clipboard.writeText(csr);
        showToast({ message: t`CSR copied.`, type: 'success' });
      } catch {
        showToast({ message: t`Could not copy — select and copy manually.`, type: 'error' });
      }
    },
    applyResumeStep() {
      if (!this.settings.zatcaEnabled || this.settings.zatcaPhase !== 'Phase 2') {
        return;
      }
      const ids = this.stepIds;
      if (!this.settings.privateKey) {
        const i = ids.indexOf('identity');
        if (i >= 0) this.stepIndex = i;
        return;
      }
      if (!this.settings.clientId) {
        const i = ids.indexOf('compliance');
        if (i >= 0) this.stepIndex = i;
        return;
      }
      if (this.settings.environment !== 'Sandbox' && this.settings.complianceRequestId) {
        const i = ids.indexOf('production');
        if (i >= 0) this.stepIndex = i;
      }
    },
    restartWizardFromStart() {
      this.showSuccessScreen = false;
      this.stepIndex = 0;
      this.otp = '';
    },
    async loadFromDoc() {
      const doc = await fyo.doc.getDoc(ModelNameEnum.ZATCASettings);
      this.settings.zatcaEnabled = !!doc.zatcaEnabled;
      this.settings.zatcaPhase = (doc.zatcaPhase as string) || 'Phase 1';
      this.settings.sellerName = (doc.sellerName as string) || '';
      this.settings.vatNumber = (doc.vatNumber as string) || '';
      this.settings.crnNumber = (doc as any).crnNumber || '';
      this.settings.city = (doc as any).city || '';
      this.settings.street = (doc as any).street || '';
      this.settings.postalZone = (doc as any).postalZone || '';
      this.settings.branchName = (doc as any).branchName || '';
      this.settings.branchIndustry = (doc as any).branchIndustry || 'Retail';
      this.settings.environment = (doc.environment as string) || 'Sandbox';
      this.settings.clientId = (doc as any).clientId || '';
      this.settings.clientSecret = (doc as any).clientSecret || '';
      this.settings.privateKey = (doc as any).privateKey || '';
      this.settings.csr = (doc as any).csr || '';
      this.settings.complianceRequestId = (doc as any).complianceRequestId || '';
    },
    async nextStep() {
      if (this.currentStepId === 'intro' && !this.settings.zatcaEnabled) {
        await this.saveGeneralSettings();
        this.showSuccessScreen = true;
        return;
      }

      if (this.currentStepId === 'organization') {
        if (!this.orgStepValid) {
          showToast({
            message: t`Enter seller name and a 15-digit VAT number.`,
            type: 'warning',
          });
          return;
        }
        await this.saveGeneralSettings();
        if (this.settings.zatcaPhase === 'Phase 1') {
          this.showSuccessScreen = true;
          return;
        }
        if (this.stepIndex < this.stepIds.length - 1) {
          this.stepIndex++;
        }
        return;
      }

      if (
        (this.currentStepId === 'intro' && this.settings.zatcaEnabled) ||
        this.currentStepId === 'identity'
      ) {
        if (this.stepIndex < this.stepIds.length - 1) {
          this.stepIndex++;
        }
      }
    },
    async saveGeneralSettings() {
      const doc = await fyo.doc.getDoc(ModelNameEnum.ZATCASettings);
      await doc.set('zatcaEnabled', this.settings.zatcaEnabled);
      await doc.set('zatcaPhase', this.settings.zatcaPhase);
      await doc.set('sellerName', this.settings.sellerName);
      await doc.set('vatNumber', this.settings.vatNumber);
      await doc.set('crnNumber', this.settings.crnNumber);
      await doc.set('city', this.settings.city);
      await doc.set('street', this.settings.street);
      await doc.set('postalZone', this.settings.postalZone);
      await doc.set('branchName', this.settings.branchName);
      await doc.set('branchIndustry', this.settings.branchIndustry);
      await doc.set('environment', this.settings.environment);
      await doc.sync();
    },
    prevStep() {
      if (this.stepIndex > 0) {
        this.stepIndex--;
      }
    },
    async persistPhase2Partial(extra: Record<string, unknown>) {
      const doc = await fyo.doc.getDoc(ModelNameEnum.ZATCASettings);
      for (const [key, value] of Object.entries(extra)) {
        await doc.set(key, value);
      }
      await doc.sync();
    },
    async generateCSR() {
      this.loading = true;
      try {
        const result = await ipc.zatcaGenerateCSR({
          sellerName: this.settings.sellerName,
          vatNumber: this.settings.vatNumber,
          crnNumber: this.settings.crnNumber,
          city: this.settings.city,
          street: this.settings.street,
          postalZone: this.settings.postalZone,
          branchName: this.settings.branchName,
          branchIndustry: this.settings.branchIndustry,
          environment: this.settings.environment,
        });

        if (result.error) {
          throw new Error(result.error.message || String(result.error));
        }

        const data = result.data as { privateKey: string; csr: string };
        this.settings.privateKey = data.privateKey;
        this.settings.csr = data.csr;

        await this.persistPhase2Partial({
          zatcaEnabled: true,
          zatcaPhase: 'Phase 2',
          sellerName: this.settings.sellerName,
          vatNumber: this.settings.vatNumber,
          crnNumber: this.settings.crnNumber,
          city: this.settings.city,
          street: this.settings.street,
          postalZone: this.settings.postalZone,
          branchName: this.settings.branchName,
          branchIndustry: this.settings.branchIndustry,
          environment: this.settings.environment,
          privateKey: data.privateKey,
          csr: data.csr,
        });
        showToast({ message: t`Private key and CSR saved.`, type: 'success' });
      } catch (error: any) {
        showToast({ message: error.message, type: 'error' });
      } finally {
        this.loading = false;
      }
    },
    async issueCertificate() {
      this.loading = true;
      try {
        const result = await ipc.zatcaIssueCert(
          {
            sellerName: this.settings.sellerName,
            vatNumber: this.settings.vatNumber,
            crnNumber: this.settings.crnNumber,
            city: this.settings.city,
            street: this.settings.street,
            postalZone: this.settings.postalZone,
            branchName: this.settings.branchName,
            branchIndustry: this.settings.branchIndustry,
            environment: this.settings.environment,
            privateKey: this.settings.privateKey,
            csr: this.settings.csr,
          },
          this.otp.trim()
        );

        if (result.error) {
          throw new Error(result.error.message || String(result.error));
        }

        const data = result.data as {
          clientId: string;
          clientSecret: string;
          complianceRequestId: string;
        };
        this.settings.clientId = data.clientId;
        this.settings.clientSecret = data.clientSecret;
        this.settings.complianceRequestId = data.complianceRequestId;

        const clearProduction = this.settings.environment === 'Sandbox';

        await this.persistPhase2Partial({
          zatcaEnabled: true,
          zatcaPhase: 'Phase 2',
          sellerName: this.settings.sellerName,
          vatNumber: this.settings.vatNumber,
          crnNumber: this.settings.crnNumber,
          city: this.settings.city,
          street: this.settings.street,
          postalZone: this.settings.postalZone,
          branchName: this.settings.branchName,
          branchIndustry: this.settings.branchIndustry,
          environment: this.settings.environment,
          privateKey: this.settings.privateKey,
          csr: this.settings.csr,
          clientId: data.clientId,
          clientSecret: data.clientSecret,
          complianceRequestId: clearProduction ? '' : data.complianceRequestId,
        });

        if (clearProduction) {
          this.settings.complianceRequestId = '';
        }

        showToast({ message: t`Compliance CSID saved.`, type: 'success' });
        this.otp = '';

        if (this.settings.environment === 'Sandbox') {
          this.showSuccessScreen = true;
        } else if (this.stepIndex < this.stepIds.length - 1) {
          this.stepIndex++;
        }
      } catch (error: any) {
        showToast({ message: error.message, type: 'error' });
      } finally {
        this.loading = false;
      }
    },
    async issueProductionCertificate() {
      this.loading = true;
      try {
        const result = await ipc.zatcaIssueProductionCert(
          {
            sellerName: this.settings.sellerName,
            vatNumber: this.settings.vatNumber,
            crnNumber: this.settings.crnNumber,
            city: this.settings.city,
            street: this.settings.street,
            postalZone: this.settings.postalZone,
            branchName: this.settings.branchName,
            branchIndustry: this.settings.branchIndustry,
            environment: this.settings.environment,
            privateKey: this.settings.privateKey,
            csr: this.settings.csr,
          },
          this.settings.complianceRequestId
        );

        if (result.error) {
          throw new Error(result.error.message || String(result.error));
        }

        const data = result.data as { clientId: string; clientSecret: string };
        this.settings.clientId = data.clientId;
        this.settings.clientSecret = data.clientSecret;

        await this.persistPhase2Partial({
          zatcaEnabled: true,
          zatcaPhase: 'Phase 2',
          sellerName: this.settings.sellerName,
          vatNumber: this.settings.vatNumber,
          crnNumber: this.settings.crnNumber,
          city: this.settings.city,
          street: this.settings.street,
          postalZone: this.settings.postalZone,
          branchName: this.settings.branchName,
          branchIndustry: this.settings.branchIndustry,
          environment: this.settings.environment,
          privateKey: this.settings.privateKey,
          csr: this.settings.csr,
          clientId: data.clientId,
          clientSecret: data.clientSecret,
          complianceRequestId: '',
        });
        this.settings.complianceRequestId = '';

        showToast({ message: t`Production CSID saved.`, type: 'success' });
        this.showSuccessScreen = true;
      } catch (error: any) {
        showToast({ message: error.message, type: 'error' });
      } finally {
        this.loading = false;
      }
    },
    async finish() {
      await routeTo('/');
    },
    async resetZatcaConfiguration() {
      const confirmed = await showDialog({
        title: t`Delete ZATCA configuration?`,
        message: t`This will remove keys, CSIDs, CSR, and invoice chain state for ZATCA. You must onboard again to use Phase 2.`,
        variant: 'danger',
        buttons: [
          {
            label: t`Delete everything`,
            variant: 'danger',
            action: () => true,
          },
          {
            label: t`Cancel`,
            isEscape: true,
            action: () => false,
          },
        ],
      });

      if (!confirmed) return;

      this.loading = true;
      try {
        const doc = await fyo.doc.getDoc(ModelNameEnum.ZATCASettings);

        const defaults: Record<string, unknown> = {
          zatcaEnabled: false,
          zatcaPhase: 'Phase 1',
          sellerName: '',
          vatNumber: '',
          crnNumber: '',
          city: '',
          street: '',
          postalZone: '',
          branchName: '',
          branchIndustry: 'Retail',
          environment: 'Sandbox',
          clientId: '',
          clientSecret: '',
          privateKey: '',
          csr: '',
          complianceRequestId: '',
          lastInvoiceCounter: 0,
          lastInvoiceHash:
            'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
        };

        for (const [key, value] of Object.entries(defaults)) {
          await doc.set(key, value);
          this.settings[key] = value;
        }

        await doc.sync();

        this.stepIndex = 0;
        this.showSuccessScreen = false;
        this.otp = '';

        showToast({
          message: t`ZATCA configuration removed.`,
          type: 'success',
        });
      } catch (error: any) {
        showToast({ message: error.message, type: 'error' });
      } finally {
        this.loading = false;
      }
    },
  },
});
</script>
