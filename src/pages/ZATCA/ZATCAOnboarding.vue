<template>
  <FormContainer>
    <template #body>
      <FormHeader
        :form-title="t`ZATCA Onboarding`"
        :form-sub-title="t`Step ${currentStep} of ${totalSteps}`"
        class="sticky top-0 bg-white dark:bg-gray-890 border-b dark:border-gray-800"
      />

      <div class="flex-1 overflow-auto p-8 max-w-2xl mx-auto w-full">
        <!-- Step 1: Introduction -->
        <div v-if="currentStep === 1" class="space-y-4">
          <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Welcome to ZATCA Phase 2 Onboarding` }}</h2>
          <p class="text-gray-600 dark:text-gray-400">
            {{ t`This wizard will help you integrate your system with ZATCA's Fatoora portal for Phase 2 (Integration Phase).` }}
          </p>
          <p class="text-gray-600 dark:text-gray-400">
            {{ t`You will need your VAT Registration Number and access to the ZATCA portal to generate an OTP.` }}
          </p>
          <div class="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-100 dark:border-blue-800">
            <p class="text-blue-800 dark:text-blue-300 text-sm">
              <strong>{{ t`Note:` }}</strong> {{ t`For Sandbox testing, you can use any 6-digit OTP (e.g., 123456).` }}
            </p>
          </div>
        </div>

        <!-- Step 2: Configuration -->
        <div v-if="currentStep === 2" class="space-y-6">
          <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Organization Details` }}</h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`Seller Name` }}</label>
              <input v-model="settings.sellerName" type="text" class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`VAT Number` }}</label>
              <input v-model="settings.vatNumber" type="text" class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`Environment` }}</label>
              <select v-model="settings.environment" class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100">
                <option value="Sandbox">Sandbox</option>
                <option value="Simulation">Simulation</option>
                <option value="Production">Production</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Step 3: CSR Generation -->
        <div v-if="currentStep === 3" class="space-y-6">
          <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Generate Digital Identity` }}</h2>
          <p class="text-gray-600 dark:text-gray-400">
            {{ t`We will now generate a Private Key and a Certificate Signing Request (CSR) for your organization.` }}
          </p>
          <div v-if="!settings.privateKey" class="flex justify-center py-8">
            <Button type="primary" :loading="loading" @click="generateCSR">
              {{ t`Generate Identity` }}
            </Button>
          </div>
          <div v-else class="space-y-4">
            <div class="p-4 bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800 rounded-lg">
              <p class="text-green-800 dark:text-green-300 text-sm">
                {{ t`Identity generated successfully.` }}
              </p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`Private Key (Stored Safely)` }}</label>
              <pre class="p-2 border rounded bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700 dark:text-gray-400 text-xs overflow-auto max-h-32">********************************</pre>
            </div>
          </div>
        </div>

        <!-- Step 4: Certificate Issuance -->
        <div v-if="currentStep === 4" class="space-y-6">
          <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Get ZATCA Certificate` }}</h2>
          <p class="text-gray-600 dark:text-gray-400">
            {{ t`Enter the OTP from the Fatoora portal to receive your Compliance Certificate.` }}
          </p>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t`OTP` }}</label>
              <input v-model="otp" type="text" placeholder="123456" class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100" />
            </div>
            <div class="flex justify-center py-4">
              <Button type="primary" :loading="loading" :disabled="!otp" @click="issueCertificate">
                {{ t`Request Certificate` }}
              </Button>
            </div>
          </div>
        </div>

        <!-- Step 5: Production CSID -->
        <div v-if="currentStep === 5" class="space-y-6">
          <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Upgrade to Production CSID` }}</h2>
          <p class="text-gray-600 dark:text-gray-400">
            {{ t`Your Compliance Certificate is ready. You can now request your Production CSID to start live integration.` }}
          </p>
          <div class="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg border border-yellow-100 dark:border-yellow-800 mb-6">
            <p class="text-yellow-800 dark:text-yellow-300 text-sm">
              <strong>{{ t`Important:` }}</strong> {{ t`Ensure you have conducted any required compliance checks before proceeding.` }}
            </p>
          </div>
          <div class="flex justify-center py-4">
            <Button type="primary" :loading="loading" @click="issueProductionCertificate">
              {{ t`Get Production CSID` }}
            </Button>
          </div>
        </div>

        <!-- Step 6: Success -->
        <div v-if="currentStep === 6" class="space-y-6 text-center">
          <div class="inline-flex items-center justify-center w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full mb-4">
            <feather-icon name="check" class="text-green-600 dark:text-green-400 w-8 h-8" />
          </div>
          <h2 class="text-2xl font-bold dark:text-gray-100">{{ t`Onboarding Complete!` }}</h2>
          <p class="text-gray-600 dark:text-gray-400">
            {{ t`Your system is now ready for ZATCA Phase 2 integration.` }}
          </p>
          <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg text-left text-sm space-y-2">
            <p class="dark:text-gray-300"><strong>{{ t`CSID:` }}</strong> {{ settings.clientId?.substring(0, 20) }}...</p>
            <p class="dark:text-gray-300"><strong>{{ t`Environment:` }}</strong> {{ settings.environment }}</p>
          </div>
          <div class="pt-6">
            <Button type="primary" @click="finish">
              {{ t`Go to Dashboard` }}
            </Button>
          </div>
        </div>
      </div>

      <!-- Action Footer -->
      <div v-if="currentStep < 6" class="mt-auto p-4 flex items-center justify-between border-t dark:border-gray-800 sticky bottom-0 bg-white dark:bg-gray-890">
        <Button v-if="currentStep > 1" class="w-24 border dark:border-gray-800" @click="prevStep">{{ t`Back` }}</Button>
        <div v-else></div>
        <Button v-if="canGoNext" type="primary" class="w-24" @click="nextStep">{{ t`Next` }}</Button>
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
import { showToast } from 'src/utils/interactive';
import { routeTo } from 'src/utils/ui';

