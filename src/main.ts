import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { hydrateStoredAuth } from './api/client'
import './styles.css'

// Desktop credential decryption must not delay the first interactive render.
void hydrateStoredAuth()
createApp(App).use(createPinia()).use(router).mount('#app')
