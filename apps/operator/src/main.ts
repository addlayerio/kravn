import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import App from './App.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import { i18n } from './i18n';
import '@kravn/ui/style.css';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(i18n);

// Apply persisted light/dark theme before mount to avoid a flash.
useThemeStore(pinia).load();

app.use(router).mount('#app');