export default defineComponent({
  name: 'ZATCAOnboarding',
  components: {
    FormContainer,
    FormHeader,
    Button,
  },
  data() {
    return {
      currentStep: 1,
      totalSteps: 6,
      loading: false,
      otp: '',
      settings: {
        sellerName: '',
        vatNumber: '',
        environment: 'Sandbox',
        clientId: '',
        clientSecret: '',
        privateKey: '',
        csr: '', // Temporary for step 4
        complianceRequestId: '', // For step 5
      } as Record<string, string>,
    };
  },
  computed: {
    canGoNext() {
      if (this.currentStep === 1) return true;
      if (this.currentStep === 2) return this.settings.sellerName && this.settings.vatNumber;
      if (this.currentStep === 3) return !!this.settings.privateKey;
      if (this.currentStep === 4) return !!this.settings.clientId;
      if (this.currentStep === 5) return !!this.settings.clientId && this.settings.environment !== 'Sandbox';
      return false;
    },
  },
  async mounted() {
    const doc = await fyo.doc.getDoc(ModelNameEnum.ZATCASettings);
    this.settings.sellerName = (doc.sellerName as string) || '';
    this.settings.vatNumber = (doc.vatNumber as string) || '';
    this.settings.environment = (doc.environment as string) || 'Sandbox';
    this.settings.clientId = (doc as any).clientId || '';
    this.settings.clientSecret = (doc as any).clientSecret || '';
    this.settings.privateKey = (doc as any).privateKey || '';
  },
  methods: {
    nextStep() {
      if (this.currentStep < this.totalSteps) {
        if (this.currentStep === 4 && this.settings.environment === 'Sandbox') {
            this.currentStep = 6; // Skip Production CSID for Sandbox
        } else {
            this.currentStep++;
        }
      }
    },
    prevStep() {
      if (this.currentStep > 1) {
        this.currentStep--;
      }
    },
    async generateCSR() {
      this.loading = true;
      try {
        const result = await ipc.zatcaGenerateCSR({
          sellerName: this.settings.sellerName,
          vatNumber: this.settings.vatNumber,
          environment: this.settings.environment,
        });

        if (!result.error) {
          const data = result.data as { privateKey: string; csr: string };
          this.settings.privateKey = data.privateKey;
          this.settings.csr = data.csr;
          showToast({ message: this.t`Identity generated.`, type: 'success' });
        } else {
          throw new Error(result.error.message);
        }
      } catch (error: any) {
        showToast({ message: error.message, type: 'error' });
      } finally {
        this.loading = false;
      }
    },
    async issueCertificate() {
      this.loading = true;
      try {
        const result = await ipc.zatcaIssueCert({
          sellerName: this.settings.sellerName,
          vatNumber: this.settings.vatNumber,
          environment: this.settings.environment,
          privateKey: this.settings.privateKey,
          csr: this.settings.csr,
        }, this.otp);

        if (!result.error) {
          const data = result.data as { clientId: string; clientSecret: string; complianceRequestId: string };
          this.settings.clientId = data.clientId;
          this.settings.clientSecret = data.clientSecret;
          this.settings.complianceRequestId = data.complianceRequestId;
          
          showToast({ message: this.t`Compliance certificate issued.`, type: 'success' });
          this.nextStep();
        } else {
          throw new Error(result.error.message);
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
        const result = await ipc.zatcaIssueProductionCert({
          privateKey: this.settings.privateKey,
          csr: this.settings.csr,
          sellerName: this.settings.sellerName,
          vatNumber: this.settings.vatNumber,
          environment: this.settings.environment,
        }, this.settings.complianceRequestId);

        if (!result.error) {
          const data = result.data as { clientId: string; clientSecret: string };
          this.settings.clientId = data.clientId;
          this.settings.clientSecret = data.clientSecret;
          
          // Save to ZATCA Settings (Final Production values)
          const doc = await fyo.doc.getDoc(ModelNameEnum.ZATCASettings);
          await doc.set('sellerName', this.settings.sellerName);
          await doc.set('vatNumber', this.settings.vatNumber);
          await doc.set('environment', this.settings.environment);
          await doc.set('clientId', this.settings.clientId);
          await doc.set('clientSecret', this.settings.clientSecret);
          await doc.set('privateKey', this.settings.privateKey);
          await doc.sync();

          showToast({ message: this.t`Production CSID issued successfully!`, type: 'success' });
          this.nextStep();
        } else {
          throw new Error(result.error.message);
        }
      } catch (error: any) {
        showToast({ message: error.message, type: 'error' });
      } finally {
        this.loading = false;
      }
    },
    async finish() {
      await routeTo('/');
    },
  },
});
</script>
