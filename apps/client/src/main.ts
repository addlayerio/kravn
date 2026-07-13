import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import 'katex/dist/katex.min.css';
import '@kravn/ui/style.css';
import './client.css';
import App from './App.vue';
import { router } from './router';
import { i18n } from './i18n';

createApp(App).use(createPinia()).use(i18n).use(router).mount('#app');
