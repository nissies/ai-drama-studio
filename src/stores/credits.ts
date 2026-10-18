import { defineStore } from 'pinia'
import { creditApi, type CreditWallet } from '../api/credits'

export const useCreditStore = defineStore('credits', {
  state: () => ({
    wallet: null as CreditWallet | null,
    loading: false,
    error: '',
  }),
  actions: {
    async load(force = false) {
      if (this.loading && !force) return
      this.loading = true
      this.error = ''
      try {
        this.wallet = await creditApi.wallet()
      } catch (error) {
        this.error = error instanceof Error ? error.message : '额度读取失败'
      } finally {
        this.loading = false
      }
    },
    clear() {
      this.wallet = null
      this.error = ''
    },
  },
})
